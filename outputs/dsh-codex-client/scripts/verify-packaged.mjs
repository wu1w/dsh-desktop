import {tmpdir} from 'node:os';
import {readFile,stat,access,mkdtemp,rm} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

export async function verifyPackagedApp(appPath,{expectedVersion,expectedCodexVersion,arch=process.arch}={}) {
  const contents=path.join(appPath,'Contents');
  const root=path.join(contents,'Resources/app');
  const required=[
    'server/model-providers.mjs','server/model-discovery.mjs','shared/model-providers.js','shared/model-provider-locales.js','native-engine/node_modules/@deepseek-ai/dsh-llm-pi-ai/package.json',
    'server/plugin-development.mjs','server/plugin-revisions.mjs','server/development-mcp.mjs','shared/development-tool.js','shared/development-locales.js','node_modules/zod/package.json',
    'server/session-programs.mjs','shared/session-programs.js','channel-runtime/compat/onboarding.py',
    'native-engine/lib/engine.js','native-engine/lib/runtime.js','native-engine/lib/provider.js','native-engine/package-lock.json','native-engine/NOTICE.md','server/shared-context.mjs','server/shared-engine.mjs','server/session-workspaces.mjs','shared/engine-locales.js','server/plugins/engine-dsh-native.mjs',
    'desktop/process-supervisor.cjs','desktop/reliability.cjs','desktop/main.cjs','desktop/preload.cjs','desktop/support.cjs','desktop/locales/zh-CN.json','desktop/locales/en.json',
    'server/engine-supervisor.mjs','server/task-recovery.mjs','shared/recovery-errors.js','server/index.mjs','server/plugin-host.mjs','server/data-directory.mjs','server/data-lock.mjs','server/event-clients.mjs','server/client-state.mjs','server/project-commands.mjs','server/session-history.mjs','server/document-drafts.mjs','server/git-drafts.mjs','server/files.mjs','server/resource-library.mjs','server/system-open.mjs','server/normalize.mjs','server/approvals.mjs','server/project-git.mjs','server/automation-runner.mjs','server/automations.mjs','server/project-pty.mjs','server/image-files.mjs','shared/image-errors.js','shared/mcp-elicitation.js','shared/mcp-elicitation-errors.js','native/bin/dsh-pty-helper','shared/local-tools-errors.js','shared/git-errors.js','shared/git-draft-errors.js','shared/file-errors.js','shared/plugin-errors.js','shell/index.html','shell/event-stream.js','shell/reconnect.js','shell/core.js','shell/core.css','shell/locales.js','shell/engine-providers.js','shell/recovery-view.js',
    'server/channel-manager.mjs','server/channel-process.mjs','server/channel-store.mjs','server/channel-plugin.mjs','shared/channel-locales.js','channel-runtime/bridge.py','channel-runtime/UPSTREAM.json','channel-runtime/vendor/hermes/LICENSE','channel-runtime/requirements.lock',
    'dist/index.html','dist/main.js','dist/main.css','package.json',
    'engine/lib/engine.js','engine/lib/plugin.js','engine/lib/deepseek-profile.js','engine/lib/jsonrpc-client.js','engine/lib/history-pages.js','engine/lib/turn-reconciler.js',
    'claude-engine/lib/engine.js','claude-engine/lib/plugin.js','claude-engine/lib/assistant-blocks.js','claude-engine/lib/policy.js',
    ...['engine-codex','engine-claude-code','appearance-codex','feature-projects','feature-chat','feature-files','feature-terminal','feature-integrations','feature-deepseek-profile','feature-git','feature-automations','feature-images','feature-mcp-forms','channel-feishu','channel-qq','channel-weixin','channel-dingtalk','channel-wecom'].map(name=>'server/plugins/'+name+'.mjs'),
  ];
  const files=[];
  for(const relative of required) {
    const target=path.join(root,relative);
    const bytes=await readFile(target);
    const metadata=await stat(target);
    if(!bytes.length)throw new Error('PACKAGED_RESOURCE_EMPTY: '+relative);
    if(relative.endsWith('.cjs'))new vm.Script(bytes.toString('utf8'),{filename:relative});
    files.push({path:relative,sha256:createHash('sha256').update(bytes).digest('hex'),mtime:metadata.mtime.toISOString(),bytes:bytes.length});
  }
  const manifest=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
  const frontend=await readFile(path.join(root,'dist/main.js'),'utf8');
  if(frontend.includes('react/cjs/react.development.js')||frontend.includes('react-dom/cjs/react-dom.development.js')||!frontend.includes('react-dom/cjs/react-dom.production.min.js'))throw new Error('PACKAGED_FRONTEND_DEVELOPMENT_RUNTIME');
  if(expectedVersion&&manifest.version!==expectedVersion)throw new Error('PACKAGED_VERSION_MISMATCH');
  const zod=JSON.parse(await readFile(path.join(root,'node_modules/zod/package.json'),'utf8'));if(zod.version!==manifest.dependencies.zod)throw Error('PACKAGED_PLUGIN_SCHEMA_VERSION_MISMATCH');
  const claudeSdk=JSON.parse(await readFile(path.join(root,'node_modules/@anthropic-ai/claude-agent-sdk/package.json'),'utf8'));
  if(claudeSdk.version!==manifest.dependencies['@anthropic-ai/claude-agent-sdk'])throw new Error('PACKAGED_CLAUDE_SDK_VERSION_MISMATCH');
  const plist=key=>{
    const result=spawnSync('/usr/libexec/PlistBuddy',['-c','Print :'+key,path.join(contents,'Info.plist')],{encoding:'utf8'});
    if(result.status!==0)throw new Error('PACKAGED_PLIST_INVALID: '+key);
    return result.stdout.trim();
  };
  const bundleId=plist('CFBundleIdentifier');
  const executable=plist('CFBundleExecutable');
  if(bundleId!=='com.deepseek.dsh.codex'||executable!=='DSH')throw new Error('PACKAGED_APP_ID_MISMATCH');
  await access(path.join(contents,'MacOS',executable),constants.X_OK);
  await access(path.join(root,'native/bin/dsh-pty-helper'),constants.X_OK);
  const helperArch=spawnSync('/usr/bin/lipo',['-archs',path.join(root,'native/bin/dsh-pty-helper')],{encoding:'utf8',timeout:5000});
  if(helperArch.status!==0||!helperArch.stdout.trim().split(/\s+/).includes(arch==='x64'?'x86_64':arch))throw new Error('PACKAGED_PTY_ARCH_MISMATCH');
  await access(path.join(contents,'Resources',plist('CFBundleIconFile')));
  const triples={arm64:'aarch64-apple-darwin',x64:'x86_64-apple-darwin'};
  if(!triples[arch])throw new Error('PACKAGED_UNSUPPORTED_ARCH');
  const binary=path.join(root,'node_modules',`@openai/codex-darwin-${arch}`,'vendor',triples[arch],'bin/codex');
  await access(binary,constants.X_OK);
  // Version invocation is local and never starts an inference or reads the
  // original Codex application's login or history.
  const version=spawnSync(binary,['--version'],{encoding:'utf8',timeout:10000,env:{PATH:'/usr/bin:/bin'}});
  if(version.status!==0||!version.stdout.includes(expectedCodexVersion??manifest.dependencies['@openai/codex']))throw new Error('PACKAGED_ENGINE_VERSION_MISMATCH');
  const moduleUrls=['server/index.mjs','native-engine/lib/engine.js',...required.filter(relative=>relative.startsWith('server/plugins/'))].map(relative=>pathToFileURL(path.join(root,relative)).href);
  const dependencyProbe=spawnSync(process.execPath,['--input-type=module','-e',`await Promise.all(${JSON.stringify(moduleUrls)}.map(url=>import(url)))`],{encoding:'utf8',timeout:15000});
  if(dependencyProbe.status!==0)throw new Error('PACKAGED_DEPENDENCY_CHECK_FAILED\n'+dependencyProbe.stderr);
  const channelRoot=path.join(root,'channel-runtime'),upstream=JSON.parse(await readFile(path.join(channelRoot,'UPSTREAM.json'),'utf8'));
  for(const file of upstream.files){const bytes=await readFile(path.join(channelRoot,'vendor/hermes',file.path));if(createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw Error('PACKAGED_CHANNEL_UPSTREAM_MISMATCH: '+file.path);}
  const channelHome=await mkdtemp(path.join(tmpdir(),'dsh-packaged-channel-'));
  let pythonVersion;
  try{
    const python=path.join(channelRoot,'python/runtime/bin/python3');await access(python,constants.X_OK);
    const probe=spawnSync(python,['-I','-B','-c',`import sys,asyncio;sys.path.insert(0,sys.argv[1]);import bridge
async def check():
 for platform in ['feishu','qq','weixin','dingtalk','wecom']:
  b=bridge.Bridge();b.configure({'platform':platform,'extra':{'allow_from':['fixture']}});await b.close()
asyncio.run(check())
bridge.WIRE.write(sys.version.split()[0])`,channelRoot],{encoding:'utf8',timeout:30000,env:{PATH:'/usr/bin:/bin',HOME:channelHome,DSH_CHANNEL_HOME:channelHome,DSH_LOCALE:'en'}});
    if(probe.status!==0)throw Error('PACKAGED_CHANNEL_RUNTIME_FAILED: '+probe.stderr);pythonVersion=probe.stdout.trim().split('\n').at(-1);if(!/^3\.12\.\d+$/.test(pythonVersion))throw Error('PACKAGED_CHANNEL_PYTHON_VERSION');
  }finally{await rm(channelHome,{recursive:true,force:true});}
  const nativeLoop=JSON.parse(await readFile(path.join(root,'native-engine/node_modules/@deepseek-ai/dsh-agent-loop/package.json'),'utf8'));if(nativeLoop.version!=='0.2.1-rc.2')throw Error('PACKAGED_NATIVE_ENGINE_VERSION');
  const signature=spawnSync('/usr/bin/codesign',['--verify','--deep','--strict',appPath],{encoding:'utf8',timeout:15000});
  return {checkedAt:new Date().toISOString(),appPath,bundleId,executable,version:manifest.version,arch,frontendMode:'production',channelRuntime:{pythonVersion,upstream:upstream.commit,verifiedFiles:upstream.files.length,platforms:['feishu','qq','weixin','dingtalk','wecom']},engineVersion:version.stdout.trim(),nativeEngineVersion:nativeLoop.version,claudeSdkVersion:claudeSdk.version,claudeCliBundled:false,signatureVerified:signature.status===0,files};
}

if(process.argv[1]&&path.resolve(process.argv[1])===new URL(import.meta.url).pathname) {
  if(!process.argv[2])throw new Error('PACKAGED_APP_PATH_REQUIRED');
  console.log(JSON.stringify(await verifyPackagedApp(path.resolve(process.argv[2])),null,2));
}
