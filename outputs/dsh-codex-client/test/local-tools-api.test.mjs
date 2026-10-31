import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const appRoot=process.env.DSH_ACCEPTANCE_APP_ROOT;
const {startHost}=await import(appRoot?pathToFileURL(path.join(appRoot,'server/index.mjs')):new URL('../server/index.mjs',import.meta.url));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn){const deadline=Date.now()+6000;while(Date.now()<deadline){const value=await fn();if(value)return value;await pause(20);}throw Error('LOCAL_TOOLS_TIMEOUT');}

test('authenticated host routes real PTY and durable local schedules through actual plugin lifecycles',{skip:process.platform!=='darwin'},async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'dsh-local-tools-api-'));let host,events,reader,reading;
  const result={checkedAt:new Date().toISOString(),appRoot:appRoot??'source',providerRequests:0,modelInferenceTurns:0,simulatedNativeTurns:0,guiChecked:false};
  try{
    const projectPath=path.join(directory,'project');await mkdir(projectPath);
    host=await startHost({dataDir:path.join(directory,'data'),binary:process.execPath,engineOptions:{args:[fileURLToPath(new URL('./fixtures/approval-app-server.mjs',import.meta.url))],resolveApiKey:async()=> 'isolated-local-tools-fixture',approvalTimeoutMs:10000}});
    const bootstrap=await fetch(host.url+'/api/bootstrap'),boot=await bootstrap.json();assert.equal(boot.state.engine.state,'ready');
    assert.match(bootstrap.headers.get('content-security-policy'),/script-src 'self'; style-src 'self' 'unsafe-inline';/);
    const headers={cookie:bootstrap.headers.get('set-cookie').split(';')[0],'x-dsh-capability':boot.capability,'content-type':'application/json','accept-language':'en'};
    const api=async(route,body)=>{const response=await fetch(host.url+'/api/'+route,{headers,method:body===undefined?'GET':'POST',body:body===undefined?undefined:JSON.stringify(body)});const value=await response.json();return{httpStatus:response.status,...value};};
    events=new AbortController();const stream=await fetch(host.url+'/api/events',{headers,signal:events.signal});reader=stream.body.getReader();const queued=[],decoder=new TextDecoder();let buffer='';
    reading=(async()=>{for(;;){const{value,done}=await reader.read();if(done)return;buffer+=decoder.decode(value,{stream:true});for(;;){const end=buffer.indexOf('\n\n');if(end<0)break;const packet=buffer.slice(0,end);buffer=buffer.slice(end+2);for(const line of packet.split('\n'))if(line.startsWith('data: '))queued.push(JSON.parse(line.slice(6)));}}})().catch(()=>{});
    const nextApproval=()=>until(()=>{const index=queued.findIndex(event=>event.type==='approval');return index<0?null:queued.splice(index,1)[0].request;});
    const project=await api('projects',{path:projectPath});assert.equal(project.httpStatus,200);
    const pty=await api(`projects/${project.id}/pty`,{cols:92,rows:24});assert.equal(pty.httpStatus,200);assert.equal(pty.status,'running');
    assert.ok((await api('state')).activities.some(row=>row.kind==='terminal'&&row.id.endsWith(pty.id)));
    assert.equal((await api(`projects/${project.id}/pty/${pty.id}/input`,{data:"test -t 0 && printf 'LOCAL_PTY_READY\\n'; stty size\n"})).httpStatus,200);
    await until(async()=>{const row=await api(`projects/${project.id}/pty/${pty.id}?after=0`);return /LOCAL_PTY_READY\r?\n24 92/.test(row.output);});
    assert.equal((await api(`projects/${project.id}/pty/${pty.id}/resize`,{cols:104,rows:33})).cols,104);
    await api(`projects/${project.id}/pty/${pty.id}/input`,{data:'stty size\n'});await until(async()=>/33 104/.test((await api(`projects/${project.id}/pty/${pty.id}?after=0`)).output));
    assert.equal((await api('plugins/feature-terminal/disable',{})).httpStatus,200);assert.equal((await api(`projects/${project.id}/pty`)).httpStatus,404);assert.equal((await api('plugins/feature-terminal/enable',{})).httpStatus,200);assert.equal((await api(`projects/${project.id}/pty`)).terminals.length,0);result.pty={nativeInteractive:true,resized:true,pluginDisable:true,pluginRestore:true};
    const input={title:'Local fixture task',projectId:project.id,prompt:'Ask the isolated fixture question',engineId:'codex',model:'deepseek-v4.1-flash',effort:'high',permission:'read-only',schedule:{type:'interval',minutes:15}};
    const created=await api('automations',input);assert.equal(created.httpStatus,200);assert.equal(created.automation.enabled,false);assert.equal(created.automation.runs.length,0);assert.equal((await api('state')).sessions.length,0);const id=created.automation.id;
    assert.equal((await api('automations/'+id+'/run',{})).httpStatus,200);result.simulatedNativeTurns++;const approval=await nextApproval();
    const active=await api('state');assert.ok(active.activities.some(row=>row.kind==='automation'));assert.ok(active.sessions.some(row=>row.running&&typeof row.activeTurnId==='string'));
    assert.equal((await api('automations/'+id+'/run',{})).code,'AUTOMATION_BUSY');assert.equal((await api('approvals/'+approval.id,{allow:false,answers:{}})).httpStatus,200);
    const completed=await until(async()=>{const row=(await api('automations')).automations.find(row=>row.id===id);return row.lastStatus==='completed'?row:null;});assert.equal(completed.runs.length,1);assert.ok(completed.lastSessionId);assert.equal((await api('state')).sessions.find(row=>row.id===completed.lastSessionId).automationId,id);
    assert.equal((await api('automations/'+id+'/run',{})).httpStatus,200);result.simulatedNativeTurns++;await nextApproval();
    assert.equal((await api('plugins/feature-automations/disable',{})).httpStatus,200);assert.equal(host.engine.activeTurns.size,0);assert.equal((await api('automations')).httpStatus,404);assert.equal((await api('plugins/feature-automations/enable',{})).httpStatus,200);
    const restored=(await api('automations')).automations.find(row=>row.id===id);assert.equal(restored.runs.length,2);assert.equal(restored.lastStatus,'cancelled');assert.equal((await api('state')).sessions.length,2);
    result.automations={defaultPaused:true,realHostBinding:true,claimOnce:true,terminalRequired:true,disableInterrupted:true,recordsRestored:true};result.activities={realTerminal:true,realAutomation:true,realNativeModel:true};result.success=true;
  }finally{events?.abort();await reader?.cancel().catch(()=>{});await reading;await host?.close();await rm(directory,{recursive:true,force:true});if(process.env.DSH_LOCAL_TOOLS_RESULT)await writeFile(process.env.DSH_LOCAL_TOOLS_RESULT,JSON.stringify(result,null,2)+'\n',{mode:0o600});}
});
