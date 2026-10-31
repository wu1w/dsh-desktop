const emptyHistory=()=>({nextCursor:null,hasMore:false,error:null,errorCode:null});
function historyMetadata(value={}){
  const nextCursor=typeof value.nextCursor==='string'&&value.nextCursor?value.nextCursor:null;
  return {nextCursor,hasMore:Boolean(value.hasMore&&nextCursor),error:typeof value.error==='string'&&value.error?value.error:null,errorCode:typeof value.errorCode==='string'?value.errorCode:null};
}
function uniqueItems(items){const seen=new Set();return (Array.isArray(items)?items:[]).filter(item=>{if(!item||typeof item.id!=='string'||!item.id||seen.has(item.id))return false;seen.add(item.id);return true;});}
const enumerableKeys=value=>Reflect.ownKeys(value).filter(key=>Object.prototype.propertyIsEnumerable.call(value,key));
function sameRecord(first,second){
  const keys=enumerableKeys(first);if(keys.length!==enumerableKeys(second).length)return false;
  return keys.every(key=>{
    if(!Object.prototype.propertyIsEnumerable.call(second,key))return false;
    const a=first[key],b=second[key];if(Object.is(a,b))return true;
    if(key!=='paths'||!Array.isArray(a)||!Array.isArray(b)||a.length!==b.length||enumerableKeys(a).length!==a.length||enumerableKeys(b).length!==b.length)return false;
    for(let index=0;index<a.length;index++)if(!Object.prototype.propertyIsEnumerable.call(a,index)||!Object.prototype.propertyIsEnumerable.call(b,index)||typeof a[index]!=='string'||typeof b[index]!=='string'||a[index]!==b[index])return false;
    return true;
  });
}
// Wire records contain JSON data. Own every nested object before freezing it;
// a different consumer may still hold and mutate the original event payload.
function ownedRecord(record){
  const copies=new Map(),pending=[];
  const copy=value=>{
    if(value===null||typeof value!=='object')return value;
    if(copies.has(value))return copies.get(value);
    const result=Array.isArray(value)?new Array(value.length):Object.create(Object.getPrototypeOf(value)===null?null:Object.prototype);
    copies.set(value,result);pending.push(value);return result;
  };
  const result=copy(record);
  for(let index=0;index<pending.length;index++){
    const source=pending[index],target=copies.get(source);
    for(const key of enumerableKeys(source))Object.defineProperty(target,key,{value:copy(source[key]),enumerable:true,writable:true,configurable:true});
    Object.freeze(target);
  }
  return result;
}

// Each operation carries a session epoch. History pages are immutable older
// observations; live updates own overlapping items even if an old request wins
// the network race. Ordering uses existing IDs as anchors instead of timestamps.
export class HistoryController {
  constructor(){this.sessionId=null;this.epoch=0;this.select(null,true);}
  select(sessionId,force=false){
    if(!force&&this.sessionId===sessionId)return false;
    this.sessionId=sessionId;this.epoch++;this.order=[];this.records=new Map();this.liveVersions=new Map();this.liveSequence=0;
    this.history=emptyHistory();this.errorSource=null;this.initialSequence=0;this.pageSequence=0;this.initialToken=null;this.pageToken=null;this.earlierPages=0;this.loadedInitial=false;this.running=false;this.reloadRequired=false;return true;
  }
  snapshot(){return {sessionId:this.sessionId,epoch:this.epoch,items:this.order.map(id=>this.records.get(id)),history:{...this.history},loadingInitial:Boolean(this.initialToken),loadingEarlier:Boolean(this.pageToken),errorSource:this.errorSource,running:this.running,reloadRequired:this.reloadRequired};}
  current(token){return Boolean(token&&token.sessionId===this.sessionId&&token.epoch===this.epoch);}
  beginInitial(){if(!this.sessionId)return null;return this.initialToken=Object.freeze({sessionId:this.sessionId,epoch:this.epoch,request:++this.initialSequence,liveSequence:this.liveSequence,hadInitial:this.loadedInitial&&!this.reloadRequired,rebuild:this.reloadRequired});}
  completeInitial(token,response={}){
    if(!this.current(token)||this.initialToken?.request!==token.request)return false;
    this.initialToken=null;
    if(token.rebuild&&!response.history?.error){
      // Replace the obsolete window while preserving messages streamed after
      // this reload began. Existing overlapping live content still wins below.
      const keep=new Set([...this.liveVersions].filter(([,version])=>version>token.liveSequence).map(([id])=>id));
      for(const item of uniqueItems(response.items))keep.add(item.id);
      this.order=this.order.filter(id=>keep.has(id));
      for(const id of [...this.records.keys()])if(!keep.has(id)){this.records.delete(id);this.liveVersions.delete(id);}
      this.earlierPages=0;this.reloadRequired=false;
    }
    this.merge(response.items,'initial',token);
    if(this.liveSequence===token.liveSequence)this.running=Boolean(response.running);
    if(this.earlierPages===0){this.history=historyMetadata(response.history);this.errorSource=this.history.error?'initial':null;}
    this.loadedInitial=true;return true;
  }
  failInitial(token,error){if(!this.current(token)||this.initialToken?.request!==token.request)return false;this.initialToken=null;this.history={...this.history,error:String(error),errorCode:null};this.errorSource='initial';return true;}
  cancelInitial(token,{error=null}={}){if(error!==null)return this.failInitial(token,error);if(!this.current(token)||this.initialToken?.request!==token.request)return false;this.initialToken=null;return true;}
  beginEarlier(){
    if(!this.sessionId||this.reloadRequired||this.pageToken||!this.history.hasMore||!this.history.nextCursor)return null;
    return this.pageToken=Object.freeze({sessionId:this.sessionId,epoch:this.epoch,request:++this.pageSequence,cursor:this.history.nextCursor});
  }
  completeEarlier(token,response={}){
    if(!this.current(token)||this.pageToken?.request!==token.request)return false;
    this.pageToken=null;
    const next=historyMetadata(response.history);
    if(next.errorCode==='HISTORY_CURSOR_STALE'){this.invalidateCursor(next);return true;}
    this.merge(response.items,'earlier');
    if(next.error){this.history={...next,nextCursor:token.cursor,hasMore:true};this.errorSource='earlier';}
    else{this.history=next;this.errorSource=null;this.earlierPages++;}
    return true;
  }
  failEarlier(token,error,errorCode=null){if(!this.current(token)||this.pageToken?.request!==token.request)return false;this.pageToken=null;if(errorCode==='HISTORY_CURSOR_STALE')this.invalidateCursor({error:String(error),errorCode});else{this.history={nextCursor:token.cursor,hasMore:true,error:String(error),errorCode};this.errorSource='earlier';}return true;}
  invalidateCursor(error){this.initialToken=null;this.initialSequence++;this.earlierPages=0;this.reloadRequired=true;this.history={nextCursor:null,hasMore:false,error:error.error,errorCode:'HISTORY_CURSOR_STALE'};this.errorSource='initial';}
  applyLive(items,{running}={}){
    if(!this.sessionId)return false;this.liveSequence++;
    this.merge(items,'live');if(typeof running==='boolean')this.running=running;return true;
  }
  retryTarget(){return this.errorSource==='earlier'&&this.history.nextCursor?'earlier':'initial';}
  merge(rawItems,source,token){
    const items=uniqueItems(rawItems),known=new Set(this.order);
    for(const item of items){
      const existing=this.records.get(item.id);
      const newerLive=source==='initial'&&(this.liveVersions.get(item.id)??0)>token.liveSequence;
      const merged=existing?(source==='earlier'||newerLive?{...item,...existing}:{...existing,...item}):{...item};
      if(!existing||!sameRecord(existing,merged))this.records.set(item.id,ownedRecord(merged));
      if(source==='live')this.liveVersions.set(item.id,this.liveSequence);
    }
    let previous=null,index=0;
    while(index<items.length){
      const id=items[index].id;
      if(known.has(id)){previous=id;index++;continue;}
      const block=[];
      while(index<items.length&&!known.has(items[index].id))block.push(items[index++].id);
      const next=index<items.length?items[index].id:null;
      let at=next?this.order.indexOf(next):previous?this.order.indexOf(previous)+1:(source==='earlier'||(source==='initial'&&!token.hadInitial))?0:this.order.length;
      this.order.splice(Math.max(0,at),0,...block);for(const added of block)known.add(added);previous=block.at(-1);
    }
  }
}
