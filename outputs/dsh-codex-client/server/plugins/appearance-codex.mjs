import {fileURLToPath} from 'node:url';
export const manifest={id:'appearance-codex',type:'appearance',version:'0.1.0',name:{'zh-CN':'Codex 外观','en':'Codex appearance'},capabilities:['chat','projects','documents','menus']};
export function apply(ctx,host){ctx.effect(()=>host.registerAppearance({root:fileURLToPath(new URL('../../dist/',import.meta.url)),entry:'main.js',styles:['main.css'],exportName:'mountDshAppearance'}));}
