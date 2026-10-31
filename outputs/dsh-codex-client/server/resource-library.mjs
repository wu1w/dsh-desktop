import {opendir,stat,readFile,writeFile,rename,mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {projectFile} from './files.mjs';

const excluded=new Set(['node_modules','vendor','dist','build','coverage','__pycache__']);
const fail=code=>{throw Object.assign(new Error(code),{code});};
export const resourceKey=(projectId,relative)=>JSON.stringify([projectId,relative]);
export function resourceKind(name){
  const extension=path.extname(name).toLowerCase();
  if(['.md','.mdx','.txt','.rtf','.doc','.docx','.pdf','.odt'].includes(extension))return 'pages';
  if(['.ppt','.pptx','.key','.odp'].includes(extension))return 'slides';
  if(['.html','.htm'].includes(extension))return 'sites';
  if(['.png','.jpg','.jpeg','.webp','.gif','.svg','.avif','.heic','.bmp','.tif','.tiff'].includes(extension))return 'images';
  return 'other';
}

// Bounded, on-demand inventory. Never follow directory symlinks or read file contents.
export async function listResources(projects,{signal,maxEntries=3000,maxVisited=15000,maxDirectories=1500}={}){
  const entries=[],unavailable=[];let visited=0,directories=0,truncated=false;
  for(const project of projects){
    if(signal?.aborted)throw signal.reason??new Error('ABORTED');
    const pending=[''];
    while(pending.length){
      if(signal?.aborted)throw signal.reason??new Error('ABORTED');
      if(entries.length>=maxEntries||visited>=maxVisited||directories>=maxDirectories){truncated=true;break;}
      const relative=pending.shift();let children;
      try{children=await opendir(await projectFile(project.path,relative));directories++;}
      catch{if(!unavailable.includes(project.id))unavailable.push(project.id);continue;}
      for await(const child of children){
        if(signal?.aborted)throw signal.reason??new Error('ABORTED');
        if(entries.length>=maxEntries||visited++>=maxVisited){truncated=true;break;}
        if(child.name.startsWith('.')||excluded.has(child.name)||child.isSymbolicLink())continue;
        const file=path.posix.join(relative,child.name);
        if(child.isDirectory()){pending.push(file);continue;}
        if(!child.isFile())continue;
        try{
          const metadata=await stat(await projectFile(project.path,file));
          if(metadata.isFile())entries.push({id:resourceKey(project.id,file),projectId:project.id,path:file,name:child.name,kind:resourceKind(child.name),size:metadata.size,modifiedAt:metadata.mtime.toISOString()});
        }catch{/* A concurrently removed file is absent from this snapshot. */}
      }
    }
    if(truncated)break;
  }
  return {entries:entries.sort((a,b)=>b.modifiedAt.localeCompare(a.modifiedAt)||a.path.localeCompare(b.path)),unavailable,truncated};
}

export class ResourceLibrary{
  constructor(dataDir){this.file=path.join(dataDir,'resource-library.json');this.records={};this.loaded=false;this.queue=Promise.resolve();}
  async load(){
    if(this.loaded)return;
    try{
      const info=await stat(this.file);if(info.size>4*1024*1024)fail('LIBRARY_STATE_INVALID');
      const data=JSON.parse(await readFile(this.file,'utf8'));
      if(data.version!==1||!data.records||typeof data.records!=='object'||Array.isArray(data.records)||Object.keys(data.records).length>20000)fail('LIBRARY_STATE_INVALID');
      for(const [key,value] of Object.entries(data.records)){
        const pair=JSON.parse(key);
        if(!Array.isArray(pair)||pair.length!==2||pair.some(x=>typeof x!=='string')||!value||typeof value!=='object'||Array.isArray(value))fail('LIBRARY_STATE_INVALID');
        if(value.favorite!==undefined&&typeof value.favorite!=='boolean'||value.hidden!==undefined&&typeof value.hidden!=='boolean'||value.openedAt!==undefined&&!Number.isFinite(Date.parse(value.openedAt)))fail('LIBRARY_STATE_INVALID');
      }
      this.records=data.records;
    }catch(error){if(error.code!=='ENOENT')fail('LIBRARY_STATE_INVALID');}
    this.loaded=true;
  }
  async snapshot(){await this.queue;await this.load();return {...this.records};}
  update(projectId,relative,patch){
    const operation=this.queue.then(async()=>{
      await this.load();const key=resourceKey(projectId,relative),record={...this.records[key]};
      if(patch.action==='open')record.openedAt=new Date().toISOString();
      else if(patch.action==='favorite'&&typeof patch.value==='boolean')record.favorite=patch.value;
      else if(patch.action==='hide')record.hidden=true;
      else if(patch.action==='restore')record.hidden=false;
      else fail('INVALID_REQUEST');
      const next={...this.records,[key]:record};if(Object.keys(next).length>20000)fail('LIBRARY_STATE_LIMIT');
      const bytes=JSON.stringify({version:1,records:next});if(Buffer.byteLength(bytes)>4*1024*1024)fail('LIBRARY_STATE_LIMIT');
      const temporary=this.file+'.'+randomUUID()+'.tmp';await mkdir(path.dirname(this.file),{recursive:true});
      try{await writeFile(temporary,bytes,{mode:0o600,flag:'wx'});await rename(temporary,this.file);}
      finally{await rm(temporary,{force:true}).catch(()=>{});}
      this.records=next;return record;
    });this.queue=operation.catch(()=>{});return operation;
  }
}

export async function createResource(project,name){
  if(typeof name!=='string'||!name.trim()||name!==name.trim()||name.length>160||/[\u0000-\u001f\u007f/\\]/.test(name)||name.startsWith('.'))fail('LIBRARY_NAME_INVALID');
  const relative=name.toLowerCase().endsWith('.md')?name:name+'.md';
  const target=await projectFile(project.path,relative,{create:true});
  try{await writeFile(target,'# '+name.replace(/\.md$/i,'')+'\n\n',{flag:'wx',mode:0o600});}
  catch(error){if(error.code==='EEXIST')fail('LIBRARY_FILE_EXISTS');throw error;}
  return {path:relative,projectId:project.id};
}
