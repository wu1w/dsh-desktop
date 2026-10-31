import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath,stat,symlink,access} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {Context} from '@deepseek-ai/cordis';
import {PluginHost} from '../server/plugin-host.mjs';

const manifest=(id,type='feature')=>({id,type,version:'1.0.0',name:{'zh-CN':id,en:id}});
const routeBody=`
  host.calls.starts++;
  host.calls.live++;
  host.calls.maxLive=Math.max(host.calls.maxLive,host.calls.live);
  ctx.effect(()=>()=>{host.calls.disposals++;host.calls.live--;});
  ctx.effect(()=>host.registerRoute({matches:segments=>segments[0]===host.routeName,handle:async environment=>environment.json({source:host.routeName})}));
`;
async function fixtureRoot() {return realpath(await mkdtemp(path.join(tmpdir(),'dsh-plugins-test-')));}
async function makeBuiltin(root,id,{type='feature',body=routeBody}={}) {
  const file=path.join(root,'builtins',id+'.mjs');await mkdir(path.dirname(file),{recursive:true});
  await writeFile(file,`export const manifest=${JSON.stringify(manifest(id,type))};\nexport async function apply(ctx,host){${body}}\n`);
  return file;
}
async function makePackage(root,id,{body=routeBody,entry='index.mjs',type='feature'}={}) {
  const directory=path.join(root,'sources',id);await mkdir(directory,{recursive:true});
  await writeFile(path.join(directory,'dsh-plugin.json'),JSON.stringify({...manifest(id,type),entry}));
  if(!entry.includes('..'))await writeFile(path.join(directory,entry),`export async function apply(ctx,host){${body}}\n`);
  return directory;
}
async function makeHost(root,{dataDir=path.join(root,'data'),builtins=[],beforeDisable,services={}}={}) {
  const context=new Context();
  const calls={starts:0,disposals:0,live:0,maxLive:0};
  const host=new PluginHost({context,dataDir,builtins,services:{calls,routeName:'fixture-route',...services},beforeDisable});
  await host.start();
  return {host,context,calls,async close(){await host.close();await context.fiber.dispose();}};
}
async function dispatched(host,segments=['fixture-route']) {
  let result;
  const handled=await host.dispatch({segments,request:{method:'GET'},json:value=>{result=value;}});
  return {handled,result};
}
async function rejectsCode(promise,code) {await assert.rejects(promise,error=>error.code===code);}

test('live activity providers report execution identities without prompt data and follow actual Cordis disposal',async()=>{
  const root=await fixtureRoot();let current;const activity={rows:[{id:'run-one',kind:'automation',count:1,projectId:'project',prompt:'MUST_NOT_LEAK'}]};
  try{
    const builtin=await makeBuiltin(root,'activity-owner',{body:`host.registerActivityProvider('owned-activity',()=>host.activity.rows);`});
    current=await makeHost(root,{builtins:[builtin],services:{activity}});
    assert.deepEqual(current.host.activities(),[{id:'owned-activity:run-one',pluginId:'activity-owner',kind:'automation',count:1,projectId:'project'}]);
    activity.rows=[{id:'run-two',kind:'terminal',count:1}];assert.equal(current.host.activities()[0].id,'owned-activity:run-two');
    await current.host.disable('activity-owner');assert.deepEqual(current.host.activities(),[]);await current.host.enable('activity-owner');assert.equal(current.host.activityProviders.size,1);
    await current.close();assert.equal(current.host.activityProviders.size,0);current=null;
  }finally{await current?.close();await rm(root,{recursive:true,force:true});}
});
test('invalid or failing activity snapshots fail closed and a failed plugin leaves no activity provider',async()=>{
  const root=await fixtureRoot();let current;const activity={rows:[{id:'bad',kind:'terminal',count:0}]};
  try{
    const builtin=await makeBuiltin(root,'broken-activity',{body:`host.registerActivityProvider('broken-snapshot',()=>host.activity.rows);`});
    const failed=await makeBuiltin(root,'failed-activity',{body:`host.registerActivityProvider('leaked-snapshot',()=>[]);throw Error('startup');`});
    const asynchronous=await makeBuiltin(root,'async-activity',{body:`host.registerActivityProvider('async-snapshot',async()=>{throw Error('async failure')});`});
    current=await makeHost(root,{builtins:[builtin,failed,asynchronous],services:{activity}});
    assert.equal(current.host.activityProviders.has('leaked-snapshot'),false);assert.equal(current.host.activities().length,2);assert.ok(current.host.activities().every(row=>row.kind==='unknown'&&row.count===1));
    await new Promise(resolve=>setImmediate(resolve));activity.rows=[];assert.equal(current.host.activities().length,1);
  }finally{await current?.close();await rm(root,{recursive:true,force:true});}
});

test('engine IDs cannot become unsafe data-directory paths and invalid providers never enter the selectable registry',async()=>{
  const root=await fixtureRoot();let current;
  try{
    const bad=['../outside','/absolute','contains space','',null];
    const builtins=[];
    for(let index=0;index<bad.length;index++)builtins.push(await makeBuiltin(root,'engine-invalid-'+index,{type:'engine',body:`host.registerEngine(${JSON.stringify(bad[index])},{create:async()=>({})});`}));
    builtins.push(await makeBuiltin(root,'valid-engine-owner',{type:'engine',body:`host.registerEngine('proof-native',{create:async()=>({})});`}));
    current=await makeHost(root,{builtins});
    assert.deepEqual([...current.host.engines.keys()],['proof-native']);
    assert.equal(current.host.engines.get('proof-native').pluginId,'valid-engine-owner');
    assert.equal(current.host.list().filter(plugin=>plugin.id.startsWith('engine-invalid-')&&!plugin.active&&plugin.error==='PLUGIN_START_FAILED').length,bad.length);
  }finally{await current?.close();await rm(root,{recursive:true,force:true});}
});

test('external feature routes can replace a disabled built-in capability across disposal and restart',async()=>{
  const root=await fixtureRoot();let current;
  try{
    const builtin=await makeBuiltin(root,'feature-files');
    const source=await makePackage(root,'replacement-files',{body:`host.registerFeature('feature-files');host.registerRoute({matches:segments=>segments[0]===host.routeName,handle:async environment=>environment.json({source:'external files'})});`});
    current=await makeHost(root,{builtins:[builtin]});
    assert.equal(current.host.features.get('feature-files').pluginId,'feature-files');
    await current.host.disable('feature-files');assert.equal(current.host.features.has('feature-files'),false);
    await current.host.install(source);assert.equal(current.host.features.size,0);
    await current.host.enable('replacement-files');
    assert.equal(current.host.features.get('feature-files').pluginId,'replacement-files');
    assert.equal(current.host.features.get('replacement-files').pluginId,'replacement-files');
    assert.equal((await dispatched(current.host)).result.source,'external files');
    await current.close();assert.equal(current.host.features.size,0);current=null;
    current=await makeHost(root,{builtins:[builtin]});
    assert.equal(current.host.list().find(item=>item.id==='feature-files').active,false);
    assert.equal(current.host.features.get('feature-files').pluginId,'replacement-files');
    assert.equal((await dispatched(current.host)).result.source,'external files');
    await current.host.disable('replacement-files');assert.equal(current.host.features.size,0);assert.equal((await dispatched(current.host)).handled,false);
    await current.host.enable('feature-files');assert.equal(current.host.features.get('feature-files').pluginId,'feature-files');
    assert.equal((await dispatched(current.host)).result.source,'fixture-route');
  }finally{await current?.close();await rm(root,{recursive:true,force:true});}
});

test('capability conflicts preserve the actual owner and roll back routes registered before failure',async()=>{
  const root=await fixtureRoot();let current;
  try{
    const builtin=await makeBuiltin(root,'feature-files');
    const source=await makePackage(root,'conflicting-files',{body:`host.registerRoute({matches:()=>true,handle:async environment=>environment.json({source:'external'})});host.registerFeature('feature-files');`});
    current=await makeHost(root,{builtins:[builtin]});await current.host.install(source);
    await rejectsCode(current.host.enable('conflicting-files'),'PLUGIN_START_FAILED');
    assert.equal(current.host.features.get('feature-files').pluginId,'feature-files');
    assert.equal(current.host.features.has('conflicting-files'),false);assert.equal(current.host.routes.has('conflicting-files'),false);
    assert.equal((await dispatched(current.host)).result.source,'fixture-route');
    await current.host.disable('feature-files');await current.host.enable('conflicting-files');
    await rejectsCode(current.host.enable('feature-files'),'PLUGIN_START_FAILED');
    assert.equal(current.host.features.get('feature-files').pluginId,'conflicting-files');
    assert.equal(current.host.routes.has('feature-files'),false);assert.equal((await dispatched(current.host)).result.source,'external');
  }finally{await current?.close();await rm(root,{recursive:true,force:true});}
});

test('capabilities require real registration, validate ids, and clean up failed or disposed Cordis scopes',async()=>{
  const root=await fixtureRoot();let current;const captures={};
  try{
    const declarative=await makeBuiltin(root,'manifest-only',{body:''});
    await writeFile(declarative,`export const manifest=${JSON.stringify({...manifest('manifest-only'),features:['feature-files']})};export function apply() {}`);
    const invalid=await makeBuiltin(root,'validated-feature',{body:`
      for(const id of ['',null,42,'Bad-Id','../feature-files','x'.repeat(81)]){
        let rejected=false;try{host.registerFeature(id);}catch(error){if(error.code!=='INVALID_PLUGIN')throw error;rejected=true;}
        if(!rejected)throw new Error('invalid capability accepted');
      }
      host.captures.register=host.registerFeature;
      host.captures.remove=host.registerFeature('validated-feature');
      host.registerRoute({matches:()=>true,handle:async environment=>environment.json({source:'validated'})});
    `});
    current=await makeHost(root,{builtins:[declarative,invalid],services:{captures}});
    assert.equal(current.host.list().find(item=>item.id==='manifest-only').active,true);
    assert.equal(current.host.features.has('manifest-only'),false);assert.equal(current.host.features.has('feature-files'),false);
    assert.equal(current.host.features.get('validated-feature').pluginId,'validated-feature');
    captures.remove();assert.equal(current.host.features.has('validated-feature'),false);
    await current.host.disable('validated-feature');assert.throws(()=>captures.register('late-feature'));assert.equal(current.host.features.has('late-feature'),false);
    const failed=await makePackage(root,'failed-feature',{body:`host.registerFeature('feature-files');host.registerRoute({matches:()=>true,handle:async()=>{}});await Promise.resolve();throw new Error('failed after registering');`});
    await current.host.install(failed);await rejectsCode(current.host.enable('failed-feature'),'PLUGIN_START_FAILED');
    assert.equal(current.host.features.size,0);assert.equal(current.host.routes.size,0);
  }finally{await current?.close();await rm(root,{recursive:true,force:true});}
});

test('feature ownership rolls back on persistence failure and stale cleanup cannot remove its replacement',async()=>{
  const root=await fixtureRoot();let current;const captures={};
  try{
    const source=await makePackage(root,'rollback-feature',{body:`host.captures.remove=host.registerFeature('feature-files');host.registerRoute({matches:()=>true,handle:async environment=>environment.json({source:'live replacement'})});`});
    current=await makeHost(root,{services:{captures}});await current.host.install(source);
    const previous=await readFile(path.join(root,'data','plugins.json'),'utf8');let restore=failNextSave(current.host);
    await rejectsCode(current.host.enable('rollback-feature'),'ENOSPC');restore();
    assert.equal(current.host.features.size,0);assert.equal(current.host.routes.size,0);
    assert.equal(await readFile(path.join(root,'data','plugins.json'),'utf8'),previous);
    await current.host.enable('rollback-feature');const staleRemove=captures.remove;
    const enabled=await readFile(path.join(root,'data','plugins.json'),'utf8');restore=failNextSave(current.host);
    await rejectsCode(current.host.disable('rollback-feature'),'ENOSPC');restore();
    assert.equal(current.host.features.get('feature-files').pluginId,'rollback-feature');
    assert.equal(current.host.features.get('rollback-feature').pluginId,'rollback-feature');
    assert.equal((await dispatched(current.host)).result.source,'live replacement');
    staleRemove();assert.equal(current.host.features.get('feature-files').pluginId,'rollback-feature');
    assert.equal(await readFile(path.join(root,'data','plugins.json'),'utf8'),enabled);
    await current.host.remove('rollback-feature');assert.equal(current.host.features.size,0);assert.equal(current.host.routes.size,0);
  }finally{await current?.close();await rm(root,{recursive:true,force:true});}
});

test('plugin suspension removes admission immediately and joins an in-flight operation before replacement',async()=>{
  const root=await fixtureRoot();let current,release,entered;
  const finish=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
  try{
    const builtin=await makeBuiltin(root,'joining-fixture',{body:`host.registerRoute({matches:()=>true,handle:async environment=>{host.gates.entered();await host.gates.finish;environment.json({finished:true});}});`});
    current=await makeHost(root,{builtins:[builtin],services:{gates:{finish,entered}}});
    const heldRoute=current.host.routes.get('joining-fixture');
    const request=dispatched(current.host);await started;
    let disabled=false;
    const disabling=current.host.disable('joining-fixture').then(()=>{disabled=true;});
    for(let n=0;n<100&&current.host.routes.has('joining-fixture');n++)await new Promise(resolve=>setTimeout(resolve,2));
    assert.equal(current.host.routes.has('joining-fixture'),false);assert.equal(disabled,false);
    assert.equal((await dispatched(current.host)).handled,false);
    await rejectsCode(heldRoute.handle({json:()=>{throw new Error('must not be admitted');}}),'PLUGIN_DISABLED');
    release();assert.equal((await request).result.finished,true);await disabling;
    assert.equal(disabled,true);await current.host.enable('joining-fixture');
    assert.equal((await dispatched(current.host)).result.finished,true);
  }finally{release();await current?.close();await rm(root,{recursive:true,force:true});}
});

test('route admission pauses before asynchronous shutdown work and resumes when shutdown is refused',async()=>{
  const root=await fixtureRoot();let current,entered,release;
  const started=new Promise(resolve=>{entered=resolve;}),waiting=new Promise(resolve=>{release=resolve;});
  try{
    const builtin=await makeBuiltin(root,'pausing-fixture');
    current=await makeHost(root,{builtins:[builtin],beforeDisable:async()=>{entered();await waiting;throw Object.assign(new Error('CANNOT_STOP'),{code:'CANNOT_STOP'});}});
    const disabling=current.host.disable('pausing-fixture');const rejected=rejectsCode(disabling,'CANNOT_STOP');
    await started;
    await rejectsCode(dispatched(current.host),'PLUGIN_DISABLED');
    release();await rejected;
    assert.equal((await dispatched(current.host)).result.source,'fixture-route');
    assert.equal(current.host.list()[0].active,true);
  }finally{release();await current?.close();await rm(root,{recursive:true,force:true});}
});

test('real Cordis disposal unregisters feature routes, engine factories, and active appearance assets',async()=>{
  const root=await fixtureRoot();let current;
  try {
    const feature=await makeBuiltin(root,'feature-fixture');
    const engine=await makeBuiltin(root,'engine-fixture',{type:'engine',body:`ctx.effect(()=>host.registerEngine('fixture-engine',{create:async()=>({marker:'real factory'})}));`});
    const appearance=await makeBuiltin(root,'appearance-fixture',{type:'appearance',body:`ctx.effect(()=>host.registerAppearance({root:host.pluginRoot,entry:'view.js',styles:[]}));`});
    await writeFile(path.join(root,'builtins','view.js'),'export const fixture = true;');
    current=await makeHost(root,{builtins:[feature,engine,appearance]});
    assert.equal((await dispatched(current.host)).result.source,'fixture-route');
    assert.equal((await current.host.engines.get('fixture-engine').create()).marker,'real factory');
    assert.equal(await readFile(await current.host.asset('appearance-fixture','view.js'),'utf8'),'export const fixture = true;');
    await current.host.disable('feature-fixture');
    assert.equal((await dispatched(current.host)).handled,false);
    assert.equal(current.calls.live,0);
    await current.host.disable('engine-fixture');assert.equal(current.host.engines.size,0);
    await current.host.disable('appearance-fixture');assert.equal(current.host.appearance(),null);
    await rejectsCode(current.host.asset('appearance-fixture','view.js'),'PLUGIN_UNKNOWN');
    await current.host.enable('feature-fixture');assert.equal((await dispatched(current.host)).handled,true);
    assert.equal(current.calls.maxLive,1);
    await rejectsCode(current.host.remove('feature-fixture'),'BUILTIN_PLUGIN');
    assert.equal((await dispatched(current.host)).handled,true);
  }finally{await current?.close();await rm(root,{recursive:true,force:true});}
});

test('failed plugin initialization cannot leave a callable route registered before the failure',async()=>{
  const root=await fixtureRoot();let current;
  try {
    const source=await makePackage(root,'failed-fixture',{body:`host.registerRoute({matches:()=>true,handle:async environment=>environment.json({leaked:true})});throw new Error('fixture startup failure');`});
    current=await makeHost(root);await current.host.install(source);
    await rejectsCode(current.host.enable('failed-fixture'),'PLUGIN_START_FAILED');
    assert.equal(current.host.list()[0].active,false);
    assert.equal((await dispatched(current.host)).handled,false,'a failed plugin must not remain callable');
    assert.equal(current.host.routes.size,0);
  }finally{await current?.close();await rm(root,{recursive:true,force:true});}
});

test('a conflicting engine plugin cannot unregister or replace the active engine owner',async()=>{
  const root=await fixtureRoot();let current;
  try {
    const first=await makeBuiltin(root,'engine-first',{type:'engine',body:`ctx.effect(()=>host.registerEngine('same-engine',{marker:'first'}));`});
    const source=await makePackage(root,'engine-conflict',{type:'engine',body:`ctx.effect(()=>host.registerEngine('same-engine',{marker:'second'}));`});
    current=await makeHost(root,{builtins:[first]});await current.host.install(source);
    await rejectsCode(current.host.enable('engine-conflict'),'PLUGIN_START_FAILED');
    assert.equal(current.host.engines.get('same-engine').marker,'first');
    await current.host.disable('engine-conflict');
    assert.equal(current.host.engines.get('same-engine').pluginId,'engine-first');
    await current.host.disable('engine-first');assert.equal(current.host.engines.size,0);
  }finally{await current?.close();await rm(root,{recursive:true,force:true});}
});

test('concurrent enable and disable persist the final state without duplicate live effects',async()=>{
  const root=await fixtureRoot();let current;
  try {
    const source=await makePackage(root,'serial-fixture',{body:`await new Promise(resolve=>setTimeout(resolve,4));${routeBody}`});
    current=await makeHost(root);await current.host.install(source);
    await Promise.all([current.host.enable('serial-fixture'),current.host.disable('serial-fixture'),current.host.enable('serial-fixture'),current.host.disable('serial-fixture')]);
    assert.equal(current.calls.maxLive,1);assert.equal(current.calls.live,0);assert.equal(current.calls.starts,current.calls.disposals);
    assert.equal((await dispatched(current.host)).handled,false);
    const settings=JSON.parse(await readFile(path.join(root,'data','plugins.json'),'utf8'));
    assert.equal(settings.enabled['serial-fixture'],false);
    assert.equal(current.host.list()[0].active,false);
    assert.equal((await stat(path.join(root,'data','plugins.json'))).mode&0o777,0o600);
  }finally{await current?.close();await rm(root,{recursive:true,force:true});}
});

test('concurrent remove and enable never leave an executable plugin after its catalog entry is removed',async()=>{
  const root=await fixtureRoot();let current;
  try {
    const source=await makePackage(root,'remove-race');
    current=await makeHost(root);await current.host.install(source);await current.host.enable('remove-race');
    await Promise.allSettled([current.host.remove('remove-race'),current.host.enable('remove-race')]);
    assert.equal(current.host.list().length,0);
    assert.equal((await dispatched(current.host)).handled,false,'removed package must not still serve its route');
    assert.equal(current.calls.live,0,'removed package must not retain a Cordis fiber');
    await assert.rejects(access(path.join(root,'data','plugins','remove-race')));
    await access(path.join(source,'index.mjs'));
  }finally{await current?.close();await rm(root,{recursive:true,force:true});}
});

test('beforeDisable rejection preserves the active plugin and its persisted enabled state',async()=>{
  const root=await fixtureRoot();let current;
  try {
    const source=await makePackage(root,'protected-fixture');let deny=true;
    current=await makeHost(root,{beforeDisable:async()=>{if(deny)throw Object.assign(new Error('fixture busy'),{code:'FIXTURE_BUSY'});}});
    await current.host.install(source);await current.host.enable('protected-fixture');
    await rejectsCode(current.host.disable('protected-fixture'),'FIXTURE_BUSY');
    assert.equal(current.host.list()[0].active,true);assert.equal((await dispatched(current.host)).handled,true);
    assert.equal(JSON.parse(await readFile(path.join(root,'data','plugins.json'),'utf8')).enabled['protected-fixture'],true);
    deny=false;await current.host.disable('protected-fixture');assert.equal(current.calls.live,0);
  }finally{await current?.close();await rm(root,{recursive:true,force:true});}
});

test('local package installation remains disabled until enabled and survives full Cordis host restarts',async()=>{
  const root=await fixtureRoot();let current;
  try {
    const source=await makePackage(root,'persistent-fixture');
    current=await makeHost(root);await current.host.install(source);
    assert.equal(current.host.list()[0].enabled,false);assert.equal((await dispatched(current.host)).handled,false);
    await current.host.enable('persistent-fixture');await current.close();current=null;
    current=await makeHost(root);assert.equal(current.host.list()[0].active,true);assert.equal((await dispatched(current.host)).handled,true);
    await current.host.disable('persistent-fixture');await current.close();current=null;
    current=await makeHost(root);assert.equal(current.host.list()[0].active,false);assert.equal((await dispatched(current.host)).handled,false);
    await current.host.remove('persistent-fixture');assert.deepEqual(current.host.list(),[]);
    await access(path.join(source,'index.mjs'));
    assert.equal(JSON.parse(await readFile(path.join(root,'data','plugins.json'),'utf8')).installed.length,0);
  }finally{await current?.close();await rm(root,{recursive:true,force:true});}
});

test('managed data-directory aliases accept valid packages without weakening the canonical boundary',async()=>{
  const root=await fixtureRoot();let current;
  try {
    const data=path.join(root,'actual-data');await mkdir(data);
    const alias=path.join(root,'data-alias');await symlink(data,alias,'dir');
    const source=await makePackage(root,'alias-fixture');
    current=await makeHost(root,{dataDir:alias});await current.host.install(source);await current.host.enable('alias-fixture');
    assert.equal((await dispatched(current.host)).handled,true);
    await current.close();current=null;
    current=await makeHost(root,{dataDir:alias});assert.equal(current.host.list()[0].active,true);
  }finally{await current?.close();await rm(root,{recursive:true,force:true});}
});

test('appearance assets reject path traversal, symlink escapes, forbidden extensions, and disabled owners',async()=>{
  const root=await fixtureRoot();let current;
  try {
    const assets=path.join(root,'assets');await mkdir(path.join(assets,'nested'),{recursive:true});
    await writeFile(path.join(assets,'nested','view.js'),'export const safe = true;');
    await writeFile(path.join(assets,'secret.json'),'private fixture data');
    await writeFile(path.join(root,'outside.js'),'outside fixture data');
    await symlink(path.join(root,'outside.js'),path.join(assets,'escape.js'));
    const builtin=await makeBuiltin(root,'asset-fixture',{type:'appearance',body:`ctx.effect(()=>host.registerAppearance({root:${JSON.stringify(assets)},entry:'nested/view.js',styles:[]}));`});
    current=await makeHost(root,{builtins:[builtin]});
    assert.equal(await current.host.asset('asset-fixture','nested/view.js'),path.join(assets,'nested','view.js'));
    for(const relative of ['../outside.js','escape.js','secret.json'])await rejectsCode(current.host.asset('asset-fixture',relative),'FORBIDDEN');
    await current.host.disable('asset-fixture');await rejectsCode(current.host.asset('asset-fixture','nested/view.js'),'PLUGIN_UNKNOWN');
  }finally{await current?.close();await rm(root,{recursive:true,force:true});}
});

test('package install rejects escaped entry files and symlinks while preserving source files',async()=>{
  const root=await fixtureRoot();let current;
  try {
    const escaped=await makePackage(root,'escaped-fixture',{entry:'../outside.mjs'});
    const outside=path.join(root,'sources','outside.mjs');await writeFile(outside,'export function apply() {}');
    current=await makeHost(root);
    await rejectsCode(current.host.install(escaped),'INVALID_PLUGIN');
    const linked=await makePackage(root,'linked-fixture');await symlink(outside,path.join(linked,'external.mjs'));
    await rejectsCode(current.host.install(linked),'INVALID_PLUGIN');
    await access(outside);await access(path.join(linked,'index.mjs'));
    assert.deepEqual(current.host.list(),[]);
    await assert.rejects(access(path.join(root,'data','plugins','linked-fixture')));
  }finally{await current?.close();await rm(root,{recursive:true,force:true});}
});

test('a failed install never deletes an already-existing managed target or the selected source directory',async()=>{
  const root=await fixtureRoot();let current;
  try {
    const source=await makePackage(root,'existing-fixture');
    const target=path.join(root,'data','plugins','existing-fixture');await mkdir(target,{recursive:true});
    await writeFile(path.join(target,'dsh-plugin.json'),JSON.stringify(manifest('existing-fixture')));
    await writeFile(path.join(target,'existing-marker.txt'),'must survive failed installation');
    current=await makeHost(root);
    await assert.rejects(current.host.install(source));
    assert.equal(await readFile(path.join(target,'existing-marker.txt'),'utf8'),'must survive failed installation');
    await access(path.join(source,'index.mjs'));
  }finally{await current?.close();await rm(root,{recursive:true,force:true});}
});

test('close waits for a pending plugin startup, rejects new work, and leaves no callable registration',async()=>{
  const root=await fixtureRoot();let current;let release;
  const gate=new Promise(resolve=>{release=resolve;});let entered;
  const started=new Promise(resolve=>{entered=resolve;});
  try {
    const source=await makePackage(root,'closing-fixture',{body:`host.entered();await host.gate;${routeBody}`});
    current=await makeHost(root,{services:{gate,entered}});await current.host.install(source);
    const enabling=current.host.enable('closing-fixture');await started;
    const closing=current.host.close();assert.equal(current.host.close(),closing);
    for(const action of [()=>current.host.enable('closing-fixture'),()=>current.host.disable('closing-fixture'),()=>current.host.install(source),()=>current.host.remove('closing-fixture')])await rejectsCode(action(),'PLUGIN_HOST_CLOSED');
    release();await enabling;await closing;
    assert.equal((await dispatched(current.host)).handled,false);assert.equal(current.calls.live,0);
    assert.equal(current.host.list()[0].active,false);
  }finally{release();await current?.close();await rm(root,{recursive:true,force:true});}
});

test('removing an unloadable persisted plugin never deletes a path outside the managed plugin directory',async()=>{
  const root=await fixtureRoot();let current;
  try {
    const outside=path.join(root,'independent-user-folder');await mkdir(outside);
    await writeFile(path.join(outside,'user-document.txt'),'user file must survive removal of an invalid plugin');
    const data=path.join(root,'data');await mkdir(data);
    await writeFile(path.join(data,'plugins.json'),JSON.stringify({version:1,enabled:{'broken-fixture':false},installed:[{id:'broken-fixture',root:outside}]}));
    current=await makeHost(root);
    assert.equal(current.host.list()[0].active,false);
    await current.host.remove('broken-fixture').catch(error=>{if(error.code!=='INVALID_PLUGIN')throw error;});
    assert.equal(await readFile(path.join(outside,'user-document.txt'),'utf8'),'user file must survive removal of an invalid plugin');
  }finally{await current?.close();await rm(root,{recursive:true,force:true});}
});

function failNextSave(host) {
  const save=host._save.bind(host);let failed=false;
  host._save=async()=>{if(!failed){failed=true;throw Object.assign(new Error('fixture disk is full'),{code:'ENOSPC'});}return save();};
  return ()=>{host._save=save;};
}

test('failed installation persistence rolls back its new catalog and files while preserving existing plugins',async()=>{
  const root=await fixtureRoot();let current;
  try {
    const stable=await makePackage(root,'stable-fixture');const incoming=await makePackage(root,'rollback-install');
    current=await makeHost(root);await current.host.install(stable);
    const previous=await readFile(path.join(root,'data','plugins.json'),'utf8');
    const restore=failNextSave(current.host);
    await assert.rejects(current.host.install(incoming));restore();
    assert.deepEqual(current.host.list().map(plugin=>plugin.id),['stable-fixture']);
    assert.equal(await readFile(path.join(root,'data','plugins.json'),'utf8'),previous);
    await assert.rejects(access(path.join(root,'data','plugins','rollback-install')));
    await access(path.join(incoming,'index.mjs'));
    await current.host.install(incoming);
    assert.ok(current.host.list().some(plugin=>plugin.id==='rollback-install'));
  }finally{await current?.close();await rm(root,{recursive:true,force:true});}
});

test('failed enable persistence restores the disabled runtime and retained disk configuration',async()=>{
  const root=await fixtureRoot();let current;
  try {
    const source=await makePackage(root,'rollback-enable');current=await makeHost(root);await current.host.install(source);
    const previous=await readFile(path.join(root,'data','plugins.json'),'utf8');const restore=failNextSave(current.host);
    await assert.rejects(current.host.enable('rollback-enable'));restore();
    assert.equal(current.host.list()[0].enabled,false);assert.equal(current.host.list()[0].active,false);
    assert.equal((await dispatched(current.host)).handled,false);assert.equal(current.calls.live,0);
    assert.equal(await readFile(path.join(root,'data','plugins.json'),'utf8'),previous);
    await current.host.enable('rollback-enable');assert.equal((await dispatched(current.host)).handled,true);
  }finally{await current?.close();await rm(root,{recursive:true,force:true});}
});

test('failed disable persistence restores the live runtime and retained disk configuration',async()=>{
  const root=await fixtureRoot();let current;
  try {
    const source=await makePackage(root,'rollback-disable');current=await makeHost(root);await current.host.install(source);await current.host.enable('rollback-disable');
    const previous=await readFile(path.join(root,'data','plugins.json'),'utf8');const restore=failNextSave(current.host);
    await assert.rejects(current.host.disable('rollback-disable'));restore();
    assert.equal(current.host.list()[0].enabled,true);assert.equal(current.host.list()[0].active,true);
    assert.equal((await dispatched(current.host)).handled,true);assert.equal(current.calls.live,1);
    assert.equal(await readFile(path.join(root,'data','plugins.json'),'utf8'),previous);
    await current.host.disable('rollback-disable');assert.equal((await dispatched(current.host)).handled,false);
  }finally{await current?.close();await rm(root,{recursive:true,force:true});}
});

async function markerPackage(root,id) {
  const source=await makePackage(root,id);
  const marker=path.join(root,id+'.executed');
  await writeFile(path.join(source,'index.mjs'),`import {appendFile} from 'node:fs/promises';\nawait appendFile(${JSON.stringify(marker)},'module loaded\\n');\nexport async function apply(ctx,host){${routeBody}}\n`);
  return {source,marker};
}

test('external package top-level code runs only after enable, never during disabled installation or restart',async()=>{
  const root=await fixtureRoot();let current;
  try {
    const {source,marker}=await markerPackage(root,'lazy-fixture');
    current=await makeHost(root);await current.host.install(source);
    await assert.rejects(access(marker),{code:'ENOENT'});
    assert.equal(current.host.list()[0].enabled,false);
    await current.close();current=null;
    current=await makeHost(root);
    await assert.rejects(access(marker),{code:'ENOENT'});
    assert.equal(current.host.list()[0].active,false);
    await current.host.enable('lazy-fixture');
    assert.equal(await readFile(marker,'utf8'),'module loaded\n');
    assert.equal((await dispatched(current.host)).handled,true);
    await current.host.disable('lazy-fixture');await current.host.enable('lazy-fixture');
    assert.equal(await readFile(marker,'utf8'),'module loaded\n','reenabling uses the validated module and reruns only its Cordis apply lifecycle');
    assert.equal(current.calls.maxLive,1);
  }finally{await current?.close();await rm(root,{recursive:true,force:true});}
});

test('a missing persisted external enabled flag fails closed without importing its module',async()=>{
  const root=await fixtureRoot();let current;
  try {
    const {source,marker}=await markerPackage(root,'missing-flag');
    current=await makeHost(root);await current.host.install(source);await current.close();current=null;
    const file=path.join(root,'data','plugins.json');const settings=JSON.parse(await readFile(file,'utf8'));
    delete settings.enabled['missing-flag'];await writeFile(file,JSON.stringify(settings));
    current=await makeHost(root);
    await assert.rejects(access(marker),{code:'ENOENT'});
    assert.equal(current.host.list()[0].enabled,false);assert.equal(current.host.list()[0].active,false);
    assert.equal((await dispatched(current.host)).handled,false);
  }finally{await current?.close();await rm(root,{recursive:true,force:true});}
});

test('external import failure is contained and does not block working built-ins or host restart',async()=>{
  const root=await fixtureRoot();let current;
  try {
    const recovery=await makeBuiltin(root,'feature-recovery');
    const source=await makePackage(root,'broken-import');
    await writeFile(path.join(source,'index.mjs'),`import './missing-dependency.mjs'; export function apply() {}`);
    current=await makeHost(root,{builtins:[recovery]});await current.host.install(source);
    await rejectsCode(current.host.enable('broken-import'),'PLUGIN_START_FAILED');
    assert.equal(current.host.list().find(plugin=>plugin.id==='broken-import').active,false);
    assert.equal((await dispatched(current.host)).handled,true);
    await current.close();current=null;
    current=await makeHost(root,{builtins:[recovery]});
    assert.equal(current.host.list().find(plugin=>plugin.id==='broken-import').error,'PLUGIN_START_FAILED');
    assert.equal((await dispatched(current.host)).handled,true);
    await current.host.disable('broken-import');
    await current.host.remove('broken-import');
    assert.equal((await dispatched(current.host)).handled,true);
  }finally{await current?.close();await rm(root,{recursive:true,force:true});}
});

test('the actual recovery shell and authenticated plugin controls remain reachable after external import failure',async()=>{
  const root=await fixtureRoot();let host;
  try {
    const {startHost}=await import('../server/index.mjs');
    const source=await makePackage(root,'http-broken-import');
    await writeFile(path.join(source,'index.mjs'),`throw new Error('fixture module load failure'); export function apply() {}`);
    host=await startHost({dataDir:path.join(root,'http-host'),autoStart:false});
    async function authenticate() {
      const response=await fetch(host.url+'/api/bootstrap');const boot=await response.json();
      return {cookie:response.headers.get('set-cookie').split(';')[0],'x-dsh-capability':boot.capability,'content-type':'application/json'};
    }
    let headers=await authenticate();
    const call=(route,body)=>fetch(host.url+'/api/'+route,{method:'POST',headers,body:JSON.stringify(body)});
    assert.equal((await call('plugins/install',{path:source})).status,200);
    const failed=await call('plugins/http-broken-import/enable',{});
    assert.notEqual(failed.status,200);assert.equal((await failed.json()).code,'PLUGIN_START_FAILED');
    assert.equal((await call('plugins/appearance-codex/disable',{})).status,200);
    let state=await (await fetch(host.url+'/api/state',{headers})).json();
    assert.equal(state.appearance,null);
    assert.equal(state.plugins.find(plugin=>plugin.id==='http-broken-import').active,false);
    assert.equal((await fetch(host.url+'/')).status,200);assert.equal((await fetch(host.url+'/core.js')).status,200);
    await host.close();host=null;
    host=await startHost({dataDir:path.join(root,'http-host'),autoStart:false});headers=await authenticate();
    state=await (await fetch(host.url+'/api/state',{headers})).json();
    assert.equal(state.plugins.find(plugin=>plugin.id==='http-broken-import').error,'PLUGIN_START_FAILED');
    assert.equal((await fetch(host.url+'/')).status,200);assert.equal((await fetch(host.url+'/core.js')).status,200);
    assert.equal((await call('plugins/http-broken-import/disable',{})).status,200);
    assert.equal((await call('plugins/http-broken-import/remove',{})).status,200);
  }finally{await host?.close();await rm(root,{recursive:true,force:true});}
});
