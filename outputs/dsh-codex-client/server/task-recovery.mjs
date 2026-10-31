import {randomUUID} from 'node:crypto';
import {continuationText} from '../shared/recovery-errors.js';

const terminal=new Set(['completed','failed','interrupted']);
const pending=new Set(['running','waiting','uncertain']);
const fault=code=>Object.assign(new Error(code),{code});
const copy=value=>structuredClone(value);

// Only structured native transport failures qualify. Authentication, quota,
// context limits, approval denials, and arbitrary tool errors never do.
export function isTransientTurnError(error){
  const info=error?.codexErrorInfo;
  if(['serverOverloaded','internalServerError'].includes(info))return true;
  // The pinned 0.163 App Server reports a broken HTTP response body as
  // `other`. Match its verified transport envelope, never arbitrary model or
  // tool text containing words such as "network" or "timeout".
  if(info==='other'&&/^stream disconnected before completion: Transport error: network error: (?:error decoding response body|error sending request for url)/.test(error?.message??''))return true;
  if(info==='other'&&error?.message==='stream disconnected before completion: idle timeout waiting for SSE')return true;
  if(!info||typeof info!=='object')return false;
  for(const key of ['httpConnectionFailed','responseStreamConnectionFailed','responseStreamDisconnected','responseTooManyFailedAttempts']){
    if(!Object.hasOwn(info,key))continue;
    const status=info[key]?.httpStatusCode;
    return status==null||status===408||status===429||(Number.isInteger(status)&&status>=500&&status<=599);
  }
  return false;
}

// One durable checkpoint per chat. Native history remains the authority and
// stores the actual input/tool results; this file never stores/replays prompts.
export class TaskRecovery {
  constructor({state,save,getEngine,getSelectedEngine,canRun=()=>true,onChange=()=>{},onError=()=>{},baseDelayMs=5000,maxDelayMs=300000,now=()=>Date.now(),setTimer=(fn,ms)=>setTimeout(fn,ms),clearTimer=id=>clearTimeout(id)}){
    Object.assign(this,{state,save,getEngine,getSelectedEngine,canRun,onChange,onError,baseDelayMs,maxDelayMs,now,setTimer,clearTimer});
    this.serial=new Map();this.timers=new Map();this.timerEpoch=new Map();this.intentEpoch=new Map();this.stopIntents=new Set();this.closed=false;this.storageFailed=false;
  }
  _sequence(session,work){
    const previous=this.serial.get(session.id)??Promise.resolve();
    const operation=previous.then(work,work),tail=operation.catch(()=>{});this.serial.set(session.id,tail);
    void tail.finally(()=>{if(this.serial.get(session.id)===tail)this.serial.delete(session.id);});return operation;
  }
  async _save(){
    try{await this.save();this.onChange();}
    catch{this.storageFailed=true;for(const id of this.timers.keys())this._cancel(id);this.onError('TASK_RECOVERY_STORAGE');throw fault('TASK_RECOVERY_STORAGE');}
  }
  _cancel(id){this.clearTimer(this.timers.get(id));this.timers.delete(id);this.timerEpoch.set(id,(this.timerEpoch.get(id)??0)+1);}
  _owns(session,engine){return !this.closed&&this.canRun()&&engine===this.getEngine()&&engine?.ready&&(session.engineId??'codex')===this.getSelectedEngine();}
  _new(options={},managed=true){return {version:1,id:randomUUID(),turnId:null,status:'uncertain',reason:'starting',attempt:0,nextRetryAt:null,canResume:false,userStopped:false,managed,permission:['read-only','workspace-write','danger-full-access'].includes(options.sandbox)?options.sandbox:'read-only',effort:['low','high','max'].includes(options.effort)?options.effort:'high',updatedAt:new Date(this.now()).toISOString()};}
  _set(session,patch){session.runRecovery={...session.runRecovery,...patch,updatedAt:new Date(this.now()).toISOString()};}
  async start(session,input,options={},dispatch){
    return this._sequence(session,async()=>{
      if(this.closed||!this.canRun())throw fault('HOST_STOPPING');
      if(this.storageFailed)throw fault('TASK_RECOVERY_STORAGE');
      if(pending.has(session.runRecovery?.status))throw fault('TASK_RECOVERY_PENDING');
      this._cancel(session.id);this.stopIntents.delete(session.id);
      session.runRecovery=this._new(options);await this._save();
      return this._dispatch(session,input,options,dispatch);
    });
  }
  async _dispatch(session,input,options,dispatch){
    const engine=this.getEngine(),runId=session.runRecovery.id;let submitted=false;
    try{
      if(!this._owns(session,engine))throw fault('ENGINE_DISABLED');
      if(this.stopIntents.has(session.id)||session.runRecovery.userStopped)throw fault('TASK_NOT_RESUMABLE');
      submitted=true;
      const result=await (dispatch?dispatch():engine.startTurn(session.id,input,options));
      if(session.runRecovery.id!==runId)return result;
      const turn=result?.turn??result,turnId=turn?.id??result?.turnId;
      if(typeof turnId==='string')this._set(session,{turnId,status:terminal.has(turn.status)?turn.status:'running',reason:null,canResume:turn.status==='failed'||turn.status==='interrupted'});
      else this._set(session,{status:'uncertain',reason:'start_unverified',canResume:true});
      await this._save();return result;
    }catch(error){
      if(session.runRecovery.id===runId){this._set(session,{status:submitted?'uncertain':'failed',reason:submitted?'start_unverified':'not_dispatched',canResume:submitted});await this._save();}
      throw error;
    }
  }
  observe(session,note){
    if(this.closed||!['turn/started','turn/completed'].includes(note.method)||!note.params?.turn?.id)return Promise.resolve();
    const turn=note.params.turn;
    return this._sequence(session,async()=>{
      if(this.closed)return;
      const old=session.runRecovery;
      if(note.method==='turn/started'){
        if(old?.turnId===turn.id&&terminal.has(old.status))return;
        if(!old||old.turnId&&old.turnId!==turn.id){session.runRecovery=this._new({sandbox:old?.permission,effort:old?.effort},!session.automationId);}
        this._set(session,{turnId:turn.id,status:'running',reason:this.stopIntents.has(session.id)?'stopping':null,canResume:false,userStopped:this.stopIntents.has(session.id)||session.runRecovery.userStopped});
      }else{
        if(!terminal.has(turn.status)||old?.turnId&&old.turnId!==turn.id)return;
        if(!old)session.runRecovery=this._new({},false);
        const stopped=this.stopIntents.has(session.id)||session.runRecovery.userStopped;
        const retry=turn.status==='failed'&&isTransientTurnError(turn.error)&&!stopped&&session.runRecovery.managed;
        this._set(session,{turnId:turn.id,status:retry?'waiting':turn.status,reason:retry?'network':stopped?'user_stopped':turn.status==='failed'?'turn_failed':null,userStopped:stopped,canResume:turn.status!=='completed',nextRetryAt:null});
      }
      await this._save();if(session.runRecovery.status==='waiting')this._schedule(session);
    });
  }
  _schedule(session){
    this._cancel(session.id);
    const run=session.runRecovery;
    if(this.closed||this.storageFailed||!this.canRun()||run?.userStopped||this.stopIntents.has(session.id)||!run?.managed||run.status!=='waiting')return;
    const delay=Math.min(this.maxDelayMs,this.baseDelayMs*2**Math.min(run.attempt??0,20));
    this._set(session,{nextRetryAt:new Date(this.now()+delay).toISOString()});
    const runId=run.id,epoch=this.timerEpoch.get(session.id);
    // Persist the intention before arming its timer. A crash at any point can
    // only cause a fresh metadata check, never replay a submission.
    const arm=async()=>{await this._save();if(this.closed||this.storageFailed||epoch!==this.timerEpoch.get(session.id)||session.runRecovery.id!==runId||session.runRecovery.userStopped||this.stopIntents.has(session.id)||session.runRecovery.status!=='waiting')return;
      const timer=this.setTimer(()=>{this.timers.delete(session.id);void this._sequence(session,()=>this._resume(session,false)).catch(error=>{if(!this.closed)this.onError(error.code??'TASK_STATE_UNVERIFIED');});},delay);timer?.unref?.();this.timers.set(session.id,timer);};
    void arm().catch(()=>{});
  }
  async _read(session){
    const engine=this.getEngine();if(!this._owns(session,engine))throw fault('ENGINE_DISABLED');
    if(typeof engine.readTurnState!=='function')throw fault('TASK_STATE_UNVERIFIED');
    const result=await engine.readTurnState(session.id,session.runRecovery?.turnId??undefined);
    if(!this._owns(session,engine))throw fault('TASK_STATE_UNVERIFIED');
    return result;
  }
  async _resume(session,manual,locale){
    const run=session.runRecovery,intent=this.intentEpoch.get(session.id)??0;
    if(!run||this.closed||(!manual&&this.storageFailed)||session.archived)throw fault('TASK_NOT_RESUMABLE');
    if(manual&&this.storageFailed){await this._save();this.storageFailed=false;}
    if(!manual&&(run.userStopped||this.stopIntents.has(session.id)||!run.managed||!this.canRun()))return;
    this._cancel(session.id);
    let metadata;
    try{metadata=await this._read(session);}catch(error){
      this._set(session,{status:manual?'uncertain':'waiting',reason:run.reason??'engine_unavailable',canResume:true});await this._save();if(!manual)this._schedule(session);if(manual)throw error;return;
    }
    if(metadata.known&&metadata.status==='inProgress'&&metadata.turnId===run.turnId){
      this._set(session,{status:'running',reason:run.userStopped?'stopping':null,canResume:false,nextRetryAt:null});await this._save();if(manual)throw fault('TASK_NOT_RESUMABLE');return;
    }
    if(!metadata.known||!terminal.has(metadata.status)||run.turnId&&metadata.turnId!==run.turnId){
      this._set(session,{status:'uncertain',reason:'state_unverified',canResume:true,nextRetryAt:null});await this._save();if(manual)throw fault('TASK_STATE_UNVERIFIED');return;
    }
    // A missing turn id after ambiguous dispatch is not evidence that the
    // latest historical turn belongs to that request.
    if(!run.turnId){this._set(session,{status:'uncertain',reason:'start_unverified',canResume:true,nextRetryAt:null});await this._save();if(manual)throw fault('TASK_STATE_UNVERIFIED');return;}
    if(metadata.status==='completed'){
      this._set(session,{status:'completed',reason:null,canResume:false,nextRetryAt:null});await this._save();return {completed:true};
    }
    if(!manual&&!(metadata.status==='failed'&&isTransientTurnError(metadata.error))&&!(metadata.status==='interrupted'&&['process_exit','host_restart'].includes(run.reason))){
      this._set(session,{status:metadata.status,reason:'turn_ended',canResume:true,nextRetryAt:null});await this._save();return;
    }
    const engine=this.getEngine();let queued;
    try{queued=await engine.queueRequest(session.id,'list',{limit:1});}
    catch(error){this._set(session,{status:manual?'uncertain':'waiting',reason:run.reason??'engine_unavailable',canResume:true});await this._save();if(!manual)this._schedule(session);if(manual)throw error;return;}
    if(queued?.data?.length||session.recoveredQueue?.length){this._set(session,{status:'interrupted',reason:'queue_pending',canResume:true,nextRetryAt:null});await this._save();if(manual)throw fault('TASK_QUEUE_PENDING');return;}
    if(!this._owns(session,engine)||(this.intentEpoch.get(session.id)??0)!==intent||this.stopIntents.has(session.id)&&!manual) return;
    if(manual){this.stopIntents.delete(session.id);this.storageFailed=false;}
    this._set(session,{status:'uncertain',reason:'resuming',turnId:null,userStopped:false,canResume:false,nextRetryAt:null,attempt:Math.min(Number.MAX_SAFE_INTEGER,(run.attempt??0)+1)});await this._save();
    return this._dispatch(session,[{type:'text',text:continuationText(locale??this.state.preferences?.locale),text_elements:[]}],{sandbox:run.permission,effort:run.effort});
  }
  resume(session,locale){return this._sequence(session,()=>this._resume(session,true,locale));}
  async stop(session,reason='user_stopped'){
    // Synchronous fence wins even when a metadata lookup/start ACK is pending.
    this.stopIntents.add(session.id);this.intentEpoch.set(session.id,(this.intentEpoch.get(session.id)??0)+1);this._cancel(session.id);
    return this._sequence(session,async()=>{
      if(session.runRecovery){const active=this.getEngine()?.activeTurns.has(session.id),ended=terminal.has(session.runRecovery.status)||session.runRecovery.reason==='network';this._set(session,{userStopped:true,reason,nextRetryAt:null,status:active?'running':ended?'interrupted':'uncertain',canResume:!active});}
      let storageError;try{await this._save();}catch(error){storageError=error;}
      const engine=this.getEngine();if(engine?.ready&&engine.activeTurns.has(session.id))await engine.interrupt(session.id);
      if(storageError)throw storageError;return {ok:true};
    });
  }
  async engineExited(engineId){
    const work=this.state.sessions.filter(s=>(s.engineId??'codex')===engineId&&pending.has(s.runRecovery?.status)).map(session=>this._sequence(session,async()=>{
      this._cancel(session.id);const stopped=session.runRecovery.userStopped||this.stopIntents.has(session.id);
      this._set(session,{status:stopped?'interrupted':session.runRecovery.managed?'waiting':'uncertain',reason:stopped?'user_stopped':'process_exit',canResume:true,nextRetryAt:null});await this._save();
    }));await Promise.allSettled(work);
  }
  async recover(){
    for(const session of this.state.sessions){
      if(this.closed)return;
      if((session.engineId??'codex')!==this.getSelectedEngine()||session.archived||!pending.has(session.runRecovery?.status))continue;
      await this._sequence(session,async()=>{
        if(!session.runRecovery.managed){this._set(session,{status:'uncertain',reason:'host_restart',canResume:true,nextRetryAt:null});await this._save();return;}
        if(session.runRecovery.userStopped){this._set(session,{status:'uncertain',reason:'user_stopped',canResume:true,nextRetryAt:null});await this._save();return;}
        if(session.runRecovery.status==='running')this._set(session,{status:'waiting',reason:'host_restart'});
        await this._resume(session,false);
      }).catch(error=>this.onError(error.code??'TASK_STATE_UNVERIFIED'));
    }
  }
  async pause(reason='engine_disabled'){
    for(const session of this.state.sessions)if((session.engineId??'codex')===this.getSelectedEngine()&&pending.has(session.runRecovery?.status)){this.stopIntents.add(session.id);this.intentEpoch.set(session.id,(this.intentEpoch.get(session.id)??0)+1);this._cancel(session.id);}
    await Promise.all(this.state.sessions.filter(s=>this.stopIntents.has(s.id)&&pending.has(s.runRecovery?.status)).map(session=>this._sequence(session,async()=>{this._set(session,{userStopped:true,status:session.runRecovery.reason==='network'?'interrupted':'uncertain',reason,canResume:true,nextRetryAt:null});await this._save();})));
  }
  async close(){this.closed=true;for(const id of this.timers.keys())this._cancel(id);await Promise.all([...this.serial.values()]);}
}
