import path from 'node:path';
import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
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
// Signal only this launch's unguessable, non-inherited stop event. Never look
// up a numeric PID: the supervisor may exit while an asynchronous helper starts
// and Windows can reuse that PID for an unrelated process.
export function stopWindowsJob(stopEvent,{env=process.env,execFileImpl=execFile}={}) {
  if(!/^Local\\DSH-[a-f0-9-]{36}$/.test(stopEvent??''))return Promise.reject(Object.assign(Error('WINDOWS_JOB_INVALID'),{code:'WINDOWS_JOB_INVALID'}));
  const script="$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$deadline=[DateTime]::UtcNow.AddSeconds(5);do{try{$event=[Threading.EventWaitHandle]::OpenExisting('"+stopEvent+"');try{$event.Set()|Out-Null}finally{$event.Dispose()};exit 0}catch [Threading.WaitHandleCannotBeOpenedException]{Start-Sleep -Milliseconds 50}}while([DateTime]::UtcNow -lt $deadline);exit 1";
  return new Promise((resolve,reject)=>execFileImpl(windowsShell(env),['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:7000,env:windowsEnvironment(env)},error=>error?reject(error):resolve()));
}

export function windowsJobCommand(executable,args,{env=process.env,source=fileURLToPath(new URL('./windows-job.cs',import.meta.url)),hostPid=process.pid,stopEvent='Local\\DSH-'+randomUUID()}={}) {
  if(!Number.isSafeInteger(hostPid)||hostPid<=0)throw Object.assign(Error('WINDOWS_PROCESS_INVALID'),{code:'WINDOWS_PROCESS_INVALID'});
  if(!/^Local\\DSH-[a-f0-9-]{36}$/.test(stopEvent))throw Object.assign(Error('WINDOWS_JOB_INVALID'),{code:'WINDOWS_JOB_INVALID'});
  const quote=value=>"'"+value.replaceAll("'","''")+"'";
  const encodedArgs=Buffer.from(JSON.stringify(args),'utf8').toString('base64');
  const script="$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';try{Add-Type -Path "+quote(source)+";$dshArgs=ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+encodedArgs+"')));$dshCode=[Dsh.WindowsJob]::Run("+quote(executable)+",[string[]]$dshArgs,"+hostPid+","+quote(stopEvent)+");exit $dshCode}catch{[Console]::Error.WriteLine('DSH_WINDOWS_JOB_FAILED');exit 125}";
  return {stopEvent,file:windowsShell(env),args:['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')]};
}
