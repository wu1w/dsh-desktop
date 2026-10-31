import {SessionPrograms} from '../session-programs.mjs';
import {randomUUID} from 'node:crypto';
import {realpath,stat} from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {projectFile,readProjectFile,writeProjectFile,listProjectFiles,saveAttachments} from '../files.mjs';
const fail=code=>{throw Object.assign(new Error(code),{code});};
export const manifest={id:'feature-chat',type:'feature',version:'0.1.0',name:{'zh-CN':'聊天与消息队列',en:'Chat and message queue'}};
export function apply(ctx,host){
const pending=new Set();const programs=new SessionPrograms(host);host.registerBeforeStop(()=>programs.close());ctx.effect(()=>()=>programs.close());
ctx.effect(()=>host.registerActivityProvider?.('chat-admission',()=>[...pending].map(id=>({id,kind:'unknown',count:1}))));
ctx.effect(()=>host.registerRoute({matches:(segments,method)=>segments[0]==='sessions',handle:async environment=>{
const incoming=environment.request.method==='POST';
const admission=incoming?randomUUID():null;if(admission)pending.add(admission);
try{

const {request,response,url,segments,body,json,locale}=environment;
const {state,save,broadcastState,getProject,getSession,getSessionWorkspace,ensureSessionWorkspace,requireEngine,readTranscript,readHistory,readQueue,sendQueue,turnInputs,transcripts,commands,getSelectedEngine}=host;
const integrations=host.integrations;
        if (segments[0] === 'sessions' && segments.length === 1 && request.method === 'POST') {
          const project = body.projectId==null?null:getProject(body.projectId); const e = requireEngine(); const id = randomUUID();
          const cwd=await ensureSessionWorkspace({id,projectId:project?.id??null});
          const requestedModel=body.model??'deepseek-v4.1-flash';if(!(state.models??[{id:'deepseek-v4.1-flash'}]).some(model=>model.id===requestedModel))fail('INVALID_REQUEST');
          const mapped = await e.createSession(id, { cwd, model:requestedModel });
          const session = { id, projectId: project?.id??null, engineId:getSelectedEngine(),kind:body.kind==='agent'?'agent':'chat',parentSessionId:body.parentSessionId&&state.sessions.some(s=>s.id===body.parentSessionId)?body.parentSessionId:null,model:mapped.model,instructionProfile:mapped.instructionProfile??null,title: typeof body.title === 'string' ? body.title.slice(0,100) : '', threadId: mapped.threadId, archived: false, pinned: false, createdAt:new Date().toISOString(), updatedAt: new Date().toISOString() };
          state.sessions.unshift(session); transcripts.set(id, []); await save(); broadcastState(); json(session); return;
        }
        if (segments[0] === 'sessions' && segments[1]) {
          const session = getSession(segments[1]); const project = getSessionWorkspace(session);
          if (segments.length === 2 && request.method === 'GET') { const transcript=await readTranscript(session,locale);if(session.unread){session.unread=false;void save().catch(()=>{});broadcastState();}json(transcript); return; }
          if(segments[2]==='history'&&segments.length===3&&request.method==='GET'){json(await readHistory(session,url.searchParams.get('cursor'),locale));return;}
          if(segments[2]==='queue'&&request.method==='GET'){json({queue:await readQueue(session)});return;}
          if (request.method !== 'POST') fail('INVALID_REQUEST');
          const action = segments[2];
          if(action==='attachments'){if(!host.hasFeature('feature-files'))fail('PLUGIN_DISABLED');const cwd=await ensureSessionWorkspace(session);json({files:await saveAttachments(cwd,body.files)});return;}
          if(action==='program'){json(body.action?await programs.action(session,body.action):await programs.start(session,body));return;}
          if(action==='interrupt'){host.computer?.stop(session.id);if(session.program?.status==='active')await programs.action(session,'pause');json(await host.taskRecovery.stop(session));return;}
          if(action==='resume'){json(await host.taskRecovery.resume(session,locale));broadcastState();return;}
          if(['pin','unread','read'].includes(action)){if(action==='pin')session.pinned=!session.pinned;else session.unread=action==='unread';await save();broadcastState();json(session);return;}
          const e = requireEngine(session);
          if(action==='queue'){return await host.runQueueMutation(session.id,async()=>{
            const operation=segments[3];
            if(operation==='add'){const input=await turnInputs(project,body);json(await e.queueRequest(session.id,'add',{input,clientUserMessageId:randomUUID()}));void sendQueue(session);return;}
            const queue=await readQueue(session);
            const entry=queue.find(item=>item.id===body.id);
            if(operation==='reorder'){
              if(!Array.isArray(body.ids)||body.ids.length!==queue.length||new Set(body.ids).size!==queue.length||body.ids.some(id=>!queue.some(item=>item.id===id)))fail('INVALID_REQUEST');
              const nativeIds=body.ids.filter(id=>!queue.find(item=>item.id===id).recovered);await e.queueRequest(session.id,'reorder',{queuedSubmissionIds:nativeIds});
              session.recoveredQueue=body.ids.map(id=>queue.find(item=>item.id===id)).filter(item=>item.recovered);await save();
            }else{
              if(!entry)fail('NOT_FOUND');
              if(operation==='update'){
                const input=[...await turnInputs(project,body),...entry.input.filter(item=>item.type!=='text')];
                if(entry.recovered){entry.input=input;await save();}else await e.queueRequest(session.id,'update',{queuedSubmissionId:entry.id,input});
              }else if(operation==='delete'){
                if(entry.recovered){session.recoveredQueue=session.recoveredQueue.filter(item=>item.id!==entry.id);await save();}else await e.queueRequest(session.id,'delete',{queuedSubmissionId:entry.id});
              }else if(operation==='steer'){
                // Remove before steering so a turn boundary cannot also dispatch the queued input.
                if(!e.activeTurns.has(session.id))fail('NO_ACTIVE_TURN');
                if(!entry.recovered){const deleted=await e.queueRequest(session.id,'delete',{queuedSubmissionId:entry.id});if(!deleted.deleted)fail('NOT_FOUND');}
                try {await e.steer(session.id,entry.input);session.recoveredQueue=(session.recoveredQueue??[]).filter(item=>item.id!==entry.id);await save();}
                catch(error){if(!entry.recovered){session.recoveredQueue=[...(session.recoveredQueue??[]),{...entry,recovered:true}];await save();}void sendQueue(session);throw error;}
              }else if(operation==='start'){
                if(e.activeTurns.has(session.id))fail('ENGINE_BUSY');
                if(entry.recovered){await host.taskRecovery.start(session,entry.input);session.recoveredQueue=session.recoveredQueue.filter(item=>item.id!==entry.id);await save();}
                else await host.taskRecovery.start(session,null,{},()=>e.queueRequest(session.id,'start',{queuedSubmissionId:entry.id}));
              }else fail('NOT_FOUND');
            }
            json({queue:await readQueue(session)});void sendQueue(session);broadcastState();return;
          });}
          if (action === 'turn') {
            const inputs=await turnInputs(project,body);
            const mode=body.followUpBehavior??state.preferences.followUpBehavior??'queue';
            const started = e.activeTurns.has(session.id) ? mode==='steer'?await e.steer(session.id,inputs):await e.queueRequest(session.id,'add',{input:inputs,clientUserMessageId:randomUUID()}) : await host.taskRecovery.start(session, inputs, { sandbox: body.permission ?? 'read-only', effort: ['low','high','max'].includes(body.effort) ? body.effort : 'high' });
            void sendQueue(session);
            broadcastState(); json(started); return;
          }
          if (action === 'rename') { if (typeof body.title !== 'string' || !body.title.trim()) fail('INVALID_REQUEST'); await e.renameSession(session.id,body.title); session.title=body.title.slice(0,100); }
          else if(action==='model'){if(!(state.models??[{id:'deepseek-v4.1-flash'}]).some(model=>model.id===body.model))fail('INVALID_REQUEST');await e.setModel(session.id,body.model);session.model=body.model;}
          else if(action==='move'){const target=body.projectId===null?null:getProject(body.projectId);if((await readQueue(session)).length)fail('ENGINE_BUSY');const cwd=await ensureSessionWorkspace({...session,projectId:target?.id??null});await e.moveSession(session.id,cwd);session.projectId=target?.id??null;}
          else if (action === 'archive') { host.computer?.stop(session.id); await e.archiveSession(session.id); session.archived=true;if(session.runRecovery)await host.taskRecovery.stop(session,'archived'); }
          else if (action === 'restore') { await e.restoreSession(session.id); session.archived=false; }
          else if (action === 'pin') session.pinned=!session.pinned;
          else if (action === 'fork') { const id=randomUUID(); const mapped=await e.forkSession(session.id,id); if(session.projectId===null)await e.moveSession(id,await ensureSessionWorkspace({id,projectId:null})); const fork={...session,id,pluginDevelopment:false,engineSessionId:id,threadId:mapped.threadId,pinned:false,program:undefined,runRecovery:undefined,updatedAt:new Date().toISOString()}; state.sessions.unshift(fork); await save(); broadcastState(); json(fork); return; }
          else fail('NOT_FOUND');
          await save(); broadcastState(); json(session); return;
        }

fail('NOT_FOUND');
}finally{if(admission)pending.delete(admission);}
}}));}
