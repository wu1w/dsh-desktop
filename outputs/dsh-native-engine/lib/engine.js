import {installModelSelection} from '@deepseek-ai/dsh-agent';
import {checkTool} from './file-policy.js';
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { setSandboxMode } from "@deepseek-ai/dsh-sandbox-policy";
import { EngineError } from "./errors.js";
import { createTranslator } from "./i18n.js";
import { assertIsolatedDataDir } from "./isolate.js";
import { DEFAULT_BASE_URL, DEFAULT_MODEL, PROVIDER } from "./provider.js";
import { bootNativeRuntime } from "./runtime.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TERMINAL = new Set(["completed", "failed", "interrupted"]);
const SANDBOXES = new Set(["read-only", "workspace-write"]);

async function bounded(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(promise).then(() => true, () => true),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function textOf(content) {
  if (typeof content === "string") return content;
  return (content ?? []).map((block) => block.text ?? "").join("");
}

export class DshNativeEngine extends EventEmitter {
  constructor(options = {}) {
    super();
    this.setMaxListeners(50);
    this.options = options;
    this.locale = options.locale ?? "zh-CN";
    this.t = createTranslator(this.locale);
    this.dataDir = assertIsolatedDataDir(options.dataDir, this.t);
    this.sessionRoot = path.join(this.dataDir, "native-sessions");
    this.model = options.model ?? DEFAULT_MODEL;
    this.provider = PROVIDER;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.resolveApiKey = options.resolveApiKey;
    this.resolveSharedInstructions = options.resolveSharedInstructions ?? (async () => "");
    this.adapter = options.adapter ?? null;
    this.approvalTimeoutMs = options.approvalTimeoutMs ?? 120_000;
    this.approvalHandler = options.approvalHandler ?? null;
    this.autoApproveWorkspaceWrites = options.autoApproveWorkspaceWrites === true;
    this.interruptTimeoutMs = options.interruptTimeoutMs ?? 5_000;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5_000;
    this.rows = new Map();
    this.live = new Map();
    this.inflight = new Map();
    this.pending = new Map();
    this.serial = new Map();
    this.loaded = false;
    this.starting = null;
    this.runtime = null;
    this._ready = false;
    this.disposed = false;
    this.disposing = false;
    this.writes = Promise.resolve();
    this._model(this.model);
  }

  get ready() {
    return this._ready && !this.disposed;
  }

  get state() {
    if (this.disposed) return "disposed";
    if (this.inflight.size > 0) return "turn-active";
    if (this.ready) return "ready";
    if (this.starting) return "starting";
    return "idle";
  }

  get activeTurns() {
    return new Map([...this.inflight].map(([id, active]) => [id, { turnId: active.turn.id, threadId: active.row.threadId }]));
  }

  status() {
    return {
      state: this.state,
      stateLabel: this.t(this.inflight.size ? "running" : this.ready ? "ready" : this.starting ? "starting" : "idle"),
      model: this.model,
      provider: this.provider,
      baseUrl: this.baseUrl,
      dataDir: this.dataDir,
      isolated: true,
      engine: "dsh-native",
      limitations: "Embedded DeepSeek Harness agent loop with filesystem read, write, and edit. No desktop credentials, shell PTY, MCP, or subagents.",
      sessions: [...this.rows.values()].map((row) => this._public(row)),
    };
  }

  async start() {
    return this.ensureStarted();
  }

  async ensureStarted() {
    if (this.disposed || this.disposing) throw new EngineError("DISPOSED", this.t("disposed"));
    if (this.ready) return this.status();
    if (this.starting) return this.starting;
    this.starting = (async () => {
      await mkdir(this.sessionRoot, { recursive: true, mode: 0o700 });
      if (!this.loaded) {
        await this._load();
        this.loaded = true;
      }
      try {
        this.runtime = await bootNativeRuntime({
          computerTool:this.options.computerTool,computerCall:this.options.computerCall,developmentTool:this.options.developmentTool,developmentCall:this.options.developmentCall,
          workspaceRoot: this.dataDir,
          sessionRoot: this.sessionRoot,
          adapter: this.adapter,
          baseUrl: this.baseUrl,
          model: this.model,
          resolveApiKey: this.resolveApiKey,
          translator: this.t,
          authorizeMutation: (exec) => this._authorizeMutation(exec),authorizeTool:exec=>this._authorizeTool(exec),checkpoint:()=>this._save(),
        });
      } catch (error) {
        throw new EngineError("BOOT_FAILED", `${this.t("boot")}: ${error.message}`, { cause: error });
      }
      this.runtime.ctx.on("session/event", (session, event) => this._onSessionEvent(session, event), { global: true });
      this.runtime.ctx.on("agent/assistant-stream", (payload) => this._onStream(payload), { global: true });
      if (this.disposed || this.disposing) throw new EngineError("DISPOSED", this.t("disposed"));
      this._ready = true;
      return this.status();
    })().finally(() => { this.starting = null; });
    return this.starting;
  }

  async createSession(id, options = {}) {
    await this.ensureStarted();
    return this._lock(id, async () => {
      const sessionId = this._sessionId(id);
      if (this.rows.has(sessionId)) throw new EngineError("SESSION_EXISTS", this.t("session_exists"));
      const cwd = await this._cwd(options.cwd);
      const selection=options.model??this.model,connection=this._connection(selection);
      const model=connection.model;this._model(model);
      await this.runtime.ensureProvider?.(connection);
      const sandbox = options.sandbox ?? "read-only";
      this._sandbox(sandbox);
      const now = new Date().toISOString();
      const row = {
        sessionId,
        threadId: sessionId,
        cwd,
        model,selection,
        provider: connection.provider,
        sandbox,
        name: "",
        archived: false,
        sharedContext: this._context(options),
        createdAt: now,
        updatedAt: now,
        turns: [],
        queue: [],
      };
      this.rows.set(sessionId, row);
      try {
        await this._open(row, "create");
        await this.runtime.ctx.sessions.flush(this.live.get(row.sessionId).agent.session);
        await this._save();
      } catch (error) {
        this.rows.delete(sessionId);
        await this.live.get(sessionId)?.handle.dispose?.().catch(() => {});
        this.live.delete(sessionId);
        throw error;
      }
      this.emit("session", this._public(row));
      return this._public(row);
    });
  }

  async resumeSession(id) {
    await this.ensureStarted();
    const row = this._row(id);
    await this._ensureLive(row);
    return this._public(row);
  }

  async listSessions() {
    await this.ensureStarted();
    return [...this.rows.values()].map((row) => this._public(row));
  }

  async readSession(id) {
    await this.ensureStarted();
    const row = this._row(id);
    await this._recoverMirror(row);
    return { ...this._public(row), thread: { id: row.threadId, turns: structuredClone(row.turns) } };
  }

  async readTurnState(id, turnId) {
    await this.ensureStarted();
    const row = this._row(id);
    await this._recoverMirror(row);
    const turn = turnId ? row.turns.find((item) => item.id === turnId) : row.turns.at(-1);
    const active = this.inflight.get(row.sessionId);
    return {
      sessionId: row.sessionId,
      threadId: row.threadId,
      turnId: turn?.id ?? turnId ?? null,
      status: turn?.status ?? "unknown",
      known: Boolean(turn),
      active: Boolean(active && active.turn.id === turn?.id),
      terminal: Boolean(turn && TERMINAL.has(turn.status)),
      error: turn?.error ?? null,
    };
  }

  async startTurn(id, input, options = {}) {
    await this.ensureStarted();
    return this._lock(id, async () => {
      const row = this._row(id);
      const connection=this._connection(row.selection??row.model);
      await this.runtime.ensureProvider?.(connection);
      if (row.archived) throw new EngineError("ARCHIVED", this.t("archived"));
      if (this.inflight.has(row.sessionId)) throw new EngineError("TURN_IN_FLIGHT", this.t("busy"));
      const prompt = this._input(input);
      const sandbox=options.sandbox??row.sandbox;this._sandbox(sandbox);row.sandbox=sandbox;
      await this._recoverMirror(row);
      const live = await this._ensureLive(row);
      if(live.modelSelection)live.modelSelection.current={provider:row.provider??this.provider,model:row.model,...((connection.reasoning===true||connection.legacy)&&['low','high','max'].includes(options.effort)?{reasoningEffort:options.effort}:{})};
      setSandboxMode(live.agent.session,row.sandbox);
      const instructions = String(await this.resolveSharedInstructions(row.cwd,row) ?? "");
      row.lastInstructions = instructions;
      this._setPrompt(live, row, instructions);
      const turn = {
        id: randomUUID(),
        status: "inProgress",
        startedAt: new Date().toISOString(),
        completedAt: null,
        ...(options.queueClaimId ? { queuedSubmissionId: options.queueClaimId } : {}),
        items: [{ id: randomUUID(), type: "userMessage", content: [{ type: "text", text: prompt }] }],
      };
      row.turns.push(turn);
      row.updatedAt = new Date().toISOString();
      await this._save();
      const active = { row, turn, live, nativeTurn: null, items: new Map(), cancelled: false };
      this.inflight.set(row.sessionId, active);
      active.done = this._run(active, prompt);
      this._notify("turn/started", { threadId: row.threadId, turn: structuredClone(turn) });
      this.emit("turn", { sessionId: row.sessionId, threadId: row.threadId, turn: structuredClone(turn), phase: "started" });
      return { sessionId: row.sessionId, threadId: row.threadId, turnId: turn.id, status: "inProgress" };
    });
  }

  async interrupt(id) {
    const active = this.inflight.get(id);
    if (!active) return { sessionId: id, interrupted: false };
    active.cancelled = true;
    for (const pending of this.pending.values()) if (pending.sessionId === id) pending.finish(false, "cancelled");
    try { active.live.handle.agent.cancel({ kind: "user" }); } catch {}
    if (!await bounded(active.done, this.interruptTimeoutMs)) throw new EngineError("INTERRUPT_TIMEOUT", this.t("interrupt_timeout"));
    return { sessionId: id, threadId: active.row.threadId, turnId: active.turn.id, interrupted: true };
  }

  async respondApproval(id, result) {
    const pending = this.pending.get(String(id));
    if (!pending) throw new EngineError("APPROVAL_NOT_FOUND", this.t("approval_missing"));
    const allowed = result?.decision === "accept" || result?.decision === "acceptForSession" || result?.behavior === "allow";
    pending.finish(allowed, "answered");
    return {};
  }

  _connection(selection){return this.options.resolveModel?.(selection)??{model:selection,provider:this.provider,baseUrl:this.baseUrl,legacy:true};}
  async setModel(id, model) {
    await this.ensureStarted();
    return this._lock(id, async () => {
      if (this.inflight.has(id)) throw new EngineError("TURN_IN_FLIGHT", this.t("busy"));
      const selection=model,connection=this._connection(selection);model=connection.model;this._model(model);
      await this.runtime.ensureProvider?.(connection);
      const row = this._row(id);
      row.model = model;row.provider=connection.provider;row.selection=selection;
      const live = this.live.get(row.sessionId);
      if(live?.modelSelection)live.modelSelection.current={provider:connection.provider,model};
      await this._save();
      return this._public(row);
    });
  }

  async renameSession(id, name) {
    await this.ensureStarted();
    const row = this._row(id);
    row.name = String(name).slice(0, 300);
    await this._save();
    return this._public(row);
  }

  async archiveSession(id) {
    await this.interrupt(id);
    const row = this._row(id);
    row.archived = true;
    await this._save();
    return this._public(row);
  }

  async restoreSession(id) {
    await this.ensureStarted();
    const row = this._row(id);
    row.archived = false;
    await this._save();
    return this._public(row);
  }

  async steer() {
    throw new EngineError("UNSUPPORTED_STEER", this.t("unsupported"));
  }

  async forkSession() {
    throw new EngineError("UNSUPPORTED_FORK", this.t("unsupported"));
  }

  async moveSession() {
    throw new EngineError("UNSUPPORTED_MOVE", this.t("unsupported"));
  }

  async queueRequest(id, action, params = {}) {
    await this.ensureStarted();
    if (action === "start") return this.startQueued(id, params);
    return this._lock(id, async () => {
      const row = this._row(id);
      const find = () => {
        const wanted = params.queuedSubmissionId ?? params.queuedItemId ?? params.itemId ?? params.id;
        const item = row.queue.find((entry) => entry.id === wanted);
        if (!item || item.status !== "queued") throw new EngineError("QUEUE_INVALID", this.t("queue_invalid"));
        return item;
      };
      let result;
      if (action === "list") return { data: structuredClone(row.queue), nextCursor: null };
      const normalize = (value) => [{ type: "text", text: this._input(value), text_elements: [] }];
      if (action === "add") {
        const item = { id: randomUUID(), input: normalize(params.input ?? params.text), clientUserMessageId: params.clientUserMessageId ?? randomUUID(), status: "queued", createdAt: new Date().toISOString() };
        row.queue.push(item);
        result = { queuedSubmission: structuredClone(item) };
      } else if (action === "update") {
        const item = find();
        item.input = normalize(params.input ?? params.text);
        result = { queuedSubmission: structuredClone(item) };
      } else if (action === "delete") {
        const item = find();
        row.queue = row.queue.filter((entry) => entry !== item);
        result = { deleted: true };
      } else if (action === "reorder") {
        const ids = params.queuedSubmissionIds ?? params.itemIds ?? params.order ?? params.ids;
        if (!Array.isArray(ids) || ids.length !== row.queue.length || new Set(ids).size !== ids.length || ids.some((value) => !row.queue.some((item) => item.id === value))) {
          throw new EngineError("QUEUE_INVALID", this.t("queue_invalid"));
        }
        row.queue = ids.map((value) => row.queue.find((item) => item.id === value));
        result = {};
      } else throw new EngineError("UNSUPPORTED_QUEUE_ACTION", this.t("unsupported"));
      await this._save();
      this._notify("thread/queue/changed", { threadId: row.threadId });
      return result;
    });
  }

  async startQueued(id, params = {}) {
    await this.ensureStarted();
    const { row, item } = await this._lock(id, async () => {
      if (this.inflight.has(id)) throw new EngineError("TURN_IN_FLIGHT", this.t("busy"));
      const row = this._row(id);
      const wanted = params.queuedSubmissionId ?? params.queuedItemId ?? params.itemId ?? params.id;
      const item = wanted ? row.queue.find((entry) => entry.id === wanted) : row.queue.find((entry) => entry.status === "queued");
      if (!item || item.status !== "queued" || row.queue.some((entry) => entry.status === "starting")) throw new EngineError("QUEUE_INVALID", this.t("queue_invalid"));
      item.status = "starting";
      try { await this._save(); } catch (error) { item.status = "queued"; throw error; }
      return { row, item };
    });
    try {
      const started = await this.startTurn(id, item.input, { ...params, queueClaimId: item.id });
      row.queue = row.queue.filter((entry) => entry.id !== item.id);
      await this._save();
      this._notify("thread/queue/changed", { threadId: row.threadId });
      return { turn: structuredClone(row.turns.find((turn) => turn.id === started.turnId)) };
    } catch (error) {
      if (row.turns.some((turn) => turn.queuedSubmissionId === item.id)) row.queue = row.queue.filter((entry) => entry.id !== item.id);
      else item.status = "queued";
      await this._save();
      throw error;
    }
  }

  async dispose() {
    if (this.disposal) return this.disposal;
    if (this.disposed) return;
    this.disposing = true;
    this.disposal = (async () => {
      const active = [...this.inflight.values()];
      for (const value of active) {
        value.cancelled = true;
        try { value.live.handle.agent.cancel({ kind: "disposed" }); } catch {}
      }
      for (const pending of this.pending.values()) pending.finish(false, "disposed");
      const settled=await bounded(Promise.allSettled(active.map((value) => value.done)), this.shutdownTimeoutMs);
      if(!settled)for(const value of active)value.detached=true;
      for (const value of this.live.values()) await bounded(value.handle.dispose?.(), this.shutdownTimeoutMs);
      if (this.runtime) await bounded(this.runtime.dispose(), this.shutdownTimeoutMs);
      if (this.loaded) await bounded(this._save(), this.shutdownTimeoutMs);
      this.disposed = true;
      this._ready = false;
      this.disposing = false;
    })();
    return this.disposal;
  }

  async _run(active, prompt) {
    const { row, turn, live } = active;
    try {
      live.handle.agent.followup(createUserMessage({
        content: [{ type: "text", text: prompt }],
        source: { kind: "user" },
      }));
      await live.handle.agent.whenIdle();
    } catch (error) {
      if (!active.cancelled && turn.status === "inProgress") {
        turn.status = "failed";
        turn.error = { code: error.code ?? "NATIVE_TURN_FAILED", message: this._redact(error.message ?? error) };
      }
    } finally {
      if(active.detached||this.disposed)return;
      for (const pending of [...this.pending.values()]) if (pending.sessionId === row.sessionId) pending.finish(false, "cancelled");
      if (active.cancelled || turn.nativeReason?.kind === "aborted") turn.status = "interrupted";
      else if (turn.nativeReason?.kind === "error") {
        turn.status = "failed";
        turn.error ??= { code: turn.nativeReason.error?.code ?? "NATIVE_TURN_FAILED", message: this._redact(turn.nativeReason.error?.message ?? this.t("failed")) };
      } else if (turn.status === "inProgress") turn.status = "completed";
      if(turn.status==='failed'&&['TRANSPORT','TIMEOUT','SERVER','RATE_LIMIT'].includes(turn.error?.code)){
        const status=turn.error.code==='RATE_LIMIT'?429:turn.error.code==='SERVER'?503:null;
        turn.error.codexErrorInfo={responseStreamConnectionFailed:{httpStatusCode:status}};
      }
      turn.completedAt = new Date().toISOString();
      row.updatedAt = turn.completedAt;
      try { await this.runtime.ctx.sessions.flush(live.agent.session);await this._save(); } catch (error) {
        turn.status = "failed";
        turn.error = { code: error.code, message: error.message };
      }
      this.inflight.delete(row.sessionId);
      if (this.disposed) return;
      this._notify("turn/completed", { threadId: row.threadId, turn: structuredClone(turn) });
      const event = { sessionId: row.sessionId, threadId: row.threadId, turnId: turn.id, status: turn.status, error: turn.error ?? null, turn: structuredClone(turn), phase: "completed" };
      this.emit("turn", event);
      this.emit("turn-completed", event);
      if (turn.status === "completed" && this.options.autoQueue !== false && !this.disposed && !row.archived && row.queue.some((item) => item.status === "queued")) {
        setImmediate(() => {
          if (!this.disposed && !row.archived) this.startQueued(row.sessionId).catch((error) => this.emit("queue-error", { sessionId: row.sessionId, code: error.code ?? "QUEUE_FAILED", message: this._redact(error.message) }));
        });
      }
    }
  }

  async _authorizeTool(exec){
    const id=exec.agent?.session?.id,active=this.inflight.get(id),row=this.rows.get(id);
    if(!active||!row||active.cancelled||this.disposing||this.disposed||exec.signal?.aborted)return false;
    if(exec.name===this.options.computerTool?.name&&this.options.computerCall)return true;
    if(exec.name===this.options.developmentTool?.name&&this.options.developmentCall)return true;
    const name=({read:'Read',write:'Write',edit:'Edit'})[exec.name];if(!name)return false;
    const policy=await checkTool({name,input:exec.arguments??{},cwd:row.cwd,dataDir:this.dataDir,sandbox:row.sandbox});
    if(policy.allowed)await this.runtime.ctx.sessions.flush(exec.agent.session);
    return policy.allowed;
  }
  async _authorizeMutation(exec) {
    const sessionId = exec.agent?.session?.id ?? exec.agent?.id;
    const row = sessionId ? this.rows.get(sessionId) : null;
    if (!row || row.sandbox !== "workspace-write" || exec.signal?.aborted) return this.t("approval_denied");
    if (this.autoApproveWorkspaceWrites) return true;
    const id = randomUUID();
    return new Promise((resolve) => {
      let timer;
      const finish = (allowed, reason = "answered") => {
        if (!this.pending.has(id)) return;
        clearTimeout(timer);
        exec.signal?.removeEventListener("abort", onAbort);
        this.pending.delete(id);
        this.emit("approval-resolved", { id, reason, allowed });
        resolve(allowed ? true : this.t("approval_denied"));
      };
      const onAbort = () => finish(false, "cancelled");
      this.pending.set(id, { finish, sessionId: row.sessionId });
      exec.signal?.addEventListener("abort", onAbort, { once: true });
      const request = {
        id,
        method: "item/fileChange/requestApproval",
        params: { threadId: row.threadId, turnId: this.inflight.get(row.sessionId)?.turn.id ?? null, tool: exec.name, input: exec.arguments, reason: this.t("approval_denied") },
      };
      const waiting = this.listenerCount("approval-required") > 0 || this.approvalHandler;
      timer = setTimeout(() => finish(false, "expired"), waiting ? this.approvalTimeoutMs : 0);
      this.emit("approval-required", request);
      if (this.approvalHandler) {
        Promise.resolve(this.approvalHandler(request)).then((answer) => {
          finish(answer?.decision === "accept" || answer?.decision === "acceptForSession" || answer?.behavior === "allow");
        }).catch(() => finish(false, "failed"));
      }
      if (exec.signal?.aborted) onAbort();
    });
  }

  async _open(row, source) {
    await this.runtime.ensureProvider?.(this._connection(row.selection??row.model));
    let bound = null;
    const factoryOptions = {
      agentOptions: { provider: row.provider??this.provider, model: row.model },
      setup: (agentCtx, agent) => {
        if (row.sandbox !== "read-only") setSandboxMode(agent.session, row.sandbox);
        const modelSelection={current:{provider:row.provider??this.provider,model:row.model},assembled:undefined};
        installModelSelection(agentCtx,modelSelection);
        bound = { handle: null, agentCtx, agent,modelSelection };
        this._setPrompt(bound, row, row.lastInstructions ?? "");
      },
    };
    const handle = source === "create"
      ? await this.runtime.ctx.agents.create({ sessionId: row.sessionId, meta: { cwd: row.cwd }, ...factoryOptions })
      : await this.runtime.ctx.agents.resume({ resumeSessionId: row.sessionId, ...factoryOptions });
    bound ??= { agentCtx: handle.agent.ctx, agent: handle.agent };
    bound.handle = handle;
    bound.agent = handle.agent;
    this.live.set(row.sessionId, bound);
    return bound;
  }

  async _ensureLive(row) {
    const existing = this.live.get(row.sessionId);
    if (existing?.handle) return existing;
    return this._open(row, "resume");
  }

  _setPrompt(live, row, instructions) {
    const ctx = live.agentCtx ?? live.agent?.ctx;
    if (!live.promptBound && ctx?.systemPrompt?.section) {
      live.promptState = { sharedContext: "", instructions: "" };
      ctx.systemPrompt.section({
        name: "client:shared-context",
        order: -2000,
        text: () => live.promptState.sharedContext,
      });
      ctx.systemPrompt.section({
        name: "client:shared-instructions",
        order: -1900,
        text: () => live.promptState.instructions,
      });
      live.promptBound = true;
    }
    if (!live.promptState) live.promptState = { sharedContext: "", instructions: "" };
    live.promptState.sharedContext = row.sharedContext ?? "";
    live.promptState.instructions = instructions ?? "";
  }

  _onSessionEvent(session, event) {
    const row = this.rows.get(session?.id);
    const active = row ? this.inflight.get(row.sessionId) : null;
    if (!row || !active) return;
    if(event.type==="turn/start")active.turn.nativeSeq=event.seq;
    if (event.type === "turn/end") active.turn.nativeReason = event.data?.reason ?? null;
    if (event.type === "assistant/message") {
      const text = textOf((event.data?.message?.content??[]).filter(block=>block.type==="text"));
      if (text) this._item(active, { id: active.streamItemId??`assistant:${event.seq ?? active.turn.items.length}`, type: "agentMessage", text: this._redact(text) });
    }
    if (event.type === "tool/call") {
      this._item(active, { id: event.data.callId, type: "commandExecution", status: "inProgress", command: `${event.data.name}`, cwd: row.cwd, aggregatedOutput: "", arguments: event.data.arguments }, "started");
    }
    if (event.type === "tool/result") {
      const id = event.data?.message?.toolCallId ?? event.data?.callId;
      const item = active.items.get(id) ?? { id, type: "commandExecution", command: "", cwd: row.cwd };
      item.status = event.data?.message?.isError ? "failed" : "completed";
      item.aggregatedOutput = this._redact(textOf(event.data?.message?.content));
      this._item(active, item);
    }
  }

  _onStream(payload) {
    const frame=payload?.frame??payload;
    const active=this.inflight.get(String(frame?.attemptId??'').split(':')[0]);
    if(!active)return;
    if(frame.type==='start'){active.streamItemId='assistant:'+frame.attemptId;return;}
    if(frame.type==='end'){active.streamItemId=null;return;}
    if(frame.type!=='chunk'||frame.chunk?.type!=='text-delta')return;
    const id=active.streamItemId??('assistant:'+frame.attemptId);
    active.streamItemId=id;
    const item=active.items.get(id)??{id,type:'agentMessage',text:''};
    if(!active.items.has(id))this._item(active,item,'started');
    const delta=this._redact(frame.chunk.text??'');item.text+=delta;
    this._notify('item/agentMessage/delta',{threadId:active.row.threadId,turnId:active.turn.id,itemId:id,delta});
  }

  _item(active, item, phase = "completed") {
    const index = active.turn.items.findIndex((row) => row.id === item.id);
    if (index < 0) active.turn.items.push(item);
    else active.turn.items[index] = item;
    active.items.set(item.id, item);
    this._notify(`item/${phase}`, { threadId: active.row.threadId, turnId: active.turn.id, item: structuredClone(item) });
  }

  _notify(method, params) {
    if (!this.disposed) this.emit("notification", { method, params });
  }

  _public(row) {
    return {
      sessionId: row.sessionId,
      threadId: row.threadId,
      cwd: row.cwd,
      model: row.selection??row.model,
      provider: row.provider,
      sandbox: row.sandbox,
      name: row.name ?? "",
      archived: Boolean(row.archived),
      sharedContext: row.sharedContext ?? "",
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      engine: "dsh-native",
    };
  }

  _row(id) {
    const row = this.rows.get(id);
    if (!row) throw new EngineError("SESSION_NOT_FOUND", this.t("session_missing"));
    return row;
  }

  _sessionId(id) {
    if (typeof id !== "string" || !UUID.test(id)) throw new EngineError("INVALID_SESSION", this.t("invalid_session"));
    return id;
  }

  _model(model) {
    if (typeof model !== "string" || !(this.options.resolveModel?/^[^\s\x00-\x1f\x7f]{1,180}$/:/^deepseek-[A-Za-z0-9._-]{1,90}$/).test(model)) throw new EngineError("MODEL_INVALID", this.t("model_invalid"));
  }

  _sandbox(sandbox) {
    if (!SANDBOXES.has(sandbox)) throw new EngineError("SANDBOX_REJECTED", this.t("sandbox_invalid"));
  }

  _context(options) {
    const value = options.sharedContext ?? options.settings?.context ?? "";
    if (typeof value !== "string") throw new EngineError("INVALID_INPUT", this.t("unsupported"));
    return value;
  }

  _input(input) {
    if (typeof input === "string" && input.trim()) return input;
    if (Array.isArray(input)) {
      if (input.some((item) => item.type && item.type !== "text")) throw new EngineError("UNSUPPORTED_INPUT", this.t("unsupported"));
      const value = input.map((item) => item.text ?? "").join("\n");
      if (value.trim()) return value;
    }
    throw new EngineError("INVALID_INPUT", this.t("unsupported"));
  }

  async _cwd(cwd) {
    if (typeof cwd !== "string" || !path.isAbsolute(cwd)) throw new EngineError("INVALID_PATH", this.t("invalid_path"));
    const resolved = path.resolve(cwd);
    const info = await stat(resolved).catch(() => null);
    if (!info?.isDirectory()) throw new EngineError("INVALID_PATH", this.t("invalid_path"));
    return resolved;
  }

  _lock(id, fn) {
    const next = (this.serial.get(id) ?? Promise.resolve()).catch(() => {}).then(() => {
      if (this.disposed || this.disposing) throw new EngineError("DISPOSED", this.t("disposed"));
      return fn();
    });
    this.serial.set(id, next);
    const cleanup = () => { if (this.serial.get(id) === next) this.serial.delete(id); };
    next.then(cleanup, cleanup);
    return next;
  }

  async _recoverMirror(row){
    if(!row.needsNativeRecovery)return;
    const turn=row.turns.at(-1);if(!turn){row.needsNativeRecovery=false;return;}
    const handle=await this.runtime.ctx.sessionPersistence.open(row.sessionId,'read');
    let offset=0,events=[];
    try{for(;;){const page=await handle.read(offset,256);if(!page.events.length)break;for(const event of page.events){if(event.type==='turn/start')events=[];events.push(event);}offset+=page.events.length;}}
    finally{await handle.close();}
    const start=events.find(e=>e.type==='turn/start');
    if(start&&turn.nativeSeq===start.seq){
      const items=[turn.items.find(i=>i.type==='userMessage')].filter(Boolean),tools=new Map();
      for(const event of events){
        const data=event.data??{};
        if(event.type==='assistant/message'){
          const text=textOf((data.message?.content??[]).filter(b=>b.type==='text'));
          if(text)items.push({id:'recovered:'+row.sessionId+':'+event.seq,type:'agentMessage',text:this._redact(text)});
        }
        if(event.type==='tool/call'){const item={id:data.callId,type:'commandExecution',command:data.name,cwd:row.cwd,status:'interrupted',arguments:data.arguments,aggregatedOutput:''};items.push(item);tools.set(item.id,item);}
        if(event.type==='tool/result'){const item=tools.get(data.message?.toolCallId??data.callId);if(item){item.status=data.message?.isError?'failed':'completed';item.aggregatedOutput=this._redact(textOf(data.message?.content));}}
      }
      turn.items=items;turn.nativeSeq=start.seq;
      const end=events.findLast(e=>e.type==='turn/end');
      if(end){const reason=end.data?.reason;turn.status=reason?.kind==='error'?'failed':reason?.kind==='aborted'?'interrupted':'completed';if(reason?.kind==='error')turn.error=reason.error;}
    }
    if(turn.nativeSeq==null){
      // No request checkpoint owns this mirror row. Never substitute an older
      // native answer or replay an unverified submission automatically.
      turn.status='failed';turn.error={code:'DISPATCH_NOT_RECORDED',message:this.t('dispatch_unverified')};
      row.sharedContext=(row.sharedContext??'')+'\nUnfinished prior user request (execution was not confirmed):\n'+JSON.stringify(turn.items.filter(i=>i.type==='userMessage'));
    }
    row.needsNativeRecovery=false;await this._save();
  }

  async _load() {
    try {
      const saved = JSON.parse(await readFile(path.join(this.dataDir, "sessions.json"), "utf8"));
      if (saved.version !== 1 || !Array.isArray(saved.sessions)) throw new Error("SCHEMA");
      for (const row of saved.sessions) {
        if (!UUID.test(row.sessionId ?? "") || !Array.isArray(row.turns) || !Array.isArray(row.queue)) throw new Error("SCHEMA");
        for (const turn of row.turns) if (turn.status === "inProgress"){turn.status="interrupted";row.needsNativeRecovery=true;}
        row.queue = row.queue.filter((entry) => !row.turns.some((turn) => turn.queuedSubmissionId === entry.id));
        for (const entry of row.queue) if (entry.status === "running" || entry.status === "starting") entry.status = "queued";
        this.rows.set(row.sessionId, row);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw new EngineError("PERSIST_FAILED", this.t("persist"), { cause: error });
    }
  }

  _save() {
    const run = this.writes.catch(() => {}).then(async () => {
      if(this.disposed)return;
      const temporary = path.join(this.dataDir, `.sessions-${randomUUID()}.tmp`);
      try {
        await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
        await writeFile(temporary, `${JSON.stringify({ version: 1, sessions: [...this.rows.values()] }, null, 2)}\n`, { mode: 0o600 });
        if(!this.disposed)await rename(temporary, path.join(this.dataDir, "sessions.json"));
      } catch (error) {
        throw new EngineError("PERSIST_FAILED", this.t("persist"), { cause: error });
      } finally {
        await rm(temporary, { force: true }).catch(() => {});
      }
    });
    this.writes = run;
    return run;
  }

  _redact(value) {
    return String(value ?? "").replace(/(?:Bearer\s+)[A-Za-z0-9._-]+/gi, "Bearer [redacted]").replace(/\b(?:sk-|oc_sk_)[A-Za-z0-9_-]{8,}\b/g, "[redacted]");
  }
}
