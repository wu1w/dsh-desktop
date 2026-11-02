import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {startHost} from '../server/index.mjs';
import {ModelProviders} from '../server/model-providers.mjs';

class LocalEngine extends EventEmitter {
 constructor(){super();this.rows=new Map();this.calls=[];this.activeTurns=new Map();this.ready=false;this.provider='fixture';}
 async start(){this.ready=true;}
 async createSession(id,options){const row={sessionId:id,threadId:randomUUID(),...options,turns:[]};this.rows.set(id,row);return row;}
 async readSession(id){const row=this.rows.get(id);return {...row,thread:{id:row.threadId,turns:row.turns}};}
 async queueRequest(){return {data:[],nextCursor:null};}
 async setModel(id,model){this.rows.get(id).model=model;return this.rows.get(id);}
 async startTurn(id,input){this.calls.push({id,input,model:this.rows.get(id).model});const turn={id:randomUUID(),status:'completed',items:[]};this.rows.get(id).turns.push(turn);return {turn};}
 async readTurnState(id,turnId){const turn=this.rows.get(id).turns.find(t=>t.id===turnId);return {turnId,known:!!turn,status:turn?.status,terminal:!!turn};}
 async dispose(){this.ready=false;}
}
async function fixture(t){
 const root=await mkdtemp(path.join(tmpdir(),'dsh-official-api-'));let host;
 t.after(async()=>{await host?.close();await rm(root,{recursive:true,force:true});});
 await mkdir(path.join(root,'project'));await mkdir(path.join(root,'global'));
 host=await startHost({dataDir:path.join(root,'data'),autoStart:false,resolveLegacyKey:async()=>null,instructionOptions:{globalRoot:path.join(root,'global')}});
 const engine=new LocalEngine();host.plugins.engines.set('codex',{pluginId:'engine-codex',capabilities:{images:true},create:async()=>({engine,dispose:()=>engine.dispose()})});
 const response=await fetch(host.url+'/api/bootstrap'),bootstrap=await response.json();
 const headers={cookie:response.headers.get('set-cookie').split(';')[0],'x-dsh-capability':bootstrap.capability,'content-type':'application/json'};
 const api=async(route,body)=>{const response=await fetch(host.url+'/api/'+route,{headers,method:body===undefined?'GET':'POST',body:body===undefined?undefined:JSON.stringify(body)});return {httpStatus:response.status,...await response.json()};};
 assert.equal((await api('engine/enable',{})).httpStatus,200);
 const setKey=async key=>{const catalog=await api('model-providers'),provider=catalog.providers.find(p=>p.id==='deepseek');const result=await api('model-providers',{...provider,apiKey:key,revision:catalog.revision});assert.equal(result.httpStatus,200,JSON.stringify(result));};
 return {root,host,engine,api,setKey};
}
test('official first use blocks missing credentials before session/turn dispatch and accepts setup without fallback',async t=>{
 const f=await fixture(t);
 const clean=await f.api('state');assert.equal(clean.models[0].id,'@deepseek/deepseek-flash');assert(clean.models.every(m=>m.available===false));
 const missing=await f.api('sessions',{});assert.equal(missing.code,'MODEL_KEY_REQUIRED');assert.equal((await f.api('state')).sessions.length,0);assert.equal(f.engine.rows.size,0);
 await f.setKey('official-test-key');
 const session=await f.api('sessions',{});assert.equal(session.httpStatus,200,JSON.stringify(session));assert.equal(session.model,'@deepseek/deepseek-flash');
 const go=await f.api('sessions',{model:'deepseek-v4.1-flash'});assert.equal(go.code,'MODEL_KEY_REQUIRED');assert.equal(f.engine.rows.size,1,'explicit Go choice must not create an official session');
 await f.setKey(null);
 const rejected=await f.api(`sessions/${session.id}/turn`,{text:'Do not dispatch without a key'});assert.equal(rejected.code,'MODEL_KEY_REQUIRED');
 let state=await f.api('state');assert.equal(state.sessions[0].runRecovery,undefined);assert.equal(f.engine.calls.length,0);
 await f.setKey('official-test-key');
 const allowed=await f.api(`sessions/${session.id}/turn`,{text:'Local fixture reply only'});assert.equal(allowed.httpStatus,200,JSON.stringify(allowed));assert.equal(f.engine.calls.length,1);assert.equal(f.engine.calls[0].model,'@deepseek/deepseek-flash');
 state=await f.api('state');assert.equal(state.sessions[0].runRecovery.status,'completed');
});
test('explicit unconfigured existing Go session choice and translated images fail before task recovery admission',async t=>{
 const f=await fixture(t);await f.setKey('official-test-key');
 const project=await f.api('projects',{path:path.join(f.root,'project')});
 const session=await f.api('sessions',{projectId:project.id});assert.equal(session.httpStatus,200);
 await writeFile(path.join(f.root,'project','fixture.png'),Buffer.from([137,80,78,71]));
 const image=await f.api(`sessions/${session.id}/turn`,{text:'Inspect image',attachments:[{path:'fixture.png',mime:'image/png'}]});assert.equal(image.code,'MODEL_INPUT_UNSUPPORTED');
 assert.equal(f.engine.calls.length,0);assert.equal((await f.api('state')).sessions[0].runRecovery,undefined);
 assert.equal((await f.api(`sessions/${session.id}/model`,{model:'deepseek-v4.1-flash'})).httpStatus,200);
 const go=await f.api(`sessions/${session.id}/turn`,{text:'Keep my explicit route'});assert.equal(go.code,'MODEL_KEY_REQUIRED');
 const row=(await f.api('state')).sessions[0];assert.equal(row.model,'deepseek-v4.1-flash');assert.equal(row.runRecovery,undefined);assert.equal(f.engine.calls.length,0);
});
test('all official engine routes retain the official origin and exact credential',async t=>{
 const dataDir=await mkdtemp(path.join(tmpdir(),'dsh-official-routes-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));const requests=[];
 const store=await new ModelProviders({dataDir,resolveLegacyKey:async()=> 'must-not-use-go-key',fetchImpl:async(url,options)=>{requests.push({url,options});return new Response(JSON.stringify({choices:[{message:{content:'fixture'},finish_reason:'stop'}]}));}}).load();
 await store.mutate({...store.public().providers.find(p=>p.id==='deepseek'),apiKey:'official-test-key',revision:store.state.revision});
 for(const engine of ['codex','claude-code','dsh-native']){
  const route=store.resolve('@deepseek/deepseek-flash',engine),api=route.api,request=Readable.from([JSON.stringify({model:route.model,...(api==='openai-responses'?{input:'hello'}:{messages:[{role:'user',content:'hello'}]})})]);
  request.method='POST';request.headers={authorization:'Bearer local-test'};const response=new EventEmitter();response.writeHead=()=>{response.headersSent=true;};response.write=()=>true;response.end=()=>{};response.destroy=()=>assert.fail('unexpected stream destruction');
  await store.proxy(request,response,{provider:route.provider,api,action:api==='openai-responses'?'responses':api==='anthropic-messages'?'messages':'chat/completions',bearer:'local-test'});
 }
 assert.deepEqual(requests.map(r=>new URL(r.url).origin),Array(3).fill('https://api.deepseek.com'));
 assert.deepEqual(requests.map(r=>new URL(r.url).pathname),['/chat/completions','/anthropic/v1/messages','/chat/completions']);
 for(const {options}of requests){assert.equal(options.headers.authorization??options.headers['x-api-key'],options.headers.authorization?'Bearer official-test-key':'official-test-key');assert(!JSON.stringify(options).includes('must-not-use-go-key'));}
});
