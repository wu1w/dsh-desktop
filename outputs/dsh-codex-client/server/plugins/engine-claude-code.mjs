import path from 'node:path';
import {homedir} from 'node:os';
import {existsSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
export const manifest={id:'engine-claude-code',type:'engine',version:'0.1.0',name:{'zh-CN':'Claude Code 执行引擎',en:'Claude Code engine'},capabilities:['tools','resume']};

// 目标：装完就能用，不用用户自己找 CLI。
// 优先级：显式配置 -> 随应用打包的 SDK 二进制 -> 用户目录里的安装 -> PATH。
function resolveClaudeBinary(appRoot,options){
  if(options.claudeBinary)return options.claudeBinary;
  if(process.platform==='win32'){
    const bundled=path.join(appRoot,'node_modules','@anthropic-ai','claude-agent-sdk-win32-x64','claude.exe');
    if(existsSync(bundled))return bundled;
    const local=path.join(homedir(),'.local','bin','claude.exe');
    if(existsSync(local))return local;
    return 'claude.exe';
  }
  const local=path.join(homedir(),'.local/bin/claude');
  return existsSync(local)?local:'claude';
}

export function apply(ctx,host){ctx.effect(()=>host.registerEngine('claude-code',{capabilities:{computerUse:true,tools:true,queue:true,autoQueue:true,steer:false,resume:true,fork:false,move:false,images:false,fullAccess:false,bash:false,mcp:false,skills:false},async create(options){
  const module=await import(pathToFileURL(path.join(host.appRoot,'claude-engine/lib/engine.js')).href).catch(()=>{throw Object.assign(new Error('ENGINE_NOT_INSTALLED'),{code:'ENGINE_NOT_INSTALLED'});});
  const engine=new module.ClaudeCodeEngine({...options,binary:resolveClaudeBinary(host.appRoot,options)});
  const cleanup=ctx.effect(()=>()=>engine.dispose());
  return{engine,dispose:async()=>{await engine.dispose();await cleanup();}};
}}));}
