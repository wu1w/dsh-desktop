import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, rm, readdir, writeFile, readFile, realpath } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { assertIndependentDataDirectory } from '../server/data-directory.mjs';
import { startHost } from '../server/index.mjs';

test('independent data validation rejects original homes and symlinked missing descendants before any write', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-data-boundary-'));
  try {
    const original = path.join(root, 'original');
    await mkdir(original);
    await writeFile(path.join(original, 'sentinel'), 'preserve');
    await symlink(original, path.join(root, 'alias'));
    const options = { protectedRoots: [original] };
    for (const candidate of [original, root, path.join(original, 'missing', 'child'), path.join(root, 'alias', 'missing', 'child')]) {
      await assert.rejects(assertIndependentDataDirectory(candidate, options), { code: 'PROTECTED_DATA_DIRECTORY' });
    }
    assert.deepEqual(await readdir(original), ['sentinel']);
    assert.equal(await readFile(path.join(original, 'sentinel'), 'utf8'), 'preserve');
    assert.equal(await assertIndependentDataDirectory(path.join(root, 'owned', 'client'), options), path.join(await realpath(root), 'owned', 'client'));
    await assert.rejects(assertIndependentDataDirectory('relative', options), { code: 'INVALID_PATH' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('host rejects original app data locations even with the engine disabled', async () => {
  // Only validation is reached; no directory is created or original state read.
  for (const name of ['.codex', '.dsh', '.claude']) {
    await assert.rejects(startHost({ dataDir: path.join(homedir(), name, '__dsh_independent_probe__'), autoStart: false }), { code: 'PROTECTED_DATA_DIRECTORY' });
  }
});
