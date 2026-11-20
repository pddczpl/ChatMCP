// Shared by tests/verify-proof-tree*.mjs: an isolated Git, the reference tree recipe, generated repositories and the property test.
//
// The reference is plain `git add -A && git write-tree` in a throw-away bare repository (its own index and objects, the workspace's
// objects as an alternate), with no system or global configuration and no personal ignore or attributes file: what Git itself says the
// tree of the workspace is. The engine under test never shares an index or an object store with it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TREE_ALGORITHM, TreeSnapshotter, exclusionOf } from '../../lib/proof/tree-snapshot.mjs';

export const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-tree-'));
process.on('exit', () => { try { fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best effort */ } });
let serial = 0;
export const fresh = (label) => { const dir = path.join(scratch, `${label}-${(serial += 1)}`); fs.mkdirSync(dir, { recursive: true }); return dir; };
export const emptyConfig = path.join(scratch, 'empty.gitconfig');
fs.writeFileSync(emptyConfig, '');

/** Git as the person would never run it: no system or global configuration, nothing inherited from this process's GIT_* variables. */
export const isolatedEnv = (extra = {}) => {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (!/^GIT_/i.test(key)) env[key] = value;
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyConfig, GIT_ATTR_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', ...extra };
};
// core.fscache is what Git for Windows sets in its system configuration (not read here); elsewhere the key is unknown and ignored
const IDENTITY = ['-c', 'user.name=Proof Test', '-c', 'user.email=proof@example.invalid', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', '-c', 'core.fscache=true'];
export function git(cwd, args, { env = isolatedEnv(), input, allowFail = false } = {}) {
  const result = spawnSync('git', [...IDENTITY, ...args], { cwd, env, input, maxBuffer: 512 * 1024 * 1024, windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFail) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr.toString()}`);
  return { status: result.status, stdout: result.stdout.toString('utf8'), stderr: result.stderr.toString('utf8') };
}
export const write = (root, relative, content) => { const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };
export const newRepo = (label) => { const dir = fresh(label); git(dir, ['init', '-q']); return dir; };
export const commitAll = (dir) => { git(dir, ['add', '-A']); git(dir, ['commit', '-q', '--allow-empty', '-m', 'fixture']); };

/** The reference: a throw-away bare repository whose index and objects are its own, pointed at the workspace as its work tree. */
export class Reference {
  constructor(workTree, { alternates = null } = {}) {
    this.workTree = workTree;
    this.bare = fresh('reference');
    git(this.bare, ['init', '-q', '--bare']);
    const objects = alternates ?? path.join(workTree, '.git', 'objects');
    if (fs.existsSync(objects)) fs.writeFileSync(path.join(this.bare, 'objects', 'info', 'alternates'), `${objects.replaceAll('\\', '/')}\n`);
    this.index = path.join(this.bare, 'reference.index');
  }
  env() { return isolatedEnv({ GIT_DIR: this.bare, GIT_WORK_TREE: this.workTree, GIT_INDEX_FILE: this.index }); }
  reset() { fs.rmSync(this.index, { force: true }); }
  tree(extraPathspecs = []) {
    // the workspace's own .git/info/exclude is part of Git's ignore rules; the bare repository would read only its own
    const exclude = path.join(this.workTree, '.git', 'info', 'exclude');
    fs.mkdirSync(path.join(this.bare, 'info'), { recursive: true });
    fs.writeFileSync(path.join(this.bare, 'info', 'exclude'), fs.existsSync(exclude) && fs.statSync(exclude).isFile() ? fs.readFileSync(exclude) : '');
    const none = emptyConfig.replaceAll('\\', '/');
    const config = ['-c', 'core.autocrlf=false', '-c', 'core.longpaths=true', '-c', 'core.sparseCheckout=false', '-c', 'core.fsmonitor=false',
      '-c', `core.excludesFile=${none}`, '-c', `core.attributesFile=${none}`];
    git(this.workTree, [...config, 'add', '-A', '--', '.', ...extraPathspecs], { env: this.env() });
    // Ignore rules apply to untracked files only: a file the repository tracks stays in its tree whatever .gitignore says. So every
    // tracked path that is still a file on disk is added too (read from the repository's own index; a deleted one drops out).
    const excluded = new Set(extraPathspecs.map((spec) => spec.replace(/^:\(exclude,literal\)/, '')));
    const tracked = this.trackedOnDisk().filter((file) => !excluded.has(file));
    if (tracked.length) {
      git(this.workTree, [...config, 'add', '-f', '--pathspec-from-file=-', '--pathspec-file-nul'], { env: this.env(), input: tracked.map((file) => `:(literal)${file}\0`).join('') });
    }
    return git(this.workTree, [...config, 'write-tree'], { env: this.env() }).stdout.trim();
  }
  /** The paths the repository's own index tracks that are a file or a link on disk now. */
  trackedOnDisk() {
    const listed = git(this.workTree, ['-c', 'core.fsmonitor=false', 'ls-files', '-z', '--cached'], { allowFail: true });
    if (listed.status !== 0) return [];
    return listed.stdout.split('\0').filter(Boolean).filter((file) => {
      try { const stat = fs.lstatSync(path.join(this.workTree, file)); return stat.isFile() || stat.isSymbolicLink(); } catch { return false; }
    });
  }
  freshTree(extraPathspecs) { this.reset(); return this.tree(extraPathspecs); }
  lsTree(tree) { return git(this.workTree, ['ls-tree', '-r', '-z', tree], { env: this.env() }).stdout.split('\0').filter(Boolean); }
}

export const snapshotter = (root, options = {}) => new TreeSnapshotter({ root, stateDir: fresh('state'), ...options });
export const sha1 = (text) => createHash('sha1').update(text).digest('hex');
export const percentile = (values, p) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]; };
export const timed = async (fn) => { const start = performance.now(); const value = await fn(); return { value, ms: performance.now() - start }; };
export const timedSync = (fn) => { const start = performance.now(); fn(); return performance.now() - start; };

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Lists every file below a folder with its size, time and a hash of its bytes: the repository's .git must come out identical. */
export function folderPrint(folder) {
  const rows = [];
  const walk = (relative) => {
    for (const entry of fs.readdirSync(path.join(folder, relative), { withFileTypes: true })) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) walk(child);
      else {
        const stat = fs.statSync(path.join(folder, child));
        rows.push(`${child}|${stat.size}|${stat.mtimeMs}|${sha1(fs.readFileSync(path.join(folder, child)))}`);
      }
    }
  };
  walk('');
  return rows.sort();
}

// ---------------------------------------------------------------------------------------------------------------------
// Generated repositories
// ---------------------------------------------------------------------------------------------------------------------

const LETTERS = 'abcdefghijklmnopqrstuvwxyz0123456789';
export function generator(seed) {
  const random = mulberry32(seed);
  const pick = (list) => list[Math.floor(random() * list.length)];
  const word = (length = 3 + Math.floor(random() * 6)) => Array.from({ length }, () => pick(LETTERS)).join('');
  // empty, binary, LF text and CRLF text
  const content = () => {
    const kind = random();
    const size = Math.floor(random() * 1200);
    if (kind < 0.1) return Buffer.alloc(0);
    if (kind < 0.25) return Buffer.from(Array.from({ length: size }, () => Math.floor(random() * 256)));
    const lines = Array.from({ length: 1 + Math.floor(size / 40) }, () => word(20));
    return Buffer.from(lines.join(random() < 0.3 ? '\r\n' : '\n') + '\n');
  };
  return { random, pick, word, content };
}

/**
 * A repository of `count` files in nested folders. `commit` commits them all, through `git fast-import` (one pack) rather than `git add`
 * (on Windows thousands of loose objects take most of a minute), then `git reset` builds the index from that commit.
 */
export function generateRepo(label, count, seed, { commit }) {
  const dir = newRepo(label);
  const g = generator(seed);
  const folders = Array.from({ length: Math.max(4, Math.floor(count / 40)) }, (_, index) => (index === 0 ? '' : `${g.word()}/${index % 3 ? g.word() : ''}`.replace(/\/$/, '')));
  const files = new Map();
  while (files.size < count) {
    const folder = g.pick(folders);
    const name = `${g.word()}.${g.pick(['js', 'txt', 'md', 'bin', 'json', 'log'])}`;
    const relative = folder ? `${folder}/${name}` : name;
    if (files.has(relative) || exclusionOf(relative)) continue;
    const content = g.content();
    files.set(relative, content);
    write(dir, relative, content);
  }
  if (commit) {
    const parts = [Buffer.from('commit refs/heads/main\ncommitter Proof Test <proof@example.invalid> 0 +0000\ndata 8\nfixture\n')];
    for (const [relative, content] of files) parts.push(Buffer.from(`M 100644 inline ${relative}\ndata ${content.length}\n`), content, Buffer.from('\n'));
    git(dir, ['fast-import', '--quiet'], { input: Buffer.concat(parts) });
    git(dir, ['reset', '-q']);
  }
  return { dir, files: new Set(files.keys()), g, folders };
}

/**
 * `steps` random operations (create, edit, same-size edit, delete, rename, and .gitignore on/off) on a generated repository. After every
 * one the engine's cached snapshot must equal the reference; every `fullEvery` steps a full snapshot, its rawTree and a fresh reference
 * index must agree too, and every `rawEvery` steps a cached raw-v1 snapshot.
 */
export async function propertyTest(repo, { steps, fullEvery, rawEvery, label }) {
  const { dir, files, g, folders } = repo;
  const list = [...files];
  const engine = snapshotter(dir);
  const raw = snapshotter(dir, { engine: TREE_ALGORITHM.raw });
  const reference = new Reference(dir);
  let gitignore = false;
  const counts = { create: 0, edit: 0, sameSize: 0, delete: 0, rename: 0, gitignore: 0, referenceMs: 0, engineMs: 0 };
  assert.equal((await engine.snapshot({ full: true })).treeAlgorithm, TREE_ALGORITHM.gitPinned);
  await raw.snapshot({ full: true });
  const remove = (relative) => { const at = list.indexOf(relative); list[at] = list.at(-1); list.pop(); };
  const clashes = (relative) => list.includes(relative) || exclusionOf(relative) || list.some((file) => file.startsWith(`${relative}/`) || relative.startsWith(`${file}/`));
  for (let step = 1; step <= steps;) {
    const roll = g.random();
    if (roll < 0.04) {
      gitignore = !gitignore;
      counts.gitignore += 1;
      if (gitignore) write(dir, '.gitignore', '*.log\nbuild/\n'); else fs.rmSync(path.join(dir, '.gitignore'), { force: true });
      reference.reset(); // a reused index keeps entries that a new ignore rule would exclude; the reference starts over
    } else if (roll < 0.3 || list.length < 5) {
      const folder = g.random() < 0.2 ? `${g.pick(folders)}/${g.word()}`.replace(/^\//, '') : g.pick(folders);
      const relative = `${folder ? `${folder}/` : ''}${g.word()}.${g.pick(['js', 'txt', 'log', 'md'])}`;
      if (clashes(relative)) continue;
      write(dir, relative, g.content());
      list.push(relative);
      counts.create += 1;
    } else if (roll < 0.6) {
      const relative = g.pick(list);
      const file = path.join(dir, relative);
      const bytes = fs.readFileSync(file);
      if (bytes.length && g.random() < 0.4) {
        const at = Math.floor(g.random() * bytes.length);
        bytes[at] = (bytes[at] + 1 + Math.floor(g.random() * 254)) % 256;
        fs.writeFileSync(file, bytes);
        counts.sameSize += 1;
      } else { fs.writeFileSync(file, g.content()); counts.edit += 1; }
    } else if (roll < 0.8) {
      const relative = g.pick(list);
      fs.rmSync(path.join(dir, relative));
      remove(relative);
      counts.delete += 1;
    } else {
      const relative = g.pick(list);
      const folder = g.pick(folders);
      const target = `${folder ? `${folder}/` : ''}${g.word()}-moved.${relative.split('.').at(-1)}`;
      if (clashes(target)) continue;
      fs.mkdirSync(path.dirname(path.join(dir, target)), { recursive: true });
      fs.renameSync(path.join(dir, relative), path.join(dir, target));
      remove(relative);
      list.push(target);
      counts.rename += 1;
    }
    let mark = performance.now();
    const expected = reference.tree();
    counts.referenceMs += performance.now() - mark;
    mark = performance.now();
    const cached = await engine.snapshot();
    counts.engineMs += performance.now() - mark;
    assert.equal(cached.treeAlgorithm, TREE_ALGORITHM.gitPinned, `${label} step ${step}: ${cached.engineReason}`);
    assert.equal(cached.tree, expected, `${label} step ${step}: the cached snapshot equals the reference`);
    if (step % fullEvery === 0) {
      const full = await engine.snapshot({ full: true });
      assert.equal(full.treeAlgorithm, TREE_ALGORITHM.gitPinned, full.engineReason);
      assert.equal(full.tree, expected, `${label} step ${step}: full`);
      assert.equal(full.rawTree, expected, `${label} step ${step}: rawTree`);
      assert.equal(reference.freshTree(), expected, `${label} step ${step}: a fresh reference index agrees with the reused one`);
    }
    if (step % rawEvery === 0) assert.equal((await raw.snapshot()).tree, expected, `${label} step ${step}: raw-v1 cached`);
    step += 1;
  }
  counts.referenceMs = Math.round(counts.referenceMs);
  counts.engineMs = Math.round(counts.engineMs);
  return counts;
}
