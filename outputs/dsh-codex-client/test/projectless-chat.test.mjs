import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,mkdir,writeFile,readFile,rm,stat,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {startHost} from '../server/index.mjs';
import {SessionWorkspaces} from '../server/session-workspaces.mjs';
import {ClientStateStore} from '../server/client-state.mjs';
import {ScriptedAdapter,textChunk} from '../native-engine/lib/scripted-adapter.js';

const delay=()=>new Promise(resolve=>setTimeout(resolve,10));
async function connection(host){const response=await fetch(host.url+'/api/bootstrap'),boot=await response.json(),headers={cookie:response.headers.get('set-cookie').split(';')[0],'x-dsh-capability':boot.capability,'content-type':'application/json'};return async(route,body)=>{const response=await fetch(host.url+'/api/'+route,{headers,method:body===undefined?'GET':'POST',body:body===undefined?undefined:JSON.stringify(body)}),data=await response.json();if(!response.ok)throw Object.assign(Error(data.code),data);return data;};}
async function until(fn){for(let i=0;i<500;i++){const result=await fn();if(result)return result;await delay();}assert.fail('chat did not settle');}
async function fixture(t,handler=()=>textChunk('A real saved answer')){
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'dsh-projectless-test-'))),dataDir=path.join(root,'data'),globalRoot=path.join(root,'global');await mkdir(dataDir);await mkdir(globalRoot);await writeFile(path.join(root,'AGENTS.md'),'UNRELATED_ANCESTOR_SETTING');await writeFile(path.join(globalRoot,'AGENTS.md'),'GLOBAL_AGENT_ONE');await writeFile(path.join(globalRoot,'MEMORY.md'),'GLOBAL_MEMORY_ONE');
 const store=new ClientStateStore({dataDir}),loaded=await store.load();loaded.state.preferences.selectedEngine='dsh-native';await store.save(loaded.state);
 const adapter=new ScriptedAdapter(handler),options={dataDir,instructionOptions:{globalRoot},engineOptions:{adapter}};let host=await startHost(options),api=await connection(host);
 t.after(async()=>{await host.close();await rm(root,{recursive:true,force:true});});
 return{root,dataDir,globalRoot,adapter,get api(){return api;},get host(){return host;},async restart(){await host.close();host=await startHost(options);api=await connection(host);},async turn(session,text){await api(`sessions/${session.id}/turn`,{text,permission:'read-only'});await until(async()=>{const s=(await api('state')).sessions.find(s=>s.id===session.id);return !s.running&&s.runRecovery?.status==='completed';});return api(`sessions/${session.id}`);}};
}

test('projectless chat keeps global memory and history through restart without inventing a project',{timeout:15000},async t=>{
 const f=await fixture(t),s=await f.api('sessions',{});assert.equal(s.projectId,null);assert.deepEqual((await f.api('state')).projects,[]);
 const first=await f.turn(s,'Remember the first conversation fact');assert.ok(first.items.some(i=>i.text==='A real saved answer'));
 assert.match(JSON.stringify(f.adapter.calls[0]),/GLOBAL_AGENT_ONE/);assert.match(JSON.stringify(f.adapter.calls[0]),/GLOBAL_MEMORY_ONE/);assert.doesNotMatch(JSON.stringify(f.adapter.calls[0]),/UNRELATED_ANCESTOR_SETTING/);
 const before=await f.host.engine.readSession(s.id),cwd=before.cwd;assert.ok(cwd.startsWith(path.join(f.dataDir,'chat-runtime')+path.sep));assert.equal((await stat(cwd)).mode&0o777,0o700);
 await f.api('preferences',{selected:s.id,projectId:null,drafts:{[s.id]:'saved unsent thought'}});
 await f.restart();assert.equal(f.adapter.calls.length,1,'restart never resends the previous message');const state=await f.api('state');assert.equal(state.preferences.projectId,null);assert.equal(state.preferences.drafts[s.id],'saved unsent thought');assert.equal(state.sessions[0].projectId,null);
 const restored=await f.api(`sessions/${s.id}`);assert.deepEqual(restored.items.map(i=>[i.type,i.text]),first.items.map(i=>[i.type,i.text]));assert.equal((await f.host.engine.readSession(s.id)).cwd,cwd);
 await writeFile(path.join(f.globalRoot,'AGENTS.md'),'GLOBAL_AGENT_TWO');await f.turn(s,'Continue this same conversation');assert.match(JSON.stringify(f.adapter.calls.at(-1)),/Remember the first conversation fact/);assert.match(JSON.stringify(f.adapter.calls.at(-1)),/GLOBAL_AGENT_TWO/);assert.match(JSON.stringify(f.adapter.calls.at(-1)),/GLOBAL_MEMORY_ONE/);
 await f.api(`sessions/${s.id}/archive`,{});assert.equal((await f.api('state')).sessions[0].archived,true);await f.api(`sessions/${s.id}/restore`,{});assert.equal((await f.api('state')).sessions[0].archived,false);
});

test('independent chats have distinct private directories; invalid project IDs stay invalid',{timeout:15000},async t=>{
 const f=await fixture(t),one=await f.api('sessions',{projectId:null}),two=await f.api('sessions',{});assert.notEqual((await f.host.engine.readSession(one.id)).cwd,(await f.host.engine.readSession(two.id)).cwd);
 for(const projectId of ['',false,{},'missing-project'])await assert.rejects(f.api('sessions',{projectId}),{code:'NOT_FOUND'});
 await assert.rejects(f.api(`sessions/${one.id}/turn`,{text:'read',attachments:[{path:'../../client.json'}]}),{code:'OUTSIDE_PROJECT'});
 assert.equal(f.adapter.calls.length,0);assert.equal((await f.api('state')).sessions.length,2);
 const project=await f.api('projects',{path:f.globalRoot});const bound=await f.api('sessions',{projectId:project.id});assert.equal((await f.host.engine.readSession(bound.id)).cwd,f.globalRoot);
});

test('stopping, continuing and queued messages work in projectless conversations',{timeout:15000},async t=>{
 let hold=true;const f=await fixture(t,()=>hold?{hang:true}:textChunk('Continued once')),s=await f.api('sessions',{});
 await f.api(`sessions/${s.id}/turn`,{text:'An interrupted thought'});await until(()=>f.adapter.calls.length===1);
 await f.api(`sessions/${s.id}/queue/add`,{text:'A queued thought'});assert.equal((await f.api(`sessions/${s.id}/queue`)).queue.length,1);
 await f.api(`sessions/${s.id}/interrupt`,{});await until(async()=>!(await f.api('state')).sessions[0].running);assert.equal((await f.api('state')).sessions[0].runRecovery.userStopped,true);
 const queued=(await f.api(`sessions/${s.id}/queue`)).queue;await f.api(`sessions/${s.id}/queue/delete`,{id:queued[0].id});hold=false;
 await f.api(`sessions/${s.id}/resume`,{});await until(async()=>(await f.api('state')).sessions[0].runRecovery.status==='completed');assert.equal(f.adapter.calls.length,2);assert.ok((await f.api(`sessions/${s.id}`)).items.some(i=>i.text==='Continued once'));
});

test('private runtime rejects symlink roots and cannot turn a session ID into a path',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'dsh-private-path-'));t.after(()=>rm(root,{recursive:true,force:true}));const outside=path.join(root,'outside'),data=path.join(root,'data');await mkdir(outside);await mkdir(data);const spaces=new SessionWorkspaces(data,()=>assert.fail('not a project'));const session={id:'../../outside',projectId:null};assert.equal(path.dirname(spaces.path(session)),path.join(data,'chat-runtime'));
 await symlink(outside,path.join(data,'chat-runtime'));await assert.rejects(spaces.ensure(session),{code:'INVALID_PATH'});
});

test('nullable workspace persists while dangling and missing project bindings remain rejected',async t=>{
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'dsh-null-state-')));t.after(()=>rm(root,{recursive:true,force:true}));const store=new ClientStateStore({dataDir:root}),{state}=await store.load();state.sessions=[{id:'chat',threadId:'thread',projectId:null}];await store.save(state);assert.equal((await store.load()).state.sessions[0].projectId,null);
 for(const value of [undefined,'missing',false,0]){state.sessions[0].projectId=value;await assert.rejects(store.save(state),{code:'CLIENT_STATE_INVALID'});}assert.equal(JSON.parse(await readFile(path.join(root,'client.json'),'utf8')).sessions[0].projectId,null);
});

test('private chat attachments survive restart and cannot cross conversation directories',async t=>{const f=await fixture(t),a=await f.api('sessions',{}),b=await f.api('sessions',{});const result=await f.api(`sessions/${a.id}/attachments`,{files:[{name:'note.txt',mime:'text/plain',data:Buffer.from('private fixture attachment').toString('base64')}]});assert.equal(result.files.length,1);await assert.rejects(()=>f.api(`sessions/${b.id}/turn`,{text:'read this',attachments:result.files}),error=>error.code==='ENOENT');await f.restart();await f.api(`sessions/${a.id}/turn`,{text:'read this',attachments:result.files});await until(async()=>!(await f.api('state')).sessions.find(s=>s.id===a.id).running);assert.equal((await f.api('state')).projects.length,0);assert.match(JSON.stringify(f.adapter.calls.at(-1)),/note.txt/);});
test('goal executes through the real native loop, verifies completion and persists across restart',async t=>{const f=await fixture(t,options=>{const id=JSON.stringify(options).match(/DSH_GOAL_DONE:([a-f0-9-]{36})/)?.[1];return textChunk('Verified completion.\n[DSH_GOAL_DONE:'+id+']');}),s=await f.api('sessions',{});await f.api(`sessions/${s.id}/program`,{kind:'goal',objective:'Inspect a harmless fixture'});await until(async()=>(await f.api('state')).sessions[0].program?.status==='completed');assert.equal(f.adapter.calls.length,1);await f.restart();assert.equal((await f.api('state')).sessions[0].program.status,'completed');assert.equal(f.adapter.calls.length,1);});
test('pin and unread actions affect their named session and persist without an engine',async t=>{const f=await fixture(t),a=await f.api('sessions',{}),b=await f.api('sessions',{});await f.api('engine/disable',{});await f.api(`sessions/${b.id}/pin`,{});await f.api(`sessions/${b.id}/unread`,{});const rows=(await f.api('state')).sessions;assert.equal(rows.find(s=>s.id===b.id).unread,true);assert.equal(rows.find(s=>s.id===b.id).pinned,true);assert.equal(rows.find(s=>s.id===a.id).pinned,false);});

test('loop restores its due time after host restart and resumes exactly once without catch-up bursts',{timeout:20000},async t=>{
 const f=await fixture(t),s=await f.api('sessions',{});await f.api(`sessions/${s.id}/program`,{kind:'loop',objective:'Check the fixture once',intervalMs:10000});
 const next=await until(async()=>{const p=(await f.api('state')).sessions[0].program;return p.nextRunAt&&p;});assert.equal(f.adapter.calls.length,1);
 await f.restart();const restored=(await f.api('state')).sessions[0].program;assert.equal(restored.nextRunAt,next.nextRunAt);assert.equal(restored.iterations,1);assert.equal(f.adapter.calls.length,1);
 const deadline=Date.now()+12000;while(Date.now()<deadline&&f.adapter.calls.length<2)await new Promise(resolve=>setTimeout(resolve,100));assert.equal(f.adapter.calls.length,2);await until(async()=>!(await f.api('state')).sessions[0].running);
 await f.api(`sessions/${s.id}/program`,{action:'pause'});await f.restart();assert.equal((await f.api('state')).sessions[0].program.status,'paused');assert.equal(f.adapter.calls.length,2);
});
