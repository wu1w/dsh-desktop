import test from 'node:test';
import assert from 'node:assert/strict';
import {AutomationsController,automationDraft,automationPayload} from '../src/lib/automations-controller.js';
const deferred=()=>{let resolve;const promise=new Promise(a=>{resolve=a;});return{promise,resolve};};
test('new automation drafts are constrained to explicit local scheduling without enabling execution',()=>{
  const draft=automationDraft(null,{projects:[{id:'p'}],selectedEngine:'codex'});draft.title='Task';draft.prompt='Inspect files';const payload=automationPayload(draft);assert.equal(payload.permission,'read-only');assert.deepEqual(payload.schedule,{type:'interval',minutes:60});assert.equal('enabled'in payload,false);assert.equal('id'in payload,false);
  for(const invalid of [{minutes:'14'},{minutes:'15.1'},{prompt:'中'.repeat(5400)},{permission:'danger-full-access'},{scheduleType:'daily',time:'25:00'}])assert.throws(()=>automationPayload({...draft,...invalid}),{code:'INVALID_AUTOMATION'});
});
test('old refresh responses cannot overwrite newer automation state',async()=>{
  const first=deferred();let calls=0;const c=new AutomationsController({request:()=>++calls===1?first.promise:Promise.resolve({automations:[{id:'new'}]})});const pending=c.load();await c.load();first.resolve({automations:[{id:'old'}]});await pending;assert.equal(c.state.automations[0].id,'new');c.dispose();
});
test('double run clicks submit once and successful mutation refreshes actual records',async()=>{
  const first=deferred(),calls=[];const c=new AutomationsController({request:(route,body)=>{calls.push({route,body});return body?first.promise:Promise.resolve({automations:[{id:'one',lastStatus:'completed'}]});}});const run=c.mutate('one','run');assert.equal(await c.mutate('one','run'),null);first.resolve({run:{id:'real-run'}});await run;assert.equal(calls.filter(row=>row.body).length,1);assert.equal(c.state.automations[0].lastStatus,'completed');c.dispose();
});
test('disposing a panel does not revive stale data after a pending request',async()=>{
  const first=deferred();let notifications=0;const c=new AutomationsController({request:()=>first.promise,onChange:()=>notifications++});const pending=c.load();c.dispose();first.resolve({automations:[{id:'old'}]});await pending;assert.equal(notifications,1);
});
