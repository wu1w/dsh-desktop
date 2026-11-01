import { copyFile, chmod, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import Credentials from '@deepseek-ai/dsh-credentials-local';

export async function resolveGoKey() {
  if (process.env.DSH_OPENCODE_GO_KEY) return process.env.DSH_OPENCODE_GO_KEY;
  const original = path.join(homedir(), '.dsh', '.credentials.yaml');
  const before = await stat(original);
  // Windows 的 stat().mode 恒为 0o100666，这个 POSIX 权限检查会必然失败，
  // 导致密钥永远取不到。NTFS ACL 才是 Windows 上的等价物，这里跳过。
  if (process.platform !== 'win32' && (before.mode & 0o077) !== 0) throw new Error('CREDENTIAL_PERMISSIONS');
  const temporary = await mkdtemp(path.join(tmpdir(), 'dsh-codex-credential-'));
  const ctx = new Context();
  try {
    await chmod(temporary, 0o700);
    const copied = path.join(temporary, 'credentials.yaml');
    await copyFile(original, copied); await chmod(copied, 0o600);
    await ctx.plugin(Credentials, { path: copied, watch: false });
    // OpenCode Go 的额度只认 OPENCODE_GO_API_KEY；DEEPSEEK_API_KEY 打这个端点会 401。
    const hit = (await ctx.credentials.resolve('OPENCODE_GO_API_KEY')) ?? (await ctx.credentials.resolve('DEEPSEEK_API_KEY'));
    if (!hit?.value) throw new Error('MISSING_GO_CREDENTIAL');
    return hit.value;
  } finally {
    try { await ctx.fiber.dispose(); }
    finally { await rm(temporary, { recursive: true, force: true }); }
    const after = await stat(original);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.mode !== after.mode) throw new Error('CREDENTIAL_STORE_CHANGED');
  }
}
