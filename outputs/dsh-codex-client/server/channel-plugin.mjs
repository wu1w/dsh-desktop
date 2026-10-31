import {ChannelManager} from './channel-manager.mjs';
import {channelFault} from './channel-store.mjs';

export async function applyChannel(ctx,host,platform){
  const manager=new ChannelManager({...host.channelOptions,host,platform});
  try{await manager.start();}catch(error){manager.store.close();throw error;}
  host.registerBeforeStop(()=>manager.close());
  ctx.effect(()=>()=>manager.close());
  host.registerActivityProvider('channel-'+platform,()=>manager.activities());
  host.registerRoute({matches:segments=>segments[0]==='channels'&&segments[1]===platform,
    handle:async({request,segments,body,json})=>{
      if(request.method==='GET'&&segments.length===2){json(manager.snapshot());return;}
      if(request.method!=='POST')throw channelFault('CHANNEL_INVALID_CONFIG');
      const action=segments[2];
      if(action==='configure'&&segments.length===3)json(await manager.saveConfig(body));
      else if(action==='connect'&&segments.length===3)json(await manager.connect());
      else if(action==='disconnect'&&segments.length===3)json(await manager.disconnect());
      else if(action==='qr'&&segments[3]==='start'&&segments.length===4)json(await manager.qrStart(body.config));
      else if(action==='qr'&&segments[3]==='poll'&&segments.length===4)json(await manager.qrPoll(body.id));
      else if(action==='qr'&&segments[3]==='cancel'&&segments.length===4)json(await manager.qrCancel(body.id));
      else if(action==='pair'&&segments.length===3)json(await manager.approvePeer(body.id));
      else if(action==='deliveries'&&segments.length===5)json(await manager.deliveryAction(segments[3],segments[4]));
      else throw channelFault('CHANNEL_NOT_FOUND');
    }});
}
