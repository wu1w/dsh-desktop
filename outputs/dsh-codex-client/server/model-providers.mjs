import {readFile,open,rename,rm,lstat} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {modelDiscoveryURL,readDiscoveredModels} from './model-discovery.mjs';
import {MODEL_PROTOCOLS,providerPresets,protocolForEngine,modelSelection,canTranslate} from '../shared/model-providers.js';
import {translateRequest,translateJson,createStreamTranslator} from './wire-translate.mjs';

const fail=code=>{throw Object.assign(new Error(code),{code});};
async function readText(stream,limit){const parts=[];let size=0;for await(const chunk of stream){const bytes=Buffer.from(chunk);size+=bytes.length;if(size>limit)fail('INVALID_REQUEST');parts.push(bytes);}return Buffer.concat(parts).toString('utf8');}
const CATALOG_LIMIT=8*1024*1024; // Match the existing client-state storage ceiling.
const MODEL_LIMIT=10000;
const validModel=(id,max=180)=>typeof id==='string'&&id.length>0&&id.length<=max&&!/[\s\x00-\x1f\x7f]/.test(id);
const positive=(n,fallback)=>n==null||n===''?fallback:Number.isSafeInteger(Number(n))&&Number(n)>0&&Number(n)<=20_000_000?Number(n):fail('MODEL_CONFIG_INVALID');
function endpoint(value){try{const url=new URL(value);if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)fail('MODEL_ENDPOINT_INVALID');return url.href.replace(/\/$/,'');}catch{fail('MODEL_ENDPOINT_INVALID');}}
function key(value){if(typeof value!=='string'||!value.trim()||!/^[\x21-\x7e]+$/.test(value.trim())||/^[A-Z_]+\s*=|^["']|["']$/.test(value.trim()))fail('MODEL_KEY_INVALID');return value.trim();}
export function providerURL(base,api,action='models'){
  base=base.replace(/\/$/,'');
  return base+(api==='anthropic-messages'&&!base.endsWith('/v1')?'/v1':'')+'/'+action;
}
function normalize(input,old){
  const historical=input?.id==='opencode_go'&&old?.legacy===true;
  if(!input||typeof input!=='object'||!/^[-a-z0-9_]{1,40}$/.test(input.id)||['__proto__','constructor','prototype'].includes(input.id)||!MODEL_PROTOCOLS.includes(input.api)||typeof input.name!=='string'||!input.name.trim()||input.name.length>100||!Array.isArray(input.models)||input.models.length>(historical?MODEL_LIMIT:500))fail('MODEL_CONFIG_INVALID');
  const baseURL=endpoint(input.baseURL),auth=input.auth??'key';if(!['key','none','legacy'].includes(auth)||auth==='legacy'&&(input.id!=='opencode_go'||new URL(baseURL).origin!=='https://opencode.ai'))fail('MODEL_CONFIG_INVALID');
  const models=input.models.map(m=>{if(!m||!validModel(m.id,historical?256:180)||m.name!=null&&(typeof m.name!=='string'||m.name.length>(historical?1024:120)))fail('MODEL_CONFIG_INVALID');return{id:m.id,name:m.name?.trim()||m.id,contextWindow:positive(m.contextWindow,131072),maxTokens:positive(m.maxTokens,8192),reasoning:m.reasoning===true};});
  if(new Set(models.map(m=>m.id)).size!==models.length)fail('MODEL_CONFIG_INVALID');
  const apiKey=input.apiKey===null?undefined:input.apiKey===undefined||input.apiKey===''?old?.apiKey:key(input.apiKey);
  if(old?.baseURL!==undefined&&old.baseURL!==baseURL&&!input.apiKey&&(old.apiKey||old.auth==='legacy'))fail('MODEL_KEY_REENTER');
  // Legacy routes preserve their known per-engine endpoints until explicitly
  // changed. User-defined routes always have exactly the selected protocol.
  return {id:input.id,name:input.name.trim(),api:input.api,baseURL,auth,enabled:input.enabled!==false,models,...(apiKey?{apiKey}:{}),...(old?.endpoints&&old.baseURL===baseURL&&old.api===input.api?{endpoints:old.endpoints}:{}),...(old?.legacy?{legacy:true}:{})};
}
export class ModelProviders{
  constructor({dataDir,legacyModels,resolveLegacyKey=async()=>null,isBusy=()=>false,isUsed=()=>false,onChange=()=>{},fetchImpl=fetch}){this.file=path.join(dataDir,'model-providers.json');this.legacyModels=legacyModels;this.resolveLegacyKey=resolveLegacyKey;this.isBusy=isBusy;this.isUsed=isUsed;this.onChange=onChange;this.fetch=fetchImpl;this.writing=Promise.resolve();this.controllers=new Set();this.state=null;}
  async load(){try{const info=await lstat(this.file);if(!info.isFile()||info.isSymbolicLink()||info.size>CATALOG_LIMIT||(process.platform!=='win32'&&(info.mode&0o077)))fail('MODEL_STORAGE_INVALID');const value=JSON.parse(await readFile(this.file,'utf8'));if(value.version!==1||typeof value.revision!=='string'||!Array.isArray(value.providers)||value.providers.length>100)fail('MODEL_STORAGE_INVALID');value.providers=value.providers.map(p=>normalize(p,p));if(new Set(value.providers.map(p=>p.id)).size!==value.providers.length||value.providers.reduce((n,p)=>n+p.models.length,0)>MODEL_LIMIT)fail('MODEL_STORAGE_INVALID');this.state=value;}catch(error){if(error.code!=='ENOENT')throw error;this.state={version:1,revision:randomUUID(),providers:[
    // 默认让用户填 DeepSeek 官方密钥。官方 /models 只声明 anthropic_messages 能力，
    // 所以 Claude Code 走原生 Anthropic 端点，Codex 走宿主转换（responses -> completions）。
    {id:'deepseek',name:'DeepSeek',api:'openai-completions',baseURL:'https://api.deepseek.com',auth:'key',enabled:true,models:[
      {id:'deepseek-flash',name:'DeepSeek-V4.1-Flash',contextWindow:1_048_576,maxTokens:393_216,reasoning:true}
    ],endpoints:{'claude-code':{api:'anthropic-messages',baseURL:'https://api.deepseek.com/anthropic'}}},
    // Harness 既有凭据的兜底路由：支持全部三个引擎，凭据可用时置顶。
    {id:'opencode_go',name:'OpenCode Go',api:'anthropic-messages',baseURL:'https://opencode.ai/inference/go/anthropic',auth:'legacy',legacy:true,enabled:true,models:[{id:'deepseek-v4.1-flash',name:'DeepSeek V4.1 Flash',contextWindow:1_000_000,maxTokens:32000,reasoning:true}],endpoints:{codex:{api:'openai-responses',baseURL:'https://opencode.ai/inference/go/openai/v1'},'claude-code':{api:'anthropic-messages',baseURL:'https://opencode.ai/inference/go/anthropic'},'dsh-native':{api:'anthropic-messages',baseURL:'https://opencode.ai/inference/go/anthropic'}}}
  ]};}
  // Before the provider catalog existed, unqualified model IDs belonged to Go.
  // Keep those IDs (and metadata) so existing chats still resolve after upgrade.
  if(this.legacyModels?.length&&!await lstat(this.file).catch(()=>null)){
    const legacy=this.state.providers.find(p=>p.id==='opencode_go');
    const migrated=this.legacyModels.filter(m=>m&&validModel(m.id,256)&&!m.id.startsWith('@'));
    if(migrated.length>MODEL_LIMIT)fail('MODEL_STORAGE_INVALID');
    if(migrated.length){
      const seen=new Set();legacy.models=migrated.filter(m=>!seen.has(m.id)&&seen.add(m.id));
      // Historical IDs own the existing client-state budget. Built-in defaults
      // may fill free slots but must never replace history at the limit.
      let remaining=MODEL_LIMIT-legacy.models.length;
      for(const provider of this.state.providers){if(provider===legacy)continue;provider.models=provider.models.slice(0,remaining);remaining-=provider.models.length;}
      if(remaining&&!seen.has('deepseek-v4.1-flash'))legacy.models.push({id:'deepseek-v4.1-flash',name:'DeepSeek V4.1 Flash',contextWindow:1000000,maxTokens:32000,reasoning:true});
      this.state.providers=this.state.providers.map(p=>normalize(p,p));
    }
  }
  this.legacyReady=await Promise.resolve().then(()=>this.resolveLegacyKey()).then(key=>!!key).catch(()=>false);
  return this;}
  configured(p){return p.auth==='none'||!!p.apiKey||(p.auth==='legacy'&&this.legacyReady);}
  ordered(){
    // Prefer a configured official route. Never choose an unconfigured legacy
    // route ahead of the setup path; keep all entries for historical sessions.
    const score=p=>p.enabled&&this.configured(p)?(p.id==='deepseek'?0:1):p.id==='deepseek'?2:3;
    return [...this.state.providers].sort((a,b)=>score(a)-score(b));
  }
  public(){return{revision:this.state.revision,presets:providerPresets,providers:this.ordered().map(({apiKey,...p})=>({...p,keyConfigured:this.configured({...p,apiKey}),engines:['dsh-native','codex','claude-code'].filter(e=>protocolForEngine(p,e))}))};}
  models(engine){return this.ordered().filter(p=>p.enabled).flatMap(p=>p.models.map(m=>{
    const compatible=!engine||!!protocolForEngine(p,engine),keyConfigured=this.configured(p);
    return {...m,id:modelSelection(p.id,m.id),modelId:m.id,providerId:p.id,providerName:p.name,engines:['dsh-native','codex','claude-code'].filter(e=>protocolForEngine(p,e)),keyConfigured,available:compatible&&keyConfigured,...(engine&&protocolForEngine(p,engine)?.translateTo&&new URL(p.baseURL).origin==='https://api.deepseek.com'?{reasoningSupported:false,limitations:['translated-text-tools','thinking-disabled']}:{}),unavailableReason:!compatible?'MODEL_ENGINE_UNSUPPORTED':!keyConfigured?'MODEL_KEY_REQUIRED':null};
  }));}
  resolve(selection,engine){const match=this.models().find(m=>m.id===selection);if(!match)fail('MODEL_NOT_FOUND');const p=this.state.providers.find(p=>p.id===match.providerId),wire=protocolForEngine(p,engine);if(!wire)fail('MODEL_ENGINE_UNSUPPORTED');return{...match,model:match.modelId,provider:p.id,api:wire.api,baseURL:wire.baseURL,revision:this.state.revision,legacy:p.legacy===true};}
  async credential(p){
    if(p.auth==='none')return '';if(p.apiKey)return p.apiKey;
    if(p.auth==='legacy'){
      try{const value=await this.resolveLegacyKey();this.legacyReady=!!value;if(value)return value;}
      catch(error){this.legacyReady=false;if(['CREDENTIAL_PERMISSIONS','CREDENTIAL_STORE_CHANGED'].includes(error.code??error.message))throw error;}
    }
    fail('MODEL_KEY_REQUIRED');
  }
  async preflight(selection,engine,{input=[]}={}){
    const connection=this.resolve(selection,engine),p=this.state.providers.find(p=>p.id===connection.provider);
    const wire=protocolForEngine(p,engine),parts=Array.isArray(input)?input:[input];
    if(wire.translateTo&&parts.some(item=>item&&['image','localImage','input_image','input_file','audio','input_audio','file'].includes(item.type)))fail('MODEL_INPUT_UNSUPPORTED');
    try{await this.credential(p);}catch(error){error.providerId=p.id;error.action='open-model-settings';throw error;}
    return {ready:true,providerId:p.id,model:selection,engine,checks:['configuration','credential'],inferenceTested:false};
  }
  async commit(next){const serialized=JSON.stringify(next,null,2);if(Buffer.byteLength(serialized)>CATALOG_LIMIT)fail('MODEL_STORAGE_INVALID');const temporary=this.file+'.'+randomUUID()+'.tmp';let file;try{file=await open(temporary,'wx',0o600);await file.writeFile(serialized);await file.sync();await file.close();file=null;await rename(temporary,this.file);}finally{await file?.close();await rm(temporary,{force:true});}this.state=next;this.onChange();return this.public();}
  mutate(body,remove=false){const operation=this.writing.then(async()=>{if(body.revision!==this.state.revision)fail('MODEL_CONFIG_CONFLICT');if(this.isBusy())fail('ENGINE_BUSY');const old=this.state.providers.find(p=>p.id===body.id);if(body.create===true&&old)fail('MODEL_PROVIDER_EXISTS');if(remove&&(!old||old.legacy))fail('MODEL_CONFIG_INVALID');if(remove&&this.isUsed(body.id))fail('MODEL_PROVIDER_IN_USE');let provider;if(!remove){provider=normalize(body,old);if(old&&old.models.some(m=>!provider.models.some(n=>n.id===m.id)&&this.isUsed(old.id,m.id)))fail('MODEL_PROVIDER_IN_USE');}
    const rows=this.state.providers.filter(p=>p.id!==body.id);if(!remove)rows.splice(old?this.state.providers.indexOf(old):rows.length,0,provider);if(rows.length>100||rows.reduce((n,p)=>n+p.models.length,0)>MODEL_LIMIT)fail('MODEL_CONFIG_INVALID');return this.commit({...this.state,revision:randomUUID(),providers:rows});});this.writing=operation.catch(()=>{});return operation;}
  async discover(body){
    const old=this.state.providers.find(p=>p.id===body.id);
    // A half-entered model row must not prevent fetching the list that fills it.
    const p=normalize({...body,id:body.id||'discovery',name:body.name?.trim()||'Discovery',models:[]},old);
    const credential=await this.credential(p),sourceURL=modelDiscoveryURL(p.baseURL,p.api);
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);this.controllers.add(controller);
    try{
      const response=await this.fetch(sourceURL,{headers:{...authHeaders(p.api,credential),accept:'application/json','user-agent':'dsh-desktop/0.1.0'},redirect:'error',signal:controller.signal});
      if(!response.ok){await response.body?.cancel();fail(response.status===401||response.status===403?'MODEL_AUTH_FAILED':response.status===404||response.status===405?'MODEL_DISCOVERY_UNSUPPORTED':'MODEL_DISCOVERY_FAILED');}
      const text=await readText(response.body,2*1024*1024);return{...readDiscoveredModels(JSON.parse(text)),sourceURL};
    }catch(error){if(['MODEL_AUTH_FAILED','MODEL_DISCOVERY_UNSUPPORTED','MODEL_DISCOVERY_FAILED'].includes(error.code))throw error;fail('MODEL_DISCOVERY_FAILED');}
    finally{clearTimeout(timer);this.controllers.delete(controller);}
  }
  async proxy(request,response,{provider,api,action,bearer}){
    if(request.method!=='POST'||request.headers.authorization!==`Bearer ${bearer}`&&request.headers['x-api-key']!==bearer)fail('FORBIDDEN');
    if(!['responses','messages','messages/count_tokens','chat/completions'].includes(action))fail('NOT_FOUND');
    const p=this.state.providers.find(p=>p.id===provider&&p.enabled);if(!p)fail('MODEL_NOT_FOUND');const wire=[{api:p.api,baseURL:p.baseURL},...Object.values(p.endpoints??{})].find(w=>w.api===api)??(canTranslate(p.api,api)?{api,baseURL:p.baseURL,translateTo:p.api}:null);if(!wire||api==='openai-responses'&&action!=='responses'||api==='anthropic-messages'&&!action.startsWith('messages')||api==='openai-completions'&&action!=='chat/completions')fail('MODEL_ENGINE_UNSUPPORTED');
    // Token counting must never become a billable completion request.
    if(wire.translateTo&&action==='messages/count_tokens')fail('MODEL_ENGINE_UNSUPPORTED');
    const text=await readText(request,32*1024*1024);let body;try{body=JSON.parse(text);}catch{fail('INVALID_REQUEST');}if(!p.models.some(m=>m.id===body.model))fail('MODEL_NOT_FOUND');
    const controller=new AbortController();this.controllers.add(controller);const disconnect=()=>controller.abort();response.once('close',disconnect);let idle=setTimeout(disconnect,300000);const touch=()=>{clearTimeout(idle);idle=setTimeout(disconnect,300000);};
    const translating=!!wire.translateTo;
    try{const credential=await this.credential(p);
      const upstreamApi=translating?p.api:api,upstreamAction=translating?'chat/completions':action;
      let upstreamBody=translating?JSON.stringify(translateRequest(api,body)):text;
      // 有些 OpenAI 兼容服务（含 DeepSeek 官方）不认 developer 角色，会直接 422。
      // system 是各家的公共子集，语义差异可以接受。
      if(upstreamApi==='openai-completions'){
        try{const parsed=JSON.parse(upstreamBody);if(Array.isArray(parsed.messages)){let changed=false;for(const message of parsed.messages){if(message&&message.role==='developer'){message.role='system';changed=true;}}if(translating&&new URL(p.baseURL).origin==='https://api.deepseek.com'){parsed.thinking={type:'disabled'};delete parsed.reasoning_effort;changed=true;}if(changed)upstreamBody=JSON.stringify(parsed);}}catch{}
      }
      const upstream=await this.fetch(providerURL(translating?p.baseURL:wire.baseURL,upstreamApi,upstreamAction),{method:'POST',headers:forwardHeaders(request.headers,upstreamApi,credential),body:upstreamBody,redirect:'error',signal:controller.signal});
      if(!upstream.ok){await upstream.body?.cancel();const code=upstream.status===401||upstream.status===403?'MODEL_AUTH_FAILED':upstream.status===402?'MODEL_QUOTA_EXCEEDED':upstream.status===429?'MODEL_RATE_LIMITED':upstream.status>=500?'MODEL_SERVICE_UNAVAILABLE':'MODEL_REQUEST_FAILED';writeProviderError(response,code,p.id,upstream.status);return;}
      if(translating){
        if(body.stream){
          response.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-store'});
          const translator=createStreamTranslator(api,body.model,response,{tools:body.tools,signal:controller.signal}),decoder=new TextDecoder();
          for await(const chunk of upstream.body){touch();translator.push(decoder.decode(chunk,{stream:true}));}
          translator.push(decoder.decode());translator.finish();response.end();return;
        }
        const raw=await readText(upstream.body,32*1024*1024);let json=null;try{json=JSON.parse(raw);}catch{json=null;}
        if(!json)fail('MODEL_PROTOCOL_INVALID');
        const translated=JSON.stringify(translateJson(api,json,body.model,{tools:body.tools}));
        response.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});response.end(translated);return;
      }
      response.writeHead(upstream.status,{'content-type':upstream.headers.get('content-type')??'application/json','cache-control':'no-store'});for await(const chunk of upstream.body){touch();if(!response.write(chunk))await once(response,'drain',{signal:controller.signal});}response.end();
    }catch(error){if(!response.headersSent){const code=providerErrorCodes.has(error.code??error.message)?(error.code??error.message):controller.signal.aborted?'MODEL_REQUEST_TIMEOUT':error.name==='TypeError'?'MODEL_NETWORK_FAILED':'MODEL_REQUEST_FAILED';writeProviderError(response,code,p.id,code==='MODEL_KEY_REQUIRED'?400:502);}else response.destroy();}finally{clearTimeout(idle);response.off('close',disconnect);this.controllers.delete(controller);}
  }
  close(){for(const controller of this.controllers)controller.abort();return this.writing;}
}
function authHeaders(api,credential){return{'content-type':'application/json',...(api==='anthropic-messages'?{'anthropic-version':'2023-06-01',...(credential?{'x-api-key':credential}:{})}:credential?{authorization:`Bearer ${credential}`}:{})};}

// Preserve SDK session routing and protocol extensions, never incoming auth/cookies.
function forwardHeaders(incoming,api,credential){const headers={...authHeaders(api,credential),'user-agent':'dsh-desktop/0.1.0'};for(const name of ['anthropic-beta','x-opencode-session','x-deepseek-harness-session-id','thread-id','session-id','session_id','x-session-id','x-client-session-id','x-claude-code-session-id']){const value=incoming[name];if(typeof value==='string'&&value.length<=1024&&!/[\x00-\x1f\x7f]/.test(value))headers[name]=value;}const session=['x-opencode-session','x-deepseek-harness-session-id','thread-id','session-id','session_id','x-session-id','x-client-session-id','x-claude-code-session-id'].map(name=>headers[name]).find(Boolean);if(session)headers['x-opencode-session']=session;return headers;}

const providerErrorCodes=new Set(['MODEL_KEY_REQUIRED','MODEL_AUTH_FAILED','MODEL_QUOTA_EXCEEDED','MODEL_RATE_LIMITED','MODEL_SERVICE_UNAVAILABLE','MODEL_REQUEST_TIMEOUT','MODEL_NETWORK_FAILED','MODEL_REQUEST_FAILED','MODEL_INPUT_UNSUPPORTED','MODEL_STREAM_INCOMPLETE','MODEL_RESPONSE_INVALID','MODEL_PROTOCOL_INVALID','MODEL_TOOL_UNSUPPORTED','MODEL_PROTOCOL_LIMIT','MODEL_REQUEST_CANCELLED','CREDENTIAL_PERMISSIONS','CREDENTIAL_STORE_CHANGED']);
function writeProviderError(response,code,providerId,status){
  response.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});
  response.end(JSON.stringify({error:{type:'provider_error',code,message:code,providerId,...(['MODEL_KEY_REQUIRED','MODEL_AUTH_FAILED','CREDENTIAL_PERMISSIONS','CREDENTIAL_STORE_CHANGED'].includes(code)?{action:'open-model-settings'}:{})}}));
}
