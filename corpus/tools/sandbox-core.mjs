// What the run sandbox (run-sandbox.mjs) and the scoring checkout (score-checkout.mjs) share (corpus/SANDBOX.md):
//
//   the run folder     <root>/<8 hex>/{w, b, h, s}: the work tree, the private base store, the profile, the scratch folder; a short
//                      root (C:\cmr) and a path budget checked before anything is checked out; removed after every run and failure
//   the base           the task's repository (a local Git source holding the commit, or the task's tarball) as one tree in the private
//                      store and one baseline commit with a fixed author and date: the same commit for the same tree, from either source
//   raw bytes          every Git process here runs without the person's configuration, hooks or GIT_* variables, with attributes read
//                      from the empty tree (GIT_ATTR_SOURCE): no line-end conversion or filter, so a file on disk is its blob, byte for byte
//   the profile        fresh HOME, APPDATA, XDG, CODEX_HOME and CLAUDE_CONFIG_DIR folders; a short allow-list of inherited variables
//   the process trees  every process started here is killed with its tree; what outlives its parent is found and killed afterwards
//
// It never contacts a network: the Git source is a local repository the owner prepared, and no remote command is ever run.
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ShellRunner, pinnedArgs, pinnedEnv, processTreeLeft, runGit, scrubEnv, treeId, windowsProcessTree } from './hub-process.mjs';
import { TarError, readTar } from './tar.mjs';

/** MAX_PATH less its terminating NUL: the longest path many Windows programs (and older npm, cmd.exe) can open. */
export const MAX_PATH_WINDOWS = 259;
export const ROOT_VARIABLE = 'DATGOLD_CORPUS_SANDBOX_ROOT';
/** GIT_ATTR_SOURCE, which turns the work tree's .gitattributes off, came with Git 2.42. */
export const GIT_MIN_VERSION = Object.freeze([2, 42]);
export const RUN_ID = /^[0-9a-f]{8}$/;
export const BASE_REF = 'refs/datgold/base';
const IMPORT_REF = 'refs/datgold/import';
/** The baseline commit: one parent-less commit per tree, whatever the source and the day. */
export const BASELINE_IDENTITY = Object.freeze({
  GIT_AUTHOR_NAME: 'DatGold Corpus', GIT_AUTHOR_EMAIL: 'baseline@corpus.datgold.invalid', GIT_AUTHOR_DATE: '946684800 +0000',
  GIT_COMMITTER_NAME: 'DatGold Corpus', GIT_COMMITTER_EMAIL: 'baseline@corpus.datgold.invalid', GIT_COMMITTER_DATE: '946684800 +0000',
});
export const BASELINE_MESSAGE = 'baseline\n';
/** The flags of the agent's diff: nothing of the person's or the repository's configuration is read, renames are not guessed. */
export const DIFF_ARGS = Object.freeze(['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--binary', '--full-index', '--no-renames',
  '--diff-algorithm=myers', '--src-prefix=a/', '--dst-prefix=b/', '--no-relative', '--submodule=short', '--ignore-submodules=none']);
export const SANDBOX_LIMITS = Object.freeze({ maxPatchBytes: 128 * 1024 * 1024, gitTimeoutMs: 600_000, setupTimeoutSeconds: 900, outputTailChars: 4000 });

/** The profile of a run: every variable that names a folder of the agent's own, and the file Git reads as its global configuration. */
export const PROFILE_VARIABLES = Object.freeze([
  { name: 'HOME', folder: 'home' },
  { name: 'USERPROFILE', folder: 'home' },
  { name: 'APPDATA', folder: 'appdata' },
  { name: 'LOCALAPPDATA', folder: 'local' },
  { name: 'XDG_CONFIG_HOME', folder: 'config' },
  { name: 'XDG_DATA_HOME', folder: 'data' },
  { name: 'XDG_CACHE_HOME', folder: 'cache' },
  { name: 'XDG_STATE_HOME', folder: 'state' },
  { name: 'CODEX_HOME', folder: 'codex' },
  { name: 'CLAUDE_CONFIG_DIR', folder: 'claude' },
  { name: 'TEMP', folder: 'tmp' },
  { name: 'TMP', folder: 'tmp' },
  { name: 'TMPDIR', folder: 'tmp' },
  { name: 'GIT_CONFIG_GLOBAL', file: 'home/.gitconfig' },
  { name: 'GIT_CONFIG_NOSYSTEM', value: '1' },
  { name: 'GIT_TERMINAL_PROMPT', value: '0' },
  { name: 'GCM_INTERACTIVE', value: 'never' },
  { name: 'GIT_CEILING_DIRECTORIES', run: true },
].map(Object.freeze));
/** The only variables a run inherits from the environment it was started in (names compared without case on Windows). */
export const INHERITED_VARIABLES = Object.freeze({
  win32: Object.freeze(['PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'OS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER',
    'PROCESSOR_LEVEL', 'PROCESSOR_REVISION', 'NUMBER_OF_PROCESSORS', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'COMMONPROGRAMFILES',
    'COMMONPROGRAMFILES(X86)', 'COMMONPROGRAMW6432', 'USERNAME', 'LANG', 'TZ', 'TERM']),
  posix: Object.freeze(['PATH', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'TZ', 'TERM', 'USER', 'LOGNAME', 'SHELL']),
});
/** The global Git configuration of a profile: an identity for the agent's commits, no line-end conversion, no credential helper. */
export const PROFILE_GITCONFIG = '[user]\n\tname = DatGold Corpus Agent\n\temail = agent@corpus.datgold.invalid\n[core]\n\tautocrlf = false\n[credential]\n\thelper =\n[init]\n\tdefaultBranch = main\n';

export const SANDBOX_CODES = Object.freeze(['bad_argument', 'bad_agent_env', 'bad_seed_path', 'git_too_old', 'git_failed', 'git_source_required',
  'base_missing', 'tarball_mismatch', 'tarball_invalid', 'path_too_long', 'setup_failed', 'setup_changed_tree', 'agent_failed_to_start',
  'patch_not_reproducible', 'cancelled', 'hidden_archive_missing', 'hidden_archive_mismatch', 'hidden_archive_invalid', 'no_checks']);

export class SandboxError extends Error {
  constructor(code, message, details = {}) {
    super(`${message} [${code}]`);
    this.name = 'SandboxError';
    this.code = code;
    Object.assign(this, details);
  }
}

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const firstLine = (text) => String(text ?? '').split('\n').map((line) => line.trim()).find(Boolean) ?? '';
const tail = (text) => (text.length > SANDBOX_LIMITS.outputTailChars ? text.slice(-SANDBOX_LIMITS.outputTailChars) : text);

/** <SystemDrive>\cmr on Windows, /tmp/cmr elsewhere; DATGOLD_CORPUS_SANDBOX_ROOT wins. */
export function defaultSandboxRoot({ platform = process.platform, env = process.env } = {}) {
  if (env[ROOT_VARIABLE]) return env[ROOT_VARIABLE];
  return platform === 'win32' ? `${env.SystemDrive ?? env.SYSTEMDRIVE ?? 'C:'}\\cmr` : '/tmp/cmr';
}
export const defaultMaxPath = (platform = process.platform) => (platform === 'win32' ? MAX_PATH_WINDOWS : 4095);

/** Throws path_too_long when `prefix` + a separator + the longest of `paths` is longer than `maxPath`. */
export function checkPathBudget({ prefix, paths, maxPath }) {
  let longest = null;
  for (const file of paths) if (longest === null || file.length > longest.length) longest = file;
  if (longest === null) return;
  const length = prefix.length + 1 + longest.length;
  if (length > maxPath) {
    throw new SandboxError('path_too_long', `${longest} would be ${length} characters long under ${prefix} (the budget is ${maxPath}); choose a shorter sandbox root`, { path: longest, length, maxPath });
  }
}

/** Creates <root>/<8 hex> with its four folders; the name is taken with an exclusive mkdir. */
export async function makeRunFolder(root) {
  await fs.mkdir(root, { recursive: true });
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const id = randomBytes(4).toString('hex');
    const dir = path.join(root, id);
    try { await fs.mkdir(dir); } catch (error) { if (error?.code === 'EEXIST') continue; throw error; }
    const layout = { id, dir, work: path.join(dir, 'w'), store: path.join(dir, 'b'), profile: path.join(dir, 'h'), scratch: path.join(dir, 's') };
    for (const folder of [layout.work, layout.profile, path.join(layout.scratch, 'hooks'), path.join(layout.scratch, 'template')]) await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(layout.scratch, 'empty.gitconfig'), '');
    return layout;
  }
  throw new SandboxError('bad_argument', `no free run folder name under ${root}`);
}

/** Removes a run folder (read-only pack files and a folder a dying process still held are retried). */
export async function removeRunFolder(dir) {
  try {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch (error) {
    return { removed: false, error: error.message };
  }
  const left = await fs.lstat(dir).then(() => true, () => false);
  return left ? { removed: false, error: `${dir} is still there` } : { removed: true };
}

/**
 * Kills what is left of process trees whose roots ({pid, spawnedAt}) were started here. POSIX: each root led its own process group, which
 * is signalled as a whole. Windows: the process table is read and every process whose parent chain (parent pid plus creation time, see
 * processTreeLeft) leads to a root is killed with its tree, a few rounds; `leftovers` lists the pids still alive after the last round.
 */
export async function reapTrees(roots, { platform = process.platform, processTree = windowsProcessTree, rounds = 3 } = {}) {
  const started = roots.filter((root) => Number.isInteger(root?.pid));
  if (!started.length) return { leftovers: [] };
  if (platform !== 'win32') {
    for (const root of started) { try { process.kill(-root.pid, 'SIGKILL'); } catch { /* the group is gone */ } }
    return { leftovers: [] };
  }
  for (let round = 0; ; round += 1) {
    const rows = await processTree.list();
    if (!rows) return { leftovers: null };
    const left = new Map();
    for (const root of started) for (const row of processTreeLeft(rows, root.pid, root.spawnedAt) ?? []) left.set(row.pid, row);
    if (!left.size) return { leftovers: [] };
    if (round === rounds) return { leftovers: [...left.keys()] };
    for (const pid of left.keys()) await processTree.kill(pid);
  }
}

// ---- Git ---------------------------------------------------------------------------------------------------------------------------

const versions = new Map();
/** A Git runner pinned to the folders of one run (its scratch folder holds the empty configuration and the empty hooks folder). */
export async function openGit({ exe = 'git', env = process.env } = {}) {
  if (!versions.has(exe)) versions.set(exe, runGit(exe, ['--version'], { env: scrubEnv(env), timeoutMs: 30_000 }).then((result) => result.stdout.toString('utf8'), () => ''));
  const text = await versions.get(exe);
  const match = /git version (\d+)\.(\d+)/.exec(text);
  if (!match) throw new SandboxError('git_failed', `${exe} is not a Git program that runs here`);
  const [major, minor] = [Number(match[1]), Number(match[2])];
  if (major < GIT_MIN_VERSION[0] || (major === GIT_MIN_VERSION[0] && minor < GIT_MIN_VERSION[1])) {
    throw new SandboxError('git_too_old', `${firstLine(text)} is older than Git ${GIT_MIN_VERSION.join('.')}, which the sandbox needs (GIT_ATTR_SOURCE)`);
  }
  return { exe, env, version: firstLine(text) };
}

/**
 * Runs Git for a run. `gitDir` is the repository, `workTree` and `indexFile` only when given; the scratch folder of `layout` holds the empty
 * configuration (global, excludes and attributes files) and the hooks folder. Attributes come from the empty tree. Throws git_failed on a
 * non-zero exit unless `allowFail`.
 */
async function git(context, layout, args, { gitDir, workTree = null, indexFile = null, input = null, objectFormat = 'sha1', allowFail = false, maxBytes, cwd, attributes = true } = {}) {
  const empty = path.join(layout.scratch, 'empty.gitconfig');
  const env = pinnedEnv(context.env, { gitDir: gitDir ?? layout.scratch, workTree: workTree ?? layout.scratch, indexFile: indexFile ?? path.join(layout.scratch, 'none.index'), objectDirectory: layout.scratch, emptyConfig: empty });
  delete env.GIT_OBJECT_DIRECTORY;
  if (!gitDir) delete env.GIT_DIR;
  if (!workTree) delete env.GIT_WORK_TREE;
  if (!indexFile) delete env.GIT_INDEX_FILE;
  if (attributes) env.GIT_ATTR_SOURCE = treeId([], objectFormat);
  Object.assign(env, BASELINE_IDENTITY);
  const unixModes = process.platform !== 'win32';
  const result = await runGit(context.exe, [...pinnedArgs(path.join(layout.scratch, 'hooks')), '-c', `core.excludesFile=${empty.replaceAll('\\', '/')}`,
    '-c', `core.attributesFile=${empty.replaceAll('\\', '/')}`, '-c', `core.fileMode=${unixModes}`, '-c', `core.symlinks=${unixModes}`, ...args],
  { cwd: cwd ?? workTree ?? gitDir ?? layout.scratch, env, input, timeoutMs: SANDBOX_LIMITS.gitTimeoutMs, ...(maxBytes ? { maxBytes } : {}) });
  if (result.code !== 0 && !allowFail) throw new SandboxError('git_failed', `git ${args[0]} exited ${result.code}: ${firstLine(result.stderr)}`);
  return result;
}
const text = (result) => result.stdout.toString('utf8').trim();

/** The Git directory of a local source: <source>/.git when it is a folder, else the source itself (a bare repository). */
async function sourceGitDir(source) {
  const dotGit = path.join(source, '.git');
  const stat = await fs.stat(dotGit).catch(() => null);
  return stat?.isDirectory() ? dotGit : source;
}

/**
 * Where the base of `task` comes from, read without writing: {kind: 'git', gitDir, commit, tree, objectFormat, paths} for a Git task (the
 * commit must be in the local source), {kind: 'tarball', files, objectFormat, paths} for a tarball task (its sha256 checked again here).
 */
export async function inspectBase({ task, gitSource, context, layout }) {
  const repo = task.task.repo;
  if (repo.tarball) {
    const file = path.join(task.dir, repo.tarball.file);
    const bytes = await fs.readFile(file);
    if (sha256(bytes) !== repo.tarball.sha256) throw new SandboxError('tarball_mismatch', `${repo.tarball.file} has the sha256 ${sha256(bytes)}, task.yml says ${repo.tarball.sha256}`);
    let files;
    try { files = readTar(bytes); } catch (error) {
      if (!(error instanceof TarError)) throw error;
      throw new SandboxError('tarball_invalid', `${repo.tarball.file}: ${error.message}`, { tarCode: error.code });
    }
    return { kind: 'tarball', files, objectFormat: 'sha1', paths: files.map((entry) => entry.path) };
  }
  if (typeof gitSource !== 'string' || !gitSource) {
    throw new SandboxError('git_source_required', `the task's repository is a Git commit: give a local repository that holds ${repo.git.commit} (the corpus tools never fetch)`);
  }
  const gitDir = await sourceGitDir(path.resolve(gitSource));
  const objectFormat = repo.git.commit.length === 64 ? 'sha256' : 'sha1';
  const options = { gitDir, objectFormat, allowFail: true, cwd: layout.scratch };
  const resolved = await git(context, layout, ['rev-parse', `${repo.git.commit}^{commit}`, `${repo.git.commit}^{tree}`], options);
  const [commit, tree] = text(resolved).split(/\s+/);
  if (resolved.code !== 0 || commit !== repo.git.commit || !tree) throw new SandboxError('base_missing', `${gitSource} does not hold the commit ${repo.git.commit}`);
  const listed = await git(context, layout, ['ls-tree', '-r', '-z', '--name-only', '--full-tree', tree], { gitDir, objectFormat, cwd: layout.scratch });
  return { kind: 'git', gitDir, commit, tree, objectFormat, paths: listed.stdout.toString('utf8').split('\0').filter(Boolean) };
}

/** Writes the base into the private store <run>/b and makes its baseline commit on refs/datgold/base. Resolves {tree, commit}. */
export async function buildBase({ base, context, layout }) {
  const formatArgs = base.objectFormat === 'sha256' ? ['--object-format=sha256'] : [];
  await git(context, layout, ['init', '--bare', '--quiet', `--template=${path.join(layout.scratch, 'template')}`, ...formatArgs, layout.store], { attributes: false });
  const store = { gitDir: layout.store, objectFormat: base.objectFormat };
  let tree = base.tree;
  if (base.kind === 'git') {
    // Only the objects of the tree, never the source's history: rev-list --objects from a tree.
    await git(context, layout, ['pack-objects', '--revs', '--quiet', path.join(layout.store, 'objects', 'pack', 'pack')], { gitDir: base.gitDir, objectFormat: base.objectFormat, input: `${tree}\n`, cwd: layout.scratch });
  } else {
    const chunks = [];
    for (const [index, entry] of base.files.entries()) chunks.push(Buffer.from(`blob\nmark :${index + 1}\ndata ${entry.data.length}\n`), entry.data, Buffer.from('\n'));
    chunks.push(Buffer.from(`commit ${IMPORT_REF}\ncommitter DatGold Corpus <baseline@corpus.datgold.invalid> 946684800 +0000\ndata 0\ndeleteall\n`));
    // the reader refused every path with a quote, a line break or a backslash: none needs quoting on an M line
    chunks.push(Buffer.from(base.files.map((entry, index) => `M ${entry.mode} :${index + 1} ${entry.path}\n`).join(''), 'utf8'), Buffer.from('\ndone\n'));
    await git(context, layout, ['-c', 'fastimport.unpackLimit=0', 'fast-import', '--quiet', '--done', '--date-format=raw'], { ...store, input: Buffer.concat(chunks) });
    tree = text(await git(context, layout, ['rev-parse', `${IMPORT_REF}^{tree}`], store));
  }
  const commit = text(await git(context, layout, ['commit-tree', tree], { ...store, input: BASELINE_MESSAGE }));
  await git(context, layout, ['update-ref', BASE_REF, commit], store);
  return { tree, commit };
}

/**
 * Checks the baseline commit out into `dest` as a repository of its own: `git init`, the commit's objects copied from the store (one pack),
 * main pointing at it, the index read from it and every file written as its blob (attributes off). The work tree is clean for `git status`.
 */
export async function checkoutBase({ base, built, context, layout, dest }) {
  const formatArgs = base.objectFormat === 'sha256' ? ['--object-format=sha256'] : [];
  await git(context, layout, ['init', '--quiet', `--template=${path.join(layout.scratch, 'template')}`, '--initial-branch=main', ...formatArgs, dest], { attributes: false });
  const gitDir = path.join(dest, '.git');
  await git(context, layout, ['pack-objects', '--revs', '--quiet', path.join(gitDir, 'objects', 'pack', 'pack')], { gitDir: layout.store, objectFormat: base.objectFormat, input: `${built.commit}\n` });
  const repo = { gitDir, workTree: dest, indexFile: path.join(gitDir, 'index'), objectFormat: base.objectFormat };
  await git(context, layout, ['update-ref', 'refs/heads/main', built.commit], repo);
  await git(context, layout, ['read-tree', built.commit], repo);
  await git(context, layout, ['checkout-index', '--all', '--force', '--index'], repo);
}

/**
 * The tree of a work folder as the private store sees it: an index of its own read from the base tree (so modes the file system cannot
 * hold are kept), then `git add --all` (the work tree's .gitignore files count; nothing of the agent's .git is read), then the tree id.
 */
export async function treeOfWork({ base, built, context, layout, name }) {
  const options = { gitDir: layout.store, workTree: layout.work, indexFile: path.join(layout.scratch, `${name}.index`), objectFormat: base.objectFormat };
  await git(context, layout, ['read-tree', built.tree], options);
  await git(context, layout, ['add', '--all'], options);
  return text(await git(context, layout, ['write-tree'], options));
}

/** The paths that differ between two trees of the store. */
export async function changedPaths({ base, context, layout, from, to }) {
  const result = await git(context, layout, ['diff', '--no-renames', '--name-only', '-z', from, to], { gitDir: layout.store, objectFormat: base.objectFormat });
  return result.stdout.toString('utf8').split('\0').filter(Boolean);
}

/** The diff from tree `from` to tree `to` (DIFF_ARGS): the agent's diff. */
export async function diffTrees({ base, context, layout, from, to }) {
  if (from === to) return Buffer.alloc(0);
  return (await git(context, layout, [...DIFF_ARGS, from, to], { gitDir: layout.store, objectFormat: base.objectFormat, maxBytes: SANDBOX_LIMITS.maxPatchBytes })).stdout;
}

/** True when `patch`, applied to tree `from` in an index of its own, gives tree `to`. */
export async function patchReproduces({ base, context, layout, from, to, patch }) {
  if (!patch.length) return from === to;
  const options = { gitDir: layout.store, indexFile: path.join(layout.scratch, 'check.index'), objectFormat: base.objectFormat, allowFail: true };
  if ((await git(context, layout, ['read-tree', from], options)).code !== 0) return false;
  if ((await git(context, layout, ['apply', '--cached', '--binary', '--whitespace=nowarn', '-'], { ...options, input: patch })).code !== 0) return false;
  const written = await git(context, layout, ['write-tree'], options);
  return written.code === 0 && text(written) === to;
}

/** Applies `patch` to the checkout in `dest` (index and files). {ok, error}. */
export async function applyToCheckout({ base, context, layout, dest, patch }) {
  if (!patch.length) return { ok: true, error: null };
  const gitDir = path.join(dest, '.git');
  const result = await git(context, layout, ['apply', '--index', '--binary', '--whitespace=nowarn', '-'],
    { gitDir, workTree: dest, indexFile: path.join(gitDir, 'index'), objectFormat: base.objectFormat, input: patch, allowFail: true });
  return result.code === 0 ? { ok: true, error: null } : { ok: false, error: firstLine(result.stderr) || `git apply exited ${result.code}` };
}

const CHANGE = Object.freeze({ A: 'added', D: 'deleted', M: 'modified', T: 'modified' });
const checkoutRepo = (dest, base) => ({ gitDir: path.join(dest, '.git'), workTree: dest, indexFile: path.join(dest, '.git', 'index'), objectFormat: base.objectFormat });

/** What the index of the checkout in `dest` changed against commit `from`: [{path, change: added | modified | deleted}], in code-unit order. */
export async function checkoutChanges({ base, context, layout, dest, from }) {
  const result = await git(context, layout, ['diff', '--cached', '--no-renames', '--name-status', '-z', from], checkoutRepo(dest, base));
  const fields = result.stdout.toString('utf8').split('\0');
  const changes = [];
  for (let index = 0; index + 1 < fields.length; index += 2) changes.push({ path: fields[index + 1], change: CHANGE[fields[index][0]] ?? 'modified' });
  return changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Puts `changes` of the checkout back to commit `from`, index and files: an added path is removed, a modified or deleted one restored. */
export async function restoreToBase({ base, context, layout, dest, from, changes }) {
  const repo = checkoutRepo(dest, base);
  const pathspecs = (list) => list.map((change) => `:(literal)${change.path}`).join('\0');
  const added = changes.filter((change) => change.change === 'added');
  const others = changes.filter((change) => change.change !== 'added');
  if (added.length) await git(context, layout, ['rm', '--quiet', '--force', '--pathspec-from-file=-', '--pathspec-file-nul'], { ...repo, input: pathspecs(added) });
  if (others.length) await git(context, layout, ['checkout', from, '--pathspec-from-file=-', '--pathspec-file-nul'], { ...repo, input: pathspecs(others) });
}

// ---- the profile -------------------------------------------------------------------------------------------------------------------

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PROFILE_NAMES = new Set(PROFILE_VARIABLES.map((entry) => entry.name.toUpperCase()));

/** Checks a map of variables a caller adds ({NAME: text}); refuses a bad name or value and any name of the profile. */
export function checkVariables(map, what) {
  if (map === undefined || map === null) return {};
  if (typeof map !== 'object' || Array.isArray(map)) throw new SandboxError('bad_agent_env', `${what} must be an object of NAME: text`);
  for (const [name, value] of Object.entries(map)) {
    if (!NAME.test(name)) throw new SandboxError('bad_agent_env', `${what}: ${JSON.stringify(name)} is not a variable name`);
    if (typeof value !== 'string') throw new SandboxError('bad_agent_env', `${what}: the value of ${name} is not text`);
    if (PROFILE_NAMES.has(name.toUpperCase())) throw new SandboxError('bad_agent_env', `${what}: ${name} is a variable of the run's profile, which the sandbox sets`);
  }
  return { ...map };
}

/** Checks the files to seed into the profile ({'claude/settings.json': text | Buffer}, relative to <run>/h). */
export function checkSeed(seed) {
  if (seed === undefined || seed === null) return {};
  if (typeof seed !== 'object' || Array.isArray(seed)) throw new SandboxError('bad_seed_path', 'seed must be an object of relative path: content');
  for (const [file, content] of Object.entries(seed)) {
    const parts = file.split('/');
    if (path.isAbsolute(file) || /[\\:]/.test(file) || parts.some((part) => !part || part === '.' || part === '..')) {
      throw new SandboxError('bad_seed_path', `the seed path ${JSON.stringify(file)} must be a relative path inside the profile, with forward slashes`);
    }
    if (typeof content !== 'string' && !Buffer.isBuffer(content)) throw new SandboxError('bad_seed_path', `the seed ${file} is not text or bytes`);
  }
  return { ...seed };
}

/** Creates the profile folders, the global Git configuration and the seeded files. */
export async function makeProfile(layout, seed = {}) {
  for (const entry of PROFILE_VARIABLES) if (entry.folder) await fs.mkdir(path.join(layout.profile, entry.folder), { recursive: true });
  await fs.writeFile(path.join(layout.profile, 'home', '.gitconfig'), PROFILE_GITCONFIG);
  for (const [file, content] of Object.entries(seed)) {
    const target = path.join(layout.profile, ...file.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
}

/**
 * The environments of a run: `setup` (inherited allow-list, profile, extra variables) for setup and checks, and `agent` (the same plus
 * the agent's variables and credentials). The inherited half is scrubbed of credential-looking names first.
 */
export function profileEnvironment({ layout, env = process.env, platform = process.platform, extraEnv = {}, agentEnv = {}, credentials = {} }) {
  const allowed = new Set(platform === 'win32' ? INHERITED_VARIABLES.win32 : INHERITED_VARIABLES.posix);
  const inherited = {};
  for (const [name, value] of Object.entries(scrubEnv(env ?? {}))) {
    if (allowed.has(platform === 'win32' ? name.toUpperCase() : name)) inherited[name] = value;
  }
  const profile = {};
  for (const entry of PROFILE_VARIABLES) {
    if (entry.folder) profile[entry.name] = path.join(layout.profile, entry.folder);
    else if (entry.file) profile[entry.name] = path.join(layout.profile, ...entry.file.split('/'));
    else if (entry.run) profile[entry.name] = layout.dir;
    else profile[entry.name] = entry.value;
  }
  const setup = { ...inherited, ...extraEnv, ...profile };
  return {
    setup,
    agent: { ...setup, ...agentEnv, ...credentials },
    record: { variables: Object.keys(profile), inherited: Object.keys(inherited).sort(), credentials: Object.keys(credentials).sort() },
  };
}

// ---- commands ----------------------------------------------------------------------------------------------------------------------

/**
 * Runs one shell command in `dir` the way the Hub's checks run (ShellRunner: Git Bash or bash, else PowerShell; bounded output; the tree
 * killed at the time limit). The pid of the shell joins `roots` so that what it left behind can be reaped. Never throws for a process outcome.
 */
export async function runCommand({ command, dir, cwd = '', env, layout, timeoutSeconds, signal = null, roots }) {
  const workspace = { resolve: (relative) => ({ absolute: path.join(dir, ...String(relative || '.').split('/')), relative: relative || '' }) };
  const runner = new ShellRunner({ workspace, env, stateDirectory: layout.scratch, maxTimeoutMs: 3_600_000 });
  const spawnedAt = Date.now();
  try {
    const result = await runner.run({ command, cwd, timeoutMs: timeoutSeconds * 1000, signal });
    roots.push({ pid: result.pid, spawnedAt });
    return {
      command, cwd: cwd || '.', exitCode: result.exitCode, timedOut: result.timedOut, cancelled: result.cancelled, durationMs: result.durationMs,
      stdoutTail: tail(result.stdout), stderrTail: tail(result.stderr), outputSha256: result.outputSha256,
    };
  } catch (error) {
    return { command, cwd: cwd || '.', exitCode: null, timedOut: false, cancelled: Boolean(signal?.aborted), durationMs: Date.now() - spawnedAt, stdoutTail: '', stderrTail: error.message, outputSha256: null };
  }
}

/** Runs the setup commands in turn; stops at the first that fails. Each step gets `pass`. */
export async function runSetup({ commands, dir, env, layout, timeoutSeconds = SANDBOX_LIMITS.setupTimeoutSeconds, signal, roots }) {
  const steps = [];
  for (const command of commands) {
    const step = await runCommand({ command, dir, env, layout, timeoutSeconds, signal, roots });
    step.pass = step.exitCode === 0 && !step.timedOut && !step.cancelled;
    steps.push(step);
    if (!step.pass) break;
  }
  return steps;
}
