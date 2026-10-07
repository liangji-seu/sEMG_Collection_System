"""Regression tests for the BLE-anchor/bin-output contract."""

import struct
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import h5py
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
import bin_sync_tool as sync


class BinCompletionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='bin-completion-', dir=ROOT)
        self.directory = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def _header(self, magic, rate=2000, version=1):
        if version == 1:
            content = struct.pack('<IHBBB32s', magic, rate, 0, 24, 1, b'test')
        else:
            content = struct.pack('<IBHBBB32s', magic, 2, rate, 0, 24, 1, b'test')
        return content.ljust(sync.HEADER_SIZE, b'\0')

    def _write_bin(self, ids, name='paired_emg.bin'):
        path = self.directory / name
        rows = {}
        with path.open('wb') as handle:
            handle.write(self._header(sync.EMG_MAGIC))
            for fid in ids:
                row = [((int(fid) * 17 + c * 101) % 24001) - 12000
                       for c in range(16)]
                rows[int(fid)] = row
                handle.write(struct.pack('<I', int(fid)))
                handle.write(b''.join(v.to_bytes(3, 'big', signed=True) for v in row))
        return path, rows

    def _write_h5(self, rows, anchor_ids, path_name='source.h5', base=0,
                  old_output=False):
        path = self.directory / path_name
        dtype = np.dtype([('channels', '<i4', (16,)), ('sd_frame_id', '<u4'),
                          ('time', '<f8')])
        data = np.zeros(len(anchor_ids), dtype=dtype)
        for idx, source_id in enumerate(anchor_ids):
            data[idx]['channels'] = rows[int(source_id)]
            data[idx]['sd_frame_id'] = int(source_id) - int(base)
            data[idx]['time'] = 1000.0 + (int(source_id) - int(base)) / 2000.0
        with h5py.File(path, 'w') as handle:
            ds = handle.create_dataset('emg1_250hz_adc', data=data)
            ds.attrs['channel_map_name'] = 'physical'
            if old_output:
                old_dtype = np.dtype([('channels', '<i4', (16,)),
                                       ('sd_frame_id', '<u4'), ('time', '<f8')])
                old = handle.create_dataset('emg1_2khz_adc', shape=(1,), dtype=old_dtype)
                old[:] = np.zeros(1, dtype=old_dtype)
                old.attrs['sync_source_mode'] = 'ble_anchored_extended'
                handle.attrs['sync_status'] = 'synced'
        return path

    @staticmethod
    def _source_ids(path):
        with h5py.File(path, 'r') as handle:
            ds = handle['emg1_2khz_adc']
            offset = int(ds.attrs['sync_bin_align_offset'])
            return ds[:]['sd_frame_id'].astype(np.int64) + offset, dict(ds.attrs)

    def test_one_to_one_keeps_paired_bin_when_ble_has_edges_and_large_gap_missing(self):
        # BLE anchors cover only the middle and skip a long middle interval;
        # every real frame in the paired collection bin must still be emitted.
        ids = list(range(1000, 1200))
        bin_path, rows = self._write_bin(ids)
        anchor_ids = ([1007 + 8 * i for i in range(8)] +
                      [1103 + 8 * i for i in range(8)])
        h5_path = self._write_h5(rows, anchor_ids, base=1000)

        result = sync.sync_h5_one_to_one(str(h5_path), str(bin_path), verify=True)

        self.assertEqual(result['status'], 'success')
        source_ids, attrs = self._source_ids(h5_path)
        np.testing.assert_array_equal(source_ids, ids)
        self.assertEqual(len(source_ids), len(ids))
        self.assertTrue(attrs['sync_full_bin_preserved'])
        self.assertEqual(attrs['sync_source_mode'], 'full_sd_bin')
        self.assertEqual(attrs['sync_source_frame_count'], len(ids))
        with h5py.File(h5_path, 'r') as handle:
            for sample, source_id in zip(handle['emg1_2khz_adc'][:], source_ids):
                np.testing.assert_array_equal(sample['channels'], rows[int(source_id)])

    def test_compatibility_entrypoint_uses_full_paired_bin_contract(self):
        ids = list(range(300, 420))
        bin_path, rows = self._write_bin(ids)
        h5_path = self._write_h5(rows, [307 + 8 * i for i in range(10)], base=300)

        result = sync.sync_h5_with_bin(str(h5_path), str(bin_path), verify=True)

        self.assertEqual(result['status'], 'success')
        source_ids, attrs = self._source_ids(h5_path)
        np.testing.assert_array_equal(source_ids, ids)
        self.assertTrue(attrs['sync_full_bin_preserved'])

    def test_nonuniform_ble_times_pin_anchor_rows_and_nominally_extrapolate_edges(self):
        ids = list(range(700, 741))
        bin_path, rows = self._write_bin(ids, name='jittered_emg.bin')
        anchor_ids = [707, 715, 723, 731]
        h5_path = self._write_h5(rows, anchor_ids, base=700)
        anchor_times = np.array([1000.0035, 1000.0076, 1000.0115, 1000.0160])
        with h5py.File(h5_path, 'r+') as handle:
            handle['emg1_250hz_adc']['time'] = anchor_times

        result = sync.sync_h5_one_to_one(str(h5_path), str(bin_path), verify=True)

        self.assertEqual(result['status'], 'success')
        with h5py.File(h5_path, 'r') as handle:
            ds = handle['emg1_2khz_adc']
            source_ids = ds['sd_frame_id'].astype(np.int64) + int(ds.attrs['sync_bin_align_offset'])
            times = ds['time']
            for source_id, expected in zip(anchor_ids, anchor_times):
                index = int(np.flatnonzero(source_ids == source_id)[0])
                self.assertAlmostEqual(float(times[index]), float(expected), places=12)
            first_anchor = int(np.flatnonzero(source_ids == anchor_ids[0])[0])
            last_anchor = int(np.flatnonzero(source_ids == anchor_ids[-1])[0])
            np.testing.assert_allclose(
                times[:first_anchor],
                anchor_times[0] - np.arange(first_anchor, 0, -1) / 2000.0,
                atol=1e-12)
            np.testing.assert_allclose(
                times[last_anchor + 1:],
                anchor_times[-1] + np.arange(1, len(times) - last_anchor) / 2000.0,
                atol=1e-12)
            self.assertEqual(
                ds.attrs['sync_time_source'],
                'ble_anchor_interpolation_nominal_extrapolation')

    def test_old_ble_anchored_output_is_resynced_and_upgraded(self):
        ids = list(range(500, 620))
        bin_path, rows = self._write_bin(ids)
        h5_path = self._write_h5(rows, [507 + 8 * i for i in range(8)],
                                 base=500, old_output=True)
        fingerprint = sync._sync_source_fingerprint(str(bin_path))
        with h5py.File(h5_path, 'r+') as handle:
            handle.attrs['sync_device_status_dev1'] = 'synced'
            handle.attrs['sync_device_validation_dev1'] = True
            handle.attrs['sync_device_imu_verified_dev1'] = True
            handle.attrs['sync_device_source_fingerprint_dev1'] = fingerprint

        result = sync.sync_h5_one_to_one(str(h5_path), str(bin_path), verify=True)

        self.assertEqual(result['status'], 'success')
        source_ids, attrs = self._source_ids(h5_path)
        np.testing.assert_array_equal(source_ids, ids)
        self.assertTrue(attrs['sync_full_bin_preserved'])
        self.assertEqual(attrs['sync_output_contract_version'], 2)

    def test_negative_prefix_rebuilds_old_unsigned_dataset_as_signed(self):
        ids = list(range(1000, 1011))
        bin_path, rows = self._write_bin(ids, name='offset_emg.bin')
        h5_path = self._write_h5(rows, [1007], base=1000, old_output=False)
        old_dtype = np.dtype([('channels', '<i4', (16,)), ('sd_frame_id', '<u4'),
                              ('time', '<f8')])
        with h5py.File(h5_path, 'r+') as handle:
            old = handle.create_dataset('emg1_2khz_adc', shape=(1,), dtype=old_dtype)
            old[:] = np.zeros(1, dtype=old_dtype)

        parser = sync.EMGBinParser(str(bin_path)).parse()
        with h5py.File(h5_path, 'r') as handle:
            data_250hz = handle['emg1_250hz_adc'][:]
        result = sync._build_and_write_2khz(
            str(h5_path), parser, None, 1, None, 'physical', data_250hz,
            len(data_250hz), 0, False, sync_mode='test',
            anchor_sd_frame_ids=np.array([1007], dtype=np.int64),
            anchor_position=7, bin_base=0, label_offset=1005, full_bin=True)

        self.assertEqual(result['status'], 'success')
        with h5py.File(h5_path, 'r') as handle:
            ds = handle['emg1_2khz_adc']
            self.assertEqual(ds.dtype['sd_frame_id'].kind, 'i')
            self.assertLess(int(ds[0]['sd_frame_id']), 0)
            self.assertEqual(len(ds), len(ids))

    def test_one_to_many_keeps_explicit_anchor_session_range(self):
        ids = list(range(300))
        bin_path, rows = self._write_bin(ids, name='long_emg.bin')
        h5_path = self._write_h5(rows, list(range(7, 152, 8)), base=0)

        result = sync.sync_h5_one_to_many_adc_search(
            str(h5_path), str(bin_path), channel_map_name='physical')

        self.assertEqual(result['status'], 'success')
        source_ids, attrs = self._source_ids(h5_path)
        np.testing.assert_array_equal(source_ids, list(range(152)))
        self.assertFalse(attrs['sync_full_bin_preserved'])
        self.assertEqual(attrs['sync_source_mode'], 'ble_anchored_session')
        self.assertLess(len(source_ids), len(ids))

    def test_negative_emg_prefix_is_not_cast_to_unsigned_imu_ids(self):
        data = np.zeros(4, dtype=[('sd_frame_id', '<i8'), ('time', '<f8')])
        data['sd_frame_id'] = [-2, -1, 0, 20]
        data['time'] = [99.999, 99.9995, 100.0, 100.01]
        sensor = {'acc': [1., 2., 3.], 'gyr': [4., 5., 6.], 'mag': [0., 0., 0.]}
        parser = SimpleNamespace(num_imus=1, bin_path='imu.bin', frames={0: [sensor], 1: [sensor]})
        with h5py.File(self.directory / 'negative-imu.h5', 'w') as handle:
            with patch.object(sync, '_build_imu_frame_axis_from_ble', return_value=None):
                result = sync._sync_imu_100hz(handle, None, parser, data, 1)
            self.assertEqual(result['imu_filled'], 2)
            np.testing.assert_array_equal(handle['imu1a_100hz']['sd_frame_id'], [0, 1])
            np.testing.assert_allclose(handle['imu1a_100hz']['time'], [100., 100.01])


if __name__ == '__main__':
    unittest.main()
