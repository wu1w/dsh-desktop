import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const appRoot = process.env.DSH_ACCEPTANCE_APP_ROOT ?? fileURLToPath(new URL('..', import.meta.url));
const { startHost } = await import(pathToFileURL(path.join(appRoot, 'server/index.mjs')));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { const end = Date.now() + 5000; while (!await check()) { if (Date.now() > end) throw Error('FIXTURE_TIMEOUT'); await sleep(5); } }
const exists = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };

test('a real command cleanup failure cannot skip other plugin, engine, listener and host-lock shutdown', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'dsh-host-stop-failure-')), project = path.join(directory, 'project');
  const originalSpawn = childProcess.spawn, originalKill = process.kill; let commandChild, host, restarted, held = true, pending;
  const spawnMock = t.mock.method(childProcess, 'spawn', function (executable, args, options) { const child = originalSpawn.call(this, executable, args, options); if (args?.[0] === '-c' && args[1] === 'exec /bin/sleep 60 # dsh-owned-stop-failure') commandChild = child; return child; }); syncBuiltinESMExports();
  const killMock = t.mock.method(process, 'kill', function (pid, signal) { if (held && commandChild?.pid && pid === -commandChild.pid && signal !== 0) throw Object.assign(Error('isolated permission fault'), { code: 'EPERM' }); return originalKill.call(this, pid, signal); });
  try {
    await mkdir(project);
    host = await startHost({ dataDir: path.join(directory, 'data'), binary: process.execPath, engineOptions: { args: [fileURLToPath(new URL('./fixtures/approval-app-server.mjs', import.meta.url))], resolveApiKey: async () => 'isolated-local-stop-fixture' } });
    const native = host.engine, enginePid = native.client.pid; assert.ok(exists(enginePid));
    const response = await fetch(host.url + '/api/bootstrap'), boot = await response.json();
    const headers = { cookie: response.headers.get('set-cookie').split(';')[0], 'x-dsh-capability': boot.capability, 'content-type': 'application/json' };
    const api = async (route, body) => { const response = await fetch(host.url + '/api/' + route, { headers, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) }); return { status: response.status, body: await response.json() }; };
    const added = await api('projects', { path: project }); assert.equal(added.status, 200);
    pending = api('projects/' + added.body.id + '/terminal', { command: 'exec /bin/sleep 60 # dsh-owned-stop-failure' }).catch(error => ({ networkError: error.code })); await until(() => Boolean(commandChild?.pid)); assert.ok(exists(commandChild.pid));
    await assert.rejects(host.close(), error => ['COMMAND_STOP_FAILED', 'PLUGIN_CLEANUP_FAILED'].includes(error.code));
    await pending; await until(() => !exists(enginePid)); assert.equal(native.ready, false);
    await assert.rejects(fetch(host.url + '/api/bootstrap')); assert.equal(host.plugins.records.get('feature-automations').active, false); assert.equal(host.plugins.records.get('feature-git').active, false);
    // The unkillable fault was restricted to this command; the other services
    // must already be closed even while that one OS resource is unconfirmed.
    assert.ok(exists(commandChild.pid)); held = false; originalKill.call(process, -commandChild.pid, 'SIGKILL'); await until(() => !exists(commandChild.pid));
    restarted = await startHost({ dataDir: path.join(directory, 'data'), autoStart: false });
    const state = restarted.state(); assert.equal(state.plugins.find(row => row.id === 'feature-automations').error, null); assert.equal(state.plugins.find(row => row.id === 'feature-automations').active, true); assert.equal(state.plugins.find(row => row.id === 'feature-git').error, null);
  } finally {
    held = false; if (commandChild?.pid) { try { originalKill.call(process, -commandChild.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    await pending; await restarted?.close(); await host?.close().catch(() => {}); killMock.mock.restore(); spawnMock.mock.restore(); syncBuiltinESMExports(); await rm(directory, { recursive: true, force: true });
  }
});
