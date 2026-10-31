import {randomUUID} from 'node:crypto';
import {validProgram} from '../shared/session-programs.js';
const fault=code=>Object.assign(new Error(code),{code});
const pending=run=>run&&['running','waiting','uncertain'].includes(run.status);
// Programs belong to a chat, so engine handoff, workspace-free chats and task
// recovery keep using the same persisted session and context.
export class SessionPrograms{
 constructor(host,{now=Date.now,tickMs=1000}={}){this.host=host;this.now=now;this.serial=Promise.resolve();this.closed=false;this.timer=setInterval(()=>void this.tick().catch(()=>{}),tickMs);this.timer.unref?.();}
 sequence(fn){const result=this.serial.then(()=>{if(this.closed)throw fault('HOST_STOPPING');return fn();});this.serial=result.catch(()=>{});return result;}
 async save(){try{await this.host.save();this.host.broadcastState();}catch(error){this.closed=true;clearInterval(this.timer);throw error;}}
 start(session,input){return this.sequence(async()=>{
   if(session.archived||session.channel||pending(session.runRecovery)||session.program?.status==='active')throw fault('PROGRAM_BUSY');
   const p={version:1,id:randomUUID(),kind:input.kind,objective:input.objective,status:'active',iterations:0,maxIterations:input.maxIterations??20,intervalMs:input.intervalMs??300000,nextRunAt:new Date(this.now()).toISOString(),runId:null,dispatching:false,permission:input.permission??'read-only',effort:input.effort??'high',reason:null};
   if(!validProgram(p))throw fault('INVALID_PROGRAM');
   session.program=p;await this.save();await this.advance(session);return {program:session.program};
 });}
 action(session,action){return this.sequence(async()=>{
   const p=session.program;if(!validProgram(p))throw fault('PROGRAM_NOT_FOUND');
   if(['pause','stop','complete'].includes(action)){
     p.status=action==='complete'?'completed':'paused';p.reason='user';p.nextRunAt=null;await this.save();
     if(p.runId===session.runRecovery?.id&&pending(session.runRecovery))await this.host.taskRecovery.stop(session);
   }else if(action==='resume'){
     if(pending(session.runRecovery))throw fault('PROGRAM_BUSY');p.status='active';p.reason=null;p.runId=null;p.dispatching=false;p.nextRunAt=new Date(this.now()).toISOString();if(p.iterations>=p.maxIterations)p.maxIterations=Math.min(1000,p.iterations+20);await this.save();await this.advance(session);
   }else throw fault('INVALID_PROGRAM');
   return {program:p};
 });}
 tick(){return this.sequence(async()=>{if(!this.host.hasFeature('feature-chat'))return;for(const session of this.host.state.sessions)if(session.program?.status==='active')await this.advance(session);});}
 async advance(session){
   const p=session.program;if(this.closed||p.status!=='active'||!this.host.hasFeature('feature-chat'))return;
   if(session.archived){p.status='paused';p.reason='archived';p.nextRunAt=null;await this.save();return;}
   if(p.dispatching&&!p.runId){p.status='blocked';p.reason='unverified';p.nextRunAt=null;await this.save();return;}
   if(p.runId){
     const run=session.runRecovery;
     if(!run||run.id!==p.runId){p.status='paused';p.reason='other_turn';p.runId=null;await this.save();return;}
     if(pending(run))return;
     if(run.status!=='completed'){p.status='blocked';p.reason=run.userStopped?'user':'run_failed';p.nextRunAt=null;await this.save();return;}
     if(p.kind==='goal'){
       let answer;try{const history=await this.host.readTranscript(session,this.host.state.preferences.locale);answer=history.items.filter(i=>i.turnId===run.turnId&&i.type==='agentMessage'&&i.phase!=='commentary').map(i=>i.text??'').join('\n');}catch{return;}
       // Completion is a separate, explicit executor outcome. An ordinary
       // end-of-turn does not silently mark the objective achieved.
       if(answer.includes('[DSH_GOAL_DONE:'+p.id+']')){p.status='completed';p.nextRunAt=null;}
       else if(answer.includes('[DSH_GOAL_BLOCKED:'+p.id+']')){p.status='blocked';p.reason='needs_input';p.nextRunAt=null;}
       else if(p.iterations>=p.maxIterations){p.status='paused';p.reason='limit';p.nextRunAt=null;}
       else p.nextRunAt=new Date(this.now()+2000).toISOString();
     }else p.nextRunAt=new Date(this.now()+p.intervalMs).toISOString();
     p.runId=null;p.dispatching=false;await this.save();return;
   }
   if(p.nextRunAt&&Date.parse(p.nextRunAt)>this.now())return;
   let engine;try{engine=this.host.requireEngine(session);if(engine.activeTurns.has(session.id)||pending(session.runRecovery)||(await this.host.readQueue(session)).length)return;}catch{return;}
   p.dispatching=true;await this.save();
   const instruction=p.kind==='goal'?`Pursue the following objective using the existing conversation. Work until verified complete. Do not repeat completed work. When achieved, end the final response with [DSH_GOAL_DONE:${p.id}]. If progress requires user input or cannot safely continue, end with [DSH_GOAL_BLOCKED:${p.id}]. Otherwise report concrete progress and the remaining next step. Objective: ${JSON.stringify(p.objective)}`:`Perform this scheduled check once, using the existing conversation. Do not create another schedule. Report findings concisely. Prompt: ${JSON.stringify(p.objective)}`;
   const text=p.objective+'\n[DSH_PROGRAM_INSTRUCTIONS]\n'+instruction+'\n[/DSH_PROGRAM_INSTRUCTIONS]';
   try{await this.host.taskRecovery.start(session,[{type:'text',text,text_elements:[]}],{sandbox:p.permission,effort:p.effort},async()=>{
     if(this.closed||p.status!=='active')throw fault('HOST_STOPPING');p.runId=session.runRecovery.id;p.iterations++;p.dispatching=false;p.nextRunAt=null;await this.save();return engine.startTurn(session.id,[{type:'text',text,text_elements:[]}],{sandbox:p.permission,effort:p.effort});
   });}catch{if(!p.runId){p.status='blocked';p.reason='unverified';p.dispatching=false;await this.save();}}
 }
 async close(){clearInterval(this.timer);this.closed=true;await this.serial;}
}
