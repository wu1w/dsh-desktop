import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {EventEmitter} from 'node:events';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
const require=createRequire(import.meta.url);
const {RendererRecovery,ActivityPowerGuard}=require('../desktop/reliability.cjs');
function clockFixture(){
  let now=0,sequence=0;const timers=new Map();
  return{now:()=>now,advance:ms=>{now+=ms;},setTimer:(fn,ms)=>{const id=++sequence;timers.set(id,{fn,ms});return id;},clearTimer:id=>timers.delete(id),fire(){const [id,value]=timers.entries().next().value;timers.delete(id);value.fn();return value.ms;},timers};
}
test('renderer recovery deduplicates pending reloads, backs off and bounds a crash loop',()=>{
  const clock=clockFixture(),recovery=new RendererRecovery(clock);let reloads=0;
  for(const delay of [250,1000,5000]){assert.equal(recovery.schedule(()=>reloads++),true);assert.equal(recovery.schedule(()=>reloads++),true);assert.equal(clock.timers.size,1);assert.equal(clock.fire(),delay);}
  assert.equal(reloads,3);assert.equal(recovery.schedule(()=>reloads++),false);assert.equal(clock.timers.size,0);
  clock.advance(300000);assert.equal(recovery.schedule(()=>reloads++),true);recovery.cancel();assert.equal(clock.timers.size,0);assert.equal(reloads,3);
});
test('only active background work keeps idle suspension blocked and resume and shutdown release resources',()=>{
  const clock=clockFixture(),powerMonitor=new EventEmitter(),starts=[],stops=[],held=new Set();let state={sessions:[],activities:[]};
  const blocker={start:type=>{starts.push(type);held.add(starts.length);return starts.length;},stop:id=>{stops.push(id);held.delete(id);},isStarted:id=>held.has(id)};
  const guard=new ActivityPowerGuard({blocker,powerMonitor,readState:()=>{if(state instanceof Error)throw state;return state;},...clock});
  guard.start();guard.start();assert.equal(starts.length,0);assert.equal(clock.timers.size,1);assert.equal(powerMonitor.listenerCount('resume'),1);
  state={sessions:[{id:'chat',running:true}]};clock.fire();assert.deepEqual(starts,['prevent-app-suspension']);clock.fire();assert.equal(starts.length,1);
  state=Error('temporary snapshot error');clock.fire();assert.equal(held.size,1);
  state={sessions:[],activities:[{id:'run',pluginId:'feature-automations',kind:'automation',count:1}]};held.clear();powerMonitor.emit('resume');assert.equal(starts.length,2);
  state={sessions:[],activities:[]};clock.fire();assert.equal(held.size,0);
  state={sessions:[{id:'chat',running:true}]};guard.update();assert.equal(held.size,1);guard.stop();guard.stop();assert.equal(held.size,0);assert.equal(clock.timers.size,0);assert.equal(powerMonitor.listenerCount('resume'),0);assert.equal(stops.length,2);
  clock.advance(1000000);powerMonitor.emit('resume');assert.equal(held.size,0);
});
test('long network backoff and engine restart keep the sleep guard until recovery is stopped or idle',()=>{
  const clock=clockFixture(),held=new Set(),starts=[];
  const blocker={start:type=>{starts.push(type);held.add(starts.length);return starts.length;},stop:id=>held.delete(id),isStarted:id=>held.has(id)};
  let state={sessions:[{id:'chat',running:false,runRecovery:{id:'run',status:'waiting',managed:true,userStopped:false}}]};
  const guard=new ActivityPowerGuard({blocker,readState:()=>state,...clock});guard.start();assert.equal(held.size,1);
  for(let n=0;n<60;n++){clock.advance(5000);clock.fire();assert.equal(held.size,1);}
  assert.equal(starts.length,1);state.sessions[0].runRecovery.userStopped=true;clock.fire();assert.equal(held.size,0);
  state={engine:{id:'codex',recovery:{status:'waiting'}}};clock.fire();assert.equal(held.size,1);
  state.engine.recovery.status='restarting';clock.fire();assert.equal(held.size,1);assert.equal(starts.length,2);
  state.engine.recovery.status='idle';clock.fire();assert.equal(held.size,0);guard.stop();assert.equal(clock.timers.size,0);
});
test('actual desktop crash recovery reloads only the renderer, preserves dirty recovery state and cancels on close',async()=>{
  const app=new EventEmitter(),clock=clockFixture();let reloads=0,dialogs=0,hostCloses=0,win;
  Object.assign(app,{setName(){},getPath(){return '/tmp';},setPath(){},requestSingleInstanceLock(){return true;},whenReady(){return new Promise(()=>{});}});
  class Window extends EventEmitter{
    constructor(){super();win=this;this.webContents=new EventEmitter();Object.assign(this.webContents,{setWindowOpenHandler(){},session:Object.assign(new EventEmitter(),{setPermissionRequestHandler(){},setPermissionCheckHandler(){}})});}
    isDestroyed(){return false;}async loadURL(){}reload(){reloads++;}
  }
  const display={id:1,workArea:{x:0,y:0,width:1440,height:900}};
  const electron={app,BrowserWindow:Window,screen:{getPrimaryDisplay:()=>display,getAllDisplays:()=>[display]},dialog:{async showMessageBox(){dialogs++;return{response:0};}}};
  const source=await readFile(new URL('../desktop/main.cjs',import.meta.url),'utf8'),module={exports:{}},scopedRequire=createRequire(new URL('../desktop/main.cjs',import.meta.url));
  vm.runInNewContext(source+'\nmodule.exports={createWindow,inject:(clock,close)=>{store={read:()=>({})};host={url:"http://127.0.0.1:1",close};origin=host.url;closeState={dirty:true,running:true,dirtyRevision:7};Object.assign(rendererRecovery,clock);},state:()=>closeState,setTransition:value=>{transition=value;}};',{require:id=>id==='electron'?electron:scopedRequire(id),module,__dirname:fileURLToPath(new URL('../desktop/',import.meta.url)),process,setTimeout,clearTimeout,setImmediate,URL,console});
  module.exports.inject(clock,()=>{hostCloses++;});await module.exports.createWindow();
  let cancelTransition;module.exports.setTransition(new Promise(resolve=>{cancelTransition=resolve;}));win.webContents.emit('render-process-gone');assert.equal(clock.timers.size,0);
  module.exports.setTransition(null);cancelTransition(false);await new Promise(resolve=>setImmediate(resolve));assert.equal(clock.timers.size,1);clock.fire();
  for(let count=0;count<2;count++){win.webContents.emit('render-process-gone');clock.fire();}
  assert.equal(reloads,3);assert.equal(dialogs,0);assert.equal(hostCloses,0);assert.equal(module.exports.state().dirty,true);assert.equal(module.exports.state().dirtyRevision,7);
  win.webContents.emit('render-process-gone');win.webContents.emit('render-process-gone');await new Promise(resolve=>setImmediate(resolve));assert.equal(dialogs,1);assert.equal(reloads,4);assert.equal(module.exports.state().dirty,true);
  clock.advance(300000);win.webContents.emit('render-process-gone');assert.equal(clock.timers.size,1);win.emit('closed');assert.equal(clock.timers.size,0);assert.equal(hostCloses,0);
});
