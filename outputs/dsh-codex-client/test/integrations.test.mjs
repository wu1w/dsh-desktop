import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { IntegrationManager } from "../server/integrations.mjs";

const SECRET = "s3cr3t-mcp-env-value";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dsh-integrations-"));
}

function fakeEngine(codexHome, handlers = {}) {
  const requests = [];
  const engine = {
    ready: true,
    codexHome,
    requests,
    client: {
      async request(method, params) {
        const recorded = structuredClone({ method, params });
        requests.push(recorded);
        if (handlers.request) return handlers.request(method, params, recorded);
        if (method === "mcpServerStatus/list") return { data: handlers.statuses ?? [] };
        if (method === "skills/list") return { data: handlers.skills ?? [] };
        if (method === "skills/config/write") return { effectiveEnabled: params.enabled };
        if (method === "mcpServer/oauth/login") {
          return { authorizationUrl: "https://example.com/oauth/callback", loginId: "login-1" };
        }
        return {};
      },
    },
  };
  return engine;
}

function manager(dir, engine, cwds) {
  let current = engine;
  const created = new IntegrationManager({
    dataDir: dir.dataDir,
    getEngine: () => current,
    getCwds: () => cwds,
  });
  created.useEngine = (next) => {
    current = next;
  };
  created.engine = () => current;
  return created;
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    return true;
  });
}

test("stdio save writes owned config, reloads, and list redacts env values", async () => {
  const root = tempDir();
  const codexHome = path.join(root, "codex-home");
  const dataDir = path.join(root, "data");
  const project = path.join(root, "project");
  fs.mkdirSync(project, { recursive: true });
  const engine = fakeEngine(codexHome, {
    statuses: [
      { name: "docs", runtimeStatus: "connected", authStatus: "bearerToken" },
      { name: "foreign", runtimeStatus: "connected", authStatus: "oAuth", tools: { leak: SECRET } },
    ],
  });
  const mgr = manager({ dataDir }, engine, [project]);
  try {
    const saved = await mgr.saveMcpServer({
      name: "docs",
      command: "server-bin",
      args: ["--flag", "one"],
      env: { TOKEN: SECRET, OTHER: "visible-key-only" },
      enabled: true,
    });
    assert.equal(JSON.stringify(saved).includes(SECRET), false);
    assert.deepEqual(saved.envKeys, ["OTHER", "TOKEN"]);
    assert.equal(saved.envConfigured, true);
    assert.deepEqual(saved.headerKeys, []);
    assert.equal(saved.headersConfigured, false);
    assert.equal(Object.hasOwn(saved, "env"), false);

    assert.deepEqual(engine.requests[0], {
      method: "config/value/write",
      params: {
        keyPath: "mcp_servers.docs",
        mergeStrategy: "replace",
        filePath: path.join(codexHome, "config.toml"),
        value: {
          enabled: true,
          command: "server-bin",
          args: ["--flag", "one"],
          env: { OTHER: "visible-key-only", TOKEN: SECRET },
        },
      },
    });
    assert.deepEqual(engine.requests[1], { method: "config/mcpServer/reload", params: {} });

    const listed = await mgr.listMcpServers();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].name, "docs");
    assert.equal(listed[0].status, "connected");
    assert.equal(listed[0].authStatus, "bearerToken");
    assert.equal(JSON.stringify(listed).includes(SECRET), false);
    assert.equal(JSON.stringify(listed).includes("foreign"), false);
    assert.deepEqual(engine.requests.at(-1).params, { detail: "toolsAndAuthOnly" });
    assert.equal(fs.statSync(dataDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(dataDir, "integrations.json")).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("env edits preserve, clear, and reject masked bullets without leaking errors", async () => {
  const root = tempDir();
  const dataDir = path.join(root, "data");
  const engine = fakeEngine(path.join(root, "codex-home"));
  const mgr = manager({ dataDir }, engine, []);
  const statePath = path.join(dataDir, "integrations.json");
  try {
    await mgr.saveMcpServer({
      name: "docs",
      command: "server-bin",
      args: [],
      env: { TOKEN: SECRET },
      enabled: true,
    });
    await mgr.saveMcpServer({ name: "docs", command: "server-bin", args: [], enabled: false });
    let listed = await mgr.listMcpServers();
    assert.deepEqual(listed[0].envKeys, ["TOKEN"]);
    assert.equal(listed[0].enabled, false);
    assert.equal(JSON.stringify(listed).includes(SECRET), false);

    await mgr.saveMcpServer({ name: "docs", command: "server-bin", args: [], env: {}, enabled: true });
    const cleared = engine.requests.filter((call) => call.method === "config/value/write").at(-1);
    assert.equal(Object.hasOwn(cleared.params.value, "env"), false);
    assert.equal(JSON.stringify(cleared.params).includes(SECRET), false);
    listed = await mgr.listMcpServers();
    assert.deepEqual(listed[0].envKeys, []);
    assert.equal(listed[0].envConfigured, false);

    await mgr.saveMcpServer({ name: "docs", command: "server-bin", args: [], env: { TOKEN: SECRET }, enabled: true });
    await rejectsCode(
      mgr.saveMcpServer({ name: "docs", command: "server-bin", args: [], env: { TOKEN: "••••••••" }, enabled: true }),
      "INVALID_MCP_CONFIG",
    );
    const raw = fs.readFileSync(statePath, "utf8");
    assert.equal(raw.includes("••••"), false);
    assert.equal(raw.includes(SECRET), true);
    listed = await mgr.listMcpServers();
    assert.equal(JSON.stringify(listed).includes(SECRET), false);
    assert.deepEqual(listed[0].envKeys, ["TOKEN"]);

    engine.client.request = async (method, params) => {
      engine.requests.push(structuredClone({ method, params }));
      if (method === "config/value/write") throw new Error(`write failed ${SECRET}`);
      return { data: [] };
    };
    await rejectsCode(
      mgr.saveMcpServer({ name: "docs", command: "server-bin", args: ["x"], enabled: true }),
      "MCP_APPLY_FAILED",
    );
    listed = await mgr.listMcpServers();
    assert.equal(listed[0].error, "MCP_APPLY_FAILED");
    assert.equal(JSON.stringify(listed).includes(SECRET), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("corrupt state is preserved and failed writes keep the previous file", async () => {
  const root = tempDir();
  const dataDir = path.join(root, "data");
  const engine = fakeEngine(path.join(root, "codex-home"));
  const mgr = manager({ dataDir }, engine, []);
  const statePath = path.join(dataDir, "integrations.json");
  try {
    await mgr.saveMcpServer({ name: "docs", command: "server-bin", args: [], env: { TOKEN: SECRET }, enabled: true });
    const corrupt = "{not-json";
    fs.writeFileSync(statePath, corrupt);
    await rejectsCode(mgr.load(), "STATE_CORRUPT");
    assert.equal(fs.readFileSync(statePath, "utf8"), corrupt);
    const listed = await mgr.listMcpServers();
    assert.equal(listed[0].name, "docs");
    assert.equal(listed[0].envConfigured, true);
    assert.equal(JSON.stringify(listed).includes(SECRET), false);

    const blocker = path.join(root, "not-a-directory");
    fs.writeFileSync(blocker, "x");
    mgr.dataDir = path.join(blocker, "child");
    await rejectsCode(
      mgr.saveMcpServer({ name: "other", command: "other-bin", args: [], enabled: true }),
      "STATE_WRITE_FAILED",
    );
    assert.equal(fs.readFileSync(statePath, "utf8"), corrupt);
    assert.equal((await mgr.listMcpServers()).some((server) => server.name === "other"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("restart apply targets the new engine and unavailable status is explicit", async () => {
  const root = tempDir();
  const codexHome = path.join(root, "codex-home");
  const dataDir = path.join(root, "data");
  const first = fakeEngine(codexHome, {
    statuses: [{ name: "docs", runtimeStatus: "connected", authStatus: "unsupported" }],
  });
  const second = fakeEngine(codexHome, {
    statuses: [
      { name: "docs", runtimeStatus: null, authStatus: "unknown" },
      { name: "foreign", runtimeStatus: "connected", authStatus: "oAuth" },
    ],
  });
  const mgr = manager({ dataDir }, first, []);
  try {
    await mgr.saveMcpServer({
      name: "docs",
      command: "server-bin",
      args: ["--a"],
      env: { TOKEN: SECRET },
      enabled: true,
    });
    assert.equal((await mgr.listMcpServers())[0].status, "connected");
    const firstWrites = first.requests.filter((call) => call.method === "config/value/write").length;

    mgr.useEngine(second);
    const swapped = await mgr.listMcpServers();
    assert.equal(swapped.length, 1);
    assert.equal(swapped[0].status, "unavailable");
    assert.equal(JSON.stringify(swapped).includes("foreign"), false);
    assert.notEqual(swapped[0].status, "connected");

    await mgr.apply();
    const write = second.requests.find((call) => call.method === "config/value/write");
    assert.equal(write.params.keyPath, "mcp_servers.docs");
    assert.equal(write.params.mergeStrategy, "replace");
    assert.equal(write.params.filePath, path.join(codexHome, "config.toml"));
    assert.equal(write.params.value.command, "server-bin");
    assert.deepEqual(write.params.value.args, ["--a"]);
    assert.equal(write.params.value.enabled, true);
    assert.equal(typeof write.params.value.env.TOKEN, "string");
    assert.equal(MASKED(write.params.value.env.TOKEN), false);
    assert.ok(second.requests.some((call) => call.method === "config/mcpServer/reload" && Object.keys(call.params).length === 0));
    assert.equal(first.requests.filter((call) => call.method === "config/value/write").length, firstWrites);

    first.ready = false;
    mgr.useEngine(first);
    const before = first.requests.length;
    const offline = await mgr.listMcpServers();
    assert.equal(first.requests.length, before);
    assert.equal(offline[0].status, "unavailable");
    assert.equal(offline[0].error, "ENGINE_DISABLED");

    let active = first;
    first.ready = true;
    first.client.request = async (method, params) => {
      first.requests.push(structuredClone({ method, params }));
      if (method === "config/value/write") {
        active = second;
        mgr.useEngine(second);
      }
      return { data: [] };
    };
    mgr.useEngine(first);
    const secondBefore = second.requests.length;
    await rejectsCode(mgr.apply(), "STALE_ENGINE");
    assert.equal(second.requests.length, secondBefore);
    assert.equal(active, second);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function MASKED(value) {
  return /^[*•●·∙\u2022\u25CF\u00B7]+$/u.test(value);
}

test("removal deletes only the owned key and falls back when null is rejected", async () => {
  const root = tempDir();
  const codexHome = path.join(root, "codex-home");
  const dataDir = path.join(root, "data");
  const engine = fakeEngine(codexHome);
  const mgr = manager({ dataDir }, engine, []);
  try {
    await mgr.saveMcpServer({ name: "docs", command: "server-bin", args: [], env: { TOKEN: SECRET }, enabled: true });
    const before = engine.requests.length;
    await rejectsCode(mgr.removeMcpServer("foreign"), "MCP_SERVER_UNKNOWN");
    await rejectsCode(mgr.removeMcpServer("bad.name"), "MCP_SERVER_UNKNOWN");
    assert.equal(engine.requests.length, before);

    const removed = await mgr.removeMcpServer("docs");
    assert.deepEqual(removed, { name: "docs", removed: true, configCleanup: "deleted" });
    const deletion = engine.requests.filter((call) => call.method === "config/value/write").at(-1);
    assert.deepEqual(deletion.params, {
      keyPath: "mcp_servers.docs",
      value: null,
      mergeStrategy: "replace",
      filePath: path.join(codexHome, "config.toml"),
    });
    assert.equal(engine.requests.at(-1).method, "config/mcpServer/reload");
    assert.equal((await mgr.listMcpServers()).length, 0);

    await mgr.saveMcpServer({ name: "docs", command: "server-bin", args: ["--a"], env: { TOKEN: SECRET }, enabled: true });
    engine.client.request = async (method, params) => {
      if (method === "config/value/write" && params.value === null) throw new Error(`null rejected ${SECRET}`);
      engine.requests.push(structuredClone({ method, params }));
      return { data: [] };
    };
    const fallback = await mgr.removeMcpServer("docs");
    assert.equal(fallback.configCleanup, "disabled");
    const disabled = engine.requests.filter((call) => call.method === "config/value/write").at(-1);
    assert.equal(disabled.params.value.enabled, false);
    assert.equal(disabled.params.value.command, "server-bin");
    assert.equal(disabled.params.keyPath, "mcp_servers.docs");
    assert.equal(disabled.params.mergeStrategy, "replace");
    assert.equal(JSON.stringify(fallback).includes(SECRET), false);
    const listed = await mgr.listMcpServers();
    assert.equal(listed.length, 0);
    assert.equal(fs.readFileSync(path.join(dataDir, "integrations.json"), "utf8").includes("docs"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("invalid MCP config is refused and login only forwards the auth URL", async () => {
  const root = tempDir();
  const dataDir = path.join(root, "data");
  const engine = fakeEngine(path.join(root, "codex-home"));
  const mgr = manager({ dataDir }, engine, []);
  try {
    await rejectsCode(
      mgr.saveMcpServer({ name: "both", command: "bin", url: "https://mcp.example.com/rpc", enabled: true }),
      "INVALID_MCP_CONFIG",
    );
    await rejectsCode(
      mgr.saveMcpServer({ name: "query", url: "https://mcp.example.com/rpc?access_token=query-token-value", enabled: true }),
      "INVALID_MCP_CONFIG",
    );
    await rejectsCode(mgr.saveMcpServer({ name: "bad name", command: "bin", args: [], enabled: true }), "INVALID_MCP_CONFIG");
    await rejectsCode(mgr.saveMcpServer({ name: "nums", command: "bin", args: [1], enabled: true }), "INVALID_MCP_CONFIG");
    assert.equal(engine.requests.length, 0);
    assert.equal(fs.existsSync(path.join(dataDir, "integrations.json")), false);

    await mgr.saveMcpServer({ name: "remote", url: "https://mcp.example.com/rpc", enabled: true });
    const write = engine.requests.find((call) => call.method === "config/value/write");
    assert.deepEqual(write.params.value, { enabled: true, url: "https://mcp.example.com/rpc" });
    const login = await mgr.loginMcpServer("remote");
    assert.deepEqual(login, { authorizationUrl: "https://example.com/oauth/callback", loginId: "login-1" });
    assert.deepEqual(engine.requests.at(-1), { method: "mcpServer/oauth/login", params: { name: "remote" } });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("skills list, enable, extra roots, and unknown paths use the native methods", async () => {
  const root = tempDir();
  const project = path.join(root, "project");
  const skillRoot = path.join(root, "extra-skills");
  const skillPath = path.join(project, "alpha", "SKILL.md");
  fs.mkdirSync(path.join(project, "alpha"), { recursive: true });
  fs.mkdirSync(skillRoot, { recursive: true });
  const dataDir = path.join(root, "data");
  const engine = fakeEngine(path.join(root, "codex-home"), {
    skills: [
      {
        cwd: project,
        skills: [{ name: "alpha", description: "Alpha skill", path: skillPath, enabled: true }],
        errors: [{ path: path.join(project, "broken"), message: "unreadable" }],
      },
      {
        cwd: path.join(root, "somewhere-else"),
        skills: [{ name: "foreign", description: "nope", path: path.join(root, "foreign", "SKILL.md"), enabled: true }],
        errors: [],
      },
    ],
  });
  const mgr = manager({ dataDir }, engine, [project, "relative/nope"]);
  try {
    const listed = await mgr.listSkills();
    assert.deepEqual(engine.requests.at(-1).params, { cwds: [project], forceReload: true });
    assert.deepEqual(listed.skills, [
      { name: "alpha", description: "Alpha skill", path: skillPath, enabled: true, cwd: project },
    ]);
    assert.deepEqual(listed.errors, [{ path: path.join(project, "broken"), cwd: project, code: "SKILL_LIST_ERROR" }]);

    const writesBefore = engine.requests.filter((call) => call.method === "skills/config/write").length;
    await rejectsCode(mgr.setSkillEnabled(path.join(root, "not-listed", "SKILL.md"), false), "SKILL_PATH_UNKNOWN");
    assert.equal(engine.requests.filter((call) => call.method === "skills/config/write").length, writesBefore);

    const updated = await mgr.setSkillEnabled(skillPath, false);
    assert.deepEqual(updated, { path: skillPath, enabled: false });
    assert.deepEqual(engine.requests.filter((call) => call.method === "skills/config/write").at(-1).params, {
      path: skillPath,
      enabled: false,
    });

    const added = await mgr.addSkillRoot(skillRoot);
    assert.deepEqual(added.roots, [skillRoot]);
    assert.deepEqual(engine.requests.filter((call) => call.method === "skills/extraRoots/set").at(-1).params, {
      extraRoots: [skillRoot],
    });
    assert.equal(engine.requests.filter((call) => call.method === "skills/list").at(-1).params.forceReload, true);
    await rejectsCode(mgr.addSkillRoot("skills"), "INVALID_SKILL_ROOT");
    await rejectsCode(mgr.addSkillRoot(path.join(skillRoot, "missing")), "INVALID_SKILL_ROOT");
    await rejectsCode(mgr.setSkillEnabled(path.join(root, "foreign", "SKILL.md"), true), "SKILL_PATH_UNKNOWN");

    const emptyEngine = fakeEngine(path.join(root, "codex-home"), { skills: [] });
    const empty = manager({ dataDir: path.join(root, "empty-data") }, emptyEngine, []);
    assert.deepEqual(await empty.listSkills(), { skills: [], errors: [] });
    assert.equal(emptyEngine.requests.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
