import test from 'node:test';
import assert from 'node:assert/strict';
import {indexDocument,resolveDocumentLocation,documentPosition,parseLineInput,visibleDocumentLines,applyDocumentLocation,applyEditorChange,isMarkdownDocument} from '../src/lib/document-location.js';
test('line/Unicode column references map to real textarea offsets and ranges',()=>{
 const index=indexDocument('first\r\n中文😀z\r\nlast\n');assert.equal(index.lineCount,4);assert.equal(index.text,'first\n中文😀z\nlast\n');
 assert.deepEqual(resolveDocumentLocation(index,{line:2,column:3}),{start:8,end:8,line:2,column:3,endLine:2});
 assert.equal(index.text.slice(...['start','end'].map(key=>resolveDocumentLocation(index,{line:2})[key])),'中文😀z');
 const range=resolveDocumentLocation(index,{line:2,column:3,endLine:3,endColumn:3});assert.equal(index.text.slice(range.start,range.end),'😀z\nla');
 assert.deepEqual(documentPosition(index,10),{line:2,column:4});assert.deepEqual(documentPosition(index,index.text.length),{line:4,column:1});
});
test('invalid, reversed and out-of-content references never silently clamp',()=>{
 const index=indexDocument('one\ntwo');for(const location of [null,{line:0},{line:-1},{line:NaN},{line:1,column:Infinity},{line:1,endColumn:1},{line:1,endLine:0}])assert.equal(resolveDocumentLocation(index,location).error,'docLocationInvalid');
 for(const location of [{line:3},{line:1,column:5},{line:1,endLine:3},{line:1,column:3,endLine:1,endColumn:2}])assert.equal(resolveDocumentLocation(index,location).error,'docLocationOutside');
 for(const value of ['0','1:0','-2','1:2:3','1.5','9007199254740992','a'])assert.equal(parseLineInput(value),null);
 assert.deepEqual(parseLineInput(' 12:3 '),{line:12,column:3});assert.deepEqual(parseLineInput('2'),{line:2});
});
test('positioning selects the actual range and scrolls the owned editor, while bad targets leave it untouched',()=>{
 const index=indexDocument(Array.from({length:100},(_,i)=>'line '+(i+1)).join('\n')),calls=[];
 const editor={clientHeight:200,scrollTop:0,scrollLeft:90,focus:value=>calls.push(value),setSelectionRange:(a,b)=>calls.push(index.text.slice(a,b))};
 const target=applyDocumentLocation(editor,index,{line:80});assert.equal(target.line,80);assert.equal(calls[1],'line 80');assert.ok(editor.scrollTop>1400);assert.equal(editor.scrollLeft,0);
 const before={...editor};assert.ok(applyDocumentLocation(editor,index,{line:1000}).error);assert.equal(editor.scrollTop,before.scrollTop);assert.equal(calls.length,2);
});
test('large-file line numbers stay within the visible window rather than creating one DOM row per line',()=>{
 const index=indexDocument('x\n'.repeat(200000));assert.equal(index.lineCount,200001);const range=visibleDocumentLines(index,1000000,800);assert.ok(range.last-range.first<50);assert.ok(range.first>49000);assert.ok(range.top<9);assert.equal(index.starts.BYTES_PER_ELEMENT,4);
 assert.ok(visibleDocumentLines(index,0,1000000).last<=256);
});
test('edits preserve untouched mixed line endings and BOM rather than rewriting a file through the textarea',()=>{
 const original='\ufeffalpha\r\nbeta\ngamma\rdelta\r\n';
 assert.equal(applyEditorChange(original,'\ufeffalpha\nbeta\ngamma\ndelta\n'),original);
 assert.equal(applyEditorChange(original,'\ufeffalpha\nBETA\ngamma\ndelta\n'),'\ufeffalpha\r\nBETA\ngamma\rdelta\r\n');
 assert.equal(applyEditorChange(original,'\ufeffalpha\nnew\nbeta\ngamma\ndelta\n'),'\ufeffalpha\r\nnew\r\nbeta\ngamma\rdelta\r\n');
 assert.equal(applyEditorChange('a\r\nb\r\nc','a\nc'),'a\r\nc');assert.equal(applyEditorChange('😀\r\n中','😁\n中'),'😁\r\n中');assert.equal(applyEditorChange('abc','a\nbc'),'a\nbc');
});
test('only Markdown extensions use formatted Markdown; source-like prose stays literal',()=>{
 for(const path of ['README.md','notes.MARKDOWN','a.mdown'])assert.equal(isMarkdownDocument({path}),true);
 for(const path of ['app.py','a.tsx','notes.txt','LICENSE','README.md.js'])assert.equal(isMarkdownDocument({path}),false);
});

test('a referenced column scrolls horizontally using measured source-font width',()=>{const index=indexDocument('中'.repeat(200));let prefix;const element={clientWidth:120,clientHeight:200,focus(){},setSelectionRange(){}};applyDocumentLocation(element,index,{line:1,column:101},{measurePrefix:text=>{prefix=text;return text.length*12;}});assert.equal(prefix.length,100);assert.equal(element.scrollLeft,1172);});
