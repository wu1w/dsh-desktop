import { mkdir, readFile, rename, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { EngineError } from "./errors.js";

export class SessionStore {
  constructor(file, translator) {
    this.file = file; this.translator = translator; this.sessions = new Map();
    this.loaded = false; this.loading = null; this.writes = Promise.resolve();
  }
  async load() {
    if (this.loaded) return;
    if (!this.loading) this.loading = (async () => {
      try {
        let raw;
        try { raw = await readFile(this.file, "utf8"); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        if (raw !== undefined) {
          const parsed = JSON.parse(raw);
          if (parsed.version !== 1 || !parsed.sessions || Array.isArray(parsed.sessions)) throw new Error("SCHEMA");
          const next = new Map();
          for (const row of Object.values(parsed.sessions)) {
            if (!row || typeof row.sessionId !== "string" || typeof row.threadId !== "string" || typeof row.cwd !== "string") throw new Error("SCHEMA");
            next.set(row.sessionId, row);
          }
          this.sessions = next;
        }
        this.loaded = true;
      } catch { throw new EngineError("PERSIST_FAILED", "error.persist_failed", {}, this.translator); }
      finally { this.loading = null; }
    })();
    return this.loading;
  }
  get(id) { return this.sessions.get(id) ?? null; }
  findByThread(id) { return [...this.sessions.values()].find(row => row.threadId === id) ?? null; }
  list() { return [...this.sessions.values()].sort((a,b) => String(b.updatedAt).localeCompare(String(a.updatedAt))); }
  upsert(record) {
    const run = this.writes.then(async () => {
      await this.load();
      const next = new Map(this.sessions); next.set(record.sessionId, record);
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
        await writeFile(temporary, JSON.stringify({ version: 1, sessions: Object.fromEntries(next) }, null, 2) + "\n", { mode: 0o600 });
        await rename(temporary, this.file);
        this.sessions = next;
      } catch { throw new EngineError("PERSIST_FAILED", "error.persist_failed", {}, this.translator); }
      finally { await rm(temporary, { force: true }).catch(() => {}); }
    });
    this.writes = run.catch(() => {});
    return run;
  }
}
