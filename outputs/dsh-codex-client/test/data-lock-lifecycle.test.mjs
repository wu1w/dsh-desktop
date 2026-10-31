import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm,stat} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import http from 'node:http';
import lockfile from 'proper-lockfile';
import {acquireDataLock} from '../server/data-lock.mjs';
import {startHost} from '../server/index.mjs';
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
async function temporary(run){const root=await realpath(await mkdtemp(path.join(tmpdir(),'dsh-data-lock-')));try{return await run(root);}finally{await rm(root,{recursive:true,force:true});}}

test('normal data lock exclusion and unexpected duplicate release keep their original safety errors',()=>temporary(async root=>{
  const release=await acquireDataLock(path.join(root,'data'),()=>assert.fail('unexpected loss'));
  await assert.rejects(acquireDataLock(path.join(root,'data')), {code:'DATA_IN_USE'});await release();await assert.rejects(release(),{code:'ERELEASED'});
  const next=await acquireDataLock(path.join(root,'data'));await next();
}));

test('real native lock-directory removal preserves the original compromised cause through release',{timeout:9000},()=>temporary(async root=>{
  const lost=deferred(),directory=path.join(root,'data'),release=await acquireDataLock(directory,lost.resolve);await rm(directory+'.lock',{recursive:true});
  const error=await lost.promise;assert.equal(error.code,'DATA_LOCK_LOST');assert.equal(error.message,'DATA_LOCK_LOST');assert.equal(error.cause.code,'ECOMPROMISED');assert.equal(error.cause.errno,-2);
  await assert.rejects(release(),actual=>actual===error);await assert.rejects(release(),actual=>actual===error);await assert.rejects(stat(directory+'.lock'),{code:'ENOENT'});
}));

test('a real host losing its native lock ends SSE and reports DATA_LOCK_LOST instead of ERELEASED on close',{timeout:10000},()=>temporary(async root=>{
  const directory=path.join(root,'data'),host=await startHost({dataDir:directory,autoStart:false});let closingError;
  try{const response=await fetch(host.url+'/api/bootstrap'),boot=await response.json(),headers={cookie:response.headers.get('set-cookie').split(';')[0],'x-dsh-capability':boot.capability};const events=await fetch(host.url+'/api/events',{headers}),reader=events.body.getReader();await reader.read();await rm(directory+'.lock',{recursive:true});let ended=false;while(!ended)ended=(await reader.read()).done;
    try{await host.close();assert.fail('lost host must reject close');}catch(error){closingError=error;assert.equal(error.code,'DATA_LOCK_LOST');assert.equal(error.cause.code,'ECOMPROMISED');}
    await assert.rejects(host.close(),error=>error===closingError);await assert.rejects(fetch(host.url+'/api/bootstrap'));assert.equal(host.engine,undefined);
  }finally{await host.close().catch(error=>assert.equal(error.code,'DATA_LOCK_LOST'));}
}));

test('controlled loss before startup handler is installed blocks API mutation, waits for shutdown and rejects startup',async t=>temporary(async root=>{
  let compromise,server,releases=0,closed=false,blocked;const originalCreate=http.createServer,originalLock=lockfile.lock;
  t.mock.method(lockfile,'lock',async(_directory,options)=>{if(_directory!==path.join(root,'data'))return originalLock(_directory,options);compromise=()=>options.onCompromised(Object.assign(new Error('PRIVATE_NATIVE_LOSS'),{code:'ECOMPROMISED'}));return async()=>{releases++;};});
  t.mock.method(http,'createServer',(...args)=>{server=originalCreate(...args);server.once('close',()=>{closed=true;});server.once('listening',()=>{
    compromise();const response={headersSent:false,setHeader(){},writeHead(status){this.status=status;this.headersSent=true;},end(body){blocked={status:this.status,body:JSON.parse(body)};}};
    // This request occurs while startHost is still awaiting listen, before
    // result.close has been assigned as the lock-loss handler.
    server.emit('request',{complete:true,headers:{host:'127.0.0.1:0','accept-language':'en'},url:'/api/projects',method:'POST'},response);
  });return server;});
  try{await assert.rejects(startHost({dataDir:path.join(root,'data'),autoStart:false}),error=>{assert.equal(error.code,'DATA_LOCK_LOST');assert.equal(error.cause.code,'ECOMPROMISED');assert.equal(error.cause.message,'PRIVATE_NATIVE_LOSS');return true;});assert.equal(closed,true);assert.equal(server.listening,false);assert.equal(releases,0);assert.equal(blocked.status,400);assert.equal(blocked.body.code,'DATA_LOCK_LOST');assert.equal(JSON.stringify(blocked).includes('PRIVATE_NATIVE_LOSS'),false);}finally{t.mock.restoreAll();server?.close();}
}));
