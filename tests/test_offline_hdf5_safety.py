import os
import queue
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

import h5py

import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'tools'))
import hdf5_tool
import h5_recovery


class Hdf5OpenSafetyTests(unittest.TestCase):
    def _make_stale_h5(self, path, flag=1):
        with h5py.File(path, 'w', libver='latest') as h5:
            h5.create_dataset('sample', data=[1, 2, 3, 5, 8])
            h5.attrs['preserve'] = 'metadata'
        with open(path, 'r+b') as source:
            header = bytearray(source.read(48))
            self.assertEqual(header[8], 3)
            header[11] = flag
            header[44:48] = hdf5_tool._jenkins_lookup3_hashlittle(
                header[:44]).to_bytes(4, 'little')
            source.seek(0)
            source.write(header)
            source.flush()
            os.fsync(source.fileno())

    def _read_bytes(self, path):
        with open(path, 'rb') as source:
            return source.read()

    def test_healthy_h5_is_read_only(self):
        with tempfile.TemporaryDirectory(dir=os.getcwd()) as tmp:
            path = os.path.join(tmp, 'healthy.h5')
            with h5py.File(path, 'w') as h5:
                h5.create_dataset('sample', data=[1, 2, 3])
            original = self._read_bytes(path)

            self.assertEqual(hdf5_tool.ensure_h5_openable(Path(path)), (True, 'ok'))
            self.assertEqual(self._read_bytes(path), original)
            self.assertFalse(os.path.exists(path + '.bak_before_h5clear_flag'))

    def test_stale_flag_recovers_and_keeps_exact_backup_and_data(self):
        with tempfile.TemporaryDirectory(dir=os.getcwd()) as tmp:
            path = os.path.join(tmp, 'stale.h5')
            self._make_stale_h5(path)
            stale_bytes = self._read_bytes(path)

            ok, message = hdf5_tool.ensure_h5_openable(path)

            self.assertTrue(ok, message)
            self.assertIn('.bak_before_h5clear_flag', message)
            backup = message.split('完整原文件备份: ', 1)[1]
            self.assertEqual(self._read_bytes(backup), stale_bytes)
            with open(path, 'rb') as source:
                header = source.read(48)
            self.assertEqual(header[11], 0)
            self.assertEqual(int.from_bytes(header[44:48], 'little'),
                             hdf5_tool._jenkins_lookup3_hashlittle(header[:44]))
            with h5py.File(path, 'r') as h5:
                self.assertEqual(h5['sample'][:].tolist(), [1, 2, 3, 5, 8])
                self.assertEqual(h5.attrs['preserve'], 'metadata')

    def test_stale_flag_with_unreferenced_tail_preserves_all_tail_bytes(self):
        with tempfile.TemporaryDirectory(dir=os.getcwd()) as tmp:
            path = os.path.join(tmp, 'stale_with_tail.h5')
            self._make_stale_h5(path)
            tail = b'preserve this unreferenced tail exactly\x00\x01\xfe'
            with open(path, 'ab') as source:
                source.write(tail)
                source.flush()
                os.fsync(source.fileno())
            original = self._read_bytes(path)

            ok, message = hdf5_tool.ensure_h5_openable(path)

            self.assertTrue(ok, message)
            backup = message.split('完整原文件备份: ', 1)[1]
            repaired = self._read_bytes(path)
            self.assertEqual(len(repaired), len(original))
            self.assertEqual(self._read_bytes(backup), original)
            self.assertEqual(repaired[:11], original[:11])
            self.assertEqual(repaired[11], 0)
            self.assertEqual(repaired[12:44], original[12:44])
            self.assertEqual(repaired[48:], original[48:])
            self.assertEqual(int.from_bytes(repaired[44:48], 'little'),
                             hdf5_tool._jenkins_lookup3_hashlittle(repaired[:44]))
            with h5py.File(path, 'r') as h5:
                self.assertEqual(h5['sample'][:].tolist(), [1, 2, 3, 5, 8])

    def test_flag_5_is_recovered(self):
        with tempfile.TemporaryDirectory(dir=os.getcwd()) as tmp:
            path = os.path.join(tmp, 'flag5.h5')
            self._make_stale_h5(path, flag=5)
            ok, message = hdf5_tool.ensure_h5_openable(path)
            self.assertTrue(ok, message)
            with open(path, 'rb') as source:
                self.assertEqual(source.read(48)[11], 0)

    def test_active_os_writer_lock_refuses_without_source_change(self):
        with tempfile.TemporaryDirectory(dir=os.getcwd()) as tmp:
            path = os.path.join(tmp, 'active.h5')
            self._make_stale_h5(path)
            original = self._read_bytes(path)

            with h5_recovery._exclusive_source(path), patch.object(
                    hdf5_tool.h5py, 'File',
                    side_effect=OSError('file is already open for write')):
                ok, message = hdf5_tool.ensure_h5_openable(path)

            self.assertFalse(ok)
            self.assertIn('无法安全恢复', message)
            self.assertEqual(self._read_bytes(path), original)
            self.assertFalse(os.path.exists(path + '.bak_before_h5clear_flag'))

    def test_bad_checksum_or_non_stale_corruption_is_never_repaired(self):
        with tempfile.TemporaryDirectory(dir=os.getcwd()) as tmp:
            bad_checksum = os.path.join(tmp, 'bad_checksum.h5')
            self._make_stale_h5(bad_checksum)
            with open(bad_checksum, 'r+b') as source:
                source.seek(44)
                source.write(b'\x00\x00\x00\x00')
            original_checksum = self._read_bytes(bad_checksum)
            ok, _message = hdf5_tool.ensure_h5_openable(bad_checksum)
            self.assertFalse(ok)
            self.assertEqual(self._read_bytes(bad_checksum), original_checksum)
            self.assertFalse(os.path.exists(bad_checksum + '.bak_before_h5clear_flag'))

            malformed = os.path.join(tmp, 'malformed.h5')
            with open(malformed, 'wb') as source:
                source.write(b'not an hdf5 file')
            original_malformed = self._read_bytes(malformed)
            with patch.object(hdf5_tool.h5py, 'File',
                              side_effect=OSError('file is already open for write')):
                ok, _message = hdf5_tool.ensure_h5_openable(malformed)
            self.assertFalse(ok)
            self.assertEqual(self._read_bytes(malformed), original_malformed)

    def test_staged_validation_failure_preserves_source(self):
        with tempfile.TemporaryDirectory(dir=os.getcwd()) as tmp:
            path = os.path.join(tmp, 'verify_failure.h5')
            self._make_stale_h5(path)
            original = self._read_bytes(path)
            calls = {'count': 0}

            def fail_staged_validation(*args, **kwargs):
                calls['count'] += 1
                if calls['count'] == 1:
                    raise OSError('file is already open for write')
                raise OSError('staged metadata validation failed')

            with patch.object(hdf5_tool.h5py, 'File', side_effect=fail_staged_validation):
                ok, message = hdf5_tool.ensure_h5_openable(path)

            self.assertFalse(ok)
            self.assertIn('staged metadata validation failed', message)
            self.assertEqual(self._read_bytes(path), original)
            self.assertTrue(os.path.exists(path + '.bak_before_h5clear_flag'))

    def test_unsupported_layouts_and_unknown_flags_are_refused(self):
        with tempfile.TemporaryDirectory(dir=os.getcwd()) as tmp:
            cases = {
                'unknown_flag': lambda header: header.__setitem__(11, 2),
                'unknown_version': lambda header: header.__setitem__(8, 2),
                'unsupported_width': lambda header: header.__setitem__(9, 4),
                'eof_beyond_file': lambda header: header.__setitem__(
                    slice(28, 36), (2**64 - 1).to_bytes(8, 'little')),
            }
            for name, mutate in cases.items():
                with self.subTest(case=name):
                    path = os.path.join(tmp, name + '.h5')
                    self._make_stale_h5(path)
                    with open(path, 'r+b') as source:
                        header = bytearray(source.read(48))
                        mutate(header)
                        header[44:48] = hdf5_tool._jenkins_lookup3_hashlittle(
                            header[:44]).to_bytes(4, 'little')
                        source.seek(0)
                        source.write(header)
                    original = self._read_bytes(path)
                    with patch.object(hdf5_tool.h5py, 'File',
                                      side_effect=OSError('file is already open for write')):
                        ok, _message = hdf5_tool.ensure_h5_openable(path)
                    self.assertFalse(ok)
                    self.assertEqual(self._read_bytes(path), original)
                    self.assertFalse(os.path.exists(path + '.bak_before_h5clear_flag'))

            userblock = os.path.join(tmp, 'userblock.h5')
            with h5py.File(userblock, 'w', libver='latest', userblock_size=512) as h5:
                h5.create_dataset('sample', data=[1])
            original = self._read_bytes(userblock)
            with patch.object(hdf5_tool.h5py, 'File',
                              side_effect=OSError('file is already open for write')):
                ok, _message = hdf5_tool.ensure_h5_openable(userblock)
            self.assertFalse(ok)
            self.assertEqual(self._read_bytes(userblock), original)
            self.assertFalse(os.path.exists(userblock + '.bak_before_h5clear_flag'))

    def test_backup_creation_failure_does_not_modify_source(self):
        with tempfile.TemporaryDirectory(dir=os.getcwd()) as tmp:
            path = os.path.join(tmp, 'backup_failure.h5')
            self._make_stale_h5(path)
            original = self._read_bytes(path)
            with patch.object(h5_recovery, '_copy_source',
                              side_effect=OSError('backup media unavailable')):
                ok, message = hdf5_tool.ensure_h5_openable(path)
            self.assertFalse(ok)
            self.assertIn('backup media unavailable', message)
            self.assertEqual(self._read_bytes(path), original)
            self.assertFalse(os.path.exists(path + '.bak_before_h5clear_flag'))

    def test_source_fsync_failure_rolls_back_original_header(self):
        with tempfile.TemporaryDirectory(dir=os.getcwd()) as tmp:
            path = os.path.join(tmp, 'write_failure.h5')
            self._make_stale_h5(path)
            original = self._read_bytes(path)
            real_fsync = os.fsync
            calls = {'count': 0}

            def fail_source_fsync(fd):
                calls['count'] += 1
                if calls['count'] == 4:
                    raise OSError('injected source fsync failure')
                return real_fsync(fd)

            with patch.object(h5_recovery.os, 'fsync', side_effect=fail_source_fsync):
                ok, message = hdf5_tool.ensure_h5_openable(path)
            self.assertFalse(ok)
            self.assertIn('已回滚', message)
            self.assertEqual(self._read_bytes(path), original)
            self.assertEqual(self._read_bytes(path + '.bak_before_h5clear_flag'), original)

    def test_real_hdf5_writer_handle_is_not_recovered(self):
        with tempfile.TemporaryDirectory(dir=os.getcwd()) as tmp:
            path = os.path.join(tmp, 'real_writer.h5')
            with h5py.File(path, 'w') as h5:
                h5.create_dataset('sample', data=[1, 2, 3])
            original = self._read_bytes(path)
            child_code = (
                "import h5py, sys\n"
                "writer = h5py.File(sys.argv[1], 'r+')\n"
                "writer.flush()\n"
                "print('READY', flush=True)\n"
                "sys.stdin.readline()\n"
                "writer.close()\n"
            )
            child = subprocess.Popen(
                [sys.executable, '-c', child_code, path],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, text=True)
            ready_lines = queue.Queue()
            reader = threading.Thread(
                target=lambda: ready_lines.put(child.stdout.readline()), daemon=True)
            try:
                reader.start()
                try:
                    ready = ready_lines.get(timeout=15)
                except queue.Empty:
                    self.fail('子进程未能及时打开 HDF5 writer')
                self.assertEqual(ready.strip(), 'READY')

                # Do not read source bytes while the child holds the writer handle.
                ok, _message = hdf5_tool.ensure_h5_openable(path)
                self.assertFalse(ok)
                self.assertFalse(os.path.exists(path + '.bak_before_h5clear_flag'))
            finally:
                if child.poll() is None:
                    try:
                        child.stdin.write('\n')
                        child.stdin.flush()
                        child.communicate(timeout=10)
                    except Exception:
                        child.kill()
                        child.communicate(timeout=10)
                else:
                    child.communicate(timeout=10)
            self.assertEqual(self._read_bytes(path), original)

    def test_existing_backup_is_preserved_and_new_backup_is_unique(self):
        with tempfile.TemporaryDirectory(dir=os.getcwd()) as tmp:
            path = os.path.join(tmp, 'backup_exists.h5')
            self._make_stale_h5(path)
            old_backup = path + '.bak_before_h5clear_flag'
            with open(old_backup, 'wb') as source:
                source.write(b'old backup must remain untouched')
            stale_bytes = self._read_bytes(path)

            ok, message = hdf5_tool.ensure_h5_openable(path)

            self.assertTrue(ok, message)
            self.assertEqual(self._read_bytes(old_backup), b'old backup must remain untouched')
            new_backup = message.split('完整原文件备份: ', 1)[1]
            self.assertNotEqual(new_backup, old_backup)
            self.assertEqual(self._read_bytes(new_backup), stale_bytes)


if __name__ == '__main__':
    unittest.main()
