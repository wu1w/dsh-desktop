import path from 'node:path';
import {pathToFileURL} from 'node:url';

export function nativeEngineProbeSource(root,home) {
  return `import {DshNativeEngine} from ${JSON.stringify(pathToFileURL(path.join(root,'native-engine/lib/engine.js')).href)};
import {ScriptedAdapter} from ${JSON.stringify(pathToFileURL(path.join(root,'native-engine/lib/scripted-adapter.js')).href)};
import {randomUUID} from 'node:crypto';import {createRequire} from 'node:module';
globalThis.fetch=()=>{throw Error('NETWORK_DISABLED_IN_PACKAGE_PROBE');};
if(process.platform==='win32'){const require=createRequire(${JSON.stringify(pathToFileURL(path.join(root,'native-engine/package.json')).href)});const koffi=require('koffi');koffi.load('kernel32.dll');koffi.load('advapi32.dll');}
const engine=new DshNativeEngine({dataDir:${JSON.stringify(path.join(home,'native-probe'))},adapter:new ScriptedAdapter(()=>{throw Error('INFERENCE_DISABLED_IN_PACKAGE_PROBE');}),resolveApiKey:()=>{throw Error('CREDENTIALS_DISABLED_IN_PACKAGE_PROBE');},resolveSharedInstructions:async()=>''});
try{await engine.start();await engine.createSession(randomUUID(),{cwd:${JSON.stringify(home)}});console.log('DSH_NATIVE_PROBE_OK');}finally{await engine.dispose();}`;
}

export function windowsPtyProbeSource(root,home) {
  return `import {ProjectPtyManager} from ${JSON.stringify(pathToFileURL(path.join(root,'server/project-pty.mjs')).href)};
const manager=new ProjectPtyManager();const timeout=setTimeout(()=>process.exit(2),20000);
try{const row=await manager.create({projectId:'package-probe',cwd:${JSON.stringify(home)}});
await manager.write('package-probe',row.id,${JSON.stringify("Write-Output 'DSH_PTY_OK'; exit 0\r")});
let result;for(let n=0;n<150;n++){result=manager.read('package-probe',row.id);if(result.status==='exited')break;await new Promise(resolve=>setTimeout(resolve,100));}
await manager.close();clearTimeout(timeout);if(result.status!=='exited'||result.exitCode!==0||!JSON.stringify(result).includes('DSH_PTY_OK'))process.exit(3);
}catch(error){console.error(error.code||error.message);process.exit(4);}`;
}
