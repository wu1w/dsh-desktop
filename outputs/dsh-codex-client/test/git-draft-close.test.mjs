import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {transform} from 'esbuild';
import React from 'react';
import * as clientDrafts from '../src/lib/client-drafts.js';

const file=new URL('../src/main.jsx',import.meta.url),require=createRequire(file),marker='  function navigate(id, record = true) {';
const raw=await readFile(file,'utf8');assert.equal(raw.split(marker).length,2);
const code=await transform(raw.replace(marker,'  captureProbe({flushDrafts,initialBoot,setError,documentDraftSync});\n'+marker)+'\nexport {App};',{loader:'jsx',format:'cjs'});
const fault=code=>Object.assign(new Error(code),{code});
const documentFile={projectId:'project-A',path:'notes.md',name:'notes.md',content:'Unsaved document input',version:'disk-version'};

function app({gitFailure=null,documentFailure=null,withDocument=true,gitState={projects:[],pending:false,needsProtection:false,errorCode:null}}={}){
  const effects=[],listeners=new Map(),calls=[],saved=new Map(),local=new Map([['dsh-locale','en'],['dsh-drafts',JSON.stringify({'session-A':'Unsent chat input'})]]);
  if(withDocument)local.set('dsh-document-draft',JSON.stringify({file:documentFile}));
  const storage={getItem:key=>local.get(key)??null,setItem:(key,value)=>local.set(key,value),removeItem:key=>local.delete(key)};
  let probe,index=0;const module={exports:{}};
  const react={...React,useEffect:callback=>effects.push(callback),useLayoutEffect(){},useRef:current=>({current}),useState(initial){const key=index++;let value=typeof initial==='function'?initial():initial;if(key===0)value='en';if(value&&Array.isArray(value.projects)&&Object.hasOwn(value,'pending'))value=gitState;const setter=next=>setter.calls.push(next);setter.calls=[];return [value,setter];}};
  const window={addEventListener:(type,listener)=>listeners.set(type,listener),removeEventListener:(type,listener)=>{if(listeners.get(type)===listener)listeners.delete(type);}};
  const dependency=id=>id==='react'?react:id.endsWith('.css')?{}:id==='./api.js'?{api:async(route,body)=>{calls.push(route);if(route==='document-drafts/save'&&documentFailure)throw documentFailure;saved.set(route,body);return {};}}:id==='./lib/git-draft-sync.js'?{flushGitDrafts:async()=>{calls.push('git-flush');if(gitFailure)throw gitFailure;saved.set('git-flush',true);},subscribeGitDraftState:()=>()=>{}}:id==='./lib/client-drafts.js'?{...clientDrafts,flushClientDrafts:async options=>{calls.push('ordinary-flush');return clientDrafts.flushClientDrafts(options);}}:id.endsWith('.jsx')?new Proxy({},{get:(_,name)=>name==='__esModule'?true:()=>null}):require(id);
  new Function('require','module','exports','localStorage','window','document','captureProbe',code.code)(dependency,module,module.exports,storage,window,{},value=>{probe=value;});
  module.exports.App({registerCleanup(){}});assert.ok(probe);probe.initialBoot.current=true;
  return {...probe,calls,saved,local,listeners,effects,dispose:()=>probe.documentDraftSync.dispose()};
}

test('the actual App flush preserves chat and document recovery even when Git fails, then rejects close',async()=>{
  const failure=fault('GIT_DRAFT_WRITE_FAILED'),fixture=app({gitFailure:failure});
  try{
    await assert.rejects(fixture.flushDrafts(),error=>error===failure);
    assert.ok(fixture.calls.includes('ordinary-flush'));assert.equal(fixture.saved.get('preferences').drafts['session-A'],'Unsent chat input');
    assert.equal(fixture.saved.get('document-drafts/save').content,'Unsaved document input');
    assert.equal(fixture.setError.calls.length,1);assert.ok(typeof fixture.setError.calls[0]==='string');
  }finally{fixture.dispose();}
});

test('a document recovery failure still flushes Git and chat preferences before the actual App rejects close',async()=>{
  const failure=fault('DOCUMENT_RECOVERY_FAILED'),fixture=app({documentFailure:failure});
  try{
    await assert.rejects(fixture.flushDrafts(),error=>error===failure);
    assert.equal(fixture.saved.get('git-flush'),true);assert.equal(fixture.saved.get('preferences').drafts['session-A'],'Unsent chat input');assert.ok(fixture.setError.calls.length>=1);
  }finally{fixture.dispose();}
});

test('the actual App close flush resolves only after Git, chat and document stores all succeed',async()=>{
  const fixture=app();try{await assert.doesNotReject(fixture.flushDrafts());assert.equal(fixture.saved.get('git-flush'),true);assert.equal(fixture.saved.get('document-drafts/save').content,documentFile.content);assert.equal(fixture.saved.get('preferences').drafts['session-A'],'Unsent chat input');assert.equal(fixture.setError.calls.length,0);}finally{fixture.dispose();}
});

for(const [label,state,expected]of [
  ['unpersisted Git input',{projects:[{projectId:'A',dirty:true}],pending:true,needsProtection:true,errorCode:null},true],
  ['a pure old-store read error',{projects:[{projectId:'A',dirty:false,errorCode:'GIT_DRAFT_CORRUPT'}],pending:false,needsProtection:false,errorCode:'GIT_DRAFT_CORRUPT'},false],
]){
  test('the actual beforeunload listener '+(expected?'warns for ':'does not warn for ')+label,()=>{
    const fixture=app({withDocument:false,gitState:state});let cleanup;
    try{const effect=fixture.effects.filter(callback=>callback.toString().includes('beforeunload'));assert.equal(effect.length,1);cleanup=effect[0]();const listener=fixture.listeners.get('beforeunload');assert.equal(typeof listener,'function');let prevented=0;const event={returnValue:'unchanged',preventDefault(){prevented++;}};listener(event);assert.equal(prevented,expected?1:0);assert.equal(event.returnValue,expected?'':'unchanged');cleanup();assert.equal(fixture.listeners.has('beforeunload'),false);}finally{fixture.dispose();}
  });
}
