import test from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalBroker, approvalResult, userInputResult } from '../server/approvals.mjs';

const questions = { questions: [{ id: 'choice' }, { id: 'secret', isSecret: true }, { id: 'skip' }] };
const request = { id: 7, method: 'item/tool/requestUserInput', params: questions };
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('answers retain individual question identity and explicit skips without copying a secret to another question', () => {
  const body = { allow: true, answers: { choice: { answers: ['Selected option'] }, secret: { answers: ['private test value'] }, skip: { answers: [] } } };
  const result = userInputResult(questions, body);
  assert.deepEqual(result, { answers: { choice: { answers: ['Selected option'] }, secret: { answers: ['private test value'] } } });
  body.answers.secret.answers[0] = 'mutated'; assert.equal(result.answers.secret.answers[0], 'private test value');
  assert.deepEqual(userInputResult(questions, { allow: false, answers: { secret: { answers: ['never sent'] } } }), { answers: {} });
  assert.deepEqual(userInputResult(questions, { allow: true, answers: {} }), { answers: {} });
});

test('unknown questions, old shared-answer payloads and malformed values cannot consume a pending input request', () => {
  for (const body of [{ allow: 'false', answers: {} }, { allow: true, answer: 'shared' }, { allow: true, answers: { unknown: { answers: ['x'] } } }, { allow: true, answers: { choice: ['x'] } }, { allow: true, answers: { choice: { answers: [1] } } }, { allow: true, answers: { choice: { answers: ['x'], extra: true } } }, { allow: true, answers: { choice: { answers: ['x'.repeat(20001)] } } }]) {
    assert.throws(() => userInputResult(questions, body));
  }
  assert.throws(() => userInputResult({ questions: [{ id: 'duplicate' }, { id: 'duplicate' }] }, { allow: true, answers: {} }), { code: 'INVALID_USER_QUESTIONS' });
  const special = JSON.parse('{"__proto__":{"answers":["literal answer"]}}');
  const result = userInputResult({ questions: [{ id: '__proto__' }] }, { allow: true, answers: special });
  assert.equal(Object.getPrototypeOf(result.answers), Object.prototype); assert.equal(Object.hasOwn(result.answers, '__proto__'), true);
});

test('concurrent answers execute once, and broadcasts never contain submitted secret values', async () => {
  const calls = [], events = [], pending = gate();
  const engine = { respondApproval: async (...args) => { calls.push(args); await pending.promise; } };
  const broker = new ApprovalBroker({ broadcast: event => events.push(event) }); const visible = broker.receive(engine, request);
  const submitting = broker.answer(visible.id, { allow: true, answers: { secret: { answers: ['SECRET_MUST_STAY_PRIVATE'] } } });
  await assert.rejects(broker.answer(visible.id, { allow: false }), { code: 'APPROVAL_BUSY' });
  pending.resolve(); await submitting;
  assert.equal(calls.length, 1); assert.equal(calls[0][0], 7); assert.equal(broker.list().length, 0);
  assert.equal(JSON.stringify(events).includes('SECRET_MUST_STAY_PRIVATE'), false);
  await assert.rejects(broker.answer(visible.id, { allow: true, answers: {} }), { code: 'APPROVAL_NOT_FOUND' });
});

test('an engine swap cannot send a late approval to a new engine reusing the same native ID', async () => {
  const oldCalls = [], newCalls = [], events = [];
  const oldEngine = { respondApproval: async (...args) => oldCalls.push(args) }, nextEngine = { respondApproval: async (...args) => newCalls.push(args) };
  const broker = new ApprovalBroker({ broadcast: event => events.push(event) }); const old = broker.receive(oldEngine, request);
  broker.clear(oldEngine); const next = broker.receive(nextEngine, request); assert.notEqual(next.id, old.id);
  await assert.rejects(broker.answer(old.id, { allow: false }), { code: 'APPROVAL_NOT_FOUND' });
  await broker.answer(next.id, { allow: false }); assert.equal(oldCalls.length, 0); assert.equal(newCalls.length, 1);
  assert.equal(events.filter(event => event.type === 'approval-resolved' && event.id === old.id).length, 1);
});

test('native resolution removes just its engine request while a transient submit failure remains retryable', async () => {
  const broker = new ApprovalBroker(); let failures = 1;
  const engine = { respondApproval: async () => { if (failures--) throw Object.assign(new Error('temporary'), { code: 'RPC' }); } };
  const first = broker.receive(engine, request), second = broker.receive(engine, { ...request, id: 8 });
  broker.resolved(engine, { id: 7, reason: 'expired' }); assert.deepEqual(broker.list().map(item => item.id), [second.id]);
  await assert.rejects(broker.answer(first.id, { allow: false }), { code: 'APPROVAL_NOT_FOUND' });
  await assert.rejects(broker.answer(second.id, { allow: false }), { code: 'RPC' });
  assert.equal(broker.list().length, 1); await broker.answer(second.id, { allow: false }); assert.equal(broker.list().length, 0);
});

test('registration snapshots permission content and duplicate replays keep the same public request', async () => {
  const calls = [], broker = new ApprovalBroker(), engine = { respondApproval: async (...args) => calls.push(args) };
  const incoming = { id: 1, method: 'item/permissions/requestApproval', params: { permissions: { network: { enabled: false } } } };
  const visible = broker.receive(engine, incoming); incoming.params.permissions.network.enabled = true;
  assert.equal(broker.receive(engine, incoming).id, visible.id); await broker.answer(visible.id, { allow: true });
  assert.deepEqual(calls[0][1], { permissions: { network: { enabled: false } }, scope: 'turn' });
});

test('legacy and current approval decisions match their native wire shapes and unsupported approvals stay denied', () => {
  for (const method of ['execCommandApproval', 'applyPatchApproval']) {
    assert.deepEqual(approvalResult({ method }, { allow: true }), { decision: 'approved' });
    assert.deepEqual(approvalResult({ method }, { allow: false }), { decision: { denied: { rejection: 'USER_DECLINED' } } });
  }
  for (const method of ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval']) assert.deepEqual(approvalResult({ method }, { allow: false }), { decision: 'decline' });
  assert.throws(() => approvalResult({ method: 'mcpServer/elicitation/request' }, { allow: true }), { code: 'UNSUPPORTED_APPROVAL' });
  assert.equal(approvalResult({ method: 'mcpServer/elicitation/request' }, { allow: false }).action, 'decline');
});
