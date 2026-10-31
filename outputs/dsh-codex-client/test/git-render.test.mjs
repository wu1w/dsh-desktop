import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { transform } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { translator } from '../src/i18n.js';
import { gitLocales } from '../src/git-locales.js';
import * as controllerModule from '../src/lib/git-controller.js';

const url = new URL('../src/components/GitPanel.jsx', import.meta.url), module = { exports: {} }, compiled = await transform(await readFile(url, 'utf8'), { loader: 'jsx', format: 'cjs' }), realRequire = createRequire(url);
new Function('require', 'module', 'exports', compiled.code)(id => id.endsWith('.css') ? {} : id === '../api.js' ? { api() { throw Error('SSR_MUST_NOT_CALL_API'); } } : id === '../lib/git-controller.js' ? controllerModule : realRequire(id), module, module.exports);
const { GitPanelView, GitPanel } = module.exports;
const tFor = locale => (key, params = {}) => typeof gitLocales[locale]?.[key] === 'string' ? gitLocales[locale][key].replace(/\{(\w+)\}/g, (whole, name) => Object.hasOwn(params, name) ? params[name] : whole) : translator(locale)(key, params);
const files = [{ path: 'staged.md', originalPath: 'old.md', staged: true, unstaged: false, index: 'R', workingTree: '.' }, { path: 'working.md', staged: false, unstaged: true, index: '.', workingTree: 'M' }];
const status = { files, branch: 'main', revision: 'review-revision', writeCapabilities: { stage: true, unstage: true, commit: true }, identity: { name: 'Fixture Author', email: 'fixture@example.invalid' } };
const controller = { refresh() {}, loadDiff() {}, stage() {}, unstage() {}, setDraft() {}, reviewCommit() {}, commitReviewed() {}, cancelReview() {} };
function snapshot(extra = {}) { return { projectId: 'project', status, selected: { ...files[1], group: 'working' }, diff: { diff: '+readable preview' }, message: 'Fix staged behavior', authorName: 'Fixture Author', authorEmail: 'fixture@example.invalid', ...extra }; }
function render(extra = {}, locale = 'en') { return renderToStaticMarkup(React.createElement(GitPanelView, { project: { id: 'project', name: 'Owned project' }, snapshot: snapshot(extra), controller, t: tFor(locale), locale, onCopy() {}, onOpenFile() {} })); }
const button = (html, label) => [...html.matchAll(/<button\b([^>]*)>/g)].map(match => match[1]).find(attributes => attributes.includes(`aria-label="${label}"`));

for (const locale of ['en', 'zh-CN']) {
  test('legacy Git remains read-only while copy and file preview remain available in ' + locale, () => {
    const legacy = { ...status }; delete legacy.revision; delete legacy.writeCapabilities;
    const html = render({ status: legacy }, locale), t = tFor(locale);
    assert.ok(html.includes(t('gitLegacyReadOnly'))); assert.ok(button(html, t('gitCopyDiff'))); assert.ok(button(html, t('gitOpenFile'))); assert.ok(html.includes('+readable preview'));
    assert.doesNotMatch(html, /git-file-action/); assert.doesNotMatch(html, /<textarea/); assert.ok(!html.includes(t('gitConfirmCommit')));
  });
  test('actual writable Git markup exposes separate single-file stage/unstage and identity review in ' + locale, () => {
    const html = render({}, locale), t = tFor(locale);
    assert.ok(button(html, t('gitStageFile', { path: 'working.md' }))); assert.ok(button(html, t('gitUnstageFile', { path: 'staged.md' })));
    assert.ok(!button(html, t('gitStageFile', { path: 'working.md' })).includes('disabled'));
    for (const key of ['gitReviewCommit', 'gitCommitMessage', 'gitAuthorName', 'gitAuthorEmail', 'gitIdentityOneCommit']) assert.ok(html.includes(t(key)), key);
    assert.ok(html.includes('value="Fixture Author"')); assert.ok(html.includes('value="fixture@example.invalid"')); assert.ok(!html.includes('window.confirm'));
  });
  test('inline commit confirmation includes actual staged paths, identity and message in ' + locale, () => {
    const review = { projectId: 'project', revision: status.revision, files: [{ path: 'staged.md', originalPath: 'old.md' }], message: 'Commit exactly this\nSecond line', name: 'Fixture Author', email: 'fixture@example.invalid' };
    const html = render({ review }, locale), t = tFor(locale), panel = html.slice(html.indexOf('class="git-commit-review"'), html.indexOf('class="git-diff-heading"'));
    for (const content of ['staged.md', 'old.md', 'Commit exactly this', 'Second line', 'Fixture Author', 'fixture@example.invalid', t('gitConfirmCommit'), t('gitStagedOnlyHelp'), t('gitCommitExecutionScope')]) assert.ok(panel.includes(content), content);
    assert.ok(!panel.includes('working.md')); assert.ok(panel.includes('role="group"')); assert.ok(panel.includes(t('gitStagedScope', { count: '1' })));
  });
}

test('disabled backend capabilities show their reason and never leave an enabled write action', () => {
  const html = render({ status: { ...status, writeCapabilities: { stage: false, unstage: false, commit: false, reasonCode: 'GIT_WRITE_TRANSFORM' } } });
  assert.ok(button(html, 'Stage working.md').includes('disabled')); assert.ok(button(html, 'Unstage staged.md').includes('disabled'));
  assert.match(html, /type="submit"[^>]*disabled/); assert.ok(html.includes('role="status"'));
});

test('busy commit controls are disabled and mutation errors do not render raw Git stderr', () => {
  const busy = render({ pending: 'commit' }); assert.match(busy, /aria-busy="true"/); assert.ok(button(busy, 'Stage working.md').includes('disabled')); assert.match(busy, /<textarea[^>]*disabled/);
  const failed = render({ mutationError: 'SECRET stderr /private/path -- dangerous', mutationErrorCode: 'UNRECOGNIZED_BACKEND_ERROR', error: '<raw stderr>', errorCode: 'UNRECOGNIZED_BACKEND_ERROR' });
  assert.ok(!failed.includes('SECRET')); assert.ok(!failed.includes('/private/path')); assert.ok(!failed.includes('raw stderr')); assert.ok(failed.includes(tFor('en')('gitFailureKeptDraft'))); assert.ok(failed.includes('Fix staged behavior'));
});

test('missing author identity disables review and supplies an explanation without erasing the message', () => {
  const html = render({ authorName: '', authorEmail: '' }); assert.match(html, /type="submit"[^>]*disabled/); assert.ok(html.includes(tFor('en')('gitCommitDraftHelp'))); assert.ok(html.includes('Fix staged behavior'));
});

test('the actual GitPanel wrapper does not fetch or mutate while server-rendering', () => {
  let calls = 0;
  const html = renderToStaticMarkup(React.createElement(GitPanel, { project: { id: 'project', name: 'Owned project' }, t: tFor('en'), locale: 'en', request: async () => { calls++; }, mutateRequest: async () => { calls++; } }));
  assert.ok(html.includes('Owned project')); assert.equal(calls, 0);
});

test('the real wrapper masks the previous project before its selection effect runs', () => {
  const isolated = { exports: {} }; let calls = 0;
  const react = { ...React, useEffect() {}, useState: () => ++calls === 1 ? [snapshot({ projectId: 'old-project', status: { ...status, files: [{ path: 'old-private-file.md', staged: false, unstaged: true }] } }), () => {}] : [controller, () => {}] };
  new Function('require', 'module', 'exports', compiled.code)(id => id === 'react' ? react : id.endsWith('.css') ? {} : id === '../api.js' ? {} : id === '../lib/git-controller.js' ? controllerModule : realRequire(id), isolated, isolated.exports);
  const html = renderToStaticMarkup(React.createElement(isolated.exports.GitPanel, { project: { id: 'new-project', name: 'New project' }, t: tFor('en'), locale: 'en' }));
  assert.ok(html.includes('New project')); assert.ok(!html.includes('old-private-file.md')); assert.ok(!html.includes('Fix staged behavior'));
});

test('Git UI translation resources have matching complete language keys', () => {
  assert.deepEqual(Object.keys(gitLocales.en).sort(), Object.keys(gitLocales['zh-CN']).sort());
  for (const dictionary of Object.values(gitLocales)) for (const value of Object.values(dictionary)) assert.equal(typeof value, 'string');
});

test('draft failures are visible and replacing a conflicted draft requires a separate explicit confirmation',()=>{
  const html=render({draftSync:{errorCode:'GIT_DRAFT_CHANGED',dirty:true},draftReloadConfirm:true});
  assert.ok(html.includes(tFor('en')('gitDraftSaveFailed')));assert.ok(html.includes(tFor('en')('gitDraftReplaceWarning')));assert.ok(html.includes(tFor('en')('gitDraftReplaceConfirm')));assert.ok(html.includes('Fix staged behavior'));assert.ok(!html.includes('Commit draft saved on this device'));
  const pending=render({draftSync:{saving:true,dirty:true,value:{message:'draft'}}});assert.ok(pending.includes(tFor('en')('gitDraftSaving')));assert.ok(!pending.includes(tFor('en')('gitDraftSaved')));
});
