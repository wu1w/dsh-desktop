import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {transform} from 'esbuild';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {translator} from '../src/i18n.js';
const file=new URL('../src/transcript-item.jsx',import.meta.url),markdownFile=new URL('../src/markdown.jsx',import.meta.url),require=createRequire(file);
const compiled=await transform(await readFile(file,'utf8'),{loader:'jsx',format:'cjs'}),markdownCode=await transform(await readFile(markdownFile,'utf8'),{loader:'jsx',format:'cjs'});
const markdownModule={exports:{}};new Function('require','module','exports',markdownCode.code)(createRequire(markdownFile),markdownModule,markdownModule.exports);
const markdown=markdownModule.exports,module={exports:{}};new Function('require','module','exports',compiled.code)(id=>id==='./markdown.jsx'?markdown:require(id),module,module.exports);
const {TranscriptItem}=module.exports;
const base={item:{id:'answer',type:'agentMessage',text:'A **bold** answer with `<script>` and [source](notes.md:2:3).'},locale:'en',projectId:'A',projectPath:'/fixture/A',filesEnabled:true,onCopy(){},onOpenFile(){}};
const html=(extra={})=>renderToStaticMarkup(React.createElement(TranscriptItem,{...base,...extra}));
function nodes(tree){if(Array.isArray(tree))return tree.flatMap(nodes);return !tree||typeof tree!=='object'?[]:[tree,...nodes(tree.props?.children)];}
function tree(extra={}){return TranscriptItem.type({...base,...extra});}
for(const locale of ['en','zh-CN'])test('actual localized assistant row preserves history identity, Markdown, accessible copy and safe text: '+locale,()=>{
  const value=html({locale}),t=translator(locale);assert.match(value,/<article class="transcript-item agentMessage" data-history-id="answer">/);assert.ok(value.includes('<strong>bold</strong>'));assert.ok(value.includes('&lt;script&gt;'));assert.ok(value.includes('class="message-actions"'));assert.ok(value.includes('aria-label="'+t('copy')+'"'));assert.ok(value.includes('aria-label="'+t('openFile')+': source"'));assert.doesNotMatch(value,/<script>/);
});
test('real assistant copy callback returns exact text and all Markdown file opens bind the owning project and location',()=>{
  const calls=[],value=tree({onCopy:text=>calls.push(['copy',text]),onOpenFile:(...args)=>calls.push(['open',...args])});
  nodes(value).find(node=>node.type==='button').props.onClick();assert.deepEqual(calls,[['copy',base.item.text]]);
  const content=nodes(value).find(node=>node.type===markdown.Markdown);content.props.onOpenFile('notes.md',{line:2,column:3});content.props.onOpenFile('plain.md');
  assert.deepEqual(calls.slice(1),[['open','notes.md','A',{line:2,column:3}],['open','plain.md','A',undefined]]);
  const changed=nodes(tree({projectId:'B',projectPath:'/fixture/B',onOpenFile:(...args)=>calls.push(['open',...args])})).find(node=>node.type===markdown.Markdown);assert.equal(changed.props.projectPath,'/fixture/B');changed.props.onOpenFile('same.md',{line:9});assert.deepEqual(calls.at(-1),['open','same.md','B',{line:9}]);
});
test('user and reasoning rows retain their original bubble/details structure and localized summaries',()=>{
  const user=html({item:{...base.item,type:'userMessage'}});assert.match(user,/class="transcript-item userMessage"/);assert.match(user,/class="user-bubble"/);assert.doesNotMatch(user,/message-actions/);
  const reasoning=html({locale:'zh-CN',item:{...base.item,type:'reasoning'}});assert.match(reasoning,/<details class="tool-event"><summary>/);assert.ok(reasoning.includes(translator('zh-CN')('thoughts')));assert.match(reasoning,/class="markdown"/);assert.doesNotMatch(reasoning,/<details[^>]+ open/);
});
for(const [type,key]of [['commandExecution','command'],['fileChange','fileChange'],['error','error'],['unknownTool','tool']])test('actual '+type+' row retains localized tool content, running state and safe file chips',()=>{
  const value=html({locale:'zh-CN',item:{id:'tool',type,running:true,command:'printf "<unsafe>"',output:'中文 output',paths:['src/file.js:4',null,'../outside']}});
  assert.ok(value.includes(translator('zh-CN')(key)));assert.ok(value.includes('spinner'));assert.ok(value.includes('printf &quot;&lt;unsafe&gt;&quot;'));assert.ok(value.includes('中文 output'));assert.ok(value.includes('src/file.js:4'));assert.ok(!value.includes('>null<'));
  assert.equal(value.includes('error-event'),type==='error');assert.ok(value.includes('<span class="file-chip">'));assert.ok(value.includes('<button type="button" class="file-chip"'));
});
test('tool file chips invoke the captured project bridge while disabled file access renders no actionable references',()=>{
  const calls=[],item={id:'tool',type:'fileChange',paths:['src/code.js:6:2'],text:'updated'};
  const enabled=nodes(tree({item,onOpenFile:(...args)=>calls.push(args)})).find(node=>node.type===markdown.FileReference);assert.equal(enabled.props.projectPath,'/fixture/A');const button=markdown.FileReference(enabled.props);button.props.onClick();assert.deepEqual(calls,[['src/code.js','A',{line:6,column:2}]]);
  const disabled=html({item,filesEnabled:false});assert.ok(disabled.includes('<span class="file-chip">'));assert.doesNotMatch(disabled,/<button[^>]+class="file-chip"/);
  const noFiles=nodes(tree({filesEnabled:false})).find(node=>node.type===markdown.Markdown);assert.equal(noFiles.props.onOpenFile,null);
});
test('new text and locale render current content while memo uses every public prop rather than only item IDs',()=>{
  assert.equal(TranscriptItem.$$typeof,Symbol.for('react.memo'));assert.equal(TranscriptItem.compare,null,'React default shallow equality includes owner, locale, permissions and action references');
  const changed=html({item:{...base.item,text:'Updated **current** text'},locale:'zh-CN'});assert.ok(changed.includes('Updated <strong>current</strong> text'));assert.ok(!changed.includes('A <strong>bold</strong>'));assert.ok(changed.includes(translator('zh-CN')('copy')));
});
