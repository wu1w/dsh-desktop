import {readFile,open,rename,rm,lstat} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {modelDiscoveryURL,readDiscoveredModels} from './model-discovery.mjs';
import {MODEL_PROTOCOLS,providerPresets,protocolForEngine,modelSelection} from '../shared/model-providers.js';

const fail=code=>{throw Object.assign(new Error(code),{code});};
async function readText(stream,limit){const parts=[];let size=0;for await(const chunk of stream){const bytes=Buffer.from(chunk);size+=bytes.length;if(size>limit)fail('INVALID_REQUEST');parts.push(bytes);}return Buffer.concat(parts).toString('utf8');}
const validModel=id=>typeof id==='string'&&id.length>0&&id.length<=180&&!/[\s\x00-\x1f\x7f]/.test(id);
const positive=(n,fallback)=>n==null||n===''?fallback:Number.isSafeInteger(Number(n))&&Number(n)>0&&Number(n)<=20_000_000?Number(n):fail('MODEL_CONFIG_INVALID');
function endpoint(value){try{const url=new URL(value);if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)fail('MODEL_ENDPOINT_INVALID');return url.href.replace(/\/$/,'');}catch{fail('MODEL_ENDPOINT_INVALID');}}
function key(value){if(typeof value!=='string'||!value.trim()||!/^[\x21-\x7e]+$/.test(value.trim())||/^[A-Z_]+\s*=|^["']|["']$/.test(value.trim()))fail('MODEL_KEY_INVALID');return value.trim();}
export function providerURL(base,api,action='models'){
  base=base.replace(/\/$/,'');
  return base+(api==='anthropic-messages'&&!base.endsWith('/v1')?'/v1':'')+'/'+action;
}
function normalize(input,old){
  if(!input||typeof input!=='object'||!/^[-a-z0-9_]{1,40}$/.test(input.id)||['__proto__','constructor','prototype'].includes(input.id)||!MODEL_PROTOCOLS.includes(input.api)||typeof input.name!=='string'||!input.name.trim()||input.name.length>100||!Array.isArray(input.models)||input.models.length>500)fail('MODEL_CONFIG_INVALID');
  const baseURL=endpoint(input.baseURL),auth=input.auth??'key';if(!['key','none','legacy'].includes(auth)||auth==='legacy'&&input.id!=='opencode_go')fail('MODEL_CONFIG_INVALID');
  const models=input.models.map(m=>{if(!m||!validModel(m.id)||m.name!=null&&(typeof m.name!=='string'||m.name.length>120))fail('MODEL_CONFIG_INVALID');return{id:m.id,name:m.name?.trim()||m.id,contextWindow:positive(m.contextWindow,131072),maxTokens:positive(m.maxTokens,8192),reasoning:m.reasoning===true};});
  if(new Set(models.map(m=>m.id)).size!==models.length)fail('MODEL_CONFIG_INVALID');
  const apiKey=input.apiKey===null?undefined:input.apiKey===undefined||input.apiKey===''?old?.apiKey:key(input.apiKey);
  if(old?.baseURL!==undefined&&old.baseURL!==baseURL&&!input.apiKey&&(old.apiKey||old.auth==='legacy'))fail('MODEL_KEY_REENTER');
  // Legacy routes preserve their known per-engine endpoints until explicitly
  // changed. User-defined routes always have exactly the selected protocol.
  return {id:input.id,name:input.name.trim(),api:input.api,baseURL,auth,enabled:input.enabled!==false,models,...(apiKey?{apiKey}:{}),...(old?.endpoints&&old.baseURL===baseURL&&old.api===input.api?{endpoints:old.endpoints}:{}),...(old?.legacy?{legacy:true}:{})};
}
export class ModelProviders{
  constructor({dataDir,legacyModels,resolveLegacyKey,isBusy=()=>false,isUsed=()=>false,onChange=()=>{},fetchImpl=fetch}){this.file=path.join(dataDir,'model-providers.json');this.legacyModels=legacyModels;this.resolveLegacyKey=resolveLegacyKey;this.isBusy=isBusy;this.isUsed=isUsed;this.onChange=onChange;this.fetch=fetchImpl;this.writing=Promise.resolve();this.controllers=new Set();this.state=null;}
  async load(){try{const info=await lstat(this.file);if(!info.isFile()||info.isSymbolicLink()||info.size>4*1024*1024||(info.mode&0o077))fail('MODEL_STORAGE_INVALID');const value=JSON.parse(await readFile(this.file,'utf8'));if(value.version!==1||typeof value.revision!=='string'||!Array.isArray(value.providers)||value.providers.length>100)fail('MODEL_STORAGE_INVALID');value.providers=value.providers.map(p=>normalize(p,p));if(new Set(value.providers.map(p=>p.id)).size!==value.providers.length)fail('MODEL_STORAGE_INVALID');this.state=value;}catch(error){if(error.code!=='ENOENT')throw error;this.state={version:1,revision:randomUUID(),providers:[{id:'opencode_go',name:'OpenCode Go',api:'anthropic-messages',baseURL:'https://opencode.ai/inference/go/anthropic',auth:'legacy',legacy:true,enabled:true,models:(this.legacyModels??[{id:'deepseek-v4.1-flash',name:'DeepSeek V4.1 Flash'}]).map(m=>({...m,contextWindow:1_000_000,maxTokens:32000,reasoning:true})),endpoints:{codex:{api:'openai-responses',baseURL:'https://opencode.ai/inference/go/openai/v1'},'claude-code':{api:'anthropic-messages',baseURL:'https://opencode.ai/inference/go/anthropic'},'dsh-native':{api:'anthropic-messages',baseURL:'https://opencode.ai/inference/go/anthropic'}}}]};}return this;}
  public(){return{revision:this.state.revision,presets:providerPresets,providers:this.state.providers.map(({apiKey,...p})=>({...p,keyConfigured:!!apiKey||p.auth==='legacy',engines:['dsh-native','codex','claude-code'].filter(e=>protocolForEngine(p,e))}))};}
  models(engine){return this.state.providers.filter(p=>p.enabled).flatMap(p=>p.models.map(m=>({...m,id:modelSelection(p.id,m.id),modelId:m.id,providerId:p.id,providerName:p.name,engines:['dsh-native','codex','claude-code'].filter(e=>protocolForEngine(p,e)),available:!engine||!!protocolForEngine(p,engine)})));}
  resolve(selection,engine){const match=this.models().find(m=>m.id===selection);if(!match)fail('MODEL_NOT_FOUND');const p=this.state.providers.find(p=>p.id===match.providerId),wire=protocolForEngine(p,engine);if(!wire)fail('MODEL_ENGINE_UNSUPPORTED');return{...match,model:match.modelId,provider:p.id,api:wire.api,baseURL:wire.baseURL,revision:this.state.revision,legacy:p.legacy===true};}
  async credential(p){if(p.auth==='none')return '';if(p.apiKey)return p.apiKey;if(p.auth==='legacy')return this.resolveLegacyKey();fail('MODEL_KEY_REQUIRED');}
  async commit(next){const temporary=this.file+'.'+randomUUID()+'.tmp';let file;try{file=await open(temporary,'wx',0o600);await file.writeFile(JSON.stringify(next,null,2));await file.sync();await file.close();file=null;await rename(temporary,this.file);}finally{await file?.close();await rm(temporary,{force:true});}this.state=next;this.onChange();return this.public();}
  mutate(body,remove=false){const operation=this.writing.then(async()=>{if(body.revision!==this.state.revision)fail('MODEL_CONFIG_CONFLICT');if(this.isBusy())fail('ENGINE_BUSY');const old=this.state.providers.find(p=>p.id===body.id);if(body.create===true&&old)fail('MODEL_PROVIDER_EXISTS');if(remove&&(!old||old.legacy))fail('MODEL_CONFIG_INVALID');if(remove&&this.isUsed(body.id))fail('MODEL_PROVIDER_IN_USE');let provider;if(!remove){provider=normalize(body,old);if(old&&old.models.some(m=>!provider.models.some(n=>n.id===m.id)&&this.isUsed(old.id,m.id)))fail('MODEL_PROVIDER_IN_USE');}
    const rows=this.state.providers.filter(p=>p.id!==body.id);if(!remove)rows.splice(old?this.state.providers.indexOf(old):rows.length,0,provider);if(rows.length>100||rows.reduce((n,p)=>n+p.models.length,0)>10000)fail('MODEL_CONFIG_INVALID');return this.commit({...this.state,revision:randomUUID(),providers:rows});});this.writing=operation.catch(()=>{});return operation;}
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
    const p=this.state.providers.find(p=>p.id===provider&&p.enabled);if(!p)fail('MODEL_NOT_FOUND');const wire=[{api:p.api,baseURL:p.baseURL},...Object.values(p.endpoints??{})].find(w=>w.api===api);if(!wire||api==='openai-responses'&&action!=='responses'||api==='anthropic-messages'&&!action.startsWith('messages')||api==='openai-completions'&&action!=='chat/completions')fail('MODEL_ENGINE_UNSUPPORTED');
    const text=await readText(request,32*1024*1024);let body;try{body=JSON.parse(text);}catch{fail('INVALID_REQUEST');}if(!p.models.some(m=>m.id===body.model))fail('MODEL_NOT_FOUND');
    const controller=new AbortController();this.controllers.add(controller);const disconnect=()=>controller.abort();response.once('close',disconnect);let idle=setTimeout(disconnect,300000);const touch=()=>{clearTimeout(idle);idle=setTimeout(disconnect,300000);};
    try{const credential=await this.credential(p);const upstream=await this.fetch(providerURL(wire.baseURL,api,action),{method:'POST',headers:forwardHeaders(request.headers,api,credential),body:text,redirect:'error',signal:controller.signal});if(!upstream.ok){response.writeHead(upstream.status,{'content-type':'application/json'});response.end(JSON.stringify({error:{type:'provider_error',message:upstream.status===401||upstream.status===403?'MODEL_AUTH_FAILED':'MODEL_REQUEST_FAILED'}}));await upstream.body?.cancel();return;}
      response.writeHead(upstream.status,{'content-type':upstream.headers.get('content-type')??'application/json','cache-control':'no-store'});for await(const chunk of upstream.body){touch();if(!response.write(chunk))await once(response,'drain',{signal:controller.signal});}response.end();
    }catch{if(!response.headersSent){response.writeHead(502,{'content-type':'application/json'});response.end(JSON.stringify({error:{type:'provider_error',message:'MODEL_REQUEST_FAILED'}}));}else response.destroy();}finally{clearTimeout(idle);response.off('close',disconnect);this.controllers.delete(controller);}
  }
  close(){for(const controller of this.controllers)controller.abort();return this.writing;}
}
function authHeaders(api,credential){return{'content-type':'application/json',...(api==='anthropic-messages'?{'anthropic-version':'2023-06-01',...(credential?{'x-api-key':credential}:{})}:credential?{authorization:`Bearer ${credential}`}:{})};}

// Preserve SDK session routing and protocol extensions, never incoming auth/cookies.
function forwardHeaders(incoming,api,credential){const headers={...authHeaders(api,credential),'user-agent':'dsh-desktop/0.1.0'};for(const name of ['anthropic-beta','x-opencode-session','x-deepseek-harness-session-id','thread-id','session-id','session_id','x-session-id','x-client-session-id','x-claude-code-session-id']){const value=incoming[name];if(typeof value==='string'&&value.length<=1024&&!/[\x00-\x1f\x7f]/.test(value))headers[name]=value;}const session=['x-opencode-session','x-deepseek-harness-session-id','thread-id','session-id','session_id','x-session-id','x-client-session-id','x-claude-code-session-id'].map(name=>headers[name]).find(Boolean);if(session)headers['x-opencode-session']=session;return headers;}
