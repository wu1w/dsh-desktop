import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {startHost} from '../server/index.mjs';
import {SharedContext,agentInstructions,contextText} from '../server/shared-context.mjs';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
class FixtureEngine extends EventEmitter{
 constructor(options,failures){super();this.options=options;this.failures=failures;this.activeTurns=new Map();this.ready=false;this.model='deepseek-v4.1-flash';this.provider='fixture';this.rows={};}
 async start(){await mkdir(this.options.dataDir,{recursive:true});this.file=path.join(this.options.dataDir,'fixture.json');try{this.rows=JSON.parse(await readFile(this.file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}this.ready=true;}
 async save(){await writeFile(this.file,JSON.stringify(this.rows));}
 async createSession(id,options){if(this.failures.create)throw Object.assign(new Error('PROTOCOL'),{code:'PROTOCOL'});this.rows[id]={sessionId:id,threadId:randomUUID(),model:this.model,...options,turns:[],queue:[]};await this.save();return this.rows[id];}
 async readSession(id){const row=this.rows[id];if(!row)throw Error('NOT_FOUND');return{...row,thread:{id:row.threadId,turns:row.turns}};}
 async resumeSession(id){return this.rows[id];}
 async readTurnState(id,turnId){const turn=this.rows[id]?.turns.find(t=>t.id===turnId);return{known:!!turn,turnId,status:turn?.status,terminal:!!turn&&turn.status!=='inProgress',active:this.activeTurns.has(id)};}
 async queueRequest(id,action,params={}){const row=this.rows[id];if(action==='list')return{data:row.queue,nextCursor:null};if(action==='add'){const entry={id:randomUUID(),...params,status:'queued'};row.queue.push(entry);await this.save();return entry;}throw Error('unsupported');}
 async startTurn(id,input){const row=this.rows[id],turn={id:randomUUID(),status:'inProgress',items:[{id:randomUUID(),type:'userMessage',content:input}]};row.turns.push(turn);this.activeTurns.set(id,{turnId:turn.id});await this.save();this.emit('notification',{method:'turn/started',params:{threadId:row.threadId,turn}});return{turnId:turn.id,status:turn.status};}
 async finish(id,text){const row=this.rows[id],turn=row.turns.at(-1);turn.items.push({id:randomUUID(),type:'agentMessage',text});turn.status='completed';this.activeTurns.delete(id);await this.save();this.emit('notification',{method:'item/completed',params:{threadId:row.threadId,turnId:turn.id,item:turn.items.at(-1)}});this.emit('notification',{method:'turn/completed',params:{threadId:row.threadId,turn}});}
 async renameSession(id,name){this.rows[id].name=name;await this.save();}
 async archiveSession(id){this.rows[id].archived=true;await this.save();}
 async dispose(){this.ready=false;this.emit('exit');}
}
async function fixture(t){const root=await mkdtemp(path.join(tmpdir(),'dsh-shared-test-'));await mkdir(path.join(root,'project'));await mkdir(path.join(root,'global'));let host;const failures={};
 const boot=async()=>{host=await startHost({dataDir:path.join(root,'data'),autoStart:false,instructionOptions:{globalRoot:path.join(root,'global')}});for(const id of ['codex','claude-code','dsh-native'])host.plugins.engines.set(id,{pluginId:'engine-'+id,capabilities:{},create:async options=>{const engine=new FixtureEngine(options,failures);return{engine,dispose:()=>engine.dispose()};}});const response=await fetch(host.url+'/api/bootstrap'),boot=await response.json(),headers={cookie:response.headers.get('set-cookie').split(';')[0],'x-dsh-capability':boot.capability,'content-type':'application/json'};
 const api=async(route,body)=>{const response=await fetch(host.url+'/api/'+route,{headers,method:body===undefined?'GET':'POST',body:body===undefined?undefined:JSON.stringify(body)});return{httpStatus:response.status,...await response.json()};};await api('engine/enable',{});return api;};
 let api=await boot();t.after(async()=>{await host.close();await rm(root,{recursive:true,force:true});});const project=await api('projects',{path:path.join(root,'project')});const session=await api('sessions',{projectId:project.id,title:'Shared sentinel'});
 return{root,failures,project,session,get host(){return host;},api:(...args)=>api(...args),restart:async()=>{await host.close();api=await boot();}};}
async function terminal(f){for(let i=0;i<100;i++){if((await f.api('state')).sessions.every(s=>s.runRecovery?.status!=='running'))return;await wait(10);}assert.fail('not terminal');}
async function turn(f,text){assert.equal((await f.api('sessions/'+f.session.id+'/turn',{text})).httpStatus,200);const state=await f.api('state'),s=state.sessions.find(s=>s.id===f.session.id);await f.host.engine.nativeEngine.finish(s.engineSessionId??s.id,'answer '+text);await terminal(f);}
test('same chat retains full history, MD, queue and draft across A-B-C-A and host restart',async t=>{
 const f=await fixture(t);await writeFile(path.join(f.root,'project','AGENTS.md'),'AGENT_SENTINEL');await mkdir(path.join(f.root,'project','memory'));await writeFile(path.join(f.root,'project','memory','facts.md'),'MEMORY_SENTINEL');
 await f.api('preferences',{drafts:{[f.session.id]:'draft untouched'},selected:f.session.id});
 await turn(f,'first fact');
 // More than the live transcript cache: the first item must still transfer.
 const native=f.host.engine.nativeEngine;for(let i=0;i<230;i++)native.rows[f.session.id].turns.push({id:randomUUID(),status:'completed',items:[{id:randomUUID(),type:'agentMessage',text:'old '+i}]});await native.save();
 for(const id of ['claude-code','dsh-native','codex']){
  const switched=await f.api('engine/select',{id});assert.equal(switched.httpStatus,200,JSON.stringify(switched));assert.equal(switched.selectedEngine,id);assert.equal(switched.sessions[0].id,f.session.id);
  const row=f.host.engine.nativeEngine.rows[switched.sessions[0].engineSessionId];assert.match(row.sharedContext,/first fact/);assert.match(row.sharedContext,/AGENT_SENTINEL/);assert.match(row.sharedContext,/MEMORY_SENTINEL/);
  await turn(f,id+' fact');
 }
 await f.api('sessions/'+f.session.id+'/queue/add',{text:'queued preserved'});
 assert.equal((await f.api('engine/select',{id:'claude-code'})).httpStatus,200);
 assert.equal((await f.api('sessions/'+f.session.id+'/queue')).queue[0].input[0].text,'queued preserved');
 await f.restart();const state=await f.api('state');assert.equal(state.selectedEngine,'claude-code');assert.equal(state.preferences.drafts[f.session.id],'draft untouched');
 const items=[];let page=await f.api('sessions/'+f.session.id);items.push(...page.items);while(page.history?.nextCursor){page=await f.api('sessions/'+f.session.id+'/history?cursor='+encodeURIComponent(page.history.nextCursor));items.unshift(...page.items);}
 assert.ok(items.some(item=>item.text==='first fact'));assert.ok(items.some(item=>item.text==='codex fact'));assert.equal(items.length,238);assert.equal(new Set(items.map(i=>i.id)).size,items.length);
});
test('failed handoff restores selection, native binding and original context',async t=>{const f=await fixture(t);await turn(f,'keep me');f.failures.create=true;const failed=await f.api('engine/select',{id:'claude-code'});assert.equal(failed.httpStatus,400);const state=await f.api('state');assert.equal(state.selectedEngine,'codex');assert.equal(state.sessions[0].threadId,f.session.threadId);assert.equal(state.engine.state,'ready');assert.ok((await f.api('sessions/'+f.session.id)).items.some(i=>i.text==='keep me'));});
test('active work defers switch, can cancel, and switches after completion without replay',async t=>{const f=await fixture(t);await f.api('sessions/'+f.session.id+'/turn',{text:'one operation'});let next=await f.api('engine/select',{id:'dsh-native'});assert.equal(next.pendingEngine,'dsh-native');assert.equal(next.selectedEngine,'codex');assert.equal(f.host.engine.activeTurns.size,1);next=await f.api('engine/select',{id:'codex'});assert.equal(next.pendingEngine,null);await f.api('engine/select',{id:'claude-code'});await f.host.engine.nativeEngine.finish(f.session.id,'done once');for(let i=0;i<300;i++){next=await f.api('state');if(next.selectedEngine==='claude-code'&&!next.switchingEngine)break;await wait(10);}assert.equal(next.selectedEngine,'claude-code');const row=f.host.engine.nativeEngine.rows[next.sessions[0].engineSessionId];assert.equal(row.turns.length,0);assert.match(row.sharedContext,/done once/);});
test('agent context loads project scope and never silently truncates oversized settings',async t=>{const root=await mkdtemp(path.join(tmpdir(),'dsh-instructions-'));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(path.join(root,'one'));await mkdir(path.join(root,'two'));await writeFile(path.join(root,'one','SOUL.md'),'ONE_ONLY');await writeFile(path.join(root,'two','SOUL.md'),'TWO_ONLY');assert.match(contextText([],await agentInstructions(path.join(root,'one'),{globalRoot:path.join(root,'none')})),/ONE_ONLY/);assert.doesNotMatch(contextText([],await agentInstructions(path.join(root,'one'),{globalRoot:path.join(root,'none')})),/TWO_ONLY/);await writeFile(path.join(root,'one','MEMORY.md'),'x'.repeat(2*1024*1024));await assert.rejects(agentInstructions(path.join(root,'one'),{globalRoot:path.join(root,'none')}),{code:'CONTEXT_TOO_LARGE'});});
