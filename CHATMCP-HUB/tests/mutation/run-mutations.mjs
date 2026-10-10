#!/usr/bin/env node
// Mutation testing for the Hub's own suites.
//
// A suite that cannot fail proves nothing. This tool checks that a suite can: it breaks the code on purpose (one small, exact
// replacement at a time, in a THROW-AWAY COPY of the Hub - the real files are never touched), runs the suite against the broken copy
// and reports whether the suite noticed. A mutation that the suite does not notice (SURVIVED) is a hole in the test or dead code.
//
// Usage:
//   node tests/mutation/run-mutations.mjs <list.json> [--only name,name] [--timeout seconds] [--json file] [--allow-skip] [--hub-root dir] [--keep]
//
// A list is {"suite": "verify-x.mjs", "mutations": [{"name", "what", "equivalent"?, "platforms"?, "patches": [{"file", "old", "new"}]}]}.
// `file` is relative to the Hub folder; `old` must occur exactly once in it (an ambiguous or stale pattern is reported as ERROR, never
// guessed at). A mutation can be annotated `"equivalent": "why"` when it provably changes no behaviour (a redundant, defensive line); if
// it survives it is reported as EQUIVALENT and does not fail the run - if it is killed after all, the annotation is stale and says so.
// A mutation can be limited with `"platforms": ["win32"]` (Node's process.platform names) when it breaks code that only runs there - the
// Windows DPAPI key store, say, or Unix file modes. On any other platform it is reported as N/A: not run, neither killed nor survived.
// The suite is run first against the unmodified copy: if it does not PASS there, every later "KILLED" would be meaningless, so the
// run stops (exit 2). A suite that SKIPs (for example the FastAPI end-to-end suite without Python) cannot judge anything: SKIP.
//
// Exit code: 0 when every mutation was killed, 1 when one survived, errored or was skipped, 2 for usage errors or a failing baseline.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OWN_HUB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PLATFORMS = ['aix', 'android', 'darwin', 'freebsd', 'linux', 'openbsd', 'sunos', 'win32'];
const TAIL_LIMIT = 8000;

function parseOptions(argv) {
  const options = { list: '', only: null, timeoutSeconds: 175, json: '', allowSkip: false, hubRoot: OWN_HUB_ROOT, keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} requires a value`);
      return next;
    };
    if (arg === '--only') options.only = new Set(value().split(',').map((name) => name.trim()).filter(Boolean));
    else if (arg === '--json') options.json = value();
    else if (arg === '--hub-root') options.hubRoot = path.resolve(value());
    else if (arg === '--allow-skip') options.allowSkip = true;
    else if (arg === '--keep') options.keep = true;
    else if (arg === '--timeout') {
      options.timeoutSeconds = Number(value());
      if (!Number.isFinite(options.timeoutSeconds) || options.timeoutSeconds < 1) throw new Error('--timeout must be a positive number of seconds');
    } else if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
    else if (!options.list) options.list = path.resolve(arg);
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  if (!options.list) throw new Error('usage: node tests/mutation/run-mutations.mjs <list.json> [--only name,name] [--timeout seconds] [--json file] [--allow-skip] [--hub-root dir] [--keep]');
  return options;
}

async function loadList(file) {
  const list = JSON.parse(await readFile(file, 'utf8'));
  if (!list || typeof list.suite !== 'string' || !/^[\w.-]+\.mjs$/.test(list.suite) || !Array.isArray(list.mutations) || list.mutations.length === 0) {
    throw new Error(`${file}: expected {"suite": "verify-x.mjs", "mutations": [...]}`);
  }
  const names = new Set();
  for (const mutation of list.mutations) {
    if (typeof mutation.name !== 'string' || !mutation.name || names.has(mutation.name)) throw new Error(`${file}: every mutation needs a unique name (${mutation.name})`);
    names.add(mutation.name);
    if (!Array.isArray(mutation.patches) || mutation.patches.length === 0) throw new Error(`${file}: ${mutation.name} has no patches`);
    if (mutation.equivalent !== undefined && (typeof mutation.equivalent !== 'string' || mutation.equivalent.trim().length < 20)) throw new Error(`${file}: ${mutation.name}: "equivalent" must explain why, in a sentence`);
    if (mutation.platforms !== undefined && (!Array.isArray(mutation.platforms) || mutation.platforms.length === 0 || mutation.platforms.some((platform) => !PLATFORMS.includes(platform)))) {
      throw new Error(`${file}: ${mutation.name}: "platforms" must list Node platform names such as "win32" or "linux"`);
    }
    for (const patch of mutation.patches) {
      if (typeof patch.file !== 'string' || typeof patch.old !== 'string' || typeof patch.new !== 'string' || !patch.old) throw new Error(`${file}: ${mutation.name} has a malformed patch`);
      const relative = path.relative(path.resolve('hub'), path.resolve('hub', patch.file));
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`${file}: ${mutation.name}: ${patch.file} is outside the Hub folder`);
    }
  }
  return list;
}

function killTree(child) {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
}

function runSuite(copy, suite, { timeoutSeconds, env }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(copy, 'tests', suite)], {
      cwd: copy, env: { ...process.env, ...env, CHATMCP_TEST_RUNNER: '1' }, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true,
    });
    let output = '';
    let timedOut = false;
    const collect = (chunk) => { output += chunk.toString('utf8'); if (output.length > TAIL_LIMIT * 4) output = output.slice(-TAIL_LIMIT * 2); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutSeconds * 1000);
    child.on('error', (error) => { clearTimeout(timer); resolve({ code: null, timedOut: false, output: `could not start: ${error.message}`, seconds: 0 }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: timedOut ? null : code, timedOut, output, seconds: Math.round((Date.now() - started) / 1000) }); });
  });
}

/**
 * Applies the patches of one mutation to the copy; returns the original texts so that the files can be put back. Patterns are written
 * with \n; a file that Git checked out with CRLF (Windows) is matched as if it had LF.
 */
async function apply(copy, mutation) {
  const originals = new Map();
  try {
    for (const patch of mutation.patches) {
      const file = path.join(copy, patch.file);
      const raw = await readFile(file, 'utf8'); // the current text: an earlier patch of this mutation may already have changed the file
      if (!originals.has(file)) originals.set(file, raw);
      const crlf = raw.includes('\r\n');
      const text = crlf ? raw.replace(/\r\n/g, '\n') : raw;
      const occurrences = text.split(patch.old).length - 1;
      if (occurrences !== 1) throw new Error(`${patch.file}: the pattern ${JSON.stringify(patch.old.slice(0, 70))} occurs ${occurrences} times, expected exactly 1`);
      const changed = text.replace(patch.old, () => patch.new);
      await writeFile(file, changed, 'utf8'); // LF in the mutated copy is fine; restore() puts the original bytes back
    }
  } catch (error) {
    await restore(originals);
    throw error;
  }
  return originals;
}

async function restore(originals) {
  for (const [file, text] of originals) await writeFile(file, text, 'utf8');
}

const failedChecks = (output) => output.split(/\r?\n/).filter((line) => /^\s*not ok\b/.test(line)).map((line) => line.trim().slice(0, 220));
/** The first line that looks like an assertion or an uncaught error: suites written with node:assert say why they failed there. */
const firstError = (output) => output.split(/\r?\n/).map((line) => line.trim()).find((line) => /^(\w*Error\b|Error:|Uncaught)/.test(line))?.slice(0, 200) ?? '';
const skipReason = (output) => output.match(/^CHATMCP_TEST_SKIP:\s*(.*)$/m)?.[1]?.trim() ?? null;

async function main() {
  let options;
  try { options = parseOptions(process.argv.slice(2)); } catch (error) { console.error(error.message); return 2; }
  let list;
  try { list = await loadList(options.list); } catch (error) { console.error(error.message); return 2; }
  const mutations = list.mutations.filter((mutation) => !options.only || options.only.has(mutation.name));
  if (mutations.length === 0) { console.error('No mutation matched --only.'); return 2; }
  if (!existsSync(path.join(options.hubRoot, 'tests', list.suite))) { console.error(`The suite tests/${list.suite} does not exist in ${options.hubRoot}.`); return 2; }

  const scratch = await mkdtemp(path.join(os.tmpdir(), 'chatmcp-mutation-'));
  const copy = path.join(scratch, 'hub');
  try {
    await cp(options.hubRoot, copy, { recursive: true, filter: (source) => !/[\\/](node_modules|test-results|\.git|__pycache__|\.generated)([\\/]|$)/.test(source) });
    // The FastAPI suite looks for its Python next to the repository, which a copy in the temp folder does not have.
    const env = {};
    if (!process.env.CHATMCP_E2E_PYTHON) {
      const venv = path.resolve(options.hubRoot, '..', 'deploy', '.generated', 'venv-e2e');
      const python = path.join(venv, process.platform === 'win32' ? path.join('Scripts', 'python.exe') : path.join('bin', 'python'));
      if (existsSync(python)) env.CHATMCP_E2E_PYTHON = python;
    }

    console.log(`Mutation run: tests/${list.suite} - ${mutations.length} mutation(s) - node ${process.version} on ${process.platform}`);
    const baseline = await runSuite(copy, list.suite, { timeoutSeconds: options.timeoutSeconds, env });
    const baselineSkip = skipReason(baseline.output);
    if (baseline.timedOut || baseline.code !== 0 || baselineSkip) {
      console.error(`The suite does not PASS on the unmodified copy (${baseline.timedOut ? 'timeout' : baselineSkip ? `SKIP: ${baselineSkip}` : `exit ${baseline.code}`}), so no mutation can be judged.`);
      console.error(baseline.output.trimEnd().split(/\r?\n/).slice(-15).join('\n'));
      return 2;
    }
    console.log(`baseline  PASS   ${baseline.seconds}s`);

    const results = [];
    for (const mutation of mutations) {
      if (mutation.platforms && !mutation.platforms.includes(process.platform)) {
        const result = { status: 'N/A', note: `applies only on ${mutation.platforms.join(', ')}; this is ${process.platform}`, seconds: 0 };
        results.push({ name: mutation.name, what: mutation.what ?? '', ...result });
        console.log(`${result.status.padEnd(9)}${mutation.name.padEnd(34)}${'0'.padStart(3)}s  ${mutation.what ?? ''}\n          ${result.note}`);
        continue;
      }
      let originals;
      let result;
      try {
        originals = await apply(copy, mutation);
        const run = await runSuite(copy, list.suite, { timeoutSeconds: options.timeoutSeconds, env });
        const skipped = skipReason(run.output);
        if (skipped) result = { status: 'SKIP', note: skipped };
        else if (run.timedOut) result = { status: 'KILLED', note: `the suite hung and was stopped after ${options.timeoutSeconds}s`, checks: [] };
        else if (run.code === 0) result = mutation.equivalent ? { status: 'EQUIVALENT', note: mutation.equivalent } : { status: 'SURVIVED', note: 'the suite passed on the broken code' };
        else result = { status: 'KILLED', note: `exit ${run.code}${firstError(run.output) ? ` - ${firstError(run.output)}` : ''}${mutation.equivalent ? ' (annotated as equivalent, yet killed: the annotation is stale)' : ''}`, checks: failedChecks(run.output).slice(0, 6) };
        result.seconds = run.seconds;
      } catch (error) {
        result = { status: 'ERROR', note: error.message, seconds: 0 };
      } finally {
        if (originals) await restore(originals);
      }
      results.push({ name: mutation.name, what: mutation.what ?? '', ...result });
      const detail = result.status === 'KILLED' ? `${result.checks?.length ? `${result.checks.length}+ check(s) failed: ` : ''}${result.checks?.[0] ?? result.note}` : result.note;
      console.log(`${result.status.padEnd(9)}${mutation.name.padEnd(34)}${String(result.seconds).padStart(3)}s  ${mutation.what ?? ''}\n          ${detail.slice(0, 200)}`);
    }

    const count = (status) => results.filter((entry) => entry.status === status).length;
    const summary = { suite: list.suite, node: process.version, platform: process.platform, total: results.length, killed: count('KILLED'), survived: count('SURVIVED'), equivalent: count('EQUIVALENT'), error: count('ERROR'), skip: count('SKIP'), notApplicable: count('N/A') };
    console.log(`\nSUMMARY: ${summary.killed} killed, ${summary.survived} survived, ${summary.equivalent} equivalent, ${summary.error} error, ${summary.skip} skip${summary.notApplicable ? `, ${summary.notApplicable} n/a` : ''} (of ${summary.total} mutations of tests/${list.suite})`);
    if (summary.survived) console.log(`SURVIVED: ${results.filter((entry) => entry.status === 'SURVIVED').map((entry) => entry.name).join(', ')}`);
    if (options.json) await writeFile(path.resolve(options.json), `${JSON.stringify({ summary, results }, null, 2)}\n`, 'utf8');
    return summary.survived + summary.error + (options.allowSkip ? 0 : summary.skip) === 0 ? 0 : 1;
  } finally {
    if (options.keep) console.log(`Kept the mutated copy at ${copy}`);
    else await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

process.exitCode = await main();
