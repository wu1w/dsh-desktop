import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, symlink, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileErrors } from '../shared/file-errors.js';

const appRoot = process.env.DSH_ACCEPTANCE_APP_ROOT;
const { startHost } = await import(appRoot ? pathToFileURL(path.join(appRoot, 'server/index.mjs')) : new URL('../server/index.mjs', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('file HTTP API rejects lossy text and preserves byte versions, formats and concurrency', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-files-encoding-api-'));
  let host;
  try {
    const projectPath = path.join(root, 'project'); await mkdir(projectPath);
    host = await startHost({ dataDir: path.join(root, 'data'), autoStart: false });
    const response = await fetch(host.url + '/api/bootstrap'), boot = await response.json();
    const headers = { cookie: response.headers.get('set-cookie').split(';')[0], 'x-dsh-capability': boot.capability, 'content-type': 'application/json', 'accept-language': 'en' };
    const api = async (route, body, language = 'en') => {
      const response = await fetch(host.url + '/api/' + route, { headers: { ...headers, 'accept-language': language }, method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
    const project = (await api('projects', { path: projectPath })).body;
    const route = `projects/${project.id}/file`, read = (name, language) => api(route + '?path=' + encodeURIComponent(name), undefined, language);

    await t.test('malformed UTF-8 and NUL reads give actionable localized errors without changing bytes', async () => {
      const bad = Buffer.from([0x66, 0x80, 0xe4, 0xb8]), target = path.join(projectPath, 'legacy.txt');
      await writeFile(target, bad); const before = await stat(target);
      for (const [language, index] of [['en', 1], ['zh-CN', 0]]) {
        const failure = await read('legacy.txt', language);
        assert.equal(failure.status, 400); assert.equal(failure.body.code, 'FILE_ENCODING');
        assert.equal(failure.body.message, fileErrors.FILE_ENCODING[index]);
      }
      const overwrite = await api(route, { path: 'legacy.txt', content: 'lossy replacement', version: hash(bad) });
      assert.equal(overwrite.body.code, 'FILE_ENCODING');
      assert.deepEqual(await readFile(target), bad); assert.equal((await stat(target)).mtimeMs, before.mtimeMs);
      await writeFile(path.join(projectPath, 'binary.txt'), Buffer.from([0x61, 0, 0x62]));
      assert.equal((await read('binary.txt')).body.code, 'BINARY_FILE');
    });

    await t.test('JSON surrogate and NUL writes are rejected before any temporary file appears', async () => {
      const target = path.join(projectPath, 'safe.txt'); await writeFile(target, '原文😀');
      const base = (await read('safe.txt')).body;
      for (const content of ['before\0after', '\ud800', '\udfff', 'x\ud800y']) {
        const result = await api(route, { path: 'safe.txt', content, version: base.version });
        assert.equal(result.status, 400); assert.equal(result.body.code, 'FILE_INVALID_TEXT');
        assert.equal(result.body.message, fileErrors.FILE_INVALID_TEXT[1]);
        assert.equal(await readFile(target, 'utf8'), '原文😀');
        assert.deepEqual((await readdir(projectPath)).filter(name => name.endsWith('.tmp')), []);
      }
    });

    await t.test('BOM, CRLF, Chinese and valid Unicode preserve raw SHA and exact read-save bytes', async () => {
      const content = '\ufeff中文😀\r\n第二行 � e\u0301\r\n', bytes = Buffer.from(content), target = path.join(projectPath, '文档.txt');
      await writeFile(target, bytes, { mode: 0o600 });
      const base = await read('文档.txt'); assert.equal(base.status, 200);
      assert.equal(base.body.content, content); assert.equal(base.body.version, hash(bytes));
      assert.equal((await api(route, { path: '文档.txt', content: base.body.content, version: base.body.version })).status, 200);
      assert.deepEqual(await readFile(target), bytes); assert.equal((await stat(target)).mode & 0o777, 0o600);
      const changed = content.replace('第二行', '修改后的第二行');
      assert.equal((await api(route, { path: '文档.txt', content: changed, version: base.body.version })).status, 200);
      assert.deepEqual(await readFile(target), Buffer.from(changed));
      assert.equal((await read('文档.txt')).body.version, hash(Buffer.from(changed)));
    });

    await t.test('canonical concurrent HTTP writes accept one expected byte version and leave no debris', async () => {
      const target = path.join(projectPath, 'concurrent.txt'); await writeFile(target, '\ufeff基础\r\n');
      await symlink(target, path.join(projectPath, 'alias.txt'));
      const base = (await read('concurrent.txt')).body, choices = ['\ufeff甲😀\r\n', '\ufeff乙😀\r\n'];
      const results = await Promise.all(choices.map((content, index) => api(route, { path: index ? 'alias.txt' : 'concurrent.txt', content, version: base.version })));
      assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
      assert.equal(results.find(result => result.status === 409).body.code, 'FILE_CHANGED');
      const winner = results.findIndex(result => result.status === 200), fresh = (await read('concurrent.txt')).body;
      assert.deepEqual(await readFile(target), Buffer.from(choices[winner]));
      assert.equal((await api(route, { path: 'alias.txt', content: '新一轮保存😀', version: fresh.version })).status, 200);
      assert.equal(await readFile(target, 'utf8'), '新一轮保存😀');
      assert.deepEqual((await readdir(projectPath)).filter(name => name.endsWith('.tmp')), []);
    });
  } finally { await host?.close(); await rm(root, { recursive: true, force: true }); }
});
