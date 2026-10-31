import {TranscriptTimeline} from './transcript-timeline.jsx';
import React,{useEffect,useLayoutEffect,useRef,useState} from 'react';
import {AtSign,Plus,ArrowLeft,ExternalLink,Square,LoaderCircle} from 'lucide-react';
import {api} from './api.js';
import {HistoryController} from './lib/history-controller.js';
import {historyForSelection} from './lib/session-view.js';
import {captureHistoryAnchor,restoreHistoryAnchor} from './lib/history-scroll.js';
import {HistoryControls} from './history-controls.jsx';
import {runStatusKey,canStopRun,canResumeRun,runStatus} from './lib/run-status.js';

export function AgentPanel({sessions,projects=[],onOpenFile,t,locale,onCreate,onOpen,onError,onCopy,onResume,onStop,actionPending,onResize,onResetWidth,onWidthKey}){
  const [selected,setSelected]=useState(null),[,setNow]=useState(Date.now());
  const selectedRef=useRef(null),transcript=useRef(null),scrollRestore=useRef(null),followTail=useRef(true),programmaticScroll=useRef(null);
  const [historyController]=useState(()=>new HistoryController());
  const [historySnapshot,setHistorySnapshot]=useState(()=>historyController.snapshot());
  const agents=sessions.filter(session=>session.kind==='agent'&&!session.archived),current=agents.find(session=>session.id===selected),hasRunning=agents.some(agent=>agent.running);
  const historyView=historyForSelection(historySnapshot,selected,current?.running),items=historyView.items,busy=runStatus(current,historyView.running)==='running',loading=historyView.loadingInitial&&items.length===0;
  function publishHistory(){setHistorySnapshot(historyController.snapshot());}
  async function loadLatest(id,{signal}={}){if(selectedRef.current!==id)return;const token=historyController.beginInitial();publishHistory();try{const result=await api(`sessions/${encodeURIComponent(id)}`,undefined,'GET',{signal});if(signal?.aborted){if(historyController.cancelInitial(token,{error:signal.reason?.code==='STREAM_RECOVERY_TIMEOUT'?t('streamResyncFailed'):null}))publishHistory();return;}const anchor=token.rebuild?captureHistoryAnchor(transcript.current):null;if(historyController.completeInitial(token,result)){if(token.rebuild)scrollRestore.current={anchor,sessionId:token.sessionId,epoch:token.epoch,missing:'start'};publishHistory();}}catch(failure){if(signal?.aborted){if(historyController.cancelInitial(token,{error:signal.reason?.code==='STREAM_RECOVERY_TIMEOUT'?t('streamResyncFailed'):null}))publishHistory();return;}if(historyController.failInitial(token,failure.message))publishHistory();if(signal)throw failure;}}
  async function loadEarlier(){const token=historyController.beginEarlier();if(!token)return;followTail.current=false;publishHistory();try{const result=await api(`sessions/${encodeURIComponent(token.sessionId)}/history?cursor=${encodeURIComponent(token.cursor)}`),anchor=captureHistoryAnchor(transcript.current);if(historyController.completeEarlier(token,result)){scrollRestore.current={anchor,sessionId:token.sessionId,epoch:token.epoch};publishHistory();if(historyController.reloadRequired)await loadLatest(token.sessionId);}}catch(failure){if(historyController.failEarlier(token,failure.message,failure.code)){publishHistory();if(historyController.reloadRequired)await loadLatest(token.sessionId);}}}
  function retryHistory(){historyController.retryTarget()==='earlier'?loadEarlier():loadLatest(selectedRef.current);}
  function positionTranscript(action){const element=transcript.current;if(!element)return;action(element);programmaticScroll.current={sessionId:selectedRef.current,top:element.scrollTop};}
  function followTranscript(){positionTranscript(element=>{element.scrollTop=element.scrollHeight;});}
  function trackScroll(){
    const element=transcript.current;if(!element)return;
    const ownScroll=programmaticScroll.current;programmaticScroll.current=null;
    // A restore can still end at the tail of a short page. Its scroll event
    // must not turn an explicit request for earlier history back into follow.
    if(ownScroll?.sessionId===selectedRef.current&&Math.abs(element.scrollTop-ownScroll.top)<1)return;
    if(historyController.pageToken||scrollRestore.current)return;
    followTail.current=element.scrollHeight-element.scrollTop-element.clientHeight<70;
  }
  useLayoutEffect(()=>{
    const pending=scrollRestore.current;scrollRestore.current=null;
    if(pending?.sessionId===historyController.sessionId&&pending.epoch===historyController.epoch){positionTranscript(element=>restoreHistoryAnchor(element,pending.anchor,{missing:pending.missing}));return;}
    if(selected===historyController.sessionId&&followTail.current&&!historyController.pageToken)followTranscript();
  },[items,busy,selected]);
  useEffect(()=>{
    const element=transcript.current;if(!selected||!element||typeof globalThis.ResizeObserver!=='function')return;
    let active=true;
    const observer=new globalThis.ResizeObserver(()=>{if(active&&selectedRef.current===selected&&followTail.current&&!historyController.pageToken&&!scrollRestore.current)followTranscript();});
    observer.observe(element);return()=>{active=false;observer.disconnect();};
  },[selected]);
  useEffect(()=>{if(!agents.some(agent=>agent.id===selected))setSelected(null);},[sessions,selected]);
  useEffect(()=>{
    if(!hasRunning)return;
    const refresh=()=>setNow(Date.now()),page=window.document,visible=()=>{if(page?.visibilityState==='visible')refresh();};
    refresh();const timer=setInterval(refresh,1000);
    window.addEventListener('focus',refresh);page?.addEventListener?.('visibilitychange',visible);
    return()=>{clearInterval(timer);window.removeEventListener('focus',refresh);page?.removeEventListener?.('visibilitychange',visible);};
  },[hasRunning]);
  useEffect(()=>{
    selectedRef.current=selected;historyController.select(selected);scrollRestore.current=null;followTail.current=true;programmaticScroll.current=null;publishHistory();if(!selected)return;
    loadLatest(selected);
    const listener=event=>{if(event.detail.sessionId===selectedRef.current){historyController.applyLive(event.detail.items,{running:event.detail.running});publishHistory();}};
    const restored=event=>{if(selectedRef.current){const operation=loadLatest(selectedRef.current,{signal:event.detail?.signal});event.detail?.waitUntil?.(operation);}};
    window.addEventListener('dsh-session-event',listener);window.addEventListener('dsh-stream-restored',restored);return()=>{historyController.select(null);window.removeEventListener('dsh-session-event',listener);window.removeEventListener('dsh-stream-restored',restored);};
  },[selected]);
  function elapsed(session){const start=new Date(session.startedAt??session.createdAt).getTime(),end=session.running?Date.now():new Date(session.completedAt??session.updatedAt??Date.now()).getTime();if(!Number.isFinite(start)||!Number.isFinite(end))return '';const seconds=Math.max(0,Math.floor((end-start)/1000)),format=new Intl.NumberFormat(locale);return seconds>=60?t('elapsedMinutes',{minutes:format.format(Math.floor(seconds/60)),seconds:format.format(seconds%60)}):t('elapsedSeconds',{seconds:format.format(seconds)});}
  async function stop(){if(!current)return;if(onStop)return onStop(current.id);try{await api(`sessions/${encodeURIComponent(current.id)}/interrupt`,{});}catch(failure){onError(failure.message);}}
  return <aside className="document-panel agent-panel"><div className="resize-handle" role="separator" aria-label={t('resizeDocument')} aria-orientation="vertical" tabIndex={0} onPointerDown={onResize} onDoubleClick={onResetWidth} onKeyDown={onWidthKey}/>
    <div className="agent-panel-heading">{current?<button className="subtle-button" onClick={()=>setSelected(null)}><ArrowLeft size={14}/>{t('allAgents')}</button>:<span>{t('agentsOpened',{count:new Intl.NumberFormat(locale).format(agents.length)})}</span>}<button className="icon-button" title={t('newAgent')} aria-label={t('newAgent')} onClick={onCreate}><Plus size={17}/></button></div>
    {current?<><div className="agent-preview-heading"><AtSign size={18}/><strong>{current.title}</strong><button className="icon-button" title={t('openChat')} aria-label={t('openChat')} onClick={()=>onOpen(current.id)}><ExternalLink size={15}/></button></div><div className="agent-preview-status"><span className={`status-dot ${busy?'ready':''}`}/>{t(runStatusKey(current,busy))}<span>{elapsed(current)}</span>{canResumeRun(current)&&onResume?<button className="subtle-button" disabled={Boolean(actionPending)} onClick={()=>onResume(current.id)}>{t(runStatus(current)==='uncertain'?'recheckTask':'resumeTask')}</button>:null}{canStopRun(current,busy)?<button className="subtle-button" disabled={Boolean(actionPending)} onClick={stop}><Square size={10} fill="currentColor"/>{t('stop')}</button>:null}</div><div ref={transcript} className="agent-preview-transcript" aria-live="polite" onScroll={trackScroll}><HistoryControls snapshot={historyView} t={t} onEarlier={loadEarlier} onRetry={retryHistory}/>{loading?<div className="working"><LoaderCircle size={14} className="spinner"/>{t('loading')}</div>:null}<TranscriptTimeline key={selected} items={items} session={current} running={busy} locale={locale} projectId={current.projectId} projectPath={projects.find(project=>project.id===current.projectId)?.path} filesEnabled={Boolean(onOpenFile)} onCopy={onCopy} onOpenFile={onOpenFile}/></div></>:<div className="agent-list">{agents.map(agent=><button className="agent-list-row" key={agent.id} onClick={()=>setSelected(agent.id)}><div className={`agent-avatar ${agent.running?'active':''}`}><AtSign size={22} strokeWidth={1.6}/></div><div className="agent-list-copy"><strong>{agent.title}</strong><span>{t(runStatusKey(agent))}</span></div><small>{elapsed(agent)}</small></button>)}{!agents.length?<div className="agent-empty"><AtSign size={25}/><p>{t('agentEmpty')}</p><button className="subtle-button" onClick={onCreate}><Plus size={14}/>{t('newAgent')}</button></div>:null}</div>}
  </aside>;
}
