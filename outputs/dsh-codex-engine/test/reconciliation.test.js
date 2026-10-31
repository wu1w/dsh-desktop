import assert from "node:assert/strict";
import test from "node:test";
import { createTestEngine, inbound, readTrace, removeDir, tempDir, waitFor, SECRET } from "./helpers.js";

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test("a real child giant completion reconciles only its explicit native terminal turn and emits a slim host notification", async () => {
  for (const [scenario, status] of [["reconcile-completed", "completed"], ["reconcile-failed", "failed"], ["reconcile-interrupted", "interrupted"], ["reconcile-paged", "completed"]]) {
    const dataDir = await tempDir(), engine = createTestEngine(dataDir, scenario);
    const completed = [], notes = [];
    engine.on("turn-completed", value => completed.push(value));
    engine.on("notification", value => { if (value.method === "turn/completed") notes.push(value); });
    try {
      const session = await engine.createSession("owned", { cwd: dataDir });
      const turn = await engine.startTurn("owned", "one authorized fixture turn");
      await waitFor(() => completed.length, 4000);
      assert.equal(engine.activeTurns.size, 0);
      assert.equal(completed.length, 1); assert.equal(notes.length, 1);
      assert.equal(completed[0].turnId, turn.turnId); assert.equal(completed[0].status, status);
      assert.equal(completed[0].reconciled, true); assert.equal(notes[0].params.reconciled, true);
      assert.deepEqual(completed[0].turn.items, []); assert.equal(completed[0].turn.itemsView, "notLoaded");
      assert.equal(completed[0].turn.reconciled, true);
      assert.ok(Buffer.byteLength(JSON.stringify(notes[0])) < 2048);
      assert.equal(JSON.stringify(notes).includes(SECRET), false);
      const trace = await readTrace(dataDir);
      assert.equal(inbound(trace, "turn/start").length, 1);
      assert.equal(trace.some(entry => entry.direction === "in" && entry.msg.method?.startsWith("thread/queue/")), false);
      const reads = inbound(trace, "thread/read"), pages = inbound(trace, "thread/turns/list");
      assert.ok(reads.length > 0 && reads.every(entry => entry.msg.params.includeTurns === false && entry.msg.params.threadId === session.threadId));
      assert.ok(pages.length > 0 && pages.every(entry => entry.msg.params.itemsView === "notLoaded" && entry.msg.params.limit === 10));
      if (scenario === "reconcile-paged") assert.equal(pages.length, 2);
    } finally { await engine.dispose(); await removeDir(dataDir); }
  }
});

test("idle metadata, unrelated terminal turns and in-progress turns never prove the target is completed", async () => {
  for (const scenario of ["reconcile-inprogress", "reconcile-missing"]) {
    const dataDir = await tempDir(), engine = createTestEngine(dataDir, scenario);
    const batches = [], completed = [];
    engine.on("turn-reconciliation", value => batches.push(value));
    engine.on("turn-completed", value => completed.push(value));
    try {
      await engine.createSession("owned", { cwd: dataDir });
      const turn = await engine.startTurn("owned", "stay active unless the exact native turn is terminal");
      await waitFor(() => batches.length, 4000);
      assert.equal(completed.length, 0); assert.equal(engine.activeTurns.get("owned").turnId, turn.turnId);
      assert.deepEqual(batches[0], { reason: "LINE_TOO_LONG", checked: 1, reconciled: 0, unresolved: 1 });
      const trace = await readTrace(dataDir);
      assert.equal(inbound(trace, "thread/read").length, 3);
      assert.equal(inbound(trace, "thread/turns/list").length, 3);
      assert.equal(inbound(trace, "turn/start").length, 1);
    } finally { await engine.dispose(); await removeDir(dataDir); }
  }
});

test("oversized recovery RPCs exhaust their budget without recursively launching more probes", async () => {
  const dataDir = await tempDir(), engine = createTestEngine(dataDir, "reconcile-probe-too-large", { maxLineBytes: 1024 });
  const batches = []; engine.on("turn-reconciliation", value => batches.push(value));
  try {
    await engine.createSession("owned", { cwd: dataDir });
    await engine.startTurn("owned", "bounded recovery");
    await waitFor(() => batches.length, 5000);
    assert.equal(engine.activeTurns.size, 1); assert.equal(engine.client.pending.size, 0);
    const count = (await readTrace(dataDir)).filter(entry => entry.direction === "in" && ["thread/read", "thread/turns/list"].includes(entry.msg.method)).length;
    assert.equal(count, 6);
    await pause(1150);
    assert.equal(batches.length, 1);
    assert.equal((await readTrace(dataDir)).filter(entry => entry.direction === "in" && ["thread/read", "thread/turns/list"].includes(entry.msg.method)).length, count);
    // Simulate a late giant reply after its recovery RPC has already timed out.
    // It may cause one further batch, but cannot keep replenishing the budget.
    const lateFrame = Buffer.from("x".repeat(1025) + "\n");
    engine.client._consumeStdout(lateFrame);
    await waitFor(() => batches.length === 2, 4000);
    engine.client._consumeStdout(lateFrame);
    await pause(1150);
    assert.equal(batches.length, 2);
    assert.equal((await readTrace(dataDir)).filter(entry => entry.direction === "in" && ["thread/read", "thread/turns/list"].includes(entry.msg.method)).length, count * 2);
    assert.equal(engine.activeTurns.size, 1);
  } finally { await engine.dispose(); await removeDir(dataDir); }
});

test("reconciliation cannot clear a newer active turn or deliver a completion after disposal", async () => {
  for (const scenario of ["reconcile-superseded", "reconcile-delayed"]) {
    const dataDir = await tempDir(), engine = createTestEngine(dataDir, scenario);
    const completed = [], batches = [];
    engine.on("turn-completed", value => completed.push(value)); engine.on("turn-reconciliation", value => batches.push(value));
    try {
      await engine.createSession("owned", { cwd: dataDir }); await engine.startTurn("owned", "lifecycle guard");
      if (scenario === "reconcile-superseded") {
        await waitFor(() => batches.length, 4000);
        assert.equal(engine.activeTurns.get("owned").turnId, "newer-active-turn"); assert.equal(completed.length, 0);
      } else {
        await waitFor(async () => inbound(await readTrace(dataDir), "thread/read").length, 2000);
        const oldClient = engine.client;
        await engine.dispose();
        oldClient.emit("notification", { method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-2", status: "completed" } } });
        await pause(250);
        assert.equal(completed.length, 0); assert.equal(batches.length, 0); assert.equal(oldClient.pending.size, 0);
      }
    } finally { await engine.dispose(); await removeDir(dataDir); }
  }
});

test("a later native duplicate cannot publish the recovered completion twice", async () => {
  const dataDir = await tempDir(), engine = createTestEngine(dataDir, "reconcile-duplicate");
  const completed = [], notes = [];
  engine.on("turn-completed", value => completed.push(value));
  engine.on("notification", value => { if (value.method === "turn/completed") notes.push(value); });
  try {
    await engine.createSession("owned", { cwd: dataDir }); await engine.startTurn("owned", "one completion");
    await waitFor(() => completed.length, 4000); await pause(150);
    assert.equal(completed.length, 1); assert.equal(notes.length, 1); assert.equal(completed[0].reconciled, true);
  } finally { await engine.dispose(); await removeDir(dataDir); }
});

test("unowned inflight entries are not queried or treated as completed", async () => {
  const dataDir = await tempDir(), engine = createTestEngine(dataDir);
  try {
    await engine.createSession("owned", { cwd: dataDir });
    engine.inflight.set("foreign", { threadId: "foreign-thread", turnId: "foreign-turn" });
    engine.client._consumeStdout(Buffer.from("x".repeat(1024 * 1024 + 1) + "\n"));
    await pause(100);
    assert.equal(engine.activeTurns.size, 1);
    const trace = await readTrace(dataDir);
    assert.equal(inbound(trace, "thread/read").length, 0); assert.equal(inbound(trace, "thread/turns/list").length, 0);
    engine.inflight.delete("foreign");
  } finally { await engine.dispose(); await removeDir(dataDir); }
});
