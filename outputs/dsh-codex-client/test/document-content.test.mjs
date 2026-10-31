import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {transform} from 'esbuild';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {translator} from '../src/i18n.js';
const file=new URL('../src/components/DocumentContent.jsx',import.meta.url),require=createRequire(file),compiled=await transform(await readFile(file,'utf8'),{loader:'jsx',format:'cjs'});
function load(react=React){const module={exports:{}};new Function('require','module','exports',compiled.code)(id=>id==='react'?react:id.endsWith('.css')?{}:id==='../markdown.jsx'?{Markdown:props=>React.createElement('div',{'data-markdown':true},props.text)}:require(id),module,module.exports);return module.exports.DocumentContent;}
const DocumentContent=load({...React,useLayoutEffect(){}}),document={projectId:'A',path:'src/code.js',name:'code.js',content:'first\r\n中文😀z\r\nlast',version:'v'};
for(const locale of ['en','zh-CN'])test('actual source component renders translated read-only code and bounded line gutter in '+locale,()=>{
 const value=renderToStaticMarkup(React.createElement(DocumentContent,{file:{...document,content:'# literal\n<script>code</script>'},editing:false,t:translator(locale),locale}));
 assert.match(value,/<textarea[^>]+readonly/);assert.match(value,/&lt;script&gt;code&lt;\/script&gt;/);assert.doesNotMatch(value,/<h1|<script>|docEditorLabel|docReadOnly|docGoToLine/);assert.ok(value.includes(translator(locale)('docReadOnly')));
 const formatted=renderToStaticMarkup(React.createElement(DocumentContent,{file:{...document,path:'README.md'},editing:false,t:translator(locale),locale}));assert.match(formatted,/data-markdown="true"/);assert.doesNotMatch(formatted,/<textarea/);
});
function harness(){
 const slots=[],layouts=[];let cursor=0;const effects=[];
 const react={...React,useState(initial){const key=cursor++;if(!(key in slots))slots[key]=typeof initial==='function'?initial():initial;return[slots[key],next=>slots[key]=typeof next==='function'?next(slots[key]):next];},useRef(current){const key=cursor++;return slots[key]??=( {current} );},useMemo(factory){cursor++;return factory();},useLayoutEffect(effect,deps){const key=cursor++,previous=slots[key];if(!previous||deps.some((value,i)=>!Object.is(value,previous[i]))){slots[key]=deps;layouts.push(effect);}},useEffect(effect,deps){const key=cursor++,previous=slots[key];if(!previous||deps.some((value,i)=>!Object.is(value,previous[i]))){slots[key]=deps;effects.push(effect);}}};
 const Component=load(react),edits=[],element={selectionStart:0,selectionEnd:0,clientHeight:200,scrollTop:0,scrollLeft:0,focused:0,focus(){this.focused++;},setSelectionRange(start,end){this.selectionStart=start;this.selectionEnd=end;}},input={focus(){},select(){}};
 function all(tree){return !tree||typeof tree!=='object'?[]:[tree,...React.Children.toArray(tree.props?.children).flatMap(all)];}
 return {element,edits,render(props={}){cursor=0;const tree=Component({file:document,editing:true,t:translator('en'),locale:'en',onEdit:value=>edits.push(value),...props});let nodes=all(tree);for(const node of nodes)if(node.type==='textarea')node.ref.current=element;else if(node.type==='input'&&node.ref)node.ref.current=input;for(const effect of layouts.splice(0))effect();for(const effect of effects.splice(0))effect();return{tree,nodes,find:type=>nodes.find(node=>node.type===type)};}};
}
test('actual location effect selects the owned buffer and never applies a location from another file',()=>{
 const app=harness(),location={projectId:'A',path:document.path,line:2,column:3,request:1};app.render({location});assert.equal(app.element.selectionStart,8);assert.equal(app.element.focused,1);
 app.render({file:{...document,path:'other.js'},location});assert.equal(app.element.focused,1,'old path location must not select the new file');
 const invalid={...location,path:'other.js',line:999,request:2};app.render({file:{...document,path:'other.js'},location:invalid});assert.equal(app.element.focused,1);const rendered=app.render({file:{...document,path:'other.js'},location:invalid});assert.ok(rendered.nodes.some(node=>node.props?.role==='status'));assert.equal(app.edits.length,0);
});
test('actual source editor forwards a minimal change retaining original CRLF and no-op preview never edits',()=>{
 const app=harness(),view=app.render();view.find('textarea').props.onChange({target:{value:'first\n中文😀Z\nlast'}});assert.deepEqual(app.edits,['first\r\n中文😀Z\r\nlast']);
 const preview=app.render({editing:false});preview.find('textarea').props.onChange({target:{value:'must not write'}});assert.equal(app.edits.length,1);
});
test('local keyboard jump and submit select a real line and invalid input leaves content unchanged',()=>{
 const app=harness(),view=app.render();let prevented=0,stopped=0;view.find('textarea').props.onKeyDown({metaKey:true,ctrlKey:false,altKey:false,key:'g',preventDefault(){prevented++;},stopPropagation(){stopped++;}});assert.equal(prevented,1);assert.equal(stopped,1);
 let jump=app.render();assert.ok(jump.find('form'));jump.find('input').props.onChange({target:{value:'3'}});jump=app.render();jump.find('form').props.onSubmit({preventDefault(){}});assert.equal(document.content.replace(/\r\n/g,'\n').slice(app.element.selectionStart,app.element.selectionEnd),'last');assert.equal(app.edits.length,0);
});
test('a fresh edit does not reapply an already consumed citation or create an unbounded gutter',()=>{
 const app=harness(),location={projectId:'A',path:document.path,line:2,request:1};app.render({location});const focused=app.element.focused;
 app.render({file:{...document,content:'changed\nnew\nlast'},location});assert.equal(app.element.focused,focused);
 const large=app.render({file:{...document,content:'x\n'.repeat(100000)},location:null});assert.ok(large.nodes.length<280);
});
