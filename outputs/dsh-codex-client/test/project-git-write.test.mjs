import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,symlink,chmod,stat,readdir} from 'node:fs/promises';
import {execFile}from'node:child_process';import {promisify}from'node:util';import os from'node:os';import path from'node:path';
import {ProjectGit}from'../server/project-git.mjs';
const exec=promisify(execFile);const git=(root,...args)=>exec('git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',...args],{cwd:root,env:{...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'},encoding:'utf8'});
async function repo(commit=true){const root=await mkdtemp(path.join(os.tmpdir(),'dsh-git-write-'));await git(root,'init','-q','--initial-branch=main');await git(root,'config','user.name','Fixture');await git(root,'config','user.email','fixture@example.invalid');if(commit){await writeFile(path.join(root,'tracked'),'base\n');await writeFile(path.join(root,'delete'),'base\n');await git(root,'add','.');await git(root,'commit','-qm','base');}return root;}
async function mutate(reader,root,action,data){const state=await reader.status(root);return reader[action](root,{...data,revision:state.revision});}

test('stage/unstage preserve files; commit contains exactly staged bytes, binary and unusual paths',async()=>{
 const root=await repo(),reader=new ProjectGit();try{
  await writeFile(path.join(root,'tracked'),'staged\n');const a=await mutate(reader,root,'stage',{path:'tracked'});assert.equal(a.status.files.find(x=>x.path==='tracked').staged,true);
  await writeFile(path.join(root,'tracked'),'working\n');await writeFile(path.join(root,'not-staged'),'exclude\n');
  const original=await readFile(path.join(root,'tracked'));const committed=await mutate(reader,root,'commit',{message:'only staged',name:'One-time User',email:'one@example.invalid'});
  assert.equal((await git(root,'show','HEAD:tracked')).stdout,'staged\n');assert.deepEqual(await readFile(path.join(root,'tracked')),original);await assert.rejects(git(root,'show','HEAD:not-staged'));assert.equal(committed.commit.oid,(await git(root,'rev-parse','HEAD')).stdout.trim());
  assert.equal((await git(root,'config','user.name')).stdout.trim(),'Fixture');assert.equal((await git(root,'show','-s','--format=%an <%ae>','HEAD')).stdout.trim(),'One-time User <one@example.invalid>');
  for(const name of ['-dash','[literal]','line\nbreak','中文']){await writeFile(path.join(root,name),Buffer.from([0,255,2,10]));await mutate(reader,root,'stage',{path:name});assert.equal((await reader.status(root)).files.find(x=>x.path===name).staged,true);await mutate(reader,root,'unstage',{path:name});assert.equal((await reader.status(root)).files.find(x=>x.path===name).untracked,true);}
  await rm(path.join(root,'delete'));await mutate(reader,root,'stage',{path:'delete'});assert.equal((await reader.status(root)).files.find(x=>x.path==='delete').index,'D');await mutate(reader,root,'unstage',{path:'delete'});await assert.rejects(readFile(path.join(root,'delete')),{code:'ENOENT'});
 }finally{await reader.close();await rm(root,{recursive:true,force:true});}
});
test('stale content and index locks reject without overwriting; concurrent same revision admits only one write',async()=>{
 const root=await repo(),reader=new ProjectGit();try{
  await writeFile(path.join(root,'a'),'one');await writeFile(path.join(root,'b'),'two');let state=await reader.status(root);
  const result=await Promise.allSettled([reader.stage(root,{path:'a',revision:state.revision}),reader.stage(root,{path:'b',revision:state.revision})]);assert.equal(result.filter(x=>x.status==='fulfilled').length,1);assert.equal(result.find(x=>x.status==='rejected').reason.code,'GIT_STALE');
  state=await reader.status(root);await writeFile(path.join(root,'a'),'different');await assert.rejects(reader.stage(root,{path:'a',revision:state.revision}),{code:'GIT_STALE'});
  await writeFile(path.join(root,'.gitignore'),'hidden\n');await writeFile(path.join(root,'hidden'),'ignored');state=await reader.status(root);await assert.rejects(reader.stage(root,{path:'hidden',revision:state.revision}),{code:'GIT_INVALID_PATH'});await assert.rejects(reader.stage(root,{path:'tracked',revision:state.revision}),{code:'GIT_INVALID_PATH'});
  state=await reader.status(root);await writeFile(path.join(root,'.git/index.lock'),'someone else');await assert.rejects(reader.stage(root,{path:'a',revision:state.revision}),{code:'GIT_BUSY'});assert.equal(await readFile(path.join(root,'.git/index.lock'),'utf8'),'someone else');await rm(path.join(root,'.git/index.lock'));
  assert.ok(!(await readdir(path.join(root,'.git'))).some(x=>x.startsWith('dsh-index-')));
 }finally{await reader.close();await rm(root,{recursive:true,force:true});}
});

test('a staged rename is unstaged as a pair without changing either working-tree path',async()=>{
 const root=await repo(),reader=new ProjectGit();try{
  await git(root,'mv','tracked','renamed');await writeFile(path.join(root,'renamed'),'renamed content\n');await mutate(reader,root,'stage',{path:'renamed'});
  const snapshot=await reader.status(root);const rename=snapshot.files.find(x=>x.path==='renamed');
  if(rename.renamed)await reader.unstage(root,{path:'renamed',revision:snapshot.revision});else{await reader.unstage(root,{path:'renamed',revision:snapshot.revision});await mutate(reader,root,'unstage',{path:'tracked'});}
  assert.equal(await readFile(path.join(root,'renamed'),'utf8'),'renamed content\n');await assert.rejects(readFile(path.join(root,'tracked')),{code:'ENOENT'});assert.equal((await git(root,'diff','--cached','--name-only')).stdout,'');
 }finally{await reader.close();await rm(root,{recursive:true,force:true});}
});
test('conversion attributes and config disable writing and never execute filters, hooks or signing',async()=>{
 const root=await repo(),reader=new ProjectGit();try{
  const marker=path.join(root,'should-not-exist'),script=path.join(root,'helper');await writeFile(script,`#!/bin/sh\necho ran > '${marker}'\nexit 1\n`);await chmod(script,0o700);
  await git(root,'config','filter.evil.clean',script);await git(root,'config','filter.evil.process',script);await git(root,'config','core.fsmonitor',script);await git(root,'config','commit.gpgsign','true');await git(root,'config','gpg.program',script);await git(root,'config','core.editor',script);
  for(const hook of ['pre-commit','prepare-commit-msg','commit-msg','post-commit','reference-transaction']){const target=path.join(root,'.git/hooks',hook);await writeFile(target,`#!/bin/sh\necho ran > '${marker}'\nexit 1\n`);await chmod(target,0o700);}
  await writeFile(path.join(root,'.gitattributes'),'tracked filter=evil\n');await writeFile(path.join(root,'tracked'),'changed\n');const state=await reader.status(root);assert.equal(state.writeCapabilities.stage,false);assert.equal(state.writeCapabilities.reasonCode,'GIT_WRITE_TRANSFORM');await assert.rejects(reader.stage(root,{path:'tracked',revision:state.revision}),{code:'GIT_WRITE_TRANSFORM'});
  await rm(path.join(root,'.gitattributes'));await git(root,'config','--unset','filter.evil.process');await git(root,'config','--unset','filter.evil.clean');const before=await readFile(path.join(root,'.git/config'));await mutate(reader,root,'stage',{path:'tracked'});await mutate(reader,root,'commit',{message:'safe plumbing'});assert.deepEqual(await readFile(path.join(root,'.git/config')),before);await assert.rejects(readFile(marker),{code:'ENOENT'});
  await git(root,'config','core.autocrlf','true');assert.equal((await reader.status(root)).writeCapabilities.stage,false);
 }finally{await reader.close();await rm(root,{recursive:true,force:true});}
});
test('unborn unstage and commit work, detached commit is disabled, and symlink/metadata paths are bounded',async()=>{
 const root=await repo(false),reader=new ProjectGit();try{
  await writeFile(path.join(root,'first'),'first\n');await mutate(reader,root,'stage',{path:'first'});await mutate(reader,root,'unstage',{path:'first'});assert.equal((await reader.status(root)).files[0].untracked,true);await mutate(reader,root,'stage',{path:'first'});await mutate(reader,root,'commit',{message:'initial'});
  await symlink('first',path.join(root,'internal-link'));await mutate(reader,root,'stage',{path:'internal-link'});assert.match((await git(root,'ls-files','--stage','--','internal-link')).stdout,/^120000/);
  for(const name of ['../escape','.git/config','/etc/passwd']){const current=await reader.status(root);await assert.rejects(reader.stage(root,{path:name,revision:current.revision}),{code:'GIT_INVALID_PATH'});}
  await git(root,'checkout','--detach','-q');const state=await reader.status(root);assert.equal(state.writeCapabilities.commit,false);await assert.rejects(reader.commit(root,{message:'no',revision:state.revision}),{code:'GIT_DETACHED_COMMIT'});
 }finally{await reader.close();await rm(root,{recursive:true,force:true});}
});

test('commit prepare checks the original branch under native HEAD lock and rejects same-OID branch switches',async()=>{
 const root=await repo(),reader=new ProjectGit();try{
  await git(root,'branch','other');await writeFile(path.join(root,'tracked'),'new\n');await mutate(reader,root,'stage',{path:'tracked'});const state=await reader.status(root),old=(await git(root,'rev-parse','HEAD')).stdout.trim();
  const run=reader._run.bind(reader);let switched=false;reader._run=async(...args)=>{if(args[1][0]==='update-ref'&&!switched){switched=true;await git(root,'symbolic-ref','HEAD','refs/heads/other');}return run(...args);};
  await assert.rejects(reader.commit(root,{message:'wrong branch prevented',revision:state.revision}),{code:'GIT_STALE'});
  assert.equal((await git(root,'rev-parse','main')).stdout.trim(),old);assert.equal((await git(root,'rev-parse','other')).stdout.trim(),old);assert.equal((await git(root,'symbolic-ref','HEAD')).stdout.trim(),'refs/heads/other');
  assert.ok(!(await readdir(path.join(root,'.git'))).some(name=>name==='HEAD.lock'||name==='index.lock'||name.startsWith('dsh-index-')));
 }finally{await reader.close();await rm(root,{recursive:true,force:true});}
});

test('objects aliases, alternates and unsupported Git versions explicitly disable writes',async()=>{
 for(const kind of ['objects-link','alternates','old-version']){
  const root=await repo(),reader=new ProjectGit();try{
   if(kind==='objects-link'){const actual=path.join(root,'object-storage');await exec('mv',[path.join(root,'.git/objects'),actual]);await symlink(actual,path.join(root,'.git/objects'));}
   if(kind==='alternates')await writeFile(path.join(root,'.git/objects/info/alternates'),'/not-used\n');
   if(kind==='old-version'){const run=reader._run.bind(reader);reader._run=(...args)=>args[1][0]==='--version'?Promise.resolve({stdout:Buffer.from('git version 2.20.0\n'),stderr:Buffer.alloc(0),code:0}):run(...args);}
   const state=await reader.status(root);assert.equal(state.writeCapabilities.stage,false);assert.equal(state.writeCapabilities.reasonCode,'GIT_WRITE_UNSUPPORTED');
  }finally{await reader.close();await rm(root,{recursive:true,force:true});}
 }
});

test('cancel and plugin close after real native prepare release HEAD/ref/index locks and all owned activity',async()=>{
 for(const mode of ['cancel','close']){
  const root=await repo(),reader=new ProjectGit(),controller=new AbortController();let release;const gate=new Promise(resolve=>release=resolve);let ready;const prepared=new Promise(resolve=>ready=resolve);
  try{
   await writeFile(path.join(root,'tracked'),'new\n');await mutate(reader,root,'stage',{path:'tracked'});const state=await reader.status(root),old=(await git(root,'rev-parse','HEAD')).stdout.trim();
   const run=reader._run.bind(reader);reader._run=(...args)=>{if(args[4]?.afterPrepare){const original=args[4].afterPrepare;args[4]={...args[4],afterPrepare:async()=>{ready();await gate;return original();}};}return run(...args);};
   const pending=reader.commit(root,{message:'must abort',revision:state.revision,signal:controller.signal}).then(()=>null,error=>error);
   await prepared;assert.equal(reader.operations.size,1);assert.ok([...reader.operations.keys()][0].activityId);assert.ok(reader.children.size>0);
   if(mode==='cancel')controller.abort();else await reader.close();
   const result=await pending;assert.ok(['GIT_WRITE_UNKNOWN','GIT_ABORTED'].includes(result.code));release();await reader.close();
   assert.equal(reader.children.size,0);assert.equal(reader.operations.size,0);assert.equal((await git(root,'rev-parse','HEAD')).stdout.trim(),old);
   assert.ok(!(await readdir(path.join(root,'.git'))).some(name=>name==='HEAD.lock'||name==='index.lock'||name.startsWith('dsh-index-')));
   assert.ok(!(await readdir(path.join(root,'.git/refs/heads'))).some(name=>name.endsWith('.lock')));
  }finally{release();await reader.close();await rm(root,{recursive:true,force:true});}
 }
});
