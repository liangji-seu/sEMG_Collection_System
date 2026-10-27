import struct
import sys
import tempfile
import unittest
from pathlib import Path

import h5py
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
import bin_sync_tool as sync


class PartialBleEpochTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='partial-ble-epoch-', dir=ROOT)
        self.directory = Path(self.temp.name)
        self.source_ids = np.arange(1000, 2000, dtype=np.int64)
        self.rows = {
            int(fid): [((int(fid) * 17 + ch * 101) % 24001) - 12000
                       for ch in range(16)]
            for fid in self.source_ids
        }

    def tearDown(self):
        self.temp.cleanup()

    def _write_bin(self, name='paired.bin', rows=None):
        rows = self.rows if rows is None else rows
        path = self.directory / name
        header = struct.pack('<IBHBBB32s', sync.EMG_MAGIC, 2, 2000, 0, 24, 1, b'test')
        with path.open('wb') as handle:
            handle.write(header.ljust(sync.HEADER_SIZE, b'\0'))
            for fid in self.source_ids:
                values = rows[int(fid)]
                handle.write(struct.pack('<I', int(fid)))
                handle.write(b''.join(int(v).to_bytes(3, 'big', signed=True)
                                      for v in values))
        return path

    def _data(self, first_ids=None, later_count=20, bad_first=None,
              reset=True, repeated=False):
        first_ids = list(first_ids or range(1007, 2000, 8))
        total = len(first_ids) + later_count
        dtype = np.dtype([('channels', '<i4', (16,)), ('frame_id', '<u4'),
                          ('sd_frame_id', '<u4'), ('time', '<f8')])
        data = np.zeros(total, dtype=dtype)
        for idx, source_id in enumerate(first_ids):
            data[idx]['channels'] = (np.zeros(16, dtype=np.int32)
                                     if repeated else self.rows[int(source_id)])
            data[idx]['frame_id'] = idx
            data[idx]['sd_frame_id'] = int(source_id - 1000)
            data[idx]['time'] = 1000.0 + idx / 250.0
        for idx in range(later_count):
            row = len(first_ids) + idx
            data[row]['channels'] = (
                np.zeros(16, dtype=np.int32) if repeated else np.full(16, 30000 + idx))
            data[row]['frame_id'] = idx if reset else len(first_ids) + idx
            data[row]['sd_frame_id'] = idx * 8 if reset else (len(first_ids) + idx) * 8
            data[row]['time'] = 1000.0 + row / 250.0
        if bad_first is not None:
            data[int(bad_first)]['channels'] = np.full(16, 29000, dtype=np.int32)
        return data

    def _write_h5(self, data, name='source.h5'):
        path = self.directory / name
        with h5py.File(path, 'w') as handle:
            ds = handle.create_dataset('emg1_250hz_adc', data=data)
            ds.attrs['channel_map_name'] = 'physical'
        return path

    def _write_large_bin_and_epochs(self):
        source_ids = np.arange(1000, 8000, dtype=np.int64)
        def vector(fid):
            return [((int(fid) * 17 + ch * 101) % 24001) - 12000
                    for ch in range(16)]
        bin_path = self.directory / 'large-paired.bin'
        header = struct.pack('<IBHBBB32s', sync.EMG_MAGIC, 2, 2000, 0, 24, 1, b'test')
        with bin_path.open('wb') as handle:
            handle.write(header.ljust(sync.HEADER_SIZE, b'\0'))
            for fid in source_ids:
                handle.write(struct.pack('<I', int(fid)))
                handle.write(b''.join(int(v).to_bytes(3, 'big', signed=True)
                                      for v in vector(fid)))

        dtype = np.dtype([('channels', '<i4', (16,)), ('frame_id', '<u4'),
                          ('sd_frame_id', '<u4'), ('time', '<f8')])
        data = np.zeros(810, dtype=dtype)
        for row in range(800):
            source_id = 1007 + row * 8
            data[row]['channels'] = vector(source_id)
            data[row]['frame_id'] = row
            data[row]['sd_frame_id'] = source_id - 1000
            data[row]['time'] = 1000.0 + row / 250.0
        for row in range(10):
            idx = 800 + row
            data[idx]['channels'] = np.full(16, 30000 + row)
            data[idx]['frame_id'] = row
            data[idx]['sd_frame_id'] = row * 8
            data[idx]['time'] = 1000.0 + idx / 250.0
        return bin_path, data

    def test_first_epoch_recovers_full_bin_and_records_later_epoch_warning(self):
        bin_path = self._write_bin()
        data = self._data()
        h5_path = self._write_h5(data)

        result = sync.sync_h5_one_to_one(str(h5_path), str(bin_path), verify=True)

        self.assertEqual(result['status'], 'success')
        self.assertEqual(result['sync_ble_uncovered_rows'], 20)
        self.assertEqual(result['sync_ble_coverage_note'],
                         'later_ble_epochs_without_paired_bin')
        with h5py.File(h5_path, 'r') as handle:
            output = handle['emg1_2khz_adc']
            self.assertEqual(len(output), len(self.source_ids))
            self.assertTrue(bool(output.attrs['sync_full_bin_preserved']))
            self.assertEqual(int(output.attrs['sync_ble_uncovered_count']), 20)
            self.assertEqual(handle.attrs['sync_ble_coverage_note_dev1'],
                             'later_ble_epochs_without_paired_bin')
            np.testing.assert_array_equal(
                handle['emg1_250hz_adc']['frame_id'], data['frame_id'])

    def test_earliest_counter_reset_wins_and_partial_edge_limit_is_fixed(self):
        parser = sync.EMGBinParser(str(self._write_bin())).parse()
        data = self._data(later_count=22)
        first_end = 125
        # frame_id resets one row before sd_frame_id; the earlier boundary is
        # the only one allowed to define the paired first epoch.
        data['sd_frame_id'][first_end] = data['sd_frame_id'][first_end - 1] + 8
        data['sd_frame_id'][first_end + 1] = 0
        anchors, details = sync._recover_one_to_one_anchors(
            parser, data['channels'], None, data_250hz=data)
        self.assertIsNotNone(anchors)
        self.assertTrue(details['partial_epoch_recovery'])
        self.assertEqual(details['counter_name'], 'frame_id')
        self.assertEqual(details['first_epoch_rows'], first_end)
        self.assertEqual(details['source_edge_limit'], 4000)

    def test_high_sampled_rate_with_later_reset_uses_partial_recovery(self):
        bin_path, data = self._write_large_bin_and_epochs()
        h5_path = self._write_h5(data, name='large-source.h5')
        result = sync.sync_h5_one_to_one(str(h5_path), str(bin_path), verify=True)
        self.assertEqual(result['status'], 'success')
        self.assertEqual(result['sync_ble_uncovered_rows'], 10)
        with h5py.File(h5_path, 'r') as handle:
            output = handle['emg1_2khz_adc']
            self.assertEqual(len(output), 7000)
            self.assertEqual(output.attrs['sync_ble_validation_scope'],
                             'paired_bin_first_ble_epoch')
            self.assertEqual(int(output.attrs['sync_ble_first_epoch_rows']), 800)
            self.assertAlmostEqual(float(output.attrs['sync_ble_epoch_match_rate']), 1.0)

    def test_later_reset_with_missing_first_epoch_anchor_fails_closed(self):
        bin_path, data = self._write_large_bin_and_epochs()
        data['channels'][0] = np.full(16, 29000, dtype=np.int32)
        h5_path = self._write_h5(data, name='large-missing-first.h5')
        result = sync.sync_h5_one_to_one(str(h5_path), str(bin_path), verify=True)
        self.assertEqual(result['status'], 'validation_failed')

    def test_partial_recovery_rejects_missing_reset_or_weak_source_evidence(self):
        parser = sync.EMGBinParser(str(self._write_bin())).parse()
        channel_map = None

        cases = {
            'no-reset': self._data(reset=False),
            'low-source-coverage': self._data(first_ids=range(1007, 1800, 8)),
            'incomplete-first-epoch': self._data(bad_first=10),
            'repeated-zero-signature': self._data(repeated=True),
        }
        for name, data in cases.items():
            with self.subTest(name=name):
                anchors, details = sync._recover_one_to_one_anchors(
                    parser, data['channels'], channel_map, data_250hz=data)
                self.assertIsNone(anchors)
                self.assertFalse(details.get('partial_epoch_recovery', False))

    def test_partial_epoch_imu_window_excludes_later_reset_epoch(self):
        dtype = np.dtype([
            ('imu_index', '<i4'), ('acc', '<f4', (3,)),
            ('gyr', '<f4', (3,)), ('has_mag', '?'), ('mag', '<f4', (3,)),
            ('frame_id', '<u4'), ('sd_frame_id', '<u4'), ('time', '<f8')])
        rows = np.zeros(3, dtype=dtype)
        rows['imu_index'] = 0
        rows['sd_frame_id'] = [0, 20, 0]
        rows['time'] = [100.0, 100.01, 101.0]
        with h5py.File(self.directory / 'imu-window.h5', 'w') as handle:
            handle.create_dataset('imu1_all_ble', data=rows)
            selected = list(sync._iter_imu_ble_anchor_rows(
                handle, 1, time_window=(99.99, 100.02)))
        self.assertEqual(len(selected), 2)
        self.assertEqual([int(item[1]) for item in selected], [0, 20])


if __name__ == '__main__':
    unittest.main()
