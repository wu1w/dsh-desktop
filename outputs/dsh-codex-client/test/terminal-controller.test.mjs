import test from 'node:test';
import assert from 'node:assert/strict';
import {TerminalController} from '../src/lib/terminal-controller.js';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function harness(request){const outputs=[],timers=[];const controller=new TerminalController({request,onOutput:(data,meta)=>outputs.push({data,...meta}),schedule:callback=>{timers.push(callback);return callback;},cancel:()=>{}});return{controller,outputs,timers};}
test('opening or changing a project never silently creates a shell and late lists cannot replace the selected project',async()=>{
  const pending=deferred(),calls=[];const {controller}=harness(route=>{calls.push(route);return route.includes('/old/')?pending.promise:Promise.resolve({terminals:[]});});
  const old=controller.project('old');await controller.project('new');pending.resolve({terminals:[{id:'foreign',status:'running'}]});await old;
  assert.equal(controller.state.projectId,'new');assert.equal(controller.state.selected,null);assert.equal(calls.length,2);controller.dispose();
});
test('a creation that finishes after project change is explicitly stopped to avoid orphan shells',async()=>{
  const pending=deferred(),calls=[];const {controller}=harness((route,body)=>{calls.push({route,body});if(body?.cols)return pending.promise;return Promise.resolve({terminals:[]});});
  await controller.project('old');const creating=controller.create();await controller.project('new');pending.resolve({id:'late',status:'running'});await creating;
  assert.equal(calls.at(-1).route,'projects/old/pty/late/stop');assert.equal(controller.state.selected,null);controller.dispose();
});
test('output uses server byte cursors, reset is explicit on gaps, and native limit errors remain visible',async()=>{
  const calls=[];let reads=0;const {controller,outputs,timers}=harness((route)=>{calls.push(route);if(!route.includes('?'))return Promise.resolve({terminals:[{id:'one',status:'running'}]});return Promise.resolve(++reads===1?{id:'one',status:'running',output:'中文',nextCursor:6,truncated:false}:{id:'one',status:'exited',output:'tail',nextCursor:20,truncated:true,error:'PTY_OUTPUT_LIMIT'});});
  await controller.project('p');await flush();assert.match(calls.at(-1),/after=0$/);await timers.shift()();await flush();
  assert.match(calls.at(-1),/after=6$/);assert.equal(outputs.at(-1).truncated,true);assert.equal(controller.state.error.code,'PTY_OUTPUT_LIMIT');controller.dispose();
});
test('input preserves UTF8 and serialization; a failed chunk is not automatically resent',async()=>{
  const calls=[],first=deferred();let sent=0;const {controller}=harness((route,body)=>{if(route.endsWith('/input')){calls.push(body.data);if(++sent===1)return first.promise;}return Promise.resolve({});});
  controller.state={projectId:'p',selected:'one',terminal:{status:'running'},terminals:[]};const a=controller.input('中'.repeat(3000)),b=controller.input('second\r');await flush();assert.equal(calls.length,1);assert.ok(Buffer.byteLength(calls[0])<=8192);first.reject(Object.assign(Error('write failed'),{code:'PTY_NOT_RUNNING'}));assert.equal(await a,false);assert.equal(await b,true);assert.deepEqual(calls.slice(1),['second\r']);controller.dispose();
});
test('late output and queued input after terminal switch cannot contaminate another terminal',async()=>{
  const pending=deferred(),calls=[];const {controller,outputs}=harness((route,body)=>{calls.push({route,body});return route.includes('/first?')?pending.promise:Promise.resolve({id:'second',status:'exited',output:'new',nextCursor:3});});
  controller.state={projectId:'p',selected:null,terminals:[{id:'first'},{id:'second'}]};controller.select('first');controller.select('second');await flush();pending.resolve({id:'first',status:'running',output:'old',nextCursor:3});await flush();assert.equal(outputs.at(-1).data,'new');assert.equal(controller.state.terminal.id,'second');controller.dispose();
});
test('input cap rejects oversized paste before sending any native input',async()=>{
  let calls=0;const {controller}=harness(()=>{calls++;});controller.state={projectId:'p',selected:'one',terminal:{status:'running'},terminals:[]};assert.equal(await controller.input('中'.repeat(22000)),false);assert.equal(calls,0);assert.equal(controller.state.inputError.code,'PTY_INPUT_LIMIT');controller.dispose();
});
test('stopping invalidates an earlier read so late running output cannot replace the terminal exit',async()=>{
  const old=deferred();let reads=0;const {controller,outputs}=harness((route)=>{if(route.endsWith('/stop'))return Promise.resolve({});return ++reads===1?old.promise:Promise.resolve({id:'one',status:'exited',output:'tail',nextCursor:4});});
  controller.state={projectId:'p',selected:null,terminals:[{id:'one',status:'running'}]};controller.select('one');await controller.stop();await flush();old.resolve({id:'one',status:'running',output:'tail',nextCursor:4});await flush();assert.deepEqual(outputs.filter(value=>value.data).map(value=>value.data),['tail']);assert.equal(controller.state.terminal.status,'exited');controller.dispose();
});
test('a successful output read does not erase an input failure warning',async()=>{
  const {controller,timers}=harness(route=>Promise.resolve(route.includes('?')?{id:'one',status:'running',output:'',nextCursor:0}:{terminals:[{id:'one',status:'running'}]}));
  await controller.project('p');await flush();await controller.input('x'.repeat(65537));await timers.shift()();await flush();assert.equal(controller.state.inputError.code,'PTY_INPUT_LIMIT');controller.dispose();
});
