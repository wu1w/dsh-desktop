import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {transform} from 'esbuild';
import React from 'react';

const file=new URL('../src/agent-panel.jsx',import.meta.url),require=createRequire(file),compiled=await transform(await readFile(file,'utf8'),{loader:'jsx',format:'cjs'});
const Controls=function HistoryControls(){},Markdown=function Markdown(){},Reference=function FileReference(){};
const sessions=['A','B'].map(id=>({id,kind:'agent',projectId:'project-'+id,title:id,createdAt:1700000000000}));
const message=(id,height=150)=>({id,type:'agentMessage',text:id,height});
const page=(items,{more=false,running=false}={})=>({items,running,history:{hasMore:more,nextCursor:more?'older':null}});
function descendants(value){if(Array.isArray(value))return value.flatMap(descendants);if(!value||typeof value!=='object')return [];return [value,...descendants(value.props?.children)];}
function harness(){
 const slots=[],requests=[],observers=[],listeners=new Map();let cursor=0,dirty=false,nodes=[],view,rows=[],top=0,controlsHeight=0;
 const layouts=[],effects=[];
 function hookEffect(queue,callback,deps){const key=cursor++,old=slots[key];if(!old||deps.some((value,index)=>!Object.is(value,old.deps[index]))){slots[key]={deps,cleanup:old?.cleanup};queue.push(()=>{old?.cleanup?.();slots[key].cleanup=callback();});}}
 const react={...React,useState(initial){const key=cursor++;if(!(key in slots))slots[key]=typeof initial==='function'?initial():initial;return[slots[key],next=>{const value=typeof next==='function'?next(slots[key]):next;if(!Object.is(value,slots[key])){slots[key]=value;dirty=true;}}];},useRef(current){return slots[cursor++]??={current};},useEffect(callback,deps){hookEffect(effects,callback,deps);},useLayoutEffect(callback,deps){hookEffect(layouts,callback,deps);}};
 const window={addEventListener(type,listener){const set=listeners.get(type)??new Set();set.add(listener);listeners.set(type,set);},removeEventListener(type,listener){listeners.get(type)?.delete(listener);}};
 class ResizeObserver{constructor(callback){this.callback=callback;this.connected=false;observers.push(this);}observe(){this.connected=true;}disconnect(){this.connected=false;}}
 const environment={ResizeObserver};
 const element={clientHeight:300,get scrollHeight(){return controlsHeight+rows.reduce((sum,row)=>sum+row.height,0);},get scrollTop(){return top;},set scrollTop(value){top=Math.max(0,Math.min(Number(value),Math.max(0,this.scrollHeight-this.clientHeight)));},getBoundingClientRect(){return{top:100};},querySelectorAll(){let offset=controlsHeight;return rows.map(row=>{const position=offset;offset+=row.height;return{dataset:{historyId:row.id},getBoundingClientRect:()=>({top:100+position-top,bottom:100+position+row.height-top})};});}};
 const api=(route)=>new Promise((resolve,reject)=>requests.push({route,resolve,reject}));
 const module={exports:{}};
 new Function('require','module','exports','window','globalThis',compiled.code)(id=>id==='react'?react:id==='./api.js'?{api}:id==='./transcript-timeline.jsx'?{TranscriptTimeline:()=>null}:id==='./markdown.jsx'?{Markdown,FileReference:Reference}:id==='./history-controls.jsx'?{HistoryControls:Controls}:require(id),module,module.exports,window,environment);
 function render(){dirty=false;cursor=0;view=module.exports.AgentPanel({sessions,projects:[],locale:'en',t:key=>key});nodes=descendants(view);const transcript=nodes.find(node=>node.props?.className==='agent-preview-transcript');if(transcript){transcript.ref.current=element;const snapshot=nodes.find(node=>node.type===Controls).props.snapshot;rows=snapshot.items;controlsHeight=snapshot.history.hasMore?40:0;element.scrollTop=top;}else{rows=[];controlsHeight=0;}for(const effect of layouts.splice(0))effect();for(const effect of effects.splice(0))effect();return view;}
 async function settle(){for(let index=0;index<20;index++){await Promise.resolve();if(dirty)render();else{await Promise.resolve();if(!dirty)return;}}throw Error('render did not settle');}
 function fireScroll(value=top){element.scrollTop=value;nodes.find(node=>node.props?.className==='agent-preview-transcript').props.onScroll({currentTarget:element});}
 function choose(id){nodes.find(node=>node.props?.className==='agent-list-row'&&node.key===id).props.onClick();render();}
 async function resolve(route,response){const request=requests.find(request=>request.route===route);assert.ok(request,'actual component requested '+route);requests.splice(requests.indexOf(request),1);request.resolve(response);await settle();}
 function live(id,items,running=true){for(const listener of listeners.get('dsh-session-event')??[])listener({detail:{sessionId:id,items,running}});render();}
 function anchor(){const item=element.querySelectorAll().find(item=>item.getBoundingClientRect().bottom>101);return{itemId:item?.dataset.historyId,offset:item?.getBoundingClientRect().top-100,top};}
 function earlier(){const operation=nodes.find(node=>node.type===Controls).props.onEarlier();render();return operation;}
 function back(){nodes.find(node=>node.type==='button'&&descendants(node.props.children).length&&node.props.className==='subtle-button').props.onClick();render();}
 render();return{element,requests,observers,listeners,render,settle,choose,resolve,live,fireScroll,anchor,earlier,back,unmount(){for(const slot of slots)slot?.cleanup?.();},get nodes(){return nodes;},get gap(){return element.scrollHeight-element.scrollTop-element.clientHeight;}};
}
async function open(app,id,items,options){app.choose(id);await app.resolve('sessions/'+id,page(items,options));}
test('actual AgentPanel opens at the tail, respects reading, and resumes only when the reader reaches its 70px threshold',async()=>{
 const app=harness(),items=Array.from({length:10},(_,i)=>message('a'+i));await open(app,'A',items);assert.equal(app.gap,0);
 app.fireScroll();app.fireScroll(310);const reading=app.anchor();app.live('A',[message('tail',200)]);assert.deepEqual(app.anchor(),reading,'new content must not move an older visible answer');
 app.fireScroll(app.element.scrollHeight-app.element.clientHeight-69);app.live('A',[message('tail',400)]);assert.equal(app.gap,0);
 app.fireScroll();app.fireScroll(app.element.scrollHeight-app.element.clientHeight-71);const stopped=app.element.scrollTop;app.live('A',[message('tail',600)]);assert.equal(app.element.scrollTop,stopped);
 app.unmount();assert.ok(app.observers.every(observer=>!observer.connected));assert.equal([...app.listeners.values()].reduce((sum,set)=>sum+set.size,0),0);
});
test('actual earlier-page response preserves the currently visible anchor, including scrolls made during its request',async()=>{
 const app=harness(),items=Array.from({length:6},(_,i)=>message('a'+i));await open(app,'A',items,{more:true});app.fireScroll();const pending=app.earlier();app.fireScroll(380);const before=app.anchor();
 app.live('A',[message('tail',250)]);assert.deepEqual(app.anchor(),before,'pending earlier load must already disable tail following');
 await app.resolve('sessions/A/history?cursor=older',page([message('earlier0'),message('earlier1')],{more:true}));await pending;assert.equal(app.anchor().itemId,before.itemId);assert.equal(app.anchor().offset,before.offset);
 app.fireScroll();const restored=app.element.scrollTop;app.live('A',[message('tail',500)]);assert.equal(app.element.scrollTop,restored);app.unmount();
});
test('short initially fitting history keeps an explicit earlier request paused even when restoration lands at the tail',async()=>{
 const app=harness();await open(app,'A',[message('a',120)],{more:true});assert.equal(app.gap,-140);const pending=app.earlier();
 await app.resolve('sessions/A/history?cursor=older',page([message('earlier',180)],{more:true}));await pending;assert.equal(app.gap,0);app.fireScroll();
 const restored=app.element.scrollTop;app.live('A',[message('new-tail',500)]);assert.equal(app.element.scrollTop,restored,'own restore scroll event must not reenable follow');
 app.unmount();
});
test('switching agents resets following and rejects late earlier pages; stale resize observers cannot move the new agent',async()=>{
 const app=harness();await open(app,'A',[message('a',900)],{more:true});app.fireScroll(80);const staleObserver=app.observers.at(-1),pending=app.earlier();app.back();await open(app,'B',[message('b',800)]);assert.equal(app.gap,0);
 app.fireScroll(120);const before=app.anchor();await app.resolve('sessions/A/history?cursor=older',page([message('old-A',600)]));await pending;assert.deepEqual(app.anchor(),before);staleObserver.callback();assert.deepEqual(app.anchor(),before);assert.equal(staleObserver.connected,false);
 app.live('A',[message('late-A',1000)]);assert.deepEqual(app.anchor(),before);app.unmount();
});
test('current resize observation follows only a reader at the tail and is safely disconnected',async()=>{
 const app=harness();await open(app,'A',[message('a',1000)]);const observer=app.observers.at(-1);app.element.clientHeight=400;observer.callback();assert.equal(app.gap,0);
 app.fireScroll();app.fireScroll(120);app.element.clientHeight=450;observer.callback();assert.equal(app.element.scrollTop,120);app.unmount();const before=app.element.scrollTop;observer.callback();assert.equal(app.element.scrollTop,before);
});
