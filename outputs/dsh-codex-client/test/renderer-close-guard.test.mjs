import test from 'node:test';
import assert from 'node:assert/strict';
import {RendererCloseGuard} from '../src/lib/renderer-close-guard.js';
const deferred=()=>{let resolve;const promise=new Promise(a=>resolve=a);return{promise,resolve};};
function fixture(extra={}){let revision=4;const element={inert:false},reports=[],errors=[],calls=[];const guard=new RendererCloseGuard({getRevision:()=>revision,getElement:()=>element,flush:async options=>calls.push(options),preserve:()=>calls.push('preserved'),onError:error=>errors.push(error.code),report:async body=>reports.push(body),...extra});return{guard,element,reports,errors,calls,setRevision:value=>{revision=value;}};}
test('a stale native discard approval never reaches the current document flush',async()=>{
  const f=fixture();assert.equal(await f.guard.request({requestId:'old',discardDocument:true,expectedDirtyRevision:3}),false);assert.deepEqual(f.calls,['preserved']);assert.deepEqual(f.reports,[{requestId:'old',allow:false}]);assert.deepEqual(f.errors,['CLOSE_DOCUMENT_CHANGED']);assert.equal(f.element.inert,false);
});
test('editing during a delayed persistence refuses closure and preserves the newer document',async()=>{
  const pending=deferred(),f=fixture({flush:()=>pending.promise});const closing=f.guard.request({requestId:'one',discardDocument:true,expectedDirtyRevision:4});assert.equal(f.element.inert,true);f.setRevision(5);pending.resolve();assert.equal(await closing,false);assert.ok(f.calls.includes('preserved'));assert.equal(f.element.inert,false);
});
test('a successful flush keeps editing inert until the native transition ends or is cancelled',async()=>{
  const f=fixture();assert.equal(await f.guard.request({requestId:'one',expectedDirtyRevision:4}),true);assert.equal(f.element.inert,true);f.guard.release();assert.equal(f.element.inert,false);assert.deepEqual(f.reports,[{requestId:'one',allow:true}]);
});
test('a failed flush restores prior interaction and never authorizes native close',async()=>{
  const f=fixture({flush:async()=>{throw Object.assign(Error('disk'),{code:'DISK_FULL'});}});assert.equal(await f.guard.request({requestId:'one'}),false);assert.equal(f.element.inert,false);assert.deepEqual(f.errors,['DISK_FULL']);assert.equal(f.reports[0].allow,false);
});
test('overlapping close handshakes cannot run competing discard operations',async()=>{
  const pending=deferred();let flushes=0;const f=fixture({flush:()=>{flushes++;return pending.promise;}});const first=f.guard.request({requestId:'one'});assert.equal(await f.guard.request({requestId:'two'}),false);assert.equal(flushes,1);pending.resolve();assert.equal(await first,true);assert.deepEqual(f.reports,[{requestId:'two',allow:false},{requestId:'one',allow:true}]);f.guard.release();
});
