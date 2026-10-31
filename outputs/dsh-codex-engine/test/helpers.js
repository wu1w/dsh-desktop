import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexEngine } from "../lib/engine.js";

export const fakeScript = fileURLToPath(new URL("./fixtures/fake-app-server.js", import.meta.url));
export const SECRET = "test-key-value-do-not-log";

export async function tempDir() {
  return mkdtemp(path.join(tmpdir(), "dsh-codex-engine-"));
}

export async function removeDir(directory) {
  await rm(directory, { recursive: true, force: true });
}

export function engineOptions(dataDir, scenario = "ok", extra = {}) {
  return {
    dataDir,
    binary: process.execPath,
    args: [fakeScript],
    resolveApiKey: () => SECRET,
    requestTimeoutMs: 2000,
    maxLineBytes: extra.maxLineBytes ?? 1024 * 1024,
    extraEnv: {
      FAKE_SCENARIO: scenario,
      FAKE_TRACE_PATH: path.join(dataDir, "trace.jsonl"),
      FAKE_PROBE_PATH: path.join(dataDir, "probe.json"),
      ...(extra.extraEnv ?? {}),
    },
    ...strip(extra, ["extraEnv", "maxLineBytes"]),
  };
}

function strip(source, keys) {
  const copy = { ...source };
  for (const key of keys) delete copy[key];
  return copy;
}

export function createTestEngine(dataDir, scenario = "ok", extra = {}) {
  return new CodexEngine(engineOptions(dataDir, scenario, extra));
}

export async function readTrace(dataDir) {
  try {
    const text = await readFile(path.join(dataDir, "trace.jsonl"), "utf8");
    return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

export async function readProbe(dataDir) {
  return JSON.parse(await readFile(path.join(dataDir, "probe.json"), "utf8"));
}

export function inbound(trace, method) {
  return trace.filter((entry) => entry.direction === "in" && entry.msg?.method === method);
}

export async function waitFor(predicate, timeoutMs = 1000) {
  const started = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error("WAIT_TIMEOUT");
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}
