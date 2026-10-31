import test from 'node:test';
import assert from 'node:assert/strict';
import promises, { mkdtemp, writeFile, symlink, rm, mkdir, readdir, stat } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readProjectFile, writeProjectFile, listProjectFiles } from '../server/files.mjs';
test('project access rejects traversal and external symlinks; stale edits cannot overwrite newer text', async () => {
  const root=await mkdtemp(path.join(tmpdir(),'dsh-client-files-'));
  try {
    const project=path.join(root,'project');await mkdir(project);
    await writeFile(path.join(root,'outside.txt'),'outside');
    await writeFile(path.join(project,'inside.md'),'first');
    await symlink(path.join(root,'outside.txt'),path.join(project,'alias.txt'));
    await assert.rejects(readProjectFile(project,'../outside.txt'),/OUTSIDE_PROJECT/);
    await assert.rejects(readProjectFile(project,'alias.txt'),/OUTSIDE_PROJECT/);
    await assert.rejects(writeProjectFile(project,'../outside.txt','overwrite','ignored'),/OUTSIDE_PROJECT/);
    await assert.rejects(writeProjectFile(project,'alias.txt','overwrite','ignored'),/OUTSIDE_PROJECT/);
    assert.equal((await listProjectFiles(project)).some(file=>file.name==='alias.txt'),false);
    const first=await readProjectFile(project,'inside.md');
    await writeFile(path.join(project,'inside.md'),'newer');
    await assert.rejects(writeProjectFile(project,'inside.md','stale',first.version),/FILE_CHANGED/);
    assert.equal((await readProjectFile(project,'inside.md')).content,'newer');
  } finally {await rm(root,{recursive:true,force:true});}
});

test('concurrent saves through canonical aliases accept one base version once and release the lock after conflict', async () => {
  const root=await mkdtemp(path.join(tmpdir(),'dsh-client-file-cas-'));
  try {
    await writeFile(path.join(root,'document.md'),'original',{mode:0o600});
    await symlink(path.join(root,'document.md'),path.join(root,'alias.md'));
    const base=await readProjectFile(root,'document.md');
    const contents=['first concurrent save','second concurrent save'];
    const results=await Promise.allSettled([
      writeProjectFile(root,'document.md',contents[0],base.version),
      writeProjectFile(root,'alias.md',contents[1],base.version),
    ]);
    assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
    assert.equal(results.filter(result=>result.status==='rejected').length,1);
    assert.match(results.find(result=>result.status==='rejected').reason.message,/^FILE_CHANGED$/);
    const winner=results.findIndex(result=>result.status==='fulfilled');
    const saved=await readProjectFile(root,'document.md');
    assert.equal(saved.content,contents[winner]);
    assert.equal((await stat(path.join(root,'document.md'))).mode&0o777,0o600);
    assert.deepEqual((await readdir(root)).filter(name=>name.endsWith('.tmp')),[]);
    await writeProjectFile(root,'alias.md','saved after conflict',saved.version);
    assert.equal((await readProjectFile(root,'document.md')).content,'saved after conflict');
    assert.deepEqual((await readdir(root)).filter(name=>name.endsWith('.tmp')),[]);
  } finally {await rm(root,{recursive:true,force:true});}
});

test('a disk edit during temporary writing is detected before rename and leaves the external text intact', async t => {
  const root=await mkdtemp(path.join(tmpdir(),'dsh-client-file-external-'));
  const target=path.join(root,'document.md');
  const originalWriteFile=promises.writeFile;
  let intercept;
  try {
    await originalWriteFile(target,'original',{mode:0o600});
    const base=await readProjectFile(root,'document.md');
    let edited=false;
    intercept=t.mock.method(promises,'writeFile',async (...args)=>{
      const result=await originalWriteFile(...args);
      if(String(args[0]).endsWith('.tmp')&&!edited){edited=true;await originalWriteFile(target,'external edit during save');}
      return result;
    });
    // Keep this race deterministic without adding a test hook to production.
    syncBuiltinESMExports();
    await assert.rejects(writeProjectFile(root,'document.md','client edit',base.version),/^Error: FILE_CHANGED$/);
    assert.equal(edited,true);
    assert.equal((await readProjectFile(root,'document.md')).content,'external edit during save');
    assert.deepEqual((await readdir(root)).filter(name=>name.endsWith('.tmp')),[]);
    intercept.mock.restore();intercept=null;syncBuiltinESMExports();
    const fresh=await readProjectFile(root,'document.md');
    await writeProjectFile(root,'document.md','saved after external conflict',fresh.version);
    assert.equal((await readProjectFile(root,'document.md')).content,'saved after external conflict');
  } finally {
    intercept?.mock.restore();syncBuiltinESMExports();
    await rm(root,{recursive:true,force:true});
  }
});

test('a temporary write failure cleans partial data and does not poison later saves', async t => {
  const root=await mkdtemp(path.join(tmpdir(),'dsh-client-file-failure-'));
  const originalWriteFile=promises.writeFile;
  let intercept;
  try {
    await originalWriteFile(path.join(root,'document.md'),'original');
    const base=await readProjectFile(root,'document.md');
    intercept=t.mock.method(promises,'writeFile',async (...args)=>{
      await originalWriteFile(...args);
      if(String(args[0]).endsWith('.tmp'))throw Object.assign(new Error('INJECTED_WRITE_FAILURE'),{code:'EIO'});
    });
    syncBuiltinESMExports();
    await assert.rejects(writeProjectFile(root,'document.md','partial failed save',base.version),/INJECTED_WRITE_FAILURE/);
    assert.equal((await readProjectFile(root,'document.md')).content,'original');
    assert.deepEqual((await readdir(root)).filter(name=>name.endsWith('.tmp')),[]);
    intercept.mock.restore();intercept=null;syncBuiltinESMExports();
    await writeProjectFile(root,'document.md','recovered save',base.version);
    assert.equal((await readProjectFile(root,'document.md')).content,'recovered save');
  } finally {
    intercept?.mock.restore();syncBuiltinESMExports();
    await rm(root,{recursive:true,force:true});
  }
});
