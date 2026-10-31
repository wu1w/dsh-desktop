import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ProjectPtyManager } from '../server/project-pty.mjs';
import { buildPtyHelper } from '../scripts/build-pty.mjs';
import { apply } from '../server/plugins/feature-terminal.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const exists=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
async function until(work,timeout=6000){const end=Date.now()+timeout;let last;while(Date.now()<end){try{last=await work();if(last)return last;}catch{}await pause(25);}assert.fail('PTY condition timed out: '+String(last));}
async function output(manager,id,match){return until(()=>{const value=manager.read('project',id);return match.test(value.output)?value:false;});}
async function pidAt(file){return until(async()=>{const pid=Number((await readFile(file,'utf8')).trim());return pid>1?pid:false;});}
function background(file){return `/usr/bin/perl -e '$SIG{TERM}="IGNORE";$SIG{HUP}="IGNORE";while(1){sleep 1}' & echo $! > '${file}'\n`;}

test('real PTY supports isatty, stdin, Ctrl-C, UTF8 chunk boundaries, size and resize without inherited model credentials',{skip:process.platform!=='darwin'},async()=>{
  await buildPtyHelper();
  const cwd=await mkdtemp(path.join(os.tmpdir(),'dsh-pty-'));
  const manager=new ProjectPtyManager({shell:'/bin/bash',env:{...process.env,OPENAI_API_KEY:'should-not-inherit',ANTHROPIC_AUTH_TOKEN:'should-not-inherit'}});
  assert.equal(manager.env.PATH,process.env.PATH);
  const fallback=new ProjectPtyManager({env:{PATH:'invalid\0path'}});assert.ok(fallback.env.PATH.includes('/opt/homebrew/bin'));await fallback.close();
  try{
    const terminal=await manager.create({projectId:'project',cwd,cols:91,rows:27});
    await manager.write('project',terminal.id,"test -t 0 && test -t 1 && test -t 2 && printf 'TTY_OK\\n'; stty size; env | /usr/bin/grep -E 'OPENAI_API_KEY|ANTHROPIC_AUTH_TOKEN' || printf 'NO_MODEL_KEYS\\n'\n");
    await output(manager,terminal.id,/TTY_OK\r?\n27 91/);await output(manager,terminal.id,/NO_MODEL_KEYS\r?\n/);
    await manager.resize('project',terminal.id,{cols:112,rows:39});
    await manager.write('project',terminal.id,"stty size; read -r answer; printf 'GOT:%s\\n' \"$answer\"\n");
    await output(manager,terminal.id,/39 112/);
    await manager.write('project',terminal.id,'hello-input\n');await output(manager,terminal.id,/GOT:hello-input/);
    await manager.write('project',terminal.id,"printf '\\344'; sleep 0.08; printf '\\270'; sleep 0.08; printf '\\255\\346\\226\\207\\n'\n");
    const utf8=await output(manager,terminal.id,/中文/);assert.ok(!utf8.output.includes('\ufffd'));
    const cursor=utf8.nextCursor;
    await manager.write('project',terminal.id,'sleep 60\n');await pause(120);
    await manager.write('project',terminal.id,'\u0003');await manager.write('project',terminal.id,"printf 'CTRL_READY\\n'\n");
    await output(manager,terminal.id,/CTRL_READY\r?\n/);
    assert.ok(manager.read('project',terminal.id,{after:cursor}).output.includes('CTRL_READY'));
    assert.throws(()=>manager.read('foreign',terminal.id),{code:'PTY_NOT_FOUND'});
    assert.throws(()=>manager.read('project',terminal.id,{after:1e12}),{code:'PTY_INVALID_CURSOR'});
    await assert.rejects(manager.resize('project',terminal.id,{cols:1,rows:2}),{code:'PTY_INVALID_SIZE'});
    await assert.rejects(manager.resize('project',terminal.id,{}),{code:'PTY_INVALID_SIZE'});
    const session=manager.sessions.get(terminal.id);session.operationStart=Date.now();session.operations=120;
    await assert.rejects(manager.write('project',terminal.id,''),{code:'PTY_RATE_LIMIT'});
  }finally{await manager.close();await rm(cwd,{recursive:true,force:true});}
});

test('ring cursor, resource limits, immediate close and foreground/background process cleanup are bounded',{skip:process.platform!=='darwin'},async()=>{
  const cwd=await mkdtemp(path.join(os.tmpdir(),'dsh-pty-clean-'));
  const manager=new ProjectPtyManager({shell:'/bin/bash',maxOutputBytes:256,maxProjectSessions:1});
  try{
    const terminal=await manager.create({projectId:'project',cwd});
    await assert.rejects(manager.create({projectId:'project',cwd}),{code:'PTY_SESSION_LIMIT'});
    await assert.rejects(manager.write('project',terminal.id,'x'.repeat(16385)),{code:'PTY_INPUT_LIMIT'});
    const bg1=path.join(cwd,'bg1'),bg2=path.join(cwd,'bg2'),fg=path.join(cwd,'fg');
    await manager.write('project',terminal.id,background(bg1)+background(bg2));
    const pids=[await pidAt(bg1),await pidAt(bg2)];
    await manager.write('project',terminal.id,`/usr/bin/perl -e '$SIG{TERM}="IGNORE";$SIG{HUP}="IGNORE";open F,">${fg}";print F $$;close F;while(1){sleep 1}'\n`);
    pids.push(await pidAt(fg));
    assert.ok(pids.every(exists));
    const stopped=await manager.stop('project',terminal.id);assert.equal(stopped.status,'exited');
    await until(()=>pids.every(pid=>!exists(pid)));
    const next=await manager.create({projectId:'project',cwd});
    await manager.write('project',next.id,"printf '%0600d\\n' 1; printf '\\344\\270\\255\\346\\226\\207\\n'\n");
    const ring=await output(manager,next.id,/中文/);assert.equal(ring.truncated,true);assert.ok(Buffer.byteLength(ring.output)<=256);assert.ok(!ring.output.includes('\ufffd'));
    const done=await manager.stop('project',next.id);assert.equal(done.status,'exited');
    for(let i=0;i<5;i++){const immediate=await manager.create({projectId:'project',cwd});await manager.stop('project',immediate.id);}
    const natural=await manager.create({projectId:'project',cwd});const writer=path.join(cwd,'natural-bg');
    await manager.write('project',natural.id,`/usr/bin/perl -e '$SIG{TERM}="IGNORE";$SIG{HUP}="IGNORE";$|=1;while(1){print "tick\\n";select undef,undef,undef,0.05}' & echo $! > '${writer}'; exit\n`);
    const writerPid=await pidAt(writer);await until(()=>manager.read('project',natural.id).status==='exited');await until(()=>!exists(writerPid));
  }finally{await manager.close();await rm(cwd,{recursive:true,force:true});}
});

test('guardian cleans jobs when helper is killed and when the host exits without disposal',{skip:process.platform!=='darwin'},async()=>{
  const cwd=await mkdtemp(path.join(os.tmpdir(),'dsh-pty-death-'));const manager=new ProjectPtyManager({shell:'/bin/bash'});
  let host;
  try{
    const terminal=await manager.create({projectId:'project',cwd});const first=path.join(cwd,'helper-bg');
    await manager.write('project',terminal.id,background(first));const helperJob=await pidAt(first);
    manager.sessions.get(terminal.id).child.kill('SIGKILL');await until(()=>!exists(helperJob));
    const hostJobFile=path.join(cwd,'host-bg'),ready=path.join(cwd,'ready');
    const source=`import {ProjectPtyManager} from ${JSON.stringify(path.join(root,'server/project-pty.mjs'))};import {writeFile} from 'node:fs/promises';const m=new ProjectPtyManager({shell:'/bin/bash'});const t=await m.create({projectId:'project',cwd:${JSON.stringify(cwd)}});await m.write('project',t.id,${JSON.stringify(background(hostJobFile))});await writeFile(${JSON.stringify(ready)},String(m.sessions.get(t.id).child.pid));setInterval(()=>{},1000);`;
    host=spawn(process.execPath,['--input-type=module','-e',source],{stdio:'ignore'});
    await pidAt(ready);const hostJob=await pidAt(hostJobFile);host.kill('SIGKILL');await until(()=>!exists(hostJob));
  }finally{host?.kill('SIGKILL');await manager.close();await rm(cwd,{recursive:true,force:true});}
});

test('Cordis terminal routes bind project ownership and plugin disposal cleans live jobs',{skip:process.platform!=='darwin'},async()=>{
  const cwd=await mkdtemp(path.join(os.tmpdir(),'dsh-pty-plugin-'));let route;const cleanup=[];
  const ctx={effect(fn){const dispose=fn();if(typeof dispose==='function')cleanup.push(dispose);}};
  const host={appRoot:root,commands:new Set(),getProject(id){if(id!=='project')throw new Error('NOT_FOUND');return {path:cwd};},registerRoute(value){route=value;return()=>{};}};
  apply(ctx,host);
  const invoke=async(method,segments,body={},query='')=>{let answer;await route.handle({request:{method},segments,body,url:new URL('http://localhost/'+query),json:value=>{answer=value;}});return answer;};
  try{
    const terminal=await invoke('POST',['projects','project','pty'],{cols:80,rows:24});
    const jobFile=path.join(cwd,'plugin-bg');await invoke('POST',['projects','project','pty',terminal.id,'input'],{data:background(jobFile)});
    assert.deepEqual(await invoke('POST',['projects','project','pty',terminal.id,'resize'],{cols:95,rows:31}),{cols:95,rows:31});
    const job=await pidAt(jobFile);assert.equal((await invoke('GET',['projects','project','pty'])).terminals.length,1);
    await assert.rejects(invoke('GET',['projects','foreign','pty',terminal.id]),/NOT_FOUND/);
    for(const dispose of cleanup.reverse())await dispose();await until(()=>!exists(job));
    await assert.rejects(invoke('GET',['projects','project','pty']),/ENGINE_DISABLED/);
  }finally{for(const dispose of cleanup.reverse())await dispose();await rm(cwd,{recursive:true,force:true});}
});

test('output rate and lifetime limits stop the native session and preserve an explicit reason',{skip:process.platform!=='darwin'},async()=>{
  const cwd=await mkdtemp(path.join(os.tmpdir(),'dsh-pty-limits-'));
  const loud=new ProjectPtyManager({shell:'/bin/bash',maxOutputBytesPerSecond:1024});
  const timed=new ProjectPtyManager({shell:'/bin/bash',lifetimeMs:150});
  try{
    const terminal=await loud.create({projectId:'project',cwd});
    await loud.write('project',terminal.id,"printf '%05000d' 1\n");
    const result=await until(()=>{const value=loud.read('project',terminal.id);return value.status==='exited'?value:false;});
    assert.equal(result.error,'PTY_OUTPUT_LIMIT');
    const timeout=await timed.create({projectId:'project',cwd});
    const expired=await until(()=>{const value=timed.read('project',timeout.id);return value.status==='exited'?value:false;});
    assert.equal(expired.error,'PTY_LIFETIME_LIMIT');
  }finally{await loud.close();await timed.close();await rm(cwd,{recursive:true,force:true});}
});

test('fast shell exit retains its final large output with a slow host reader',{skip:process.platform!=='darwin'},async()=>{
  await buildPtyHelper();const cwd=await mkdtemp(path.join(os.tmpdir(),'dsh-pty-tail-'));
  const manager=new ProjectPtyManager({shell:'/bin/bash',maxOutputBytes:2*1024*1024});
  try{
    for(const bytes of [100*1024,768*1024]){
      const terminal=await manager.create({projectId:'project',cwd});
      const child=manager.sessions.get(terminal.id).child;child.stdout.pause();
      await manager.write('project',terminal.id,`/usr/bin/perl -e 'print "START_TAIL\\n";print "x"x${bytes};print "TAIL_FINISHED\\n"'; exit\n`);
      await pause(550);child.stdout.resume();
      const result=await until(()=>{const value=manager.read('project',terminal.id);return value.status==='exited'?value:false;});
      assert.equal(result.exitCode,0);assert.equal(result.error,undefined);
      const start=result.output.indexOf('START_TAIL\r\n');assert.ok(start>=0);
      assert.equal(result.output.slice(start+'START_TAIL\r\n'.length,start+'START_TAIL\r\n'.length+bytes),'x'.repeat(bytes));
      assert.ok(result.output.includes('xTAIL_FINISHED\r\n'));
    }
  }finally{await manager.close();await rm(cwd,{recursive:true,force:true});}
});
