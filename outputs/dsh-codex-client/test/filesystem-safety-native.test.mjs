import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';import {tmpdir} from 'node:os';import path from 'node:path';
import {fixtureSymlink} from './fixtures/fs-platform.mjs';
import {readProjectFile,writeProjectFile} from '../server/files.mjs';
import {ClientStateStore} from '../server/client-state.mjs';
import {GitDraftStore} from '../server/git-drafts.mjs';
import {DocumentDraftStore} from '../server/document-drafts.mjs';
async function fixture(t){const root=await fs.realpath(await fs.mkdtemp(path.join(tmpdir(),'dsh-fs-native-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}
test('native directory aliases share Unicode byte-version writes and reject an external alias',async t=>{
 const root=await fixture(t),project=path.join(root,'project'),docs=path.join(project,'docs'),outside=path.join(root,'outside');await fs.mkdir(docs,{recursive:true});await fs.mkdir(outside);await fs.writeFile(path.join(docs,'文档.txt'),'\ufeff原始😀\r\n');await fs.writeFile(path.join(outside,'private.txt'),'outside unchanged');
 await fixtureSymlink(docs,path.join(project,'alias'),'dir');await fixtureSymlink(outside,path.join(project,'external'),'dir');
 const base=await readProjectFile(project,'docs/文档.txt');const outcomes=await Promise.allSettled(['docs/文档.txt','alias/文档.txt'].map((name,index)=>writeProjectFile(project,name,'\ufeff新内容'+index+'😀\r\n',base.version)));
 assert.equal(outcomes.filter(row=>row.status==='fulfilled').length,1);assert.match(outcomes.find(row=>row.status==='rejected').reason.message,/FILE_CHANGED/);assert.equal((await readProjectFile(project,'alias/文档.txt')).version,(await readProjectFile(project,'docs/文档.txt')).version);
 await assert.rejects(readProjectFile(project,'external/private.txt'),/OUTSIDE_PROJECT/);assert.equal(await fs.readFile(path.join(outside,'private.txt'),'utf8'),'outside unchanged');
});
for(const kind of ['client','git','document'])test('native hardlink '+kind+' recovery storage fails closed without changing the shared file',async t=>{
 const root=await fixture(t),data=path.join(root,'data'),outside=path.join(root,'outside.json');await fs.mkdir(data);await fs.writeFile(outside,'outside unchanged');
 const name={client:'client.json',git:'git-drafts.json',document:'document-drafts.json'}[kind];await fs.link(outside,path.join(data,name));
 if(kind==='client'){const store=new ClientStateStore({dataDir:data}),state=await store.load();assert.equal(state.recovery.code,'CLIENT_STATE_UNSAFE_PATH');assert.equal(state.recovery.canReset,false);await store.flush();}
 if(kind==='git'){const store=new GitDraftStore({dataDir:data});try{await assert.rejects(store.save({projectId:'p',message:'draft',authorName:'Fixture',authorEmail:'unfinished@',baseVersion:null}),{code:'GIT_DRAFT_STORAGE_UNSAFE'});}finally{await store.close();}}
 if(kind==='document'){const store=new DocumentDraftStore({dataDir:data});await assert.rejects(store.load(),{code:'DOCUMENT_DRAFTS_UNSAFE'});}
 assert.equal(await fs.readFile(outside,'utf8'),'outside unchanged');assert.equal((await fs.stat(outside)).nlink,2);
});
test('controlled file-symlink metadata refusal keeps recovery bytes and refuses reset',async t=>{
 const root=await fixture(t),file=path.join(root,'client.json');await fs.writeFile(file,'untouched original');const native=fs.lstat;
 const mocked=t.mock.method(fs,'lstat',async(target,...options)=>{const info=await native(target,...options);if(target===file)info.isSymbolicLink=()=>true;return info;});syncBuiltinESMExports();
 try{const store=new ClientStateStore({dataDir:root}),state=await store.load();assert.equal(state.recovery.code,'CLIENT_STATE_UNSAFE_PATH');assert.equal(state.recovery.canReset,false);await assert.rejects(store.recover({action:'reset'}),{code:'CLIENT_STATE_RECOVERY_UNAVAILABLE'});assert.equal(await fs.readFile(file,'utf8'),'untouched original');}
 finally{mocked.mock.restore();syncBuiltinESMExports();}
});
