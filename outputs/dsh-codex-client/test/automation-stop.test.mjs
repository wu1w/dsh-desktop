import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';

const appRoot = process.env.DSH_ACCEPTANCE_APP_ROOT ?? fileURLToPath(new URL('..', import.meta.url));
const { AutomationScheduler } = await import(pathToFileURL(path.join(appRoot, 'server/automations.mjs')));
const { PluginHost } = await import(pathToFileURL(path.join(appRoot, 'server/plugin-host.mjs')));
const task = { title: 'Owned cancellation probe', projectId: 'project-owned', prompt: 'Deterministic local callback only', engineId: 'codex', model: 'deepseek-v4.1-flash', effort: 'high', permission: 'read-only', schedule: { type: 'interval', minutes: 15 } };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { const deadline = Date.now() + 2000; while (!await check()) { if (Date.now() > deadline) throw Error('FIXTURE_TIMEOUT'); await sleep(2); } }
async function fixture(action) { const directory = await mkdtemp(path.join(tmpdir(), 'dsh-automation-stop-')); try { await action(directory); } finally { await rm(directory, { recursive: true, force: true }); } }
const options = directory => ({ dataDir: directory, getProject: () => ({ id: task.projectId, path: directory }), runAutomation: async () => ({ status: 'completed' }), stopTimeoutMs: 50 });

test('unconfirmed automation stop keeps its real run, claim and lock until a late terminal outcome and explicit retry', () => fixture(async directory => {
  const terminal = deferred(), entered = deferred(); let calls = 0, signal;
  const scheduler = new AutomationScheduler({ ...options(directory), runAutomation: async (_task, input) => { calls++; signal = input.signal; await input.onSession('session-owned'); entered.resolve(); await terminal.promise; return { status: 'completed', sessionId: 'session-owned' }; } });
  let second;
  try {
    await scheduler.start(); const { automation } = await scheduler.create(task); await scheduler.update(automation.id, { enabled: true }); await scheduler.run(automation.id); await entered.promise;
    const claim = await readFile(path.join(directory, 'automations.json'));
    await assert.rejects(scheduler.close(), { code: 'AUTOMATION_STOP_FAILED' });
    assert.equal(signal.aborted, true); assert.equal(scheduler.active.size, 1); assert.equal(scheduler.timer, null); assert.equal(scheduler.closing, null); assert.equal(typeof scheduler.releaseLock, 'function');
    assert.equal(scheduler.list().runtime.hostRunning, false); assert.equal(scheduler.list().automations[0].lastStatus, 'running'); assert.deepEqual(await readFile(path.join(directory, 'automations.json')), claim);
    await assert.rejects(scheduler.run(automation.id), { code: 'AUTOMATION_STOPPED' });
    second = new AutomationScheduler(options(directory)); await assert.rejects(second.start(), { code: 'AUTOMATION_LOCKED' }); await second.close(); second = null;
    terminal.resolve(); await scheduler.waitForIdle(); assert.equal(scheduler.list().automations[0].lastStatus, 'completed'); assert.equal(calls, 1);
    // Timeout must not schedule lock release in a hidden continuation.
    assert.equal(typeof scheduler.releaseLock, 'function'); await scheduler.close(); assert.equal(scheduler.releaseLock, null);
    second = new AutomationScheduler(options(directory)); await second.start(); const row = second.list().automations[0]; assert.equal(row.lastStatus, 'completed'); assert.equal(row.lastSessionId, 'session-owned'); assert.equal(row.runs.length, 1); assert.equal(calls, 1);
  } finally { terminal.resolve(); await scheduler.waitForIdle(); await scheduler.close(); await second?.close(); }
}));

test('failed lock release is surfaced and retried without reporting a successful scheduler close', () => fixture(async directory => {
  const scheduler = new AutomationScheduler(options(directory)); let actualRelease, releases = 0, second;
  try {
    await scheduler.start(); await scheduler.create(task); actualRelease = scheduler.releaseLock;
    scheduler.releaseLock = async () => { if (++releases === 1) throw Object.assign(Error('private disk detail'), { code: 'EIO' }); await actualRelease(); };
    await assert.rejects(scheduler.close(), { code: 'EIO' }); assert.equal(scheduler.closing, null); assert.equal(typeof scheduler.releaseLock, 'function');
    second = new AutomationScheduler(options(directory)); await assert.rejects(second.start(), { code: 'AUTOMATION_LOCKED' }); await second.close(); second = null;
    await scheduler.close(); assert.equal(releases, 2); assert.equal(scheduler.releaseLock, null);
    second = new AutomationScheduler(options(directory)); await second.start(); assert.equal(second.list().automations.length, 1);
  } finally { await scheduler.close(); await second?.close(); }
}));

test('a claim already waiting for project binding is cancelled before invoking its callback during shutdown', () => fixture(async directory => {
  const binding = deferred(), entered = deferred(); let hold = false, calls = 0;
  const scheduler = new AutomationScheduler({ ...options(directory), getProject: async () => { if (hold) { entered.resolve(); await binding.promise; } return { id: task.projectId, path: directory }; }, runAutomation: async (_task, { signal }) => { calls++; assert.equal(signal.aborted, true); return { status: 'cancelled', errorCode: 'AUTOMATION_CANCELLED' }; } });
  let running;
  try {
    await scheduler.start(); const { automation } = await scheduler.create(task); hold = true;
    running = scheduler.run(automation.id); await entered.promise; await assert.rejects(scheduler.close(), { code: 'AUTOMATION_STOP_FAILED' }); assert.equal(scheduler.active.size, 0);
    binding.resolve(); await running; await scheduler.waitForIdle(); assert.equal(calls, 0); assert.equal(scheduler.list().automations[0].lastStatus, 'cancelled'); await scheduler.close();
  } finally { binding.resolve(); await running; await scheduler.waitForIdle(); await scheduler.close(); }
}));

test('actual Cordis automation plugin retains fiber, activity and persisted enable choice after stop timeout; late finish permits disable and restore', async t => fixture(async directory => {
  const terminal = deferred(), entered = deferred(); let scheduler, calls = 0, aborted = false, host;
  const originalStart = AutomationScheduler.prototype.start;
  t.mock.method(AutomationScheduler.prototype, 'start', function (...args) { scheduler = this; this.stopTimeoutMs = 50; return originalStart.apply(this, args); });
  const context = new Context();
  const dispatch = async (segments = [], method = 'GET', body = {}) => { let result; const handled = await host.dispatch({ segments: ['automations', ...segments], request: { method }, body, json: value => { result = value; } }); return { handled, result }; };
  try {
    host = new PluginHost({ context, dataDir: directory, builtins: [path.join(appRoot, 'server/plugins/feature-automations.mjs')], services: { dataDir: directory, getProject: () => ({ id: task.projectId, path: directory }), runAutomation: async (_task, { signal, onSession }) => { calls++; signal.addEventListener('abort', () => { aborted = true; }, { once: true }); await onSession('native-binding-owned'); entered.resolve(); await terminal.promise; return { status: 'cancelled', sessionId: 'native-binding-owned', errorCode: 'AUTOMATION_CANCELLED' }; } } });
    await host.start(); await host.enable('feature-automations'); const { result } = await dispatch([], 'POST', task); const id = result.automation.id; await dispatch([id, 'run'], 'POST'); await entered.promise;
    const record = host.records.get('feature-automations'), fiber = record.fiber, before = await readFile(path.join(directory, 'plugins.json')), activities = host.activities();
    assert.equal(activities.length, 1); assert.equal(record.stopGuards.size, 1);
    await assert.rejects(host.disable('feature-automations'), { code: 'AUTOMATION_STOP_FAILED' });
    assert.equal(aborted, true); assert.equal(record.fiber, fiber); assert.equal(record.active, true); assert.equal(record.enabled, true); assert.equal(record.error, 'AUTOMATION_STOP_FAILED'); assert.deepEqual(host.activities(), activities); assert.deepEqual(await readFile(path.join(directory, 'plugins.json')), before);
    assert.equal((await dispatch()).result.runtime.hostRunning, false); await assert.rejects(dispatch([id, 'run'], 'POST'), { code: 'AUTOMATION_STOPPED' });
    terminal.resolve(); await until(() => scheduler.active.size === 0); assert.equal(host.activities().length, 0); await host.disable('feature-automations'); assert.equal(record.active, false); assert.equal((await dispatch()).handled, false);
    await host.enable('feature-automations'); const restored = (await dispatch()).result; assert.equal(restored.automations[0].lastStatus, 'cancelled'); assert.equal(restored.automations[0].lastSessionId, 'native-binding-owned'); assert.equal(restored.automations[0].runs.length, 1); assert.equal(calls, 1);
  } finally { terminal.resolve(); await scheduler?.waitForIdle(); await host?.close(); await context.fiber.dispose(); }
}));

test('stop timeout rejects invalid bounds', () => {
  for (const stopTimeoutMs of [0, -1, 1.5, 60001, Infinity, '50']) assert.throws(() => new AutomationScheduler({ ...options('/tmp'), stopTimeoutMs }), { code: 'INVALID_AUTOMATION' });
});
