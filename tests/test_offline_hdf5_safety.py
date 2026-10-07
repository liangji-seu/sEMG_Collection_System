import os
import tempfile
import unittest
from unittest.mock import patch

import h5py

import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'tools'))
import hdf5_tool


class Hdf5OpenSafetyTests(unittest.TestCase):
    def test_stale_write_error_does_not_rewrite_source(self):
        with tempfile.TemporaryDirectory(dir=os.getcwd()) as tmp:
            path = os.path.join(tmp, 'active.h5')
            original = b'unchanged source bytes\x00\x01'
            with open(path, 'wb') as f:
                f.write(original)

            with patch.object(
                hdf5_tool.h5py, 'File',
                side_effect=OSError('file is already open for write')
            ), patch.object(hdf5_tool, 'repair_h5_stale_write_flag') as repair:
                ok, message = hdf5_tool.ensure_h5_openable(path)

            self.assertFalse(ok)
            self.assertIn('可能仍在采集', message)
            self.assertIn('关闭占用程序', message)
            repair.assert_not_called()
            with open(path, 'rb') as f:
                self.assertEqual(f.read(), original)

    def test_healthy_h5_remains_openable(self):
        with tempfile.TemporaryDirectory(dir=os.getcwd()) as tmp:
            path = os.path.join(tmp, 'healthy.h5')
            with h5py.File(path, 'w') as h5:
                h5.create_dataset('sample', data=[1, 2, 3])

            self.assertEqual(hdf5_tool.ensure_h5_openable(path), (True, 'ok'))


if __name__ == '__main__':
    unittest.main()
