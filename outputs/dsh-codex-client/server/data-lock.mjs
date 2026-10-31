import lockfile from 'proper-lockfile';
import {mkdir,realpath} from 'node:fs/promises';
export async function acquireDataLock(directory,onCompromised){
  await mkdir(directory,{recursive:true,mode:0o700});
  const canonical=await realpath(directory);let lost;
  const compromised=error=>{lost??=Object.assign(new Error('DATA_LOCK_LOST',{cause:error}),{code:'DATA_LOCK_LOST'});onCompromised?.(lost);};
  try{
    const release=await lockfile.lock(canonical,{realpath:true,stale:30000,update:5000,retries:0,onCompromised:compromised});
    return async()=>{if(lost)throw lost;try{await release();}catch(error){throw lost??error;}if(lost)throw lost;};
  }catch(error){if(error.code==='ELOCKED')throw Object.assign(new Error('DATA_IN_USE'),{code:'DATA_IN_USE'});throw error;}
}
