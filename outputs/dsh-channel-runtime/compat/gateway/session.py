from dataclasses import dataclass, asdict
from typing import Optional
from gateway.config import Platform

@dataclass
class SessionSource:
    platform: Platform
    chat_id: str
    chat_name: Optional[str] = None
    chat_type: str = 'dm'
    user_id: Optional[str] = None
    user_name: Optional[str] = None
    thread_id: Optional[str] = None
    chat_topic: Optional[str] = None
    user_id_alt: Optional[str] = None
    chat_id_alt: Optional[str] = None
    is_bot: bool = False
    scope_id: Optional[str] = None
    guild_id: Optional[str] = None
    parent_chat_id: Optional[str] = None
    message_id: Optional[str] = None
    profile: Optional[str] = None
    profile_route_rejected: bool = False

    def to_dict(self):
        return {**asdict(self), 'platform': self.platform.value}
