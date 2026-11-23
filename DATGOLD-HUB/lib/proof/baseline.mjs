// The baseline store of Proof-of-Done in observe mode (plan task pod-25, docs/PROOF-BASELINE.md).
//
// snapshotBaseline() takes a full tree snapshot of a workspace (./tree-snapshot.mjs) and keeps what a later diff needs:
//   <hubDir>/proof/baselines/<workspaceKey>/<id>.json  the record: tree ids, a gzip manifest (path -> mode, blob id), the acceptance file,
//                                                      the package.json scripts, HEAD and a dirty summary, the toolchain versions;
//   <hubDir>/proof/baselines/<workspaceKey>/<id>.git/  for a Git workspace only: a private bare store with every blob and tree of the
//                                                      baseline, written as one pack by `git fast-import`. The user's object store is
//                                                      never written or relied on, so commits, branch switches, history rewrites and
//                                                      `git gc --prune=now` of the user's repository leave the baseline whole.
// diffBaseline() takes the final snapshot, lists the changes between the two manifests (added, modified, deleted, with blob ids), and
// for a Git workspace writes the final tree into a temporary store that borrows the baseline's objects (objects/info/alternates), runs
// `git diff --binary` between the two trees and checks that the patch, applied to the baseline tree, gives the final tree id. The
// patch's sha256 is what a proof pack (pod-29) binds to. A plain folder gets the change list and `patch: unavailable`.
//
// The record file ends with its own sha256. The caller keeps that hash elsewhere (the proof ledger) and passes it back as the anchor.
// Neither is a seal: the agent runs as the same user and can delete or rewrite the record, the store and the ledger. The baseline is
// tamper-evident (an edit is detected, a deletion is reported), it is not tamper-proof. Nothing in the agent or the Hub calls this
// module yet (pod-26 and pod-32).
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import { locateGitDirectories } from '../git-trust.mjs';
import { killTree, scrubEnv } from '../shell-runner.mjs';
import { ACCEPTANCE_FILE, ACCEPTANCE_MAX_BYTES } from './acceptance.mjs';
import { MODE, blobId, buildTree, gitlinkCommit, pinnedArgs, pinnedEnv, runGit, splitNul } from './git-plumbing.mjs';
import { LEDGER_FOLDER, ToolchainProbe } from './ledger.mjs';
import { gitTreeSide } from './tamper.mjs';
import { TREE_ALGORITHM, TreeSnapshotter } from './tree-snapshot.mjs';

export const BASELINE_FORMAT = 'chatmcp.proof-baseline/1';
export const BASELINE_DIFF_FORMAT = 'chatmcp.proof-baseline-diff/1';
export const BASELINES_FOLDER = 'baselines';
export const LOCK_FILE = 'lock';
/** The ref of the baseline commit in its private store (a commit only so that the store holds a tree; never in the user's repository). */
export const STORE_REF = 'refs/datgold/baseline';
const FINAL_REF = 'refs/datgold/final';
const DAY_MS = 24 * 60 * 60 * 1000;
/** Kept per workspace: the newest `maxPerWorkspace`, none older than `maxAgeMs`. Pruned on every write (docs/PROOF-BASELINE.md). */
export const RETENTION = Object.freeze({ maxAgeMs: 14 * DAY_MS, maxPerWorkspace: 10 });
/** The workspace lock (docs/PROOF-BASELINE.md, "The lock"). */
export const LOCK_RULES = Object.freeze({ waitMs: 60_000, staleMs: 120_000, heartbeatMs: 15_000, pollMs: 50, breakGraceMs: 10_000 });
export const BASELINE_LIMITS = Object.freeze({
  maxPatchBytes: 128 * 1024 * 1024,
  acceptanceInlineBytes: ACCEPTANCE_MAX_BYTES,
  maxManifestBytes: 256 * 1024 * 1024,
  /** The most a Git command whose output is kept in memory may print (runGit's own default). */
  gitOutputBytes: 256 * 1024 * 1024,
  gitTimeoutMs: 600_000,
});
/** The flags of the patch: nothing of the person's or the repository's configuration is read, renames are not guessed. */
export const DIFF_ARGS = Object.freeze(['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--binary', '--full-index', '--no-renames',
  '--diff-algorithm=myers', '--src-prefix=a/', '--dst-prefix=b/', '--no-relative', '--submodule=short', '--ignore-submodules=none']);

const ID = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z-[0-9a-f]{8}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const OID = Object.freeze({ sha1: /^[0-9a-f]{40}$/, sha256: /^[0-9a-f]{64}$/ });
const MODES = new Set([MODE.file, MODE.executable, MODE.symlink, MODE.gitlink]);
const HASH_SUFFIX = /,"recordSha256":"([0-9a-f]{64})"\}\n$/;
const EMPTY_CONFIG = 'empty.gitconfig';
const NO_HOOKS = 'no-hooks';
const READ_AHEAD = 16;
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

const fault = (code, message) => Object.assign(new Error(message), { code });
const sha256Hex = (data) => createHash('sha256').update(typeof data === 'string' ? Buffer.from(data, 'utf8') : data).digest('hex');
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const since = (mark) => Math.round(performance.now() - mark);

// ---------------------------------------------------------------------------------------------------------------------
// Names and places
// ---------------------------------------------------------------------------------------------------------------------

/** 32 hex digits naming a workspace: sha256 of its resolved path (lower case on Windows, where case does not matter). */
export function workspaceKey(root) {
  if (typeof root !== 'string' || !root) throw fault('baseline_bad_argument', 'a baseline needs the workspace folder');
  const resolved = path.resolve(root);
  return sha256Hex(process.platform === 'win32' ? resolved.toLowerCase() : resolved).slice(0, 32);
}

/** `<hubDir>/proof/baselines/<workspaceKey>`: the folder of one workspace's baselines, next to the proof ledgers. */
export function baselineFolder(hubDir, root) {
  if (typeof hubDir !== 'string' || !hubDir) throw fault('baseline_bad_argument', 'a baseline needs the Hub data folder');
  return path.join(hubDir, LEDGER_FOLDER, BASELINES_FOLDER, workspaceKey(root));
}

/** `20261122T120000123Z-1a2b3c4d`: the time of the baseline in UTC, then 32 random bits. Sorts by time. */
const newId = (date) => `${date.toISOString().replace(/[-:.]/g, '')}-${randomBytes(4).toString('hex')}`;
const idTime = (id) => {
  const [, year, month, day, hour, minute, second, milli] = ID.exec(id).map(Number);
  return Date.UTC(year, month - 1, day, hour, minute, second, milli);
};
function checkId(id) {
  if (typeof id !== 'string' || !ID.test(id)) throw fault('baseline_bad_id', `not a baseline id: ${JSON.stringify(String(id).slice(0, 60))}`);
}

// ---------------------------------------------------------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------------------------------------------------------

/** The rows {path, mode, oid} as gzip + base64 of the JSON text `[[path, mode, oid], ...]` in path order, with that text's sha256. */
export function encodeManifest(entries) {
  const rows = entries.map(({ path: file, mode, oid }) => ({ path: file, mode, oid })).sort(byPath);
  const json = JSON.stringify(rows.map((row) => [row.path, row.mode, row.oid]));
  return { encoding: 'gzip+base64', entries: rows.length, sha256: sha256Hex(json), data: zlib.gzipSync(Buffer.from(json, 'utf8'), { level: 9 }).toString('base64') };
}

const validPath = (file) => !file.startsWith('/') && !file.includes('\0') && file.split('/').every((part) => part && part !== '.' && part !== '..');

/** The rows of a manifest, checked: its sha256, its count, one [path, mode, oid] per row, paths in order and once each. */
export function decodeManifest(manifest, { objectFormat = 'sha1' } = {}) {
  const bad = (why) => fault('baseline_bad_record', `the manifest ${why}`);
  if (!isPlainObject(manifest) || manifest.encoding !== 'gzip+base64' || typeof manifest.data !== 'string') throw bad('is not gzip + base64 data');
  let json;
  try {
    json = zlib.gunzipSync(Buffer.from(manifest.data, 'base64'), { maxOutputLength: BASELINE_LIMITS.maxManifestBytes }).toString('utf8');
  } catch { throw bad('does not decompress'); }
  if (sha256Hex(json) !== manifest.sha256) throw bad('is not the text its sha256 was made of');
  let rows;
  try { rows = JSON.parse(json); } catch { throw bad('is not JSON'); }
  if (!Array.isArray(rows) || rows.length !== manifest.entries) throw bad('does not hold its count of rows');
  const oid = OID[objectFormat] ?? OID.sha1;
  const entries = [];
  let previous = null;
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== 3 || row.some((cell) => typeof cell !== 'string')) throw bad('has a row that is not [path, mode, oid]');
    const [file, mode, id] = row;
    if (!validPath(file)) throw bad(`has a path that is not relative: ${JSON.stringify(file.slice(0, 80))}`);
    if (!MODES.has(mode)) throw bad(`has an unknown mode ${JSON.stringify(mode.slice(0, 10))}`);
    if (!oid.test(id)) throw bad('has an object id that is not hex');
    if (previous !== null && !(previous < file)) throw bad('is not in path order or names a path twice');
    previous = file;
    entries.push({ path: file, mode, oid: id });
  }
  return entries;
}

/** What changed between two lists of rows {path, mode, oid}: added and deleted rows, modified ones with both modes and ids. */
export function manifestChanges(before, after) {
  const was = new Map(before.map((row) => [row.path, row]));
  const now = new Set(after.map((row) => row.path));
  const added = [];
  const modified = [];
  const deleted = [];
  for (const row of after) {
    const old = was.get(row.path);
    if (!old) added.push({ path: row.path, mode: row.mode, oid: row.oid });
    else if (old.oid !== row.oid || old.mode !== row.mode) modified.push({ path: row.path, oldMode: old.mode, newMode: row.mode, oldOid: old.oid, newOid: row.oid });
  }
  for (const row of before) if (!now.has(row.path)) deleted.push({ path: row.path, mode: row.mode, oid: row.oid });
  return { added: added.sort(byPath), modified: modified.sort(byPath), deleted: deleted.sort(byPath) };
}

// ---------------------------------------------------------------------------------------------------------------------
// The lock
// ---------------------------------------------------------------------------------------------------------------------

const ownTokens = new Set(); // tokens of the locks this process holds now: its other callers wait for them like anyone else

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

/** {raw, info, mtimeMs} of a lock file, or null when it is gone. `info` is null when the content is not a lock record (yet). */
async function readLock(file) {
  try {
    const [raw, stat] = await Promise.all([fs.readFile(file, 'utf8'), fs.stat(file)]);
    let info = null;
    try {
      const parsed = JSON.parse(raw);
      if (isPlainObject(parsed) && Number.isSafeInteger(parsed.pid) && parsed.pid > 0 && typeof parsed.host === 'string' && typeof parsed.token === 'string') info = parsed;
    } catch { /* being written, or not a lock */ }
    return { raw, info, mtimeMs: stat.mtimeMs };
  } catch (error) {
    if (['ENOENT', 'EPERM', 'EBUSY'].includes(error?.code)) return null;
    throw error;
  }
}

/** Stale: unreadable and older than breakGraceMs; a heartbeat older than staleMs; this process but not held; a dead process here. */
function isStale(holder, rules) {
  const age = Date.now() - holder.mtimeMs;
  if (!holder.info) return age > rules.breakGraceMs;
  if (age > rules.staleMs) return true;
  if (holder.info.host !== os.hostname()) return false;
  if (holder.info.pid === process.pid) return !ownTokens.has(holder.info.token);
  return !pidAlive(holder.info.pid);
}

/** Removes a stale lock under `<lock>.break`, only if it is still byte for byte the lock that was judged stale. True when removed. */
async function breakStale(file, holder, rules) {
  const breaker = `${file}.break`;
  try {
    await fs.writeFile(breaker, String(process.pid), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (!['EEXIST', 'EPERM', 'EBUSY'].includes(error?.code)) throw error;
    // a breaker that crashed inside its few milliseconds leaves the file behind
    const stat = await fs.stat(breaker).catch(() => null);
    if (stat && Date.now() - stat.mtimeMs > rules.breakGraceMs) await fs.rm(breaker, { force: true }).catch(() => {});
    return false;
  }
  try {
    const current = await readLock(file);
    if (!current || current.raw !== holder.raw || current.mtimeMs !== holder.mtimeMs) return false;
    await fs.rm(file, { force: true });
    return true;
  } finally {
    await fs.rm(breaker, { force: true }).catch(() => {});
  }
}

async function takeFile(file, rules, deadline, purpose) {
  const token = randomUUID();
  const content = JSON.stringify({ pid: process.pid, host: os.hostname(), token, since: new Date().toISOString(), purpose });
  for (;;) {
    let holder = null;
    try {
      await fs.writeFile(file, content, { flag: 'wx', mode: 0o600 });
      ownTokens.add(token);
      return token;
    } catch (error) {
      if (!['EEXIST', 'EPERM', 'EBUSY'].includes(error?.code)) throw error;
      if (error.code === 'EEXIST') holder = await readLock(file);
    }
    if (holder && isStale(holder, rules) && await breakStale(file, holder, rules)) continue;
    const left = deadline - Date.now();
    if (left <= 0) {
      const who = holder?.info ? `process ${holder.info.pid} on ${holder.info.host}, since ${holder.info.since ?? 'an unknown time'}` : 'another process';
      throw fault('baseline_busy', `another snapshot of this workspace is running (${who}); try again later`);
    }
    await delay(Math.min(rules.pollMs, left));
  }
}

async function lockFolder(folder, lock = {}, purpose = 'baseline') {
  const rules = { ...LOCK_RULES, ...lock };
  await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  const file = path.join(folder, LOCK_FILE);
  // One rule in and across processes: the lock file decides (a lock of this process is held while its token is in ownTokens).
  const token = await takeFile(file, rules, Date.now() + rules.waitMs, purpose);
  const heartbeat = setInterval(() => {
    readLock(file).then((current) => (current?.info?.token === token ? fs.utimes(file, new Date(), new Date()) : null)).catch(() => {});
  }, rules.heartbeatMs);
  heartbeat.unref();
  let released = false;
  return {
    file,
    token,
    async release() {
      if (released) return;
      released = true;
      clearInterval(heartbeat);
      ownTokens.delete(token);
      const current = await readLock(file).catch(() => null);
      if (current?.info?.token === token) await fs.rm(file, { force: true });
    },
  };
}

/**
 * The lock of one workspace's baselines: `<folder>/lock`, created exclusively, holding {pid, host, token, since, purpose}; its time is
 * refreshed every heartbeatMs. Waits up to waitMs (polling every pollMs), then throws `baseline_busy`. Resolves with {file, token, release()}.
 */
export async function acquireWorkspaceLock({ hubDir, root, lock = {}, purpose = 'baseline' } = {}) {
  return lockFolder(baselineFolder(hubDir, root), lock, purpose);
}

// ---------------------------------------------------------------------------------------------------------------------
// The private store
// ---------------------------------------------------------------------------------------------------------------------

/** A bare repository written by hand (no `git init`, so no template and no hook): HEAD on a branch that never exists. */
export async function initStore(gitDir, { objectFormat = 'sha1', alternates = [] } = {}) {
  for (const folder of ['objects/info', 'objects/pack', 'refs/heads', 'refs/tags', NO_HOOKS]) await fs.mkdir(path.join(gitDir, folder), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(gitDir, 'HEAD'), 'ref: refs/heads/none\n');
  const sha256 = objectFormat === 'sha256';
  await fs.writeFile(path.join(gitDir, 'config'),
    `[core]\n\trepositoryformatversion = ${sha256 ? 1 : 0}\n\tbare = true\n${sha256 ? '[extensions]\n\tobjectformat = sha256\n' : ''}`);
  await fs.writeFile(path.join(gitDir, EMPTY_CONFIG), '');
  if (alternates.length) await fs.writeFile(path.join(gitDir, 'objects', 'info', 'alternates'), `${alternates.map((folder) => folder.replaceAll('\\', '/')).join('\n')}\n`);
}

/** Git pointed at the store alone: no work tree, no index, no system or global configuration, no attributes, the person's GIT_* gone. */
function storeEnv(base, gitDir) {
  const env = pinnedEnv(base, { gitDir, workTree: gitDir, indexFile: path.join(gitDir, 'unused.index'), objectDirectory: path.join(gitDir, 'objects'), emptyConfig: path.join(gitDir, EMPTY_CONFIG) });
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_OBJECT_DIRECTORY;
  return env;
}
function storeArgs(gitDir) {
  const empty = path.join(gitDir, EMPTY_CONFIG).replaceAll('\\', '/');
  return [...pinnedArgs(path.join(gitDir, NO_HOOKS)), '-c', `core.excludesFile=${empty}`, '-c', `core.attributesFile=${empty}`];
}
const storeGit = (exe, gitDir, env, args, options = {}) => runGit(exe, [...storeArgs(gitDir), ...args], { cwd: gitDir, env: storeEnv(env, gitDir), timeoutMs: BASELINE_LIMITS.gitTimeoutMs, ...options });
const firstLine = (text) => String(text ?? '').split('\n').find(Boolean) ?? '';

const versions = new Map();
async function gitVersion(exe, env) {
  if (!versions.has(exe)) versions.set(exe, runGit(exe, ['--version'], { env: scrubEnv(env ?? {}), timeoutMs: 20_000 }).then((result) => firstLine(result.stdout.toString('utf8')).trim() || null, () => null));
  return versions.get(exe);
}

/** A path on an `M` line of fast-import: as it is, unless it starts with a quote or holds a line end (then C-quoted). */
const fastImportPath = (file) => (file.startsWith('"') || file.includes('\n')
  ? `"${file.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n')}"`
  : file);

/** Runs Git with `source` (an async iterable of Buffers) as its standard input, with back-pressure; resolves for any exit code. */
function streamGit(exe, args, { cwd, env, source, signal = null, timeoutMs = BASELINE_LIMITS.gitTimeoutMs, maxBytes = 16 * 1024 * 1024 }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? fault('cancelled', 'cancelled')); return; }
    let child;
    try {
      child = spawn(exe, args, { cwd, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    } catch (error) { reject(fault('git_missing', `cannot start git: ${error.message}`)); return; }
    const out = [];
    const err = [];
    let total = 0;
    let failure = null;
    const stop = (error) => { if (!failure) { failure = error; killTree(child); } };
    const collect = (list) => (chunk) => { total += chunk.length; if (total <= maxBytes) list.push(chunk); };
    child.stdout.on('data', collect(out));
    child.stderr.on('data', collect(err));
    child.stdout.on('error', () => {});
    child.stderr.on('error', () => {});
    child.stdin.on('error', () => {});
    // A source that throws (bytes that are not the blob) stops Git before it reads `done`, so it commits nothing. A closed pipe means
    // Git stopped reading: its exit code says why.
    const fed = pipeline(Readable.from(source), child.stdin).then(() => null, (error) => {
      if (!['EPIPE', 'EOF', 'ERR_STREAM_PREMATURE_CLOSE', 'ERR_STREAM_DESTROYED'].includes(error?.code)) stop(error);
      return error;
    });
    const timer = setTimeout(() => stop(fault('git_timeout', `git did not finish within ${timeoutMs} ms`)), timeoutMs);
    const onAbort = () => stop(signal.reason ?? fault('cancelled', 'cancelled'));
    signal?.addEventListener('abort', onAbort, { once: true });
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
    child.once('error', (error) => { finish(); reject(error?.code === 'ENOENT' ? fault('git_missing', 'git was not found') : error); });
    child.once('close', (code) => {
      finish();
      fed.then(() => {
        if (failure) reject(failure);
        else resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8') });
      });
    });
  });
}

/**
 * Writes the tree of `entries` ({path, mode, oid}) into the store at `gitDir` as a commit on `ref`, through one `git fast-import`.
 * A blob in `known` (or a submodule) is named by its id and must already be in the store or one of its alternates (else
 * `objects_missing`); any other blob is read with `contentOf(entry)` and must hash to its id (else `workspace_changed`).
 * Resolves with {commit, tree}.
 */
export async function importTree({ git, env = process.env, gitDir, entries, contentOf, known = new Set(), ref, when = new Date(), objectFormat = 'sha1', signal = null } = {}) {
  if (typeof git !== 'string' || !git || typeof gitDir !== 'string' || !Array.isArray(entries) || typeof ref !== 'string' || !ref.startsWith('refs/')) {
    throw fault('baseline_bad_argument', 'importTree needs git, gitDir, entries and a ref');
  }
  // Every blob to write once (the first path that has it), then the commit whose `M` lines name blobs by mark or by id.
  const toWrite = [...new Map(entries.filter((entry) => entry.mode !== MODE.gitlink && !known.has(entry.oid)).map((entry) => [entry.oid, entry])).values()];
  const marks = new Map(toWrite.map((entry, index) => [entry.oid, index + 1]));
  async function* source() {
    for (let start = 0; start < toWrite.length; start += READ_AHEAD) {
      const batch = toWrite.slice(start, start + READ_AHEAD);
      const contents = await Promise.all(batch.map((row) => contentOf(row))); // READ_AHEAD files read at once, written in order
      for (const [index, row] of batch.entries()) {
        const content = contents[index];
        if (!Buffer.isBuffer(content) || blobId(content, objectFormat) !== row.oid) throw fault('workspace_changed', `${row.path} changed while it was read; take the snapshot again`);
        yield Buffer.concat([Buffer.from(`blob\nmark :${marks.get(row.oid)}\ndata ${content.length}\n`), content, Buffer.from('\n')]);
      }
    }
    yield Buffer.from(`commit ${ref}\ncommitter DatGold Baseline <baseline@datgold.invalid> ${Math.floor(when.getTime() / 1000)} +0000\ndata 0\ndeleteall\n`);
    // a submodule or a known blob is named by its id (a submodule's commit id is never among the marks of blobs)
    const lines = entries.map((entry) => `M ${entry.mode} ${marks.has(entry.oid) ? `:${marks.get(entry.oid)}` : entry.oid} ${fastImportPath(entry.path)}\n`);
    for (let index = 0; index < lines.length; index += 4096) yield Buffer.from(lines.slice(index, index + 4096).join(''), 'utf8');
    yield Buffer.from('\ndone\n');
  }
  // fastimport.unpackLimit=0: always one pack, also for a handful of objects (Git's default writes fewer than 100 as loose files)
  const run = await streamGit(git, [...storeArgs(gitDir), '-c', 'fastimport.unpackLimit=0', 'fast-import', '--quiet', '--force', '--done', '--date-format=raw'],
    { cwd: gitDir, env: storeEnv(env, gitDir), source: source(), signal });
  if (run.code !== 0) {
    if (/not found/i.test(run.stderr)) throw fault('objects_missing', `the store lacks an object: ${firstLine(run.stderr)}`);
    throw fault('git_failed', `git fast-import exited ${run.code}: ${firstLine(run.stderr)}`);
  }
  const resolved = await storeGit(git, gitDir, env, ['rev-parse', ref, `${ref}^{tree}`], { signal });
  const [commit, tree] = resolved.stdout.toString('utf8').trim().split(/\s+/);
  if (resolved.code !== 0 || !commit || !tree) throw fault('git_failed', `the store has no ${ref}: ${firstLine(resolved.stderr)}`);
  return { commit, tree };
}

/** The patch from tree `from` to tree `to` (DIFF_ARGS), both in the store at `gitDir`. {bytes, sha256}; `patch_too_large` beyond maxBytes. */
export async function treePatch({ git, env = process.env, gitDir, from, to, maxBytes = BASELINE_LIMITS.maxPatchBytes, signal = null } = {}) {
  let result;
  try {
    result = await storeGit(git, gitDir, env, [...DIFF_ARGS, from, to], { maxBytes, signal });
  } catch (error) {
    if (error?.code === 'git_output_limit') throw fault('patch_too_large', `the patch is over ${maxBytes} bytes`);
    throw error;
  }
  if (result.code !== 0) throw fault('git_failed', `git diff exited ${result.code}: ${firstLine(result.stderr)}`);
  return { bytes: result.stdout, sha256: sha256Hex(result.stdout) };
}

/** True when `patch`, applied with `git apply --cached --binary` to tree `from` in a temporary index, gives tree `to` exactly. */
export async function patchReproduces({ git, env = process.env, gitDir, from, to, patch, signal = null } = {}) {
  if (!patch.length) return from === to;
  const index = path.join(gitDir, `check-${randomUUID()}.index`);
  const run = (args, options = {}) => runGit(git, [...storeArgs(gitDir), ...args], {
    cwd: gitDir, env: { ...storeEnv(env, gitDir), GIT_INDEX_FILE: index }, timeoutMs: BASELINE_LIMITS.gitTimeoutMs, signal, ...options,
  });
  try {
    if ((await run(['read-tree', from])).code !== 0) return false;
    if ((await run(['apply', '--cached', '--binary', '--whitespace=nowarn', '-'], { input: patch })).code !== 0) return false;
    const written = await run(['write-tree']);
    return written.code === 0 && written.stdout.toString('utf8').trim() === to;
  } finally {
    await fs.rm(index, { force: true });
  }
}

/** A loose object of the snapshot's private store, or null: the blobs `.gitattributes` converted are only there. */
async function readLoose(directory, oid) {
  let packed;
  try { packed = await fs.readFile(path.join(directory, oid.slice(0, 2), oid.slice(2))); } catch { return null; }
  let raw;
  try { raw = zlib.inflateSync(packed); } catch { return null; }
  const nul = raw.indexOf(0);
  if (nul < 0 || !raw.subarray(0, nul).toString('latin1').startsWith('blob ')) return null;
  return raw.subarray(nul + 1);
}

/** The bytes of a tree entry: the converted blob the snapshot wrote, else the file (a link's target, with "/") as it is on disk. */
const workspaceContent = (root, looseDirectory) => async (entry) => {
  const stored = await readLoose(looseDirectory, entry.oid);
  if (stored) return stored;
  const absolute = path.join(root, entry.path);
  if (entry.mode === MODE.symlink) {
    const target = await fs.readlink(absolute).catch(() => null);
    return target === null ? null : Buffer.from(process.platform === 'win32' ? target.replaceAll('\\', '/') : target, 'utf8');
  }
  return fs.readFile(absolute).catch(() => null);
};

// ---------------------------------------------------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------------------------------------------------

/** The JSON text of the record on one line, with `,"recordSha256":"<sha256 of that text>"` put in front of its closing brace. */
function serialise(record) {
  const body = JSON.stringify(record);
  const hash = sha256Hex(body);
  return { text: `${body.slice(0, -1)},"recordSha256":"${hash}"}\n`, hash };
}

function parseRecord(bytes) {
  const edited = (why) => fault('baseline_edited', `the baseline record ${why}: it was changed after it was written`);
  let text;
  try { text = UTF8.decode(bytes); } catch { throw edited('is not UTF-8'); }
  const suffix = HASH_SUFFIX.exec(text);
  if (!suffix) throw edited('does not end with its sha256');
  const body = `${text.slice(0, suffix.index)}}`;
  if (sha256Hex(body) !== suffix[1]) throw edited('is not the text its sha256 was made of');
  let record;
  try { record = JSON.parse(body); } catch { throw edited('is not JSON'); }
  return { record, sha256: suffix[1] };
}

function recordProblem(record, id) {
  if (!isPlainObject(record)) return 'it is not an object';
  if (record.format !== BASELINE_FORMAT) return `its format is ${JSON.stringify(String(record.format).slice(0, 40))}, this reader knows ${BASELINE_FORMAT}`;
  if (record.id !== id) return 'its id is not its file name';
  if (![TREE_ALGORITHM.gitPinned, TREE_ALGORITHM.raw].includes(record.treeAlgorithm)) return 'unknown tree algorithm';
  const oid = OID[record.objectFormat];
  if (!oid) return 'unknown object format';
  if (typeof record.tree !== 'string' || !oid.test(record.tree) || typeof record.rawTree !== 'string' || !oid.test(record.rawTree)) return 'the tree ids are not hex';
  if (!isPlainObject(record.workspace) || typeof record.workspace.key !== 'string') return 'no workspace';
  if (!isPlainObject(record.manifest)) return 'no manifest';
  if (!isPlainObject(record.patch)) return 'no patch availability';
  // the store is always named after the record: an edited record must not lead a diff to another folder
  if (record.store !== null && (!isPlainObject(record.store) || record.store.directory !== `${id}.git` || record.store.ref !== STORE_REF)) return 'the store is not the one of this baseline';
  return null;
}

/** Reads, checks and decodes `<folder>/<id>.json`; see loadBaseline. */
async function readBaseline(folder, root, id, anchor) {
  checkId(id);
  if (anchor !== null && anchor !== undefined && (typeof anchor !== 'string' || !HEX64.test(anchor))) throw fault('baseline_bad_anchor', 'the anchor is the 64 hex digits that snapshotBaseline returned as sha256');
  const file = path.join(folder, `${id}.json`);
  let bytes;
  try { bytes = await fs.readFile(file); } catch (error) {
    if (error?.code === 'ENOENT') throw fault('baseline_missing', `there is no baseline ${id} for this workspace (pruned, deleted, or never taken)`);
    throw error;
  }
  const { record, sha256 } = parseRecord(bytes);
  if (anchor && sha256 !== anchor) throw fault('baseline_mismatch', `the baseline ${id} is not the one that was taken: its sha256 differs from the anchor`);
  const problem = recordProblem(record, id);
  if (problem) throw fault('baseline_bad_record', `the baseline ${id} is not valid: ${problem}`);
  if (record.workspace.key !== workspaceKey(root)) throw fault('baseline_wrong_workspace', `the baseline ${id} belongs to another workspace`);
  const entries = decodeManifest(record.manifest, { objectFormat: record.objectFormat });
  let tree;
  try { tree = buildTree(entries, record.objectFormat); } catch { tree = null; }
  if (tree !== record.tree) throw fault('baseline_bad_record', `the baseline ${id} is not valid: its manifest does not give its tree`);
  return { record, sha256, verifiedAgainst: anchor ? 'anchor' : 'self', file, entries };
}

/**
 * Reads a baseline and checks it: its own sha256, the anchor when given (the sha256 snapshotBaseline returned, kept by the caller),
 * its fields, its workspace, and that its manifest builds its tree. Resolves with {record, sha256, verifiedAgainst, file, entries};
 * throws baseline_bad_id, baseline_bad_anchor, baseline_missing, baseline_edited, baseline_mismatch, baseline_bad_record or
 * baseline_wrong_workspace.
 */
export async function loadBaseline({ hubDir, root, id, expectSha256 = null } = {}) {
  return readBaseline(baselineFolder(hubDir, root), root, id, expectSha256);
}

/** The baselines of a workspace, oldest first: {id, createdAt, file, store}. Read from the file names; nothing is verified here. */
export async function listBaselines({ hubDir, root } = {}) {
  const folder = baselineFolder(hubDir, root);
  const names = await fs.readdir(folder).catch(() => []);
  const stores = new Set(names.filter((name) => name.endsWith('.git')).map((name) => name.slice(0, -4)));
  return names.filter((name) => name.endsWith('.json') && ID.test(name.slice(0, -5))).map((name) => name.slice(0, -5)).sort()
    .map((id) => ({ id, createdAt: new Date(idTime(id)).toISOString(), file: path.join(folder, `${id}.json`), store: stores.has(id) }));
}

// ---------------------------------------------------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------------------------------------------------

/** Removes what a crash left (temporary folders, half-written records); only under the workspace lock. */
async function removeLeftovers(folder) {
  for (const name of await fs.readdir(folder).catch(() => [])) {
    if (name.startsWith('tmp-') || name.includes('.json.tmp-')) await fs.rm(path.join(folder, name), { recursive: true, force: true, maxRetries: 3 });
  }
}

/** Keeps the newest maxPerWorkspace baselines no older than maxAgeMs (by the time in their id) and `keep`; removes a store without a record. */
async function pruneFolder(folder, { now, retention, keep = null }) {
  const names = await fs.readdir(folder).catch(() => []);
  const ids = names.filter((name) => name.endsWith('.json') && ID.test(name.slice(0, -5))).map((name) => name.slice(0, -5));
  const doomed = [];
  [...ids].sort().reverse().forEach((id, index) => {
    if (id !== keep && (now - idTime(id) > retention.maxAgeMs || index >= retention.maxPerWorkspace)) doomed.push(id);
  });
  for (const id of doomed) {
    await fs.rm(path.join(folder, `${id}.json`), { force: true });
    await fs.rm(path.join(folder, `${id}.git`), { recursive: true, force: true, maxRetries: 3 });
  }
  const records = new Set(ids);
  for (const name of names) {
    if (name.endsWith('.git') && ID.test(name.slice(0, -4)) && !records.has(name.slice(0, -4))) await fs.rm(path.join(folder, name), { recursive: true, force: true, maxRetries: 3 });
  }
  return { removed: doomed, kept: ids.filter((id) => !doomed.includes(id)).sort() };
}

/** The age rule for every other workspace of this Hub; a workspace whose lock is held is left for its own next write. */
async function sweepOtherWorkspaces(folder, now, retention) {
  const parent = path.dirname(folder);
  for (const name of await fs.readdir(parent).catch(() => [])) {
    const other = path.join(parent, name);
    if (other === folder || !/^[0-9a-f]{32}$/.test(name)) continue;
    let held;
    try { held = await lockFolder(other, { waitMs: 0 }, 'prune'); } catch { continue; }
    try { await pruneFolder(other, { now, retention: { ...retention, maxPerWorkspace: Infinity } }); } finally { await held.release(); }
  }
}

/** Applies the retention to one workspace now (under its lock). Resolves with {removed, kept} (ids). */
export async function pruneBaselines({ hubDir, root, now = () => new Date(), retention = {}, lock = {} } = {}) {
  const folder = baselineFolder(hubDir, root);
  const held = await lockFolder(folder, lock, 'prune');
  try { return await pruneFolder(folder, { now: now().getTime(), retention: { ...RETENTION, ...retention } }); } finally { await held.release(); }
}

// ---------------------------------------------------------------------------------------------------------------------
// The baseline
// ---------------------------------------------------------------------------------------------------------------------

/** The bytes of a regular file of the tree, checked against its blob id; null when the tree has no such file. */
async function treeFile(entries, relative, contentOf, objectFormat) {
  const entry = entries.find((row) => row.path === relative && (row.mode === MODE.file || row.mode === MODE.executable));
  if (!entry) return null;
  const content = await contentOf(entry);
  if (!Buffer.isBuffer(content) || blobId(content, objectFormat) !== entry.oid) throw fault('workspace_changed', `${relative} changed while it was read; take the snapshot again`);
  return content;
}

function acceptanceOf(bytes) {
  if (!bytes) return { path: ACCEPTANCE_FILE, present: false, bytes: null, sha256: null, content: null };
  return { path: ACCEPTANCE_FILE, present: true, bytes: bytes.length, sha256: sha256Hex(bytes), content: bytes.length <= BASELINE_LIMITS.acceptanceInlineBytes ? bytes.toString('base64') : null };
}

function scriptsOf(bytes) {
  if (!bytes) return { present: false, scripts: null, problem: null };
  let parsed;
  try { parsed = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); } catch { return { present: true, scripts: null, problem: 'not_json' }; }
  if (!isPlainObject(parsed)) return { present: true, scripts: null, problem: 'not_an_object' };
  if (parsed.scripts === undefined) return { present: true, scripts: {}, problem: null };
  if (!isPlainObject(parsed.scripts)) return { present: true, scripts: null, problem: 'scripts_not_an_object' };
  return { present: true, scripts: Object.fromEntries(Object.entries(parsed.scripts).filter(([, value]) => typeof value === 'string')), problem: null };
}

/** HEAD (read from files), its branch, and the tree against HEAD's tree (read through the pinned Git, never written). */
async function gitSummary({ root, located, entries, work, git, env, signal }) {
  if (!located) return { repository: false, head: null, branch: null, dirty: null, dirtyReason: 'not_a_repository' };
  if (!located.gitDir) return { repository: true, head: null, branch: null, dirty: null, dirtyReason: 'repository_unreadable' };
  const head = await gitlinkCommit(root);
  const headText = await fs.readFile(path.join(located.gitDir, 'HEAD'), 'utf8').catch(() => '');
  const branch = /^ref:\s*refs\/heads\/(.+?)\s*$/m.exec(headText)?.[1] ?? null;
  const counts = (changes) => ({ clean: !(changes.added.length + changes.modified.length + changes.deleted.length), added: changes.added.length, modified: changes.modified.length, deleted: changes.deleted.length });
  if (!head) return { repository: true, head: null, branch, dirty: counts(manifestChanges([], entries)), dirtyReason: null };
  try {
    signal?.throwIfAborted();
    const side = await gitTreeSide({ root, rev: head, stateDir: path.join(work, 'head'), git, env });
    return { repository: true, head, branch, dirty: counts(manifestChanges(side.entries, entries)), dirtyReason: null };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { repository: true, head, branch, dirty: null, dirtyReason: String(error?.code ?? 'git_failed') };
  }
}

async function toolchainOf(option, env, root) {
  if (option === null || option === false) return null;
  const probe = option ?? new ToolchainProbe({ env });
  try { return await probe.versions(path.resolve(root)); } catch { return null; }
}

/**
 * Takes the baseline of a workspace: a full snapshot, its objects in a private store (Git workspaces), the record. Under the workspace
 * lock; prunes on write. Resolves with {id, sha256 (the anchor to keep elsewhere), file, record, timings}.
 * @param {object} options
 * @param {string} options.hubDir   the Hub data folder
 * @param {string} options.root     the workspace folder
 * @param {string|null} [options.git]  Git as for TreeSnapshotter (PATH when left out, null for none)
 * @param {object|null} [options.toolchain]  a ToolchainProbe-like {versions(root)}; null for none; a new ToolchainProbe when left out
 * @param {() => Date} [options.now]  the clock of the id, createdAt and retention
 * @param {Partial<typeof RETENTION>} [options.retention]
 * @param {Partial<typeof LOCK_RULES>} [options.lock]
 */
export async function snapshotBaseline({ hubDir, root, git, env = process.env, toolchain, now = () => new Date(), retention = {}, lock = {}, signal = null } = {}) {
  const folder = baselineFolder(hubDir, root);
  const rules = { ...RETENTION, ...retention };
  const started = performance.now();
  const held = await lockFolder(folder, lock, 'baseline');
  const work = path.join(folder, `tmp-${randomUUID()}`);
  let storeDir = null;
  let written = false;
  try {
    await removeLeftovers(folder);
    const createdAt = now();
    const id = newId(createdAt);
    const timings = {};
    let mark = performance.now();
    const snapshotter = new TreeSnapshotter({ root, stateDir: path.join(work, 'state'), git, env });
    const snapshot = await snapshotter.snapshot({ full: true, entries: true, signal });
    timings.snapshotMs = since(mark);
    if (snapshot.status !== 'ok') throw fault('workspace_too_large', `the workspace is over the snapshot limits (${snapshot.unbounded}); no baseline`);
    const { entries, objectFormat } = snapshot;
    const contentOf = workspaceContent(path.resolve(root), path.join(work, 'state', 'objects'));
    const located = await locateGitDirectories(path.resolve(root));
    let store = null;
    let patch = { available: false, reason: !located ? 'not_a_repository' : 'repository_unreadable' };
    mark = performance.now();
    if (located?.gitDir) {
      const exe = await snapshotter.usableGit();
      if (!exe) patch = { available: false, reason: 'git_missing' };
      else {
        storeDir = path.join(folder, `${id}.git`);
        await initStore(storeDir, { objectFormat });
        const imported = await importTree({ git: exe, env, gitDir: storeDir, entries, contentOf, ref: STORE_REF, when: createdAt, objectFormat, signal });
        if (imported.tree !== snapshot.tree) throw fault('baseline_store_mismatch', `the store holds tree ${imported.tree}, the snapshot was ${snapshot.tree}`);
        store = { kind: 'git', directory: `${id}.git`, ref: STORE_REF, commit: imported.commit, git: await gitVersion(exe, env) };
        patch = { available: true, reason: null };
      }
    }
    timings.storeMs = since(mark);
    const record = {
      format: BASELINE_FORMAT,
      id,
      createdAt: createdAt.toISOString(),
      workspace: { key: workspaceKey(root), root: path.resolve(root) },
      treeAlgorithm: snapshot.treeAlgorithm,
      objectFormat,
      tree: snapshot.tree,
      rawTree: snapshot.rawTree,
      snapshot: {
        engineReason: snapshot.engineReason, ignoreRules: snapshot.ignoreRules, files: snapshot.files, bytes: snapshot.bytes, excluded: snapshot.excluded,
        limitations: snapshot.limitations, takenAt: snapshot.takenAt, durationMs: snapshot.durationMs,
      },
      manifest: encodeManifest(entries),
      acceptance: acceptanceOf(await treeFile(entries, ACCEPTANCE_FILE, contentOf, objectFormat)),
      packageScripts: scriptsOf(await treeFile(entries, 'package.json', contentOf, objectFormat)),
      git: await gitSummary({ root: path.resolve(root), located, entries, work, git, env, signal }),
      toolchain: await toolchainOf(toolchain, env, root),
      store,
      patch,
    };
    const { text, hash } = serialise(record);
    const file = path.join(folder, `${id}.json`);
    const temporary = `${file}.tmp-${randomUUID()}`;
    await fs.writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, file);
    written = true;
    await pruneFolder(folder, { now: createdAt.getTime(), retention: rules, keep: id });
    await sweepOtherWorkspaces(folder, createdAt.getTime(), rules);
    timings.totalMs = since(started);
    return { id, sha256: hash, file, record, timings };
  } catch (error) {
    if (!written && storeDir) await fs.rm(storeDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    throw error;
  } finally {
    await fs.rm(work, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    await held.release();
  }
}

const unavailable = (reason) => ({ patch: { status: 'unavailable', reason }, patchBytes: null });

/**
 * The store must hold exactly the tree of the verified manifest, and the old blob of every changed path must hash to its id (the
 * patch is made of them). null when it does, else the reason the patch is unavailable. Git checks the hash of the root tree when it
 * parses it (a forged root fails `ls-tree`), but not of the trees below it nor of blobs read by `cat-file --batch`: those are compared
 * here. A store Git cannot read within the limits (an output over `maxOutputBytes`, a timeout) is 'baseline_objects_unreadable'.
 */
async function storeProblem({ exe, env, storeDir, record, before, changes, maxOutputBytes, signal }) {
  try {
    const listed = await storeGit(exe, storeDir, env, ['ls-tree', '-r', '-z', '--full-tree', record.tree], { maxBytes: maxOutputBytes, signal });
    if (listed.code !== 0) {
      const present = await storeGit(exe, storeDir, env, ['cat-file', '-e', record.tree], { maxBytes: maxOutputBytes, signal });
      return present.code === 0 ? 'baseline_objects_mismatch' : 'baseline_objects_missing';
    }
    const expected = new Set(before.map((row) => `${row.mode} ${row.oid}\t${row.path}`));
    const rows = splitNul(listed.stdout).map((line) => {
      const tab = line.indexOf('\t');
      const [mode, , oid] = line.slice(0, tab).split(' ');
      return `${mode} ${oid}\t${line.slice(tab + 1)}`;
    });
    if (rows.length !== expected.size || rows.some((row) => !expected.has(row))) return 'baseline_objects_mismatch';
    const wanted = [...new Set([...changes.modified.filter((row) => row.oldMode !== MODE.gitlink).map((row) => row.oldOid),
      ...changes.deleted.filter((row) => row.mode !== MODE.gitlink).map((row) => row.oid)])];
    if (!wanted.length) return null;
    return await oldBlobsProblem({ exe, env, gitDir: storeDir, oids: wanted, objectFormat: record.objectFormat, signal });
  } catch (error) {
    if (signal?.aborted || !['git_output_limit', 'git_timeout', 'git_missing'].includes(error?.code)) throw error;
    return 'baseline_objects_unreadable'; // the store check ran out of a limit
  }
}

/**
 * Hashes the blobs `oids` of the store at `gitDir` as one `git cat-file --batch` prints them, chunk by chunk. No blob and no sum of
 * blobs is held in memory, so their size has no limit (audit F1 of #148: a 270 MB file with a 7-byte change). null when each is a
 * blob that hashes to its id, else 'baseline_objects_missing', 'baseline_objects_mismatch' or 'baseline_objects_unreadable' (Git
 * failed, timed out or printed something else). Rejects only when `signal` aborts.
 */
function oldBlobsProblem({ exe, env, gitDir, oids, objectFormat, signal = null, timeoutMs = BASELINE_LIMITS.gitTimeoutMs }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? fault('cancelled', 'cancelled')); return; }
    let child;
    try {
      child = spawn(exe, [...storeArgs(gitDir), 'cat-file', '--batch'], {
        cwd: gitDir, env: storeEnv(env, gitDir), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], detached: process.platform !== 'win32',
      });
    } catch { resolve('baseline_objects_unreadable'); return; }
    let verdict; // undefined while the answer is still being read
    let index = 0; // the object being read
    let left = -1; // the bytes of its content not hashed yet; -1 while its header line is awaited
    let header = Buffer.alloc(0);
    let hash = null;
    const settle = (value) => { if (verdict === undefined) { verdict = value; killTree(child); } };
    const read = (chunk) => {
      let at = 0;
      while (at < chunk.length && verdict === undefined) {
        if (left > 0) {
          const part = chunk.subarray(at, at + left);
          hash.update(part);
          left -= part.length;
          at += part.length;
        } else if (left === 0) { // the line end after the content
          if (chunk[at] !== 0x0a) { settle('baseline_objects_unreadable'); return; }
          if (hash.digest('hex') !== oids[index]) { settle('baseline_objects_mismatch'); return; }
          at += 1;
          left = -1;
          index += 1;
        } else {
          const newline = chunk.indexOf(0x0a, at);
          if (newline < 0) { // a header split between two chunks
            header = Buffer.concat([header, chunk.subarray(at)]);
            if (header.length > 512) settle('baseline_objects_unreadable');
            return;
          }
          const [id, type, size] = Buffer.concat([header, chunk.subarray(at, newline)]).toString('latin1').split(' ');
          header = Buffer.alloc(0);
          at = newline + 1;
          if (index >= oids.length) { settle('baseline_objects_unreadable'); return; }
          if (type === 'missing') { settle('baseline_objects_missing'); return; }
          if (id !== oids[index] || type !== 'blob' || !/^\d{1,15}$/.test(size ?? '')) { settle('baseline_objects_mismatch'); return; }
          left = Number(size);
          hash = createHash(objectFormat).update(`blob ${left}\0`);
        }
      }
    };
    child.stdout.on('data', read);
    child.stdout.on('error', () => {});
    child.stdin.on('error', () => {});
    child.stdin.end(`${oids.join('\n')}\n`);
    const timer = setTimeout(() => settle('baseline_objects_unreadable'), timeoutMs);
    const onAbort = () => settle('baseline_objects_unreadable');
    signal?.addEventListener('abort', onAbort, { once: true });
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
    child.once('error', () => { finish(); settle('baseline_objects_unreadable'); resolve(verdict); });
    child.once('close', (code) => {
      finish();
      if (signal?.aborted) reject(signal.reason ?? fault('cancelled', 'cancelled'));
      else if (verdict !== undefined) resolve(verdict);
      else resolve(code === 0 && index === oids.length && left === -1 && !header.length ? null : 'baseline_objects_unreadable');
    });
  });
}

async function buildPatch({ exe, env, folder, record, before, snapshot, changes, work, root, bounds, signal }) {
  const storeDir = path.join(folder, record.store.directory);
  if (!(await fs.stat(path.join(storeDir, 'objects')).then((stat) => stat.isDirectory(), () => false))) return unavailable('baseline_objects_missing');
  if (snapshot.objectFormat !== record.objectFormat) return unavailable('object_format_changed');
  const problem = await storeProblem({ exe, env, storeDir, record, before, changes, maxOutputBytes: bounds.gitOutputBytes, signal });
  if (problem) return unavailable(problem);
  // The final tree goes into a temporary store that borrows the baseline's objects; the baseline's store is only read.
  const finalDir = path.join(work, 'final.git');
  await initStore(finalDir, { objectFormat: record.objectFormat, alternates: [path.join(storeDir, 'objects')] });
  let imported;
  try {
    imported = await importTree({
      git: exe, env, gitDir: finalDir, entries: snapshot.entries, contentOf: workspaceContent(root, path.join(work, 'state', 'objects')),
      known: new Set(before.map((row) => row.oid)), ref: FINAL_REF, objectFormat: record.objectFormat, signal,
    });
  } catch (error) {
    if (error?.code === 'objects_missing') return unavailable('baseline_objects_missing');
    throw error;
  }
  if (imported.tree !== snapshot.tree) throw fault('baseline_store_mismatch', `the final store holds tree ${imported.tree}, the snapshot was ${snapshot.tree}`);
  let made;
  try {
    made = await treePatch({ git: exe, env, gitDir: finalDir, from: record.tree, to: snapshot.tree, maxBytes: bounds.maxPatchBytes, signal });
  } catch (error) {
    if (error?.code === 'patch_too_large') return unavailable('patch_too_large');
    throw error;
  }
  if (!(await patchReproduces({ git: exe, env, gitDir: finalDir, from: record.tree, to: snapshot.tree, patch: made.bytes, signal }))) return unavailable('patch_does_not_reproduce');
  return { patch: { status: 'ok', reason: null, sha256: made.sha256, bytes: made.bytes.length, reproduces: true, git: await gitVersion(exe, env) }, patchBytes: made.bytes };
}

/**
 * Compares the workspace now with a baseline: a full snapshot, the change list of the two manifests, and for a Git workspace the
 * patch between the two trees (its sha256 is the subject of a proof pack). Under the workspace lock. Throws what loadBaseline throws
 * and `workspace_changed` / `workspace_too_large`; a patch that cannot be made is `patch: {status: 'unavailable', reason}`.
 * `limits` may lower `maxPatchBytes` and `gitOutputBytes` (BASELINE_LIMITS) for this diff.
 */
export async function diffBaseline({ hubDir, root, id, expectSha256 = null, git, env = process.env, lock = {}, limits = {}, signal = null } = {}) {
  const folder = baselineFolder(hubDir, root);
  checkId(id);
  const bounds = {
    maxPatchBytes: Math.min(limits.maxPatchBytes ?? Infinity, BASELINE_LIMITS.maxPatchBytes),
    gitOutputBytes: Math.min(limits.gitOutputBytes ?? Infinity, BASELINE_LIMITS.gitOutputBytes),
  };
  const held = await lockFolder(folder, lock, 'diff');
  const work = path.join(folder, `tmp-${randomUUID()}`);
  try {
    const loaded = await readBaseline(folder, root, id, expectSha256);
    const { record, entries: before } = loaded;
    const snapshotter = new TreeSnapshotter({ root, stateDir: path.join(work, 'state'), git, env });
    const snapshot = await snapshotter.snapshot({ full: true, entries: true, signal });
    if (snapshot.status !== 'ok') throw fault('workspace_too_large', `the workspace is over the snapshot limits (${snapshot.unbounded})`);
    const changes = manifestChanges(before, snapshot.entries);
    let made;
    if (!record.store) made = unavailable(record.patch.reason ?? 'no_store');
    else {
      const exe = await snapshotter.usableGit();
      made = exe ? await buildPatch({ exe, env, folder, record, before, snapshot, changes, work, root: path.resolve(root), bounds, signal }) : unavailable('git_missing');
    }
    return {
      format: BASELINE_DIFF_FORMAT,
      baselineId: id,
      baselineSha256: loaded.sha256,
      verifiedAgainst: loaded.verifiedAgainst,
      baseline: { createdAt: record.createdAt, treeAlgorithm: record.treeAlgorithm, objectFormat: record.objectFormat, tree: record.tree, rawTree: record.rawTree },
      final: {
        treeAlgorithm: snapshot.treeAlgorithm, objectFormat: snapshot.objectFormat, tree: snapshot.tree, rawTree: snapshot.rawTree, engineReason: snapshot.engineReason,
        ignoreRules: snapshot.ignoreRules, files: snapshot.files, bytes: snapshot.bytes, excluded: snapshot.excluded, limitations: snapshot.limitations,
        takenAt: snapshot.takenAt, durationMs: snapshot.durationMs,
      },
      sameTree: snapshot.treeAlgorithm === record.treeAlgorithm && snapshot.tree === record.tree,
      changes,
      counts: { added: changes.added.length, modified: changes.modified.length, deleted: changes.deleted.length },
      patch: made.patch,
      patchBytes: made.patchBytes,
    };
  } finally {
    await fs.rm(work, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    await held.release();
  }
}
