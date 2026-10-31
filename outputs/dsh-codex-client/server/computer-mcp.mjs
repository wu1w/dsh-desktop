import {computerTool,computerText} from '../shared/computer-tool.js';
// A private, stateless Streamable HTTP MCP endpoint. It never accepts browser-origin requests.
export async function handleComputerMcp(request,response,{bearer,computer}){
 const reply=(body,status=200)=>{response.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});response.end(body==null?'':JSON.stringify(body));};
 if(request.headers.origin||request.headers.authorization!==`Bearer ${bearer}`){reply({error:'FORBIDDEN'},403);return;}
 if(request.method==='GET'){reply(null,405);return;}
 if(request.method!=='POST'){reply(null,405);return;}
 let raw='';for await(const chunk of request){raw+=chunk;if(Buffer.byteLength(raw)>100000){reply(null,413);return;}}
 let message;try{message=JSON.parse(raw);}catch{reply({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}});return;}
 if(message.id===undefined){reply(null,202);return;}
 let result;
 try{
  if(message.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'dsh-computer',version:'1.0.0'}};
  else if(message.method==='ping')result={};
  else if(message.method==='tools/list')result={tools:[{...computerTool,inputSchema:{...computerTool.inputSchema,properties:{...computerTool.inputSchema.properties,sessionToken:{type:'string',description:'Use the exact DSH Computer Use token from the current developer instructions.'}},required:['action','sessionToken']}}]};
  else if(message.method==='tools/call'){
   if(message.params?.name!==computerTool.name)throw Error('COMPUTER_INVALID_INPUT');
   const {sessionToken,...input}=message.params?.arguments??{};
   const nativeId=computer.idForToken(sessionToken);if(!nativeId)throw Error('COMPUTER_NOT_CONNECTED');
   const value=await computer.engineCall(nativeId,input);result={content:[{type:'text',text:computerText(value)}]};
  }else{reply({jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'Method not found'}});return;}
 }catch(error){result={isError:true,content:[{type:'text',text:String(error.code??error.message).slice(0,200)}]};}
 reply({jsonrpc:'2.0',id:message.id,result});
}
