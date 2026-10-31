export { CodexEngine, createEngine } from "./engine.js";
export { AppServerClient } from "./jsonrpc-client.js";

export const SUPPORTED_ENGINE_METHODS = [
  "start",
  "createSession",
  "resumeSession",
  "startTurn",
  "interrupt",
  "steer",
  "readSession",
  "readTurnState",
  "listSessionItems",
  "listSessionTurns",
  "listSessions",
  "archiveSession",
  "renameSession",
  "forkSession",
  "respondApproval",
  "status",
  "dispose",
];

export const SUPPORTED_RPC = [
  "initialize",
  "initialized",
  "thread/start",
  "thread/resume",
  "thread/read",
  "thread/items/list",
  "thread/turns/list",
  "thread/fork",
  "thread/archive",
  "thread/name/set",
  "turn/start",
  "turn/steer",
  "turn/interrupt",
];

export const DEFERRED = [
  "dsh-agent-factory",
  "transcript-adapter",
  "codex-ui",
  "voice",
  "browser",
  "remote-control",
  "filesystem-rpc",
  "account-login",
  "mcp-lifecycle",
  "thread/list-import",
];

export function describeEngine() {
  return {
    package: "@dsh/codex-engine",
    version: "0.1.0",
    service: "codexEngine",
    provider: "opencode_go",
    model: "deepseek-v4.1-flash",
    wireApi: "responses",
    apiKeyEnv: "DSH_OPENCODE_GO_KEY",
    supportedEngineMethods: SUPPORTED_ENGINE_METHODS,
    supportedRpc: SUPPORTED_RPC,
    deferred: DEFERRED,
  };
}
