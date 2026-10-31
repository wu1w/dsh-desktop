import test from 'node:test';
import assert from 'node:assert/strict';
import {ReconnectController} from '../shell/reconnect.js';
import {StreamRecovery} from '../src/lib/stream-recovery.js';
import {runStatus,runStatusKey,canStopRun,canResumeRun} from '../src/lib/run-status.js';
import {translator} from '../src/i18n.js';

const turn=()=>new Promise(resolve=>setImmediate(resolve));
function timers(){let sequence=0;const pending=new Map();return{pending,schedule:(fn,ms)=>{const id=++sequence;pending.set(id,{fn,ms});return id;},cancel:id=>pending.delete(id),fire(){const [id,value]=pending.entries().next().value;pending.delete(id);value.fn();return value.ms;}};}
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};

test('reconnect backs off to its cap, online wake owns one attempt, and stop leaves no timer',async()=>{
 const clock=timers(),statuses=[],signals=[];let count=0;
 const connection=new ReconnectController({...clock,random:()=>1,baseDelayMs:10,maxDelayMs:40,onStatus:s=>statuses.push(s),connect:async({signal})=>{signals.push(signal);count++;throw new Error('offline');}});
 connection.start();await turn();assert.equal(count,1);
 assert.equal(clock.fire(),10);await turn();assert.equal(clock.fire(),20);await turn();assert.equal(clock.fire(),40);await turn();
 connection.wake();connection.wake();await turn();assert.equal(count,5);assert.equal(clock.pending.size,1);assert.equal([...clock.pending.values()][0].ms,40);
 connection.stop();assert.equal(clock.pending.size,0);connection.wake();await turn();assert.equal(count,5);assert.ok(signals.every(s=>s.aborted));assert.equal(statuses.at(-1),'reconnecting');
});
test('an aborted generation cannot reconnect or report connected after a later start',async()=>{
 const clock=timers(),old=deferred(),fresh=deferred(),statuses=[];let count=0,oldOpen,freshSignal;
 const connection=new ReconnectController({...clock,onStatus:s=>statuses.push(s),connect:({onOpen,signal})=>{if(++count===1){oldOpen=onOpen;return old.promise;}freshSignal=signal;onOpen();return fresh.promise;}});
 connection.start();connection.stop();connection.start();assert.equal(statuses.at(-1),'connected');oldOpen();old.resolve();await turn();assert.equal(clock.pending.size,0);assert.equal(connection.controller.signal,freshSignal);connection.stop();fresh.resolve();await turn();assert.equal(clock.pending.size,0);
});
test('read-only recovery retries with a finite budget and preserves newer streamed state',async()=>{
 const clock=timers(),states=[],statuses=[],calls=[];let reads=0;
 const recovery=new StreamRecovery({...clock,timeoutMs:200,retryBaseMs:5,maxRetries:2,onStatus:s=>statuses.push(s.status),readState:async()=>{calls.push('state');if(++reads<3)throw new Error('transient');return {version:3};},applyState:s=>states.push(s),getSelected:()=> 'chat',refreshSelected:async()=>calls.push('history'),onRestored:async()=>calls.push('panel')});
 await recovery.opened();assert.equal(statuses.at(-1),'retrying');assert.equal(clock.fire(),5);await turn();assert.equal(clock.fire(),10);await turn();assert.equal(statuses.at(-1),'ready');assert.deepEqual(states,[{version:3}]);assert.equal(calls.length,9);assert.equal(clock.pending.size,0);recovery.stop();
 const failed=new StreamRecovery({...clock,retryBaseMs:1,maxRetries:1,onStatus:s=>statuses.push(s.status),readState:async()=>{throw new Error('permanent');},applyState:()=>{},getSelected:()=>null,refreshSelected:()=>{}});await failed.opened();clock.fire();await turn();assert.equal(statuses.at(-1),'failed');assert.equal(clock.pending.size,0);failed.stop();
});
test('disconnect cancels an automatic recovery retry without reading or mutating again',async()=>{
 const clock=timers();let calls=0;
 const recovery=new StreamRecovery({...clock,readState:async()=>{calls++;throw Error('fail');},applyState:()=>{},getSelected:()=>null,refreshSelected:()=>{}});await recovery.opened();assert.equal(clock.pending.size,1);recovery.stop();assert.equal(clock.pending.size,0);await turn();assert.equal(calls,1);
});
test('durable user interruption cannot be mislabelled complete or revived by stale live history',()=>{
 for(const status of ['waiting','interrupted','failed','uncertain','completed','running']){
  const session={running:status==='running',runRecovery:{status,canResume:true}};
  assert.equal(runStatus(session,true),status);assert.equal(canStopRun(session,true),['running','waiting'].includes(status));assert.equal(canResumeRun(session),['interrupted','failed','uncertain'].includes(status));
  for(const locale of ['zh-CN','en'])assert.notEqual(translator(locale)(runStatusKey(session,true)),runStatusKey(session,true));
 }
 assert.equal(canResumeRun({runRecovery:{status:'uncertain',canResume:false}}),false);assert.equal(canResumeRun(null),false);
});
