import {packager} from '@electron/packager';
import {readFile,writeFile,chmod,copyFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createRequire} from 'node:module';
import {verifyPackagedApp} from './verify-packaged.mjs';
import {packagingTarget,windowsInstallerConfig} from './packaging-config.mjs';
const {launcherScript}=createRequire(import.meta.url)('../desktop/process-supervisor.cjs');
const root=fileURLToPath(new URL('../',import.meta.url));
const manifest=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
const {platform,arch}=packagingTarget();
if(platform==='win32') {
  const {prepareWindowsPty}=await import('./prepare-windows-pty.mjs');
  const electron=createRequire(import.meta.url)('electron');
  console.log('[DSH package] '+JSON.stringify(await prepareWindowsPty({root,electron,electronVersion:manifest.devDependencies.electron,arch})));
}
const paths=await packager({dir:root,name:'DSH',appBundleId:'com.deepseek.dsh.codex',appVersion:manifest.version,executableName:'DSH',platform,arch,electronVersion:manifest.devDependencies.electron,out:path.resolve(root,'../DSH-desktop'),icon:path.join(root,platform==='win32'?'assets/icon.ico':'assets-icon.icns'),asar:false,prune:true,overwrite:true,ignore:[/^\/reference(?:\/|$)/,/^\/src(?:\/|$)/,/^\/test(?:\/|$)/,/^\/scripts(?:\/|$)/,/^\/\.local-data(?:\/|$)/,/\.log$/]});
const reports=[];
for(const packaged of paths){
  const appPath=platform==='darwin'?path.join(packaged,'DSH.app'):packaged;
  const appRoot=platform==='darwin'?path.join(appPath,'Contents/Resources/app'):path.join(appPath,'resources/app');
  await copyFile(path.join(root,'native-engine/package-lock.json'),path.join(appRoot,'native-engine/package-lock.json'));
  reports.push(await verifyPackagedApp(appPath,{platform,arch,expectedVersion:manifest.version,expectedCodexVersion:manifest.dependencies['@openai/codex']}));
}
let installers=[];
if(platform==='darwin') {
  const launcher=path.resolve(root,'../DSH-desktop/DSH-长期运行.command');
  await writeFile(launcher,launcherScript(path.relative(path.dirname(launcher),path.join(paths[0],'DSH.app'))),{mode:0o755});await chmod(launcher,0o755);
} else {
  // No installer is emitted until its staged runtime has passed verification.
  const {build,Platform,Arch}=await import('electron-builder');
  installers=await build({projectDir:root,prepackaged:paths[0],targets:Platform.WINDOWS.createTarget('nsis',Arch.x64),publish:'never',config:windowsInstallerConfig(root,manifest)});
}
await writeFile(path.resolve(root,`../DSH-desktop/package-verification-${platform}-${arch}.json`),JSON.stringify({packages:reports,installers},null,2)+'\n',{mode:0o600});
console.log([...paths,...installers].join('\n'));
