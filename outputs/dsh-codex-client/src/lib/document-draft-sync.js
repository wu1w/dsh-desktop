const keyOf=file=>`${file.projectId}\0${file.path}`;
const payloadOf=file=>({projectId:file.projectId,path:file.path,version:file.version,content:file.content});
const samePayload=(a,b)=>a.projectId===b.projectId&&a.path===b.path&&a.version===b.version&&a.content===b.content;

// Recovery writes share one serial lane. A clear always follows any write already
// in flight; superseded, not-yet-started saves never bring discarded text back.
export class DocumentDraftSync {
  constructor({save,clear,debounceMs=400,setTimer=(...args)=>globalThis.setTimeout(...args),clearTimer=(...args)=>globalThis.clearTimeout(...args),onError=()=>{}}){
    this.save=save;this.remove=clear;this.debounceMs=debounceMs;this.setTimer=setTimer;this.clearTimer=clearTimer;this.onError=onError;
    this.entries=new Map();this.serial=Promise.resolve();this.sequence=0;this.disposed=false;
  }
  _entry(kind,file){
    if(this.disposed)throw new Error('DOCUMENT_RECOVERY_DISPOSED');
    const key=keyOf(file),old=this.entries.get(key),payload=kind==='save'?payloadOf(file):{projectId:file.projectId,path:file.path};
    if(old?.kind===kind&&(kind==='clear'||samePayload(old.payload,payload)))return old;
    if(old?.timer!==undefined)this.clearTimer(old.timer);
    const entry={key,id:++this.sequence,kind,payload,timer:undefined,promise:null,error:null,done:false};this.entries.set(key,entry);return entry;
  }
  _enqueue(entry){
    if(entry.timer!==undefined){this.clearTimer(entry.timer);entry.timer=undefined;}
    if(entry.promise)return entry.promise;
    entry.done=false;entry.error=null;
    const pending=this.serial.then(async()=>{
      if(this.disposed||(entry.kind==='save'&&this.entries.get(entry.key)!==entry))return false;
      await (entry.kind==='save'?this.save(entry.payload):this.remove(entry.payload));
      entry.done=true;return true;
    }).catch(error=>{entry.error=error;if(this.entries.get(entry.key)===entry)this.onError(error,Object.freeze({kind:entry.kind,projectId:entry.payload.projectId,path:entry.payload.path}));throw error;});
    entry.promise=pending;
    // The lane survives failures. Callers still receive the operation's rejection.
    this.serial=pending.catch(()=>{});return pending;
  }
  scheduleSave(file){
    if(this.disposed)return false;
    const entry=this._entry('save',file);
    if(entry.error){entry.promise=null;entry.error=null;}
    if(entry.done||entry.promise||entry.timer!==undefined)return true;
    entry.timer=this.setTimer(()=>{entry.timer=undefined;this._enqueue(entry).catch(()=>{});},this.debounceMs);return true;
  }
  saveNow(file){return this._enqueue(this._entry('save',file));}
  clear(file){return this._enqueue(this._entry('clear',file));}
  async flush(){
    if(this.disposed)throw new Error('DOCUMENT_RECOVERY_DISPOSED');
    const retried=new Set();
    for(;;){
      for(const entry of this.entries.values())if(entry.timer!==undefined)this._enqueue(entry).catch(()=>{});
      const observed=this.serial;await observed;
      if(observed!==this.serial)continue;
      const failed=[...this.entries.values()].filter(entry=>entry.error);
      const retry=failed.filter(entry=>!retried.has(entry.id));
      if(retry.length){for(const entry of retry){retried.add(entry.id);entry.promise=null;this._enqueue(entry).catch(()=>{});}continue;}
      if(failed.length)throw failed[0].error;
      if([...this.entries.values()].some(entry=>entry.timer!==undefined))continue;
      return;
    }
  }
  dispose(){this.disposed=true;for(const entry of this.entries.values())if(entry.timer!==undefined)this.clearTimer(entry.timer);}
}

// Use the disk version when the content was already saved before a crash. For
// unsaved recovery retain the original version so external changes still conflict.
export function recoveredDocument(disk,draft){
  if(!draft||draft.projectId!==disk.projectId||draft.path!==disk.path)return {file:disk,dirty:false,stale:false};
  if(draft.content===disk.content)return {file:disk,dirty:false,stale:true};
  return {file:{...disk,content:draft.content,version:draft.version},dirty:true,stale:false};
}

export function latestDocumentDraft(drafts,projects){
  const known=new Set(projects.map(project=>project.id));
  return [...drafts].filter(row=>known.has(row.projectId)&&typeof row.path==='string'&&typeof row.content==='string'&&typeof row.version==='string')
    .sort((a,b)=>String(b.updatedAt??'').localeCompare(String(a.updatedAt??'')))[0]??null;
}
