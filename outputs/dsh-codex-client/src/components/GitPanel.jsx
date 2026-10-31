import React, { useEffect, useState } from 'react';
import { GitBranch, RefreshCw, FileText, Copy, LoaderCircle, Plus, Minus, GitCommitHorizontal, ArrowLeft } from 'lucide-react';
import { api } from '../api.js';
import { GitController, gitEntries, gitEntryKey, gitDisplayPath, diffPreview, gitCapabilities, gitErrorText, gitCommitFields } from '../lib/git-controller.js';
import {gitDraftCoordinator} from '../lib/git-draft-sync.js';
import './git-actions.css';

const read = (route, options) => api(route, undefined, 'GET', options);
const write = (route, body) => api(route, body);
export function GitPanel({ request = read, mutateRequest = write, draftCoordinator = gitDraftCoordinator, ...props }) {
  const [snapshot, setSnapshot] = useState({ projectId: null });
  const [controller] = useState(() => new GitController({ request, mutateRequest, draftCoordinator, onChange: setSnapshot }));
  useEffect(() => { controller.select(props.project?.id ?? null); if (props.project) void controller.refresh(); return () => controller.dispose(); }, [props.project?.id]);
  const current = snapshot.projectId === (props.project?.id ?? null) ? snapshot : { projectId: props.project?.id ?? null, loading: Boolean(props.project) };
  return <GitPanelView {...props} snapshot={current} controller={controller}/>;
}

export function GitPanelView({ project, snapshot, controller, t, locale, onCopy, onOpenFile, onResize, onResetWidth, onWidthKey }) {
  const { status, selected, diff, loading, diffLoading, error, errorCode, diffError, diffErrorCode, pending, mutationError, mutationErrorCode, review, message = '', authorName = '', authorEmail = '', commitResult, draftSync, draftReloadConfirm } = snapshot;
  const entries = gitEntries(status), staged = status?.files?.filter(file => file.staged) ?? [], preview = diffPreview(diff?.diff), number = value => new Intl.NumberFormat(locale).format(value);
  const capabilities = gitCapabilities(status), modern = Boolean(status?.writeCapabilities), busy = Boolean(pending), locked = busy || loading, draftLocked = locked || draftSync?.unavailable;
  let validDraft = true; try { gitCommitFields({ message, authorName, authorEmail }); } catch { validDraft = false; }
  const reason = gitErrorText(capabilities.reasonCode, t);
  return <aside className="document-panel git-panel" aria-busy={busy || loading}>
    <div className="resize-handle" role="separator" aria-label={t('resizeDocument')} aria-orientation="vertical" tabIndex={0} onPointerDown={onResize} onDoubleClick={onResetWidth} onKeyDown={onWidthKey}/>
    <header className="git-panel-heading"><div><GitBranch size={15}/><strong>{project?.name ?? t('gitReview')}</strong></div><button type="button" className="icon-button" aria-label={t('gitRefresh')} title={t('gitRefresh')} disabled={!project || locked} onClick={() => controller.refresh()}>{loading ? <LoaderCircle size={15} className="spinner"/> : <RefreshCw size={15}/>}</button></header>
    <div className="git-branch-caption"><span>{status ? status.branch ?? t(status.detached ? 'gitDetached' : 'gitUnborn') : t('gitLocalReview')}</span>{status?.upstream ? <small>{status.upstream} · {t('gitAheadBehind', { ahead: number(status.ahead), behind: number(status.behind) })}</small> : null}</div>
    {!project ? <p className="git-empty">{t('chooseProject')}</p> : null}
    {error ? <div className="git-error" role="alert"><span>{gitErrorText(errorCode, t)}</span><button type="button" className="subtle-button" disabled={locked} onClick={() => controller.refresh()}>{t('retry')}</button></div> : null}
    {mutationError ? <div className="git-error git-write-error" role="alert"><span>{gitErrorText(mutationErrorCode, t)} <small>{t('gitFailureKeptDraft')}</small></span><button type="button" className="subtle-button" disabled={locked} onClick={() => controller.refresh()}>{t('gitRefreshReview')}</button></div> : null}
    {draftSync?.errorCode ? <div className="git-error git-write-error" role="alert"><span>{gitErrorText(draftSync.errorCode,t)} <small>{t('gitDraftSaveFailed')}</small></span><button type="button" className="subtle-button" disabled={draftSync.saving||draftSync.loading} onClick={()=>controller.retryDraft()}>{t('retry')}</button>{draftSync.errorCode==='GIT_DRAFT_CHANGED'?<button type="button" className="subtle-button" onClick={()=>controller.confirmDraftReload()}>{t('gitDraftLoadStored')}</button>:null}</div> : draftSync ? <p className="git-write-progress" role="status">{t(draftSync.loading?'gitDraftRestoring':draftSync.saving||draftSync.dirty?'gitDraftSaving':draftSync.recovered?'gitDraftRestored':draftSync.value?'gitDraftSaved':'gitDraftAutoSave')}</p> : null}
    {draftReloadConfirm ? <div className="git-error" role="group" aria-label={t('gitDraftLoadStored')}><span>{t('gitDraftReplaceWarning')}</span><button type="button" className="subtle-button" onClick={()=>controller.confirmDraftReload(false)}>{t('cancel')}</button><button type="button" className="subtle-button" onClick={()=>controller.reloadDraft()}>{t('gitDraftReplaceConfirm')}</button></div> : null}
    {commitResult ? <p className="git-write-result" role="status">{t('gitCommitSucceeded', { oid: typeof commitResult.shortOid === 'string' ? commitResult.shortOid : commitResult.oid?.slice(0, 8) ?? '' })}</p> : null}
    {busy ? <p className="git-write-progress" role="status"><LoaderCircle size={13} className="spinner"/>{t(pending === 'commit' ? 'gitCommitting' : 'gitUpdatingIndex')}</p> : null}
    {loading && !status ? <div className="git-empty" role="status"><LoaderCircle size={15} className="spinner"/>{t('loading')}</div> : null}
    {status ? <>
      <div className="git-files" aria-label={t('gitChangedFiles')}>
        {['staged', 'working', 'untracked'].map(group => {
          const rows = entries.filter(entry => entry.group === group); if (!rows.length) return null;
          return <section key={group}><h3>{t('gitGroup_' + group)}<span>{number(rows.length)}</span></h3>{rows.map(entry => {
            const action = entry.staged ? 'unstage' : 'stage', label = t(entry.staged ? 'gitUnstageFile' : 'gitStageFile', { path: gitDisplayPath(entry.path) });
            return <div className="git-file-row" key={gitEntryKey(entry)}><button type="button" className={`git-file ${selected && gitEntryKey(selected) === gitEntryKey(entry) ? 'selected' : ''}`} disabled={locked} onClick={() => controller.loadDiff(entry)} title={entry.originalPath ? `${gitDisplayPath(entry.originalPath)} → ${gitDisplayPath(entry.path)}` : gitDisplayPath(entry.path)}><span className="git-file-status">{entry.conflicted ? 'U' : entry.untracked ? '?' : entry.staged ? entry.index : entry.workingTree}</span><span>{gitDisplayPath(entry.path)}</span>{entry.originalPath ? <small>{gitDisplayPath(entry.originalPath)}</small> : null}</button>{modern ? <button type="button" className="icon-button git-file-action" aria-label={label} title={capabilities[action] ? label : reason} disabled={locked || Boolean(review) || !capabilities[action]} onClick={() => controller[action](entry)}>{entry.staged ? <Minus size={14}/> : <Plus size={14}/>}</button> : null}</div>;
          })}</section>;
        })}
        {!entries.length && !loading ? <p className="git-empty">{t('gitClean')}</p> : null}
      </div>
      {modern ? <section className="git-commit-box" aria-label={t('gitCommitLocal')}>
        {review ? <div className="git-commit-review" role="group" aria-label={t('gitReviewCommit')}>
          <h3>{t('gitReviewCommit')}</h3><p>{t('gitStagedScope', { count: number(review.files.length) })}</p>
          <ul aria-label={t('gitStagedFiles')}>{review.files.map(file => <li key={file.path}>{file.originalPath ? <><span>{gitDisplayPath(file.originalPath)}</span><span aria-hidden="true"> → </span></> : null}<span>{gitDisplayPath(file.path)}</span></li>)}</ul>
          <dl><dt>{t('gitCommitIdentity')}</dt><dd>{review.name} &lt;{review.email}&gt;</dd><dt>{t('gitCommitMessage')}</dt><dd className="git-review-message">{review.message}</dd></dl>
          <p className="git-commit-disclosure">{t('gitStagedOnlyHelp')}</p>
          <p className="git-commit-disclosure">{t('gitCommitExecutionScope')}</p>
          <div className="git-commit-buttons"><button type="button" className="subtle-button" disabled={busy} onClick={() => controller.cancelReview()}><ArrowLeft size={13}/>{t('gitBackToEdit')}</button><button type="button" className="primary-button" disabled={locked || !capabilities.commit} onClick={() => controller.commitReviewed()}>{busy ? <LoaderCircle size={13} className="spinner"/> : <GitCommitHorizontal size={13}/>} {t('gitConfirmCommit')}</button></div>
        </div> : <form onSubmit={event => { event.preventDefault(); void controller.reviewCommit(); }}>
          <h3>{t('gitCommitLocal')}</h3>
          <label>{t('gitCommitMessage')}<textarea rows={2} maxLength={16000} value={message} disabled={draftLocked} placeholder={t('gitCommitMessagePlaceholder')} onChange={event => controller.setDraft({ message: event.target.value })}/></label>
          <div className="git-author-fields"><label>{t('gitAuthorName')}<input autoComplete="name" maxLength={160} value={authorName} disabled={draftLocked} onChange={event => controller.setDraft({ authorName: event.target.value })}/></label><label>{t('gitAuthorEmail')}<input type="email" autoComplete="email" maxLength={254} value={authorEmail} disabled={draftLocked} onChange={event => controller.setDraft({ authorEmail: event.target.value })}/></label></div>
          <p className="git-commit-disclosure">{t('gitIdentityOneCommit')}</p>
          {!capabilities.commit ? <p className="git-capability-reason" role="status">{reason}</p> : !staged.length ? <p className="git-capability-reason">{t('gitNothingStaged')}</p> : !validDraft ? <p className="git-capability-reason">{t('gitCommitDraftHelp')}</p> : null}
          <div className="git-commit-buttons"><small>{t('gitStagedCount', { count: number(staged.length) })}</small><button type="submit" className="subtle-button" disabled={locked || !capabilities.commit || !staged.length || !validDraft}><GitCommitHorizontal size={13}/>{t('gitReviewCommit')}</button></div>
        </form>}
      </section> : null}
      {selected ? <><div className="git-diff-heading"><span title={gitDisplayPath(selected.path)}>{gitDisplayPath(selected.path)}</span><button type="button" className="icon-button" aria-label={t('gitOpenFile')} title={t('gitOpenFile')} disabled={loading || selected.deleted || !onOpenFile} onClick={() => onOpenFile(selected.path)}><FileText size={14}/></button><button type="button" className="icon-button" aria-label={t('gitCopyDiff')} title={t('gitCopyDiff')} disabled={!diff?.diff || diffLoading || loading || !onCopy} onClick={() => onCopy(diff.diff)}><Copy size={14}/></button></div>
        {diffError ? <div className="git-error" role="alert"><span>{gitErrorText(diffErrorCode, t)}</span><button type="button" className="subtle-button" disabled={locked} onClick={() => controller.loadDiff(selected)}>{t('retry')}</button></div> : null}
        {diffLoading ? <div className="git-empty" role="status"><LoaderCircle size={15} className="spinner"/>{t('loading')}</div> : null}
        {diff && !diffLoading ? <>{preview.omitted > 0 ? <p className="git-preview-limit">{t('gitPreviewLimit', { count: number(preview.omitted) })}</p> : null}{diff.diff ? <pre className="git-diff" tabIndex={0} aria-label={t('gitDiff')}><code>{preview.lines.map((line, index) => <span key={index} className={line.startsWith('@@') ? 'git-hunk' : line.startsWith('+') && !line.startsWith('+++') ? 'git-added' : line.startsWith('-') && !line.startsWith('---') ? 'git-removed' : undefined}>{line}{'\n'}</span>)}</code></pre> : <p className="git-empty">{t('gitNoDiff')}</p>}</> : null}
      </> : null}
      <p className="git-readonly-note">{modern ? t('gitLocalActionsHelp') : t('gitLegacyReadOnly')}</p>
    </> : null}
  </aside>;
}
