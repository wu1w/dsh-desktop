import readline from 'node:readline';
import { appendFileSync } from 'node:fs';
let sequence = 0;
const threads = new Map(), pending = new Map();
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
const identity = thread => ({ thread: { id: thread.id }, model: thread.model, modelProvider: thread.modelProvider });
for await (const line of readline.createInterface({ input: process.stdin })) {
  const message = JSON.parse(line), { id, method, params = {} } = message;
  if (!method) {
    if (process.env.DSH_APPROVAL_CAPTURE) appendFileSync(process.env.DSH_APPROVAL_CAPTURE, JSON.stringify(message) + '\n');
    const native = pending.get(id);
    if (native) { pending.delete(id); send({ method: 'turn/completed', params: { threadId: native.threadId, turn: { id: native.turnId, status: 'completed', items: [], itemsView: 'notLoaded' } } }); }
    continue;
  }
  if (method === 'initialized') continue;
  if (method === 'initialize') { send({ id, result: { codexHome: process.env.CODEX_HOME, userAgent: 'isolated-approval-probe' } }); continue; }
  if (method === 'thread/start') { const thread = { id: 'owned-thread-' + ++sequence, ...params }; threads.set(thread.id, thread); send({ id, result: identity(thread) }); continue; }
  if (method === 'thread/resume') { send({ id, result: identity(threads.get(params.threadId)) }); continue; }
  if (method === 'turn/start') {
    const turnId = 'owned-turn-' + ++sequence;
    send({ id, result: { turn: { id: turnId, status: 'inProgress', items: [], itemsView: 'notLoaded' } } });
    send({ method: 'turn/started', params: { threadId: params.threadId, turn: { id: turnId, status: 'inProgress', items: [] } } });
    const requestId = 7000 + sequence; pending.set(requestId, { threadId: params.threadId, turnId });
    send({ id: requestId, method: 'item/tool/requestUserInput', params: { threadId: params.threadId, turnId, itemId: 'question-' + sequence, isBlocking: true, autoResolutionMs: null, questions: [
      { id: 'choice', header: 'Choice', question: 'Choose a format', isOther: false, isSecret: false, options: [{ label: 'Markdown', description: 'Readable text' }, { label: 'JSON', description: 'Structured output' }] },
      { id: 'secret', header: 'Secret', question: 'Optional private value', isOther: true, isSecret: true, options: null },
      { id: 'skip', header: 'Skip', question: 'May be unanswered', isOther: true, isSecret: false, options: null },
    ] } }); continue;
  }
  if (method === 'turn/interrupt') { send({ id, result: {} }); send({ method: 'turn/completed', params: { threadId: params.threadId, turn: { id: params.turnId, status: 'interrupted', items: [], itemsView: 'notLoaded' } } }); continue; }
  if (method === 'thread/queue/list') { send({ id, result: { data: [], nextCursor: null } }); continue; }
  send({ id, result: {} });
}
