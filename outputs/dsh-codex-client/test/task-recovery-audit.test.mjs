import test from 'node:test';
import assert from 'node:assert/strict';
import {TaskRecovery} from '../server/task-recovery.mjs';
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const transient={codexErrorInfo:{responseStreamDisconnected:{httpStatusCode:null}}};
function fixture(){
  const session={id:'audit-chat',threadId:'audit-thread',engineId:'codex'},state={sessions:[session],preferences:{locale:'en'}},timers=new Map(),calls=[];let count=0;
  const engine={ready:true,activeTurns:new Map(),async startTurn(id,input){calls.push({id,input});const turn={id:'audit-turn-'+ ++count,status:'inProgress'};this.activeTurns.set(id,{turnId:turn.id});return{turn};},async queueRequest(){return{data:[]};},async interrupt(){}};
  const recovery=new TaskRecovery({state,save:async()=>{},getEngine:()=>engine,getSelectedEngine:()=> 'codex',setTimer:(fn,delay)=>{const id=Symbol();timers.set(id,{fn,delay});return id;},clearTimer:id=>timers.delete(id)});
  return{session,engine,recovery,timers,calls,async fire(){const [id,value]=timers.entries().next().value;timers.delete(id);await value.fn();await flush();await flush();}};
}

test('a temporary metadata failure preserves crash continuation eligibility for a verified interrupted turn',async()=>{
  const f=fixture();let reads=0;
  try{
    await f.recovery.start(f.session,[{type:'text',text:'perform once'}]);f.engine.activeTurns.clear();await f.recovery.engineExited('codex');
    f.engine.readTurnState=async()=>{if(++reads===1)throw Object.assign(Error('TIMEOUT'),{code:'TIMEOUT'});return{known:true,turnId:'audit-turn-1',status:'interrupted'};};
    await f.recovery.recover();assert.equal(f.calls.length,1);assert.equal(f.timers.size,1);
    await f.fire();assert.equal(f.calls.length,2,'temporary read failure must not abandon an otherwise eligible crash recovery');assert.equal(f.session.runRecovery.status,'running');
  }finally{await f.recovery.close();}
});

test('an untracked historical completion cannot acquire automatic continuation permission',async()=>{
  const f=fixture();
  try{
    await f.recovery.observe(f.session,{method:'turn/completed',params:{threadId:f.session.threadId,turn:{id:'old-turn',status:'failed',error:transient,reconciled:true}}});await flush();
    assert.equal(f.timers.size,0,'reading an old failed turn must not schedule a new model request');assert.equal(f.calls.length,0);
  }finally{await f.recovery.close();}
});

test('observed native queue turns still get checkpoints while automation runs remain unmanaged',async()=>{
  for(const automation of [false,true]){
    const f=fixture();if(automation)f.session.automationId='automation-owned';
    try{
      await f.recovery.observe(f.session,{method:'turn/started',params:{threadId:f.session.threadId,turn:{id:'queue-turn',status:'inProgress'}}});
      await f.recovery.observe(f.session,{method:'turn/completed',params:{threadId:f.session.threadId,turn:{id:'queue-turn',status:'failed',error:transient}}});await flush();
      assert.equal(f.session.runRecovery.managed,!automation);assert.equal(f.timers.size,automation?0:1);
    }finally{await f.recovery.close();}
  }
});

test('an unmanaged automation checkpoint becomes uncertain on host restart instead of waiting forever',async()=>{
  const f=fixture();f.session.automationId='automation-owned';
  try{
    await f.recovery.observe(f.session,{method:'turn/started',params:{threadId:f.session.threadId,turn:{id:'automation-turn',status:'inProgress'}}});
    await f.recovery.recover();
    assert.equal(f.session.runRecovery.status,'uncertain');assert.equal(f.session.runRecovery.canResume,true);assert.equal(f.timers.size,0);assert.equal(f.calls.length,0);
  }finally{await f.recovery.close();}
});
