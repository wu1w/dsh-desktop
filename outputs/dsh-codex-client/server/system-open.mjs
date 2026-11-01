import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const fault = code => Object.assign(new Error(code), { code });
const environmentKeys = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'XDG_CURRENT_DESKTOP', 'XDG_SESSION_TYPE', 'DBUS_SESSION_BUS_ADDRESS'];
function launcherEnvironment() {
  const env = {};
  for (const key of environmentKeys) {
    const value = process.env[key];
    if (typeof value === 'string' && value.length <= 32768 && !value.includes('\0')) env[key] = value;
  }
  return env;
}

// Resolves when the launcher exits, not when an application window appears.
// Injection is an in-process constructor seam for tests, never an env override.
export class SystemOpener {
  constructor({ spawnImpl = spawn, platform = process.platform, timeoutMs = 10000, maxConcurrent = 4, killGraceMs = 150, cleanupWaitMs = 1000, stderrLimitBytes = 16384 } = {}) {
    if (typeof spawnImpl !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000 ||
        !Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 32 ||
        !Number.isInteger(killGraceMs) || killGraceMs < 1 || killGraceMs > 5000 ||
        !Number.isInteger(cleanupWaitMs) || cleanupWaitMs < 1 || cleanupWaitMs > 10000 ||
        !Number.isInteger(stderrLimitBytes) || stderrLimitBytes < 1 || stderrLimitBytes > 65536) throw fault('FILE_OPEN_FAILED');
    this.spawn = spawnImpl;
    this.platform = platform;
    // Windows 没有 open/xdg-open，用 cmd 的 start；注意 start 首个参数是窗口标题。
    this.command = platform === 'darwin' ? '/usr/bin/open' : platform === 'linux' ? 'xdg-open' : platform === 'win32' ? 'cmd.exe' : null;
    this.timeoutMs = timeoutMs;
    this.maxConcurrent = maxConcurrent;
    this.killGraceMs = killGraceMs;
    this.cleanupWaitMs = cleanupWaitMs;
    this.stderrLimitBytes = stderrLimitBytes;
    this.operations = new Map();
    this.closed = false;
  }

  async open(target, { signal, projectId } = {}) {
    if (this.closed) throw fault('FILE_OPEN_CLOSED');
    if (!this.command) throw fault('FILE_OPEN_UNAVAILABLE');
    if (typeof target !== 'string' || !path.isAbsolute(target) || target.includes('\0') || Buffer.byteLength(target) > 32768) throw fault('FILE_OPEN_INVALID_PATH');
    if (signal?.aborted) throw fault('FILE_OPEN_CANCELLED');
    if (this.operations.size >= this.maxConcurrent) throw fault('FILE_OPEN_BUSY');
    let release;
    const operation = { id: randomUUID(), projectId, child: null, stderrBytes: 0, done: new Promise(resolve => { release = resolve; }) };
    this.operations.set(operation.id, operation);
    return new Promise((resolve, reject) => {
      let finished = false, requestSettled = false, failure = null, timeout, killTimer, cleanupTimer;
      const abort = () => stop('FILE_OPEN_CANCELLED');
      const finish = (code, exitSignal) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout); clearTimeout(killTimer); clearTimeout(cleanupTimer);
        signal?.removeEventListener('abort', abort);
        this.operations.delete(operation.id);
        release(null);
        if (requestSettled) return;
        requestSettled = true;
        if (failure) reject(fault(failure));
        else if (code === 0 && !exitSignal) resolve({ ok: true, accepted: true });
        else reject(fault('FILE_OPEN_FAILED'));
      };
      const kill = kind => {
        // Never kill by application name, process group or an unrelated PID.
        // The operating system may already have handed off to a user app.
        try { operation.child?.kill(kind); } catch { /* close/error remains authoritative */ }
      };
      const stop = code => {
        if (finished || failure) return;
        failure = code;
        kill('SIGTERM');
        killTimer = setTimeout(() => kill('SIGKILL'), this.killGraceMs);
        cleanupTimer = setTimeout(() => {
          if (finished || requestSettled) return;
          requestSettled = true;
          clearTimeout(timeout);
          signal?.removeEventListener('abort', abort);
          // An unconfirmed exit is an explicit error. Keep the operation
          // visible until a real late exit, rather than claiming cleanup.
          release('FILE_OPEN_CLEANUP_FAILED');
          reject(fault('FILE_OPEN_CLEANUP_FAILED'));
        }, this.killGraceMs + this.cleanupWaitMs);
      };
      operation.cancel = () => stop('FILE_OPEN_CANCELLED');
      try {
        const args = this.platform === 'win32' ? ['/c', 'start', '""', target] : [target];
        const child = this.spawn(this.command, args, { stdio: ['ignore', 'ignore', 'pipe'], shell: false, windowsHide: true, env: launcherEnvironment() });
        operation.child = child;
        child.once('error', error => {
          const code = ['ENOENT', 'EACCES', 'EPERM'].includes(error?.code) ? 'FILE_OPEN_UNAVAILABLE' : 'FILE_OPEN_FAILED';
          if (!child.pid) { failure = code; finish(null, null); }
          else stop(code);
        });
        child.once('exit', (code, exitSignal) => { child.stderr?.destroy(); finish(code, exitSignal); });
        child.once('close', finish);
        // Drain stderr without retaining or returning any launcher text. Even
        // very noisy launchers leave only a bounded byte counter in memory.
        child.stderr?.on('data', chunk => { operation.stderrBytes = Math.min(this.stderrLimitBytes + 1, operation.stderrBytes + Buffer.byteLength(chunk)); });
        child.stderr?.once('error', () => stop('FILE_OPEN_FAILED'));
        timeout = setTimeout(() => stop('FILE_OPEN_TIMEOUT'), this.timeoutMs);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      } catch (error) { failure = ['ENOENT', 'EACCES', 'EPERM'].includes(error?.code) ? 'FILE_OPEN_UNAVAILABLE' : 'FILE_OPEN_FAILED'; finish(null, null); }
    });
  }

  async close() {
    this.closed = true;
    const operations = [...this.operations.values()];
    for (const operation of operations) operation.cancel();
    const results = await Promise.all(operations.map(operation => operation.done));
    if (results.some(Boolean)) throw fault('FILE_OPEN_CLEANUP_FAILED');
  }
}
