"""Bounded JSON-lines transport between DSH and pinned Hermes adapters."""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path[:0] = [str(ROOT / 'compat'), str(ROOT / 'vendor/hermes'), str(ROOT / 'packages')]

import asyncio
import base64
import dataclasses
import importlib
import json
import logging
import os
import signal
import time
import uuid
from gateway.config import PlatformConfig
from gateway.platforms import _shared
from gateway.platforms.base import SendResult

# Vendor SDK output must never become protocol output or expose token/body logs.
WIRE = sys.stdout
sys.stdout = sys.stderr
logging.disable(logging.CRITICAL)
MAX_LINE = 2 * 1024 * 1024
ADAPTERS = {'feishu': ('plugins.platforms.feishu.adapter', 'FeishuAdapter'),
            'qq': ('gateway.platforms.qqbot.adapter', 'QQAdapter'),
            'weixin': ('gateway.platforms.weixin', 'WeixinAdapter'),
            'dingtalk': ('plugins.platforms.dingtalk.adapter', 'DingTalkAdapter'),
            'wecom': ('plugins.platforms.wecom.adapter', 'WeComAdapter')}

def emit(value):
    data = json.dumps(value, ensure_ascii=False, separators=(',', ':'))
    if len(data.encode()) > MAX_LINE:
        raise RuntimeError('CHANNEL_PROTOCOL_LIMIT')
    WIRE.write(data + '\n')
    WIRE.flush()

class Bridge:
    def __init__(self):
        self.adapter = None
        self.platform = None
        self.pending = {}
        self.tasks = set()
        self.closing = False
        self.qr = None
        self.connecting = False
        self.ingress = None

    async def inbound(self, event):
        if self.closing or len(self.pending) >= 32:
            raise RuntimeError('CHANNEL_BACKPRESSURE')
        source = event.source
        # Never trust a payload to set internal=true or grant remote permissions.
        body = {'messageId': str(event.message_id or ''), 'text': event.text or '',
                'chatId': str(source.chat_id), 'chatType': source.chat_type,
                'senderId': str(source.user_id or ''), 'senderAlt': source.user_id_alt,
                'threadId': source.thread_id, 'scopeId': source.scope_id,
                'isBot': bool(source.is_bot), 'senderName': source.user_name, 'chatName': source.chat_name,
                'transportType': self.adapter._chat_type_map.get(source.chat_id) if self.platform == 'qq' else None, 'attachments': [
                    {'path': str(p), 'mime': event.media_types[i] if i < len(event.media_types) else ''}
                    for i, p in enumerate(event.media_urls)],
                'metadata': {'thread_id': source.thread_id} if source.thread_id else {}}
        identifier = uuid.uuid4().hex
        future = asyncio.get_running_loop().create_future()
        self.pending[identifier] = future
        try:
            emit({'event': 'incoming', 'id': identifier, 'message': body})
            result = await asyncio.wait_for(future, 20)
            return result.get('accepted') is True
        finally:
            self.pending.pop(identifier, None)

    def configure(self, params):
        if self.adapter or self.platform:
            raise RuntimeError('CHANNEL_ALREADY_CONFIGURED')
        self.platform = params['platform']
        module_name, class_name = ADAPTERS[self.platform]
        module = importlib.import_module(module_name)
        extra = dict(params.get('extra') or {})
        allowed = extra.get('allow_from', [])
        _shared.SECRETS.update({'FEISHU_ALLOWED_USERS': ','.join(allowed),
                                'FEISHU_GROUP_POLICY': 'allowlist'})
        config = PlatformConfig(token=params.get('token', ''), extra=extra, allowed_users=allowed)
        self.adapter = getattr(module, class_name)(config)
        self.adapter.set_message_handler(self.inbound)
        self.adapter._status_handler = lambda state, code=None: emit({'event': 'status', 'state': state, 'code': code})
        if self.platform == 'feishu':
            # DSH owns deduplication and message ordering. Never persist a vendor
            # 'seen' marker or merge separate IDs before the SQLite admission ACK.
            async def no_vendor_dedup(identifier):
                return False
            from ingress import Ingress
            self.ingress = Ingress(self.platform)
            self.adapter._on_message_event = self.ingress.put
            self.adapter._is_duplicate = no_vendor_dedup
            self.adapter._dispatch_inbound_event = self.adapter.handle_message
            module._FEISHU_SEND_ATTEMPTS = 1
            # Only IM message events belong to this integration. Hermes tools,
            # meetings, drive comments and interactive approvals are not loaded.
            def message_handler():
                return module.EventDispatcherHandler.builder('', '').register_p2_im_message_receive_v1(self.adapter._on_message_event).build()
            self.adapter._build_event_handler = message_handler
        if self.platform == 'qq':
            from ingress import Ingress
            self.ingress = Ingress(self.platform)
            dispatch = self.adapter._dispatch_payload
            def durable_dispatch(payload):
                if payload.get('op') == 0 and payload.get('t') in self.adapter._INBOUND_HANDLERS:
                    self.ingress.put(payload)
                    sequence = payload.get('s')
                    if isinstance(sequence, int):
                        self.adapter._last_seq = max(sequence, self.adapter._last_seq or sequence)
                    return
                dispatch(payload)
            self.adapter._dispatch_payload = durable_dispatch
            self.adapter._dedup.is_duplicate = lambda identifier: False
            self.adapter.set_interaction_callback(None)
            async def send_once(chat_id, content, reply_to=None):
                sender = self.adapter._text_sender(self.adapter._guess_chat_type(chat_id))
                if sender is None:
                    return SendResult(success=False, error='CHANNEL_PROTOCOL_FAILED')
                return await sender(chat_id, content, reply_to)
            self.adapter._send_chunk = send_once
            # Native QQ ASR text is usable; external speech services are not
            # configured implicitly from the user's Hermes installation.
            async def native_transcript(*args, asr_refer_text=None, **kwargs):
                from agent.i18n import t
                return asr_refer_text or t('unsupported')
            self.adapter._stt_voice_attachment = native_transcript
            from media_policy import qq_attachments
            self.adapter._process_attachments = lambda attachments: qq_attachments(self.adapter, attachments)
        if self.platform == 'weixin':
            from ingress import Ingress, PERMANENT_ERRORS
            self.ingress = Ingress(self.platform)
            from media_policy import read_weixin_bytes
            module._download_bytes = read_weixin_bytes
            # The upstream enqueue hook is synchronous. Await DSH's durable
            # receipt before the upstream poll loop commits its cursor.
            self.adapter._dedup.is_duplicate = lambda identifier: False
            process_message = self.adapter._process_message
            async def durable_process(message):
                before = dict(self.adapter._dedup._seen)
                await process_message(message)
                await self.adapter.drain_background()
                if self.adapter.has_fatal_error:
                    self.adapter._dedup._seen = before
                    raise RuntimeError('CHANNEL_INBOX_REJECTED')
            self.adapter._process_message = durable_process
            get_updates = module._get_updates
            async def durable_updates(*args, **kwargs):
                response = await get_updates(*args, **kwargs)
                if module._is_session_expired(response,response.get('ret',0),response.get('errcode',0)):
                    self.adapter._set_fatal_error('CHANNEL_QR_REQUIRED','',retryable=False)
                    raise RuntimeError('CHANNEL_QR_REQUIRED')
                for message in response.get('msgs') or []:
                    try:
                        await durable_process(message)
                    except Exception as error:
                        if str(error) not in PERMANENT_ERRORS:raise
                        self.ingress.quarantine(message,str(error))
                return {**response, 'msgs': []}
            module._get_updates = durable_updates
        if self.platform in ('dingtalk', 'wecom'):
            from enterprise import configure_enterprise
            configure_enterprise(self, module)
        return {'configured': True}

    async def call(self, method, params):
        if method == 'configure':
            return self.configure(params)
        if not self.adapter:
            raise RuntimeError('CHANNEL_NOT_CONFIGURED')
        if method == 'connect':
            if self.connecting:
                raise RuntimeError('CHANNEL_BUSY')
            self.connecting = True
            try:
                connected = await asyncio.wait_for(self.adapter.connect(), 45)
                if connected and self.ingress and self.platform != 'weixin':
                    self.ingress.start(self.adapter)
                return {'connected': bool(connected), 'code': None if connected else 'CHANNEL_CONNECTION_FAILED'}
            finally:
                self.connecting = False
        if method == 'status':
            from enterprise import connected
            return {'connected': connected(self.adapter, self.platform), 'fatal': self.adapter.has_fatal_error,
                    'fatalCode': (self.adapter._fatal_error or {}).get('code'),
                    'pending': len(self.pending), 'rejected': self.ingress.rejected_count() if self.ingress else 0}
        if method == 'send':
            from enterprise import connected
            if not connected(self.adapter, self.platform):
                return {'success': False, 'code': 'CHANNEL_OFFLINE', 'delivery': 'not_sent'}
            chat_id = params['chatId']
            if self.platform == 'qq' and params.get('chatType'):
                self.adapter._chat_type_map[chat_id] = params['chatType']
            try:
                result = await asyncio.wait_for(self.adapter.send(chat_id, params['text'],
                    reply_to=params.get('replyTo'), metadata=params.get('metadata')), 25)
            except Exception:
                return {'success': False, 'code': 'CHANNEL_DELIVERY_UNCERTAIN', 'delivery': 'unknown'}
            if result.success:
                return {'success': True, 'messageId': result.message_id, 'delivery': 'delivered'}
            if result.error_kind == 'not_sent':
                return {'success': False, 'code': result.error, 'delivery': 'not_sent'}
            # An error string is not proof the platform rejected the message.
            return {'success': False, 'code': 'CHANNEL_DELIVERY_UNCERTAIN', 'delivery': 'unknown'}
        if method == 'qr/start':
            from onboarding import Onboarding
            self.qr = Onboarding(self.platform)
            return await self.qr.start()
        if method == 'qr/poll':
            result = await self.qr.poll() if self.qr else {'status': 'expired'}
            if result['status'] in ('confirmed', 'expired', 'denied'):
                self.qr = None
            return result
        if method == 'close':
            await self.close()
            return {'closed': True}
        raise RuntimeError('CHANNEL_METHOD_UNSUPPORTED')

    async def request(self, request):
        identifier = request['id']
        try:
            result = await self.call(request['method'], request.get('params') or {})
            emit({'id': identifier, 'result': result})
        except Exception as failure:
            code = str(failure)
            if not code.startswith('CHANNEL_') or len(code) > 80:
                code = 'CHANNEL_RUNTIME_FAILED'
            emit({'id': identifier, 'error': {'code': code}})

    async def close(self):
        if self.closing:
            return
        self.closing = True
        if self.ingress:
            await self.ingress.close()
        if self.adapter:
            await asyncio.wait_for(self.adapter.disconnect(), 15)
        for future in list(self.pending.values()):
            if not future.done():
                future.cancel()

async def main():
    bridge = Bridge()
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader(limit=MAX_LINE)
    transport, _ = await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)
    stopping = asyncio.Event()
    for signum in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(signum, stopping.set)
    emit({'event': 'ready', 'protocol': 1})
    try:
        while not stopping.is_set():
            line_task = asyncio.create_task(reader.readline())
            stop_task = asyncio.create_task(stopping.wait())
            done, pending = await asyncio.wait([line_task, stop_task], return_when=asyncio.FIRST_COMPLETED)
            for task in pending:
                task.cancel()
            if stop_task in done:
                break
            line = line_task.result()
            if not line:
                break
            request = json.loads(line)
            if request.get('method') == 'incoming/ack':
                future = bridge.pending.get(request.get('id'))
                if future and not future.done():
                    future.set_result(request.get('result') or {})
                continue
            if len(bridge.tasks) >= 32:
                emit({'id': request.get('id'), 'error': {'code': 'CHANNEL_BACKPRESSURE'}})
                continue
            task = asyncio.create_task(bridge.request(request))
            bridge.tasks.add(task)
            task.add_done_callback(bridge.tasks.discard)
    finally:
        try:
            await bridge.close()
        finally:
            transport.close()
            for task in list(bridge.tasks):
                task.cancel()
            await asyncio.gather(*list(bridge.tasks), return_exceptions=True)

if __name__ == '__main__':
    try:
        asyncio.run(main())
    except BaseException:
        # Pipe closed / malformed protocol / unconfirmed cleanup: nonzero
        # exits are reconciled by DSH, never reported as delivered.
        sys.exit(1)
