import { packager } from '@electron/packager';
import { readFile,writeFile,chmod,copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {createRequire} from 'node:module';
const {launcherScript}=createRequire(import.meta.url)('../desktop/process-supervisor.cjs');
import {verifyPackagedApp} from './verify-packaged.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const manifest=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
const paths=await packager({dir:root,name:'DSH',appBundleId:'com.deepseek.dsh.codex',appVersion:manifest.version,executableName:'DSH',platform:'darwin',arch:process.arch,electronVersion:manifest.devDependencies.electron,out:path.resolve(root,'../DSH-desktop'),icon:path.join(root,'assets-icon.icns'),asar:false,prune:true,overwrite:true,ignore:[/^\/reference(?:\/|$)/,/^\/src(?:\/|$)/,/^\/test(?:\/|$)/,/^\/scripts(?:\/|$)/,/^\/\.local-data(?:\/|$)/,/\.log$/]});
const reports=[];
for(const packaged of paths){
  // Electron Packager omits dependency lockfiles by default; retain native provenance.
  await copyFile(path.join(root,'native-engine/package-lock.json'),path.join(packaged,'DSH.app/Contents/Resources/app/native-engine/package-lock.json'));
  reports.push(await verifyPackagedApp(path.join(packaged,'DSH.app'),{expectedVersion:manifest.version,expectedCodexVersion:manifest.dependencies['@openai/codex']}));
}
const launcher=path.resolve(root,'../DSH-desktop/DSH-长期运行.command');
await writeFile(launcher,launcherScript(path.relative(path.dirname(launcher),path.join(paths[0],'DSH.app'))),{mode:0o755});await chmod(launcher,0o755);
await writeFile(path.resolve(root,'../DSH-desktop/package-verification.json'),JSON.stringify({packages:reports},null,2)+'\n',{mode:0o600});
console.log(paths.join('\n'));
