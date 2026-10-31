"""DSH durability and bounded I/O around the unmodified enterprise adapters.

SDKs parse platform messages; this boundary owns ACK timing, credentials for
replies after restart, and uncertainty. No fallback send after a timeout.
"""
import asyncio
import json
import mimetypes
import time
import uuid
from pathlib import Path
from urllib.parse import urlparse, quote_plus
from gateway.platforms.base import SendResult, MAX_MEDIA_BYTES, cache_document_from_bytes_async
from ingress import Ingress


def connected(adapter, platform):
    if not adapter.is_connected:
        return False
    if platform == 'dingtalk':
        return bool(getattr(adapter, '_dsh_ready', False))
    if platform == 'wecom':
        return bool(adapter._ws and not adapter._ws.closed)
    return True


def not_sent(code='CHANNEL_REPLY_WINDOW'):
    return SendResult(success=False, error=code, error_kind='not_sent')


async def download(url, limit=MAX_MEDIA_BYTES):
    from tools.url_safety import create_ssrf_safe_async_client, async_is_safe_url
    if not await async_is_safe_url(url):
        raise RuntimeError('CHANNEL_UNSAFE_URL')
    async with create_ssrf_safe_async_client(timeout=20, follow_redirects=True) as client:
        async with client.stream('GET', url) as response:
            response.raise_for_status()
            data=bytearray()
            async for chunk in response.aiter_bytes():
                if len(data)+len(chunk)>limit:
                    raise RuntimeError('CHANNEL_ATTACHMENT_LIMIT')
                data.extend(chunk)
            return bytes(data),dict(response.headers)


def configure_enterprise(bridge, module):
    adapter=bridge.adapter
    journal=bridge.ingress=Ingress(bridge.platform)
    adapter._dedup.is_duplicate=lambda identifier:False
    capture=adapter.handle_message

    async def durable_event(event):
        source=event.source
        # Gate before downloading attachments or retaining routing credentials.
        allowed=adapter.config.extra.get('allow_from',[])
        if source.user_id not in allowed and source.user_id_alt not in allowed and not (not allowed and source.chat_type == 'dm' and adapter.config.extra.get('dsh_pairing')):
            return
        if source.chat_type!='dm' and source.chat_id not in adapter.config.extra.get('group_allow_from',[]):
            return
        if bridge.platform=='dingtalk':
            webhook=adapter._get_valid_webhook(source.chat_id)
            if webhook:
                journal.route(source.chat_id, {'url':webhook[0], 'expires':webhook[1]})
            total=0
            if len(event.media_urls)>8:
                raise RuntimeError('CHANNEL_ATTACHMENT_LIMIT')
            for index,url in enumerate(event.media_urls):
                data,headers=await download(url,MAX_MEDIA_BYTES-total)
                total+=len(data)
                mime=event.media_types[index]
                if mime in ('image','audio','video'):
                    mime=headers.get('content-type','').split(';')[0] or mime+'/*'
                event.media_types[index]=mime
                ext=mimetypes.guess_extension(mime) or Path(urlparse(url).path).suffix or '.bin'
                event.media_urls[index]=await cache_document_from_bytes_async(data,ext)
        else:
            payload=event.raw_message
            journal.route(source.chat_id, {'reqId':module.WeComAdapter._payload_req_id(payload), 'group':source.chat_type!='dm'})
        await capture(event)
    adapter.handle_message=durable_event

    if bridge.platform=='dingtalk':
        configure_dingtalk(adapter,module,journal)
    else:
        configure_wecom(adapter,module,journal)


def configure_dingtalk(adapter,module,journal):
    # Upstream immediately ACKs and schedules work. Commit raw bytes first;
    # use the SDK's framing/ACK implementation without its background dispatch.
    class DurableIncoming(module.dingtalk_stream.ChatbotHandler):
        def __init__(self, owner, loop=None):
            super().__init__()
        def pre_start(self):
            pass
        async def process(self,message):
            try:
                value=json.loads(message.data) if isinstance(message.data,str) else message.data
                if not isinstance(value,dict) or not value.get('msgId'):
                    raise RuntimeError('CHANNEL_PROTOCOL_FAILED')
                journal.put(value)
                return module.AckMessage.STATUS_OK,'OK'
            except Exception:
                return module.AckMessage.STATUS_SYSTEM_EXCEPTION,'error'
    module._IncomingHandler=DurableIncoming
    adapter._fire_done_reaction=lambda chat:None
    extract_text=adapter._extract_text
    def localized_text(message):
        from agent.i18n import t
        text=extract_text(message)
        if not getattr(message,'text',None) and getattr(message,'message_type','') in ('file','card','interactiveCard'):
            for prefix,key in (('[文件]','fileLabel'),('[文档]','documentLabel'),('[文档卡片]','cardLabel')):
                if text.startswith(prefix):return t(key)+text[len(prefix):]
        return text
    adapter._extract_text=localized_text
    adapter._dsh_ready=False
    ready=asyncio.Event()
    original_connect=adapter.connect

    async def run_stream():
        # SDK 0.24.3 start() does blocking requests and swallows cancellation.
        # Retain SDK routing, replace only its transport loop with bounded I/O.
        client=adapter._stream_client
        try:
            client.pre_start()
            response=await adapter._http_client.post(client.OPEN_CONNECTION_API,json={
                'clientId':adapter._client_id,'clientSecret':adapter._client_secret,
                'subscriptions':[{'type':'CALLBACK','topic':topic} for topic in client.callback_handler_map],
                'ua':'DSH/1.0','localIp':''},timeout=15)
            response.raise_for_status()
            connection=response.json()
            endpoint=connection['endpoint']
            parsed=urlparse(endpoint)
            if parsed.scheme!='wss' or not parsed.hostname or not parsed.hostname.endswith('.dingtalk.com'):
                raise RuntimeError('CHANNEL_UNSAFE_URL')
            import websockets
            async with websockets.connect(endpoint+'?ticket='+quote_plus(connection['ticket']),open_timeout=15,
                    close_timeout=3,ping_interval=20,ping_timeout=20,max_size=2*1024*1024,max_queue=16) as websocket:
                client.websocket=websocket
                adapter._dsh_ready=True
                ready.set()
                adapter._status_handler('connected')
                async for raw in websocket:
                    if await client.route_message(json.loads(raw))==client.TAG_DISCONNECT:
                        break
        except asyncio.CancelledError:
            raise
        except Exception:
            adapter._set_fatal_error('CHANNEL_CONNECTION_FAILED','',retryable=True)
        finally:
            adapter._dsh_ready=False
            ready.set()
            if adapter._running and not adapter.has_fatal_error:
                adapter._set_fatal_error('CHANNEL_CONNECTION_FAILED','',retryable=True)
    adapter._run_stream=run_stream

    async def connect(**kwargs):
        handler=adapter._status_handler
        adapter._status_handler=lambda state,code=None:handler('connecting' if state=='connected' and not adapter._dsh_ready else state,code)
        if not await original_connect(**kwargs):
            return False
        await asyncio.wait_for(ready.wait(),35)
        return connected(adapter,'dingtalk')
    adapter.connect=connect

    async def resolve_media(message):
        pairs=module.collect_download_codes(message)
        if not pairs:
            return
        if len(pairs)>8:
            raise RuntimeError('CHANNEL_ATTACHMENT_LIMIT')
        # Async, time bounded token and download-code calls. No optional giant
        # Alibaba card SDK, global credentials, or remote speech service.
        response=await adapter._http_client.post('https://api.dingtalk.com/v1.0/oauth2/accessToken',
            json={'appKey':adapter._client_id,'appSecret':adapter._client_secret},timeout=15)
        response.raise_for_status()
        token=response.json()['accessToken']
        for obj,key in pairs:
            code=obj.get(key) if isinstance(obj,dict) else getattr(obj,key)
            response=await adapter._http_client.post('https://api.dingtalk.com/v1.0/robot/messageFiles/download',
                json={'downloadCode':code,'robotCode':adapter._robot_code},headers={'x-acs-dingtalk-access-token':token},timeout=15)
            response.raise_for_status()
            url=response.json()['downloadUrl']
            if isinstance(obj,dict):obj[key]=url
            else:setattr(obj,key,url)
    adapter._resolve_media_codes=resolve_media

    async def send(chat,content,reply_to=None,metadata=None):
        route=journal.route(chat)
        if not route or route['expires']<=time.time()*1000:
            return not_sent()
        parsed=urlparse(route['url'])
        if parsed.scheme!='https' or parsed.hostname not in ('api.dingtalk.com','oapi.dingtalk.com') or parsed.username or parsed.password or parsed.port:
            return not_sent()
        # Upstream accepts any HTTP 2xx as success. DingTalk can return errcode
        # in HTTP 200; acknowledge only errcode=0. Never fall back after timeout.
        response=await adapter._http_client.post(route['url'],json={'msgtype':'markdown',
            'markdown':{'title':'DSH','text':adapter._normalize_markdown(content)}},timeout=15)
        response.raise_for_status()
        result=response.json()
        if result.get('errcode')!=0:
            return SendResult(success=False,error='CHANNEL_DELIVERY_UNCERTAIN')
        return SendResult(success=True,message_id=uuid.uuid4().hex)
    adapter.send=send


def configure_wecom(adapter,module,journal):
    adapter._attachment_text_merge_delay_seconds=0
    adapter._stream_keepalive_enabled=False
    adapter._is_group_allowed=lambda chat,user:chat in adapter.config.extra.get('group_allow_from',[]) and user in adapter.config.extra.get('allow_from',[])
    dispatch=adapter._dispatch_payload
    async def durable_dispatch(payload):
        cmd=payload.get('cmd')
        if cmd in module.CALLBACK_COMMANDS:
            journal.put(payload)
        else:
            if cmd==module.APP_CMD_EVENT_CALLBACK and (payload.get('body') or {}).get('event_type')=='disconnected_event':
                adapter._set_fatal_error('CHANNEL_CONNECTION_CONFLICT','',retryable=False)
            await dispatch(payload)
    adapter._dispatch_payload=durable_dispatch
    async def bounded_listen():
        # The upstream reconnect loop can spin without yielding when a failed
        # handshake leaves a closed socket. DSH owns reconnect/backoff instead.
        try:
            await adapter._read_events()
        except asyncio.CancelledError:
            return
        except Exception:
            pass
        if adapter._running:
            adapter._fail_all(RuntimeError('CHANNEL_OFFLINE'))
            adapter._set_fatal_error('CHANNEL_CONNECTION_FAILED','',retryable=True)
    adapter._listen_loop=bounded_listen

    # The vendor catches media errors and drops files. Preserve the whole
    # envelope on transient failures and quarantine permanent size violations.
    cache_media=adapter._cache_media
    extract_media=adapter._extract_media
    async def bounded_extract(body):
        adapter._dsh_media_bytes=0
        adapter._dsh_media_count=0
        return await extract_media(body)
    adapter._extract_media=bounded_extract
    async def strict_media(kind,media):
        adapter._dsh_media_count+=1
        if adapter._dsh_media_count>8:
            raise RuntimeError('CHANNEL_ATTACHMENT_LIMIT')
        adapter._dsh_media_error=None
        result=await cache_media(kind,media)
        if not result:
            raise adapter._dsh_media_error or RuntimeError('CHANNEL_MEDIA_FAILED')
        adapter._dsh_media_bytes+=Path(result[0]).stat().st_size
        if adapter._dsh_media_bytes>MAX_MEDIA_BYTES:
            raise RuntimeError('CHANNEL_ATTACHMENT_LIMIT')
        return result
    adapter._cache_media=strict_media
    async def read_remote(url,max_bytes):
        try:
            return await download(url,min(max_bytes,MAX_MEDIA_BYTES-adapter._dsh_media_bytes+32))
        except Exception as error:
            adapter._dsh_media_error=error
            raise
    adapter._download_remote_bytes=read_remote

    async def send_once(chat,content,reply_to=None,force_proactive=False):
        route=journal.route(chat)
        if not route:
            return not_sent()
        if route['group']:
            if not route.get('reqId'):
                return not_sent()
            response=await adapter._send_reply_request(route['reqId'],adapter._markdown_body(content))
        else:
            response=await adapter._send_proactive_markdown(chat,content)
        error=response.get('errcode',0)
        if error in (846604,846608,846609):
            if route['group']:
                journal.route(chat,{**route,'reqId':''})
            return not_sent()
        if error==846607:
            return not_sent('CHANNEL_RATE_LIMIT')
        if error not in (0,None):
            return SendResult(success=False,error='CHANNEL_DELIVERY_UNCERTAIN')
        return SendResult(success=True,message_id=adapter._payload_req_id(response) or uuid.uuid4().hex)
    adapter._send_inner=send_once
    async def bounded_send(chat, factory, is_control=False):
        # DSH's outbox owns waiting. Do not leave an SDK worker sending after
        # the RPC caller timed out or cancelled the request.
        if adapter._bucket_try_consume(chat,is_control)>0:
            return not_sent('CHANNEL_RATE_LIMIT')
        return await factory()
    adapter._enqueue_chat_send=bounded_send
