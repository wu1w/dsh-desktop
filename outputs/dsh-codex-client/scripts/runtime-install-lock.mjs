import {mkdir,lstat,readFile,writeFile,unlink,rmdir,realpath} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {hostname} from 'node:os';
const fault=(code,lockPath)=>Object.assign(Error(code),{code,lockPath});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino;

// A crashed writer is reported explicitly, never stolen by elapsed time. A
// live but paused process must not lose its install lease during suspend/resume.
// PID reuse conservatively leaves the orphan busy rather than deleting it.
export async function withRuntimeInstallLock(root,work,{timeoutMs=60000,pollMs=25}={}){
 await mkdir(root,{recursive:true});const canonical=await realpath(root),lockPath=path.join(canonical,'.runtime-install.lock'),ownerPath=path.join(lockPath,'owner.json');
 const owner={pid:process.pid,host:hostname(),token:randomUUID()},serialized=JSON.stringify(owner),deadline=Date.now()+timeoutMs;
 let identity;
 for(;;){
  try{await mkdir(lockPath,{mode:0o700});identity=await lstat(lockPath);await writeFile(ownerPath,serialized,{flag:'wx',mode:0o600});break;}
  catch(error){
   if(error.code!=='EEXIST')throw error;
   const info=await lstat(lockPath).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
   if(!info)continue;if(!info.isDirectory()||info.isSymbolicLink())throw fault('CHANNEL_RUNTIME_LOCK_UNSAFE',lockPath);
   try{
    const file=await lstat(ownerPath);if(!file.isFile()||file.isSymbolicLink()||file.nlink!==1||file.size>4096)throw fault('CHANNEL_RUNTIME_LOCK_UNSAFE',lockPath);
    let previous;try{previous=JSON.parse(await readFile(ownerPath,'utf8'));}catch(error){if(error instanceof SyntaxError)throw fault('CHANNEL_RUNTIME_LOCK_UNSAFE',lockPath);throw error;}
    if(!previous||typeof previous!=='object'||typeof previous.host!=='string'||!Number.isSafeInteger(previous.pid)||previous.pid<=1||typeof previous.token!=='string')throw fault('CHANNEL_RUNTIME_LOCK_UNSAFE',lockPath);
    if(previous.host===owner.host&&Number.isSafeInteger(previous.pid)&&previous.pid>1){try{process.kill(previous.pid,0);}catch(error){if(error.code==='ESRCH')throw fault('CHANNEL_RUNTIME_LOCK_STALE',lockPath);}}
   }catch(error){if(error.code!=='ENOENT')throw error;}
   if(Date.now()>=deadline)throw fault('CHANNEL_RUNTIME_BUSY',lockPath);await pause(pollMs);
  }
 }
 const assertHeld=async()=>{
  let current;try{current=await lstat(lockPath);if(current.isSymbolicLink()||!same(identity,current)||await readFile(ownerPath,'utf8')!==serialized)throw Error();}
  catch{throw fault('CHANNEL_RUNTIME_LOCK_LOST',lockPath);}
 };
 let failure;
 try{return await work({assertHeld,lockPath});}
 catch(error){failure=error;throw error;}
 finally{
  try{await assertHeld();await unlink(ownerPath);await rmdir(lockPath);}
  catch(error){
   // Preserve transaction recovery information if ownership was lost during
   // rollback. Never remove a replacement owner's lock to hide that failure.
   if(failure){error.cause=failure;if(failure.recoveryDirectory)error.recoveryDirectory=failure.recoveryDirectory;}
   throw error;
  }
 }
}
