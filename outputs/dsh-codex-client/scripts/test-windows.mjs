import {spawn} from 'node:child_process';
import {readdir,mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('..',import.meta.url)),logs=path.resolve(process.argv[2]??path.join(root,'windows-test-results'));
await mkdir(logs,{recursive:true});
const files=(await readdir(path.join(root,'test'))).filter(name=>name.endsWith('.test.mjs')).sort(),results=[];
let next=0;
async function worker(){
 while(next<files.length){
  const name=files[next++],args=['--test','--test-reporter=tap','--test-timeout=90000'];
  // node-pty keeps its native dispatcher alive after every owned Job and PTY
  // has closed. Force exit only this native-only test worker. Forcing all
  // workers triggers a Node 24 Windows libuv assertion with HTTP keepalives.
  if(name==='windows-terminal-native.test.mjs')args.push('--test-force-exit');
  args.push(path.join(root,'test',name));
  const child=spawn(process.execPath,args,{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';
  child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
  let timedOut=false;const watchdog=setTimeout(()=>{timedOut=true;child.kill();},180000);
  const code=await new Promise(resolve=>{child.once('error',error=>{output+=error.stack;resolve(-1);});child.once('close',resolve);});clearTimeout(watchdog);
  await writeFile(path.join(logs,name+'.log'),output);
  const counts=Object.fromEntries(['tests','pass','fail','cancelled','skipped'].map(key=>[key,Number(output.match(new RegExp('^# '+key+' (\\d+)$','m'))?.[1]??0)]));
  const row={name,code,timedOut,...counts};results.push(row);console.log(JSON.stringify(row));
 }
}
await Promise.all(Array.from({length:4},worker));
const totals=Object.fromEntries(['tests','pass','fail','cancelled','skipped'].map(key=>[key,results.reduce((sum,row)=>sum+row[key],0)]));
const report={totals,files:results.sort((a,b)=>a.name.localeCompare(b.name))};await writeFile(path.join(logs,'summary.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({totals}));
process.exitCode=results.some(row=>row.code!==0||row.timedOut||!row.tests)?1:0;
