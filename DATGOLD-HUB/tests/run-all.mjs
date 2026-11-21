#!/usr/bin/env node
// Unified test runner for ChatMCP Hub.
//
// Runs every tests/verify-*.mjs suite in its own Node process, enforces a
// per-suite timeout and prints a table that contains the REAL exit code of
// each suite. Python UI suites (tests/verify-*.py) need Playwright + Chromium
// and are opt-in (--python).
//
// Usage:
//   node tests/run-all.mjs [--list] [--filter text] [--bail] [--verbose]
//                          [--timeout seconds] [--python] [--json file]
//                          [--no-skip all|name[,name...]] [--tests-dir dir]
//                          [--retry-failed-once] [--fail-on-flaky] [--shard i/n]
//
// A suite that cannot run in the current environment may print a line that
// starts with "CHATMCP_TEST_SKIP:" followed by the reason and exit with 0.
// The runner then reports it as SKIP (never as PASS).
//
// --no-skip is for CI, where the job has installed everything the suites need:
// a SKIP of the named suites (or of any suite, with "all") is then reported as
// FAIL, so a green run cannot hide a suite that never ran.
// --tests-dir runs the verify-*.mjs / verify-*.py files of another folder; it
// exists so that the runner itself can be tested (tests/verify-test-runner.mjs).
//
// --retry-failed-once runs a suite that FAILED or TIMED OUT a second time. A suite that passes the second time is reported as FLAKY: not
// PASS (it did not pass cleanly), not FAIL (it passed), counted on its own in the summary and in the JSON, with both attempts and the
// output of the first one kept. A suite that fails both times stays FAIL (or TIMEOUT); one that skips the second time stays FAIL, because
// a skip never turns a failure into anything else. A suite that passes is never run twice. One FLAKY suite does not fail the run (that is
// what the retry is for); the same thing on several runs in a row does, and scripts/ci-flaky-gate.mjs decides that across runs on main.
// --fail-on-flaky makes any FLAKY suite fail this run (exit 1), for local use where nothing should need a retry.
// On GitHub Actions each FLAKY suite is also a ::warning annotation and a line in the step summary.
//
// --shard i/n (1 <= i <= n) runs the i-th of n parts of the suite list, so that CI can spread one OS and Node version over n jobs
// (docs/CI-HEALTH.md). The split depends only on the list of suites (with --python, the Python ones too) and on tests/shard-weights.json
// in the tests folder, never on the machine, the filter or the order of the folder, so every job computes the same parts, and the n parts
// together are the whole list, each suite in exactly one. The rule: the suites the weights file lists (its "seconds", measured on the
// Windows runners), heaviest first and by name among equals, each go to the shard with the least weight so far (the lower number among
// equals); then the suites it does not list, by name, the same way, each weighing the mean of the listed ones. Without the file every suite
// weighs the same and the parts differ by at most one suite. A suite added later never moves a listed one. --filter picks from the shard after
// the split; --list prints the shard; the --json summary records it as summary.shard = {index, count, suites, of}.
//
// Exit code: 0 when no suite failed or timed out, 1 otherwise, 2 for usage
// errors.

import { spawn } from 'node:child_process';
import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ownDirectory = path.dirname(fileURLToPath(import.meta.url));
const hubRoot = path.resolve(ownDirectory, '..');
// How much of the end of a suite's output is kept, and shown when the suite fails. The words that differ in a long assertion stand at the top of Node's report and of each value it
// dumps, a few thousand characters above the end, so this is more than the report of the longest assertion the suites make.
const TAIL_LIMIT = 12_000;
// The measured seconds per suite that --shard balances by; it lives next to the suites it describes.
const SHARD_WEIGHTS_FILE = 'shard-weights.json';
const MAX_SHARDS = 100;

/** "i/n" -> {index: i, count: n}; anything else is a usage error. */
function parseShard(text) {
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(text);
  if (!match || Number(match[1]) > Number(match[2]) || Number(match[2]) > MAX_SHARDS) throw new Error(`--shard needs i/n with 1 <= i <= n <= ${MAX_SHARDS} (for example 1/2), not "${text}"`);
  return { index: Number(match[1]), count: Number(match[2]) };
}

function parseOptions(argv) {
  const options = { list: false, filter: '', bail: false, verbose: false, timeoutSeconds: 180, python: false, json: '', noSkip: null, testsDirectory: ownDirectory, retryFailedOnce: false, failOnFlaky: false, shard: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} requires a value`);
      return next;
    };
    if (arg === '--list') options.list = true;
    else if (arg === '--bail') options.bail = true;
    else if (arg === '--verbose') options.verbose = true;
    else if (arg === '--python') options.python = true;
    else if (arg === '--retry-failed-once') options.retryFailedOnce = true;
    else if (arg === '--fail-on-flaky') options.failOnFlaky = true;
    else if (arg === '--filter') options.filter = value().toLowerCase();
    else if (arg === '--json') options.json = value();
    else if (arg === '--tests-dir') options.testsDirectory = path.resolve(value());
    else if (arg === '--shard') options.shard = parseShard(value());
    else if (arg === '--no-skip') {
      const names = value().split(',').map((name) => name.trim().toLowerCase().replace(/\.(mjs|py)$/, '')).filter(Boolean);
      if (names.length === 0) throw new Error('--no-skip needs "all" or a comma-separated list of suite names');
      options.noSkip = names.includes('all') ? 'all' : new Set(names);
    }
    else if (arg === '--timeout') {
      options.timeoutSeconds = Number(value());
      if (!Number.isFinite(options.timeoutSeconds) || options.timeoutSeconds < 1) throw new Error('--timeout must be a positive number of seconds');
    } else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

/** True when a SKIP of this suite must be reported as a failure (--no-skip). */
function mustRun(options, name) {
  if (options.noSkip === null) return false;
  return options.noSkip === 'all' || options.noSkip.has(name.toLowerCase().replace(/\.(mjs|py)$/, ''));
}

/** Code-unit order: the same on every machine and locale. */
const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The weights file as a Map of suite name -> whole milliseconds (whole numbers, so that every machine adds them up to the same totals and
 * breaks the same ties). A missing file is an empty Map (every suite then weighs the same); a file that is there but wrong is an error.
 */
async function readShardWeights(file) {
  let text;
  try { text = await readFile(file, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return new Map();
    throw new Error(`${file} could not be read: ${error.message}`);
  }
  let parsed;
  try { parsed = JSON.parse(text); } catch (error) { throw new Error(`${file} is not JSON: ${error.message}`); }
  const seconds = parsed?.seconds;
  if (!seconds || typeof seconds !== 'object' || Array.isArray(seconds)) throw new Error(`${file} must hold {"seconds": {"verify-name.mjs": <seconds>, ...}}`);
  const weights = new Map();
  for (const [name, value] of Object.entries(seconds)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${file}: the seconds of ${name} must be a number >= 0, not ${JSON.stringify(value)}`);
    weights.set(name, Math.round(value * 1000));
  }
  return weights;
}

/** Split `names` into `count` lists by the rule in the header of this file; each list in name order. */
function splitIntoShards(names, weights, count) {
  const listed = names.filter((name) => weights.has(name));
  const unlisted = names.filter((name) => !weights.has(name));
  const mean = listed.length === 0 ? 1 : Math.round(listed.reduce((sum, name) => sum + weights.get(name), 0) / listed.length);
  const shards = Array.from({ length: count }, () => ({ weight: 0, names: [] }));
  const place = (name, weight) => {
    let lightest = 0;
    for (let i = 1; i < count; i++) if (shards[i].weight < shards[lightest].weight) lightest = i;
    shards[lightest].weight += weight;
    shards[lightest].names.push(name);
  };
  for (const name of [...listed].sort((a, b) => weights.get(b) - weights.get(a) || byName(a, b))) place(name, weights.get(name));
  for (const name of [...unlisted].sort(byName)) place(name, mean);
  return shards.map((shard) => shard.names.sort(byName));
}

/** The suites this run takes (its shard, then the filter) and, with --shard, what the summary records about the shard. */
async function discover(options) {
  const files = (await readdir(options.testsDirectory)).filter((name) => /^verify-.+\.mjs$/.test(name) || (options.python && /^verify-.+\.py$/.test(name))).sort();
  let chosen = files;
  let shard = null;
  if (options.shard) {
    const weights = await readShardWeights(path.join(options.testsDirectory, SHARD_WEIGHTS_FILE));
    chosen = splitIntoShards(files, weights, options.shard.count)[options.shard.index - 1];
    shard = { index: options.shard.index, count: options.shard.count, suites: chosen.length, of: files.length };
  }
  return { suites: chosen.filter((name) => !options.filter || name.toLowerCase().includes(options.filter)), shard };
}

function killTree(child) {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => child.kill('SIGKILL'));
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
}

function runSuite(name, options) {
  return new Promise((resolve) => {
    const started = Date.now();
    const isPython = name.endsWith('.py');
    const command = isPython ? (process.platform === 'win32' ? 'python' : 'python3') : process.execPath;
    const childEnv = { ...process.env, CHATMCP_TEST_RUNNER: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
    delete childEnv.CHATMCP_PUBLIC;
    delete childEnv.CHATMCP_EXEC_MODE;
    const child = spawn(command, [path.join(options.testsDirectory, name)], {
      cwd: hubRoot,
      // UTF-8 for Python children: on Windows a piped stdout defaults to cp1252 and cannot print the Vietnamese UI text.
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    let output = '';
    let timedOut = false;
    const collect = (chunk) => {
      const text = chunk.toString('utf8');
      if (options.verbose) process.stdout.write(text);
      output += text;
      if (output.length > TAIL_LIMIT * 2) output = output.slice(-TAIL_LIMIT * 2);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, options.timeoutSeconds * 1000);
    const finish = (code, signal, error) => {
      clearTimeout(timer);
      const milliseconds = Date.now() - started;
      let status;
      let note = '';
      if (error) { status = 'FAIL'; note = `could not start: ${error.message}`; }
      else if (timedOut) { status = 'TIMEOUT'; note = `killed after ${options.timeoutSeconds}s`; }
      else if (code === 0) {
        const skip = output.match(/^CHATMCP_TEST_SKIP:\s*(.*)$/m);
        if (skip && mustRun(options, name)) { status = 'FAIL'; note = `skipped (${skip[1].trim()}), but --no-skip requires this suite to run`; }
        else if (skip) { status = 'SKIP'; note = skip[1].trim(); }
        else status = 'PASS';
      } else { status = 'FAIL'; note = signal ? `signal ${signal}` : `exit ${code}`; }
      resolve({ name, status, code: timedOut ? null : code, note, milliseconds, tail: output.slice(-TAIL_LIMIT) });
    };
    child.on('error', (error) => finish(null, null, error));
    child.on('close', (code, signal) => finish(code, signal, null));
  });
}

/** Run a suite; with --retry-failed-once a FAIL or TIMEOUT gets exactly one more attempt, and the outcome says how the two went. */
async function runWithRetry(name, options) {
  const first = await runSuite(name, options);
  if (!options.retryFailedOnce || (first.status !== 'FAIL' && first.status !== 'TIMEOUT')) return first;
  const second = await runSuite(name, options);
  const attempts = [first, second].map(({ status, code, note, milliseconds, tail }) => ({ status, code, note, milliseconds, tail }));
  const milliseconds = first.milliseconds + second.milliseconds;
  if (second.status === 'PASS') {
    // The tail shown for a FLAKY suite is the one of the attempt that failed: the evidence of a flake is what the failure said.
    return { ...second, status: 'FLAKY', note: `failed once (${first.note}) and passed on retry`, milliseconds, attempts, tail: first.tail };
  }
  if (second.status === 'SKIP') {
    return { ...second, status: 'FAIL', code: first.code, note: `failed (${first.note}), then skipped on retry (${second.note}); a skip never rescues a failure`, milliseconds, attempts, tail: first.tail };
  }
  return { ...second, note: `failed twice (first: ${first.note}; retry: ${second.note})`, milliseconds, attempts };
}

/** GitHub workflow commands take %, CR and LF escaped. */
const escapeCommand = (text) => String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

function pad(text, width) { return text.length >= width ? text : text + ' '.repeat(width - text.length); }

/**
 * The lines of a failing suite's tail that the log shows: all of them. The log of a CI run is what is left of a failure that happens once in a hundred runs; the last 25 lines,
 * which were all that was printed, ended inside the second value of a long assertion and left out the words that differ. The tail is already bounded (TAIL_LIMIT characters), so
 * showing it whole keeps the log short. When the suite printed more than that, the cut falls inside a line, and that half line is left out.
 */
function shownLines(tail) {
  const lines = tail.trimEnd().split(/\r?\n/);
  return tail.length >= TAIL_LIMIT && lines.length > 1 ? lines.slice(1) : lines;
}

async function main() {
  let options;
  try { options = parseOptions(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exit(2); }
  let suites;
  let shard;
  try { ({ suites, shard } = await discover(options)); } catch (error) { console.error(error.message); return 2; }
  if (options.list) { for (const name of suites) console.log(name); return 0; }
  const shardText = shard ? `shard ${shard.index}/${shard.count} of ${shard.of}` : '';
  if (suites.length === 0) { console.error(`No test suites matched${shard ? ` in ${shardText} (it holds ${shard.suites})` : ''}.`); return 2; }

  console.log(`ChatMCP Hub test runner - node ${process.version} on ${process.platform}/${process.arch} - ${suites.length} suite(s)${shard ? `, ${shardText}` : ''}`);
  const results = [];
  for (const name of suites) {
    const result = await runWithRetry(name, options);
    results.push(result);
    console.log(`${pad(result.status, 8)}${pad(name, 46)}${pad(`${(result.milliseconds / 1000).toFixed(1)}s`, 8)}${result.note}`);
    // A FLAKY suite prints what its first attempt said: a flake is only worth anything if somebody can read why it failed.
    if ((result.status === 'FAIL' || result.status === 'TIMEOUT' || result.status === 'FLAKY') && !options.verbose) {
      for (const line of shownLines(result.tail)) console.log(`    | ${line}`);
    }
    if (options.bail && (result.status === 'FAIL' || result.status === 'TIMEOUT')) break;
  }

  const count = (status) => results.filter((r) => r.status === status).length;
  const summary = { node: process.version, platform: process.platform, arch: process.arch, total: results.length, pass: count('PASS'), fail: count('FAIL'), timeout: count('TIMEOUT'), skip: count('SKIP'), flaky: count('FLAKY'), shard };
  console.log(`\nSUMMARY: ${summary.pass} pass, ${summary.fail} fail, ${summary.timeout} timeout, ${summary.skip} skip, ${summary.flaky} flaky (of ${summary.total} suites run${shard ? `; ${shardText}` : ''})`);
  const flaky = results.filter((r) => r.status === 'FLAKY');
  if (flaky.length) {
    console.log(`\nFLAKY - passed only on the second attempt, so NOT counted as pass: ${flaky.map((r) => r.name).join(', ')}`);
    if (process.env.GITHUB_ACTIONS === 'true') {
      for (const r of flaky) console.log(`::warning title=FLAKY suite::${escapeCommand(`${r.name} ${r.note}`)}`);
      if (process.env.GITHUB_STEP_SUMMARY) {
        const lines = ['### FLAKY suites (failed, then passed on retry)', '', '| Suite | First attempt | Retry |', '| --- | --- | --- |',
          ...flaky.map((r) => `| ${r.name} | ${r.attempts[0].note} | ${r.attempts[1].note || 'passed'} |`), ''];
        await appendFile(process.env.GITHUB_STEP_SUMMARY, lines.join('\n')).catch(() => {});
      }
    }
  }
  if (options.json) {
    await mkdir(path.dirname(path.resolve(options.json)), { recursive: true });
    // The attempts keep their own tail (the output of the failed attempt); the top-level tail was never part of the report.
    await writeFile(options.json, JSON.stringify({ summary, results: results.map(({ tail, ...rest }) => rest) }, null, 2) + '\n');
  }
  return summary.fail + summary.timeout === 0 && !(options.failOnFlaky && summary.flaky > 0) ? 0 : 1;
}

process.exitCode = await main();
