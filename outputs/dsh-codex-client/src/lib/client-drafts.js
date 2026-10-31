// Empty caches from an earlier window/origin must not erase durable drafts.
// Nonempty local edits still win so offline work remains recoverable.
export function mergeInitialDrafts(saved={},cached={}){const next={...saved};for(const [id,value] of Object.entries(cached??{})){if(!value?.length&&saved?.[id]?.length)continue;next[id]=value;}return next;}
const documentKey='dsh-document-draft';
const preferenceValues=preferences=>[
  ['dsh-drafts',JSON.stringify(preferences.drafts??{})],
  ['dsh-attachment-drafts',JSON.stringify(preferences.attachmentDrafts??{})]
];
const sameDocument=(a,b)=>!a||!b?a===b:a.file.projectId===b.file.projectId&&a.file.path===b.file.path&&a.file.version===b.file.version&&a.file.content===b.file.content;

// localStorage is an optional cache once the independent recovery service is
// available. Keep failures by snapshot so a late success cannot erase newer data.
export class ClientDraftCache {
  constructor(storage,{onError=()=>{}}={}){this.storage=storage;this.onError=onError;this.failed=new Map();}
  persist(preferences,documentDraft){
    const failures=[];
    for(const [key,value] of [...preferenceValues(preferences),[documentKey,documentDraft?JSON.stringify(documentDraft):null]]){
      try{value===null?this.storage.removeItem(key):this.storage.setItem(key,value);this.failed.delete(key);}
      catch(error){const entry={key,value,error};this.failed.set(key,entry);failures.push(entry);}
    }
    if(failures.length)this.onError(failures[0].error);
    return failures;
  }
  _acknowledge(matches){
    const failures=[];
    for(const entry of [...this.failed.values()])if(matches(entry)){
      // Removing a quota-blocked old value is safe only after its replacement is
      // durable. Otherwise local-first startup could restore the stale value.
      try{this.storage.removeItem(entry.key);if(this.failed.get(entry.key)===entry)this.failed.delete(entry.key);}
      catch(error){failures.push(error);this.onError(error);}
    }
    if(failures.length){const error=new Error('LOCAL_DRAFT_CACHE_FAILED',{cause:failures[0]});error.code='LOCAL_DRAFT_CACHE_FAILED';throw error;}
  }
  acknowledgePreferences(preferences){const values=new Map(preferenceValues(preferences));this._acknowledge(entry=>values.get(entry.key)===entry.value);}
  acknowledgeDocument(draft){this._acknowledge(entry=>entry.key===documentKey&&sameDocument(entry.value?JSON.parse(entry.value):null,draft));}
}

export function persistClientDrafts(storage,preferences,documentDraft){
  const failures=new ClientDraftCache(storage).persist(preferences,documentDraft);
  if(failures.length)throw failures[0].error;
}

export async function flushClientDrafts({storage,cache=new ClientDraftCache(storage),documentSession,preferences,persistPreferences,persistDocumentRecovery,discardDocument=false}){
  const previouslyDiscarded=documentSession.recoveryDiscarded;
  if(discardDocument)documentSession.setRecoveryDiscarded(true);
  try{
    const draft=documentSession.recoveryDraft(),file=documentSession.snapshot().file;
    const localFailures=cache.persist(preferences,draft),failures=[];
    // Attempt both durable stores even if a cache or the other store failed.
    if(persistDocumentRecovery){
      try{await persistDocumentRecovery({file,draft});cache.acknowledgeDocument(draft);}
      catch(error){failures.push(error);}
    }else if(draft&&localFailures.some(entry=>entry.key===documentKey))failures.push(localFailures.find(entry=>entry.key===documentKey).error);
    else if(!draft){try{cache.acknowledgeDocument(null);}catch(error){failures.push(error);}}
    try{await persistPreferences(preferences);cache.acknowledgePreferences(preferences);}
    catch(error){failures.push(error);}
    if(failures.length)throw failures[0];
  }catch(error){
    // A rejected close leaves the editor alive. Restore its recovery record so
    // another reload or an appearance switch cannot lose the unsaved document.
    if(discardDocument&&!previouslyDiscarded){
      documentSession.setRecoveryDiscarded(false);
      cache.persist(preferences,documentSession.recoveryDraft());
    }
    throw error;
  }
}
