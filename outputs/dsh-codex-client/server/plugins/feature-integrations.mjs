import {randomUUID} from 'node:crypto';
import {realpath,stat} from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {projectFile,readProjectFile,writeProjectFile,listProjectFiles,saveAttachments} from '../files.mjs';
const fail=code=>{throw Object.assign(new Error(code),{code});};
export const manifest={id:'feature-integrations',type:'feature',version:'0.1.0',name:{'zh-CN':'应用与技能',en:'Apps and skills'}};
export function apply(ctx,host){ctx.effect(()=>host.registerRoute({matches:(segments,method)=>segments[0]==='integrations',handle:async environment=>{
const {request,response,url,segments,body,json,locale}=environment;
const {state,save,broadcastState,getProject,getSession,requireEngine,readTranscript,readQueue,sendQueue,turnInputs,transcripts,commands}=host;
const integrations=host.integrations;
        if(segments[0]==='integrations'){
          if(segments[1]==='mcp'){
            if(request.method==='GET'){json({servers:await integrations.listMcpServers()});return;}
            if(request.method==='POST'){
              const result=segments[2]==='remove'?await integrations.removeMcpServer(body.name):segments[2]==='login'?await integrations.loginMcpServer(body.name):await integrations.saveMcpServer(body);json(result);return;
            }
          }
          if(segments[1]==='skills'){
            if(request.method==='GET'){json(await integrations.listSkills());return;}
            if(request.method==='POST'&&segments[2]==='root'){json(await integrations.addSkillRoot(body.path));return;}
            if(request.method==='POST'&&segments[2]==='toggle'){json(await integrations.setSkillEnabled(body.path,body.enabled));return;}
          }
          fail('NOT_FOUND');
        }

fail('NOT_FOUND');
}}));}
