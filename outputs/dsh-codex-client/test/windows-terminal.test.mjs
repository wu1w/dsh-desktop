import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {windowsEnvironment,windowsShell,windowsCommandArgs,windowsJobCommand,stopWindowsJob} from '../server/windows-process.mjs';
import {ProjectPtyManager} from '../server/project-pty.mjs';
import {runProjectCommand,stopProjectCommands} from '../server/project-commands.mjs';
const env={SystemRoot:'C:\\Windows',Path:'C:\\tools;C:\\Windows\\System32',PATHEXT:'.COM;.EXE;.BAT;.CMD',USERPROFILE:'C:\\Users\\小白',TEMP:'C:\\Temp',ANTHROPIC_API_KEY:'secret',OPENAI_API_KEY:'secret',DSH_OPENCODE_GO_KEY:'secret'};
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('Windows shell/env resolve system binaries and do not inherit model keys',()=>{
 const safe=windowsEnvironment(env);assert.equal(safe.PATH,env.Path);assert.equal(safe.Path,undefined);assert.equal(safe.USERPROFILE,env.USERPROFILE);assert(!JSON.stringify(safe).includes('secret'));
 assert.equal(windowsShell(env),'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
 const command='Write-Output "中文 & $text"';const args=windowsCommandArgs(windowsShell(env),command);assert(Buffer.from(args.at(-1),'base64').toString('utf16le').endsWith(command));assert(Buffer.from(args.at(-1),'base64').toString('utf16le').includes('UTF8Encoding'));
 assert.deepEqual(windowsCommandArgs('C:\\Windows\\System32\\cmd.exe','echo ok'),['/d','/s','/c','echo ok']);
});
test('Job launcher quotes app path, serializes arguments and never weakens execution policy',async()=>{
 const launch=windowsJobCommand('C:\\Users\\O\'Brien\\shell.exe',['a b','中文','x"y'],{env,source:"C:\\DSH app\\O'Brien\\windows-job.cs"});
 const script=Buffer.from(launch.args.at(-1),'base64').toString('utf16le');assert(script.includes("O''Brien"));assert(!launch.args.includes('-ExecutionPolicy'));assert(!script.includes('Set-ExecutionPolicy'));assert(script.includes('[Dsh.WindowsJob]::Run'));
 const source=await readFile(new URL('../server/windows-job.cs',import.meta.url),'utf8');assert(source.includes('limits.basic.flags=0x2000'));assert(source.indexOf('Check(AssignProcessToJobObject')<source.indexOf('Check(ResumeThread'));assert(source.includes('CloseHandle(job)'));assert(source.includes('OpenProcess(0x100000,false'));assert(source.includes('new IntPtr[]{process.process,host,stop.SafeWaitHandle.DangerousGetHandle()}'));assert(source.indexOf('host=OpenProcess')<source.indexOf('Check(CreateProcess'));assert(script.includes('[string[]]$dshArgs,'+process.pid+','));
});
test('stop signals an unguessable per-job event with bounded wait, never a numeric process ID',async()=>{
 const first=windowsJobCommand(windowsShell(env),[],{env}),second=windowsJobCommand(windowsShell(env),[],{env});assert.notEqual(first.stopEvent,second.stopEvent);
 let call;await stopWindowsJob(first.stopEvent,{env,execFileImpl:(...args)=>{call=args;args.at(-1)(null);}});assert.equal(call[0],windowsShell(env));assert.equal(call[2].windowsHide,true);assert.equal(call[2].timeout,7000);assert(!JSON.stringify(call[2].env).includes('secret'));
 const script=Buffer.from(call[1].at(-1),'base64').toString('utf16le');assert(script.includes(first.stopEvent));assert(script.includes('OpenExisting'));assert(!script.includes('taskkill'));assert(!script.includes('Stop-Process'));assert(script.includes('AddSeconds(5)'));
 await assert.rejects(stopWindowsJob(123),{code:'WINDOWS_JOB_INVALID'});await assert.rejects(stopWindowsJob("Local\\DSH-';Stop-Process -Id 1"),{code:'WINDOWS_JOB_INVALID'});
});
async function fixture(t,extra={}){
 const cwd=await mkdtemp(path.join(tmpdir(),'dsh-windows-pty-'));let data,exit,captured;const writes=[],sizes=[];
 const pty={pid:123,write:value=>writes.push(value),resize:(...value)=>sizes.push(value),onData:fn=>{data=fn;return{dispose(){}};},onExit:fn=>{exit=fn;return{dispose(){}};},kill(){exit({exitCode:0});}};
 const {stopJob,...options}=extra;const manager=new ProjectPtyManager({platform:'win32',env,loadPty:async()=>({spawn:(...args)=>{captured=args;return pty;}}),...options,stopJob:async(...args)=>{await stopJob?.(...args);exit({exitCode:125});}});
 t.after(async()=>{await manager.close().catch(()=>{});await rm(cwd,{recursive:true,force:true});});
 const terminal=await manager.create({projectId:'p',cwd,cols:80,rows:24});
 return{manager,terminal,pty,writes,sizes,data:value=>data(value),exit:value=>exit(value),captured};
}
test('Windows ConPTY path preserves project ownership, UTF8 input/output, resize and tree shutdown',async t=>{
 const stopped=[];const f=await fixture(t,{stopJob:async pid=>stopped.push(pid)});assert.equal(f.captured[0],windowsShell(env));assert.equal(f.captured[2].useConpty,true);assert(!JSON.stringify(f.captured[2].env).includes('secret'));
 f.data('中文 output');assert.equal(f.manager.read('p',f.terminal.id).output,'中文 output');await f.manager.write('p',f.terminal.id,'你好\r');assert.deepEqual(f.writes,['你好\r']);await f.manager.resize('p',f.terminal.id,{cols:110,rows:40});assert.deepEqual(f.sizes,[[110,40]]);
 await assert.rejects(f.manager.write('other',f.terminal.id,'x'),{code:'PTY_NOT_FOUND'});await assert.rejects(f.manager.resize('p',f.terminal.id,{cols:1,rows:40}),{code:'PTY_INVALID_SIZE'});
 const result=await f.manager.stop('p',f.terminal.id);assert.equal(stopped.length,1);assert.match(stopped[0],/^Local\\DSH-/);assert.equal(result.status,'exited');assert.equal(result.cleanupPending,undefined);
});
test('Windows stop failure remains visible and can be retried',async t=>{
 let failed=true;const f=await fixture(t,{stopJob:async()=>{if(failed)throw Error('denied');}});await assert.rejects(f.manager.stop('p',f.terminal.id),{code:'PTY_STOP_FAILED'});await tick();assert.equal(f.manager.read('p',f.terminal.id).cleanupPending,true);failed=false;assert.equal((await f.manager.stop('p',f.terminal.id)).status,'exited');
});
test('Windows unavailable native addon reports actionable code, natural exit maps job launch failure',async t=>{
 const f=await fixture(t);f.data('DSH_WINDOWS_JOB_FAILED\r\n');f.exit({exitCode:125});assert.equal(f.manager.read('p',f.terminal.id).error,'PTY_START_FAILED');
 const unavailable=new ProjectPtyManager({platform:'win32',env,loadPty:async()=>{throw Error('missing native module');}});await assert.rejects(unavailable.create({projectId:'p',cwd:tmpdir()}),{code:'PTY_HELPER_MISSING'});await unavailable.close();
});
test('Windows captured command uses Job supervisor, safe arguments and tree stop without POSIX signals',async()=>{
 const commands=new Set();let child,launch;const command='Write-Output "中文 $value"';let killed;
 const pending=runProjectCommand({command,cwd:tmpdir(),commands,platform:'win32',env,spawnProcess:(...args)=>{launch=args;child=new EventEmitter();child.pid=456;child.stdout=new PassThrough();child.stderr=new PassThrough();return child;},stopJob:async pid=>{killed=pid;child.emit('close',1,null);}});
 await tick();assert.equal(launch[2].detached,false);assert.equal(launch[0],windowsShell(env));const script=Buffer.from(launch[1].at(-1),'base64').toString('utf16le');assert(script.includes('[Dsh.WindowsJob]::Run'));child.stdout.write('captured');await stopProjectCommands(commands);const result=await pending;assert.equal(result.output,'captured');assert.match(killed,/^Local\\DSH-/);assert.equal(commands.size,0);
});
test('natural Windows Job exit settles capture; startup error cannot be mistaken for successful command',async()=>{
 for(const [code,text]of [[0,'done'],[125,'DSH_WINDOWS_JOB_FAILED']]){
  const commands=new Set();let child;const pending=runProjectCommand({command:'echo test',cwd:tmpdir(),commands,platform:'win32',env,spawnProcess:()=>{child=new EventEmitter();child.pid=789;child.stdout=new PassThrough();child.stderr=new PassThrough();return child;},stopJob:async()=>assert.fail('finished supervisor already closed its job')});
  const settled=pending.then(value=>({value}),error=>({error}));child.stdout.write(text);child.emit('close',code,null);const result=await settled;if(code===0)assert.equal(result.value.output,'done');else assert.equal(result.error.code,'COMMAND_START_FAILED');assert.equal(commands.size,0);
 }
});

test('Claude plugin does not mistake shared Codex binary option for Claude executable',async t=>{
 const {apply}=await import('../server/plugins/engine-claude-code.mjs');const {mkdir,writeFile}=await import('node:fs/promises');const root=await mkdtemp(path.join(tmpdir(),'dsh-cli-plugin-'));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(path.join(root,'claude-engine','lib'),{recursive:true});await writeFile(path.join(root,'claude-engine','package.json'),'{"type":"module"}');await writeFile(path.join(root,'claude-engine','lib','engine.js'),'export class ClaudeCodeEngine{constructor(options){this.options=options;}async dispose(){}}');
 let factory;apply({effect:fn=>{fn();return()=>{};}},{appRoot:root,registerEngine:(_id,value)=>{factory=value;return()=>{};}});const {engine}=await factory.create({binary:'/codex/bin/codex'});assert.equal(engine.options.binary,undefined);assert.equal(engine.options.appRoot,root);const explicit=await factory.create({binary:'/codex/bin/codex',claudeBinary:'/custom/claude'});assert.equal(explicit.engine.options.binary,'/custom/claude');
});


test('Windows native input and resize failures stay actionable and preserve terminal dimensions',async t=>{
 const f=await fixture(t);f.pty.write=()=>{throw Error('native pipe closed');};f.pty.resize=()=>{throw Error('native console closed');};
 await assert.rejects(f.manager.write('p',f.terminal.id,'中文'),{code:'PTY_NOT_RUNNING'});await assert.rejects(f.manager.resize('p',f.terminal.id,{cols:120,rows:50}),{code:'PTY_NOT_RUNNING'});assert.equal(f.manager.read('p',f.terminal.id).cols,80);assert.equal(f.manager.read('p',f.terminal.id).rows,24);assert.equal(f.manager.sessions.get(f.terminal.id).queuedBytes,0);
});
test('natural Windows exit racing a delayed stop never calls a PID-based kill',async t=>{
 let rejectStop;const f=await fixture(t,{stopJob:()=>new Promise((_resolve,reject)=>{rejectStop=reject;})});f.pty.kill=()=>assert.fail('must not call node-pty numeric PID cleanup');
 const stopping=f.manager.stop('p',f.terminal.id);await tick();f.exit({exitCode:0});rejectStop(Error('event disappeared after natural exit'));const result=await stopping;assert.equal(result.status,'exited');assert.equal(result.cleanupPending,undefined);
});
test('captured command natural close racing a failed stop signal releases ownership without another kill',async()=>{
 const commands=new Set();let child,rejectStop;const pending=runProjectCommand({command:'test',cwd:tmpdir(),commands,platform:'win32',env,spawnProcess:()=>{child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();return child;},stopJob:()=>new Promise((_resolve,reject)=>{rejectStop=reject;})});
 const stopping=stopProjectCommands(commands);await tick();child.emit('close',0,null);await tick();rejectStop(Error('event closed'));await stopping;assert.equal((await pending).code,0);assert.equal(commands.size,0);
});
