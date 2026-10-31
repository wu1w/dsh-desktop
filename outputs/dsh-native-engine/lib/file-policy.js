// Shared DSH file boundary policy, adapted from the sibling Claude adapter.
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';

export const FILE_TOOLS = ['Read', 'Glob', 'Grep', 'Write', 'Edit'];
export const WRITES = new Set(['Write', 'Edit']);
export const isInside = (target, root) => { const relative = path.relative(root, target); return relative === '' || (!relative.startsWith('..'+path.sep) && relative !== '..' && !path.isAbsolute(relative)); };
export async function canonical(target) {
  try { return await realpath(target); }
  catch (error) { if (error.code !== 'ENOENT') throw error; const parent = path.dirname(target); if (parent === target) throw error; return path.join(await canonical(parent), path.basename(target)); }
}
export async function checkTool({name,input,cwd,configDir,dataDir,sandbox}) {
  if (!FILE_TOOLS.includes(name)) return {allowed:false,reason:'tool_denied'};
  if (WRITES.has(name) && sandbox === 'read-only') return {allowed:false,reason:'readonly'};
  const value = input.file_path ?? input.path ?? cwd;
  if (typeof value !== 'string' || value.includes('\0')) return {allowed:false,reason:'path_denied'};
  if (name === 'Glob' && (typeof input.pattern !== 'string' || path.isAbsolute(input.pattern) || /(?:^|\/)\.\.(?:\/|$)|\\/.test(input.pattern))) return {allowed:false,reason:'path_denied'};
  if (name === 'Grep' && typeof input.glob === 'string' && (path.isAbsolute(input.glob) || /(?:^|\/)\.\.(?:\/|$)|\\/.test(input.glob))) return {allowed:false,reason:'path_denied'};
  const target = await canonical(path.resolve(cwd, value));
  const root = await canonical(cwd);
  const protectedRoots = [dataDir,configDir,...['.dsh','.claude','.codex','.ssh'].map(value=>path.join(homedir(),value))].filter(Boolean);
  for (const protectedRoot of protectedRoots) if (isInside(target,await canonical(protectedRoot))) return {allowed:false,reason:'path_denied'};
  if (!isInside(target,root)) return {allowed:false,reason:'path_denied'};
  return {allowed:true,write:WRITES.has(name),target};
}
