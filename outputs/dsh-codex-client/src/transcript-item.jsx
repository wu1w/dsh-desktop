import {cleanProgramText} from '../shared/session-programs.js';
import React from 'react';
import {Copy,Circle,LoaderCircle,TerminalSquare,Pencil,FileText} from 'lucide-react';
import {translator} from './i18n.js';
import {Markdown,FileReference} from './markdown.jsx';

// Stable item and action references let unrelated composer/state updates skip
// Markdown parsing while changed text, locale, ownership and capabilities render.
export const TranscriptItem=React.memo(function TranscriptItem({item,locale,projectId,projectPath,filesEnabled,onCopy,onOpenFile}){
  const t=translator(locale),openFile=filesEnabled&&typeof onOpenFile==='function'?(relative,location)=>onOpenFile(relative,projectId,location):null;
  const markdown={text:cleanProgramText(item.text),t,onCopy,projectPath,onOpenFile:openFile};
  return <article className={`transcript-item ${item.type}`} data-history-id={item.id}>
    {item.type==='userMessage'?<div className="user-bubble"><Markdown {...markdown}/></div>
      :item.type==='agentMessage'?<><Markdown {...markdown}/><div className="message-actions"><button type="button" className="icon-button " title={t('copy')} aria-label={t('copy')} onClick={()=>onCopy(cleanProgramText(item.text))}><Copy size={17} strokeWidth={1.65}/></button></div></>
        :item.type==='reasoning'?<details className="tool-event"><summary><Circle size={13}/>{t('thoughts')}</summary><Markdown {...markdown}/></details>
          :<details className={`tool-event ${item.type==='error'?'error-event':''}`}>
            <summary>{item.type==='commandExecution'?<TerminalSquare size={14}/>:<Pencil size={14}/>}<span>{t(item.type==='commandExecution'?'command':item.type==='fileChange'?'fileChange':item.type==='error'?'error':'tool')}</span>{item.running?<LoaderCircle size={13} className="spinner"/>:null}</summary>
            {item.command||item.text?<pre>{item.command??item.text}</pre>:null}
            {item.output?<pre>{item.output}</pre>:null}
            {(Array.isArray(item.paths)?item.paths:[]).filter(value=>typeof value==='string').map(target=><FileReference t={t} target={target} projectPath={projectPath} onOpenFile={openFile} key={target}><FileText size={13}/>{target}</FileReference>)}
          </details>}
  </article>;
});
