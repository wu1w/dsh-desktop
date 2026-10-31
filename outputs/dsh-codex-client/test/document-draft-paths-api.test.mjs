import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import net from 'node:net';

const appRoot = process.env.DSH_ACCEPTANCE_APP_ROOT;
const { startHost } = await import(appRoot ? pathToFileURL(path.join(appRoot, 'server/index.mjs')) : new URL('../server/index.mjs', import.meta.url));
const names = ['a\\b.txt', 'notes\\..\\outside.md', 'C:notes.txt', 'C:\\outside.md', 'line\nname.txt', 'tab\tname.txt', 'escape\x1bname.txt', 'delete\x7fname.txt', 'hash#part?.md'];
async function connection(host) {
  const response = await fetch(host.url + '/api/bootstrap'), boot = await response.json(), headers = { cookie: response.headers.get('set-cookie').split(';')[0], 'x-dsh-capability': boot.capability, 'content-type': 'application/json', 'accept-language': 'en' };
  return async (route, body) => { const response = await fetch(host.url + '/api/' + route, { headers, method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body) }); return { status: response.status, body: await response.json() }; };
}

test('literal POSIX filename drafts survive actual authenticated HTTP and a different-port host restart', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-draft-paths-api-')); let host, reservation;
  try {
    const projectPath = path.join(root, 'project'), dataDir = path.join(root, 'data'); await mkdir(projectPath);
    for (const name of names) await writeFile(path.join(projectPath, name), '原磁盘内容\r\n');
    host = await startHost({ dataDir, autoStart: false }); let api = await connection(host); const project = (await api('projects', { path: projectPath })).body;
    const rows = [];
    for (const name of names) {
      const file = (await api(`projects/${project.id}/file?path=${encodeURIComponent(name)}`)).body;
      const payload = { projectId: project.id, path: name, version: file.version, content: '未保存 ' + JSON.stringify(name) };
      const saved = await api('document-drafts/save', payload); assert.equal(saved.status, 200); assert.equal(saved.body.draft.path, name); rows.push(saved.body.draft);
      assert.equal((await api(`document-drafts?projectId=${project.id}&path=${encodeURIComponent(name)}`)).body.draft.content, payload.content);
      assert.equal(await readFile(path.join(projectPath, name), 'utf8'), '原磁盘内容\r\n');
    }
    reservation = net.createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve)); const port = reservation.address().port, oldUrl = host.url;
    await host.close(); host = null; await new Promise(resolve => reservation.close(resolve)); reservation = null;
    host = await startHost({ dataDir, port, autoStart: false }); api = await connection(host); assert.notEqual(host.url, oldUrl);
    const restored = (await api('document-drafts')).body.drafts; assert.equal(restored.length, names.length);
    for (let index = 0; index < names.length; index++) {
      const name = names[index]; assert.deepEqual((await api(`document-drafts?projectId=${project.id}&path=${encodeURIComponent(name)}`)).body.draft, rows[index]);
      assert.equal((await api('document-drafts/clear', { projectId: project.id, path: name })).body.cleared, true);
      assert.equal((await api('document-drafts/clear', { projectId: project.id, path: name })).body.cleared, false);
      assert.equal(await readFile(path.join(projectPath, name), 'utf8'), '原磁盘内容\r\n');
    }
    assert.deepEqual((await api('document-drafts')).body.drafts, []); assert.equal(host.engine, undefined);
  } finally { await host?.close(); if (reservation) await new Promise(resolve => reservation.close(resolve)); await rm(root, { recursive: true, force: true }); }
});

test('allowing literal filename characters does not allow traversal, external aliases or unknown projects', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-draft-paths-boundary-')); let host;
  try {
    const projectPath = path.join(root, 'project'), outside = path.join(root, 'outside'); await mkdir(projectPath); await mkdir(outside); await writeFile(path.join(outside, 'external.md'), 'preserve'); await symlink(outside, path.join(projectPath, 'link'));
    host = await startHost({ dataDir: path.join(root, 'data'), autoStart: false }); const api = await connection(host), project = (await api('projects', { path: projectPath })).body;
    const draft = { projectId: project.id, version: 'a'.repeat(64), content: 'must not escape' };
    for (const name of ['../outside/external.md', 'link/external.md']) assert.equal((await api('document-drafts/save', { ...draft, path: name })).body.code, 'OUTSIDE_PROJECT');
    assert.equal((await api('document-drafts/save', { ...draft, path: 'safe.txt', projectId: 'unknown' })).body.code, 'NOT_FOUND');
    assert.equal((await api('document-drafts/save', { ...draft, path: 'bad\0name' })).body.code, 'INVALID_PATH');
    assert.equal((await api('document-drafts/clear', { ...draft, path: 'nested/../outside.md' })).body.code, 'INVALID_DOCUMENT_DRAFT');
    assert.equal(await readFile(path.join(outside, 'external.md'), 'utf8'), 'preserve'); assert.deepEqual((await api('document-drafts')).body.drafts, []);
  } finally { await host?.close(); await rm(root, { recursive: true, force: true }); }
});
