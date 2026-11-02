import assert from 'node:assert/strict';
import fs,{constants} from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
const shell=path.join(process.env.SystemRoot||'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
export function permissionSnapshot(file){
 if(process.platform!=='win32')return {mode:fs.statSync(file).mode&0o777};
 const encoded=Buffer.from(path.resolve(file),'utf8').toString('base64');
 const script="$ErrorActionPreference='Stop';[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false);$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+encoded+"'));$a=if([IO.Directory]::Exists($p)){[IO.Directory]::GetAccessControl($p)}else{[IO.File]::GetAccessControl($p)};$u=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$r=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|ForEach-Object{@{sid=$_.IdentityReference.Value;rights=[int64]$_.FileSystemRights;type=[string]$_.AccessControlType}});@{user=$u;rules=$r}|ConvertTo-Json -Compress -Depth 4";
 return JSON.parse(execFileSync(shell,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:10000}));
}
export function assertPrivatePermissions(file,mode){
 if(process.platform!=='win32'){assert.equal(permissionSnapshot(file).mode,mode);return;}
 const acl=permissionSnapshot(file),broad=new Set(['S-1-1-0','S-1-5-11','S-1-5-32-545','S-1-5-4','S-1-15-2-1']);
 // NTFS uses the user's explicitly authorized profile ACL, not POSIX mode bits.
 // Assert real access rules without modifying them or removing named delegates.
 assert(!acl.rules.some(r=>r.type==='Allow'&&broad.has(r.sid)&&(r.rights&3)), 'private storage grants broad read/write access');
 assert(acl.rules.some(r=>r.type==='Allow'&&r.sid===acl.user&&(r.rights&3)===3),'current user lacks private storage read/write access');
 assert([0o600,0o700].includes(mode),'use an ACL snapshot for preservation assertions');
}
export function denyFixtureWrites(t,directory){
 const native=fsp.open;const mock=t.mock.method(fsp,'open',(file,flags,...rest)=>{
  const writing=typeof flags==='string'?/[wax+]/.test(flags):Boolean(flags&(constants.O_CREAT|constants.O_WRONLY|constants.O_RDWR));
  if(writing&&path.resolve(file).startsWith(path.resolve(directory)+path.sep))return Promise.reject(Object.assign(Error('controlled access denial'),{code:'EACCES'}));
  return native(file,flags,...rest);
 });syncBuiltinESMExports();let restored=false;return()=>{if(!restored){restored=true;mock.mock.restore();syncBuiltinESMExports();}};
}
