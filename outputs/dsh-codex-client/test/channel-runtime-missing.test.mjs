import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,rm,realpath,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {ChannelManager} from '../server/channel-manager.mjs';
import {ChannelProcess} from '../server/channel-process.mjs';
import {channelPythonPath} from '../shared/channel-runtime.js';

test('missing interpreter or bridge is classified before starting a process',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'dsh-channel-missing-'));t.after(()=>rm(root,{recursive:true,force:true}));
  let spawned=0;const worker=new ChannelProcess({root,home:root,platform:'qq',locale:'en',spawnProcess(){spawned++;throw Error('must not spawn');}});
  await assert.rejects(worker.start({}),{code:'CHANNEL_RUNTIME_MISSING'});
  const python=channelPythonPath(root);await mkdir(path.dirname(python),{recursive:true});await writeFile(python,'fixture',{mode:0o755});
  await assert.rejects(worker.start({}),{code:'CHANNEL_RUNTIME_MISSING'});
  assert.equal(spawned,0);assert.equal(worker.child,null);
});

test('missing runtime pauses reconnection and queued work until an explicit retry without clearing configuration',async t=>{
  const dataDir=await realpath(await mkdtemp(path.join(tmpdir(),'dsh-channel-paused-')));t.after(()=>rm(dataDir,{recursive:true,force:true}));
  let starts=0,available=false;
  class Transport extends EventEmitter {
    async start(){starts++;if(!available)throw Object.assign(Error('missing'),{code:'CHANNEL_RUNTIME_MISSING'});this.connected=true;return {connected:true};}
    async stop(){this.connected=false;this.emit('exit');}
    async request(){return {connected:true};}
  }
  const host={dataDir,appRoot:dataDir,state:{preferences:{},projects:[],sessions:[],models:[{id:'fixture-model'}]},getSelectedEngine:()=> 'codex',hasFeature:()=>false};
  const manager=await new ChannelManager({host,platform:'qq',Process:Transport,tickMs:1000000}).start();clearInterval(manager.timer);t.after(()=>manager.close());
  await manager.saveConfig({projectId:null,model:'fixture-model',permission:'read-only',locale:'en',appId:'fixture',secret:'fake-only',allowedUsers:['fixture'],allowedGroups:[]});
  await assert.rejects(manager.connect(),{code:'CHANNEL_RUNTIME_MISSING'});
  assert.equal(manager.snapshot().runtime.state,'error');assert.equal(manager.snapshot().runtime.nextRetryAt,null);assert.equal(manager.snapshot().runtime.retryBlocked,true);
  assert.equal(manager.store.config().enabled,true);
  for(let i=0;i<20;i++)await manager.work();assert.equal(starts,1);
  // Even a stale process-exit callback cannot restart the retry loop.
  manager.scheduleReconnect('CHANNEL_PROCESS_EXITED');await manager.work();assert.equal(starts,1);assert.equal(manager.error,'CHANNEL_RUNTIME_MISSING');
  available=true;await manager.connect();assert.equal(starts,2);assert.equal(manager.snapshot().runtime.retryBlocked,false);assert.equal(manager.state,'connected');
});
