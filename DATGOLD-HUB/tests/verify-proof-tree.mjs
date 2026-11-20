// lib/proof/tree-snapshot.mjs + lib/proof/git-plumbing.mjs: the content identity of a workspace tree (P4 pod-15).
//
// Every tree id the engine gives is compared with an independent reference: plain `git add -A && git write-tree` run by this suite in a
// throw-away bare repository (its own index and objects, the workspace's objects as an alternate), with no system or global configuration.
//
//  1. object ids: blobs and trees against `git hash-object --no-filters` / `git mktree`, Git's entry order, the empty tree
//  2. exclusions: the name globs given to Git match exactly what PRIVATE_FILE matches (checked BY GIT over a corpus of names), and the
//     pathspecs exclude exactly what exclusionOf() excludes, for whole paths
//  3. fixtures: worktree (.git file), submodule, sparse checkout, LFS pointer (with and without a repository LFS filter), a clean filter
//     whose program must NOT run (canary), fsmonitor and textconv, a long path, a symlink, an executable bit, CRLF with core.autocrlf=true
//     in the person's own config, a same-size edit with the modification time put back, protected files, no Git, not a repository,
//     unbounded workspaces, too many new blobs, and the repository's own .git folder unchanged byte for byte
//  4. budgets (gate G4 criterion 1), printed as one JSON line `PROOF_TREE_BUDGET {...}`
//  5. a property test: 200 random create/edit/delete/rename steps (and .gitignore changes) on a 663-file and an 8,002-file repository;
//     after each step the engine's cached snapshot equals the reference, and at fixed steps so do a full snapshot, its rawTree and raw-v1
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PRIVATE_FILE } from '../lib/protected-paths.mjs';
import { MODE, blobId, buildTree, treeId } from '../lib/proof/git-plumbing.mjs';
import {
  LIMITATION, TREE_ALGORITHM, TreeSnapshotter, excludePathspecs, exclusionOf, privateFileGlobs, snapshotTree,
} from '../lib/proof/tree-snapshot.mjs';

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
const note = (label) => console.log(`  note - ${label}`);
const SUITE_BUDGET_MS = 170_000;
setTimeout(() => { console.error('FAIL: the proof tree suite exceeded its own time budget'); process.exit(2); }, SUITE_BUDGET_MS).unref();

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-tree-'));
process.on('exit', () => { try { fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best effort */ } });
let serial = 0;
const fresh = (label) => { const dir = path.join(scratch, `${label}-${(serial += 1)}`); fs.mkdirSync(dir, { recursive: true }); return dir; };
const emptyConfig = path.join(scratch, 'empty.gitconfig');
fs.writeFileSync(emptyConfig, '');

// Git as the person would never run it: no system or global configuration, nothing inherited from this process's GIT_* variables.
const isolatedEnv = (extra = {}) => {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (!/^GIT_/i.test(key)) env[key] = value;
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyConfig, GIT_ATTR_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', ...extra };
};
const IDENTITY = ['-c', 'user.name=Proof Test', '-c', 'user.email=proof@example.invalid', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false'];
function git(cwd, args, { env = isolatedEnv(), input, allowFail = false } = {}) {
  const result = spawnSync('git', [...IDENTITY, ...args], { cwd, env, input, encoding: 'buffer', maxBuffer: 512 * 1024 * 1024, windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFail) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr.toString()}`);
  return { status: result.status, stdout: result.stdout.toString('utf8'), stderr: result.stderr.toString('utf8') };
}
const write = (root, relative, content) => { const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };
const newRepo = (label) => { const dir = fresh(label); git(dir, ['init', '-q']); return dir; };
const commitAll = (dir) => { git(dir, ['add', '-A']); git(dir, ['commit', '-q', '--allow-empty', '-m', 'fixture']); };

/** The reference: a throw-away bare repository whose index and objects are its own, pointed at the workspace as its work tree. */
class Reference {
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
    const config = ['-c', 'core.autocrlf=false', '-c', 'core.longpaths=true', '-c', 'core.sparseCheckout=false', '-c', 'core.fsmonitor=false'];
    git(this.workTree, [...config, 'add', '-A', '--', '.', ...extraPathspecs], { env: this.env() });
    return git(this.workTree, [...config, 'write-tree'], { env: this.env() }).stdout.trim();
  }
  freshTree(extraPathspecs) { this.reset(); return this.tree(extraPathspecs); }
  lsTree(tree) { return git(this.workTree, ['ls-tree', '-r', '-z', tree], { env: this.env() }).stdout.split('\0').filter(Boolean); }
}

const snapshotter = (root, options = {}) => new TreeSnapshotter({ root, stateDir: fresh('state'), ...options });
const sha1 = (text) => createHash('sha1').update(text).digest('hex');
const percentile = (values, p) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]; };
const timed = async (fn) => { const start = performance.now(); const value = await fn(); return { value, ms: performance.now() - start }; };
const timedSync = (fn) => { const start = performance.now(); fn(); return performance.now() - start; };

function mulberry32(seed) {
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
function folderPrint(folder) {
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

// ------------------------------------------------------------------ 1. object ids
{
  const dir = newRepo('ids');
  const samples = [Buffer.alloc(0), Buffer.from('hello\n'), Buffer.from('a\r\nb\r\n'), Buffer.from([0, 255, 13, 10, 0]), Buffer.from('ünïcödé 日本\n')];
  for (const [index, bytes] of samples.entries()) {
    fs.writeFileSync(path.join(dir, `s${index}`), bytes);
    const expected = git(dir, ['hash-object', '--no-filters', `s${index}`]).stdout.trim();
    assert.equal(blobId(bytes), expected, `blob ${index}`);
    assert.equal(blobId(bytes, 'sha256'), createHash('sha256').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'));
  }
  ok('blobId equals git hash-object --no-filters (empty, text, CRLF, binary, Unicode) and is sha256-aware');

  assert.equal(treeId([]), '4b825dc642cb6eb9a060e54bf8d69288fbee4904', 'the empty tree');
  assert.equal(buildTree([]), '4b825dc642cb6eb9a060e54bf8d69288fbee4904');
  // Git's order: "a.b" < "a" (a folder, read as "a/") < "a0"; a file "a-" sorts before the folder "a".
  const blob = blobId('x\n');
  const sub = treeId([{ name: 'f', mode: MODE.file, oid: blob }]);
  const entries = [
    { name: 'a0', mode: MODE.file, oid: blob }, { name: 'a', mode: MODE.tree, oid: sub }, { name: 'a.b', mode: MODE.executable, oid: blob },
    { name: 'a-', mode: MODE.symlink, oid: blob }, { name: 'm', mode: MODE.gitlink, oid: '1'.repeat(40) },
  ];
  const listing = entries.map((entry) => `${entry.mode.padStart(6, '0')} ${entry.mode === MODE.tree ? 'tree' : entry.mode === MODE.gitlink ? 'commit' : 'blob'} ${entry.oid}\t${entry.name}`).join('\n');
  const expected = git(dir, ['mktree', '--missing'], { input: `${listing}\n` }).stdout.trim();
  assert.equal(treeId(entries), expected, 'treeId sorts like git mktree');
  assert.equal(buildTree([
    { path: 'a0', mode: MODE.file, oid: blob }, { path: 'a/f', mode: MODE.file, oid: blob }, { path: 'a.b', mode: MODE.executable, oid: blob },
    { path: 'a-', mode: MODE.symlink, oid: blob }, { path: 'm', mode: MODE.gitlink, oid: '1'.repeat(40) },
  ]), expected, 'buildTree makes the folders');
  assert.throws(() => buildTree([{ path: 'a', mode: MODE.file, oid: blob }, { path: 'a', mode: MODE.file, oid: blob }]), /duplicate/);
  assert.throws(() => buildTree([{ path: 'a', mode: MODE.file, oid: blob }, { path: 'a/b', mode: MODE.file, oid: blob }]), /share the name|duplicate/);
  assert.throws(() => buildTree([{ path: 'a//b', mode: MODE.file, oid: blob }]), /bad path/);
  assert.throws(() => buildTree([{ path: '../b', mode: MODE.file, oid: blob }]), /bad path/);
  assert.throws(() => treeId([{ name: 'a', mode: MODE.file, oid: 'abcd' }]), /bad object id/);
  ok('treeId/buildTree equal git mktree in Git\'s entry order (file "a-", folder "a", "a.b", "a0", gitlink) and refuse duplicates and bad paths');
}

// ------------------------------------------------------------------ 2. exclusions: parity with PRIVATE_FILE, checked by Git itself
{
  const names = new Set([
    '.env', '.ENV', '.env.', '.env.local', '.env.example', '.env.EXAMPLE', '.env.sample', '.env.template', '.env.dist', '.env.default', '.env.defaults',
    '.env.defaultsx', '.env.example.bak', '.env.exampl', '.env.e', '.env.d', '.env.di', '.env.dis', '.env.distx', '.env.s', '.env.t', '.env.templat',
    '.env.templates', '.env.x', '.env.def', '.env.defa', '.env.defaul', '.envrc', 'env', 'x.env', '.env-local', '.env.production.local', '.env.DIST',
    'id_rsa', 'id_rsa.pub', 'ID_ED25519', 'id_ecdsa.old', 'id_dsa', 'id_rsax', 'id_ed25519.pub', 'my_id_rsa',
    'cert.pem', '.pem', 'a.p12', 'b.PFX', 'server.key', 'x.keystore', 'y.jks', 'z.ppk', 'key', 'pem', 'a.pem.txt', 'keys.json', 'a.keys',
    'credentials', 'credentials.json', 'credentials.toml', 'Credentials.JSON', 'credentials.yml', 'credentials.json.bak', 'mycredentials',
    'secret.json', 'secrets.json', 'secret.yml', 'secrets.yaml', 'secret.toml', 'secrets.tfvars', 'secret.auto.tfvars', 'secrets.txt', 'secret', 'secretss.json',
    '.npmrc', '.pypirc', '.netrc', '.git-credentials', '.htpasswd', '.pgpass', '.dockercfg', '.vault-token', '.terraformrc', '_netrc', 'npmrc', '.npmrc.bak',
    'terraform.rc', 'credentials.tfrc.json', 'terraform.tfstate', 'a.tfstate.backup', 'x.tfstate.1', 'x.tfstate.12', 'x.tfstate.123456789', 'x.tfstate.1.backup',
    'x.tfstate.12345.backup', 'x.tfstate.a', 'x.tfstate.1a', 'x.tfstate.', 'x.tfstate.backup.1', 'tfstate', '.tfstate', 'x.tfstatex',
    'service-account.json', 'serviceaccount.json', 'service_account_key.json', 'service-account-key.json', 'serviceaccountkey.json', 'service-account-prod.json',
    'service_account.prod.json', 'service-account_key-x.json', 'service-account.yaml', 'service-accounts.json', 'service--account.json', 'service-account..json',
    'application_default_credentials.json', 'kubeconfig', 'kubeconfig.yml', 'kubeconfig.yaml', 'prod.kubeconfig', 'kubeconfig.json', 'kubeconfigs',
    'README.md', 'index.js', 'package.json', 'config.json', 'hosts.yml', '.gitignore', 'environment.ts', 'monkey.txt', 'keystore', 'x.tfvars',
  ]);
  // more names from the seeds: case changes and suffixes
  const random = mulberry32(15);
  for (const base of [...names]) {
    if (random() < 0.5) names.add(base.toUpperCase());
    if (random() < 0.3) names.add(`${base}.${['bak', 'old', 'example', '1', 'json'][Math.floor(random() * 5)]}`);
  }
  // Windows refuses names ending with a dot or a space; everything else in the corpus is a legal name on all three systems.
  const usable = [...names].filter((name) => process.platform !== 'win32' || !/[. ]$/.test(name));
  const dir = newRepo('parity');
  const byFolder = new Map();
  usable.forEach((name, index) => { const folder = `n${index}`; byFolder.set(folder, name); write(dir, `${folder}/${name}`, 'x'); });
  const matched = git(dir, ['ls-files', '-z', '--others', '--', ...privateFileGlobs().map((glob) => `:(glob,icase)**/${glob}`)]).stdout.split('\0').filter(Boolean);
  const matchedNames = new Set(matched.map((file) => byFolder.get(file.split('/')[0])));
  const overMatch = /\.tfstate\.\d{10,}/i;
  const wrong = [];
  for (const name of usable) {
    const expected = PRIVATE_FILE.test(name);
    const actual = matchedNames.has(name);
    if (expected !== actual && !(actual && overMatch.test(name))) wrong.push(`${name}: PRIVATE_FILE ${expected}, globs ${actual}`);
  }
  assert.deepEqual(wrong, [], 'the globs given to Git must match exactly what PRIVATE_FILE matches');
  ok(`the ${privateFileGlobs().length} name globs match exactly the names PRIVATE_FILE matches (${usable.length} names, judged by git ls-files)`);

  // every glob is needed: each one matches a name of the corpus
  for (const glob of privateFileGlobs().filter((g) => !g.includes('[0-9]'))) {
    const hits = git(dir, ['ls-files', '-z', '--others', '--', `:(glob,icase)**/${glob}`]).stdout;
    assert.ok(hits.length > 0, `glob ${glob} matches no name of the corpus`);
  }
  ok('every glob without a digit class matches at least one name of the corpus (no dead glob)');

  // whole paths: the pathspecs exclude exactly what exclusionOf() excludes
  const paths = [
    'a/.ssh/id', '.ssh/config', 'deep/x/.aws/credentials.cfg', '.gnupg/k', 'k/.kube/c', 'x/.SSH/y', 'notssh/a', '.sshx/a',
    '.docker/config.json', 'h/.docker/config.json', '.docker/other.json', 'config.json', '.config/gh/hosts.yml', 'gh/hosts.yml', 'hosts.yml',
    '.azure/accessTokens.json', 'gcloud/legacy_credentials/me/adc.json', 'gcloud/credentials.db', '.m2/settings.xml', 'm2/settings.xml',
    '.chatmcp/hooks.json', 'pkg/.chatmcp/hooks.json', '.chatmcp/hooks.json.bak', '.chatmcp/other.json', '.chatmcp/runs/r1/receipt.json',
    '.chatmcp/runs', '.chatmcp/runsx/a', 'sub/.chatmcp/runs/a', '.CHATMCP/RUNS/b', 'src/.env', 'src/app.js', 'docs/secrets.json/readme',
  ];
  const mismatch = [];
  for (const relative of paths) {
    // one repository per path: a path that is a file in one row can be a folder in another, and .chatmcp/runs is at the top
    const pathRepo = newRepo('parity-path');
    write(pathRepo, relative, 'x');
    const kept = git(pathRepo, ['ls-files', '-z', '--others', '--', '.', ...excludePathspecs()]).stdout.split('\0').filter(Boolean).includes(relative);
    const excluded = exclusionOf(relative) !== null;
    if (excluded === kept) mismatch.push(`${relative}: exclusionOf ${exclusionOf(relative)}, git kept ${kept}`);
  }
  assert.deepEqual(mismatch, [], 'the pathspecs and exclusionOf() must agree on whole paths');
  ok(`the ${excludePathspecs().length} pathspecs exclude exactly what exclusionOf() excludes (${paths.length} paths: folders, locations, the hooks file, .chatmcp/runs)`);
}

// ------------------------------------------------------------------ 3. fixtures
async function expectEqual(label, root, reference, options = {}, { algorithm = TREE_ALGORITHM.gitPinned, rawEqual = true } = {}) {
  const engine = snapshotter(root, options);
  const full = await engine.snapshot({ full: true });
  const expected = reference.freshTree();
  assert.equal(full.status, 'ok', `${label}: status`);
  assert.equal(full.treeAlgorithm, algorithm, `${label}: algorithm (${full.engineReason})`);
  assert.equal(full.tree, expected, `${label}: full snapshot equals the reference`);
  if (rawEqual) assert.equal(full.rawTree, expected, `${label}: rawTree equals the reference`);
  const cached = await engine.snapshot();
  assert.equal(cached.tree, expected, `${label}: cached snapshot equals the reference`);
  assert.equal(cached.full, false);
  assert.equal(cached.rawTree, null, 'a cached snapshot has no rawTree');
  return { engine, full, expected };
}

{ // a worktree: .git is a file that points into the main repository
  const main = newRepo('wt-main');
  write(main, 'a.txt', 'one\n');
  write(main, 'src/b.js', 'two\n');
  commitAll(main);
  const wt = path.join(fresh('wt-parent'), 'wt');
  git(main, ['worktree', 'add', '-q', wt]);
  assert.ok(fs.statSync(path.join(wt, '.git')).isFile());
  write(wt, 'src/b.js', 'changed in the worktree\n');
  write(wt, 'new.txt', 'untracked\n');
  const objects = path.join(main, '.git', 'objects');
  await expectEqual('worktree', wt, new Reference(wt, { alternates: objects }));
  ok('worktree (.git file): full, raw and cached snapshots equal the reference');
}

{ // a submodule: a gitlink resolved through .git/modules
  const source = newRepo('sub-source');
  write(source, 'lib.txt', 'library\n');
  commitAll(source);
  const main = newRepo('sub-main');
  write(main, 'app.txt', 'app\n');
  git(main, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', source.replaceAll('\\', '/'), 'deps/lib']);
  commitAll(main);
  assert.ok(fs.statSync(path.join(main, 'deps', 'lib', '.git')).isFile(), 'the submodule has a .git file');
  const { expected } = await expectEqual('submodule', main, new Reference(main));
  const reference = new Reference(main);
  const row = reference.lsTree(expected).find((line) => line.endsWith('\tdeps/lib'));
  assert.match(row, /^160000 commit [0-9a-f]{40}\t/);
  ok('submodule: the gitlink is the checked-out commit, in Git and in raw-v1');
}

{ // a sparse checkout: what is not on disk is not in the tree
  const repo = newRepo('sparse');
  write(repo, 'in/a.txt', 'a\n');
  write(repo, 'out/b.txt', 'b\n');
  write(repo, 'top.txt', 't\n');
  commitAll(repo);
  git(repo, ['sparse-checkout', 'set', 'in']);
  assert.equal(fs.existsSync(path.join(repo, 'out', 'b.txt')), false);
  await expectEqual('sparse checkout', repo, new Reference(repo));
  ok('sparse checkout: snapshots equal the reference (files outside the cone are not on disk and not in the tree)');
}

{ // Git LFS pointers
  const repo = newRepo('lfs');
  const pointer = 'version https://git-lfs.github.com/spec/v1\noid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\nsize 12345\n';
  write(repo, '.gitattributes', '*.bin filter=lfs diff=lfs merge=lfs -text\n');
  write(repo, 'big.bin', pointer);
  write(repo, 'readme.md', 'r\n');
  await expectEqual('LFS pointer, no filter in the repository', repo, new Reference(repo));
  git(repo, ['config', 'filter.lfs.clean', 'git-lfs clean -- %f']);
  git(repo, ['config', 'filter.lfs.process', 'git-lfs filter-process']);
  const { full } = await expectEqual('LFS pointer, repository LFS filter', repo, new Reference(repo), {}, { algorithm: TREE_ALGORITHM.raw });
  assert.match(full.engineReason, /^repository_programs:.*filter\.lfs\.clean/);
  assert.equal(full.ignoreRules, 'git', 'Git still lists the files: ls-files runs no filter');
  ok('LFS pointer: hashed as the pointer bytes; a repository LFS filter selects raw-v1 (the filter program is not run)');
}

const nodeProgram = process.execPath.replaceAll('\\', '/');
function canaryScript(dir) {
  const canary = path.join(dir, 'canary.txt');
  const script = path.join(dir, 'filter.cjs');
  fs.writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(canary)}, 'ran'); process.stdin.pipe(process.stdout);\n`);
  return { canary, command: `"${nodeProgram}" "${script.replaceAll('\\', '/')}"` };
}

{ // a clean filter: raw-v1, and the program never runs
  const repo = newRepo('clean-filter');
  const outside = fresh('canary');
  const { canary, command } = canaryScript(outside);
  git(repo, ['config', 'filter.evil.clean', command]);
  git(repo, ['config', 'filter.evil.smudge', command]);
  write(repo, '.gitattributes', '* filter=evil\n');
  write(repo, 'a.txt', 'content the filter would see\n');
  write(repo, 'b/c.txt', 'more\n');
  const engine = snapshotter(repo);
  const full = await engine.snapshot({ full: true });
  const cached = await engine.snapshot();
  assert.equal(full.treeAlgorithm, TREE_ALGORITHM.raw);
  assert.match(full.engineReason, /^repository_config_refused:.*filter\.evil\.clean/);
  assert.equal(full.ignoreRules, 'none', 'a refused configuration means Git is not run at all');
  assert.ok(full.limitations.includes(LIMITATION.ignoreRulesNotApplied));
  assert.equal(cached.tree, full.tree);
  assert.equal(fs.existsSync(canary), false, 'the clean filter must not have run');
  assert.equal(full.tree, new Reference(repo).freshTree(), 'the raw bytes, as Git without the filter');
  // the fixture is real: Git run the usual way does start the filter
  const control = fresh('control-index');
  fs.mkdirSync(path.join(control, 'objects'), { recursive: true });
  spawnSync('git', ['add', '-A'], { cwd: repo, env: isolatedEnv({ GIT_INDEX_FILE: path.join(control, 'index'), GIT_OBJECT_DIRECTORY: path.join(control, 'objects') }), windowsHide: true });
  assert.equal(fs.existsSync(canary), true, 'control: plain git add runs the clean filter of this fixture');
  ok('clean filter: raw-v1 with the reason, no Git process at all, the canary stays absent (and plain git add does write it)');
}

{ // fsmonitor and textconv
  const repo = newRepo('fsmonitor');
  const outside = fresh('canary');
  const { canary, command } = canaryScript(outside);
  git(repo, ['config', 'core.fsmonitor', command]);
  write(repo, 'a.txt', 'a\n');
  write(repo, '.gitignore', '*.log\n');
  write(repo, 'x.log', 'ignored\n');
  const { full } = await expectEqual('fsmonitor', repo, new Reference(repo), {}, { algorithm: TREE_ALGORITHM.raw });
  assert.match(full.engineReason, /^repository_programs:core\.fsmonitor/);
  assert.equal(full.ignoreRules, 'git');
  assert.equal(fs.existsSync(canary), false, 'the fsmonitor program must not have run');
  const textconv = newRepo('textconv');
  git(textconv, ['config', 'diff.pdf.textconv', command]);
  write(textconv, 'a.txt', 'a\n');
  const second = await snapshotter(textconv).snapshot({ full: true });
  assert.equal(second.treeAlgorithm, TREE_ALGORITHM.raw);
  assert.match(second.engineReason, /diff\.pdf\.textconv/);
  assert.equal(second.tree, new Reference(textconv).freshTree());
  assert.equal(fs.existsSync(canary), false);
  ok('fsmonitor selects raw-v1 (Git lists with fsmonitor off), textconv selects raw-v1 (refused); neither program runs');
}

{ // a long path (more than 260 characters on Windows)
  const repo = newRepo('long');
  const relative = [...Array.from({ length: 6 }, (_, index) => `${String(index).repeat(45)}`), 'file-with-a-long-name.txt'].join('/');
  write(repo, relative, 'deep\n');
  write(repo, 'short.txt', 's\n');
  assert.ok(path.join(repo, relative).length > 260, 'the path is longer than MAX_PATH');
  await expectEqual('long path', repo, new Reference(repo));
  ok(`long path (${path.join(repo, relative).length} characters): snapshots equal the reference`);
}

{ // a symlink and an executable bit
  const repo = newRepo('links');
  write(repo, 'target.txt', 't\n');
  let linked = true;
  try { fs.symlinkSync('target.txt', path.join(repo, 'link')); } catch (error) { linked = false; note(`symlink fixture not run here: ${error.code} (no privilege to create symlinks)`); }
  if (process.platform !== 'win32') { write(repo, 'run.sh', '#!/bin/sh\necho hi\n'); fs.chmodSync(path.join(repo, 'run.sh'), 0o755); }
  const { expected } = await expectEqual('symlink and executable', repo, new Reference(repo));
  const rows = new Reference(repo).lsTree(expected);
  if (linked) assert.ok(rows.some((row) => row.startsWith('120000 ') && row.endsWith('\tlink')), 'a symlink is mode 120000');
  if (process.platform !== 'win32') assert.ok(rows.some((row) => row.startsWith('100755 ') && row.endsWith('\trun.sh')), 'executable bit');
  ok(`symlink${linked ? '' : ' (not on this machine)'} and executable bit${process.platform === 'win32' ? ' (not on Windows)' : ''}: raw-v1 and Git agree`);
}

{ // CRLF, with core.autocrlf=true in the person's own configuration and in the repository's
  const repo = newRepo('crlf');
  const home = fresh('home');
  const userConfig = path.join(home, '.gitconfig');
  fs.writeFileSync(userConfig, '[core]\n\tautocrlf = true\n\tsafecrlf = true\n');
  git(repo, ['config', 'core.autocrlf', 'true']);
  const crlf = Buffer.from('line one\r\nline two\r\n');
  write(repo, 'dos.txt', crlf);
  write(repo, 'unix.txt', 'lf only\n');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: userConfig, HOME: home, USERPROFILE: home, GIT_INDEX_FILE: path.join(repo, '.git', 'index') };
  const { expected } = await expectEqual('CRLF', repo, new Reference(repo), { env });
  const row = new Reference(repo).lsTree(expected).find((line) => line.endsWith('\tdos.txt'));
  const rawId = createHash('sha1').update(`blob ${crlf.length}\0`).update(crlf).digest('hex');
  assert.equal(row.split(' ')[2].split('\t')[0], rawId, 'the CRLF bytes are hashed as they are');
  // control: Git with the person's configuration converts the line endings, so the setting was live
  const control = fresh('control-crlf');
  fs.mkdirSync(path.join(control, 'objects'), { recursive: true });
  const personal = { ...process.env, GIT_CONFIG_GLOBAL: userConfig, GIT_INDEX_FILE: path.join(control, 'index'), GIT_OBJECT_DIRECTORY: path.join(control, 'objects'), GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(repo, '.git', 'objects') };
  spawnSync('git', ['add', '-A'], { cwd: repo, env: personal, windowsHide: true });
  const converted = spawnSync('git', ['write-tree'], { cwd: repo, env: personal, encoding: 'utf8', windowsHide: true }).stdout.trim();
  assert.notEqual(converted, expected, 'control: the person\'s autocrlf=true would have changed the tree');
  ok('CRLF with core.autocrlf=true for the person and the repository: the raw CRLF bytes are hashed (the setting is live for plain Git)');
}

{ // a same-size edit with the modification time put back: the full snapshot rehashes
  const repo = newRepo('same-size');
  write(repo, 'a.txt', 'aaaa\n');
  write(repo, 'b.txt', 'bbbb\n');
  commitAll(repo);
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(repo, 'a.txt'), old, old);
  for (const algorithm of [TREE_ALGORITHM.gitPinned, TREE_ALGORITHM.raw]) {
    const engine = snapshotter(repo, { engine: algorithm === TREE_ALGORITHM.raw ? TREE_ALGORITHM.raw : 'auto' });
    const before = await engine.snapshot({ full: true });
    await engine.snapshot();
    const file = path.join(repo, 'a.txt');
    const original = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, original === 'aaaa\n' ? 'AAAA\n' : 'aaaa\n');
    fs.utimesSync(file, old, old);
    const cached = await engine.snapshot();
    const after = await engine.snapshot({ full: true });
    assert.equal(after.treeAlgorithm, algorithm);
    assert.notEqual(after.tree, before.tree, `${algorithm}: the full snapshot sees the edit`);
    assert.equal(after.tree, new Reference(repo).freshTree(), `${algorithm}: and equals the reference`);
    note(`${algorithm}: a cached snapshot ${cached.tree === after.tree ? 'also caught' : 'did not catch'} the same-size edit with the old time (only the full snapshot must)`);
  }
  ok('a same-size edit with the modification time restored is caught by the full snapshot (both engines)');
}

{ // protected files and .chatmcp/runs are left out and counted
  const repo = newRepo('protected');
  for (const relative of ['app.js', '.env.example', '.chatmcp/settings.json', 'src/readme.md']) write(repo, relative, `keep ${relative}\n`);
  const secrets = ['.env', 'config/.env.local', 'keys/server.pem', '.ssh/id_ed25519', 'home/.aws/credentials', 'secrets.json', '.chatmcp/hooks.json', '.docker/config.json', 'infra/terraform.tfstate'];
  for (const relative of secrets) write(repo, relative, 'SECRET\n');
  const runs = ['.chatmcp/runs/r1/receipt.json', '.chatmcp/runs/r2/log.txt'];
  for (const relative of runs) write(repo, relative, 'run\n');
  const literal = [...secrets, ...runs].map((relative) => `:(exclude,literal)${relative}`);
  for (const engineName of ['auto', TREE_ALGORITHM.raw]) {
    const engine = snapshotter(repo, { engine: engineName });
    const full = await engine.snapshot({ full: true });
    const expected = new Reference(repo).freshTree(literal);
    assert.equal(full.tree, expected, `${engineName}: protected files and runs are not in the tree`);
    assert.equal(full.rawTree, expected);
    assert.deepEqual(full.excluded, { protected: secrets.length, runs: runs.length, gitlinks: 0 });
    assert.equal(full.files, 4);
    assert.equal((await engine.snapshot()).tree, expected);
    const objects = fs.existsSync(path.join(engine.stateDir, 'objects')) ? folderPrint(path.join(engine.stateDir, 'objects')) : [];
    const secretId = blobId('SECRET\n');
    assert.equal(objects.some((row) => row.startsWith(path.join(secretId.slice(0, 2), secretId.slice(2)))), false, 'no secret blob is written to the private store');
  }
  ok(`protected files (${secrets.length}) and .chatmcp/runs (${runs.length}) are left out, counted, and never written as objects`);
}

{ // no Git, an unusable Git, not a repository
  const repo = newRepo('no-git');
  write(repo, 'a.txt', 'a\n');
  write(repo, 'b/c.txt', 'c\n');
  const reference = new Reference(repo);
  const none = await snapshotter(repo, { git: null }).snapshot({ full: true });
  assert.equal(none.treeAlgorithm, TREE_ALGORITHM.raw);
  assert.equal(none.engineReason, 'git_missing');
  assert.equal(none.tree, reference.freshTree());
  assert.ok(none.limitations.includes(LIMITATION.ignoreRulesNotApplied));
  const missing = await snapshotter(repo, { git: path.join(scratch, 'no-such-git', 'git.exe') }).snapshot({ full: true });
  assert.equal(missing.engineReason, 'git_missing');
  assert.equal(missing.tree, none.tree);
  const plain = fresh('plain-folder');
  write(plain, 'x.txt', 'x\n');
  write(plain, 'node_modules/m/index.js', 'm\n');
  write(plain, '.env', 'SECRET\n');
  const loose = await snapshotTree({ root: plain, stateDir: fresh('state') });
  assert.equal(loose.engineReason, 'not_a_repository');
  assert.equal(loose.tree, buildTree([{ path: 'x.txt', mode: MODE.file, oid: blobId('x\n') }, { path: 'node_modules/m/index.js', mode: MODE.file, oid: blobId('m\n') }]));
  assert.deepEqual(loose.excluded, { protected: 1, runs: 0, gitlinks: 0 });
  await assert.rejects(snapshotTree({ root: path.join(scratch, 'nowhere'), stateDir: fresh('state') }), /workspace folder not found/);
  assert.throws(() => new TreeSnapshotter({ root: plain }), /needs root and stateDir/);
  assert.throws(() => new TreeSnapshotter({ root: plain, stateDir: plain, engine: 'sha3' }), /unknown engine/);
  ok('no Git or a Git that cannot start: raw-v1 with reason git_missing; a plain folder: raw-v1, not_a_repository, every file but the protected ones');
}

{ // limits: unbounded, too many new blobs, an empty nested repository
  const repo = newRepo('limits');
  for (let index = 0; index < 30; index += 1) write(repo, `f${index}.txt`, `file ${index}\n`);
  const byFiles = await snapshotter(repo, { limits: { maxFiles: 10 } }).snapshot({ full: true });
  assert.deepEqual([byFiles.status, byFiles.tree, byFiles.treeAlgorithm, byFiles.unbounded], ['unbounded', null, null, 'files']);
  const byBytes = await snapshotter(repo, { limits: { maxBytes: 100 } }).snapshot({ full: true });
  assert.deepEqual([byBytes.status, byBytes.unbounded], ['unbounded', 'bytes']);
  const blobs = await snapshotter(repo, { limits: { maxNewBlobs: 5 } }).snapshot({ full: true });
  assert.equal(blobs.treeAlgorithm, TREE_ALGORITHM.raw);
  assert.equal(blobs.engineReason, 'too_many_new_blobs:30');
  assert.equal(blobs.tree, new Reference(repo).freshTree());
  commitAll(repo);
  const committed = await snapshotter(repo, { limits: { maxNewBlobs: 5 } }).snapshot({ full: true });
  assert.equal(committed.treeAlgorithm, TREE_ALGORITHM.gitPinned, 'blobs the repository already has are not new');
  // a nested repository without a commit: Git refuses to add it, so it is left out and counted
  const empty = path.join(repo, 'nested');
  fs.mkdirSync(empty);
  git(empty, ['init', '-q']);
  write(repo, 'nested/inside.txt', 'n\n');
  const engine = snapshotter(repo);
  const nested = await engine.snapshot({ full: true });
  assert.equal(nested.treeAlgorithm, TREE_ALGORITHM.gitPinned, nested.engineReason);
  assert.equal(nested.excluded.gitlinks, 1);
  assert.equal(nested.tree, committed.tree);
  write(repo, 'later.txt', 'l\n');
  assert.equal((await engine.snapshot()).tree, new Reference(repo).freshTree([':(exclude,literal)nested']));
  ok('more than maxFiles or maxBytes: status unbounded with no tree; more new blobs than maxNewBlobs: raw-v1; an empty nested repository is counted, not fatal');
}

{ // the repository's own .git is unchanged, whatever the environment says
  const repo = newRepo('untouched');
  for (let index = 0; index < 40; index += 1) write(repo, `src/m${index}.js`, `export const m${index} = ${index};\n`);
  commitAll(repo);
  write(repo, 'src/m1.js', 'changed\n');
  write(repo, 'new/untracked.txt', 'u\n');
  fs.rmSync(path.join(repo, 'src', 'm2.js'));
  const dotGit = path.join(repo, '.git');
  const before = folderPrint(dotGit);
  const looseBefore = git(repo, ['count-objects', '-v']).stdout;
  const env = { ...process.env, GIT_INDEX_FILE: path.join(dotGit, 'index'), GIT_OBJECT_DIRECTORY: path.join(dotGit, 'objects'), GIT_DIR: dotGit };
  const engine = snapshotter(repo, { env });
  const first = await engine.snapshot({ full: true });
  write(repo, 'src/m3.js', 'edited again\n');
  await engine.snapshot();
  await engine.snapshot({ full: true });
  await snapshotter(repo, { engine: TREE_ALGORITHM.raw, env }).snapshot({ full: true });
  assert.equal(first.treeAlgorithm, TREE_ALGORITHM.gitPinned);
  assert.deepEqual(folderPrint(dotGit), before, 'no file below .git changed, appeared or vanished');
  assert.equal(git(repo, ['count-objects', '-v']).stdout, looseBefore, 'the object count is the same');
  ok('the repository\'s .git (index, objects, everything) is byte-for-byte unchanged, also with GIT_INDEX_FILE / GIT_OBJECT_DIRECTORY / GIT_DIR pointing at it');
}

{ // concurrent calls are serialised and a cancelled call rejects
  const repo = newRepo('serial');
  write(repo, 'a.txt', 'a\n');
  const engine = snapshotter(repo);
  const results = await Promise.all([engine.snapshot({ full: true }), engine.snapshot(), engine.snapshot({ full: true }), engine.snapshot()]);
  assert.equal(new Set(results.map((result) => result.tree)).size, 1);
  const controller = new AbortController();
  controller.abort(new Error('stopped'));
  await assert.rejects(engine.snapshot({ signal: controller.signal }), /stopped/);
  assert.equal((await engine.snapshot()).tree, results[0].tree, 'the queue survives a rejected call');
  ok('concurrent snapshots are serialised; a cancelled one rejects and the next one works');
}

// ------------------------------------------------------------------ 4 + 5. generated repositories: budgets, then the property test
const LETTERS = 'abcdefghijklmnopqrstuvwxyz0123456789';
function generator(seed) {
  const random = mulberry32(seed);
  const pick = (list) => list[Math.floor(random() * list.length)];
  const word = (length = 3 + Math.floor(random() * 6)) => Array.from({ length }, () => pick(LETTERS)).join('');
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

function generateRepo(label, count, seed, { commit }) {
  const dir = newRepo(label);
  const g = generator(seed);
  const folders = Array.from({ length: Math.max(4, Math.floor(count / 40)) }, (_, index) => (index === 0 ? '' : `${g.word()}/${index % 3 ? g.word() : ''}`.replace(/\/$/, '')));
  const files = new Set();
  while (files.size < count) {
    const folder = g.pick(folders);
    const name = `${g.word()}.${g.pick(['js', 'txt', 'md', 'bin', 'json', 'log'])}`;
    const relative = folder ? `${folder}/${name}` : name;
    if (files.has(relative) || [...files].length > count * 2) continue;
    if (exclusionOf(relative)) continue;
    files.add(relative);
    write(dir, relative, g.content());
  }
  if (commit) commitAll(dir);
  return { dir, files, g, folders };
}

const budget = { platform: process.platform, git: git(scratch, ['--version']).stdout.trim(), node: process.version };
const big = generateRepo('big', 8002, 8002, { commit: true });
{
  const status = () => git(big.dir, ['status', '--porcelain']);
  budget.firstStatusMs = Math.round(timedSync(status));
  const cold = await timed(() => snapshotter(big.dir).snapshot({ full: true }));
  assert.equal(cold.value.status, 'ok');
  assert.equal(cold.value.files, 8002);
  budget.coldFullMs = Math.round(cold.ms);
  budget.coldLimitMs = Math.max(4000, 6 * budget.firstStatusMs);
  const statusRuns = Array.from({ length: 15 }, () => timedSync(status));
  budget.statusP95Ms = Math.round(percentile(statusRuns, 95));
  const engine = snapshotter(big.dir);
  const first = await engine.snapshot({ full: true });
  assert.equal(first.treeAlgorithm, TREE_ALGORITHM.gitPinned, first.engineReason);
  const warm = [];
  for (let run = 0; run < 15; run += 1) warm.push((await timed(() => engine.snapshot())).ms);
  budget.warmP95Ms = Math.round(percentile(warm, 95));
  budget.warmLimitMs = Math.max(300, 3 * budget.statusP95Ms);
  const raw = snapshotter(big.dir, { engine: TREE_ALGORITHM.raw });
  await raw.snapshot({ full: true });
  const rawWarm = [];
  for (let run = 0; run < 5; run += 1) rawWarm.push((await timed(() => raw.snapshot())).ms);
  budget.rawWarmP95Ms = Math.round(percentile(rawWarm, 95));
  budget.rawWarmLimitMs = 1500;
  console.log(`PROOF_TREE_BUDGET ${JSON.stringify(budget)}`);
  assert.ok(budget.coldFullMs <= budget.coldLimitMs, `cold full snapshot ${budget.coldFullMs} ms > ${budget.coldLimitMs} ms`);
  assert.ok(budget.warmP95Ms <= budget.warmLimitMs, `warm p95 ${budget.warmP95Ms} ms > ${budget.warmLimitMs} ms`);
  assert.ok(budget.rawWarmP95Ms <= budget.rawWarmLimitMs, `raw-v1 warm p95 ${budget.rawWarmP95Ms} ms > 1500 ms`);
  ok(`budgets on 8,002 files: cold ${budget.coldFullMs} <= ${budget.coldLimitMs} ms, warm p95 ${budget.warmP95Ms} <= ${budget.warmLimitMs} ms, raw-v1 warm p95 ${budget.rawWarmP95Ms} <= 1500 ms`);
}

async function propertyTest(repo, { steps, fullEvery, rawEvery, label }) {
  const { dir, files, g, folders } = repo;
  const list = [...files];
  const engine = snapshotter(dir);
  const raw = snapshotter(dir, { engine: TREE_ALGORITHM.raw });
  const reference = new Reference(dir);
  let gitignore = false;
  const counts = { create: 0, edit: 0, sameSize: 0, delete: 0, rename: 0, gitignore: 0 };
  await engine.snapshot({ full: true });
  await raw.snapshot({ full: true });
  const remove = (relative) => { const at = list.indexOf(relative); list[at] = list.at(-1); list.pop(); };
  for (let step = 1; step <= steps; step += 1) {
    const roll = g.random();
    if (roll < 0.04) {
      gitignore = !gitignore;
      counts.gitignore += 1;
      if (gitignore) write(dir, '.gitignore', '*.log\nbuild/\n'); else fs.rmSync(path.join(dir, '.gitignore'), { force: true });
      reference.reset(); // a reused index keeps entries that a new ignore rule would exclude; the reference starts over
    } else if (roll < 0.3 || list.length < 5) {
      const folder = g.random() < 0.2 ? `${g.pick(folders)}/${g.word()}`.replace(/^\//, '') : g.pick(folders);
      const relative = `${folder ? `${folder}/` : ''}${g.word()}.${g.pick(['js', 'txt', 'log', 'md'])}`;
      if (list.includes(relative) || exclusionOf(relative) || list.some((file) => file.startsWith(`${relative}/`) || relative.startsWith(`${file}/`))) continue;
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
      const target = `${g.pick(folders) ? `${g.pick(folders)}/` : ''}${g.word()}-moved.${relative.split('.').at(-1)}`.replace(/^\//, '');
      if (list.includes(target) || exclusionOf(target) || list.some((file) => file.startsWith(`${target}/`) || target.startsWith(`${file}/`))) continue;
      fs.mkdirSync(path.dirname(path.join(dir, target)), { recursive: true });
      fs.renameSync(path.join(dir, relative), path.join(dir, target));
      remove(relative);
      list.push(target);
      counts.rename += 1;
    }
    const expected = reference.tree();
    const cached = await engine.snapshot();
    assert.equal(cached.tree, expected, `${label} step ${step}: the cached snapshot equals the reference`);
    if (step % fullEvery === 0) {
      const full = await engine.snapshot({ full: true });
      assert.equal(full.treeAlgorithm, TREE_ALGORITHM.gitPinned, full.engineReason);
      assert.equal(full.tree, expected, `${label} step ${step}: full`);
      assert.equal(full.rawTree, expected, `${label} step ${step}: rawTree`);
      assert.equal(reference.freshTree(), expected, `${label} step ${step}: a fresh reference index agrees with the reused one`);
    }
    if (step % rawEvery === 0) assert.equal((await raw.snapshot()).tree, expected, `${label} step ${step}: raw-v1 cached`);
  }
  return counts;
}

{
  const small = generateRepo('small', 663, 663, { commit: false });
  const started = performance.now();
  const counts = await propertyTest(small, { steps: 200, fullEvery: 20, rawEvery: 1, label: '663 files' });
  ok(`property test, 663 untracked files, 200 steps ${JSON.stringify(counts)}: every cached, full, raw and raw-v1 snapshot equals the reference (${Math.round(performance.now() - started)} ms)`);
}
{
  const started = performance.now();
  const counts = await propertyTest(big, { steps: 200, fullEvery: 50, rawEvery: 25, label: '8,002 files' });
  ok(`property test, 8,002 committed files, 200 steps ${JSON.stringify(counts)}: every snapshot equals the reference (${Math.round(performance.now() - started)} ms)`);
}

console.log(`verify-proof-tree: ${checks} checks passed`);
