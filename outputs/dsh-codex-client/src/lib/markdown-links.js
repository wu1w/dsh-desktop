// File links remain project paths. They never become requests against the
// authenticated loopback origin; the file API checks the canonical path again.
const controls=/[\u0000-\u001f\u007f]/;
const scheme=/^[a-z][a-z\d+.-]*:/i;
const reservedScheme=/^(?:https?|mailto|javascript|data|file|ftp|ftps|ws|wss|blob|about|chrome|codex|vscode|dsh|vbscript|tel|sms|urn|ssh|sftp|magnet|shell|facetime|zoom):/i;
function segments(value){const result=[];for(const part of value.split('/')){if(!part||part==='.')continue;if(part==='..'){if(!result.length)return null;result.pop();}else result.push(part);}return result;}
const positive=value=>{const number=Number(value);return Number.isSafeInteger(number)&&number>0?number:null;};
function citation(value){
  let file=value,location;
  const hash=value.indexOf('#');
  if(hash>=0){
    const match=/^L(\d+)(?:C(\d+))?(?:-L(\d+)(?:C(\d+))?)?$/.exec(value.slice(hash+1));
    if(!match)return null;file=value.slice(0,hash);location={line:positive(match[1])};
    if(match[2]!==undefined)location.column=positive(match[2]);
    if(match[3]!==undefined)location.endLine=positive(match[3]);
    if(match[4]!==undefined)location.endColumn=positive(match[4]);
    if(file.includes(':'))return null;
  }else if(file.includes(':')){
    const match=/^([^:]+):(\d+)(?::(\d+))?$/.exec(file);if(!match)return null;
    file=match[1];location={line:positive(match[2])};if(match[3]!==undefined)location.column=positive(match[3]);
  }
  if(location&&(Object.values(location).some(value=>value===null)||location.endLine<location.line||location.endLine===location.line&&location.column!==undefined&&location.endColumn!==undefined&&location.endColumn<location.column))return null;
  return {file,location};
}
export function markdownLink(value,{projectPath,documentPath=''}={}){
  if(typeof value!=='string'||!value||controls.test(value))return null;
  if(/^(https?:\/\/|mailto:)/i.test(value)){try{const url=new URL(value);return {type:'external',href:url.href};}catch{return null;}}
  if(reservedScheme.test(value)||value.startsWith('//')||value.startsWith('#')||value.includes('\\')||value.includes('?'))return null;
  const reference=citation(value);if(!reference)return null;let {file,location}=reference;
  if(scheme.test(file))return null;
  try{file=decodeURIComponent(file);}catch{return null;}
  if(!file||controls.test(file)||file.includes('\\')||file.startsWith('//')||scheme.test(file))return null;
  if(typeof projectPath!=='string'||!projectPath.startsWith('/')||controls.test(projectPath)||projectPath.includes('\\'))return null;
  const root=segments(projectPath);if(!root)return null;let relative;
  if(file.startsWith('/')){const target=segments(file);if(!target||target.length<=root.length||root.some((part,index)=>part!==target[index]))return null;relative=target.slice(root.length);}
  else{if(typeof documentPath!=='string'||documentPath.startsWith('/')||documentPath.includes('\\')||controls.test(documentPath))return null;const base=documentPath.split('/').slice(0,-1).join('/');relative=segments(base?base+'/'+file:file);}
  if(!relative?.length||relative.some(part=>part.toLowerCase()==='.git'))return null;
  return {type:'file',path:relative.join('/'),...(location?{location}:{})};
}
