import {open,mkdir,realpath,lstat,chmod,rename,rm} from 'node:fs/promises';
import {constants} from 'node:fs';
import {randomUUID} from 'node:crypto';
import path from 'node:path';

export const MAX_DOCUMENT_DRAFT_BYTES=2*1024*1024;
const MAX_TOTAL_BYTES=16*1024*1024;
const MAX_DRAFTS=128;
const MAX_PATH_BYTES=4096;
// JSON can escape each control byte as six ASCII bytes in both body and path.
// Keep the existing fixed metadata allowance in addition to the path budget.
const MAX_FILE_BYTES=MAX_TOTAL_BYTES*6+MAX_DRAFTS*(MAX_PATH_BYTES*6+8192)+1024;
const PROJECT_ID=/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const VERSION=/^[a-fA-F0-9]{64}$/;
const TIMESTAMP=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export class DocumentDraftError extends Error {
  constructor(code,{cause,recoverable=false}={}) {super(code,{cause});this.name='DocumentDraftError';this.code=code;this.recoverable=recoverable;}
}
const fault=(code,cause,recoverable=false)=>new DocumentDraftError(code,{cause,recoverable});
function keyFields(value) {
  if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.projectId!=='string'||!PROJECT_ID.test(value.projectId))throw fault('INVALID_DOCUMENT_DRAFT');
  const relative=value.path;
  if(typeof relative!=='string'||!relative||Buffer.byteLength(relative)>MAX_PATH_BYTES||relative.includes('\0')||path.posix.isAbsolute(relative)||relative.split('/').includes('..'))throw fault('INVALID_DOCUMENT_DRAFT');
  // This is a project-relative JSON key, not a Windows path. On POSIX a
  // backslash, colon or newline is a literal filename character; changing or
  // rejecting it here would break recovery for files the native API can edit.
  if(process.platform==='win32'&&(/[\x00-\x1f\x7f\\]/.test(relative)||path.win32.isAbsolute(relative)||/^[A-Za-z]:/.test(relative)))throw fault('INVALID_DOCUMENT_DRAFT');
  const normalized=path.posix.normalize(relative);
  if(normalized==='.'||normalized.endsWith('/'))throw fault('INVALID_DOCUMENT_DRAFT');
  return {projectId:value.projectId,path:normalized};
}
function draftFields(value) {
  const key=keyFields(value);
  if(typeof value.version!=='string'||!VERSION.test(value.version)||typeof value.content!=='string'||value.content.includes('\0'))throw fault('INVALID_DOCUMENT_DRAFT');
  if(Buffer.byteLength(value.content)>MAX_DOCUMENT_DRAFT_BYTES)throw fault('DOCUMENT_DRAFT_LIMIT');
  return {...key,version:value.version.toLowerCase(),content:value.content};
}
const id=row=>JSON.stringify([row.projectId,row.path]);
const publicRow=row=>({...row,name:path.posix.basename(row.path)});
function checkTotals(rows) {
  if(rows.size>MAX_DRAFTS||[...rows.values()].reduce((sum,row)=>sum+Buffer.byteLength(row.content),0)>MAX_TOTAL_BYTES)throw fault('DOCUMENT_DRAFTS_LIMIT');
}

/** Persistent, port-independent text recovery. This never writes project files. */
export class DocumentDraftStore {
  constructor({dataDir}={}) {
    if(typeof dataDir!=='string'||!path.isAbsolute(dataDir)||dataDir.includes('\0'))throw fault('INVALID_DOCUMENT_DRAFT');
    this.dataDir=dataDir;this.directory=null;this.file=null;this.rows=new Map();this.loaded=false;this.serial=Promise.resolve();this.lastUpdated=0;
  }
  _queue(work) {const pending=this.serial.then(work,work);this.serial=pending.catch(()=>{});return pending;}
  async _directory() {
    if(this.directory)return;
    await mkdir(this.dataDir,{recursive:true,mode:0o700});
    const directory=await realpath(this.dataDir);await chmod(directory,0o700);
    this.directory=directory;this.file=path.join(directory,'document-drafts.json');
  }
  _list() {return [...this.rows.values()].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).map(publicRow);}
  async _load() {
    let handle;
    try {
      await this._directory();
      try {handle=await open(this.file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));}
      catch(error) {
        if(error.code!=='ENOENT')throw error;
        this.rows=new Map();this.lastUpdated=0;this.loaded=true;return this._list();
      }
      const info=await handle.stat();
      if(!info.isFile())throw fault('DOCUMENT_DRAFTS_UNSAFE',null,true);
      if(info.size>MAX_FILE_BYTES)throw fault('DOCUMENT_DRAFTS_CORRUPT',null,true);
      const bytes=await handle.readFile();
      if(bytes.length>MAX_FILE_BYTES)throw fault('DOCUMENT_DRAFTS_CORRUPT',null,true);
      let parsed;
      try {parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch(error){throw fault('DOCUMENT_DRAFTS_CORRUPT',error,true);}
      const next=new Map();let lastUpdated=0;
      try {
        if(!parsed||parsed.version!==1||!Array.isArray(parsed.drafts))throw new Error('SCHEMA');
        for(const input of parsed.drafts) {
          const row=draftFields(input);
          if(typeof input.updatedAt!=='string'||!TIMESTAMP.test(input.updatedAt)||new Date(input.updatedAt).toISOString()!==input.updatedAt||next.has(id(row)))throw new Error('SCHEMA');
          row.updatedAt=input.updatedAt;next.set(id(row),row);lastUpdated=Math.max(lastUpdated,Date.parse(row.updatedAt));
        }
        checkTotals(next);
      }catch(error){throw fault('DOCUMENT_DRAFTS_CORRUPT',error,true);}
      await handle.chmod(0o600);
      this.rows=next;this.lastUpdated=lastUpdated;this.loaded=true;return this._list();
    }catch(error) {
      this.loaded=false;
      if(error instanceof DocumentDraftError)throw error;
      throw fault(error.code==='ELOOP'?'DOCUMENT_DRAFTS_UNSAFE':'DOCUMENT_DRAFTS_READ_FAILED',error,true);
    }finally{await handle?.close().catch(()=>{});}
  }
  async _ensureLoaded() {if(!this.loaded)await this._load();}
  async load() {return this._queue(()=>this._load());}
  async read(key) {
    const normalized=key===undefined?null:keyFields(key);
    return this._queue(async()=>{await this._ensureLoaded();return normalized?(this.rows.has(id(normalized))?publicRow(this.rows.get(id(normalized))):null):this._list();});
  }
  async _replaceFile(source,target) {await rename(source,target);}
  async _persist(rows) {
    let temporary;let handle;
    try {
      await this._directory();
      try {const existing=await lstat(this.file);if(!existing.isFile()||existing.isSymbolicLink())throw fault('DOCUMENT_DRAFTS_UNSAFE',null,true);}
      catch(error){if(error.code!=='ENOENT')throw error;}
      temporary=path.join(this.directory,'.document-drafts.'+randomUUID()+'.tmp');
      handle=await open(temporary,'wx',0o600);
      await handle.writeFile(JSON.stringify({version:1,drafts:[...rows.values()]})+'\n','utf8');
      await handle.sync();await handle.close();handle=null;
      await this._replaceFile(temporary,this.file);
    }catch(error) {
      if(error instanceof DocumentDraftError)throw error;
      throw fault('DOCUMENT_DRAFTS_WRITE_FAILED',error,true);
    }finally{await handle?.close().catch(()=>{});if(temporary)await rm(temporary,{force:true}).catch(()=>{});}
  }
  async save(value) {
    const input=draftFields(value);
    return this._queue(async()=>{
      await this._ensureLoaded();
      const updated=Math.max(Date.now(),this.lastUpdated+1);
      const row={...input,updatedAt:new Date(updated).toISOString()};
      const next=new Map(this.rows);next.set(id(row),row);checkTotals(next);
      await this._persist(next);
      this.rows=next;this.lastUpdated=updated;return publicRow(row);
    });
  }
  async clear(key) {
    const normalized=keyFields(key);
    return this._queue(async()=>{
      await this._ensureLoaded();
      if(!this.rows.has(id(normalized)))return {cleared:false};
      const next=new Map(this.rows);next.delete(id(normalized));await this._persist(next);this.rows=next;return {cleared:true};
    });
  }
}
