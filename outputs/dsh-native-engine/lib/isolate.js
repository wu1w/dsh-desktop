import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineError } from "./errors.js";

function canonical(value) {
  if (existsSync(value)) return realpathSync(value);
  const parent = path.dirname(value);
  return parent === value ? value : path.join(canonical(parent), path.basename(value));
}

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function assertIsolatedDataDir(dataDir, t) {
  if (typeof dataDir !== "string" || dataDir.length === 0) {
    throw new EngineError("DATA_DIR_REQUIRED", t("data_dir_required"));
  }
  const resolved = path.resolve(dataDir);
  const homes = [".dsh", ".codex", ".claude"].map((name) => path.resolve(os.homedir(), name));
  const candidates = [resolved, canonical(resolved)];
  for (const home of homes) {
    const parent = canonical(home);
    if (candidates.some((value) => isInside(value, home) || isInside(value, parent))) {
      throw new EngineError("UNSAFE_DATA_DIR", t("unsafe_data_dir"));
    }
  }
  return resolved;
}
