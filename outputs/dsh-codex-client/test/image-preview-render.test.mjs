import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {imageLocales} from '../src/image-locales.js';
import {loadImageComponent,imageFile,harness,turn} from './image-preview-harness.mjs';
const module=loadImageComponent(),tFor=locale=>(key,params={})=>(imageLocales[locale]?.[key]??imageLocales.en[key]??key).replace(/\{(\w+)\}/g,(match,name)=>params[name]??match);
for(const locale of ['en','zh-CN'])test('actual image preview SSR has localized read-only toolbar, honest loading and no editing controls: '+locale,()=>{
  const html=renderToStaticMarkup(React.createElement(module.ImagePreview,{file:imageFile(),locale,t:tFor(locale),loadImage:async()=>{throw Error('SSR must not fetch');}}));
  for(const key of ['imagePreview','imageFit','imageActual','imageReadOnly','imageLoading','imageZoomOut','imageZoomIn'])assert.ok(html.includes(tFor(locale)(key)),key);
  assert.match(html,/tabindex="0"/);assert.match(html,/aria-busy="true"/);assert.doesNotMatch(html,/<textarea|<input|Save|保存|<img|imagePreview|imageLoading/);
});
test('locale fallback, dates, dimensions, byte sizes and matching language dictionaries remain localized',()=>{
  assert.deepEqual(Object.keys(imageLocales.en).sort(),Object.keys(imageLocales['zh-CN']).sort());
  const html=renderToStaticMarkup(React.createElement(module.ImagePreview,{file:imageFile(),locale:'de-DE',t:key=>key,loadImage:async()=>{}}));
  assert.ok(html.includes('Actual size'));assert.ok(html.includes('2.000 × 1.000 pixels'));assert.ok(html.includes(module.imagePreviewSize(1024,'de-DE')));assert.ok(html.includes(new Intl.DateTimeFormat('de-DE',{dateStyle:'medium',timeStyle:'short'}).format(new Date(imageFile().preview.modifiedAt))));
  assert.equal(module.imagePreviewSize(16*1024*1024,'bad_locale'),new Intl.NumberFormat('en',{style:'unit',unit:'megabyte',unitDisplay:'short',maximumFractionDigits:1}).format(16*1024*1024/1e6));
});
test('real fit/actual/zoom handlers use viewport dimensions and keep the full image origin reachable',async()=>{
  const app=harness();app.render();app.flush();await app.settle();let view=app.decode();
  assert.equal(view.img.props.style.width,468);assert.equal(view.img.props.style.height,234);assert.ok(view.img.props.style.left>=16);assert.ok(view.img.props.style.top>=16);
  view.button('Actual size').props.onClick();view=app.render();app.flush();assert.equal(view.img.props.style.width,2000);assert.equal(view.img.props.style.height,1000);assert.equal(view.img.props.style.left,16);assert.equal(view.img.props.style.top,16);
  for(let index=0;index<30;index++){view.button('Zoom in').props.onClick();view=app.render();}assert.equal(view.img.props.style.width,8000);assert.equal(view.button('Zoom in').props.disabled,true);
  for(let index=0;index<60;index++){view.button('Zoom out').props.onClick();view=app.render();}assert.equal(view.img.props.style.width,200);assert.equal(view.button('Zoom out').props.disabled,true);
  view.button('Fit').props.onClick();view=app.render();app.stage.clientWidth=300;app.stage.clientHeight=220;app.observers.at(-1).callback();view=app.render();assert.equal(view.img.props.style.width,268);app.unmount();
});
test('large-image fit may be below ten percent and minus never makes it larger',async()=>{
  const file=imageFile({preview:{...imageFile().preview,width:16384,height:1000}}),app=harness({file});app.stage.clientWidth=300;app.render();app.flush();await app.settle();let view=app.decode();
  const width=view.img.props.style.width;assert.ok(width<1638.4);assert.equal(view.button('Zoom out').props.disabled,true);view.button('Zoom out').props.onClick();view=app.render();assert.equal(view.img.props.style.width,width);
  view.button('Zoom in').props.onClick();view=app.render();assert.equal(view.img.props.style.width,1638.4);app.unmount();
});
test('actual keyboard handler stays inside preview focus, respects modifiers and supports plus/minus/fit/actual',async()=>{
  const app=harness();app.render();app.flush();await app.settle();let view=app.decode(),prevented=0,stopped=0;
  function key(key,extra={}){view.tree.props.onKeyDown({key,target:{tagName:'SECTION'},currentTarget:{contains:()=>true},preventDefault(){prevented++;},stopPropagation(){stopped++;},...extra});view=app.render();}
  const fit=view.img.props.style.width;key('+',{ctrlKey:true});key('+',{metaKey:true});key('+',{altKey:true});key('+',{currentTarget:{contains:()=>false}});key('+',{target:{tagName:'INPUT'}});assert.equal(view.img.props.style.width,fit);assert.equal(prevented,0);
  key('1');assert.equal(view.img.props.style.width,2000);key('+');assert.equal(view.img.props.style.width,2500);key('-');assert.equal(view.img.props.style.width,2000);key('0');assert.equal(view.img.props.style.width,fit);assert.equal(prevented,4);assert.equal(stopped,4);app.unmount();
});
test('decoded EXIF-oriented natural size drives fit without rejecting valid JPEG orientation',async()=>{
  const file=imageFile({preview:{...imageFile().preview,mime:'image/jpeg',width:1200,height:800}}),app=harness({file,loadImage:async()=>new Blob(['JPEG fixture'],{type:'image/jpeg'})});app.render();app.flush();await app.settle();const view=app.decode(800,1200);
  assert.ok(view.img);assert.equal(view.img.props.className,'image-preview-image');assert.ok(Math.abs(view.img.props.style.height-368)<.001);assert.ok(view.img.props.style.width<250);app.unmount();
});
