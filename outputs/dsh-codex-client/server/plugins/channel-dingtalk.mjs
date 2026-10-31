import {applyChannel} from '../channel-plugin.mjs';
export const manifest={id:'channel-dingtalk',type:'feature',version:'0.1.0',name:{'zh-CN':'钉钉消息通道',en:'DingTalk messaging'}};
export const apply=(ctx,host)=>applyChannel(ctx,host,'dingtalk');
