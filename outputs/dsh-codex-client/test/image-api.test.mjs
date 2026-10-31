import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {get} from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {images,pngWith} from './image-files-fixtures.mjs';
import {imageErrors} from '../shared/image-errors.js';
const appRoot=process.env.DSH_ACCEPTANCE_APP_ROOT;
const {startHost}=await import(appRoot?pathToFileURL(path.join(appRoot,'server/index.mjs')):new URL('../server/index.mjs',import.meta.url));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),execute=promisify(execFile);
async function until(check){const deadline=Date.now()+5000;while(!await check()){if(Date.now()>deadline)throw Error('FIXTURE_TIMEOUT');await sleep(5);}}
async function setup(){const root=await fs.realpath(await fs.mkdtemp(path.join(tmpdir(),'dsh-image-api-'))),projectPath=path.join(root,'project');await fs.mkdir(projectPath);const host=await startHost({dataDir:path.join(root,'data'),autoStart:false}),response=await fetch(host.url+'/api/bootstrap'),boot=await response.json(),headers={cookie:response.headers.get('set-cookie').split(';')[0],'x-dsh-capability':boot.capability,'content-type':'application/json','accept-language':'en'};const api=async(route,body,options={})=>{const response=await fetch(host.url+'/api/'+route,{headers:{...headers,...options.headers},method:body===undefined?'GET':'POST',body:body===undefined?undefined:JSON.stringify(body),signal:options.signal});return {status:response.status,body:await response.json()};};const project=(await api('projects',{path:projectPath})).body;return {root,host,headers,api,project,projectPath};}

test('authenticated static-image HTTP validates versions and containers, preserves original bytes and survives plugin restart',{timeout:20000},async t=>{
  const f=await setup();try{const base=`projects/${f.project.id}/`,query=name=>'?path='+encodeURIComponent(name),name='中文\\图片.any';await fs.writeFile(path.join(f.projectPath,name),images.png);const before=await fs.stat(path.join(f.projectPath,name));let info;
    await t.test('metadata shape, headers, content length, SHA256 and exact original bytes match',async()=>{
      const result=await f.api(base+'image-info'+query(name));assert.equal(result.status,200);info=result.body;assert.deepEqual(Object.keys(info).sort(),['path','name','size','modifiedAt','version','mime','width','height'].sort());assert.equal(info.path,name);assert.equal(info.name,name);assert.equal(info.size,images.png.length);assert.equal(info.modifiedAt,before.mtime.toISOString());assert.equal(info.version,createHash('sha256').update(images.png).digest('hex'));assert.equal(info.mime,'image/png');assert.equal(info.width,4);assert.equal(info.height,3);
      const response=await fetch(f.host.url+'/api/'+base+'image'+query(name)+'&version='+info.version,{headers:f.headers});assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/png');assert.equal(response.headers.get('content-length'),String(images.png.length));assert.equal(response.headers.get('x-dsh-image-version'),info.version);assert.equal(response.headers.get('x-content-type-options'),'nosniff');assert.equal(response.headers.get('cache-control'),'no-store');assert.deepEqual(Buffer.from(await response.arrayBuffer()),images.png);assert.equal((await fs.stat(path.join(f.projectPath,name))).mtimeMs,before.mtimeMs);assert.equal(f.host.engine,undefined);
    });
    await t.test('unauthenticated access never returns raw bytes or metadata',async()=>{for(const route of ['image-info','image']){const response=await fetch(f.host.url+'/api/'+base+route+query(name)+'&version='+info.version);assert.equal(response.status,403);assert.equal((await response.json()).code,'FORBIDDEN');}});
    await t.test('method/segment/parameter/version validation cannot be bypassed',async()=>{
      for(const [route,body]of [[base+'image-info',undefined],[base+'image-info/extra'+query(name),undefined],[base+'image-info'+query(name)+'&path=other',undefined],[base+'image-info'+query(name),{}]])assert.equal((await f.api(route,body)).body.code,'INVALID_REQUEST');
      for(const suffix of ['', '&version=bad', '&version='+info.version.toUpperCase(),'&version='+info.version+'&version='+info.version])assert.equal((await f.api(base+'image'+query(name)+suffix)).body.code,'IMAGE_VERSION_REQUIRED');
      assert.equal((await f.api('projects/missing/image-info'+query(name))).status,404);
    });
    await t.test('same name changed content rejects the old hash without altering its new bytes',async()=>{await fs.writeFile(path.join(f.projectPath,name),images.jpeg);const stale=await f.api(base+'image'+query(name)+'&version='+info.version);assert.equal(stale.status,400);assert.equal(stale.body.code,'IMAGE_CHANGED');assert.deepEqual(await fs.readFile(path.join(f.projectPath,name)),images.jpeg);assert.equal((await f.api(base+'image-info'+query(name))).body.mime,'image/jpeg');});
    await t.test('animated, malformed and over-limit files give localized errors, never raw detail',async()=>{
      for(const [file,bytes,code,locale,index]of [['animated.png',pngWith('acTL',Buffer.alloc(8)),'IMAGE_ANIMATED','en',1],['bad.png',images.png.subarray(0,20),'IMAGE_INVALID','zh-CN',0],['vector.svg',Buffer.from('<svg>PRIVATE_CONTENT</svg>'),'IMAGE_UNSUPPORTED','en',1]]){await fs.writeFile(path.join(f.projectPath,file),bytes);const result=await f.api(base+'image-info'+query(file),undefined,{headers:{'accept-language':locale}});assert.equal(result.status,400);assert.equal(result.body.code,code);assert.equal(result.body.message,imageErrors[code][index]);assert.equal(JSON.stringify(result.body).includes('PRIVATE_CONTENT'),false);}
      await fs.writeFile(path.join(f.projectPath,'large.png'),'');await fs.truncate(path.join(f.projectPath,'large.png'),16*1024*1024+1);assert.equal((await f.api(base+'image-info'+query('large.png'))).body.code,'IMAGE_LIMIT');
    });
    await t.test('directory/FIFO/absolute/traversal/external and metadata aliases fail closed',async()=>{
      await fs.mkdir(path.join(f.projectPath,'folder'));await execute('mkfifo',[path.join(f.projectPath,'fifo')]);await fs.writeFile(path.join(f.root,'outside'),images.png);await fs.symlink(path.join(f.root,'outside'),path.join(f.projectPath,'alias'));await fs.mkdir(path.join(f.projectPath,'.git'));await fs.writeFile(path.join(f.projectPath,'.git','icon'),images.png);await fs.symlink('.git/icon',path.join(f.projectPath,'metadata'));
      for(const relative of ['folder','fifo','../outside',path.join(f.root,'outside'),'alias','.git/icon','metadata']){const result=await f.api(base+'image-info'+query(relative));assert.equal(result.status,400);assert.ok(['IMAGE_UNSAFE_PATH','OUTSIDE_PROJECT'].includes(result.body.code));}
    });
    await t.test('plugin disable removes both routes, enable restores them and independent host restart keeps content valid',async()=>{
      assert.equal((await f.api('plugins/feature-images/disable',{})).status,200);assert.equal((await f.api(base+'image-info'+query(name))).status,404);assert.equal((await f.api('plugins/feature-images/enable',{})).status,200);assert.equal((await f.api(base+'image-info'+query(name))).status,200);await f.host.close();f.host=await startHost({dataDir:path.join(f.root,'data'),autoStart:false});const response=await fetch(f.host.url+'/api/bootstrap'),boot=await response.json();f.headers.cookie=response.headers.get('set-cookie').split(';')[0];f.headers['x-dsh-capability']=boot.capability;
      const current=await fetch(f.host.url+'/api/'+base+'image-info'+query(name),{headers:f.headers});assert.equal(current.status,200);assert.equal((await current.json()).mime,'image/jpeg');assert.deepEqual(await fs.readFile(path.join(f.projectPath,name)),images.jpeg);assert.equal(f.host.engine,undefined);
    });
  }finally{await f.host.close();await fs.rm(f.root,{recursive:true,force:true});}
});

test('real paused HTTP consumer keeps a stable owned transfer activity until plugin stop cancels it',{timeout:20000},async()=>{
  const f=await setup();let request,response;try{const name='large.png',bytes=pngWith('raNd',Buffer.alloc(12*1024*1024,65));await fs.writeFile(path.join(f.projectPath,name),bytes);const route=`projects/${f.project.id}/`,info=(await f.api(route+'image-info?path='+name)).body;
    await new Promise((resolve,reject)=>{request=get(f.host.url+'/api/'+route+'image?path='+name+'&version='+info.version,{headers:f.headers},res=>{response=res;res.pause();res.on('error',()=>{});resolve();});request.on('error',reject);});assert.equal(response.statusCode,200);assert.equal(response.readableEnded,false);
    const activities=()=>f.api('state').then(result=>result.body.activities.filter(row=>row.pluginId==='feature-images'));await until(async()=>(await activities()).length===1);const first=(await activities())[0];await sleep(30);assert.equal((await activities())[0].id,first.id);assert.equal(first.projectId,f.project.id);
    const started=Date.now(),stopped=await f.api('plugins/feature-images/disable',{});assert.equal(stopped.status,200);assert.ok(Date.now()-started<3000);assert.deepEqual(await activities(),[]);assert.equal((await f.api(route+'image-info?path='+name)).status,404);assert.deepEqual(await fs.readFile(path.join(f.projectPath,name)),bytes);assert.equal((await f.api('plugins/feature-images/enable',{})).status,200);assert.equal((await f.api(route+'image-info?path='+name)).status,200);
  }finally{response?.destroy();request?.destroy();await f.host.close();await fs.rm(f.root,{recursive:true,force:true});}
});

test('failed descriptor cleanup blocks image-plugin disable, retains activity and allows a real cleanup retry',{timeout:20000},async t=>{
  const f=await setup(),nativeOpen=fs.open,target=path.join(f.projectPath,'close.png');let refuse=true;
  try{await fs.writeFile(target,images.png);t.mock.method(fs,'open',async(...args)=>{const handle=await nativeOpen(...args);if(args[0]!==target)return handle;return {stat:()=>handle.stat(),read:(...args)=>handle.read(...args),close:async()=>{if(refuse)throw Object.assign(new Error('PRIVATE_CLOSE_DETAIL'),{code:'EIO'});await handle.close();}};});syncBuiltinESMExports();
    const result=await f.api(`projects/${f.project.id}/image-info?path=close.png`);assert.equal(result.body.code,'IMAGE_CLEANUP_FAILED');const activity=(await f.api('state')).body.activities.find(row=>row.pluginId==='feature-images');assert.ok(activity);
    const stop=await f.api('plugins/feature-images/disable',{});assert.equal(stop.body.code,'IMAGE_CLEANUP_FAILED');const state=(await f.api('state')).body;assert.equal(state.features.includes('feature-images'),true);assert.equal(state.activities.find(row=>row.id===activity.id).id,activity.id);assert.equal(JSON.stringify(stop.body).includes('PRIVATE_CLOSE_DETAIL'),false);
    refuse=false;assert.equal((await f.api('plugins/feature-images/disable',{})).status,200);assert.equal((await f.api('state')).body.activities.some(row=>row.pluginId==='feature-images'),false);assert.equal((await f.api('plugins/feature-images/enable',{})).status,200);assert.equal((await f.api(`projects/${f.project.id}/image-info?path=close.png`)).status,200);
  }finally{refuse=false;t.mock.restoreAll();syncBuiltinESMExports();await f.host.close();await fs.rm(f.root,{recursive:true,force:true});}
});

test('HTTP disconnect and plugin stop await their own actual in-flight file descriptor cleanup',{timeout:20000},async t=>{
  const f=await setup(),nativeOpen=fs.open,target=path.join(f.projectPath,'hold.png');let release,entered=0,closed=0,gate;
  const newGate=()=>{gate=new Promise(resolve=>{release=resolve;});};
  try{await fs.writeFile(target,images.png);newGate();t.mock.method(fs,'open',async(...args)=>{const handle=await nativeOpen(...args);if(args[0]!==target)return handle;return {stat:()=>handle.stat(),read:async(...args)=>{entered++;await gate;return handle.read(...args);},close:async()=>{await handle.close();closed++;}};});syncBuiltinESMExports();
    const route=`projects/${f.project.id}/image-info?path=hold.png`,activities=()=>f.api('state').then(result=>result.body.activities.filter(row=>row.pluginId==='feature-images'));
    const controller=new AbortController(),pending=f.api(route,undefined,{signal:controller.signal}).then(value=>({value}),error=>({error}));await until(()=>entered===1);controller.abort();assert.equal((await pending).error.name,'AbortError');assert.equal((await activities()).length,1);assert.equal(closed,0);release();await until(async()=>closed===1&&(await activities()).length===0);
    newGate();const started=entered,pendingStopRead=f.api(route).then(value=>({value}),error=>({error}));await until(()=>entered>started);let settled=false;const stop=f.api('plugins/feature-images/disable',{}).then(result=>{settled=true;return result;});await sleep(30);assert.equal(settled,false);assert.equal(closed,1);release();assert.equal((await stop).status,200);assert.ok((await pendingStopRead).error);assert.equal(closed,2);assert.deepEqual(await activities(),[]);
  }finally{release?.();t.mock.restoreAll();syncBuiltinESMExports();await f.host.close();await fs.rm(f.root,{recursive:true,force:true});}
});
