import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,stat,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const appRoot=process.env.DSH_ACCEPTANCE_APP_ROOT;
const {startHost}=await import(appRoot?pathToFileURL(path.join(appRoot,'server/index.mjs')):new URL('../server/index.mjs',import.meta.url));
async function client(host){const response=await fetch(host.url+'/api/bootstrap'),boot=await response.json(),headers={cookie:response.headers.get('set-cookie').split(';')[0],'x-dsh-capability':boot.capability,'content-type':'application/json','accept-language':'en'};return{boot,api:async(route,body)=>{const response=await fetch(host.url+'/api/'+route,{headers,method:body===undefined?'GET':'POST',body:body===undefined?undefined:JSON.stringify(body)});return{httpStatus:response.status,...await response.json()};}};}

test('corrupt startup serves an actionable shell, blocks execution, and only a deliberate reset archives original bytes',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'dsh-client-recovery-api-')),dataDir=path.join(directory,'data');let host;
  try{
    await mkdir(dataDir);const original=Buffer.from('{INVALID_PRIVATE_CONTENT');const file=path.join(dataDir,'client.json');await writeFile(file,original,{mode:0o600});const before=await stat(file);await mkdir(path.join(dataDir,'engine'));await writeFile(path.join(dataDir,'engine','preserved'),'ENGINE_HISTORY_SENTINEL');
    let keyCalls=0;host=await startHost({dataDir,autoStart:false,engineOptions:{resolveApiKey:async()=>{keyCalls++;throw Error('MUST_NOT_RESOLVE_DURING_RECOVERY');}}});
    const{boot,api}=await client(host);assert.equal(boot.state.recovery.code,'CLIENT_STATE_INVALID');assert.equal(boot.state.appearance,null);assert.equal(boot.state.plugins.length,0);assert.equal(boot.state.engine.state,'stopped');assert.equal(keyCalls,0);assert.ok(!JSON.stringify(boot).includes('INVALID_PRIVATE_CONTENT'));
    assert.equal((await stat(file)).mtimeMs,before.mtimeMs);assert.deepEqual(await readFile(file),original);assert.equal((await api('projects',{path:directory})).code,'CLIENT_STATE_RECOVERY_REQUIRED');assert.equal((await api('engine/enable',{})).code,'CLIENT_STATE_RECOVERY_REQUIRED');assert.equal((await api('plugins/install',{path:directory})).code,'CLIENT_STATE_RECOVERY_REQUIRED');
    assert.equal((await fetch(host.url+'/recovery-view.js')).status,200);const reset=await api('recovery',{action:'reset'});assert.equal(reset.httpStatus,200);assert.equal(reset.recovery,null);assert.equal(path.basename(reset.archive),reset.archive);assert.deepEqual(await readFile(path.join(dataDir,reset.archive)),original);assert.equal((await stat(path.join(dataDir,reset.archive))).mode&0o777,0o600);assert.equal((await readFile(path.join(dataDir,'engine','preserved'),'utf8')),'ENGINE_HISTORY_SENTINEL');assert.equal(keyCalls,0);
    const live=await api('state');assert.equal(live.recovery,null);assert.equal(live.plugins.filter(plugin=>plugin.active).length,20);assert.equal(live.sessions.length,0);assert.equal((await api('projects',{path:directory})).httpStatus,200);assert.equal((await api('preferences',{selected:'nonexistent-chat'})).code,'INVALID_REQUEST');
    await host.close();host=await startHost({dataDir,autoStart:false});assert.equal(host.state().recovery,null);assert.equal(host.state().projects.length,1);
  }finally{await host?.close();await rm(directory,{recursive:true,force:true});}
});

test('restoring the displayed valid backup preserves the exact damaged file and engine data',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'dsh-client-restore-api-')),dataDir=path.join(directory,'data');let host;
  try{
    const one=path.join(directory,'one'),two=path.join(directory,'two');await mkdir(one);await mkdir(two);
    host=await startHost({dataDir,autoStart:false});let{api}=await client(host);await api('projects',{path:one});await api('projects',{path:two});await host.close();host=null;
    const backup=await readFile(path.join(dataDir,'client.backup.json'));assert.equal(JSON.parse(backup).projects.length,1);const damaged=Buffer.from([0xff,0xfe,0x00,0x23]);await writeFile(path.join(dataDir,'client.json'),damaged);
    host=await startHost({dataDir,autoStart:false});const connection=await client(host);api=connection.api;assert.equal(connection.boot.state.recovery.candidates[0].projects,1);
    assert.equal((await api('recovery',{action:'restore',candidateId:'../outside'})).code,'CLIENT_STATE_RECOVERY_UNAVAILABLE');assert.deepEqual(await readFile(path.join(dataDir,'client.json')),damaged);
    const restored=await api('recovery',{action:'restore',candidateId:'last-good'});assert.equal(restored.httpStatus,200);assert.equal(restored.state.projects.length,1);assert.deepEqual(await readFile(path.join(dataDir,restored.archive)),damaged);assert.deepEqual(await readFile(path.join(dataDir,'client.json')),backup);
  }finally{await host?.close();await rm(directory,{recursive:true,force:true});}
});

test('unsafe state symlinks remain untouched and cannot be reset through the recovery API',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'dsh-client-unsafe-api-')),dataDir=path.join(directory,'data');let host;
  try{
    await mkdir(dataDir);const outside=path.join(directory,'outside.json');await writeFile(outside,'OUTSIDE_UNCHANGED');await symlink(outside,path.join(dataDir,'client.json'));host=await startHost({dataDir,autoStart:false});const{boot,api}=await client(host);assert.equal(boot.state.recovery.canReset,false);assert.equal(boot.state.recovery.code,'CLIENT_STATE_UNSAFE_PATH');assert.equal((await api('recovery',{action:'reset'})).code,'CLIENT_STATE_RECOVERY_UNAVAILABLE');assert.equal(await readFile(outside,'utf8'),'OUTSIDE_UNCHANGED');
  }finally{await host?.close();await rm(directory,{recursive:true,force:true});}
});
test('reread accepts a deliberately repaired index while stale destructive recovery is rejected',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'dsh-client-reread-api-')),dataDir=path.join(directory,'data');let host;
  try{
    await mkdir(dataDir);const file=path.join(dataDir,'client.json');await writeFile(file,'BROKEN');host=await startHost({dataDir,autoStart:false});const{api}=await client(host);
    const repaired='{"version":1,"projects":[],"sessions":[],"customExtension":{"preserved":true},"__proto__":{"preservedProtoKey":true}}';await writeFile(file,repaired);assert.equal((await api('recovery',{action:'reset'})).code,'CLIENT_STATE_CHANGED');assert.equal(await readFile(file,'utf8'),repaired);
    const read=await api('recovery',{action:'retry'});assert.equal(read.httpStatus,200);assert.equal(read.recovery,null);assert.equal(read.state.plugins.filter(plugin=>plugin.active).length,20);assert.equal(await readFile(file,'utf8'),repaired);await api('preferences',{locale:'en'});const stored=JSON.parse(await readFile(file,'utf8'));assert.equal(Object.hasOwn(stored,'__proto__'),true);assert.equal(stored.__proto__.preservedProtoKey,true);
  }finally{await host?.close();await rm(directory,{recursive:true,force:true});}
});
test('recovering an index never overwrites other invalid settings after partial initialization fails',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'dsh-client-partial-recovery-')),dataDir=path.join(directory,'data');let host;
  try{
    await mkdir(dataDir);await writeFile(path.join(dataDir,'client.json'),'BROKEN_CLIENT');const plugins=path.join(dataDir,'plugins.json');await writeFile(plugins,'BROKEN_PLUGIN_SETTINGS');host=await startHost({dataDir,autoStart:false});const{api}=await client(host);
    const reset=await api('recovery',{action:'reset'});assert.equal(reset.httpStatus,200);assert.equal(reset.recovery,null);assert.equal(reset.state.startupBlocked,true);assert.equal(reset.state.engine.state,'stopped');assert.equal((await api('plugins/install',{path:directory})).code,'RECOVERY_INITIALIZATION_FAILED');assert.equal((await api('projects',{path:directory})).code,'RECOVERY_INITIALIZATION_FAILED');assert.equal(await readFile(plugins,'utf8'),'BROKEN_PLUGIN_SETTINGS');assert.equal((await api('state')).startupBlocked,true);
  }finally{await host?.close();await rm(directory,{recursive:true,force:true});}
});
