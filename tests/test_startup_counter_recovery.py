import contextlib
import io
from pathlib import Path
import struct
import sys
import tempfile
import unittest

import h5py
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
import bin_sync_tool as sync


class StartupCounterRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='startup-reset-', dir=ROOT)
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.assertEqual(self.root.resolve().parent, ROOT.resolve())
        self.temp.cleanup()

    def emg_bin(self, ids, name='emg.bin', salt=0):
        path = self.root / name
        rows = []
        with path.open('wb') as handle:
            header = struct.pack('<IHBBB32s', sync.EMG_MAGIC, 2000, 0, 24, 1, b'synthetic')
            handle.write(header.ljust(sync.HEADER_SIZE, b'\0'))
            for fid in ids:
                row = [((int(fid) * 17 + c * 101 + salt) % 24001) - 12000 for c in range(16)]
                rows.append(row)
                handle.write(struct.pack('<I', int(fid)))
                handle.write(b''.join(v.to_bytes(3, 'big', signed=True) for v in row))
            handle.write(struct.pack('>I', sync.EMG_MAGIC) + bytes(32))
        return path, np.asarray(rows, dtype=np.int32)

    def imu_bin(self, count=1):
        path = self.root / 'imu.bin'
        with path.open('wb') as handle:
            header = struct.pack('<IHBBB32s', sync.IMU_MAGIC, 100, 0, 24, 1, b'synthetic')
            handle.write(header.ljust(sync.HEADER_SIZE, b'\0'))
            for fid in range(80):
                handle.write(struct.pack('<I', fid))
                for k in range(count):
                    value = fid + k
                    handle.write(struct.pack('<9h', 100 + value, 200, 300,
                                             10, 20, 30, 1, 2, 3))
            handle.write(struct.pack('>I', sync.IMU_MAGIC) + bytes(32))
        return path

    def h5(self, rows, source_rows, name='test.h5', wrong=False, with_imu_attr=False):
        path = self.root / name
        dtype = np.dtype([
            ('channels', '<i4', (16,)), ('frame_id', '<u4'),
            ('sd_frame_id', '<u4'), ('time', '<f8')])
        data = np.zeros(len(source_rows), dtype=dtype)
        for i, source_row in enumerate(source_rows):
            data[i]['channels'] = rows[int(source_row)]
            if wrong:
                data[i]['channels'] += 5000
            data[i]['frame_id'] = i
            data[i]['sd_frame_id'] = int(source_row) - 7
            data[i]['time'] = 1000.0 + float(source_row - 7) / 2000.0
        with h5py.File(path, 'w') as handle:
            ds = handle.create_dataset('emg1_250hz_adc', data=data)
            ds.attrs['channel_map_name'] = 'physical'
            if with_imu_attr:
                handle.attrs['imu1_num_imus'] = 1
                handle.attrs['ble_device_dev1'] = 'synthetic'
        return path

    def test_strict_parser_rejects_startup_reset_but_optin_preserves_rows(self):
        path, _rows = self.emg_bin([123, 0, 1, 2, 3])
        with self.assertRaisesRegex(ValueError, 'reset_or_reorder'):
            sync.EMGBinParser(str(path)).parse()
        parser = sync.EMGBinParser(str(path), allow_startup_reset=True).parse()
        self.assertEqual(parser.counter_mode, 'startup_reset_segments')
        np.testing.assert_array_equal(parser.raw_frame_ids, [123, 0, 1, 2, 3])
        np.testing.assert_array_equal(parser.frames.ids_array, np.arange(5, dtype=np.uint32))

    def test_optin_rejects_later_reset_reorder_gap_and_duplicate(self):
        malformed = {
            'later-reset': [123, 0, 1, 0, 1],
            'reorder': [123, 0, 2, 1, 3],
            'gap': [123, 0, 1, 3, 4],
            'duplicate': [123, 0, 1, 1, 2],
        }
        for name, ids in malformed.items():
            with self.subTest(name=name):
                path, _rows = self.emg_bin(ids, f'{name}.bin')
                with self.assertRaises((ValueError, AssertionError)):
                    sync.EMGBinParser(str(path), allow_startup_reset=True).parse()

    def test_one_to_one_recovery_preserves_every_row_and_raw_provenance(self):
        ids = [500] + list(range(799))
        bp, rows = self.emg_bin(ids)
        anchors = list(range(7, 640, 8))
        hp = self.h5(rows, anchors)
        result = sync.sync_h5_one_to_one(str(hp), str(bp), verify=True)
        self.assertEqual(result['status'], 'success')
        parser = sync.EMGBinParser(str(bp), allow_startup_reset=True).parse()
        with h5py.File(hp, 'r') as handle:
            ds = handle['emg1_2khz_adc']
            data = ds[:]
            self.assertEqual(len(data), len(ids))
            self.assertIn('source_bin_row', data.dtype.names)
            self.assertIn('raw_sd_frame_id', data.dtype.names)
            np.testing.assert_array_equal(data['source_bin_row'], np.arange(len(ids), dtype=np.uint64))
            np.testing.assert_array_equal(data['raw_sd_frame_id'], parser.raw_frame_ids)
            np.testing.assert_array_equal(data['channels'], rows)
            self.assertTrue(np.all(np.isfinite(data['time'])))
            self.assertTrue(np.all(np.diff(data['time']) > 0))
            self.assertEqual(ds.attrs['sync_counter_mode'], 'startup_reset_segments')
            self.assertEqual(ds.attrs['sync_bin_align_offset_scope'], 'source_bin_row')
            self.assertFalse(bool(ds.attrs['sync_raw_counter_usable']))
            self.assertEqual(ds.attrs['sync_startup_reset_first_raw_id'], 500)

    def test_wrong_adc_and_verify_false_do_not_publish_recovery(self):
        ids = [500] + list(range(799))
        bp, rows = self.emg_bin(ids)
        hp = self.h5(rows, list(range(7, 640, 8)), name='wrong.h5', wrong=True)
        result = sync.sync_h5_one_to_one(str(hp), str(bp), verify=True)
        self.assertEqual(result['status'], 'validation_failed')
        with h5py.File(hp, 'r') as handle:
            self.assertNotIn('emg1_2khz_adc', handle)

        hp2 = self.h5(rows, list(range(7, 640, 8)), name='unverified.h5')
        with self.assertRaises(ValueError):
            sync.sync_h5_one_to_one(str(hp2), str(bp), verify=False)
        with h5py.File(hp2, 'r') as handle:
            self.assertNotIn('emg1_2khz_adc', handle)

    def test_missing_imu_output_is_not_accepted_by_repeat_skip(self):
        ids = [500] + list(range(799))
        bp, rows = self.emg_bin(ids)
        hp = self.h5(rows, list(range(7, 640, 8)), with_imu_attr=True)
        first = sync.sync_h5_one_to_one(str(hp), str(bp), verify=True)
        self.assertEqual(first['status'], 'success')
        ip = self.imu_bin(1)
        second = sync.sync_h5_one_to_one(str(hp), str(bp), str(ip), verify=True,
                                         manual_num_imus=1)
        self.assertNotEqual(second['status'], 'skipped')
        with h5py.File(hp, 'r') as handle:
            self.assertIn('imu1a_100hz', handle)


if __name__ == '__main__':
    unittest.main()
