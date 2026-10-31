import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AgentLoop } from "@deepseek-ai/dsh-agent-loop";
import { createRequire } from "node:module";
import { DeepSeekAdapter } from "@deepseek-ai/dsh-llm-deepseek";
import { DshNativeEngine } from "../lib/engine.js";
import { DEFAULT_BASE_URL, PROVIDER } from "../lib/provider.js";
import { ScriptedAdapter, textChunk, toolChunk } from "../lib/scripted-adapter.js";

const require = createRequire(import.meta.url);

function visible(options) {
  return JSON.stringify(options.messages ?? []);
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-native-engine-"));
  const dataDir = path.join(root, "data");
  const cwd = path.join(root, "project");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dataDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  return {
    dataDir,
    cwd,
    async cleanup(engine) {
      await engine?.dispose?.().catch(() => {});
      await rm(root, { recursive: true, force: true });
    },
  };
}

function engineFor(env, adapter, extra = {}) {
  return new DshNativeEngine({
    dataDir: env.dataDir,
    locale: "en",
    adapter,
    resolveSharedInstructions: extra.resolveSharedInstructions ?? (async () => "INSTR-FRESH"),
    resolveApiKey: async () => { throw new Error("tests must not request a real key"); },
    ...extra,
  });
}

test("pins the real agent loop and official DeepSeek adapter", () => {
  const version = require("@deepseek-ai/dsh-agent-loop/package.json").version;
  assert.equal(version, "0.2.1-rc.2");
  assert.deepEqual(AgentLoop.inject, ["agents", "sessions", "llm", "tools", "systemPrompt", "sessionProjections"]);
  assert.equal(typeof DeepSeekAdapter, "function");
  assert.equal(PROVIDER, "opencode_go");
  assert.equal(DEFAULT_BASE_URL, "https://opencode.ai/inference/go/anthropic");
});

test("boots the native loop, completes a turn, and replays it after restart", async (t) => {
  const env = await fixture();
  const seen = [];
  const adapter = new ScriptedAdapter(async (options) => {
    seen.push(visible(options));
    return textChunk(seen.length === 1 ? "ALPHA-TOKEN" : "BETA-TOKEN");
  });
  const first = engineFor(env, adapter, { resolveSharedInstructions: async () => "INSTR-ONE" });
  t.after(() => env.cleanup(first));
  const id = crypto.randomUUID();
  const created = await first.createSession(id, { cwd: env.cwd, sharedContext: "SHARED-HISTORY", settings: { context: "ignored-when-shared" } });
  assert.equal(created.engine, "dsh-native");
  assert.equal(created.threadId, id);
  assert.equal(created.sharedContext, "SHARED-HISTORY");
  const completed = new Promise((resolve) => first.once("turn-completed", resolve));
  const started = await first.startTurn(id, "say alpha");
  assert.equal(started.status, "inProgress");
  await completed;
  const done = await first.readTurnState(id, started.turnId);
  assert.equal(done.status, "completed");
  assert.match(seen[0], /SHARED-HISTORY/);
  assert.match(seen[0], /INSTR-ONE/);
  assert.match(seen[0], /say alpha/);
  const transcript = await first.readSession(id);
  assert.match(JSON.stringify(transcript), /ALPHA-TOKEN/);
  await first.dispose();

  const secondAdapter = new ScriptedAdapter(async (options) => {
    seen.push(visible(options));
    return textChunk("BETA-TOKEN");
  });
  const second = engineFor(env, secondAdapter, { resolveSharedInstructions: async () => "INSTR-RESTART" });
  t.after(() => second.dispose());
  const resumed = await second.resumeSession(id);
  assert.equal(resumed.sharedContext, "SHARED-HISTORY");
  const completedAgain = new Promise((resolve) => second.once("turn-completed", resolve));
  const again = await second.startTurn(id, "say beta");
  await completedAgain;
  const replay = seen.at(-1);
  assert.match(replay, /ALPHA-TOKEN/);
  assert.match(replay, /SHARED-HISTORY/);
  assert.match(replay, /INSTR-RESTART/);
  assert.equal((await second.readTurnState(id, again.turnId)).status, "completed");
  const index = JSON.parse(await readFile(path.join(env.dataDir, "sessions.json"), "utf8"));
  assert.equal(index.sessions[0].sessionId, id);
});

test("cancels an in-flight native turn without leaving it running", async (t) => {
  const env = await fixture();
  t.after(() => env.cleanup());
  const adapter = new ScriptedAdapter(async () => ({ hang: true }));
  const engine = engineFor(env, adapter);
  t.after(() => engine.dispose());
  const id = crypto.randomUUID();
  await engine.createSession(id, { cwd: env.cwd, sharedContext: "SHARED-HISTORY" });
  const started = await engine.startTurn(id, "wait");
  await new Promise((resolve) => setTimeout(resolve, 30));
  const interrupted = await engine.interrupt(id);
  assert.equal(interrupted.interrupted, true);
  assert.equal(interrupted.turnId, started.turnId);
  const state = await engine.readTurnState(id);
  assert.equal(state.status, "interrupted");
  assert.equal(state.active, false);
});

test("runs the real read tool and does not replay a denied write", async (t) => {
  const env = await fixture();
  t.after(() => env.cleanup());
  await writeFile(path.join(env.cwd, "hello.txt"), "hello-from-disk\n");
  const target = path.join(env.cwd, "written.txt");
  let calls = 0;
  const adapter = new ScriptedAdapter(async () => {
    calls += 1;
    if (calls === 1) return toolChunk("read", { file_path: path.join(env.cwd, "hello.txt") });
    if (calls === 2) return textChunk("READ-OK");
    if (calls === 3) return toolChunk("write", { file_path: target, content: "should-not-land" });
    return textChunk("WRITE-DENIED");
  });
  const engine = engineFor(env, adapter);
  t.after(() => engine.dispose());
  const id = crypto.randomUUID();
  await engine.createSession(id, { cwd: env.cwd, sharedContext: "SHARED-HISTORY", sandbox: "workspace-write" });
  engine.on("approval-required", (request) => {
    engine.respondApproval(request.id, { decision: "cancel" }).catch(() => {});
  });
  const readDone = new Promise((resolve) => engine.once("turn-completed", resolve));
  await engine.startTurn(id, "read the file");
  await readDone;
  const first = await engine.readSession(id);
  assert.match(JSON.stringify(first), /hello-from-disk/);
  assert.match(JSON.stringify(first), /READ-OK/);
  const writeDone = new Promise((resolve) => engine.once("turn-completed", resolve));
  await engine.startTurn(id, "write the file");
  await writeDone;
  await assert.rejects(readFile(target, "utf8"), { code: "ENOENT" });
  const second = await engine.readSession(id);
  const writeTurn = second.thread.turns.at(-1);
  const writeItem = writeTurn.items.find((item) => item.command === "write");
  assert.equal(writeTurn.status, "completed");
  assert.equal(writeItem.status, "failed");
  assert.match(writeItem.aggregatedOutput, /not approved/);
  assert.doesNotMatch(writeItem.aggregatedOutput, /should-not-land/);
  assert.match(JSON.stringify(second), /WRITE-DENIED/);
  await engine.dispose();

  const replayed = [];
  const resumed = engineFor(env, new ScriptedAdapter(async (options) => {
    replayed.push(visible(options));
    return textChunk("NO-RETRY");
  }));
  t.after(() => resumed.dispose());
  await resumed.resumeSession(id);
  const replayDone = new Promise((resolve) => resumed.once("turn-completed", resolve));
  await resumed.startTurn(id, "continue");
  await replayDone;
  assert.match(replayed[0], /not approved/);
  assert.doesNotMatch(replayed[0], /outcome is unknown/);
  await assert.rejects(readFile(target, "utf8"), { code: "ENOENT" });
});

test("queues a follow-up and refuses to start it during a turn", async (t) => {
  const env = await fixture();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const adapter = new ScriptedAdapter(async () => {
    calls += 1;
    if (calls === 1) {
      await gate;
      return textChunk("FIRST-DONE");
    }
    return textChunk("QUEUED-DONE");
  });
  const engine = engineFor(env, adapter, { autoQueue: false });
  t.after(() => env.cleanup(engine));
  const id = crypto.randomUUID();
  await engine.createSession(id, { cwd: env.cwd, sharedContext: "SHARED-HISTORY" });
  const added = await engine.queueRequest(id, "add", { input: "queued message" });
  const listed = await engine.queueRequest(id, "list");
  assert.equal(listed.data.length, 1);
  assert.equal(listed.data[0].status, "queued");
  assert.equal(listed.data[0].input[0].text, "queued message");
  const running = new Promise((resolve) => engine.once("turn-completed", resolve));
  const started = await engine.startTurn(id, "first");
  await new Promise((resolve) => setTimeout(resolve, 30));
  await assert.rejects(engine.startQueued(id), (error) => error.code === "TURN_IN_FLIGHT");
  const extra = await engine.queueRequest(id, "add", { input: "second queued" });
  release();
  await running;
  assert.equal((await engine.readTurnState(id, started.turnId)).status, "completed");
  const queuedDone = new Promise((resolve) => engine.once("turn-completed", resolve));
  await engine.startQueued(id, { queuedSubmissionId: added.queuedSubmission.id });
  await queuedDone;
  const session = JSON.stringify(await engine.readSession(id));
  assert.match(session, /queued message/);
  assert.match(session, /QUEUED-DONE/);
  const left = await engine.queueRequest(id, "list");
  assert.equal(left.data.length, 1);
  assert.equal(left.data[0].id, extra.queuedSubmission.id);
  await engine.dispose();

  const restoredEngine = engineFor(env, new ScriptedAdapter(async () => textChunk("IGNORED")), { autoQueue: false });
  t.after(() => restoredEngine.dispose());
  await restoredEngine.resumeSession(id);
  const restored = await restoredEngine.queueRequest(id, "list");
  assert.equal(restored.data[0].status, "queued");
  assert.equal(restored.data[0].input[0].text, "second queued");
});

test('computer tool is scoped to the native session and returns observed data through the real loop',async t=>{
 const env=await fixture();let step=0;const calls=[];
 const adapter=new ScriptedAdapter(async options=>{step++;if(step===1)return toolChunk('dsh_computer',{action:'observe'});assert.match(JSON.stringify(options.messages),/CUA_NATIVE_VERIFIED/);return textChunk('CUA_NATIVE_DONE');});
 const {computerTool}=await import('../../dsh-codex-client/shared/computer-tool.js');
 const engine=engineFor(env,adapter,{computerTool,computerCall:async(id,input,{signal})=>{calls.push({id,input,aborted:signal.aborted});return {text:'CUA_NATIVE_VERIFIED'};}});t.after(()=>env.cleanup(engine));const id=crypto.randomUUID();await engine.createSession(id,{cwd:env.cwd});const done=new Promise(resolve=>engine.once('turn-completed',resolve));await engine.startTurn(id,'Observe the connected computer');await done;assert.deepEqual(calls.map(c=>[c.id,c.input.action,c.aborted]),[[id,'observe',false]]);assert.match(JSON.stringify(await engine.readSession(id)),/CUA_NATIVE_DONE/);
});

test("selected reasoning effort reaches the native model request",async t=>{const env=await fixture(),adapter=new ScriptedAdapter(()=>textChunk('Reasoning request complete'));const engine=engineFor(env,adapter);t.after(()=>env.cleanup(engine));const id=crypto.randomUUID();await engine.createSession(id,{cwd:env.cwd});for(const effort of ['low','max']){const done=new Promise(resolve=>engine.once('turn-completed',resolve));await engine.startTurn(id,'Reply once',{effort});await done;assert.equal(adapter.calls.at(-1).reasoningEffort,effort);}});
