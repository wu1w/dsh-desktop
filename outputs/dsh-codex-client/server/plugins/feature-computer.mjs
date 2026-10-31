export const manifest={id:'feature-computer',type:'feature',version:'0.1.0',name:{'zh-CN':'电脑操作',en:'Computer Use'}};
export function apply(ctx,host){
 ctx.effect(()=>()=>host.computer.stopAll());
 ctx.effect(()=>host.registerRoute({matches:segments=>segments[0]==='computer',handle:async({segments,request,body,json})=>{
  const action=segments[1];
  if(request.method==='GET'){
   if(action==='status'){json(await host.computer.status());return;}
   if(action==='apps'){json(await host.computer.apps());return;}
   host.getSession(action);json(host.computer.snapshot(action));return;
  }
  if(request.method!=='POST')throw Object.assign(Error('INVALID_REQUEST'),{code:'INVALID_REQUEST'});
  if(action==='permission'){json(await host.computer.permission(body.kind));return;}
  const session=host.getSession(action);
  if(segments[2]==='connect'){json(await host.computer.connect(session.id,body.target));return;}
  if(segments[2]==='stop'){host.computer.stop(session.id);json({connected:false});return;}
  if(segments[2]==='observe'){json(await host.computer.execute(session.id,{action:'observe'},{fromUser:true}));return;}
  throw Object.assign(Error('INVALID_REQUEST'),{code:'INVALID_REQUEST'});
 }}));
}
