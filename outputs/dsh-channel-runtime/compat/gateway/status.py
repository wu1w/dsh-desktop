"""Account process locks live only below DSH's independent data directory."""
import fcntl
import hashlib
import os
from hermes_constants import get_hermes_home

_LOCKS = {}

def acquire_scoped_lock(scope, identity, *args, **kwargs):
    key = (scope, identity)
    if key in _LOCKS:
        return True, None
    directory = get_hermes_home() / 'locks'
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    file = directory / hashlib.sha256((scope + ':' + str(identity)).encode()).hexdigest()
    fd = os.open(file, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
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
