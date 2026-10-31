import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {transform} from 'esbuild';
import React from 'react';
import {DocumentSession} from '../../src/lib/document-session.js';
import {translator} from '../../src/i18n.js';

// Execute the real App functions with persistent React hook slots. All I/O is
// intercepted at its API import; these tests never launch a system application.
const file=new URL('../../src/main.jsx',import.meta.url),require=createRequire(file),marker='  function navigate(id, record = true) {';
const raw=await readFile(file,'utf8');assert.equal(raw.split(marker).length,2);
const code=await transform(raw.replace(marker,'  captureProbe({openFile,openProjectFileExternally,openDocumentExternally,saveDocument,browseFiles,closeFileBrowser,flushDrafts,flushDocumentRecovery,documentSession,documentDraftSync,syncDocument,cancelUnsaved,setUnsavedAction,setDocumentLocation,setDocumentEditing,setProjectId,setState,setFileList,setFileBrowsing,fileBrowsing,fileBrowseRequest,browseRevision,setError,setNotice,externalOpenLock,openingDocument,initialBoot,imageRequestCache,transcriptActions,renderRef});\n'+marker)+'\nexport {App};',{loader:'jsx',format:'cjs'});
const t=translator('en');
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const disk=(projectId='A',path='notes.md',content='current document')=>({projectId,path,name:path.split('/').at(-1),content,version:'disk-'+projectId+'-'+path});
const metadata=(path='image.png')=>({path,name:path.split('/').at(-1),size:67108864,modifiedAt:'2026-10-24T01:02:03.000Z'});
const failure=code=>Object.assign(new Error('fixture '+code),{code});
const contentRoute=(projectId,path)=>`projects/${encodeURIComponent(projectId)}/file?path=${encodeURIComponent(path)}`;
const infoRoute=(projectId,path)=>`projects/${encodeURIComponent(projectId)}/file-info?path=${encodeURIComponent(path)}`;
async function until(check){for(let count=0;count<100;count++){if(check())return;await new Promise(resolve=>setTimeout(resolve,1));}assert.fail('controlled API request did not start');}
function nodes(value){if(Array.isArray(value))return value.flatMap(nodes);if(!value||typeof value!=='object')return [];return [value,...nodes(value.props?.children)];}

function app({initialFile=disk(),dirty=false,read,readDraft,clearDraft,open=async()=>({accepted:true}),draft=null}={}){
  const session=new DocumentSession({file:initialFile,dirty}),calls=[],slots=[],storage=new Map([['dsh-locale','en']]);
  if(dirty&&initialFile)storage.set('dsh-document-draft',JSON.stringify({file:initialFile}));
  const state={projects:[{id:'A',path:'/projects/A',name:'A'},{id:'B',path:'/projects/B',name:'B'}],sessions:[],engine:{state:'ready',capabilities:{}},features:['feature-files','feature-images']};
  let cursor=0,latest,tree;const jsxModules=new Map();
  const react={...React,useEffect(){},useLayoutEffect(){},useRef(current){const key=cursor++;return slots[key]??=({current});},useState(initialValue){const key=cursor++;if(!(key in slots)){let value=typeof initialValue==='function'?initialValue():initialValue;if(value instanceof DocumentSession)value=session;if(value&&Array.isArray(value.projects)&&Array.isArray(value.sessions)&&value.engine)value=state;const slot={value};slot.setter=next=>{slot.setter.calls.push(next);slot.value=typeof next==='function'?next(slot.value):next;};slot.setter.calls=[];slots[key]=slot;}return [slots[key].value,slots[key].setter];}};
  const dependency=id=>{
    if(id==='react')return react;
    if(id.endsWith('.css'))return {};
    if(id==='./api.js')return {api:async(route,body,method,options)=>{calls.push({route,body,method,options});if(route.endsWith('/open'))return open(route,body);if(route.startsWith('document-drafts?'))return readDraft?readDraft(route):{draft};if(route==='document-drafts/clear')return clearDraft?clearDraft(body):{};if(route==='document-drafts/save'||route==='preferences')return {};if(read)return read(route,body);throw Error('UNEXPECTED_API:'+route);}};
    if(id==='./lib/git-draft-sync.js')return {flushGitDrafts:async()=>{},subscribeGitDraftState:()=>()=>{}};
    if(id.endsWith('.jsx')){if(!jsxModules.has(id))jsxModules.set(id,new Proxy({},{get:(target,name)=>{if(name==='__esModule')return true;if(!target[name]){const component=function Stub(){return null;};component.componentName=name;component.importPath=id;target[name]=component;}return target[name];}}));return jsxModules.get(id);}
    return require(id);
  };
  const module={exports:{}};
  new Function('require','module','exports','localStorage','window','document','captureProbe',code.code)(dependency,module,module.exports,{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},{},{},value=>{latest=value;});
  function render(){cursor=0;tree=module.exports.App({registerCleanup(){}});latest.initialBoot.current=true;return tree;}
  render();
  return {get probe(){return latest;},session,calls,storage,render,get tree(){return tree;},nodes(){return nodes(tree);},componentNode(name){return nodes(tree).find(node=>node.type?.componentName===name);},dispose(){latest.documentDraftSync.dispose();}};
}

export {app,deferred,disk,metadata,contentRoute,failure,until};
