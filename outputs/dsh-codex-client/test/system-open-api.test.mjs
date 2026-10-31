import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { spawn } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileErrors } from '../shared/file-errors.js';

const appRoot = process.env.DSH_ACCEPTANCE_APP_ROOT;
const { startHost } = await import(appRoot ? pathToFileURL(path.join(appRoot, 'server/index.mjs')) : new URL('../server/index.mjs', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(check) { const end = Date.now() + 3000; while (!await check()) { if (Date.now() > end) throw Error('FIXTURE_TIMEOUT'); await sleep(5); } }
const launcher = String.raw`const fs=require('node:fs');const [mode,marker,target]=process.argv.slice(1);if(mode==='ignore')process.on('SIGTERM',()=>{});fs.writeFileSync(marker,JSON.stringify({pid:process.pid,target}));if(mode==='success')setTimeout(()=>process.exit(0),120);else if(mode==='fail'){process.stderr.write('PRIVATE_LAUNCHER_DETAIL '+target);process.exitCode=3;}else setInterval(()=>{},1000);`;

test('authenticated system-open HTTP awaits launcher result and cleans cancelled or disabled requests without GUI', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-system-open-api-')); let host, intercept;
  const nativeSpawn = spawn, launches = []; let mode = 'success', serial = 0;
  try {
    const projectPath = path.join(root, 'project'); await mkdir(projectPath); await writeFile(path.join(projectPath, '中文.txt'), 'kept\r\n');
    intercept = t.mock.method(childProcess, 'spawn', (command, args, options) => {
      if (command !== '/usr/bin/open' && command !== 'xdg-open') return nativeSpawn(command, args, options);
      const marker = path.join(root, `launcher-${++serial}.json`);
      const child = mode === 'missing' ? nativeSpawn(path.join(root, 'nonexistent-launcher'), args, options) : nativeSpawn(process.execPath, ['-e', launcher, '--', mode, marker, ...args], options);
      launches.push({ pid: child.pid, marker, target: args[0] }); return child;
    }); syncBuiltinESMExports();
    host = await startHost({ dataDir: path.join(root, 'data'), autoStart: false });
    const bootResponse = await fetch(host.url + '/api/bootstrap'), boot = await bootResponse.json();
    const headers = { cookie: bootResponse.headers.get('set-cookie').split(';')[0], 'x-dsh-capability': boot.capability, 'content-type': 'application/json', 'accept-language': 'en' };
    const api = async (route, body, { signal, language = 'en' } = {}) => {
      const response = await fetch(host.url + '/api/' + route, { method: body === undefined ? 'GET' : 'POST', headers: { ...headers, 'accept-language': language }, body: body === undefined ? undefined : JSON.stringify(body), signal });
      return { status: response.status, body: await response.json() };
    };
    const project = (await api('projects', { path: projectPath })).body, route = `projects/${project.id}/open`;

    await t.test('success is returned only after launcher exit and the file stays unchanged', async () => {
      let settled = false; const result = api(route, { path: '中文.txt' }).then(value => { settled = true; return value; });
      await until(() => launches.length === 1 && readFile(launches[0].marker).then(() => true, () => false)); assert.equal(settled, false);
      const response = await result; assert.equal(response.status, 200); assert.deepEqual(response.body, { ok: true, accepted: true });
      assert.equal(alive(launches[0].pid), false); assert.equal(await readFile(path.join(projectPath, '中文.txt'), 'utf8'), 'kept\r\n');
    });
    await t.test('nonzero and spawn errors expose localized codes without launcher text', async () => {
      for (const [nextMode, code, language, index] of [['fail', 'FILE_OPEN_FAILED', 'en', 1], ['missing', 'FILE_OPEN_UNAVAILABLE', 'zh-CN', 0]]) {
        mode = nextMode; const result = await api(route, { path: '中文.txt' }, { language });
        assert.equal(result.status, 400); assert.equal(result.body.code, code); assert.equal(result.body.message, fileErrors[code][index]);
        assert.equal(JSON.stringify(result.body).includes('PRIVATE_LAUNCHER_DETAIL'), false); assert.equal(JSON.stringify(result.body).includes(projectPath), false);
      }
    });
    await t.test('project traversal and an external symlink never launch', async () => {
      await writeFile(path.join(root, 'outside.txt'), 'outside'); await symlink(path.join(root, 'outside.txt'), path.join(projectPath, 'alias.txt'));
      const count = launches.length;
      for (const relative of ['../outside.txt', 'alias.txt']) assert.equal((await api(route, { path: relative })).body.code, 'OUTSIDE_PROJECT');
      assert.equal(launches.length, count);
    });
    await t.test('HTTP disconnect terminates and waits for its own ignoring launcher', async () => {
      mode = 'ignore'; const previous = launches.length, controller = new AbortController();
      const pending = api(route, { path: '中文.txt' }, { signal: controller.signal }).then(value => ({ value }), error => ({ error }));
      await until(() => launches.length > previous && readFile(launches.at(-1).marker).then(() => true, () => false));
      const child = launches.at(-1), firstActivity = (await api('state')).body.activities.find(row => row.pluginId === 'feature-files' && row.kind === 'command');
      assert.equal(firstActivity.kind, 'command'); assert.equal(firstActivity.projectId, project.id);
      assert.equal((await api('state')).body.activities.find(row => row.pluginId === 'feature-files' && row.kind === 'command').id, firstActivity.id);
      controller.abort(); assert.equal((await pending).error.name, 'AbortError'); await until(() => !alive(child.pid));
      assert.equal((await api('state')).body.activities.some(row => row.id === firstActivity.id), false);
      mode = 'success'; assert.equal((await api(route, { path: '中文.txt' })).status, 200);
    });
    await t.test('plugin disable cancels a pending open and leaves files available after re-enable', async () => {
      mode = 'ignore'; const previous = launches.length, pending = api(route, { path: '中文.txt' });
      await until(() => launches.length > previous && readFile(launches.at(-1).marker).then(() => true, () => false)); const child = launches.at(-1);
      const disabled = await api('plugins/feature-files/disable', {}); assert.equal(disabled.status, 200);
      const cancelled = await pending; assert.equal(cancelled.body.code, 'FILE_OPEN_CANCELLED'); assert.equal(alive(child.pid), false);
      assert.equal(await readFile(path.join(projectPath, '中文.txt'), 'utf8'), 'kept\r\n');
      assert.equal((await api('plugins/feature-files/enable', {})).status, 200);
      mode = 'success'; assert.equal((await api(route, { path: '中文.txt' })).status, 200);
    });
  } finally { await host?.close(); intercept?.mock.restore(); syncBuiltinESMExports(); for (const child of launches) if (child.pid && alive(child.pid)) try { process.kill(child.pid, 'SIGKILL'); } catch {} await rm(root, { recursive: true, force: true }); }
});
