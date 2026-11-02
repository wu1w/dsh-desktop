import {fixtureSymlink} from './fixtures/fs-platform.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import promises, { mkdtemp, mkdir, writeFile, readFile, stat, truncate, realpath, rename, unlink, symlink, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const appRoot = process.env.DSH_ACCEPTANCE_APP_ROOT;
const { readProjectFileInfo, readProjectFile } = await import(appRoot ? pathToFileURL(path.join(appRoot, 'server/files.mjs')) : new URL('../server/files.mjs', import.meta.url));
const execute = promisify(execFile);
async function temporary(action) { const root = await mkdtemp(path.join(tmpdir(), 'dsh-file-info-')); try { await action(root); } finally { await rm(root, { recursive: true, force: true }); } }

test('file info returns only ordinary metadata with ISO time and canonical internal aliases', async () => temporary(async root => {
  const target = path.join(root, '中文 文档.txt'), content = Buffer.from('\ufeff中文😀\r\n'); await writeFile(target, content); await fixtureSymlink(target, path.join(root, 'alias.txt'));
  const metadata = await stat(target), info = await readProjectFileInfo(root, '中文 文档.txt');
  assert.deepEqual(info, { path: '中文 文档.txt', name: '中文 文档.txt', size: content.length, modifiedAt: metadata.mtime.toISOString() });
  assert.deepEqual(Object.keys(info).sort(), ['modifiedAt', 'name', 'path', 'size']);
  assert.deepEqual(await readProjectFileInfo(root, 'alias.txt'), { ...info, path: 'alias.txt' });
  assert.deepEqual(await readFile(target), content); assert.equal((await stat(target)).mtimeMs, metadata.mtimeMs);
}));

test('metadata accepts malformed UTF-8, binary bytes and large sparse files without weakening strict preview', async () => temporary(async root => {
  for (const [name, bytes, code] of [['legacy.txt', Buffer.from([0xe4, 0xb8]), 'FILE_ENCODING'], ['binary.bin', Buffer.from([1, 0, 255]), 'BINARY_FILE']]) {
    await writeFile(path.join(root, name), bytes); assert.equal((await readProjectFileInfo(root, name)).size, bytes.length);
    await assert.rejects(readProjectFile(root, name), error => error.code === code || error.message === code);
    assert.deepEqual(await readFile(path.join(root, name)), bytes);
  }
  const target = path.join(root, 'large.bin'); await writeFile(target, ''); await truncate(target, 64 * 1024 * 1024);
  assert.equal((await readProjectFileInfo(root, 'large.bin')).size, 64 * 1024 * 1024);
  await assert.rejects(readProjectFile(root, 'large.bin'), /FILE_LIMIT/);
}));

test('metadata opens with no-follow and nonblocking flags and never reads body bytes', async t => temporary(async root => {
  const target = path.join(root, 'large.bin'); await writeFile(target, ''); await truncate(target, 64 * 1024 * 1024); const canonical = await realpath(target);
  const originalOpen = promises.open; let intercept, closed = false, reads = 0, flags;
  try {
    intercept = t.mock.method(promises, 'open', async (...args) => {
      const handle = await originalOpen(...args); if (args[0] !== canonical) return handle; flags = args[1];
      return { stat: (...parameters) => handle.stat(...parameters), read: () => { reads++; throw Error('BODY_READ_FORBIDDEN'); }, readFile: () => { reads++; throw Error('BODY_READ_FORBIDDEN'); }, async close() { closed = true; await handle.close(); } };
    }); syncBuiltinESMExports();
    assert.equal((await readProjectFileInfo(root, 'large.bin')).size, 64 * 1024 * 1024);
    if(process.platform==='win32'){assert.equal(constants.O_NOFOLLOW,undefined);assert.equal(flags,constants.O_RDONLY);}else{assert.ok(flags & constants.O_NOFOLLOW);assert.ok(flags & constants.O_NONBLOCK);}assert.equal(reads, 0); assert.equal(closed, true);
  } finally { intercept?.mock.restore(); syncBuiltinESMExports(); }
}));

test('metadata rejects traversal, external files and external sensitive metadata aliases', async () => temporary(async root => {
  const project = path.join(root, 'project'), outside = path.join(root, 'outside'); await mkdir(project); await mkdir(outside); await writeFile(path.join(outside, 'config'), 'private');
  await fixtureSymlink(path.join(outside, 'config'), path.join(project, 'alias.txt')); await fixtureSymlink(outside, path.join(project, '.git')); await fixtureSymlink('/dev/null', path.join(project, 'device'));
  for (const relative of ['../outside/config', 'alias.txt', '.git/config', 'device']) await assert.rejects(readProjectFileInfo(project, relative), /OUTSIDE_PROJECT/);
  for (const relative of ['/absolute', 'contains\0null', undefined]) await assert.rejects(readProjectFileInfo(project, relative), /INVALID_PATH/);
  await assert.rejects(readProjectFileInfo(project, 'missing.txt'), { code: 'ENOENT' });
}));

for(const kind of ['directory','fifo'])test(kind+' metadata is rejected without blocking or leaking a descriptor', { timeout: 3000,skip:kind==='fifo'&&process.platform==='win32'?'POSIX FIFO is unavailable on Windows':false }, async t => temporary(async root => {
  if(kind==='directory')await mkdir(path.join(root,kind));else await execute('mkfifo',[path.join(root,kind)]);
  const originalOpen = promises.open; let intercept, opened = 0, closed = 0;
  try {
    intercept = t.mock.method(promises, 'open', async (...args) => { const handle = await originalOpen(...args); opened++; return { stat: (...parameters) => handle.stat(...parameters), async close() { closed++; await handle.close(); } }; }); syncBuiltinESMExports();
    await assert.rejects(readProjectFileInfo(root,kind), { code: 'FILE_LIMIT' });
    assert.equal(opened,1); assert.equal(closed,1);
  } finally { intercept?.mock.restore(); syncBuiltinESMExports(); }
}));

test('metadata rejects content changes, inode replacements and disappearance between checks and closes each handle', async t => temporary(async root => {
  const originalOpen = promises.open; let intercept;
  for (const mode of ['changed', 'replaced', 'missing']) {
    const target = path.join(root, mode); await writeFile(target, 'original'); const canonical = await realpath(target); let calls = 0, closed = false;
    try {
      intercept = t.mock.method(promises, 'open', async (...args) => {
        const handle = await originalOpen(...args); if (args[0] !== canonical) return handle;
        return {
          async stat(...parameters) {
            const metadata = await handle.stat(...parameters);
            if (++calls === 1) {
              if (mode === 'changed') await writeFile(target, 'external changed content');
              else if(process.platform==='win32'){
                // NTFS denies replacing this open handle. Inject only the
                // second pathname stat to exercise the same race boundary;
                // retain the actual descriptor and its close obligation.
                const nativeStat=promises.stat,pathnameStat=t.mock.method(promises,'stat',async(file,...options)=>{
                  if(file!==canonical)return nativeStat(file,...options);
                  if(mode==='missing')throw Object.assign(Error('controlled disappearance'),{code:'ENOENT'});
                  const info=await nativeStat(file,...options);return Object.assign(info,{ino:-1});
                });syncBuiltinESMExports();t.after(()=>{pathnameStat.mock.restore();syncBuiltinESMExports();});
              }
              else if (mode === 'replaced') { const replacement = path.join(root, 'replacement'); await writeFile(replacement, 'original'); await rename(replacement, target); }
              else await unlink(target);
            }
            return metadata;
          },
          async close() { closed = true; await handle.close(); },
        };
      }); syncBuiltinESMExports();
      await assert.rejects(readProjectFileInfo(root, mode), { code: 'FILE_CHANGED' }); assert.equal(closed, true);
    } finally { intercept?.mock.restore(); intercept = null; syncBuiltinESMExports(); }
  }
}));
