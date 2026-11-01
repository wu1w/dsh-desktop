import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';
import { FILE_TOOLS, WRITES, checkTool, childEnvironment, canonical, isInside } from './policy.js';
import { AssistantBlocks } from './assistant-blocks.js';

const messages=Object.fromEntries(['en','zh-CN'].map(locale=>[locale,JSON.parse(readFileSync(new URL(`../locale/${locale}.json`,import.meta.url),'utf8'))]));
const textOf=content=>typeof content==='string'?content:(content??[]).map(block=>block.text??'').join('\n');
const TERMINAL=new Set(['completed','failed','interrupted']);
const bounded=async(promise,ms)=>{let timer;try{return await Promise.race([Promise.resolve(promise).then(()=>true,()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),ms);})]);}finally{clearTimeout(timer);}};
export class ClaudeCodeEngine extends EventEmitter {
  constructor(options={}) {
    super();this.setMaxListeners(50);this.options=options;this.locale=options.locale??'zh-CN';
    if(!options.dataDir)throw this._error('INVALID_PATH','invalid_path');
    this.dataDir=path.resolve(options.dataDir);this.configDir=path.join(this.dataDir,'claude');
    // Windows 上可执行文件必须带扩展名，否则 Node 解析会失败。
    const defaultBinary=process.platform==='win32'?path.join(homedir(),'.local','bin','claude.exe'):path.join(homedir(),'.local/bin/claude');
    this.model=options.model??'deepseek-v4.1-flash';this.provider='opencode_go_anthropic';this.baseUrl=options.baseUrl;this.binary=options.claudeBinary??options.binary??defaultBinary;
    this.resolveApiKey=options.resolveApiKey;this.requestTimeoutMs=options.idleTimeoutMs??options.requestTimeoutMs??300000;this.approvalTimeoutMs=options.approvalTimeoutMs??120000;
    this.turnTimeoutMs=options.turnTimeoutMs??null;this.interruptTimeoutMs=options.interruptTimeoutMs??5000;this.shutdownTimeoutMs=options.shutdownTimeoutMs??5000;this.checkpointIntervalMs=options.checkpointIntervalMs??1000;
    this.rows=new Map();this.inflight=new Map();this.pending=new Map();this.writes=Promise.resolve();this.serial=new Map();this.loaded=false;this.starting=null;this._ready=false;this.disposed=false;this.disposing=false;this.secret=null;
    this.client={request:async()=>{throw this._error('UNSUPPORTED','unsupported');}};
  }
  t(key){return messages[this.locale]?.[key]??messages.en[key]??key;}
  _error(code,key,detail){return Object.assign(new Error(this.t(key)),{code,...(detail?{detail:this._redact(detail)}:{})});}
  _redact(value){let result=String(value??'');if(this.secret)result=result.split(this.secret).join('[redacted]');return result.replace(/(?:Bearer\s+)[A-Za-z0-9._-]+/gi,'Bearer [redacted]').replace(/\b(?:sk-|oc_sk_)[A-Za-z0-9_-]{8,}\b/g,'[redacted]');}
  _stderr(active,value,flush=false){active.stderrBuffer=(active.stderrBuffer??'')+String(value??'');const parts=active.stderrBuffer.split('\n');active.stderrBuffer=parts.pop();for(const line of parts){if(!active.stderrOverflow)this.emit('stderr',this._redact(line).slice(0,32768));active.stderrOverflow=false;}if(active.stderrBuffer.length>65536){active.stderrBuffer='';active.stderrOverflow=true;}if(flush){if(active.stderrBuffer&&!active.stderrOverflow)this.emit('stderr',this._redact(active.stderrBuffer));active.stderrBuffer='';active.stderrOverflow=false;}}
  get ready(){return this._ready&&!this.disposed;}
  get state(){return this.disposed?'disposed':this.inflight.size?'turn-active':this.ready?'ready':this.starting?'starting':'idle';}
  get activeTurns(){return new Map([...this.inflight].map(([id,value])=>[id,{turnId:value.turn.id,threadId:value.row.threadId}]));}
  status(){return {state:this.state,stateLabel:this.t(this.inflight.size?'running':this.ready?'ready':'idle'),model:this.model,provider:this.provider,binary:this.binary,dataDir:this.dataDir,claudeConfigDir:this.configDir,isolated:true,limitations:this.t('limitations'),capabilities:{steer:false,queue:true,autoQueue:this.options.autoQueue!==false,shell:false,move:false,image:false,fork:false,permissions:['read-only','workspace-write'],mcpConfiguration:false,skillsManagement:false},sessions:[...this.rows.values()].map(row=>this._public(row))};}
  async start(){return this.ensureStarted();}
  async ensureStarted(){
    if(this.disposed||this.disposing)throw this._error('DISPOSED','disposed');if(this.ready)return this.status();if(this.starting)return this.starting;
    this.starting=(async()=>{
      const resolved=await canonical(this.configDir);
      for(const unsafe of [path.join(homedir(),'.claude'),path.join(homedir(),'.codex'),path.join(homedir(),'.dsh')]) if(isInside(resolved,await canonical(unsafe))||isInside(await canonical(this.dataDir),await canonical(unsafe)))throw this._error('UNSAFE_DATA_DIR','path_denied');
      await mkdir(this.configDir,{recursive:true,mode:0o700});
      if(!this.options.query){if(!(await stat(this.binary)).isFile())throw this._error('BINARY_UNAVAILABLE','failed');this.querySDK=(await import('@anthropic-ai/claude-agent-sdk')).query;}
      if(!this.loaded){try{const saved=JSON.parse(await readFile(path.join(this.dataDir,'sessions.json'),'utf8'));if(saved.version!==1||!Array.isArray(saved.sessions))throw new Error('SCHEMA');for(const row of saved.sessions){if(!row.sessionId||!row.threadId||!row.cwd||!Array.isArray(row.turns)||!Array.isArray(row.queue))throw new Error('SCHEMA');for(const turn of row.turns)if(turn.status==='inProgress')turn.status='interrupted';row.queue=row.queue.filter(entry=>!row.turns.some(turn=>turn.queuedSubmissionId===entry.id));for(const entry of row.queue)if(['running','starting'].includes(entry.status))entry.status='queued';this.rows.set(row.sessionId,row);}}catch(error){if(error.code!=='ENOENT')throw this._error('PERSIST_FAILED','persist');}this.loaded=true;}
      if(this.disposed||this.disposing)throw this._error('DISPOSED','disposed');this._ready=true;return this.status();
    })().finally(()=>{this.starting=null;});return this.starting;
  }
  _public(row){return {sessionId:row.sessionId,threadId:row.threadId,cwd:row.cwd,model:row.selection??row.model,provider:row.provider??this.provider,name:row.name??'',archived:!!row.archived,createdAt:row.createdAt,updatedAt:row.updatedAt,engine:'claude-code'};}
  _row(id){const row=this.rows.get(id);if(!row)throw this._error('SESSION_NOT_FOUND','invalid_session');return row;}
  _lock(id,fn){const next=(this.serial.get(id)??Promise.resolve()).catch(()=>{}).then(()=>{if(this.disposed||this.disposing)throw this._error('DISPOSED','disposed');return fn();});this.serial.set(id,next);const cleanup=()=>{if(this.serial.get(id)===next)this.serial.delete(id);};next.then(cleanup,cleanup);return next;}
  _save(){const run=this.writes.catch(()=>{}).then(async()=>{const temporary=path.join(this.dataDir,`.sessions-${randomUUID()}.tmp`);try{await mkdir(this.dataDir,{recursive:true,mode:0o700});await writeFile(temporary,JSON.stringify({version:1,sessions:[...this.rows.values()]},null,2)+'\n',{mode:0o600});await rename(temporary,path.join(this.dataDir,'sessions.json'));}catch{throw this._error('PERSIST_FAILED','persist');}finally{await rm(temporary,{force:true}).catch(()=>{});}});this.writes=run;return run;}
  async createSession(id,options={}){await this.ensureStarted();return this._lock(id,async()=>{if(typeof id!=='string'||!id||id.length>200)throw this._error('INVALID_SESSION','invalid_session');if(this.rows.has(id))throw this._error('SESSION_EXISTS','already_exists');if(typeof options.cwd!=='string'||!path.isAbsolute(options.cwd))throw this._error('INVALID_PATH','invalid_path');const cwd=await canonical(path.resolve(options.cwd));if(!(await stat(cwd)).isDirectory())throw this._error('INVALID_PATH','invalid_path');const selection=options.model??this.model,c=this._connection(selection),model=c.model;this._model(model);const now=new Date().toISOString();const row={sessionId:id,threadId:randomUUID(),cwd,model,selection,provider:c.provider,createdAt:now,updatedAt:now,archived:false,nativeStarted:false,sharedContext:options.sharedContext??'',turns:[],queue:[]};this.rows.set(id,row);await this._save();this.emit('session',this._public(row));return this._public(row);});}
  _connection(selection){return this.options.resolveModel?.(selection)??{model:selection,provider:this.provider,baseUrl:this.baseUrl};}
  _model(model){if(typeof model!=='string'||!(this.options.resolveModel?/^[^\s\x00-\x1f\x7f]{1,180}$/:/^deepseek-[A-Za-z0-9._-]{1,90}$/).test(model))throw this._error('MODEL_INVALID','model_invalid');}
  async resumeSession(id){await this.ensureStarted();return this._public(this._row(id));}
  async listSessions(){await this.ensureStarted();return [...this.rows.values()].map(row=>this._public(row));}
  async readSession(id){await this.ensureStarted();const row=this._row(id);return {...this._public(row),thread:{id:row.threadId,turns:structuredClone(row.turns)}};}
  async readTurnState(id,turnId){await this.ensureStarted();const row=this._row(id);const turn=turnId?row.turns.find(turn=>turn.id===turnId):row.turns.at(-1);const active=this.inflight.get(id);return {sessionId:id,threadId:row.threadId,turnId:turn?.id??turnId??null,status:turn?.status??'unknown',known:!!turn,active:!!active&&active.turn.id===turn?.id,terminal:!!turn&&TERMINAL.has(turn.status),error:turn?.error??null};}
  _input(input){if(typeof input==='string'&&input.trim())return input; if(Array.isArray(input)){if(input.some(item=>item.type!=='text'))throw this._error('UNSUPPORTED_INPUT','unsupported');const value=input.map(item=>item.text??'').join('\n');if(value.trim())return value;}throw this._error('INVALID_INPUT','invalid_input');}
  _notify(method,params){if(!this.disposed)this.emit('notification',{method,params});}
  async startTurn(id,input,options={}){await this.ensureStarted();return this._lock(id,async()=>{
    const row=this._row(id);this._connection(row.selection??row.model);if(row.archived)throw this._error('ARCHIVED','invalid_session');if(this.inflight.has(id)||row.queue.some(item=>item.status==='starting'&&item.id!==options.queueClaimId))throw this._error('TURN_IN_FLIGHT','busy');const prompt=this._input(input);const sandbox=options.sandbox??row.lastSandbox??'read-only';if(!['read-only','workspace-write'].includes(sandbox))throw this._error('UNSUPPORTED_PERMISSION','permission_unsupported');row.lastSandbox=sandbox;options={...options,effort:options.effort??row.lastEffort};if(options.effort)row.lastEffort=options.effort;
    const turn={id:randomUUID(),status:'inProgress',startedAt:new Date().toISOString(),completedAt:null,...(options.queueClaimId?{queuedSubmissionId:options.queueClaimId}:{}),items:[{id:randomUUID(),type:'userMessage',content:[{type:'text',text:prompt}]}]};row.turns.push(turn);row.updatedAt=new Date().toISOString();try{await this._save();}catch(error){row.turns.pop();throw error;}if(this.disposed||this.disposing){turn.status='interrupted';await this._save();throw this._error('DISPOSED','disposed');}
    const active={row,turn,sandbox,options,abort:new AbortController(),query:null,items:new Map(),cancelled:false};this.inflight.set(id,active);active.done=this._run(active,prompt);this._notify('turn/started',{threadId:row.threadId,turn:structuredClone(turn)});this.emit('turn',{sessionId:id,threadId:row.threadId,turn:structuredClone(turn),phase:'started'});
    return {sessionId:id,threadId:row.threadId,turnId:turn.id,status:'inProgress'};
  });}
  _emitItem(active,item,phase='completed'){const existing=active.turn.items.findIndex(row=>row.id===item.id);if(existing<0)active.turn.items.push(item);else active.turn.items[existing]=item;active.items.set(item.id,item);this._notify(`item/${phase}`,{threadId:active.row.threadId,turnId:active.turn.id,item:structuredClone(item)});}
  async _policy(active,name,input){if(active.cancelled||active.timedOut||active.detached||this.disposed||this.disposing)return {allowed:false,reason:'disposed'};if(name==='mcp__dsh_development__dsh_plugins'&&this.options.developmentCall)return {allowed:true,write:false};if(name==='mcp__dsh_computer__dsh_computer'&&this.options.computerCall)return {allowed:true,write:false};return checkTool({name,input,cwd:active.row.cwd,configDir:this.configDir,dataDir:this.dataDir,sandbox:active.sandbox});}
  _stopActive(active){
    if(active.stopRequested)return;active.stopRequested=true;active.abort.abort();
    // The control receipt can be lost when the subprocess or connection fails.
    // Closing the query must never wait behind that receipt.
    try{Promise.resolve(active.query?.interrupt?.()).catch(()=>{});}catch{}
    try{Promise.resolve(active.query?.close?.()).catch(()=>{});}catch{}
  }
  _touch(active){
    clearTimeout(active.idleTimer);if(active.cancelled||active.timedOut||active.detached||this.disposed)return;
    if(Number.isFinite(this.requestTimeoutMs)&&this.requestTimeoutMs>0)active.idleTimer=setTimeout(()=>{active.timedOut=true;active.timeoutCode='IDLE_TIMEOUT';this._stopActive(active);},this.requestTimeoutMs);
  }
  _checkpoint(active){
    if(active.checkpointTimer||active.checkpointPending||active.detached||this.disposed)return;
    active.checkpointTimer=setTimeout(()=>{active.checkpointTimer=null;if(active.detached||this.disposed)return;active.checkpointPending=true;this._save().catch(error=>{if(!this.disposed)this.emit('checkpoint-error',{sessionId:active.row.sessionId,turnId:active.turn.id,code:error.code});}).finally(()=>{active.checkpointPending=false;});},this.checkpointIntervalMs);
  }
  async _approval(active,name,input,signal){
    const policy=await this._policy(active,name,input);if(!policy.allowed)return {behavior:'deny',message:this.t(policy.reason)};
    if(!policy.write)return {behavior:'allow',updatedInput:input};
    if(this.options.autoApproveWorkspaceWrites===true)return {behavior:'allow',updatedInput:input};
    const id=randomUUID();return new Promise(resolve=>{
      let timer;const finish=(decision,reason='answered')=>{if(!this.pending.has(id))return;clearTimeout(timer);signal?.removeEventListener('abort',onAbort);this.pending.delete(id);this.emit('approval-resolved',{id,reason});resolve(decision?{behavior:'allow',updatedInput:input}:{behavior:'deny',message:this.t('approval_denied')});};const onAbort=()=>finish(false,'cancelled');
      this.pending.set(id,{finish,sessionId:active.row.sessionId});signal?.addEventListener('abort',onAbort,{once:true});timer=setTimeout(()=>finish(false,'expired'),this.listenerCount('approval-required')||this.options.approvalHandler?this.approvalTimeoutMs:0);
      if(signal?.aborted){onAbort();return;}
      const request={id,method:'item/fileChange/requestApproval',params:{threadId:active.row.threadId,turnId:active.turn.id,tool:name,input,reason:this.t('approval_required')}};this.emit('approval-required',request);
      if(this.options.approvalHandler)Promise.resolve(this.options.approvalHandler(request)).then(answer=>finish(answer?.decision==='accept'||answer?.decision==='acceptForSession'||answer?.behavior==='allow')).catch(()=>finish(false,'failed'));
    });
  }
  async _run(active,prompt){
    let timer;let resultSeen=false;const {row,turn}=active;const blocks=new AssistantBlocks();
    try{
      this._touch(active);if(active.cancelled||this.disposed)throw this._error('DISPOSED','disposed');const key=await this.resolveApiKey?.();if(active.cancelled||active.timedOut||this.disposed)throw this._error('DISPOSED','disposed');if(!key)throw this._error('MISSING_API_KEY','missing_key');this.secret=key;
      const queryFn=this.options.query??this.querySDK;
      const connection=this._connection(row.selection??row.model);
      const currentInstructions=await this.options.resolveSharedInstructions?.(row.cwd,row);
      const options={cwd:row.cwd,pathToClaudeCodeExecutable:this.binary,env:childEnvironment({baseEnv:this.options.baseEnv??process.env,configDir:this.configDir,key,model:row.model,baseUrl:connection.baseUrl}),model:row.model,settingSources:[],tools:FILE_TOOLS,permissionMode:'default',includePartialMessages:true,abortController:active.abort,...(this.options.maxTurns==null?{}:{maxTurns:this.options.maxTurns}),persistSession:true,systemPrompt:{type:'preset',preset:'claude_code',append:'This independent DSH client uses the model and provider selected by the user. Do not infer model identity from the execution engine name. Work only within the authorized project and supplied tool permissions. Report actual results honestly.'+[row.sharedContext,currentInstructions].filter(Boolean).map(text=>'\n\n'+text).join('')},...(row.nativeStarted?{resume:row.threadId}:{sessionId:row.threadId}),hooks:{PreToolUse:[{hooks:[async input=>{const decision=await this._policy(active,input.tool_name,input.tool_input??{});return {hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:!decision.allowed?'deny':decision.write&&this.options.autoApproveWorkspaceWrites!==true?'ask':'allow',...(!decision.allowed?{permissionDecisionReason:this.t(decision.reason)}:{})}};}]}]},canUseTool:(name,input,meta)=>this._approval(active,name,input,meta.signal),stderr:value=>{if(!active.detached&&!this.disposed)this._stderr(active,value);}};
      if(active.options.effort)options.effort=({medium:'high',xhigh:'high',minimal:'low'})[active.options.effort]??active.options.effort;
      Object.assign(options,{strictMcpConfig:true,mcpServers:{},plugins:[],extraArgs:{restricted:null}});
      if(this.options.computerTool&&this.options.computerCall){
        const {createSdkMcpServer,tool}=await import('@anthropic-ai/claude-agent-sdk');
        const {z}=await import('zod');const spec=this.options.computerTool;
        const shape=Object.fromEntries(Object.entries(spec.inputSchema.properties).map(([key,value])=>{let schema=value.enum?z.enum(value.enum):value.type==='integer'?z.number().int().min(0):z.string().max(20000);return [key,spec.inputSchema.required.includes(key)?schema:schema.optional()];}));
        options.mcpServers={dsh_computer:createSdkMcpServer({name:'dsh_computer',version:'1.0.0',tools:[tool(spec.name,spec.description,shape,async args=>{try{const {image,...result}=await this.options.computerCall(row.sessionId,args,{signal:active.abort.signal});return {content:[{type:'text',text:JSON.stringify(result)}]};}catch(error){return {isError:true,content:[{type:'text',text:error.code??'COMPUTER_NATIVE_FAILED'}]};}})]})};
      }
      if(this.options.developmentTool&&this.options.developmentCall){
        const {createSdkMcpServer,tool}=await import('@anthropic-ai/claude-agent-sdk');
        const {z}=await import('zod');const spec=this.options.developmentTool;
        const shape=Object.fromEntries(Object.entries(spec.inputSchema.properties).map(([key,value])=>{let schema=value.enum?z.enum(value.enum):value.type==='integer'?z.number().int().min(0):z.string().max(value.maxLength??200000);return [key,spec.inputSchema.required.includes(key)?schema:schema.optional()];}));
        options.mcpServers={...options.mcpServers,dsh_development:createSdkMcpServer({name:'dsh_development',version:'1.0.0',tools:[tool(spec.name,spec.description,shape,async args=>{try{const {image,...result}=await this.options.developmentCall(row.sessionId,args,{signal:active.abort.signal});return {content:[{type:'text',text:JSON.stringify(result)}]};}catch(error){return {isError:true,content:[{type:'text',text:error.code??'PLUGIN_RUNTIME_FAILED'}]};}})]})};
      }
      const queryPrompt=currentInstructions&&currentInstructions!==row.lastSharedInstructions?'DSH updated agent settings. These are the current settings for this project and supersede earlier snapshots.\n<current_agent_settings>\n'+currentInstructions+'\n</current_agent_settings>\n\nCurrent user request:\n'+prompt:prompt;
      active.currentSharedInstructions=currentInstructions;active.query=queryFn({prompt:queryPrompt,options});this._touch(active);
      if(Number.isFinite(this.turnTimeoutMs)&&this.turnTimeoutMs>0)active.deadlineTimer=timer=setTimeout(()=>{active.timedOut=true;active.timeoutCode='TIMEOUT';this._stopActive(active);},this.turnTimeoutMs);
      if(active.cancelled)this._stopActive(active);
      for await(const message of active.query){
        if(active.cancelled||active.timedOut||active.detached||this.disposed)break;
        this._touch(active);this._checkpoint(active);
        if(message.type==='system'&&message.subtype==='init'){
          if(message.model!==row.model||message.session_id!==row.threadId)throw this._error('MODEL_MISMATCH','model_mismatch');row.nativeStarted=true;await this._save();
        }else if(message.type==='stream_event'){
          const event=message.event;
          if(event.type==='message_start')blocks.start(event.message.id);
          if(event.type==='content_block_start')blocks.stream(event.index,event.content_block.type);
          if(event.type==='content_block_start'&&['text','thinking'].includes(event.content_block.type)){
            const item={id:`${blocks.currentMessageId}:${event.index}`,type:event.content_block.type==='text'?'agentMessage':'reasoning',text:event.content_block.text??event.content_block.thinking??''};if(!active.items.has(item.id))this._emitItem(active,item,'started');
          }
          if(event.type==='content_block_delta'&&event.delta.type==='text_delta'){
            const id=`${blocks.currentMessageId}:${event.index}`;const item=active.items.get(id)??{id,type:'agentMessage',text:''};if(!active.items.has(id))this._emitItem(active,item,'started');const delta=this._redact(event.delta.text);item.text+=delta;this._notify('item/agentMessage/delta',{threadId:row.threadId,turnId:turn.id,itemId:id,delta});
          }
          if(event.type==='content_block_delta'&&event.delta.type==='thinking_delta'){const item=active.items.get(`${blocks.currentMessageId}:${event.index}`);if(item)item.text+=this._redact(event.delta.thinking);}
        }else if(message.type==='assistant'){
          for(const {id,block}of blocks.snapshot(message)){
            if(block.type==='text')this._emitItem(active,{id,type:'agentMessage',text:this._redact(block.text)});
            else if(block.type==='thinking')this._emitItem(active,{id,type:'reasoning',text:this._redact(block.thinking)});
            else if(block.type==='tool_use'){
              const input=block.input??{};const item=WRITES.has(block.name)?{id:block.id,type:'fileChange',status:'inProgress',changes:[{path:input.file_path,kind:{type:'update'},diff:this._redact(input.new_string??input.content??'')}]}:{id:block.id,type:'commandExecution',status:'inProgress',command:`${block.name} ${input.file_path??input.path??input.pattern??''}`,cwd:row.cwd,aggregatedOutput:''};this._emitItem(active,item,'started');
            }
          }
        }else if(message.type==='user'){
          for(const block of Array.isArray(message.message?.content)?message.message.content:[]){if(block.type!=='tool_result')continue;const item=active.items.get(block.tool_use_id);if(!item)continue;item.status=block.is_error?'failed':'completed';item.aggregatedOutput=this._redact(textOf(block.content));item.exitCode=block.is_error?1:0;this._emitItem(active,item);}
        }else if(message.type==='result'){
          resultSeen=true;turn.status=message.subtype==='success'&&!message.is_error?'completed':'failed';if(turn.status==='completed'&&active.currentSharedInstructions)row.lastSharedInstructions=active.currentSharedInstructions;
          if(turn.status==='failed')turn.error={message:this._redact((message.errors??[]).join('\n')||message.result||this.t('failed'))};
          if(turn.status==='completed'&&message.result){
            const target=blocks.resultTarget(active.items,turn.id);
            if(target.kind==='fallback'||target.kind==='complete-stream')this._emitItem(active,{id:target.id,type:'agentMessage',text:this._redact(message.result)});
            else if(target.kind==='complete-blocks')for(const item of target.items)this._emitItem(active,item);
          }
          row.lastUsage=message.usage??null;row.actualModel=message.modelUsage?Object.keys(message.modelUsage):[row.model];
        }
      }
      if(!resultSeen&&!active.cancelled&&!active.timedOut)throw this._error('INCOMPLETE_TURN','failed');
    }catch(error){if(!active.cancelled&&!active.timedOut){turn.status='failed';turn.error={code:error.code??'CLAUDE_SDK_FAILED',message:this._redact(error.message??error)};}}
    finally{
      clearTimeout(timer);clearTimeout(active.idleTimer);clearTimeout(active.checkpointTimer);
      if(active.detached){if(this.inflight.get(row.sessionId)===active)this.inflight.delete(row.sessionId);return;}
      if(active.cancelled)turn.status='interrupted';else if(active.timedOut){turn.status='failed';turn.error={code:active.timeoutCode??'TIMEOUT',message:this.t(active.timeoutCode==='IDLE_TIMEOUT'?'idle_timeout':'timeout')};}
      try{Promise.resolve(active.query?.close?.()).catch(()=>{});}catch{}
      this._stderr(active,'',true);
      for(const pending of [...this.pending.values()])if(pending.sessionId===row.sessionId)pending.finish(false,'cancelled');
      turn.completedAt=new Date().toISOString();row.updatedAt=turn.completedAt;try{await this._save();}catch(error){turn.status='failed';turn.error={code:error.code,message:error.message};}
      if(active.detached||this.disposed){if(this.inflight.get(row.sessionId)===active)this.inflight.delete(row.sessionId);return;}
      this.inflight.delete(row.sessionId);this._notify('turn/completed',{threadId:row.threadId,turn:structuredClone(turn)});const event={sessionId:row.sessionId,threadId:row.threadId,turnId:turn.id,status:turn.status,error:turn.error??null,turn:structuredClone(turn),phase:'completed'};this.emit('turn',event);this.emit('turn-completed',event);
      if(turn.status==='completed'&&this.options.autoQueue!==false&&!this.disposed&&!this.disposing&&row.queue.some(item=>item.status==='queued'))setImmediate(()=>{if(!this.disposed&&!this.disposing&&!row.archived)this.startQueued(row.sessionId).catch(error=>this.emit('queue-error',{sessionId:row.sessionId,code:error.code??'QUEUE_FAILED',message:this._redact(error.message)}));});
    }
  }
  async interrupt(id){const active=this.inflight.get(id);if(!active)return {sessionId:id,interrupted:false};active.cancelled=true;this._stopActive(active);if(!await bounded(active.done,this.interruptTimeoutMs))throw this._error('INTERRUPT_TIMEOUT','interrupt_timeout');return {sessionId:id,threadId:active.row.threadId,turnId:active.turn.id,interrupted:true};}
  async steer(){throw this._error('UNSUPPORTED_STEER','unsupported');}
  async respondApproval(id,result){const pending=this.pending.get(String(id));if(!pending)throw this._error('APPROVAL_NOT_FOUND','invalid_input');pending.finish(result?.decision==='accept'||result?.decision==='acceptForSession'||result?.behavior==='allow');return {};}
  async setModel(id,model){await this.ensureStarted();return this._lock(id,async()=>{if(this.inflight.has(id))throw this._error('TURN_IN_FLIGHT','busy');const selection=model,c=this._connection(selection);model=c.model;this._model(model);const row=this._row(id);row.model=model;row.selection=selection;row.provider=c.provider;await this._save();return this._public(row);});}
  async renameSession(id,name){await this.ensureStarted();const row=this._row(id);row.name=String(name).slice(0,300);await this._save();return this._public(row);}
  async archiveSession(id){await this.interrupt(id);const row=this._row(id);row.archived=true;await this._save();return this._public(row);}
  async restoreSession(id){await this.ensureStarted();const row=this._row(id);row.archived=false;await this._save();return this._public(row);}
  async forkSession(){throw this._error('UNSUPPORTED_FORK','unsupported');}
  async moveSession(id,cwd){await this.ensureStarted();if(this.inflight.has(id))throw this._error('TURN_IN_FLIGHT','busy');const row=this._row(id);if(await canonical(path.resolve(cwd))!==row.cwd)throw this._error('UNSUPPORTED_MOVE','unsupported');return this._public(row);}
  async queueRequest(id,action,params={}){await this.ensureStarted();if(action==='start')return this.startQueued(id,params);return this._lock(id,async()=>{
    const row=this._row(id);const find=()=>{const item=row.queue.find(entry=>entry.id===(params.queuedSubmissionId??params.queuedItemId??params.itemId??params.id));if(!item||item.status!=='queued')throw this._error('QUEUE_INVALID','queue_invalid');return item;};let result;
    if(action==='list')return {data:structuredClone(row.queue),nextCursor:null};
    const normalize=value=>[{type:'text',text:this._input(value),text_elements:[]}];
    if(action==='add'){const item={id:randomUUID(),input:normalize(params.input??params.text),clientUserMessageId:params.clientUserMessageId??randomUUID(),status:'queued',createdAt:new Date().toISOString()};row.queue.push(item);result={queuedSubmission:structuredClone(item)};}
    else if(action==='update'){const item=find();item.input=normalize(params.input??params.text);result={queuedSubmission:structuredClone(item)};}
    else if(action==='delete'){const item=find();row.queue=row.queue.filter(entry=>entry!==item);result={deleted:true};}
    else if(action==='reorder'){const ids=params.queuedSubmissionIds??params.itemIds??params.order??params.ids;if(!Array.isArray(ids)||ids.length!==row.queue.length||new Set(ids).size!==ids.length||ids.some(value=>!row.queue.some(item=>item.id===value)))throw this._error('QUEUE_INVALID','queue_invalid');row.queue=ids.map(value=>row.queue.find(item=>item.id===value));result={};}
    else throw this._error('UNSUPPORTED_QUEUE_ACTION','unsupported');await this._save();this._notify('thread/queue/changed',{threadId:row.threadId});return result;
  });}
  async startQueued(id,params={}){
    await this.ensureStarted();
    const {row,item}=await this._lock(id,async()=>{
      if(this.inflight.has(id))throw this._error('TURN_IN_FLIGHT','busy');
      const row=this._row(id),wanted=params.queuedSubmissionId??params.queuedItemId??params.itemId??params.id;
      const item=wanted?row.queue.find(entry=>entry.id===wanted):row.queue.find(entry=>entry.status==='queued');
      if(!item||item.status!=='queued'||row.queue.some(entry=>entry.status==='starting'))throw this._error('QUEUE_INVALID','queue_invalid');
      item.status='starting';try{await this._save();}catch(error){item.status='queued';throw error;}return {row,item};
    });
    try{
      const started=await this.startTurn(id,item.input,{...params,queueClaimId:item.id});
      row.queue=row.queue.filter(entry=>entry.id!==item.id);await this._save();this._notify('thread/queue/changed',{threadId:row.threadId});return {turn:structuredClone(row.turns.find(turn=>turn.id===started.turnId))};
    }catch(error){
      if(row.turns.some(turn=>turn.queuedSubmissionId===item.id))row.queue=row.queue.filter(entry=>entry.id!==item.id);else item.status='queued';
      await this._save();throw error;
    }
  }
  async dispose(){if(this.disposal)return this.disposal;if(this.disposed)return;this.disposing=true;this.disposal=(async()=>{
    const active=[...this.inflight.values()];for(const value of active){value.cancelled=true;this._stopActive(value);}
    for(const pending of [...this.pending.values()])pending.finish(false,'disposed');
    await bounded(Promise.allSettled(active.map(value=>value.done)),this.shutdownTimeoutMs);
    // An uncooperative iterator remains quarantined; it cannot publish late
    // events, authorize tools, or overwrite the durable interrupted checkpoint.
    for(const value of this.inflight.values()){value.detached=true;value.turn.status='interrupted';clearTimeout(value.idleTimer);clearTimeout(value.deadlineTimer);clearTimeout(value.checkpointTimer);}
    if(this.loaded)await bounded(this._save(),this.shutdownTimeoutMs);
    this.disposed=true;this._ready=false;this.secret=null;this.disposing=false;
  })();return this.disposal;}
}
