import React,{useEffect,useId,useRef,useState} from 'react';
import {Target,Repeat2,ChevronRight,Square,Play,Check,Pause,Slash} from 'lucide-react';
import {slashMatches,parseSlash} from './lib/slash-commands.js';
import {isComposing} from './lib/keyboard.js';
export function SlashMenu({draft,onDraft,onExecute,inputRef,t}){
 const [index,setIndex]=useState(0),[dismissed,setDismissed]=useState(null),id=useId(),list=useRef(null);
 const matches=slashMatches(draft),visible=matches!==null&&dismissed!==draft,selected=Math.min(index,Math.max(0,(matches?.length??0)-1));
 const pick=name=>{if(['goal','loop'].includes(name)){onDraft('/'+name+' ');inputRef.current?.focus();}else onExecute(name);};
 useEffect(()=>{setIndex(0);},[draft]);
 useEffect(()=>{const input=inputRef.current;if(!input||!visible)return;function keys(event){if(isComposing(event))return;if(['ArrowUp','ArrowDown','Enter','Tab','Escape'].includes(event.key)){if(event.shiftKey&&event.key==='Enter')return;event.preventDefault();event.stopPropagation();if(event.key==='Escape'){setDismissed(draft);return;}if(!matches.length)return;if(event.key==='ArrowDown'||event.key==='ArrowUp')setIndex(value=>(value+(event.key==='ArrowDown'?1:-1)+matches.length)%matches.length);else pick(matches[selected]);}}
 input.addEventListener('keydown',keys);input.setAttribute('aria-controls',id);input.setAttribute('aria-expanded','true');input.setAttribute('aria-activedescendant',id+'-'+selected);
 return()=>{input.removeEventListener('keydown',keys);input.removeAttribute('aria-controls');input.removeAttribute('aria-expanded');input.removeAttribute('aria-activedescendant');};
 },[draft,visible,selected,matches?.join(','),onExecute]);
 useEffect(()=>{list.current?.querySelector('[aria-selected=true]')?.scrollIntoView({block:'nearest'});},[selected]);
 if(!visible){const command=parseSlash(draft);return command&&['goal','loop'].includes(command.name)?<div className="slash-hint"><Slash size={12}/>{t('slashUsage_'+command.name)}</div>:null;}
 return <div className="slash-popover"><div className="slash-heading">{t('slashCommands')}<kbd>↑ ↓</kbd></div><div className="slash-options" ref={list} id={id} role="listbox" aria-label={t('slashCommands')}>{matches.length?matches.map((name,i)=><button type="button" key={name} id={id+'-'+i} role="option" aria-selected={i===selected} onMouseEnter={()=>setIndex(i)} onMouseDown={event=>event.preventDefault()} onClick={()=>pick(name)}><span className="slash-command">/{name}</span><span>{t('slash_'+name)}</span>{i===selected?<ChevronRight size={13}/>:null}</button>):<p className="slash-empty">{t('slashNoMatches')}</p>}</div></div>;
}
export function ProgramStatus({program,locale,t,onAction}){
 const [now,setNow]=useState(Date.now),[pending,setPending]=useState(false);
 useEffect(()=>{if(program?.status!=='active')return;const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[program?.status]);
 if(!program)return null;const active=program.status==='active',Icon=program.kind==='goal'?Target:Repeat2;
 const remaining=program.nextRunAt?Math.max(0,Math.ceil((Date.parse(program.nextRunAt)-now)/1000)):null;
 async function action(value){if(pending)return;setPending(true);try{await onAction(value);}finally{setPending(false);}}
 return <div className="program-status" role="status"><Icon size={15} strokeWidth={1.6}/><div><span>{t('program_'+program.kind)} · {t('program_'+program.status)}</span><small title={program.objective}>{program.objective}</small><small>{t('programIterations',{count:new Intl.NumberFormat(locale).format(program.iterations)})}{active&&remaining!==null?' · '+t('programNext',{seconds:new Intl.NumberFormat(locale).format(remaining)}):''}{program.reason&&t('programReason_'+program.reason)!=='programReason_'+program.reason?' · '+t('programReason_'+program.reason):''}</small></div>{active?<button type="button" disabled={pending} aria-label={t('programPause')} title={t('programPause')} onClick={()=>action('pause')}><Pause size={14}/></button>:program.status!=='completed'?<button type="button" disabled={pending} title={t('programResume')} aria-label={t('programResume')} onClick={()=>action('resume')}><Play size={14}/></button>:<Check size={14}/>} {program.kind==='goal'&&program.status!=='completed'?<button type="button" disabled={pending} title={t('programComplete')} aria-label={t('programComplete')} onClick={()=>action('complete')}><Check size={14}/></button>:null}</div>;
}
