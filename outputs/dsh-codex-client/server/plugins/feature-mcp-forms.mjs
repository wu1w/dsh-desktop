import {mcpElicitationResult} from '../approvals.mjs';
export const manifest={id:'feature-mcp-forms',type:'feature',version:'0.1.0',name:{'zh-CN':'MCP 问询表单',en:'MCP request forms'}};
export function apply(ctx,host){
  host.registerFeature('feature-mcp-forms');
  ctx.effect(()=>host.approvals.registerHandler('mcpServer/elicitation/request',mcpElicitationResult));
}
