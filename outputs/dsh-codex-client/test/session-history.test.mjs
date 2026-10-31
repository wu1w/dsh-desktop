import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionHistory } from '../server/session-history.mjs';

const session = { id: 'owned-session' };
const entry = (id, text = id) => ({ turnId: 'turn-' + id, item: { id, type: 'agentMessage', text }, startedAtMs: 1, completedAtMs: 2 });
const page = (ids, nextCursor = null) => ({ data: ids.map(id => entry(id)), nextCursor });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function engineFor(list) { return { readSession: async (id, options) => { assert.equal(id, session.id); assert.equal(options.includeTurns, false); return { thread: { id: 'native' } }; }, listSessionItems: list }; }

test('opening a large history requests metadata and one recent page, without hydrating all earlier items', async () => {
  const calls = [], transcripts = new Map(), history = new SessionHistory({ transcripts });
  const engine = engineFor(async (id, options) => { calls.push(options); return page(Array.from({ length: 20 }, (_, n) => 'item-' + (99 - n)), 'earlier-80'); });
  const result = await history.initial(session, engine, '/project', 'en');
  assert.deepEqual(calls, [{ cursor: null, limit: 20, sortDirection: 'desc' }]);
  assert.equal(result.items.length, 20); assert.equal(result.items[0].id, 'item-80'); assert.equal(result.items.at(-1).id, 'item-99');
  assert.equal(result.items[0].turnId, 'turn-item-80'); assert.equal(result.history.nextCursor, 'earlier-80'); assert.equal(result.history.hasMore, true);
  assert.equal(transcripts.get(session.id).length, 20);
});

test('earlier pages preserve ascending order and never enlarge the live SSE cache', async () => {
  const transcripts = new Map([[session.id, [{ id: 'latest', type: 'agentMessage', text: 'latest' }]]]);
  const history = new SessionHistory({ transcripts });
  const result = await history.earlier(session, engineFor(async (id, options) => { assert.equal(options.cursor, 'opaque-1'); return page(['middle', 'oldest']); }), '/project', 'opaque-1', 'en');
  assert.deepEqual(result.items.map(item => item.id), ['oldest', 'middle']); assert.equal(result.history.hasMore, false);
  assert.deepEqual(transcripts.get(session.id).map(item => item.id), ['latest']);
});

test('a pending history snapshot cannot overwrite current streamed text or duplicate a delta', async () => {
  const snapshot = deferred(), history = new SessionHistory({});
  const pending = history.initial(session, engineFor(() => snapshot.promise), '/project', 'en');
  history.notification(session.id, { method: 'item/started', params: { turnId: 'active', item: { id: 'live', type: 'agentMessage', text: '' } } }, '/project');
  history.notification(session.id, { method: 'item/agentMessage/delta', params: { turnId: 'active', itemId: 'live', delta: '中文实时正文' } }, '/project');
  history.notification(session.id, { method: 'item/completed', params: { turnId: 'active', item: { id: 'live', type: 'agentMessage', text: '中文实时正文', status: 'completed' } } }, '/project');
  history.notification(session.id, { method: 'item/started', params: { item: { id: 'new-after-snapshot', type: 'agentMessage', text: 'new' } } }, '/project');
  snapshot.resolve({ data: [entry('live', '中文实时'), entry('older')], nextCursor: 'old-page' });
  const result = await pending;
  assert.deepEqual(result.items.map(item => item.id), ['older', 'live', 'new-after-snapshot']);
  assert.equal(result.items[1].text, '中文实时正文'); assert.equal(result.items[1].turnId, 'active'); assert.equal(result.items[1].running, false);
});

test('streamed text received before the first snapshot survives a persisted prefix and subsequent deltas', async () => {
  const transcripts = new Map(), history = new SessionHistory({ transcripts });
  history.notification(session.id, { method: 'item/started', params: { turnId: 'active', item: { id: 'live', type: 'agentMessage', text: '已收到' } } }, '/project');
  history.notification(session.id, { method: 'item/agentMessage/delta', params: { turnId: 'active', itemId: 'live', delta: '的较新片段' } }, '/project');
  const engine = { ...engineFor(async () => ({ data: [{ ...entry('live', '已收到'), turnId: 'active', completedAtMs: null }], nextCursor: null })), activeTurns: new Map([[session.id, { turnId: 'active' }]]) };
  const result = await history.initial(session, engine, '/project', 'en');
  assert.equal(result.items[0].text, '已收到的较新片段'); assert.equal(result.items[0].running, true);
  history.notification(session.id, { method: 'item/agentMessage/delta', params: { turnId: 'active', itemId: 'live', delta: '及后续' } }, '/project');
  assert.equal(transcripts.get(session.id)[0].text, '已收到的较新片段及后续');
});

test('a snapshot ahead of the live buffer cannot make a later agent delta appear twice', async () => {
  const transcripts = new Map(), history = new SessionHistory({ transcripts });
  history.notification(session.id, { method: 'item/started', params: { turnId: 'active', item: { id: 'live', type: 'agentMessage', text: 'prefix' } } }, '/project');
  const engine = { ...engineFor(async () => ({ data: [entry('live', 'prefix suffix')], nextCursor: null })), activeTurns: new Map([[session.id, { turnId: 'active' }]]) };
  const result = await history.initial(session, engine, '/project', 'en');
  assert.equal(result.items[0].text, 'prefix');
  history.notification(session.id, { method: 'item/agentMessage/delta', params: { turnId: 'active', itemId: 'live', delta: ' suffix' } }, '/project');
  assert.equal(transcripts.get(session.id)[0].text, 'prefix suffix');
});

test('an active item missing from the persisted page stays visible without appending unrelated cache', async () => {
  const transcripts = new Map([[session.id, [{ id: 'old-cache', type: 'agentMessage', text: 'old' }]]]), history = new SessionHistory({ transcripts });
  history.notification(session.id, { method: 'item/agentMessage/delta', params: { turnId: 'active', itemId: 'live', delta: 'not persisted yet' } }, '/project');
  const engine = { ...engineFor(async () => page(['recent'])), activeTurns: new Map([[session.id, { turnId: 'active' }]]) };
  const result = await history.initial(session, engine, '/project', 'en');
  assert.deepEqual(result.items.map(item => item.id), ['recent', 'live']);
});

test('completed items accept subsequent authoritative updates and ignore delayed terminal deltas', async () => {
  const transcripts = new Map(), history = new SessionHistory({ transcripts });
  history.notification(session.id, { method: 'item/completed', params: { turnId: 'done', item: { id: 'live', type: 'agentMessage', text: 'completed text' } } }, '/project');
  history.notification(session.id, { method: 'item/agentMessage/delta', params: { turnId: 'done', itemId: 'live', delta: 'completed text' } }, '/project');
  assert.equal(transcripts.get(session.id)[0].text, 'completed text');
  const engine = { ...engineFor(async () => page(['live'])), activeTurns: new Map() };
  const result = await history.initial(session, engine, '/project', 'en');
  assert.equal(result.items[0].text, 'live'); assert.equal(result.items[0].running, false);
});

test('turn completion and inactive or replacement turns release old streaming snapshots', async () => {
  for (const state of ['completed', 'inactive', 'replaced']) {
    const history = new SessionHistory({});
    history.notification(session.id, { method: 'item/started', params: { turnId: 'old-turn', item: { id: 'live', type: 'agentMessage', text: 'old buffer' } } }, '/project');
    if (state === 'completed') history.notification(session.id, { method: 'turn/completed', params: { turn: { id: 'old-turn', status: 'completed' } } }, '/project');
    const activeTurns = state === 'inactive' ? new Map() : new Map([[session.id, { turnId: state === 'replaced' ? 'new-turn' : 'old-turn' }]]);
    const result = await history.initial(session, { ...engineFor(async () => page(['live'])), activeTurns }, '/project', 'en');
    assert.equal(result.items[0].text, 'live', state); assert.equal(result.items[0].running, false, state);
  }
});

test('only read-only page requests are retried with a smaller item count after a byte limit failure', async () => {
  const limits = [], history = new SessionHistory({});
  const engine = engineFor(async (id, options) => { limits.push(options.limit); if (options.limit > 1) throw Object.assign(new Error('too large'), { code: 'LINE_TOO_LONG' }); return page(['one'], 'next'); });
  const result = await history.initial(session, engine, '/project', 'en');
  assert.deepEqual(limits, [20, 5, 1]); assert.equal(result.items.length, 1); assert.equal(result.history.nextCursor, 'next');
});

test('an individually oversized history item leaves an actionable localized error and preserves current messages', async () => {
  const transcripts = new Map([[session.id, [{ id: 'saved', text: 'preserve', type: 'agentMessage' }]]]);
  const history = new SessionHistory({ transcripts, describeError: (error, locale) => locale + ':' + error.code });
  let requests = 0;
  const engine = engineFor(async () => { requests++; throw Object.assign(new Error('too large'), { code: 'LINE_TOO_LONG' }); });
  const initial = await history.initial(session, engine, '/project', 'en');
  assert.equal(initial.items[0].text, 'preserve'); assert.equal(initial.history.error, 'en:LINE_TOO_LONG'); assert.equal(requests, 3);
  const earlier = await history.earlier(session, engine, '/project', 'retry-cursor', 'zh-CN');
  assert.equal(earlier.history.nextCursor, 'retry-cursor'); assert.equal(earlier.history.error, 'zh-CN:LINE_TOO_LONG'); assert.equal(earlier.history.hasMore, true);
});

test('invalid cursors never reach the engine and a repeated server cursor cannot cause an endless loop', async () => {
  const history = new SessionHistory({}); let calls = 0;
  const engine = engineFor(async () => { calls++; return page(['one'], 'same'); });
  for (const cursor of [null, '', 42, 'x'.repeat(8193)]) await assert.rejects(history.earlier(session, engine, '/project', cursor, 'en'), { code: 'INVALID_REQUEST' });
  assert.equal(calls, 0);
  const result = await history.earlier(session, engine, '/project', 'same', 'en');
  assert.equal(result.history.errorCode, 'HISTORY_INVALID_PAGE'); assert.equal(calls, 1);
});

test('an old cached window does not silently inflate a fresh first page', async () => {
  const transcripts = new Map([[session.id, Array.from({ length: 100 }, (_, n) => ({ id: 'old-' + n, type: 'agentMessage', text: 'old' }))]]);
  const history = new SessionHistory({ transcripts });
  const result = await history.initial(session, engineFor(async () => page(['newest', 'recent'], 'more')), '/project', 'en');
  assert.deepEqual(result.items.map(item => item.id), ['recent', 'newest']);
});

test('out-of-order initial requests cannot roll back the host window', async () => {
  const first = deferred(), second = deferred(), transcripts = new Map(), history = new SessionHistory({ transcripts }); let calls = 0;
  const engine = engineFor(() => ++calls === 1 ? first.promise : second.promise);
  const older = history.initial(session, engine, '/project', 'en'); const newer = history.initial(session, engine, '/project', 'en');
  second.resolve(page(['newer'])); await newer; first.resolve(page(['older'])); await older;
  assert.deepEqual(transcripts.get(session.id).map(item => item.id), ['newer']);
});

test('the live transcript window stays bounded while keeping event identities and current text', () => {
  const transcripts = new Map(), history = new SessionHistory({ transcripts, maxLiveItems: 20 });
  for (let n = 0; n < 100; n++) history.notification(session.id, { method: 'item/completed', params: { turnId: 'turn-' + n, item: { id: 'item-' + n, type: 'agentMessage', text: String(n) } } }, '/project');
  assert.equal(transcripts.get(session.id).length, 20); assert.equal(transcripts.get(session.id)[0].id, 'item-80');
  assert.equal(history.windows.get(session.id).changed.size, 20);
  assert.equal(history.windows.get(session.id).phases.size, 20);
});

test('a legacy alternate engine retains its supported transcript contract', async () => {
  const history = new SessionHistory({});
  const result = await history.initial(session, { readSession: async (id, options) => { assert.equal(options.includeTurns, true); return { thread: { turns: [{ id: 'legacy-turn', items: [{ id: 'legacy', type: 'agentMessage', text: 'one' }] }] } }; } }, '/project', 'en');
  assert.equal(result.items[0].text, 'one'); assert.equal(result.history.hasMore, false);
});
