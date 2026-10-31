const {contextBridge,ipcRenderer}=require('electron');

function subscribe(channel,callback) {
  if(typeof callback!=='function')throw new TypeError('DESKTOP_INVALID_CALLBACK');
  // Never expose Electron's privileged IPC event or ipcRenderer to page code.
  const listener=(_event,value)=>callback(value);
  ipcRenderer.on(channel,listener);
  return ()=>ipcRenderer.removeListener(channel,listener);
}
contextBridge.exposeInMainWorld('dshDesktop',{
  fullscreen:()=>ipcRenderer.invoke('dsh:fullscreen'),
  chooseFolder:()=>ipcRenderer.invoke('dsh:chooseFolder'),
  setLocale:locale=>ipcRenderer.invoke('dsh:locale',locale),
  setCloseState:value=>ipcRenderer.invoke('dsh:close-state',{dirty:value?.dirty,running:value?.running,dirtyRevision:value?.dirtyRevision}),
  onMenuAction:callback=>subscribe('dsh:menu-action',callback),
  onTransitionEnded:callback=>subscribe('dsh:transition-ended',callback),
  onBeforeClose:callback=>{
    const unsubscribe=subscribe('dsh:before-close',callback);
    void ipcRenderer.invoke('dsh:close-ready',true).catch(()=>{});
    return ()=>{unsubscribe();void ipcRenderer.invoke('dsh:close-ready',false).catch(()=>{});};
  },
  completeClose:value=>ipcRenderer.invoke('dsh:close-complete',{requestId:value?.requestId,allow:value?.allow}),
  closeWindow:()=>ipcRenderer.invoke('dsh:close-window'),
  findText:value=>ipcRenderer.invoke('dsh:find-text',{text:value?.text,forward:value?.forward,findNext:value?.findNext,matchCase:value?.matchCase}),
  stopFind:()=>ipcRenderer.invoke('dsh:stop-find'),
  onFoundInPage:callback=>subscribe('dsh:found-in-page',callback),
});
window.addEventListener('DOMContentLoaded',()=>document.documentElement.classList.add('native-desktop'));
