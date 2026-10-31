import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {transform} from 'esbuild';
import React from 'react';
import {HistoryController} from '../src/lib/history-controller.js';
import {queueForSelection} from '../src/lib/session-view.js';

const file=new URL('../src/main.jsx',import.meta.url),require=createRequire(file);
const marker='  function navigate(id, record = true) {';
const raw=await readFile(file,'utf8');
assert.equal(raw.split(marker).length,2,'the probe must instrument the actual App navigation boundary once');
const code=await transform(raw.replace(marker,'  captureProbe({navigate,loadTranscript,selectedRef,historyController,setQueueSnapshot,setEngineMismatch,setError});\n'+marker)+'\nexport {App};',{loader:'jsx',format:'cjs'});
const projects=[{id:'project-A',path:'/projects/A',name:'A'},{id:'project-B',path:'/projects/B',name:'B'}];
const sessions=[{id:'session-A',projectId:'project-A',title:'A'},{id:'session-B',projectId:'project-B',title:'B'}];
const queueA=[{id:'queued-A',text:'Belongs only to A'}];
const responseA={items:[{id:'message-A',type:'agentMessage',text:'Answer A'}],running:false,engineMismatch:true,queue:queueA};

function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function appWithPendingTranscript(){
  const pending=deferred(),controller=new HistoryController();controller.select('session-A');
  const state={projects,sessions,engine:{state:'ready',capabilities:{}},selectedEngine:'codex'};
  const overrides=new Map([[0,'en'],[2,state],[3,true],[4,'session-A'],[6,controller],[7,controller.snapshot()],[8,{sessionId:'session-A',items:[]}]]);
  let index=0,probe;const module={exports:{}},requests=[];
  const react={...React,useEffect(){},useLayoutEffect(){},useRef:current=>({current}),useState(initial){const key=index++;const setter=value=>setter.calls.push(value);setter.calls=[];return [overrides.has(key)?overrides.get(key):typeof initial==='function'?initial():initial,setter];}};
  const dependency=id=>id==='react'?react:id.endsWith('.css')?{}:id==='./api.js'?{api(route){requests.push(route);assert.equal(route,'sessions/session-A');return pending.promise;}}:id.endsWith('.jsx')?new Proxy({},{get:(_,name)=>name==='__esModule'?true:()=>null}):require(id);
  const storage={getItem:()=>null,setItem(){},removeItem(){}};
  new Function('require','module','exports','localStorage','window','document','captureProbe',code.code)(dependency,module,module.exports,storage,{},{},value=>{probe=value;});
  module.exports.App({registerCleanup(){}});assert.ok(probe,'real App must expose its actual functions');probe.selectedRef.current='session-A';
  return {...probe,pending,requests};
}

for(const target of ['session-B',null]){
  test(`an A response after navigation to ${target??'a new chat'} cannot relabel its queue or overwrite engine mismatch before effects`,async()=>{
    const app=appWithPendingTranscript(),request=app.loadTranscript('session-A');
    assert.deepEqual(app.requests,['sessions/session-A']);app.navigate(target);
    // Navigation updates the ref immediately, while the actual history owner
    // still says A until React's passive selection effect. This is the race.
    assert.equal(app.selectedRef.current,target);assert.equal(app.historyController.sessionId,'session-A');
    const beforeQueue=app.setQueueSnapshot.calls.length,beforeMismatch=app.setEngineMismatch.calls.length;
    app.pending.resolve(responseA);await request;
    assert.equal(app.setQueueSnapshot.calls.length,beforeQueue,'old HTTP data must not be relabelled with the new selected ref');
    assert.equal(app.setEngineMismatch.calls.length,beforeMismatch,'old engine metadata must not disable the new chat');
    assert.deepEqual(queueForSelection({sessionId:'session-A',items:queueA},target),[]);
  });
}

test('the same A response still publishes its own queue and mismatch while A remains selected',async()=>{
  const app=appWithPendingTranscript(),request=app.loadTranscript('session-A');app.pending.resolve(responseA);await request;
  assert.deepEqual(app.setQueueSnapshot.calls.at(-1),{sessionId:'session-A',items:queueA});
  assert.equal(app.setEngineMismatch.calls.at(-1),true);
  assert.deepEqual(app.historyController.snapshot().items,responseA.items);
});

for(const target of ['session-B',null]){
  test(`an A network failure after navigation to ${target??'a new chat'} is discarded before effects`,async()=>{
    const app=appWithPendingTranscript(),request=app.loadTranscript('session-A');app.navigate(target);
    const before=app.setError.calls.length;app.pending.reject(Object.assign(new Error('OLD_A_NETWORK_FAILURE'),{code:'OLD_A_NETWORK_FAILURE'}));
    await assert.doesNotReject(request,'obsolete request failure must not escape into the newly selected view');
    assert.equal(app.setError.calls.length,before);
  });
}
