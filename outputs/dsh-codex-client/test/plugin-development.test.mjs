import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,symlink,mkdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Context} from '@deepseek-ai/cordis';
import {PluginHost} from '../server/plugin-host.mjs';
import {PluginDevelopment} from '../server/plugin-development.mjs';

async function fixture(t){
  const root=await mkdtemp(path.join(os.tmpdir(),'dsh-self-development-'));
  let context=new Context(),host=new PluginHost({context,dataDir:root,builtins:[],services:{}});await host.start();
  const state={sessions:[{id:'stable-chat',engineSessionId:'native-chat',runRecovery:{userStopped:false},pluginDevelopment:true}],preferences:{}},engine={activeTurns:new Map([['stable-chat',{}]])};
  let development=new PluginDevelopment({host,state,getEngine:()=>engine,save:async()=>{}});
  const call=input=>development.run(input);
  async function write(draft,file,content){return call({action:'write',pluginId:draft.pluginId,digest:draft.digest,file,content});}
  async function apply(draft){return call({action:'apply',pluginId:draft.pluginId,digest:draft.digest,expectedRevision:draft.expectedRevision});}
  async function restart(){await host.close();await context.fiber.dispose();context=new Context();host=new PluginHost({context,dataDir:root,builtins:[],services:{}});await host.start();development=new PluginDevelopment({host,state,getEngine:()=>engine,save:async()=>{}});}
  t.after(async()=>{await host.close();await context.fiber.dispose();await rm(root,{recursive:true,force:true});});
  return {root,state,engine,get host(){return host;},get development(){return development;},call,write,apply,restart};
}
const entry=`import {version} from './value.mjs';export function apply(ctx,host){host.registerTool({name:'version',description:'version',inputSchema:{type:'object',properties:{}},execute:async()=>({version})});host.registerHealthCheck(()=>true);}`;
test('agent creates plugin, updates a nested module live, rolls back and retains code through restart',async t=>{
  const f=await fixture(t);let draft=await f.call({action:'create',pluginId:'self-helper'});draft=await f.write(draft,'index.mjs',entry);draft=await f.write(draft,'value.mjs',"export const version='one';");
  const first=await f.apply(draft);assert.equal((await f.host.callTool('self-helper:version',{})).version,'one');
  draft=await f.call({action:'files',pluginId:'self-helper'});draft=await f.write(draft,'value.mjs',"export const version='two';");
  const second=await f.apply(draft);assert.equal((await f.host.callTool('self-helper:version',{})).version,'two');assert.notEqual(first.plugin.revision,second.plugin.revision);
  const originalState=structuredClone(f.state);await f.call({action:'rollback',pluginId:'self-helper',revision:first.plugin.revision,expectedRevision:second.plugin.revision});assert.equal((await f.host.callTool('self-helper:version',{})).version,'one');assert.deepEqual(f.state,originalState);
  await f.restart();assert.equal((await f.host.callTool('self-helper:version',{})).version,'one');assert.equal(f.host.history('self-helper').length,3);
});
test('syntax validation never executes draft code, and bad syntax cannot replace a working plugin',async t=>{
  const f=await fixture(t);let draft=await f.call({action:'create',pluginId:'syntax-helper'});await f.apply(draft);const revision=f.host.list()[0].revision;
  draft=await f.call({action:'files',pluginId:'syntax-helper'});draft=await f.write(draft,'index.mjs',"throw Error('must never execute');export function apply(){};");assert.equal((await f.call({action:'validate',pluginId:'syntax-helper',digest:draft.digest})).ok,true);
  draft=await f.write(draft,'index.mjs','export function apply( {');const result=await f.call({action:'validate',pluginId:'syntax-helper',digest:draft.digest});assert.equal(result.ok,false);assert.equal(result.issues[0].file,'index.mjs');await assert.rejects(f.apply(draft),{code:'PLUGIN_VALIDATION_FAILED'});assert.equal(f.host.list()[0].revision,revision);
});
test('startup and health-check failures dispose candidate registrations and restore the prior live tool',async t=>{
  const f=await fixture(t);let draft=await f.call({action:'create',pluginId:'bad-helper'});await f.apply(draft);const revision=f.host.list()[0].revision;
  for(const body of ["host.registerFeature('leak-check');throw Error('broken');","host.registerFeature('leak-check');host.registerHealthCheck(()=>false);"]){draft=await f.call({action:'files',pluginId:'bad-helper'});draft=await f.write(draft,'index.mjs',`export function apply(ctx,host){${body}}`);await assert.rejects(f.apply(draft));assert.equal(f.host.features.has('leak-check'),false);assert.equal(f.host.list()[0].revision,revision);assert.equal((await f.host.callTool('bad-helper:status',{})).version,'1.0.0');assert.equal(f.host.settings.pending,undefined);}
});
test('changed revision and stale drafts reject lost updates',async t=>{
  const f=await fixture(t);const first=await f.call({action:'create',pluginId:'cas-helper'});const next=await f.write(first,'readme.md','changed');await assert.rejects(f.write(first,'readme.md','overwrite'),{code:'PLUGIN_DRAFT_CHANGED'});await f.apply(next);await assert.rejects(f.apply(next),{code:'PLUGIN_REVISION_CHANGED'});assert.equal((await f.call({action:'read',pluginId:'cas-helper',file:'readme.md'})).content,'changed');
});
test('a failed settings commit restores the old running plugin and its persisted revision',async t=>{
  const f=await fixture(t);let draft=await f.call({action:'create',pluginId:'disk-helper'});await f.apply(draft);const revision=f.host.list()[0].revision;draft=await f.call({action:'files',pluginId:'disk-helper'});draft=await f.write(draft,'index.mjs',"export function apply(ctx,host){host.registerFeature('candidate-feature');}");
  const original=f.host._save.bind(f.host);let calls=0;f.host._save=async()=>{if(++calls===2)throw Error('disk full');return original();};await assert.rejects(f.apply(draft));f.host._save=original;
  assert.equal(f.host.list()[0].revision,revision);assert.equal(f.host.features.has('candidate-feature'),false);assert.equal((await f.host.callTool('disk-helper:status',{})).version,'1.0.0');await f.restart();assert.equal(f.host.list()[0].revision,revision);
});
test('restart restores an interrupted transaction before importing candidate code',async t=>{
  const f=await fixture(t);const draft=await f.call({action:'create',pluginId:'crash-helper'});await f.apply(draft);const previous=structuredClone(f.host.settings),revision=f.host.list()[0].revision;
  f.host.settings={...previous,pending:{id:'crash-helper',revision:'interrupted',previous},installed:[{id:'crash-helper',root:'/never/import/me'}]};await f.host._save();await f.restart();assert.equal(f.host.list()[0].revision,revision);assert.equal(f.host.settings.lastChange.reason,'PLUGIN_INTERRUPTED');assert.equal((await f.host.callTool('crash-helper:status',{})).version,'1.0.0');
});
test('appearance revisions need shell acknowledgement; a failed first appearance falls back without blocking future changes',async t=>{
  const f=await fixture(t);let draft=await f.call({action:'create',pluginId:'new-look'});draft=await f.write(draft,'dsh-plugin.json',JSON.stringify({id:'new-look',type:'appearance',name:{en:'Look','zh-CN':'外观'},version:'1.0.0'}));draft=await f.write(draft,'index.mjs',"export function apply(ctx,host){host.registerAppearance({root:host.pluginRoot,entry:'view.js',styles:[],exportName:'mount'});}");draft=await f.write(draft,'view.js','export function mount(){throw Error("bad UI");}');
  const result=await f.apply(draft);assert.equal(f.host.settings.pending.revision,result.plugin.revision);await assert.rejects(f.host.disable('new-look'),{code:'PLUGIN_VERIFY_PENDING'});await f.host.finishAppearance('new-look',result.plugin.revision,false);assert.equal(f.host.appearance(),null);assert.equal(f.host.settings.pending,undefined);assert.equal(f.host.settings.lastChange.reason,'PLUGIN_APPEARANCE_FAILED');
});
test('acknowledged appearance survives restart; rejected update restores earlier appearance files',async t=>{
  const f=await fixture(t);let draft=await f.call({action:'create',pluginId:'stable-look'});draft=await f.write(draft,'dsh-plugin.json',JSON.stringify({id:'stable-look',type:'appearance',name:{en:'Look','zh-CN':'外观'},version:'1.0.0'}));draft=await f.write(draft,'index.mjs',"export function apply(ctx,host){host.registerAppearance({root:host.pluginRoot,entry:'view.js',styles:[],exportName:'mount'});}");draft=await f.write(draft,'view.js','export function mount(){return ()=>{};}');
  const first=await f.apply(draft);await f.host.finishAppearance('stable-look',first.plugin.revision,true);await f.restart();assert.equal(f.host.appearance().revision,first.plugin.revision);
  draft=await f.call({action:'files',pluginId:'stable-look'});draft=await f.write(draft,'view.js','export function mount(){throw Error("bad");}');const second=await f.apply(draft);await f.host.finishAppearance('stable-look',second.plugin.revision,false);assert.equal(f.host.appearance().revision,first.plugin.revision);assert.match(await readFile(await f.host.asset('stable-look','view.js'),'utf8'),/return/);
});
test('in-flight plugin tools prevent disposal or replacement until they finish',async t=>{
  const f=await fixture(t);let resolve;f.host.services.wait=()=>new Promise(done=>{resolve=done;});let draft=await f.call({action:'create',pluginId:'busy-helper'});draft=await f.write(draft,'index.mjs',"export function apply(ctx,host){host.registerTool({name:'wait',description:'wait',inputSchema:{type:'object'},execute:()=>host.wait()});}");await f.apply(draft);draft=await f.call({action:'files',pluginId:'busy-helper'});const call=f.host.callTool('busy-helper:wait',{});await new Promise(setImmediate);await assert.rejects(f.apply(draft),{code:'PLUGIN_BUSY'});await assert.rejects(f.host.disable('busy-helper'),{code:'PLUGIN_BUSY'});resolve('done');assert.equal(await call,'done');await f.apply(draft);assert.equal(f.host.toolList().length,1);
});
test('agent grants are stable-chat scoped across engine IDs; stop, IM and revocation prevent mutation',async t=>{
  const f=await fixture(t);const native='native-chat';f.state.sessions[0].pluginDevelopment=false;await assert.rejects(f.development.engineCall(native,{action:'create',pluginId:'grant-helper'}),{code:'PLUGIN_DEVELOPMENT_DENIED'});assert.ok((await f.development.engineCall(native,{action:'guide'})).guide.includes('Workflow'));
  await f.development.grant('stable-chat',true);await f.development.engineCall(native,{action:'create',pluginId:'grant-helper'});f.state.sessions[0].engineSessionId='next-engine-chat';await assert.rejects(f.development.engineCall(native,{action:'list'}),{code:'PLUGIN_CHAT_INACTIVE'});assert.ok((await f.development.engineCall('next-engine-chat',{action:'list'})).drafts.includes('grant-helper'));
  f.state.sessions[0].runRecovery.userStopped=true;await assert.rejects(f.development.engineCall('next-engine-chat',{action:'list'}),{code:'PLUGIN_CHAT_INACTIVE'});f.state.sessions[0].runRecovery.userStopped=false;f.state.sessions[0].channel='feishu';await assert.rejects(f.development.grant('stable-chat',true),{code:'PLUGIN_CHAT_INACTIVE'});
});
test('revocation during validation prevents activation and leaves existing runtime untouched',async t=>{
  const f=await fixture(t);const draft=await f.call({action:'create',pluginId:'revoke-helper'}),original=f.development.validate.bind(f.development);f.development.validate=async(...args)=>{const result=await original(...args);f.state.sessions[0].pluginDevelopment=false;return result;};await assert.rejects(f.development.engineCall('native-chat',{action:'apply',pluginId:'revoke-helper',digest:draft.digest,expectedRevision:'new'}),{code:'PLUGIN_DEVELOPMENT_DENIED'});assert.equal(f.host.records.has('revoke-helper'),false);
});
test('draft traversal, symlinks and builtin edits are rejected',async t=>{
  const f=await fixture(t);const draft=await f.call({action:'create',pluginId:'path-helper'});await assert.rejects(f.write(draft,'../outside.mjs','bad'),{code:'INVALID_PLUGIN'});await symlink('/tmp',path.join(draft.root,'escaped'));await assert.rejects(f.call({action:'files',pluginId:'path-helper'}),{code:'INVALID_PLUGIN'});f.host.records.set('builtin-one',{builtin:true});await assert.rejects(f.call({action:'create',pluginId:'builtin-one'}),{code:'INVALID_PLUGIN'});f.host.records.delete('builtin-one');
});
test('changed installed code is detected before import and startup restores the last intact version',async t=>{
  const f=await fixture(t);let draft=await f.call({action:'create',pluginId:'corrupt-helper'});const first=await f.apply(draft);draft=await f.call({action:'files',pluginId:'corrupt-helper'});draft=await f.write(draft,'notes.md','second version');await f.apply(draft);
  await writeFile(path.join(f.host.records.get('corrupt-helper').root,'index.mjs'),"throw Error('changed code must never run');");await f.restart();assert.equal(f.host.list()[0].revision,first.plugin.revision);assert.equal((await f.host.callTool('corrupt-helper:status',{})).version,'1.0.0');assert.equal(f.host.settings.lastChange.status,'rolledBack');
});
test('an unexpected tool runtime exception restores the previous version after the call unwinds',async t=>{
  const f=await fixture(t);let draft=await f.call({action:'create',pluginId:'runtime-helper'});await f.apply(draft);draft=await f.call({action:'files',pluginId:'runtime-helper'});draft=await f.write(draft,'index.mjs',"export function apply(ctx,host){host.registerTool({name:'status',description:'status',inputSchema:{type:'object'},execute:async()=>{throw Error('broken tool')}});}");await f.apply(draft);await assert.rejects(f.host.callTool('runtime-helper:status',{}));await f.host.serial;assert.equal((await f.host.callTool('runtime-helper:status',{})).version,'1.0.0');assert.equal(f.host.settings.lastChange.reason,'PLUGIN_RUNTIME_FAILED');
});
test('explicit stop cancels cooperative plugin work without replay or automatic code rollback',async t=>{
  const f=await fixture(t);let started;const began=new Promise(resolve=>{started=resolve;});f.host.services.started=started;let draft=await f.call({action:'create',pluginId:'stop-helper'});draft=await f.write(draft,'index.mjs',"export function apply(ctx,host){host.registerTool({name:'wait',description:'wait',inputSchema:{type:'object'},execute:async(input,{signal})=>{host.started();return new Promise(resolve=>signal.addEventListener('abort',()=>resolve({stopped:true}),{once:true}));}});}");await f.apply(draft);const revision=f.host.list()[0].revision;
  const work=f.development.engineCall('native-chat',{action:'call',toolId:'stop-helper:wait'});const rejected=assert.rejects(work,{code:'PLUGIN_CHAT_INACTIVE'});await began;f.state.sessions[0].runRecovery.userStopped=true;await rejected;assert.equal(f.host.list()[0].revision,revision);assert.equal(f.host.records.get('stop-helper').toolPending.size,0);
});
