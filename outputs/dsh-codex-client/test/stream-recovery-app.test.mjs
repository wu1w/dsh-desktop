import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { transform } from 'esbuild';
import React from 'react';
import { HistoryController } from '../src/lib/history-controller.js';

// Instrument the actual App, following the existing session/queue race probe.
// No replica of loadTranscript or the reconnect effect is tested here.
const file = new URL('../src/main.jsx', import.meta.url), require = createRequire(file);
const raw = await readFile(file, 'utf8'), marker = '  function navigate(id, record = true) {';
assert.equal(raw.split(marker).length, 2);
const compiled = await transform(raw.replace(marker, '  captureProbe({loadTranscript,selectedRef,historyController,setHistorySnapshot,setQueueSnapshot,setEngineMismatch,setState,setError});\n' + marker) + '\nexport {App};', { loader: 'jsx', format: 'cjs' });
const project = { id: 'project-A', path: '/projects/A', name: 'A' };
const session = { id: 'session-A', projectId: project.id, title: 'A' };
const baseline = { id: 'baseline', type: 'agentMessage', text: 'Already visible' };
const stale = { items: [{ id: 'stale', type: 'agentMessage', text: 'Late disconnected response' }], running: true, engineMismatch: true, queue: [{ id: 'stale-queue', text: 'Do not restore' }] };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const turn = () => new Promise(resolve => setImmediate(resolve));

function appFixture({ api, initCapability, eventStream } = {}) {
  const pending = deferred(), history = new HistoryController(); history.select(session.id);
  history.completeInitial(history.beginInitial(), { items: [baseline], running: false });
  const state = { projects: [project], sessions: [session], engine: { state: 'ready', capabilities: {} }, selectedEngine: 'codex' };
  const overrides = new Map([[0, 'en'], [2, state], [3, true], [4, session.id], [6, history], [7, history.snapshot()], [8, { sessionId: session.id, items: [] }]]);
  const effects = [], requests = [], events = []; let index = 0, probe;
  const react = { ...React, useEffect: effect => effects.push(effect), useLayoutEffect() {}, useRef: current => ({ current }), useState(initial) {
    const key = index++, setter = value => setter.calls.push(value); setter.calls = [];
    return [overrides.has(key) ? overrides.get(key) : typeof initial === 'function' ? initial() : initial, setter];
  } };
  const dependencies = id => id === 'react' ? react : id.endsWith('.css') ? {} : id === './api.js' ? {
    api(route, body, method, options) { requests.push({ route, body, method, signal: options?.signal }); return api ? api(route, body, method, options) : pending.promise; },
    initCapability: initCapability ?? (() => Promise.resolve({ state })), eventStream: eventStream ?? (() => new Promise(() => {})),
  } : id.endsWith('.jsx') ? new Proxy({}, { get: (_, name) => name === '__esModule' ? true : () => null }) : require(id);
  const module = { exports: {} }, storage = { getItem: () => null, setItem() {}, removeItem() {} };
  new Function('require', 'module', 'exports', 'localStorage', 'window', 'document', 'captureProbe', compiled.code)(dependencies, module, module.exports, storage, { dispatchEvent: event => { events.push(event); return true; } }, {}, value => { probe = value; });
  module.exports.App({ registerCleanup() {} }); assert.ok(probe); probe.selectedRef.current = session.id;
  return { ...probe, pending, effects, requests, events, initialState: state };
}

for (const timeout of [false, true]) {
  test(`actual App discards a late successful transcript after ${timeout ? 'recovery deadline' : 'disconnect abort'} without changing history, queue or mismatch`, async () => {
    const app = appFixture(), abort = new AbortController();
    const operation = app.loadTranscript(session.id, { signal: abort.signal });
    assert.equal(app.historyController.snapshot().loadingInitial, true);
    const queueCalls = app.setQueueSnapshot.calls.length, mismatchCalls = app.setEngineMismatch.calls.length;
    abort.abort(timeout ? Object.assign(new Error('deadline'), { code: 'STREAM_RECOVERY_TIMEOUT' }) : undefined);
    app.pending.resolve(stale); await operation;
    const snapshot = app.historyController.snapshot();
    assert.deepEqual(snapshot.items, [baseline]); assert.equal(snapshot.running, false); assert.equal(snapshot.loadingInitial, false);
    assert.equal(app.setQueueSnapshot.calls.length, queueCalls); assert.equal(app.setEngineMismatch.calls.length, mismatchCalls);
    assert.equal(app.setError.calls.length, 0);
    if (timeout) assert.ok(snapshot.history.error, 'deadline should leave the current history retryable');
    else assert.equal(snapshot.history.error, null);
  });
}

test('actual App ignores the old aborted failure and cannot cancel a newer initial request', async () => {
  const first = deferred(), second = deferred(); let count = 0;
  const app = appFixture({ api: () => ++count === 1 ? first.promise : second.promise }), abort = new AbortController();
  const old = app.loadTranscript(session.id, { signal: abort.signal }); abort.abort();
  const current = app.loadTranscript(session.id);
  first.reject(new Error('OLD_CONNECTION_ERROR')); await assert.doesNotReject(old);
  assert.equal(app.historyController.snapshot().loadingInitial, true, 'old cancellation cannot cancel the current token');
  second.resolve({ items: [{ id: 'fresh', type: 'agentMessage', text: 'Fresh' }], running: false, queue: [{ id: 'fresh-queue' }], engineMismatch: false }); await current;
  assert.ok(app.historyController.snapshot().items.some(item => item.id === 'fresh'));
  assert.equal(app.setQueueSnapshot.calls.at(-1).items[0].id, 'fresh-queue'); assert.equal(app.setEngineMismatch.calls.at(-1), false); assert.equal(app.setError.calls.length, 0);
});

test('actual reconnect effect waits for onOpen before read-only gap recovery and cleanup cancels both recovery reads', async () => {
  const state = deferred(), transcript = deferred(), stream = deferred(); let subscribed, bootstrapSignal;
  const app = appFixture({
    initCapability: async options => { bootstrapSignal = options.signal; return { state: { projects: [project], sessions: [session], engine: { capabilities: {} }, selectedEngine: 'codex', preferences: {} } }; },
    eventStream: (listener, signal, options) => { subscribed = { listener, signal, options }; signal.addEventListener('abort', () => stream.reject(new Error('aborted')), { once: true }); return stream.promise; },
    api: route => route === 'state' ? state.promise : transcript.promise,
  });
  const effect = app.effects.find(callback => callback.toString().includes('initCapability') && callback.toString().includes('eventStream'));
  assert.ok(effect, 'probe must execute the real reconnect effect');
  const cleanup = effect(); await turn(); assert.ok(subscribed); assert.equal(app.requests.length, 0);
  subscribed.options.onOpen(); await turn();
  assert.deepEqual(app.requests.map(request => request.route).sort(), ['sessions/session-A', 'state']);
  assert.ok(app.requests.every(request => request.body === undefined && request.method === 'GET'));
  assert.equal(app.events.filter(event => event.type === 'dsh-stream-restored').length, 1);
  cleanup(); assert.equal(bootstrapSignal.aborted, true); assert.equal(subscribed.signal.aborted, true);
  assert.ok(app.requests.every(request => request.signal.aborted));
  const states = app.setState.calls.length, queues = app.setQueueSnapshot.calls.length, mismatches = app.setEngineMismatch.calls.length;
  state.resolve({ obsolete: true }); transcript.resolve(stale); await turn(); await turn();
  assert.equal(app.setState.calls.length, states); assert.equal(app.setQueueSnapshot.calls.length, queues); assert.equal(app.setEngineMismatch.calls.length, mismatches);
  assert.deepEqual(app.historyController.snapshot().items, [baseline]); assert.equal(app.setError.calls.length, 0);
});

test('actual reconnect state event prevents an older gap-read state from replacing the live state', async () => {
  const state = deferred(), stream = deferred(); let subscribed;
  const app = appFixture({
    eventStream: (listener, signal, options) => { subscribed = { listener, signal, options }; signal.addEventListener('abort', () => stream.reject(new Error('aborted')), { once: true }); return stream.promise; },
    api: route => route === 'state' ? state.promise : Promise.resolve({ items: [baseline], running: false, queue: [] }),
  });
  const effect = app.effects.find(callback => callback.toString().includes('initCapability') && callback.toString().includes('eventStream'));
  const cleanup = effect(); await turn(); subscribed.options.onOpen(); await turn();
  const live = { ...app.initialState, observed: 'live' }; subscribed.listener({ type: 'state', state: live });
  state.resolve({ ...app.initialState, observed: 'old HTTP' }); await turn(); await turn();
  assert.equal(app.setState.calls.at(-1), live); cleanup(); await turn();
});
