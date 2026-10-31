import test from 'node:test';
import assert from 'node:assert/strict';
import {HistoryController} from '../src/lib/history-controller.js';
import {captureHistoryAnchor,restoreHistoryAnchor} from '../src/lib/history-scroll.js';

const item=(id,text=id,extra={})=>({id,type:'agentMessage',text,...extra});
const page=(items,nextCursor=null,extra={})=>({items,history:{nextCursor,hasMore:Boolean(nextCursor),error:null,...extra}});
const ids=controller=>controller.snapshot().items.map(row=>row.id);
function start(items,cursor='older-1'){const controller=new HistoryController();controller.select('chat-a');controller.completeInitial(controller.beginInitial(),page(items,cursor));return controller;}
function deferred(){let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};}

test('the initial window retains its pagination cursor when live text arrives during loading',async()=>{
  const controller=new HistoryController();controller.select('chat-a');const token=controller.beginInitial(),response=deferred();
  const loading=response.promise.then(value=>controller.completeInitial(token,value));
  controller.applyLive([item('b','new streamed content')],{running:true});
  response.resolve({...page([item('a'),item('b','old snapshot')],'opaque+/cursor'),running:false});
  assert.equal(await loading,true);
  assert.deepEqual(ids(controller),['a','b']);
  assert.equal(controller.snapshot().items[1].text,'new streamed content');
  assert.equal(controller.snapshot().running,true);
  assert.equal(controller.snapshot().history.nextCursor,'opaque+/cursor');
  assert.equal(controller.snapshot().loadingInitial,false);
});

test('a newer initial request supersedes an older request without discarding live state',()=>{
  const controller=new HistoryController();controller.select('chat-a');const old=controller.beginInitial(),latest=controller.beginInitial();
  controller.applyLive([item('b','live')]);
  assert.equal(controller.completeInitial(old,page([item('old')],'old-cursor')),false);
  assert.equal(controller.completeInitial(latest,page([item('a'),item('b','snapshot')],'cursor')),true);
  assert.deepEqual(ids(controller),['a','b']);assert.equal(controller.snapshot().items[1].text,'live');
});

test('earlier pages prepend, deduplicate by item ID without turnId, and cannot replace live text',async()=>{
  const controller=start([item('c'),item('d','before')]);const token=controller.beginEarlier(),response=deferred();
  const loading=response.promise.then(value=>controller.completeEarlier(token,value));
  controller.applyLive([item('d','during page load'),item('e','brand new')],{running:true});
  response.resolve(page([item('a'),item('b'),item('c','stale overlap'),item('d','even older')],'older-2'));
  assert.equal(await loading,true);assert.deepEqual(ids(controller),['a','b','c','d','e']);
  assert.equal(controller.snapshot().items.find(row=>row.id==='d').text,'during page load');
  assert.equal(controller.snapshot().items.find(row=>row.id==='c').text,'c');
  assert.equal(controller.snapshot().history.nextCursor,'older-2');
  assert.equal(controller.beginEarlier().cursor,'older-2');
});

test('live windows upsert existing IDs and preserve already loaded earlier pages',()=>{
  const controller=start([item('c'),item('d')]);controller.completeEarlier(controller.beginEarlier(),page([item('a'),item('b')],null));
  controller.applyLive([item('d','completed',{running:false}),item('e','next')],{running:false});
  assert.deepEqual(ids(controller),['a','b','c','d','e']);
  assert.equal(controller.snapshot().items[3].text,'completed');
  assert.equal(controller.snapshot().history.hasMore,false);
});

test('a refresh of the latest window does not reset the oldest loaded cursor',()=>{
  const controller=start([item('d'),item('e')]);const refresh=controller.beginInitial();
  controller.completeEarlier(controller.beginEarlier(),page([item('b'),item('c')],'oldest-cursor'));
  controller.completeInitial(refresh,page([item('e'),item('f')],'latest-window-cursor'));
  assert.deepEqual(ids(controller),['b','c','d','e','f']);
  assert.equal(controller.snapshot().history.nextCursor,'oldest-cursor');
});

test('only one earlier request may run and a page failure retries exactly the requested cursor',()=>{
  const controller=start([item('c')],'exact opaque cursor');const token=controller.beginEarlier();
  assert.equal(controller.beginEarlier(),null);
  assert.equal(controller.failEarlier(token,'Temporary failure'),true);
  assert.equal(controller.snapshot().loadingEarlier,false);
  assert.equal(controller.snapshot().history.error,'Temporary failure');
  assert.equal(controller.retryTarget(),'earlier');
  assert.equal(controller.beginEarlier().cursor,'exact opaque cursor');
});

test('a partial earlier error retains the request cursor even when the response has none',()=>{
  const controller=start([item('c')],'retry-me');controller.completeEarlier(controller.beginEarlier(),page([item('b')],null,{error:'Localized failure',errorCode:'READ_FAILED'}));
  assert.deepEqual(ids(controller),['b','c']);assert.equal(controller.snapshot().history.nextCursor,'retry-me');
  assert.equal(controller.snapshot().history.errorCode,'READ_FAILED');
  const retry=controller.beginEarlier();controller.completeEarlier(retry,page([item('a'),item('b')],null));
  assert.deepEqual(ids(controller),['a','b','c']);assert.equal(controller.snapshot().history.error,null);assert.equal(controller.snapshot().history.hasMore,false);
});

test('an initial error without a cursor is still visible and retries the initial endpoint',()=>{
  const controller=new HistoryController();controller.select('chat-a');
  controller.completeInitial(controller.beginInitial(),page([item('cached')],null,{error:'Could not read older messages'}));
  assert.equal(controller.snapshot().history.hasMore,false);
  assert.equal(controller.snapshot().history.error,'Could not read older messages');
  assert.equal(controller.retryTarget(),'initial');
  assert.equal(controller.beginEarlier(),null);
  const retry=controller.beginInitial();controller.completeInitial(retry,page([item('cached'),item('new')],'recovered'));
  assert.deepEqual(ids(controller),['cached','new']);assert.equal(controller.snapshot().history.error,null);
});

test('switching chats rejects old initial and earlier requests, including switch-away-and-back',()=>{
  const controller=start([item('a')]);const oldPage=controller.beginEarlier(),oldInitial=controller.beginInitial();
  controller.select('chat-b');controller.completeInitial(controller.beginInitial(),page([item('b')]));
  assert.equal(controller.completeEarlier(oldPage,page([item('wrong-chat')])),false);
  assert.equal(controller.completeInitial(oldInitial,page([item('also-wrong')])),false);
  assert.deepEqual(ids(controller),['b']);
  controller.select('chat-a');assert.equal(controller.completeEarlier(oldPage,page([item('stale-a')])),false);assert.deepEqual(ids(controller),[]);
});

test('anchored insertion places page items between known live records rather than moving existing rows',()=>{
  const controller=start([item('a'),item('d')]);controller.applyLive([item('d'),item('f')]);
  controller.completeEarlier(controller.beginEarlier(),page([item('a'),item('b'),item('c'),item('d'),item('e'),item('f')]));
  assert.deepEqual(ids(controller),['a','b','c','d','e','f']);
});

test('duplicate IDs in the same page are displayed once and turnId is metadata, not identity',()=>{
  const controller=start([item('a','live',{turnId:'turn-a'})]);
  controller.completeEarlier(controller.beginEarlier(),page([item('old'),item('old','duplicate'),item('a','older',{turnId:'other-turn'})]));
  assert.deepEqual(ids(controller),['old','a']);assert.equal(controller.snapshot().items[1].turnId,'turn-a');
});

function scrollContainer(rows,scrollTop){
  const container={rows,scrollTop,top:100,get scrollHeight(){return this.rows.reduce((sum,row)=>sum+row.height,0);},getBoundingClientRect(){return {top:this.top};},querySelectorAll(){let offset=0;return this.rows.map(row=>{const start=offset;offset+=row.height;return {dataset:{historyId:row.id},getBoundingClientRect:()=>({top:container.top+start-container.scrollTop,bottom:container.top+start+row.height-container.scrollTop})};});}};
  return container;
}

test('prepending history preserves a partly visible row while simultaneous live additions stay below it',()=>{
  const container=scrollContainer([{id:'a',height:100},{id:'b',height:80},{id:'c',height:100}],150),anchor=captureHistoryAnchor(container);
  assert.equal(anchor.itemId,'b');assert.equal(anchor.offset,-50);
  container.rows=[{id:'older',height:200},...container.rows,{id:'live-new',height:300}];
  restoreHistoryAnchor(container,anchor);
  assert.equal(container.scrollTop,350);
  const after=captureHistoryAnchor(container);assert.equal(after.itemId,'b');assert.equal(after.offset,-50);
});

test('the anchor is captured at commit time so user scrolling during the request is respected',()=>{
  const container=scrollContainer([{id:'a',height:100},{id:'b',height:100},{id:'c',height:100}],0);
  container.scrollTop=170;const latestAnchor=captureHistoryAnchor(container);
  container.rows=[{id:'older',height:150},...container.rows];restoreHistoryAnchor(container,latestAnchor);
  assert.equal(container.scrollTop,320);assert.equal(captureHistoryAnchor(container).offset,latestAnchor.offset);
});

test('scroll-height fallback handles a missing row without a negative scroll position',()=>{
  const container=scrollContainer([{id:'a',height:100}],20),anchor=captureHistoryAnchor(container);
  container.rows=[{id:'replacement',height:250}];restoreHistoryAnchor(container,anchor);assert.equal(container.scrollTop,170);
});

test('a stale cursor is discarded immediately and retry rebuilds the latest window instead of resending it',()=>{
  const controller=start([item('recent')],'stale-cursor');
  controller.completeEarlier(controller.beginEarlier(),page([item('older')],'stale-page-2'));
  const stale=controller.beginEarlier();controller.completeEarlier(stale,page([],null,{error:'History changed',errorCode:'HISTORY_CURSOR_STALE'}));
  assert.equal(controller.snapshot().reloadRequired,true);assert.equal(controller.snapshot().history.nextCursor,null);assert.equal(controller.snapshot().history.hasMore,false);
  assert.equal(controller.beginEarlier(),null);assert.equal(controller.retryTarget(),'initial');
  const reload=controller.beginInitial();assert.equal(reload.rebuild,true);controller.completeInitial(reload,page([item('new-window')],'rebuilt-cursor'));
  assert.deepEqual(ids(controller),['new-window']);assert.equal(controller.snapshot().reloadRequired,false);
  assert.equal(controller.beginEarlier().cursor,'rebuilt-cursor');
});

test('live updates during cursor recovery survive replacement and keep their newer overlapping text',()=>{
  const controller=start([item('oldest'),item('recent','before')]);
  controller.completeEarlier(controller.beginEarlier(),page([],null,{error:'Changed',errorCode:'HISTORY_CURSOR_STALE'}));
  const reload=controller.beginInitial();
  controller.applyLive([item('recent','new streamed text'),item('brand-new','arrived during reload')],{running:true});
  controller.completeInitial(reload,{...page([item('recent','old persisted snapshot')],'fresh-cursor'),running:false});
  assert.deepEqual(ids(controller),['recent','brand-new']);assert.equal(controller.snapshot().items[0].text,'new streamed text');assert.equal(controller.snapshot().running,true);
});

test('a stale page invalidates a concurrent older initial refresh so it cannot restore the obsolete cursor',()=>{
  const controller=start([item('a')],'stale');const refresh=controller.beginInitial(),earlier=controller.beginEarlier();
  controller.failEarlier(earlier,'Changed','HISTORY_CURSOR_STALE');
  assert.equal(controller.completeInitial(refresh,page([item('old-response')],'obsolete')),false);
  assert.equal(controller.snapshot().history.nextCursor,null);assert.equal(controller.snapshot().reloadRequired,true);
});

test('failed window recovery remains retryable without returning to the stale cursor',()=>{
  const controller=start([item('visible')],'stale');controller.failEarlier(controller.beginEarlier(),'Changed','HISTORY_CURSOR_STALE');
  const first=controller.beginInitial();controller.failInitial(first,'Network failed');
  assert.deepEqual(ids(controller),['visible']);assert.equal(controller.beginEarlier(),null);assert.equal(controller.retryTarget(),'initial');
  const retry=controller.beginInitial();assert.equal(retry.rebuild,true);controller.completeInitial(retry,page([item('fresh')],'good'));
  assert.deepEqual(ids(controller),['fresh']);assert.equal(controller.snapshot().history.nextCursor,'good');
});

test('switching chats during a stale-window rebuild rejects its result and preserves the new chat',()=>{
  const controller=start([item('a')]);controller.failEarlier(controller.beginEarlier(),'Changed','HISTORY_CURSOR_STALE');const reload=controller.beginInitial();
  controller.select('chat-b');controller.completeInitial(controller.beginInitial(),page([item('b')],'b-cursor'));
  assert.equal(controller.completeInitial(reload,page([item('a-late')],'a-cursor')),false);assert.deepEqual(ids(controller),['b']);assert.equal(controller.snapshot().history.nextCursor,'b-cursor');
});

test('a rebuilt window keeps a surviving scroll anchor and starts at the top if that old row no longer exists',()=>{
  const container=scrollContainer([{id:'old',height:200},{id:'recent',height:200}],230),anchor=captureHistoryAnchor(container);
  container.rows=[{id:'newest-prefix',height:90},{id:'recent',height:200}];restoreHistoryAnchor(container,anchor,{missing:'start'});
  assert.equal(captureHistoryAnchor(container).itemId,'recent');assert.equal(captureHistoryAnchor(container).offset,anchor.offset);
  container.rows=[{id:'replacement',height:400}];restoreHistoryAnchor(container,anchor,{missing:'start'});assert.equal(container.scrollTop,0);
});
