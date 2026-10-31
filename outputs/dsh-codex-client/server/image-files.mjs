import {open,realpath,stat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {projectFile} from './files.mjs';

export const IMAGE_LIMITS=Object.freeze({bytes:16*1024*1024,pixels:32000000,side:16384});
const fault=code=>Object.assign(new Error(code),{code});
const requireImage=(condition,code='IMAGE_INVALID')=>{if(!condition)throw fault(code);};
const dimensions=(width,height)=>{requireImage(Number.isSafeInteger(width)&&Number.isSafeInteger(height)&&width>0&&height>0);requireImage(width<=IMAGE_LIMITS.side&&height<=IMAGE_LIMITS.side&&width*height<=IMAGE_LIMITS.pixels,'IMAGE_LIMIT');return {width,height};};
const crcTable=Uint32Array.from({length:256},(_,index)=>{let value=index;for(let bit=0;bit<8;bit++)value=value&1?0xedb88320^(value>>>1):value>>>1;return value>>>0;});
function crc32(bytes){let crc=0xffffffff;for(const value of bytes)crc=crcTable[(crc^value)&255]^(crc>>>8);return (crc^0xffffffff)>>>0;}
function png(bytes){
  let offset=8,frame,palette=0,data=false,dataEnded=false,totalData=0,firstData=[];
  for(let chunks=0;offset<bytes.length;chunks++){
    requireImage(chunks<8192,'IMAGE_LIMIT');requireImage(offset+12<=bytes.length);
    const length=bytes.readUInt32BE(offset),end=offset+12+length;requireImage(end<=bytes.length);
    const type=bytes.toString('latin1',offset+4,offset+8);requireImage(/^[A-Za-z]{4}$/.test(type)&&type[2]===type[2].toUpperCase());
    requireImage(crc32(bytes.subarray(offset+4,end-4))===bytes.readUInt32BE(end-4));const payload=bytes.subarray(offset+8,end-4);
    if(['acTL','fcTL','fdAT'].includes(type))throw fault('IMAGE_ANIMATED');
    if(type==='IHDR'){
      requireImage(!frame&&offset===8&&length===13);const depth=payload[8],color=payload[9],allowed={0:[1,2,4,8,16],2:[8,16],3:[1,2,4,8],4:[8,16],6:[8,16]};
      requireImage(allowed[color]?.includes(depth)&&payload[10]===0&&payload[11]===0&&payload[12]<=1);frame={...dimensions(payload.readUInt32BE(0),payload.readUInt32BE(4)),depth,color};
    }else{
      requireImage(Boolean(frame));
      if(type==='PLTE'){requireImage(!palette&&!data&&![0,4].includes(frame.color)&&length>0&&length%3===0&&length<=768);palette=length/3;if(frame.color===3)requireImage(palette<=2**frame.depth);}
      else if(type==='IDAT'){requireImage(!dataEnded&&(frame.color!==3||palette>0));data=true;totalData+=length;for(let index=0;index<payload.length&&firstData.length<2;index++)firstData.push(payload[index]);}
      else if(type==='IEND'){requireImage(length===0&&data&&totalData>=6&&end===bytes.length);requireImage((firstData[0]&15)===8&&(firstData[0]>>>4)<=7&&((firstData[0]<<8)|firstData[1])%31===0&&!(firstData[1]&32));return {mime:'image/png',width:frame.width,height:frame.height};}
      else{if(data)dataEnded=true;requireImage(type[0]===type[0].toLowerCase(),'IMAGE_UNSUPPORTED');}
    }
    offset=end;
  }
  throw fault('IMAGE_INVALID');
}
function jpeg(bytes){
  let offset=2,frame,scans=0,entropy=false,entropyBytes=0;const quant=new Set(),huffman=new Set();
  for(let markers=0;offset<bytes.length;markers++){
    requireImage(markers<8192,'IMAGE_LIMIT');
    if(entropy){
      while(offset<bytes.length){if(bytes[offset++]!==255){entropyBytes++;continue;}const start=offset-1;while(offset<bytes.length&&bytes[offset]===255)offset++;requireImage(offset<bytes.length);const marker=bytes[offset];if(marker===0){offset++;entropyBytes++;continue;}if(marker>=0xd0&&marker<=0xd7){offset++;continue;}offset=start;entropy=false;break;}
      requireImage(entropyBytes>0);if(entropy)throw fault('IMAGE_INVALID');
    }
    requireImage(bytes[offset++]===255);while(offset<bytes.length&&bytes[offset]===255)offset++;requireImage(offset<bytes.length);const marker=bytes[offset++];
    if(marker===0xd9){requireImage(Boolean(frame)&&scans>0&&offset===bytes.length);return {mime:'image/jpeg',width:frame.width,height:frame.height};}
    requireImage(marker!==0&&marker!==0xd8&&!(marker>=0xd0&&marker<=0xd7));requireImage(offset+2<=bytes.length);const length=bytes.readUInt16BE(offset);requireImage(length>=2&&offset+length<=bytes.length);const payload=bytes.subarray(offset+2,offset+length);offset+=length;
    if([0xc0,0xc2].includes(marker)){
      requireImage(!frame&&payload.length>=6&&payload[0]===8,'IMAGE_UNSUPPORTED');const count=payload[5];requireImage([1,3,4].includes(count)&&length===8+3*count);
      frame={...dimensions(payload.readUInt16BE(3),payload.readUInt16BE(1)),progressive:marker===0xc2,components:new Map()};
      for(let index=0;index<count;index++){const base=6+index*3,id=payload[base],sampling=payload[base+1],table=payload[base+2];requireImage(!frame.components.has(id)&&(sampling>>>4)>0&&(sampling>>>4)<=4&&(sampling&15)>0&&(sampling&15)<=4&&table<=3);frame.components.set(id,table);}
    }else if(marker===0xdb){requireImage(payload.length>0);for(let index=0;index<payload.length;){const value=payload[index++],precision=value>>>4;requireImage(precision<=1&&(value&15)<=3);index+=64*(precision+1);requireImage(index<=payload.length);quant.add(value&15);}}
    else if(marker===0xc4){requireImage(payload.length>0);for(let index=0;index<payload.length;){requireImage(index+17<=payload.length);const value=payload[index++];requireImage((value>>>4)<=1&&(value&15)<=3);let count=0,slots=1;for(let bits=0;bits<16;bits++){const next=payload[index++];count+=next;slots=slots*2-next;requireImage(slots>=0);}requireImage(count>0&&count<=256&&index+count<=payload.length);index+=count;huffman.add(value);}}
    else if(marker===0xda){
      requireImage(Boolean(frame)&&payload.length>=4);const count=payload[0];requireImage(count>0&&count<=frame.components.size&&length===6+2*count);const seen=new Set(),ss=payload[1+2*count],se=payload[2+2*count],successive=payload[3+2*count];
      requireImage(frame.progressive?ss<=se&&se<=63&&(ss===0?se===0:count===1)&&(successive>>>4)<=13&&(successive&15)<=13&&((successive>>>4)===0||(successive&15)===(successive>>>4)-1):ss===0&&se===63&&successive===0);
      for(let index=0;index<count;index++){const id=payload[1+2*index],table=payload[2+2*index];requireImage(frame.components.has(id)&&!seen.has(id)&&quant.has(frame.components.get(id))&&(table>>>4)<=3&&(table&15)<=3);seen.add(id);requireImage(ss===0?huffman.has(table>>>4):huffman.has(0x10|(table&15)));if(!frame.progressive)requireImage(huffman.has(0x10|(table&15)));}
      scans++;entropy=true;entropyBytes=0;
    }else if(marker===0xdd)requireImage(length===4);
    else requireImage((marker>=0xe0&&marker<=0xef)||marker===0xfe,'IMAGE_UNSUPPORTED');
  }
  throw fault('IMAGE_INVALID');
}
function webp(bytes){
  requireImage(bytes.length>=20&&bytes.readUInt32LE(4)+8===bytes.length&&bytes.length%2===0);let offset=12,extended,frame,alpha=false,iccp=false,exif=false,xmp=false;
  for(let chunks=0;offset<bytes.length;chunks++){
    requireImage(chunks<8192,'IMAGE_LIMIT');requireImage(offset+8<=bytes.length);const type=bytes.toString('latin1',offset,offset+4),length=bytes.readUInt32LE(offset+4),end=offset+8+length,padded=end+(length&1);requireImage(padded<=bytes.length&&(!(length&1)||bytes[end]===0));const payload=bytes.subarray(offset+8,end);
    if(type==='ANIM'||type==='ANMF')throw fault('IMAGE_ANIMATED');
    if(type==='VP8X'){requireImage(!extended&&offset===12&&length===10&&!(payload[0]&0xc1)&&payload[1]===0&&payload[2]===0&&payload[3]===0);if(payload[0]&2)throw fault('IMAGE_ANIMATED');extended={...dimensions(payload.readUIntLE(4,3)+1,payload.readUIntLE(7,3)+1),flags:payload[0]};}
    else if(type==='VP8 '){requireImage(!frame&&length>=11&&!(payload[0]&1)&&((payload[0]>>>1)&7)<=3&&(payload[0]&16)&&payload.subarray(3,6).equals(Buffer.from([0x9d,1,0x2a])));const partition=payload.readUIntLE(0,3)>>>5;requireImage(partition>0&&partition<=length-10);const width=payload.readUInt16LE(6),height=payload.readUInt16LE(8);requireImage(!(width&0xc000)&&!(height&0xc000),'IMAGE_UNSUPPORTED');frame={...dimensions(width,height),lossless:false,alpha};}
    else if(type==='VP8L'){requireImage(!frame&&!alpha&&length>=6&&payload[0]===0x2f);const value=payload.readUInt32LE(1);requireImage((value>>>29)===0);frame={...dimensions((value&0x3fff)+1,((value>>>14)&0x3fff)+1),lossless:true,alpha:Boolean(value&0x10000000)};}
    else if(type==='ALPH'){requireImage(Boolean(extended)&&!frame&&!alpha&&length>=1&&!(payload[0]&0xc0)&&(payload[0]&3)<=1&&((payload[0]>>>4)&3)<=1);alpha=true;}
    else if(type==='ICCP'){requireImage(Boolean(extended)&&!frame&&!alpha&&!iccp&&length>0);iccp=true;}
    else if(type==='EXIF'){requireImage(Boolean(extended)&&!exif&&length>0);exif=true;}
    else if(type==='XMP '){requireImage(Boolean(extended)&&!xmp&&length>0);xmp=true;}
    else throw fault('IMAGE_UNSUPPORTED');
    offset=padded;
  }
  requireImage(Boolean(frame));
  if(extended)requireImage(extended.width===frame.width&&extended.height===frame.height&&Boolean(extended.flags&0x20)===iccp&&Boolean(extended.flags&0x10)===frame.alpha&&Boolean(extended.flags&8)===exif&&Boolean(extended.flags&4)===xmp);
  else requireImage(offset===bytes.length&&bytes.toString('latin1',12,16)===(frame.lossless?'VP8L':'VP8 '));
  return {mime:'image/webp',width:frame.width,height:frame.height};
}
/** Bounded container/header checks, not a replacement for browser pixel decode. */
export function inspectImage(bytes){
  requireImage(Buffer.isBuffer(bytes));requireImage(bytes.length<=IMAGE_LIMITS.bytes,'IMAGE_LIMIT');
  if(bytes.length>=8&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return png(bytes);
  if(bytes.length>=2&&bytes[0]===255&&bytes[1]===0xd8)return jpeg(bytes);
  if(bytes.length>=12&&bytes.toString('latin1',0,4)==='RIFF'&&bytes.toString('latin1',8,12)==='WEBP')return webp(bytes);
  throw fault('IMAGE_UNSUPPORTED');
}
const same=(first,second)=>first.dev===second.dev&&first.ino===second.ino&&first.size===second.size&&first.mtimeMs===second.mtimeMs&&first.ctimeMs===second.ctimeMs;
const sensitive=relative=>relative.split(path.sep).some(part=>part.toLowerCase()==='.git'||part==='.DS_Store'||/^\.env(?:\.|$)/i.test(part));
export class ImageFileReader{
  constructor({maxConcurrent=4,readTimeoutMs=10000,closeTimeoutMs=10000}={}){this.operations=new Map();this.closed=false;this.maxConcurrent=maxConcurrent;this.readTimeoutMs=readTimeoutMs;this.closeTimeoutMs=closeTimeoutMs;}
  activities(){return [...this.operations.values()].map(operation=>({id:'image-'+operation.activityId,kind:'command',count:1,...(operation.projectId?{projectId:operation.projectId}:{})}));}
  _check(operation){if(operation.controller.signal.aborted)throw operation.controller.signal.reason;}
  async _load(root,relative,operation){
    requireImage(typeof relative==='string'&&relative.length>0&&!relative.includes('\0')&&!path.isAbsolute(relative)&&!relative.split('/').includes('..'),'IMAGE_UNSAFE_PATH');
    const canonicalRoot=await realpath(root),target=await projectFile(canonicalRoot,relative);requireImage(!sensitive(relative)&&!sensitive(path.relative(canonicalRoot,target)),'IMAGE_UNSAFE_PATH');this._check(operation);
    operation.handle=await open(target,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try{
      const before=await operation.handle.stat();requireImage(before.isFile(),'IMAGE_UNSAFE_PATH');requireImage(before.size<=IMAGE_LIMITS.bytes,'IMAGE_LIMIT');const chunks=[];let length=0;
      for(;;){this._check(operation);const bytes=Buffer.allocUnsafe(Math.min(65536,IMAGE_LIMITS.bytes+1-length));const {bytesRead}=await operation.handle.read(bytes,0,bytes.length,null);this._check(operation);if(!bytesRead)break;length+=bytesRead;requireImage(length<=IMAGE_LIMITS.bytes,'IMAGE_LIMIT');chunks.push(bytes.subarray(0,bytesRead));}
      const after=await operation.handle.stat(),current=await stat(target);requireImage(same(before,after)&&same(after,current)&&length===after.size&&await projectFile(canonicalRoot,relative)===target,'IMAGE_CHANGED');this._check(operation);
      const bytes=Buffer.concat(chunks,length),format=inspectImage(bytes);this._check(operation);const version=createHash('sha256').update(bytes).digest('hex');
      return {info:{path:relative,name:path.basename(target),size:length,modifiedAt:after.mtime.toISOString(),version,...format},bytes};
    }finally{try{await operation.handle.close();operation.handle=null;}catch{throw fault('IMAGE_CLEANUP_FAILED');}}
  }
  _operation(root,relative,{signal,projectId,requestId}={}){
    if(this.closed)return Promise.reject(fault('IMAGE_PLUGIN_DISABLED'));if(this.operations.size>=this.maxConcurrent)return Promise.reject(fault('IMAGE_BUSY'));
    const operation={id:randomUUID(),controller:new AbortController(),handle:null,projectId};operation.activityId=requestId??operation.id;const abort=()=>operation.controller.abort(fault('IMAGE_LOAD_ABORTED'));if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});const timer=setTimeout(()=>operation.controller.abort(fault('IMAGE_LOAD_TIMEOUT')),this.readTimeoutMs);
    operation.pending=Promise.resolve().then(()=>{this._check(operation);return this._load(root,relative,operation);}).catch(error=>{if(error.code?.startsWith('IMAGE_'))throw error;if(['OUTSIDE_PROJECT','INVALID_PATH'].includes(error.code??error.message))throw fault(error.code??error.message);if(error.code==='ENOENT')throw fault('IMAGE_NOT_FOUND');if(['ELOOP','ENOTDIR'].includes(error.code))throw fault('IMAGE_CHANGED');throw fault('IMAGE_READ_FAILED');}).finally(()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);if(!operation.handle)this.operations.delete(operation.id);});this.operations.set(operation.id,operation);return operation.pending;
  }
  async info(root,relative,options){return (await this._operation(root,relative,options)).info;}
  async read(root,relative,{version,...options}={}){requireImage(typeof version==='string'&&/^[a-f0-9]{64}$/.test(version),'IMAGE_VERSION_REQUIRED');const result=await this._operation(root,relative,options);requireImage(result.info.version===version,'IMAGE_CHANGED');return result;}
  close(){
    if(this.closing)return this.closing;this.closed=true;const operations=[...this.operations.values()];for(const operation of operations)operation.controller.abort(fault('IMAGE_LOAD_ABORTED'));let timer;
    const finish=async()=>{await Promise.allSettled(operations.map(operation=>operation.pending));for(const operation of this.operations.values())if(operation.handle){try{await operation.handle.close();operation.handle=null;this.operations.delete(operation.id);}catch{throw fault('IMAGE_CLEANUP_FAILED');}}if(this.operations.size)throw fault('IMAGE_CLEANUP_FAILED');};
    const closing=Promise.race([finish(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(fault('IMAGE_CLEANUP_FAILED')),this.closeTimeoutMs);})]).finally(()=>clearTimeout(timer));this.closing=closing;void closing.catch(()=>{if(this.closing===closing)this.closing=null;});return closing;
  }
}
