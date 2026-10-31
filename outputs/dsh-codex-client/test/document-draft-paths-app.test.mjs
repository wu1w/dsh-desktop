import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { transform } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DocumentSession } from '../src/lib/document-session.js';

const appRoot = process.env.DSH_ACCEPTANCE_APP_ROOT;
const { startHost } = await import(appRoot ? pathToFileURL(path.join(appRoot, 'server/index.mjs')) : new URL('../server/index.mjs', import.meta.url));
const appFile = new URL('../src/main.jsx', import.meta.url), require = createRequire(appFile), marker = '  function navigate(id, record = true) {';
const raw = await readFile(appFile, 'utf8'); assert.equal(raw.split(marker).length, 2);
const code = await transform(raw.replace(marker, '  captureProbe({saveDocument,flushDrafts,documentSession,documentDraftSync,syncDocument,setProjectId,setError,setNotice,initialBoot});\n' + marker) + '\nexport {App};', { loader: 'jsx', format: 'cjs' });

function actualApp({ file, project, api }) {
  const session = new DocumentSession({ file, dirty: false }), slots = [], storage = new Map([['dsh-locale', 'en']]), calls = [], jsx = new Map();
  const state = { projects: [project], sessions: [], engine: { state: 'stopped', capabilities: {} }, features: ['feature-files'] }; let cursor = 0, latest;
  const react = { ...React, useEffect() {}, useLayoutEffect() {}, useRef(value) { return slots[cursor++] ??= { current: value }; }, useState(initial) {
    const key = cursor++; if (!(key in slots)) { let value = typeof initial === 'function' ? initial() : initial; if (value instanceof DocumentSession) value = session; if (value && Array.isArray(value.projects) && Array.isArray(value.sessions) && value.engine) value = state; const slot = { value }; slot.setter = next => { slot.setter.calls.push(next); slot.value = typeof next === 'function' ? next(slot.value) : next; }; slot.setter.calls = []; slots[key] = slot; }
    return [slots[key].value, slots[key].setter];
  } };
  const dependency = id => {
    if (id === 'react') return react;
    if (id.endsWith('.css')) return {};
    if (id === './api.js') return { api: async (...args) => { calls.push(args); return api(...args); } };
    if (id === './lib/git-draft-sync.js') return { flushGitDrafts: async () => {}, subscribeGitDraftState: () => () => {} };
    if (id.endsWith('.jsx')) { if (!jsx.has(id)) jsx.set(id, new Proxy({}, { get(target, name) { if (name === '__esModule') return true; return target[name] ??= function Stub() { return null; }; } })); return jsx.get(id); }
    return require(id);
  };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'localStorage', 'window', 'document', 'captureProbe', code.code)(dependency, module, module.exports, { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) }, {}, {}, value => { latest = value; });
  const render = () => { cursor = 0; module.exports.App({ registerCleanup() {} }); latest.initialBoot.current = true; };
  render(); latest.setProjectId(project.id); render();
  return { session, storage, calls, render, get probe() { return latest; }, dispose() { latest.documentDraftSync.dispose(); } };
}

test('actual App Save and close flush use real HTTP recovery for POSIX backslash, drive and control filenames', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-draft-paths-app-')); let host;
  try {
    const projectPath = path.join(root, 'project'); await mkdir(projectPath); host = await startHost({ dataDir: path.join(root, 'data'), autoStart: false });
    const response = await fetch(host.url + '/api/bootstrap'), boot = await response.json(), headers = { cookie: response.headers.get('set-cookie').split(';')[0], 'x-dsh-capability': boot.capability, 'content-type': 'application/json', 'accept-language': 'en' };
    const api = async (route, body) => { const response = await fetch(host.url + '/api/' + route, { headers, method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body) }); const result = await response.json(); if (response.status !== 200) throw Object.assign(new Error(result.message), { code: result.code }); return result; };
    const project = await api('projects', { path: projectPath });
    for (const name of ['a\\b.txt', 'notes\\..\\outside.md', 'C:\\outside.md', 'line\nname.txt', 'tab\tname.txt', 'escape\x1bname.txt', 'literal"><img src=x onerror=alert(1)>\n.txt']) {
      const target = path.join(projectPath, name); await writeFile(target, 'original'); const file = { ...await api(`projects/${project.id}/file?path=${encodeURIComponent(name)}`), projectId: project.id }, app = actualApp({ file, project, api });
      try {
        const edited = 'edited content for ' + JSON.stringify(name); app.session.edit(edited); app.probe.syncDocument(); app.render();
        await app.probe.flushDrafts(); const recovered = await api(`document-drafts?projectId=${project.id}&path=${encodeURIComponent(name)}`);
        assert.equal(recovered.draft.path, name); assert.equal(recovered.draft.content, edited); assert.equal(await readFile(target, 'utf8'), 'original');
        assert.equal(await app.probe.saveDocument(), true); assert.equal(app.session.snapshot().dirty, false); assert.equal(await readFile(target, 'utf8'), edited);
        assert.equal((await api(`document-drafts?projectId=${project.id}&path=${encodeURIComponent(name)}`)).draft, null);
        app.render(); await app.probe.flushDrafts(); await app.probe.documentDraftSync.flush();
        app.session.edit('explicitly discarded unsaved content'); app.probe.syncDocument(); app.render(); await app.probe.flushDrafts({ discardDocument: true });
        assert.equal((await api(`document-drafts?projectId=${project.id}&path=${encodeURIComponent(name)}`)).draft, null); assert.equal(app.storage.has('dsh-document-draft'), false); assert.equal(await readFile(target, 'utf8'), edited);
        assert.equal(app.probe.setError.calls.filter(value => typeof value === 'string' && value).length, 0);
      } finally { app.dispose(); }
    }
    assert.equal(host.engine, undefined);
  } finally { await host?.close(); await rm(root, { recursive: true, force: true }); }
});

test('the actual FileBrowser renders control and markup-looking filenames as escaped text while handlers retain exact paths', async () => {
  const file = new URL('../src/components/FileBrowser.jsx', import.meta.url), source = await transform(await readFile(file, 'utf8'), { loader: 'jsx', format: 'cjs' }), module = { exports: {} };
  new Function('require', 'module', 'exports', source.code)(id => id.endsWith('.css') ? {} : id === '../menu.jsx' ? { Dropdown: () => null, MenuItem: () => null, MenuDivider: () => null } : require(id), module, module.exports);
  const { FileBrowser } = module.exports, name = 'literal"><img src=x onerror=alert(1)>\n\t\x1b.txt', clicked = [];
  const props = { project: { id: 'p', path: '/isolated', name: 'Project' }, entries: [{ path: name, name, size: 1 }], t: key => key, locale: 'en', onOpen: value => clicked.push(value) };
  const html = renderToStaticMarkup(React.createElement(FileBrowser, props));
  assert.ok(!html.includes('<img')); assert.ok(html.includes('&lt;img')); assert.ok(html.includes('\\n')); assert.ok(html.includes('\\t')); assert.ok(html.includes('\\u001b'));
  const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...nodes(value.props?.children)] : [];
  const primary = nodes(FileBrowser(props)).find(node => node.type === 'button' && node.props.className === 'file-browser-entry-main'); assert.equal(primary.props.disabled, false); primary.props.onClick(); assert.deepEqual(clicked, [name]);
});
