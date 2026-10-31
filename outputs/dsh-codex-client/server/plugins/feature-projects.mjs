import {randomUUID} from 'node:crypto';
import {realpath,stat} from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {projectFile,readProjectFile,writeProjectFile,listProjectFiles,saveAttachments} from '../files.mjs';
const fail=code=>{throw Object.assign(new Error(code),{code});};
export const manifest={id:'feature-projects',type:'feature',version:'0.1.0',name:{'zh-CN':'项目管理',en:'Projects'}};
export function apply(ctx,host){ctx.effect(()=>host.registerRoute({matches:(segments,method)=>segments[0]==='projects'&&segments.length===1,handle:async environment=>{
const {request,response,url,segments,body,json,locale}=environment;
const {state,save,broadcastState,getProject,getSession,requireEngine,readTranscript,readQueue,sendQueue,turnInputs,transcripts,commands}=host;
const integrations=host.integrations;
        if (segments[0] === 'projects' && segments.length === 1 && request.method === 'POST') {
          if (typeof body.path !== 'string' || !path.isAbsolute(body.path)) fail('INVALID_PATH');
          const canonical = await realpath(body.path); if (!(await stat(canonical)).isDirectory()) fail('INVALID_PATH');
          let project = state.projects.find(p => p.path === canonical);
          if (!project) { project = { id: randomUUID(), path: canonical, name: typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0,100) : path.basename(canonical) }; state.projects.push(project); await save(); }
          broadcastState(); json(project); return;
        }

fail('NOT_FOUND');
}}));}
