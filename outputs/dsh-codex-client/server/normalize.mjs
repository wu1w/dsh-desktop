import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { inside } from './files.mjs';

const timeMs=value=>typeof value==='string'?(Number.isFinite(Date.parse(value))?Date.parse(value):null):typeof value==='number'&&Number.isFinite(value)?(value<1e12?value*1000:value):null;
export function turnMetadata(turn={}){return {turnId:turn.id,turnStatus:turn.status,turnStartedAtMs:timeMs(turn.startedAt),turnCompletedAtMs:timeMs(turn.completedAt)};}
export function normalizeItem(item, root) {
  if (!item?.id || !item.type) return null;
  const base = { id: item.id, type: item.type, running: item.status === 'inProgress', ...(item.status?{status:item.status}:{}) };
  if (item.type === 'userMessage') return { ...base, text: (item.content ?? []).map(block => block.text ?? block.path ?? '').join('\n') };
  if (item.type === 'agentMessage') return { ...base, text: item.text ?? '', ...(['commentary','final_answer'].includes(item.phase)?{phase:item.phase}:{}) };
  if (item.type === 'reasoning') return { ...base, text: [...(item.summary ?? []), ...(item.content ?? [])].map(value=>typeof value==='string'?value:value?.text??'').join('\n') || item.text || '' };
  if((item.type==='mcpToolCall'&&item.server==='dsh_development')||(item.type==='commandExecution'&&/^(?:mcp__dsh_development__)?dsh_plugins(?:\s|$)/.test(item.command??''))){
    const output=item.result?.content?.filter(block=>block.type==='text').map(block=>block.text).join('\n')??item.aggregatedOutput??item.output??'';
    return {...base,type:'commandExecution',activity:'plugin',command:item.arguments?.action??'dsh_plugins',output:String(output).slice(0,24000),exitCode:item.status==='failed'||item.result?.isError?1:undefined};
  }
  if((item.type==='mcpToolCall'&&item.server==='dsh_computer')||(item.type==='commandExecution'&&/^(?:mcp__dsh_computer__)?dsh_computer(?:\s|$)/.test(item.command??''))){
    let value=item.result?.content?.filter(block=>block.type==='text').map(block=>block.text).join('\n')??item.aggregatedOutput??item.output??'';
    for(let i=0;i<3;i++){try{if(typeof value==='string')value=JSON.parse(value);else if(value?.text)value=value.text;else break;}catch{break;}}
    const action=item.arguments?.action??value?.action??'';
    const summary=typeof value==='object'&&value?Object.fromEntries(['title','url','text','connected','target','action'].filter(key=>value[key]!=null).map(key=>[key,value[key]])):value;
    return {...base,type:'commandExecution',activity:'computer',command:action||'observe',output:typeof summary==='string'?summary.slice(0,12000):JSON.stringify(summary,null,2),exitCode:item.status==='failed'||item.result?.isError?1:undefined};
  }
  if (item.type === 'commandExecution') return { ...base, command: item.command ?? '', output: item.aggregatedOutput ?? item.output ?? '', exitCode: item.exitCode, activity:item.commandActions?.length&&item.commandActions.every(action=>action.type==='read')?'read':item.commandActions?.length&&item.commandActions.every(action=>['search','listFiles'].includes(action.type))?'search':undefined };
  if (item.type === 'fileChange') return { ...base, paths: (item.changes ?? []).map(change => path.isAbsolute(change.path) ? inside(root, change.path) ? path.relative(root, change.path) : null : change.path).filter(Boolean), text: (item.changes ?? []).map(change => change.diff ?? '').join('\n') };
  return { ...base, text: JSON.stringify(item, null, 2) };
}
export function historyItems(thread, root) {
  return (thread?.turns ?? []).flatMap(turn => (turn.items ?? []).map(item => {const result=normalizeItem(item,root);return result?{...result,...turnMetadata(turn)}:null;}).filter(Boolean));
}
export function updateItems(items, notification, root) {
  const { method, params = {} } = notification;
  if (method === 'item/started' || method === 'item/completed') {
    const normalized = normalizeItem(params.item, root);
    const item = normalized ? {...normalized,...(params.turnId?{turnId:params.turnId}:{})} : null;
    if (!item) return items;
    const index = items.findIndex(value => value.id === item.id);
    if (index === -1) return [...items, item];
    return items.map((value, i) => i === index ? { ...value, ...item } : value);
  }
  if(method==='turn/completed'&&params.turn?.status==='failed'&&params.turn.error){const id=`turn-error-${params.turn.id}`;if(items.some(item=>item.id===id))return items;return [...items,{id,type:'error',...turnMetadata(params.turn),text:params.turn.error.message??params.turn.error.errorInfo??'ENGINE_ERROR'}];}
  if (method === 'error') return [...items, { id: `error-${randomUUID()}`, type: 'error', text: params.error?.message ?? 'ENGINE_ERROR' }];
  const type = method === 'item/agentMessage/delta' ? 'agentMessage' : method.includes('reasoning') && method.endsWith('Delta') ? 'reasoning' : null;
  if (type || method === 'item/commandExecution/outputDelta') {
    const id = params.itemId;
    if (!id) return items;
    const key = type ? 'text' : 'output';
    const index = items.findIndex(value => value.id === id);
    if (index === -1) return [...items, { id, type: type ?? 'commandExecution', [key]: params.delta ?? '', running: true,...(params.turnId?{turnId:params.turnId}:{}) }];
    return items.map((value, i) => i === index ? { ...value, [key]: (value[key] ?? '') + (params.delta ?? '') } : value);
  }
  return items;
}
