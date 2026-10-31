import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, truncate, symlink, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const appRoot = process.env.DSH_ACCEPTANCE_APP_ROOT;
const { startHost } = await import(appRoot ? pathToFileURL(path.join(appRoot, 'server/index.mjs')) : new URL('../server/index.mjs', import.meta.url));
const execute = promisify(execFile);

test('authenticated file-info API exposes honest metadata without allowing unavailable text to be edited', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-file-info-api-')); let host;
  try {
    const projectPath = path.join(root, 'project'); await mkdir(projectPath);
    host = await startHost({ dataDir: path.join(root, 'data'), autoStart: false });
    const response = await fetch(host.url + '/api/bootstrap'), boot = await response.json();
    const headers = { cookie: response.headers.get('set-cookie').split(';')[0], 'x-dsh-capability': boot.capability, 'content-type': 'application/json', 'accept-language': 'en' };
    const api = async (route, body) => { const response = await fetch(host.url + '/api/' + route, { headers, method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body) }); return { status: response.status, body: await response.json() }; };
    const project = (await api('projects', { path: projectPath })).body, route = `projects/${project.id}/file-info`, query = name => '?path=' + encodeURIComponent(name);

    await t.test('ordinary UTF-8 metadata has the exact four-field shape, size and ISO timestamp', async () => {
      const target = path.join(projectPath, '中文 文件.txt'), content = Buffer.from('\ufeff中文😀\r\n'); await writeFile(target, content); const metadata = await stat(target);
      const result = await api(route + query('中文 文件.txt'));
      assert.equal(result.status, 200); assert.deepEqual(result.body, { path: '中文 文件.txt', name: '中文 文件.txt', size: content.length, modifiedAt: metadata.mtime.toISOString() });
      assert.deepEqual(await readFile(target), content); assert.equal((await stat(target)).mtimeMs, metadata.mtimeMs);
    });
    await t.test('invalid UTF-8, binary and large files give metadata but keep text preview rejected', async () => {
      for (const [name, bytes, errorCode] of [['legacy.txt', Buffer.from([0xff, 0x80]), 'FILE_ENCODING'], ['binary.bin', Buffer.from([1, 0, 255]), 'BINARY_FILE'], ['large.txt', null, 'FILE_LIMIT']]) {
        const target = path.join(projectPath, name); await writeFile(target, bytes ?? ''); if (!bytes) await truncate(target, 64 * 1024 * 1024);
        const before = await stat(target), info = await api(route + query(name));
        assert.equal(info.status, 200); assert.equal(info.body.size, before.size); assert.deepEqual(Object.keys(info.body).sort(), ['modifiedAt', 'name', 'path', 'size']);
        const preview = await api(`projects/${project.id}/file` + query(name)); assert.equal(preview.status, 400); assert.equal(preview.body.code, errorCode);
        assert.equal((await stat(target)).mtimeMs, before.mtimeMs); if (bytes) assert.deepEqual(await readFile(target), bytes);
      }
    });
    await t.test('directories, a real FIFO, project traversal and external aliases are rejected', async () => {
      await mkdir(path.join(projectPath, 'directory')); await execute('mkfifo', [path.join(projectPath, 'fifo')]); await writeFile(path.join(root, 'outside.txt'), 'private'); await symlink(path.join(root, 'outside.txt'), path.join(projectPath, 'alias.txt'));
      for (const name of ['directory', 'fifo']) assert.equal((await api(route + query(name))).body.code, 'FILE_LIMIT');
      for (const name of ['../outside.txt', 'alias.txt']) assert.equal((await api(route + query(name))).body.code, 'OUTSIDE_PROJECT');
    });
    await t.test('method, route length and duplicate or absent path parameters are strictly rejected', async () => {
      for (const [target, body] of [[route, { path: '中文 文件.txt' }], [route, undefined], [route + '/extra' + query('中文 文件.txt'), undefined], [route + query('中文 文件.txt') + '&path=other', undefined]]) {
        const result = await api(target, body); assert.equal(result.status, 400); assert.equal(result.body.code, 'INVALID_REQUEST');
      }
      assert.equal((await api(route + query('contains\0null'))).body.code, 'INVALID_PATH');
      assert.equal((await api('projects/not-a-project/file-info' + query('file.txt'))).status, 404);
    });
    await t.test('feature-files disable removes the new route and enable restores it without starting a model', async () => {
      assert.equal((await api('plugins/feature-files/disable', {})).status, 200);
      assert.equal((await api(route + query('中文 文件.txt'))).status, 404);
      assert.equal((await api('plugins/feature-files/enable', {})).status, 200);
      assert.equal((await api(route + query('中文 文件.txt'))).status, 200); assert.equal(host.engine, undefined);
    });
  } finally { await host?.close(); await rm(root, { recursive: true, force: true }); }
});
