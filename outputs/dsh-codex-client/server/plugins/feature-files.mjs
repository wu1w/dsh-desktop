import {randomUUID} from 'node:crypto';
import {realpath,stat} from 'node:fs/promises';
import path from 'node:path';
import {projectFile,readProjectFileInfo,readProjectFile,writeProjectFile,listProjectFiles,saveAttachments} from '../files.mjs';
import {DocumentDraftStore} from '../document-drafts.mjs';
import {SystemOpener} from '../system-open.mjs';
import {ResourceLibrary,listResources,createResource} from '../resource-library.mjs';
const fail=code=>{throw Object.assign(new Error(code),{code});};
export const manifest={id:'feature-files',type:'feature',version:'0.1.0',name:{'zh-CN':'文件预览与编辑',en:'File preview and editing'}};
export async function apply(ctx,host){
const opener=new SystemOpener();
let openerDisposed=false;
host.registerBeforeStop(()=>opener.close());
ctx.effect(()=>host.registerActivityProvider?.('system-open-runtime',()=>[...opener.operations.values()].map(operation=>({id:'system-open-'+operation.id,kind:'command',count:1,pid:operation.child?.pid??null,projectId:operation.projectId}))));
ctx.effect(()=>()=>{openerDisposed=true;return opener.close();});
const documentDrafts=new DocumentDraftStore({dataDir:host.dataDir});
const library=new ResourceLibrary(host.dataDir);
host.registerBeforeStop(()=>library.queue);
try{await documentDrafts.load();}catch{/* Recovery routes surface the preserved file's localized error. Browsing stays available. */}
ctx.effect(()=>host.registerRoute({matches:(segments,method)=>segments[0]==='library'||segments[0]==='document-drafts'||segments[0]==='projects'&&segments[1]&&['files','file','file-info','attachments','open'].includes(segments[2]),handle:async environment=>{
const {request,response,url,segments,body,json,locale}=environment;
const {state,save,broadcastState,getProject,getSession,requireEngine,readTranscript,readQueue,sendQueue,turnInputs,transcripts,commands}=host;
const integrations=host.integrations;
        if(segments[0]==='library'){
          if(request.method==='GET'&&segments.length===1){
            const controller=new AbortController(),abort=()=>controller.abort();
            const disconnected=()=>{if(!response.writableFinished)abort();};
            request.once('aborted',abort);response.once('close',disconnected);
            if(request.aborted||response.destroyed)abort();
            try{const [inventory,records]=await Promise.all([listResources(url.searchParams.has('projectId')?[getProject(url.searchParams.get('projectId'))]:state.projects,{signal:controller.signal}),library.snapshot()]);json({...inventory,records});}
            finally{request.removeListener('aborted',abort);response.removeListener('close',disconnected);}
            return;
          }
          if(request.method==='POST'&&segments.length===2){
            const project=getProject(body.projectId);
            if(segments[1]==='create'){json(await createResource(project,body.name));return;}
            if(segments[1]==='item'){
              const info=await readProjectFileInfo(project.path,body.path);
              json({record:await library.update(project.id,info.path,body)});return;
            }
          }
          fail('INVALID_REQUEST');
        }
        if(segments[0]==='document-drafts'){
          if(request.method==='GET'&&segments.length===1){
            const projectId=url.searchParams.get('projectId'),relative=url.searchParams.get('path');
            if(projectId!==null||relative!==null){const project=getProject(projectId);await projectFile(project.path,relative,{create:true});json({draft:await documentDrafts.read({projectId,path:relative})});}
            else json({drafts:await documentDrafts.read()});
            return;
          }
          if(request.method==='POST'&&segments.length===2){
            const project=getProject(body.projectId);
            if(segments[1]==='save'){await projectFile(project.path,body.path,{create:true});json({draft:await documentDrafts.save(body)});return;}
            if(segments[1]==='clear'){json(await documentDrafts.clear(body));return;}
          }
          fail('INVALID_REQUEST');
        }
        if (segments[0] === 'projects' && segments[1]) {
          const project = getProject(segments[1]);
          if (segments[2] === 'file-info') {
            if(request.method!=='GET'||segments.length!==3||url.searchParams.getAll('path').length!==1)fail('INVALID_REQUEST');
            json(await readProjectFileInfo(project.path,url.searchParams.get('path')));return;
          }
          if (segments[2] === 'files' && request.method === 'GET') { json({ entries: await listProjectFiles(project.path, url.searchParams.get('path') ?? '') }); return; }
          if (segments[2] === 'file') {
            if (request.method === 'GET') { json(await readProjectFile(project.path, url.searchParams.get('path') ?? '')); return; }
            if (request.method === 'POST') { await writeProjectFile(project.path, body.path, body.content, body.version); json({ ok: true }); return; }
          }
          if (segments[2] === 'attachments' && request.method === 'POST') { json({ files: await saveAttachments(project.path, body.files) }); return; }
          if (segments[2] === 'open' && request.method === 'POST') {
            if(segments.length!==3)fail('INVALID_REQUEST');
            if(openerDisposed)fail('FILE_OPEN_CLOSED');
            const target=await projectFile(project.path,body.path),controller=new AbortController();
            const abort=()=>controller.abort();
            const disconnected=()=>{if(!response.writableFinished)abort();};
            request.once?.('aborted',abort);response.once?.('close',disconnected);
            if(request.aborted||response.destroyed)abort();
            try{json(await opener.open(target,{signal:controller.signal,projectId:project.id}));}
            finally{request.removeListener?.('aborted',abort);response.removeListener?.('close',disconnected);}
            return;
          }
        }

fail('NOT_FOUND');
}}));}
