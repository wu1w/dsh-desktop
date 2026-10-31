import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { transform } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { translator } from '../src/i18n.js';

const file = new URL('../src/settings-content.jsx', import.meta.url), require = createRequire(file);
const code = await transform(await readFile(file, 'utf8') + '\nexport { PluginsContent };', { loader: 'jsx', format: 'cjs' });
const plugin = (error = null) => ({ id: 'feature-automations', type: 'feature', name: { en: 'Local automations', 'zh-CN': '本地自动化' }, version: '0.1.0', active: true, enabled: true, builtin: true, error });
const snapshot = row => ({ plugins: [row], engineProviders: [], selectedEngine: 'codex', engine: { state: 'ready' }, sessions: [] });
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : [];
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

function view({ locale = 'en', state = snapshot(plugin()), read = async () => ({}), refresh = async () => {} } = {}) {
  const slots = [], effects = []; let cursor = 0;
  const react = { ...React, useEffect(effect) { effects.push(effect); }, useRef(current) { const index = cursor++; return slots[index] ??= { current }; }, useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial; return [slots[index], next => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }]; } };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code.code)(id => id === 'react' ? react : id === './api.js' ? { api: read } : id === './model-settings.jsx' ? {ModelSettings:()=>null} : id === './plugin-studio.jsx' ? {PluginStudio:()=>null} : id === './channel-settings.jsx' ? {ChannelSettings:()=>null} : require(id), module, module.exports);
  const render = () => { cursor = 0; return module.exports.PluginsContent({ t: translator(locale), locale, state, refresh }); };
  return { render, mount() { render(); const cleanups = effects.splice(0).map(effect => effect()); return () => cleanups.forEach(cleanup => cleanup?.()); } };
}

test('actual plugin rows localize retained cleanup errors in both languages and keep explicit stop controls', () => {
  for (const locale of ['zh-CN', 'en']) for (const error of ['AUTOMATION_STOP_FAILED', 'COMMAND_STOP_FAILED', 'PTY_STOP_FAILED', 'GIT_CLEANUP_FAILED', 'GIT_DRAFT_WRITE_FAILED', 'FILE_OPEN_CLEANUP_FAILED']) {
    const row = plugin(error), fixture = view({ locale, state: snapshot(row) });
    const tree = fixture.render(), message = nodes(tree).find(node => node.props?.className === 'plugin-error');
    assert.equal(message.props.children, translator(locale)(error)); assert.notEqual(message.props.children, error);
    assert.ok(nodes(tree).some(node => node.type === 'button' && node.props.children === translator(locale)('disablePlugin') && !node.props.disabled));
    const html = renderToStaticMarkup(tree); assert.ok(!html.includes(error)); assert.ok(html.includes(translator(locale)('pluginActive')));
  }
});

test('unknown plugin error codes and arbitrary details use a localized fallback without rendering raw internals', () => {
  for (const error of ['UNKNOWN_CLEANUP', '<private-path>/private-data', 'secret\nstack']) {
    const fixture = view({ locale: 'en', state: snapshot(plugin(error)) }), html = renderToStaticMarkup(fixture.render());
    assert.ok(html.includes(translator('en')('PLUGIN_RUNTIME_FAILED'))); assert.ok(!html.includes(error));
  }
});

test('a failed stop refreshes authoritative plugin state, preserves the first error, and unlocks a single explicit retry', async () => {
  const held = deferred(), calls = [], state = snapshot(plugin()); let refreshes = 0, fail = true;
  const fixture = view({ state, refresh: async () => { refreshes++; state.plugins = [plugin(fail ? 'AUTOMATION_STOP_FAILED' : null)]; if (!fail) Object.assign(state.plugins[0], { enabled: false, active: false }); }, read: async (route, body) => { calls.push({ route, body }); if (route === 'plugins') return { plugins: state.plugins }; if (fail) { await held.promise; throw Object.assign(Error('The native task is still ending.'), { code: 'AUTOMATION_STOP_FAILED' }); } return {}; } });
  const stop = nodes(fixture.render()).find(node => node.type === 'button' && node.props.children === 'Disable');
  const first = stop.props.onClick(), duplicate = stop.props.onClick(); await duplicate;
  assert.equal(calls.filter(call => call.route.endsWith('/disable')).length, 1); assert.ok(nodes(fixture.render()).filter(node => node.type === 'button').every(node => node.props.disabled));
  held.resolve(); await first;
  assert.equal(refreshes, 1); assert.equal(calls.filter(call => call.route === 'plugins').length, 1);
  let tree = fixture.render(); assert.equal(nodes(tree).find(node => node.props?.className === 'plugin-error').props.children, translator('en')('AUTOMATION_STOP_FAILED'));
  assert.ok(nodes(tree).some(node => node.props?.error === 'The native task is still ending.'));
  fail = false; await nodes(tree).find(node => node.type === 'button' && node.props.children === 'Disable').props.onClick();
  tree = fixture.render(); assert.equal(refreshes, 2); assert.equal(calls.filter(call => call.route.endsWith('/disable')).length, 2); assert.ok(nodes(tree).some(node => node.type === 'button' && node.props.children === 'Enable' && !node.props.disabled));
});

test('an older catalog failure cannot replace a newer refresh', async () => {
  const reads = [deferred(), deferred()], state = snapshot(plugin()); let count = 0;
  const fixture = view({ state, read: async () => reads[count++].promise });
  const unmount = fixture.mount(); const newer = nodes(fixture.render()).find(node => node.type === 'button' && node.props.title === 'Refresh').props.onClick();
  reads[1].resolve({ plugins: state.plugins }); await newer; reads[0].reject(Error('stale catalog failure')); await tick();
  assert.ok(!nodes(fixture.render()).some(node => node.props?.error === 'stale catalog failure')); unmount();
});
