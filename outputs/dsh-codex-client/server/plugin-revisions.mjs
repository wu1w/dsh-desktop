import {mkdir,cp,rm,realpath,stat,readdir,lstat,readFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';

export const pluginFault=code=>Object.assign(new Error(code),{code});
export const inside=(root,file)=>{const relative=path.relative(root,file);return relative===''||(!relative.startsWith('..')&&!path.isAbsolute(relative));};
export async function pluginDigest(root){
  const hash=createHash('sha256');let count=0,bytes=0;
  const walk=async folder=>{for(const name of (await readdir(folder)).sort()){
    const file=path.join(folder,name),info=await lstat(file);
    if(info.isSymbolicLink()||(!info.isFile()&&!info.isDirectory()))throw pluginFault('INVALID_PLUGIN');
    if(++count>2000||(bytes+=info.size)>20*1024*1024)throw pluginFault('PLUGIN_LIMIT');
    if(info.isDirectory())await walk(file);else {hash.update(path.relative(root,file)+'\0');hash.update(await readFile(file));hash.update('\0');}
  }};await walk(root);return hash.digest('hex');
}
export async function copyPlugin(source,target){
  source=await realpath(source);let bytes=0,count=0;
  if(inside(source,path.resolve(target)))throw pluginFault('INVALID_PLUGIN');
  await mkdir(target,{recursive:true,mode:0o700});
  try{await cp(source,target,{recursive:true,dereference:true,filter:async file=>{
    if(['.git','node_modules'].includes(path.basename(file)))return false;
    const canonical=await realpath(file),info=await stat(file);
    if(!inside(source,canonical)||(!info.isDirectory()&&!info.isFile()))throw pluginFault('INVALID_PLUGIN');
    if(++count>2000||(bytes+=info.size)>20*1024*1024)throw pluginFault('PLUGIN_LIMIT');
    return true;
  }});}catch(error){await rm(target,{recursive:true,force:true});throw error;}
}
const snapshot=record=>({id:record.manifest.id,root:record.root,revision:record.revision??'legacy',digest:record.digest,version:record.manifest.version,createdAt:new Date().toISOString()});

// This transaction covers executable plugin files and registrations. User data,
// chats and agent instructions are deliberately outside its rollback scope.
export async function replacePlugin(host,directory,{expectedRevision,expectedDigest,guard=()=>{},rollbackFrom=null}={}){
  if(host.settings.pending)throw pluginFault('PLUGIN_VERIFY_PENDING');
  await guard();
  const manifest=await host._manifest(directory),id=manifest.id,previous=host.records.get(id);
  if(previous?.builtin)throw pluginFault('BUILTIN_PLUGIN');
  if((previous?.revision??(previous?'legacy':null))!==expectedRevision)throw pluginFault('PLUGIN_REVISION_CHANGED');
  if(previous?.toolPending?.size)throw pluginFault('PLUGIN_BUSY');
  await host.beforeUpdate(previous?.manifest??manifest);
  const revision=randomUUID(),root=path.join(host.dataDir,'plugins','.versions',id,revision);
  await copyPlugin(directory,root);
  const digest=await pluginDigest(root);
  if(expectedDigest&&digest!==expectedDigest){await rm(root,{recursive:true,force:true});throw pluginFault('PLUGIN_DRAFT_CHANGED');}
  const prior=structuredClone(host.settings),wasActive=previous?.active??false;
  // Freeze legacy installations as well, so subsequent draft edits never
  // change a version which the history promises can be restored.
  let priorVersion;
  if(previous){
    priorVersion=snapshot(previous);
    if(!previous.revision){
      priorVersion={...priorVersion,revision:randomUUID(),root:path.join(host.dataDir,'plugins','.versions',id,randomUUID())};
      await copyPlugin(previous.root,priorVersion.root);
      priorVersion.digest=await pluginDigest(priorVersion.root);
    }
  }
  const pending={id,revision,previous:prior};
  host.settings.pending=pending;
  try{await host._save();}catch(error){host.settings=prior;await rm(root,{recursive:true,force:true});throw error;}
  let stopped=false,candidate;
  try{
    await guard();
    await host.beforeUpdate(previous?.manifest??manifest);
    if(previous){await host._disable(previous);stopped=true;host.records.delete(id);}
    await host._loadInstalled({id,root,revision,digest});candidate=host.records.get(id);
    await host._enable(candidate);
    if(!candidate.active)throw pluginFault('PLUGIN_START_FAILED');
    for(const check of candidate.healthChecks??[])if(await check()===false)throw pluginFault('PLUGIN_HEALTH_FAILED');
    await guard();
    await host.afterUpdate(manifest);
    host.settings.installed=prior.installed.filter(row=>row.id!==id).concat({id,root,revision,digest});
    host.settings.enabled={...prior.enabled,[id]:true};
    const history=[...(prior.history?.[id]??[])];
    if(priorVersion&&!history.some(row=>row.revision===priorVersion.revision))history.push(priorVersion);
    history.push({...snapshot(candidate),...(rollbackFrom?{restoredFrom:rollbackFrom}:{})});
    host.settings.history={...prior.history,[id]:history.slice(-30)};
    host.settings.lastChange={id,revision,status:manifest.type==='appearance'?'verifying':'applied',at:new Date().toISOString()};
    // A UI plugin is not committed until the independent shell has mounted it.
    if(manifest.type!=='appearance')delete host.settings.pending;
    await host._save();host.onChange();return {plugin:host.list().find(row=>row.id===id),history:host.history(id)};
  }catch(error){
    try{
      if(candidate?.fiber)await host._disable(candidate);
      if(stopped||!previous)host.records.delete(id);
      if(previous){host.records.set(id,previous);if(wasActive&&!previous.active)await host._enable(previous);if(wasActive&&!previous.active)throw pluginFault('PLUGIN_ROLLBACK_FAILED');}
      if(previous)await host.afterUpdate(previous.manifest);
      host.settings=prior;host.settings.lastChange={id,revision,status:'rolledBack',reason:error.code??'PLUGIN_START_FAILED',at:new Date().toISOString()};
      await host._save();
    }catch{host.settings={...prior,pending};host.onChange();throw pluginFault('PLUGIN_ROLLBACK_FAILED');}
    host.onChange();throw pluginFault(error.code==='PLUGIN_START_FAILED'||!error.code?'PLUGIN_UPDATE_FAILED':error.code);
  }
}

export async function finishAppearance(host,id,revision,success){
  const pending=host.settings.pending;
  if(!pending||pending.id!==id||pending.revision!==revision)throw pluginFault('PLUGIN_REVISION_CHANGED');
  if(success){const prior=host.settings;host.settings={...prior};delete host.settings.pending;host.settings.lastChange={...prior.lastChange,status:'applied'};try{await host._save();}catch(error){host.settings=prior;throw error;}host.onChange();return;}
  const current=host.records.get(id);if(current)await host._disable(current);host.records.delete(id);
  const previous=pending.previous,installed=previous.installed.find(row=>row.id===id);
  if(installed){await host._loadInstalled(installed);if(previous.enabled[id]){await host._enable(host.records.get(id));if(!host.records.get(id).active)throw pluginFault('PLUGIN_ROLLBACK_FAILED');}}
  host.settings={...previous,lastChange:{id,revision,status:'rolledBack',reason:'PLUGIN_APPEARANCE_FAILED',at:new Date().toISOString()}};
  try{await host._save();}catch(error){host.settings.pending=pending;throw error;}host.onChange();
}
