import {applyChannel} from '../channel-plugin.mjs';
export const manifest={id:'channel-weixin',type:'feature',version:'0.1.0',name:{'zh-CN':'微信消息通道',en:'WeChat messaging'}};
export const apply=(ctx,host)=>applyChannel(ctx,host,'weixin');
