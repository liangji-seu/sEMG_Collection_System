"""对侧时间锚回填机制的回归测试（不依赖真实 bin 数据）。"""
import os
import sys
import tempfile
import unittest
from unittest.mock import patch

import h5py

_TOOLS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tools")
if _TOOLS_DIR not in sys.path:
    sys.path.insert(0, _TOOLS_DIR)

try:
    import hdf5_tool
except Exception as error:  # PyQt5 等 GUI 依赖缺失时跳过
    hdf5_tool = None
    _IMPORT_ERROR = error


@unittest.skipIf(hdf5_tool is None, "hdf5_tool 无法导入（缺少 GUI 依赖）")
class PeerTimeFallbackTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="peer-fallback-test-")
        self.path = os.path.join(self.temp.name, "t.h5")
        with h5py.File(self.path, "w") as f:
            f.create_dataset("emg1_250hz_adc", shape=(0,), maxshape=(None,), dtype="u1")
            f.create_dataset("emg2_250hz_adc", shape=(3,), maxshape=(None,), dtype="u1")

    def tearDown(self):
        self.temp.cleanup()

    def _specs(self):
        return [(1, "l.bin", "l_imu.bin", True), (2, "r.bin", "r_imu.bin", True)]

    def test_failed_hand_borrows_peer_clock(self):
        calls = {}

        def fake_sync(_h5, emg_bin, peer_id, peer_bin, target_id, imu_bin_path=None,
                      full_bin=True, allow_unreliable_target=False):
            calls.update(emg=emg_bin, peer=peer_id, target=target_id,
                         allow=allow_unreliable_target, full=full_bin,
                         imu=imu_bin_path)
            return {"status": "success", "frames_2khz": 322338,
                    "peer_time_fallback": True}

        results = [(1, {"status": "validation_failed", "reason": "adc mismatch"}, True),
                   (2, {"status": "success", "frames_2khz": 321397}, True)]
        with patch.object(hdf5_tool, "_sync_output_is_valid", return_value=(True, "")), \
                patch.object(hdf5_tool, "sync_h5_from_peer_time_reference", side_effect=fake_sync), \
                patch.object(hdf5_tool, "update_sync_status"):
            out = hdf5_tool._apply_peer_time_fallback(
                self.path, self._specs(), results, lambda _msg: None, full_bin=True)

        self.assertEqual(calls["target"], 1)
        self.assertEqual(calls["peer"], 2)
        self.assertEqual(calls["emg"], "l.bin")
        self.assertEqual(calls["imu"], "l_imu.bin")
        self.assertTrue(calls["allow"])
        self.assertTrue(calls["full"])
        self.assertEqual(out[0][1]["status"], "success")
        self.assertTrue(out[0][1].get("peer_time_fallback"))
        # 对侧结果不受影响
        self.assertEqual(out[1][1]["status"], "success")

    def test_no_fallback_when_no_verified_peer(self):
        results = [(1, {"status": "validation_failed", "reason": "x"}, True),
                   (2, {"status": "validation_failed", "reason": "y"}, True)]
        with patch.object(hdf5_tool, "sync_h5_from_peer_time_reference") as sync_mock, \
                patch.object(hdf5_tool, "update_sync_status"):
            out = hdf5_tool._apply_peer_time_fallback(
                self.path, self._specs(), results, lambda _msg: None)
        sync_mock.assert_not_called()
        self.assertEqual(out[0][1]["status"], "validation_failed")

    def test_peer_that_failed_validation_is_not_used(self):
        results = [(1, {"status": "validation_failed", "reason": "x"}, True),
                   (2, {"status": "success", "frames_2khz": 10}, True)]
        with patch.object(hdf5_tool, "_sync_output_is_valid", return_value=(False, "bad")), \
                patch.object(hdf5_tool, "sync_h5_from_peer_time_reference") as sync_mock, \
                patch.object(hdf5_tool, "update_sync_status"):
            out = hdf5_tool._apply_peer_time_fallback(
                self.path, self._specs(), results, lambda _msg: None)
        sync_mock.assert_not_called()
        self.assertEqual(out[0][1]["status"], "validation_failed")


if __name__ == "__main__":
    unittest.main()
