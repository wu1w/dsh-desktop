import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {transform} from 'esbuild';
import React from 'react';
import {HistoryController} from '../src/lib/history-controller.js';
import {translator} from '../src/i18n.js';
const file=new URL('../src/main.jsx',import.meta.url),require=createRequire(file),raw=await readFile(file,'utf8');
const compiled=await transform(raw.replace('  async function queueAction(action,body){','  captureProbe({resumeTask,interruptTask,setError});\n  async function queueAction(action,body){')+'\nexport {App};',{loader:'jsx',format:'cjs'});
const nodes=value=>Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'?[value,...nodes(value.props?.children)]:[];
const text=value=>Array.isArray(value)?value.map(text).join(''):value&&typeof value==='object'?text(value.props?.children):value==null||typeof value==='boolean'?'':String(value);
function fixture(status,locale='en',{failRead=false}={}){
 const session={id:'chat',projectId:'project',title:'Task',running:false,runRecovery:{status,canResume:true,nextRetryAt:status==='waiting'?'2026-10-24T00:00:00Z':null}},state={projects:[{id:'project',path:'/project',name:'Project'}],sessions:[session],engine:{state:'ready',capabilities:{}},selectedEngine:'codex'},history=new HistoryController();history.select('chat');history.completeInitial(history.beginInitial(),{items:[],running:true});
 const overrides=new Map([[0,locale],[2,state],[3,true],[4,'chat'],[6,history],[7,history.snapshot()]]);let index=0,probe,release;
 const requests=[],pending=new Promise(resolve=>{release=resolve;}),react={...React,useEffect(){},useLayoutEffect(){},useRef:current=>({current}),useState(initial){const key=index++,setter=value=>setter.calls.push(value);setter.calls=[];return[overrides.has(key)?overrides.get(key):typeof initial==='function'?initial():initial,setter];}};
 const module={exports:{}},dependencies=id=>id==='react'?react:id.endsWith('.css')?{}:id==='./api.js'?{api:async(route,body)=>{requests.push({route,body});if(body)return pending;if(failRead)throw Error('READ_CONNECTION_LOST');return route==='state'?state:{items:[],running:false,queue:[]};}}:id.endsWith('.jsx')?new Proxy({},{get:(_,key)=>key==='__esModule'?true:()=>null}):require(id);
 new Function('require','module','exports','localStorage','window','document','captureProbe',compiled.code)(dependencies,module,module.exports,{getItem:()=>null},{},{},value=>{probe=value;});
 const tree=module.exports.App({registerCleanup(){}});return{...probe,tree,nodes:nodes(tree),requests,release};
}
for(const locale of ['en','zh-CN'])test('actual App shows durable recovery states and explicit continue controls in '+locale,()=>{
 for(const status of ['interrupted','failed','uncertain','waiting']){
  const app=fixture(status,locale),banner=app.nodes.find(node=>node.props?.className==='task-recovery-status');assert.ok(banner,status);
  const button=nodes(banner).find(node=>node.type==='button');assert.equal(Boolean(button),status!=='waiting');
  if(button)assert.equal(text(button),translator(locale)(status==='uncertain'?'recheckTask':'resumeTask'));
  const composer=app.nodes.find(node=>node.props?.onStop&&node.props?.models);assert.ok(composer);assert.equal(composer.props.busy,status==='waiting','stale running transcript must not revive stopped work');
 }
});
test('actual continue action sends one resume request, never original prompt, and serializes rapid retries',async()=>{
 const app=fixture('interrupted');const first=app.resumeTask('chat'),second=app.resumeTask('chat');await second;assert.deepEqual(app.requests,[{route:'sessions/chat/resume',body:{}}]);app.release({});await first;assert.equal(app.requests.filter(row=>row.body!==undefined).length,1);
});
test('actual stop while waiting uses interrupt and cannot race a second resume action',async()=>{
 const app=fixture('waiting'),stop=app.interruptTask('chat');await app.resumeTask('chat');assert.deepEqual(app.requests,[{route:'sessions/chat/interrupt',body:{}}]);app.release({});await stop;
});

test('acknowledged resume followed by a lost refresh reports sync state without claiming the action failed',async()=>{
 const app=fixture('interrupted','en',{failRead:true}),pending=app.resumeTask('chat');app.release({});await pending;
 assert.deepEqual(app.setError.calls,['']);assert.equal(app.requests.filter(row=>row.body!==undefined).length,1);
});
