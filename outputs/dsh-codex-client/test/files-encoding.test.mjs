import test from 'node:test';
import assert from 'node:assert/strict';
import promises, { mkdtemp, writeFile, readFile, readdir, stat, symlink, rm, appendFile, realpath } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readProjectFile, writeProjectFile } from '../server/files.mjs';
import { fileErrors } from '../shared/file-errors.js';

const LIMIT = 2 * 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(action) {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-files-encoding-'));
  try { await action(root); } finally { await rm(root, { recursive: true, force: true }); }
}
async function noTemps(root) { assert.deepEqual((await readdir(root)).filter(name => name.endsWith('.tmp')), []); }

test('strict UTF-8 rejects malformed disk bytes and never rewrites them', async () => fixture(async root => {
  const malformed = [Buffer.from([0xc0, 0xaf]), Buffer.from([0xe4, 0xb8]), Buffer.from([0x80]), Buffer.from([0xed, 0xa0, 0x80]), Buffer.from([0xf4, 0x90, 0x80, 0x80])];
  for (let index = 0; index < malformed.length; index++) {
    const name = `${index}.txt`, target = path.join(root, name), bytes = malformed[index];
    await writeFile(target, bytes, { mode: 0o600 });
    const before = await stat(target);
    await assert.rejects(readProjectFile(root, name), { code: 'FILE_ENCODING' });
    await assert.rejects(writeProjectFile(root, name, 'replacement', hash(bytes)), { code: 'FILE_ENCODING' });
    assert.deepEqual(await readFile(target), bytes);
    assert.equal((await stat(target)).mtimeMs, before.mtimeMs);
  }
  await noTemps(root);
}));

test('NUL disk data and invalid JS text are rejected before temporary writing', async () => fixture(async root => {
  await writeFile(path.join(root, 'binary.txt'), Buffer.from([0x61, 0, 0x62]));
  await assert.rejects(readProjectFile(root, 'binary.txt'), /BINARY_FILE/);
  await writeFile(path.join(root, 'text.txt'), '原文', { mode: 0o600 });
  const original = await readFile(path.join(root, 'text.txt')), base = await readProjectFile(root, 'text.txt');
  for (const content of ['a\0b', '\ud800', '\udfff', '前\ud800后', '\ud800\ud800\udc00', '\udc00\ud800']) {
    await assert.rejects(writeProjectFile(root, 'text.txt', content, base.version), { code: 'FILE_INVALID_TEXT' });
    assert.deepEqual(await readFile(path.join(root, 'text.txt')), original);
    await noTemps(root);
  }
  await writeProjectFile(root, 'text.txt', '修复后 😀', base.version);
  assert.equal((await readProjectFile(root, 'text.txt')).content, '修复后 😀');
}));

test('Chinese, emoji, literal replacement characters, BOM and CRLF round trip byte for byte', async () => fixture(async root => {
  const content = '\ufeff中文 😀\r\n第二行\r\n合法替换字符 � 与组合 e\u0301\ufeff\r\n';
  const bytes = Buffer.from(content), target = path.join(root, '文档.txt');
  await writeFile(target, bytes, { mode: 0o600 });
  const file = await readProjectFile(root, '文档.txt');
  assert.equal(file.content, content);
  assert.equal(file.content.charCodeAt(0), 0xfeff);
  assert.equal(file.version, hash(bytes));
  await writeProjectFile(root, '文档.txt', file.content, file.version);
  assert.deepEqual(await readFile(target), bytes);
  assert.equal((await stat(target)).mode & 0o777, 0o600);
  const changed = content.replace('第二行', '已编辑');
  await writeProjectFile(root, '文档.txt', changed, file.version);
  assert.deepEqual(await readFile(target), Buffer.from(changed));
  await noTemps(root);
}));

test('UTF-8 character split at a file read chunk boundary remains exact', async () => fixture(async root => {
  const content = 'a'.repeat(64 * 1024 - 1) + '中😀文\r\n';
  await writeFile(path.join(root, 'boundary.txt'), content);
  const file = await readProjectFile(root, 'boundary.txt');
  assert.equal(file.content, content);
  assert.equal(file.version, hash(Buffer.from(content)));
}));

test('the 2 MiB limit counts actual UTF-8 bytes and allows exactly the limit', async () => fixture(async root => {
  const content = '中'.repeat(Math.floor(LIMIT / 3)) + 'x'.repeat(LIMIT % 3), target = path.join(root, 'limit.txt');
  assert.equal(Buffer.byteLength(content), LIMIT);
  await writeFile(target, content);
  const file = await readProjectFile(root, 'limit.txt');
  assert.equal(file.content, content);
  await writeProjectFile(root, 'limit.txt', content, file.version);
  await assert.rejects(writeProjectFile(root, 'limit.txt', content + '中', file.version), /FILE_LIMIT/);
  assert.equal((await stat(target)).size, LIMIT);
  await appendFile(target, 'x');
  await assert.rejects(readProjectFile(root, 'limit.txt'), /FILE_LIMIT/);
  await noTemps(root);
}));

test('a file growing after fstat is read at most limit plus one bytes and the handle is closed', async t => fixture(async root => {
  const target = path.join(root, 'growing.txt');
  await writeFile(target, Buffer.alloc(64 * 1024, 0x61));
  const canonicalTarget = await realpath(target);
  const originalOpen = promises.open;
  let intercepted, reads = 0, consumed = 0, requested = 0, closed = false;
  try {
    intercepted = t.mock.method(promises, 'open', async (...args) => {
      const handle = await originalOpen(...args);
      if (args[0] !== canonicalTarget) return handle;
      return {
        stat: (...parameters) => handle.stat(...parameters),
        async read(...parameters) {
          requested += parameters[2];
          const result = await handle.read(...parameters);
          consumed += result.bytesRead;
          if (++reads === 1) await appendFile(target, Buffer.alloc(LIMIT, 0x62));
          return result;
        },
        async close() { closed = true; await handle.close(); },
      };
    });
    syncBuiltinESMExports();
    await assert.rejects(readProjectFile(root, 'growing.txt'), { code: 'FILE_LIMIT' });
    assert.equal(consumed, LIMIT + 1);
    assert.equal(requested, LIMIT + 1);
    assert.equal(closed, true);
    await noTemps(root);
  } finally { intercepted?.mock.restore(); syncBuiltinESMExports(); }
}));

test('Unicode saves keep canonical alias CAS and a rejected save does not poison its lock', async () => fixture(async root => {
  await writeFile(path.join(root, '文档.txt'), '\ufeff初稿\r\n', { mode: 0o600 });
  await symlink(path.join(root, '文档.txt'), path.join(root, 'alias.txt'));
  const base = await readProjectFile(root, '文档.txt'), contents = ['\ufeff甲😀\r\n', '\ufeff乙😀\r\n'];
  const results = await Promise.allSettled(contents.map((content, index) => writeProjectFile(root, index ? 'alias.txt' : '文档.txt', content, base.version)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.message, 'FILE_CHANGED');
  const winner = results.findIndex(result => result.status === 'fulfilled'), saved = await readProjectFile(root, '文档.txt');
  assert.deepEqual(await readFile(path.join(root, '文档.txt')), Buffer.from(contents[winner]));
  assert.equal(saved.version, hash(Buffer.from(contents[winner])));
  await assert.rejects(writeProjectFile(root, 'alias.txt', '\ud800', saved.version), { code: 'FILE_INVALID_TEXT' });
  await writeProjectFile(root, 'alias.txt', '\ufeff再次保存\r\n', saved.version);
  assert.equal((await readProjectFile(root, '文档.txt')).content, '\ufeff再次保存\r\n');
  await noTemps(root);
}));

test('all file error codes have nonempty Chinese and English resources', () => {
  for (const [code, translations] of Object.entries(fileErrors)) {
    assert.match(code, /^[A-Z_]+$/);
    assert.equal(translations.length, 2);
    assert.ok(translations.every(value => typeof value === 'string' && value.length > 0));
  }
});
