import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { SessionStore } from '../lib/session-store.js';
import { CodexEngine } from '../lib/engine.js';
test('concurrent session commits preserve every mapping after recovery',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'dsh-mappings-'));
  try{
    const file=path.join(root,'sessions.json');const store=new SessionStore(file);
    await Promise.all(Array.from({length:25},(_,index)=>store.upsert({sessionId:String(index),threadId:'thread-'+index,cwd:root,updatedAt:new Date().toISOString()})));
    const recovered=new SessionStore(file);await recovered.load();
    assert.equal(recovered.list().length,25);
    for(let i=0;i<25;i++)assert.equal(recovered.get(String(i)).threadId,'thread-'+i);
  }finally{await rm(root,{recursive:true,force:true});}
});
test('corrupt persisted state is rejected repeatedly and never replaced with an empty store',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'dsh-corrupt-'));
  try{const file=path.join(root,'sessions.json');await writeFile(file,'broken');const store=new SessionStore(file);await assert.rejects(store.load());await assert.rejects(store.upsert({sessionId:'new',threadId:'new',cwd:root}));assert.equal(await readFile(file,'utf8'),'broken');}
  finally{await rm(root,{recursive:true,force:true});}
});
test('a symlink alias of the original Codex home is refused before initialization',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'dsh-home-alias-'));
  try{await symlink(path.join(homedir(),'.codex'),path.join(root,'alias'));assert.throws(()=>new CodexEngine({dataDir:path.join(root,'alias')}),error=>error.code==='UNSAFE_CODEX_HOME');}
  finally{await rm(root,{recursive:true,force:true});}
});
