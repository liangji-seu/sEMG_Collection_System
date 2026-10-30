"""Guarded recovery of an idle HDF5 v3 stale write flag."""

from contextlib import contextmanager
import ctypes
import os
import shutil
import tempfile

try:
    from file_access import _io_path, _ordinary_path
except ImportError:
    def _io_path(path):
        return os.fspath(path)

    def _ordinary_path(path):
        return os.fspath(path)


@contextmanager
def _exclusive_source(path):
    """Open the source with an OS-level exclusive lock for the full operation."""
    if os.name == 'nt':
        import msvcrt

        kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
        create_file = kernel32.CreateFileW
        create_file.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32,
                                ctypes.c_uint32, ctypes.c_void_p,
                                ctypes.c_uint32, ctypes.c_uint32,
                                ctypes.c_void_p]
        create_file.restype = ctypes.c_void_p
        close_handle = kernel32.CloseHandle
        close_handle.argtypes = [ctypes.c_void_p]
        close_handle.restype = ctypes.c_int
        handle = create_file(_io_path(path),
                             0x80000000 | 0x40000000,
                             0, None, 3, 0x80, None)
        invalid = ctypes.c_void_p(-1).value
        if handle in (None, invalid):
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            fd = msvcrt.open_osfhandle(handle, os.O_BINARY | os.O_RDWR)
        except Exception:
            close_handle(handle)
            raise
        with os.fdopen(fd, 'r+b') as source:
            yield source
    else:
        raise OSError('自动恢复仅在可验证 Windows no-share 文件锁的平台启用')


def _unique_backup_path(source_path):
    candidate = source_path + '.bak_before_h5clear_flag'
    index = 1
    while os.path.exists(_io_path(candidate)):
        candidate = f'{source_path}.bak_before_h5clear_flag.{index}'
        index += 1
    return candidate


def _copy_source(source, destination, exclusive=True):
    source.seek(0)
    created = False
    try:
        with open(_io_path(destination), 'xb' if exclusive else 'wb') as backup:
            created = True
            shutil.copyfileobj(source, backup, length=1024 * 1024)
            backup.flush()
            os.fsync(backup.fileno())
    except Exception:
        if created:
            try:
                os.remove(_io_path(destination))
            except OSError:
                pass
        raise


def recover_stale_write_flag(path, checksum_func):
    """Return ``(ok, message)`` after safely repairing a recognized v3 flag."""
    path = os.path.abspath(_ordinary_path(path))
    temporary_path = None
    backup_path = None
    try:
        with _exclusive_source(path) as source:
            source.seek(0, os.SEEK_END)
            original_size = source.tell()
            source.seek(0)
            original_header = source.read(48)
            if (len(original_header) != 48 or
                    original_header[:8] != b'\x89HDF\r\n\x1a\n'):
                return False, '拒绝修复：文件不是从偏移 0 开始的完整 HDF5 v3 文件'
            if original_header[8] != 3:
                return False, f'拒绝修复：仅支持 superblock v3，当前版本={original_header[8]}'
            if original_header[9] != 8 or original_header[10] != 8:
                return False, '拒绝修复：仅支持地址和长度均为 8 字节的 HDF5 文件'
            if original_header[12:20] != b'\0' * 8:
                return False, '拒绝修复：暂不支持非零 base address 的 HDF5 文件'
            eof_address = int.from_bytes(original_header[28:36], 'little')
            if not 48 <= eof_address <= original_size:
                return False, '拒绝修复：HDF5 EOF 地址超出实际文件范围或无效'
            expected_checksum = checksum_func(original_header[:44])
            if int.from_bytes(original_header[44:48], 'little') != expected_checksum:
                return False, '拒绝修复：superblock 校验和错误'
            if original_header[11] not in (1, 5):
                return False, f'拒绝修复：不属于可清除的 stale write flag（flag={original_header[11]}）'

            candidate_backup_path = _unique_backup_path(path)
            _copy_source(source, candidate_backup_path)
            backup_path = candidate_backup_path
            fd, temporary_path = tempfile.mkstemp(
                prefix='.h5_flag_recovery_', suffix='.h5',
                dir=_io_path(os.path.dirname(os.path.abspath(path))))
            os.close(fd)
            _copy_source(source, temporary_path, exclusive=False)
            staged_header = bytearray(original_header)
            staged_header[11] = 0
            staged_header[44:48] = checksum_func(staged_header[:44]).to_bytes(4, 'little')
            with open(_io_path(temporary_path), 'r+b') as staged:
                staged.seek(0)
                staged.write(staged_header)
                staged.flush()
                os.fsync(staged.fileno())
            import h5py
            with h5py.File(_io_path(temporary_path), 'r') as staged_h5:
                staged_h5.visititems(lambda _name, _obj: None)
                if staged_h5.id.get_filesize() != original_size:
                    raise RuntimeError('暂存文件长度变化')
            with open(_io_path(temporary_path), 'rb') as staged:
                if staged.read(48) != bytes(staged_header):
                    raise RuntimeError('暂存 superblock 复核失败')

            # Recheck the locked source immediately before the only source write.
            source.seek(0, os.SEEK_END)
            if source.tell() != original_size:
                return False, f'拒绝修复：锁定期间源文件长度变化，完整备份保留于 {backup_path}'
            source.seek(0)
            if source.read(48) != original_header:
                return False, f'拒绝修复：锁定期间源文件头部变化，完整备份保留于 {backup_path}'
            try:
                source.seek(0)
                source.write(staged_header)
                source.flush()
                os.fsync(source.fileno())
            except Exception as write_error:
                try:
                    source.seek(0)
                    source.write(original_header)
                    source.flush()
                    os.fsync(source.fileno())
                except Exception as rollback_error:
                    return False, (f'写入及回滚均失败，源文件状态不确定；完整备份保留于 {backup_path}。'
                                   f'写入错误: {write_error}; 回滚错误: {rollback_error}')
                return False, f'写入失败，原 superblock 已回滚；完整备份保留于 {backup_path}: {write_error}'
            return True, f'已安全清除 stale write flag；完整原文件备份: {backup_path}'
    except Exception as exc:
        detail = f'；完整备份保留于 {backup_path}' if backup_path else ''
        return False, f'无法安全恢复 HDF5 stale write flag: {exc}{detail}'
    finally:
        if temporary_path:
            try:
                os.remove(_io_path(temporary_path))
            except OSError:
                pass
