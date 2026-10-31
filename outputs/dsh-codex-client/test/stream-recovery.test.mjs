import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { StreamRecovery } from '../src/lib/stream-recovery.js';
import { HistoryController } from '../src/lib/history-controller.js';
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
function setup(overrides={}){
  const states=[],sessions=[],errors=[],restored=[];
  const recovery=new StreamRecovery({readState:async()=>({version:1}),applyState:value=>states.push(value),getSelected:()=> 'chat-a',refreshSelected:async(id,signal)=>sessions.push({id,signal}),onRestored:details=>restored.push(details),onError:error=>errors.push(error),...overrides});
  return {recovery,states,sessions,errors,restored};
}
test('opening subscribes before independent state, selected history and panel recovery reads settle',async()=>{
  const state=deferred(),history=deferred(),panel=deferred(),called=[];
  const {recovery,states}=setup({readState:signal=>{called.push(['state',signal]);return state.promise;},refreshSelected:(id,signal)=>{called.push([id,signal]);return history.promise;},onRestored:({signal})=>{called.push(['panel',signal]);return panel.promise;}});
  const pending=recovery.opened();await tick();assert.deepEqual(called.map(row=>row[0]),['state','chat-a','panel']);assert.equal(new Set(called.map(row=>row[1])).size,1);
  history.resolve();panel.resolve();await tick();assert.deepEqual(states,[]);state.resolve({version:2});assert.deepEqual(await pending,{aborted:false,errors:[]});assert.deepEqual(states,[{version:2}]);recovery.stop();
});
test('a newer streamed state prevents an older snapshot from reverting it',async()=>{
  const read=deferred(),{recovery,states}=setup({readState:()=>read.promise});const pending=recovery.opened();await tick();recovery.observeState();read.resolve({version:'stale'});await pending;assert.deepEqual(states,[]);recovery.stop();
});
test('stop resolves recovery even when old reads ignore abort and never settle',async()=>{
  let signal;const {recovery,states,errors}=setup({readState:value=>{signal=value;return new Promise(()=>{});}});const pending=recovery.opened();await tick();recovery.stop();assert.deepEqual(await pending,{aborted:true});assert.equal(signal.aborted,true);assert.deepEqual(states,[]);assert.deepEqual(errors,[]);
});
test('a second opening cancels the previous generation and ignores its late state',async()=>{
  const old=deferred();let count=0;const signals=[];const {recovery,states,errors}=setup({readState:signal=>{signals.push(signal);return ++count===1?old.promise:Promise.resolve({version:'current'});}});
  const first=recovery.opened();await tick();const second=recovery.opened();assert.deepEqual(await first,{aborted:true});await second;old.resolve({version:'old'});await tick();assert.equal(signals[0].aborted,true);assert.deepEqual(states,[{version:'current'}]);assert.deepEqual(errors,[]);recovery.stop();
});
test('recovery has its own deadline even while the stream remains healthy',async()=>{
  let signal;const {recovery,errors}=setup({timeoutMs:25,readState:value=>{signal=value;return new Promise(()=>{});}});const result=await recovery.opened();assert.equal(result.aborted,false);assert.equal(result.errors[0].code,'STREAM_RECOVERY_TIMEOUT');assert.equal(signal.aborted,true);assert.equal(signal.reason.code,'STREAM_RECOVERY_TIMEOUT');assert.equal(errors.length,1);recovery.stop();
});
test('the same deadline bounds registered panel reads, and timeout cannot apply late state',async()=>{
  const late=deferred();let signal;const {recovery,states}=setup({timeoutMs:25,readState:()=>late.promise,onRestored:details=>{signal=details.signal;return new Promise(()=>{});}});await recovery.opened();late.resolve({version:'late'});await tick();assert.equal(signal.aborted,true);assert.deepEqual(states,[]);recovery.stop();
});
test('a read failure still attempts the other independent recoveries and is visible once',async()=>{
  const failure=new Error('read failed');const {recovery,sessions,restored,errors}=setup({readState:async()=>{throw failure;}});const result=await recovery.opened();assert.deepEqual(result.errors,[failure]);assert.equal(sessions.length,1);assert.equal(restored.length,1);assert.deepEqual(errors,[failure]);recovery.stop();
});
test('empty selection still refreshes state and panels without issuing an invalid session read',async()=>{
  const {recovery,sessions,states,restored}=setup({getSelected:()=>null});await recovery.opened();assert.deepEqual(sessions,[]);assert.equal(states.length,1);assert.equal(restored.length,1);recovery.stop();
});
test('history cancellation only releases the matching request, while timeout exposes a retryable error',()=>{
  const history=new HistoryController();history.select('a');const first=history.beginInitial(),second=history.beginInitial();assert.equal(history.cancelInitial(first),false);assert.equal(history.snapshot().loadingInitial,true);assert.equal(history.cancelInitial(second),true);assert.equal(history.snapshot().loadingInitial,false);assert.equal(history.snapshot().history.error,null);
  const timed=history.beginInitial();assert.equal(history.cancelInitial(timed,{error:'retry sync'}),true);assert.equal(history.snapshot().history.error,'retry sync');assert.equal(history.retryTarget(),'initial');assert.equal(history.completeInitial(timed,{items:[{id:'stale'}]}),false);assert.deepEqual(history.snapshot().items,[]);
  const old=history.beginInitial();history.select('b');assert.equal(history.cancelInitial(old,{error:'old error'}),false);assert.equal(history.snapshot().history.error,null);
});
