import {open,lstat,mkdir,rename,unlink,rmdir} from 'node:fs/promises';
import fs,{constants} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import path from 'node:path';
import lockfile from 'proper-lockfile';

const MAX_BYTES=64*1024,MAX_ROWS=64,MAX_FILE_BYTES=8*1024*1024;
const ID=/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const VERSION=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fault=code=>Object.assign(new Error(code),{code});
const valid=condition=>{if(!condition)throw fault('GIT_DRAFT_INVALID');};
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const goodText=(value,max)=>typeof value==='string'&&!value.includes('\0')&&Buffer.byteLength(value)<=max&&Buffer.from(value).toString('utf8')===value;
function projectId(value){valid(typeof value==='string'&&ID.test(value));return value;}
function baseVersion(value){valid(value===null||(typeof value==='string'&&VERSION.test(value)));return value;}
function fields(value){
  valid(plain(value));const row={projectId:projectId(value.projectId),message:value.message,authorName:value.authorName,authorEmail:value.authorEmail};
  valid(goodText(row.message,Number.MAX_SAFE_INTEGER)&&goodText(row.authorName,Number.MAX_SAFE_INTEGER)&&goodText(row.authorEmail,Number.MAX_SAFE_INTEGER));
  if(Buffer.byteLength(row.message)>MAX_BYTES||Buffer.byteLength(row.authorName)>1024||Buffer.byteLength(row.authorEmail)>1024)throw fault('GIT_DRAFT_LIMIT');
  if(Buffer.byteLength(row.message)+Buffer.byteLength(row.authorName)+Buffer.byteLength(row.authorEmail)>MAX_BYTES)throw fault('GIT_DRAFT_LIMIT');
  return row;
}
function encode(rows){
  if(rows.size>MAX_ROWS)throw fault('GIT_DRAFT_LIMIT');
  const bytes=Buffer.from(JSON.stringify({version:1,drafts:[...rows.values()]})+'\n');
  if(bytes.length>MAX_FILE_BYTES)throw fault('GIT_DRAFT_LIMIT');return bytes;
}
function parse(bytes){
  try{
    const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));valid(plain(value)&&value.version===1&&Array.isArray(value.drafts)&&value.drafts.length<=MAX_ROWS&&Object.keys(value).every(key=>['version','drafts'].includes(key)));
    const rows=new Map();
    for(const input of value.drafts){const row=fields(input);valid(Object.keys(input).length===6&&VERSION.test(input.version)&&typeof input.updatedAt==='string'&&new Date(input.updatedAt).toISOString()===input.updatedAt&&!rows.has(row.projectId));rows.set(row.projectId,{...row,version:input.version,updatedAt:input.updatedAt});}
    encode(rows);return rows;
  }catch(error){throw error.code==='GIT_DRAFT_LIMIT'?error:fault('GIT_DRAFT_CORRUPT');}
}
const fingerprint=(bytes,info)=>JSON.stringify([info.dev,info.ino,info.size,info.mtimeMs,createHash('sha256').update(bytes).digest('hex')]);

/** Independent, bounded Git input recovery; never opens a project Git file. */
export class GitDraftStore{
  constructor({dataDir,closeTimeoutMs=10000}={}){if(typeof dataDir!=='string'||!path.isAbsolute(dataDir)||dataDir.includes('\0'))throw fault('GIT_DRAFT_STORAGE_UNSAFE');this.dataDir=path.resolve(dataDir);this.file=path.join(this.dataDir,'git-drafts.json');this.lockPath=path.join(this.dataDir,'.git-drafts.lock');this.serial=Promise.resolve();this.closed=false;this.closeTimeoutMs=closeTimeoutMs;this.operations=new Map();this.stopFailures=new Map();this.cleanupTasks=new Set();}
  _queue(work,writing=false,project){
    if(this.closed)return Promise.reject(fault('GIT_DRAFT_CLOSED'));
    const operation={id:randomUUID(),writing,projectId:project,protectOnFailure:false};
    const run=this.serial.then(async()=>{
      this.activeOperation=operation;
      try{if(writing&&this.cleanupTasks.size)await Promise.all([...this.cleanupTasks].map(resource=>this._cleanup(resource)));const result=await work();if(writing)this.stopFailures.delete(project);return result;}
      catch(error){const failure=error.code?.startsWith('GIT_DRAFT_')?error:fault(writing?'GIT_DRAFT_WRITE_FAILED':'GIT_DRAFT_READ_FAILED');if(writing&&operation.protectOnFailure&&failure.code==='GIT_DRAFT_WRITE_FAILED')this.stopFailures.set(project,operation.id);throw failure;}
      finally{this.operations.delete(operation.id);if(this.activeOperation===operation)this.activeOperation=null;}
    });
    operation.promise=run;this.operations.set(operation.id,operation);this.serial=run.catch(()=>{});return run;
  }
  activities(){const rows=new Map(),put=(id,project,kind)=>rows.set(id,{id:'git-draft-'+id,kind,count:1,...(project?{projectId:project}:{})});for(const operation of this.operations.values())put(operation.id,operation.projectId,'command');for(const resource of this.cleanupTasks)if(!rows.has(resource.owner?.id??resource.id))put(resource.owner?.id??resource.id,resource.owner?.projectId,'unknown');for(const [project,id]of this.stopFailures)if(!rows.has(id))put(id,project,'unknown');return [...rows.values()];}
  _cleanup(resource){if(resource.pending)return resource.pending;const pending=Promise.resolve().then(resource.run).then(()=>{this.cleanupTasks.delete(resource);},()=>{throw fault('GIT_DRAFT_WRITE_FAILED');});resource.pending=pending;void pending.finally(()=>{if(resource.pending===pending)resource.pending=null;}).catch(()=>{});return pending;}
  async _directory(){
    let current=path.parse(this.dataDir).root;
    for(const component of this.dataDir.slice(current.length).split(path.sep).filter(Boolean)){current=path.join(current,component);let info;try{info=await lstat(current);}catch(error){if(error.code!=='ENOENT')throw error;try{await mkdir(current,{mode:0o700});}catch(create){if(create.code!=='EEXIST')throw create;}info=await lstat(current);}if(!info.isDirectory()||info.isSymbolicLink())throw fault('GIT_DRAFT_STORAGE_UNSAFE');}
  }
  async _read(){
    await this._directory();let before;
    try{before=await lstat(this.file);}catch(error){if(error.code==='ENOENT')return {bytes:null,key:null};throw error;}
    if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1)throw fault('GIT_DRAFT_STORAGE_UNSAFE');
    if(before.size>MAX_FILE_BYTES)throw fault('GIT_DRAFT_LIMIT');let handle;
    try{
      handle=await open(this.file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const info=await handle.stat();
      if(!info.isFile()||info.nlink!==1||info.ino!==before.ino||info.dev!==before.dev)throw fault('GIT_DRAFT_CHANGED');
      const chunks=[];let total=0;
      while(true){const chunk=Buffer.alloc(Math.min(65536,MAX_FILE_BYTES+1-total));const {bytesRead}=await handle.read(chunk,0,chunk.length,null);if(!bytesRead)break;total+=bytesRead;if(total>MAX_FILE_BYTES)throw fault('GIT_DRAFT_LIMIT');chunks.push(chunk.subarray(0,bytesRead));}
      const after=await handle.stat(),current=await lstat(this.file);
      if(after.size!==total||after.mtimeMs!==info.mtimeMs||current.ino!==info.ino||current.dev!==info.dev||current.isSymbolicLink())throw fault('GIT_DRAFT_CHANGED');
      const bytes=Buffer.concat(chunks);return {bytes,key:fingerprint(bytes,after)};
    }catch(error){if(['ELOOP','EISDIR','ENOTDIR'].includes(error.code))throw fault('GIT_DRAFT_STORAGE_UNSAFE');throw error;}
    finally{await handle?.close();}
  }
  async _withLock(work){
    await this._directory();
    const prior=await lstat(this.lockPath).catch(error=>{if(error.code==='ENOENT')return null;throw error;});if(prior&&(!prior.isDirectory()||prior.isSymbolicLink()))throw fault('GIT_DRAFT_STORAGE_UNSAFE');
    let compromised=false,release,identity;
    const guardedFs={...fs,rmdir:(target,callback)=>{
      if(target!==this.lockPath||!identity)return fs.rmdir(target,callback);
      fs.lstat(target,(error,info)=>{if(error)return callback(error);if(!info.isDirectory()||info.isSymbolicLink()||info.dev!==identity.dev||info.ino!==identity.ino)return callback(Object.assign(new Error('LOCK_CHANGED'),{code:'ECOMPROMISED'}));fs.rmdir(target,callback);});
    }};
    try{release=await lockfile.lock(this.file,{fs:guardedFs,realpath:false,lockfilePath:this.lockPath,stale:10000,update:2000,retries:{retries:40,minTimeout:25,maxTimeout:100,randomize:false},onCompromised:()=>{compromised=true;}});}
    catch(error){if(error.code==='ELOCKED')throw fault('GIT_DRAFT_BUSY');throw error;}
    const assertLock=async()=>{if(compromised)throw fault('GIT_DRAFT_CHANGED');const current=await lstat(this.lockPath).catch(()=>null);if(!current||!current.isDirectory()||current.isSymbolicLink()||current.dev!==identity.dev||current.ino!==identity.ino)throw fault('GIT_DRAFT_CHANGED');};
    let released=false;
    const cleanup={id:randomUUID(),owner:this.activeOperation,run:async()=>{
      if(!released){released=true;try{await release();return;}catch{/* Inspect only our original lock before retrying removal. */}}
      const current=await lstat(this.lockPath).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
      if(current&&!identity)throw fault('GIT_DRAFT_WRITE_FAILED');
      if(current&&identity&&current.isDirectory()&&!current.isSymbolicLink()&&current.dev===identity.dev&&current.ino===identity.ino)await rmdir(this.lockPath);
    }};this.cleanupTasks.add(cleanup);
    try{identity=await lstat(this.lockPath);if(!identity.isDirectory()||identity.isSymbolicLink())throw fault('GIT_DRAFT_STORAGE_UNSAFE');return await work(assertLock);}finally{await this._cleanup(cleanup);}
  }
  async _persist(rows,expected,assertLock){
    const bytes=encode(rows),temporary=path.join(this.dataDir,'.git-drafts-'+randomUUID()+'.tmp');let handle,identity,cleanup;
    try{
      handle=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
      cleanup={id:randomUUID(),owner:this.activeOperation,run:async()=>{if(handle){identity??=await handle.stat();await handle.close();handle=null;}const current=await lstat(temporary).catch(error=>{if(error.code==='ENOENT')return null;throw error;});if(current&&identity&&current.dev===identity.dev&&current.ino===identity.ino&&!current.isSymbolicLink())await unlink(temporary);}};this.cleanupTasks.add(cleanup);identity=await handle.stat();
      await handle.writeFile(bytes);await handle.sync();await handle.close();handle=null;
      await assertLock();await this._directory();if((await this._read()).key!==expected)throw fault('GIT_DRAFT_CHANGED');await assertLock();
      await rename(temporary,this.file);if(process.platform!=='win32'){const directory=await open(this.dataDir,constants.O_RDONLY);try{await directory.sync();}finally{await directory.close();}}
    }finally{if(cleanup)await this._cleanup(cleanup);}
  }
  get(value){let id;try{id=projectId(value);}catch(error){return Promise.reject(error);}return this._queue(async()=>{const current=await this._read(),rows=current.bytes?parse(current.bytes):new Map();return rows.has(id)?{...rows.get(id)}:null;});}
  save(value){
    let captured,base;try{captured=fields(value);base=baseVersion(value.baseVersion);}catch(error){return Promise.reject(error);}
    return this._queue(()=>this._withLock(async assertLock=>{
      const current=await this._read(),rows=current.bytes?parse(current.bytes):new Map();
      if((rows.get(captured.projectId)?.version??null)!==base)throw fault('GIT_DRAFT_CHANGED');
      const row={...captured,version:randomUUID(),updatedAt:new Date().toISOString()};rows.set(row.projectId,row);await this._persist(rows,current.key,assertLock);return {...row};
    }),true,captured.projectId);
  }
  clear(value){
    let id,base;try{valid(plain(value));id=projectId(value.projectId);base=baseVersion(value.baseVersion);}catch(error){return Promise.reject(error);}
    return this._queue(()=>this._withLock(async assertLock=>{
      const current=await this._read(),rows=current.bytes?parse(current.bytes):new Map(),row=rows.get(id);
      if((row?.version??null)!==base)throw fault('GIT_DRAFT_CHANGED');if(!row)return {cleared:false};
      rows.delete(id);await this._persist(rows,current.key,assertLock);return {cleared:true};
    }),true,id);
  }
  close(){
    if(this.closing)return this.closing;this.closed=true;
    for(const operation of this.operations.values())if(operation.writing)operation.protectOnFailure=true;
    let timer;
    const settle=async()=>{await this.serial;const results=await Promise.allSettled([...this.cleanupTasks].map(resource=>this._cleanup(resource)));if(results.some(result=>result.status==='rejected')||this.cleanupTasks.size||this.stopFailures.size)throw fault('GIT_DRAFT_WRITE_FAILED');};
    const closing=Promise.race([settle(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(fault('GIT_DRAFT_WRITE_FAILED')),this.closeTimeoutMs);})]).finally(()=>clearTimeout(timer));
    this.closing=closing;void closing.catch(()=>{if(this.closing===closing){this.closing=null;this.closed=false;}});return closing;
  }
}
