import os
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import numpy as np

import ble_server
import storage_server


class BleCaptureFaultSignalTests(unittest.TestCase):
    def setUp(self):
        self.queued = []
        self.queue_patch = patch(
            "ble_server.add_to_queue",
            side_effect=lambda priority, kind, packet: self.queued.append((priority, kind, packet)) or True,
        )
        self.queue_patch.start()
        self.addCleanup(self.queue_patch.stop)

    def _dev(self, mode="collection", connected=True):
        dev = ble_server.DeviceState(1)
        dev.is_streaming = True
        dev.stream_mode = mode
        dev.sd_filename = "S001_L_capture"
        dev.stream_started_monotonic = 100.0
        dev.client = SimpleNamespace(is_connected=connected)
        return dev

    def test_collection_no_emg_and_disconnect_emit_once_with_required_payload(self):
        dev = self._dev()
        with patch("ble_server.log"):
            ble_server.log_capture_device_health(dev, 104.9)
            ble_server.log_capture_device_health(dev, 105.0)
            ble_server.log_capture_device_health(dev, 110.0)
        self.assertEqual(len(self.queued), 1)
        priority, kind, packet = self.queued[0]
        self.assertEqual((priority, kind), (ble_server.PRIORITY_HIGH, "data"))
        self.assertEqual(packet["type"], "capture_fault")
        self.assertEqual(packet["source"], "ble")
        self.assertEqual(packet["code"], "ble_no_emg")
        self.assertEqual(packet["device_id"], 1)
        self.assertEqual(packet["sd_prefix"], "S001_L_capture")

        dev.capture_fault_active = False
        dev.client.is_connected = False
        with patch("ble_server.log"):
            ble_server.log_capture_device_health(dev, 111.0)
            ble_server.log_capture_device_health(dev, 116.0)
        self.assertEqual(len(self.queued), 2)
        self.assertEqual(self.queued[1][2]["code"], "ble_disconnected")

    def test_preview_does_not_emit_and_recovery_allows_a_later_fault(self):
        preview = self._dev(mode="preview")
        with patch("ble_server.log"):
            ble_server.log_capture_device_health(preview, 120.0)
        self.assertEqual(self.queued, [])

        dev = self._dev()
        with patch("ble_server.log"):
            ble_server.log_capture_device_health(dev, 105.0)
        self.assertTrue(dev.capture_fault_active)
        dev.last_valid_emg_monotonic = 106.0
        with patch("ble_server.log"):
            ble_server.log_capture_device_health(dev, 107.0)
        self.assertFalse(dev.capture_fault_active)
        with patch("ble_server.log"):
            ble_server.log_capture_device_health(dev, 112.0)
        self.assertEqual([item[2]["code"] for item in self.queued], ["ble_no_emg", "ble_no_emg"])

        dev.capture_fault_active = True
        ble_server.clear_stream_buffers(dev)
        self.assertFalse(dev.capture_fault_active)
        dev.capture_fault_active = True
        dev.reset_stats()
        self.assertFalse(dev.capture_fault_active)

    def test_explicit_collection_disconnect_queues_fault_before_reset(self):
        dev = self._dev(connected=True)
        with patch.object(ble_server.state, "get_device", return_value=dev), \
                patch("ble_server.stop_stream", new=self._stop_stream):
            import asyncio
            asyncio.run(ble_server.disconnect_device(None, 1, silent=True))
        self.assertEqual(len(self.queued), 1)
        packet = self.queued[0][2]
        self.assertEqual(packet["code"], "ble_disconnected")
        self.assertEqual(packet["sd_prefix"], "S001_L_capture")
        self.assertIsNone(dev.sd_filename)

    async def _stop_stream(self, *_args, **_kwargs):
        dev = ble_server.state.get_device(1)
        dev.is_streaming = False
        ble_server.clear_stream_buffers(dev)


class BleStopResultTests(unittest.IsolatedAsyncioTestCase):
    def _dev(self, connected=True):
        dev = ble_server.DeviceState(1)
        dev.is_streaming = True
        dev.stream_mode = "collection"
        dev.raw_buffer.append(b"raw")
        dev.data_buffer.append(b"data")
        dev.client = SimpleNamespace(
            is_connected=connected,
            stop_notify=AsyncMock(),
        )
        return dev

    async def test_disconnect_and_stop_write_failure_clear_locally_without_claiming_command_sent(self):
        disconnected = self._dev(connected=False)
        with patch("ble_server.send_control_command", new_callable=AsyncMock) as send, \
                patch("ble_server.log"):
            result = await ble_server._do_stop_stream_for_device(disconnected)
        send.assert_not_awaited()
        self.assertEqual(result["device_id"], 1)
        self.assertTrue(result["local_stopped"])
        self.assertFalse(result["stop_command_sent"])
        self.assertIn("断开", result["error"])
        self.assertFalse(disconnected.is_streaming)
        self.assertEqual(len(disconnected.raw_buffer), 0)
        self.assertEqual(len(disconnected.data_buffer), 0)
        disconnected.client.stop_notify.assert_awaited_once()

        write_failed = self._dev(connected=True)
        with patch("ble_server.send_control_command", new_callable=AsyncMock,
                   side_effect=OSError("gatt write failed")), patch("ble_server.log"):
            result = await ble_server._do_stop_stream_for_device(write_failed)
        self.assertTrue(result["local_stopped"])
        self.assertFalse(result["stop_command_sent"])
        self.assertIn("gatt write failed", result["error"])
        self.assertFalse(write_failed.is_streaming)
        self.assertEqual(len(write_failed.raw_buffer), 0)
        self.assertEqual(len(write_failed.data_buffer), 0)
        write_failed.client.stop_notify.assert_awaited_once()

    async def test_successful_stop_is_reported_per_device_without_changing_top_level_success(self):
        dev = self._dev(connected=True)
        dev2 = ble_server.DeviceState(2)
        send = AsyncMock()
        send_response = AsyncMock()
        with patch.object(ble_server.state, "get_device", side_effect=lambda did: dev if did == 1 else dev2), \
                patch("ble_server.send_control_command", new=send), \
                patch("ble_server.send_to_control", new=send_response), \
                patch("ble_server.broadcast_event", new_callable=AsyncMock), \
                patch("ble_server.asyncio.sleep", new_callable=AsyncMock), \
                patch("ble_server.log"):
            await ble_server.stop_collection_stream(object())

        send.assert_awaited_once_with(dev, bytes([ble_server.CMD_MAP["STOP"]]))
        sent_action, response = send_response.await_args.args[1:]
        self.assertEqual(sent_action, "stop_collection_stream")
        self.assertTrue(response["success"])
        self.assertTrue(response["stop_results"]["dev1"]["local_stopped"])
        self.assertTrue(response["stop_results"]["dev1"]["stop_command_sent"])
        self.assertEqual(response["stop_results"]["dev1"]["device_id"], 1)
        self.assertFalse(dev.is_streaming)
        self.assertEqual(dev.stream_mode, "idle")


class StorageCaptureFaultStatusTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="capture-fault-status-", dir=os.path.dirname(__file__))
        self.addCleanup(self.temp.cleanup)
        with patch("storage_server.zmq.Context"):
            self.server = storage_server.HDF5StorageServer(storage_dir=self.temp.name)
        self.addCleanup(self._close)

    def _close(self):
        if self.server.f is not None:
            self.server.f.close()

    def _create(self, token):
        result = self.server.create_file({
            "_storage_file_token": token,
            "user_id": "fault-test",
            "recording_session_id": "fault-session",
            "sd_bin_dev1": "S001_L_test",
            "sd_bin_dev2": "S001_R_test",
            "ble_dev1": "Band-L",
            "ble_dev2": "Band-R",
        })
        self.assertEqual(result["status"], "success")
        return result

    def _write_emg_rows(self, count=3):
        self.server._append_emg("emg1", np.zeros((16, count), dtype=np.int32),
                                np.arange(count, dtype=np.float64), np.arange(count, dtype=np.uint32))

    def test_open_status_exposes_push_write_error_rows_and_disk_free(self):
        self._create("fault-status")
        self._write_emg_rows()

        with patch.object(self.server, "append_data", return_value={"status": "error", "msg": "disk full"}):
            self.assertFalse(self.server._process_data_request({
                "cmd": "append",
                "params": {"_storage_file_token": "fault-status", "_storage_seq": 1, "data": {}},
            }))
            self.server._record_data_write_error("later error")

        status = self.server.get_file_status()
        self.assertTrue(status["open"])
        self.assertEqual(status["write_error"], "disk full")
        health = status["data_health"]
        self.assertEqual(health["write_error"], "disk full")
        self.assertEqual(health["emg_rows"]["dev1"], 3)
        self.assertIsInstance(health["disk_free_bytes"], int)

        self._close()
        closed_status = self.server.get_file_status()
        self.assertFalse(closed_status["open"])
        self.assertNotIn("data_health", closed_status)

    def test_incomplete_metadata_failure_still_closes_and_reads_existing_rows(self):
        self._create("incomplete-metadata")
        self._write_emg_rows(4)
        with patch.object(self.server, "_store_capture_health", side_effect=OSError("disk full while writing attrs")):
            result = self.server.close_file({"_storage_file_token": "incomplete-metadata"}, incomplete=True)

        self.assertEqual(result["status"], "error")
        self.assertEqual(result["error"], "disk full while writing attrs")
        self.assertTrue(result["file_closed"])
        self.assertEqual(result["readback"], {"ok": True, "emg_rows": {"dev1": 4, "dev2": 0}})
        with storage_server.h5py.File(result["file_path"], "r") as saved:
            self.assertEqual(len(saved["emg1_250hz_adc"]), 4)

    def test_incomplete_fallback_reports_flush_close_and_readback_failures(self):
        self._create("fallback-errors")
        self._write_emg_rows(2)
        original_handle = self.server.f

        class FailingHandle:
            def __init__(self, wrapped):
                self.attrs = wrapped.attrs

            def flush(self):
                raise OSError("flush failed")

            def close(self):
                raise OSError("close failed")

        failing_handle = FailingHandle(original_handle)

        def fail_metadata(_health):
            self.server.f = failing_handle
            raise OSError("original attrs failure")

        try:
            with patch.object(self.server, "_store_capture_health", side_effect=fail_metadata):
                result = self.server.close_file({"_storage_file_token": "fallback-errors"}, incomplete=True)
        finally:
            self.server.f = original_handle

        self.assertEqual(result["status"], "error")
        self.assertEqual(result["error"], "original attrs failure")
        self.assertFalse(result["file_closed"])
        self.assertEqual(result["fallback_errors"]["flush"], "flush failed")
        self.assertEqual(result["fallback_errors"]["close"], "close failed")

    def test_incomplete_fallback_reports_readback_failure_after_close(self):
        self._create("fallback-readback")
        self._write_emg_rows(2)
        real_file = storage_server.h5py.File

        def fail_readback(path, mode="r", *args, **kwargs):
            if mode == "r":
                raise OSError("readback failed")
            return real_file(path, mode, *args, **kwargs)

        with patch.object(self.server, "_store_capture_health", side_effect=OSError("attrs failed")), \
                patch("storage_server.h5py.File", side_effect=fail_readback):
            result = self.server.close_file({"_storage_file_token": "fallback-readback"}, incomplete=True)

        self.assertEqual(result["status"], "error")
        self.assertEqual(result["error"], "attrs failed")
        self.assertTrue(result["file_closed"])
        self.assertFalse(result["readback"]["ok"])
        self.assertEqual(result["readback"]["error"], "readback failed")


if __name__ == "__main__":
    unittest.main()
