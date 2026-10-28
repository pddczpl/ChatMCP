// Unit tests for the small building blocks under the local tool server:
// argument validation, safe text decoding, atomic writes, glob matching and the hardened Git runner.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { delay, exists } from '../lib/runtime.mjs';
import { StudioWorkspace } from '../lib/studio-workspace.mjs';
import { validateArguments } from '../lib/tool-schema.mjs';
import { applyEol, canonicalRelative, decodeText, detectEol, encodeText, isUnsafeWindowsName, sha256, splitLines, writeFileAtomic } from '../lib/fs-safe.mjs';
import { compileGlob } from '../lib/glob.mjs';
import { GitRunner, isSafeRevision } from '../lib/git-runner.mjs';
import { isProtectedPath } from '../lib/protected-paths.mjs';

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
const isWindows = process.platform === 'win32';

// ------------------------------------------------------------------ tool-schema
{
  const schema = {
    type: 'object', additionalProperties: false, required: ['path'],
    properties: {
      path: { type: 'string', minLength: 1, maxLength: 20 }, limit: { type: 'integer', minimum: 1, maximum: 100 }, flag: { type: 'boolean' },
      mode: { type: 'string', enum: ['a', 'b'] }, tags: { type: 'array', items: { type: 'string' }, maxItems: 2 },
      items: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['text', 'status'], properties: { text: { type: 'string' }, status: { type: 'string', enum: ['todo', 'done'] } } } },
    },
  };
  let r = validateArguments(schema, { path: 'a.txt', limit: '50', flag: 'true', tags: 'one', extra: undefined });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { path: 'a.txt', limit: 50, flag: true, tags: ['one'] });
  r = validateArguments(schema, { path: 'a', limit: null, mode: null });
  assert.equal(r.ok, true, 'null for an optional field means "not provided"');
  assert.deepEqual(r.value, { path: 'a' });
  r = validateArguments(schema, { limit: 5 });
  assert.match(r.errors.join('|'), /path: bắt buộc/);
  r = validateArguments(schema, { path: 'a', bogus: 1 });
  assert.match(r.errors.join('|'), /bogus: tham số không tồn tại \(hợp lệ: path, limit/);
  r = validateArguments(schema, { path: 'a', limit: 0, mode: 'z', tags: ['x', 'y', 'z'] });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('|'), /limit phải ≥ 1/);
  assert.match(r.errors.join('|'), /mode phải là một trong: a, b/);
  assert.match(r.errors.join('|'), /tags: tối đa 2/);
  r = validateArguments(schema, { path: 'x'.repeat(21) });
  assert.match(r.errors.join('|'), /dài tối đa 20/);
  r = validateArguments(schema, { path: '' });
  assert.match(r.errors.join('|'), /không được rỗng/);
  r = validateArguments(schema, { path: 'a', items: [{ text: 't', status: 'todo' }, { text: 't', status: 'maybe' }] });
  assert.match(r.errors.join('|'), /items\[1\]\.status phải là một trong: todo, done/);
  r = validateArguments(schema, { path: 'a', limit: '50' }, { coerce: false });
  assert.match(r.errors.join('|'), /limit phải là số nguyên/);
  r = validateArguments(schema, 'not an object');
  assert.match(r.errors.join('|'), /phải là object JSON/);
  r = validateArguments(schema, { path: 'a', limit: 1.5 });
  assert.match(r.errors.join('|'), /số nguyên/);
  r = validateArguments({ type: 'string', minLength: 64 }, 'abc');
  assert.match(r.errors.join('|'), /ít nhất 64/);
  ok('validateArguments: coercion, optional nulls, enum/range/length, nested paths, unknown properties');
}

// ------------------------------------------------------------------ fs-safe
{
  assert.equal(detectEol(''), 'none');
  assert.equal(detectEol('a'), 'none');
  assert.equal(detectEol('a\nb\n'), 'lf');
  assert.equal(detectEol('a\r\nb\r\n'), 'crlf');
  assert.equal(detectEol('a\r\nb\n'), 'mixed');
  assert.equal(detectEol('a\rb'), 'mixed');
  assert.equal(applyEol('a\nb\r\nc', 'crlf'), 'a\r\nb\r\nc');
  assert.equal(applyEol('a\r\nb', 'lf'), 'a\r\nb');
  assert.deepEqual(splitLines('a\nb\n'), ['a', 'b']);
  assert.deepEqual(splitLines('a\r\nb'), ['a', 'b']);
  assert.deepEqual(splitLines(''), []);
  assert.deepEqual(splitLines('\n'), ['']);
  assert.deepEqual(splitLines('a\n\nb'), ['a', '', 'b']);
  ok('detectEol, applyEol and splitLines');
}
{
  const plain = decodeText(Buffer.from('xin chào\n', 'utf8'));
  assert.deepEqual([plain.ok, plain.text, plain.encoding, plain.eol], [true, 'xin chào\n', 'utf8', 'lf']);
  const bom = decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hi\r\n')]));
  assert.deepEqual([bom.ok, bom.text, bom.encoding, bom.eol], [true, 'hi\r\n', 'utf8-bom', 'crlf']);
  const wide = decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('chào', 'utf16le')]));
  assert.deepEqual([wide.ok, wide.text, wide.encoding], [true, 'chào', 'utf16le']);
  assert.equal(decodeText(Buffer.from([0x63, 0x61, 0x66, 0xe9])).reason, 'not_utf8');
  assert.equal(decodeText(Buffer.from([0x50, 0x4b, 0x00, 0x03])).reason, 'binary');
  assert.equal(decodeText(Buffer.from([0xfe, 0xff, 0x00, 0x41])).reason, 'utf16be');
  assert.equal(decodeText(Buffer.from([0xff, 0xfe, 0x41])).reason, 'not_utf8', 'odd-length UTF-16 body');
  for (const encoding of ['utf8', 'utf8-bom', 'utf16le']) {
    const text = 'dòng một\r\nline 2 — ✓';
    const back = decodeText(encodeText(text, encoding));
    assert.deepEqual([back.ok, back.text, back.encoding], [true, text, encoding], encoding);
  }
  assert.throws(() => encodeText('lone \ud800 surrogate'), (error) => error.code === 'invalid_unicode');
  ok('decodeText/encodeText: UTF-8, BOM, UTF-16LE round trips; legacy, binary and UTF-16BE are refused, never guessed');
}
{
  for (const bad of ['con', 'CON', 'nul.txt', 'aux.c', 'com1', 'lpt3.log', 'a.', 'a ', 'a:b', 'what?', 'a|b']) assert.equal(isUnsafeWindowsName(bad), true, bad);
  for (const fine of ['console.txt', 'ok.txt', '.env', '.', '..', 'comma.txt', 'auxiliary', 'a b.txt', '']) assert.equal(isUnsafeWindowsName(fine), false, fine || '(empty)');
  ok('isUnsafeWindowsName flags device names, trailing dots/spaces and forbidden characters only');
}

// ------------------------------------------------------------------ glob
{
  const matches = (glob, file, options) => compileGlob(glob, options).test(file);
  const yes = [['*.py', 'a.py'], ['*.py', 'src/a.py'], ['src/*.py', 'src/a.py'], ['**/*.js', 'a.js'], ['**/*.js', 'x/y/a.js'], ['src/**/test_*.py', 'src/test_a.py'],
    ['src/**/test_*.py', 'src/a/b/test_a.py'], ['*.{json,yaml}', 'a.json'], ['*.{json,yaml}', 'd/a.yaml'], ['?.txt', 'a.txt'], ['[ab].txt', 'b.txt'], ['[!a].txt', 'c.txt'],
    ['docs/**', 'docs/a/b.md'], ['./src/*.py', 'src/a.py'], ['src\\*.py', 'src/a.py'], ['{src,lib}/**/*.ts', 'lib/x/y.ts'], ['a.b', 'a.b'], ['file(1).txt', 'file(1).txt']];
  const no = [['*.py', 'a.pyc'], ['src/*.py', 'src/x/a.py'], ['src/*.py', 'a.py'], ['*.{json,yaml}', 'a.yml'], ['?.txt', 'ab.txt'], ['[ab].txt', 'c.txt'], ['[!a].txt', 'a.txt'],
    ['docs/**', 'doc/a.md'], ['a.b', 'axb'], ['*.py', 'dir.py/readme']];
  for (const [glob, file] of yes) assert.equal(matches(glob, file, { caseInsensitive: false }), true, `${glob} should match ${file}`);
  for (const [glob, file] of no) assert.equal(matches(glob, file, { caseInsensitive: false }), false, `${glob} should not match ${file}`);
  assert.equal(matches('*.PY', 'a.py', { caseInsensitive: true }), true);
  assert.equal(matches('*.PY', 'a.py', { caseInsensitive: false }), false);
  for (const bad of ['', '   ', 'x'.repeat(301), '*/*/*/*/*/*/*/*/*']) assert.throws(() => compileGlob(bad), (error) => error.code === 'bad_pattern', JSON.stringify(bad.slice(0, 12)));
  ok('compileGlob: *, **, ?, classes, braces, bare names at any depth, Windows separators; bad patterns rejected');
}

// ------------------------------------------------------------------ writeFileAtomic
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-fs-helpers-'));
async function cleanup() { await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 }).catch(() => {}); }
{
  const file = path.join(root, 'atomic.txt');
  await writeFileAtomic(file, Buffer.from('one'));
  assert.equal(await fs.readFile(file, 'utf8'), 'one');
  await writeFileAtomic(file, Buffer.from('two'), { expectedSha: sha256(Buffer.from('one')) });
  assert.equal(await fs.readFile(file, 'utf8'), 'two');
  await assert.rejects(writeFileAtomic(file, Buffer.from('three'), { expectedSha: sha256(Buffer.from('one')) }), (error) => error.code === 'stale_revision');
  assert.equal(await fs.readFile(file, 'utf8'), 'two', 'a refused write leaves the file untouched');
  assert.deepEqual((await fs.readdir(root)).filter((name) => name.endsWith('.tmp')), [], 'no temporary files remain');
  await assert.rejects(writeFileAtomic(path.join(root, 'missing-dir', 'x.txt'), Buffer.from('x')), (error) => error.code === 'ENOENT');
  if (!isWindows) {
    await fs.chmod(file, 0o750);
    await writeFileAtomic(file, Buffer.from('four'), { mode: (await fs.stat(file)).mode });
    assert.equal((await fs.stat(file)).mode & 0o777, 0o750, 'the file mode is preserved');
  }
  ok('writeFileAtomic replaces files atomically, refuses stale revisions and leaves no temporary files');
}

// ------------------------------------------------------------------ canonicalRelative (symlink / junction / short-name guard)
{
  const base = path.join(root, 'canon');
  const outside = path.join(root, 'canon-outside');
  await fs.mkdir(path.join(base, 'sub', 'deeper'), { recursive: true });
  await fs.mkdir(path.join(base, '.git', 'hooks'), { recursive: true });
  await fs.mkdir(outside);
  await fs.writeFile(path.join(base, 'plain.txt'), 'x');
  await fs.writeFile(path.join(base, '.env'), 'SECRET=1\n');
  await fs.writeFile(path.join(outside, 'o.txt'), 'o');
  const where = (...parts) => canonicalRelative(base, path.join(base, ...parts));

  assert.deepEqual(await where('plain.txt'), { inside: true, relative: 'plain.txt' });
  assert.deepEqual(await where('sub', 'deeper'), { inside: true, relative: 'sub/deeper' });
  assert.deepEqual(await where(), { inside: true, relative: '' }, 'the root itself');
  assert.deepEqual(await where('sub', 'not-yet', 'new.txt'), { inside: true, relative: 'sub/not-yet/new.txt' }, 'a missing tail is resolved through its nearest existing parent');
  assert.deepEqual(await where('plain.txt', 'child'), { inside: true, relative: 'plain.txt/child' }, 'a file used as a folder is left for the caller to report');
  assert.equal((await where('sub', '..', 'plain.txt')).relative, 'plain.txt');

  // Directory links (junctions work without privileges on Windows; on Linux this is a normal symlink).
  let directoryLinks = true;
  try {
    await fs.symlink(path.join(base, 'sub', 'deeper'), path.join(base, 'shortcut'), 'junction');
    await fs.symlink(path.join(base, '.git'), path.join(base, 'gitlink'), 'junction');
    await fs.symlink(outside, path.join(base, 'escape'), 'junction');
  } catch { directoryLinks = false; }
  if (directoryLinks) {
    assert.deepEqual(await where('shortcut', 'x.txt'), { inside: true, relative: 'sub/deeper/x.txt' }, 'a new file under a linked folder lands where the link points');
    const hook = await where('gitlink', 'hooks', 'pre-commit');
    assert.equal(hook.relative, '.git/hooks/pre-commit');
    assert.equal(isProtectedPath(hook.relative), true, 'a folder link into .git is recognised as .git');
    assert.deepEqual(await where('escape', 'o.txt'), { inside: false, relative: '' }, 'a link leading out of the root is reported as outside');
  } else console.warn('  SKIPPED directory-link checks: this environment cannot create symlinks or junctions');

  let fileLinks = true;
  try { await fs.symlink('.env', path.join(base, 'innocent.txt')); } catch { fileLinks = false; }
  if (fileLinks) {
    assert.deepEqual(await where('innocent.txt'), { inside: true, relative: '.env' }, 'a file link resolves to its target');
    // The Studio file viewer shares the rule: a harmless-looking link must not reveal a secret.
    const viewer = new StudioWorkspace({ manager: { workspace: base }, directory: path.join(root, 'canon-state') });
    await assert.rejects(viewer.read({ file: 'innocent.txt' }), (error) => error.code === 'protected_path');
    assert.equal((await viewer.read({ file: 'plain.txt' })).content, 'x');
  } else console.warn('  SKIPPED file-link checks: this environment cannot create file symlinks');

  // Anything other than "does not exist" must fail the check instead of being treated as safe.
  let loops = true;
  try {
    await fs.symlink('loop-b', path.join(base, 'loop-a'));
    await fs.symlink('loop-a', path.join(base, 'loop-b'));
  } catch { loops = false; }
  if (loops) await assert.rejects(canonicalRelative(base, path.join(base, 'loop-a')), 'a symlink loop is an error, never "safe"');
  await assert.rejects(canonicalRelative(path.join(base, 'does-not-exist'), path.join(base, 'plain.txt')), (error) => error.code === 'ENOENT', 'a missing root is an error');
  ok('canonicalRelative: links to secrets and into .git are recognised, escapes are reported, errors fail closed');
}

// ------------------------------------------------------------------ GitRunner
function git(cwd, ...args) { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
let haveGit = true;
try { git(root, '--version'); } catch { haveGit = false; }
if (!haveGit) console.warn('  SKIPPED GitRunner checks: git is not installed');
else {
  assert.equal(isSafeRevision('main'), true);
  for (const good of ['HEAD~3', 'feature/x-1', 'v1.0.0', 'abc1234', 'HEAD^', 'origin/main@{1}'.replace('@{1}', '')]) assert.equal(isSafeRevision(good), true, good);
  for (const bad of ['', '-n', '--output=x', 'a..b', 'HEAD:.env', 'a b', 'x;y', '@{-1}', 'a'.repeat(201), 'rev\nrev', 5, null]) assert.equal(isSafeRevision(bad), false, String(bad));
  ok('isSafeRevision accepts plain revisions only');

  const work = path.join(root, 'repo');
  await fs.mkdir(work);
  git(work, 'init', '-q');
  git(work, 'config', 'user.email', 'test@example.invalid');
  git(work, 'config', 'user.name', 'Test');
  await fs.writeFile(path.join(work, 'a.txt'), 'hello\n');
  git(work, 'add', 'a.txt');
  git(work, 'commit', '-q', '-m', 'first');
  const state = path.join(root, 'state');
  await fs.mkdir(state);
  const workspace = new StudioWorkspace({ manager: { workspace: work }, directory: state });
  const runner = new GitRunner({ workspace, hooksDirectory: path.join(state, 'no-hooks') });

  assert.equal(await runner.ensureRepo(), await fs.realpath(work));
  const status = await runner.text(['status', '--short']);
  assert.equal(status.code, 0);
  assert.equal(status.stdout, '');
  const log = await runner.text(['log', '--format=%s']);
  assert.equal(log.stdout.trim(), 'first');
  ok('GitRunner: runs in the workspace root and verifies it is the repository top level');

  // A repository that merely contains the workspace is refused.
  const nested = path.join(work, 'nested');
  await fs.mkdir(nested);
  const nestedRunner = new GitRunner({ workspace: new StudioWorkspace({ manager: { workspace: nested }, directory: state }), hooksDirectory: path.join(state, 'no-hooks') });
  await assert.rejects(nestedRunner.ensureRepo(), (error) => error.code === 'git_root_mismatch');
  const plain = path.join(root, 'plain');
  await fs.mkdir(plain);
  const plainRunner = new GitRunner({ workspace: new StudioWorkspace({ manager: { workspace: plain }, directory: state }), hooksDirectory: path.join(state, 'no-hooks') });
  await assert.rejects(plainRunner.ensureRepo(), (error) => error.code === 'not_git_repo');
  ok('GitRunner: refuses a parent repository and a folder that is not a repository');

  // Repository configuration must not be able to run programs through read-only commands.
  await fs.writeFile(path.join(work, 'b.txt'), 'untracked\n');
  git(work, 'config', 'core.fsmonitor', 'touch fsmonitor-ran');
  try { git(work, 'status', '--short'); } catch { /* the control only needs to try */ }
  const controlFired = await exists(path.join(work, 'fsmonitor-ran'));
  await fs.rm(path.join(work, 'fsmonitor-ran'), { force: true });
  await runner.text(['status', '--short']);
  await runner.text(['diff', '--stat']);
  if (!controlFired) console.warn('  SKIPPED fsmonitor check: the control run did not execute core.fsmonitor on this Git version');
  else { assert.equal(await exists(path.join(work, 'fsmonitor-ran')), false, 'core.fsmonitor must not run'); ok('GitRunner: a hostile core.fsmonitor setting is not executed (control run did execute it)'); }
  git(work, 'config', '--unset', 'core.fsmonitor');

  // Hooks are off unless explicitly enabled.
  const hook = path.join(work, '.git', 'hooks', 'pre-commit');
  await fs.mkdir(path.dirname(hook), { recursive: true });
  await fs.writeFile(hook, '#!/bin/sh\necho ran > hook-ran.txt\n', { mode: 0o755 });
  await runner.text(['add', 'b.txt'], { writes: true });
  const quiet = await runner.text(['commit', '-q', '-m', 'second'], { writes: true });
  assert.equal(quiet.code, 0, quiet.stderr);
  assert.equal(await exists(path.join(work, 'hook-ran.txt')), false, 'hooks are disabled by default');
  await fs.writeFile(path.join(work, 'c.txt'), 'three\n');
  await runner.text(['add', 'c.txt'], { writes: true });
  const loud = await runner.text(['commit', '-q', '-m', 'third'], { writes: true, hooks: true });
  assert.equal(loud.code, 0, loud.stderr);
  assert.equal(await exists(path.join(work, 'hook-ran.txt')), true, 'hooks run only when enabled explicitly');
  ok('GitRunner: repository hooks are skipped unless hooks:true');

  // Environment that would redirect Git elsewhere is ignored.
  const bogus = path.join(root, 'bogus-git-dir');
  process.env.GIT_DIR = bogus;
  process.env.GIT_WORK_TREE = bogus;
  try {
    const redirected = new GitRunner({ workspace, hooksDirectory: path.join(state, 'no-hooks') });
    assert.equal((await redirected.text(['log', '--format=%s', '-1'])).stdout.trim(), 'third');
  } finally { delete process.env.GIT_DIR; delete process.env.GIT_WORK_TREE; }
  ok('GitRunner: GIT_DIR / GIT_WORK_TREE from the environment are ignored');

  // Limits and cancellation.
  const tiny = await runner.exec(['log', '--format=%H'], { maxBytes: 10 });
  assert.equal(tiny.truncated, true);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runner.exec(['status'], { signal: controller.signal }));
  ok('GitRunner: output limit and cancellation');
}

await delay(50);
await cleanup();
console.log(`PASS: ${checks} fs-helper checks (schema, text codec, atomic write, glob, git runner)`);
