import {replacePlugin,finishAppearance,pluginDigest} from './plugin-revisions.mjs';
import {readFile,writeFile,mkdir,rename,cp,rm,realpath,stat,open} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
const validId=/^[a-z][a-z0-9-]{1,79}$/;
const fault=code=>Object.assign(new Error(code),{code});
const inside=(root,file)=>{const relative=path.relative(root,file);return relative===''||(!relative.startsWith('..')&&!path.isAbsolute(relative));};
export class PluginHost{
  constructor({context,dataDir,builtins,services,onChange=()=>{},beforeDisable=async()=>{},beforeUpdate=async()=>{},afterUpdate=async()=>{}}){this.context=context;this.dataDir=dataDir;this.builtins=builtins;this.services=services;this.onChange=onChange;this.beforeDisable=beforeDisable;this.beforeUpdate=beforeUpdate;this.afterUpdate=afterUpdate;this.tools=new Map();this.records=new Map();this.routes=new Map();this.activityProviders=new Map();this.features=new Map();this.engines=new Map();this.appearances=new Map();this.instructionProfiles=new Map();this.serial=Promise.resolve();this.settings={version:1,enabled:{},installed:[]};}
  async start(){
    await mkdir(this.dataDir,{recursive:true,mode:0o700});this.dataDir=await realpath(this.dataDir);
    try{this.settings=JSON.parse(await readFile(path.join(this.dataDir,'plugins.json'),'utf8'));if(this.settings.version!==1||!this.settings.enabled||!Array.isArray(this.settings.installed))throw fault('PLUGIN_STATE_INVALID');}catch(error){if(error.code!=='ENOENT')throw error;}
    if(this.settings.pending){const pending=this.settings.pending;if(!pending.previous||pending.previous.pending)throw fault('PLUGIN_STATE_INVALID');this.settings={...pending.previous,lastChange:{id:pending.id,revision:pending.revision,status:'rolledBack',reason:'PLUGIN_INTERRUPTED',at:new Date().toISOString()}};await this._save();}
    for(const file of this.builtins){const module=await import(pathToFileURL(file).href);this._add(module.manifest,module.apply,{builtin:true,file,root:path.dirname(file)});}
    for(const installed of this.settings.installed){if(!installed||!validId.test(installed.id)||this.records.has(installed.id))throw fault('PLUGIN_STATE_INVALID');try{await this._loadInstalled(installed);}catch{this.records.set(installed.id,{manifest:{id:installed.id,type:'feature',name:{en:installed.id,'zh-CN':installed.id},version:'?'},enabled:false,active:false,error:'PLUGIN_LOAD_FAILED',builtin:false,root:installed.root});}}
    // Built-ins are available by default. An external package must have an
    // explicit, persisted enable choice before any of its JavaScript runs.
    for(const record of [...this.records.values()])if(record.builtin?this.settings.enabled[record.manifest.id]!==false:this.settings.enabled[record.manifest.id]===true){await this._enable(record);if(!record.builtin&&!record.active)await this._restoreStartup(record);}
  }
  async _restoreStartup(failed){
    const id=failed.manifest.id,installed=this.settings.installed.find(row=>row.id===id);
    for(const prior of (this.settings.history?.[id]??[]).slice().reverse().filter(row=>row.root!==installed?.root)){
      this.records.delete(id);
      try{await this._loadInstalled(prior);const record=this.records.get(id);await this._enable(record);if(!record.active)continue;}
      catch{continue;}
      this.settings.installed=this.settings.installed.filter(row=>row.id!==id).concat(prior);
      this.settings.lastChange={id,revision:prior.revision,status:'rolledBack',reason:'PLUGIN_START_FAILED',at:new Date().toISOString()};await this._save();return;
    }
    this.records.set(id,failed);
  }
  _validate(manifest){if(!manifest||!validId.test(manifest.id)||!['appearance','feature','engine'].includes(manifest.type)||typeof manifest.version!=='string'||!manifest.name||typeof manifest.name.en!=='string'||typeof manifest.name['zh-CN']!=='string')throw fault('INVALID_PLUGIN');return manifest;}
  async _manifest(root){
    try{return this._validate(JSON.parse(await readFile(path.join(root,'dsh-plugin.json'),'utf8')));}
    catch(error){
      if(error.code==='ENOENT'){
        // Native DSH bundles need its Loader, reactive Config and browser slot
        // services. Do not import their code or pretend a manifest rename is
        // enough to run them in this independent host.
        try{const file=path.join(root,'package.json');if((await stat(file)).size<=1024*1024){const pkg=JSON.parse(await readFile(file,'utf8'));if(pkg?.dsh?.bundle||pkg?.dsh?.client)throw fault('PLUGIN_DSH_RUNTIME_REQUIRED');}}
        catch(nativeError){if(nativeError.code==='PLUGIN_DSH_RUNTIME_REQUIRED')throw nativeError;}
      }
      throw fault('INVALID_PLUGIN');
    }
  }
  _add(manifest,apply,extra){this._validate(manifest);if((typeof apply!=='function'&&!(extra?.lazy&&apply===null))||this.records.has(manifest.id))throw fault('INVALID_PLUGIN');this.records.set(manifest.id,{manifest,apply,...extra,enabled:false,active:false,error:null,fiber:null});}
  async _loadInstalled(installed){const root=await realpath(installed.root);if(!inside(path.join(this.dataDir,'plugins'),root))throw fault('INVALID_PLUGIN');if(installed.digest&&await pluginDigest(root)!==installed.digest)throw fault('PLUGIN_DRAFT_CHANGED');const manifest=await this._manifest(root);if(manifest.id!==installed.id)throw fault('INVALID_PLUGIN');const entry=await realpath(path.join(root,manifest.entry??'index.mjs'));if(!inside(root,entry)||!(await stat(entry)).isFile())throw fault('INVALID_PLUGIN');this._add(manifest,null,{builtin:false,lazy:true,root,file:entry,revision:installed.revision??null,digest:installed.digest});}
  list(){return [...this.records.values()].map(record=>({...record.manifest,enabled:record.enabled,active:record.active,error:record.error,builtin:record.builtin,revision:record.revision??(record.builtin?null:'legacy'),canRollback:this.history(record.manifest.id).some(row=>row.revision!==record.revision)}));}
  async _save(){
    await mkdir(this.dataDir,{recursive:true,mode:0o700});const temporary=path.join(this.dataDir,'.plugins.'+randomUUID()+'.tmp');let file;
    try{file=await open(temporary,'wx',0o600);await file.writeFile(JSON.stringify(this.settings,null,2)+'\n');await file.sync();await file.close();file=null;await rename(temporary,path.join(this.dataDir,'plugins.json'));const directory=await open(this.dataDir,'r');try{await directory.sync();}finally{await directory.close();}}
    finally{await file?.close();await rm(temporary,{force:true}).catch(()=>{});}
  }
  _sequence(work){if(this.closed)return Promise.reject(fault('PLUGIN_HOST_CLOSED'));const run=this.serial.then(work,work);this.serial=run.catch(()=>{});return run;}
  _registration(map,key,value){if(map.has(key))throw fault('PLUGIN_CONFLICT');map.set(key,value);return()=>{if(map.get(key)===value)map.delete(key);};}
  async _enable(record){
    if(record.active)return;record.enabled=true;record.error=null;
    const stopGuards=new Set();record.stopGuards=stopGuards;record.toolPending=new Set();record.toolControllers=new Set();record.acceptingTools=true;record.healthChecks=[];
    const registry=this;let pluginContext;
    const register=(map,key,value,afterRemove)=>{pluginContext.fiber.assertActive();const remove=registry._registration(map,key,value);let disposal;const dispose=()=>{remove();if(afterRemove)return disposal??=(async()=>{await afterRemove();})();};try{pluginContext.effect(()=>dispose);}catch(error){dispose();throw error;}return dispose;};
    const registerFeature=id=>{if(typeof id!=='string'||!validId.test(id))throw fault('INVALID_PLUGIN');return register(registry.features,id,{pluginId:record.manifest.id});};
    const bridge={...this.services,
      registerFeature,
      registerHealthCheck:check=>{if(typeof check!=='function')throw fault('INVALID_PLUGIN');record.healthChecks.push(check);},
      registerTool:spec=>{
        if(!spec||typeof spec.name!=='string'||!validId.test(spec.name)||typeof spec.description!=='string'||typeof spec.execute!=='function'||spec.inputSchema?.type!=='object')throw fault('INVALID_PLUGIN');
        return register(registry.tools,record.manifest.id+':'+spec.name,{...spec,pluginId:record.manifest.id,record});
      },
      hasFeature:id=>registry.features.has(id),
      registerActivityProvider:(id,snapshot)=>{if(typeof id!=='string'||!validId.test(id)||typeof snapshot!=='function')throw fault('INVALID_PLUGIN');return register(registry.activityProviders,id,{pluginId:record.manifest.id,snapshot});},
      registerBeforeStop:handler=>{
        pluginContext.fiber.assertActive();
        if(typeof handler!=='function'||stopGuards.size>=64)throw fault('INVALID_PLUGIN');
        const registration={handler};stopGuards.add(registration);
        const remove=()=>{stopGuards.delete(registration);};
        try{pluginContext.effect(()=>remove);}catch(error){remove();throw error;}
        return remove;
      },
      registerRoute:(handler)=>{
        if(!handler||typeof handler.matches!=='function'||typeof handler.handle!=='function')throw fault('INVALID_PLUGIN');
        const pending=new Set();let active=true;
        record.pauseRoute=()=>{active=false;};record.resumeRoute=()=>{active=true;};
        const route={...handler,async handle(environment){
          if(!active)throw fault('PLUGIN_DISABLED');
          const operation=Promise.resolve().then(()=>handler.handle(environment));pending.add(operation);
          try{return await operation;}finally{pending.delete(operation);}
        }};
        // Feature capabilities reflect live registrations, not manifest claims.
        // A replacement may explicitly own a built-in's canonical capability,
        // while its own route automatically supplies its default capability.
        let removeFeature;
        if(record.manifest.type==='feature'&&registry.features.get(record.manifest.id)?.pluginId!==record.manifest.id)removeFeature=registerFeature(record.manifest.id);
        let removeRoute;
        try{removeRoute=register(registry.routes,record.manifest.id,route,()=>{active=false;return Promise.allSettled([...pending]);});}
        catch(error){removeFeature?.();throw error;}
        return()=>{removeFeature?.();return removeRoute();};
      },
      registerEngine:(id,factory)=>{if(typeof id!=='string'||!validId.test(id))throw fault('INVALID_PLUGIN');return register(registry.engines,id,{...factory,pluginId:record.manifest.id});},
      registerInstructionProfile:(profile)=>register(registry.instructionProfiles,record.manifest.id,profile),
      registerAppearance:(appearance)=>register(registry.appearances,record.manifest.id,{...appearance,pluginId:record.manifest.id,revision:record.revision??null}),
      pluginRoot:record.root,
    };
    const plugin=async ctx=>{
      pluginContext=ctx;
      if(record.lazy&&!record.apply){
        const module=await import(pathToFileURL(record.file).href+'?revision='+randomUUID());
        const apply=module.apply??module.default;
        if(typeof apply!=='function')throw fault('INVALID_PLUGIN');
        record.apply=apply;
      }
      ctx.fiber.assertActive();
      return await record.apply(ctx,bridge);
    };
    try{record.fiber=this.context.plugin(plugin);await record.fiber;record.active=true;
      if(!record.builtin){let checking=false;const timer=setInterval(async()=>{if(checking||!record.active||!record.acceptingTools)return;checking=true;try{for(const check of record.healthChecks)if(await check()===false)throw fault('PLUGIN_HEALTH_FAILED');}catch{this.scheduleRecovery(record,'PLUGIN_HEALTH_FAILED');}finally{checking=false;}},30000);timer.unref();pluginContext.effect(()=>()=>clearInterval(timer));}
    }
    catch(error){record.error='PLUGIN_START_FAILED';record.active=false;if(record.fiber)await record.fiber.dispose().catch(()=>{});record.fiber=null;}
  }
  async _changeEnabled(record,enabled){
    if(this.settings.pending)throw fault('PLUGIN_VERIFY_PENDING');
    const settings=structuredClone(this.settings);const prior={active:record.active,enabled:record.enabled,error:record.error};
    if(enabled)await this._enable(record);else await this._disable(record);
    this.settings.enabled[record.manifest.id]=enabled;
    try{await this._save();}catch(error){
      try{if(prior.active&&!record.active)await this._enable(record);else if(!prior.active&&record.active)await this._disable(record);record.enabled=prior.enabled;record.error=prior.error;}
      catch{record.error='PLUGIN_ROLLBACK_FAILED';}
      finally{this.settings=settings;this.onChange();}throw error;
    }
    this.onChange();
  }
  async enable(id){return this._sequence(async()=>{const record=this.records.get(id);if(!record)throw fault('PLUGIN_UNKNOWN');await this._changeEnabled(record,true);if(!record.active)throw fault(record.error);return this.list();});}
  async _beforeStop(record,reason){
    try{for(const registration of [...(record.stopGuards??[])])await registration.handler({reason,pluginId:record.manifest.id});}
    catch(error){record.error=typeof error?.code==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(error.code)?error.code:'PLUGIN_STOP_FAILED';throw fault(record.error);}
  }
  async _disable(record){if(record.toolPending?.size)throw fault('PLUGIN_BUSY');record.acceptingTools=false;record.pauseRoute?.();try{await this.beforeDisable(record.manifest);await this._beforeStop(record,'disable');}catch(error){record.acceptingTools=true;record.resumeRoute?.();this.onChange();throw error;}if(record.fiber)await record.fiber.dispose();record.fiber=null;record.enabled=false;record.active=false;record.error=null;this.settings.enabled[record.manifest.id]=false;}
  async disable(id){return this._sequence(async()=>{const record=this.records.get(id);if(!record)throw fault('PLUGIN_UNKNOWN');await this._changeEnabled(record,false);return this.list();});}
  async remove(id){return this._sequence(async()=>{
    if(this.settings.pending)throw fault('PLUGIN_VERIFY_PENDING');
    const record=this.records.get(id);if(!record)throw fault('PLUGIN_UNKNOWN');if(record.builtin)throw fault('BUILTIN_PLUGIN');
    const prior=structuredClone(this.settings);const wasActive=record.active;const wasEnabled=record.enabled;
    await this._disable(record);this.settings.installed=this.settings.installed.filter(entry=>entry.id!==id);delete this.settings.enabled[id];
    try{await this._save();}catch(error){try{if(wasActive)await this._enable(record);record.enabled=wasEnabled;}catch{record.error='PLUGIN_ROLLBACK_FAILED';}finally{this.settings=prior;this.onChange();}throw error;}
    this.records.delete(id);const canonical=typeof record.root==='string'?await realpath(record.root).catch(()=>null):null;const managed=await realpath(path.join(this.dataDir,'plugins')).catch(()=>null);if(canonical&&managed&&canonical===path.join(managed,record.manifest.id))await rm(canonical,{recursive:true,force:true});this.onChange();return this.list();
  });}
  async install(directory){return this._sequence(async()=>{
    if(this.settings.pending)throw fault('PLUGIN_VERIFY_PENDING');
    if(typeof directory!=='string'||!path.isAbsolute(directory))throw fault('INVALID_PLUGIN');
    const root=await realpath(directory);const manifest=await this._manifest(root);if(this.records.has(manifest.id))throw fault('PLUGIN_CONFLICT');
    const entry=await realpath(path.join(root,manifest.entry??'index.mjs'));if(!inside(root,entry)||!(await stat(entry)).isFile())throw fault('INVALID_PLUGIN');
    const target=path.join(this.dataDir,'plugins',manifest.id);await mkdir(path.dirname(target),{recursive:true,mode:0o700});await mkdir(target,{mode:0o700});
    let bytes=0,count=0;
    await cp(root,target,{recursive:true,dereference:true,errorOnExist:false,force:true,filter:async source=>{const info=await stat(source);if(++count>20000||(bytes+=info.size)>100*1024*1024)throw fault('PLUGIN_LIMIT');const canonical=await realpath(source);if(!inside(root,canonical))throw fault('INVALID_PLUGIN');return !['.git','node_modules'].includes(path.basename(source));}}).catch(async error=>{await rm(target,{recursive:true,force:true});throw error;});
    const installed={id:manifest.id,root:target};try{await this._loadInstalled(installed);}catch(error){await rm(target,{recursive:true,force:true});throw error;}
    const previous=structuredClone(this.settings);this.settings.installed.push(installed);this.settings.enabled[manifest.id]=false;try{await this._save();}catch(error){this.settings=previous;this.records.delete(manifest.id);await rm(target,{recursive:true,force:true});throw error;}this.onChange();return this.list();
  });}
  history(id){return (this.settings.history?.[id]??[]).map(({root,...row})=>row);}
  deploy(directory,options){return this._sequence(()=>replacePlugin(this,directory,options));}
  rollback(id,revision,options){return this._sequence(async()=>{const version=this.settings.history?.[id]?.find(row=>row.revision===revision);if(!version)throw fault('PLUGIN_VERSION_UNKNOWN');return replacePlugin(this,version.root,{...options,expectedDigest:version.digest,rollbackFrom:revision});});}
  finishAppearance(id,revision,success){return this._sequence(()=>finishAppearance(this,id,revision,success));}
  toolList(){return [...this.tools].map(([id,spec])=>({id,pluginId:spec.pluginId,name:spec.name,description:spec.description,inputSchema:spec.inputSchema}));}
  async callTool(id,input,options={}){
    const tool=this.tools.get(id);if(!tool||!tool.record.active||!tool.record.acceptingTools)throw fault('PLUGIN_TOOL_UNKNOWN');
    const controller=new AbortController();tool.record.toolControllers.add(controller);
    const signal=options.signal?AbortSignal.any([options.signal,controller.signal]):controller.signal;
    const operation=Promise.resolve().then(()=>{if(signal.aborted)throw fault('PLUGIN_CHAT_INACTIVE');return tool.execute(input,{...options,signal});});tool.record.toolPending.add(operation);
    try{return await operation;}catch(error){if(!error.code&&!signal.aborted)this.scheduleRecovery(tool.record,'PLUGIN_RUNTIME_FAILED');throw error;}finally{tool.record.toolPending.delete(operation);tool.record.toolControllers.delete(controller);}
  }
  scheduleRecovery(record,reason){
    if(record.builtin||!record.revision||this.closed)return;
    void this._sequence(async()=>{
      if(this.records.get(record.manifest.id)!==record||!record.active||this.settings.pending)return;
      const id=record.manifest.id,previous=(this.settings.history?.[id]??[]).slice().reverse().find(row=>row.revision!==record.revision);
      if(previous)await replacePlugin(this,previous.root,{expectedRevision:record.revision,expectedDigest:previous.digest,rollbackFrom:previous.revision});
      else await this._changeEnabled(record,false);
      this.settings.lastChange={id,revision:record.revision,status:previous?'rolledBack':'disabled',reason,at:new Date().toISOString()};await this._save();this.onChange();
    }).catch(()=>{record.error='PLUGIN_ROLLBACK_FAILED';this.onChange();});
  }
  async asset(id,relative){const appearance=this.appearances.get(id);if(!appearance||typeof relative!=='string')throw fault('PLUGIN_UNKNOWN');const root=await realpath(appearance.root);const file=await realpath(path.join(root,relative));if(!inside(root,file)||!['.js','.css','.svg','.png','.woff2'].includes(path.extname(file)))throw fault('FORBIDDEN');return file;}
  activities(){
    const rows=[];
    for(const [providerId,provider] of this.activityProviders){
      try{const current=provider.snapshot();if(current&&typeof current.then==='function'){void Promise.resolve(current).catch(()=>{});throw fault('INVALID_PLUGIN');}if(!Array.isArray(current)||current.length>1000)throw fault('INVALID_PLUGIN');const ids=new Set();for(const row of current){if(!row||typeof row.id!=='string'||row.id.length<1||row.id.length>200||/[\x00-\x1f]/.test(row.id)||ids.has(row.id)||!['terminal','command','automation','unknown'].includes(row.kind)||!Number.isSafeInteger(row.count)||row.count<1||row.count>10000)throw fault('INVALID_PLUGIN');ids.add(row.id);}for(const row of current)rows.push({id:providerId+':'+row.id,pluginId:provider.pluginId,kind:row.kind,count:row.count,...(typeof row.projectId==='string'?{projectId:row.projectId}:{})});}
      catch{rows.push({id:providerId+':unverified',pluginId:provider.pluginId,kind:'unknown',count:1});}
    }return rows;
  }
  appearance(){return [...this.appearances.values()].at(-1)??null;}
  async dispatch(environment){for(const handler of this.routes.values()){if(handler.matches(environment.segments,environment.request.method)){await handler.handle(environment);return true;}}return false;}
  close(){
    if(this.closing)return this.closing;
    this.closed=true;
    const closing=this.serial.then(async()=>{
      const failures=[];
      for(const record of [...this.records.values()].reverse())if(record.fiber){
        record.pauseRoute?.();
        record.acceptingTools=false;for(const controller of record.toolControllers??[])controller.abort();
        try{if(record.toolPending?.size){let timer;try{await Promise.race([Promise.allSettled([...record.toolPending]),new Promise((_,reject)=>{timer=setTimeout(()=>reject(fault('PLUGIN_CLEANUP_FAILED')),5000);})]);}finally{clearTimeout(timer);}}await this._beforeStop(record,'shutdown');await record.fiber.dispose();record.fiber=null;record.active=false;record.error=null;}
        catch(error){failures.push(error);}
      }
      if(failures.length){this.onChange();throw fault('PLUGIN_CLEANUP_FAILED');}
      this.tools.clear();this.routes.clear();this.activityProviders.clear();this.features.clear();this.engines.clear();this.appearances.clear();this.instructionProfiles.clear();
    });
    this.closing=closing;
    void closing.catch(()=>{if(this.closing===closing)this.closing=null;});
    return closing;
  }
}
