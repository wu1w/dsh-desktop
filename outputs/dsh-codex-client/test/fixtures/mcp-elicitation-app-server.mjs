import readline from 'node:readline';import {appendFileSync} from 'node:fs';import {createHash} from 'node:crypto';
const threads=new Map(),pending=new Map();let sequence=0;
const send=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\n');
const identity=thread=>({thread:{id:thread.id,cwd:thread.cwd,turns:[]},model:thread.model,modelProvider:thread.modelProvider});
for await(const line of readline.createInterface({input:process.stdin})){
 const message=JSON.parse(line),{id,method,params={}}=message;
 if(!method){const turn=pending.get(id);if(turn){pending.delete(id);const result=message.result;if(process.env.DSH_MCP_ELICITATION_CAPTURE)appendFileSync(process.env.DSH_MCP_ELICITATION_CAPTURE,JSON.stringify({nativeId:id,action:result?.action,resultHash:createHash('sha256').update(JSON.stringify(result)).digest('hex')})+'\n');send({method:'serverRequest/resolved',params:{threadId:turn.threadId,requestId:id}});send({method:'turn/completed',params:{threadId:turn.threadId,turn:{id:turn.turnId,status:'completed',items:[],itemsView:'notLoaded'}}});}continue;}
 if(method==='initialized')continue;
 if(method==='initialize'){send({id,result:{codexHome:process.env.CODEX_HOME,userAgent:'isolated-mcp-elicitation-fixture'}});continue;}
 if(method==='thread/start'){const thread={...params,id:'owned-mcp-thread-'+ ++sequence};threads.set(thread.id,thread);send({id,result:identity(thread)});continue;}
 if(method==='thread/resume'){send({id,result:identity(threads.get(params.threadId))});continue;}
 if(method==='thread/read'){const thread=threads.get(params.threadId);send({id,result:{thread:{id:thread.id,cwd:thread.cwd,turns:[],status:{type:'idle'}}}});continue;}
 if(['thread/items/list','thread/turns/list','thread/queue/list'].includes(method)){send({id,result:{data:[],nextCursor:null}});continue;}
 if(method==='turn/start'){
  const turnId='owned-mcp-turn-'+ ++sequence;send({id,result:{turn:{id:turnId,status:'inProgress',items:[],itemsView:'notLoaded'}}});send({method:'turn/started',params:{threadId:params.threadId,turn:{id:turnId,status:'inProgress',items:[]}}});const requestId=9000+sequence;pending.set(requestId,{threadId:params.threadId,turnId});send({id:requestId,method:'mcpServer/elicitation/request',params:{threadId:params.threadId,turnId,serverName:'owned-fixture',mode:'form',_meta:null,message:'Owned form fixture',requestedSchema:{type:'object',properties:{count:{type:'integer',minimum:0},flag:{type:'boolean'},text:{type:'string'}},required:['count','flag']}}});continue;
 }
 if(method==='turn/interrupt'){send({id,result:{}});continue;}
 send({id,result:{}});
}
