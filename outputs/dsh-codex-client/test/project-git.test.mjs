import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, chmod, stat } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import { PluginHost } from '../server/plugin-host.mjs';
import { ProjectGit } from '../server/project-git.mjs';

const execute = promisify(execFile);
const git = (root, ...args) => execute('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], { cwd: root, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
async function repository({ commit = true } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-git-review-'));
  await git(root, 'init', '-q', '--initial-branch=main');
  await git(root, 'config', 'user.name', 'Fixture'); await git(root, 'config', 'user.email', 'fixture@example.invalid');
  if (commit) {
    for (const name of ['tracked.txt', 'rename old.txt', 'deleted.txt', '[literal].txt']) await writeFile(path.join(root, name), 'base\n');
    await git(root, 'add', '--', '.'); await git(root, 'commit', '-qm', 'baseline');
  }
  return root;
}
async function modifiedRepository() {
  const root = await repository();
  await git(root, 'branch', 'other');
  await writeFile(path.join(root, 'tracked.txt'), 'staged\n'); await git(root, 'add', '--', 'tracked.txt');
  await writeFile(path.join(root, 'tracked.txt'), 'working\n');
  await git(root, 'mv', '--', 'rename old.txt', 'rename new.txt'); await rm(path.join(root, 'deleted.txt'));
  for (const name of ['space name.txt', 'line\nbreak.txt', '-leading-dash.txt', '   ', '中文.txt']) await writeFile(path.join(root, name), 'new content\n');
  return root;
}
async function waitMarker(file) {
  for (let n = 0; n < 100; n++) { try { const pid=Number(await readFile(file, 'utf8')); if(Number.isSafeInteger(pid)&&pid>0)return pid; } catch (error) { if (error.code !== 'ENOENT') throw error; } await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('CHILD_NOT_READY');
}
async function fakeGit(root, body) {
  const directory = path.join(root, 'fake-bin'); await mkdir(directory);
  const file = path.join(directory, 'git'); await writeFile(file, `#!${process.execPath}\n${body}\n`); await chmod(file, 0o700); return file;
}

test('real porcelain -z status preserves unusual paths, staged/worktree states, rename and deletion', async () => {
  const root = await modifiedRepository(), reader = new ProjectGit();
  try {
    const before = { bytes: await readFile(path.join(root, '.git/index')), info: await stat(path.join(root, '.git/index')) };
    const state = await reader.status(root);
    assert.equal(state.branch, 'main'); assert.equal(state.detached, false); assert.equal(state.unborn, false);
    assert.deepEqual(state.branches, [{ name: 'main', current: true }, { name: 'other', current: false }]);
    const tracked = state.files.find(item => item.path === 'tracked.txt');
    assert.equal(tracked.index, 'M'); assert.equal(tracked.workingTree, 'M'); assert.equal(tracked.staged, true); assert.equal(tracked.unstaged, true);
    const renamed = state.files.find(item => item.path === 'rename new.txt');
    assert.equal(renamed.originalPath, 'rename old.txt'); assert.equal(renamed.renamed, true); assert.equal(renamed.staged, true);
    assert.equal(state.files.find(item => item.path === 'deleted.txt').deleted, true);
    for (const name of ['space name.txt', 'line\nbreak.txt', '-leading-dash.txt', '   ', '中文.txt']) assert.equal(state.files.find(item => item.path === name).untracked, true, name);
    assert.deepEqual(await readFile(path.join(root, '.git/index')), before.bytes);
    assert.equal((await stat(path.join(root, '.git/index'))).mtimeMs, before.info.mtimeMs);
  } finally { await reader.close(); await rm(root, { recursive: true, force: true }); }
});

test('real diff separates staged, unstaged and untracked changes and retains rename/deletion content', async () => {
  const root = await modifiedRepository(), reader = new ProjectGit();
  try {
    const staged = await reader.diff(root, { path: 'tracked.txt', staged: true });
    assert.match(staged.diff, /\+staged/); assert.doesNotMatch(staged.diff, /\+working/);
    const working = await reader.diff(root, { path: 'tracked.txt' }); assert.match(working.diff, /-staged\n\+working/);
    for (const relative of ['space name.txt', 'line\nbreak.txt', '-leading-dash.txt', '   ']) {
      const added = await reader.diff(root, { path: relative }); assert.equal(added.kind, 'untracked'); assert.match(added.diff, /\+new content/);
    }
    assert.equal((await reader.diff(root, { path: 'space name.txt', staged: true })).diff, '');
    const renamed = await reader.diff(root, { path: 'rename new.txt', staged: true });
    assert.equal(renamed.originalPath, 'rename old.txt'); assert.match(renamed.diff, /rename from rename old.txt/); assert.match(renamed.diff, /rename to rename new.txt/);
    assert.match((await reader.diff(root, { path: 'deleted.txt' })).diff, /deleted file mode/);
    await writeFile(path.join(root, '[literal].txt'), 'literal changed\n');
    assert.match((await reader.diff(root, { path: '[literal].txt' })).diff, /literal changed/);
    assert.equal(reader.children.size, 0);
  } finally { await reader.close(); await rm(root, { recursive: true, force: true }); }
});

test('repository and path checks refuse parent repositories, traversal, metadata and escaped symlinks', async () => {
  const root = await repository(), outside = await mkdtemp(path.join(tmpdir(), 'dsh-git-outside-')), reader = new ProjectGit();
  try {
    await mkdir(path.join(root, 'nested')); await writeFile(path.join(outside, 'private'), 'outside data'); await symlink(outside, path.join(root, 'escape'));
    await assert.rejects(reader.status(outside), { code: 'GIT_NOT_REPOSITORY' });
    await assert.rejects(reader.status(path.join(root, 'nested')), { code: 'GIT_PROJECT_ROOT_REQUIRED' });
    for (const relative of ['', null, '../private', '/etc/passwd', '.git/config', 'nested/../tracked.txt', 'tracked.txt\0x', '\ud800']) await assert.rejects(reader.diff(root, { path: relative }), { code: 'GIT_INVALID_PATH' });
    await assert.rejects(reader.diff(root, { path: 'escape/private' }), { code: 'GIT_OUTSIDE_PROJECT' });
    await symlink(path.join(outside, 'private'), path.join(root, 'external-untracked'));
    await assert.rejects(reader.diff(root, { path: 'external-untracked' }), { code: 'GIT_OUTSIDE_PROJECT' });
    await assert.rejects(reader.diff(root, { path: 'nested' }), { code: 'GIT_INVALID_PATH' });
    await assert.rejects(reader.diff(root, { path: 'does-not-exist' }), { code: 'GIT_INVALID_PATH' });
  } finally { await reader.close(); await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test('binary content, invalid UTF-8 paths and oversized differences have explicit bounded errors', async () => {
  const root = await repository(), reader = new ProjectGit(), small = new ProjectGit({ maxOutputBytes: 1024 });
  try {
    await writeFile(path.join(root, 'binary.bin'), Buffer.from([0, 1, 2, 3]));
    await assert.rejects(reader.diff(root, { path: 'binary.bin' }), { code: 'GIT_BINARY' });
    await writeFile(path.join(root, 'encoding.txt'), Buffer.from([0xff, 10]));
    await assert.rejects(reader.diff(root, { path: 'encoding.txt' }), { code: 'GIT_BINARY' });
    await writeFile(path.join(root, 'tracked.txt'), 'long change '.repeat(1000));
    await assert.rejects(small.diff(root, { path: 'tracked.txt' }), { code: 'GIT_OUTPUT_LIMIT' });
    // APFS rejects invalid UTF-8 filenames, but an imported Git index can still
    // contain one. Exercise the real Git porcelain output from such an index.
    const object = (await git(root, 'rev-parse', 'HEAD:tracked.txt')).stdout.trim();
    const update = spawn('git', ['-c', 'core.fsmonitor=false', 'update-index', '-z', '--index-info'], { cwd: root, stdio: ['pipe', 'ignore', 'pipe'] });
    const updated = new Promise((resolve, reject) => { update.once('error', reject); update.once('close', code => code === 0 ? resolve() : reject(new Error('INDEX_FIXTURE_FAILED'))); });
    update.stdin.end(Buffer.concat([Buffer.from(`100644 ${object}\tbad-`), Buffer.from([0xff, 0])])); await updated;
    await assert.rejects(reader.status(root), { code: 'GIT_PATH_ENCODING' });
    assert.equal(reader.children.size, 0); assert.equal(small.children.size, 0);
  } finally { await reader.close(); await small.close(); await rm(root, { recursive: true, force: true }); }
});

test('repository configured fsmonitor, hooks and text conversion never execute during review', async () => {
  const root = await repository(), reader = new ProjectGit();
  try {
    const marker = path.join(root, 'must-not-exist'), script = path.join(root, 'external-helper');
    await writeFile(script, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'executed');\n`); await chmod(script, 0o700);
    await git(root, 'config', 'core.fsmonitor', script); await git(root, 'config', 'diff.evil.textconv', script); await git(root, 'config', 'diff.external', script);
    await writeFile(path.join(root, '.gitattributes'), 'tracked.txt diff=evil\n'); await writeFile(path.join(root, 'tracked.txt'), 'updated\n');
    await reader.status(root); assert.match((await reader.diff(root, { path: 'tracked.txt' })).diff, /updated/);
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
  } finally { await reader.close(); await rm(root, { recursive: true, force: true }); }
});

test('clean and process filter sentinels execute in raw Git but stay disabled in read-only review', async () => {
  const root = await repository(), reader = new ProjectGit();
  try {
    await writeFile(path.join(root, '.gitattributes'), 'tracked.txt filter=evil\n');
    await writeFile(path.join(root, 'tracked.txt'), 'changed raw contents\n');
    for (const driver of ['clean', 'process']) {
      const marker = path.join(root, 'ran-' + driver), helper = path.join(root, 'filter-' + driver);
      await writeFile(helper, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'executed');${driver === 'clean' ? 'process.stdin.pipe(process.stdout);' : ''}\n`); await chmod(helper, 0o700);
      await git(root, 'config', 'filter.evil.' + driver, "'" + helper.replaceAll("'", "'\\''") + "'");
      await git(root, 'diff', '--no-ext-diff', '--no-textconv', '--', 'tracked.txt').catch(() => {});
      assert.equal(await readFile(marker, 'utf8'), 'executed', driver + ' control must actually exercise its helper');
      await rm(marker);
      const before = await readFile(path.join(root, '.git/config'));
      await reader.status(root); assert.match((await reader.diff(root, { path: 'tracked.txt' })).diff, /changed raw contents/);
      await assert.rejects(readFile(marker), { code: 'ENOENT' });
      assert.deepEqual(await readFile(path.join(root, '.git/config')), before);
      await git(root, 'config', '--unset', 'filter.evil.' + driver);
    }
    const unsafeMarker = path.join(root, 'unsafe-filter-ran'), helper = path.join(root, 'unsafe-filter');
    await writeFile(helper, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(unsafeMarker)},'executed');process.stdin.pipe(process.stdout);\n`); await chmod(helper, 0o700);
    await git(root, 'config', 'filter.evil=name.clean', helper);
    await writeFile(path.join(root, '.gitattributes'), 'tracked.txt filter=evil=name\n');
    await assert.rejects(reader.status(root), { code: 'GIT_FILTER_UNSUPPORTED' });
    await assert.rejects(reader.diff(root, { path: 'tracked.txt' }), { code: 'GIT_FILTER_UNSUPPORTED' });
    await assert.rejects(readFile(unsafeMarker), { code: 'ENOENT' });
  } finally { await reader.close(); await rm(root, { recursive: true, force: true }); }
});

test('unborn and detached branches and real conflicted porcelain entries remain readable', async () => {
  const unborn = await repository({ commit: false }), root = await repository(), reader = new ProjectGit();
  try {
    const fresh = await reader.status(unborn); assert.equal(fresh.unborn, true); assert.equal(fresh.branch, 'main'); assert.deepEqual(fresh.branches, []);
    await writeFile(path.join(unborn, 'first'), 'first\n'); await git(unborn, 'add', '--', 'first'); assert.match((await reader.diff(unborn, { path: 'first', staged: true })).diff, /\+first/);
    await git(root, 'checkout', '-qb', 'side'); await writeFile(path.join(root, 'tracked.txt'), 'side\n'); await git(root, 'commit', '-qam', 'side');
    await git(root, 'checkout', '-q', 'main'); await writeFile(path.join(root, 'tracked.txt'), 'main\n'); await git(root, 'commit', '-qam', 'main');
    await assert.rejects(git(root, 'merge', '--no-edit', 'side'));
    assert.equal((await reader.status(root)).files.find(item => item.path === 'tracked.txt').conflicted, true);
    await git(root, 'merge', '--abort'); await git(root, 'checkout', '-q', '--detach'); assert.equal((await reader.status(root)).detached, true);
  } finally { await reader.close(); await rm(root, { recursive: true, force: true }); await rm(unborn, { recursive: true, force: true }); }
});

test('missing Git, deadline and explicit cancellation leave no running owned process', async () => {
  const root = await repository(), missing = new ProjectGit({ gitBinary: path.join(root, 'missing-git') });
  try {
    await assert.rejects(missing.status(root), { code: 'GIT_NOT_INSTALLED' }); assert.equal(missing.children.size, 0);
    const marker = path.join(root, 'pid'), binary = await fakeGit(root, `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000);`);
    for (const mode of ['deadline', 'abort', 'close']) {
      await rm(marker, { force: true });
      const reader = new ProjectGit({ gitBinary: binary, timeoutMs: mode === 'deadline' ? 800 : 30000, killGraceMs: 30 }), controller = new AbortController();
      const result = reader.status(root, { signal: controller.signal }).then(() => null, error => error);
      const pid = await waitMarker(marker); if (mode === 'abort') controller.abort();
      if (mode === 'close') { const closing = reader.close(); assert.equal(reader.close(), closing); await closing; await assert.rejects(reader.status(root), { code: 'GIT_ABORTED' }); }
      assert.equal((await result).code, mode === 'deadline' ? 'GIT_TIMEOUT' : 'GIT_ABORTED');
      assert.equal(reader.children.size, 0); assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }); await reader.close();
    }
  } finally { await missing.close(); await rm(root, { recursive: true, force: true }); }
});

test('real Cordis plugin disable aborts in-flight reads, unregisters routes and can re-enable', async () => {
  const root = await repository(), context = new Context(); let host;
  const originalPath = process.env.PATH;
  try {
    host = new PluginHost({ context, dataDir: path.join(root, 'owned'), builtins: [fileURLToPath(new URL('../server/plugins/feature-git.mjs', import.meta.url))], services: { getProject: id => { assert.equal(id, 'owned'); return { path: root }; } } });
    await host.start();
    const environment = () => ({ segments: ['projects', 'owned', 'git', 'status'], request: Object.assign(new EventEmitter(), { method: 'GET' }), response: Object.assign(new EventEmitter(), { writableFinished: false }), url: new URL('http://127.0.0.1/api/projects/owned/git/status'), json: value => value });
    assert.equal(await host.dispatch(environment()), true);
    const marker = path.join(root, 'plugin-pid'), binary = await fakeGit(root, `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000);`);
    process.env.PATH = path.dirname(binary) + path.delimiter + originalPath;
    const disconnected = environment();
    const cancelled = host.dispatch(disconnected).then(() => null, error => error); const cancelledPid = await waitMarker(marker);
    disconnected.response.emit('close');
    assert.equal((await cancelled).code, 'GIT_ABORTED'); assert.throws(() => process.kill(cancelledPid, 0), { code: 'ESRCH' });
    assert.equal(disconnected.request.listenerCount('aborted'), 0); assert.equal(disconnected.response.listenerCount('close'), 0);
    await rm(marker);
    const pending = host.dispatch(environment()).then(() => null, error => error); const pid = await waitMarker(marker);
    await host.disable('feature-git');
    assert.equal((await pending).code, 'GIT_ABORTED'); assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    assert.equal(await host.dispatch(environment()), false);
    process.env.PATH = originalPath;
    await host.enable('feature-git'); assert.equal(await host.dispatch(environment()), true);
    for (const query of ['path=tracked.txt&staged=2', 'path=tracked.txt&path=deleted.txt', 'staged=0']) {
      const request = environment(); request.segments[3] = 'diff'; request.url = new URL('http://127.0.0.1/diff?' + query);
      await assert.rejects(host.dispatch(request), error => error.message === 'GIT_INVALID_PATH');
    }
  } finally { process.env.PATH = originalPath; await host?.close(); await context.fiber.dispose(); await rm(root, { recursive: true, force: true }); }
});
