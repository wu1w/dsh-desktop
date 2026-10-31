import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, readdir, symlink, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import { PluginHost } from '../server/plugin-host.mjs';
import { AutomationScheduler, nextAutomationTime } from '../server/automations.mjs';

const task = (extra = {}) => ({ title: '本地测试', projectId: 'project-owned', prompt: '只检查本项目并汇报结果。', engineId: 'codex', model: 'deepseek-v4.1-flash', effort: 'high', permission: 'read-only', schedule: { type: 'interval', minutes: 15 }, ...extra });
function clockFixture(start = Date.parse('2026-10-24T00:00:00.000Z')) {
  let now = start, count = 0; const timers = new Map();
  return { now: () => now, setTimeout: (fn, delay) => { const id = ++count; timers.set(id, { fn: () => { timers.delete(id); fn(); }, at: now + delay }); return id; }, clearTimeout: id => timers.delete(id), advance: milliseconds => { now += milliseconds; }, timers };
}
async function fixture(options = {}) {
  const directory = options.directory ?? await mkdtemp(path.join(tmpdir(), 'dsh-automations-')), clock = options.clock ?? clockFixture();
  const scheduler = new AutomationScheduler({ dataDir: directory, clock, getProject: id => { assert.equal(id, 'project-owned'); return { id, path: directory }; }, runAutomation: options.runAutomation ?? (async () => ({ status: 'completed', sessionId: 'session-owned' })) });
  await scheduler.start();
  return { directory, clock, scheduler, async close() { await scheduler.close(); if (!options.directory) await rm(directory, { recursive: true, force: true }); } };
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

test('new tasks are paused, validate execution settings and schedules, and persist privately without extra fields', async () => {
  const current = await fixture();
  try {
    for (const bad of [{ enabled: true }, { permission: 'full-access' }, { effort: 'medium' }, { prompt: '汉'.repeat(6000) }, { schedule: { type: 'interval', minutes: 14 } }, { schedule: { type: 'interval', minutes: 10081 } }, { schedule: { type: 'daily', time: '24:00' } }, { apiKey: 'never clone credentials' }]) {
      await assert.rejects(async () => current.scheduler.create(task(bad)), { code: 'INVALID_AUTOMATION' });
    }
    const { automation } = await current.scheduler.create(task());
    assert.equal(automation.enabled, false); assert.equal(automation.nextRunAt, null); assert.equal(automation.lastStatus, 'never'); assert.deepEqual(automation.runs, []);
    assert.equal(current.clock.timers.size, 0); assert.equal((await stat(path.join(current.directory, 'automations.json'))).mode & 0o777, 0o600);
    assert.equal((await stat(current.directory)).mode & 0o777, 0o700);
    const disk = JSON.parse(await readFile(path.join(current.directory, 'automations.json'), 'utf8'));
    assert.equal(disk.version, 1); assert.equal(disk.automations[0].id, automation.id); assert.equal('apiKey' in disk.automations[0], false);
    assert.equal((await readdir(current.directory)).some(name => name.endsWith('.tmp')), false);
  } finally { await current.close(); }
});

test('a real callback observes a durable claim and awaits persisted chat binding before its turn', async () => {
  let current, calls = 0;
  current = await fixture({ runAutomation: async (input, { onSession }) => {
    calls++;
    let disk = JSON.parse(await readFile(path.join(current.directory, 'automations.json'), 'utf8')).automations[0];
    assert.equal(disk.lastStatus, 'running'); assert.equal(disk.runs.at(-1).id, input.runs.at(-1).id);
    await onSession('session-created');
    disk = JSON.parse(await readFile(path.join(current.directory, 'automations.json'), 'utf8')).automations[0]; assert.equal(disk.lastSessionId, 'session-created');
    assert.equal(input.permission, 'read-only'); return { status: 'completed', sessionId: 'session-created' };
  } });
  try {
    const { automation } = await current.scheduler.create(task()); const started = await current.scheduler.run(automation.id);
    assert.equal(started.run.status, 'running'); await current.scheduler.waitForIdle();
    const finished = current.scheduler.list().automations[0]; assert.equal(calls, 1); assert.equal(finished.lastStatus, 'completed'); assert.equal(finished.lastSessionId, 'session-created'); assert.ok(finished.runs[0].finishedAt);
  } finally { await current.close(); }
});

test('enabled interval timers invoke once at a due slot, skip suspension gaps and never overlap', async () => {
  let calls = 0; const held = deferred(), entered = deferred();
  const current = await fixture({ runAutomation: async () => { calls++; entered.resolve(); await held.promise; return { status: 'completed' }; } });
  try {
    const { automation } = await current.scheduler.create(task()); await current.scheduler.update(automation.id, { enabled: true });
    current.clock.advance(15 * 60000); const timer = [...current.clock.timers.values()][0]; timer.fn(); await entered.promise;
    await assert.rejects(current.scheduler.run(automation.id), { code: 'AUTOMATION_BUSY' });
    await assert.rejects(current.scheduler.delete(automation.id), { code: 'AUTOMATION_BUSY' });
    await assert.rejects(current.scheduler.update(automation.id, { prompt: 'changed' }), { code: 'AUTOMATION_BUSY' });
    current.clock.advance(60 * 60000); await current.scheduler.tick(); assert.equal(calls, 1);
    held.resolve(); await current.scheduler.waitForIdle(); assert.ok(Date.parse(current.scheduler.list().automations[0].nextRunAt) > current.clock.now());
    current.clock.advance(90 * 60000); await current.scheduler.tick(); await current.scheduler.waitForIdle(); assert.equal(calls, 1, 'a missed slot is rescheduled without inference');
    const next = current.scheduler.list().automations[0].nextRunAt; current.clock.advance(Date.parse(next) - current.clock.now()); await current.scheduler.tick(); await current.scheduler.waitForIdle(); assert.equal(calls, 2);
    await current.scheduler.update(automation.id, { enabled: false }); assert.equal(current.clock.timers.size, 0);
  } finally { held.resolve(); await current.close(); }
});

test('daily schedules use local calendar time and an exact or missed daily slot advances to the future', () => {
  const date = new Date(2026, 9, 24, 10, 15, 0, 0), expected = new Date(2026, 9, 25, 10, 15, 0, 0);
  assert.equal(nextAutomationTime({ type: 'daily', time: '10:15' }, date.getTime()), expected.toISOString());
  const before = new Date(2026, 9, 24, 10, 14, 59, 0);
  assert.equal(nextAutomationTime({ type: 'daily', time: '10:15' }, before.getTime()), date.toISOString());
});

test('concurrent manual requests claim once; pausing a running task stops future scheduling and retains its actual outcome', async () => {
  let calls = 0; const held = deferred();
  const current = await fixture({ runAutomation: async () => { calls++; await held.promise; return { status: 'blocked', errorCode: 'ENGINE_BUSY' }; } });
  try {
    const { automation } = await current.scheduler.create(task()); await current.scheduler.update(automation.id, { enabled: true });
    const results = await Promise.allSettled([current.scheduler.run(automation.id), current.scheduler.run(automation.id), current.scheduler.run(automation.id)]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1); assert.equal(calls, 1);
    await current.scheduler.update(automation.id, { enabled: false }); assert.equal(current.clock.timers.size, 0);
    held.resolve(); await current.scheduler.waitForIdle(); const row = current.scheduler.list().automations[0];
    assert.equal(row.enabled, false); assert.equal(row.lastStatus, 'blocked'); assert.equal(row.lastErrorCode, 'ENGINE_BUSY'); assert.equal(row.nextRunAt, null);
  } finally { held.resolve(); await current.close(); }
});

test('claim persistence failure cannot invoke inference or alter the in-memory record', async () => {
  let calls = 0; const current = await fixture({ runAutomation: async () => { calls++; return { status: 'completed' }; } });
  try {
    const { automation } = await current.scheduler.create(task()); const original = await readFile(path.join(current.directory, 'automations.json'), 'utf8');
    const replace = current.scheduler._replaceFile; current.scheduler._replaceFile = async () => { throw Object.assign(new Error('full'), { code: 'ENOSPC' }); };
    await assert.rejects(current.scheduler.run(automation.id), { code: 'AUTOMATION_STORAGE_FAILED' });
    assert.equal(calls, 0); assert.equal(current.scheduler.list().automations[0].lastStatus, 'never'); assert.equal(await readFile(path.join(current.directory, 'automations.json'), 'utf8'), original);
    await current.scheduler.tick(); assert.equal(calls, 0); assert.equal(current.clock.timers.size, 0);
    current.scheduler._replaceFile = replace; await current.scheduler.run(automation.id); await current.scheduler.waitForIdle(); assert.equal(calls, 1);
  } finally { await current.close(); }
});

test('failed chat-binding persistence aborts the callback before a turn and leaves a recoverable durable claim', async () => {
  let turns = 0; const current = await fixture({ runAutomation: async (_input, { onSession }) => { await onSession('session-new'); turns++; return { status: 'completed', sessionId: 'session-new' }; } });
  try {
    const { automation } = await current.scheduler.create(task()); const replace = current.scheduler._replaceFile.bind(current.scheduler); let saves = 0;
    current.scheduler._replaceFile = async (...args) => { if (++saves >= 2) throw Object.assign(new Error('full'), { code: 'ENOSPC' }); return replace(...args); };
    await current.scheduler.run(automation.id); await current.scheduler.waitForIdle(); assert.equal(turns, 0);
    assert.equal(current.scheduler.list().automations[0].lastStatus, 'running'); assert.equal(current.scheduler.list().runtime.storageErrorCode, 'AUTOMATION_STORAGE_FAILED');
    await assert.rejects(current.scheduler.run(automation.id), { code: 'AUTOMATION_BUSY' });
  } finally { await current.close(); }
});

test('a crash claim recovers as unknown without replay and enabled schedules restart only in the future', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'dsh-automation-crash-')), crashed = path.join(directory, 'restart'); await mkdir(crashed);
  const clock = clockFixture(); let calls = 0;
  const first = await fixture({ directory: path.join(directory, 'first'), clock, runAutomation: async (_input, { signal }) => { await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); return { status: 'unknown', errorCode: 'AUTOMATION_UNKNOWN' }; } });
  let second;
  try {
    const { automation } = await first.scheduler.create(task()); await first.scheduler.update(automation.id, { enabled: true }); await first.scheduler.run(automation.id);
    const claim = await readFile(path.join(first.directory, 'automations.json')); await writeFile(path.join(crashed, 'automations.json'), claim); await first.scheduler.close();
    clock.advance(24 * 60 * 60000); second = await fixture({ directory: crashed, clock, runAutomation: async () => { calls++; return { status: 'completed' }; } });
    const row = second.scheduler.list().automations[0]; assert.equal(row.lastStatus, 'unknown'); assert.equal(row.runs.length, 1); assert.equal(row.runs[0].status, 'unknown'); assert.ok(Date.parse(row.nextRunAt) > clock.now());
    await second.scheduler.tick(); assert.equal(calls, 0);
  } finally { await first.scheduler.close(); await second?.scheduler.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a host restart preserves a future interval deadline rather than postponing it on each launch', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'dsh-automation-future-')), clock = clockFixture(); let first, second;
  try {
    first = await fixture({ directory, clock }); const { automation } = await first.scheduler.create(task()); await first.scheduler.update(automation.id, { enabled: true });
    const deadline = first.scheduler.list().automations[0].nextRunAt; await first.scheduler.close(); clock.advance(5 * 60000);
    second = await fixture({ directory, clock }); assert.equal(second.scheduler.list().automations[0].nextRunAt, deadline);
    clock.advance(Date.parse(deadline) - clock.now()); await second.scheduler.tick(); await second.scheduler.waitForIdle(); assert.equal(second.scheduler.list().automations[0].lastStatus, 'completed');
  } finally { await first?.scheduler.close(); await second?.scheduler.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a missing project blocks only its occurrence and the actual timer keeps other tasks alive',async()=>{
  const current=await fixture();let missing=false;const calls=[];
  current.scheduler.getProject=id=>{if(missing&&id==='gone')throw Object.assign(Error('NOT_FOUND'),{code:'NOT_FOUND'});return{id};};
  current.scheduler.runAutomation=async input=>{calls.push(input.projectId);return{status:'completed'};};
  try{
    const broken=(await current.scheduler.create(task({projectId:'gone'}))).automation;
    const good=(await current.scheduler.create(task({projectId:'good'}))).automation;
    await current.scheduler.update(broken.id,{enabled:true});await current.scheduler.update(good.id,{enabled:true});
    missing=true;current.clock.advance(15*60000);
    const timer=[...current.clock.timers.values()][0];timer.fn();await current.scheduler.serial;await current.scheduler.waitForIdle();
    assert.deepEqual(calls,['good']);assert.equal(current.clock.timers.size,1);
    const blocked=current.scheduler.list().automations.find(row=>row.id===broken.id);
    assert.equal(blocked.lastStatus,'blocked');assert.equal(blocked.lastErrorCode,'NOT_FOUND');assert.equal(blocked.runs[0].status,'blocked');assert.equal(blocked.runs[0].sessionId,null);
    assert.ok(Date.parse(blocked.nextRunAt)>current.clock.now());assert.equal(current.scheduler.list().runtime.storageErrorCode,null);
    const persisted=JSON.parse(await readFile(path.join(current.directory,'automations.json'),'utf8'));assert.equal(persisted.automations.find(row=>row.id===broken.id).lastStatus,'blocked');
    missing=false;current.clock.advance(15*60000);[...current.clock.timers.values()][0].fn();await current.scheduler.serial;await current.scheduler.waitForIdle();
    assert.equal(calls.filter(id=>id==='gone').length,1);assert.equal(calls.filter(id=>id==='good').length,2);assert.equal(current.clock.timers.size,1);
  }finally{await current.close();}
});

test('unknown/corrupt state and external edits fail closed without rewriting user bytes', async () => {
  for (const content of ['{broken', JSON.stringify({ version: 2, automations: [] }), JSON.stringify({ version: 1, automations: [{ id: 'fake', enabled: true }] })]) {
    const directory = await mkdtemp(path.join(tmpdir(), 'dsh-automation-corrupt-')); await writeFile(path.join(directory, 'automations.json'), content);
    const scheduler = new AutomationScheduler({ dataDir: directory, getProject: () => ({}), runAutomation: async () => { throw new Error('must not run'); } });
    try { await assert.rejects(scheduler.start(), { code: 'AUTOMATION_STATE_INVALID' }); assert.equal(await readFile(path.join(directory, 'automations.json'), 'utf8'), content); }
    finally { await scheduler.close(); await rm(directory, { recursive: true, force: true }); }
  }
  const current = await fixture();
  try {
    const { automation } = await current.scheduler.create(task()); await writeFile(path.join(current.directory, 'automations.json'), 'external edit');
    await assert.rejects(current.scheduler.run(automation.id), { code: 'AUTOMATION_STATE_INVALID' }); assert.equal(await readFile(path.join(current.directory, 'automations.json'), 'utf8'), 'external edit');
  } finally { await current.close(); }
});

test('a second owner cannot schedule the same file and symlink state is refused', async () => {
  const current = await fixture();
  const second = new AutomationScheduler({ dataDir: current.directory, getProject: () => ({}), runAutomation: async () => ({ status: 'completed' }) });
  try { await assert.rejects(second.start(), { code: 'AUTOMATION_LOCKED' }); }
  finally { await second.close(); await current.close(); }
  const directory = await mkdtemp(path.join(tmpdir(), 'dsh-automation-symlink-')); await writeFile(path.join(directory, 'outside'), 'private'); await symlink(path.join(directory, 'outside'), path.join(directory, 'automations.json'));
  const scheduler = new AutomationScheduler({ dataDir: directory, getProject: () => ({}), runAutomation: async () => ({ status: 'completed' }) });
  try { await assert.rejects(scheduler.start(), { code: 'AUTOMATION_STORAGE_UNSAFE' }); assert.equal(await readFile(path.join(directory, 'outside'), 'utf8'), 'private'); }
  finally { await scheduler.close(); await rm(directory, { recursive: true, force: true }); }
});

test('bounded histories, exact unknown outcomes and idempotent shutdown wait for the real callback', async () => {
  const current = await fixture();
  try {
    const { automation } = await current.scheduler.create(task());
    for (let n = 0; n < 25; n++) { current.clock.advance(1000); await current.scheduler.run(automation.id); await current.scheduler.waitForIdle(); }
    assert.equal(current.scheduler.list().automations[0].runs.length, 20);
    let aborted; const terminal = deferred(), abortSeen = new Promise(resolve => { aborted = resolve; });
    current.scheduler.runAutomation = async (_input, { signal }) => { signal.addEventListener('abort', aborted, { once: true }); await terminal.promise; return { status: 'unknown', errorCode: 'AUTOMATION_UNKNOWN' }; };
    await current.scheduler.run(automation.id); let closed = false; const closing = current.scheduler.close().then(() => { closed = true; }); await abortSeen;
    assert.equal(closed, false); assert.equal(current.scheduler.close(), current.scheduler.closing); await assert.rejects(current.scheduler.run(automation.id), { code: 'AUTOMATION_STOPPED' });
    terminal.resolve(); await closing; assert.equal(current.scheduler.list().automations[0].lastStatus, 'unknown'); assert.equal(current.clock.timers.size, 0);
  } finally { await current.close(); }
});

test('real Cordis routes run through the host callback, abort on disable, and retain records after re-enable', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'dsh-automation-plugin-')), context = new Context(); let host; const entered = deferred(); let calls = 0;
  const dispatch = async (segments, method = 'GET', body = {}) => { let value; const handled = await host.dispatch({ segments: ['automations', ...segments], request: { method }, body, json: result => { value = result; } }); return { handled, value }; };
  try {
    host = new PluginHost({ context, dataDir: directory, builtins: [fileURLToPath(new URL('../server/plugins/feature-automations.mjs', import.meta.url))], services: { dataDir: directory, getProject: () => ({ path: directory }), runAutomation: async (_input, { signal, onSession }) => { calls++; await onSession('plugin-session'); entered.resolve(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); return { sessionId: 'plugin-session', status: 'unknown', errorCode: 'AUTOMATION_UNKNOWN' }; } } });
    await host.start(); const created = await dispatch([], 'POST', task()); const id = created.value.automation.id;
    assert.equal(created.value.automation.enabled, false); await dispatch([id, 'run'], 'POST'); await entered.promise; assert.equal(calls, 1);
    await host.disable('feature-automations'); assert.equal((await dispatch([])).handled, false);
    const disk = JSON.parse(await readFile(path.join(directory, 'automations.json'), 'utf8')); assert.equal(disk.automations[0].lastStatus, 'unknown');
    await host.enable('feature-automations'); const state = (await dispatch([])).value;
    assert.equal(state.automations[0].lastSessionId, 'plugin-session'); assert.equal(state.automations[0].enabled, false); assert.equal(calls, 1);
    await dispatch([id, 'delete'], 'POST'); assert.equal((await dispatch([])).value.automations.length, 0);
  } finally { await host?.close(); await context.fiber.dispose(); await rm(directory, { recursive: true, force: true }); }
});
