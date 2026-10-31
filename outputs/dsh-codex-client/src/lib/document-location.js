const positive=value=>Number.isSafeInteger(value)&&value>0;
export const normalizeEditorText=value=>String(value).replace(/\r\n?/g,'\n');
export function indexDocument(content){
  const text=normalizeEditorText(content);let count=1;
  for(let i=0;i<text.length;i++)if(text.charCodeAt(i)===10)count++;
  const starts=new Uint32Array(count);let next=1;
  for(let i=0;i<text.length;i++)if(text.charCodeAt(i)===10)starts[next++]=i+1;
  return {text,starts,lineCount:count};
}
export function validLocation(location){
  if(!location||typeof location!=='object'||!positive(location.line))return false;
  for(const key of ['column','endLine','endColumn'])if(location[key]!==undefined&&!positive(location[key]))return false;
  if(location.endColumn!==undefined&&location.endLine===undefined)return false;
  return location.endLine===undefined||location.endLine>=location.line;
}
function endOfLine(index,line){return line===index.lineCount?index.text.length:index.starts[line]-1;}
function columnOffset(index,line,column){
  const start=index.starts[line-1],end=endOfLine(index,line);let current=1,at=start;
  while(at<end&&current<column){const code=index.text.codePointAt(at);at+=code>0xffff?2:1;current++;}
  return current===column?at:null;
}
export function resolveDocumentLocation(index,location){
  if(!validLocation(location))return {error:'docLocationInvalid'};
  if(location.line>index.lineCount||(location.endLine??location.line)>index.lineCount)return {error:'docLocationOutside'};
  const start=location.column===undefined?index.starts[location.line-1]:columnOffset(index,location.line,location.column);
  let end=location.endLine!==undefined?(location.endColumn===undefined?endOfLine(index,location.endLine):columnOffset(index,location.endLine,location.endColumn)):location.column===undefined?endOfLine(index,location.line):start;
  if(start===null||end===null||end<start)return {error:'docLocationOutside'};
  return {start,end,line:location.line,column:location.column??1,endLine:location.endLine??location.line};
}
export function documentPosition(index,offset=0){
  const at=Math.max(0,Math.min(index.text.length,Number.isFinite(offset)?Math.trunc(offset):0));let low=0,high=index.starts.length;
  while(low+1<high){const mid=(low+high)>>>1;if(index.starts[mid]<=at)low=mid;else high=mid;}
  let column=1;for(let i=index.starts[low];i<at;column++)i+=index.text.codePointAt(i)>0xffff?2:1;
  return {line:low+1,column};
}
export function parseLineInput(value){
  if(typeof value!=='string')return null;const match=/^\s*([1-9]\d*)(?::([1-9]\d*))?\s*$/.exec(value);
  if(!match)return null;const location={line:Number(match[1]),...(match[2]?{column:Number(match[2])}:{})};return validLocation(location)?location:null;
}
export function visibleDocumentLines(index,scrollTop=0,height=400,lineHeight=20){
  const first=Math.max(1,Math.floor((scrollTop-8)/lineHeight)+1-3),count=Math.min(256,Math.ceil(Math.max(0,height)/lineHeight)+7);
  return {first,last:Math.min(index.lineCount,first+count-1),top:8+(first-1)*lineHeight-scrollTop};
}
export function applyDocumentLocation(element,index,location,{measurePrefix}={}){
  const target=resolveDocumentLocation(index,location);if(target.error)return target;
  element.focus({preventScroll:true});element.setSelectionRange(target.start,target.end);
  element.scrollTop=Math.max(0,8+(target.line-1)*20-(element.clientHeight||400)/3);
  const prefix=index.text.slice(index.starts[target.line-1],target.start);
  const width=measurePrefix?measurePrefix(prefix):Math.max(0,target.column-1)*7.2;
  element.scrollLeft=Math.max(0,width-(element.clientWidth||400)/3+12);return target;
}
function originalOffset(original,visualOffset){let visual=0,at=0;while(at<original.length&&visual<visualOffset){if(original[at]==='\r'&&original[at+1]==='\n')at+=2;else at++;visual++;}return at;}
// A textarea normalizes CRLF. Apply only the changed visual span to the original
// text so an ordinary edit cannot rewrite every untouched line ending.
export function applyEditorChange(original,value){
  // LF buffers already share the textarea's representation. Use the complete
  // current value directly instead of scanning unchanged prefixes twice.
  if(!original.includes('\r')){const next=normalizeEditorText(value);return next===original?original:next;}
  const previous=normalizeEditorText(original),next=normalizeEditorText(value);if(previous===next)return original;
  let start=0;while(start<previous.length&&start<next.length&&previous[start]===next[start])start++;
  let suffix=0;while(suffix<previous.length-start&&suffix<next.length-start&&previous[previous.length-1-suffix]===next[next.length-1-suffix])suffix++;
  const from=originalOffset(original,start),to=originalOffset(original,previous.length-suffix),eol=/\r\n|\r|\n/.exec(original)?.[0]??'\n';
  return original.slice(0,from)+next.slice(start,next.length-suffix).replace(/\n/g,eol)+original.slice(to);
}
export const isMarkdownDocument=file=>/\.(?:md|markdown|mdown|mkd)$/i.test(file?.path??'');
