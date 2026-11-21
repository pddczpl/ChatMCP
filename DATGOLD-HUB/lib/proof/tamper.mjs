// Which changes of a task touched the checks: the test-tamper detector of Proof-of-Done (plan task pod-22, docs/PROOF-TAMPER.md).
//
// A task starts from a baseline tree and ends with a final one. This module lists the changes between the two (a name-status diff
// computed here from the entries of both sides) and classifies those that can change what a check proves:
//   test files (by the usual naming conventions), test configuration, the scripts the checks run (the package.json scripts a criterion
//   reaches, a Makefile a criterion runs, scripts/ folders, files a command names), CI workflows, the acceptance file, lockfiles (hashed),
//   and paths the acceptance file protects;
// then looks inside the changed text with plain heuristics: fewer assertions, new skip or focus markers, a widened numeric tolerance,
// `|| true` / `exit 0` / `continue-on-error` added, deleted test files.
//
// The result says, per acceptance criterion, `checks_modified` and why. The wording is neutral on purpose: a flag means checks were
// modified during the task, not that anyone did something wrong, and the heuristics also flag legitimate changes (docs/PROOF-TAMPER.md).
//
// The sides come from pod-15's code: gitTreeSide reads a commit or tree through the pinned Git of ./git-plumbing.mjs (ls-tree and
// cat-file, the repository's objects read only), workTreeSide lists the workspace the way the tree snapshot engine does
// (./tree-snapshot.mjs, raw-v1: .gitignore'd untracked paths and protected files are left out). memorySide holds files given in memory.
// Nothing here writes to the workspace or the repository, and nothing runs a command of the workspace.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { globMatches } from '../glob-match.mjs';
import { ACCEPTANCE_FILE, AcceptanceError, compareAcceptance, parseAcceptance } from './acceptance.mjs';
import { MODE, blobId, pinnedArgs, pinnedEnv, runGit, splitNul } from './git-plumbing.mjs';
import { LIMITATION, TreeSnapshotter, exclusionOf } from './tree-snapshot.mjs';

export const CHECK_CHANGES_FORMAT = 'chatmcp.check-changes/1';
export const CATEGORY = Object.freeze({
  testFile: 'test_file', testConfig: 'test_config', checkScript: 'check_script', ciWorkflow: 'ci_workflow',
  acceptance: 'acceptance_file', lockfile: 'lockfile', protectedPath: 'acceptance_protected',
});
export const TAMPER_LIMITS = Object.freeze({
  maxFileBytes: 8 * 1024 * 1024, // a file larger than this is not read: not_analyzed (flagged)
  maxReadBytes: 256 * 1024 * 1024, // all the content read for the analysis of one report; what does not fit is not_analyzed (flagged)
  maxFindings: 2_000, // findings listed (flagged first); the rest are only counted
  maxReasonsPerCriterion: 200,
  maxSimilarityPairs: 40_000, // deleted x added pairs compared for a rename with edits
  maxSimilarityBytes: 1024 * 1024,
  detailChars: 200, // a script text quoted in a detail is cut to this length
});
/** What a report does not see or cannot tell; stated in every report, in this order. */
export const LIMITATION_CODES = Object.freeze([LIMITATION.ignoredPaths, 'heuristics-may-flag-legitimate-changes', 'test-selection-unknown', 'protected-files-not-read']);
const LIMITATION_TEXT = {
  [LIMITATION.ignoredPaths]: 'Changes under paths that .gitignore excludes and the repository does not track are not seen.',
  'heuristics-may-flag-legitimate-changes': 'The heuristics also flag legitimate test changes (a refactor that folds assertions into a loop, a new test configuration); a flag means checks were modified, not that the work is wrong.',
  'test-selection-unknown': 'Which tests a command runs is not known, so a change to tests is attributed to every criterion that runs a command.',
  'protected-files-not-read': 'Protected files (secrets and keys) are never read, so changes to them are not seen.',
};

const MESSAGE = {
  test_file_deleted: 'A test file was deleted.',
  test_file_renamed_out: 'A test file was renamed to a name that the test conventions do not match, so test runners may no longer collect it.',
  test_file_type_changed: 'A test file was replaced by a link or a submodule.',
  assertions_removed: 'The test file has fewer assertions than at the start of the task.',
  skip_marker_added: 'A skip or focus marker was added to the test file.',
  tolerance_loosened: 'A numeric tolerance in the test file was widened.',
  test_data_changed: 'A test fixture or expected-output file was changed.',
  test_config_changed: 'The test configuration was changed.',
  check_script_changed: 'A script that the checks run was changed.',
  check_script_added: 'A script that a criterion runs did not exist at the start of the task and was added.',
  check_script_removed: 'A script that a criterion runs was removed.',
  check_script_unreadable: 'A package.json that holds scripts of the checks cannot be read on one side, so its scripts were not compared.',
  failure_masked: 'A change lets a command report success when it fails (`|| true`, `exit 0`, `continue-on-error` and the like).',
  acceptance_edited: 'The acceptance file was edited during the task; the criteria stay those of the start of the task.',
  protected_path_changed: 'A path that the acceptance file lists under `protected` was changed.',
  ci_workflow_deleted: 'A CI workflow was deleted.',
  not_analyzed: 'The file could not be compared (too large, binary, unreadable or beyond the read limit), so it counts as modified.',
  test_file_added: 'A test file was added.',
  test_file_renamed: 'A test file was renamed.',
  test_file_copied: 'A test file was copied.',
  test_file_modified: 'A test file was changed without fewer assertions, new skip markers or a wider tolerance.',
  line_endings_only: 'Only the line endings changed.',
  mode_changed: 'Only the file mode changed.',
  lockfile_changed: 'A lockfile changed; its sha256 before and after are recorded.',
  ci_workflow_changed: 'A CI workflow was changed.',
  ci_workflow_added: 'A CI workflow was added.',
  script_file_added: 'A file was added to a scripts folder.',
};

const fault = (code, message) => Object.assign(new Error(message), { code });
const EMPTY_BLOBS = new Set([blobId(Buffer.alloc(0)), blobId(Buffer.alloc(0), 'sha256')]);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// ---------------------------------------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------------------------------------

const THIRD_PARTY = new Set(['node_modules', 'vendor', 'bower_components', 'jspm_packages', '.git']);
const TEST_FOLDERS = new Set(['test', 'tests', '__tests__', 'spec', 'specs', '__mocks__', '__snapshots__', '__fixtures__', 'testdata', 'e2e']);
const TEST_NAMES = [
  /\.(?:test|spec|e2e|cy)\.[^/]+$/i, // a.test.js, a.spec.ts, login.e2e.ts, page.cy.js
  /_(?:test|spec)s?\.[a-z0-9]+$/i, // calc_test.go, utils_test.py, user_spec.rb
  /^test_[^/]*\.pyw?$/i, // test_calc.py
  /^[A-Za-z0-9_]*Tests?\.(?:java|kt|kts|cs|fs|vb|scala|groovy|swift|php|m)$/, // CalcTest.java, CalcTests.cs (a capital T)
  /\.snap$/i,
];
const TEST_CONFIG_NAMES = [
  /^jest\.(?:config|setup)\.[a-z]+$/, /^vitest\.(?:config|workspace|setup)\.[a-z]+$/, /^\.mocharc(?:\.[a-z]+)?$/, /^karma\.conf\.[a-z]+$/,
  /^playwright\.config\.[a-z]+$/, /^cypress\.config\.[a-z]+$/, /^ava\.config\.[a-z]+$/, /^\.nycrc(?:\.[a-z]+)?$/, /^\.c8rc(?:\.[a-z]+)?$/,
  /^jasmine\.json$/, /^setuptests\.[jt]sx?$/, /^pytest\.ini$/, /^conftest\.py$/, /^tox\.ini$/, /^noxfile\.py$/, /^\.coveragerc$/,
  /^setup\.cfg$/, /^pyproject\.toml$/, /\.(?:cs|fs|vb)proj$/, /\.runsettings$/, /^phpunit\.xml(?:\.dist)?$/, /^\.rspec$/,
];
const LOCKFILES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock', 'deno.lock', 'poetry.lock', 'pipfile.lock',
  'uv.lock', 'pdm.lock', 'cargo.lock', 'go.sum', 'gemfile.lock', 'composer.lock', 'packages.lock.json', 'paket.lock', 'mix.lock', 'pubspec.lock',
  'podfile.lock', 'gradle.lockfile', 'flake.lock', 'conda-lock.yml',
]);
const CI_PATHS = [
  /^\.github\/workflows\/[^/]+\.ya?ml$/, /^\.gitlab-ci\.ya?ml$/, /^azure-pipelines\.ya?ml$/, /^\.azure-pipelines\//, /^\.circleci\//,
  /(?:^|\/)Jenkinsfile$/, /^\.travis\.ya?ml$/, /^bitbucket-pipelines\.ya?ml$/, /^appveyor\.ya?ml$/, /^\.buildkite\//, /^\.drone\.ya?ml$/,
];
const MAKEFILES = new Set(['makefile', 'gnumakefile']);

const posix = path.posix;
const baseName = (file) => file.slice(file.lastIndexOf('/') + 1);
const folderOf = (file) => { const index = file.lastIndexOf('/'); return index < 0 ? '.' : file.slice(0, index); };
const inFolder = (file, folder) => (folder === '.' ? true : file.startsWith(`${folder}/`));

/** Whether the path is a test file by the usual conventions (a test folder, or a test file name); classifyPath leaves third-party folders out first. */
function isTestPath(file) {
  const parts = file.split('/');
  if (parts.slice(0, -1).some((part) => TEST_FOLDERS.has(part.toLowerCase()) || /\.(?:unit|integration|functional)?tests?$/i.test(part))) return true;
  return TEST_NAMES.some((pattern) => pattern.test(parts.at(-1)));
}

/**
 * The category of a path by its name alone, or null: acceptance file, lockfile, CI workflow, test configuration, test file, check script
 * (any package.json, a Makefile, a file in a scripts/ folder at the workspace root or in one of `checkFolders`), in that precedence.
 * package.json, pyproject.toml, setup.cfg and project files are candidates: their content decides (see detectCheckChanges).
 */
export function classifyPath(file, { checkFolders = [] } = {}) {
  const relative = String(file);
  const parts = relative.split('/');
  if (parts.some((part) => THIRD_PARTY.has(part.toLowerCase()))) return null;
  const name = parts.at(-1);
  const lower = name.toLowerCase();
  if (relative === ACCEPTANCE_FILE) return CATEGORY.acceptance;
  if (LOCKFILES.has(lower)) return CATEGORY.lockfile;
  if (CI_PATHS.some((pattern) => pattern.test(relative))) return CATEGORY.ciWorkflow;
  if (TEST_CONFIG_NAMES.some((pattern) => pattern.test(lower))) return CATEGORY.testConfig;
  if (isTestPath(relative)) return CATEGORY.testFile;
  if (lower === 'package.json' || MAKEFILES.has(lower)) return CATEGORY.checkScript;
  if (relative.startsWith('scripts/') || checkFolders.some((folder) => folder !== '.' && relative.startsWith(`${folder}/scripts/`))) return CATEGORY.checkScript;
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Text: comments and strings blanked, assertions, markers, tolerances
// ---------------------------------------------------------------------------------------------------------------------

const C_FAMILY = new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'mts', 'cts', 'go', 'cs', 'java', 'kt', 'kts', 'scala', 'swift', 'rs', 'c', 'cc', 'cpp',
  'cxx', 'h', 'hpp', 'm', 'mm', 'dart', 'php', 'groovy', 'gradle', 'fs', 'fsx']);
const PY_FAMILY = new Set(['py', 'pyi', 'pyw']);
const SHELL_FAMILY = new Set(['sh', 'bash', 'zsh', 'ps1', 'psm1', 'yml', 'yaml', 'toml', 'cfg', 'ini', 'mk']);
const SHELL_CODE = new Set(['sh', 'bash', 'zsh', 'ps1', 'psm1']);

function familyOf(file) {
  const name = baseName(String(file)).toLowerCase();
  if (MAKEFILES.has(name)) return 'shell';
  if (name === 'jenkinsfile') return 'c';
  const dot = name.lastIndexOf('.');
  const ext = dot < 0 ? '' : name.slice(dot + 1);
  if (C_FAMILY.has(ext)) return 'c';
  if (PY_FAMILY.has(ext)) return 'python';
  if (ext === 'rb') return 'ruby';
  if (SHELL_FAMILY.has(ext)) return 'shell';
  return 'none';
}
/** Whether a test file is code the heuristics read (else it is data: fixtures, snapshots, expected output). */
function isCode(file) {
  const family = familyOf(file);
  if (family === 'shell') { const name = baseName(file).toLowerCase(); return SHELL_CODE.has(name.slice(name.lastIndexOf('.') + 1)); }
  return family !== 'none';
}

const blank = (text) => text.replace(/[^\r\n]/g, ' ');

/**
 * The text with the inside of comments and string literals replaced by spaces (delimiters, line breaks and length kept), so that a
 * marker in a comment or a string is not counted. Families by extension: C-like (// and /* *\/, "", '', ``, C# @""), Python (#,
 * triple quotes), Ruby (#, quotes), shell-like (#; strings kept: `run: "npm test || true"` must stay visible). Other files are returned
 * unchanged. An approximation: a regex literal or a Rust lifetime can blank the rest of its line.
 */
export function codeOnly(text, file) {
  const family = familyOf(file);
  const source = String(text);
  if (family === 'none') return source;
  const out = [];
  const n = source.length;
  let i = 0;
  const keepStrings = family === 'shell';
  while (i < n) {
    const c = source[i];
    if (family === 'c' && c === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i); const stop = end < 0 ? n : end;
      out.push(blank(source.slice(i, stop))); i = stop; continue;
    }
    if (family === 'c' && c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2); const stop = end < 0 ? n : end + 2;
      out.push(blank(source.slice(i, stop))); i = stop; continue;
    }
    if (family === 'shell' && c === '<' && source[i + 1] === '#') {
      const end = source.indexOf('#>', i + 2); const stop = end < 0 ? n : end + 2;
      out.push(blank(source.slice(i, stop))); i = stop; continue;
    }
    if (c === '#' && family !== 'c' && (family !== 'shell' || i === 0 || /\s/.test(source[i - 1]))) {
      const end = source.indexOf('\n', i); const stop = end < 0 ? n : end;
      out.push(blank(source.slice(i, stop))); i = stop; continue;
    }
    if (family === 'python' && (source.startsWith('"""', i) || source.startsWith("'''", i))) {
      const quote = source.slice(i, i + 3);
      const end = source.indexOf(quote, i + 3);
      out.push(quote, blank(source.slice(i + 3, end < 0 ? n : end)), end < 0 ? '' : quote); i = end < 0 ? n : end + 3; continue;
    }
    if (c === '"' || c === "'" || (c === '`' && (family === 'c' || family === 'shell'))) {
      const verbatim = family === 'c' && c === '"' && source[i - 1] === '@';
      let k = i + 1;
      while (k < n) {
        const ch = source[k];
        if (ch === '\\' && !verbatim) { k += 2; continue; }
        if (ch === c) { if (verbatim && source[k + 1] === '"') { k += 2; continue; } break; }
        if (ch === '\n' && c !== '`' && !verbatim) break;
        k += 1;
      }
      const closed = k < n && source[k] === c;
      const inner = source.slice(i + 1, Math.min(k, n));
      out.push(c, keepStrings ? inner : blank(inner), closed ? c : '');
      i = closed ? k + 1 : Math.min(k, n);
      continue;
    }
    out.push(c); i += 1;
  }
  return out.join('');
}

const ASSERTIONS = [
  /\bexpect\s*\(/g, // Jest, Vitest, Chai, RSpec
  /\b[Aa]ssert\w*!?\s*\(/g, // assert(, assertEqual(, assertThat(, assert_eq!(
  /\b[Aa]ssert\.\w+\s*\(/g, // assert.equal(, Assert.Equal(, testify assert.Equal(
  /\brequire\.\w+\s*\(/g, // testify require.NoError(
  /\bt\.(?:Error|Errorf|Fatal|Fatalf|Fail|FailNow)\s*\(/g, // Go testing
  /\bt\.(?:is|not|true|false|truthy|falsy|deepEqual|notDeepEqual|like|equal|notEqual|ok|notOk|same|strictSame|match|throws|throwsAsync|rejects|regex|snapshot|assert)\s*\(/g, // AVA, tap
  /\.[Ss]hould\b/g, // Chai should, FluentAssertions
  /\bpytest\.raises\s*\(/g,
  /^[ \t]*assert(?=[ \t])(?![ \t]*\()/gm, // the Python assert statement
];
const SKIP_MARKERS = [
  /(?<![.\w$])(?:it|test|describe|context|suite|specify|bench)\.(?:skip|only|todo)\b/g, // it.skip, test.only, describe.skip, test.todo
  /(?<![.\w$])x(?:it|test|describe|context|specify)\b(?=\s*[('"])/g, // xit(, xdescribe(, RSpec xit "..."
  /(?<![.\w$])f(?:it|describe)\s*\(/g, // Jasmine focus
  /\b(?:this|t)\.(?:skip|todo)\s*\(/g, // Mocha this.skip(), node:test t.skip()
  /\b(?:skip|todo)\s*:\s*(?:true\b|['"`])/g, // node:test { skip: true }, { todo: '...' }
  /(?<![.\w$])(?:skip|pending)\s*(?:\(|['"])/g, // RSpec skip "...", pending "...", from pytest import skip; skip("...")
  /@pytest\.mark\.(?:skip|skipif|xfail)\b/g,
  /\bpytest\.(?:skip|xfail)\s*\(/g,
  /@unittest\.(?:skip|skipIf|skipUnless|expectedFailure)\b/g,
  /@skip(?:If|Unless)\s*\(/g,
  /\bself\.skipTest\s*\(/g,
  /\braise\s+(?:unittest\.)?SkipTest\b/g,
  /\bcollect_ignore(?:_glob)?\b/g, // conftest.py
  /\bt\.Skip(?:f|Now)?\s*\(/g, // Go
  /(?:\[|,)\s*(?:Ignore|Explicit)\s*[\](]/g, // NUnit, MSTest
  /\[\s*(?:Fact|Theory)\s*\(\s*Skip\s*=/g, // xUnit
  /\bAssert\.(?:Ignore|Inconclusive)\s*\(/g,
  /@(?:Disabled|Ignore)\b/g, // JUnit
  /#\[\s*ignore\b/g, // Rust
  /\bmarkTest(?:Skipped|Incomplete)\s*\(/g, // PHPUnit
];
const countAll = (patterns, code) => patterns.reduce((sum, pattern) => sum + (String(code).match(pattern)?.length ?? 0), 0);
/** Assertions in code (codeOnly output): expect(, assert*(, Assert.*(, t.Error/t.Fatal, should, pytest.raises, assert statements. */
export const countAssertions = (code) => countAll(ASSERTIONS, code);
/** Skip and focus markers in code (codeOnly output), in JS/TS, Python, Go, C#, Java, Rust, Ruby and PHP spellings. */
export const countSkipMarkers = (code) => countAll(SKIP_MARKERS, code);

const NUMBER = String.raw`-?(?:\d[\d_]*(?:\.\d[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d+)?[fFdDmM]?(?![\w.])`;
const NAMED_TOLERANCE = new RegExp(String.raw`\b([A-Za-z_]\w*)\s*(?::=|=|:)\s*(${NUMBER})`, 'g');
const TOLERANCE_WORDS = new Set(['rel', 'abs', 'rtol', 'atol', 'tol', 'tolerance', 'epsilon', 'eps', 'delta', 'margin', 'reltol', 'abstol', 'places', 'decimal', 'digits', 'precision']);
const DIGIT_WORDS = new Set(['places', 'decimal', 'digits', 'precision']); // a smaller number is the looser one
const TOLERANCE_CALLS = new RegExp(String.raw`\b(toBeCloseTo|closeTo|approximately|InDelta\w*|InEpsilon\w*|Within|assertAlmostEqual|assertNotAlmostEqual|assert_almost_equal|assert_array_almost_equal)\s*\(`, 'g');
const CALL_RULES = {
  toBeCloseTo: { min: 2, index: 'last', smaller: true }, closeTo: { min: 2, index: 'last' }, approximately: { min: 2, index: 'last' },
  Within: { min: 1, index: 'last' }, assertAlmostEqual: { min: 3, index: 2, smaller: true }, assertNotAlmostEqual: { min: 3, index: 2, smaller: true },
  assert_almost_equal: { min: 3, index: 2, smaller: true }, assert_array_almost_equal: { min: 3, index: 2, smaller: true },
};
const callRule = (name) => CALL_RULES[name] ?? (/^In(?:Delta|Epsilon)/.test(name) ? { min: 3, index: 'last' } : null);
const wordsOf = (identifier) => identifier.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split('_').filter(Boolean);
const numberValue = (text) => Number(text.replace(/_/g, '').replace(/[fFdDmM]$/, ''));

/** The arguments of a call whose "(" is at `open`, split at top-level commas, with their offsets; null when it does not close on the line. */
function callArguments(line, open) {
  const args = [];
  let depth = 0;
  let start = open + 1;
  const stop = Math.min(line.length, open + 500); // a call whose arguments run longer is not a tolerance this reads
  for (let k = open + 1; k < stop; k += 1) {
    const ch = line[k];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) { args.push({ text: line.slice(start, k), offset: start }); return args; }
      depth -= 1;
    } else if (ch === ',' && depth === 0) { args.push({ text: line.slice(start, k), offset: start }); start = k + 1; }
  }
  return null;
}

/** Numeric tolerances on one line of code: [{start, end, text, smaller}] (smaller: a smaller number is looser). */
function tolerancesOf(line) {
  const found = [];
  for (const match of line.matchAll(NAMED_TOLERANCE)) {
    const words = wordsOf(match[1]);
    if (!words.some((word) => TOLERANCE_WORDS.has(word))) continue;
    const start = match.index + match[0].length - match[2].length;
    found.push({ start, end: start + match[2].length, text: match[2], smaller: words.some((word) => DIGIT_WORDS.has(word)) });
  }
  for (const match of line.matchAll(TOLERANCE_CALLS)) {
    const rule = callRule(match[1]);
    const args = rule && callArguments(line, match.index + match[0].length - 1);
    if (!args || args.length < rule.min) continue;
    const arg = args[rule.index === 'last' ? args.length - 1 : rule.index];
    const value = arg && new RegExp(`^\\s*(${NUMBER})\\s*$`).exec(arg.text);
    if (!value) continue;
    const start = arg.offset + arg.text.indexOf(value[1]);
    if (found.some((row) => row.start === start)) continue;
    found.push({ start, end: start + value[1].length, text: value[1], smaller: Boolean(rule.smaller) });
  }
  return found.sort((a, b) => a.start - b.start);
}

/** The first tolerance that the final text widened on a line that is otherwise the same: {before, after, line} or null. */
function widenedTolerance(beforeCode, afterCode) {
  const keyed = (code) => code.split('\n').map((line, index) => {
    const values = tolerancesOf(line);
    if (!values.length) return null;
    let key = '';
    let last = 0;
    for (const value of values) { key += `${line.slice(last, value.start)}\u0000`; last = value.end; }
    key += line.slice(last);
    return { key: key.replace(/\s+/g, ' ').trim(), values, line: index + 1 };
  }).filter(Boolean);
  const pool = new Map();
  for (const row of keyed(beforeCode)) { if (!pool.has(row.key)) pool.set(row.key, []); pool.get(row.key).push(row); }
  for (const row of keyed(afterCode)) {
    const earlier = pool.get(row.key)?.shift();
    if (!earlier) continue;
    for (let index = 0; index < row.values.length; index += 1) {
      const was = numberValue(earlier.values[index].text);
      const now = numberValue(row.values[index].text);
      if (!Number.isFinite(was) || !Number.isFinite(now)) continue;
      if (row.values[index].smaller ? now < was : now > was) return { before: earlier.values[index].text, after: row.values[index].text, line: row.line };
    }
  }
  return null;
}

/** The lines of `after` that `before` does not have (a multiset difference), as [{line, text}]. */
function addedLines(before, after) {
  const counts = new Map();
  for (const line of before.split('\n')) counts.set(line.trimEnd(), (counts.get(line.trimEnd()) ?? 0) + 1);
  const added = [];
  after.split('\n').forEach((line, index) => {
    const key = line.trimEnd();
    const left = counts.get(key) ?? 0;
    if (left > 0) counts.set(key, left - 1); else added.push({ line: index + 1, text: line });
  });
  return added;
}

// Horizontal space only: with the m flag, a `\s*` after `^` would cross line breaks and make a text of blank lines quadratic.
const MASKS = /\|\|[ \t]*(?:true\b|:(?![\w:])|exit[ \t]+0\b|echo\b)|(?:^|[;&][ \t]*)exit[ \t]+0\b|\bset[ \t]+\+e\b|continue-on-error[ \t]*:[ \t]*['"]?true\b|\bif[ \t]*:[ \t]*(?:['"]?false\b|\$\{\{[ \t]*false[ \t]*\}\})|^[ \t]*(?:true|:)[ \t]*$/m;
const masks = (text) => MASKS.test(text);

const decode = (bytes) => { const text = bytes.toString('utf8'); return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; };
const normalized = (bytes) => decode(bytes).replace(/\r\n?/g, '\n');
const isBinary = (bytes) => bytes.subarray(0, 8000).includes(0);

// ---------------------------------------------------------------------------------------------------------------------
// Commands of the criteria
// ---------------------------------------------------------------------------------------------------------------------

/** Splits a command line into simple commands at &&, ||, ;, |, & and line breaks outside quotes. */
function simpleCommands(command) {
  const parts = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i];
    if (quote) { current += c; if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; current += c; continue; }
    if (c === '&' || c === '|' || c === ';' || c === '\n' || c === '\r') { parts.push(current); current = ''; if ((c === '&' || c === '|') && command[i + 1] === c) i += 1; continue; }
    current += c;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}
/** The words of a simple command, quotes removed. */
function shellWords(command) {
  const words = [];
  let current = null;
  let quote = null;
  for (const c of command) {
    if (quote) { if (c === quote) quote = null; else current += c; continue; }
    if (c === '"' || c === "'") { quote = c; current ??= ''; continue; }
    if (/\s/.test(c)) { if (current !== null) words.push(current); current = null; continue; }
    current = (current ?? '') + c;
  }
  if (current !== null) words.push(current);
  return words;
}
const programName = (word) => word.replace(/^.*[\\/]/, '').toLowerCase().replace(/\.(?:cmd|exe|bat|ps1)$/, '');
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** The program and its arguments of a simple command, past `VAR=value` prefixes and cross-env. */
function commandOf(simple) {
  const words = shellWords(simple);
  let i = 0;
  while (i < words.length && ENV_ASSIGNMENT.test(words[i])) i += 1;
  if (words[i] && programName(words[i]) === 'cross-env') { i += 1; while (i < words.length && ENV_ASSIGNMENT.test(words[i])) i += 1; }
  return i < words.length ? { program: programName(words[i]), word: words[i], args: words.slice(i + 1) } : null;
}

const NPM_RUN = new Set(['run', 'run-script', 'rum', 'urn']);
const LIFECYCLE = new Set(['start', 'stop', 'restart']);
const PNPM_YARN_BUILTINS = new Set(['install', 'i', 'add', 'remove', 'rm', 'uninstall', 'ci', 'exec', 'dlx', 'create', 'init', 'publish', 'link', 'unlink',
  'outdated', 'update', 'up', 'upgrade', 'why', 'list', 'ls', 'audit', 'config', 'cache', 'store', 'rebuild', 'prune', 'pack', 'info', 'view',
  'version', 'workspace', 'workspaces', 'import', 'setup', 'patch', 'env', 'bin', 'root', 'global', 'licenses', 'dedupe', 'x', 'node', 'help',
  'login', 'logout', 'set', 'plugin', 'dlx', 'fetch', 'deploy', 'recursive', 'r']);
const VALUE_OPTIONS = new Set(['--prefix', '-C', '--dir', '--cwd', '--loglevel', '--filter', '-F', '-w', '--workspace', '--max-parallel', '--registry']);
const SCOPE_OPTIONS = new Set(['--filter', '-F', '-w', '--workspace', '-r', '--recursive', '--workspaces', '-ws']);

/**
 * The package.json scripts a command runs: [{runner: 'npm'|'pnpm'|'yarn'|'bun'|'npm-run-all', key, prefix}] where prefix is the folder
 * a --prefix / -C / --dir / --cwd option names (relative, as written) or null. `npm test`, `npm run x`, `pnpm x`, `yarn x`, `bun run x`,
 * `run-s a b`, `npm-run-all -p "a:*"` (a pattern key). A workspace-scoped call (-w, --filter, yarn workspace) is not followed.
 */
export function scriptInvocations(command) {
  const found = [];
  for (const simple of simpleCommands(String(command ?? ''))) {
    const parsed = commandOf(simple);
    if (!parsed) continue;
    const { program, args } = parsed;
    if (program === 'run-s' || program === 'run-p' || program === 'npm-run-all') {
      for (let i = 0; i < args.length; i += 1) {
        if (args[i].startsWith('-')) { if (args[i] === '--max-parallel') i += 1; continue; }
        found.push({ runner: 'npm-run-all', key: args[i], prefix: null });
      }
      continue;
    }
    if (!['npm', 'pnpm', 'yarn', 'bun'].includes(program)) continue;
    let prefix = null;
    let scoped = false;
    const rest = [];
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i];
      if (rest.length === 0 && arg.startsWith('-')) {
        const [name, inline] = arg.split(/=(.*)/s);
        if (SCOPE_OPTIONS.has(name)) scoped = true;
        const value = inline ?? (VALUE_OPTIONS.has(name) ? args[++i] : undefined);
        if (['--prefix', '-C', '--dir', '--cwd'].includes(name) && value) prefix = value.replaceAll('\\', '/');
        continue;
      }
      rest.push(arg);
    }
    if (scoped || !rest.length) continue;
    const [sub, ...more] = rest;
    const named = more.find((arg) => !arg.startsWith('-'));
    let key = null;
    if (program === 'npm') {
      if (['test', 't', 'tst'].includes(sub)) key = 'test';
      else if (LIFECYCLE.has(sub)) key = sub;
      else if (NPM_RUN.has(sub)) key = named ?? null;
    } else if (program === 'bun') {
      if (sub === 'run') key = named ?? null;
    } else if (sub === 'test' || sub === 't') key = 'test';
    else if (sub === 'run') key = named ?? null;
    else if (!PNPM_YARN_BUILTINS.has(sub)) key = sub;
    if (key && key !== '--') found.push({ runner: program, key, prefix });
  }
  return found;
}

const MAKE_PROGRAMS = new Set(['make', 'gmake', 'mingw32-make', 'nmake']);
const SCRIPT_EXTENSION = /\.(?:sh|bash|zsh|ps1|psm1|py|js|mjs|cjs|ts|mts|cts|rb|pl|bat|cmd)$/i;

/** Relative workspace paths a simple command names (`bash ci/check.sh`, `node tests/x.mjs`, `--config=jest.ci.js`), resolved from cwd. */
function namedPaths(parsed, cwd) {
  const words = [parsed.word, ...parsed.args];
  const out = [];
  for (const word of words) {
    let token = word.startsWith('-') ? (word.includes('=') ? word.slice(word.indexOf('=') + 1) : '') : word;
    token = token.replaceAll('\\', '/');
    if (!token || token.includes('://') || token.startsWith('$') || (!token.includes('/') && !SCRIPT_EXTENSION.test(token))) continue;
    if (token.startsWith('/') || /^[A-Za-z]:/.test(token) || token.startsWith('~')) continue;
    const joined = posix.normalize(posix.join(cwd === '.' ? '' : cwd, token)).replace(/\/+$/, '');
    if (!joined || joined === '.' || joined.startsWith('../') || joined === '..') continue;
    out.push(joined);
  }
  return out;
}
const MAKE_FOLDER_OPTIONS = /^(?:-C|--directory)(?:=(.*))?$/;
function makeFolder(parsed, cwd) {
  if (!MAKE_PROGRAMS.has(parsed.program)) return null;
  let folder = cwd;
  for (let i = 0; i < parsed.args.length; i += 1) {
    const match = MAKE_FOLDER_OPTIONS.exec(parsed.args[i]);
    if (match) { const value = match[1] ?? parsed.args[i + 1]; if (value) folder = posix.normalize(posix.join(cwd === '.' ? '' : cwd, value.replaceAll('\\', '/'))) || '.'; }
  }
  return folder === '' ? '.' : folder.replace(/\/+$/, '');
}

const packageFile = (folder) => (folder === '.' ? 'package.json' : `${folder}/package.json`);
const keyMatcher = (pattern) => (pattern.includes('*') ? (key) => globMatches(pattern.replace(/\*\*/g, '*'), key) : (key) => key === pattern);

// ---------------------------------------------------------------------------------------------------------------------
// Sides
// ---------------------------------------------------------------------------------------------------------------------

/** Reads paths in order under a per-file limit and a total budget, with `fetch(rows)` reading the rows that fit. */
async function readWithin(rows, { maxBytes = Infinity, budget = Infinity } = {}, fetch) {
  const result = new Map();
  const wanted = [];
  let used = 0;
  for (const row of rows) {
    if (!row.entry || row.size === null) { result.set(row.path, null); continue; }
    if (row.size > maxBytes) { result.set(row.path, { skipped: 'too_large', size: row.size }); continue; }
    if (used + row.size > budget) { result.set(row.path, { skipped: 'read_budget', size: row.size }); continue; }
    used += row.size;
    wanted.push(row);
  }
  const contents = await fetch(wanted);
  for (const row of wanted) result.set(row.path, contents.get(row.path) ?? null);
  return result;
}

/**
 * A side held in memory: `files` maps a relative path to its content (a string or bytes) or to {content, mode?, symlink?}. For tests and
 * for callers that kept the bytes themselves.
 */
export function memorySide(files, { objectFormat = 'sha1' } = {}) {
  const entries = [];
  const bytes = new Map();
  for (const [file, value] of Object.entries(files ?? {})) {
    const spec = typeof value === 'string' || Buffer.isBuffer(value) ? { content: value } : value;
    const content = Buffer.from(spec.content ?? '');
    entries.push({ path: file, mode: spec.symlink ? MODE.symlink : (spec.mode ?? MODE.file), oid: blobId(content, objectFormat), size: content.length });
    bytes.set(file, content);
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  return {
    entries,
    read: (paths, options) => readWithin(paths.map((file) => ({ path: file, entry: byPath.get(file), size: byPath.get(file)?.size ?? null })), options,
      async (rows) => new Map(rows.map((row) => [row.path, bytes.get(row.path)]))),
  };
}

const REVISION = /^[A-Za-z0-9_./~^{}@+-]{1,256}$/;

/**
 * The side of a Git revision (a commit or a tree, `HEAD` included) of the repository at `root`, read through the pinned Git of
 * ./git-plumbing.mjs: no system or global configuration, nothing written, the repository's objects read only. Protected files and
 * `.chatmcp/runs` are left out, as in a tree snapshot. Throws `bad_revision` for an option-like or unknown revision, `git_unavailable`
 * when Git cannot be used on this repository.
 */
export async function gitTreeSide({ root, rev, stateDir, git, env = process.env } = {}) {
  if (!root || !stateDir) throw new TypeError('gitTreeSide needs root and stateDir');
  if (typeof rev !== 'string' || !REVISION.test(rev) || rev.startsWith('-') || rev.includes('..')) throw fault('bad_revision', `not a revision: ${JSON.stringify(rev)}`);
  const snapshotter = new TreeSnapshotter({ root, stateDir, git, env, engine: 'raw-v1' });
  const plan = await snapshotter.plan();
  if (!plan.gitListing) throw fault('git_unavailable', `the revision ${rev} cannot be read: Git cannot be used here (${plan.reason})`);
  await fs.mkdir(stateDir, { recursive: true });
  const emptyConfig = path.join(stateDir, 'empty.gitconfig');
  await fs.writeFile(emptyConfig, '', { flag: 'a' });
  const hooks = path.join(stateDir, 'no-hooks');
  await fs.mkdir(hooks, { recursive: true });
  const pinned = pinnedEnv(env, {
    gitDir: plan.gitDir, workTree: path.resolve(root), indexFile: path.join(stateDir, 'unused.index'), objectDirectory: path.resolve(plan.commonDir, 'objects'), emptyConfig,
  });
  const none = emptyConfig.replaceAll('\\', '/');
  const prefix = [...pinnedArgs(hooks), '-c', `core.excludesFile=${none}`, '-c', `core.attributesFile=${none}`];
  const run = (args, options = {}) => runGit(plan.exe, [...prefix, ...args], { cwd: path.resolve(root), env: pinned, ...options });
  const listed = await run(['ls-tree', '-r', '-z', '-l', '--full-tree', rev]);
  if (listed.code !== 0) throw fault('bad_revision', `the revision ${rev} cannot be read: ${listed.stderr.split('\n').find(Boolean) ?? `git exited ${listed.code}`}`);
  const entries = [];
  for (const line of splitNul(listed.stdout)) {
    const tab = line.indexOf('\t');
    const [mode, , oid, size] = line.slice(0, tab).split(/ +/);
    const file = line.slice(tab + 1);
    if (exclusionOf(file)) continue;
    entries.push({ path: file, mode, oid, size: mode === MODE.gitlink ? null : Number(size) });
  }
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  return {
    entries,
    read: (paths, options) => readWithin(paths.map((file) => ({ path: file, entry: byPath.get(file), size: byPath.get(file)?.size ?? null })), options, async (rows) => {
      const contents = new Map();
      if (!rows.length) return contents;
      const batch = await run(['cat-file', '--batch'], { input: `${rows.map((row) => row.entry.oid).join('\n')}\n` });
      let at = 0;
      for (const row of rows) {
        const newline = batch.stdout.indexOf(0x0a, at);
        if (newline < 0) break;
        const header = batch.stdout.subarray(at, newline).toString('utf8').split(' ');
        at = newline + 1;
        if (header[1] === 'missing' || header.length < 3) { contents.set(row.path, null); continue; }
        const length = Number(header[2]);
        contents.set(row.path, header[1] === 'blob' ? Buffer.from(batch.stdout.subarray(at, at + length)) : null);
        at += length + 1;
      }
      return contents;
    }),
  };
}

/**
 * The side of the workspace as it is now, listed the way the tree snapshot engine lists it (raw-v1 of ./tree-snapshot.mjs: Git's ignore
 * rules for untracked paths when Git can list, protected files and `.chatmcp/runs` left out). Throws `workspace_too_large` beyond the
 * snapshot limits.
 */
export async function workTreeSide({ root, stateDir, git, env = process.env, limits } = {}) {
  if (!root || !stateDir) throw new TypeError('workTreeSide needs root and stateDir');
  const snapshotter = new TreeSnapshotter({ root, stateDir, git, env, engine: 'raw-v1', limits });
  const plan = await snapshotter.plan();
  const pass = await snapshotter.rawPass(plan, null, { full: true });
  if (pass.unbounded) throw fault('workspace_too_large', `the workspace is over the snapshot limit (${pass.unbounded})`);
  const absolute = path.resolve(root);
  const entries = [...pass.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  return {
    entries,
    ignoreRules: pass.ignoreRules,
    read: async (paths, options) => {
      const rows = [];
      for (const file of paths) {
        const entry = byPath.get(file);
        if (!entry || entry.mode === MODE.gitlink) { rows.push({ path: file, entry: null, size: null }); continue; }
        const stat = await fs.lstat(path.join(absolute, file)).catch(() => null);
        const usable = stat && (entry.mode === MODE.symlink ? stat.isSymbolicLink() : stat.isFile());
        rows.push({ path: file, entry: usable ? entry : null, size: usable ? stat.size : null });
      }
      return readWithin(rows, options, async (wanted) => {
        const contents = new Map();
        for (const row of wanted) {
          const target = path.join(absolute, row.path);
          const content = row.entry.mode === MODE.symlink
            ? await fs.readlink(target).then((link) => Buffer.from(link.replaceAll('\\', '/'), 'utf8'), () => null)
            : await fs.readFile(target).catch(() => null);
          contents.set(row.path, content);
        }
        return contents;
      });
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The name-status diff
// ---------------------------------------------------------------------------------------------------------------------

const kindOf = (mode) => (mode === MODE.symlink ? 'symlink' : mode === MODE.gitlink ? 'gitlink' : 'file');
const byPathOrder = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/**
 * The name-status diff of two entry lists [{path, mode, oid}], as Git would name it with exact rename and copy detection:
 * rows {status: 'A'|'D'|'M'|'T'|'R'|'C', path, oldPath, oldMode, newMode, oldOid, newOid, similarity?} sorted by path (a D row carries
 * the deleted path). R: a deleted and an added entry with the same blob; C: an added entry with the blob of an entry the baseline has;
 * T: a file became a link or a submodule (or back); a mode change alone is an M with the same blob. Empty files are never paired.
 */
export function nameStatus(before, after) {
  const was = new Map(before.map((entry) => [entry.path, entry]));
  const now = new Map(after.map((entry) => [entry.path, entry]));
  const rows = [];
  const deleted = [];
  for (const [file, entry] of was) {
    const next = now.get(file);
    if (!next) { deleted.push(entry); continue; }
    if (next.oid === entry.oid && next.mode === entry.mode) continue;
    rows.push({ status: kindOf(entry.mode) === kindOf(next.mode) ? 'M' : 'T', path: file, oldPath: null, oldMode: entry.mode, newMode: next.mode, oldOid: entry.oid, newOid: next.oid });
  }
  const added = [...now.values()].filter((entry) => !was.has(entry.path)).sort(byPathOrder);
  const pairable = (entry) => !EMPTY_BLOBS.has(entry.oid) && kindOf(entry.mode) !== 'gitlink';
  const keyOf = (entry) => `${kindOf(entry.mode)}:${entry.oid}`;
  const sources = new Map();
  for (const entry of [...was.values()].sort(byPathOrder)) if (pairable(entry) && !sources.has(keyOf(entry))) sources.set(keyOf(entry), entry);
  const renameFrom = new Map();
  for (const entry of deleted.sort(byPathOrder)) if (pairable(entry)) { const key = keyOf(entry); if (!renameFrom.has(key)) renameFrom.set(key, []); renameFrom.get(key).push(entry); }
  const renamed = new Set();
  for (const entry of added) {
    const pair = pairable(entry) ? renameFrom.get(keyOf(entry))?.shift() : undefined;
    const source = pair ?? (pairable(entry) ? sources.get(keyOf(entry)) : undefined);
    if (pair) renamed.add(pair.path);
    if (source) rows.push({ status: pair ? 'R' : 'C', path: entry.path, oldPath: source.path, oldMode: source.mode, newMode: entry.mode, oldOid: source.oid, newOid: entry.oid, similarity: 100 });
    else rows.push({ status: 'A', path: entry.path, oldPath: null, oldMode: null, newMode: entry.mode, oldOid: null, newOid: entry.oid });
  }
  for (const entry of deleted) if (!renamed.has(entry.path)) rows.push({ status: 'D', path: entry.path, oldPath: null, oldMode: entry.mode, newMode: null, oldOid: entry.oid, newOid: null });
  return rows.sort(byPathOrder);
}

/** Line similarity of two texts in percent (Dice over the multisets of trimmed, non-empty lines). */
function similarity(a, b) {
  const lines = (text) => text.split('\n').map((line) => line.trim()).filter(Boolean);
  const left = lines(a);
  const right = lines(b);
  if (!left.length && !right.length) return 100;
  const counts = new Map();
  for (const line of left) counts.set(line, (counts.get(line) ?? 0) + 1);
  let common = 0;
  for (const line of right) { const n = counts.get(line) ?? 0; if (n > 0) { common += 1; counts.set(line, n - 1); } }
  return Math.floor((200 * common) / (left.length + right.length));
}

// ---------------------------------------------------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------------------------------------------------

const clip = (text, limit) => (typeof text === 'string' && text.length > limit ? `${text.slice(0, limit)}...` : text);
const parseJson = (bytes) => {
  if (!Buffer.isBuffer(bytes)) return { absent: true, value: null };
  try { const value = JSON.parse(decode(bytes)); return { value: value && typeof value === 'object' && !Array.isArray(value) ? value : {} }; } catch { return { invalid: true, value: null }; }
};
const TEST_CONFIG_KEYS = ['jest', 'mocha', 'ava', 'c8', 'nyc', 'vitest'];
const PYPROJECT_SECTION = /^\s*\[\s*tool\.(?:pytest|tox|coverage|nox|hatch\.envs)\b/;
const SETUP_CFG_SECTION = /^\s*\[\s*(?:tool:pytest|pytest|coverage:|tox)/;
const TEST_PROJECT = /Microsoft\.NET\.Test\.Sdk|<IsTestProject>\s*true|\b(?:xunit|nunit|MSTest)\b/i;

/** The text of the sections a header pattern selects (INI and TOML), for a comparison that ignores the rest of the file. */
function sectionsText(text, header) {
  let inside = false;
  const kept = [];
  for (const line of text.split('\n')) {
    if (/^\s*\[/.test(line)) inside = header.test(line);
    if (inside) kept.push(line.trimEnd());
  }
  return kept.join('\n');
}

/** Normalises the criteria (from parseAcceptance or the caller) to what the detector needs. */
function readCriteria(acceptance) {
  if (acceptance === null || acceptance === undefined) return { criteria: [], protected: [] };
  if (typeof acceptance !== 'object' || !Array.isArray(acceptance.criteria)) throw new TypeError('acceptance must be {criteria: [...]} (parseAcceptance) or null');
  const criteria = acceptance.criteria.map((criterion) => {
    if (!criterion || typeof criterion.id !== 'string') throw new TypeError('every criterion needs an id');
    const checks = Array.isArray(criterion.checks) ? criterion.checks.filter((check) => check && typeof check.run === 'string') : [];
    return { id: criterion.id, checks: checks.map((check) => ({ run: check.run, cwd: typeof check.cwd === 'string' && check.cwd ? check.cwd.replaceAll('\\', '/') : '.' })) };
  });
  return { criteria, protected: Array.isArray(acceptance.protected) ? acceptance.protected.filter((glob) => typeof glob === 'string') : [] };
}

class Reader {
  constructor(sides, limits) { this.sides = sides; this.limits = limits; this.cache = { baseline: new Map(), final: new Map() }; this.used = 0; }
  /** Reads what is not read yet; `budgeted` reads count against maxReadBytes. */
  async load(side, paths, { budgeted = true } = {}) {
    const known = this.cache[side];
    const todo = [...new Set(paths)].filter((file) => !known.has(file));
    if (!todo.length) return;
    const got = await this.sides[side].read(todo, { maxBytes: this.limits.maxFileBytes, budget: budgeted ? Math.max(0, this.limits.maxReadBytes - this.used) : Infinity });
    for (const file of todo) {
      let value = got?.get(file) ?? null;
      if (typeof value === 'string') value = Buffer.from(value);
      if (Buffer.isBuffer(value) && budgeted) this.used += value.length;
      known.set(file, value);
    }
  }
  get(side, file) { return this.cache[side].get(file); }
}

const isBytes = (value) => Buffer.isBuffer(value);
const skippedWhy = (value) => (value && !isBytes(value) && value.skipped) || 'unreadable';

/**
 * Compares the baseline and the final side of a task and reports which changes touched the checks.
 *
 * @param {object} options
 * @param {object} options.baseline  a side (gitTreeSide, workTreeSide, memorySide): {entries: [{path, mode, oid}], read(paths, {maxBytes, budget})}
 * @param {object} options.final     the side at the end of the task
 * @param {object|null} [options.acceptance]  {criteria, protected} (parseAcceptance of the BASELINE file); when left out, the baseline's
 *                                   .chatmcp/acceptance.yml is read; null means no criteria
 * @param {Partial<typeof TAMPER_LIMITS>} [options.limits]
 * @returns {Promise<object>} {format, checks_modified, summary, criteria: [{id, checks_modified, reasons}], findings, lockfiles, counts,
 *   limitations} - see docs/PROOF-TAMPER.md
 */
export async function detectCheckChanges({ baseline, final, acceptance, limits = {} } = {}) {
  for (const [name, side] of [['baseline', baseline], ['final', final]]) {
    if (!side || !Array.isArray(side.entries) || typeof side.read !== 'function') throw new TypeError(`detectCheckChanges needs the ${name} side ({entries, read})`);
  }
  const L = { ...TAMPER_LIMITS, ...limits };
  const reader = new Reader({ baseline, final }, L);
  const before = new Map(baseline.entries.map((entry) => [entry.path, entry]));
  const after = new Map(final.entries.map((entry) => [entry.path, entry]));
  const rows = nameStatus(baseline.entries, final.entries);

  // ---- the criteria: given, or the baseline's acceptance file (never the final one)
  await reader.load('baseline', [ACCEPTANCE_FILE], { budgeted: false });
  await reader.load('final', [ACCEPTANCE_FILE], { budgeted: false });
  let given = acceptance;
  if (given === undefined) {
    const bytes = reader.get('baseline', ACCEPTANCE_FILE);
    given = null;
    if (isBytes(bytes)) {
      try { given = parseAcceptance(bytes); } catch (error) { if (!(error instanceof AcceptanceError)) throw error; }
    }
  }
  const { criteria, protected: protectedGlobs } = readCriteria(given);

  // ---- what each criterion runs: package.json scripts (with what they reach), Makefiles, named files
  const uses = criteria.map((criterion) => ({ id: criterion.id, checks: criterion.checks.length > 0, packages: new Map(), make: new Set(), paths: new Set() }));
  if (!criteria.length) uses.push({ id: null, checks: true, packages: new Map([['package.json', ['test']]]), make: new Set(['.']), paths: new Set(), fallback: true });
  const exists = (file) => before.has(file) || after.has(file);
  const addKey = (use, pkg, key) => { if (!use.packages.has(pkg)) use.packages.set(pkg, []); if (!use.packages.get(pkg).includes(key)) use.packages.get(pkg).push(key); };
  const scan = (use, command, cwd) => {
    for (const simple of simpleCommands(command)) {
      const parsed = commandOf(simple);
      if (!parsed) continue;
      for (const call of scriptInvocations(simple)) {
        const folder = posix.normalize(posix.join(cwd === '.' ? '' : cwd, call.prefix ?? '')).replace(/\/+$/, '') || '.';
        addKey(use, packageFile(folder === '' ? '.' : folder), call.key);
      }
      const make = makeFolder(parsed, cwd);
      if (make) use.make.add(make);
      for (const file of namedPaths(parsed, cwd)) if (exists(file)) use.paths.add(file);
    }
  };
  criteria.forEach((criterion, index) => { for (const check of criterion.checks) scan(uses[index], check.run, check.cwd); });
  const usedPackages = [...new Set(uses.flatMap((use) => [...use.packages.keys()]))];
  await reader.load('baseline', usedPackages, { budgeted: false });
  await reader.load('final', usedPackages, { budgeted: false });
  const packageScripts = new Map();
  for (const pkg of usedPackages) {
    const sides = [parseJson(reader.get('baseline', pkg)), parseJson(reader.get('final', pkg))];
    const union = {};
    for (const side of sides) for (const [key, value] of Object.entries(side.value?.scripts ?? {})) if (typeof value === 'string') union[key] = [...(union[key] ?? []), value];
    packageScripts.set(pkg, union);
  }
  // the closure: pre/post scripts, scripts a script runs (`npm run x`, run-s), Makefiles and files a script names
  for (const use of uses) {
    for (const pkg of [...use.packages.keys()]) {
      const scripts = packageScripts.get(pkg) ?? {};
      const folder = folderOf(pkg);
      const list = use.packages.get(pkg);
      // npm runs pre<key> and post<key> around a script it is asked to run (not around those two themselves)
      const queue = list.map((key) => ({ key, hooks: true }));
      const reach = (key, hooks) => { if (!list.includes(key)) { list.push(key); queue.push({ key, hooks }); } };
      for (let index = 0; index < queue.length && list.length < 500; index += 1) {
        const { key: pattern, hooks } = queue[index];
        const keys = pattern.includes('*') ? Object.keys(scripts).filter(keyMatcher(pattern)) : [pattern];
        for (const key of keys) {
          reach(key, true);
          if (hooks) { reach(`pre${key}`, false); reach(`post${key}`, false); }
          for (const body of scripts[key] ?? []) {
            for (const simple of simpleCommands(body)) {
              const parsed = commandOf(simple);
              if (!parsed) continue;
              for (const call of scriptInvocations(simple)) if (!call.prefix) reach(call.key, true);
              const make = makeFolder(parsed, folder);
              if (make) use.make.add(make);
              for (const file of namedPaths(parsed, folder)) if (exists(file)) use.paths.add(file);
            }
          }
        }
      }
    }
  }
  const checkFolders = [...new Set(criteria.flatMap((criterion) => criterion.checks.map((check) => check.cwd)))];
  const withChecks = (use) => use.checks;

  // ---- classify every change
  const categoryOf = (file) => {
    if (!file) return null;
    const category = classifyPath(file, { checkFolders });
    if (category) return category;
    if (uses.some((use) => use.paths.has(file))) return CATEGORY.checkScript;
    if (protectedGlobs.some((glob) => globMatches(glob, file, { path: true }))) return CATEGORY.protectedPath;
    return null;
  };
  const changes = rows.map((row) => ({ ...row, category: categoryOf(row.path), oldCategory: row.oldPath ? categoryOf(row.oldPath) : null }));
  const lockfilePaths = [...new Set([...before.keys(), ...after.keys()].filter((file) => classifyPath(file) === CATEGORY.lockfile))].sort();

  // ---- read what the analysis needs (in path order, within the budget), then pair renames that carry edits
  const relevant = (change) => change.category || change.oldCategory;
  const needBefore = [];
  const needAfter = [];
  for (const change of changes) {
    if (!relevant(change)) continue;
    if (change.status !== 'A') needBefore.push(change.oldPath ?? change.path);
    if (change.status !== 'D') needAfter.push(change.path);
  }
  for (const file of lockfilePaths) {
    const unchanged = before.get(file)?.oid === after.get(file)?.oid && before.has(file) && after.has(file);
    if (before.has(file) && !unchanged) needBefore.push(file);
    if (after.has(file)) needAfter.push(file);
  }
  await reader.load('baseline', needBefore.sort());
  await reader.load('final', needAfter.sort());

  const deletedRows = changes.filter((change) => change.status === 'D' && change.category);
  const addedRows = changes.filter((change) => change.status === 'A' && change.category);
  if (deletedRows.length && addedRows.length && deletedRows.length * addedRows.length <= L.maxSimilarityPairs) {
    const text = (side, file) => { const value = reader.get(side, file); return isBytes(value) && value.length <= L.maxSimilarityBytes && !isBinary(value) ? normalized(value) : null; };
    const pairs = [];
    for (const gone of deletedRows) {
      const was = text('baseline', gone.path);
      if (was === null) continue;
      for (const come of addedRows) {
        const now = text('final', come.path);
        if (now === null) continue;
        const score = was === now ? 100 : similarity(was, now);
        if (score >= 50) pairs.push({ gone, come, score });
      }
    }
    pairs.sort((a, b) => b.score - a.score || byPathOrder(a.come, b.come) || byPathOrder(a.gone, b.gone));
    const taken = new Set();
    for (const { gone, come, score } of pairs) {
      if (taken.has(gone) || taken.has(come)) continue;
      taken.add(gone); taken.add(come);
      Object.assign(come, { status: 'R', oldPath: gone.path, oldMode: gone.oldMode, oldOid: gone.oldOid, oldCategory: gone.category, similarity: score });
    }
    for (let index = changes.length - 1; index >= 0; index -= 1) if (taken.has(changes[index]) && changes[index].status === 'D') changes.splice(index, 1);
  }

  // ---- analyse each classified change
  const findings = [];
  const every = { kind: 'every' };
  const nobody = { kind: 'none' };
  const only = (ids) => ({ kind: 'ids', ids: new Set(ids) });
  const usersOf = (predicate) => uses.filter(predicate).map((use) => use.id).filter((id) => id !== null);
  for (const change of changes) {
    if (!relevant(change)) continue;
    const reasons = [];
    const add = (code, flagged, { detail, line, targets = every, via = 'every_check' } = {}) => {
      reasons.push({ code, flagged, message: MESSAGE[code], ...(detail !== undefined ? { detail } : {}), ...(line !== undefined ? { line } : {}), targets, via });
    };
    const oldFile = change.oldPath ?? change.path;
    const was = change.status === 'A' ? undefined : reader.get('baseline', oldFile);
    const now = change.status === 'D' ? undefined : reader.get('final', change.path);
    const sameBlob = change.oldOid !== null && change.oldOid === change.newOid;
    const modeOnly = change.status === 'M' && sameBlob;
    const unreadable = (value) => value !== undefined && !isBytes(value);
    const notAnalyzed = (why, targets, via) => add('not_analyzed', true, { detail: { why }, targets, via });
    /** Common prelude of a content comparison: true when the caller should stop (an outcome was recorded or nothing changed). */
    const settled = (targets, via) => {
      if (modeOnly) { add('mode_changed', false, { targets, via }); return true; }
      if (unreadable(was) || unreadable(now)) { notAnalyzed(unreadable(was) ? skippedWhy(was) : skippedWhy(now), targets, via); return true; }
      if (isBytes(was) && isBytes(now) && !isBinary(was) && !isBinary(now) && normalized(was) === normalized(now) && !sameBlob) {
        add('line_endings_only', false, { targets, via }); return true;
      }
      return false;
    };
    const category = change.category ?? change.oldCategory;

    if (category === CATEGORY.acceptance) {
      if (change.path === ACCEPTANCE_FILE || change.oldPath === ACCEPTANCE_FILE) {
        const beforeBytes = reader.get('baseline', ACCEPTANCE_FILE);
        const afterBytes = reader.get('final', ACCEPTANCE_FILE);
        let edit = null;
        let detail;
        try {
          edit = compareAcceptance(isBytes(beforeBytes) ? beforeBytes : null, isBytes(afterBytes) ? afterBytes : null);
          if (edit) detail = { removed: edit.removed, added: edit.added, changed: edit.changed, sections: edit.sections, deleted: edit.deleted, unparseable: edit.unparseable };
        } catch (error) {
          if (!(error instanceof AcceptanceError)) throw error;
          edit = { all: true };
          detail = { baselineUnreadable: true };
        }
        if (edit) {
          const all = edit.all || edit.deleted || edit.unparseable || edit.sections.includes('reproduce') || edit.sections.includes('protected');
          add('acceptance_edited', true, { detail, targets: all ? { kind: 'all' } : only([...edit.removed, ...edit.changed]), via: 'acceptance' });
        }
      }
    } else if (category === CATEGORY.lockfile) {
      const hash = (value) => (isBytes(value) ? sha256(value) : null);
      add('lockfile_changed', false, { detail: { sha256Before: hash(was), sha256After: hash(now) }, targets: nobody, via: 'lockfile' });
    } else if (category === CATEGORY.ciWorkflow) {
      if (change.status === 'D' || (change.status === 'R' && change.category !== CATEGORY.ciWorkflow)) add('ci_workflow_deleted', true, { targets: nobody, via: 'ci' });
      else if (!settled(nobody, 'ci')) {
        const beforeText = isBytes(was) ? codeOnly(normalized(was), oldFile) : '';
        const afterText = codeOnly(normalized(now), change.path);
        const masked = addedLines(beforeText, afterText).find((row) => masks(row.text));
        if (masked) add('failure_masked', true, { line: masked.line, targets: nobody, via: 'ci' });
        else add(change.status === 'A' ? 'ci_workflow_added' : 'ci_workflow_changed', false, { targets: nobody, via: 'ci' });
      }
    } else if (category === CATEGORY.testConfig) {
      const name = baseName(change.path).toLowerCase();
      const oldName = baseName(oldFile).toLowerCase();
      const textOf = (value) => (isBytes(value) ? normalized(value) : '');
      let relevantPart = null;
      if (name === 'pyproject.toml' || oldName === 'pyproject.toml') relevantPart = PYPROJECT_SECTION;
      else if (name === 'setup.cfg' || oldName === 'setup.cfg') relevantPart = SETUP_CFG_SECTION;
      if (unreadable(was) || unreadable(now)) notAnalyzed(unreadable(was) ? skippedWhy(was) : skippedWhy(now), every, 'every_check');
      else if (relevantPart) {
        if (sectionsText(textOf(was), relevantPart) !== sectionsText(textOf(now), relevantPart)) add('test_config_changed', true);
      } else if (/\.(?:cs|fs|vb)proj$/.test(name)) {
        if ((TEST_PROJECT.test(textOf(was)) || TEST_PROJECT.test(textOf(now))) && textOf(was) !== textOf(now)) add('test_config_changed', true);
        else if (modeOnly && (TEST_PROJECT.test(textOf(now)))) add('mode_changed', false);
      } else if (!settled(every, 'every_check')) add('test_config_changed', true);
    } else if (category === CATEGORY.testFile) {
      const nowTest = change.status === 'D' ? false : change.category === CATEGORY.testFile;
      if (change.status === 'D') add('test_file_deleted', true);
      else if (change.status === 'R' && !nowTest) add('test_file_renamed_out', true);
      else if (change.status === 'T') add('test_file_type_changed', true);
      else {
        if (change.status === 'R') add('test_file_renamed', false);
        if (change.status === 'C') add('test_file_copied', false);
        if (change.status === 'A') {
          if (unreadable(now)) notAnalyzed(skippedWhy(now));
          else {
            add('test_file_added', false);
            if (isCode(change.path) && !isBinary(now)) {
              const code = codeOnly(normalized(now), change.path);
              const skips = countSkipMarkers(code);
              if (skips > 0) add('skip_marker_added', true, { detail: { before: 0, after: skips }, line: firstMarkerLine(code) });
            }
          }
        } else if (!sameBlob || modeOnly) {
          if (!settled(every, 'every_check')) {
            const binary = isBinary(was) || isBinary(now);
            if (!isCode(change.path) || !isCode(oldFile)) add('test_data_changed', true, { detail: { binary } });
            else if (binary) notAnalyzed('binary');
            else {
              const beforeCode = codeOnly(normalized(was), oldFile);
              const afterCode = codeOnly(normalized(now), change.path);
              const flaggedBefore = reasons.length;
              const assertions = [countAssertions(beforeCode), countAssertions(afterCode)];
              if (assertions[1] < assertions[0]) add('assertions_removed', true, { detail: { before: assertions[0], after: assertions[1] } });
              const skips = [countSkipMarkers(beforeCode), countSkipMarkers(afterCode)];
              if (skips[1] > skips[0]) {
                const added = addedLines(beforeCode, afterCode).find((row) => countSkipMarkers(row.text) > 0);
                add('skip_marker_added', true, { detail: { before: skips[0], after: skips[1] }, ...(added ? { line: added.line } : {}) });
              }
              const widened = widenedTolerance(beforeCode, afterCode);
              if (widened) add('tolerance_loosened', true, { detail: { before: widened.before, after: widened.after }, line: widened.line });
              if (reasons.length === flaggedBefore && change.status === 'M') add('test_file_modified', false);
            }
          }
        }
      }
    } else if (category === CATEGORY.checkScript || category === CATEGORY.protectedPath) {
      const name = baseName(change.path).toLowerCase();
      if (category === CATEGORY.checkScript && name === 'package.json' && baseName(oldFile).toLowerCase() === 'package.json') {
        analysePackage(change.path, was, now, add, { uses, L, only, every });
      } else if (category === CATEGORY.checkScript && MAKEFILES.has(name)) {
        const users = usersOf((use) => use.make.has(folderOf(change.path)));
        const used = uses.some((use) => use.make.has(folderOf(change.path)));
        if (used) scriptChange(change, was, now, add, settled, only(users), 'make');
      } else if (category === CATEGORY.checkScript) {
        const named = uses.filter((use) => use.paths.has(change.path) || use.paths.has(oldFile));
        if (named.length) scriptChange(change, was, now, add, settled, only(named.map((use) => use.id).filter((id) => id !== null)), 'command_path');
        else if (change.status === 'A') add('script_file_added', false);
        else scriptChange(change, was, now, add, settled, every, 'every_check');
      }
    }
    // a path the acceptance file protects: any change, whatever else it is (the acceptance file itself has its own reason)
    if (category !== CATEGORY.acceptance && protectedGlobs.some((glob) => globMatches(glob, change.path, { path: true }) || (change.oldPath && globMatches(glob, change.oldPath, { path: true })))) {
      add('protected_path_changed', true, { targets: { kind: 'all' }, via: 'acceptance_protected' });
    }
    if (!reasons.length) continue;
    findings.push({
      path: change.path, oldPath: change.oldPath ?? null, status: change.status, category, flagged: reasons.some((reason) => reason.flagged), reasons,
      ...(modeOnly ? { modeOnly: true } : {}), ...(change.similarity !== undefined && change.status === 'R' ? { similarity: change.similarity } : {}),
    });
  }

  // ---- per criterion
  const criteriaRows = criteria.map((criterion, index) => {
    const use = uses[index];
    const reasons = [];
    for (const row of findings) {
      for (const reason of row.reasons) {
        if (!reason.flagged) continue;
        const { kind, ids } = reason.targets;
        const applies = kind === 'all' || (kind === 'every' && withChecks(use)) || (kind === 'ids' && ids.has(criterion.id));
        if (applies) reasons.push({ code: reason.code, path: row.path, ...(row.oldPath ? { oldPath: row.oldPath } : {}), message: reason.message, ...(reason.detail !== undefined ? { detail: reason.detail } : {}), ...(reason.line !== undefined ? { line: reason.line } : {}), via: reason.via });
      }
    }
    const kept = reasons.slice(0, L.maxReasonsPerCriterion);
    return { id: criterion.id, checks_modified: reasons.length > 0, reasons: kept, ...(reasons.length > kept.length ? { omittedReasons: reasons.length - kept.length } : {}) };
  });

  // ---- lockfiles, hashed
  const lockfiles = lockfilePaths.map((file) => {
    const hash = (side) => { const value = reader.get(side, file); return isBytes(value) ? sha256(value) : null; };
    const has = [before.has(file), after.has(file)];
    const unchanged = has[0] && has[1] && before.get(file).oid === after.get(file).oid && before.get(file).mode === after.get(file).mode;
    const afterHash = has[1] ? hash('final') : null;
    return { path: file, status: unchanged ? 'unchanged' : !has[0] ? 'added' : !has[1] ? 'deleted' : 'modified', sha256Before: unchanged ? afterHash : has[0] ? hash('baseline') : null, sha256After: afterHash };
  });

  const strip = (row) => ({ ...row, reasons: row.reasons.map(({ targets, via, ...rest }) => rest) });
  const ordered = [...findings].sort((a, b) => Number(b.flagged) - Number(a.flagged) || byPathOrder(a, b));
  const flaggedCount = findings.filter((row) => row.flagged).length;
  const checksModified = flaggedCount > 0;
  return {
    format: CHECK_CHANGES_FORMAT,
    checks_modified: checksModified,
    summary: checksModified
      ? `Checks were modified during the task: ${flaggedCount} ${flaggedCount === 1 ? 'change' : 'changes'} to tests, test configuration, check scripts or the acceptance file.`
      : 'No modification of checks was found.',
    criteria: criteriaRows,
    findings: ordered.slice(0, L.maxFindings).map(strip),
    lockfiles,
    counts: {
      changes: changes.length,
      findings: findings.length,
      flagged: flaggedCount,
      notAnalyzed: findings.filter((row) => row.reasons.some((reason) => reason.code === 'not_analyzed')).length,
      omittedFindings: Math.max(0, findings.length - L.maxFindings),
    },
    limitations: LIMITATION_CODES.map((code) => ({ code, text: LIMITATION_TEXT[code] })),
  };
}

/** The line of the first skip marker in code (1-based). */
function firstMarkerLine(code) {
  const lines = code.split('\n');
  const index = lines.findIndex((line) => countSkipMarkers(line) > 0);
  return index < 0 ? undefined : index + 1;
}

/** A changed script file (Makefile, scripts/, a file a criterion names): changed, plus failure_masked when an added line masks a failure. */
function scriptChange(change, was, now, add, settled, targets, via) {
  if (change.status === 'D') { add('check_script_changed', true, { targets, via }); return; }
  if (settled(targets, via)) return;
  add('check_script_changed', true, { targets, via });
  if (!Buffer.isBuffer(now) || isBinary(now)) return;
  const beforeText = Buffer.isBuffer(was) && !isBinary(was) ? codeOnly(normalized(was), change.oldPath ?? change.path) : '';
  const masked = addedLines(beforeText, codeOnly(normalized(now), change.path)).find((row) => masks(row.text));
  if (masked) add('failure_masked', true, { line: masked.line, targets, via });
}

/** package.json: the scripts the criteria reach (JSON values compared) and the test-runner keys. */
function analysePackage(file, was, now, add, { uses, L, only, every }) {
  const users = uses.filter((use) => use.packages.has(file));
  const keys = [];
  for (const use of users) for (const key of use.packages.get(file)) if (!keys.includes(key)) keys.push(key);
  const idsFor = (key) => users.filter((use) => use.packages.get(file).includes(key)).map((use) => use.id).filter((id) => id !== null);
  const left = parseJson(was);
  const right = parseJson(now);
  if (left.invalid || right.invalid) {
    const readable = left.invalid ? right.value : left.value;
    if (keys.length) add('check_script_unreadable', true, { detail: { package: file }, targets: only(users.map((use) => use.id).filter((id) => id !== null)), via: 'script' });
    else if (readable && TEST_CONFIG_KEYS.some((key) => readable[key] !== undefined)) add('check_script_unreadable', true, { detail: { package: file }, targets: every, via: 'every_check' });
    return;
  }
  const scripts = (side) => (side.value?.scripts && typeof side.value.scripts === 'object' ? side.value.scripts : {});
  const [beforeScripts, afterScripts] = [scripts(left), scripts(right)];
  for (const key of keys) {
    const b = typeof beforeScripts[key] === 'string' ? beforeScripts[key] : undefined;
    const a = typeof afterScripts[key] === 'string' ? afterScripts[key] : undefined;
    if (b === a) continue;
    const detail = { package: file, key, before: b === undefined ? null : clip(b, L.detailChars), after: a === undefined ? null : clip(a, L.detailChars) };
    const targets = only(idsFor(key));
    add(a === undefined ? 'check_script_removed' : b === undefined ? 'check_script_added' : 'check_script_changed', true, { detail, targets, via: 'script' });
    if (a !== undefined && masks(a) && !(b !== undefined && masks(b))) add('failure_masked', true, { detail: { package: file, key }, targets, via: 'script' });
  }
  for (const key of TEST_CONFIG_KEYS) {
    if (JSON.stringify(left.value?.[key]) !== JSON.stringify(right.value?.[key])) add('test_config_changed', true, { detail: { package: file, key } });
  }
}
