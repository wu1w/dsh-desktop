import test from 'node:test';
import assert from 'node:assert/strict';
import {updateItems} from '../server/normalize.mjs';
import {HistoryController} from '../src/lib/history-controller.js';

test('multiple distinct native errors in one millisecond retain distinct stable item identities and remain visible',t=>{
  t.mock.method(Date,'now',()=>12345);let items=[];
  for(const message of ['first native error','second native error','same text','same text'])items=updateItems(items,{method:'error',params:{error:{message}}},'/owned/project');
  assert.equal(new Set(items.map(item=>item.id)).size,4);for(const item of items)assert.match(item.id,/^error-[a-f0-9-]{36}$/);
  const controller=new HistoryController();controller.select('owned');controller.applyLive(items);assert.deepEqual(controller.snapshot().items.map(item=>item.text),['first native error','second native error','same text','same text']);
  const ids=controller.snapshot().items.map(item=>item.id);controller.applyLive(items);assert.deepEqual(controller.snapshot().items.map(item=>item.id),ids);
});
test('turn failure identity still deduplicates the same native terminal notification',()=>{
  const notification={method:'turn/completed',params:{turn:{id:'owned-turn',status:'failed',error:{message:'failed'}}}};
  const once=updateItems([],notification,'/owned/project'),twice=updateItems(once,notification,'/owned/project');assert.equal(twice.length,1);assert.equal(twice[0].id,'turn-error-owned-turn');
});
