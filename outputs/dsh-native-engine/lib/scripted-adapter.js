import { LlmAdapter } from "@deepseek-ai/dsh-llm";

/** Test double that still enters the real agent loop through LlmAdapter. */
export class ScriptedAdapter extends LlmAdapter {
  constructor(handler) {
    super();
    this.handler = handler;
    this.calls = [];
  }

  providerInfo(provider) {
    return { id: provider, name: "Scripted DeepSeek" };
  }

  info(provider, model) {
    return {
      provider,
      id: model,
      name: model,
      context: { contextWindow: 128000 },
      reasoning: { efforts: ["low", "high", "max"].map(id=>({id,name:id})), defaultEffort:"high" },
      inputModalities: ["text"],
      systemPromptUpdate: "in-history",
      toolUpdate: "addition-only",
    };
  }

  async listModels(provider) {
    return [this.info(provider, "deepseek-v4.1-flash")];
  }

  async resolveModel(provider, model) {
    return this.info(provider, model);
  }

  async prepareCall(provider, model) {
    return { model: this.info(provider, model), stream: (options) => this.stream(options) };
  }

  stream(options) {
    const adapter = this;
    return {
      async *[Symbol.asyncIterator]() {
        adapter.calls.push(options);
        const result = await adapter.handler(options, adapter.calls.length - 1);
        if (result?.hang) {
          await new Promise((resolve, reject) => {
            const abort = () => reject(options.signal?.reason instanceof Error ? options.signal.reason : new Error("aborted"));
            if (options.signal?.aborted) { abort(); return; }
            options.signal?.addEventListener("abort", abort, { once: true });
          });
          return;
        }
        for (const chunk of result ?? []) {
          if (options.signal?.aborted) throw options.signal.reason instanceof Error ? options.signal.reason : new Error("aborted");
          yield chunk;
        }
      },
    };
  }
}

export function textChunk(text) {
  return [
    { type: "text-delta", index: 0, text },
    { type: "finish", reason: { kind: "stop" } },
  ];
}

export function toolChunk(name, args, id = `call_${name}`) {
  return [
    { type: "tool-call-delta", index: 0, id, name, argumentsDelta: JSON.stringify(args) },
    { type: "finish", reason: { kind: "stop" } },
  ];
}
