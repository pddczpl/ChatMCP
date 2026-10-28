// scripts/ci-health.mjs against a saved `gh` output, offline: the arithmetic of the CI health gate, its exit codes and its read-only promise.
//
// The fixture (tests/fixtures/ci-health/gh-output.json) has the shape of `gh run list --json ...` and `gh pr list --state merged --json ...` and
// the edge cases the gate has to get right: fewer than 50 runs on main, a run still in progress, cancelled / skipped / timed_out /
// startup_failure runs, a re-run, another workflow whose jobs are always skipped, a branch without a pull request, a pull request whose
// commits were built twice (push + pull_request), one that was built once per commit, one closed without merge, a run from before the pull
// request existed. The expected numbers below were counted by hand from the fixture (and the generated data set with a separate Python
// script), not by running the code under test.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(HUB, '..');
const SCRIPT = path.join(REPO, 'scripts', 'ci-health.mjs');
const FIXTURE = path.join(HUB, 'tests', 'fixtures', 'ci-health', 'gh-output.json');
if (!existsSync(SCRIPT)) {
  console.log('CHATMCP_TEST_SKIP: scripts/ci-health.mjs was not found next to DATGOLD-HUB (the CI health check needs the whole repository)');
  process.exit(0);
}
const { GH_ALLOWED, buildReport, ghArguments, runGh } = await import(pathToFileURL(SCRIPT).href);

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} != ${expected}`);
const cli = (args, env = process.env) => new Promise((resolve) => {
  execFile(process.execPath, [SCRIPT, ...args], { env, windowsHide: true }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
});
const asJson = async (args) => { const result = await cli([...args, '--json']); return { ...result, report: result.stdout.trim().startsWith('{') ? JSON.parse(result.stdout) : null }; };

// ---- 1. the fixture, through the command line ------------------------------------------------------------------------------------------
{
  const { code, report } = await asJson(['--fixture', FIXTURE]);
  assert.equal(code, 1, 'with the default limits this fixture fails (33% failures, two commits built twice)');
  for (const window of report.windows) {
    assert.equal(window.available, 12, 'CI has 12 runs on main in the fixture');
    assert.equal(window.windowFilled, false, 'fewer runs than the window: reported, never padded');
    assert.deepEqual([window.runs, window.completed, window.success, window.failure, window.cancelled, window.skipped, window.other, window.notCompleted, window.rerun],
      [12, 11, 6, 3, 1, 1, 0, 1, 1], `window ${window.window}: runs, completed, success, failure (failure + timed_out + startup_failure), cancelled, skipped, other, in progress, re-run`);
    assert.equal(window.decided, 9);
    near(window.failureShare, 3 / 9, `window ${window.window} failure share`);
    near(window.failureShareOfCompleted, 3 / 11, `window ${window.window} failure share of completed`);
  }
  assert.deepEqual(report.windows.map((window) => window.window), [50, 100]);
  ok('main, workflow CI, 12 runs: 6 success, 3 failure (failure+timed_out+startup_failure), 1 cancelled, 1 skipped, 1 in progress, 1 re-run; share 3/9 and 3/11; a window with fewer runs than asked is flagged');

  const costs = report.pullRequests;
  assert.deepEqual([costs.pullRequests, costs.withRunData, costs.withoutRunData], [3, 2, 1], 'three merged pull requests; #104 has no run in the history and is "no data", not "zero runs"; the closed one is not counted');
  near(costs.runsPerPullRequest, 3, 'runs per merged pull request with run data (2 and 4)');
  assert.equal(costs.duplicatedCommits, 2);
  const [, clean, built] = costs.items; // newest first: #104, #102, #101
  assert.deepEqual([costs.items[0].number, costs.items[0].runs, costs.items[0].hasRunData], [104, 0, false]);
  assert.deepEqual([clean.number, clean.runs, clean.commits, clean.maxRunsPerCommitAndWorkflow, clean.duplicated.length], [102, 2, 2, 1, 0], 'the run from before the pull request existed is not counted');
  assert.deepEqual([built.number, built.runs, built.commits, built.maxRunsPerCommitAndWorkflow, built.duplicated.length], [101, 4, 2, 2, 2]);
  assert.deepEqual(built.duplicated.map((entry) => entry.events), [['pull_request', 'push'], ['pull_request', 'push']]);
  ok('merged pull requests: #102 cost 2 runs for 2 commits, #101 cost 4 runs for 2 commits (push + pull_request on both), #104 has no run data and stays out of the mean; the unmerged one and the run from before #102 existed are not counted');
}

// ---- 2. other workflows, a date, exit codes -----------------------------------------------------------------------------------------------
{
  const all = (await asJson(['--fixture', FIXTURE, '--workflow', 'all'])).report;
  assert.deepEqual([all.windows[0].runs, all.windows[0].skipped, all.windows[0].failure], [15, 4, 3], 'all workflows on main: the release workflow adds 3 skipped runs');
  assert.equal(all.pullRequests.items.find((item) => item.number === 102).runs, 4, 'with DCO: 2 CI + 2 DCO runs');
  assert.equal(all.pullRequests.withRunData, 2);
  near(all.pullRequests.runsPerPullRequest, 5, 'runs per pull request, all workflows (4 and 6)');
  assert.equal(all.pullRequests.duplicatedCommits, 2, 'DCO runs once per commit and adds no duplicate');
  const dco = (await asJson(['--fixture', FIXTURE, '--workflow', 'DCO'])).report;
  assert.equal(dco.windows[0].runs, 0, 'DCO has no run on main in the fixture');
  assert.equal(dco.pullRequests.duplicatedCommits, 0);

  const since = (await asJson(['--fixture', FIXTURE, '--since', '2026-10-01'])).report;
  assert.deepEqual([since.pullRequests.pullRequests, since.pullRequests.withRunData], [2, 1]);
  near(since.pullRequests.runsPerPullRequest, 2, 'only #102 and #104 merged after 2026-10-01, and only #102 has run data');
  assert.equal(since.pullRequests.duplicatedCommits, 0);

  assert.equal((await cli(['--fixture', FIXTURE, '--max-failure-share', '0.5', '--max-duplicated-commits', '2'])).code, 0, 'limits that hold give exit 0');
  assert.equal((await cli(['--fixture', FIXTURE, '--max-failure-share', '0.5'])).code, 1, 'a commit built twice fails the gate');
  assert.equal((await cli(['--fixture', FIXTURE, '--since', '2026-10-01', '--max-failure-share', '0.2'])).code, 1, 'a failure share above the limit fails the gate');
  assert.equal((await cli(['--fixture', FIXTURE, '--since', '2026-10-01', '--max-failure-share', '0.34'])).code, 0, 'exactly at the limit passes');
  assert.equal((await cli(['--fixture', FIXTURE, '--branch', 'release', '--max-duplicated-commits', '5'])).code, 3, 'a branch with no decided run cannot be judged: exit 3 (a failing limit elsewhere would give 1)');
  assert.equal((await cli(['--fixture', FIXTURE, '--bogus'])).code, 2, 'unknown option: exit 2');
  assert.equal((await cli(['--fixture', path.join(os.tmpdir(), 'chatmcp-no-such-fixture.json')])).code, 2, 'unreadable fixture: exit 2');
  assert.equal((await cli(['--windows', '0'])).code, 2, 'a window of 0 is a usage error');
  ok('--workflow all / DCO, --since, and the exit codes 0 (limits hold), 1 (limit exceeded), 2 (usage), 3 (nothing to judge)');
}

// ---- 3. the 50 and 100 trailing windows with enough data ----------------------------------------------------------------------------------
{
  // Run i (0 = newest): cancelled when i%13==5; else failure when i<50 and i%4==3, or 50<=i<100 and i%10==0; else success.
  // Expected counts were derived with a separate script: window 50 = 35 success / 11 failure / 4 cancelled; window 100 = 77 / 15 / 8.
  const runs = [];
  for (let i = 0; i < 120; i += 1) {
    const conclusion = i % 13 === 5 ? 'cancelled' : i < 50 ? (i % 4 === 3 ? 'failure' : 'success') : i < 100 ? (i % 10 === 0 ? 'failure' : 'success') : 'success';
    runs.push({ databaseId: 9000 - i, workflowName: 'CI', name: 'CI', event: 'push', headBranch: 'main', headSha: String(i).padStart(40, '0'), status: 'completed', conclusion, createdAt: new Date(Date.UTC(2026, 9, 1) - i * 3_600_000).toISOString(), attempt: 1 });
  }
  // pull request runs on other branches must not leak into main's windows
  for (let i = 0; i < 30; i += 1) runs.push({ databaseId: 100 + i, workflowName: 'CI', name: 'CI', event: 'pull_request', headBranch: `feat/${i}`, headSha: `p${i}`.padEnd(40, '0'), status: 'completed', conclusion: 'failure', createdAt: new Date(Date.UTC(2026, 9, 1) - i * 1_000).toISOString(), attempt: 1 });
  const options = { workflow: 'CI', branch: 'main', windows: [50, 100], maxFailureShare: 0.15, maxDuplicatedCommits: 0 };
  const report = buildReport({ runs: runs.sort(() => 0), pulls: [] }, options);
  const [w50, w100] = report.windows;
  assert.deepEqual([w50.runs, w50.success, w50.failure, w50.cancelled, w50.windowFilled], [50, 35, 11, 4, true]);
  assert.deepEqual([w100.runs, w100.success, w100.failure, w100.cancelled, w100.windowFilled], [100, 77, 15, 8, true]);
  near(w50.failureShare, 11 / 46, 'window 50 share');
  near(w100.failureShare, 15 / 92, 'window 100 share');
  near(w100.failureShareOfCompleted, 0.15, 'window 100 share of completed (cancelled counted as completed)');
  assert.equal(report.exitCode, 1, 'both windows are above 15%');
  assert.equal(buildReport({ runs, pulls: [] }, { ...options, maxFailureShare: 0.2 }).exitCode, 1, 'window 50 is still above 20%');
  assert.equal(buildReport({ runs, pulls: [] }, { ...options, maxFailureShare: 0.25 }).exitCode, 0, 'both windows are below 25%');
  // the order of the input does not matter, and newest-first means the trailing runs, not the first 50 in the file
  const shuffled = [...runs].reverse();
  assert.deepEqual(buildReport({ runs: shuffled, pulls: [] }, options).windows.map((window) => [window.success, window.failure, window.cancelled]), [[35, 11, 4], [77, 15, 8]]);
  ok('50 and 100 trailing runs of main: 35/11/4 and 77/15/8 (success/failure/cancelled), shares 11/46 and 15/92; pull request runs on other branches and the input order do not matter');
}

// ---- 4. read-only, and gh missing ------------------------------------------------------------------------------------------------------------
{
  assert.deepEqual(GH_ALLOWED.map((pair) => pair.join(' ')).sort(), ['pr list', 'run list'], 'the allow-list is exactly "run list" and "pr list"');
  for (const kind of ['runs', 'pulls']) {
    const args = ghArguments(kind, { repo: 'example/chatmcp', branch: kind === 'runs' ? 'main' : null, limit: 100 });
    assert.ok(GH_ALLOWED.some(([a, b]) => args[0] === a && args[1] === b), `${kind}: ${args.slice(0, 2).join(' ')}`);
    for (const forbidden of ['delete', 'cancel', 'rerun', 'edit', 'create', 'merge', 'close', 'comment', 'api', '--method', '-X', 'POST', 'PATCH', 'PUT', 'DELETE']) assert.ok(!args.includes(forbidden), `gh ${args.slice(0, 2).join(' ')} must not carry ${forbidden}`);
  }
  assert.deepEqual(ghArguments('runs', { workflow: 'CI' }).slice(-2), ['--workflow', 'CI'], 'a workflow filter is passed to gh run list');
  assert.ok(!ghArguments('runs', { workflow: 'all' }).includes('--workflow'), '--workflow all asks gh for every workflow');
  for (const verb of [['run', 'cancel', '1'], ['run', 'rerun', '1'], ['run', 'delete', '1'], ['pr', 'merge', '1'], ['api', '-X', 'POST', '/repos/x/y'], ['workflow', 'run', 'ci.yml']]) {
    await assert.rejects(runGh(verb), /refusing to run gh/, `gh ${verb.join(' ')} must be refused before a process starts`);
  }
  const source = readFileSync(SCRIPT, 'utf8');
  assert.ok(!/\[\s*'(?:run|pr|api|workflow|release|issue)'\s*,\s*'(?!list')/.test(source.replace(/GH_ALLOWED = Object\.freeze\(\[\['run', 'list'\], \['pr', 'list'\]\]\)/, '')), 'no gh verb other than "list" appears in an argument array of the script');
  assert.ok(!/writeFile|appendFile|unlink|rmSync|rm\(/.test(source), 'the script writes no file');
  ok('read-only: the allow-list is "run list" and "pr list"; every argv built carries no mutating verb or method; a mutating gh command is refused before a process starts; the script writes no file');

  const bare = await cli([], { ...process.env, PATH: path.dirname(process.execPath) });
  assert.equal(bare.code, 2);
  assert.match(bare.stderr, /gh CLI is not installed|gh failed/, 'without gh the message says so and points at --fixture');
  ok('without the gh CLI the script stops with exit 2 and a message that names --fixture');
}

// a fixture written by a person (hand edits) is parsed the same way
{
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'chatmcp-ci-health-'));
  try {
    const file = path.join(scratch, 'minimal.json');
    writeFileSync(file, JSON.stringify({ runs: [{ databaseId: 1, workflowName: 'CI', event: 'push', headBranch: 'main', headSha: 'a'.repeat(40), status: 'completed', conclusion: 'success', createdAt: '2026-10-01T00:00:00Z' }], pulls: [] }));
    const { code, report } = await asJson(['--fixture', file, '--windows', '1,5']);
    assert.equal(code, 0);
    assert.deepEqual(report.windows.map((window) => [window.window, window.runs, window.windowFilled, window.failureShare]), [[1, 1, true, 0], [5, 1, false, 0]]);
    ok('a minimal fixture with one green run: share 0, a window of 5 is flagged as not filled, exit 0');
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

console.log(`PASS: ${checks} CI health checks (fixture arithmetic, windows, pull request cost, exit codes, read-only)`);
