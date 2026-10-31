import {developmentTool} from '../shared/development-tool.js';
export async function handleDevelopmentMcp(request,response,{bearer,development}){
  const reply=(body,status=200)=>{response.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});response.end(body==null?'':JSON.stringify(body));};
  if(request.headers.origin||request.headers.authorization!==`Bearer ${bearer}`){reply({error:'FORBIDDEN'},403);return;}
  if(request.method!=='POST'){reply(null,405);return;}
  let raw='';for await(const chunk of request){raw+=chunk;if(Buffer.byteLength(raw)>300000){reply(null,413);return;}}
  let message;try{message=JSON.parse(raw);}catch{reply({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}});return;}
  if(!message||typeof message!=='object'||Array.isArray(message)){reply({jsonrpc:'2.0',id:null,error:{code:-32600,message:'Invalid request'}});return;}
  if(message.id===undefined){reply(null,202);return;}
  let result;
  try{
    if(message.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'dsh-development',version:'1.0.0'}};
    else if(message.method==='ping')result={};
    else if(message.method==='tools/list')result={tools:[{...developmentTool,inputSchema:{...developmentTool.inputSchema,properties:{...developmentTool.inputSchema.properties,sessionToken:{type:'string',description:'Exact DSH plugin development sessionToken from current instructions.'}},required:['action','sessionToken']}}]};
    else if(message.method==='tools/call'){
      if(message.params?.name!==developmentTool.name)throw Error('INVALID_REQUEST');
      const {sessionToken,...input}=message.params?.arguments??{},id=development.idForToken(sessionToken);
      if(!id)throw Error('PLUGIN_CHAT_INACTIVE');result={content:[{type:'text',text:JSON.stringify(await development.engineCall(id,input))}]};
    }else{reply({jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'Method not found'}});return;}
  }catch(error){result={isError:true,content:[{type:'text',text:String(error.code??error.message).slice(0,200)}]};}
  reply({jsonrpc:'2.0',id:message.id,result});
}
