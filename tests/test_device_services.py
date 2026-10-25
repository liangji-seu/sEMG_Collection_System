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

    def _make_stopped_camera_recorder(self, root, frame_count=2, first=100.0, last=101.0):
        recorder = camera_server.FrameRecorder('left', 'ffmpeg', root)
        self.assertTrue(recorder.start('result.avi'))
        recorder.raw_file.write(b'raw-mjpeg')
        recorder.frame_count = frame_count
        recorder.first_frame_real_time = first
        recorder.last_frame_real_time = last
        recorder.stop_recording_only()
        meta_path = recorder.raw_path.with_suffix(
            recorder.raw_path.suffix + camera_server.VIDEO_ENCODER_META_SUFFIX)
        self.assertTrue(meta_path.exists())
        return recorder, meta_path

    def test_camera_encode_succeeds_on_nonempty_avi_without_index_validation(self):
        with tempfile.TemporaryDirectory(dir=str(Path.cwd())) as tmp:
            root = Path(tmp)
            recorder, meta_path = self._make_stopped_camera_recorder(
                root, frame_count=2, first=100.0, last=101.0)

            def fake_remux(command, **_kwargs):
                # A valid nonempty AVI may have an index count different from the recorder counter.
                Path(command[-1]).write_bytes(b'RIFF\x04\x00\x00\x00AVI ')
                return SimpleNamespace(returncode=0, stderr='')

            with patch.object(camera_server.subprocess, 'run', side_effect=fake_remux) as run:
                result = recorder.encode_stopped_recording()

            self.assertTrue(result['success'])
            self.assertEqual(recorder.output_path.read_bytes(), b'RIFF\x04\x00\x00\x00AVI ')
            self.assertEqual(result['frame_count'], 2)
            self.assertEqual(result['timing']['frame_count'], 2)
            self.assertEqual(result['timing']['duration'], 1.0)
            args = run.call_args.args[0]
            self.assertEqual(args[args.index('-framerate') + 1], '1.000000')
            self.assertFalse(recorder.raw_path.exists())
            self.assertFalse(meta_path.exists())
            self.assertFalse(list(root.glob('*.tmp.avi')))

    @unittest.skipUnless(HAS_CV2, 'cv2 unavailable for AVI fixture generation')
    def test_camera_encode_accepts_real_avi_with_more_or_fewer_indexed_frames_without_cv2(self):
        with tempfile.TemporaryDirectory(dir=str(Path.cwd())) as tmp:
            root = Path(tmp)
            prepared = root / 'prepared.avi'
            writer = cv2.VideoWriter(
                str(prepared), cv2.VideoWriter_fourcc(*'MJPG'), 10.0, (16, 16))
            self.assertTrue(writer.isOpened())
            for value in (20, 100, 220):
                writer.write(np.full((16, 16, 3), value, dtype=np.uint8))
            writer.release()
            self.assertGreater(prepared.stat().st_size, 0)

            avi_bytes = prepared.read_bytes()
            for label, recorded_count in (('indexed-more', 2), ('indexed-fewer', 4)):
                with self.subTest(label=label):
                    output_root = root / label
                    output_root.mkdir()
                    recorder, _ = self._make_stopped_camera_recorder(
                        output_root, frame_count=recorded_count, first=100.0, last=100.2)

                    def fake_remux(command, **_kwargs):
                        Path(command[-1]).write_bytes(avi_bytes)
                        return SimpleNamespace(returncode=0, stderr='')

                    with patch.object(camera_server.subprocess, 'run', side_effect=fake_remux), \
                            patch.dict(sys.modules, {'cv2': None}):
                        result = recorder.encode_stopped_recording()

                    self.assertTrue(result['success'])
                    self.assertEqual(recorder.output_path.read_bytes(), avi_bytes)
                    self.assertGreater(recorder.output_path.stat().st_size, 0)
                    self.assertFalse(recorder.raw_path.exists())
                    self.assertFalse(list(output_root.glob('*.tmp.avi')))

    def test_camera_encode_uses_n_minus_one_fps_and_clamps_low_fps(self):
        with tempfile.TemporaryDirectory(dir=str(Path.cwd())) as tmp:
            root = Path(tmp)
            recorder, _ = self._make_stopped_camera_recorder(
                root, frame_count=4, first=100.0, last=102.0)

            def fake_remux(command, **_kwargs):
                Path(command[-1]).write_bytes(b'RIFFAVI-content')
                return SimpleNamespace(returncode=0, stderr='')

            with patch.object(camera_server.subprocess, 'run', side_effect=fake_remux) as run:
                result = recorder.encode_stopped_recording()
            self.assertTrue(result['success'])
            args = run.call_args.args[0]
            self.assertEqual(args[args.index('-framerate') + 1], '1.500000')

            low_root = root / 'low-fps'
            low_recorder, _ = self._make_stopped_camera_recorder(
                low_root, frame_count=2, first=100.0, last=104.0)
            with patch.object(camera_server.subprocess, 'run', side_effect=fake_remux) as run:
                low_result = low_recorder.encode_stopped_recording()
            self.assertTrue(low_result['success'])
            low_args = run.call_args.args[0]
            self.assertEqual(low_args[low_args.index('-framerate') + 1], '1.000000')

            invalid_interval_root = root / 'invalid-interval'
            invalid_interval_recorder, _ = self._make_stopped_camera_recorder(
                invalid_interval_root, frame_count=2, first=104.0, last=100.0)
            with patch.object(camera_server.subprocess, 'run', side_effect=fake_remux) as run:
                invalid_interval_result = invalid_interval_recorder.encode_stopped_recording()
            self.assertTrue(invalid_interval_result['success'])
            invalid_args = run.call_args.args[0]
            self.assertEqual(invalid_args[invalid_args.index('-framerate') + 1], '60.000000')

    def test_camera_encode_failure_preserves_old_avi_raw_and_metadata(self):
        for label in ('nonzero', 'missing', 'empty'):
            with self.subTest(label=label), tempfile.TemporaryDirectory(dir=str(Path.cwd())) as tmp:
                root = Path(tmp) / label
                root.mkdir()
                recorder, meta_path = self._make_stopped_camera_recorder(root)
                old_output = recorder.output_path
                old_output.write_bytes(b'old-avi')

                def fake_remux(command, **_kwargs):
                    if label == 'nonzero':
                        Path(command[-1]).write_bytes(b'partial-avi')
                        return SimpleNamespace(returncode=1, stderr='ffmpeg error')
                    if label == 'empty':
                        Path(command[-1]).write_bytes(b'')
                    return SimpleNamespace(returncode=0, stderr='')

                with patch.object(camera_server.subprocess, 'run', side_effect=fake_remux):
                    result = recorder.encode_stopped_recording()

                self.assertFalse(result['success'])
                self.assertEqual(old_output.read_bytes(), b'old-avi')
                self.assertTrue(recorder.raw_path.exists())
                self.assertTrue(meta_path.exists())
                self.assertFalse(list(root.glob('*.tmp.avi')))

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
