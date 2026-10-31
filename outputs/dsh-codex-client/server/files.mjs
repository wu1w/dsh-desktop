import { realpath, stat, readdir, open, writeFile, rename, mkdir, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

const projectWrites = new Map();
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
function fileError(code) { return Object.assign(new Error(code), { code }); }
function validText(content) {
  for (let index = 0; index < content.length; index++) {
    const unit = content.charCodeAt(index);
    if (unit === 0 || (unit >= 0xdc00 && unit <= 0xdfff)) return false;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = content.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    }
  }
  return true;
}
async function serializeProjectWrite(target, action) {
  const previous = projectWrites.get(target) ?? Promise.resolve();
  let release;
  const held = new Promise(resolve => { release = resolve; });
  projectWrites.set(target, held);
  await previous;
  try { return await action(); }
  finally {
    release();
    if (projectWrites.get(target) === held) projectWrites.delete(target);
  }
}

export function inside(root, target) { const relative = path.relative(root, target); return !relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)); }
export async function projectFile(root, relative, { create = false } = {}) {
  if (typeof relative !== 'string' || relative.includes('\0') || path.isAbsolute(relative)) throw new Error('INVALID_PATH');
  const canonicalRoot = await realpath(root);
  const candidate = path.resolve(canonicalRoot, relative);
  if (!inside(canonicalRoot, candidate)) throw new Error('OUTSIDE_PROJECT');
  let canonical;
  try { canonical = await realpath(candidate); }
  catch (error) {
    if (error.code !== 'ENOENT' || !create) throw error;
    canonical = path.join(await realpath(path.dirname(candidate)), path.basename(candidate));
  }
  if (!inside(canonicalRoot, canonical)) throw new Error('OUTSIDE_PROJECT');
  return canonical;
}
export function version(content) { return createHash('sha256').update(content).digest('hex'); }
export async function readProjectFileInfo(root, relative) {
  const target = await projectFile(root, relative);
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw fileError('FILE_LIMIT');
    const same = (first, second) => first.dev === second.dev && first.ino === second.ino && first.size === second.size && first.mtimeMs === second.mtimeMs && first.ctimeMs === second.ctimeMs;
    try {
      const current = await stat(target), latest = await handle.stat();
      if (!same(metadata, latest) || !same(latest, current) || await projectFile(root, relative) !== target) throw fileError('FILE_CHANGED');
      return { path: relative, name: path.basename(target), size: latest.size, modifiedAt: latest.mtime.toISOString() };
    } catch (error) {
      if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) throw fileError('FILE_CHANGED');
      throw error;
    }
  } finally { await handle.close(); }
}
export async function readProjectFile(root, relative) {
  const target = await projectFile(root, relative);
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes;
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > MAX_TEXT_BYTES) throw fileError('FILE_LIMIT');
    const chunks = [];
    let length = 0;
    // Limit the reads themselves: a file that grows after fstat cannot make
    // readFile allocate arbitrary memory or bypass the editor's byte limit.
    while (length <= MAX_TEXT_BYTES) {
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, MAX_TEXT_BYTES + 1 - length));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      length += bytesRead;
      if (length > MAX_TEXT_BYTES) throw fileError('FILE_LIMIT');
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const latest = await handle.stat();
    if (latest.size > MAX_TEXT_BYTES) throw fileError('FILE_LIMIT');
    const current = await stat(target);
    if (metadata.size !== latest.size || metadata.mtimeMs !== latest.mtimeMs || metadata.ctimeMs !== latest.ctimeMs ||
        latest.dev !== current.dev || latest.ino !== current.ino || await projectFile(root, relative) !== target) throw fileError('FILE_CHANGED');
    bytes = Buffer.concat(chunks, length);
  } finally { await handle.close(); }
  if (bytes.includes(0)) throw new Error('BINARY_FILE');
  let content;
  // ignoreBOM preserves U+FEFF in the editor's content. Removing it here would
  // silently strip the original UTF-8 BOM on a read/save round trip.
  try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw fileError('FILE_ENCODING'); }
  return { path: relative, name: path.basename(target), content, version: version(bytes) };
}
export async function writeProjectFile(root, relative, content, expectedVersion) {
  if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_TEXT_BYTES) throw new Error('FILE_LIMIT');
  if (!validText(content)) throw fileError('FILE_INVALID_TEXT');
  const bytes = Buffer.from(content, 'utf8');
  const target = await projectFile(root, relative);
  return serializeProjectWrite(target, async () => {
    const previous = await readProjectFile(root, relative);
    if (expectedVersion !== previous.version || await projectFile(root, relative) !== target) throw new Error('FILE_CHANGED');
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, bytes, { mode: (await stat(target)).mode, flag: 'wx' });
      // Detect edits made while the temporary file was being written. This is
      // an application lock plus a version check, not an OS-wide atomic CAS.
      const latest = await readProjectFile(root, relative);
      if (latest.version !== expectedVersion || await projectFile(root, relative) !== target) throw new Error('FILE_CHANGED');
      await rename(temporary, target);
    } finally { await rm(temporary, { force: true }).catch(() => {}); }
  });
}
export async function listProjectFiles(root, relative = '') {
  const target = await projectFile(root, relative);
  const entries = await readdir(target, { withFileTypes: true });
  const rows = await Promise.all(entries.filter(item => !['.git','node_modules','.dsh-attachments'].includes(item.name)).slice(0, 2000).map(async item => {
    const file = path.join(target, item.name);
    let metadata;
    try { const canonical = await realpath(file); if (!inside(await realpath(root), canonical)) return null; metadata = await stat(canonical); }
    catch { return null; }
    return { name: item.name, path: path.posix.join(relative, item.name), directory: metadata.isDirectory(), size: metadata.size };
  }));
  return rows.filter(Boolean).sort((a,b) => Number(b.directory)-Number(a.directory) || a.name.localeCompare(b.name));
}
export async function saveAttachments(root, files) {
  if (!Array.isArray(files) || files.length > 20) throw new Error('ATTACHMENT_LIMIT');
  const total = files.reduce((sum, file) => sum + Buffer.byteLength(file.data ?? '', 'base64'), 0);
  if (total > 10 * 1024 * 1024) throw new Error('ATTACHMENT_LIMIT');
  const directory = path.join(root, '.dsh-attachments');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await projectFile(root, '.dsh-attachments');
  const saved = [];
  for (const file of files) {
    if (typeof file.name !== 'string' || typeof file.data !== 'string') throw new Error('INVALID_ATTACHMENT');
    const name = path.basename(file.name).replace(/[\0\r\n]/g, '_');
    const relative = path.posix.join('.dsh-attachments', randomUUID() + '-' + name);
    await writeFile(await projectFile(root, relative, { create: true }), Buffer.from(file.data, 'base64'), { mode: 0o600 });
    saved.push({ path: relative, name, mime: typeof file.mime === 'string' ? file.mime : '' });
  }
  return saved;
}
