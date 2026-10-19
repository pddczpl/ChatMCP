#!/usr/bin/env node
// CI health report for the phase-P0 gate (docs/CI-HEALTH.md): how often does CI fail on main, and how many runs does one pull request cost?
//
//   node scripts/ci-health.mjs [--repo owner/name] [--workflow CI|all] [--branch main] [--windows 50,100] [--limit 500] [--prs 30]
//                              [--since 2026-11-01] [--max-failure-share 0.15] [--json] [--fixture file.json]
//
// It only READS: it runs `gh run list` and `gh pr list` (the allow-list below is enforced before anything is started) and prints
//   * success / failure / cancelled / skipped / other counts of the trailing 50 and 100 runs on main, separately;
//   * the failure share of the COMPLETED runs on main (definition below);
//   * the runs a merged pull request cost, the commits that were built more than once by the same workflow, and per pull request.
// `--fixture` reads the output of those two commands from a JSON file ({"runs": [...], "pulls": [...]}) instead of calling gh, which is how
// tests/verify-ci-health.mjs checks the arithmetic offline.
//
// Definitions (the numbers a gate is judged by, so they are fixed here and repeated in the report):
//   window       the N most recent runs of the workflow on the branch (event pull_request excluded), newest first, whatever their status;
//                fewer than N runs is reported as such, never padded.
//   completed    status "completed". Queued and in-progress runs are counted separately and are not part of any share.
//   failure      conclusion failure, timed_out or startup_failure.
//   decided      success + failure. Cancelled (superseded or stopped by a person), skipped, neutral, stale and action_required runs say
//                nothing about the health of the code and are reported on their own.
//   failure share  failure / decided. The share of all completed runs (failure / completed) is printed beside it.
//   runs per merged PR  runs of the workflow whose head branch is the pull request's branch and that started between the pull request's
//                creation and its merge, any event; "built twice" = two runs of the same workflow for the same commit.
// A re-run keeps its run id (attempt 2), so a failure that a re-run turned green shows as success here; the count of such runs is printed.
//
// Exit code: 0 all limits hold; 1 a limit is exceeded (failure share, or a commit built twice); 2 usage or gh error; 3 not enough data.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

/** Every gh invocation this script may make. Anything else is refused before a process starts. */
export const GH_ALLOWED = Object.freeze([['run', 'list'], ['pr', 'list']]);
export const RUN_FIELDS = 'databaseId,workflowName,name,event,headBranch,headSha,status,conclusion,createdAt,updatedAt,attempt,url,displayTitle';
export const PR_FIELDS = 'number,title,headRefName,headRefOid,baseRefName,createdAt,mergedAt,url';

const FAILURES = new Set(['failure', 'timed_out', 'startup_failure']);

/** argv for gh, checked against the allow-list. */
export function ghArguments(kind, { repo = null, branch = null, limit = 500, state = 'merged', workflow = null } = {}) {
  const base = kind === 'runs'
    ? ['run', 'list', '--limit', String(limit), '--json', RUN_FIELDS]
    : ['pr', 'list', '--state', state, '--limit', String(limit), '--json', PR_FIELDS];
  if (kind === 'runs' && branch) base.push('--branch', branch);
  if (kind === 'runs' && workflow && workflow !== 'all') base.push('--workflow', workflow);
  if (repo) base.push('--repo', repo);
  if (!GH_ALLOWED.some(([a, b]) => base[0] === a && base[1] === b)) throw new Error(`gh ${base.slice(0, 2).join(' ')} is not on the read-only allow-list`);
  return base;
}

export function runGh(args) {
  return new Promise((resolve, reject) => {
    if (!GH_ALLOWED.some(([a, b]) => args[0] === a && args[1] === b)) { reject(new Error(`refusing to run gh ${args.slice(0, 2).join(' ')}`)); return; }
    execFile('gh', args, { maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) { reject(Object.assign(new Error(error.code === 'ENOENT' ? 'the gh CLI is not installed or not on PATH (https://cli.github.com), or use --fixture' : `gh failed: ${String(stderr || error.message).trim().split('\n')[0]}`), { usage: true })); return; }
      try { resolve(JSON.parse(stdout)); } catch (parseError) { reject(new Error(`gh returned text that is not JSON: ${parseError.message}`)); }
    });
  });
}

const selects = (run, workflow) => workflow === 'all' || run.workflowName === workflow || run.name === workflow;

/** Counts of one list of runs. */
export function tally(runs) {
  const counts = { runs: runs.length, completed: 0, success: 0, failure: 0, cancelled: 0, skipped: 0, other: 0, notCompleted: 0, rerun: 0, byConclusion: {} };
  for (const run of runs) {
    if ((run.attempt ?? 1) > 1) counts.rerun += 1;
    if (run.status !== 'completed') { counts.notCompleted += 1; continue; }
    counts.completed += 1;
    const conclusion = run.conclusion || 'unknown';
    counts.byConclusion[conclusion] = (counts.byConclusion[conclusion] ?? 0) + 1;
    if (conclusion === 'success') counts.success += 1;
    else if (FAILURES.has(conclusion)) counts.failure += 1;
    else if (conclusion === 'cancelled') counts.cancelled += 1;
    else if (conclusion === 'skipped') counts.skipped += 1;
    else counts.other += 1;
  }
  counts.decided = counts.success + counts.failure;
  counts.failureShare = counts.decided > 0 ? counts.failure / counts.decided : null;
  counts.failureShareOfCompleted = counts.completed > 0 ? counts.failure / counts.completed : null;
  return counts;
}

/** The trailing windows on the branch. */
export function branchWindows(runs, { workflow = 'CI', branch = 'main', windows = [50, 100] } = {}) {
  const onBranch = runs
    .filter((run) => selects(run, workflow) && run.headBranch === branch && run.event !== 'pull_request')
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return windows.map((size) => {
    const slice = onBranch.slice(0, size);
    return { window: size, available: onBranch.length, windowFilled: onBranch.length >= size, ...tally(slice) };
  });
}

/** What a merged pull request cost. */
export function pullRequestCosts(pulls, runs, { workflow = 'CI', since = null } = {}) {
  const wanted = pulls.filter((pull) => pull.mergedAt && (!since || Date.parse(pull.mergedAt) >= Date.parse(since)))
    .sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt));
  const items = wanted.map((pull) => {
    const created = Date.parse(pull.createdAt);
    const merged = Date.parse(pull.mergedAt);
    const mine = runs.filter((run) => selects(run, workflow) && run.headBranch === pull.headRefName
      && Date.parse(run.createdAt) >= created && Date.parse(run.createdAt) <= merged);
    const perCommit = new Map();
    for (const run of mine) {
      const key = `${run.workflowName ?? run.name} ${run.headSha}`;
      const entry = perCommit.get(key) ?? { workflow: run.workflowName ?? run.name, sha: run.headSha, runs: 0, events: new Set() };
      entry.runs += 1; entry.events.add(run.event);
      perCommit.set(key, entry);
    }
    const duplicated = [...perCommit.values()].filter((entry) => entry.runs > 1);
    return {
      number: pull.number, branch: pull.headRefName, runs: mine.length, hasRunData: mine.length > 0, commits: new Set(mine.map((run) => run.headSha)).size,
      maxRunsPerCommitAndWorkflow: Math.max(0, ...[...perCommit.values()].map((entry) => entry.runs)),
      duplicated: duplicated.map((entry) => ({ workflow: entry.workflow, sha: entry.sha, runs: entry.runs, events: [...entry.events].sort() })),
    };
  });
  // A pull request with no run in the fetched history is "no data" (its runs may be older than what gh returned), not "zero runs".
  const withData = items.filter((item) => item.hasRunData);
  const total = withData.reduce((sum, item) => sum + item.runs, 0);
  return {
    pullRequests: items.length,
    withRunData: withData.length,
    withoutRunData: items.length - withData.length,
    runsPerPullRequest: withData.length ? total / withData.length : null,
    duplicatedCommits: items.reduce((sum, item) => sum + item.duplicated.length, 0),
    items,
  };
}

const percent = (value) => (value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`);

export function formatReport(report) {
  const lines = [];
  lines.push(`CI health - workflow ${report.options.workflow} - branch ${report.options.branch}${report.options.repo ? ` - ${report.options.repo}` : ''}${report.options.fixture ? ' - FIXTURE DATA' : ''}`);
  lines.push('');
  lines.push('window  runs  completed  success  failure  cancelled  skipped  other  not done  failure share (of success+failure)  of completed');
  for (const w of report.windows) {
    lines.push(`${String(w.window).padStart(6)}  ${String(w.runs).padStart(4)}  ${String(w.completed).padStart(9)}  ${String(w.success).padStart(7)}  ${String(w.failure).padStart(7)}  ${String(w.cancelled).padStart(9)}  ${String(w.skipped).padStart(7)}  ${String(w.other).padStart(5)}  ${String(w.notCompleted).padStart(8)}  ${percent(w.failureShare).padStart(34)}  ${percent(w.failureShareOfCompleted).padStart(12)}`
      + (w.windowFilled ? '' : `   (only ${w.available} runs exist)`)
      + (w.rerun ? `   (${w.rerun} re-run)` : ''));
  }
  lines.push('');
  const costs = report.pullRequests;
  if (costs.pullRequests === 0) lines.push('Merged pull requests: none in the data.');
  else {
    lines.push(`Merged pull requests: ${costs.pullRequests}, ${costs.withRunData} with run data${costs.withoutRunData ? ` (${costs.withoutRunData} without: their runs are not in the fetched history)` : ''}; runs per pull request ${costs.runsPerPullRequest === null ? 'n/a' : costs.runsPerPullRequest.toFixed(2)}; commits built more than once by the same workflow: ${costs.duplicatedCommits}`);
    for (const item of costs.items.filter((entry) => entry.hasRunData)) {
      lines.push(`  #${item.number} ${item.branch}: ${item.runs} run(s), ${item.commits} commit(s), at most ${item.maxRunsPerCommitAndWorkflow} per commit and workflow${item.duplicated.length ? ` - ${item.duplicated.length} commit(s) BUILT TWICE (${[...new Set(item.duplicated.map((d) => d.events.join('+')))].join(', ')}): ${item.duplicated.slice(0, 2).map((d) => `${d.workflow} ${String(d.sha).slice(0, 7)}`).join(', ')}${item.duplicated.length > 2 ? ', ...' : ''}` : ''}`);
    }
  }
  lines.push('');
  for (const check of report.checks) lines.push(`${check.status.padEnd(4)} ${check.text}`);
  lines.push('');
  lines.push('Failure = failure, timed_out or startup_failure. Cancelled, skipped, neutral and stale runs are outside the share. See docs/CI-HEALTH.md.');
  return lines.join('\n');
}

export function evaluate(report, { maxFailureShare = 0.15, maxDuplicatedCommits = 0 } = {}) {
  const checks = [];
  let exit = 0;
  for (const w of report.windows) {
    if (w.failureShare === null) { checks.push({ status: 'N/A', text: `last ${w.window} runs on ${report.options.branch}: no decided run, no failure share` }); exit = exit || 3; continue; }
    const pass = w.failureShare <= maxFailureShare;
    checks.push({ status: pass ? 'PASS' : 'FAIL', text: `last ${w.window} runs on ${report.options.branch}: failure share ${percent(w.failureShare)} (${w.failure} of ${w.decided}) <= ${percent(maxFailureShare)}${w.windowFilled ? '' : `; only ${w.available} runs exist`}` });
    if (!pass) exit = 1;
  }
  const costs = report.pullRequests;
  const duplicatePass = costs.duplicatedCommits <= maxDuplicatedCommits;
  checks.push({ status: costs.withRunData === 0 ? 'N/A' : duplicatePass ? 'PASS' : 'FAIL', text: `commits built more than once by the same workflow: ${costs.duplicatedCommits} (limit ${maxDuplicatedCommits}) over ${costs.withRunData} merged pull request(s) with run data` });
  if (costs.withRunData > 0 && !duplicatePass) exit = 1;
  return { checks, exit };
}

export function buildReport({ runs, pulls }, options) {
  const report = {
    options,
    windows: branchWindows(runs, options),
    pullRequests: pullRequestCosts(pulls, runs, options),
  };
  const verdict = evaluate(report, options);
  report.checks = verdict.checks;
  report.exitCode = verdict.exit;
  return report;
}

function parseOptions(argv) {
  const options = { repo: null, workflow: 'CI', branch: 'main', windows: [50, 100], limit: 500, prs: 30, since: null, maxFailureShare: 0.15, maxDuplicatedCommits: 0, json: false, fixture: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => { const next = argv[index += 1]; if (next === undefined) throw Object.assign(new Error(`${arg} needs a value`), { usage: true }); return next; };
    if (arg === '--repo') options.repo = value();
    else if (arg === '--workflow') options.workflow = value();
    else if (arg === '--branch') options.branch = value();
    else if (arg === '--windows') options.windows = value().split(',').map(Number);
    else if (arg === '--limit') options.limit = Number(value());
    else if (arg === '--prs') options.prs = Number(value());
    else if (arg === '--since') options.since = value();
    else if (arg === '--max-failure-share') options.maxFailureShare = Number(value());
    else if (arg === '--max-duplicated-commits') options.maxDuplicatedCommits = Number(value());
    else if (arg === '--fixture') options.fixture = value();
    else if (arg === '--json') options.json = true;
    else throw Object.assign(new Error(`unknown option ${arg}`), { usage: true });
  }
  if (options.windows.some((size) => !Number.isInteger(size) || size < 1)) throw Object.assign(new Error('--windows needs positive integers'), { usage: true });
  if (![options.limit, options.prs, options.maxFailureShare].every(Number.isFinite)) throw Object.assign(new Error('--limit, --prs and --max-failure-share need numbers'), { usage: true });
  if (options.since && Number.isNaN(Date.parse(options.since))) throw Object.assign(new Error('--since needs a date'), { usage: true });
  return options;
}

async function main(argv) {
  let options;
  try { options = parseOptions(argv); } catch (error) { console.error(`ci-health: ${error.message}`); return 2; }
  try {
    let data;
    if (options.fixture) {
      data = JSON.parse(await readFile(path.resolve(options.fixture), 'utf8'));
      if (!Array.isArray(data.runs) || !Array.isArray(data.pulls)) throw Object.assign(new Error('a fixture needs "runs" and "pulls" arrays'), { usage: true });
    } else {
      // Two reads of the runs: the branch alone (pull request runs would crowd main out of one list) and everything recent (for the cost of pull requests).
      const [onBranch, recent, pulls] = await Promise.all([
        runGh(ghArguments('runs', { repo: options.repo, branch: options.branch, limit: Math.max(...options.windows), workflow: options.workflow })),
        runGh(ghArguments('runs', { repo: options.repo, limit: options.limit, workflow: options.workflow })),
        runGh(ghArguments('pulls', { repo: options.repo, limit: options.prs })),
      ]);
      const byId = new Map();
      for (const run of [...onBranch, ...recent]) byId.set(run.databaseId, run);
      data = { runs: [...byId.values()], pulls };
    }
    const report = buildReport(data, options);
    console.log(options.json ? JSON.stringify(report, null, 2) : formatReport(report));
    return report.exitCode;
  } catch (error) {
    console.error(`ci-health: ${error.message}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main(process.argv.slice(2));
