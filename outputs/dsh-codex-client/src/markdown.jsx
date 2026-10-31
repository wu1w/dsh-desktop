import React from 'react';
import {Copy} from 'lucide-react';
import {markdownLink} from './lib/markdown-links.js';
import {markdownInline} from './lib/markdown-inline.js';

export function FileReference({target,projectPath,documentPath,onOpenFile,label,children,className='file-chip',t=key=>key,disabled=false}){
  const link=markdownLink(target,{projectPath,documentPath}),content=children??label??(typeof target==='string'?target:'');
  if(link?.type==='file'&&typeof onOpenFile==='function')return <button type="button" className={className} title={link.path} aria-label={`${t('openFile')}: ${typeof label==='string'?label:typeof target==='string'?target:link.path}`} disabled={disabled} onClick={()=>{if(link.location)onOpenFile(link.path,link.location);else onOpenFile(link.path);}}>{content}</button>;
  return <span className={className}>{content}</span>;
}
export function MarkdownLink({label,target,projectPath,documentPath,onOpenFile,t}){
  const link=markdownLink(target,{projectPath,documentPath});
  if(link?.type==='external')return <a href={link.href} target="_blank" rel="noopener noreferrer">{label}</a>;
  return FileReference({target,projectPath,documentPath,onOpenFile,label,t,className:'markdown-file-link'});
}
function Inline({text='',...links}){
  return markdownInline(text).map((part,index)=>{
    if(part.kind==='code')return <code key={index}>{part.text}</code>;
    if(part.kind==='bold')return <strong key={index}>{part.text}</strong>;
    if(part.kind==='italic')return <em key={index}>{part.text}</em>;
    if(part.kind==='link')return <MarkdownLink key={index} label={part.text} target={part.target} {...links}/>;
    return <React.Fragment key={index}>{part.text}</React.Fragment>;
  });
}
function CodeBlock({language,text,t,onCopy}){
  return <div className="markdown-code"><div className="code-heading"><span>{language}</span><button type="button" aria-label={t('copyCode')} onClick={()=>onCopy(text)}><Copy size={13}/>{t('copy')}</button></div><pre><code>{text}</code></pre></div>;
}
function splitCells(line){return line.trim().replace(/^\||\|$/g,'').split(/(?<!\\)\|/).map(cell=>cell.trim().replace(/\\\|/g,'|'));}
export function Markdown({text='',t=key=>key,onCopy=()=>{},projectPath,documentPath,onOpenFile}){
  const links={projectPath,documentPath,onOpenFile,t};
  const lines=String(text).split('\n');const blocks=[];
  for(let index=0;index<lines.length;){
    const line=lines[index];
    if(/^\s*```/.test(line)){
      const language=line.replace(/^\s*```/,'').trim();const content=[];index++;
      while(index<lines.length&&!/^\s*```/.test(lines[index]))content.push(lines[index++]);
      if(index<lines.length)index++;
      blocks.push(<CodeBlock key={index} language={language} text={content.join('\n')} t={t} onCopy={onCopy}/>);continue;
    }
    const heading=/^(#{1,6})\s+(.*)$/.exec(line);
    if(heading){blocks.push(React.createElement(`h${heading[1].length}`,{key:index},<Inline text={heading[2]} {...links}/>));index++;continue;}
    if(/^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)){blocks.push(<hr key={index++}/>);continue;}
    if(line.includes('|')&&/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index+1]??'')){
      const headers=splitCells(line);const alignment=splitCells(lines[index+1]).map(cell=>cell.startsWith(':')&&cell.endsWith(':')?'center':cell.endsWith(':')?'right':'left');const rows=[];const first=index;index+=2;
      while(index<lines.length&&lines[index].includes('|')&&lines[index].trim())rows.push(splitCells(lines[index++]));
      blocks.push(<div className="markdown-table" key={first}><table><thead><tr>{headers.map((cell,i)=><th key={i} style={{textAlign:alignment[i]}}><Inline text={cell} {...links}/></th>)}</tr></thead><tbody>{rows.map((row,r)=><tr key={r}>{headers.map((_,c)=><td key={c} style={{textAlign:alignment[c]}}><Inline text={row[c]??''} {...links}/></td>)}</tr>)}</tbody></table></div>);continue;
    }
    const list=/^(\s*)([-*+] |\d+[.)] )(.*)$/.exec(line);
    if(list){const ordered=/\d/.test(list[2]);const rows=[];const first=index;
      while(index<lines.length){const entry=/^(\s*)([-*+] |\d+[.)] )(.*)$/.exec(lines[index]);if(!entry||/\d/.test(entry[2])!==ordered)break;rows.push(entry[3]);index++;}
      const List=ordered?'ol':'ul';blocks.push(<List key={first}>{rows.map((value,r)=><li key={r}><Inline text={value} {...links}/></li>)}</List>);continue;
    }
    if(/^>\s?/.test(line)){const quote=[];const first=index;while(index<lines.length&&/^>\s?/.test(lines[index]))quote.push(lines[index++].replace(/^>\s?/,''));blocks.push(<blockquote key={first}><Inline text={quote.join('\n')} {...links}/></blockquote>);continue;}
    if(!line.trim()){index++;continue;}
    const paragraph=[line];const first=index++;while(index<lines.length&&lines[index].trim()&&!/^(#{1,6}\s|\s*```|[-*+] |\d+[.)] |>\s?)/.test(lines[index])&&!(lines[index].includes('|')&&lines[index+1]?.includes('---')))paragraph.push(lines[index++]);
    blocks.push(<p key={first}><Inline text={paragraph.join('\n')} {...links}/></p>);
  }
  return <div className="markdown">{blocks}</div>;
}
