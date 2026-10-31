import {applyChannel} from '../channel-plugin.mjs';
export const manifest={id:'channel-feishu',type:'feature',version:'0.1.0',name:{'zh-CN':'飞书消息通道',en:'Feishu messaging'}};
export const apply=(ctx,host)=>applyChannel(ctx,host,'feishu');
