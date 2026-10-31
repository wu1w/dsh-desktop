import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {transform} from 'esbuild';
import React from 'react';
import {historyForSelection,queueForSelection} from '../src/lib/session-view.js';

const message={id:'answer-A',type:'agentMessage',text:'[source](README.md)'};
const historyA={sessionId:'session-A',items:[message],running:false,loadingInitial:false,history:{nextCursor:'cursor-A',hasMore:true,error:'error-A'},loadingEarlier:false};
test('a new selection cannot expose old content, cursors, errors or queue actions before effects run',()=>{
  const view=historyForSelection(historyA,'session-B',true);
  assert.deepEqual(view.items,[]);assert.equal(view.history.nextCursor,null);assert.equal(view.history.error,null);assert.equal(view.loadingInitial,true);assert.equal(view.running,true);
  assert.deepEqual(queueForSelection({sessionId:'session-A',items:[{id:'same-local-id',text:'old'}]},'session-B'),[]);
  assert.equal(historyForSelection(historyA,'session-A'),historyA);
  assert.deepEqual(queueForSelection({sessionId:'session-A',items:[{id:'one'}]},'session-A'),[{id:'one'}]);
});
const Markdown=function Markdown(){},Queue=function QueuedMessages(){},Controls=function HistoryControls(){},Row=function TranscriptTimeline(){};
const projects=[{id:'project-A',path:'/projects/A',name:'A'},{id:'project-B',path:'/projects/B',name:'B'}];
const sessions=[{id:'session-A',projectId:'project-A',kind:'agent',title:'A'},{id:'session-B',projectId:'project-B',kind:'agent',title:'B'}];
const storage={getItem:()=>null,setItem(){},removeItem(){}};
function descendants(value){if(Array.isArray(value))return value.flatMap(descendants);if(!value||typeof value!=='object')return [];return [value,...descendants(value.props?.children)];}
async function component(file,overrides,exportApp=false){
  const require=createRequire(file),module={exports:{}};let index=0;
  const react={...React,useEffect(){},useLayoutEffect(){},useRef:current=>({current}),useState(initial){const key=index++;return [overrides.has(key)?overrides.get(key):typeof initial==='function'?initial():initial,()=>{}];}};
  const code=await transform(await readFile(file,'utf8')+(exportApp?'\nexport {App};':''),{loader:'jsx',format:'cjs'});
  const dependency=id=>id==='react'?react:id.endsWith('.css')?{}:id.endsWith('/markdown.jsx')||id==='./markdown.jsx'?{Markdown}:id.endsWith('/queued-messages.jsx')||id==='./queued-messages.jsx'?{QueuedMessages:Queue}:id.endsWith('/history-controls.jsx')||id==='./history-controls.jsx'?{HistoryControls:Controls}:id==='./transcript-timeline.jsx'?{TranscriptTimeline:Row}:id.endsWith('.jsx')?new Proxy({},{get:(_,name)=>name==='__esModule'?true:()=>null}):require(id);
  new Function('require','module','exports','localStorage','window','document',code.code)(dependency,module,module.exports,storage,{},{});
  return module.exports;
}
test('the actual agent panel hides old Markdown and controls before its selection effect, then binds matching content to B',async()=>{
  const file=new URL('../src/agent-panel.jsx',import.meta.url),opened=[];
  async function tree(history){const module=await component(file,new Map([[0,'session-B'],[2,{snapshot:()=>history}],[3,history]]));return descendants(module.AgentPanel({sessions,projects,onOpenFile:(...args)=>opened.push(args),t:key=>key,locale:'en'}));}
  let nodes=await tree(historyA);assert.equal(nodes.filter(node=>node.type===Markdown).length,0);assert.equal(nodes.find(node=>node.type===Controls).props.snapshot.history.hasMore,false);
  nodes=await tree({...historyA,sessionId:'session-B'});const timeline=nodes.find(node=>node.type===Row);assert.equal(timeline.props.projectPath,'/projects/B');assert.equal(timeline.props.projectId,'project-B');assert.deepEqual(timeline.props.items,[message]);timeline.props.onOpenFile('README.md',timeline.props.projectId);assert.deepEqual(opened,[['README.md','project-B']]);
});
test('the actual main chat hides previous-project Markdown, sources and queue before its passive selection effect',async()=>{
  const file=new URL('../src/main.jsx',import.meta.url);
  const state={projects,sessions,engine:{state:'ready',capabilities:{}},selectedEngine:'codex'};
  const overrides=new Map([[0,'en'],[2,state],[3,true],[4,'session-B'],[6,{snapshot:()=>historyA}],[7,historyA],[8,{sessionId:'session-A',items:[{id:'same-local-id',text:'old-queue-A'}]}]]);
  const module=await component(file,overrides,true),nodes=descendants(module.App({registerCleanup(){}}));
  assert.equal(nodes.filter(node=>node.type===Markdown).length,0);assert.deepEqual(nodes.find(node=>node.type===Row).props.items,[]);assert.equal(nodes.filter(node=>node.type===Queue).length,0);
  assert.equal(nodes.find(node=>node.type===Controls).props.snapshot.history.hasMore,false);
  assert.ok(!JSON.stringify(nodes.filter(node=>node.type==='button').map(node=>node.props.title)).includes('answer-A'));
});

test('the actual main chat passes matching history ownership to its shared turn timeline',async()=>{
 const file=new URL('../src/main.jsx',import.meta.url),state={projects,sessions,engine:{state:'ready',capabilities:{}},selectedEngine:'codex'};
 const overrides=new Map([[0,'en'],[2,state],[3,true],[4,'session-A'],[6,{snapshot:()=>historyA}],[7,historyA],[8,{sessionId:'session-A',items:[]}]]);
 const module=await component(file,overrides,true),nodes=descendants(module.App({registerCleanup(){}})),row=nodes.find(node=>node.type===Row);
 assert.ok(row);assert.deepEqual(row.props.items,[message]);assert.equal(row.props.projectId,'project-A');assert.equal(row.props.projectPath,'/projects/A');assert.equal(row.props.filesEnabled,true);assert.equal(row.props.locale,'en');
});
