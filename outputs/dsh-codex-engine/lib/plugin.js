import { Service } from "@deepseek-ai/cordis";
import { CodexEngine } from "./engine.js";

export class CodexEngineService extends Service {
  static inject = [];

  constructor(ctx, config) {
    super(ctx, "codexEngine", config);
    this.engine = new CodexEngine(config);
    ctx.effect(() => async () => {
      await this.engine.dispose();
    });
  }

  get ready() { return this.engine?.ready ?? false; }
  get state() { return this.engine?.state ?? "idle"; }
  get activeTurns() { return this.engine?.activeTurns ?? new Map(); }

  start() { return this.engine.start(); }
  ensureStarted() { return this.engine.ensureStarted(); }
  createSession(sessionId, options) { return this.engine.createSession(sessionId, options); }
  resumeSession(sessionId) { return this.engine.resumeSession(sessionId); }
  startTurn(sessionId, input, options) { return this.engine.startTurn(sessionId, input, options); }
  interrupt(sessionId) { return this.engine.interrupt(sessionId); }
  steer(sessionId, input) { return this.engine.steer(sessionId, input); }
  readSession(sessionId, options) { return this.engine.readSession(sessionId, options); }
  readTurnState(sessionId, turnId) { return this.engine.readTurnState(sessionId, turnId); }
  listSessionItems(sessionId, options) { return this.engine.listSessionItems(sessionId, options); }
  listSessionTurns(sessionId, options) { return this.engine.listSessionTurns(sessionId, options); }
  listSessions() { return this.engine.listSessions(); }
  queueRequest(sessionId, action, params) { return this.engine.queueRequest(sessionId, action, params); }
  moveSession(sessionId, cwd) { return this.engine.moveSession(sessionId, cwd); }
  setModel(sessionId, model) { return this.engine.setModel(sessionId, model); }
  archiveSession(sessionId) { return this.engine.archiveSession(sessionId); }
  restoreSession(sessionId) { return this.engine.restoreSession(sessionId); }
  renameSession(sessionId, name) { return this.engine.renameSession(sessionId, name); }
  forkSession(sessionId, newSessionId) { return this.engine.forkSession(sessionId, newSessionId); }
  respondApproval(requestId, result) { return this.engine.respondApproval(requestId, result); }
  status() { return this.engine.status(); }
  dispose() { return this.engine.dispose(); }
}

export async function apply(ctx, config) {
  await ctx.plugin(CodexEngineService, config);
}

export default apply;
