import json
import tempfile
import unittest
from pathlib import Path

import h5py
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
import sys
sys.path.insert(0, str(ROOT / 'tools'))
import bin_sync_tool as sync


class SyncStatusSemanticsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='sync-status-', dir=ROOT)
        self.path = Path(self.temp.name) / 'status.h5'

    def tearDown(self):
        self.temp.cleanup()

    def _create(self, *, validation=True, imu_output=False, imu_status=None,
                imu_count=None, legacy_alignment=False, with_imu_verified=False,
                physical_device_ids=(1,)):
        emg_dtype = np.dtype([('channels', '<i2', (16,)), ('sd_frame_id', '<i8'), ('time', '<f8')])
        imu_dtype = np.dtype([('time', '<f8'), ('valid', '<?')])
        with h5py.File(self.path, 'w') as handle:
            handle.attrs['physical_device_ids'] = json.dumps(list(physical_device_ids))
            handle.create_dataset('emg1_250hz_adc', data=np.zeros(1, dtype=emg_dtype))
            handle.create_dataset('emg1_2khz_adc', data=np.zeros(1, dtype=emg_dtype))
            handle.attrs['sync_device_status_dev1'] = 'synced'
            handle.attrs['sync_device_validation_dev1'] = bool(validation)
            handle.attrs['sync_device_source_fingerprint_dev1'] = 'test-source'
            if imu_count is not None:
                handle.attrs['imu1_num_imus'] = int(imu_count)
            if imu_output:
                handle.create_dataset('imu1a_100hz', data=np.array([(1.0, True)], dtype=imu_dtype))
            if imu_status is not None:
                handle.attrs['sync_device_imu_status_dev1'] = imu_status
            if with_imu_verified:
                handle.attrs['sync_device_imu_verified_dev1'] = False
            if legacy_alignment:
                handle.attrs['imu1_time_alignment'] = 'emg_time_fallback'
                handle.attrs['imu1_alignment_confidence'] = 'unverified'

    def test_successful_imu_output_is_synced_but_strictly_unverified(self):
        self._create(imu_output=True, imu_status='success', imu_count=1,
                     with_imu_verified=True)
        with h5py.File(self.path, 'r') as handle:
            summary = sync.sync_status_summary(handle)
        self.assertEqual(summary['status'], 'synced')
        self.assertTrue(summary['emg_complete'])
        self.assertTrue(summary['imu_complete'])
        self.assertFalse(summary['verified'])
        self.assertEqual(summary['imu_unverified_devices'], [1])

    def test_missing_required_imu_is_partial(self):
        self._create(imu_status='success', imu_count=1)
        with h5py.File(self.path, 'r') as handle:
            summary = sync.sync_status_summary(handle)
        self.assertEqual(summary['status'], 'partial')
        self.assertTrue(summary['emg_complete'])
        self.assertFalse(summary['imu_complete'])
        self.assertEqual(summary['imu_missing_devices'], [1])

    def test_failed_emg_validation_stays_unverified(self):
        self._create(validation=False, imu_output=True, imu_status='success', imu_count=1)
        with h5py.File(self.path, 'r') as handle:
            summary = sync.sync_status_summary(handle)
        self.assertEqual(summary['status'], 'unverified')
        self.assertFalse(summary['emg_complete'])

    def test_legacy_output_and_alignment_attrs_are_read_only_migrated(self):
        self._create(imu_output=True, imu_count=1, legacy_alignment=True,
                     with_imu_verified=True)
        with h5py.File(self.path, 'r') as handle:
            summary = sync.sync_status_summary(handle)
        self.assertEqual(summary['status'], 'synced')
        self.assertTrue(summary['imu_complete'])
        self.assertEqual(summary['imu_unverified_devices'], [1])

    def test_output_without_per_device_imu_evidence_is_unverified(self):
        self._create(imu_output=True, imu_count=1)
        with h5py.File(self.path, 'r') as handle:
            summary = sync.sync_status_summary(handle)
        self.assertEqual(summary['status'], 'unverified')
        self.assertFalse(summary['imu_complete'])

    def test_repeat_skipped_preserves_existing_imu_status(self):
        self._create(imu_output=True, imu_status='success', imu_count=1,
                     with_imu_verified=True)
        with h5py.File(self.path, 'r+') as handle:
            handle.attrs['sync_device_imu_verified_dev1'] = True
            summary = sync.update_sync_status(
                handle, 1, imu_result={'status': 'skipped', 'reason': 'already_synced'},
                validation_passed=True)
            self.assertEqual(handle.attrs['sync_device_imu_status_dev1'], 'success')
            self.assertTrue(handle.attrs['sync_device_imu_verified_dev1'])
            self.assertEqual(summary['status'], 'synced')

    def test_fresh_emg_rebuild_skip_invalidates_old_imu_output(self):
        self._create(imu_output=True, imu_status='success', imu_count=1,
                     with_imu_verified=True, legacy_alignment=True)
        with h5py.File(self.path, 'r+') as handle:
            summary = sync.update_sync_status(
                handle, 1,
                imu_result={'status': 'success', 'imu_status': 'skipped'},
                validation_passed=True)
            self.assertEqual(handle.attrs['sync_device_imu_status_dev1'], 'skipped')
            self.assertEqual(summary['status'], 'partial')
            self.assertEqual(summary['imu_missing_devices'], [1])


    def test_missing_expected_side_stays_partial_after_the_other_side_is_synced(self):
        # 采集端在切流时声明期望双手（physical_device_ids=[1,2]），但只有左手有数据并同步成功。
        # 右手整段 0 行时不能被"非空数据集推断"排除掉，否则单手文件会被标成 synced。
        self._create(imu_output=True, imu_status='success', imu_count=1,
                     with_imu_verified=True, physical_device_ids=(1, 2))
        with h5py.File(self.path, 'r') as handle:
            summary = sync.sync_status_summary(handle)
        self.assertEqual(summary['required_devices'], [1, 2])
        self.assertFalse(summary['emg_complete'])
        self.assertEqual(summary['status'], 'partial')


if __name__ == '__main__':
    unittest.main()
