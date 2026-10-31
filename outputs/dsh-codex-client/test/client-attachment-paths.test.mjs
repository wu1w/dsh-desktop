import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,realpath,rm,stat,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const appRoot=process.env.DSH_ACCEPTANCE_APP_ROOT;
const fromApp=relative=>appRoot?pathToFileURL(path.join(appRoot,relative)):new URL('../'+relative,import.meta.url);
const {ClientStateStore,validAttachmentDraftPath,validAttachmentDrafts}=await import(fromApp('server/client-state.mjs'));
const {startHost}=await import(fromApp('server/index.mjs'));
const attachment=(relative,extra={})=>({path:relative,name:'attachment',mime:'text/plain',...extra});
const sample=attachmentDrafts=>({version:1,projects:[],sessions:[],preferences:{theme:'light',attachmentDrafts},notifications:[],models:[{id:'deepseek-v4.1-flash',name:'DeepSeek V4.1 Flash'}]});
const exactAscii='a'.repeat(4096),exactUnicode='中'.repeat(1365)+'x';
const platformLiteralPaths=path.sep==='/'?['notes\\..\\outside.md','C:\\drafts\\notes.md','C:chapter.md','..\\parent.md','folder\\..\\story.md','folder/child\\..\\notes.md']:['folder\\child.md'];
const validPaths=['plain.md','folder//child.md','./folder/notes.md','folder/..hidden.md',...platformLiteralPaths,exactAscii,exactUnicode];
const invalidPaths=['','/outside.md','../outside.md','folder/../outside.md','folder/..','folder//..//outside.md','file\0name.md','\0','a'.repeat(4097),'中'.repeat(1366),...(path.sep==='\\'?['C:\\outside.md','\\\\server\\share\\outside.md','..\\outside.md','folder\\..\\outside.md']:[])];
const malformedDrafts=[null,[],{chat:{}},{chat:[null]},{chat:[[]]},{chat:Array.from({length:51},()=>attachment('safe.md'))},{chat:[attachment('safe.md',{name:'x'.repeat(257)})]},{chat:[attachment('safe.md',{name:'bad\0name'})]},{chat:[attachment('safe.md',{mime:'x'.repeat(129)})]},{chat:[attachment('safe.md',{mime:'bad\0mime'})]}];
async function temporary(action){const root=await realpath(await mkdtemp(path.join(tmpdir(),'dsh-client-attachment-paths-')));try{await action(root);}finally{await rm(root,{recursive:true,force:true});}}
async function client(host){const response=await fetch(host.url+'/api/bootstrap'),boot=await response.json(),headers={cookie:response.headers.get('set-cookie').split(';')[0],'x-dsh-capability':boot.capability,'content-type':'application/json','accept-language':'en'};return {boot,api:async(route,body)=>{const response=await fetch(host.url+'/api/'+route,{headers,method:body===undefined?'GET':'POST',body:body===undefined?undefined:JSON.stringify(body)});return {httpStatus:response.status,...await response.json()};}};}

test('attachment draft paths use native separators, preserve literal POSIX names and enforce the UTF-8 byte boundary',()=>{
  assert.equal(Buffer.byteLength(exactAscii),4096);assert.equal(Buffer.byteLength(exactUnicode),4096);
  for(const relative of validPaths)assert.equal(validAttachmentDraftPath(relative),true,JSON.stringify(relative.slice(0,100)));
  for(const relative of invalidPaths)assert.equal(validAttachmentDraftPath(relative),false,JSON.stringify(relative.slice(0,100)));
  for(const value of [null,undefined,4,{},[]])assert.equal(validAttachmentDraftPath(value),false);
  assert.equal(validAttachmentDrafts({'new-none':validPaths.map(relative=>attachment(relative))}),true);
  assert.equal(validAttachmentDrafts({'new-none':[attachment('safe.md',{name:'n'.repeat(256),mime:'m'.repeat(128)}),attachment('empty-display-fields.md',{name:'',mime:''})]}),true);
  for(const drafts of malformedDrafts)assert.equal(validAttachmentDrafts(drafts),false);
});

test('real ClientStateStore snapshots and restarts preserve allowed attachment paths without normalization',async()=>temporary(async root=>{
  const dataDir=path.join(root,'data'),store=new ClientStateStore({dataDir});await store.load();
  const entries=validPaths.map(relative=>attachment(relative)),expected={'new-none':structuredClone(entries)},state=sample({'new-none':entries});
  const saving=store.save(state);state.preferences.attachmentDrafts['new-none'][0].path='mutation-after-snapshot.md';await saving;await store.flush();
  const file=path.join(dataDir,'client.json'),bytes=await readFile(file);assert.deepEqual(JSON.parse(bytes).preferences.attachmentDrafts,expected);assert.equal((await stat(file)).mode&0o777,0o600);
  const restarted=new ClientStateStore({dataDir}),loaded=await restarted.load();assert.equal(loaded.recovery,null);assert.deepEqual(loaded.state.preferences.attachmentDrafts,expected);await restarted.save(loaded.state);assert.deepEqual(await readFile(file),bytes);
  assert.ok(!(await readdir(dataDir)).some(name=>name.endsWith('.tmp')));
}));

test('invalid attachment snapshots preserve the last valid bytes and remain restartable',async()=>temporary(async root=>{
  const dataDir=path.join(root,'data'),store=new ClientStateStore({dataDir});await store.load();const state=sample({'new-none':[attachment(platformLiteralPaths[0])]});await store.save(state);
  const file=path.join(dataDir,'client.json'),before=await readFile(file),beforeInfo=await stat(file);
  for(const drafts of [...invalidPaths.map(relative=>({'new-none':[attachment(relative)]})),...malformedDrafts]){
    const changed={...state,preferences:{...state.preferences,theme:'dark',attachmentDrafts:drafts}};
    await assert.rejects(store.save(changed),{code:'CLIENT_STATE_INVALID'});await store.flush();assert.deepEqual(await readFile(file),before);assert.equal((await stat(file)).mtimeMs,beforeInfo.mtimeMs);
  }
  const restarted=new ClientStateStore({dataDir}),loaded=await restarted.load();assert.equal(loaded.recovery,null);assert.deepEqual(loaded.state.preferences,state.preferences);assert.ok(!(await readdir(dataDir)).some(name=>name.endsWith('.tmp')));
}));

test('real preference API saves native literal paths and 4096-byte paths and restores them after restart',async()=>temporary(async root=>{
  const dataDir=path.join(root,'data'),projectPath=path.join(root,'project');await mkdir(projectPath);let host;
  try{
    host=await startHost({dataDir,autoStart:false});let {api}=await client(host);const project=await api('projects',{path:projectPath});assert.equal(project.httpStatus,200);
    const drafts={[`new-${project.id}`]:validPaths.map(relative=>attachment(relative))};drafts[`new-${project.id}`].push(attachment('empty-display.md',{name:'',mime:''}),attachment('max-display.md',{name:'n'.repeat(256),mime:'m'.repeat(128)}));
    const result=await api('preferences',{theme:'light',attachmentDrafts:drafts});assert.equal(result.httpStatus,200);assert.equal(result.ok,true);assert.deepEqual((await api('state')).preferences.attachmentDrafts,drafts);
    const file=path.join(dataDir,'client.json'),before=await readFile(file);assert.deepEqual(JSON.parse(before).preferences.attachmentDrafts,drafts);
    if(path.sep==='/'){
      const relative='notes\\..\\outside.md';await writeFile(path.join(projectPath,relative),'literal POSIX filename remains inside the test project');
      const opened=await api(`projects/${project.id}/file?path=${encodeURIComponent(relative)}`);assert.equal(opened.httpStatus,200);assert.equal(opened.path,relative);assert.equal(opened.content,'literal POSIX filename remains inside the test project');
    }
    await host.close();host=null;host=await startHost({dataDir,autoStart:false});const restarted=await client(host);api=restarted.api;assert.equal(restarted.boot.state.recovery,null);assert.equal(restarted.boot.state.engine.state,'stopped');assert.deepEqual(restarted.boot.state.preferences.attachmentDrafts,drafts);assert.deepEqual(await readFile(file),before);
    const unrelated=await api('preferences',{theme:'dark'});assert.equal(unrelated.httpStatus,200);assert.equal((await api('state')).preferences.theme,'dark');assert.deepEqual((await api('state')).preferences.attachmentDrafts,drafts);
  }finally{await host?.close();}
}));

test('bad attachment preferences reject the whole HTTP request without changing disk, backup or live preferences',async()=>temporary(async root=>{
  const dataDir=path.join(root,'data');let host;
  try{
    host=await startHost({dataDir,autoStart:false});let {api}=await client(host);const good={'new-none':[attachment(platformLiteralPaths[0])]};assert.equal((await api('preferences',{theme:'light',attachmentDrafts:good})).httpStatus,200);assert.equal((await api('preferences',{locale:'en'})).httpStatus,200);
    const file=path.join(dataDir,'client.json'),backup=path.join(dataDir,'client.backup.json'),before=await readFile(file),backupBefore=await readFile(backup),beforeInfo=await stat(file),preferences=structuredClone((await api('state')).preferences);
    for(const drafts of [...invalidPaths.map(relative=>({'new-none':[attachment(relative)]})),...malformedDrafts]){
      const rejected=await api('preferences',{theme:'dark',attachmentDrafts:drafts});assert.equal(rejected.httpStatus,400);assert.equal(rejected.code,'INVALID_REQUEST');assert.deepEqual(await readFile(file),before);assert.deepEqual(await readFile(backup),backupBefore);assert.equal((await stat(file)).mtimeMs,beforeInfo.mtimeMs);assert.deepEqual((await api('state')).preferences,preferences);
    }
    await host.close();host=null;host=await startHost({dataDir,autoStart:false});const restarted=await client(host);api=restarted.api;assert.equal(restarted.boot.state.recovery,null);assert.deepEqual(restarted.boot.state.preferences,preferences);assert.deepEqual(await readFile(file),before);
    assert.equal((await api('preferences',{theme:'dark'})).httpStatus,200);assert.deepEqual((await api('state')).preferences.attachmentDrafts,good);
  }finally{await host?.close();}
}));
