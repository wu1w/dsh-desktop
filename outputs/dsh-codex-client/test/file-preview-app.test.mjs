import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {transform} from 'esbuild';
import React from 'react';
import {DocumentSession} from '../src/lib/document-session.js';
import {translator} from '../src/i18n.js';

// Execute the real App functions with persistent React hook slots. All I/O is
// intercepted at its API import; these tests never launch a system application.
const file=new URL('../src/main.jsx',import.meta.url),require=createRequire(file),marker='  function navigate(id, record = true) {';
const raw=await readFile(file,'utf8');assert.equal(raw.split(marker).length,2);
const code=await transform(raw.replace(marker,'  captureProbe({openFile,openProjectFileExternally,openDocumentExternally,saveDocument,browseFiles,closeFileBrowser,flushDrafts,flushDocumentRecovery,documentSession,documentDraftSync,syncDocument,cancelUnsaved,setUnsavedAction,setDocumentLocation,setDocumentEditing,setProjectId,setState,setFileList,setFileBrowsing,fileBrowsing,fileBrowseRequest,browseRevision,setError,setNotice,externalOpenLock,openingDocument,initialBoot});\n'+marker)+'\nexport {App};',{loader:'jsx',format:'cjs'});
const t=translator('en');
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const disk=(projectId='A',path='notes.md',content='current document')=>({projectId,path,name:path.split('/').at(-1),content,version:'disk-'+projectId+'-'+path});
const metadata=(path='image.png')=>({path,name:path.split('/').at(-1),size:67108864,modifiedAt:'2026-10-24T01:02:03.000Z'});
const failure=code=>Object.assign(new Error('fixture '+code),{code});
const contentRoute=(projectId,path)=>`projects/${encodeURIComponent(projectId)}/file?path=${encodeURIComponent(path)}`;
const infoRoute=(projectId,path)=>`projects/${encodeURIComponent(projectId)}/file-info?path=${encodeURIComponent(path)}`;
async function until(check){for(let count=0;count<100;count++){if(check())return;await new Promise(resolve=>setTimeout(resolve,1));}assert.fail('controlled API request did not start');}
function nodes(value){if(Array.isArray(value))return value.flatMap(nodes);if(!value||typeof value!=='object')return [];return [value,...nodes(value.props?.children)];}

function app({initialFile=disk(),dirty=false,read,readDraft,clearDraft,open=async()=>({accepted:true}),draft=null}={}){
  const session=new DocumentSession({file:initialFile,dirty}),calls=[],slots=[],storage=new Map([['dsh-locale','en']]);
  if(dirty&&initialFile)storage.set('dsh-document-draft',JSON.stringify({file:initialFile}));
  const state={projects:[{id:'A',path:'/projects/A',name:'A'},{id:'B',path:'/projects/B',name:'B'}],sessions:[],engine:{state:'ready',capabilities:{}},features:['feature-files']};
  let cursor=0,latest,tree;const jsxModules=new Map();
  const react={...React,useEffect(){},useLayoutEffect(){},useRef(current){const key=cursor++;return slots[key]??=({current});},useState(initialValue){const key=cursor++;if(!(key in slots)){let value=typeof initialValue==='function'?initialValue():initialValue;if(value instanceof DocumentSession)value=session;if(value&&Array.isArray(value.projects)&&Array.isArray(value.sessions)&&value.engine)value=state;const slot={value};slot.setter=next=>{slot.setter.calls.push(next);slot.value=typeof next==='function'?next(slot.value):next;};slot.setter.calls=[];slots[key]=slot;}return [slots[key].value,slots[key].setter];}};
  const dependency=id=>{
    if(id==='react')return react;
    if(id.endsWith('.css'))return {};
    if(id==='./api.js')return {api:async(route,body,method,options)=>{calls.push({route,body,method,options});if(route.endsWith('/open'))return open(route,body);if(route.startsWith('document-drafts?'))return readDraft?readDraft(route):{draft};if(route==='document-drafts/clear')return clearDraft?clearDraft(body):{};if(route==='document-drafts/save'||route==='preferences')return {};if(read)return read(route,body);throw Error('UNEXPECTED_API:'+route);}};
    if(id==='./lib/git-draft-sync.js')return {flushGitDrafts:async()=>{},subscribeGitDraftState:()=>()=>{}};
    if(id.endsWith('.jsx')){if(!jsxModules.has(id))jsxModules.set(id,new Proxy({},{get:(target,name)=>{if(name==='__esModule')return true;if(!target[name]){const component=function Stub(){return null;};component.componentName=name;component.importPath=id;target[name]=component;}return target[name];}}));return jsxModules.get(id);}
    return require(id);
  };
  const module={exports:{}};
  new Function('require','module','exports','localStorage','window','document','captureProbe',code.code)(dependency,module,module.exports,{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},{},{},value=>{latest=value;});
  function render(){cursor=0;tree=module.exports.App({registerCleanup(){}});latest.initialBoot.current=true;return tree;}
  render();
  return {get probe(){return latest;},session,calls,storage,render,get tree(){return tree;},nodes(){return nodes(tree);},componentNode(name){return nodes(tree).find(node=>node.type?.componentName===name);},dispose(){latest.documentDraftSync.dispose();}};
}
const routes=fixture=>fixture.calls.map(call=>call.route);
const mutatingCalls=fixture=>fixture.calls.filter(call=>call.body!==undefined);

for(const reason of ['BINARY_FILE','FILE_ENCODING','FILE_LIMIT'])test(`actual ${reason} file read uses metadata-only fallback and preserves an older text recovery`,async()=>{
  const path='assets/中文 image.bin',info=metadata(path),oldDraft={...disk('B',path,'old unsaved recovery'),version:'prior-disk-version'};
  const fixture=app({draft:oldDraft,read:async route=>{if(route===contentRoute('B',path))throw failure(reason);if(route===infoRoute('B',path))return info;throw Error('UNEXPECTED_API:'+route);}});
  try{
    assert.equal(await fixture.probe.openFile(path,'B',{line:2,column:3}),true);
    assert.deepEqual(fixture.session.snapshot(),{file:{...info,projectId:'B',content:'',version:null,preview:{kind:'external',reason}},dirty:false,saving:false});
    const sequence=routes(fixture);assert.ok(sequence.indexOf(contentRoute('B',path))<sequence.indexOf(infoRoute('B',path)));
    assert.equal(sequence.filter(route=>route===infoRoute('B',path)).length,1);
    assert.deepEqual(mutatingCalls(fixture),[],'fallback must neither save nor clear a text recovery');
    assert.equal(fixture.probe.setDocumentLocation.calls.at(-1),null);
    assert.equal(fixture.probe.setDocumentEditing.calls.at(-1),false);
    assert.ok(fixture.probe.setNotice.calls.includes(t('filePreviewRecoveryPreserved')));
    let beganSave=false;const original=fixture.session.beginSave;fixture.session.beginSave=()=>{beganSave=true;return original.call(fixture.session);};
    const count=fixture.calls.length;assert.equal(await fixture.probe.saveDocument(),false);assert.equal(beganSave,false);assert.equal(fixture.calls.length,count);
    assert.ok(fixture.probe.setError.calls.includes(t('filePreviewNotEditable')));
  }finally{fixture.dispose();}
});

test('an empty previous text recovery is also preserved rather than cleared as a stale fallback',async()=>{
  const path='empty-recovery.pdf',fixture=app({draft:disk('B',path,''),read:async route=>{if(route===contentRoute('B',path))throw failure('BINARY_FILE');if(route===infoRoute('B',path))return metadata(path);throw Error('UNEXPECTED_API:'+route);}});
  try{assert.equal(await fixture.probe.openFile(path,'B'),true);assert.equal(fixture.session.snapshot().dirty,false);assert.deepEqual(mutatingCalls(fixture),[]);assert.ok(!routes(fixture).includes('document-drafts/clear'));}finally{fixture.dispose();}
});

test('ordinary text still loads its recovery without a metadata request',async()=>{
  const file=disk('B','text.md','saved text'),draft={...file,content:'unsaved text',version:'older-version'},fixture=app({draft,read:async route=>{assert.equal(route,contentRoute('B','text.md'));return file;}});
  try{assert.equal(await fixture.probe.openFile('text.md','B'),true);assert.deepEqual(fixture.session.snapshot().file,{...file,content:draft.content,version:draft.version});assert.equal(fixture.session.snapshot().dirty,true);assert.ok(!routes(fixture).some(route=>route.includes('/file-info?')));assert.equal(fixture.probe.setDocumentEditing.calls.at(-1),true);}finally{fixture.dispose();}
});

test('other file failures preserve the current document and never request fallback metadata',async()=>{
  for(const reason of ['ENOENT','OUTSIDE_PROJECT','FILE_CHANGED','FORBIDDEN']){
    const initial=disk(),fixture=app({initialFile:initial,read:async()=>{throw failure(reason);}});
    try{assert.notEqual(await fixture.probe.openFile('missing.txt','B',{line:2}),true);assert.deepEqual(fixture.session.snapshot().file,initial);assert.equal(fixture.session.snapshot().dirty,false);assert.ok(!routes(fixture).some(route=>route.includes('/file-info?')),reason);assert.deepEqual(fixture.probe.setDocumentLocation.calls,[]);assert.deepEqual(mutatingCalls(fixture),[]);}finally{fixture.dispose();}
  }
});

test('failed or invalid fallback metadata cannot replace the current document',async()=>{
  for(const answer of [failure('FILE_CHANGED'),{...metadata('other.pdf'),path:'different.pdf'},{...metadata('other.pdf'),size:-1},{...metadata('other.pdf'),modifiedAt:'not a date'}]){
    const initial=disk(),fixture=app({initialFile:initial,read:async route=>{if(route===contentRoute('B','other.pdf'))throw failure('BINARY_FILE');if(route===infoRoute('B','other.pdf')){if(answer instanceof Error)throw answer;return answer;}throw Error('UNEXPECTED_API:'+route);}});
    try{assert.notEqual(await fixture.probe.openFile('other.pdf','B'),true);assert.deepEqual(fixture.session.snapshot().file,initial);assert.deepEqual(fixture.probe.setDocumentLocation.calls,[]);assert.deepEqual(mutatingCalls(fixture),[]);}finally{fixture.dispose();}
  }
});

test('late fallback metadata cannot replace a newer document or attach its old location',async()=>{
  const old=deferred(),newFile=disk('B','new.md','newer text'),fixture=app({read:async route=>{if(route===contentRoute('A','old.bin'))throw failure('FILE_ENCODING');if(route===infoRoute('A','old.bin'))return old.promise;if(route===contentRoute('B','new.md'))return newFile;throw Error('UNEXPECTED_API:'+route);}});
  try{const opening=fixture.probe.openFile('old.bin','A',{line:9});await until(()=>routes(fixture).includes(infoRoute('A','old.bin')));assert.equal(await fixture.probe.openFile('new.md','B',{line:1}),true);const location=fixture.probe.setDocumentLocation.calls.at(-1);old.resolve(metadata('old.bin'));assert.equal(await opening,false);assert.deepEqual(fixture.session.snapshot().file,newFile);assert.equal(fixture.probe.setDocumentLocation.calls.at(-1),location);assert.equal(location.path,'new.md');assert.deepEqual(mutatingCalls(fixture),[]);}finally{old.resolve(metadata('old.bin'));fixture.dispose();}
});

test('typing while fallback metadata loads keeps the newer dirty buffer and invalidates the old open',async()=>{
  const pending=deferred(),fixture=app({read:async route=>{if(route===contentRoute('B','large.pdf'))throw failure('FILE_LIMIT');if(route===infoRoute('B','large.pdf'))return pending.promise;throw Error('UNEXPECTED_API:'+route);}});
  try{const opening=fixture.probe.openFile('large.pdf','B');await until(()=>routes(fixture).includes(infoRoute('B','large.pdf')));fixture.session.edit('typed while metadata was pending');fixture.probe.syncDocument();pending.resolve(metadata('large.pdf'));assert.equal(await opening,false);assert.equal(fixture.session.snapshot().file.path,'notes.md');assert.equal(fixture.session.snapshot().file.content,'typed while metadata was pending');assert.equal(fixture.session.snapshot().dirty,true);assert.deepEqual(fixture.probe.setDocumentLocation.calls,[]);assert.deepEqual(mutatingCalls(fixture),[]);}finally{pending.resolve(metadata('large.pdf'));fixture.dispose();}
});

test('cancelling a dirty different-file confirmation sends neither a content nor metadata GET',async()=>{
  const initial=disk('A','current.md','keep unsaved input'),fixture=app({initialFile:initial,dirty:true,read:async()=>{throw Error('MUST_NOT_READ');}});
  try{const opening=fixture.probe.openFile('image.png','B');assert.equal(fixture.probe.setUnsavedAction.calls.length,1);assert.deepEqual(fixture.calls,[]);fixture.probe.cancelUnsaved();assert.equal(await opening,false);assert.deepEqual(fixture.session.snapshot().file,initial);assert.equal(fixture.session.snapshot().dirty,true);assert.deepEqual(fixture.calls,[]);}finally{fixture.dispose();}
});

test('a different-project external target bypasses dirty discard and uses one captured global launch token',async()=>{
  const pending=deferred(),initial=disk('A','current.md','keep this unsaved input'),target={...metadata('folder/图像.png'),projectId:'B'},fixture=app({initialFile:initial,dirty:true,open:()=>pending.promise});
  try{
    const opening=fixture.probe.openProjectFileExternally(target);
    assert.deepEqual(fixture.probe.externalOpenLock.current,{projectId:'B',path:'folder/图像.png',name:'图像.png'});
    assert.equal(fixture.probe.setUnsavedAction.calls.length,0);assert.deepEqual(fixture.session.snapshot().file,initial);assert.equal(fixture.session.snapshot().dirty,true);
    assert.equal(await fixture.probe.openProjectFileExternally({...target,path:'second.png'}),false);
    assert.equal(await fixture.probe.openDocumentExternally(),false);
    target.path='mutated-after-launch.png';target.name='mutated name';fixture.probe.setProjectId('A');fixture.render();
    pending.resolve({accepted:true});assert.equal(await opening,true);
    assert.deepEqual(fixture.calls.map(({route,body})=>({route,body})),[{route:'projects/B/open',body:{path:'folder/图像.png'}}]);
    assert.deepEqual(fixture.session.snapshot().file,initial);assert.equal(fixture.session.snapshot().dirty,true);assert.equal(fixture.probe.externalOpenLock.current,null);
    assert.ok(fixture.probe.setNotice.calls.includes(t('docOpenAccepted',{name:'图像.png'})));
    assert.ok(fixture.storage.get('dsh-document-draft').includes('keep this unsaved input'));
  }finally{pending.resolve({accepted:true});fixture.dispose();}
});

test('a captured external target in the same dirty document still requires confirmation and cancellation releases the lock',async()=>{
  const initial=disk('A','same.md','keep dirty'),fixture=app({initialFile:initial,dirty:true});
  try{const opening=fixture.probe.openProjectFileExternally({...metadata('same.md'),projectId:'A'});assert.equal(fixture.probe.setUnsavedAction.calls.length,1);assert.deepEqual(fixture.calls,[]);fixture.probe.cancelUnsaved();assert.equal(await opening,false);assert.equal(fixture.probe.externalOpenLock.current,null);assert.deepEqual(fixture.session.snapshot().file,initial);assert.equal(fixture.session.snapshot().dirty,true);assert.deepEqual(fixture.calls,[]);}finally{fixture.dispose();}
});

test('rejected external preview launches preserve the dirty editor and release the global token for retry',async()=>{
  let accepted=false;const initial=disk('A','current.md','keep dirty'),target={...metadata('external.bin'),projectId:'B'},fixture=app({initialFile:initial,dirty:true,open:async()=>accepted?{accepted:true}:{accepted:false}});
  try{assert.equal(await fixture.probe.openProjectFileExternally(target),false);assert.ok(fixture.probe.setError.calls.includes(t('docOpenUnconfirmed')));assert.equal(fixture.probe.externalOpenLock.current,null);assert.deepEqual(fixture.session.snapshot().file,initial);assert.equal(fixture.session.snapshot().dirty,true);accepted=true;assert.equal(await fixture.probe.openProjectFileExternally(target),true);assert.equal(fixture.calls.length,2);assert.equal(fixture.probe.setUnsavedAction.calls.length,0);}finally{fixture.dispose();}
});

test('the actual fallback panel has no text editor or source/save controls and retries into a real text document',async()=>{
  let textReady=false;const path='retry.pdf',info=metadata(path),text=disk('B',path,'now valid UTF-8 text'),fixture=app({read:async route=>{if(route===contentRoute('B',path)){if(textReady)return text;throw failure('BINARY_FILE');}if(route===infoRoute('B',path))return info;throw Error('UNEXPECTED_API:'+route);}});
  try{
    assert.equal(await fixture.probe.openFile(path,'B'),true);fixture.render();
    const fallback=fixture.componentNode('FilePreviewFallback');assert.ok(fallback,'the actual App must render the dedicated fallback component');
    assert.equal(fallback.props.file.preview.kind,'external');assert.equal(fixture.componentNode('DocumentContent'),undefined);
    assert.ok(!fixture.nodes().some(node=>node.type==='button'&&node.props['aria-pressed']!==undefined),'text source toggle must not be offered');
    assert.ok(!fixture.nodes().some(node=>node.type==='button'&&node.props.onClick===fixture.probe.saveDocument),'fallback must not offer Save');
    assert.equal(fixture.calls.some(call=>call.route.endsWith('/open')),false,'reading a fallback must never launch another app automatically');
    textReady=true;assert.equal(await fallback.props.onRetry(),true);fixture.render();
    assert.equal(fixture.componentNode('FilePreviewFallback'),undefined);assert.ok(fixture.componentNode('DocumentContent'));assert.deepEqual(fixture.session.snapshot().file,text);
    assert.ok(fixture.nodes().some(node=>node.type==='button'&&node.props['aria-pressed']!==undefined),'a successful text retry restores the normal source toggle');
    assert.deepEqual(mutatingCalls(fixture),[]);
  }finally{fixture.dispose();}
});

test('the actual file-browser external action keeps another project’s dirty editor and binds busy state to its captured target',async()=>{
  const pending=deferred(),initial=disk('A','current.md','keep editor text'),entry={path:'assets/picture.png',name:'Picture from project B',size:123,directory:false},fixture=app({initialFile:initial,dirty:true,read:async route=>{assert.equal(route,'projects/B/files?path=');return {entries:[entry]};},open:()=>pending.promise});
  try{
    fixture.probe.setProjectId('B');fixture.render();assert.equal(await fixture.probe.browseFiles(),true);fixture.render();
    const browser=fixture.componentNode('FileBrowser');assert.ok(browser);assert.equal(browser.props.project.id,'B');assert.equal(browser.props.externalBusy,false);
    const opening=browser.props.onOpenExternal(entry.path);assert.deepEqual(fixture.probe.externalOpenLock.current,{projectId:'B',path:entry.path,name:entry.name});
    assert.equal(fixture.probe.setUnsavedAction.calls.length,0);fixture.render();const busyBrowser=fixture.componentNode('FileBrowser');assert.equal(busyBrowser.props.externalBusy,true);assert.equal(busyBrowser.props.openingPath,entry.path);
    assert.equal(await busyBrowser.props.onOpenExternal(entry.path),false);assert.equal(await fixture.probe.openDocumentExternally(),false);
    fixture.probe.setProjectId('A');fixture.render();pending.resolve({accepted:true});assert.equal(await opening,true);
    assert.deepEqual(fixture.calls.filter(call=>call.route.endsWith('/open')).map(({route,body})=>({route,body})),[{route:'projects/B/open',body:{path:entry.path}}]);
    assert.deepEqual(fixture.session.snapshot().file,initial);assert.equal(fixture.session.snapshot().dirty,true);assert.equal(fixture.probe.externalOpenLock.current,null);
    assert.ok(fixture.probe.setNotice.calls.includes(t('docOpenAccepted',{name:entry.name})));
  }finally{pending.resolve({accepted:true});fixture.dispose();}
});

test('actual directory browsing immediately clears old rows and shows loading bound to the captured project and path',async()=>{
  const pending=deferred(),entries=[{path:'folder/child.txt',name:'child.txt',size:5,directory:false}],fixture=app({read:async route=>{assert.equal(route,'projects/B/files?path=folder');return pending.promise;}});
  try{
    fixture.probe.setProjectId('B');fixture.probe.setFileList([{path:'old.txt',name:'old.txt'}]);fixture.render();
    const browsing=fixture.probe.browseFiles('folder',true),controller=fixture.probe.fileBrowseRequest.current;
    assert.ok(controller instanceof AbortController);assert.equal(fixture.calls.at(-1).options.signal,controller.signal);assert.equal(fixture.calls.at(-1).method,'GET');
    fixture.render();const loading=fixture.componentNode('FileBrowser');assert.ok(loading);assert.equal(loading.props.project.id,'B');assert.equal(loading.props.directory,'folder');assert.equal(loading.props.picking,true);assert.equal(loading.props.loading,true);assert.deepEqual(loading.props.entries,[]);assert.deepEqual(fixture.probe.fileBrowsing,{projectId:'B',loading:true,failure:null});
    pending.resolve({entries});assert.equal(await browsing,true);fixture.render();assert.equal(fixture.componentNode('FileBrowser').props.loading,false);assert.deepEqual(fixture.componentNode('FileBrowser').props.entries,entries);assert.equal(fixture.probe.fileBrowseRequest.current,null);
  }finally{pending.resolve({entries});fixture.dispose();}
});

test('closing the actual browser aborts its request and ignores both late success and late failure',async()=>{
  for(const outcome of ['success','failure']){
    const pending=deferred(),fixture=app({read:async()=>pending.promise});
    try{
      fixture.probe.setProjectId('A');fixture.render();const browsing=fixture.probe.browseFiles('pending'),controller=fixture.probe.fileBrowseRequest.current,revision=fixture.probe.browseRevision.current;
      fixture.render();const browser=fixture.componentNode('FileBrowser');assert.ok(browser);browser.props.onClose();
      assert.equal(controller.signal.aborted,true);assert.equal(fixture.probe.fileBrowseRequest.current,null);assert.ok(fixture.probe.browseRevision.current>revision);fixture.render();assert.equal(fixture.componentNode('FileBrowser'),undefined);
      const rowsBefore=fixture.probe.setFileList.calls.length,browsingBefore=fixture.probe.setFileBrowsing.calls.length,errorsBefore=fixture.probe.setError.calls.length;
      if(outcome==='success')pending.resolve({entries:[{path:'late.txt',name:'late.txt'}]});else pending.reject(failure('LATE_DIRECTORY_FAILURE'));
      assert.equal(await browsing,false);fixture.render();assert.equal(fixture.componentNode('FileBrowser'),undefined);assert.equal(fixture.probe.setFileList.calls.length,rowsBefore);assert.equal(fixture.probe.setFileBrowsing.calls.length,browsingBefore);assert.equal(fixture.probe.setError.calls.length,errorsBefore);assert.equal(fixture.probe.fileBrowsing.loading,false);
    }finally{pending.resolve({entries:[]});fixture.dispose();}
  }
});

test('switching projects hides the old actual browser in the first render before effects run',async()=>{
  const entriesA=[{path:'only-A.txt',name:'only A',size:1,directory:false}],entriesB=[{path:'only-B.txt',name:'only B',size:2,directory:false}],pendingB=deferred(),fixture=app({read:async route=>{if(route==='projects/A/files?path=')return {entries:entriesA};if(route==='projects/B/files?path=')return pendingB.promise;throw Error('UNEXPECTED_API:'+route);}});
  try{
    fixture.probe.setProjectId('A');fixture.render();assert.equal(await fixture.probe.browseFiles(),true);fixture.render();assert.deepEqual(fixture.componentNode('FileBrowser').props.entries,entriesA);
    // The harness deliberately does not run useEffect. The render-time project
    // identity guard must hide A before the reset effect can clear its state.
    fixture.probe.setProjectId('B');fixture.render();assert.equal(fixture.componentNode('FileBrowser'),undefined);assert.equal(fixture.probe.fileBrowsing.projectId,'A');
    const browsing=fixture.probe.browseFiles();fixture.render();const loadingB=fixture.componentNode('FileBrowser');assert.equal(loadingB.props.project.id,'B');assert.deepEqual(loadingB.props.entries,[]);assert.equal(loadingB.props.loading,true);
    pendingB.resolve({entries:entriesB});assert.equal(await browsing,true);fixture.render();assert.deepEqual(fixture.componentNode('FileBrowser').props.entries,entriesB);
  }finally{pendingB.resolve({entries:entriesB});fixture.dispose();}
});

test('same-project directory results arriving backwards keep only the newest actual listing',async()=>{
  const old=deferred(),latest=deferred(),entries=[{path:'new/newest.txt',name:'newest.txt'}],fixture=app({read:async route=>route==='projects/A/files?path=old'?old.promise:route==='projects/A/files?path=new'?latest.promise:Promise.reject(Error('UNEXPECTED_API:'+route))});
  try{
    fixture.probe.setProjectId('A');fixture.render();const oldRead=fixture.probe.browseFiles('old'),oldController=fixture.probe.fileBrowseRequest.current;
    const newRead=fixture.probe.browseFiles('new'),newController=fixture.probe.fileBrowseRequest.current;assert.equal(oldController.signal.aborted,true);assert.notEqual(newController,oldController);
    latest.resolve({entries});assert.equal(await newRead,true);fixture.render();assert.equal(fixture.componentNode('FileBrowser').props.directory,'new');assert.deepEqual(fixture.componentNode('FileBrowser').props.entries,entries);
    const rowsBefore=fixture.probe.setFileList.calls.length,browsingBefore=fixture.probe.setFileBrowsing.calls.length;
    old.resolve({entries:[{path:'old/stale.txt',name:'stale.txt'}]});assert.equal(await oldRead,false);fixture.render();assert.equal(fixture.componentNode('FileBrowser').props.directory,'new');assert.deepEqual(fixture.componentNode('FileBrowser').props.entries,entries);assert.equal(fixture.probe.setFileList.calls.length,rowsBefore);assert.equal(fixture.probe.setFileBrowsing.calls.length,browsingBefore);assert.equal(fixture.probe.fileBrowseRequest.current,null);
  }finally{old.resolve({entries:[]});latest.resolve({entries});fixture.dispose();}
});

test('an older request finishing first cannot clear the newer browser controller or write old rows',async()=>{
  const old=deferred(),latest=deferred(),fixture=app({read:async route=>route.endsWith('path=old')?old.promise:latest.promise});
  try{
    fixture.probe.setProjectId('A');fixture.render();const oldRead=fixture.probe.browseFiles('old'),newRead=fixture.probe.browseFiles('new'),controller=fixture.probe.fileBrowseRequest.current;
    old.resolve({entries:[{path:'old.txt',name:'old.txt'}]});assert.equal(await oldRead,false);assert.equal(fixture.probe.fileBrowseRequest.current,controller);fixture.render();assert.equal(fixture.componentNode('FileBrowser').props.loading,true);assert.deepEqual(fixture.componentNode('FileBrowser').props.entries,[]);
    latest.resolve({entries:[{path:'new.txt',name:'new.txt'}]});assert.equal(await newRead,true);fixture.render();assert.equal(fixture.componentNode('FileBrowser').props.loading,false);assert.equal(fixture.componentNode('FileBrowser').props.entries[0].path,'new.txt');
  }finally{old.resolve({entries:[]});latest.resolve({entries:[]});fixture.dispose();}
});

test('late directory failures cannot replace the current browser error or an unrelated global error',async()=>{
  const old=deferred(),latest=deferred(),currentFailure=failure('CURRENT_DIRECTORY_FAILURE'),fixture=app({read:async route=>route.endsWith('path=old')?old.promise:latest.promise});
  try{
    fixture.probe.setProjectId('A');fixture.probe.setError('keep unrelated editor error');fixture.render();const oldRead=fixture.probe.browseFiles('old'),newRead=fixture.probe.browseFiles('new');
    latest.reject(currentFailure);assert.equal(await newRead,false);fixture.render();assert.equal(fixture.probe.fileBrowsing.failure,currentFailure);assert.equal(fixture.componentNode('FileBrowser').props.error,currentFailure.message);
    const browsingBefore=fixture.probe.setFileBrowsing.calls.length,errorsBefore=fixture.probe.setError.calls.length;
    old.reject(failure('OLD_DIRECTORY_FAILURE'));assert.equal(await oldRead,false);fixture.render();assert.equal(fixture.probe.setFileBrowsing.calls.length,browsingBefore);assert.equal(fixture.probe.setError.calls.length,errorsBefore);assert.equal(fixture.probe.setError.calls.at(-1),'keep unrelated editor error');assert.equal(fixture.probe.fileBrowsing.failure,currentFailure);assert.equal(fixture.componentNode('FileBrowser').props.error,currentFailure.message);
  }finally{old.resolve({entries:[]});latest.resolve({entries:[]});fixture.dispose();}
});

test('disabling files hides an already loaded browser before effects and rejects writes from a later response',async()=>{
  const pending=deferred(),entries=[{path:'visible-before-disable.txt',name:'old entry'}],fixture=app({read:async route=>route.endsWith('path=pending')?pending.promise:{entries}});
  try{
    fixture.probe.setProjectId('A');fixture.render();assert.equal(await fixture.probe.browseFiles(),true);fixture.render();assert.deepEqual(fixture.componentNode('FileBrowser').props.entries,entries);
    fixture.probe.setState(current=>({...current,features:[]}));fixture.render();assert.equal(fixture.componentNode('FileBrowser'),undefined);assert.equal(fixture.probe.fileBrowsing.projectId,'A');const callsBefore=fixture.calls.length;assert.notEqual(await fixture.probe.browseFiles(),true);assert.equal(fixture.calls.length,callsBefore);
    fixture.probe.setState(current=>({...current,features:['feature-files']}));fixture.render();const browsing=fixture.probe.browseFiles('pending');fixture.render();assert.equal(fixture.componentNode('FileBrowser').props.loading,true);
    fixture.probe.setState(current=>({...current,features:[]}));fixture.render();assert.equal(fixture.componentNode('FileBrowser'),undefined);const rowsBefore=fixture.probe.setFileList.calls.length,browsingBefore=fixture.probe.setFileBrowsing.calls.length;
    pending.resolve({entries:[{path:'late-after-disable.txt',name:'must not publish'}]});assert.equal(await browsing,false);fixture.render();assert.equal(fixture.componentNode('FileBrowser'),undefined);assert.equal(fixture.probe.setFileList.calls.length,rowsBefore);assert.equal(fixture.probe.setFileBrowsing.calls.length,browsingBefore);
  }finally{pending.resolve({entries:[]});fixture.dispose();}
});

test('normal real-App recovery and preference flushes preserve the text backup of an external preview',async()=>{
  const path='backup-now-binary.dat',draft={...disk('B',path,'unsaved text before the file became binary'),version:'previous-text-version'},original=structuredClone(draft),fixture=app({draft,read:async route=>{if(route===contentRoute('B',path))throw failure('BINARY_FILE');if(route===infoRoute('B',path))return metadata(path);throw Error('UNEXPECTED_API:'+route);}});
  try{
    fixture.probe.setProjectId('B');fixture.render();assert.equal(await fixture.probe.openFile(path,'B'),true);fixture.render();const file=fixture.session.snapshot().file;
    const before=fixture.calls.length;await fixture.probe.flushDocumentRecovery({file,draft:null});assert.equal(fixture.calls.length,before,'a clean fallback must not clear its saved text recovery');
    // Run both production flush functions: the optional cache and preference
    // persistence still work while the independent text recovery stays intact.
    await fixture.probe.flushDrafts();await fixture.probe.flushDrafts();
    assert.equal(fixture.calls.filter(call=>call.route==='document-drafts/clear').length,0);assert.equal(fixture.calls.filter(call=>call.route==='document-drafts/save').length,0);assert.equal(fixture.calls.filter(call=>call.route==='preferences').length,2);
    for(const call of fixture.calls.filter(call=>call.route==='preferences')){assert.equal(call.body.projectId,'B');assert.equal(call.body.locale,'en');assert.deepEqual(call.body.drafts,{});}
    assert.deepEqual(draft,original);assert.equal(fixture.session.snapshot().file.preview.kind,'external');assert.equal(fixture.session.snapshot().dirty,false);assert.equal(fixture.probe.documentDraftSync.entries.size,0);
  }finally{fixture.dispose();}
});

test('ordinary clean-text recovery flush still clears its stale backup and persists preferences',async()=>{
  const initial=disk('A','normal.md','saved text'),fixture=app({initialFile:initial});
  try{await fixture.probe.flushDrafts();assert.deepEqual(fixture.calls.filter(call=>call.route==='document-drafts/clear').map(call=>call.body),[{projectId:'A',path:'normal.md'}]);assert.equal(fixture.calls.filter(call=>call.route==='preferences').length,1);assert.deepEqual(fixture.session.snapshot().file,initial);}finally{fixture.dispose();}
});

test('disabling files before a pending text or fallback response prevents committing that document',async()=>{
  for(const kind of ['text','metadata']){
    const pending=deferred(),initial=disk('A','current.md','preserve original document'),path='pending-'+kind+'.dat',fixture=app({initialFile:initial,read:async route=>{if(route===contentRoute('B',path)){if(kind==='text')return pending.promise;throw failure('FILE_ENCODING');}if(route===infoRoute('B',path))return pending.promise;throw Error('UNEXPECTED_API:'+route);}});
    try{
      const opening=fixture.probe.openFile(path,'B',{line:2});await until(()=>routes(fixture).includes(kind==='text'?contentRoute('B',path):infoRoute('B',path)));
      fixture.probe.setState(current=>({...current,features:[]}));fixture.render();const locationCount=fixture.probe.setDocumentLocation.calls.length;
      pending.resolve(kind==='text'?disk('B',path,'too late text'):metadata(path));assert.equal(await opening,false);assert.deepEqual(fixture.session.snapshot().file,initial);assert.equal(fixture.session.snapshot().dirty,false);assert.equal(fixture.probe.setDocumentLocation.calls.length,locationCount);assert.deepEqual(mutatingCalls(fixture),[]);
    }finally{pending.resolve(kind==='text'?disk('B',path):metadata(path));fixture.dispose();}
  }
});

for(const stage of ['text','metadata','recovery'])test(`an obsolete ${stage} failure cannot publish an error after the user has opened a newer document`,async()=>{
  const pending=deferred(),oldPath='old-'+stage+'.dat',newFile=disk('B','new.md','the current document belongs to B'),error=failure('OBSOLETE_'+stage.toUpperCase()+'_FAILED');
  const fixture=app({
    read:async route=>{
      if(route===contentRoute('B','new.md'))return newFile;
      if(route===contentRoute('A',oldPath)){if(stage==='text')return pending.promise;if(stage==='metadata')throw failure('FILE_LIMIT');return disk('A',oldPath,'old text');}
      if(route===infoRoute('A',oldPath))return pending.promise;
      throw Error('UNEXPECTED_API:'+route);
    },
    readDraft:async route=>stage==='recovery'&&route===`document-drafts?projectId=A&path=${encodeURIComponent(oldPath)}`?pending.promise:{draft:null},
  });
  try{
    const opening=fixture.probe.openFile(oldPath,'A');
    const delayedRoute=stage==='metadata'?infoRoute('A',oldPath):stage==='recovery'?`document-drafts?projectId=A&path=${encodeURIComponent(oldPath)}`:contentRoute('A',oldPath);
    await until(()=>routes(fixture).includes(delayedRoute));
    assert.equal(await fixture.probe.openFile('new.md','B'),true);fixture.render();assert.deepEqual(fixture.session.snapshot().file,newFile);
    fixture.probe.setError('current B error must remain');const errorsBefore=fixture.probe.setError.calls.length;
    pending.reject(error);assert.notEqual(await opening,true);assert.deepEqual(fixture.session.snapshot().file,newFile);
    assert.deepEqual(fixture.probe.setError.calls.slice(errorsBefore),[],`obsolete ${stage} failure must not overwrite B with ${error.message}`);
  }finally{pending.resolve(stage==='recovery'?{draft:null}:stage==='metadata'?metadata(oldPath):disk('A',oldPath));fixture.dispose();}
});

for(const stage of ['text','metadata','recovery'])test(`a current ${stage} request failure remains visible after stale-error suppression`,async()=>{
  const path='current-'+stage+'.dat',expected=disk('B',path,'current text'),error=failure('CURRENT_'+stage.toUpperCase()+'_FAILED'),initial=disk();
  const fixture=app({initialFile:initial,read:async route=>{if(route===contentRoute('B',path)){if(stage==='text')throw error;if(stage==='metadata')throw failure('FILE_LIMIT');return expected;}if(route===infoRoute('B',path))throw error;throw Error('UNEXPECTED_API:'+route);},readDraft:async()=>{if(stage==='recovery')throw error;return {draft:null};}});
  try{
    const result=await fixture.probe.openFile(path,'B');assert.equal(result,stage==='recovery');assert.ok(fixture.probe.setError.calls.includes(error.message));assert.deepEqual(fixture.session.snapshot().file,stage==='recovery'?expected:initial);
  }finally{fixture.dispose();}
});

test('an obsolete stale-recovery clear failure cannot overwrite the error of a newer document',async()=>{
  const pending=deferred(),oldFile=disk('A','old.md','already saved A text'),newFile=disk('B','new.md','current B text'),error=failure('OBSOLETE_CLEAR_FAILED');
  const fixture=app({read:async route=>{if(route===contentRoute('A','old.md'))return oldFile;if(route===contentRoute('B','new.md'))return newFile;throw Error('UNEXPECTED_API:'+route);},readDraft:async route=>({draft:route==='document-drafts?projectId=A&path=old.md'?{...oldFile}:null}),clearDraft:async body=>{assert.deepEqual(body,{projectId:'A',path:'old.md'});return pending.promise;}});
  try{
    const opening=fixture.probe.openFile('old.md','A');await until(()=>routes(fixture).includes('document-drafts/clear'));assert.deepEqual(fixture.session.snapshot().file,oldFile);
    assert.equal(await fixture.probe.openFile('new.md','B'),true);fixture.render();fixture.probe.setError('keep current B error');const before=fixture.probe.setError.calls.length;
    pending.reject(error);assert.equal(await opening,true);assert.deepEqual(fixture.session.snapshot().file,newFile);assert.deepEqual(fixture.probe.setError.calls.slice(before),[],'a delayed recovery-store callback must obey the same document identity guard');
  }finally{pending.resolve({cleared:true});fixture.dispose();}
});

test('a current stale-recovery clear failure remains visible while its opened text stays available',async()=>{
  const current=disk('A','current-clear.md','already saved text'),error=failure('CURRENT_CLEAR_FAILED'),fixture=app({read:async()=>current,draft:{...current},clearDraft:async()=>{throw error;}});
  try{assert.equal(await fixture.probe.openFile(current.path,'A'),true);assert.deepEqual(fixture.session.snapshot().file,current);assert.ok(fixture.probe.setError.calls.includes(error.message));}finally{fixture.dispose();}
});
