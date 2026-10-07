import hashlib
import json
import os
import struct
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import h5py
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'tools'))
import bin_sync_tool as bst
import repair_timestamps as repair
from file_access import h5_transaction


def _write_emg_bin(path, ids=(0, 1, 2, 3)):
    header = bytearray(bst.HEADER_SIZE)
    struct.pack_into('<I H B B B 32s', header, 0,
                     bst.EMG_MAGIC, 2000, 4, 24, 0, b'test')
    payload = bytearray()
    for frame_id in ids:
        payload.extend(struct.pack('<I', frame_id))
        for value in range(16):
            payload.extend(int(value).to_bytes(3, 'big', signed=False))
    footer = struct.pack('>I', bst.EMG_MAGIC) + b'footer'.ljust(bst.FOOTER_SIZE - 4, b'\0')
    with open(path, 'wb') as stream:
        stream.write(header)
        stream.write(payload)
        stream.write(footer)


def _write_minimal_h5(path, devices=(1,)):
    dtype = np.dtype([('channels', '<i4', (16,)), ('frame_id', '<u4'),
                      ('sd_frame_id', '<u4'), ('time', '<f8')])
    with h5py.File(path, 'w') as h5:
        for device in devices:
            data = np.zeros(4, dtype=dtype)
            data['sd_frame_id'] = np.arange(4) * 8 + 7
            data['frame_id'] = np.arange(4)
            data['time'] = np.arange(4) / 250.0
            h5.create_dataset(f'emg{device}_250hz_adc', data=data)


class OfflineEntrypointTests(unittest.TestCase):
    def test_public_failure_dicts_and_exceptions_keep_source_bytes(self):
        with __import__('tempfile').TemporaryDirectory(dir=os.getcwd()) as root:
            h5_path = os.path.join(root, 'source.h5')
            bin_path = os.path.join(root, 'source.bin')
            # No emg1 dataset: each public synchronizer must fail on its
            # staged copy and leave the logical source byte-identical.
            with h5py.File(h5_path, 'w') as h5:
                h5.attrs['sync_status'] = 'pending'
            _write_emg_bin(bin_path)

            calls = [
                lambda: bst.sync_h5_with_bin(h5_path, bin_path, device_id=1),
                lambda: bst.sync_h5_one_to_one(h5_path, bin_path, device_id=1),
                lambda: bst.sync_h5_one_to_one_multibin_rescue(
                    h5_path, [bin_path], device_id=1),
                lambda: bst.sync_h5_one_to_many_adc_search(
                    h5_path, bin_path, device_id=1),
            ]
            for call in calls:
                before = Path(h5_path).read_bytes()
                try:
                    result = call()
                except Exception:
                    # A source/parser exception is also required to leave the
                    # source untouched; the next call exercises the dict path.
                    result = None
                self.assertEqual(Path(h5_path).read_bytes(), before)
                if result is not None:
                    self.assertIn(result.get('status'),
                                  ('error', 'failed', 'sync_failed', 'validation_failed'))

            before = Path(h5_path).read_bytes()
            with patch.object(bst, 'append_sync_history', side_effect=RuntimeError('injected clear failure')):
                result = bst.clear_sync_outputs(h5_path, backup=False)
            self.assertFalse(result['success'])
            self.assertEqual(Path(h5_path).read_bytes(), before)

            before = Path(h5_path).read_bytes()
            with self.assertRaises(RuntimeError):
                with h5_transaction(h5_path):
                    with patch.object(bst.EMGBinParser, 'parse', side_effect=RuntimeError('injected parser failure')):
                        bst.sync_h5_with_bin(h5_path, bin_path, device_id=1)
            self.assertEqual(Path(h5_path).read_bytes(), before)

    def test_imu_zero_values_are_retained_and_marked(self):
        dtype = np.dtype([('channels', '<i4', (16,)), ('sd_frame_id', '<u4'), ('time', '<f8')])
        data_2khz = np.zeros(3, dtype=dtype)
        data_2khz['sd_frame_id'] = [0, 20, 40]
        data_2khz['time'] = [10.0, 10.01, 10.02]

        class Parser:
            num_imus = 2
            bin_path = 'imu.bin'
            frames = {
                0: ({'acc': [0.0, 0.0, 0.0], 'gyr': [0.0, 0.0, 0.0], 'mag': [0.0, 0.0, 0.0]},
                    {'acc': [1.0, 0.0, 0.0], 'gyr': [1.0, 0.0, 0.0], 'mag': [1.0, 0.0, 0.0]}),
                2: ({'acc': [0.0, 0.0, 0.0], 'gyr': [0.0, 0.0, 0.0], 'mag': [0.0, 0.0, 0.0]},
                    {'acc': [2.0, 0.0, 0.0], 'gyr': [2.0, 0.0, 0.0], 'mag': [2.0, 0.0, 0.0]}),
            }

        with __import__('tempfile').TemporaryDirectory(dir=os.getcwd()) as root:
            path = os.path.join(root, 'imu.h5')
            with h5py.File(path, 'w') as h5:
                result = bst._sync_imu_100hz(h5, None, Parser(), data_2khz, 1)
                self.assertFalse(result['imu_verified'])
                self.assertEqual(result['imu_alignment_confidence'], 'unverified')
                a = h5['imu1a_100hz'][:]
                b = h5['imu1b_100hz'][:]
                self.assertEqual(a.shape[0], 3)
                self.assertTrue(np.all(a['acc'][0] == 0))
                self.assertTrue(np.array_equal(a['valid'], [True, False, True]))
                self.assertTrue(np.array_equal(a['missing'], [False, True, False]))
                self.assertTrue(np.array_equal(b['acc'][:, 0], [1.0, 0.0, 2.0]))
                missing = h5['sync_quality/dev1/imu_missing_frame_ids'][:]
                self.assertEqual(missing.tolist(), [1])

    def test_repair_distinct_output_dry_run_and_source_change_guard(self):
        dtype = np.dtype([('channels', '<i4', (16,)), ('time', '<f8')])
        with __import__('tempfile').TemporaryDirectory(dir=os.getcwd()) as root:
            source = os.path.join(root, 'source.h5')
            output = os.path.join(root, 'repaired.h5')
            with h5py.File(source, 'w') as h5:
                data = np.zeros(3, dtype=dtype)
                data['time'] = [1.0, 1.0, 0.5]
                h5.create_dataset('emg1_2khz_adc', data=data)
            original = Path(source).read_bytes()
            self.assertTrue(repair.repair_file(source, output))
            self.assertEqual(Path(source).read_bytes(), original)
            self.assertNotEqual(Path(output).read_bytes(), original)

            dry_before = Path(source).read_bytes()
            self.assertTrue(repair.repair_file(source, dry_run=True))
            self.assertEqual(Path(source).read_bytes(), dry_before)

            output2 = os.path.join(root, 'repaired2.h5')
            old_output = b'previous output bytes'
            Path(output2).write_bytes(old_output)
            real_validate = repair._validate_saved_h5
            def validate_and_change(staged):
                real_validate(staged)
                with open(source, 'ab') as stream:
                    stream.write(b'changed')
            with patch.object(repair, '_validate_saved_h5', side_effect=validate_and_change):
                with self.assertRaises(repair.FileBusyError):
                    repair.repair_file(source, output2)
            self.assertEqual(Path(output2).read_bytes(), old_output)


if __name__ == '__main__':
    unittest.main()
