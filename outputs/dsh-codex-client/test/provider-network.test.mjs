import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {ModelProviders} from '../server/model-providers.mjs';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){for(let n=0;n<100;n++){if(check())return;await pause(20);}assert.fail('loopback cleanup timed out');}

test('real loopback provider transport handles missing key, typed errors, stream interruption, cancellation and recovery',{timeout:20000},async t=>{
 const dataDir=await mkdtemp(path.join(tmpdir(),'dsh-provider-network-'));let mode='complete',calls=0,upstreamClosed=false;
 const upstream=http.createServer(async(req,res)=>{
  calls++;let bytes='';for await(const part of req)bytes+=part;
  assert.equal(req.url,'/chat/completions');assert.equal(req.headers.authorization,'Bearer local-fixture-key');assert.equal(req.headers.cookie,undefined);assert(Array.isArray(JSON.parse(bytes).messages));
  if(mode==='auth'){res.writeHead(401);res.end('PRIVATE_UPSTREAM_SENTINEL');return;}
  res.writeHead(200,{'content-type':'text/event-stream'});
  res.write('data: '+JSON.stringify({choices:[{index:0,delta:{content:'loopback reply'},finish_reason:null}]})+'\n\n');
  if(mode==='hold'){res.on('close',()=>{upstreamClosed=true;});return;}
  if(mode==='interrupt'){setTimeout(()=>res.end(),30);return;}
  res.end('data: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
 });
 upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
 const store=await new ModelProviders({dataDir,resolveLegacyKey:async()=>null}).load();
 const saveKey=async apiKey=>store.mutate({id:'fixture',name:'Local fixture',api:'openai-completions',baseURL:`http://127.0.0.1:${upstream.address().port}`,auth:'key',apiKey,models:[{id:'fixture-model'}],revision:store.state.revision});
 await saveKey('local-fixture-key');
 const gateway=http.createServer((req,res)=>{store.proxy(req,res,{provider:'fixture',api:'openai-responses',action:'responses',bearer:'local-gateway-token'}).catch(()=>{res.writeHead(500);res.end();});});
 gateway.listen(0,'127.0.0.1');await once(gateway,'listening');
 t.after(async()=>{await store.close();for(const server of [gateway,upstream]){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}await rm(dataDir,{recursive:true,force:true});});
 const request=signal=>fetch(`http://127.0.0.1:${gateway.address().port}`,{method:'POST',signal,headers:{authorization:'Bearer local-gateway-token','content-type':'application/json',cookie:'local-private-cookie'},body:JSON.stringify({model:'fixture-model',input:'hello',stream:true})});
 await saveKey(null);const missing=await request();assert.equal((await missing.json()).error.code,'MODEL_KEY_REQUIRED');assert.equal(calls,0);
 await saveKey('local-fixture-key');mode='auth';const auth=await request(),error=await auth.json();assert.equal(error.error.code,'MODEL_AUTH_FAILED');assert.equal(error.error.action,'open-model-settings');assert(!JSON.stringify(error).includes('PRIVATE_UPSTREAM_SENTINEL'));
 mode='complete';assert.match(await (await request()).text(),/response.completed/);
 mode='interrupt';await assert.rejects(async()=>{const response=await request();await response.text();});
 mode='hold';const controller=new AbortController(),response=await request(controller.signal),reader=response.body.getReader();await reader.read();controller.abort();await reader.cancel().catch(()=>{});await until(()=>upstreamClosed&&store.controllers.size===0);
 mode='complete';assert.match(await (await request()).text(),/response.completed/);assert.equal(store.controllers.size,0);
});
