import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createTestEngine, tempDir, removeDir, readTrace, inbound, SECRET, waitFor } from './helpers.js';
import { normalizeNetworkRecovery } from '../lib/provider-config.js';

async function fixture(t,scenario='ok',options={}){const dataDir=await tempDir();const engine=createTestEngine(dataDir,scenario,{requestTimeoutMs:100,...options});t.after(async()=>{await engine.dispose();await removeDir(dataDir);});const session=await engine.createSession('one',{cwd:dataDir});return {engine,dataDir,session};}

test('native retry limits are explicit in both process and per-thread config and remain overridable',async t=>{
  const networkRecovery={requestMaxRetries:2,streamMaxRetries:4,streamIdleTimeoutMs:90000};const {engine,dataDir}=await fixture(t,'ok',{networkRecovery});
  const config=await readFile(path.join(engine.codexHome,'config.toml'),'utf8');assert.match(config,/request_max_retries = 2/);assert.match(config,/stream_max_retries = 4/);assert.match(config,/stream_idle_timeout_ms = 90000/);
  const profile=inbound(await readTrace(dataDir),'thread/start')[0].msg.params.config.model_providers.opencode_go;assert.equal(profile.request_max_retries,2);assert.equal(profile.stream_max_retries,4);assert.equal(profile.stream_idle_timeout_ms,90000);
  assert.equal(normalizeNetworkRecovery().request_max_retries,6);assert.throws(()=>normalizeNetworkRecovery({requestMaxRetries:-1}));assert.throws(()=>normalizeNetworkRecovery({streamIdleTimeoutMs:Infinity}));
});

test('a lost start ACK is fenced and reconciles against the exact observed native turn without replay',async t=>{
  const {engine,dataDir,session}=await fixture(t,'reliability-lost-start-ack');
  await assert.rejects(engine.startTurn('one','run exactly once'),{code:'TIMEOUT'});const turnId=engine.activeTurns.get('one').turnId;
  await assert.rejects(engine.startTurn('one','must not run'),{code:'TURN_STATE_UNKNOWN'});
  const running=await engine.readTurnState('one',turnId);assert.equal(running.known,true);assert.equal(running.active,true);assert.equal(running.pendingOperation,null);
  const completed=[];engine.on('turn-completed',event=>completed.push(event));
  await engine.client.request('fixture/complete',{threadId:session.threadId,status:'failed',error:{message:`connection failed ${SECRET}`,codexErrorInfo:'streamConnectionFailed'},notify:false});
  const state=await engine.readTurnState('one',turnId);assert.equal(state.terminal,true);assert.equal(state.status,'failed');assert.equal(state.error.message.includes(SECRET),false);assert.equal(engine.activeTurns.size,0);assert.equal(completed.length,1);assert.equal(completed[0].error.codexErrorInfo,'streamConnectionFailed');
  assert.equal(inbound(await readTrace(dataDir),'turn/start').length,1);
});

test('a start with no ACK or notification stays unknown even when a latest turn exists',async t=>{
  const {engine,dataDir}=await fixture(t,'reliability-lost-start-all');await assert.rejects(engine.startTurn('one','once'),{code:'TIMEOUT'});
  const state=await engine.readTurnState('one');assert.equal(state.known,false);assert.equal(state.status,'unknown');assert.equal(state.turnId,null);assert.ok(state.candidateTurnId);
  await assert.rejects(engine.startTurn('one','no duplicate'),{code:'TURN_STATE_UNKNOWN'});assert.equal(inbound(await readTrace(dataDir),'turn/start').length,1);
});

test('queued starts use the same uncertainty fence and do not replay an accepted queue item',async t=>{
  const {engine,dataDir}=await fixture(t,'reliability-lost-start-ack');await assert.rejects(engine.queueRequest('one','start',{queuedSubmissionId:'queued-one'}),{code:'TIMEOUT'});
  await assert.rejects(engine.queueRequest('one','start',{queuedSubmissionId:'queued-one'}),{code:'TURN_STATE_UNKNOWN'});
  assert.equal(inbound(await readTrace(dataDir),'thread/queue/start').length,1);assert.equal((await engine.readTurnState('one')).active,true);
});

test('a broken stdin stops its own child and retains recovery ownership',async t=>{
  const {engine}=await fixture(t,'reliability-interrupt-ack-only');const started=await engine.startTurn('one','work');const child=engine.client.child;
  engine.client._onStdinError();assert.equal(engine.ready,false);await waitFor(()=>child.exitCode!==null||child.signalCode!==null);
  assert.equal(engine.pendingOperations.get('one').turnId,started.turnId);assert.equal(engine.activeTurns.size,0);
});

test('interrupt ACK or timeout cannot release a still-running turn or repeat the interrupt',async t=>{
  for(const scenario of ['reliability-interrupt-ack-only','reliability-lost-interrupt-ack']){
    const {engine,dataDir,session}=await fixture(t,scenario);const started=await engine.startTurn('one','work');
    if(scenario==='reliability-lost-interrupt-ack')await assert.rejects(engine.interrupt('one'),{code:'TIMEOUT'});else await engine.interrupt('one');
    await assert.rejects(engine.interrupt('one'),{code:'TURN_STATE_UNKNOWN'});assert.equal((await engine.readTurnState('one',started.turnId)).active,true);
    await assert.rejects(engine.startTurn('one','no overlap'),{code:'TURN_STATE_UNKNOWN'});
    await engine.client.request('fixture/complete',{threadId:session.threadId,status:'interrupted',notify:false});assert.equal((await engine.readTurnState('one',started.turnId)).status,'interrupted');assert.equal(engine.pendingOperations.size,0);assert.equal(engine.activeTurns.size,0);
    assert.equal(inbound(await readTrace(dataDir),'turn/interrupt').length,1);
  }
});

test('native process loss retains exact turn ownership for host recovery',async t=>{
  const {engine,session}=await fixture(t,'reliability-interrupt-ack-only');const started=await engine.startTurn('one','work');engine.client.child.kill('SIGTERM');await waitFor(()=>!engine.ready);
  assert.equal(engine.activeTurns.size,0);const pending=engine.pendingOperations.get('one');assert.equal(pending.threadId,session.threadId);assert.equal(pending.turnId,started.turnId);assert.equal(pending.reason,'PROCESS_EXIT');
  await assert.rejects(engine.startTurn('one','no replay'),{code:'TURN_STATE_UNKNOWN'});
});

test('turn event memory is bounded over repeated activity while recent duplicate completion is suppressed',async t=>{
  const {engine,session}=await fixture(t,'ok',{eventHistoryLimit:32});const events=[];engine.on('turn-completed',event=>events.push(event));
  for(let i=0;i<500;i++){const turn={id:`synthetic-${i}`,status:'completed'};engine._onNotification({method:'turn/completed',params:{threadId:session.threadId,turn}});}
  engine._onNotification({method:'turn/completed',params:{threadId:session.threadId,turn:{id:'synthetic-499',status:'completed'}}});assert.equal(events.length,500);assert.ok(engine.completedTurns.size<=32);assert.ok(engine.seenTurnEvents.size<=32);
});

test('late recovery metadata cannot overwrite a newer turn or mutate a disposed engine',async t=>{
  for(const dispose of [false,true]){
    const {engine,session}=await fixture(t,'reliability-interrupt-ack-only');const started=await engine.startTurn('one','work');
    const request=engine.client.request.bind(engine.client);let release;
    engine.client.request=(method,...args)=>method==='thread/turns/list'?new Promise(resolve=>{release=resolve;}):request(method,...args);
    const reading=engine.readTurnState('one',started.turnId);const rejected=dispose?assert.rejects(reading,{code:'DISPOSED'}):null;while(!release)await new Promise(resolve=>setImmediate(resolve));
    if(dispose)await engine.dispose();else engine.inflight.set('one',{threadId:session.threadId,turnId:'newer-turn'});
    release({data:[{id:started.turnId,status:'inProgress'}],nextCursor:null});
    if(dispose){await rejected;assert.equal(engine.activeTurns.size,0);}else{await reading;assert.equal(engine.activeTurns.get('one').turnId,'newer-turn');}
  }
});

test('recovery page timeout leaves the healthy child and long task running and ignores its late reply',async t=>{
  const {engine}=await fixture(t,'reliability-read-stall',{recoveryRequestTimeoutMs:30,recoveryReadTimeoutMs:1000});
  const started=await engine.startTurn('one','long work');const pid=engine.status().pid;const completed=[];engine.on('turn-completed',event=>completed.push(event));
  await assert.rejects(engine.readTurnState('one',started.turnId),{code:'TIMEOUT'});assert.equal(engine.ready,true);assert.equal(engine.status().pid,pid);assert.equal(engine.client.pending.size,0);assert.equal(engine.activeTurns.get('one').turnId,started.turnId);
  await new Promise(resolve=>setTimeout(resolve,230));assert.equal(completed.length,0);assert.equal(engine.activeTurns.get('one').turnId,started.turnId);assert.equal(engine.ready,true);
});

test('recovery pagination has one total deadline even when each individual page responds',async t=>{
  const {engine,dataDir}=await fixture(t,'reliability-read-paged',{recoveryRequestTimeoutMs:500,recoveryReadTimeoutMs:100});
  const started=await engine.startTurn('one','long work');const begin=Date.now();await assert.rejects(engine.readTurnState('one',started.turnId),{code:'TIMEOUT'});
  assert.ok(Date.now()-begin<500);const reads=inbound(await readTrace(dataDir),'thread/turns/list');assert.ok(reads.length>=2&&reads.length<=3);assert.equal(engine.ready,true);assert.equal(engine.activeTurns.get('one').turnId,started.turnId);assert.equal(engine.client.pending.size,0);
});
