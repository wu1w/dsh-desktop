import {createHash} from 'node:crypto';
import {mkdir,lstat,realpath} from 'node:fs/promises';
import path from 'node:path';

// Engines need a cwd even when the conversation has no user workspace. Keep it
// private, stable across engine handoffs, and separate for every conversation.
export class SessionWorkspaces {
  constructor(dataDir,getProject){this.root=path.join(dataDir,'chat-runtime');this.getProject=getProject;}
  path(session){return session.projectId==null?path.join(this.root,createHash('sha256').update(session.id).digest('hex')):this.getProject(session.projectId).path;}
  isPrivate(cwd){const relative=path.relative(this.root,path.resolve(cwd));return /^[a-f0-9]{64}$/.test(relative);}
  async ensure(session){
    const cwd=this.path(session);
    if(session.projectId!=null)return cwd;
    for(const dir of [this.root,cwd]){
      await mkdir(dir,{recursive:true,mode:0o700});
      const info=await lstat(dir);
      if(!info.isDirectory()||info.isSymbolicLink())throw Object.assign(new Error('INVALID_PATH'),{code:'INVALID_PATH'});
    }
    if(path.dirname(await realpath(cwd))!==await realpath(this.root))throw Object.assign(new Error('INVALID_PATH'),{code:'INVALID_PATH'});
    return cwd;
  }
}
