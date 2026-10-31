import test from 'node:test';
import assert from 'node:assert/strict';
import {app,deferred,disk,contentRoute,failure,until} from './fixtures/image-app-harness.mjs';

const info=(path='photo.png')=>({path,name:path.split('/').at(-1),size:123,modifiedAt:'2026-10-24T00:00:00.000Z',version:'a'.repeat(64),mime:'image/png',width:200,height:100});
const read=async route=>{if(route.includes('/file?'))throw failure('BINARY_FILE');if(route.includes('/image-info?'))return info();throw Error('UNEXPECTED:'+route);};
const writes=fixture=>fixture.calls.filter(call=>call.body!==undefined);

test('actual App image open preserves older text recovery, renders only read-only controls and refuses save before beginning it',async()=>{
  const fixture=app({draft:disk('B','photo.png','old text recovery'),read});
  try{
    assert.equal(await fixture.probe.openFile('photo.png','B',{line:2}),true);fixture.render();const snapshot=fixture.session.snapshot();
    assert.equal(snapshot.file.preview.kind,'image');assert.equal(snapshot.file.preview.version,'a'.repeat(64));assert.equal(snapshot.file.version,null);assert.equal(snapshot.file.content,'');assert.equal(snapshot.dirty,false);
    assert.ok(fixture.componentNode('ImagePreview'));assert.equal(fixture.componentNode('DocumentContent'),undefined);assert.equal(fixture.componentNode('FilePreviewFallback'),undefined);assert.equal(fixture.probe.setDocumentEditing.calls.at(-1),false);assert.equal(fixture.probe.setDocumentLocation.calls.at(-1),null);
    let began=false;fixture.session.beginSave=()=>{began=true;throw Error('IMAGE_SAVE_BEGAN');};assert.equal(await fixture.probe.saveDocument(),false);assert.equal(began,false);await fixture.probe.flushDocumentRecovery({file:snapshot.file,draft:null});assert.deepEqual(writes(fixture),[]);
  }finally{fixture.dispose();}
});

test('image plugin disable returns to metadata without clearing the file or recovery, and re-enable restores a stable load callback',async()=>{
  const fixture=app({read});
  try{
    await fixture.probe.openFile('photo.png','B');fixture.render();const first=fixture.componentNode('ImagePreview'),file=fixture.session.snapshot().file;
    assert.equal(typeof first.props.loadImage,'function');fixture.render();assert.equal(fixture.componentNode('ImagePreview').props.loadImage,first.props.loadImage);
    fixture.probe.setState(old=>({...old,features:['feature-files']}));fixture.render();assert.equal(fixture.componentNode('ImagePreview'),undefined);assert.equal(fixture.componentNode('FilePreviewFallback').props.file.preview.reason,'IMAGE_PLUGIN_DISABLED');assert.equal(fixture.session.snapshot().file,file);assert.deepEqual(writes(fixture),[]);
    fixture.probe.setState(old=>({...old,features:['feature-files','feature-images']}));fixture.render();assert.equal(fixture.componentNode('ImagePreview').props.loadImage,first.props.loadImage);assert.equal(fixture.session.snapshot().file,file);assert.deepEqual(writes(fixture),[]);
  }finally{fixture.dispose();}
});

test('a late image metadata response cannot replace a newer text file or attach stale source locations',async()=>{
  const pending=deferred(),next=disk('B','next.md','new current text'),fixture=app({read:async route=>{if(route===contentRoute('A','photo.png'))throw failure('BINARY_FILE');if(route.includes('/image-info?'))return pending.promise;if(route===contentRoute('B','next.md'))return next;throw Error('UNEXPECTED:'+route);}});
  try{
    const opening=fixture.probe.openFile('photo.png','A',{line:2});await until(()=>fixture.calls.some(call=>call.route.includes('/image-info?')));assert.equal(await fixture.probe.openFile('next.md','B',{line:1}),true);pending.resolve(info());assert.equal(await opening,false);fixture.render();assert.deepEqual(fixture.session.snapshot().file,next);assert.equal(fixture.componentNode('ImagePreview'),undefined);assert.ok(fixture.componentNode('DocumentContent'));assert.deepEqual(writes(fixture),[]);
  }finally{pending.resolve(info());fixture.dispose();}
});

test('disabling images during a metadata read cannot mount a decoder when the old read completes',async()=>{
  const pending=deferred(),fixture=app({read:async route=>{if(route.includes('/file?'))throw failure('BINARY_FILE');return pending.promise;}});
  try{
    const opening=fixture.probe.openFile('photo.png','B');await until(()=>fixture.calls.some(call=>call.route.includes('/image-info?')));fixture.probe.setState(old=>({...old,features:['feature-files']}));fixture.render();pending.resolve(info());assert.equal(await opening,true);fixture.render();assert.equal(fixture.componentNode('ImagePreview'),undefined);assert.equal(fixture.componentNode('FilePreviewFallback').props.file.preview.reason,'IMAGE_PLUGIN_DISABLED');assert.deepEqual(writes(fixture),[]);
  }finally{pending.resolve(info());fixture.dispose();}
});
