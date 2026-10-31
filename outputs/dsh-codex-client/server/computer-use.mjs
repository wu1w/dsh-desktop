import {randomUUID} from 'node:crypto';
import {computerTool} from '../shared/computer-tool.js';
export const computerErrors={
 COMPUTER_UNAVAILABLE:['电脑操作仅在本机 DSH 桌面应用中可用。','Computer Use is available in the local DSH desktop app.'],
 COMPUTER_NOT_CONNECTED:['请先在加号菜单的“使用电脑”中连接一个目标。','Connect a target from Use computer in the plus menu first.'],
 COMPUTER_STOPPED:['电脑控制已停止，请由用户重新连接。','Computer control stopped. The user must reconnect it.'],
 COMPUTER_ACCESSIBILITY_REQUIRED:['请在系统设置中允许 DSH 的辅助功能访问，然后重新检查。','Allow DSH Accessibility access in System Settings, then check again.'],
 COMPUTER_OBSERVATION_STALE:['画面已变化，请重新观察后再操作。','The view changed. Observe again before acting.'],
 COMPUTER_ELEMENT_STALE:['此控件已变化，请重新观察。','This element changed. Observe again.'],
 COMPUTER_ACTION_UNAVAILABLE:['此控件不支持该操作，请重新观察并选择其他方式。','This control does not support that action. Observe and choose another control.'],
 COMPUTER_APP_GONE:['所选应用已退出，请重新选择。','The selected app exited. Choose it again.'],
 COMPUTER_NO_WINDOW:['所选应用没有可操作的窗口。','The selected app has no available window.'],
 COMPUTER_FOCUS_CHANGED:['当前窗口已改变，操作未继续。','The focused window changed. The action was stopped.'],
 COMPUTER_PROTECTED_FIELD:['密码和验证码请由你在目标应用中输入。','Enter passwords and verification codes yourself in the target app.'],
 COMPUTER_INVALID_INPUT:['操作参数无效，请重新观察。','Invalid action parameters. Observe again.'],
 COMPUTER_INVALID_URL:['请输入不含账号信息的 HTTP 或 HTTPS 地址。','Enter an HTTP or HTTPS URL without embedded credentials.'],
 COMPUTER_NATIVE_UNAVAILABLE:['本机控制进程已断开，请重新连接；不要重复上一次点击。','The native controller disconnected. Reconnect and observe before repeating an action.'],
 COMPUTER_NATIVE_FAILED:['本机操作失败，请重新观察确认结果。','The native action failed. Observe to verify the result.'],
 COMPUTER_BUSY:['另一个聊天正在使用此应用。','Another chat is controlling this app.'],
 COMPUTER_INACTIVE:['此聊天没有正在执行的任务。','This chat has no active task.']
};
const fault=code=>Object.assign(new Error(code),{code});
const mutations=new Set(['navigate','click','type','key','scroll','back','forward']);
export class ComputerUse {
 constructor({runtime,state,getEngine,onChange=()=>{}}){this.runtime=runtime;this.state=state;this.getEngine=getEngine;this.onChange=onChange;this.sessions=new Map();this.tokens=new Map();this.serial=Promise.resolve();this.closed=false;runtime?.onDisconnect?.(id=>this.stop(id));}
 token(id){if(!this.tokens.has(id))this.tokens.set(id,randomUUID());return this.tokens.get(id);}
 idForToken(token){return [...this.tokens].find(([,value])=>value===token)?.[0];}
 snapshot(id){const entry=this.sessions.get(id);if(!entry)return {connected:false,available:!!this.runtime};return {connected:true,available:true,target:entry.target,busy:entry.busy,step:entry.step,action:entry.action??null,last:entry.last??null,error:entry.error??null};}
 async status(){return this.runtime?this.runtime.status():{available:false};}
 async apps(){if(!this.runtime)throw fault('COMPUTER_UNAVAILABLE');return this.runtime.apps();}
 async permission(kind){if(!this.runtime)throw fault('COMPUTER_UNAVAILABLE');return this.runtime.permission(kind);}
 changed(id){this.onChange(id,this.snapshot(id));}
 async connect(id,target){
  if(this.closed||!this.runtime)throw fault('COMPUTER_UNAVAILABLE');const session=this.state.sessions.find(s=>s.id===id);if(!session||session.archived||session.channel||session.kind==='agent')throw fault('COMPUTER_NOT_CONNECTED');
  let binding={kind:'browser',name:'browser'};
  if(target?.kind==='app'){const {apps}=await this.apps();const app=apps.find(row=>row.pid===target.pid);if(!app)throw fault('COMPUTER_APP_GONE');const status=await this.status();if(!status.accessibility)throw fault('COMPUTER_ACCESSIBILITY_REQUIRED');if([...this.sessions].some(([other,entry])=>other!==id&&entry.target.kind==='app'&&entry.target.pid===app.pid))throw fault('COMPUTER_BUSY');binding={kind:'app',pid:app.pid,name:app.name,bundleId:app.bundleId};}
  else if(target?.kind!=='browser')throw fault('COMPUTER_INVALID_INPUT');
  if(this.closed)throw fault('COMPUTER_STOPPED');this.stop(id);const entry={target:binding,abort:new AbortController(),step:0,busy:false,last:null,observation:null,nativeObservation:null};this.sessions.set(id,entry);this.changed(id);
  try{return await this.execute(id,{action:'observe'},{fromUser:true});}catch(error){if(this.sessions.get(id)===entry)this.stop(id);throw error;}
 }
 stop(id){const entry=this.sessions.get(id);this.sessions.delete(id);entry?.abort.abort();this.runtime?.stop(id);this.changed(id);}
 stopAll(){for(const id of [...this.sessions.keys()])this.stop(id);}
 async execute(id,input,{fromUser=false,signal}={}){
  if(!input||typeof input!=='object'||!computerTool.inputSchema.properties.action.enum.includes(input.action))throw fault('COMPUTER_INVALID_INPUT');
  if(input.action==='status'){const {last,...status}=this.snapshot(id);return {...status,observation:this.sessions.get(id)?.observation??null};}
  if(input.action==='stop'){this.stop(id);return {connected:false};}
  if(this.closed)throw fault('COMPUTER_STOPPED');const entry=this.sessions.get(id);if(!entry)throw fault('COMPUTER_NOT_CONNECTED');
  if(!fromUser&&!this.getEngine()?.activeTurns.has(id))throw fault('COMPUTER_INACTIVE');
  const current=()=>this.sessions.get(id)===entry&&!entry.abort.signal.aborted&&!signal?.aborted;
  const active=()=>fromUser||this.getEngine()?.activeTurns.has(id);
  const task=async()=>{
   if(!current())throw fault('COMPUTER_STOPPED');if(!active())throw fault('COMPUTER_INACTIVE');
   if(mutations.has(input.action)&&(!entry.observation||input.observation!==entry.observation))throw fault('COMPUTER_OBSERVATION_STALE');
   if(input.text!=null&&(typeof input.text!=='string'||input.text.length>20000))throw fault('COMPUTER_INVALID_INPUT');
   if(input.element!=null&&(!Number.isSafeInteger(input.element)||input.element<0))throw fault('COMPUTER_INVALID_INPUT');
   // Coordinates are intentionally unavailable to text-only engines. Use an observed control ID.
   if(input.x!=null||input.y!=null)throw fault('COMPUTER_INVALID_INPUT');
   const nativeObservation=entry.nativeObservation;if(mutations.has(input.action))entry.observation=null;
   entry.busy=true;entry.action=input.action;entry.error=null;this.changed(id);
   try{
    const combined=signal?AbortSignal.any([signal,entry.abort.signal]):entry.abort.signal;
    const result=await this.runtime.execute(id,entry.target,{...input,nativeObservation},{signal:combined});
    if(!current())throw fault('COMPUTER_STOPPED');
    entry.nativeObservation=result.nativeObservation;entry.observation=randomUUID();entry.step++;
    const {nativeObservation:_native,id:_id,ok:_ok,...visible}=result;entry.last={...visible,observation:entry.observation,at:Date.now()};
    return {...entry.last,action:input.action,connected:true,target:entry.target};
   }catch(error){entry.observation=null;entry.error=computerErrors[error.code]?error.code:'COMPUTER_NATIVE_FAILED';throw fault(entry.error);}
   finally{entry.busy=false;if(current())this.changed(id);}
  };
  const result=this.serial.then(task,task);this.serial=result.catch(()=>{});return result;
 }
 async engineCall(nativeId,input,{signal}={}){const session=this.state.sessions.find(s=>(s.engineSessionId??s.id)===nativeId);if(!session)throw fault('COMPUTER_NOT_CONNECTED');return this.execute(session.id,input,{signal});}
 close(){this.closed=true;this.stopAll();this.runtime?.close();}
}
