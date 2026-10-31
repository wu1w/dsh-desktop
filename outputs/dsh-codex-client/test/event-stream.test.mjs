import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setTimeout as delay, setImmediate as nextTick } from 'node:timers/promises';
import { JsonEventParser, readEventStream } from '../src/lib/event-stream.js';
import { eventStream, initCapability } from '../src/api.js';

const encode = value => new TextEncoder().encode(value);
const sse = response => { response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' }); response.flushHeaders(); };
async function server(handler, work) {
  const sockets = new Set(), timers = new Set();
  const later = (callback, milliseconds) => { const timer = setTimeout(() => { timers.delete(timer); callback(); }, milliseconds); timers.add(timer); return timer; };
  const host = http.createServer((request, response) => { Promise.resolve(handler(request, response, later)).catch(error => response.destroy(error)); });
  host.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise(resolve => host.listen(0, '127.0.0.1', resolve));
  try { return await work(`http://127.0.0.1:${host.address().port}`); }
  finally { for (const timer of timers) clearTimeout(timer); for (const socket of sockets) socket.destroy(); await new Promise(resolve => host.close(resolve)); }
}
function observeFetch(url, state) {
  return async signal => {
    state.signal = signal;
    const response = await fetch(url, { signal });
    state.response = response;
    if (response.body) {
      const getReader = response.body.getReader.bind(response.body);
      response.body.getReader = () => {
        const reader = getReader(); state.reader = reader;
        return {
          read: () => reader.read(),
          cancel: (...args) => { state.cancelled = (state.cancelled ?? 0) + 1; return reader.cancel(...args); },
          releaseLock: () => { state.released = (state.released ?? 0) + 1; return reader.releaseLock(); },
        };
      };
    }
    return response;
  };
}
function cleaned(state) { assert.equal(state.cancelled, 1); assert.equal(state.released, 1); assert.equal(state.response.body.locked, false); assert.equal(state.signal.aborted, true); }

test('real HTTP byte fragmentation parses UTF-8, CRLF, comments and multiline JSON only at complete boundaries', async () => {
  const events = [], state = {};
  await server(async (_, response) => {
    sse(response);
    const bytes = encode('\uFEFF: connected\r\nid: 19\r\nevent: ignored\r\ndata: {\r\ndata: "text":"中文😀",\r\ndata: "n":2\r\ndata: }\r\n\r\n');
    for (const byte of bytes) { response.write(Uint8Array.of(byte)); await nextTick(); }
    response.end('data: {"unfinished":true}\n');
  }, async origin => { await readEventStream(observeFetch(origin, state), value => events.push(value), undefined, { idleTimeoutMs: 1000 }); });
  assert.deepEqual(events, [{ text: '中文😀', n: 2 }]); cleaned(state);
});

test('parser supports LF and bare CR, preserves later BOMs, flushes invalid UTF-8 and discards unterminated events', () => {
  const values = [], parser = new JsonEventParser(value => values.push(value));
  parser.push(encode(': heartbeat\r\rdata:{"one":1}\r\rdata: {"two":2}\n\n'));
  parser.push(Uint8Array.from([...encode('data: {"text":"'), 0xf0, ...encode('"}\n\n')]));
  parser.push(encode('data: {"unfinished":"')); parser.push(Uint8Array.of(0xf0)); parser.finish();
  assert.deepEqual(values, [{ one: 1 }, { two: 2 }, { text: '\uFFFD' }]);
  const laterBOM = new JsonEventParser(() => {});
  assert.throws(() => laterBOM.push(encode(': first\n\ndata: \uFEFF{}\n\n')), { code: 'EVENTS_PROTOCOL' });
});

test('comment heartbeat bytes keep a real stream alive beyond the injected idle window', async () => {
  const state = {}, values = [];
  await server((_, response, later) => {
    sse(response);
    for (let index = 1; index <= 8; index++) later(() => response.write(': heartbeat\n\n'), index * 15);
    later(() => response.end('data: {"alive":true}\n\n'), 140);
  }, async origin => { await readEventStream(observeFetch(origin, state), value => values.push(value), undefined, { idleTimeoutMs: 60 }); });
  assert.deepEqual(values, [{ alive: true }]); cleaned(state);
});

test('headers blackhole times out without waiting for fetch and cancels its own signal only', async () => {
  const caller = new AbortController(), state = {};
  await server(() => {}, async origin => {
    await assert.rejects(readEventStream(observeFetch(origin, state), () => {}, caller.signal, { idleTimeoutMs: 40 }), { code: 'EVENTS_IDLE_TIMEOUT' });
  });
  assert.equal(state.signal.aborted, true); assert.equal(caller.signal.aborted, false); assert.equal(state.reader, undefined);
});

test('body blackhole idle timeout cancels and releases the real reader', async () => {
  const state = {};
  await server((_, response) => { sse(response); response.write(': connected\n\n'); }, async origin => {
    await assert.rejects(readEventStream(observeFetch(origin, state), () => {}, undefined, { idleTimeoutMs: 40 }), { code: 'EVENTS_IDLE_TIMEOUT' });
  });
  cleaned(state);
});

test('caller abort interrupts a pending real read and pre-abort sends no request', async () => {
  const state = {}, caller = new AbortController(); let requests = 0;
  await server((_, response, later) => { requests++; sse(response); later(() => caller.abort(), 20); }, async origin => {
    await assert.rejects(readEventStream(observeFetch(origin, state), () => {}, caller.signal, { idleTimeoutMs: 1000 }), { code: 'EVENTS_ABORTED' });
    const before = requests;
    await assert.rejects(readEventStream(observeFetch(origin, {}), () => {}, caller.signal), { code: 'EVENTS_ABORTED' });
    assert.equal(requests, before);
  });
  cleaned(state);
});

test('abrupt real socket loss surfaces failure after completed events and cleans the reader', async () => {
  const state = {}, values = [];
  await server((_, response, later) => { sse(response); response.write('data: {"n":1}\n\n'); later(() => response.destroy(), 30); }, async origin => {
    await assert.rejects(readEventStream(observeFetch(origin, state), value => values.push(value), undefined, { idleTimeoutMs: 1000 }));
  });
  assert.deepEqual(values, [{ n: 1 }]); cleaned(state);
});

test('listener throws propagate unchanged and stop further dispatch; asynchronous listener failures also end the stream', async () => {
  const failure = new Error('listener sentinel'), state = {}; let calls = 0;
  await server((_, response) => { sse(response); response.write('data: {}\n\ndata: {}\n\n'); }, async origin => {
    await assert.rejects(readEventStream(observeFetch(origin, state), () => { calls++; throw failure; }), error => error === failure);
  });
  assert.equal(calls, 1); cleaned(state);
  const asyncState = {};
  await server((_, response) => { sse(response); response.write('data: {}\n\n'); }, async origin => {
    await assert.rejects(readEventStream(observeFetch(origin, asyncState), () => Promise.reject(failure)), error => error === failure);
  });
  cleaned(asyncState);
});

test('message and unterminated-buffer caps fail explicitly; a session-sized message fits the default', () => {
  const oversized = new JsonEventParser(() => {}, { maxMessageBytes: 128 });
  assert.throws(() => oversized.push(encode('data: ' + 'x'.repeat(129))), { code: 'EVENTS_MESSAGE_LIMIT' });
  const multiple = new JsonEventParser(() => {}, { maxMessageBytes: 128 });
  assert.throws(() => multiple.push(encode('data: "' + 'x'.repeat(50) + '"\ndata: "' + 'x'.repeat(70) + '"\n\n')), { code: 'EVENTS_MESSAGE_LIMIT' });
  const values = [], parser = new JsonEventParser(value => values.push(value));
  const content = '中'.repeat(400000), bytes = encode(`data: ${JSON.stringify({ content })}\n\n`);
  for (let offset = 0; offset < bytes.length; offset += 997) parser.push(bytes.subarray(offset, offset + 997));
  parser.finish(); assert.equal(values[0].content, content);
});

test('an async listener rejection after HTTP EOF still rejects the transport; abort inside a callback stops the same packet', async () => {
  const failure = new Error('late listener failure'), state = {};
  await server((_, response) => { sse(response); response.end('data: {}\n\n'); }, async origin => {
    await assert.rejects(readEventStream(observeFetch(origin, state), () => delay(20).then(() => { throw failure; })), error => error === failure);
  });
  cleaned(state);
  const controller = new AbortController(), aborted = {}; let callbacks = 0;
  await server((_, response) => { sse(response); response.end('data: {}\n\ndata: {}\n\n'); }, async origin => {
    await assert.rejects(readEventStream(observeFetch(origin, aborted), () => { callbacks++; controller.abort(); }, controller.signal), { code: 'EVENTS_ABORTED' });
  });
  assert.equal(callbacks, 1); cleaned(aborted);
});

test('normal EOF and protocol failure clear their watchdog and detach the caller abort listener', async () => {
  for (const data of ['data: {}\n\n', 'data: invalid\n\n']) {
    const controller = new AbortController(); let attached = 0, removed = 0;
    const originalAdd = controller.signal.addEventListener.bind(controller.signal), originalRemove = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.addEventListener = (...args) => { attached++; return originalAdd(...args); };
    controller.signal.removeEventListener = (...args) => { removed++; return originalRemove(...args); };
    const state = {};
    await server((_, response) => { sse(response); response.end(data); }, async origin => {
      const pending = readEventStream(observeFetch(origin, state), () => {}, controller.signal, { idleTimeoutMs: 30 });
      if (data.includes('invalid')) await assert.rejects(pending, { code: 'EVENTS_PROTOCOL' }); else await pending;
      assert.equal(attached, 1); assert.equal(removed, 1); controller.abort();
      await delay(40);
    });
    cleaned(state);
  }
});

test('invalid JSON, MIME and HTTP status fail explicitly and clean real readers', async () => {
  for (const variant of ['json', 'mime', 'http', 'limit']) {
    const state = {};
    await server((_, response) => {
      if (variant === 'http') { response.writeHead(503); response.end('unavailable'); }
      else if (variant === 'mime') { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<html>'); }
      else { sse(response); response.write(variant === 'limit' ? 'data: ' + 'x'.repeat(200) : 'data: {invalid}\n\n'); }
    }, async origin => {
      const code = { json: 'EVENTS_PROTOCOL', mime: 'EVENTS_CONTENT_TYPE', http: 'EVENTS_503', limit: 'EVENTS_MESSAGE_LIMIT' }[variant];
      await assert.rejects(readEventStream(observeFetch(origin, state), () => {}, undefined, { maxMessageBytes: 128 }), { code });
    });
    cleaned(state);
  }
});

test('onOpen runs once after validated headers without awaiting its Promise; rejection remains observable', async () => {
  let opened = 0; const values = [], state = {};
  await server((_, response) => { sse(response); response.end('data: {"ready":true}\n\n'); }, async origin => {
    await readEventStream(observeFetch(origin, state), value => values.push(value), undefined, { onOpen() { opened++; return new Promise(() => {}); } });
  });
  assert.equal(opened, 1); assert.deepEqual(values, [{ ready: true }]); cleaned(state);
  const failure = new Error('open sentinel'), rejected = {};
  await server((_, response) => { sse(response); }, async origin => {
    await assert.rejects(readEventStream(observeFetch(origin, rejected), () => {}, undefined, { onOpen: () => Promise.reject(failure) }), error => error === failure);
  });
  cleaned(rejected);
});

test('late fetch headers after cancellation are cancelled without acquiring a reader', async () => {
  let cancelled = 0, gotReader = 0;
  const response = new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { 'content-type': 'text/event-stream' } });
  const original = response.body.getReader.bind(response.body);
  response.body.getReader = () => { gotReader++; return original(); };
  await assert.rejects(readEventStream(() => delay(50).then(() => response), () => {}, undefined, { idleTimeoutMs: 10 }), { code: 'EVENTS_IDLE_TIMEOUT' });
  await delay(65); assert.equal(cancelled, 1); assert.equal(gotReader, 0);
});

test('bootstrap is bounded and failed, aborted or oversized handshakes preserve the last valid capability', async () => {
  const originalFetch = globalThis.fetch; let variant = 'good', received, fetchOptions;
  await server((request, response, later) => {
    if (request.url === '/api/events') { received = request.headers['x-dsh-capability']; sse(response); response.end('data: {"ok":true}\n\n'); return; }
    if (variant === 'headers') return;
    response.writeHead(200, { 'content-type': 'application/json' }); response.flushHeaders();
    if (variant === 'body') return;
    if (variant === 'bad') response.end('{bad}');
    else if (variant === 'schema') response.end('{"capability":false}');
    else if (variant === 'utf8') response.end(Buffer.from([0xff]));
    else if (variant === 'large') response.end(' '.repeat(16 * 1024 * 1024 + 1));
    else if (variant === 'slow') later(() => response.end('{"capability":"late"}'), 100);
    else response.end('{"capability":"saved-capability","state":{"ok":true}}');
  }, async origin => {
    globalThis.fetch = (url, options) => { fetchOptions = options; return originalFetch(origin + url, options); };
    try {
      assert.equal((await initCapability()).capability, 'saved-capability'); assert.equal(fetchOptions.credentials, 'same-origin');
      for (const failed of ['bad', 'schema', 'utf8', 'large', 'headers', 'body']) {
        variant = failed;
        const code = ['headers', 'body'].includes(failed) ? 'BOOTSTRAP_TIMEOUT' : failed === 'large' ? 'BOOTSTRAP_RESPONSE_LIMIT' : 'BOOTSTRAP_PROTOCOL';
        await assert.rejects(initCapability({ timeoutMs: 60 }), { code });
        await eventStream(() => {}); assert.equal(received, 'saved-capability');
      }
      variant = 'slow'; const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), 15);
      try { await assert.rejects(initCapability({ signal: abort.signal, timeoutMs: 1000 }), { code: 'BOOTSTRAP_ABORTED' }); }
      finally { clearTimeout(timer); }
      await eventStream(() => {}); assert.equal(received, 'saved-capability');
    } finally { globalThis.fetch = originalFetch; }
  });
});
