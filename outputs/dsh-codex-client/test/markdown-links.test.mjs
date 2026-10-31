import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {transform} from 'esbuild';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {markdownLink} from '../src/lib/markdown-links.js';

const options={projectPath:'/Users/fixture/project'};
test('project citations resolve relative, absolute, encoded and document-relative file paths',()=>{
  for(const target of ['src/app.jsx','./src/app.jsx','/Users/fixture/project/src/app.jsx'])assert.deepEqual(markdownLink(target,options),{type:'file',path:'src/app.jsx'});
  for(const target of ['/Users/fixture/project/src/app.jsx:42','src/app.jsx#L42'])assert.deepEqual(markdownLink(target,options),{type:'file',path:'src/app.jsx',location:{line:42}});
  assert.deepEqual(markdownLink('资料/金额%20表.md',options),{type:'file',path:'资料/金额 表.md'});
  assert.deepEqual(markdownLink('../README.md',{...options,documentPath:'docs/guide.md'}),{type:'file',path:'README.md'});
  assert.deepEqual(markdownLink('./nested/file.md',{...options,documentPath:'docs/guide.md'}),{type:'file',path:'docs/nested/file.md'});
});
test('file citations cannot become authenticated loopback requests, metadata or escaped project paths',()=>{
  for(const target of ['../outside.md','%2e%2e/outside.md','/Users/fixture/project-other/secret','/Users/fixture/project/../secret','//other.example/file','/api/bootstrap','file:///Users/fixture/project/a','javascript:alert(1)','data:text/html,test','.git/config','docs/../.git/config','bad%00file','bad%0Afile','bad\\path','%2F%2Fhost/a','%ZZ','#heading','https://example.invalid/\ntext'])assert.equal(markdownLink(target,options),null,target);
  assert.equal(markdownLink('README.md'),null);
  assert.equal(markdownLink('../../../outside.md',{...options,documentPath:'docs/guide.md'}),null);
});
test('web and email links retain their explicit schemes independently of project context',()=>{
  assert.deepEqual(markdownLink('https://example.invalid/path?q=1'),{type:'external',href:'https://example.invalid/path?q=1'});
  assert.deepEqual(markdownLink('mailto:fixture@example.invalid'),{type:'external',href:'mailto:fixture@example.invalid'});
  assert.equal(markdownLink('ftp://example.invalid/file',options),null);
});

const file=new URL('../src/markdown.jsx',import.meta.url),module={exports:{}};
const source=await transform(await readFile(file,'utf8'),{loader:'jsx',format:'cjs'});
new Function('require','module','exports',source.code)(createRequire(file),module,module.exports);
const {Markdown,MarkdownLink}=module.exports;
function html(text,props={}){return renderToStaticMarkup(React.createElement(Markdown,{text,...options,onOpenFile:()=>{},...props}));}
test('the actual renderer makes project links buttons, web links anchors, and never renders executable markup',()=>{
  const value=html('[source](src/app.jsx:42) [space](<docs/file name.md>) [nested](docs/file(1).md) [web](https://example.invalid) [bad](javascript:alert(1)) <script>bad()</script>');
  assert.match(value,/<button[^>]+title="src\/app.jsx"[^>]*>source<\/button>/);
  assert.match(value,/title="docs\/file name.md"/);assert.match(value,/title="docs\/file\(1\).md"/);
  assert.match(value,/<a href="https:\/\/example.invalid\/" target="_blank" rel="noopener noreferrer">web<\/a>/);
  assert.doesNotMatch(value,/href="(?:javascript|\/api|src\/)/);assert.doesNotMatch(value,/<script>/);assert.match(value,/&lt;script&gt;/);
  assert.doesNotMatch(html('[source](src/app.jsx)',{onOpenFile:null}),/<button|href=/);
});
test('clicking the real file-link component opens exactly its captured project path',()=>{
  const opened=[];
  const element=MarkdownLink({label:'source',target:'../src/app.jsx',...options,documentPath:'docs/guide.md',onOpenFile:path=>opened.push(path)});
  assert.equal(element.type,'button');element.props.onClick();assert.deepEqual(opened,['src/app.jsx']);
  assert.equal(MarkdownLink({label:'unsafe',target:'../../outside',...options,onOpenFile:path=>opened.push(path)}).type,'span');assert.equal(opened.length,1);
});
test('headings, lists, tables and quotes carry project context while code remains literal',()=>{
  const value=html('# [title](a.md)\n\n- [list](b.md)\n\n| Name |\n| --- |\n| [cell](c.md) |\n\n> [quote](d.md)\n\n```md\n[literal](e.md)\n```');
  // The existing parser supports two-column Markdown tables.
  assert.match(value,/title="a.md"/);assert.match(value,/title="b.md"/);assert.match(value,/title="d.md"/);
  assert.doesNotMatch(value,/title="e.md"/);assert.match(value,/\[literal\]\(e.md\)/);
  const table=html('| Name | Value |\n| --- | --- |\n| [cell](c.md) | 1 |');assert.match(table,/title="c.md"/);
});
