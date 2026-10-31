import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const hostModule=process.env.DSH_ACCEPTANCE_APP_ROOT?pathToFileURL(path.join(process.env.DSH_ACCEPTANCE_APP_ROOT,'server/index.mjs')):new URL('../server/index.mjs',import.meta.url);
const {startHost}=await import(hostModule);

async function stream(url, headers) {
  const abort = new AbortController(), response = await fetch(url + '/api/events', { headers, signal: abort.signal });
  const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = ''; const queue = [];
  return { close() { abort.abort(); reader.cancel().catch(() => {}); }, async next(type) {
    const timer = setTimeout(() => abort.abort(), 3000);
    try {
      for (;;) {
        const index = queue.findIndex(event => event.type === type); if (index >= 0) return queue.splice(index, 1)[0];
        const { value, done } = await reader.read(); if (done) throw Error('EVENT_STREAM_ENDED'); buffer += decoder.decode(value, { stream: true });
        for (;;) { const end = buffer.indexOf('\n\n'); if (end < 0) break; const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2); for (const line of frame.split('\n')) if (line.startsWith('data: ')) queue.push(JSON.parse(line.slice(6))); }
      }
    } finally { clearTimeout(timer); }
  } };
}

test('authenticated HTTP and native JSON-RPC preserve per-question answers, skips and cancellation without broadcasting secrets', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-approval-api-')); let host, events;
  try {
    const projectPath = path.join(root, 'project'), capture = path.join(root, 'native-answers.jsonl'); await mkdir(projectPath);
    host = await startHost({ dataDir: path.join(root, 'data'), binary: process.execPath, engineOptions: { args: [fileURLToPath(new URL('./fixtures/approval-app-server.mjs', import.meta.url))], resolveApiKey: async () => 'isolated-fixture-key', extraEnv: { DSH_APPROVAL_CAPTURE: capture }, approvalTimeoutMs: 10000 } });
    const response = await fetch(host.url + '/api/bootstrap'), boot = await response.json(); assert.equal(boot.state.engine.state, 'ready');
    const headers = { cookie: response.headers.get('set-cookie').split(';')[0], 'x-dsh-capability': boot.capability, 'content-type': 'application/json', 'accept-language': 'en' };
    const api = async (route, body) => { const response = await fetch(host.url + '/api/' + route, { headers, method: 'POST', body: JSON.stringify(body) }); return { httpStatus: response.status, ...await response.json() }; };
    events = await stream(host.url, headers);
    const project = await api('projects', { path: projectPath }), session = await api('sessions', { projectId: project.id });
    assert.equal((await api('sessions/' + session.id + '/turn', { text: 'Ask three questions', permission: 'read-only' })).httpStatus, 200);
    const first = (await events.next('approval')).request; assert.equal(first.params.questions.length, 3); assert.notEqual(first.id, '7002');
    const invalid = await api('approvals/' + first.id, { allow: true, answer: 'incorrect shared answer' }); assert.equal(invalid.code, 'INVALID_USER_ANSWERS');
    events.close();events=await stream(host.url,headers);
    const synchronized=await events.next('approvals-sync');assert.deepEqual(synchronized.requests.map(request=>request.id),[first.id]);
    assert.equal((await events.next('approval')).request.id,first.id);
    // The invalid submit did not resolve or delete the native request.
    const secret = 'SECRET_ONLY_IN_ANSWER_TEST';
    assert.equal((await api('approvals/' + first.id, { allow: true, answers: { choice: { answers: ['JSON'] }, secret: { answers: [secret] } } })).httpStatus, 200);
    const resolved = await events.next('approval-resolved'); assert.equal(resolved.id, first.id); assert.equal(JSON.stringify(resolved).includes(secret), false);
    const end = Date.now() + 3000; while (host.engine.activeTurns.size) { if (Date.now() > end) throw Error('TURN_STILL_ACTIVE'); await new Promise(resolve => setTimeout(resolve, 5)); }
    let native = (await readFile(capture, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(native[0].result, { answers: { choice: { answers: ['JSON'] }, secret: { answers: [secret] } } }); assert.equal(Object.hasOwn(native[0].result.answers, 'skip'), false);
    assert.equal(JSON.stringify((await (await fetch(host.url + '/api/state', { headers })).json())).includes(secret), false);
    await api('sessions/' + session.id + '/turn', { text: 'Ask again', permission: 'read-only' });
    const second = (await events.next('approval')).request; assert.notEqual(second.id, first.id);
    assert.equal((await api('approvals/' + second.id, { allow: false })).httpStatus, 200);
    const until = Date.now() + 3000; while (host.engine.activeTurns.size) { if (Date.now() > until) throw Error('CANCEL_STILL_ACTIVE'); await new Promise(resolve => setTimeout(resolve, 5)); }
    native = (await readFile(capture, 'utf8')).trim().split('\n').map(JSON.parse); assert.deepEqual(native[1].result, { answers: {} });
    events.close();events=await stream(host.url,headers);assert.deepEqual((await events.next('approvals-sync')).requests,[]);
    assert.equal((await api('approvals/' + first.id, { allow: false })).code, 'APPROVAL_NOT_FOUND');
  } finally { events?.close(); await host?.close(); await rm(root, { recursive: true, force: true }); }
});
