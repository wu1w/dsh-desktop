import React,{useEffect,useRef,useState} from 'react';
import {ListEnd,CornerDownRight,Trash2,MoreHorizontal,Pencil,ArrowUp,ArrowDown,Send,Check,X,Paperclip,LoaderCircle} from 'lucide-react';
import {Dropdown,MenuItem,MenuDivider} from './menu.jsx';
import {isComposing} from './lib/keyboard.js';

export function QueuedMessages({queue,busy,t,onAction,canSteer=true}){
  const [editing,setEditing]=useState(null),[text,setText]=useState(''),[pending,setPending]=useState(null);
  const lock=useRef(false);
  useEffect(()=>{if(editing&&!queue.some(entry=>entry.id===editing))setEditing(null);},[queue,editing]);
  const content=entry=>(entry.input??[]).filter(item=>item.type==='text').map(item=>item.text??'').join('\n');
  const files=entry=>(entry.input??[]).filter(item=>item.type!=='text').length;
  async function run(action,entry,extra={}){
    if(lock.current)return;lock.current=true;setPending(entry.id);
    try{await onAction(action,{id:entry.id,...extra});if(action==='update')setEditing(null);}catch{/* The parent displays the failure and retains the message. */}finally{lock.current=false;setPending(null);}
  }
  function move(entry,offset){const ids=queue.map(item=>item.id),index=ids.indexOf(entry.id);if(index+offset<0||index+offset>=ids.length)return;[ids[index],ids[index+offset]]=[ids[index+offset],ids[index]];return run('reorder',entry,{ids});}
  return <section className="queued-messages" aria-label={t('queuedMessages')}>{queue.map((entry,index)=><div className={`queued-message ${entry.recovered?'queue-recovered':''}`} key={entry.id} aria-busy={pending===entry.id}>
    <ListEnd size={16} strokeWidth={1.5} className="queue-symbol"/>
    {editing===entry.id?<div className="queue-editor"><textarea aria-label={t('editQueued')} autoFocus disabled={pending!==null} value={text} onChange={event=>setText(event.target.value)} onKeyDown={event=>{if(isComposing(event))return;if(event.key==='Escape'){event.preventDefault();event.stopPropagation();setEditing(null);}if((event.metaKey||event.ctrlKey)&&event.key==='Enter'){event.preventDefault();if(text.trim()||files(entry)>0)run('update',entry,{text});}}}/><button type="button" disabled={pending!==null||(!text.trim()&&files(entry)===0)} onClick={()=>run('update',entry,{text})}><Check size={14}/>{t('save')}</button><button type="button" disabled={pending!==null} onClick={()=>setEditing(null)}><X size={14}/>{t('cancel')}</button></div>:<button type="button" className="queued-text" title={content(entry)} disabled={pending!==null} onClick={()=>{setEditing(entry.id);setText(content(entry));}}><span>{content(entry)||t('attachment')}</span>{files(entry)>0?<small><Paperclip size={11}/>{t('queueAttachmentCount',{count:files(entry)})}</small>:null}{entry.recovered?<small>{t('queueRecovered')}</small>:null}</button>}
    <div className="queue-actions"><button type="button" className="queue-steer" disabled={pending!==null||editing===entry.id||(busy&&!canSteer)} title={t(busy&&!canSteer?'steerUnsupported':busy?'steerDescription':'sendNow')} onClick={()=>run(busy?'steer':'start',entry)}>{pending===entry.id?<LoaderCircle size={14} className="spinner"/>:busy?<CornerDownRight size={15}/>:<Send size={14}/>}<span>{t(busy?'steer':'sendNow')}</span></button><button type="button" className="icon-button" aria-label={t('deleteQueued')} title={t('deleteQueued')} disabled={pending!==null} onClick={()=>run('delete',entry)}><Trash2 size={15} strokeWidth={1.6}/></button>
    <Dropdown label={t('queueOptions')} above align="right" disabled={pending!==null} className="queue-dropdown" trigger={<MoreHorizontal size={17}/>}>
      {close=><><MenuItem icon={Pencil} label={t('editQueued')} onClick={()=>{close();setEditing(entry.id);setText(content(entry));}}/><MenuItem icon={ArrowUp} label={t('moveUp')} disabled={index===0||entry.recovered||queue[index-1]?.recovered} onClick={()=>{close();move(entry,-1);}}/><MenuItem icon={ArrowDown} label={t('moveDown')} disabled={index===queue.length-1||entry.recovered||queue[index+1]?.recovered} onClick={()=>{close();move(entry,1);}}/><MenuDivider/><MenuItem icon={Trash2} label={t('deleteQueued')} onClick={()=>{close();run('delete',entry);}}/></>}
    </Dropdown></div>
  </div>)}</section>;
}
