import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PluginHost } from '../server/plugin-host.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { const end = Date.now() + 3000; while (!await check()) { if (Date.now() > end) throw Error('FIXTURE_TIMEOUT'); await sleep(3); } }
const manifest = id => ({ id, type: 'feature', version: '1.0.0', name: { en: id, 'zh-CN': id } });
async function fixture(action) { const root = await mkdtemp(path.join(tmpdir(), 'dsh-plugin-before-stop-')); try { await action(root); } finally { await rm(root, { recursive: true, force: true }); } }
async function source(root, id, body, installed = false) {
  const directory = path.join(root, installed ? 'source' : 'builtins', id); await mkdir(directory, { recursive: true });
  if (installed) await writeFile(path.join(directory, 'dsh-plugin.json'), JSON.stringify(manifest(id)));
  const file = path.join(directory, 'index.mjs'); await writeFile(file, `export const manifest=${JSON.stringify(manifest(id))};export async function apply(ctx,host){${body}}`);
  return installed ? directory : file;
}
async function current(root, { builtins = [], controls = {}, services = {} } = {}) {
  const context = new Context(), host = new PluginHost({ context, dataDir: path.join(root, 'data'), builtins, services: { dataDir: path.join(root, 'data'), controls, ...services } }); await host.start();
  return { host, context, async close() { await host.close(); await context.fiber.dispose(); } };
}
async function dispatch(host, segments, body = {}, method = 'POST') {
  const request = new EventEmitter(), response = new EventEmitter(); request.method = method; request.aborted = false; response.writableFinished = false; response.destroyed = false;
  let value;
  const handled = await host.dispatch({ segments, body, request, response, url: new URL('http://isolated/?path=file.txt'), json: result => { value = result; response.writableFinished = true; } });
  return { handled, value };
}
const guardedBody = `
host.registerActivityProvider('guarded-activity',()=>[{id:'operation',kind:'command',count:1}]);
host.registerBeforeStop(async info=>{host.controls.calls.push(info.reason);if(host.controls.wait)await host.controls.wait;if(host.controls.fail)throw Object.assign(new Error('PRIVATE_DETAIL'),{code:'FILE_OPEN_CLEANUP_FAILED'});});
ctx.effect(()=>()=>{host.controls.disposals++;});
host.registerRoute({matches:()=>true,handle:async environment=>environment.json({ok:true})});
`;

test('before-stop rejection keeps actual Cordis fiber, activities, routes and persisted settings; retry runs once', async () => fixture(async root => {
  let release, environment;
  const controls = { calls: [], fail: true, disposals: 0, wait: new Promise(resolve => { release = resolve; }) };
  try {
    const file = await source(root, 'guarded-feature', guardedBody); environment = await current(root, { builtins: [file], controls });
    const host = environment.host; await host.enable('guarded-feature');
    const before = await readFile(path.join(root, 'data', 'plugins.json')), record = host.records.get('guarded-feature'), fiber = record.fiber, activities = host.activities();
    const stopping = host.disable('guarded-feature'), rejected = assert.rejects(stopping, { code: 'FILE_OPEN_CLEANUP_FAILED' });
    await until(() => controls.calls.length === 1);
    await assert.rejects(dispatch(host, ['anything']), { code: 'PLUGIN_DISABLED' });
    assert.deepEqual(host.activities(), activities); assert.equal(controls.disposals, 0);
    release(); controls.wait = null; await rejected;
    assert.equal(record.fiber, fiber); assert.equal(record.active, true); assert.equal(record.enabled, true); assert.equal(record.error, 'FILE_OPEN_CLEANUP_FAILED');
    assert.equal((await dispatch(host, ['anything'])).value.ok, true); assert.deepEqual(host.activities(), activities);
    assert.deepEqual(await readFile(path.join(root, 'data', 'plugins.json')), before);
    controls.fail = false; await host.disable('guarded-feature');
    assert.equal(controls.disposals, 1); assert.equal(record.active, false); assert.equal(record.error, null); assert.equal(host.activities().length, 0); assert.equal(host.routes.size, 0);
    await host.enable('guarded-feature'); assert.equal(record.stopGuards.size, 1); await host.disable('guarded-feature');
    assert.equal(controls.disposals, 2); assert.deepEqual(controls.calls, ['disable', 'disable', 'disable']);
  } finally { release(); controls.wait = null; controls.fail = false; await environment?.close(); }
}));

test('failed remove preserves installed plugin files and settings until a successful explicit retry', async () => fixture(async root => {
  const controls = { calls: [], fail: true, disposals: 0 }; let environment;
  try {
    const directory = await source(root, 'installed-guarded', guardedBody, true); environment = await current(root, { controls });
    const host = environment.host; await host.install(directory); await host.enable('installed-guarded');
    const record = host.records.get('installed-guarded'), installed = record.root, before = await readFile(path.join(root, 'data', 'plugins.json'));
    await assert.rejects(host.remove('installed-guarded'), { code: 'FILE_OPEN_CLEANUP_FAILED' });
    await access(installed); assert.equal(host.records.get('installed-guarded'), record); assert.equal(record.active, true); assert.equal(record.enabled, true);
    assert.deepEqual(await readFile(path.join(root, 'data', 'plugins.json')), before); assert.equal(host.activities().length, 1); assert.equal(controls.disposals, 0);
    controls.fail = false; await host.remove('installed-guarded');
    assert.equal(host.records.has('installed-guarded'), false); await assert.rejects(access(installed), { code: 'ENOENT' }); assert.equal(controls.disposals, 1);
  } finally { controls.fail = false; await environment?.close(); }
}));

test('close explicitly rejects guard failures without discarding activity and a late cleanup can be retried', async () => fixture(async root => {
  const controls = { calls: [], fail: true, disposals: 0 }; let environment;
  try {
    const file = await source(root, 'shutdown-guarded', guardedBody); environment = await current(root, { builtins: [file], controls });
    const host = environment.host, record = host.records.get('shutdown-guarded'), fiber = record.fiber;
    await assert.rejects(host.close(), { code: 'PLUGIN_CLEANUP_FAILED' });
    assert.equal(record.fiber, fiber); assert.equal(record.active, true); assert.equal(record.error, 'FILE_OPEN_CLEANUP_FAILED');
    assert.equal(host.activities().length, 1); assert.equal(host.routes.size, 1); assert.equal(controls.disposals, 0);
    await assert.rejects(dispatch(host, ['anything']), { code: 'PLUGIN_DISABLED' });
    controls.fail = false; await host.close();
    assert.equal(controls.disposals, 1); assert.equal(host.activities().length, 0); assert.equal(record.active, false); assert.deepEqual(controls.calls, ['shutdown', 'shutdown']);
  } finally { controls.fail = false; await environment?.close(); }
}));

test('invalid guard registration fails startup and unknown guard errors are sanitized', async () => fixture(async root => {
  const controls = { fail: true }; let environment;
  try {
    const file = await source(root, 'sanitized-stop', `host.registerBeforeStop(()=>{if(host.controls.fail)throw Error('PRIVATE_SECRET');});host.registerRoute({matches:()=>true,handle:async e=>e.json({ok:true})});`);
    const bad = await source(root, 'invalid-stop', 'host.registerBeforeStop(null);'); environment = await current(root, { builtins: [file, bad], controls });
    const host = environment.host; assert.equal(host.records.get('invalid-stop').active, false);
    await assert.rejects(host.disable('sanitized-stop'), { code: 'PLUGIN_STOP_FAILED', message: 'PLUGIN_STOP_FAILED' });
    assert.equal(host.records.get('sanitized-stop').error, 'PLUGIN_STOP_FAILED'); assert.equal(host.records.get('sanitized-stop').active, true);
  } finally { controls.fail = false; await environment?.close(); }
}));

test('actual feature-files retains its unconfirmed launcher across failed stop and succeeds only after real late exit', async t => fixture(async root => {
  const originalSpawn = childProcess.spawn; let intercepted, environment, child, succeed = false;
  try {
    const projectPath = path.join(root, 'project'); await mkdir(projectPath); await writeFile(path.join(projectPath, 'file.txt'), 'unchanged');
    intercepted = t.mock.method(childProcess, 'spawn', (command, args, options) => {
      if (command !== '/usr/bin/open' && command !== 'xdg-open') return originalSpawn(command, args, options);
      child = new EventEmitter(); child.pid = 123456789; child.stderr = new EventEmitter(); child.stderr.destroy = () => {}; child.kills = []; child.kill = signal => { child.kills.push(signal); return false; };
      if (succeed) process.nextTick(() => child.emit('exit', 0, null)); return child;
    }); syncBuiltinESMExports();
    environment = await current(root, { builtins: [fileURLToPath(new URL('../server/plugins/feature-files.mjs', import.meta.url))], services: { getProject: id => ({ id, path: projectPath }) } });
    const host = environment.host; await host.enable('feature-files'); const record = host.records.get('feature-files'), fiber = record.fiber;
    const opening = dispatch(host, ['projects', 'project', 'open'], { path: 'file.txt' }).then(value => ({ value }), error => ({ error }));
    await until(() => Boolean(child)); const activity = host.activities();
    await assert.rejects(host.disable('feature-files'), { code: 'FILE_OPEN_CLEANUP_FAILED' });
    assert.equal((await opening).error.code, 'FILE_OPEN_CLEANUP_FAILED'); assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL']);
    assert.equal(record.fiber, fiber); assert.equal(record.active, true); assert.equal(record.enabled, true); assert.deepEqual(host.activities(), activity);
    assert.equal((await dispatch(host, ['projects', 'project', 'file'], {}, 'GET')).value.content, 'unchanged');
    await assert.rejects(dispatch(host, ['projects', 'project', 'open'], { path: 'file.txt' }), { code: 'FILE_OPEN_CLOSED' });
    child.emit('exit', null, 'SIGKILL'); assert.equal(host.activities().length, 0); await host.disable('feature-files');
    assert.equal(record.active, false); assert.equal(record.error, null); assert.equal(host.routes.size, 0);
    succeed = true; await host.enable('feature-files'); assert.deepEqual((await dispatch(host, ['projects', 'project', 'open'], { path: 'file.txt' })).value, { ok: true, accepted: true });
    assert.equal(await readFile(path.join(projectPath, 'file.txt'), 'utf8'), 'unchanged');
  } finally { child?.emit('exit', null, 'SIGKILL'); await environment?.close(); intercepted?.mock.restore(); syncBuiltinESMExports(); }
}));
