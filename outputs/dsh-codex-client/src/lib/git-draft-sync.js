import {api} from '../api.js';

const fields=['message','authorName','authorEmail'];
const empty=()=>({message:'',authorName:'',authorEmail:''});
const fault=code=>Object.assign(new Error(code),{code});
const codeOf=error=>/^[A-Z][A-Z0-9_]{0,79}$/.test(error?.code??'')?error.code:'GIT_DRAFT_UNAVAILABLE';
const equal=(a,b)=>fields.every(key=>a?.[key]===b?.[key]);
function valueOf(value){const result={};for(const key of fields){if(typeof value?.[key]!=='string')throw fault('GIT_DRAFT_INVALID');result[key]=value[key];}return result;}
function validate(value){let bytes=0;for(const key of fields){const text=value[key];if(text.includes('\0')||/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text))throw fault('GIT_DRAFT_INVALID');const size=new TextEncoder().encode(text).length;bytes+=size;if(key!=='message'&&size>1024)throw fault('GIT_DRAFT_LIMIT');}if(bytes>65536)throw fault('GIT_DRAFT_LIMIT');}

// Shared outside React: closing a panel never abandons an outstanding write.
export class GitDraftCoordinator {
  constructor({request=(route)=>api(route),mutateRequest=(route,body)=>api(route,body),delay=350,maxEntries=64,setTimer=(...args)=>globalThis.setTimeout(...args),clearTimer=(...args)=>globalThis.clearTimeout(...args)}={}){this.request=request;this.mutateRequest=mutateRequest;this.delay=delay;this.maxEntries=maxEntries;this.setTimer=setTimer;this.clearTimer=clearTimer;this.entries=new Map();this.listeners=new Set();}
  _entry(projectId){
    if(typeof projectId!=='string'||!projectId)throw fault('GIT_DRAFT_INVALID');
    let entry=this.entries.get(projectId);if(entry)return entry;
    for(const [id,value]of this.entries){if(this.entries.size<this.maxEntries)break;if(!value.listeners.size&&!value.dirty&&!value.promise&&!value.errorCode){this._cancel(value);this.entries.delete(id);}}
    if(this.entries.size>=this.maxEntries)throw fault('GIT_DRAFT_LIMIT');
    entry={projectId,value:empty(),hasValue:false,version:null,revision:0,loaded:false,loading:false,saving:false,dirty:false,desired:'save',errorCode:null,recovered:false,listeners:new Set(),promise:null,timer:null};this.entries.set(projectId,entry);return entry;
  }
  snapshot(projectId){const e=this._entry(projectId);return {projectId,value:e.hasValue?{...e.value}:null,version:e.version,revision:e.revision,loaded:e.loaded,loading:e.loading,saving:e.saving,dirty:e.dirty,errorCode:e.errorCode,recovered:e.recovered};}
  state(){const projects=[...this.entries.values()].filter(e=>e.dirty||e.loading||e.saving||e.errorCode).map(e=>({projectId:e.projectId,dirty:e.dirty,loading:e.loading,saving:e.saving,errorCode:e.errorCode}));return {projects,pending:projects.some(e=>e.dirty||e.loading||e.saving),needsProtection:projects.some(e=>e.dirty||e.saving),errorCode:projects.find(e=>e.errorCode)?.errorCode??null};}
  subscribeState(listener){this.listeners.add(listener);listener(this.state());return()=>this.listeners.delete(listener);}
  subscribe(projectId,listener){const e=this._entry(projectId);e.listeners.add(listener);listener(this.snapshot(projectId));return()=>{e.listeners.delete(listener);if(!e.listeners.size){this._cancel(e);void this.flushProject(projectId).catch(()=>{});}};}
  _emit(e){for(const listener of e.listeners){try{listener(this.snapshot(e.projectId));}catch{}}for(const listener of this.listeners){try{listener(this.state());}catch{}}}
  _cancel(e){if(e.timer!==null){this.clearTimer(e.timer);e.timer=null;}}
  _serial(e,operation){const next=(e.promise??Promise.resolve()).catch(()=>{}).then(operation);e.promise=next;next.finally(()=>{if(e.promise===next)e.promise=null;}).catch(()=>{});return next;}
  async _load(e,{discardLocal=false}={}){
    const revision=e.revision;e.loading=true;this._emit(e);
    try{
      const response=await this.request(`git-drafts?projectId=${encodeURIComponent(e.projectId)}`),draft=response?.draft;
      if(draft!==null&&(draft?.projectId!==e.projectId||typeof draft.version!=='string'||!draft.version))throw fault('GIT_DRAFT_PROTOCOL');
      const value=draft===null?empty():valueOf(draft);validate(value);
      e.version=draft?.version??null;e.loaded=true;e.errorCode=null;
      if(e.revision===revision&&(!e.dirty||discardLocal)){e.value=value;e.hasValue=draft!==null;e.dirty=false;e.recovered=draft!==null;e.desired='save';}
      return this.snapshot(e.projectId);
    }catch(error){e.errorCode=codeOf(error);throw error;}finally{e.loading=false;this._emit(e);}
  }
  load(projectId){const e=this._entry(projectId);if(e.loaded)return Promise.resolve(this.snapshot(projectId));return this._serial(e,()=>e.loaded?this.snapshot(projectId):this._load(e));}
  reload(projectId){const e=this._entry(projectId);this._cancel(e);return this._serial(e,()=>this._load(e,{discardLocal:true}));}
  update(projectId,value){const e=this._entry(projectId),next=valueOf(value);if(e.hasValue&&equal(e.value,next)&&e.desired==='save')return this.snapshot(projectId);e.value=next;e.hasValue=true;e.revision++;e.dirty=true;e.desired='save';e.recovered=false;
    // Conflicts remain visible until an explicit reload. A local edit cannot
    // authorize overwriting another writer's version.
    if(e.errorCode!=='GIT_DRAFT_CHANGED')e.errorCode=null;
    try{validate(next);}catch(error){e.errorCode=codeOf(error);}
    this._cancel(e);if(!e.errorCode)e.timer=this.setTimer(()=>{e.timer=null;void this.flushProject(projectId).catch(()=>{});},this.delay);this._emit(e);return this.snapshot(projectId);
  }
  clearMatching(projectId,expected){const e=this._entry(projectId);if(!e.hasValue||!equal(e.value,expected))return false;e.value=empty();e.hasValue=true;e.revision++;e.dirty=true;e.desired='clear';e.recovered=false;this._cancel(e);this._emit(e);void this.flushProject(projectId).catch(()=>{});return true;}
  retry(projectId){const e=this._entry(projectId);return e.dirty?this.flushProject(projectId):this.load(projectId);}
  flushProject(projectId){const e=this._entry(projectId);this._cancel(e);return this._serial(e,async()=>{
    if(!e.dirty)return this.snapshot(projectId);
    try{
      if(!e.loaded)await this._load(e);
      while(e.dirty){
        if(e.errorCode==='GIT_DRAFT_CHANGED')throw fault(e.errorCode);
        const revision=e.revision,desired=e.desired,value={...e.value},baseVersion=e.version;validate(value);e.saving=true;e.errorCode=null;this._emit(e);
        const result=await this.mutateRequest(`git-drafts/${desired==='clear'?'clear':'save'}`,{projectId,...(desired==='clear'?{}:value),baseVersion});
        if(desired==='clear'){if(typeof result?.cleared!=='boolean')throw fault('GIT_DRAFT_PROTOCOL');e.version=null;}
        else{const draft=result?.draft;if(draft?.projectId!==projectId||typeof draft.version!=='string'||!draft.version||!equal(valueOf(draft),value))throw fault('GIT_DRAFT_PROTOCOL');e.version=draft.version;}
        if(e.revision===revision){e.dirty=false;this._cancel(e);if(desired==='clear')e.hasValue=false;}e.errorCode=null;e.saving=false;this._emit(e);
      }
      return this.snapshot(projectId);
    }catch(error){e.errorCode=codeOf(error);throw error;}finally{e.saving=false;this._emit(e);}
  });}
  async flush(){const results=await Promise.allSettled([...this.entries.values()].filter(e=>e.dirty||e.saving).map(e=>this.flushProject(e.projectId)));const failed=results.find(result=>result.status==='rejected');if(failed)throw failed.reason;return this.state();}
}
export const gitDraftCoordinator=new GitDraftCoordinator();
export const flushGitDrafts=()=>gitDraftCoordinator.flush();
export const subscribeGitDraftState=listener=>gitDraftCoordinator.subscribeState(listener);
