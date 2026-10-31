import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTranslator } from "../lib/i18n.js";
import {
  SECRET,
  createTestEngine,
  inbound,
  readProbe,
  readTrace,
  removeDir,
  tempDir,
  waitFor,
} from "./helpers.js";

const engineSourceUrl = new URL("../lib/engine.js", import.meta.url);

test("provider config is isolated and the key stays out of args and disk", async () => {
  const previousOpenAI = process.env.OPENAI_API_KEY;
  const previousCodex = process.env.CODEX_API_KEY;
  const previousHome = process.env.CODEX_HOME;
  process.env.OPENAI_API_KEY = "sk-should-not-pass";
  process.env.CODEX_API_KEY = "codex-should-not-pass";
  process.env.CODEX_HOME = path.join(os.homedir(), ".codex");
  const dataDir = await tempDir();
  const engine = createTestEngine(dataDir, "ok");
  try {
    await engine.start();
    const probe = await readProbe(dataDir);
    assert.equal(probe.codexHome, engine.codexHome);
    assert.equal(probe.hasOpenAI, false);
    assert.equal(probe.hasCodexApi, false);
    assert.equal(probe.hasGoKey, true);
    assert.equal(probe.keyInArgv, false);
    const config = await readFile(path.join(engine.codexHome, "config.toml"), "utf8");
    assert.match(config, /model = "deepseek-v4\.1-flash"/);
    assert.match(config, /model_provider = "opencode_go"/);
    assert.match(config, /env_key = "DSH_OPENCODE_GO_KEY"/);
    assert.match(config, /wire_api = "responses"/);
    assert.match(config, /requires_openai_auth = false/);
    assert.match(config, /supports_websockets = false/);
    assert.match(config, /code_mode = false/);
    assert.match(config, /web_search = "disabled"/);
    assert.equal(config.includes(SECRET), false);
    assert.equal(config.includes("sk-should-not-pass"), false);
    const status = JSON.stringify(engine.status());
    assert.equal(status.includes(SECRET), false);
    assert.equal(status.includes("OPENAI_API_KEY"), false);
    assert.equal(engine.status().stateLabel.length > 0, true);
  } finally {
    await engine.dispose();
    await removeDir(dataDir);
    restore("OPENAI_API_KEY", previousOpenAI);
    restore("CODEX_API_KEY", previousCodex);
    restore("CODEX_HOME", previousHome);
  }
});

test("missing provider and the original Codex home fail before fallback", async () => {
  const dataDir = await tempDir();
  const engine = createTestEngine(dataDir, "ok", { resolveApiKey: () => "" });
  try {
    await assert.rejects(engine.start(), (error) => error.code === "PROVIDER_UNAVAILABLE" && error.key === "error.provider_unavailable");
    await assert.rejects(access(path.join(dataDir, "codex", "config.toml")));
    assert.equal(engine.ready, false);
  } finally {
    await engine.dispose();
    await removeDir(dataDir);
  }

  assert.throws(
    () => createTestEngine(path.join(os.homedir(), ".codex")),
    (error) => error.code === "UNSAFE_CODEX_HOME",
  );
  assert.throws(
    () => createTestEngine("/tmp/not-a-sandbox", "ok", { sandbox: "invalid-sandbox" }),
    (error) => error.code === "SANDBOX_REJECTED",
  );
});

test("one session keeps one thread across restart and does not replay history", async () => {
  const dataDir = await tempDir();
  const cwd = dataDir;
  const first = createTestEngine(dataDir);
  let created;
  try {
    created = await first.createSession("alpha", { cwd });
    assert.equal(created.provider, "opencode_go");
    assert.equal(created.model, "deepseek-v4.1-flash");
    const trace = await readTrace(dataDir);
    const start = inbound(trace, "thread/start")[0].msg.params;
    assert.equal(start.allowProviderModelFallback, false);
    assert.equal(start.sandbox, "read-only");
    assert.equal(start.approvalPolicy, "on-request");
    assert.equal(start.config.features.code_mode, false);
    assert.equal(start.config.model_providers.opencode_go.requires_openai_auth, false);
    assert.equal(JSON.stringify(start).includes(SECRET), false);
    await assert.rejects(first.createSession("alpha", { cwd }), (error) => error.code === "SESSION_EXISTS");
  } finally {
    await first.dispose();
  }

  const second = createTestEngine(dataDir);
  try {
    const listed = await second.listSessions();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].threadId, created.threadId);
    const offline = await second.readSession("alpha");
    assert.equal(offline.threadId, created.threadId);
    assert.equal(second.ready, false);
    const resumed = await second.resumeSession("alpha");
    assert.equal(resumed.threadId, created.threadId);
    const trace = await readTrace(dataDir);
    const starts = inbound(trace, "thread/start");
    const resumes = inbound(trace, "thread/resume");
    assert.equal(starts.length, 1);
    assert.equal(resumes.length, 1);
    assert.equal(resumes[0].msg.params.threadId, created.threadId);
    assert.equal("history" in resumes[0].msg.params, false);
    assert.equal("path" in resumes[0].msg.params, false);
    assert.equal(resumes[0].msg.params.excludeTurns, true);
    const remote = await second.readSession("alpha");
    assert.equal(remote.remoteThreadId, created.threadId);
    const read = inbound(await readTrace(dataDir), "thread/read")[0].msg.params;
    assert.equal(read.includeTurns, false);
  } finally {
    await second.dispose();
    await removeDir(dataDir);
  }
});

test("a second turn is rejected until the active turn is interrupted", async () => {
  const dataDir = await tempDir();
  const engine = createTestEngine(dataDir);
  const completed = [];
  engine.on("turn-completed", (event) => completed.push(event));
  try {
    await engine.createSession("alpha", { cwd: dataDir });
    const started = await engine.startTurn("alpha", "hello");
    assert.equal(started.status, "inProgress");
    assert.equal(engine.state, "turn-active");
    await assert.rejects(engine.startTurn("alpha", "again"), (error) => error.code === "TURN_IN_FLIGHT");
    const stopped = await engine.interrupt("alpha");
    assert.equal(stopped.turnId, started.turnId);
    await waitFor(() => completed.some((event) => event.turnId === started.turnId));
    assert.equal(engine.activeTurns.size, 0);
    const next = await engine.startTurn("alpha", { text: "continue" });
    assert.notEqual(next.turnId, started.turnId);
  } finally {
    await engine.dispose();
    await removeDir(dataDir);
  }
});

test("provider mismatch and archive failure do not rewrite the owned mapping", async () => {
  const mismatchDir = await tempDir();
  const mismatch = createTestEngine(mismatchDir, "provider-mismatch");
  try {
    await assert.rejects(
      mismatch.createSession("alpha", { cwd: mismatchDir }),
      (error) => error.code === "PROVIDER_MISMATCH",
    );
    assert.deepEqual(await mismatch.listSessions(), []);
  } finally {
    await mismatch.dispose();
    await removeDir(mismatchDir);
  }

  const dataDir = await tempDir();
  const engine = createTestEngine(dataDir, "archive-fail");
  try {
    const created = await engine.createSession("alpha", { cwd: dataDir });
    await assert.rejects(engine.archiveSession("alpha"), (error) => error.code === "RPC_FAILED");
    const stored = JSON.parse(await readFile(path.join(dataDir, "sessions.json"), "utf8"));
    assert.equal(stored.sessions.alpha.archived, false);
    assert.equal(stored.sessions.alpha.threadId, created.threadId);
    assert.equal(Object.keys(stored.sessions).length, 1);
  } finally {
    await engine.dispose();
    await removeDir(dataDir);
  }
});

test("a crashed child rejects the turn and keeps the original thread", async () => {
  const dataDir = await tempDir();
  const engine = createTestEngine(dataDir, "crash-on-turn");
  try {
    const created = await engine.createSession("alpha", { cwd: dataDir });
    await assert.rejects(engine.startTurn("alpha", "run"), (error) => error.code === "PROCESS_EXIT");
    assert.equal(engine.activeTurns.size, 0);
    const listed = await engine.listSessions();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].threadId, created.threadId);
    const trace = await readTrace(dataDir);
    assert.equal(inbound(trace, "thread/start").length, 1);
  } finally {
    await engine.dispose();
    await removeDir(dataDir);
  }
});

test("approval events forward a caller decision and otherwise decline", async () => {
  const allowDir = await tempDir();
  const allow = createTestEngine(allowDir, "approval", { approvalTimeoutMs: 1000 });
  try {
    allow.on("approval-required", (request) => {
      allow.respondApproval(request.id, { decision: "accept" });
    });
    await allow.createSession("alpha", { cwd: allowDir });
    await allow.startTurn("alpha", "please run");
    const accepted = await waitFor(async () => {
      const trace = await readTrace(allowDir);
      return trace.find((entry) => entry.direction === "in" && entry.msg?.id === 7001);
    });
    assert.equal(accepted.msg.result.decision, "accept");
  } finally {
    await allow.dispose();
    await removeDir(allowDir);
  }

  const denyDir = await tempDir();
  const deny = createTestEngine(denyDir, "deny-approval");
  try {
    await deny.createSession("alpha", { cwd: denyDir });
    await deny.startTurn("alpha", "please run");
    const declined = await waitFor(async () => {
      const trace = await readTrace(denyDir);
      return trace.find((entry) => entry.direction === "in" && entry.msg?.id === 7001);
    });
    assert.equal(declined.msg.result.decision, "decline");
  } finally {
    await deny.dispose();
    await removeDir(denyDir);
  }
});

test("stderr secrets are redacted and user-facing engine text is translated", async () => {
  const dataDir = await tempDir();
  const engine = createTestEngine(dataDir, "stderr-secret", { locale: "en" });
  const stderr = [];
  engine.on("stderr", (text) => stderr.push(text));
  try {
    await engine.start();
    await waitFor(() => stderr.length > 0);
    const joined = stderr.join("\n");
    assert.equal(joined.includes(SECRET), false);
    assert.equal(joined.includes("sk-supersecretvalue"), false);
    await assert.rejects(engine.readSession("missing"), (error) => {
      assert.equal(error.code, "SESSION_NOT_FOUND");
      assert.match(error.message, /No Codex thread/);
      return true;
    });
  } finally {
    await engine.dispose();
    await removeDir(dataDir);
  }

  const chinese = createTestEngine(await tempDir(), "ok", { locale: "zh-CN", resolveApiKey: () => "" });
  try {
    await assert.rejects(chinese.start(), (error) => {
      assert.match(error.message, /不会回退到 GPT/);
      return true;
    });
  } finally {
    await chinese.dispose();
  }

  const translate = createTranslator("fr");
  assert.match(translate("error.disposed"), /stopped/i);
  const source = await readFile(engineSourceUrl, "utf8");
  assert.equal(/[\u4e00-\u9fff]/.test(source), false);
  assert.equal(source.includes("cordis"), false);
});

test("oversized history keeps its machine code, translated message and owned thread mapping", async () => {
  for (const [locale, message] of [["en", /size limit/], ["zh-CN", /超过大小上限/]]) {
    const dataDir = await tempDir();
    const engine = createTestEngine(dataDir, "oversized-read", { locale, maxLineBytes: 1024 });
    try {
      const created = await engine.createSession("alpha", { cwd: dataDir });
      const before = await readFile(path.join(dataDir, "sessions.json"), "utf8");
      await assert.rejects(engine.readSession("alpha", { includeTurns: true }), error => {
        assert.equal(error.code, "LINE_TOO_LONG");
        assert.equal(error.key, "error.line_too_long");
        assert.match(error.message, message);
        return true;
      });
      assert.equal(engine.ready, true);
      const metadata = await engine.readSession("alpha");
      assert.equal(metadata.remoteThreadId, created.threadId);
      assert.equal(await readFile(path.join(dataDir, "sessions.json"), "utf8"), before);
    } finally {
      await engine.dispose();
      await removeDir(dataDir);
    }
  }
});

test("fork persists a new owned mapping and foreign threads are not imported", async () => {
  const dataDir = await tempDir();
  const engine = createTestEngine(dataDir);
  try {
    const created = await engine.createSession("alpha", { cwd: dataDir });
    const forked = await engine.forkSession("alpha", "beta");
    assert.notEqual(forked.threadId, created.threadId);
    assert.equal(forked.forkedFromSessionId, "alpha");
    const names = (await engine.listSessions()).map((session) => session.sessionId).sort();
    assert.deepEqual(names, ["alpha", "beta"]);
    const renamed = await engine.renameSession("beta", "branch");
    assert.equal(renamed.name, "branch");
    await engine.archiveSession("beta");
    await assert.rejects(engine.startTurn("beta", "nope"), (error) => error.code === "ARCHIVED");
    const stored = JSON.parse(await readFile(path.join(dataDir, "sessions.json"), "utf8"));
    assert.equal(Object.keys(stored.sessions).length, 2);
  } finally {
    await engine.dispose();
    await removeDir(dataDir);
  }
});

function restore(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}


test('an instruction profile is pinned to its native thread across reload, fork, and changed defaults',async()=>{
  const dataDir=await tempDir();let engine;
  const profile=text=>({id:'profile-'+text,version:1,instructionHash:'hash-'+text,threadParams:{baseInstructions:text}});
  try{
    engine=createTestEngine(dataDir,'ok',{resolveInstructionProfile:()=>profile('original')});
    const created=await engine.createSession('profile-session',{cwd:dataDir});
    assert.equal(created.instructionProfile.id,'profile-original');
    await engine.dispose();
    engine=createTestEngine(dataDir,'ok',{resolveInstructionProfile:()=>profile('new-default')});
    await engine.resumeSession('profile-session');
    let trace=await readTrace(dataDir);
    assert.equal(inbound(trace,'thread/resume').at(-1).msg.params.baseInstructions,'original');
    const fork=await engine.forkSession('profile-session','profile-fork');
    assert.equal(fork.instructionProfile.instructionHash,'hash-original');
    const changed=await engine.createSession('new-profile-session',{cwd:dataDir});
    assert.equal(changed.instructionProfile.id,'profile-new-default');
    await assert.rejects(engine.setModel('profile-session','deepseek-other'),error=>error.code==='PROFILE_MODEL_MISMATCH');
    trace=await readTrace(dataDir);
    assert.equal(inbound(trace,'thread/start').at(-1).msg.params.baseInstructions,'new-default');
    const persisted=JSON.parse(await readFile(path.join(dataDir,'sessions.json'),'utf8'));
    assert.equal(persisted.sessions['profile-session'].instructionProfile.threadParams.baseInstructions,'original');
  }finally{await engine?.dispose();await removeDir(dataDir);}
});

test('shared instructions reach first turn and refresh on resume; empty handoff survives restart',async()=>{
 const dataDir=await tempDir();let setting='SETTING_A';const options={resolveSharedInstructions:async()=>setting};let engine=createTestEngine(dataDir,'ok',options);
 try{
  await engine.createSession('shared-empty',{cwd:dataDir,sharedContext:'SHARED_FACT'});await engine.renameSession('shared-empty','Title');await engine.archiveSession('shared-empty');await engine.restoreSession('shared-empty');assert.deepEqual((await engine.listSessionItems('shared-empty')).data,[]);
  await engine.dispose();engine=createTestEngine(dataDir,'ok',options);await engine.start();await engine.startTurn('shared-empty','first');await engine.interrupt('shared-empty');await waitFor(()=>!engine.activeTurns.size);
  setting='SETTING_B';await engine.startTurn('shared-empty','second');await engine.interrupt('shared-empty');await waitFor(()=>!engine.activeTurns.size);
  const sent=(await readTrace(dataDir)).filter(row=>row.direction==="in").map(row=>row.msg);const starts=sent.filter(row=>row.method==='thread/start');assert.ok(starts.length>=2);assert.match(starts.at(-1).params.developerInstructions,/SHARED_FACT/);assert.match(starts.at(-1).params.developerInstructions,/SETTING_A/);assert.ok(sent.some(row=>row.method==='thread/resume'&&row.params.developerInstructions?.includes('SETTING_B')));
 }finally{await engine.dispose();await removeDir(dataDir);}
});

test('moving an empty casual chat installs destination instructions before its first turn',async()=>{
 const dataDir=await tempDir(),target=await tempDir(),engine=createTestEngine(dataDir,'ok',{resolveSharedInstructions:async cwd=>cwd===target?'DESTINATION_SETTING':'ORIGINAL_SETTING'});
 try{await engine.createSession('moving-empty',{cwd:dataDir});await engine.moveSession('moving-empty',target);const resume=inbound(await readTrace(dataDir),'thread/resume').at(-1).msg.params;assert.equal(resume.cwd,target);assert.match(resume.developerInstructions,/DESTINATION_SETTING/);assert.doesNotMatch(resume.developerInstructions,/ORIGINAL_SETTING/);}
 finally{await engine.dispose();await removeDir(dataDir);await removeDir(target);}
});
