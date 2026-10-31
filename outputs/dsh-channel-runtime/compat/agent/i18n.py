import os

MESSAGES = {
    'zh': {'fileLabel':'[文件]', 'documentLabel':'[文档]', 'cardLabel':'[文档卡片]', 'unsupported': '此消息类型暂不支持，请发送文字或图片。'},
    'en': {'fileLabel':'[File]', 'documentLabel':'[Document]', 'cardLabel':'[Document card]', 'unsupported': 'This message type is not supported. Send text or an image.'},
}

def t(key, *args, **kwargs):
    locale = 'zh' if os.environ.get('DSH_LOCALE', 'en').startswith('zh') else 'en'
    return MESSAGES[locale].get(key, MESSAGES[locale]['unsupported'])
