import test from'node:test';import assert from'node:assert/strict';import{mkdtemp,mkdir,readFile,writeFile,rm,realpath}from'node:fs/promises';import{tmpdir}from'node:os';import path from'node:path';import{pathToFileURL,fileURLToPath}from'node:url';import{execFile,spawn}from'node:child_process';import{promisify}from'node:util';
const appRoot=process.env.DSH_ACCEPTANCE_APP_ROOT;
const {startHost}=await import(appRoot?pathToFileURL(path.join(appRoot,'server/index.mjs')):new URL('../server/index.mjs',import.meta.url));
const run=promisify(execFile);
async function client(host){const response=await fetch(host.url+'/api/bootstrap'),boot=await response.json(),headers={cookie:response.headers.get('set-cookie').split(';')[0],'x-dsh-capability':boot.capability,'content-type':'application/json','accept-language':'en'};return {boot,api:async(route,body)=>{const response=await fetch(host.url+'/api/'+route,{headers,method:body===undefined?'GET':'POST',body:body===undefined?undefined:JSON.stringify(body)});return{httpStatus:response.status,...await response.json()};}};}
async function setup(){const directory=await realpath(await mkdtemp(path.join(tmpdir(),'dsh-git-draft-api-'))),dataDir=path.join(directory,'data'),project=path.join(directory,'project');await mkdir(project);await run('git',['-c','core.hooksPath=/dev/null','init','-q'],{cwd:project});return {directory,dataDir,project};}

test('actual HTTP draft survives a different host port and does not enter Git or client preferences',async()=>{
 const {directory,dataDir,project}=await setup();let host;
 try{
  host=await startHost({dataDir,autoStart:false});let c=await client(host);const added=await c.api('projects',{path:project}),projectId=added.id;
  assert.equal((await c.api('git-drafts?projectId='+projectId)).draft,null);
  const row=(await c.api('git-drafts/save',{projectId,message:'commit text 中文',authorName:'one author',authorEmail:'partial@',baseVersion:null})).draft;assert.ok(row.version);
  const beforePort=new URL(host.url).port;await host.close();host=null;
  host=await startHost({dataDir,autoStart:false});c=await client(host);assert.notEqual(new URL(host.url).port,beforePort);assert.deepEqual((await c.api('git-drafts?projectId='+projectId)).draft,row);
  const persisted=JSON.parse(await readFile(path.join(dataDir,'client.json'),'utf8'));assert.ok(!JSON.stringify(persisted).includes('commit text'));await assert.rejects(readFile(path.join(project,'.git/git-drafts.json')),{code:'ENOENT'});
  const newer=(await c.api('git-drafts/save',{projectId,message:'newer',authorName:'',authorEmail:'',baseVersion:row.version})).draft;
  assert.equal((await c.api('git-drafts/clear',{projectId,baseVersion:row.version})).code,'GIT_DRAFT_CHANGED');assert.equal((await c.api('git-drafts?projectId='+projectId)).draft.version,newer.version);
  assert.equal((await c.api('git-drafts/clear',{projectId,baseVersion:newer.version})).cleared,true);assert.equal((await c.api('git-drafts/clear',{projectId,baseVersion:null})).cleared,false);
 }finally{await host?.close();await rm(directory,{recursive:true,force:true});}
});

test('Cordis disable and re-enable preserve acknowledged draft without restarting Git processes',async()=>{
 const {directory,dataDir,project}=await setup();let host;
 try{
  host=await startHost({dataDir,autoStart:false});const c=await client(host),projectId=(await c.api('projects',{path:project})).id;
  const draft=(await c.api('git-drafts/save',{projectId,message:'preserved during disable',authorName:'',authorEmail:'',baseVersion:null})).draft;
  const file=path.join(dataDir,'git-drafts.json'),bytes=await readFile(file);assert.equal((await c.api('plugins/feature-git/disable',{})).httpStatus,200);
  assert.equal((await c.api('git-drafts?projectId='+projectId)).httpStatus,404);assert.deepEqual(await readFile(file),bytes);
  assert.equal((await c.api('plugins/feature-git/enable',{})).httpStatus,200);assert.deepEqual((await c.api('git-drafts?projectId='+projectId)).draft,draft);assert.equal(host.engine,undefined);
 }finally{await host?.close();await rm(directory,{recursive:true,force:true});}
});

test('corrupt draft storage affects only drafts; Git review still works and unknown projects are refused',async()=>{
 const {directory,dataDir,project}=await setup();let host;
 try{
  host=await startHost({dataDir,autoStart:false});const c=await client(host),projectId=(await c.api('projects',{path:project})).id;
  const file=path.join(dataDir,'git-drafts.json'),bytes=Buffer.from([0xff,0x7b]);await writeFile(file,bytes);
  assert.equal((await c.api('git-drafts?projectId='+projectId)).code,'GIT_DRAFT_CORRUPT');assert.equal((await c.api('git-drafts/save',{projectId,message:'not overwrite',authorName:'',authorEmail:'',baseVersion:null})).code,'GIT_DRAFT_CORRUPT');
  const git=await c.api('projects/'+projectId+'/git/status');assert.equal(git.httpStatus,200);assert.ok(Array.isArray(git.files));assert.deepEqual(await readFile(file),bytes);
  assert.equal((await c.api('git-drafts?projectId=unknown')).code,'NOT_FOUND');assert.equal((await c.api('git-drafts/clear',{projectId:'unknown',baseVersion:null})).code,'NOT_FOUND');assert.equal((await c.api('git-drafts?projectId='+projectId+'&projectId='+projectId)).code,'GIT_DRAFT_INVALID');
 }finally{await host?.close();await rm(directory,{recursive:true,force:true});}
});

test('acknowledged HTTP draft survives host SIGKILL and native data-lock stale recovery',{timeout:45000},async()=>{
 const {directory,dataDir,project}=await setup();let child,host;
 try{
  const entry=appRoot?path.join(appRoot,'server/index.mjs'):fileURLToPath(new URL('../server/index.mjs',import.meta.url));
  const source=`import{startHost}from ${JSON.stringify(entry)};const h=await startHost({dataDir:${JSON.stringify(dataDir)},autoStart:false});process.stdout.write(h.url+'\\n');`;
  child=spawn(process.execPath,['--input-type=module','-e',source],{env:{PATH:process.env.PATH,HOME:process.env.HOME},stdio:['ignore','pipe','pipe']});let stdout='';child.stdout.on('data',bytes=>stdout+=bytes.toString());
  for(let i=0;i<200&&!stdout.includes('\n');i++)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(stdout.includes('\n'));
  const c=await client({url:stdout.trim()}),projectId=(await c.api('projects',{path:project})).id;
  const draft=(await c.api('git-drafts/save',{projectId,message:'survive full host kill',authorName:'author',authorEmail:'',baseVersion:null})).draft;assert.ok(draft.version);
  child.kill('SIGKILL');await new Promise(resolve=>child.once('close',resolve));
  const deadline=Date.now()+35000;while(!host&&Date.now()<deadline){try{host=await startHost({dataDir,autoStart:false});}catch(error){if(error.code!=='DATA_IN_USE')throw error;await new Promise(resolve=>setTimeout(resolve,250));}}
  assert.ok(host,'native data lock did not expire within its documented bound');const reopened=await client(host);assert.deepEqual((await reopened.api('git-drafts?projectId='+projectId)).draft,draft);
 }finally{child?.kill('SIGKILL');await host?.close();await rm(directory,{recursive:true,force:true});}
});
