import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ClaudeCodeEngine } from '../lib/engine.js';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const init=options=>({type:'system',subtype:'init',model:options.model,session_id:options.resume??options.sessionId});
const text=(id,value)=>({type:'assistant',message:{id,content:[{type:'text',text:value}]}});
const success={type:'result',subtype:'success',is_error:false,result:'done'};
async function fixture(t,query,options={}){
  const root=await mkdtemp(path.join(tmpdir(),'dsh-claude-reliability-'));const cwd=path.join(root,'project');await mkdir(cwd);
  const engine=new ClaudeCodeEngine({dataDir:path.join(root,'data'),query,resolveApiKey:()=> 'isolated-test-key',idleTimeoutMs:1000,interruptTimeoutMs:50,shutdownTimeoutMs:50,checkpointIntervalMs:10,...options});
  t.after(async()=>{await engine.dispose();await rm(root,{recursive:true,force:true});});
  await engine.createSession('one',{cwd});return {engine,root};
}
async function done(engine){for(let i=0;i<200;i++){if(!engine.activeTurns.size)return;await pause(5);}throw new Error('TEST_TIMEOUT');}

test('active progress can outlive the idle window without a default turn-count or wall-clock limit',async t=>{
  let sdkOptions;
  const query=async function*({options}){sdkOptions=options;yield init(options);for(let i=0;i<12;i++){await pause(10);yield text(`message-${i}`,'working');}yield success;};
  const {engine}=await fixture(t,query,{idleTimeoutMs:45});await engine.startTurn('one','long task');await done(engine);
  assert.equal((await engine.readTurnState('one')).status,'completed');assert.equal(sdkOptions.maxTurns,undefined);assert.equal(engine.serial.size,0);
});

test('silent queries use an idle watchdog and a requested total deadline also applies to busy queries',async t=>{
  for(const deadline of [false,true]){
    const query=async function*({options}){yield init(options);while(!options.abortController.signal.aborted){await pause(5);if(deadline)yield text('still-working','working');}};
    const {engine}=await fixture(t,query,{idleTimeoutMs:deadline?100:30,...(deadline?{turnTimeoutMs:40}:{})});await engine.startTurn('one','watchdog');await done(engine);
    const state=await engine.readTurnState('one');assert.equal(state.status,'failed');assert.equal(state.error.code,deadline?'TIMEOUT':'IDLE_TIMEOUT');
  }
});

test('a lost interrupt receipt cannot prevent close from stopping the query',async t=>{
  let release,closeCalls=0;
  const query=({options})=>({async *[Symbol.asyncIterator](){yield init(options);await new Promise(resolve=>{release=resolve;});},interrupt:()=>new Promise(()=>{}),close(){closeCalls++;release?.();}});
  const {engine}=await fixture(t,query);await engine.startTurn('one','wait');while(!release)await pause(2);
  const result=await engine.interrupt('one');assert.equal(result.interrupted,true);assert.ok(closeCalls>=1);assert.equal(engine.activeTurns.size,0);assert.equal((await engine.readTurnState('one')).status,'interrupted');
});

test('an uncooperative query stays fenced after bounded interruption and cannot mutate state after shutdown',async t=>{
  let release,sdkOptions;
  const query=({options})=>{sdkOptions=options;return {async *[Symbol.asyncIterator](){yield init(options);await new Promise(resolve=>{release=resolve;});yield text('late','must not persist');yield success;},interrupt:()=>new Promise(()=>{}),close(){}};};
  const {engine,root}=await fixture(t,query);const events=[];engine.on('notification',event=>events.push(event));
  await engine.startTurn('one','wait');while(!release)await pause(2);
  await assert.rejects(engine.interrupt('one'),{code:'INTERRUPT_TIMEOUT'});assert.equal(engine.activeTurns.size,1);
  await assert.rejects(engine.startTurn('one','duplicate'),{code:'TURN_IN_FLIGHT'});
  assert.equal((await sdkOptions.canUseTool('Read',{file_path:'file'},{signal:sdkOptions.abortController.signal})).behavior,'deny');
  await engine.dispose();assert.equal(engine.disposed,true);const count=events.length;const file=path.join(root,'data/sessions.json');const before=await readFile(file,'utf8');
  release();await pause(25);assert.equal(events.length,count);assert.equal(await readFile(file,'utf8'),before);assert.equal(engine.activeTurns.size,0);
});

test('partial text and tool results are checkpointed while the query remains active',async t=>{
  let release;
  const query=async function*({options}){yield init(options);yield text('partial','durable progress');yield {type:'assistant',message:{id:'tool',content:[{type:'tool_use',id:'read-one',name:'Read',input:{file_path:'notes.txt'}}]}};yield {type:'user',message:{content:[{type:'tool_result',tool_use_id:'read-one',content:'read result'}]}};await new Promise(resolve=>{release=resolve;});yield success;};
  const {engine,root}=await fixture(t,query);await engine.startTurn('one','save progress');while(!release)await pause(2);await pause(30);
  const saved=JSON.parse(await readFile(path.join(root,'data/sessions.json'),'utf8')).sessions[0].turns[0];assert.equal(saved.status,'inProgress');assert.equal(saved.items.find(item=>item.id==='partial:0').text,'durable progress');assert.equal(saved.items.find(item=>item.id==='read-one').aggregatedOutput,'read result');
  release();await done(engine);
});

test('a terminal save resuming after bounded disposal cannot emit a late completion',async t=>{
  let finish;const query=async function*({options}){yield init(options);await new Promise(resolve=>{finish=resolve;});yield success;};
  const {engine}=await fixture(t,query);await engine.startTurn('one','finish');while(!finish)await pause(2);await pause(20);
  const original=engine._save.bind(engine);let release,entered;
  const gate=new Promise(resolve=>{entered=resolve;});let first=true;
  engine._save=async()=>{if(first){first=false;entered();await new Promise(resolve=>{release=resolve;});}return original();};
  finish();await gate;const events=[];engine.on('turn-completed',event=>events.push(event));await engine.dispose();release();await pause(20);
  assert.equal(events.length,0);assert.equal(engine.activeTurns.size,0);
});

test('slow checkpoint persistence never accumulates a second pending checkpoint',async t=>{
  let finish;const query=async function*({options}){yield init(options);await new Promise(resolve=>{finish=resolve;});yield success;};
  const {engine}=await fixture(t,query);await engine.startTurn('one','checkpoint');while(!finish)await pause(2);await pause(20);
  const original=engine._save.bind(engine);let release,calls=0;engine._save=()=>{calls++;return new Promise(resolve=>{release=resolve;});};
  const active=engine.inflight.get('one');engine._checkpoint(active);await pause(20);for(let i=0;i<15;i++){engine._checkpoint(active);await pause(2);}assert.equal(calls,1);
  engine._save=original;release();finish();await done(engine);
});
