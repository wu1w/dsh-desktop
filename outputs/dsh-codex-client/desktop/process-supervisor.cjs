'use strict';
const path=require('node:path');
const os=require('node:os');
const fs=require('node:fs/promises');
const {spawn}=require('node:child_process');
const {performance}=require('node:perf_hooks');
const lockfile=require('proper-lockfile');

const messages={
  'zh-CN':{starting:'正在启动 DSH。',restart:'DSH 异常退出，将在 {seconds} 秒后重新启动。',normal:'DSH 已正常退出，守护启动器也已停止。',stopping:'正在停止此启动器创建的 DSH 进程。',forced:'进程未及时退出，正在终止此启动器创建的进程。',locked:'已有守护启动器正在使用此数据目录。',lost:'守护锁失效，正在停止自己的 DSH 进程。',invalid:'请从配套的 DSH 长期运行入口启动。',failed:'守护启动失败：{code}',unconfirmed:'无法确认子进程已退出；已停止重启，并保留守护锁等待该进程结束。',childError:'子进程报告错误（{code}）；正在保留其归属并等待退出确认。'},
  en:{starting:'Starting DSH.',restart:'DSH exited unexpectedly. Restarting in {seconds} seconds.',normal:'DSH exited normally. The supervisor has stopped.',stopping:'Stopping the DSH process created by this launcher.',forced:'The process did not exit in time. Terminating the process created by this launcher.',locked:'Another supervisor is already using this data folder.',lost:'The supervisor lock was lost. Stopping its own DSH process.',invalid:'Start this supervisor from its matching DSH launcher.',failed:'Supervisor could not start: {code}',unconfirmed:'The child exit could not be confirmed. Restarts are stopped; the lock stays held until this child exits.',childError:'The child reported an error ({code}); retaining ownership until its exit is confirmed.'},
};
const error=code=>Object.assign(new Error(code),{code});
function language(value){return typeof value==='string'&&value.toLowerCase().startsWith('zh')?'zh-CN':'en';}
function translator(locale){const selected=language(locale);return(key,values={})=>(messages[selected][key]??messages.en[key]??key).replace(/\{(\w+)\}/g,(_,name)=>String(values[name]??''));}
function childEnvironment(env=process.env){const child={...env};delete child.ELECTRON_RUN_AS_NODE;return child;}
function positive(value){if(!Number.isSafeInteger(value)||value<1)throw error('SUPERVISOR_INVALID_LIMIT');return value;}

// This class only signals the ChildProcess it created. It neither enumerates
// processes nor uses process groups, application names, or a user's data lock.
class ProcessSupervisor{
  constructor({executable,args=[],cwd,env=process.env,baseDelayMs=1000,maxDelayMs=30000,stableMs=60000,stopTimeoutMs=5000,killTimeoutMs=2000,onEvent=()=>{},runtime={}}){
    if(typeof executable!=='string'||!path.isAbsolute(executable)||!Array.isArray(args)||args.some(value=>typeof value!=='string'))throw error('SUPERVISOR_INVALID_RUNTIME');
    Object.assign(this,{executable,args:[...args],cwd,env:childEnvironment(env),baseDelayMs:positive(baseDelayMs),maxDelayMs:positive(maxDelayMs),stableMs:positive(stableMs),stopTimeoutMs:positive(stopTimeoutMs),killTimeoutMs:positive(killTimeoutMs),onEvent});
    this.runtime={spawn,now:()=>performance.now(),setTimer:(fn,ms)=>setTimeout(fn,ms),clearTimer:id=>clearTimeout(id),...runtime};
    this.child=null;this.restartTimer=null;this.stopTimer=null;this.killTimer=null;this.failures=0;this.started=false;this.stopping=false;this.finished=false;this.stopCode=0;this.lastExit=null;
    this.done=new Promise(resolve=>{this.resolve=resolve;});
    this.closed=new Promise(resolve=>{this.resolveClosed=resolve;});
  }
  _event(type,details={}){try{this.onEvent({type,...details});}catch{/* Logging must not restart or strand a child. */}}
  _clear(name){this.runtime.clearTimer(this[name]);this[name]=null;}
  start(){if(!this.started&&!this.finished){this.started=true;this._launch();}return this.done;}
  _launch(){
    if(this.stopping||this.finished||this.child)return;
    this._clear('restartTimer');this.launchedAt=this.runtime.now();this._event('starting');
    let child;try{child=this.runtime.spawn(this.executable,this.args,{cwd:this.cwd,env:this.env,stdio:'inherit',shell:false,detached:false});}
    catch(failure){this._exited(null,null,null,failure);return;}
    this.child=child;
    const exited=(code,signal)=>this._exited(child,code,signal),failed=failure=>{
      if(child!==this.child)return;
      // An error can mean a failed kill or IPC operation. A process with a PID
      // still owns its slot until exit; never launch a second one on that error.
      if(child.pid==null)this._exited(child,null,null,failure);
      else this._event('childError',{code:failure?.code??'CHILD_PROCESS_ERROR'});
    };
    this.childListeners={child,exited,failed};child.once('exit',exited);child.on('error',failed);
  }
  _exited(child,code,signal,failure){
    if(child!==this.child)return;
    const listeners=this.childListeners;if(listeners?.child===child){
      child.removeListener('exit',listeners.exited);child.removeListener('error',listeners.failed);
      // Late ChildProcess errors must remain handled without retaining this
      // supervisor or changing the ownership of its next child.
      child.on('error',()=>{});this.childListeners=null;
    }
    this.child=null;this._clear('stopTimer');this._clear('killTimer');
    this.lastExit={code,signal,errorCode:failure?.code??null};
    if(this.finished){this.resolveClosed();return;}
    if(this.stopping){this._finish(this.stopCode,'stopped');return;}
    if(code===0&&!signal&&!failure){this._event('normal');this._finish(0,'normal');return;}
    if(this.runtime.now()-this.launchedAt>=this.stableMs)this.failures=0;
    this.failures=Math.min(this.failures+1,30);
    const delayMs=Math.min(this.maxDelayMs,this.baseDelayMs*2**(this.failures-1));
    this._event('restart',{delayMs,attempt:this.failures,exit:this.lastExit});
    this.restartTimer=this.runtime.setTimer(()=>{this.restartTimer=null;this._launch();},delayMs);
  }
  stop(reason='signal'){
    if(this.finished||this.stopping)return this.done;
    this.stopping=true;this.stopCode=reason==='lock-lost'?1:0;this._clear('restartTimer');this._event(reason==='lock-lost'?'lost':'stopping');
    const child=this.child;if(!child){this._finish(this.stopCode,'stopped');return this.done;}
    // SIGINT is normalized to SIGTERM so Electron has one bounded shutdown path.
    try{child.kill('SIGTERM');}catch{/* A concurrent exit may already be queued. */}
    if(this.child!==child||this.finished)return this.done;
    this.stopTimer=this.runtime.setTimer(()=>{
      this.stopTimer=null;if(this.child!==child||this.finished)return;this._event('forced');
      try{child.kill('SIGKILL');}catch{/* The bounded confirmation below reports failure. */}
      if(this.child!==child||this.finished)return;
      this.killTimer=this.runtime.setTimer(()=>{this.killTimer=null;if(this.child===child){this._event('unconfirmed');this._finish(1,'child-exit-unconfirmed');}},this.killTimeoutMs);
    },this.stopTimeoutMs);
    return this.done;
  }
  _finish(code,reason){if(this.finished)return;this.finished=true;for(const timer of ['restartTimer','stopTimer','killTimer'])this._clear(timer);this.resolve({code,reason,lastExit:this.lastExit,childPid:this.child?.pid??null});if(!this.child)this.resolveClosed();}
}

async function acquireSupervisorLock(directory,onLost=()=>{},options={}){
  const {assertIndependentDataDirectory}=await import('../server/data-directory.mjs');
  const canonical=await assertIndependentDataDirectory(directory);
  await fs.mkdir(canonical,{recursive:true,mode:0o700});
  const resolved=await fs.realpath(canonical),lockfilePath=path.join(resolved,'desktop-supervisor.lock');let lost=false;
  try{
    const release=await lockfile.lock(resolved,{realpath:true,lockfilePath,retries:0,stale:30000,update:5000,...options,onCompromised:()=>{if(lost)return;lost=true;onLost(error('SUPERVISOR_LOCK_LOST'));}});
    return{directory:resolved,lockfilePath,async release(){if(lost)return;await release();},get lost(){return lost;}};
  }catch(failure){if(failure.code==='ELOCKED')throw error('SUPERVISOR_ALREADY_RUNNING');throw failure;}
}
function defaultDataDirectory(env=process.env,platform=process.platform,home=os.homedir()){
  if(env.DSH_CLIENT_DATA_DIR)return env.DSH_CLIENT_DATA_DIR;
  const appData=platform==='darwin'?path.join(home,'Library','Application Support'):platform==='win32'?env.APPDATA??path.join(home,'AppData','Roaming'):env.XDG_CONFIG_HOME??path.join(home,'.config');
  return path.join(appData,'DSH-Codex','client');
}
async function packagedExecutable({scriptDirectory=__dirname,execPath=process.execPath}={}){
  const appRoot=await fs.realpath(path.resolve(scriptDirectory,'..'));
  if(path.basename(appRoot)!=='app'||path.basename(path.dirname(appRoot))!=='Resources'||path.basename(path.dirname(path.dirname(appRoot)))!=='Contents')throw error('SUPERVISOR_INVALID_PACKAGE');
  const executable=await fs.realpath(path.resolve(appRoot,'../../MacOS/DSH'));
  if(executable!==await fs.realpath(execPath))throw error('SUPERVISOR_INVALID_PACKAGE');
  return{executable,appRoot};
}
function launcherScript(relativeAppPath='DSH-darwin-arm64/DSH.app'){
  if(typeof relativeAppPath!=='string'||!relativeAppPath||path.posix.isAbsolute(relativeAppPath)||relativeAppPath.split('/').some(part=>part==='..'||!part)||/[\0\r\n]/.test(relativeAppPath))throw error('SUPERVISOR_INVALID_PACKAGE');
  const quoted="'"+relativeAppPath.replace(/'/g,"'\\''")+"'";
  return '#!/bin/sh\nset -eu\nDSH_LAUNCH_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nDSH_SUPERVISED_APP="$DSH_LAUNCH_DIR"/'+quoted+'\nELECTRON_RUN_AS_NODE=1 exec "$DSH_SUPERVISED_APP/Contents/MacOS/DSH" "$DSH_SUPERVISED_APP/Contents/Resources/app/desktop/process-supervisor.cjs"\n';
}
function attachShutdownSignals(supervisor,source=process){
  const signal=()=>{void supervisor.stop();};
  for(const name of ['SIGINT','SIGTERM','SIGHUP'])source.on(name,signal);
  return()=>{for(const name of ['SIGINT','SIGTERM','SIGHUP'])source.removeListener(name,signal);};
}
async function runCli({env=process.env,signalSource=process,onEvent,lockOptions={},runtime={}}={}){
  const locale=language(env.DSH_LOCALE??env.LC_ALL??env.LC_MESSAGES??env.LANG),t=translator(locale);
  const report=onEvent??(event=>{const values={...event,seconds:new Intl.NumberFormat(locale).format((event.delayMs??0)/1000)};process.stderr.write('[DSH] '+t(event.type,values)+'\n');});
  let supervisor,lease,detach,lost=false;
  try{
    const {executable,appRoot}=await (runtime.packagedExecutable??packagedExecutable)();
    lease=await acquireSupervisorLock(defaultDataDirectory(env),()=>{lost=true;void supervisor?.stop('lock-lost');},lockOptions);
    if(lost||lease.lost)throw error('SUPERVISOR_LOCK_LOST');
    supervisor=new ProcessSupervisor({executable,cwd:appRoot,env:{...env,DSH_PROCESS_SUPERVISED:'1'},onEvent:report,runtime:runtime.supervisor});
    detach=attachShutdownSignals(supervisor,signalSource);
    const result=await supervisor.start();
    // The bounded shutdown verdict is available, but releasing the lease while
    // the OS still reports a live owned child could permit a duplicate launch.
    if(supervisor.child)await supervisor.closed;
    return result.code;
  }catch(failure){report({type:failure.code==='SUPERVISOR_ALREADY_RUNNING'?'locked':failure.code==='SUPERVISOR_INVALID_PACKAGE'?'invalid':'failed',code:failure.code??'SUPERVISOR_FAILED'});return 1;}
  finally{detach?.();try{if(!supervisor?.child)await lease?.release();}catch{report({type:'lost'});}}
}
module.exports={ProcessSupervisor,acquireSupervisorLock,defaultDataDirectory,packagedExecutable,childEnvironment,launcherScript,translator,attachShutdownSignals,runCli};
if(require.main===module)void runCli().then(code=>{process.exitCode=code;});
