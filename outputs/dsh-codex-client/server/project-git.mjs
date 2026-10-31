import { spawn } from 'node:child_process';
import { realpath, stat, lstat, open, readlink, writeFile, rename, unlink, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

const fault = code => Object.assign(new Error(code), { code });
const inside = (root, target) => { const relative = path.relative(root, target); return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)); };
const decode = (bytes, code = 'GIT_PATH_ENCODING') => { try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw fault(code); } };
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value);
function groupExists(child) {
  if (!child.pid) return false;
  try { process.kill(-child.pid, 0); return true; }
  catch (error) {
    if (error.code === 'ESRCH') return false;
    // macOS may deny process-group probes for its platform-signed Git while
    // still allowing the parent to signal its exact child. Git hooks, pagers
    // and external conversion/diff helpers are disabled below.
    if (error.code !== 'EPERM') throw error;
    try { process.kill(child.pid, 0); return true; } catch (direct) { if (direct.code === 'ESRCH') return false; throw direct; }
  }
}
async function terminate(child, grace, confirmMs) {
  const signal = value => { try { process.kill(-child.pid, value); } catch (error) { if (error.code === 'EPERM') child.kill(value); else if (error.code !== 'ESRCH') throw error; } };
  if (!groupExists(child)) return;
  signal('SIGTERM');
  const deadline = Date.now() + grace;
  while (groupExists(child) && Date.now() < deadline) await pause(10);
  if (groupExists(child)) signal('SIGKILL');
  const finalDeadline=Date.now()+confirmMs;
  while(groupExists(child)&&Date.now()<finalDeadline)await pause(10);
  if(groupExists(child))throw fault('GIT_CLEANUP_FAILED');
}
function fields(record, count) {
  const values = []; let offset = 0;
  for (let n = 0; n < count; n++) {
    const next = record.indexOf(32, offset);
    if (next < 0) throw fault('GIT_PROTOCOL');
    values.push(decode(record.subarray(offset, next))); offset = next + 1;
  }
  return [...values, decode(record.subarray(offset))];
}
function validPath(relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\0') || Buffer.byteLength(relative) > 4096 || path.isAbsolute(relative)
    || relative.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')
    || decode(Buffer.from(relative)) !== relative) throw fault('GIT_INVALID_PATH');
  return relative;
}
function parseStatus(bytes) {
  if (bytes.length && bytes.at(-1) !== 0) throw fault('GIT_PROTOCOL');
  const records = []; let offset = 0;
  for (let n = 0; n < bytes.length; n++) if (bytes[n] === 0) { records.push(bytes.subarray(offset, n)); offset = n + 1; }
  const result = { branch: null, detached: false, unborn: false, upstream: null, ahead: 0, behind: 0, files: [] };
  for (let n = 0; n < records.length; n++) {
    const record = records[n], kind = String.fromCharCode(record[0]);
    if (kind === '#') {
      const header = decode(record);
      if (header.startsWith('# branch.head ')) { const name = header.slice(14); result.detached = name === '(detached)'; result.branch = result.detached ? null : name; }
      else if (header === '# branch.oid (initial)') result.unborn = true;
      else if (header.startsWith('# branch.upstream ')) result.upstream = header.slice(18);
      else if (header.startsWith('# branch.ab ')) { const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(header); if (!match) throw fault('GIT_PROTOCOL'); result.ahead = Number(match[1]); result.behind = Number(match[2]); }
      continue;
    }
    let relative, originalPath = null, xy;
    if (kind === '?') { if (record[1] !== 32) throw fault('GIT_PROTOCOL'); relative = decode(record.subarray(2)); xy = '??'; }
    else if (['1', '2', 'u'].includes(kind)) {
      const values = fields(record, kind === '1' ? 8 : kind === '2' ? 9 : 10);
      xy = values[1]; relative = values.at(-1);
      if (kind === '2') { if (++n >= records.length) throw fault('GIT_PROTOCOL'); originalPath = decode(records[n]); }
    } else throw fault('GIT_PROTOCOL');
    validPath(relative); if (originalPath != null) validPath(originalPath);
    if (xy.length !== 2) throw fault('GIT_PROTOCOL');
    result.files.push({ path: relative, originalPath, index: xy[0], workingTree: xy[1], staged: !['.', '?'].includes(xy[0]), unstaged: xy[1] !== '.', untracked: kind === '?', renamed: kind === '2', deleted: xy.includes('D'), conflicted: kind === 'u' });
  }
  return result;
}

/** Bounded local Git access. Each instance owns and can abort all its work. */
export class ProjectGit {
  constructor({ gitBinary = 'git', timeoutMs = 30000, maxOutputBytes = 2 * 1024 * 1024, killGraceMs = 150, cleanupWaitMs = 1000, closeTimeoutMs = 10000 } = {}) {
    this.gitBinary = gitBinary; this.timeoutMs = timeoutMs; this.maxOutputBytes = maxOutputBytes; this.killGraceMs = killGraceMs;
    this.operations = new Map(); this.children = new Set(); this.childOwners=new WeakMap();this.cleanupTasks=new Set();this.cleanupWaitMs=cleanupWaitMs;this.closeTimeoutMs=closeTimeoutMs;this.closed = false; this.repoTails = new Map();
  }
  _operation(signal, work) {
    if (this.closed) return Promise.reject(fault('GIT_ABORTED'));
    const controller = new AbortController();
    controller.activityId=randomUUID();controller.childPids=new Set();
    const abort = () => controller.abort(fault('GIT_ABORTED'));
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(fault('GIT_TIMEOUT')), this.timeoutMs);
    const pending = Promise.resolve().then(() => { if (controller.signal.aborted) throw controller.signal.reason; return work(controller.signal); }).finally(() => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort); this.operations.delete(controller);
    });
    this.operations.set(controller, pending); return pending;
  }
  async _run(root, args, signal, accepted = [0], { input, env = {}, normalConfig = false, afterPrepare } = {}) {
    if (signal.aborted) throw signal.reason;
    const environment = Object.fromEntries(['PATH', 'HOME', 'USER', 'TMPDIR', 'SystemRoot','XDG_CONFIG_HOME'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
    Object.assign(environment, { LC_ALL: 'C', LANG: 'C', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ATTR_NOSYSTEM: '1', GIT_PAGER: 'cat', GIT_NO_LAZY_FETCH:'1' }, env);
    if(normalConfig){delete environment.GIT_CONFIG_GLOBAL;delete environment.GIT_CONFIG_NOSYSTEM;}
    const child = spawn(this.gitBinary, ['--no-pager', '--literal-pathspecs', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'diff.external=', '-c', 'color.ui=false', '-c','protocol.allow=never','-c','commit.gpgsign=false','-c','gc.auto=0', ...args], { cwd: root, env: environment, detached: true, stdio: [input===undefined?'ignore':'pipe', 'pipe', 'pipe'] });
    if(input!==undefined){child.stdin.on('error',()=>{});if(afterPrepare)child.stdin.write(input);else child.stdin.end(input);}
    this.children.add(child);
    const owner=[...this.operations.keys()].find(controller=>controller.signal===signal);if(owner)this.childOwners.set(child,owner);if(child.pid)owner?.childPids.add(child.pid);
    const stdout = [], stderr = []; let size = 0, failure, stopping, prepared=false;
    const stop = () => stopping ??= terminate(child, this.killGraceMs,this.cleanupWaitMs);
    const abort = () => { failure ??= signal.reason ?? fault('GIT_ABORTED'); void stop().catch(() => {}); };
    const append = chunks => chunk => {
      size += chunk.length;
      if (size > this.maxOutputBytes) { failure ??= fault('GIT_OUTPUT_LIMIT'); void stop().catch(() => {}); return; }
      chunks.push(chunk);
      if(afterPrepare&&chunks===stdout&&!prepared&&Buffer.concat(stdout).includes(Buffer.from('prepare: ok\n'))){prepared=true;Promise.resolve().then(()=>afterPrepare()).then(allowed=>{if(!allowed||signal.aborted){failure??=fault('GIT_STALE');child.stdin.end('abort\n');}else child.stdin.end('commit\n');},error=>{failure??=error;child.stdin.end('abort\n');});}
    };
    child.stdout.on('data', append(stdout)); child.stderr.on('data', append(stderr));
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    try {
      const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
      if (failure) throw failure;
      if (!accepted.includes(code)) throw fault('GIT_FAILED');
      return { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), code };
    } catch (error) { throw error.code === 'ENOENT' ? fault('GIT_NOT_INSTALLED') : error; }
    finally { signal.removeEventListener('abort', abort);await stop().catch(()=>{throw fault('GIT_CLEANUP_FAILED');});this.children.delete(child);owner?.childPids.delete(child.pid); }
  }
  _cleanResource(resource){
    if(resource.pending)return resource.pending;
    const pending=Promise.resolve().then(resource.run).then(()=>{this.cleanupTasks.delete(resource);},()=>{throw fault('GIT_CLEANUP_FAILED');});
    resource.pending=pending;void pending.finally(()=>{if(resource.pending===pending)resource.pending=null;}).catch(()=>{});return pending;
  }
  activities(){
    const rows=new Map(),put=(owner,id,pid)=>{const key=owner?.activityId??id;rows.set(key,{id:'git-'+key,kind:'command',count:1,...(pid?{pid}:{})});};
    for(const owner of this.operations.keys())put(owner,null,owner.childPids.values().next().value);
    for(const child of this.children)put(this.childOwners.get(child),'child-'+child.pid,child.pid);
    for(const resource of this.cleanupTasks)put(resource.owner,resource.id);
    return [...rows.values()];
  }
  async _root(directory, signal) {
    let root;
    try { root = await realpath(directory); if (!(await stat(root)).isDirectory()) throw fault('GIT_NOT_REPOSITORY'); }
    catch { throw fault('GIT_NOT_REPOSITORY'); }
    let output;
    try { output = await this._run(root, ['rev-parse', '--show-toplevel'], signal); }
    catch (error) { if (error.code === 'GIT_FAILED') throw fault('GIT_NOT_REPOSITORY'); throw error; }
    const top = decode(output.stdout).replace(/\n$/, '');
    if (await realpath(top) !== root) throw fault('GIT_PROJECT_ROOT_REQUIRED');
    return root;
  }
  async _filterOptions(root, signal) {
    // --no-textconv and --no-ext-diff do not disable clean/process filters:
    // even status may invoke those when comparing the working tree to index.
    const { stdout } = await this._run(root, ['config', '--null', '--name-only', '--list'], signal);
    const keys = decode(stdout).split('\0'); if (keys.pop() !== '') throw fault('GIT_PROTOCOL');
    const names = new Set(keys.flatMap(key => { const match = /^filter\.([\s\S]+)\.(?:clean|process|smudge|required)$/.exec(key); return match ? [match[1]] : []; }));
    // Exotic subsection names (notably '=') cannot be overridden safely with
    // Git's key=value command syntax. Refuse before any content comparison.
    if ([...names].some(name => !/^[A-Za-z0-9_.-]+$/.test(name))) throw fault('GIT_FILTER_UNSUPPORTED');
    return [...names].flatMap(name => ['clean', 'process', 'smudge', 'required'].flatMap(key => ['-c', `filter.${name}.${key}=${key === 'required' ? 'false' : ''}`]));
  }
  async _status(root, signal, filters) {
    const { stdout } = await this._run(root, [...filters, '-c', 'status.renames=true', 'status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all', '--ignore-submodules=all'], signal);
    return parseStatus(stdout);
  }
  async _path(root, relative) {
    validPath(relative);
    const candidate = path.resolve(root, relative);
    if (!inside(root, candidate)) throw fault('GIT_OUTSIDE_PROJECT');
    let ancestor = candidate;
    for (;;) {
      try { if (!inside(root, await realpath(ancestor))) throw fault('GIT_OUTSIDE_PROJECT'); break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; if (ancestor === root) throw fault('GIT_INVALID_PATH'); ancestor = path.dirname(ancestor); }
    }
    try { if (!(await stat(candidate)).isFile()) throw fault('GIT_INVALID_PATH'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return candidate;
  }
  async _view(root, token) {
      const filters = await this._filterOptions(root, token), state = await this._status(root, token, filters);
      const { stdout } = await this._run(root, ['for-each-ref', '--format=%(refname:short)%00%(HEAD)', 'refs/heads/'], token);
      const branches = decode(stdout).split('\n').filter(Boolean).map(line => { const [name, head, ...extra] = line.split('\0'); if (!name || extra.length || ![' ', '*'].includes(head)) throw fault('GIT_PROTOCOL'); return { name, current: head === '*' }; });
      const base={ root, ...state, branches };
      const metadata=await this._snapshot(root,token,base);
      return {...base,revision:metadata.revision,writeCapabilities:metadata.capabilities,identity:metadata.identity};
  }
  status(directory, { signal } = {}) {
    return this._operation(signal, async token => this._view(await this._root(directory,token),token));
  }
  async _regular(file,limit=16*1024*1024) {
    let info;try{info=await lstat(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}
    if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1)throw fault('GIT_WRITE_UNSUPPORTED');
    if(info.size>limit)throw fault('GIT_WRITE_LIMIT');
    const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
    try{const before=await handle.stat(),chunks=[];let count=0;while(true){const buffer=Buffer.alloc(Math.min(65536,limit+1-count));const {bytesRead}=await handle.read(buffer,0,buffer.length,null);if(!bytesRead)break;count+=bytesRead;if(count>limit)throw fault('GIT_WRITE_LIMIT');chunks.push(buffer.subarray(0,bytesRead));}const bytes=Buffer.concat(chunks),after=await handle.stat();if(before.ino!==info.ino||before.dev!==info.dev||before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw fault('GIT_STALE');return {bytes,key:[info.dev,info.ino,info.size,info.mtimeMs,info.mode,sha(bytes)]};}finally{await handle.close();}
  }
  async _writePath(root,relative) {
    validPath(relative);let current=root;
    const parts=relative.split('/');
    for(let i=0;i<parts.length;i++){
      current=path.join(current,parts[i]);let info;try{info=await lstat(current);}catch(error){if(error.code==='ENOENT')return {missing:true};throw error;}
      if(info.isSymbolicLink()){
        const target=await realpath(current).catch(()=>null);if(!target||!inside(root,target))throw fault('GIT_OUTSIDE_PROJECT');
        if(i!==parts.length-1)throw fault('GIT_INVALID_PATH');
        const bytes=Buffer.from(await readlink(current));return {bytes,mode:'120000',key:[info.dev,info.ino,info.size,info.mtimeMs,info.mode,sha(bytes)]};
      }
      if(i!==parts.length-1){if(!info.isDirectory())throw fault('GIT_INVALID_PATH');continue;}
      if(!info.isFile())throw fault('GIT_INVALID_PATH');
      const value=await this._regular(current);return {...value,mode:info.mode&0o111?'100755':'100644'};
    }
    throw fault('GIT_INVALID_PATH');
  }
  async _snapshot(root,token,state) {
    const identity={name:null,email:null};
    for(const [key,field] of [['user.name','name'],['user.email','email']]){
      const result=await this._run(root,['config','--get',key],token,[0,1],{normalConfig:true});
      if(result.code===0){const value=decode(result.stdout).replace(/\n$/,'');if(value.length<=512&&!/[\0\r\n]/.test(value))identity[field]=value;}
    }
    let reasonCode,capabilities={stage:true,unstage:true,commit:!state.detached};
    if(state.detached)capabilities.reasonCode='GIT_DETACHED_COMMIT';
    const gitDir=path.join(root,'.git');let directory;
    try{directory=await lstat(gitDir);}catch{reasonCode='GIT_WRITE_UNSUPPORTED';}
    if(!directory?.isDirectory()||directory.isSymbolicLink())reasonCode='GIT_WRITE_UNSUPPORTED';
    if(directory?.isDirectory()&&!directory.isSymbolicLink()){
      let visited=0;const pending=['objects','refs','logs'];
      while(pending.length&&!reasonCode){const relative=pending.pop();let info;try{info=await lstat(path.join(gitDir,relative));}catch(error){if(error.code==='ENOENT')continue;throw error;}if(++visited>50000){reasonCode='GIT_WRITE_LIMIT';break;}if(info.isSymbolicLink()||(!info.isDirectory()&&!info.isFile())){reasonCode='GIT_WRITE_UNSUPPORTED';break;}if(info.isDirectory())for(const name of await readdir(path.join(gitDir,relative)))pending.push(relative+'/'+name);}
      for(const name of ['objects/info/alternates','objects/info/http-alternates'])try{await lstat(path.join(gitDir,name));reasonCode='GIT_WRITE_UNSUPPORTED';}catch(error){if(error.code!=='ENOENT')throw error;}
    }
    const version=decode((await this._run(root,['--version'],token)).stdout).match(/git version (\d+)\.(\d+)/);if(!version||Number(version[1])<2||(Number(version[1])===2&&Number(version[2])<30))reasonCode='GIT_WRITE_UNSUPPORTED';
    const format=decode((await this._run(root,['rev-parse','--show-object-format'],token)).stdout).trim();if(format!=='sha1')reasonCode='GIT_WRITE_UNSUPPORTED';
    if(state.files.some(row=>row.conflicted))reasonCode='GIT_WRITE_CONFLICT';
    const headResult=await this._run(root,['rev-parse','--verify','HEAD'],token,[0,128]);
    const head=headResult.code===0?decode(headResult.stdout).trim():null;
    const refResult=await this._run(root,['symbolic-ref','-q','HEAD'],token,[0,1]);
    const ref=refResult.code===0?decode(refResult.stdout).trim():null;
    if(ref&&!/^refs\/heads\/[^\s\0]+$/.test(ref))reasonCode='GIT_WRITE_UNSUPPORTED';
    const {stdout:listed}=await this._run(root,['ls-files','--stage','-z'],token);
    const entries=decode(listed).split('\0').filter(Boolean).map(row=>{const found=/^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/.exec(row);if(!found)throw fault('GIT_PROTOCOL');return {mode:found[1],oid:found[2],stage:Number(found[3]),path:validPath(found[4])};});
    if(entries.some(row=>row.mode==='160000'))reasonCode='GIT_WRITE_UNSUPPORTED';
    const {stdout:flags}=await this._run(root,['ls-files','-v','-z'],token);
    if(decode(flags).split('\0').some(row=>row&&row[0]!=='H'))reasonCode='GIT_WRITE_UNSUPPORTED';
    let index=null,headFile=null;
    if(!reasonCode||directory?.isDirectory()){
      try{index=await this._regular(path.join(gitDir,'index'));headFile=await this._regular(path.join(gitDir,'HEAD'),16384);}catch(error){if(['GIT_WRITE_UNSUPPORTED','GIT_WRITE_LIMIT'].includes(error.code))reasonCode=error.code;else throw error;}
    }
    const operational=[];
    if(directory?.isDirectory())for(const name of ['MERGE_HEAD','CHERRY_PICK_HEAD','REVERT_HEAD','rebase-merge','rebase-apply','sequencer']){try{await lstat(path.join(gitDir,name));operational.push(name);}catch(error){if(error.code!=='ENOENT')throw error;}}
    if(operational.length)reasonCode='GIT_WRITE_CONFLICT';
    let configFile=null;try{configFile=directory?.isDirectory()?await this._regular(path.join(gitDir,'config')):null;}catch(error){if(['GIT_WRITE_UNSUPPORTED','GIT_WRITE_LIMIT'].includes(error.code))reasonCode=error.code;else throw error;}
    const config=await this._run(root,['config','--null','--get-regexp','^core\.(autocrlf|eol|safecrlf|attributesfile)$'],token,[0,1],{normalConfig:true});
    if(config.stdout.length)reasonCode='GIT_WRITE_TRANSFORM';
    const paths=[...new Set([...entries.map(row=>row.path),...state.files.flatMap(row=>[row.path,row.originalPath].filter(Boolean))])].sort();
    const attr=paths.length?await this._run(root,['check-attr','--all','-z','--stdin'],token,[0],{input:Buffer.from(paths.join('\0')+'\0'),normalConfig:true}):{stdout:Buffer.alloc(0)};
    if(attr.stdout.length)reasonCode='GIT_WRITE_TRANSFORM';
    const files=[];let bytes=0;
    if(!reasonCode)for(const relative of paths){
      try{const value=await this._writePath(root,relative);bytes+=value.bytes?.length??0;if(bytes>32*1024*1024)throw fault('GIT_WRITE_LIMIT');files.push([relative,value.key??null]);}
      catch(error){if(['GIT_WRITE_LIMIT','GIT_WRITE_UNSUPPORTED','GIT_INVALID_PATH','GIT_OUTSIDE_PROJECT'].includes(error.code)){reasonCode=error.code;break;}throw error;}
    }
    if(reasonCode)capabilities={stage:false,unstage:false,commit:false,reasonCode};
    const revision=sha(canonical({head,ref,index:index?.key??null,headFile:headFile?.key??null,files,state:state.files,operational,configFile:configFile?.key??null,config:sha(config.stdout),attr:sha(attr.stdout),identity,reasonCode}));
    return {revision,capabilities,identity,gitDir,index,head,ref,entries};
  }
  _write(directory,options,action){
    if(typeof options?.revision!=='string'||! /^[a-f0-9]{64}$/.test(options.revision))return Promise.reject(fault('GIT_STALE'));
    return this._operation(options.signal,async token=>{
      const root=await this._root(directory,token),previous=this.repoTails.get(root)??Promise.resolve();let release;const gate=new Promise(resolve=>release=resolve);const tail=previous.catch(()=>{}).then(()=>gate);this.repoTails.set(root,tail);
      await previous.catch(()=>{});
      try{return await this._transaction(root,options,action,token);}finally{release();if(this.repoTails.get(root)===tail)this.repoTails.delete(root);}
    });
  }
  stage(directory,options){return this._write(directory,options,'stage');}
  unstage(directory,options){return this._write(directory,options,'unstage');}
  commit(directory,options){return this._write(directory,options,'commit');}
  async _transaction(root,options,action,token){
    const filters=await this._filterOptions(root,token);const state=await this._status(root,token,filters);const before=await this._snapshot(root,token,state);
    if(before.revision!==options.revision)throw fault('GIT_STALE');
    if(!before.capabilities[action])throw fault(before.capabilities.reasonCode??'GIT_WRITE_UNSUPPORTED');
    const lockPath=path.join(before.gitDir,'index.lock'),temporary=path.join(before.gitDir,'dsh-index-'+randomUUID());let lock,lockIdentity,published=false,cleanup;
    try{
      try{lock=await open(lockPath,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);}catch(error){if(error.code==='EEXIST')throw fault('GIT_BUSY');throw error;}
      cleanup={id:randomUUID(),owner:[...this.operations.keys()].find(controller=>controller.signal===token),run:async()=>{
        if(lock){lockIdentity??=await lock.stat();await lock.close();lock=null;}
        if(lockIdentity)try{const info=await lstat(lockPath);if(info.ino===lockIdentity.ino&&info.dev===lockIdentity.dev)await unlink(lockPath);}catch(error){if(error.code!=='ENOENT')throw error;}
        for(const name of [temporary,temporary+'.lock'])await unlink(name).catch(error=>{if(error.code!=='ENOENT')throw error;});
      }};this.cleanupTasks.add(cleanup);
      lockIdentity=await lock.stat();
      const current=await this._regular(path.join(before.gitDir,'index'));if(canonical(current?.key??null)!==canonical(before.index?.key??null))throw fault('GIT_STALE');
      const env={GIT_INDEX_FILE:temporary};
      if(before.index)await writeFile(temporary,before.index.bytes,{mode:0o600,flag:'wx'});else await this._run(root,['read-tree','--empty'],token,[0],{env});
      let commit;
      if(action==='commit'){
        if(typeof options.message!=='string'||!options.message.trim()||Buffer.byteLength(options.message)>65536||options.message.includes('\0'))throw fault('GIT_INVALID_MESSAGE');
        const name=options.name??before.identity.name,email=options.email??before.identity.email;
        if(typeof name!=='string'||!name.trim()||name.length>200||/[\0\r\n<>]/.test(name)||typeof email!=='string'||email.length>254||! /^[^\s<>@]+@[^\s<>@]+$/.test(email))throw fault('GIT_IDENTITY_REQUIRED');
        const tree=decode((await this._run(root,['write-tree'],token,[0],{env})).stdout).trim();
        if(before.head){const headTree=decode((await this._run(root,['rev-parse','HEAD^{tree}'],token)).stdout).trim();if(tree===headTree)throw fault('GIT_NOTHING_STAGED');}
        else if(!before.entries.length)throw fault('GIT_NOTHING_STAGED');
        const result=await this._run(root,['commit-tree',tree,...(before.head?['-p',before.head]:[]),'--no-gpg-sign'],token,[0],{input:Buffer.from(options.message),env:{...env,GIT_AUTHOR_NAME:name.trim(),GIT_AUTHOR_EMAIL:email,GIT_COMMITTER_NAME:name.trim(),GIT_COMMITTER_EMAIL:email}});
        const oid=decode(result.stdout).trim();if(!/^[a-f0-9]{40,64}$/.test(oid))throw fault('GIT_PROTOCOL');
        const latest=await this._snapshot(root,token,await this._status(root,token,filters));if(latest.revision!==before.revision)throw fault('GIT_STALE');
        const zero='0'.repeat(oid.length),transaction=`start\nupdate HEAD ${oid} ${before.head??zero}\nprepare\n`;
        try{await this._run(root,['update-ref','--stdin'],token,[0],{input:Buffer.from(transaction),afterPrepare:async()=>{
          const branch=await this._run(root,['symbolic-ref','--no-recurse','-q','HEAD'],token,[0,1]);
          const current=await this._run(root,['rev-parse','--verify','HEAD'],token,[0,128]);
          return branch.code===0&&decode(branch.stdout).trim()===before.ref&&(current.code===0?decode(current.stdout).trim():null)===before.head;
        }});}catch(error){if(['GIT_ABORTED','GIT_TIMEOUT'].includes(error.code))throw fault('GIT_WRITE_UNKNOWN');throw fault('GIT_STALE');}
        published=true;commit={oid,shortOid:oid.slice(0,12),subject:options.message.trim().split(/\r?\n/)[0].slice(0,200)};
      }else{
        validPath(options.path);const row=state.files.find(item=>item.path===options.path||item.originalPath===options.path);
        if(action==='stage'&&(!row||(!row.unstaged&&!row.untracked)))throw fault('GIT_INVALID_PATH');
        if(action==='unstage'&&!row?.staged)throw fault('GIT_INVALID_PATH');
        const selected=[...new Set([options.path,...(row?.renamed?[row.path,row.originalPath]:[])])];
        const zero='0'.repeat(before.head?.length??40);let instructions='';
        const fileMode=await this._run(root,['config','--bool','--get','core.filemode'],token,[0,1]);
        for(const relative of selected){
          await this._writePath(root,relative);
          if(action==='stage'){
            const file=await this._writePath(root,relative),previous=before.entries.find(entry=>entry.path===relative);
            if(file.missing){if(!previous&&relative!==row?.originalPath)throw fault('GIT_INVALID_PATH');instructions+=`0 ${zero}\t${relative}\0`;continue;}
            const oid=decode((await this._run(root,['hash-object','-w','--no-filters','--stdin'],token,[0],{input:file.bytes})).stdout).trim();
            const mode=fileMode.code===0&&decode(fileMode.stdout).trim()==='false'&&previous&&['100644','100755'].includes(previous.mode)&&file.mode!=='120000'?previous.mode:file.mode;
            instructions+=`${mode} ${oid}\t${relative}\0`;
          }else{
            let entry=null;if(before.head){const output=decode((await this._run(root,['ls-tree','-z',before.head,'--',relative],token)).stdout);const match=/^(\d+) blob ([a-f0-9]+)\t/.exec(output);if(match)entry={mode:match[1],oid:match[2]};else if(output)throw fault('GIT_WRITE_UNSUPPORTED');}
            instructions+=entry?`${entry.mode} ${entry.oid}\t${relative}\0`:`0 ${zero}\t${relative}\0`;
          }
        }
        await this._run(root,['update-index','-z','--index-info'],token,[0],{env,input:Buffer.from(instructions)});
        const latest=await this._snapshot(root,token,await this._status(root,token,filters));if(latest.revision!==before.revision)throw fault('GIT_STALE');
        const updated=await this._regular(temporary);await lock.writeFile(updated.bytes);await lock.sync();
        const check=await lstat(lockPath);if(check.ino!==lockIdentity.ino||check.dev!==lockIdentity.dev)throw fault('GIT_STALE');
        const unchanged=await this._regular(path.join(before.gitDir,'index'));if(canonical(unchanged?.key??null)!==canonical(before.index?.key??null))throw fault('GIT_STALE');
        if(token.aborted)throw token.reason;await rename(lockPath,path.join(before.gitDir,'index'));published=true;
      }
      try{return {status:await this._view(root,token),...(commit?{commit}:{})};}catch(error){if(published)throw fault('GIT_WRITE_UNKNOWN');throw error;}
    }finally{
      if(cleanup)await this._cleanResource(cleanup);
    }
  }
  diff(directory, { path: relative, staged = false, signal } = {}) {
    if (typeof staged !== 'boolean') return Promise.reject(fault('GIT_INVALID_PATH'));
    return this._operation(signal, async token => {
      const root = await this._root(directory, token); await this._path(root, relative);
      const filters = await this._filterOptions(root, token), state = await this._status(root, token, filters), file = state.files.find(item => item.path === relative || item.originalPath === relative);
      const selected = file?.path ?? relative;
      await this._path(root, selected);
      if (file?.originalPath) await this._path(root, file.originalPath);
      const untracked = file?.untracked === true;
      if (!file) {
        const tracked = await this._run(root, ['ls-files', '--error-unmatch', '-z', '--', relative], token, [0, 1]);
        if (tracked.code !== 0 || !tracked.stdout.length) throw fault('GIT_INVALID_PATH');
      }
      if (untracked && staged) return { path: selected, originalPath: null, staged, kind: 'untracked', diff: '', binary: false };
      const paths = [...new Set([file?.originalPath, selected].filter(Boolean))];
      const args = [...filters, 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--ignore-submodules=all', '--src-prefix=a/', '--dst-prefix=b/'];
      if (untracked) args.push('--no-index', '--', '/dev/null', selected);
      else args.push(...(staged ? ['--cached'] : []), '--', ...paths);
      const { stdout } = await this._run(root, args, token, untracked ? [0, 1] : [0]);
      const diff = decode(stdout, 'GIT_BINARY');
      if (/^Binary files .* differ$/m.test(diff) || /^GIT binary patch$/m.test(diff)) throw fault('GIT_BINARY');
      return { path: selected, originalPath: file?.originalPath ?? null, staged, kind: untracked ? 'untracked' : 'tracked', diff, binary: false };
    });
  }
  close() {
    if (this.closing) return this.closing;
    this.closed = true;
    for (const controller of this.operations.keys()) controller.abort(fault('GIT_ABORTED'));
    let timer;
    const cleanup=async()=>{
      await Promise.allSettled([...this.operations.values()]);
      const results=await Promise.allSettled([
        ...[...this.children].map(async child=>{await terminate(child,this.killGraceMs,this.cleanupWaitMs);this.children.delete(child);this.childOwners.get(child)?.childPids.delete(child.pid);}),
        ...[...this.cleanupTasks].map(resource=>this._cleanResource(resource)),
      ]);
      if(results.some(result=>result.status==='rejected')||this.operations.size||this.children.size||this.cleanupTasks.size)throw fault('GIT_CLEANUP_FAILED');
    };
    const closing=Promise.race([cleanup(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(fault('GIT_CLEANUP_FAILED')),this.closeTimeoutMs);})]).finally(()=>clearTimeout(timer));
    this.closing=closing;void closing.catch(()=>{if(this.closing===closing)this.closing=null;});return closing;
  }
}
