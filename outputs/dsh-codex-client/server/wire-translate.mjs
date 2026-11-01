// 协议转换：让只提供 openai-completions 的供应商，也能服务只讲
// openai-responses（Codex）或 anthropic-messages（Claude Code）的引擎。
//
// 设计取舍：
//  - 文本增量实时转发，保证"逐字出现"的观感；
//  - 工具调用（tool_calls / tool_use）在流结束时一次性给出，避免把三方
//    流式工具协议互相映射带来的复杂度；
//  - 只做单向：任何协议 -> openai-completions。反方向不缺场景。

const uid = (prefix) => `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;

export const canTranslate = (providerApi, requestedApi) =>
  providerApi === 'openai-completions' &&
  (requestedApi === 'openai-responses' || requestedApi === 'anthropic-messages');

const safeParse = (text) => {
  try { return JSON.parse(text || '{}'); } catch { return {}; }
};

// ---------- 请求：responses -> completions ----------

function inputToMessages(input) {
  const messages = [];
  if (typeof input === 'string') return [{ role: 'user', content: input }];

  for (const item of input ?? []) {
    if (!item) continue;

    if (item.type === 'function_call') {
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [{ id: item.call_id ?? item.id, type: 'function', function: { name: item.name, arguments: item.arguments ?? '{}' } }],
      });
      continue;
    }

    if (item.type === 'function_call_output') {
      const output = typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '');
      messages.push({ role: 'tool', tool_call_id: item.call_id, content: output });
      continue;
    }

    const role = item.role === 'developer' ? 'system' : item.role;
    if (!role) continue;
    const parts = Array.isArray(item.content) ? item.content : [{ type: 'input_text', text: String(item.content ?? '') }];
    const text = parts.map((part) => part.text ?? part.input_text ?? '').join('');
    if (text) messages.push({ role, content: text });
  }
  return messages;
}

function toolsFromResponses(tools) {
  return (tools ?? [])
    .filter((tool) => tool && (tool.type === 'function' || tool.name))
    .map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description ?? '',
        parameters: tool.parameters ?? { type: 'object', properties: {} },
      },
    }));
}

function requestFromResponses(body) {
  const out = {
    model: body.model,
    messages: [],
    stream: Boolean(body.stream),
  };
  if (body.instructions) out.messages.push({ role: 'system', content: body.instructions });
  out.messages.push(...inputToMessages(body.input));

  const tools = toolsFromResponses(body.tools);
  if (tools.length) out.tools = tools;

  if (body.tool_choice) {
    if (typeof body.tool_choice === 'string') out.tool_choice = body.tool_choice;
    else if (body.tool_choice.name) out.tool_choice = { type: 'function', function: { name: body.tool_choice.name } };
  }
  if (body.max_output_tokens) out.max_tokens = body.max_output_tokens;
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  return out;
}

// ---------- 请求：anthropic messages -> completions ----------

function requestFromMessages(body) {
  const messages = [];
  const system = Array.isArray(body.system)
    ? body.system.map((part) => part.text ?? '').join('')
    : body.system;
  if (system) messages.push({ role: 'system', content: system });

  for (const message of body.messages ?? []) {
    const blocks = Array.isArray(message.content) ? message.content : [{ type: 'text', text: String(message.content ?? '') }];
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const toolUses = blocks.filter((b) => b.type === 'tool_use');
    const toolResults = blocks.filter((b) => b.type === 'tool_result');

    if (toolResults.length) {
      for (const result of toolResults) {
        const content = typeof result.content === 'string' ? result.content : JSON.stringify(result.content ?? '');
        messages.push({ role: 'tool', tool_call_id: result.tool_use_id, content });
      }
      if (text) messages.push({ role: 'user', content: text });
      continue;
    }

    if (toolUses.length) {
      messages.push({
        role: 'assistant',
        content: text || null,
        tool_calls: toolUses.map((use) => ({
          id: use.id,
          type: 'function',
          function: { name: use.name, arguments: JSON.stringify(use.input ?? {}) },
        })),
      });
      continue;
    }

    if (text) messages.push({ role: message.role, content: text });
  }

  const out = { model: body.model, messages, stream: Boolean(body.stream) };
  if (body.max_tokens) out.max_tokens = body.max_tokens;
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (body.stop_sequences) out.stop = body.stop_sequences;
  if (body.tools) {
    out.tools = body.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description ?? '',
        parameters: tool.input_schema ?? { type: 'object', properties: {} },
      },
    }));
  }
  if (body.tool_choice) {
    const choice = body.tool_choice;
    out.tool_choice = choice.type === 'any' ? 'required' : choice.type === 'none' ? 'none'
      : choice.name ? { type: 'function', function: { name: choice.name } } : 'auto';
  }
  return out;
}

export function translateRequest(requestedApi, body) {
  return requestedApi === 'openai-responses' ? requestFromResponses(body) : requestFromMessages(body);
}

// ---------- 响应：completions -> 目标协议 ----------

const usageOf = (usage) => ({
  inputTokens: usage?.prompt_tokens ?? 0,
  outputTokens: usage?.completion_tokens ?? 0,
});

const stopForResponses = (reason) =>
  reason === 'length' ? 'incomplete' : 'completed';

const stopForMessages = (reason) =>
  reason === 'length' ? 'max_tokens' : reason === 'tool_calls' ? 'tool_use' : 'end_turn';

export function translateJson(requestedApi, json, model) {
  const message = json?.choices?.[0]?.message ?? {};
  const finish = json?.choices?.[0]?.finish_reason;
  const usage = usageOf(json?.usage);

  if (requestedApi === 'openai-responses') {
    const output = [];
    if (message.content) {
      output.push({
        type: 'message', id: uid('msg'), role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: message.content, annotations: [] }],
      });
    }
    for (const call of message.tool_calls ?? []) {
      output.push({
        type: 'function_call', id: uid('fc'), call_id: call.id,
        name: call.function?.name, arguments: call.function?.arguments ?? '{}', status: 'completed',
      });
    }
    return {
      id: uid('resp'), object: 'response', created_at: Math.floor(Date.now() / 1000),
      model, status: stopForResponses(finish), output,
      usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens, total_tokens: usage.inputTokens + usage.outputTokens },
    };
  }

  const content = [];
  if (message.content) content.push({ type: 'text', text: message.content });
  for (const call of message.tool_calls ?? []) {
    content.push({ type: 'tool_use', id: call.id, name: call.function?.name, input: safeParse(call.function?.arguments) });
  }
  return {
    id: uid('msg'), type: 'message', role: 'assistant', model, content,
    stop_reason: stopForMessages(finish),
    usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens },
  };
}

// ---------- 流式：把 completions 的 SSE 转成目标协议的 SSE ----------

function sse(res, event, data) {
  if (event) res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * 返回一个 { push(chunkText), finish() } 消费器。
 * push 接收上游 SSE 的原始文本片段（可能半行），内部按行解析。
 */
export function createStreamTranslator(requestedApi, model, res) {
  let buffer = '';
  let text = '';
  let started = false;
  let textDone = false;
  let messageId = uid('msg');
  let itemId = uid('msg');
  let finishReason = null;
  const calls = new Map(); // index -> { id, name, arguments }

  const start = () => {
    if (started) return;
    started = true;
    if (requestedApi === 'openai-responses') {
      sse(res, null, { type: 'response.created', response: { id: uid('resp'), object: 'response', status: 'in_progress', model, output: [] } });
    } else {
      sse(res, 'message_start', {
        type: 'message_start',
        message: { id: messageId, type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } },
      });
    }
  };

  const onTextDelta = (delta) => {
    start();
    text += delta;
    if (requestedApi === 'openai-responses') {
      if (!textDone) {
        if (text === delta) {
          sse(res, null, {
            type: 'response.output_item.added', output_index: 0,
            item: { type: 'message', id: itemId, role: 'assistant', status: 'in_progress', content: [] },
          });
        }
        sse(res, null, { type: 'response.output_text.delta', item_id: itemId, output_index: 0, content_index: 0, delta });
      }
    } else {
      if (text === delta) sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: delta } });
    }
  };

  const handleLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') return;

    let json;
    try { json = JSON.parse(payload); } catch { return; }

    const choice = json.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;

    const delta = choice.delta ?? {};
    if (typeof delta.content === 'string' && delta.content) onTextDelta(delta.content);

    for (const call of delta.tool_calls ?? []) {
      const index = call.index ?? 0;
      const current = calls.get(index) ?? { id: call.id ?? uid('call'), name: '', arguments: '' };
      if (call.id) current.id = call.id;
      if (call.function?.name) current.name += call.function.name;
      if (call.function?.arguments) current.arguments += call.function.arguments;
      calls.set(index, current);
    }
  };

  const flushText = () => {
    if (textDone) return;
    textDone = true;
    if (!started) return;
    if (!text) return;
    if (requestedApi === 'openai-responses') {
      sse(res, null, { type: 'response.output_text.done', item_id: itemId, output_index: 0, content_index: 0, text });
      sse(res, null, {
        type: 'response.output_item.done', output_index: 0,
        item: { type: 'message', id: itemId, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] },
      });
    } else {
      sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
    }
  };

  const flushTools = () => {
    let index = text ? 1 : 0;
    for (const call of calls.values()) {
      if (requestedApi === 'openai-responses') {
        sse(res, null, {
          type: 'response.output_item.added', output_index: index,
          item: { type: 'function_call', id: uid('fc'), call_id: call.id, name: call.name, arguments: '', status: 'in_progress' },
        });
        sse(res, null, { type: 'response.function_call_arguments.delta', item_id: call.id, output_index: index, delta: call.arguments });
        sse(res, null, {
          type: 'response.output_item.done', output_index: index,
          item: { type: 'function_call', id: uid('fc'), call_id: call.id, name: call.name, arguments: call.arguments, status: 'completed' },
        });
      } else {
        sse(res, 'content_block_start', {
          type: 'content_block_start', index,
          content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} },
        });
        sse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: call.arguments || '{}' } });
        sse(res, 'content_block_stop', { type: 'content_block_stop', index });
      }
      index += 1;
    }
  };

  return {
    push(chunk) {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        handleLine(line);
      }
    },
    finish() {
      if (buffer.trim()) handleLine(buffer);
      buffer = '';
      start();
      flushText();
      flushTools();

      const usage = { input_tokens: 0, output_tokens: 0 };
      if (requestedApi === 'openai-responses') {
        sse(res, null, {
          type: 'response.completed',
          response: {
            id: uid('resp'), object: 'response', status: stopForResponses(finishReason), model,
            output: [], usage: { ...usage, total_tokens: 0 },
          },
        });
      } else {
        sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: stopForMessages(finishReason), stop_sequence: null }, usage });
        sse(res, 'message_stop', { type: 'message_stop' });
      }
    },
  };
}

export const contentTypeFor = (requestedApi) => 'text/event-stream; charset=utf-8';
