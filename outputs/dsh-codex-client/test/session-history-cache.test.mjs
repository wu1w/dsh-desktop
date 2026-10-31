import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {SessionHistory} from '../server/session-history.mjs';
const flush=()=>new Promise(resolve=>queueMicrotask(resolve));
const entry=(id,text)=>({turnId:'turn-'+id,item:{id,type:'agentMessage',text}});
const engine={activeTurns:new Map(),readSession:async()=>({}),listSessionItems:async id=>({data:[entry(id,'body-'+id)],nextCursor:'earlier-'+id})};
const complete=(history,id,text='body')=>history.notification(id,{method:'item/completed',params:{turnId:'turn-'+id,item:{id:'item-'+id,type:'agentMessage',text}}},'/project');
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};

test('LRU evicts whole idle windows while native first and earlier pages remain complete',async()=>{
  const history=new SessionHistory({maxCachedSessions:2});
  const a=await history.initial({id:'a'},engine,'/project','en'),b=await history.initial({id:'b'},engine,'/project','en');
  await history.initial({id:'a'},engine,'/project','en');await history.initial({id:'c'},engine,'/project','en');
  assert.deepEqual([...history.windows.keys()],['a','c']);assert.deepEqual([...history.transcripts.keys()].sort(),['a','c']);
  assert.equal(a.items[0].text,'body-a');assert.equal(b.items[0].text,'body-b');assert.equal(b.history.hasMore,true);
  const older=await history.earlier({id:'b'},{...engine,listSessionItems:async()=>({data:[entry('b-old','earlier-body-b')],nextCursor:null})},'/project','earlier-b','en');assert.equal(older.items[0].text,'earlier-body-b');assert.equal(older.history.nextCursor,null);assert.equal(older.history.errorCode,null);
  const reopened=await history.initial({id:'b'},engine,'/project','en');assert.equal(reopened.items[0].text,'body-b');assert.equal(reopened.history.nextCursor,'earlier-b');assert.equal(history.windows.size,2);
});

test('a completed page larger than the cache budget is returned whole without retaining it',async()=>{
  const history=new SessionHistory({maxCachedBytes:2048}),text='完整正文'.repeat(2000);
  const native={...engine,listSessionItems:async(_id,{cursor})=>({data:[entry(cursor?'older':'large',text)],nextCursor:cursor?null:'more'})};
  const result=await history.initial({id:'large'},native,'/project','zh-CN');
  assert.equal(result.items[0].text,text);assert.equal(result.history.hasMore,true);assert.equal(result.history.nextCursor,'more');assert.equal(history.transcripts.has('large'),false);assert.equal(history.cacheInfo().overBudget,false);
  const older=await history.earlier({id:'large'},native,'/project','more','zh-CN');assert.equal(older.items[0].text,text);assert.equal(older.history.hasMore,false);assert.equal(older.history.error,null);
});

test('byte pressure evicts idle records and ignores delayed deltas until a new start',async()=>{
  const history=new SessionHistory({maxCachedBytes:4096});
  complete(history,'old','a'.repeat(1000));complete(history,'recent','b'.repeat(1000));await flush();
  assert.equal(history.transcripts.has('old'),false);assert.equal(history.transcripts.has('recent'),true);assert.ok(history.cacheInfo().estimatedBytes<=4096);
  history.notification('old',{method:'thread/queue/changed',params:{}},'/project');
  history.notification('old',{method:'item/agentMessage/delta',params:{itemId:'item-old',delta:'late partial'}},'/project');assert.equal(history.transcripts.has('old'),false);
  history.notification('old',{method:'turn/started',params:{turn:{id:'fresh'}}},'/project');
  history.notification('old',{method:'item/agentMessage/delta',params:{turnId:'fresh',itemId:'fresh-item',delta:'new full stream'}},'/project');
  assert.equal(history.transcripts.get('old')[0].text,'new full stream');
});

test('active streams may exceed the budget but idle windows are evicted and completion releases protection',async()=>{
  const history=new SessionHistory({maxCachedSessions:1,maxCachedBytes:2048});
  history.notification('live',{method:'turn/started',params:{turn:{id:'active'}}},'/project');
  history.notification('live',{method:'item/agentMessage/delta',params:{turnId:'active',itemId:'live-item',delta:'x'.repeat(5000)}},'/project');
  complete(history,'idle');await flush();assert.equal(history.transcripts.has('live'),true);assert.equal(history.transcripts.has('idle'),false);assert.equal(history.cacheInfo().overBudget,true);
  const ended=history.notification('live',{method:'turn/completed',params:{turn:{id:'active',status:'completed'}}},'/project');assert.equal(ended[0].text.length,5000);assert.equal(history.transcripts.has('live'),true);
  await flush();assert.equal(history.transcripts.has('live'),false);assert.equal(history.cacheInfo().overBudget,false);
});

test('in-flight page loads retain their merge state and later release it even on metadata failure',async()=>{
  const gate=deferred(),history=new SessionHistory({maxCachedSessions:1}),native={...engine,listSessionItems:()=>gate.promise};
  const pending=history.initial({id:'loading'},native,'/project','en');
  for(let n=0;n<10;n++)complete(history,'other-'+n);await flush();assert.equal(history.windows.has('loading'),true);
  history.notification('loading',{method:'item/agentMessage/delta',params:{itemId:'live',turnId:'active',delta:'current streamed text'}},'/project');
  gate.resolve({data:[entry('live','stale prefix')],nextCursor:'next'});const result=await pending;assert.equal(result.items[0].text,'current streamed text');assert.equal(history.windows.get('loading').loading,0);
  const failed=history.initial({id:'failed'}, {...engine,readSession:async()=>{throw Error('METADATA_FAIL');}},'/project','en');await assert.rejects(failed,/METADATA_FAIL/);assert.equal(history.windows.has('failed'),false);
});

test('authoritative engine activity releases a stale stream after engine exit',async()=>{
  const active=new Set(['live']),history=new SessionHistory({maxCachedBytes:1024,isActiveSession:id=>active.has(id)});
  history.notification('live',{method:'item/agentMessage/delta',params:{itemId:'live-item',delta:'x'.repeat(2000)}},'/project');await flush();assert.equal(history.transcripts.has('live'),true);
  active.clear();history.prune();assert.equal(history.transcripts.has('live'),false);assert.equal(history.cacheInfo().overBudget,false);
});

test('thousands of real completed sessions keep bounded cache and stable collected heap',{timeout:20000},()=>{
  const source=`import {SessionHistory} from ${JSON.stringify(new URL('../server/session-history.mjs',import.meta.url).href)};
    const history=new SessionHistory({});let sequence=0;
    function batch(count){for(let n=0;n<count;n++){const id='session-'+sequence++,text=Buffer.alloc(65536,33+n%80).toString('latin1');history.notification(id,{method:'item/completed',params:{turnId:id,item:{id,type:'agentMessage',text}}},'/project');}}
    batch(200);await Promise.resolve();global.gc();const baseline=process.memoryUsage().heapUsed;let maximum=baseline;
    for(let round=0;round<8;round++){batch(500);await Promise.resolve();global.gc();maximum=Math.max(maximum,process.memoryUsage().heapUsed);const info=history.cacheInfo();if(info.sessions>100||info.estimatedBytes>32*1024*1024)throw Error('CACHE_UNBOUNDED');}
    console.log(JSON.stringify({processed:sequence,baseline,maximum,growth:maximum-baseline,...history.cacheInfo(),transcripts:history.transcripts.size,tombstones:history.evicted.size}));`;
  const result=spawnSync(process.execPath,['--expose-gc','--max-old-space-size=128','--input-type=module','-e',source],{encoding:'utf8',timeout:18000});
  assert.equal(result.status,0,result.stderr);const report=JSON.parse(result.stdout.trim());assert.equal(report.processed,4200);assert.equal(report.sessions,100);assert.equal(report.transcripts,100);assert.ok(report.tombstones<=2000);assert.ok(report.growth<16*1024*1024,JSON.stringify(report));
});
