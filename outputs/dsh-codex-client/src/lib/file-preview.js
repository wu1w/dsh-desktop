import {validateImageMetadata} from './image-metadata.js';
const externalReasons=new Set(['BINARY_FILE','FILE_ENCODING','FILE_LIMIT']);
export const isExternalPreview=file=>file?.preview?.kind==='external';
export const isImagePreview=file=>file?.preview?.kind==='image';
export const isReadOnlyPreview=file=>isExternalPreview(file)||isImagePreview(file);
// A fallback carries metadata only. It never pretends binary or undecodable
// bytes are editable text and never starts an external program automatically.
export async function readFilePreview(request,projectId,relative,{images=false}={}){
  const route=`projects/${encodeURIComponent(projectId)}`;
  try{return await request(`${route}/file?path=${encodeURIComponent(relative)}`);}
  catch(failure){
    if(!externalReasons.has(failure.code))throw failure;
    let externalReason=failure.code;
    if(images){
      let info,unavailable=false;
      try{info=await request(`${route}/image-info?path=${encodeURIComponent(relative)}`);}
      catch(imageFailure){if(!['IMAGE_UNSUPPORTED','IMAGE_INVALID','IMAGE_ANIMATED','IMAGE_LIMIT','IMAGE_PLUGIN_DISABLED','PLUGIN_DISABLED','NOT_FOUND'].includes(imageFailure.code))throw imageFailure;unavailable=true;if(['IMAGE_INVALID','IMAGE_ANIMATED','IMAGE_LIMIT','IMAGE_PLUGIN_DISABLED'].includes(imageFailure.code))externalReason=imageFailure.code;}
      if(!unavailable){const metadata=validateImageMetadata(info,relative);return {...metadata,content:'',version:null,preview:{...metadata,kind:'image'}};}
    }
    const metadata=await request(`${route}/file-info?path=${encodeURIComponent(relative)}`);
    if(!metadata||metadata.path!==relative||typeof metadata.name!=='string'||!metadata.name||metadata.name.length>4096||!Number.isSafeInteger(metadata.size)||metadata.size<0||typeof metadata.modifiedAt!=='string'||!Number.isFinite(Date.parse(metadata.modifiedAt)))throw Object.assign(new Error('FILE_INFO_INVALID'),{code:'FILE_INFO_INVALID'});
    return {...metadata,content:'',version:null,preview:{kind:'external',reason:externalReason}};
  }
}
