import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {EventEmitter} from 'node:events';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import {ComputerUse} from '../server/computer-use.mjs';

async function fixture(platform){
 const windows=[],partitions=[],nativeCalls=[],external=[];
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
 const module={exports:{}},require=createRequire(import.meta.url);
 const fakeSpawn=(...args)=>{nativeCalls.push(args);const child=new EventEmitter();child.stdout=new EventEmitter();child.stdout.setEncoding=()=>{};child.stderr=new EventEmitter();child.stdin=new EventEmitter();child.stdin.write=()=>{};child.kill=()=>child.emit('exit');queueMicrotask(()=>child.emit('error',Object.assign(Error('missing helper'),{code:'ENOENT'})));return child;};
 const source=await readFile(new URL('../desktop/computer-runtime.cjs',import.meta.url),'utf8');
 vm.runInNewContext(source,{require:id=>id==='electron'?electron:id==='node:child_process'?{spawn:fakeSpawn}:require(id),module,__dirname:fileURLToPath(new URL('../desktop/',import.meta.url)),process,setTimeout,clearTimeout,URL,console});
 const runtime=module.exports.createComputerRuntime({platform,app:{},locale:()=> 'en'});
 return {runtime,windows,partitions,nativeCalls,external};
}

test('Windows exposes the browser without spawning a native helper or opening system settings',async()=>{
 const f=await fixture('win32');try{
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
