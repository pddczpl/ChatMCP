#!/usr/bin/env node
// Rebuild DATGOLD-HUB/tests/shard-weights.json, the seconds per suite that `tests/run-all.mjs --shard i/n` balances by (docs/CI-HEALTH.md,
// "Three shards"), from the summaries CI uploads.
//
//   gh run download <run id> --repo pddczpl/ChatMCP --pattern 'hub-test-summary-windows-*' --dir <dir>     (one or more runs of main)
//   node scripts/ci-shard-weights.mjs --from <dir> --out DATGOLD-HUB/tests/shard-weights.json [--note "runs 1, 2 on main"] [--date YYYY-MM-DD]
//
// Every summary.json below <dir> written on Windows (summary.platform "win32": the slow runners, the ones that decide when a shard nears its
// limit) is read, in any folder layout; other summaries are ignored. A suite weighs the mean of its "milliseconds" over the summaries in which
// it PASSED (a FLAKY time includes the failed attempt, a FAIL or TIMEOUT time says nothing about a normal run), in seconds rounded to 0.1. A
// suite that never passed is left out, so the runner gives it the mean of the listed ones. The script reads files only: no network.
//
// Exit code: 0 written; 2 usage error or no Windows summary below <dir>.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

function parseArguments(argv) {
  const options = { from: null, out: null, note: '', date: new Date().toISOString().slice(0, 10) };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => { const next = argv[++i]; if (next === undefined) throw new Error(`${arg} requires a value`); return next; };
    if (arg === '--from') options.from = value();
    else if (arg === '--out') options.out = value();
    else if (arg === '--note') options.note = value();
    else if (arg === '--date') { options.date = value(); if (!/^\d{4}-\d{2}-\d{2}$/.test(options.date)) throw new Error('--date must be YYYY-MM-DD'); }
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!options.from || !options.out) throw new Error('--from <dir> and --out <file> are required');
  return options;
}

async function summaryFiles(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await summaryFiles(full));
    else if (entry.isFile() && entry.name === 'summary.json') found.push(full);
  }
  return found;
}

async function main(argv = process.argv.slice(2)) {
  let options;
  try { options = parseArguments(argv); } catch (error) { console.error(error.message); return 2; }
  let files;
  try { files = (await summaryFiles(options.from)).sort(); } catch (error) { console.error(`${options.from} could not be read: ${error.message}`); return 2; }
  const times = new Map();
  const read = [];
  for (const file of files) {
    let parsed;
    try { parsed = JSON.parse(await readFile(file, 'utf8')); } catch { continue; }
    if (parsed?.summary?.platform !== 'win32' || !Array.isArray(parsed.results)) continue;
    read.push(path.relative(options.from, file).split(path.sep).join('/'));
    for (const result of parsed.results) {
      if (result?.status !== 'PASS' || typeof result.name !== 'string' || !Number.isFinite(result.milliseconds)) continue;
      if (!times.has(result.name)) times.set(result.name, []);
      times.get(result.name).push(result.milliseconds);
    }
  }
  if (read.length === 0) { console.error(`No summary.json written on Windows (summary.platform "win32") below ${options.from}`); return 2; }
  const seconds = {};
  for (const name of [...times.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const values = times.get(name);
    seconds[name] = Math.round(values.reduce((sum, value) => sum + value, 0) / values.length / 100) / 10;
  }
  const weights = {
    about: 'Seconds per suite that tests/run-all.mjs --shard balances by (the rule is in the header of run-all.mjs; docs/CI-HEALTH.md, "Three shards"). Written by scripts/ci-shard-weights.mjs: the mean time of each suite over the Windows summaries below, PASS results only, rounded to 0.1 s. A suite not listed here weighs the mean of the listed ones.',
    measured: { date: options.date, ...(options.note ? { note: options.note } : {}), summaries: read },
    seconds,
  };
  await writeFile(options.out, `${JSON.stringify(weights, null, 2)}\n`);
  const total = Object.values(seconds).reduce((sum, value) => sum + value, 0);
  console.log(`${options.out}: ${Object.keys(seconds).length} suites, ${total.toFixed(1)} s in all, from ${read.length} Windows summaries`);
  return 0;
}

process.exitCode = await main();
