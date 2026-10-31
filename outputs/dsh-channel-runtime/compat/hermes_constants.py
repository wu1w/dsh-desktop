"""DSH-owned account scope; never reads an installed Hermes profile."""
import os
from pathlib import Path

def get_hermes_home():
    value = os.environ.get('DSH_CHANNEL_HOME')
    if not value or not Path(value).is_absolute():
        raise RuntimeError('CHANNEL_SCOPE_REQUIRED')
    return Path(value)

def get_project_root():
    return Path(__file__).resolve().parents[1]

def get_hermes_home_override():
    return str(get_hermes_home())

def mkdir_under_hermes_home(directory):
    target = Path(directory).resolve()
    home = get_hermes_home().resolve()
    if target != home and home not in target.parents:
        raise OSError('CHANNEL_STORAGE_UNSAFE')
    target.mkdir(parents=True, exist_ok=True, mode=0o700)
    return target
