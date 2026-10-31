import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";
import { ClientClosed } from "./errors.js";
import { redactText } from "./redact.js";

export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_DENIED = -32001;

export const RECOGNIZED_SERVER_METHODS = [
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/tool/requestUserInput",
  "item/permissions/requestApproval",
  "item/tool/call",
  "mcpServer/elicitation/request",
  "applyPatchApproval",
  "execCommandApproval",
];

const RECOGNIZED = new Set(RECOGNIZED_SERVER_METHODS);

export function safeDenyResult(method) {
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return { decision: "decline" };
    case "mcpServer/elicitation/request":
      return { action: "decline", content: null, _meta: null };
    case "applyPatchApproval":
    case "execCommandApproval":
      return { decision: { denied: { rejection: "denied" } } };
    case "item/tool/call":
      return { success: false, contentItems: [{ type: "inputText", text: "denied" }] };
    default:
      return null;
  }
}

const CLIENT_INFO = {
  name: "dsh_codex_engine",
  title: "DSH Codex Engine",
  version: "0.1.0",
};

export class AppServerClient extends EventEmitter {
  constructor(options) {
    super();
    this.setMaxListeners(50);
    this.binary = options.binary;
    this.args = options.args ?? ["app-server"];
    this.cwd = options.cwd ?? undefined;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.maxLineBytes = options.maxLineBytes ?? 1024 * 1024;
    this.stderrEventCap = options.stderrEventCap ?? 8192;
    this.stderrTotalCap = options.stderrTotalCap ?? 65_536;
    this.secretValues = [...(options.secretValues ?? [])];
    this._env = options.env;
    this.handlers = new Map();
    this.pending = new Map();
    this.serverRequests = new Map();
    this.child = null;
    this.buffer = "";
    this._stdoutDecoder = new StringDecoder("utf8");
    this.skipping = false;
    this.disposed = false;
    this.ready = false;
    this.nextId = 1;
    this.stderrBytes = 0;
    this.stderrBuffer = "";
    this.initResult = null;
    this._onStdout = (chunk) => this._consumeStdout(chunk);
    this._onStderr = (chunk) => this._consumeStderr(chunk);
    this._onStdinError = () => { this.ready = false; this.failAll(new ClientClosed("STDIN")); void this._stopChild(); };
    this._onSpawnError = (error) => {
      this.ready = false;
      this._cancelServerRequests();
      this.failAll(new ClientClosed("SPAWN_FAILED", { spawnCode: error?.code ?? "" }));
      this.emit("exit", { code: null, signal: null, spawnCode: error?.code ?? "" });
    };
    this._onExit = (code, signal) => {
      this.ready = false;
      this.child = null;
      this._cancelServerRequests();
      if (!this.disposed) this.failAll(new ClientClosed("PROCESS_EXIT"));
      this.emit("exit", { code, signal });
    };
  }

  get pid() {
    return this.child?.pid ?? null;
  }

  setHandler(method, handler) {
    this.handlers.set(method, handler);
  }

  async start() {
    if (this.ready) return this.initResult;
    if (this.disposed) throw new ClientClosed("DISPOSED");
    this._spawn();
    try {
      const result = await this.request("initialize", {
        clientInfo: CLIENT_INFO,
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
        },
      });
      this.notify("initialized");
      this.ready = true;
      this.initResult = result;
      return result;
    } catch (error) {
      await this.dispose();
      throw error;
    }
  }

  request(method, params = {}, options = {}) {
    if (this.disposed) return Promise.reject(new ClientClosed("DISPOSED"));
    if (!this.child?.stdin?.writable) return Promise.reject(new ClientClosed("NOT_RUNNING"));
    if (!this.ready && method !== "initialize") return Promise.reject(new ClientClosed("NOT_READY"));
    const id = this.nextId++;
    const timeoutMs = options.timeoutMs === undefined ? this.requestTimeoutMs : options.timeoutMs;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, result) => {
        if (settled) return;
        const entry = this.pending.get(id);
        if (!entry) return;
        settled = true;
        this.pending.delete(id);
        if (entry.timer) clearTimeout(entry.timer);
        if (entry.signal) entry.signal.removeEventListener("abort", entry.onAbort);
        if (error) reject(error);
        else resolve(result);
      };
      const onAbort = () => finish(new ClientClosed("ABORTED"));
      const signal = options.signal ?? null;
      if (signal?.aborted) {
        reject(new ClientClosed("ABORTED"));
        return;
      }
      const timer = timeoutMs == null
        ? null
        : setTimeout(() => finish(new ClientClosed("TIMEOUT")), timeoutMs);
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, { method, finish, timer, signal, onAbort });
      try {
        this._write({ jsonrpc: "2.0", id, method, params });
      } catch {
        finish(new ClientClosed("WRITE_FAILED"));
      }
    });
  }

  notify(method, params) {
    const message = { jsonrpc: "2.0", method };
    if (params !== undefined) message.params = params;
    this._write(message);
  }

  respond(id, result) {
    if (this.disposed) return;
    try {
      this._write({ jsonrpc: "2.0", id, result });
    } catch {
      this.emit("protocol-error", { code: "WRITE_FAILED" });
    }
  }

  respondError(id, code, message) {
    if (this.disposed) return;
    try {
      this._write({ jsonrpc: "2.0", id, error: { code, message } });
    } catch {
      this.emit("protocol-error", { code: "WRITE_FAILED" });
    }
  }

  failAll(error) {
    for (const entry of [...this.pending.values()]) entry.finish(error);
  }

  async dispose() {
    if (this.disposal) return this.disposal;
    this.disposal = this._dispose();
    return this.disposal;
  }

  async _dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.ready = false;
    this.failAll(new ClientClosed("DISPOSED"));
    this._cancelServerRequests();
    this.handlers.clear();
    const child = this.child;
    if (child) {
      child.stdout?.off("data", this._onStdout);
      child.stderr?.off("data", this._onStderr);
      child.stdin?.off("error", this._onStdinError);
      child.off("error", this._onSpawnError);
      child.off("exit", this._onExit);
      try { child.stdin?.end(); } catch { /* already closed */ }
    }
    await this._stopChild();
    this.child = null;
    this.buffer = "";
    this._stdoutDecoder = new StringDecoder("utf8");
    this.secretValues = [];
    this._env = null;
    this.removeAllListeners();
  }

  _spawn() {
    this.buffer = "";
    this.skipping = false;
    this._stdoutDecoder = new StringDecoder("utf8");
    const child = spawn(this.binary, this.args, {
      cwd: this.cwd,
      env: this._env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this._env = null;
    this.child = child;
    child.stdout?.on("data", this._onStdout);
    child.stderr?.on("data", this._onStderr);
    child.stderr?.setEncoding("utf8");
    child.stdin?.on("error", this._onStdinError);
    child.once("error", this._onSpawnError);
    child.once("exit", this._onExit);
  }

  async _stopChild() {
    const child = this.child;
    if (!child || child.exitCode != null || child.signalCode != null) return;
    try { child.kill("SIGTERM"); } catch { return; }
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (child.exitCode == null && child.signalCode == null) {
          try { child.kill("SIGKILL"); } catch { /* already gone */ }
        }
        resolve();
      }, 400);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  _write(message) {
    if (!this.child?.stdin?.writable || this.disposed) throw new ClientClosed("NOT_RUNNING");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  _consumeStderr(chunk) {
    if (this.stderrBytes >= this.stderrTotalCap) return;
    this.stderrBuffer += chunk.toString();
    if (this.stderrBuffer.length > this.stderrTotalCap) { this.stderrBuffer = ""; this.stderrBytes = this.stderrTotalCap; return; }
    let index;
    while ((index = this.stderrBuffer.indexOf("\n")) !== -1) {
      const text = redactText(this.stderrBuffer.slice(0, index + 1), this.secretValues, this.stderrEventCap);
      this.stderrBuffer = this.stderrBuffer.slice(index + 1);
      this.stderrBytes += text.length;
      if (this.stderrBytes <= this.stderrTotalCap && text) this.emit("stderr", text);
    }
  }

  _consumeStdout(chunk) {
    const text = this._stdoutDecoder.write(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
    if (this.skipping) {
      const index = text.indexOf("\n");
      if (index < 0) return;
      this.skipping = false;
      this.buffer += text.slice(index + 1);
      this._drain();
      return;
    }
    this.buffer += text;
    this._drain();
  }

  _drain() {
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      let line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (Buffer.byteLength(line, "utf8") > this.maxLineBytes) this._lineTooLong();
      else if (line.trim()) this._handleLine(line);
      index = this.buffer.indexOf("\n");
    }
    if (Buffer.byteLength(this.buffer, "utf8") > this.maxLineBytes) {
      this.buffer = "";
      this.skipping = true;
      this._lineTooLong();
    }
  }

  _lineTooLong() {
    // The discarded frame may contain any pending response ID. Settle existing
    // requests before notifying listeners, while keeping the stream reusable.
    this.failAll(new ClientClosed("LINE_TOO_LONG"));
    this.emit("protocol-error", { code: "LINE_TOO_LONG" });
  }

  _handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.emit("protocol-error", { code: "INVALID_JSON" });
      return;
    }
    if (message && message.id != null && message.method && !("result" in message) && !("error" in message)) {
      this._handleServerRequest(message);
      return;
    }
    if (message && message.id != null && ("result" in message || "error" in message)) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      if (message.error) entry.finish(new ClientClosed("RPC_FAILED", { rpcCode: message.error.code ?? null }));
      else entry.finish(null, message.result);
      return;
    }
    if (message?.method) {
      if (message.method === "serverRequest/resolved") this.cancelServerRequest(message.params?.requestId, message.params?.threadId);
      this.emit("notification", message);
    }
  }

  cancelServerRequest(id, threadId) {
    if (id == null) return false;
    const key = String(id), pending = this.serverRequests.get(key);
    if (!pending || (threadId != null && pending.threadId != null && threadId !== pending.threadId)) return false;
    pending.cancelled = true;
    this.serverRequests.delete(key);
    return true;
  }

  _cancelServerRequests() {
    for (const pending of this.serverRequests.values()) pending.cancelled = true;
    this.serverRequests.clear();
  }

  _handleServerRequest(message) {
    this.emit("server-request", { id: message.id, method: message.method, params: message.params ?? {} });
    const handler = this.handlers.get(message.method);
    if (!handler) {
      if (!RECOGNIZED.has(message.method)) {
        this.respondError(message.id, JSONRPC_METHOD_NOT_FOUND, "Method not found");
        return;
      }
      const denied = safeDenyResult(message.method);
      if (denied) this.respond(message.id, denied);
      else this.respondError(message.id, JSONRPC_DENIED, "DENIED");
      return;
    }
    const key = String(message.id);
    const pending = { cancelled: false, threadId: message.params?.threadId ?? message.params?.conversationId ?? null };
    this.serverRequests.set(key, pending);
    const active = () => !this.disposed && !pending.cancelled && this.serverRequests.get(key) === pending;
    Promise.resolve().then(() => active() ? handler(message.params ?? {}, { id: message.id, method: message.method }) : undefined)
      .then((result) => {
        if (active()) this.respond(message.id, result);
      })
      .catch((error) => {
        if (!active()) return;
        const code = Number.isInteger(error?.code) ? error.code : JSONRPC_DENIED;
        this.respondError(message.id, code, "DENIED");
      }).finally(() => { if (this.serverRequests.get(key) === pending) this.serverRequests.delete(key); });
  }
}
