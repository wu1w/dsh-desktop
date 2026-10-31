import React,{useId,useLayoutEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {Check} from 'lucide-react';
import {isComposing} from './lib/keyboard.js';

export function Dropdown({label,trigger,children,align='left',above=false,className='',disabled=false,contextTrigger=false}){
  const [open,setOpen]=useState(false);
  const [position,setPosition]=useState({left:0,top:0,visibility:'hidden'});
  const root=useRef(null),button=useRef(null),menu=useRef(null),typeahead=useRef(''),typeaheadTimer=useRef(null),initialFocus=useRef('first'),lastFocused=useRef(null);
  const id=useId(),expanded=open&&!disabled;
  function resetSearch(){clearTimeout(typeaheadTimer.current);typeaheadTimer.current=null;typeahead.current='';}
  function close(restore=true){resetSearch();setOpen(false);if(restore&&!disabled)button.current?.focus();}
  function options(){return [...(menu.current?.querySelectorAll('[role^="menuitem"]:not(:disabled)')??[])];}
  function focusEdge(edge){const entries=options();(edge==='last'?entries.at(-1):entries[0])?.focus();if(!entries.length)menu.current?.focus();}
  function show(edge='first'){if(disabled)return;resetSearch();initialFocus.current=edge;if(open)focusEdge(edge);else setOpen(true);}
  useLayoutEffect(()=>{
    if(!expanded){if(open)setOpen(false);return;}
    function place(){
      const anchor=button.current?.getBoundingClientRect(),popup=menu.current?.getBoundingClientRect();if(!anchor||!popup)return;
      let left=align==='right'?anchor.right-popup.width:anchor.left;
      let top=above?anchor.top-popup.height-8:anchor.bottom+7;
      if(top+popup.height>window.innerHeight-8&&anchor.top-popup.height>8)top=anchor.top-popup.height-8;
      if(top<8&&anchor.bottom+popup.height<window.innerHeight-8)top=anchor.bottom+7;
      setPosition({left:Math.max(8,Math.min(left,window.innerWidth-popup.width-8)),top:Math.max(8,Math.min(top,window.innerHeight-popup.height-8)),visibility:'visible'});
    }
    place();const observer=new ResizeObserver(place);if(menu.current)observer.observe(menu.current);
    window.addEventListener('resize',place);window.addEventListener('scroll',place,true);
    const focusFrame=requestAnimationFrame(()=>focusEdge(initialFocus.current));
    const outside=event=>{if(document.body?.inert===true)return;if(!root.current?.contains(event.target)&&!menu.current?.contains(event.target))close(false);};
    const other=event=>{if(document.body?.inert!==true&&event.detail!==id)close(false);};
    window.dispatchEvent(new CustomEvent('dsh-menu-open',{detail:id}));
    window.addEventListener('dsh-menu-open',other);window.addEventListener('pointerdown',outside,true);
    return()=>{cancelAnimationFrame(focusFrame);observer.disconnect();window.removeEventListener('resize',place);window.removeEventListener('scroll',place,true);window.removeEventListener('pointerdown',outside,true);window.removeEventListener('dsh-menu-open',other);resetSearch();};
  },[expanded,open,above,align]);
  useLayoutEffect(()=>{
    if(!expanded){lastFocused.current=null;return;}
    const prior=lastFocused.current,active=document.activeElement;
    // A native update can disable/remove the focused option. Chromium then
    // focuses body, so keep keyboard dismissal available without stealing an
    // intentional focus change to another control.
    if(prior&&(prior.disabled||!menu.current?.contains(prior))&&(active===document.body||menu.current?.contains(active)))focusEdge('first');
  });
  function leaveByTab(backward){
    // The menu lives in a portal. Continue from its opener in the page's tab
    // order instead of jumping from the end of document.body.
    const scope=button.current?.closest('dialog[open]')??document;
    const entries=[...scope.querySelectorAll('a[href],button,input,select,textarea,[tabindex],[contenteditable="true"]')].filter(element=>{
      if(menu.current?.contains(element)||element.tabIndex<0||element.matches(':disabled')||element.closest('[inert]')||!element.getClientRects().length)return false;
      const visibility=window.getComputedStyle(element).visibility;return visibility!=='hidden'&&visibility!=='collapse';
    }).map((element,index)=>({element,index})).sort((a,b)=>{
      const first=a.element.tabIndex,second=b.element.tabIndex;
      return first>0&&second>0?first-second||a.index-b.index:first>0?-1:second>0?1:a.index-b.index;
    }).map(entry=>entry.element);
    const index=entries.indexOf(button.current),next=index<0?(backward?entries.at(-1):entries[0]):entries[(index+(backward?-1:1)+entries.length)%entries.length];
    close(false);next?.focus();
  }
  function fold(value){try{return value.toLocaleLowerCase(document.documentElement?.lang||undefined);}catch{return value.toLocaleLowerCase();}}
  function keys(event){
    if(isComposing(event))return;
    if(event.key==='Escape'){event.stopPropagation();event.preventDefault();close();return;}
    if(event.key==='Tab'){event.preventDefault();leaveByTab(event.shiftKey);return;}
    const entries=options(),index=entries.indexOf(document.activeElement);let next;
    if(event.key==='ArrowDown')next=(index+1)%entries.length;
    if(event.key==='ArrowUp')next=index<0?entries.length-1:(index-1+entries.length)%entries.length;
    if(event.key==='Home')next=0;if(event.key==='End')next=entries.length-1;
    if(next!==undefined){event.preventDefault();if(entries.length)entries[next].focus();return;}
    if(event.key.length===1&&!event.metaKey&&!event.ctrlKey&&!event.altKey&&event.key!==' '){
      const key=fold(event.key),prior=typeahead.current;
      typeahead.current=prior&&[...prior].every(char=>char===key)?key:prior+key;
      clearTimeout(typeaheadTimer.current);typeaheadTimer.current=setTimeout(()=>{typeahead.current='';typeaheadTimer.current=null;},600);
      const start=typeahead.current.length===1?index+1:Math.max(0,index);
      const ordered=[...entries.slice(start),...entries.slice(0,start)];
      const target=ordered.find(option=>fold(option.getAttribute?.('data-menu-label')??option.textContent.trim()).startsWith(typeahead.current));
      if(target){event.preventDefault();target.focus();}
    }
  }
  return <div ref={root} className={`dropdown ${className}`}>{contextTrigger?React.cloneElement(trigger,{ref:button,'aria-haspopup':'menu','aria-expanded':expanded,'aria-controls':expanded?id:undefined,onContextMenu:event=>{event.preventDefault();show();},onKeyDown:event=>{if(event.key==='ContextMenu'||event.shiftKey&&event.key==='F10'){event.preventDefault();show();}else trigger.props.onKeyDown?.(event);}}):(<button ref={button} type="button" className="dropdown-trigger" disabled={disabled} title={label} aria-label={label} aria-haspopup="menu" aria-expanded={expanded} aria-controls={expanded?id:undefined} onClick={()=>expanded?close(false):show()} onKeyDown={event=>{if(isComposing(event))return;if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();show(event.key==='ArrowUp'?'last':'first');}}}>{trigger}</button>)}{expanded?createPortal(<div ref={menu} id={id} role="menu" tabIndex={-1} aria-label={label} style={position} className={`floating-menu menu-portal ${className} ${above?'above':''} ${align==='right'?'align-right':''}`} onFocusCapture={event=>{lastFocused.current=event.target;}} onKeyDown={keys}>{typeof children==='function'?children(close):children}</div>,document.body):null}</div>;
}
export function MenuItem({icon:Icon,label,detail,checked,onClick,disabled=false,shortcut,danger=false}){
  return <button type="button" role={checked===undefined?'menuitem':'menuitemradio'} data-menu-label={label} aria-checked={checked} disabled={disabled} className={`floating-menu-item ${danger?'danger':''}`} onClick={onClick}>{Icon?<Icon size={16} strokeWidth={1.65}/>:null}<span className="menu-copy"><span>{label}</span>{detail?<small>{detail}</small>:null}</span>{checked?<Check size={15}/>:shortcut?<kbd>{shortcut}</kbd>:null}</button>;
}
export function MenuLabel({children}){return <div className="floating-menu-label">{children}</div>;}
export function MenuDivider(){return <div className="floating-menu-divider" role="separator"/>;}
