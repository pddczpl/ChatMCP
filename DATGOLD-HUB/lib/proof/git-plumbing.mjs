// Git object identities and a Git invocation that cannot touch the repository's own index or object store.
//
// The proof engine (lib/proof/tree-snapshot.mjs) names a workspace tree by a Git tree id. Two halves live here:
//
//  1. Pure Node: the id of a blob, of a tree, and of a whole tree built from (path, mode, blob id) rows, byte for byte what
//     `git hash-object --no-filters` and `git write-tree --missing-ok` give. Nothing is written anywhere.
//  2. A pinned Git process: a temporary index (GIT_INDEX_FILE) and a private object directory (GIT_OBJECT_DIRECTORY, with the
//     repository's own objects as a read-only alternate), no system or global configuration, no system attributes, and the
//     settings that change bytes or start programs switched off on the command line. The person's GIT_* variables are dropped.
//
// GitRunner (lib/git-runner.mjs) strips GIT_INDEX_FILE and GIT_OBJECT_DIRECTORY on purpose, so it is not used here; the guard it
// applies (inspectGitSafety / refusalsForRunner) is applied by the caller before any process starts.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveProgram } from '../runtime.mjs';
import { killTree, scrubEnv } from '../shell-runner.mjs';

export const MODE = Object.freeze({ file: '100644', executable: '100755', symlink: '120000', gitlink: '160000', tree: '40000' });

/** Settings given on every pinned command line: no line-ending conversion, no fsmonitor, long paths, no sparse view, nothing automatic. */
export const PINNED_CONFIG = Object.freeze([
  'core.autocrlf=false', 'core.safecrlf=false', 'core.fsmonitor=false', 'core.longpaths=true',
  'core.sparseCheckout=false', 'index.sparse=false', 'core.untrackedCache=false', 'core.splitIndex=false',
  'core.quotepath=false', 'core.pager=cat', 'core.editor=true', 'gc.auto=0', 'maintenance.auto=false',
  // Git for Windows turns its file-system cache on in the system configuration, which is not read here; without it a scan of 8,000
  // files takes five times longer. Other builds do not know the key and ignore it.
  'core.fscache=true',
]);

const OID_LENGTH = { sha1: 20, sha256: 32 };

/** The id of a blob with exactly these bytes (`git hash-object --no-filters`). */
export function blobId(bytes, objectFormat = 'sha1') {
  const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return createHash(objectFormat).update(`blob ${body.length}\0`).update(body).digest('hex');
}

/** Git orders tree entries by their name bytes, a folder's name read as if it ended with "/". */
function entryKey(entry) {
  return entry.mode === MODE.tree ? Buffer.concat([entry.name, Buffer.from('/')]) : entry.name;
}

/** The id of one tree object from its entries {name: Buffer|string, mode, oid}. Throws on a duplicate name. */
export function treeId(entries, objectFormat = 'sha1') {
  const rows = entries.map((entry) => ({ ...entry, name: Buffer.isBuffer(entry.name) ? entry.name : Buffer.from(entry.name, 'utf8') }));
  rows.sort((a, b) => Buffer.compare(entryKey(a), entryKey(b)));
  const parts = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (index > 0 && Buffer.compare(rows[index - 1].name, row.name) === 0) throw new Error(`duplicate tree entry: ${row.name.toString('utf8')}`);
    const oid = Buffer.from(row.oid, 'hex');
    if (oid.length !== OID_LENGTH[objectFormat]) throw new Error(`bad object id for ${row.name.toString('utf8')}`);
    parts.push(Buffer.from(`${row.mode} `), row.name, Buffer.from([0]), oid);
  }
  const body = Buffer.concat(parts);
  return createHash(objectFormat).update(`tree ${body.length}\0`).update(body).digest('hex');
}

/**
 * The root tree id of files given as rows {path: "a/b.txt" (forward slashes), mode, oid}; folders are made from the paths and
 * empty folders do not exist, as in Git. The tree of no files is the empty tree.
 */
export function buildTree(files, objectFormat = 'sha1') {
  const root = new Map();
  for (const file of files) {
    const parts = String(file.path).split('/');
    if (parts.some((part) => !part || part === '.' || part === '..')) throw new Error(`bad path in tree: ${file.path}`);
    let folder = root;
    for (const part of parts.slice(0, -1)) {
      let next = folder.get(part);
      if (next === undefined) { next = new Map(); folder.set(part, next); }
      if (!(next instanceof Map)) throw new Error(`a file and a folder share the name ${part}`);
      folder = next;
    }
    const name = parts.at(-1);
    if (folder.has(name)) throw new Error(`duplicate path in tree: ${file.path}`);
    folder.set(name, file);
  }
  const write = (folder) => treeId([...folder].map(([name, value]) => (value instanceof Map
    ? { name, mode: MODE.tree, oid: write(value) }
    : { name, mode: value.mode, oid: value.oid })), objectFormat);
  return write(root);
}

/** Resolves the commit a nested repository has checked out (what `git add` records for a gitlink), or null. Reads files only. */
export async function gitlinkCommit(folder) {
  const dotGit = path.join(folder, '.git');
  let gitDir = dotGit;
  try {
    const stat = await fs.lstat(dotGit);
    if (stat.isFile()) {
      const target = /^gitdir:\s*(.+?)\s*$/m.exec(await fs.readFile(dotGit, 'utf8'))?.[1];
      if (!target) return null;
      gitDir = path.resolve(folder, target);
    } else if (!stat.isDirectory()) return null;
  } catch { return null; }
  const read = (file) => fs.readFile(file, 'utf8').catch(() => null);
  const common = (await read(path.join(gitDir, 'commondir')))?.trim();
  const commonDir = common ? path.resolve(gitDir, common) : gitDir;
  let head = (await read(path.join(gitDir, 'HEAD')))?.trim();
  for (let depth = 0; head && depth < 5; depth += 1) {
    if (/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(head)) return head;
    const ref = /^ref:\s*(refs\/[^\s]+)$/.exec(head)?.[1];
    if (!ref || ref.split('/').includes('..')) return null;
    const loose = (await read(path.join(gitDir, ref))) ?? (await read(path.join(commonDir, ref)));
    if (loose !== null) { head = loose.trim(); continue; }
    const packed = (await read(path.join(commonDir, 'packed-refs'))) ?? '';
    const line = packed.split(/\r?\n/).find((row) => row.endsWith(` ${ref}`));
    head = line ? line.slice(0, line.indexOf(' ')) : null;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// The pinned process
// ---------------------------------------------------------------------------------------------------------------------

/** The Git program: an explicit path, `null` for "no Git" (the engine then works without it), or PATH when undefined. */
export async function findGit(explicit) {
  if (explicit === null || explicit === false) return null;
  if (typeof explicit === 'string') return explicit;
  return resolveProgram(process.platform === 'win32' ? 'git.exe' : 'git');
}

/**
 * The environment of a pinned Git process. Every GIT_* variable of `base` is dropped (they redirect Git or name programs), credentials
 * are scrubbed, and Git is pointed at exactly the given repository, work tree, index and object store.
 * @param {object} where {gitDir, workTree, indexFile, objectDirectory, alternates: string[], emptyConfig}
 */
export function pinnedEnv(base, { gitDir, workTree, indexFile, objectDirectory, alternates = [], emptyConfig }) {
  const env = scrubEnv(base ?? {});
  for (const key of Object.keys(env)) if (/^GIT_/i.test(key) || /^(?:XDG_CONFIG_HOME|EMAIL)$/i.test(key)) delete env[key];
  Object.assign(env, {
    GIT_DIR: gitDir,
    GIT_WORK_TREE: workTree,
    GIT_INDEX_FILE: indexFile,
    GIT_OBJECT_DIRECTORY: objectDirectory,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_LITERAL_PATHSPECS: '0',
    LC_ALL: 'C',
    LANGUAGE: 'en',
  });
  if (alternates.length) env.GIT_ALTERNATE_OBJECT_DIRECTORIES = alternates.join(path.delimiter);
  return env;
}

/** The command-line half: `-c` for every pinned setting, hooks pointed at an empty folder. */
export function pinnedArgs(hooksDirectory) {
  const args = [];
  for (const setting of PINNED_CONFIG) args.push('-c', setting);
  if (hooksDirectory) args.push('-c', `core.hooksPath=${hooksDirectory.replaceAll('\\', '/')}`);
  return args;
}

/** Creates the private object directory Git needs before it accepts GIT_OBJECT_DIRECTORY. */
export async function ensureObjectDirectory(directory) {
  await fs.mkdir(path.join(directory, 'info'), { recursive: true });
  await fs.mkdir(path.join(directory, 'pack'), { recursive: true });
}

const fault = (code, message) => Object.assign(new Error(message), { code });

/**
 * Runs Git and collects its output. Resolves for any exit code; rejects with code `git_missing` when the program cannot start,
 * `git_timeout` after `timeoutMs`, `git_output_limit` beyond `maxBytes`, and the signal's reason when aborted.
 */
export function runGit(exe, args, { cwd, env, input = null, timeoutMs = 120_000, maxBytes = 256 * 1024 * 1024, signal = null } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? fault('cancelled', 'cancelled')); return; }
    let child;
    try {
      child = spawn(exe, args, { cwd, env, shell: false, windowsHide: true, stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    } catch (error) { reject(fault('git_missing', `cannot start git: ${error.message}`)); return; }
    const out = [];
    const err = [];
    let total = 0;
    let failure = null;
    const stop = (error) => { if (!failure) { failure = error; killTree(child); } };
    const collect = (list) => (chunk) => {
      total += chunk.length;
      if (total > maxBytes) { stop(fault('git_output_limit', `git printed more than ${maxBytes} bytes`)); return; }
      if (!failure) list.push(chunk);
    };
    child.stdout.on('data', collect(out));
    child.stderr.on('data', collect(err));
    child.stdout.on('error', () => {});
    child.stderr.on('error', () => {});
    if (input !== null) { child.stdin.on('error', () => {}); child.stdin.end(input); }
    const timer = setTimeout(() => stop(fault('git_timeout', `git did not finish within ${timeoutMs} ms`)), timeoutMs);
    const onAbort = () => stop(signal.reason ?? fault('cancelled', 'cancelled'));
    signal?.addEventListener('abort', onAbort, { once: true });
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
    child.once('error', (error) => { finish(); reject(error?.code === 'ENOENT' ? fault('git_missing', 'git was not found') : error); });
    child.once('close', (code) => {
      finish();
      if (failure) reject(failure);
      else resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8') });
    });
  });
}

/** Splits NUL-terminated output (`-z`) into strings. */
export const splitNul = (buffer) => buffer.toString('utf8').split('\0').filter(Boolean);
