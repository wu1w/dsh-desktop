import { AutomationScheduler } from '../automations.mjs';
import { createAutomationRunner } from '../automation-runner.mjs';

export const manifest = { id: 'feature-automations', type: 'feature', version: '0.1.0', name: { 'zh-CN': '本地自动化', en: 'Local automations' } };
export async function apply(ctx, host) {
  const runAutomation = host.runAutomation ?? createAutomationRunner({ ...host, canChat: () => host.hasFeature('feature-chat') });
  const scheduler = new AutomationScheduler({ dataDir: host.dataDir, getProject: host.getProject, runAutomation: (task, options) => runAutomation(task, options) });
  let startupError;
  try { await scheduler.start(); } catch (error) { startupError = error; }
  host.registerBeforeStop(() => scheduler.close());
  ctx.effect(()=>host.registerActivityProvider?.('automation-runtime',()=>startupError?[]:scheduler.list().runtime.activeRuns.map(run=>({id:run.runId,kind:'automation',count:1}))));
  ctx.effect(() => host.registerRoute({
    matches: segments => segments[0] === 'automations',
    handle: async ({ request, segments, body, json }) => {
      if (startupError) throw startupError;
      if (segments.length === 1 && request.method === 'GET') { json(scheduler.list()); return; }
      if (request.method !== 'POST') throw new Error('INVALID_REQUEST');
      if (segments.length === 1) { json(await scheduler.create(body)); return; }
      if (segments.length !== 3) throw new Error('INVALID_REQUEST');
      const [, id, action] = segments;
      if (action === 'update') { json(await scheduler.update(id, body)); return; }
      if (action === 'run') { json(await scheduler.run(id)); return; }
      if (action === 'delete') { json(await scheduler.delete(id)); return; }
      throw new Error('NOT_FOUND');
    },
  }));
  ctx.effect(() => () => scheduler.close());
}
