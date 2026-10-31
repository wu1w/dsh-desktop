import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {transform} from 'esbuild';
import React from 'react';
import {translator} from '../src/i18n.js';

const file=new URL('../src/agent-panel.jsx',import.meta.url),require=createRequire(file),compiled=await transform(await readFile(file,'utf8'),{loader:'jsx',format:'cjs'}),BASE=Date.parse('2026-10-24T00:00:00Z');
function descendants(value){if(Array.isArray(value))return value.flatMap(descendants);if(!value||typeof value!=='object')return [];return[value,...descendants(value.props?.children)];}
function text(value){if(Array.isArray(value))return value.map(text).join('');if(value==null||typeof value==='boolean')return'';if(typeof value!=='object')return String(value);return text(value.props?.children);}
const session=(id='A',options={})=>({id,kind:'agent',title:id,running:true,startedAt:new Date(BASE).toISOString(),...options});
function harness(initial=[session()],locale='en'){
 let time=BASE,cursor=0,dirty=false,tree,nodes=[],sessions=initial,nextId=0;const slots=[],pending=[],timers=new Map(),windowListeners=new Map(),documentListeners=new Map();let created=0,cleared=0,fired=0;
 class ClockDate extends Date{constructor(...args){super(...(args.length?args:[time]));}static now(){return time;}}
 const setInterval=(callback,delay)=>{const id=++nextId;timers.set(id,{callback,delay,next:time+delay});created++;return id;},clearInterval=id=>{if(timers.delete(id))cleared++;};
 function target(listeners){return{addEventListener(type,listener){const set=listeners.get(type)??new Set();set.add(listener);listeners.set(type,set);},removeEventListener(type,listener){listeners.get(type)?.delete(listener);}};}
 const document={...target(documentListeners),visibilityState:'visible'},window={...target(windowListeners),document};
 function effect(callback,deps){const key=cursor++,old=slots[key];if(!old||deps.some((value,index)=>!Object.is(value,old.deps[index]))){const entry={deps,cleanup:old?.cleanup};slots[key]=entry;pending.push(()=>{old?.cleanup?.();entry.cleanup=callback();});}}
 const react={...React,useState(initial){const key=cursor++;if(!(key in slots))slots[key]=typeof initial==='function'?initial():initial;return[slots[key],next=>{const value=typeof next==='function'?next(slots[key]):next;if(!Object.is(value,slots[key])){slots[key]=value;dirty=true;}}];},useRef(current){return slots[cursor++]??={current};},useEffect:effect,useLayoutEffect:effect};
 const module={exports:{}};
 new Function('require','module','exports','window','Date','setInterval','clearInterval',compiled.code)(id=>id==='react'?react:id==='./api.js'?{api:()=>new Promise(()=>{})}:id==='./transcript-timeline.jsx'?{TranscriptTimeline:()=>null}:id==='./markdown.jsx'?{Markdown:()=>null,FileReference:()=>null}:id==='./history-controls.jsx'?{HistoryControls:()=>null}:require(id),module,module.exports,window,ClockDate,setInterval,clearInterval);
 function render(nextSessions=sessions,nextLocale=locale,{effects=true}={}){sessions=nextSessions;locale=nextLocale;dirty=false;cursor=0;tree=module.exports.AgentPanel({sessions,projects:[],locale,t:translator(locale)});nodes=descendants(tree);if(effects)for(const callback of pending.splice(0))callback();return tree;}
 function settle(){for(let index=0;dirty&&index<20;index++)render();assert.equal(dirty,false,'effects should settle');}
 function advance(milliseconds){const end=time+milliseconds;while(true){const next=[...timers].filter(([,timer])=>timer.next<=end).sort((a,b)=>a[1].next-b[1].next)[0];if(!next)break;time=next[1].next;next[1].next+=next[1].delay;fired++;next[1].callback();settle();}time=end;}
 function emit(listeners,type){for(const listener of listeners.get(type)??[])listener({type});settle();}
 render();settle();return{render,settle,advance,jump(ms){time+=ms;},select(id){nodes.find(node=>node.props?.className==='agent-list-row'&&node.key===id).props.onClick();render();settle();},back(){nodes.find(node=>node.props?.className==='subtle-button'&&text(node)==='All agents').props.onClick();render();settle();},focus(){emit(windowListeners,'focus');},visibility(value){document.visibilityState=value;emit(documentListeners,'visibilitychange');},unmount(){for(const slot of slots)slot?.cleanup?.();},get rows(){return nodes.filter(node=>node.type==='small').map(text);},get preview(){return text(nodes.find(node=>node.props?.className==='agent-preview-status')?.props.children?.find(child=>child?.type==='span'&&!child.props.className));},get timers(){return timers.size;},get created(){return created;},get cleared(){return cleared;},get fired(){return fired;},get listeners(){return [...windowListeners.values(),...documentListeners.values()].reduce((count,set)=>count+set.size,0);}};
}
function expected(seconds,locale='en'){const format=new Intl.NumberFormat(locale),t=translator(locale);return seconds>=60?t('elapsedMinutes',{minutes:format.format(Math.floor(seconds/60)),seconds:format.format(seconds%60)}):t('elapsedSeconds',{seconds:format.format(seconds)});}

test('actual AgentPanel keeps one ticking interval under 200ms session-array replacements',()=>{
 const app=harness();assert.deepEqual(app.rows,[expected(0)]);for(let index=0;index<25;index++){app.advance(200);app.render([session('A',{updatedAt:new Date(BASE+index*200).toISOString()})]);app.settle();}
 assert.deepEqual(app.rows,[expected(5)],'five seconds of running must not remain frozen at zero');assert.equal(app.created,1,'array identity changes must not restart the clock');assert.equal(app.fired,5);app.unmount();assert.equal(app.timers,0);assert.equal(app.listeners,0);
});
test('first render and selection use current wall time even before a suspended interval can fire',()=>{
 const app=harness([session('A',{running:false,completedAt:new Date(BASE+1000).toISOString()})]);assert.equal(app.timers,0);app.jump(12000);app.render([session('A',{startedAt:new Date(BASE+9000).toISOString()}),session('B',{startedAt:new Date(BASE-61000).toISOString()})]);assert.deepEqual(app.rows,[expected(3),expected(73)]);app.settle();assert.equal(app.timers,1);
 app.jump(11000);app.select('A');assert.equal(app.preview,expected(14));app.back();app.select('B');assert.equal(app.preview,expected(84));assert.equal(app.created,1,'switching agent must not postpone the shared tick');app.unmount();
});
test('visible/focus refresh catches a long background pause without replaying timer ticks or leaking listeners',()=>{
 const app=harness();app.visibility('hidden');app.jump(125000);app.visibility('visible');assert.deepEqual(app.rows,[expected(125)]);assert.equal(app.fired,0);app.jump(30000);app.focus();assert.deepEqual(app.rows,[expected(155)]);assert.equal(app.created,1);app.unmount();assert.equal(app.timers,0);assert.equal(app.listeners,0);
});
test('completed and archived agents stop the clock, fixed endpoints stay fixed, and a new run starts one fresh timer',()=>{
 const app=harness();app.advance(3000);app.render([session('A',{running:false,completedAt:new Date(BASE+2000).toISOString()})]);app.settle();assert.deepEqual(app.rows,[expected(2)]);assert.equal(app.timers,0);app.jump(40000);app.render([session('A',{running:false,completedAt:new Date(BASE+2000).toISOString()}),session('hidden',{archived:true})]);app.settle();assert.deepEqual(app.rows,[expected(2)]);assert.equal(app.timers,0);
 app.render([session('B',{startedAt:new Date(BASE+40000).toISOString()})]);app.settle();assert.deepEqual(app.rows,[expected(3)]);assert.equal(app.timers,1);assert.equal(app.created,2);app.unmount();assert.equal(app.cleared,2);
});
test('actual elapsed labels retain locale formatting, minute rollover, and invalid-date safety',()=>{
 const app=harness([session('A',{startedAt:new Date(BASE-64000).toISOString()})],'zh-CN');assert.deepEqual(app.rows,[expected(64,'zh-CN')]);app.advance(1000);assert.deepEqual(app.rows,[expected(65,'zh-CN')]);app.render([session('A',{startedAt:new Date(BASE-64000).toISOString()})],'ar-EG');app.settle();assert.deepEqual(app.rows,[expected(65,'ar-EG')]);assert.equal(app.created,1);
 app.render([session('bad',{startedAt:'not-a-date'}),session('future',{startedAt:new Date(BASE+90000).toISOString()})],'en');app.settle();assert.deepEqual(app.rows,['',expected(0)]);app.unmount();
});
