from pathlib import Path
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import h5py

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
import hdf5_tool
import calibrate_tool


class FakeH5:
    def __init__(self):
        self.close_calls = 0

    def close(self):
        self.close_calls += 1


class FakeTimer:
    def stop(self):
        pass


class FakeLabel:
    def __init__(self, fail_first_set=False):
        self.set_calls = 0
        self.fail_first_set = fail_first_set

    def setText(self, _value):
        self.set_calls += 1
        if self.fail_first_set and self.set_calls == 1:
            raise ValueError('injected label failure')

    def setStyleSheet(self, _value):
        pass


class FakeSlider:
    def setMaximum(self, _value):
        pass


class FakeEvent:
    def __init__(self):
        self.accepted = False

    def accept(self):
        self.accepted = True


class H5HandleCleanupTests(unittest.TestCase):
    def test_sync_calibration_close_file_closes_h5_after_video_cleanup_error(self):
        fake_h5 = FakeH5()
        widget = SimpleNamespace(
            h5_file=fake_h5,
            _stop_playback=lambda: None,
            _close_videos=lambda: (_ for _ in ()).throw(RuntimeError('video cleanup failed')),
        )

        with self.assertRaisesRegex(RuntimeError, 'video cleanup failed'):
            hdf5_tool.SyncCalibrationTab.close_file(widget)

        self.assertEqual(fake_h5.close_calls, 1)
        self.assertIsNone(widget.h5_file)

    def test_calibrate_tab_close_file_closes_h5_after_stop_error(self):
        fake_h5 = FakeH5()
        widget = SimpleNamespace(
            is_playing=True,
            is_full_playing=False,
            h5_file=fake_h5,
            _stop_playback=lambda: (_ for _ in ()).throw(ValueError('stop failed')),
            _stop_full_playback=lambda: None,
            _close_videos=lambda: None,
        )
        tab = SimpleNamespace(calibrate_widget=widget)

        with self.assertRaisesRegex(ValueError, 'stop failed'):
            hdf5_tool.CalibrateTab.close_file(tab)

        self.assertEqual(fake_h5.close_calls, 1)
        self.assertIsNone(widget.h5_file)

    def test_release_loaded_file_closes_h5_after_video_cleanup_error(self):
        fake_h5 = FakeH5()
        widget = SimpleNamespace(
            is_playing=False,
            is_full_playing=False,
            playback_timer=FakeTimer(),
            full_playback_timer=FakeTimer(),
            update_timer=FakeTimer(),
            pending_update=False,
            h5_file=fake_h5,
            _close_videos=lambda: (_ for _ in ()).throw(RuntimeError('video cleanup failed')),
        )

        with self.assertRaisesRegex(RuntimeError, 'video cleanup failed'):
            calibrate_tool.CalibrateWidget._release_loaded_file(widget)

        self.assertEqual(fake_h5.close_calls, 1)
        self.assertIsNone(widget.h5_file)

    def test_calibrate_close_event_closes_h5_after_stop_error(self):
        fake_h5 = FakeH5()
        widget = SimpleNamespace(
            is_playing=True,
            is_full_playing=False,
            h5_file=fake_h5,
            _stop_playback=lambda: (_ for _ in ()).throw(ValueError('stop failed')),
            _stop_full_playback=lambda: None,
            _close_videos=lambda: None,
        )
        event = FakeEvent()

        with self.assertRaisesRegex(ValueError, 'stop failed'):
            calibrate_tool.CalibrateWidget.closeEvent(widget, event)

        self.assertEqual(fake_h5.close_calls, 1)
        self.assertIsNone(widget.h5_file)
        self.assertFalse(event.accepted)

    def test_sync_calibration_load_failure_releases_opened_h5(self):
        widget = SimpleNamespace(
            h5_file=None,
            lbl_file=FakeLabel(fail_first_set=True),
            _stop_playback=lambda: None,
            _close_videos=lambda: None,
        )
        widget.close_file = lambda: hdf5_tool.SyncCalibrationTab.close_file(widget)
        with tempfile.TemporaryDirectory(dir=ROOT) as tmp:
            path = Path(tmp) / 'load-failure.h5'
            with h5py.File(path, 'w'):
                pass

            with self.assertRaisesRegex(ValueError, 'injected label failure'):
                hdf5_tool.SyncCalibrationTab.load_file(widget, str(path))

        self.assertIsNone(widget.h5_file)

    def test_calibrate_load_failure_releases_opened_h5(self):
        widget = SimpleNamespace(
            is_playing=False,
            is_full_playing=False,
            playback_timer=FakeTimer(),
            full_playback_timer=FakeTimer(),
            update_timer=FakeTimer(),
            pending_update=False,
            h5_file=None,
            h5_path=None,
            lbl_file=FakeLabel(fail_first_set=True),
            slider=FakeSlider(),
            lbl_total=FakeLabel(),
            calib_offset={},
            _close_videos=lambda: None,
            _update_playback_buttons=lambda **_kwargs: None,
        )
        widget._release_loaded_file = lambda: calibrate_tool.CalibrateWidget._release_loaded_file(widget)
        with tempfile.TemporaryDirectory(dir=ROOT) as tmp:
            path = Path(tmp) / 'load-failure.h5'
            with h5py.File(path, 'w'):
                pass

            with patch.object(calibrate_tool.QMessageBox, 'critical'):
                calibrate_tool.CalibrateWidget.load_h5_file(widget, str(path))

        self.assertIsNone(widget.h5_file)
        self.assertEqual(widget.lbl_file.set_calls, 2)


if __name__ == '__main__':
    unittest.main()
