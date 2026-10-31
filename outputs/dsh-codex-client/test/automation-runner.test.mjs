import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createAutomationRunner} from '../server/automation-runner.mjs';
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const task={id:'task',title:'Inspect',projectId:'p',prompt:'Read and summarize',engineId:'codex',model:'deepseek-v4.1-flash',permission:'read-only',effort:'high'};
function fixture(){
  const e=new EventEmitter();e.activeTurns=new Map();e.creations=0;e.starts=[];e.interrupts=[];
  e.createSession=async()=>{e.creations++;return{threadId:'thread-owned',model:task.model};};
  e.startTurn=async(id,input,options)=>{e.starts.push({id,input,options});e.activeTurns.set(id,'turn-owned');e.emit('notification',{method:'turn/started',params:{threadId:'thread-owned',turn:{id:'turn-owned',status:'inProgress'}}});return{turn:{id:'turn-owned'}};};
  e.interrupt=async id=>{e.interrupts.push(id);e.activeTurns.delete(id);e.emit('notification',{method:'turn/completed',params:{threadId:'thread-owned',turn:{id:'turn-owned',status:'interrupted'}}});};
  const state={sessions:[],models:[{id:task.model}]};const services={state,save:async()=>{},broadcastState:()=>{},transcripts:new Map(),getProject:()=>({id:'p',path:'/tmp'}),requireEngine:()=>e,getSelectedEngine:()=> 'codex'};
  return{e,state,services};
}
test('blocked engine/model/permission states never create a native session or run',async()=>{
  for(const change of [{engineId:'other'},{model:'unregistered'},{permission:'danger-full-access'},{effort:'ultra'}]){const f=fixture();const result=await createAutomationRunner(f.services)({...task,...change});assert.equal(result.status,'blocked');assert.equal(f.e.creations,0);}
  const f=fixture();f.e.activeTurns.set('existing','busy');assert.equal((await createAutomationRunner(f.services)(task)).status,'blocked');assert.equal(f.e.creations,0);
});
test('session registration must be durable before a model turn can be started',async()=>{
  const f=fixture();let release;const saved=new Promise(resolve=>release=resolve);const running=createAutomationRunner(f.services)(task,{onSession:()=>saved});await flush();assert.equal(f.e.starts.length,0);assert.equal(f.state.sessions.length,1);release();await flush();await f.e.interrupt(f.state.sessions[0].id);assert.equal((await running).status,'cancelled');
});
test('a start acknowledgement does not complete the task; only its own actual terminal event does',async()=>{
  const f=fixture();let complete=false;const running=createAutomationRunner(f.services)(task).then(value=>{complete=true;return value;});await flush();assert.equal(complete,false);assert.equal(f.e.starts.length,1);assert.equal(f.e.starts[0].options.sandbox,'read-only');
  f.e.emit('notification',{method:'turn/completed',params:{threadId:'other',turn:{id:'turn-owned',status:'completed'}}});f.e.emit('notification',{method:'turn/completed',params:{threadId:'thread-owned',turn:{id:'wrong',status:'completed'}}});await flush();assert.equal(complete,false);
  f.e.emit('notification',{method:'turn/completed',params:{threadId:'thread-owned',turn:{id:'turn-owned',status:'completed'}}});assert.equal((await running).status,'completed');assert.equal(f.e.listenerCount('notification'),0);
});
test('plugin cancellation interrupts the native run and waits for native interruption',async()=>{
  const f=fixture(),abort=new AbortController();const running=createAutomationRunner(f.services)(task,{signal:abort.signal});await flush();abort.abort();assert.equal((await running).status,'cancelled');assert.equal(f.e.interrupts.length,1);assert.equal(f.e.listenerCount('exit'),0);
});
test('engine exit and ambiguous native start errors preserve an unverified result without retries',async()=>{
  const f=fixture();const running=createAutomationRunner(f.services)(task);await flush();f.e.emit('exit');assert.equal((await running).status,'unknown');assert.equal(f.e.starts.length,1);
  const g=fixture();g.e.startTurn=async()=>{throw Object.assign(Error('timeout'),{code:'RPC_TIMEOUT'});};assert.equal((await createAutomationRunner(g.services)(task)).status,'unknown');
});
test('failed host save or automation session registration starts no model turn',async()=>{
  for(const at of ['save','onSession']){const f=fixture();if(at==='save')f.services.save=async()=>{throw Error('DISK_FULL');};const result=await createAutomationRunner(f.services)(task,{onSession:async()=>{if(at==='onSession')throw Error('DISK_FULL');}});assert.equal(result.status,'failed');assert.equal(f.e.starts.length,0);}
});
test('chat disable or a newly busy engine during durable binding prevents the scheduled turn',async()=>{
  for(const mode of ['disabled','busy']){const f=fixture();let enabled=true,release;const pending=new Promise(resolve=>release=resolve);f.services.canChat=()=>enabled;const running=createAutomationRunner(f.services)(task,{onSession:()=>pending});await flush();if(mode==='disabled')enabled=false;else f.e.activeTurns.set('manual-user-task','manual-turn');release();const result=await running;assert.equal(result.status,'blocked');assert.equal(f.e.starts.length,0);}
});
test('concurrent schedule claims reserve before native creation so only one starts',async()=>{
  const f=fixture();let release;const binding=new Promise(resolve=>release=resolve),run=createAutomationRunner(f.services);const first=run(task,{onSession:()=>binding});const second=await run({...task,id:'second'});assert.equal(second.status,'blocked');assert.equal(f.e.creations,1);await flush();release();await flush();await f.e.interrupt(f.state.sessions[0].id);await first;assert.equal(f.e.starts.length,1);
});

test('long automation runs have no default cutoff and configurable limits await a native terminal event',async()=>{
  const f=fixture(),timers=new Map();let counter=0;
  const clock={setTimeout:(fn,delay)=>{const id=++counter;timers.set(id,{fn,delay});return id;},clearTimeout:id=>timers.delete(id)};
  const running=createAutomationRunner({...f.services,maxRunMs:0,clock})(task);await flush();
  assert.equal(timers.size,0);assert.equal(f.e.interrupts.length,0);
  f.e.emit('notification',{method:'turn/completed',params:{threadId:'thread-owned',turn:{id:'turn-owned',status:'completed'}}});assert.equal((await running).status,'completed');
  const g=fixture();let interrupted=false,finished=false;g.e.interrupt=async()=>{interrupted=true;};
  const capped=createAutomationRunner({...g.services,maxRunMs:2*60*60*1000,clock})(task).then(value=>{finished=true;return value;});await flush();
  assert.equal(timers.size,1);const timer=[...timers.values()][0];assert.equal(timer.delay,7200000);timer.fn();await flush();
  assert.equal(interrupted,true);assert.equal(finished,false);
  g.e.emit('notification',{method:'turn/completed',params:{threadId:'thread-owned',turn:{id:'turn-owned',status:'interrupted'}}});assert.equal((await capped).status,'cancelled');assert.equal(timers.size,0);
  for(const maxRunMs of [-1,0.1,Infinity,2147483648,'bad'])assert.throws(()=>createAutomationRunner({...fixture().services,maxRunMs}),{code:'INVALID_AUTOMATION'});
});

test('long automation default is unlimited when no operator override exists',async t=>{
  const previous=process.env.DSH_AUTOMATION_MAX_RUN_MS;delete process.env.DSH_AUTOMATION_MAX_RUN_MS;
  t.after(()=>{if(previous===undefined)delete process.env.DSH_AUTOMATION_MAX_RUN_MS;else process.env.DSH_AUTOMATION_MAX_RUN_MS=previous;});
  const f=fixture(),running=createAutomationRunner({...f.services,clock:{setTimeout:()=>assert.fail('default must not install a run deadline')}})(task);await flush();
  await f.e.interrupt(f.state.sessions[0].id);await running;
});
