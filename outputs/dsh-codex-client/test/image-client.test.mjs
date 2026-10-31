import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {apiImage,initCapability} from '../src/api.js';
import {readFilePreview,isImagePreview,isReadOnlyPreview,isExternalPreview} from '../src/lib/file-preview.js';
import {validateImageMetadata,MAX_IMAGE_BYTES} from '../src/lib/image-metadata.js';

const bytes=Buffer.from('Owned authenticated image transport fixture');
const metadata={path:'图像/photo #?.png',name:'photo #?.png',size:bytes.length,modifiedAt:'2026-10-24T00:00:00.000Z',version:createHash('sha256').update(bytes).digest('hex'),mime:'image/png',width:12,height:8};
const fault=code=>Object.assign(new Error(code),{code});
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function response({body=bytes,headers={},status=200,hold=false}={}){
  const counters={cancel:0,release:0,read:0,lateCancel:0};let sent=false;
  const reader={async read(){counters.read++;if(sent)return hold?new Promise(()=>{}):{done:true};sent=true;return {done:false,value:new Uint8Array(body)};},async cancel(){counters.cancel++;},releaseLock(){counters.release++;}};
  return {counters,ok:status>=200&&status<300,status,headers:new Headers({'content-type':metadata.mime,'content-length':String(metadata.size),'x-dsh-image-version':metadata.version,...headers}),body:{getReader:()=>reader,async cancel(){counters.lateCancel++;}}};
}
async function environment(t,handler){
  const previous=globalThis.document;globalThis.document={documentElement:{lang:'zh-CN'}};t.after(()=>{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;});
  const calls=[];t.mock.method(globalThis,'fetch',async(url,options)=>{calls.push({url,options});if(url==='/api/bootstrap')return new Response(JSON.stringify({capability:'owned-image-capability'}));return handler(url,options);});
  await initCapability();return calls;
}

test('image metadata requires bounded dimensions, bytes, canonical dates and a native byte version',()=>{
  assert.deepEqual(validateImageMetadata(metadata,metadata.path),metadata);
  for(const change of [{path:'other'},{name:''},{name:'nul\0name'},{size:0},{size:MAX_IMAGE_BYTES+1},{size:1.5},{mime:'image/svg+xml'},{width:16385},{width:8000,height:4001},{height:Infinity},{version:'old-text-version'},{version:'A'.repeat(64)},{modifiedAt:'2026-10-24'},{modifiedAt:'invalid'}])assert.throws(()=>validateImageMetadata({...metadata,...change},metadata.path),{code:'IMAGE_INFO_INVALID'});
});

test('optional image capability promotes only validated metadata to a read-only image, never a text version',async()=>{
  const calls=[];const image=await readFilePreview(async route=>{calls.push(route);if(route.includes('/file?'))throw fault('BINARY_FILE');return metadata;},'project /?',metadata.path,{images:true});
  assert.deepEqual(calls,['projects/project%20%2F%3F/file?path='+encodeURIComponent(metadata.path),'projects/project%20%2F%3F/image-info?path='+encodeURIComponent(metadata.path)]);
  assert.equal(image.content,'');assert.equal(image.version,null);assert.equal(image.preview.version,metadata.version);assert.ok(isImagePreview(image));assert.ok(isReadOnlyPreview(image));assert.equal(isExternalPreview(image),false);
});

test('disabled, unsupported and limited images retain ordinary metadata without making a decode request',async()=>{
  for(const code of ['IMAGE_UNSUPPORTED','IMAGE_ANIMATED','IMAGE_INVALID','IMAGE_LIMIT','IMAGE_PLUGIN_DISABLED','PLUGIN_DISABLED','NOT_FOUND']){
    const calls=[];const file=await readFilePreview(async route=>{calls.push(route);if(route.includes('/file?'))throw fault('BINARY_FILE');if(route.includes('/image-info?'))throw fault(code);return metadata;},'p',metadata.path,{images:true});
    assert.ok(isExternalPreview(file));assert.equal(file.version,null);assert.equal(file.content,'');assert.equal(calls.length,3);assert.equal(file.preview.reason,['IMAGE_ANIMATED','IMAGE_INVALID','IMAGE_LIMIT','IMAGE_PLUGIN_DISABLED'].includes(code)?code:'BINARY_FILE');
  }
  const calls=[];await readFilePreview(async route=>{calls.push(route);if(route.includes('/file?'))throw fault('BINARY_FILE');return metadata;},'p',metadata.path);assert.equal(calls.length,2);assert.ok(!calls.some(route=>route.includes('image')));
});

test('image identity and real read errors cannot be swallowed by an external-preview fallback',async()=>{
  for(const code of ['IMAGE_CHANGED','IMAGE_UNSAFE_PATH','IMAGE_NOT_FOUND','IMAGE_BUSY','IMAGE_LOAD_ABORTED','FORBIDDEN']){
    const calls=[];await assert.rejects(readFilePreview(async route=>{calls.push(route);if(route.includes('/file?'))throw fault('BINARY_FILE');throw fault(code);},'p',metadata.path,{images:true}),{code});assert.equal(calls.length,2);
  }
  for(const info of [null,undefined,{}, {...metadata,path:'other'},{...metadata,version:'forged'}])await assert.rejects(readFilePreview(async route=>{if(route.includes('/file?'))throw fault('BINARY_FILE');return info;},'p',metadata.path,{images:true}),{code:'IMAGE_INFO_INVALID'});
});

test('actual image transport uses local capability and cookie credentials, verifies bytes, and returns an owned typed Blob',async t=>{
  const received=response();const calls=await environment(t,async()=>received);
  const blob=await apiImage('project /?',metadata.path,metadata);assert.equal(blob.type,metadata.mime);assert.deepEqual(Buffer.from(await blob.arrayBuffer()),bytes);
  const request=calls.at(-1);assert.equal(request.url,'/api/projects/project%20%2F%3F/image?path='+encodeURIComponent(metadata.path)+'&version='+metadata.version);assert.equal(request.options.credentials,'same-origin');assert.equal(request.options.headers['X-DSH-Capability'],'owned-image-capability');assert.equal(request.options.headers['Accept-Language'],'zh-CN');assert.equal(request.options.headers.Accept,'image/png');assert.equal(received.counters.cancel,1);assert.equal(received.counters.release,1);
});

test('mismatched response headers and oversized, short or altered bytes are rejected and each reader is released',async t=>{
  let current;await environment(t,async()=>current);
  for(const headers of [{'content-type':'image/svg+xml'},{'content-type':'image/png; charset=utf-8'},{'content-length':'1'},{'content-length':'-1'},{'content-length':'999999999'},{'x-dsh-image-version':'b'.repeat(64)}]){
    current=response({headers});await assert.rejects(apiImage('p',metadata.path,metadata),{code:'IMAGE_RESPONSE_INVALID'});assert.equal(current.counters.read,0);assert.equal(current.counters.cancel,1);assert.equal(current.counters.release,1);
  }
  for(const body of [Buffer.concat([bytes,Buffer.from('extra')]),bytes.subarray(1),Buffer.from('x'.repeat(bytes.length))]){
    current=response({body});await assert.rejects(apiImage('p',metadata.path,metadata),{code:'IMAGE_RESPONSE_INVALID'});assert.equal(current.counters.cancel,1);assert.equal(current.counters.release,1);
  }
});

test('bounded HTTP errors retain their actual code and never return a Blob',async t=>{
  let current;await environment(t,async()=>current);
  current=response({status:409,body:Buffer.from(JSON.stringify({code:'IMAGE_CHANGED',message:'Changed'}))});await assert.rejects(apiImage('p',metadata.path,metadata),{code:'IMAGE_CHANGED'});
  current=response({status:400,body:Buffer.alloc(8193,65)});await assert.rejects(apiImage('p',metadata.path,metadata),{code:'IMAGE_RESPONSE_INVALID'});assert.equal(current.counters.cancel,1);
  current=response({status:400,body:Buffer.from('not JSON')});await assert.rejects(apiImage('p',metadata.path,metadata),{code:'IMAGE_RESPONSE_INVALID'});
});

test('image timeout and caller abort cancel their own stream without retries or late results',async t=>{
  let current;const calls=await environment(t,async()=>current);
  current=response({hold:true});await assert.rejects(apiImage('p',metadata.path,metadata,{timeoutMs:30}),{code:'IMAGE_LOAD_TIMEOUT'});assert.equal(current.counters.cancel,1);assert.equal(current.counters.release,1);
  current=response({hold:true});const abort=new AbortController(),pending=apiImage('p',metadata.path,metadata,{signal:abort.signal,timeoutMs:1000});await tick();abort.abort();await assert.rejects(pending,{code:'IMAGE_LOAD_ABORTED'});assert.equal(current.counters.cancel,1);assert.equal(current.counters.release,1);assert.equal(calls.filter(call=>call.url.includes('/image?')).length,2);
});

test('a cancelled image request ignores late fetch headers and never starts reading the late body',async t=>{
  const held=deferred(),late=response();await environment(t,()=>held.promise);const abort=new AbortController();const pending=apiImage('p',metadata.path,metadata,{signal:abort.signal});await tick();abort.abort();await assert.rejects(pending,{code:'IMAGE_LOAD_ABORTED'});held.resolve(late);await tick();assert.equal(late.counters.read,0);assert.equal(late.counters.lateCancel,1);
});
