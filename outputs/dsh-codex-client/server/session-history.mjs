import { historyItems, normalizeItem, updateItems, turnMetadata } from './normalize.mjs';

const codeOf = error => error.code ?? error.message;
const fault = code => Object.assign(new Error(code), { code });
const emptyHistory = () => ({ nextCursor: null, hasMore: false, error: null, errorCode: null });
const activeTurn = (engine, id) => {
  const turns = engine.activeTurns;
  return typeof turns?.has !== 'function' ? null : turns.has(id) ? turns.get?.(id) ?? true : false;
};

export class SessionHistory {
  constructor({ transcripts = new Map(), maxLiveItems = 200, maxCachedSessions = 100, maxCachedBytes = 32 * 1024 * 1024, isActiveSession, describeError = error => codeOf(error) }) {
    if(!Number.isSafeInteger(maxCachedSessions)||maxCachedSessions<1||!Number.isSafeInteger(maxCachedBytes)||maxCachedBytes<1)throw fault('INVALID_REQUEST');
    this.transcripts = transcripts;
    this.maxLiveItems = maxLiveItems;
    this.maxCachedSessions=maxCachedSessions;this.maxCachedBytes=maxCachedBytes;this.isActiveSession=isActiveSession;
    this.describeError = describeError;
    this.windows = new Map();
    this.itemBytes=new WeakMap();this.cacheBytes=0;this.pruneQueued=false;this.evicted=new Map();
    for(const id of transcripts.keys())this._window(id);
    this.prune();
  }
  _bytes(item){
    if(!item||typeof item!=='object')return 32;
    if(this.itemBytes.has(item))return this.itemBytes.get(item);
    // Normalized records are flat primitives plus path arrays. Counting string
    // code units is O(1), unlike reserializing an ever-growing token buffer.
    let bytes=128;
    for(const [key,value] of Object.entries(item)){
      bytes+=key.length*2+16;
      if(typeof value==='string')bytes+=value.length*2;
      else if(Array.isArray(value))bytes+=32+value.reduce((sum,entry)=>sum+(typeof entry==='string'?entry.length*2+16:32),0);
      else bytes+=16;
    }
    this.itemBytes.set(item,bytes);return bytes;
  }
  _size(items){return 256+items.reduce((bytes,item)=>bytes+this._bytes(item)+128,0);}
  _window(id) {
    let window=this.windows.get(id);
    if(!window){window={revision:0,loads:0,loading:0,activeTurn:null,changed:new Map(),phases:new Map(),turns:new Map(),bytes:this._size(this.transcripts.get(id)??[])};this.cacheBytes+=window.bytes;}
    else this.windows.delete(id);
    this.windows.set(id,window);return window;
  }
  _protected(id,window){
    if(window.loading)return true;
    if(this.isActiveSession){try{return Boolean(this.isActiveSession(id));}catch{return true;}}
    return window.activeTurn!==null||(this.transcripts.get(id)??[]).some(item=>item.running===true);
  }
  _store(id,items){
    const window=this._window(id);this.cacheBytes-=window.bytes;window.bytes=this._size(items);this.cacheBytes+=window.bytes;
    this.transcripts.set(id,items);this.evicted.delete(id);
    this.prune(id);
    // The host synchronously broadcasts the current complete event before its
    // now-idle cache can be evicted. HTTP results retain their own page array.
    if(!this.pruneQueued){this.pruneQueued=true;queueMicrotask(()=>{this.pruneQueued=false;this.prune();});}
  }
  prune(keepId){
    for(const id of this.transcripts.keys())if(!this.windows.has(id))this._window(id);
    for(const [id,window] of this.windows){
      if(this.windows.size<=this.maxCachedSessions&&this.cacheBytes<=this.maxCachedBytes)break;
      if(id===keepId||this._protected(id,window))continue;
      this.cacheBytes-=window.bytes;this.windows.delete(id);this.transcripts.delete(id);this.evicted.delete(id);this.evicted.set(id,true);
      while(this.evicted.size>Math.max(2000,this.maxCachedSessions*4))this.evicted.delete(this.evicted.keys().next().value);
    }
  }
  cacheInfo(){return{sessions:this.windows.size,estimatedBytes:this.cacheBytes,maxSessions:this.maxCachedSessions,maxBytes:this.maxCachedBytes,overBudget:this.windows.size>this.maxCachedSessions||this.cacheBytes>this.maxCachedBytes};}
  _activity(window,active){
    if(active===false)window.activeTurn=null;
    else if(active)window.activeTurn=active.turnId??true;
  }
  notification(id, notification, root) {
    const {method,params={}}=notification;
    const delta=method==='item/agentMessage/delta'||method==='item/commandExecution/outputDelta'||(method.includes('reasoning')&&method.endsWith('Delta'));
    // An idle session that was evicted cannot legitimately own a continuing
    // stream. Ignore delayed old deltas until a new start/snapshot is observed.
    if(this.evicted.has(id)&&!this.transcripts.has(id)&&(delta||!['turn/started','item/started','item/completed','error'].includes(method)))return [];
    const window = this._window(id), previous = this.transcripts.get(id) ?? [];
    if(['turn/started','turn/completed'].includes(method)&&params.turn?.id){const prior=window.turns.get(params.turn.id)??{},next=turnMetadata(params.turn);window.turns.set(params.turn.id,{...prior,...Object.fromEntries(Object.entries(next).filter(([,value])=>value!=null))});}
    if(method==='turn/started'){window.activeTurn=params.turn?.id??true;this.evicted.delete(id);}
    if(method==='item/started')this.evicted.delete(id);
    const eventId=params.item?.id??params.itemId;
    // Completed notifications carry the full authoritative item. Delayed or
    // replayed deltas must not append again after that terminal snapshot.
    if(delta&&window.phases.get(eventId)?.phase==='completed')return previous;
    let next = updateItems(previous, notification, root);
    if(eventId&&(method==='item/started'||method==='item/completed'||delta)) {
      const completed=method==='item/completed';
      window.phases.set(eventId,{phase:completed?'completed':'streaming',turnId:params.turnId??window.phases.get(eventId)?.turnId});
      // Agent message items do not have a native status field. Their enclosing
      // started/completed event, rather than normalizeItem's default, owns it.
      next=next.map(item=>item.id===eventId?{...item,running:!completed}:item);
    }
    if(method==='turn/completed') {
      const turnId=params.turn?.id??params.turnId;
      if(!turnId||window.activeTurn===turnId||window.activeTurn===true)window.activeTurn=null;
      for(const [itemId,state] of window.phases)if(turnId&&state.turnId===turnId) {
        window.phases.set(itemId,{...state,phase:'completed'});
        next=next.map(item=>item.id===itemId&&item.running?{...item,running:false}:item);
      }
    }
    next=next.map(item=>{const meta=window.turns.get(item.turnId);return meta&&Object.entries(meta).some(([key,value])=>item[key]!==value)?{...item,...meta}:item;}).slice(-this.maxLiveItems);
    const retainedTurns=new Set(next.map(item=>item.turnId));for(const id of window.turns.keys())if(!retainedTurns.has(id)&&id!==window.activeTurn)window.turns.delete(id);
    const previousById = new Map(previous.map(item => [item.id, item]));
    const revision = ++window.revision;
    for (const item of next) if (previousById.get(item.id) !== item) window.changed.set(item.id, revision);
    const retained = new Set(next.map(item => item.id));
    for (const itemId of window.changed.keys()) if (!retained.has(itemId)) window.changed.delete(itemId);
    for (const itemId of window.phases.keys()) if (!retained.has(itemId)) window.phases.delete(itemId);
    this._store(id, next);
    return next;
  }
  async _page(engine, id, cursor) {
    // Retry only reads. An item count limit cannot split one oversized item.
    for (const limit of [20, 5, 1]) {
      try {
        const page = await engine.listSessionItems(id, { cursor, limit, sortDirection: 'desc' });
        if (!Array.isArray(page?.data) || (page.nextCursor != null && (typeof page.nextCursor !== 'string' || !page.nextCursor || page.nextCursor === cursor))) throw fault('HISTORY_INVALID_PAGE');
        // Enrich only this bounded page. Older protocols expose timing on turns,
        // while native item timestamps describe individual operations.
        const provider=engine.nativeEngine??engine;
        if(typeof provider.listSessionTurns==='function'&&page.data.some(entry=>entry.turnStartedAtMs==null)){
          try{const turns=await engine.listSessionTurns(id,{limit:50,sortDirection:'desc',itemsView:'notLoaded'});const timing=new Map((turns.data??[]).map(turn=>[turn.id,turnMetadata(turn)]));return {...page,data:page.data.map(entry=>({...entry,...(timing.get(entry.turnId)??{})}))};}catch{/* Keep available history if optional timing is unavailable. */}
        }
        return page;
      } catch (error) { if (codeOf(error) !== 'LINE_TOO_LONG' || limit === 1) throw error; }
    }
  }
  _entries(page, root) {
    return page.data.slice().reverse().map(entry => {
      const item = normalizeItem(entry.item, root);
      return item ? { ...item, turnId: entry.turnId, startedAtMs: entry.startedAtMs, completedAtMs: entry.completedAtMs, ...(entry.turnStartedAtMs!=null?{turnStartedAtMs:entry.turnStartedAtMs}:{}), ...(entry.turnCompletedAtMs!=null?{turnCompletedAtMs:entry.turnCompletedAtMs}:{}), ...(entry.turnStatus?{turnStatus:entry.turnStatus}:{}) } : null;
    }).filter(Boolean);
  }
  _mergeLive(id, items, since, { includeNew = false, active = null } = {}) {
    const window = this._window(id), live = this.transcripts.get(id) ?? [];
    const byId = new Map(live.map(item => [item.id, item]));
    const ids = new Set(items.map(item => item.id));
    const streaming = item => {
      const state = window.phases.get(item.id);
      return active !== false && (!active?.turnId || !state?.turnId || active.turnId === state.turnId)
        && (state?.phase === 'streaming' || (state == null && item.running === true));
    };
    const result = items.map(item => {
      const current = byId.get(item.id);
      // A page may contain only the persisted prefix of an active message, or
      // text whose corresponding delta has not reached us yet. In either case
      // the live delta buffer stays authoritative until completion. Once an
      // item completed before this request (or the engine has no active turn),
      // a subsequent snapshot may legitimately update its historical text.
      return current && ((window.changed.get(item.id) ?? 0) > since || streaming(current)) ? { ...item, ...current } : item;
    });
    // An active item may not have reached persisted history at all yet. Other
    // cached items are appended only when received after this request began.
    if (includeNew) for (const item of live) if (!ids.has(item.id) && ((window.changed.get(item.id) ?? 0) > since || streaming(item))) result.push(item);
    return result;
  }
  async initial(session, engine, root, locale) {
    const id = session.id, window = this._window(id), token = ++window.loads, since = window.revision;
    window.loading++;
    try {
    if (typeof engine.listSessionItems !== 'function') {
      const response = await engine.readSession(id, { includeTurns: true });
      const active = activeTurn(engine, id);
      this._activity(window,active);
      const items = this._mergeLive(id, historyItems(response.thread, root), since, { includeNew: true, active });
      if (token === window.loads) this._store(id, items.slice(-this.maxLiveItems));
      return { items, history: emptyHistory() };
    }
    await engine.readSession(id, { includeTurns: false });
    try {
      const page = await this._page(engine, id, null);
      const active = activeTurn(engine, id);
      this._activity(window,active);
      const items = this._mergeLive(id, this._entries(page, root), since, { includeNew: true, active });
      if (token === window.loads) this._store(id, items.slice(-this.maxLiveItems));
      return { items, history: { ...emptyHistory(), nextCursor: page.nextCursor ?? null, hasMore: Boolean(page.nextCursor) } };
    } catch (error) {
      return { items: (this.transcripts.get(id) ?? []).slice(-20), history: { ...emptyHistory(), error: this.describeError(error, locale), errorCode: codeOf(error) } };
    }
    }finally{window.loading--;this.prune();}
  }
  async earlier(session, engine, root, cursor, locale) {
    if (typeof cursor !== 'string' || !cursor || cursor.length > 8192) throw fault('INVALID_REQUEST');
    if (typeof engine.listSessionItems !== 'function') throw fault('HISTORY_UNSUPPORTED');
    const window=this._window(session.id),since=window.revision;window.loading++;
    try {
      const page = await this._page(engine, session.id, cursor);
      const active = activeTurn(engine, session.id);
      this._activity(window,active);
      return { items: this._mergeLive(session.id, this._entries(page, root), since, {active}), history: { ...emptyHistory(), nextCursor: page.nextCursor ?? null, hasMore: Boolean(page.nextCursor) } };
    } catch (error) {
      return { items: [], history: { nextCursor: cursor, hasMore: true, error: this.describeError(error, locale), errorCode: codeOf(error) } };
    }finally{window.loading--;this.prune();}
  }
}
