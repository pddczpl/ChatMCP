// The patch engine (lib/patch-apply.mjs, plan task multi-agent-tools-20, docs/PATCH-ENGINE.md): pure functions that parse a unified diff or the
// `*** Begin Patch` envelope and work out the new text of each file. Nothing calls it yet; the apply_patch tool (multi-agent-tools-21) will.
//
//   A. The oracle corpus: real diffs mined from this repository's own history (tests/fixtures/patches/git-corpus.json, rebuilt by
//      tests/support/mine-patch-corpus.mjs). Each is applied to the old blobs by the engine (default ladder and exact only) and by `git apply` in a
//      temp folder; all three must be the blobs of the commit, byte for byte.
//   B. Adversarial unified diffs written here (git's own t/ patches are GPL-2.0 and are not copied): offsets, repeated blocks, CRLF, missing final
//      newline, empty files, whitespace, rename + edit, start and end of file. Where the engine and git must agree, git is run too; where the engine
//      is stricter or looser on purpose, the case says why and git's answer is still checked.
//   C. The envelope (`*** Begin Patch`): add, update with several @@ sections, delete, move + update, the end-of-file anchor, malformed envelopes.
//   D. What is refused at parse level: paths, binary patches, symlinks, limits, malformed input; and that the module has no import and no I/O.
//   E. A seeded fuzz: mutated patches and mutated files never throw, never place a hunk on lines that do not match, and give the same answer twice.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PATCH_LIMITS, FUZZ_LEVELS, PatchError, parsePatch, applyPatch, applyFilePatch, checkPatchPath, patchPaths,
} from '../lib/patch-apply.mjs';

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const L = (...lines) => lines.join('\n') + '\n';
const P = (...lines) => lines.join('\n') + '\n';
const ERROR_CODES = new Set(['too_large', 'too_many_files', 'too_many_hunks', 'malformed', 'empty', 'binary', 'unsafe_path', 'unsupported_mode',
  'file_exists', 'file_missing', 'context_mismatch', 'ambiguous', 'no_context', 'not_at_eof', 'delete_not_empty']);

// ------------------------------------------------------------------ git as the oracle
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-oracle-'));
const EMPTY_CONFIG = path.join(SCRATCH, 'empty.gitconfig');
fs.writeFileSync(EMPTY_CONFIG, '');
let gitRuns = 0;

function writeTree(dir, files) {
  for (const [file, text] of Object.entries(files)) {
    if (text === null || text === undefined) continue;
    const full = path.join(dir, ...file.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text, 'utf8');
  }
}
function readTree(dir, prefix = '') {
  const out = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(out, readTree(path.join(dir, entry.name), rel));
    else out[rel] = fs.readFileSync(path.join(dir, entry.name), 'utf8');
  }
  return out;
}
function gitApply(files, patch) {
  gitRuns += 1;
  const caseDir = fs.mkdtempSync(path.join(SCRATCH, 'case-'));
  const tree = path.join(caseDir, 'tree');
  fs.mkdirSync(tree);
  writeTree(tree, files);
  const patchFile = path.join(caseDir, 'change.diff');
  fs.writeFileSync(patchFile, patch, 'utf8');
  return new Promise((resolve) => {
    const child = spawn('git', ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-c', 'core.quotePath=true', 'apply', '--whitespace=nowarn', patchFile], {
      cwd: tree, windowsHide: true,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: EMPTY_CONFIG, GIT_CEILING_DIRECTORIES: SCRATCH, LC_ALL: 'C' },
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => resolve({ code: -1, stderr: String(error), files: null }));
    child.on('close', (code) => resolve({ code, stderr, files: code === 0 ? readTree(tree) : readTree(tree) }));
  });
}
async function pool(items, size, work) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await work(items[index], index); }
  }));
  return results;
}
/** The files after a successful engine run: the input with the changes laid over it. */
function afterEngine(files, result) {
  const out = { ...files };
  for (const change of result.changes) {
    if (change.action === 'delete') delete out[change.path]; else out[change.path] = change.text;
  }
  for (const key of Object.keys(out)) if (out[key] === null || out[key] === undefined) delete out[key];
  return out;
}
const sortKeys = (object) => Object.fromEntries(Object.entries(object).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
const describeBytes = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return `${typeof a} vs ${typeof b}`;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i += 1;
  return `first difference at ${i}: ${JSON.stringify(a.slice(Math.max(0, i - 20), i + 20))} vs ${JSON.stringify(b.slice(Math.max(0, i - 20), i + 20))}`;
};
function assertSameFiles(actual, expected, label) {
  const a = sortKeys(actual);
  const e = sortKeys(expected);
  assert.deepEqual(Object.keys(a), Object.keys(e), `${label}: the same files`);
  for (const key of Object.keys(e)) assert.ok(a[key] === e[key], `${label}: ${key} byte for byte (${describeBytes(a[key], e[key])})`);
}

// ------------------------------------------------------------------ A. the oracle corpus
const corpus = JSON.parse(fs.readFileSync(path.join(HUB, 'tests', 'fixtures', 'patches', 'git-corpus.json'), 'utf8'));
{
  assert.ok(corpus.cases.length >= 60, `at least 60 mined diffs (found ${corpus.cases.length})`);
  const categories = new Set(corpus.cases.map((c) => c.category));
  for (const needed of ['crlf', 'rename-edit', 'rename', 'delete', 'add', 'multi-file', 'mjs', 'md', 'json', 'ts', 'cs']) assert.ok(categories.has(needed), `the corpus has a ${needed} case`);
  assert.ok(corpus.cases.some((c) => Object.values(c.before).some((text) => text.includes('\r\n'))), 'the corpus has an old blob with CRLF line ends');
  assert.match(corpus.minedFrom, /^[0-9a-f]{40}$/, 'the corpus names the commit it was mined from');
  const extensions = new Set(corpus.cases.flatMap((c) => c.paths.map((p) => path.extname(p))));
  assert.ok(extensions.size >= 8, `several file types (${[...extensions].join(' ')})`);
  ok(`the corpus: ${corpus.cases.length} real diffs from ${corpus.minedFrom.slice(0, 10)}, ${categories.size} categories, ${extensions.size} file types`);

  const expectedOf = (c) => { const out = { ...c.before }; for (const [p, text] of Object.entries(c.after)) { if (text === null) delete out[p]; else out[p] = text; } return out; };
  let hunks = 0;
  for (const c of corpus.cases) {
    for (const maxFuzz of [3, 0]) {
      const result = applyPatch(c.patch, c.before, { maxFuzz });
      assert.ok(result.ok, `${c.id} (${c.commit.slice(0, 10)} ${c.paths.join(', ')}), maxFuzz ${maxFuzz}: ${result.error?.message}`);
      assertSameFiles(afterEngine(c.before, result), expectedOf(c), `${c.id} engine (maxFuzz ${maxFuzz})`);
      for (const report of result.reports) for (const hunk of report.hunks) {
        assert.equal(hunk.fuzz, 0, `${c.id}: a diff of git applies to its own old blob exactly`);
        assert.equal(hunk.offset, 0, `${c.id}: at the line the diff names`);
        if (maxFuzz === 3) hunks += 1;
      }
    }
  }
  ok(`the engine turns every old blob into the blob of the commit, byte for byte, ${hunks} hunks at fuzz 0 and offset 0 (default ladder and exact only)`);

  const gitResults = await pool(corpus.cases, 8, (c) => gitApply(c.before, c.patch));
  corpus.cases.forEach((c, index) => {
    const run = gitResults[index];
    assert.equal(run.code, 0, `${c.id}: git apply takes it (${run.stderr})`);
    assertSameFiles(run.files, expectedOf(c), `${c.id} git apply`);
    assertSameFiles(afterEngine(c.before, applyPatch(c.patch, c.before)), run.files, `${c.id} engine vs git apply`);
  });
  ok(`git apply in a temp folder gives the same bytes as the engine for all ${corpus.cases.length} mined diffs`);
}

// ------------------------------------------------------------------ B. adversarial unified diffs
const F10 = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8', 'l9', 'l10'];
const H = (file) => [`--- a/${file}`, `+++ b/${file}`];
const ADVERSARIAL = [
  { name: 'offset forward: five lines were added above the hunk', git: 'same',
    files: { 'f.txt': L('x1', 'x2', 'x3', 'x4', 'x5', ...F10) },
    patch: P(...H('f.txt'), '@@ -4,3 +4,3 @@', ' l4', '-l5', '+L5', ' l6'),
    expect: { 'f.txt': L('x1', 'x2', 'x3', 'x4', 'x5', 'l1', 'l2', 'l3', 'l4', 'L5', 'l6', 'l7', 'l8', 'l9', 'l10') },
    hunks: [{ offset: 5, line: 9, expectedLine: 4, fuzz: 0, matchedLines: 3 }] },
  { name: 'offset backward: two lines were removed above the hunk', git: 'same',
    files: { 'f.txt': L(...F10.slice(2)) },
    patch: P(...H('f.txt'), '@@ -4,3 +4,3 @@', ' l4', '-l5', '+L5', ' l6'),
    expect: { 'f.txt': L('l3', 'l4', 'L5', 'l6', 'l7', 'l8', 'l9', 'l10') },
    hunks: [{ offset: -2, line: 2 }] },
  { name: 'a repeated block: the line numbers pick the second copy', git: 'same',
    files: { 'f.txt': L('a', 'b', 'c', 'x', 'x', 'x', 'x', 'a', 'b', 'c', 'y') },
    patch: P(...H('f.txt'), '@@ -8,3 +8,3 @@', ' a', '-b', '+B', ' c'),
    expect: { 'f.txt': L('a', 'b', 'c', 'x', 'x', 'x', 'x', 'a', 'B', 'c', 'y') } },
  { name: 'a repeated block, neither copy at the line named, both five lines away: refused as ambiguous', git: 'differs', gitApplies: true,
    why: 'git takes the nearest copy; two equally good places are a guess, so the engine refuses',
    files: { 'f.txt': L('p', 'a', 'b', 'c', 'q', 'q', 'q', 'q', 'q', 'q', 'q', 'a', 'b', 'c', 'r') },
    patch: P(...H('f.txt'), '@@ -7,3 +7,3 @@', ' a', '-b', '+B', ' c'),
    error: 'ambiguous' },
  { name: 'a repeated block, neither copy at the line named, one nearer: still refused', git: 'differs', gitApplies: true,
    why: 'git takes the nearest copy; the engine accepts a moved hunk only where it matches once',
    files: { 'f.txt': L('p', 'a', 'b', 'c', 'q', 'q', 'q', 'q', 'q', 'q', 'q', 'a', 'b', 'c', 'r') },
    patch: P(...H('f.txt'), '@@ -4,3 +4,3 @@', ' a', '-b', '+B', ' c'),
    error: 'ambiguous' },
  { name: 'context that is nowhere in the file', git: 'same',
    files: { 'f.txt': L(...F10) },
    patch: P(...H('f.txt'), '@@ -4,3 +4,3 @@', ' l4', '-l5', '+L5', ' zz'),
    error: 'context_mismatch' },
  { name: 'a CRLF file and a diff written with LF: matched, CRLF out', git: 'differs', gitApplies: false,
    why: 'git compares the carriage return as content; the engine compares LF-normalised lines and writes the file\'s own line ends',
    files: { 'f.txt': 'a\r\nb\r\nc\r\n' },
    patch: P(...H('f.txt'), '@@ -1,3 +1,3 @@', ' a', '-b', '+B', ' c'),
    expect: { 'f.txt': 'a\r\nB\r\nc\r\n' } },
  { name: 'a CRLF file and a diff git wrote from it (CR in every line)', git: 'same',
    files: { 'f.txt': 'a\r\nb\r\nc\r\n' },
    patch: P(...H('f.txt'), '@@ -1,3 +1,3 @@', ' a\r', '-b\r', '+B\r', ' c\r'),
    expect: { 'f.txt': 'a\r\nB\r\nc\r\n' } },
  { name: 'no final newline before and after', git: 'same',
    files: { 'f.txt': 'a\nb' },
    patch: P(...H('f.txt'), '@@ -1,2 +1,2 @@', ' a', '-b', '\\ No newline at end of file', '+c', '\\ No newline at end of file'),
    expect: { 'f.txt': 'a\nc' } },
  { name: 'the final newline is added', git: 'same',
    files: { 'f.txt': 'a\nb' },
    patch: P(...H('f.txt'), '@@ -1,2 +1,2 @@', ' a', '-b', '\\ No newline at end of file', '+b'),
    expect: { 'f.txt': 'a\nb\n' } },
  { name: 'the final newline is removed', git: 'same',
    files: { 'f.txt': 'a\nb\n' },
    patch: P(...H('f.txt'), '@@ -1,2 +1,2 @@', ' a', '-b', '+b', '\\ No newline at end of file'),
    expect: { 'f.txt': 'a\nb' } },
  { name: 'a CRLF file without a final newline', git: 'same',
    files: { 'f.txt': 'a\r\nb' },
    patch: P(...H('f.txt'), '@@ -1,2 +1,2 @@', ' a\r', '-b', '\\ No newline at end of file', '+c', '\\ No newline at end of file'),
    expect: { 'f.txt': 'a\r\nc' } },
  { name: 'a line inserted before a last line without newline', git: 'same',
    files: { 'f.txt': 'a\nb' },
    patch: P(...H('f.txt'), '@@ -1,2 +1,3 @@', ' a', '+x', ' b', '\\ No newline at end of file'),
    expect: { 'f.txt': 'a\nx\nb' } },
  { name: 'the patch says the old last line has no newline, the file has one', git: 'same',
    files: { 'f.txt': 'a\nb\n' },
    patch: P(...H('f.txt'), '@@ -1,2 +1,2 @@', ' a', '-b', '\\ No newline at end of file', '+c'),
    error: 'context_mismatch' },
  { name: 'a diff without the no-newline marker on a file that has no final newline', git: 'differs',
    why: 'git compares the missing newline as content; the engine matches the line and writes the newline the diff gives the new line',
    files: { 'f.txt': 'a\nb' },
    patch: P(...H('f.txt'), '@@ -1,2 +1,2 @@', ' a', '-b', '+c'),
    expect: { 'f.txt': 'a\nc\n' } },
  { name: 'an empty file gets two lines', git: 'same',
    files: { 'f.txt': '' },
    patch: P('diff --git a/f.txt b/f.txt', ...H('f.txt'), '@@ -0,0 +1,2 @@', '+one', '+two'),
    expect: { 'f.txt': L('one', 'two') } },
  { name: 'a new file from /dev/null', git: 'same',
    files: {},
    patch: P('diff --git a/new.txt b/new.txt', 'new file mode 100644', '--- /dev/null', '+++ b/new.txt', '@@ -0,0 +1,2 @@', '+hello', '+world'),
    expect: { 'new.txt': L('hello', 'world') } },
  { name: 'a new file that already exists', git: 'same',
    files: { 'new.txt': 'mine\n' },
    patch: P('diff --git a/new.txt b/new.txt', 'new file mode 100644', '--- /dev/null', '+++ b/new.txt', '@@ -0,0 +1 @@', '+hello'),
    error: 'file_exists' },
  { name: 'a new empty file (no hunk)', git: 'same',
    files: {},
    patch: P('diff --git a/empty.txt b/empty.txt', 'new file mode 100644', 'index 0000000..e69de29'),
    expect: { 'empty.txt': '' } },
  { name: 'a deleted file', git: 'same',
    files: { 'f.txt': L('a', 'b'), 'keep.txt': 'k\n' },
    patch: P('diff --git a/f.txt b/f.txt', 'deleted file mode 100644', '--- a/f.txt', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-a', '-b'),
    expect: { 'keep.txt': 'k\n' } },
  { name: 'a deletion of a file that has more lines than the diff removes', git: 'same',
    files: { 'f.txt': L('a', 'b', 'c') },
    patch: P('diff --git a/f.txt b/f.txt', 'deleted file mode 100644', '--- a/f.txt', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-a', '-b'),
    error: 'context_mismatch' },
  { name: 'a deletion of an empty file (no hunk) that is not empty', git: 'same',
    files: { 'f.txt': 'text\n' },
    patch: P('diff --git a/f.txt b/f.txt', 'deleted file mode 100644', 'index e69de29..0000000'),
    error: 'delete_not_empty' },
  { name: 'a whitespace-only change (spaces to a tab)', git: 'same',
    files: { 'f.js': L('function f() {', '  return 1;', '}') },
    patch: P(...H('f.js'), '@@ -1,3 +1,3 @@', ' function f() {', '-  return 1;', '+\treturn 1;', ' }'),
    expect: { 'f.js': L('function f() {', '\treturn 1;', '}') } },
  { name: 'trailing whitespace in the file and not in the context: fuzz 1, the file\'s context kept', git: 'differs', gitApplies: false,
    why: 'git requires exact context unless told to ignore whitespace; the engine\'s ladder allows it and reports fuzz 1',
    files: { 'f.txt': L('a  ', 'b', 'c') },
    patch: P(...H('f.txt'), '@@ -1,3 +1,3 @@', ' a', '-b', '+B', ' c'),
    expect: { 'f.txt': L('a  ', 'B', 'c') }, hunks: [{ fuzz: 1, fuzzName: 'trailing-whitespace' }] },
  { name: 'tabs in the file, spaces in the diff: fuzz 2, the + line as written', git: 'differs', gitApplies: false,
    why: 'the third rung (trimmed) matches lines whose indentation differs',
    files: { 'f.js': L('\tif (a) {', '\t\tb();', '\t}') },
    patch: P(...H('f.js'), '@@ -1,3 +1,3 @@', '     if (a) {', '-        b();', '+        c();', '     }'),
    expect: { 'f.js': L('\tif (a) {', '        c();', '\t}') }, hunks: [{ fuzz: 2, fuzzName: 'trimmed' }] },
  { name: 'curly quotes and an em dash in the file, ASCII in the diff: fuzz 3', git: 'differs', gitApplies: false,
    why: 'the fourth rung normalises Unicode punctuation',
    files: { 'f.js': L('const s = \u201chi\u201d \u2014 ok;', 'x', 'y') },
    patch: P(...H('f.js'), '@@ -1,3 +1,3 @@', ' const s = "hi" - ok;', '-x', '+X', ' y'),
    expect: { 'f.js': L('const s = \u201chi\u201d \u2014 ok;', 'X', 'y') }, hunks: [{ fuzz: 3, fuzzName: 'unicode-punctuation' }] },
  { name: 'a non-breaking space in the file', git: 'differs', gitApplies: false, why: 'the fourth rung reads U+00A0 as a space',
    files: { 'f.txt': L('a\u00a0b', 'c') },
    patch: P(...H('f.txt'), '@@ -1,2 +1,2 @@', ' a b', '-c', '+C'),
    expect: { 'f.txt': L('a\u00a0b', 'C') }, hunks: [{ fuzz: 3 }] },
  { name: 'rename + edit', git: 'same',
    files: { 'old.txt': L('a', 'b', 'c') },
    patch: P('diff --git a/old.txt b/new.txt', 'similarity index 66%', 'rename from old.txt', 'rename to new.txt', '--- a/old.txt', '+++ b/new.txt', '@@ -1,3 +1,3 @@', ' a', '-b', '+B', ' c'),
    expect: { 'new.txt': L('a', 'B', 'c') } },
  { name: 'a pure rename into a new folder', git: 'same',
    files: { 'old.txt': L('a') },
    patch: P('diff --git a/old.txt b/dir/new.txt', 'similarity index 100%', 'rename from old.txt', 'rename to dir/new.txt'),
    expect: { 'dir/new.txt': L('a') } },
  { name: 'a rename onto a file that exists', git: 'same',
    files: { 'old.txt': L('a'), 'new.txt': L('z') },
    patch: P('diff --git a/old.txt b/new.txt', 'similarity index 100%', 'rename from old.txt', 'rename to new.txt'),
    error: 'file_exists' },
  { name: 'a copy + edit', git: 'same',
    files: { 'src.txt': L('a', 'b', 'c') },
    patch: P('diff --git a/src.txt b/dst.txt', 'similarity index 66%', 'copy from src.txt', 'copy to dst.txt', '--- a/src.txt', '+++ b/dst.txt', '@@ -1,3 +1,3 @@', ' a', '-b', '+B', ' c'),
    expect: { 'src.txt': L('a', 'b', 'c'), 'dst.txt': L('a', 'B', 'c') } },
  { name: 'a hunk at the start of the file', git: 'same',
    files: { 'f.txt': L(...F10) },
    patch: P(...H('f.txt'), '@@ -1,3 +1,3 @@', '-l1', '+L1', ' l2', ' l3'),
    expect: { 'f.txt': L('L1', ...F10.slice(1)) } },
  { name: 'a hunk that names line 1 while the file gained a line on top: refused', git: 'same',
    files: { 'f.txt': L('extra', ...F10) },
    patch: P(...H('f.txt'), '@@ -1,3 +1,3 @@', '-l1', '+L1', ' l2', ' l3'),
    error: 'context_mismatch' },
  { name: 'a hunk without trailing context appends at the end', git: 'same',
    files: { 'f.txt': L(...F10) },
    patch: P(...H('f.txt'), '@@ -9,2 +9,3 @@', ' l9', ' l10', '+l11'),
    expect: { 'f.txt': L(...F10, 'l11') } },
  { name: 'a hunk without trailing context while the file goes on: refused', git: 'same',
    files: { 'f.txt': L(...F10, 'l11', 'l12') },
    patch: P(...H('f.txt'), '@@ -9,2 +9,2 @@', ' l9', '-l10', '+L10'),
    error: 'context_mismatch' },
  { name: 'two hunks with different offsets', git: 'same',
    files: { 'f.txt': L('x', 'l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'y', 'l7', 'l8', 'l9', 'l10') },
    patch: P(...H('f.txt'), '@@ -2,3 +2,3 @@', ' l2', '-l3', '+L3', ' l4', '@@ -8,3 +8,3 @@', ' l8', '-l9', '+L9', ' l10'),
    expect: { 'f.txt': L('x', 'l1', 'l2', 'L3', 'l4', 'l5', 'l6', 'y', 'l7', 'l8', 'L9', 'l10') },
    hunks: [{ offset: 1, line: 3 }, { offset: 2, line: 10 }] },
  { name: 'two hunks on two copies of a block, the line numbers keep them apart', git: 'same',
    files: { 'f.txt': L('a', 'b', 'c', 'x', 'a', 'b', 'c', 'x', 'a', 'b', 'c') },
    patch: P(...H('f.txt'), '@@ -5,3 +5,3 @@', ' a', '-b', '+B1', ' c', '@@ -9,3 +9,3 @@', ' a', '-b', '+B2', ' c'),
    expect: { 'f.txt': L('a', 'b', 'c', 'x', 'a', 'B1', 'c', 'x', 'a', 'B2', 'c') } },
  { name: 'the offset of a hunk carries to the next: it picks the right one of two copies', git: 'same',
    files: { 'f.txt': L('p1', 'p2', 'h1', 'h2', 'h3', 'a', 'b', 'c', 'q', 'a', 'b', 'c', 'q', 'a', 'b', 'c', 'z') },
    patch: P(...H('f.txt'), '@@ -2,3 +2,3 @@', ' h2', '-h3', '+H3', ' a', '@@ -8,3 +8,3 @@', ' a', '-b', '+B', ' c'),
    expect: { 'f.txt': L('p1', 'p2', 'h1', 'h2', 'H3', 'a', 'b', 'c', 'q', 'a', 'B', 'c', 'q', 'a', 'b', 'c', 'z') },
    hunks: [{ offset: 2 }, { offset: 2, line: 10 }] },
  { name: 'a line added after a last line that has no newline, the diff not saying so', git: 'differs',
    why: 'git compares the missing newline as content; the engine matches the line and gives it the newline it needs before the added one',
    files: { 'f.txt': 'a\nb' },
    patch: P(...H('f.txt'), '@@ -1,2 +1,3 @@', ' a', ' b', '+c'),
    expect: { 'f.txt': 'a\nb\nc\n' } },
  { name: 'hunks out of order: refused', git: 'differs',
    why: 'git searches the whole file for every hunk; the engine places each hunk after the one before it, so two hunks never overlap or swap',
    files: { 'f.txt': L(...F10) },
    patch: P(...H('f.txt'), '@@ -7,3 +7,3 @@', ' l7', '-l8', '+L8', ' l9', '@@ -2,3 +2,3 @@', ' l2', '-l3', '+L3', ' l4'),
    error: 'context_mismatch' },
  { name: 'an insertion without context at the end of the file', git: 'same',
    files: { 'f.txt': L('a', 'b', 'c') },
    patch: P(...H('f.txt'), '@@ -3,0 +4 @@', '+d'),
    expect: { 'f.txt': L('a', 'b', 'c', 'd') } },
  { name: 'an insertion without context in the middle of the file: refused', git: 'differs',
    why: 'a hunk with no line to match is placed only at the start or the end of a file, never by its line number alone',
    files: { 'f.txt': L('a', 'b', 'c') },
    patch: P(...H('f.txt'), '@@ -1,0 +2 @@', '+x'),
    error: 'no_context' },
  { name: 'an empty line in a hunk is an empty context line', git: 'same',
    files: { 'f.txt': L('a', '', 'b') },
    patch: P(...H('f.txt'), '@@ -1,3 +1,3 @@', ' a', '', '-b', '+B'),
    expect: { 'f.txt': L('a', '', 'B') } },
  { name: 'a mode change only', git: 'same',
    files: { 'run.sh': 'echo\n' },
    patch: P('diff --git a/run.sh b/run.sh', 'old mode 100644', 'new mode 100755'),
    expect: { 'run.sh': 'echo\n' }, mode: { 'run.sh': '100755' } },
  { name: 'a modified file that does not exist', git: 'same',
    files: {},
    patch: P(...H('f.txt'), '@@ -1,2 +1,2 @@', ' a', '-b', '+B'),
    error: 'file_missing' },
  { name: 'two files, the second does not apply: nothing is changed', git: 'same',
    files: { 'a.txt': L('a', 'b'), 'b.txt': L('x', 'y') },
    patch: P('diff --git a/a.txt b/a.txt', ...H('a.txt'), '@@ -1,2 +1,2 @@', ' a', '-b', '+B', 'diff --git a/b.txt b/b.txt', ...H('b.txt'), '@@ -1,2 +1,2 @@', ' x', '-q', '+Q'),
    error: 'context_mismatch', errorFile: 'b.txt', errorHunk: 1 },
  { name: 'a quoted path with a space and octal escapes', git: 'same',
    files: { 'dir/na\u00efve file.txt': L('a', 'b') },
    patch: P('diff --git "a/dir/na\\303\\257ve file.txt" "b/dir/na\\303\\257ve file.txt"', '--- "a/dir/na\\303\\257ve file.txt"', '+++ "b/dir/na\\303\\257ve file.txt"', '@@ -1,2 +1,2 @@', ' a', '-b', '+B'),
    expect: { 'dir/na\u00efve file.txt': L('a', 'B') } },
  { name: 'an e-mail around the diff (format-patch)', git: 'same',
    files: { 'f.txt': L('a', 'b', 'c') },
    patch: P('From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001', 'From: Someone <someone@example.invalid>', 'Subject: [PATCH] change b', '', '---', ' f.txt | 2 +-', ' 1 file changed', '',
      'diff --git a/f.txt b/f.txt', 'index 1111111..2222222 100644', ...H('f.txt'), '@@ -1,3 +1,3 @@ section heading', ' a', '-b', '+B', ' c', '-- ', '2.40.0', ''),
    expect: { 'f.txt': L('a', 'B', 'c') } },
  { name: 'a hunk cut off before its counts are met', git: 'same',
    files: { 'f.txt': L('a', 'b', 'c') },
    patch: P(...H('f.txt'), '@@ -1,3 +1,3 @@', ' a', '-b'),
    error: 'malformed' },
  { name: 'a line inside a hunk that is no hunk line', git: 'same',
    files: { 'f.txt': L('a', 'b', 'c') },
    patch: P(...H('f.txt'), '@@ -1,3 +1,3 @@', ' a', '*b', '+B', ' c'),
    error: 'malformed' },
  { name: 'a binary patch', git: 'same',
    files: { 'i.png': 'x' },
    patch: P('diff --git a/i.png b/i.png', 'index 1111111..2222222 100644', 'GIT binary patch', 'literal 1', 'Ic${', '', 'literal 1', 'Ic${', ''),
    error: 'binary' },
  { name: 'a "Binary files differ" line', git: 'same',
    files: { 'i.png': 'x' },
    patch: P('diff --git a/i.png b/i.png', 'index 1111111..2222222 100644', 'Binary files a/i.png and b/i.png differ'),
    error: 'binary' },
  { name: 'a plain diff (no git header) with a/ and b/', git: 'same',
    files: { 'f.txt': L('a', 'b') },
    patch: P('--- a/f.txt\t2026-01-01 00:00:00.000000000 +0000', '+++ b/f.txt\t2026-01-01 00:00:01.000000000 +0000', '@@ -1,2 +1,2 @@', ' a', '-b', '+B'),
    expect: { 'f.txt': L('a', 'B') } },
  { name: 'an @@ header that counts too few lines: refused, not half applied', git: 'differs', gitApplies: true,
    why: 'git applies the counted lines and ignores the rest; the engine refuses lines that look like hunk lines right after a hunk',
    files: { 'f.txt': L('a', 'b', 'c', 'd', 'e', 'f') },
    patch: P(...H('f.txt'), '@@ -2,3 +2,3 @@', ' b', '-c', '+C', ' d', '-e', '+E', ' f'),
    error: 'malformed' },
  { name: 'a ---/+++ header without any hunk', git: 'differs', why: 'a header that changes nothing is refused as malformed, never taken as done',
    files: { 'f.txt': L('a') }, patch: P(...H('f.txt')), error: 'malformed' },
  { name: 'a diff --git header with nothing to change', git: 'differs', why: 'a header that changes nothing is refused as malformed, never taken as done',
    files: { 'f.txt': L('a') }, patch: P('diff --git a/f.txt b/f.txt', 'index 1111111..2222222 100644'), error: 'malformed' },
  { name: 'an LF file and a diff whose every line got a CR on its way (a CRLF clipboard): LF out', git: 'differs', gitApplies: false,
    why: 'git compares the carriage return as content; the engine sees CRs on every patch line and none on the lines they match, and drops them',
    files: { 'f.txt': L('a', 'b', 'c') },
    patch: P(...H('f.txt'), '@@ -1,3 +1,3 @@', ' a', '-b', '+B', ' c').replace(/\n/g, '\r\n').replace('--- a/f.txt\r\n+++ b/f.txt\r\n', '--- a/f.txt\n+++ b/f.txt\n'),
    expect: { 'f.txt': L('a', 'B', 'c') } },
  { name: 'a mixed file: the CRs a git diff carries are kept as given', git: 'same',
    files: { 'f.txt': 'a\r\nb\nc\r\n' },
    patch: P(...H('f.txt'), '@@ -1,3 +1,4 @@', ' a\r', '-b', '+B', '+n\r', ' c\r'),
    expect: { 'f.txt': 'a\r\nB\nn\r\nc\r\n' } },
  { name: 'a file with a byte order mark, its first line replaced by a diff without one: the mark stays', git: 'differs', gitApplies: false,
    why: 'git compares the mark as part of the first line; the engine sets it aside and keeps it',
    files: { 'f.js': '\ufeffimport a;\nb();\n' },
    patch: P(...H('f.js'), '@@ -1,2 +1,2 @@', '-import a;', '+import z;', ' b();'),
    expect: { 'f.js': '\ufeffimport z;\nb();\n' }, hunks: [{ fuzz: 0 }] },
  { name: 'a file with a byte order mark and a diff git wrote from it (the mark in the line)', git: 'same',
    files: { 'f.js': '\ufeffimport a;\nb();\n' },
    patch: P(...H('f.js'), '@@ -1,2 +1,2 @@', '-\ufeffimport a;', '+\ufeffimport z;', ' b();'),
    expect: { 'f.js': '\ufeffimport z;\nb();\n' } },
  { name: 'a symlink (mode 120000)', git: 'not-run', why: 'the engine writes text files only; git would make a link',
    files: {},
    patch: P('diff --git a/link b/link', 'new file mode 120000', '--- /dev/null', '+++ b/link', '@@ -0,0 +1 @@', '+../../etc/passwd', '\\ No newline at end of file'),
    error: 'unsupported_mode' },
  { name: 'a path that climbs out of the root', git: 'not-run', why: 'never run git on a path that could write outside the temp folder',
    files: {},
    patch: P('--- /dev/null', '+++ b/../outside.txt', '@@ -0,0 +1 @@', '+x'),
    error: 'unsafe_path' },
  { name: 'an absolute path', git: 'not-run', why: 'never run git on a path that could write outside the temp folder',
    files: {},
    patch: P('diff --git a/etc/x b/etc/x', '--- /etc/x', '+++ /etc/x', '@@ -1 +1 @@', '-a', '+b'),
    error: 'unsafe_path' },
];

{
  const gitCases = ADVERSARIAL.filter((c) => c.git !== 'not-run');
  const gitAnswers = await pool(gitCases, 8, (c) => gitApply(c.files, c.patch));
  const byName = new Map(gitCases.map((c, index) => [c.name, gitAnswers[index]]));
  let same = 0;
  let differs = 0;
  for (const c of ADVERSARIAL) {
    let result;
    assert.doesNotThrow(() => { result = applyPatch(c.patch, c.files); }, c.name);
    if (c.error) {
      assert.equal(result.ok, false, `${c.name}: refused`);
      assert.equal(result.error.code, c.error, `${c.name}: ${result.error.code} - ${result.error.message}`);
      assert.ok(result.error.message.length > 10, `${c.name}: says why`);
      if (c.errorFile) {
        assert.equal(result.error.file, c.errorFile, `${c.name}: names the file`);
        assert.ok(result.error.message.includes(c.errorFile), `${c.name}: the message names the file`);
      }
      if (c.errorHunk) {
        assert.equal(result.error.hunk, c.errorHunk, `${c.name}: names the hunk`);
        assert.ok(result.error.message.includes(`hunk ${c.errorHunk}`), `${c.name}: the message names the hunk`);
      }
    } else {
      assert.ok(result.ok, `${c.name}: ${result.error?.message}`);
      const expected = { ...c.files, ...c.expect };
      for (const key of Object.keys(c.files)) if (!(key in c.expect)) {
        const kept = !result.changes.some((change) => change.path === key);
        if (!kept) delete expected[key];
      }
      assertSameFiles(afterEngine(c.files, result), c.expect ? sortKeys(Object.fromEntries(Object.entries(expected).filter(([k]) => k in c.expect || !result.changes.some((ch) => ch.path === k)))) : expected, c.name);
      if (c.hunks) c.hunks.forEach((want, index) => {
        const got = result.reports.flatMap((r) => r.hunks)[index];
        for (const [key, value] of Object.entries(want)) assert.equal(got[key], value, `${c.name}: hunk ${index + 1} ${key}`);
      });
      if (c.mode) for (const [file, mode] of Object.entries(c.mode)) assert.equal(result.changes.find((change) => change.path === file)?.mode, mode, `${c.name}: the mode of ${file}`);
    }
    if (c.git === 'not-run') continue;
    const run = byName.get(c.name);
    if (c.git === 'same') {
      same += 1;
      if (c.error) {
        assert.notEqual(run.code, 0, `${c.name}: git refuses it too`);
        assertSameFiles(run.files, Object.fromEntries(Object.entries(c.files).filter(([, v]) => v !== null)), `${c.name}: git left the files alone`);
      } else {
        assert.equal(run.code, 0, `${c.name}: git takes it (${run.stderr})`);
        assertSameFiles(afterEngine(c.files, result), run.files, `${c.name}: engine vs git`);
      }
    } else {
      differs += 1;
      assert.ok(c.why, `${c.name}: a deliberate difference says why`);
      if (c.gitApplies !== undefined) assert.equal(run.code === 0, c.gitApplies, `${c.name}: git ${c.gitApplies ? 'takes' : 'refuses'} it (${run.stderr.trim()})`);
    }
  }
  ok(`${ADVERSARIAL.length} adversarial unified diffs: ${same} where git agrees byte for byte (or refuses too), ${differs} deliberate differences, ${ADVERSARIAL.length - same - differs} not run through git`);
}

// ------------------------------------------------------------------ C. the envelope
const E = (...lines) => ['*** Begin Patch', ...lines, '*** End Patch'].join('\n') + '\n';
const ENVELOPE = [
  { name: 'add a file', files: {},
    patch: E('*** Add File: src/new.js', '+export const a = 1;', '+', '+export const b = 2;'),
    expect: { 'src/new.js': L('export const a = 1;', '', 'export const b = 2;') } },
  { name: 'add an empty file', files: {}, patch: E('*** Add File: empty.txt'), expect: { 'empty.txt': '' } },
  { name: 'update with two @@ sections on a CRLF file: the anchors keep the two returns apart, CRLF out',
    files: { 'a.js': 'class A {\r\n  f() {\r\n    return 1;\r\n  }\r\n  g() {\r\n    return 1;\r\n  }\r\n}\r\n' },
    patch: E('*** Update File: a.js', '@@ f() {', '-    return 1;', '+    return 10;', '@@ g() {', '-    return 1;', '+    return 20;'),
    expect: { 'a.js': 'class A {\r\n  f() {\r\n    return 10;\r\n  }\r\n  g() {\r\n    return 20;\r\n  }\r\n}\r\n' } },
  { name: 'delete a file', files: { 'old.txt': 'x\n', 'keep.txt': 'k\n' }, patch: E('*** Delete File: old.txt'), expect: { 'keep.txt': 'k\n' }, gone: ['old.txt'] },
  { name: 'move + update', files: { 'a.txt': L('a', 'b', 'c') },
    patch: E('*** Update File: a.txt', '*** Move to: b/a2.txt', '@@', ' a', '-b', '+B'),
    expect: { 'b/a2.txt': L('a', 'B', 'c') }, gone: ['a.txt'] },
  { name: 'move only', files: { 'a.txt': L('a') }, patch: E('*** Update File: a.txt', '*** Move to: c.txt'), expect: { 'c.txt': L('a') }, gone: ['a.txt'] },
  { name: 'the end-of-file anchor picks the last copy', files: { 'f.txt': L('x', 'end', 'y', 'end') },
    patch: E('*** Update File: f.txt', '@@', '-end', '+END', '*** End of File'),
    expect: { 'f.txt': L('x', 'end', 'y', 'END') } },
  { name: 'without the end-of-file anchor the same lines are ambiguous', files: { 'f.txt': L('x', 'end', 'y', 'end') },
    patch: E('*** Update File: f.txt', '@@', '-end', '+END'), error: 'ambiguous' },
  { name: 'the first section without @@', files: { 'f.txt': L('a', 'b', 'c') },
    patch: E('*** Update File: f.txt', ' a', '-b', '+B'), expect: { 'f.txt': L('a', 'B', 'c') } },
  { name: 'the same lines twice and no anchor: refused', files: { 'f.txt': L('a', 'b', 'a', 'b') },
    patch: E('*** Update File: f.txt', '@@', ' a', '-b', '+B'), error: 'ambiguous', errorFile: 'f.txt', errorHunk: 1 },
  { name: 'an anchor picks the second function', files: { 'f.py': L('def one():', '  x = 1', 'def two():', '  x = 1') },
    patch: E('*** Update File: f.py', '@@ def two():', '-  x = 1', '+  x = 2'), expect: { 'f.py': L('def one():', '  x = 1', 'def two():', '  x = 2') } },
  { name: 'nested anchors (class, then method)', files: { 'f.py': L('class A:', '  def run(self):', '    return 1', 'class B:', '  def run(self):', '    return 1') },
    patch: E('*** Update File: f.py', '@@ class B:', '@@   def run(self):', '-    return 1', '+    return 2'),
    expect: { 'f.py': L('class A:', '  def run(self):', '    return 1', 'class B:', '  def run(self):', '    return 2') } },
  { name: 'an anchor that occurs twice: refused', files: { 'f.py': L('def f():', '  a', 'def f():', '  b') },
    patch: E('*** Update File: f.py', '@@ def f():', '-  b', '+  c'), error: 'ambiguous' },
  { name: 'an anchor that is not in the file', files: { 'f.py': L('def f():', '  a') },
    patch: E('*** Update File: f.py', '@@ def g():', '-  a', '+  c'), error: 'context_mismatch' },
  { name: 'an insertion right after the anchor', files: { 'f.py': L('def one():', '  x = 1') },
    patch: E('*** Update File: f.py', '@@ def one():', '+  y = 0'), expect: { 'f.py': L('def one():', '  y = 0', '  x = 1') } },
  { name: 'an insertion without anchor appends at the end', files: { 'f.txt': L('a') },
    patch: E('*** Update File: f.txt', '@@', '+z'), expect: { 'f.txt': L('a', 'z') } },
  { name: 'straight quotes in the patch, curly quotes in the file: fuzz 3', files: { 'f.py': L('print(\u201chi\u201d)', 'x') },
    patch: E('*** Update File: f.py', '@@', ' print("hi")', '-x', '+y'), expect: { 'f.py': L('print(\u201chi\u201d)', 'y') }, hunks: [{ fuzz: 3 }] },
  { name: 'an envelope written with CRLF', files: { 'f.txt': L('a', 'b') },
    patch: E('*** Update File: f.txt', '@@', ' a', '-b', '+B').replace(/\n/g, '\r\n'), expect: { 'f.txt': L('a', 'B') } },
  { name: 'a file without final newline, its last line rewritten', files: { 'f.txt': 'a\nb' },
    patch: E('*** Update File: f.txt', '@@', ' a', '-b', '+c'), expect: { 'f.txt': 'a\nc\n' } },
  { name: 'a file without final newline, its last line kept as context', files: { 'f.txt': 'a\nb' },
    patch: E('*** Update File: f.txt', '@@', '-a', '+A', ' b'), expect: { 'f.txt': 'A\nb' } },
  { name: 'two files in one envelope', files: { 'a.txt': L('a'), 'b.txt': L('b') },
    patch: E('*** Update File: a.txt', '@@', '-a', '+A', '*** Update File: b.txt', '@@', '-b', '+B', '*** Add File: c.txt', '+c'),
    expect: { 'a.txt': L('A'), 'b.txt': L('B'), 'c.txt': L('c') } },
  { name: 'update a missing file', files: {}, patch: E('*** Update File: f.txt', '@@', '-a', '+b'), error: 'file_missing' },
  { name: 'add a file that exists', files: { 'f.txt': 'x\n' }, patch: E('*** Add File: f.txt', '+y'), error: 'file_exists' },
  { name: 'delete a missing file', files: {}, patch: E('*** Delete File: f.txt'), error: 'file_missing' },
  { name: 'move onto a file that exists', files: { 'a.txt': L('a'), 'b.txt': L('b') }, patch: E('*** Update File: a.txt', '*** Move to: b.txt'), error: 'file_exists' },
  { name: 'an unsafe path', files: {}, patch: E('*** Add File: ../x.txt', '+x'), error: 'unsafe_path' },
  { name: 'an unsafe move target', files: { 'a.txt': 'a\n' }, patch: E('*** Update File: a.txt', '*** Move to: C:/x.txt'), error: 'unsafe_path' },
];
const MALFORMED_ENVELOPES = [
  ['no end marker', '*** Begin Patch\n*** Add File: a.txt\n+a\n'],
  ['an unknown marker', E('*** Rename File: a.txt')],
  ['an add line without +', E('*** Add File: a.txt', 'a')],
  ['an update with nothing to change', E('*** Update File: a.txt')],
  ['a change line before any file', E('+a')],
  ['an empty @@ section', E('*** Update File: a.txt', '@@ f()', '@@', '-a', '+b').replace('@@ f()\n@@', '@@ f()\n*** End of File\n@@')],
  ['text after the end marker', E('*** Delete File: a.txt') + 'trailing words\n'],
  ['an empty envelope', E()],
  ['a file name missing', E('*** Delete File: ')],
  ['end of file before the change', E('*** Update File: a.txt', '*** End of File', '-a')],
];

for (const c of ENVELOPE) {
  let result;
  assert.doesNotThrow(() => { result = applyPatch(c.patch, c.files); }, c.name);
  if (c.error) {
    assert.equal(result.ok, false, `${c.name}: refused`);
    assert.equal(result.error.code, c.error, `${c.name}: ${result.error.code} - ${result.error.message}`);
    if (c.errorFile) assert.ok(result.error.message.includes(c.errorFile) && result.error.file === c.errorFile, `${c.name}: names the file`);
    if (c.errorHunk) assert.ok(result.error.message.includes(`hunk ${c.errorHunk}`) && result.error.hunk === c.errorHunk, `${c.name}: names the hunk`);
    continue;
  }
  assert.ok(result.ok, `${c.name}: ${result.error?.message}`);
  assert.equal(result.format, 'envelope');
  const after = afterEngine(c.files, result);
  for (const [file, text] of Object.entries(c.expect)) assert.equal(after[file], text, `${c.name}: ${file}`);
  for (const file of c.gone ?? []) assert.ok(!(file in after), `${c.name}: ${file} is gone`);
  if (c.hunks) c.hunks.forEach((want, index) => {
    const got = result.reports.flatMap((r) => r.hunks)[index];
    for (const [key, value] of Object.entries(want)) assert.equal(got[key], value, `${c.name}: hunk ${index + 1} ${key}`);
  });
}
for (const [name, text] of MALFORMED_ENVELOPES) {
  const result = applyPatch(text, { 'a.txt': 'a\n' });
  assert.equal(result.ok, false, `malformed envelope (${name}) is refused`);
  assert.ok(['malformed', 'empty'].includes(result.error.code), `malformed envelope (${name}): ${result.error.code} - ${result.error.message}`);
}
ok(`${ENVELOPE.length} envelope cases and ${MALFORMED_ENVELOPES.length} malformed envelopes`);

// ------------------------------------------------------------------ D. parse-level refusals, the API, purity
{
  const accepted = ['a.txt', 'dir/sub/file.js', '.gitignore', 'dir/.github/x.yml', 'na\u00efve file.txt', '~x', 'a..b', '...x/y'];
  for (const p of accepted) assert.equal(checkPatchPath(p), p, `path accepted: ${p}`);
  const refused = ['', '/etc/passwd', '\\\\server\\share\\x', 'C:/x', 'c:x', 'a/../b', '../a', '..', 'a/./b', './a', 'a//b', 'a/', 'a\\b', 'a\0b', 'a\nb', 'a\tb',
    '.git/config', 'sub/.GIT/hooks/x', 'GIT~1/config', 'CON', 'aux.txt', 'dir/nul', 'Com1.log', 'a.', 'dir/a /b', 'file:stream', 'x'.repeat(5000), 42, null];
  for (const p of refused) {
    assert.throws(() => checkPatchPath(p), (error) => error instanceof PatchError && error.code === 'unsafe_path', `path refused: ${JSON.stringify(p)?.slice(0, 40)}`);
  }
  // `..` also ends in a dot; it must be refused as what it is, a climb out of the folder, by its own rule.
  assert.throws(() => checkPatchPath('a/../b'), /a "\.\." segment/, 'a .. segment is named as such');
  ok(`${accepted.length} paths accepted, ${refused.length} refused (absolute, drive, UNC, .., ., empty segment, backslash, NUL and control characters, .git, device names, trailing dot or space, colon, length)`);

  assert.equal(PATCH_LIMITS.maxPatchBytes, 8 * 1024 * 1024);
  assert.equal(PATCH_LIMITS.maxFiles, 1000);
  assert.equal(PATCH_LIMITS.maxHunks, 10000);
  assert.equal(PATCH_LIMITS.maxFileBytes, 32 * 1024 * 1024);
  assert.equal(PATCH_LIMITS.maxSearchSteps, 100_000_000);
  {
    // A long hunk against a long file of equal lines: every start position compares almost the whole hunk. Refused at the bound, quickly.
    const file = 'a\n'.repeat(200_000) + 'b\n';
    const hunk = P(...H('f.txt'), '@@ -100,602 +100,602 @@', ...Array(600).fill(' a'), '-c', '+d', ' a');
    const started = performance.now();
    const result = applyPatch(hunk, { 'f.txt': file });
    const took = performance.now() - started;
    assert.equal(result.error?.code, 'too_large', `the search bound (${result.error?.message})`);
    assert.match(result.error.message, /f\.txt, hunk 1/);
    assert.ok(took < 20_000, `refused in ${Math.round(took)} ms`);
    const moved = P(...H('f.txt'), '@@ -2,3 +2,3 @@', ' a', '-b', '+B', ' c');
    const movedFile = { 'f.txt': 'x\n'.repeat(50) + 'a\nb\nc\nx\n' };
    assert.ok(applyPatch(moved, movedFile).ok, 'the moved hunk applies with the default bound');
    assert.equal(applyPatch(moved, movedFile, { limits: { maxSearchSteps: 20 } }).error?.code, 'too_large', 'a caller may lower the bound');
    ok(`a search past ${PATCH_LIMITS.maxSearchSteps} line comparisons is refused (${Math.round(took)} ms), and the bound can be lowered`);
  }
  assert.ok(Object.isFrozen(PATCH_LIMITS), 'the limits cannot be changed by a caller');
  assert.deepEqual(FUZZ_LEVELS, ['exact', 'trailing-whitespace', 'trimmed', 'unicode-punctuation']);
  const two = P(...H('a.txt'), '@@ -1,2 +1,2 @@', ' a', '-b', '+B', ...H('b.txt'), '@@ -1,2 +1,2 @@', ' a', '-b', '+B', '@@ -5,2 +5,2 @@', ' e', '-f', '+F');
  const code = (fn) => { try { fn(); return 'none'; } catch (error) { assert.ok(error instanceof PatchError, String(error)); return error.code; } };
  assert.equal(code(() => parsePatch(two, { limits: { maxPatchBytes: 20 } })), 'too_large');
  assert.equal(code(() => parsePatch(two, { limits: { maxFiles: 1 } })), 'too_many_files');
  assert.equal(code(() => parsePatch(two, { limits: { maxHunks: 2 } })), 'too_many_hunks');
  assert.equal(code(() => parsePatch(two, { limits: { maxPatchBytes: 1e12 } })), 'none', 'a caller may lower a limit, raising one past the default is ignored');
  assert.equal(code(() => parsePatch('x'.repeat(PATCH_LIMITS.maxPatchBytes + 1))), 'too_large');
  assert.equal(code(() => parsePatch('x'.repeat(PATCH_LIMITS.maxPatchBytes + 1), { limits: { maxPatchBytes: PATCH_LIMITS.maxPatchBytes * 2 } })), 'too_large', 'a raised limit is ignored');
  assert.equal(code(() => parsePatch('\u00e9'.repeat(PATCH_LIMITS.maxPatchBytes / 2 + 1))), 'too_large', 'the limit counts UTF-8 bytes, not characters');
  assert.equal(applyPatch(two, { 'a.txt': 'a\nb\n', 'b.txt': 'big'.repeat(100) }, { limits: { maxFileBytes: 50 } }).error.code, 'too_large', 'a file past the limit is refused');
  assert.equal(code(() => parsePatch(42)), 'malformed');
  assert.equal(code(() => parsePatch('')), 'empty');
  assert.equal(code(() => parsePatch('just some words\nand more\n')), 'empty');
  assert.equal(code(() => parsePatch(P(...H('a.txt'), '@@ -1 +1 @@', '-a\0', '+b'))), 'binary');
  assert.equal(code(() => parsePatch(P(...H('a.txt'), '@@ -1,x +1 @@', '-a', '+b'))), 'malformed');
  assert.equal(code(() => parsePatch(P(...H('a.txt'), '@@ -99999999999999999999,1 +1 @@', '-a', '+b'))), 'malformed');
  assert.equal(code(() => parsePatch(P('--- a/x.orig', '+++ b/x', '@@ -1 +1 @@', '-a', '+b'))), 'malformed', 'a plain diff whose two names differ is not guessed');
  assert.equal(code(() => parsePatch(P('diff --git a/a b/a', 'new file mode 160000', '--- /dev/null', '+++ b/a', '@@ -0,0 +1 @@', '+Subproject commit 1'))), 'unsupported_mode', 'a submodule');
  assert.equal(code(() => parsePatch(P('diff --git a/a b/a', 'old mode 100644', 'new mode 100600'))), 'malformed', 'a mode git never writes');
  ok('the limits (patch bytes, files, hunks, file bytes; a caller may only lower them) and malformed input are refused with their codes');

  const parsed = parsePatch(P('diff --git "a/q\\"x\\\\y\\tz" "b/q\\"x\\\\y\\tz"', '--- "a/q\\"x\\\\y\\tz"', '+++ "b/q\\"x\\\\y\\tz"', '@@ -1 +1 @@', '-a', '+b'), { checkPaths: false });
  assert.equal(parsed.files[0].newPath, 'q"x\\y\tz', 'git\'s C-style quoting is decoded');
  assert.equal(code(() => parsePatch(P('diff --git "a/q\\tz" "b/q\\tz"', '--- "a/q\\tz"', '+++ "b/q\\tz"', '@@ -1 +1 @@', '-a', '+b'))), 'unsafe_path', 'and the decoded name is checked');
  const envelope = parsePatch(E('*** Update File: a.txt', '*** Move to: b.txt', '@@ fn', ' x', '-y', '+z', '*** End of File'));
  assert.equal(envelope.format, 'envelope');
  assert.deepEqual({ kind: envelope.files[0].kind, oldPath: envelope.files[0].oldPath, newPath: envelope.files[0].newPath }, { kind: 'rename', oldPath: 'a.txt', newPath: 'b.txt' });
  assert.deepEqual(envelope.files[0].hunks[0].anchors, ['fn']);
  assert.equal(envelope.files[0].hunks[0].endOfFile, true);
  assert.deepEqual(envelope.files[0].hunks[0].lines.map((l) => l.op + l.text), [' x', '-y', '+z']);
  const unified = parsePatch(P('diff --git a/a.txt b/a.txt', 'index 1111111..2222222 100755', ...H('a.txt'), '@@ -3,2 +3,3 @@ heading', ' c', '+n', ' d'));
  assert.deepEqual({ format: unified.format, kind: unified.files[0].kind, oldMode: unified.files[0].oldMode, newMode: unified.files[0].newMode }, { format: 'unified', kind: 'modify', oldMode: '100755', newMode: '100755' });
  assert.deepEqual({ ...unified.files[0].hunks[0], lines: undefined }, { header: '@@ -3,2 +3,3 @@ heading', oldStart: 3, oldCount: 2, newStart: 3, newCount: 3, anchors: [], endOfFile: false, oldNoEol: false, newNoEol: false, lines: undefined });
  assert.deepEqual(patchPaths(parsePatch(E('*** Update File: a.txt', '*** Move to: b.txt', '@@', '-x', '+y', '*** Add File: c.txt', '+c', '*** Delete File: d.txt'))), { reads: ['a.txt', 'b.txt', 'c.txt', 'd.txt'], writes: ['a.txt', 'b.txt', 'c.txt', 'd.txt'] });
  ok('the parsed form: quoted names decoded and checked, envelope anchors and end-of-file, modes from the index line, patchPaths lists what to read and write');

  const direct = applyFilePatch('a\nb\nc\nd\n', unified.files[0]);
  assert.equal(direct.text, 'a\nb\nc\nn\nd\n', 'applyFilePatch works on one file');
  assert.deepEqual(direct.hunks, [{ hunk: 1, header: '@@ -3,2 +3,3 @@ heading', line: 3, expectedLine: 3, offset: 0, fuzz: 0, fuzzName: 'exact', matchedLines: 2, anchorLines: [] }]);
  assert.equal(direct.mode, '100755', 'the mode the index line names');
  assert.throws(() => applyFilePatch('x\n', unified.files[0]), (error) => error instanceof PatchError && error.code === 'context_mismatch' && error.hunk === 1 && error.file === 'a.txt');
  const twice = applyPatch(P(...H('a.txt'), '@@ -1,2 +1,2 @@', ' a', '-b', '+B', ...H('a.txt'), '@@ -1,2 +1,2 @@', ' a', '-B', '+C'), { 'a.txt': 'a\nb\n' });
  assert.ok(twice.ok && twice.changes.length === 1 && twice.changes[0].text === 'a\nC\n', 'the same file twice in one patch: the second section applies to the result of the first');
  const input = { 'a.txt': 'a\nb\n' };
  const frozen = JSON.stringify(input);
  applyPatch(P(...H('a.txt'), '@@ -1,2 +1,2 @@', ' a', '-b', '+B'), input);
  assert.equal(JSON.stringify(input), frozen, 'the input files are not modified');
  const asMap = applyPatch(P(...H('a.txt'), '@@ -1,2 +1,2 @@', ' a', '-b', '+B'), new Map([['a.txt', 'a\nb\n']]));
  assert.ok(asMap.ok && asMap.changes[0].text === 'a\nB\n', 'files may be a Map');
  ok('applyFilePatch, the same file twice, input left untouched, a Map of files');

  const source = fs.readFileSync(path.join(HUB, 'lib', 'patch-apply.mjs'), 'utf8');
  assert.doesNotMatch(source, /^\s*import\s/m, 'no import: no dependency and no I/O module');
  assert.doesNotMatch(source, /\brequire\s*\(|\bimport\s*\(|\bprocess\.|\bglobalThis\b|\bfetch\s*\(|\bDate\.now|\bMath\.random/, 'no require, dynamic import, process, global, network, clock or randomness');
  ok('the module imports nothing and touches no process, file, clock, network or random source');
}

// ------------------------------------------------------------------ E. seeded fuzz
{
  let seed = 0x5eed1234;
  const random = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pick = (list) => list[Math.floor(random() * list.length)];
  const NOISE = ['garbage', '+x', '-x', ' x', '', '\\ No newline at end of file', '@@ -1 +1 @@', '@@', '*** End Patch', '*** End of File', 'diff --git a/x b/x', '--- a/f.txt', '+++ /dev/null', '+\u201c', ' \t', '\r'];
  const mutateLines = (text, extra) => {
    const lines = text.split('\n');
    const i = Math.floor(random() * lines.length);
    switch (Math.floor(random() * 8)) {
      case 0: lines.splice(i, 1); break;
      case 1: lines.splice(i, 0, lines[i] ?? ''); break;
      case 2: if (i + 1 < lines.length) [lines[i], lines[i + 1]] = [lines[i + 1], lines[i]]; break;
      case 3: lines.splice(i, 0, pick(extra)); break;
      case 4: return text.slice(0, Math.floor(random() * text.length));
      case 5: lines[i] = (lines[i] ?? '').replace(/\d/, () => String(Math.floor(random() * 10))); break;
      case 6: { const at = Math.floor(random() * (lines[i] ?? '').length); lines[i] = (lines[i] ?? '').slice(0, at) + pick([' ', '\t', '-', '+', '\u2014', '"', 'z']) + (lines[i] ?? '').slice(at + 1); break; }
      default: lines.splice(i, 0, ...lines.slice(i, i + 3)); break;
    }
    return lines.join('\n');
  };
  const mutateFile = (text) => {
    switch (Math.floor(random() * 4)) {
      case 0: return text.replace(/\r?\n/g, random() < 0.5 ? '\r\n' : '\n');
      case 1: return text.replace(/\n$/, '');
      default: return mutateLines(text, ['inserted', '', '}', 'a', 'l5']);
    }
  };
  const bases = [
    ...corpus.cases.filter((c) => c.category !== 'multi-file').slice(0, 40).map((c) => ({ patch: c.patch, files: c.before })),
    ...ADVERSARIAL.filter((c) => c.git !== 'not-run').map((c) => ({ patch: c.patch, files: c.files })),
    ...ENVELOPE.map((c) => ({ patch: c.patch, files: c.files })),
  ];
  // Lines of a text as a file has them: split on LF, no line after a final LF, one CR before the LF is the line end, not the line.
  const lineTexts = (text) => {
    if (text === '') return [];
    const parts = text.split('\n');
    if (parts[parts.length - 1] === '') parts.pop();
    return parts.map((part) => (part.endsWith('\r') ? part.slice(0, -1) : part));
  };
  // The ladder written again here, apart from the engine's: the fourth rung by explicit character lists.
  const punct = (s) => s.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-').replace(/[\u2018\u2019\u201a\u201b]/g, '\'').replace(/[\u201c\u201d\u201e\u201f]/g, '"')
    .replace(/[\u00a0\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u202f\u205f\u3000]/g, ' ');
  const LADDER = [
    (a, b) => a === b,
    (a, b) => a.trimEnd() === b.trimEnd(),
    (a, b) => a.trim() === b.trim(),
    (a, b) => punct(a).trim() === punct(b).trim(),
  ];
  let applied = 0;
  let refused = 0;
  let verifiedHunks = 0;
  const ITERATIONS = 2000;
  for (let n = 0; n < ITERATIONS; n += 1) {
    const base = pick(bases);
    let patch = base.patch;
    const files = { ...base.files };
    const rounds = 1 + Math.floor(random() * 3);
    for (let r = 0; r < rounds; r += 1) {
      if (random() < 0.4) patch = mutateLines(patch, NOISE);
      else { const key = pick(Object.keys(files).length ? Object.keys(files) : ['f.txt']); if (typeof files[key] === 'string') files[key] = mutateFile(files[key]); }
    }
    if (process.env.PATCH_FUZZ_DUMP && Number(process.env.PATCH_FUZZ_DUMP) === n) fs.writeFileSync(path.join(os.tmpdir(), 'patch-fuzz-case.json'), JSON.stringify({ patch, files }));
    let first;
    let second;
    try { first = applyPatch(patch, files); second = applyPatch(patch, files); } catch (error) {
      assert.fail(`fuzz ${n}: an exception escaped (${error?.stack ?? error})\n${JSON.stringify(patch).slice(0, 400)}`);
    }
    assert.equal(JSON.stringify(first), JSON.stringify(second), `fuzz ${n}: the same answer twice`);
    if (!first.ok) {
      refused += 1;
      assert.ok(ERROR_CODES.has(first.error.code), `fuzz ${n}: a known code (${first.error.code})`);
      assert.equal(typeof first.error.message, 'string');
      continue;
    }
    applied += 1;
    // Every applied hunk is checked again, here, on the original text: its old lines are at the line it reports and match at the rung it reports,
    // and the new text is the old one with exactly those lines replaced.
    const parsed = parsePatch(patch);
    const state = new Map(Object.entries(files));
    const touches = new Map();
    for (const f of parsed.files) for (const p of new Set([f.oldPath, f.newPath])) if (p !== null) touches.set(p, (touches.get(p) ?? 0) + 1);
    parsed.files.forEach((filePatch, index) => {
      const report = first.reports[index];
      // A file that several sections touch is checked by the engine section by section; the re-check below needs the text before each section.
      if ([filePatch.oldPath, filePatch.newPath].some((p) => p !== null && touches.get(p) > 1)) {
        filePatch.hunks.forEach((hunk, h) => assert.equal(report.hunks[h].matchedLines, hunk.lines.filter((l) => l.op !== '+').length));
        return;
      }
      const original = filePatch.kind === 'add' ? '' : state.get(filePatch.oldPath);
      if (filePatch.kind === 'delete') { state.delete(filePatch.oldPath); return; }
      // A byte order mark is set aside unless a line of the patch holds one (docs/PATCH-ENGINE.md).
      const bomAside = original.startsWith('\ufeff') && !filePatch.hunks.some((h) => h.lines.some((l) => l.text.includes('\ufeff')));
      const body = bomAside ? original.slice(1) : original;
      const orig = lineTexts(body);
      const out = [];
      let cursor = 0;
      filePatch.hunks.forEach((hunk, h) => {
        const diag = report.hunks[h];
        const oldLines = hunk.lines.filter((l) => l.op !== '+');
        assert.equal(diag.matchedLines, oldLines.length, `fuzz ${n}: every old line of a hunk is matched`);
        const start = oldLines.length === 0 ? diag.line - 1 : diag.line - 1;
        assert.ok(start >= cursor, `fuzz ${n}: hunks do not overlap`);
        oldLines.forEach((l, k) => {
          const fileLine = orig[start + k];
          assert.ok(fileLine !== undefined, `fuzz ${n}: the hunk lies inside the file`);
          const same = LADDER[diag.fuzz](fileLine, l.text);
          assert.ok(same, `fuzz ${n}: line ${start + k + 1} matches at rung ${diag.fuzz} (${JSON.stringify(fileLine)} vs ${JSON.stringify(l.text)})`);
        });
        out.push(...orig.slice(cursor, start));
        let k = start;
        for (const l of hunk.lines) { if (l.op === ' ') out.push(orig[k++]); else if (l.op === '-') k += 1; else out.push(l.text); }
        cursor = k;
        verifiedHunks += 1;
      });
      out.push(...orig.slice(cursor));
      const target = filePatch.newPath;
      const written = first.changes.find((c) => c.path === target);
      const text = written ? written.text : state.get(target);
      const result = lineTexts(bomAside ? (text ?? '').replace(/^\ufeff/, '') : text ?? '');
      assert.ok(!bomAside || (text ?? '').startsWith('\ufeff'), `fuzz ${n}: the byte order mark is kept`);
      assert.deepEqual(result, out,`fuzz ${n}: the new text is the old one with the hunks' lines replaced, nothing else`);
    });
  }
  assert.ok(applied > 50 && refused > 50, `the fuzz exercises both outcomes (${applied} applied, ${refused} refused)`);
  ok(`${ITERATIONS} seeded fuzz runs: ${applied} applied (${verifiedHunks} hunks re-checked line by line), ${refused} refused with a known code, no exception, the same answer twice`);
}

fs.rmSync(SCRATCH, { recursive: true, force: true });
console.log(`verify-patch-apply: ${checks} checks passed (${gitRuns} git apply runs)`);
