import {mkdir,mkdtemp,readdir,rename,rm,access} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {CHANNEL_PYTHON_VERSION,channelPythonPath} from '../shared/channel-runtime.js';
const run = promisify(execFile);

export async function prepareChannelRuntime({root=fileURLToPath(new URL('../../dsh-channel-runtime/',import.meta.url)),uv=process.env.DSH_UV_BINARY || 'uv',platform=process.platform,arch=process.arch,execute=run}={}) {
  if (!['darwin','win32'].includes(platform) || platform==='win32' && arch!=='x64') throw Error('CHANNEL_PREPARE_UNSUPPORTED_TARGET');
  if(platform!==process.platform || arch!==process.arch) throw Error('CHANNEL_PREPARE_NATIVE_HOST_REQUIRED');
  await mkdir(root,{recursive:true});
  const stage=await mkdtemp(path.join(root,'.prepare-'));
  const backups=[];const installed=[];
  try {
    const pythonRoot=path.join(stage,'python');await mkdir(pythonRoot);
    await execute(uv,['--no-config','--cache-dir',path.join(stage,'uv-cache'),'python','install','--no-bin','--install-dir',pythonRoot,CHANNEL_PYTHON_VERSION],{timeout:600000,maxBuffer:4*1024*1024});
    const distributions=(await readdir(pythonRoot,{withFileTypes:true})).filter(e=>e.isDirectory() && e.name.startsWith('cpython-'+CHANNEL_PYTHON_VERSION+'-'));
    if(distributions.length!==1)throw Error('CHANNEL_PYTHON_DISTRIBUTION_AMBIGUOUS');
    await rename(path.join(pythonRoot,distributions[0].name),path.join(pythonRoot,'runtime'));
    const python=channelPythonPath(stage);
    const probe=await execute(python,['-I','-B','-c','import sys,struct;print(".".join(map(str,sys.version_info[:3])));print(sys.platform);print(struct.calcsize("P")*8)'],{timeout:10000});
    const [version,actualPlatform,bits]=probe.stdout.trim().split(/\r?\n/);
    if(version!==CHANNEL_PYTHON_VERSION || actualPlatform!==platform || bits!=='64')throw Error('CHANNEL_PYTHON_TARGET_MISMATCH');
    await execute(uv,['--no-config','--cache-dir',path.join(stage,'uv-cache'),'pip','install','--python',python,'--target',path.join(stage,'packages'),'--require-hashes','--only-binary',':all:','--index-url','https://pypi.org/simple','-r',path.join(root,'requirements.lock')],{timeout:600000,maxBuffer:4*1024*1024});
    // Replace only generated runtime folders; roll back if either replacement fails.
    for(const name of ['python','packages']) {
      const target=path.join(root,name),backup=path.join(stage,'previous-'+name);
      try {await access(target);await rename(target,backup);backups.push([target,backup]);} catch(error){if(error.code!=='ENOENT')throw error;}
      await rename(path.join(stage,name),target);installed.push(target);
    }
    return {platform,arch,python:channelPythonPath(root),version};
  } catch(error) {
    for(const target of installed.reverse())await rm(target,{recursive:true,force:true});
    for(const [target,backup] of backups.reverse())await rename(backup,target);
    throw error;
  } finally {await rm(stage,{recursive:true,force:true});}
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) console.log(JSON.stringify(await prepareChannelRuntime(),null,2));
