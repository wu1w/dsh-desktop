import test from 'node:test';
import assert from 'node:assert/strict';
import {renderRecovery} from '../shell/recovery-view.js';
import {resources} from '../shell/locales.js';
class Element{
  constructor(tag){this.tagName=tag;this.children=[];this.attributes={};this.textContent='';}
  append(...nodes){for(const node of nodes){node.parent=this;this.children.push(node);}}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this);}
  setAttribute(key,value){this.attributes[key]=value;}
  querySelector(tag){return all(this).find(node=>node!==this&&node.tagName===tag)??null;}
  focus(){this.focused=true;}
}
const all=node=>[node,...node.children.flatMap(all)];
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function view(locale='en',extra={},act=async()=>{}){const container=new Element('main'),t=key=>resources[locale][key]??resources.en[key]??key;const panel=renderRecovery({document:{createElement:tag=>new Element(tag)},container,t,locale,act,recovery:{code:'CLIENT_STATE_INVALID',canReset:true,candidates:[{id:'last-good',createdAt:'2026-10-23T00:00:00.000Z',projects:2,sessions:3}],...extra}});return{panel,t,button:label=>all(panel).find(node=>node.tagName==='button'&&node.textContent===t(label))};}
for(const locale of ['en','zh-CN'])test('actual recovery view requires a separate confirmation and never auto-restores in '+locale,async()=>{
  const calls=[];let release;const pending=new Promise(resolve=>release=resolve),v=view(locale,{},body=>{calls.push(body);return pending;});
  assert.equal(calls.length,0);v.button('recoveryRestore').onclick();assert.equal(calls.length,0);assert.ok(v.button('recoveryCancel').focused);
  v.button('recoveryConfirm').onclick();v.button('recoveryConfirm').onclick();await flush();assert.deepEqual(calls,[{action:'restore',candidateId:'last-good'}]);assert.ok(v.button('recoveryRetry').disabled);release();await flush();assert.equal(v.button('recoveryRetry').disabled,false);
});
test('cancelling reset changes no data and unsafe paths expose retry without destructive actions',()=>{
  const calls=[],v=view('en',{},body=>calls.push(body));v.button('recoveryReset').onclick();v.button('recoveryCancel').onclick();assert.equal(calls.length,0);assert.equal(v.button('recoveryConfirm'),undefined);
  const unsafe=view('en',{canReset:false,code:'CLIENT_STATE_UNSAFE_PATH'});assert.ok(unsafe.button('recoveryRetry'));assert.equal(unsafe.button('recoveryRestore'),undefined);assert.equal(unsafe.button('recoveryReset'),undefined);
});
