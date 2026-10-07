import asyncio
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import ble_server
import camera_server
import mocap_server

try:
    import cv2
    import numpy as np
    HAS_CV2 = True
except ImportError:
    HAS_CV2 = False

sys.stdout = sys.__stdout__
sys.stderr = sys.__stderr__
if sys.platform == 'win32' and hasattr(asyncio, 'WindowsSelectorEventLoopPolicy'):
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())


class FakeClient:
    def __init__(self, delay=0):
        self.delay = delay
        self.messages = []
        self.closed = False

    async def send(self, payload):
        if self.delay:
            await asyncio.sleep(self.delay)
        self.messages.append(payload)

    async def close(self, **kwargs):
        self.closed = True


class DeviceServiceTests(unittest.TestCase):
    def setUp(self):
        self.old_queue = ble_server.state.msg_queue
        self.old_loop = ble_server.state.main_loop
        self.old_task = ble_server.state.queue_task
        self.old_clients = ble_server.state.control_clients
        self.old_data_clients = ble_server.state.data_clients
        ble_server.state.msg_queue = ble_server.PriorityQueue()
        ble_server.state.main_loop = None
        ble_server.state.queue_task = None
        ble_server.state.control_clients = set()
        ble_server.state.data_clients = set()

    def tearDown(self):
        ble_server.state.msg_queue = self.old_queue
        ble_server.state.main_loop = self.old_loop
        ble_server.state.queue_task = self.old_task
        ble_server.state.control_clients = self.old_clients
        ble_server.state.data_clients = self.old_data_clients

    def test_ble_low_overflow_does_not_pop_control(self):
        control = FakeClient()
        ble_server.state.msg_queue.put((ble_server.PRIORITY_CONTROL, 0, 'control', {'x': 1}, control))
        for i in range(ble_server.state.queue_low_limit - 1):
            ble_server.state.msg_queue.put((ble_server.PRIORITY_LOW, i + 1, 'data', {'i': i}, None))
        ble_server.state.main_loop = None
        self.assertFalse(ble_server.add_to_queue(ble_server.PRIORITY_LOW, 'data', {'i': 'overflow'}))
        self.assertEqual(ble_server.state.msg_queue.get_nowait()[2], 'control')
        self.assertEqual(ble_server.state.msg_queue.qsize(), ble_server.state.queue_low_limit)
        faults = [item[3] for item in ble_server.state.msg_queue.queue if item[2] == 'broadcast']
        self.assertEqual(len(faults), 1)
        self.assertEqual(faults[0]['type'], 'transport_fault')
        self.assertEqual(faults[0]['dropped'], 1)

    def test_ble_control_response_echoes_context_request_id(self):
        ble_server.state.main_loop = None
        token = ble_server._control_request_id.set('req-42')
        try:
            _drive_coroutine(ble_server.send_to_control(None, 'status', {'success': True}))
        finally:
            ble_server._control_request_id.reset(token)
        message = ble_server.state.msg_queue.get_nowait()[3]
        self.assertEqual(message['request_id'], 'req-42')

        _drive_coroutine(ble_server.send_to_control(None, 'status', {'success': True}))
        legacy_message = ble_server.state.msg_queue.get_nowait()[3]
        self.assertNotIn('request_id', legacy_message)

    def test_mocap_buffer_is_bounded_and_drains_without_clients(self):
        receiver = mocap_server.BaseMocapReceiver()
        for i in range(receiver._frame_buffer.maxlen + 5):
            receiver._append_frame({'frame': i})
        frames = receiver.get_buffered_frames()
        self.assertEqual(len(frames), receiver._frame_buffer.maxlen)
        self.assertEqual(receiver.pop_dropped_frames(), 5)
        self.assertEqual(receiver.get_buffered_frames(), [])

    def test_camera_thread_bridge_coalesces_pending_callbacks(self):
        class FakeLoop:
            def __init__(self):
                self.callbacks = []

            def call_soon_threadsafe(self, callback):
                self.callbacks.append(callback)

        class FakeQueue:
            def __init__(self):
                self.items = []

            def put_nowait(self, item):
                self.items[:] = [item]

        capture = camera_server.CameraCapture.__new__(camera_server.CameraCapture)
        capture._frame_callback_lock = threading.Lock()
        capture._frame_callback_pending = False
        capture._pending_frame_item = None
        capture._loop = FakeLoop()
        capture.frame_queue = FakeQueue()
        for i in range(20):
            capture._enqueue_frame_from_thread({'frame': i})
        self.assertEqual(len(capture._loop.callbacks), 1)
        capture._loop.callbacks.pop()()
        self.assertEqual(capture.frame_queue.items, [{'frame': 19}])

    def test_camera_write_error_is_reported_on_stop(self):
        with tempfile.TemporaryDirectory(dir=str(Path.cwd())) as tmp:
            recorder = camera_server.FrameRecorder('left', 'ffmpeg', Path(tmp))
            self.assertTrue(recorder.start('test.avi'))
            recorder.raw_file.close()
            recorder.raw_file = _FailingFile()
            recorder.write_frame(b'frame')
            result = recorder.stop_recording_only()
            self.assertFalse(result['success'])
            self.assertIn('录制写入失败', result['error'])

    @unittest.skipUnless(HAS_CV2, 'cv2 unavailable')
    def test_camera_encode_validates_two_frame_one_fps_output_before_cleanup(self):
        with tempfile.TemporaryDirectory(dir=str(Path.cwd())) as tmp:
            root = Path(tmp)
            prepared = root / 'prepared.avi'
            writer = cv2.VideoWriter(str(prepared), cv2.VideoWriter_fourcc(*'MJPG'), 1.0, (16, 16))
            for value in (20, 80):
                writer.write(np.full((16, 16, 3), value, dtype=np.uint8))
            writer.release()

            recorder = camera_server.FrameRecorder('left', 'ffmpeg', root)
            self.assertTrue(recorder.start('result.avi'))
            recorder.raw_file.write(b'raw-mjpeg')
            recorder.frame_count = 2
            recorder.first_frame_real_time = 100.0
            recorder.last_frame_real_time = 101.0
            recorder.stop_recording_only()

            def fake_remux(command, **_kwargs):
                Path(command[-1]).write_bytes(prepared.read_bytes())
                return SimpleNamespace(returncode=0, stderr='')

            with patch.object(camera_server.subprocess, 'run', side_effect=fake_remux) as run:
                result = recorder.encode_stopped_recording()
            self.assertTrue(result['success'])
            self.assertAlmostEqual(result['timing']['duration'], 1.0, places=3)
            self.assertEqual(run.call_args.args[0][run.call_args.args[0].index('-framerate') + 1], '1.000000')
            self.assertTrue(recorder.output_path.exists())
            self.assertFalse(recorder.raw_path.exists())
            self.assertFalse(list(root.glob('*.tmp.avi')))

    @unittest.skipUnless(HAS_CV2, 'cv2 unavailable')
    def test_camera_encode_rejects_empty_or_short_output_and_preserves_old_files(self):
        with tempfile.TemporaryDirectory(dir=str(Path.cwd())) as tmp:
            root = Path(tmp)
            short = root / 'short.avi'
            writer = cv2.VideoWriter(str(short), cv2.VideoWriter_fourcc(*'MJPG'), 1.0, (16, 16))
            writer.write(np.zeros((16, 16, 3), dtype=np.uint8))
            writer.release()
            for label, make_output in (
                ('empty', lambda path: path.write_bytes(b'')),
                ('short', lambda path: path.write_bytes(short.read_bytes())),
            ):
                with self.subTest(label=label):
                    recorder = camera_server.FrameRecorder('left', 'ffmpeg', root / label)
                    recorder.output_dir.mkdir(parents=True, exist_ok=True)
                    self.assertTrue(recorder.start('result.avi'))
                    recorder.raw_file.write(b'raw-mjpeg')
                    recorder.frame_count = 2
                    recorder.first_frame_real_time = 100.0
                    recorder.last_frame_real_time = 101.0
                    old_output = recorder.output_path
                    old_output.write_bytes(b'old-avi')
                    recorder.stop_recording_only()

                    def fake_remux(command, **_kwargs):
                        make_output(Path(command[-1]))
                        return SimpleNamespace(returncode=0, stderr='')

                    with patch.object(camera_server.subprocess, 'run', side_effect=fake_remux):
                        result = recorder.encode_stopped_recording()
                    self.assertFalse(result['success'])
                    self.assertEqual(old_output.read_bytes(), b'old-avi')
                    self.assertTrue(recorder.raw_path.exists())
                    self.assertFalse(list((root / label).glob('*.tmp.avi')))

    def test_camera_start_refuses_existing_avi_without_overwriting(self):
        with tempfile.TemporaryDirectory(dir=str(Path.cwd())) as tmp:
            root = Path(tmp)
            recorder = camera_server.FrameRecorder('left', 'ffmpeg', root)
            output = root / 'result.avi'
            output.write_bytes(b'old-avi')
            self.assertFalse(recorder.start('result.avi'))
            self.assertEqual(output.read_bytes(), b'old-avi')
            self.assertFalse((root / 'result.mjpeg').exists())

            marker = root / 'marker-failure.mjpeg.recording'
            marker.write_text('existing marker', encoding='utf-8')
            self.assertFalse(recorder.start('marker-failure.avi'))
            self.assertFalse((root / 'marker-failure.mjpeg').exists())

            self.assertTrue(recorder.start('fresh.avi'))
            raw_before = recorder.raw_path.read_bytes()
            self.assertTrue(recorder.start('fresh.avi'))
            self.assertEqual(recorder.raw_path.read_bytes(), raw_before)
            recorder.stop_recording_only()

    def test_stop_operation_id_is_idempotent_and_old_generation_cannot_stop_new(self):
        async def scenario():
            from types import SimpleNamespace
            server = camera_server.CameraServer.__new__(camera_server.CameraServer)
            server._stop_operations = {}; server._stop_operation_results = {}
            server._stop_operation_lock = threading.Lock(); server._closing_sides = set()
            server.recorders = {'left': SimpleNamespace(recording_id='generation-a', requires_recording_id=True)}
            gate = asyncio.Event(); calls = []
            async def stop(side, output):
                calls.append(side); await gate.wait()
                return {'success': False, 'error': 'disk full'}
            server._do_stop_and_save = stop
            data = {'side': 'left', 'operation_id': 'op-1', 'recording_id': 'generation-a'}
            first = asyncio.create_task(server._cmd_stop_and_save(data))
            second = asyncio.create_task(server._cmd_stop_and_save(data))
            await asyncio.sleep(0); await asyncio.sleep(0)
            gate.set(); results = await asyncio.gather(first, second)
            self.assertEqual(calls, ['left']); self.assertEqual(results[0], results[1])
            server._stop_operation_results.clear()  # simulate bounded cache eviction
            server.recorders['left'] = SimpleNamespace(recording_id='generation-b', requires_recording_id=True)
            stale = await server._cmd_stop_and_save(data)
            self.assertFalse(stale['success']); self.assertEqual(calls, ['left'])
        asyncio.run(scenario())

    def test_ble_thread_wake_is_coalesced_and_consumer_is_single(self):
        async def scenario():
            loop = asyncio.get_running_loop()
            ble_server.state.main_loop = loop
            ble_server.state.queue_wake_pending = False
            fast = FakeClient(); slow = FakeClient(delay=3)
            ble_server.state.data_clients = {fast, slow}
            def produce():
                for index in range(20):
                    ble_server.add_to_queue(ble_server.PRIORITY_LOW, 'data', {'index': index})
            thread = threading.Thread(target=produce); thread.start(); thread.join()
            self.assertTrue(ble_server.state.queue_wake_pending)
            await asyncio.sleep(0.05)
            first = ble_server.state.queue_task
            ble_server._ensure_process_queue()
            self.assertIs(first, ble_server.state.queue_task)
            await asyncio.wait_for(first, 2)
            self.assertEqual(len(fast.messages), 20)
            self.assertNotIn(slow, ble_server.state.data_clients)
            self.assertTrue(ble_server.state.msg_queue.empty())
        asyncio.run(scenario())


def _drive_coroutine(coro):
    try:
        coro.send(None)
    except StopIteration as completed:
        return completed.value
    raise AssertionError('test coroutine unexpectedly suspended')


class _FailingFile:
    def write(self, _):
        raise OSError('disk full')

    def close(self):
        pass


if __name__ == '__main__':
    unittest.main()
