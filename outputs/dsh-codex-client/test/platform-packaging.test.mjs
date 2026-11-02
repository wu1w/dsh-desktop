import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {channelPythonPath,channelEnvironment,CHANNEL_PYTHON_VERSION,channelPythonArchitecture} from '../shared/channel-runtime.js';
import {packagingTarget,windowsInstallerConfig} from '../scripts/packaging-config.mjs';
import {prepareChannelRuntime} from '../scripts/prepare-channel-runtime.mjs';

test('Windows runtime uses native executable layout and private homes without inheriting credentials',()=>{
  assert.equal(channelPythonPath('C:\\Program Files\\DSH\\channel-runtime','win32'),'C:\\Program Files\\DSH\\channel-runtime\\python\\runtime\\python.exe');
  const env=channelEnvironment('C:\\Users\\测试\\DSH','zh-CN','win32',{SystemRoot:'D:\\Windows',PATH:'C:\\Untrusted',PYTHONPATH:'secret',OPENAI_API_KEY:'secret',HTTPS_PROXY:'http://proxy:8888'});
  assert.equal(env.SystemRoot,'D:\\Windows');assert.equal(env.PATH,'D:\\Windows\\System32;D:\\Windows');
  assert.equal(env.USERPROFILE,env.HOME);assert.equal(env.APPDATA,env.HOME);assert.equal(env.TEMP,env.HOME);
  assert.equal(env.HTTPS_PROXY,'http://proxy:8888');assert.equal(env.PYTHONPATH,undefined);assert.equal(env.OPENAI_API_KEY,undefined);
  assert.equal(channelPythonPath('/Applications/DSH/channel-runtime','darwin'),'/Applications/DSH/channel-runtime/python/runtime/bin/python3');
  assert.equal(channelEnvironment('/tmp/private','en','darwin',{}).PATH,'/usr/bin:/bin');
});

test('native target validation refuses cross-platform or unsupported payloads before packing',()=>{
  assert.deepEqual(packagingTarget(['--platform=win32','--arch=x64'],'win32','x64'),{platform:'win32',arch:'x64'});
  assert.throws(()=>packagingTarget(['--platform=win32','--arch=x64'],'darwin','arm64'),/NATIVE_HOST_REQUIRED/);
  assert.throws(()=>packagingTarget(['--platform=win32','--arch=arm64'],'win32','arm64'),/UNSUPPORTED_TARGET/);
  assert.throws(()=>packagingTarget(['--publish=always'],'win32','x64'),/Unknown packaging argument/);
  const config=windowsInstallerConfig('/build/client',{devDependencies:{electron:'45.0.0'}});
  assert.equal(config.publish,null);assert.equal(config.nsis.runAfterFinish,false);assert.equal(config.nsis.deleteAppDataOnUninstall,false);
  assert.deepEqual(config.win.target,[{target:'nsis',arch:['x64']}]);
});

test('Python preparation pins interpreter and wheel hashes; failed install preserves previous runtime',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'dsh-python-prepare-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(path.join(root,'python'));await writeFile(path.join(root,'python','previous'),'old');
  await mkdir(path.join(root,'packages'));await writeFile(path.join(root,'packages','previous'),'old');
  const calls=[];
  async function execute(command,args){
    calls.push({command,args});
    if(args.includes('python')) {await mkdir(path.join(args[args.indexOf('--install-dir')+1],`cpython-${CHANNEL_PYTHON_VERSION}-fixture`));return {stdout:''};}
    if(args[0]==='-I')return {stdout:CHANNEL_PYTHON_VERSION+'\n'+process.platform+'\n64\n'+process.arch+'\n'};
    if(args.includes('pip'))throw Error('OFFLINE_INSTALL_FAILED');
    throw Error('unexpected command');
  }
  await assert.rejects(prepareChannelRuntime({root,uv:'fixture-uv',execute}),/OFFLINE_INSTALL_FAILED/);
  assert.equal(await readFile(path.join(root,'python','previous'),'utf8'),'old');
  assert.equal(await readFile(path.join(root,'packages','previous'),'utf8'),'old');
  const pip=calls.find(c=>c.args.includes('pip'));assert(pip.args.includes('--require-hashes'));assert(pip.args.includes('--only-binary'));assert(pip.args.includes(':all:'));
  assert.deepEqual((await readdir(root)).sort(),['packages','python']);
});

test('successful Python preparation replaces both generated directories without stale dependencies',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'dsh-python-prepare-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(path.join(root,'packages'));await writeFile(path.join(root,'packages','stale'),'old');
  async function execute(command,args){
    if(args.includes('python')){const pythonRoot=args[args.indexOf('--install-dir')+1],distribution=path.join(pythonRoot,`cpython-${CHANNEL_PYTHON_VERSION}-fixture`);await mkdir(distribution);await symlink(distribution,path.join(pythonRoot,'cpython-version-alias'),process.platform==='win32'?'junction':'dir');return {stdout:''};}
    if(args[0]==='-I')return {stdout:CHANNEL_PYTHON_VERSION+'\n'+process.platform+'\n64\n'+process.arch+'\n'};
    if(args.includes('pip')){const target=args[args.indexOf('--target')+1];await mkdir(target);await writeFile(path.join(target,'current'),'new');return {stdout:''};}
    throw Error('unexpected command');
  }
  const result=await prepareChannelRuntime({root,execute});assert.equal(result.version,CHANNEL_PYTHON_VERSION);
  assert.deepEqual(await readdir(path.join(root,'packages')),['current']);
  assert.deepEqual(await readdir(path.join(root,'python')),['runtime']);
  assert.deepEqual((await readdir(root)).sort(),['packages','python']);
});

test('fresh Windows pipeline installs every package before channel prep, build and verified packaging',async()=>{
  const {windowsReleasePlan,releaseWindows}=await import('../scripts/release-windows.mjs');
  const options={root:'/isolated/dsh-codex-client',npmCli:path.resolve('/tools/npm-cli.js'),node:'/tools/node',platform:'win32',arch:'x64'};
  const plan=windowsReleasePlan(options);assert.equal(plan.length,7);
  assert.deepEqual(plan.slice(0,4).map(p=>p.name),['install dsh-codex-engine','install dsh-native-engine','install dsh-claude-engine','install dsh-codex-client']);
  assert.deepEqual(plan.slice(4).map(p=>p.name),['prepare:channels','build','package:win']);
  assert(plan.every(p=>p.file==='/tools/node' && p.args[0]===path.resolve('/tools/npm-cli.js')));
  assert(plan.slice(0,4).every(p=>p.args.includes('--registry=https://registry.npmjs.org')));
  const calls=[];await assert.rejects(releaseWindows(options,async task=>{calls.push(task.name);if(calls.length===2)throw Error('INSTALL_FAILED');}),/INSTALL_FAILED/);
  assert.equal(calls.length,2);
  assert.throws(()=>windowsReleasePlan({...options,platform:'darwin',arch:'arm64'}),/NATIVE_HOST_REQUIRED/);
});

test('packaged PTY probe emits a real Enter character and escaped source paths',async()=>{
  const {windowsPtyProbeSource,nativeEngineProbeSource}=await import('../scripts/packaged-probes.mjs');
  const source=windowsPtyProbeSource('/path with spaces/client',"/tmp/probe's home");
  const argument=source.match(/await manager.write\('package-probe',row.id,(.+)\);/)[1];
  assert.equal(JSON.parse(argument),"Write-Output 'DSH_PTY_OK'; exit 0\r");
  assert(!JSON.parse(argument).endsWith('\\r'));
  const native=nativeEngineProbeSource('/client','/tmp/probe');
  assert(native.includes('engine.createSession(randomUUID()'));assert(native.includes("koffi.load('kernel32.dll')"));
  assert(native.includes('INFERENCE_DISABLED_IN_PACKAGE_PROBE'));assert(native.includes('CREDENTIALS_DISABLED_IN_PACKAGE_PROBE'));
});

test('Python architecture aliases are explicit; a wrong 64-bit runtime is rejected before replacing files',async t=>{
  assert.equal(channelPythonArchitecture('AMD64'),'x64');assert.equal(channelPythonArchitecture('x86_64'),'x64');assert.equal(channelPythonArchitecture('aarch64'),'arm64');assert.equal(channelPythonArchitecture('arm64'),'arm64');assert.equal(channelPythonArchitecture('i386'),null);
  const root=await mkdtemp(path.join(tmpdir(),'dsh-python-wrong-arch-'));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(path.join(root,'python'));await writeFile(path.join(root,'python','previous'),'keep');let pipCalled=false;
  async function execute(command,args){
    if(args.includes('python')){await mkdir(path.join(args[args.indexOf('--install-dir')+1],`cpython-${CHANNEL_PYTHON_VERSION}-fixture`));return {stdout:''};}
    if(args[0]==='-I')return {stdout:CHANNEL_PYTHON_VERSION+'\n'+process.platform+'\n64\n'+(process.arch==='x64'?'arm64':'x86_64')+'\n'};
    pipCalled=true;throw Error('unexpected install');
  }
  await assert.rejects(prepareChannelRuntime({root,execute}),/CHANNEL_PYTHON_TARGET_MISMATCH/);assert.equal(pipCalled,false);assert.equal(await readFile(path.join(root,'python','previous'),'utf8'),'keep');assert.deepEqual(await readdir(root),['python']);
});

test('failed runtime rollback preserves the old files in an explicitly reported recovery directory',async t=>{
  const {installStagedRuntime}=await import('../scripts/prepare-channel-runtime.mjs');const {rename}=await import('node:fs/promises');
  const root=await mkdtemp(path.join(tmpdir(),'dsh-python-rollback-'));t.after(()=>rm(root,{recursive:true,force:true}));const stage=path.join(root,'.prepare-fixture');await mkdir(stage);
  for(const name of ['python','packages']){await mkdir(path.join(root,name));await writeFile(path.join(root,name,'old'),'old '+name);await mkdir(path.join(stage,name));await writeFile(path.join(stage,name,'new'),'new '+name);}
  const denied=()=>Object.assign(Error('locked fixture'),{code:'EPERM'});
  await assert.rejects(installStagedRuntime(root,stage,{renamePath:async(from,to)=>{
    if(from===path.join(stage,'packages')||from===path.join(stage,'previous-python'))throw denied();
    return rename(from,to);
  }}),error=>error.code==='CHANNEL_PREPARE_ROLLBACK_FAILED'&&error.recoveryDirectory===stage);
  assert.equal(await readFile(path.join(stage,'previous-python','old'),'utf8'),'old python');assert.equal(await readFile(path.join(root,'packages','old'),'utf8'),'old packages');
});

test('Windows computer package probe only requests status and does not claim desktop acceptance',async()=>{
  const {verifyWindowsComputerHelper}=await import('../scripts/verify-packaged.mjs');let call;
  const commandFor=()=>({file:'trusted-powershell',args:['-NoProfile','-EncodedCommand','fixture']});
  const run=(...args)=>{call=args;return {status:0,stdout:JSON.stringify({id:'package-status',ok:true,nativeReady:false,nativeValidation:'pending-windows-device',nativeReason:'COMPUTER_INPUT_BLOCKED'})};};
  const result=verifyWindowsComputerHelper('/staged',{}, {run,commandFor});assert.deepEqual(JSON.parse(call[2].input),{id:'package-status',action:'status'});assert.equal(result.statusProbePassed,true);assert.equal(result.nativeReady,false);assert.equal(result.nativeValidation,'pending-windows-device');
  assert.throws(()=>verifyWindowsComputerHelper('/staged',{}, {commandFor,run:()=>({status:1,stderr:'private environment detail'})}),/^Error: PACKAGED_WINDOWS_COMPUTER_FAILED$/);
  assert.throws(()=>verifyWindowsComputerHelper('/staged',{}, {commandFor,run:()=>({status:0,stdout:'not JSON'})}),/PACKAGED_WINDOWS_COMPUTER_PROTOCOL/);
});

test('Windows packaging verifies an existing native module under Electron before requiring a compiler',async()=>{
 const {prepareWindowsPty}=await import('../scripts/prepare-windows-pty.mjs');let captured;
 const result=await prepareWindowsPty({root:path.resolve('/client'),electron:'target-electron',electronVersion:'45.0.0',arch:'x64',run:(...args)=>{captured=args;return{status:0,stdout:'DSH_WINDOWS_PTY_PROBE_OK'};},rebuild:()=>assert.fail('verified native module needs no compiler')});
 assert.equal(result.nativeModule,'verified-prebuild-or-existing');assert.equal(captured[0],'target-electron');assert.equal(captured[2].env.ELECTRON_RUN_AS_NODE,'1');assert(captured[1].at(-1).includes('process.versions.electron'));assert(captured[1].at(-1).includes('manager.create'));
});

test('Windows packaging rebuilds failed prebuilds and rejects an unverified rebuilt module',async()=>{
 const {prepareWindowsPty}=await import('../scripts/prepare-windows-pty.mjs');let probes=0,builds=0;
 const options={root:path.resolve('/client'),electron:'target-electron',electronVersion:'45.0.0',arch:'x64',rebuild:async value=>{builds++;assert.equal(value.force,true);assert.deepEqual(value.onlyModules,['node-pty']);}};
 const result=await prepareWindowsPty({...options,run:()=>++probes===1?{status:1}:{status:0,stdout:'DSH_WINDOWS_PTY_PROBE_OK'}});assert.equal(result.nativeModule,'rebuilt-and-verified');assert.equal(builds,1);assert.equal(probes,2);
 await assert.rejects(prepareWindowsPty({...options,run:()=>({status:0,stdout:'no real success marker'})}),/WINDOWS_PTY_REBUILD_VERIFICATION_FAILED/);
});
