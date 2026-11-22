// lib/proof/baseline.mjs: observe mode, the baseline store, the diff and the patch hash (P4 pod-25, docs/PROOF-BASELINE.md).
//
// Every case runs on real temporary folders and Git repositories. What it proves:
//   1. a baseline record holds the tree ids, the gzip manifest, the acceptance file, the package.json scripts, HEAD, a dirty summary and
//      the toolchain; protected files are in neither the manifest nor the store; the repository's .git is byte for byte unchanged;
//   2. the agent edits, commits, deletes and renames files, switches branches, rewrites history and runs `git gc --prune=now`: the
//      baseline objects survive (they live in a private store), and the patch applied to a fresh checkout of the baseline gives the
//      final tree id exactly (binary, CRLF, a path with spaces and Vietnamese letters, a deleted file, a mode change on POSIX);
//   3. the store level on every system: a mode change, a symbolic link, a submodule, an empty file; the patch bytes are reproducible;
//   4. an empty diff, a plain folder (manifest change list and `patch: unavailable`), no Git;
//   5. the lock: in-process and cross-process waiting, refusal after the wait, stale locks of a crashed process, an old heartbeat, another
//      host, unreadable content; four concurrent baselines of one workspace, none corrupt;
//   6. retention by count and by age, leftovers; an edited, re-hashed, moved, missing or forged baseline is refused or reported;
//   7. budgets on a 663-file and an 8,002-file repository, printed as PROOF_BASELINE_BUDGET {...}.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import {
  BASELINE_FORMAT, BASELINE_DIFF_FORMAT, LOCK_RULES, RETENTION, STORE_REF,
  acquireWorkspaceLock, baselineFolder, decodeManifest, diffBaseline, encodeManifest, importTree, initStore, listBaselines, loadBaseline,
  manifestChanges, patchReproduces, pruneBaselines, snapshotBaseline, treePatch, workspaceKey,
} from '../lib/proof/baseline.mjs';
import { blobId, buildTree, findGit } from '../lib/proof/git-plumbing.mjs';
import { TREE_ALGORITHM, TreeSnapshotter } from '../lib/proof/tree-snapshot.mjs';
import { Reference, commitAll, folderPrint, fresh, generateRepo, git, newRepo, write } from './support/proof-tree-fixtures.mjs';

let checks = 0;
const suiteStart = performance.now();
const elapsed = () => `${((performance.now() - suiteStart) / 1000).toFixed(1)} s`;
const ok = (label) => { checks += 1; console.log(`  ok - ${label} [${elapsed()}]`); };
setTimeout(() => { console.error('FAIL: the proof baseline suite exceeded its own time budget'); process.exit(2); }, 170_000).unref();

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const EMPTY_SHA256 = sha256(Buffer.alloc(0));
const POSIX = process.platform !== 'win32';
const DAY = 24 * 60 * 60 * 1000;
const FAKE_TOOLCHAIN = Object.freeze({ node: '24.0.0', python: null, dotnet: null, git: '2.50.0' });
const toolchain = { versions: async () => ({ ...FAKE_TOOLCHAIN }) };
const MODULE_URL = pathToFileURL(path.resolve(import.meta.dirname, '../lib/proof/baseline.mjs')).href;
const GIT = await findGit();
assert.ok(GIT, 'this suite needs Git on PATH');
const storeOf = (hubDir, root, record) => path.join(baselineFolder(hubDir, root), record.store.directory);
const paths = (rows) => rows.map((row) => row.path);
const rejectsWith = async (promise, code, label) => {
  await assert.rejects(promise, (error) => { assert.equal(error?.code, code, `${label}: ${error?.message}`); return true; }, label);
};

/** A fresh clone of the baseline from the private store: the files as they were when the baseline was taken. */
function checkoutBaseline(storeDirectory, ref = STORE_REF) {
  const dir = fresh('checkout');
  git(dir, ['init', '-q']);
  git(dir, ['fetch', '-q', storeDirectory, `${ref}:refs/heads/base`]);
  git(dir, ['checkout', '-q', 'base']);
  return dir;
}
/** The manifest format written by hand: gzip of the JSON rows [path, mode, oid], its sha256 over the JSON text. */
const craftManifest = (rows) => {
  const json = JSON.stringify(rows.map((row) => [row.path, row.mode, row.oid]));
  return { encoding: 'gzip+base64', entries: rows.length, sha256: sha256(json), data: zlib.gzipSync(json).toString('base64') };
};
const NO_ENV = [':(exclude,literal).env'];
function applyPatch(dir, bytes) {
  if (!bytes.length) return;
  const file = path.join(fresh('patch'), 'change.patch');
  fs.writeFileSync(file, bytes);
  git(dir, ['apply', '--index', '--binary', '--whitespace=nowarn', file]);
}

const ACCEPTANCE = `version: 1
criteria:
  - id: unit
    text: Unit tests pass
    checks:
      - run: npm test
`;

// ------------------------------------------------------------------ 1 + 2: the agent scenario on a real repository
{
  const hub = fresh('hub');
  const repo = newRepo('agent');
  const appV1 = 'console.log(1);\n';
  const crlfV1 = 'line one\r\nline two\r\n';
  const binV1 = Buffer.from([0, 1, 2, 3, 0, 255, 254, 0, 7]);
  write(repo, 'src/app.js', appV1);
  write(repo, 'src/keep.txt', 'unchanged\n');
  write(repo, 'windows.txt', crlfV1);
  write(repo, 'assets/logo.bin', binV1);
  write(repo, 'docs/tài liệu cũ.md', '# cũ\nnội dung\n');
  write(repo, 'old/remove-me.txt', 'bye\n');
  write(repo, 'run.sh', '#!/bin/sh\necho hi\n');
  write(repo, 'package.json', `${JSON.stringify({ name: 'demo', scripts: { test: 'node --test', lint: 'eslint .', weird: 7 } }, null, 2)}\n`);
  write(repo, '.chatmcp/acceptance.yml', ACCEPTANCE);
  write(repo, '.gitignore', 'build/\n');
  write(repo, '.gitattributes', 'conv/*.dat text eol=lf\n');
  write(repo, 'conv/crlf.dat', 'converted\r\nby git\r\n');
  commitAll(repo);
  const firstCommit = git(repo, ['rev-parse', 'HEAD']).stdout.trim();
  write(repo, 'notes/untracked draft.txt', 'not committed yet\n');
  write(repo, 'build/out.js', 'ignored output\n');
  const secret = 'API_KEY=pod25-secret-value-for-the-test\n';
  write(repo, '.env', secret);

  const dotGit = folderPrint(path.join(repo, '.git'));
  const base = await snapshotBaseline({ hubDir: hub, root: repo, toolchain });
  assert.deepEqual(folderPrint(path.join(repo, '.git')), dotGit, "taking a baseline writes nothing below the repository's .git");
  const { record } = base;
  const reference = new Reference(repo);
  assert.equal(record.format, BASELINE_FORMAT);
  assert.equal(record.id, base.id);
  assert.match(base.id, /^\d{8}T\d{9}Z-[0-9a-f]{8}$/);
  assert.equal(record.treeAlgorithm, TREE_ALGORITHM.gitPinned);
  assert.equal(record.tree, reference.tree(NO_ENV), 'the baseline tree is what git add -A gives (the protected .env left out)');
  assert.notEqual(record.rawTree, record.tree, 'the .gitattributes conversion makes the raw tree differ');
  assert.equal(record.objectFormat, 'sha1');
  assert.deepEqual(record.workspace, { key: workspaceKey(repo), root: path.resolve(repo) });
  const manifest = decodeManifest(record.manifest);
  assert.equal(record.manifest.entries, manifest.length);
  assert.equal(buildTree(manifest), record.tree, 'the manifest rebuilds the tree');
  assert.ok(manifest.some((row) => row.path === 'notes/untracked draft.txt'), 'an untracked file is in the baseline');
  assert.ok(!manifest.some((row) => row.path === '.env' || row.path.startsWith('build/')), 'protected and ignored files are not');
  assert.equal(manifest.find((row) => row.path === 'assets/logo.bin').oid, blobId(binV1));
  assert.equal(manifest.find((row) => row.path === 'conv/crlf.dat').oid, blobId(Buffer.from('converted\nby git\n')), 'the converted blob, as Git stores it');
  assert.deepEqual(record.acceptance, {
    path: '.chatmcp/acceptance.yml', present: true, bytes: Buffer.byteLength(ACCEPTANCE), sha256: sha256(ACCEPTANCE), content: Buffer.from(ACCEPTANCE).toString('base64'),
  });
  assert.deepEqual(record.packageScripts, { present: true, scripts: { test: 'node --test', lint: 'eslint .' }, problem: null }, 'only string scripts are kept');
  assert.equal(record.git.repository, true);
  assert.equal(record.git.head, firstCommit);
  assert.equal(record.git.branch, 'main');
  assert.deepEqual(record.git.dirty, { clean: false, added: 1, modified: 0, deleted: 0 }, 'dirty against HEAD: the untracked draft');
  assert.deepEqual(record.toolchain, FAKE_TOOLCHAIN);
  assert.deepEqual(record.patch, { available: true, reason: null });
  assert.equal(record.store.ref, STORE_REF);
  assert.equal(record.store.directory, `${base.id}.git`);
  const file = path.join(baselineFolder(hub, repo), `${base.id}.json`);
  assert.equal(base.file, file);
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.endsWith(`,"recordSha256":"${base.sha256}"}\n`) && text.indexOf('\n') === text.length - 1, 'one line that ends with its own hash');
  assert.ok(!text.includes('pod25-secret-value'), 'the secret is not in the record');
  const store = storeOf(hub, repo, record);
  const objects = git(store, ['cat-file', '--batch-all-objects', '--batch-check'], { env: { ...process.env, GIT_DIR: store } }).stdout;
  assert.ok(!objects.includes(blobId(Buffer.from(secret))), 'the protected file is not in the store');
  assert.ok(objects.includes(blobId(Buffer.from('not committed yet\n'))), 'the untracked file is');
  assert.deepEqual(await listBaselines({ hubDir: hub, root: repo }), [{ id: base.id, createdAt: record.createdAt, file, store: true }]);
  ok('a baseline of a Git workspace: tree ids, manifest, acceptance, scripts, HEAD, dirty summary, toolchain, store; .env and .git untouched');

  // The agent works: edits (text, CRLF, binary), deletes, renames, adds a path with spaces and Vietnamese letters, chmod on POSIX,
  // commits on a new branch, switches branches back and forth, rewrites history into an orphan commit, drops every old branch and
  // prunes the repository's objects.
  write(repo, 'src/app.js', 'console.log(2);\n');
  write(repo, 'windows.txt', 'line one\r\nline 2\r\nline three\r\n');
  write(repo, 'assets/logo.bin', Buffer.from([0, 1, 2, 4, 0, 255, 254, 0, 7, 9]));
  fs.rmSync(path.join(repo, 'old/remove-me.txt'));
  fs.renameSync(path.join(repo, 'docs/tài liệu cũ.md'), path.join(repo, 'docs/tài liệu mới.md'));
  write(repo, 'docs/hướng dẫn mới/ghi chú 1.txt', 'xin chào\n');
  write(repo, 'conv/crlf.dat', 'converted\r\nagain by git\r\n');
  if (POSIX) fs.chmodSync(path.join(repo, 'run.sh'), 0o755);
  git(repo, ['switch', '-q', '-c', 'feature']);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'work']);
  git(repo, ['switch', '-q', 'main']);
  assert.equal(fs.readFileSync(path.join(repo, 'src/app.js'), 'utf8'), appV1, 'main has the old file back');
  git(repo, ['switch', '-q', 'feature']);
  git(repo, ['checkout', '-q', '--orphan', 'rewritten']);
  git(repo, ['commit', '-q', '-m', 'squashed']);
  git(repo, ['branch', '-q', '-D', 'main', 'feature']);
  git(repo, ['reflog', 'expire', '--expire=now', '--all']);
  git(repo, ['gc', '-q', '--prune=now']);
  for (const gone of [firstCommit, blobId(Buffer.from(appV1)), blobId(binV1), blobId(Buffer.from('bye\n'))]) {
    assert.notEqual(git(repo, ['cat-file', '-e', gone], { allowFail: true }).status, 0, `the repository no longer has ${gone}`);
  }
  const finalTree = new Reference(repo).tree(NO_ENV);
  const dotGitAfterAgent = folderPrint(path.join(repo, '.git'));
  const diff = await diffBaseline({ hubDir: hub, root: repo, id: base.id, expectSha256: base.sha256 });
  assert.deepEqual(folderPrint(path.join(repo, '.git')), dotGitAfterAgent, "the diff writes nothing below the repository's .git");
  assert.equal(diff.format, BASELINE_DIFF_FORMAT);
  assert.equal(diff.baselineId, base.id);
  assert.equal(diff.baselineSha256, base.sha256);
  assert.equal(diff.verifiedAgainst, 'anchor');
  assert.equal(diff.baseline.tree, record.tree);
  assert.equal(diff.final.tree, finalTree, 'the final tree is what git add -A gives now');
  assert.equal(diff.sameTree, false);
  assert.deepEqual(paths(diff.changes.added), ['docs/hướng dẫn mới/ghi chú 1.txt', 'docs/tài liệu mới.md']);
  assert.deepEqual(paths(diff.changes.deleted), ['docs/tài liệu cũ.md', 'old/remove-me.txt']);
  assert.deepEqual(paths(diff.changes.modified), ['assets/logo.bin', 'conv/crlf.dat', ...(POSIX ? ['run.sh'] : []), 'src/app.js', 'windows.txt']);
  assert.deepEqual(diff.changes.modified.find((row) => row.path === 'src/app.js'), {
    path: 'src/app.js', oldMode: '100644', newMode: '100644', oldOid: blobId(Buffer.from(appV1)), newOid: blobId(Buffer.from('console.log(2);\n')),
  });
  assert.deepEqual(diff.counts, { added: 2, modified: POSIX ? 5 : 4, deleted: 2 });
  assert.equal(diff.changes.modified.find((row) => row.path === 'conv/crlf.dat').newOid, blobId(Buffer.from('converted\nagain by git\n')));
  assert.equal(diff.patch.status, 'ok', diff.patch.reason);
  assert.equal(diff.patch.sha256, sha256(diff.patchBytes));
  assert.equal(diff.patch.bytes, diff.patchBytes.length);
  assert.equal(diff.patch.reproduces, true);
  assert.match(diff.patch.git, /^git version /);
  const patchText = diff.patchBytes.toString('utf8');
  assert.ok(patchText.includes('GIT binary patch'), 'the binary file is a binary patch');
  assert.ok(patchText.includes('+line 2\r\n'), 'CRLF lines keep their CR');
  assert.ok(patchText.includes('docs/hướng dẫn mới/ghi chú 1.txt'), 'non-ASCII paths are written as they are');
  assert.ok(!patchText.includes('rename from') && patchText.includes('diff --git a/docs/tài liệu cũ.md b/docs/tài liệu cũ.md\ndeleted file mode 100644'), 'no rename is guessed: a deletion and an addition');
  if (POSIX) assert.ok(patchText.includes('old mode 100644\nnew mode 100755'), 'the mode change is in the patch');
  const checkout = checkoutBaseline(storeOf(hub, repo, record));
  assert.equal(git(checkout, ['rev-parse', 'HEAD^{tree}']).stdout.trim(), record.tree, 'the fresh checkout is the baseline');
  assert.equal(fs.readFileSync(path.join(checkout, 'notes/untracked draft.txt'), 'utf8'), 'not committed yet\n');
  applyPatch(checkout, diff.patchBytes);
  assert.equal(git(checkout, ['write-tree']).stdout.trim(), finalTree, 'the patch applied to the baseline gives the final tree id exactly');
  for (const relative of ['windows.txt', 'assets/logo.bin', 'docs/hướng dẫn mới/ghi chú 1.txt', 'docs/tài liệu mới.md']) {
    assert.deepEqual(fs.readFileSync(path.join(checkout, relative)), fs.readFileSync(path.join(repo, relative)), `${relative}: same bytes`);
  }
  assert.ok(!fs.existsSync(path.join(checkout, 'old/remove-me.txt')), 'the deleted file is deleted');
  const again = await diffBaseline({ hubDir: hub, root: repo, id: base.id });
  assert.equal(again.verifiedAgainst, 'self');
  assert.equal(again.patch.sha256, diff.patch.sha256, 'the same two trees give the same patch bytes');
  ok('the agent commits, switches branches, rewrites history and prunes; the patch on a fresh checkout of the baseline gives the final tree');
}

// ------------------------------------------------------------------ 3: the store level on every system
{
  const store = path.join(fresh('store'), 'synthetic.git');
  await initStore(store);
  const rows = (spec) => Object.entries(spec).map(([file, value]) => ({
    path: file, mode: value.mode ?? '100644', oid: value.oid ?? blobId(Buffer.from(value.content)), content: value.content === undefined ? null : Buffer.from(value.content),
  }));
  const contentOf = (list) => async (entry) => list.find((row) => row.oid === entry.oid && row.content).content;
  const strip = (list) => list.map(({ path: file, mode, oid }) => ({ path: file, mode, oid }));
  const before = rows({
    'run.sh': { content: '#!/bin/sh\necho hi\n' },
    link: { mode: '120000', content: 'target.txt' },
    'vendor/lib': { mode: '160000', oid: 'a'.repeat(40) },
    'crlf.txt': { content: 'a\r\nb\r\n' },
    'data.bin': { content: '\u0000\u0001\u0002binary' },
    'tên có dấu/và khoảng trắng.txt': { content: 'một\n' },
  });
  const after = rows({
    'run.sh': { mode: '100755', content: '#!/bin/sh\necho hi\n' },
    link: { mode: '120000', content: 'other.txt' },
    'vendor/lib': { mode: '160000', oid: 'b'.repeat(40) },
    'crlf.txt': { content: 'a\r\nB\r\nc\r\n' },
    'data.bin': { content: '\u0000\u0001\u0003binary!' },
    'empty.txt': { content: '' },
    // names fast-import must have quoted; Git for Windows refuses both (core.protectNTFS), and NTFS cannot hold them anyway
    ...(POSIX ? { '"quoted" name.txt': { content: 'a name that starts with a quote\n' }, 'line\nbreak.txt': { content: 'a name with a line end\n' } } : {}),
  });
  const a = await importTree({ git: GIT, gitDir: store, entries: strip(before), contentOf: contentOf(before), ref: 'refs/test/a' });
  assert.equal(a.tree, buildTree(strip(before)));
  assert.match(a.commit, /^[0-9a-f]{40}$/);
  const b = await importTree({ git: GIT, gitDir: store, entries: strip(after), contentOf: contentOf(after), known: new Set(before.map((row) => row.oid)), ref: 'refs/test/b' });
  assert.equal(b.tree, buildTree(strip(after)));
  const patch = await treePatch({ git: GIT, gitDir: store, from: a.tree, to: b.tree });
  const text = patch.bytes.toString('utf8');
  assert.equal(patch.sha256, sha256(patch.bytes));
  assert.ok(text.includes('diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n'), 'a mode change');
  assert.ok(text.includes('-target.txt\n\\ No newline at end of file\n+other.txt'), 'a symbolic link is its target');
  assert.ok(text.includes('-Subproject commit aaaa') && text.includes('+Subproject commit bbbb'), 'a submodule is its commit');
  assert.ok(text.includes('new file mode 100644') && text.includes('b/empty.txt'), 'an empty file is added');
  assert.ok(text.includes('deleted file mode 100644') && text.includes('a/tên có dấu/và khoảng trắng.txt'), 'a file with spaces and Vietnamese letters is deleted');
  assert.equal(await patchReproduces({ git: GIT, gitDir: store, from: a.tree, to: b.tree, patch: patch.bytes }), true);
  assert.equal(await patchReproduces({ git: GIT, gitDir: store, from: a.tree, to: a.tree, patch: patch.bytes }), false, 'a patch that leads elsewhere does not reproduce');
  assert.equal(await patchReproduces({ git: GIT, gitDir: store, from: a.tree, to: b.tree, patch: Buffer.alloc(0) }), false, 'an empty patch between two trees does not');
  if (POSIX) assert.ok(text.includes('"b/\\"quoted\\" name.txt"') && text.includes('"b/line\\nbreak.txt"'), 'Git quotes the names fast-import needed quoted');
  assert.deepEqual((await treePatch({ git: GIT, gitDir: store, from: a.tree, to: b.tree })).bytes, patch.bytes, 'the bytes are the same every time');
  const none = await treePatch({ git: GIT, gitDir: store, from: b.tree, to: b.tree });
  assert.deepEqual(none, { bytes: Buffer.alloc(0), sha256: EMPTY_SHA256 });
  assert.equal(await patchReproduces({ git: GIT, gitDir: store, from: b.tree, to: b.tree, patch: none.bytes }), true, 'an empty patch reproduces the same tree');
  await rejectsWith(treePatch({ git: GIT, gitDir: store, from: a.tree, to: b.tree, maxBytes: 64 }), 'patch_too_large', 'a patch over the limit');
  if (POSIX) {
    const checkout = checkoutBaseline(store, 'refs/test/a');
    applyPatch(checkout, patch.bytes);
    assert.equal(git(checkout, ['write-tree']).stdout.trim(), b.tree, 'applied to a checkout on POSIX');
  }
  await rejectsWith(importTree({ git: GIT, gitDir: store, entries: strip(before), contentOf: async () => Buffer.from('other bytes'), ref: 'refs/test/c' }), 'workspace_changed', 'bytes that are not the blob');
  await rejectsWith(importTree({ git: GIT, gitDir: store, entries: [{ path: 'x', mode: '100644', oid: 'c'.repeat(40) }], contentOf: async () => null, known: new Set(['c'.repeat(40)]), ref: 'refs/test/d' }), 'objects_missing', 'a known blob the store lacks');
  ok('the store level: mode change, symbolic link, submodule, empty file, CRLF, binary, non-ASCII path; reproducible bytes; limits and refusals');
}

// ------------------------------------------------------------------ 4: an empty diff, no Git, a plain folder
{
  const hub = fresh('hub');
  const repo = newRepo('quiet');
  write(repo, 'a.txt', 'a\n');
  write(repo, 'b/c.txt', 'c\r\n');
  commitAll(repo);
  const base = await snapshotBaseline({ hubDir: hub, root: repo, toolchain: null });
  assert.equal(base.record.toolchain, null);
  assert.deepEqual(base.record.git.dirty, { clean: true, added: 0, modified: 0, deleted: 0 });
  assert.deepEqual(base.record.acceptance, { path: '.chatmcp/acceptance.yml', present: false, bytes: null, sha256: null, content: null });
  assert.deepEqual(base.record.packageScripts, { present: false, scripts: null, problem: null });
  const diff = await diffBaseline({ hubDir: hub, root: repo, id: base.id, expectSha256: base.sha256 });
  assert.equal(diff.sameTree, true);
  assert.deepEqual(diff.changes, { added: [], modified: [], deleted: [] });
  assert.deepEqual(diff.patch, { status: 'ok', reason: null, sha256: EMPTY_SHA256, bytes: 0, reproduces: true, git: diff.patch.git });
  assert.deepEqual(diff.patchBytes, Buffer.alloc(0));
  write(repo, 'a.txt', 'A\n');
  const noGit = await diffBaseline({ hubDir: hub, root: repo, id: base.id, git: null });
  assert.equal(noGit.final.treeAlgorithm, TREE_ALGORITHM.raw);
  assert.deepEqual(noGit.patch, { status: 'unavailable', reason: 'git_missing' });
  assert.equal(noGit.patchBytes, null);
  assert.deepEqual(paths(noGit.changes.modified), ['a.txt'], 'the change list still comes from the manifests');
  const missing = await snapshotBaseline({ hubDir: hub, root: repo, git: null, toolchain: null });
  assert.equal(missing.record.store, null);
  assert.deepEqual(missing.record.patch, { available: false, reason: 'git_missing' });
  assert.equal(missing.record.snapshot.engineReason, 'git_missing');
  ok('an empty diff gives an empty patch that reproduces; without Git the patch is unavailable and the change list remains');

  const plain = fresh('plain');
  write(plain, 'a.txt', 'one\n');
  write(plain, 'b/c.bin', Buffer.from([1, 0, 2]));
  write(plain, 'gone.txt', 'soon gone\n');
  const bigAcceptance = `# ${'x'.repeat(70 * 1024)}\n`;
  write(plain, '.chatmcp/acceptance.yml', bigAcceptance);
  write(plain, 'package.json', '{ not json');
  const plainBase = await snapshotBaseline({ hubDir: hub, root: plain }); // the real toolchain probe, once
  const { record } = plainBase;
  assert.equal(record.treeAlgorithm, TREE_ALGORITHM.raw);
  assert.equal(record.snapshot.engineReason, 'not_a_repository');
  assert.equal(record.store, null);
  assert.deepEqual(record.patch, { available: false, reason: 'not_a_repository' });
  assert.deepEqual(record.git, { repository: false, head: null, branch: null, dirty: null, dirtyReason: 'not_a_repository' });
  assert.deepEqual(record.acceptance, { path: '.chatmcp/acceptance.yml', present: true, bytes: Buffer.byteLength(bigAcceptance), sha256: sha256(bigAcceptance), content: null }, 'over 64 KiB: the hash only');
  assert.deepEqual(record.packageScripts, { present: true, scripts: null, problem: 'not_json' });
  assert.match(record.toolchain.node, /^\d+\.\d+\.\d+/, 'the real probe reads the Node of PATH');
  assert.match(record.toolchain.git, /^\d+\.\d+/);
  assert.ok(!fs.readdirSync(baselineFolder(hub, plain)).some((name) => name.endsWith('.git')), 'no store for a plain folder');
  write(plain, 'a.txt', 'two\n');
  fs.rmSync(path.join(plain, 'gone.txt'));
  write(plain, 'd e/f.txt', 'new\n');
  const plainDiff = await diffBaseline({ hubDir: hub, root: plain, id: plainBase.id });
  assert.deepEqual(plainDiff.patch, { status: 'unavailable', reason: 'not_a_repository' });
  assert.equal(plainDiff.patchBytes, null);
  assert.deepEqual(plainDiff.changes, {
    added: [{ path: 'd e/f.txt', mode: '100644', oid: blobId(Buffer.from('new\n')) }],
    modified: [{ path: 'a.txt', oldMode: '100644', newMode: '100644', oldOid: blobId(Buffer.from('one\n')), newOid: blobId(Buffer.from('two\n')) }],
    deleted: [{ path: 'gone.txt', mode: '100644', oid: blobId(Buffer.from('soon gone\n')) }],
  });
  ok('a plain folder: raw-v1, no store, a manifest change list with hashes and patch: unavailable (not_a_repository); the real toolchain probe');
}

// ------------------------------------------------------------------ manifest helpers
{
  const rows = [{ path: 'b.txt', mode: '100644', oid: 'b'.repeat(40) }, { path: 'a b/ç.txt', mode: '100755', oid: 'a'.repeat(40) }];
  const encoded = encodeManifest(rows);
  const crafted = craftManifest([rows[1], rows[0]]);
  assert.deepEqual({ ...encoded, data: null }, { ...crafted, data: null }, 'the documented format: rows in path order, sha256 of the JSON text');
  assert.deepEqual(decodeManifest(encoded), [rows[1], rows[0]], 'decoded in path order');
  assert.deepEqual(decodeManifest(crafted), [rows[1], rows[0]]);
  assert.equal(encodeManifest([...rows].reverse()).sha256, encoded.sha256, 'the order of the input does not matter');
  assert.throws(() => decodeManifest({ ...encoded, sha256: '0'.repeat(64) }), { code: 'baseline_bad_record' });
  assert.throws(() => decodeManifest({ ...encoded, data: 'not gzip' }), { code: 'baseline_bad_record' });
  assert.throws(() => decodeManifest({ ...encoded, encoding: 'zip' }), { code: 'baseline_bad_record' });
  assert.throws(() => decodeManifest({ ...encoded, entries: 3 }), { code: 'baseline_bad_record' }, 'a count that is not the rows');
  assert.throws(() => decodeManifest(null), { code: 'baseline_bad_record' });
  const refused = [
    ['a path twice', [rows[0], rows[0]]],
    ['an unknown mode', [{ path: 'x', mode: '100666', oid: 'a'.repeat(40) }]],
    ['an object id that is not hex', [{ path: 'x', mode: '100644', oid: 'xyz' }]],
    ['a path out of order', [rows[0], rows[1]]],
    ['a path that climbs', [{ path: '../x', mode: '100644', oid: 'a'.repeat(40) }]],
    ['a row that is not three strings', [{ path: 7, mode: '100644', oid: 'a'.repeat(40) }]],
  ];
  for (const [label, list] of refused) assert.throws(() => decodeManifest(craftManifest(list)), { code: 'baseline_bad_record' }, label);
  const changes = manifestChanges(
    [{ path: 'same', mode: '100644', oid: '1'.repeat(40) }, { path: 'gone', mode: '100644', oid: '2'.repeat(40) }, { path: 'mode', mode: '100644', oid: '3'.repeat(40) }],
    [{ path: 'same', mode: '100644', oid: '1'.repeat(40) }, { path: 'mode', mode: '100755', oid: '3'.repeat(40) }, { path: 'came', mode: '120000', oid: '4'.repeat(40) }],
  );
  assert.deepEqual(changes, {
    added: [{ path: 'came', mode: '120000', oid: '4'.repeat(40) }],
    modified: [{ path: 'mode', oldMode: '100644', newMode: '100755', oldOid: '3'.repeat(40), newOid: '3'.repeat(40) }],
    deleted: [{ path: 'gone', mode: '100644', oid: '2'.repeat(40) }],
  });
  assert.equal(workspaceKey(`${os.tmpdir()}${path.sep}a${path.sep}..${path.sep}b`), workspaceKey(path.join(os.tmpdir(), 'b')), 'the path is resolved first');
  assert.equal(workspaceKey('some/where'), workspaceKey(path.resolve('some/where')), 'a relative path names the folder it resolves to');
  assert.match(workspaceKey('C:/some/where'), /^[0-9a-f]{32}$/);
  assert.notEqual(workspaceKey('/one'), workspaceKey('/two'));
  if (!POSIX) assert.equal(workspaceKey('C:\\Work\\Repo'), workspaceKey('c:\\work\\repo'), 'case does not matter on Windows');
  assert.equal(baselineFolder('/hub', '/one'), path.join('/hub', 'proof', 'baselines', workspaceKey('/one')));
  ok('the manifest: gzip + base64, path order, its own sha256, refusals; the change list; the workspace key and folder');
}

// ------------------------------------------------------------------ 5: the lock
function child(code) {
  const proc = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
  let buffer = '';
  const waiters = [];
  proc.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (const waiter of [...waiters]) if (buffer.includes(waiter.text)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(buffer); }
  });
  const exited = new Promise((resolve) => proc.once('exit', (code) => resolve(code)));
  return {
    proc,
    exited,
    output: () => buffer,
    waitFor: (text) => (buffer.includes(text) ? Promise.resolve(buffer) : new Promise((resolve) => waiters.push({ text, resolve }))),
  };
}
const holder = (hubDir, root, after) => child(`
import { acquireWorkspaceLock } from ${JSON.stringify(MODULE_URL)};
const lock = await acquireWorkspaceLock({ hubDir: ${JSON.stringify(hubDir)}, root: ${JSON.stringify(root)} });
process.stdout.write('held\\n');
${after}
`);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
{
  assert.deepEqual({ ...LOCK_RULES }, { waitMs: 60_000, staleMs: 120_000, heartbeatMs: 15_000, pollMs: 50, breakGraceMs: 10_000 }, 'the documented lock rules');
  const hub = fresh('hub');
  const root = fresh('locked');
  const lockFile = path.join(baselineFolder(hub, root), 'lock');
  // in-process: the second waits for the first
  const order = [];
  const first = await acquireWorkspaceLock({ hubDir: hub, root });
  const second = acquireWorkspaceLock({ hubDir: hub, root }).then((lock) => { order.push('second'); return lock; });
  await wait(150);
  order.push('first released');
  await first.release();
  await (await second).release();
  assert.deepEqual(order, ['first released', 'second']);
  assert.ok(!fs.existsSync(lockFile), 'released: no lock file');
  const quick = await acquireWorkspaceLock({ hubDir: hub, root });
  await rejectsWith(acquireWorkspaceLock({ hubDir: hub, root, lock: { waitMs: 100 } }), 'baseline_busy', 'in-process, after the wait');
  await quick.release();

  // another process holds it: refused after the wait, then waited for
  const other = holder(hub, root, "process.stdin.once('data', async () => { await lock.release(); process.stdout.write('released\\n'); process.exit(0); });");
  await other.waitFor('held');
  const info = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  assert.equal(info.pid, other.proc.pid);
  assert.equal(info.host, os.hostname());
  await rejectsWith(acquireWorkspaceLock({ hubDir: hub, root, lock: { waitMs: 300 } }), 'baseline_busy', 'another live process, after the wait');
  const started = performance.now();
  const waiting = acquireWorkspaceLock({ hubDir: hub, root, lock: { waitMs: 20_000 } });
  await wait(500);
  other.proc.stdin.write('go\n');
  const got = await waiting;
  assert.ok(performance.now() - started >= 450, 'it waited for the other process');
  await got.release();
  await other.exited;

  // a crashed holder leaves a stale lock: taken at once
  const crashed = holder(hub, root, "process.kill(process.pid, 'SIGKILL');");
  await crashed.waitFor('held');
  await crashed.exited;
  assert.ok(fs.existsSync(lockFile), 'the crashed process left its lock');
  let t = performance.now();
  const afterCrash = await acquireWorkspaceLock({ hubDir: hub, root, lock: { waitMs: 5_000 } });
  assert.ok(performance.now() - t < 2_000, 'a lock of a dead process is broken at once');
  await afterCrash.release();

  // a live process whose heartbeat stopped, another host, unreadable content, a leftover of this very process
  const idle = child('setInterval(() => {}, 1000); process.stdout.write("up\\n");');
  await idle.waitFor('up');
  const plant = (content, ageMs) => {
    fs.writeFileSync(lockFile, content);
    const when = new Date(Date.now() - ageMs);
    fs.utimesSync(lockFile, when, when);
  };
  const dead = crashed.proc.pid; // no process here has this id now: on another host it must still count as alive
  const cases = [
    ['live pid, fresh heartbeat', JSON.stringify({ pid: idle.proc.pid, host: os.hostname(), token: 't1' }), 0, 'busy'],
    ['live pid, heartbeat older than staleMs', JSON.stringify({ pid: idle.proc.pid, host: os.hostname(), token: 't2' }), LOCK_RULES.staleMs + 5_000, 'taken'],
    ['another host, fresh', JSON.stringify({ pid: dead, host: 'another-machine.invalid', token: 't3' }), 0, 'busy'],
    ['another host, old', JSON.stringify({ pid: dead, host: 'another-machine.invalid', token: 't4' }), LOCK_RULES.staleMs + 5_000, 'taken'],
    ['unreadable, being written', '', 0, 'busy'],
    ['unreadable, old', '{"pid":', LOCK_RULES.breakGraceMs + 5_000, 'taken'],
    ['this process, not held', JSON.stringify({ pid: process.pid, host: os.hostname(), token: 'leftover' }), 0, 'taken'],
  ];
  for (const [label, content, age, expected] of cases) {
    plant(content, age);
    if (expected === 'busy') {
      await rejectsWith(acquireWorkspaceLock({ hubDir: hub, root, lock: { waitMs: 200 } }), 'baseline_busy', label);
      fs.rmSync(lockFile);
    } else {
      t = performance.now();
      const lock = await acquireWorkspaceLock({ hubDir: hub, root, lock: { waitMs: 200 } });
      assert.ok(performance.now() - t < 1_000, `${label}: taken at once`);
      assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid, process.pid, `${label}: the lock is ours now`);
      await lock.release();
    }
  }
  idle.proc.kill();
  await idle.exited;
  // a breaker that crashed leaves lock.break: it does not block for long
  plant(JSON.stringify({ pid: 1, host: 'another-machine.invalid', token: 't5' }), LOCK_RULES.staleMs + 5_000);
  fs.writeFileSync(`${lockFile}.break`, 'crashed breaker');
  const old = new Date(Date.now() - LOCK_RULES.breakGraceMs - 5_000);
  fs.utimesSync(`${lockFile}.break`, old, old);
  const afterBreaker = await acquireWorkspaceLock({ hubDir: hub, root, lock: { waitMs: 2_000 } });
  assert.ok(!fs.existsSync(`${lockFile}.break`));
  await afterBreaker.release();
  // the heartbeat moves the time of the lock; a release never removes a lock that is no longer ours
  const beating = await acquireWorkspaceLock({ hubDir: hub, root, lock: { heartbeatMs: 50 } });
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(lockFile, past, past);
  await wait(250);
  assert.ok(Date.now() - fs.statSync(lockFile).mtimeMs < 5_000, 'the heartbeat refreshed the lock');
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 1, host: 'another-machine.invalid', token: 'stolen' }));
  await beating.release();
  assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf8')).token, 'stolen', 'a lock that is not ours stays');
  fs.rmSync(lockFile);
  ok('the lock: waits in and across processes, refuses after the wait; stale when the process died, the heartbeat stopped, or unreadable and old');

  // four baselines of one workspace at once (two in this process, two in others): all valid, none corrupt
  const repo = newRepo('concurrent');
  for (let index = 0; index < 40; index += 1) write(repo, `f${index}.txt`, `${index}\n`);
  commitAll(repo);
  write(repo, 'untracked.txt', 'u\n');
  const script = `
import { snapshotBaseline } from ${JSON.stringify(MODULE_URL)};
const result = await snapshotBaseline({ hubDir: ${JSON.stringify(hub)}, root: ${JSON.stringify(repo)}, toolchain: null });
process.stdout.write(JSON.stringify({ id: result.id, sha256: result.sha256 }) + '\\n');
`;
  const children = [child(script), child(script)];
  const local = await Promise.all([snapshotBaseline({ hubDir: hub, root: repo, toolchain: null }), snapshotBaseline({ hubDir: hub, root: repo, toolchain: null })]);
  const codes = await Promise.all(children.map((c) => c.exited));
  assert.deepEqual(codes, [0, 0]);
  const made = [...local.map((r) => ({ id: r.id, sha256: r.sha256 })), ...children.map((c) => JSON.parse(c.output().trim()))];
  assert.equal(new Set(made.map((r) => r.id)).size, 4);
  const listed = await listBaselines({ hubDir: hub, root: repo });
  assert.deepEqual(listed.map((row) => row.id).sort(), made.map((row) => row.id).sort());
  for (const { id, sha256: anchor } of made) {
    const loaded = await loadBaseline({ hubDir: hub, root: repo, id, expectSha256: anchor });
    assert.equal(loaded.record.tree, local[0].record.tree);
    const store = storeOf(hub, repo, loaded.record);
    assert.equal(git(store, ['rev-parse', `${STORE_REF}^{tree}`], { env: { ...process.env, GIT_DIR: store } }).stdout.trim(), loaded.record.tree);
  }
  assert.ok(!fs.existsSync(path.join(baselineFolder(hub, repo), 'lock')));
  ok('four concurrent baselines of one workspace (two processes, two in this one): all four valid, the store of each holds its tree');
}

// ------------------------------------------------------------------ 6: retention, leftovers, edited and missing baselines
{
  assert.deepEqual({ ...RETENTION }, { maxAgeMs: 14 * DAY, maxPerWorkspace: 10 }, 'the documented retention');
  const hub = fresh('hub');
  const repo = newRepo('kept');
  write(repo, 'a.txt', 'a\n');
  write(repo, 'sub/b.txt', 'b\n');
  commitAll(repo);
  const T = Date.parse('2026-11-22T12:00:00.000Z');
  const at = (ms) => () => new Date(ms);
  const made = [];
  for (let index = 0; index < 5; index += 1) made.push(await snapshotBaseline({ hubDir: hub, root: repo, toolchain: null, now: at(T + index * 1000), retention: { maxPerWorkspace: 3 } }));
  const folder = baselineFolder(hub, repo);
  assert.deepEqual((await listBaselines({ hubDir: hub, root: repo })).map((row) => row.id), made.slice(2).map((row) => row.id), 'the newest three are kept');
  for (const gone of made.slice(0, 2)) {
    assert.ok(!fs.existsSync(path.join(folder, `${gone.id}.json`)) && !fs.existsSync(path.join(folder, `${gone.id}.git`)), 'record and store are removed');
  }
  const backInTime = await snapshotBaseline({ hubDir: hub, root: repo, toolchain: null, now: at(T - 1000), retention: { maxPerWorkspace: 3 } });
  assert.deepEqual((await listBaselines({ hubDir: hub, root: repo })).map((row) => row.id), [backInTime.id, ...made.slice(2).map((row) => row.id)],
    'a baseline just taken is never pruned by its own write, even when the clock went back');
  const other = fresh('other-workspace');
  write(other, 'x.txt', 'x\n');
  const oldOther = await snapshotBaseline({ hubDir: hub, root: other, toolchain: null, now: at(T - 15 * DAY) });
  const youngOther = await snapshotBaseline({ hubDir: hub, root: other, toolchain: null, now: at(T - 13 * DAY) });
  fs.mkdirSync(path.join(folder, 'tmp-left-by-a-crash'), { recursive: true });
  fs.writeFileSync(path.join(folder, `${made[2].id}.json.tmp-1234`), 'half written');
  fs.mkdirSync(path.join(folder, '20201122T120000000Z-deadbeef.git', 'objects'), { recursive: true });
  const latest = await snapshotBaseline({ hubDir: hub, root: repo, toolchain: null, now: at(T + 10_000) });
  assert.deepEqual((await listBaselines({ hubDir: hub, root: other })).map((row) => row.id), [youngOther.id], "another workspace's baseline older than 14 days is pruned on write");
  assert.ok(!fs.existsSync(path.join(baselineFolder(hub, other), `${oldOther.id}.json`)));
  assert.ok(!fs.existsSync(path.join(folder, 'tmp-left-by-a-crash')) && !fs.existsSync(path.join(folder, `${made[2].id}.json.tmp-1234`)), 'leftovers of a crash are removed');
  assert.ok(!fs.existsSync(path.join(folder, '20201122T120000000Z-deadbeef.git')), 'a store without its record is removed');
  assert.equal((await listBaselines({ hubDir: hub, root: repo })).length, 5, 'the default keeps up to ten');
  const pruned = await pruneBaselines({ hubDir: hub, root: repo, now: at(T + 15 * DAY), retention: { maxPerWorkspace: 10 } });
  assert.deepEqual(pruned.removed.sort(), [backInTime, ...made.slice(2), latest].map((row) => row.id).sort(), 'older than 14 days: all removed');
  assert.deepEqual(await listBaselines({ hubDir: hub, root: repo }), []);
  ok('retention: at most N per workspace (oldest first), 14 days for every workspace, leftovers of a crash, on write and on demand');

  // edited, re-hashed, moved, missing
  const base = await snapshotBaseline({ hubDir: hub, root: repo, toolchain: null });
  const file = base.file;
  const original = fs.readFileSync(file);
  const flipAt = original.indexOf('"data":"') + 12;
  const flipped = Buffer.from(original);
  flipped[flipAt] = flipped[flipAt] === 0x41 ? 0x42 : 0x41;
  fs.writeFileSync(file, flipped);
  await rejectsWith(loadBaseline({ hubDir: hub, root: repo, id: base.id }), 'baseline_edited', 'one byte flipped');
  await rejectsWith(diffBaseline({ hubDir: hub, root: repo, id: base.id }), 'baseline_edited', 'the diff refuses it too');
  const rehash = (mutate) => {
    const body = JSON.parse(original.toString('utf8'));
    delete body.recordSha256;
    mutate(body);
    const json = JSON.stringify(body);
    fs.writeFileSync(file, `${json.slice(0, -1)},"recordSha256":"${sha256(json)}"}\n`);
  };
  rehash((body) => { body.createdAt = '2020-01-01T00:00:00.000Z'; });
  const self = await loadBaseline({ hubDir: hub, root: repo, id: base.id });
  assert.equal(self.verifiedAgainst, 'self', 'with its own hash recomputed it passes alone');
  await rejectsWith(loadBaseline({ hubDir: hub, root: repo, id: base.id, expectSha256: base.sha256 }), 'baseline_mismatch', 'but not against the anchor kept elsewhere');
  await rejectsWith(diffBaseline({ hubDir: hub, root: repo, id: base.id, expectSha256: base.sha256 }), 'baseline_mismatch', 'nor in a diff');
  rehash((body) => { body.manifest = encodeManifest([{ path: 'a.txt', mode: '100644', oid: blobId(Buffer.from('forged\n')) }]); });
  await rejectsWith(loadBaseline({ hubDir: hub, root: repo, id: base.id }), 'baseline_bad_record', 'a manifest that does not rebuild the tree');
  rehash((body) => { body.format = 'chatmcp.proof-baseline/9'; });
  await rejectsWith(loadBaseline({ hubDir: hub, root: repo, id: base.id }), 'baseline_bad_record', 'another format');
  rehash((body) => { body.store.directory = '../../elsewhere.git'; });
  await rejectsWith(loadBaseline({ hubDir: hub, root: repo, id: base.id }), 'baseline_bad_record', 'a store folder that is not the baseline own');
  fs.writeFileSync(file, original);
  assert.equal((await loadBaseline({ hubDir: hub, root: repo, id: base.id, expectSha256: base.sha256 })).verifiedAgainst, 'anchor');
  await rejectsWith(loadBaseline({ hubDir: hub, root: repo, id: base.id, expectSha256: 'nothex' }), 'baseline_bad_anchor', 'an anchor that is not a sha256');
  const moved = path.join(baselineFolder(hub, other), path.basename(file));
  fs.copyFileSync(file, moved);
  await rejectsWith(loadBaseline({ hubDir: hub, root: other, id: base.id }), 'baseline_wrong_workspace', 'a record copied into another workspace');
  fs.rmSync(moved);
  for (const bad of ['../x', 'con', '', 'x'.repeat(200), '20261122T120000000Z-ABCDEF12']) {
    await rejectsWith(loadBaseline({ hubDir: hub, root: repo, id: bad }), 'baseline_bad_id', `id ${JSON.stringify(bad)}`);
  }
  await rejectsWith(loadBaseline({ hubDir: hub, root: repo, id: '20201122T120000000Z-abcdef12' }), 'baseline_missing', 'no such baseline');

  // the store: missing, then forged
  write(repo, 'a.txt', 'edited\n');
  const store = storeOf(hub, repo, base.record);
  const aside = `${store}.aside`;
  fs.renameSync(store, aside);
  const noStore = await diffBaseline({ hubDir: hub, root: repo, id: base.id, expectSha256: base.sha256 });
  assert.deepEqual(noStore.patch, { status: 'unavailable', reason: 'baseline_objects_missing' });
  assert.deepEqual(paths(noStore.changes.modified), ['a.txt'], 'the verified manifest still gives the change list');
  fs.renameSync(aside, store);
  // the forger unpacks the store's pack into loose objects and writes other bytes under the id of the old a.txt
  const packFolder = path.join(store, 'objects', 'pack');
  const packs = fs.readdirSync(packFolder).filter((name) => name.endsWith('.pack'));
  assert.equal(packs.length, 1, 'one pack per baseline');
  const packBytes = fs.readFileSync(path.join(packFolder, packs[0]));
  for (const name of fs.readdirSync(packFolder)) fs.rmSync(path.join(packFolder, name), { force: true });
  git(store, ['unpack-objects', '-q'], { env: { ...process.env, GIT_DIR: store }, input: packBytes });
  const oldBlob = blobId(Buffer.from('a\n'));
  const loose = path.join(store, 'objects', oldBlob.slice(0, 2), oldBlob.slice(2));
  fs.chmodSync(loose, 0o644);
  fs.writeFileSync(loose, zlib.deflateSync(Buffer.from('blob 2\0b\n', 'latin1')));
  const forged = await diffBaseline({ hubDir: hub, root: repo, id: base.id, expectSha256: base.sha256 });
  assert.deepEqual(forged.patch, { status: 'unavailable', reason: 'baseline_objects_mismatch' });
  // the blob put back, then a tree forged: other bytes under the id of the sub folder's tree, then under the root tree's id
  fs.writeFileSync(loose, zlib.deflateSync(Buffer.from('blob 2\0a\n', 'latin1')));
  assert.equal((await diffBaseline({ hubDir: hub, root: repo, id: base.id, expectSha256: base.sha256 })).patch.status, 'ok', 'the genuine blob is back');
  const inStore = { ...process.env, GIT_DIR: store };
  const forgeTree = (id) => {
    const other = git(store, ['mktree', '--missing'], { env: inStore, input: `100644 blob ${blobId(Buffer.from('forged\n'))}\tb.txt\n` }).stdout.trim();
    const raw = spawnSync('git', ['cat-file', 'tree', other], { env: inStore }).stdout; // bytes: a tree holds binary ids
    assert.ok(raw.length > 0);
    const file = path.join(store, 'objects', id.slice(0, 2), id.slice(2));
    fs.chmodSync(file, 0o644);
    fs.writeFileSync(file, zlib.deflateSync(Buffer.concat([Buffer.from(`tree ${raw.length}\0`, 'latin1'), raw])));
  };
  const subTree = git(store, ['rev-parse', `${base.record.tree}:sub`], { env: inStore }).stdout.trim();
  forgeTree(subTree);
  const forgedSub = await diffBaseline({ hubDir: hub, root: repo, id: base.id, expectSha256: base.sha256 });
  assert.deepEqual(forgedSub.patch, { status: 'unavailable', reason: 'baseline_objects_mismatch' }, 'a forged tree below the root (Git does not check its hash)');
  forgeTree(base.record.tree);
  const forgedRoot = await diffBaseline({ hubDir: hub, root: repo, id: base.id, expectSha256: base.sha256 });
  assert.deepEqual(forgedRoot.patch, { status: 'unavailable', reason: 'baseline_objects_mismatch' }, 'a forged root tree (Git refuses to read it)');
  fs.rmSync(file);
  await rejectsWith(diffBaseline({ hubDir: hub, root: repo, id: base.id }), 'baseline_missing', 'a deleted record');
  ok('an edited record is refused (byte flip; re-hashed against the anchor; manifest; format; wrong workspace; ids); a missing or forged store is reported');
}

// ------------------------------------------------------------------ the rows of a snapshot (lib/proof/tree-snapshot.mjs, `entries: true`)
{
  const repo = newRepo('entries');
  write(repo, '.gitattributes', '*.dat text eol=lf\n');
  write(repo, 'x.dat', 'one\r\ntwo\r\n');
  write(repo, 'y/z.txt', 'z\n');
  const snapshots = new TreeSnapshotter({ root: repo, stateDir: fresh('state') });
  const plain = await snapshots.snapshot({ full: true });
  assert.ok(!('entries' in plain), 'without the option a snapshot is what it was');
  const full = await snapshots.snapshot({ full: true, entries: true });
  assert.equal(full.treeAlgorithm, TREE_ALGORITHM.gitPinned);
  assert.equal(buildTree(full.entries), full.tree, 'the rows build the tree');
  assert.equal(full.entries.find((row) => row.path === 'x.dat').oid, blobId(Buffer.from('one\ntwo\n')), 'the rows of the git engine hold the converted blob');
  write(repo, 'y/new.txt', 'new\n');
  const cached = await snapshots.snapshot({ entries: true });
  assert.equal(buildTree(cached.entries), cached.tree);
  assert.ok(cached.entries.some((row) => row.path === 'y/new.txt'));
  const raw = await new TreeSnapshotter({ root: repo, stateDir: fresh('state'), engine: TREE_ALGORITHM.raw }).snapshot({ full: true, entries: true });
  assert.equal(buildTree(raw.entries), raw.tree);
  assert.equal(raw.entries.find((row) => row.path === 'x.dat').oid, blobId(Buffer.from('one\r\ntwo\r\n')), 'raw-v1 rows hold the raw bytes');
  const rawCached = await new TreeSnapshotter({ root: repo, stateDir: fresh('state'), engine: TREE_ALGORITHM.raw });
  await rawCached.snapshot({ full: true });
  assert.equal(buildTree((await rawCached.snapshot({ entries: true })).entries), raw.tree);
  const tight = new TreeSnapshotter({ root: repo, stateDir: fresh('state'), limits: { maxFiles: 4 } });
  assert.equal((await tight.snapshot({ full: true, entries: true })).entries.length, 4);
  write(repo, 'y/one-too-many.txt', 'over the limit\n');
  const over = await tight.snapshot({ full: true, entries: true });
  assert.equal(over.status, 'unbounded');
  assert.equal(over.entries, null, 'no rows without a tree (not the rows of the snapshot before)');
  const forced = await new TreeSnapshotter({ root: repo, stateDir: fresh('state'), limits: { maxNewBlobs: 0 } }).snapshot({ full: true, entries: true });
  assert.match(forced.engineReason, /^too_many_new_blobs:/);
  assert.equal(buildTree(forced.entries), forced.tree, 'a full snapshot that fell back to raw-v1 hands over the raw rows');
  ok('the snapshot hands over the rows its tree was built from when asked (git engine, cached, raw-v1, fallback, unbounded); unchanged otherwise');
}

// ------------------------------------------------------------------ 7: budgets on a 663-file and an 8,002-file repository
{
  const hub = fresh('hub');
  const budgets = [];
  for (const [label, count, commit] of [['663-committed', 663, true], ['8k-untracked', 8_002, false]]) {
    const { dir } = generateRepo(`budget-${label}`, count, 2501 + count, { commit }); // not committed: every file is a new blob
    const cold = new TreeSnapshotter({ root: dir, stateDir: fresh('cold') });
    let mark = performance.now();
    const snapshot = await cold.snapshot({ full: true });
    const snapshotMs = Math.round(performance.now() - mark);
    assert.equal(snapshot.treeAlgorithm, TREE_ALGORITHM.gitPinned, snapshot.engineReason);
    mark = performance.now();
    const base = await snapshotBaseline({ hubDir: hub, root: dir, toolchain: null });
    const baselineMs = Math.round(performance.now() - mark);
    assert.equal(base.record.tree, snapshot.tree);
    const files = fs.readdirSync(dir, { recursive: true }).filter((name) => !name.split(/[\\/]/).includes('.git') && /\.(?:js|txt|md)$/.test(name)).slice(0, 20);
    for (const name of files) fs.appendFileSync(path.join(dir, name), 'edited by the agent\n');
    mark = performance.now();
    const diff = await diffBaseline({ hubDir: hub, root: dir, id: base.id, expectSha256: base.sha256 });
    const diffMs = Math.round(performance.now() - mark);
    assert.equal(diff.patch.status, 'ok', diff.patch.reason);
    assert.equal(diff.patch.reproduces, true);
    assert.equal(diff.counts.modified, files.length);
    const storeBytes = fs.readdirSync(storeOf(hub, dir, base.record), { recursive: true })
      .map((name) => fs.statSync(path.join(storeOf(hub, dir, base.record), name))).filter((stat) => stat.isFile()).reduce((sum, stat) => sum + stat.size, 0);
    const row = {
      repo: label, files: base.record.manifest.entries, snapshotMs, baselineMs, storeMs: base.timings.storeMs, perBlobMs: Number((base.timings.storeMs / base.record.manifest.entries).toFixed(3)),
      diffMs, patchBytes: diff.patch.bytes, storeBytes, recordBytes: fs.statSync(base.file).size,
    };
    budgets.push(row);
    // Budgets (docs/PROOF-BASELINE.md "Budgets"), set with room for a CI runner two to three times slower than the machine that
    // measured them: storing the objects costs at most max(3 s, 1 ms per blob) (the plan measured 5.6 ms per new loose blob); a baseline
    // at most max(5 s, 2.5x its own full snapshot) (storing reads every file the snapshot hashed once more); a diff at most
    // max(10 s, 4x the snapshot).
    assert.ok(row.storeMs <= Math.max(3_000, row.files), `${label}: storing ${row.files} blobs took ${row.storeMs} ms`);
    assert.ok(row.baselineMs <= Math.max(5_000, 2.5 * snapshotMs), `${label}: the baseline took ${row.baselineMs} ms, its snapshot alone ${snapshotMs} ms`);
    assert.ok(row.diffMs <= Math.max(10_000, 4 * snapshotMs), `${label}: the diff took ${row.diffMs} ms`);
  }
  console.log(`PROOF_BASELINE_BUDGET ${JSON.stringify({ platform: process.platform, node: process.versions.node, budgets })}`);
  ok(`budgets: ${budgets.map((row) => `${row.repo} baseline ${row.baselineMs} ms (snapshot ${row.snapshotMs} ms, store ${row.storeMs} ms), diff ${row.diffMs} ms`).join('; ')}`);
}

console.log(`\nverify-proof-baseline: ${checks} checks passed [${elapsed()}]`);
