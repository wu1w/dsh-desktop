import {applyChannel} from '../channel-plugin.mjs';
export const manifest={id:'channel-qq',type:'feature',version:'0.1.0',name:{'zh-CN':'QQ 消息通道',en:'QQ messaging'}};
export const apply=(ctx,host)=>applyChannel(ctx,host,'qq');
