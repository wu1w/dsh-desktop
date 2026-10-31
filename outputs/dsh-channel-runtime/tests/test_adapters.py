import asyncio
import importlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from types import SimpleNamespace as NS
from unittest.mock import AsyncMock, patch

ROOT = Path(os.environ.get('DSH_CHANNEL_TEST_ROOT', str(Path(__file__).resolve().parents[1])))
sys.path.insert(0, str(ROOT))
import bridge
from gateway.platforms.base import SendResult

class AdapterTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.home = tempfile.TemporaryDirectory()
        os.environ['DSH_CHANNEL_HOME'] = self.home.name
        self.bridges = []
        self.events = []

    def configured(self, platform):
        b = bridge.Bridge()
        b.configure({'platform': platform, 'extra': {'app_id':'app-fixture','app_secret':'secret-fixture','client_secret':'secret-fixture','client_id':'app-fixture','bot_id':'app-fixture','secret':'secret-fixture','allowed_users':['user'],'allowed_chats':['group'],'require_mention':True,'allow_from':['user'],'group_allow_from':['group'], 'connection_mode':'websocket','send_chunk_retries':0}})
        b.adapter.set_message_handler(self.capture)
        self.bridges.append(b)
        return b

    async def capture(self, event):
        self.events.append(event)
        return True

    async def asyncTearDown(self):
        for b in self.bridges:
            if b.platform=='weixin': b.adapter._poll_session=None
            await b.close()
        self.home.cleanup()

    async def test_feishu_real_sdk_connect_contract_and_text(self):
        b=self.configured('feishu');a=b.adapter
        with patch.object(a,'_connect_with_retry',AsyncMock()):
            self.assertTrue(await a.connect())
        self.assertIsNotNone(a._build_event_handler())
        message=NS(message_id='f-1',chat_id='chat',chat_type='p2p',message_type='text',content=json.dumps({'text':'你好'}),mentions=[])
        event=NS(event=NS(message=message,sender=NS(sender_id=NS(open_id='user',user_id=None,union_id=None),sender_type='user')))
        a._on_message_event(event)
        self.assertTrue(await b.ingress.drain_once(a))
        self.assertEqual(self.events[0].text,'你好')
        self.assertEqual(self.events[0].source.user_id,'user')

    async def test_qq_real_payload_journal_replay_and_acl(self):
        b=self.configured('qq');a=b.adapter
        payload={'op':0,'t':'C2C_MESSAGE_CREATE','s':123,'d':{'id':'q-1','content':'测试','author':{'user_openid':'user'}}}
        a._dispatch_payload(payload)
        self.assertEqual(self.events,[])
        self.assertTrue(await b.ingress.drain_once(a))
        self.assertEqual(self.events[0].text,'测试')
        self.assertEqual(a._chat_type_map['user'],'c2c')
        payload['d']['author']['user_openid']='stranger';payload['d']['id']='q-2'
        a._dispatch_payload(payload);await b.ingress.drain_once(a)
        self.assertEqual(len(self.events),1)

    async def test_qq_unknown_send_is_not_retried(self):
        b=self.configured('qq');a=b.adapter;a._running=True;a._ws=NS(closed=False,close=AsyncMock())
        sender=AsyncMock(side_effect=TimeoutError('delivered but ack lost'))
        with patch.object(a,'_ensure_connected',AsyncMock(return_value=True)),patch.object(a,'_text_sender',return_value=sender):
            result=await b.call('send',{'chatId':'user','text':'hello','chatType':'c2c'})
        self.assertEqual(result['delivery'],'unknown');self.assertEqual(sender.await_count,1)

    async def test_feishu_unknown_send_is_not_retried(self):
        b=self.configured('feishu');a=b.adapter;a._running=True;a._client=NS()
        sender=AsyncMock(side_effect=TimeoutError('ack lost'))
        with patch.object(a,'_send_raw_message',sender):
            result=await b.call('send',{'chatId':'chat','text':'hello'})
        self.assertEqual(result['delivery'],'unknown');self.assertEqual(sender.await_count,1)
        a._client=None

    async def test_weixin_durable_cursor_boundary_and_repeated_text(self):
        module=importlib.import_module('gateway.platforms.weixin')
        message={'from_user_id':'user','message_id':'w-1','item_list':[{'type':1,'text_item':{'text':'继续'}}]}
        async def updates(*args,**kwargs): return {'msgs':[message],'get_updates_buf':'next'}
        with patch.object(module,'_get_updates',updates):
            b=self.configured('weixin');a=b.adapter;a._poll_session=NS()
            response=await module._get_updates(None)
            self.assertEqual(response['msgs'],[]);self.assertEqual(len(self.events),1)
            message['message_id']='w-2';await module._get_updates(None)
            self.assertEqual(len(self.events),2,'same text with a new ID must remain a distinct message')
            async def reject(event): return False
            a.set_message_handler(reject);message['message_id']='w-3'
            with self.assertRaises(RuntimeError):await module._get_updates(None)

    async def test_journal_survives_failure_and_restart(self):
        from ingress import Ingress
        b=self.configured('qq');a=b.adapter
        payload={'op':0,'t':'C2C_MESSAGE_CREATE','s':1,'d':{'id':'q-1','content':'test','author':{'user_openid':'user'}}}
        b.ingress.put(payload)
        async def reject(event):return False
        a.set_message_handler(reject)
        with self.assertRaises(RuntimeError):await b.ingress.drain_once(a)
        await b.ingress.close();b.ingress=Ingress('qq');a.set_message_handler(self.capture)
        self.assertTrue(await b.ingress.drain_once(a));self.assertFalse(await b.ingress.drain_once(a))
        self.assertEqual(len(self.events),1)

    async def test_offline_send_explicitly_not_sent(self):
        for platform in ['qq','feishu','weixin','dingtalk','wecom']:
            b=self.configured(platform)
            self.assertEqual((await b.call('send',{'chatId':'user','text':'x'}))['delivery'],'not_sent')

    async def test_media_cache_restricts_paths_size_and_permissions(self):
        from gateway.platforms.base import cache_document_from_bytes_async
        value=await cache_document_from_bytes_async(b'text','../../secrets.txt')
        self.assertEqual(Path(value).parent,Path(self.home.name)/'media')
        self.assertEqual(os.stat(value).st_mode&0o777,0o600)
        with self.assertRaises(RuntimeError):await cache_document_from_bytes_async(b'a'*(10*1024*1024+1),'a.txt')


    async def test_qq_connection_opens_real_http_client_and_releases_resources(self):
        b=self.configured('qq');a=b.adapter
        async def open_ws(**kwargs):a._ws=NS(closed=False,close=AsyncMock())
        async def wait_loop():await asyncio.Event().wait()
        with patch.object(a,'_open_gateway_ws',open_ws),patch.object(a,'_listen_loop',wait_loop),patch.object(a,'_heartbeat_loop',wait_loop):
            self.assertTrue(await a.connect())
            self.assertIsNotNone(a._http_client)
            await a.disconnect()
            self.assertFalse(a.is_connected)

    async def test_weixin_connection_opens_and_closes_its_own_sessions(self):
        b=self.configured('weixin');a=b.adapter;a._token='fixture-token';a._account_id='fixture-account'
        async def wait_loop():await asyncio.Event().wait()
        with patch.object(a,'_poll_loop',wait_loop):
            self.assertTrue(await a.connect())
            poll,send=a._poll_session,a._send_session
            await a.disconnect()
            self.assertTrue(poll.closed);self.assertTrue(send.closed)

    async def test_weixin_qr_transfers_owner_over_private_pipe(self):
        b=self.configured('weixin');module=importlib.import_module('gateway.platforms.weixin')
        with patch.object(module,'_fetch_qr',AsyncMock(return_value=('qr-id','https://example.test/scan'))):
            result=await b.call('qr/start',{})
        self.assertTrue(result['image'].startswith('data:image/svg+xml;base64,'))
        with patch.object(module,'_api_get',AsyncMock(return_value={'status':'confirmed','ilink_bot_id':'bot','bot_token':'secret','ilink_user_id':'owner'})):
            result=await b.call('qr/poll',{})
        self.assertEqual(result['credentials']['owner_id'],'owner');self.assertIsNone(b.qr)

    async def test_weixin_unknown_send_does_not_retry(self):
        module=importlib.import_module('gateway.platforms.weixin')
        b=self.configured('weixin');a=b.adapter
        sender=AsyncMock(side_effect=TimeoutError('ack lost'))
        with patch.object(module,'_send_message',sender):
            with self.assertRaises(TimeoutError):
                await a._send_text_chunk(chat_id='user',chunk='hello',context_token=None,client_id='stable-id')
        self.assertEqual(sender.await_count,1)


    async def test_poison_media_is_quarantined_without_blocking_following_messages(self):
        b=self.configured('qq');a=b.adapter
        for identifier in ['bad','good']:
            b.ingress.put({'op':0,'t':'C2C_MESSAGE_CREATE','d':{'id':identifier,'content':'hello','author':{'user_openid':'user'}}})
        original=a._on_message
        async def process(kind,data):
            if data['id']=='bad':raise RuntimeError('CHANNEL_ATTACHMENT_LIMIT')
            await original(kind,data)
        a._on_message=process
        self.assertTrue(await b.ingress.drain_once(a));self.assertEqual(b.ingress.rejected_count(),1)
        self.assertTrue(await b.ingress.drain_once(a));self.assertEqual(len(self.events),1)


    async def test_weixin_real_send_preserves_text_without_implicit_file_upload(self):
        b=self.configured('weixin');a=b.adapter;a._running=True;a._token='fixture';a._send_session=NS(closed=False,close=AsyncMock())
        module=importlib.import_module('gateway.platforms.weixin');sender=AsyncMock(return_value={'ret':0,'errcode':0})
        text='结果：MEDIA:/private/secret.txt 只是文本'
        with patch.object(module,'_send_message',sender):
            result=await b.call('send',{'chatId':'user','text':text})
        self.assertTrue(result['success']);self.assertEqual(sender.await_count,1);self.assertIn('/private/secret.txt',sender.call_args.kwargs['text'])


    async def test_weixin_expired_authorization_requests_qr_instead_of_false_online_status(self):
        module=importlib.import_module('gateway.platforms.weixin')
        with patch.object(module,'_get_updates',AsyncMock(return_value={'ret':-14,'errcode':-14})):
            b=self.configured('weixin');b.adapter._running=True
            with self.assertRaisesRegex(RuntimeError,'CHANNEL_QR_REQUIRED'):await module._get_updates(None)
            status=await b.call('status',{})
            self.assertFalse(status['connected']);self.assertEqual(status['fatalCode'],'CHANNEL_QR_REQUIRED')

    def dingtalk_message(self, **patch):
        import time
        return {'msgId':'dt-1','conversationId':'group','conversationType':'2','senderId':'user','senderStaffId':'staff','senderNick':'User','conversationTitle':'Team','isInAtList':True,'msgtype':'text','text':{'content':'hello'},'sessionWebhook':'https://oapi.dingtalk.com/robot/send?access_token=fake','sessionWebhookExpiredTime':int(time.time()*1000)+3600000,**patch}

    def wecom_message(self, **patch):
        return {'cmd':'aibot_msg_callback','headers':{'req_id':'request-1'},'body':{'msgid':'wc-1','chatid':'group','chattype':'group','from':{'userid':'user'},'msgtype':'text','text':{'content':'@Bot hello'},**patch}}

    async def test_dingtalk_sdk_ack_after_journal_commit_and_restart_replay(self):
        from ingress import Ingress
        b=self.configured('dingtalk');a=b.adapter
        module=importlib.import_module('plugins.platforms.dingtalk.adapter')
        handler=module._IncomingHandler(a)
        status,_=await handler.process(NS(data=self.dingtalk_message()))
        self.assertEqual(status,200);self.assertEqual(self.events,[])
        await b.ingress.close();b.ingress=Ingress('dingtalk')
        # The journal held by the configured boundary is reopened on a new process.
        await b.close();self.bridges.remove(b)
        b=self.configured('dingtalk');a=b.adapter
        self.assertTrue(await b.ingress.drain_once(a))
        self.assertEqual(self.events[0].text,'hello')
        self.assertEqual(self.events[0].source.user_id_alt,'staff')
        self.assertIn('expires',b.ingress.route('group'))
        handler=module._IncomingHandler(a)
        with patch.object(b.ingress,'put',side_effect=RuntimeError('disk full')):
            self.assertEqual((await handler.process(NS(data=self.dingtalk_message())))[0],500)

    async def test_dingtalk_gates_mentions_users_and_groups(self):
        b=self.configured('dingtalk');a=b.adapter
        for patcher in [{'isInAtList':False},{'senderId':'outsider','senderStaffId':'unknown'},{'conversationId':'other'}]:
            b.ingress.put(self.dingtalk_message(**patcher));await b.ingress.drain_once(a)
        self.assertEqual(self.events,[])
        self.assertIsNone(b.ingress.route('other'))

    async def test_dingtalk_restart_send_checks_platform_errcode_and_expiry(self):
        import httpx,time
        b=self.configured('dingtalk');a=b.adapter;a._running=True;a._dsh_ready=True
        b.ingress.route('group',{'url':'https://oapi.dingtalk.com/robot/send?access_token=fake','expires':int(time.time()*1000)+60000})
        calls=[]
        def response(request):
            calls.append(json.loads(request.content));return httpx.Response(200,json={'errcode':400,'errmsg':'rejected'})
        a._http_client=httpx.AsyncClient(transport=httpx.MockTransport(response))
        result=await b.call('send',{'chatId':'group','text':'hello'})
        self.assertEqual(result['delivery'],'unknown');self.assertEqual(len(calls),1)
        self.assertEqual(calls[0]['markdown']['title'],'DSH')
        b.ingress.route('group',{'url':'https://oapi.dingtalk.com/robot/send?access_token=fake','expires':1})
        result=await b.call('send',{'chatId':'group','text':'hello'})
        self.assertEqual(result['delivery'],'not_sent');self.assertEqual(result['code'],'CHANNEL_REPLY_WINDOW');self.assertEqual(len(calls),1)

    async def test_wecom_journal_no_early_dedup_and_durable_reply_route(self):
        b=self.configured('wecom');a=b.adapter
        await a._dispatch_payload(self.wecom_message())
        self.assertEqual(self.events,[])
        await b.ingress.drain_once(a)
        self.assertEqual(self.events[0].text,'hello')
        self.assertEqual(b.ingress.route('group'),{'reqId':'request-1','group':True})
        await a._dispatch_payload(self.wecom_message(msgid='wc-2'))
        await b.ingress.drain_once(a);self.assertEqual(len(self.events),2)
        await a._dispatch_payload(self.wecom_message(msgid='wc-3',**{'from':{'userid':'stranger'}}))
        await b.ingress.drain_once(a);self.assertEqual(len(self.events),2)

    async def test_wecom_timeout_never_falls_back_or_sends_later(self):
        b=self.configured('wecom');a=b.adapter;a._running=True;a._ws=NS(closed=False,close=AsyncMock())
        b.ingress.route('group',{'reqId':'request-1','group':True})
        with patch.object(a,'_send_reply_request',AsyncMock(side_effect=TimeoutError('ack lost'))) as passive,patch.object(a,'_send_proactive_markdown',AsyncMock()) as proactive:
            result=await b.call('send',{'chatId':'group','text':'answer'})
        self.assertEqual(result['delivery'],'unknown');self.assertEqual(passive.await_count,1);proactive.assert_not_called()
        self.assertEqual(a._chat_workers,{})

    async def test_wecom_rate_limit_and_expired_group_route_remain_pending(self):
        b=self.configured('wecom');a=b.adapter;a._running=True;a._ws=NS(closed=False,close=AsyncMock())
        b.ingress.route('group',{'reqId':'old','group':True})
        with patch.object(a,'_send_reply_request',AsyncMock(return_value={'errcode':846604})) as sender:
            result=await b.call('send',{'chatId':'group','text':'answer'})
            self.assertEqual(result['delivery'],'not_sent')
            result=await b.call('send',{'chatId':'group','text':'answer'})
            self.assertEqual(sender.await_count,1)
        with patch.object(a,'_bucket_try_consume',return_value=60):
            result=await b.call('send',{'chatId':'group','text':'answer'})
            self.assertEqual(result['code'],'CHANNEL_RATE_LIMIT')
        await a._dispatch_payload(self.wecom_message(msgid='refresh'))
        await b.ingress.drain_once(a)
        with patch.object(a,'_send_reply_request',AsyncMock(return_value={'errcode':0,'headers':{'req_id':'new'}})):
            self.assertEqual((await b.call('send',{'chatId':'group','text':'answer'}))['delivery'],'delivered')

    async def test_wecom_kicked_connection_requires_manual_reconnect(self):
        b=self.configured('wecom');a=b.adapter
        await a._dispatch_payload({'cmd':'aibot_event_callback','body':{'event_type':'disconnected_event'}})
        self.assertEqual((await b.call('status',{}))['fatalCode'],'CHANNEL_CONNECTION_CONFLICT')

    async def test_wecom_real_websocket_subscribe_receive_send_and_cleanup(self):
        from aiohttp import web
        seen=[]
        async def socket(request):
            ws=web.WebSocketResponse();await ws.prepare(request)
            auth=await ws.receive_json();seen.append(auth)
            await ws.send_json({'headers':auth['headers'],'errcode':0})
            await ws.send_json(self.wecom_message())
            async for message in ws:
                payload=json.loads(message.data);seen.append(payload)
                await ws.send_json({'headers':payload['headers'],'errcode':0})
            return ws
        app=web.Application();app.router.add_get('/ws',socket);runner=web.AppRunner(app);await runner.setup()
        site=web.TCPSite(runner,'127.0.0.1',0);await site.start()
        try:
            b=self.configured('wecom');a=b.adapter;a._ws_url=f'http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}/ws'
            self.assertTrue((await b.call('connect',{}))['connected'])
            for _ in range(100):
                if self.events:break
                await asyncio.sleep(.02)
            self.assertEqual(len(self.events),1)
            result=await b.call('send',{'chatId':'group','text':'real socket reply'})
            self.assertEqual(result['delivery'],'delivered')
            self.assertEqual(seen[0]['body']['bot_id'],'app-fixture')
            self.assertEqual(seen[-1]['body']['markdown']['content'],'real socket reply')
            await a._ws.close();await asyncio.wait_for(a._listen_task,1)
            self.assertEqual((await b.call('status',{}))['fatalCode'],'CHANNEL_CONNECTION_FAILED')
            await b.close();self.assertIsNone(a._session);self.assertIsNone(a._http_client)
        finally:await runner.cleanup()

    async def test_dingtalk_real_websocket_sdk_ack_and_clean_disconnect(self):
        from aiohttp import web
        import httpx,websockets
        received=[]
        async def socket(request):
            ws=web.WebSocketResponse();await ws.prepare(request)
            await ws.send_json({'type':'CALLBACK','headers':{'topic':'/v1.0/im/bot/messages/get','messageId':'wire-1','contentType':'application/json'},'data':json.dumps(self.dingtalk_message())})
            async for message in ws:received.append(json.loads(message.data))
            return ws
        app=web.Application();app.router.add_get('/ws',socket);runner=web.AppRunner(app);await runner.setup();site=web.TCPSite(runner,'127.0.0.1',0);await site.start()
        original_client=httpx.AsyncClient;original_ws=websockets.connect
        def local_ws(*args,**kwargs):return original_ws(f'ws://127.0.0.1:{site._server.sockets[0].getsockname()[1]}/ws',**kwargs)
        def client(*args,**kwargs):return original_client(transport=httpx.MockTransport(lambda request:httpx.Response(200,json={'endpoint':'wss://test.dingtalk.com','ticket':'fake'})),**kwargs)
        try:
            b=self.configured('dingtalk');a=b.adapter
            with patch.object(httpx,'AsyncClient',client),patch.object(websockets,'connect',local_ws):
                self.assertTrue((await b.call('connect',{}))['connected'])
                for _ in range(100):
                    if received and self.events:break
                    await asyncio.sleep(.02)
                self.assertEqual(received[0]['code'],200);self.assertEqual(len(self.events),1)
                await a._stream_client.websocket.close();await asyncio.wait_for(a._stream_task,1)
                self.assertEqual((await b.call('status',{}))['fatalCode'],'CHANNEL_CONNECTION_FAILED')
                await b.close();self.assertIsNone(a._stream_client);self.assertIsNone(a._stream_task)
        finally:await runner.cleanup()

    async def test_enterprise_reply_route_survives_process_restart(self):
        b=self.configured('wecom');b.ingress.put(self.wecom_message());await b.ingress.drain_once(b.adapter);await b.close()
        b=self.configured('wecom');a=b.adapter;a._running=True;a._ws=NS(closed=False,close=AsyncMock())
        with patch.object(a,'_send_reply_request',AsyncMock(return_value={'errcode':0})) as sender:
            self.assertEqual((await b.call('send',{'chatId':'group','text':'saved reply'}))['delivery'],'delivered')
            self.assertEqual(sender.call_args.args[0],'request-1')

    async def test_wecom_oversize_media_quarantine_keeps_next_message_moving(self):
        b=self.configured('wecom');a=b.adapter
        bad=self.wecom_message(msgid='oversize',msgtype='file',file={'url':'https://cdn.example.test/file','filename':'x.txt'})
        with patch('enterprise.download',AsyncMock(side_effect=RuntimeError('CHANNEL_ATTACHMENT_LIMIT'))):
            b.ingress.put(bad);self.assertTrue(await b.ingress.drain_once(a))
        self.assertEqual(b.ingress.rejected_count(),1)
        b.ingress.put(self.wecom_message(msgid='next'));await b.ingress.drain_once(a)
        self.assertEqual(len(self.events),1);self.assertEqual(self.events[0].message_id,'next')

    async def test_dingtalk_attachment_uses_bounded_code_resolution_and_local_cache(self):
        import httpx
        b=self.configured('dingtalk');a=b.adapter
        def response(request):
            if request.url.path.endswith('accessToken'):return httpx.Response(200,json={'accessToken':'test-token'})
            self.assertEqual(request.headers['x-acs-dingtalk-access-token'],'test-token')
            self.assertEqual(json.loads(request.content)['downloadCode'],'opaque-code')
            return httpx.Response(200,json={'downloadUrl':'https://files.example.test/a.txt'})
        a._http_client=httpx.AsyncClient(transport=httpx.MockTransport(response))
        payload=self.dingtalk_message(msgtype='file',text={},content={'downloadCode':'opaque-code','fileName':'a.txt'})
        with patch('enterprise.download',AsyncMock(return_value=(b'attachment',{'content-type':'text/plain'}))):
            b.ingress.put(payload);await b.ingress.drain_once(a)
        self.assertEqual(len(self.events),1)
        event=self.events[0];self.assertEqual(event.media_types,['text/plain'])
        self.assertEqual(Path(event.media_urls[0]).read_bytes(),b'attachment')
        self.assertEqual(Path(event.media_urls[0]).parent,Path(self.home.name)/'media')

    async def test_wecom_closed_socket_returns_to_host_reconnect_without_busy_loop(self):
        b=self.configured('wecom');a=b.adapter;a._running=True;a._ws=NS(closed=True)
        with patch.object(a,'_read_events',AsyncMock(return_value=None)) as read:
            await asyncio.wait_for(a._listen_loop(),.5)
        self.assertEqual(read.await_count,1)
        health=await b.call('status',{})
        self.assertFalse(health['connected']);self.assertEqual(health['fatalCode'],'CHANNEL_CONNECTION_FAILED')


    async def test_feishu_qr_confirm_denied_and_expiry(self):
        from onboarding import Onboarding
        module=importlib.import_module('plugins.platforms.feishu.adapter')
        qr=Onboarding('feishu')
        with patch.object(module,'_init_registration'),patch.object(module,'_begin_registration',return_value={'device_code':'device','qr_url':'https://example.test/scan','interval':2,'expire_in':60}):
            result=await qr.start()
        self.assertTrue(result['image'].startswith('data:image/svg+xml;base64,'))
        with patch.object(module,'_post_registration',return_value={'client_id':'app','client_secret':'secret','user_info':{'open_id':'owner','tenant_brand':'lark'}}):
            result=await qr.poll()
        self.assertEqual(result['credentials'],{'appId':'app','secret':'secret','domain':'lark','owner_id':'owner'})
        qr.state['next']=0
        with patch.object(module,'_post_registration',return_value={'error':'access_denied'}):
            self.assertEqual(await qr.poll(),{'status':'denied'})
        self.assertEqual(await qr.poll(),{'status':'expired'})

    async def test_qq_qr_uses_upstream_aes_decryption(self):
        import base64
        from onboarding import Onboarding
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        module=importlib.import_module('gateway.platforms.qqbot.onboard')
        key=bytes(range(32));iv=bytes(range(12));encrypted=base64.b64encode(iv+AESGCM(key).encrypt(iv,b'fixture-secret',None)).decode()
        qr=Onboarding('qq')
        with patch.object(module,'_create_bind_task',return_value=('task',base64.b64encode(key).decode())):
            await qr.start()
        with patch.object(module,'_poll_bind_result',return_value=(module.BindStatus.COMPLETED,'app',encrypted,'owner')):
            result=await qr.poll()
        self.assertEqual(result['credentials'],{'appId':'app','secret':'fixture-secret','owner_id':'owner'})
        qr.state['next']=0
        with patch.object(module,'_poll_bind_result',return_value=(module.BindStatus.EXPIRED,None,None,None)):
            self.assertEqual(await qr.poll(),{'status':'expired'})

if __name__=='__main__':unittest.main()
