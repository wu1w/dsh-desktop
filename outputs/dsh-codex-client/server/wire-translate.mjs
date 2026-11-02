// A text/tool protocol bridge. Unsupported modalities fail before any provider
// request; streamed tools are released only after a verified upstream terminal.
import {randomUUID} from 'node:crypto';
const uid = prefix => `${prefix}_${randomUUID().replaceAll('-', '')}`;
const fault = code => { throw Object.assign(new Error(code), {code}); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const TERMINALS = new Set(['stop', 'tool_calls', 'length', 'content_filter']);
const LIMIT = 32 * 1024 * 1024;
export const canTranslate = (providerApi, requestedApi) => providerApi === 'openai-completions' && ['openai-responses', 'anthropic-messages'].includes(requestedApi);
function checkApi(api) { if (!['openai-responses', 'anthropic-messages'].includes(api)) fault('MODEL_PROTOCOL_INVALID'); }
function parseArguments(value) {
  try { const parsed = JSON.parse(value || '{}'); if (object(parsed)) return parsed; } catch {}
  fault('MODEL_PROTOCOL_INVALID');
}
function textContent(content, allowed = ['text', 'input_text', 'output_text']) {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (!Array.isArray(content)) fault('MODEL_INPUT_UNSUPPORTED');
  return content.map(part => {
    if (!object(part) || !allowed.includes(part.type) || typeof part.text !== 'string') fault('MODEL_INPUT_UNSUPPORTED');
    return part.text;
  }).join('');
}
function inputToMessages(input) {
  if (typeof input === 'string') return [{role:'user', content:input}];
  if (!Array.isArray(input)) fault('MODEL_INPUT_UNSUPPORTED');
  const messages = [];
  for (const item of input) {
    if (!object(item)) fault('MODEL_INPUT_UNSUPPORTED');
    // Responses reasoning items are metadata, not user-visible conversation.
    if (item.type === 'reasoning') continue;
    if (['function_call', 'custom_tool_call'].includes(item.type)) {
      const custom = item.type === 'custom_tool_call';
      if (custom && typeof item.input !== 'string') fault('MODEL_INPUT_UNSUPPORTED');
      const call = {id:item.call_id ?? item.id, type:'function', function:{name:item.name, arguments:custom ? JSON.stringify({input:item.input}) : item.arguments ?? '{}'}};
      if (!call.id || !call.function.name) fault('MODEL_INPUT_UNSUPPORTED');
      const previous = messages.at(-1);
      // A single assistant message owns all parallel calls before their results.
      if (previous?.role === 'assistant' && previous.tool_calls) previous.tool_calls.push(call);
      else messages.push({role:'assistant', content:null, tool_calls:[call]});
      continue;
    }
    if (['function_call_output', 'custom_tool_call_output'].includes(item.type)) {
      if (!item.call_id) fault('MODEL_INPUT_UNSUPPORTED');
      messages.push({role:'tool', tool_call_id:item.call_id, content:textContent(item.output)});
      continue;
    }
    const role = item.role === 'developer' ? 'system' : item.role;
    if (!['system', 'user', 'assistant'].includes(role)) fault('MODEL_INPUT_UNSUPPORTED');
    messages.push({role, content:textContent(item.content)});
  }
  return messages;
}
function toolsFromResponses(tools) {
  return (tools ?? []).map(tool => {
    if (!object(tool) || !['function','custom'].includes(tool.type) || !tool.name) fault('MODEL_TOOL_UNSUPPORTED');
    return {type:'function', function:{name:tool.name, description:(tool.description ?? '') + (tool.type === 'custom' && tool.format?.definition ? '\nRequired input syntax:\n' + tool.format.definition : ''), parameters:tool.type === 'custom'
      ? {type:'object', properties:{input:{type:'string', description:'The complete raw input for this tool, following its documented syntax.'}}, required:['input'], additionalProperties:false}
      : tool.parameters ?? {type:'object', properties:{}}}};
  });
}
function requestFromResponses(body) {
  const out = {model:body.model, messages:[], stream:Boolean(body.stream)};
  if (body.previous_response_id) fault('MODEL_INPUT_UNSUPPORTED'); // this bridge has no server-side history
  if (body.instructions) out.messages.push({role:'system', content:body.instructions});
  out.messages.push(...inputToMessages(body.input));
  const tools = toolsFromResponses(body.tools);
  if (tools.length) out.tools = tools;
  if (body.tool_choice) {
    if (typeof body.tool_choice === 'string' && ['auto','required','none'].includes(body.tool_choice)) out.tool_choice = body.tool_choice;
    else if (['function','custom'].includes(body.tool_choice.type) && body.tool_choice.name) out.tool_choice = {type:'function', function:{name:body.tool_choice.name}};
    else fault('MODEL_TOOL_UNSUPPORTED');
  }
  if (body.max_output_tokens) out.max_tokens = body.max_output_tokens;
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (body.parallel_tool_calls != null) out.parallel_tool_calls = body.parallel_tool_calls;
  if (out.stream) out.stream_options = {include_usage:true};
  return out;
}
function requestFromMessages(body) {
  const messages = [], system = textContent(body.system, ['text']);
  if (system) messages.push({role:'system', content:system});
  for (const message of body.messages ?? []) {
    const blocks = typeof message.content === 'string' ? [{type:'text', text:message.content}] : message.content;
    if (!Array.isArray(blocks) || !['user','assistant'].includes(message.role)) fault('MODEL_INPUT_UNSUPPORTED');
    if (blocks.some(b => !object(b) || !['text','tool_use','tool_result','thinking','redacted_thinking'].includes(b.type))) fault('MODEL_INPUT_UNSUPPORTED');
    const text = textContent(blocks.filter(b => b.type === 'text'), ['text']);
    const uses = blocks.filter(b => b.type === 'tool_use'), results = blocks.filter(b => b.type === 'tool_result');
    if (uses.length && results.length) fault('MODEL_INPUT_UNSUPPORTED');
    if (results.length) {
      for (const result of results) messages.push({role:'tool', tool_call_id:result.tool_use_id, content:(result.is_error ? 'Tool error: ' : '') + textContent(result.content, ['text'])});
      if (text) messages.push({role:'user', content:text});
    } else if (uses.length) {
      messages.push({role:'assistant', content:text || null, tool_calls:uses.map(use => ({id:use.id, type:'function', function:{name:use.name, arguments:JSON.stringify(use.input ?? {})}}))});
    } else if (text) messages.push({role:message.role, content:text});
  }
  const out = {model:body.model, messages, stream:Boolean(body.stream)};
  for (const field of ['max_tokens','temperature','top_p']) if (body[field] != null) out[field] = body[field];
  if (body.stop_sequences) out.stop = body.stop_sequences;
  if (body.tools) out.tools = body.tools.map(tool => {
    if (!tool.name || tool.type && tool.type !== 'custom') fault('MODEL_TOOL_UNSUPPORTED');
    return {type:'function', function:{name:tool.name, description:tool.description ?? '', parameters:tool.input_schema ?? {type:'object', properties:{}}}};
  });
  if (body.tool_choice) {
    const choice = body.tool_choice;
    if (choice.type === 'tool' && choice.name) out.tool_choice = {type:'function', function:{name:choice.name}};
    else if (['any','none','auto'].includes(choice.type)) out.tool_choice = choice.type === 'any' ? 'required' : choice.type;
    else fault('MODEL_TOOL_UNSUPPORTED');
  }
  if (out.stream) out.stream_options = {include_usage:true};
  return out;
}
export function translateRequest(requestedApi, body) {
  checkApi(requestedApi);
  return requestedApi === 'openai-responses' ? requestFromResponses(body) : requestFromMessages(body);
}
// Reuse the exact admission rules before dispatch; this never performs IO.
export function assertTranslatableInput(requestedApi, body) { translateRequest(requestedApi, body); }
function usageOf(usage) {
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const input_tokens = count(usage?.prompt_tokens), output_tokens = count(usage?.completion_tokens);
  return {input_tokens, output_tokens, total_tokens:input_tokens + output_tokens};
}
function terminal(reason) {
  if (reason === 'insufficient_system_resource' || reason === 'aborted') fault('MODEL_STREAM_INCOMPLETE');
  if (!TERMINALS.has(reason)) fault(reason == null ? 'MODEL_STREAM_INCOMPLETE' : 'MODEL_PROTOCOL_INVALID');
  return reason;
}
const statusOf = reason => ['length','content_filter'].includes(reason) ? 'incomplete' : 'completed';
const stopOf = reason => reason === 'length' ? 'max_tokens' : reason === 'tool_calls' ? 'tool_use' : reason === 'content_filter' ? 'refusal' : 'end_turn';
function outputFor(text, calls, reason, options = {}) {
  const output = [];
  if (text) output.push({type:'message', id:options.itemId ?? uid('msg'), role:'assistant', status:statusOf(reason), content:[{type:'output_text', text, annotations:[]}]});
  // Never release a partially generated tool command on token/filter truncation.
  if (statusOf(reason) !== 'completed') return output;
  if (calls.length && reason !== 'tool_calls' || !calls.length && reason === 'tool_calls') fault('MODEL_PROTOCOL_INVALID');
  for (const call of calls) {
    if (typeof call.id !== 'string' || !call.id || typeof call.function?.name !== 'string' || !call.function.name || typeof call.function.arguments !== 'string') fault('MODEL_PROTOCOL_INVALID');
    const parsed = parseArguments(call.function.arguments);
    const custom = options.tools?.some(t => t.type === 'custom' && t.name === call.function.name);
    const id = call.itemId ?? uid('fc');
    if (custom) {
      if (typeof parsed.input !== 'string' || Object.keys(parsed).some(k => k !== 'input')) fault('MODEL_PROTOCOL_INVALID');
      output.push({type:'custom_tool_call', id, call_id:call.id, name:call.function.name, input:parsed.input, status:'completed'});
    } else output.push({type:'function_call', id, call_id:call.id, name:call.function.name, arguments:call.function.arguments, status:'completed'});
  }
  return output;
}
function responseOf(output, reason, model, usage, id = uid('resp')) {
  const status = statusOf(reason);
  return {id, object:'response', created_at:Math.floor(Date.now()/1000), model, status, output, usage:usageOf(usage),
    ...(status === 'incomplete' ? {incomplete_details:{reason:reason === 'length' ? 'max_output_tokens' : 'content_filter'}} : {})};
}
export function translateJson(requestedApi, json, model, options = {}) {
  checkApi(requestedApi);
  if (json?.error) fault('MODEL_REQUEST_FAILED');
  const choice = json?.choices?.[0];
  if (!object(choice?.message)) fault('MODEL_PROTOCOL_INVALID');
  const reason = terminal(choice.finish_reason), text = textContent(choice.message.content);
  const output = outputFor(text, choice.message.tool_calls ?? [], reason, options);
  if (requestedApi === 'openai-responses') return responseOf(output, reason, model, json.usage);
  const usage = usageOf(json.usage);
  return {id:uid('msg'), type:'message', role:'assistant', model, content:output.map(item => item.type === 'message'
    ? {type:'text', text:item.content[0].text} : {type:'tool_use', id:item.call_id, name:item.name, input:parseArguments(item.arguments)}),
    stop_reason:stopOf(reason), stop_sequence:null, usage:{input_tokens:usage.input_tokens, output_tokens:usage.output_tokens}};
}
function sse(res, event, data) { if (event) res.write(`event: ${event}\n`); res.write(`data: ${JSON.stringify(data)}\n\n`); }

export function createStreamTranslator(requestedApi, model, res, options = {}) {
  checkApi(requestedApi);
  let buffer = '', data = [], text = '', started = false, textStarted = false, finishReason = null, done = false, ended = false, failed = false, usage;
  let bytes = 0, sequence = 0;
  const responseId = uid('resp'), messageId = uid('msg'), itemId = uid('msg'), calls = new Map();
  const active = () => { if (options.signal?.aborted || res.destroyed || res.writableEnded) fault('MODEL_REQUEST_CANCELLED'); };
  const write = (event, value) => { active(); sse(res, event, value); };
  const emit = value => write(value.type, {...value, sequence_number:sequence++});
  const start = () => {
    if (started) return; started = true;
    if (requestedApi === 'openai-responses') {
      const response = {id:responseId, object:'response', status:'in_progress', model, output:[]};
      emit({type:'response.created', response}); emit({type:'response.in_progress', response});
    } else write('message_start', {type:'message_start', message:{id:messageId, type:'message', role:'assistant', model, content:[], stop_reason:null, stop_sequence:null, usage:{input_tokens:0, output_tokens:0}}});
  };
  const onText = delta => {
    start(); text += delta;
    if (requestedApi === 'openai-responses') {
      if (!textStarted) {
        emit({type:'response.output_item.added', output_index:0, item:{type:'message', id:itemId, role:'assistant', status:'in_progress', content:[]}});
        emit({type:'response.content_part.added', item_id:itemId, output_index:0, content_index:0, part:{type:'output_text', text:'', annotations:[]}});
      }
      emit({type:'response.output_text.delta', item_id:itemId, output_index:0, content_index:0, delta});
    } else {
      if (!textStarted) write('content_block_start', {type:'content_block_start', index:0, content_block:{type:'text', text:''}});
      write('content_block_delta', {type:'content_block_delta', index:0, delta:{type:'text_delta', text:delta}});
    }
    textStarted = true;
  };
  const dispatch = () => {
    if (!data.length) return;
    const payload = data.join('\n').trim(); data = [];
    if (!payload) return;
    if (done) fault('MODEL_PROTOCOL_INVALID');
    if (payload === '[DONE]') { terminal(finishReason); done = true; return; }
    let json; try { json = JSON.parse(payload); } catch { fault('MODEL_PROTOCOL_INVALID'); }
    if (!object(json)) fault('MODEL_PROTOCOL_INVALID');
    if (json.error) fault('MODEL_REQUEST_FAILED');
    if (json.usage != null) usage = json.usage;
    if (!Array.isArray(json.choices)) fault('MODEL_PROTOCOL_INVALID');
    if (!json.choices.length) return; // usage-only chunk
    const choice = json.choices[0];
    if (!object(choice) || json.choices.length !== 1 || choice.index != null && choice.index !== 0) fault('MODEL_PROTOCOL_INVALID');
    if (finishReason != null) fault('MODEL_PROTOCOL_INVALID');
    const delta = choice.delta ?? {};
    if (!object(delta)) fault('MODEL_PROTOCOL_INVALID');
    if (delta.content != null && typeof delta.content !== 'string') fault('MODEL_PROTOCOL_INVALID');
    if (delta.content) onText(delta.content);
    if (delta.tool_calls != null && !Array.isArray(delta.tool_calls)) fault('MODEL_PROTOCOL_INVALID');
    for (const call of delta.tool_calls ?? []) {
      const index = call.index;
      if (!Number.isSafeInteger(index) || index < 0 || index > 1024) fault('MODEL_PROTOCOL_INVALID');
      const current = calls.get(index) ?? {id:'', itemId:uid('fc'), function:{name:'', arguments:''}};
      if (call.id != null) { if (typeof call.id !== 'string' || current.id && current.id !== call.id) fault('MODEL_PROTOCOL_INVALID'); current.id = call.id; }
      for (const field of ['name','arguments']) if (call.function?.[field] != null) {
        if (typeof call.function[field] !== 'string') fault('MODEL_PROTOCOL_INVALID');
        current.function[field] += call.function[field];
      }
      calls.set(index, current);
    }
    if (choice.finish_reason != null) finishReason = terminal(choice.finish_reason);
  };
  const line = value => {
    if (!value) { dispatch(); return; }
    if (value.startsWith(':')) return;
    if (value.startsWith('data:')) data.push(value.slice(5).replace(/^ /, ''));
    else if (value === 'data') data.push('');
    else if (value.startsWith('event:') && value.slice(6).trim() === 'error') fault('MODEL_REQUEST_FAILED');
  };
  const guard = fn => { if (ended || failed) fault('MODEL_PROTOCOL_INVALID'); try { active(); return fn(); } catch (error) { failed = true; throw error; } };
  return {
    push(chunk) { return guard(() => {
      if (typeof chunk !== 'string') fault('MODEL_PROTOCOL_INVALID');
      bytes += Buffer.byteLength(chunk); if (bytes > LIMIT) fault('MODEL_PROTOCOL_LIMIT');
      buffer += chunk;
      let match;
      while ((match = /\r\n|\r|\n/.exec(buffer))) {
        // A CR at the chunk boundary may be the first half of CRLF.
        if (match[0] === '\r' && match.index === buffer.length - 1) break;
        const value = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length); line(value);
      }
    }); },
    finish() { return guard(() => {
      if (buffer.endsWith('\r')) { line(buffer.slice(0,-1)); buffer = ''; }
      if (buffer) { line(buffer); buffer = ''; }
      dispatch();
      if (!done || finishReason == null) fault('MODEL_STREAM_INCOMPLETE');
      const ordered = [...calls.entries()].sort(([a],[b]) => a-b).map(([,call]) => call);
      const output = outputFor(text, ordered, finishReason, {...options, itemId});
      // Validate every tool first. No partial/invalid tool can escape on failure.
      start();
      if (textStarted) {
        if (requestedApi === 'openai-responses') {
          emit({type:'response.output_text.done', item_id:itemId, output_index:0, content_index:0, text});
          emit({type:'response.content_part.done', item_id:itemId, output_index:0, content_index:0, part:output[0].content[0]});
          emit({type:'response.output_item.done', output_index:0, item:output[0]});
        } else write('content_block_stop', {type:'content_block_stop', index:0});
      }
      for (const [index,item] of output.entries()) {
        if (item.type === 'message') continue;
        if (requestedApi === 'openai-responses') {
          const custom = item.type === 'custom_tool_call', field = custom ? 'input' : 'arguments', kind = custom ? 'custom_tool_call_input' : 'function_call_arguments';
          emit({type:'response.output_item.added', output_index:index, item:{...item, [field]:'', status:'in_progress'}});
          emit({type:`response.${kind}.delta`, item_id:item.id, output_index:index, delta:item[field]});
          emit({type:`response.${kind}.done`, item_id:item.id, output_index:index, [field]:item[field]});
          emit({type:'response.output_item.done', output_index:index, item});
        } else {
          write('content_block_start', {type:'content_block_start', index, content_block:{type:'tool_use', id:item.call_id, name:item.name, input:{}}});
          write('content_block_delta', {type:'content_block_delta', index, delta:{type:'input_json_delta', partial_json:item.arguments}});
          write('content_block_stop', {type:'content_block_stop', index});
        }
      }
      if (requestedApi === 'openai-responses') emit({type:`response.${statusOf(finishReason)}`, response:responseOf(output, finishReason, model, usage, responseId)});
      else {
        const counts = usageOf(usage);
        write('message_delta', {type:'message_delta', delta:{stop_reason:stopOf(finishReason), stop_sequence:null}, usage:{input_tokens:counts.input_tokens, output_tokens:counts.output_tokens}});
        write('message_stop', {type:'message_stop'});
      }
      ended = true;
    }); },
  };
}
export const contentTypeFor = () => 'text/event-stream; charset=utf-8';
