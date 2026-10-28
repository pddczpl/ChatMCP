// Tests for the mutation-testing tool (tests/mutation/run-mutations.mjs).
//
// The tool is how this project shows that its suites can fail, so it has to be right in both directions: a mutation the suite notices
// must be KILLED, one it does not notice must be SURVIVED (never silently dropped), a pattern that does not apply must be an ERROR
// (never "killed because nothing happened"), a suite that cannot run must not be judged, and the real tree must never change.
// Everything runs against a tiny fake Hub in a temporary folder, selected with --hub-root.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };

const TOOL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'mutation', 'run-mutations.mjs');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-mutation-test-'));
const fake = path.join(root, 'fake-hub');

const FILES = {
  'lib/value.mjs': "export const value = 1;\nexport const label = 'one';\nexport function guard(x) {\n  if (x > 5) throw new Error('too big');\n  return x;\n}\n",
  // Fails like the real suites do: a "not ok" line per failed check and a non-zero exit.
  'tests/verify-fake.mjs': [
    "import { guard, value } from '../lib/value.mjs';",
    'const problems = [];',
    "if (value !== 1) problems.push('value is 1');",
    "try { guard(6); problems.push('guard refuses 6'); } catch { /* expected */ }",
    "for (const problem of problems) console.log('  not ok - ' + problem);",
    "if (problems.length) { console.log('FAIL: ' + problems.length + ' of 2 checks failed'); process.exit(1); }",
    "console.log('PASS: 2 checks');",
  ].join('\n') + '\n',
  'tests/verify-skippy.mjs': "console.log('CHATMCP_TEST_SKIP: the tool it needs is not installed');\n",
  'tests/verify-broken.mjs': "console.log('  not ok - this suite always fails');\nprocess.exit(1);\n",
  'tests/verify-condskip.mjs': "import { value } from '../lib/value.mjs';\nif (value === 3) { console.log('CHATMCP_TEST_SKIP: cannot judge this value'); process.exit(0); }\nif (value !== 1) { console.log('  not ok - value is 1'); process.exit(1); }\nconsole.log('PASS');\n",
  'tests/verify-hang.mjs': "import { value } from '../lib/value.mjs';\nif (value === 99) setInterval(() => {}, 1000); else console.log('PASS');\n",
};
// lib/value.mjs is written with CRLF, as Git does on Windows: the patterns (written with \n) must still match, and the line endings must survive.
const onDisk = (name) => (name === 'lib/value.mjs' ? FILES[name].replace(/\n/g, '\r\n') : FILES[name]);
for (const name of Object.keys(FILES)) {
  await fs.mkdir(path.dirname(path.join(fake, name)), { recursive: true });
  await fs.writeFile(path.join(fake, name), onDisk(name), 'utf8');
}
const fingerprint = () => createHash('sha256').update(Object.keys(FILES).sort().map((name) => readFileSync(path.join(fake, name), 'utf8')).join('\0')).digest('hex');
const before = fingerprint();

let counter = 0;
async function list(suite, mutations) {
  const file = path.join(root, `list-${counter += 1}.json`);
  await fs.writeFile(file, JSON.stringify({ suite, mutations }), 'utf8');
  return file;
}
function run(listFile, args = []) {
  const json = path.join(root, `out-${counter += 1}.json`);
  const result = spawnSync(process.execPath, [TOOL, listFile, '--hub-root', fake, '--json', json, ...args], { encoding: 'utf8', timeout: 90_000, windowsHide: true });
  assert.equal(result.error, undefined, `could not start the tool: ${result.error?.message}`);
  const report = existsSync(json) ? JSON.parse(readFileSync(json, 'utf8')) : null;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, report, results: Object.fromEntries((report?.results ?? []).map((entry) => [entry.name, entry])) };
}
const patch = (file, old, replacement) => ({ file, old, new: replacement });

try {
  // ---- verdicts ----------------------------------------------------------------------------------------------------------------
  {
    const file = await list('verify-fake.mjs', [
      { name: 'value', what: 'the constant changes', patches: [patch('lib/value.mjs', 'value = 1', 'value = 2')] },
      { name: 'value-again', what: 'the same patch once more: the first one was put back', patches: [patch('lib/value.mjs', 'value = 1', 'value = 2')] },
      { name: 'guard', what: 'the guard is loosened', patches: [patch('lib/value.mjs', 'x > 5', 'x > 50')] },
      { name: 'two-patches', what: 'two files-worth of change in one mutation', patches: [patch('lib/value.mjs', 'value = 1', 'value = 7'), patch('lib/value.mjs', 'x > 5', 'x > 55')] },
      { name: 'multi-line', what: 'a pattern that spans two lines of a CRLF file', patches: [patch('lib/value.mjs', "export const label = 'one';\nexport function guard(x) {\n  if (x > 5)", "export const label = 'one';\nexport function guard(x) {\n  if (x > 500)")] },
      { name: 'label', what: 'a change nothing checks', patches: [patch('lib/value.mjs', "'one'", "'uno'")] },
      { name: 'dollar', what: 'a replacement with $& in it is inserted literally', patches: [patch('lib/value.mjs', "'one'", "'$&$1'")] },
      { name: 'equivalent', what: 'a known-equivalent change survives without failing the run', equivalent: 'The label is documentation only; nothing reads it, so no suite can tell the difference.', patches: [patch('lib/value.mjs', "'one'", "'één'")] },
      { name: 'stale-annotation', what: 'annotated as equivalent but the suite does notice it', equivalent: 'Wrongly claimed to change nothing; the suite checks this constant.', patches: [patch('lib/value.mjs', 'value = 1', 'value = 4')] },
    ]);
    const { status, results, stdout, report } = run(file);
    assert.equal(status, 1, stdout);
    assert.equal(results.value.status, 'KILLED');
    assert.ok(results.value.checks.some((line) => line.includes('value is 1')), 'the failing check is reported by name');
    assert.equal(results['value-again'].status, 'KILLED', 'the first mutation was restored before the second ran');
    assert.equal(results.guard.status, 'KILLED');
    assert.equal(results['two-patches'].status, 'KILLED');
    assert.equal(results.label.status, 'SURVIVED');
    assert.equal(results.dollar.status, 'SURVIVED');
    assert.equal(results['multi-line'].status, 'KILLED', 'a multi-line pattern matches a CRLF file');
    assert.equal(results.equivalent.status, 'EQUIVALENT');
    assert.equal(results['stale-annotation'].status, 'KILLED');
    assert.match(results['stale-annotation'].note, /annotation is stale/);
    assert.deepEqual({ killed: report.summary.killed, survived: report.summary.survived, equivalent: report.summary.equivalent, error: report.summary.error, skip: report.summary.skip }, { killed: 6, survived: 2, equivalent: 1, error: 0, skip: 0 });
    assert.match(stdout, /SURVIVED: label, dollar/);
    ok('a mutation the suite notices is KILLED (with the failing checks named), one it does not notice is SURVIVED and the run exits 1');
    ok('each mutation is undone before the next, and replacement text is inserted literally ($& is not special)');
  }
  {
    const survivor = await list('verify-fake.mjs', [{ name: 'label', what: 'x', patches: [patch('lib/value.mjs', "'one'", "'uno'")] }]);
    assert.equal(run(survivor).status, 1);
    const clean = await list('verify-fake.mjs', [{ name: 'value', what: 'x', patches: [patch('lib/value.mjs', 'value = 1', 'value = 2')] }]);
    const result = run(clean);
    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stdout, /SUMMARY: 1 killed, 0 survived, 0 equivalent, 0 error, 0 skip/);
    const equivalentOnly = run(await list('verify-fake.mjs', [
      { name: 'value', what: 'x', patches: [patch('lib/value.mjs', 'value = 1', 'value = 2')] },
      { name: 'equivalent', what: 'x', equivalent: 'The label is documentation only; nothing reads it, so no suite can tell the difference.', patches: [patch('lib/value.mjs', "'one'", "'uno'")] },
    ]));
    assert.equal(equivalentOnly.status, 0, 'a documented equivalent mutation does not fail the run');
    ok('exit 0 only when every mutation was killed (or is documented as equivalent)');
  }

  // ---- mutations that only make sense on one platform ---------------------------------------------------------------------------
  {
    const other = process.platform === 'win32' ? 'linux' : 'win32';
    const file = await list('verify-fake.mjs', [
      { name: 'here', what: 'limited to this platform: it runs', platforms: [process.platform], patches: [patch('lib/value.mjs', 'value = 1', 'value = 2')] },
      { name: 'elsewhere', what: 'limited to another platform: it must neither run nor count as a survivor', platforms: [other], patches: [patch('lib/value.mjs', "'one'", "'uno'")] },
    ]);
    const { status, results, report, stdout } = run(file);
    assert.equal(status, 0, stdout);
    assert.equal(results.here.status, 'KILLED');
    assert.equal(results.elsewhere.status, 'N/A');
    assert.match(results.elsewhere.note, new RegExp(`applies only on ${other}`));
    assert.equal(report.summary.notApplicable, 1);
    assert.match(stdout, /SUMMARY: 1 killed, 0 survived, 0 equivalent, 0 error, 0 skip, 1 n\/a/);
    const typo = await list('verify-fake.mjs', [{ name: 'typo', what: 'x', platforms: ['windows'], patches: [patch('lib/value.mjs', 'value = 1', 'value = 2')] }]);
    assert.equal(run(typo).status, 2, 'an unknown platform name is a usage error, not a mutation that silently never runs');
    ok('a mutation with "platforms" runs only there; elsewhere it is N/A (neither a kill nor a survivor, the exit code is unaffected); a misspelt platform is a usage error');
  }

  // ---- patches that do not apply ------------------------------------------------------------------------------------------------
  {
    const file = await list('verify-fake.mjs', [
      { name: 'stale', what: 'x', patches: [patch('lib/value.mjs', 'this text is not in the file', 'x')] },
      { name: 'ambiguous', what: 'x', patches: [patch('lib/value.mjs', 'export const', 'const')] },
      { name: 'no-file', what: 'x', patches: [patch('lib/missing.mjs', 'a', 'b')] },
      { name: 'half-applied', what: 'the first patch applies, the second does not: nothing may stay changed', patches: [patch('lib/value.mjs', 'value = 1', 'value = 2'), patch('lib/value.mjs', 'not there', 'x')] },
      { name: 'after', what: 'a good mutation after the bad ones still works', patches: [patch('lib/value.mjs', 'value = 1', 'value = 2')] },
    ]);
    const { status, results } = run(file);
    assert.equal(status, 1);
    for (const name of ['stale', 'ambiguous', 'no-file', 'half-applied']) assert.equal(results[name].status, 'ERROR', name);
    assert.match(results.ambiguous.note, /occurs 2 times, expected exactly 1/);
    assert.match(results.stale.note, /occurs 0 times/);
    assert.equal(results.after.status, 'KILLED', 'the half-applied mutation was undone');
    ok('a pattern that is missing, ambiguous or in a missing file is an ERROR (never a free kill), and a half-applied mutation is undone');
  }

  // ---- suites that cannot be judged ----------------------------------------------------------------------------------------------
  {
    const broken = run(await list('verify-broken.mjs', [{ name: 'm', what: 'x', patches: [patch('lib/value.mjs', 'value = 1', 'value = 2')] }]));
    assert.equal(broken.status, 2);
    assert.match(broken.stderr, /does not PASS on the unmodified copy \(exit 1\)/);
    assert.equal(broken.report, null);
    const skippy = run(await list('verify-skippy.mjs', [{ name: 'm', what: 'x', patches: [patch('lib/value.mjs', 'value = 1', 'value = 2')] }]));
    assert.equal(skippy.status, 2);
    assert.match(skippy.stderr, /SKIP: the tool it needs is not installed/);
    ok('a suite that fails or skips on the unmodified code stops the run (exit 2): nothing could be judged');
  }
  {
    const file = await list('verify-condskip.mjs', [
      { name: 'skips', what: 'the suite skips under this change', patches: [patch('lib/value.mjs', 'value = 1', 'value = 3')] },
      { name: 'kills', what: 'x', patches: [patch('lib/value.mjs', 'value = 1', 'value = 2')] },
    ]);
    const strict = run(file);
    assert.equal(strict.results.skips.status, 'SKIP');
    assert.equal(strict.results.kills.status, 'KILLED');
    assert.equal(strict.status, 1, 'a skipped mutation is not a kill');
    assert.equal(run(file, ['--allow-skip']).status, 0);
    ok('a suite that SKIPs under a mutation is SKIP, not SURVIVED or KILLED; --allow-skip accepts it');
  }
  {
    const started = Date.now();
    const result = run(await list('verify-hang.mjs', [{ name: 'hang', what: 'the code makes the suite hang', patches: [patch('lib/value.mjs', 'value = 1', 'value = 99')] }]), ['--timeout', '3']);
    assert.equal(result.results.hang.status, 'KILLED');
    assert.match(result.results.hang.note, /hung and was stopped after 3s/);
    assert.equal(result.status, 0);
    assert.ok(Date.now() - started < 30_000);
    ok('a mutation that makes the suite hang is stopped at the timeout and counts as killed');
  }

  // ---- options and usage ----------------------------------------------------------------------------------------------------------
  {
    const file = await list('verify-fake.mjs', [
      { name: 'a', what: 'x', patches: [patch('lib/value.mjs', 'value = 1', 'value = 2')] },
      { name: 'b', what: 'x', patches: [patch('lib/value.mjs', "'one'", "'uno'")] },
    ]);
    const only = run(file, ['--only', 'a']);
    assert.deepEqual(Object.keys(only.results), ['a']);
    assert.equal(only.status, 0);
    assert.equal(run(file, ['--only', 'nothing']).status, 2);
    const kept = run(file, ['--only', 'a', '--keep']);
    const keptPath = kept.stdout.match(/Kept the mutated copy at (.+)/)?.[1]?.trim();
    assert.ok(keptPath && existsSync(path.join(keptPath, 'lib', 'value.mjs')), 'the copy is kept on request');
    assert.equal(readFileSync(path.join(keptPath, 'lib', 'value.mjs'), 'utf8'), onDisk('lib/value.mjs'), 'and it is back to the original text, line endings included');
    await fs.rm(path.dirname(keptPath), { recursive: true, force: true });
    ok('--only selects mutations; --keep leaves the (restored) copy for inspection');
  }
  {
    assert.equal(spawnSync(process.execPath, [TOOL], { encoding: 'utf8' }).status, 2);
    assert.equal(spawnSync(process.execPath, [TOOL, '--bogus'], { encoding: 'utf8' }).status, 2);
    assert.equal(spawnSync(process.execPath, [TOOL, path.join(root, 'no-such-list.json'), '--hub-root', fake], { encoding: 'utf8' }).status, 2);
    const lazy = await list('verify-fake.mjs', [{ name: 'lazy', what: 'x', equivalent: 'ok', patches: [patch('lib/value.mjs', "'one'", "'uno'")] }]);
    assert.equal(run(lazy).status, 2, 'an "equivalent" annotation must explain itself');
    const badShape = path.join(root, 'bad-shape.json');
    await fs.writeFile(badShape, JSON.stringify({ suite: 'verify-fake.mjs', mutations: [{ name: 'x', patches: [] }] }), 'utf8');
    assert.equal(run(badShape).status, 2);
    const outside = await list('verify-fake.mjs', [{ name: 'escape', what: 'x', patches: [patch('../outside.txt', 'a', 'b')] }]);
    const escaped = run(outside);
    assert.equal(escaped.status, 2);
    assert.match(escaped.stderr, /outside the Hub folder/);
    const noSuite = run(await list('verify-nothing.mjs', [{ name: 'x', what: 'x', patches: [patch('lib/value.mjs', 'value = 1', 'value = 2')] }]));
    assert.equal(noSuite.status, 2);
    ok('usage errors exit 2: no list, unknown option, unreadable or malformed list, a patch outside the Hub folder, a missing suite');
  }

  // ---- the real files ---------------------------------------------------------------------------------------------------------------
  assert.equal(fingerprint(), before, 'the tree the tool was pointed at must be byte-for-byte what it was');
  ok('the tree under test is untouched: mutations only ever happen in the temporary copy');
} finally {
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
}

console.log(`PASS: ${checks} mutation-runner checks (kill/survive/error/skip/n-a verdicts, restore, baseline, timeout, options, usage)`);
