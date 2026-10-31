const { app, BrowserWindow, ipcMain, dialog, shell, Menu, screen, powerSaveBlocker, powerMonitor } = require('electron');
const path = require('node:path');
const {RendererRecovery,ActivityPowerGuard}=require('./reliability.cjs');
const {
  normalizeLocale, translator, isMainDocument, isTrustedSender, isExternalWebUrl,
  restoreWindowState, DesktopStateStore, CloseHandshake, menuTemplate,
  activitySummary, hasNewActivities, approveActivities, activityDetail,
} = require('./support.cjs');

let host;
let mainWindow;
let origin;
let locale='en';
let store;
let closeState={dirty:false,running:false};
let closeReady=false;
let transition;
let approvedQuit=false;
let stateTimer;
let hostStarting;
let quitRequested=false;
let powerGuard;
let rendererPrompt=false;
const rendererRecovery=new RendererRecovery();
const handshake=new CloseHandshake({send:value=>mainWindow.webContents.send('dsh:before-close',value)});

app.setName('DSH');
app.setPath('userData',process.env.DSH_DESKTOP_USER_DATA?path.resolve(process.env.DSH_DESKTOP_USER_DATA):path.join(app.getPath('appData'),'DSH-Codex'));

function t(key,params) {return translator(locale)(key,params);}
function stopDesktopRuntime() {rendererRecovery.cancel();powerGuard?.stop();}
function captureState() {
  return {locale,...(mainWindow&&!mainWindow.isDestroyed()?{bounds:mainWindow.getNormalBounds(),maximized:mainWindow.isMaximized(),fullScreen:mainWindow.isFullScreen()}:{})};
}
function saveWindowState() {
  clearTimeout(stateTimer);
  return store?.save(captureState());
}
function scheduleStateSave() {clearTimeout(stateTimer);stateTimer=setTimeout(()=>{void saveWindowState()?.catch(()=>{});},200);}
function validEvent(event) {
  if(!isTrustedSender(event,mainWindow,origin))throw new Error('DESKTOP_FORBIDDEN');
}
function sendAction(action) {
  if(mainWindow&&!mainWindow.isDestroyed()) {mainWindow.show();mainWindow.webContents.send('dsh:menu-action',action);}
}
function applyMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate({locale,send:sendAction,requestReload:()=>{void requestTransition('reload');}})));
  app.setAboutPanelOptions({applicationName:'DSH',applicationVersion:app.getVersion(),copyright:t('aboutDetail')});
}
async function nativeConfirm({title,detail,params,confirm,cancel='cancel'}) {
  const options={type:'warning',title:'DSH',message:t(title),detail:t(detail,params),buttons:[t(cancel),t(confirm)],defaultId:0,cancelId:0,noLink:true};
  const result=mainWindow&&!mainWindow.isDestroyed()?await dialog.showMessageBox(mainWindow,options):await dialog.showMessageBox(options);
  return result.response===1;
}
function withDeadline(promise,ms) {
  let timer;
  return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('DESKTOP_SHUTDOWN_TIMEOUT')),ms);})]).finally(()=>clearTimeout(timer));
}
async function performTransition(reason) {
  const hasWindow=mainWindow&&!mainWindow.isDestroyed();
  const approved=new Map();let dirtyApprovedToken=null,flushedToken=null;
  const documentToken=()=>Number.isSafeInteger(closeState.dirtyRevision)?'revision:'+closeState.dirtyRevision:'legacy:'+(closeState.legacyDirtyRevision??0);
  const activities=()=>{
    let state;
    try{state=host?.state();}
    catch{state={activities:[{id:'host-state-unverified',pluginId:'host',kind:'unknown',count:1}]};}
    return activitySummary(state,{rendererRunning:closeState.running});
  };
  const needsConfirmation=summary=>(closeState.dirty&&dirtyApprovedToken!==documentToken())||(reason==='quit'&&hasNewActivities(summary,approved));
  async function confirmCurrent() {
    const summary=reason==='quit'?activities():activitySummary(null);
    if(!needsConfirmation(summary))return true;
    const dirty=closeState.dirty,token=documentToken(),background=summary.total>0;
    const allowed=await nativeConfirm({
      title:dirty?'dirtyTitle':'runningTitle',
      detail:reason==='reload'?'reloadDirtyDetail':background?(dirty?'dirtyActivitiesDetail':'activitiesDetail'):'dirtyDetail',
      params:{items:activityDetail(summary,locale)},
      confirm:reason==='reload'?'discardReload':dirty?'discardQuit':'quitAnyway',
    });
    if(!allowed)return false;
    if(dirty)dirtyApprovedToken=token;
    approveActivities(summary,approved);return true;
  }
  const currentActivities=()=>reason==='quit'?activities():activitySummary(null);
  const prepared=()=>!needsConfirmation(currentActivities())&&(!(hasWindow&&closeReady)||flushedToken===documentToken());
  async function prepareCurrent() {
    for(;;) {
      if(!(await confirmCurrent()))return false;
      if(needsConfirmation(currentActivities()))continue;
      const token=documentToken();
      if(hasWindow&&closeReady&&flushedToken!==token) {
        const result=await handshake.request(reason,{discardDocument:closeState.dirty&&dirtyApprovedToken===token,expectedDirtyRevision:closeState.dirtyRevision});
        if(token!==documentToken())continue;
        if(!result.allow) {
          if(!result.timedOut||!(await nativeConfirm({title:'flushFailedTitle',detail:reason==='reload'?'reloadFlushFailedDetail':'flushFailedDetail',confirm:reason==='reload'?'discardReload':'forceQuit'})))return false;
        }
        flushedToken=token;
      }
      if(prepared())return true;
    }
  }
  if(!(await prepareCurrent()))return false;
  // Window geometry is expendable; a failed geometry write must not prevent
  // quitting after the renderer has already confirmed chat-draft persistence.
  await saveWindowState()?.catch(()=>{});
  await store?.flush();
  if(reason==='reload') {
    for(;;){if(!(await prepareCurrent()))return false;if(!prepared())continue;if(hasWindow){closeState={...closeState,dirty:false};closeReady=false;mainWindow.reload();}break;}
    return true;
  }
  if(hostStarting&&!host) {
    try {host=await hostStarting;}catch{}
  }
  if(host) {
    const beginShutdown=()=>{try{return Promise.resolve(host.close());}catch(error){return Promise.reject(error);}};
    // No await separates this last authoritative snapshot from host.close().
    // A task created during a dialog or renderer flush needs its own consent.
    let shutdown;
    for(;;){if(!(await prepareCurrent()))return false;if(!prepared())continue;shutdown=beginShutdown();break;}
    for(;;) {
      try {await withDeadline(shutdown,20000);host=null;break;}
      catch(error) {
        const timedOut=error.message==='DESKTOP_SHUTDOWN_TIMEOUT';
        const force=await nativeConfirm({title:'shutdownFailedTitle',detail:'shutdownFailedDetail',confirm:'forceQuit',cancel:timedOut?'continueWaiting':'retryShutdown'});
        if(force) {
          // A force-exit answer does not approve new work that appeared while
          // waiting for cleanup. Refusing this check keeps the app alive.
          for(;;){if(!(await prepareCurrent()))return false;if(prepared())break;}
          try {await withDeadline(Promise.resolve(host?.engine?.dispose()),3000);}catch{}
          for(;;){if(!(await prepareCurrent()))return false;if(prepared())break;}
          stopDesktopRuntime();approvedQuit=true;app.exit(0);return true;
        }
        if(!timedOut){for(;;){if(!(await prepareCurrent()))return false;if(!prepared())continue;shutdown=beginShutdown();break;}}
      }
    }
  }
  stopDesktopRuntime();approvedQuit=true;app.quit();return true;
}
function requestTransition(reason) {
  if(transition)return transition;
  if(reason==='quit')quitRequested=true;
  transition=performTransition(reason).catch(()=>false).then(result=>{if(!result)quitRequested=false;return result;}).finally(()=>{transition=null;try{if(mainWindow&&!mainWindow.isDestroyed())mainWindow.webContents.send('dsh:transition-ended',{});}catch{}});
  return transition;
}

function installIpc() {
  ipcMain.handle('dsh:fullscreen',event=>{validEvent(event);mainWindow.setFullScreen(!mainWindow.isFullScreen());return mainWindow.isFullScreen();});
  ipcMain.handle('dsh:chooseFolder',async event=>{
    validEvent(event);
    const result=await dialog.showOpenDialog(mainWindow,{title:t('chooseFolder'),buttonLabel:t('chooseFolderButton'),properties:['openDirectory','createDirectory','dontAddToRecent']});
    return result.canceled?null:result.filePaths[0];
  });
  ipcMain.handle('dsh:locale',(event,value)=>{
    validEvent(event);
    if(!['zh-CN','en'].includes(value))throw new Error('DESKTOP_INVALID_LOCALE');
    locale=value;applyMenu();scheduleStateSave();return locale;
  });
  ipcMain.handle('dsh:close-state',(event,value)=>{
    validEvent(event);
    if(!value||typeof value.dirty!=='boolean'||typeof value.running!=='boolean')throw new Error('DESKTOP_INVALID_CLOSE_STATE');
    if(value.dirtyRevision!==undefined&&(!Number.isSafeInteger(value.dirtyRevision)||value.dirtyRevision<0))throw new Error('DESKTOP_INVALID_CLOSE_STATE');
    closeState={dirty:value.dirty,running:value.running,legacyDirtyRevision:(closeState.legacyDirtyRevision??0)+(value.dirty&&!closeState.dirty?1:0),...(value.dirtyRevision!==undefined?{dirtyRevision:value.dirtyRevision}:{})};powerGuard?.update();return true;
  });
  ipcMain.handle('dsh:close-ready',(event,value)=>{validEvent(event);closeReady=value===true;return true;});
  ipcMain.handle('dsh:close-complete',(event,value)=>{validEvent(event);return handshake.finish(value);});
  ipcMain.handle('dsh:find-text',(event,value)=>{
    validEvent(event);
    if(!value||typeof value.text!=='string'||!value.text.length||value.text.length>10000)throw new Error('DESKTOP_INVALID_FIND_TEXT');
    return mainWindow.webContents.findInPage(value.text,{forward:value.forward!==false,findNext:value.findNext===true,matchCase:value.matchCase===true});
  });
  ipcMain.handle('dsh:stop-find',event=>{validEvent(event);mainWindow.webContents.stopFindInPage('clearSelection');return true;});
  // Closing is scheduled after the invoke acknowledgement so the renderer is
  // still alive to complete the separate persistence handshake.
  ipcMain.handle('dsh:close-window',event=>{validEvent(event);setImmediate(()=>{void requestTransition('quit');});return true;});
}

async function createWindow() {
  const saved=store.read();
  const primary=screen.getPrimaryDisplay();
  const displays=[primary,...screen.getAllDisplays().filter(display=>display.id!==primary.id)];
  const restored=restoreWindowState(saved,displays);
  const {maximized,fullScreen,...bounds}=restored;
  mainWindow=new BrowserWindow({
    ...bounds,minWidth:Math.min(860,primary.workArea.width),minHeight:Math.min(580,primary.workArea.height),
    show:false,title:'DSH',titleBarStyle:'hidden',trafficLightPosition:{x:15,y:15},backgroundColor:'#ffffff',
    webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,webviewTag:false,allowRunningInsecureContent:false,navigateOnDragDrop:false},
  });
  const win=mainWindow;
  win.webContents.setWindowOpenHandler(({url})=>{
    if(isExternalWebUrl(url))void shell.openExternal(url).catch(()=>{});
    return {action:'deny'};
  });
  win.webContents.on('will-navigate',(event,url)=>{if(!isMainDocument(event.url??url,origin))event.preventDefault();});
  win.webContents.on('will-frame-navigate',event=>{if(!event.isMainFrame||!isMainDocument(event.url,origin))event.preventDefault();});
  win.webContents.on('will-redirect',(event,url)=>{if(!isMainDocument(event.url??url,origin))event.preventDefault();});
  win.webContents.on('will-attach-webview',event=>event.preventDefault());
  win.webContents.on('found-in-page',(_event,result)=>win.webContents.send('dsh:found-in-page',{requestId:result.requestId,matches:result.matches,activeMatchOrdinal:result.activeMatchOrdinal,finalUpdate:result.finalUpdate}));
  win.webContents.session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
  win.webContents.session.setPermissionCheckHandler(()=>false);
  win.webContents.session.on('will-download',event=>event.preventDefault());
  const recoverRenderer=async()=>{
    closeReady=false;handshake.cancel();
    if(approvedQuit||win.isDestroyed())return;
    // A renderer crash can cancel its pending close/save handshake. Retry
    // after that cancelled transition instead of leaving a dead interface.
    if(transition){void transition.then(result=>{if(!result&&!approvedQuit&&!win.isDestroyed())void recoverRenderer();});return;}
    if(rendererRecovery.schedule(()=>{if(!approvedQuit&&!transition&&!quitRequested&&!win.isDestroyed())win.reload();}))return;
    if(rendererPrompt)return;rendererPrompt=true;
    try {
      const result=await dialog.showMessageBox(win,{type:'error',title:'DSH',message:t('rendererFailedTitle'),detail:t('rendererFailedDetail'),buttons:[t('reloadButton'),t('quit')],defaultId:0,cancelId:1,noLink:true});
      if(approvedQuit||transition||win.isDestroyed())return;
      if(result.response===0){win.reload();}else void requestTransition('quit');
    }catch{/* A failed native dialog must not terminate the background host. */}
    finally{rendererPrompt=false;}
  };
  win.webContents.on('render-process-gone',recoverRenderer);
  for(const event of ['resize','move','maximize','unmaximize','enter-full-screen','leave-full-screen'])win.on(event,scheduleStateSave);
  win.on('close',event=>{if(!approvedQuit){event.preventDefault();void requestTransition('quit');}});
  win.on('closed',()=>{rendererRecovery.cancel();mainWindow=null;});
  win.once('ready-to-show',()=>{if(maximized)win.maximize();if(fullScreen)win.setFullScreen(true);win.show();});
  await win.loadURL(host.url);
}

if(!app.requestSingleInstanceLock())app.quit();
else {
  app.on('second-instance',()=>{if(mainWindow&&!mainWindow.isDestroyed()){if(mainWindow.isMinimized())mainWindow.restore();mainWindow.show();mainWindow.focus();}});
  app.on('before-quit',event=>{if(!approvedQuit){event.preventDefault();void requestTransition('quit');}});
  app.on('will-quit',stopDesktopRuntime);
  app.on('activate',()=>{if(mainWindow&&!mainWindow.isDestroyed()){mainWindow.show();mainWindow.focus();}});
  app.on('certificate-error',(event,_contents,_url,_error,_certificate,callback)=>{event.preventDefault();callback(false);});
  app.whenReady().then(async()=>{
    if(quitRequested)return;
    store=new DesktopStateStore(path.join(process.env.DSH_CLIENT_DATA_DIR||app.getPath('userData'),'desktop-state.json'));
    const saved=store.read();locale=normalizeLocale(saved.locale||app.getLocale());applyMenu();
    installIpc();
    const {startHost}=await import('../server/index.mjs');
    const computerRuntime=require('./computer-runtime.cjs').createComputerRuntime({app,locale:()=>locale});
    hostStarting=startHost({computerRuntime,dataDir:process.env.DSH_CLIENT_DATA_DIR||path.join(app.getPath('userData'),'client')});
    host=await hostStarting;
    if(quitRequested)return;
    powerGuard=new ActivityPowerGuard({blocker:powerSaveBlocker,powerMonitor,readState:()=>host?.state()});powerGuard.start();
    origin=new URL(host.url).origin;
    await createWindow();
  }).catch(async error=>{
    const supervised=process.env.DSH_PROCESS_SUPERVISED==='1';
    // A restart can arrive before the dead process's data lock becomes stale.
    // Leave that lock intact and report a retryable process failure to the guard.
    if(!quitRequested) {
      if(supervised)console.error('DSH_DESKTOP_STARTUP_FAILED',error?.code??error?.message??'UNKNOWN');
      else try{dialog.showErrorBox(t('startupFailedTitle'),t('startupFailedDetail'));}catch{}
    }
    try{await withDeadline(Promise.resolve(host?.close()),20000);}
    catch{try{await withDeadline(Promise.resolve(host?.engine?.dispose()),3000);}catch{}}
    host=null;stopDesktopRuntime();approvedQuit=true;
    if(supervised&&!quitRequested)app.exit(75);else app.quit();
  });
}
