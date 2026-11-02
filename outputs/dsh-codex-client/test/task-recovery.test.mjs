import test from 'node:test';
import assert from 'node:assert/strict';
import {TaskRecovery,isTransientTurnError} from '../server/task-recovery.mjs';
import {EngineSupervisor} from '../server/engine-supervisor.mjs';
const turnError={codexErrorInfo:{responseStreamDisconnected:{httpStatusCode:null}}};
const note=(method,id,status,error=null)=>({method,params:{turn:{id,status,error}}});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
function setup(options={}){
 const session={id:'s',threadId:'t',engineId:'codex'},state={sessions:[session],preferences:{locale:'en'}},timers=new Map(),saved=[],calls=[];let seq=0;
 const engine={ready:true,activeTurns:new Map(),async startTurn(id,input,opts){calls.push({id,input,opts});const turn={id:'turn-'+ ++seq,status:'inProgress'};engine.activeTurns.set(id,{turnId:turn.id});return {turn};},async readTurnState(id,turnId){return{turnId,known:true,status:'failed',error:turnError};},async queueRequest(){return{data:[]};},async interrupt(id){calls.push({interrupt:id});engine.activeTurns.delete(id);}};
 let save=async()=>{saved.push(structuredClone(state));};
 const recovery=new TaskRecovery({state,save:()=>save(),getEngine:()=>engine,getSelectedEngine:()=> 'codex',baseDelayMs:10,maxDelayMs:100,now:()=>100000,setTimer:(fn,ms)=>{const id=Symbol();timers.set(id,{fn,ms});return id;},clearTimer:id=>timers.delete(id),...options});
 return{session,state,engine,recovery,timers,saved,calls,setSave:fn=>{save=fn;},async failed(){engine.activeTurns.clear();await recovery.observe(session,note('turn/completed',session.runRecovery.turnId,'failed',turnError));await tick();},async fire(){const [id,t]=timers.entries().next().value;timers.delete(id);await t.fn();await tick();await tick();},async close(){await recovery.close();}};
}

test('only structured retryable transport failures qualify',()=>{
 for(const code of ['unauthorized','usageLimitExceeded','contextWindowExceeded','rateLimitExceeded','sandboxError','other'])assert.equal(isTransientTurnError({codexErrorInfo:code}),false);
 for(const code of [null,408,429,500,503])assert.equal(isTransientTurnError({codexErrorInfo:{httpConnectionFailed:{httpStatusCode:code}}}),true);
 for(const code of [400,401,403,404])assert.equal(isTransientTurnError({codexErrorInfo:{httpConnectionFailed:{httpStatusCode:code}}}),false);
 assert.equal(isTransientTurnError({message:'network timeout'}),false);
 assert.equal(isTransientTurnError({codexErrorInfo:'other',message:'stream disconnected before completion: idle timeout waiting for SSE'}),true);
 assert.equal(isTransientTurnError({codexErrorInfo:'other',message:'stream disconnected before completion: Transport error: network error: error decoding response body'}),true);
 assert.equal(isTransientTurnError({codexErrorInfo:'other',message:'Tool failed: stream disconnected before completion: idle timeout waiting for SSE'}),false);
});
test('checkpoint precedes dispatch, transient failure continues same chat with original permissions and no prompt replay',async()=>{
 const s=setup();try{
  await s.recovery.start(s.session,[{type:'text',text:'WRITE ONCE'}],{sandbox:'workspace-write',effort:'max'});
  assert.equal(s.saved[0].sessions[0].runRecovery.status,'uncertain');assert.equal(s.saved[0].sessions[0].runRecovery.turnId,null);
  await s.failed();assert.equal(s.session.runRecovery.status,'waiting');assert.equal([...s.timers.values()][0].ms,10);
  await s.fire();assert.equal(s.calls.length,2);assert.equal(s.calls[1].id,'s');assert.doesNotMatch(s.calls[1].input[0].text,/WRITE ONCE/);assert.match(s.calls[1].input[0].text,/Do not repeat/);assert.deepEqual(s.calls[1].opts,{sandbox:'workspace-write',effort:'max'});assert.equal(s.session.runRecovery.attempt,1);assert.equal(s.session.runRecovery.status,'running');
 }finally{await s.close();}
});
test('explicit stop cancels pending retry durably and survives recovery/restart',async()=>{
 const s=setup();try{await s.recovery.start(s.session,'x');await s.failed();await s.recovery.stop(s.session);assert.equal(s.timers.size,0);assert.equal(s.session.runRecovery.userStopped,true);assert.equal(s.session.runRecovery.status,'interrupted');await s.recovery.recover();assert.equal(s.calls.length,1);assert.equal(s.timers.size,0);}finally{await s.close();}
});
test('stop wins while a manual resume metadata query is pending',async()=>{
 const s=setup(),read=deferred();try{await s.recovery.start(s.session,'x');await s.failed();s.engine.readTurnState=()=>read.promise;const resume=s.recovery.resume(s.session);await tick();const stop=s.recovery.stop(s.session);read.resolve({known:true,turnId:'turn-1',status:'failed',error:turnError});await Promise.all([resume,stop]);assert.equal(s.calls.length,1);assert.equal(s.session.runRecovery.userStopped,true);assert.equal(s.timers.size,0);}finally{await s.close();}
});
test('a lost start ACK stays uncertain and never binds an unrelated latest historical turn',async()=>{
 const s=setup();try{s.engine.startTurn=async()=>{throw Object.assign(Error('TIMEOUT'),{code:'TIMEOUT'});};await assert.rejects(s.recovery.start(s.session,'x'),{code:'TIMEOUT'});assert.equal(s.session.runRecovery.status,'uncertain');s.engine.readTurnState=async()=>({known:true,turnId:'previous',status:'interrupted'});await assert.rejects(s.recovery.resume(s.session),{code:'TASK_STATE_UNVERIFIED'});assert.equal(s.timers.size,0);assert.equal(s.calls.length,0);}finally{await s.close();}
});
test('completion notification arriving before start ACK wins over start metadata',async()=>{
 const s=setup();try{s.engine.startTurn=async()=>{void s.recovery.observe(s.session,note('turn/completed','fast','completed'));return{turn:{id:'fast',status:'inProgress'}};};await s.recovery.start(s.session,'x');await tick();assert.equal(s.session.runRecovery.status,'completed');assert.equal(s.timers.size,0);}finally{await s.close();}
});
test('native completion after a process exit prevents automatic duplicate continuation',async()=>{
 const s=setup();try{await s.recovery.start(s.session,'x');await s.recovery.engineExited('codex');s.engine.activeTurns.clear();s.engine.readTurnState=async()=>({known:true,turnId:'turn-1',status:'completed'});await s.recovery.recover();assert.equal(s.session.runRecovery.status,'completed');assert.equal(s.calls.length,1);}finally{await s.close();}
});
test('known interrupted turn after a crash resumes, unverified native state remains paused',async()=>{
 for(const known of [true,false]){const s=setup();try{await s.recovery.start(s.session,'x');await s.recovery.engineExited('codex');s.engine.activeTurns.clear();s.engine.readTurnState=async()=>({known,turnId:'turn-1',status:'interrupted'});await s.recovery.recover();assert.equal(s.calls.length,known?2:1);assert.equal(s.session.runRecovery.status,known?'running':'uncertain');}finally{await s.close();}}
});
test('fatal failure is resumable only by explicit action, completed tasks never resume',async()=>{
 const s=setup();try{await s.recovery.start(s.session,'x');s.engine.activeTurns.clear();await s.recovery.observe(s.session,note('turn/completed','turn-1','failed',{codexErrorInfo:'unauthorized'}));assert.equal(s.timers.size,0);s.engine.readTurnState=async()=>({known:true,turnId:'turn-1',status:'failed',error:{codexErrorInfo:'unauthorized'}});await s.recovery.resume(s.session);assert.equal(s.calls.length,2);await s.recovery.observe(s.session,note('turn/completed','turn-2','completed'));s.engine.readTurnState=async()=>({known:true,turnId:'turn-2',status:'completed'});await s.recovery.resume(s.session);assert.equal(s.calls.length,2);}finally{await s.close();}
});
test('pending native queue prevents automatic continuation racing the queue',async()=>{
 const s=setup();try{await s.recovery.start(s.session,'x');await s.failed();s.engine.queueRequest=async()=>({data:[{id:'queued'}]});await s.fire();assert.equal(s.calls.length,1);assert.equal(s.session.runRecovery.reason,'queue_pending');assert.equal(s.timers.size,0);}finally{await s.close();}
});
test('storage failure prevents dispatch, preserves state, and reports recovery error',async()=>{
 const errors=[],s=setup({onError:code=>errors.push(code)});try{s.setSave(async()=>{throw Error('disk full');});await assert.rejects(s.recovery.start(s.session,'x'),{code:'TASK_RECOVERY_STORAGE'});assert.equal(s.calls.length,0);assert.equal(s.timers.size,0);assert.deepEqual(errors,['TASK_RECOVERY_STORAGE']);}finally{await s.close();}
});
test('repeated network failures back off to a bounded interval; close clears timers and serialization',async()=>{
 const s=setup();try{await s.recovery.start(s.session,'x');for(const expected of [10,20,40,80,100,100]){await s.failed();assert.equal([...s.timers.values()][0].ms,expected);await s.fire();}await s.failed();await s.close();assert.equal(s.timers.size,0);assert.equal(s.recovery.serial.size,0);}finally{await s.close();}
});
test('disabling the engine while recovery is reading fences late continuation',async()=>{
 const s=setup(),read=deferred();try{await s.recovery.start(s.session,'x');await s.failed();s.engine.readTurnState=()=>read.promise;const resume=s.recovery.resume(s.session);await tick();const pause=s.recovery.pause();read.resolve({known:true,turnId:'turn-1',status:'failed',error:turnError});await Promise.all([resume,pause]);assert.equal(s.calls.length,1);assert.equal(s.session.runRecovery.userStopped,true);}finally{await s.close();}
});
test('scheduler read failure retries without dispatch; stopped engine never receives a turn',async()=>{
 const s=setup();try{await s.recovery.start(s.session,'x');await s.failed();s.engine.queueRequest=async()=>{throw Error('PROCESS_EXIT');};await s.fire();assert.equal(s.calls.length,1);assert.equal(s.timers.size,1);s.engine.ready=false;await s.fire();assert.equal(s.calls.length,1);assert.equal(s.timers.size,1);}finally{await s.close();}
});
test('supervisor backs off crashes, cancels pending restarts, and never restarts after close',async()=>{
 const timers=new Map(),changes=[];let restarted=0;
 const supervisor=new EngineSupervisor({restart:async()=>{restarted++;throw Error('crashed');},onChange:s=>changes.push(s),baseDelayMs:10,maxDelayMs:40,setTimer:(fn,ms)=>{const id=Symbol();timers.set(id,{fn,ms});return id;},clearTimer:id=>timers.delete(id)});
 for(const expected of [10,20,40,40]){supervisor.failed();assert.equal(timers.size,1);const [id,t]=timers.entries().next().value;assert.equal(t.ms,expected);timers.delete(id);await t.fn();}
 supervisor.close();assert.equal(timers.size,0);supervisor.failed();assert.equal(timers.size,0);assert.equal(restarted,4);assert.equal(supervisor.snapshot().status,'idle');
});

test('a repeated resume against a known active turn cannot change it into uncertain or dispatch again',async()=>{
 const s=setup();try{await s.recovery.start(s.session,'x');s.engine.readTurnState=async()=>({known:true,turnId:'turn-1',status:'inProgress',active:true});await assert.rejects(s.recovery.resume(s.session),{code:'TASK_NOT_RESUMABLE'});assert.equal(s.calls.length,1);assert.equal(s.session.runRecovery.status,'running');assert.equal(s.session.runRecovery.canResume,false);}finally{await s.close();}
});
test('an uncertain start can be stopped without falsely confirming a native interrupted terminal',async()=>{
 const s=setup();try{s.engine.startTurn=async()=>{throw Object.assign(Error('TIMEOUT'),{code:'TIMEOUT'});};await assert.rejects(s.recovery.start(s.session,'x'));await s.recovery.stop(s.session);assert.equal(s.session.runRecovery.status,'uncertain');assert.equal(s.session.runRecovery.userStopped,true);assert.equal(s.session.runRecovery.canResume,true);}finally{await s.close();}
});
test('manual continuation uses the request locale even before a preference save completes',async()=>{
 const s=setup();try{await s.recovery.start(s.session,'x');await s.failed();await s.recovery.resume(s.session,'zh-CN');assert.match(s.calls[1].input[0].text,/继续完成/);assert.equal(s.state.preferences.locale,'en');}finally{await s.close();}
});

test('preflight failure preserves previous run and dispatches nothing before a checkpoint',async()=>{
 const failure=Object.assign(Error('missing key'),{code:'MODEL_KEY_REQUIRED'}),s=setup({preflight:async()=>{throw failure;}});
 try{await assert.rejects(s.recovery.start(s.session,'private prompt'),{code:'MODEL_KEY_REQUIRED'});assert.equal(s.session.runRecovery,undefined);assert.equal(s.saved.length,0);assert.equal(s.calls.length,0);assert.equal(s.timers.size,0);}
 finally{await s.close();}
});
test('stop while preflight is pending prevents the validated task from dispatching',async()=>{
 const gate=deferred(),s=setup({preflight:()=>gate.promise});
 try{const start=s.recovery.start(s.session,'do not send'),rejected=assert.rejects(start,{code:'TASK_NOT_RESUMABLE'});await tick();const stop=s.recovery.stop(s.session);gate.resolve();await rejected;await stop;assert.equal(s.calls.length,0);assert.equal(s.session.runRecovery,undefined);}
 finally{await s.close();}
});
test('a recovery preflight failure unlocks configuration without replaying the task',async()=>{
 let ready=true;const s=setup({preflight:async()=>{if(!ready)throw Object.assign(Error('key removed'),{code:'MODEL_KEY_REQUIRED'});}});
 try{await s.recovery.start(s.session,'original');await s.failed();ready=false;await assert.rejects(s.recovery.resume(s.session),{code:'MODEL_KEY_REQUIRED'});assert.equal(s.calls.length,1);assert.equal(s.session.runRecovery.status,'failed');assert.equal(s.session.runRecovery.reason,'preflight_failed');assert.equal(s.session.runRecovery.turnId,'turn-1');assert.equal(s.timers.size,0);await s.recovery.recover();assert.equal(s.calls.length,1);ready=true;await s.recovery.resume(s.session);assert.equal(s.calls.length,2);assert.notEqual(s.calls[1].input,'original');}
 finally{await s.close();}
});
test('an uncertain no-ACK request requires full engine disposal before abandonment and never replays',async()=>{
 const s=setup();try{
  s.engine.startTurn=async()=>{throw Object.assign(Error('TIMEOUT'),{code:'TIMEOUT'});};
  await assert.rejects(s.recovery.start(s.session,'original secret input'),{code:'TIMEOUT'});
  const old=structuredClone(s.session.runRecovery);
  s.engine.ready=false;await assert.rejects(s.recovery.abandon(s.session),{code:'TASK_ABANDON_REQUIRES_STOP'});
  assert.equal(s.session.runRecovery.status,'uncertain');
  s.recovery.getEngine=()=>null;
  assert.deepEqual(await s.recovery.abandon(s.session),{ok:true,abandoned:true});
  assert.equal(s.session.runRecovery.status,'interrupted');assert.equal(s.session.runRecovery.canResume,false);
  assert.deepEqual(s.session.abandonedRuns,[{id:old.id,turnId:null,status:'uncertain',reason:'start_unverified',abandonedAt:new Date(100000).toISOString(),outcome:'unknown'}]);
  assert.equal(JSON.stringify(s.state).includes('original secret input'),false);assert.equal(s.calls.length,0);
  await s.recovery.abandon(s.session);assert.equal(s.session.abandonedRuns.length,1);
  await assert.rejects(s.recovery.resume(s.session),{code:'TASK_NOT_RESUMABLE'});await s.recovery.recover();assert.equal(s.calls.length,0);
 }finally{await s.close();}
});
test('abandonment evidence is durable and late old-engine notifications cannot alter a new run',async()=>{
 const s=setup();try{
  await s.recovery.start(s.session,'old');s.engine.activeTurns.clear();
  s.recovery.getEngine=()=>null;await s.recovery.abandon(s.session);
  const current={...s.engine,activeTurns:new Map()};s.recovery.getEngine=()=>current;
  const gate=deferred();current.startTurn=()=>gate.promise;
  const start=s.recovery.start(s.session,'new');await tick();
  const late=s.recovery.observe(s.session,note('turn/completed','unknown-old-turn','completed'),s.engine);
  gate.resolve({turn:{id:'new-turn',status:'inProgress'}});await start;await late;
  await s.recovery.observe(s.session,note('turn/started','turn-1','inProgress'),current);
  assert.equal(s.session.runRecovery.turnId,'new-turn');assert.equal(s.session.runRecovery.status,'running');
  await s.recovery.observe(s.session,note('turn/completed','new-turn','completed'),current);
  assert.equal(s.session.runRecovery.status,'completed');assert.equal(s.session.abandonedRuns.length,1);
 }finally{await s.close();}
});
test('failed abandonment persistence retains the uncertain lock and reports storage failure',async()=>{
 const s=setup();try{
  s.engine.startTurn=async()=>{throw Error('unknown');};await assert.rejects(s.recovery.start(s.session,'old'));
  const old=structuredClone(s.session.runRecovery);s.recovery.getEngine=()=>null;s.setSave(async()=>{throw Error('disk full');});
  await assert.rejects(s.recovery.abandon(s.session),{code:'TASK_RECOVERY_STORAGE'});
  assert.deepEqual(s.session.runRecovery,old);assert.equal(s.session.abandonedRuns,undefined);assert.equal(s.calls.length,0);
 }finally{await s.close();}
});

test('stopping or archiving an abandoned run cannot restore permission to resume it',async()=>{
 for(const reason of ['user_stopped','archived']){
  const s=setup();try{
   await s.recovery.start(s.session,'old');s.engine.activeTurns.clear();
   s.recovery.getEngine=()=>null;await s.recovery.abandon(s.session);
   const abandoned=structuredClone(s.session.runRecovery);s.recovery.getEngine=()=>s.engine;
   await s.recovery.stop(s.session,reason);
   assert.deepEqual(s.session.runRecovery,abandoned);
   await assert.rejects(s.recovery.resume(s.session),{code:'TASK_NOT_RESUMABLE'});
   assert.equal(s.calls.length,1);
  }finally{await s.close();}
 }
});
test('durable abandonment evidence fences a run even if a legacy stop already replaced its reason',async()=>{
 const s=setup();try{
  await s.recovery.start(s.session,'old');s.engine.activeTurns.clear();s.recovery.getEngine=()=>null;
  await s.recovery.abandon(s.session);s.session.runRecovery.reason='archived';s.session.runRecovery.canResume=true;s.recovery.getEngine=()=>s.engine;
  await assert.rejects(s.recovery.resume(s.session),{code:'TASK_NOT_RESUMABLE'});assert.equal(s.calls.length,1);
 }finally{await s.close();}
});
