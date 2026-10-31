import test from 'node:test';
import assert from 'node:assert/strict';
import {GitDraftCoordinator} from '../src/lib/git-draft-sync.js';
import {GitController} from '../src/lib/git-controller.js';
const fields=message=>({message,authorName:'Fixture Author',authorEmail:'fixture@example.invalid'});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const error=code=>Object.assign(new Error(code),{code});
function fixture({read,write,maxEntries=64}={}){
  const data=new Map(),calls=[],timers=new Map();let version=0,sequence=0;
  const coordinator=new GitDraftCoordinator({maxEntries,delay:350,setTimer:fn=>{const id=++sequence;timers.set(id,fn);return id;},clearTimer:id=>timers.delete(id),request:async route=>{const id=new URLSearchParams(route.split('?')[1]).get('projectId');calls.push({kind:'read',id});if(read)return read(id);return {draft:data.get(id)??null};},mutateRequest:async(route,body)=>{calls.push({kind:route.split('/')[1],...body});if(write)return write(route,body);const old=data.get(body.projectId);if((old?.version??null)!==body.baseVersion)throw error('GIT_DRAFT_CHANGED');if(route.endsWith('/clear'))return {cleared:data.delete(body.projectId)};const draft={projectId:body.projectId,...fields(body.message),authorName:body.authorName,authorEmail:body.authorEmail,version:'version-'+(++version),updatedAt:new Date().toISOString()};data.set(body.projectId,draft);return {draft};}});
  return {coordinator,data,calls,timers};
}

test('private drafts restore only the requested project, with no identity storage in browser APIs',async()=>{
  const f=fixture();f.data.set('A',{projectId:'A',...fields('A only'),version:'v-A'});f.data.set('B',{projectId:'B',...fields('B only'),version:'v-B'});
  await f.coordinator.load('A');assert.equal(f.coordinator.snapshot('A').value.message,'A only');assert.equal(f.coordinator.snapshot('B').value,null);assert.deepEqual(f.calls,[{kind:'read',id:'A'}]);
});
test('a late restore supplies its CAS version without replacing newly typed text',async()=>{
  const gate=deferred(),f=fixture({read:()=>gate.promise});const loading=f.coordinator.load('A');await turn();f.coordinator.update('A',fields('typed during restore'));
  gate.resolve({draft:{projectId:'A',...fields('old saved'),version:'remote-version'}});await loading;
  assert.equal(f.coordinator.snapshot('A').value.message,'typed during restore');assert.equal(f.coordinator.snapshot('A').version,'remote-version');assert.equal(f.coordinator.snapshot('A').dirty,true);
  // Use a read-only probe, and cancel the pending debounce without writing.
  f.coordinator.clearTimer(f.coordinator.entries.get('A').timer);
});
test('concurrent saves are serialized and a newer revision cannot be acknowledged by an older response',async()=>{
  const first=deferred(),calls=[];let count=0;
  const f=fixture({write:async(route,body)=>{calls.push({...body});if(++count===1)await first.promise;return {draft:{...body,version:'v'+count}};}});
  await f.coordinator.load('A');f.coordinator.update('A',fields('first'));const flush=f.coordinator.flush();await turn();f.coordinator.update('A',fields('second'));const other=f.coordinator.flush();assert.equal(calls.length,1);
  first.resolve();await Promise.all([flush,other]);assert.deepEqual(calls.map(c=>[c.message,c.baseVersion]),[['first',null],['second','v1']]);assert.equal(f.coordinator.snapshot('A').value.message,'second');assert.equal(f.coordinator.snapshot('A').dirty,false);assert.equal(f.timers.size,0);
});
test('unmount saves remain globally tracked, failures reject close flush and explicit retry can recover',async()=>{
  let offline=true;const f=fixture({write:async(route,body)=>{if(offline)throw error('GIT_DRAFT_UNAVAILABLE');return {draft:{...body,version:'v1'}};}});
  const states=[],stopState=f.coordinator.subscribeState(state=>states.push(state));const release=f.coordinator.subscribe('A',()=>{});await f.coordinator.load('A');f.coordinator.update('A',fields('must survive panel close'));release();await turn();
  assert.equal(f.timers.size,0);await assert.rejects(f.coordinator.flush(),{code:'GIT_DRAFT_UNAVAILABLE'});assert.equal(f.coordinator.snapshot('A').value.message,'must survive panel close');assert.equal(states.at(-1).errorCode,'GIT_DRAFT_UNAVAILABLE');assert.ok(!JSON.stringify(states).includes('fixture@example.invalid'));
  offline=false;await f.coordinator.flush();assert.equal(f.coordinator.snapshot('A').dirty,false);assert.equal(f.coordinator.state().errorCode,null);stopState();
});
test('CAS conflict never retries with a newly fetched version until the user explicitly replaces local input',async()=>{
  const f=fixture();await f.coordinator.load('A');f.coordinator.update('A',fields('local'));f.data.set('A',{projectId:'A',...fields('other writer'),version:'other'});
  await assert.rejects(f.coordinator.flush(),{code:'GIT_DRAFT_CHANGED'});const writes=f.calls.filter(c=>c.kind==='save').length;await assert.rejects(f.coordinator.flush(),{code:'GIT_DRAFT_CHANGED'});assert.equal(f.calls.filter(c=>c.kind==='save').length,writes);assert.equal(f.coordinator.snapshot('A').value.message,'local');assert.equal(f.data.get('A').message,'other writer');
  await f.coordinator.reload('A');assert.equal(f.coordinator.snapshot('A').value.message,'other writer');assert.equal(f.coordinator.snapshot('A').dirty,false);
});
test('a corrupt store permits editing but never attempts a destructive save and close flush fails',async()=>{
  const f=fixture({read:async()=>{throw error('GIT_DRAFT_CORRUPT');}});await assert.rejects(f.coordinator.load('A'),{code:'GIT_DRAFT_CORRUPT'});f.coordinator.update('A',fields('recoverable new input'));
  await assert.rejects(f.coordinator.flush(),{code:'GIT_DRAFT_CORRUPT'});assert.equal(f.coordinator.snapshot('A').value.message,'recoverable new input');assert.equal(f.calls.filter(c=>c.kind==='save').length,0);
});
test('commit cleanup cannot clear newer input, and clear followed by editing serializes with a null base',async()=>{
  const clearGate=deferred(),calls=[];const f=fixture({write:async(route,body)=>{calls.push({route,...body});if(route.endsWith('/clear')){await clearGate.promise;return {cleared:true};}return {draft:{...body,version:'v-new'}};}});
  await f.coordinator.load('A');f.coordinator.update('A',fields('committed'));await f.coordinator.flush();f.coordinator.update('A',fields('new before cleanup'));assert.equal(f.coordinator.clearMatching('A',fields('committed')),false);await f.coordinator.flush();
  assert.equal(f.coordinator.clearMatching('A',fields('new before cleanup')),true);await turn();f.coordinator.update('A',fields('typed while clearing'));const flushing=f.coordinator.flush();clearGate.resolve();await flushing;
  assert.equal(calls.at(-1).baseVersion,null);assert.equal(calls.at(-1).message,'typed while clearing');assert.equal(f.coordinator.snapshot('A').value.message,'typed while clearing');assert.equal(f.coordinator.snapshot('A').dirty,false);
});
test('a queued clear is superseded before sending and cannot erase edits after an old in-flight save',async()=>{
  const saveGate=deferred(),calls=[];let first=true;const f=fixture({write:async(route,body)=>{calls.push({route,...body});if(first){first=false;await saveGate.promise;}return {draft:{...body,version:'v'+calls.length}};}});
  await f.coordinator.load('A');f.coordinator.update('A',fields('committed'));const flushing=f.coordinator.flush();await turn();f.coordinator.clearMatching('A',fields('committed'));f.coordinator.update('A',fields('keep newest'));saveGate.resolve();await flushing;await f.coordinator.flush();assert.equal(calls.filter(c=>c.route.endsWith('/clear')).length,0);assert.equal(calls.at(-1).message,'keep newest');
});
test('bounded cache reclaims only clean detached entries and never evicts a dirty draft',async()=>{
  const f=fixture({maxEntries:2});await f.coordinator.load('A');f.coordinator.update('A',fields('unsaved'));await f.coordinator.load('B');await f.coordinator.load('C');assert.equal(f.coordinator.entries.has('A'),true);assert.equal(f.coordinator.entries.has('B'),false);assert.equal(f.coordinator.entries.size,2);await f.coordinator.flush();
});
test('real controller keeps project recovery and new edits isolated when its panel is disposed',async()=>{
  const f=fixture(),status={files:[],revision:'git-revision',identity:{name:'Config Author',email:'config@example.invalid'},writeCapabilities:{stage:true,unstage:true,commit:true}};
  f.data.set('A',{projectId:'A',...fields('restored A'),version:'v-A'});
  const controller=new GitController({draftCoordinator:f.coordinator,draftCache:new Map(),request:async()=>status});controller.select('A');await f.coordinator.load('A');assert.equal(controller.snapshot().message,'restored A');await controller.refresh();assert.equal(controller.snapshot().authorName,'Fixture Author');controller.setDraft({message:'edited A'});controller.select('B');await f.coordinator.load('B');assert.equal(controller.snapshot().message,'');controller.setDraft({message:'edited B'});controller.dispose();await f.coordinator.flush();assert.equal(f.data.get('A').message,'edited A');assert.equal(f.data.get('B').message,'edited B');assert.equal(f.timers.size,0);
});

test('an acknowledged real-controller commit clears the exact raw draft even though commit fields are trimmed',async()=>{
  const f=fixture(),status={files:[{path:'staged.md',staged:true,index:'M'}],revision:'git-revision',identity:{name:'Config Author',email:'config@example.invalid'},writeCapabilities:{stage:true,unstage:true,commit:true}},post=[];
  const controller=new GitController({draftCoordinator:f.coordinator,draftCache:new Map(),request:async route=>route.endsWith('/status')?status:{diff:'+file'},mutateRequest:async(route,body)=>{post.push(body);return {status:{...status,revision:'git-after'},commit:{oid:'a'.repeat(40),shortOid:'aaaaaaaa',subject:'Fix'}};}});
  controller.select('A');await f.coordinator.load('A');await controller.refresh();controller.setDraft({message:'  Fix\n',authorName:' Fixture Author ',authorEmail:' fixture@example.invalid '});await f.coordinator.flush();assert.equal(f.data.get('A').message,'  Fix\n');
  assert.equal(await controller.reviewCommit(),true);assert.equal(await controller.commitReviewed(),true);await f.coordinator.flush();assert.equal(post[0].message,'Fix');assert.equal(f.data.has('A'),false);assert.equal(controller.snapshot().message,'');controller.dispose();await f.coordinator.flush();
});

test('new edits made while a real-controller commit is pending remain persistent after acknowledgement',async()=>{
  const f=fixture(),gate=deferred(),status={files:[{path:'staged.md',staged:true,index:'M'}],revision:'git-revision',identity:{name:'Fixture Author',email:'fixture@example.invalid'},writeCapabilities:{stage:true,unstage:true,commit:true}};
  const controller=new GitController({draftCoordinator:f.coordinator,draftCache:new Map(),request:async route=>route.endsWith('/status')?status:{diff:'+file'},mutateRequest:()=>gate.promise});controller.select('A');await f.coordinator.load('A');await controller.refresh();controller.setDraft({message:'committed'});await f.coordinator.flush();await controller.reviewCommit();const committing=controller.commitReviewed();controller.setDraft({message:'next change'});gate.resolve({status:{...status,revision:'git-after'},commit:{oid:'b'.repeat(40)}});assert.equal(await committing,true);await f.coordinator.flush();assert.equal(controller.snapshot().message,'next change');assert.equal(f.data.get('A').message,'next change');controller.dispose();await f.coordinator.flush();
});

test('viewing a corrupt store alone reports the error but does not block closing or retry reads in flush',async()=>{
  const f=fixture({read:async()=>{throw error('GIT_DRAFT_CORRUPT');}});await assert.rejects(f.coordinator.load('A'),{code:'GIT_DRAFT_CORRUPT'});const reads=f.calls.length;assert.equal(f.coordinator.state().needsProtection,false);assert.equal(f.coordinator.state().errorCode,'GIT_DRAFT_CORRUPT');await f.coordinator.flush();assert.equal(f.calls.length,reads);f.coordinator.update('A',fields('now there is local input'));assert.equal(f.coordinator.state().needsProtection,true);await assert.rejects(f.coordinator.flush(),{code:'GIT_DRAFT_CORRUPT'});
});

test('restored incomplete author fields and captured draft identity are not silently replaced by status refresh',async()=>{
  const f=fixture();f.data.set('A',{projectId:'A',message:'unfinished draft',authorName:'',authorEmail:'',version:'v-A'});
  let identity={name:'Config One',email:'one@example.invalid'};const controller=new GitController({draftCoordinator:f.coordinator,draftCache:new Map(),request:async()=>({files:[],revision:'git-r',identity,writeCapabilities:{stage:true,unstage:true,commit:true}})});controller.select('A');await f.coordinator.load('A');await controller.refresh();assert.equal(controller.snapshot().authorName,'');assert.equal(controller.snapshot().authorEmail,'');controller.setDraft({authorName:'Chosen',authorEmail:'chosen@example.invalid'});identity={name:'Config Two',email:'two@example.invalid'};await controller.refresh();assert.equal(controller.snapshot().authorName,'Chosen');await f.coordinator.flush();assert.equal(f.data.get('A').authorName,'Chosen');controller.dispose();await f.coordinator.flush();
});
