import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {transform} from 'esbuild';
import React from 'react';
import {GitController} from '../src/lib/git-controller.js';
import * as controllerModule from '../src/lib/git-controller.js';
import {translator} from '../src/i18n.js';
const file=new URL('../src/components/GitPanel.jsx',import.meta.url),require=createRequire(file),compiled=await transform(await readFile(file,'utf8'),{loader:'jsx',format:'cjs'}),module={exports:{}};
new Function('require','module','exports',compiled.code)(id=>id.endsWith('.css')?{}:id==='../api.js'?{api(){throw Error('ACTUAL_UI_MUST_USE_INJECTED_TRANSPORT');}}:id==='../lib/git-controller.js'?controllerModule:require(id),module,module.exports);
const t=translator('en'),gate=()=>{let resolve,reject;return{promise:new Promise((yes,no)=>{resolve=yes;reject=no;}),get resolve(){return resolve;},get reject(){return reject;}};};
const item=(path,staged=true)=>({path,staged,unstaged:!staged,index:staged?'M':'.',workingTree:staged?'.':'M'});
const status=(files=[item('same.txt')])=>({branch:'main',revision:'review-owned-revision',files,identity:{name:'Fixture Author',email:'fixture@example.invalid'},writeCapabilities:{stage:true,unstage:true,commit:true}});
function descendants(value){if(Array.isArray(value))return value.flatMap(descendants);return!value||typeof value!=='object'?[]:[value,...descendants(value.props?.children)];}
function text(value){if(Array.isArray(value))return value.map(text).join('');return!value||typeof value!=='object'?String(value??''):text(value.props?.children);}
function fixture({read,onChange}={}){
 const reads=[],writes=[];const controller=new GitController({draftCache:new Map(),onChange,request:async(route,options)=>{reads.push({route,signal:options.signal});return read?read(route,options,reads):route.endsWith('/status')?status():{diff:'+owned staged diff'};},mutateRequest:async(route,body)=>{writes.push({route,body});throw Error('NO_WRITE_AUTHORIZED_BY_BACK');}});controller.select('P');
 const render=()=>descendants(module.exports.GitPanelView({project:controller.projectId?{id:controller.projectId,name:controller.projectId}:null,snapshot:controller.snapshot(),controller,t,locale:'en',onCopy(){},onOpenFile(){}}));
 async function review(){await controller.refresh();controller.setDraft({message:'  Preserve this draft 中文😀\n'});const form=render().find(node=>node.type==='form');assert.ok(form);form.props.onSubmit({preventDefault(){}});await new Promise(resolve=>setImmediate(resolve));assert.ok(controller.snapshot().review);const back=render().find(node=>node.type==='button'&&text(node.props.children)===t('gitBackToEdit'));assert.ok(back);return back;}
 return{controller,reads,writes,render,review};
}
test('actual review Back button reloads the owned selected diff without writing or changing the commit draft',async()=>{
 const f=fixture(),back=await f.review(),draft=f.controller.snapshot().message;assert.equal(f.controller.snapshot().diff,null);await back.props.onClick();const state=f.controller.snapshot();assert.equal(state.review,null);assert.equal(state.selected.path,'same.txt');assert.equal(state.diff.diff,'+owned staged diff');assert.equal(state.message,draft);assert.equal(f.writes.length,0);assert.ok(f.render().some(node=>node.props?.className==='git-diff'));assert.equal(f.render().find(node=>node.props?.['aria-label']===t('gitCopyDiff')).props.disabled,false);f.controller.dispose();
});
test('a Back read failure stays explicitly retryable through the actual JSX Retry button and retains the draft',async()=>{
 let diffCount=0;const f=fixture({read:async route=>{if(route.endsWith('/status'))return status();if(++diffCount===2)throw Object.assign(Error('bounded diff failed'),{code:'GIT_OUTPUT_LIMIT'});return{diff:diffCount===1?'+initial':'+retried current diff'};}}),back=await f.review(),draft=f.controller.snapshot().message;await back.props.onClick();assert.equal(f.controller.snapshot().diffErrorCode,'GIT_OUTPUT_LIMIT');assert.equal(f.controller.snapshot().diffLoading,false);assert.equal(f.controller.snapshot().message,draft);const retry=f.render().find(node=>node.type==='button'&&text(node.props.children)===t('retry'));assert.ok(retry);await retry.props.onClick();assert.equal(f.controller.snapshot().diff.diff,'+retried current diff');assert.equal(f.controller.snapshot().diffError,null);assert.equal(f.writes.length,0);f.controller.dispose();
});
test('a late Back response from project P cannot replace an identical path selected in project Q',async()=>{
 const pending=gate();let pDiff=0;const f=fixture({read:async route=>{if(route.endsWith('/status'))return status();if(route.startsWith('projects/P/')&&++pDiff===2)return pending.promise;return{diff:route.startsWith('projects/Q/')?'+project Q current':'+project P initial'};}}),back=await f.review(),operation=back.props.onClick();assert.equal(f.controller.snapshot().diffLoading,true);f.controller.select('Q');await f.controller.refresh();pending.resolve({diff:'+late private P text'});await operation;assert.equal(f.controller.snapshot().projectId,'Q');assert.equal(f.controller.snapshot().selected.path,'same.txt');assert.equal(f.controller.snapshot().diff.diff,'+project Q current');assert.equal(f.reads.find(row=>row.route.includes('/P/git/diff')&&row!==f.reads[1])?.signal.aborted,true);assert.equal(f.writes.length,0);f.controller.dispose();
});
test('a later file selection wins over an earlier Back reload and typing is preserved while that read is pending',async()=>{
 const pending=gate();let aReads=0;const f=fixture({read:async route=>{if(route.endsWith('/status'))return status([item('a.txt'),item('b.txt')]);if(route.includes('path=a.txt')&&++aReads===2)return pending.promise;return{diff:route.includes('path=b.txt')?'+current b':'+initial a'};}}),back=await f.review(),operation=back.props.onClick();assert.equal(f.controller.snapshot().diffLoading,true);f.controller.setDraft({message:'New text entered while Back is pending'});const b=f.render().find(node=>node.type==='button'&&node.props.className==='git-file '&&node.props.title==='b.txt');assert.ok(b);await b.props.onClick();pending.resolve({diff:'+old a must not replace b'});await operation;assert.equal(f.controller.snapshot().selected.path,'b.txt');assert.equal(f.controller.snapshot().diff.diff,'+current b');assert.equal(f.controller.snapshot().message,'New text entered while Back is pending');assert.equal(f.writes.length,0);f.controller.dispose();
});
test('repeated clicks of the same Back handler start one read and do not cancel the first reload',async()=>{
 const pending=gate();let diffs=0;const f=fixture({read:async route=>route.endsWith('/status')?status():++diffs===2?pending.promise:{diff:'+initial'}}),back=await f.review(),first=back.props.onClick(),second=back.props.onClick();assert.equal(diffs,2);assert.equal(await second,false);assert.equal(f.controller.snapshot().diffLoading,true);pending.resolve({diff:'+only Back reload'});assert.equal(await first,true);assert.equal(f.controller.snapshot().diff.diff,'+only Back reload');assert.equal(f.writes.length,0);f.controller.dispose();
});
test('an obsolete Back handler after disposal starts no read and cannot restore a previous project',async()=>{
 const f=fixture(),back=await f.review(),count=f.reads.length;f.controller.dispose();assert.equal(await back.props.onClick(),false);assert.equal(f.reads.length,count);assert.equal(f.controller.snapshot().projectId,null);assert.equal(f.controller.snapshot().diff,null);assert.equal(f.writes.length,0);
});
