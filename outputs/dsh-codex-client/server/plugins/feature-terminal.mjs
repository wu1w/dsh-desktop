import { runProjectCommand, stopProjectCommands } from '../project-commands.mjs';
import { ProjectPtyManager } from '../project-pty.mjs';
import path from 'node:path';
export const manifest = { id: 'feature-terminal', type: 'feature', version: '0.1.0', name: { 'zh-CN': '项目终端', en: 'Project terminal' } };
export function apply(ctx, host) {
  let disposed = false, stopping = false;
  const assertAccepting=()=>{if(stopping)throw Object.assign(new Error('PTY_CLOSED'),{code:'PTY_CLOSED'});};
  const terminals = new ProjectPtyManager({helperPath:path.join(host.appRoot,'native/bin/dsh-pty-helper')});
  ctx.effect(()=>host.registerActivityProvider?.('terminal-runtime',()=>[...[...terminals.sessions.values()].filter(row=>row.status==='running'||row.cleanupPending).map(row=>({id:row.id,kind:'terminal',count:1,projectId:row.projectId})),...[...host.commands].map(child=>({id:'command-'+child.pid,kind:'command',count:1}))]));
  const stopResources=async()=>{
    stopping=true;
    const stopped=await Promise.allSettled([terminals.close(),stopProjectCommands(host.commands)]);
    const failure=stopped.find(result=>result.status==='rejected');if(failure)throw failure.reason;
  };
  // Cordis disposal removes routes and ownership. Refuse that transition until
  // real cleanup succeeds, so a failed stop remains visible and retryable.
  ctx.effect(()=>host.registerBeforeStop?.(stopResources));
  ctx.effect(() => host.registerRoute({
    matches: segments => segments[0] === 'projects' && ['terminal','pty'].includes(segments[2]),
    handle: async ({ request, segments, body, url, json }) => {
      if (disposed) throw new Error('ENGINE_DISABLED');
      const project = host.getProject(segments[1]);
      if(segments[2]==='pty') {
        if(segments.length===3) {
          if(request.method==='GET'){json({terminals:terminals.list(segments[1])});return;}
          if(request.method==='POST'){assertAccepting();json(await terminals.create({projectId:segments[1],cwd:project.path,cols:body.cols??100,rows:body.rows??30}));return;}
        }
        if(segments.length===4||segments.length===5) {
          if(request.method==='GET'&&segments.length===4) {
            if(url.searchParams.getAll('after').length>1)throw new Error('PTY_INVALID_CURSOR');
            json(terminals.read(segments[1],segments[3],{after:url.searchParams.get('after')??0}));return;
          }
          if(request.method==='POST') {
            const action=segments.length===5?segments[4]:body.action;
            if(action==='input'){assertAccepting();json(await terminals.write(segments[1],segments[3],body.data));return;}
            if(action==='resize'){assertAccepting();json(await terminals.resize(segments[1],segments[3],{cols:body.cols,rows:body.rows}));return;}
            if(action==='stop'){json(await terminals.stop(segments[1],segments[3]));return;}
          }
        }
        throw new Error('INVALID_REQUEST');
      }
      if(segments.length!==3)throw new Error('INVALID_REQUEST');
      if (request.method !== 'POST') throw new Error('INVALID_REQUEST');
      assertAccepting();
      if (typeof body.command !== 'string' || !body.command.trim() || body.command.length > 16000) throw new Error('INVALID_REQUEST');
      json(await runProjectCommand({ command: body.command, cwd: project.path, commands: host.commands }));
    },
  }));
  ctx.effect(() => () => { disposed = true; return stopResources(); });
}
