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
//
// A suite that cannot run in the current environment may print a line that
// starts with "CHATMCP_TEST_SKIP:" followed by the reason and exit with 0.
// The runner then reports it as SKIP (never as PASS).
//
// Exit code: 0 when no suite failed or timed out, 1 otherwise, 2 for usage
// errors.

import { spawn } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const testsDirectory = path.dirname(fileURLToPath(import.meta.url));
const hubRoot = path.resolve(testsDirectory, '..');
const TAIL_LIMIT = 6000;

function parseOptions(argv) {
  const options = { list: false, filter: '', bail: false, verbose: false, timeoutSeconds: 180, python: false, json: '' };
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
    else if (arg === '--filter') options.filter = value().toLowerCase();
    else if (arg === '--json') options.json = value();
    else if (arg === '--timeout') {
      options.timeoutSeconds = Number(value());
      if (!Number.isFinite(options.timeoutSeconds) || options.timeoutSeconds < 1) throw new Error('--timeout must be a positive number of seconds');
    } else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

async function discover(options) {
  const files = (await readdir(testsDirectory)).filter((name) => /^verify-.+\.mjs$/.test(name) || (options.python && /^verify-.+\.py$/.test(name))).sort();
  return files.filter((name) => !options.filter || name.toLowerCase().includes(options.filter));
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
    const child = spawn(command, [path.join(testsDirectory, name)], {
      cwd: hubRoot,
      // UTF-8 for Python children: on Windows a piped stdout defaults to cp1252 and cannot print the Vietnamese UI text.
      env: { ...process.env, CHATMCP_TEST_RUNNER: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
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
        if (skip) { status = 'SKIP'; note = skip[1].trim(); } else status = 'PASS';
      } else { status = 'FAIL'; note = signal ? `signal ${signal}` : `exit ${code}`; }
      resolve({ name, status, code: timedOut ? null : code, note, milliseconds, tail: output.slice(-TAIL_LIMIT) });
    };
    child.on('error', (error) => finish(null, null, error));
    child.on('close', (code, signal) => finish(code, signal, null));
  });
}

function pad(text, width) { return text.length >= width ? text : text + ' '.repeat(width - text.length); }

async function main() {
  let options;
  try { options = parseOptions(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exit(2); }
  const suites = await discover(options);
  if (options.list) { for (const name of suites) console.log(name); return 0; }
  if (suites.length === 0) { console.error('No test suites matched.'); return 2; }

  console.log(`ChatMCP Hub test runner - node ${process.version} on ${process.platform}/${process.arch} - ${suites.length} suite(s)`);
  const results = [];
  for (const name of suites) {
    const result = await runSuite(name, options);
    results.push(result);
    console.log(`${pad(result.status, 8)}${pad(name, 46)}${pad(`${(result.milliseconds / 1000).toFixed(1)}s`, 8)}${result.note}`);
    if ((result.status === 'FAIL' || result.status === 'TIMEOUT') && !options.verbose) {
      const lines = result.tail.trimEnd().split(/\r?\n/).slice(-25);
      for (const line of lines) console.log(`    | ${line}`);
    }
    if (options.bail && (result.status === 'FAIL' || result.status === 'TIMEOUT')) break;
  }

  const count = (status) => results.filter((r) => r.status === status).length;
  const summary = { node: process.version, platform: process.platform, arch: process.arch, total: results.length, pass: count('PASS'), fail: count('FAIL'), timeout: count('TIMEOUT'), skip: count('SKIP') };
  console.log(`\nSUMMARY: ${summary.pass} pass, ${summary.fail} fail, ${summary.timeout} timeout, ${summary.skip} skip (of ${summary.total} suites run)`);
  if (options.json) {
    await mkdir(path.dirname(path.resolve(options.json)), { recursive: true });
    await writeFile(options.json, JSON.stringify({ summary, results: results.map(({ tail, ...rest }) => rest) }, null, 2) + '\n');
  }
  return summary.fail + summary.timeout === 0 ? 0 : 1;
}

process.exitCode = await main();
