import React,{useEffect,useRef,useState} from 'react';
import {Terminal} from '@xterm/xterm';
import {FitAddon} from '@xterm/addon-fit';
import {Plus,X,Square,Copy,Eraser,LoaderCircle} from 'lucide-react';
import {api} from '../api.js';
import {TerminalController} from '../lib/terminal-controller.js';
import '@xterm/xterm/css/xterm.css';
import './local-tools.css';

export function TerminalPanel({project,t,locale,onClose}){
  const element=useRef(null),terminal=useRef(null),fit=useRef(null),tRef=useRef(t);tRef.current=t;
  const [snapshot,setSnapshot]=useState({terminals:[]}),[selection,setSelection]=useState(false),[warning,setWarning]=useState('');
  const [controller]=useState(()=>new TerminalController({request:(route,body,options)=>api(route,body,body===undefined?'GET':'POST',options),onChange:setSnapshot,onOutput:(data,meta)=>{if(meta.reset)terminal.current?.reset();if(meta.truncated)setWarning(tRef.current('ptyTruncated'));if(data)terminal.current?.write(data);}}));
  useEffect(()=>{
    const style=getComputedStyle(element.current),foreground=style.getPropertyValue('--text').trim()||'#25282c',background=style.getPropertyValue('--surface').trim()||'#ffffff';
    const instance=new Terminal({fontFamily:'SFMono-Regular, Menlo, Monaco, Consolas, monospace',fontSize:12,lineHeight:1.25,scrollback:2000,cursorBlink:false,allowProposedApi:false,allowTransparency:false,theme:{background,foreground,cursor:foreground,selectionBackground:'#93a9c94d'}});
    const addon=new FitAddon();instance.loadAddon(addon);instance.open(element.current);terminal.current=instance;fit.current=addon;
    const data=instance.onData(value=>void controller.input(value)),resize=instance.onResize(({cols,rows})=>controller.resize(cols,rows)),select=instance.onSelectionChange(()=>setSelection(instance.hasSelection()));
    const fitNow=()=>{if(element.current?.clientWidth&&element.current?.clientHeight)addon.fit();};
    const observer=new ResizeObserver(fitNow);observer.observe(element.current);fitNow();
    const themeObserver=new MutationObserver(()=>{const css=getComputedStyle(element.current);instance.options.theme={...instance.options.theme,background:css.getPropertyValue('--surface').trim(),foreground:css.getPropertyValue('--text').trim(),cursor:css.getPropertyValue('--text').trim()};});themeObserver.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme','class','style']});
    return()=>{observer.disconnect();themeObserver.disconnect();data.dispose();resize.dispose();select.dispose();controller.dispose();instance.dispose();terminal.current=null;};
  },[]);
  useEffect(()=>{setWarning('');void controller.project(project?.id??null);return()=>controller.dispose();},[project?.id]);
  useEffect(()=>{if(snapshot.selected&&terminal.current){fit.current?.fit();controller.resize(terminal.current.cols,terminal.current.rows);}},[snapshot.selected]);
  const message=error=>error?.code&&t(error.code)!==error.code?t(error.code):error?.message??t('ptyFailed');
  const error=snapshot.inputError??snapshot.resizeError??snapshot.error;
  return <section className="terminal-panel pty-panel" aria-label={t('terminal')}>
    <div className="terminal-header"><strong>{t('terminal')}</strong><span className="pty-project">{project?.name??t('chooseProject')}</span>
      <select aria-label={t('ptySessions')} value={snapshot.selected??''} disabled={snapshot.busy} onChange={event=>{setWarning('');controller.select(event.target.value);}}><option value="" disabled>{t('ptySessions')}</option>{snapshot.terminals.map((row,index)=><option key={row.id} value={row.id}>{t('ptySessionNumber',{count:new Intl.NumberFormat(locale).format(index+1)})}{row.status==='exited'?' · '+t('ptyExited'):''}</option>)}</select>
      <button className="icon-button" type="button" title={t('ptyNew')} aria-label={t('ptyNew')} disabled={!project||snapshot.busy} onClick={async()=>{await controller.create({cols:terminal.current?.cols??90,rows:terminal.current?.rows??12});terminal.current?.focus();}}>{snapshot.busy?<LoaderCircle className="spinner" size={14}/>:<Plus size={14}/>}</button>
      <button className="icon-button" type="button" title={t('ptyCopy')} aria-label={t('ptyCopy')} disabled={!selection} onClick={()=>navigator.clipboard.writeText(terminal.current?.getSelection()??'').catch(()=>setWarning(t('copyFailed')))}><Copy size={14}/></button>
      <button className="icon-button" type="button" title={t('ptyClear')} aria-label={t('ptyClear')} onClick={()=>terminal.current?.clear()}><Eraser size={14}/></button>
      <button className="icon-button" type="button" title={t('ptyStop')} aria-label={t('ptyStop')} disabled={snapshot.terminal?.status!=='running'||snapshot.busy} onClick={()=>controller.stop()}><Square size={12}/></button>
      <button className="icon-button" type="button" title={t('ptyHide')} aria-label={t('ptyHide')} onClick={onClose}><X size={15}/></button>
    </div>
    {error?<div className="local-tool-error" role="alert">{message(error)}</div>:null}
    {warning?<div className="local-tool-note" role="status">{warning}</div>:null}
    {!snapshot.selected?<div className="pty-empty"><span>{snapshot.busy?t('loading'):t('ptyStartHelp')}</span>{project&&!snapshot.busy?<button type="button" className="subtle-button" onClick={()=>controller.create({cols:terminal.current?.cols??90,rows:terminal.current?.rows??12})}>{t('ptyNew')}</button>:null}</div>:null}
    <div className={`pty-viewport ${snapshot.selected?'':'pty-idle'}`} ref={element}/>
    <footer className="local-tool-note">{snapshot.terminal?.status==='exited'?t('ptyExitCode',{code:snapshot.terminal.exitCode??snapshot.terminal.signal??'—'}):t('ptyLocalHelp')}</footer>
  </section>;
}
