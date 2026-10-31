import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {Context} from '@deepseek-ai/cordis';
const appRoot=process.env.DSH_ACCEPTANCE_APP_ROOT??path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const {PluginHost}=await import(pathToFileURL(path.join(appRoot,'server/plugin-host.mjs')));
const {runProjectCommand,stopProjectCommand,stopProjectCommands}=await import(pathToFileURL(path.join(appRoot,'server/project-commands.mjs')));
const {ProjectPtyManager}=await import(pathToFileURL(path.join(appRoot,'server/project-pty.mjs')));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
const kill=process.kill.bind(process);
const exists=pid=>{try{kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};
async function until(read,timeout=5000){const deadline=Date.now()+timeout;while(Date.now()<deadline){const value=await read();if(value)return value;await pause(20);}assert.fail('Owned process did not reach expected state');}
async function marker(file){return until(async()=>{try{return Number(await readFile(file,'utf8'))||false;}catch(error){if(error.code!=='ENOENT')throw error;return false;}});}
const stubborn=file=>`exec ${quote(process.execPath)} -e ${quote(`process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(file)},String(process.pid));setInterval(()=>{},1000);`)}`;
function killOwnedGroup(pid){if(!pid)return;try{kill(-pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}}

test('failed command SIGKILL is bounded, retains activity, rejects its request and can be retried',async t=>{
  const cwd=await mkdtemp(path.join(tmpdir(),'dsh-terminal-stop-retry-')),commands=new Set();let pending,child,pid;
  try{
    pending=runProjectCommand({command:stubborn(path.join(cwd,'ready')),cwd,commands,shell:'/bin/sh',timeoutMs:30000,killGraceMs:30});
    const settled=pending.then(value=>({value}),error=>({error}));
    pid=await marker(path.join(cwd,'ready'));child=[...commands][0];assert.equal(child.pid,pid);
    const interception=t.mock.method(process,'kill',(target,signal)=>target===-pid&&signal==='SIGKILL'?true:kill(target,signal));
    const started=Date.now(),first=stopProjectCommand(child);
    assert.equal(stopProjectCommand(child),first,'concurrent stops share one attempt');
    await assert.rejects(first,{code:'COMMAND_STOP_FAILED'});
    assert.ok(Date.now()-started<2500);assert.equal(commands.has(child),true);assert.equal(exists(pid),true);
    assert.equal((await settled).error.code,'COMMAND_STOP_FAILED','request does not hang after cleanup failed');
    interception.mock.restore();
    await stopProjectCommand(child);assert.equal(commands.size,0);assert.equal(exists(pid),false);
    await stopProjectCommand(child); // Successful cleanup is idempotent.
  }finally{killOwnedGroup(pid);await stopProjectCommands(commands).catch(()=>{});await pending?.catch(()=>{});await rm(cwd,{recursive:true,force:true});}
});

test('escaped pipe holder does not make command cleanup wait forever or lose the retry handle',async()=>{
  const cwd=await mkdtemp(path.join(tmpdir(),'dsh-terminal-stop-pipe-')),commands=new Set();let pending,escaped;
  try{
    const file=path.join(cwd,'escaped');
    const worker=`require('node:fs').writeFileSync(${JSON.stringify(file)},String(process.pid));setInterval(()=>{},1000);`;
    const leader=`const p=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(worker)}],{detached:true,stdio:['ignore','inherit','inherit']});p.unref();`;
    pending=runProjectCommand({command:`exec ${quote(process.execPath)} -e ${quote(leader)}`,cwd,commands,shell:'/bin/sh',timeoutMs:30000});
    const settled=pending.then(value=>({value}),error=>({error}));
    const child=[...commands][0];escaped=await marker(file);await until(()=>!exists(child.pid));
    const started=Date.now();await assert.rejects(stopProjectCommand(child),{code:'COMMAND_STOP_FAILED'});
    assert.ok(Date.now()-started<2000);assert.equal(commands.has(child),true);assert.equal(exists(escaped),true);
    assert.equal((await settled).error.code,'COMMAND_STOP_FAILED');
    killOwnedGroup(escaped);await stopProjectCommand(child);assert.equal(commands.size,0);
  }finally{killOwnedGroup(escaped);await stopProjectCommands(commands).catch(()=>{});await pending?.catch(()=>{});await rm(cwd,{recursive:true,force:true});}
});

test('bulk command stop settles other owned cleanups before reporting a failed process',async t=>{
  const cwd=await mkdtemp(path.join(tmpdir(),'dsh-terminal-stop-all-')),commands=new Set(),pids=[];let intercept,pending=[];
  try{
    pending=[30,1400].map((killGraceMs,index)=>runProjectCommand({command:stubborn(path.join(cwd,'ready'+index)),cwd,commands,shell:'/bin/sh',killGraceMs,timeoutMs:30000}).then(value=>({value}),error=>({error})));
    pids.push(await marker(path.join(cwd,'ready0')),await marker(path.join(cwd,'ready1')));
    intercept=t.mock.method(process,'kill',(target,signal)=>target===-pids[0]&&signal==='SIGKILL'?true:kill(target,signal));
    await assert.rejects(stopProjectCommands(commands),{code:'COMMAND_STOP_FAILED'});
    assert.equal(exists(pids[0]),true);assert.equal(exists(pids[1]),false,'the slower cleanup completed before rejection');
    assert.deepEqual([...commands].map(child=>child.pid),[pids[0]]);
    intercept.mock.restore();intercept=null;await stopProjectCommands(commands);assert.equal(commands.size,0);
    const results=await Promise.all(pending);assert.equal(results[0].error.code,'COMMAND_STOP_FAILED');assert.equal(results[1].value.signal,'SIGKILL');
  }finally{intercept?.mock.restore();pids.forEach(killOwnedGroup);await stopProjectCommands(commands).catch(()=>{});await Promise.all(pending);await rm(cwd,{recursive:true,force:true});}
});

test('actual Cordis disable retains routes and activities until the terminal stop guard succeeds',async t=>{
  const cwd=await mkdtemp(path.join(tmpdir(),'dsh-terminal-stop-cordis-')),commands=new Set(),context=new Context();let host,pending,pid,interception;
  try{
    host=new PluginHost({context,dataDir:path.join(cwd,'state'),builtins:[path.join(appRoot,'server/plugins/feature-terminal.mjs')],services:{appRoot,commands,getProject:id=>{assert.equal(id,'project');return {path:cwd};}}});
    await host.start();let answer;
    const invoke=async(method,segments,body={})=>{let value;await host.dispatch({segments,request:{method},body,url:new URL('http://localhost/'),json:result=>{value=result;}});return value;};
    const pty=process.platform==='darwin'?await invoke('POST',['projects','project','pty']):null;
    pending=host.dispatch({segments:['projects','project','terminal'],request:{method:'POST'},body:{command:stubborn(path.join(cwd,'ready'))},json:value=>{answer=value;}});
    const settled=pending.then(value=>({value}),error=>({error}));
    pid=await marker(path.join(cwd,'ready'));
    const originalFiber=host.records.get('feature-terminal').fiber;
    interception=t.mock.method(process,'kill',(target,signal)=>target===-pid&&signal==='SIGKILL'?true:kill(target,signal));
    await assert.rejects(host.disable('feature-terminal'),{code:'COMMAND_STOP_FAILED'});
    assert.equal((await settled).error.code,'COMMAND_STOP_FAILED');assert.equal(answer,undefined);
    assert.equal(host.records.get('feature-terminal').fiber,originalFiber);
    assert.equal(host.list()[0].active,true);assert.equal(host.list()[0].error,'COMMAND_STOP_FAILED');
    assert.equal(host.routes.size,1);assert.equal(host.features.size,1);assert.equal(host.activityProviders.size,1);
    assert.ok(host.activities().some(row=>row.kind==='command'&&row.id.endsWith('command-'+pid)));
    const blockedMarker=path.join(cwd,'must-not-start'),before=[...commands];
    await assert.rejects(invoke('POST',['projects','project','terminal'],{command:`printf spawned > ${quote(blockedMarker)}`}),{code:'PTY_CLOSED'});
    assert.deepEqual([...commands],before);await assert.rejects(readFile(blockedMarker),{code:'ENOENT'});
    await assert.rejects(invoke('POST',['projects','project','pty']),{code:'PTY_CLOSED'});
    for(const action of ['input','resize'])await assert.rejects(invoke('POST',['projects','project','pty',pty?.id??'absent',action],{data:'x',cols:80,rows:24}),{code:'PTY_CLOSED'});
    const list=await invoke('GET',['projects','project','pty']);assert.ok(Array.isArray(list.terminals));
    if(pty){
      assert.equal((await invoke('GET',['projects','project','pty',pty.id])).status,'exited');
      assert.equal((await invoke('POST',['projects','project','pty',pty.id,'stop'])).status,'exited');
    }else await assert.rejects(invoke('POST',['projects','project','pty','absent','stop']),{code:'PTY_NOT_FOUND'});
    interception.mock.restore();interception=null;
    await host.disable('feature-terminal');assert.equal(exists(pid),false);assert.equal(commands.size,0);
    assert.equal(host.routes.size,0);assert.equal(host.features.size,0);assert.deepEqual(host.activities(),[]);
    await host.enable('feature-terminal');assert.equal(host.routes.size,1);
    pending=host.dispatch({segments:['projects','project','terminal'],request:{method:'POST'},body:{command:stubborn(path.join(cwd,'close-ready'))},json:()=>{}});
    const closeRequest=pending.then(value=>({value}),error=>({error}));
    pid=await marker(path.join(cwd,'close-ready'));
    interception=t.mock.method(process,'kill',(target,signal)=>target===-pid&&signal==='SIGKILL'?true:kill(target,signal));
    await assert.rejects(host.close(),{code:'PLUGIN_CLEANUP_FAILED'});
    assert.equal((await closeRequest).error.code,'COMMAND_STOP_FAILED');
    assert.equal(host.list()[0].active,true);assert.equal(host.routes.size,1);
    assert.ok(host.activities().some(row=>row.kind==='command'&&row.id.endsWith('command-'+pid)));
    interception.mock.restore();interception=null;
    await host.close();await host.close();assert.equal(exists(pid),false);assert.deepEqual(host.activities(),[]);
  }finally{interception?.mock.restore();killOwnedGroup(pid);await stopProjectCommands(commands).catch(()=>{});await pending?.catch(()=>{});await host?.close();await context.fiber.dispose();await rm(cwd,{recursive:true,force:true});}
});

test('PTY stop errors keep the real terminal visible and permit a later cooperative retry',{skip:process.platform!=='darwin'},async t=>{
  const cwd=await mkdtemp(path.join(tmpdir(),'dsh-terminal-stop-pty-')),manager=new ProjectPtyManager({shell:'/bin/bash'});let end,signal;
  try{
    const terminal=await manager.create({projectId:'project',cwd});
    await manager.write('project',terminal.id,"printf 'STOP_READY\\n'\n");
    await until(()=>manager.read('project',terminal.id).output.includes('STOP_READY\r\n'));
    const session=manager.sessions.get(terminal.id);
    end=t.mock.method(session.child.stdin,'end',function(){return this;});
    signal=t.mock.method(session.child,'kill',()=>{throw Object.assign(new Error('test owned child signal failure'),{code:'EPERM'});});
    const started=Date.now();await assert.rejects(manager.stop('project',terminal.id),{code:'PTY_STOP_FAILED'});
    assert.ok(Date.now()-started<2500);assert.equal(session.stopping,null);
    assert.equal(exists(session.child.pid),true);assert.equal(session.cleanupPending,true);
    assert.equal(manager.read('project',terminal.id).error,'PTY_STOP_FAILED');
    end.mock.restore();end=null;signal.mock.restore();signal=null;
    const result=await manager.stop('project',terminal.id);
    assert.equal(result.status,'exited');assert.equal(result.error,undefined);assert.equal(result.cleanupPending,undefined);
    assert.equal(exists(session.child.pid),false);await manager.close();await manager.close();
  }finally{end?.mock.restore();signal?.mock.restore();await manager.close();await rm(cwd,{recursive:true,force:true});}
});

test('SIGKILL helper stop waits for the real guardian completion handshake and background job cleanup',{skip:process.platform!=='darwin'},async()=>{
  const cwd=await mkdtemp(path.join(tmpdir(),'dsh-terminal-stop-guard-')),manager=new ProjectPtyManager({shell:'/bin/bash'});let background;
  try{
    const terminal=await manager.create({projectId:'project',cwd}),file=path.join(cwd,'background');
    await manager.write('project',terminal.id,`/usr/bin/perl -e '$SIG{TERM}="IGNORE";$SIG{HUP}="IGNORE";while(1){sleep 1}' & echo $! > '${file}'\n`);
    background=await marker(file);const session=manager.sessions.get(terminal.id);
    session.child.kill('SIGKILL');let settled=false;
    const stopping=manager.stop('project',terminal.id).finally(()=>{settled=true;});
    await pause(50);assert.equal(settled,false,'helper death does not acknowledge guardian cleanup');
    const result=await stopping;assert.equal(result.status,'exited');assert.equal(result.error,undefined);
    assert.match(session.diagnostic,/^DSH_PTY_GUARD_DONE [1-9]\d* [1-9]\d*$/m);
    assert.equal(exists(background),false);assert.equal(session.cleanupPending,false);
  }finally{if(background&&exists(background))try{kill(background,'SIGKILL');}catch{}await manager.close();await rm(cwd,{recursive:true,force:true});}
});

test('legacy or malformed guardian acknowledgements fail closed without pretending cleanup succeeded',{skip:process.platform!=='darwin'},async()=>{
  const cwd=await mkdtemp(path.join(tmpdir(),'dsh-terminal-stop-legacy-')),managers=[];
  try{
    for(const [index,diagnostic] of ['DSH_PTY_EXIT 0 0\n','DSH_PTY_GUARD_DONE 0 10\nDSH_PTY_EXIT 0 0\n','DSH_PTY_GUARD_DONE 9007199254740992 10\nDSH_PTY_EXIT 0 0\n','DSH_PTY_GUARD_DONE 10 11\nDSH_PTY_GUARD_FAILED\nDSH_PTY_EXIT 0 0\n'].entries()){
      const helper=path.join(cwd,'old-helper-'+index);
      await writeFile(helper,'#!/bin/sh\nprintf %s '+quote(diagnostic)+' >&2\nexit 0\n',{mode:0o700});
      const manager=new ProjectPtyManager({helperPath:helper,shell:'/bin/bash'});managers.push(manager);
      const terminal=await manager.create({projectId:'project',cwd});
      await until(()=>manager.read('project',terminal.id).status==='exited');
      assert.equal(manager.read('project',terminal.id).cleanupPending,true);
    }
    const results=await Promise.allSettled(managers.map(manager=>manager.close()));
    assert.ok(results.every(result=>result.status==='rejected'&&result.reason.code==='PTY_STOP_FAILED'));
    assert.ok(managers.every(manager=>[...manager.sessions.values()].every(session=>session.cleanupPending&&!exists(session.child.pid))));
  }finally{await Promise.allSettled(managers.map(manager=>manager.close()));await rm(cwd,{recursive:true,force:true});}
});
