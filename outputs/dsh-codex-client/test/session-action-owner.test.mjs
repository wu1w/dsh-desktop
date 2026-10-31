import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {transform} from 'esbuild';
import React from 'react';

const file=new URL('../src/main.jsx',import.meta.url),require=createRequire(file),marker='  function navigate(id, record = true) {';
const source=await readFile(file,'utf8');assert.equal(source.split(marker).length,2);
const compiled=await transform(source.replace(marker,'  captureProbe({navigate,sessionAction,selectedRef,setSelected,setSessionMenu,setError,setChatDialog});\n'+marker)+'\nexport {App};',{loader:'jsx',format:'cjs'});
const projects=[{id:'project-A',path:'/fixtures/A',name:'A'},{id:'project-B',path:'/fixtures/B',name:'B'}];
const state={projects,sessions:[{id:'session-A',projectId:'project-A',title:'A'},{id:'session-B',projectId:'project-B',title:'B'}],engine:{state:'ready',capabilities:{}},selectedEngine:'codex'};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
function app({selected='session-A'}={}){
 const mutation=deferred(),refresh=deferred(),requests=[],module={exports:{}};let cursor=0,probe;
 const overrides=new Map([[0,'en'],[2,state],[3,true],[4,selected]]);
 const react={...React,useEffect(){},useLayoutEffect(){},useRef:current=>({current}),useState(initial){const index=cursor++,setter=value=>setter.calls.push(value);setter.calls=[];return[overrides.has(index)?overrides.get(index):typeof initial==='function'?initial():initial,setter];}};
 const dependency=id=>id==='react'?react:id.endsWith('.css')?{}:id==='./api.js'?{api(route,body){requests.push({route,body});if(route==='state')return refresh.promise;assert.match(route,/^sessions\/session-[AB]\/(archive|fork|pin|restore|unread|read)$/);return mutation.promise;}}:id.endsWith('.jsx')?new Proxy({},{get:(_,name)=>name==='__esModule'?true:()=>null}):require(id);
 new Function('require','module','exports','localStorage','window','document','captureProbe',compiled.code)(dependency,module,module.exports,{getItem:()=>null,setItem(){},removeItem(){}},{},{},value=>{probe=value;});module.exports.App({registerCleanup(){}});probe.selectedRef.current=selected;
 return{...probe,mutation,refresh,requests};
}
function move(app,target){if(target==='ABA'){app.navigate('session-B');app.navigate('session-A');}else if(target!==undefined)app.navigate(target);}
async function complete(app){app.mutation.resolve({id:'session-A-fork'});app.refresh.resolve(state);}
for(const action of['archive','fork'])for(const target of[undefined,'session-B',null,'ABA'])test(`${action} completion respects ${target===undefined?'unchanged owner':target===null?'new chat':target} navigation intent`,async()=>{
 const fixture=app(),operation=fixture.sessionAction(action);move(fixture,target);
 const selectedBefore=fixture.selectedRef.current,selectionCalls=fixture.setSelected.calls.length,menuCalls=fixture.setSessionMenu.calls.length;
 await complete(fixture);await operation;
 assert.equal(fixture.requests[0].route,`sessions/session-A/${action}`);assert.equal(fixture.requests.filter(entry=>entry.route==='state').length,1,'the real completed action must still refresh state');
 if(target===undefined){assert.equal(fixture.selectedRef.current,action==='archive'?null:'session-A-fork');assert.equal(fixture.setSessionMenu.calls.at(-1),false);}
 else{assert.equal(fixture.selectedRef.current,selectedBefore);assert.equal(fixture.setSelected.calls.length,selectionCalls);assert.equal(fixture.setSessionMenu.calls.length,menuCalls,'old completion cannot close a newly opened menu');}
});
for(const phase of['mutation','refresh'])for(const target of[undefined,'session-B','ABA'])test(`${phase} failure is shown only to its ${target===undefined?'unchanged owner':target} owner`,async()=>{
 const fixture=app(),operation=fixture.sessionAction('archive');move(fixture,target);const errorCalls=fixture.setError.calls.length;
 const failure=new Error(`fixture ${phase} failed`);
 if(phase==='mutation')fixture.mutation.reject(failure);else{fixture.mutation.resolve({});fixture.refresh.reject(failure);}
 await operation;
 if(target===undefined)assert.equal(fixture.setError.calls.at(-1),failure.message,'current refresh failure must remain visible, with no successful navigation');
 else assert.equal(fixture.setError.calls.length,errorCalls,'a stale failure cannot replace a new view error');
 assert.equal(fixture.selectedRef.current,target==='session-B'?'session-B':'session-A');
});
test('navigation while the refresh itself is pending also invalidates an old fork result',async()=>{
 const fixture=app(),operation=fixture.sessionAction('fork');fixture.mutation.resolve({id:'session-A-fork'});await Promise.resolve();assert.equal(fixture.requests.at(-1).route,'state');fixture.navigate('session-B');fixture.refresh.resolve(state);await operation;assert.equal(fixture.selectedRef.current,'session-B');
});
test('non-navigation actions cannot close a new owner menu, but still perform exactly one background write',async()=>{
 const fixture=app(),operation=fixture.sessionAction('pin');fixture.navigate('session-B');fixture.setSessionMenu(true);const calls=fixture.setSessionMenu.calls.length;await complete(fixture);await operation;assert.equal(fixture.setSessionMenu.calls.length,calls);assert.equal(fixture.requests.filter(entry=>entry.route==='sessions/session-A/pin').length,1);assert.equal(fixture.selectedRef.current,'session-B');
});
test('an unchanged pin action closes its own menu and keeps its current session',async()=>{
 const fixture=app(),operation=fixture.sessionAction('pin');await complete(fixture);await operation;assert.equal(fixture.setSessionMenu.calls.at(-1),false);assert.equal(fixture.selectedRef.current,'session-A');
});
for(const action of['rename','move'])test(`${action} still opens the current session dialog without a background write`,async()=>{
 const fixture=app();await fixture.sessionAction(action);assert.deepEqual(fixture.setChatDialog.calls.at(-1),{action,sessionId:'session-A'});assert.deepEqual(fixture.requests,[]);
});
test('an empty selection cannot perform a session action',async()=>{
 const fixture=app({selected:null});await fixture.sessionAction('archive');assert.deepEqual(fixture.requests,[]);assert.equal(fixture.selectedRef.current,null);
});

const submitCode=await transform(source.replace(marker,'  captureProbe({navigate,newChat,project,submit,selectedRef,setSelected,setProjectId,setError,setDrafts,setAttachmentDrafts,attachProjectFile,uploadFiles,attachmentUploadLock});\n'+marker)+'\nexport {App};',{loader:'jsx',format:'cjs'});
function descendants(value){if(Array.isArray(value))return value.flatMap(descendants);return !value||typeof value!=='object'?[]:[value,...descendants(value.props?.children)];}
function newChatApp({attachments=[],projectId='project-A'}={}){
 const creating=deferred(),turn=deferred(),upload=deferred(),requests=[],slots=[],refs=[],module={exports:{}};let stateIndex=0,refIndex=0,probe,tree;
 const initial={...state,sessions:[...state.sessions],features:['feature-chat','feature-files','feature-projects']},overrides=new Map([[0,'en'],[2,initial],[3,true],[4,null],[5,projectId],[10,{['new-'+(projectId??'none')]:'captured first message'}],[11,{['new-'+(projectId??'none')]:attachments}]]);
 const react={...React,useEffect(){},useLayoutEffect(){},useRef:current=>refs[refIndex++]??=({current}),useState(value){const index=stateIndex++;if(!slots[index]){const slot={value:overrides.has(index)?overrides.get(index):typeof value==='function'?value():value};slot.setter=next=>{slot.setter.calls.push(next);slot.value=typeof next==='function'?next(slot.value):next;};slot.setter.calls=[];slots[index]=slot;}return[slots[index].value,slots[index].setter];}};
 const dependency=id=>id==='react'?react:id.endsWith('.css')?{}:id==='./api.js'?{api(route,body){requests.push({route,body});if(route==='sessions')return creating.promise;if(route==='state')return Promise.resolve({...initial,sessions:[...initial.sessions,{id:'created-A',projectId,title:'Created A'}]});if(route==='sessions/created-A/turn')return turn.promise;if(route==='sessions/created-A')return Promise.resolve({items:[],queue:[],running:false});if(route==='projects/project-A/attachments')return upload.promise;throw Error('UNEXPECTED_API:'+route);}}:id.endsWith('.jsx')?new Proxy({},{get:(_,name)=>name==='__esModule'?true:()=>null}):require(id);
 class FileReaderFixture{readAsDataURL(){this.result='data:text/plain;base64,eA==';this.onload();}}
 new Function('require','module','exports','localStorage','window','document','FileReader','captureProbe',submitCode.code)(dependency,module,module.exports,{getItem:()=>null,setItem(){},removeItem(){}},{},{body:{inert:false},querySelector:()=>null},FileReaderFixture,value=>{probe=value;});
 function render(){stateIndex=0;refIndex=0;tree=module.exports.App({registerCleanup(){}});return tree;}
 render();probe.selectedRef.current=null;
 return{creating,turn,upload,requests,render,get probe(){return probe;},get draftValues(){return slots[10].value;},get attachmentValues(){return slots[11].value;},input(value){const textarea=descendants(tree).find(node=>node.type==='textarea'&&node.props['aria-describedby']==='composer-help');textarea.props.onChange({target:{value,style:{},scrollHeight:45}});render();},get visibleDraft(){return descendants(tree).find(node=>node.type==='textarea'&&node.props['aria-describedby']==='composer-help').props.value;},async creationDone(){creating.resolve({id:'created-A'});for(let index=0;index<8;index++)await Promise.resolve();render();},get turns(){return requests.filter(entry=>entry.route==='sessions/created-A/turn');}};
}
for(const target of['session-B','ABA'])test(`a first new-chat send continues once without stealing ${target} selection`,async()=>{
 const fixture=newChatApp(),operation=fixture.probe.submit();fixture.probe.navigate('session-B');if(target==='ABA')fixture.probe.navigate(null);fixture.render();fixture.input('fresh current-view draft');await fixture.creationDone();fixture.turn.resolve({});await operation;fixture.render();assert.equal(fixture.probe.selectedRef.current,target==='session-B'?'session-B':null);assert.equal(fixture.visibleDraft,'fresh current-view draft');assert.equal(fixture.turns.length,1);assert.equal(fixture.turns[0].body.text,'captured first message');
});
test('a new project selected without a session is also a different owner from the creating draft',async()=>{
 const fixture=newChatApp(),operation=fixture.probe.submit();fixture.probe.setProjectId('project-B');fixture.render();fixture.input('project B input');await fixture.creationDone();fixture.turn.resolve({});await operation;fixture.render();assert.equal(fixture.probe.selectedRef.current,null);assert.equal(fixture.visibleDraft,'project B input');assert.equal(fixture.turns.length,1);
});
test('returning to the original empty project after viewing another project does not revive a pending navigation intent',async()=>{
 const fixture=newChatApp(),operation=fixture.probe.submit();fixture.probe.setProjectId('project-B');fixture.render();fixture.probe.setProjectId('project-A');fixture.render();fixture.input('new project A draft');await fixture.creationDone();fixture.turn.resolve({});await operation;fixture.render();assert.equal(fixture.probe.selectedRef.current,null);assert.equal(fixture.visibleDraft,'new project A draft');assert.equal(fixture.turns.length,1);
});
test('new text entered during creation is promoted visibly and subsequent typing survives successful sending',async()=>{
 const fixture=newChatApp(),operation=fixture.probe.submit();fixture.input('next unsent message');await fixture.creationDone();assert.equal(fixture.probe.selectedRef.current,'created-A');assert.equal(fixture.visibleDraft,'next unsent message');assert.equal(Object.hasOwn(fixture.draftValues,'new-project-A'),false);fixture.input('newer unsent message');fixture.turn.resolve({});await operation;fixture.render();assert.equal(fixture.visibleDraft,'newer unsent message');assert.equal(Object.hasOwn(fixture.draftValues,'new-project-A'),false);assert.equal(fixture.turns.length,1);assert.equal(fixture.turns[0].body.text,'captured first message');
});
test('an unchanged first draft is cleared only from its promoted session after success',async()=>{
 const fixture=newChatApp(),operation=fixture.probe.submit();await fixture.creationDone();fixture.turn.resolve({});await operation;fixture.render();assert.equal(fixture.visibleDraft,'');assert.equal(Object.hasOwn(fixture.draftValues,'new-project-A'),false);assert.equal(fixture.turns.length,1);
});
test('new attachments selected during creation move with the draft and only captured sent files are cleared',async()=>{
 const sent={path:'sent.txt',name:'sent.txt',mime:''},fixture=newChatApp({attachments:[sent]}),operation=fixture.probe.submit();assert.equal(fixture.probe.attachProjectFile({path:'next.txt',name:'next.txt'}),true);fixture.render();await fixture.creationDone();fixture.turn.resolve({});await operation;fixture.render();assert.deepEqual(fixture.attachmentValues['created-A'].map(file=>file.path),['next.txt']);assert.equal(Object.hasOwn(fixture.attachmentValues,'new-project-A'),false);assert.deepEqual(fixture.turns[0].body.attachments,[sent]);
});
test('an upload started during creation and completed after promotion targets the same newly created draft',async()=>{
 const fixture=newChatApp(),operation=fixture.probe.submit(),upload=fixture.probe.uploadFiles({target:{files:[{name:'late.txt',type:'text/plain',size:1}],value:'chosen'}});for(let index=0;index<6;index++)await Promise.resolve();assert.ok(fixture.requests.some(entry=>entry.route==='projects/project-A/attachments'));await fixture.creationDone();fixture.turn.resolve({});await operation;fixture.upload.resolve({files:[{path:'.dsh/late.txt',name:'late.txt',mime:'text/plain'}]});await upload;fixture.render();assert.deepEqual(fixture.attachmentValues['created-A'].map(file=>file.path),['.dsh/late.txt']);assert.equal(Object.hasOwn(fixture.attachmentValues,'new-project-A'),false);assert.equal(fixture.probe.attachmentUploadLock.current,false);
});
test('a departed first draft does not retarget an upload into another project or session',async()=>{
 const fixture=newChatApp(),operation=fixture.probe.submit(),upload=fixture.probe.uploadFiles({target:{files:[{name:'late.txt',type:'text/plain',size:1}],value:'chosen'}});fixture.probe.navigate('session-B');fixture.render();await fixture.creationDone();fixture.turn.resolve({});await operation;fixture.upload.resolve({files:[{path:'.dsh/late.txt',name:'late.txt',mime:'text/plain'}]});await upload;fixture.render();assert.equal(fixture.probe.selectedRef.current,'session-B');assert.equal(fixture.attachmentValues['created-A'],undefined);assert.deepEqual(fixture.attachmentValues['new-project-A'].map(file=>file.path),['.dsh/late.txt']);assert.equal(fixture.attachmentValues['session-B'],undefined);
});
for(const target of[undefined,'session-B','ABA'])test(`a first-send turn failure remains visible only to ${target??'the self-promoted owner'}`,async()=>{
 const fixture=newChatApp(),operation=fixture.probe.submit();await fixture.creationDone();if(target){fixture.probe.navigate('session-B');if(target==='ABA')fixture.probe.navigate('created-A');fixture.render();}const before=fixture.probe.setError.calls.length;fixture.turn.reject(new Error('fixture turn failed'));await operation;fixture.render();if(target===undefined)assert.equal(fixture.probe.setError.calls.at(-1),'fixture turn failed');else assert.equal(fixture.probe.setError.calls.length,before);assert.equal(fixture.draftValues['created-A'],'captured first message');assert.equal(fixture.turns.length,1);
});
for(const target of[undefined,'session-B'])test(`a first-send creation failure is retained only for ${target??'the originating new draft'}`,async()=>{
 const fixture=newChatApp(),operation=fixture.probe.submit();if(target){fixture.probe.navigate(target);fixture.render();}const before=fixture.probe.setError.calls.length;fixture.creating.reject(new Error('fixture create failed'));await operation;if(target===undefined)assert.equal(fixture.probe.setError.calls.at(-1),'fixture create failed');else assert.equal(fixture.probe.setError.calls.length,before);assert.equal(fixture.draftValues['new-project-A'],'captured first message');assert.equal(fixture.turns.length,0);
});

test('a projectless first send creates one null-bound chat and retains ownership after promotion',async()=>{
 const f=newChatApp({projectId:null}),pending=f.probe.submit();assert.equal(f.requests[0].route,'sessions');assert.equal(f.requests[0].body.projectId,null);await f.creationDone();f.turn.resolve({});await pending;f.render();assert.equal(f.probe.selectedRef.current,'created-A');assert.equal(f.visibleDraft,'');assert.equal(f.turns.length,1);f.probe.setProjectId('project-B');f.render();assert.equal(f.probe.project,undefined,'a selected casual chat must never inherit a stale project preference');
});
test('global new chat clears project context while project-specific creation preserves it',()=>{
 const f=newChatApp();f.probe.newChat();f.render();assert.equal(f.probe.project,undefined);assert.equal(f.probe.selectedRef.current,null);f.probe.newChat('project-B');f.render();assert.equal(f.probe.project.id,'project-B');
});

test('sidebar action targets B without changing selected A or opening an A dialog',async()=>{const f=app();await f.sessionAction('rename','session-B');assert.deepEqual(f.setChatDialog.calls.at(-1),{action:'rename',sessionId:'session-B'});const operation=f.sessionAction('pin','session-B');await complete(f);await operation;assert.equal(f.requests[0].route,'sessions/session-B/pin');assert.equal(f.selectedRef.current,'session-A');});
