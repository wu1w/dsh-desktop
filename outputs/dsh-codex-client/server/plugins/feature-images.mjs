import {ImageFileReader} from '../image-files.mjs';
import {randomUUID} from 'node:crypto';
const fail=code=>{throw Object.assign(new Error(code),{code});};
export const manifest={id:'feature-images',type:'feature',version:'0.1.0',name:{'zh-CN':'静态图片预览',en:'Static image preview'}};
export function apply(ctx,host){
  const reader=new ImageFileReader(),transfers=new Set();let stopping=false;
  const stop=async()=>{
    stopping=true;for(const transfer of transfers){transfer.controller.abort();if(!transfer.response.writableFinished)transfer.response.destroy();}
    let timer;
    try{const results=await Promise.race([Promise.allSettled([reader.close(),...[...transfers].map(transfer=>transfer.done)]),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error('IMAGE_CLEANUP_FAILED'),{code:'IMAGE_CLEANUP_FAILED'})),10000);})]);if(results.some(result=>result.status==='rejected')||transfers.size)fail('IMAGE_CLEANUP_FAILED');}
    finally{clearTimeout(timer);}
  };
  host.registerBeforeStop(stop);
  ctx.effect(()=>host.registerActivityProvider?.('image-runtime',()=>[...new Map([...reader.activities(),...[...transfers].map(transfer=>({id:'image-'+transfer.id,kind:'command',count:1,projectId:transfer.projectId}))].map(row=>[row.id,row])).values()]));
  ctx.effect(()=>host.registerRoute({matches:segments=>segments[0]==='projects'&&['image-info','image'].includes(segments[2]),handle:async({request,response,segments,url,json})=>{
    if(request.method!=='GET'||segments.length!==3||url.searchParams.getAll('path').length!==1)fail('INVALID_REQUEST');
    if(stopping)fail('IMAGE_PLUGIN_DISABLED');if(transfers.size>=4)fail('IMAGE_BUSY');
    const project=host.getProject(segments[1]),relative=url.searchParams.get('path'),controller=new AbortController(),abort=()=>controller.abort(),disconnected=()=>{if(!response.writableFinished)abort();};
    if(segments[2]==='image'&&(url.searchParams.getAll('version').length!==1||!/^[a-f0-9]{64}$/.test(url.searchParams.get('version'))))fail('IMAGE_VERSION_REQUIRED');
    let release,sent=false;const transfer={id:randomUUID(),projectId:project.id,controller,response,done:new Promise(resolve=>{release=resolve;})};const finished=()=>{transfers.delete(transfer);release();};transfers.add(transfer);response.once?.('finish',finished);response.once?.('close',finished);
    request.once?.('aborted',abort);response.once?.('close',disconnected);if(request.aborted||response.destroyed)abort();
    try{
      if(segments[2]==='image-info'){const info=await reader.info(project.path,relative,{signal:controller.signal,projectId:project.id,requestId:transfer.id});if(controller.signal.aborted)fail('IMAGE_LOAD_ABORTED');sent=true;json(info);await transfer.done;return;}
      const result=await reader.read(project.path,relative,{version:url.searchParams.get('version'),signal:controller.signal,projectId:project.id,requestId:transfer.id});if(controller.signal.aborted)fail('IMAGE_LOAD_ABORTED');
      response.writeHead(200,{'content-type':result.info.mime,'content-length':String(result.bytes.length),'x-content-type-options':'nosniff','cache-control':'no-store','x-dsh-image-version':result.info.version});sent=true;response.end(result.bytes);await transfer.done;
    }finally{request.removeListener?.('aborted',abort);response.removeListener?.('close',disconnected);if(!sent)finished();response.removeListener?.('finish',finished);response.removeListener?.('close',finished);}
  }}));
  ctx.effect(()=>stop);
}
