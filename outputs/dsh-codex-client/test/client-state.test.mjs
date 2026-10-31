import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,writeFile,readFile,stat,readdir,rm,symlink,mkdir,chmod} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ClientStateStore} from '../server/client-state.mjs';

const sample=()=>({version:1,projects:[{id:'project',path:'/tmp/project',name:'Project'}],sessions:[{id:'chat',projectId:'project',threadId:'native-thread',title:'Chat',archived:false}],preferences:{selected:'chat',projectId:'project',drafts:{'new-none':'draft'}},models:[{id:'deepseek-v4.1-flash',name:'DeepSeek'}],notifications:[{id:'notice',sessionId:'chat',title:'Done',status:'completed',createdAt:'2026-10-24T00:00:00.000Z'}],extension:{preserved:true}});
async function setup(){const dir=await realpath(await mkdtemp(path.join(os.tmpdir(),'dsh-client-state-')));return {dir,store:new ClientStateStore({dataDir:dir}),file:path.join(dir,'client.json'),backup:path.join(dir,'client.backup.json')};}
async function clean(dir){await rm(dir,{recursive:true,force:true});}

test('valid startup preserves exact bytes/mtime and compatible old defaults and extensions',async()=>{
  const {dir,store,file}=await setup();try{
    const state=sample();delete state.models;delete state.preferences;delete state.notifications;
    const bytes=Buffer.from(JSON.stringify(state));await writeFile(file,bytes);const before=await stat(file);
    const loaded=await store.load();assert.equal(loaded.recovery,null);assert.deepEqual(loaded.state.preferences,{});assert.equal(loaded.state.models[0].id,'deepseek-v4.1-flash');assert.deepEqual(loaded.state.extension,{preserved:true});
    assert.deepEqual(await readFile(file),bytes);assert.equal((await stat(file)).mtimeMs,before.mtimeMs);
    await store.save(loaded.state);assert.deepEqual(await readFile(file),bytes);assert.equal((await stat(file)).mtimeMs,before.mtimeMs);assert.deepEqual(await readdir(dir),['client.json']);
  }finally{await clean(dir);}
});

test('save snapshots immediately, serializes fsynced atomic writes and backs up only a changed valid predecessor',async()=>{
  const {dir,store,file,backup}=await setup();try{
    const state=sample();await store.load();const first=store.save(state);state.extension.preserved='second';const second=store.save(state);state.extension.preserved='not-saved';await Promise.all([first,second]);await store.flush();
    assert.equal(JSON.parse(await readFile(file,'utf8')).extension.preserved,'second');assert.equal(JSON.parse(await readFile(backup,'utf8')).extension.preserved,true);
    for(const target of [file,backup])assert.equal((await stat(target)).mode&0o777,0o600);
    const backupBefore=await stat(backup);const current=await store.load();await store.save(current.state);assert.equal((await stat(backup)).mtimeMs,backupBefore.mtimeMs);
    assert.ok((await readdir(dir)).every(name=>!name.endsWith('.tmp')));
  }finally{await clean(dir);}
});

test('bad JSON, UTF8 and schema enter read-only recovery and never replace the original or poison the backup',async()=>{
  for(const bytes of [Buffer.from('{bad'),Buffer.from([0xc3,0x28]),Buffer.from(JSON.stringify({version:1,projects:[],sessions:null})),Buffer.from(JSON.stringify({...sample(),preferences:null}))]){
    const {dir,store,file,backup}=await setup();try{
      await writeFile(file,bytes);const good=Buffer.from(JSON.stringify(sample()));await writeFile(backup,good);const before=await stat(file);
      const loaded=await store.load();assert.equal(loaded.recovery.code,'CLIENT_STATE_INVALID');assert.equal(loaded.recovery.canReset,true);assert.deepEqual(loaded.recovery.candidates.map(row=>[row.id,row.projects,row.sessions]),[['last-good',1,1]]);
      assert.deepEqual(loaded.state.sessions,[]);await assert.rejects(store.save(sample()),{code:'CLIENT_STATE_RECOVERY_REQUIRED'});
      assert.deepEqual(await readFile(file),bytes);assert.equal((await stat(file)).mtimeMs,before.mtimeMs);assert.deepEqual(await readFile(backup),good);
    }finally{await clean(dir);}
  }
});

test('explicit restore and reset archive exact corrupt bytes privately before writing validated state',async()=>{
  for(const action of ['restore','reset']){
    const {dir,store,file,backup}=await setup();try{
      const bad=Buffer.from([0xff,0x00,0x7b,0x62]);await writeFile(file,bad);const good=Buffer.from(JSON.stringify(sample()));await writeFile(backup,good);await store.load();
      const restored=await store.recover({action,candidateId:'last-good'});assert.match(restored.archive,/^client-corrupt-[\w.-]+\.json$/);
      assert.deepEqual(await readFile(path.join(dir,restored.archive)),bad);assert.equal((await stat(path.join(dir,restored.archive))).mode&0o777,0o600);assert.equal((await stat(file)).mode&0o777,0o600);
      assert.equal(restored.state.sessions.length,action==='restore'?1:0);assert.equal((await store.load()).recovery,null);
      if(action==='restore')assert.deepEqual(await readFile(file),good);
    }finally{await clean(dir);}
  }
});

test('main and displayed backup fingerprint changes block recovery before archiving',async()=>{
  for(const changed of ['main','backup']){
    const {dir,store,file,backup}=await setup();try{
      await writeFile(file,'bad');await writeFile(backup,JSON.stringify(sample()));await store.load();
      await writeFile(changed==='main'?file:backup,changed==='main'?'changed corrupt bytes':JSON.stringify({...sample(),extension:{changed:true}}));
      await assert.rejects(store.recover({action:'restore',candidateId:'last-good'}),{code:'CLIENT_STATE_CHANGED'});
      await store.flush();
      assert.ok(!(await readdir(dir)).some(name=>name.startsWith('client-corrupt-')));await assert.rejects(store.save(sample()),{code:'CLIENT_STATE_RECOVERY_REQUIRED'});
    }finally{await clean(dir);}
  }
});

test('unsafe symlinks, directories and oversized files fail closed without touching external content',async()=>{
  for(const kind of ['main-link','backup-link','parent-link','directory','oversized']){
    const {dir,file,backup}=await setup();const outside=await setup();try{
      await writeFile(outside.file,'external unchanged');let dataDir=dir;
      if(kind==='main-link')await symlink(outside.file,file);
      if(kind==='backup-link'){await writeFile(file,'bad');await symlink(outside.file,backup);}
      if(kind==='parent-link'){dataDir=path.join(dir,'alias');await symlink(outside.dir,dataDir);}
      if(kind==='directory')await mkdir(file);
      if(kind==='oversized')await writeFile(file,Buffer.alloc(8*1024*1024+1,0x20));
      const store=new ClientStateStore({dataDir});const loaded=await store.load();assert.equal(loaded.recovery.canReset,false);assert.equal(loaded.recovery.code,kind==='oversized'?'CLIENT_STATE_TOO_LARGE':'CLIENT_STATE_UNSAFE_PATH');
      await assert.rejects(store.recover({action:'reset'}),{code:'CLIENT_STATE_RECOVERY_UNAVAILABLE'});await store.flush();assert.equal(await readFile(outside.file,'utf8'),'external unchanged');
    }finally{await clean(dir);await clean(outside.dir);}
  }
});

test('failed main commit keeps corrupt source and recovery active; invalid backups are not candidates',async()=>{
  const {dir,store,file,backup}=await setup();try{
    const bad=Buffer.from('corrupt-original');await writeFile(file,bad);await writeFile(backup,'invalid backup');const loaded=await store.load();assert.deepEqual(loaded.recovery.candidates,[]);
    await assert.rejects(store.recover({action:'restore',candidateId:'last-good'}),{code:'CLIENT_STATE_RECOVERY_UNAVAILABLE'});
    const atomic=store._atomic;store._atomic=async()=>{throw Object.assign(Error('simulated ENOSPC'),{code:'ENOSPC'});};
    await assert.rejects(store.recover({action:'reset'}),{code:'CLIENT_STATE_IO'});assert.deepEqual(await readFile(file),bad);await assert.rejects(store.save(sample()),{code:'CLIENT_STATE_RECOVERY_REQUIRED'});
    const archives=(await readdir(dir)).filter(name=>name.startsWith('client-corrupt-'));assert.equal(archives.length,1);assert.deepEqual(await readFile(path.join(dir,archives[0])),bad);
    store._atomic=atomic;const result=await store.recover({action:'reset'});assert.deepEqual(result.state.sessions,[]);
  }finally{await clean(dir);}
});

test('schema rejects ID/reference and known-field corruption while allowing absent old fields and unknown engines',async()=>{
  const invalid=[s=>s.projects.push({...s.projects[0]}),s=>s.sessions[0].projectId='missing',s=>s.sessions[0].parentSessionId='chat',s=>s.sessions[0].threadId=null,s=>s.models={},s=>s.preferences.drafts=[],s=>s.notifications[0].sessionId='missing',s=>s.notifications[0].createdAt='bad-date',s=>delete s.notifications[0].createdAt,s=>s.preferences.locale='not a locale!',s=>s.preferences.selected='missing',s=>s.preferences.attachmentDrafts={chat:[{path:'../outside',name:'x',mime:'text/plain'}]},s=>s.sessions[0].archived='false',s=>s.projects[0].path='relative',s=>{let node=s.extension;for(let i=0;i<102;i++)node=node.deep={};}];
  const {dir,store}=await setup();try{
    await store.load();for(const change of invalid){const value=sample();change(value);await assert.rejects(store.save(value),{code:'CLIENT_STATE_INVALID'});}
    const old=sample();delete old.sessions[0].model;delete old.sessions[0].kind;old.sessions[0].engineId='external-engine-provider';await store.save(old);assert.equal((await store.load()).state.sessions[0].engineId,'external-engine-provider');
  }finally{await clean(dir);}
});

test('real filesystem write failure preserves the valid original and does not poison subsequent saves',{skip:process.getuid?.()===0},async()=>{
  const {dir,store,file,backup}=await setup();try{
    const bytes=Buffer.from(JSON.stringify(sample()));await writeFile(file,bytes);const state=(await store.load()).state;state.extension.changed=true;
    await chmod(dir,0o500);await assert.rejects(store.save(state),{code:'CLIENT_STATE_IO'});await store.flush();await chmod(dir,0o700);
    assert.deepEqual(await readFile(file),bytes);assert.ok(!(await readdir(dir)).some(name=>name.endsWith('.tmp')));
    await store.save(state);await store.flush();assert.deepEqual(await readFile(backup),bytes);assert.equal(JSON.parse(await readFile(file,'utf8')).extension.changed,true);
  }finally{await chmod(dir,0o700);await clean(dir);}
});

test('actual task-owned old client seeds remain readable without rewriting their copied bytes',async()=>{
  const workspace=path.resolve(import.meta.dirname,'../../..');
  for(const name of ['dsh-client-live-home','dsh-frontend-qa-home','dsh-history-http-1792777401234/legacy']){
    const source=path.join(workspace,'work',name,'client.json');let bytes;try{bytes=await readFile(source);}catch(error){if(error.code==='ENOENT')continue;throw error;}
    const {dir,store,file}=await setup();try{await writeFile(file,bytes);const loaded=await store.load();assert.equal(loaded.recovery,null,name);assert.deepEqual(await readFile(file),bytes);}finally{await clean(dir);}
  }
});
