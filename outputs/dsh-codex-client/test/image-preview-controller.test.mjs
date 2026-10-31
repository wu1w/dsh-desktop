import test from 'node:test';
import assert from 'node:assert/strict';
import {harness,imageFile,blob,deferred,turn} from './image-preview-harness.mjs';

test('a late blob after project/version switch is ignored before effects flush and never allocates a URL',async()=>{
  const a=deferred(),b=deferred(),calls=[],app=harness({loadImage:signal=>{calls.push(['A',signal]);return a.promise;}});
  app.render();app.flush();await turn();assert.equal(calls.length,1);
  const file=imageFile({projectId:'B'});assert.equal(app.render({file,loadImage:signal=>{calls.push(['B',signal]);return b.promise;}}).img,undefined);
  a.resolve(blob());await turn();assert.equal(app.created.length,0,'render-time identity guard precedes effect cleanup');
  app.flush();await turn();assert.equal(calls[0][1].aborted,true);assert.equal(calls.length,2);
  b.resolve(blob());await app.settle();app.decode();assert.equal(app.created.length,1);
  app.render({locale:'zh-CN',loadImage:()=>{throw Error('SSE/locale rerender must not reload');}});app.flush();await turn();assert.equal(calls.length,2);assert.equal(app.created.length,1);app.unmount();assert.deepEqual(app.revoked,app.created);
});
test('a ready old file is hidden immediately and its URL is released exactly once on replacement or unmount',async()=>{
  const signals=[],app=harness({loadImage:async signal=>{signals.push(signal);return blob();}});app.render();app.flush();await app.settle();const old=app.decode();assert.ok(old.img);
  const next=imageFile({preview:{...imageFile().preview,version:'b'.repeat(64)}});assert.equal(app.render({file:next}).img,undefined);old.img.props.onLoad({currentTarget:{naturalWidth:2000,naturalHeight:1000}});assert.equal(app.render().img,undefined);
  app.flush();await app.settle();app.decode();assert.equal(signals[0].aborted,true);assert.deepEqual(app.revoked,[app.created[0]]);app.unmount();assert.equal(signals[1].aborted,true);assert.deepEqual(app.revoked,app.created);assert.ok(app.observers.every(observer=>observer.disconnected));
});
test('disabled or unmounted preview aborts pending loads, removes observers and does not allocate late URLs',async()=>{
  const first=deferred(),second=deferred(),signals=[],app=harness({loadImage:signal=>{signals.push(signal);return signals.length===1?first.promise:second.promise;}});
  app.render();app.flush();await turn();assert.equal(app.render({enabled:false}).img,undefined);app.flush();assert.equal(signals[0].aborted,true);first.resolve(blob());await turn();assert.equal(app.created.length,0);assert.equal(app.observers[0].disconnected,true);
  app.render({enabled:true});app.flush();await turn();app.unmount();assert.equal(signals[1].aborted,true);second.resolve(blob());await turn();assert.equal(app.created.length,0);assert.ok(app.observers.every(observer=>observer.disconnected));
});
test('actual error/retry flow translates known codes, hides raw errors, single-flights metadata and retries the same file',async()=>{
  const metadata=deferred();let loads=0,retries=0;
  const app=harness({t:key=>key==='IMAGE_CHANGED'?'The image changed.':key,loadImage:async()=>{if(++loads===1)throw Object.assign(new Error('PRIVATE_NETWORK_STACK'),{code:'IMAGE_CHANGED'});return blob();},onRetry:()=>{retries++;return metadata.promise;}});
  app.render();app.flush();await app.settle();let view=app.render();assert.ok(view.nodes.some(node=>node.type==='p'&&node.props.children==='The image changed.'));assert.ok(!JSON.stringify(view.tree).includes('PRIVATE_NETWORK_STACK'));
  const retry=view.button('Reload image');const pending=retry.props.onClick();await retry.props.onClick();assert.equal(retries,1);assert.equal(loads,1);assert.equal(app.render().button('Loading image…').props.disabled,true);
  metadata.resolve();await pending;app.render();app.flush();await app.settle();view=app.decode();assert.ok(view.img);assert.equal(loads,2);app.unmount();assert.deepEqual(app.revoked,app.created);
});
test('late retry metadata does not fetch or replace a newly selected project',async()=>{
  const metadata=deferred();let oldLoads=0,newLoads=0;
  const app=harness({loadImage:async()=>{oldLoads++;throw Error('temporary');},onRetry:()=>metadata.promise});app.render();app.flush();await app.settle();const pending=app.render().button('Reload image').props.onClick();
  app.render({file:imageFile({projectId:'B'}),loadImage:async()=>{newLoads++;return blob();}});app.flush();await app.settle();app.decode();metadata.resolve();await pending;app.render();app.flush();await turn();assert.equal(oldLoads,1);assert.equal(newLoads,1);assert.equal(app.created.length,1);app.unmount();
});
test('decode errors revoke their object URL immediately and invalid blobs never become image sources',async()=>{
  const app=harness();app.render();app.flush();await app.settle();let view=app.render();view.img.props.onError();view=app.render();assert.equal(view.img,undefined);assert.deepEqual(app.revoked,app.created);assert.ok(view.button('Reload image'));app.unmount();assert.deepEqual(app.revoked,app.created);
  for(const value of [new Blob([],{type:'image/png'}),new Blob(['<svg/>'],{type:'image/svg+xml'}),'not a blob']){
    const rejected=harness({loadImage:async()=>value});rejected.render();rejected.flush();await rejected.settle();assert.equal(rejected.render().img,undefined);assert.equal(rejected.created.length,0);assert.ok(rejected.render().button('Reload image'));assert.ok(rejected.render().nodes.some(node=>node.type==='p'&&node.props.children==='The image could not be loaded. Try again.'));rejected.unmount();
  }
});
test('oversized metadata and decoded dimensions are rejected while independent file identities never collide',async()=>{
  const app=harness();assert.notEqual(app.module.imagePreviewIdentity(imageFile()),app.module.imagePreviewIdentity(imageFile({projectId:'B'})));assert.notEqual(app.module.imagePreviewIdentity(imageFile()),app.module.imagePreviewIdentity(imageFile({preview:{...imageFile().preview,version:'b'.repeat(64)}})));
  assert.equal(app.module.imagePreviewIdentity(imageFile({preview:{...imageFile().preview,version:'v1'}})),null);
  assert.equal(app.module.imagePreviewIdentity(imageFile({preview:{...imageFile().preview,width:8000,height:4001}})),null,'32 million pixels, not 32 Mi pixels');
  let calls=0;const invalid=imageFile({preview:{...imageFile().preview,width:16385}});app.render({file:invalid,loadImage:async()=>{calls++;return blob();}});app.flush();await turn();assert.equal(calls,0);assert.equal(app.created.length,0);app.unmount();
  const decoded=harness();decoded.render();decoded.flush();await decoded.settle();decoded.decode(16385,100);assert.equal(decoded.render().img,undefined);assert.deepEqual(decoded.revoked,decoded.created);decoded.unmount();
});
