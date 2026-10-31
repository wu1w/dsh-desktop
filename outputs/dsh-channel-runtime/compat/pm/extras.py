import importlib.util

def available(name):
    return name == 'feishu' and importlib.util.find_spec('lark_oapi') is not None
