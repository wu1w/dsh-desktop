from dataclasses import dataclass, field
from enum import Enum

class Platform(Enum):
    FEISHU = 'feishu'
    QQBOT = 'qqbot'
    WEIXIN = 'weixin'
    DINGTALK = 'dingtalk'
    WECOM = 'wecom'

@dataclass
class PlatformConfig:
    enabled: bool = True
    token: str = ''
    extra: dict = field(default_factory=dict)
    allowed_users: list = field(default_factory=list)
