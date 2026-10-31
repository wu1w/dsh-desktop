import {mkdir,rename,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
const run=promisify(execFile);
export async function buildComputerHelper(){
 if(process.platform!=='darwin')return;
 const source=fileURLToPath(new URL('../native/computer-helper.swift',import.meta.url));
 const target=fileURLToPath(new URL('../native/bin/dsh-computer-helper',import.meta.url));
 await mkdir(fileURLToPath(new URL('../native/bin/',import.meta.url)),{recursive:true});
 const tmp=target+'.'+process.pid;
 try{await run('/usr/bin/swiftc',['-O',source,'-o',tmp],{timeout:60000});await rename(tmp,target);}finally{await rm(tmp,{force:true});}
}
if(process.argv[1]===fileURLToPath(import.meta.url))await buildComputerHelper();
