import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { EngineError } from "./errors.js";
import { createTranslator, formatTime } from "./i18n.js";
import { AppServerClient, RECOGNIZED_SERVER_METHODS, safeDenyResult } from "./jsonrpc-client.js";
import {
  API_KEY_ENV,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  assertIsolatedDataDir,
  assertSandbox,
  buildChildEnv,
  renderProviderConfig,
  threadProviderConfig,
} from "./provider-config.js";
import { SessionStore } from "./session-store.js";
import { isTurnItemsCursor, legacyItemsPage } from "./history-pages.js";
import { TurnStateReconciler } from "./turn-reconciler.js";
import { redactText } from "./redact.js";

const TERMINAL_TURN_STATES = new Set(["completed", "failed", "interrupted"]);
async function bounded(promise, ms = 1000) { let timer; try { await Promise.race([Promise.resolve(promise).catch(() => {}), new Promise(resolve => { timer = setTimeout(resolve, ms); })]); } finally { clearTimeout(timer); } }

const CLIENT_ERROR_KEYS = {
  TIMEOUT: "error.timeout",
  DISPOSED: "error.disposed",
  SPAWN_FAILED: "error.spawn_failed",
  PROCESS_EXIT: "error.process_exit",
  ABORTED: "error.aborted",
  NOT_READY: "error.not_ready",
  NOT_RUNNING: "error.not_ready",
  RPC_FAILED: "error.rpc_failed",
  PROTOCOL: "error.protocol",
  LINE_TOO_LONG: "error.line_too_long",
  WRITE_FAILED: "error.rpc_failed",
  STDIN: "error.rpc_failed",
};

export class CodexEngine extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options=options;
    this.setMaxListeners(50);
    this.locale = options.locale ?? "zh-CN";
    this.t = createTranslator(this.locale);
    const isolated = assertIsolatedDataDir(options.dataDir, this.t);
    this.dataDir = isolated.dataDir;
    this.codexHome = isolated.codexHome;
    this.binary = options.binary ?? "";
    this.args = options.args ?? ["app-server"];
    this.model = options.model ?? DEFAULT_MODEL;
    this.provider = options.provider ?? DEFAULT_PROVIDER;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.sandbox = options.sandbox ?? "read-only";
    this.approvalPolicy = options.approvalPolicy ?? "on-request";
    assertSandbox(this.sandbox, this.t);
    this.resolveApiKey = options.resolveApiKey ?? (() => process.env[API_KEY_ENV]);
    this.resolveInstructionProfile = options.resolveInstructionProfile ?? (() => null);
    this.extraEnv = options.extraEnv ?? {};
    this.baseEnv = options.baseEnv ?? process.env;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.recoveryRequestTimeoutMs = options.recoveryRequestTimeoutMs ?? 1500;
    this.recoveryReadTimeoutMs = options.recoveryReadTimeoutMs ?? 8000;
    for (const value of [this.recoveryRequestTimeoutMs, this.recoveryReadTimeoutMs]) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError("INVALID_RECOVERY_TIMEOUT");
    }
    this.networkRecovery = options.networkRecovery ?? {};
    this.eventHistoryLimit = Math.max(16, Math.min(100_000, options.eventHistoryLimit ?? 4096));
    this.maxLineBytes = options.maxLineBytes ?? 1024 * 1024;
    this.approvalTimeoutMs = options.approvalTimeoutMs ?? 120_000;
    this.approvalHandler = options.approvalHandler ?? null;
    this.store = new SessionStore(path.join(this.dataDir, "sessions.json"), this.t);
    this.client = null;
    this.inflight = new Map();
    this.queues = new Map();
    this.pendingApprovals = new Map();
    this.completedTurns = new Set();
    this.seenTurnEvents = new Set();
    this.loadedThreads = new Set();
    this.pendingOperations = new Map();
    this.disposed = false;
    this.starting = null;
    this.initResult = null;
    this._apiKey = null;
    this.turnReconciler = new TurnStateReconciler({
      getClient: () => this.disposed ? null : this.client,
      getTargets: () => [...this.inflight].flatMap(([sessionId, active]) =>
        this.store.get(sessionId)?.threadId === active.threadId && typeof active.turnId === "string"
          ? [{ sessionId, ...active }] : []),
      isCurrentTarget: target => !this.disposed && this.store.get(target.sessionId)?.threadId === target.threadId
        && this.inflight.get(target.sessionId)?.threadId === target.threadId
        && this.inflight.get(target.sessionId)?.turnId === target.turnId,
      onCompleted: (target, turn) => this._completeReconciledTurn(target, turn),
      onSettled: result => this.emit("turn-reconciliation", result),
    });
  }

  get ready() {
    return Boolean(this.client?.ready);
  }

  get state() {
    if (this.disposed) return "disposed";
    if (this.inflight.size > 0) return "turn-active";
    if (this.ready) return "ready";
    if (this.starting) return "starting";
    return "idle";
  }

  get activeTurns() {
    return new Map(this.inflight);
  }

  status() {
    return {
      state: this.state,
      stateLabel: this.t(stateKey(this.state)),
      binary: this.binary || null,
      dataDir: this.dataDir,
      codexHome: this.codexHome,
      model: this.model,
      provider: this.provider,
      sandbox: this.sandbox,
      approvalPolicy: this.approvalPolicy,
      pid: this.client?.pid ?? null,
      isolated: true,
      limitations: this.t("status.limitations"),
      sessions: this.store.list().map((record) => this._public(record)),
    };
  }

  async start() {
    try {
      return await this.ensureStarted();
    } catch (error) {
      throw this._wrap(error);
    }
  }

  async createSession(sessionId, options = {}) {
    try {
      return await this._enqueue(sessionId, async () => {
        this._assertAlive();
        const id = this._sessionId(sessionId);
        const cwd = this._cwd(options.cwd);
        const selection=options.model??this.model, connection=this._connection(selection);
        const selectedModel = connection.model;
        let profile = await this.resolveInstructionProfile({model:selectedModel,locale:this.locale});
        if(options.sharedContext){profile={...(profile??{id:"dsh-shared",version:"1"}),threadParams:{...profile?.threadParams,developerInstructions:[profile?.threadParams?.developerInstructions,options.sharedContext].filter(Boolean).join("\n\n")}};}
        await this.store.load();
        if (this.store.get(id)) throw new EngineError("SESSION_EXISTS", "error.session_exists", {}, this.t);
        await this.ensureStarted();
        const result = await this.client.request("thread/start", {
          model: selectedModel,
          modelProvider: connection.provider,
          allowProviderModelFallback: false,
          cwd,
          approvalPolicy: this.approvalPolicy,
          sandbox: this.sandbox,
          config: this._providerConfig({model:selectedModel,selection}),
          ...await this._sharedProfileParams({instructionProfile:profile,cwd,sessionId:id}),
        });
        const identity = this._identity(result, selectedModel,connection.provider);
        this.loadedThreads.add(identity.threadId);
        const record = this._record({
          sessionId: id,
          threadId: identity.threadId,
          cwd,
          model: identity.model,
          selection,
          provider: identity.provider,
          instructionProfile: profile ? { id:profile.id,version:profile.version,instructionHash:profile.instructionHash,model:selectedModel,threadParams:structuredClone(profile.threadParams??{}) } : null,
        });
        if(this.options.resolveSharedInstructions||options.sharedContext)record.unstarted=true;
        await this.store.upsert(record);
        this.emit("session", this._public(record));
        return this._public(record);
      });
    } catch (error) {
      throw this._wrap(error);
    }
  }

  async resumeSession(sessionId) {
    try {
      return await this._enqueue(sessionId, async () => {
        this._assertAlive();
        const record = await this._require(sessionId);
        await this.ensureStarted();
        if(record.unstarted===true&&!this.loadedThreads.has(record.threadId)){await this._restartEmpty(record);return this._public(record);}
        if (this.loadedThreads.has(record.threadId)) return this._public(record);
        const result = await this.client.request("thread/resume", {
          threadId: record.threadId,
          model: record.model,
          modelProvider: record.provider,
          cwd: record.cwd,
          approvalPolicy: this.approvalPolicy,
          sandbox: this.sandbox,
          excludeTurns: true,
          config:this._providerConfig(record),
          ...await this._sharedProfileParams(record),
        });
        const identity = this._identity(result, record.model,record.provider);
        if (identity.threadId !== record.threadId) {
          throw new EngineError("PROVIDER_MISMATCH", "error.provider_mismatch", {}, this.t);
        }
        this.loadedThreads.add(record.threadId);
        return this._public(record);
      });
    } catch (error) {
      throw this._wrap(error);
    }
  }

  async startTurn(sessionId, input, options = {}) {
    try {
      return await this._enqueue(sessionId, async () => {
        this._assertAlive();
        const record = await this._require(sessionId);
        if(this.options.resolveModel)this._connection(record.selection??record.model);
        if (record.archived) throw new EngineError("ARCHIVED", "error.archived", {}, this.t);
        if (record.blocked) throw new EngineError(record.blocked, blockedKey(record.blocked), {}, this.t);
        if (this.pendingOperations.has(record.sessionId)) throw new EngineError("TURN_STATE_UNKNOWN", "error.turn_state_unknown", {}, this.t);
        if (this.inflight.has(record.sessionId)) {
          throw new EngineError("TURN_IN_FLIGHT", "error.turn_in_flight", {}, this.t);
        }
        const turnInput = Array.isArray(input) ? input : [{ type: "text", text: normalizeText(input, this.t), text_elements: [] }];
        if (!turnInput.length) throw new EngineError("INVALID_INPUT", "error.invalid_input", {}, this.t);
        const sandbox = options.sandbox ?? this.sandbox;
        assertSandbox(sandbox, this.t);
        await this.ensureStarted();
        if(record.unstarted===true&&!this.loadedThreads.has(record.threadId))await this._restartEmpty(record);
        if (!this.loadedThreads.has(record.threadId) || this.options.resolveSharedInstructions&&record.unstarted!==true) {
          const resumed = await this.client.request("thread/resume", { threadId: record.threadId, model: record.model, modelProvider: record.provider, cwd: record.cwd, approvalPolicy: this.approvalPolicy, sandbox, excludeTurns: true, config:this._providerConfig(record), ...await this._sharedProfileParams(record) });
          this._identity(resumed, record.model,record.provider);
          this.loadedThreads.add(record.threadId);
        }
        if(record.unstarted===true){record.unstarted=false;await this.store.upsert(record);}
        const operation = { operation: "start", threadId: record.threadId, turnId: null, reason: null };
        this.pendingOperations.set(record.sessionId, operation);
        let result;
        try { result = await this.client.request("turn/start", {
          threadId: record.threadId,
          input: turnInput,
          approvalPolicy: this.approvalPolicy,
          model: record.model,
          ...(options.effort ? { effort: options.effort } : {}),
          sandboxPolicy: sandbox === "danger-full-access" ? { type: "dangerFullAccess" } : sandbox === "workspace-write"
            ? { type: "workspaceWrite", writableRoots: [record.cwd], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true }
            : { type: "readOnly", networkAccess: false },
        }); } catch (error) {
          // A lost ACK does not prove that the native server rejected the turn.
          // Keep a fence until a matching native turn can be read or observed.
          if (error.code === "RPC_FAILED" || error.code === "NOT_READY" || error.code === "NOT_RUNNING") this.pendingOperations.delete(record.sessionId);
          else { operation.reason = error.code ?? "UNKNOWN"; operation.turnId ??= this.inflight.get(record.sessionId)?.turnId ?? null; }
          throw error;
        }
        const turn = result?.turn;
        if (!turn?.id) throw new EngineError("PROTOCOL", "error.protocol", {}, this.t);
        this.pendingOperations.delete(record.sessionId);
        const key = `${record.threadId}:${turn.id}`;
        if (turn.status === "inProgress" && !this.completedTurns.has(key)) {
          this.inflight.set(record.sessionId, { turnId: turn.id, threadId: record.threadId });
        }
        this._emitTurn(record.sessionId, record.threadId, turn, "started");
        return {
          sessionId: record.sessionId,
          threadId: record.threadId,
          turnId: turn.id,
          status: turn.status,
        };
      });
    } catch (error) {
      throw this._wrap(error);
    }
  }

  async steer(sessionId, input) {
    try {
      return await this._enqueue(sessionId, async () => {
        this._assertAlive();
        const record = await this._require(sessionId);
        const active = this.inflight.get(record.sessionId);
        if (!active) throw new EngineError("NO_ACTIVE_TURN", "error.no_active_turn", {}, this.t);
        const turnInput = Array.isArray(input) ? input : [{ type: "text", text: normalizeText(input, this.t), text_elements: [] }];
        if (!turnInput.length) throw new EngineError("INVALID_INPUT", "error.invalid_input", {}, this.t);
        await this.ensureStarted();
        await this.client.request("turn/steer", {
          threadId: record.threadId,
          expectedTurnId: active.turnId,
          input: turnInput,
        });
        return { sessionId: record.sessionId, threadId: record.threadId, turnId: active.turnId };
      });
    } catch (error) {
      throw this._wrap(error);
    }
  }

  async queueRequest(sessionId, action, params = {}) {
    return this._enqueue(sessionId, async () => {
      const record = await this._require(sessionId);
      if (record.archived) throw new EngineError("ARCHIVED", "error.archived", {}, this.t);
      if (!["add", "list", "update", "delete", "reorder", "start"].includes(action)) throw new EngineError("INVALID_INPUT", "error.invalid_input", {}, this.t);
      if (action === "start") {
        if (this.pendingOperations.has(sessionId)) throw new EngineError("TURN_STATE_UNKNOWN", "error.turn_state_unknown", {}, this.t);
        if (this.inflight.has(sessionId)) throw new EngineError("TURN_IN_FLIGHT", "error.turn_in_flight", {}, this.t);
      }
      await this.ensureStarted();
      if (action === "start" && !this.loadedThreads.has(record.threadId)) {
        const resumed = await this.client.request("thread/resume", { threadId: record.threadId, model: record.model, modelProvider: record.provider, cwd: record.cwd, approvalPolicy: this.approvalPolicy, sandbox: this.sandbox, excludeTurns: true, config:this._providerConfig(record), ...await this._sharedProfileParams(record) });
        this._identity(resumed, record.model,record.provider);
        this.loadedThreads.add(record.threadId);
      }
      if(record.unstarted===true&&!this.loadedThreads.has(record.threadId))await this._restartEmpty(record);
      const request = { ...params, threadId: record.threadId };
      if (action === "add" && !request.clientUserMessageId) request.clientUserMessageId = randomUUID();
      if (action !== "start") return this.client.request(`thread/queue/${action}`, request);
      const operation = { operation: "start", threadId: record.threadId, turnId: null, reason: null };
      this.pendingOperations.set(sessionId, operation);
      try {
        const result = await this.client.request("thread/queue/start", request);
        if (!result?.turn?.id) throw new EngineError("PROTOCOL", "error.protocol", {}, this.t);
        this.pendingOperations.delete(sessionId);
        if (result.turn.status === "inProgress" && !this.completedTurns.has(`${record.threadId}:${result.turn.id}`)) this.inflight.set(sessionId, { threadId: record.threadId, turnId: result.turn.id });
        this._emitTurn(sessionId, record.threadId, result.turn, "started");
        return result;
      } catch (error) {
        if (["RPC_FAILED", "NOT_READY", "NOT_RUNNING"].includes(error.code)) this.pendingOperations.delete(sessionId);
        else { operation.reason = error.code ?? "UNKNOWN"; operation.turnId ??= this.inflight.get(sessionId)?.turnId ?? null; }
        throw error;
      }
    }).catch(error => { throw this._wrap(error); });
  }

  async moveSession(sessionId, cwd) {
    return this._enqueue(sessionId, async () => {
      const record = await this._require(sessionId);
      if (this.inflight.has(sessionId)) throw new EngineError("TURN_IN_FLIGHT", "error.turn_in_flight", {}, this.t);
      await this.ensureStarted();
      const nextCwd = this._cwd(cwd);
      const resumed = await this.client.request("thread/resume", { threadId: record.threadId, model: record.model, modelProvider: record.provider, cwd: nextCwd, approvalPolicy: this.approvalPolicy, sandbox: this.sandbox, excludeTurns: true, config:this._providerConfig(record), ...await this._sharedProfileParams({...record,cwd:nextCwd}) });
      this._identity(resumed, record.model,record.provider);
      const next = { ...record, cwd: nextCwd, updatedAt: new Date().toISOString() };
      await this.store.upsert(next);
      this.loadedThreads.add(record.threadId);
      return this._public(next);
    }).catch(error => { throw this._wrap(error); });
  }

  _connection(selection){return this.options.resolveModel?.(selection)??{model:selection,provider:this.provider,baseUrl:this.baseUrl};}
  _providerConfig(record){const c=this._connection(record.selection??record.model);return threadProviderConfig({provider:c.provider,baseUrl:c.baseUrl,networkRecovery:this.networkRecovery});}
  async setModel(sessionId, model) {
    return this._enqueue(sessionId, async () => {
      if(this.options.resolveModel){
        const selection=model,c=this._connection(selection),record=await this._require(sessionId);
        if((record.selection??record.model)===selection)return this._public(record);
        if(this.inflight.has(sessionId))throw new EngineError("TURN_IN_FLIGHT","error.turn_in_flight",{},this.t);
        await this.ensureStarted();
        const profile=await this.resolveInstructionProfile({model:c.model,locale:this.locale});
        const next={...record,model:c.model,provider:c.provider,selection,instructionProfile:profile?{...profile,model:c.model}:null,updatedAt:new Date().toISOString()};
        if(record.unstarted){await this._restartEmpty(next);return this._public(next);}
        const result=await this.client.request("thread/resume",{threadId:record.threadId,model:c.model,modelProvider:c.provider,cwd:record.cwd,approvalPolicy:this.approvalPolicy,sandbox:this.sandbox,excludeTurns:true,config:this._providerConfig(next),...(record.instructionProfile&&!profile?{baseInstructions:null}:{}),...await this._sharedProfileParams(next)});
        this._identity(result,c.model,c.provider);await this.store.upsert(next);this.loadedThreads.add(record.threadId);return this._public(next);
      }
      if (typeof model !== "string" || !/^deepseek-[a-zA-Z0-9._-]{1,90}$/.test(model)) throw new EngineError("INVALID_INPUT", "error.invalid_input", {}, this.t);
      const record = await this._require(sessionId);
      if(record.instructionProfile?.model && record.instructionProfile.model!==model)throw new EngineError("PROFILE_MODEL_MISMATCH","error.profile_model_mismatch",{},this.t);
      if (this.inflight.has(sessionId)) throw new EngineError("TURN_IN_FLIGHT", "error.turn_in_flight", {}, this.t);
      await this.ensureStarted();
      const result = await this.client.request("thread/resume", { threadId: record.threadId, model, modelProvider: record.provider, cwd: record.cwd, approvalPolicy: this.approvalPolicy, sandbox: this.sandbox, excludeTurns: true, config:this._providerConfig(record), ...await this._sharedProfileParams(record) });
      this._identity(result, model);
      const next = { ...record, model, updatedAt: new Date().toISOString() };
      await this.store.upsert(next); this.loadedThreads.add(record.threadId);
      return this._public(next);
    }).catch(error => { throw this._wrap(error); });
  }

  async interrupt(sessionId) {
    try {
      return await this._enqueue(sessionId, async () => {
        this._assertAlive();
        const record = await this._require(sessionId);
        const active = this.inflight.get(record.sessionId);
        if (!active) throw new EngineError("NO_ACTIVE_TURN", "error.no_active_turn", {}, this.t);
        await this.ensureStarted();
        const pending = this.pendingOperations.get(record.sessionId);
        if (pending?.operation === "interrupt") throw new EngineError("TURN_STATE_UNKNOWN", "error.turn_state_unknown", {}, this.t);
        const operation = { operation: "interrupt", threadId: active.threadId, turnId: active.turnId, reason: null };
        this.pendingOperations.set(record.sessionId, operation);
        try { await this.client.request("turn/interrupt", {
          threadId: active.threadId,
          turnId: active.turnId,
        }); } catch (error) {
          if (error.code === "RPC_FAILED" || error.code === "NOT_READY" || error.code === "NOT_RUNNING") this.pendingOperations.delete(record.sessionId);
          else operation.reason = error.code ?? "UNKNOWN";
          throw error;
        }
        // The receipt only acknowledges the request. Completion is established
        // by turn/completed or readTurnState, never by this ACK alone.
        if (this.pendingOperations.get(record.sessionId) === operation) operation.reason = "AWAITING_COMPLETION";
        return {
          sessionId: record.sessionId,
          threadId: active.threadId,
          turnId: active.turnId,
          status: "interrupted",
        };
      });
    } catch (error) {
      throw this._wrap(error);
    }
  }

  async readSession(sessionId, options = {}) {
    try {
      this._assertAlive();
      const record = await this._require(sessionId);
      if (!this.ready) return this._public(record);
      if(record.unstarted===true)return {...this._public(record),thread:{id:record.threadId,turns:[]}};
      const result = await this.client.request("thread/read", {
        threadId: record.threadId,
        includeTurns: Boolean(options.includeTurns),
      });
      return {
        ...this._public(record),
        remoteThreadId: result?.thread?.id ?? null,
        thread: result.thread,
      };
    } catch (error) {
      throw this._wrap(error);
    }
  }

  async readTurnState(sessionId, turnId) {
    try {
      this._assertAlive();
      const record = await this._require(sessionId);
      await this.ensureStarted();
      await this.resumeSession(sessionId);
      const client = this.client;
      // This budget starts after cold startup/resume. A slow metadata read
      // expires independently of the running turn and never stops the child.
      const deadline = Date.now() + this.recoveryReadTimeoutMs;
      const pending = this.pendingOperations.get(sessionId);
      const target = turnId ?? this.inflight.get(sessionId)?.turnId ?? pending?.turnId;
      const unknownStart = !target && pending?.operation === "start";
      let cursor; const seen = new Set(); let found = null;
      for (let page = 0; page < 5; page++) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new EngineError("TIMEOUT", "error.timeout", {}, this.t);
        const result = await client.request("thread/turns/list", { threadId: record.threadId, limit: 20, sortDirection: "desc", itemsView: "notLoaded", ...(cursor ? { cursor } : {}) },
          { timeoutMs: Math.min(this.recoveryRequestTimeoutMs, remaining) });
        this._assertAlive();
        if (this.client !== client || !client.ready) throw new EngineError("PROCESS_EXIT", "error.process_exit", {}, this.t);
        if (Date.now() > deadline) throw new EngineError("TIMEOUT", "error.timeout", {}, this.t);
        if (!Array.isArray(result?.data)) throw new EngineError("PROTOCOL", "error.protocol", {}, this.t);
        found = target ? result.data.find(turn => turn?.id === target) : result.data[0];
        if (found || !target) break;
        if (typeof result.nextCursor !== "string" || !result.nextCursor || seen.has(result.nextCursor)) break;
        cursor = result.nextCursor; seen.add(cursor);
      }
      const known = !!found && !unknownStart && (TERMINAL_TURN_STATES.has(found.status) || found.status === "inProgress");
      if (known && TERMINAL_TURN_STATES.has(found.status)) {
        if (pending?.turnId === found.id) this.pendingOperations.delete(sessionId);
        this._onNotification({ method: "turn/completed", params: { threadId: record.threadId, turn: { ...found, items: [], itemsView: "notLoaded", reconciled: true } } });
      } else if (known && found.status === "inProgress") {
        const current = this.inflight.get(sessionId);
        if (!current || current.turnId === found.id) this.inflight.set(sessionId, { threadId: record.threadId, turnId: found.id });
        // A matching active turn resolves a lost start ACK, but not a pending
        // interrupt: that turn can still be stopping in the native process.
        if (pending?.operation !== "interrupt" && pending?.turnId === found.id) this.pendingOperations.delete(sessionId);
      }
      return { sessionId, threadId: record.threadId, turnId: target ?? (unknownStart ? null : found?.id ?? null),
        status: known ? found.status : "unknown", known, terminal: known && TERMINAL_TURN_STATES.has(found.status),
        active: known && found.status === "inProgress", error: known ? this._safeTurnError(found.error) : null,
        ...(unknownStart && found ? { candidateTurnId: found.id } : {}), pendingOperation: this.pendingOperations.get(sessionId) ?? null };
    } catch (error) { throw this._wrap(error); }
  }

  async listSessionItems(sessionId, options = {}) {
    try {
      this._assertAlive();
      const record = await this._require(sessionId);
      const page = this._historyPageOptions(options, false);
      await this.ensureStarted();
      if((await this._require(sessionId)).unstarted===true)return {data:[],nextCursor:null};
      await this.resumeSession(sessionId);
      if (isTurnItemsCursor(page.cursor)) return await legacyItemsPage(this.client, record.threadId, page, this.t);
      try {
        return await this.client.request("thread/items/list", { threadId: record.threadId, ...page });
      } catch (error) {
        if (error?.code !== "RPC_FAILED" || error.rpcCode !== -32601) throw error;
        return await legacyItemsPage(this.client, record.threadId, page, this.t);
      }
    } catch (error) {
      throw this._wrap(error);
    }
  }

  async listSessionTurns(sessionId, options = {}) {
    try {
      this._assertAlive();
      const record = await this._require(sessionId);
      const page = this._historyPageOptions(options, true);
      await this.ensureStarted();
      await this.resumeSession(sessionId);
      return await this.client.request("thread/turns/list", { threadId: record.threadId, ...page });
    } catch (error) {
      throw this._wrap(error);
    }
  }

  async listSessions() {
    try {
      this._assertAlive();
      await this.store.load();
      return this.store.list().map((record) => this._public(record));
    } catch (error) {
      throw this._wrap(error);
    }
  }

  async archiveSession(sessionId) {
    try {
      return await this._enqueue(sessionId, async () => {
        this._assertAlive();
        const record = await this._require(sessionId);
        await this.ensureStarted();
        if(record.unstarted!==true)await this.client.request("thread/archive", { threadId: record.threadId });
        const next = { ...record, archived: true, updatedAt: new Date().toISOString() };
        await this.store.upsert(next);
        return this._public(next);
      });
    } catch (error) {
      throw this._wrap(error);
    }
  }

  async restoreSession(sessionId) {
    return this._enqueue(sessionId, async () => {
      const record = await this._require(sessionId);
      await this.ensureStarted();
      if(record.unstarted!==true)await this.client.request("thread/unarchive", { threadId: record.threadId });
      const next = { ...record, archived: false, updatedAt: new Date().toISOString() };
      await this.store.upsert(next);
      return this._public(next);
    }).catch(error => { throw this._wrap(error); });
  }

  async renameSession(sessionId, name) {
    try {
      return await this._enqueue(sessionId, async () => {
        this._assertAlive();
        const record = await this._require(sessionId);
        if (typeof name !== "string" || !name.trim()) {
          throw new EngineError("INVALID_NAME", "error.invalid_name", {}, this.t);
        }
        await this.ensureStarted();
        if(record.unstarted!==true)await this.client.request("thread/name/set", { threadId: record.threadId, name });
        const next = { ...record, name, updatedAt: new Date().toISOString() };
        await this.store.upsert(next);
        return this._public(next);
      });
    } catch (error) {
      throw this._wrap(error);
    }
  }

  async forkSession(sessionId, newSessionId) {
    try {
      return await this._enqueue(sessionId, async () => {
        this._assertAlive();
        const record = await this._require(sessionId);
        const id = this._sessionId(newSessionId);
        await this.store.load();
        if (this.store.get(id)) throw new EngineError("SESSION_EXISTS", "error.session_exists", {}, this.t);
        await this.ensureStarted();
        const result = await this.client.request("thread/fork", { threadId: record.threadId, excludeTurns: true });
        const identity = this._identity(result, record.model,record.provider);
        const next = this._record({
          sessionId: id,
          threadId: identity.threadId,
          cwd: record.cwd,
          model: identity.model,
          provider: identity.provider,
          selection:record.selection,
          forkedFromSessionId: record.sessionId,
          instructionProfile: record.instructionProfile ?? null,
        });
        await this.store.upsert(next);
        return this._public(next);
      });
    } catch (error) {
      throw this._wrap(error);
    }
  }

  respondApproval(requestId, result) {
    if (!this._finishApproval(String(requestId), "answered", { result })) {
      throw new EngineError("APPROVAL_NOT_FOUND", "error.approval_not_found", {}, this.t);
    }
  }

  async dispose() {
    if (this.disposal) return this.disposal;
    this.disposal = this._dispose();
    return this.disposal;
  }

  async _dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.turnReconciler.dispose();
    this._cancelApprovals("disposed");
    const interrupts = [];
    for (const active of this.inflight.values()) {
      if (!this.client?.ready) break;
      interrupts.push(this.client.request("turn/interrupt", {
        threadId: active.threadId,
        turnId: active.turnId,
      }, { timeoutMs: 150 }).catch(() => {}));
    }
    if (interrupts.length) {
      await Promise.race([
        Promise.all(interrupts),
        new Promise((resolve) => setTimeout(resolve, 200)),
      ]);
    }
    this.inflight.clear();
    if (this.client) await this.client.dispose();
    if (this.starting) await bounded(this.starting);
    await bounded(this.store.writes);
    this.pendingOperations.clear(); this.completedTurns.clear(); this.seenTurnEvents.clear(); this.loadedThreads.clear();
    this._apiKey = null;
    this.removeAllListeners();
  }

  async ensureStarted() {
    this._assertAlive();
    if (this.client?.ready) return this.initResult;
    if (!this.starting) {
      this.starting = this._start().finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  async _start() {
    if (!this.binary) throw new EngineError("BINARY_REQUIRED", "error.binary_required", {}, this.t);
    // A broken stdin can leave a live process behind. Reap the previous child
    // before a replacement is allowed to execute any task.
    if (this.client && !this.client.ready) { await this.client.dispose(); this._assertAlive(); }
    const apiKey = await this.resolveApiKey();
    this._assertAlive();
    if (typeof apiKey !== "string" || apiKey.length === 0) {
      throw new EngineError("PROVIDER_UNAVAILABLE", "error.provider_unavailable", {}, this.t);
    }
    this._apiKey = apiKey;
    this.loadedThreads.clear();
    await mkdir(this.codexHome, { recursive: true, mode: 0o700 });
    assertIsolatedDataDir(this.dataDir, this.t);
    this._assertAlive();
    await writeFile(path.join(this.codexHome, "config.toml"), renderProviderConfig({
      model: this.model,
      provider: this.provider,
      baseUrl: this.baseUrl,
      sandbox: this.sandbox,
      approvalPolicy: this.approvalPolicy,
      networkRecovery: this.networkRecovery,
    })+(this.options.computerMcp?'\n[mcp_servers.dsh_computer]\nurl = '+JSON.stringify(this.options.computerMcp.url)+'\nbearer_token_env_var = "DSH_COMPUTER_BEARER"\nenabled = true\n':'')+(this.options.developmentMcp?'\n[mcp_servers.dsh_development]\nurl = '+JSON.stringify(this.options.developmentMcp.url)+'\nbearer_token_env_var = "DSH_DEVELOPMENT_BEARER"\nenabled = true\n':''), { encoding: "utf8", mode: 0o600 });
    this._assertAlive();
    const env = buildChildEnv({
      baseEnv: this.baseEnv,
      codexHome: this.codexHome,
      apiKey,
      extraEnv: {...this.extraEnv,...(this.options.developmentMcp?{DSH_DEVELOPMENT_BEARER:this.options.developmentMcp.bearer}:{}),...(this.options.computerMcp?{DSH_COMPUTER_BEARER:this.options.computerMcp.bearer}:{})},
    });
    const client = new AppServerClient({
      binary: this.binary,
      args: this.args,
      cwd: this.dataDir,
      env,
      secretValues: [apiKey],
      requestTimeoutMs: this.requestTimeoutMs,
      maxLineBytes: this.maxLineBytes,
    });
    this._wire(client);
    this.client = client;
    try {
      const init = await client.start();
      this._assertAlive();
      this._assertHome(init);
      this._bindApprovals();
      this.initResult = init;
      return init;
    } catch (error) {
      await client.dispose();
      if (this.client === client) this.client = null;
      throw error;
    }
  }

  _wire(client) {
    client.on("notification", (message) => {
      if (!this.disposed && this.client === client) {
        this._onNotification(message);
        this.turnReconciler.observe(client, message);
      }
    });
    client.on("stderr", (text) => { if (!this.disposed && this.client === client) this.emit("stderr", text); });
    client.on("protocol-error", (error) => {
      if (this.disposed || this.client !== client) return;
      this.emit("protocol-error", error);
      if (error.code === "LINE_TOO_LONG") this.turnReconciler.trigger(client);
    });
    client.on("server-request", (request) => { if (!this.disposed && this.client === client) this.emit("server-request", request); });
    client.on("exit", (info) => {
      if (this.client !== client) return;
      this.turnReconciler.cancel(client);
      this._cancelApprovals("cancelled");
      for (const [sessionId, active] of this.inflight) {
        if (!this.pendingOperations.has(sessionId)) this.pendingOperations.set(sessionId, { operation: "active", ...active, reason: "PROCESS_EXIT" });
      }
      this.inflight.clear();
      this.loadedThreads.clear();
      this.emit("exit", info);
    });
  }

  _bindApprovals() {
    for (const method of RECOGNIZED_SERVER_METHODS) {
      this.client.setHandler(method, (params, meta) => this._onServerRequest(method, params, meta));
    }
  }

  _onServerRequest(method, params, meta) {
    if (this.disposed) return Promise.reject(new EngineError("DISPOSED", "error.disposed", {}, this.t));
    const key = String(meta.id);
    if (this.pendingApprovals.has(key)) this._denyApproval(key, "cancelled");
    let settle;
    const promise = new Promise((resolve, reject) => {
      settle = { resolve, reject };
    });
    const approval = { ...settle, timer: null, method, threadId: params.threadId ?? params.conversationId ?? null };
    approval.timer = setTimeout(() => { if (this.pendingApprovals.get(key) === approval) this._denyApproval(key, "expired"); }, this._approvalWaitMs());
    this.pendingApprovals.set(key, approval);
    this.emit("approval-required", { id: meta.id, method, params });
    if (this.approvalHandler) {
      Promise.resolve().then(() => this.pendingApprovals.get(key) === approval
        ? this.approvalHandler({ id: meta.id, method, params }) : undefined)
        .then((result) => {
          if (this.pendingApprovals.get(key) !== approval) return;
          if (result === undefined) {
            this._denyApproval(key, "cancelled");
          } else this._finishApproval(key, "answered", { result });
        })
        .catch((error) => {
          if (this.pendingApprovals.get(key) !== approval) return;
          this._finishApproval(key, "failed", { error });
        });
    }
    return promise;
  }

  _finishApproval(key, reason, { result, error } = {}) {
    const pending = this.pendingApprovals.get(key);
    if (!pending) return false;
    this.pendingApprovals.delete(key);
    clearTimeout(pending.timer);
    if (error) pending.reject(error); else pending.resolve(result);
    this.emit("approval-resolved", { id: key, reason });
    return true;
  }

  _denyApproval(key, reason) {
    const pending = this.pendingApprovals.get(key);
    if (!pending) return;
    const denied = safeDenyResult(pending.method);
    if (denied) this._finishApproval(key, reason, { result: denied });
    else this._finishApproval(key, reason, { error: Object.assign(new Error("DENIED"), { code: -32001 }) });
  }

  _cancelApprovals(reason) {
    for (const key of [...this.pendingApprovals.keys()]) {
      this._finishApproval(key, reason, { error: new EngineError(reason === "disposed" ? "DISPOSED" : "PROCESS_EXIT",
        reason === "disposed" ? "error.disposed" : "error.process_exit", {}, this.t) });
    }
  }

  _approvalWaitMs() {
    if (this.approvalHandler) return this.approvalTimeoutMs;
    if (this.listenerCount("approval-required") > 0) return this.approvalTimeoutMs;
    return 0;
  }

  _onNotification(message) {
    if (this.disposed) return;
    if (message.method === "serverRequest/resolved") {
      const { requestId, threadId } = message.params ?? {};
      const key = String(requestId), pending = this.pendingApprovals.get(key);
      if (requestId != null && pending && (pending.threadId == null || pending.threadId === threadId)) {
        this.client?.cancelServerRequest(requestId, threadId);
        this._denyApproval(key, "cancelled");
      }
    } else if (message.method === "turn/completed") {
      const threadId = message.params?.threadId;
      const turn = message.params?.turn;
      if (threadId && turn?.id && TERMINAL_TURN_STATES.has(turn.status)) {
        const key = `${threadId}:${turn.id}`;
        if (this.completedTurns.has(key)) return;
        this._remember(this.completedTurns, key);
        for (const [sessionId, active] of this.inflight) {
          if (active.threadId === threadId && active.turnId === turn.id) this.inflight.delete(sessionId);
        }
        const record = this.store.findByThread(threadId);
        if (record) {
          if (this.pendingOperations.get(record.sessionId)?.turnId === turn.id) this.pendingOperations.delete(record.sessionId);
          this._emitTurn(record.sessionId, threadId, { ...turn, error: this._safeTurnError(turn.error) }, "completed");
        }
      } else return;
    } else if (message.method === "turn/started") {
      const threadId = message.params?.threadId;
      const turn = message.params?.turn;
      const record = threadId ? this.store.findByThread(threadId) : null;
      if (record && turn?.id && !this.completedTurns.has(`${threadId}:${turn.id}`)) {
        this.inflight.set(record.sessionId, { threadId, turnId: turn.id });
        const pending = this.pendingOperations.get(record.sessionId);
        if (pending?.operation === "start") pending.turnId = turn.id;
        this._emitTurn(record.sessionId, threadId, turn, "started");
      }
    } else if (message.method === "model/rerouted") {
      const record = this.store.findByThread(message.params?.threadId);
      if (record && !record.blocked) {
        const next = { ...record, blocked: "PROVIDER_REROUTED", updatedAt: new Date().toISOString() };
        void this.store.upsert(next).catch(() => this.emit("protocol-error", { code: "PERSIST_FAILED" }));
        this.emit("provider-diverged", { sessionId: record.sessionId, params: message.params });
      }
    }
    this.emit("notification", message);
  }

  _emitTurn(sessionId, threadId, turn, phase) {
    const key = `${phase}:${threadId}:${turn.id}`;
    if (this.seenTurnEvents.has(key)) return;
    this._remember(this.seenTurnEvents, key);
    this.emit(phase === "completed" ? "turn-completed" : "turn-started", {
      sessionId,
      threadId,
      turnId: turn.id,
      status: turn.status,
      error: this._safeTurnError(turn.error),
      turn,
      ...(turn.reconciled === true ? { reconciled: true } : {}),
    });
  }

  _remember(set, key) { set.add(key); while (set.size > this.eventHistoryLimit) set.delete(set.values().next().value); }
  _safeTurnError(error) {
    if (!error) return null;
    let codexErrorInfo = null;
    try {
      const encoded = JSON.stringify(error.codexErrorInfo ?? null);
      if (encoded.length <= 2048) codexErrorInfo = JSON.parse(redactText(encoded, [this._apiKey], 4096));
    } catch { /* Invalid provider metadata is not needed to display the error. */ }
    return { message: redactText(error.message ?? "", [this._apiKey], 1024), codexErrorInfo, additionalDetails: null, misalignment: null,
      ...(typeof error.code === "string" ? { code: redactText(error.code, [this._apiKey], 128) } : {}) };
  }

  _completeReconciledTurn(target, turn) {
    const active = this.inflight.get(target.sessionId);
    if (this.disposed || this.store.get(target.sessionId)?.threadId !== target.threadId
      || active?.threadId !== target.threadId || active?.turnId !== target.turnId
      || turn.id !== target.turnId || !TERMINAL_TURN_STATES.has(turn.status)) return false;
    const number = value => Number.isFinite(value) ? value : null;
    const slim = {
      id: turn.id, rootTurnId: typeof turn.rootTurnId === "string" ? turn.rootTurnId : null,
      status: turn.status, items: [], itemsView: "notLoaded", reconciled: true,
      startedAt: number(turn.startedAt), completedAt: number(turn.completedAt), durationMs: number(turn.durationMs),
      error: this._safeTurnError(turn.error),
    };
    this._onNotification({ method: "turn/completed", params: { threadId: target.threadId, turn: slim, reconciled: true } });
    return true;
  }

  _identity(result, expectedModel = this.model,expectedProvider=this.provider) {
    const threadId = result?.thread?.id;
    if (typeof threadId !== "string" || !threadId) {
      throw new EngineError("PROTOCOL", "error.protocol", {}, this.t);
    }
    if (result.modelProvider !== expectedProvider) {
      throw new EngineError("PROVIDER_MISMATCH", "error.provider_mismatch", {}, this.t);
    }
    if (result.model !== expectedModel) {
      throw new EngineError("MODEL_MISMATCH", "error.model_mismatch", {}, this.t);
    }
    return { threadId, model: result.model, provider: result.modelProvider };
  }

  _assertHome(init) {
    if (!init?.codexHome || path.resolve(init.codexHome) !== path.resolve(this.codexHome)) {
      throw new EngineError("HOME_MISMATCH", "error.home_mismatch", {}, this.t);
    }
  }

  async _require(sessionId) {
    const id = this._sessionId(sessionId);
    await this.store.load();
    const record = this.store.get(id);
    if (!record) throw new EngineError("SESSION_NOT_FOUND", "error.session_not_found", {}, this.t);
    return record;
  }

  _record(fields) {
    return {
      sessionId: fields.sessionId,
      threadId: fields.threadId,
      cwd: fields.cwd,
      model: fields.model,
      ...(fields.selection?{selection:fields.selection}:{}),
      provider: fields.provider,
      archived: false,
      name: null,
      blocked: null,
      instructionProfile: fields.instructionProfile ?? null,
      forkedFromSessionId: fields.forkedFromSessionId ?? null,
      updatedAt: new Date().toISOString(),
    };
  }

  _public(record) {
    return {
      sessionId: record.sessionId,
      threadId: record.threadId,
      cwd: record.cwd,
      model: record.selection??record.model,
      provider: record.provider,
      archived: Boolean(record.archived),
      name: record.name ?? null,
      blocked: record.blocked ?? null,
      instructionProfile: record.instructionProfile ? {id:record.instructionProfile.id,version:record.instructionProfile.version,instructionHash:record.instructionProfile.instructionHash} : null,
      forkedFromSessionId: record.forkedFromSessionId ?? null,
      updatedAt: record.updatedAt,
      updatedAtLabel: formatTime(record.updatedAt, this.locale),
      activeTurnId: this.inflight.get(record.sessionId)?.turnId ?? null,
      pendingOperation: this.pendingOperations.get(record.sessionId) ? { ...this.pendingOperations.get(record.sessionId) } : null,
    };
  }

  async _restartEmpty(record){
    const result=await this.client.request("thread/start",{model:record.model,modelProvider:record.provider,cwd:record.cwd,approvalPolicy:this.approvalPolicy,sandbox:this.sandbox,config:this._providerConfig(record),...await this._sharedProfileParams(record)});
    const identity=this._identity(result,record.model,record.provider);record.threadId=identity.threadId;await this.store.upsert(record);this.loadedThreads.add(record.threadId);this.emit("session",this._public(record));
  }
  async _sharedProfileParams(record){const params=this._profileParams(record);const current=await this.options.resolveSharedInstructions?.(record.cwd,record);if(current)params.developerInstructions=[params.developerInstructions,current].filter(Boolean).join("\n\n");return params;}

  _profileParams(record){return structuredClone(record.instructionProfile?.threadParams??{});}

  _historyPageOptions(options, turns) {
    const invalid = () => { throw new EngineError("INVALID_HISTORY_PAGE", "error.invalid_history_page", {}, this.t); };
    if (!options || typeof options !== "object" || Array.isArray(options)) invalid();
    const allowed = new Set(["cursor", "limit", "sortDirection", ...(turns ? ["itemsView"] : [])]);
    if (Object.keys(options).some(key => !allowed.has(key))) invalid();
    const limit = options.limit === undefined ? (turns ? 10 : 20) : options.limit;
    const sortDirection = options.sortDirection === undefined ? "desc" : options.sortDirection;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) invalid();
    if (sortDirection !== "asc" && sortDirection !== "desc") invalid();
    const cursor = options.cursor;
    if (cursor != null && (typeof cursor !== "string" || !cursor.trim())) invalid();
    const page = { limit, sortDirection };
    if (cursor !== undefined) page.cursor = cursor;
    if (turns) {
      const itemsView = options.itemsView === undefined ? "notLoaded" : options.itemsView;
      if (!["notLoaded", "summary", "full"].includes(itemsView)) invalid();
      page.itemsView = itemsView;
    }
    return page;
  }

  _sessionId(sessionId) {
    if (typeof sessionId !== "string" || !sessionId.trim() || sessionId.length > 200) {
      throw new EngineError("INVALID_SESSION", "error.invalid_session", {}, this.t);
    }
    if (/[/\0\\]/.test(sessionId)) throw new EngineError("INVALID_SESSION", "error.invalid_session", {}, this.t);
    return sessionId;
  }

  _cwd(cwd) {
    if (typeof cwd !== "string" || !path.isAbsolute(cwd)) {
      throw new EngineError("INVALID_CWD", "error.invalid_cwd", {}, this.t);
    }
    return cwd;
  }

  _assertAlive() {
    if (this.disposed) throw new EngineError("DISPOSED", "error.disposed", {}, this.t);
  }

  _enqueue(sessionId, fn) {
    const key = typeof sessionId === "string" ? sessionId : "";
    const previous = this.queues.get(key) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const settled = run.then(() => {}, () => {});
    this.queues.set(key, settled);
    settled.then(() => { if (this.queues.get(key) === settled) this.queues.delete(key); });
    return run;
  }

  _wrap(error) {
    if (error instanceof EngineError) return error;
    const code = typeof error?.code === "string" && CLIENT_ERROR_KEYS[error.code] ? error.code : "RPC_FAILED";
    return new EngineError(code, CLIENT_ERROR_KEYS[code], { rpcCode: error?.rpcCode ?? "" }, this.t);
  }
}

function stateKey(state) {
  if (state === "turn-active") return "state.turn_active";
  if (state === "disposed") return "state.disposed";
  if (state === "ready") return "state.ready";
  if (state === "starting") return "state.starting";
  return "state.idle";
}

function blockedKey(code) {
  if (code === "PROVIDER_REROUTED") return "error.provider_rerouted";
  return "error.unsupported";
}

function normalizeText(input, translator) {
  const text = typeof input === "string" ? input : input?.text;
  if (typeof text !== "string" || !text.trim()) {
    throw new EngineError("INVALID_INPUT", "error.invalid_input", {}, translator);
  }
  return text;
}

export function createEngine(options) {
  return new CodexEngine(options);
}
