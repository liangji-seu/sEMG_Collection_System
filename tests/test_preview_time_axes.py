import os
import unittest

import h5py
import numpy as np

os.environ.setdefault('QT_QPA_PLATFORM', 'offscreen')
from PyQt5.QtWidgets import QApplication

from tools.video_timeline import VideoTimeline
from tools.calibrate_tool import CalibrateWidget


class _FieldProbe:
    def __init__(self, field, dataset, calls):
        self.field = field
        self.dataset = dataset
        self.calls = calls

    def __getitem__(self, key):
        self.calls.append((self.field, key))
        return self.dataset.fields(self.field)[key]


class _DatasetProbe:
    def __init__(self, dataset):
        self.dataset = dataset
        self.shape = dataset.shape
        self.dtype = dataset.dtype
        self.calls = []

    def fields(self, field):
        self.calls.append(('fields', field))
        return _FieldProbe(field, self.dataset, self.calls)


class PreviewTimeAxisTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication([])

    def test_relative_time_axis_is_not_shifted_by_unix_session_origin(self):
        from types import SimpleNamespace
        widget = CalibrateWidget()
        widget.session_start_unix = 1_700_000_000.0
        widget.emg1_length = 3; widget.emg1_sample_rate = 250
        widget.emg1_start_time = 0.0; widget.emg1_has_time = True
        widget.emg1_time_axis = np.array([0.0, 0.004, 0.008])
        widget.emg1_dataset = SimpleNamespace()
        widget._read_emg_index_window = lambda _dev, lo, hi: (np.zeros((hi-lo,16)), widget.emg1_time_axis[lo:hi])
        chunk, times = widget._read_emg_time_window(1, 0.003, 0.005)
        self.assertEqual(len(chunk), 1)
        np.testing.assert_allclose(times, [0.004])
        widget.deleteLater()

    def test_failed_load_closes_handle_and_clears_partial_state(self):
        import tempfile
        from unittest.mock import patch
        dtype = np.dtype([('channels', np.float32, (16,)), ('time', np.float64)])
        with tempfile.TemporaryDirectory(dir=os.path.dirname(__file__)) as folder:
            path = os.path.join(folder, 'invalid.h5')
            with h5py.File(path, 'w') as f:
                rows = np.zeros(3, dtype=dtype)
                rows['time'] = [100.0, 100.01, 100.005]
                f.create_dataset('emg1_250hz', data=rows)
            widget = CalibrateWidget()
            try:
                with patch('tools.calibrate_tool.QMessageBox.critical') as message:
                    widget.load_h5_file(path)
                message.assert_called_once()
                self.assertIsNone(widget.h5_file)
                self.assertIsNone(widget.emg1_dataset)
                self.assertEqual(widget.emg1_length, 0)
                self.assertFalse(widget.update_timer.isActive())
                self.assertFalse(widget.video_enabled)
                with h5py.File(path, 'r+') as f:
                    f.attrs['released'] = True
            finally:
                widget._release_loaded_file()
                widget.deleteLater()

    def test_video_timeline_endpoints(self):
        one = VideoTimeline.from_timing(1, 600, 100.0, 100.0)
        self.assertEqual(one.frame_to_time(0), 100.0)
        self.assertEqual(one.time_to_frame(100.0), 0)

        two = VideoTimeline.from_timing(2, 600, 100.0, 101.0)
        self.assertEqual(two.frame_to_time(0), 100.0)
        self.assertEqual(two.frame_to_time(1), 101.0)
        self.assertEqual(two.time_to_frame(100.9), 1)
        self.assertAlmostEqual(two.effective_fps, 1.0)

        irregular = VideoTimeline(3, 600, 0.0, frame_times=(10.0, 10.2, 11.0))
        self.assertEqual(irregular.frame_to_time(2), 11.0)
        self.assertEqual(irregular.time_to_frame(10.8), 2)
        single = VideoTimeline(1, 30, 10.0, 99.0)
        self.assertEqual(single.duration, 0.0)

    def test_calibrate_reads_lazy_mixed_rate_windows(self):
        dtype = np.dtype([('channels', np.float32, (16,)), ('time', np.float64)])
        td = os.path.join(os.path.dirname(__file__), '.preview_time_axes_tmp')
        os.makedirs(td, exist_ok=True)
        path = os.path.join(td, 'preview.h5')
        try:
            with h5py.File(path, 'w') as f:
                a = np.zeros(20, dtype=dtype)
                a['channels'][:, 0] = np.arange(20)
                a['time'] = 1000.0 + np.arange(20) / 250.0
                b = np.zeros(40, dtype=dtype)
                b['channels'][:, 0] = np.arange(40) + 100
                # Device 2 starts later and has a deliberate time gap.
                b['time'] = 999.8 + np.arange(40) / 2000.0
                b['time'][20:] += 0.5
                f.create_dataset('emg1_250hz', data=a)
                f.create_dataset('emg2_2khz_adc', data=b)
                f.attrs['sync_status'] = 'partial'
                f.attrs['start_time'] = 1000.0

            widget = CalibrateWidget()
            widget.h5_file = h5py.File(path, 'r')
            widget.load_emg_data()
            self.assertIsNone(widget.emg1_data)
            self.assertEqual(widget.emg1_length, 20)
            self.assertEqual(widget.emg2_sample_rate, 2000)
            widget.emg2_dataset = _DatasetProbe(widget.emg2_dataset)

            chunk, times = widget._read_emg_time_window(2, 0.3, 0.305)
            self.assertEqual(len(chunk), 0)
            self.assertEqual(len(times), 0)

            chunk, times = widget._read_emg_time_window(2, 0.31, 0.312)
            self.assertGreater(len(chunk), 0)
            self.assertTrue(np.all(np.diff(times) >= 0))
            self.assertEqual(chunk.shape[1], 16)
            # Device 2 starts before device 1 and extends beyond its shorter
            # dataset; the shared display bounds must include both.
            _, rate, origin, end = widget._emg_session_bounds()
            self.assertLess(origin, 0.0)
            self.assertGreater(end, 0.31)
            self.assertGreater(widget.get_max_data_length(), widget.emg1_length)
            self.assertTrue(any(item[0] == 'fields' and item[1] == 'channels'
                                for item in widget.emg2_dataset.calls))
            self.assertTrue(all(not (isinstance(item[1], slice) and
                                     item[1] == slice(None))
                                for item in widget.emg2_dataset.calls
                                if item[0] == 'channels'))
            widget.h5_file.close()
            widget.deleteLater()
        finally:
            try:
                os.remove(path)
                os.rmdir(td)
            except OSError:
                pass


if __name__ == '__main__':
    unittest.main()
