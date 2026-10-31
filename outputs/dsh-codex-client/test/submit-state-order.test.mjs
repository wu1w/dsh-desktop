import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {transform} from 'esbuild';
import React from 'react';
import {HistoryController} from '../src/lib/history-controller.js';
const file=new URL('../src/main.jsx',import.meta.url),require=createRequire(file),raw=await readFile(file,'utf8'),marker='  function navigate(id, record = true) {';assert.equal(raw.split(marker).length,2);
const compiled=await transform(raw.replace(marker,'  captureProbe({submit,navigate,selectedRef,historyController,setHistorySnapshot,setError});\n'+marker)+'\nexport {App};',{loader:'jsx',format:'cjs'});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};},turn=()=>new Promise(resolve=>setImmediate(resolve));
async function until(check){for(let count=0;count<50;count++){if(check())return;await turn();}assert.fail('fixture did not reach its bounded API gate');}
async function app({newSession=false,selectedBeforePost=false}={}){
  const history=new HistoryController();history.select(newSession?null:'A');if(!newSession)history.completeInitial(history.beginInitial(),{items:[],running:false});
  const selected=newSession?null:'A',draftId=newSession?'new-P':'A',state={projects:[{id:'P',path:'/owned/project',name:'P'}],sessions:[{id:'A',projectId:'P',title:'A'},{id:'B',projectId:'P',title:'B'}],engine:{state:'ready',capabilities:{}},selectedEngine:'codex',features:['feature-chat']};
  const overrides=new Map([[0,'en'],[2,state],[3,true],[4,selected],[5,'P'],[6,history],[7,history.snapshot()],[8,{sessionId:selected,items:[]}],[10,{[draftId]:'owned draft'}]]),effects=[],requests=[],post=deferred(),read=deferred(),stream=deferred();let probe,index=0,listener;
  const react={...React,useEffect:callback=>effects.push(callback),useLayoutEffect(){},useMemo:callback=>callback(),useCallback:callback=>callback,useRef:current=>({current}),useState(initial){const key=index++,setter=value=>setter.calls.push(value);setter.calls=[];return [overrides.has(key)?overrides.get(key):typeof initial==='function'?initial():initial,setter];}};
  const dependency=id=>id==='react'?react:id.endsWith('.css')?{}:id==='./api.js'?{
    api(route,body){requests.push({route,body});if(route==='sessions')return Promise.resolve({id:'A',projectId:'P'});if(route==='state'){if(selectedBeforePost)history.select('A');return Promise.resolve(state);}if(route==='sessions/A/turn')return post.promise;if(route==='sessions/A')return read.promise;throw Error('UNEXPECTED '+route);},
    initCapability:async()=>({state}),eventStream:(callback,signal)=>{listener=callback;signal.addEventListener('abort',()=>stream.reject(Error('aborted')),{once:true});return stream.promise;},
  }:id.endsWith('.jsx')?new Proxy({},{get:(_,name)=>name==='__esModule'?true:()=>null}):require(id);
  const module={exports:{}},storage={getItem:()=>null,setItem(){},removeItem(){}};new Function('require','module','exports','localStorage','window','document','captureProbe',compiled.code)(dependency,module,module.exports,storage,{dispatchEvent:()=>true},{},value=>{probe=value;});module.exports.App({registerCleanup(){}});probe.selectedRef.current=selected;
  const effect=effects.find(callback=>callback.toString().includes('initCapability')&&callback.toString().includes('eventStream'));assert.ok(effect);const cleanup=effect();await turn();return {...probe,history,post,read,requests,emit:listener,cleanup};
}
for(const newSession of [false,true])for(const running of [false,true]){
  test(`actual App ${newSession?'new':'existing'} session ACK preserves a newer native ${running?'start':'completion'} even when the read fails`,async()=>{
    const f=await app({newSession});try{const pending=f.submit({preventDefault(){}});await until(()=>f.requests.some(row=>row.route==='sessions/A/turn'));
      f.emit({type:'session',sessionId:'A',items:[{id:'native-answer',type:'agentMessage',text:'Native observation',running}],running});assert.equal(f.history.snapshot().running,running);const live=f.history.liveSequence;
      f.post.resolve({turn:{id:'turn-A'}});await until(()=>f.requests.some(row=>row.route==='sessions/A'));assert.equal(f.history.snapshot().running,running);assert.equal(f.history.liveSequence,live,'HTTP ACK must not create a competing live observation');f.read.reject(Error('READ_FAILED'));await pending;
      assert.equal(f.history.snapshot().running,running);assert.equal(f.setError.calls.at(-1),'READ_FAILED');assert.equal(f.requests.filter(row=>row.route==='sessions/A/turn').length,1);
    }finally{f.cleanup();await turn();}
  });
}
test('normal existing-session ACK can show optimistic running before the authoritative read completes',async()=>{
  const f=await app();try{const pending=f.submit({preventDefault(){}});await until(()=>f.requests.some(row=>row.route==='sessions/A/turn'));f.post.resolve({turn:{id:'turn-A'}});await until(()=>f.requests.some(row=>row.route==='sessions/A'));assert.equal(f.history.snapshot().running,true);f.read.resolve({items:[],running:false,queue:[]});await pending;assert.equal(f.history.snapshot().running,false);assert.equal(f.requests.filter(row=>row.route==='sessions/A/turn').length,1);}finally{f.cleanup();await turn();}
});
test('new session with no selected history at POST time waits for a read instead of guessing running across selection effects',async()=>{
  const f=await app({newSession:true});try{const pending=f.submit({preventDefault(){}});await until(()=>f.requests.some(row=>row.route==='sessions/A/turn'));assert.equal(f.history.sessionId,null);f.history.select('A');f.post.resolve({turn:{id:'turn-A'}});await until(()=>f.requests.some(row=>row.route==='sessions/A'));assert.equal(f.history.snapshot().running,false);f.read.resolve({items:[],running:true,queue:[]});await pending;assert.equal(f.history.snapshot().running,true);assert.equal(f.requests.filter(row=>row.route==='sessions/A/turn').length,1);}finally{f.cleanup();await turn();}
});
test('new session selected before POST can use the same uncontested ACK path',async()=>{
  const f=await app({newSession:true,selectedBeforePost:true});try{const pending=f.submit({preventDefault(){}});await until(()=>f.requests.some(row=>row.route==='sessions/A/turn'));assert.equal(f.history.sessionId,'A');f.post.resolve({turn:{id:'turn-A'}});await until(()=>f.requests.some(row=>row.route==='sessions/A'));assert.equal(f.history.snapshot().running,true);f.read.resolve({items:[],running:false,queue:[]});await pending;assert.equal(f.history.snapshot().running,false);}finally{f.cleanup();await turn();}
});
test('a changed history epoch for the same session prevents an old ACK from changing its new observation',async()=>{
  const f=await app();try{const pending=f.submit({preventDefault(){}});await until(()=>f.requests.some(row=>row.route==='sessions/A/turn'));f.history.select('B');f.history.select('A');f.post.resolve({turn:{id:'turn-A'}});await until(()=>f.requests.some(row=>row.route==='sessions/A'));assert.equal(f.history.snapshot().running,false);f.read.reject(Error('READ_FAILED'));await pending;assert.equal(f.history.snapshot().running,false);assert.equal(f.requests.filter(row=>row.route==='sessions/A/turn').length,1);}finally{f.cleanup();await turn();}
});
test('navigating away before ACK neither resurrects the old session nor starts a read for it',async()=>{
  const f=await app();try{const pending=f.submit({preventDefault(){}});await until(()=>f.requests.some(row=>row.route==='sessions/A/turn'));f.navigate('B');f.history.select('B');f.history.applyLive([{id:'B-native',type:'agentMessage',text:'B'}],{running:false});f.post.resolve({turn:{id:'turn-A'}});await pending;assert.equal(f.history.sessionId,'B');assert.equal(f.history.snapshot().running,false);assert.deepEqual(f.history.snapshot().items.map(row=>row.id),['B-native']);assert.equal(f.requests.filter(row=>row.route==='sessions/A').length,0);assert.equal(f.requests.filter(row=>row.route==='sessions/A/turn').length,1);}finally{f.cleanup();await turn();}
});
