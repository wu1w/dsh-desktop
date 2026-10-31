import { controlledResponse, readEventStream, streamFault } from './lib/event-stream.js';
import {validateImageMetadata} from './lib/image-metadata.js';

let capability = '';
export async function initCapability({ signal, timeoutMs = 15000 } = {}) {
  const data = await controlledResponse(token => fetch('/api/bootstrap', { credentials: 'same-origin', signal: token }), async (result, transport) => {
    if (!result.ok) throw streamFault(`BOOTSTRAP_${result.status}`);
    if (!result.body) throw streamFault('BOOTSTRAP_BODY_MISSING');
    const chunks = []; let size = 0, block, used = 0;
    while (true) {
      const { value, done } = await transport.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16 * 1024 * 1024) throw streamFault('BOOTSTRAP_RESPONSE_LIMIT');
      let offset = 0;
      while (offset < value.byteLength) {
        if (!block) { block = new Uint8Array(16384); used = 0; }
        const length = Math.min(value.byteLength - offset, block.byteLength - used);
        block.set(value.subarray(offset, offset + length), used); used += length; offset += length;
        if (used === block.byteLength) { chunks.push(block); block = null; used = 0; }
      }
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    if (block) bytes.set(block.subarray(0, used), offset);
    let data;
    try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw streamFault('BOOTSTRAP_PROTOCOL'); }
    if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.capability !== 'string' || !data.capability) throw streamFault('BOOTSTRAP_PROTOCOL');
    transport.check();
    return data;
  }, signal, { timeoutMs, idle: false, timeoutCode: 'BOOTSTRAP_TIMEOUT', abortCode: 'BOOTSTRAP_ABORTED' });
  if (signal?.aborted) throw streamFault('BOOTSTRAP_ABORTED');
  capability = data.capability;
  return data;
}
export async function api(route, body, method = body === undefined ? 'GET' : 'POST', {signal} = {}) {
  const response = await fetch(`/api/${route}`, { method, credentials: 'same-origin', signal, headers: { 'Content-Type': 'application/json', 'X-DSH-Capability': capability, 'Accept-Language': document.documentElement.lang }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) {const error=new Error(data.message??data.error??`HTTP_${response.status}`);error.code=typeof data.error==='string'?data.error:typeof data.code==='string'?data.code:null;throw error;}
  return data;
}
export async function eventStream(onEvent, signal, options = {}) {
  return readEventStream(token => fetch('/api/events', { headers: { 'X-DSH-Capability': capability }, signal: token }), onEvent, signal, options);
}

// Images use the same authenticated local API as documents. A Blob URL is
// created only by the mounted preview, after bounded bytes and identity agree.
export async function apiImage(projectId,relative,metadata,{signal,timeoutMs=15000}={}){
  const info=validateImageMetadata(metadata,relative);
  const route=`/api/projects/${encodeURIComponent(projectId)}/image?path=${encodeURIComponent(relative)}&version=${info.version}`;
  return controlledResponse(token=>fetch(route,{credentials:'same-origin',signal:token,headers:{'X-DSH-Capability':capability,'Accept-Language':document.documentElement.lang,'Accept':info.mime}}),async(response,transport)=>{
    const readBytes=async limit=>{
      const chunks=[];let length=0;
      for(;;){const {done,value}=await transport.read();if(done)break;if(!(value instanceof Uint8Array)||length+value.byteLength>limit)throw streamFault('IMAGE_RESPONSE_INVALID');chunks.push(value);length+=value.byteLength;}
      const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}transport.check();return bytes;
    };
    if(!response.ok){const bytes=await readBytes(8192);let data;try{data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw streamFault('IMAGE_RESPONSE_INVALID');}const code=typeof data?.code==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(data.code)?data.code:'IMAGE_LOAD_FAILED';throw Object.assign(new Error(typeof data?.message==='string'?data.message:code),{code});}
    if(response.headers.get('content-type')!==info.mime||response.headers.get('x-dsh-image-version')!==info.version||response.headers.get('content-length')!==String(info.size))throw streamFault('IMAGE_RESPONSE_INVALID');
    const bytes=await readBytes(info.size);if(bytes.byteLength!==info.size)throw streamFault('IMAGE_RESPONSE_INVALID');
    const digest=await transport.wait(globalThis.crypto.subtle.digest('SHA-256',bytes));transport.check();
    const hash=[...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
    if(hash!==info.version)throw streamFault('IMAGE_RESPONSE_INVALID');
    return new Blob([bytes],{type:info.mime});
  },signal,{timeoutMs,idle:false,timeoutCode:'IMAGE_LOAD_TIMEOUT',abortCode:'IMAGE_LOAD_ABORTED'});
}
