#!/usr/bin/env node
// Checks that the sharded Hub run of a release ran every suite of the commit exactly once and that every one passed.
//
// The release workflow (.github/workflows/release.yml) runs the Hub suites in several Windows jobs (hub-tests, `run-all.mjs --no-skip all
// --shard i/n`), each of which uploads its evidence under a name ending in "-shard<i>". Its `verify` job, which also runs in a dry run and
// which the publish job waits for, downloads all of it and runs this script on the checkout of the same commit:
//
//   gh run download <run id> --pattern '<prefix>-hub-evidence-shard*' --dir <dir>      (one folder per shard)
//   node scripts/verify-release-evidence.mjs --evidence <dir> --shards <n> --commit <40 hex> [--tests-dir <dir>]
//
// The list of suites is the one `tests/run-all.mjs --list` prints in this checkout (--tests-dir: for the tests of this script), so nothing
// here knows how the split is made. Refused, each problem on a line of its own:
//   - a folder for anything but the shards 1..n, or a shard without one, or with two;
//   - a shard that ran on another commit (commit.txt) or system, whose summary is of another shard, another n or another list, or that ran
//     fewer suites than the shard holds (--bail, --filter, a run cut short);
//   - a result that is not PASS with exit code 0, or a count of fail, timeout, skip or flaky that is not 0 (a release retries nothing);
//   - a suite of the list that ran in no shard, or more than once, and a suite that is not in the list;
//   - a log (node-all.log) that is missing, that lists other suites or statuses than the summary, or that does not end with its counts.
//
// Exit code: 0 all of that holds; 1 a problem; 2 usage error, or the list of suites could not be had.
import { spawnSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RUNNER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'DATGOLD-HUB', 'tests', 'run-all.mjs');
/** PowerShell writes a BOM or not, depending on its version. */
const plain = (text) => text.replace(/^\uFEFF/, '');
const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isSummary = (parsed) => isObject(parsed) && isObject(parsed.summary) && Array.isArray(parsed.results)
  && parsed.results.every((result) => isObject(result) && typeof result.name === 'string');

/** The problems of one shard, read from its folder; `results` is empty when the summary could not be read. */
async function readShard({ folder, index, shards, commit, listed }) {
  const problems = [];
  const say = (text) => problems.push(`shard ${index}: ${text}`);
  const read = async (name) => {
    try { return plain(await readFile(path.join(folder, name), 'utf8')); } catch (error) { say(`${name} could not be read: ${error.message}`); return null; }
  };

  const ranOn = (await read('commit.txt'))?.trim();
  if (ranOn !== undefined && ranOn !== commit) say(`it ran on commit ${ranOn || '(empty)'}, not ${commit}`);

  const text = await read('node-summary.json');
  let parsed = null;
  if (text !== null) {
    try { parsed = JSON.parse(text); } catch (error) { say(`node-summary.json could not be read: ${error.message}`); }
    if (parsed !== null && !isSummary(parsed)) { say('node-summary.json is not a summary of run-all.mjs'); parsed = null; }
  }
  const log = await read('node-all.log');
  if (parsed === null) return { problems, results: [], node: '', seconds: 0 };

  const { summary, results } = parsed;
  const total = results.length;
  const shard = isObject(summary.shard) ? summary.shard : null;
  if (!shard) say(`the summary says no shard, not ${index}/${shards}`);
  else {
    if (shard.index !== index || shard.count !== shards) say(`the summary says shard ${shard.index}/${shard.count}, not ${index}/${shards}`);
    if (shard.of !== listed) say(`it was split from ${shard.of} suites, this commit has ${listed}`);
    if (shard.suites !== total) say(`${total} of the ${shard.suites} suites of the shard ran`);
  }
  if (summary.platform !== 'win32') say(`it ran on ${summary.platform}, not on Windows (win32)`);
  for (const result of results) {
    if (result.status !== 'PASS') say(`${result.name} is ${result.status}${result.note ? `: ${result.note}` : ''}`);
    else if (result.code !== 0) say(`${result.name} is PASS with exit code ${result.code}`);
  }
  for (const count of ['fail', 'timeout', 'skip', 'flaky']) if (summary[count] !== 0) say(`the summary counts ${summary[count]} ${count}`);
  if (summary.pass !== total || summary.total !== total) say(`the summary counts ${summary.pass} pass of ${summary.total}, ${total} results are listed`);

  if (log !== null) {
    // A result starts its line; what a failing suite printed is indented.
    const lines = [...log.matchAll(/^([A-Z]+) +(verify-.+?\.(?:mjs|py)) *\d+\.\d+s/gm)].map(([, status, name]) => `${status} ${name}`);
    if (lines.join('\n') !== results.map((result) => `${result.status} ${result.name}`).join('\n')) say('the log lists other suites than the summary, or other statuses');
    const last = log.trimEnd().split('\n').pop();
    if (last !== `SUMMARY: ${total} pass, 0 fail, 0 timeout, 0 skip, 0 flaky (of ${total} suites run; shard ${index}/${shards} of ${listed})`) say('the log does not end with the summary of the run, every suite passed');
  }
  return { problems, results, node: String(summary.node), seconds: results.reduce((sum, result) => sum + (Number(result.milliseconds) || 0), 0) / 1000 };
}

/**
 * @param {{directory: string, shards: number, commit: string, suites: string[]}} options `suites` is the list of the commit
 * @returns {Promise<{problems: string[], shards: {index: number, suites: number, seconds: number, node: string}[]}>} no problems: the release may go on
 */
export async function checkEvidence({ directory, shards, commit, suites }) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { return { problems: [`${directory} could not be read: ${error.message}`], shards: [] }; }
  const problems = [];
  const folders = new Map();
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const index = Number(/-shard([1-9]\d*)$/.exec(entry.name)?.[1] ?? 0);
    if (!entry.isDirectory() || index === 0) problems.push(`${entry.name} is not the evidence of a shard`);
    else if (index > shards) problems.push(`${entry.name}: a release run of ${shards} shards has no shard ${index}`);
    else folders.set(index, [...(folders.get(index) ?? []), entry.name]);
  }
  const ranIn = new Map();
  const report = [];
  for (let index = 1; index <= shards; index += 1) {
    const found = folders.get(index) ?? [];
    if (found.length === 0) { problems.push(`shard ${index}: its evidence is missing`); continue; }
    if (found.length > 1) { problems.push(`shard ${index}: its evidence is there ${found.length} times: ${found.join(', ')}`); continue; }
    const shard = await readShard({ folder: path.join(directory, found[0]), index, shards, commit, listed: suites.length });
    problems.push(...shard.problems);
    for (const { name } of shard.results) ranIn.set(name, [...(ranIn.get(name) ?? []), index]);
    report.push({ index, suites: shard.results.length, seconds: shard.seconds, node: shard.node });
  }
  const known = new Set(suites);
  for (const name of suites) if (!ranIn.has(name)) problems.push(`${name} ran in no shard`);
  for (const [name, where] of ranIn) {
    if (!known.has(name)) problems.push(`${name} is not a suite of this commit`);
    if (where.length > 1) problems.push(`${name} ran in shards ${where.join(', ')}: each suite must run exactly once`);
  }
  return { problems, shards: report };
}

function parseArguments(argv) {
  const options = { evidence: null, shards: null, commit: null, testsDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => { const next = argv[++i]; if (next === undefined) throw new Error(`${arg} requires a value`); return next; };
    if (arg === '--evidence') options.evidence = value();
    else if (arg === '--shards') options.shards = Number(value());
    else if (arg === '--commit') options.commit = value();
    else if (arg === '--tests-dir') options.testsDir = value();
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!options.evidence) throw new Error('--evidence <dir> is required');
  if (!Number.isInteger(options.shards) || options.shards < 1) throw new Error('--shards <n> is required, a whole number of at least 1');
  if (!/^[0-9a-f]{40}$/.test(options.commit ?? '')) throw new Error('--commit is required, the 40 hex digits of the commit');
  return options;
}

/** The suites of this checkout, as the runner itself lists them. */
function listSuites(testsDir) {
  const run = spawnSync(process.execPath, [RUNNER, '--list', ...(testsDir ? ['--tests-dir', testsDir] : [])], { encoding: 'utf8', windowsHide: true });
  if (run.status !== 0) throw new Error(`run-all.mjs --list failed (exit ${run.status}): ${run.stderr || run.error?.message || ''}`);
  const suites = run.stdout.split(/\r?\n/).filter(Boolean);
  if (suites.length === 0) throw new Error('run-all.mjs --list names no suite: there is nothing to hold the evidence against');
  return suites;
}

async function main(argv = process.argv.slice(2)) {
  let options;
  let suites;
  try { options = parseArguments(argv); suites = listSuites(options.testsDir); } catch (error) { console.error(error.message); return 2; }
  const verdict = await checkEvidence({ directory: options.evidence, shards: options.shards, commit: options.commit, suites });
  console.log('| Shard | Suites | Seconds | Node |\n| --- | --- | --- | --- |');
  for (const shard of verdict.shards) console.log(`| ${shard.index} | ${shard.suites} | ${shard.seconds.toFixed(1)} | ${shard.node} |`);
  for (const problem of verdict.problems) console.error(`verify-release-evidence: ${problem}`);
  if (verdict.problems.length > 0) return 1;
  console.log(`\nOK: the ${options.shards} shards ran each of the ${suites.length} Hub suites of ${options.commit} exactly once on Windows and every one passed.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main();
