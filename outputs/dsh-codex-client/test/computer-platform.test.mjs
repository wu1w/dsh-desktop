import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {EventEmitter} from 'node:events';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import {ComputerUse} from '../server/computer-use.mjs';

async function fixture(platform,nativeStatus,capture){
 const windows=[],partitions=[],nativeCalls=[],nativeRequests=[],children=[],external=[];
 class Window extends EventEmitter {
  constructor(options){super();this.options=options;this.destroyed=false;this.urls=[];this.webContents=new EventEmitter();Object.assign(this.webContents,{
   setWindowOpenHandler:fn=>this.openHandler=fn,isLoadingMainFrame:()=>false,
   executeJavaScriptInIsolatedWorld:async()=>({nativeObservation:'observed',text:'fixture',elements:[]}),
   capturePage:async()=>({resize:()=>({toDataURL:()=> 'data:image/png;base64,fixture'})}),stop(){},
  });windows.push(this);}
  async loadURL(url){this.urls.push(url);}
  isDestroyed(){return this.destroyed;}
  destroy(){this.destroyed=true;this.emit('closed');}
 }
 const electron={BrowserWindow:Window,session:{fromPartition(name){const partition=new EventEmitter();Object.assign(partition,{name,setPermissionRequestHandler:fn=>partition.permission=fn,setPermissionCheckHandler:fn=>partition.check=fn,clearStorageData:async()=>{partition.cleared=true;}});partitions.push(partition);return partition;}},shell:{openExternal:async url=>external.push(url)}};
 if(capture)electron.desktopCapturer={getSources:capture};
 const module={exports:{}},require=createRequire(new URL('../desktop/computer-runtime.cjs',import.meta.url));
 const fakeSpawn=(...args)=>{nativeCalls.push(args);const child=new EventEmitter();children.push(child);child.stdout=new EventEmitter();child.stdout.setEncoding=()=>{};child.stderr=new EventEmitter();child.stdin=new EventEmitter();child.stdin.write=line=>{if(nativeStatus){const request=JSON.parse(line);nativeRequests.push(request);const reply=typeof nativeStatus==='function'?nativeStatus(request):nativeStatus;if(reply)queueMicrotask(()=>child.stdout.emit('data',JSON.stringify({id:request.id,ok:true,...reply})+'\n'));}};child.kill=()=>child.emit('exit');if(!nativeStatus)queueMicrotask(()=>child.emit('error',Object.assign(Error('missing helper'),{code:'ENOENT'})));return child;};
 const source=await readFile(new URL('../desktop/computer-runtime.cjs',import.meta.url),'utf8');
 vm.runInNewContext(source,{require:id=>id==='electron'?electron:id==='node:child_process'?{spawn:fakeSpawn}:require(id),module,__dirname:fileURLToPath(new URL('../desktop/',import.meta.url)),process,setTimeout,clearTimeout,URL,console});
 const runtime=module.exports.createComputerRuntime({platform,app:{},locale:()=> 'en',environment:{SystemRoot:'C:\\Windows'}});
 return {runtime,windows,partitions,nativeCalls,nativeRequests,children,external};
}

test('unsupported platforms expose the browser without spawning a native helper or opening system settings',async()=>{
 const f=await fixture('linux');try{
 const status=await f.runtime.status();assert.equal(status.available,true);assert.equal(status.browserAvailable,true);assert.equal(status.nativeAvailable,false);assert.equal(status.nativeReason,'COMPUTER_NATIVE_UNSUPPORTED');
 await assert.rejects(f.runtime.apps(),{code:'COMPUTER_NATIVE_UNSUPPORTED'});
 await assert.rejects(f.runtime.permission('screen'),{code:'COMPUTER_NATIVE_UNSUPPORTED'});
 await assert.rejects(f.runtime.execute('one',{kind:'app',pid:42},{action:'observe'}),{code:'COMPUTER_NATIVE_UNSUPPORTED'});
 assert.equal(f.nativeCalls.length,0);assert.equal(f.external.length,0);
 }finally{f.runtime.close();}
});

test('Windows browser navigation keeps the sandbox, denies downloads and clears its isolated session',async()=>{
 const f=await fixture('win32');try{
 const first=await f.runtime.execute('one',{kind:'browser'},{action:'observe'});assert.equal(first.text,'fixture');
 const win=f.windows[0],partition=f.partitions[0];assert.equal(win.options.webPreferences.sandbox,true);assert.equal(win.options.webPreferences.contextIsolation,true);assert.equal(win.options.webPreferences.nodeIntegration,false);assert.equal(win.options.webPreferences.partition,partition.name);assert.equal(partition.name.startsWith('persist:'),false);
 await f.runtime.execute('one',{kind:'browser'},{action:'navigate',text:'https://example.invalid/path'});assert.equal(win.urls.at(-1),'https://example.invalid/path');
 await assert.rejects(f.runtime.execute('one',{kind:'browser'},{action:'navigate',text:'file:///private'}),{code:'COMPUTER_INVALID_URL'});
 assert.equal(win.openHandler().action,'deny');let allowed=true;partition.permission(null,null,value=>allowed=value);assert.equal(allowed,false);assert.equal(partition.check(),false);
 let cancelled=false;partition.emit('will-download',{}, {cancel:()=>cancelled=true});assert.equal(cancelled,true);
 f.runtime.stop('one');assert.equal(win.destroyed,true);assert.equal(partition.cleared,true);assert.equal(f.nativeCalls.length,0);
 }finally{f.runtime.close();}
});

test('a missing macOS native helper cannot disable the independent browser',async()=>{
 const f=await fixture('darwin');try{
 const status=await f.runtime.status();assert.equal(status.available,true);assert.equal(status.browserAvailable,true);assert.equal(status.nativeAvailable,false);assert.equal(status.nativeReason,'COMPUTER_NATIVE_UNAVAILABLE');assert.equal(f.nativeCalls.length,1);
 assert.equal((await f.runtime.execute('one',{kind:'browser'},{action:'observe'})).text,'fixture');
 }finally{f.runtime.close();}
});

test('closed runtime refuses new browser windows',async()=>{
 const f=await fixture('win32');f.runtime.close();assert.equal((await f.runtime.status()).browserAvailable,false);await assert.rejects(f.runtime.execute('one',{kind:'browser'},{action:'observe'}),{code:'COMPUTER_STOPPED'});assert.equal(f.windows.length,0);
});

test('host enforces per-target capabilities even if a caller bypasses the UI',async()=>{
 const calls=[];const runtime={status:async()=>({available:true,browserAvailable:true,nativeAvailable:false,nativeReason:'COMPUTER_NATIVE_UNSUPPORTED'}),apps:async()=>{throw Error('must not enumerate');},execute:async(...args)=>{calls.push(args);return {nativeObservation:'fixture'};},stop(){},close(){}};
 const service=new ComputerUse({runtime,state:{sessions:[{id:'one'}]},getEngine:()=>({activeTurns:new Map()})});try{
 await assert.rejects(service.connect('one',{kind:'app',pid:42}),{code:'COMPUTER_NATIVE_UNSUPPORTED'});assert.equal(calls.length,0);
 assert.equal((await service.connect('one',{kind:'browser'})).connected,true);
 runtime.status=async()=>({available:true,browserAvailable:false});await assert.rejects(service.connect('one',{kind:'browser'}),{code:'COMPUTER_UNAVAILABLE'});
 assert.equal(calls.length,1);
 }finally{service.close();}
});

test('Windows native status distinguishes an active desktop from blocked service or locked sessions',async()=>{
 for(const ready of [true,false]){
  const f=await fixture('win32',{nativeReady:ready,accessibility:ready,nativeReason:ready?null:'COMPUTER_DESKTOP_UNAVAILABLE',nativeValidation:'pending-windows-device'});
  try{const status=await f.runtime.status();assert.equal(status.browserAvailable,true);assert.equal(status.nativeAvailable,ready);assert.equal(status.nativeValidation,'pending-windows-device');assert.equal(f.nativeCalls.length,1);assert.equal(f.nativeCalls[0][0],'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');assert.equal(f.nativeCalls[0][2].windowsHide,true);assert.deepEqual(Object.keys(f.nativeCalls[0][2].env),['SystemRoot']);if(!ready)assert.equal(status.nativeReason,'COMPUTER_DESKTOP_UNAVAILABLE');}finally{f.runtime.close();}
 }
});

test('native IPC ignores bytes from an exited helper after a new helper starts',async()=>{
 const f=await fixture('win32',()=>undefined);
 try{
  const first=f.runtime.status();f.children[0].emit('error',Error('gone'));assert.equal((await first).nativeAvailable,false);
  const second=f.runtime.status();f.children[0].stdout.emit('data','not-json-from-old-helper');
  f.children[1].stdout.emit('data',JSON.stringify({id:f.nativeRequests[1].id,ok:true,nativeReady:true})+'\n');
  assert.equal((await second).nativeAvailable,true);
 }finally{f.runtime.close();}
});

test('native IPC preserves bound window identity and never accepts caller replacement fields',async()=>{
 const f=await fixture('win32',{nativeObservation:'new',windowId:'42',bounds:{x:-1920,y:0,width:1000,height:600}});
 try{await f.runtime.execute('one',{kind:'app',pid:123,windowId:'42',processStartTime:'638000000000000000'},{action:'observe',pid:999,windowId:'99',processStartTime:'1'});assert.equal(f.nativeRequests[0].pid,123);assert.equal(f.nativeRequests[0].windowId,'42');assert.equal(f.nativeRequests[0].processStartTime,'638000000000000000');}finally{f.runtime.close();}
});

test('app connection refuses recycled windows and preserves the verified process start identity',async()=>{
 const app={pid:42,name:'Fixture',windowId:'201',processStartTime:'638000000000000000'};const calls=[];
 const runtime={status:async()=>({available:true,nativeAvailable:true,accessibility:true}),apps:async()=>({apps:[app]}),execute:async(...args)=>{calls.push(args);return {nativeObservation:'fixture'};},stop(){},close(){}};
 const service=new ComputerUse({runtime,state:{sessions:[{id:'one'}]},getEngine:()=>({activeTurns:new Map()})});
 try{await assert.rejects(service.connect('one',{kind:'app',pid:42,windowId:'200',processStartTime:app.processStartTime}),{code:'COMPUTER_APP_GONE'});await assert.rejects(service.connect('one',{kind:'app',...app,processStartTime:'1'}),{code:'COMPUTER_APP_GONE'});await service.connect('one',{kind:'app',...app});assert.equal(calls[0][1].windowId,app.windowId);assert.equal(calls[0][1].processStartTime,app.processStartTime);}finally{service.close();}
});

const capturedThumbnail={isEmpty:()=>false,getSize:()=>({width:1100,height:695}),toDataURL:()=> 'data:image/png;base64,own-fixture'};
const capturedWindow={id:'window:42:0',thumbnail:capturedThumbnail};
const screenshotTarget={kind:'app',pid:123,windowId:'42',processStartTime:'638000000000000000'};
test('asynchronous selected-window capture returns the current native token rather than stale pre-capture authority',async()=>{
 let count=0;const bounds={x:322,y:210,width:746,height:473};
 const f=await fixture('win32',()=>({nativeObservation:++count===1?'old':'fresh',windowId:'42',bounds}),async()=>[capturedWindow]);
 try{const row=await f.runtime.execute('one',screenshotTarget,{action:'observe'});assert.equal(row.nativeObservation,'fresh');assert.equal(row.image,'data:image/png;base64,own-fixture');assert.equal(row.screenshot.mappingAvailable,false);assert.equal(f.nativeRequests.length,2);assert(f.nativeRequests.every(request=>request.action==='observe'));}finally{f.runtime.close();}
});
test('moving a window while capturing rejects its mismatched image without replaying the completed input',async()=>{
 let changed=false;const f=await fixture('win32',()=>({nativeObservation:'fresh',windowId:'42',bounds:{x:changed?400:322,y:210,width:746,height:473}}),async()=>{changed=true;return[capturedWindow];});
 try{await assert.rejects(f.runtime.execute('one',screenshotTarget,{action:'key',key:'7',nativeObservation:'old'}),{code:'COMPUTER_OBSERVATION_STALE'});assert.deepEqual(f.nativeRequests.map(request=>request.action),['key','observe']);}finally{f.runtime.close();}
});
test('a target closed during capture propagates app-gone instead of swallowing it as a missing screenshot',async()=>{
 let count=0;const f=await fixture('win32',()=>++count===1?{nativeObservation:'old',windowId:'42',bounds:{x:0,y:0,width:700,height:500}}:{ok:false,code:'COMPUTER_APP_GONE'},async()=>[capturedWindow]);
 try{await assert.rejects(f.runtime.execute('one',screenshotTarget,{action:'observe'}),{code:'COMPUTER_APP_GONE'});}finally{f.runtime.close();}
});
test('an empty or different-window thumbnail never becomes a selected-target screenshot',async()=>{
 for(const sources of [[{id:'window:99:0',thumbnail:capturedThumbnail}],[{id:'window:42:0',thumbnail:{...capturedThumbnail,isEmpty:()=>true}}]]){
  const f=await fixture('win32',{nativeObservation:'old',windowId:'42',bounds:{x:0,y:0,width:700,height:500}},async()=>sources);
  try{const row=await f.runtime.execute('one',screenshotTarget,{action:'observe'});assert.equal(row.image,undefined);assert.equal(f.nativeRequests.length,1);}finally{f.runtime.close();}
 }
});
