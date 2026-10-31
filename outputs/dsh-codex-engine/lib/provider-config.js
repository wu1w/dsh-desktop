import os from "node:os";
import path from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { EngineError } from "./errors.js";

export const DEFAULT_MODEL = "deepseek-v4.1-flash";
export const DEFAULT_PROVIDER = "opencode_go";
export const DEFAULT_BASE_URL = "https://opencode.ai/inference/go/openai/v1";
export const API_KEY_ENV = "DSH_OPENCODE_GO_KEY";
export const ALLOWED_SANDBOX = new Set(["read-only", "workspace-write", "danger-full-access"]);

export function isolatedCodexHome(dataDir) {
  return path.resolve(dataDir, "codex");
}

export function assertIsolatedDataDir(dataDir, translator) {
  if (!dataDir || typeof dataDir !== "string") {
    throw new EngineError("DATA_DIR_REQUIRED", "error.data_dir_required", {}, translator);
  }
  const resolvedData = path.resolve(dataDir);
  const resolvedHome = isolatedCodexHome(resolvedData);
  const unsafe = path.resolve(os.homedir(), ".codex");
  if ([resolvedData, resolvedHome, canonical(resolvedData), canonical(resolvedHome)].some(value => isInside(value, unsafe) || isInside(value, canonical(unsafe)))) {
    throw new EngineError("UNSAFE_CODEX_HOME", "error.unsafe_codex_home", {}, translator);
  }
  return { dataDir: resolvedData, codexHome: resolvedHome };
}

function canonical(value) {
  if (existsSync(value)) return realpathSync(value);
  const parent = path.dirname(value);
  return parent === value ? value : path.join(canonical(parent), path.basename(value));
}

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function assertSandbox(sandbox, translator) {
  if (!ALLOWED_SANDBOX.has(sandbox)) {
    throw new EngineError("SANDBOX_REJECTED", "error.sandbox_rejected", {}, translator);
  }
}

export function tomlString(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

export function normalizeNetworkRecovery(options = {}) {
  const value = (key, fallback, maximum) => {
    const selected = options[key] ?? fallback;
    if (!Number.isSafeInteger(selected) || selected < 0 || selected > maximum) throw new Error("INVALID_NETWORK_RECOVERY");
    return selected;
  };
  return { request_max_retries: value("requestMaxRetries", 6, 100), stream_max_retries: value("streamMaxRetries", 8, 100), stream_idle_timeout_ms: value("streamIdleTimeoutMs", 300_000, 86_400_000) };
}

export function renderProviderConfig({ model, provider, baseUrl, sandbox, approvalPolicy, networkRecovery }) {
  if (!/^[A-Za-z0-9_-]+$/.test(provider)) {
    throw new Error("INVALID_PROVIDER");
  }
  const recovery = normalizeNetworkRecovery(networkRecovery);
  return [
    `model = ${tomlString(model)}`,
    `model_provider = ${tomlString(provider)}`,
    `approval_policy = ${tomlString(approvalPolicy)}`,
    `sandbox_mode = ${tomlString(sandbox)}`,
    'web_search = "disabled"',
    'shell_environment_policy = { inherit = "core" }',
    "",
    `[model_providers.${provider}]`,
    `name = ${tomlString(provider === DEFAULT_PROVIDER ? "OpenCode Go" : provider)}`,
    `base_url = ${tomlString(baseUrl)}`,
    `env_key = ${tomlString(API_KEY_ENV)}`,
    `wire_api = "responses"`,
    "requires_openai_auth = false",
    "supports_websockets = false",
    ...Object.entries(recovery).map(([key, value]) => `${key} = ${value}`),
    "",
    "[features]",
    "code_mode = false",
    "",
    "[analytics]",
    "enabled = false",
    "",
  ].join("\n");
}

export function threadProviderConfig({ provider, baseUrl, networkRecovery }) {
  return {
    features: { code_mode: false },
    web_search: "disabled",
    model_providers: {
      [provider]: {
        name: provider === DEFAULT_PROVIDER ? "OpenCode Go" : provider,
        base_url: baseUrl,
        env_key: API_KEY_ENV,
        wire_api: "responses",
        requires_openai_auth: false,
        supports_websockets: false,
        ...normalizeNetworkRecovery(networkRecovery),
      },
    },
  };
}

export function buildChildEnv({ baseEnv, codexHome, apiKey, extraEnv }) {
  const env = { ...baseEnv };
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  delete env.OPENAI_BASE_URL;
  delete env.OPENAI_API_BASE;
  if (extraEnv) {
    for (const [key, value] of Object.entries(extraEnv)) {
      if (key === "OPENAI_API_KEY" || key === "CODEX_API_KEY" || key === "OPENAI_BASE_URL") continue;
      env[key] = value;
    }
  }
  env.CODEX_HOME = codexHome;
  env[API_KEY_ENV] = apiKey;
  return env;
}
