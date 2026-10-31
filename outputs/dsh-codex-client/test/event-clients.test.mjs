import test from'node:test';import assert from'node:assert/strict';import{EventEmitter}from'node:events';import{EventClients}from'../server/event-clients.mjs';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms)),size=value=>Buffer.byteLength(`data: ${JSON.stringify(value)}\n\n`);
class Response extends EventEmitter{
 constructor({block=false}={}){super();this.block=block;this.frames=[];this.writableLength=0;this.destroyed=false;this.writableEnded=false;this.destroyCount=0;this.endCount=0;}
 write(frame){if(this.throwWrite)throw Error('OWNED_WRITE_FAILED');this.frames.push(Buffer.from(frame));if(this.closeOnWrite){this.emit('close');return false;}if(this.block){this.writableLength+=frame.length;return false;}return true;}
 drain({block=false}={}){this.block=block;this.writableLength=0;this.emit('drain');}
 destroy(){this.destroyed=true;this.destroyCount++;this.emit('close');}
 end(){this.writableEnded=true;this.endCount++;this.emit('finish');}
}
const events=response=>response.frames.filter(frame=>frame.toString().startsWith('data:')).map(frame=>JSON.parse(frame.toString().slice(6)));
const clean=response=>{for(const name of ['drain','close','error','finish'])assert.equal(response.listenerCount(name),0,name+' listener leaked');};

test('write false already accepted its entire frame; repeated drain preserves exact FIFO without duplicates',()=>{
 const manager=new EventClients(),response=new Response();try{manager.add(response);response.block=true;for(let sequence=0;sequence<20;sequence++)manager.send(response,{sequence,text:'中文😀'});assert.deepEqual(events(response).map(row=>row.sequence),[0]);assert.equal(manager.snapshot()[0].pendingFrames,19);for(let index=0;index<20;index++)response.drain({block:true});assert.deepEqual(events(response).map(row=>row.sequence),Array.from({length:20},(_,index)=>index));assert.equal(manager.snapshot()[0].pendingFrames,0);response.drain();assert.equal(manager.snapshot()[0].blocked,false);}finally{manager.close();clean(response);}
});
test('connected, approval sync, approval, state, queue and heartbeat all share a single ordered queue',()=>{
 const manager=new EventClients(),response=new Response({block:true});try{manager.add(response);for(const type of ['approvals-sync','approval','state','queue'])manager.send(response,{type});manager.heartbeat();assert.equal(response.frames.length,1);response.drain();assert.deepEqual(response.frames.map(frame=>frame.toString().startsWith(':')?frame.toString().trim():JSON.parse(frame.toString().slice(6)).type),[': connected','approvals-sync','approval','state','queue',': heartbeat']);}finally{manager.close();clean(response);}
});
test('single-frame UTF8 boundary is exact and a larger frame is never written',()=>{
 const value={text:'中文😀'},bytes=size(value),manager=new EventClients({maxFrameBytes:bytes}),response=new Response();manager.add(response);assert.equal(manager.send(response,value),true);assert.equal(manager.send(response,{text:'中文😀x'}),false);assert.equal(events(response).length,1);assert.equal(response.destroyCount,1);assert.equal(manager.size,0);clean(response);
});
test('pending plus native writable bytes obey the exact combined limit, counting accepted false frame once',()=>{
 const first={n:1,text:'中文'},second={n:2,text:'😀'},budget=size(first)+size(second),manager=new EventClients({maxBufferBytes:budget}),response=new Response();manager.add(response);response.block=true;manager.send(response,first);assert.equal(manager.send(response,second),true);const row=manager.snapshot()[0];assert.equal(row.pendingBytes+row.writableBytes,budget);assert.equal(row.pendingFrames,1);assert.equal(manager.send(response,{x:1}),false);assert.equal(response.destroyCount,1);assert.deepEqual(events(response),[first]);clean(response);
});
test('pending frame count is bounded separately from byte budget',()=>{
 const manager=new EventClients({maxPendingFrames:2}),response=new Response({block:true});manager.add(response);manager.send(response,{n:1});manager.send(response,{n:2});assert.equal(manager.snapshot()[0].pendingFrames,2);manager.send(response,{n:3});assert.equal(response.destroyCount,1);assert.equal(manager.size,0);clean(response);
});
test('continuous queued heartbeats cannot extend a blocked connection stall deadline',async()=>{
 const manager=new EventClients({stallTimeoutMs:25}),response=new Response({block:true});manager.add(response);const timer=setInterval(()=>manager.heartbeat(),5);try{await delay(55);assert.equal(manager.size,0);assert.equal(response.destroyCount,1);clean(response);}finally{clearInterval(timer);manager.close();}
});
test('actual drain cancels the stall timer instead of destroying a recovered client later',async()=>{
 const manager=new EventClients({stallTimeoutMs:20}),response=new Response({block:true});try{manager.add(response);manager.send(response,{n:1});response.drain();await delay(45);assert.equal(manager.size,1);assert.equal(response.destroyCount,0);assert.equal(manager.snapshot()[0].blocked,false);}finally{manager.close();assert.equal(response.endCount,1);clean(response);}
});
test('slow, destroyed and throwing responses cannot interrupt another client',()=>{
 const manager=new EventClients({maxBufferBytes:80}),slow=new Response({block:true}),failed=new Response(),fast=new Response();manager.add(slow);manager.add(failed);manager.add(fast);failed.throwWrite=true;manager.broadcast({sequence:1,text:'a'.repeat(25)});manager.broadcast({sequence:2,text:'b'.repeat(25)});assert.equal(slow.destroyCount,1);assert.equal(failed.destroyCount,1);assert.deepEqual(events(fast).map(row=>row.sequence),[1,2]);assert.equal(manager.size,1);manager.close();for(const response of [slow,failed,fast])clean(response);
});
test('host close ends an empty client, destroys blocked/pending data and releases every owned listener',()=>{
 const manager=new EventClients(),empty=new Response(),blocked=new Response({block:true});manager.add(empty);manager.add(blocked);manager.send(blocked,{type:'pending'});manager.close();assert.equal(empty.endCount,1);assert.equal(empty.destroyCount,0);assert.equal(blocked.endCount,0);assert.equal(blocked.destroyCount,1);assert.equal(manager.size,0);for(const response of [empty,blocked]){clean(response);response.emit('drain');}manager.close();assert.equal(empty.endCount,1);assert.equal(blocked.destroyCount,1);assert.equal(manager.send(empty,{type:'late'}),false);const late=new Response();assert.equal(manager.add(late),false);assert.equal(late.destroyCount,1);clean(late);
});
test('a response that closes synchronously inside write cannot install a late orphan stall timer',async()=>{
 const manager=new EventClients({stallTimeoutMs:10}),response=new Response();response.closeOnWrite=true;manager.add(response);assert.equal(manager.size,0);await delay(25);assert.equal(response.destroyCount,0);clean(response);manager.close();
});

test('response error cancels its blocked deadline and listeners while production budgets stay explicit',async()=>{
 const manager=new EventClients({stallTimeoutMs:10}),response=new Response({block:true});manager.add(response);response.emit('error',Error('OWNED_SOCKET_FAILURE'));assert.equal(manager.size,0);assert.equal(response.destroyCount,1);clean(response);await delay(25);assert.equal(response.destroyCount,1);manager.close();const defaults=new EventClients();assert.equal(defaults.maxFrameBytes,4*1024*1024);assert.equal(defaults.maxBufferBytes,8*1024*1024);assert.equal(defaults.maxPendingFrames,256);assert.equal(defaults.stallTimeoutMs,10000);defaults.close();
});
