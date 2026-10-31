import {validProgram} from '../shared/session-programs.js';
import { open, lstat, mkdir, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';
import path from 'node:path';

const LIMIT=8*1024*1024;
const fault=code=>Object.assign(new Error(code),{code});
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const text=(value,max=1024,empty=false)=>typeof value==='string'&&value.length<=max&&(empty||value.length>0)&&!value.includes('\0');
const own=(value,key)=>Object.hasOwn(value,key);
const valid=condition=>{if(!condition)throw fault('CLIENT_STATE_INVALID');};
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
export function validAttachmentDraftPath(value){return text(value,4096)&&Buffer.byteLength(value,'utf8')<=4096&&!path.isAbsolute(value)&&!value.split(path.sep==='\\'?/[\\/]/:'/').includes('..');}
export function validAttachmentDrafts(value){return object(value)&&Object.values(value).every(files=>Array.isArray(files)&&files.length<=50&&files.every(file=>object(file)&&validAttachmentDraftPath(file.path)&&text(file.name,256,true)&&text(file.mime,128,true)));}
function defaults(){return {version:1,projects:[],sessions:[],preferences:{},notifications:[],models:[{id:'deepseek-v4.1-flash',name:'DeepSeek V4.1 Flash'}]};}
function optional(row,key,check){if(own(row,key))valid(check(row[key]));}
function unique(rows){const ids=new Set();for(const row of rows){valid(object(row)&&text(row.id,256)&&!ids.has(row.id));ids.add(row.id);}return ids;}
function validate(value){
  valid(object(value)&&value.version===1&&Array.isArray(value.projects)&&Array.isArray(value.sessions));
  const pending=[[value,0]];let nodes=0;while(pending.length){const [item,depth]=pending.pop();valid(depth<=100&&++nodes<=250000);for(const child of Object.values(item))if(child!==null&&typeof child==='object')pending.push([child,depth+1]);}
  valid(value.projects.length<=50000&&value.sessions.length<=50000);
  const state={...value,preferences:own(value,'preferences')?value.preferences:{},notifications:own(value,'notifications')?value.notifications:[],models:own(value,'models')?value.models:defaults().models};
  valid(object(state.preferences)&&Array.isArray(state.models)&&state.models.length<=10000&&Array.isArray(state.notifications)&&state.notifications.length<=50000);
  const projects=unique(state.projects),sessions=unique(state.sessions);unique(state.models);unique(state.notifications);
  for(const row of state.projects){valid(text(row.path,8192)&&path.isAbsolute(row.path));optional(row,'name',v=>text(v,1024,true));}
  const threads=new Set(),parents=new Map();
  for(const row of state.sessions){
    valid((row.projectId===null||(text(row.projectId,256)&&projects.has(row.projectId)))&&text(row.threadId,256));
    for(const key of ['title'])optional(row,key,v=>text(v,100000,true));
    for(const key of ['engineId','model','engineSessionId','contextRef'])optional(row,key,v=>text(v,256));
    for(const key of ['archived','pinned','unread','pluginDevelopment'])optional(row,key,v=>typeof v==='boolean');
    optional(row,'channel',v=>object(v)&&['feishu','qq','weixin','dingtalk','wecom'].includes(v.platform)&&text(v.binding,256)&&['dm','group','channel','thread'].includes(v.chatType)&&text(v.peer,256,true)&&text(v.chat,256,true));
    optional(row,'kind',v=>['chat','agent'].includes(v));
    optional(row,'instructionProfile',v=>v===null||object(v)||text(v,256));
    for(const key of ['createdAt','updatedAt','startedAt','completedAt'])optional(row,key,v=>v===null||(text(v,100)&&Number.isFinite(Date.parse(v))));
    optional(row,'recoveredQueue',v=>Array.isArray(v)&&v.length<=10000&&v.every(item=>object(item)&&text(item.id,256)&&Array.isArray(item.input)));
    optional(row,'program',validProgram);
    optional(row,'runRecovery',v=>object(v)&&v.version===1&&text(v.id,256)&&(v.turnId===null||text(v.turnId,256))&&['running','waiting','interrupted','failed','uncertain','completed'].includes(v.status)&&(v.reason===null||text(v.reason,128))&&Number.isSafeInteger(v.attempt)&&v.attempt>=0&&(v.nextRetryAt===null||(text(v.nextRetryAt,100)&&Number.isFinite(Date.parse(v.nextRetryAt))))&&typeof v.canResume==='boolean'&&typeof v.userStopped==='boolean'&&typeof v.managed==='boolean'&&['read-only','workspace-write','danger-full-access'].includes(v.permission)&&['low','high','max'].includes(v.effort)&&text(v.updatedAt,100)&&Number.isFinite(Date.parse(v.updatedAt)));
    optional(row,'parentSessionId',v=>v===null||(text(v,256)&&sessions.has(v)&&v!==row.id));
    if(row.parentSessionId)parents.set(row.id,row.parentSessionId);
    const thread=JSON.stringify([row.engineId??'codex',row.threadId]);valid(!threads.has(thread));threads.add(thread);
  }
  const finished=new Set();
  for(const id of parents.keys()){let next=id;const chain=new Set();while(parents.has(next)&&!finished.has(next)){valid(!chain.has(next));chain.add(next);next=parents.get(next);}for(const item of chain)finished.add(item);}
  for(const row of state.models){optional(row,'name',v=>text(v,1024,true));}
  for(const row of state.notifications){valid(text(row.sessionId,256)&&sessions.has(row.sessionId)&&text(row.createdAt,100)&&Number.isFinite(Date.parse(row.createdAt)));optional(row,'title',v=>text(v,100000,true));optional(row,'status',v=>['completed','failed','interrupted'].includes(v));}
  const prefs=state.preferences;
  optional(prefs,'selected',v=>v===null||v===''||(text(v,256)&&sessions.has(v)));
  optional(prefs,'projectId',v=>v===null||v===''||(text(v,256)&&projects.has(v)));
  optional(prefs,'pendingEngine',v=>v===null||text(v,256));
  optional(prefs,'selectedEngine',v=>text(v,256));
  optional(prefs,'locale',v=>{try{return text(v,256)&&Intl.getCanonicalLocales(v).length===1;}catch{return false;}});
  optional(prefs,'theme',v=>['light','dark','system'].includes(v));optional(prefs,'followUpBehavior',v=>['queue','steer'].includes(v));
  for(const key of ['sidebarWidth','documentWidth'])optional(prefs,key,v=>v===null||(typeof v==='number'&&Number.isFinite(v)&&v>0&&v<=10000));
  optional(prefs,'drafts',v=>object(v)&&Object.values(v).every(item=>typeof item==='string'));
  optional(prefs,'attachmentDrafts',validAttachmentDrafts);
  return state;
}
function decode(bytes){try{return validate(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));}catch(error){throw error.code?.startsWith('CLIENT_STATE_')?error:fault('CLIENT_STATE_INVALID');}}
function snapshot(state){try{const encoded=JSON.stringify(state);if(typeof encoded!=='string'||Buffer.byteLength(encoded)>LIMIT)throw fault('CLIENT_STATE_TOO_LARGE');const value=decode(Buffer.from(encoded));const bytes=Buffer.from(JSON.stringify(value,null,2)+'\n');if(bytes.length>LIMIT)throw fault('CLIENT_STATE_TOO_LARGE');return {state:value,bytes};}catch(error){throw error.code?error:fault('CLIENT_STATE_INVALID');}}
function signature(bytes,info){return {hash:digest(bytes),dev:info.dev,ino:info.ino,size:info.size,mtime:info.mtimeMs};}
function equal(left,right){return left===null?right===null:right!==null&&Object.keys(left).every(key=>left[key]===right[key]);}

export class ClientStateStore {
  constructor({dataDir}={}){if(typeof dataDir!=='string'||!path.isAbsolute(dataDir))throw fault('CLIENT_STATE_UNSAFE_PATH');this.dataDir=path.resolve(dataDir);this.serial=Promise.resolve();this.loaded=false;this.recovery=null;this.observed=null;}
  _sequence(work){const wrapped=async()=>{try{return await work();}catch(error){throw error.code?.startsWith('CLIENT_STATE_')?error:fault('CLIENT_STATE_IO');}};const operation=this.serial.then(wrapped,wrapped);this.serial=operation.catch(()=>{});return operation;}
  async flush(){await this.serial;}
  async _directory(){
    let current=path.parse(this.dataDir).root;
    for(const component of this.dataDir.slice(current.length).split(path.sep).filter(Boolean)){
      current=path.join(current,component);let info;
      try{info=await lstat(current);}catch(error){if(error.code!=='ENOENT')throw error;try{await mkdir(current,{mode:0o700});}catch(createError){if(createError.code!=='EEXIST')throw createError;}info=await lstat(current);}
      if(!info.isDirectory()||info.isSymbolicLink())throw fault('CLIENT_STATE_UNSAFE_PATH');
    }
  }
  async _read(name){
    const file=path.join(this.dataDir,name);let before;
    try{before=await lstat(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}
    if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1)throw fault('CLIENT_STATE_UNSAFE_PATH');
    if(before.size>LIMIT)throw fault('CLIENT_STATE_TOO_LARGE');
    let handle;
    try{
      handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      const info=await handle.stat();if(!info.isFile()||info.nlink!==1||info.dev!==before.dev||info.ino!==before.ino)throw fault('CLIENT_STATE_CHANGED');
      if(info.size>LIMIT)throw fault('CLIENT_STATE_TOO_LARGE');
      const chunks=[];let size=0;
      while(true){const bytes=Buffer.alloc(Math.min(65536,LIMIT+1-size));const {bytesRead}=await handle.read(bytes,0,bytes.length,null);if(!bytesRead)break;size+=bytesRead;if(size>LIMIT)throw fault('CLIENT_STATE_TOO_LARGE');chunks.push(bytes.subarray(0,bytesRead));}
      const final=await handle.stat(),after=await lstat(file);
      if(final.size!==size||final.mtimeMs!==info.mtimeMs||after.ino!==info.ino||after.dev!==info.dev||after.isSymbolicLink())throw fault('CLIENT_STATE_CHANGED');
      const bytes=Buffer.concat(chunks);return {bytes,signature:signature(bytes,final),createdAt:final.mtime.toISOString()};
    }catch(error){if(['ELOOP','EISDIR','ENOTDIR'].includes(error.code))throw fault('CLIENT_STATE_UNSAFE_PATH');throw error;}
    finally{await handle?.close();}
  }
  async _check(name,expected){const actual=await this._read(name);if(!equal(expected,actual?.signature??null))throw fault('CLIENT_STATE_CHANGED');return actual;}
  async _syncDirectory(){const handle=await open(this.dataDir,constants.O_RDONLY);try{await handle.sync();}finally{await handle.close();}}
  async _atomic(name,bytes,expected){
    await this._directory();await this._check(name,expected);
    const temporary='.'+name+'.'+randomUUID()+'.tmp';let handle;
    try{
      handle=await open(path.join(this.dataDir,temporary),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
      await handle.writeFile(bytes);await handle.sync();await handle.close();handle=null;
      await this._directory();await this._check(name,expected);
      await rename(path.join(this.dataDir,temporary),path.join(this.dataDir,name));await this._syncDirectory();
    }finally{await handle?.close();await unlink(path.join(this.dataDir,temporary)).catch(error=>{if(error.code!=='ENOENT')throw error;});}
  }
  load(){return this._sequence(()=>this._load());}
  async _load(){
    this.loaded=true;this.recovery=null;this.observed=null;this.candidate=null;
    let main,directoryReady=false;
    try{
      await this._directory();directoryReady=true;main=await this._read('client.json');
      const backupInfo=await lstat(path.join(this.dataDir,'client.backup.json')).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
      if(backupInfo&&(!backupInfo.isFile()||backupInfo.isSymbolicLink()||backupInfo.nlink!==1))throw fault('CLIENT_STATE_UNSAFE_PATH');
      if(!main){this.baseline=null;return {state:defaults(),recovery:null};}
      this.observed=main;const state=decode(main.bytes);this.baseline=main.signature;return {state,recovery:null};
    }catch(error){
      const code=error.code?.startsWith('CLIENT_STATE_')?error.code:'CLIENT_STATE_IO';
      let canReset=Boolean(main)&&!['CLIENT_STATE_UNSAFE_PATH','CLIENT_STATE_TOO_LARGE','CLIENT_STATE_CHANGED'].includes(code);
      const candidates=[];
      try{const backup=directoryReady?await this._read('client.backup.json'):null;if(backup){const state=decode(backup.bytes);this.candidate={...backup,state};candidates.push({id:'last-good',createdAt:backup.createdAt,projects:state.projects.length,sessions:state.sessions.length});}}
      catch(backupError){if(backupError.code==='CLIENT_STATE_UNSAFE_PATH')canReset=false;}
      this.recovery={code,candidates,canReset};return {state:defaults(),recovery:structuredClone(this.recovery)};
    }
  }
  save(state){
    let captured;try{captured=snapshot(state);}catch(error){return Promise.reject(error);}
    return this._sequence(async()=>{
      if(!this.loaded)await this._load();if(this.recovery)throw fault('CLIENT_STATE_RECOVERY_REQUIRED');
      await this._directory();const current=await this._check('client.json',this.baseline);
      if(current){
        let existing;try{existing=snapshot(decode(current.bytes));}catch{throw fault('CLIENT_STATE_RECOVERY_REQUIRED');}
        if(existing.bytes.equals(captured.bytes))return;
        const backup=await this._read('client.backup.json');await this._atomic('client.backup.json',current.bytes,backup?.signature??null);
      }
      await this._atomic('client.json',captured.bytes,current?.signature??null);this.baseline=(await this._read('client.json')).signature;
    });
  }
  recover(options){return this._sequence(async()=>{
    if(!this.loaded)await this._load();
    if(!this.recovery||!this.recovery.canReset||!['restore','reset'].includes(options?.action))throw fault('CLIENT_STATE_RECOVERY_UNAVAILABLE');
    if(options.action==='restore'&&(options.candidateId!=='last-good'||!this.candidate))throw fault('CLIENT_STATE_RECOVERY_UNAVAILABLE');
    await this._directory();await this._check('client.json',this.observed?.signature??null);
    if(this.candidate)await this._check('client.backup.json',this.candidate.signature);
    let selected;
    if(options.action==='restore'){const backup=await this._check('client.backup.json',this.candidate.signature);selected={state:decode(backup.bytes),bytes:backup.bytes};}
    else selected=snapshot(defaults());
    const archive='client-corrupt-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID()+'.json';
    let handle;
    try{handle=await open(path.join(this.dataDir,archive),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);await handle.writeFile(this.observed.bytes);await handle.sync();}
    finally{await handle?.close();}
    await this._syncDirectory();await this._check('client.json',this.observed.signature);
    await this._atomic('client.json',selected.bytes,this.observed.signature);
    this.baseline=(await this._read('client.json')).signature;this.observed=null;this.candidate=null;this.recovery=null;
    return {state:selected.state,archive};
  });}
}
