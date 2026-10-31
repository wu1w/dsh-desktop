import test from 'node:test';
import assert from 'node:assert/strict';
import promises, { mkdtemp, realpath, mkdir, writeFile, readFile, readdir, stat, chmod, rm } from 'node:fs/promises';
import childProcess, { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';

const appRoot = process.env.DSH_ACCEPTANCE_APP_ROOT;
const location = relative => appRoot ? pathToFileURL(path.join(appRoot, relative)) : new URL('../' + relative, import.meta.url);
const { ProjectGit } = await import(location('server/project-git.mjs'));
const { GitDraftStore } = await import(location('server/git-drafts.mjs'));
const { PluginHost } = await import(location('server/plugin-host.mjs'));
const execute = promisify(execFile), sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const fault = code => Object.assign(new Error(code), { code });
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
async function until(check) { const end = Date.now() + 3000; while (!await check()) { if (Date.now() > end) throw Error('GIT_STOP_FIXTURE_TIMEOUT'); await sleep(5); } }
const git = (root, ...args) => execute('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], { cwd: root, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
async function temporary(action) { const root = await realpath(await mkdtemp(path.join(tmpdir(), 'dsh-git-stop-'))); try { await action(root); } finally { await rm(root, { recursive: true, force: true }); } }
async function repository(root) { const directory = path.join(root, 'repo'); await mkdir(directory); await git(directory, 'init', '-q', '--initial-branch=main'); await git(directory, 'config', 'user.name', 'Fixture'); await git(directory, 'config', 'user.email', 'fixture@example.invalid'); await writeFile(path.join(directory, 'tracked'), 'original\n'); await git(directory, 'add', 'tracked'); await git(directory, 'commit', '-qm', 'base'); return directory; }
const draft = (baseVersion = null, message = 'saved input') => ({ projectId: 'project', message, authorName: 'Draft Author', authorEmail: 'unfinished@', baseVersion });
async function noGitLocks(root) { assert.ok(!(await readdir(path.join(root, '.git'))).some(name => name === 'HEAD.lock' || name === 'index.lock' || name.startsWith('dsh-index-'))); assert.ok(!(await readdir(path.join(root, '.git/refs/heads'))).some(name => name.endsWith('.lock'))); }

test('reader close waits for a real TERM-ignoring owned Git process to die', async () => temporary(async root => {
  const marker = path.join(root, 'pid'), binary = path.join(root, 'fake-git');
  await writeFile(binary, `#!${process.execPath}\nprocess.on('SIGTERM',()=>{});const fs=require('node:fs'),marker=${JSON.stringify(marker)};fs.writeFileSync(marker+'.tmp',String(process.pid));fs.renameSync(marker+'.tmp',marker);setInterval(()=>{},1000);\n`); await chmod(binary, 0o700);
  const reader = new ProjectGit({ gitBinary: binary, killGraceMs: 25, closeTimeoutMs: 1000 });
  try {
    const pending = reader.status(root).then(() => null, error => error); let pid;
    // Existence alone can observe an empty file, whose Number is 0 (our own
    // process group). Publish atomically and only probe the owned child PID.
    await until(async()=>{const value=await readFile(marker,'utf8').catch(()=>'');if(!/^[1-9]\d*$/.test(value))return false;const candidate=Number(value);if(!Number.isSafeInteger(candidate)||candidate<=1)return false;pid=candidate;return true;});
    assert.equal([...reader.children][0]?.pid,pid); assert.equal(alive(pid), true); assert.equal(reader.activities().length, 1); const id = reader.activities()[0].id;
    await reader.close(); assert.equal((await pending).code, 'GIT_ABORTED'); assert.equal(alive(pid), false,`owned Git leader ${pid} remained alive after close`); assert.equal(reader.children.size, 0); assert.equal(reader.operations.size, 0); assert.deepEqual(reader.activities(), []); assert.ok(id.startsWith('git-'));
  } finally { await reader.close(); }
}));

test('closing an actual prepared commit aborts native HEAD/ref/index locks before returning', async () => temporary(async root => {
  const repo = await repository(root), reader = new ProjectGit(), gate = deferred(), prepared = deferred();
  try {
    await writeFile(path.join(repo, 'tracked'), 'staged\n'); await git(repo, 'add', 'tracked'); const beforeHead = (await git(repo, 'rev-parse', 'HEAD')).stdout, beforeIndex = await readFile(path.join(repo, '.git/index')), state = await reader.status(repo);
    const run = reader._run.bind(reader); reader._run = (...args) => { if (args[4]?.afterPrepare) { const original = args[4].afterPrepare; args[4] = { ...args[4], afterPrepare: async () => { prepared.resolve(); await gate.promise; return original(); } }; } return run(...args); };
    const committing = reader.commit(repo, { message: 'must not be published', revision: state.revision }).then(() => null, error => error); await prepared.promise;
    const pids = [...reader.children].map(child => child.pid); assert.ok(pids.length); await reader.close();
    assert.ok(['GIT_WRITE_UNKNOWN', 'GIT_ABORTED'].includes((await committing).code)); assert.ok(pids.every(pid => !alive(pid)));
    assert.equal((await git(repo, 'rev-parse', 'HEAD')).stdout, beforeHead); assert.deepEqual(await readFile(path.join(repo, '.git/index')), beforeIndex); await noGitLocks(repo); assert.deepEqual(reader.activities(), []);
  } finally { gate.resolve(); await reader.close(); }
}));

test('failed owned index cleanup rejects close, keeps one activity and retries cleanup without replaying stage', async t => temporary(async root => {
  const repo = await repository(root), reader = new ProjectGit(); const originalUnlink = promises.unlink; let intercept, failing = true;
  try {
    await writeFile(path.join(repo, 'tracked'), 'changed\n'); const state = await reader.status(repo), before = await readFile(path.join(repo, '.git/index'));
    const run = reader._run.bind(reader); reader._run = (...args) => args[1][0] === 'update-index' ? Promise.reject(fault('GIT_ABORTED')) : run(...args);
    intercept = t.mock.method(promises, 'unlink', (file, ...args) => failing && file === path.join(repo, '.git/index.lock') ? Promise.reject(Object.assign(new Error('PRIVATE_FS_ERROR'), { code: 'EACCES' })) : originalUnlink(file, ...args)); syncBuiltinESMExports();
    await assert.rejects(reader.stage(repo, { path: 'tracked', revision: state.revision }), { code: 'GIT_CLEANUP_FAILED' }); assert.equal(reader.cleanupTasks.size, 1); const activity = reader.activities(); assert.equal(activity.length, 1);
    await assert.rejects(reader.close(), { code: 'GIT_CLEANUP_FAILED' }); assert.deepEqual(reader.activities(), activity); assert.deepEqual(await readFile(path.join(repo, '.git/index')), before);
    failing = false; await reader.close(); await noGitLocks(repo); assert.equal(reader.cleanupTasks.size, 0); assert.deepEqual(reader.activities(), []); assert.deepEqual(await readFile(path.join(repo, '.git/index')), before);
  } finally { failing = false; intercept?.mock.restore(); syncBuiltinESMExports(); await reader.close(); }
}));

test('a missing exit event cannot hang close or erase its operation; late close permits retry', async t => temporary(async root => {
  let fake; const originalSpawn = childProcess.spawn;
  const intercept = t.mock.method(childProcess, 'spawn', () => { fake = new EventEmitter(); fake.stdout = new EventEmitter(); fake.stderr = new EventEmitter(); return fake; }); syncBuiltinESMExports();
  const reader = new ProjectGit({ closeTimeoutMs: 25 });
  try {
    const pending = reader.status(root).then(() => null, error => error); await until(() => Boolean(fake)); const id = reader.activities()[0].id;
    await assert.rejects(reader.close(), { code: 'GIT_CLEANUP_FAILED' }); assert.equal(reader.activities()[0].id, id); assert.equal(reader.operations.size, 1);
    fake.emit('close', null); assert.equal((await pending).code, 'GIT_ABORTED'); await reader.close(); assert.deepEqual(reader.activities(), []);
  } finally { fake?.emit('close', null); intercept.mock.restore(); syncBuiltinESMExports(); assert.equal(childProcess.spawn, originalSpawn); await reader.close(); }
}));

test('draft close joins admitted fsync/rename and reports an in-flight storage failure until explicit successful retry', async t => temporary(async root => {
  const store = new GitDraftStore({ dataDir: root }), gate = deferred(), entered = deferred(), originalRename = promises.rename; let intercept, failing = true;
  try {
    const first = await store.save(draft()), original = store._persist.bind(store); store._persist = async (...args) => { entered.resolve(); await gate.promise; return original(...args); };
    intercept = t.mock.method(promises, 'rename', (...args) => failing && args[1] === path.join(root, 'git-drafts.json') ? Promise.reject(Object.assign(new Error('PRIVATE_DISK_FULL'), { code: 'ENOSPC' })) : originalRename(...args)); syncBuiltinESMExports();
    const pending = store.save(draft(first.version, 'must retry')).then(() => null, error => error); await entered.promise;
    const stopping = store.close(), rejected = assert.rejects(stopping, { code: 'GIT_DRAFT_WRITE_FAILED' }); assert.equal(store.activities().length, 1); gate.resolve(); await rejected;
    assert.equal((await pending).code, 'GIT_DRAFT_WRITE_FAILED'); assert.equal(store.closed, false); assert.equal(store.activities()[0].kind, 'unknown');
    await assert.rejects(store.close(), { code: 'GIT_DRAFT_WRITE_FAILED' }); assert.equal((await store.get('project')).message, first.message);
    failing = false; const saved = await store.save(draft(first.version, 'explicit retry saved')); await store.close();
    const reopened = new GitDraftStore({ dataDir: root }); assert.deepEqual(await reopened.get('project'), saved); await reopened.close(); assert.deepEqual(store.activities(), []); assert.equal((await stat(path.join(root, 'git-drafts.json'))).mode & 0o777, 0o600); assert.ok(!(await readdir(root)).some(name => name.endsWith('.tmp') || name === '.git-drafts.lock'));
  } finally { gate.resolve(); failing = false; intercept?.mock.restore(); syncBuiltinESMExports(); if (store.stopFailures.size) { const row = await store.get('project'); await store.save(draft(row?.version ?? null, 'cleanup retry')); } await store.close(); }
}));

test('known validation/CAS/read errors do not become a permanent exit blocker and a slow draft close has a deadline', async () => temporary(async root => {
  const store = new GitDraftStore({ dataDir: root, closeTimeoutMs: 25 });
  const first = await store.save(draft()); await assert.rejects(store.save({ ...draft(), message: '\0' }), { code: 'GIT_DRAFT_INVALID' }); await assert.rejects(store.save(draft(null)), { code: 'GIT_DRAFT_CHANGED' });
  const gate = deferred(), entered = deferred(), original = store._persist.bind(store); store._persist = async (...args) => { entered.resolve(); await gate.promise; return original(...args); };
  const pending = store.save(draft(first.version, 'slow but eventually durable')); await entered.promise;
  await assert.rejects(store.close(), { code: 'GIT_DRAFT_WRITE_FAILED' }); assert.ok(store.activities().length); gate.resolve(); await pending; await store.close(); assert.deepEqual(store.activities(), []);
  const broken = new GitDraftStore({ dataDir: path.join(root, 'broken') }); await mkdir(path.join(root, 'broken')); await writeFile(path.join(root, 'broken/git-drafts.json'), 'corrupt'); await assert.rejects(broken.get('project'), { code: 'GIT_DRAFT_CORRUPT' }); await broken.close();
}));

test('draft temporary cleanup failures retain owned resources until a cleanup-only retry succeeds', async t => temporary(async root => {
  const store = new GitDraftStore({ dataDir: root }), originalRename = promises.rename, originalUnlink = promises.unlink; let renameMock, unlinkMock, failing = true;
  try {
    const first = await store.save(draft()), before = await readFile(path.join(root, 'git-drafts.json'));
    renameMock = t.mock.method(promises, 'rename', (...args) => failing && args[1] === path.join(root, 'git-drafts.json') ? Promise.reject(Object.assign(new Error('PRIVATE_RENAME'), { code: 'EIO' })) : originalRename(...args));
    unlinkMock = t.mock.method(promises, 'unlink', (file, ...args) => failing && String(file).startsWith(path.join(root, '.git-drafts-')) ? Promise.reject(Object.assign(new Error('PRIVATE_UNLINK'), { code: 'EACCES' })) : originalUnlink(file, ...args)); syncBuiltinESMExports();
    await assert.rejects(store.save(draft(first.version, 'not published')), { code: 'GIT_DRAFT_WRITE_FAILED' }); assert.equal(store.stopFailures.size, 0); assert.equal(store.cleanupTasks.size, 1);
    await assert.rejects(store.close(), { code: 'GIT_DRAFT_WRITE_FAILED' }); assert.equal(store.activities().length, 1); assert.deepEqual(await readFile(path.join(root, 'git-drafts.json')), before);
    failing = false; await store.close(); assert.equal(store.cleanupTasks.size, 0); assert.deepEqual(store.activities(), []); assert.deepEqual(await readFile(path.join(root, 'git-drafts.json')), before); assert.ok(!(await readdir(root)).some(name => name.endsWith('.tmp') || name === '.git-drafts.lock'));
  } finally { failing = false; renameMock?.mock.restore(); unlinkMock?.mock.restore(); syncBuiltinESMExports(); await store.close(); }
}));

test('failed removal of an owned draft lock is visible and an explicit save can retry cleanup before taking a new lock', async t => temporary(async root => {
  const store = new GitDraftStore({ dataDir: root }), originalRmdir = fs.rmdir, originalPromiseRmdir = promises.rmdir, lock = path.join(root, '.git-drafts.lock'); let callbackMock, promiseMock, failing = true;
  try {
    const first = await store.save(draft());
    callbackMock = t.mock.method(fs, 'rmdir', (target, ...args) => { if (failing && target === lock) { const callback = args.at(-1); process.nextTick(() => callback(Object.assign(new Error('PRIVATE_LOCK'), { code: 'EACCES' }))); return; } return originalRmdir(target, ...args); });
    promiseMock = t.mock.method(promises, 'rmdir', (target, ...args) => failing && target === lock ? Promise.reject(Object.assign(new Error('PRIVATE_LOCK'), { code: 'EACCES' })) : originalPromiseRmdir(target, ...args)); syncBuiltinESMExports();
    await assert.rejects(store.save(draft(first.version, 'published before lock cleanup failed')), { code: 'GIT_DRAFT_WRITE_FAILED' }); assert.equal(store.cleanupTasks.size, 1); await assert.rejects(store.close(), { code: 'GIT_DRAFT_WRITE_FAILED' }); assert.equal(store.activities().length, 1);
    const current = await store.get('project'); assert.equal(current.message, 'published before lock cleanup failed');
    failing = false; await store.save(draft(current.version, 'user reviewed and retried')); await store.close(); assert.deepEqual(store.activities(), []); assert.equal(store.cleanupTasks.size, 0); assert.ok(!(await readdir(root)).includes('.git-drafts.lock'));
  } finally { failing = false; callbackMock?.mock.restore(); promiseMock?.mock.restore(); syncBuiltinESMExports(); await store.close(); }
}));

async function plugin(root, projectPath = root) {
  const context = new Context(), dataDir = path.join(root, 'data'), host = new PluginHost({ context, dataDir, builtins: [fileURLToPath(location('server/plugins/feature-git.mjs'))], services: { dataDir, getProject: id => ({ id, path: projectPath }) } }); await host.start();
  return { host, context, async close() { await host.close(); await context.fiber.dispose(); } };
}
async function route(host, segments, body, method = 'POST') { const request = new EventEmitter(), response = new EventEmitter(); request.method = method; response.writableFinished = false; let value; await host.dispatch({ segments, body, request, response, url: new URL('http://isolated/'), json: result => { value = result; response.writableFinished = true; } }); return value; }

test('actual Cordis Git stop guard retains activity/state on storage failure and permits save then stop retry', async t => temporary(async root => {
  const gate = deferred(), entered = deferred(), originalPersist = GitDraftStore.prototype._persist, originalRename = promises.rename; let environment, persistMock, renameMock, blocked = false, failing = false;
  try {
    environment = await plugin(root); const host = environment.host; await host.enable('feature-git'); const first = (await route(host, ['git-drafts', 'save'], draft())).draft;
    persistMock = t.mock.method(GitDraftStore.prototype, '_persist', async function (...args) { if (blocked) { entered.resolve(); await gate.promise; } return originalPersist.apply(this, args); });
    renameMock = t.mock.method(promises, 'rename', (...args) => failing && args[1] === path.join(root, 'data/git-drafts.json') ? Promise.reject(Object.assign(new Error('PRIVATE_FS'), { code: 'EIO' })) : originalRename(...args)); syncBuiltinESMExports(); blocked = true; failing = true;
    const saving = route(host, ['git-drafts', 'save'], draft(first.version, 'retry this input')).then(() => null, error => error); await entered.promise;
    const record = host.records.get('feature-git'), fiber = record.fiber, stopping = host.disable('feature-git'), rejected = assert.rejects(stopping, { code: 'GIT_DRAFT_WRITE_FAILED' }); gate.resolve(); await rejected; assert.equal((await saving).code, 'GIT_DRAFT_WRITE_FAILED');
    assert.equal(record.fiber, fiber); assert.equal(record.enabled, true); assert.equal(record.active, true); assert.equal(record.error, 'GIT_DRAFT_WRITE_FAILED'); assert.equal(host.activities().length, 1);
    blocked = false; failing = false; await route(host, ['git-drafts', 'save'], draft(first.version, 'user retried successfully')); await host.disable('feature-git'); assert.equal(record.active, false); assert.equal(record.error, null); assert.deepEqual(host.activities(), []);
    await host.enable('feature-git'); await host.disable('feature-git');
  } finally { gate.resolve(); blocked = false; failing = false; persistMock?.mock.restore(); renameMock?.mock.restore(); syncBuiltinESMExports(); await environment?.close(); }
}));

test('idle Git plugin start/close does not require loading draft data or running Git', async () => temporary(async root => {
  const environment = await plugin(root); await environment.close(); assert.deepEqual(environment.host.activities(), []); assert.equal(environment.host.records.get('feature-git').active, false);
}));

test('actual Git plugin refuses disposal while a native index rollback cannot clean its owned lock', async t => temporary(async root => {
  const repo = await repository(root), originalRun = ProjectGit.prototype._run, originalUnlink = promises.unlink; let environment, runMock, unlinkMock, failing = true;
  try {
    environment = await plugin(root, repo); const host = environment.host; await host.enable('feature-git'); await writeFile(path.join(repo, 'tracked'), 'pending work\n');
    const before = await readFile(path.join(repo, '.git/index')), state = await route(host, ['projects', 'project', 'git', 'status'], undefined, 'GET');
    runMock = t.mock.method(ProjectGit.prototype, '_run', function (...args) { return args[1][0] === 'update-index' ? Promise.reject(fault('GIT_ABORTED')) : originalRun.apply(this, args); });
    unlinkMock = t.mock.method(promises, 'unlink', (file, ...args) => failing && file === path.join(repo, '.git/index.lock') ? Promise.reject(Object.assign(new Error('PRIVATE_LOCK_ERROR'), { code: 'EACCES' })) : originalUnlink(file, ...args)); syncBuiltinESMExports();
    await assert.rejects(route(host, ['projects', 'project', 'git', 'stage'], { path: 'tracked', revision: state.revision }), { code: 'GIT_CLEANUP_FAILED' });
    const record = host.records.get('feature-git'), fiber = record.fiber, activity = host.activities(); assert.equal(activity.length, 1);
    await assert.rejects(host.disable('feature-git'), { code: 'GIT_CLEANUP_FAILED' }); assert.equal(record.fiber, fiber); assert.equal(record.enabled, true); assert.equal(record.active, true); assert.equal(record.error, 'GIT_CLEANUP_FAILED'); assert.deepEqual(host.activities(), activity); assert.deepEqual(await readFile(path.join(repo, '.git/index')), before);
    failing = false; await host.disable('feature-git'); await noGitLocks(repo); assert.equal(record.active, false); assert.equal(record.error, null); assert.deepEqual(host.activities(), []); assert.equal(await readFile(path.join(repo, 'tracked'), 'utf8'), 'pending work\n');
  } finally { failing = false; runMock?.mock.restore(); unlinkMock?.mock.restore(); syncBuiltinESMExports(); await environment?.close(); }
}));
