import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {windows} from './command-platform.mjs';
export function denyOwnedStop(t,child,nativeKill=process.kill.bind(process)){
 if(!windows)return t.mock.method(child,'send',(message,...args)=>{if(message?.type==='stop'){const callback=args.at(-1);if(typeof callback==='function')queueMicrotask(()=>callback(null));return true;}throw Error('unexpected fixture control message');});
 const event=child.spawnargs[2],native=childProcess.execFile;
 if(!/^Local\\DSH-/.test(event))throw Error('fixture does not own a Job event');
 const mocked=t.mock.method(childProcess,'execFile',(file,args,...rest)=>{
  const script=Buffer.from(args.at(-1),'base64').toString('utf16le');
  if(script.includes('EventWaitHandle]::OpenExisting')&&script.includes(event)){queueMicrotask(()=>rest.at(-1)(Object.assign(Error('controlled owned Job stop denial'),{code:'EACCES'})));return;}
  return native(file,args,...rest);
 });syncBuiltinESMExports();
 return{mock:{restore(){mocked.mock.restore();syncBuiltinESMExports();}}};
}
