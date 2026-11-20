// lib/proof/tree-snapshot.mjs + lib/proof/git-plumbing.mjs: the content identity of a workspace tree (P4 pod-15).
//
// Every tree id the engine gives is compared with an independent reference (tests/support/proof-tree-fixtures.mjs): plain
// `git add -A && git write-tree` in a throw-away bare repository, with no system or global configuration.
//
//  1. object ids: blobs and trees against `git hash-object --no-filters` / `git mktree`, Git's entry order, the empty tree
//  2. exclusions: the name globs given to Git match exactly what PRIVATE_FILE matches, and the exclude lines leave out exactly what
//     exclusionOf() excludes, for whole paths; both judged BY GIT with case-sensitive matching
//  3. fixtures: worktree (.git file), submodule, sparse checkout, LFS pointer (with and without a repository LFS filter), a clean filter
//     whose program must NOT run (canary), fsmonitor and textconv, a long path, a symlink, an executable bit, CRLF with core.autocrlf=true
//     in the person's own config, a same-size edit with the modification time put back, protected files (also re-included by a
//     .gitignore), no Git, not a repository, the limits, gitlinks, ignore-rule changes, and the repository's own .git unchanged
//  4. budgets (gate G4 criterion 1), printed as one JSON line `PROOF_TREE_BUDGET {...}`
// The 200-step property tests are tests/verify-proof-tree-property.mjs (663 files) and tests/verify-proof-tree-property-8k.mjs (8,002).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PRIVATE_FILE } from '../lib/protected-paths.mjs';
import { MODE, blobId, buildTree, treeId } from '../lib/proof/git-plumbing.mjs';
import {
  LIMITATION, TREE_ALGORITHM, TreeSnapshotter, caseless, excludeLines, exclusionOf, privateFileGlobs, snapshotTree,
} from '../lib/proof/tree-snapshot.mjs';
import {
  Reference, commitAll, folderPrint, fresh, generateRepo, git, isolatedEnv, mulberry32, newRepo, percentile, scratch, snapshotter, timed, timedSync, write,
} from './support/proof-tree-fixtures.mjs';

let checks = 0;
const suiteStart = performance.now();
const elapsed = () => `${((performance.now() - suiteStart) / 1000).toFixed(1)} s`;
const ok = (label) => { checks += 1; console.log(`  ok - ${label} [${elapsed()}]`); };
const note = (label) => console.log(`  note - ${label}`);
setTimeout(() => { console.error('FAIL: the proof tree suite exceeded its own time budget'); process.exit(2); }, 170_000).unref();

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

/** The untracked files that an exclude file makes Git ignore, with case-sensitive matching (the Linux default). */
const ignoredBy = (dir, file) => git(dir, ['-c', 'core.ignorecase=false', '-c', `core.excludesFile=${file.replaceAll('\\', '/')}`, 'ls-files', '-z', '--others', '--ignored', '--exclude-standard'])
  .stdout.split('\0').filter(Boolean);

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
    'x.tfstate.12345.backup', 'x.tfstate.1234a', 'x.tfstate.1234567890', 'x.tfstate.a','x.tfstate.1a', 'x.tfstate.', 'x.tfstate.backup.1', 'tfstate', '.tfstate', 'x.tfstatex',
    'service-account.json', 'serviceaccount.json', 'service_account_key.json', 'service-account-key.json', 'serviceaccountkey.json', 'service-account-prod.json',
    'service_account.prod.json', 'service-account_key-x.json', 'service-account.yaml', 'service-accounts.json', 'service--account.json', 'service-account..json',
    'application_default_credentials.json', 'kubeconfig', 'kubeconfig.yml', 'kubeconfig.yaml', 'prod.kubeconfig', 'kubeconfig.json', 'kubeconfigs',
    'README.md', 'index.js', 'package.json', 'config.json', 'hosts.yml', '.gitignore', 'environment.ts', 'monkey.txt', 'keystore', 'x.tfvars',
  ]);
  // one name drawn from every glob (a class becomes a character it allows, a star a short run), so each glob is exercised; the verdict
  // of every name still comes from PRIVATE_FILE, not from the glob it was drawn from
  const allowed = (set) => [...'qkz7w-_.'].find((char) => !set.includes(char));
  const samples = [];
  for (const glob of privateFileGlobs()) {
    const sample = glob.replace(/\[!([^\]]+)\]/g, (_, set) => allowed(set)).replace(/\[0-9\]/g, '7').replace(/\[-_\.\]/g, '-').replace(/\?/g, 'w').replace(/\*/g, 'x1');
    samples.push(sample);
    names.add(sample);
    names.add(glob.replace(/\[!([^\]]+)\]/g, (_, set) => allowed(set)).replace(/\[0-9\]/g, '0').replace(/\[-_\.\]/g, '.').replace(/[?*]/g, ''));
  }
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
  // the globs as the engine gives them to Git: lines of core.excludesFile, case folded by caseless(), with core.ignorecase=false
  const namesFile = path.join(fresh('exclude'), 'names');
  fs.writeFileSync(namesFile, `${privateFileGlobs().map(caseless).join('\n')}\n`);
  const matched = ignoredBy(dir, namesFile);
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

  // every glob stands for protected names: the name drawn from it is in the corpus, Git matched it, and PRIVATE_FILE protects it
  for (const sample of samples) {
    if (process.platform === 'win32' && /[. ]$/.test(sample)) continue;
    assert.ok(matchedNames.has(sample), `the name ${sample} drawn from a glob is not matched`);
    assert.ok(PRIVATE_FILE.test(sample) || overMatch.test(sample), `the glob of ${sample} matches a name PRIVATE_FILE does not protect`);
  }
  ok(`each of the ${samples.length} names drawn from the globs is matched by Git and protected by PRIVATE_FILE`);

  // whole paths: the pathspecs exclude exactly what exclusionOf() excludes
  const paths = [
    'a/.ssh/id', '.ssh/config', 'deep/x/.aws/credentials.cfg', '.gnupg/k', 'k/.kube/c', 'x/.SSH/y', 'notssh/a', '.sshx/a',
    '.docker/config.json', 'h/.docker/config.json', '.docker/other.json', 'config.json', '.config/gh/hosts.yml', 'gh/hosts.yml', 'hosts.yml',
    '.azure/accessTokens.json', 'gcloud/legacy_credentials/me/adc.json', 'gcloud/credentials.db', '.m2/settings.xml', 'm2/settings.xml',
    '.chatmcp/hooks.json', 'pkg/.chatmcp/hooks.json', '.chatmcp/hooks.json.bak', '.chatmcp/other.json', '.chatmcp/runs/r1/receipt.json',
    '.chatmcp/runs', '.chatmcp/runsx/a', 'sub/.chatmcp/runs/a', '.CHATMCP/RUNS/b', 'src/.env', 'src/app.js', 'docs/secrets.json/readme',
  ];
  const linesFile = path.join(fresh('exclude'), 'lines');
  fs.writeFileSync(linesFile, `${excludeLines().join('\n')}\n`);
  const mismatch = [];
  for (const relative of paths) {
    // one repository per path: a path that is a file in one row can be a folder in another, and .chatmcp/runs is at the top
    const pathRepo = newRepo('parity-path');
    write(pathRepo, relative, 'x');
    const kept = !ignoredBy(pathRepo, linesFile).includes(relative);
    const excluded = exclusionOf(relative) !== null;
    if (excluded === kept) mismatch.push(`${relative}: exclusionOf ${exclusionOf(relative)}, git kept ${kept}`);
  }
  assert.deepEqual(mismatch, [], 'the pathspecs and exclusionOf() must agree on whole paths');
  ok(`the ${excludeLines().length} exclude lines leave out exactly what exclusionOf() excludes (${paths.length} paths: folders, locations, the hooks file, .chatmcp/runs)`);
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
  assert.equal(cached.treeAlgorithm, algorithm, `${label}: the cached snapshot keeps the algorithm`);
  assert.equal(cached.full, false);
  assert.equal(cached.rawTree, null, 'a cached snapshot has no rawTree');
  return { engine, full, expected, reference };
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
  const { expected, reference } = await expectEqual('submodule', main, new Reference(main));
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
  // a file the agent writes outside the cone is on disk, so it belongs in the tree (git add with the sparse view on would refuse it)
  write(repo, 'out/written-later.txt', 'outside the cone\n');
  await expectEqual('sparse checkout', repo, new Reference(repo));
  ok("sparse checkout: snapshots equal the reference (what the cone left off disk is not in the tree, a file written outside the cone is)");
}

{ // Git LFS pointers
  const repo = newRepo('lfs');
  const pointer = 'version https://git-lfs.github.com/spec/v1\noid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\nsize 12345\n';
  write(repo, '.gitattributes', '*.bin filter=lfs diff=lfs merge=lfs -text\n');
  write(repo, 'big.bin', pointer);
  // not a pointer: the system configuration of Git for Windows defines filter.lfs (required), which would turn it into one
  write(repo, 'real.bin', Buffer.from('real bytes, never cleaned by git-lfs\n'));
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
  const { expected, reference } = await expectEqual('symlink and executable', repo, new Reference(repo));
  const rows = reference.lsTree(expected);
  if (linked) assert.ok(rows.some((row) => row.startsWith('120000 ') && row.endsWith('\tlink')), 'a symlink is mode 120000');
  if (process.platform !== 'win32') assert.ok(rows.some((row) => row.startsWith('100755 ') && row.endsWith('\trun.sh')), 'executable bit');
  ok(`symlink${linked ? '' : ' (not on this machine)'} and executable bit${process.platform === 'win32' ? ' (not on Windows)' : ''}: raw-v1 and Git agree`);
}

{ // CRLF, with core.autocrlf=true in the person's own configuration and in the repository's
  const repo = newRepo('crlf');
  const home = fresh('home');
  const userConfig = path.join(home, '.gitconfig');
  // the person's global configuration also defines a filter; the repository's .gitattributes names it, the repository's config does not
  const { canary, command } = canaryScript(fresh('canary'));
  fs.writeFileSync(userConfig, `[core]\n\tautocrlf = true\n\tsafecrlf = true\n[filter "personal"]\n\tclean = ${command.replaceAll('"', '\\"').replace(/^/, '"').concat('"')}\n`);
  write(repo, '.gitattributes', '*.dat filter=personal\n');
  write(repo, 'data.dat', 'what the personal filter would see\n');
  // the person's own ignore and attributes files, which Git reads by default even when GIT_CONFIG_GLOBAL names another file
  write(home, '.config/git/ignore', 'unix.txt\n');
  write(home, '.config/git/attributes', '*.txt text eol=crlf\n');
  git(repo, ['config', 'core.autocrlf', 'true']);
  const crlf = Buffer.from('line one\r\nline two\r\n');
  write(repo, 'dos.txt', crlf);
  write(repo, 'unix.txt', 'lf only\n');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: userConfig, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), GIT_INDEX_FILE: path.join(repo, '.git', 'index') };
  const { expected, reference } = await expectEqual('CRLF', repo, new Reference(repo), { env });
  const row = reference.lsTree(expected).find((line) => line.endsWith('\tdos.txt'));
  const rawId = createHash('sha1').update(`blob ${crlf.length}\0`).update(crlf).digest('hex');
  assert.equal(row.split(' ')[2].split('\t')[0], rawId, 'the CRLF bytes are hashed as they are');
  // control: Git with the person's configuration converts the line endings, so the setting was live
  const control = fresh('control-crlf');
  fs.mkdirSync(path.join(control, 'objects'), { recursive: true });
  const personal = { ...process.env, GIT_CONFIG_GLOBAL: userConfig, GIT_INDEX_FILE: path.join(control, 'index'), GIT_OBJECT_DIRECTORY: path.join(control, 'objects'), GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(repo, '.git', 'objects') };
  // (safecrlf=true of the person's file would abort on unix.txt before anything is compared, so the control lifts only that one)
  const added = spawnSync('git', ['-c', 'core.safecrlf=false', 'add', '-A'], { cwd: repo, env: personal, encoding: 'utf8', windowsHide: true });
  assert.equal(added.status, 0, `control: plain git add works (${added.stderr})`);
  const converted = spawnSync('git', ['write-tree'], { cwd: repo, env: personal, encoding: 'utf8', windowsHide: true }).stdout.trim();
  assert.notEqual(converted, expected, 'control: the person\'s autocrlf=true would have changed the tree');
  assert.ok(reference.lsTree(expected).some((line) => line.endsWith('\tunix.txt')), 'the ignore file of the person does not apply');
  assert.ok(fs.existsSync(canary), 'control: plain Git with the person\'s configuration ran their filter');
  fs.rmSync(canary);
  await snapshotter(repo, { env }).snapshot({ full: true });
  assert.equal(fs.existsSync(canary), false, 'the engine never runs a filter of the person\'s global configuration');
  ok('CRLF with core.autocrlf=true for the person and the repository, plus their own ignore and attributes files: raw CRLF bytes, nothing ignored (the settings are live for plain Git)');
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
    // raw-v1 keys its cache on the change time too, which a write always moves; Git's index may not (core.trustctime, Windows)
    if (algorithm === TREE_ALGORITHM.raw) assert.equal(cached.tree, after.tree, 'raw-v1: the cached snapshot sees the new change time');
    else note(`${algorithm}: a cached snapshot ${cached.tree === after.tree ? 'also caught' : 'did not catch'} the same-size edit with the old time (only the full snapshot must)`);
  }
  ok('a same-size edit with the modification time restored is caught by the full snapshot (both engines) and by a cached raw-v1 one');

  // the raw-v1 stat cache, probed directly: an entry whose stat matches is trusted (so a poisoned id shows), a full snapshot never
  // trusts it, and an entry cached within the racy window is hashed again
  const engine = snapshotter(repo, { engine: TREE_ALGORITHM.raw });
  const truth = (await engine.snapshot({ full: true })).tree;
  const poison = blobId('poison\n');
  engine.rawCache.get('a.txt').oid = poison;
  assert.notEqual((await engine.snapshot()).tree, truth, 'an old entry with an unchanged stat is trusted');
  engine.rawCache.get('a.txt').oid = poison;
  assert.equal((await engine.snapshot({ full: true })).tree, truth, 'a full snapshot ignores the cache');
  write(repo, 'young.txt', 'just written\n');
  const young = await engine.snapshot({ full: true });
  engine.rawCache.get('young.txt').oid = poison;
  assert.equal((await engine.snapshot()).tree, young.tree, 'an entry written within the racy window is hashed again');
  ok('raw-v1 stat cache: trusted when the stat matches and the entry is old, ignored by a full snapshot, not trusted within the racy window');
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
  // a .gitignore that re-includes a secret with "!" outranks the exclude file: the tree still leaves it out, and its blob is deleted
  write(repo, '.gitignore', '!.env\n!*.pem\n');
  const literalWithIgnore = literal;
  const engine = snapshotter(repo);
  const reincluded = await engine.snapshot({ full: true });
  const expectedWithIgnore = new Reference(repo).freshTree(literalWithIgnore);
  assert.equal(reincluded.treeAlgorithm, TREE_ALGORITHM.gitPinned);
  assert.equal(reincluded.tree, expectedWithIgnore, 'a re-included secret is not in the tree');
  write(repo, 'keys/other.pem', 'SECRET 2\n');
  const cachedReincluded = await engine.snapshot();
  assert.equal(cachedReincluded.tree, expectedWithIgnore, 'nor in a cached snapshot');
  const store = folderPrint(path.join(engine.stateDir, 'objects')).join('\n');
  for (const secret of ['SECRET\n', 'SECRET 2\n']) {
    const id = blobId(secret);
    assert.equal(store.includes(`${id.slice(0, 2)}${path.sep}${id.slice(2)}`), false, 'the blob of a re-included secret is deleted from the private store');
  }
  ok(`protected files (${secrets.length}) and .chatmcp/runs (${runs.length}) are left out and counted, never written as objects, also when a .gitignore re-includes them with "!"`);
}

{ // no Git, an unusable Git, not a repository
  const repo = newRepo('no-git');
  write(repo, 'a.txt', 'a\n');
  write(repo, 'b/c.txt', 'c\n');
  const reference = new Reference(repo);
  const none = await snapshotter(repo, { git: null }).snapshot({ full: true });
  assert.equal(none.treeAlgorithm, TREE_ALGORITHM.raw);
  assert.equal(none.engineReason, 'git_missing');
  assert.deepEqual(none.excluded, { protected: 0, runs: 0, gitlinks: 0 }, 'the walk does not enter .git');
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
  const atFiles = await snapshotter(repo, { limits: { maxFiles: 30 } }).snapshot({ full: true });
  const totalBytes = Array.from({ length: 30 }, (_, index) => `file ${index}\n`.length).reduce((a, b) => a + b, 0);
  const atBytes = await snapshotter(repo, { limits: { maxBytes: totalBytes } }).snapshot({ full: true });
  assert.deepEqual([atFiles.status, atFiles.files, atBytes.status, atBytes.bytes], ['ok', 30, 'ok', totalBytes], 'exactly at a limit is still bounded');
  // raw bytes need no blob written; only what .gitattributes converts does
  const plainFiles = await snapshotter(repo, { limits: { maxNewBlobs: 5 } }).snapshot({ full: true });
  assert.equal(plainFiles.treeAlgorithm, TREE_ALGORITHM.gitPinned, 'a first scan of unconverted files writes no blob');
  const converting = newRepo('converting');
  write(converting, '.gitattributes', '*.txt text eol=lf\n');
  for (let index = 0; index < 30; index += 1) write(converting, `c${index}.txt`, `crlf ${index}\r\nline\r\n`);
  const blobs = await snapshotter(converting, { limits: { maxNewBlobs: 5 } }).snapshot({ full: true });
  assert.equal(blobs.treeAlgorithm, TREE_ALGORITHM.raw);
  assert.equal(blobs.engineReason, 'too_many_new_blobs:30');
  assert.equal(blobs.tree, buildTree([{ path: '.gitattributes', mode: MODE.file, oid: blobId('*.txt text eol=lf\n') },
    ...Array.from({ length: 30 }, (_, index) => ({ path: `c${index}.txt`, mode: MODE.file, oid: blobId(`crlf ${index}\r\nline\r\n`) }))]), 'raw-v1 keeps the CRLF bytes');
  assert.equal((await snapshotter(converting, { limits: { maxNewBlobs: 30 } }).snapshot({ full: true })).treeAlgorithm, TREE_ALGORITHM.gitPinned, 'exactly maxNewBlobs is allowed');
  const converted = await snapshotter(converting).snapshot({ full: true });
  assert.equal(converted.treeAlgorithm, TREE_ALGORITHM.gitPinned);
  assert.equal(converted.tree, new Reference(converting).freshTree(), 'git-pinned-v1 applies .gitattributes as git add does');
  assert.notEqual(converted.tree, converted.rawTree, 'and rawTree keeps the bytes');
  commitAll(repo);
  const committed = await snapshotter(repo).snapshot({ full: true });
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
  ok('more than maxFiles or maxBytes: status unbounded with no tree (exactly at a limit is fine); more new blobs than maxNewBlobs: raw-v1; an empty nested repository is counted, not fatal');
}

{ // a nested repository whose branch lives in packed-refs, and one with a detached HEAD
  const repo = newRepo('packed');
  write(repo, 'top.txt', 't\n');
  const packed = path.join(repo, 'packed');
  fs.mkdirSync(packed);
  git(packed, ['init', '-q']);
  write(packed, 'p.txt', 'p\n');
  commitAll(packed);
  git(packed, ['pack-refs', '--all']);
  assert.equal(fs.existsSync(path.join(packed, '.git', 'refs', 'heads', 'main')), false, 'the branch is only in packed-refs');
  const detached = path.join(repo, 'detached');
  fs.mkdirSync(detached);
  git(detached, ['init', '-q']);
  write(detached, 'd.txt', 'd\n');
  commitAll(detached);
  git(detached, ['checkout', '-q', '--detach']);
  await expectEqual('packed-refs and detached gitlinks', repo, new Reference(repo));
  ok('gitlinks resolved through packed-refs and a detached HEAD equal what git add records');
}

{ // a reused index after an ignore rule changes: the cached snapshot drops what the rule now excludes, and takes back what it frees
  const repo = newRepo('ignore-change');
  write(repo, 'keep.txt', 'k\n');
  write(repo, 'build/out.js', 'o\n');
  write(repo, 'debug.log', 'l\n');
  const engine = snapshotter(repo);
  const reference = new Reference(repo);
  await engine.snapshot({ full: true });
  write(repo, '.gitignore', '*.log\nbuild/\n');
  assert.equal((await engine.snapshot()).tree, reference.freshTree(), 'a new rule removes tracked entries of the reused index');
  write(repo, '.git/info/exclude', 'keep.txt\n');
  assert.equal((await engine.snapshot()).tree, reference.freshTree(), 'so does a change to .git/info/exclude');
  fs.rmSync(path.join(repo, '.gitignore'));
  fs.writeFileSync(path.join(repo, '.git', 'info', 'exclude'), '');
  assert.equal((await engine.snapshot()).tree, reference.freshTree(), 'and files a rule no longer excludes come back');
  ok('a cached snapshot follows .gitignore and .git/info/exclude changes like a fresh index');
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
  const env = { ...process.env, GIT_INDEX_FILE: path.join(dotGit, 'index'), GIT_OBJECT_DIRECTORY: path.join(dotGit, 'objects'), GIT_DIR: dotGit, GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(dotGit, 'objects') };
  const engine = snapshotter(repo, { env });
  const first = await engine.snapshot({ full: true });
  write(repo, 'src/m3.js', 'edited again\n');
  await engine.snapshot();
  // blobs the repository already has: a rename and an edit put back. Git would "freshen" them if it could see the repository's store.
  fs.mkdirSync(path.join(repo, 'moved'));
  fs.renameSync(path.join(repo, 'src', 'm5.js'), path.join(repo, 'moved', 'm5.js'));
  write(repo, 'src/m1.js', 'export const m1 = 1;\n');
  write(repo, 'src/copy-of-m7.js', 'export const m7 = 7;\n');
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

// ------------------------------------------------------------------ 4. budgets on a generated 8,002-file repository
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

console.log(`verify-proof-tree: ${checks} checks passed`);
