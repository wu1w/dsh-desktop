import json
import os
import tempfile
from pathlib import Path

def atomic_json_write(path, data, **kwargs):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix='.dsh-')
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(data, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        parent = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(parent)
        finally:
            os.close(parent)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)

def env_int(name, default):
    # Adapter behavior is configured explicitly by DSH, never by Hermes env.
    return default

def env_float(name, default):
    return 0.0 if 'BATCH_DELAY' in name or 'BATCH_SPLIT_DELAY' in name else default

def is_truthy_value(value, default=False):
    if value is None:
        return default
    return str(value).lower() in {'true', '1', 'yes', 'on'}
