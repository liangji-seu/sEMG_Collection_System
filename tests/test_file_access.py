import os
from pathlib import Path
import sys
import tempfile
import subprocess
import unittest
from unittest.mock import patch

import h5py

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
from file_access import FileBusyError, h5_transaction, exclusive_file, transactional_h5


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

if __name__ == '__main__':
    unittest.main()
