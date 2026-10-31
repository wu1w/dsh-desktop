import test from 'node:test';
import assert from 'node:assert/strict';
import {applyEditorChange} from '../src/lib/document-location.js';
import {DocumentSession} from '../src/lib/document-session.js';

test('LF editing retains unchanged content, BOM and Unicode and only removes the BOM when the user does',()=>{
  const original='\ufefffirst\n中文😀 last\n';assert.equal(applyEditorChange(original,original),original);
  assert.equal(applyEditorChange(original,'\ufeffFIRST\n中文😀 last\n'),'\ufeffFIRST\n中文😀 last\n');
  assert.equal(applyEditorChange(original,'\ufefffirst\n中文😁 last\n'),'\ufefffirst\n中文😁 last\n');
  assert.equal(applyEditorChange(original,'first\n中文😀 last\n'),'first\n中文😀 last\n');
  assert.equal(applyEditorChange('','中😀\n'),'中😀\n');assert.equal(applyEditorChange('erase\nall',''),'');
});
test('LF buffers normalize pasted CRLF and isolated CR while retaining the exact complete current text',()=>{
  assert.equal(applyEditorChange('first\nlast','first\r\npasted\rlast'),'first\npasted\nlast');
  assert.equal(applyEditorChange('\ufefffirst\nlast','\ufefffirst\r\nlast'),'\ufefffirst\nlast');
});
test('CRLF, isolated CR and mixed line endings retain the existing minimal-change behavior',()=>{
  const mixed='\ufeffa\rb\nc\r\nd😀';assert.equal(applyEditorChange(mixed,'\ufeffa\nb\nc\nd😀'),mixed);
  assert.equal(applyEditorChange(mixed,'\ufeffa\nB\nc\nd😀'),'\ufeffa\rB\nc\r\nd😀');
  assert.equal(applyEditorChange(mixed,'\ufeffa\nb\nc\nd😁'),'\ufeffa\rb\nc\r\nd😁');
  assert.equal(applyEditorChange('a\rb\rc','a\nB\nc'),'a\rB\rc');
  assert.equal(applyEditorChange('a\r\nb\r\nc','a\nnew\nb\nc'),'a\r\nnew\r\nb\r\nc');
});
test('transient UTF16 input, including an unpaired surrogate, is retained until the later complete input arrives',()=>{
  for(const original of ['prefix\n\ud83d','prefix\n\ude00','prefix\n😀']){const next=original+'中';assert.equal(applyEditorChange(original,next),next);}
  let current='prefix\n';for(const value of ['prefix\n\ud83d','prefix\n😀','prefix\n😀中'])current=applyEditorChange(current,value);assert.equal(current,'prefix\n😀中');
});
test('large LF edits deliver every complete snapshot synchronously and preserve the final dirty save content',()=>{
  const original='\ufeff'+('const value = "中😀";\n').repeat(60000),session=new DocumentSession({file:{projectId:'A',path:'large.js',version:'disk',content:original}});
  const positions=[1,original.indexOf('\n',Math.floor(original.length/2))+1,original.length];
  for(let i=0;i<positions.length;i++){const current=session.snapshot().file.content,at=Math.min(current.length,positions[i]),next=current.slice(0,at)+'edit'+i+current.slice(at);session.edit(applyEditorChange(current,next));assert.equal(session.snapshot().file.content,next);assert.equal(session.snapshot().dirty,true);}
  const expected=session.snapshot().file.content,save=session.beginSave();assert.equal(save.status,'saving');assert.equal(save.token.file.content,expected);assert.equal(session.recoveryDraft().file.content,expected);assert.ok(expected.includes('edit0'));assert.ok(expected.includes('edit1'));assert.ok(expected.includes('edit2'));
  const other='other project\n';assert.equal(applyEditorChange(other,'other project\nnew'),'other project\nnew');assert.equal(session.snapshot().file.content,expected,'stateless helpers cannot carry a previous file buffer into another project');
});
