import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,mkdtemp,rm,stat,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import vm from 'node:vm';
import {EventEmitter} from 'node:events';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url);
const {isTrustedSender,isExternalWebUrl,restoreWindowState,DesktopStateStore,CloseHandshake,menuTemplate}=require('../desktop/support.cjs');
const origin='http://127.0.0.1:51234';

test('privileged desktop actions reject a same-origin child frame, another window, and navigated content',()=>{
  const frame={url:origin+'/'};
  const window={isDestroyed:()=>false,webContents:{mainFrame:frame}};
  const good={sender:window.webContents,senderFrame:frame};
  assert.equal(isTrustedSender(good,window,origin),true);
  assert.equal(isTrustedSender({...good,senderFrame:{url:origin+'/'}},window,origin),false);
  assert.equal(isTrustedSender({...good,sender:{}},window,origin),false);
  frame.url=origin+'/api/bootstrap';
  assert.equal(isTrustedSender(good,window,origin),false);
  frame.url='https://untrusted.example/';
  assert.equal(isTrustedSender(good,window,origin),false);
  assert.equal(isTrustedSender(good,{...window,isDestroyed:()=>true},origin),false);
});

test('link handoff refuses local files, application protocols, credentials, and numeric loopback variants',()=>{
  for(const url of ['file:///etc/passwd','javascript:alert(1)','codex://threads/id','https://name:secret@example.com','http://127.0.0.1:9000/','http://2130706433/','http://0x7f000001/','http://192.168.5.32/','http://localhost/','http://[::1]/','http://[::ffff:127.0.0.1]/','http://aiga.local/','not a URL'])assert.equal(isExternalWebUrl(url),false,url);
  assert.equal(isExternalWebUrl('https://opencode.ai/docs/'),true);
  assert.equal(isExternalWebUrl('https://github.com/deepseek-ai'),true);
});

test('window recovery relocates lost monitors and retains a reachable secondary-monitor layout',()=>{
  const displays=[{workArea:{x:0,y:25,width:1512,height:857}},{workArea:{x:-1920,y:0,width:1920,height:1080}}];
  const recovered=restoreWindowState({bounds:{x:9000,y:2000,width:4000,height:2000},maximized:true},displays);
  assert.deepEqual(recovered,{x:0,y:25,width:1512,height:857,maximized:true,fullScreen:false});
  const other=restoreWindowState({bounds:{x:-1800,y:40,width:1200,height:800}},displays);
  assert.equal(other.x,-1800);assert.equal(other.width,1200);
  assert.equal(restoreWindowState({bounds:{x:NaN,y:0,width:900,height:700}},displays).width,1512);
  const tiny=restoreWindowState({bounds:{x:0,y:0,width:200,height:200}},[{workArea:{x:0,y:0,width:600,height:400}}]);
  assert.equal(tiny.width,600);assert.equal(tiny.height,400);
});

test('desktop state survives concurrent updates and corrupt-file recovery with private permissions',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'dsh-desktop-state-'));
  try {
    const file=path.join(dir,'nested','desktop-state.json');
    const store=new DesktopStateStore(file);
    await Promise.all(Array.from({length:20},(_,i)=>store.save({locale:i%2?'zh-CN':'en',bounds:{x:i,y:25,width:900,height:700}})));
    await store.flush();
    assert.equal(new DesktopStateStore(file).read().bounds.x,19);
    assert.equal((await stat(file)).mode&0o777,0o600);
    await writeFile(file,'{truncated');
    assert.deepEqual(new DesktopStateStore(file).read(),{});
    await store.save({locale:'en'});
    assert.equal(store.read().locale,'en');
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('quit handshake deduplicates concurrent requests and never accepts a stale acknowledgement',async()=>{
  const messages=[];
  const handshake=new CloseHandshake({send:message=>messages.push(message),timeoutMs:100});
  const first=handshake.request('quit');
  assert.equal(handshake.request('quit'),first);
  assert.equal(messages.length,1);
  assert.equal(handshake.finish({requestId:'old',allow:true}),false);
  assert.equal(handshake.finish({requestId:messages[0].requestId,allow:'yes'}),false);
  assert.equal(handshake.finish({requestId:messages[0].requestId,allow:true}),true);
  assert.deepEqual(await first,{allow:true,timedOut:false});
  const second=handshake.request('reload');
  assert.notEqual(messages[1].requestId,messages[0].requestId);
  assert.equal(handshake.finish({requestId:messages[0].requestId,allow:true}),false);
  handshake.cancel();
  assert.deepEqual(await second,{allow:false,timedOut:false});
  const expiring=new CloseHandshake({send:()=>{},timeoutMs:10});
  assert.deepEqual(await expiring.request('quit'),{allow:false,timedOut:true});
});

test('native menu actions route to the renderer while standard editing retains macOS roles',()=>{
  const actions=[];let reloads=0;
  const menus=menuTemplate({locale:'zh-CN',send:action=>actions.push(action),requestReload:()=>reloads++,platform:'darwin'});
  const all=menus.flatMap(menu=>menu.submenu);
  assert.deepEqual(menus.map(menu=>menu.label),['DSH','文件','编辑','显示','聊天','窗口','帮助']);
  for(const item of all)if(item.click)item.click();
  for(const action of ['new-chat','open-project','save-document','close-panel','find-document','find','toggle-sidebar','toggle-document','toggle-terminal','focus-composer','back','forward','rename-chat','copy-chat','archive-chat','open-settings','open-shortcuts','open-about'])assert.ok(actions.includes(action),action);
  assert.equal(reloads,1);
  assert.equal(all.find(item=>item.role==='paste').label,'粘贴');
  assert.equal(all.find(item=>item.role==='quit').accelerator,'CmdOrCtrl+Q');
  const accelerators=all.filter(item=>item.accelerator).map(item=>item.accelerator);
  assert.equal(new Set(accelerators).size,accelerators.length);
  assert.equal(menuTemplate({locale:'unsupported',send:()=>{},requestReload:()=>{},platform:'darwin'})[1].label,'File');
});

test('the actual main-process IPC handlers authorize every invocation before performing native work',async()=>{
  const handlers=new Map();
  const app=new EventEmitter();
  Object.assign(app,{setName(){},getPath(){return tmpdir();},setPath(){},requestSingleInstanceLock(){return true;},whenReady(){return new Promise(()=>{});},getVersion(){return 'test';},setAboutPanelOptions(){}});
  let folderCalls=0,findCalls=0;
  const electron={app,ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},dialog:{showOpenDialog:async()=>{folderCalls++;return{canceled:false,filePaths:['/selected/project']};}},Menu:{buildFromTemplate:template=>template,setApplicationMenu(){}},screen:{},BrowserWindow:class{},shell:{}};
  const scopedRequire=createRequire(new URL('../desktop/main.cjs',import.meta.url));
  const source=await readFile(new URL('../desktop/main.cjs',import.meta.url),'utf8');
  const module={exports:{}};
  vm.runInNewContext(source+'\nmodule.exports={installIpc,inject:(win,url)=>{mainWindow=win;origin=url;},reset:()=>clearTimeout(stateTimer)};',{
    require:id=>id==='electron'?electron:scopedRequire(id),module,__dirname:fileURLToPath(new URL('../desktop/',import.meta.url)),process,setTimeout,clearTimeout,setImmediate,URL,console,
  });
  const frame={url:origin+'/'};
  const win={isDestroyed:()=>false,webContents:{mainFrame:frame,findInPage:()=>{findCalls++;return 7;},stopFindInPage(){}},setFullScreen(){},isFullScreen(){return false;}};
  module.exports.inject(win,origin);module.exports.installIpc();
  const good={sender:win.webContents,senderFrame:frame};
  const bad={sender:win.webContents,senderFrame:{url:origin+'/'}};
  for(const [name,handler]of handlers)await assert.rejects(async()=>handler(bad,{}),/DESKTOP_FORBIDDEN/,name);
  assert.equal(folderCalls,0);assert.equal(findCalls,0);
  assert.equal(await handlers.get('dsh:chooseFolder')(good),'/selected/project');
  assert.equal(handlers.get('dsh:find-text')(good,{text:'needle'}),7);
  assert.equal(findCalls,1);
  assert.throws(()=>handlers.get('dsh:find-text')(good,{text:''}),/INVALID_FIND_TEXT/);
  assert.throws(()=>handlers.get('dsh:locale')(good,'file:///tmp'),/INVALID_LOCALE/);
  assert.throws(()=>handlers.get('dsh:close-state')(good,{dirty:true}),/INVALID_CLOSE_STATE/);
  module.exports.reset();
});

test('preload subscriptions expose payloads without privileged IPC events and can be removed',async()=>{
  const ipcRenderer=new EventEmitter();
  const invokes=[];let bridge;
  ipcRenderer.invoke=(...args)=>{invokes.push(args);return Promise.resolve(true);};
  vm.runInNewContext(await readFile(new URL('../desktop/preload.cjs',import.meta.url),'utf8'),{
    require:()=>({ipcRenderer,contextBridge:{exposeInMainWorld:(_name,value)=>{bridge=value;}}}),window:{addEventListener(){}},document:{},
  });
  assert.equal(bridge.ipcRenderer,undefined);
  assert.equal(bridge.send,undefined);
  const received=[];const unsubscribe=bridge.onMenuAction((...args)=>received.push(args));
  ipcRenderer.emit('dsh:menu-action',{sender:'privileged'},'new-chat');
  assert.equal(received.length,1);assert.deepEqual(Array.from(received[0]),['new-chat']);
  unsubscribe();ipcRenderer.emit('dsh:menu-action',{},'ignored');
  assert.equal(received.length,1);
  bridge.findText({text:'needle',forbidden:'extra'});
  assert.equal(invokes[0][0],'dsh:find-text');assert.equal(invokes[0][1].forbidden,undefined);
});

test('native quit saves renderer state before one host shutdown; reload keeps the engine alive',async()=>{
  async function harness({dirty=false,running=false,answer=1}={}) {
    const steps=[],messages=[];const handlers=new Map();const app=new EventEmitter();
    Object.assign(app,{setName(){},getPath(){return tmpdir();},setPath(){},requestSingleInstanceLock(){return true;},whenReady(){return new Promise(()=>{});},getVersion(){return 'test';},setAboutPanelOptions(){},quit(){steps.push('quit');},exit(){steps.push('exit');}});
    const electron={app,ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},dialog:{showMessageBox:async()=>{steps.push('confirm');return{response:answer};}},Menu:{buildFromTemplate:value=>value,setApplicationMenu(){}},screen:{},BrowserWindow:class{},shell:{}};
    const scopedRequire=createRequire(new URL('../desktop/main.cjs',import.meta.url));
    const source=await readFile(new URL('../desktop/main.cjs',import.meta.url),'utf8');
    const module={exports:{}};
    vm.runInNewContext(source+'\nmodule.exports={installIpc,requestTransition,inject:value=>{mainWindow=value.win;origin=value.origin;host=value.host;store=value.store;closeReady=true;closeState=value.closeState;}};',{
      require:id=>id==='electron'?electron:scopedRequire(id),module,__dirname:fileURLToPath(new URL('../desktop/',import.meta.url)),process,setTimeout,clearTimeout,setImmediate,URL,console,
    });
    const frame={url:origin+'/'};
    const win={isDestroyed:()=>false,getNormalBounds:()=>({x:0,y:0,width:1512,height:886}),isMaximized:()=>false,isFullScreen:()=>false,reload(){steps.push('reload');},webContents:{mainFrame:frame,send(channel,payload){
      if(channel==='dsh:before-close'){messages.push({...payload});setImmediate(()=>{steps.push('flush-drafts');handlers.get('dsh:close-complete')({sender:win.webContents,senderFrame:frame},{requestId:payload.requestId,allow:true});});}
    }}};
    module.exports.inject({win,origin,closeState:{dirty,running},host:{state:()=>({sessions:[{running}]}),async close(){steps.push('host-close');await new Promise(resolve=>setTimeout(resolve,5));}},store:{async save(){steps.push('save-window');},async flush(){steps.push('flush-window');}}});
    module.exports.installIpc();return {steps,messages,...module.exports};
  }
  const quitting=await harness({dirty:true,running:true});
  const first=quitting.requestTransition('quit');
  assert.equal(quitting.requestTransition('quit'),first);
  assert.equal(await first,true);
  assert.deepEqual(quitting.steps,['confirm','flush-drafts','save-window','flush-window','host-close','quit']);
  assert.equal(quitting.messages[0].discardDocument,true);assert.equal(quitting.messages[0].reason,'quit');
  const cancelled=await harness({dirty:true,answer:0});
  assert.equal(await cancelled.requestTransition('quit'),false);
  assert.deepEqual(cancelled.steps,['confirm']);
  assert.equal(cancelled.messages.length,0);
  const reloading=await harness({running:true});
  assert.equal(await reloading.requestTransition('reload'),true);
  assert.deepEqual(reloading.steps,['flush-drafts','save-window','flush-window','reload']);
  assert.equal(reloading.messages[0].discardDocument,false);
  const discardingReload=await harness({dirty:true});
  assert.equal(await discardingReload.requestTransition('reload'),true);
  assert.deepEqual(discardingReload.steps,['confirm','flush-drafts','save-window','flush-window','reload']);
  assert.equal(discardingReload.messages[0].discardDocument,true);
  assert.equal(discardingReload.messages[0].reason,'reload');
});
