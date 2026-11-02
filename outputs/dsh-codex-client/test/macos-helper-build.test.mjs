import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {buildComputerHelper} from '../scripts/build-computer.mjs';
import {buildPtyHelper} from '../scripts/build-pty.mjs';
const run=promisify(execFile);

test('Mac helpers compile with stable native signing identifiers across atomic rebuilds',{skip:process.platform!=='darwin',timeout:60000},async()=>{
 for(const [build,name] of [[buildComputerHelper,'dsh-computer-helper'],[buildPtyHelper,'dsh-pty-helper']]){
  const file=fileURLToPath(new URL('../native/bin/'+name,import.meta.url));
  for(let attempt=0;attempt<2;attempt++){
   await build();
   const signature=await run('/usr/bin/codesign',['-dv','--verbose=4',file]);
   assert.equal(signature.stderr.match(/^Identifier=(.+)$/m)?.[1],name);
   assert.match(signature.stderr,/Signature=adhoc/);
   const architecture=await run('/usr/bin/lipo',['-archs',file]);
   assert.ok(architecture.stdout.trim().split(/\s+/).includes(process.arch==='arm64'?'arm64':'x86_64'));
  }
 }
});
