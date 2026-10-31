import test from 'node:test';
import assert from 'node:assert/strict';
import { GitController, gitEntries, gitEntryKey, diffPreview, gitCapabilities, gitCommitFields } from '../src/lib/git-controller.js';
const gate = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const status = files => ({ branch: 'main', files });
const file = path => ({ path, staged: false, unstaged: true, workingTree: 'M' });

test('a file with index and working-tree changes has two independently selectable entries', () => {
  const entries = gitEntries(status([{ ...file('two changes.md'), staged: true, index: 'M' }, { ...file('new.md'), untracked: true }]));
  assert.deepEqual(entries.map(entry => [entry.path, entry.staged, entry.group]), [['two changes.md', true, 'staged'], ['two changes.md', false, 'working'], ['new.md', false, 'untracked']]);
  assert.notEqual(gitEntryKey(entries[0]), gitEntryKey(entries[1]));
});

test('switching projects aborts work and prevents an old status from exposing another project', async () => {
  const old = gate(), calls = []; const controller = new GitController({ request: (route, options) => { calls.push(options); return old.promise; } });
  controller.select('old'); const loading = controller.refresh(); controller.select('new'); old.resolve(status([file('private-old.md')]));
  assert.equal(await loading, false); assert.equal(calls[0].signal.aborted, true); assert.equal(controller.snapshot().status, null); assert.equal(controller.snapshot().projectId, 'new');
});

test('out-of-order selected-file responses and errors cannot replace the current diff', async () => {
  const a = gate(), b = gate(), calls = [];
  const controller = new GitController({ request: (route, options) => { calls.push({ route, ...options }); return route.endsWith('/status') ? Promise.resolve(status([file('a.md'), file('b.md')])) : route.includes('a.md') ? a.promise : b.promise; } });
  controller.select('project'); const initial = controller.refresh(); await new Promise(resolve => setImmediate(resolve));
  const selecting = controller.loadDiff(gitEntries(controller.snapshot().status)[1]); b.resolve({ path: 'b.md', diff: '+new b' }); await selecting; a.reject(new Error('late old failure')); await initial;
  assert.equal(controller.snapshot().selected.path, 'b.md'); assert.equal(controller.snapshot().diff.diff, '+new b'); assert.equal(controller.snapshot().diffError, null); assert.equal(calls[1].signal.aborted, true);
});

test('refresh preserves a staged selection when available and invalidates its old diff', async () => {
  const calls = [], controller = new GitController({ request: async route => { calls.push(route); return route.endsWith('/status') ? status([{ ...file('dash - and\nline.md'), staged: true, index: 'M' }]) : { diff: '+content' }; } });
  controller.select('project'); await controller.refresh(); assert.equal(controller.snapshot().selected.staged, true); await controller.refresh();
  assert.equal(controller.snapshot().selected.staged, true); assert.ok(calls.at(-1).endsWith('path=dash%20-%20and%0Aline.md&staged=1'));
});

test('a failed diff remains explicitly retryable and disposing cancels every outstanding read', async () => {
  let failed = true; const seen = [];
  const controller = new GitController({ request: async (route, options) => { seen.push(options.signal); if (route.endsWith('/status')) return status([file('a.md')]); if (failed) throw Error('visible diff failure'); return { diff: '+recovered' }; } });
  controller.select('project'); await controller.refresh(); assert.equal(controller.snapshot().diffError, 'visible diff failure'); assert.equal(controller.snapshot().diff, null);
  failed = false; await controller.loadDiff(controller.snapshot().selected); assert.equal(controller.snapshot().diff.diff, '+recovered'); controller.dispose(); assert.equal(seen.at(-1).aborted, true); assert.equal(controller.snapshot().projectId, null);
});

test('large previews are bounded without silently discarding the complete diff available for copying', () => {
  const original = Array.from({ length: 4000 }, (_, n) => '+' + n).join('\n'); const result = diffPreview(original);
  assert.equal(result.lines.length, 3000); assert.equal(result.omitted, 1000); assert.equal(original.split('\n').length, 4000);
});

const writable = (revision = 'revision-one', files = [{ ...file('staged.md'), staged: true, index: 'M' }, file('working.md')]) => ({ ...status(files), revision, identity: { name: 'Fixture Author', email: 'fixture@example.invalid' }, writeCapabilities: { stage: true, unstage: true, commit: true } });
function mutationFixture({ initial = writable(), mutate, read, draftCache = new Map() } = {}) {
  const reads = [], writes = []; let current = initial;
  const controller = new GitController({ draftCache, request: async (route, options) => { reads.push({ route, options }); if (read) return read(route, options); return route.endsWith('/status') ? current : { diff: '+preview' }; }, mutateRequest: async (route, body) => { writes.push({ route, body }); const value = await mutate(route, body); if (value?.status) current = value.status; return value; } });
  controller.select('project'); return { controller, reads, writes, setStatus: value => { current = value; } };
}

test('legacy or explicitly disabled write capabilities never authorize a write', async () => {
  assert.equal(gitCapabilities(status([])).commit, false); assert.equal(gitCapabilities({ ...writable(), revision: undefined }).stage, false);
  let writes = 0;
  const fixture = mutationFixture({ initial: { ...writable(), writeCapabilities: { stage: false, unstage: false, commit: false, reasonCode: 'GIT_WRITE_TRANSFORM' } }, mutate: async () => { writes++; } });
  await fixture.controller.refresh(); assert.equal(await fixture.controller.stage(file('working.md')), false); assert.equal(writes, 0); assert.equal(fixture.controller.snapshot().mutationErrorCode, 'GIT_WRITE_TRANSFORM');
});

test('staging uses the separate write transport with its exact path and revision and blocks double clicks', async () => {
  const pending = gate(), fixture = mutationFixture({ mutate: () => pending.promise });
  await fixture.controller.refresh(); const path = '-space and\nline.md';
  const first = fixture.controller.stage(file(path)); assert.equal(await fixture.controller.stage(file(path)), false);
  assert.equal(fixture.writes.length, 1); assert.deepEqual(fixture.writes[0], { route: 'projects/project/git/stage', body: { path, revision: 'revision-one' } });
  assert.ok(fixture.reads[0].options.signal instanceof AbortSignal); assert.equal('signal' in fixture.writes[0].body, false);
  pending.resolve({ status: writable('revision-two') }); assert.equal(await first, true); assert.equal(fixture.controller.snapshot().status.revision, 'revision-two'); assert.equal(fixture.controller.snapshot().pending, null);
});

test('unstaging only sends one selected path and does not commit or stage other working files', async () => {
  const fixture = mutationFixture({ mutate: async () => ({ status: writable('after-unstage', [file('staged.md'), file('working.md')]) }) });
  await fixture.controller.refresh(); await fixture.controller.unstage(gitEntries(fixture.controller.snapshot().status)[0]);
  assert.deepEqual(fixture.writes.map(row => row.route), ['projects/project/git/unstage']); assert.deepEqual(fixture.writes[0].body, { path: 'staged.md', revision: 'revision-one' });
});

test('review refreshes the actual index and freezes only staged files, identity and message without writing', async () => {
  const fixture = mutationFixture({ mutate: async () => { throw Error('must not write while reviewing'); } });
  await fixture.controller.refresh(); fixture.controller.setDraft({ message: 'Fix selected behavior' });
  fixture.setStatus(writable('review-revision', [{ ...file('new staged.md'), staged: true, originalPath: 'old staged.md' }, file('not staged.md')]));
  assert.equal(await fixture.controller.reviewCommit(), true); const review = fixture.controller.snapshot().review;
  assert.equal(review.revision, 'review-revision'); assert.deepEqual(review.files, [{ path: 'new staged.md', originalPath: 'old staged.md' }]); assert.equal(review.name, 'Fixture Author'); assert.equal(review.message, 'Fix selected behavior'); assert.equal(fixture.writes.length, 0);
  fixture.controller.setDraft({ message: 'edited after review' }); assert.equal(fixture.controller.snapshot().review, null); assert.equal(await fixture.controller.commitReviewed(), false);
});

test('confirmed commit sends the reviewed staged revision once and clears message only after an acknowledged commit', async () => {
  const pending = gate(), fixture = mutationFixture({ mutate: () => pending.promise });
  await fixture.controller.refresh(); fixture.controller.setDraft({ message: 'One local commit' }); await fixture.controller.reviewCommit();
  const committing = fixture.controller.commitReviewed(); assert.equal(await fixture.controller.commitReviewed(), false);
  assert.equal(fixture.controller.snapshot().message, 'One local commit'); assert.equal(fixture.writes.length, 1); assert.ok(fixture.writes[0].route.endsWith('/commit'));
  assert.deepEqual(fixture.writes[0].body, { message: 'One local commit', name: 'Fixture Author', email: 'fixture@example.invalid', revision: 'revision-one' });
  const commit = { oid: 'a'.repeat(40), shortOid: 'aaaaaaa', subject: 'One local commit' }; pending.resolve({ status: writable('committed', [file('working.md')]), commit });
  assert.equal(await committing, true); assert.equal(fixture.controller.snapshot().message, ''); assert.deepEqual(fixture.controller.snapshot().commitResult, commit); assert.equal(fixture.controller.snapshot().status.files.length, 1);
});

test('stale or ambiguous mutation errors refresh reads without resubmission and preserve all commit input', async () => {
  for (const code of ['GIT_STALE', 'GIT_WRITE_CONFLICT', 'GIT_WRITE_UNKNOWN']) {
    const fixture = mutationFixture({ mutate: async () => { throw Object.assign(Error('unsafe raw git stderr'), { code }); } });
    await fixture.controller.refresh(); fixture.controller.setDraft({ message: 'Keep this draft', authorName: 'Another Author', authorEmail: 'other@example.invalid' }); await fixture.controller.reviewCommit();
    assert.equal(await fixture.controller.commitReviewed(), false); const current = fixture.controller.snapshot();
    assert.equal(fixture.writes.length, 1); assert.equal(current.message, 'Keep this draft'); assert.equal(current.authorName, 'Another Author'); assert.equal(current.authorEmail, 'other@example.invalid'); assert.equal(current.review, null); assert.equal(current.commitResult, null); assert.equal(current.mutationErrorCode, code);
    assert.equal(fixture.reads.filter(row => row.route.endsWith('/status')).length, 3);
  }
});

test('a malformed commit response is not treated as success and leaves the message intact', async () => {
  const fixture = mutationFixture({ mutate: async () => ({ status: writable('maybe-committed') }) });
  await fixture.controller.refresh(); fixture.controller.setDraft({ message: 'Needs evidence' }); await fixture.controller.reviewCommit();
  assert.equal(await fixture.controller.commitReviewed(), false); assert.equal(fixture.controller.snapshot().message, 'Needs evidence'); assert.equal(fixture.controller.snapshot().mutationErrorCode, 'GIT_PROTOCOL'); assert.equal(fixture.controller.snapshot().commitResult, null);
});

test('a late write response after switching projects cannot overwrite the new status or clear its draft', async () => {
  const pending = gate(), fixture = mutationFixture({ mutate: () => pending.promise });
  await fixture.controller.refresh(); fixture.controller.setDraft({ message: 'Old project draft' }); await fixture.controller.reviewCommit(); const writing = fixture.controller.commitReviewed();
  fixture.controller.select('new-project'); fixture.controller.setDraft({ message: 'New project draft' }); fixture.setStatus(writable('new-project-revision', [file('new-project.md')])); await fixture.controller.refresh();
  pending.resolve({ status: writable('old-mutation-result'), commit: { oid: 'b'.repeat(40), shortOid: 'bbbbbbb', subject: 'Old' } }); assert.equal(await writing, false);
  const current = fixture.controller.snapshot(); assert.equal(current.projectId, 'new-project'); assert.equal(current.status.revision, 'new-project-revision'); assert.equal(current.message, 'New project draft'); assert.equal(current.commitResult, null); assert.equal(current.pending, null);
});

test('a slow status read cannot roll a newer mutation snapshot back', async () => {
  const oldRead = gate(); let calls = 0;
  const fixture = mutationFixture({ read: async route => route.endsWith('/status') ? ++calls === 1 ? writable() : oldRead.promise : { diff: '+preview' }, mutate: async () => ({ status: writable('newest-mutation') }) });
  await fixture.controller.refresh(); const reading = fixture.controller.refresh(); await fixture.controller.stage(file('working.md')); oldRead.resolve(writable('obsolete-read')); await reading;
  assert.equal(fixture.controller.snapshot().status.revision, 'newest-mutation');
});

test('commit input limits and missing identity are checked before review can authorize a write', () => {
  for (const input of [{ message: '', authorName: 'A', authorEmail: 'a@b' }, { message: '中'.repeat(5400), authorName: 'A', authorEmail: 'a@b' }, { message: 'hello', authorName: '', authorEmail: 'a@b' }, { message: 'hello', authorName: 'A\nBad', authorEmail: 'a@b' }, { message: 'hello', authorName: 'A', authorEmail: 'not an email' }]) assert.throws(() => gitCommitFields(input));
  assert.deepEqual(gitCommitFields({ message: ' first commit ', authorName: ' A ', authorEmail: 'a@localhost' }), { message: 'first commit', name: 'A', email: 'a@localhost' });
});

test('refresh immediately invalidates a reviewed commit and editing during a pending review cannot revive it', async () => {
  const held = gate(); let wait = false;
  const fixture = mutationFixture({ read: async route => route.endsWith('/status') ? wait ? held.promise : writable() : { diff: '+preview' }, mutate: async () => { throw Error('must not write'); } });
  await fixture.controller.refresh(); fixture.controller.setDraft({ message: 'Before refresh' }); await fixture.controller.reviewCommit();
  wait = true; const refreshing = fixture.controller.refresh(); assert.equal(fixture.controller.snapshot().review, null); assert.equal(await fixture.controller.commitReviewed(), false);
  fixture.controller.setDraft({ message: 'New draft during read' }); held.resolve(writable('fresh-read')); await refreshing; assert.equal(fixture.controller.snapshot().message, 'New draft during read'); assert.equal(fixture.controller.snapshot().review, null); assert.equal(fixture.writes.length, 0);
});

test('new editing while a commit response is delayed survives its successful acknowledgement', async () => {
  const held = gate(), fixture = mutationFixture({ mutate: () => held.promise });
  await fixture.controller.refresh(); fixture.controller.setDraft({ message: 'Submitted message' }); await fixture.controller.reviewCommit(); const writing = fixture.controller.commitReviewed();
  fixture.controller.setDraft({ message: 'Prepared next message' }); held.resolve({ status: writable('done'), commit: { oid: 'c'.repeat(40), shortOid: 'ccccccc', subject: 'Submitted message' } }); await writing;
  assert.equal(fixture.controller.snapshot().message, 'Prepared next message'); assert.equal(fixture.writes.length, 1);
});

test('bounded memory-only drafts survive panel recreation and successful commits remove the matching draft', async () => {
  const draftCache = new Map(), first = mutationFixture({ draftCache, mutate: async () => ({ status: writable('committed'), commit: { oid: 'd'.repeat(40), shortOid: 'ddddddd', subject: 'Keep across panels' } }) });
  await first.controller.refresh(); first.controller.setDraft({ message: 'Keep across panels', authorName: 'Local Author', authorEmail: 'local@example.invalid' }); first.controller.dispose();
  const second = mutationFixture({ draftCache, mutate: async () => ({ status: writable('committed'), commit: { oid: 'd'.repeat(40), shortOid: 'ddddddd', subject: 'Keep across panels' } }) });
  await second.controller.refresh(); assert.equal(second.controller.snapshot().message, 'Keep across panels'); assert.equal(second.controller.snapshot().authorName, 'Local Author'); await second.controller.reviewCommit(); await second.controller.commitReviewed(); second.controller.dispose(); assert.equal(draftCache.has('project'), false);
  for (let n = 0; n < 25; n++) { second.controller.select('project-' + n); second.controller.setDraft({ message: 'bounded ' + n }); }
  assert.equal(draftCache.size, 20); assert.equal(draftCache.has('project-0'), false); second.controller.dispose();
});
