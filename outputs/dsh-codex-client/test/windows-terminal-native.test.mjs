// Runs on a Windows machine only. Uses local shells and temporary files, no
// model/network calls. Requires node-pty rebuilt for the running Node/Electron.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {ProjectPtyManager} from '../server/project-pty.mjs';
import {runProjectCommand} from '../server/project-commands.mjs';
const skip=process.platform!=='win32';
const quote=text=>"'"+text.replaceAll("'","''")+"'";
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};
async function until(predicate){for(let n=0;n<300;n++){if(await predicate())return;await pause(50);}assert.fail('Windows terminal acceptance timed out');}

test('Windows native ConPTY supports Unicode, input, resize and bounded stop',{skip,timeout:30000},async()=>{
 const cwd=await mkdtemp(path.join(tmpdir(),'dsh-win-native-')),manager=new ProjectPtyManager();
 try{
  const terminal=await manager.create({projectId:'p',cwd,cols:90,rows:25});
  await manager.write('p',terminal.id,"[Console]::WriteLine(('终端测试').ToUpper()); [Console]::WriteLine('SIZE:'+ $Host.UI.RawUI.WindowSize.Width)\r");
  await until(()=>manager.read('p',terminal.id).output.includes('SIZE:90'));
  await manager.resize('p',terminal.id,{cols:110,rows:35});await manager.write('p',terminal.id,"[Console]::WriteLine('RESIZED:'+ $Host.UI.RawUI.WindowSize.Width)\r");
  await until(()=>manager.read('p',terminal.id).output.includes('RESIZED:110'));assert(manager.read('p',terminal.id).output.includes('终端测试'));
  assert.equal((await manager.stop('p',terminal.id)).status,'exited');
 }finally{await manager.close();await rm(cwd,{recursive:true,force:true});}
});
test('Windows Job kills background descendants after a captured command naturally exits',{skip,timeout:30000},async()=>{
 const cwd=await mkdtemp(path.join(tmpdir(),'dsh-win-job-')),commands=new Set();
 try{
  const marker=path.join(cwd,'child.txt');const command="$p=Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe') -ArgumentList '-NoLogo','-NoProfile','-Command','Start-Sleep -Seconds 120' -PassThru;[IO.File]::WriteAllText("+quote(marker)+",[string]$p.Id);Write-Output '中文完成'";
  const result=await runProjectCommand({command,cwd,commands,timeoutMs:20000});assert.equal(result.code,0);assert(result.output.includes('中文完成'));assert.equal(commands.size,0);const pid=Number(await readFile(marker,'utf8'));assert(pid>0);await until(()=>!alive(pid));
 }finally{await rm(cwd,{recursive:true,force:true});}
});

test('Windows Job supervisor closes descendants when its Node host is terminated',{skip,timeout:30000},async()=>{
 const {spawn}=await import('node:child_process');const {windowsEnvironment}=await import('../server/windows-process.mjs');const cwd=await mkdtemp(path.join(tmpdir(),'dsh-win-host-death-'));let host,pid;
 try{
  const marker=path.join(cwd,'owned.txt');const command='[IO.File]::WriteAllText('+quote(marker)+',[string]$PID);Start-Sleep -Seconds 120';
  const source=`import {runProjectCommand} from ${JSON.stringify(new URL('../server/project-commands.mjs',import.meta.url).href)};await runProjectCommand({command:${JSON.stringify(command)},cwd:${JSON.stringify(cwd)},commands:new Set(),timeoutMs:120000});`;
  host=spawn(process.execPath,['--input-type=module','-e',source],{stdio:'ignore',windowsHide:true,env:windowsEnvironment(process.env)});
  await until(async()=>{try{pid=Number(await readFile(marker,'utf8'));return pid>0;}catch{return false;}});assert(alive(pid));host.kill();await until(()=>!alive(pid));
 }finally{host?.kill();if(pid&&alive(pid))try{process.kill(pid);}catch{}await rm(cwd,{recursive:true,force:true});}
});
