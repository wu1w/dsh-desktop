import test from "node:test";
import assert from "node:assert/strict";
import { deepSeekProfile, DEEPSEEK_PROFILE_ID, BUILTIN_PROFILE_ID, listDeepSeekProfiles, normalizeDeepSeekReasoningEffort, DEEPSEEK_FLASH_REASONING_EFFORTS } from "../lib/deepseek-profile.js";

test("default keeps the native model instructions and switching back removes the override", () => {
  assert.deepEqual(deepSeekProfile().threadParams, {});
  const candidate = deepSeekProfile({ id: DEEPSEEK_PROFILE_ID });
  assert.match(candidate.threadParams.baseInstructions, /DeepSeek V4\.1 Flash/);
  assert.match(candidate.instructionHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(deepSeekProfile({ id: BUILTIN_PROFILE_ID }).threadParams, {});
});

test("Flash reasoning tiers preserve actual API semantics without fake middle tiers", () => {
  assert.deepEqual(DEEPSEEK_FLASH_REASONING_EFFORTS, ["low", "high", "max"]);
  assert.equal(normalizeDeepSeekReasoningEffort("medium"), "high");
  assert.equal(normalizeDeepSeekReasoningEffort("xhigh"), "high");
  assert.equal(normalizeDeepSeekReasoningEffort("minimal"), "low");
  assert.equal(normalizeDeepSeekReasoningEffort("none"), "none");
  assert.equal(normalizeDeepSeekReasoningEffort("max"), "max");
  assert.throws(() => normalizeDeepSeekReasoningEffort("ultra"), { code: "UNSUPPORTED_DEEPSEEK_EFFORT" });
});

test("model scope cannot leak a Flash-specific identity into another model", () => {
  assert.throws(() => deepSeekProfile({ id: DEEPSEEK_PROFILE_ID, model: "deepseek-other" }), { code: "PROFILE_MODEL_MISMATCH" });
  assert.throws(() => deepSeekProfile({ id: "missing" }), { code: "UNKNOWN_DEEPSEEK_PROFILE" });
  assert.throws(() => deepSeekProfile({ id: DEEPSEEK_PROFILE_ID, engine: "claude-code" }), { code: "PROFILE_ENGINE_MISMATCH" });
  assert.deepEqual(deepSeekProfile({ model: "other" }).threadParams, {});
});

test("profile copies are independent, localized, and cannot grant permissions", () => {
  const first = deepSeekProfile({ id: DEEPSEEK_PROFILE_ID });
  first.threadParams.baseInstructions = "mutated";
  const next = deepSeekProfile({ id: DEEPSEEK_PROFILE_ID, locale: "unknown" });
  assert.match(next.threadParams.baseInstructions, /sandbox boundaries/);
  assert.equal(next.name, listDeepSeekProfiles("en")[1].name);
  assert.notEqual(next.description, listDeepSeekProfiles("zh-CN")[1].description);
  assert.deepEqual(Object.keys(next.threadParams), ["baseInstructions"]);
  assert.equal("approvalPolicy" in next.threadParams, false);
  assert.equal("sandbox" in next.threadParams, false);
  assert.equal("config" in next.threadParams, false);
});
