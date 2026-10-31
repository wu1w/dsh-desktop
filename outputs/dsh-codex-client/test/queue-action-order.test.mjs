import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {transform} from 'esbuild';
import React from 'react';
import {HistoryController} from '../src/lib/history-controller.js';
const file=new URL('../src/main.jsx',import.meta.url),require=createRequire(file),raw=await readFile(file,'utf8'),marker='  function navigate(id, record = true) {';
assert.equal(raw.split(marker).length,2);
const compiled=await transform(raw.replace(marker,'  captureProbe({queueAction,selectedRef,setQueueSnapshot,queueRevision});\n'+marker)+'\nexport {App};',{loader:'jsx',format:'cjs'});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const old=[{id:'old-native',input:[{type:'text',text:'already consumed'}]}],latest=[{id:'new-native',input:[{type:'text',text:'new queue'}]}];
async function app({mutationFails=false}={}){
  const history=new HistoryController();history.select('A');const state={projects:[{id:'P',path:'/owned/project',name:'P'}],sessions:[{id:'A',projectId:'P',title:'A'}],engine:{state:'ready',capabilities:{}},selectedEngine:'codex'};
  const overrides=new Map([[0,'en'],[2,state],[3,true],[4,'A'],[6,history],[7,history.snapshot()],[8,{sessionId:'A',items:old}]]),effects=[],requests=[],get=deferred(),stream=deferred();let probe,index=0,listener;
  const react={...React,useEffect:callback=>effects.push(callback),useLayoutEffect(){},useRef:current=>({current}),useState(initial){const key=index++,setter=value=>setter.calls.push(value);setter.calls=[];return [overrides.has(key)?overrides.get(key):typeof initial==='function'?initial():initial,setter];}};
  const dependency=id=>id==='react'?react:id.endsWith('.css')?{}:id==='./api.js'?{
    api(route,body){requests.push({route,body});if(route==='sessions/A/queue/delete'){if(mutationFails)return Promise.reject(Object.assign(new Error('MUTATION_FAILED'),{code:'MUTATION_FAILED'}));return Promise.resolve({});}if(route==='sessions/A/queue')return get.promise;throw Error('UNEXPECTED '+route);},
    initCapability:async()=>({state}),eventStream:(callback,signal)=>{listener=callback;signal.addEventListener('abort',()=>stream.reject(Error('aborted')),{once:true});return stream.promise;},
  }:id.endsWith('.jsx')?new Proxy({},{get:(_,name)=>name==='__esModule'?true:()=>null}):require(id);
  const module={exports:{}},storage={getItem:()=>null,setItem(){},removeItem(){}};new Function('require','module','exports','localStorage','window','document','captureProbe',compiled.code)(dependency,module,module.exports,storage,{dispatchEvent:()=>true},{},value=>{probe=value;});module.exports.App({registerCleanup(){}});probe.selectedRef.current='A';
  const effect=effects.find(callback=>callback.toString().includes('initCapability')&&callback.toString().includes('eventStream'));assert.ok(effect);const cleanup=effect();await turn();assert.equal(typeof listener,'function');return {...probe,get,requests,emit:listener,cleanup};
}
for(const mutationFails of [false,true]){
  test(`actual App ${mutationFails?'failure recovery':'successful mutation'} queue GET cannot replace a newer native SSE snapshot`,async()=>{
    const fixture=await app({mutationFails});try{const pending=fixture.queueAction('delete',{id:'old-native'}).then(value=>({value}),error=>({error}));await turn();assert.equal(fixture.requests.filter(row=>row.route==='sessions/A/queue').length,1);
      fixture.emit({type:'queue',sessionId:'A',queue:latest});const calls=fixture.setQueueSnapshot.calls.length;assert.deepEqual(fixture.setQueueSnapshot.calls.at(-1),{sessionId:'A',items:latest});fixture.get.resolve({queue:old});const result=await pending;
      assert.equal(Boolean(result.error),mutationFails);assert.equal(fixture.setQueueSnapshot.calls.length,calls,'old HTTP result must not resurrect a consumed entry');assert.deepEqual(fixture.setQueueSnapshot.calls.at(-1),{sessionId:'A',items:latest});assert.equal(fixture.requests.filter(row=>row.body!==undefined).length,1,'mutation must never replay');
    }finally{fixture.cleanup();await turn();}
  });
  test(`actual App ${mutationFails?'failure recovery':'successful mutation'} queue GET is ignored after session selection changes`,async()=>{
    const fixture=await app({mutationFails});try{const pending=fixture.queueAction('delete',{id:'old-native'}).catch(()=>{});await turn();fixture.selectedRef.current='B';const calls=fixture.setQueueSnapshot.calls.length;fixture.get.resolve({queue:old});await pending;assert.equal(fixture.setQueueSnapshot.calls.length,calls);assert.equal(fixture.requests.filter(row=>row.body!==undefined).length,1);}finally{fixture.cleanup();await turn();}
  });
}
test('an uncontested actual App queue GET still publishes the authoritative response',async()=>{
  const fixture=await app();try{const pending=fixture.queueAction('delete',{id:'old-native'});await turn();fixture.get.resolve({queue:latest});await pending;assert.deepEqual(fixture.setQueueSnapshot.calls.at(-1),{sessionId:'A',items:latest});assert.equal(fixture.requests.filter(row=>row.body!==undefined).length,1);}finally{fixture.cleanup();await turn();}
});
