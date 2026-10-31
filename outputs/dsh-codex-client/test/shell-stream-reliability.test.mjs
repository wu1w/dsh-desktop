import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {transform} from 'esbuild';
import * as transport from '../shell/event-stream.js';
import {ReconnectController} from '../shell/reconnect.js';
import {resources} from '../shell/locales.js';
import {pluginEngineProviders} from '../shell/engine-providers.js';
import {renderRecovery} from '../shell/recovery-view.js';
const compiled=await transform(await readFile(new URL('../shell/core.js',import.meta.url),'utf8'),{format:'cjs'});
const pause=()=>new Promise(resolve=>setTimeout(resolve,5));
async function until(check){for(let i=0;i<100;i++){if(check())return;await pause();}assert.fail('condition timed out');}
const state=version=>({version,preferences:{locale:'en'},engine:{state:'ready'},plugins:[],projects:[],sessions:[],appearance:null});
class Element{constructor(){this.children=[];}append(...children){this.children.push(...children);}replaceChildren(...children){this.children=children;}remove(){}}
function fixture(fetch){
 let probe,sequence=0;const timers=new Map(),listeners=new Map(),requests=[];
 const core=new Element(),root=new Element(),document={getElementById:id=>id==='root'?root:core,createElement:()=>new Element(),head:new Element()};
 const window={addEventListener:(name,callback)=>listeners.set(name,callback)};
 const deps={'./event-stream.js':{...transport,readJsonResponse:(open,signal,options)=>transport.readJsonResponse(open,signal,{...options,timeoutMs:25,maxBytes:2048}),readEventStream:(open,listener,signal,options)=>transport.readEventStream(open,listener,signal,{...options,idleTimeoutMs:25,maxMessageBytes:2048})},'./reconnect.js':{ReconnectController:class extends ReconnectController{constructor(options){super({...options,random:()=>1,schedule:(callback,ms)=>{timers.set(++sequence,{callback,ms});return sequence;},cancel:id=>timers.delete(id)});}}},'./locales.js':{resources},'./engine-providers.js':{pluginEngineProviders},'./recovery-view.js':{renderRecovery}};
 new Function('require','module','exports','document','window','fetch','captureProbe',compiled.code+'\ncaptureProbe({connection,getState:()=>state,getProblem:()=>problem});')(id=>deps[id],{exports:{}},{},document,window,(url,options={})=>{requests.push({url,options});return fetch(url,options);},value=>{probe=value;});
 return{...probe,requests,timers,listeners,stop:()=>probe.connection.stop()};
}
test('actual shell exits bootstrap header blackhole, retries, and online wake never writes',async()=>{
 const shell=fixture(()=>new Promise(()=>{}));try{await until(()=>shell.timers.size===1);assert.equal(shell.requests[0].options.signal.aborted,true);assert.equal(shell.getProblem(),resources.en.connectionRetry===shell.getProblem()?resources.en.connectionRetry:resources['zh-CN'].connectionRetry);shell.listeners.get('online')();await until(()=>shell.requests.length===2);await until(()=>shell.timers.size===1);assert.ok(shell.requests.every(row=>!row.options.method||row.options.method==='GET'));}finally{shell.stop();}assert.equal(shell.timers.size,0);
});
test('actual shell times out a silent SSE body and releases its reader without stalling future reconnects',async()=>{
 let cancelled=0;const shell=fixture(url=>url==='/api/bootstrap'?Response.json({capability:'fixture',state:state('boot')}):url==='/api/state'?Response.json(state('fresh')):new Response(new ReadableStream({cancel(){cancelled++;}}),{headers:{'content-type':'text/event-stream'}}));
 try{await until(()=>shell.timers.size===1);assert.equal(cancelled,1);assert.equal(shell.getState().version,'fresh');assert.ok(shell.requests.find(row=>row.url==='/api/events').options.signal.aborted);assert.equal(shell.timers.values().next().value.ms,1000);}finally{shell.stop();}
});
test('actual shell subscribes before gap read and refuses its stale result after a live state',async()=>{
 let stream,resolveRead;const shell=fixture(url=>url==='/api/bootstrap'?Response.json({capability:'fixture',state:state('boot')}):url==='/api/state'?new Promise(resolve=>{resolveRead=resolve;}):new Response(new ReadableStream({start(controller){stream=controller;}}),{headers:{'content-type':'text/event-stream'}}));
 try{await until(()=>resolveRead);assert.deepEqual(shell.requests.map(r=>r.url),['/api/bootstrap','/api/events','/api/state']);stream.enqueue(new TextEncoder().encode('data: '+JSON.stringify({type:'state',state:state('live')})+'\n\n'));await until(()=>shell.getState().version==='live');resolveRead(Response.json(state('stale')));await pause();assert.equal(shell.getState().version,'live');}finally{shell.stop();}
});
test('actual shell disconnects oversized unterminated SSE instead of growing the buffer',async()=>{
 const shell=fixture(url=>url==='/api/bootstrap'?Response.json({capability:'fixture',state:state('boot')}):url==='/api/state'?Response.json(state('fresh')):new Response('data: '+ 'x'.repeat(4096),{headers:{'content-type':'text/event-stream'}}));
 try{await until(()=>shell.timers.size===1);assert.equal(shell.requests.length,3);assert.ok(shell.requests.find(r=>r.url==='/api/events').options.signal.aborted);}finally{shell.stop();}
});
