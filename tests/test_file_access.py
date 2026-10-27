import os
from pathlib import Path
import shutil
import sys
import tempfile
import subprocess
import unittest
from unittest.mock import patch

import h5py

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
from file_access import (
    FileBusyError,
    _io_path,
    _key,
    exclusive_file,
    h5_transaction,
    logical_h5_path,
    transactional_h5,
)


class FileTransactionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1])
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'original.h5'
        with h5py.File(self.path, 'w') as f:
            f['old'] = [1, 2, 3]

    def test_commit_and_nested_reuse(self):
        with h5_transaction(self.path) as work:
            with h5_transaction(self.path) as again:
                self.assertEqual(work, again)
            with h5_transaction(work) as again:
                self.assertEqual(work, again)
            with h5py.File(work, 'a') as f:
                f['new'] = [4]
            with h5py.File(self.path, 'r') as f:
                self.assertNotIn('new', f)
        with h5py.File(self.path, 'r') as f:
            self.assertEqual(f['new'][0], 4)

    def test_failed_write_leaves_identical_original(self):
        before = self.path.read_bytes()
        with self.assertRaisesRegex(RuntimeError, 'injected'):
            with h5_transaction(self.path) as work:
                with h5py.File(work, 'a') as f:
                    del f['old']
                    f['new'] = [4]
                raise RuntimeError('injected IMU failure')
        self.assertEqual(before, self.path.read_bytes())
        self.assertFalse(list(self.path.parent.glob('.*.edit-*.h5')))

    def test_commit_error_leaves_identical_original(self):
        before = self.path.read_bytes()
        with patch('file_access.os.replace', side_effect=PermissionError('reader open')):
            with self.assertRaises(PermissionError):
                with h5_transaction(self.path) as work:
                    with h5py.File(work, 'a') as f:
                        f['new'] = [4]
        self.assertEqual(before, self.path.read_bytes())

    def test_exclusive_operation_fails_immediately(self):
        with exclusive_file(self.path):
            with self.assertRaises(FileBusyError):
                with exclusive_file(self.path):
                    self.fail('second writer entered')

    def test_source_change_is_not_overwritten(self):
        with self.assertRaises(FileBusyError):
            with h5_transaction(self.path):
                with h5py.File(self.path, 'a') as f:
                    f.attrs['external'] = True
        with h5py.File(self.path, 'r') as f:
            self.assertTrue(f.attrs['external'])

    def test_second_process_cannot_enter_operation(self):
        code = '''
import sys
sys.path.insert(0, sys.argv[1])
from file_access import FileBusyError, exclusive_file
try:
    with exclusive_file(sys.argv[2]):
        sys.exit(99)
except FileBusyError:
    sys.exit(0)
'''
        with exclusive_file(self.path):
            result = subprocess.run([sys.executable, '-c', code,
                                     str(Path(__file__).resolve().parents[1] / 'tools'),
                                     str(self.path)], capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr.decode(errors='replace'))

    def test_non_success_return_cannot_commit_partial_output(self):
        @transactional_h5
        def failed_sync(path, result):
            with h5py.File(path, 'a') as f:
                del f['old']
            return result
        before = self.path.read_bytes()
        for result in (False, {'success': False}, {'status': 'validation_failed'},
                       {'status': 'sync_failed'}, {'status': 'error'}):
            with self.subTest(result=result), self.assertRaises(RuntimeError):
                failed_sync(self.path, result)
            self.assertEqual(self.path.read_bytes(), before)


    def test_caught_nested_failure_poison_rolls_back_outer_transaction(self):
        with tempfile.TemporaryDirectory(dir=os.getcwd()) as root:
            path = os.path.join(root, 'nested.h5')
            with h5py.File(path, 'w') as f:
                f.attrs['original'] = True
            before = Path(path).read_bytes()
            with self.assertRaisesRegex(RuntimeError, '嵌套'):
                with h5_transaction(path) as staged:
                    try:
                        with h5_transaction(staged):
                            with h5py.File(staged, 'a') as f:
                                f.attrs['bad'] = True
                            raise ValueError('injected inner failure')
                    except ValueError:
                        pass
            self.assertEqual(Path(path).read_bytes(), before)

    @unittest.skipUnless(os.name == 'nt', 'Windows extended paths are Windows-only')
    def test_long_windows_path_commit_rollback_and_alias_reuse(self):
        root = Path(self.tmp.name) / 'long-path-root'
        relative = root / ('segment_' * 5)
        ordinary_parent = str(relative)
        for index in range(18):
            ordinary_parent = os.path.join(ordinary_parent, f'level_{index:02d}_xxxxxxxx')
        ordinary = os.path.join(ordinary_parent, 'original.h5')
        self.assertGreater(len(ordinary), 260)
        self.addCleanup(lambda: shutil.rmtree(_io_path(root), ignore_errors=True))

        os.makedirs(_io_path(ordinary_parent))
        with h5py.File(_io_path(ordinary), 'w') as file:
            file['old'] = [1]
        extended = _io_path(ordinary)

        with h5_transaction(ordinary) as staged:
            self.assertTrue(staged.startswith('\\\\?\\'))
            with h5_transaction(extended) as again:
                self.assertEqual(staged, again)
            with h5_transaction(staged) as third:
                self.assertEqual(staged, third)
                self.assertEqual(logical_h5_path(third), _key(ordinary))
                self.assertNotIn('\\\\?\\', logical_h5_path(third))
            with h5py.File(staged, 'a') as file:
                file['new'] = [2]
        with h5py.File(extended, 'r') as file:
            self.assertEqual(file['new'][0], 2)

        with open(_io_path(ordinary), 'rb') as handle:
            before = handle.read()
        with self.assertRaisesRegex(RuntimeError, 'long rollback'):
            with h5_transaction(extended) as staged:
                with h5py.File(staged, 'a') as file:
                    file['bad'] = [3]
                raise RuntimeError('long rollback')
        with open(_io_path(ordinary), 'rb') as handle:
            self.assertEqual(handle.read(), before)

if __name__ == '__main__':
    unittest.main()
