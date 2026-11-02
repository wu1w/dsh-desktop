import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {packagingTarget} from './packaging-config.mjs';

export function windowsReleasePlan({root=fileURLToPath(new URL('../',import.meta.url)),npmCli=process.env.npm_execpath,node=process.execPath,platform=process.platform,arch=process.arch}={}) {
  packagingTarget(['--platform=win32','--arch=x64'],platform,arch);
  if(!npmCli || !path.isAbsolute(npmCli))throw Error('WINDOWS_RELEASE_USE_NPM: run npm run release:win');
  const npm=(name,args)=>({name,file:node,args:[npmCli,...args],cwd:root});
  const packages=['dsh-codex-engine','dsh-native-engine','dsh-claude-engine','dsh-codex-client'];
  return [
    ...packages.map(name=>npm('install '+name,['ci','--prefix',path.resolve(root,'..',name),'--registry=https://registry.npmjs.org','--no-audit','--no-fund'])),
    ...['prepare:channels','build','package:win'].map(name=>npm(name,['run',name,'--prefix',root])),
  ];
}
function execute(task) {
  return new Promise((resolve,reject)=>{
    const child=spawn(task.file,task.args,{cwd:task.cwd,stdio:'inherit',shell:false});
    child.once('error',reject);
    child.once('exit',(code,signal)=>code===0?resolve():reject(Error(`WINDOWS_RELEASE_STAGE_FAILED: ${task.name} (${signal || code})`)));
  });
}
export async function releaseWindows(options={},run=execute) {
  for(const task of windowsReleasePlan(options)) {console.log('[DSH release] '+task.name);await run(task);}
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await releaseWindows();
