import test from 'node:test';
import assert from 'node:assert/strict';
import {DocumentDraftSync,recoveredDocument,latestDocumentDraft} from '../src/lib/document-draft-sync.js';
import {DocumentSession} from '../src/lib/document-session.js';
import {ClientDraftCache,flushClientDrafts,mergeInitialDrafts} from '../src/lib/client-drafts.js';

const file=(content='edited',path='A.md',version='v1')=>({projectId:'project',path,name:path,content,version});
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function timers(){const calls=new Map();let sequence=0;return {setTimer:callback=>{calls.set(++sequence,callback);return sequence;},clearTimer:id=>calls.delete(id),run(){const pending=[...calls.values()];calls.clear();pending.forEach(callback=>callback());},get size(){return calls.size;}};}
function storage(){const values=new Map();return {getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};}
function quotaStorage(initial={},removeFails=false){
  const values=new Map(Object.entries(initial));
  return {getItem:key=>values.get(key)??null,setItem(){throw new DOMException('The quota has been exceeded.','QuotaExceededError');},removeItem(key){if(removeFails)throw new DOMException('Storage is inaccessible.','SecurityError');values.delete(key);}};
}

test('discard cancels debounced recovery and no timer can resurrect its text',async()=>{
  const clock=timers(),events=[],sync=new DocumentDraftSync({...clock,save:async value=>events.push(['save',value.content]),clear:async()=>events.push(['clear'])});
  sync.scheduleSave(file('never write me'));assert.equal(clock.size,1);
  await sync.clear(file());clock.run();await sync.flush();
  assert.deepEqual(events,[['clear']]);assert.equal(clock.size,0);
});

test('discard is serialized after an in-flight save, even if that save responds late',async()=>{
  const writing=deferred(),events=[],sync=new DocumentDraftSync({save:async value=>{events.push(['save-start',value.content]);await writing.promise;events.push(['save-end']);},clear:async()=>events.push(['clear'])});
  const old=sync.saveNow(file('old draft'));await Promise.resolve();
  const clearing=sync.clear(file());await Promise.resolve();
  assert.deepEqual(events,[['save-start','old draft']]);
  writing.resolve();await Promise.all([old,clearing]);await sync.flush();
  assert.deepEqual(events,[['save-start','old draft'],['save-end'],['clear']]);
});

test('superseded queued saves are skipped and newer edits after a clear remain recoverable',async()=>{
  const first=deferred(),events=[],sync=new DocumentDraftSync({save:async value=>{events.push(value.content);if(value.content==='first')await first.promise;},clear:async()=>events.push('clear')});
  const a=sync.saveNow(file('first'));await Promise.resolve();
  const b=sync.saveNow(file('obsolete')),c=sync.clear(file()),d=sync.saveNow(file('new edit after discard'));
  first.resolve();await Promise.all([a,b,c,d]);await sync.flush();
  assert.deepEqual(events,['first','clear','new edit after discard']);
});

test('flush forces the latest debounced content and waits for the actual backend write',async()=>{
  const clock=timers(),write=deferred(),events=[],sync=new DocumentDraftSync({...clock,save:async value=>{events.push(value.content);await write.promise;},clear:async()=>{}});
  sync.scheduleSave(file('old'));sync.scheduleSave(file('latest'));assert.equal(clock.size,1);
  let completed=false;const flushing=sync.flush().then(()=>completed=true);
  await Promise.resolve();assert.deepEqual(events,['latest']);assert.equal(completed,false);
  write.resolve();await flushing;assert.equal(clock.size,0);assert.equal(completed,true);
});

test('a failed clear remains retryable after the editor became clean',async()=>{
  let calls=0;const sync=new DocumentDraftSync({save:async()=>{},clear:async()=>{if(++calls<3)throw Error('write failed');}});
  await assert.rejects(sync.clear(file()),/write failed/);
  await assert.rejects(sync.flush(),/write failed/);assert.equal(calls,2);
  await sync.flush();assert.equal(calls,3);
  await sync.flush();assert.equal(calls,3);
});

test('a persistent recovery failure refuses close and retains the local unsaved document',async()=>{
  const local=storage(),session=new DocumentSession({file:file('keep this'),dirty:true});
  let prefs=0;const sync=new DocumentDraftSync({save:async()=>{throw Error('recovery disk unavailable');},clear:async()=>{throw Error('recovery disk unavailable');}});
  await assert.rejects(flushClientDrafts({storage:local,documentSession:session,preferences:{drafts:{}},discardDocument:true,persistPreferences:async()=>prefs++,persistDocumentRecovery:async({file,draft})=>{
    await (draft?sync.saveNow(draft.file):sync.clear(file)).catch(()=>{});await sync.flush();
  }}),/recovery disk unavailable/);
  assert.equal(prefs,1);assert.equal(session.recoveryDiscarded,false);
  assert.equal(JSON.parse(local.getItem('dsh-document-draft')).file.content,'keep this');
});

test('close handshake remains pending until recovery and preferences both finish',async()=>{
  const local=storage(),session=new DocumentSession({file:file(),dirty:true}),recovery=deferred(),preferences=deferred();let closed=false,prefsStarted=false;
  const closing=flushClientDrafts({storage:local,documentSession:session,preferences:{},persistDocumentRecovery:()=>recovery.promise,persistPreferences:()=>{prefsStarted=true;return preferences.promise;}}).then(()=>closed=true);
  await Promise.resolve();assert.equal(closed,false);assert.equal(prefsStarted,false);
  recovery.resolve();await Promise.resolve();await Promise.resolve();assert.equal(prefsStarted,true);assert.equal(closed,false);
  preferences.resolve();await closing;assert.equal(closed,true);
});

test('a disposed appearance cannot clear recovery created by a later mount',async()=>{
  const calls=[],sync=new DocumentDraftSync({save:async()=>calls.push('save'),clear:async()=>calls.push('clear')});
  sync.scheduleSave(file());sync.dispose();
  assert.equal(sync.scheduleSave(file('new mount text')),false);
  assert.throws(()=>sync.clear(file()),/DISPOSED/);
  await assert.rejects(sync.flush(),/DISPOSED/);assert.deepEqual(calls,[]);
});

test('a fresh origin chooses the latest known-project recovery and preserves its original save version',()=>{
  const records=[{...file('older'),updatedAt:'2026-10-23T01:00:00.000Z'},{...file('latest','B.md','old-version'),updatedAt:'2026-10-24T01:00:00.000Z'},{...file('foreign'),projectId:'deleted-project',updatedAt:'2026-10-25T01:00:00.000Z'}];
  const row=latestDocumentDraft(records,[{id:'project'}]);assert.equal(row.path,'B.md');
  const recovered=recoveredDocument(file('changed externally','B.md','disk-version'),row),session=new DocumentSession();
  assert.equal(session.completeOpen(session.beginOpen(),recovered.file,{dirty:recovered.dirty}),true);
  assert.equal(session.snapshot().dirty,true);assert.equal(session.snapshot().file.content,'latest');assert.equal(session.snapshot().file.version,'old-version');
});

test('late recovery cannot replace an editor opened or edited while the backend was loading',()=>{
  const session=new DocumentSession(),initial=session.beginOpen();
  session.completeOpen(session.beginOpen(),file('local user choice','B.md'));session.edit('just typed');
  assert.equal(session.completeOpen(initial,file('remote recovery'),{dirty:true}),false);
  assert.equal(session.snapshot().file.path,'B.md');assert.equal(session.snapshot().file.content,'just typed');
  const targeted=session.beginOpen();session.edit('even newer');
  assert.equal(session.completeOpen(targeted,file('late matching recovery','B.md'),{dirty:true}),false);
  assert.equal(session.snapshot().file.content,'even newer');
});

test('a recovery already written to disk opens clean using the current disk version',()=>{
  const disk=file('already saved','A.md','latest-version'),recovered=recoveredDocument(disk,file('already saved','A.md','old-version'));
  assert.deepEqual(recovered,{file:disk,dirty:false,stale:true});
  assert.deepEqual(recoveredDocument(disk,{...file(),path:'another.md'}),{file:disk,dirty:false,stale:false});
});

test('a late failed save superseded by a clear cannot make a later close fail',async()=>{
  const writing=deferred(),sync=new DocumentDraftSync({save:()=>writing.promise,clear:async()=>{}});
  const saved=sync.saveNow(file()).catch(()=>{});await Promise.resolve();const cleared=sync.clear(file());
  writing.reject(Error('old save failed'));await saved;await cleared;await sync.flush();
});

test('QuotaExceeded still saves durable document and preferences, then removes stale local priority caches',async()=>{
  const old={file:file('old cached text')},local=quotaStorage({'dsh-document-draft':JSON.stringify(old),'dsh-drafts':JSON.stringify({chat:'old prompt'}),'dsh-attachment-drafts':JSON.stringify({chat:[{path:'old.md'}]})});
  const session=new DocumentSession({file:file('new document'),dirty:true}),preferences={drafts:{chat:'new prompt'},attachmentDrafts:{chat:[{path:'new.md'}]}};
  let remoteDraft,remotePreferences;
  await flushClientDrafts({storage:local,documentSession:session,preferences,persistDocumentRecovery:async({draft})=>{remoteDraft=structuredClone(draft);},persistPreferences:async value=>{remotePreferences=structuredClone(value);}});
  assert.equal(remoteDraft.file.content,'new document');assert.deepEqual(remotePreferences,preferences);
  assert.equal(local.getItem('dsh-document-draft'),null);assert.equal(local.getItem('dsh-drafts'),null);assert.equal(local.getItem('dsh-attachment-drafts'),null);
  // A later origin/startup has no stale local document or prompt to override the
  // new durable data; it takes the recovery service and stored preferences.
  const bootDraft=JSON.parse(local.getItem('dsh-document-draft')??'null')??remoteDraft;
  const bootPrompts={...remotePreferences.drafts,...JSON.parse(local.getItem('dsh-drafts')??'{}')};
  assert.equal(bootDraft.file.content,'new document');assert.equal(bootPrompts.chat,'new prompt');
});

test('QuotaExceeded plus durable failures refuses close and keeps the current editor and existing local recovery',async()=>{
  const local=quotaStorage({'dsh-document-draft':JSON.stringify({file:file('older fallback')})}),session=new DocumentSession({file:file('current unsaved text'),dirty:true});let preferencesAttempted=false;
  await assert.rejects(flushClientDrafts({storage:local,documentSession:session,preferences:{},persistDocumentRecovery:async()=>{throw Error('recovery offline');},persistPreferences:async()=>{preferencesAttempted=true;throw Error('preferences offline');}}),/recovery offline/);
  assert.equal(preferencesAttempted,true);assert.equal(session.snapshot().dirty,true);assert.equal(session.snapshot().file.content,'current unsaved text');
  assert.equal(JSON.parse(local.getItem('dsh-document-draft')).file.content,'older fallback');
});

test('without a durable document adapter a quota failure cannot silently drop the only document backup',async()=>{
  const local=quotaStorage({'dsh-document-draft':JSON.stringify({file:file('old')})}),session=new DocumentSession({file:file('new unsaved text'),dirty:true});let prefs=0;
  await assert.rejects(flushClientDrafts({storage:local,documentSession:session,preferences:{},persistPreferences:async()=>prefs++}),{name:'QuotaExceededError'});
  assert.equal(prefs,1);assert.equal(session.snapshot().dirty,true);assert.equal(session.snapshot().file.content,'new unsaved text');
  assert.equal(JSON.parse(local.getItem('dsh-document-draft')).file.content,'old');
});

test('background cache failure is controlled and an older durable acknowledgement cannot erase a newer cache intent',()=>{
  const local=quotaStorage({'dsh-document-draft':JSON.stringify({file:file('old local')}) ,'dsh-drafts':'{"chat":"old local"}'}),reported=[];
  const cache=new ClientDraftCache(local,{onError:error=>reported.push(error.name)}),older={drafts:{chat:'older remote'}},newer={drafts:{chat:'newer remote'}};
  assert.equal(cache.persist(older,{file:file('older remote')}).length,3);
  assert.equal(cache.persist(newer,{file:file('newer remote')}).length,3);
  assert.deepEqual(reported,['QuotaExceededError','QuotaExceededError']);
  cache.acknowledgePreferences(older);cache.acknowledgeDocument({file:file('older remote')});
  assert.ok(local.getItem('dsh-document-draft'));assert.ok(local.getItem('dsh-drafts'));
  cache.acknowledgePreferences(newer);cache.acknowledgeDocument({file:file('newer remote')});
  assert.equal(local.getItem('dsh-document-draft'),null);assert.equal(local.getItem('dsh-drafts'),null);
});

test('durable success cannot authorize close if an inaccessible stale local cache still overrides it on startup',async()=>{
  const local=quotaStorage({'dsh-document-draft':JSON.stringify({file:file('old')})},true),session=new DocumentSession({file:file('new'),dirty:true});let written=false;
  await assert.rejects(flushClientDrafts({storage:local,documentSession:session,preferences:{},persistDocumentRecovery:async()=>{written=true;},persistPreferences:async()=>{}}),error=>error.code==='LOCAL_DRAFT_CACHE_FAILED');
  assert.equal(written,true);assert.equal(session.snapshot().dirty,true);assert.equal(session.snapshot().file.content,'new');
});

test('successful legacy local writes preserve their complete document and preference records',async()=>{
  const local=storage(),session=new DocumentSession({file:file('safe local'),dirty:true}),preferences={drafts:{chat:'prompt'},attachmentDrafts:{}};
  await flushClientDrafts({storage:local,documentSession:session,preferences,persistPreferences:async()=>{}});
  assert.equal(JSON.parse(local.getItem('dsh-document-draft')).file.content,'safe local');
  assert.deepEqual(JSON.parse(local.getItem('dsh-drafts')),preferences.drafts);
});

test('background quota failure does not block scheduled durable recovery or leave old cache priority behind',async()=>{
  const local=quotaStorage({'dsh-document-draft':JSON.stringify({file:file('old local')})}),clock=timers(),cache=new ClientDraftCache(local),written=[];
  const sync=new DocumentDraftSync({...clock,save:async payload=>{written.push(payload.content);cache.acknowledgeDocument({file:payload});},clear:async()=>{}});
  const current=file('latest background edit');
  assert.doesNotThrow(()=>cache.persist({},{file:current}));
  assert.equal(sync.scheduleSave(current),true);clock.run();await sync.flush();
  assert.deepEqual(written,['latest background edit']);assert.equal(local.getItem('dsh-document-draft'),null);
});

test('an old empty cache cannot erase a durable new-chat draft during startup',()=>{const saved={'new-none':'durable unsent draft',chat:'saved'},cached={'new-none':'',chat:'offline edit',extra:'offline new chat'};assert.deepEqual(mergeInitialDrafts(saved,cached),{'new-none':'durable unsent draft',chat:'offline edit',extra:'offline new chat'});assert.equal(cached['new-none'],'');});
test('startup preserves durable attachments over empty cache without dropping new offline files',()=>{const saved={chat:[{path:'durable.txt'}]},cached={chat:[],other:[{path:'offline.txt'}]};assert.deepEqual(mergeInitialDrafts(saved,cached),{chat:saved.chat,other:cached.other});});
