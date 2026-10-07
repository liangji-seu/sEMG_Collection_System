"""Exclusive, copy-on-write HDF5 edits shared by offline entry points.

Writers cooperate through a persistent sidecar lock (never unlink a lock file:
that would permit two processes to lock different inodes). HDF5's own locking
is left enabled. All handles must close before the staged file is committed.
"""

from contextlib import contextmanager
from functools import wraps
from pathlib import Path
import os
import shutil
import tempfile
import threading


class FileBusyError(RuntimeError):
    pass


_active = threading.local()


def _key(path):
    return os.path.normcase(os.path.realpath(os.fspath(path)))


def logical_h5_path(path):
    """Return the caller-visible source path for an active staged H5 path.

    Writers use this for provenance and backup names.  A nested operation may
    receive the temporary working copy, but it must still refer to the logical
    source beside the user's H5 file.
    """
    key = _key(path)
    active = getattr(_active, 'files', None) or {}
    logical = getattr(_active, 'logical', None) or {}
    return logical.get(key, key)


def _stamp(path):
    value = os.stat(path)
    return value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns


@contextmanager
def exclusive_file(path):
    """Acquire immediately or fail with an actionable error; no GUI blocking."""
    target = Path(_key(path))
    lock_path = target.with_name(target.name + '.offline.lock')
    with open(lock_path, 'a+b') as handle:
        handle.seek(0, os.SEEK_END)
        if handle.tell() == 0:
            handle.write(b'\0')
            handle.flush()
        handle.seek(0)
        try:
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            raise FileBusyError(f'文件正在被另一项离线操作使用：{target}') from exc
        try:
            yield target
        finally:
            handle.seek(0)
            if os.name == 'nt':
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def _validate_h5(path):
    import h5py
    with h5py.File(path, 'r') as file:
        # Traverse metadata, including links to deleted/corrupt objects.
        file.visititems(lambda _name, _obj: None)


@contextmanager
def h5_transaction(path, validate=None):
    """Yield a same-directory working copy; commit once on normal exit.

    Nested operations on either original or working path reuse the same copy.
    Every operation must raise on failure (a false result is not an exception).
    Commit failure leaves the original intact and removes our temporary file.
    """
    key = _key(path)
    active = getattr(_active, 'files', None)
    if active is None:
        active = _active.files = {}
    logical = getattr(_active, 'logical', None)
    if logical is None:
        logical = _active.logical = {}
    failures = getattr(_active, 'failures', None)
    if failures is None:
        failures = _active.failures = {}
    if key in active:
        owner = logical.get(key, key)
        try:
            yield active[key]
        except BaseException:
            failures[owner] = True
            raise
        return
    with exclusive_file(path) as original:
        stamp = _stamp(original)
        required = original.stat().st_size
        if shutil.disk_usage(original.parent).free < required + 1024 * 1024:
            raise OSError(f'没有足够空间创建安全编辑副本：{original}')
        fd, name = tempfile.mkstemp(prefix=f'.{original.stem}.edit-', suffix='.h5',
                                    dir=original.parent)
        os.close(fd)
        staged = Path(name)
        staged_key = _key(staged)
        active[key] = active[staged_key] = str(staged)
        logical[key] = key
        logical[staged_key] = key
        try:
            import h5py
            with h5py.File(original, 'r'):
                shutil.copy2(original, staged)
            yield str(staged)
            if failures.get(key):
                raise RuntimeError('嵌套离线操作失败，已取消整个文件的提交')
            _validate_h5(staged)
            if validate:
                validate(str(staged))
            if _stamp(original) != stamp:
                raise FileBusyError(f'源文件在编辑期间发生变化，未提交：{original}')
            with open(staged, 'r+b') as handle:
                os.fsync(handle.fileno())
            os.replace(staged, original)
        finally:
            active.pop(key, None)
            active.pop(staged_key, None)
            logical.pop(key, None)
            logical.pop(staged_key, None)
            failures.pop(key, None)
            staged.unlink(missing_ok=True)


def transactional_h5(function):
    """Decorate a path-first writer. False success results abort the commit."""
    @wraps(function)
    def wrapped(h5_path, *args, **kwargs):
        with h5_transaction(h5_path) as staged:
            result = function(staged, *args, **kwargs)
            failed = result is False or (isinstance(result, dict) and (
                result.get('success') is False or result.get('status') in
                ('error', 'failed', 'sync_failed', 'validation_failed')))
            if failed:
                reason = (result.get('error') or result.get('reason') or
                          result.get('message')) if isinstance(result, dict) else None
                raise RuntimeError(reason or '离线操作失败，原文件保持完整')
            return result
    return wrapped
