import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnPosixCommand,requestPosixStop,posixCommandResult} from '../server/posix-command-supervisor.mjs';
import {runProjectCommand,stopProjectCommand} from '../server/project-commands.mjs';

function fixture(){
 const child=new EventEmitter();Object.assign(child,{pid:424242,connected:true,sent:[],send(message,callback){this.sent.push(message);callback?.();}});
 let launch;spawnPosixCommand('/bin/sh',['-c','true'],{env:{PATH:'/bin'},spawnProcess:(file,args,options)=>{launch={file,args,options};return child;}});
 return{child,launch,token:launch.args[2]};
}
test('POSIX ownership uses a private non-inherited IPC capability and validates result tokens',()=>{
 const {child,launch,token}=fixture();assert.equal(launch.options.detached,true);assert.deepEqual(launch.options.stdio,['ignore','pipe','pipe','ipc']);assert.equal(launch.options.env.ELECTRON_RUN_AS_NODE,'1');
 child.emit('message',{type:'result',token:'foreign',code:0});assert.equal(posixCommandResult(child,125).code,125);
 child.emit('message',{type:'result',token,code:7,signal:null});assert.equal(posixCommandResult(child,125).code,7);
 requestPosixStop(child);assert.deepEqual(child.sent,[{type:'stop',token}]);
});
test('an exited or disconnected supervisor never receives delayed numeric PID/group signals',t=>{
 const denied=t.mock.method(process,'kill',()=>assert.fail('the parent must never signal a retained numeric PID'));
 const a=fixture();a.child.emit('exit',0,null);requestPosixStop(a.child);assert.equal(a.child.sent.length,0);
 const b=fixture();b.child.connected=false;requestPosixStop(b.child);assert.equal(b.child.sent.length,0);
 const c=fixture();requestPosixStop(c.child);c.child.emit('exit',null,'SIGKILL');c.child.pid=424242;requestPosixStop(c.child);assert.equal(c.child.sent.length,1);assert.equal(denied.mock.callCount(),0);
});
const native={skip:process.platform==='win32'?'native POSIX process-group lifetime test; run on Mac':false,timeout:10000};
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function marker(file){for(let n=0;n<300;n++){try{const value=Number(await readFile(file,'utf8'));if(value>1)return value;}catch(error){if(error.code!=='ENOENT')throw error;}await delay(10);}assert.fail('owned fixture did not start');}
test('native POSIX supervisor remains alive after shell exit, reaps its group and preserves an unrelated process',native,async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'dsh-posix-lifetime-')),commands=new Set();
 const unrelated=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
 const unrelatedDone=new Promise(resolve=>unrelated.once('close',resolve));
 try{
  const file=path.join(root,'pid'),worker=`require('node:fs').writeFileSync(${JSON.stringify(file)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`;
  const command=`${quote(process.execPath)} -e ${quote(worker)} >/dev/null 2>&1 & while [ ! -s ${quote(file)} ]; do sleep 0.01; done; printf done`;
  const pending=runProjectCommand({command,cwd:root,commands,shell:'/bin/sh',killGraceMs:100});const supervisor=[...commands][0];const pid=await marker(file);
  assert.notEqual(supervisor.pid,pid);const result=await pending;assert.equal(result.code,0);assert.equal(result.output,'done');assert.equal(result.cleanup.verified,false);assert.equal(commands.size,0);
  assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});assert.doesNotThrow(()=>process.kill(unrelated.pid,0));await stopProjectCommand(supervisor);assert.doesNotThrow(()=>process.kill(unrelated.pid,0));
 }finally{unrelated.kill('SIGKILL');await unrelatedDone;await rm(root,{recursive:true,force:true});}
});
