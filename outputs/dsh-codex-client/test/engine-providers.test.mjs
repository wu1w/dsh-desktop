import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {transform} from 'esbuild';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {pluginEngineProviders,engineRegistrySource} from '../shell/engine-providers.js';
import {resources} from '../shell/locales.js';
import * as eventTransport from '../shell/event-stream.js';
import {ReconnectController} from '../shell/reconnect.js';
import {translator} from '../src/i18n.js';

const plugin=(extra={})=>({id:'community-harness-pack',type:'engine',name:'Community harnesses',version:'1.0',enabled:true,active:true,builtin:false,...extra});
const registered=[{id:'native-fast',pluginId:'community-harness-pack',capabilities:{}},{id:'native-careful',pluginId:'community-harness-pack',capabilities:{}},{id:'unrelated',pluginId:'other-pack'}];
const state=(extra={})=>({plugins:[plugin()],engineProviders:registered,selectedEngine:'native-fast',preferences:{locale:'en'},engine:{state:'ready'},sessions:[],...extra});

test('engine ownership maps one package to every actual registered factory, independently of package naming',()=>{
  assert.deepEqual(pluginEngineProviders(plugin(),state()).map(provider=>provider.id),['native-fast','native-careful']);
  assert.deepEqual(pluginEngineProviders(plugin({id:'other-pack'}),state()).map(provider=>provider.id),['unrelated']);
});

test('an advertised empty or malformed registry is authoritative and never falls back to inferred IDs',()=>{
  for(const engineProviders of [[],null,{},undefined])assert.deepEqual(pluginEngineProviders(plugin({id:'engine-codex'}),{engineProviders}),[]);
  assert.deepEqual(pluginEngineProviders(plugin({id:'engine-codex'}),{}),[{id:'codex',pluginId:'engine-codex'}]);
});

test('disabled or inactive plugins expose no executable choice even if an old provider record remains',()=>{
  assert.deepEqual(pluginEngineProviders(plugin({enabled:false}),state()),[]);assert.deepEqual(pluginEngineProviders(plugin({active:false}),state()),[]);
  assert.deepEqual(pluginEngineProviders(plugin({id:'engine-codex',enabled:false}),{}),[]);
});

test('the latest public registry prevents a stale plugin catalog from reviving removed providers',()=>{
  const current=state({engineProviders:[],plugins:[plugin({enabled:false,active:false})]}),stale=state();
  assert.equal(engineRegistrySource(current,stale),current);assert.deepEqual(pluginEngineProviders(plugin(),engineRegistrySource(current,stale)),[]);
  assert.equal(engineRegistrySource({},stale),stale);
});

test('malformed, foreign and duplicated provider rows do not create duplicate executable actions',()=>{
  const source={engineProviders:[...registered,registered[0],{id:'',pluginId:plugin().id},null,{id:2,pluginId:plugin().id}]};
  assert.deepEqual(pluginEngineProviders(plugin(),source).map(provider=>provider.id),['native-fast','native-careful']);
});

const settingsUrl=new URL('../src/settings-content.jsx',import.meta.url),settingsModule={exports:{}};
const settingsCode=await transform(await readFile(settingsUrl,'utf8'),{loader:'jsx',format:'cjs'});
new Function('require','module','exports',settingsCode.code)(id=>id==='./model-settings.jsx'?{ModelSettings:()=>null}:id==='./plugin-studio.jsx'?{PluginStudio:()=>null}:id==='./channel-settings.jsx'?{ChannelSettings:()=>null}:createRequire(settingsUrl)(id),settingsModule,settingsModule.exports);
function settingsMarkup(snapshot){return renderToStaticMarkup(React.createElement(settingsModule.exports.SettingsContent,{tab:'engines',t:translator('en'),locale:'en',state:snapshot,refresh:async()=>{}}));}

test('the real settings component renders distinct factory choices and marks only the actual selected ID',()=>{
  const html=settingsMarkup(state());assert.match(html,/Selected · native-fast/);assert.match(html,/Use this engine · native-careful/);assert.doesNotMatch(html,/Use this engine · community-harness-pack/);assert.match(html,/title="native-fast" disabled=""/);assert.match(html,/Disable/);
});

test('settings keeps plugin toggles but offers no engine selection for disabled or unregistered packages',()=>{
  const disabled=settingsMarkup(state({plugins:[plugin({enabled:false,active:false})]}));assert.doesNotMatch(disabled,/Use this engine|Selected ·/);assert.match(disabled,/>Enable<\/button>/);
  const unregistered=settingsMarkup(state({engineProviders:[]}));assert.doesNotMatch(unregistered,/Use this engine|Selected ·/);assert.match(unregistered,/>Disable<\/button>/);
});

class Element {
  constructor(tag){this.tagName=tag;this.children=[];this.textContent='';this.hidden=false;}
  append(...children){this.children.push(...children);}
  replaceChildren(...children){this.children=[...children];}
  remove(){}
}
function nodes(element){return [element,...element.children.flatMap(nodes)];}
const coreCode=await transform(await readFile(new URL('../shell/core.js',import.meta.url),'utf8'),{format:'cjs'});
async function recoveryShell(snapshot){
  let current=structuredClone(snapshot);const requests=[],core=new Element('div'),root=new Element('div');
  const document={getElementById:id=>id==='dsh-core'?core:root,createElement:tag=>new Element(tag),head:new Element('head')};
  const fetch=async(url,options={})=>{
    if(url==='/api/bootstrap')return Response.json({capability:'synthetic-capability',state:current});
    if(url==='/api/events')return new Response(': connected\n\n',{headers:{'content-type':'text/event-stream'}});
    if(url==='/api/state')return Response.json(current);
    const body=options.body?JSON.parse(options.body):undefined;requests.push({url,body});if(url==='/api/engine/select')current={...current,selectedEngine:body.id};
    return {ok:true,json:async()=>({ok:true})};
  };
  const require=id=>id==='./locales.js'?{resources}:id==='./engine-providers.js'?{pluginEngineProviders}:id==='./event-stream.js'?eventTransport:id==='./reconnect.js'?{ReconnectController:class extends ReconnectController{constructor(options){super({...options,schedule:()=>0,cancel:()=>{}});}}}:null;
  new Function('require','module','exports','document','window','fetch','setTimeout',coreCode.code)(require,{exports:{}},{},document,{addEventListener(){}},fetch,()=>0);
  await new Promise(resolve=>setImmediate(resolve));return {core,requests};
}

test('the real recovery shell selects the registered factory ID when the package ID differs',async()=>{
  const {core,requests}=await recoveryShell(state());
  const select=nodes(core).find(node=>node.tagName==='button'&&node.textContent==='Switch engine · native-careful');assert.ok(select);await select.onclick();
  assert.deepEqual(requests,[{url:'/api/engine/select',body:{id:'native-careful'}}]);assert.ok(nodes(core).some(node=>node.textContent==='Current engine · native-careful'));
});

test('recovery shell does not expose guessed or stale choices but retains enable controls',async()=>{
  for(const snapshot of [state({engineProviders:[]}),state({plugins:[plugin({active:false,enabled:false})]})]){
    const {core}=await recoveryShell(snapshot),buttons=nodes(core).filter(node=>node.tagName==='button');
    assert.equal(buttons.some(node=>node.textContent.startsWith('Switch engine')),false);
    assert.ok(buttons.some(node=>['Enable','Disable'].includes(node.textContent)));
  }
});
