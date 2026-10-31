import { ProjectGit } from '../project-git.mjs';
import { GitDraftStore } from '../git-drafts.mjs';

export const manifest = { id: 'feature-git', type: 'feature', version: '0.1.0', name: { 'zh-CN': 'Git 本地审阅', en: 'Local Git review' } };
export function apply(ctx, host) {
  const reader = new ProjectGit();
  const drafts=host.dataDir?new GitDraftStore({dataDir:host.dataDir}):null;
  const stop=async()=>{const results=await Promise.allSettled([reader.close(),drafts?.close()]);const failed=results.find(result=>result.status==='rejected');if(failed)throw failed.reason;};
  host.registerBeforeStop(stop);
  ctx.effect(()=>host.registerActivityProvider?.('git-runtime',()=>[...reader.activities(),...(drafts?.activities()??[])]));
  ctx.effect(() => host.registerRoute({
    matches: segments => segments[0] === 'git-drafts'||segments[0] === 'projects' && segments[2] === 'git',
    handle: async ({ request, response, segments, url, body, json }) => {
      if(segments[0]==='git-drafts'){
        if(!drafts)throw Object.assign(new Error('GIT_DRAFT_STORAGE_UNSAFE'),{code:'GIT_DRAFT_STORAGE_UNSAFE'});
        if(request.method==='GET'&&segments.length===1){if(url.searchParams.getAll('projectId').length!==1)throw Object.assign(new Error('GIT_DRAFT_INVALID'),{code:'GIT_DRAFT_INVALID'});const projectId=url.searchParams.get('projectId');host.getProject(projectId);json({draft:await drafts.get(projectId)});return;}
        if(request.method==='POST'&&segments.length===2&&['save','clear'].includes(segments[1])){host.getProject(body.projectId);if(segments[1]==='save'){json({draft:await drafts.save(body)});return;}json(await drafts.clear(body));return;}
        throw new Error('INVALID_REQUEST');
      }
      if (!['GET','POST'].includes(request.method) || segments.length !== 4) throw new Error('INVALID_REQUEST');
      const project = host.getProject(segments[1]);
      const controller = new AbortController();
      const abort = () => controller.abort();
      const disconnected = () => { if (!response.writableFinished) abort(); };
      request.once?.('aborted', abort);
      response?.once?.('close', disconnected);
      if (request.aborted || response?.destroyed) abort();
      try {
        if(request.method==='POST'){
          if(['stage','unstage'].includes(segments[3])){json(await reader[segments[3]](project.path,{path:body.path,revision:body.revision,signal:controller.signal}));return;}
          if(segments[3]==='commit'){json(await reader.commit(project.path,{message:body.message,revision:body.revision,name:body.name,email:body.email,signal:controller.signal}));return;}
          throw new Error('INVALID_REQUEST');
        }
        if (segments[3] === 'status') { json(await reader.status(project.path, { signal: controller.signal })); return; }
        if (segments[3] === 'diff') {
          const staged = url.searchParams.get('staged') ?? '0';
          if (!['0', '1'].includes(staged) || url.searchParams.getAll('path').length !== 1 || url.searchParams.getAll('staged').length > 1) throw new Error('GIT_INVALID_PATH');
          json(await reader.diff(project.path, { path: url.searchParams.get('path'), staged: staged === '1', signal: controller.signal })); return;
        }
        throw new Error('NOT_FOUND');
      } finally { request.removeListener?.('aborted', abort); response?.removeListener?.('close', disconnected); }
    },
  }));
  ctx.effect(() => stop);
}
