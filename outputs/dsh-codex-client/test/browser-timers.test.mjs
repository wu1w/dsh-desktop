import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {transform} from 'esbuild';
const turn=()=>new Promise(resolve=>setImmediate(resolve));

// A browser host method can require Window as its receiver. Node timers accept
// arbitrary receivers, so the ordinary controller unit tests cannot expose this.
async function browserModule(name){
  const source=await transform(await readFile(new URL('../src/lib/'+name,import.meta.url),'utf8'),{format:'cjs'});
  const context=vm.createContext({AbortController,TextEncoder,__module:{exports:{}},__require:id=>{assert.equal(id,'../api.js');return {api(){throw Error('UNEXPECTED_NETWORK');}};}});
  vm.runInContext(`
    globalThis.__timers=new Map();globalThis.__timerCalls=[];globalThis.__nextTimer=0;
    globalThis.setTimeout=function(callback,delay){'use strict';if(this!==globalThis)throw new TypeError('Illegal invocation: setTimeout receiver');const id=++globalThis.__nextTimer;globalThis.__timers.set(id,{callback,delay});globalThis.__timerCalls.push(['set',id]);return id;};
    globalThis.clearTimeout=function(id){'use strict';if(this!==globalThis)throw new TypeError('Illegal invocation: clearTimeout receiver');globalThis.__timers.delete(id);globalThis.__timerCalls.push(['clear',id]);};
    globalThis.__fire=id=>{const entry=globalThis.__timers.get(id);if(!entry)throw Error('NO_TIMER');globalThis.__timers.delete(id);return entry.callback();};
  `,context);
  vm.runInContext(`(function(require,module,exports){${source.code}\n})(__require,__module,__module.exports);`,context,{filename:name});
  return {module:context.__module.exports,timers:context.__timers,calls:context.__timerCalls,fire:id=>context.__fire(id)};
}
const file={projectId:'A',path:'draft.md',version:'disk',content:'first'};
const fields=message=>({message,authorName:'Fixture Author',authorEmail:'fixture@example.invalid'});

test('document autosave, replacement, flush, clear and dispose call browser timers with the global receiver',async()=>{
  const {module,timers,calls,fire}=await browserModule('document-draft-sync.js'),saved=[],cleared=[];
  const sync=new module.DocumentDraftSync({save:async body=>saved.push(body),clear:async body=>cleared.push(body)});
  assert.equal(sync.scheduleSave(file),true);assert.equal(timers.size,1);fire(timers.keys().next().value);await sync.flush();assert.equal(saved[0].content,'first');
  sync.scheduleSave({...file,content:'second'});sync.scheduleSave({...file,content:'latest'});assert.equal(timers.size,1);await sync.flush();assert.equal(saved.at(-1).content,'latest');assert.equal(timers.size,0);
  sync.scheduleSave({...file,content:'discarded'});await sync.clear(file);await sync.flush();assert.equal(cleared.at(-1).path,file.path);assert.equal(saved.some(body=>body.content==='discarded'),false);assert.equal(timers.size,0);
  sync.scheduleSave({...file,path:'other.md'});sync.dispose();assert.equal(timers.size,0);assert.ok(calls.some(call=>call[0]==='set'));assert.ok(calls.some(call=>call[0]==='clear'));
});

test('Git draft debounce, supersession, flush, commit cleanup and detach use browser timer receivers',async()=>{
  const {module,timers,calls,fire}=await browserModule('git-draft-sync.js'),written=[];let version=0;
  const coordinator=new module.GitDraftCoordinator({request:async()=>({draft:null}),mutateRequest:async(route,body)=>{written.push({route,...body});return route.endsWith('/clear')?{cleared:true}:{draft:{...body,version:'v'+(++version)}};}});
  const release=coordinator.subscribe('A',()=>{});await coordinator.load('A');coordinator.update('A',fields('first'));coordinator.update('A',fields('latest'));assert.equal(timers.size,1);fire(timers.keys().next().value);await coordinator.flush();assert.equal(written.at(-1).message,'latest');assert.equal(timers.size,0);
  assert.equal(coordinator.clearMatching('A',fields('latest')),true);await coordinator.flush();assert.equal(written.at(-1).route,'git-drafts/clear');assert.equal(coordinator.state().needsProtection,false);
  coordinator.update('A',fields('unmounted'));release();await coordinator.flush();assert.equal(written.at(-1).message,'unmounted');assert.equal(timers.size,0);assert.ok(calls.some(call=>call[0]==='clear'));
});

test('terminal polling, resize supersession and dispose use the browser receiver for schedule and cancel',async()=>{
  const {module,timers,calls,fire}=await browserModule('terminal-controller.js'),requests=[];
  const controller=new module.TerminalController({request:async(route,body)=>{requests.push({route,body});if(route.endsWith('/resize'))return {};if(route.includes('?after='))return {id:'term',status:'running',output:'output',nextCursor:6};return {terminals:[{id:'term',status:'running'}]};}});
  await controller.project('A');await turn();assert.equal(timers.size,1);const poll=timers.keys().next().value;await fire(poll);assert.equal(timers.size,1);
  controller.resize(80,20);controller.resize(120,30);assert.equal(timers.size,2);const resize=controller.resizeTimer;fire(resize);await turn();assert.equal(requests.filter(row=>row.route.endsWith('/resize')).length,1);assert.equal(requests.at(-1).body.cols,120);
  controller.dispose();assert.equal(timers.size,0);assert.ok(calls.some(call=>call[0]==='set'));assert.ok(calls.some(call=>call[0]==='clear'));
});

test('explicit timer injection keeps the existing fake-timer contract instead of forcing browser methods',async()=>{
  for(const [name,exportName]of [['document-draft-sync.js','DocumentDraftSync'],['git-draft-sync.js','GitDraftCoordinator'],['terminal-controller.js','TerminalController']]){
    const {module,calls}=await browserModule(name),scheduled=[],cancelled=[];
    const set=callback=>{scheduled.push(callback);return scheduled.length;},clear=id=>cancelled.push(id);let instance;
    if(exportName==='DocumentDraftSync'){instance=new module[exportName]({save:async()=>{},clear:async()=>{},setTimer:set,clearTimer:clear});instance.scheduleSave(file);instance.dispose();}
    else if(exportName==='GitDraftCoordinator'){instance=new module[exportName]({request:async()=>({draft:null}),mutateRequest:async(route,body)=>({draft:{...body,version:'v'}}),setTimer:set,clearTimer:clear});await instance.load('A');instance.update('A',fields('fake'));await instance.flush();}
    else{instance=new module[exportName]({request:async()=>({}),schedule:set,cancel:clear});instance.state={projectId:'A',selected:'term',terminal:{status:'running'},terminals:[]};instance.resize(80,20);instance.dispose();}
    assert.equal(calls.length,0,name+' must preserve injected timer isolation');assert.ok(scheduled.length>=1);assert.ok(cancelled.length>=1);
  }
});
