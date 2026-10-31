"""DSH's explicit adapter boundary. No Hermes agent, tools, config or sessions run here.

The unmodified MIT platform adapters call this small contract. Admission and
delivery are acknowledged by DSH's durable inbox/outbox, not by a second agent.
"""
import asyncio
import contextlib
import mimetypes
import os
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Any
from hermes_constants import get_hermes_home
from gateway.session import SessionSource
from gateway.status import acquire_scoped_lock, release_scoped_lock

_IMAGE_EXTS = frozenset({'.png', '.jpg', '.jpeg', '.webp', '.gif'})
_VIDEO_EXTS = frozenset({'.mp4', '.mov', '.webm', '.mkv'})
SUPPORTED_DOCUMENT_TYPES = {ext: mimetypes.guess_type('file' + ext)[0] or 'application/octet-stream'
                            for ext in ['.txt', '.md', '.csv', '.json', '.pdf', '.docx', '.xlsx', '.pptx', '.zip']}
MAX_MEDIA_BYTES = 10 * 1024 * 1024

@dataclass
class SendResult:
    success: bool
    message_id: Optional[str] = None
    error: Optional[str] = None
    raw_response: Any = None
    retryable: bool = False
    retry_after: Optional[float] = None
    continuation_message_ids: tuple = ()
    error_kind: Optional[str] = None

@dataclass
class ExecApprovalPrompt:
    chat_id: str
    session_key: str
    text: str
    actions: list
    command: str
    description: str
    smart_denied: bool
    metadata: Optional[dict] = None

    @property
    def choices(self):
        return [row[1] for row in self.actions]

def gateway_trust_env():
    return True

async def _ssrf_redirect_guard(response):
    from tools.url_safety import async_is_safe_url, redirect_target_from_response
    target = redirect_target_from_response(response)
    if target and not await async_is_safe_url(target):
        raise RuntimeError('CHANNEL_UNSAFE_URL')

def _cache(data, filename='', *args, **kwargs):
    if len(data) > MAX_MEDIA_BYTES:
        raise RuntimeError('CHANNEL_ATTACHMENT_LIMIT')
    name = str(filename or kwargs.get('filename') or kwargs.get('ext') or '.bin')
    suffix = Path(name).suffix or (name if name.startswith('.') else '.bin')
    if not suffix[1:].isalnum() or len(suffix) > 12:
        suffix = '.bin'
    directory = get_hermes_home() / 'media'
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    files = list(directory.iterdir())
    if len(files) >= 2000 or sum(p.stat().st_size for p in files if p.is_file()) + len(data) > 500 * 1024 * 1024:
        raise RuntimeError('CHANNEL_MEDIA_FULL')
    target = directory / (uuid.uuid4().hex + suffix)
    fd = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(data)
    return str(target)

async def cache_document_from_bytes_async(data, *args, **kwargs):
    return await asyncio.to_thread(_cache, data, *args, **kwargs)

cache_audio_from_bytes_async = cache_document_from_bytes_async
cache_image_from_bytes_async = cache_document_from_bytes_async

async def cache_image_from_url(url, *args, **kwargs):
    from tools.url_safety import create_ssrf_safe_async_client
    async with create_ssrf_safe_async_client(timeout=20, follow_redirects=True) as client:
        async with client.stream('GET', url) as response:
            response.raise_for_status()
            data = bytearray()
            async for chunk in response.aiter_bytes():
                data.extend(chunk)
                if len(data) > MAX_MEDIA_BYTES:
                    raise RuntimeError('CHANNEL_ATTACHMENT_LIMIT')
    return await cache_image_from_bytes_async(bytes(data), '.png')

def resolve_channel_prompt(*args, **kwargs):
    return None

def transcode_to_ogg_opus(*args, **kwargs):
    # Audio conversion is optional in the upstream adapter; it falls back to a file.
    return None

class BasePlatformAdapter:
    MAX_MESSAGE_LENGTH = 4000

    def __init__(self, config, platform):
        self.config, self.platform = config, platform
        self._running = False
        self._fatal_error = None
        self._message_handler = None
        self._fatal_error_handler = None
        self._background = set()
        self._pending_text_batches = {}
        self._pending_text_batch_tasks = {}
        self._platform_lock = None
        self._status_handler = lambda state, code=None: None

    @property
    def name(self):
        return self.platform.value

    @property
    def is_connected(self):
        return self._running and not self.has_fatal_error

    @property
    def has_fatal_error(self):
        return self._fatal_error is not None

    def set_message_handler(self, handler):
        self._message_handler = handler

    def set_fatal_error_handler(self, handler):
        self._fatal_error_handler = handler

    def _mark_connected(self):
        self._running = True
        self._fatal_error = None
        self._status_handler('connected')

    def _mark_disconnected(self):
        self._running = False
        self._status_handler('disconnected')

    def _set_fatal_error(self, code, message, retryable=False):
        self._fatal_error = {'code': code, 'retryable': retryable}
        self._status_handler('error', code if code.startswith('CHANNEL_') else 'CHANNEL_CONNECTION_FAILED')

    def _write_runtime_status_safe(self, state, **kwargs):
        self._status_handler(state, 'CHANNEL_CONNECTION_FAILED' if kwargs.get('error_code') else None)

    def _wire_plugin_handlers(self, native_client):
        # DSH deliberately has no Hermes plugin dispatcher or implicit remote approvals.
        return None

    def build_source(self, **kwargs):
        return SessionSource(platform=self.platform, **kwargs)

    def _source_session_key(self, source):
        import json
        return json.dumps([self.platform.value, source.chat_id, source.thread_id, source.user_id], separators=(',', ':'))

    def _event_session_key(self, event):
        return self._source_session_key(event.source)

    async def handle_message(self, event):
        if not self._message_handler:
            raise RuntimeError('CHANNEL_NOT_READY')
        accepted = await self._message_handler(event)
        event._gateway_accepted = bool(accepted)
        if not accepted:
            raise RuntimeError('CHANNEL_INBOX_REJECTED')

    def _configure_text_batch_delays(self):
        pass

    def _enqueue_text_event(self, event):
        task = asyncio.create_task(self.handle_message(event))
        self._background.add(task)
        def done(result):
            self._background.discard(result)
            if not result.cancelled() and result.exception():
                self._set_fatal_error('inbox', '', retryable=True)
        task.add_done_callback(done)

    async def drain_background(self):
        if self._background:
            await asyncio.gather(*list(self._background), return_exceptions=True)

    def _text_batch_key(self, event):
        return self._event_session_key(event)

    async def _flush_text_batch_now(self, key):
        return None

    def _acquire_platform_lock(self, scope, identity, *args):
        acquired, _ = acquire_scoped_lock(scope, identity)
        if acquired:
            self._platform_lock = (scope, identity)
            return True
        self._set_fatal_error('locked', '', False)
        return False

    def _release_platform_lock(self):
        if self._platform_lock:
            release_scoped_lock(*self._platform_lock)
            self._platform_lock = None

    @staticmethod
    def truncate_message(text, limit):
        from gateway.platforms.helpers import split_text_fence_aware
        return split_text_fence_aware(text, limit)

    @staticmethod
    def format_message(content):
        return content

    @staticmethod
    def warning_text(*args, **kwargs):
        from agent.i18n import t
        return t('unsupported')

    @staticmethod
    def _merge_caption(*parts):
        return '\n'.join(part for part in parts if part)

    def _media_delivery_scope(self, source):
        return contextlib.nullcontext()

    # Outbound attachments must be explicit, validated DSH requests. Never
    # interpret arbitrary model text as permission to upload a local file.
    @staticmethod
    def extract_media(text):
        return [], text

    extract_local_files = extract_media
    extract_images = extract_media

    @staticmethod
    def filter_local_delivery_paths(paths):
        return []

    filter_media_delivery_paths = filter_local_delivery_paths
