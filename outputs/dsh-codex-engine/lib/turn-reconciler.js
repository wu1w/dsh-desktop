const TERMINAL = new Set(["completed", "failed", "interrupted"]);
const ATTEMPT_DELAYS = [0, 150, 600];
const BATCH_BUDGET_MS = 8000;
const REQUEST_BUDGET_MS = 1500;
const COOLDOWN_MS = 1000;
const MAX_BATCHES_WITHOUT_PROGRESS = 2;

function pause(ms, signal) {
  if (!ms || signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

/** Bounded, read-only recovery after a dropped JSON-RPC frame. */
export class TurnStateReconciler {
  constructor({ getClient, getTargets, isCurrentTarget, onCompleted, onSettled }) {
    Object.assign(this, { getClient, getTargets, isCurrentTarget, onCompleted, onSettled });
    this.disposed = false;
    this.running = null;
    this.timer = null;
    this.timerClient = null;
    this.cooldownUntil = 0;
    this.budgets = new Map();
  }

  trigger(client) {
    if (this.disposed || !client?.ready || this.getClient() !== client) return;
    // In particular, a recovery read that is itself oversized must not create
    // another recovery batch or reset this batch's retry budget.
    if (this.running || this.timer) return;
    this.timerClient = client;
    this.timer = setTimeout(() => {
      this.timer = null; this.timerClient = null;
      if (this.disposed || this.getClient() !== client || !client.ready) return;
      // Collect after the current stdout callback: a start ACK and a giant
      // completion can arrive together before startTurn sets local inflight.
      const active = this.getTargets();
      const keys = new Set(active.map(target => `${target.threadId}:${target.turnId}`));
      for (const key of this.budgets.keys()) if (!keys.has(key)) this.budgets.delete(key);
      const targets = active.filter(target => (this.budgets.get(`${target.threadId}:${target.turnId}`) ?? 0) < MAX_BATCHES_WITHOUT_PROGRESS);
      if (!targets.length) return;
      for (const target of targets) {
        const key = `${target.threadId}:${target.turnId}`;
        this.budgets.set(key, (this.budgets.get(key) ?? 0) + 1);
      }
      const job = { client, targets, controller: new AbortController(), deadline: Date.now() + BATCH_BUDGET_MS,
        checked: 0, reconciled: 0 };
      this.running = job;
      this._run(job).catch(() => {}).finally(() => {
        if (this.running !== job) return;
        this.running = null;
        this.cooldownUntil = Date.now() + COOLDOWN_MS;
        if (!this.disposed && this.getClient() === client && !job.controller.signal.aborted) {
          this.onSettled?.({ reason: "LINE_TOO_LONG", checked: job.checked, reconciled: job.reconciled,
            unresolved: targets.filter(target => this.isCurrentTarget(target)).length });
        }
      });
    }, Math.max(25, this.cooldownUntil - Date.now()));
  }

  cancel(client) {
    if (this.timer && (!client || this.timerClient === client)) {
      clearTimeout(this.timer); this.timer = null; this.timerClient = null;
    }
    if (this.running && (!client || this.running.client === client)) {
      this.running.controller.abort(); this.running = null;
    }
    this.cooldownUntil = 0;
    this.budgets.clear();
  }

  dispose() { this.disposed = true; this.cancel(); }

  observe(client, message) {
    if (this.disposed || this.getClient() !== client) return;
    const threadId = message.params?.threadId;
    const turnId = message.params?.turnId ?? message.params?.turn?.id;
    if (!threadId || !turnId) return;
    const key = `${threadId}:${turnId}`;
    if (message.method === "turn/completed" && TERMINAL.has(message.params?.turn?.status)) {
      this.budgets.delete(key); return;
    }
    // Only successfully parsed native progress can replenish the automatic
    // budget. Late oversized replies to timed-out probes cannot replenish it.
    const progress = message.method === "turn/started" || message.method === "item/started"
      || message.method === "item/completed" || (message.method?.startsWith("item/") && /delta$/i.test(message.method));
    if (progress && this.getTargets().some(target => target.threadId === threadId && target.turnId === turnId)) this.budgets.delete(key);
  }

  _alive(job) {
    return !this.disposed && this.running === job && !job.controller.signal.aborted
      && this.getClient() === job.client && job.client.ready && Date.now() < job.deadline;
  }

  async _request(job, method, params) {
    if (!this._alive(job)) return null;
    return job.client.request(method, params, {
      timeoutMs: Math.max(1, Math.min(REQUEST_BUDGET_MS, job.deadline - Date.now())),
      signal: job.controller.signal,
    });
  }

  async _probe(job, target) {
    try {
      const metadata = await this._request(job, "thread/read", { threadId: target.threadId, includeTurns: false });
      if (metadata?.thread?.id !== target.threadId) return null;
    } catch (error) {
      // A giant preview can overflow metadata too. The exact turn can still be
      // verified through the independently bounded notLoaded pages below.
      if (error?.code !== "LINE_TOO_LONG") return null;
    }
    let cursor;
    const seen = new Set();
    for (let page = 0; page < 3 && this._alive(job) && this.isCurrentTarget(target); page++) {
      let result;
      try {
        result = await this._request(job, "thread/turns/list", {
          threadId: target.threadId, limit: 10, sortDirection: "desc", itemsView: "notLoaded",
          ...(cursor === undefined ? {} : { cursor }),
        });
      } catch { return null; }
      if (!Array.isArray(result?.data)) return null;
      const turn = result.data.find(value => value?.id === target.turnId);
      if (turn) return TERMINAL.has(turn.status) ? turn : null;
      const next = result.nextCursor;
      if (typeof next !== "string" || !next || seen.has(next)) return null;
      seen.add(next); cursor = next;
    }
    return null;
  }

  async _run(job) {
    let index = 0;
    const worker = async () => {
      while (this._alive(job) && index < job.targets.length) {
        const target = job.targets[index++];
        if (!this.isCurrentTarget(target)) continue;
        job.checked++;
        for (const delay of ATTEMPT_DELAYS) {
          await pause(Math.min(delay, Math.max(0, job.deadline - Date.now())), job.controller.signal);
          if (!this._alive(job) || !this.isCurrentTarget(target)) break;
          const turn = await this._probe(job, target);
          if (turn && this._alive(job) && this.isCurrentTarget(target)) {
            if (this.onCompleted(target, turn)) {
              job.reconciled++;
              this.budgets.delete(`${target.threadId}:${target.turnId}`);
            }
            break;
          }
        }
      }
    };
    await Promise.all([worker(), worker()]);
  }
}
