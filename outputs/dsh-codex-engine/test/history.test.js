import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createTestEngine, inbound, readTrace, removeDir, tempDir } from "./helpers.js";
import { legacyItemsPage } from "../lib/history-pages.js";

test("item pages use native order and opaque continuation without loading complete history", async () => {
  const dataDir = await tempDir();
  const engine = createTestEngine(dataDir);
  try {
    const session = await engine.createSession("owned", { cwd: dataDir });
    const before = await readFile(path.join(dataDir, "sessions.json"), "utf8");
    let page = await engine.listSessionItems("owned");
    assert.equal(page.data.length, 20);
    assert.equal(page.data[0].item.id, `${session.threadId}-item-48`);
    assert.equal(page.data.at(-1).item.id, `${session.threadId}-item-29`);
    assert.equal(page.data[0].turnId, `${session.threadId}-turn-12`);
    assert.equal(page.data[0].startedAtMs, 111000);
    assert.equal(typeof page.nextCursor, "string");
    assert.equal(typeof page.backwardsCursor, "string");
    const ids = page.data.map(entry => entry.item.id);
    while (page.nextCursor) {
      page = await engine.listSessionItems("owned", { cursor: page.nextCursor });
      ids.push(...page.data.map(entry => entry.item.id));
    }
    assert.deepEqual(ids, Array.from({ length: 48 }, (_, index) => `${session.threadId}-item-${48 - index}`));
    assert.equal(new Set(ids).size, 48);
    assert.equal(page.nextCursor, null);
    const oldest = await engine.listSessionItems("owned", { limit: 1, cursor: null, sortDirection: "asc" });
    assert.equal(oldest.data[0].item.id, `${session.threadId}-item-1`);
    const afterOldest = await engine.listSessionItems("owned", { limit: 2, cursor: oldest.nextCursor, sortDirection: "asc" });
    assert.deepEqual(afterOldest.data.map(entry => entry.item.id), [`${session.threadId}-item-2`, `${session.threadId}-item-3`]);
    assert.equal((await engine.listSessionItems("owned", { limit: 50 })).data.length, 48);
    assert.equal(await readFile(path.join(dataDir, "sessions.json"), "utf8"), before);
    const trace = await readTrace(dataDir);
    assert.equal(inbound(trace, "thread/read").length, 0);
    assert.equal(inbound(trace, "thread/resume").length, 0);
    assert.equal(inbound(trace, "turn/start").length, 0);
    const reads = inbound(trace, "thread/items/list");
    assert.deepEqual(reads[0].msg.params, { threadId: session.threadId, limit: 20, sortDirection: "desc" });
    assert.ok(reads.every(entry => entry.msg.params.threadId === session.threadId));
  } finally {
    await engine.dispose();
    await removeDir(dataDir);
  }
});

test("turn pages default to notLoaded and fork returns metadata without changing the pinned profile", async () => {
  const dataDir = await tempDir();
  const profile = { id: "history-profile", version: 1, instructionHash: "history-hash", threadParams: { developerInstructions: "pinned fixture instructions" } };
  const engine = createTestEngine(dataDir, "ok", { resolveInstructionProfile: () => profile });
  try {
    const session = await engine.createSession("owned", { cwd: dataDir });
    const recent = await engine.listSessionTurns("owned");
    assert.equal(recent.data.length, 10);
    assert.deepEqual(recent.data.map(turn => turn.id), Array.from({ length: 10 }, (_, index) => `${session.threadId}-turn-${12 - index}`));
    assert.ok(recent.data.every(turn => turn.itemsView === "notLoaded" && turn.items.length === 0));
    const older = await engine.listSessionTurns("owned", { cursor: recent.nextCursor });
    assert.deepEqual(older.data.map(turn => turn.id), [`${session.threadId}-turn-2`, `${session.threadId}-turn-1`]);
    assert.equal(older.nextCursor, null);
    for (const itemsView of ["summary", "full"]) {
      const page = await engine.listSessionTurns("owned", { limit: 1, sortDirection: "asc", itemsView });
      assert.equal(page.data[0].id, `${session.threadId}-turn-1`);
      assert.equal(page.data[0].itemsView, itemsView);
      assert.equal(page.data[0].items.length, 4);
    }
    const fork = await engine.forkSession("owned", "fork");
    assert.deepEqual(fork.instructionProfile, session.instructionProfile);
    assert.equal(fork.model, session.model);
    assert.equal(fork.provider, session.provider);
    const trace = await readTrace(dataDir);
    assert.deepEqual(inbound(trace, "thread/turns/list")[0].msg.params, { threadId: session.threadId, limit: 10, sortDirection: "desc", itemsView: "notLoaded" });
    assert.deepEqual(inbound(trace, "thread/fork").at(-1).msg.params, { threadId: session.threadId, excludeTurns: true });
  } finally {
    await engine.dispose();
    await removeDir(dataDir);
  }
});

test("history APIs reject invalid options and foreign session IDs before sending native requests", async () => {
  const dataDir = await tempDir();
  const engine = createTestEngine(dataDir, "ok", { locale: "fr" });
  try {
    await assert.rejects(engine.listSessionItems("foreign"), error => error.code === "SESSION_NOT_FOUND");
    assert.equal(engine.client, null);
    const session = await engine.createSession("owned", { cwd: dataDir });
    const other = await engine.createSession("other", { cwd: dataDir });
    const before = await readFile(path.join(dataDir, "sessions.json"), "utf8");
    const invalid = [null, [], "wrong", { limit: 0 }, { limit: 51 }, { limit: 1.5 }, { limit: "20" }, { limit: null }, { limit: Infinity }, { sortDirection: "newest" }, { sortDirection: null }, { cursor: "" }, { cursor: "  " }, { cursor: 1 }, { cursor: { type: "item", itemId: "foreign" } }, { threadId: other.threadId }];
    for (const method of ["listSessionItems", "listSessionTurns"]) {
      for (const options of invalid) {
        await assert.rejects(engine[method]("owned", options), error => {
          assert.equal(error.code, "INVALID_HISTORY_PAGE");
          assert.equal(error.key, "error.invalid_history_page");
          assert.match(error.message, /page size from 1 to 50/);
          return true;
        });
      }
      await assert.rejects(engine[method](session.threadId), error => error.code === "SESSION_NOT_FOUND");
      await assert.rejects(engine[method]("foreign"), error => error.code === "SESSION_NOT_FOUND");
    }
    await assert.rejects(engine.listSessionTurns("owned", { itemsView: "all" }), error => error.code === "INVALID_HISTORY_PAGE");
    await assert.rejects(engine.listSessionItems("owned", { itemsView: "full" }), error => error.code === "INVALID_HISTORY_PAGE");
    const traceBeforeRead = await readTrace(dataDir);
    assert.equal(inbound(traceBeforeRead, "thread/items/list").length, 0);
    assert.equal(inbound(traceBeforeRead, "thread/turns/list").length, 0);
    const first = await engine.listSessionItems("owned", { limit: 1 });
    await assert.rejects(engine.listSessionItems("other", { cursor: first.nextCursor }), error => error.code === "RPC_FAILED");
    assert.equal(await readFile(path.join(dataDir, "sessions.json"), "utf8"), before);
    const requests = inbound(await readTrace(dataDir), "thread/items/list");
    assert.deepEqual(requests.map(entry => entry.msg.params.threadId), [session.threadId, other.threadId]);
    await engine.dispose();
    await assert.rejects(engine.listSessionTurns("owned"), error => error.code === "DISPOSED");
  } finally {
    await engine.dispose();
    await removeDir(dataDir);
  }
});

test("legacy item windows resume within turns, reverse at the anchor and bind cursors to their owned thread", async () => {
  const dataDir = await tempDir();
  const engine = createTestEngine(dataDir, "legacy-history");
  try {
    const session = await engine.createSession("owned", { cwd: dataDir });
    await engine.createSession("other", { cwd: dataDir });
    const first = await engine.listSessionItems("owned", { limit: 3 });
    assert.deepEqual(first.data.map(entry => entry.item.id), [48, 47, 46].map(id => `${session.threadId}-item-${id}`));
    assert.ok(first.data.every(entry => entry.startedAtMs === null && entry.completedAtMs === null));
    const second = await engine.listSessionItems("owned", { limit: 3, cursor: first.nextCursor });
    assert.deepEqual(second.data.map(entry => entry.item.id), [45, 44, 43].map(id => `${session.threadId}-item-${id}`));
    const reverse = await engine.listSessionItems("owned", { limit: 3, sortDirection: "asc", cursor: second.backwardsCursor });
    assert.deepEqual(reverse.data.map(entry => entry.item.id), [45, 46, 47].map(id => `${session.threadId}-item-${id}`));
    const ids = first.data.map(entry => entry.item.id);
    let next = first.nextCursor;
    while (next) {
      const page = await engine.listSessionItems("owned", { limit: 3, cursor: next });
      ids.push(...page.data.map(entry => entry.item.id)); next = page.nextCursor;
    }
    assert.deepEqual(ids, Array.from({ length: 48 }, (_, index) => `${session.threadId}-item-${48 - index}`));
    await assert.rejects(engine.listSessionItems("other", { cursor: first.nextCursor }), error => error.code === "INVALID_HISTORY_PAGE");
    await assert.rejects(engine.listSessionItems("owned", { sortDirection: "asc", cursor: first.nextCursor }), error => error.code === "INVALID_HISTORY_PAGE");
    const prefix = "dsh-turn-items-v1:";
    const stale = JSON.parse(Buffer.from(first.nextCursor.slice(prefix.length), "base64url").toString("utf8"));
    stale.itemId = "removed-item";
    await assert.rejects(engine.listSessionItems("owned", { cursor: prefix + Buffer.from(JSON.stringify(stale)).toString("base64url") }), error => error.code === "HISTORY_CURSOR_STALE");
    const trace = await readTrace(dataDir);
    const turns = inbound(trace, "thread/turns/list");
    assert.ok(turns.length > 0 && turns.every(entry => entry.msg.params.limit === 1));
    assert.ok(turns.some(entry => entry.msg.params.itemsView === "notLoaded"));
    assert.equal(inbound(trace, "thread/read").length, 0);
    assert.equal(inbound(trace, "turn/start").length, 0);
  } finally {
    await engine.dispose(); await removeDir(dataDir);
  }
});

test("cold history paging resumes only the owned native thread with the original provider and pinned profile", async () => {
  const dataDir = await tempDir();
  const profile = { id: "original", version: 1, instructionHash: "original-hash", threadParams: { developerInstructions: "original-pinned-instructions" } };
  let engine = createTestEngine(dataDir, "legacy-history", { resolveInstructionProfile: () => profile });
  try {
    const created = await engine.createSession("owned", { cwd: dataDir });
    await engine.dispose();
    engine = createTestEngine(dataDir, "legacy-history", { resolveInstructionProfile: () => ({ ...profile, id: "new-default", threadParams: { developerInstructions: "new-default-instructions" } }) });
    const before = await readFile(path.join(dataDir, "sessions.json"), "utf8");
    const page = await engine.listSessionItems("owned", { limit: 1 });
    assert.equal(page.data[0].item.id, `${created.threadId}-item-48`);
    const resumed = inbound(await readTrace(dataDir), "thread/resume");
    assert.equal(resumed.length, 1);
    assert.equal(resumed[0].msg.params.threadId, created.threadId);
    assert.equal(resumed[0].msg.params.modelProvider, "opencode_go");
    assert.equal(resumed[0].msg.params.model, "deepseek-v4.1-flash");
    assert.equal(resumed[0].msg.params.excludeTurns, true);
    assert.equal(resumed[0].msg.params.developerInstructions, "original-pinned-instructions");
    assert.equal(await readFile(path.join(dataDir, "sessions.json"), "utf8"), before);
  } finally {
    await engine.dispose(); await removeDir(dataDir);
  }
});

test("legacy adaptation leaves a single oversized turn and unrelated native errors visible", async () => {
  for (const scenario of ["legacy-history-huge", "history-rpc-error"]) {
    const dataDir = await tempDir();
    const engine = createTestEngine(dataDir, scenario, { maxLineBytes: 1024 });
    try {
      const created = await engine.createSession("owned", { cwd: dataDir });
      await assert.rejects(engine.listSessionItems("owned", { limit: 1 }), error => error.code === (scenario === "legacy-history-huge" ? "LINE_TOO_LONG" : "RPC_FAILED"));
      assert.equal(engine.client.pending.size, 0);
      assert.equal((await engine.readSession("owned")).remoteThreadId, created.threadId);
      const turns = inbound(await readTrace(dataDir), "thread/turns/list");
      assert.equal(turns.length, scenario === "legacy-history-huge" ? 1 : 0);
      assert.ok(turns.every(entry => entry.msg.params.limit === 1));
    } finally {
      await engine.dispose(); await removeDir(dataDir);
    }
  }
});

test("empty legacy turns have a bounded scan with a continuation cursor", async () => {
  let requests = 0;
  const client = { async request(method, params) {
    requests++; assert.equal(method, "thread/turns/list"); assert.equal(params.limit, 1);
    const index = Number(params.cursor ?? 0);
    return { data: [{ id: `turn-${index}`, itemsView: "full", items: index < 100 ? [] : [{ type: "agentMessage", id: "final-item", text: "found" }] }], nextCursor: index < 100 ? String(index + 1) : null, backwardsCursor: `reverse-${index}` };
  } };
  const first = await legacyItemsPage(client, "owned-thread", { limit: 20, sortDirection: "desc" });
  assert.equal(requests, 100); assert.deepEqual(first.data, []); assert.equal(typeof first.nextCursor, "string");
  const next = await legacyItemsPage(client, "owned-thread", { limit: 20, sortDirection: "desc", cursor: first.nextCursor });
  assert.equal(requests, 101); assert.equal(next.data[0].item.id, "final-item"); assert.equal(next.nextCursor, null);
});

test("an empty native legacy page follows its cursor and preserves the remaining item order", async () => {
  const calls = [];
  const client = { async request(method, params) {
    calls.push(params.cursor ?? null);
    if (params.cursor == null) return { data: [], nextCursor: "after-empty", backwardsCursor: null };
    assert.equal(params.cursor, "after-empty");
    return { data: [{ id: "older-turn", itemsView: "full", items: [
      { type: "agentMessage", id: "z-item", text: "oldest" },
      { type: "agentMessage", id: "a-item", text: "newer" },
    ] }], nextCursor: null, backwardsCursor: "reverse-anchor" };
  } };
  const result = await legacyItemsPage(client, "owned-thread", { limit: 20, sortDirection: "desc" });
  assert.deepEqual(calls, [null, "after-empty"]);
  assert.deepEqual(result.data.map(entry => entry.item.id), ["a-item", "z-item"]);
  assert.equal(result.nextCursor, null); assert.equal(typeof result.backwardsCursor, "string");
});

test("empty native pages use a bounded budget and resume at the first unscanned cursor", async () => {
  let requests = 0;
  const client = { async request(method, params) {
    requests++;
    const index = Number(params.cursor ?? 0);
    return index < 100
      ? { data: [], nextCursor: String(index + 1), backwardsCursor: null }
      : { data: [{ id: "final-turn", itemsView: "full", items: [{ type: "agentMessage", id: "found", text: "retained" }] }], nextCursor: null, backwardsCursor: "reverse-final" };
  } };
  const first = await legacyItemsPage(client, "owned-thread", { limit: 20, sortDirection: "desc" });
  assert.equal(requests, 100); assert.deepEqual(first.data, []); assert.equal(typeof first.nextCursor, "string");
  const next = await legacyItemsPage(client, "owned-thread", { limit: 20, sortDirection: "desc", cursor: first.nextCursor });
  assert.equal(requests, 101); assert.deepEqual(next.data.map(entry => entry.item.id), ["found"]); assert.equal(next.nextCursor, null);
});

test("self-repeating and cyclic empty-page cursors fail before exhausting the scan budget", async () => {
  for (const cycle of [false, true]) {
    let requests = 0;
    const client = { async request(method, params) {
      requests++;
      const nextCursor = params.cursor == null ? "a" : cycle && params.cursor === "a" ? "b" : "a";
      return { data: [], nextCursor, backwardsCursor: null };
    } };
    await assert.rejects(legacyItemsPage(client, "owned-thread", { limit: 20, sortDirection: "desc" }), { code: "PROTOCOL" });
    assert.equal(requests, cycle ? 3 : 2);
  }
});

test("invalid empty native continuation fields cannot silently truncate legacy history", async () => {
  for (const field of ["nextCursor", "backwardsCursor"]) {
    const client = { async request() { return { data: [], nextCursor: null, backwardsCursor: null, [field]: "" }; } };
    await assert.rejects(legacyItemsPage(client, "owned-thread", { limit: 20, sortDirection: "desc" }), { code: "PROTOCOL" });
  }
});
