export const gitEntryKey = entry => JSON.stringify([entry.path, Boolean(entry.staged)]);
export const gitDisplayPath = value => /[\r\n\t]/.test(value) || value.trim() !== value ? JSON.stringify(value) : value;
export function gitEntries(status) {
  const files = status?.files ?? [];
  return [
    ...files.filter(file => file.staged).map(file => ({ ...file, staged: true, group: 'staged' })),
    ...files.filter(file => file.unstaged || file.untracked).map(file => ({ ...file, staged: false, group: file.untracked ? 'untracked' : 'working' })),
  ];
}
export function diffPreview(diff, limit = 3000) {
  const lines = String(diff ?? '').split('\n');
  return { lines: lines.slice(0, limit), omitted: Math.max(0, lines.length - limit) };
}
const fault = code => Object.assign(new Error(code), { code });
const codeOf = error => /^[A-Z][A-Z0-9_]{0,79}$/.test(error?.code ?? '') ? error.code : 'GIT_FAILED';
const validStatus = status => status && Array.isArray(status.files) && status.files.every(file => typeof file?.path === 'string');
const memoryDrafts = new Map();
export function gitCapabilities(status) {
  const value = status?.writeCapabilities, revision = typeof status?.revision === 'string' && status.revision.length > 0;
  return { stage: revision && value?.stage === true, unstage: revision && value?.unstage === true, commit: revision && value?.commit === true, reasonCode: value?.reasonCode ?? 'gitLegacyReadOnly' };
}
export function gitErrorText(code, t) { const translated = typeof code === 'string' ? t(code) : null; return translated && translated !== code ? translated : t('gitOperationFailed'); }
export function gitCommitFields({ message = '', authorName = '', authorEmail = '' }) {
  const name = authorName.trim(), email = authorEmail.trim(), text = message.trim();
  if (!text || text.includes('\0') || new TextEncoder().encode(text).length > 16000) throw fault('gitMessageInvalid');
  if (!name || name.length > 160 || /[\x00-\x1f\x7f<>]/.test(name) || !/^[^\s<>@]+@[^\s<>@]+$/.test(email) || email.length > 254) throw fault('gitIdentityInvalid');
  return { message: text, name, email };
}

export class GitController {
  constructor({ request, mutateRequest, draftCache = memoryDrafts, draftCoordinator = null, onChange = () => {} }) { this.draftCoordinator = draftCoordinator; this.request = request; this.mutateRequest = mutateRequest; this.onChange = () => {}; this.epoch = 0; this.statusSequence = 0; this.diffSequence = 0; this.drafts = draftCache; this.draftRevision = 0; this.select(null); this.onChange = onChange; }
  _rememberDraft() {
    if (!this.projectId || !this.state) return;
    const value = { message: this.state.message, authorName: this.state.authorName, authorEmail: this.state.authorEmail, authorEdited: this.state.authorEdited };
    this.drafts.delete(this.projectId);
    if ((!value.message && !value.authorEdited) || new TextEncoder().encode(JSON.stringify(value)).length > 65536) return;
    this.drafts.set(this.projectId, value); while (this.drafts.size > 20) this.drafts.delete(this.drafts.keys().next().value);
  }
  select(projectId) {
    this._rememberDraft(); this.releaseDraft?.(); this.releaseDraft = null;
    this.statusAbort?.abort(); this.diffAbort?.abort(); this.epoch++; this.projectId = projectId;
    this.state = { projectId, status: null, selected: null, diff: null, loading: false, diffLoading: false, error: null, errorCode: null, diffError: null, diffErrorCode: null, pending: this.pendingMutation?.action ?? null, mutationError: null, mutationErrorCode: null, message: '', authorName: '', authorEmail: '', authorEdited: false, review: null, commitResult: null, draftSync: null, draftReloadConfirm: false, ...this.drafts.get(projectId) }; this.publish();
    if (projectId && this.draftCoordinator) {
      const epoch = this.epoch;
      try {
        this.releaseDraft = this.draftCoordinator.subscribe(projectId, draft => {
          if (epoch !== this.epoch) return;
          const changed = draft.value && ['message','authorName','authorEmail'].some(key => this.state[key] !== draft.value[key]);
          if (changed) this.draftRevision++;
          this.state = { ...this.state, ...(changed ? { ...draft.value, authorEdited: Boolean(draft.value.message || draft.value.authorName || draft.value.authorEmail), review: null } : {}), draftSync: draft }; this._rememberDraft(); this.publish();
        });
        void this.draftCoordinator.load(projectId).catch(() => {});
      } catch (error) { this.state = { ...this.state, draftSync: { errorCode: error.code, unavailable: true } }; this.publish(); }
    }
  }
  publish() { this.onChange(this.snapshot()); }
  snapshot() { return { ...this.state }; }
  _acceptStatus(status) {
    if (!validStatus(status)) throw fault('GIT_PROTOCOL');
    const entries = gitEntries(status), old = this.state.selected;
    const selected = entries.find(entry => old && gitEntryKey(entry) === gitEntryKey(old)) ?? entries[0] ?? null;
    const identity = this.state.authorEdited ? {} : { authorName: typeof status.identity?.name === 'string' ? status.identity.name : '', authorEmail: typeof status.identity?.email === 'string' ? status.identity.email : '' };
    this.state = { ...this.state, ...identity, status, selected, diff: null, diffLoading: false, loading: false, review: null };
  }
  setDraft(patch) {
    const clean = Object.fromEntries(['message', 'authorName', 'authorEmail'].filter(key => typeof patch?.[key] === 'string').map(key => [key, patch[key]]));
    this.draftRevision++; this.state = { ...this.state, ...clean, ...(Object.hasOwn(clean, 'authorName') || Object.hasOwn(clean, 'authorEmail') || this.draftCoordinator && Object.keys(clean).length ? { authorEdited: true } : {}), review: null, mutationError: null, mutationErrorCode: null, commitResult: null }; this._rememberDraft(); this.publish();
    if (this.draftCoordinator && this.projectId) { try { this.draftCoordinator.update(this.projectId, { message: this.state.message, authorName: this.state.authorName, authorEmail: this.state.authorEmail }); } catch (error) { this.state = { ...this.state, draftSync: { errorCode: error.code, unavailable: true } }; this.publish(); } }
  }
  retryDraft() { return this.draftCoordinator?.retry(this.projectId).catch(() => {}); }
  confirmDraftReload(value = true) { this.state = { ...this.state, draftReloadConfirm: value }; this.publish(); }
  async reloadDraft() { const id = this.projectId, epoch = this.epoch; try { await this.draftCoordinator?.reload(id); } catch {} finally { if (epoch === this.epoch) { this.state = { ...this.state, draftReloadConfirm: false }; this.publish(); } } }
  cancelReview() {
    if (!this.state.review) return Promise.resolve(false);
    const epoch = this.epoch, selected = this.state.selected;
    this.state = { ...this.state, review: null }; this.publish();
    // Review refreshes the index without loading a diff. Return to the current
    // owned selection; a duplicate click must not abort that fresh read.
    if (epoch !== this.epoch || !selected || this.pendingMutation || this.state.loading) return Promise.resolve(false);
    return this.loadDiff(selected);
  }
  async refresh({ loadDiff = true } = {}) {
    if (!this.projectId) return false;
    this.statusAbort?.abort(); this.diffAbort?.abort(); const abort = this.statusAbort = new AbortController();
    const epoch = this.epoch, sequence = ++this.statusSequence, projectId = this.projectId; ++this.diffSequence;
    this.state = { ...this.state, loading: true, diffLoading: false, diff: null, error: null, diffError: null, review: null }; this.publish();
    try {
      const status = await this.request(`projects/${encodeURIComponent(projectId)}/git/status`, { signal: abort.signal });
      if (epoch !== this.epoch || sequence !== this.statusSequence || abort.signal.aborted) return false;
      this._acceptStatus(status); this.publish();
      if (loadDiff && this.state.selected) await this.loadDiff(this.state.selected); return true;
    } catch (error) {
      if (epoch !== this.epoch || sequence !== this.statusSequence || abort.signal.aborted) return false;
      this.state = { ...this.state, loading: false, error: String(error.message).slice(0, 400), errorCode: codeOf(error) }; this.publish(); return false;
    }
  }
  async loadDiff(entry) {
    if (!this.projectId || !gitEntries(this.state.status).some(value => gitEntryKey(value) === gitEntryKey(entry))) return false;
    this.diffAbort?.abort(); const abort = this.diffAbort = new AbortController();
    const epoch = this.epoch, sequence = ++this.diffSequence, key = gitEntryKey(entry), projectId = this.projectId;
    this.state = { ...this.state, selected: entry, diff: null, diffLoading: true, diffError: null }; this.publish();
    try {
      const diff = await this.request(`projects/${encodeURIComponent(projectId)}/git/diff?path=${encodeURIComponent(entry.path)}&staged=${entry.staged ? '1' : '0'}`, { signal: abort.signal });
      if (epoch !== this.epoch || sequence !== this.diffSequence || abort.signal.aborted || gitEntryKey(this.state.selected) !== key) return false;
      this.state = { ...this.state, diff, diffLoading: false }; this.publish(); return true;
    } catch (error) {
      if (epoch !== this.epoch || sequence !== this.diffSequence || abort.signal.aborted) return false;
      this.state = { ...this.state, diffLoading: false, diffError: String(error.message).slice(0, 400), diffErrorCode: codeOf(error) }; this.publish(); return false;
    }
  }
  async reviewCommit() {
    if (this.pendingMutation || !this.projectId) return false;
    const epoch = this.epoch, draftRevision = this.draftRevision;
    if (!(await this.refresh({ loadDiff: false })) || epoch !== this.epoch || draftRevision !== this.draftRevision) return false;
    try {
      if (!gitCapabilities(this.state.status).commit) throw fault(this.state.status?.writeCapabilities?.reasonCode ?? 'gitLegacyReadOnly');
      const fields = gitCommitFields(this.state), files = this.state.status.files.filter(file => file.staged).map(file => ({ path: file.path, originalPath: file.originalPath ?? null }));
      if (!files.length) throw fault('gitNothingStaged');
      this.state = { ...this.state, review: { projectId: this.projectId, revision: this.state.status.revision, ...fields, files }, mutationError: null, mutationErrorCode: null }; this.publish(); return true;
    } catch (error) { this.state = { ...this.state, review: null, mutationError: error.message, mutationErrorCode: error.code }; this.publish(); return false; }
  }
  stage(entry) { return this._mutate('stage', { path: entry.path, revision: this.state.status?.revision }); }
  unstage(entry) { return this._mutate('unstage', { path: entry.path, revision: this.state.status?.revision }); }
  commitReviewed() {
    const review = this.state.review;
    if (!review || review.projectId !== this.projectId || review.revision !== this.state.status?.revision) return Promise.resolve(false);
    let fields; try { fields = gitCommitFields(this.state); } catch { return Promise.resolve(false); }
    if (['message', 'name', 'email'].some(key => fields[key] !== review[key])) return Promise.resolve(false);
    return this._mutate('commit', { message: review.message, name: review.name, email: review.email, revision: review.revision });
  }
  async _mutate(action, body) {
    if (this.pendingMutation || !this.projectId) return false;
    if (typeof this.mutateRequest !== 'function' || !gitCapabilities(this.state.status)[action]) {
      this.state = { ...this.state, mutationError: 'gitLegacyReadOnly', mutationErrorCode: this.state.status?.writeCapabilities?.reasonCode ?? 'gitLegacyReadOnly' }; this.publish(); return false;
    }
    const epoch = this.epoch, projectId = this.projectId, draftRevision = this.draftRevision, submittedDraft = { message: this.state.message, authorName: this.state.authorName, authorEmail: this.state.authorEmail }, mutation = { action, projectId };
    this.pendingMutation = mutation; this.statusAbort?.abort(); this.diffAbort?.abort(); ++this.statusSequence; ++this.diffSequence;
    this.state = { ...this.state, pending: action, loading: false, diffLoading: false, mutationError: null, mutationErrorCode: null, commitResult: null }; this.publish();
    try {
      // Writes are deliberately never retried, including ambiguous failures.
      const result = await this.mutateRequest(`projects/${encodeURIComponent(projectId)}/git/${action}`, body);
      if (!validStatus(result?.status) || typeof result.status.revision !== 'string' || !result.status.revision) throw fault('GIT_PROTOCOL');
      if (action === 'commit' && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(result.commit?.oid ?? '')) throw fault('GIT_PROTOCOL');
      if (action === 'commit') {
        const cached = this.drafts.get(projectId);
        if (cached && ['message','authorName','authorEmail'].every(key => cached[key] === submittedDraft[key])) this.drafts.delete(projectId);
        this.draftCoordinator?.clearMatching(projectId, submittedDraft);
      }
      if (epoch !== this.epoch) return false;
      ++this.statusSequence; this.statusAbort?.abort(); this._acceptStatus(result.status);
      this.state = { ...this.state, ...(action === 'commit' ? { ...(draftRevision === this.draftRevision ? { message: '', authorEdited: false } : {}), commitResult: result.commit } : {}) }; this._rememberDraft(); this.publish();
      if (this.state.selected) void this.loadDiff(this.state.selected); return true;
    } catch (error) {
      if (epoch !== this.epoch) return false;
      this.state = { ...this.state, review: null, mutationError: String(error.message).slice(0, 400), mutationErrorCode: codeOf(error) }; this.publish();
      // A read can reveal a stale index or an ambiguous commit. It never
      // authorizes resubmission and leaves the user's draft intact.
      await this.refresh({ loadDiff: false }); return false;
    } finally {
      if (this.pendingMutation === mutation) this.pendingMutation = null;
      this.state = { ...this.state, pending: null }; this.publish();
    }
  }
  dispose() { this.select(null); }
}
