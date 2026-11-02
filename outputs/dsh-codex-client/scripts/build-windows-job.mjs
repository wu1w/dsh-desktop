import {mkdir,rename,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
const run=promisify(execFile);
export async function buildWindowsJobHelper({appRoot,systemRoot=process.env.SystemRoot||'C:\\Windows'}={}){
 const compiler=path.join(systemRoot,'Microsoft.NET','Framework64','v4.0.30319','csc.exe');
 const target=path.join(appRoot,'native/bin/dsh-windows-job.exe'),temporary=target+'.'+process.pid+'.exe';
 await mkdir(path.dirname(target),{recursive:true});
 try{await run(compiler,['/nologo','/optimize+','/target:exe','/out:'+temporary,path.join(appRoot,'server/windows-job.cs'),path.join(appRoot,'server/windows-job-main.cs')],{windowsHide:true,timeout:30000});await rename(temporary,target);return target;}
 finally{await rm(temporary,{force:true});}
}
