import test from 'node:test';import assert from 'node:assert/strict';
import {transcriptTurns,processBlocks,activityKinds,elapsedText} from '../src/lib/transcript-turns.js';
import {translator} from '../src/i18n.js';import {SessionHistory} from '../server/session-history.mjs';import {normalizeItem,historyItems} from '../server/normalize.mjs';
const item=(id,type,extra={})=>({id,type,turnId:'one',text:id,...extra});
const rows=[item('question','userMessage'),item('reason','reasoning',{text:''}),item('progress','agentMessage',{phase:'commentary'}),item('read','commandExecution',{command:'cat README.md'}),item('reason2','reasoning'),item('command','commandExecution',{command:'npm test'}),item('answer','agentMessage',{phase:'final_answer'})];
test('one response retains only the final answer outside one collapsed process, omitting empty reasoning',()=>{
 const result=transcriptTurns(rows),turn=result[1];assert.equal(result.length,2);assert.equal(result[0].kind,'user');assert.deepEqual(turn.answers.map(x=>x.id),['answer']);assert.deepEqual(turn.process.map(x=>x.id),['progress','read','reason2','command']);assert.deepEqual(processBlocks(turn.process).map(x=>x.kind),['commentary','activity']);assert.deepEqual(activityKinds(turn.process.slice(1)),['read','command']);
});
test('legacy multi-block final answers stay together and intermediate prose collapses only when followed by work',()=>{
 const result=transcriptTurns([item('u','userMessage'),item('intro','agentMessage'),item('tool','fileChange'),item('answer1','agentMessage'),item('answer2','agentMessage')])[1];assert.deepEqual(result.answers.map(x=>x.id),['answer1','answer2']);assert.deepEqual(result.process.map(x=>x.id),['intro','tool']);
});
test('failure stays visible and explicit commentary is never falsely promoted to an answer',()=>{
 const turn=transcriptTurns([item('u','userMessage'),item('comment','agentMessage',{phase:'commentary'}),item('error','error',{turnStatus:'failed'})])[1];assert.deepEqual(turn.answers.map(x=>x.id),['error']);assert.equal(turn.status,'failed');assert.equal(turn.process[0].id,'comment');
});
test('multiple turns, missing users on paged history and repeated steer users never share disclosure identity',()=>{
 const second=rows.map(x=>({...x,id:'second-'+x.id,turnId:'two'})),session={activeTurnId:'two',startedAt:'2026-01-01T00:00:00Z'};const turns=transcriptTurns([...rows,...second],session,true).filter(x=>x.kind==='turn');assert.equal(turns.length,2);assert.deepEqual(turns.map(x=>x.active),[false,true]);assert.equal(turns[0].startedAt,null);assert.equal(turns[1].startedAt,Date.parse(session.startedAt));assert.equal(transcriptTurns(rows.slice(3))[0].id,turns[0].id);
 const steered=transcriptTurns([...rows,item('steer','userMessage'),item('later','agentMessage')]).filter(x=>x.kind==='turn');assert.equal(new Set(steered.map(x=>x.id)).size,2);
});
test('active empty turn has one progress header and stopped recovery cannot look active',()=>{
 assert.equal(transcriptTurns([],{activeTurnId:'turn'},true)[0].active,true);assert.equal(transcriptTurns(rows,{runRecovery:{turnId:'one',status:'interrupted'}},false)[1].active,false);assert.equal(transcriptTurns(rows,{runRecovery:{turnId:'one',status:'interrupted'}},false)[1].status,'interrupted');
});
test('elapsed time is localized from real turn clocks, never made up for old partial history',()=>{
 for(const locale of ['zh-CN','en']){const t=translator(locale);assert.equal(elapsedText(0,410000,locale,t),t('elapsedMinutes',{minutes:'6',seconds:'50'}));assert.equal(elapsedText(null,410000,locale,t),null);assert.equal(elapsedText(100,0,locale,t),null);assert.ok(!elapsedText(0,3661000,locale,t).includes('undefined'));}
});
test('live timing and completion survive incremental events without mutating previous snapshots',()=>{
 const h=new SessionHistory({}),turn={id:'one',status:'inProgress',startedAt:1767225600};h.notification('s',{method:'turn/started',params:{turn}},'/tmp');h.notification('s',{method:'item/started',params:{turnId:'one',item:{id:'a',type:'reasoning',summary:['actual thought']}}},'/tmp');const before=h.transcripts.get('s');assert.equal(before[0].turnStartedAtMs,1767225600000);
 h.notification('s',{method:'turn/completed',params:{turn:{...turn,status:'completed',completedAt:1767226010}}},'/tmp');const after=h.transcripts.get('s');assert.equal(after[0].turnCompletedAtMs,1767226010000);assert.equal(after[0].turnStatus,'completed');assert.equal(after[0].running,false);assert.equal(before[0].turnCompletedAtMs,undefined);
});
test('history enrichment obtains bounded turn metadata without confusing item and turn timestamps',async()=>{
 const h=new SessionHistory({}),calls=[],engine={activeTurns:new Map(),readSession:async()=>({}),listSessionItems:async()=>({data:[{turnId:'one',startedAtMs:9,completedAtMs:10,item:{id:'a',type:'agentMessage',text:'answer'}}]}),listSessionTurns:async(id,args)=>{calls.push(args);return{data:[{id:'one',status:'completed',startedAt:1767225600,completedAt:1767226010}]};}};
 const response=await h.initial({id:'s'},engine,'/tmp','en');assert.equal(response.items[0].startedAtMs,9);assert.equal(response.items[0].turnCompletedAtMs-response.items[0].turnStartedAtMs,410000);assert.deepEqual(calls,[{limit:50,sortDirection:'desc',itemsView:'notLoaded'}]);
 engine.listSessionTurns=async()=>{throw Error('optional timing failed');};assert.equal((await h.initial({id:'s'},engine,'/tmp','en')).items[0].text,'answer');
});
test('all engine reasoning formats and persisted ISO clocks retain actual data',()=>{
 assert.equal(normalizeItem({id:'r',type:'reasoning',text:'Claude actual reasoning'},'/tmp').text,'Claude actual reasoning');assert.equal(normalizeItem({id:'r',type:'reasoning',summary:[{text:'Codex summary'}]},'/tmp').text,'Codex summary');
 const row=historyItems({turns:[{id:'t',status:'completed',startedAt:'2026-01-01T00:00:00Z',completedAt:'2026-01-01T00:00:12Z',items:[{id:'a',type:'agentMessage',text:'Native answer'}]}]},'/tmp')[0];assert.equal(row.turnCompletedAtMs-row.turnStartedAtMs,12000);
});
