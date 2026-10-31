import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {transform} from 'esbuild';
import React from 'react';
import {DocumentSession} from '../src/lib/document-session.js';
import {indexDocument,resolveDocumentLocation} from '../src/lib/document-location.js';

const file=new URL('../src/main.jsx',import.meta.url),require=createRequire(file),marker='  function navigate(id, record = true) {';
const raw=await readFile(file,'utf8');assert.equal(raw.split(marker).length,2);
const code=await transform(raw.replace(marker,'  captureProbe({openFile,documentSession,setDocumentLocation,setDocumentEditing,setUnsavedAction,cancelUnsaved,setError,documentDraftSync});\n'+marker)+'\nexport {App};',{loader:'jsx',format:'cjs'});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const disk=(projectId,path,content='first\r\n中文😀z\r\nlast')=>({projectId,path,name:path.split('/').at(-1),content,version:'disk-'+projectId+'-'+path});
function app({initialFile=null,dirty=false,read}={}){
  const session=new DocumentSession({file:initialFile,dirty}),calls=[],effects=[];let probe,index=0;const module={exports:{}};
  const state={projects:[{id:'A',path:'/projects/A',name:'A'},{id:'B',path:'/projects/B',name:'B'}],sessions:[],engine:{state:'ready',capabilities:{}},features:['feature-files']};
  const react={...React,useEffect:fn=>effects.push(fn),useLayoutEffect(){},useRef:current=>({current}),useState(initial){const key=index++;let value=typeof initial==='function'?initial():initial;if(value instanceof DocumentSession)value=session;if(key===0)value='en';if(key===2)value=state;const setter=next=>setter.calls.push(next);setter.calls=[];return [value,setter];}};
  const dependency=id=>id==='react'?react:id.endsWith('.css')?{}:id==='./api.js'?{api:async(route,body)=>{calls.push({route,body});return read(route,body);}}:id.endsWith('.jsx')?new Proxy({},{get:(_,name)=>name==='__esModule'?true:()=>null}):require(id);
  new Function('require','module','exports','localStorage','window','document','captureProbe',code.code)(dependency,module,module.exports,{getItem:()=>null,setItem(){},removeItem(){}},{},{},value=>{probe=value;});
  module.exports.App({registerCleanup(){}});assert.equal(probe.documentSession,session);return {...probe,calls,dispose:()=>probe.documentDraftSync.dispose()};
}
function fileResponse(route){if(route.startsWith('document-drafts?'))return {draft:null};const match=/^projects\/([^/]+)\/file\?path=(.*)$/.exec(route);assert.ok(match,route);return disk(decodeURIComponent(match[1]),decodeURIComponent(match[2]));}

test('actual same-file dirty citations locate the unsaved buffer without reading or asking to discard it',async()=>{
  const existing=disk('A','src/a.js','first\r\n中文😀UNSAVED\r\nlast'),fixture=app({initialFile:existing,dirty:true,read:()=>{throw Error('MUST_NOT_READ');}});
  try{assert.equal(await fixture.openFile('src/a.js','A',{line:2,column:3}),true);assert.deepEqual(fixture.calls,[]);assert.equal(fixture.setUnsavedAction.calls.length,0);assert.equal(fixture.documentSession.snapshot().file.content,existing.content);assert.equal(fixture.documentSession.snapshot().dirty,true);assert.deepEqual(fixture.setDocumentLocation.calls.at(-1),{line:2,column:3,projectId:'A',path:'src/a.js',request:1});assert.equal(fixture.setDocumentEditing.calls.at(-1),true);
    assert.equal(await fixture.openFile('src/a.js','A'),true);assert.equal(fixture.setDocumentLocation.calls.at(-1),null);assert.deepEqual(fixture.calls,[]);
  }finally{fixture.dispose();}
});

test('actual out-of-order opens cannot replace the newer document or attach the older citation location',async()=>{
  const first=deferred(),second=deferred(),fixture=app({read:route=>route.startsWith('document-drafts?')?{draft:null}:route.includes('path=first.js')?first.promise:second.promise});
  try{const a=fixture.openFile('first.js','A',{line:1}),b=fixture.openFile('second.js','B',{line:2,column:3,endLine:2,endColumn:4});second.resolve(disk('B','second.js'));assert.equal(await b,true);first.resolve(disk('A','first.js'));assert.equal(await a,false);assert.equal(fixture.documentSession.snapshot().file.projectId,'B');assert.equal(fixture.documentSession.snapshot().file.path,'second.js');assert.equal(fixture.setDocumentLocation.calls.length,1);
    const location=fixture.setDocumentLocation.calls[0];assert.deepEqual(location,{line:2,column:3,endLine:2,endColumn:4,projectId:'B',path:'second.js',request:1});const index=indexDocument(fixture.documentSession.snapshot().file.content),resolved=resolveDocumentLocation(index,location);assert.equal(index.text.slice(resolved.start,resolved.end),'😀');
  }finally{fixture.dispose();}
});

test('a current-buffer citation supersedes a pending different-file read and preserves edits made meanwhile',async()=>{
  const pending=deferred(),fixture=app({initialFile:disk('A','current.js'),read:route=>route.startsWith('document-drafts?')?{draft:null}:pending.promise});
  try{const opening=fixture.openFile('other.js','A',{line:1});fixture.documentSession.edit('first\r\nnew local text');assert.equal(await fixture.openFile('current.js','A',{line:2}),true);pending.resolve(disk('A','other.js'));assert.equal(await opening,false);assert.equal(fixture.documentSession.snapshot().file.path,'current.js');assert.equal(fixture.documentSession.snapshot().file.content,'first\r\nnew local text');assert.equal(fixture.documentSession.snapshot().dirty,true);assert.equal(fixture.setDocumentLocation.calls.at(-1).path,'current.js');assert.equal(fixture.setUnsavedAction.calls.length,0);
  }finally{fixture.dispose();}
});

test('same relative path in another project still prompts for dirty changes and cancellation never reads the other project',async()=>{
  const fixture=app({initialFile:disk('A','same.md','unsaved A'),dirty:true,read:fileResponse});
  try{const opening=fixture.openFile('same.md','B',{line:1});assert.equal(fixture.setUnsavedAction.calls.length,1);assert.deepEqual(fixture.calls,[]);fixture.cancelUnsaved();assert.equal(await opening,false);assert.equal(fixture.documentSession.snapshot().file.projectId,'A');assert.equal(fixture.documentSession.snapshot().file.content,'unsaved A');assert.equal(fixture.setDocumentLocation.calls.length,0);
  }finally{fixture.dispose();}
});

test('same relative path in a clean different project reads the captured project and binds its citation there',async()=>{
  const fixture=app({initialFile:disk('A','same.md'),read:fileResponse});try{assert.equal(await fixture.openFile('same.md','B',{line:2,column:3}),true);assert.equal(fixture.documentSession.snapshot().file.projectId,'B');assert.ok(fixture.calls.some(call=>call.route==='projects/B/file?path=same.md'));assert.equal(fixture.setDocumentLocation.calls.at(-1).projectId,'B');assert.equal(fixture.setUnsavedAction.calls.length,0);}finally{fixture.dispose();}
});

test('actual failed file reads retain the prior document and location, respecting act’s non-throwing failure contract',async()=>{
  const failure=Object.assign(new Error('fixture read failed'),{code:'READ_FAILED'}),initial=disk('A','current.txt'),fixture=app({initialFile:initial,read:async route=>{if(route.startsWith('document-drafts?'))return {draft:null};throw failure;}});
  try{const result=await fixture.openFile('missing.js','B',{line:3});assert.notEqual(result,true);assert.deepEqual(fixture.documentSession.snapshot().file,initial);assert.equal(fixture.setDocumentLocation.calls.length,0);assert.ok(fixture.setError.calls.includes('fixture read failed'));}finally{fixture.dispose();}
});

test('invalid citation positions are rejected by the real App before dirty prompting or any file read',async()=>{
  const fixture=app({initialFile:disk('A','current.js'),dirty:true,read:fileResponse});try{for(const location of [{line:0},{line:1,column:-1},{line:NaN},{line:Number.MAX_SAFE_INTEGER+1},{line:1,endColumn:2}])assert.equal(await fixture.openFile('other.js','B',location),false);assert.deepEqual(fixture.calls,[]);assert.equal(fixture.setUnsavedAction.calls.length,0);assert.equal(fixture.setDocumentLocation.calls.length,0);}finally{fixture.dispose();}
});

test('typing into the current editor while another file loads invalidates the old open token without requiring another citation',async()=>{
  const pending=deferred(),fixture=app({initialFile:disk('A','current.js'),read:route=>route.startsWith('document-drafts?')?{draft:null}:pending.promise});
  try{const opening=fixture.openFile('other.js','B',{line:2});fixture.documentSession.edit('preserve this newer buffer');pending.resolve(disk('B','other.js'));assert.equal(await opening,false);assert.equal(fixture.documentSession.snapshot().file.projectId,'A');assert.equal(fixture.documentSession.snapshot().file.content,'preserve this newer buffer');assert.equal(fixture.documentSession.snapshot().dirty,true);assert.equal(fixture.setDocumentLocation.calls.length,0);}finally{fixture.dispose();}
});
