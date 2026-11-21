// Tests for the test runner itself (tests/run-all.mjs).
//
// Every number in a test report comes from this runner, so the runner is held to the same standard as the code it tests: a failing
// suite must be FAIL whatever it prints, a hung suite must be TIMEOUT and must not outlive the runner, a skipped suite must be SKIP
// (never PASS), and --no-skip must turn a skip into a failure. The suites below are throw-away files in a temporary folder that the
// runner is pointed at with --tests-dir; none of the real suites is involved.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };

const RUNNER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'run-all.mjs');
const GATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'ci-flaky-gate.mjs');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-runner-'));
const suites = path.join(root, 'suites');
await fs.mkdir(suites);

const SUITES = {
  'verify-ok-pass.mjs': "console.log('PASS: nothing to see');\n",
  'verify-ok-skip.mjs': "console.log('CHATMCP_TEST_SKIP: the tool it needs is not installed');\n",
  'verify-bad-fail.mjs': "console.log('PASS: this line must not rescue a failing suite');\nprocess.exit(3);\n",
  'verify-bad-skipfail.mjs': "console.log('CHATMCP_TEST_SKIP: a skip marker must not hide a failure');\nprocess.exit(1);\n",
  'verify-bad-crash.mjs': "throw new Error('boom');\n",
  // An assertion whose difference is long: Node prints the difference at the top of its report and then both values in full, 60 lines each, and the words that differ
  // stand near the top of each. The suite also prints enough before it to fill the tail on its own.
  'verify-bad-longdiff.mjs': [
    "import assert from 'node:assert/strict';",
    "for (let i = 1; i <= 400; i += 1) console.log('  ok - a step of the suite that passed, number ' + i);",
    "const rows = (marker) => Array.from({ length: 12 }, (_, i) => ['row' + i, { n: i }, i === 1 ? marker : 'same']);",
    "assert.deepEqual(rows('ACTUAL-VALUE'), rows('EXPECTED-VALUE'));",
  ].join('\n'),
  'verify-bad-slow.mjs': "console.log('started');\nsetInterval(() => {}, 1000);\n",
  // Not a suite: wrong prefix and extension, so the runner must not pick it up.
  'helper-pass.mjs': "console.log('PASS: not a suite');\n",
  'verify-notes.txt': 'not a suite either\n',
  // A Python file is only a suite with --python.
  'verify-py-pass.py': "print('PASS: python suite')\n",
  // Suites for --retry-failed-once. They keep state between attempts in RUNNER_FIXTURE_MARKER (a path the test sets per run), so
  // "fails the first time only" does not depend on timing or on luck.
  'verify-flaky-once.mjs': [
    "import fs from 'node:fs';",
    "const marker = process.env.RUNNER_FIXTURE_MARKER + '.flaky-once';",
    "if (!fs.existsSync(marker)) { fs.writeFileSync(marker, '1'); console.log('first attempt: the assertion that fails'); process.exit(7); }",
    "console.log('second attempt: passes');",
  ].join('\n'),
  'verify-flaky-hang-once.mjs': [
    "import fs from 'node:fs';",
    "const marker = process.env.RUNNER_FIXTURE_MARKER + '.hang-once';",
    "if (!fs.existsSync(marker)) { fs.writeFileSync(marker, '1'); console.log('first attempt hangs'); setInterval(() => {}, 1000); } else console.log('second attempt: passes');",
  ].join('\n'),
  'verify-flaky-then-skip.mjs': [
    "import fs from 'node:fs';",
    "const marker = process.env.RUNNER_FIXTURE_MARKER + '.then-skip';",
    "if (!fs.existsSync(marker)) { fs.writeFileSync(marker, '1'); process.exit(5); }",
    "console.log('CHATMCP_TEST_SKIP: the second attempt skips itself');",
  ].join('\n'),
  // Counts how often it ran: a suite that keeps failing is attempted exactly twice, never three times.
  'verify-count-fail.mjs': [
    "import fs from 'node:fs';",
    "fs.appendFileSync(process.env.RUNNER_FIXTURE_MARKER + '.count', 'x');",
    "process.exit(9);",
  ].join('\n'),
  'verify-count-pass.mjs': [
    "import fs from 'node:fs';",
    "fs.appendFileSync(process.env.RUNNER_FIXTURE_MARKER + '.count-pass', 'x');",
    "console.log('PASS');",
  ].join('\n'),
};
for (const [name, source] of Object.entries(SUITES)) await fs.writeFile(path.join(suites, name), source, 'utf8');

function run(args, extraEnv = {}, directory = suites) {
  const id = Math.random().toString(16).slice(2);
  const json = path.join(root, `out-${id}.json`);
  // A fresh marker per run, so every scenario starts with "this suite has not run yet".
  const marker = path.join(root, `marker-${id}`);
  const result = spawnSync(process.execPath, [RUNNER, '--tests-dir', directory, '--json', json, ...args], { encoding: 'utf8', timeout: 60_000, windowsHide: true, env: { ...process.env, RUNNER_FIXTURE_MARKER: marker, ...extraEnv } });
  assert.equal(result.error, undefined, `the runner could not be started: ${result.error?.message}`);
  let report = null;
  try { report = JSON.parse(readFileSync(json, 'utf8')); } catch { /* usage errors write no report */ }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, report, marker };
}
const countOf = (file) => { try { return readFileSync(file, 'utf8').length; } catch { return 0; } };
const byName = (report) => Object.fromEntries(report.results.map((r) => [r.name, r]));

try {
  // ---- classification --------------------------------------------------------------------------------------------------------
  {
    const { status, report, stdout } = run(['--filter', '-ok-']);
    assert.equal(status, 0, stdout);
    const r = byName(report);
    assert.deepEqual(Object.keys(r).sort(), ['verify-ok-pass.mjs', 'verify-ok-skip.mjs']);
    assert.equal(r['verify-ok-pass.mjs'].status, 'PASS');
    assert.equal(r['verify-ok-skip.mjs'].status, 'SKIP');
    assert.match(r['verify-ok-skip.mjs'].note, /tool it needs is not installed/);
    assert.deepEqual({ pass: report.summary.pass, skip: report.summary.skip, fail: report.summary.fail }, { pass: 1, skip: 1, fail: 0 });
    assert.match(stdout, /SUMMARY: 1 pass, 0 fail, 0 timeout, 1 skip/);
    ok('exit 0 only when nothing failed; a skipped suite is SKIP and carries its reason, never PASS');
  }
  {
    const { status, report } = run(['--filter', '-bad-fail', '--timeout', '30']);
    assert.equal(status, 1);
    assert.equal(report.results[0].status, 'FAIL');
    assert.equal(report.results[0].code, 3);
    ok('a suite that exits non-zero is FAIL even though it printed PASS first (the real exit code decides)');
  }
  {
    const { status, report } = run(['--filter', 'skipfail']);
    assert.equal(status, 1);
    assert.equal(report.results[0].status, 'FAIL');
    ok('a skip marker cannot hide a failing exit code');
  }
  {
    const { status, report } = run(['--filter', 'crash']);
    assert.equal(status, 1);
    assert.equal(report.results[0].status, 'FAIL');
    assert.notEqual(report.results[0].code, 0);
    ok('an uncaught exception is FAIL');
  }
  {
    // The log of a CI run is all that is left of a failure that happens once in a hundred runs. verify-subagent-notices failed that way and the runner showed the last 25
    // lines of its output, which were the end of the second value of a long assertion: the words that differ were above them, and the cause could not be read.
    const { status, report, stdout } = run(['--filter', 'bad-longdiff']);
    assert.equal(status, 1);
    assert.equal(report.results[0].status, 'FAIL');
    assert.match(stdout, /ACTUAL-VALUE/, 'what the assertion got is in the log');
    assert.match(stdout, /EXPECTED-VALUE/, 'and what it expected');
    assert.match(stdout, /Expected values to be strictly deep-equal/, 'with the sentence Node starts its report with');
    const shown = stdout.split(/\r?\n/).filter((line) => line.startsWith('    | '));
    assert.ok(shown.length > 25, `${shown.length} lines of the failing suite are shown`);
    // The suite printed far more than the runner keeps, so its tail starts inside a line; that half line is not shown.
    const steps = shown.filter((line) => /number \d+$/.test(line));
    assert.ok(steps.length > 0 && steps.length < 400, `the tail holds some of the steps and not all (${steps.length})`);
    assert.ok(steps.every((line) => line.startsWith('    |   ok - a step of the suite that passed, number ')), 'and each of them is whole');
    assert.ok(stdout.length < 20_000, `and the log of one failing suite stays short (${stdout.length} characters)`);
    ok('a failing suite shows its whole assertion difference (both values and the words that differ), not the last 25 lines of its output');
  }
  {
    const started = Date.now();
    const { status, report, stdout } = run(['--filter', 'slow', '--timeout', '2']);
    const elapsed = Date.now() - started;
    assert.equal(status, 1);
    assert.equal(report.results[0].status, 'TIMEOUT');
    assert.equal(report.results[0].code, null);
    assert.equal(report.summary.timeout, 1);
    assert.match(stdout, /SUMMARY: 0 pass, 0 fail, 1 timeout/);
    assert.ok(elapsed < 20_000, `the hung suite was still running after ${elapsed} ms`);
    ok('a hung suite is killed at the timeout and reported as TIMEOUT (exit 1)');
  }

  // ---- discovery ---------------------------------------------------------------------------------------------------------------
  {
    const list = run(['--list']);
    assert.equal(list.status, 0);
    const names = list.stdout.trim().split(/\r?\n/).sort();
    assert.deepEqual(names, ['verify-bad-crash.mjs', 'verify-bad-fail.mjs', 'verify-bad-longdiff.mjs', 'verify-bad-skipfail.mjs', 'verify-bad-slow.mjs', 'verify-count-fail.mjs', 'verify-count-pass.mjs', 'verify-flaky-hang-once.mjs', 'verify-flaky-once.mjs', 'verify-flaky-then-skip.mjs', 'verify-ok-pass.mjs', 'verify-ok-skip.mjs']);
    ok('only verify-*.mjs files are suites; helpers and other extensions are ignored');
    const withPython = run(['--list', '--python']);
    assert.ok(withPython.stdout.split(/\r?\n/).includes('verify-py-pass.py'));
    assert.ok(!list.stdout.split(/\r?\n/).includes('verify-py-pass.py'));
    ok('Python suites are listed only with --python');
  }

  // ---- --no-skip -------------------------------------------------------------------------------------------------------------
  {
    const all = run(['--filter', '-ok-', '--no-skip', 'all']);
    assert.equal(all.status, 1);
    const r = byName(all.report);
    assert.equal(r['verify-ok-pass.mjs'].status, 'PASS');
    assert.equal(r['verify-ok-skip.mjs'].status, 'FAIL');
    assert.match(r['verify-ok-skip.mjs'].note, /--no-skip requires this suite to run/);
    assert.match(r['verify-ok-skip.mjs'].note, /tool it needs is not installed/);
    assert.equal(all.report.summary.skip, 0);
    ok('--no-skip all: a skipped suite becomes FAIL (exit 1) and the reason for the skip is kept');

    const named = run(['--filter', '-ok-', '--no-skip', 'verify-ok-skip']);
    assert.equal(named.status, 1);
    assert.equal(byName(named.report)['verify-ok-skip.mjs'].status, 'FAIL');
    const withExtension = run(['--filter', '-ok-', '--no-skip', 'verify-ok-pass.mjs, VERIFY-OK-SKIP.MJS']);
    assert.equal(withExtension.status, 1);
    ok('--no-skip name: names work with or without the extension, in any case, in a comma-separated list');

    const other = run(['--filter', '-ok-', '--no-skip', 'verify-ok-pass']);
    assert.equal(other.status, 0);
    assert.equal(byName(other.report)['verify-ok-skip.mjs'].status, 'SKIP');
    ok('--no-skip name: a skip of a suite that was not named is still only SKIP');

    const passing = run(['--filter', 'ok-pass', '--no-skip', 'all']);
    assert.equal(passing.status, 0);
    ok('--no-skip does not touch suites that pass');
  }

  // ---- --retry-failed-once: a flake is shown as a flake ---------------------------------------------------------------------
  {
    const off = run(['--filter', 'flaky-once']);
    assert.equal(off.status, 1, 'without the flag a suite that fails once is FAIL');
    assert.equal(off.report.results[0].status, 'FAIL');
    assert.equal(off.report.results[0].attempts, undefined, 'and was run once');
    assert.equal(off.report.summary.flaky, 0, 'the summary always has the field');
    ok('without --retry-failed-once nothing is retried (FAIL stays FAIL, summary.flaky is 0)');
  }
  {
    const { status, report, stdout } = run(['--retry-failed-once', '--filter', 'flaky-once']);
    assert.equal(status, 0, 'a flake does not fail the run by itself: the streak gate decides that across runs');
    const flaky = report.results[0];
    assert.equal(flaky.status, 'FLAKY', 'it is labelled FLAKY');
    assert.notEqual(flaky.status, 'PASS');
    assert.deepEqual(report.summary, { ...report.summary, pass: 0, fail: 0, timeout: 0, skip: 0, flaky: 1 }, 'and is not counted as a pass');
    assert.equal(flaky.attempts.length, 2);
    assert.deepEqual(flaky.attempts.map((attempt) => attempt.status), ['FAIL', 'PASS']);
    assert.equal(flaky.attempts[0].code, 7);
    assert.match(flaky.attempts[0].tail, /the assertion that fails/, 'the output of the failed attempt is kept in the JSON: the evidence of a flake must not vanish with the retry');
    assert.match(flaky.note, /failed once \(exit 7\).*passed on retry/);
    assert.match(stdout, /^FLAKY\s+verify-flaky-once\.mjs/m, 'the table says FLAKY');
    assert.match(stdout, /first attempt: the assertion that fails/, 'and prints what the first attempt said');
    assert.match(stdout, /SUMMARY: 0 pass, 0 fail, 0 timeout, 0 skip, 1 flaky/);
    ok('--retry-failed-once: a suite that fails then passes is FLAKY (exit 0), not PASS, with both attempts and the first failure output kept');
  }
  {
    const { status, report } = run(['--retry-failed-once', '--filter', 'flaky-hang-once', '--timeout', '2']);
    assert.equal(status, 0);
    assert.equal(report.results[0].status, 'FLAKY');
    assert.deepEqual(report.results[0].attempts.map((attempt) => attempt.status), ['TIMEOUT', 'PASS']);
    ok('--retry-failed-once: a hang that passes the second time is FLAKY too (the first attempt is recorded as TIMEOUT)');
  }
  {
    const { status, report, marker } = run(['--retry-failed-once', '--filter', 'count-fail']);
    assert.equal(status, 1);
    assert.equal(report.results[0].status, 'FAIL');
    assert.equal(report.results[0].attempts.length, 2);
    assert.equal(countOf(`${marker}.count`), 2, 'a suite that keeps failing runs exactly twice');
    assert.match(report.results[0].note, /failed twice/);
    assert.equal(report.summary.fail, 1);
    assert.equal(report.summary.flaky, 0);
    ok('--retry-failed-once: a suite that fails both times stays FAIL (exit 1) and is attempted twice, never more');
  }
  {
    const { status, report } = run(['--retry-failed-once', '--filter', 'flaky-then-skip']);
    assert.equal(status, 1);
    assert.equal(report.results[0].status, 'FAIL', 'a skip on the second attempt does not rescue the failure of the first');
    assert.match(report.results[0].note, /skipped on retry/);
    ok('--retry-failed-once: fail then SKIP is FAIL (a skip never turns a failure into anything else)');
  }
  {
    const { status, report, marker } = run(['--retry-failed-once', '--filter', 'count-pass']);
    assert.equal(status, 0);
    assert.equal(report.results[0].status, 'PASS');
    assert.equal(report.results[0].attempts, undefined);
    assert.equal(countOf(`${marker}.count-pass`), 1, 'a passing suite is not run twice');
    ok('--retry-failed-once: a passing suite is run once and stays PASS');
  }
  {
    const flaky = run(['--retry-failed-once', '--fail-on-flaky', '--filter', 'flaky-once']);
    assert.equal(flaky.status, 1, '--fail-on-flaky turns a FLAKY suite into a failing run');
    assert.equal(flaky.report.results[0].status, 'FLAKY');
    const clean = run(['--retry-failed-once', '--fail-on-flaky', '--filter', 'count-pass']);
    assert.equal(clean.status, 0);
    ok('--fail-on-flaky: exit 1 when any suite was FLAKY, 0 when none was');
  }
  {
    const summaryFile = path.join(root, 'step-summary.md');
    const quiet = run(['--retry-failed-once', '--filter', 'flaky-once'], { GITHUB_ACTIONS: '', GITHUB_STEP_SUMMARY: '' });
    assert.doesNotMatch(quiet.stdout, /::warning/, 'no workflow command outside GitHub Actions');
    const inActions = run(['--retry-failed-once', '--filter', 'flaky-once'], { GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summaryFile });
    assert.match(inActions.stdout, /^::warning title=FLAKY suite::verify-flaky-once\.mjs failed once \(exit 7\) and passed on retry/m, 'a flake is an annotation on the run');
    const markdown = readFileSync(summaryFile, 'utf8');
    assert.match(markdown, /FLAKY/);
    assert.match(markdown, /verify-flaky-once\.mjs/);
    ok('on GitHub Actions a FLAKY suite becomes a ::warning annotation and a line in the step summary');
  }
  {
    const bail = run(['--retry-failed-once', '--bail', '--filter', 'verify-bad-', '--timeout', '30']);
    assert.equal(bail.status, 1);
    assert.equal(bail.report.results.length, 1, '--bail still stops at the first suite that is FAIL after its retry');
    assert.equal(bail.report.results[0].attempts.length, 2);
    ok('--retry-failed-once and --bail: the retry happens before the run is stopped');
  }

  // ---- --shard i/n: CI runs the suites of one OS and Node version in n jobs; together the jobs must run every suite exactly once -----------
  const listOf = (args, directory = suites) => {
    const result = spawnSync(process.execPath, [RUNNER, '--tests-dir', directory, '--list', ...args], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
    assert.equal(result.status, 0, `--list ${args.join(' ')} exited ${result.status}: ${result.stderr}`);
    return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  };
  /** The lists of shards 1..count, and the checks that hold for any split: nothing lost, nothing twice, the full list is the union. */
  const shardsOf = (count, extra = [], directory = suites) => {
    const full = listOf(extra, directory);
    const shards = Array.from({ length: count }, (_, i) => listOf(['--shard', `${i + 1}/${count}`, ...extra], directory));
    const flat = shards.flat();
    assert.equal(new Set(flat).size, flat.length, `with ${count} shards a suite is in two of them: ${JSON.stringify(shards)}`);
    assert.deepEqual([...flat].sort(), [...full].sort(), `with ${count} shards the union is not the full list`);
    for (const shard of shards) assert.deepEqual(shard, [...shard].sort(), 'a shard runs its suites in name order, as the full run does');
    return shards;
  };
  {
    // No shard-weights.json in this folder: every suite weighs the same, so the shards differ by at most one suite.
    for (const count of [1, 2, 3, 5, 12, 13]) {
      const sizes = shardsOf(count).map((shard) => shard.length);
      assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `${count} shards without weights: sizes ${sizes.join('/')}`);
    }
    assert.deepEqual(listOf(['--shard', '13/13']), [], 'more shards than suites: the last one is empty, which --list prints as nothing');
    const withPython = shardsOf(2, ['--python']);
    assert.equal(withPython.filter((shard) => shard.includes('verify-py-pass.py')).length, 1, 'a Python suite (--python) is in exactly one shard');
    ok('--shard i/n (1 to 13 shards, with and without --python): every suite is in exactly one shard, the union is the full list, each shard runs in name order; without weights the sizes differ by at most one');
  }
  const weighted = path.join(root, 'weighted');
  await fs.mkdir(weighted);
  for (const name of ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'new-foxtrot', 'new-golf']) await fs.writeFile(path.join(weighted, `verify-sh-${name}.mjs`), `console.log('PASS: ${name}');\n`, 'utf8');
  // Seconds per suite, as CI measured them. The two "new" suites are not listed: they weigh the mean of the listed suites that exist (30).
  // verify-sh-gone.mjs no longer exists: its 500 s must neither be placed nor move the mean.
  const WEIGHTS = { about: 'fixture of tests/verify-test-runner.mjs', seconds: { 'verify-sh-alpha.mjs': 50, 'verify-sh-bravo.mjs': 40, 'verify-sh-charlie.mjs': 30, 'verify-sh-delta.mjs': 20, 'verify-sh-echo.mjs': 10, 'verify-sh-gone.mjs': 500 } };
  await fs.writeFile(path.join(weighted, 'shard-weights.json'), JSON.stringify(WEIGHTS), 'utf8');
  const suite = (name) => `verify-sh-${name}.mjs`;
  {
    // The rule, worked by hand. Listed suites first, heaviest first (ties by name), each to the lightest shard (ties to the lower number):
    //   2 shards: alpha 50 -> 1 (50); bravo 40 -> 2 (40); charlie 30 -> 2 (70); delta 20 -> 1 (70); echo 10 -> 1, the tie (80).
    //   Then the unlisted suites in name order, 30 each: new-foxtrot -> 2 (100); new-golf -> 1 (110).
    assert.deepEqual(shardsOf(2, [], weighted), [['alpha', 'delta', 'echo', 'new-golf'].map(suite), ['bravo', 'charlie', 'new-foxtrot'].map(suite)]);
    //   3 shards: alpha -> 1 (50); bravo -> 2 (40); charlie -> 3 (30); delta -> 3 (50); echo -> 2 (50); new-foxtrot -> 1, all tied (80); new-golf -> 2 (80).
    assert.deepEqual(shardsOf(3, [], weighted), [['alpha', 'new-foxtrot'].map(suite), ['bravo', 'echo', 'new-golf'].map(suite), ['charlie', 'delta'].map(suite)]);
    assert.deepEqual(shardsOf(2, [], weighted), shardsOf(2, [], weighted), 'the same input gives the same split every time');
    ok('--shard with tests/shard-weights.json: listed suites heaviest first to the lightest shard, then unlisted ones at the mean weight in name order; a listed suite that no longer exists is ignored; worked examples for 2 and 3 shards');
  }
  {
    assert.deepEqual(listOf(['--shard', '1/2', '--filter', 'new'], weighted), [suite('new-golf')], '--filter picks from the shard; it does not split again');
    assert.deepEqual(listOf(['--shard', '2/2', '--filter', 'NEW'], weighted), [suite('new-foxtrot')]);
    const { status, report, stdout } = run(['--shard', '2/2'], {}, weighted);
    assert.equal(status, 0, stdout);
    assert.deepEqual(report.results.map((result) => result.name), ['bravo', 'charlie', 'new-foxtrot'].map(suite), 'a run of shard 2/2 runs exactly the suites --list --shard 2/2 prints');
    assert.deepEqual(report.summary.shard, { index: 2, count: 2, suites: 3, of: 7 }, 'the JSON summary records the shard, its size and the size of the full list');
    assert.match(stdout, /3 suite\(s\), shard 2\/2 of 7/);
    const filtered = run(['--shard', '1/2', '--filter', 'echo'], {}, weighted);
    assert.deepEqual([filtered.report.results.map((result) => result.name), filtered.report.summary.total, filtered.report.summary.shard], [[suite('echo')], 1, { index: 1, count: 2, suites: 4, of: 7 }], 'with --filter the summary still names the shard as split');
    assert.equal(run(['--filter', 'echo'], {}, weighted).report.summary.shard, null, 'a run without --shard records shard: null');
    ok('--shard with --filter (the filter applies after the split, so it cannot move a suite) and --json (summary.shard = {index, count, suites, of}, null without --shard)');
  }
  {
    // --retry-failed-once and --no-skip work per suite, so they behave the same inside a shard.
    const shards = shardsOf(2);
    const holding = (name) => shards.findIndex((shard) => shard.includes(name)) + 1;
    const flaky = run(['--shard', `${holding('verify-flaky-once.mjs')}/2`, '--filter', 'flaky-once', '--retry-failed-once']);
    assert.equal(flaky.status, 0, flaky.stdout);
    assert.deepEqual(flaky.report.results.map((result) => [result.name, result.status]), [['verify-flaky-once.mjs', 'FLAKY']]);
    const elsewhere = run(['--shard', `${3 - holding('verify-flaky-once.mjs')}/2`, '--filter', 'flaky-once']);
    assert.equal(elsewhere.status, 2, 'the other shard does not hold the suite: nothing matched');
    const skip = run(['--shard', `${holding('verify-ok-skip.mjs')}/2`, '--filter', 'ok-skip', '--no-skip', 'all']);
    assert.equal(skip.status, 1);
    assert.deepEqual(skip.report.results.map((result) => [result.name, result.status]), [['verify-ok-skip.mjs', 'FAIL']]);
    ok('--shard with --retry-failed-once (FLAKY inside its shard; the other shard does not run it) and --no-skip all (a skip in the shard is FAIL)');
  }
  {
    for (const bad of ['0/2', '3/2', '1/0', 'x/2', '1/2/3', '1', '-1/2', '1/-2', '1.5/2', '']) {
      const result = spawnSync(process.execPath, [RUNNER, '--tests-dir', suites, '--list', '--shard', bad], { encoding: 'utf8', windowsHide: true });
      assert.equal(result.status, 2, `--shard "${bad}" is a usage error`);
      assert.match(result.stderr, /--shard/, `the message for "${bad}" names the option`);
    }
    assert.equal(spawnSync(process.execPath, [RUNNER, '--tests-dir', suites, '--list', '--shard'], { encoding: 'utf8', windowsHide: true }).status, 2, '--shard without a value');
    const broken = path.join(root, 'broken-weights');
    await fs.mkdir(broken);
    await fs.writeFile(path.join(broken, 'verify-one.mjs'), "console.log('PASS');\n", 'utf8');
    for (const content of ['{ not json', JSON.stringify({ seconds: { 'verify-one.mjs': -1 } }), JSON.stringify({ seconds: { 'verify-one.mjs': 'ten' } }), JSON.stringify({ seconds: [] }), JSON.stringify([])]) {
      await fs.writeFile(path.join(broken, 'shard-weights.json'), content, 'utf8');
      const result = spawnSync(process.execPath, [RUNNER, '--tests-dir', broken, '--list', '--shard', '1/2'], { encoding: 'utf8', windowsHide: true });
      assert.equal(result.status, 2, `a broken weights file (${content}) is an error, not a silent split by count`);
      assert.match(result.stderr, /shard-weights\.json/, 'and the message names the file');
    }
    assert.deepEqual(listOf([], broken), ['verify-one.mjs'], 'without --shard the weights file is not read at all');
    ok('--shard usage errors exit 2 (0/2, 3/2, 1/0, words, three parts, negatives, fractions, empty, no value); a broken shard-weights.json is an error when --shard reads it and is never read without --shard');
  }
  {
    // The real suites of this folder and the committed weights: two shards cover the full list, and the heavier shard is within the bound
    // that this greedy split always meets: total / n + (1 - 1/n) x the heaviest suite.
    const real = (args) => {
      const result = spawnSync(process.execPath, [RUNNER, '--list', ...args], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    };
    const full = real([]);
    const halves = [real(['--shard', '1/2']), real(['--shard', '2/2'])];
    const flat = halves.flat();
    assert.equal(new Set(flat).size, flat.length, 'no real suite is in both shards');
    assert.deepEqual([...flat].sort(), [...full].sort(), 'the two shards of the real suites are the full list');
    const file = path.join(path.dirname(RUNNER), 'shard-weights.json');
    assert.ok(existsSync(file), 'tests/shard-weights.json is committed');
    const seconds = JSON.parse(readFileSync(file, 'utf8')).seconds;
    const listed = full.filter((name) => Object.hasOwn(seconds, name));
    assert.ok(listed.length * 2 > full.length, `tests/shard-weights.json lists ${listed.length} of the ${full.length} suites; with fewer than half the split is close to a split by count (refresh it: docs/CI-HEALTH.md)`);
    const mean = listed.reduce((sum, name) => sum + seconds[name], 0) / listed.length;
    const weight = (name) => (Object.hasOwn(seconds, name) ? seconds[name] : mean);
    const totals = halves.map((half) => half.reduce((sum, name) => sum + weight(name), 0));
    const total = totals[0] + totals[1];
    const bound = total / 2 + Math.max(...full.map(weight)) / 2;
    assert.ok(Math.max(...totals) <= bound + 1e-9, `the heavier shard (${Math.max(...totals).toFixed(1)} s) is above the bound ${bound.toFixed(1)} s`);
    ok(`the real suites: ${halves[0].length} + ${halves[1].length} = ${full.length} (${full.length - listed.length} not in tests/shard-weights.json); predicted ${totals[0].toFixed(0)} s / ${totals[1].toFixed(0)} s on the Windows runner (heavier shard ${(Math.max(...totals) / total * 100).toFixed(1)}% of ${total.toFixed(0)} s, bound ${(bound / total * 100).toFixed(1)}%)`);
  }

  // ---- scripts/ci-flaky-gate.mjs: one flake is allowed, three runs of main in a row are not -------------------------------------
  if (existsSync(GATE)) {
    const gate = await import(pathToFileURL(GATE).href);
    const summaryOf = (flaky, names = []) => ({ summary: { total: 10, pass: 10 - flaky, fail: 0, timeout: 0, skip: 0, ...(flaky === null ? {} : { flaky }) }, results: names.map((name) => ({ name, status: 'FLAKY' })) });
    const write = async (dir, file, value) => { await fs.mkdir(dir, { recursive: true }); await fs.writeFile(path.join(dir, file), typeof value === 'string' ? value : JSON.stringify(value)); };

    assert.deepEqual(gate.flakyOfSummary(summaryOf(2, ['verify-a.mjs', 'verify-b.mjs'])), { flaky: 2, suites: ['verify-a.mjs', 'verify-b.mjs'] });
    assert.deepEqual(gate.flakyOfSummary(summaryOf(null)), { flaky: 0, suites: [] }, 'a summary written before the retry existed has no flaky field: 0');
    assert.deepEqual(gate.flakyOfSummary({ summary: {}, results: [{ name: 'verify-c.mjs', status: 'FLAKY' }] }), { flaky: 1, suites: ['verify-c.mjs'] }, 'a FLAKY result counts even if the total is missing');
    assert.deepEqual(gate.flakyOfSummary(null), { flaky: 0, suites: [] });
    ok('gate: flakyOfSummary reads the count and the names, and treats an old summary as 0');

    const decide = (current, previous, limit) => gate.decideFlakyGate({ current: { flaky: current }, previous: previous.map((flaky, index) => ({ id: index, flaky })), ...(limit === undefined ? {} : { limit }) });
    assert.equal(decide(1, [2, 1]).fail, true, 'this run and the two before it');
    assert.equal(decide(1, [2, 1]).streak, 3);
    assert.equal(decide(1, [2, 0]).fail, false, 'a clean run in between ends the streak');
    assert.equal(decide(1, [2, 0]).streak, 2);
    assert.equal(decide(0, [2, 1]).fail, false, 'a clean current run never fails');
    assert.equal(decide(0, [2, 1]).streak, 0);
    assert.equal(decide(1, [1]).fail, false, 'fewer runs than the limit cannot make a streak of the limit');
    assert.equal(decide(1, []).fail, false);
    assert.equal(decide(1, [null, 3]).fail, false, 'an unknown run (no summaries) ends the streak: the gate never fails on what it did not see');
    assert.equal(decide(1, [3, 3, 3, 3]).streak, 5, 'the streak is counted as far as it goes');
    assert.equal(decide(1, [1], 2).fail, true, 'the limit is a parameter');
    assert.equal(decide(1, [1, 1], 4).fail, false);
    assert.throws(() => decide(1, [1], 0), RangeError);
    const named = gate.decideFlakyGate({ current: { flaky: 1, suites: ['verify-x.mjs'] }, previous: [{ id: 1, flaky: 1, suites: ['verify-y.mjs'] }, { id: 2, flaky: 2, suites: ['verify-x.mjs'] }] });
    assert.equal(named.fail, true);
    assert.match(named.message, /3 runs of main in a row/);
    assert.match(named.message, /verify-x\.mjs, verify-y\.mjs/, 'the message names the suites, each once');
    ok('gate: three FLAKY runs in a row fail; a clean or unknown run in between, or fewer runs, never do; the limit is a parameter');

    const runs = path.join(root, 'gate-runs');
    await write(path.join(runs, 'current', 'hub-test-summary-ubuntu-latest-node22'), 'summary.json', summaryOf(1, ['verify-flaky-once.mjs']));
    await write(path.join(runs, 'current', 'hub-test-summary-windows-latest-node24'), 'summary.json', summaryOf(0));
    await write(path.join(runs, 'current', 'unrelated'), 'notes.json', { hello: 'world' });
    await write(path.join(runs, 'current', 'broken'), 'summary.json', '{ not json');
    const current = await gate.readRunSummaries(path.join(runs, 'current'));
    assert.deepEqual({ files: current.files, flaky: current.flaky, suites: current.suites }, { files: 2, flaky: 1, suites: ['verify-flaky-once.mjs'] }, 'summaries are added up across the jobs of a run; JSON that is not a summary is ignored');
    assert.deepEqual(await gate.readRunSummaries(path.join(runs, 'missing')), { files: 0, flaky: null, suites: [] }, 'no folder, no summaries: unknown, not zero');
    ok('gate: readRunSummaries adds up the matrix jobs of a run and reports "unknown" when there is nothing to read');

    const prior = path.join(runs, 'prior');
    for (const [id, flaky] of [[201, 1], [202, 2], [203, 1]]) await write(path.join(prior, String(id), 'hub-test-summary-ubuntu-latest-node22'), 'summary.json', summaryOf(flaky, ['verify-flaky-once.mjs']));
    const cli = (args) => spawnSync(process.execPath, [GATE, '--current', path.join(runs, 'current'), '--previous-dir', prior, ...args], { encoding: 'utf8', windowsHide: true });
    const failing = cli([]);
    assert.equal(failing.status, 1, failing.stdout + failing.stderr);
    assert.match(failing.stdout, /^FAIL: FLAKY suites in 3 runs of main in a row/m);
    assert.equal(cli(['--limit', '4']).status, 1, 'a limit of 4 reads three earlier runs: this one and those three are four flaky runs');
    assert.equal(cli(['--limit', '5']).status, 0, 'only three earlier runs exist, so a streak of five cannot be shown');
    // ci.yml runs the Hub suites in two shards per OS and Node version, so this run has one summary per shard; the job says how many it expects.
    assert.equal(cli(['--expect-summaries', '2']).status, 1, 'both summaries of this run are there: the streak decides');
    const short = cli(['--expect-summaries', '8']);
    assert.equal(short.status, 2, 'fewer summaries than jobs is an error, not a verdict on part of the run');
    assert.match(short.stderr, /2 summaries[^\n]*expected 8/);
    for (const bad of ['0', 'two', '-1']) assert.equal(cli(['--expect-summaries', bad]).status, 2, `--expect-summaries ${bad}`);
    await write(path.join(prior, '202', 'hub-test-summary-ubuntu-latest-node22'), 'summary.json', summaryOf(0));
    assert.equal(cli([]).status, 0, 'a clean run in between');
    await fs.rm(path.join(prior, '202'), { recursive: true });
    await fs.mkdir(path.join(prior, '202'));
    assert.equal(cli([]).status, 0, 'a run with no readable summary is unknown, and unknown is not a flake');
    assert.match(cli([]).stdout, /unknown \(no summaries\)/);
    const json = JSON.parse(cli(['--json']).stdout);
    assert.deepEqual([json.fail, json.streak, json.limit], [false, 2, 3]);
    assert.equal(spawnSync(process.execPath, [GATE, '--current', path.join(runs, 'missing'), '--previous-dir', prior], { encoding: 'utf8', windowsHide: true }).status, 2, 'no summary for this run is a usage error, not a pass');
    assert.equal(spawnSync(process.execPath, [GATE, '--nonsense'], { encoding: 'utf8', windowsHide: true }).status, 2);
    ok('gate: the command line exits 1 on a streak of three, 0 otherwise, 2 when this run has no summary, fewer than --expect-summaries, or the usage is wrong');

    const asked = [];
    const ids = await gate.previousRunIds({ repo: 'o/r', workflow: 'CI', branch: 'main', exceptRunId: 500, count: 2, run: async (args) => { asked.push(args); return JSON.stringify([
      { databaseId: 500, conclusion: 'failure', createdAt: '2026-10-20T10:00:00Z' }, { databaseId: 499, conclusion: 'cancelled', createdAt: '2026-10-20T09:00:00Z' },
      { databaseId: 498, conclusion: 'success', createdAt: '2026-10-19T09:00:00Z' }, { databaseId: 497, conclusion: 'failure', createdAt: '2026-10-18T09:00:00Z' }, { databaseId: 496, conclusion: 'success', createdAt: '2026-10-17T09:00:00Z' }]); } });
    assert.deepEqual(ids, [498, 497], 'the current run and cancelled runs are not history; newest first');
    assert.deepEqual(asked.map((args) => args.slice(0, 2)), [['run', 'list']]);
    assert.ok(asked[0].includes('--event') && asked[0].includes('push') && asked[0].includes('--branch') && asked[0].includes('main'), 'only push runs of main');
    assert.ok(gate.GH_ALLOWED.every(([a, b]) => a === 'run' && ['list', 'download'].includes(b)), 'the only gh commands are run list and run download');
    ok('gate: the history is the previous completed push runs of main (not the current run, not cancelled ones), read with run list only');
  } else console.log('  skip - scripts/ci-flaky-gate.mjs was not found next to DATGOLD-HUB (the gate checks need the whole repository)');

  // ---- usage errors ----------------------------------------------------------------------------------------------------------
  {
    const unknown = run(['--nonsense']);
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /Unknown option: --nonsense/);
    const missing = run(['--filter']);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /--filter requires a value/);
    const emptyNoSkip = run(['--no-skip', ',']);
    assert.equal(emptyNoSkip.status, 2);
    const badTimeout = run(['--timeout', '0']);
    assert.equal(badTimeout.status, 2);
    const nothing = run(['--filter', 'matches-nothing-at-all']);
    assert.equal(nothing.status, 2);
    assert.match(nothing.stderr, /No test suites matched/);
    ok('usage errors exit 2 with a message (unknown option, missing value, empty --no-skip, bad timeout, no match)');
  }
} finally {
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
}

console.log(`PASS: ${checks} test-runner checks (classification, real exit codes, timeout, discovery, --no-skip, --retry-failed-once and FLAKY, --shard, the flaky-streak gate, usage errors)`);
