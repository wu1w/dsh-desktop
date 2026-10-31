import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ClaudeCodeEngine } from '../lib/engine.js';
import { checkTool, childEnvironment } from '../lib/policy.js';

async function fixture(t,query,extra={}){const root=await mkdtemp(path.join(tmpdir(),'dsh-claude-test-'));const cwd=path.join(root,'project');await mkdir(cwd);const options={dataDir:path.join(root,'data'),query,resolveApiKey:()=> 'oc_sk_TEST_PRIVATE_TOKEN_123456789',requestTimeoutMs:2000,...extra};const engine=new ClaudeCodeEngine(options);t.after(async()=>{await engine.dispose();await rm(root,{recursive:true,force:true});});await engine.start();await engine.createSession('one',{cwd});return {engine,root,cwd,options};}
async function wait(engine){const end=Date.now()+3000;while(engine.activeTurns.size){if(Date.now()>end)throw new Error('TEST_TIMEOUT');await new Promise(resolve=>setTimeout(resolve,5));}}
const init=options=>({type:'system',subtype:'init',model:options.model,session_id:options.resume??options.sessionId});
const final=(id,text)=>({type:'assistant',message:{id,content:[{type:'text',text}]}});
const result=text=>({type:'result',subtype:'success',is_error:false,result:text,usage:{input_tokens:1},modelUsage:{'deepseek-v4.1-flash':{}}});

test('streamed text reconciles without duplication; native UUID resumes after restart',async t=>{
  const calls=[];const query=async function*({prompt,options}){calls.push({prompt,options});yield init(options);yield{type:'stream_event',event:{type:'message_start',message:{id:'m'}}};yield{type:'stream_event',event:{type:'content_block_start',index:0,content_block:{type:'text',text:''}}};yield{type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'ok'}}};yield final('m','ok');yield result('ok');};
  const {engine,options}=await fixture(t,query);const first=(await engine.listSessions())[0];await engine.startTurn('one','first');await wait(engine);assert.equal((await engine.readSession('one')).thread.turns[0].items.filter(item=>item.type==='agentMessage').length,1);await engine.dispose();
  const resumed=new ClaudeCodeEngine(options);t.after(()=>resumed.dispose());await resumed.start();await resumed.startTurn('one','followup');await wait(resumed);assert.equal(calls[1].options.resume,first.threadId);assert.equal(calls[1].options.sessionId,undefined);assert.equal(calls[1].prompt,'followup');assert.deepEqual(calls[1].options.settingSources,[]);assert.equal(calls[1].options.env.CLAUDE_CONFIG_DIR,path.join(options.dataDir,'claude'));assert.equal(calls[1].options.env.ANTHROPIC_API_KEY,undefined);
});

test('mandatory hook guards auto-approved reads, traversal, symlinks and unknown tools',async t=>{
  let sdk;const query=async function*({options}){sdk=options;yield init(options);yield final('m','ok');yield result('ok');};const {engine,cwd,root}=await fixture(t,query);await mkdir(path.join(root,'outside'));await symlink(path.join(root,'outside'),path.join(cwd,'linked'));await engine.startTurn('one','go',{sandbox:'workspace-write'});await wait(engine);const guard=sdk.hooks.PreToolUse[0].hooks[0];
  for(const [tool,input]of [['Read',{file_path:'../outside/secret'}],['Write',{file_path:'linked/file'}],['Glob',{pattern:'../**'}],['Bash',{command:'env'}],['Agent',{}]]){const response=await guard({tool_name:tool,tool_input:input});assert.equal(response.hookSpecificOutput.permissionDecision,'deny',tool);}
  assert.equal((await guard({tool_name:'Read',tool_input:{file_path:'inside.txt'}})).hookSpecificOutput.permissionDecision,'allow');
  assert.equal(sdk.tools.includes('Bash'),false);assert.equal(sdk.tools.includes('Agent'),false);assert.equal(sdk.strictMcpConfig,true);assert.deepEqual(sdk.mcpServers,{});assert.deepEqual(sdk.plugins,[]);assert.deepEqual(sdk.extraArgs,{restricted:null});
  assert.equal((await checkTool({name:'Write',input:{file_path:'safe'},cwd,sandbox:'read-only'})).reason,'readonly');
});

test('write approval is a real callback and normalized tool result is persisted',async t=>{
  const query=async function*({options}){yield init(options);const input={file_path:'proof.txt',content:'proof\n'};const hook=await options.hooks.PreToolUse[0].hooks[0]({tool_name:'Write',tool_input:input});assert.equal(hook.hookSpecificOutput.permissionDecision,'ask');yield{type:'assistant',message:{id:'m',content:[{type:'tool_use',id:'write1',name:'Write',input}]}};const approval=await options.canUseTool('Write',input,{signal:options.abortController.signal});assert.equal(approval.behavior,'allow');await writeFile(path.join(options.cwd,'proof.txt'),input.content);yield{type:'user',message:{content:[{type:'tool_result',tool_use_id:'write1',content:'saved'}]}};yield final('f','done');yield result('done');};
  const {engine,cwd}=await fixture(t,query);let requested=false;engine.on('approval-required',request=>{requested=true;engine.respondApproval(request.id,{decision:'accept'});});await engine.startTurn('one','write',{sandbox:'workspace-write'});await wait(engine);assert.equal(requested,true);assert.equal(await readFile(path.join(cwd,'proof.txt'),'utf8'),'proof\n');const turn=(await engine.readSession('one')).thread.turns[0];assert.equal(turn.items.find(item=>item.type==='fileChange').status,'completed');assert.equal(turn.status,'completed');
});

test('expired and already-aborted approvals settle once and expose no submitted input in lifecycle events',async t=>{
  const decisions=[],events=[],requests=[];
  const query=async function*({options}){
    yield init(options);
    const input={file_path:'proof.txt',content:'PRIVATE_APPROVAL_TEST_CONTENT'};
    decisions.push(await options.canUseTool('Write',input,{signal:options.abortController.signal}));
    const aborted=new AbortController();aborted.abort();
    decisions.push(await options.canUseTool('Write',input,{signal:aborted.signal}));
    yield final('f','done');yield result('done');
  };
  const {engine}=await fixture(t,query,{approvalTimeoutMs:15});
  engine.on('approval-required',request=>requests.push(request));engine.on('approval-resolved',event=>events.push(event));
  await engine.startTurn('one','request',{sandbox:'workspace-write'});await wait(engine);
  assert.deepEqual(decisions.map(decision=>decision.behavior),['deny','deny']);
  assert.equal(requests.length,1);assert.deepEqual(events.map(event=>event.reason),['expired','cancelled']);
  assert.equal(engine.pending.size,0);assert.equal(JSON.stringify(events).includes('PRIVATE_APPROVAL_TEST_CONTENT'),false);
  await assert.rejects(engine.respondApproval(requests[0].id,{decision:'accept'}),{code:'APPROVAL_NOT_FOUND'});
});

test('interrupt retains the active turn until SDK loop actually ends',async t=>{
  let ended=false;const query=async function*({options}){yield init(options);await new Promise(resolve=>options.abortController.signal.addEventListener('abort',()=>setTimeout(resolve,30),{once:true}));ended=true;};const {engine}=await fixture(t,query);await engine.startTurn('one','long');await new Promise(resolve=>setTimeout(resolve,10));const stopping=engine.interrupt('one');assert.equal(engine.activeTurns.size,1);await stopping;assert.equal(ended,true);assert.equal(engine.activeTurns.size,0);assert.equal((await engine.readSession('one')).thread.turns[0].status,'interrupted');
});

test('queue persistence, editing, ordering and actual start share the client contract',async t=>{
  const prompts=[];const query=async function*({prompt,options}){prompts.push(prompt);yield init(options);yield final('m','ok');yield result('ok');};const {engine,options}=await fixture(t,query,{autoQueue:false});const add=text=>engine.queueRequest('one','add',{input:[{type:'text',text}]});const first=(await add('first')).queuedSubmission;const second=(await add('second')).queuedSubmission;await engine.queueRequest('one','update',{queuedSubmissionId:first.id,input:[{type:'text',text:'edited'}]});await engine.queueRequest('one','reorder',{queuedSubmissionIds:[second.id,first.id]});await engine.dispose();const next=new ClaudeCodeEngine(options);t.after(()=>next.dispose());await next.start();const page=await next.queueRequest('one','list');assert.deepEqual(page.data.map(item=>item.id),[second.id,first.id]);const started=await next.queueRequest('one','start',{queuedSubmissionId:first.id});assert.ok(started.turn.id);await wait(next);assert.deepEqual(prompts,['edited']);assert.equal((await next.queueRequest('one','list')).data.length,1);await assert.rejects(next.steer('one','x'),{code:'UNSUPPORTED_STEER'});await assert.rejects(next.startTurn('one','x',{sandbox:'danger-full-access'}),{code:'UNSUPPORTED_PERMISSION'});
});

test('secrets are removed from split stderr and failed turn errors',async t=>{
  const secret='oc_sk_TEST_PRIVATE_TOKEN_123456789';const query=async function*({options}){options.stderr('failure '+secret.slice(0,14));options.stderr(secret.slice(14)+'\n');yield init(options);throw new Error('Bearer '+secret);};const {engine}=await fixture(t,query);const logs=[];engine.on('stderr',value=>logs.push(value));await engine.startTurn('one','test');await wait(engine);const history=JSON.stringify(await engine.readSession('one'));assert.equal(logs.join('').includes(secret),false);assert.equal(logs.join('').includes(secret.slice(0,14)),false);assert.equal(history.includes(secret),false);assert.equal((await engine.readSession('one')).thread.turns[0].status,'failed');const env=childEnvironment({baseEnv:{PATH:'/bin',OPENAI_API_KEY:'unwanted',CLAUDE_CODE_OAUTH_TOKEN:'unwanted'},configDir:'/temporary',key:secret,model:'deepseek-v4.1-flash'});assert.equal(env.OPENAI_API_KEY,undefined);assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN,undefined);assert.equal(env.ANTHROPIC_AUTH_TOKEN,secret);
});

test('a start waiting on persistence cannot launch a child after disposal',async t=>{
  let calls=0;const query=async function*(){calls++;};const {engine}=await fixture(t,query);const save=engine._save.bind(engine);let release,entered;const gate=new Promise(resolve=>{entered=resolve;});let first=true;engine._save=async()=>{if(first){first=false;entered();await new Promise(resolve=>{release=resolve;});}return save();};const starting=engine.startTurn('one','racy');const rejected=assert.rejects(starting,{code:'DISPOSED'});await gate;await engine.dispose();release();await rejected;assert.equal(calls,0);assert.equal(engine.activeTurns.size,0);
});

test('queued starts claim once even when the first turn finishes immediately; remaining queue dispatches',async t=>{
  const prompts=[];const query=async function*({prompt,options}){prompts.push(prompt);yield init(options);yield final('m'+prompts.length,'ok');yield result('ok');};const {engine}=await fixture(t,query);const add=async text=>(await engine.queueRequest('one','add',{input:[{type:'text',text}]})).queuedSubmission;const first=await add('first');await add('second');const starts=await Promise.allSettled([engine.queueRequest('one','start',{queuedSubmissionId:first.id}),engine.queueRequest('one','start',{queuedSubmissionId:first.id})]);assert.equal(starts.filter(item=>item.status==='fulfilled').length,1);const deadline=Date.now()+2000;while(prompts.length<2||engine.activeTurns.size||(await engine.queueRequest('one','list')).data.length){if(Date.now()>deadline)throw new Error('QUEUE_TIMEOUT');await new Promise(resolve=>setTimeout(resolve,5));}assert.deepEqual(prompts,['first','second']);const third=await add('third');assert.deepEqual(await engine.queueRequest('one','delete',{queuedSubmissionId:third.id}),{deleted:true});
});

test('recovery does not replay a queue item already represented in a durable user turn',async t=>{
  const prompts=[];const query=async function*({prompt,options}){prompts.push(prompt);yield init(options);yield final('m','ok');yield result('ok');};const {engine,options}=await fixture(t,query);const first=(await engine.queueRequest('one','add',{input:[{type:'text',text:'claimed'}]})).queuedSubmission;const row=engine.rows.get('one');row.queue[0].status='starting';row.turns.push({id:'durable-turn',queuedSubmissionId:first.id,status:'inProgress',items:[{id:'input',type:'userMessage',content:[{type:'text',text:'claimed'}]}]});await engine._save();await engine.dispose();const resumed=new ClaudeCodeEngine(options);t.after(()=>resumed.dispose());await resumed.start();assert.deepEqual((await resumed.queueRequest('one','list')).data,[]);assert.equal((await resumed.readSession('one')).thread.turns[0].status,'interrupted');assert.deepEqual(prompts,[]);
});

test('captured DeepSeek thinking/text single-block envelopes reconcile to their original stream indexes',async t=>{
  const captured=JSON.parse(await readFile(new URL('./fixtures/deepseek-block-envelopes.json',import.meta.url),'utf8')).messages;
  // SDK public envelopes may omit the native transcript's apiBlockIndex.
  for(const explicitIndex of [true,false]){
    const query=async function*({options}){
      yield init(options);const id=captured[0].message.id;
      yield{type:'stream_event',event:{type:'message_start',message:{id}}};
      yield{type:'stream_event',event:{type:'content_block_start',index:0,content_block:{type:'thinking',thinking:''}}};
      const thinking=structuredClone(captured[0]);if(!explicitIndex)delete thinking.apiBlockIndex;yield thinking;
      yield{type:'stream_event',event:{type:'content_block_start',index:1,content_block:{type:'text',text:''}}};
      yield{type:'stream_event',event:{type:'content_block_delta',index:1,delta:{type:'text_delta',text:'CLAUDE_HOST_OK'}}};
      const text=structuredClone(captured[1]);if(!explicitIndex)delete text.apiBlockIndex;yield text;yield text;
      yield result('CLAUDE_HOST_OK');
    };
    const {engine}=await fixture(t,query);await engine.startTurn('one','captured-shape');await wait(engine);const items=(await engine.readSession('one')).thread.turns[0].items;
    const replies=items.filter(item=>item.type==='agentMessage');assert.deepEqual(replies.map(item=>({id:item.id,text:item.text})),[{id:captured[0].message.id+':1',text:'CLAUDE_HOST_OK'}]);assert.equal(items.find(item=>item.id===captured[0].message.id+':0').type,'reasoning');
  }
});

test('same text in distinct API messages or distinct blocks remains legitimate output',async t=>{
  const query=async function*({options}){
    yield init(options);
    yield{type:'assistant',uuid:'frame1',message:{id:'first-message',content:[{type:'text',text:'same'}]}};
    yield{type:'assistant',uuid:'frame2',message:{id:'second-message',content:[{type:'text',text:'same'},{type:'text',text:'same'}]}};
    yield result('same');
  };
  const {engine}=await fixture(t,query);await engine.startTurn('one','same');await wait(engine);const messages=(await engine.readSession('one')).thread.turns[0].items.filter(item=>item.type==='agentMessage');assert.deepEqual(messages.map(item=>item.id),['first-message:0','second-message:0','second-message:1']);assert.equal(messages.every(item=>item.text==='same'),true);
});

test('result fallback completes a partial stream or creates one result item without duplication',async t=>{
  for(const stream of [true,false]){
    const query=async function*({options}){
      yield init(options);if(stream){yield{type:'stream_event',event:{type:'message_start',message:{id:'partial'}}};yield{type:'stream_event',event:{type:'content_block_start',index:0,content_block:{type:'text',text:''}}};yield{type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'CL'}}};}
      yield result('CLAUDE_HOST_OK');yield result('CLAUDE_HOST_OK');
    };
    const {engine}=await fixture(t,query);await engine.startTurn('one','fallback');await wait(engine);const messages=(await engine.readSession('one')).thread.turns[0].items.filter(item=>item.type==='agentMessage');assert.equal(messages.length,1);assert.equal(messages[0].text,'CLAUDE_HOST_OK');
  }
});

test('updated shared MD reaches resumed SDK prompt without rewriting visible user history',async t=>{
 const calls=[];let settings='AGENT_SETTING_A';
 const query=async function*({prompt,options}){calls.push({prompt,options});yield init(options);yield final('m'+calls.length,'done');yield result('done');};
 const {engine,options}=await fixture(t,query,{resolveSharedInstructions:async()=>settings});
 await engine.startTurn('one','first');await wait(engine);settings='AGENT_SETTING_B';await engine.startTurn('one','second');await wait(engine);
 assert.match(calls[1].prompt,/AGENT_SETTING_B/);assert.ok(calls[1].options.resume);assert.equal((await engine.readSession('one')).thread.turns[1].items[0].content[0].text,'second');
 await engine.startTurn('one','third');await wait(engine);assert.equal(calls[2].prompt,'third');
 await engine.dispose();const restarted=new ClaudeCodeEngine(options);t.after(()=>restarted.dispose());await restarted.start();await restarted.startTurn('one','fourth');await wait(restarted);assert.equal(calls[3].prompt,'fourth');
});

test('long assistant and tool content remains complete for engine handoff',async t=>{const text='CONTEXT_START_'+ '长'.repeat(40000)+'_CONTEXT_END';const query=async function*({options}){yield init(options);yield final('long',text);yield result(text);};const {engine}=await fixture(t,query);await engine.startTurn('one','long response');await wait(engine);assert.equal((await engine.readSession('one')).thread.turns[0].items.find(i=>i.type==='agentMessage').text,text);});
