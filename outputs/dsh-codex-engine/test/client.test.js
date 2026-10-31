import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AppServerClient } from "../lib/jsonrpc-client.js";
import { fakeScript, SECRET, inbound, readTrace, waitFor } from "./helpers.js";

async function tempDir() {
  return mkdtemp(path.join(tmpdir(), "dsh-codex-client-"));
}

function client(dataDir, scenario, extra = {}) {
  return new AppServerClient({
    binary: process.execPath,
    args: [fakeScript],
    cwd: dataDir,
    env: {
      ...process.env,
      FAKE_SCENARIO: scenario,
      FAKE_TRACE_PATH: path.join(dataDir, "trace.jsonl"),
      FAKE_PROBE_PATH: path.join(dataDir, "probe.json"),
      DSH_OPENCODE_GO_KEY: SECRET,
      CODEX_HOME: dataDir,
    },
    secretValues: [SECRET],
    requestTimeoutMs: extra.requestTimeoutMs ?? 2000,
    maxLineBytes: extra.maxLineBytes ?? 1024 * 1024,
  });
}

test("handshake sends initialize then initialized", async () => {
  const dataDir = await tempDir();
  const rpc = client(dataDir, "ok");
  try {
    const init = await rpc.start();
    assert.equal(init.userAgent, "fake-app-server");
    assert.equal(init.codexHome, dataDir);
    // initialized is a notification, so start() cannot wait for a remote ACK.
    // Observe the fixture actually consuming it before asserting its trace.
    const trace = await waitFor(async () => {
      const entries = await readTrace(dataDir);
      return inbound(entries, 'initialized').length ? entries : null;
    });
    const methods = trace.filter((entry) => entry.direction === "in").map((entry) => entry.msg.method);
    assert.deepEqual(methods.slice(0, 2), ["initialize", "initialized"]);
    const initialize = inbound(trace, "initialize")[0].msg;
    assert.equal(initialize.params.clientInfo.name, "dsh_codex_engine");
    assert.equal(initialize.params.capabilities.requestAttestation, false);
    assert.equal(initialize.params.capabilities.experimentalApi, true);
    assert.equal(inbound(trace, "initialized")[0].msg.id, undefined);
  } finally {
    await rpc.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("invalid JSON and unknown server requests do not approve anything", async () => {
  const dataDir = await tempDir();
  const rpc = client(dataDir, "bad-json");
  const protocol = [];
  rpc.on("protocol-error", (error) => protocol.push(error));
  const notes = [];
  rpc.on("notification", (message) => notes.push(message));
  try {
    await rpc.start();
    await waitFor(() => notes.some((message) => message.method === "warning"));
    assert.ok(protocol.some((error) => error.code === "INVALID_JSON"));
  } finally {
    await rpc.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }

  const unknownDir = await tempDir();
  const unknown = client(unknownDir, "unknown-after-init");
  try {
    await unknown.start();
    const response = await waitFor(async () => {
      const trace = await readTrace(unknownDir);
      return trace.find((entry) => entry.direction === "in" && entry.msg?.id === 9001);
    });
    assert.equal(response.msg.error.code, -32601);
    assert.equal(response.msg.result, undefined);
  } finally {
    await unknown.dispose();
    await rm(unknownDir, { recursive: true, force: true });
  }
});

test("recognized approval without a handler is declined", async () => {
  const dataDir = await tempDir();
  const rpc = client(dataDir, "ok");
  try {
    await rpc.start();
    rpc.notify("initialized");
  } finally {
    await rpc.dispose();
  }
  const approvalDir = await tempDir();
  const approval = client(approvalDir, "deny-approval");
  try {
    await approval.start();
    await approval.request("thread/start", {
      model: "deepseek-v4.1-flash",
      modelProvider: "opencode_go",
      cwd: approvalDir,
    });
    await approval.request("turn/start", { threadId: "thread-1", input: [] });
    const denied = await waitFor(async () => {
      const trace = await readTrace(approvalDir);
      return trace.find((entry) => entry.direction === "in" && entry.msg?.id === 7001);
    });
    assert.equal(denied.msg.result.decision, "decline");
  } finally {
    await approval.dispose();
    await rm(approvalDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("handler receives approval and cancellation rejects a hung request", async () => {
  const dataDir = await tempDir();
  const rpc = client(dataDir, "approval");
  let forwarded = null;
  rpc.setHandler("item/commandExecution/requestApproval", async (params, meta) => {
    forwarded = { params, meta };
    return { decision: "accept" };
  });
  try {
    await rpc.start();
    await rpc.request("thread/start", { model: "deepseek-v4.1-flash", modelProvider: "opencode_go", cwd: dataDir });
    await rpc.request("turn/start", { threadId: "thread-1", input: [] });
    const accepted = await waitFor(async () => {
      const trace = await readTrace(dataDir);
      return trace.find((entry) => entry.direction === "in" && entry.msg?.id === 7001);
    });
    assert.equal(accepted.msg.result.decision, "accept");
    assert.equal(forwarded.params.command, "pwd");
  } finally {
    await rpc.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }

  const hangDir = await tempDir();
  const hanging = client(hangDir, "hang", { requestTimeoutMs: 50 });
  try {
    await hanging.start();
    await assert.rejects(
      hanging.request("thread/read", { threadId: "missing" }),
      (error) => error.code === "TIMEOUT",
    );
    const controller = new AbortController();
    const pending = hanging.request("thread/read", { threadId: "missing" }, {
      timeoutMs: 2000,
      signal: controller.signal,
    });
    controller.abort();
    await assert.rejects(pending, (error) => error.code === "ABORTED");
  } finally {
    await hanging.dispose();
    await rm(hangDir, { recursive: true, force: true });
  }
});

test("dispose rejects a hung request and redacts stderr", async () => {
  const hangDir = await tempDir();
  const hanging = client(hangDir, "hang-turn");
  try {
    await hanging.start();
    const pending = hanging.request("turn/start", { threadId: "thread-1" }, { timeoutMs: 5000 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const settled = Promise.race([
      pending.then(() => "resolved", (error) => error.code),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 1500)),
    ]);
    await hanging.dispose();
    assert.equal(await settled, "DISPOSED");
    await assert.rejects(hanging.request("thread/read", {}), (error) => error.code === "DISPOSED");
  } finally {
    await rm(hangDir, { recursive: true, force: true });
  }

  const secretDir = await tempDir();
  const noisy = client(secretDir, "stderr-secret");
  const stderr = [];
  noisy.on("stderr", (text) => stderr.push(text));
  try {
    await noisy.start();
    await waitFor(() => stderr.length > 0);
    const joined = stderr.join("\n");
    assert.equal(joined.includes(SECRET), false);
    assert.equal(joined.includes("sk-supersecretvalue"), false);
    assert.match(joined, /\[redacted\]/);
  } finally {
    await noisy.dispose();
    await rm(secretDir, { recursive: true, force: true });
  }
});

test("oversized lines and spawn failure surface without hanging", async () => {
  const dataDir = await tempDir();
  const rpc = client(dataDir, "huge-line", { maxLineBytes: 1024 });
  const protocol = [];
  const notes = [];
  rpc.on("protocol-error", (error) => protocol.push(error));
  rpc.on("notification", (message) => notes.push(message));
  try {
    await rpc.start();
    await waitFor(() => notes.some((message) => message.params?.message === "after-huge"));
    assert.ok(protocol.some((error) => error.code === "LINE_TOO_LONG"));
  } finally {
    await rpc.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }

  const missing = new AppServerClient({
    binary: path.join(dataDir, "missing-codex-binary"),
    args: ["app-server"],
    env: process.env,
    requestTimeoutMs: 500,
  });
  await assert.rejects(missing.start(), (error) => error.code === "SPAWN_FAILED" || error.code === "DISPOSED");
  await missing.dispose();
});

test("stdout preserves UTF8 at every byte boundary and enforces the exact byte limit", () => {
  const note = { jsonrpc: "2.0", method: "warning", params: { message: "中文、é、🤖，完整输出" } };
  const line = JSON.stringify(note);
  const bytes = Buffer.from(`${line}\n`, "utf8");
  const limit = Buffer.byteLength(line, "utf8");
  assert.ok(limit > line.length);
  const rpc = new AppServerClient({ binary: process.execPath, maxLineBytes: limit });
  const notes = [];
  const protocol = [];
  rpc.on("notification", message => notes.push(message));
  rpc.on("protocol-error", error => protocol.push(error));
  for (const byte of bytes) rpc._consumeStdout(Buffer.from([byte]));
  assert.deepEqual(notes, [note]);
  assert.deepEqual(protocol, []);
  assert.equal(rpc.buffer, "");

  const tooSmall = new AppServerClient({ binary: process.execPath, maxLineBytes: limit - 1 });
  const rejected = [];
  tooSmall.on("protocol-error", error => rejected.push(error.code));
  tooSmall.on("notification", () => assert.fail("byte-oversized line was accepted"));
  tooSmall._consumeStdout(bytes);
  assert.deepEqual(rejected, ["LINE_TOO_LONG"]);
});

test("oversized response immediately rejects all pending requests including timeoutMs:null and keeps the child reusable", async () => {
  const dataDir = await tempDir();
  const rpc = client(dataDir, "oversized-read", { maxLineBytes: 1024 });
  const settled = [];
  const notes = [];
  let recovery;
  let pendingAtError;
  rpc.on("notification", message => notes.push(message));
  rpc.on("protocol-error", error => {
    if (error.code !== "LINE_TOO_LONG") return;
    pendingAtError = rpc.pending.size;
    // A synchronous listener may start a new request after the existing ones
    // failed. It must not be included in this frame's failAll operation.
    recovery = rpc.request("thread/read", { threadId: "after-event" });
  });
  try {
    await rpc.start();
    const pid = rpc.pid;
    for (const threadId of ["pending", "oversized"]) {
      rpc.request("thread/read", { threadId }, { timeoutMs: null }).then(
        () => settled.push("unexpected success"),
        error => settled.push(error.code),
      );
    }
    await waitFor(() => settled.length === 2, 500);
    assert.deepEqual(settled, ["LINE_TOO_LONG", "LINE_TOO_LONG"]);
    assert.equal(pendingAtError, 0);
    assert.equal(rpc.pid, pid);
    assert.equal(rpc.ready, true);
    assert.equal((await recovery).thread.id, "after-event");
    assert.equal(rpc.pending.size, 0);
    await waitFor(() => notes.some(message => message.params?.message === "after-oversized-response"));
    const trace = await readTrace(dataDir);
    const oversized = trace.find(entry => entry.direction === "out" && entry.msg?.result?.thread?.id === "oversized").msg;
    assert.ok(JSON.stringify(oversized).length < 1024);
    assert.ok(Buffer.byteLength(JSON.stringify(oversized), "utf8") > 1024);
    assert.equal(inbound(trace, "thread/read").length, 3);
  } finally {
    await rpc.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("an oversized unterminated frame rejects immediately and resynchronizes after the next newline", async () => {
  const rpc = new AppServerClient({ binary: process.execPath, maxLineBytes: 128 });
  const writes = [];
  rpc.child = { stdin: { writable: true, write: value => writes.push(JSON.parse(value)) } };
  rpc.ready = true;
  const protocol = [];
  const notes = [];
  rpc.on("protocol-error", error => protocol.push(error.code));
  rpc.on("notification", message => notes.push(message));
  try {
    const pending = rpc.request("thread/read", {}, { timeoutMs: null });
    const rejected = assert.rejects(pending, error => error.code === "LINE_TOO_LONG");
    rpc._consumeStdout(Buffer.from("x".repeat(129)));
    assert.equal(rpc.pending.size, 0);
    assert.equal(rpc.skipping, true);
    await rejected;
    const healthy = rpc.request("thread/read", {}, { timeoutMs: null });
    const id = writes.at(-1).id;
    const response = { jsonrpc: "2.0", id, result: { thread: { id: "recovered" } } };
    const note = { jsonrpc: "2.0", method: "warning", params: { message: "同块恢复" } };
    rpc._consumeStdout(Buffer.from(`ignored-tail\n${JSON.stringify(response)}\n${JSON.stringify(note)}\n`));
    assert.equal((await healthy).thread.id, "recovered");
    assert.deepEqual(notes, [note]);
    assert.deepEqual(protocol, ["LINE_TOO_LONG"]);
    assert.equal(rpc.skipping, false);
    assert.equal(rpc.pending.size, 0);
  } finally {
    // This parser-only test never spawns a child.
    rpc.child = null;
    await rpc.dispose();
  }
});

test("initialize failure is not reported as success", async () => {
  const dataDir = await tempDir();
  const rpc = client(dataDir, "init-fail");
  try {
    await assert.rejects(rpc.start(), (error) => error.code === "RPC_FAILED" && error.rpcCode === -32000);
  } finally {
    await rpc.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("stderr fixture does not write the secret into the probe file", async () => {
  const dataDir = await tempDir();
  const rpc = client(dataDir, "stderr-secret");
  try {
    await rpc.start();
    const probe = JSON.parse(await readFile(path.join(dataDir, "probe.json"), "utf8"));
    assert.equal(JSON.stringify(probe).includes(SECRET), false);
    assert.equal(probe.hasGoKey, true);
  } finally {
    await rpc.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});
