#!/usr/bin/env node
// Mutation testing for the native side of the in-app updater (native-shared/, installer/, desktop-shell/).
//
// The Hub's suites have a runner for this (DATGOLD-HUB/tests/mutation/run-mutations.mjs); the C# tests in this folder had none, and a test that cannot fail proves nothing. This tool breaks the C# code on
// purpose, ONE small exact replacement at a time, in a THROW-AWAY COPY of the folders it needs (the real files are never touched), builds the copy and runs the native tests against it. A mutation the tests
// do not notice SURVIVED: a hole in the tests, or dead code.
//
//   node scripts/tests/native-lifecycle/run-mutations.mjs [--only name,name] [--json file] [--timeout seconds] [--keep] [--check] [--list mutations.json]
//
// A list is {"mutations": [{"name", "what", "run"?: "native" | "gate" | "payload", "equivalent"?, "patches": [{"file", "old", "new"}]}]}. `file` is relative to the repository root and must be one of the files the copy holds;
// `old` must occur exactly once in it (an ambiguous or stale pattern is an ERROR, never guessed at). `run` says what judges the mutation: "native" (the default) builds the native test project and runs it,
// "gate" runs DATGOLD-HUB/tests/verify-update-apply.mjs, the static gate for the build and the source, "payload" runs scripts/tests/Test-InstallerPayload.ps1, the PowerShell tests of the build's own helpers
// (the proof of the key list the build embeds). A mutation that does not COMPILE is INVALID, not killed: a compiler error is not a test that noticed
// something, so the list must hold only mutations that build. The same goes for a mutation of a script that does not PARSE ("gate" and "payload": a ParserError of PowerShell or a SyntaxError of node in the
// output): the judge failed because the file is not source any more, not because a check noticed what the mutation did. `"equivalent": "why"` marks a mutation that provably changes no behaviour; if it survives it is EQUIVALENT and does not fail the run, and if it
// is killed after all the annotation is stale and the note says so. `"needs": ["symlink"]` marks a mutation that only a machine able to make a link to a file can judge (on Windows that takes a privilege): where it
// cannot, the test says so and passes, and the mutation is N/A there, never counted as survived.
//
// The native tests only ever touch temporary folders and loopback ports of their own: this tool never runs an installer, never starts the real Hub and never touches port 3007. (Do not add a mutation that
// changes a port number or a folder the tests are given: the test would then reach for something that is not theirs.)
//
// Exit code: 0 when every mutation was killed (or is equivalent), 1 when one survived, was invalid or errored, 2 for usage errors or a baseline that does not pass.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync as removeSync, symlinkSync, writeFileSync as writeSync } from 'node:fs';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// A PowerShell child that a script starts from node gets the environment of this helper (tests/verify-source-lint.mjs holds every such script to it): without PSModulePath of the PowerShell 7 that may have started node.
import { powerShellChildEnvironment } from '../../../DATGOLD-HUB/tests/support/powershell-environment.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const HERE = path.relative(REPO, path.dirname(fileURLToPath(import.meta.url))).replaceAll('\\', '/');
const COPIED = [
  'native-shared', 'installer', 'desktop-shell', HERE,
  'scripts/Build-Installer.ps1', 'scripts/tests/Test-NativeLifecycle.ps1',
  'scripts/InstallerPayload.ps1', 'scripts/tests/Test-InstallerPayload.ps1', 'scripts/intelligence-runtime/licenses/ripgrep', 'DATGOLD-HUB/lib/assemble.mjs', // what the PowerShell tests of the build read
  'DATGOLD-HUB/lib/release-keys.json', 'DATGOLD-HUB/tests/verify-update-apply.mjs',
  'DATGOLD-HUB/tests/support/powershell-environment.mjs', 'DATGOLD-HUB/lib/powershell-environment.mjs', // which that gate imports
  'DATGOLD-HUB/tests/fixtures/release-verify-vectors.json', 'DATGOLD-HUB/tests/fixtures/update-result-vectors.json', 'DATGOLD-HUB/tests/fixtures/active-work-cases.json',
  'docs/WINDOWS-SETUP.md', // the recovery by hand that the guide gives is run by Program.cs from this text
];
const SKIPPED = /(^|[\\/])(bin|obj|node_modules|payload\.zip)([\\/]|$)/;
/** What this machine can do, found by trying it once. */
const CAPABILITIES = {
  symlink: () => {
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'chatmcp-can-link-'));
    try { writeSync(path.join(scratch, 'target'), 'x'); symlinkSync(path.join(scratch, 'target'), path.join(scratch, 'link'), 'file'); return true; } catch { return false; } finally { removeSync(scratch, { recursive: true, force: true }); }
  },
};
const TAIL = 6000;
/** The line of a judge's output that says the mutated file is not valid source (PowerShell: ParserError / ParseException; node: SyntaxError), or undefined when it does not say so. */
const parseError = (output) => output.split(/\r?\n/).find((line) => /\bParserError\b|\bParseException\b|^SyntaxError: /.test(line));

function options(argv) {
  const found = { only: null, json: '', timeout: 300, keep: false, check: false, list: path.join(REPO, HERE, 'mutations.json') };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => { const next = argv[++i]; if (next === undefined) throw new Error(`${arg} needs a value`); return next; };
    if (arg === '--only') found.only = new Set(value().split(',').map((name) => name.trim()).filter(Boolean));
    else if (arg === '--json') found.json = path.resolve(value());
    else if (arg === '--timeout') { found.timeout = Number(value()); if (!(found.timeout >= 1)) throw new Error('--timeout is a number of seconds'); }
    else if (arg === '--keep') found.keep = true;
    else if (arg === '--check') found.check = true;
    else if (arg === '--list') found.list = path.resolve(value());
    else throw new Error(`unknown option ${arg}`);
  }
  return found;
}

async function load(file) {
  const list = JSON.parse(await readFile(file, 'utf8'));
  if (!list || !Array.isArray(list.mutations) || list.mutations.length === 0) throw new Error(`${file}: expected {"mutations": [...]}`);
  const names = new Set();
  for (const mutation of list.mutations) {
    if (typeof mutation.name !== 'string' || !mutation.name || names.has(mutation.name)) throw new Error(`every mutation needs a unique name (${mutation.name})`);
    names.add(mutation.name);
    if (mutation.run !== undefined && !['native', 'gate', 'payload'].includes(mutation.run)) throw new Error(`${mutation.name}: run is "native", "gate" or "payload"`);
    if (mutation.needs !== undefined && (!Array.isArray(mutation.needs) || mutation.needs.some((need) => !(need in CAPABILITIES)))) throw new Error(`${mutation.name}: needs is a list of ${Object.keys(CAPABILITIES).join(', ')}`);
    if (mutation.equivalent !== undefined && (typeof mutation.equivalent !== 'string' || mutation.equivalent.trim().length < 20)) throw new Error(`${mutation.name}: "equivalent" must explain why, in a sentence`);
    if (!Array.isArray(mutation.patches) || mutation.patches.length === 0) throw new Error(`${mutation.name} has no patches`);
    // The native tests build C# and nothing else: a patch to any other kind of file that they are asked to judge would "survive" for no reason (eleven mutations of a PowerShell function once did).
    if ((mutation.run === undefined || mutation.run === 'native') && mutation.patches.some((patch) => typeof patch.file === 'string' && !patch.file.endsWith('.cs'))) throw new Error(`${mutation.name}: the native tests build C# only: a patch to another kind of file is judged by "gate" or "payload"`);
    for (const patch of mutation.patches) {
      if (typeof patch.file !== 'string' || typeof patch.old !== 'string' || typeof patch.new !== 'string' || !patch.old) throw new Error(`${mutation.name} has a malformed patch`);
      const relative = path.relative(REPO, path.resolve(REPO, patch.file));
      if (relative.startsWith('..') || path.isAbsolute(relative) || !COPIED.some((item) => relative.replaceAll('\\', '/') === item || relative.replaceAll('\\', '/').startsWith(`${item}/`))) throw new Error(`${mutation.name}: ${patch.file} is not one of the files the copy holds`);
    }
  }
  return list;
}

function run(command, args, { cwd, timeout, env = process.env }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    let timedOut = false;
    const collect = (chunk) => { output += chunk.toString('utf8'); if (output.length > TAIL * 4) output = output.slice(-TAIL * 2); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => { timedOut = true; if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); else child.kill('SIGKILL'); }, timeout * 1000);
    child.on('error', (error) => { clearTimeout(timer); resolve({ code: null, timedOut: false, output: `could not start: ${error.message}`, seconds: 0 }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: timedOut ? null : code, timedOut, output, seconds: Math.round((Date.now() - started) / 1000) }); });
  });
}

async function apply(copy, mutation) {
  const originals = new Map();
  try {
    for (const patch of mutation.patches) {
      const file = path.join(copy, patch.file);
      const raw = await readFile(file, 'utf8');
      if (!originals.has(file)) originals.set(file, raw);
      const text = raw.replace(/\r\n/g, '\n');
      const occurrences = text.split(patch.old).length - 1;
      if (occurrences !== 1) throw new Error(`${patch.file}: the pattern ${JSON.stringify(patch.old.slice(0, 70))} occurs ${occurrences} times, expected exactly 1`);
      await writeFile(file, text.replace(patch.old, () => patch.new), 'utf8');
    }
  } catch (error) {
    for (const [file, text] of originals) await writeFile(file, text, 'utf8');
    throw error;
  }
  return originals;
}

const failedLines = (output) => output.split(/\r?\n/).filter((line) => /^\s*(FAIL|Unhandled exception|System\.\w*Exception)/.test(line)).map((line) => line.trim().slice(0, 200));
const compilerErrors = (output) => [...new Set(output.split(/\r?\n/).filter((line) => /error CS\d+/.test(line)).map((line) => line.replace(/^.*?(?=error CS)/, '').slice(0, 200)))];

async function main() {
  let opts;
  let list;
  try { opts = options(process.argv.slice(2)); list = await load(opts.list); } catch (error) { console.error(error.message); return 2; }
  const mutations = list.mutations.filter((mutation) => !opts.only || opts.only.has(mutation.name));
  if (mutations.length === 0) { console.error('No mutation matched --only.'); return 2; }

  if (opts.check) {
    // No build, no run: only whether every pattern still occurs exactly once in the file it is for (the fast check while a list is written, and in CI when the code moves).
    let problems = 0;
    for (const mutation of mutations) {
      for (const patch of mutation.patches) {
        const file = path.join(REPO, patch.file);
        if (!existsSync(file)) { console.log(`${mutation.name}: ${patch.file} does not exist`); problems += 1; continue; }
        const occurrences = (await readFile(file, 'utf8')).replace(/\r\n/g, '\n').split(patch.old).length - 1;
        if (occurrences !== 1) { console.log(`${mutation.name}: the pattern ${JSON.stringify(patch.old.slice(0, 70))} occurs ${occurrences} times in ${patch.file}, expected exactly 1`); problems += 1; }
      }
    }
    console.log(problems === 0 ? `CHECK: ${mutations.length} mutations, every pattern occurs exactly once` : `CHECK: ${problems} problem(s)`);
    return problems === 0 ? 0 : 1;
  }

  const scratch = await mkdtemp(path.join(os.tmpdir(), 'chatmcp-native-mutation-'));
  const copy = path.join(scratch, 'repo');
  try {
    for (const item of COPIED) {
      const from = path.join(REPO, item);
      if (!existsSync(from)) throw new Error(`${item} is not in the repository`);
      const to = path.join(copy, item);
      await mkdir(path.dirname(to), { recursive: true });
      await cp(from, to, { recursive: true, filter: (source) => !SKIPPED.test(path.relative(REPO, source)) });
    }
    const project = path.join(copy, HERE, 'NativeLifecycle.Tests.csproj');
    const build = () => run('dotnet', ['build', project, '-c', 'Release', '--nologo', '-v', 'q', '-p:TreatWarningsAsErrors=false'], { cwd: copy, timeout: opts.timeout });
    // Each run of the tests starts in a folder of its own that is empty and removed afterwards: a file that a mutated run leaves in the folder it was started from (a result file written to a relative path, say)
    // would otherwise be there for every later run and kill it for a reason that is not its own.
    const execute = async () => {
      const here = await mkdtemp(path.join(os.tmpdir(), 'chatmcp-native-cwd-'));
      try { return await run('dotnet', ['run', '--no-build', '--project', project, '-c', 'Release'], { cwd: here, timeout: opts.timeout }); }
      finally { await rm(here, { recursive: true, force: true }).catch(() => {}); }
    };
    // the gate must not compare the list of mutations with a copy that has a mutation in it: it is told so
    const gate = () => run(process.execPath, [path.join(copy, 'DATGOLD-HUB', 'tests', 'verify-update-apply.mjs')], { cwd: copy, timeout: opts.timeout, env: { ...process.env, CHATMCP_NATIVE_MUTATION_COPY: '1' } });
    // the PowerShell tests of the build's helpers: they read the copy of the scripts next to them
    const payload = () => run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(copy, 'scripts', 'tests', 'Test-InstallerPayload.ps1')], { cwd: copy, timeout: opts.timeout, env: powerShellChildEnvironment() });

    console.log(`Native mutation run: ${mutations.length} mutation(s) - ${HERE}/${path.basename(opts.list)} - node ${process.version} on ${process.platform}`);
    const first = await build();
    if (first.code !== 0) { console.error(`The copy does not build (exit ${first.code}):\n${first.output.trimEnd().split(/\r?\n/).slice(-20).join('\n')}`); return 2; }
    const baseline = await execute();
    const baselineGate = await gate();
    const baselinePayload = await payload();
    if (baseline.code !== 0 || baseline.timedOut || !/"result":"PASS"/.test(baseline.output)) { console.error(`The native tests do not pass on the unmodified copy (exit ${baseline.code}), so no mutation can be judged.\n${baseline.output.trimEnd().split(/\r?\n/).slice(-15).join('\n')}`); return 2; }
    if (baselineGate.code !== 0) { console.error(`The static gate does not pass on the unmodified copy (exit ${baselineGate.code}).\n${baselineGate.output.trimEnd().split(/\r?\n/).slice(-15).join('\n')}`); return 2; }
    if (baselinePayload.code !== 0 || !/Installer payload regression \(\d+ passed, 0 failed/.test(baselinePayload.output)) { console.error(`The PowerShell tests of the build do not pass on the unmodified copy (exit ${baselinePayload.code}).\n${baselinePayload.output.trimEnd().split(/\r?\n/).slice(-15).join('\n')}`); return 2; }
    console.log(`baseline  PASS   native ${baseline.seconds}s, gate ${baselineGate.seconds}s, payload ${baselinePayload.seconds}s`);

    const results = [];
    const can = Object.fromEntries(Object.entries(CAPABILITIES).map(([need, probe]) => [need, probe()]));
    for (const mutation of mutations) {
      let originals;
      let result;
      const missing = (mutation.needs ?? []).filter((need) => !can[need]);
      if (missing.length) {
        result = { status: 'N/A', note: `this machine cannot ${missing.join(', ')}, which the test of this mutation needs (the test says so and passes here)`, seconds: 0 };
        results.push({ name: mutation.name, what: mutation.what ?? '', ...result });
        console.log(`${result.status.padEnd(10)}${mutation.name.padEnd(46)}${String(result.seconds).padStart(3)}s  ${mutation.what ?? ''}\n           ${result.note}`);
        continue;
      }
      try {
        originals = await apply(copy, mutation);
        if (mutation.run === 'gate') {
          const judged = await gate();
          if (judged.timedOut) result = { status: 'KILLED', note: 'the gate hung and was stopped' };
          else if (judged.code !== 0 && parseError(judged.output)) result = { status: 'INVALID', note: `does not parse: ${parseError(judged.output).trim().slice(0, 160)}` };
          else if (judged.code === 0) result = mutation.equivalent ? { status: 'EQUIVALENT', note: mutation.equivalent } : { status: 'SURVIVED', note: 'the gate passed on the broken source' };
          else result = { status: 'KILLED', note: `exit ${judged.code}: ${(judged.output.split(/\r?\n/).find((line) => /AssertionError/.test(line)) ?? '').replace(/^AssertionError \[ERR_ASSERTION\]: /, '').slice(0, 180)}${mutation.equivalent ? ' (annotated as equivalent, yet killed: the annotation is stale)' : ''}` };
          result.seconds = judged.seconds;
        } else if (mutation.run === 'payload') {
          const judged = await payload();
          if (judged.timedOut) result = { status: 'KILLED', note: 'the tests hung and were stopped' };
          else if (judged.code !== 0 && parseError(judged.output)) result = { status: 'INVALID', note: `does not parse: ${parseError(judged.output).trim().slice(0, 160)}` };
          else if (judged.code === 0) result = mutation.equivalent ? { status: 'EQUIVALENT', note: mutation.equivalent } : { status: 'SURVIVED', note: 'the PowerShell tests passed on the broken script' };
          else result = { status: 'KILLED', note: `exit ${judged.code}: ${(judged.output.split(/\r?\n/).find((line) => /FAIL:/.test(line)) ?? judged.output.split(/\r?\n/).find((line) => /\b(?:Exception|error)\b|is not recognized|cannot be/i.test(line)) ?? judged.output.trim().split(/\r?\n/).at(-1) ?? '').replace(/^.*?(?=FAIL:)/, '').slice(0, 180)}${mutation.equivalent ? ' (annotated as equivalent, yet killed: the annotation is stale)' : ''}` };
          result.seconds = judged.seconds;
        } else {
          const built = await build();
          if (built.code !== 0) result = { status: 'INVALID', note: `does not compile: ${compilerErrors(built.output).slice(0, 2).join(' | ') || `exit ${built.code}`}`, seconds: built.seconds };
          else {
            const judged = await execute();
            if (judged.timedOut) result = { status: 'KILLED', note: 'the tests hung and were stopped' };
            else if (judged.code === 0 && /"result":"PASS"/.test(judged.output)) result = mutation.equivalent ? { status: 'EQUIVALENT', note: mutation.equivalent } : { status: 'SURVIVED', note: 'the tests passed on the broken code' };
            else result = { status: 'KILLED', note: `${failedLines(judged.output)[0] ?? `exit ${judged.code}`}${mutation.equivalent ? ' (annotated as equivalent, yet killed: the annotation is stale)' : ''}` };
            result.seconds = built.seconds + judged.seconds;
          }
        }
      } catch (error) {
        result = { status: 'ERROR', note: error.message, seconds: 0 };
      } finally {
        if (originals) for (const [file, text] of originals) await writeFile(file, text, 'utf8');
      }
      results.push({ name: mutation.name, what: mutation.what ?? '', ...result });
      console.log(`${result.status.padEnd(10)}${mutation.name.padEnd(46)}${String(result.seconds).padStart(3)}s  ${mutation.what ?? ''}\n           ${result.note.slice(0, 200)}`);
    }
    const count = (status) => results.filter((entry) => entry.status === status).length;
    const summary = { total: results.length, killed: count('KILLED'), survived: count('SURVIVED'), equivalent: count('EQUIVALENT'), invalid: count('INVALID'), error: count('ERROR'), notApplicable: count('N/A') };
    console.log(`\nSUMMARY: ${summary.killed} killed, ${summary.survived} survived, ${summary.equivalent} equivalent, ${summary.invalid} invalid, ${summary.error} error${summary.notApplicable ? `, ${summary.notApplicable} n/a` : ''} (of ${summary.total} mutations)`);
    if (summary.survived) console.log(`SURVIVED: ${results.filter((entry) => entry.status === 'SURVIVED').map((entry) => entry.name).join(', ')}`);
    if (summary.invalid) console.log(`INVALID: ${results.filter((entry) => entry.status === 'INVALID').map((entry) => entry.name).join(', ')}`);
    if (opts.json) await writeFile(opts.json, `${JSON.stringify({ summary, results }, null, 2)}\n`, 'utf8');
    return summary.survived + summary.invalid + summary.error === 0 ? 0 : 1;
  } finally {
    if (opts.keep) console.log(`Kept the mutated copy at ${copy}`);
    else await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

process.exitCode = await main();
