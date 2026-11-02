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
await manager.close();clearTimeout(timeout);if(result.status!=='exited'||result.exitCode!==0||!JSON.stringify(result).includes('DSH_PTY_OK'))process.exit(3);console.log('DSH_WINDOWS_PTY_PROBE_OK');process.exit(0);
}catch(error){console.error(error.code||error.message);process.exit(4);}`;
}

// macOS-only runtime acceptance. Immediate UTF-8 input is tested, not assumed
// broken: a Mac-built package cannot pass its gate if the real PTY loses it.
export function macosPtyProbeSource(root,home){
 return `import {ProjectPtyManager} from ${JSON.stringify(pathToFileURL(path.join(root,'server/project-pty.mjs')).href)};
const manager=new ProjectPtyManager();const watchdog=setTimeout(()=>process.exit(2),20000);
try{const row=await manager.create({projectId:'package-probe',cwd:${JSON.stringify(home)}});
await manager.write('package-probe',row.id,${JSON.stringify("printf 'DSH_MAC_PTY_UTF8_终端\\n'; exit 0\r")});
let result;for(let n=0;n<150;n++){result=manager.read('package-probe',row.id);if(result.status==='exited')break;await new Promise(resolve=>setTimeout(resolve,100));}
await manager.close();clearTimeout(watchdog);if(result.status!=='exited'||result.exitCode!==0||result.cleanupPending||!result.output.includes('DSH_MAC_PTY_UTF8_终端'))process.exit(3);
console.log('DSH_MACOS_PTY_PROBE_OK');process.exit(0);
}catch(error){console.error(error.code||error.message);process.exit(4);}`;
}

// Exercise the private IPC supervisor under Electron's embedded Node, not only
// a developer Node installation. Commands and all their data stay local.
export function macosCommandProbeSource(root,home){
 return `import {runProjectCommand,stopProjectCommands} from ${JSON.stringify(pathToFileURL(path.join(root,'server/project-commands.mjs')).href)};
import assert from 'node:assert/strict';
const commands=new Set();
try{
 const normal=await runProjectCommand({command:"printf 'PACKAGED_COMMAND_终端'",cwd:${JSON.stringify(home)},commands,shell:'/bin/sh',killGraceMs:50});
 assert.equal(normal.code,0);assert.equal(normal.output,'PACKAGED_COMMAND_终端');assert.equal(commands.size,0);
 assert.deepEqual(normal.cleanup,{verified:false,scope:'process-group',reason:'detached_descendants_unverified'});
 const timed=await runProjectCommand({command:'exec /bin/sleep 60',cwd:${JSON.stringify(home)},commands,shell:'/bin/sh',timeoutMs:300,killGraceMs:50});
 assert.notEqual(timed.code,0);assert.equal(commands.size,0);
 console.log('DSH_MACOS_COMMAND_PROBE_OK');
}finally{await stopProjectCommands(commands);}`;
}
