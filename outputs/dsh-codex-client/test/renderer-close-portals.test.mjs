import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const {RendererCloseGuard}=await import(process.env.DSH_CLOSE_GUARD_TEST_SOURCE?pathToFileURL(process.env.DSH_CLOSE_GUARD_TEST_SOURCE):new URL('../src/lib/renderer-close-guard.js',import.meta.url));
function fixture({bodyInert=false,flush=async()=>{},observeFailure=false}={}){
  const body={inert:bodyInert},root={inert:false},first={inert:false},prior={inert:true},closed={inert:false},dialogs=[first,prior],observers=[],reports=[],errors=[],preserved=[];
  class Observer{
    constructor(callback){this.callback=callback;this.disconnected=false;observers.push(this);}
    observe(element,options){this.element=element;this.options=options;if(observeFailure)throw Object.assign(Error('fixture observer failure'),{code:'OBSERVER_FAILED'});}
    disconnect(){this.disconnected=true;}
  }
  const page={body,defaultView:{MutationObserver:Observer},querySelectorAll(selector){assert.equal(selector,'dialog[open]');return dialogs;}};root.ownerDocument=page;
  const guard=new RendererCloseGuard({getRevision:()=>4,getElement:()=>root,flush,preserve:()=>preserved.push(true),onError:error=>errors.push(error.code),report:async value=>reports.push(value)});
  return{guard,body,root,first,prior,closed,dialogs,observers,reports,errors,preserved};
}
test('close protection covers body portals and each open modal, and restores their individual previous inert values',()=>{
  const f=fixture({bodyInert:true});f.guard.lock();assert.equal(f.root.inert,true);assert.equal(f.body.inert,true);assert.equal(f.first.inert,true);assert.equal(f.prior.inert,true);assert.equal(f.closed.inert,false);
  f.guard.release();assert.equal(f.root.inert,false);assert.equal(f.body.inert,true);assert.equal(f.first.inert,false);assert.equal(f.prior.inert,true);assert.equal(f.observers.length,1);assert.equal(f.observers[0].disconnected,true);
});
test('a modal opened or inserted while closing receives its own lock, without overwriting an existing modal previous state',()=>{
  const f=fixture();f.guard.lock();const observer=f.observers[0];assert.ok(observer);assert.equal(observer.element,f.body);assert.equal(observer.options.subtree,true);assert.equal(observer.options.childList,true);assert.deepEqual(observer.options.attributeFilter,['open']);
  f.dialogs.push(f.closed);observer.callback();assert.equal(f.closed.inert,true);observer.callback();f.guard.lock();assert.equal(f.observers.length,1);
  f.guard.release();assert.equal(f.closed.inert,false);assert.equal(f.first.inert,false);assert.equal(f.prior.inert,true);
});
test('a disconnected observer cannot reapply a lock after release or protect unrelated dialogs during a later handshake',()=>{
  const f=fixture();f.guard.lock();const firstObserver=f.observers[0];assert.ok(firstObserver);f.guard.release();const late={inert:false};f.dialogs.push(late);firstObserver.callback();assert.equal(late.inert,false);
  f.guard.lock();assert.equal(late.inert,true);const later={inert:false};f.dialogs.push(later);firstObserver.callback();assert.equal(later.inert,false);f.observers[1].callback();assert.equal(later.inert,true);f.guard.release();assert.equal(late.inert,false);assert.equal(later.inert,false);
});
test('a rejected persistence unlocks portals and modals while preserving previously inert elements and the draft',async()=>{
  const f=fixture({flush:async()=>{throw Object.assign(Error('disk full'),{code:'DISK_FULL'});}});assert.equal(await f.guard.request({requestId:'failed'}),false);assert.deepEqual(f.errors,['DISK_FULL']);assert.deepEqual(f.preserved,[true]);assert.deepEqual(f.reports,[{requestId:'failed',allow:false}]);assert.equal(f.root.inert,false);assert.equal(f.body.inert,false);assert.equal(f.first.inert,false);assert.equal(f.prior.inert,true);assert.equal(f.observers[0]?.disconnected,true);
});
test('failure during lock setup refuses closure, restores interaction, and never starts a flush',async()=>{
  let flushes=0;const f=fixture({observeFailure:true,flush:async()=>{flushes++;}});assert.equal(await f.guard.request({requestId:'setup-failed'}),false);assert.equal(flushes,0);assert.deepEqual(f.errors,['OBSERVER_FAILED']);assert.deepEqual(f.preserved,[true]);assert.deepEqual(f.reports,[{requestId:'setup-failed',allow:false}]);assert.equal(f.root.inert,false);assert.equal(f.body.inert,false);assert.equal(f.first.inert,false);assert.equal(f.prior.inert,true);assert.equal(f.observers[0]?.disconnected,true);
});
test('release restores the previously focused control after all locks, without scrolling or repeating focus on a second release',()=>{
  const f=fixture(),calls=[],target={isConnected:true,focus(options){calls.push({options,body:f.body.inert,root:f.root.inert,modal:f.first.inert});}};f.root.ownerDocument.activeElement=target;f.guard.lock();f.root.ownerDocument.activeElement=f.body;f.guard.release();assert.deepEqual(calls,[{options:{preventScroll:true},body:false,root:false,modal:false}]);f.guard.release();assert.equal(calls.length,1);
});
test('unmounted focus targets are skipped and focus failures cannot prevent inert restoration or observer cleanup',()=>{
  for(const connected of [false,true]){const f=fixture();let calls=0;f.root.ownerDocument.activeElement={isConnected:connected,focus(){calls++;throw Error('focus cannot run');}};f.guard.lock();assert.doesNotThrow(()=>f.guard.release());assert.equal(calls,Number(connected));assert.equal(f.body.inert,false);assert.equal(f.root.inert,false);assert.equal(f.first.inert,false);assert.equal(f.observers[0].disconnected,true);}
});
test('locked modal cancellation is prevented in document capture, including late dialogs, and the listener is removed on release',()=>{
  const f=fixture(),page=f.root.ownerDocument,attached=[],removed=[];page.addEventListener=(...args)=>attached.push(args);page.removeEventListener=(...args)=>removed.push(args);f.guard.lock();assert.equal(attached.length,2);const[type,listener,capture]=attached[0];assert.equal(type,'cancel');assert.equal(capture,true);
  const event=tagName=>({target:{tagName},preventDefault(){this.prevented=true;},stopImmediatePropagation(){this.stopped=true;}});
  for(const tag of ['DIALOG','INPUT']){const e=event(tag);listener(e);assert.equal(Boolean(e.prevented),tag==='DIALOG');assert.equal(Boolean(e.stopped),tag==='DIALOG');}
  const[keyType,keyListener,keyCapture]=attached[1];assert.equal(keyType,'keydown');assert.equal(keyCapture,true);for(const key of ['Escape','Enter']){const e={...event('DIALOG'),key};keyListener(e);assert.equal(Boolean(e.prevented),key==='Escape');assert.equal(Boolean(e.stopped),key==='Escape');}
  f.guard.release();assert.deepEqual(removed,attached);const stale=event('DIALOG');listener(stale);assert.equal(Boolean(stale.prevented),false);f.guard.release();assert.equal(removed.length,2);const staleKey={...event('DIALOG'),key:'Escape'};keyListener(staleKey);assert.equal(Boolean(staleKey.prevented),false);
});
