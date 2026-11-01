import { mkdir, chmod, rename, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const run = promisify(execFile);
export async function buildPtyHelper({ appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') } = {}) {
  // Windows 上没有 POSIX PTY 辅助程序；跳过而不是中断整个构建。
  if (process.platform !== 'darwin') return null;
  const target = path.join(appRoot,'native/bin/dsh-pty-helper');
  await mkdir(path.dirname(target),{recursive:true});
  const temporary = target+'.'+process.pid+'.tmp';
  try {
    await run('/usr/bin/clang',['-std=c11','-O2','-Wall','-Wextra','-Werror',path.join(appRoot,'native/pty-helper.c'),'-o',temporary],{timeout:30000});
    await chmod(temporary,0o755); await rename(temporary,target);
  } finally {await rm(temporary,{force:true});}
  return target;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(await buildPtyHelper());
