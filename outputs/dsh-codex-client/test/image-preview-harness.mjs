import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {transform} from 'esbuild';
import React from 'react';
import {imageLocales} from '../src/image-locales.js';

const file=new URL('../src/components/ImagePreview.jsx',import.meta.url),require=createRequire(file),compiled=await transform(await readFile(file,'utf8'),{loader:'jsx',format:'cjs'});
export const imageFile=(extra={})=>({projectId:'A',path:'photos/图片.png',name:'图片.png',preview:{kind:'image',mime:'image/png',width:2000,height:1000,size:1024,version:'a'.repeat(64),modifiedAt:'2026-10-24T00:00:00.000Z'},...extra});
export const blob=()=>new Blob(['test image payload'],{type:'image/png'});
export const turn=()=>new Promise(resolve=>setImmediate(resolve));
export function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
export function nodes(tree){return !tree||typeof tree!=='object'?[]:[tree,...React.Children.toArray(tree.props?.children).flatMap(nodes)];}
export function loadImageComponent(react=React,extra={}){
  const module={exports:{}},context=vm.createContext({module,Blob,AbortController,Intl,console,URL,require:id=>id==='react'?react:id.endsWith('.css')?{}:id==='../image-locales.js'?{imageLocales}:require(id),...extra});
  vm.runInContext(`(function(require,module,exports){${compiled.code}\n})(require,module,module.exports);`,context);
  return module.exports;
}
export function harness(initial={}){
  const slots=[],pending=new Map(),created=[],revoked=[],observers=[];let cursor=0,props={file:imageFile(),locale:'en',loadImage:async()=>blob(),...initial};
  const react={...React,useState(initial){const key=cursor++;if(!(key in slots))slots[key]=typeof initial==='function'?initial():initial;return [slots[key],value=>{slots[key]=typeof value==='function'?value(slots[key]):value;}];},useRef(current){const key=cursor++;return slots[key]??={current};},useEffect(effect,deps){const key=cursor++,previous=slots[key];if(!previous||deps.some((value,index)=>!Object.is(value,previous.deps[index]))){slots[key]={deps,cleanup:previous?.cleanup};pending.set(key,effect);}}};
  const urlApi={createObjectURL(value){assert.equal(this,urlApi,'native URL method receiver');assert.ok(value instanceof Blob);const url='blob:fixture-'+created.length;created.push(url);return url;},revokeObjectURL(url){assert.equal(this,urlApi,'native URL method receiver');revoked.push(url);}};
  class Observer{constructor(callback){this.callback=callback;this.disconnected=false;observers.push(this);}observe(element){assert.ok(this instanceof Observer);this.element=element;}disconnect(){assert.ok(this instanceof Observer);this.disconnected=true;}}
  const module=loadImageComponent(react,{URL:urlApi,ResizeObserver:Observer}),stage={clientWidth:500,clientHeight:400,scrollLeft:0,scrollTop:0};
  function render(extra={}){props={...props,...extra};cursor=0;const tree=module.ImagePreview(props),all=nodes(tree);for(const node of all)if(node.props.className==='image-preview-stage')node.ref.current=stage;return {tree,nodes:all,img:all.find(node=>node.type==='img'),button:label=>all.find(node=>node.type==='button'&&(node.props['aria-label']===label||node.props.children===label))};}
  function flush(){for(const [key,effect]of [...pending]){pending.delete(key);slots[key].cleanup?.();slots[key].cleanup=effect();}}
  async function settle(){await turn();return render();}
  function unmount(){pending.clear();for(const slot of slots)slot?.cleanup?.();}
  function decode(width=props.file.preview.width,height=props.file.preview.height){const value=render();assert.ok(value.img);value.img.props.onLoad({currentTarget:{naturalWidth:width,naturalHeight:height}});return render();}
  return {render,flush,settle,unmount,decode,stage,created,revoked,observers,module,get props(){return props;}};
}
