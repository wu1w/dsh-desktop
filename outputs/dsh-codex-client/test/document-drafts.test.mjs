import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,readFile,writeFile,stat,lstat,readdir,symlink} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {DocumentDraftStore,MAX_DOCUMENT_DRAFT_BYTES} from '../server/document-drafts.mjs';

const base={projectId:'project-one',path:'notes/chapter.md',version:'a'.repeat(64),content:'未保存的正文'};
async function fixture(){return mkdtemp(path.join(tmpdir(),'dsh-document-drafts-'));}
async function rejectsCode(promise,code){await assert.rejects(promise,error=>error.code===code);}

test('document recovery survives a new store without depending on the application URL or touching project text',async()=>{
  const root=await fixture();
  try {
    const project=path.join(root,'project');await mkdir(project);await writeFile(path.join(project,'chapter.md'),'saved original');
    const dataDir=path.join(root,'protected-data');const first=new DocumentDraftStore({dataDir});
    assert.deepEqual(await first.load(),[]);
    const saved=await first.save(base);
    assert.equal(saved.name,'chapter.md');assert.equal(saved.content,base.content);
    assert.ok(!Number.isNaN(Date.parse(saved.updatedAt)));
    const second=new DocumentDraftStore({dataDir});
    assert.deepEqual(await second.load(),[saved]);assert.deepEqual(await second.read(base),saved);
    assert.equal((await stat(path.join(dataDir,'document-drafts.json'))).mode&0o777,0o600);
    assert.equal((await stat(dataDir)).mode&0o777,0o700);
    assert.equal(await readFile(path.join(project,'chapter.md'),'utf8'),'saved original');
    assert.deepEqual(await second.clear(base),{cleared:true});assert.equal(await second.read(base),null);
    assert.deepEqual(await new DocumentDraftStore({dataDir}).read(),[]);
    assert.equal(await readFile(path.join(project,'chapter.md'),'utf8'),'saved original');
  }finally{await rm(root,{recursive:true,force:true});}
});

test('concurrent saves, reads, and clear are serialized without losing unrelated project drafts',async()=>{
  const root=await fixture();
  try {
    const store=new DocumentDraftStore({dataDir:root});
    const writes=Array.from({length:20},(_,index)=>store.save({...base,path:`notes/${index}.md`,content:String(index)}));
    const clearing=store.clear({...base,path:'notes/4.md'});
    const latest=store.save({...base,path:'notes/0.md',content:'latest queued value'});
    const reading=store.read();await Promise.all([...writes,clearing,latest]);
    const rows=await reading;assert.equal(rows.length,19);assert.equal(rows[0].content,'latest queued value');
    assert.equal(await store.read({...base,path:'notes/4.md'}),null);
    const restarted=await new DocumentDraftStore({dataDir:root}).load();
    assert.deepEqual(restarted,rows);
    assert.equal(new Set(rows.map(row=>row.updatedAt)).size,rows.length);
    assert.deepEqual((await readdir(root)).filter(name=>name.endsWith('.tmp')),[]);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('project identifiers, safe relative paths, file-version hashes, and UTF-8 body limits are validated before persistence',async()=>{
  const root=await fixture();
  try {
    const store=new DocumentDraftStore({dataDir:root});
    for(const change of [{projectId:''},{projectId:'../other'},{projectId:123},{path:''},{path:'../outside.md'},{path:'notes/../outside.md'},{path:'/absolute.md'},...(process.platform==='win32'?[{path:'C:\\outside.md'},{path:'notes\\..\\outside.md'}]:[]),{path:'a\0b'},{version:''},{version:'not-a-hash'},{content:null},{content:'a\0b'}])await rejectsCode(store.save({...base,...change}),'INVALID_DOCUMENT_DRAFT');
    assert.deepEqual(await store.read(),[]);
    const exact='你'.repeat(Math.floor(MAX_DOCUMENT_DRAFT_BYTES/3));
    await store.save({...base,content:exact});
    await rejectsCode(store.save({...base,content:exact+'你'}),'DOCUMENT_DRAFT_LIMIT');
    assert.equal((await store.read(base)).content,exact);
    await store.save({...base,path:'./目录/正文.md',version:'B'.repeat(64),content:''});
    const normalized=await store.read({...base,path:'目录/正文.md'});
    assert.equal(normalized.name,'正文.md');assert.equal(normalized.version,'b'.repeat(64));assert.equal(normalized.content,'');
  }finally{await rm(root,{recursive:true,force:true});}
});

test('a failed atomic replacement preserves the old file and memory, removes its temporary file, and allows retry',async()=>{
  const root=await fixture();
  try {
    const store=new DocumentDraftStore({dataDir:root});const saved=await store.save(base);
    const file=path.join(root,'document-drafts.json');const before=await readFile(file,'utf8');
    const replace=store._replaceFile.bind(store);
    store._replaceFile=async()=>{throw Object.assign(new Error('fixture full disk'),{code:'ENOSPC'});};
    await rejectsCode(store.save({...base,content:'must not become the live recovery draft'}),'DOCUMENT_DRAFTS_WRITE_FAILED');
    assert.deepEqual(await store.read(base),saved);assert.equal(await readFile(file,'utf8'),before);
    await rejectsCode(store.clear(base),'DOCUMENT_DRAFTS_WRITE_FAILED');
    assert.deepEqual(await store.read(base),saved);
    assert.deepEqual((await readdir(root)).filter(name=>name.endsWith('.tmp')),[]);
    store._replaceFile=replace;
    await store.save({...base,content:'retry saved'});
    assert.equal((await new DocumentDraftStore({dataDir:root}).read(base)).content,'retry saved');
  }finally{await rm(root,{recursive:true,force:true});}
});

test('corrupt recovery files are preserved, block accidental overwrite, and can be reread after an explicit external repair',async()=>{
  const root=await fixture();
  try {
    const file=path.join(root,'document-drafts.json');const corrupt='{incomplete document recovery';
    await writeFile(file,corrupt,{mode:0o640});const before=await stat(file);
    const store=new DocumentDraftStore({dataDir:root});
    await assert.rejects(store.load(),error=>error.code==='DOCUMENT_DRAFTS_CORRUPT'&&error.recoverable===true);
    await rejectsCode(store.save(base),'DOCUMENT_DRAFTS_CORRUPT');await rejectsCode(store.clear(base),'DOCUMENT_DRAFTS_CORRUPT');
    assert.equal(await readFile(file,'utf8'),corrupt);
    assert.equal((await stat(file)).mtimeMs,before.mtimeMs);assert.equal((await stat(file)).mode&0o777,0o640);
    await writeFile(file,JSON.stringify({version:1,drafts:[]}));assert.deepEqual(await store.load(),[]);
    await store.save(base);assert.equal((await store.read(base)).content,base.content);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('valid JSON with invalid draft schema or duplicate document keys is reported as recoverable corruption',async()=>{
  const root=await fixture();
  try {
    const file=path.join(root,'document-drafts.json');const valid={...base,updatedAt:'2026-10-24T00:00:00.000Z'};
    for(const parsed of [{version:2,drafts:[]},{version:1,drafts:{}},{version:1,drafts:[{...valid,version:'bad'}]},{version:1,drafts:[{...valid,path:'../outside'}]},{version:1,drafts:[{...valid,updatedAt:'not a date'}]},{version:1,drafts:[valid,valid]}]) {
      const original=JSON.stringify(parsed);await writeFile(file,original);
      await assert.rejects(new DocumentDraftStore({dataDir:root}).load(),error=>error.code==='DOCUMENT_DRAFTS_CORRUPT'&&error.recoverable);
      assert.equal(await readFile(file,'utf8'),original);
    }
  }finally{await rm(root,{recursive:true,force:true});}
});

test('a recovery-file symlink is never read or overwritten',async()=>{
  const root=await fixture();
  try {
    const outside=path.join(root,'outside.json');const dataDir=path.join(root,'data');await mkdir(dataDir);
    await writeFile(outside,'outside contents must survive');await symlink(outside,path.join(dataDir,'document-drafts.json'));
    const store=new DocumentDraftStore({dataDir});
    await rejectsCode(store.load(),'DOCUMENT_DRAFTS_UNSAFE');await rejectsCode(store.save(base),'DOCUMENT_DRAFTS_UNSAFE');
    assert.equal(await readFile(outside,'utf8'),'outside contents must survive');
    assert.equal((await lstat(path.join(dataDir,'document-drafts.json'))).isSymbolicLink(),true);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('invalid UTF-8 is preserved as corruption instead of silently replacing damaged document text',async()=>{
  const root=await fixture();
  try {
    const file=path.join(root,'document-drafts.json');
    const bytes=Buffer.from(JSON.stringify({version:1,drafts:[{...base,content:'fixture-corrupt-me',updatedAt:'2026-10-24T00:00:00.000Z'}]}));
    bytes[bytes.indexOf(Buffer.from('fixture-corrupt-me'))]=0xff;await writeFile(file,bytes);
    await rejectsCode(new DocumentDraftStore({dataDir:root}).load(),'DOCUMENT_DRAFTS_CORRUPT');
    assert.deepEqual(await readFile(file),bytes);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('caller mutation cannot change queued input or the persisted in-memory recovery snapshot',async()=>{
  const root=await fixture();
  try {
    const store=new DocumentDraftStore({dataDir:root});const input={...base};
    const saving=store.save(input);input.content='mutated after calling save';
    const result=await saving;assert.equal(result.content,base.content);result.content='mutated returned row';
    const rows=await store.read();rows[0].content='mutated returned list';rows.splice(0);
    assert.equal((await store.read(base)).content,base.content);
    assert.equal((await new DocumentDraftStore({dataDir:root}).read(base)).content,base.content);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('an actual writer killed after staging but before rename leaves the last complete recovery file readable',async()=>{
  const root=await fixture();let child;
  try {
    const previous=await new DocumentDraftStore({dataDir:root}).save(base);
    const moduleUrl=new URL('../server/document-drafts.mjs',import.meta.url).href;
    const code=`import {DocumentDraftStore} from ${JSON.stringify(moduleUrl)};
const store=new DocumentDraftStore({dataDir:${JSON.stringify(root)}});
store._replaceFile=async()=>{process.send({staged:true});await new Promise(()=>{});};
await store.save(${JSON.stringify({...base,content:'incomplete write must not replace the recoverable document'})});`;
    child=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['ignore','ignore','pipe','ipc']});
    let diagnostic='';child.stderr.on('data',chunk=>{diagnostic+=chunk.toString();});
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('DRAFT_WRITER_NOT_READY')),3000);
      child.once('message',message=>{clearTimeout(timer);message?.staged?resolve():reject(new Error('DRAFT_WRITER_INVALID_STAGE'));});
      child.once('error',error=>{clearTimeout(timer);reject(error);});
      child.once('exit',code=>{clearTimeout(timer);reject(new Error('DRAFT_WRITER_EXIT_'+code+' '+diagnostic));});
    });
    assert.equal((await readdir(root)).filter(name=>name.endsWith('.tmp')).length,1);
    const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await exited;child=null;
    assert.deepEqual(await new DocumentDraftStore({dataDir:root}).read(base),previous);
    assert.equal(JSON.parse(await readFile(path.join(root,'document-drafts.json'),'utf8')).drafts[0].content,base.content);
  }finally{if(child?.pid&&child.exitCode===null&&child.signalCode===null){const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await exited;}await rm(root,{recursive:true,force:true});}
});
