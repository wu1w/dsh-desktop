import path from 'node:path';
import {pathToFileURL} from 'node:url';
export const manifest={id:'engine-dsh-native',type:'engine',version:'0.1.0',name:{'zh-CN':'DSH 原生执行引擎',en:'DSH native engine'},capabilities:['tools','queue','resume']};
export function apply(ctx,host){ctx.effect(()=>host.registerEngine('dsh-native',{capabilities:{computerUse:true,tools:true,queue:true,autoQueue:true,steer:false,resume:true,fork:false,move:false,images:false,fullAccess:false,bash:false,mcp:false,skills:false},async create(options){
 const module=await import(pathToFileURL(path.join(host.appRoot,'native-engine/lib/engine.js')).href).catch(()=>{throw Object.assign(new Error('ENGINE_NOT_INSTALLED'),{code:'ENGINE_NOT_INSTALLED'});});
 const engine=new module.DshNativeEngine(options);
 const cleanup=ctx.effect(()=>()=>engine.dispose());return{engine,dispose:async()=>{await engine.dispose();await cleanup();}};
}}));}
