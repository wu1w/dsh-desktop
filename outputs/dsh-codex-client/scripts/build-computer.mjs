import {mkdir,mkdtemp,rename,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const run=promisify(execFile);
export async function buildComputerHelper(){
 if(process.platform!=='darwin')return;
 const source=fileURLToPath(new URL('../native/computer-helper.swift',import.meta.url));
 const target=fileURLToPath(new URL('../native/bin/dsh-computer-helper',import.meta.url));
 await mkdir(fileURLToPath(new URL('../native/bin/',import.meta.url)),{recursive:true});
 // A PID suffix becomes the linker's code-signing identifier. Keep the
 // executable basename stable while retaining a private atomic build directory.
 const stage=await mkdtemp(path.join(path.dirname(target),'.computer-build-'));
 const tmp=path.join(stage,path.basename(target));
 try{await run('/usr/bin/swiftc',['-O',source,'-o',tmp],{timeout:60000});await rename(tmp,target);}finally{await rm(stage,{recursive:true,force:true});}
}
if(process.argv[1]===fileURLToPath(import.meta.url))await buildComputerHelper();
