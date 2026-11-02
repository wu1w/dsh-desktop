import path from 'node:path';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export function windowsEnvironment(source=process.env) {
  const allowed=new Set(['path','pathext','systemroot','windir','comspec','temp','tmp','userprofile','homedrive','homepath','appdata','localappdata','username','lang']);
  const env={};
  for(const [key,value] of Object.entries(source))if(allowed.has(key.toLowerCase())&&typeof value==='string'&&!value.includes('\0')){
    const canonical={path:'PATH',pathext:'PATHEXT',systemroot:'SystemRoot',windir:'WINDIR',comspec:'ComSpec'}[key.toLowerCase()]??key.toUpperCase();
    env[canonical]=value;
  }
  return env;
}
export function windowsShell(env=process.env) {
  const safe=windowsEnvironment(env),root=safe.SystemRoot||safe.WINDIR||'C:\\Windows';
  return path.win32.join(root,'System32','WindowsPowerShell','v1.0','powershell.exe');
}
export function windowsCommandArgs(shell,command) {
  if(path.win32.basename(shell).toLowerCase()==='cmd.exe')return ['/d','/s','/c',command];
  return ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from("[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); $OutputEncoding = [Console]::OutputEncoding; "+command,'utf16le').toString('base64')];
}
// Use an absolute OS utility, never a shell string or a PATH-provided taskkill.
// Resolve only after taskkill reports success; callers separately await the
// owned process exit. Failed termination keeps the activity/retry handle.
export function killWindowsProcessTree(pid,{env=process.env,execFileImpl=execFile}={}) {
  if(!Number.isSafeInteger(pid)||pid<=0)return Promise.reject(Object.assign(Error('WINDOWS_PROCESS_INVALID'),{code:'WINDOWS_PROCESS_INVALID'}));
  const safe=windowsEnvironment(env),root=safe.SystemRoot||safe.WINDIR||'C:\\Windows';
  return new Promise((resolve,reject)=>execFileImpl(path.win32.join(root,'System32','taskkill.exe'),['/PID',String(pid),'/T','/F'],{windowsHide:true,timeout:5000,env:safe},error=>error?reject(error):resolve()));
}

export function windowsJobCommand(executable,args,{env=process.env,source=fileURLToPath(new URL('./windows-job.cs',import.meta.url)),hostPid=process.pid}={}) {
  if(!Number.isSafeInteger(hostPid)||hostPid<=0)throw Object.assign(Error('WINDOWS_PROCESS_INVALID'),{code:'WINDOWS_PROCESS_INVALID'});
  const quote=value=>"'"+value.replaceAll("'","''")+"'";
  const encodedArgs=Buffer.from(JSON.stringify(args),'utf8').toString('base64');
  const script="$ErrorActionPreference='Stop';try{Add-Type -Path "+quote(source)+";$dshArgs=ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+encodedArgs+"')));$dshCode=[Dsh.WindowsJob]::Run("+quote(executable)+",[string[]]$dshArgs,"+hostPid+");exit $dshCode}catch{[Console]::Error.WriteLine('DSH_WINDOWS_JOB_FAILED');exit 125}";
  return {file:windowsShell(env),args:['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')]};
}
