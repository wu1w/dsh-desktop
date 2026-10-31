import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {crc32} from 'node:zlib';
import {ImageFileReader,inspectImage,IMAGE_LIMITS} from '../server/image-files.mjs';
import {images,pngChunk,pngWith,pngDimensions,riff} from './image-files-fixtures.mjs';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),execute=promisify(execFile);
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
async function until(check){const deadline=Date.now()+3000;while(!await check()){if(Date.now()>deadline)throw Error('FIXTURE_TIMEOUT');await sleep(2);}}
const code=(fn,expected='IMAGE_INVALID')=>assert.throws(fn,{code:expected});
async function project(){return fs.realpath(await fs.mkdtemp(path.join(tmpdir(),'dsh-images-')));}

test('real encoder-produced static PNG, baseline/progressive JPEG and lossy/lossless/alpha WebP expose encoded dimensions',()=>{
  for(const [name,bytes]of Object.entries(images))assert.deepEqual(inspectImage(bytes),{mime:name==='png'?'image/png':['jpeg','progressive'].includes(name)?'image/jpeg':'image/webp',width:4,height:3});
});
test('magic alone, truncated containers, SVG/GIF and unrelated binary are rejected with fixed image codes',()=>{
  for(const bytes of [Buffer.from('GIF89a'),Buffer.from('<svg/>'),Buffer.alloc(20),images.png.subarray(0,8),images.jpeg.subarray(0,2),images.webp.subarray(0,12)])assert.throws(()=>inspectImage(bytes),error=>/^IMAGE_/.test(error.code));
  for(const bytes of Object.values(images)){code(()=>inspectImage(bytes.subarray(0,bytes.length-1)));code(()=>inspectImage(Buffer.concat([bytes,Buffer.from([0])])));}
});
test('PNG validates CRC, IHDR/order/palette/IDAT continuity/IEND and rejects APNG chunks',()=>{
  const crc=Buffer.from(images.png);crc[25]^=1;code(()=>inspectImage(crc));
  code(()=>inspectImage(Buffer.concat([images.png.subarray(0,33),images.png.subarray(8)])));
  code(()=>inspectImage(pngWith('ABCD',Buffer.alloc(1))),'IMAGE_UNSUPPORTED');
  for(const type of ['acTL','fcTL','fdAT'])code(()=>inspectImage(pngWith(type,Buffer.alloc(8))),'IMAGE_ANIMATED');
  const payload=Buffer.from(images.png.subarray(16,29));payload[9]=3;
  code(()=>inspectImage(Buffer.concat([images.png.subarray(0,8),pngChunk('IHDR',payload),images.png.subarray(33)])));
  code(()=>inspectImage(Buffer.concat([images.png.subarray(0,-12),pngChunk('teSt'),pngChunk('IDAT',Buffer.from([1])),images.png.subarray(-12)])));
  const bad=Buffer.from(payload);bad[10]=1;code(()=>inspectImage(Buffer.concat([images.png.subarray(0,8),pngChunk('IHDR',bad),images.png.subarray(33)])));
});
test('image size/pixel/side limits use actual encoded headers and total bytes',()=>{
  for(const [width,height]of [[16385,1],[8000,8000]])code(()=>inspectImage(pngDimensions(width,height)),'IMAGE_LIMIT');
  code(()=>inspectImage(pngDimensions(0,1)));
  code(()=>inspectImage(Buffer.alloc(IMAGE_LIMITS.bytes+1)),'IMAGE_LIMIT');
});
test('JPEG validates frame/scan references, supported coding and segment boundaries',()=>{
  const find=marker=>images.jpeg.indexOf(Buffer.from([255,marker]));
  const frame=Buffer.from(images.jpeg);frame[find(0xc0)+4]=12;code(()=>inspectImage(frame),'IMAGE_UNSUPPORTED');
  const length=Buffer.from(images.jpeg);length.writeUInt16BE(1,find(0xda)+2);code(()=>inspectImage(length));
  const reference=Buffer.from(images.jpeg);reference[find(0xda)+5]=88;code(()=>inspectImage(reference));
  const scan=Buffer.from(images.jpeg);scan[find(0xda)+scan.readUInt16BE(find(0xda)+2)+1]=1;code(()=>inspectImage(scan));
  const height=Buffer.from(images.jpeg);height.writeUInt16BE(0,find(0xc0)+5);code(()=>inspectImage(height));
});
test('WebP validates RIFF size/padding/chunk order/header flags and rejects animation',()=>{
  const payload=images.webp.subarray(20),extended=Buffer.from(images.alphaWebp.subarray(20,30));extended[0]=0;
  const simple=riff([['VP8X',extended],['VP8 ',payload]]);assert.equal(inspectImage(simple).width,4);
  const animated=Buffer.from(extended);animated[0]=2;code(()=>inspectImage(riff([['VP8X',animated],['VP8 ',payload]])),'IMAGE_ANIMATED');
  for(const type of ['ANIM','ANMF'])code(()=>inspectImage(riff([[type,Buffer.alloc(0)],['VP8 ',payload]])),'IMAGE_ANIMATED');
  code(()=>inspectImage(riff([['ALPH',Buffer.from([0])],['VP8 ',payload]])));
  code(()=>inspectImage(riff([['VP8 ',payload],['VP8 ',payload]])));
  const size=Buffer.from(images.webp);size.writeUInt32LE(0,4);code(()=>inspectImage(size));
  const padding=Buffer.from(images.lossless);padding[padding.length-1]=1;code(()=>inspectImage(padding));
  const canvas=Buffer.from(extended);canvas[4]=4;code(()=>inspectImage(riff([['VP8X',canvas],['VP8 ',payload]])));
  const reserved=Buffer.from(extended);reserved[1]=1;code(()=>inspectImage(riff([['VP8X',reserved],['VP8 ',payload]])));
  const lossless=Buffer.from(images.lossless);lossless[24]|=0xe0;code(()=>inspectImage(lossless));
});
test('bounded random malformed frames never leak Buffer range exceptions',()=>{
  let value=1234567;for(let index=0;index<300;index++){const bytes=Buffer.alloc(index%95+2);for(let offset=0;offset<bytes.length;offset++){value=(value*1664525+1013904223)>>>0;bytes[offset]=value&255;}if(index%3===0){bytes[0]=255;bytes[1]=216;}try{inspectImage(bytes);}catch(error){assert.match(error.code,/^IMAGE_/);assert.equal(error instanceof RangeError,false);}}
});
test('real file metadata/hash/raw bytes match and old versions fail without changing the original file',async()=>{
  const root=await project(),reader=new ImageFileReader();try{const target=path.join(root,'中文\\photo.bin');await fs.writeFile(target,images.png);const before=await fs.stat(target),info=await reader.info(root,path.basename(target));assert.deepEqual(info,{path:path.basename(target),name:path.basename(target),size:images.png.length,modifiedAt:before.mtime.toISOString(),version:createHash('sha256').update(images.png).digest('hex'),mime:'image/png',width:4,height:3});assert.deepEqual((await reader.read(root,path.basename(target),{version:info.version})).bytes,images.png);assert.equal((await fs.stat(target)).mtimeMs,before.mtimeMs);await fs.writeFile(target,images.jpeg);await assert.rejects(reader.read(root,path.basename(target),{version:info.version}),{code:'IMAGE_CHANGED'});await assert.rejects(reader.read(root,path.basename(target),{version:'ABC'}),{code:'IMAGE_VERSION_REQUIRED'});assert.deepEqual(await fs.readFile(target),images.jpeg);assert.deepEqual(reader.activities(),[]);}finally{await reader.close();await fs.rm(root,{recursive:true,force:true});}
});
test('real directory/FIFO/traversal/external aliases and sensitive canonical metadata paths fail closed',async()=>{
  const root=await project(),reader=new ImageFileReader(),outside=root+'-outside';try{await fs.writeFile(outside,images.png);await fs.mkdir(path.join(root,'folder'));await execute('mkfifo',[path.join(root,'fifo')]);await fs.symlink(outside,path.join(root,'outside.png'));await fs.mkdir(path.join(root,'.git'));await fs.writeFile(path.join(root,'.git','picture.png'),images.png);await fs.symlink('.git/picture.png',path.join(root,'alias.png'));await fs.writeFile(path.join(root,'.env.png'),images.png);
    for(const name of ['folder','fifo','.git/picture.png','alias.png','.env.png','../outside',outside,'nul\0name'])await assert.rejects(reader.info(root,name),error=>['IMAGE_UNSAFE_PATH','OUTSIDE_PROJECT'].includes(error.code));await assert.rejects(reader.info(root,'outside.png'),{code:'OUTSIDE_PROJECT'});assert.equal(reader.activities().length,0);
  }finally{await reader.close();await fs.rm(root,{recursive:true,force:true});await fs.rm(outside,{force:true});}
});
test('read growth is capped at 16 MiB plus one byte even after a small initial fstat',async t=>{
  const root=await project(),target=path.join(root,'grow.png'),reader=new ImageFileReader(),nativeOpen=fs.open;let consumed=0,grew=false,closed=0;
  try{await fs.writeFile(target,images.png);t.mock.method(fs,'open',async(...args)=>{const handle=await nativeOpen(...args);if(args[0]!==target)return handle;return {stat:()=>handle.stat(),read:async(...readArgs)=>{const result=await handle.read(...readArgs);consumed+=result.bytesRead;if(!grew){grew=true;await fs.appendFile(target,Buffer.alloc(IMAGE_LIMITS.bytes));}return result;},close:async()=>{closed++;await handle.close();}};});syncBuiltinESMExports();await assert.rejects(reader.info(root,'grow.png'),{code:'IMAGE_LIMIT'});assert.equal(consumed,IMAGE_LIMITS.bytes+1);assert.equal(closed,1);assert.equal(reader.activities().length,0);
  }finally{t.mock.restoreAll();syncBuiltinESMExports();await reader.close();await fs.rm(root,{recursive:true,force:true});}
});
test('cancellation, concurrency and close deadline retain pending handles until actual read returns',async t=>{
  const root=await project(),target=path.join(root,'hold.png'),gate=deferred(),reader=new ImageFileReader({maxConcurrent:1,closeTimeoutMs:25}),nativeOpen=fs.open;let entered=false,closed=0;
  try{await fs.writeFile(target,images.png);t.mock.method(fs,'open',async(...args)=>{const handle=await nativeOpen(...args);return {stat:()=>handle.stat(),read:async(...readArgs)=>{entered=true;await gate.promise;return handle.read(...readArgs);},close:async()=>{closed++;await handle.close();}};});syncBuiltinESMExports();const pending=reader.info(root,'hold.png').then(value=>({value}),error=>({error}));await until(()=>entered);await assert.rejects(reader.info(root,'hold.png'),{code:'IMAGE_BUSY'});const activity=reader.activities()[0];await assert.rejects(reader.close(),{code:'IMAGE_CLEANUP_FAILED'});assert.equal(reader.activities()[0].id,activity.id);assert.equal(closed,0);gate.resolve();assert.equal((await pending).error.code,'IMAGE_LOAD_ABORTED');await reader.close();assert.equal(closed,1);assert.equal(reader.activities().length,0);await assert.rejects(reader.info(root,'hold.png'),{code:'IMAGE_PLUGIN_DISABLED'});
  }finally{gate.resolve();t.mock.restoreAll();syncBuiltinESMExports();await reader.close();await fs.rm(root,{recursive:true,force:true});}
});
test('read timeout and already-aborted requests close handles and expose explicit cancellation codes',async t=>{
  const root=await project(),target=path.join(root,'timeout.png'),reader=new ImageFileReader({readTimeoutMs:10}),nativeOpen=fs.open,entered=deferred(),gate=deferred();let closed=0;
  try{await fs.writeFile(target,images.png);t.mock.timers.enable({apis:['setTimeout']});t.mock.method(fs,'open',async(...args)=>{const handle=await nativeOpen(...args);return {stat:()=>handle.stat(),read:async(...readArgs)=>{entered.resolve();await gate.promise;return handle.read(...readArgs);},close:async()=>{closed++;await handle.close();}};});syncBuiltinESMExports();const pending=assert.rejects(reader.info(root,'timeout.png'),{code:'IMAGE_LOAD_TIMEOUT'});await entered.promise;assert.equal(reader.activities().length,1);t.mock.timers.tick(10);assert.equal(closed,0);gate.resolve();await pending;assert.equal(closed,1);const controller=new AbortController();controller.abort();await assert.rejects(reader.info(root,'timeout.png',{signal:controller.signal}),{code:'IMAGE_LOAD_ABORTED'});assert.equal(closed,1);assert.equal(reader.activities().length,0);
  }finally{gate.resolve();t.mock.restoreAll();t.mock.timers.reset();syncBuiltinESMExports();await reader.close();await fs.rm(root,{recursive:true,force:true});}
});
test('timeout during real path resolution rejects before opening a descriptor, with no cleanup handle to close',async t=>{
  const root=await project(),target=path.join(root,'before-open.png'),reader=new ImageFileReader({readTimeoutMs:10}),nativeRealpath=fs.realpath,nativeOpen=fs.open,entered=deferred(),gate=deferred();let opened=0;
  try{await fs.writeFile(target,images.png);t.mock.timers.enable({apis:['setTimeout']});t.mock.method(fs,'realpath',async(...args)=>{entered.resolve();await gate.promise;return nativeRealpath(...args);});t.mock.method(fs,'open',async(...args)=>{opened++;return nativeOpen(...args);});syncBuiltinESMExports();const pending=assert.rejects(reader.info(root,'before-open.png'),{code:'IMAGE_LOAD_TIMEOUT'});await entered.promise;t.mock.timers.tick(10);gate.resolve();await pending;assert.equal(opened,0);assert.equal(reader.activities().length,0);
  }finally{gate.resolve();t.mock.restoreAll();t.mock.timers.reset();syncBuiltinESMExports();await reader.close();await fs.rm(root,{recursive:true,force:true});}
});

test('failed descriptor close retains activity and retries cleanup instead of falsely declaring success',async t=>{
  const root=await project(),reader=new ImageFileReader(),nativeOpen=fs.open;let refuse=true;
  try{await fs.writeFile(path.join(root,'close.png'),images.png);t.mock.method(fs,'open',async(...args)=>{const handle=await nativeOpen(...args);return {stat:()=>handle.stat(),read:(...args)=>handle.read(...args),close:async()=>{if(refuse)throw Object.assign(new Error('private'),{code:'EIO'});await handle.close();}};});syncBuiltinESMExports();await assert.rejects(reader.info(root,'close.png'),{code:'IMAGE_CLEANUP_FAILED'});assert.equal(reader.activities().length,1);await assert.rejects(reader.close(),{code:'IMAGE_CLEANUP_FAILED'});assert.equal(reader.activities().length,1);refuse=false;await reader.close();assert.equal(reader.activities().length,0);
  }finally{refuse=false;t.mock.restoreAll();syncBuiltinESMExports();await reader.close();await fs.rm(root,{recursive:true,force:true});}
});

test('a file that changes during an otherwise bounded read is rejected after descriptor/path revalidation',async t=>{
  const root=await project(),target=path.join(root,'change.png'),reader=new ImageFileReader(),nativeOpen=fs.open;let changed=false,closed=0;
  try{await fs.writeFile(target,images.png);t.mock.method(fs,'open',async(...args)=>{const handle=await nativeOpen(...args);return {stat:()=>handle.stat(),read:async(...readArgs)=>{const result=await handle.read(...readArgs);if(!changed){changed=true;await fs.appendFile(target,Buffer.from('external'));}return result;},close:async()=>{closed++;await handle.close();}};});syncBuiltinESMExports();await assert.rejects(reader.info(root,'change.png'),{code:'IMAGE_CHANGED'});assert.equal(closed,1);assert.deepEqual(await fs.readFile(target),Buffer.concat([images.png,Buffer.from('external')]));assert.equal(reader.activities().length,0);
  }finally{t.mock.restoreAll();syncBuiltinESMExports();await reader.close();await fs.rm(root,{recursive:true,force:true});}
});


test('image identifiers require exact ASCII bytes and never alias high-bit bytes through ASCII decoding',()=>{
  for(const offset of [0,8,12]){const bytes=Buffer.from(images.webp);bytes[offset]|=0x80;code(()=>inspectImage(bytes),'IMAGE_UNSUPPORTED');}
  const bytes=Buffer.from(images.png);bytes[12]|=0x80;bytes.writeUInt32BE(crc32(bytes.subarray(12,29)),29);code(()=>inspectImage(bytes));
});


test('progressive JPEG refinement scans require Al to be exactly Ah minus one',()=>{
  const bytes=Buffer.from(images.progressive),offset=bytes.indexOf(Buffer.from([255,0xda]));bytes[offset+1+bytes.readUInt16BE(offset+2)]=0x20;code(()=>inspectImage(bytes));
});
