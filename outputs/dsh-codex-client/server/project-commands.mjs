import { spawn } from 'node:child_process';
import {windowsEnvironment,windowsShell,windowsCommandArgs,windowsJobCommand,stopWindowsJob} from './windows-process.mjs';

const executions = new WeakMap();
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const stopFault = cause => Object.assign(new Error('COMMAND_STOP_FAILED', { cause }), { code: 'COMMAND_STOP_FAILED' });
async function waitUntil(check, milliseconds) {
  const deadline = Date.now() + milliseconds;
  while (!check()) {
    if (Date.now() >= deadline) return false;
    await delay(Math.min(20, Math.max(1, deadline - Date.now())));
  }
  return true;
}
function groupExists(child) {
  if (!child.pid) return false;
  try { process.kill(-child.pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; if (error.code === 'EPERM') return true; throw error; }
}
function signalGroup(child, signal) {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}
export function stopProjectCommand(child) {
  const execution = executions.get(child);
  if (!execution) return Promise.resolve();
  if (execution.stopping) return execution.stopping;
  const stopping = (async () => {
    try {
      // The leader may have exited while background descendants redirected their
      // pipes. Its close event alone does not mean that the process group is gone.
      if(execution.platform==='win32'){
        if(!execution.doneSettled){try{await execution.stopJob(execution.stopEvent,{env:execution.environment});}catch(error){if(!execution.doneSettled)throw error;}}
      }else if (groupExists(child)) {
        signalGroup(child, 'SIGTERM');
        if (!await waitUntil(() => !groupExists(child), execution.killGraceMs)) {
          signalGroup(child, 'SIGKILL');
          // Allow the OS a bounded interval to reap adopted descendants.
          if (!await waitUntil(() => !groupExists(child), 1000)) throw stopFault();
        }
      }
      // A descendant can escape its group while retaining an inherited pipe. Do
      // not wait forever for close, or discard ownership when it cannot be proved.
      if (!await waitUntil(() => execution.doneSettled, 1000)) throw stopFault();
      execution.commands.delete(child); executions.delete(child);
    } catch (cause) {
      const error = cause.code === 'COMMAND_STOP_FAILED' ? cause : stopFault(cause);
      execution.rejectStop(error);
      throw error;
    }
  })();
  execution.stopping = stopping;
  void stopping.finally(() => {
    if (execution.stopping === stopping) execution.stopping = null;
  }).catch(() => {});
  return stopping;
}
export async function stopProjectCommands(commands) {
  const stopped = await Promise.allSettled([...commands].map(stopProjectCommand));
  const failure = stopped.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
}
export async function runProjectCommand({ command, cwd, commands, shell, platform=process.platform, env=process.env, spawnProcess=spawn, stopJob=stopWindowsJob, timeoutMs = 30000, killGraceMs = 1000, maxOutputBytes = 1024 * 1024 }) {
  shell??=platform==='win32'?windowsShell(env):env.SHELL||'/bin/zsh';
  const environment = platform==='win32'?windowsEnvironment(env):Object.fromEntries(['PATH', 'HOME', 'USER', 'LANG', 'TMPDIR', 'SHELL', 'TERM'].filter(key => env[key]).map(key => [key, env[key]]));
  const launch=platform==='win32'?windowsJobCommand(shell,windowsCommandArgs(shell,command),{env:environment}):{file:shell,args:['-c',command]};
  const child = spawnProcess(launch.file,launch.args, { cwd, env: environment, detached: platform!=='win32', windowsHide:true, stdio: ['ignore', 'pipe', 'pipe'] });
  let size = 0;
  const chunks = [];
  const append = chunk => {
    if (size >= maxOutputBytes) return;
    const bytes = Buffer.from(chunk).subarray(0, maxOutputBytes - size);
    chunks.push(bytes); size += bytes.length;
  };
  child.stdout.on('data', append); child.stderr.on('data', append);
  const done = new Promise((resolve, reject) => {
    child.once('error', error=>reject(platform==='win32'?Object.assign(Error('COMMAND_START_FAILED',{cause:error}),{code:'COMMAND_START_FAILED'}):error));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  let rejectStop;
  const stopFailed = new Promise((resolve, reject) => { rejectStop = reject; });
  const execution = { done, killGraceMs, commands, doneSettled: false, rejectStop,platform,environment,stopJob,stopEvent:launch.stopEvent };
  void done.then(() => { execution.doneSettled = true; }, () => { execution.doneSettled = true; });
  executions.set(child, execution); commands.add(child);
  const timeout = setTimeout(() => { void stopProjectCommand(child).catch(() => {}); }, timeoutMs);
  let failedStop = false;
  try { const result=await Promise.race([done,stopFailed]);const output=Buffer.concat(chunks).toString('utf8');if(platform==='win32'&&result.code===125&&output.includes('DSH_WINDOWS_JOB_FAILED'))throw Object.assign(Error('COMMAND_START_FAILED'),{code:'COMMAND_START_FAILED'});return {...result,output}; }
  catch (error) { failedStop = error.code === 'COMMAND_STOP_FAILED'; throw error; }
  finally {
    clearTimeout(timeout);
    if (!failedStop) await stopProjectCommand(child);
  }
}
