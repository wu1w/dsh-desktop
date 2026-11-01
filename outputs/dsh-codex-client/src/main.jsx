import {ComputerControl} from './computer-panel.jsx';
import {SlashMenu,ProgramStatus} from './slash-menu.jsx';
import {parseSlash} from './lib/slash-commands.js';
import {cleanProgramText} from '../shared/session-programs.js';
import {SessionMenuItems} from './session-menu.jsx';
import {ChannelSessions,ChannelMark} from './channel-settings.jsx';
import './styles.css';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MessageCircle, LibraryBig, Clock3, Puzzle, Files, History, AtSign, MoreHorizontal, PanelLeft, PanelRight, Bell, Search, SquarePen, Folder, FolderOpen, Plus, ArrowLeft, ArrowRight, SlidersHorizontal, Maximize2, X, ChevronDown, ChevronRight, ArrowUp, Paperclip, Mic, ShieldAlert, Zap, Square, FileText, Copy, TerminalSquare, Pencil, Check, Settings, Archive, GitFork, GitBranch, Pin, Circle, LoaderCircle, ExternalLink, Code, Send } from 'lucide-react';
import { translator } from './i18n.js';
import { modKey, fmtKeys } from './platform.js';
import { api, apiImage, eventStream, initCapability } from './api.js';
import {Dropdown,MenuItem,MenuLabel,MenuDivider} from './menu.jsx';
import {ComposerControls} from './composer-controls.jsx';
import {SettingsContent} from './settings-content.jsx';
import {QueuedMessages} from './queued-messages.jsx';
import {FileReference} from './markdown.jsx';
import {TranscriptTimeline} from './transcript-timeline.jsx';
import {DocumentContent} from './components/DocumentContent.jsx';
import {FileBrowser} from './components/FileBrowser.jsx';
import {FilePreviewFallback} from './components/FilePreviewFallback.jsx';
import {readFilePreview,isReadOnlyPreview,isImagePreview} from './lib/file-preview.js';
import {ImagePreview} from './components/ImagePreview.jsx';
import {isComposing} from './lib/keyboard.js';
import {validLocation} from './lib/document-location.js';
import {AgentPanel} from './agent-panel.jsx';
import {DshLogo} from './brand.jsx';
import {DocumentSession} from './lib/document-session.js';
import {ClientDraftCache,flushClientDrafts,mergeInitialDrafts} from './lib/client-drafts.js';
import {RendererCloseGuard} from './lib/renderer-close-guard.js';
import {DocumentDraftSync,recoveredDocument,latestDocumentDraft} from './lib/document-draft-sync.js';
import {HistoryController} from './lib/history-controller.js';
import {historyForSelection,queueForSelection} from './lib/session-view.js';
import {StreamRecovery} from './lib/stream-recovery.js';
import {ReconnectController} from '../shell/reconnect.js';
import {runStatus,runStatusKey,canStopRun,canResumeRun} from './lib/run-status.js';
import {flushGitDrafts,subscribeGitDraftState} from './lib/git-draft-sync.js';
import {captureHistoryAnchor,restoreHistoryAnchor} from './lib/history-scroll.js';
import {HistoryControls} from './history-controls.jsx';
import {ApprovalController} from './lib/approval-controller.js';
import {ApprovalPanel} from './approval-panel.jsx';
import {GitPanel} from './components/GitPanel.jsx';
import {TerminalPanel} from './components/TerminalPanel.jsx';
import {AutomationsPanel} from './components/AutomationsPanel.jsx';
import {ResourceSpace} from './components/ResourceSpace.jsx';

function IconButton({ icon: Icon, label, onClick, className = '', disabled = false, children, ...props }) {
  return <button type="button" className={`icon-button ${className}`} title={label} aria-label={label} onClick={onClick} disabled={disabled} {...props}>{Icon ? <Icon size={17} strokeWidth={1.65} /> : children}</button>;
}
function Dialog({ title, onClose, children, className = '', closeLabel }) {
  const element = useRef(null);
  const closeRef=useRef(onClose);closeRef.current=onClose;
  useEffect(() => {
    const prior = document.activeElement;
    const dialog = element.current;
    dialog.showModal();
    dialog.querySelector('input:not(:disabled),textarea:not(:disabled),select:not(:disabled)')?.focus();
    const cancel = event => { event.preventDefault(); closeRef.current(); };
    dialog.addEventListener('cancel', cancel);
    return () => { dialog.removeEventListener('cancel', cancel); dialog.close(); prior?.focus(); };
  }, []);
  return <dialog ref={element} className={`dialog ${className}`} aria-label={title}><div className="dialog-heading"><h2>{title}</h2><IconButton icon={X} label={closeLabel??title} onClick={onClose}/></div>{children}</dialog>;
}
function readDocumentDraft(){try{const value=JSON.parse(localStorage.getItem('dsh-document-draft')??'null');return value&&typeof value.file?.content==='string'&&typeof value.file?.path==='string'&&typeof value.file?.projectId==='string'?value:null;}catch{return null;}}
function App({registerCleanup}) {
  const [locale, setLocale] = useState(localStorage.getItem('dsh-locale') ?? 'zh-CN');
  const [theme, setTheme] = useState(localStorage.getItem('dsh-theme') ?? 'light');
  const t = translator(locale);
  const [state, setState] = useState({ projects: [], sessions: [], engine: { state: 'stopped' } });
  const [booted, setBooted] = useState(false);
  const [selected, setSelected] = useState(null);
  const [projectId, setProjectId] = useState(null);
  const [historyController]=useState(()=>new HistoryController());
  const [historySnapshot,setHistorySnapshot]=useState(()=>historyController.snapshot());
  const historyScrollRestore=useRef(null);
  const queueRevision=useRef(0);
  const [queueSnapshot,setQueueSnapshot]=useState({sessionId:null,items:[]});
  const [submitting,setSubmitting]=useState(false);
  const submitLock=useRef(false);
  const [drafts, setDrafts] = useState(() => { try { return JSON.parse(localStorage.getItem('dsh-drafts') ?? '{}'); } catch { return {}; } });
  const [attachmentDrafts,setAttachmentDrafts]=useState(()=>{try{return JSON.parse(localStorage.getItem('dsh-attachment-drafts')??'{}');}catch{return {};}});
  const [uploading,setUploading]=useState(false);
  const [connection,setConnection]=useState('connecting');
  const [findOpen,setFindOpen]=useState(false),[findText,setFindText]=useState(''),[findResult,setFindResult]=useState(null);
  const findInput=useRef(null);
  const [chatDialog,setChatDialog]=useState(null);
  const [chatDialogValue,setChatDialogValue]=useState('');
  const [unsavedAction,setUnsavedAction]=useState(null);
  const [savingDocument,setSavingDocument]=useState(false);
  const [discardingDocument,setDiscardingDocument]=useState(false);
  const [modalPending,setModalPending]=useState(false);
  const [sidebar, setSidebar] = useState(true);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [archived, setArchived] = useState(false);
  const [documentRecovery]=useState(readDocumentDraft);
  const [documentSession]=useState(()=>new DocumentSession({file:documentRecovery?.file??null,dirty:Boolean(documentRecovery)}));
  const [documentFile,setDocumentFile]=useState(()=>documentSession.snapshot().file);
  const [documentEditing,setDocumentEditing]=useState(Boolean(documentRecovery));
  const [documentDirty,setDocumentDirty]=useState(Boolean(documentRecovery));
  const cancelUnsavedRef=useRef(null);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [settings, setSettings] = useState(false);
  const [settingTab, setSettingTab] = useState('general');
  const [addProject, setAddProject] = useState(false);
  const [pathInput, setPathInput] = useState('');
  const [projectName, setProjectName] = useState('');
  const [filePanel,setFilePanel]=useState(false),[filePicking,setFilePicking]=useState(false);
  const [engineMismatch,setEngineMismatch]=useState(false);
  const [fileList, setFileList] = useState([]);
  const [fileDirectory, setFileDirectory] = useState('');
  const [error, setError] = useState('');
  const [clientDraftCache]=useState(()=>new ClientDraftCache(localStorage,{onError:()=>setError(translator(renderRef.current?.locale??locale)('localDraftCacheFailed'))}));
  const [documentDraftSync]=useState(()=>new DocumentDraftSync({save:async body=>{const result=await api('document-drafts/save',body);clientDraftCache.acknowledgeDocument({file:body});return result;},clear:async body=>{const result=await api('document-drafts/clear',body);clientDraftCache.acknowledgeDocument(null);return result;},onError:(failure,operation)=>{if(operation?.kind==='clear'){const file=documentSession.snapshot().file;if(!file||file.projectId!==operation.projectId||file.path!==operation.path)return;}setError(failureMessage(failure));}}));
  const recoveryRequested=useRef(false);
  const [notice, setNotice] = useState('');
  const [sessionMenu, setSessionMenu] = useState(false);
  const [effort, setEffort] = useState('high');
  const [newModel,setNewModel]=useState('deepseek-v4.1-flash');
  useEffect(()=>{const available=state.models?.filter(m=>m.available!==false);if(available?.length&&!available.some(m=>m.id===newModel))setNewModel(available[0].id);},[state.models,newModel]);
  const [sidebarWidth,setSidebarWidth]=useState(240);
  const [documentWidth,setDocumentWidth]=useState(null);
  const [agentDialog,setAgentDialog]=useState(false);
  const [agentPanel,setAgentPanel]=useState(false),[rightTab,setRightTab]=useState('document');
  const [gitPanel,setGitPanel]=useState(false);
  const [agentName,setAgentName]=useState('');
  const [agentPrompt,setAgentPrompt]=useState('');
  const [permission, setPermission] = useState('read-only');
  const [approvalController]=useState(()=>new ApprovalController());
  const [approvalSnapshot,setApprovalSnapshot]=useState(()=>approvalController.snapshot());
  const [terminal, setTerminal] = useState(false);
  const [automationsOpen,setAutomationsOpen]=useState(false);
  const [navigation, setNavigation] = useState({ ids: [], index: -1 });
  const [gitDraftState,setGitDraftState]=useState({projects:[],pending:false,errorCode:null});
  const [documentLocation,setDocumentLocation]=useState(null);
  const documentLocationSequence=useRef(0);
  const [openingDocument,setOpeningDocument]=useState(null);
  const externalOpenLock=useRef(null);
  const [fileBrowsing,setFileBrowsing]=useState({projectId:null,loading:false,failure:null});
  const fileBrowseRequest=useRef(null);
  const attachmentSelectionSnapshot=useRef(attachmentDrafts);attachmentSelectionSnapshot.current=attachmentDrafts;
  const attachmentUploadLock=useRef(false);
  const uploadInput = useRef(null);
  const composerInput=useRef(null);
  const transcriptElement=useRef(null);
  const keepAtBottom=useRef(true);
  const initialBoot=useRef(false);
  const renderRef=useRef(null);
  const browseRevision=useRef(0);
  const projectRef=useRef(null);
  const bottom = useRef(null);
  const selectedRef = useRef(null);
  const navigationEpoch = useRef(0);
  const imageRequestCache=useRef(null);
  const transcriptActions=useRef(null);
  const [syncStatus,setSyncStatus]=useState('idle');
  const [recoveryAction,setRecoveryAction]=useState(null);
  const recoveryActionLock=useRef(false),streamRecoveryRef=useRef(null);
  const [resourceSpaceOpen,setResourceSpaceOpen]=useState(false);
  const current = state.sessions.find(s => s.id === selected);
  const historyView=historyForSelection(historySnapshot,selected,current?.running);
  const items=historyView.items,busy=canStopRun(current,historyView.running),transcriptLoading=historyView.loadingInitial&&items.length===0;
  const queue=queueForSelection(queueSnapshot,selected);
  function setQueue(items,sessionId){setQueueSnapshot({sessionId,items});}
  const isEngineMismatch=engineMismatch||Boolean(current&&(current.engineId??'codex')!==(state.selectedEngine??'codex'));
  const project = state.projects.find(p => p.id === (current ? current.projectId : projectId));
  if(projectRef.current!==(project?.id??null))navigationEpoch.current++;
  projectRef.current=project?.id??null;
  const draftId = selected ?? `new-${projectId ?? 'none'}`;
  const draft = drafts[draftId] ?? '';
  const attachments=attachmentDrafts[draftId]??[];
  function setAttachments(update){setAttachmentDrafts(old=>({...old,[draftId]:typeof update==='function'?update(old[draftId]??[]):update}));}
  const documentProject=state.projects.find(entry=>entry.id===documentFile?.projectId);
  renderRef.current={locale,theme,selected,projectId,drafts,attachmentDrafts,sidebarWidth,documentWidth,documentDirty,documentFile,busy};
  function preferencePayload(){const {locale,theme,selected,projectId,drafts,attachmentDrafts,sidebarWidth,documentWidth}=renderRef.current;return {locale,theme,selected,projectId,drafts,attachmentDrafts,sidebarWidth,documentWidth};}
  function failureMessage(failure){const t=translator(renderRef.current.locale);if(failure.code==='LOCAL_DRAFT_CACHE_FAILED')return t('localDraftCacheFailed');const localized=typeof failure.code==='string'?t(failure.code):null;return localized&&localized!==failure.code?localized:failure.message;}
  function syncDocument(){const next=documentSession.snapshot();setDocumentFile(next.file);setDocumentDirty(next.dirty);setSavingDocument(next.saving);}
  function publishApprovals(){setApprovalSnapshot(approvalController.snapshot());}
  function preserveLocalDrafts(){return clientDraftCache.persist(preferencePayload(),documentSession.recoveryDraft());}
  function cachePreference(key,value){try{localStorage.setItem(key,value);}catch{setError(translator(renderRef.current.locale)('localDraftCacheFailed'));}}
  async function flushDocumentRecovery({file,draft}){
    // flush retries the newest failed operation once, including a previous clear
    // that failed after the project file was already saved successfully.
    if(draft)await documentDraftSync.saveNow(draft.file).catch(()=>{});
    else if(file&&!isReadOnlyPreview(file))await documentDraftSync.clear(file).catch(()=>{});
    await documentDraftSync.flush();
  }
  async function flushDrafts({discardDocument=false}={}){
    const flushOrdinary=async()=>{if(!initialBoot.current){const failures=preserveLocalDrafts();if(documentSession.snapshot().dirty||failures.length)throw new Error(translator(renderRef.current.locale)('documentRecoveryUnavailable'));return;}await flushClientDrafts({storage:localStorage,cache:clientDraftCache,documentSession,preferences:preferencePayload(),persistPreferences:body=>api('preferences',body),persistDocumentRecovery:flushDocumentRecovery,discardDocument});};
    try{const results=await Promise.allSettled([flushGitDrafts(),flushOrdinary()]);const failed=results.find(result=>result.status==='rejected');if(failed)throw failed.reason;}
    catch(failure){const draft=documentSession.recoveryDraft();if(draft)documentDraftSync.scheduleSave(draft.file);setError(failureMessage(failure));throw failure;}
  }
  const featureEnabled=id=>Array.isArray(state.features)?state.features.includes(id):!(state.plugins??[]).some(plugin=>plugin.id===id&&!plugin.enabled);
  const followUpBehavior=state.engine.capabilities?.steer===false?'queue':state.preferences?.followUpBehavior??'queue';
  const chatEnabled=featureEnabled('feature-chat'),filesEnabled=featureEnabled('feature-files'),terminalEnabled=featureEnabled('feature-terminal'),integrationsEnabled=featureEnabled('feature-integrations'),projectsEnabled=featureEnabled('feature-projects'),gitEnabled=featureEnabled('feature-git'),automationsEnabled=featureEnabled('feature-automations');
  renderRef.current.filesEnabled=filesEnabled;
  renderRef.current.transcriptCopy=copyText;renderRef.current.transcriptOpen=openFile;
  if(!transcriptActions.current)transcriptActions.current={onCopy:value=>renderRef.current.transcriptCopy(value),onOpenFile:(relative,sourceProjectId,location)=>renderRef.current.transcriptOpen(relative,sourceProjectId,location)};
  const imagesEnabled=Array.isArray(state.features)?state.features.includes('feature-images'):(state.plugins??[]).some(plugin=>plugin.id==='feature-images'&&plugin.active);
  renderRef.current.imagesEnabled=imagesEnabled;
  const mcpFormsEnabled=Array.isArray(state.features)?state.features.includes('feature-mcp-forms'):(state.plugins??[]).some(plugin=>plugin.id==='feature-mcp-forms'&&plugin.active);
  renderRef.current.mcpFormsEnabled=mcpFormsEnabled;
  useEffect(()=>{approvalController.setElicitationEnabled(mcpFormsEnabled);publishApprovals();},[mcpFormsEnabled]);
  const imageIdentity=isImagePreview(documentFile)?JSON.stringify([documentFile.projectId,documentFile.path,documentFile.preview.version,documentFile.preview.mime,documentFile.preview.width,documentFile.preview.height,documentFile.preview.size]):null;
  if(imageRequestCache.current?.identity!==imageIdentity){const file=documentFile;imageRequestCache.current=imageIdentity?{identity:imageIdentity,load:signal=>apiImage(file.projectId,file.path,file.preview,{signal})}:null;}
  const fileBrowserVisible=filePanel&&filesEnabled&&fileBrowsing.projectId===project?.id;
  const sources = items.flatMap(item => Array.isArray(item.paths)?item.paths.filter(path=>typeof path==='string'):[]);
  const uniqueSources = [...new Set(sources)];

  const engineName=id=>t('engineName_'+String(id??'codex').replaceAll('-','_'));
  async function switchEngine(id){await act(async()=>{await api('engine/select',{id});const next=await refresh();if(!next.pendingEngine&&selectedRef.current)await loadTranscript(selectedRef.current);});}
  async function refresh() { const next = await api('state'); setState(next); return next; }
  function publishHistory(){setHistorySnapshot(historyController.snapshot());}
  async function loadTranscript(id,{signal}={}){
    if(selectedRef.current!==id)return;
    historyController.select(id);const token=historyController.beginInitial(),queueVersion=queueRevision.current;publishHistory();
    try{const response=await api(`sessions/${encodeURIComponent(id)}`,undefined,'GET',{signal});
      if(selectedRef.current!==id)return;
      if(signal?.aborted){if(historyController.cancelInitial(token,{error:signal.reason?.code==='STREAM_RECOVERY_TIMEOUT'?translator(renderRef.current.locale)('streamResyncFailed'):null}))publishHistory();return;}
      const anchor=token.rebuild?captureHistoryAnchor(transcriptElement.current):null;
      if(historyController.completeInitial(token,response)){if(token.rebuild)historyScrollRestore.current={anchor,sessionId:token.sessionId,epoch:token.epoch,missing:'start'};publishHistory();if(queueVersion===queueRevision.current)setQueue(response.queue??[],id);setEngineMismatch(Boolean(response.engineMismatch));}
    }catch(failure){if(selectedRef.current!==id)return;if(signal?.aborted){if(historyController.cancelInitial(token,{error:signal.reason?.code==='STREAM_RECOVERY_TIMEOUT'?translator(renderRef.current.locale)('streamResyncFailed'):null}))publishHistory();return;}if(historyController.failInitial(token,failure.message))publishHistory();throw failure;}
  }
  async function loadEarlierHistory(){
    if(historyController.sessionId!==selectedRef.current)return;
    const token=historyController.beginEarlier();if(!token)return;
    keepAtBottom.current=false;publishHistory();
    try{const response=await api(`sessions/${encodeURIComponent(token.sessionId)}/history?cursor=${encodeURIComponent(token.cursor)}`);
      if(selectedRef.current!==token.sessionId)return;
      const anchor=captureHistoryAnchor(transcriptElement.current);
      if(historyController.completeEarlier(token,response)){historyScrollRestore.current={anchor,sessionId:token.sessionId,epoch:token.epoch};publishHistory();if(historyController.reloadRequired)await loadTranscript(token.sessionId);}
    }catch(failure){if(selectedRef.current!==token.sessionId)return;if(historyController.failEarlier(token,failure.message,failure.code)){publishHistory();if(historyController.reloadRequired)await loadTranscript(token.sessionId).catch(()=>{});}}
  }
  function retryHistory(){if(historyController.retryTarget()==='earlier')loadEarlierHistory();else if(selectedRef.current)loadTranscript(selectedRef.current).catch(()=>{});}
  useEffect(() => {
    const recovery=new StreamRecovery({readState:signal=>api('state',undefined,'GET',{signal}),applyState:setState,getSelected:()=>selectedRef.current,refreshSelected:(id,signal)=>loadTranscript(id,{signal}),onRestored:details=>{const pending=[];window.dispatchEvent(new CustomEvent('dsh-stream-restored',{detail:{...details,waitUntil:operation=>pending.push(Promise.resolve(operation))}}));return Promise.all(pending);},onStatus:result=>setSyncStatus(result.status)});
    streamRecoveryRef.current=recovery;
    const reconnect=new ReconnectController({onStatus:setConnection,onError:()=>{if(!initialBoot.current)setError(translator(renderRef.current.locale)('streamConnectFailed'));},connect:async({signal,onOpen})=>{
      try {
        const boot = await initCapability({signal});
        if(signal.aborted)return;
        setState(boot.state);
        if(!initialBoot.current){initialBoot.current=true;
          const preferences = boot.state.preferences ?? {};
          if (preferences.locale) setLocale(preferences.locale);
          if (preferences.theme) setTheme(preferences.theme);
          if(preferences.drafts)setDrafts(local=>mergeInitialDrafts(preferences.drafts,local));
          if(preferences.attachmentDrafts)setAttachmentDrafts(local=>mergeInitialDrafts(preferences.attachmentDrafts,local));
          if (preferences.selected) setSelected(preferences.selected);
          if (Object.hasOwn(preferences,'projectId')) setProjectId(preferences.projectId);
          if(preferences.sidebarWidth)setSidebarWidth(preferences.sidebarWidth);
          if(preferences.documentWidth)setDocumentWidth(preferences.documentWidth);
          setBooted(true);
        }
        await eventStream(event => {
          if(signal.aborted)return;
          if(event.type==='state'){recovery.observeState();setState(event.state);}
          if(event.type==='session')window.dispatchEvent(new CustomEvent('dsh-session-event',{detail:event}));
          if(event.type==='session'&&event.sessionId===selectedRef.current){historyController.select(event.sessionId);historyController.applyLive(event.items,{running:event.running});publishHistory();}
          if(event.type==='queue'&&event.sessionId===selectedRef.current){queueRevision.current++;setQueue(event.queue,event.sessionId);}
          if(event.type==='approvals-sync'){approvalController.reconcile(event.requests);publishApprovals();}
          if(event.type==='approval'){approvalController.enqueue(event.request);publishApprovals();}
          if(event.type==='approval-resolved'){approvalController.resolve(event.id);publishApprovals();}
          if(event.type==='error')setError(event.message);
        },signal,{onOpen:()=>{if(signal.aborted)return;onOpen();void recovery.opened();}});
      }finally{recovery.stop();}
    }});
    const wake=()=>reconnect.wake();
    window.addEventListener?.('online',wake);
    reconnect.start();
    return()=>{reconnect.stop();recovery.stop();streamRecoveryRef.current=null;window.removeEventListener?.('online',wake);};
  }, []);
  useEffect(()=>{if(state.switchingEngine)return;setEngineMismatch(false);if(selected)loadTranscript(selected).catch(failure=>setError(failureMessage(failure)));},[state.selectedEngine,state.switchingEngine]);
  useEffect(()=>{if(state.engine.capabilities?.fullAccess===false&&permission==='danger-full-access'){setPermission('read-only');setNotice(t('permissionUnsupported'));}},[state.engine.capabilities?.fullAccess,permission]);
  useEffect(()=>{closeFileBrowser();setFileList([]);setFileDirectory('');setFileBrowsing({projectId:null,loading:false,failure:null});},[project?.id,filesEnabled]);
  useEffect(()=>{selectedRef.current=selected;historyController.select(selected);historyScrollRestore.current=null;queueRevision.current++;setQueue([],selected);setEngineMismatch(false);keepAtBottom.current=true;publishHistory();if(selected)loadTranscript(selected).catch(e=>{if(selectedRef.current===selected)setError(failureMessage(e));});},[selected]);
  useEffect(()=>{preserveLocalDrafts();},[drafts,attachmentDrafts]);
  useEffect(()=>{registerCleanup?.(flushDrafts);return()=>{fileBrowseRequest.current?.abort();fileBrowseRequest.current=null;++browseRevision.current;preserveLocalDrafts();documentDraftSync.dispose();approvalController.clear();};},[]);
  useEffect(()=>{const timer=setTimeout(()=>preserveLocalDrafts(),180);return()=>clearTimeout(timer);},[documentFile,documentDirty]);
  useEffect(()=>{if(booted&&filesEnabled){const draft=documentSession.recoveryDraft();if(draft)documentDraftSync.scheduleSave(draft.file);}},[booted,filesEnabled,documentFile,documentDirty]);
  useEffect(()=>{
    if(!booted||!filesEnabled||recoveryRequested.current)return;
    recoveryRequested.current=true;
    // Same-origin local recovery and any editor opened by the user take priority.
    if(documentSession.snapshot().file)return;
    const token=documentSession.beginOpen();let cancelled=false;
    (async()=>{
      const response=await api('document-drafts');
      let candidates=response.drafts??[];
      while(!cancelled){
        const draft=latestDocumentDraft(candidates,state.projects);if(!draft)return;
        candidates=candidates.filter(row=>row.projectId!==draft.projectId||row.path!==draft.path);
        const disk={...await readFilePreview(api,draft.projectId,draft.path,{images:renderRef.current.imagesEnabled}),projectId:draft.projectId};
        if(cancelled||!documentSession.isCurrentOpen(token))return;
        if(isReadOnlyPreview(disk)){setNotice(t('filePreviewRecoveryPreserved'));continue;}
        const recovered=recoveredDocument(disk,draft);
        // A crash between writing the file and clearing its backup can leave an
        // already-saved entry at the top. Continue to the newest unsaved one.
        if(recovered.stale){await documentDraftSync.clear(disk);continue;}
        if(documentSession.completeOpen(token,recovered.file,{dirty:recovered.dirty})){
          syncDocument();setRightTab('document');setDocumentEditing(recovered.dirty);
          if(recovered.dirty)setNotice(t('documentRecovered',{name:recovered.file.name}));
        }
        return;
      }
    })().catch(failure=>{if(!cancelled)setError(failureMessage(failure));});
    return()=>{cancelled=true;recoveryRequested.current=false;};
  },[booted,filesEnabled]);
  useEffect(()=>{const input=composerInput.current;if(input){input.style.height='auto';input.style.height=`${Math.min(200,Math.max(45,input.scrollHeight))}px`;}},[draftId,draft]);
  useEffect(() => { if (!booted) return; const body={locale,theme,selected,projectId,drafts,attachmentDrafts,sidebarWidth,documentWidth};const timer = setTimeout(() => api('preferences',body).then(()=>clientDraftCache.acknowledgePreferences(body)).catch(e=>setError(failureMessage(e))),500); return () => clearTimeout(timer); }, [booted,locale,theme,selected,projectId,drafts,attachmentDrafts,sidebarWidth,documentWidth]);
  useEffect(()=>{cachePreference('dsh-locale',locale);document.documentElement.lang=locale;window.dshDesktop?.setLocale?.(locale);},[locale]);
  useEffect(() => { cachePreference('dsh-theme', theme); const media = window.matchMedia('(prefers-color-scheme: dark)'); const update = () => { document.documentElement.dataset.theme = theme === 'system' ? media.matches ? 'dark' : 'light' : theme; }; update(); media.addEventListener('change',update); return () => media.removeEventListener('change',update); }, [theme]);
  useLayoutEffect(()=>{const pending=historyScrollRestore.current;if(!pending)return;historyScrollRestore.current=null;if(pending.sessionId===historyController.sessionId&&pending.epoch===historyController.epoch)restoreHistoryAnchor(transcriptElement.current,pending.anchor,{missing:pending.missing});},[items]);
  useEffect(()=>{if(keepAtBottom.current)bottom.current?.scrollIntoView({block:'end'});},[items,busy]);
  useEffect(()=>subscribeGitDraftState(setGitDraftState),[]);
  const gitDraftNeedsProtection=gitDraftState.needsProtection??gitDraftState.projects.some(row=>row.dirty||row.saving);
  useEffect(()=>{window.dshDesktop?.setCloseState?.({dirty:documentDirty,dirtyRevision:documentSession.revision,running:submitting||state.sessions.some(session=>session.running)});const warn=event=>{if((documentDirty||gitDraftNeedsProtection)&&!window.dshDesktop){event.preventDefault();event.returnValue='';}};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[documentDirty,documentFile,state.sessions,submitting,gitDraftNeedsProtection]);
  useEffect(()=>{
    if(!window.dshDesktop)return;
    const guard=new RendererCloseGuard({getRevision:()=>documentSession.revision,getElement:()=>document.querySelector('.app-shell'),flush:options=>flushDrafts(options),preserve:()=>{preserveLocalDrafts();const draft=documentSession.recoveryDraft();if(draft)documentDraftSync.scheduleSave(draft.file);},onError:failure=>setError(failure.code==='CLOSE_DOCUMENT_CHANGED'?translator(renderRef.current.locale)('documentChangedDuringClose'):failureMessage(failure)),report:body=>window.dshDesktop.completeClose(body)});
    const before=window.dshDesktop.onBeforeClose?.(message=>void guard.request(message).catch(()=>guard.release()));
    const after=window.dshDesktop.onTransitionEnded?.(()=>guard.release());
    return()=>{before?.();after?.();guard.release();};
  },[]);
  useEffect(()=>window.dshDesktop?.onFoundInPage?.(result=>setFindResult(result)),[]);
  useEffect(()=>{if(!findOpen)return;findInput.current?.focus();const timer=setTimeout(()=>{if(!findText){window.dshDesktop?.stopFind?.();setFindResult(null);return;}if(window.dshDesktop?.findText)window.dshDesktop.findText({text:findText,findNext:false});else{const found=window.find?.(findText,false,false,true);setFindResult({found});}},180);return()=>clearTimeout(timer);},[findOpen,findText]);
  function closeFind(){setFindOpen(false);window.dshDesktop?.stopFind?.();setFindResult(null);composerInput.current?.focus();}
  function nextFind(forward=true){if(!findText)return;if(window.dshDesktop?.findText)window.dshDesktop.findText({text:findText,forward,findNext:true});else setFindResult({found:window.find?.(findText,false,!forward,true)});}
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 2500); return () => clearTimeout(timer); }, [notice]);
  function interactionLocked(){return document.body?.inert===true||document.querySelector?.('.app-shell')?.inert===true;}
  useEffect(()=>{
    function menuAction(action){
      if(interactionLocked())return;
      if(action==='new-chat')newChat();
      else if(action==='open-project')requestProject();
      else if(action==='find-document'){setFindOpen(true);findInput.current?.focus();}
      else if(action==='find'||action==='search'){setSidebar(true);setSearching(true);}
      else if(action==='open-settings'||action==='settings')setSettings(true);
      else if(action==='open-about'){setSettingTab('about');setSettings(true);}
      else if(action==='open-shortcuts'){setSettingTab('shortcuts');setSettings(true);}
      else if(action==='toggle-sidebar')setSidebar(value=>!value);
      else if(action==='toggle-terminal'){if(terminalEnabled)setTerminal(value=>!value);else{setSettingTab('plugins');setSettings(true);}}
      else if(action==='toggle-document'){if(agentPanel&&rightTab==='agents')setAgentPanel(false);else documentFile?closeDocument():browseFiles();}
      else if(action==='save-document')saveDocument();
      else if(action==='focus-composer')composerInput.current?.focus();
      else if(action==='back')travel(-1);
      else if(action==='forward')travel(1);
      else if(action==='archive-chat')sessionAction(current?.archived?'restore':'archive');
      else if(action==='rename-chat')showChatDialog('rename');
      else if(action==='copy-chat')copyTranscript();
      else if(action==='close-panel'){
        const pendingApproval=approvalController.snapshot();if(pendingApproval.current&&(pendingApproval.isBlocking||document.activeElement?.closest('.approval-panel'))){answerApproval(pendingApproval.current.id,false,pendingApproval.current.method==='mcpServer/elicitation/request'?{elicitationAction:'cancel'}:undefined);return;}
        if(findOpen)closeFind();else if(automationsOpen)setAutomationsOpen(false);else if(settings)setSettings(false);else if(agentDialog)setAgentDialog(false);else if(addProject)setAddProject(false);else if(chatDialog)setChatDialog(null);else if(resourceSpaceOpen)setResourceSpaceOpen(false);else if(agentPanel&&rightTab==='agents')setAgentPanel(false);else if(documentFile)closeDocument();else if(fileBrowserVisible)closeFileBrowser();else if(terminal)setTerminal(false);else if(sourcesOpen)setSourcesOpen(false);else window.dshDesktop?.closeWindow?.();
      }
    }
    const handler=e=>{
      if(e.defaultPrevented||isComposing(e)||interactionLocked())return;
      const modifier=e.metaKey||e.ctrlKey,key=e.key.toLowerCase();
      const shortcuts={n:'new-chat',k:'find',f:'find-document',',':'open-settings',b:'toggle-sidebar','`':'toggle-terminal'};
      if(modifier&&e.shiftKey&&key==='o'){e.preventDefault();menuAction('open-project');}
      else if(modifier&&key==='s'&&documentFile){e.preventDefault();menuAction('save-document');}
      else if(modifier&&shortcuts[key]){e.preventDefault();menuAction(shortcuts[key]);}
      if(e.key==='Escape'){if(findOpen)closeFind();setSourcesOpen(false);setSessionMenu(false);}
    };
    const stop=window.dshDesktop?.onMenuAction?.(menuAction);
    window.addEventListener('keydown',handler);return()=>{window.removeEventListener('keydown',handler);stop?.();};
  });
  async function act(action) { setError(''); try { return await action(); } catch (failure) { setError(failureMessage(failure)); } }
  function navigate(id, record = true) {
    navigationEpoch.current++;selectedRef.current=id;setSelected(id);if(id){const target=state.sessions.find(session=>session.id===id);if(target)setProjectId(target.projectId);}setSessionMenu(false);
    if (record) setNavigation(prev => ({ ids: [...prev.ids.slice(0, prev.index + 1), id], index: prev.index + 1 }));
  }
  function newChat(id=null) { setProjectId(id); navigate(null); setArchived(false); setResourceSpaceOpen(false); }
  function travel(offset) { const index = navigation.index + offset; if (index < 0 || index >= navigation.ids.length) return; setNavigation(prev => ({ ...prev, index })); navigate(navigation.ids[index], false); }
  async function createProject(event) {
    event.preventDefault();
    await act(async () => { const created = await api('projects', { path: pathInput, name: projectName }); await refresh(); setProjectId(created.id); setAddProject(false); setPathInput(''); setProjectName(''); navigate(null); });
  }
  async function requestProject() {
    if(!projectsEnabled){setSettingTab('plugins');setSettings(true);return;}
    if (!window.dshDesktop) { setAddProject(true); return; }
    await act(async () => { const selectedPath = await window.dshDesktop.chooseFolder(); if (!selectedPath) return; const created = await api('projects',{path:selectedPath}); await refresh(); setProjectId(created.id); navigate(null); });
  }
  async function executeSlash(name,args=''){
    const owner=selected,draftOwner=draftId;
    if(name==='new'){setDrafts(old=>({...old,[draftOwner]:''}));newChat();return;}
    if(name==='computer'){window.dispatchEvent(new Event('dsh-open-computer'));setDrafts(old=>({...old,[draftOwner]:''}));return;}
    if(name==='stop'||name==='resume'){if(!owner){setError(t('slashNeedSession'));return;}if(name==='stop')await interruptTask(owner);else if(current?.program&&current.program.status!=='completed')await programAction('resume',owner);else await resumeTask(owner);}
    else{const tab={model:'models',engine:'engines',settings:'general'}[name]??name;setSettingTab(tab);setSettings(true);}
    setDrafts(old=>({...old,[draftOwner]:old[draftOwner]?.startsWith('/')?'':old[draftOwner]}));
  }
  async function programAction(action,id=selected){if(!id)return;await act(async()=>{await api(`sessions/${encodeURIComponent(id)}/program`,{action});await refresh();});}
  async function submit(event, invert=false) {
    event?.preventDefault();
    if(interactionLocked())return;
    const slash=parseSlash(draft);
    if(slash?.error||slash?.needsInput){setError(t(slash.error??'slashNeedObjective'));return;}
    if(slash?.action){if(!selected){setError(t('slashNeedSession'));return;}await programAction(slash.action);setDrafts(old=>({...old,[draftId]:''}));return;}
    if(slash&&!slash.program){await executeSlash(slash.name,slash.args);return;}
    if(slash?.program&&attachments.length){setError(t('slashNoAttachments'));return;}
    if(submitLock.current){setNotice(t('previousMessageSending'));return;}if(uploading||attachmentUploadLock.current||!booted||!chatEnabled||isEngineMismatch||['waiting','uncertain'].includes(current?.runRecovery?.status)||(!draft.trim()&&!attachments.length))return;
    const origin={selected,projectId:project?.id??null,draftId,epoch:navigationEpoch.current};
    let expectedSelected=origin.selected,expectedEpoch=origin.epoch,cleanupDraftId=origin.draftId;
    const ownsView=()=>selectedRef.current===expectedSelected&&navigationEpoch.current===expectedEpoch&&projectRef.current===origin.projectId;
    submitLock.current=true;setSubmitting(true);
    setError('');
    try {
      let sessionId = selected;
      if (!sessionId) {
        const session = await api('sessions', { projectId: origin.projectId, title: draft.trim().slice(0, 60) || t('emptyTitle'), model: newModel });
        sessionId = session.id;
        if(ownsView()){
          cleanupDraftId=sessionId;
          setDrafts(old=>{const next={...old,[sessionId]:old[origin.draftId]??''};delete next[origin.draftId];return next;});
          const promoted={...attachmentSelectionSnapshot.current,[sessionId]:attachmentSelectionSnapshot.current[origin.draftId]??[]};delete promoted[origin.draftId];attachmentSelectionSnapshot.current=promoted;
          setAttachmentDrafts(old=>{const next={...old,[sessionId]:old[origin.draftId]??[]};delete next[origin.draftId];return next;});
          const upload=attachmentUploadLock.current;
          if(upload&&upload.draftId===origin.draftId&&upload.projectId===origin.projectId&&upload.navigationEpoch===origin.epoch)upload.draftId=sessionId;
          navigate(sessionId);expectedSelected=sessionId;expectedEpoch=navigationEpoch.current;
        }
        await refresh();
      }
      const observation=historyController.sessionId===sessionId?{epoch:historyController.epoch,liveSequence:historyController.liveSequence}:null;
      await api(`sessions/${encodeURIComponent(sessionId)}/${slash?.program?'program':'turn'}`, slash?.program?{...slash.program,effort,permission}:{ text: draft, attachments, effort, permission, followUpBehavior:state.engine.capabilities?.steer===false?'queue':invert?(followUpBehavior==='steer'?'queue':'steer'):followUpBehavior });
      setDrafts(old=>({...old,[cleanupDraftId]:old[cleanupDraftId]===draft?'':old[cleanupDraftId]}));
      attachmentSelectionSnapshot.current={...attachmentSelectionSnapshot.current,[cleanupDraftId]:(attachmentSelectionSnapshot.current[cleanupDraftId]??[]).filter(file=>!attachments.some(sent=>sent.path===file.path))};
      setAttachmentDrafts(old=>({...old,[cleanupDraftId]:(old[cleanupDraftId]??[]).filter(file=>!attachments.some(sent=>sent.path===file.path))}));if(selectedRef.current===sessionId&&observation&&historyController.sessionId===sessionId&&historyController.epoch===observation.epoch&&historyController.liveSequence===observation.liveSequence){historyController.applyLive([],{running:true});publishHistory();}
      await loadTranscript(sessionId);
    } catch(failure) { if(ownsView())setError(failureMessage(failure)); }
    finally {submitLock.current=false;setSubmitting(false);}
  }
  async function recoveryTask(id,action){
    if(!id||recoveryActionLock.current)return;
    const owner=selectedRef.current,epoch=navigationEpoch.current;
    recoveryActionLock.current=true;setRecoveryAction(id);setError('');let acknowledged=false;
    try{await api(`sessions/${encodeURIComponent(id)}/${action}`,{});acknowledged=true;await refresh();if(selectedRef.current===id)await loadTranscript(id);}
    catch(failure){
      if(acknowledged){setSyncStatus('failed');void streamRecoveryRef.current?.opened();}
      else if(selectedRef.current===owner&&navigationEpoch.current===epoch)setError(failureMessage(failure));
    }
    finally{recoveryActionLock.current=false;setRecoveryAction(null);}
  }
  const resumeTask=id=>recoveryTask(id,'resume');
  const interruptTask=id=>recoveryTask(id,'interrupt');
  async function queueAction(action,body){
    if(!selected)return;const id=selected;setError('');
    try{await api(`sessions/${encodeURIComponent(id)}/queue/${action}`,body);const revision=queueRevision.current;const response=await api(`sessions/${encodeURIComponent(id)}/queue`);if(selectedRef.current===id&&revision===queueRevision.current){queueRevision.current++;setQueue(response.queue,id);}}
    catch(failure){if(selectedRef.current===id)setError(failureMessage(failure));const revision=queueRevision.current;const response=await api(`sessions/${encodeURIComponent(id)}/queue`).catch(()=>null);if(response&&selectedRef.current===id&&revision===queueRevision.current){queueRevision.current++;setQueue(response.queue,id);}throw failure;}
  }
  async function sessionAction(name,sourceId=selected) {
    const epoch=navigationEpoch.current;
    if (!sourceId) return;
    const ownsView=()=>selectedRef.current===sourceId&&navigationEpoch.current===epoch;
    setError('');
    try {
      let body = {};
      if(name==='rename'||name==='move'){showChatDialog(name,sourceId);return;}
      const response = await api(`sessions/${encodeURIComponent(sourceId)}/${name}`, body);
      await refresh();
      if(!ownsView())return;
      setSessionMenu(false);
      if (name === 'fork') navigate(response.id);
      if (name === 'archive'||name==='unread') navigate(null);
    } catch(failure) { if(ownsView())setError(failureMessage(failure)); }
  }
  function confirmDocumentChange(action){if(discardingDocument)return false;if(!documentSession.snapshot().dirty)return action();return new Promise(resolve=>{cancelUnsavedRef.current=()=>resolve(false);setUnsavedAction(()=>async()=>{cancelUnsavedRef.current=null;try{resolve(await action());}catch(failure){setError(failureMessage(failure));resolve(false);}});});}
  function cancelUnsaved(){cancelUnsavedRef.current?.();cancelUnsavedRef.current=null;setUnsavedAction(null);}
  async function beforePluginChange(plugin,action){if(action==='disable'&&['appearance-codex','feature-files'].includes(plugin.id)&&documentDirty){if(await confirmDocumentChange(()=>true)===false)return false;}await flushDrafts();return true;}
  function closeDocument(){confirmDocumentChange(()=>{documentSession.close();syncDocument();setDocumentEditing(false);});}
  async function discardDocumentChanges(){
    if(!unsavedAction||discardingDocument||savingDocument)return;
    setDiscardingDocument(true);
    try{
      await flushDrafts({discardDocument:true});
      const action=unsavedAction;setUnsavedAction(null);documentSession.close();syncDocument();setDocumentEditing(false);preserveLocalDrafts();await action();
    }catch(failure){preserveLocalDrafts();setError(failureMessage(failure));}
    finally{setDiscardingDocument(false);}
  }
  async function saveDocument(){
    if(isReadOnlyPreview(documentSession.snapshot().file)){setError(t('filePreviewNotEditable'));return false;}
    const operation=documentSession.beginSave();
    if(operation.status==='clean'){try{await documentDraftSync.flush();return true;}catch(failure){setError(failureMessage(failure));return false;}}
    if(operation.status==='busy')return false;
    const {token}=operation,file=token.file;syncDocument();
    try{
      await api(`projects/${file.projectId}/file`,{path:file.path,content:file.content,version:file.version});
      const saved={...await api(`projects/${file.projectId}/file?path=${encodeURIComponent(file.path)}`),projectId:file.projectId};
      const result=documentSession.completeSave(token,saved);syncDocument();
      if(result.conflict){setError(t('documentSaveConflict'));return false;}
      if(result.applied&&result.clean){setSavingDocument(true);preserveLocalDrafts();await documentDraftSync.clear(saved).catch(()=>{});await documentDraftSync.flush();}
      else if(result.applied){const draft=documentSession.recoveryDraft();if(draft)documentDraftSync.scheduleSave(draft.file);}
      if(projectRef.current===file.projectId)setFileList(old=>old.map(entry=>entry.path===saved.path?{...entry,size:new Blob([saved.content]).size}:entry));
      setNotice(t('fileSaved'));return Boolean(result.applied&&result.clean);
    }catch(failure){documentSession.failSave(token);setError(failureMessage(failure));return false;}
    finally{syncDocument();}
  }
  async function openFile(relative,sourceProjectId=project?.id,location){
    if(!sourceProjectId||!filesEnabled)return false;
    if(location&&!validLocation(location)){setError(t('docLocationInvalid'));return false;}
    const locate=file=>setDocumentLocation(location?{...location,projectId:file.projectId,path:file.path,request:++documentLocationSequence.current}:null);
    const existing=documentSession.snapshot();
    // A citation into the current editor must use its unsaved buffer. It also
    // supersedes any pending request to open another document.
    if(!isReadOnlyPreview(existing.file)&&existing.file?.projectId===sourceProjectId&&existing.file.path===relative&&(existing.dirty||location)){
      documentSession.beginOpen();locate(existing.file);setRightTab('document');if(location)setDocumentEditing(true);return true;
    }
    return confirmDocumentChange(async()=>{const token=documentSession.beginOpen(),currentOpen=()=>renderRef.current.filesEnabled&&documentSession.isCurrentOpen(token);setError('');try{
      const [file,recovery]=await Promise.all([readFilePreview(api,sourceProjectId,relative,{images:renderRef.current.imagesEnabled}),api(`document-drafts?projectId=${encodeURIComponent(sourceProjectId)}&path=${encodeURIComponent(relative)}`).catch(failure=>{if(currentOpen())setError(failureMessage(failure));return {draft:null};})]);
      const fallback=isReadOnlyPreview(file),recovered=fallback?{file:{...file,projectId:sourceProjectId},dirty:false,stale:false}:recoveredDocument({...file,projectId:sourceProjectId},recovery.draft);
      if(!renderRef.current.filesEnabled||!documentSession.completeOpen(token,recovered.file,{dirty:recovered.dirty}))return false;
      const generation=documentSession.generation;
      syncDocument();if(fallback)setDocumentLocation(null);else locate(recovered.file);setRightTab('document');setDocumentEditing(!fallback&&(recovered.dirty||Boolean(location)));if(fallback&&recovery.draft)setNotice(t('filePreviewRecoveryPreserved'));else if(recovered.dirty)setNotice(t('documentRecovered',{name:recovered.file.name}));if(recovered.stale)await documentDraftSync.clear(recovered.file).catch(failure=>{if(renderRef.current.filesEnabled&&token.request===documentSession.openSequence&&generation===documentSession.generation)setError(failureMessage(failure));});return true;
    }catch(failure){if(currentOpen())setError(failureMessage(failure));return false;}});
  }
  function openDocumentExternally(){return openProjectFileExternally(documentSession.snapshot().file);}
  async function openProjectFileExternally(file){
    if(externalOpenLock.current||savingDocument||discardingDocument||!filesEnabled)return false;
    if(!file)return false;
    const token={projectId:file.projectId,path:file.path,name:file.name};
    externalOpenLock.current=token;setOpeningDocument(token);setError('');
    const action=async()=>{
      const response=await api(`projects/${encodeURIComponent(token.projectId)}/open`,{path:token.path});
      if(response.accepted!==true)throw Object.assign(new Error('docOpenUnconfirmed'),{code:'docOpenUnconfirmed'});
      setNotice(translator(renderRef.current.locale)('docOpenAccepted',{name:token.name}));return true;
    };
    try{const current=documentSession.snapshot().file;return await(current?.projectId===token.projectId&&current.path===token.path?confirmDocumentChange(action):action());}catch(failure){setError(failureMessage(failure));return false;}
    finally{if(externalOpenLock.current===token){externalOpenLock.current=null;setOpeningDocument(null);}}
  }
  async function copyText(value){try{await navigator.clipboard.writeText(value);setNotice(t('copied'));}catch{setError(t('copyFailed'));}}
  function copyTranscript(){copyText(items.filter(item=>item.type==='userMessage'||item.type==='agentMessage').map(item=>`${t(item.type==='userMessage'?'user':'assistant')}\n${cleanProgramText(item.text??'')}`).join('\n\n'));}
  function showChatDialog(action,id=selected){const target=state.sessions.find(row=>row.id===id);if(!target)return;setChatDialog({action,sessionId:target.id});setChatDialogValue(action==='rename'?target.title:(target.projectId??''));}
  async function submitChatDialog(event){event.preventDefault();if(!chatDialog)return;setModalPending(true);await act(async()=>{await api(`sessions/${chatDialog.sessionId}/${chatDialog.action}`,chatDialog.action==='rename'?{title:chatDialogValue}:{projectId:chatDialogValue||null});await refresh();setChatDialog(null);});setModalPending(false);}

  function closeFileBrowser(){fileBrowseRequest.current?.abort();fileBrowseRequest.current=null;++browseRevision.current;setFilePanel(false);setFileBrowsing(old=>({...old,loading:false}));}
  async function browseFiles(relative='',picking=false) {
    if(!filesEnabled){setSettingTab('plugins');setSettings(true);return;}
    if (!project) { setAddProject(true); return; }
    fileBrowseRequest.current?.abort();const controller=new AbortController();fileBrowseRequest.current=controller;
    const targetProject=project.id,revision=++browseRevision.current,current=()=>revision===browseRevision.current&&projectRef.current===targetProject&&renderRef.current.filesEnabled;
    setFileList([]);setFileDirectory(relative);setFilePicking(picking);setFilePanel(true);setFileBrowsing({projectId:targetProject,loading:true,failure:null});
    try{const files=await api(`projects/${encodeURIComponent(targetProject)}/files?path=${encodeURIComponent(relative)}`,undefined,'GET',{signal:controller.signal});if(current()){if(!Array.isArray(files?.entries))throw Object.assign(new Error('fileBrowserLoadFailed'),{code:'fileBrowserLoadFailed'});setFileList(files.entries);setFileBrowsing({projectId:targetProject,loading:false,failure:null});return true;}return false;}
    catch(failure){if(current()&&!controller.signal.aborted)setFileBrowsing({projectId:targetProject,loading:false,failure});return false;}
    finally{if(fileBrowseRequest.current===controller)fileBrowseRequest.current=null;}
  }
  function attachProjectFile(file){
    if(uploading||attachmentUploadLock.current){setError(t('attachmentsUploading'));return false;}
    if(!file||typeof file.name!=='string'||!file.name||file.name.includes('\0')||file.name.length>256||typeof file.path!=='string'||!file.path||file.path.includes('\0')||file.path.startsWith('/')||file.path.split('/').includes('..')||new TextEncoder().encode(file.path).length>4096){setError(t('fileAttachmentInvalid'));return false;}
    const current=attachmentSelectionSnapshot.current[draftId]??[];
    if(!current.some(entry=>entry.path===file.path)&&current.length>=50){setError(t('fileAttachmentLimit',{count:new Intl.NumberFormat(locale).format(50)}));return false;}
    const extension=file.name.split('.').pop().toLowerCase(),mime={png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif'}[extension]??'';
    const next=current.some(entry=>entry.path===file.path)?current:[...current,{path:file.path,name:file.name,mime}];attachmentSelectionSnapshot.current={...attachmentSelectionSnapshot.current,[draftId]:next};setAttachments(()=>next);closeFileBrowser();composerInput.current?.focus();return true;
  }
  async function prepareComputerSession(){
    if(selected)return selected;
    const origin={epoch:navigationEpoch.current,projectId:project?.id??null,draftId};
    const created=await api('sessions',{projectId:origin.projectId,title:draft.trim().slice(0,60)||t('computerTitle'),model:newModel});
    if(navigationEpoch.current!==origin.epoch||selectedRef.current||projectRef.current!==origin.projectId){await refresh();return null;}
    setDrafts(old=>{const next={...old,[created.id]:old[origin.draftId]??''};delete next[origin.draftId];return next;});
    const attached=attachmentSelectionSnapshot.current[origin.draftId]??[];attachmentSelectionSnapshot.current={...attachmentSelectionSnapshot.current,[created.id]:attached};setAttachmentDrafts(old=>{const next={...old,[created.id]:attached};delete next[origin.draftId];return next;});
    navigate(created.id);await refresh();return created.id;
  }
  async function uploadFiles(event) {
    const files = [...event.target.files];
    event.target.value = '';
    if(uploading||attachmentUploadLock.current)return false;
    if(!files.length)return false;
    if((attachmentSelectionSnapshot.current[draftId]??[]).length+files.length>50){setError(t('fileAttachmentLimit',{count:new Intl.NumberFormat(locale).format(50)}));return false;}
    if(files.length>20){setError(t('fileUploadBatchLimit',{count:new Intl.NumberFormat(locale).format(20)}));return false;}
    if (files.reduce((sum, file) => sum + file.size, 0) > 10 * 1024 * 1024) { setError(t('attachLimit')); return; }
    const targetProject=project?.id??null,uploadToken={projectId:project?.id??null,draftId,navigationEpoch:navigationEpoch.current},sourceSession=selected;attachmentUploadLock.current=uploadToken;setUploading(true);
    try{return await act(async () => {
      let targetSession=sourceSession;
      if(!targetProject&&!targetSession){
        const created=await api('sessions',{projectId:null,title:draft.trim().slice(0,60)||files[0].name,model:newModel});targetSession=created.id;
        const owned=selectedRef.current===sourceSession&&navigationEpoch.current===uploadToken.navigationEpoch&&projectRef.current===null;
        if(owned){setDrafts(old=>{const next={...old,[created.id]:old[uploadToken.draftId]??''};delete next[uploadToken.draftId];return next;});navigate(created.id);}
        uploadToken.draftId=created.id;await refresh();
      }
      const encoded = await Promise.all(files.map(async file => ({ name: file.name, mime: file.type, data: await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = reject; reader.readAsDataURL(file); }) })));
      const response=await api(targetProject?`projects/${targetProject}/attachments`:`sessions/${targetSession}/attachments`,{files:encoded});
      const targetDraft=uploadToken.draftId;
      const existing=attachmentSelectionSnapshot.current[targetDraft]??[];
      if(existing.length+response.files.length>50)throw new Error(t('fileAttachmentLimit',{count:new Intl.NumberFormat(locale).format(50)}));
      const next=[...existing,...response.files];attachmentSelectionSnapshot.current={...attachmentSelectionSnapshot.current,[targetDraft]:next};
      setAttachmentDrafts(old=>({...old,[targetDraft]:next}));return true;
    });}finally{if(attachmentUploadLock.current===uploadToken){attachmentUploadLock.current=false;setUploading(false);}}
  }
  async function answerApproval(id,allow,options) {
    if(interactionLocked())return;
    approvalController.setElicitationEnabled(renderRef.current.mcpFormsEnabled);
    const token=approvalController.beginSubmit(id,allow,options);if(!token)return;publishApprovals();
    try{await api(`approvals/${encodeURIComponent(token.id)}`,token.body);approvalController.complete(token);}
    catch(failure){if(failure.code==='APPROVAL_NOT_FOUND'){approvalController.resolve(token.id);setNotice(failureMessage(failure));}else approvalController.fail(token,failureMessage(failure));}
    publishApprovals();
  }
  function resize(event,kind){
    event.preventDefault();document.body.classList.add('resize-dragging');
    const move=pointer=>{if(kind==='sidebar')setSidebarWidth(Math.max(190,Math.min(400,pointer.clientX-51)));else setDocumentWidth(Math.max(320,Math.min(window.innerWidth-sidebarWidth-410,window.innerWidth-pointer.clientX)));};
    const finish=()=>{document.body.classList.remove('resize-dragging');window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',finish);window.removeEventListener('pointercancel',finish);};
    window.addEventListener('pointermove',move);window.addEventListener('pointerup',finish,{once:true});window.addEventListener('pointercancel',finish,{once:true});
  }
  async function createAgent(event){
    event.preventDefault();if(!project){requestProject();return;}if(modalPending)return;setModalPending(true);
    await act(async()=>{const session=await api('sessions',{projectId:project.id,parentSessionId:selected,kind:'agent',model:current?.model??newModel,title:agentName.trim()||agentPrompt.trim().slice(0,60)});await api(`sessions/${session.id}/turn`,{text:agentPrompt,attachments:[],effort,permission});await refresh();setAgentPrompt('');setAgentName('');setAgentDialog(false);});setModalPending(false);
  }
  const visibleSessions = state.sessions.filter(s => Boolean(s.archived) === archived && (!query || (s.title??'').toLocaleLowerCase(locale).includes(query.toLocaleLowerCase(locale))));
  const previewTabs=[documentFile&&filesEnabled?'document':null,agentPanel&&chatEnabled?'agents':null,gitPanel&&gitEnabled?'git':null].filter(Boolean);
  const rightPanelOpen=previewTabs.length>0;
  const visibleRightTab=previewTabs.includes(rightTab)?rightTab:previewTabs[0]??'document';
  function openAgents(){setAgentPanel(true);setRightTab('agents');}
  function openGit(){if(!project){requestProject();return;}setGitPanel(true);setRightTab('git');}
  const renderSession = session => <Dropdown key={session.id} contextTrigger className="session-context" label={t('sessionMenu')} trigger={<button key={session.id} className={`session-row ${session.id === selected ? 'selected' : ''} ${session.unread?'unread':''}`} aria-current={session.id===selected?'page':undefined} onClick={() => navigate(session.id)} title={session.title}>{session.pinned ? <Pin size={12}/> : null}<span>{session.title || t('emptyTitle')}</span>{session.channel?.chatType!=='dm'&&session.channel?<small className="im-kind">{t('channelGroup')}</small>:null}{session.running ? <span className="session-running"/> : null}</button>}>{close=><SessionMenuItems session={session} state={state} t={t} onAction={action=>{close();if(action==='copyTitle')copyText(session.title);else sessionAction(action,session.id);}}/>}</Dropdown>;
  return <div style={{'--sidebar-width':`${sidebarWidth}px`,...(documentWidth?{'--document-width':`${documentWidth}px`}:{})}} className={`app-shell ${sidebar ? '' : 'sidebar-hidden'} ${rightPanelOpen&&!resourceSpaceOpen?'has-document':''} ${rightPanelOpen&&!resourceSpaceOpen&&visibleRightTab==='agents'?'agent-preview-layout':''} ${resourceSpaceOpen?'library-active':''} ${sourcesOpen ? 'has-sources' : ''}`}>
    <header className="titlebar">
      <div className="window-controls" aria-hidden="true"><i/><i/><i/></div>
      <div className="navigation-controls"><IconButton icon={ArrowLeft} label={t('back')} onClick={() => resourceSpaceOpen?setResourceSpaceOpen(false):travel(-1)} disabled={!resourceSpaceOpen&&navigation.index <= 0}/><IconButton icon={ArrowRight} label={t('forward')} onClick={() => travel(1)} disabled={resourceSpaceOpen||navigation.index >= navigation.ids.length - 1}/><IconButton icon={PanelLeft} label={t(sidebar ? 'collapse' : 'expand')} onClick={() => setSidebar(!sidebar)}/></div>
      <div className="window-title">{!resourceSpaceOpen&&current?.channel?<ChannelMark platform={current.channel.platform} t={t}/>:null}{resourceSpaceOpen?t('resourceSpace'):current?.title ?? t('newChat')}</div>
      <div className="title-actions"><Dropdown label={t('sessionMenu')} disabled={!selected} align="right" trigger={<MoreHorizontal size={17}/>}>
        {close=><><MenuItem icon={Pencil} label={t('rename')} onClick={()=>{close();showChatDialog('rename');}}/><MenuItem icon={Pin} label={t(current?.pinned?'unpin':'pin')} onClick={()=>{close();sessionAction('pin');}}/><MenuItem icon={Folder} label={t('move')} disabled={busy||isEngineMismatch||state.engine.capabilities?.move===false||!state.projects.length} onClick={()=>{close();showChatDialog('move');}}/><MenuItem icon={GitFork} label={t('fork')} disabled={isEngineMismatch||busy||state.engine.capabilities?.fork===false} onClick={()=>{close();sessionAction('fork');}}/><MenuItem icon={Copy} label={t('copyChat')} disabled={!items.length} onClick={()=>{close();copyTranscript();}}/><MenuDivider/>{busy?<MenuItem icon={Square} label={t('stop')} onClick={()=>{close();interruptTask(selected);}}/>:null}<MenuItem icon={Archive} label={t(current?.archived?'restore':'archive')} disabled={busy} onClick={()=>{close();sessionAction(current?.archived?'restore':'archive');}}/></>}
      </Dropdown><IconButton icon={GitBranch} label={t('gitReview')} disabled={!gitEnabled} aria-pressed={gitPanel&&visibleRightTab==='git'} className={gitPanel&&visibleRightTab==='git'?'active':''} onClick={()=>gitPanel&&visibleRightTab==='git'?setGitPanel(false):openGit()}/><IconButton icon={SlidersHorizontal} label={t('details')} onClick={() => setSourcesOpen(!sourcesOpen)} aria-pressed={sourcesOpen} className={sourcesOpen ? 'active' : ''}/></div>
      {rightPanelOpen?<div className="workspace-tabs" role="tablist" aria-label={t('previewPanels')}>{documentFile&&filesEnabled?<div className={`workspace-tab ${visibleRightTab==='document'?'selected':''}`}><button role="tab" aria-selected={visibleRightTab==='document'} onClick={()=>setRightTab('document')}><FileText size={14}/><span>{documentFile.name}{documentDirty?' •':''}</span></button><IconButton icon={X} label={t('closeDocument')} onClick={closeDocument}/></div>:null}{agentPanel&&chatEnabled?<div className={`workspace-tab ${visibleRightTab==='agents'?'selected':''}`}><button role="tab" aria-selected={visibleRightTab==='agents'} onClick={()=>setRightTab('agents')}><AtSign size={14}/><span>{t('subagents')}</span></button><IconButton icon={X} label={t('closeAgents')} onClick={()=>setAgentPanel(false)}/></div>:null}{gitPanel&&gitEnabled?<div className={`workspace-tab ${visibleRightTab==='git'?'selected':''}`}><button role="tab" aria-selected={visibleRightTab==='git'} onClick={()=>setRightTab('git')}><GitBranch size={14}/><span>{t('gitReview')}</span></button><IconButton icon={X} label={t('gitClose')} onClick={()=>setGitPanel(false)}/></div>:null}<Dropdown label={t('addPreview')} className="preview-add-menu" align="right" trigger={<Plus size={17}/>}>
        {close=><><MenuItem icon={FileText} label={t('openFile')} onClick={()=>{close();browseFiles();}}/><MenuItem icon={AtSign} label={t('subagents')} onClick={()=>{close();openAgents();}}/><MenuItem icon={GitBranch} label={t('gitReview')} disabled={!gitEnabled} onClick={()=>{close();openGit();}}/></>}
      </Dropdown></div>:null}
      <div className="window-actions"><IconButton icon={Maximize2} label={t('fullScreen')} onClick={() => window.dshDesktop ? window.dshDesktop.fullscreen() : document.documentElement.requestFullscreen?.()}/><IconButton icon={PanelRight} label={t('split')} onClick={()=>rightPanelOpen?visibleRightTab==='git'?setGitPanel(false):visibleRightTab==='agents'?setAgentPanel(false):closeDocument():browseFiles()}/></div>
    </header>
    <nav className="activity-rail" aria-label={t('sidebarMenu')}>
      <div className="rail-top">
        <IconButton icon={LibraryBig} label={t('resourceSpace')} aria-pressed={resourceSpaceOpen} className={resourceSpaceOpen?'active':''} onClick={()=>setResourceSpaceOpen(value=>!value)}/>
        <IconButton icon={Clock3} label={t('scheduledTasks')} aria-haspopup="dialog" aria-expanded={automationsOpen} className={automationsOpen?'active':''} onClick={()=>{if(automationsEnabled)setAutomationsOpen(true);else{setSettingTab('plugins');setSettings(true);}}}/>
        <IconButton icon={Puzzle} label={t('plugins')} aria-haspopup="dialog" aria-expanded={settings&&settingTab==='plugins'} className={settings&&settingTab==='plugins'?'active':''} onClick={()=>{setSettingTab('plugins');setSettings(true);}}/>
      </div>
      <button className="profile-button" aria-label={t('settings')} title={t('settings')} onClick={() => setSettings(true)}><DshLogo/></button>
    </nav>
    <aside className="project-sidebar"><div className="resize-handle" role="separator" aria-label={t('resizeSidebar')} aria-orientation="vertical" tabIndex={0} onPointerDown={event=>resize(event,'sidebar')} onDoubleClick={()=>setSidebarWidth(240)} onKeyDown={event=>{if(['ArrowLeft','ArrowRight'].includes(event.key)){event.preventDefault();setSidebarWidth(width=>Math.max(190,Math.min(400,width+(event.key==='ArrowRight'?20:-20))));}}}/>
      <div className="sidebar-heading"><Dropdown label={t('app')} className="brand-dropdown" trigger={<><span className="dsh-wordmark">DSH</span><ChevronDown size={12}/></>}>{close=><><MenuLabel>{t('engineLabel')}</MenuLabel>{['dsh-native','codex','claude-code'].map(id=><MenuItem key={id} icon={id==='dsh-native'?Zap:id==='codex'?Code:TerminalSquare} label={engineName(id)} detail={t('engineDetail_'+id.replaceAll('-','_'))} checked={(state.selectedEngine??'codex')===id} disabled={state.switchingEngine||!(state.engineProviders??[]).some(p=>p.id===id)} onClick={()=>{close();switchEngine(id);}}/>)}<div className="engine-menu-hint">{t('engineMenuHint')}</div><MenuDivider/><MenuItem icon={SquarePen} label={t('newChat')} shortcut={`${modKey} N`} onClick={()=>{close();newChat();}}/><MenuItem icon={Archive} label={t(archived?'recent':'archived')} onClick={()=>{close();setArchived(!archived);closeFileBrowser();}}/><MenuItem icon={AtSign} label={t('subagents')} disabled={!chatEnabled} onClick={()=>{close();openAgents();}}/><MenuDivider/><MenuItem icon={Settings} label={t('settings')} shortcut={`${modKey} ,`} onClick={()=>{close();setSettings(true);}}/><MenuItem icon={ExternalLink} label={t('openOfficial')} onClick={()=>{close();act(()=>api('system/openCodex',{}));}}/><MenuDivider/><MenuItem label={t('about')} onClick={()=>{close();setSettingTab('about');setSettings(true);}}/></>}</Dropdown><Dropdown label={t('notifications')} align="right" trigger={<span className="icon-button"><Bell size={17}/>{state.notifications?.length?<i className="notification-dot"/>:null}</span>}>{close=><div className="notification-menu"><MenuLabel>{t('notifications')}</MenuLabel>{state.notifications?.length?state.notifications.map(entry=><button role="menuitem" className="notification-entry" key={entry.id} onClick={()=>{close();navigate(entry.sessionId);}}>{entry.title}<small>{t(entry.status)} · {new Intl.DateTimeFormat(locale,{hour:'2-digit',minute:'2-digit'}).format(new Date(entry.createdAt))}</small></button>):<MenuLabel>{t('noNotifications')}</MenuLabel>}{state.notifications?.length?<><MenuDivider/><MenuItem label={t('clearNotifications')} onClick={()=>{act(()=>api('notifications',{}));close();}}/></>:null}</div>}</Dropdown><IconButton icon={Search} label={t('search')} onClick={() => setSearching(!searching)}/></div>
      <button className="new-chat" onClick={() => newChat()}><SquarePen size={16}/><span>{t('newChat')}</span></button>
      {searching ? <div className="sidebar-search"><Search size={14}/><input aria-label={t('search')} autoFocus value={query} onChange={e => setQuery(e.target.value)} placeholder={t('search')}/><IconButton icon={X} label={t('clearSearch')} onClick={() => { setSearching(false); setQuery(''); }}/></div> : null}
      <div className="project-list">
        {visibleSessions.filter(s => s.pinned&&!s.channel).length ? <section className="workspace-group"><div className="workspace-title"><Pin size={15}/>{t('pinned')}</div>{visibleSessions.filter(s => s.pinned&&!s.channel).map(renderSession)}</section> : null}
        <section className="workspace-group casual-group" aria-label={t('casualChats')}><div className={`workspace-title ${!project?'current':''}`}><button onClick={()=>newChat()}><MessageCircle size={16}/><span>{t('casualChats')}</span></button><IconButton icon={SquarePen} label={t('newCasualChat')} onClick={()=>newChat()}/></div>{visibleSessions.filter(s=>s.projectId===null&&!s.pinned&&!s.channel).map(renderSession)}{!archived&&!query&&!visibleSessions.some(s=>s.projectId===null&&!s.pinned&&!s.channel)?<p className="casual-empty">{t('casualSidebarHint')}</p>:null}</section>
        <div className="section-heading"><span>{t(archived ? 'archived' : 'projects')}</span><IconButton icon={Plus} label={t('addProject')} disabled={!projectsEnabled} onClick={requestProject}/></div>
        {state.projects.map(p => <section className="workspace-group" key={p.id}><div className={`workspace-title ${p.id === project?.id ? 'current' : ''}`}><button onClick={() => { setProjectId(p.id); if (selected && current?.projectId !== p.id) navigate(null); }}>{p.id === project?.id ? <FolderOpen size={16}/> : <Folder size={16}/>}<span>{p.name}</span></button><IconButton icon={SquarePen} label={t('newChat')} onClick={() => newChat(p.id)}/></div>{visibleSessions.filter(s => s.projectId === p.id && !s.pinned && !s.channel).map(renderSession)}</section>)}
        {!state.projects.length ? <button className="empty-project" onClick={requestProject}><Plus size={16}/>{t('noProjects')}</button> : null}
        <ChannelSessions sessions={visibleSessions.filter(s=>s.channel).sort((a,b)=>Number(!!b.pinned)-Number(!!a.pinned))} renderSession={renderSession} t={t} locale={locale} onSettings={()=>{setSettingTab('channels');setSettings(true);}}/>
        {query && !visibleSessions.length ? <p className="sidebar-empty">{t('noResults')}</p> : null}
      </div>
      <div className="sidebar-status"><span className={`status-dot ${state.engine.state === 'ready' ? 'ready' : ''}`}/><span>{engineName(state.selectedEngine)} · {t(state.engine.recovery?.status==='restarting'?'engineRestarting':state.engine.recovery?.status==='waiting'?'engineRecoveryWaiting':state.engine.state==='ready'?'connected':'disconnected')}</span><IconButton icon={Settings} label={t('settings')} onClick={() => setSettings(true)}/></div>
    </aside>
    <main className="conversation">
      {fileBrowserVisible ? <FileBrowser project={project} entries={fileList} directory={fileDirectory} picking={filePicking} loading={fileBrowsing.loading} error={fileBrowsing.failure?failureMessage(fileBrowsing.failure):''} t={t} locale={locale} enabled={filesEnabled} externalBusy={Boolean(openingDocument)} openingPath={openingDocument?.projectId===project?.id?openingDocument.path:null} onBrowse={path=>browseFiles(path,filePicking)} onOpen={path=>openFile(path,project.id)} onAttach={attachProjectFile} onOpenExternal={path=>openProjectFileExternally({projectId:project.id,path,name:fileList.find(entry=>entry.path===path)?.name??path.split('/').at(-1)})} onCopyPath={copyText} onClose={closeFileBrowser} onRetry={()=>browseFiles(fileDirectory,filePicking)}/> : <div className="transcript" aria-live="polite" ref={transcriptElement} onScroll={event=>{const el=event.currentTarget;keepAtBottom.current=el.scrollHeight-el.scrollTop-el.clientHeight<70;}}>
        <HistoryControls snapshot={historyView} t={t} onEarlier={loadEarlierHistory} onRetry={retryHistory}/>
        {!selected ? <div className="empty-conversation"><DshLogo className="welcome-logo"/><h1>{t(project?'greeting':'casualGreeting')}</h1><p>{t(project?'empty':'casualIntro')}</p><Dropdown label={t('casualWorkspace')} className="chat-workspace-picker" trigger={<><span className="project-caption">{project?<Folder size={15}/>:<MessageCircle size={15}/>}<span>{project?.name??t('casualNoWorkspace')}</span><ChevronDown size={13}/></span></>}>{close=><><MenuItem icon={MessageCircle} label={t('casualNoWorkspace')} checked={!project} onClick={()=>{close();newChat();}}/>{state.projects.map(p=><MenuItem key={p.id} icon={Folder} label={p.name} checked={project?.id===p.id} onClick={()=>{close();newChat(p.id);}}/>)}<MenuDivider/><MenuItem icon={Plus} label={t('addProject')} disabled={!projectsEnabled} onClick={()=>{close();requestProject();}}/></>}</Dropdown></div> : null}
        {transcriptLoading?<div className="transcript-loading" role="status"><LoaderCircle size={14} className="spinner"/>{t('chatLoading')}</div>:null}
        <TranscriptTimeline key={selected??'new'} items={items} session={current} running={runStatus(current,historyView.running)==='running'} locale={locale} projectId={project?.id} projectPath={project?.path} filesEnabled={filesEnabled} onCopy={transcriptActions.current.onCopy} onOpenFile={transcriptActions.current.onOpenFile}/><div ref={bottom}/>
      </div>}
      {state.switchingEngine||state.pendingEngine?<div className="engine-transfer-status" role="status">{state.switchingEngine?<LoaderCircle size={14} className="spinner"/>:<History size={14}/>}<span>{state.switchingEngine?t('engineSwitching'):t('enginePending',{engine:engineName(state.pendingEngine)})}</span>{!state.switchingEngine?<button className="subtle-button" onClick={()=>switchEngine(state.selectedEngine)}>{t('engineCancelPending')}</button>:null}</div>:null}
      {isEngineMismatch?<div className="engine-mismatch" role="status"><span>{t('engineMismatch',{engine:engineName(current?.engineId)})}</span><button className="subtle-button" onClick={()=>act(async()=>{await api('engine/select',{id:current?.engineId??'codex'});await refresh();await loadTranscript(selected);})}>{t('switchBackEngine')}</button></div>:null}
      {connection==='connected'&&['syncing','retrying','failed'].includes(syncStatus)?<div className="live-status" role="status">{t(syncStatus==='failed'?'streamResyncFailed':syncStatus==='retrying'?'streamResyncRetrying':'streamResyncing')}{syncStatus==='failed'?<button type="button" onClick={()=>void streamRecoveryRef.current?.opened()}>{t('retry')}</button>:null}</div>:null}
      {current?.runRecovery&&!(current.program?.status==='paused'&&current.program.runId===current.runRecovery.id)&&runStatus(current)!=='running'&&runStatus(current)!=='completed'?<div className="task-recovery-status" role="status"><span>{t(runStatusKey(current))}</span>{current.runRecovery.nextRetryAt&&Number.isFinite(Date.parse(current.runRecovery.nextRetryAt))?<small>{t('recoveryRetryAt',{time:new Intl.DateTimeFormat(locale,{hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(new Date(current.runRecovery.nextRetryAt))})}</small>:null}{canResumeRun(current)?<button type="button" disabled={recoveryAction!==null||isEngineMismatch} onClick={()=>resumeTask(current.id)}>{t(runStatus(current)==='uncertain'?'recheckTask':'resumeTask')}</button>:null}</div>:null}
      {connection==='reconnecting'?<div className="live-status" role="status"><LoaderCircle size={12} className="spinner"/>{t('liveDisconnected')}</div>:null}
      {error ? <div className="error-banner" role="alert"><span>{error}</span><IconButton icon={X} label={t('close')} onClick={() => setError('')}/></div> : null}
      {terminal&&terminalEnabled&&project?<TerminalPanel project={project} t={t} locale={locale} onClose={()=>setTerminal(false)}/>:null}
      <div className="composer-wrap"><div className="composer-surface"><ProgramStatus program={current?.program} locale={locale} t={t} onAction={action=>programAction(action)}/><SlashMenu key={draftId} draft={draft} t={t} inputRef={composerInput} onDraft={value=>setDrafts(old=>({...old,[draftId]:value}))} onExecute={executeSlash}/>{uploading?<div className="live-status" role="status"><LoaderCircle size={12} className="spinner"/>{t('attachmentsUploading')}</div>:null}{queue.length?<QueuedMessages queue={queue} busy={busy} canSteer={state.engine.capabilities?.steer!==false} t={t} onAction={queueAction}/>:null}<form className="composer" onSubmit={submit}>
        {attachments.length ? <div className="attachment-list">{attachments.map(file => <span className="file-chip" key={file.path}><Paperclip size={12}/>{file.name}<button type="button" aria-label={t('close')} onClick={() => setAttachments(old => old.filter(f => f.path !== file.path))}><X size={12}/></button></span>)}</div> : null}
        <span className="composer-input-help" id="composer-help">{t('inputHint')}</span>{!chatEnabled?<div className="feature-disabled-note"><span>{t('chatPluginDisabled')}</span><button type="button" className="subtle-button" onClick={()=>{setSettingTab('plugins');setSettings(true);}}>{t('managePlugins')}</button></div>:null}<textarea ref={composerInput} aria-describedby="composer-help" aria-label={t('placeholder')} placeholder={t('placeholder')} value={draft} disabled={!booted||!chatEnabled} onChange={e=>{e.target.style.height='auto';e.target.style.height=`${Math.min(200,Math.max(45,e.target.scrollHeight))}px`;setDrafts(old=>({...old,[draftId]:e.target.value}));}} onKeyDown={e => { if(e.defaultPrevented)return; if (e.key === 'Enter' && (!e.shiftKey||e.metaKey||e.ctrlKey) && !isComposing(e)) { e.preventDefault(); submit(null,Boolean((e.metaKey||e.ctrlKey)&&e.shiftKey)); } }}/>
        {state.features?.includes('feature-computer')?<ComputerControl t={t} locale={locale} sessionId={selected} restricted={Boolean(current?.channel||current?.kind==='agent')} prepareSession={prepareComputerSession}/>:null}
        <input type="file" multiple hidden ref={uploadInput} onChange={uploadFiles}/><ComposerControls computerEnabled={state.features?.includes('feature-computer')} t={t} modelDisabled={isEngineMismatch} capabilities={state.engine.capabilities??{}} models={state.models??[{id:'deepseek-v4.1-flash',name:'DeepSeek V4.1 Flash'}]} model={current?.model??newModel} submitting={submitting} effort={effort} permission={permission} busy={busy} stopDisabled={recoveryAction!==null} followUpBehavior={followUpBehavior} canSend={!state.switchingEngine&&chatEnabled&&booted&&!submitting&&!uploading&&!isEngineMismatch&&!['waiting','uncertain'].includes(current?.runRecovery?.status)&&Boolean(draft.trim()||attachments.length)} onModel={id=>selected?act(async()=>{await api(`sessions/${selected}/model`,{model:id});await refresh();}):setNewModel(id)} onEffort={setEffort} onPermission={setPermission} onFiles={()=>uploadInput.current.click()} onProjectFile={()=>project?browseFiles('',true):requestProject()} onSkills={()=>{setSettingTab('skills');setSettings(true);}} onModels={()=>{setSettingTab('models');setSettings(true);}} terminalEnabled={terminalEnabled} filesEnabled={filesEnabled} hasProject={Boolean(project)} integrationsEnabled={integrationsEnabled&&state.engine.capabilities?.skills!==false} onTerminal={()=>project?setTerminal(!terminal):requestProject()} onStop={()=>interruptTask(selected)}/>
      </form></div></div>
    </main>
    {documentFile&&filesEnabled&&visibleRightTab==='document'?<aside className="document-panel"><div className="resize-handle" role="separator" aria-label={t('resizeDocument')} aria-orientation="vertical" tabIndex={0} onPointerDown={event=>resize(event,'document')} onDoubleClick={()=>setDocumentWidth(null)} onKeyDown={event=>{if(['ArrowLeft','ArrowRight'].includes(event.key)){event.preventDefault();setDocumentWidth(width=>Math.max(320,(width??window.innerWidth*.45)+(event.key==='ArrowLeft'?20:-20)));}}}/><div className="document-toolbar"><div className="file-breadcrumb"><span>{documentProject?.name}</span><ChevronRight size={13}/><strong>{documentFile.name}</strong></div><div>{!isReadOnlyPreview(documentFile)?<><button className="subtle-button" aria-pressed={documentEditing} onClick={()=>{setDocumentLocation(null);setDocumentEditing(!documentEditing);}}><Code size={15}/>{t(documentEditing?'docReadOnlyPreview':'docEditSource')}</button><IconButton icon={Copy} label={t('copy')} onClick={()=>copyText(documentFile.content)}/></>:null}<button className="subtle-button" disabled={Boolean(openingDocument)||savingDocument||discardingDocument} onClick={openDocumentExternally}>{openingDocument?<LoaderCircle size={15} className="spinner"/>:<ExternalLink size={15}/>} {t(openingDocument?'docOpeningSystem':'open')}</button>{documentDirty ? <button className="primary-button" disabled={savingDocument} onClick={saveDocument}>{savingDocument?<LoaderCircle size={13} className="spinner"/>:t('save')}</button> : null}</div></div><div className="document-body document-content-host"><>{isImagePreview(documentFile)&&imagesEnabled?<ImagePreview key={imageIdentity} file={documentFile} locale={locale} t={t} loadImage={imageRequestCache.current.load} enabled={imagesEnabled} onRetry={()=>openFile(documentFile.path,documentFile.projectId)}/>:isReadOnlyPreview(documentFile)?<FilePreviewFallback file={isImagePreview(documentFile)?{...documentFile,preview:{kind:'external',reason:'IMAGE_PLUGIN_DISABLED'}}:documentFile} t={t} locale={locale} opening={Boolean(openingDocument)} disabled={savingDocument||discardingDocument} onOpen={openDocumentExternally} onRetry={()=>openFile(documentFile.path,documentFile.projectId)} onCopyPath={()=>copyText(documentFile.path)}/>:<DocumentContent file={documentFile} editing={documentEditing} location={documentLocation} t={t} locale={locale} disabled={savingDocument||discardingDocument} onEdit={content=>{documentSession.edit(content);syncDocument();}} onCopy={copyText} projectPath={documentProject?.path} onOpenFile={filesEnabled?(relative,location)=>openFile(relative,documentFile.projectId,location):null}/>}</></div></aside> : null}
    {agentPanel&&chatEnabled&&visibleRightTab==='agents'?<AgentPanel onResize={event=>resize(event,'document')} onResetWidth={()=>setDocumentWidth(null)} onWidthKey={event=>{if(['ArrowLeft','ArrowRight'].includes(event.key)){event.preventDefault();setDocumentWidth(width=>Math.max(320,(width??Math.min(440,window.innerWidth*.3))+(event.key==='ArrowLeft'?20:-20)));}}} sessions={state.sessions} projects={state.projects} onOpenFile={filesEnabled?openFile:null} t={t} locale={locale} onCreate={()=>setAgentDialog(true)} onOpen={navigate} onError={setError} onCopy={copyText}/>:null}
    {gitPanel&&gitEnabled&&visibleRightTab==='git'?<GitPanel project={project} t={t} locale={locale} onCopy={copyText} onOpenFile={filesEnabled?(relative,location)=>openFile(relative,project?.id,location):null} onResize={event=>resize(event,'document')} onResetWidth={()=>setDocumentWidth(null)} onWidthKey={event=>{if(['ArrowLeft','ArrowRight'].includes(event.key)){event.preventDefault();setDocumentWidth(width=>Math.max(320,(width??window.innerWidth*.45)+(event.key==='ArrowLeft'?20:-20)));}}}/>:null}
    {sourcesOpen ? <aside className="sources-popover"><div className="sources-title"><span>{t('output')}</span><IconButton icon={Plus} label={t('openFile')} onClick={() => browseFiles()}/></div><button className="source-create" onClick={() => browseFiles()}>{t('createFile')}</button><hr/><div className="sources-title"><span>{t('sources')}</span><IconButton icon={Plus} label={t('attach')} onClick={() => uploadInput.current.click()}/></div>{uniqueSources.map(p => <FileReference t={t} target={p} projectPath={project?.path} className="source-row" onOpenFile={filesEnabled?(relative,location)=>openFile(relative,project?.id,location):null} key={p}><FileText size={16}/><span>{p}</span></FileReference>)}{!uniqueSources.length ? <div className="sources-empty">{t('noSources')}</div> : null}<button className="source-row muted" onClick={() => browseFiles()}><Files size={16}/>{t('allSources')}</button></aside> : null}
    {findOpen?<div className="find-bar" role="search" aria-label={t('findInChat')}><Search size={14}/><input ref={findInput} autoFocus aria-label={t('findInChat')} placeholder={t('findInChat')} value={findText} onChange={event=>setFindText(event.target.value)} onKeyDown={event=>{if(isComposing(event))return;if(event.key==='Enter'){event.preventDefault();nextFind(!event.shiftKey);}if(event.key==='Escape'){event.stopPropagation();closeFind();}}}/><span className="find-count" aria-live="polite">{findResult?.matches!==undefined?`${new Intl.NumberFormat(locale).format(findResult.activeMatchOrdinal??0)} / ${new Intl.NumberFormat(locale).format(findResult.matches)}`:findResult?.found===false?t('noResults'):''}</span><IconButton icon={ArrowUp} label={t('previousMatch')} disabled={!findText} onClick={()=>nextFind(false)}/><IconButton icon={ChevronDown} label={t('nextMatch')} disabled={!findText} onClick={()=>nextFind(true)}/><IconButton icon={X} label={t('close')} onClick={closeFind}/></div>:null}
    {notice ? <div className="toast" role="status"><Check size={15}/>{notice}</div> : null}
    {addProject ? <Dialog closeLabel={t('close')} title={t('addProject')} onClose={() => setAddProject(false)}><form onSubmit={createProject} className="dialog-form"><label>{t('projectPath')}<input value={pathInput} onChange={e => setPathInput(e.target.value)} required autoFocus/></label><label>{t('projectName')}<input value={projectName} onChange={e => setProjectName(e.target.value)}/></label><div className="dialog-actions"><button type="button" onClick={() => setAddProject(false)}>{t('cancel')}</button><button className="primary-button" type="submit">{t('add')}</button></div></form></Dialog> : null}
    {approvalSnapshot.current?<ApprovalPanel formsEnabled={mcpFormsEnabled} onFormType={(field,value)=>{approvalController.formType(approvalSnapshot.current.id,field,value);publishApprovals();}} key={approvalSnapshot.current.id} snapshot={approvalSnapshot} t={t} locale={locale} contextName={state.sessions.find(session=>session.threadId===(approvalSnapshot.current.params?.threadId??approvalSnapshot.current.params?.conversationId))?.title} onChoose={choice=>{approvalController.choose(approvalSnapshot.current.id,approvalSnapshot.question.id,choice);publishApprovals();}} onType={text=>{approvalController.type(approvalSnapshot.current.id,approvalSnapshot.question.id,text);publishApprovals();}} onMove={direction=>{approvalController.move(approvalSnapshot.current.id,direction);publishApprovals();}} onSkip={()=>{approvalController.skip(approvalSnapshot.current.id);publishApprovals();}} onSubmit={(allow,options)=>answerApproval(approvalSnapshot.current.id,allow,options)}/>:null}
    {agentDialog?<Dialog closeLabel={t('close')} title={t('agents')} onClose={()=>setAgentDialog(false)} className="settings-dialog"><div className="integrations-list">{state.sessions.filter(session=>session.kind==='agent').map(session=><div className="integration-row" key={session.id}><div className="integration-description"><strong>{session.title}</strong><small>{t(runStatusKey(session))}</small></div><button onClick={()=>{navigate(session.id);setAgentDialog(false);}}>{t('openChat')}</button>{canStopRun(session)?<button disabled={recoveryAction===session.id} onClick={()=>interruptTask(session.id)}>{t('stop')}</button>:null}</div>)}</div>{!state.sessions.some(session=>session.kind==='agent')?<p className="muted">{t('agentEmpty')}</p>:null}<form className="dialog-form" onSubmit={createAgent}><h3>{t('newAgent')}</h3><label>{t('chooseProject')}<select required value={project?.id??''} onChange={event=>{setProjectId(event.target.value);if(selected)navigate(null);}}><option value="">{t('chooseProject')}</option>{state.projects.map(project=><option value={project.id} key={project.id}>{project.name}</option>)}</select></label><label>{t('agentName')}<input value={agentName} onChange={event=>setAgentName(event.target.value)}/></label><label>{t('agentPrompt')}<textarea required value={agentPrompt} onChange={event=>setAgentPrompt(event.target.value)}/></label><div className="dialog-actions"><button type="button" onClick={()=>setAgentDialog(false)}>{t('close')}</button><button className="primary-button" type="submit" disabled={modalPending||!agentPrompt.trim()}>{modalPending?<LoaderCircle size={13} className="spinner"/>:t('startAgent')}</button></div></form></Dialog>:null}
    {chatDialog?<Dialog closeLabel={t('close')} title={t(chatDialog.action==='rename'?'renameChat':'moveChat')} onClose={()=>!modalPending&&setChatDialog(null)} className="chat-action-dialog"><form className="dialog-form" onSubmit={submitChatDialog}>{chatDialog.action==='rename'?<label>{t('renameChatLabel')}<input autoFocus required maxLength={200} value={chatDialogValue} onChange={event=>setChatDialogValue(event.target.value)}/></label>:<><p className="dialog-description">{t('moveChatHelp')}</p><label>{t('moveToProject')}<select autoFocus value={chatDialogValue} onChange={event=>setChatDialogValue(event.target.value)}><option value="">{t('casualNoWorkspace')}</option>{state.projects.map(entry=><option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></label></>}<div className="dialog-actions"><button type="button" disabled={modalPending} onClick={()=>setChatDialog(null)}>{t('cancel')}</button><button type="submit" className="primary-button" disabled={modalPending||(chatDialog.action==='rename'&&!chatDialogValue.trim())}>{modalPending?<LoaderCircle size={13} className="spinner"/>:t(chatDialog.action==='rename'?'save':'move')}</button></div></form></Dialog>:null}
    {unsavedAction?<Dialog closeLabel={t('close')} title={t('unsavedDocument')} onClose={()=>!savingDocument&&!discardingDocument&&cancelUnsaved()}><p className="dialog-description">{t('unsaved')}</p><div className="dialog-actions"><button type="button" disabled={savingDocument||discardingDocument} onClick={cancelUnsaved}>{t('cancel')}</button><button type="button" disabled={savingDocument||discardingDocument} onClick={discardDocumentChanges}>{discardingDocument?<LoaderCircle size={13} className="spinner"/>:t('discard')}</button><button type="button" className="primary-button" disabled={savingDocument||discardingDocument} onClick={async()=>{if(await saveDocument()){const action=unsavedAction;setUnsavedAction(null);action();}}}>{t('saveAndContinue')}</button></div></Dialog>:null}
    {resourceSpaceOpen?<ResourceSpace projects={state.projects} initialProjectId={project?.id} t={t} locale={locale} enabled={filesEnabled} canAddProject={projectsEnabled} collapsed={!sidebar} onClose={()=>setResourceSpaceOpen(false)} onAddProject={requestProject} onManagePlugins={()=>{setSettingTab('plugins');setSettings(true);}} onOpenFile={(path,projectId)=>{setResourceSpaceOpen(false);return openFile(path,projectId);}} onOpenExternal={openProjectFileExternally} onCopyPath={copyText}/>:null}
    {automationsOpen&&automationsEnabled?<Dialog closeLabel={t('close')} title={t('scheduledTasks')} className="automations-dialog" onClose={()=>setAutomationsOpen(false)}><AutomationsPanel state={state} t={t} locale={locale} onOpenChat={id=>{setAutomationsOpen(false);navigate(id);}}/></Dialog>:null}
    {settings ? <Dialog closeLabel={t('close')} title={t('settingsTitle')} onClose={() => setSettings(false)} className="settings-dialog"><div className="settings-layout"><nav>{['general','channels','plugins','engines','mcp','skills','models','shortcuts','logs','about'].map(key => <button className={settingTab === key ? 'selected' : ''} key={key} onClick={() => setSettingTab(key)}>{t(key)}</button>)}</nav><section><SettingsContent onOpenChat={id=>{navigate(id);setSettings(false);}} onFollowUp={value=>act(async()=>{await api('preferences',{followUpBehavior:value});await refresh();})} beforePluginChange={beforePluginChange} tab={settingTab} t={t} locale={locale} setLocale={setLocale} theme={theme} setTheme={setTheme} state={state} busy={busy} act={act} refresh={refresh}/></section></div></Dialog> : null}
  </div>;
}
export function mountDshAppearance(element){let flush;const root=createRoot(element);root.render(<App registerCleanup={callback=>{flush=callback;}}/>);return async()=>{await flush?.();root.unmount();};}
