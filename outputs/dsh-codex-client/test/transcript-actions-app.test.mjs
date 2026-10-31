import test from 'node:test';
import assert from 'node:assert/strict';
import {app,disk} from './fixtures/image-app-harness.mjs';
const read=route=>{const match=/^projects\/([^/]+)\/file\?path=(.*)$/.exec(route);assert.ok(match,route);return disk(decodeURIComponent(match[1]),decodeURIComponent(match[2]));};
test('memoized row action bridge keeps stable identity and opens the explicitly captured project',async()=>{
 const fixture=app({read});try{const actions=fixture.probe.transcriptActions.current;fixture.render();assert.equal(fixture.probe.transcriptActions.current,actions);assert.equal(await actions.onOpenFile('same.md','B',{line:1}),true);assert.equal(fixture.session.snapshot().file.projectId,'B');assert.ok(fixture.calls.some(row=>row.route==='projects/B/file?path=same.md'));assert.ok(!fixture.calls.some(row=>row.route==='projects/A/file?path=same.md'));}finally{fixture.dispose();}
});
test('the same stable bridge uses the latest disabled and restored file capability rather than its initial closure',async()=>{
 const fixture=app({read});try{const actions=fixture.probe.transcriptActions.current;fixture.probe.setState(old=>({...old,features:[]}));fixture.render();assert.equal(fixture.probe.transcriptActions.current,actions);assert.equal(await actions.onOpenFile('new.md','B'),false);assert.deepEqual(fixture.calls,[]);fixture.probe.setState(old=>({...old,features:['feature-files']}));fixture.render();assert.equal(await actions.onOpenFile('new.md','B'),true);assert.equal(fixture.session.snapshot().file.projectId,'B');}finally{fixture.dispose();}
});
