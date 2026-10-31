import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';

const mainURL=new URL('../desktop/main.cjs',import.meta.url),require=createRequire(mainURL);
const source=await readFile(mainURL,'utf8');
const flush=()=>new Promise(resolve=>setImmediate(resolve));

async function startup({supervised,startHost=async()=>{throw Object.assign(Error('DATA_IN_USE'),{code:'DATA_IN_USE'});},beforeReject}={}) {
  const app=new EventEmitter(),events=[],logs=[],timers=new Map();let nextTimer=0;
  Object.assign(app,{setName(){},getPath:()=>'/isolated-test',setPath(){},requestSingleInstanceLock:()=>true,whenReady:()=>Promise.resolve(),getLocale:()=> 'en',getVersion:()=> 'test',setAboutPanelOptions(){},quit:()=>events.push(['quit',0]),exit:code=>events.push(['exit',code])});
  const electron={app,ipcMain:{handle(){}},dialog:{showErrorBox:()=>events.push(['dialog'])},Menu:{buildFromTemplate:value=>value,setApplicationMenu(){}},screen:{getPrimaryDisplay(){throw Error('WINDOW_START_FAILED');}},powerSaveBlocker:{start:()=>1,stop(){}},powerMonitor:new EventEmitter()};
  const support=require('./support.cjs');
  const injected=source.replace("await import('../server/index.mjs')",'await importHost()');
  assert.notEqual(injected,source,'mock only the host import; execute the actual desktop startup and failure handling');
  vm.runInNewContext(injected,{require:id=>id==='electron'?electron:id==='./support.cjs'?{...support,DesktopStateStore:class{read(){return {};}async save(){}async flush(){}}}:require(id),importHost:async()=>({startHost}),__dirname:fileURLToPath(new URL('../desktop/',import.meta.url)),process:{env:supervised===undefined?{}:{DSH_PROCESS_SUPERVISED:supervised},platform:process.platform},setTimeout:(fn,ms)=>{const id=++nextTimer;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),setImmediate,URL,console:{error:(...args)=>logs.push(args)}});
  await flush();await beforeReject?.(app,events,timers);await flush();
  return{events,logs,timers,app};
}

test('supervised data-lock startup failure exits nonzero without a blocking dialog',async()=>{
  const result=await startup({supervised:'1'});
  assert.deepEqual(result.events,[['exit',75]]);assert.deepEqual(result.logs,[['DSH_DESKTOP_STARTUP_FAILED','DATA_IN_USE']]);assert.equal(result.timers.size,0);
});

test('ordinary launch retains the startup dialog and normal exit unless supervision is explicitly enabled',async()=>{
  for(const supervised of [undefined,'0','true']){
    const result=await startup({supervised});assert.deepEqual(result.events,[['dialog'],['quit',0]]);assert.equal(result.logs.length,0);assert.equal(result.timers.size,0);
  }
});

test('supervised window startup failure closes the initialized host before reporting failure',async()=>{
  const calls=[];
  const result=await startup({supervised:'1',startHost:async()=>({url:'http://127.0.0.1:51234',state:()=>({sessions:[]}),close:async()=>{calls.push('close');}})});
  assert.deepEqual(calls,['close']);assert.deepEqual(result.events,[['exit',75]]);assert.equal(result.timers.size,0);
});

test('startup cleanup failure disposes the engine before allowing a supervised retry',async()=>{
  const calls=[];
  const result=await startup({supervised:'1',startHost:async()=>({url:'http://127.0.0.1:51234',state:()=>({sessions:[]}),close:async()=>{calls.push('close');throw Error('CLOSE_FAILED');},engine:{dispose:async()=>{calls.push('dispose');}}})});
  assert.deepEqual(calls,['close','dispose']);assert.deepEqual(result.events,[['exit',75]]);assert.equal(result.timers.size,0);
});

test('a stalled host and engine cleanup cannot permanently stop supervised startup recovery',async()=>{
  const calls=[];
  const result=await startup({supervised:'1',startHost:async()=>({url:'http://127.0.0.1:51234',state:()=>({sessions:[]}),close:()=>{calls.push('close');return new Promise(()=>{});},engine:{dispose:()=>{calls.push('dispose');return new Promise(()=>{});}}}),beforeReject:async(_app,events,timers)=>{
    assert.deepEqual(events,[]);const shutdown=[...timers.values()].find(timer=>timer.ms===20000);assert.ok(shutdown);shutdown.fn();await flush();
    const dispose=[...timers.values()].find(timer=>timer.ms===3000);assert.ok(dispose);dispose.fn();
  }});
  assert.deepEqual(calls,['close','dispose']);assert.deepEqual(result.events,[['exit',75]]);assert.equal(result.timers.size,0);
});

test('an explicit quit while supervised startup is pending remains a normal exit',async()=>{
  let reject;const pending=new Promise((_,fail)=>{reject=fail;});
  const result=await startup({supervised:'1',startHost:()=>pending,beforeReject:async app=>{
    let prevented=false;app.emit('before-quit',{preventDefault(){prevented=true;}});assert.equal(prevented,true);reject(Error('DATA_IN_USE'));
  }});
  assert.ok(result.events.length>0);assert.ok(result.events.every(event=>event[0]==='quit'&&event[1]===0));assert.equal(result.logs.length,0);assert.equal(result.timers.size,0);
});
