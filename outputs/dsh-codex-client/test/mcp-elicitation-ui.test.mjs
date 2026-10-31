import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {transform} from 'esbuild';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ApprovalController,canApproveRequest} from '../src/lib/approval-controller.js';
import {translator,dictionaries} from '../src/i18n.js';
const file=new URL('../src/approval-panel.jsx',import.meta.url),require=createRequire(file),compiled=await transform(await readFile(file,'utf8'),{loader:'jsx',format:'cjs'});
const properties={name:{type:'string',title:'Display name',minLength:0,maxLength:3},count:{type:'number',title:'Count',minimum:0,maximum:5},whole:{type:'integer',title:'Whole count',minimum:0},enabled:{type:'boolean',title:'Enable option',default:true},choice:{type:'string',title:'Choice',oneOf:[{const:'first',title:'First choice'},{const:'second',title:'Second choice'}]},tags:{type:'array',title:'Tags',items:{anyOf:[{const:'red',title:'Red tag'},{const:'blue',title:'Blue tag'}]},maxItems:2},note:{type:'string',title:'Optional note',default:'SERVER_DEFAULT'}};
const request=(id='form',extra={})=>({id,method:'mcpServer/elicitation/request',params:{mode:'form',serverName:'Fixture MCP',message:'Explain how the selected options will be used.',threadId:'owned-thread',requestedSchema:{type:'object',properties,required:['name','count','whole','enabled','choice','tags']},internalToken:'MUST_NOT_RENDER',...extra}});
function controller(req=request()){const value=new ApprovalController();value.setElicitationEnabled(true);value.enqueue(req);return value;}
function fill(value,id='form'){for(const [key,entry]of Object.entries({name:'',count:'0',whole:'0',enabled:false,choice:'first',tags:[]}))assert.equal(value.formType(id,key,entry),true);}
function load(react=React,document={}){const module={exports:{}};new Function('require','module','exports','document',compiled.code)(id=>id==='react'?react:require(id),module,module.exports,document);return module.exports;}
const Component=load().ApprovalPanel;
function descendants(value){if(Array.isArray(value))return value.flatMap(descendants);return !value||typeof value!=='object'?[]:[value,...descendants(value.props?.children)];}
function text(value){if(Array.isArray(value))return value.map(text).join('');return !value||typeof value!=='object'?String(value??''):text(value.props?.children);}
function harness(value=controller(),locale='en',legacy=false){
 const slots=[],effects=[],events=new Map(),submissions=[];let cursor=0,nodes=[],closed=0,opened=0,restored=0,focused=0;
 const prior={isConnected:true,focus(){restored++;}},document={activeElement:prior},dialog={showModal(){opened++;},close(){closed++;},querySelector(){return{focus(){focused++;}};},addEventListener(type,listener){events.set(type,listener);},removeEventListener(type,listener){if(events.get(type)===listener)events.delete(type);}};
 const react={...React,useState(initial){const key=cursor++;if(!(key in slots))slots[key]=typeof initial==='function'?initial():initial;return[slots[key],next=>{slots[key]=typeof next==='function'?next(slots[key]):next;}];},useRef(current){return slots[cursor++]??={current};},useEffect(callback,deps){const key=cursor++,old=slots[key];if(!old||deps.some((value,index)=>!Object.is(value,old.deps[index]))){slots[key]={deps,cleanup:old?.cleanup};effects.push(()=>{old?.cleanup?.();slots[key].cleanup=callback();});}}};
 const loaded=load(react,document),Panel=legacy?props=>{const branch=loaded.ApprovalPanel(props);return branch.type(branch.props);}:loaded.ElicitationPanel;
 function render({formsEnabled=true,snapshot=value.snapshot()}={}){cursor=0;const tree=Panel({snapshot,t:translator(locale),locale,formsEnabled,contextName:'Owned chat',onFormType:(name,answer)=>value.formType(snapshot.current.id,name,answer),onSubmit:(allow,options)=>{const token=value.beginSubmit(snapshot.current.id,allow,options);if(token)submissions.push(token);}});nodes=descendants(tree);tree.ref.current=dialog;for(const effect of effects.splice(0))effect();return tree;}
 render();return{controller:value,submissions,render,get nodes(){return nodes;},find(id){return nodes.find(node=>node.props?.id===id);},button(key){return nodes.find(node=>node.type==='button'&&text(node.props.children)===translator(locale)(key));},form(){return nodes.find(node=>node.type==='form');},cancel(){events.get('cancel')?.({preventDefault(){}});},unmount(){for(const slot of slots)slot?.cleanup?.();},get focus(){return{opened,closed,restored,focused,listeners:events.size};}};
}

test('MCP defaults and untouched required fields never become answers; false, numeric zero and explicit empty values stay typed',()=>{
 const value=controller();assert.deepEqual(value.snapshot().elicitation.values,{});assert.equal(value.snapshot().canContinue,false);assert.equal(value.beginSubmit('form',true),null);fill(value);assert.equal(value.snapshot().canContinue,true);const token=value.beginSubmit('form',true,{elicitationAction:'accept'});assert.deepEqual(token.body,{allow:true,elicitationAction:'accept',content:{name:'',count:0,whole:0,enabled:false,choice:'first',tags:[]}});assert.equal(Object.hasOwn(token.body.content,'note'),false);assert.equal(value.beginSubmit('form',false),null);assert.equal(value.formType('form','name','late'),false);
});
test('required own-empty string is distinct from omission and Unicode codepoint limits do not truncate emoji',()=>{
 const value=controller(request('form',{requestedSchema:{type:'object',properties:{emoji:{type:'string',title:'Emoji',maxLength:1}},required:['emoji']}}));assert.equal(value.beginSubmit('form',true),null);value.formType('form','emoji','');assert.equal(value.snapshot().canContinue,true);value.formType('form','emoji','😀');assert.equal(value.snapshot().canContinue,true);value.formType('form','emoji','😀x');assert.equal(value.snapshot().canContinue,false);assert.equal(value.snapshot().elicitation.validation.field,'emoji');value.formType('form','emoji',undefined);assert.deepEqual(value.snapshot().elicitation.values,{});
});
test('numeric coercion and constraints are delegated to the shared helper without blank-to-zero or integer rounding',()=>{
 const value=controller();fill(value);for(const [key,input]of[['count',''],['count','NaN'],['count','6'],['whole','1.2'],['count','0x10']]){value.formType('form',key,input);assert.equal(value.beginSubmit('form',true),null);value.formType('form',key,'0');}assert.equal(value.snapshot().canContinue,true);
});
test('decline and cancel are different protocol actions, contain no field content, and contradictions cannot submit',()=>{
 for(const action of['decline','cancel']){const value=controller();value.formType('form','name','private');assert.equal(value.beginSubmit('form',true,{elicitationAction:action}),null);assert.equal(value.beginSubmit('form',false,{elicitationAction:'accept'}),null);assert.deepEqual(value.beginSubmit('form',false,{elicitationAction:action}).body,{allow:false,elicitationAction:action});}assert.equal(controller().beginSubmit('form',false).body.elicitationAction,'decline');
});
test('FIFO reconciliation preserves matching fields and a failed submit retains input for exactly one retry',()=>{
 const value=controller();fill(value);value.enqueue(request('next'));const token=value.beginSubmit('form',true);assert.equal(value.beginSubmit('next',false),null);value.reconcile([request(),request('next')]);assert.equal(value.snapshot().pending,true);assert.equal(value.fail(token,'Network unavailable'),true);assert.equal(value.snapshot().elicitation.values.enabled,false);const retry=value.beginSubmit('form',true);assert.deepEqual(retry.body,token.body);const old=value.requests.get('form');value.reconcile([request('next')]);assert.equal(old.formValues.size,0);assert.equal(value.complete(retry),false);assert.equal(value.snapshot().current.id,'next');assert.deepEqual(value.snapshot().elicitation.values,{});
});
test('disabling the feature scrubs every queued form and invalidates pending acceptance without resolving the request',()=>{
 const value=controller();fill(value);value.enqueue(request('next'));value.formType('next','name','private next');const old=value.requests.get('form'),next=value.requests.get('next'),token=value.beginSubmit('form',true);value.setElicitationEnabled(false);assert.equal(old.formValues.size,0);assert.equal(next.formValues.size,0);assert.equal(value.snapshot().current.id,'form');assert.equal(value.snapshot().count,2);assert.equal(value.snapshot().pending,false);assert.equal(value.complete(token),false);assert.equal(value.fail(token,'late failure'),false);assert.equal(value.beginSubmit('form',true),null);assert.equal(value.formType('form','name','disabled'),false);value.setElicitationEnabled(true);assert.deepEqual(value.snapshot().elicitation.values,{});assert.equal(value.snapshot().canContinue,false);
});
test('changed form ownership or schema under the same opaque ID cannot reuse entered fields or old submission tokens',()=>{
 const value=controller();fill(value);const old=value.requests.get('form'),token=value.beginSubmit('form',true);value.reconcile([request('form',{threadId:'different-thread'})]);assert.equal(old.formValues.size,0);assert.equal(value.complete(token),false);assert.deepEqual(value.snapshot().elicitation.values,{});value.formType('form','name','new');value.reconcile([request('form',{threadId:'different-thread',requestedSchema:{type:'object',properties:{newField:{type:'boolean'}},required:['newField']}})]);assert.deepEqual(value.snapshot().elicitation.values,{});assert.equal(value.formType('form','name','stale field'),false);
});
test('unsupported schemas and modes never expose acceptance while cancellation remains available',()=>{
 for(const extra of[{mode:'url',url:'https://example.invalid/'},{requestedSchema:{type:'object',properties:{date:{type:'string',format:'date'}}}}]){const value=controller(request('form',extra));assert.equal(canApproveRequest(value.snapshot().current),false);assert.equal(value.beginSubmit('form',true),null);assert.deepEqual(value.beginSubmit('form',false,{elicitationAction:'cancel'}).body,{allow:false,elicitationAction:'cancel'});}
});
test('special property names are owned data, and snapshots cannot mutate a multiselect draft',()=>{
 const properties=Object.fromEntries([['__proto__',{type:'string'}],['constructor',{type:'boolean'}],['tags',{type:'array',items:{type:'string',enum:['a','b']}}]]),value=controller(request('form',{requestedSchema:{type:'object',properties,required:['__proto__','constructor']}}));value.formType('form','__proto__','data');value.formType('form','constructor',false);value.formType('form','tags',['a']);value.snapshot().elicitation.values.tags.push('b');const token=value.beginSubmit('form',true);assert.equal(Object.hasOwn(token.body.content,'__proto__'),true);assert.equal(token.body.content.__proto__,'data');assert.equal(token.body.content.constructor,false);assert.deepEqual(token.body.content.tags,['a']);
});
for(const locale of['en','zh-CN'])test('actual form renders localized safe labels and no preselected defaults in '+locale,()=>{
 const value=controller(),html=renderToStaticMarkup(React.createElement(Component,{snapshot:value.snapshot(),t:translator(locale),locale,formsEnabled:true,onFormType(){},onSubmit(){}}));assert.match(html,/class="dialog approval-panel approval-blocking approval-elicitation"/);assert.ok(html.includes('Fixture MCP'));assert.ok(html.includes('Explain how'));assert.ok(!html.includes('MUST_NOT_RENDER'));assert.ok(html.includes(translator(locale)('elicitationAccept')));assert.ok(html.includes('for="dsh-mcp-field-0"'));assert.ok(html.includes('value=""'));assert.doesNotMatch(html,/maxLength=|type="submit"[^>]*required/);assert.match(html,/<button type="submit"[^>]*disabled/);assert.ok(!html.includes('value="SERVER_DEFAULT"'));assert.equal((html.match(/checked=/g)??[]).length,0);
});
test('actual form length constraints use locale plurals and the same supported-language fallback as other text',()=>{
 const value=controller(request('form',{requestedSchema:{type:'object',properties:{one:{type:'string',minLength:1,maxLength:1},two:{type:'string',minLength:2,maxLength:2},zero:{type:'string',minLength:0,maxLength:1000}}}}));
 for(const [locale,expected]of[
  ['en',['At least 1 character · At most 1 character','At least 2 characters · At most 2 characters','At least 0 characters · At most 1,000 characters']],
  ['zh-CN',['最少 1 个字符 · 最多 1 个字符','最少 2 个字符 · 最多 2 个字符','最少 0 个字符 · 最多 1,000 个字符']],
  ['zh-HK',['最少 1 个字符 · 最多 1 个字符','最少 2 个字符 · 最多 2 个字符','最少 0 个字符 · 最多 1,000 个字符']],
  ['fr-FR',['At least 1 character · At most 1 character','At least 2 characters · At most 2 characters',`At least 0 characters · At most ${new Intl.NumberFormat('fr-FR').format(1000)} characters`]],
  [undefined,['At least 1 character · At most 1 character','At least 2 characters · At most 2 characters']]
 ]){
  const html=renderToStaticMarkup(React.createElement(Component,{snapshot:value.snapshot(),t:translator(locale),locale,formsEnabled:true,onSubmit(){}}));
  for(const text of expected)assert.ok(html.includes(text),`${locale}: ${text}`);
  assert.doesNotMatch(html,/\b1 characters\b/);
 }
});
test('actual input/select/multiselect/empty handlers produce typed content and one submit despite repeated UI calls',()=>{
 const app=harness();app.find('dsh-mcp-field-0-empty').props.onChange({target:{checked:true}});app.find('dsh-mcp-field-1').props.onChange({target:{value:'0'}});app.find('dsh-mcp-field-2').props.onChange({target:{value:'0'}});app.find('dsh-mcp-field-3').props.onChange({target:{value:'false'}});app.find('dsh-mcp-field-4').props.onChange({target:{value:'1'}});app.find('dsh-mcp-field-5-empty').props.onChange({target:{checked:true}});app.render();assert.equal(app.button('elicitationAccept').props.disabled,false);const form=app.form();form.props.onSubmit({preventDefault(){}});form.props.onSubmit({preventDefault(){}});assert.equal(app.submissions.length,1);assert.deepEqual(app.submissions[0].body.content,{name:'',count:0,whole:0,enabled:false,choice:'second',tags:[]});app.unmount();assert.deepEqual(app.focus,{opened:1,closed:1,restored:1,focused:1,listeners:0});
});
test('optional text empty means omitted unless explicitly selected; clear and multi-choice handlers preserve their semantics',()=>{
 const app=harness();fill(app.controller);app.render();app.find('dsh-mcp-field-6').props.onChange({target:{value:'typed'}});app.render();app.find('dsh-mcp-field-6').props.onChange({target:{value:''}});app.render();assert.equal(Object.hasOwn(app.controller.snapshot().elicitation.values,'note'),false);app.find('dsh-mcp-field-6-empty').props.onChange({target:{checked:true}});app.render();assert.equal(app.controller.snapshot().elicitation.values.note,'');app.find('dsh-mcp-field-5-option-0').props.onChange({target:{checked:true}});app.render();assert.deepEqual(app.controller.snapshot().elicitation.values.tags,['red']);app.find('dsh-mcp-field-5-option-0').props.onChange({target:{checked:false}});app.render();assert.deepEqual(app.controller.snapshot().elicitation.values.tags,[]);const omit=app.nodes.find(node=>node.type==='button'&&text(node.props.children)===translator('en')('elicitationOmit'));assert.ok(omit);omit.props.onClick();assert.equal(Object.hasOwn(app.controller.snapshot().elicitation.values,'note'),false);app.unmount();
});
test('actual form IME composition and legacy 229 do not submit, and ordinary submission resumes afterward',()=>{
 const app=harness();fill(app.controller);app.render();let form=app.form();form.props.onCompositionStart();form.props.onSubmit({preventDefault(){}});assert.equal(app.submissions.length,0);form.props.onCompositionEnd();form.props.onKeyDownCapture({key:'Enter',keyCode:229,isComposing:false});form.props.onSubmit({preventDefault(){}});assert.equal(app.submissions.length,0);form.props.onKeyDownCapture({key:'Enter',keyCode:13,isComposing:false});form.props.onSubmit({preventDefault(){}});assert.equal(app.submissions.length,1);app.unmount();
});
test('actual Cancel/X and Decline handlers differ; native dialog Escape cancels and restores focus',()=>{
 for(const key of['cancel','elicitationDecline']){const app=harness();app.button(key).props.onClick();assert.equal(app.submissions[0].body.elicitationAction,key==='cancel'?'cancel':'decline');app.unmount();}const app=harness();app.cancel();assert.deepEqual(app.submissions[0].body,{allow:false,elicitationAction:'cancel'});app.unmount();assert.equal(app.focus.restored,1);
});
test('a disabled prop redacts even a stale snapshot and never renders an acceptance control or private entered value',()=>{
 const value=controller();value.formType('form','name','private input');const old=value.snapshot(),html=renderToStaticMarkup(React.createElement(Component,{snapshot:old,t:translator('en'),locale:'en',formsEnabled:false,onSubmit(){}}));assert.ok(!html.includes('private input'));assert.ok(!html.includes('type="submit"'));assert.ok(html.includes(translator('en')('elicitationDisabled')));
});
test('new form translation keys are complete in both languages and shared errors use the same resources',()=>{
 const keys=Object.keys(dictionaries.en).filter(key=>key.startsWith('elicitation'));assert.ok(keys.length>20);for(const key of keys){assert.equal(typeof dictionaries['zh-CN'][key],'string');assert.notEqual(translator('zh-CN')(key),key);}for(const key of['MCP_ELICITATION_UNSUPPORTED','MCP_ELICITATION_INVALID_CONTENT','MCP_ELICITATION_LIMIT'])assert.notEqual(translator('en')(key),key);
});

test('post-composition Escape with legacy 229 or isComposing cannot cancel the native form, while ordinary Escape still can',()=>{
 for(const flags of[{keyCode:229,isComposing:false},{keyCode:27,isComposing:true}]){const app=harness();const form=app.form();form.props.onCompositionStart();form.props.onCompositionEnd();form.props.onKeyDownCapture({key:'Escape',...flags});app.cancel();assert.equal(app.submissions.length,0,'candidate Escape must not become MCP cancellation');form.props.onKeyDownCapture({key:'Escape',keyCode:27,isComposing:false});app.cancel();assert.equal(app.submissions.length,1);assert.equal(app.submissions[0].body.elicitationAction,'cancel');app.unmount();}
});

test('ordinary approval native cancellation also leaves candidate Escape untouched and restores normal deny afterward',()=>{
 const value=new ApprovalController();value.enqueue({id:'command',method:'execCommandApproval',params:{command:['echo','fixture']}});const app=harness(value,'en',true),dialog=app.nodes[0];dialog.props.onCompositionStart();dialog.props.onCompositionEnd();dialog.props.onKeyDownCapture({key:'Escape',keyCode:229,isComposing:false});app.cancel();assert.equal(app.submissions.length,0);dialog.props.onKeyDownCapture({key:'Escape',keyCode:27,isComposing:false});app.cancel();assert.deepEqual(app.submissions[0].body,{allow:false,answers:{}});app.unmount();
});

test('feature disable clears unfinished IME state even when input removal emits no compositionend',()=>{
 const app=harness();app.form().props.onCompositionStart();app.form().props.onKeyDownCapture({key:'Enter',keyCode:229,isComposing:false});app.controller.setElicitationEnabled(false);app.render({formsEnabled:false});app.controller.setElicitationEnabled(true);fill(app.controller);app.render();assert.equal(app.controller.snapshot().canContinue,true);app.form().props.onSubmit({preventDefault(){}});assert.equal(app.submissions.length,1);app.unmount();
});
test('a new request generation under the same ID resets old composition and candidate-key state',()=>{
 const app=harness();app.form().props.onCompositionStart();app.form().props.onKeyDownCapture({key:'Escape',keyCode:229,isComposing:false});app.controller.enqueue(request('form',{threadId:'new-owner-thread'}));fill(app.controller);app.render();app.form().props.onSubmit({preventDefault(){}});assert.equal(app.submissions.length,1);app.unmount();
});
test('moving a question clears composition belonging to the removed previous input',()=>{
 const value=new ApprovalController();value.enqueue({id:'questions',method:'item/tool/requestUserInput',params:{questions:[{id:'one',question:'First',options:[]},{id:'two',question:'Second',options:[]}]}});value.type('questions','one','first answer');const app=harness(value,'en',true),dialog=app.nodes[0];dialog.props.onCompositionStart();assert.equal(value.move('questions',1),true);app.render();app.cancel();assert.equal(app.submissions.length,1);assert.deepEqual(app.submissions[0].body,{allow:false,answers:{}});app.unmount();
});
test('controller owns MCP request schema and normalized fields instead of exposing externally mutable definitions',()=>{
 const incoming=structuredClone(request()),value=controller(incoming);fill(value);const snapshot=value.snapshot(),form=snapshot.elicitation.fields;incoming.params.requestedSchema.properties.name.type='boolean';incoming.params.message='external mutation';assert.equal(value.snapshot().current.params.requestedSchema.properties.name.type,'string');assert.equal(value.snapshot().elicitation.message,'Explain how the selected options will be used.');assert.equal(value.snapshot().canContinue,true);assert.throws(()=>{snapshot.current.params.requestedSchema.properties.name.type='boolean';},TypeError);assert.throws(()=>{form[0].type='number';},TypeError);assert.throws(()=>{form.find(field=>field.type==='enum').options[0].value='changed';},TypeError);assert.equal(value.snapshot().elicitation.fields,form);assert.equal(value.beginSubmit('form',true).body.content.name,'');assert.equal(Object.isFrozen(incoming),false);
});
test('iterative request ownership handles deeply nested plain JSON once and reuses it during typing',()=>{
 const incoming=structuredClone(request());incoming.params.extra={};let leaf=incoming.params.extra;for(let index=0;index<20000;index++)leaf=leaf.next={};leaf.value='owned';const value=controller(incoming),owned=value.snapshot().current;assert.notEqual(owned.params.extra,incoming.params.extra);let last=owned.params.extra;for(let index=0;index<20000;index++)last=last.next;assert.equal(last.value,'owned');assert.equal(Object.isFrozen(last),true);leaf.value='external';assert.equal(last.value,'owned');value.formType('form','name','x');assert.equal(value.snapshot().current,owned);assert.equal(value.snapshot().elicitation.fields,value.snapshot().elicitation.fields);
});
