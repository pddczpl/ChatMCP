// Tests for the test runner itself (tests/run-all.mjs).
//
// Every number in a test report comes from this runner, so the runner is held to the same standard as the code it tests: a failing
// suite must be FAIL whatever it prints, a hung suite must be TIMEOUT and must not outlive the runner, a skipped suite must be SKIP
// (never PASS), and --no-skip must turn a skip into a failure. The suites below are throw-away files in a temporary folder that the
// runner is pointed at with --tests-dir; none of the real suites is involved.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };

const RUNNER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'run-all.mjs');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-runner-'));
const suites = path.join(root, 'suites');
await fs.mkdir(suites);

const SUITES = {
  'verify-ok-pass.mjs': "console.log('PASS: nothing to see');\n",
  'verify-ok-skip.mjs': "console.log('CHATMCP_TEST_SKIP: the tool it needs is not installed');\n",
  'verify-bad-fail.mjs': "console.log('PASS: this line must not rescue a failing suite');\nprocess.exit(3);\n",
  'verify-bad-skipfail.mjs': "console.log('CHATMCP_TEST_SKIP: a skip marker must not hide a failure');\nprocess.exit(1);\n",
  'verify-bad-crash.mjs': "throw new Error('boom');\n",
  'verify-bad-slow.mjs': "console.log('started');\nsetInterval(() => {}, 1000);\n",
  // Not a suite: wrong prefix and extension, so the runner must not pick it up.
  'helper-pass.mjs': "console.log('PASS: not a suite');\n",
  'verify-notes.txt': 'not a suite either\n',
  // A Python file is only a suite with --python.
  'verify-py-pass.py': "print('PASS: python suite')\n",
};
for (const [name, source] of Object.entries(SUITES)) await fs.writeFile(path.join(suites, name), source, 'utf8');

function run(args) {
  const json = path.join(root, `out-${Math.random().toString(16).slice(2)}.json`);
  const result = spawnSync(process.execPath, [RUNNER, '--tests-dir', suites, '--json', json, ...args], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
  assert.equal(result.error, undefined, `the runner could not be started: ${result.error?.message}`);
  let report = null;
  try { report = JSON.parse(readFileSync(json, 'utf8')); } catch { /* usage errors write no report */ }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, report };
}
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
    assert.deepEqual(names, ['verify-bad-crash.mjs', 'verify-bad-fail.mjs', 'verify-bad-skipfail.mjs', 'verify-bad-slow.mjs', 'verify-ok-pass.mjs', 'verify-ok-skip.mjs']);
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

console.log(`PASS: ${checks} test-runner checks (classification, real exit codes, timeout, discovery, --no-skip, usage errors)`);
