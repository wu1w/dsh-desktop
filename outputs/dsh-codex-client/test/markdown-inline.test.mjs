import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {transform} from 'esbuild';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {markdownInline} from '../src/lib/markdown-inline.js';

test('balanced inline formatting retains text, one-level parentheses, angle paths and explicit targets',()=>{
 assert.deepEqual(markdownInline('中文 `x` **粗体** *斜体* [文件](<docs/金额 表.md:4:2>) [next](docs/a(1).md)'),[
  {kind:'text',text:'中文 '},{kind:'code',text:'x'},{kind:'text',text:' '},{kind:'bold',text:'粗体'},{kind:'text',text:' '},{kind:'italic',text:'斜体'},{kind:'text',text:' '},{kind:'link',text:'文件',target:'docs/金额 表.md:4:2'},{kind:'text',text:' '},{kind:'link',text:'next',target:'docs/a(1).md'},
 ]);
 assert.deepEqual(markdownInline('[safe](https://example.invalid/a(b)?q=x) [raw](<a>b)'),[{kind:'link',text:'safe',target:'https://example.invalid/a(b)?q=x'},{kind:'text',text:' '},{kind:'link',text:'raw',target:'<a>b'}]);
});
test('unfinished inline delimiters remain complete literal text while the next valid fragment still renders',()=>{
 for(const value of ['`unfinished','**unfinished','*unfinished','[unfinished','[bad](a(b(c))','[bad](a\nb)','[bad\nlabel](a)','[]()','[](<>)'])assert.deepEqual(markdownInline(value),[{kind:'text',text:value}],value);
 assert.deepEqual(markdownInline('`unfinished [file](a.md)'),[{kind:'text',text:'`unfinished '},{kind:'link',text:'file',target:'a.md'}]);
});
function reference(text){
 const pattern=/(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]\n]+\]\((?:<[^>\n]+>|[^\s()]+(?:\([^\n()]*\)[^\s()]*)*)\))/g,result=[];let prior=0,match;
 while((match=pattern.exec(text))){if(match.index>prior)result.push({kind:'text',text:text.slice(prior,match.index)});const value=match[0];
  if(value[0]==='`')result.push({kind:'code',text:value.slice(1,-1)});
  else if(value.startsWith('**'))result.push({kind:'bold',text:value.slice(2,-2)});
  else if(value[0]==='*')result.push({kind:'italic',text:value.slice(1,-1)});
  else{const link=/^\[([^\]]+)\]\(([\s\S]+)\)$/.exec(value),target=link[2],angle=/^<[^>\n]+>$/.test(target);result.push({kind:'link',text:link[1],target:angle?target.slice(1,-1):target});}
  prior=pattern.lastIndex;
 }
 if(prior<text.length)result.push({kind:'text',text:text.slice(prior)});return result;
}
test('bounded randomized inline input matches the previous supported grammar without its unmatched-text truncation',()=>{
 let seed=91423;const alphabet='[]()<>*` ab\n\r中文012';
 for(let sample=0;sample<3000;sample++){let text='';for(let i=0;i<48;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;text+=alphabet[seed%alphabet.length];}assert.deepEqual(markdownInline(text),reference(text),JSON.stringify(text));}
});
test('large malformed brackets, groups and delimiters finish without truncating original text',{timeout:2000},()=>{
 for(const value of ['['.repeat(512*1024),'[a](x('.repeat(70000),'*'.repeat(512*1024),'`'.repeat(512*1024)])assert.deepEqual(markdownInline(value),[{kind:'text',text:value}]);
});
const file=new URL('../src/markdown.jsx',import.meta.url),module={exports:{}};
const code=await transform(await readFile(file,'utf8'),{loader:'jsx',format:'cjs'});new Function('require','module','exports',code.code)(createRequire(file),module,module.exports);
test('real renderer keeps unfinished streaming content and never interprets inline HTML or unsafe targets',()=>{
 for(const text of ['`unfinished','**unfinished','*unfinished']){const html=renderToStaticMarkup(React.createElement(module.exports.Markdown,{text}));assert.ok(html.includes(text),html);assert.doesNotMatch(html,/<code>|<strong>|<em>/);}
 const html=renderToStaticMarkup(React.createElement(module.exports.Markdown,{text:'[bad](javascript:alert(1)) <img onerror=run()> [good](<docs/file name.md>)',projectPath:'/owned/project',onOpenFile(){}}));assert.doesNotMatch(html,/href="javascript:|<img/);assert.match(html,/&lt;img/);assert.match(html,/title="docs\/file name.md"/);
});
