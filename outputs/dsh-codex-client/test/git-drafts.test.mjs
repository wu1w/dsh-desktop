import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,realpath,writeFile,readFile,rm,stat,symlink,link,chmod,readdir,rename,mkdir}from'node:fs/promises';import os from'node:os';import path from'node:path';import {spawn}from'node:child_process';import {fileURLToPath}from'node:url';
import {GitDraftStore}from'../server/git-drafts.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
async function setup(){const dir=await realpath(await mkdtemp(path.join(os.tmpdir(),'dsh-git-draft-')));return {dir,store:new GitDraftStore({dataDir:dir}),file:path.join(dir,'git-drafts.json')};}
const value=(projectId='project',baseVersion=null,message='commit input')=>({projectId,message,authorName:'Draft Author',authorEmail:'unfinished@',baseVersion});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn){for(let i=0;i<200;i++){try{const v=await fn();if(v)return v;}catch{}await pause(10);}assert.fail('condition timeout');}

test('immediate input snapshot, fresh non-ABA versions and stale clear preserve independent project drafts',async()=>{
 const {dir,store,file}=await setup();try{
  assert.equal(await store.get('project'),null);assert.deepEqual(await store.clear({projectId:'project',baseVersion:null}),{cleared:false});
  const input=value(),pending=store.save(input);input.message='mutated after call';const first=await pending;assert.equal(first.message,'commit input');assert.equal((await stat(file)).mode&0o777,0o600);
  const next=await store.save(value('project',first.version,'newer'));assert.notEqual(next.version,first.version);
  await assert.rejects(store.save(value('project',first.version)),{code:'GIT_DRAFT_CHANGED'});await assert.rejects(store.clear({projectId:'project',baseVersion:first.version}),{code:'GIT_DRAFT_CHANGED'});
  const other=await store.save(value('other'));await store.clear({projectId:'project',baseVersion:next.version});assert.equal(await store.get('project'),null);assert.equal((await store.get('other')).version,other.version);
  const again=await store.save(value());assert.notEqual(again.version,first.version);await store.close();await assert.rejects(store.get('project'),{code:'GIT_DRAFT_CLOSED'});
 }finally{await store.close();await rm(dir,{recursive:true,force:true});}
});

test('two writers serialize CAS and preserve unrelated drafts without stale in-memory overwrites',async()=>{
 const {dir,store}=await setup(),second=new GitDraftStore({dataDir:dir});try{
  const outcomes=await Promise.allSettled([store.save(value()),second.save(value('project',null,'other writer'))]);assert.equal(outcomes.filter(v=>v.status==='fulfilled').length,1);assert.equal(outcomes.find(v=>v.status==='rejected').reason.code,'GIT_DRAFT_CHANGED');
  await Promise.all([store.save(value('a')),second.save(value('b'))]);assert.equal((await store.get('a')).message,'commit input');assert.equal((await second.get('b')).message,'commit input');
  const current=await store.get('project');await second.save(value('project',current.version,'new version'));await assert.rejects(store.clear({projectId:'project',baseVersion:current.version}),{code:'GIT_DRAFT_CHANGED'});
 }finally{await store.close();await second.close();await rm(dir,{recursive:true,force:true});}
});

test('bad UTF8, JSON and strict schema are preserved and cannot be overwritten',async()=>{
 for(const bytes of [Buffer.from([0xc3,0x28]),Buffer.from('bad json'),Buffer.from('{"version":1,"drafts":[{}]}'),Buffer.from('{"version":1,"drafts":[],"extra":true}')]){
  const {dir,store,file}=await setup();try{await writeFile(file,bytes);const before=await stat(file);await assert.rejects(store.get('project'),{code:'GIT_DRAFT_CORRUPT'});await assert.rejects(store.save(value()),{code:'GIT_DRAFT_CORRUPT'});await assert.rejects(store.clear({projectId:'project',baseVersion:null}),{code:'GIT_DRAFT_CORRUPT'});assert.deepEqual(await readFile(file),bytes);assert.equal((await stat(file)).mtimeMs,before.mtimeMs);}finally{await store.close();await rm(dir,{recursive:true,force:true});}
 }
});

test('symlink and hardlink destinations fail closed without changing outside bytes',async()=>{
 for(const kind of ['symlink','hardlink','parent','lock']){
  const {dir,store,file}=await setup();const outside=await setup();let active=store;try{
   await writeFile(outside.file,'outside unchanged');
   if(kind==='symlink')await symlink(outside.file,file);if(kind==='hardlink')await link(outside.file,file);
   if(kind==='parent'){const alias=path.join(dir,'alias');await symlink(outside.dir,alias);active=new GitDraftStore({dataDir:alias});}
   if(kind==='lock')await symlink(outside.dir,path.join(dir,'.git-drafts.lock'));
   await assert.rejects(active.save(value()),{code:'GIT_DRAFT_STORAGE_UNSAFE'});assert.equal(await readFile(outside.file,'utf8'),'outside unchanged');
  }finally{await active.close();await store.close();await outside.store.close();await rm(dir,{recursive:true,force:true});await rm(outside.dir,{recursive:true,force:true});}
 }
});

test('byte, row and file capacity limits reject safely',async()=>{
 const {dir,store,file}=await setup();try{
  await assert.rejects(store.save(value('project',null,'中'.repeat(22000))),{code:'GIT_DRAFT_LIMIT'});await assert.rejects(store.save({...value(),message:'\ud800'}),{code:'GIT_DRAFT_INVALID'});
  for(let i=0;i<64;i++)await store.save(value('p'+i));const before=await readFile(file);await assert.rejects(store.save(value('overflow')),{code:'GIT_DRAFT_LIMIT'});assert.deepEqual(await readFile(file),before);
  await writeFile(file,Buffer.alloc(8*1024*1024+1));await assert.rejects(store.get('p0'),{code:'GIT_DRAFT_LIMIT'});
 }finally{await store.close();await rm(dir,{recursive:true,force:true});}
});

test('external replacement during atomic write rejects and removes only own temporary files',async()=>{
 const {dir,store,file}=await setup();try{
  const first=await store.save(value());const original=store._persist.bind(store);let once=true;
  store._persist=async(...args)=>{if(once){once=false;const rows=JSON.parse(await readFile(file,'utf8'));rows.drafts[0].message='external data';await writeFile(file,JSON.stringify(rows));}return original(...args);};
  await assert.rejects(store.save(value('project',first.version,'should not replace')),{code:'GIT_DRAFT_CHANGED'});assert.equal(JSON.parse(await readFile(file,'utf8')).drafts[0].message,'external data');assert.ok(!(await readdir(dir)).some(name=>name.endsWith('.tmp')));
 }finally{await store.close();await rm(dir,{recursive:true,force:true});}
});

test('lost write-lock identity refuses publication and never removes another lock directory',async()=>{
 const {dir,store,file}=await setup();try{
  const first=await store.save(value()),bytes=await readFile(file),lock=path.join(dir,'.git-drafts.lock'),displaced=lock+'.displaced',persist=store._persist.bind(store);
  store._persist=async(...args)=>{await rename(lock,displaced);await mkdir(lock);return persist(...args);};
  await assert.rejects(store.save(value('project',first.version,'must not publish')),{code:'GIT_DRAFT_CHANGED'});assert.deepEqual(await readFile(file),bytes);assert.equal((await stat(lock)).isDirectory(),true);assert.ok(!(await readdir(dir)).some(name=>name.endsWith('.tmp')));
 }finally{await store.close();await rm(dir,{recursive:true,force:true});}
});

test('filesystem failure retains saved data and close waits for an admitted write',{skip:process.getuid?.()===0},async()=>{
 const {dir,store,file}=await setup();try{
  const first=await store.save(value()),bytes=await readFile(file);await chmod(dir,0o500);await assert.rejects(store.save(value('project',first.version,'lost')),{code:'GIT_DRAFT_WRITE_FAILED'});await chmod(dir,0o700);assert.deepEqual(await readFile(file),bytes);
  let release;const gate=new Promise(resolve=>release=resolve),original=store._persist.bind(store);store._persist=async(...args)=>{await gate;return original(...args);};const pending=store.save(value('project',first.version,'admitted'));let closed=false;const closing=store.close().then(()=>closed=true);await pause(20);assert.equal(closed,false);release();await pending;await closing;
  const reopened=new GitDraftStore({dataDir:dir});assert.equal((await reopened.get('project')).message,'admitted');await reopened.close();
 }finally{await chmod(dir,0o700);await store.close();await rm(dir,{recursive:true,force:true});}
});

test('SIGKILL after acknowledged save survives with exact draft and private file',async()=>{
 const {dir,store}=await setup();let child;try{
  const source=`import{GitDraftStore}from ${JSON.stringify(path.join(root,'server/git-drafts.mjs'))};const s=new GitDraftStore({dataDir:${JSON.stringify(dir)}});const row=await s.save(${JSON.stringify(value())});process.stdout.write(JSON.stringify(row)+'\\n');setInterval(()=>{},1000);`;
  child=spawn(process.execPath,['--input-type=module','-e',source],{stdio:['ignore','pipe','pipe']});let stdout='';child.stdout.on('data',b=>stdout+=b.toString());const saved=await until(()=>stdout.includes('\n')?JSON.parse(stdout.trim()):null);child.kill('SIGKILL');await new Promise(resolve=>child.once('close',resolve));assert.deepEqual(await store.get('project'),saved);
 }finally{child?.kill('SIGKILL');await store.close();await rm(dir,{recursive:true,force:true});}
});

test('two actual processes cannot both save the same base version',async()=>{
 const {dir,store}=await setup(),children=[];
 try{
  const worker=()=>{
   const source=`import{GitDraftStore}from ${JSON.stringify(path.join(root,'server/git-drafts.mjs'))};const s=new GitDraftStore({dataDir:${JSON.stringify(dir)}});process.on('message',async()=>{try{process.send({row:await s.save(${JSON.stringify(value())})});}catch(e){process.send({code:e.code});}finally{await s.close();process.disconnect();}});process.send({ready:true});`;
   const child=spawn(process.execPath,['--input-type=module','-e',source],{env:{PATH:process.env.PATH,HOME:process.env.HOME},stdio:['ignore','ignore','pipe','ipc']});children.push(child);
   let ready;const started=new Promise(resolve=>ready=resolve);const result=new Promise(resolve=>child.on('message',data=>data.ready?ready():resolve(data)));return {child,started,result};
  };
  const one=worker(),two=worker();await Promise.all([one.started,two.started]);one.child.send({go:true});two.child.send({go:true});const results=await Promise.all([one.result,two.result]);assert.equal(results.filter(row=>row.row).length,1);assert.equal(results.find(row=>row.code).code,'GIT_DRAFT_CHANGED');assert.equal((await store.get('project')).version,results.find(row=>row.row).row.version);
  await Promise.all(children.map(child=>child.exitCode!==null?null:new Promise(resolve=>child.once('close',resolve))));
 }finally{children.forEach(child=>child.kill('SIGKILL'));await store.close();await rm(dir,{recursive:true,force:true});}
});
