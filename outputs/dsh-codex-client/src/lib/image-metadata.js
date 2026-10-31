export const MAX_IMAGE_BYTES=16*1024*1024;
export const IMAGE_MIMES=new Set(['image/png','image/jpeg','image/webp']);
const invalid=()=>Object.assign(new Error('IMAGE_INFO_INVALID'),{code:'IMAGE_INFO_INVALID'});
export function validateImageMetadata(value,relative){
  if(!value||typeof value!=='object'||Array.isArray(value)||value.path!==relative||typeof value.name!=='string'||!value.name||value.name.includes('\0')||value.name.length>4096
    ||!Number.isSafeInteger(value.size)||value.size<1||value.size>MAX_IMAGE_BYTES||!IMAGE_MIMES.has(value.mime)
    ||typeof value.modifiedAt!=='string'||value.modifiedAt.length>40||!Number.isFinite(Date.parse(value.modifiedAt))||new Date(value.modifiedAt).toISOString()!==value.modifiedAt
    ||typeof value.version!=='string'||! /^[a-f0-9]{64}$/.test(value.version)
    ||![value.width,value.height].every(number=>Number.isSafeInteger(number)&&number>0&&number<=16384)||value.width*value.height>32000000)throw invalid();
  return {path:value.path,name:value.name,size:value.size,modifiedAt:value.modifiedAt,version:value.version,mime:value.mime,width:value.width,height:value.height};
}
