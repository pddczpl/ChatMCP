// Content-addressed, private, read-only staging for a broker-selected file set.
// A Git worktree is NOT an operating-system sandbox. Never stage arbitrary
// model-supplied absolute paths, secrets, Git metadata or executable hooks.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { constants } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { fault } from './execution-contract.mjs';
import { isProtectedPath } from './protected-paths.mjs';

const EXCLUDED_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '.next', 'dist', 'build', 'coverage', '.vs', '.idea', '.cache', '__pycache__']);
const RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;
const SHA = (bytes) => createHash('sha256').update(bytes).digest('hex');
const inside = (root, child) => {
  const rel = path.relative(root, child);
  return !!rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
};
export function validateSnapshotPath(value) {
  if (typeof value !== 'string' || !value || value.length > 1024 || value.includes('\0') ||
      path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || value.includes(':') ||
      value.includes('\\') || value.startsWith('//')) throw fault('unsafe_snapshot_path', 'Snapshot path must be a short relative POSIX path.');
  const parts = value.split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) || RESERVED.test(p)) ||
      parts.some(p => EXCLUDED_DIRS.has(p.toLowerCase())) || isProtectedPath(value)) {
    throw fault('unsafe_snapshot_path', 'Snapshot path contains private, special or unsafe components.');
  }
  return parts.join('/');
}
const checkStat = (s, type) => {
  if (s.isSymbolicLink() || (type === 'file' && (!s.isFile() || s.nlink !== 1)) ||
      (type === 'dir' && !s.isDirectory())) {
    throw fault('unsafe_snapshot_entry', 'Snapshot contains a linked or special filesystem entry.');
  }
};
async function verifyParents(root, relative) {
  let cursor = root;
  const parts = relative.split('/');
  for (const part of parts.slice(0, -1)) {
    cursor = path.join(cursor, part);
    checkStat(await fs.lstat(cursor), 'dir');
    if (!inside(root, await fs.realpath(cursor))) throw fault('snapshot_escape', 'Snapshot ancestor resolved outside root.');
  }
}
async function readRegular(root, relative, maxFileBytes) {
  await verifyParents(root, relative);
  const absolute = path.resolve(root, ...relative.split('/'));
  if (!inside(root, absolute)) throw fault('snapshot_escape', 'File path escaped workspace.');
  const before = await fs.lstat(absolute);
  checkStat(before, 'file');
  if (before.size > maxFileBytes) throw fault('snapshot_too_large', 'File exceeds snapshot byte limit.');
  const real = await fs.realpath(absolute);
  if (!inside(root, real)) throw fault('snapshot_escape', 'File resolved outside workspace.');
  const nofollow = process.platform === 'win32' ? 0 : (constants.O_NOFOLLOW || 0);
  const handle = await fs.open(absolute, constants.O_RDONLY | nofollow);
  try {
    const opened = await handle.stat();
    checkStat(opened, 'file');
    if (opened.size > maxFileBytes || opened.ino !== before.ino || opened.dev !== before.dev ||
        opened.size !== before.size || opened.mtimeMs !== before.mtimeMs) throw fault('snapshot_race', 'Source file changed during opening.');
    const content = await handle.readFile();
    const after = await handle.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || content.length !== before.size) {
      throw fault('snapshot_race', 'Source file changed while being snapshotted.');
    }
    return content;
  } finally { await handle.close(); }
}
export async function createExecutionSnapshot({
  workspace, files, baseSha = null, outputRoot = null, signal = null,
  maxFiles = 256, maxFileBytes = 8 * 1024 * 1024, maxTotalBytes = 48 * 1024 * 1024,
} = {}) {
  const workspacePath = typeof workspace === 'string' ? workspace : workspace?.root;
  if (!workspacePath || !Array.isArray(files) || !files.length || files.length > maxFiles ||
      !files.every(f => typeof f === 'string')) throw fault('invalid_snapshot', 'Trusted broker must supply a nonempty bounded regular-file list.');
  if (baseSha !== null && !/^[0-9a-f]{40}$/i.test(baseSha)) throw fault('invalid_snapshot', 'baseSha must be a complete Git SHA.');
  const workspaceRoot = await fs.realpath(path.resolve(workspacePath));
  const names = files.map(validateSnapshotPath).sort();
  if (new Set(names.map(x => process.platform === 'win32' ? x.toLowerCase() : x)).size !== names.length) {
    throw fault('snapshot_duplicate', 'Duplicate or case-aliased snapshot path.');
  }
  const privateRoot = path.resolve(outputRoot || path.join(os.tmpdir(), 'chatmcp-execution-snapshots'));
  if (privateRoot === workspaceRoot || inside(workspaceRoot, privateRoot) || inside(privateRoot, workspaceRoot)) {
    throw fault('unsafe_snapshot_root', 'Snapshot staging must not overlap workspace.');
  }
  await fs.mkdir(privateRoot, { recursive: true, mode: 0o700 });
  const directory = await fs.mkdtemp(path.join(privateRoot, 'snapshot-'));
  const manifestFiles = [];
  let total = 0;
  try {
    for (const name of names) {
      signal?.throwIfAborted();
      const bytes = await readRegular(workspaceRoot, name, maxFileBytes);
      total += bytes.length;
      if (total > maxTotalBytes) throw fault('snapshot_too_large', 'Snapshot exceeds total byte limit.');
      const destination = path.join(directory, ...name.split('/'));
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await fs.writeFile(destination, bytes, { flag: 'wx', mode: 0o400 });
      manifestFiles.push({ path: name, size: bytes.length, sha256: SHA(bytes) });
    }
    const contentHash = SHA(JSON.stringify({ baseSha, files: manifestFiles }));
    const manifest = Object.freeze({ schema: 1, baseSha, files: Object.freeze(manifestFiles.map(x => Object.freeze(x))), contentHash });
    await fs.writeFile(path.join(directory, '.snapshot.json'), JSON.stringify(manifest), { flag: 'wx', mode: 0o400 });
    const snapshot = Object.freeze({ snapshotId: randomUUID(), manifest, contentHash, directory });
    await verifyExecutionSnapshot(snapshot);
    return snapshot;
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
export async function verifyExecutionSnapshot(snapshot) {
  if (!snapshot || !snapshot.manifest || !snapshot.directory) throw fault('invalid_snapshot', 'Missing immutable snapshot manifest.');
  const manifest = snapshot.manifest;
  const hash = SHA(JSON.stringify({ baseSha: manifest.baseSha, files: manifest.files }));
  if (hash !== manifest.contentHash || hash !== snapshot.contentHash) throw fault('snapshot_corrupt', 'Snapshot content manifest has changed.');
  const diskManifest = JSON.parse(await fs.readFile(path.join(snapshot.directory, '.snapshot.json'), 'utf8'));
  if (JSON.stringify(diskManifest) !== JSON.stringify(manifest)) throw fault('snapshot_corrupt', 'Snapshot manifest altered on disk.');
  for (const item of manifest.files) {
    const name = validateSnapshotPath(item.path);
    const data = await readRegular(snapshot.directory, name, 8 * 1024 * 1024);
    if (data.length !== item.size || SHA(data) !== item.sha256) throw fault('snapshot_stale', 'Staged snapshot file changed: ' + name);
  }
  return true;
}
