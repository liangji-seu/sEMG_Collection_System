"""Synthetic coverage for the empty-BLE peer-clock fallback."""

import json
import struct
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

import h5py
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
import bin_sync_tool as sync


class PeerBleTimeFallbackTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='peer-time-', dir=ROOT)
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def _write_bin(self, side, stamp, ids, name_stamp=None):
        name_stamp = name_stamp or stamp
        subject, side_code, date, clock = name_stamp.split('_')
        path = self.root / f'{subject}_{side_code}_{date}_{clock}_emg.bin'
        header = struct.pack('<IHBBB32s', sync.EMG_MAGIC, 2000, 0, 24, 1,
                             stamp.encode('ascii'))
        with path.open('wb') as stream:
            stream.write(header.ljust(sync.HEADER_SIZE, b'\0'))
            for frame_id in ids:
                channels = [frame_id * 10 + ch for ch in range(16)]
                stream.write(struct.pack('<I', frame_id))
                stream.write(b''.join(int(v).to_bytes(3, 'big', signed=True)
                                      for v in channels))
        return path

    def _session(self, target_side='R', delta=1, target_ids=range(3000, 3040),
                 reference_ids=range(1000, 1100), empty_target=True,
                 empty_reference=False):
        subject = 'A00703'
        ref_side = 'L' if target_side == 'R' else 'R'
        ref_dt = datetime(2026, 10, 27, 23, 59, 59)
        target_dt = ref_dt.fromtimestamp(ref_dt.timestamp() + delta)
        ref_stamp = f'{subject}_{ref_side}_{ref_dt:%y%m%d_%H%M%S}'
        target_stamp = f'{subject}_{target_side}_{target_dt:%y%m%d_%H%M%S}'
        ref_bin = self._write_bin(ref_side, ref_stamp, reference_ids)
        target_bin = self._write_bin(target_side, target_stamp, target_ids)
        h5_path = self.root / f'{target_side}_{delta}.h5'
        dtype = np.dtype([('channels', '<i4', (16,)), ('sd_frame_id', '<i8'),
                          ('time', '<f8')])
        with h5py.File(h5_path, 'w') as f:
            for device, path, is_empty in ((1 if ref_side == 'L' else 2, ref_bin, empty_reference),
                                           (1 if target_side == 'L' else 2, target_bin, empty_target)):
                ble = np.zeros(0 if is_empty else 4, dtype=dtype)
                if len(ble):
                    ble['sd_frame_id'] = [107, 115, 123, 131]
                    ble['time'] = [1000.0035, 1000.0075, 1000.0115, 1000.0155]
                ble_ds = f.create_dataset(f'emg{device}_250hz_adc', data=ble)
                if device == (1 if target_side == 'L' else 2):
                    ble_ds.attrs['channel_map_name'] = 'physical'
                f.attrs[f'sd_bin_dev{device}'] = path.name[:-len('_emg.bin')]
            ref_device = 1 if ref_side == 'L' else 2
            ref_ds = f.create_dataset(f'emg{ref_device}_2khz_adc', shape=(4000,), dtype=dtype)
            ref_ds['sd_frame_id'] = np.arange(4000) - 7
            ref_ds['time'] = 1000.0 + np.arange(4000) / 2000.0
            ref_ds.attrs['sync_time_source'] = 'ble_anchor_interpolation_nominal_extrapolation'
            ref_ds.attrs['sync_bin_fid0'] = 1000
            ref_ds.attrs['sync_bin_align_offset'] = 1017
            ref_ds.attrs['sync_own_adc_verified'] = True
            f.attrs[f'sync_device_status_dev{ref_device}'] = 'synced'
            f.attrs[f'sync_device_validation_dev{ref_device}'] = True
            f.attrs[f'sync_device_source_fingerprint_dev{ref_device}'] = sync._sync_source_fingerprint(ref_bin)
        return h5_path, ref_bin, target_bin, ref_side, target_side

    def test_both_orientations_apply_second_resolution_midnight_delta_and_keep_target_rows(self):
        for target_side, delta in (('R', 1), ('L', -1)):
            with self.subTest(target_side=target_side, delta=delta):
                path, ref_bin, target_bin, ref_side, target_side = self._session(
                    target_side, delta, target_ids=range(3000, 3040))
                ref_device = 1 if ref_side == 'L' else 2
                target_device = 1 if target_side == 'L' else 2
                before_ref = ref_bin.read_bytes()
                with h5py.File(path, 'r') as f:
                    reference_snapshots = {
                        name: f[name][:].copy() for name in (
                            f'emg{ref_device}_250hz_adc',
                            f'emg{ref_device}_2khz_adc',
                            f'emg{target_device}_250hz_adc')}
                result = sync.sync_h5_from_peer_time_reference(
                    str(path), str(target_bin), ref_device, str(ref_bin), target_device)
                self.assertEqual(result['status'], 'success', result)
                self.assertEqual(result['peer_start_delta_seconds'], delta)
                self.assertEqual(ref_bin.read_bytes(), before_ref)
                expected_ids = np.arange(3000, 3040)
                expected_times = 1000.0 + (expected_ids - 3010) / 2000.0 + delta
                with h5py.File(path, 'r') as f:
                    ds = f[f'emg{target_device}_2khz_adc']
                    self.assertEqual(len(ds), 40)
                    self.assertEqual(ds.attrs['sync_align_tier'], 'peer_time_fallback')
                    self.assertFalse(ds.attrs['sync_own_adc_verified'])
                    self.assertEqual(ds.attrs['sync_peer_time_start_delta_seconds'], delta)
                    np.testing.assert_array_equal(ds['sd_frame_id'], expected_ids - 3000)
                    np.testing.assert_allclose(ds['time'], expected_times, atol=1e-10)
                    expected_channels = np.array(
                        [[frame_id * 10 + ch for ch in range(16)]
                         for frame_id in expected_ids], dtype=np.int32)
                    np.testing.assert_array_equal(ds['channels'], expected_channels)
                    self.assertEqual(f[f'emg{target_device}_250hz_adc'].shape[0], 0)
                    for name, original_data in reference_snapshots.items():
                        np.testing.assert_array_equal(f[name][:], original_data)

    def test_rejects_nonempty_target_unverified_reference_and_wrong_header_identity(self):
        path, ref_bin, target_bin, ref_side, target_side = self._session(empty_target=False)
        target_device = 2 if target_side == 'R' else 1
        ref_device = 1 if ref_side == 'L' else 2
        original = path.read_bytes()
        result = sync.sync_h5_from_peer_time_reference(
            str(path), str(target_bin), ref_device, str(ref_bin), target_device)
        self.assertEqual(result['status'], 'validation_failed')
        self.assertEqual(path.read_bytes(), original)

        path, ref_bin, target_bin, ref_side, target_side = self._session(empty_reference=True)
        ref_device = 1 if ref_side == 'L' else 2
        target_device = 1 if target_side == 'L' else 2
        original = path.read_bytes()
        result = sync.sync_h5_from_peer_time_reference(
            str(path), str(target_bin), ref_device, str(ref_bin), target_device)
        self.assertEqual(result['status'], 'validation_failed')
        self.assertEqual(path.read_bytes(), original)

        path, ref_bin, target_bin, ref_side, target_side = self._session()
        ref_device = 1 if ref_side == 'L' else 2
        target_device = 1 if target_side == 'L' else 2
        original = path.read_bytes()
        with target_bin.open('r+b') as stream:
            stream.seek(10)
            stream.write(b'X')
        result = sync.sync_h5_from_peer_time_reference(
            str(path), str(target_bin), ref_device, str(ref_bin), target_device)
        self.assertEqual(result['status'], 'validation_failed')
        self.assertEqual(path.read_bytes(), original)

        path, ref_bin, target_bin, ref_side, target_side = self._session()
        ref_device = 1 if ref_side == 'L' else 2
        target_device = 1 if target_side == 'L' else 2
        with h5py.File(path, 'r+') as f:
            f.attrs[f'sync_device_source_fingerprint_dev{ref_device}'] = 'stale fingerprint'
        original = path.read_bytes()
        result = sync.sync_h5_from_peer_time_reference(
            str(path), str(target_bin), ref_device, str(ref_bin), target_device)
        self.assertEqual(result['status'], 'validation_failed')
        self.assertEqual(path.read_bytes(), original)

    def test_target_bin_gaps_are_not_filled(self):
        source_ids = [3000, 3001, 3003, 3007, 3008]
        path, ref_bin, target_bin, ref_side, target_side = self._session(
            target_ids=source_ids)
        ref_device = 1 if ref_side == 'L' else 2
        target_device = 1 if target_side == 'L' else 2
        result = sync.sync_h5_from_peer_time_reference(
            str(path), str(target_bin), ref_device, str(ref_bin), target_device)
        self.assertEqual(result['status'], 'success', result)
        with h5py.File(path, 'r') as f:
            ds = f[f'emg{target_device}_2khz_adc']
            np.testing.assert_array_equal(ds['sd_frame_id'], np.array(source_ids) - 3000)
            np.testing.assert_array_equal(
                ds['channels'][:, 0], np.array(source_ids, dtype=np.int32) * 10)
            np.testing.assert_allclose(np.diff(ds['time']), np.diff(source_ids) / 2000.0)

    def test_normal_output_does_not_claim_adc_verification_when_verify_is_false(self):
        path, _ref_bin, target_bin, _ref_side, target_side = self._session(empty_target=False)
        device = 1 if target_side == 'L' else 2
        parser = sync.EMGBinParser(str(target_bin)).parse()
        with h5py.File(path, 'r') as f:
            data = f[f'emg{device}_250hz_adc'][:]
        result = sync._build_and_write_2khz(
            str(path), parser, None, device, None, 'physical', data, len(data),
            0, False, sync_mode='unit_test', verify_passed=False,
            bin_base=parser.fid0, label_offset=parser.fid0, full_bin=True)
        self.assertEqual(result['status'], 'success')
        self.assertFalse(result['own_adc_verified'])
        with h5py.File(path, 'r') as f:
            self.assertFalse(f[f'emg{device}_2khz_adc'].attrs['sync_own_adc_verified'])
            self.assertFalse(f.attrs[f'sync_own_adc_verified_dev{device}'])
            history = json.loads(f.attrs['sync_history'])
            self.assertFalse(history[-1]['details']['own_adc_verified'])

        path, ref_bin, target_bin, ref_side, target_side = self._session()
        ref_device = 1 if ref_side == 'L' else 2
        target_device = 1 if target_side == 'L' else 2
        with h5py.File(path, 'r+') as f:
            f.attrs[f'sync_device_validation_dev{ref_device}'] = False
        original = path.read_bytes()
        result = sync.sync_h5_from_peer_time_reference(
            str(path), str(target_bin), ref_device, str(ref_bin), target_device)
        self.assertEqual(result['status'], 'validation_failed')
        self.assertEqual(path.read_bytes(), original)

    def test_one_to_many_is_bounded_to_verified_reference_clock_range(self):
        path, ref_bin, target_bin, ref_side, target_side = self._session(
            target_ids=range(3000, 10000), reference_ids=range(1000, 1100))
        ref_device = 1 if ref_side == 'L' else 2
        target_device = 1 if target_side == 'L' else 2
        result = sync.sync_h5_from_peer_time_reference(
            str(path), str(target_bin), ref_device, str(ref_bin), target_device,
            full_bin=False)
        self.assertEqual(result['status'], 'success', result)
        with h5py.File(path, 'r') as f:
            ds = f[f'emg{target_device}_2khz_adc']
            self.assertLess(len(ds), 7000)
            self.assertGreater(len(ds), 0)
            self.assertLessEqual(float(ds['time'][-1]), 1002.0 + 1e-8)


if __name__ == '__main__':
    unittest.main()
