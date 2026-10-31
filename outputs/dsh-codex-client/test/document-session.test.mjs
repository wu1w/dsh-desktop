import test from 'node:test';
import assert from 'node:assert/strict';
import {DocumentSession} from '../src/lib/document-session.js';
import {persistClientDrafts,flushClientDrafts} from '../src/lib/client-drafts.js';

const file=(path,content='original',version='v1',projectId='project')=>({path,name:path,content,version,projectId});
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function memoryStorage(){const values=new Map();return {getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};}

test('a delayed open cannot replace edits typed into the current document while it loads',async()=>{
  const session=new DocumentSession({file:file('B.md')});
  const response=deferred(),token=session.beginOpen();
  const opening=response.promise.then(result=>session.completeOpen(token,result));
  session.edit('unsaved B typed after the request');
  response.resolve(file('A.md','A content'));
  assert.equal(await opening,false);
  assert.equal(session.snapshot().file.path,'B.md');
  assert.equal(session.snapshot().file.content,'unsaved B typed after the request');
  assert.equal(session.snapshot().dirty,true);
});

test('out-of-order opens keep the last requested file, and close invalidates a pending response',async()=>{
  const session=new DocumentSession({file:file('B.md')});
  const first=deferred(),second=deferred();
  const firstToken=session.beginOpen(),firstOpen=first.promise.then(value=>session.completeOpen(firstToken,value));
  const secondToken=session.beginOpen(),secondOpen=second.promise.then(value=>session.completeOpen(secondToken,value));
  second.resolve(file('C.md'));assert.equal(await secondOpen,true);
  first.resolve(file('A.md'));assert.equal(await firstOpen,false);
  assert.equal(session.snapshot().file.path,'C.md');
  const afterClose=session.beginOpen();session.close();
  assert.equal(session.completeOpen(afterClose,file('D.md')),false);
  assert.equal(session.snapshot().file,null);
});

test('a save response for a closed document never overwrites the subsequently opened document',async()=>{
  const session=new DocumentSession({file:file('B.md'),dirty:true});
  const {token}=session.beginSave(),response=deferred();
  const saving=response.promise.then(value=>session.completeSave(token,value));
  session.close();assert.equal(session.completeOpen(session.beginOpen(),file('A.md','A untouched')),true);
  response.resolve(file('B.md','original','v2'));
  assert.deepEqual(await saving,{accepted:true,applied:false});
  assert.equal(session.snapshot().file.path,'A.md');
  assert.equal(session.snapshot().file.content,'A untouched');
  assert.equal(session.snapshot().dirty,false);
  assert.equal(session.snapshot().saving,false);
});

test('reopening the same path creates a new document generation immune to an earlier save',()=>{
  const session=new DocumentSession({file:file('same.md'),dirty:true});
  const {token}=session.beginSave();
  session.close();session.completeOpen(session.beginOpen(),file('same.md','reopened content','v3'));
  assert.deepEqual(session.completeSave(token,file('same.md','original','v2')),{accepted:true,applied:false});
  assert.equal(session.snapshot().file.content,'reopened content');
  assert.equal(session.snapshot().file.version,'v3');
  assert.equal(session.snapshot().dirty,false);
});

test('a save completing after another edit preserves that edit while advancing its optimistic version',()=>{
  const session=new DocumentSession({file:file('A.md')});session.edit('saved text');
  const {token}=session.beginSave();assert.equal(session.beginSave().status,'busy');
  session.edit('newer unsaved text');
  assert.deepEqual(session.completeSave(token,file('A.md','saved text','v2')),{accepted:true,applied:true,clean:false});
  assert.equal(session.snapshot().file.content,'newer unsaved text');
  assert.equal(session.snapshot().file.version,'v2');
  assert.equal(session.snapshot().dirty,true);
  assert.equal(session.snapshot().saving,false);
  const next=session.beginSave();assert.equal(next.token.file.content,'newer unsaved text');
  assert.equal(session.failSave(next.token),true);assert.equal(session.snapshot().dirty,true);
});

test('an external modification between the write and reread cannot replace the user editor',()=>{
  const session=new DocumentSession({file:file('A.md')});session.edit('my edit');
  const {token}=session.beginSave();
  assert.deepEqual(session.completeSave(token,file('A.md','external writer content','v3')),{accepted:true,applied:false,conflict:true});
  assert.equal(session.snapshot().file.content,'my edit');
  assert.equal(session.snapshot().file.version,'v1');
  assert.equal(session.snapshot().dirty,true);
  assert.equal(session.snapshot().saving,false);
});

test('successful save is clean and a stale completion cannot release a later save lock',()=>{
  const session=new DocumentSession({file:file('A.md'),dirty:true});
  const first=session.beginSave();assert.equal(first.status,'saving');
  assert.equal(session.completeSave(first.token,file('A.md','original','v2')).clean,true);
  assert.equal(session.beginSave().status,'clean');
  session.edit('next');const second=session.beginSave();
  assert.equal(session.failSave(first.token),false);assert.equal(session.snapshot().saving,true);
  assert.equal(session.completeSave(first.token,file('A.md','original','v2')).accepted,false);
  assert.equal(session.snapshot().saving,true);
  session.failSave(second.token);assert.equal(session.snapshot().saving,false);
});

test('discard-before-reload preserves chat and attachment drafts but cannot restore the discarded document',async()=>{
  const storage=memoryStorage(),session=new DocumentSession({file:file('A.md','discard me'),dirty:true});
  const preferences={drafts:{chat:'keep my prompt'},attachmentDrafts:{chat:[{path:'README.md',name:'README.md',mime:''}]}};
  persistClientDrafts(storage,preferences,session.recoveryDraft());
  assert.ok(storage.getItem('dsh-document-draft'));
  const written=[];
  await flushClientDrafts({storage,documentSession:session,preferences,discardDocument:true,persistPreferences:async value=>written.push(value)});
  // Appearance cleanup may flush again before the reload destroys React.
  await flushClientDrafts({storage,documentSession:session,preferences,persistPreferences:async()=>{}});
  assert.equal(storage.getItem('dsh-document-draft'),null);
  assert.deepEqual(JSON.parse(storage.getItem('dsh-drafts')),preferences.drafts);
  assert.deepEqual(JSON.parse(storage.getItem('dsh-attachment-drafts')),preferences.attachmentDrafts);
  assert.equal(written.length,1);
  const recovered=JSON.parse(storage.getItem('dsh-document-draft')??'null');
  assert.equal(new DocumentSession({file:recovered?.file??null,dirty:Boolean(recovered)}).snapshot().file,null);
});

test('a rejected close restores unsaved document recovery so the live editor remains safe',async()=>{
  const storage=memoryStorage(),session=new DocumentSession({file:file('A.md','still mine'),dirty:true});
  const preferences={drafts:{chat:'prompt'},attachmentDrafts:{}};
  await assert.rejects(flushClientDrafts({storage,documentSession:session,preferences,discardDocument:true,persistPreferences:async()=>{throw Error('disk failed');}}),/disk failed/);
  assert.equal(session.recoveryDiscarded,false);
  assert.equal(JSON.parse(storage.getItem('dsh-document-draft')).file.content,'still mine');
  assert.equal(session.snapshot().dirty,true);
  await flushClientDrafts({storage,documentSession:session,preferences,persistPreferences:async()=>{}});
  assert.equal(JSON.parse(storage.getItem('dsh-document-draft')).file.content,'still mine');
});
