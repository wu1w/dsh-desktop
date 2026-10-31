import { spawn } from 'node:child_process';

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
      if (groupExists(child)) {
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
export async function runProjectCommand({ command, cwd, commands, shell = process.env.SHELL || '/bin/zsh', timeoutMs = 30000, killGraceMs = 1000, maxOutputBytes = 1024 * 1024 }) {
  const environment = Object.fromEntries(['PATH', 'HOME', 'USER', 'LANG', 'TMPDIR', 'SHELL', 'TERM'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  const child = spawn(shell, ['-c', command], { cwd, env: environment, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let size = 0;
  const chunks = [];
  const append = chunk => {
    if (size >= maxOutputBytes) return;
    const bytes = Buffer.from(chunk).subarray(0, maxOutputBytes - size);
    chunks.push(bytes); size += bytes.length;
  };
  child.stdout.on('data', append); child.stderr.on('data', append);
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  let rejectStop;
  const stopFailed = new Promise((resolve, reject) => { rejectStop = reject; });
  const execution = { done, killGraceMs, commands, doneSettled: false, rejectStop };
  void done.then(() => { execution.doneSettled = true; }, () => { execution.doneSettled = true; });
  executions.set(child, execution); commands.add(child);
  const timeout = setTimeout(() => { void stopProjectCommand(child).catch(() => {}); }, timeoutMs);
  let failedStop = false;
  try { return { ...await Promise.race([done, stopFailed]), output: Buffer.concat(chunks).toString('utf8') }; }
  catch (error) { failedStop = error.code === 'COMMAND_STOP_FAILED'; throw error; }
  finally {
    clearTimeout(timeout);
    if (!failedStop) await stopProjectCommand(child);
  }
}
