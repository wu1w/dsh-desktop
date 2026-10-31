import test from 'node:test';import assert from 'node:assert/strict';
import {modelDiscoveryURL,readDiscoveredModels} from '../server/model-discovery.mjs';
import {ModelProviders} from '../server/model-providers.mjs';
import {mkdtemp,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
test('OpenCode inference families use the real shared model catalog without changing origin',()=>{
 for(const [base,expected]of [['https://opencode.ai/inference/go/anthropic','https://opencode.ai/inference/go/v1/models'],['https://opencode.ai/inference/go/openai/v1','https://opencode.ai/inference/go/v1/models'],['https://opencode.ai/inference/anthropic','https://opencode.ai/inference/v1/models'],['https://opencode.ai/zen/go/v1','https://opencode.ai/zen/go/v1/models']])assert.equal(modelDiscoveryURL(base,'anthropic-messages'),expected);
 assert.equal(modelDiscoveryURL('https://other.example/inference/go/anthropic','anthropic-messages'),'https://other.example/inference/go/anthropic/v1/models');
 assert.equal(modelDiscoveryURL('https://opencode.ai.evil.example/inference/go/anthropic','anthropic-messages'),'https://opencode.ai.evil.example/inference/go/anthropic/v1/models');
});
test('compatible discovery preserves enriched model map metadata and handles standard arrays',()=>{
 assert.deepEqual(readDiscoveredModels({models:{'org/reasoner':{name:'Reasoner',limit:{context:128000,output:32000},reasoning:true},ignored:false}}).models,[{id:'org/reasoner',name:'Reasoner',contextWindow:128000,maxTokens:32000,reasoning:true}]);
 assert.equal(readDiscoveredModels({data:[{id:'chat',name:'Chat',context_length:64000,top_provider:{max_completion_tokens:4000}}]}).models[0].maxTokens,4000);
 assert.throws(()=>readDiscoveredModels({message:'not a model listing'}),/MODEL_DISCOVERY_FAILED/);
 assert.equal(readDiscoveredModels({data:Array.from({length:501},(_,n)=>({id:'model-'+n}))}).hasMore,true);
});
test('legacy OpenCode button reads its real catalog path and ignores unfinished draft model rows',async t=>{
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'dsh-discovery-test-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));let request;
 const store=await new ModelProviders({dataDir,resolveLegacyKey:async()=> 'test-key',fetchImpl:async(url,options)=>{request={url,options};return new Response(JSON.stringify({data:[{id:'deepseek-v4.1-flash'},{id:'deepseek-v4-pro'}]}));}}).load();
 const before=store.state.revision,p=store.public().providers[0];const result=await store.discover({...p,apiKey:'',models:[{id:'',name:'',contextWindow:''}]});
 assert.equal(request.url,'https://opencode.ai/inference/go/v1/models');assert.equal(request.options.headers['x-api-key'],'test-key');assert.equal(request.options.redirect,'error');assert.equal(result.models.length,2);assert.equal(result.sourceURL,request.url);assert.equal(store.state.revision,before);
});
test('catalog auth, absent endpoint and malformed response remain distinct failures',async t=>{
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'dsh-discovery-errors-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));let status=401;
 const store=await new ModelProviders({dataDir,resolveLegacyKey:async()=> 'test-key',fetchImpl:async()=>new Response('{}',{status})}).load();const p=store.public().providers[0];
 for(const [code,expected]of [[401,'MODEL_AUTH_FAILED'],[403,'MODEL_AUTH_FAILED'],[404,'MODEL_DISCOVERY_UNSUPPORTED'],[405,'MODEL_DISCOVERY_UNSUPPORTED'],[500,'MODEL_DISCOVERY_FAILED'],[200,'MODEL_DISCOVERY_FAILED']]){status=code;await assert.rejects(store.discover(p),{code:expected});}
});
