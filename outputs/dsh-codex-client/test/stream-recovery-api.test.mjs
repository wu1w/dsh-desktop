import test from'node:test';import assert from'node:assert/strict';
import{mkdtemp,mkdir,rm,readFile,writeFile,appendFile}from'node:fs/promises';import{tmpdir}from'node:os';import path from'node:path';import{fileURLToPath,pathToFileURL}from'node:url';
import http from'node:http';
import{readEventStream}from'../src/lib/event-stream.js';
const appRoot=process.env.DSH_ACCEPTANCE_APP_ROOT;
const {startHost}=await import(appRoot?pathToFileURL(path.join(appRoot,'server/index.mjs')):new URL('../server/index.mjs',import.meta.url));
const fixture=fileURLToPath(new URL('./fixtures/recovery-app-server.mjs',import.meta.url)),results=[],startedAt=new Date().toISOString();
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(work,{timeout=5000}={}){const deadline=Date.now()+timeout;let last;while(Date.now()<deadline){last=await work();if(last)return last;await delay(10);}assert.fail('recovery fixture condition timed out');}
async function logs(file){try{return(await readFile(file,'utf8')).split('\n').filter(Boolean).map(JSON.parse);}catch(error){if(error.code==='ENOENT')return[];throw error;}}
async function connection(host){const response=await fetch(host.url+'/api/bootstrap'),boot=await response.json(),headers={cookie:response.headers.get('set-cookie').split(';')[0],'x-dsh-capability':boot.capability,'content-type':'application/json','accept-language':'en'};return {boot,headers,api:async(route,body)=>{const response=await fetch(host.url+'/api/'+route,{headers,method:body===undefined?'GET':'POST',body:body===undefined?undefined:JSON.stringify(body)});return{httpStatus:response.status,...await response.json()};}};}
async function events(host,headers){
 const controller=new AbortController(),response=await fetch(host.url+'/api/events',{headers,signal:controller.signal}),reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';const queue=[];
 return{async close(){controller.abort();await reader.cancel().catch(()=>{});},async next(type){
  const timer=setTimeout(()=>controller.abort(),5000);try{for(;;){const index=queue.findIndex(event=>event.type===type);if(index>=0)return queue.splice(index,1)[0];const{value,done}=await reader.read();if(done)throw Error('RECOVERY_STREAM_ENDED');buffer+=decoder.decode(value,{stream:true});for(;;){const end=buffer.indexOf('\n\n');if(end<0)break;const block=buffer.slice(0,end);buffer=buffer.slice(end+2);for(const line of block.split('\n'))if(line.startsWith('data: '))queue.push(JSON.parse(line.slice(6)));}}}finally{clearTimeout(timer);}
 }};
}
async function setup(approvalTimeoutMs=150000){const directory=await mkdtemp(path.join(tmpdir(),'dsh-stream-recovery-api-')),projectPath=path.join(directory,'project'),capture=path.join(directory,'capture.jsonl'),control=path.join(directory,'control.jsonl');await mkdir(projectPath);const host=await startHost({dataDir:path.join(directory,'data'),binary:process.execPath,engineOptions:{args:[fixture],resolveApiKey:async()=> 'isolated-recovery-fixture-key',approvalTimeoutMs,extraEnv:{DSH_RECOVERY_CAPTURE:capture,DSH_RECOVERY_CONTROL:control}}});const c=await connection(host),project=await c.api('projects',{path:projectPath});assert.equal(c.boot.state.engine.state,'ready');let controlId=0;return{directory,host,c,capture,async session(){const row=await c.api('sessions',{projectId:project.id});assert.equal(row.httpStatus,200);return row;},async control(command){const id=++controlId;await appendFile(control,JSON.stringify({...command,id})+'\n');await until(async()=>(await logs(capture)).some(row=>row.type==='control-applied'&&row.controlId===id));}};}
const count=(rows,method)=>rows.filter(row=>row.type==='rpc'&&row.method===method).length;

test('real host stream gap and independent recovery scenarios',{concurrency:true,timeout:90000},async t=>{
 try{await Promise.all([
  t.test('65-second gap recovers completion, queue consumption and authoritative replacement approval without replay',{timeout:85000},async()=>{
   const s=await setup();let stream;const result={name:'65-second-gap',ok:false};
   try{
    stream=await events(s.host,s.c.headers);assert.deepEqual((await stream.next('approvals-sync')).requests,[]);
    const a=await s.session(),b=await s.session();await s.c.api('sessions/'+a.id+'/turn',{text:'first task',permission:'read-only'});await s.c.api('sessions/'+b.id+'/turn',{text:'approval task',permission:'read-only'});
    await s.control({action:'approval',threadId:b.threadId,tag:'old'});const old=(await stream.next('approval')).request;
    await s.c.api('sessions/'+a.id+'/turn',{text:'queued follow-up',permission:'read-only'});
    await stream.close();stream=null;const disconnectedAt=performance.now();
    await s.control({action:'resolve',threadId:b.threadId,tag:'old'});
    await s.control({action:'complete',threadId:a.threadId,text:'first task completed while offline'});
    await s.control({action:'complete',threadId:a.threadId,text:'queued task completed while offline'});
    await s.control({action:'late-delta',threadId:a.threadId});
    await s.control({action:'approval',threadId:b.threadId,tag:'new'});
    await s.c.api('sessions/'+b.id+'/queue/add',{text:'retained queue during disconnect'});
    while(performance.now()-disconnectedAt<65000)await delay(Math.max(1,65000-(performance.now()-disconnectedAt)));result.gapMs=performance.now()-disconnectedAt;assert.ok(result.gapMs>=65000);
    const before=await logs(s.capture);assert.equal(count(before,'turn/start'),2);assert.equal(count(before,'thread/queue/add'),2);
    const reconnected=await connection(s.host);assert.equal(reconnected.boot.state.sessions.find(row=>row.id===a.id).running,false);assert.equal(reconnected.boot.state.sessions.find(row=>row.id===b.id).running,true);
    stream=await events(s.host,reconnected.headers);const sync=await stream.next('approvals-sync');assert.equal(sync.requests.length,1);assert.notEqual(sync.requests[0].id,old.id);assert.match(sync.requests[0].params.questions[0].question,/new/);assert.equal((await stream.next('approval')).request.id,sync.requests[0].id);
    const state=await reconnected.api('state'),historyA=await reconnected.api('sessions/'+a.id),historyB=await reconnected.api('sessions/'+b.id),queueA=await reconnected.api('sessions/'+a.id+'/queue'),queueB=await reconnected.api('sessions/'+b.id+'/queue');
    assert.equal(state.sessions.find(row=>row.id===a.id).running,false);assert.equal(historyA.running,false);assert.equal(historyB.running,true);assert.deepEqual(queueA.queue,[]);assert.equal(queueB.queue.length,1);assert.match(queueB.queue[0].input[0].text,/retained queue/);assert.equal(historyB.queue[0].id,queueB.queue[0].id);
    const answers=historyA.items.filter(row=>row.type==='agentMessage');assert.deepEqual(answers.map(row=>row.text),['first task completed while offline','queued task completed while offline']);assert.equal(new Set(historyA.items.map(row=>row.id)).size,historyA.items.length);assert.ok(!JSON.stringify(historyA.items).includes('MUST_NOT_DUPLICATE'));
    assert.equal((await reconnected.api('approvals/'+old.id,{allow:false})).code,'APPROVAL_NOT_FOUND');
    for(let i=0;i<2;i++)await reconnected.api('sessions/'+a.id);
    const after=await logs(s.capture);assert.equal(count(after,'turn/start'),2);assert.equal(count(after,'thread/queue/add'),2);assert.equal(after.filter(row=>row.type==='turn-created').length,3);assert.equal(after.filter(row=>row.type==='fixture-error').length,0);
    assert.ok(after.filter(row=>row.type==='rpc'&&row.method==='thread/read').every(row=>row.includeTurns===false));
    Object.assign(result,{ok:true,nativeTurnStart:2,nativeCreatedTurns:3,nativeQueuedStarts:1,queueAdds:2,recoveredHistoryItems:historyA.items.length,recoveredAgentMessages:answers.length,recoveredPendingApprovals:sync.requests.length,oldApprovalRemoved:true,remainingQueue:queueB.queue.length,providerRequests:0});
   }finally{results.push(result);await stream?.close();await s.host.close();await rm(s.directory,{recursive:true,force:true});}
  }),
  t.test('short reconnect clears resolved authority and repeated supplemental reads never start a turn',{timeout:15000},async()=>{
   const s=await setup();let stream;const result={name:'short-authority-recovery',ok:false};
   try{
    const session=await s.session();await s.c.api('sessions/'+session.id+'/turn',{text:'short fixture',permission:'read-only'});stream=await events(s.host,s.c.headers);await stream.next('approvals-sync');await s.control({action:'approval',threadId:session.threadId,tag:'removed'});const old=(await stream.next('approval')).request;await stream.close();stream=null;
    await s.control({action:'resolve',threadId:session.threadId,tag:'removed'});await s.control({action:'complete',threadId:session.threadId,text:'short completed'});
    for(let i=0;i<3;i++){const client=await connection(s.host);stream=await events(s.host,client.headers);assert.deepEqual((await stream.next('approvals-sync')).requests,[]);const history=await client.api('sessions/'+session.id);assert.equal(history.running,false);assert.equal(history.items.filter(row=>row.type==='agentMessage').length,1);assert.equal(history.items.find(row=>row.type==='agentMessage').text,'short completed');await stream.close();stream=null;}
    assert.equal((await s.c.api('approvals/'+old.id,{allow:false})).code,'APPROVAL_NOT_FOUND');const captured=await logs(s.capture);assert.equal(count(captured,'turn/start'),1);assert.equal(captured.filter(row=>row.type==='turn-created').length,1);Object.assign(result,{ok:true,reconnects:3,nativeTurnStart:1,recoveredPendingApprovals:0,recoveredAgentMessages:1,providerRequests:0});
   }finally{results.push(result);await stream?.close();await s.host.close();await rm(s.directory,{recursive:true,force:true});}
  }),
  t.test('default 45-second transport watchdog times out a real silent socket and releases its reader',{timeout:65000},async()=>{
   const sockets=new Set(),observed={cancelled:0,released:0},result={name:'default-45-second-watchdog',ok:false,transportModule:'source src/lib/event-stream.js'};
   let responseClosed=false;const server=http.createServer((request,response)=>{response.once('close',()=>{responseClosed=true;});response.writeHead(200,{'content-type':'text/event-stream'});response.flushHeaders();});
   server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const began=Date.now();
   try{
    await assert.rejects(readEventStream(async signal=>{observed.signal=signal;const response=await fetch(`http://127.0.0.1:${server.address().port}/silent`,{signal});observed.response=response;const get=response.body.getReader.bind(response.body);response.body.getReader=()=>{const reader=get();return{read:()=>reader.read(),cancel:()=>{observed.cancelled++;return reader.cancel();},releaseLock:()=>{observed.released++;reader.releaseLock();}};};return response;},()=>assert.fail('silent socket emitted an event')),{code:'EVENTS_IDLE_TIMEOUT'});
    result.elapsedMs=Date.now()-began;assert.ok(result.elapsedMs>=44000&&result.elapsedMs<60000);assert.equal(observed.signal.aborted,true);assert.equal(observed.cancelled,1);assert.equal(observed.released,1);assert.equal(observed.response.body.locked,false);await until(()=>responseClosed,{timeout:3000});
    Object.assign(result,{ok:true,defaultTimeoutMs:45000,readerCancelled:observed.cancelled,readerReleased:observed.released,bodyUnlocked:true,socketResponseClosed:true});
   }finally{results.push(result);for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));}
  })
 ]);}finally{if(process.env.DSH_STREAM_RECOVERY_RESULT)await writeFile(process.env.DSH_STREAM_RECOVERY_RESULT,JSON.stringify({appRoot:appRoot??'source',fixture,startedAt,finishedAt:new Date().toISOString(),cases:results},null,2)+'\n',{mode:0o600});}
});
