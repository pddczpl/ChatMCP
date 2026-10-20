#!/usr/bin/env node
// Flaky-suite gate for main (docs/CI-HEALTH.md). `tests/run-all.mjs --retry-failed-once` runs a failed suite a second time; a suite that
// passes only the second time is labelled FLAKY (never PASS) in the summary JSON. One FLAKY run is allowed: that is what a retry is for. The
// same thing on three runs of main in a row is not an accident any more, so this gate fails the run.
//
//   node scripts/ci-flaky-gate.mjs --current <dir> [--repo owner/name] [--run-id N] [--workflow CI] [--branch main] [--limit 3] [--json]
//                                  [--previous-dir <dir>]
//
// <dir> holds the summary.json files of the jobs of one run, in any folder layout (`gh run download` writes one folder per artifact).
// The previous runs come from GitHub (`gh run list`, then `gh run download` of their `hub-test-summary-*` artifacts), or, for tests, from
// --previous-dir: one sub-folder per run, named by run id, newest = highest id. The script only READS GitHub (allow-list below); the
// artifacts are written to a temporary folder here.
//
// Definitions:
//   flaky run     a run whose summaries add up to more than 0 FLAKY suites. A summary written before the retry existed has no `flaky`
//                 field and counts as 0. A run with no readable summary (artifact expired, run cancelled before the upload) is UNKNOWN,
//                 and unknown ends a streak: this gate never fails on something it did not see.
//   streak        the current run plus the runs before it, newest first, as long as each is a flaky run.
//   verdict       fail when the current run is flaky and the streak has reached the limit (default 3).
//
// Exit code: 0 pass; 1 the streak reached the limit; 2 usage or gh error.
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, appendFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const GH_ALLOWED = Object.freeze([['run', 'list'], ['run', 'download']]);
export const DEFAULT_LIMIT = 3;

/** {flaky, suites} of one parsed summary.json; a summary without a `flaky` field is from a runner that could not retry. */
export function flakyOfSummary(summary) {
  const results = Array.isArray(summary?.results) ? summary.results : [];
  const names = results.filter((entry) => entry?.status === 'FLAKY').map((entry) => String(entry.name));
  const counted = Number.isInteger(summary?.summary?.flaky) ? summary.summary.flaky : 0;
  return { flaky: Math.max(counted, names.length), suites: names };
}

async function jsonFiles(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await jsonFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.json')) found.push(full);
  }
  return found;
}

/**
 * Add up the summaries below `directory`.
 * @returns {Promise<{files: number, flaky: number|null, suites: string[]}>} flaky is null when no summary could be read (unknown).
 */
export async function readRunSummaries(directory) {
  let files = [];
  try { files = await jsonFiles(directory); } catch { return { files: 0, flaky: null, suites: [] }; }
  let flaky = 0;
  let read = 0;
  const suites = new Set();
  for (const file of files) {
    let parsed;
    try { parsed = JSON.parse(await readFile(file, 'utf8')); } catch { continue; }
    if (!parsed || typeof parsed !== 'object' || !parsed.summary) continue;
    read += 1;
    const one = flakyOfSummary(parsed);
    flaky += one.flaky;
    for (const name of one.suites) suites.add(name);
  }
  return read === 0 ? { files: 0, flaky: null, suites: [] } : { files: read, flaky, suites: [...suites].sort() };
}

/**
 * @param {{flaky: number, suites?: string[]}} current
 * @param {Array<{id?: string|number, flaky: number|null, suites?: string[]}>} previous newest first; flaky null = unknown
 */
export function decideFlakyGate({ current, previous = [], limit = DEFAULT_LIMIT }) {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError('limit must be a positive whole number');
  const runs = [{ id: 'current', flaky: current.flaky, suites: current.suites ?? [] }, ...previous];
  let streak = 0;
  for (const run of runs) {
    if (!(Number.isInteger(run.flaky) && run.flaky > 0)) break;
    streak += 1;
  }
  const currentFlaky = Number.isInteger(current.flaky) && current.flaky > 0;
  const fail = currentFlaky && streak >= limit;
  const names = [...new Set(runs.slice(0, streak).flatMap((run) => run.suites ?? []))].sort();
  let message;
  if (!currentFlaky) message = 'No suite needed a retry in this run: the streak is 0.';
  else if (fail) message = `FLAKY suites in ${streak} runs of main in a row (limit ${limit})${names.length ? `: ${names.join(', ')}` : ''}. A retry hides a timing accident once; the same suite failing then passing on every run is a defect to fix, not to retry.`;
  else message = `${current.flaky} suite(s) passed only on retry in this run (streak ${streak} of ${limit})${names.length ? `: ${names.join(', ')}` : ''}. Fix them before the streak reaches ${limit}.`;
  return { fail, streak, limit, currentFlaky: current.flaky, suites: names, message };
}

function runGh(args) {
  return new Promise((resolve, reject) => {
    if (!GH_ALLOWED.some(([a, b]) => args[0] === a && args[1] === b)) { reject(new Error(`refusing to run gh ${args.slice(0, 2).join(' ')}`)); return; }
    execFile('gh', args, { maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) { reject(Object.assign(new Error(error.code === 'ENOENT' ? 'the gh CLI is not installed or not on PATH' : `gh failed: ${String(stderr || error.message).trim().split('\n')[0]}`), { code: error.code, stderr: String(stderr || '') })); return; }
      resolve(stdout);
    });
  });
}

/** Completed runs of the workflow on the branch (push events), newest first, without `exceptRunId`; success and failure only. */
export async function previousRunIds({ repo, workflow, branch, exceptRunId, count, run = runGh }) {
  const out = await run(['run', 'list', '--repo', repo, '--workflow', workflow, '--branch', branch, '--event', 'push', '--status', 'completed', '--limit', '40', '--json', 'databaseId,conclusion,createdAt']);
  const rows = JSON.parse(out);
  return rows
    .filter((row) => ['success', 'failure'].includes(row.conclusion) && String(row.databaseId) !== String(exceptRunId ?? ''))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, count)
    .map((row) => row.databaseId);
}

function parseArguments(argv) {
  const options = { current: null, repo: process.env.GITHUB_REPOSITORY ?? null, runId: process.env.GITHUB_RUN_ID ?? null, workflow: 'CI', branch: 'main', limit: DEFAULT_LIMIT, json: false, previousDir: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => { const next = argv[++i]; if (next === undefined) throw new Error(`${arg} requires a value`); return next; };
    if (arg === '--current') options.current = value();
    else if (arg === '--repo') options.repo = value();
    else if (arg === '--run-id') options.runId = value();
    else if (arg === '--workflow') options.workflow = value();
    else if (arg === '--branch') options.branch = value();
    else if (arg === '--limit') { options.limit = Number(value()); if (!Number.isInteger(options.limit) || options.limit < 1) throw new Error('--limit must be a positive whole number'); }
    else if (arg === '--previous-dir') options.previousDir = value();
    else if (arg === '--json') options.json = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!options.current) throw new Error('--current <dir> is required');
  if (!options.previousDir && !options.repo) throw new Error('--repo owner/name (or GITHUB_REPOSITORY) is required to read the previous runs');
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try { options = parseArguments(argv); } catch (error) { console.error(error.message); return 2; }
  const needed = options.limit - 1;
  const previous = [];
  let scratch = null;
  try {
    const current = await readRunSummaries(options.current);
    if (current.files === 0) { console.error(`No summary.json found below ${options.current}`); return 2; }
    if (options.previousDir) {
      const folders = (await readdir(options.previousDir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
        .sort((a, b) => Number(b) - Number(a) || b.localeCompare(a)).slice(0, needed);
      for (const id of folders) previous.push({ id, ...await readRunSummaries(path.join(options.previousDir, id)) });
    } else if (needed > 0) {
      scratch = await mkdtemp(path.join(os.tmpdir(), 'chatmcp-flaky-gate-'));
      for (const id of await previousRunIds({ repo: options.repo, workflow: options.workflow, branch: options.branch, exceptRunId: options.runId, count: needed })) {
        const target = path.join(scratch, String(id));
        try { await runGh(['run', 'download', String(id), '--repo', options.repo, '--pattern', 'hub-test-summary-*', '--dir', target]); } catch { /* expired or never uploaded: unknown */ }
        previous.push({ id, ...await readRunSummaries(target) });
      }
    }
    const verdict = decideFlakyGate({ current: { flaky: current.flaky, suites: current.suites }, previous, limit: options.limit });
    const report = { ...verdict, current: { files: current.files, flaky: current.flaky }, previous: previous.map((run) => ({ id: run.id, files: run.files, flaky: run.flaky })) };
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`Flaky gate - branch ${options.branch}, limit ${options.limit} runs in a row`);
      console.log(`  this run   : ${current.flaky} FLAKY suite(s) in ${current.files} summaries`);
      for (const run of previous) console.log(`  run ${String(run.id).padEnd(12)}: ${run.flaky === null ? 'unknown (no summaries)' : `${run.flaky} FLAKY suite(s) in ${run.files} summaries`}`);
      console.log(`${verdict.fail ? 'FAIL' : 'OK'}: ${verdict.message}`);
    }
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `### Flaky suites on main\n\n${verdict.message}\n`).catch(() => {});
    return verdict.fail ? 1 : 0;
  } catch (error) {
    console.error(error.message);
    return 2;
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main();
