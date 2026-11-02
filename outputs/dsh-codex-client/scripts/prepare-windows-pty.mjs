import {spawnSync} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {channelEnvironment} from '../shared/channel-runtime.js';
import {windowsPtyProbeSource} from './packaged-probes.mjs';

// The locked node-pty package ships a Windows N-API prebuild. Verify it with
// the exact Electron runtime and a real ConPTY before requiring a C++ compiler.
// Packaged-app verification repeats this check on the copied application.
export async function prepareWindowsPty({root,electron,electronVersion,arch,run=spawnSync,rebuild}={}) {
 const home=await mkdtemp(path.join(tmpdir(),'dsh-pty-abi-'));
 try {
  const source=`if(process.versions.electron!==${JSON.stringify(electronVersion)}||process.arch!==${JSON.stringify(arch)})throw Error('PTY_TARGET_MISMATCH');\n`+windowsPtyProbeSource(root,home);
  const probe=()=>run(electron,['--input-type=module','-e',source],{encoding:'utf8',timeout:25000,windowsHide:true,env:{...channelEnvironment(home,'en'),ELECTRON_RUN_AS_NODE:'1'}});
  const valid=result=>result.status===0&&result.stdout?.includes('DSH_WINDOWS_PTY_PROBE_OK');
  if(valid(probe()))return {nativeModule:'verified-prebuild-or-existing',electronVersion,arch};
  rebuild??=(await import('@electron/rebuild')).rebuild;
  await rebuild({buildPath:root,electronVersion,arch,onlyModules:['node-pty'],force:true});
  if(!valid(probe()))throw Error('WINDOWS_PTY_REBUILD_VERIFICATION_FAILED');
  return {nativeModule:'rebuilt-and-verified',electronVersion,arch};
 }finally{await rm(home,{recursive:true,force:true});}
}
