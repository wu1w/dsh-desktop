import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runProjectCommand } from '../server/project-commands.mjs';
import { startHost } from '../server/index.mjs';
import http from 'node:http';
import { once } from 'node:events';
import {windows,commandShell,nodeCommand,outputCommand,assertStopped} from './fixtures/command-platform.mjs';

const quote = text => "'" + text.replaceAll("'", "'\\''") + "'";
const stubborn = marker => nodeCommand(`process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000);`);
async function waitMarker(file) {
  for (let n = 0; n < 100; n++) {
    try { const pid=Number(await readFile(file, 'utf8')); if(Number.isSafeInteger(pid)&&pid>0)return pid; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('CHILD_NOT_READY');
}

test('command deadline kills a process ignoring TERM and clears the owned registry', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'dsh-command-deadline-'));
  const commands = new Set();
  try {
    const marker = path.join(directory, 'ready');
    const pending = runProjectCommand({ command: stubborn(marker), cwd: directory, commands, shell: commandShell, timeoutMs: 1500, killGraceMs: 100 });
    const pid = await waitMarker(marker);
    const result = await pending;
    assertStopped(result); assert.equal(commands.size, 0);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('terminal plugin disable waits for its actual process to end; routes stop and re-enable cleanly', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'dsh-terminal-lifecycle-'));
  let host;
  try {
    host = await startHost({ dataDir: path.join(directory, 'owned'), autoStart: false });
    const response = await fetch(host.url + '/api/bootstrap');
    const boot = await response.json();
    const headers = { cookie: response.headers.get('set-cookie').split(';')[0], 'x-dsh-capability': boot.capability, 'content-type': 'application/json' };
    const post = async (route, body) => fetch(host.url + '/api/' + route, { method: 'POST', headers, body: JSON.stringify(body) });
    const project = await (await post('projects', { path: directory, name: 'Terminal lifecycle' })).json();
    const marker = path.join(directory, 'ready');
    const pending = post(`projects/${project.id}/terminal`, { command: stubborn(marker) });
    const pid = await waitMarker(marker);
    assert.equal((await post('plugins/feature-terminal/disable', {})).status, 200);
    assertStopped(await (await pending).json());
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    assert.equal((await post(`projects/${project.id}/terminal`, { command: outputCommand('disabled') })).status, 404);
    assert.equal((await post('plugins/feature-terminal/enable', {})).status, 200);
    assert.equal((await (await post(`projects/${project.id}/terminal`, { command: outputCommand('resumed') })).json()).output, 'resumed');
    const secondMarker = path.join(directory, 'second-ready');
    const secondPending = post(`projects/${project.id}/terminal`, { command: stubborn(secondMarker) });
    const secondPid = await waitMarker(secondMarker);
    const closing = host.close();
    const duringShutdown = await post(`projects/${project.id}/terminal`, { command: 'printf should-not-run' });
    assert.equal((await duringShutdown.json()).code, 'HOST_STOPPING');
    await closing; host = null;
    assertStopped(await (await secondPending).json());
    assert.throws(() => process.kill(secondPid, 0), { code: 'ESRCH' });
  } finally { await host?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('terminal capture bounds bytes and rejects spawn failures without retaining a process', async () => {
  const commands = new Set();
  const result = await runProjectCommand({ command: outputCommand('123456789'), cwd: tmpdir(), commands, shell: commandShell, maxOutputBytes: 4 });
  assert.equal(result.output, '1234');
  const unicode = await runProjectCommand({ command: outputCommand('你好世界'), cwd: tmpdir(), commands, shell: commandShell, maxOutputBytes: 6 });
  assert.equal(unicode.output, '你好');
  await assert.rejects(runProjectCommand({ command: 'true', cwd: tmpdir(), commands, shell: '/missing/dsh-test-shell' }), { code: windows?'COMMAND_START_FAILED':'ENOENT' });
  assert.equal(commands.size, 0);
});

test('a redirected background descendant is reaped even after its shell has already exited', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'dsh-command-background-'));
  const commands = new Set();
  try {
    const marker = path.join(directory, 'ready');
    const code = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000);`;
    const posixCommand = `${quote(process.execPath)} -e ${quote(code)} >/dev/null 2>&1 & dsh_child_pid=$!; while [ ! -f ${quote(marker)} ]; do sleep 0.01; done; printf "$dsh_child_pid"`;
    const command=windows?nodeCommand(`const p=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(code)}],{detached:true,stdio:'ignore'});p.unref();const fs=require('node:fs');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(marker)})){clearInterval(timer);process.stdout.write(String(p.pid));}},10);`):posixCommand;
    const result = await runProjectCommand({ command, cwd: directory, commands, shell: commandShell, timeoutMs: 3000, killGraceMs: 100 });
    assert.equal(result.code, 0); assert.equal(commands.size, 0);
    const pid = Number(result.output);
    assert.equal(pid, await waitMarker(marker));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('host shutdown aborts a half-uploaded request instead of waiting indefinitely for its body', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'dsh-host-half-upload-'));
  let host, upload;
  try {
    host = await startHost({ dataDir: directory, autoStart: false });
    const response = await fetch(host.url + '/api/bootstrap');
    const boot = await response.json();
    upload = http.request(host.url + '/api/preferences', { method: 'POST', headers: {
      cookie: response.headers.get('set-cookie').split(';')[0], 'x-dsh-capability': boot.capability,
      'content-type': 'application/json', 'content-length': '1000', expect: '100-continue',
    } });
    const disconnected = new Promise(resolve => upload.on('error', resolve));
    const closed = new Promise(resolve => upload.once('close', resolve));
    upload.flushHeaders(); await once(upload, 'continue'); upload.write('{');
    const started = Date.now();
    await host.close(); host = null;
    assert.ok(Date.now() - started < 2000);
    await disconnected; await closed;
    assert.equal(upload.socket.destroyed, true);
  } finally { upload?.destroy(); await host?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a new-session child with redirected pipes never produces a false complete-cleanup claim',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'dsh-command-new-session-')),commands=new Set();let pid;
 try{
  const marker=path.join(directory,'owned-pid'),worker=`require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000);`;
  const leader=`const fs=require('node:fs'),p=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(worker)}],{detached:true,stdio:'ignore'});p.unref();const waiting=setInterval(()=>{if(fs.existsSync(${JSON.stringify(marker)})){clearInterval(waiting);process.stdout.write(String(p.pid));}},5);`;
  const result=await runProjectCommand({command:nodeCommand(leader),cwd:directory,commands,shell:commandShell,timeoutMs:5000});pid=Number(result.output);assert.ok(Number.isSafeInteger(pid)&&pid>1);assert.equal(pid,await waitMarker(marker));
  if(windows){assert.deepEqual(result.cleanup,{verified:true,scope:'kernel-job'});assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});}
  else{assert.deepEqual(result.cleanup,{verified:false,scope:'process-group',reason:'detached_descendants_unverified'});assert.doesNotThrow(()=>process.kill(pid,0));}
 }finally{
  // This PID is published by this fixture's handshaken child, not discovered
  // by scanning user processes. Cleanup stays inside the fixture lifetime.
  if(pid)try{process.kill(pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}
  await rm(directory,{recursive:true,force:true});
 }
});
