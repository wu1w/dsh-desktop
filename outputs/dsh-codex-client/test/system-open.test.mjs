import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SystemOpener } from '../server/system-open.mjs';
import { fileErrors } from '../shared/file-errors.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(check) { const end = Date.now() + 3000; while (!await check()) { if (Date.now() > end) throw Error('FIXTURE_TIMEOUT'); await sleep(5); } }
const launcher = String.raw`
const fs=require('node:fs');
const [mode,marker,target]=process.argv.slice(1);
if(mode==='ignore')process.on('SIGTERM',()=>{});
fs.writeFileSync(marker,JSON.stringify({pid:process.pid,target}));
if(mode==='success'){setTimeout(()=>process.exit(0),120);}
else if(mode==='fail'){process.stderr.write('PRIVATE_LAUNCHER_SECRET '+target);process.exitCode=7;}
else if(mode==='noisy'){process.stderr.write(Buffer.alloc(512*1024,65),()=>process.exit(3));}
else if(mode==='handoff'){
 const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','ignore',2]});
 fs.writeFileSync(marker,JSON.stringify({pid:process.pid,target,appPid:child.pid}));child.unref();process.exit(0);
}else setInterval(()=>{},1000);
`;
function fixtureSpawn(mode, marker, observed = []) {
  return (command, args, options) => {
    const child = spawn(process.execPath, ['-e', launcher, '--', mode, marker, ...args], options);
    observed.push({ command, args, options, pid: child.pid });
    return child;
  };
}
async function temporary(action) { const root = await mkdtemp(path.join(tmpdir(), 'dsh-system-open-')); try { await action(root); } finally { await rm(root, { recursive: true, force: true }); } }

test('system launcher success waits for exit zero and does not modify target or inherit provider secrets', async () => temporary(async root => {
  const target = path.join(root, '-中文.txt'), marker = path.join(root, 'marker.json'), observed = [];
  await writeFile(target, '原始 bytes\r\n');
  const opener = new SystemOpener({ spawnImpl: fixtureSpawn('success', marker, observed), platform: 'darwin' });
  try {
    let finished = false; const pending = opener.open(target).then(value => { finished = true; return value; });
    await until(() => readFile(marker).then(() => true, () => false));
    assert.equal(finished, false); assert.equal(opener.operations.size, 1);
    assert.deepEqual(await pending, { ok: true, accepted: true });
    assert.equal(opener.operations.size, 0); assert.equal(alive(observed[0].pid), false);
    assert.equal(observed[0].command, '/usr/bin/open'); assert.deepEqual(observed[0].args, [target]); assert.equal(observed[0].options.shell, false);
    assert.ok(!Object.keys(observed[0].options.env).some(key => /(?:TOKEN|API_KEY|AUTHORIZATION|SECRET)/i.test(key)));
    assert.equal(await readFile(target, 'utf8'), '原始 bytes\r\n');
  } finally { await opener.close(); }
}));

test('spawn failures and nonzero launcher exits return fixed codes without stderr or paths', async () => temporary(async root => {
  const target = path.join(root, 'secret-target'), marker = path.join(root, 'marker.json'); await writeFile(target, 'kept');
  const absent = new SystemOpener({ spawnImpl: (_command, args, options) => spawn(path.join(root, 'missing-launcher'), args, options) });
  await assert.rejects(absent.open(target), { code: 'FILE_OPEN_UNAVAILABLE', message: 'FILE_OPEN_UNAVAILABLE' });
  assert.equal(absent.operations.size, 0); await absent.close();
  for (const mode of ['fail', 'noisy']) {
    const opener = new SystemOpener({ spawnImpl: fixtureSpawn(mode, marker), stderrLimitBytes: 128 });
    const pending = opener.open(target), operation = [...opener.operations.values()][0];
    await assert.rejects(pending, error => { assert.equal(error.code, 'FILE_OPEN_FAILED'); assert.equal(error.message, 'FILE_OPEN_FAILED'); assert.equal(JSON.stringify(error).includes(target), false); return true; });
    assert.ok(operation.stderrBytes <= 129); assert.equal(opener.operations.size, 0); await opener.close();
  }
  assert.equal(await readFile(target, 'utf8'), 'kept');
}));

test('timeout escalates an ignoring launcher to SIGKILL and waits for its exit', async () => temporary(async root => {
  const observed = [], opener = new SystemOpener({ spawnImpl: fixtureSpawn('ignore', path.join(root, 'marker'), observed), timeoutMs: 200, killGraceMs: 35 });
  try {
    const began = Date.now();
    await assert.rejects(opener.open(path.join(root, 'target')), { code: 'FILE_OPEN_TIMEOUT' });
    assert.ok(Date.now() - began >= 225); assert.equal(alive(observed[0].pid), false); assert.equal(opener.operations.size, 0);
  } finally { await opener.close(); }
}));

test('abort, concurrency limit and close clean owned launchers and reject future opens', async () => temporary(async root => {
  const marker = path.join(root, 'marker'), observed = [], controller = new AbortController();
  const opener = new SystemOpener({ spawnImpl: fixtureSpawn('ignore', marker, observed), maxConcurrent: 1, killGraceMs: 30 });
  try {
    const pending = opener.open(path.join(root, 'target'), { signal: controller.signal });
    const rejected = assert.rejects(pending, { code: 'FILE_OPEN_CANCELLED' });
    await until(() => readFile(marker).then(() => true, () => false));
    await assert.rejects(opener.open(path.join(root, 'second')), { code: 'FILE_OPEN_BUSY' });
    controller.abort(); await rejected; assert.equal(alive(observed[0].pid), false);
    const second = opener.open(path.join(root, 'third')), secondRejected = assert.rejects(second, { code: 'FILE_OPEN_CANCELLED' });
    await opener.close(); await secondRejected; await opener.close();
    assert.equal(alive(observed[1].pid), false); assert.equal(opener.operations.size, 0);
    await assert.rejects(opener.open(path.join(root, 'fourth')), { code: 'FILE_OPEN_CLOSED' });
  } finally { await opener.close(); }
}));

test('preaborted and invalid paths never spawn a launcher', async () => {
  let calls = 0; const opener = new SystemOpener({ spawnImpl: () => { calls++; throw Error('SHOULD_NOT_RUN'); } });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(opener.open('/isolated', { signal: controller.signal }), { code: 'FILE_OPEN_CANCELLED' });
  for (const target of ['relative', '/contains\0null', undefined]) await assert.rejects(opener.open(target), { code: 'FILE_OPEN_INVALID_PATH' });
  assert.equal(calls, 0); await opener.close();
  const unsupported = new SystemOpener({ platform: 'unsupported' });
  await assert.rejects(unsupported.open('/target'), { code: 'FILE_OPEN_UNAVAILABLE' }); await unsupported.close();
});

test('an unconfirmed kill returns a bounded cleanup error and retains activity until a real late exit', async () => {
  const child = new EventEmitter(), kills = [];
  child.pid = 123456789; child.kill = signal => { kills.push(signal); return false; };
  const opener = new SystemOpener({ spawnImpl: () => child, timeoutMs: 5, killGraceMs: 5, cleanupWaitMs: 15 });
  await assert.rejects(opener.open('/isolated'), { code: 'FILE_OPEN_CLEANUP_FAILED' });
  assert.deepEqual(kills, ['SIGTERM', 'SIGKILL']); assert.equal(opener.operations.size, 1);
  await assert.rejects(opener.close(), { code: 'FILE_OPEN_CLEANUP_FAILED' });
  child.emit('exit', null, 'SIGKILL'); assert.equal(opener.operations.size, 0); await opener.close();
});

test('launcher handoff succeeds on exit even if an independent application inherits stderr; close preserves that app', async () => temporary(async root => {
  const marker = path.join(root, 'handoff'), opener = new SystemOpener({ spawnImpl: fixtureSpawn('handoff', marker), timeoutMs: 500 });
  let appPid;
  try {
    assert.deepEqual(await opener.open(path.join(root, 'target')), { ok: true, accepted: true });
    const row = JSON.parse(await readFile(marker)); appPid = row.appPid;
    assert.equal(alive(row.pid), false); assert.equal(alive(appPid), true);
    await opener.close(); assert.equal(alive(appPid), true);
  } finally { await opener.close(); if (appPid) try { process.kill(appPid, 'SIGKILL'); } catch {} }
}));

test('system open errors have centralized bilingual resources', () => {
  for (const [code, value] of Object.entries(fileErrors).filter(([code]) => code.startsWith('FILE_OPEN_'))) { assert.equal(value.length, 2); assert.ok(value.every(text => typeof text === 'string' && text.length)); assert.notEqual(value[0], value[1], code); }
});
