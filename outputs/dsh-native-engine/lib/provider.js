import { DeepSeekAdapter } from "@deepseek-ai/dsh-llm-deepseek";
import { EngineError } from "./errors.js";

export const PROVIDER = "opencode_go";
export const DEFAULT_MODEL = "deepseek-v4.1-flash";
/** Official DeepSeek adapter speaks the Anthropic Messages protocol. */
export const DEFAULT_BASE_URL = "https://opencode.ai/inference/go/anthropic";

export function createOpenCodeAdapter({ baseUrl = DEFAULT_BASE_URL, model = DEFAULT_MODEL, resolveApiKey, translator }) {
  const connection = () => ({
    baseURL: baseUrl,
    defaults: {},
    maxTokens: 32000,
    defaultContextWindow: 1_000_000,
    streamIdleTimeoutMs: 300_000,
    models: [{
      id: model,
      name: "DeepSeek V4.1 Flash",
      contextWindow: 1_000_000,
      inputModalities: ["text"],
      systemPromptUpdate: "in-history",
      toolUpdate: "addition-only",
    }],
  });
  return new DeepSeekAdapter({
    // Same empty extension contract as the upstream registerDeepSeekProvider factory.
    prepareExtensions: async () => ({fields:{},accept:async()=>{}}),
    providerName: "OpenCode Go",
    options: connection,
    resolveUserId: () => "dsh-native-engine",
    resolveAuth: async () => {
      const key = await resolveApiKey?.();
      if (typeof key !== "string" || key.length === 0) throw new EngineError("MISSING_API_KEY", translator("missing_key"));
      return { headers: { "x-api-key": key } };
    },
    discoverModels: async (provider) => connection().models.map((entry) => ({ provider, ...entry })),
  });
}
