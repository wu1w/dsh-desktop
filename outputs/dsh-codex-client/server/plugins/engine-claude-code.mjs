import path from 'node:path';
import {homedir} from 'node:os';
import {pathToFileURL} from 'node:url';
export const manifest={id:'engine-claude-code',type:'engine',version:'0.1.0',name:{'zh-CN':'Claude Code 执行引擎',en:'Claude Code engine'},capabilities:['tools','resume']};
export function apply(ctx,host){ctx.effect(()=>host.registerEngine('claude-code',{capabilities:{computerUse:true,tools:true,queue:true,autoQueue:true,steer:false,resume:true,fork:false,move:false,images:false,fullAccess:false,bash:false,mcp:false,skills:false},async create(options){
  const module=await import(pathToFileURL(path.join(host.appRoot,'claude-engine/lib/engine.js')).href).catch(()=>{throw Object.assign(new Error('ENGINE_NOT_INSTALLED'),{code:'ENGINE_NOT_INSTALLED'});});
  const engine=new module.ClaudeCodeEngine({...options,binary:options.claudeBinary??path.join(homedir(),'.local/bin/claude')});
  const cleanup=ctx.effect(()=>()=>engine.dispose());
  return{engine,dispose:async()=>{await engine.dispose();await cleanup();}};
}}));}
