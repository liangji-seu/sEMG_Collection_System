import contextlib
import io
import struct
import unittest
from unittest.mock import patch

import ble_server


class BleCaptureHealthTests(unittest.TestCase):
    def test_notification_without_valid_emg_warns_then_logs_one_recovery(self):
        dev = ble_server.DeviceState(1)
        dev.is_streaming = True
        dev.stream_mode = "collection"
        dev.sd_filename = "A001_L_test"
        dev.name = "Band-L"
        dev.stream_started_monotonic = 100.0
        handler = ble_server.create_notification_handler(dev)
        capture = io.StringIO()
        with contextlib.redirect_stderr(capture), patch("ble_server.time.monotonic", return_value=105.0):
            handler(0, bytearray(b"bad notification"))
            health = ble_server.log_capture_device_health(dev, 105.0)
        self.assertIsNone(dev.last_valid_emg_monotonic)
        self.assertEqual(health["last_valid_notification_age_s"], 0.0)
        self.assertIn('"last_valid_emg_age_s": null', capture.getvalue())
        self.assertIn("no_valid_emg", capture.getvalue())

        dev.config["imu_enabled"] = False
        params = ble_server.get_packet_params(dev.config)
        packet = struct.pack("<I", 1) + bytes(params["emg_len"])
        with contextlib.redirect_stderr(capture), patch("ble_server.time.monotonic", return_value=106.0):
            parsed = ble_server.parse_packet(packet, dev)
            ble_server.parse_packet(packet, dev)
        self.assertIsNotNone(parsed)
        self.assertEqual(dev.last_valid_emg_monotonic, 106.0)
        self.assertEqual(capture.getvalue().count("EMG_CAPTURE_HEALTH recovered"), 1)

    def test_repeated_no_emg_snapshots_do_not_repeat_missing_warning(self):
        dev = ble_server.DeviceState(2)
        dev.is_streaming = True
        dev.stream_started_monotonic = 10.0
        capture = io.StringIO()
        with contextlib.redirect_stderr(capture):
            ble_server.log_capture_device_health(dev, 15.0)
            ble_server.log_capture_device_health(dev, 20.0)
        self.assertEqual(capture.getvalue().count("no_valid_emg"), 1)
        self.assertIn('"device_id": 2', capture.getvalue())
        self.assertIn('"raw_dropped": 0', capture.getvalue())


if __name__ == "__main__":
    unittest.main()
