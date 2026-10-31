def install_hint(*args, **kwargs):
    return 'CHANNEL_RUNTIME_INCOMPLETE'

def ensure_import(name):
    if name != 'feishu':
        raise ImportError('CHANNEL_DEPENDENCY_UNSUPPORTED')
    import lark_oapi
    return lark_oapi
