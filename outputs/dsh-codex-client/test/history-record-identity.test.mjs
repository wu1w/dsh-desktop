import test from 'node:test';
import assert from 'node:assert/strict';
import {HistoryController} from '../src/lib/history-controller.js';
const item=(id,text=id,extra={})=>({id,type:'agentMessage',text,...extra});
function start(items){const controller=new HistoryController();controller.select('owned');controller.completeInitial(controller.beginInitial(),{items,running:false,history:{nextCursor:'older',hasMore:true}});return controller;}

test('unchanged records retain identity while changed text receives a new immutable owned record',()=>{
  const stable=item('stable'),active=item('active','a'),controller=start([stable,active]),before=controller.snapshot();controller.applyLive([item('stable'),item('active','ab')],{running:true});const after=controller.snapshot();assert.equal(after.items[0],before.items[0]);assert.notEqual(after.items[1],before.items[1]);assert.equal(after.items[1].text,'ab');assert.equal(after.running,true);assert.notEqual(after.items,before.items);assert.notEqual(controller.snapshot().items,after.items);assert.equal(Object.isFrozen(after.items[0]),true);assert.equal(Object.isFrozen(stable),false);
});
test('every enumerable primitive field participates in equality without JSON serialization coercion',()=>{
  const symbol=Symbol('future'),controller=start([item('row','body',{unknown:1,optional:undefined,metric:NaN,zero:-0,[symbol]:'a'})]);let previous=controller.snapshot().items[0];
  controller.applyLive([item('row','body',{unknown:1,optional:undefined,metric:NaN,zero:-0,[symbol]:'a'})]);assert.equal(controller.snapshot().items[0],previous);
  for(const patch of [{unknown:2},{optional:null},{metric:0},{zero:0},{newField:undefined},{[symbol]:'b'}]){controller.applyLive([{...controller.snapshot().items[0],...patch}]);const current=controller.snapshot().items[0];assert.notEqual(current,previous);previous=current;for(const key of Reflect.ownKeys(patch))assert.ok(Object.is(current[key],patch[key]));}
});
test('dense string paths compare by value while caller arrays remain mutable and cannot change an owned view',()=>{
  const paths=['a.txt','中文\\b.txt'],raw=item('files','change',{paths}),controller=start([raw]),original=controller.snapshot().items[0];assert.notEqual(original.paths,paths);assert.equal(Object.isFrozen(original.paths),true);assert.equal(Object.isFrozen(paths),false);
  controller.applyLive([item('files','change',{paths:[...paths]})]);assert.equal(controller.snapshot().items[0],original);paths[0]='external-change';assert.equal(original.paths[0],'a.txt');controller.applyLive([raw]);assert.notEqual(controller.snapshot().items[0],original);assert.equal(controller.snapshot().items[0].paths[0],'external-change');assert.throws(()=>{original.paths.push('x');},TypeError);
});
test('unknown nested JSON data remains complete and conservatively changed, detached and frozen without touching the caller',()=>{
  const nested={future:{list:[{value:1},null,'text']},optional:undefined},raw=item('row','body',{nested}),controller=start([raw]),first=controller.snapshot().items[0];assert.deepEqual(first.nested,nested);assert.notEqual(first.nested,nested);assert.notEqual(first.nested.future.list,nested.future.list);assert.equal(Object.isFrozen(first.nested.future.list[0]),true);assert.equal(Object.isFrozen(nested.future.list[0]),false);
  controller.applyLive([raw]);const second=controller.snapshot().items[0];assert.notEqual(second,first);nested.future.list[0].value=2;assert.equal(second.nested.future.list[0].value,1);controller.applyLive([raw]);assert.equal(controller.snapshot().items[0].nested.future.list[0].value,2);assert.equal(first.nested.future.list[0].value,1);
});
test('cycles and shared references are copied without recursion or freezing any original object',()=>{
  const nested={name:'complete'};nested.self=nested;const raw=item('row','body',{a:nested,b:nested}),controller=start([raw]),view=controller.snapshot().items[0];assert.notEqual(view.a,nested);assert.equal(view.a,view.b);assert.equal(view.a.self,view.a);assert.equal(Object.isFrozen(view.a),true);assert.equal(Object.isFrozen(nested),false);nested.name='caller remains writable';assert.equal(view.a.name,'complete');
});
test('deep unknown JSON data copies iteratively without truncation',()=>{
  const nested={};let cursor=nested;for(let index=0;index<15000;index++){cursor.next={index};cursor=cursor.next;}cursor.end='retained';const controller=start([item('row','body',{nested})]);cursor=controller.snapshot().items[0].nested;for(let index=0;index<15000;index++){assert.equal(Object.isFrozen(cursor),true);cursor=cursor.next;assert.equal(cursor.index,index);}assert.equal(cursor.end,'retained');assert.equal(Object.isFrozen(cursor),true);
});
test('own __proto__ keys, null prototypes and unknown array fields survive without prototype pollution',()=>{
  const nested=JSON.parse('{"__proto__":{"retained":"yes"},"constructor":"data"}'),list=['a'];Object.defineProperty(list,'__proto__',{value:{retained:'array-data'},enumerable:true});const raw=item('row','body',{nested,list}),nullObject=Object.create(null);nullObject.future='kept';raw.nullObject=nullObject;Object.defineProperty(raw,'__proto__',{value:{retained:'top'},enumerable:true});const view=start([raw]).snapshot().items[0];assert.equal(Object.getPrototypeOf(view),Object.prototype);assert.equal(Object.hasOwn(view,'__proto__'),true);assert.equal(view.__proto__.retained,'top');assert.equal(Object.hasOwn(view.nested,'__proto__'),true);assert.equal(view.nested.__proto__.retained,'yes');assert.equal(view.list.__proto__.retained,'array-data');assert.equal(Object.getPrototypeOf(view.nullObject),null);assert.equal(view.nullObject.future,'kept');assert.equal(Object.prototype.retained,undefined);assert.equal(Object.isFrozen(nested),false);
});
test('unchanged live observations still advance authority and prevent a stale initial response from replacing them',()=>{
  const controller=start([item('row','live text',{paths:['a']})]),before=controller.snapshot(),token=controller.beginInitial(),sequence=controller.liveSequence;controller.applyLive([item('row','live text',{paths:['a']})],{running:true});assert.equal(controller.snapshot().items[0],before.items[0]);assert.equal(controller.liveSequence,sequence+1);assert.equal(controller.liveVersions.get('row'),sequence+1);
  controller.completeInitial(token,{items:[item('row','stale')],running:false,history:{nextCursor:'newer-cursor',hasMore:true}});assert.equal(controller.snapshot().items[0],before.items[0]);assert.equal(controller.snapshot().items[0].text,'live text');assert.equal(controller.snapshot().running,true);
});
test('earlier-page priority preserves existing values but retains new unknown fields and stable order',()=>{
  const controller=start([item('recent','new text',{paths:['new']})]),token=controller.beginEarlier();controller.completeEarlier(token,{items:[item('old'),item('recent','old text',{paths:['old'],future:{kept:true}})],history:{nextCursor:null,hasMore:false}});assert.deepEqual(controller.snapshot().items.map(row=>row.id),['old','recent']);const current=controller.snapshot().items[1];assert.equal(current.text,'new text');assert.deepEqual(current.paths,['new']);assert.deepEqual(current.future,{kept:true});assert.equal(Object.isFrozen(current.future),true);
});

test('paths with additional enumerable keys or symbols never enter the pure string-array equality shortcut',()=>{
  const symbol=Symbol('path metadata');for(const key of ['future',symbol]){
    const paths=['a.txt'];paths[key]={value:'original'};const controller=start([item('row','body',{paths})]),before=controller.snapshot().items[0],next=['a.txt'];next[key]={value:'changed'};
    controller.applyLive([item('row','body',{paths:next})]);const after=controller.snapshot().items[0];assert.notEqual(after,before);assert.deepEqual(before.paths[key],{value:'original'});assert.deepEqual(after.paths[key],{value:'changed'});assert.notEqual(after.paths[key],next[key]);assert.equal(Object.isFrozen(after.paths[key]),true);assert.equal(Object.isFrozen(next[key]),false);
  }
});
