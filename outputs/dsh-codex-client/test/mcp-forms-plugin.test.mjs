import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {Context} from '@deepseek-ai/cordis';
const appRoot=process.env.DSH_ACCEPTANCE_APP_ROOT??fileURLToPath(new URL('../',import.meta.url));
const {PluginHost}=await import(pathToFileURL(path.join(appRoot,'server/plugin-host.mjs')));
const {ApprovalBroker}=await import(pathToFileURL(path.join(appRoot,'server/approvals.mjs')));
const builtin=path.join(appRoot,'server/plugins/feature-mcp-forms.mjs');
const request=id=>({id,method:'mcpServer/elicitation/request',params:{mode:'form',threadId:'owned-native-thread',turnId:null,serverName:'owned-mcp',message:'Fixture request',requestedSchema:{type:'object',properties:{count:{type:'integer',minimum:0}},required:['count']}}});
async function fixture(){
  const root=await mkdtemp(path.join(tmpdir(),'dsh-mcp-plugin-')),context=new Context(),broker=new ApprovalBroker(),answers=[],calls={replacement:0};
  const engine={async respondApproval(id,result){answers.push({id,result});}};
  const host=new PluginHost({context,dataDir:path.join(root,'client'),builtins:[builtin],services:{approvals:broker,calls}});await host.start();
  return{root,host,broker,engine,answers,calls,async close(){broker.clear(engine);await host.close();await context.fiber.dispose();await rm(root,{recursive:true,force:true});}};
}
test('actual Cordis stop removes the MCP form handler, preserves pending native identity, and re-enable restores typed answers',async()=>{
  const f=await fixture();try{
    assert.equal(f.host.features.has('feature-mcp-forms'),true);assert.equal(f.broker.handlers.size,1);
    const pending=f.broker.receive(f.engine,request(101));await f.host.disable('feature-mcp-forms');assert.equal(f.host.features.size,0);assert.equal(f.broker.handlers.size,0);assert.equal(f.broker.list()[0].id,pending.id);
    await assert.rejects(f.broker.answer(pending.id,{allow:true,content:{count:0}}),{code:'UNSUPPORTED_APPROVAL'});assert.deepEqual(f.answers,[]);
    await f.host.enable('feature-mcp-forms');assert.equal(f.broker.handlers.size,1);await f.broker.answer(pending.id,{allow:true,content:{count:0}});assert.deepEqual(f.answers,[{id:101,result:{action:'accept',content:{count:0},_meta:null}}]);assert.deepEqual(f.broker.list(),[]);
    await f.host.disable('feature-mcp-forms');const next=f.broker.receive(f.engine,request(102));await f.broker.answer(next.id,{allow:false,elicitationAction:'cancel'});assert.equal(f.answers.at(-1).result.action,'cancel');assert.equal(f.answers.at(-1).result.content,null);
  }finally{await f.close();assert.equal(f.broker.handlers.size,0);}
});
test('an installed replacement owns the actual form capability and handler, releases them on removal, and restores the builtin',async()=>{
  const f=await fixture();try{
    const source=path.join(f.root,'replacement');await mkdir(source);await writeFile(path.join(source,'dsh-plugin.json'),JSON.stringify({id:'replacement-mcp-forms',type:'feature',version:'0.1.0',entry:'index.mjs',name:{en:'Fixture forms','zh-CN':'测试表单'}}));
    const moduleUrl=pathToFileURL(path.join(appRoot,'server/approvals.mjs')).href;
    await writeFile(path.join(source,'index.mjs'),`import {mcpElicitationResult} from ${JSON.stringify(moduleUrl)};export function apply(ctx,host){host.registerFeature('feature-mcp-forms');ctx.effect(()=>host.approvals.registerHandler('mcpServer/elicitation/request',(request,body)=>{host.calls.replacement++;return mcpElicitationResult(request,body);}));}`);
    await f.host.install(source);assert.equal(f.calls.replacement,0);await assert.rejects(f.host.enable('replacement-mcp-forms'),{code:'PLUGIN_START_FAILED'});assert.equal(f.broker.handlers.size,1);assert.equal(f.host.features.get('feature-mcp-forms').pluginId,'feature-mcp-forms');
    await f.host.disable('feature-mcp-forms');await f.host.enable('replacement-mcp-forms');assert.equal(f.host.features.get('feature-mcp-forms').pluginId,'replacement-mcp-forms');assert.equal(f.broker.handlers.size,1);
    const pending=f.broker.receive(f.engine,request(201));await f.broker.answer(pending.id,{allow:true,content:{count:0}});assert.equal(f.calls.replacement,1);assert.equal(f.answers[0].result.content.count,0);
    await f.host.remove('replacement-mcp-forms');assert.equal(f.host.features.size,0);assert.equal(f.broker.handlers.size,0);assert.equal(f.host.records.has('replacement-mcp-forms'),false);
    await f.host.enable('feature-mcp-forms');assert.equal(f.broker.handlers.size,1);assert.equal(f.host.features.get('feature-mcp-forms').pluginId,'feature-mcp-forms');
  }finally{await f.close();assert.equal(f.broker.handlers.size,0);}
});
test('a failed Cordis initializer releases a form handler registered before its failure',async()=>{
  const f=await fixture();try{
    const source=path.join(f.root,'broken');await mkdir(source);await writeFile(path.join(source,'dsh-plugin.json'),JSON.stringify({id:'broken-mcp-forms',type:'feature',version:'0.1.0',name:{en:'Broken fixture','zh-CN':'失败测试'}}));await writeFile(path.join(source,'index.mjs'),"export function apply(ctx,host){host.registerFeature('broken-mcp-forms');ctx.effect(()=>host.approvals.registerHandler('test/broken-mcp',()=>({})));throw Error('owned failure');}");
    await f.host.install(source);await assert.rejects(f.host.enable('broken-mcp-forms'),{code:'PLUGIN_START_FAILED'});assert.equal(f.host.features.has('broken-mcp-forms'),false);assert.equal(f.broker.handlers.size,1);assert.equal(f.broker.handlers.has('test/broken-mcp'),false);
  }finally{await f.close();}
});
