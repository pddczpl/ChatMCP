// A content identity of the workspace tree: the Git tree id of the files the workspace holds right now.
//
// Later receipts (P4 pod-16/17/18) bind to such an id. The proof service (lib/proof/service.mjs, pod-17) takes snapshots around calls. See
// docs/PROOF-TREE.md for the contract.
//
// Two engines:
//   git-pinned-v1  Git itself (`add -A` in a temporary index with a private object directory, the tree built from `ls-files -s`); the
//                  repository's own index and object store are never written, not even their times (lib/proof/git-plumbing.mjs). The
//                  id is what `git add -A && git write-tree` gives, .gitattributes conversions included, with no line-ending setting
//                  of the person or the repository applied.
//   raw-v1         Pure Node over the raw bytes: equal to `git hash-object --no-filters` for every file and `write-tree --missing-ok`
//                  over them. Chosen when Git would run a program of the repository (a clean/smudge/process filter, textconv, an
//                  fsmonitor, anything refusalsForRunner names), when the workspace is not a repository, when Git is missing, when
//                  Git fails, or when a first scan would write more than ~3,000 new blobs.
//
// Both leave out protected files (lib/protected-paths.mjs) and `.chatmcp/runs`. Untracked paths that .gitignore excludes are not
// covered; a path the repository tracks is, whatever .gitignore says (as in Git, ignore rules apply to untracked files only). When Git
// cannot be used the ignore rules are not applied at all.
// A full snapshot (task start, final, pack) bypasses every cache and also computes `rawTree`; a cached snapshot reuses the
// stat information of the last one and is meant for the calls in between.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { inspectGitSafety, locateGitDirectories, parseGitConfig, refusalsForRunner } from '../git-trust.mjs';
import { PRIVATE_DIRECTORIES, PRIVATE_LOCATIONS, isProtectedPath } from '../protected-paths.mjs';
import { scrubEnv } from '../shell-runner.mjs';
import {
  MODE, blobId, buildTree, ensureObjectDirectory, findGit, gitlinkCommit, pinnedArgs, pinnedEnv, runGit, splitNul,
} from './git-plumbing.mjs';

export const SNAPSHOT_FORMAT = 'chatmcp.tree-snapshot/1';
export const TREE_ALGORITHM = Object.freeze({ gitPinned: 'git-pinned-v1', raw: 'raw-v1' });
export const LIMITS = Object.freeze({
  maxFiles: 200_000,
  maxBytes: 2 * 1024 * 1024 * 1024,
  maxNewBlobs: 3_000,
  // A file whose modification time is this close to the moment its stat was cached is hashed again next time: a write in the same
  // tick of a coarse clock (2 s on FAT) would otherwise leave size and time unchanged.
  racyWindowMs: 2_000,
});
export const RUNS_FOLDER = '.chatmcp/runs';
/** What a snapshot does not see; recorded on every snapshot so a reader never assumes more. */
export const LIMITATION = Object.freeze({
  ignoredPaths: 'untracked-ignored-paths-not-covered',
  ignoreRulesNotApplied: 'ignore-rules-not-applied',
  countsFromLastFull: 'counts-from-last-full-snapshot',
});

// ---------------------------------------------------------------------------------------------------------------------
// Exclusion patterns for Git (pathspec globs, case-insensitive); tests/verify-proof-tree.mjs keeps them equal to PRIVATE_FILE
// ---------------------------------------------------------------------------------------------------------------------

/** Globs for `prefix` followed by any text that is not one of `words` (the negative look-ahead of `.env(?!.example$)`). */
function complementGlobs(prefix, words) {
  const trie = { terminal: false, children: new Map() };
  for (const word of words) {
    let node = trie;
    for (const char of word) {
      if (!node.children.has(char)) node.children.set(char, { terminal: false, children: new Map() });
      node = node.children.get(char);
    }
    node.terminal = true;
  }
  const globs = [];
  const walk = (node, text) => {
    if (!node.terminal) globs.push(`${prefix}${text}`);
    const next = [...node.children.keys()];
    globs.push(next.length ? `${prefix}${text}[!${next.join('')}]*` : `${prefix}${text}?*`);
    for (const [char, child] of node.children) walk(child, `${text}${char}`);
  };
  walk(trie, '');
  return globs;
}

const TFSTATE_DIGITS = 9;

/** Name globs (one path segment, lower case) that together match exactly the names PRIVATE_FILE matches, see docs/PROOF-TREE.md. */
export function privateFileGlobs() {
  const globs = ['.env', ...complementGlobs('.env.', ['example', 'sample', 'template', 'dist', 'default', 'defaults'])];
  for (const key of ['rsa', 'dsa', 'ecdsa', 'ed25519']) globs.push(`id_${key}`, `id_${key}.*`);
  for (const ext of ['pem', 'p12', 'pfx', 'key', 'keystore', 'jks', 'ppk']) globs.push(`*.${ext}`);
  globs.push('credentials', 'credentials.json', 'credentials.toml');
  for (const stem of ['secret', 'secrets']) for (const ext of ['json', 'yml', 'yaml', 'toml', 'tfvars', 'auto.tfvars']) globs.push(`${stem}.${ext}`);
  for (const name of ['npmrc', 'pypirc', 'netrc', 'git-credentials', 'htpasswd', 'pgpass', 'dockercfg', 'vault-token', 'terraformrc']) globs.push(`.${name}`);
  globs.push('_netrc', 'terraform.rc', 'credentials.tfrc.json');
  // `.tfstate` with an optional `.<digits>` and an optional `.backup`; a glob cannot say "one or more digits", so up to nine are
  // written out and ten or more are matched by a prefix (an over-match: such a name is protected although PRIVATE_FILE says no).
  for (const tail of ['', '.backup']) {
    globs.push(`*.tfstate${tail}`);
    for (let count = 1; count <= TFSTATE_DIGITS; count += 1) globs.push(`*.tfstate.${'[0-9]'.repeat(count)}${tail}`);
  }
  globs.push(`*.tfstate.${'[0-9]'.repeat(TFSTATE_DIGITS + 1)}*`);
  for (const join of ['', '-', '_']) for (const key of ['', 'key', '-key', '_key']) for (const tail of ['', '[-_.]*']) globs.push(`service${join}account${key}${tail}.json`);
  globs.push('application_default_credentials.json', 'kubeconfig', 'kubeconfig.yml', 'kubeconfig.yaml', '*.kubeconfig');
  return globs;
}

/** A glob that matches regardless of case without relying on core.ignorecase: every letter becomes a class of both cases. */
export function caseless(glob) {
  let out = '';
  let inClass = false;
  for (const char of glob) {
    const lower = char.toLowerCase();
    const upper = char.toUpperCase();
    if (char === '[') inClass = true;
    else if (char === ']') inClass = false;
    if (lower === upper) out += char;
    else out += inClass ? `${lower}${upper}` : `[${lower}${upper}]`;
  }
  return out;
}

/**
 * The lines of the exclude file (gitignore syntax, given to Git as core.excludesFile) that keeps protected files and `.chatmcp/runs`
 * out of the temporary index. A .gitignore of the workspace can re-include one with "!", so this file only keeps secrets from being
 * hashed; the tree itself is filtered with exclusionOf() (see TreeSnapshotter.indexTree).
 */
export function excludeLines() {
  const names = privateFileGlobs().map(caseless);
  // A name glob is about files; in gitignore syntax it would also hide a folder of that name ("docs/secrets.json/readme"), so every
  // folder is let back in. Later lines win, and the rows below protect folders on purpose.
  const lines = [...names, ...names.map((glob) => `!${glob}/`)];
  for (const folder of PRIVATE_DIRECTORIES) if (folder !== '.git') lines.push(caseless(folder));
  for (const row of PRIVATE_LOCATIONS) lines.push(`**/${caseless(row.join('/'))}`);
  lines.push(`**/${caseless('.chatmcp/hooks.json')}`, `/${caseless(RUNS_FOLDER)}`);
  return lines;
}

const inRunsFolder = (relative) => {
  const lower = relative.toLowerCase();
  return lower === RUNS_FOLDER || lower.startsWith(`${RUNS_FOLDER}/`);
};

/** Why a path is left out of the tree, or null when it belongs in it. */
export function exclusionOf(relative) {
  if (inRunsFolder(relative)) return 'runs';
  if (isProtectedPath(relative)) return 'protected';
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// The snapshotter
// ---------------------------------------------------------------------------------------------------------------------

const fault = (code, message) => Object.assign(new Error(message), { code });
const STAT_CONCURRENCY = 64;
const READ_CONCURRENCY = 32;

/** Maps `items` through `task` with at most `limit` running at once; the results keep the order of the items. */
async function inParallel(items, limit, signal, task) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      signal?.throwIfAborted();
      results[index] = await task(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
const REPOSITORY_PROGRAMS = new Set(['filter', 'fsmonitor', 'diff-driver']);

/**
 * Takes snapshots of one workspace. Calls are serialised; a snapshot never throws for a property of the workspace (it falls back
 * to raw-v1 and records why), only for bad arguments, cancellation or an unreadable root.
 */
export class TreeSnapshotter {
  /**
   * @param {string} options.root       the workspace folder
   * @param {string} options.stateDir   a private folder of the Hub (temporary index, private objects, empty config)
   * @param {string|null} [options.git] path of Git, `null` for none; PATH when left out
   * @param {object} [options.env]      the environment Git would inherit (its GIT_* variables are dropped)
   * @param {'auto'|'git-pinned-v1'|'raw-v1'} [options.engine]
   * @param {Partial<typeof LIMITS>} [options.limits]
   */
  constructor({ root, stateDir, git, env = process.env, engine = 'auto', limits = {} } = {}) {
    if (!root || !stateDir) throw new TypeError('TreeSnapshotter needs root and stateDir');
    if (!['auto', TREE_ALGORITHM.gitPinned, TREE_ALGORITHM.raw].includes(engine)) throw new TypeError(`unknown engine: ${engine}`);
    this.root = path.resolve(root);
    this.stateDir = path.resolve(stateDir);
    this.gitOption = git;
    this.env = env;
    this.engine = engine;
    this.limits = { ...LIMITS, ...limits };
    this.queue = Promise.resolve();
    this.rawCache = null; // Map(path -> {size, mtimeMs, ctimeMs, ino, mode, oid}) plus takenAt
    this.gitIndexReady = false;
    this.unresolvedGitlinks = [];
    this.lastFull = null;
    this.lastEntries = null; // the rows the last tree was built from, for snapshot({entries: true})
  }

  /**
   * @param {{full?: boolean, signal?: AbortSignal, entries?: boolean}} [options] full: bypass every cache and compute rawTree too;
   *   entries: also return `entries`, the rows {path, mode, oid} the tree was built from (null without a tree; the baseline store of
   *   lib/proof/baseline.mjs needs them). Left out, the snapshot has no `entries` field at all.
   * @returns {Promise<object>} see docs/PROOF-TREE.md ("The snapshot")
   */
  snapshot({ full = false, signal = null, entries = false } = {}) {
    const run = this.queue.then(() => this.take(Boolean(full), signal, Boolean(entries)));
    this.queue = run.catch(() => {});
    return run;
  }

  async take(full, signal, withEntries = false) {
    signal?.throwIfAborted();
    const started = Date.now();
    const rootStat = await fs.stat(this.root).catch(() => null);
    if (!rootStat?.isDirectory()) throw fault('root_unreadable', `workspace folder not found: ${this.root}`);
    const plan = await this.plan();
    let result;
    if (full || !this.lastFull) result = await this.fullSnapshot(plan, signal);
    else if (plan.engine === TREE_ALGORITHM.gitPinned && this.gitIndexReady && this.lastFull.treeAlgorithm === TREE_ALGORITHM.gitPinned) {
      result = await this.cachedGit(plan, signal).catch(async (error) => {
        if (error?.code === 'cancelled' || signal?.aborted) throw error;
        return this.fullSnapshot(plan, signal); // a failed cached call starts over from scratch
      });
    } else result = await this.rawSnapshot(plan, signal, { full: false, reason: plan.engine === TREE_ALGORITHM.raw ? plan.reason : this.lastFull.engineReason });
    const taken = { ...result, takenAt: new Date(started).toISOString(), durationMs: Date.now() - started };
    if (withEntries) taken.entries = result.status === 'ok' ? this.lastEntries : null;
    return taken;
  }

  /** Which engine may run, and why not Git. Reads the repository's own configuration every time: it can change between calls. */
  async plan() {
    const located = await locateGitDirectories(this.root);
    const base = { exe: null, gitDir: located?.gitDir ?? null, commonDir: located?.commonDir ?? null, objectFormat: 'sha1', fileMode: process.platform !== 'win32', gitListing: false };
    if (!located || !located.gitDir) return { ...base, engine: TREE_ALGORITHM.raw, reason: located ? 'repository_unreadable' : 'not_a_repository' };
    const settings = await this.repositorySettings(located);
    Object.assign(base, settings);
    const safety = await inspectGitSafety(this.root, { hooks: false });
    const refused = refusalsForRunner(safety);
    if (safety.unreadable || refused.length) return { ...base, engine: TREE_ALGORITHM.raw, reason: `repository_config_refused:${refused.join(',') || 'unreadable'}` };
    const exe = await this.usableGit();
    if (!exe) return { ...base, engine: TREE_ALGORITHM.raw, reason: 'git_missing' };
    // Git may list files from here on (ls-files reads no content and runs no filter); whether it may hash them is decided next.
    const ready = { ...base, exe, gitListing: true };
    const programs = safety.risks.filter((risk) => REPOSITORY_PROGRAMS.has(risk.kind)).map((risk) => risk.key);
    if (settings.filters.length || programs.length) return { ...ready, engine: TREE_ALGORITHM.raw, reason: `repository_programs:${[...new Set([...settings.filters, ...programs])].join(',')}` };
    if (this.engine === TREE_ALGORITHM.raw) return { ...ready, engine: TREE_ALGORITHM.raw, reason: 'engine_forced' };
    return { ...ready, engine: TREE_ALGORITHM.gitPinned, reason: null };
  }

  /** The Git program if it starts (`git --version`, once per snapshotter), else null. */
  async usableGit() {
    this.gitChecked ??= (async () => {
      const exe = await findGit(this.gitOption);
      if (!exe) return null;
      const probe = await runGit(exe, ['--version'], { env: scrubEnv(this.env ?? {}), timeoutMs: 20_000 }).catch(() => null);
      return probe?.code === 0 && /^git version /.test(probe.stdout.toString('utf8')) ? exe : null;
    })();
    return this.gitChecked;
  }

  /** Settings of the repository that change the tree: object format, executable bit, and every filter (Git LFS included). */
  async repositorySettings({ gitDir, commonDir }) {
    const entries = [];
    for (const file of [path.join(commonDir, 'config'), path.join(gitDir, 'config.worktree')]) {
      const text = await fs.readFile(file, 'utf8').catch(() => '');
      entries.push(...parseGitConfig(text));
    }
    const last = (section, key) => entries.filter((entry) => entry.section === section && !entry.subsection && entry.key === key).at(-1);
    const format = String(last('extensions', 'objectformat')?.value ?? 'sha1').toLowerCase();
    const fileModeEntry = last('core', 'filemode');
    const fileMode = fileModeEntry ? !/^(?:false|no|off|0)$/i.test(String(fileModeEntry.value ?? 'true')) : process.platform !== 'win32';
    const filters = entries.filter((entry) => entry.section === 'filter' && entry.subsection && ['clean', 'smudge', 'process'].includes(entry.key) && entry.value)
      .map((entry) => `filter.${entry.subsection}.${entry.key}`);
    return { objectFormat: format === 'sha256' ? 'sha256' : 'sha1', fileMode: fileMode && process.platform !== 'win32', filters: [...new Set(filters)] };
  }

  async gitPlaces(plan, indexFile, { excludes = true, objectDirectory: readOnlyObjects = null } = {}) {
    const objectDirectory = readOnlyObjects ?? path.join(this.stateDir, 'objects');
    if (!readOnlyObjects) await ensureObjectDirectory(objectDirectory);
    const emptyConfig = path.join(this.stateDir, 'empty.gitconfig');
    await fs.writeFile(emptyConfig, '', { flag: 'a' });
    const hooks = path.join(this.stateDir, 'no-hooks');
    await fs.mkdir(hooks, { recursive: true });
    const excludeFile = path.join(this.stateDir, 'exclude');
    await fs.writeFile(excludeFile, `${excludeLines().join('\n')}\n`);
    // No alternate object directory on purpose: Git "freshens" an object it finds in an alternate (it rewrites the modification time of
    // the loose object or of the whole pack), which is a write to the repository's store. The private store starts empty, a full
    // snapshot writes no blob (update-index --index-info + --refresh), and the tree is built here from `ls-files -s`, not by write-tree.
    const env = pinnedEnv(this.env, { gitDir: plan.gitDir, workTree: this.root, indexFile, objectDirectory, emptyConfig });
    // Both files are always named: left unset, Git reads the person's ~/.config/git/ignore and ~/.config/git/attributes, which no
    // environment variable switches off.
    const prefix = [...pinnedArgs(hooks), '-c', `core.excludesFile=${(excludes ? excludeFile : emptyConfig).replaceAll('\\', '/')}`,
      '-c', `core.attributesFile=${emptyConfig.replaceAll('\\', '/')}`];
    const git = async (args, { allowFailure = false, ...options } = {}) => {
      const result = await runGit(plan.exe, [...prefix, ...args], { cwd: this.root, env, ...options });
      if (result.code !== 0 && !allowFailure) throw fault('git_failed', `git ${args[0]} exited ${result.code}: ${result.stderr.split('\n').find(Boolean) ?? ''}`.trim());
      return result;
    };
    return { git, env, objectDirectory };
  }

  /**
   * The paths the repository tracks, read (never written) from its own index; from HEAD when it has no index. Kept while the index file
   * keeps its size, time and inode. `{paths: string[], set: Set<string>}`; empty when Git cannot read either.
   */
  async trackedPaths(plan, signal) {
    const indexFile = path.join(plan.gitDir, 'index');
    const stat = await fs.stat(indexFile).catch(() => null);
    const key = stat ? `${stat.size}:${stat.mtimeMs}:${stat.ino}` : 'no-index';
    if (this.tracked?.key === key) return this.tracked;
    let listed = [];
    if (stat) {
      const { git } = await this.gitPlaces(plan, indexFile, { excludes: false });
      listed = splitNul((await git(['ls-files', '-z', '--cached'], { signal, allowFailure: true })).stdout);
    } else {
      // no index yet (a clone without checkout, say): the tree of HEAD, read from the repository's objects (reading freshens nothing)
      const { git } = await this.gitPlaces(plan, path.join(this.stateDir, `head-${randomUUID()}.index`), { excludes: false, objectDirectory: path.resolve(plan.commonDir, 'objects') });
      listed = splitNul((await git(['ls-tree', '-r', '-z', '--name-only', '--full-tree', 'HEAD'], { signal, allowFailure: true })).stdout);
    }
    const set = new Set(listed);
    this.tracked = { key, paths: [...set], set };
    return this.tracked;
  }

  /** The files of the workspace, relative with "/" (a nested repository ends with "/"), with Git's ignore rules when Git may list. */
  async listFiles(plan, signal) {
    if (plan.gitListing) {
      const scratch = path.join(this.stateDir, `list-${randomUUID()}.index`);
      try {
        const { git } = await this.gitPlaces(plan, scratch, { excludes: false }); // the listing names protected files so that they are counted
        const result = await git(['ls-files', '-z', '--others', '--exclude-standard'], { signal });
        // Ignore rules apply to untracked files only: what the repository tracks is listed whatever .gitignore says
        const others = splitNul(result.stdout);
        const listed = new Set(others);
        const paths = [...others];
        for (const file of (await this.trackedPaths(plan, signal)).paths) if (!listed.has(file) && !listed.has(`${file}/`)) { listed.add(file); paths.push(file); }
        return { paths, ignoreRules: 'git' };
      } finally { await fs.rm(scratch, { force: true }); }
    }
    const paths = [];
    const walk = async (relative) => {
      signal?.throwIfAborted();
      const entries = await fs.readdir(path.join(this.root, relative), { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.name === '.git') continue;
        const child = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (await fs.lstat(path.join(this.root, child, '.git')).then(() => true, () => false)) paths.push(`${child}/`);
          else await walk(child);
        } else paths.push(child);
        if (paths.length > this.limits.maxFiles + 1) return;
      }
    };
    await walk('');
    return { paths, ignoreRules: 'none' };
  }

  /** Lists, excludes, stats and hashes (reusing the stat cache unless `full`), then builds the raw tree. */
  async rawPass(plan, signal, { full }) {
    const { paths, ignoreRules } = await this.listFiles(plan, signal);
    const excluded = { protected: 0, runs: 0, gitlinks: 0 };
    const files = [];
    const unresolved = [];
    let bytes = 0;
    const cache = full ? null : this.rawCache;
    const nextCache = new Map();
    const takenAt = Date.now();
    const kept = [];
    for (const listed of paths) {
      const isGitlink = listed.endsWith('/');
      const relative = isGitlink ? listed.slice(0, -1) : listed;
      const why = exclusionOf(relative);
      if (why) excluded[why] += 1;
      else kept.push({ relative, isGitlink });
    }
    if (kept.length > this.limits.maxFiles) return { unbounded: 'files', excluded, ignoreRules };
    // stat everything first (so a workspace over the byte limit is not read), then hash what the cache cannot vouch for
    const stats = await inParallel(kept, STAT_CONCURRENCY, signal, async ({ relative, isGitlink }) => {
      const absolute = path.join(this.root, relative);
      if (isGitlink) return { relative, absolute, isGitlink };
      const stat = await fs.lstat(absolute).catch(() => null);
      if (!stat) return null; // removed while we looked
      if (stat.isSymbolicLink()) return { relative, absolute, stat, mode: MODE.symlink };
      if (stat.isFile()) return { relative, absolute, stat, mode: plan.fileMode && (stat.mode & 0o100) ? MODE.executable : MODE.file };
      return null;
    });
    for (const row of stats) if (row?.stat) bytes += row.stat.size;
    if (bytes > this.limits.maxBytes) return { unbounded: 'bytes', excluded, ignoreRules };
    const hashed = await inParallel(stats, READ_CONCURRENCY, signal, async (row) => {
      if (!row) return null;
      const { relative, absolute, stat, mode } = row;
      if (row.isGitlink) {
        const commit = await gitlinkCommit(absolute);
        if (!commit || commit.length !== (plan.objectFormat === 'sha256' ? 64 : 40)) return { relative, unresolved: true };
        return { file: { path: relative, mode: MODE.gitlink, oid: commit } };
      }
      const known = cache?.get(relative);
      const trusted = known && known.size === stat.size && known.mtimeMs === stat.mtimeMs && known.ctimeMs === stat.ctimeMs && known.ino === stat.ino
        && known.mode === mode && known.mtimeMs < cache.takenAt - this.limits.racyWindowMs;
      let oid;
      if (trusted) oid = known.oid;
      else if (mode === MODE.symlink) {
        const target = await fs.readlink(absolute).catch(() => null);
        if (target === null) return null;
        oid = blobId(Buffer.from(process.platform === 'win32' ? target.replaceAll('\\', '/') : target, 'utf8'), plan.objectFormat);
      } else {
        const content = await fs.readFile(absolute).catch(() => null);
        if (content === null) return null;
        oid = blobId(content, plan.objectFormat);
      }
      return { file: { path: relative, mode, oid }, cached: { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino, mode, oid } };
    });
    for (const row of hashed) {
      if (!row) continue;
      if (row.unresolved) { excluded.gitlinks += 1; unresolved.push(row.relative); continue; }
      files.push(row.file);
      if (row.cached) nextCache.set(row.file.path, row.cached);
    }
    this.rawCache = Object.assign(nextCache, { takenAt });
    this.unresolvedGitlinks = unresolved;
    return { files, bytes, excluded, ignoreRules, tree: buildTree(files, plan.objectFormat) };
  }

  describe(plan, { status = 'ok', treeAlgorithm, tree = null, rawTree = null, full, reason, pass }) {
    const counted = Array.isArray(pass?.files);
    const fromLast = !counted && !pass?.unbounded;
    const limitations = [pass?.ignoreRules === 'none' ? LIMITATION.ignoreRulesNotApplied : LIMITATION.ignoredPaths];
    if (fromLast) limitations.push(LIMITATION.countsFromLastFull);
    return {
      format: SNAPSHOT_FORMAT,
      status,
      treeAlgorithm: status === 'ok' ? treeAlgorithm : null,
      tree: status === 'ok' ? tree : null,
      rawTree: status === 'ok' && full ? rawTree : null,
      objectFormat: plan.objectFormat,
      full,
      engineReason: reason ?? null,
      ignoreRules: pass?.ignoreRules ?? 'git',
      files: counted ? pass.files.length : fromLast ? (this.lastFull?.files ?? null) : null,
      bytes: counted ? pass.bytes : fromLast ? (this.lastFull?.bytes ?? null) : null,
      excluded: pass?.excluded ?? (fromLast ? this.lastFull?.excluded ?? null : null),
      limits: { maxFiles: this.limits.maxFiles, maxBytes: this.limits.maxBytes },
      limitations,
      ...(pass?.unbounded ? { unbounded: pass.unbounded } : {}),
    };
  }

  async rawSnapshot(plan, signal, { full, reason }) {
    const pass = await this.rawPass(plan, signal, { full });
    if (pass.unbounded) return this.describe(plan, { status: 'unbounded', full, reason, pass: { ...pass, files: null } });
    this.lastEntries = pass.files;
    const result = this.describe(plan, { treeAlgorithm: TREE_ALGORITHM.raw, tree: pass.tree, rawTree: pass.tree, full, reason, pass });
    if (full) { this.lastFull = result; this.gitIndexReady = false; }
    return result;
  }

  async fullSnapshot(plan, signal) {
    if (plan.engine !== TREE_ALGORITHM.gitPinned) return this.rawSnapshot(plan, signal, { full: true, reason: plan.reason });
    const pass = await this.rawPass(plan, signal, { full: true });
    if (pass.unbounded) {
      const result = this.describe(plan, { status: 'unbounded', full: true, reason: plan.reason, pass: { ...pass, files: null } });
      this.lastFull = result;
      return result;
    }
    const asRaw = (reason) => {
      this.lastEntries = pass.files;
      const result = this.describe(plan, { treeAlgorithm: TREE_ALGORITHM.raw, tree: pass.tree, rawTree: pass.tree, full: true, reason, pass });
      this.lastFull = result;
      this.gitIndexReady = false;
      return result;
    };
    const fresh = path.join(this.stateDir, `full-${randomUUID()}.index`);
    try {
      const { git, objectDirectory } = await this.gitPlaces(plan, fresh);
      // Seed the fresh index with the raw rows and let Git check them against the files: --refresh hashes, it writes no object. An entry
      // that still "needs update" is one that .gitattributes converts, and `add -A` must write a blob for each of them.
      const rows = pass.files.map((file) => `${file.mode} ${file.mode === MODE.gitlink ? 'commit' : 'blob'} ${file.oid}\t${file.path}\0`).join('');
      await git(['update-index', '-z', '--add', '--index-info'], { input: rows, signal });
      const refreshed = await git(['update-index', '--ignore-missing', '--refresh'], { signal, allowFailure: true });
      const differing = refreshed.stdout.toString('utf8').split('\n').filter((line) => line.endsWith(': needs update')).length;
      if (differing > this.limits.maxNewBlobs) return asRaw(`too_many_new_blobs:${differing}`);
      const tree = await this.indexTree(plan, git, objectDirectory, signal, { fresh: true });
      await fs.rename(fresh, this.cachedIndexPath());
      this.gitIndexReady = true;
      const result = this.describe(plan, { treeAlgorithm: TREE_ALGORITHM.gitPinned, tree, rawTree: pass.tree, full: true, reason: null, pass });
      this.lastFull = result;
      return result;
    } catch (error) {
      if (error?.code === 'cancelled' || signal?.aborted) throw error;
      return asRaw(`git_failed:${String(error?.code ?? 'error')}`);
    } finally { await fs.rm(fresh, { force: true }); }
  }

  cachedIndexPath() { return path.join(this.stateDir, 'cached.index'); }

  async cachedGit(plan, signal) {
    const { git, objectDirectory } = await this.gitPlaces(plan, this.cachedIndexPath());
    const tree = await this.indexTree(plan, git, objectDirectory, signal, { fresh: false });
    return this.describe(plan, { treeAlgorithm: TREE_ALGORITHM.gitPinned, tree, full: false, reason: null, pass: null });
  }

  /** The entries of the temporary index as rows {path, mode, oid}. */
  async indexEntries(git, signal) {
    const rows = [];
    for (const line of splitNul((await git(['ls-files', '-z', '--stage'], { signal })).stdout)) {
      const tab = line.indexOf('\t');
      const [mode, oid] = line.slice(0, tab).split(' ');
      rows.push({ path: line.slice(tab + 1), mode, oid });
    }
    return rows;
  }

  /** What decides Git's ignore rules: every .gitignore in the index (path and blob) and the repository's info/exclude. */
  async ignoreFingerprint(plan, entries) {
    const files = entries.filter((entry) => entry.path === '.gitignore' || entry.path.endsWith('/.gitignore')).map((entry) => `${entry.path}:${entry.oid}`);
    const info = await fs.stat(path.join(plan.commonDir, 'info', 'exclude')).catch(() => null);
    return `${files.join('|')}#${info ? `${info.size}:${info.mtimeMs}` : '-'}`;
  }

  /**
   * `add -A` (the exclude file keeps protected files out), then for a reused index drops the entries that changed ignore rules now
   * exclude, then drops any protected entry a .gitignore re-included with "!" (and its blob from the private store), and builds the tree.
   */
  async indexTree(plan, git, objectDirectory, signal, { fresh }) {
    await git(['add', '-A', '--', '.', ...this.unresolvedGitlinks.map((relative) => `:(exclude,literal)${relative}`)], { signal });
    let entries = await this.indexEntries(git, signal);
    const tracked = await this.trackedPaths(plan, signal);
    const literal = (files) => files.map((file) => `:(literal)${file}\0`).join('');
    // A file the repository tracks belongs in the tree even when an ignore rule matches it, and add -A never adds an ignored file that the
    // temporary index does not hold yet (force-added since, or deleted and written again): add those that are on disk.
    const held = new Set(entries.map((entry) => entry.path));
    const missing = [];
    for (const file of tracked.paths) {
      if (held.has(file) || exclusionOf(file)) continue;
      const stat = await fs.lstat(path.join(this.root, file)).catch(() => null);
      if (stat && (stat.isFile() || stat.isSymbolicLink())) missing.push(file);
    }
    if (missing.length) await git(['add', '-f', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: literal(missing), signal });
    // Entries that the ignore rules now exclude and the repository does not track leave the reused index.
    const fingerprint = `${await this.ignoreFingerprint(plan, entries)}#${tracked.key}`;
    let dropped = [];
    if (!fresh && fingerprint !== this.ignoreRules) {
      dropped = splitNul((await git(['ls-files', '-z', '--cached', '--ignored', '--exclude-standard'], { signal })).stdout).filter((file) => !tracked.set.has(file));
      if (dropped.length) await git(['rm', '-q', '--cached', '--ignore-unmatch', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: literal(dropped), signal });
    }
    if (missing.length || dropped.length) entries = await this.indexEntries(git, signal);
    this.ignoreRules = fingerprint;
    const leaked = entries.filter((entry) => exclusionOf(entry.path));
    if (leaked.length) {
      await git(['rm', '-q', '--cached', '--ignore-unmatch', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: leaked.map((entry) => `:(literal)${entry.path}\0`).join(''), signal });
      entries = entries.filter((entry) => !exclusionOf(entry.path));
      const kept = new Set(entries.map((entry) => entry.oid));
      for (const { oid } of leaked) if (!kept.has(oid)) await fs.rm(path.join(objectDirectory, oid.slice(0, 2), oid.slice(2)), { force: true });
    }
    this.lastEntries = entries;
    return buildTree(entries, plan.objectFormat);
  }
}

/** One full snapshot of `root` (a fresh state folder is the caller's to give and to remove). */
export async function snapshotTree(options) {
  return new TreeSnapshotter(options).snapshot({ full: true, signal: options?.signal ?? null });
}
