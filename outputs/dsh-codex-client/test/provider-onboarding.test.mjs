import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {EventEmitter} from 'node:events';
import {ModelProviders} from '../server/model-providers.mjs';
import {resolveGoKey} from '../server/credentials.mjs';
async function fixture(t,options={}){
 const dataDir=await mkdtemp(path.join(tmpdir(),'dsh-provider-onboarding-'));
 t.after(()=>rm(dataDir,{recursive:true,force:true}));
 return new ModelProviders({dataDir,resolveLegacyKey:async()=>null,...options}).load();
}
async function setKey(store,id,apiKey){const provider=store.public().providers.find(p=>p.id===id);return store.mutate({...provider,apiKey,revision:store.state.revision});}
async function proxy(store,{provider='deepseek',api='openai-responses',model='deepseek-flash',action,body={}}={}){
 const request=Readable.from([JSON.stringify({model,input:'Hello',...body})]);request.method='POST';request.headers={authorization:'Bearer local-test'};
 const response=new EventEmitter();let bytes='';response.headersSent=false;response.writeHead=(status)=>{response.status=status;response.headersSent=true;};response.write=chunk=>{bytes+=typeof chunk==='string'?chunk:Buffer.from(chunk).toString('utf8');return true;};response.end=chunk=>{bytes+=chunk??'';};response.destroy=()=>{response.destroyed=true;};
 await store.proxy(request,response,{provider,api,action:action??(api==='openai-responses'?'responses':api==='anthropic-messages'?'messages':'chat/completions'),bearer:'local-test'});
 return {status:response.status,body:bytes,destroyed:response.destroyed};
}
test('clean install never advertises missing legacy credentials or selects it ahead of official setup',async t=>{
 const store=await fixture(t);
 assert.equal(store.models('codex')[0].providerId,'deepseek');
 assert(store.models('codex').every(m=>m.available===false&&m.unavailableReason==='MODEL_KEY_REQUIRED'));
 assert.equal(store.public().providers.find(p=>p.id==='opencode_go').keyConfigured,false);
 await assert.rejects(store.preflight('@deepseek/deepseek-flash','codex'),e=>e.code==='MODEL_KEY_REQUIRED'&&e.providerId==='deepseek'&&e.action==='open-model-settings');
});
test('official configured route is preferred, key deletion revokes readiness, and history IDs remain resolvable',async t=>{
 const store=await fixture(t,{resolveLegacyKey:async()=> 'go-only-test-key',legacyModels:[{id:'historic-model',name:'Historical',contextWindow:8192,maxTokens:2048}]});
 assert.equal(store.models('codex')[0].id,'historic-model');
 await setKey(store,'deepseek','deepseek-only-test-key');
 assert.equal(store.models('codex')[0].id,'@deepseek/deepseek-flash');
 assert.equal((await store.preflight('@deepseek/deepseek-flash','codex')).inferenceTested,false);
 assert.equal(store.resolve('historic-model','codex').model,'historic-model');
 await setKey(store,'deepseek',null);
 await assert.rejects(store.preflight('@deepseek/deepseek-flash','codex'),{code:'MODEL_KEY_REQUIRED'});
 const reloaded=await new ModelProviders({dataDir:path.dirname(store.file),resolveLegacyKey:async()=>null}).load();
 assert.equal(reloaded.resolve('historic-model','codex').model,'historic-model');
 assert(!JSON.stringify(reloaded.public()).includes('deepseek-only-test-key'));
});
test('credential resolver never asks for a DeepSeek credential when resolving Go',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'dsh-provider-key-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const file=path.join(root,'fixture.yaml');await writeFile(file,'fixture: only\n',{mode:0o600});
 const requested=[];let disposed=false;
 const context={plugin:async()=>{},credentials:{resolve:async name=>{requested.push(name);return name==='DEEPSEEK_API_KEY'?{value:'must-not-use'}:null;}},fiber:{dispose:async()=>{disposed=true;}}};
 await assert.rejects(resolveGoKey({env:{},credentialFile:file,createContext:()=>context,credentialPlugin:{}}),/MISSING_GO_CREDENTIAL/);
 assert.deepEqual(requested,['OPENCODE_GO_API_KEY']);assert.equal(disposed,true);
 assert.equal(await readFile(file,'utf8'),'fixture: only\n');
});
test('missing keys fail before fetch and proxy retains structured settings action',async t=>{
 let calls=0;const store=await fixture(t,{fetchImpl:async()=>{calls++;throw Error('unexpected fetch');}});
 const response=await proxy(store);assert.equal(calls,0);assert.equal(response.status,400);
 const error=JSON.parse(response.body).error;assert.equal(error.code,'MODEL_KEY_REQUIRED');assert.equal(error.providerId,'deepseek');assert.equal(error.action,'open-model-settings');
});
test('provider credentials stay on their routes and only official translated requests disable thinking',async t=>{
 const requests=[];const store=await fixture(t,{resolveLegacyKey:async()=> 'go-key',fetchImpl:async(url,options)=>{requests.push({url,options});return new Response(JSON.stringify({choices:[{message:{role:'assistant',content:'ok'},finish_reason:'stop'}]}));}});
 await setKey(store,'deepseek','official-key');
 await proxy(store);
 assert.equal(requests[0].options.headers.authorization,'Bearer official-key');
 assert.deepEqual(JSON.parse(requests[0].options.body).thinking,{type:'disabled'});
 assert.equal(store.models('codex').find(m=>m.providerId==='deepseek').reasoningSupported,false);
 await proxy(store,{api:'openai-completions',body:{messages:[{role:'user',content:'hello'}],thinking:{type:'enabled'}}});
 assert.deepEqual(JSON.parse(requests[1].options.body).thinking,{type:'enabled'});
});
test('upstream failures expose bounded typed errors without echoing body or credentials',async t=>{
 let status=401;const store=await fixture(t,{fetchImpl:async()=>new Response('secret-upstream-contents',{status})});await setKey(store,'deepseek','private-key');
 for(const [httpStatus,code]of [[401,'MODEL_AUTH_FAILED'],[402,'MODEL_QUOTA_EXCEEDED'],[429,'MODEL_RATE_LIMITED'],[503,'MODEL_SERVICE_UNAVAILABLE']]){
   status=httpStatus;const response=await proxy(store);assert.equal(response.status,status);assert.equal(JSON.parse(response.body).error.code,code);assert(!response.body.includes('secret-upstream-contents'));assert(!response.body.includes('private-key'));
 }
});

test('translated image inputs are rejected during local preflight before any request',async t=>{
 let calls=0;const store=await fixture(t,{fetchImpl:async()=>{calls++;throw Error('unexpected');}});await setKey(store,'deepseek','official-key');
 for(const type of ['image','localImage','input_image'])await assert.rejects(store.preflight('@deepseek/deepseek-flash','codex',{input:[{type,url:'fixture'}]}),{code:'MODEL_INPUT_UNSUPPORTED'});
 assert.equal(calls,0);assert.equal((await store.preflight('@deepseek/deepseek-flash','codex',{input:[{type:'text',text:'hello'}]})).ready,true);
});
test('legacy credentials cannot be redirected to a different provider origin',async t=>{
 const store=await fixture(t,{resolveLegacyKey:async()=> 'go-key'}),p=store.public().providers.find(p=>p.id==='opencode_go');
 await assert.rejects(store.mutate({...p,revision:store.state.revision,baseURL:'https://example.invalid',apiKey:'explicit-test-key'}),{code:'MODEL_CONFIG_INVALID'});
});
test('persisted provider catalog is authoritative over old model migration input',async t=>{
 const store=await fixture(t,{legacyModels:[{id:'preserved',name:'Preserved'}]});await setKey(store,'deepseek','fixture-key');
 const next=await new ModelProviders({dataDir:path.dirname(store.file),legacyModels:[{id:'must-not-overwrite',name:'Other'}]}).load();
 assert(next.models().some(m=>m.id==='preserved'));assert(!next.models().some(m=>m.id==='must-not-overwrite'));
});
test('transport failures are distinct from authentication and protocol failures',async t=>{
 const store=await fixture(t,{fetchImpl:async()=>{throw new TypeError('network connection failed with private details');}});await setKey(store,'deepseek','fixture-key');
 const result=await proxy(store);assert.equal(JSON.parse(result.body).error.code,'MODEL_NETWORK_FAILED');assert(!result.body.includes('private details'));
});

test('nonstream translated protocol failure returns a typed error before any success headers',async t=>{
 const store=await fixture(t,{fetchImpl:async()=>new Response(JSON.stringify({choices:[{message:{content:'incomplete'},finish_reason:null}]}))});await setKey(store,'deepseek','fixture-key');
 const result=await proxy(store);assert.equal(result.status,502);assert.equal(JSON.parse(result.body).error.code,'MODEL_STREAM_INCOMPLETE');assert.equal(result.destroyed,undefined);
});
test('translated count_tokens is rejected locally, while direct unauthenticated counting remains available',async t=>{
 const requests=[];const store=await fixture(t,{fetchImpl:async(url,options)=>{requests.push({url,options});return new Response(JSON.stringify({input_tokens:12}));}});
 const provider={id:'local',name:'Local fixture',api:'openai-completions',baseURL:'http://127.0.0.1:11434/v1',auth:'none',enabled:true,models:[{id:'local-model'}],revision:store.state.revision};
 await store.mutate(provider);
 assert.equal((await store.preflight('@local/local-model','claude-code')).ready,true);
 await assert.rejects(proxy(store,{provider:'local',model:'local-model',api:'anthropic-messages',action:'messages/count_tokens',body:{messages:[{role:'user',content:'count only'}]}}),{code:'MODEL_ENGINE_UNSUPPORTED'});
 assert.equal(requests.length,0);
 await store.mutate({...provider,api:'anthropic-messages',revision:store.state.revision});
 const direct=await proxy(store,{provider:'local',model:'local-model',api:'anthropic-messages',action:'messages/count_tokens',body:{messages:[{role:'user',content:'count only'}]}});
 assert.equal(direct.status,200);assert.equal(JSON.parse(direct.body).input_tokens,12);assert.equal(requests.length,1);assert.equal(requests[0].url,'http://127.0.0.1:11434/v1/messages/count_tokens');assert.equal(requests[0].options.headers['x-api-key'],undefined);
});

test('migration preserves historical ID/name bounds and the full existing 10000-model budget across reload',async t=>{
 const longId='historic-'+ 'x'.repeat(247),longName='历史'.repeat(512);
 const legacyModels=Array.from({length:10000},(_,i)=>({id:i===0?longId:`historical-${i}`,name:i===0?longName:`Historical ${i}`}));
 const store=await fixture(t,{legacyModels});
 assert.equal(store.models().length,10000);assert.equal(store.resolve(longId,'codex').name,longName);
 assert.equal(store.resolve('historical-9999','codex').model,'historical-9999');
 await setKey(store,'opencode_go','fixture-go-key');
 const saved=await readFile(store.file);assert(saved.length<8*1024*1024);
 const next=await new ModelProviders({dataDir:path.dirname(store.file)}).load();
 assert.equal(next.models().length,10000);assert.equal(next.resolve(longId,'codex').name,longName);
 assert.equal(next.resolve('historical-9999','codex').model,'historical-9999');
 // Wider compatibility applies only to the historical provider, not new inputs.
 await assert.rejects(next.mutate({id:'custom',name:'Custom',api:'openai-completions',baseURL:'https://example.invalid',auth:'none',models:[{id:longId}],revision:next.state.revision}),{code:'MODEL_CONFIG_INVALID'});
});

test('oversized provider saves cannot replace a readable catalog with an unreadable file',async t=>{
 const store=await fixture(t);await setKey(store,'opencode_go','fixture-go-key');
 const before=await readFile(store.file,'utf8'),revision=store.state.revision;
 const provider=store.public().providers.find(p=>p.id==='opencode_go');
 await assert.rejects(store.mutate({...provider,models:Array.from({length:9000},(_,i)=>({id:`large-${i}`,name:'x'.repeat(1024)})),revision}),{code:'MODEL_STORAGE_INVALID'});
 assert.equal(await readFile(store.file,'utf8'),before);assert.equal(store.state.revision,revision);
});
