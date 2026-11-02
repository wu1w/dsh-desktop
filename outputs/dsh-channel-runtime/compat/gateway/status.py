"""Account process locks live only below DSH's independent data directory."""
import stat
import hashlib
import os

if os.name == 'nt':
    import msvcrt
else:
    import fcntl
from hermes_constants import get_hermes_home

_LOCKS = {}

def acquire_scoped_lock(scope, identity, *args, **kwargs):
    key = (scope, identity)
    if key in _LOCKS:
        return True, None
    directory = get_hermes_home() / 'locks'
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    file = directory / hashlib.sha256((scope + ':' + str(identity)).encode()).hexdigest()
    flags = os.O_CREAT | os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NOINHERIT', 0)
    fd = os.open(file, flags, 0o600)
    try:
        # Windows lacks O_NOFOLLOW. Refuse a reparse point/alias before using
        # the opened handle; no outside file is read, written or locked.
        opened, named = os.fstat(fd), os.lstat(file)
        if (not stat.S_ISREG(named.st_mode) or opened.st_nlink != 1
                or (opened.st_dev, opened.st_ino) != (named.st_dev, named.st_ino)
                or getattr(named, 'st_file_attributes', 0) & 0x400):
            raise OSError('UNSAFE_SCOPED_LOCK')
        if os.name == 'nt':
            os.lseek(fd, 0, os.SEEK_SET)
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
        else:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        os.close(fd)
        return False, None
    _LOCKS[key] = fd
    return True, None

def release_scoped_lock(scope, identity, *args, **kwargs):
    fd = _LOCKS.pop((scope, identity), None)
    if fd is not None:
        os.close(fd)
