import json
import os
import tempfile
import unittest
from threading import Lock
from unittest.mock import patch

import h5py
import numpy as np

import storage_server


class CaptureStorageHealthTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="capture-health-", dir=os.path.dirname(__file__))
        with patch("storage_server.zmq.Context"):
            self.server = storage_server.HDF5StorageServer(storage_dir=self.temp.name)

    def tearDown(self):
        if self.server.f is not None:
            self.server.f.close()
        self.temp.cleanup()

    def _create(self, token):
        return self.server.create_file({
            "_storage_file_token": token, "user_id": "health-test", "recording_session_id": "session-x",
            "sd_bin_dev1": "S_L_test", "sd_bin_dev2": "S_R_test",
            "ble_dev1": "Band-L", "ble_dev2": "Band-R",
        })

    def _append_side(self, side, count=2):
        name = f"emg{side}"
        self.server._append_emg(name, np.zeros((16, count), dtype=np.int32),
                                np.arange(count, dtype=np.float64), np.arange(count, dtype=np.uint32))

    def _close(self, token, incomplete=False):
        return self.server.close_file({"_storage_file_token": token}, incomplete=incomplete)

    def test_dual_single_and_empty_h5_close_success_with_warnings_and_readback(self):
        for token, sides, expected_status, expected_warnings in (
            ("both", (1, 2), "complete", []),
            ("one", (1,), "partial", ["emg_dev2_empty"]),
            ("empty", (), "empty", ["emg_dev1_empty", "emg_dev2_empty"]),
        ):
            created = self._create(token)
            self.assertEqual(created["status"], "success")
            for side in sides:
                self._append_side(side)
            result = self._close(token)
            self.assertEqual(result["status"], "success")
            self.assertEqual(result["capture_warnings"], expected_warnings)
            self.assertEqual(result["data_health"]["content_status"], expected_status)
            self.assertEqual(result["data_health"]["save_validation"], "valid")
            self.assertTrue(result["data_health"]["readback"]["ok"])
            with h5py.File(result["file_path"], "r") as saved:
                self.assertEqual(len(saved["emg1_250hz_adc"]), 2 if 1 in sides else 0)
                self.assertEqual(len(saved["emg2_250hz_adc"]), 2 if 2 in sides else 0)
                stored = json.loads(saved.attrs["capture_data_health_json"])
                self.assertEqual(stored["save_validation"], "pending")
            self.server.finalized_files.clear()

    def test_row_counter_mismatch_refuses_to_report_success(self):
        self._create("mismatch")
        self._append_side(1)
        self.server.stats["emg1_frames"] += 1
        result = self._close("mismatch")
        self.assertEqual(result["status"], "error")
        self.assertIsNotNone(self.server.f)
        self.assertEqual(result["data_health"]["save_validation"], "failed")

    def test_incomplete_close_preserves_file_with_row_count_mismatch(self):
        self._create("mismatch-incomplete")
        self._append_side(1)
        self.server.stats["emg1_frames"] += 1
        refused = self._close("mismatch-incomplete")
        self.assertEqual(refused["status"], "error")
        self.assertIsNotNone(self.server.f)

        result = self._close("mismatch-incomplete", incomplete=True)
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["collection_status"], "incomplete")
        self.assertEqual(result["data_health"]["emg_rows"]["dev1"], 2)
        self.assertEqual(result["data_health"]["emg_write_counts"]["dev1"], 3)
        self.assertEqual(result["data_health"]["row_count_mismatches"], [
            {"side": "dev1", "dataset": "emg1_250hz_adc", "actual_rows": 2, "write_count": 3}
        ])
        self.assertIn("emg_dataset_write_count_mismatch", result["capture_warnings"])
        with h5py.File(result["file_path"], "r") as saved:
            self.assertEqual(saved.attrs["collection_status"], "incomplete")
            self.assertEqual(len(saved["emg1_250hz_adc"]), 2)
            stored_health = json.loads(saved.attrs["capture_data_health_json"])
            self.assertEqual(stored_health["row_count_mismatches"][0]["actual_rows"], 2)

        created = self._create("after-incomplete-mismatch")
        self.assertEqual(created["status"], "success")
        next_result = self._close("after-incomplete-mismatch")
        self.assertEqual(next_result["status"], "success")

    def test_record_write_error_survives_closed_h5_diagnostic_failure(self):
        self._create("closed-handle")
        self.server.f.close()
        self.server._record_data_write_error("original append failure")
        self.assertEqual(self.server.data_write_error, "original append failure")
        health = self.server._capture_health()
        self.assertEqual(health["content_status"], "unknown")
        self.assertTrue(health["diagnostic_error"])

    def test_write_error_burst_throttles_full_health_snapshots_but_keeps_each_error(self):
        self._create("error-burst")
        with patch.object(self.server, "_capture_health_json", wraps=self.server._capture_health_json) as snapshot, \
                patch("storage_server.debug_log") as log, \
                patch("storage_server.time.monotonic", return_value=100.0):
            for index in range(3):
                self.server._record_data_write_error(f"write failure {index}")
        self.assertEqual(snapshot.call_count, 1)
        messages = [call.args[0] for call in log.call_args_list]
        for index in range(3):
            self.assertTrue(any(f"write failure {index}" in message and "CAPTURE_HEALTH_WRITE_ERROR" not in message
                                for message in messages))
        self.assertEqual(sum("CAPTURE_HEALTH_WRITE_ERROR" in message for message in messages), 1)

    def test_close_without_open_file_keeps_error_return_semantics(self):
        result = self.server.close_file()
        self.assertEqual(result["status"], "error")

    def test_readback_open_failure_can_retry_without_losing_validation_snapshot(self):
        self._create("readback")
        self._append_side(1)
        self._append_side(2)
        original_file = h5py.File

        readonly_failures = {"remaining": 1}

        def fail_readonly_once(path, mode="r", *args, **kwargs):
            if mode == "r" and readonly_failures["remaining"]:
                readonly_failures["remaining"] -= 1
                raise OSError("simulated readback failure")
            return original_file(path, mode, *args, **kwargs)

        with patch("storage_server.h5py.File", side_effect=fail_readonly_once):
            result = self._close("readback")
        self.assertIsNone(self.server.f)
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["data_health"]["save_validation"], "failed")
        self.assertEqual(self.server._pending_close_validation["file_path"], result["file_path"])
        self.assertEqual(self.server._pending_close_validation["health"]["emg_rows"], {"dev1": 2, "dev2": 2})
        self.assertNotIn("readback", self.server.finalized_files)

        retried = self._close("readback")
        self.assertEqual(retried["status"], "success")
        self.assertEqual(retried["data_health"]["save_validation"], "valid")
        self.assertEqual(retried["data_health"]["readback"]["emg_rows"], {"dev1": 2, "dev2": 2})
        self.assertIsNone(self.server._pending_close_validation)
        self.assertIn("readback", self.server.finalized_files)
        with original_file(result["file_path"], "r") as saved:
            self.assertEqual(saved.attrs["collection_status"], "completed")
            self.assertEqual(saved.attrs["capture_validation"], "pending")
            self.assertEqual(json.loads(saved.attrs["capture_data_health_json"])["save_validation"], "pending")


if __name__ == "__main__":
    unittest.main()
