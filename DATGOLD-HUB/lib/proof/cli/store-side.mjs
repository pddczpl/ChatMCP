// The baseline side of the check-changes report (lib/proof/tamper.mjs detectCheckChanges) for `chatmcp verify pack`: the rows of the
// baseline's verified manifest, read from the baseline's private store (lib/proof/baseline.mjs) through the pinned Git of
// ../git-plumbing.mjs. The user's repository is not read: the baseline may hold untracked files only the store has.
import fs from 'node:fs/promises';
import path from 'node:path';
import { MODE, blobId, pinnedArgs, pinnedEnv, runGit } from '../git-plumbing.mjs';
import { stop } from './codes.mjs';

/**
 * A side {entries, read(paths, {maxBytes, budget})} as detectCheckChanges reads it. `entries` are the manifest rows [{path, mode, oid}];
 * read() gives each path its bytes, null (not in the baseline, a submodule, or not a blob in the store) or {skipped, size} beyond the
 * limits, and checks that every blob it hands out hashes to its id (Git's cat-file does not): store_object_mismatch otherwise.
 * `scratch` is an empty folder of the caller's for Git's unused index and empty configuration.
 */
export async function storeSide({ git, env = process.env, storeDir, entries, objectFormat, scratch }) {
  await fs.mkdir(path.join(scratch, 'no-hooks'), { recursive: true });
  const emptyConfig = path.join(scratch, 'empty.gitconfig');
  await fs.writeFile(emptyConfig, '', { flag: 'a' });
  const pinned = pinnedEnv(env, { gitDir: storeDir, workTree: scratch, indexFile: path.join(scratch, 'unused.index'), objectDirectory: path.join(storeDir, 'objects'), emptyConfig });
  const none = emptyConfig.replaceAll('\\', '/');
  const prefix = [...pinnedArgs(path.join(scratch, 'no-hooks')), '-c', `core.excludesFile=${none}`, '-c', `core.attributesFile=${none}`];
  const run = (args, options) => runGit(git, [...prefix, ...args], { cwd: scratch, env: pinned, ...options });
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));

  async function read(paths, { maxBytes = Infinity, budget = Infinity } = {}) {
    const result = new Map();
    const rows = [];
    for (const file of paths) {
      const entry = byPath.get(file);
      if (!entry || entry.mode === MODE.gitlink) result.set(file, null);
      else rows.push({ path: file, entry, size: null });
    }
    if (!rows.length) return result;
    const checked = await run(['cat-file', '--batch-check'], { input: `${rows.map((row) => row.entry.oid).join('\n')}\n` });
    const lines = checked.stdout.toString('utf8').split('\n');
    rows.forEach((row, index) => {
      const [oid, type, size] = (lines[index] ?? '').split(' ');
      row.size = oid === row.entry.oid && type === 'blob' && /^\d+$/.test(size ?? '') ? Number(size) : null;
    });
    const wanted = [];
    let used = 0;
    for (const row of rows) {
      if (row.size === null) { result.set(row.path, null); continue; }
      if (row.size > maxBytes) { result.set(row.path, { skipped: 'too_large', size: row.size }); continue; }
      if (used + row.size > budget) { result.set(row.path, { skipped: 'read_budget', size: row.size }); continue; }
      used += row.size;
      wanted.push(row);
    }
    if (!wanted.length) return result;
    const batch = await run(['cat-file', '--batch'], { input: `${wanted.map((row) => row.entry.oid).join('\n')}\n`, maxBytes: used + wanted.length * 160 + 4096 });
    let at = 0;
    for (const row of wanted) {
      const newline = batch.stdout.indexOf(0x0a, at);
      if (newline < 0) { result.set(row.path, null); continue; }
      const [oid, type, size] = batch.stdout.subarray(at, newline).toString('utf8').split(' ');
      at = newline + 1;
      if (oid !== row.entry.oid || type !== 'blob') { result.set(row.path, null); continue; }
      const content = Buffer.from(batch.stdout.subarray(at, at + Number(size)));
      at += Number(size) + 1;
      if (blobId(content, objectFormat) !== row.entry.oid) throw stop('store_object_mismatch', { path: row.path });
      result.set(row.path, content);
    }
    return result;
  }

  return { entries, read };
}
