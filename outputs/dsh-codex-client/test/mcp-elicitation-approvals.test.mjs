import test from 'node:test';import assert from 'node:assert/strict';
import {ApprovalBroker,approvalResult,mcpElicitationResult} from '../server/approvals.mjs';
import {execFile} from 'node:child_process';import {promisify} from 'node:util';
const request={id:9,method:'mcpServer/elicitation/request',params:{threadId:'owned',turnId:null,mode:'form',message:'Owned form',serverName:'owned',requestedSchema:{type:'object',properties:{count:{type:'integer'},flag:{type:'boolean'},text:{type:'string'}},required:['count','flag']}}};
test('optional form handler validates typed accept; decline/cancel remain explicit and content-free',()=>{
  assert.deepEqual(mcpElicitationResult(request,{allow:true,content:{count:0,flag:false,text:''}}),{action:'accept',content:{count:0,flag:false,text:''},_meta:null});
  for(const action of ['decline','cancel']){assert.deepEqual(mcpElicitationResult(request,{allow:false,elicitationAction:action,content:{SECRET:'never forwarded'}}),{action,content:null,_meta:null});assert.deepEqual(approvalResult(request,{allow:false,elicitationAction:action}),{action,content:null,_meta:null});}
  assert.throws(()=>approvalResult(request,{allow:true,content:{count:0,flag:false}}),{code:'UNSUPPORTED_APPROVAL'});
  for(const body of [{allow:false,elicitationAction:'accept'},{allow:true,elicitationAction:'decline'},{allow:false,elicitationAction:null},{allow:false,elicitationAction:'url'}])assert.throws(()=>mcpElicitationResult(request,body),{code:'INVALID_REQUEST'});
});
test('handler install/conflict/removal is real, safe to retry, generation scoped and blocks stale acceptance after disable',async()=>{
  const events=[],calls=[],broker=new ApprovalBroker({broadcast:event=>events.push(event)}),engine={respondApproval:async(...args)=>calls.push(args)},visible=broker.receive(engine,request),content={count:0,flag:false,text:'PRIVATE_CONTENT_NEVER_BROADCAST'};
  const remove=broker.registerHandler(request.method,mcpElicitationResult);assert.throws(()=>broker.registerHandler(request.method,mcpElicitationResult),{code:'APPROVAL_HANDLER_CONFLICT'});
  await assert.rejects(broker.answer(visible.id,{allow:true,content:{count:'0',flag:false}}),{code:'MCP_ELICITATION_INVALID_CONTENT'});assert.equal(broker.pending.get(visible.id).answering,false);assert.equal(calls.length,0);
  remove();await assert.rejects(broker.answer(visible.id,{allow:true,content}),{code:'UNSUPPORTED_APPROVAL'});assert.equal(broker.list().length,1);
  const newerRemove=broker.registerHandler(request.method,mcpElicitationResult);remove();await broker.answer(visible.id,{allow:true,elicitationAction:'accept',content});assert.equal(calls.length,1);assert.deepEqual(calls[0],[9,{action:'accept',content,_meta:null}]);assert.equal(JSON.stringify(events).includes(content.text),false);assert.equal(broker.list().length,0);newerRemove();
});
test('unsupported extended forms cannot be accepted even while handler is enabled; cancellation is always available',async()=>{
  const calls=[],broker=new ApprovalBroker(),engine={respondApproval:async(...args)=>calls.push(args)};broker.registerHandler(request.method,mcpElicitationResult);const r=broker.receive(engine,{...request,params:{...request.params,mode:'openai/form'}});
  await assert.rejects(broker.answer(r.id,{allow:true,content:{count:0,flag:false}}),{code:'MCP_ELICITATION_UNSUPPORTED'});assert.equal(broker.list().length,1);await broker.answer(r.id,{allow:false,elicitationAction:'cancel'});assert.deepEqual(calls[0][1],{action:'cancel',content:null,_meta:null});
});
test('handler validation stays synchronous and is complete before answering begins',async()=>{
  const broker=new ApprovalBroker(),r=broker.receive({respondApproval:async()=>{}},request);
  assert.throws(()=>broker.registerHandler('',()=>({})),{code:'APPROVAL_HANDLER_INVALID'});assert.throws(()=>broker.registerHandler('async',async()=>({})),{code:'APPROVAL_HANDLER_INVALID'});
  const remove=broker.registerHandler(request.method,()=>undefined);await assert.rejects(broker.answer(r.id,{allow:true}),{code:'APPROVAL_HANDLER_INVALID'});assert.equal(broker.pending.get(r.id).answering,false);remove();await broker.answer(r.id,{allow:false});
});
test('a rejected Promise returned by an ordinary handler cannot become a host unhandled rejection',async()=>{
  const source=`import {ApprovalBroker} from ${JSON.stringify(new URL('../server/approvals.mjs',import.meta.url).href)};let unhandled=0,calls=0;process.on('unhandledRejection',()=>{unhandled++;});const broker=new ApprovalBroker(),visible=broker.receive({respondApproval:async()=>{calls++;}},{id:0,method:'fixture'});broker.registerHandler('fixture',()=>Promise.reject(Error('PRIVATE_PLUGIN_EXCEPTION')));let code;try{await broker.answer(visible.id,{allow:true});}catch(error){code=error.code;}await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));console.log(JSON.stringify({code,unhandled,calls,answering:broker.pending.get(visible.id).answering}));`;
  const {stdout,stderr}=await promisify(execFile)(process.execPath,['--input-type=module','-e',source],{timeout:3000});assert.equal(stderr,'');assert.deepEqual(JSON.parse(stdout),{code:'APPROVAL_HANDLER_INVALID',unhandled:0,calls:0,answering:false});
});
test('a throwing thenable getter is a fixed invalid handler result and never exposes its exception',async()=>{
  const calls=[],broker=new ApprovalBroker(),visible=broker.receive({respondApproval:async(...args)=>calls.push(args)},request);broker.registerHandler(request.method,()=>Object.defineProperty({},'then',{get(){throw Error('PRIVATE_GETTER_EXCEPTION');}}));
  await assert.rejects(broker.answer(visible.id,{allow:true}),error=>error.code==='APPROVAL_HANDLER_INVALID'&&!String(error).includes('PRIVATE'));assert.equal(calls.length,0);assert.equal(broker.pending.get(visible.id).answering,false);
});
