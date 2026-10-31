import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
import {mkdtemp,writeFile,readFile,rm,mkdir,stat,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url),modulePath=fileURLToPath(new URL('../desktop/process-supervisor.cjs',import.meta.url));
const {ProcessSupervisor,acquireSupervisorLock,childEnvironment,launcherScript,packagedExecutable,translator,attachShutdownSignals,runCli}=require(modulePath);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,ms=3000){const end=Date.now()+ms;while(Date.now()<end){if(await check())return;await delay(10);}assert.fail('supervisor fixture timed out');}
async function fixture(source){const directory=await mkdtemp(path.join(tmpdir(),'dsh-supervisor-')),file=path.join(directory,'child.cjs'),log=path.join(directory,'events.jsonl');await writeFile(file,source);return {directory,file,log,clean:()=>rm(directory,{recursive:true,force:true})};}
async function records(file){try{return(await readFile(file,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch(error){if(error.code==='ENOENT')return[];throw error;}}
const header="const fs=require('node:fs'),log=process.env.OWNED_SUPERVISOR_LOG;function record(v){fs.appendFileSync(log,JSON.stringify(v)+'\\n');}";
function fakeRuntime(){let now=0,id=0;const timers=new Map(),children=[];return{timers,children,jump:value=>{now+=value;},runtime:{now:()=>now,setTimer:(fn,ms)=>{timers.set(++id,{fn,ms});return id;},clearTimer:id=>timers.delete(id),spawn:()=>{const child=new EventEmitter();child.pid=100+children.length;child.signals=[];child.kill=signal=>{child.signals.push(signal);return true;};children.push(child);return child;}},fire(){const [id,value]=timers.entries().next().value;timers.delete(id);now+=value.ms;value.fn();return value.ms;}};}

test('crash backoff is capped and a stable 60-second run resets it; a normal exit never restarts',async()=>{
 const fake=fakeRuntime(),events=[],supervisor=new ProcessSupervisor({executable:process.execPath,runtime:fake.runtime,onEvent:e=>events.push(e)});supervisor.start();
 for(const expected of [1000,2000,4000,8000,16000,30000,30000]){fake.children.at(-1).emit('exit',9,null);assert.equal(fake.fire(),expected);}
 fake.jump(60000);fake.children.at(-1).emit('exit',null,'SIGTERM');assert.equal(fake.fire(),1000);fake.children.at(-1).emit('exit',0,null);
 assert.equal((await supervisor.done).reason,'normal');assert.equal(fake.timers.size,0);assert.equal(supervisor.child,null);assert.equal(events.filter(e=>e.type==='restart').length,8);
});
test('stopping during backoff cancels every restart and sends no signals to a prior child',async()=>{
 const fake=fakeRuntime(),supervisor=new ProcessSupervisor({executable:process.execPath,runtime:fake.runtime});supervisor.start();const child=fake.children[0];child.emit('exit',1,null);await supervisor.stop();assert.equal(fake.timers.size,0);assert.deepEqual(child.signals,[]);assert.equal(fake.children.length,1);supervisor.start();assert.equal(fake.children.length,1);
});
test('signal listeners stop only the owned child and are removable',async()=>{
 const fake=fakeRuntime(),supervisor=new ProcessSupervisor({executable:process.execPath,runtime:fake.runtime}),signals=new EventEmitter(),detach=attachShutdownSignals(supervisor,signals);supervisor.start();signals.emit('SIGINT');signals.emit('SIGTERM');assert.deepEqual(fake.children[0].signals,['SIGTERM']);fake.children[0].emit('exit',0,null);await supervisor.done;detach();for(const signal of ['SIGINT','SIGTERM','SIGHUP'])assert.equal(signals.listenerCount(signal),0);assert.equal(fake.timers.size,0);
});
test('real child crashes twice, receives no Node-mode flag, then exits normally without another restart',{timeout:5000},async()=>{
 const f=await fixture(header+"const n=fs.existsSync(log)?fs.readFileSync(log,'utf8').trim().split('\\n').length:0;record({pid:process.pid,nodeMode:process.env.ELECTRON_RUN_AS_NODE??null,attempt:n+1});process.exit(n<2?7:0);");
 const events=[],supervisor=new ProcessSupervisor({executable:process.execPath,args:[f.file],env:{...process.env,ELECTRON_RUN_AS_NODE:'1',OWNED_SUPERVISOR_LOG:f.log},baseDelayMs:20,maxDelayMs:40,onEvent:e=>events.push(e)});
 try{const result=await supervisor.start();assert.equal(result.code,0);assert.equal(result.reason,'normal');const rows=await records(f.log);assert.equal(rows.length,3);assert.equal(new Set(rows.map(r=>r.pid)).size,3);assert.ok(rows.every(r=>r.nodeMode===null));assert.deepEqual(events.filter(e=>e.type==='restart').map(e=>e.delayMs),[20,40]);assert.equal(supervisor.child,null);assert.equal(supervisor.restartTimer,null);await delay(60);assert.equal((await records(f.log)).length,3);}finally{await supervisor.stop();await f.clean();}
});
test('a real signal-terminated child restarts once, and the next normal exit finishes',{timeout:5000},async()=>{
 const f=await fixture(header+"const first=!fs.existsSync(log);record({pid:process.pid});if(first)process.kill(process.pid,'SIGTERM');else process.exit(0);");const supervisor=new ProcessSupervisor({executable:process.execPath,args:[f.file],env:{...process.env,OWNED_SUPERVISOR_LOG:f.log},baseDelayMs:15,maxDelayMs:15});
 try{assert.equal((await supervisor.start()).code,0);assert.equal((await records(f.log)).length,2);}finally{await supervisor.stop();await f.clean();}
});
test('bounded shutdown kills only its real SIGTERM-ignoring child and leaves no restart timer',{timeout:5000},async()=>{
 const f=await fixture(header+"process.on('SIGTERM',()=>record({signal:'SIGTERM'}));record({pid:process.pid,ready:true});setInterval(()=>{},1000);");const supervisor=new ProcessSupervisor({executable:process.execPath,args:[f.file],env:{...process.env,OWNED_SUPERVISOR_LOG:f.log},stopTimeoutMs:30,killTimeoutMs:1000});
 try{supervisor.start();await until(async()=>(await records(f.log)).some(r=>r.ready));const pid=supervisor.child.pid;const result=await supervisor.stop();assert.equal(result.lastExit.signal,'SIGKILL');assert.equal(supervisor.child,null);assert.equal(supervisor.restartTimer,null);assert.equal(supervisor.stopTimer,null);assert.equal(supervisor.killTimer,null);assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});assert.ok((await records(f.log)).some(r=>r.signal==='SIGTERM'));}finally{await supervisor.stop();await f.clean();}
});
test('a real supervisor process receiving SIGTERM cleans its child before exiting',{timeout:6000},async()=>{
 const f=await fixture(header+"process.on('SIGTERM',()=>{});record({pid:process.pid,ready:true});setInterval(()=>{},1000);"),wrapper=path.join(f.directory,'owner.cjs');
 await writeFile(wrapper,"const {ProcessSupervisor,attachShutdownSignals}=require("+JSON.stringify(modulePath)+");const s=new ProcessSupervisor({executable:process.execPath,args:["+JSON.stringify(f.file)+"],stopTimeoutMs:40,killTimeoutMs:1000});const detach=attachShutdownSignals(s);s.start().then(result=>{detach();process.exitCode=result.code;});");
 const owner=spawn(process.execPath,[wrapper],{env:{...process.env,OWNED_SUPERVISOR_LOG:f.log},stdio:'ignore'});let exited=false;const done=new Promise((resolve,reject)=>{owner.on('error',reject);owner.on('exit',(code,signal)=>{exited=true;resolve({code,signal});});});
 try{await until(async()=>(await records(f.log)).some(r=>r.ready));const pid=(await records(f.log))[0].pid;owner.kill('SIGTERM');assert.deepEqual(await done,{code:0,signal:null});assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});assert.equal((await records(f.log)).filter(r=>r.ready).length,1);}finally{if(!exited){owner.kill('SIGTERM');await done;}await f.clean();}
});
test('supervisor lock is distinct from data lock, rejects duplicates, and loss stops its child',{timeout:6000},async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'dsh-supervisor-lock-')),fake=fakeRuntime(),supervisor=new ProcessSupervisor({executable:process.execPath,runtime:fake.runtime});let lease;
 try{lease=await acquireSupervisorLock(directory,()=>void supervisor.stop('lock-lost'),{stale:2000,update:1000});assert.equal((await stat(directory)).mode&0o777,0o700);await assert.rejects(acquireSupervisorLock(directory),{code:'SUPERVISOR_ALREADY_RUNNING'});await mkdir(directory+'.lock');supervisor.start();await rm(lease.lockfilePath,{recursive:true});await until(()=>supervisor.stopping,3000);assert.deepEqual(fake.children[0].signals,['SIGTERM']);fake.children[0].emit('exit',null,'SIGTERM');assert.equal((await supervisor.done).code,1);assert.equal(fake.timers.size,0);assert.ok((await stat(directory+'.lock')).isDirectory());await lease.release();}finally{await supervisor.stop();await lease?.release();await rm(directory,{recursive:true,force:true});await rm(directory+'.lock',{recursive:true,force:true});}
});
test('launcher is relative, safely quoted, and production CLI refuses an unrelated Node runtime',async()=>{
 const script=launcherScript("nested folder/DSH's app.app");assert.match(script,/ELECTRON_RUN_AS_NODE=1 exec/);assert.match(script,/DSH_LAUNCH_DIR/);assert.ok(script.includes("DSH'\\''s app.app"));for(const value of ['../other.app','/Applications/DSH.app','x\nwhoami','x\0y'])assert.throws(()=>launcherScript(value));await assert.rejects(packagedExecutable(),{code:'SUPERVISOR_INVALID_PACKAGE'});assert.equal(childEnvironment({ELECTRON_RUN_AS_NODE:'1',SAFE:'ok'}).SAFE,'ok');assert.equal('ELECTRON_RUN_AS_NODE'in childEnvironment({ELECTRON_RUN_AS_NODE:'1'}),false);for(const locale of ['en','zh-CN'])assert.notEqual(translator(locale)('restart',{seconds:1}),'restart');
});

test('errors from an already spawned child preserve ownership and cannot trigger another launch',async()=>{
 const fake=fakeRuntime(),events=[],supervisor=new ProcessSupervisor({executable:process.execPath,runtime:fake.runtime,onEvent:e=>events.push(e)});supervisor.start();const child=fake.children[0];child.emit('error',Object.assign(Error('kill denied'),{code:'EPERM'}));child.emit('error',Object.assign(Error('IPC closed'),{code:'ERR_IPC_CHANNEL_CLOSED'}));assert.equal(supervisor.child,child);assert.equal(fake.children.length,1);assert.equal(fake.timers.size,0);assert.equal(events.filter(e=>e.type==='restart').length,0);assert.equal(events.filter(e=>e.type==='childError').length,2);child.emit('exit',0,null);await supervisor.done;assert.doesNotThrow(()=>child.emit('error',Error('late')));assert.equal(child.listenerCount('exit'),0);assert.equal(supervisor.childListeners,null);
});
test('a failed spawn without a PID can retry, while late errors cannot alter the next child',async()=>{
 const fake=fakeRuntime(),supervisor=new ProcessSupervisor({executable:process.execPath,runtime:fake.runtime});supervisor.start();const failed=fake.children[0];delete failed.pid;failed.emit('error',Object.assign(Error('missing executable'),{code:'ENOENT'}));assert.equal(fake.fire(),1000);assert.equal(fake.children.length,2);assert.doesNotThrow(()=>failed.emit('error',Error('late spawn error')));assert.equal(supervisor.child,fake.children[1]);fake.children[1].emit('exit',0,null);await supervisor.done;
});
test('unconfirmed termination cancels all timers but keeps child ownership until its late real exit',async()=>{
 const fake=fakeRuntime(),supervisor=new ProcessSupervisor({executable:process.execPath,runtime:fake.runtime});supervisor.start();const child=fake.children[0];child.kill=signal=>{child.signals.push(signal);child.emit('error',Object.assign(Error('denied'),{code:'EPERM'}));return false;};supervisor.stop();assert.equal(fake.fire(),5000);assert.equal(fake.fire(),2000);const result=await supervisor.done;assert.equal(result.code,1);assert.equal(result.reason,'child-exit-unconfirmed');assert.equal(supervisor.child,child);assert.equal(fake.timers.size,0);let closed=false;supervisor.closed.then(()=>{closed=true;});await Promise.resolve();assert.equal(closed,false);assert.equal(fake.children.length,1);child.emit('exit',null,'SIGKILL');await supervisor.closed;assert.equal(supervisor.child,null);assert.equal(supervisor.childListeners,null);assert.equal(child.listenerCount('exit'),0);assert.doesNotThrow(()=>child.emit('error',Error('late')));assert.equal(fake.timers.size,0);
});

test('a real shell launcher resolves spaces and quotes relative to itself and invokes only its bundled executable',{timeout:4000},async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),"dsh-launcher's dir-")),relative="nested folder/DSH's app.app",bundle=path.join(directory,relative),desktop=path.join(bundle,'Contents/Resources/app/desktop'),executable=path.join(bundle,'Contents/MacOS/DSH'),record=path.join(directory,'launch.json'),command=path.join(directory,'DSH long running.command');
 try{
  await mkdir(desktop,{recursive:true});await mkdir(path.dirname(executable),{recursive:true});
  await writeFile(executable,'#!'+process.execPath+'\nrequire("node:fs").writeFileSync(process.env.OWNED_LAUNCH_RECORD,JSON.stringify({argv:process.argv.slice(2),nodeMode:process.env.ELECTRON_RUN_AS_NODE}));\n',{mode:0o700});await writeFile(command,launcherScript(relative),{mode:0o700});
  const child=spawn('/bin/sh',[command],{cwd:'/',env:{...process.env,OWNED_LAUNCH_RECORD:record},stdio:'ignore'}),result=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',(code,signal)=>resolve({code,signal}));});assert.deepEqual(result,{code:0,signal:null});assert.deepEqual(JSON.parse(await readFile(record,'utf8')),{argv:[path.join(desktop,'process-supervisor.cjs')],nodeMode:'1'});
  assert.deepEqual(await packagedExecutable({scriptDirectory:desktop,execPath:executable}),{executable:await realpath(executable),appRoot:await realpath(path.dirname(desktop))});await assert.rejects(packagedExecutable({scriptDirectory:desktop,execPath:process.execPath}),{code:'SUPERVISOR_INVALID_PACKAGE'});
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('CLI marks its own app as supervised, removes Node mode, and releases the lease after a normal exit',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'dsh-supervisor-env-')),signals=new EventEmitter(),env={...process.env,DSH_CLIENT_DATA_DIR:directory,ELECTRON_RUN_AS_NODE:'1',DSH_PROCESS_SUPERVISED:'0',OWNED_ENV_TEST:'retained'};let options;
 try{
  const code=await runCli({env,signalSource:signals,onEvent:()=>{},runtime:{packagedExecutable:async()=>({executable:process.execPath,appRoot:directory}),supervisor:{spawn:(_file,_args,received)=>{options=received;const child=new EventEmitter();child.pid=101;queueMicrotask(()=>child.emit('exit',0,null));return child;}}}});
  assert.equal(code,0);assert.equal(options.env.DSH_PROCESS_SUPERVISED,'1');assert.equal('ELECTRON_RUN_AS_NODE'in options.env,false);assert.equal(options.env.OWNED_ENV_TEST,'retained');assert.equal(env.DSH_PROCESS_SUPERVISED,'0');assert.equal(env.ELECTRON_RUN_AS_NODE,'1');assert.equal(options.cwd,directory);for(const signal of ['SIGINT','SIGTERM','SIGHUP'])assert.equal(signals.listenerCount(signal),0);await assert.rejects(stat(path.join(directory,'desktop-supervisor.lock')),{code:'ENOENT'});
 }finally{await rm(directory,{recursive:true,force:true});}
});
