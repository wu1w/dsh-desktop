const {BrowserWindow,session,desktopCapturer,systemPreferences,shell}=require('electron');
const {spawn}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const path=require('node:path');
const {windowsHelperCommand,validateWindowsInput,screenshotGeometry}=require('./windows-computer.cjs');
const fail=code=>{throw Object.assign(new Error(code),{code});};
const browserDocument=()=>{
 const state=window.__dshComputer={token:String(Date.now())+Math.random().toString(36),nodes:[],signatures:[]};
 const rows=[];const candidates=document.querySelectorAll('a,button,input,textarea,select,[role="button"],[role="link"],[contenteditable="true"],h1,h2,h3,p,label');
 for(const node of candidates){if(rows.length>=160)break;const r=node.getBoundingClientRect(),css=getComputedStyle(node);if(!r.width||!r.height||css.visibility==='hidden'||css.display==='none')continue;
 const protectedField=node.matches('input[type=password],input[autocomplete="one-time-code"]');
 const label=(node.getAttribute('aria-label')||node.labels?.[0]?.innerText||node.innerText||node.getAttribute('placeholder')||node.getAttribute('title')||'').trim().slice(0,240);
 const id=state.nodes.length;state.nodes.push(node);state.signatures.push([node.tagName,node.getAttribute('aria-label'),node.textContent,node.value,node.getAttribute('type')].join('|'));rows.push({id,role:node.getAttribute('role')||node.tagName.toLowerCase(),label,value:protectedField?'[protected]':String(node.value??'').slice(0,400),protected:protectedField,disabled:Boolean(node.disabled),editable:!protectedField&&node.matches('input,textarea,select,[contenteditable="true"]')});}
 return {nativeObservation:state.token,title:document.title,url:location.href,elements:rows,text:document.body?.innerText.slice(0,9000)||'',viewport:{width:innerWidth,height:innerHeight}};
};
const browserAction=(input)=>{
 const state=window.__dshComputer;if(!state||state.token!==input.nativeObservation)throw Error('COMPUTER_OBSERVATION_STALE');
 const node=Number.isInteger(input.element)?state.nodes[input.element]:null;
 if(node&&(!node.isConnected||!node.getBoundingClientRect().width||state.signatures[input.element]!==[node.tagName,node.getAttribute('aria-label'),node.textContent,node.value,node.getAttribute('type')].join('|')))throw Error('COMPUTER_ELEMENT_STALE');
 if(input.action==='click'){if(!node||node.disabled)throw Error('COMPUTER_ELEMENT_STALE');state.token='';node.scrollIntoView({block:'center'});node.click();}
 else if(input.action==='type'){if(!node||node.disabled||node.readOnly||node.matches('input[type=password],input[type=file],input[autocomplete="one-time-code"]'))throw Error('COMPUTER_PROTECTED_FIELD');
 state.token='';node.focus();if(node.isContentEditable)node.textContent=input.text;else{const proto=node instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:node instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype;const set=Object.getOwnPropertyDescriptor(proto,'value')?.set;if(!set)throw Error('COMPUTER_ACTION_UNAVAILABLE');set.call(node,input.text);}node.dispatchEvent(new Event('input',{bubbles:true}));node.dispatchEvent(new Event('change',{bubbles:true}));}
 else if(input.action==='scroll'){state.token='';window.scrollBy({left:input.direction==='right'?600:input.direction==='left'?-600:0,top:input.direction==='up'?-600:input.direction==='down'?600:0,behavior:'instant'});}
 else if(input.action==='key'){if(node)node.focus();state.token='';}
};
function createComputerRuntime({app,locale=()=> 'zh-CN',platform=process.platform,environment=process.env}){
 let child=null,pending=new Map(),buffer='',closed=false,disconnected=()=>{};const browsers=new Map();
 function native(input,signal){return new Promise((resolve,reject)=>{
  if(closed)return reject(Object.assign(Error('COMPUTER_STOPPED'),{code:'COMPUTER_STOPPED'}));
  if(!['darwin','win32'].includes(platform))return reject(Object.assign(Error('COMPUTER_NATIVE_UNSUPPORTED'),{code:'COMPUTER_NATIVE_UNSUPPORTED'}));
  if(platform==='win32')input=validateWindowsInput(input);
  if(!child){
   const command=platform==='win32'?windowsHelperCommand(path.join(__dirname,'..'),environment):{file:path.join(__dirname,'../native/bin/dsh-computer-helper'),args:[]};
   const env=platform==='win32'?Object.fromEntries(['SystemRoot','WINDIR','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA'].filter(k=>environment[k]).map(k=>[k,environment[k]])):undefined;
   child=spawn(command.file,command.args,{stdio:['pipe','pipe','pipe'],windowsHide:true,...(env?{env}:{})});const bound=child;let startupFailure='COMPUTER_NATIVE_UNAVAILABLE';
   child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{if(child!==bound)return;buffer+=chunk;if(buffer.length>4000000){bound.kill();return;}let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);try{const value=JSON.parse(line);const task=pending.get(value.id);if(task){task.finish();value.ok?task.resolve(value):task.reject(Object.assign(Error(value.code),{code:value.code}));}}catch{}}});
   const exit=()=>{if(child!==bound)return;child=null;buffer='';for(const task of [...pending.values()]){task.finish();task.reject(Object.assign(Error('COMPUTER_NATIVE_UNAVAILABLE'),{code:startupFailure,actionSent:true}));}};
   child.on('exit',exit);child.on('error',exit);child.stdin.on('error',()=>{});child.stderr.on('data',chunk=>{if(String(chunk).includes('COMPUTER_NATIVE_BLOCKED'))startupFailure='COMPUTER_NATIVE_BLOCKED';});
   bound.failPending=()=>exit();
  }
  const id=randomUUID();const abort=()=>{const current=child;current?.failPending?.();current?.kill();};const timer=setTimeout(abort,12000);
  const finish=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);pending.delete(id);};
  pending.set(id,{resolve,reject,finish});signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted){abort();return;}try{child.stdin.write(JSON.stringify({...input,id})+'\n');}catch{abort();}
 });}
 function safeURL(value){let url;try{url=new URL(value);}catch{fail('COMPUTER_INVALID_URL');}if(!['http:','https:'].includes(url.protocol)||url.username||url.password)fail('COMPUTER_INVALID_URL');return url.href;}
 async function browser(id){let win=browsers.get(id);if(win&&!win.isDestroyed())return win;
  const partition='dsh-computer-'+randomUUID();const isolated=session.fromPartition(partition);isolated.setPermissionRequestHandler((_w,_p,done)=>done(false));isolated.setPermissionCheckHandler(()=>false);
  win=new BrowserWindow({width:1100,height:800,show:true,title:locale().startsWith('zh')?'DSH 浏览器':'DSH Browser',webPreferences:{partition,sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,devTools:false}});
  browsers.set(id,win);win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate',(event,url)=>{try{safeURL(url);}catch{event.preventDefault();}});win.webContents.on('will-redirect',(event,url)=>{try{safeURL(url);}catch{event.preventDefault();}});
  win.webContents.on('will-attach-webview',event=>event.preventDefault());isolated.on('will-download',(_event,item)=>item.cancel());
  win.on('closed',()=>{if(browsers.get(id)===win){browsers.delete(id);disconnected(id);}void isolated.clearStorageData();});
  await win.loadURL('about:blank');return win;
 }
 async function observeBrowser(win){if(win.webContents.isLoadingMainFrame())await new Promise((resolve,reject)=>{const done=()=>{clearTimeout(timer);win.webContents.removeListener('did-stop-loading',done);resolve();};const timer=setTimeout(()=>{win.webContents.removeListener('did-stop-loading',done);reject(Object.assign(Error('COMPUTER_NATIVE_FAILED'),{code:'COMPUTER_NATIVE_FAILED'}));},12000);win.webContents.once('did-stop-loading',done);});const observation=await win.webContents.executeJavaScriptInIsolatedWorld(1004,[{code:'('+browserDocument.toString()+')()'}],false);const shot=await win.webContents.capturePage();return {...observation,image:shot.resize({width:1100}).toDataURL()};}
 return {
  onDisconnect(callback){disconnected=callback;},
  async status(){
   if(closed)return {available:false,browserAvailable:false,nativeAvailable:false};
   // The isolated Electron browser does not need a native controller or OS permissions.
   const capabilities={available:true,browserAvailable:true,nativeAvailable:false,platform};
   if(!['darwin','win32'].includes(platform))return {...capabilities,nativeReason:'COMPUTER_NATIVE_UNSUPPORTED'};
   try{const nativeStatus=await native({action:'status'});return {...nativeStatus,...capabilities,nativeAvailable:platform==='win32'?nativeStatus.nativeReady===true:true,...(platform==='win32'?{nativeValidation:'pending-windows-device'}:{})};}
   catch(error){return {...capabilities,nativeReason:['COMPUTER_NATIVE_BLOCKED','COMPUTER_DESKTOP_UNAVAILABLE'].includes(error.code)?error.code:'COMPUTER_NATIVE_UNAVAILABLE',...(platform==='win32'?{nativeValidation:'pending-windows-device'}:{})};}
  },
  async apps(){return native({action:'apps'});},
  async permission(kind){if(platform!=='darwin')fail('COMPUTER_NATIVE_UNSUPPORTED');if(kind==='accessibility')return native({action:'requestAccessibility'});if(kind==='screen'){await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');return {ok:true};}fail('COMPUTER_INVALID_INPUT');},
  async execute(id,target,input,{signal}={}){
   if(closed||signal?.aborted)fail('COMPUTER_STOPPED');
   if(!['browser','app'].includes(target?.kind))fail('COMPUTER_INVALID_INPUT');
   if(target.kind==='browser'){
    const win=await browser(id);if(signal?.aborted)fail('COMPUTER_STOPPED');
    const abort=()=>win.webContents.stop();signal?.addEventListener('abort',abort,{once:true});
    try{
     if(input.action==='navigate')await win.loadURL(safeURL(input.text));
     else if(input.action==='back'){if(win.webContents.navigationHistory.canGoBack())win.webContents.navigationHistory.goBack();}
     else if(input.action==='forward'){if(win.webContents.navigationHistory.canGoForward())win.webContents.navigationHistory.goForward();}
     else if(input.action!=='observe'){
      await win.webContents.executeJavaScriptInIsolatedWorld(1004,[{code:'('+browserAction.toString()+')('+JSON.stringify(input)+')'}],true);
      if(input.action==='key'){const parts=(input.key??'').split('+');const key=parts.pop();const aliases={Cmd:'meta',Meta:'meta',Ctrl:'control',Control:'control',Shift:'shift',Alt:'alt'};if(parts.some(p=>!aliases[p])||!/^(Return|Enter|Tab|Escape|Backspace|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|[a-zA-Z])$/.test(key))fail('COMPUTER_INVALID_INPUT');const keyCode=key==='Enter'?'Return':key;win.webContents.sendInputEvent({type:'keyDown',keyCode,modifiers:parts.map(p=>aliases[p])});win.webContents.sendInputEvent({type:'keyUp',keyCode,modifiers:parts.map(p=>aliases[p])});}
     }
     if(signal?.aborted)fail('COMPUTER_STOPPED');for(let attempt=0;;attempt++){try{return await observeBrowser(win);}catch(error){if(attempt>=2||signal?.aborted||win.isDestroyed())throw error;await new Promise(resolve=>setTimeout(resolve,80*(attempt+1)));}}
    }finally{signal?.removeEventListener('abort',abort);}
   }
   let result=await native({...input,pid:target.pid,...(platform==='win32'?{windowId:target.windowId,processStartTime:target.processStartTime}:{})},signal);
   // Capture only the selected application's observed window; never fall back to another screen.
   if(platform==='win32'||systemPreferences.getMediaAccessStatus('screen')==='granted'){
    let sources;try{sources=await desktopCapturer.getSources({types:['window'],thumbnailSize:{width:1100,height:800},fetchWindowIcons:false});}catch{}
    const matches=result.windowId?sources?.filter(source=>source.id.split(':')[1]===String(result.windowId)):[];
    if(matches?.length===1&&!matches[0].thumbnail.isEmpty()){
     if(platform==='win32'){
      const before=JSON.stringify([result.windowId,result.bounds,result.windowRect]);
      const verified=await native({action:'observe',pid:target.pid,windowId:target.windowId,processStartTime:target.processStartTime},signal);
      if(JSON.stringify([verified.windowId,verified.bounds,verified.windowRect])!==before)fail('COMPUTER_OBSERVATION_STALE');
      // This fresh token is the helper's current authority after asynchronous
      // capture. Never return the consumed pre-capture token or stale geometry.
      result=verified;result.screenshot=screenshotGeometry(result,matches[0].thumbnail.getSize());
     }
     result.image=matches[0].thumbnail.toDataURL();
    }
   }
   return result;
  },
  stop(id){const win=browsers.get(id);browsers.delete(id);if(win&&!win.isDestroyed())win.destroy();},
  close(){closed=true;const current=child;current?.failPending?.();current?.kill();for(const id of browsers.keys())this.stop(id);}
 };
}
module.exports={createComputerRuntime};
