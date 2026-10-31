import {readFile,writeFile,mkdir,readdir,lstat,realpath,rename,rm} from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {developmentTool} from '../shared/development-tool.js';
import {copyPlugin,inside,pluginFault as fault} from './plugin-revisions.mjs';
const execute=promisify(execFile),validId=/^[a-z][a-z0-9-]{1,79}$/;
const mutating=new Set(['create','checkout','write','apply','rollback','call']);
const guide=`DSH versioned plugin development API v1
Workflow: create(pluginId) OR checkout(pluginId) -> files/read -> write(file,content,digest) -> validate(digest) -> apply(digest,expectedRevision). Every write returns a NEW digest; use it on the next operation. expectedRevision is the installed revision from list, or "new". Revisions are immutable; rollback(revision,expectedRevision) restores code without touching chats/memories/agent markdown. Native DSH packages need adapting to this API.
Manifest dsh-plugin.json: {id,type:"feature"|"appearance"|"engine",version,entry:"index.mjs",name:{"zh-CN":...,en:...}}. Export async apply(ctx,host). Bundle dependencies or use relative imports/Node builtins; node_modules is not copied. Managed drafts are <=20 MB, 2000 files, text file <=200 KB.
Host API: registerTool({name (hyphenated ID),description,inputSchema:{type:"object",properties:...},execute:async(input,{signal,sessionId})=>JSON value}); registerFeature(id); hasFeature(id); registerRoute({matches:(segments,method)=>boolean,handle:async({request,segments,body,url,json})=>{...}}); registerHealthCheck(async()=>boolean); registerBeforeStop(async({reason})=>{...}); registerAppearance({root:absolute path,entry:"view.js",styles:["view.css"],exportName:"mount"}); pluginRoot. Register every timer/listener/resource cleanup with ctx.effect(()=>()=>cleanup()); await ctx-owned async work; never use detached unmanaged tasks. Runtime self-checks run before commit. Tool names are published live through dsh_plugins tools/call.
Appearance JS must export async mount(root) returning an unmount function; use bilingual resources/locale, preserve DSH backend sessions. The independent recovery shell (Cmd+Alt+P) remains available. UI assets use revision-specific paths for nested modules. If mount fails the shell rolls back automatically. Current builtins cannot be overwritten; extend with a new plugin or replace a disabled capability. Core binary/boot changes need a normal build/restart, not hot swapping.
Validation checks syntax only and does NOT execute draft code. Apply executes trusted Node code with the host user's access: only on explicit user scope. Rollback restores executable code/registrations, not external writes/network side effects. Keep migrations reversible. A stopped/archived/IM chat cannot mutate plugins. Never use shell to bypass grants.`;

export class PluginDevelopment{
  constructor({host,state,getEngine,save,onChange=()=>{}}){Object.assign(this,{host,state,getEngine,save,onChange});this.tokens=new Map();this.serial=Promise.resolve();}
  token(id){if(!this.tokens.has(id))this.tokens.set(id,randomUUID());return this.tokens.get(id);}
  idForToken(value){return typeof value==='string'?[...this.tokens].find(([,token])=>token===value)?.[0]:undefined;}
  session(nativeId){return this.state.sessions.find(row=>(row.engineSessionId??row.id)===nativeId);}
  guard(nativeId,action,signal){
    const session=this.session(nativeId);
    if(signal?.aborted||this.host.closed||!session||session.archived||session.channel||session.kind==='agent'||session.automationId||session.runRecovery?.userStopped||!this.getEngine()?.activeTurns.has(session.id))throw fault('PLUGIN_CHAT_INACTIVE');
    if(mutating.has(action)&&session.pluginDevelopment!==true)throw fault('PLUGIN_DEVELOPMENT_DENIED');
    return session;
  }
  async grant(id,enabled){
    const session=this.state.sessions.find(row=>row.id===id);if(!session||session.archived||session.channel||session.kind==='agent'||session.automationId||typeof enabled!=='boolean')throw fault('PLUGIN_CHAT_INACTIVE');
    const previous=session.pluginDevelopment;session.pluginDevelopment=enabled;
    try{await this.save();}catch(error){session.pluginDevelopment=previous;throw error;}this.onChange();return {enabled};
  }
  async engineCall(nativeId,input,options={}){
    const controller=new AbortController();
    const signal=options.signal?AbortSignal.any([options.signal,controller.signal]):controller.signal;
    const guard=()=>this.guard(nativeId,input?.action,signal);guard();
    const timer=setInterval(()=>{try{guard();}catch(error){controller.abort(error);}},250);timer.unref();
    try{const result=await this.run(input,{guard,signal,sessionId:this.session(nativeId).id});guard();return result;}
    finally{clearInterval(timer);}
  }
  run(input,options={}){const work=()=>this._run(input,options);const pending=this.serial.then(work,work);this.serial=pending.catch(()=>{});return pending;}
  root(id){if(typeof id!=='string'||!validId.test(id)||this.host.records.get(id)?.builtin)throw fault('INVALID_PLUGIN');return path.join(this.host.dataDir,'plugin-drafts',id);}
  async inspect(id){
    const root=this.root(id),files=[],hash=createHash('sha256');let bytes=0,count=0;
    if((await lstat(root)).isSymbolicLink())throw fault('INVALID_PLUGIN');
    const walk=async folder=>{for(const name of (await readdir(folder)).sort()){const file=path.join(folder,name),info=await lstat(file);if(info.isSymbolicLink()||(!info.isFile()&&!info.isDirectory()))throw fault('INVALID_PLUGIN');if(++count>2000||(bytes+=info.size)>20*1024*1024)throw fault('PLUGIN_LIMIT');if(info.isDirectory()){await walk(file);continue;}const relative=path.relative(root,file);const data=await readFile(file);hash.update(relative+'\0');hash.update(data);hash.update('\0');files.push({path:relative,bytes:data.length});}};
    await walk(root);return {pluginId:id,root,files,digest:hash.digest('hex'),expectedRevision:this.host.records.get(id)?.revision??(this.host.records.has(id)?'legacy':'new')};
  }
  async file(id,relative){
    const root=this.root(id);if(typeof relative!=='string'||!relative||relative.includes('\\')||relative.includes('\0')||path.isAbsolute(relative)||relative.split('/').some(part=>!part||part==='.'||part==='..'||part.startsWith('.')))throw fault('INVALID_PLUGIN');
    const target=path.join(root,relative);if(!inside(root,target))throw fault('INVALID_PLUGIN');
    let current=root;for(const part of path.relative(root,path.dirname(target)).split(path.sep).filter(Boolean)){current=path.join(current,part);try{const info=await lstat(current);if(!info.isDirectory()||info.isSymbolicLink())throw fault('INVALID_PLUGIN');}catch(error){if(error.code!=='ENOENT')throw error;await mkdir(current,{mode:0o700});}}
    try{if(!(await lstat(target)).isFile())throw fault('INVALID_PLUGIN');}catch(error){if(error.code!=='ENOENT')throw error;}
    if(!inside(await realpath(root),await realpath(path.dirname(target))))throw fault('INVALID_PLUGIN');return target;
  }
  async validate(id,digest){
    const draft=await this.inspect(id);if(draft.digest!==digest)throw fault('PLUGIN_DRAFT_CHANGED');
    const manifest=await this.host._manifest(draft.root);if(manifest.id!==id)throw fault('INVALID_PLUGIN');
    const entry=await realpath(path.join(draft.root,manifest.entry??'index.mjs'));if(!inside(draft.root,entry))throw fault('INVALID_PLUGIN');
    const issues=[];for(const file of draft.files.filter(row=>/\.(mjs|cjs|js)$/.test(row.path))){try{await execute(process.execPath,['--check',path.join(draft.root,file.path)],{timeout:5000,maxBuffer:16000,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});}catch(error){issues.push({file:file.path,message:String(error.stderr||error.message).slice(0,3000)});}}
    return {...draft,ok:issues.length===0,issues};
  }
  async _run(input,{guard=()=>{},signal,sessionId}={}){
    if(!input||!developmentTool.inputSchema.properties.action.enum.includes(input.action))throw fault('INVALID_REQUEST');await guard();
    const {action,pluginId:id}=input;
    if(action==='guide')return {guide};
    if(action==='list')return {plugins:this.host.list(),lastChange:this.host.settings.lastChange??null,drafts:await readdir(path.join(this.host.dataDir,'plugin-drafts')).catch(error=>{if(error.code==='ENOENT')return [];throw error;})};
    if(action==='tools')return {tools:this.host.toolList()};
    if(action==='call'){let value;try{value=JSON.parse(input.input??'{}');}catch{throw fault('INVALID_REQUEST');}if(!value||typeof value!=='object'||Array.isArray(value))throw fault('INVALID_REQUEST');return {result:await this.host.callTool(input.toolId,value,{signal,sessionId})};}
    if(action==='history')return {history:this.host.history(id)};
    if(action==='rollback')return this.host.rollback(id,input.revision,{expectedRevision:input.expectedRevision==='new'?null:input.expectedRevision,guard});
    const root=this.root(id);
    if(action==='create'){
      if(this.host.records.has(id))throw fault('PLUGIN_CONFLICT');
      await mkdir(path.dirname(root),{recursive:true,mode:0o700});await mkdir(root,{mode:0o700}).catch(error=>{if(error.code==='EEXIST')throw fault('PLUGIN_DRAFT_EXISTS');throw error;});
      const manifest={id,type:'feature',version:'1.0.0',entry:'index.mjs',name:{'zh-CN':id,en:id}};
      await writeFile(path.join(root,'dsh-plugin.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600});
      await writeFile(path.join(root,'index.mjs'),`export function apply(ctx, host) {\n  host.registerTool({\n    name: 'status',\n    description: 'Return this plugin version.',\n    inputSchema: {type:'object', properties:{}, additionalProperties:false},\n    execute: async () => ({plugin:${JSON.stringify(id)}, version:'1.0.0'})\n  });\n  host.registerHealthCheck(() => true);\n}\n`,{mode:0o600});
      return this.inspect(id);
    }
    if(action==='checkout'){
      const record=this.host.records.get(id);if(!record)throw fault('PLUGIN_UNKNOWN');
      try{await lstat(root);throw fault('PLUGIN_DRAFT_EXISTS');}catch(error){if(error.code!=='ENOENT')throw error;}
      await copyPlugin(record.root,root);return this.inspect(id);
    }
    const draft=await this.inspect(id);
    if(action==='files')return draft;
    if(action==='read'){const row=draft.files.find(file=>file.path===input.file);if(!row||row.bytes>200000)throw fault('PLUGIN_LIMIT');return {...draft,file:input.file,content:await readFile(await this.file(id,input.file),'utf8')};}
    if(draft.digest!==input.digest)throw fault('PLUGIN_DRAFT_CHANGED');
    if(action==='write'){
      if(typeof input.content!=='string'||Buffer.byteLength(input.content)>200000)throw fault('PLUGIN_LIMIT');
      const target=await this.file(id,input.file),temporary=target+'.'+randomUUID()+'.tmp';await guard();
      await writeFile(temporary,input.content,{mode:0o600});await rename(temporary,target);return this.inspect(id);
    }
    if(action==='validate')return this.validate(id,input.digest);
    if(action==='apply'){
      const checked=await this.validate(id,input.digest);if(!checked.ok)throw fault('PLUGIN_VALIDATION_FAILED');
      await guard();return this.host.deploy(root,{expectedRevision:input.expectedRevision==='new'?null:input.expectedRevision,expectedDigest:input.digest,guard});
    }
    throw fault('INVALID_REQUEST');
  }
}
