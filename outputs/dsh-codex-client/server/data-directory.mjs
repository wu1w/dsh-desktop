import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

// Resolve the existing ancestor before creating anything. A symlinked parent
// must not turn an apparently independent directory into an original app home.
async function canonicalCandidate(directory) {
  let ancestor = path.resolve(directory);
  const suffix = [];
  for (;;) {
    try { return path.join(await realpath(ancestor), ...suffix); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      suffix.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
}
function contains(parent, target) {
  const relative = path.relative(parent, target);
  return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
}
export async function assertIndependentDataDirectory(directory, {
  protectedRoots = ['.codex', '.dsh', '.claude'].map(name => path.join(homedir(), name)),
} = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
    throw Object.assign(new Error('INVALID_PATH'), { code: 'INVALID_PATH' });
  }
  const candidate = await canonicalCandidate(directory);
  for (const root of protectedRoots) {
    const protectedRoot = await canonicalCandidate(root);
    if (contains(protectedRoot, candidate) || contains(candidate, protectedRoot)) {
      throw Object.assign(new Error('PROTECTED_DATA_DIRECTORY'), { code: 'PROTECTED_DATA_DIRECTORY' });
    }
  }
  return candidate;
}
