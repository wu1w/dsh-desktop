import {applyChannel} from '../channel-plugin.mjs';
export const manifest={id:'channel-wecom',type:'feature',version:'0.1.0',name:{'zh-CN':'企业微信消息通道',en:'WeCom messaging'}};
export const apply=(ctx,host)=>applyChannel(ctx,host,'wecom');
