import { appendFileSync, writeFileSync } from "node:fs";
import readline from "node:readline";

const scenario = process.env.FAKE_SCENARIO || "ok";
const tracePath = process.env.FAKE_TRACE_PATH || "";
const probePath = process.env.FAKE_PROBE_PATH || "";
const secret = process.env.DSH_OPENCODE_GO_KEY || "";

if (probePath) {
  writeFileSync(probePath, JSON.stringify({
    codexHome: process.env.CODEX_HOME ?? null,
    hasOpenAI: Object.hasOwn(process.env, "OPENAI_API_KEY"),
    hasCodexApi: Object.hasOwn(process.env, "CODEX_API_KEY"),
    hasGoKey: Boolean(secret),
    keyInArgv: secret ? process.argv.join("\n").includes(secret) : false,
    argv: process.argv.slice(1),
  }));
}

if (scenario === "stderr-secret") {
  process.stderr.write(`debug DSH_OPENCODE_GO_KEY=${secret} OPENAI_API_KEY=sk-supersecretvalue Bearer ${secret}\n`);
}

const threads = new Map();
const runtimeTurns = new Map();
let sequence = 1;

function trace(direction, message) {
  if (!tracePath) return;
  appendFileSync(tracePath, `${JSON.stringify({ direction, msg: message })}\n`);
}

function send(message) {
  trace("out", message);
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function threadResult(thread) {
  return {
    thread: { id: thread.id },
    model: thread.model,
    modelProvider: thread.modelProvider,
    serviceTier: null,
    disabledPluginIds: [],
    cwd: thread.cwd,
    runtimeWorkspaceRoots: [],
    instructionSources: [],
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: { type: "readOnly", networkAccess: false },
    activePermissionProfile: null,
    reasoningEffort: null,
    multiAgentMode: "explicitRequestOnly",
  };
}

function remember(params, id = `thread-${sequence++}`) {
  const provider = scenario === "provider-mismatch" ? "openai" : params.modelProvider;
  const model = scenario === "provider-mismatch" ? "gpt-5.4" : params.model;
  const thread = {
    id,
    cwd: params.cwd,
    model,
    modelProvider: provider,
  };
  threads.set(id, thread);
  return thread;
}

function historyTurns(threadId) {
  return Array.from({ length: 12 }, (_, turnIndex) => {
    const turnId = `${threadId}-turn-${turnIndex + 1}`;
    return {
      id: turnId, rootTurnId: null, status: "completed", error: null,
      startedAt: 100 + turnIndex, completedAt: 101 + turnIndex, durationMs: 1000,
      itemsView: "full",
      items: Array.from({ length: 4 }, (_, itemIndex) => ({
        type: "agentMessage", id: `${threadId}-item-${turnIndex * 4 + itemIndex + 1}`,
        text: scenario === "legacy-history-huge" ? "x".repeat(3000) : `history ${turnIndex + 1}.${itemIndex + 1}`,
      })),
    };
  });
}

function historyPage(method, params) {
  if (!threads.has(params.threadId)) throw new Error("unknown thread");
  const turns = historyTurns(params.threadId);
  const isTurns = method === "thread/turns/list";
  const data = isTurns ? turns : turns.flatMap(turn => turn.items.map(item => ({
    turnId: turn.id, item, startedAtMs: turn.startedAt * 1000, completedAtMs: turn.completedAt * 1000,
  })));
  if (params.sortDirection === "desc") data.reverse();
  let offset = 0;
  if (params.cursor) {
    const decoded = JSON.parse(Buffer.from(params.cursor, "base64url").toString("utf8"));
    if (decoded.threadId !== params.threadId || decoded.method !== method || decoded.sortDirection !== params.sortDirection || !Number.isInteger(decoded.offset)) throw new Error("invalid cursor");
    offset = decoded.offset;
  }
  const encode = (index, direction = params.sortDirection) => Buffer.from(JSON.stringify({ threadId: params.threadId, method, sortDirection: direction, offset: index })).toString("base64url");
  const page = data.slice(offset, offset + params.limit).map(entry => isTurns
    ? { ...entry, itemsView: params.itemsView, items: params.itemsView === "notLoaded" ? [] : entry.items }
    : entry);
  return {
    data: page,
    nextCursor: offset + page.length < data.length ? encode(offset + page.length) : null,
    backwardsCursor: page.length ? encode(Math.max(0, data.length - offset - 1), params.sortDirection === "desc" ? "asc" : "desc") : null,
  };
}

function handle(message) {
  const { id, method, params = {} } = message;
  if (scenario.startsWith("reliability-") && method === "fixture/complete") {
    const turn = runtimeTurns.get(params.threadId);
    if (turn) { turn.status = params.status ?? "completed"; turn.error = params.error ?? null; }
    send({ jsonrpc: "2.0", id, result: {} });
    if (turn && params.notify !== false) send({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: params.threadId, turn } });
    return;
  }
  if (method === "thread/items/list" || method === "thread/turns/list") {
    if (scenario.startsWith("reliability-") && method === "thread/turns/list") {
      const turn = runtimeTurns.get(params.threadId);
      if (scenario === "reliability-read-stall") {
        setTimeout(() => send({ jsonrpc: "2.0", id, result: { data: turn ? [{ ...turn, status: "completed", items: [], itemsView: "notLoaded" }] : [], nextCursor: null } }), 200);
        return;
      }
      if (scenario === "reliability-read-paged") {
        setTimeout(() => send({ jsonrpc: "2.0", id, result: { data: [], nextCursor: String(Number(params.cursor ?? 0) + 1) } }), 40);
        return;
      }
      send({ jsonrpc: "2.0", id, result: { data: turn ? [{ ...turn, items: [], itemsView: "notLoaded" }] : [], nextCursor: null } });
      return;
    }
    if (scenario.startsWith("reconcile-") && method === "thread/turns/list") {
      const current = runtimeTurns.get(params.threadId);
      let turns = current ? [{ ...current, items: [], itemsView: "notLoaded" }] : [];
      if (scenario === "reconcile-missing") turns = [{ ...current, id: "some-other-terminal-turn", status: "completed", items: [], itemsView: "notLoaded" }];
      if (scenario === "reconcile-paged") turns = [...Array.from({ length: 14 }, (_, index) => ({ ...current, id: `newer-${index}`, status: "completed", items: [], itemsView: "notLoaded" })), ...turns];
      if (scenario === "reconcile-probe-too-large") turns[0].error = { message: "x".repeat(2 * 1024 * 1024) };
      const offset = Number(params.cursor ?? 0), data = turns.slice(offset, offset + params.limit);
      send({ jsonrpc: "2.0", id, result: { data, nextCursor: offset + data.length < turns.length ? String(offset + data.length) : null, backwardsCursor: data.length ? "fixture-anchor" : null } });
      if (scenario === "reconcile-duplicate" && current && !threads.get(params.threadId).duplicateScheduled) {
        threads.get(params.threadId).duplicateScheduled = true;
        setTimeout(() => send({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: params.threadId, turn: { ...current, items: [], itemsView: "notLoaded" } } }), 80);
      }
      return;
    }
    if (method === "thread/items/list" && scenario.startsWith("legacy-history")) {
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: "thread/items/list is not supported yet" } });
      return;
    }
    if (method === "thread/items/list" && scenario === "history-rpc-error") {
      send({ jsonrpc: "2.0", id, error: { code: -32000, message: "unrelated failure" } });
      return;
    }
    try {
      send({ jsonrpc: "2.0", id, result: historyPage(method, params) });
    } catch {
      send({ jsonrpc: "2.0", id, error: { code: -32602, message: "Invalid history page" } });
    }
    return;
  }
  if (method === "thread/start") {
    send({ jsonrpc: "2.0", id, result: threadResult(remember(params)) });
    return;
  }
  if (method === "thread/resume" || method === "thread/fork") {
    const existing = threads.get(params.threadId);
    const thread = method === "thread/fork"
      ? remember(existing ?? params)
      : existing ?? remember(params, params.threadId);
    send({ jsonrpc: "2.0", id, result: threadResult(thread) });
    return;
  }
  if (method === "thread/read") {
    if (scenario.startsWith("reconcile-")) {
      const current = runtimeTurns.get(params.threadId);
      const response = { jsonrpc: "2.0", id, result: { thread: { id: params.threadId, status: { type: current?.status === "inProgress" ? "active" : "idle", activeFlags: [] },
        ...(scenario === "reconcile-probe-too-large" ? { preview: "x".repeat(2 * 1024 * 1024) } : {}) }, readState: null } };
      if (scenario === "reconcile-delayed") setTimeout(() => send(response), 200);
      else send(response);
      if (scenario === "reconcile-superseded") send({ jsonrpc: "2.0", method: "turn/started", params: { threadId: params.threadId, turn: { ...current, id: "newer-active-turn", status: "inProgress" } } });
      return;
    }
    if (scenario === "hang") return;
    if (scenario === "oversized-read" && params.threadId === "pending") return;
    if (scenario === "oversized-read" && (params.threadId === "oversized" || params.includeTurns)) {
      send({ jsonrpc: "2.0", id, result: { thread: { id: params.threadId, preview: "中".repeat(400) } } });
      send({ jsonrpc: "2.0", method: "warning", params: { message: "after-oversized-response" } });
      return;
    }
    const thread = threads.get(params.threadId) ?? remember(params, params.threadId);
    send({ jsonrpc: "2.0", id, result: { thread: { id: thread.id }, readState: null } });
    return;
  }
  if (method === "turn/start" || (scenario.startsWith("reliability-") && method === "thread/queue/start")) {
    if (scenario === "crash-on-turn") process.exit(7);
    if (scenario === "hang-turn") return;
    const turnId = `turn-${sequence++}`;
    const turn = {
      id: turnId,
      rootTurnId: null,
      items: [],
      itemsView: "notLoaded",
      status: "inProgress",
      error: null,
      startedAt: 1,
      completedAt: null,
      durationMs: null,
    };
    if (scenario.startsWith("reliability-")) {
      runtimeTurns.set(params.threadId, turn);
      if (scenario !== "reliability-lost-start-ack" && scenario !== "reliability-lost-start-all") send({ jsonrpc: "2.0", id, result: { turn } });
      if (scenario !== "reliability-lost-start-all") send({ jsonrpc: "2.0", method: "turn/started", params: { threadId: params.threadId, turn } });
      return;
    }
    send({ jsonrpc: "2.0", id, result: { turn } });
    if (scenario.startsWith("reconcile-")) {
      const status = scenario === "reconcile-failed" ? "failed" : scenario === "reconcile-interrupted" ? "interrupted"
        : ["reconcile-inprogress", "reconcile-probe-too-large"].includes(scenario) ? "inProgress" : "completed";
      const actual = { ...turn, status, completedAt: status === "inProgress" ? null : 2, durationMs: status === "inProgress" ? null : 1000,
        error: status === "failed" ? { message: `native failure ${secret}`, codexErrorInfo: null, additionalDetails: null, misalignment: null } : null };
      runtimeTurns.set(params.threadId, actual);
      send({ jsonrpc: "2.0", method: status === "inProgress" ? "item/completed" : "turn/completed", params: status === "inProgress"
        ? { threadId: params.threadId, turnId, item: { type: "agentMessage", id: "giant-item", text: "x".repeat(2 * 1024 * 1024) } }
        : { threadId: params.threadId, turn: { ...actual, itemsView: "full", items: [{ type: "agentMessage", id: "giant-item", text: "x".repeat(2 * 1024 * 1024) }] } } });
      return;
    }
    if (scenario.startsWith("approval") || scenario === "deny-approval") {
      const legacy = scenario.includes("legacy");
      send({
        jsonrpc: "2.0",
        id: 7001,
        method: scenario === "approval-legacy-exec" ? "execCommandApproval" : scenario === "approval-legacy-patch" ? "applyPatchApproval" : "item/commandExecution/requestApproval",
        params: legacy ? { conversationId: params.threadId, callId: "call-1", command: ["pwd"], cwd: process.cwd(), reason: null, parsedCmd: [], approvalId: null, fileChanges: {}, grantRoot: null } : {
          kind: "command",
          threadId: params.threadId,
          turnId,
          itemId: "item-1",
          startedAtMs: 1,
          environmentId: null,
          command: "pwd",
        },
      });
      if (scenario === "approval-native-resolved" || scenario === "approval-native-mismatch") {
        setTimeout(() => send({ jsonrpc: "2.0", method: "serverRequest/resolved", params: { threadId: scenario === "approval-native-mismatch" ? "other-thread" : params.threadId, requestId: 7001 } }), 30);
      }
      if (scenario === "approval-exit") setTimeout(() => process.exit(7), 30);
    }
    return;
  }
  if (method === "turn/interrupt") {
    if (scenario === "reliability-interrupt-ack-only") { send({ jsonrpc: "2.0", id, result: {} }); return; }
    if (scenario === "reliability-lost-interrupt-ack") return;
    send({ jsonrpc: "2.0", id, result: {} });
    send({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: {
        threadId: params.threadId,
        turn: {
          id: params.turnId,
          rootTurnId: null,
          items: [],
          itemsView: "notLoaded",
          status: "interrupted",
          error: null,
          startedAt: 1,
          completedAt: 2,
          durationMs: 1,
        },
      },
    });
    return;
  }
  if (method === "turn/steer" ) {
    send({ jsonrpc: "2.0", id, result: { turnId: params.expectedTurnId } });
    return;
  }
  if (method === "thread/archive") {
    if (scenario === "archive-fail") {
      send({ jsonrpc: "2.0", id, error: { code: -32000, message: "archive failed" } });
      return;
    }
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (method === "thread/name/set") {
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
}

const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  trace("in", message);
  if (message.method === "initialize" && message.id != null) {
    if (scenario === "init-fail") {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "init failed" } });
      return;
    }
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        userAgent: "fake-app-server",
        codexHome: process.env.CODEX_HOME,
        platformFamily: "unix",
        platformOs: "macos",
      },
    });
    return;
  }
  if (message.method === "initialized") {
    if (scenario === "unknown-after-init") {
      send({ jsonrpc: "2.0", id: 9001, method: "custom/unknown", params: {} });
    }
    if (scenario === "bad-json") {
      process.stdout.write("not-json\n");
      send({ jsonrpc: "2.0", method: "warning", params: { message: "still-alive" } });
    }
    if (scenario === "huge-line") {
      process.stdout.write(`${"x".repeat(256 * 1024)}\n`);
      send({ jsonrpc: "2.0", method: "warning", params: { message: "after-huge" } });
    }
    if (scenario === "crash-after-init") process.exit(9);
    return;
  }
  if (message.method == null) return;
  handle(message);
});
