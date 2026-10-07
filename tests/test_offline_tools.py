import os
import sys
import tempfile
import unittest
from unittest.mock import patch

import h5py
import numpy as np

os.environ.setdefault('QT_QPA_PLATFORM', 'offscreen')
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'tools'))

from PyQt5.QtCore import QThread
from PyQt5.QtGui import QCloseEvent
from PyQt5.QtWidgets import QApplication

import hdf5_tool


class _TrackingDataset:
    def __init__(self, dataset):
        self._dataset = dataset
        self.shape = dataset.shape
        self.dtype = dataset.dtype
        self.keys = []

    def __getitem__(self, key):
        self.keys.append(key)
        return self._dataset[key]


class _PreviewProbe:
    preview_rows = 100

    def __init__(self):
        self.waveform = type('Waveform', (), {'plot_data': lambda *_args: None})()
        self.received = None

    def show_emg_data(self, data, dtype, path):
        self.received = (data, dtype, path, self._preview_total_rows)

    def show_imu_data(self, data, dtype, path):
        self.received = (data, dtype, path, self._preview_total_rows)

    def show_prompt_data(self, data, path):
        self.received = (data, path, self._preview_total_rows)

    def show_video_timing_data(self, data, dtype, path):
        self.received = (data, dtype, path, self._preview_total_rows)

    def update_table_view(self, data, is_emg):
        self.received = (data, is_emg, self._preview_total_rows)

    def update_text_view(self, data, is_emg):
        pass


class _ShortThread(QThread):
    def run(self):
        self.msleep(50)


class OfflineToolRegressionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication([])

    def test_viewer_preview_reads_only_bounded_head(self):
        dtype = np.dtype([('channels', '<i4', (16,)), ('time', '<f8')])
        with tempfile.TemporaryDirectory(dir=os.getcwd()) as tmp:
            path = os.path.join(tmp, 'large_preview.h5')
            with h5py.File(path, 'w') as h5:
                ds = h5.create_dataset('emg1_2khz_adc', shape=(10000,), dtype=dtype)
                ds['time'] = np.arange(10000, dtype=np.float64) / 2000.0
                tracking = _TrackingDataset(ds)
                probe = _PreviewProbe()
                hdf5_tool.ViewerTab.show_data_preview(probe, tracking, 'emg1_2khz_adc')

        self.assertEqual(len(tracking.keys), 1)
        self.assertEqual(tracking.keys[0], slice(None, 2000, None))
        self.assertEqual(len(probe.received[0]), 2000)
        self.assertEqual(probe.received[-1], 10000)

    def test_main_window_waits_for_worker_before_close(self):
        window = hdf5_tool.HDF5Tool()
        worker = _ShortThread()
        window.sync_tab.worker = worker
        worker.start()
        first_event = QCloseEvent()

        with patch.object(hdf5_tool.QMessageBox, 'information'):
            window.closeEvent(first_event)

        self.assertFalse(first_event.isAccepted())
        worker.wait()
        second_event = QCloseEvent()
        window.closeEvent(second_event)

        self.assertTrue(second_event.isAccepted())
        self.assertFalse(worker.isRunning())
        window.deleteLater()
        self.app.processEvents()

    def test_viewer_displays_numeric_string_and_structured_scalars(self):
        scalar_dtype = np.dtype([('value', '<i4'), ('time', '<f8')])
        cases = [
            ('scalar_num', np.float64(3.5), None, '3.5000'),
            ('scalar_text', 'hello', h5py.string_dtype(encoding='utf-8'), 'hello'),
            ('scalar_struct', np.array((7, 1.25), dtype=scalar_dtype), scalar_dtype, '7'),
        ]
        with tempfile.TemporaryDirectory(dir=os.getcwd()) as tmp:
            path = os.path.join(tmp, 'scalar_preview.h5')
            with h5py.File(path, 'w') as h5:
                for name, value, dtype, expected in cases:
                    kwargs = {'dtype': dtype} if dtype is not None else {}
                    h5.create_dataset(name, data=value, **kwargs)

            for name, _value, _dtype, expected in cases:
                viewer = hdf5_tool.ViewerTab()
                viewer.waveform.plot_data = lambda *_args: None
                with h5py.File(path, 'r') as h5:
                    viewer.show_data_preview(h5[name], name)
                self.assertIn(expected, viewer.text_view.toPlainText())
                viewer.deleteLater()
            self.app.processEvents()

    def test_numeric_preview_stats_state_their_limited_scope(self):
        with tempfile.TemporaryDirectory(dir=os.getcwd()) as tmp:
            path = os.path.join(tmp, 'stats_preview.h5')
            with h5py.File(path, 'w') as h5:
                h5.create_dataset('signal', data=np.arange(10000, dtype=np.float64))
                viewer = hdf5_tool.ViewerTab()
                viewer.waveform.plot_data = lambda *_args: None
                viewer.show_data_preview(h5['signal'], 'signal')
                text = viewer.text_view.toPlainText()
                self.assertIn('Shape: (10000,)', text)
                self.assertIn('统计范围：仅基于前 2000 行预览', text)
                viewer.deleteLater()
            self.app.processEvents()


if __name__ == '__main__':
    unittest.main()
