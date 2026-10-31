import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {transform} from 'esbuild';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ApprovalController} from '../src/lib/approval-controller.js';
import {translator} from '../src/i18n.js';

// Transpile only in memory so the real component can be rendered without a
// browser or any generated app/engine resources.
const url=new URL('../src/approval-panel.jsx',import.meta.url),source=await readFile(url,'utf8');
const compiled=await transform(source,{loader:'jsx',format:'cjs'}),module={exports:{}};
new Function('require','module','exports',compiled.code)(createRequire(url),module,module.exports);
const {ApprovalPanel}=module.exports;
const request=(questions,isBlocking=true)=>({id:'opaque-uuid',method:'item/tool/requestUserInput',params:{questions,isBlocking}});
const question=(extra={})=>({id:'q',header:'Access',question:'Which access should be used?',isOther:false,isSecret:false,options:null,...extra});
function render(controller){return renderToStaticMarkup(React.createElement(ApprovalPanel,{snapshot:controller.snapshot(),t:translator('en'),locale:'en',onChoose(){},onType(){},onMove(){},onSkip(){},onSubmit(){}}));}

test('real secret input markup uses a password field and never renders an unmasked textarea',()=>{
  const controller=new ApprovalController();controller.enqueue(request([question({isSecret:true})]));controller.type('opaque-uuid','q','synthetic secret');
  const html=render(controller);assert.match(html,/<input type="password" autoComplete="new-password"/);assert.doesNotMatch(html,/<textarea/);assert.match(html,/not saved to drafts/);
});

test('option descriptions render with unchecked radios and the submit button starts disabled',()=>{
  const controller=new ApprovalController();controller.enqueue(request([question({options:[{label:'Read only',description:'Allow reading the current project'}],isOther:true})]));
  const html=render(controller);assert.match(html,/Allow reading the current project/);assert.equal((html.match(/type="radio"/g)??[]).length,2);assert.doesNotMatch(html,/checked=/);assert.match(html,/<button type="submit" class="primary-button" disabled="">Send answers/);
});

test('nonblocking questions use a nonmodal panel and offer answer-later without blocking the rest of the app',()=>{
  const controller=new ApprovalController();controller.enqueue(request([question()],false));const html=render(controller);
  assert.match(html,/^<section/);assert.match(html,/aria-modal="false"/);assert.match(html,/role="dialog"/);assert.match(html,/Answer later/);assert.match(html,/does not block the task/);assert.doesNotMatch(html,/<dialog/);
});

test('unsupported requests do not expose an approve button or raw internal JSON',()=>{
  const controller=new ApprovalController();controller.enqueue({id:'x',method:'mcpServer/elicitation/request',params:{message:'Please enter account details',internalToken:'should not be displayed'}});
  const html=render(controller);assert.match(html,/cannot handle this request type yet/);assert.match(html,/Please enter account details/);assert.doesNotMatch(html,/should not be displayed|type="submit"|internalToken/);
});

test('entrypoint and history panel JSX remain syntactically valid without writing a build',async()=>{
  for(const name of ['main.jsx','agent-panel.jsx','history-controls.jsx'])await transform(await readFile(new URL(`../src/${name}`,import.meta.url),'utf8'),{loader:'jsx',format:'esm'});
});

test('bounded write context appears as collapsible preview and its truncation is visible',()=>{
  const controller=new ApprovalController();controller.enqueue({id:'write',method:'item/permissions/requestApproval',params:{tool:'Write',input:{file_path:'/project/new.md',content:'preview content'}},displayContext:{text:'remaining context',textTruncated:true}});
  const html=render(controller);assert.match(html,/Tool to run/);assert.match(html,/Write/);assert.match(html,/\/project\/new.md/);assert.match(html,/<details class="approval-change-preview"/);assert.match(html,/preview content/);assert.match(html,/This preview is truncated/);
});
