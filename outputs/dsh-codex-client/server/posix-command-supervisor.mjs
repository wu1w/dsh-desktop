import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const owned=new WeakMap();
// No caller retains a numeric process-group capability. Only the still-live
// detached supervisor may signal its own group, whose ID cannot be recycled
// while that supervisor exists. The IPC channel is not inherited by commands.
export function spawnPosixCommand(file,args,{cwd,env,graceMs=150,stdin='ignore',spawnProcess=spawn}={}){
 const token=randomUUID(),helper=fileURLToPath(import.meta.url);
 const child=spawnProcess(process.execPath,[helper,'--owned-command',token,String(graceMs),file,...args],{
  cwd,env:{...env,ELECTRON_RUN_AS_NODE:'1'},detached:true,windowsHide:true,stdio:[stdin,'pipe','pipe','ipc']
 });
 const state={token,result:null,exited:false};owned.set(child,state);
 child.on('message',message=>{if(message?.token===token&&message.type==='result')state.result=message;});
 child.once('exit',()=>{state.exited=true;});child.once('error',()=>{state.exited=true;});
 return child;
}
export function posixCommandResult(child,code,signal=null){
 const result=owned.get(child)?.result;
 return result?{code:result.code,signal:result.signal,errorCode:result.errorCode}:{code,signal};
}
export function requestPosixStop(child){
 const state=owned.get(child);
 // An exited supervisor is never replaced with a group lookup or child.kill.
 // A remaining inherited pipe can still make cleanup fail at the caller.
 if(!state||state.exited||!child.connected)return;
 child.send({type:'stop',token:state.token},()=>{});
}

function supervise(){
 const [, , ,token,graceText,file,...args]=process.argv;
 const grace=Number(graceText);
 if(process.platform==='win32'||!process.send||!process.connected||!token||!file||!Number.isFinite(grace)||grace<0||grace>60000)process.exit(125);
 let stopping=false;
 // Stay alive through TERM so our own process-group ID remains reserved until
 // the final SIGKILL syscall, including when the shell has already exited.
 process.on('SIGTERM',()=>{});
 const stop=()=>{
  if(stopping)return;stopping=true;
  process.kill(-process.pid,'SIGTERM');
  setTimeout(()=>process.kill(-process.pid,'SIGKILL'),grace);
 };
 process.on('message',message=>{if(message?.token===token&&message.type==='stop')stop();});
 process.on('disconnect',stop);
 const environment={...process.env};delete environment.ELECTRON_RUN_AS_NODE;
 const command=spawn(file,args,{env:environment,stdio:['pipe','inherit','inherit']});
 command.stdin.on('error',()=>{});process.stdin.on('error',()=>{});process.stdin.pipe(command.stdin);
 const report=result=>{if(process.connected)process.send({type:'result',token,...result},()=>stop());else stop();};
 command.once('error',error=>report({code:125,signal:null,errorCode:error.code}));
 command.once('exit',(code,signal)=>report({code,signal}));
}
if(process.argv[2]==='--owned-command'&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))supervise();
