import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

const { default: apply } = await import("../lib/plugin.js");
const { Context } = await import("@deepseek-ai/cordis");
const { engineOptions, removeDir, tempDir } = await import("./helpers.js");

test("plugin registers codexEngine and unload stops only its child", async () => {
  const dataDir = await tempDir();
  const ctx = new Context();
  try {
    await apply(ctx, engineOptions(dataDir));
    const service = ctx.codexEngine;
    assert.equal(typeof service.createSession, "function");
    await service.start();
    const pid = service.engine.client.child.pid;
    assert.equal(typeof pid, "number");
    service.engine.on("turn-completed", () => {});
    assert.ok(service.engine.listenerCount("turn-completed") >= 1);
    await ctx.fiber.dispose();
    assert.equal(ctx.codexEngine, undefined);
    assert.equal(service.engine.disposed, true);
    assert.equal(service.engine.listenerCount("turn-completed"), 0);
    assert.equal(service.engine.client.handlers.size, 0);
    await waitUntil(() => !alive(pid));
    assert.equal(alive(pid), false);
    assert.equal(path.basename(service.engine.codexHome), "codex");
  } finally {
    await removeDir(dataDir);
  }
});

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(predicate) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 1500) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
