import readline from 'node:readline';
import {appendFileSync,readFileSync} from 'node:fs';

const threads=new Map(),pending=new Map();let sequence=0,requestSequence=8100,controlOffset=0,stopping=false;
const send=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\n');
function capture(value){if(process.env.DSH_RECOVERY_CAPTURE)appendFileSync(process.env.DSH_RECOVERY_CAPTURE,JSON.stringify({at:Date.now(),...value})+'\n');}
const identity=thread=>({thread:{id:thread.id,cwd:thread.cwd,turns:[]},model:thread.model,modelProvider:thread.modelProvider});
const active=thread=>thread.turns.findLast(turn=>turn.status==='inProgress');
function begin(thread,input,source){
  const turn={id:'recovery-turn-'+ ++sequence,status:'inProgress',itemsView:'full',items:[],startedAt:Math.floor(Date.now()/1000),completedAt:null};thread.turns.push(turn);
  const user={id:turn.id+'-user',type:'userMessage',content:input};turn.items.push(user);
  capture({type:'turn-created',source,threadId:thread.id,turnId:turn.id});
  send({method:'turn/started',params:{threadId:thread.id,turn:{...turn,items:[]}}});
  send({method:'item/completed',params:{threadId:thread.id,turnId:turn.id,item:user}});return turn;
}
function nextQueued(thread){if(stopping||active(thread)||!thread.queue.length)return;const row=thread.queue.shift();send({method:'thread/queue/changed',params:{threadId:thread.id}});begin(thread,row.input,'native-queue');}
function finish(thread,text='completed offline',status='completed'){
  const turn=active(thread);if(!turn)return;
  const item={id:turn.id+'-assistant',type:'agentMessage',text,status:'completed'};turn.items.push(item);turn.status=status;turn.completedAt=Math.floor(Date.now()/1000);
  send({method:'item/completed',params:{threadId:thread.id,turnId:turn.id,item}});
  send({method:'turn/completed',params:{threadId:thread.id,turn:{...turn}}});capture({type:'turn-finished',threadId:thread.id,turnId:turn.id,status});
  if(status==='completed')nextQueued(thread);
}
function issue(thread,tag){
  const turn=active(thread);if(!turn)return;
  const id=++requestSequence;pending.set(id,{threadId:thread.id,turnId:turn.id,tag});
  send({id,method:'item/tool/requestUserInput',params:{threadId:thread.id,turnId:turn.id,itemId:'approval-item-'+id,isBlocking:true,autoResolutionMs:null,questions:[{id:'choice',header:'Choice',question:'Recovery fixture '+tag,isOther:false,isSecret:false,options:[{label:'Continue',description:'Fixture only'}]}]}});
  capture({type:'approval-issued',id,threadId:thread.id,turnId:turn.id,tag});
}
function applyControl(command){
  const thread=threads.get(command.threadId);if(!thread)throw Error('UNKNOWN_OWN_THREAD');
  if(command.action==='approval')issue(thread,command.tag??'pending');
  else if(command.action==='resolve'){
    for(const [id,row]of pending)if(row.threadId===thread.id&&(!command.tag||row.tag===command.tag)){pending.delete(id);send({method:'serverRequest/resolved',params:{threadId:thread.id,requestId:id}});capture({type:'approval-native-resolved',id,tag:row.tag});}
  }else if(command.action==='complete')finish(thread,command.text??'completed offline');
  else if(command.action==='late-delta'){
    const turn=thread.turns.findLast(row=>row.status==='completed'),item=turn?.items.findLast(row=>row.type==='agentMessage');if(item)send({method:'item/agentMessage/delta',params:{threadId:thread.id,turnId:turn.id,itemId:item.id,delta:'MUST_NOT_DUPLICATE'}});
  }else throw Error('UNKNOWN_CONTROL');
  capture({type:'control-applied',controlId:command.id,action:command.action});
}
const controlTimer=setInterval(()=>{
  if(!process.env.DSH_RECOVERY_CONTROL)return;
  try{const text=readFileSync(process.env.DSH_RECOVERY_CONTROL,'utf8');const lines=text.split('\n');if(lines.at(-1)!=='')return;for(;controlOffset<lines.length-1;controlOffset++)applyControl(JSON.parse(lines[controlOffset]));}
  catch(error){if(error.code!=='ENOENT')capture({type:'fixture-error',code:error.message});}
},20);
for await(const line of readline.createInterface({input:process.stdin})){
  const message=JSON.parse(line),{id,method,params={}}=message;
  if(!method){
    const request=pending.get(id);if(request){pending.delete(id);capture({type:'approval-response',id,tag:request.tag,hasResult:Object.hasOwn(message,'result')});if(Object.hasOwn(message,'result'))finish(threads.get(request.threadId),'approval answered once');}continue;
  }
  capture({type:'rpc',method,id:id??null,threadId:params.threadId??null,includeTurns:params.includeTurns??null});
  if(method==='initialized')continue;
  if(method==='initialize'){send({id,result:{codexHome:process.env.CODEX_HOME,userAgent:'isolated-stream-recovery-fixture'}});continue;}
  if(method==='thread/start'){const thread={...params,id:'recovery-thread-'+ ++sequence,turns:[],queue:[]};threads.set(thread.id,thread);send({id,result:identity(thread)});continue;}
  if(method==='thread/resume'){send({id,result:identity(threads.get(params.threadId))});continue;}
  if(method==='thread/read'){const thread=threads.get(params.threadId);send({id,result:{thread:{id:thread.id,cwd:thread.cwd,status:{type:active(thread)?'active':'idle'},...(params.includeTurns?{turns:thread.turns}:{})}}});continue;}
  if(method==='thread/items/list'){
    const thread=threads.get(params.threadId),rows=thread.turns.flatMap(turn=>turn.items.map(item=>({turnId:turn.id,item,startedAtMs:turn.startedAt*1000,completedAtMs:turn.completedAt?turn.completedAt*1000:null})));
    if(params.sortDirection!=='asc')rows.reverse();const offset=params.cursor?Number(params.cursor):0,limit=params.limit??20;send({id,result:{data:rows.slice(offset,offset+limit),nextCursor:offset+limit<rows.length?String(offset+limit):null,backwardsCursor:null}});continue;
  }
  if(method==='thread/turns/list'){const rows=[...threads.get(params.threadId).turns];if(params.sortDirection!=='asc')rows.reverse();send({id,result:{data:rows.slice(0,params.limit??10).map(turn=>params.itemsView==='notLoaded'?{...turn,items:[],itemsView:'notLoaded'}:turn),nextCursor:null,backwardsCursor:null}});continue;}
  if(method==='turn/start'){const thread=threads.get(params.threadId);const turn=begin(thread,params.input,'turn/start');send({id,result:{turn:{id:turn.id,status:turn.status,items:[],itemsView:'notLoaded'}}});continue;}
  if(method==='turn/interrupt'){const thread=threads.get(params.threadId);for(const [key,row]of pending)if(row.threadId===thread.id){pending.delete(key);send({method:'serverRequest/resolved',params:{threadId:thread.id,requestId:key}});}send({id,result:{}});finish(thread,'interrupted by owner','interrupted');continue;}
  if(method.startsWith('thread/queue/')){
    const thread=threads.get(params.threadId),action=method.slice('thread/queue/'.length);let result;
    if(action==='list')result={data:thread.queue,nextCursor:null};
    else if(action==='add'){const row={id:'queued-'+ ++sequence,threadId:thread.id,input:params.input,clientUserMessageId:params.clientUserMessageId,createdAt:new Date().toISOString()};thread.queue.push(row);result={queuedSubmission:row};}
    else if(action==='delete'){const previous=thread.queue.length;thread.queue=thread.queue.filter(row=>row.id!==params.queuedSubmissionId);result={deleted:previous!==thread.queue.length};}
    else if(action==='update'){const row=thread.queue.find(row=>row.id===params.queuedSubmissionId);row.input=params.input;result={queuedSubmission:row};}
    else if(action==='reorder'){thread.queue=params.queuedSubmissionIds.map(key=>thread.queue.find(row=>row.id===key));result={};}
    else if(action==='start'){const index=params.queuedSubmissionId?thread.queue.findIndex(row=>row.id===params.queuedSubmissionId):0;const [row]=thread.queue.splice(index,1);const turn=begin(thread,row.input,'native-queue');result={turn};}
    else result={};send({id,result});if(action!=='list')send({method:'thread/queue/changed',params:{threadId:thread.id}});continue;
  }
  if(method==='mcpServerStatus/list'){send({id,result:{data:[],nextCursor:null}});continue;}
  if(method==='skills/list'){send({id,result:{data:[]}});continue;}
  send({id,result:{}});
}
stopping=true;clearInterval(controlTimer);
