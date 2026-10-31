import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const appRoot = process.env.DSH_ACCEPTANCE_APP_ROOT;
const { DocumentDraftStore } = await import(appRoot ? pathToFileURL(path.join(appRoot, 'server/document-drafts.mjs')) : new URL('../server/document-drafts.mjs', import.meta.url));
const base = { projectId: 'project-one', version: 'a'.repeat(64), content: '未保存正文😀\r\n' };
const names = ['a\\b.txt', 'notes\\..\\outside.md', 'C:notes.txt', 'C:\\outside.md', '\\literal.txt', 'line\nname.txt', 'tab\tname.txt', 'escape\x1bname.txt', 'delete\x7fname.txt', 'report:part.txt', 'hash#part?.md', 'percent%file.md', '中文😀.txt', ' leading and trailing .txt '];
async function temporary(action) { const root = await mkdtemp(path.join(tmpdir(), 'dsh-draft-paths-')); try { await action(root); } finally { await rm(root, { recursive: true, force: true }); } }

test('POSIX draft keys preserve literal filename characters across save/read/restart/clear without ABA aliases', { skip: process.platform === 'win32' }, async () => temporary(async root => {
  const store = new DocumentDraftStore({ dataDir: root });
  const saved = [];
  for (const name of names) saved.push(await store.save({ ...base, path: name, content: 'body for ' + JSON.stringify(name) }));
  const restarted = new DocumentDraftStore({ dataDir: root }); await restarted.load();
  for (let index = 0; index < names.length; index++) {
    assert.equal((await restarted.read({ projectId: base.projectId, path: names[index] })).path, names[index]);
    assert.deepEqual(await restarted.read({ projectId: base.projectId, path: names[index] }), saved[index]);
  }
  await store.save({ ...base, path: 'a/b.txt', content: 'slash is a directory separator' });
  assert.notEqual((await store.read({ projectId: base.projectId, path: 'a/b.txt' })).content, (await store.read({ projectId: base.projectId, path: 'a\\b.txt' })).content);
  const encoded = await readFile(path.join(root, 'document-drafts.json'), 'utf8');
  assert.equal(JSON.parse(encoded).drafts.length, names.length + 1);
  assert.ok(encoded.includes('line\\nname.txt')); assert.ok(encoded.includes('escape\\u001bname.txt')); assert.ok(encoded.includes('a\\\\b.txt'));
  for (const name of names) { assert.deepEqual(await store.clear({ projectId: base.projectId, path: name }), { cleared: true }); assert.equal(await store.read({ projectId: base.projectId, path: name }), null); }
  await store.clear({ projectId: base.projectId, path: 'a/b.txt' }); assert.deepEqual(await new DocumentDraftStore({ dataDir: root }).read(), []);
}));

test('normalization stays consistent while absolute, parent-segment, NUL and byte-limit keys remain rejected', async () => temporary(async root => {
  const store = new DocumentDraftStore({ dataDir: root });
  const saved = await store.save({ ...base, path: './目录//正文.md' });
  assert.equal(saved.path, '目录/正文.md'); assert.deepEqual(await store.read({ projectId: base.projectId, path: '目录/正文.md' }), saved);
  assert.deepEqual(await store.clear({ projectId: base.projectId, path: './目录//正文.md' }), { cleared: true });
  for (const name of ['', '.', './', 'directory/', '/absolute', '//host/absolute', '..', '../outside', 'nested/../outside', 'nested/..', 'a\0b', '你'.repeat(1366)]) {
    await assert.rejects(store.save({ ...base, path: name }), { code: 'INVALID_DOCUMENT_DRAFT' });
    await assert.rejects(store.read({ projectId: base.projectId, path: name }), { code: 'INVALID_DOCUMENT_DRAFT' });
    await assert.rejects(store.clear({ projectId: base.projectId, path: name }), { code: 'INVALID_DOCUMENT_DRAFT' });
  }
  const exact = '你'.repeat(1365) + 'a'; assert.equal(Buffer.byteLength(exact), 4096);
  await store.save({ ...base, path: exact }); assert.equal((await store.read({ projectId: base.projectId, path: exact })).path, exact);
}));

test('actual Windows platform retains strict drive, backslash and control rejection', { skip: process.platform !== 'win32' }, async () => temporary(async root => {
  const store = new DocumentDraftStore({ dataDir: root });
  for (const name of ['C:notes.txt', 'C:\\outside.md', 'notes\\..\\outside.md', 'line\nname.txt']) await assert.rejects(store.save({ ...base, path: name }), { code: 'INVALID_DOCUMENT_DRAFT' });
}));

test('the bounded recovery envelope accepts worst-case escaped paths together with the existing full body capacity', { skip: process.platform === 'win32', timeout: 20000 }, async () => temporary(async root => {
  // Build one valid recovery image, rather than rewriting a growing 100 MiB
  // image 128 times. C0 bytes expand sixfold in both JSON body and path.
  const content = '\x01'.repeat(16 * 1024 * 1024 / 128);
  const drafts = Array.from({ length: 128 }, (_, index) => ({ ...base, path: String(index).padStart(3, '0') + '\x01'.repeat(4093), content, updatedAt: '2026-10-24T00:00:00.000Z' }));
  let encoded = JSON.stringify({ version: 1, drafts });
  assert.ok(Buffer.byteLength(encoded) > 16 * 1024 * 1024 * 6 + 128 * 8192 + 1024, 'this valid image exceeded the old path-insensitive envelope');
  await writeFile(path.join(root, 'document-drafts.json'), encoded); encoded = null;
  const restored = await new DocumentDraftStore({ dataDir: root }).load();
  assert.equal(restored.length, 128); assert.equal(restored.reduce((bytes, row) => bytes + Buffer.byteLength(row.content), 0), 16 * 1024 * 1024);
  assert.ok(restored.every(row => Buffer.byteLength(row.path) === 4096 && row.content === content));
}));
