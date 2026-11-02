import { spawn } from 'node:child_process';
import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {windowsEnvironment,windowsShell,windowsJobCommand,stopWindowsJob} from './windows-process.mjs';

const fault = code => Object.assign(new Error(code), { code });
const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
function groupExists(child) {
  if(!child.pid)return false;
  try{process.kill(-child.pid,0);return true;}
  catch(error){if(error.code==='ESRCH')return false;if(error.code==='EPERM')return true;throw error;}
}
async function waitUntil(check,milliseconds) {
  const deadline=Date.now()+milliseconds;
  while(!check()){
    if(Date.now()>=deadline)return false;
    await sleep(Math.min(20,Math.max(1,deadline-Date.now())));
  }
  return true;
}
function dimensions({cols=100,rows=30}={}) {
  if (!Number.isInteger(cols)||cols<2||cols>500||!Number.isInteger(rows)||rows<2||rows>300) throw fault('PTY_INVALID_SIZE');
  return {cols,rows};
}
function frame(type,data=Buffer.alloc(0)) { const header=Buffer.alloc(5);header[0]=type;header.writeUInt32BE(data.length,1);return Buffer.concat([header,data]); }
function guardianDone(diagnostic) {
  if(/^DSH_PTY_GUARD_FAILED\b/m.test(diagnostic))return false;
  const done=/^DSH_PTY_GUARD_DONE ([1-9]\d*) ([1-9]\d*)$/m.exec(diagnostic);
  if(!done)return false;
  const guardian=Number(done[1]),session=Number(done[2]);
  return Number.isSafeInteger(guardian)&&guardian>1&&Number.isSafeInteger(session)&&session>1&&guardian!==session;
}
export class ProjectPtyManager {
  constructor({ helperPath=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../native/bin/dsh-pty-helper'), shell, platform=process.platform, loadPty=()=>import('node-pty'), stopJob=stopWindowsJob, maxSessions=4, maxProjectSessions=2, maxOutputBytes=1024*1024, maxOutputBytesPerSecond=4*1024*1024, lifetimeMs=24*60*60*1000, env=process.env }={}) {
    shell??=platform==='win32'?windowsShell(env):'/bin/zsh';
    if (platform==='win32'?!path.win32.isAbsolute(shell):!['/bin/zsh','/bin/bash'].includes(shell)) throw fault('PTY_UNSUPPORTED');
    Object.assign(this,{platform,loadPty,stopJob});
    Object.assign(this,{helperPath,shell,maxSessions,maxProjectSessions,maxOutputBytes,maxOutputBytesPerSecond,lifetimeMs});
    this.env=Object.fromEntries(['HOME','USER','LOGNAME','LANG','LC_ALL','LC_CTYPE','TMPDIR'].filter(key=>typeof env[key]==='string').map(key=>[key,env[key]]));
    const terminalPath=typeof env.PATH==='string'&&env.PATH.length>0&&env.PATH.length<=32768&&!env.PATH.includes('\0')?env.PATH:'/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin';
    Object.assign(this.env,{PATH:terminalPath,TERM:'xterm-256color',COLORTERM:'truecolor',SHELL:shell,ZDOTDIR:'/var/empty'});
    if(platform==='win32')this.env={...windowsEnvironment(env),TERM:'xterm-256color',COLORTERM:'truecolor'};
    this.sessions=new Map();this.pending=new Map();this.closed=false;
  }
  async create({projectId,cwd,cols=100,rows=30}) {
    if(this.closed)throw fault('PTY_CLOSED');
    if(typeof projectId!=='string'||!projectId||typeof cwd!=='string'||!path.isAbsolute(cwd))throw fault('INVALID_REQUEST');
    const size=dimensions({cols,rows});
    const running=[...this.sessions.values()].filter(value=>value.status==='running'||value.cleanupPending);
    if(running.length+[...this.pending.values()].reduce((a,b)=>a+b,0)>=this.maxSessions||running.filter(value=>value.projectId===projectId).length+(this.pending.get(projectId)||0)>=this.maxProjectSessions)throw fault('PTY_SESSION_LIMIT');
    this.pending.set(projectId,(this.pending.get(projectId)||0)+1);
    try {
      if(!['darwin','win32'].includes(this.platform))throw fault('PTY_UNSUPPORTED');
      const canonical=await realpath(cwd).catch(()=>{throw fault('PTY_INVALID_CWD');});
      if(!(await stat(canonical)).isDirectory())throw fault('PTY_INVALID_CWD');
      if(this.platform==='win32')return await this._createWindows({projectId,cwd:canonical,...size});
      await access(this.helperPath,constants.X_OK).catch(()=>{throw fault('PTY_HELPER_MISSING');});
      if(this.closed)throw fault('PTY_CLOSED');
      const child=spawn(this.helperPath,[canonical,String(cols),String(rows),this.shell],{cwd:canonical,env:this.env,detached:true,stdio:['pipe','pipe','pipe']});
      child.stdin.on('error',()=>{});
      const session={id:randomUUID(),projectId,...size,status:'running',exitCode:null,signal:null,child,decoder:new StringDecoder('utf8'),output:Buffer.alloc(0),start:0,end:0,rateStart:Date.now(),outputRate:0,inputRate:0,inputRateStart:Date.now(),operationStart:Date.now(),operations:0,queuedBytes:0,stopping:null,cleanupPending:false,diagnostic:'',timer:null};
      this.sessions.set(session.id,session);
      session.done=new Promise(resolve=>{session.resolveDone=resolve;});
      child.stdout.on('data',chunk=>{
        if(Date.now()-session.rateStart>=1000){session.rateStart=Date.now();session.outputRate=0;}
        session.outputRate+=chunk.length;
        if(session.outputRate>this.maxOutputBytesPerSecond){session.error='PTY_OUTPUT_LIMIT';void this._stop(session).catch(()=>{});return;}
        this._append(session,session.decoder.write(chunk));
      });
      child.stderr.on('data',chunk=>{if(session.diagnostic.length<512)session.diagnostic+=(chunk.toString('ascii').slice(0,512-session.diagnostic.length));});
      child.once('error',()=>{session.error='PTY_START_FAILED';});
      child.once('close',(code,signal)=>{
        this._append(session,session.decoder.end());clearTimeout(session.timer);
        const match=/DSH_PTY_EXIT (\d+) (\d+)/.exec(session.diagnostic);
        if(/DSH_PTY_(ARGUMENT|FORK)\b/.test(session.diagnostic)||(!match&&code===125))session.error='PTY_START_FAILED';
        if(session.diagnostic.includes('DSH_PTY_OUTPUT_TRUNCATED'))session.error??='PTY_OUTPUT_TRUNCATED';
        session.status='exited';session.exitCode=match?(Number(match[2])?null:Number(match[1])):code;
        session.signal=match&&Number(match[2])?Number(match[2]):signal;
        // The guardian keeps the control pipe until it has cleaned the PTY's
        // separate session. Neither a helper close nor its exit footer alone is
        // that proof, including when the helper was killed with SIGKILL.
        session.cleanupUnverified=Boolean(child.pid)&&!guardianDone(session.diagnostic);
        if(session.cleanupUnverified)session.stopError='PTY_STOP_FAILED';
        try{session.cleanupPending=session.cleanupUnverified||groupExists(child);}catch{session.cleanupPending=true;}
        if(!session.cleanupPending)session.stopError=null;
        session.resolveDone();
        if(session.cleanupPending)void this._stop(session).catch(()=>{});
      });
      session.timer=setTimeout(()=>{session.error='PTY_LIFETIME_LIMIT';void this._stop(session).catch(()=>{});},this.lifetimeMs);session.timer.unref();
      await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',()=>reject(fault('PTY_START_FAILED')));});
      for(const old of this.sessions.values()){if(this.sessions.size<=32)break;if(old.status==='exited'&&!old.cleanupPending)this.sessions.delete(old.id);}
      return this.read(projectId,session.id);
    } finally {const remaining=(this.pending.get(projectId)||1)-1;if(remaining)this.pending.set(projectId,remaining);else this.pending.delete(projectId);}
  }
  async _createWindows({projectId,cwd,cols,rows}) {
    let module;try{module=await this.loadPty();}catch{throw fault('PTY_HELPER_MISSING');}
    if(this.closed)throw fault('PTY_CLOSED');
    const spawnPty=module.spawn??module.default?.spawn;
    if(typeof spawnPty!=='function')throw fault('PTY_HELPER_MISSING');
    const args=path.win32.basename(this.shell).toLowerCase()==='cmd.exe'?['/d']:['-NoLogo','-NoProfile'];
    const launch=windowsJobCommand(this.shell,args,{env:this.env});
    let pty;try{pty=spawnPty(launch.file,launch.args,{cwd,env:this.env,name:'xterm-256color',cols,rows,useConpty:true,useConptyDll:false});}catch{throw fault('PTY_START_FAILED');}
    const session={id:randomUUID(),projectId,cols,rows,status:'running',exitCode:null,signal:null,pty,stopEvent:launch.stopEvent,child:pty,output:Buffer.alloc(0),start:0,end:0,rateStart:Date.now(),outputRate:0,inputRate:0,inputRateStart:Date.now(),operationStart:Date.now(),operations:0,queuedBytes:0,stopping:null,cleanupPending:false,timer:null};
    this.sessions.set(session.id,session);
    session.done=new Promise(resolve=>{session.resolveDone=resolve;});
    session.dataSubscription=pty.onData(text=>{
      if(Date.now()-session.rateStart>=1000){session.rateStart=Date.now();session.outputRate=0;}
      session.outputRate+=Buffer.byteLength(text);
      if(session.outputRate>this.maxOutputBytesPerSecond){session.error='PTY_OUTPUT_LIMIT';void this._stopWindows(session).catch(()=>{});return;}
      this._append(session,text);
    });
    session.exitSubscription=pty.onExit(({exitCode,signal})=>{
      if(session.status==='exited')return;
      if(exitCode===125&&session.output.toString('utf8').includes('DSH_WINDOWS_JOB_FAILED'))session.error='PTY_START_FAILED';
      session.status='exited';session.exitCode=exitCode;session.signal=signal??null;clearTimeout(session.timer);
      session.resolveDone();
      // The Job supervisor closes its non-inherited handle on every exit.
      // node-pty emits onExit only after closing the ConPTY output pipe.
      if(!session.stopping){session.cleanupPending=false;session.stopError=null;session.dataSubscription?.dispose();session.exitSubscription?.dispose();}
    });
    // node-pty can emit an error event separately from onExit.
    pty.on?.('error',()=>{session.error='PTY_START_FAILED';void this._stopWindows(session).catch(()=>{});});
    session.timer=setTimeout(()=>{session.error='PTY_LIFETIME_LIMIT';void this._stopWindows(session).catch(()=>{});},this.lifetimeMs);session.timer.unref();
    for(const old of this.sessions.values()){if(this.sessions.size<=32)break;if(old.status==='exited'&&!old.cleanupPending)this.sessions.delete(old.id);}
    return this.read(projectId,session.id);
  }
  _stopWindows(session) {
    if(session.status==='exited'&&!session.cleanupPending)return Promise.resolve();
    if(session.stopping)return session.stopping;
    session.cleanupPending=true;
    const stopping=(async()=>{
      try{
        if(session.status!=='exited'){
          // Closing the supervisor's Job kills only its owned descendants.
          // Do not call taskkill or node-pty.kill(): both can enumerate numeric
          // PIDs asynchronously after the original process has already exited.
          try{await this.stopJob(session.stopEvent,{env:this.env});}catch(error){if(session.status!=='exited')throw error;}
        }
        if(!await waitUntil(()=>session.status==='exited',2500))throw fault('PTY_STOP_FAILED');
        session.cleanupPending=false;session.stopError=null;
        session.dataSubscription?.dispose();session.exitSubscription?.dispose();
      }catch{session.stopError='PTY_STOP_FAILED';throw fault('PTY_STOP_FAILED');}
    })();
    session.stopping=stopping;
    void stopping.finally(()=>{if(session.stopping===stopping)session.stopping=null;}).catch(()=>{});
    return stopping;
  }
  _append(session,text) {
    if(!text)return;
    const data=Buffer.from(text,'utf8');session.end+=data.length;
    session.output=Buffer.concat([session.output,data]);
    if(session.output.length>this.maxOutputBytes){
      let trim=session.output.length-this.maxOutputBytes;
      while(trim<session.output.length&&(session.output[trim]&0xc0)===0x80)trim++;
      session.output=session.output.subarray(trim);session.start+=trim;
    }
  }
  _session(projectId,id) {const session=this.sessions.get(id);if(!session||session.projectId!==projectId)throw fault('PTY_NOT_FOUND');return session;}
  _allowOperation(session) {
    if(Date.now()-session.operationStart>=1000){session.operationStart=Date.now();session.operations=0;}
    if(++session.operations>120)throw fault('PTY_RATE_LIMIT');
  }
  list(projectId) {return [...this.sessions.values()].filter(session=>session.projectId===projectId).map(session=>this.read(projectId,session.id,{after:session.end}));}
  read(projectId,id,{after=0}={}) {
    const session=this._session(projectId,id);
    if(typeof after==='string'&&/^(0|[1-9]\d*)$/.test(after))after=Number(after);
    if(!Number.isSafeInteger(after)||after<0||after>session.end)throw fault('PTY_INVALID_CURSOR');
    let position=Math.max(after,session.start),truncated=after<session.start;
    while(position<session.end&&(session.output[position-session.start]&0xc0)===0x80){position++;truncated=true;}
    const error=session.stopError??session.error;
    return {id:session.id,projectId:session.projectId,cols:session.cols,rows:session.rows,status:session.status,exitCode:session.exitCode,signal:session.signal,output:session.output.subarray(position-session.start).toString('utf8'),nextCursor:session.end,truncated,...(session.cleanupPending?{cleanupPending:true}:{}),...(error?{error}:{})};
  }
  async write(projectId,id,data) {
    const session=this._session(projectId,id);
    if(session.status!=='running'||session.stopping)throw fault('PTY_NOT_RUNNING');
    this._allowOperation(session);
    if(typeof data!=='string')throw fault('INVALID_REQUEST');
    const bytes=Buffer.from(data,'utf8');
    if(bytes.length>16384)throw fault('PTY_INPUT_LIMIT');
    if(Date.now()-session.inputRateStart>=1000){session.inputRateStart=Date.now();session.inputRate=0;}
    if(session.inputRate+bytes.length>65536||session.queuedBytes+bytes.length>65536)throw fault('PTY_INPUT_LIMIT');
    session.inputRate+=bytes.length;session.queuedBytes+=bytes.length;
    try {if(session.pty){try{session.pty.write(data);}catch{throw fault('PTY_NOT_RUNNING');}}else await new Promise((resolve,reject)=>{session.child.stdin.write(frame(1,bytes),error=>error?reject(fault('PTY_NOT_RUNNING')):resolve());});}
    finally {session.queuedBytes-=bytes.length;}
    return {accepted:true};
  }
  async resize(projectId,id,size) {
    if(!size||!Number.isInteger(size.cols)||!Number.isInteger(size.rows))throw fault('PTY_INVALID_SIZE');
    const session=this._session(projectId,id);const {cols,rows}=dimensions(size);
    if(session.status!=='running'||session.stopping)throw fault('PTY_NOT_RUNNING');
    this._allowOperation(session);
    const bytes=Buffer.alloc(8);bytes.writeUInt32BE(cols,0);bytes.writeUInt32BE(rows,4);
    if(session.pty){try{session.pty.resize(cols,rows);}catch{throw fault('PTY_NOT_RUNNING');}}else await new Promise((resolve,reject)=>session.child.stdin.write(frame(2,bytes),error=>error?reject(fault('PTY_NOT_RUNNING')):resolve()));
    session.cols=cols;session.rows=rows;return {cols,rows};
  }
  async _stop(session) {
    if(session.pty)return this._stopWindows(session);
    if(session.status==='exited'&&!session.cleanupPending)return;
    if(session.stopping)return session.stopping;
    session.cleanupPending=true;
    const stopped=()=>session.status==='exited'&&!session.cleanupUnverified&&!groupExists(session.child);
    const stopping=(async()=>{
      try{
        const input=session.child.stdin;
        if(session.status!=='exited'&&!input.destroyed&&!input.writableEnded){
          try{input.end(frame(3));}catch{} // Signalling remains available after a broken pipe.
        }
        if(!await waitUntil(stopped,1500)){
          if(session.status!=='exited')session.child.kill('SIGTERM');
          if(!await waitUntil(stopped,1000)){
            // Only signal the helper. Its guardian must stay alive to clean the
            // shell's separate session when the helper exits or is killed.
            if(session.status!=='exited')session.child.kill('SIGKILL');
            if(!await waitUntil(stopped,1000))throw fault('PTY_STOP_FAILED');
          }
        }
        session.cleanupPending=false;session.stopError=null;
      }catch(cause){session.stopError='PTY_STOP_FAILED';throw fault('PTY_STOP_FAILED');}
    })();
    session.stopping=stopping;
    void stopping.finally(()=>{if(session.stopping===stopping)session.stopping=null;}).catch(()=>{});
    return stopping;
  }
  async stop(projectId,id) {const session=this._session(projectId,id);await this._stop(session);return this.read(projectId,id);}
  async close() {
    this.closed=true;
    const stopped=await Promise.allSettled([...this.sessions.values()].map(session=>this._stop(session)));
    const failure=stopped.find(result=>result.status==='rejected');if(failure)throw failure.reason;
  }
}
