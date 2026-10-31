import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {transform} from 'esbuild';
import React from 'react';
import {translator} from '../src/i18n.js';
const file=new URL('../src/main.jsx',import.meta.url),require=createRequire(file),marker='  function navigate(id, record = true) {';
const raw=await readFile(file,'utf8');assert.equal(raw.split(marker).length,2);
const code=await transform(raw.replace(marker,'  captureProbe({attachProjectFile,uploadFiles,setAttachmentDrafts,attachmentDrafts,attachmentSelectionSnapshot,draftId,setUploading,uploading,setProjectId,setSelected,navigate,setFilePanel,setError,documentDraftSync,renderRef});\n'+marker)+'\nexport {App};',{loader:'jsx',format:'cjs'});
const t=translator('en'),entry=index=>({name:'file-'+index+'.txt',path:'docs/file-'+index+'.txt',mime:''});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function app({count=0,attachments=Array.from({length:count},(_,index)=>entry(index)),read=async()=>({files:[]}),FileReaderClass}={}){
  const slots=[],calls=[],readers=[],storage=new Map([['dsh-locale','en'],['dsh-attachment-drafts',JSON.stringify({'new-A':attachments})]]);let cursor=0,latest;
  const state={projects:[{id:'A',path:'/projects/A',name:'A'},{id:'B',path:'/projects/B',name:'B'}],sessions:[{id:'chat-A',projectId:'A',title:'A'}],engine:{state:'ready',capabilities:{}},features:['feature-files']};
  const react={...React,useEffect(){},useLayoutEffect(){},useRef(current){const key=cursor++;return slots[key]??=({current});},useState(initial){const key=cursor++;if(!(key in slots)){let value=typeof initial==='function'?initial():initial;if(value&&Array.isArray(value.projects)&&Array.isArray(value.sessions)&&value.engine)value=state;const slot={value};slot.setter=next=>{slot.setter.calls.push(next);slot.value=typeof next==='function'?next(slot.value):next;};slot.setter.calls=[];slots[key]=slot;}return [slots[key].value,slots[key].setter];}};
  class Reader{constructor(){readers.push(this);}readAsDataURL(file){this.file=file;this.result='data:text/plain;base64,eA==';queueMicrotask(()=>this.onload?.());}}
  const dependency=id=>id==='react'?react:id.endsWith('.css')?{}:id==='./api.js'?{api:async(route,body)=>{calls.push({route,body});return read(route,body);}}:id.endsWith('.jsx')?new Proxy({},{get:(_,name)=>name==='__esModule'?true:()=>null}):require(id),module={exports:{}};
  new Function('require','module','exports','localStorage','window','document','FileReader','captureProbe',code.code)(dependency,module,module.exports,{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},{},{},FileReaderClass??Reader,value=>{latest=value;});
  function render(){cursor=0;module.exports.App({registerCleanup(){}});}render();latest.setProjectId('A');render();
  return {get probe(){return latest;},calls,readers,render,get attachments(){return latest.attachmentSelectionSnapshot.current[latest.draftId]??[];},dispose(){latest.documentDraftSync.dispose();}};
}
function input(files){return {target:{files,value:'selected'}};}

test('49 attachments plus two same-tick project selections accepts only the first without a render gap',()=>{
 const fixture=app({count:49});try{assert.equal(fixture.probe.attachProjectFile(entry(49)),true);assert.equal(fixture.probe.attachProjectFile(entry(50)),false);assert.equal(fixture.attachments.length,50);fixture.render();assert.equal(fixture.probe.attachmentDrafts['new-A'].length,50);assert.equal(fixture.probe.attachmentDrafts['new-A'].at(-1).path,entry(49).path);assert.ok(fixture.probe.setError.calls.includes(t('fileAttachmentLimit',{count:'50'})));}finally{fixture.dispose();}
});
test('duplicate selection at the limit remains idempotent and can close the picker',()=>{
 const fixture=app({count:50});try{const before=fixture.probe.setFilePanel.calls.length;assert.equal(fixture.probe.attachProjectFile(entry(0)),true);assert.equal(fixture.attachments.length,50);assert.ok(fixture.probe.setFilePanel.calls.slice(before).includes(false));assert.equal(fixture.probe.setError.calls.length,0);}finally{fixture.dispose();}
});
test('invalid and over-limit relative paths or names cannot change attachment drafts',()=>{
 const fixture=app({count:1});try{const bad=[null,{},{name:'',path:'file'},{name:123,path:'file'},{name:'bad\0name',path:'file'},{name:'x'.repeat(257),path:'file'},{name:'file',path:''},{name:'file',path:'/outside'},{name:'file',path:'../outside'},{name:'file',path:'docs/../outside'},{name:'file',path:'a\0b'},{name:'file',path:'中'.repeat(1366)}];for(const value of bad)assert.equal(fixture.probe.attachProjectFile(value),false);assert.equal(fixture.attachments.length,1);assert.deepEqual(fixture.calls,[]);assert.ok(fixture.probe.setError.calls.every(message=>message===t('fileAttachmentInvalid')));}finally{fixture.dispose();}
});
test('literal POSIX backslashes and Windows-looking basenames retain their exact original attachment path',()=>{
 const fixture=app();try{for(const path of ['C:\\name.txt','notes\\..\\x'])assert.equal(fixture.probe.attachProjectFile({name:path,path}),true);assert.deepEqual(fixture.attachments.map(row=>row.path),['C:\\name.txt','notes\\..\\x']);}finally{fixture.dispose();}
});
test('switching project and chat draft identity does not copy attachments into the newly selected draft',()=>{
 const fixture=app({count:1});try{fixture.probe.setProjectId('B');fixture.render();assert.equal(fixture.probe.draftId,'new-B');assert.equal(fixture.attachments.length,0);assert.equal(fixture.probe.attachProjectFile(entry(2)),true);fixture.render();assert.equal(fixture.probe.attachmentDrafts['new-A'].length,1);assert.equal(fixture.probe.attachmentDrafts['new-B'][0].path,entry(2).path);fixture.probe.navigate('chat-A');fixture.render();assert.equal(fixture.probe.draftId,'chat-A');assert.equal(fixture.attachments.length,0);assert.equal(fixture.probe.attachProjectFile(entry(3)),true);fixture.render();assert.equal(fixture.probe.attachmentDrafts['chat-A'][0].path,entry(3).path);assert.equal(fixture.probe.attachmentDrafts['new-B'].length,1);}finally{fixture.dispose();}
});
test('an upload already in progress prevents project selection until its actual response completes',async()=>{
 const gate=deferred(),fixture=app({read:()=>gate.promise});try{const uploading=fixture.probe.uploadFiles(input([{name:'upload.txt',type:'text/plain',size:1}]));fixture.render();assert.equal(fixture.probe.uploading,true);assert.equal(fixture.probe.attachProjectFile(entry(1)),false);assert.equal(fixture.attachments.length,0);await tick();gate.resolve({files:[entry(100)]});await uploading;fixture.render();assert.equal(fixture.probe.uploading,false);assert.equal(fixture.probe.attachmentDrafts['new-A'][0].path,entry(100).path);}finally{fixture.dispose();}
});
test('an oversized upload selection is rejected before FileReader or any API call',async()=>{
 const fixture=app({count:49});try{await fixture.probe.uploadFiles(input([{name:'a.txt',size:1},{name:'b.txt',size:1}]));assert.equal(fixture.readers.length,0);assert.deepEqual(fixture.calls,[]);assert.equal(fixture.attachments.length,49);assert.ok(fixture.probe.setError.calls.includes(t('fileAttachmentLimit',{count:'50'})));}finally{fixture.dispose();}
});
test('an upload response checks the target draft after late concurrent changes and preserves another current project',async()=>{
 const gate=deferred(),fixture=app({count:49,read:()=>gate.promise});try{const uploading=fixture.probe.uploadFiles(input([{name:'upload.txt',type:'text/plain',size:1}]));await tick();fixture.probe.setAttachmentDrafts(old=>({...old,'new-A':Array.from({length:50},(_,index)=>entry(index))}));fixture.probe.setProjectId('B');fixture.render();gate.resolve({files:[entry(100)]});await uploading;fixture.render();assert.equal(fixture.probe.attachmentDrafts['new-A'].length,50);assert.equal(fixture.attachments.length,0);assert.ok(fixture.probe.setError.calls.includes(t('fileAttachmentLimit',{count:'50'})));}finally{fixture.dispose();}
});

test('a same-tick project selection reaching 50 also blocks a following upload before FileReader or API',async()=>{
 const fixture=app({count:49,read:async()=>({files:[entry(100)]})});try{assert.equal(fixture.probe.attachProjectFile(entry(49)),true);await fixture.probe.uploadFiles(input([{name:'upload.txt',type:'text/plain',size:1}]));fixture.render();assert.equal(fixture.probe.attachmentDrafts['new-A'].length,50,'selection and upload must share the same synchronous count boundary');assert.equal(fixture.readers.length,0);assert.deepEqual(fixture.calls,[]);}finally{fixture.dispose();}
});

test('starting an upload synchronously prevents a same-tick project selection before React renders uploading state',async()=>{
 const fixture=app({read:async()=>({files:[entry(100)]})});try{const uploading=fixture.probe.uploadFiles(input([{name:'upload.txt',type:'text/plain',size:1}]));const selected=fixture.probe.attachProjectFile(entry(1));await uploading;assert.equal(selected,false);fixture.render();assert.deepEqual(fixture.probe.attachmentDrafts['new-A'].map(value=>value.path),[entry(100).path]);}finally{fixture.dispose();}
});

test('two same-tick upload requests share a synchronous lock and create only one reader and request',async()=>{
 let request=0;const fixture=app({read:async()=>({files:[entry(100+(request++))]})});try{const first=fixture.probe.uploadFiles(input([{name:'a.txt',type:'text/plain',size:1}])),second=fixture.probe.uploadFiles(input([{name:'b.txt',type:'text/plain',size:1}]));await Promise.all([first,second]);fixture.render();assert.equal(fixture.readers.length,1);assert.equal(fixture.calls.length,1);assert.equal(fixture.probe.attachmentDrafts['new-A'].length,1);}finally{fixture.dispose();}
});

test('upload failure releases its synchronous lock and a retry can complete without losing existing attachments',async()=>{
 let attempt=0;const fixture=app({count:1,read:async()=>{if(++attempt===1)throw Error('fixture upload failed');return {files:[entry(100)]};}});try{assert.notEqual(await fixture.probe.uploadFiles(input([{name:'upload.txt',type:'text/plain',size:1}])),true);assert.equal(fixture.attachments.length,1);assert.ok(fixture.probe.setError.calls.includes('fixture upload failed'));assert.equal(await fixture.probe.uploadFiles(input([{name:'retry.txt',type:'text/plain',size:1}])),true);fixture.render();assert.equal(fixture.probe.uploading,false);assert.deepEqual(fixture.attachments.map(value=>value.path),[entry(0).path,entry(100).path]);assert.equal(fixture.calls.length,2);}finally{fixture.dispose();}
});
test('an empty upload selection clears the input without starting readers, requests or busy state',async()=>{
 const fixture=app({count:1});try{const event=input([]);assert.equal(await fixture.probe.uploadFiles(event),false);assert.equal(event.target.value,'');assert.equal(fixture.readers.length,0);assert.deepEqual(fixture.calls,[]);assert.equal(fixture.probe.setUploading.calls.length,0);assert.equal(fixture.attachments.length,1);}finally{fixture.dispose();}
});
test('a batch over 20 files is rejected before reading and leaves selection available',async()=>{
 const fixture=app();try{assert.equal(await fixture.probe.uploadFiles(input(Array.from({length:21},(_,index)=>({name:index+'.txt',type:'text/plain',size:1})))),false);assert.equal(fixture.readers.length,0);assert.deepEqual(fixture.calls,[]);assert.ok(fixture.probe.setError.calls.includes(t('fileUploadBatchLimit',{count:'20'})));assert.equal(fixture.probe.attachProjectFile(entry(1)),true);}finally{fixture.dispose();}
});
