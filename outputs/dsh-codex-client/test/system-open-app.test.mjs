import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {transform} from 'esbuild';
import React from 'react';
import {DocumentSession} from '../src/lib/document-session.js';
import {translator} from '../src/i18n.js';
const file=new URL('../src/main.jsx',import.meta.url),require=createRequire(file),marker='  function navigate(id, record = true) {';
const raw=await readFile(file,'utf8');assert.equal(raw.split(marker).length,2);
const code=await transform(raw.replace(marker,'  captureProbe({openDocumentExternally,externalOpenLock,openingDocument,setOpeningDocument,documentSession,syncDocument,saveDocument,discardDocumentChanges,cancelUnsaved,closeDocument,initialBoot,documentDraftSync,setError,setNotice});\n'+marker)+'\nexport {App};',{loader:'jsx',format:'cjs'});
const t=translator('en'),deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const disk=(projectId='A',path='notes.md',content='editor input')=>({projectId,path,name:path.split('/').at(-1),content,version:'disk-version'});
function nodes(value){if(Array.isArray(value))return value.flatMap(nodes);if(!value||typeof value!=='object')return [];return [value,...nodes(value.props?.children)];}
function app({dirty=false,open=async()=>({accepted:true}),writeFile,preferences=async()=>({})}={}){
  const initial=disk(),session=new DocumentSession({file:initial,dirty}),calls=[],slots=[],storage=new Map([['dsh-locale','en']]);if(dirty)storage.set('dsh-document-draft',JSON.stringify({file:initial}));let cursor=0,latest,tree,stored={...initial};
  const state={projects:[{id:'A',path:'/projects/A',name:'A'},{id:'B',path:'/projects/B',name:'B'}],sessions:[],engine:{state:'ready',capabilities:{}},features:['feature-files']};
  const react={...React,useEffect(){},useLayoutEffect(){},useRef(current){const key=cursor++;return slots[key]??=({current});},useState(initialValue){const key=cursor++;if(!(key in slots)){let value=typeof initialValue==='function'?initialValue():initialValue;if(value instanceof DocumentSession)value=session;if(value&&Array.isArray(value.projects)&&Array.isArray(value.sessions)&&value.engine)value=state;const slot={value};slot.setter=next=>{slot.setter.calls.push(next);slot.value=typeof next==='function'?next(slot.value):next;};slot.setter.calls=[];slots[key]=slot;}return [slots[key].value,slots[key].setter];}};
  const dependency=id=>id==='react'?react:id.endsWith('.css')?{}:id==='./api.js'?{api:async(route,body)=>{calls.push({route,body});if(route.endsWith('/open'))return open(route,body);if(/^projects\/[^/]+\/file$/.test(route)){if(writeFile)await writeFile(route,body);stored={...stored,content:body.content,version:'saved-version'};return {}; }if(route.includes('/file?'))return stored;if(route==='preferences')return preferences(body);if(route==='document-drafts/clear'||route==='document-drafts/save')return {};throw Error('UNEXPECTED_API:'+route);}}:id==='./lib/git-draft-sync.js'?{flushGitDrafts:async()=>{},subscribeGitDraftState:()=>()=>{}}:id.endsWith('.jsx')?new Proxy({},{get:(_,name)=>name==='__esModule'?true:()=>null}):require(id);
  const module={exports:{}};new Function('require','module','exports','localStorage','window','document','captureProbe',code.code)(dependency,module,module.exports,{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},{},{},value=>{latest=value;});
  function render(){cursor=0;tree=module.exports.App({registerCleanup(){}});latest.initialBoot.current=true;return tree;}render();
  return {get probe(){return latest;},session,calls,render,get tree(){return tree;},openButton(){return nodes(tree).find(node=>node.type==='button'&&node.props.onClick===latest.openDocumentExternally);},button(label){return nodes(tree).find(node=>node.type==='button'&&nodes(node.props.children).length===0&&React.Children.toArray(node.props.children).includes(label));},dispose(){latest.documentDraftSync.dispose();}};
}

test('real App locks before awaiting and duplicates cannot send a second launch; accepted notice uses captured target',async()=>{
  const gate=deferred(),fixture=app({open:()=>gate.promise});try{const opening=fixture.probe.openDocumentExternally();assert.deepEqual(fixture.probe.externalOpenLock.current,{projectId:'A',path:'notes.md',name:'notes.md'});assert.equal(fixture.calls.filter(call=>call.route.endsWith('/open')).length,1);assert.equal(await fixture.probe.openDocumentExternally(),false);fixture.render();assert.equal(fixture.openButton().props.disabled,true);
    fixture.session.completeOpen(fixture.session.beginOpen(),disk('B','other.md'));fixture.probe.syncDocument();fixture.render();gate.resolve({accepted:true});assert.equal(await opening,true);assert.deepEqual(fixture.calls.filter(call=>call.route.endsWith('/open')),[{route:'projects/A/open',body:{path:'notes.md'}}]);assert.ok(fixture.probe.setNotice.calls.includes(t('docOpenAccepted',{name:'notes.md'})));assert.equal(fixture.probe.externalOpenLock.current,null);fixture.render();assert.equal(fixture.openButton().props.disabled,false);
  }finally{fixture.dispose();}
});

test('dirty cancel sends nothing and releases both synchronous lock and pending state',async()=>{
  const fixture=app({dirty:true});try{const opening=fixture.probe.openDocumentExternally();assert.equal(fixture.calls.length,0);assert.equal(await fixture.probe.openDocumentExternally(),false);fixture.render();assert.equal(fixture.openButton().props.disabled,true);fixture.probe.cancelUnsaved();assert.equal(await opening,false);assert.equal(fixture.probe.externalOpenLock.current,null);fixture.render();assert.equal(fixture.probe.openingDocument,null);assert.equal(fixture.openButton().props.disabled,false);assert.equal(fixture.calls.length,0);assert.equal(fixture.session.snapshot().dirty,true);}finally{fixture.dispose();}
});

test('dirty Save and continue uses real save workflow before opening the captured file once',async()=>{
  const fixture=app({dirty:true});try{const opening=fixture.probe.openDocumentExternally();fixture.render();const save=fixture.button(t('saveAndContinue'));assert.ok(save,'actual dirty dialog must expose Save and continue');await save.props.onClick();assert.equal(await opening,true);const fileWrite=fixture.calls.findIndex(call=>call.route==='projects/A/file'),launch=fixture.calls.findIndex(call=>call.route==='projects/A/open');assert.ok(fileWrite>=0&&launch>fileWrite);assert.equal(fixture.calls[fileWrite].body.content,'editor input');assert.equal(fixture.session.snapshot().dirty,false);assert.equal(fixture.probe.externalOpenLock.current,null);assert.ok(fixture.probe.setNotice.calls.includes(t('docOpenAccepted',{name:'notes.md'})));}finally{fixture.dispose();}
});

test('dirty Discard and continue still opens the captured target after the real discard closes the editor',async()=>{
  const fixture=app({dirty:true});try{const opening=fixture.probe.openDocumentExternally();fixture.render();await fixture.probe.discardDocumentChanges();assert.equal(await opening,true);assert.equal(fixture.session.snapshot().file,null);assert.ok(fixture.calls.some(call=>call.route==='document-drafts/clear'));assert.ok(fixture.calls.some(call=>call.route==='preferences'));assert.deepEqual(fixture.calls.filter(call=>call.route.endsWith('/open')),[{route:'projects/A/open',body:{path:'notes.md'}}]);assert.equal(fixture.calls.some(call=>call.route==='projects/A/file'),false);assert.equal(fixture.probe.externalOpenLock.current,null);}finally{fixture.dispose();}
});

for(const response of [{accepted:false},{accepted:'true'},{}])test('non-accepted response '+JSON.stringify(response)+' never produces success and releases the lock',async()=>{
  let accepted=false;const fixture=app({open:async()=>accepted?{accepted:true}:response});try{assert.equal(await fixture.probe.openDocumentExternally(),false);assert.ok(fixture.probe.setError.calls.includes(t('docOpenUnconfirmed')));assert.ok(!fixture.probe.setNotice.calls.includes(t('docOpenAccepted',{name:'notes.md'})));assert.equal(fixture.probe.externalOpenLock.current,null);fixture.render();assert.equal(fixture.openButton().props.disabled,false);accepted=true;assert.equal(await fixture.probe.openDocumentExternally(),true);assert.equal(fixture.calls.filter(call=>call.route.endsWith('/open')).length,2);}finally{fixture.dispose();}
});

test('launch failure through the dirty-confirm wrapper is visible, returns false and permits retry',async()=>{
  const failure=Object.assign(new Error('fixture launcher failed'),{code:'UNKNOWN_FIXTURE_CODE'}),fixture=app({dirty:true,open:async()=>{throw failure;}});try{const opening=fixture.probe.openDocumentExternally();fixture.render();const save=fixture.button(t('saveAndContinue'));await save.props.onClick();assert.equal(await opening,false);assert.ok(fixture.probe.setError.calls.includes('fixture launcher failed'));assert.equal(fixture.probe.externalOpenLock.current,null);fixture.render();assert.equal(fixture.openButton().props.disabled,false);}finally{fixture.dispose();}
});

test('save failure keeps the dirty dialog and lock until cancellation and never launches the stale disk file',async()=>{
  const fixture=app({dirty:true,writeFile:async()=>{throw Error('fixture save failed');}});try{const opening=fixture.probe.openDocumentExternally();fixture.render();await fixture.button(t('saveAndContinue')).props.onClick();assert.equal(fixture.calls.some(call=>call.route.endsWith('/open')),false);assert.equal(fixture.session.snapshot().dirty,true);assert.ok(fixture.probe.externalOpenLock.current);fixture.render();fixture.probe.cancelUnsaved();assert.equal(await opening,false);assert.equal(fixture.probe.externalOpenLock.current,null);}finally{fixture.dispose();}
});

test('actual open button and function reject launch while an independent document save is pending',async()=>{
  const saving=deferred(),fixture=app({dirty:true,writeFile:()=>saving.promise});try{const save=fixture.probe.saveDocument();fixture.render();assert.equal(fixture.openButton().props.disabled,true);assert.equal(await fixture.probe.openDocumentExternally(),false);assert.equal(fixture.calls.some(call=>call.route.endsWith('/open')),false);saving.resolve();assert.equal(await save,true);fixture.render();assert.equal(fixture.openButton().props.disabled,false);}finally{fixture.dispose();}
});

test('actual open button and function reject launch during an independent discard recovery flush',async()=>{
  const preferences=deferred(),fixture=app({dirty:true,preferences:()=>preferences.promise});try{fixture.probe.closeDocument();fixture.render();const discarding=fixture.probe.discardDocumentChanges();fixture.render();assert.equal(fixture.openButton().props.disabled,true);assert.equal(await fixture.probe.openDocumentExternally(),false);assert.equal(fixture.probe.externalOpenLock.current,null);assert.equal(fixture.calls.some(call=>call.route.endsWith('/open')),false);preferences.resolve({});await discarding;assert.equal(fixture.session.snapshot().file,null);}finally{fixture.dispose();}
});

test('clean launcher errors release pending state and leave the current editor available',async()=>{
  const fixture=app({open:async()=>{throw Error('fixture clean launcher failed');}});try{assert.equal(await fixture.probe.openDocumentExternally(),false);assert.ok(fixture.probe.setError.calls.includes('fixture clean launcher failed'));assert.equal(fixture.probe.externalOpenLock.current,null);assert.equal(fixture.session.snapshot().file.path,'notes.md');fixture.render();assert.equal(fixture.openButton().props.disabled,false);assert.equal(fixture.probe.openingDocument,null);}finally{fixture.dispose();}
});
