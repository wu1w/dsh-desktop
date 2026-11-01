import {buildComputerHelper} from './build-computer.mjs';
await buildComputerHelper();
import { build } from 'esbuild';
import { mkdir, copyFile, cp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {buildPtyHelper} from './build-pty.mjs';
await buildPtyHelper();
const engine = new URL('../../dsh-codex-engine/', import.meta.url);
// These directories contain generated runtime copies only. Clean them before
// copying so a removed source file cannot survive in a later application.
await rm(new URL('../engine/', import.meta.url), { recursive: true, force: true, maxRetries:3, retryDelay:100 });
await rm(new URL('../claude-engine/', import.meta.url), { recursive: true, force: true, maxRetries:3, retryDelay:100 });
for (const entry of ['lib', 'locale', 'package.json']) await cp(new URL(entry, engine), new URL('../engine/' + entry, import.meta.url), { recursive: true });
await mkdir(new URL('../dist/', import.meta.url), { recursive: true });
// Ship the production React runtime. Keep application names/source maps useful
// for local diagnostics; that does not require development React checks.
await build({ entryPoints: [fileURLToPath(new URL('../src/main.jsx', import.meta.url))], bundle: true, outdir: fileURLToPath(new URL('../dist/', import.meta.url)), minify: false, sourcemap: true, define:{'process.env.NODE_ENV':'"production"'}, format:'esm', jsx: 'automatic', loader: { '.svg': 'dataurl' }, target: 'chrome130' });
await copyFile(new URL('../src/index.html', import.meta.url), new URL('../dist/index.html', import.meta.url));

try { await cp(new URL('../../dsh-claude-engine/',import.meta.url),new URL('../claude-engine/',import.meta.url),{recursive:true,filter:source=>!source.includes('/node_modules/')&&!source.endsWith('/node_modules')&&!source.includes('/test/')&&!source.endsWith('/test')}); } catch(error) { if(error.code!=='ENOENT')throw error; }

const channelSource = new URL('../../dsh-channel-runtime/',import.meta.url);
await rm(new URL('../channel-runtime/',import.meta.url),{recursive:true,force:true,maxRetries:3,retryDelay:100});
await cp(channelSource,new URL('../channel-runtime/',import.meta.url),{recursive:true,verbatimSymlinks:true,filter:source=>!source.split('/').some(part=>['__pycache__','.temp','tests'].includes(part))&&!source.endsWith('.pyc')&&!source.endsWith('.o')&&!source.endsWith('/.DS_Store')});

// Ship the pinned native Harness runtime with its own dependency tree.
const nativeSource=new URL('../../dsh-native-engine/',import.meta.url);
await rm(new URL('../native-engine/',import.meta.url),{recursive:true,force:true,maxRetries:3,retryDelay:100});
await cp(nativeSource,new URL('../native-engine/',import.meta.url),{recursive:true,verbatimSymlinks:true,filter:source=>!source.startsWith(new URL('test/',nativeSource).pathname)&&!source.endsWith('/.DS_Store')});
