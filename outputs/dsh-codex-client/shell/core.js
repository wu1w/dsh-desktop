import {resources} from './locales.js';
import {pluginEngineProviders} from './engine-providers.js';
import {renderRecovery} from './recovery-view.js';
import {readEventStream,readJsonResponse,streamFault} from './event-stream.js';
import {ReconnectController} from './reconnect.js';
const core=document.getElementById('dsh-core');
const root=document.getElementById('root');
let capability,state,appearanceId,unmount,styles=[],revision=0,manage=false,problem='',stateRevision=0;
const t=key=>resources[state?.preferences?.locale?.startsWith('en')?'en':'zh-CN'][key]??resources.en[key]??key;
async function api(route,body){const response=await fetch('/api/'+route,{method:body===undefined?'GET':'POST',credentials:'same-origin',headers:{'x-dsh-capability':capability,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const data=await response.json();if(!response.ok)throw new Error(data.message);return data;}
function button(label,action){const button=document.createElement('button');button.textContent=label;button.onclick=async()=>{button.disabled=true;problem='';try{await action();state=await api('state');await queueUpdate();}catch(error){problem=error.message;render();}finally{button.disabled=false;}};return button;}
function text(tag,value){const element=document.createElement(tag);element.textContent=value;return element;}
function render(){core.replaceChildren();core.hidden=Boolean(appearanceId&&!manage&&!state?.recovery);if(core.hidden)return;
 if(state?.startupBlocked){const panel=document.createElement('section');panel.className='core-panel';panel.append(text('h1',t('recoveryTitle')),text('p',state.engine?.error??t('failed')));core.append(panel);return;}
 if(state?.recovery){renderRecovery({document,container:core,recovery:state.recovery,t,locale:state.preferences?.locale??'zh-CN',problem,act:async body=>{problem='';try{await api('recovery',body);state=await api('state');await queueUpdate();}catch(error){problem=error.message;render();}}});return;}
 const panel=document.createElement('section');panel.className='core-panel';panel.append(text('h1',t('title')),text('p',problem||state?.engine?.error||t('description')));
 for(const kind of ['appearance','feature','engine']){panel.append(text('h2',t(kind)));for(const plugin of state?.plugins?.filter(plugin=>plugin.type===kind)??[]){const row=document.createElement('div');row.className='core-plugin';const label=document.createElement('div');label.append(text('strong',plugin.name?.[state?.preferences?.locale??'zh-CN']??plugin.name?.en??plugin.id),text('small',`${plugin.version} · ${plugin.active?t('active'):t('inactive')}`));if(plugin.error)label.append(text('small',t('pluginError')));row.append(label,button(t(plugin.enabled?'disable':'enable'),()=>api(`plugins/${plugin.id}/${plugin.enabled?'disable':'enable'}`,{})));if(!plugin.builtin&&(plugin.canRollback||state.pluginChange?.status==='verifying'&&state.pluginChange?.id===plugin.id))row.append(button(t('rollback'),async()=>{if(state.pluginChange?.status==='verifying'&&state.pluginChange?.id===plugin.id){await api('plugin-development',{action:'appearance-result',pluginId:plugin.id,revision:plugin.revision,success:false});return;}const result=await api('plugin-development',{action:'history',pluginId:plugin.id});const previous=result.history.slice().reverse().find(version=>version.revision!==plugin.revision);if(previous)await api('plugin-development',{action:'rollback',pluginId:plugin.id,revision:previous.revision,expectedRevision:plugin.revision});}));if(kind==='engine')for(const provider of pluginEngineProviders(plugin,state)){if(provider.id!==state.selectedEngine)row.append(button(`${t('engineSelect')} · ${provider.id}`,()=>api('engine/select',{id:provider.id})));else row.append(text('small',`${t('current')} · ${provider.id}`));}panel.append(row);}}
 panel.append(button(t('install'),async()=>{const path=window.dshDesktop?await window.dshDesktop.chooseFolder():window.prompt(t('path'));if(path)await api('plugins/install',{path});}));
 if(appearanceId)panel.append(button(t('close'),()=>{manage=false;render();}));else if(state?.appearance)panel.append(button(t('retry'),()=>{appearanceId=null;return queueUpdate();}));
 core.append(panel);
}
async function update(){const appearance=state.appearance;const identity=appearance?appearance.id+':'+(appearance.revision??'builtin'):null;if(identity===appearanceId){render();return;}const current=++revision;await unmount?.();unmount=null;appearanceId=null;root.replaceChildren();styles.forEach(link=>link.remove());styles=[];
 if(!appearance){render();return;}
 try{await Promise.all(appearance.styles.map(href=>new Promise((resolve,reject)=>{const link=document.createElement('link');link.rel='stylesheet';link.href=href;link.onload=resolve;link.onerror=reject;styles.push(link);document.head.append(link);})));const module=await import(appearance.entry);if(current!==revision)return;if(typeof module[appearance.exportName]!=='function')throw new Error(t('failed'));unmount=await module[appearance.exportName](root);appearanceId=identity;problem='';if(appearance.revision&&state.pluginChange?.status==='verifying'&&state.pluginChange?.revision===appearance.revision){await api('plugin-development',{action:'appearance-result',pluginId:appearance.id,revision:appearance.revision,success:true});}}
 catch(error){appearanceId=null;problem=error.message||t('failed');if(appearance.revision&&state.pluginChange?.status==='verifying'&&state.pluginChange?.revision===appearance.revision){try{await api('plugin-development',{action:'appearance-result',pluginId:appearance.id,revision:appearance.revision,success:false});state=await api('state');updateRequested=true;problem=t('rollbackDone');}catch(rollbackError){problem=rollbackError.message;}}}render();
}
// Appearance loading may wait on disk or unsaved drafts; it never blocks SSE.
let updatePending=null,updateRequested=false;
function queueUpdate(){
 updateRequested=true;if(updatePending)return updatePending;
 updatePending=(async()=>{while(updateRequested){updateRequested=false;await update();}})().catch(error=>{problem=error.message||t('failed');render();}).finally(()=>{updatePending=null;if(updateRequested)void queueUpdate();});
 return updatePending;
}
const connection=new ReconnectController({onError:()=>{problem=t('connectionRetry');render();},connect:async({signal,onOpen})=>{
 const boot=await readJsonResponse(token=>fetch('/api/bootstrap',{credentials:'same-origin',signal:token}),signal);
 if(signal.aborted)return;
 if(typeof boot?.capability!=='string'||!boot.capability||!boot.state)throw streamFault('BOOTSTRAP_PROTOCOL');
 capability=boot.capability;state=boot.state;stateRevision++;if(Object.values(resources).some(resource=>problem===resource.connectionRetry))problem='';void queueUpdate();
 await readEventStream(token=>fetch('/api/events',{credentials:'same-origin',headers:{'x-dsh-capability':capability},signal:token}),event=>{
  if(signal.aborted)return;
  if(event.type==='state'){stateRevision++;state=event.state;void queueUpdate();}
 },signal,{onOpen:()=>{
  onOpen();const observed=stateRevision;
  // Subscribe first, then close the bootstrap-to-subscription observation gap.
  return readJsonResponse(token=>fetch('/api/state',{credentials:'same-origin',headers:{'x-dsh-capability':capability},signal:token}),signal).then(next=>{
   if(signal.aborted)return;if(observed===stateRevision){state=next;void queueUpdate();}
  });
 }});
}});
window.addEventListener('online',()=>connection.wake());
window.addEventListener('pagehide',()=>connection.stop());
window.addEventListener('pageshow',()=>connection.start());
window.addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey)&&event.altKey&&event.key.toLowerCase()==='p'){event.preventDefault();manage=!manage;render();}});
connection.start();
