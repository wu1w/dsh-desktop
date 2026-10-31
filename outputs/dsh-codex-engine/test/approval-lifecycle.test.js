import assert from "node:assert/strict";
import test from "node:test";
import { AppServerClient, safeDenyResult } from "../lib/jsonrpc-client.js";
import { createTestEngine, inbound, readTrace, removeDir, tempDir, waitFor } from "./helpers.js";

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function capture(engine) {
  const values = [];
  engine.on("approval-resolved", value => { assert.deepEqual(Object.keys(value).sort(), ["id", "reason"]); values.push(value); });
  return values;
}

test("answered, expired and failed approval paths publish only their ID and resolution reason", async () => {
  for (const kind of ["answered", "expired", "failed", "undefined"]) {
    const dataDir = await tempDir();
    const engine = createTestEngine(dataDir, "approval", { approvalTimeoutMs: 25,
      ...(kind === "failed" ? { approvalHandler: () => { throw new Error("private handler detail"); } } : {}),
      ...(kind === "undefined" ? { approvalHandler: async () => undefined } : {}),
    });
    const resolved = capture(engine);
    engine.on("approval-required", request => { if (kind === "answered") engine.respondApproval(request.id, { decision: "decline" }); });
    try {
      await engine.createSession("owned", { cwd: dataDir }); await engine.startTurn("owned", "approval lifecycle");
      await waitFor(() => resolved.length, 1000);
      assert.deepEqual(resolved, [{ id: "7001", reason: kind === "undefined" ? "cancelled" : kind }]);
      assert.equal(engine.pendingApprovals.size, 0);
      const response = await waitFor(async () => (await readTrace(dataDir)).find(entry => entry.direction === "in" && entry.msg.id === 7001));
      if (kind === "failed") assert.equal(response.msg.error.code, -32001);
      else assert.equal(response.msg.result.decision, "decline");
    } finally { await engine.dispose(); await removeDir(dataDir); }
  }
});

test("native serverRequest/resolved closes the matching pending approval without replying to the resolved request", async () => {
  const dataDir = await tempDir(), engine = createTestEngine(dataDir, "approval-native-resolved", { approvalTimeoutMs: 1000 });
  const resolved = capture(engine); engine.on("approval-required", () => {});
  try {
    await engine.createSession("owned", { cwd: dataDir }); await engine.startTurn("owned", "native cancellation");
    await waitFor(() => resolved.length, 1000);
    assert.deepEqual(resolved, [{ id: "7001", reason: "cancelled" }]); assert.equal(engine.pendingApprovals.size, 0);
    assert.equal(engine.client.serverRequests.size, 0);
    assert.throws(() => engine.respondApproval(7001, { decision: "accept" }), error => error.code === "APPROVAL_NOT_FOUND");
    await pause(50);
    assert.equal((await readTrace(dataDir)).some(entry => entry.direction === "in" && entry.msg.id === 7001), false);
  } finally { await engine.dispose(); await removeDir(dataDir); }
});

test("a resolved notification for another thread cannot cancel the current request", async () => {
  const dataDir = await tempDir(), engine = createTestEngine(dataDir, "approval-native-mismatch", { approvalTimeoutMs: 1000 });
  const resolved = capture(engine), notifications = [];
  engine.on("approval-required", () => {}); engine.on("notification", value => notifications.push(value));
  try {
    await engine.createSession("owned", { cwd: dataDir }); await engine.startTurn("owned", "thread identity");
    await waitFor(() => notifications.some(value => value.method === "serverRequest/resolved"), 1000);
    assert.equal(engine.pendingApprovals.size, 1); assert.equal(resolved.length, 0);
    engine.respondApproval(7001, { decision: "decline" }); assert.deepEqual(resolved, [{ id: "7001", reason: "answered" }]);
  } finally { await engine.dispose(); await removeDir(dataDir); }
});

test("exit and disposal resolve pending approvals once and ignore a late handler result", async () => {
  for (const scenario of ["approval-exit", "approval"]) {
    const dataDir = await tempDir(); let settle;
    const engine = createTestEngine(dataDir, scenario, { approvalTimeoutMs: 1000, approvalHandler: () => new Promise(resolve => { settle = resolve; }) });
    const resolved = capture(engine);
    try {
      await engine.createSession("owned", { cwd: dataDir }); await engine.startTurn("owned", "cleanup");
      await waitFor(() => engine.pendingApprovals.size, 1000);
      if (scenario === "approval-exit") await waitFor(() => resolved.length, 1000); else await engine.dispose();
      assert.deepEqual(resolved, [{ id: "7001", reason: scenario === "approval-exit" ? "cancelled" : "disposed" }]);
      assert.equal(engine.pendingApprovals.size, 0);
      settle({ decision: "accept" }); await pause(50);
      assert.equal(resolved.length, 1); assert.equal(engine.client.serverRequests.size, 0);
    } finally { await engine.dispose(); await removeDir(dataDir); }
  }
});

test("a native resolution in the same stdout chunk prevents a deferred handler from creating a stale request", async () => {
  const rpc = new AppServerClient({ binary: process.execPath }); let called = 0;
  rpc.setHandler("item/commandExecution/requestApproval", () => { called++; return { decision: "decline" }; });
  rpc._consumeStdout(Buffer.from([
    { jsonrpc: "2.0", id: 9, method: "item/commandExecution/requestApproval", params: { threadId: "own" } },
    { jsonrpc: "2.0", method: "serverRequest/resolved", params: { threadId: "own", requestId: 9 } },
  ].map(value => JSON.stringify(value)).join("\n") + "\n"));
  await pause(0); assert.equal(called, 0); assert.equal(rpc.serverRequests.size, 0); await rpc.dispose();
});

test("legacy ReviewDecision denial is an object while v2 denial remains decline", async () => {
  for (const [scenario, method] of [["approval-legacy-exec", "execCommandApproval"], ["approval-legacy-patch", "applyPatchApproval"]]) {
    assert.deepEqual(safeDenyResult(method), { decision: { denied: { rejection: "denied" } } });
    const dataDir = await tempDir(), engine = createTestEngine(dataDir, scenario); const resolved = capture(engine);
    try {
      await engine.createSession("owned", { cwd: dataDir }); await engine.startTurn("owned", "default denial");
      const reply = await waitFor(async () => (await readTrace(dataDir)).find(entry => entry.direction === "in" && entry.msg.id === 7001));
      assert.deepEqual(reply.msg.result, { decision: { denied: { rejection: "denied" } } });
      assert.deepEqual(resolved, [{ id: "7001", reason: "expired" }]);
    } finally { await engine.dispose(); await removeDir(dataDir); }
  }
  assert.deepEqual(safeDenyResult("item/commandExecution/requestApproval"), { decision: "decline" });
});
