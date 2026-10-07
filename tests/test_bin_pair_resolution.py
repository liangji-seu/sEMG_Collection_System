import os
import sys
import tempfile
import unittest
from pathlib import Path

import h5py

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
import hdf5_tool


class BinPairResolutionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='bin-pair-', dir=ROOT)
        self.root = Path(self.temp.name)
        self.h5 = self.root / 'L372_坐姿_session4_20260903_155823.h5'
        with h5py.File(self.h5, 'w') as f:
            f.attrs['sd_bin_dev1'] = 'L372_L_260903_155549'
            f.attrs['sd_bin_dev2'] = 'L372_R_260903_155550'

    def tearDown(self):
        self.temp.cleanup()

    def touch_pair(self, prefix, *, imu=True):
        (self.root / f'{prefix}_emg.bin').touch()
        if imu:
            (self.root / f'{prefix}_imu.bin').touch()

    def resolve(self, dev=1, prefix='L372_L_260903_155549'):
        return hdf5_tool._resolve_time_matched_bin_pair(
            str(self.root), str(self.h5), dev, prefix)

    def test_stale_existing_reference_is_replaced_by_near_session_pair(self):
        self.touch_pair('L372_L_260903_155549')
        self.touch_pair('L372_L_260903_155821')
        emg, imu, info = self.resolve()
        self.assertTrue(emg.endswith('L372_L_260903_155821_emg.bin'))
        self.assertTrue(imu.endswith('L372_L_260903_155821_imu.bin'))
        self.assertEqual(info['status'], 'time_matched_replacement')

    def test_missing_reference_uses_near_session_pair(self):
        self.touch_pair('L372_L_260903_155821')
        emg, imu, info = self.resolve()
        self.assertTrue(emg.endswith('L372_L_260903_155821_emg.bin'))
        self.assertIsNotNone(imu)
        self.assertEqual(info['status'], 'time_matched_replacement')

    def test_near_existing_reference_is_kept(self):
        self.touch_pair('L372_L_260903_155821')
        emg, imu, info = self.resolve(prefix='L372_L_260903_155821')
        self.assertTrue(emg.endswith('L372_L_260903_155821_emg.bin'))
        self.assertEqual(info['status'], 'legacy_valid')

    def test_subject_and_side_are_isolated(self):
        self.touch_pair('L373_L_260903_155821')
        self.touch_pair('L372_R_260903_155821')
        emg, imu, info = self.resolve()
        self.assertIsNone(emg)
        self.assertIsNone(imu)
        self.assertEqual(info['reason'], 'no_same_subject_side_date_emg_candidate')

    def test_far_candidate_is_rejected(self):
        self.touch_pair('L372_L_260903_160500')
        emg, imu, info = self.resolve()
        self.assertIsNone(emg)
        self.assertEqual(info['reason'], 'nearest_candidate_outside_time_window')

    def test_far_candidate_keeps_existing_reference_for_adc_check(self):
        self.touch_pair('L372_L_260903_155549')
        self.touch_pair('L372_L_260903_160500')
        worker = hdf5_tool.SyncWorker.__new__(hdf5_tool.SyncWorker)
        worker.bin_dir = str(self.root)
        worker.sync_mode = 'one_to_one'
        worker.validate_data = True
        worker.log = type('L', (), {'emit': lambda self, msg: None})()
        emg, imu = worker._find_bin_files(str(self.h5), 1)
        self.assertTrue(emg.endswith('L372_L_260903_155549_emg.bin'))
        self.assertTrue(imu.endswith('L372_L_260903_155549_imu.bin'))

    def test_nonstandard_h5_name_keeps_existing_reference(self):
        record = self.root / 'record.h5'
        with h5py.File(record, 'w') as f:
            f.attrs['sd_bin_dev1'] = 'L372_L_260903_155821'
        self.touch_pair('L372_L_260903_155821')
        worker = hdf5_tool.SyncWorker.__new__(hdf5_tool.SyncWorker)
        worker.bin_dir = str(self.root)
        worker.sync_mode = 'one_to_one'
        worker.validate_data = True
        worker.log = type('L', (), {'emit': lambda self, msg: None})()
        emg, imu = worker._find_bin_files(str(record), 1)
        self.assertTrue(emg.endswith('L372_L_260903_155821_emg.bin'))
        self.assertTrue(imu.endswith('L372_L_260903_155821_imu.bin'))

    def test_ambiguous_nearest_candidates_are_rejected(self):
        a = self.root / 'a'; b = self.root / 'b'
        a.mkdir(); b.mkdir()
        for folder in (a, b):
            (folder / 'L372_L_260903_155821_emg.bin').touch()
        emg, imu, info = self.resolve()
        self.assertIsNone(emg)
        self.assertEqual(info['reason'], 'ambiguous_nearest_emg_candidates')

    def test_one_to_many_keeps_legacy_reference(self):
        self.touch_pair('L372_L_260903_155549')
        worker = hdf5_tool.SyncWorker.__new__(hdf5_tool.SyncWorker)
        worker.bin_dir = str(self.root)
        worker.sync_mode = 'one_to_many'
        worker.validate_data = True
        worker.log = type('L', (), {'emit': lambda self, msg: None})()
        emg, imu = worker._find_bin_files(str(self.h5), 1)
        self.assertTrue(emg.endswith('L372_L_260903_155549_emg.bin'))
        self.assertTrue(imu.endswith('L372_L_260903_155549_imu.bin'))

    def test_verify_false_does_not_auto_select_time_candidate(self):
        self.touch_pair('L372_L_260903_155821')
        worker = hdf5_tool.SyncWorker.__new__(hdf5_tool.SyncWorker)
        worker.bin_dir = str(self.root)
        worker.sync_mode = 'one_to_one'
        worker.validate_data = False
        worker.log = type('L', (), {'emit': lambda self, msg: None})()
        emg, imu = worker._find_bin_files(str(self.h5), 1)
        self.assertIsNone(emg)
        self.assertIsNone(imu)


if __name__ == '__main__':
    unittest.main()
