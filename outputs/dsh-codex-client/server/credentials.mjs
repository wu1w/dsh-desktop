import { copyFile, chmod, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import Credentials from '@deepseek-ai/dsh-credentials-local';

export async function resolveGoKey() {
  if (process.env.DSH_OPENCODE_GO_KEY) return process.env.DSH_OPENCODE_GO_KEY;
  const original = path.join(homedir(), '.dsh', '.credentials.yaml');
  const before = await stat(original);
  if ((before.mode & 0o077) !== 0) throw new Error('CREDENTIAL_PERMISSIONS');
  const temporary = await mkdtemp(path.join(tmpdir(), 'dsh-codex-credential-'));
  const ctx = new Context();
  try {
    await chmod(temporary, 0o700);
    const copied = path.join(temporary, 'credentials.yaml');
    await copyFile(original, copied); await chmod(copied, 0o600);
    await ctx.plugin(Credentials, { path: copied, watch: false });
    const hit = await ctx.credentials.resolve('DEEPSEEK_API_KEY');
    if (!hit?.value) throw new Error('MISSING_GO_CREDENTIAL');
    return hit.value;
  } finally {
    try { await ctx.fiber.dispose(); }
    finally { await rm(temporary, { recursive: true, force: true }); }
    const after = await stat(original);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.mode !== after.mode) throw new Error('CREDENTIAL_STORE_CHANGED');
  }
}
