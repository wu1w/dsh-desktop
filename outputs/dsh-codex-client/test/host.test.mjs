import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startHost } from '../server/index.mjs';
test('local API rejects cross-origin and unauthenticated calls and persists a real project across restart', async () => {
  const root=await mkdtemp(path.join(tmpdir(),'dsh-client-host-'));let host;
  try {
    host=await startHost({dataDir:root,autoStart:false});
    assert.equal((await fetch(host.url+'/api/state')).status,403);
    assert.equal((await fetch(host.url+'/api/bootstrap',{headers:{origin:'https://untrusted.example'}})).status,403);
    const response=await fetch(host.url+'/api/bootstrap');
    const cookie=response.headers.get('set-cookie').split(';')[0];
    const boot=await response.json();
    const headers={cookie,'x-dsh-capability':boot.capability,'content-type':'application/json'};
    const added=await fetch(host.url+'/api/projects',{method:'POST',headers,body:JSON.stringify({path:root,name:'Actual test folder'})});
    assert.equal(added.status,200);const project=await added.json();
    const noEngine=await fetch(host.url+'/api/sessions',{method:'POST',headers,body:JSON.stringify({projectId:project.id})});
    assert.equal(noEngine.status,400);assert.equal((await noEngine.json()).code,'ENGINE_DISABLED');
    await host.close();host=null;
    host=await startHost({dataDir:root,autoStart:false});
    const next=await (await fetch(host.url+'/api/bootstrap')).json();
    assert.equal(next.state.projects[0].id,project.id);
    assert.equal(next.state.projects[0].name,'Actual test folder');
    assert.notEqual(next.capability,boot.capability);
  } finally {if(host)await host.close();await rm(root,{recursive:true,force:true});}
});

test('a second host cannot share live state, including through a directory alias; shutdown is idempotent',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'dsh-client-lock-'));let host,next;
  try{
    host=await startHost({dataDir:root,autoStart:false});
    await assert.rejects(startHost({dataDir:root,autoStart:false}),error=>error.code==='DATA_IN_USE');
    await symlink(root,root+'-alias');await assert.rejects(startHost({dataDir:root+'-alias',autoStart:false}),error=>error.code==='DATA_IN_USE');
    const firstClose=host.close();assert.equal(host.close(),firstClose);await firstClose;host=null;
    next=await startHost({dataDir:root,autoStart:false});
    assert.equal((await fetch(next.url+'/api/bootstrap')).status,200);
  }finally{await host?.close();await next?.close();await rm(root+'-alias',{force:true});await rm(root,{recursive:true,force:true});}
});
