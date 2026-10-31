import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {transform} from 'esbuild';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {translator} from '../src/i18n.js';
import * as terminalController from '../src/lib/terminal-controller.js';
import * as automationsController from '../src/lib/automations-controller.js';
async function component(name){const url=new URL('../src/components/'+name+'.jsx',import.meta.url),module={exports:{}},code=await transform(await readFile(url,'utf8'),{loader:'jsx',format:'cjs'}),realRequire=createRequire(url);const require=id=>id.endsWith('.css')?{}:id==='../api.js'?{api:()=>{throw Error('SSR_MUST_NOT_CALL_API');}}:id.includes('/terminal-controller.js')?terminalController:id.includes('/automations-controller.js')?automationsController:realRequire(id);new Function('require','module','exports',code.code)(require,module,module.exports);return module.exports[name];}
const TerminalPanel=await component('TerminalPanel'),AutomationsPanel=await component('AutomationsPanel');
for(const locale of ['en','zh-CN']){
 test('real terminal component renders translated deliberate-start and process controls in '+locale,()=>{const t=translator(locale),html=renderToStaticMarkup(React.createElement(TerminalPanel,{project:{id:'p',name:'Owned project'},t,locale,onClose:()=>{}}));assert.ok(html.includes(t('ptyNew')));assert.ok(html.includes(t('ptyHide')));assert.ok(html.includes(t('ptyStop')));assert.ok(html.includes(t('ptyStartHelp')));assert.ok(!html.includes('ptyNew'));});
 test('real local task form creates paused and exposes supported permissions without untranslated keys in '+locale,()=>{const t=translator(locale),state={projects:[{id:'p',name:'Owned project'}],selectedEngine:'codex',engineProviders:[{id:'codex',pluginId:'engine-codex'}],plugins:[{id:'engine-codex',active:true}],models:[{id:'deepseek-v4.1-flash',name:'DeepSeek V4.1 Flash'}]},html=renderToStaticMarkup(React.createElement(AutomationsPanel,{state,t,locale,onOpenChat:()=>{}}));assert.ok(html.includes(t('automationCreatePaused')));assert.ok(html.includes(t('automationLocalHelp')));assert.ok(html.includes(t('workspaceWrite')));assert.ok(!html.includes('danger-full-access'));assert.ok(!html.includes('checked=""'));assert.ok(!html.includes('automationStatus_'));});
}
