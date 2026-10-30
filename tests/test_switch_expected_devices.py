"""切流"全有或全无"与发送队列丢弃策略的回归测试。

现场问题：一只手在切流时没启动成功，旧逻辑只要有一只成功就返回 success，
于是写出"单手"H5 且全链路无告警。这里锁定三件事：
1. 期望设备集合的规范化；
2. 缺设备时的错误信息包含手别与设备号；
3. 发送队列溢出时丢"最旧的数据"，而不是把刚采到的新数据整批丢掉。
"""
import unittest
from queue import PriorityQueue
from unittest.mock import patch

import ble_server


class SwitchAllOrNothingTests(unittest.IsolatedAsyncioTestCase):
    """切流核心：只要缺任何一台期望设备，就回滚已启动的流并报失败。"""

    def setUp(self):
        self.state = ble_server.state
        self.saved = {
            'dev1_mode': self.state.dev1.stream_mode,
            'dev1_streaming': self.state.dev1.is_streaming,
            'dev2_mode': self.state.dev2.stream_mode,
            'dev2_streaming': self.state.dev2.is_streaming,
        }
        self.state.dev1.stream_mode = 'idle'
        self.state.dev2.stream_mode = 'idle'
        self.state.dev1.is_streaming = False
        self.state.dev2.is_streaming = False
        self.responses = []
        self.stopped = []

        async def fake_send_to_control(ws, action, payload):
            self.responses.append({'action': action, **payload})

        async def fake_broadcast_event(event, payload):
            return None

        async def fake_sleep(_seconds):
            return None

        self.patches = [
            patch.object(ble_server, 'send_to_control', fake_send_to_control),
            patch.object(ble_server, 'broadcast_event', fake_broadcast_event),
            patch.object(ble_server.asyncio, 'sleep', fake_sleep),
            patch.object(self.state, 'get_connected_devices', lambda: [1, 2]),
            patch.object(ble_server.DeviceState, 'is_connected', lambda self: True),
        ]
        for item in self.patches:
            item.start()

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.state.dev1.stream_mode = self.saved['dev1_mode']
        self.state.dev1.is_streaming = self.saved['dev1_streaming']
        self.state.dev2.stream_mode = self.saved['dev2_mode']
        self.state.dev2.is_streaming = self.saved['dev2_streaming']

    def _patch_start(self, results):
        async def fake_start(dev, filename_str):
            if results.get(dev.device_id):
                dev.is_streaming = True
                dev.sd_filename = filename_str
                return True
            return False
        return patch.object(ble_server, '_do_start_stream_for_device', fake_start)

    def _patch_stop(self):
        async def fake_stop(dev):
            self.stopped.append(dev.device_id)
            dev.is_streaming = False
            return {'device_id': dev.device_id, 'local_stopped': True}
        return patch.object(ble_server, '_do_stop_stream_for_device', fake_stop)

    async def test_missing_expected_device_rolls_back_started_stream(self):
        with self._patch_start({1: True, 2: False}), self._patch_stop():
            await ble_server.switch_preview_to_collection(object(), expected_devices=[1, 2])
        response = self.responses[-1]
        self.assertFalse(response['success'])
        self.assertEqual(response['expected_devices'], [1, 2])
        self.assertEqual(response['missing_devices'], [2])
        self.assertEqual(response['started'], [])
        self.assertEqual(response['collection_bins'], {})
        self.assertIn('右手', response['error'])
        self.assertEqual(self.stopped, [1])
        self.assertEqual(self.state.dev1.stream_mode, 'idle')

    async def test_all_expected_devices_start_returns_success(self):
        with self._patch_start({1: True, 2: True}), self._patch_stop():
            await ble_server.switch_preview_to_collection(object(), expected_devices=[1, 2])
        response = self.responses[-1]
        self.assertTrue(response['success'])
        self.assertEqual(response['expected_devices'], [1, 2])
        self.assertEqual(response['missing_devices'], [])
        self.assertEqual(response['started'], [1, 2])
        self.assertEqual(sorted(response['collection_bins']), ['dev1', 'dev2'])
        self.assertEqual(self.stopped, [])


class ExpectedDeviceNormalizationTests(unittest.TestCase):
    def test_accepts_ints_strings_and_deduplicates(self):
        self.assertEqual(ble_server._normalize_expected_devices([2, 1, 2]), [1, 2])
        self.assertEqual(ble_server._normalize_expected_devices(["2", 1]), [1, 2])
        self.assertEqual(ble_server._normalize_expected_devices(1), [1])
        self.assertEqual(ble_server._normalize_expected_devices(None), [])

    def test_ignores_invalid_entries(self):
        self.assertEqual(ble_server._normalize_expected_devices([0, 3, "x", None]), [])
        self.assertEqual(ble_server._normalize_expected_devices("dev2"), [])

    def test_missing_message_names_side_and_device(self):
        message = ble_server._missing_devices_message([2])
        self.assertIn("右手", message)
        self.assertIn("dev2", message)


class QueueDropOldestTests(unittest.TestCase):
    def setUp(self):
        self.state = ble_server.state
        self.saved = (
            self.state.msg_queue,
            self.state.queue_low_limit,
            self.state.queue_limit,
            self.state.transport_fault_dropped,
            self.state.transport_fault_last_emit,
        )
        self.state.msg_queue = PriorityQueue()
        self.state.queue_low_limit = 2
        self.state.queue_limit = 4
        self.state.transport_fault_dropped = 0
        self.state.transport_fault_last_emit = 0.0

    def tearDown(self):
        (
            self.state.msg_queue,
            self.state.queue_low_limit,
            self.state.queue_limit,
            self.state.transport_fault_dropped,
            self.state.transport_fault_last_emit,
        ) = self.saved

    def _drain_markers(self):
        markers = []
        while not self.state.msg_queue.empty():
            _priority, _seq, _msg_type, data, _target = self.state.msg_queue.get_nowait()
            if data.get("type") != "transport_fault":
                markers.append(data.get("marker"))
        return markers

    def test_overflow_drops_oldest_data_and_keeps_newest(self):
        self.assertTrue(ble_server.add_to_queue(
            ble_server.PRIORITY_LOW, "data", {"type": "data", "marker": "a"}))
        self.assertTrue(ble_server.add_to_queue(
            ble_server.PRIORITY_LOW, "data", {"type": "data", "marker": "b"}))
        self.assertTrue(ble_server.add_to_queue(
            ble_server.PRIORITY_HIGH, "control", {"type": "control", "marker": "ctl"}))
        # 第 3 条数据到达时队列已到 low_limit：应丢掉最旧的 a，而不是丢掉 c。
        self.assertTrue(ble_server.add_to_queue(
            ble_server.PRIORITY_LOW, "data", {"type": "data", "marker": "c"}))
        # PriorityQueue 先按优先级出队，所以控制消息排在最前；数据保持 b -> c 的顺序。
        self.assertEqual(self._drain_markers(), ["ctl", "b", "c"])

    def test_low_message_rejected_when_no_low_priority_item_exists(self):
        self.assertTrue(ble_server.add_to_queue(
            ble_server.PRIORITY_HIGH, "control", {"type": "control", "marker": "h1"}))
        self.assertTrue(ble_server.add_to_queue(
            ble_server.PRIORITY_HIGH, "control", {"type": "control", "marker": "h2"}))
        self.assertFalse(ble_server.add_to_queue(
            ble_server.PRIORITY_LOW, "data", {"type": "data", "marker": "late"}))
        self.assertEqual(self._drain_markers(), ["h1", "h2"])


if __name__ == "__main__":
    unittest.main()
