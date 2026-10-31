// Model catalog endpoints can differ from inference endpoints. Keep credentials
// on the configured origin; provider names never authorize another destination.
export function modelDiscoveryURL(base,api){
  const url=new URL(base);
  if(url.hostname==='opencode.ai'){
    const match=url.pathname.match(/^\/(inference|zen)(\/go)?(?:\/(?:openai|anthropic|google))?(?:\/v1)?\/?$/);
    if(match){url.pathname=`/${match[1]}${match[2]??''}/v1/models`;return url.href;}
  }
  const root=base.replace(/\/$/,'');
  return root+(api==='anthropic-messages'&&!root.endsWith('/v1')?'/v1':'')+'/models';
}
const modelId=id=>typeof id==='string'&&id.length>0&&id.length<=180&&!/[\s\x00-\x1f\x7f]/.test(id);
const capacity=value=>Number.isSafeInteger(value)&&value>0&&value<=20_000_000?value:undefined;
export function readDiscoveredModels(data){
  let rows;if(Array.isArray(data?.data))rows=data.data;
  else if(Array.isArray(data?.models))rows=data.models;
  else if(data?.models&&typeof data.models==='object')rows=Object.entries(data.models).filter(([,value])=>value&&typeof value==='object'&&!Array.isArray(value)).map(([id,value])=>({...value,id:value.id??id}));
  else throw Object.assign(new Error('MODEL_DISCOVERY_FAILED'),{code:'MODEL_DISCOVERY_FAILED'});
  const found=new Map();let overflow=false;
  for(const row of rows){if(!modelId(row?.id))continue;if(!found.has(row.id)&&found.size>=500){overflow=true;continue;}const name=row.display_name??row.name,contextWindow=capacity(row.context_window??row.contextWindow??row.context_length??row.limit?.context),maxTokens=capacity(row.max_tokens??row.maxTokens??row.limit?.output??row.top_provider?.max_completion_tokens);
    found.set(row.id,{id:row.id,name:typeof name==='string'?name.slice(0,120):row.id,...(contextWindow?{contextWindow}:{}),...(maxTokens?{maxTokens}:{}),...(typeof row.reasoning==='boolean'?{reasoning:row.reasoning}:{})});
  }
  return{models:[...found.values()],hasMore:overflow||data.has_more===true};
}
