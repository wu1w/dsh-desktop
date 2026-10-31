import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {transform,build} from 'esbuild';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {markdownLink} from '../src/lib/markdown-links.js';

const options={projectPath:'/projects/A'};
test('file citations retain exact positive line, column and ordered range locations',()=>{
  const examples=[['src/a.js:12',{line:12}],['src/a.js:12:3',{line:12,column:3}],['src/a.js#L12',{line:12}],['src/a.js#L12-L15',{line:12,endLine:15}],['src/a.js#L12C3-L15C4',{line:12,column:3,endLine:15,endColumn:4}],['src/a.js#L12C3-L12C3',{line:12,column:3,endLine:12,endColumn:3}],['src/a.js#L12C3',{line:12,column:3}],['src/a.js:9007199254740991',{line:Number.MAX_SAFE_INTEGER}]];
  for(const [target,location]of examples)assert.deepEqual(markdownLink(target,options),{type:'file',path:'src/a.js',location},target);
  assert.deepEqual(markdownLink('/projects/A/src/a.js:2:4',options),{type:'file',path:'src/a.js',location:{line:2,column:4}});
  assert.deepEqual(markdownLink('../src/a.js#L3-L4',{...options,documentPath:'docs/guide.md'}),{type:'file',path:'src/a.js',location:{line:3,endLine:4}});
  assert.deepEqual(markdownLink('src/a.js',options),{type:'file',path:'src/a.js'});
});
test('invalid or ambiguous locations, query pseudo-links and project escapes cannot request a file',()=>{
  for(const target of ['a.js:0','a.js:-1','a.js:NaN','a.js:Infinity','a.js:1:0','a.js:1:-2','a.js:1:2:3','a.js:9007199254740992','a.js#L0','a.js#L-1','a.js#LNaN','a.js#L1-L0','a.js#L2-L1','a.js#L1C5-L1C4','a.js#L1C0','a.js#L1-L2C0','a.js#L1-L9007199254740992','a.js:1#L2','a.js#L1#L2','a.js#heading','a.js?next=/api/bootstrap','a.js:2?token=1','javascript:12','file:12','http:12','data:12','tel:123','sms:123','vbscript:12','https%3A%2F%2Fexample.invalid%2Fa','%2F%2Fevil/a:1','../outside.js:2','%2e%2e/outside.js#L2','/projects/A-other/a.js:2','.git/config#L1','a.js%00#L1'])assert.equal(markdownLink(target,options),null,target);
  assert.equal(markdownLink('a.js',{...options,documentPath:12}),null);
  assert.deepEqual(markdownLink('https://example.invalid/a.js?x=1#L0',options),{type:'external',href:'https://example.invalid/a.js?x=1#L0'});
});
test('encoded filename delimiters remain literal filenames rather than location or network syntax',()=>{
  assert.deepEqual(markdownLink('docs/金额%20表%23L2.md:5',options),{type:'file',path:'docs/金额 表#L2.md',location:{line:5}});
  assert.deepEqual(markdownLink('docs/part%3Fname.md',options),{type:'file',path:'docs/part?name.md'});
  assert.deepEqual(markdownLink('docs/file%3Aname.md#L2',options),{type:'file',path:'docs/file:name.md',location:{line:2}});
});

const markdownFile=new URL('../src/markdown.jsx',import.meta.url),markdownModule={exports:{}};
const markdownCode=await transform(await readFile(markdownFile,'utf8'),{loader:'jsx',format:'cjs'});
new Function('require','module','exports',markdownCode.code)(createRequire(markdownFile),markdownModule,markdownModule.exports);
const {Markdown,MarkdownLink,FileReference}=markdownModule.exports;
test('actual Markdown and raw file references forward validated positions while unsafe raw links stay text',()=>{
  const opened=[],onOpenFile=(...args)=>opened.push(args),location={line:12,column:3,endLine:15,endColumn:4};
  const link=MarkdownLink({label:'source',target:'src/a.js#L12C3-L15C4',...options,onOpenFile});assert.equal(link.type,'button');link.props.onClick();assert.deepEqual(opened,[['src/a.js',location]]);
  const raw=FileReference({target:'src/a.js:2',...options,onOpenFile,t:key=>key==='openFile'?'Open file':key});assert.equal(raw.type,'button');raw.props.onClick();assert.deepEqual(opened.at(-1),['src/a.js',{line:2}]);assert.ok(raw.props['aria-label'].includes('Open file'));
  for(const target of ['https://example.invalid/a.js','../outside.js:1','a.js:0','javascript:alert(1)'])assert.equal(FileReference({target,...options,onOpenFile}).type,'span');assert.equal(opened.length,2);
  const plain=FileReference({target:'src/a.js',...options,onOpenFile});plain.props.onClick();assert.deepEqual(opened.at(-1),['src/a.js']);
});
test('actual SSR exposes accessible file buttons and preserves literal code and non-executable invalid references',()=>{
  const html=renderToStaticMarkup(React.createElement(Markdown,{text:'[source](src/a.js#L2C1-L3C2) [invalid](src/a.js#L0)\n\n```md\n[literal](src/a.js:4)\n```',...options,onOpenFile(){},t:key=>key==='openFile'?'Open file':key}));
  assert.match(html,/<button[^>]+title="src\/a.js"[^>]+aria-label="Open file: source"/);assert.match(html,/<span[^>]*>invalid<\/span>/);assert.ok(html.includes('[literal](src/a.js:4)'));assert.doesNotMatch(html,/href="src/);
});

const timelineFile=new URL('../src/transcript-timeline.jsx',import.meta.url),timelineModule={exports:{}};
const timelineBundle=await build({entryPoints:[timelineFile.pathname],bundle:true,write:false,platform:'node',format:'cjs',external:['react','react-dom','react/jsx-runtime','lucide-react']});
const timelineReact={...React,useState:initial=>[typeof initial==='function'?initial():initial,()=>{}],useId:()=>':test:',useEffect(){}};
new Function('require','module','exports',timelineBundle.outputFiles[0].text)(id=>id==='react'?timelineReact:createRequire(timelineFile)(id),timelineModule,timelineModule.exports);
const panelFile=new URL('../src/agent-panel.jsx',import.meta.url),panelCode=await transform(await readFile(panelFile,'utf8'),{loader:'jsx',format:'cjs'}),panelRequire=createRequire(panelFile);
function agentTree({selected='agent-A',owner='agent-A'}={}){
  const opened=[],history={sessionId:owner,items:[{id:'answer',type:'agentMessage',text:'[source](src/a.js:3)'},{id:'tool',type:'fileChange',text:'Edited files',paths:['src/a.js#L2C3-L4C5','../outside.js:2','src/a.js:0']}],history:{hasMore:false},running:false,loadingInitial:false};let index=0;
  const states=[selected,Date.now(),{snapshot:()=>history},history],react={...React,useState:()=>[states[index++],()=>{}],useRef:current=>({current}),useEffect(){},useLayoutEffect(){}};const module={exports:{}};
  new Function('require','module','exports',panelCode.code)(id=>id==='react'?react:id==='./markdown.jsx'?markdownModule.exports:id==='./transcript-timeline.jsx'?timelineModule.exports:id==='./api.js'?{}:id==='./history-controls.jsx'?{HistoryControls:()=>null}:panelRequire(id),module,module.exports);
  const sessions=[{id:'agent-A',kind:'agent',title:'A',projectId:'project-A'},{id:'agent-B',kind:'agent',title:'B',projectId:'project-B'}];
  const tree=module.exports.AgentPanel({sessions,projects:[{id:'project-A',path:'/projects/A'},{id:'project-B',path:'/projects/B'}],onOpenFile:(...args)=>opened.push(args),t:key=>key,locale:'en'});return {tree,opened};
}
function descendants(value){if(Array.isArray(value))return value.flatMap(descendants);if(!value||typeof value!=='object')return [];const component=typeof value.type==='function'?value.type:value.type?.type;if(component&&['TranscriptTimeline','TranscriptTurn','ActivityGroup','TranscriptItem2','TranscriptItem'].includes(component.name))return [value,...descendants(component(value.props))];return [value,...descendants(value.props?.children)];}
test('actual AgentPanel forwards Markdown and tool references to the source project with the third location argument',()=>{
  const {tree,opened}=agentTree(),nodes=descendants(tree);const markdown=nodes.find(node=>node.type?.name==='Markdown');markdown.props.onOpenFile('src/a.js',{line:3});assert.deepEqual(opened[0],['src/a.js','project-A',{line:3}]);
  const chips=nodes.filter(node=>node.type?.name==='FileReference');assert.equal(chips.length,3);const button=FileReference(chips[0].props);assert.equal(button.type,'button');button.props.onClick();assert.deepEqual(opened[1],['src/a.js','project-A',{line:2,column:3,endLine:4,endColumn:5}]);for(const chip of chips.slice(1))assert.equal(FileReference(chip.props).type,'span');assert.equal(opened.length,2);
});
test('AgentPanel does not attach old-project file references to a newly selected agent',()=>{
  const {tree,opened}=agentTree({selected:'agent-B',owner:'agent-A'});const nodes=descendants(tree);assert.equal(nodes.filter(node=>node.type?.name==='Markdown'||node.type?.name==='FileReference').length,0);assert.deepEqual(opened,[]);
});
