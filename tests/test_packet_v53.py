"""V5.3.x 新包格式（可变 EMG 帧数 + IMU 实时尾包）的解析回归测试。

现场两个手环（固件 5.3.0）发出的包长只有 336/372/408/444/480 五种，
旧解析器按「固定 9 帧 + 18B*N IMU 快照」全部判成"包过短"，导致两路都是 0 帧。
"""
import struct
import unittest

import ble_server


def _emg_bytes(frames, bps=3, channels=16):
    data = bytearray()
    for frame in range(frames):
        for channel in range(channels):
            value = channel * 1000 + frame
            data += int(value).to_bytes(bps, "big", signed=True)
    return bytes(data)


def _make_v53(frames, samples, num_imus=2, seq=0, bps=3):
    data = bytearray(struct.pack("<I", seq))
    data += _emg_bytes(frames, bps=bps)
    data += struct.pack("<HIBB", ble_server.IMU_LIVE_HDR_MAGIC, seq, samples, num_imus)
    for sample in range(samples):
        for chip in range(num_imus):
            values = [sample * 100 + chip, 1, 2, 3, 4, 5]
            # V2 IMU 块固定 18B：acc6 + gyro6 + reserved6
            data += struct.pack("<6h", *values) + b"\x00" * 6
    return data


def _make_legacy(frames=9, num_imus=2, seq=0):
    data = bytearray(struct.pack("<I", seq))
    data += _emg_bytes(frames)
    for chip in range(num_imus):
        data += struct.pack("<6h", chip, 1, 2, 3, 4, 5) + b"\x00" * 6
    return data


class PacketV53Tests(unittest.TestCase):
    def setUp(self):
        self.dev = ble_server.DeviceState(1)
        self.dev.hw_version = "V2"
        self.dev.num_imus = 2
        self.dev.config["imu_enabled"] = True
        self.dev.config["is_16bit"] = False
        self.dev.config["frames_per_packet"] = 9

    def _parse(self, data, ts=1000.0):
        parsed = ble_server.parse_packet(data, self.dev)
        self.assertIsNotNone(parsed, f"packet len={len(data)} should parse")
        ble_server.finalize_parsed_packet(self.dev, parsed, ts)
        return parsed

    def test_v53_nine_frames_one_imu_sample(self):
        parsed = self._parse(_make_v53(frames=9, samples=1), 1000.0)
        self.assertEqual(parsed["layout"], "v53")
        self.assertEqual(parsed["n"], 9)
        self.assertEqual(parsed["imu_samples"], 1)
        self.assertEqual(len(parsed["imu_all"]), 2)
        self.assertEqual(parsed["frame_ids"], list(range(0, 9)))
        self.assertEqual(len(parsed["imu_t"]), 2)
        self.assertAlmostEqual(parsed["imu_t"][0], parsed["emg_t"][-1], places=6)

    def test_v53_six_frames_three_imu_samples(self):
        parsed = self._parse(_make_v53(frames=6, samples=3, seq=1), 1000.1)
        self.assertEqual(parsed["n"], 6)
        self.assertEqual(parsed["imu_samples"], 3)
        self.assertEqual(len(parsed["imu_all"]), 6)
        self.assertEqual(parsed["frame_ids"], list(range(0, 6)))
        self.assertEqual(len(parsed["imu_t"]), 6)
        self.assertEqual(parsed["imu_t"], sorted(parsed["imu_t"]))
        self.assertEqual(len(set(parsed["imu_t"])), 3)
        # 芯片下标按样本内 0/1 循环，而不是按展平后的行号
        self.assertEqual([row["index"] for row in parsed["imu_all"]],
                         [0, 1, 0, 1, 0, 1])

    def test_v53_trailer_without_imu_samples(self):
        parsed = self._parse(_make_v53(frames=9, samples=0, seq=3), 1000.2)
        self.assertEqual(parsed["n"], 9)
        self.assertEqual(parsed["imu_samples"], 0)
        self.assertEqual(parsed["imu_all"], [])
        self.assertFalse(parsed.get("imu_t"))

    def test_v53_16bit_emg(self):
        # 7 帧 × 16ch × 2B = 224，恰好避开 24bit 的 48B 帧格，能验证 bps 自动识别
        parsed = self._parse(_make_v53(frames=7, samples=1, seq=4, bps=2), 1000.3)
        self.assertEqual(parsed["n"], 7)
        self.assertEqual(len(parsed["raw"][0]), 16)

    def test_legacy_layout_still_parses(self):
        dev = ble_server.DeviceState(2)
        dev.hw_version = "V2"
        dev.num_imus = 2
        dev.config["imu_enabled"] = True
        parsed = ble_server.parse_packet(_make_legacy(9, 2), dev)
        self.assertIsNotNone(parsed)
        self.assertEqual(parsed["layout"], "legacy")
        self.assertEqual(parsed["n"], 9)
        self.assertEqual(len(parsed["imu_all"]), 2)

    def test_frame_cursor_survives_variable_fpp_and_reset(self):
        first = self._parse(_make_v53(frames=9, samples=1, seq=10), 1001.0)
        second = self._parse(_make_v53(frames=6, samples=1, seq=11), 1001.05)
        self.assertEqual(first["frame_ids"], list(range(0, 9)))
        self.assertEqual(second["frame_ids"], list(range(9, 15)))
        # 计数器复位：帧号继续往后走，不允许倒退
        third = self._parse(_make_v53(frames=9, samples=1, seq=0), 1001.1)
        self.assertEqual(third["frame_ids"], list(range(15, 24)))

    def test_packet_loss_advances_cursor(self):
        self._parse(_make_v53(frames=9, samples=1, seq=100), 1002.0)
        skipped = self._parse(_make_v53(frames=9, samples=1, seq=103), 1002.1)
        # 中间丢 2 包，按上一包帧数(9)补偿缺口
        self.assertEqual(skipped["frame_ids"], list(range(27, 36)))
        self.assertEqual(self.dev.lost_frames, 18)


if __name__ == "__main__":
    unittest.main()
