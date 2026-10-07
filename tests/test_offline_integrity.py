import json
import os
import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

import h5py
import numpy as np

os.environ.setdefault('QT_QPA_PLATFORM', 'offscreen')
from PyQt5.QtWidgets import QApplication

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'tools'))
import archive_tool
import hdf5_tool


_APP = QApplication.instance() or QApplication([])


class OfflineIntegrityTests(unittest.TestCase):
    def _make_h5(self, root, name='record.h5', devices=(1, 2)):
        path = os.path.join(root, name)
        with h5py.File(path, 'w') as h5:
            for device_id in devices:
                h5.attrs[f'sd_bin_dev{device_id}'] = f'device{device_id}'
                h5.create_dataset(f'emg{device_id}_250hz_adc', data=np.zeros(4))
        return path

    def _make_bins(self, root, devices=(1, 2)):
        for device_id in devices:
            for suffix in ('emg', 'imu'):
                with open(os.path.join(root, f'device{device_id}_{suffix}.bin'), 'wb') as stream:
                    stream.write(b'synthetic')

    def _fake_sync(self, fail_device=None, raise_device=None):
        def fake(h5_path, emg_bin_path, imu_bin_path, device_id, **kwargs):
            self.assertFalse(kwargs.get('set_synced'))
            if device_id == raise_device:
                raise RuntimeError('injected device failure')
            if device_id == fail_device:
                return {'status': 'validation_failed', 'reason': 'injected validation failure'}
            with h5py.File(h5_path, 'a') as h5:
                h5.create_dataset(f'emg{device_id}_2khz_adc', data=np.ones(3))
            return {'status': 'success', 'frames_2khz': 3, 'imu_status': 'skipped'}
        return fake

    def test_two_device_success_commits_aggregate_traceability(self):
        with tempfile.TemporaryDirectory(dir=os.getcwd()) as root:
            path = self._make_h5(root)
            self._make_bins(root)
            before = Path(path).read_bytes()
            worker = hdf5_tool.SyncWorker([path], root, ['emg1', 'emg2'], True)
            with patch.object(hdf5_tool, 'repair_250hz_timestamps_in_h5'), \
                    patch.object(hdf5_tool, 'sync_h5_one_to_one', side_effect=self._fake_sync()):
                worker.run()
            after = Path(path).read_bytes()
            self.assertNotEqual(before, after)
            with h5py.File(path, 'r') as h5:
                self.assertEqual(h5.attrs['sync_aggregate_status'], 'synced')
                self.assertEqual(json.loads(h5.attrs['sync_required_devices']), [1, 2])
                details = json.loads(h5.attrs['sync_device_results'])
                self.assertEqual([item['device_id'] for item in details], [1, 2])
                self.assertTrue(all(item['valid'] for item in details))

    def test_device_failure_and_mid_transaction_exception_preserve_old_bytes(self):
        for failure in ('return', 'raise'):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory(dir=os.getcwd()) as root:
                path = self._make_h5(root)
                self._make_bins(root)
                before = Path(path).read_bytes()
                worker = hdf5_tool.SyncWorker([path], root, ['emg1', 'emg2'], True)
                fake = self._fake_sync(fail_device=2 if failure == 'return' else None,
                                       raise_device=2 if failure == 'raise' else None)
                with patch.object(hdf5_tool, 'repair_250hz_timestamps_in_h5'), \
                        patch.object(hdf5_tool, 'sync_h5_one_to_one', side_effect=fake):
                    worker.run()
                self.assertEqual(Path(path).read_bytes(), before)
                with h5py.File(path, 'r') as h5:
                    self.assertNotIn('emg1_2khz_adc', h5)
                    self.assertNotIn('sync_aggregate_status', h5.attrs)

    def test_missing_required_bin_does_not_create_partial_commit(self):
        with tempfile.TemporaryDirectory(dir=os.getcwd()) as root:
            path = self._make_h5(root)
            self._make_bins(root, devices=(1,))
            before = Path(path).read_bytes()
            worker = hdf5_tool.SyncWorker([path], root, ['emg1', 'emg2'], True)
            with patch.object(hdf5_tool, 'sync_h5_one_to_one') as sync:
                worker.run()
            self.assertEqual(Path(path).read_bytes(), before)
            sync.assert_not_called()

    def test_selecting_one_device_cannot_mark_dual_device_file_green(self):
        with tempfile.TemporaryDirectory(dir=os.getcwd()) as root:
            path = self._make_h5(root)
            self._make_bins(root)
            with h5py.File(path, 'a') as h5:
                h5.attrs['sync_required_devices'] = '[1]'
            worker = hdf5_tool.SyncWorker([path], root, ['emg1'], True)
            with patch.object(hdf5_tool, 'repair_250hz_timestamps_in_h5'), \
                    patch.object(hdf5_tool, 'sync_h5_one_to_one', side_effect=self._fake_sync()):
                worker.run()
            with h5py.File(path, 'r') as h5:
                self.assertEqual(h5.attrs['sync_status'], 'partial')
                self.assertEqual(json.loads(h5.attrs['sync_required_devices']), [1, 2])
            self.assertFalse(archive_tool.read_h5_status(path)['sync_traceability'])

    def test_archive_requires_aggregate_and_required_device_data(self):
        with tempfile.TemporaryDirectory(dir=os.getcwd()) as root:
            legacy = self._make_h5(root, 'legacy.h5', devices=(1,))
            with h5py.File(legacy, 'a') as h5:
                h5.create_dataset('emg1_2khz_adc', data=np.ones(2))
            legacy_status = archive_tool.read_h5_status(legacy)
            self.assertEqual(legacy_status['sync_status'], archive_tool.STATUS_UNVERIFIED)
            self.assertFalse(legacy_status['sync_traceability'])

            complete = self._make_h5(root, 'complete.h5', devices=(1,))
            with h5py.File(complete, 'a') as h5:
                h5.create_dataset('emg1_2khz_adc', data=np.ones(2))
                h5.attrs['sync_status'] = 'synced'
                h5.attrs['sync_aggregate_status'] = 'synced'
                h5.attrs['sync_required_devices'] = '[1]'
                h5.attrs['sync_device_results'] = json.dumps([
                    {'device_id': 1, 'valid': True, 'required_imu': False}])
                h5.attrs['sync_device_status_dev1'] = 'synced'
                h5.attrs['sync_device_validation_dev1'] = True
                h5.attrs['sync_device_imu_verified_dev1'] = True
                h5.attrs['sync_device_source_fingerprint_dev1'] = 'bin|100|123'
            complete_status = archive_tool.read_h5_status(complete)
            self.assertEqual(complete_status['sync_status'], archive_tool.STATUS_SYNCED)
            self.assertTrue(complete_status['sync_traceability'])

            incomplete = self._make_h5(root, 'incomplete.h5', devices=(1, 2))
            with h5py.File(incomplete, 'a') as h5:
                h5.create_dataset('emg1_2khz_adc', data=np.ones(2))
                h5.attrs['sync_status'] = 'synced'
                h5.attrs['sync_aggregate_status'] = 'synced'
                h5.attrs['sync_required_devices'] = '[1, 2]'
                h5.attrs['sync_device_results'] = json.dumps([
                    {'device_id': 1, 'valid': True, 'required_imu': False}])
            incomplete_status = archive_tool.read_h5_status(incomplete)
            self.assertEqual(incomplete_status['sync_status'], archive_tool.STATUS_UNVERIFIED)
            self.assertFalse(incomplete_status['sync_traceability'])


if __name__ == '__main__':
    unittest.main()
