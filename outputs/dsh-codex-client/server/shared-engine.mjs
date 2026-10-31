import {turnMetadata} from './normalize.mjs';
const fault=code=>Object.assign(new Error(code),{code});
const scoped=new Set(['resumeSession','startTurn','steer','queueRequest','startQueued','moveSession','setModel','interrupt','readTurnState','listSessionTurns','archiveSession','restoreSession','renameSession']);
const decode=value=>{try{return JSON.parse(Buffer.from(value.slice(5),'base64url').toString());}catch{throw fault('INVALID_HISTORY_PAGE');}};
const encode=value=>'dsh1:'+Buffer.from(JSON.stringify(value)).toString('base64url');
// The UI identity belongs to DSH; each engine generation has its own native ID.
export function sharedEngine(native,{state,store,canMutate=()=>true}){
  const row=id=>state.sessions.find(s=>s.id===id);
  const mapped=id=>row(id)?.engineSessionId??id;
  const remap=value=>value&&typeof value==='object'&&value.sessionId?{...value,sessionId:state.sessions.find(s=>s.engineSessionId===value.sessionId)?.id??value.sessionId}:value;
  async function nativePage(id,{cursor,limit}){
    if(native.listSessionItems)return native.listSessionItems(mapped(id),{cursor,limit:Math.min(limit,50),sortDirection:'desc'});
    const response=await native.readSession(mapped(id),{includeTurns:true});
    const entries=(response.thread?.turns??[]).flatMap(turn=>(turn.items??[]).map(item=>({item,...turnMetadata(turn)}))).reverse();
    const index=cursor?entries.findIndex(entry=>entry.item.id===cursor):-1;if(cursor&&index<0)throw fault('HISTORY_CURSOR_STALE');const start=index+1;
    return{data:entries.slice(start,start+limit),nextCursor:start+limit<entries.length?entries[start+limit-1].item.id:null};
  }
  async function listSessionItems(id,{cursor=null,limit=20,sortDirection='desc'}={}){
    if(!Number.isSafeInteger(limit)||limit<1||limit>100||sortDirection!=='desc')throw fault('INVALID_HISTORY_PAGE');
    const ref=row(id)?.contextRef??null;
    let position={ref,phase:'native',cursor:null,offset:0};
    if(cursor?.startsWith('dsh1:')){position=decode(cursor);if(position.ref!==ref)throw fault('HISTORY_CURSOR_STALE');}
    else if(cursor)position.cursor=cursor;
    let data=[];
    if(position.phase==='native'){
      const page=await nativePage(id,{cursor:position.cursor,limit});data=page.data;
      if(page.nextCursor)return {data,nextCursor:encode({...position,cursor:page.nextCursor})};
      position={ref,phase:'shared',offset:0};
    }
    if(!ref)return{data,nextCursor:null};
    if(position.phase!=='shared'||!Number.isSafeInteger(position.offset)||position.offset<0)throw fault('INVALID_HISTORY_PAGE');
    const shared=await store.read(ref),entries=shared.entries,remaining=limit-data.length;
    const end=Math.max(0,entries.length-position.offset),start=Math.max(0,end-remaining);
    data.push(...entries.slice(start,end).reverse());position.offset+=end-start;
    return{data,nextCursor:start>0?encode(position):null};
  }
  return new Proxy(native,{get(target,key){
    if(key==='nativeEngine')return native;
    if(key==='activeTurns')return new Map([...native.activeTurns].map(([id,turn])=>[state.sessions.find(s=>s.engineSessionId===id)?.id??id,turn]));
    if(key==='listSessionItems')return listSessionItems;
    if(key==='readTurnState')return async(id,turnId)=>{if(turnId&&row(id)?.contextRef){const shared=await store.read(row(id).contextRef);if(shared.turnState?.turnId===turnId&&shared.turnState.terminal)return{...shared.turnState,sessionId:id,threadId:row(id).threadId,active:false};}return remap(await native.readTurnState(mapped(id),turnId));};
    if(key==='readSession')return async(id,options)=>remap(await native.readSession(mapped(id),options));
    if(key==='createSession')return async(id,options={})=>{if(!canMutate())throw fault('ENGINE_SWITCHING');return native.createSession(id,options);};
    if(key==='forkSession')return async(id,newId)=>{if(!canMutate())throw fault('ENGINE_SWITCHING');return remap(await native.forkSession(mapped(id),newId));};
    if(scoped.has(key))return async(id,...args)=>{if(!['readTurnState','listSessionTurns'].includes(key)&&!(key==='queueRequest'&&args[0]==='list')&&!canMutate())throw fault('ENGINE_SWITCHING');return remap(await native[key](mapped(id),...args));};
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});
}
