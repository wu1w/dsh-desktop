"""DSH-owned transport journal. A platform callback commits before returning.

The main event loop replays unacknowledged envelopes after a process restart.
Only DSH's durable inbox ACK removes an admitted message from this journal.
"""
import asyncio
import hashlib
import json
import os
import sqlite3
import threading
from types import SimpleNamespace
from hermes_constants import get_hermes_home

PERMANENT_ERRORS={'CHANNEL_ATTACHMENT_LIMIT','CHANNEL_UNSUPPORTED_ATTACHMENT','CHANNEL_UNSAFE_URL','CHANNEL_PROTOCOL_LIMIT'}

class Ingress:
    def __init__(self, platform):
        home = get_hermes_home()
        home.mkdir(parents=True, exist_ok=True, mode=0o700)
        file = home / 'transport.sqlite'
        for suffix in ('', '-wal', '-shm'):
            target = str(file) + suffix
            if os.path.lexists(target) and (os.path.islink(target) or os.stat(target).st_nlink != 1):
                raise RuntimeError('CHANNEL_STORAGE_UNSAFE')
        self.db = sqlite3.connect(file, check_same_thread=False)
        os.chmod(file, 0o600)
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.execute('CREATE TABLE IF NOT EXISTS queue(id TEXT PRIMARY KEY, payload TEXT NOT NULL)')
        self.db.execute('CREATE TABLE IF NOT EXISTS rejected(id TEXT PRIMARY KEY,payload TEXT NOT NULL,error TEXT NOT NULL)')
        self.db.execute('CREATE TABLE IF NOT EXISTS routes(chat TEXT PRIMARY KEY, payload TEXT NOT NULL, updated REAL NOT NULL)')
        self.db.commit()
        for suffix in ('-wal', '-shm'):
            if os.path.exists(str(file) + suffix):
                os.chmod(str(file) + suffix, 0o600)
        self.platform, self.lock = platform, threading.Lock()
        self.task = None

    def put(self, payload):
        data = json.dumps(payload, ensure_ascii=False, default=lambda obj: vars(obj))
        if len(data.encode()) > 2 * 1024 * 1024:
            raise RuntimeError('CHANNEL_PROTOCOL_LIMIT')
        key = hashlib.sha256(data.encode()).hexdigest()
        with self.lock:
            if self.db.execute('SELECT count(*) FROM queue').fetchone()[0] >= 2000:
                raise RuntimeError('CHANNEL_BACKPRESSURE')
            self.db.execute('INSERT OR IGNORE INTO queue VALUES(?,?)', (key, data))
            self.db.commit()

    def route(self, chat, value=None):
        import time
        with self.lock:
            if value is not None:
                self.db.execute('INSERT OR REPLACE INTO routes VALUES(?,?,?)', (chat,json.dumps(value),time.time()))
                self.db.execute('DELETE FROM routes WHERE chat IN (SELECT chat FROM routes ORDER BY updated DESC LIMIT -1 OFFSET 2000)')
                self.db.commit()
            row=self.db.execute('SELECT payload FROM routes WHERE chat=?',(chat,)).fetchone()
            return json.loads(row[0]) if row else None

    def rejected_count(self):
        with self.lock:
            return self.db.execute('SELECT count(*) FROM rejected').fetchone()[0]

    def quarantine(self, payload, error, identifier=None):
        data=json.dumps(payload,ensure_ascii=False,default=lambda obj:vars(obj))
        key=identifier or hashlib.sha256(data.encode()).hexdigest()
        with self.lock:
            if self.db.execute('SELECT count(*) FROM rejected').fetchone()[0]>=2000:
                raise RuntimeError('CHANNEL_BACKPRESSURE')
            self.db.execute('INSERT OR IGNORE INTO rejected VALUES(?,?,?)',(key,data,error))
            if identifier:self.db.execute('DELETE FROM queue WHERE id=?',(identifier,))
            self.db.commit()

    async def drain_once(self, adapter):
        with self.lock:
            row = self.db.execute('SELECT id,payload FROM queue ORDER BY rowid LIMIT 1').fetchone()
        if not row:
            return False
        try:
            if self.platform == 'feishu':
                event = json.loads(row[1], object_hook=lambda obj: SimpleNamespace(**obj))
                await adapter._handle_message_event_data(event)
            elif self.platform == 'dingtalk':
                from dingtalk_stream import ChatbotMessage
                value = json.loads(row[1])
                message = ChatbotMessage.from_dict(value)
                message.is_in_at_list = bool(value.get('isInAtList'))
                await adapter._on_message(message)
            elif self.platform == 'wecom':
                await adapter._on_message(json.loads(row[1]))
            else:
                value = json.loads(row[1])
                await adapter._on_message(value['t'], value['d'])
        except Exception as error:
            if str(error) not in PERMANENT_ERRORS:
                raise
            self.quarantine(json.loads(row[1]),str(error),row[0])
            return True
        with self.lock:
            self.db.execute('DELETE FROM queue WHERE id=?', (row[0],))
            self.db.commit()
        return True

    def start(self, adapter):
        async def pump():
            while True:
                try:
                    if not await self.drain_once(adapter):
                        await asyncio.sleep(.2)
                except asyncio.CancelledError:
                    raise
                except Exception:
                    adapter._set_fatal_error('journal', '', retryable=True)
                    return
        self.task = asyncio.create_task(pump())

    async def close(self):
        if self.task:
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)
        with self.lock:
            self.db.close()
