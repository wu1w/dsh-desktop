import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {startHost} from '../server/index.mjs';
const tick=()=>new Promise(resolve=>setImmediate(resolve));

async function fixture(t){
 const root=await mkdtemp(path.join(tmpdir(),'dsh-abandon-api-')),dataDir=path.join(root,'data'),rows=new Map(),engines=[],calls=[];
 let loseAck=true,host;
 class Engine extends EventEmitter{
  constructor(){super();this.ready=false;this.activeTurns=new Map();this.model='deepseek-v4.1-flash';}
  async start(){this.ready=true;}
  async createSession(id,options){const row={sessionId:id,threadId:randomUUID(),...options,turns:[]};rows.set(id,row);return row;}
  async resumeSession(id){return rows.get(id);}
  async readSession(id){const row=rows.get(id);return{...row,thread:{id:row.threadId,turns:row.turns}};}
  async readTurnState(id,turnId){const turn=rows.get(id)?.turns.find(turn=>turn.id===turnId);return turn?{known:true,turnId:turn.id,status:turn.status,terminal:turn.status!=='inProgress'}:{known:false};}
  async archiveSession(id){rows.get(id).archived=true;}
  async restoreSession(id){rows.get(id).archived=false;}
  async queueRequest(){return{data:[],nextCursor:null};}
  async startTurn(id,input){
   calls.push({id,input});if(loseAck)throw Object.assign(Error('lost ACK'),{code:'TIMEOUT'});
   const row=rows.get(id),turn={id:randomUUID(),status:'inProgress',items:[{id:randomUUID(),type:'userMessage',content:input}]};row.turns.push(turn);this.activeTurns.set(id,{turnId:turn.id});this.emit('notification',{method:'turn/started',params:{threadId:row.threadId,turn}});return{turn};
  }
  async interrupt(id){this.activeTurns.delete(id);}
  async dispose(){this.ready=false;this.activeTurns.clear();for(const row of rows.values())for(const turn of row.turns)if(turn.status==='inProgress')turn.status='interrupted';this.disposed=true;this.emit('exit');}
 }
 await mkdir(path.join(root,'global'));
 host=await startHost({dataDir,autoStart:false,resolveLegacyKey:async()=> 'fixture-key',instructionOptions:{globalRoot:path.join(root,'global')}});
 host.plugins.engines.set('codex',{pluginId:'engine-codex',capabilities:{},create:async()=>{const engine=new Engine();engines.push(engine);return{engine,dispose:()=>engine.dispose()};}});
 t.after(async()=>{await host.close();await rm(root,{recursive:true,force:true});});
 const response=await fetch(host.url+'/api/bootstrap'),bootstrap=await response.json(),headers={'content-type':'application/json','x-dsh-capability':bootstrap.capability,cookie:response.headers.get('set-cookie').split(';')[0]};
 const api=async(route,body)=>{const response=await fetch(host.url+'/api/'+route,{headers,method:body===undefined?'GET':'POST',body:body===undefined?undefined:JSON.stringify(body)});return{httpStatus:response.status,...await response.json()};};
 assert.equal((await api('engine/enable',{})).httpStatus,200);const session=await api('sessions',{});assert.equal(session.httpStatus,200,JSON.stringify(session));
 return{root,dataDir,host,api,session,engines,calls,setLoseAck:value=>{loseAck=value;}};
}

test('abandon unknown dispatch disposes its engine, keeps evidence and ignores late events until explicit new work',async t=>{
 const f=await fixture(t),route='sessions/'+f.session.id;
 assert.equal((await f.api(route+'/turn',{text:'original request'})).code,'TIMEOUT');
 let session=(await f.api('state')).sessions.find(s=>s.id===f.session.id);assert.equal(session.runRecovery.status,'uncertain');assert.equal(session.runRecovery.turnId,null);const oldId=session.runRecovery.id,old=f.engines[0];
 const result=await f.api(route+'/abandon',{});assert.equal(result.httpStatus,200,JSON.stringify(result));assert.equal(result.engineStopped,true);assert.equal(result.outcome,'unknown');assert.equal(f.host.engine,null);assert.equal(old.disposed,true);
 session=(await f.api('state')).sessions.find(s=>s.id===f.session.id);assert.equal(session.runRecovery.reason,'abandoned');assert.equal(session.runRecovery.canResume,false);assert.equal(session.abandonedRuns[0].id,oldId);assert.equal(session.abandonedRuns[0].turnId,null);assert.equal(session.abandonedRuns[0].outcome,'unknown');
 const saved=JSON.parse(await readFile(path.join(f.dataDir,'client.json'),'utf8'));assert.equal(saved.sessions[0].abandonedRuns[0].id,oldId);
 old.emit('notification',{method:'turn/completed',params:{threadId:f.session.threadId,turn:{id:'late-unknown',status:'completed'}}});await tick();
 assert.equal((await f.api('state')).sessions[0].runRecovery.reason,'abandoned');assert.equal(f.calls.length,1);assert.equal(f.engines.length,1);
 assert.equal((await f.api(route+'/turn',{text:'not while disabled'})).code,'ENGINE_DISABLED');assert.equal((await f.api(route+'/resume',{})).code,'TASK_NOT_RESUMABLE');assert.equal(f.calls.length,1);
 f.setLoseAck(false);assert.equal((await f.api('engine/enable',{})).httpStatus,200);assert.equal(f.calls.length,1,'enabling must not replay abandoned input');
 assert.equal((await f.api(route+'/turn',{text:'explicit new task'})).httpStatus,200);await tick();const current=(await f.api('state')).sessions[0].runRecovery;
 old.emit('notification',{method:'turn/started',params:{threadId:f.session.threadId,turn:{id:'another-late-turn',status:'inProgress'}}});old.emit('notification',{method:'turn/completed',params:{threadId:f.session.threadId,turn:{id:'another-late-turn',status:'completed'}}});await tick();
 const after=(await f.api('state')).sessions[0];assert.equal(after.runRecovery.id,current.id);assert.equal(after.runRecovery.turnId,current.turnId);assert.equal(after.runRecovery.status,'running');assert.equal(after.abandonedRuns[0].id,oldId);
 assert.equal(f.calls.length,2);assert.equal(f.calls[1].input[0].text,'explicit new task');
});

test('archive and restore cannot make an explicitly abandoned known turn resumable',async t=>{
 const f=await fixture(t),route='sessions/'+f.session.id;f.setLoseAck(false);
 assert.equal((await f.api(route+'/turn',{text:'old task'})).httpStatus,200);await tick();
 assert.equal((await f.api('engine/disable',{})).httpStatus,200);
 assert.equal((await f.api('state')).sessions[0].runRecovery.status,'uncertain');
 assert.equal((await f.api(route+'/abandon',{})).httpStatus,200);
 assert.equal((await f.api('engine/enable',{})).httpStatus,200);
 assert.equal((await f.api(route+'/archive',{})).httpStatus,200);
 assert.equal((await f.api(route+'/restore',{})).httpStatus,200);
 const after=(await f.api('state')).sessions[0];assert.equal(after.runRecovery.reason,'abandoned');assert.equal(after.runRecovery.canResume,false);
 assert.equal((await f.api(route+'/resume',{})).code,'TASK_NOT_RESUMABLE');assert.equal(f.calls.length,1);
 assert.equal((await f.api(route+'/turn',{text:'explicit new task'})).httpStatus,200);assert.equal(f.calls.length,2);
});
