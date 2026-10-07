import json
import os
import shutil
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

import h5py

os.environ.setdefault('QT_QPA_PLATFORM', 'offscreen')
from PyQt5.QtWidgets import QApplication

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'tools'))
import hdf5_tool
import video_encoder_worker


_APP = QApplication.instance() or QApplication([])


@unittest.skipUnless(hdf5_tool.HAS_CV2, 'cv2 unavailable in target environment')
class VideoIntegrityTests(unittest.TestCase):
    def setUp(self):
        self.thread_errors = []
        hook = patch.object(threading, 'excepthook', side_effect=lambda args: self.thread_errors.append(args.exc_value))
        hook.start()
        self.addCleanup(hook.stop)

    def tearDown(self):
        self.assertFalse(self.thread_errors, f'Background pipe failure: {self.thread_errors}')

    @staticmethod
    def _copy_video(source, destination, *_args):
        shutil.copy2(source, destination)
        return os.path.getsize(destination)

    def _video(self, path, codec, frames=6):
        import cv2
        import numpy as np
        writer = cv2.VideoWriter(path, cv2.VideoWriter_fourcc(*codec), 10.0, (32, 24))
        self.assertTrue(writer.isOpened())
        for index in range(frames):
            writer.write(np.full((24, 32, 3), index * 20, dtype=np.uint8))
        writer.release()

    def _h5(self, path, video):
        with h5py.File(path, 'w') as h5:
            h5.attrs['video_left'] = os.path.basename(video)

    def test_shared_avi_is_one_job_and_source_is_retained_after_all_h5_updates(self):
        with tempfile.TemporaryDirectory(dir=os.getcwd()) as root:
            avi = os.path.join(root, 'shared.avi')
            mp4_source = os.path.join(root, 'prepared.mp4')
            self._video(avi, 'MJPG')
            self._video(mp4_source, 'mp4v')
            h5_a = os.path.join(root, 'a.h5')
            h5_b = os.path.join(root, 'b.h5')
            self._h5(h5_a, avi)
            self._h5(h5_b, avi)
            worker = hdf5_tool.VideoCompressWorker([h5_a, h5_b])
            with patch.object(hdf5_tool, 'find_h5_video_files', return_value={'left': avi}), \
                    patch.object(hdf5_tool, 'compress_video_to_mp4',
                    side_effect=lambda _ffmpeg, _src, dst, *_args, **_kwargs: self._copy_video(mp4_source, dst)):
                jobs = worker._collect_jobs()
                self.assertEqual(len(jobs), 1)
                self.assertEqual(len(jobs[0]['references']), 2)
                result = worker._run_one('mock-ffmpeg', jobs[0], 1, 1)
            self.assertTrue(result['success'])
            self.assertFalse(result['deleted_source'])
            self.assertTrue(os.path.exists(avi))
            for path in (h5_a, h5_b):
                with h5py.File(path, 'r') as h5:
                    self.assertEqual(h5.attrs['video_left'], 'shared.mp4')
                    self.assertEqual(h5.attrs['video_compression'], 'h264_mp4')

    def test_reference_failure_keeps_source_and_reports_partial(self):
        with tempfile.TemporaryDirectory(dir=os.getcwd()) as root:
            avi = os.path.join(root, 'shared.avi')
            mp4_source = os.path.join(root, 'prepared.mp4')
            self._video(avi, 'MJPG')
            self._video(mp4_source, 'mp4v')
            h5_a = os.path.join(root, 'a.h5')
            h5_b = os.path.join(root, 'b.h5')
            self._h5(h5_a, avi)
            self._h5(h5_b, avi)
            worker = hdf5_tool.VideoCompressWorker([h5_a, h5_b])
            calls = {'count': 0}
            original = worker._update_h5_video_attr

            def fail_second(path, side, output, deleted_source=False):
                calls['count'] += 1
                if calls['count'] == 2:
                    raise OSError('injected H5 attribute failure')
                return original(path, side, output, deleted_source)

            job = {'input': avi, 'output': os.path.join(root, 'shared.mp4'),
                   'references': [{'h5_path': h5_a, 'side': 'left'},
                                  {'h5_path': h5_b, 'side': 'left'}],
                   'h5_path': h5_a, 'side': 'left'}
            with patch.object(hdf5_tool, 'compress_video_to_mp4',
                              side_effect=lambda _ffmpeg, _src, dst, *_args, **_kwargs: self._copy_video(mp4_source, dst)), \
                    patch.object(worker, '_update_h5_video_attr', side_effect=fail_second):
                result = worker._run_one('mock-ffmpeg', job, 1, 1)
            self.assertFalse(result['success'])
            self.assertTrue(result['partial'])
            self.assertTrue(os.path.exists(avi))
            with h5py.File(h5_a, 'r') as h5:
                self.assertEqual(h5.attrs['video_left'], 'shared.mp4')
            with h5py.File(h5_b, 'r') as h5:
                self.assertEqual(h5.attrs['video_left'], os.path.basename(avi))

    def test_full_decode_rejects_truncated_output(self):
        with tempfile.TemporaryDirectory(dir=os.getcwd()) as root:
            source = os.path.join(root, 'source.avi')
            truncated = os.path.join(root, 'truncated.mp4')
            self._video(source, 'MJPG', frames=6)
            self._video(truncated, 'mp4v', frames=5)
            worker = hdf5_tool.VideoCompressWorker([])
            with self.assertRaisesRegex(RuntimeError, '帧数不一致'):
                worker._validate_video_output(source, truncated)

    def test_unselected_h5_reference_keeps_source_video(self):
        with tempfile.TemporaryDirectory(dir=os.getcwd()) as root:
            avi = os.path.join(root, 'shared.avi')
            mp4_source = os.path.join(root, 'prepared.mp4')
            self._video(avi, 'MJPG')
            self._video(mp4_source, 'mp4v')
            h5_selected = os.path.join(root, 'selected.h5')
            h5_unselected = os.path.join(root, 'unselected.h5')
            self._h5(h5_selected, avi)
            self._h5(h5_unselected, avi)
            worker = hdf5_tool.VideoCompressWorker([h5_selected])
            with patch.object(hdf5_tool, 'find_h5_video_files', return_value={'left': avi}), \
                    patch.object(
                        hdf5_tool, 'compress_video_to_mp4',
                        side_effect=lambda _ffmpeg, _src, dst, *_args, **_kwargs:
                            self._copy_video(mp4_source, dst)):
                result = worker._run_one('mock-ffmpeg', worker._collect_jobs()[0], 1, 1)
            self.assertTrue(result['success'])
            self.assertTrue(os.path.exists(avi))
            with h5py.File(h5_unselected, 'r') as h5:
                self.assertEqual(h5.attrs['video_left'], os.path.basename(avi))

    def test_validation_failure_leaves_existing_mp4_and_removes_unique_temp(self):
        class Pipe:
            def readline(self, size=-1):
                return ''

            def close(self):
                pass

        class Process:
            def __init__(self, cmd, **_kwargs):
                self.stdout = Pipe()
                self.stderr = Pipe()
                self.returncode = 0
                with open(cmd[-1], 'wb') as stream:
                    stream.write(b'bad output')

            def poll(self):
                return self.returncode

            def wait(self, timeout=None):
                return self.returncode

            def kill(self):
                self.returncode = -9

        with tempfile.TemporaryDirectory(dir=os.getcwd()) as root:
            source = os.path.join(root, 'source.avi')
            output = os.path.join(root, 'result.mp4')
            self._video(source, 'MJPG', frames=2)
            with open(output, 'wb') as stream:
                stream.write(b'old-valid-mp4')
            with patch.object(hdf5_tool, 'probe_video_duration', return_value=None), \
                    patch.object(hdf5_tool.subprocess, 'Popen', side_effect=Process), \
                    self.assertRaisesRegex(RuntimeError, 'validation failed'):
                hdf5_tool.compress_video_to_mp4(
                    'fake-ffmpeg', source, output, 1, 'ultrafast', 35,
                    validate_cb=lambda _candidate: (_ for _ in ()).throw(
                        RuntimeError('validation failed')),
                    timeout_seconds=5)
            with open(output, 'rb') as stream:
                self.assertEqual(stream.read(), b'old-valid-mp4')
            self.assertFalse([name for name in os.listdir(root) if name.endswith('.tmp.mp4')])

    def test_timeout_kills_process_and_cleans_temp_after_stderr_flood(self):
        class Pipe:
            def __init__(self):
                self.remaining = 1000

            def readline(self, size=-1):
                if self.remaining <= 0:
                    return ''
                self.remaining -= 1
                return 'diagnostic ' * 100

            def close(self):
                pass

        class Process:
            def __init__(self, cmd, **_kwargs):
                self.stdout = Pipe()
                self.stderr = Pipe()
                self.returncode = None
                self.killed = False

            def poll(self):
                return self.returncode

            def wait(self, timeout=None):
                self.returncode = -9 if self.killed else 0
                return self.returncode

            def kill(self):
                self.killed = True
                self.returncode = -9

        with tempfile.TemporaryDirectory(dir=os.getcwd()) as root:
            source = os.path.join(root, 'source.avi')
            output = os.path.join(root, 'result.mp4')
            self._video(source, 'MJPG', frames=2)
            with patch.object(hdf5_tool, 'probe_video_duration', return_value=None), \
                    patch.object(hdf5_tool.subprocess, 'Popen', side_effect=Process) as popen, \
                    self.assertRaisesRegex(TimeoutError, 'timeout'):
                hdf5_tool.compress_video_to_mp4(
                    'fake-ffmpeg', source, output, 1, 'ultrafast', 35,
                    timeout_seconds=0.05)
            self.assertTrue(popen.call_args)
            self.assertFalse([name for name in os.listdir(root) if name.endswith('.tmp.mp4')])


class VideoStatusConcurrencyTests(unittest.TestCase):
    def test_atomic_json_and_status_snapshots_remain_parseable(self):
        with tempfile.TemporaryDirectory(dir=os.getcwd()) as root:
            path = os.path.join(root, 'status.json')
            errors = []

            def write(index):
                try:
                    video_encoder_worker.atomic_write_json(path, {'writer': index, 'values': list(range(index))})
                except Exception as exc:
                    errors.append(exc)

            threads = [threading.Thread(target=write, args=(i,)) for i in range(12)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()
            self.assertFalse(errors)
            with open(path, 'r', encoding='utf-8') as stream:
                data = json.load(stream)
            self.assertIn('writer', data)
            self.assertFalse([name for name in os.listdir(root) if name.endswith('.tmp')])


if __name__ == '__main__':
    unittest.main()
