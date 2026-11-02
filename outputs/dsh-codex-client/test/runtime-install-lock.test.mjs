import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,utimes} from 'node:fs/promises';
import path from 'node:path';import {tmpdir,hostname} from 'node:os';import {spawn,spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {withRuntimeInstallLock} from '../scripts/runtime-install-lock.mjs';
import {fixtureSymlink} from './fixtures/fs-platform.mjs';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function setup(t){const root=await mkdtemp(path.join(tmpdir(),'dsh-install-lock-'));t.after(()=>rm(root,{recursive:true,force:true}));for(const n of ['python','packages']){await mkdir(path.join(root,n));await writeFile(path.join(root,n,'version'),'old');}return root;}
async function stage(root,name){const dir=path.join(root,name);for(const n of ['python','packages']){await mkdir(path.join(dir,n),{recursive:true});await writeFile(path.join(dir,n,'version'),name);}return dir;}
function worker(t,root,stage,fail=''){
 const child=spawn(process.execPath,[fileURLToPath(new URL('./fixtures/runtime-install-worker.mjs',import.meta.url)),root,stage,fail],{stdio:['ignore','ignore','pipe','ipc'],windowsHide:true});const messages=[];let stderr='';child.stderr.on('data',b=>stderr+=b);child.on('message',m=>messages.push(m));const done=new Promise(resolve=>child.on('close',code=>resolve(code)));t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill();await done;});
 return {child,messages,done,async until(key){for(let n=0;n<500;n++){const found=messages.find(m=>key in m);if(found)return found;if(child.exitCode!==null)assert.fail(stderr||JSON.stringify(messages));await delay(10);}assert.fail('worker timed out: '+stderr);}};
}
for(const fail of ['', 'fail'])test('cross-process runtime writers cannot publish mixed pairs; rollback='+Boolean(fail),{timeout:20000},async t=>{
 const root=await setup(t),a=await stage(root,'A'),b=await stage(root,'B');
 // Normalize for the worker's fixed generated source paths, not shell parsing.
 const first=worker(t,root,a);await first.until('entered');const second=worker(t,root,b,fail);await second.until('started');await delay(100);assert(!second.messages.some(m=>m.entered));first.child.send('release');assert((await first.until('done')).done);await second.until('entered');second.child.send('release');await second.until(fail?'error':'done');assert.equal(await first.done,0);assert.equal(await second.done,0);
 const expected=fail?'A':'B';assert.equal(await readFile(path.join(root,'python/version'),'utf8'),expected);assert.equal(await readFile(path.join(root,'packages/version'),'utf8'),expected);
 await withRuntimeInstallLock(root,async()=>{}); // prior owners released after success/failure
});
test('an old but live lock is never stolen; a dead owner is reported without deleting its data',async t=>{
 const root=await setup(t),lock=path.join(root,'.runtime-install.lock');await mkdir(lock);
 const ownerPath=path.join(lock,'owner.json'),owner={pid:process.pid,host:hostname(),token:'live-fixture'};await writeFile(ownerPath,JSON.stringify(owner));const old=new Date(Date.now()-86400000);await utimes(lock,old,old);
 await assert.rejects(withRuntimeInstallLock(root,async()=>assert.fail('must not enter'),{timeoutMs:40,pollMs:10}),{code:'CHANNEL_RUNTIME_BUSY'});assert.deepEqual(JSON.parse(await readFile(ownerPath,'utf8')),owner);
 const child=spawnSync(process.execPath,['-e','process.stdout.write(String(process.pid))'],{encoding:'utf8',windowsHide:true});assert.equal(child.status,0);const pid=Number(child.stdout);assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});owner.pid=pid;owner.token='dead-fixture';await writeFile(ownerPath,JSON.stringify(owner));
 await assert.rejects(withRuntimeInstallLock(root,async()=>assert.fail('must not enter')),{code:'CHANNEL_RUNTIME_LOCK_STALE'});assert.deepEqual(JSON.parse(await readFile(ownerPath,'utf8')),owner);assert.equal(await readFile(path.join(root,'python/version'),'utf8'),'old');
});
test('lease releases after a thrown operation and canonical directory aliases serialize',async t=>{
 const root=await setup(t);await assert.rejects(withRuntimeInstallLock(root,async()=>{throw Error('FIXTURE_FAILURE');}),/FIXTURE_FAILURE/);
 const alias=root+'-alias';await fixtureSymlink(root,alias,'dir');t.after(()=>rm(alias,{recursive:true,force:true}));
 await withRuntimeInstallLock(root,async ({assertHeld})=>{await assertHeld();await assert.rejects(withRuntimeInstallLock(alias,async()=>assert.fail('alias bypassed lock'),{timeoutMs:40,pollMs:10}),{code:'CHANNEL_RUNTIME_BUSY'});});
 await withRuntimeInstallLock(alias,async ({assertHeld})=>{await assertHeld();});
});

test('a replaced owner is never removed by the previous lease',async t=>{
 const root=await setup(t),owner=path.join(root,'.runtime-install.lock/owner.json');
 await assert.rejects(withRuntimeInstallLock(root,async({assertHeld})=>{await writeFile(owner,'foreign owner');await assert.rejects(assertHeld(),{code:'CHANNEL_RUNTIME_LOCK_LOST'});}),{code:'CHANNEL_RUNTIME_LOCK_LOST'});
 assert.equal(await readFile(owner,'utf8'),'foreign owner');
});

test('malformed lock metadata fails explicitly without removing a possible writer',async t=>{
 const root=await setup(t),lock=path.join(root,'.runtime-install.lock'),owner=path.join(lock,'owner.json');await mkdir(lock);await writeFile(owner,'partial writer metadata');
 await assert.rejects(withRuntimeInstallLock(root,async()=>assert.fail('unsafe lock admitted writer')),{code:'CHANNEL_RUNTIME_LOCK_UNSAFE'});assert.equal(await readFile(owner,'utf8'),'partial writer metadata');
});
