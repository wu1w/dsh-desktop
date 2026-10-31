import { randomUUID } from 'node:crypto';
import { validateElicitationContent } from '../shared/mcp-elicitation.js';

const fault = code => Object.assign(new Error(code), { code });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function userInputResult(params, body) {
  if (!object(body) || typeof body.allow !== 'boolean') throw fault('INVALID_REQUEST');
  // This protocol has no cancel flag. Omitting every answer means the user
  // chose not to answer this request; it does not interrupt the running task.
  if (!body.allow) return { answers: {} };
  if (!Array.isArray(params?.questions) || !object(body.answers)) throw fault('INVALID_USER_ANSWERS');
  const known = new Set();
  for (const question of params.questions) {
    if (typeof question?.id !== 'string' || !question.id || known.has(question.id)) throw fault('INVALID_USER_QUESTIONS');
    known.add(question.id);
  }
  const entries = [];
  let totalBytes = 0;
  for (const [id, answer] of Object.entries(body.answers)) {
    if (!known.has(id) || !object(answer) || !Array.isArray(answer.answers)
      || answer.answers.length > 20 || Object.keys(answer).some(key => key !== 'answers')) throw fault('INVALID_USER_ANSWERS');
    const values = answer.answers.map(value => {
      if (typeof value !== 'string' || value.includes('\0')) throw fault('INVALID_USER_ANSWERS');
      if (Buffer.byteLength(value) > 20000) throw fault('USER_ANSWER_LIMIT');
      totalBytes += Buffer.byteLength(value);
      return value;
    });
    if (totalBytes > 100000) throw fault('USER_ANSWER_LIMIT');
    // An unanswered question is absent, rather than receiving someone else's
    // answer or a synthetic empty string. Explicit empty lists are also skips.
    if (values.length) entries.push([id, { answers: values }]);
  }
  return { answers: Object.fromEntries(entries) };
}

function elicitationAction(body){
  if(!object(body)||typeof body.allow!=='boolean')throw fault('INVALID_REQUEST');
  const action=Object.hasOwn(body,'elicitationAction')?body.elicitationAction:(body.allow?'accept':'decline');
  if(!['accept','decline','cancel'].includes(action)||(action==='accept')!==body.allow)throw fault('INVALID_REQUEST');return action;
}
export function mcpElicitationResult(request,body){
  const action=elicitationAction(body);
  return {action,content:action==='accept'?validateElicitationContent(request,body.content):null,_meta:null};
}
export function approvalResult(request, body) {
  if (!object(body) || typeof body.allow !== 'boolean') throw fault('INVALID_REQUEST');
  const { method, params = {} } = request;
  if (method === 'item/tool/requestUserInput') return userInputResult(params, body);
  if (method === 'item/permissions/requestApproval') return { permissions: body.allow ? params.permissions : {}, scope: 'turn' };
  if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(method)) return { decision: body.allow ? 'accept' : 'decline' };
  if (['execCommandApproval', 'applyPatchApproval'].includes(method)) return { decision: body.allow ? 'approved' : { denied: { rejection: 'USER_DECLINED' } } };
  if (method === 'mcpServer/elicitation/request') {const action=elicitationAction(body);if(action==='accept')throw fault('UNSUPPORTED_APPROVAL');return {action,content:null,_meta:null};}
  if (body.allow) throw fault('UNSUPPORTED_APPROVAL');
  return { success: false, contentItems: [{ type: 'inputText', text: 'UNSUPPORTED_TOOL' }] };
}

// Request IDs are scoped to an engine process. Public IDs remain unique across
// engine swaps so a late click can never approve an unrelated new request.
export class ApprovalBroker {
  constructor({ broadcast = () => {} } = {}) { this.broadcast = broadcast; this.pending = new Map(); this.native = new Map();this.handlers=new Map(); }
  registerHandler(method,handler){
    if(typeof method!=='string'||!method||method.length>200||typeof handler!=='function'||handler.constructor?.name==='AsyncFunction')throw fault('APPROVAL_HANDLER_INVALID');
    if(this.handlers.has(method))throw fault('APPROVAL_HANDLER_CONFLICT');
    const registration={handler};this.handlers.set(method,registration);
    return()=>{if(this.handlers.get(method)===registration)this.handlers.delete(method);};
  }
  receive(engine, request) {
    if (!engine || request?.id == null || typeof request.method !== 'string') throw fault('INVALID_REQUEST');
    let native = this.native.get(engine);
    if (!native) { native = new Map(); this.native.set(engine, native); }
    const key = String(request.id), existing = native.get(key);
    if (existing) return this.pending.get(existing)?.request;
    const id = randomUUID(), visible = { ...structuredClone(request), id };
    this.pending.set(id, { engine, nativeId: request.id, request: visible, answering: false }); native.set(key, id);
    this.broadcast({ type: 'approval', request: visible }); return visible;
  }
  list() { return [...this.pending.values()].map(entry => entry.request); }
  _remove(id, reason) {
    const entry = this.pending.get(id); if (!entry) return false;
    this.pending.delete(id); const native = this.native.get(entry.engine); native?.delete(String(entry.nativeId)); if (native?.size === 0) this.native.delete(entry.engine);
    this.broadcast({ type: 'approval-resolved', id, reason }); return true;
  }
  resolved(engine, event) { const id = this.native.get(engine)?.get(String(event.id)); if (id) this._remove(id, event.reason ?? 'resolved'); }
  clear(engine, reason = 'cancelled') { for (const [id, entry] of this.pending) if (entry.engine === engine) this._remove(id, reason); }
  async answer(id, body) {
    const entry = this.pending.get(id); if (!entry) throw fault('APPROVAL_NOT_FOUND');
    if (entry.answering) throw fault('APPROVAL_BUSY');
    const handler=this.handlers.get(entry.request.method)?.handler;
    const result = handler?handler(entry.request,body):approvalResult(entry.request, body);
    if(!object(result))throw fault('APPROVAL_HANDLER_INVALID');
    let then;try{then=result.then;}catch{throw fault('APPROVAL_HANDLER_INVALID');}
    if(typeof then==='function'){
      // A normal function can still return a rejected Promise. Reject async
      // handlers without leaving that rejection unobserved in the host.
      void Promise.resolve(result).catch(()=>{});
      throw fault('APPROVAL_HANDLER_INVALID');
    }
    entry.answering = true;
    try { await entry.engine.respondApproval(entry.nativeId, result); this._remove(id, 'answered'); }
    catch (error) {
      if (error.code === 'APPROVAL_NOT_FOUND') this._remove(id, 'expired');
      else if (this.pending.get(id) === entry) entry.answering = false;
      throw error;
    }
    return { ok: true };
  }
}
