"""DSH's cancellable UI bridge to the pinned Hermes QR onboarding helpers.

Credentials stay on the private worker pipe. Platform code and cryptography are
reused unchanged; this module splits their terminal loops into start/poll calls.
"""
import asyncio
import base64
import importlib
import time
from urllib.parse import quote
import aiohttp
import qrcode


def image(url):
    qr = qrcode.QRCode(border=4)
    qr.add_data(url)
    qr.make(fit=True)
    matrix = qr.get_matrix()
    cells = ''.join(f'M{x},{y}h1v1h-1z' for y, row in enumerate(matrix) for x, cell in enumerate(row) if cell)
    svg = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {len(matrix)} {len(matrix)}"><path fill="white" d="M0 0h{len(matrix)}v{len(matrix)}H0z"/><path d="{cells}"/></svg>'
    return 'data:image/svg+xml;base64,' + base64.b64encode(svg.encode()).decode()


class Onboarding:
    def __init__(self, platform):
        self.platform = platform
        self.state = None

    async def start(self):
        interval, ttl = 2, 240
        if self.platform == 'feishu':
            module = importlib.import_module('plugins.platforms.feishu.adapter')
            await asyncio.to_thread(module._init_registration, 'feishu')
            begin = await asyncio.to_thread(module._begin_registration, 'feishu')
            self.state = {'device': begin['device_code'], 'domain': 'feishu'}
            url, interval, ttl = begin['qr_url'], max(2, int(begin['interval'])), min(600, int(begin['expire_in']))
        elif self.platform == 'qq':
            module = importlib.import_module('gateway.platforms.qqbot.onboard')
            task, key = await asyncio.to_thread(module._create_bind_task)
            self.state = {'task': task, 'key': key}
            url, ttl = module.build_connect_url(task), 600
        elif self.platform == 'weixin':
            module = importlib.import_module('gateway.platforms.weixin')
            async with aiohttp.ClientSession() as client:
                value, url = await module._fetch_qr(client, '3')
            self.state = {'value': value}
        else:
            raise RuntimeError('CHANNEL_QR_UNSUPPORTED')
        if not url:
            raise RuntimeError('CHANNEL_QR_FAILED')
        self.state.update(expires=time.time() + ttl, interval=interval, next=0)
        return {'image': image(url), 'expiresAt': int(self.state['expires'] * 1000), 'intervalMs': interval * 1000}

    async def poll(self):
        state = self.state
        if not state or time.time() >= state['expires']:
            return {'status': 'expired'}
        if time.time() < state['next']:
            return {'status': 'wait'}
        state['next'] = time.time() + state['interval']
        if self.platform == 'feishu':
            module = importlib.import_module('plugins.platforms.feishu.adapter')
            result = await asyncio.to_thread(module._post_registration, module._accounts_base_url(state['domain']), {'action': 'poll', 'device_code': state['device'], 'tp': 'ob_app'})
            user = result.get('user_info') or {}
            if user.get('tenant_brand') == 'lark':
                state['domain'] = 'lark'
            if result.get('client_id') and result.get('client_secret'):
                return {'status': 'confirmed', 'credentials': {'appId': result['client_id'], 'secret': result['client_secret'], 'domain': state['domain'], 'owner_id': user.get('open_id')}}
            if result.get('error') in ('access_denied', 'expired_token'):
                self.state = None
                return {'status': 'denied' if result['error'] == 'access_denied' else 'expired'}
        elif self.platform == 'qq':
            module = importlib.import_module('gateway.platforms.qqbot.onboard')
            status, app, encrypted, owner = await asyncio.to_thread(module._poll_bind_result, state['task'])
            if status == module.BindStatus.COMPLETED:
                return {'status': 'confirmed', 'credentials': {'appId': app, 'secret': module.decrypt_secret(encrypted, state['key']), 'owner_id': owner}}
            if status == module.BindStatus.EXPIRED:
                self.state = None
                return {'status': 'expired'}
        else:
            module = importlib.import_module('gateway.platforms.weixin')
            async with aiohttp.ClientSession() as client:
                result = await module._api_get(client, base_url=module.ILINK_BASE_URL, endpoint=module.EP_GET_QR_STATUS + '?qrcode=' + quote(state['value']), timeout_ms=10000)
            if result.get('status') == 'confirmed':
                return {'status': 'confirmed', 'credentials': {'account_id': str(result.get('ilink_bot_id') or ''), 'owner_id': str(result.get('ilink_user_id') or ''), 'token': str(result.get('bot_token') or ''), 'base_url': str(result.get('baseurl') or module.ILINK_BASE_URL)}}
            return {'status': result.get('status', 'wait')}
        return {'status': 'wait'}
