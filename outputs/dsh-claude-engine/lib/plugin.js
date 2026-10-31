import { Service } from '@deepseek-ai/cordis';
import { ClaudeCodeEngine } from './engine.js';
export class ClaudeCodeEngineService extends Service {
  constructor(ctx,config){super(ctx,'claudeEngine',config);this.engine=new ClaudeCodeEngine(config);ctx.effect(()=>()=>this.engine.dispose());}
}
for(const name of ['start','ensureStarted','createSession','resumeSession','startTurn','interrupt','steer','readSession','readTurnState','listSessions','setModel','archiveSession','restoreSession','renameSession','forkSession','moveSession','queueRequest','respondApproval','status','dispose']){
  Object.defineProperty(ClaudeCodeEngineService.prototype,name,{value(...args){return this.engine[name](...args);}});
}
export default async function apply(ctx,config){await ctx.plugin(ClaudeCodeEngineService,config);}
