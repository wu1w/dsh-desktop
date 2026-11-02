import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {resolveClaudeBinary} from '../lib/cli-binary.js';

test('Windows bundled CLI follows target architecture and returns absolute executable',()=>{
 const target='C:\\DSH\\node_modules\\@anthropic-ai\\claude-agent-sdk-win32-arm64\\claude.exe';const checked=[];
 assert.equal(resolveClaudeBinary({platform:'win32',arch:'arm64',appRoot:'C:\\DSH',home:'C:\\Users\\Test',env:{},isExecutable:p=>{checked.push(p);return p===target;}}),target);assert(!checked.some(p=>p.includes('win32-x64')));
});
test('PATH resolution is case insensitive on Windows, supports spaces and ignores relative/batch entries',()=>{
 const target='C:\\Program Files\\Claude\\claude.exe';assert.equal(resolveClaudeBinary({platform:'win32',arch:'x64',home:'C:\\Users\\Test',env:{Path:'relative;;"C:\\Program Files\\Claude"',PATHEXT:'.CMD;.EXE'},binary:'claude',isExecutable:p=>p===target}),target);
 assert.throws(()=>resolveClaudeBinary({platform:'win32',home:'C:\\Users\\Test',binary:'claude',env:{Path:'C:\\tools',PATHEXT:'.CMD'},isExecutable:()=>true}),{code:'CLAUDE_CLI_NOT_FOUND'});
});
test('macOS CLI can resolve bundled SDK before home and PATH',()=>{
 const target='/app/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude';assert.equal(resolveClaudeBinary({platform:'darwin',arch:'arm64',appRoot:'/app',home:'/isolated',env:{PATH:'/bin'},isExecutable:p=>p===target}),target);
});
test('real temp executable on PATH resolves without running it; missing/non executable is explicit',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'dsh-cli-path-'));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(path.join(root,'bin'));const cli=path.join(root,'bin',process.platform==='win32'?'claude.exe':'claude');await writeFile(cli,'#!/bin/sh\nexit 0\n',{mode:0o700});assert.equal(resolveClaudeBinary({platform:process.platform,home:root,binary:'claude',env:{PATH:path.dirname(cli)}}),cli);
 assert.throws(()=>resolveClaudeBinary({platform:process.platform,home:root,binary:'missing',env:{PATH:path.dirname(cli)}}),{code:'CLAUDE_CLI_NOT_FOUND'});
});

test('Windows child environment keeps required OS paths but excludes inherited account tokens',async()=>{
 const {childEnvironment}=await import('../lib/policy.js');const env=childEnvironment({baseEnv:{Path:'C:\\tools',SystemRoot:'C:\\Windows',USERPROFILE:'C:\\Users\\Test',TEMP:'C:\\Temp',CLAUDE_CODE_OAUTH_TOKEN:'old-private',ANTHROPIC_API_KEY:'old-private'},configDir:'C:\\isolated',key:'local-proxy-token',model:'fixture'});
 assert.equal(env.PATH,'C:\\tools');assert.equal(env.SystemRoot,'C:\\Windows');assert.equal(env.USERPROFILE,'C:\\Users\\Test');assert.equal(env.TEMP,'C:\\Temp');assert(!JSON.stringify(env).includes('old-private'));
});
