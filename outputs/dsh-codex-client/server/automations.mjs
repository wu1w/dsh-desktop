import { open, mkdir, realpath, lstat, chmod, rename, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import lockfile from 'proper-lockfile';

const MAX_TASKS = 100, MAX_RUNS = 20, MAX_FILE_BYTES = 4 * 1024 * 1024, MAX_LATENESS_MS = 60000;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const ENGINE = /^[a-z][a-z0-9-]{1,79}$/;
const STATUSES = new Set(['completed', 'failed', 'blocked', 'cancelled', 'unknown']);
const EFFORTS = new Set(['low', 'high', 'max']);
const EDITABLE = ['title', 'projectId', 'prompt', 'engineId', 'model', 'effort', 'permission', 'schedule', 'enabled'];
const ROW_KEYS = [...EDITABLE, 'id', 'nextRunAt', 'lastRunAt', 'lastStatus', 'lastErrorCode', 'lastSessionId', 'runs'];
const fault = (code, cause) => Object.assign(new Error(code, { cause }), { code });
const clone = value => structuredClone(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const nullableTime = value => value === null || timestamp(value);
const errorCode = value => typeof value === 'string' && /^[A-Z0-9_:-]{1,120}$/.test(value) ? value : 'AUTOMATION_FAILED';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function scheduleFields(value) {
  if (exactKeys(value, ['type', 'minutes']) && value.type === 'interval' && Number.isInteger(value.minutes) && value.minutes >= 15 && value.minutes <= 10080) return { type: 'interval', minutes: value.minutes };
  if (exactKeys(value, ['type', 'time']) && value.type === 'daily' && typeof value.time === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.time)) return { type: 'daily', time: value.time };
  throw fault('INVALID_AUTOMATION');
}
function taskFields(value) {
  if (!object(value) || typeof value.title !== 'string' || !value.title.trim() || value.title.length > 160 || /[\0\r\n]/.test(value.title)
    || typeof value.projectId !== 'string' || !ID.test(value.projectId) || typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.includes('\0') || Buffer.byteLength(value.prompt) > 16000
    || typeof value.engineId !== 'string' || !ENGINE.test(value.engineId) || typeof value.model !== 'string' || !value.model.trim() || value.model.length > 160 || /[\0\r\n]/.test(value.model)
    || !EFFORTS.has(value.effort) || !['read-only', 'workspace-write'].includes(value.permission)) throw fault('INVALID_AUTOMATION');
  return { title: value.title.trim(), projectId: value.projectId, prompt: value.prompt, engineId: value.engineId, model: value.model, effort: value.effort, permission: value.permission, schedule: scheduleFields(value.schedule) };
}
function persistedRow(value) {
  if (!exactKeys(value, ROW_KEYS) || typeof value.id !== 'string' || !ID.test(value.id) || typeof value.enabled !== 'boolean' || !nullableTime(value.nextRunAt) || !nullableTime(value.lastRunAt)
    || !['never', 'running', ...STATUSES].includes(value.lastStatus) || (value.lastErrorCode !== null && errorCode(value.lastErrorCode) !== value.lastErrorCode)
    || (value.lastSessionId !== null && (typeof value.lastSessionId !== 'string' || !ID.test(value.lastSessionId))) || !Array.isArray(value.runs) || value.runs.length > MAX_RUNS) throw fault('AUTOMATION_STATE_INVALID');
  const fields = taskFields(value), runIds = new Set();
  for (const run of value.runs) {
    if (!exactKeys(run, ['id', 'trigger', 'scheduledAt', 'startedAt', 'finishedAt', 'status', 'errorCode', 'sessionId']) || typeof run.id !== 'string' || !ID.test(run.id) || runIds.has(run.id)
      || !['manual', 'scheduled'].includes(run.trigger) || !nullableTime(run.scheduledAt) || !timestamp(run.startedAt) || !nullableTime(run.finishedAt)
      || !['running', ...STATUSES].includes(run.status) || (run.errorCode !== null && errorCode(run.errorCode) !== run.errorCode)
      || (run.sessionId !== null && (typeof run.sessionId !== 'string' || !ID.test(run.sessionId))) || (run.status === 'running' ? run.finishedAt !== null || run.errorCode !== null : run.finishedAt === null)) throw fault('AUTOMATION_STATE_INVALID');
    runIds.add(run.id);
  }
  if (value.runs.filter(run => run.status === 'running').length > 1 || (value.lastStatus === 'running') !== (value.runs.at(-1)?.status === 'running')) throw fault('AUTOMATION_STATE_INVALID');
  const last = value.runs.at(-1);
  if (last ? value.lastStatus !== last.status || value.lastRunAt !== last.startedAt || value.lastSessionId !== last.sessionId || value.lastErrorCode !== last.errorCode
    : value.lastStatus !== 'never' || value.lastRunAt !== null || value.lastSessionId !== null || value.lastErrorCode !== null) throw fault('AUTOMATION_STATE_INVALID');
  return { ...clone(value), ...fields };
}
export function nextAutomationTime(schedule, now) {
  if (schedule.type === 'interval') return new Date(now + schedule.minutes * 60000).toISOString();
  const [hours, minutes] = schedule.time.split(':').map(Number), next = new Date(now);
  next.setHours(hours, minutes, 0, 0); if (next.getTime() <= now) next.setDate(next.getDate() + 1);
  return next.toISOString();
}

/** Local-only scheduling. Claims are committed before invoking the real host. */
export class AutomationScheduler {
  constructor({ dataDir, runAutomation, getProject, clock = {}, stopTimeoutMs = 10000 } = {}) {
    if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir) || dataDir.includes('\0') || typeof runAutomation !== 'function' || typeof getProject !== 'function') throw fault('INVALID_AUTOMATION');
    if (!Number.isSafeInteger(stopTimeoutMs) || stopTimeoutMs < 1 || stopTimeoutMs > 60000) throw fault('INVALID_AUTOMATION');
    this.dataDir = dataDir; this.runAutomation = runAutomation; this.getProject = getProject; this.stopTimeoutMs = stopTimeoutMs;
    this.now = clock.now ?? Date.now; this.setTimer = clock.setTimeout ?? setTimeout; this.clearTimer = clock.clearTimeout ?? clearTimeout;
    this.rows = new Map(); this.active = new Map(); this.serial = Promise.resolve(); this.loaded = false; this.stopping = false; this.storageErrorCode = null; this.diskHash = null;
  }
  _queue(work, internal = false) {
    if (this.stopping && !internal) return Promise.reject(fault('AUTOMATION_STOPPED'));
    const operation = this.serial.then(() => { if (this.stopping && !internal) throw fault('AUTOMATION_STOPPED'); return work(); });
    this.serial = operation.catch(() => {}); return operation;
  }
  async _bytes() {
    let handle;
    try {
      const metadata = await lstat(this.file); if (!metadata.isFile() || metadata.isSymbolicLink()) throw fault('AUTOMATION_STORAGE_UNSAFE');
      handle = await open(this.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      const info = await handle.stat(); if (!info.isFile()) throw fault('AUTOMATION_STORAGE_UNSAFE'); if (info.size > MAX_FILE_BYTES) throw fault('AUTOMATION_STATE_INVALID');
      await handle.chmod(0o600);
      const bytes = await handle.readFile(); if (bytes.length > MAX_FILE_BYTES) throw fault('AUTOMATION_STATE_INVALID'); return bytes;
    } catch (error) { if (error.code === 'ENOENT') return null; if (error.code === 'ELOOP') throw fault('AUTOMATION_STORAGE_UNSAFE'); throw error; }
    finally { await handle?.close(); }
  }
  async _replaceFile(temporary, target) { await rename(temporary, target); }
  async _persist(rows) {
    let temporary, handle;
    try {
      if (this.lockLost) throw fault('AUTOMATION_LOCKED');
      const current = await this._bytes(); if ((current === null ? null : hash(current)) !== this.diskHash) throw fault('AUTOMATION_STATE_INVALID');
      const bytes = Buffer.from(JSON.stringify({ version: 1, automations: [...rows.values()] }) + '\n'); if (bytes.length > MAX_FILE_BYTES) throw fault('AUTOMATION_LIMIT');
      temporary = path.join(this.directory, '.automations.' + randomUUID() + '.tmp'); handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null;
      await this._replaceFile(temporary, this.file); this.diskHash = hash(bytes);
    } catch (error) { this.storageErrorCode = error.code?.startsWith('AUTOMATION_') ? error.code : 'AUTOMATION_STORAGE_FAILED'; if (this.timer != null) this.clearTimer(this.timer); this.timer = null; throw fault(this.storageErrorCode, error); }
    finally { await handle?.close().catch(() => {}); if (temporary) await rm(temporary, { force: true }).catch(() => {}); }
  }
  async _commit(rows) { await this._persist(rows); this.rows = rows; this.storageErrorCode = null; }
  async start() {
    if (this.loaded || this.stopping) throw fault('AUTOMATION_STOPPED');
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 }); this.directory = await realpath(this.dataDir); await chmod(this.directory, 0o700); this.file = path.join(this.directory, 'automations.json');
    try {
      this.releaseLock = await lockfile.lock(this.file, { realpath: false, lockfilePath: path.join(this.directory, '.automations.lock'), stale: 30000, update: 5000, retries: 0, onCompromised: () => { this.lockLost = true; this.storageErrorCode = 'AUTOMATION_LOCKED'; void this.close().catch(() => {}); } });
      const bytes = await this._bytes(), next = new Map();
      if (bytes !== null) {
        let parsed; try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch (error) { throw fault('AUTOMATION_STATE_INVALID', error); }
        if (!exactKeys(parsed, ['version', 'automations']) || parsed.version !== 1 || !Array.isArray(parsed.automations) || parsed.automations.length > MAX_TASKS) throw fault('AUTOMATION_STATE_INVALID');
        try { for (const value of parsed.automations) { const row = persistedRow(value); if (next.has(row.id)) throw fault('AUTOMATION_STATE_INVALID'); next.set(row.id, row); } }
        catch (error) { throw fault('AUTOMATION_STATE_INVALID', error); }
        this.diskHash = hash(bytes);
      }
      const now = this.now(); let changed = false;
      for (const row of next.values()) {
        if (row.lastStatus === 'running') {
          row.lastStatus = 'unknown'; row.lastErrorCode = 'AUTOMATION_UNKNOWN';
          for (const run of row.runs) if (run.status === 'running') Object.assign(run, { status: 'unknown', errorCode: 'AUTOMATION_UNKNOWN', finishedAt: new Date(now).toISOString() });
          changed = true;
        }
        const due = row.enabled ? row.nextRunAt && Date.parse(row.nextRunAt) > now ? row.nextRunAt : nextAutomationTime(row.schedule, now) : null;
        if (row.nextRunAt !== due) { row.nextRunAt = due; changed = true; }
      }
      if (changed) await this._commit(next); else this.rows = next;
      this.loaded = true; this._arm(); return this.list();
    } catch (error) { await this.releaseLock?.().catch(() => {}); this.releaseLock = null; throw fault(error.code === 'ELOCKED' ? 'AUTOMATION_LOCKED' : error.code?.startsWith('AUTOMATION_') ? error.code : 'AUTOMATION_STORAGE_FAILED', error); }
  }
  list() {
    if (!this.loaded) throw fault('AUTOMATION_STOPPED');
    return { automations: clone([...this.rows.values()]), runtime: { hostRunning: !this.stopping, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, missedRuns: 'skip', storageErrorCode: this.storageErrorCode, activeRuns: [...this.active].map(([automationId, value]) => ({ automationId, runId: value.runId })), nextRunAt: this._nextWake() } };
  }
  _row(id) { if (!this.loaded) throw fault('AUTOMATION_STOPPED'); const row = this.rows.get(id); if (!row) throw fault('AUTOMATION_NOT_FOUND'); return row; }
  _busy(row) { return this.active.has(row.id) || row.lastStatus === 'running'; }
  create(input) {
    if (!exactKeys(input, EDITABLE) || (input.enabled !== undefined && input.enabled !== false)) return Promise.reject(fault('INVALID_AUTOMATION'));
    const fields = taskFields(input);
    return this._queue(async () => {
      if (!this.loaded) throw fault('AUTOMATION_STOPPED'); if (this.rows.size >= MAX_TASKS) throw fault('AUTOMATION_LIMIT'); await this.getProject(fields.projectId);
      const row = { ...fields, id: randomUUID(), enabled: false, nextRunAt: null, lastRunAt: null, lastStatus: 'never', lastErrorCode: null, lastSessionId: null, runs: [] };
      const next = new Map(this.rows); next.set(row.id, row); await this._commit(next); this._arm(); return { automation: clone(row) };
    });
  }
  update(id, input) {
    if (!exactKeys(input, EDITABLE) || !Object.keys(input).length || (input.enabled !== undefined && typeof input.enabled !== 'boolean')) return Promise.reject(fault('INVALID_AUTOMATION'));
    return this._queue(async () => {
      const previous = this._row(id); if (this._busy(previous) && (Object.keys(input).some(key => key !== 'enabled') || input.enabled !== false)) throw fault('AUTOMATION_BUSY');
      const fields = taskFields({ ...previous, ...input }); await this.getProject(fields.projectId);
      const row = { ...previous, ...fields, enabled: input.enabled ?? previous.enabled };
      row.nextRunAt = row.enabled ? nextAutomationTime(row.schedule, this.now()) : null;
      const next = new Map(this.rows); next.set(id, row); await this._commit(next); this._arm(); return { automation: clone(row) };
    });
  }
  delete(id) {
    return this._queue(async () => { const row = this._row(id); if (this._busy(row)) throw fault('AUTOMATION_BUSY'); const next = new Map(this.rows); next.delete(id); await this._commit(next); this._arm(); return { deleted: true }; });
  }
  async _claim(id, trigger) {
    const previous = this._row(id); if (this._busy(previous)) throw fault('AUTOMATION_BUSY'); await this.getProject(previous.projectId);
    const now = this.now(), time = new Date(now).toISOString();
    const run = { id: randomUUID(), trigger, scheduledAt: trigger === 'scheduled' ? previous.nextRunAt : null, startedAt: time, finishedAt: null, status: 'running', errorCode: null, sessionId: null };
    const row = { ...previous, nextRunAt: previous.enabled ? nextAutomationTime(previous.schedule, now) : null, lastRunAt: time, lastStatus: 'running', lastErrorCode: null, lastSessionId: null, runs: [...previous.runs, run].slice(-MAX_RUNS) };
    const next = new Map(this.rows); next.set(id, row); await this._commit(next);
    const controller = new AbortController(), active = { runId: run.id, controller, promise: null }; this.active.set(id, active);
    if (this.stopping) controller.abort();
    active.promise = this._execute(clone(row), clone(run), controller).finally(() => { if (this.active.get(id) === active) this.active.delete(id); this._arm(); });
    return { automation: clone(row), run: clone(run) };
  }
  run(id) { return this._queue(() => this._claim(id, 'manual')); }
  async _execute(task, run, controller) {
    const onSession = sessionId => this._queue(async () => {
      if (typeof sessionId !== 'string' || !ID.test(sessionId)) throw fault('INVALID_AUTOMATION');
      const previous = this._row(task.id); if (previous.runs.at(-1)?.id !== run.id || previous.lastStatus !== 'running') throw fault('AUTOMATION_BUSY');
      if (previous.lastSessionId && previous.lastSessionId !== sessionId) throw fault('INVALID_AUTOMATION');
      const row = clone(previous); row.lastSessionId = sessionId; row.runs.at(-1).sessionId = sessionId;
      const next = new Map(this.rows); next.set(row.id, row);
      try { await this._commit(next); } catch (error) { controller.abort(error); throw error; }
    }, true);
    let outcome;
    try {
      if (controller.signal.aborted) outcome = { status: 'cancelled', errorCode: 'AUTOMATION_CANCELLED' };
      else outcome = await this.runAutomation(clone(task), { signal: controller.signal, onSession });
      if (!object(outcome) || !STATUSES.has(outcome.status)) outcome = { status: 'unknown', errorCode: 'AUTOMATION_UNKNOWN' };
      if (outcome.sessionId != null && (typeof outcome.sessionId !== 'string' || !ID.test(outcome.sessionId))) outcome = { status: 'unknown', errorCode: 'AUTOMATION_UNKNOWN' };
    } catch (error) { outcome = { status: controller.signal.aborted ? 'unknown' : 'failed', errorCode: controller.signal.aborted ? 'AUTOMATION_UNKNOWN' : errorCode(error.code) }; }
    try {
      await this._queue(async () => {
        const previous = this._row(task.id), row = clone(previous), latest = row.runs.at(-1);
        if (latest?.id !== run.id) throw fault('AUTOMATION_BUSY');
        Object.assign(latest, { status: outcome.status, errorCode: outcome.errorCode == null ? null : errorCode(outcome.errorCode), finishedAt: new Date(this.now()).toISOString(), sessionId: outcome.sessionId ?? latest.sessionId });
        Object.assign(row, { lastStatus: latest.status, lastErrorCode: latest.errorCode, lastSessionId: latest.sessionId });
        // A long or suspended execution never catches up missed intervals.
        if (row.enabled && Date.parse(row.nextRunAt) <= this.now()) row.nextRunAt = nextAutomationTime(row.schedule, this.now());
        const next = new Map(this.rows); next.set(row.id, row); await this._commit(next);
      }, true);
    } catch { /* The durable running claim remains unknown on the next start. */ }
  }
  _nextWake() { const times = [...this.rows.values()].filter(row => row.enabled && row.nextRunAt && !this._busy(row)).map(row => row.nextRunAt).sort(); return times[0] ?? null; }
  _arm() {
    if (this.timer != null) this.clearTimer(this.timer); this.timer = null;
    if (!this.loaded || this.stopping || this.storageErrorCode) return;
    const next = this._nextWake(); if (!next) return;
    this.timer = this.setTimer(() => { this.timer = null; void this.tick().catch(() => {}); }, Math.min(2147483647, Math.max(1, Date.parse(next) - this.now()))); this.timer?.unref?.();
  }
  async _blockScheduledClaim(id, error) {
    const previous=this._row(id),now=this.now(),time=new Date(now).toISOString();
    const code=errorCode(error?.code??error?.message);
    const run={id:randomUUID(),trigger:'scheduled',scheduledAt:previous.nextRunAt,startedAt:time,finishedAt:time,status:'blocked',errorCode:code,sessionId:null};
    const row={...previous,nextRunAt:previous.enabled?nextAutomationTime(previous.schedule,now):null,lastRunAt:time,lastStatus:'blocked',lastErrorCode:code,lastSessionId:null,runs:[...previous.runs,run].slice(-MAX_RUNS)};
    const next=new Map(this.rows);next.set(id,row);await this._commit(next);
  }
  tick() {
    return this._queue(async () => {
      try {
        if (this.storageErrorCode) return;
        for (const row of [...this.rows.values()]) if (row.enabled && row.nextRunAt && Date.parse(row.nextRunAt) <= this.now() && !this._busy(row)) {
          if (this.now() - Date.parse(row.nextRunAt) > MAX_LATENESS_MS) {
            const next = new Map(this.rows); next.set(row.id, { ...row, nextRunAt: nextAutomationTime(row.schedule, this.now()) }); await this._commit(next);
          } else {
            try { await this._claim(row.id, 'scheduled'); }
            catch(error) {
              // An unavailable project affects this occurrence only. Persist
              // its blocked outcome so other tasks and future slots continue.
              // Storage/ownership failures still stop all new execution.
              if(this.storageErrorCode||this.lockLost||this.stopping||this._busy(this._row(row.id)))throw error;
              await this._blockScheduledClaim(row.id,error);
            }
          }
        }
      } finally { this._arm(); }
    });
  }
  async waitForIdle() { await Promise.allSettled([...this.active.values()].map(value => value.promise)); await this.serial; }
  close() {
    if (this.closing) return this.closing;
    this.stopping = true; if (this.timer != null) this.clearTimer(this.timer); this.timer = null;
    for (const value of this.active.values()) value.controller.abort();
    const closing = (async () => {
      let timer;
      const idle = (async () => {
        // A claim may still be binding a project when shutdown starts. Wait
        // for it to register its run, then interrupt and observe that run too.
        await this.serial; for (const value of this.active.values()) value.controller.abort();
        await this.waitForIdle();
      })();
      try {
        await Promise.race([idle, new Promise((_, reject) => { timer = setTimeout(() => reject(fault('AUTOMATION_STOP_FAILED')), this.stopTimeoutMs); })]);
      } finally { clearTimeout(timer); }
      // A timed-out run still owns its durable claim and lock. Never release
      // them in a background continuation or invent a cancelled outcome.
      if (!this.lockLost) await this.releaseLock?.(); this.releaseLock = null;
    })();
    this.closing = closing;
    void closing.catch(() => { if (this.closing === closing) this.closing = null; });
    return closing;
  }
}
