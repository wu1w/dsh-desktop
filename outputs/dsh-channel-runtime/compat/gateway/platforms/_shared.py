"""Explicit per-process settings replace Hermes's environment/profile loader."""
SECRETS = {}

def get_scoped_secret(key, default=''):
    return SECRETS.get(key, default)

def extra_or_secret(extra, key, env, default='', blank_is_unset=True):
    value = extra.get(key)
    return value if value is not None and (value != '' or not blank_is_unset) else get_scoped_secret(env, default)

def decode_json_list_literal(value):
    import json
    try:
        parsed = json.loads(value) if isinstance(value, str) else value
        return parsed if isinstance(parsed, list) else None
    except (ValueError, TypeError):
        return None

def apply_yaml_bridge(*args, **kwargs):
    raise RuntimeError('CHANNEL_HERMES_CONFIG_UNSUPPORTED')

def send_error(message):
    from gateway.platforms.base import SendResult
    return SendResult(success=False, error=str(message))
