import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { startHost } from '../server/index.mjs';

async function client(host, locale = 'en') {
  const response = await fetch(host.url + '/api/bootstrap');
  const boot = await response.json();
  const headers = { cookie: response.headers.get('set-cookie').split(';')[0], 'x-dsh-capability': boot.capability, 'content-type': 'application/json', 'accept-language': locale };
  return async (route, body) => {
    const response = await fetch(host.url + '/api/' + route, { headers, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
    return { status: response.status, ...await response.json() };
  };
}

test('document recovery survives an actual host restart on a different port without writing the project file', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-draft-api-')); let host, reservation;
  try {
    const projectDirectory = path.join(root, 'project'), dataDir = path.join(root, 'owned');
    await mkdir(projectDirectory); await writeFile(path.join(projectDirectory, 'document.md'), 'original disk text');
    host = await startHost({ dataDir, autoStart: false }); let api = await client(host);
    const project = await api('projects', { path: projectDirectory, name: 'Draft project' });
    const original = await api(`projects/${project.id}/file?path=document.md`);
    const saved = await api('document-drafts/save', { projectId: project.id, path: 'document.md', version: original.version, content: '未保存的中文编辑' });
    assert.equal(saved.status, 200); assert.equal(saved.draft.name, 'document.md');
    assert.equal(await readFile(path.join(projectDirectory, 'document.md'), 'utf8'), 'original disk text');
    // Reserve an alternate port while the first is still bound: this is a real
    // origin change, rather than assuming the OS chooses a different free port.
    reservation = net.createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const secondPort = reservation.address().port, firstUrl = host.url;
    await host.close(); host = null;
    await new Promise(resolve => reservation.close(resolve)); reservation = null;
    host = await startHost({ dataDir, port: secondPort, autoStart: false }); api = await client(host);
    assert.notEqual(host.url, firstUrl);
    const restored = await api('document-drafts'); assert.equal(restored.drafts.length, 1); assert.equal(restored.drafts[0].content, '未保存的中文编辑'); assert.equal(restored.drafts[0].version, original.version);
    const one = await api(`document-drafts?projectId=${project.id}&path=document.md`); assert.equal(one.draft.content, '未保存的中文编辑');
    await api('plugins/feature-files/disable', {}); assert.equal((await api('document-drafts')).status, 404);
    await api('plugins/feature-files/enable', {}); assert.equal((await api('document-drafts')).drafts.length, 1);
    assert.equal((await api('document-drafts/clear', { projectId: project.id, path: 'document.md' })).cleared, true);
    assert.equal((await api('document-drafts')).drafts.length, 0);
    assert.equal(await readFile(path.join(projectDirectory, 'document.md'), 'utf8'), 'original disk text');
  } finally { await host?.close(); if (reservation) await new Promise(resolve => reservation.close(resolve)); await rm(root, { recursive: true, force: true }); }
});

test('draft APIs enforce actual project and symlink boundaries instead of trusting a recovery path', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-draft-boundary-api-')); let host;
  try {
    const projectDirectory = path.join(root, 'project'), outside = path.join(root, 'outside');
    await mkdir(projectDirectory); await mkdir(outside); await writeFile(path.join(outside, 'external.md'), 'preserve');
    await symlink(outside, path.join(projectDirectory, 'linked'));
    host = await startHost({ dataDir: path.join(root, 'owned'), autoStart: false }); const api = await client(host);
    const project = await api('projects', { path: projectDirectory, name: 'Bounded draft' });
    const draft = { projectId: project.id, path: 'linked/external.md', version: 'a'.repeat(64), content: 'must not save' };
    assert.equal((await api('document-drafts/save', draft)).code, 'OUTSIDE_PROJECT');
    assert.equal((await api('document-drafts/save', { ...draft, path: '../outside/external.md' })).code, 'OUTSIDE_PROJECT');
    assert.equal((await api('document-drafts/save', { ...draft, projectId: 'unknown' })).code, 'NOT_FOUND');
    assert.equal((await api('document-drafts')).drafts.length, 0); assert.equal(await readFile(path.join(outside, 'external.md'), 'utf8'), 'preserve');
  } finally { await host?.close(); await rm(root, { recursive: true, force: true }); }
});

test('corrupt recovery data remains intact and visible while ordinary project browsing stays usable', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-draft-corrupt-api-')); let host;
  try {
    const dataDir = path.join(root, 'owned'), projectDirectory = path.join(root, 'project');
    await mkdir(dataDir); await mkdir(projectDirectory); await writeFile(path.join(projectDirectory, 'document.md'), 'still browsable');
    const corrupt = '{ keep this broken recovery copy'; await writeFile(path.join(dataDir, 'document-drafts.json'), corrupt);
    host = await startHost({ dataDir, autoStart: false }); const api = await client(host);
    const recovery = await api('document-drafts'); assert.equal(recovery.status, 400); assert.equal(recovery.code, 'DOCUMENT_DRAFTS_CORRUPT'); assert.match(recovery.message, /preserved/);
    const project = await api('projects', { path: projectDirectory, name: 'Usable project' });
    assert.equal((await api(`projects/${project.id}/file?path=document.md`)).content, 'still browsable');
    assert.equal((await api('document-drafts/save', { projectId: project.id, path: 'document.md', version: 'a'.repeat(64), content: 'pending' })).code, 'DOCUMENT_DRAFTS_CORRUPT');
    assert.equal(await readFile(path.join(dataDir, 'document-drafts.json'), 'utf8'), corrupt);
  } finally { await host?.close(); await rm(root, { recursive: true, force: true }); }
});
