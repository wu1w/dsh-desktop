import React,{useEffect,useId,useState} from 'react';
import {Code2,Monitor,ChevronRight,BookOpen,Search,Pencil,TerminalSquare,Wrench,LoaderCircle,FileText} from 'lucide-react';
import {TranscriptItem} from './transcript-item.jsx';
import {Markdown,FileReference} from './markdown.jsx';
import {translator} from './i18n.js';
import {transcriptTurns,processBlocks,activityKinds,elapsedText} from './lib/transcript-turns.js';

function ActivityGroup({items,locale,projectId,projectPath,filesEnabled,onCopy,onOpenFile}){
  const t=translator(locale),kinds=activityKinds(items),running=items.some(item=>item.running),failed=items.some(item=>item.status==='failed'||Number.isInteger(item.exitCode)&&item.exitCode!==0);
  const Icon=running?LoaderCircle:({plugin:Code2,computer:Monitor,read:BookOpen,search:Search,edit:Pencil,command:TerminalSquare,tool:Wrench,thinking:ChevronRight}[kinds[0]]??Wrench);
  const label=kinds.map(kind=>t(`process_${kind}_${running?'active':'done'}`)).join(t('processJoin'));
  const openFile=filesEnabled&&onOpenFile?(relative,location)=>onOpenFile(relative,projectId,location):null;
  return <details className={`activity-group${failed?' activity-failed':''}`}><summary><Icon size={15} strokeWidth={1.6} className={running?'spinner':undefined}/><span>{label}</span><ChevronRight className="activity-chevron" size={13}/>{failed?<span className="activity-failure-label">{t('processToolFailed')}</span>:null}</summary><div className="activity-details">
    {items.map(item=><div className={`activity-operation ${item.type}`} key={item.id} data-history-id={item.id}>
      {item.type==='reasoning'?<Markdown text={item.text} t={t} onCopy={onCopy} projectPath={projectPath} onOpenFile={openFile}/>:<><div className="activity-operation-heading">{t(item.activity==='plugin'?'devTitle':item.activity==='computer'?'computerTitle':item.type==='commandExecution'?'command':item.type==='fileChange'?'fileChange':'tool')}</div>{item.command?<pre>{item.command}</pre>:null}{item.text?<pre>{item.text}</pre>:null}{item.output?<pre>{item.output}</pre>:null}{(item.paths??[]).filter(value=>typeof value==='string').map(target=><FileReference key={target} t={t} target={target} projectPath={projectPath} onOpenFile={openFile}><FileText size={13}/>{target}</FileReference>)}</>}
    </div>)}
  </div></details>;
}
export function TranscriptTurn({turn,...props}){
  const t=translator(props.locale),[choice,setChoice]=useState(null),[now,setNow]=useState(Date.now),contentId=useId();
  const open=choice??turn.active;
  useEffect(()=>{if(!turn.active)return;setNow(Date.now());const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[turn.active,turn.id]);
  const duration=elapsedText(turn.startedAt,turn.active?now:turn.completedAt,props.locale,t);
  const special={failed:'processFailed',interrupted:'processInterrupted',waiting:'processWaiting',uncertain:'processUncertain'}[turn.status];
  const label=turn.active?t('processWorking'):special?t(special):duration?t('processElapsed',{duration}):t('processHistory');
  const showHeader=turn.process.length>0||turn.active||duration!==null||Boolean(special),blocks=processBlocks(turn.process);
  return <section className={`transcript-turn${turn.active?' is-active':''}`} data-history-id={'turn:'+turn.id}>
    {showHeader?<><button type="button" className={`turn-toggle${open?' expanded':''}`} aria-expanded={open} aria-controls={contentId} onClick={()=>setChoice(!open)}><span>{label}{turn.active&&duration?' · '+duration:''}</span><ChevronRight size={14} strokeWidth={1.6}/></button><div id={contentId} className="turn-process" hidden={!open}>{blocks.length?blocks.map(block=>block.kind==='commentary'?<TranscriptItem key={block.id} item={block.item} {...props}/>:<ActivityGroup key={block.id} items={block.items} {...props}/>):<p className="process-empty">{t(turn.active?'processWaitingForActivity':'processNoDetails')}</p>}</div></>:null}
    <div className="turn-answer">{turn.answers.map(item=><TranscriptItem key={item.id} item={item} {...props}/>)}</div>
  </section>;
}
export function TranscriptTimeline({items,session,running,...props}){
  return <>{transcriptTurns(items,session,running).map(row=>row.kind==='user'?<TranscriptItem key={'user:'+row.id} item={row.item} {...props}/>:<TranscriptTurn key={row.id} turn={row} {...props}/>)}</>;
}
