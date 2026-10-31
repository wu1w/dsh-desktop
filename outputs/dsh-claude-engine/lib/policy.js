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

export function childEnvironment({baseEnv=process.env,configDir,key,model,baseUrl}) {
  const env={};
  for(const name of ['PATH','HOME','USER','LOGNAME','TMPDIR','LANG','LC_ALL','SHELL','TERM','SystemRoot']) if(baseEnv[name]) env[name]=baseEnv[name];
  return {...env,CLAUDE_CONFIG_DIR:configDir,ANTHROPIC_BASE_URL:baseUrl??'https://opencode.ai/inference/go/anthropic',ANTHROPIC_AUTH_TOKEN:key,ANTHROPIC_DEFAULT_OPUS_MODEL:model,ANTHROPIC_DEFAULT_SONNET_MODEL:model,ANTHROPIC_DEFAULT_HAIKU_MODEL:model,CLAUDE_CODE_SUBAGENT_MODEL:model,CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_TELEMETRY:'1',DISABLE_ERROR_REPORTING:'1',CLAUDE_AGENT_SDK_CLIENT_APP:'dsh-claude-engine/0.1.0'};
}
