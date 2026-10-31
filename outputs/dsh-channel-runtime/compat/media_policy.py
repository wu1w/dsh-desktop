"""Bounded attachment reads for DSH's transport-only integration."""
import asyncio
from pathlib import Path
from urllib.parse import urlparse
from gateway.platforms.base import MAX_MEDIA_BYTES, cache_document_from_bytes_async

async def read_weixin_bytes(session, *, url, timeout_seconds=60.0):
    async def read():
        async with session.get(url) as response:
            response.raise_for_status()
            data=bytearray()
            async for chunk in response.content.iter_chunked(65536):
                if len(data)+len(chunk)>MAX_MEDIA_BYTES+32:
                    raise RuntimeError('CHANNEL_ATTACHMENT_LIMIT')
                data.extend(chunk)
            return bytes(data)
    return await asyncio.wait_for(read(),timeout=min(timeout_seconds,30))

async def qq_attachments(adapter, attachments):
    from tools.url_safety import async_is_safe_url
    from agent.i18n import t
    paths,types,transcripts=[],[],[]
    rows=attachments if isinstance(attachments,list) else []
    if len(rows)>8:
        raise RuntimeError('CHANNEL_ATTACHMENT_LIMIT')
    total=0
    for item in rows:
        if not isinstance(item,dict):
            continue
        mime=str(item.get('content_type') or 'application/octet-stream')
        name=str(item.get('filename') or '')
        if adapter._is_voice_content_type(mime,name):
            transcripts.append(str(item.get('asr_refer_text') or t('unsupported')))
            continue
        url=str(item.get('url') or '')
        if url.startswith('//'): url='https:'+url
        if not url or not await async_is_safe_url(url):
            raise RuntimeError('CHANNEL_UNSAFE_URL')
        host=urlparse(url).hostname or ''
        headers=adapter._qq_media_headers() if host.endswith('.qq.com') or host.endswith('.qpic.cn') else {}
        async with adapter._http_client.stream('GET',url,headers=headers,timeout=20) as response:
            response.raise_for_status()
            data=bytearray()
            async for chunk in response.aiter_bytes():
                total+=len(chunk)
                if total>MAX_MEDIA_BYTES:
                    raise RuntimeError('CHANNEL_ATTACHMENT_LIMIT')
                data.extend(chunk)
        if not name:
            import mimetypes
            name='attachment'+(mimetypes.guess_extension(mime) or '.bin')
        paths.append(await cache_document_from_bytes_async(bytes(data),name));types.append(mime)
    return {'image_urls':paths,'image_media_types':types,'voice_transcripts':transcripts,'attachment_info':''}
