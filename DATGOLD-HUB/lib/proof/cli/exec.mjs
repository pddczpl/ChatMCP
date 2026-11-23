// `chatmcp verify exec`: the exec wrapper for any external agent (P5 pod-26, docs/PROOF-CLI.md, "exec"). In order:
//   1. the acceptance file must be there and trusted (nothing runs otherwise); the agent's words are joined as `run` joins them;
//   2. the snapshot: a new proof session, as `snapshot` starts one (the workspace must be a Git repository: the pack needs a patch);
//   3. the agent runs in the workspace through the shell, its standard input closed, with a time limit, its whole process tree killed at
//      the limit, on Ctrl-C (after a grace) and when its root exits leaving processes behind;
//   4. its exit, its duration and the sha256 and size of each output stream are recorded, the streams are kept in the evidence folder;
//   5. the claim is read from the end of its final message (the marker contract of lib/proof/marker.mjs, or --claim-marker), from its
//      stdout or from what an adapter (lib/proof/adapters/index.mjs) found in its documented JSON output; the run and the claim are one
//      `call` record of the session's ledger (exec's closed shape of it, kind agent_exec);
//   6. the criteria: the trusted checks of the baseline's acceptance file, each recorded with recordCheck as `run` records one;
//   7. the pack, as `pack` builds it.
// The commands' shared steps (the workspace and state folder, the session start, the pack) come from commands.mjs as `steps`, so this
// module does not import it back.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { maskSecrets } from '../../permissions.mjs';
import { powerShellChildEnvironment } from '../../powershell-environment.mjs';
import { ShellRunner, killTree } from '../../shell-runner.mjs';
import { processTreeLeft, windowsProcessTree } from '../../studio-terminal.mjs';
import { ACCEPTANCE_FILE, ACCEPTANCE_LIMITS, acceptanceSha256, resolveAcceptance } from '../acceptance.mjs';
import { ADAPTERS, readAgentOutput } from '../adapters/index.mjs';
import { COMMAND_CHARS, EXEC_CALL_FORMAT, EXEC_CALL_KIND, EXEC_CALL_TEXT, ProofLedger, ToolchainProbe, commandSha256, recordCheck } from '../ledger.mjs';
import { finalLine, parseFinalMarker } from '../marker.mjs';
import { TreeSnapshotter } from '../tree-snapshot.mjs';
import { createTrustStore } from '../trust-store.mjs';
import { joinCommand } from './args.mjs';
import { stop } from './codes.mjs';
import { readAcceptance } from './session.mjs';

/**
 * The format of the agent's `call` record in the session's ledger: exec's own closed shape of `call` (kind agent_exec), beside the proof
 * service's tool calls (pod-17); lib/proof/ledger.mjs holds both shapes.
 */
export const EXEC_FORMAT = EXEC_CALL_FORMAT;
/** The claim is read from at most the last 64 KiB of the agent's stdout. */
export const CLAIM_WINDOW_BYTES = 64 * 1024;
/** Each output stream is kept in the evidence folder up to 16 MiB; its sha256 and its size cover every byte. */
export const LOG_MAX_BYTES = 16 * 1024 * 1024;
/** The final line is recorded, and tested against --claim-marker, up to 1,000 characters. */
export const CLAIM_LINE_MAX = 1000;
/** How long a --claim-marker pattern may run on the final line. */
export const CLAIM_MARKER_TIMEOUT_MS = 1000;
/** After the first Ctrl-C the agent has this long to stop on its own before its tree is killed. */
export const INTERRUPT_GRACE_MS = 5000;
const KILL_GRACE_MS = 4000;
const LINGER_MS = 1500;
const SIGNALS = Object.freeze(['SIGINT', 'SIGTERM', 'SIGBREAK']);
const PATCH_CODES = new Set(['not_a_repository', 'repository_unreadable', 'git_missing']);
const SETTLED = new Set(['evidenced', 'owner_accepted']);
const AGAINST = new Set(['failed', 'checks_modified']);

// --------------------------------------------------------------------------------------------------------------------------- the claim
/**
 * The text the claim is read from, out of the last bytes of stdout (`window`) and the size of the whole stream (`total`): the whole
 * stream when the window holds all of it; otherwise only the lines that lie wholly inside the window (what follows its first line break),
 * because the line the window starts in began before it. A cut stream is never read as a marker it does not end with.
 */
export function claimText(window, total) {
  if (total <= window.length) return window.toString('utf8');
  const lf = window.indexOf(0x0a);
  return lf < 0 ? '' : window.subarray(lf + 1).toString('utf8');
}

const context = vm.createContext({});
/** Runs `pattern` on `line` with a time limit: true, false, or 'timeout' for a pattern that backtracks without end. */
function testWithin(pattern, line) {
  context.pattern = pattern;
  context.line = line;
  try { return vm.runInContext('pattern.test(line)', context, { timeout: CLAIM_MARKER_TIMEOUT_MS }) === true; } catch (error) {
    if (error?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') return 'timeout';
    throw error;
  } finally {
    delete context.pattern;
    delete context.line;
  }
}

/**
 * The claim of a final message: {marker: 'DONE' | 'BLOCKED' | null, reason, rule, pattern, line, markerTimedOut}. Without `pattern` the
 * marker contract decides (parseFinalMarker). With `pattern` (--claim-marker, compiled by compileClaimMarker) a final line it matches is
 * the claim DONE and the contract's DONE no longer counts; `BLOCKED: <reason>` stays the contract's either way, so a custom marker never
 * turns BLOCKED into DONE. `line` is the final line, cut to 1,000 characters (null when it is empty); a longer line is not tested.
 */
export function readClaim(text, { pattern = null } = {}) {
  const line = finalLine(text);
  const base = { rule: pattern ? 'claim-marker' : 'contract', pattern: pattern ? (pattern.claimMarker ?? pattern.source) : null, line: line ? line.slice(0, CLAIM_LINE_MAX) : null, markerTimedOut: false };
  const contract = parseFinalMarker(text);
  if (contract.marker === 'BLOCKED') return { marker: 'BLOCKED', reason: contract.reason, ...base };
  if (!pattern) return { marker: contract.marker, reason: null, ...base };
  if (line.length > CLAIM_LINE_MAX) return { marker: null, reason: null, ...base };
  const tested = testWithin(pattern, line);
  return { marker: tested === true ? 'DONE' : null, reason: null, ...base, markerTimedOut: tested === 'timeout' };
}

// --------------------------------------------------------------------------------------------------------------------------- the criteria
/**
 * The criteria step: each runnable check of the baseline's acceptance file (resolveAcceptance().runnable) is run `repeat` times, or until
 * its first run that does not pass, through `recordOne(check)` (which records one receipt with recordCheck and resolves {receipt,
 * entry}). A pass is the exit the file expects, in time, not cancelled and not ended by a signal; the pack decides the criterion's status
 * from the receipts themselves. A check that cannot start (its folder is gone) has no receipt and names why. `signal` stops the step
 * before the next run. This is the seam for the check runner of pod-21 (lib/proof/check-runner.mjs): a later change can replace this one
 * function. Resolves {results: [{criterion, index, run, cwd, attempt, seq, exit, timedOut, passed, error}], interrupted}.
 */
export async function runCriteria({ runnable, recordOne, signal = null }) {
  const results = [];
  for (const check of runnable) {
    const expectExit = check.expect?.exit ?? 0;
    for (let attempt = 0; attempt < (check.repeat ?? 1); attempt += 1) {
      if (signal?.aborted) return { results, interrupted: true }; // before the next run
      const row = { criterion: check.criterionId, index: check.index, run: check.run, cwd: check.cwd, attempt };
      let recorded;
      try { recorded = await recordOne(check); } catch (error) {
        if (signal?.aborted) return { results, interrupted: true }; // the run was stopped: no receipt
        results.push({ ...row, seq: null, exit: null, timedOut: false, passed: false, error: String(error?.code ?? 'check_failed_to_start').slice(0, 64) });
        break;
      }
      const { receipt, entry } = recorded;
      const passed = receipt.exit === expectExit && !receipt.timedOut && !receipt.cancelled && receipt.signal === null;
      results.push({ ...row, seq: entry.seq, exit: receipt.exit, timedOut: receipt.timedOut, passed, error: null });
      if (!passed) break;
    }
  }
  return { results, interrupted: signal?.aborted === true };
}

// --------------------------------------------------------------------------------------------------------------------------- the agent
/** One output stream of the agent: hashed and counted whole, written to its log up to LOG_MAX_BYTES, its last bytes kept for the claim. */
export class StreamEvidence {
  constructor(file) {
    this.hash = createHash('sha256');
    this.bytes = 0;
    this.logged = 0;
    this.tail = [];
    this.tailBytes = 0;
    this.failure = null;
    this.out = fs.createWriteStream(file, { flags: 'wx' });
    this.out.on('error', (error) => { this.failure ??= error; });
  }

  push(chunk) {
    this.hash.update(chunk);
    this.bytes += chunk.length;
    if (this.logged < LOG_MAX_BYTES) {
      const part = chunk.subarray(0, LOG_MAX_BYTES - this.logged);
      this.out.write(part);
      this.logged += part.length;
    }
    this.tail.push(chunk);
    this.tailBytes += chunk.length;
    if (this.tailBytes > CLAIM_WINDOW_BYTES * 2) {
      const merged = Buffer.concat(this.tail);
      this.tail = [merged.subarray(merged.length - CLAIM_WINDOW_BYTES)];
      this.tailBytes = this.tail[0].length;
    }
  }

  /** The last CLAIM_WINDOW_BYTES of the stream (all of it when it is shorter). */
  window() {
    const merged = Buffer.concat(this.tail);
    return merged.length > CLAIM_WINDOW_BYTES ? merged.subarray(merged.length - CLAIM_WINDOW_BYTES) : merged;
  }

  async close() {
    if (!this.out.closed) await new Promise((resolve) => { this.out.once('close', resolve); this.out.end(); });
    if (this.failure) throw this.failure;
  }

  summary() {
    return { sha256: this.hash.copy().digest('hex'), bytes: this.bytes, logged: this.logged, truncated: this.bytes > this.logged };
  }
}

/**
 * The environment of the agent: the person's own (an agent needs its credentials, so nothing is scrubbed, unlike a check's), with what
 * keeps the words of the command line unchanged on their way through Git Bash on Windows, and without the PowerShell 7 module path that
 * breaks Windows PowerShell (lib/powershell-environment.mjs), as ShellRunner gives its shells.
 */
function agentEnvironment(env, shellName, platform) {
  const out = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined));
  if (platform === 'win32' && shellName !== 'powershell') Object.assign(out, { MSYS_NO_PATHCONV: '1', MSYS2_ARG_CONV_EXCL: '*', CHERE_INVOKING: '1' });
  return platform === 'win32' ? powerShellChildEnvironment({}, out) : out;
}

/**
 * How long the sweep after the root exited waits for what it finds to be gone by itself before it counts it as left. A process killed
 * with its group (killTree at the timeout or after Ctrl-C, or SIGKILL'ed with its parent) stays a member of the group, and a row of
 * the process table, until it has been reaped; on Windows taskkill may still be finishing the tree after the root exited. Measured on
 * Linux: a killed group was gone within 11 ms in 300 of 300 trials, and answered at once in 138 of them.
 */
export const REAP_WAIT_MS = 2000;
const REAP_POLL_MS = 25;
const TABLE_POLL_MS = 250;
const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
/** The agent's process group on Linux and macOS (it leads its own): whether any member is there, and SIGKILL to all of them. */
const processGroup = Object.freeze({
  alive(pid) { try { process.kill(-pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; } },
  kill(pid) { try { process.kill(-pid, 'SIGKILL'); } catch { /* it ended in between */ } },
});

/**
 * What is left of the agent's tree once its root exited, killed: on Linux and macOS its process group, on Windows the processes the
 * process table links to the root by parent id and creation time. What is still there is looked at again until it is gone or
 * REAP_WAIT_MS have passed; only what is still there then counts as left, and is killed. Resolves whether anything was left, or null when
 * Windows could not list its processes. `group`, `table`, `now` and `pause` are for tests.
 */
export async function reapTree({ pid, spawnedAt, platform = process.platform, group = processGroup, table = windowsProcessTree, now = Date.now, pause = delay }) {
  if (!Number.isInteger(pid)) return false;
  const until = now() + REAP_WAIT_MS;
  if (platform !== 'win32') {
    while (group.alive(pid)) {
      if (now() >= until) { group.kill(pid); return true; }
      await pause(REAP_POLL_MS);
    }
    return false;
  }
  for (;;) {
    const rows = await table.list();
    if (!rows) return null;
    const left = (processTreeLeft(rows, pid, spawnedAt) ?? []).filter((row) => row.pid !== pid);
    if (!left.length) return false;
    if (now() >= until) {
      await Promise.all(left.map((row) => table.kill(row.pid)));
      return true;
    }
    await pause(TABLE_POLL_MS);
  }
}

/** Ctrl-C (SIGINT), SIGTERM and Ctrl-Break while exec runs the agent and the checks: counted, and the running step is told. */
export class Interrupts {
  constructor(signals) {
    this.signals = signals;
    this.count = 0;
    this.controller = new AbortController();
    this.onAgent = null;
    this.handler = () => {
      this.count += 1;
      this.controller.abort();
      this.onAgent?.(this.count);
    };
  }

  get signal() { return this.controller.signal; }
  listen() { for (const name of SIGNALS) this.signals.on(name, this.handler); }
  stop() { for (const name of SIGNALS) this.signals.removeListener(name, this.handler); }
}

/**
 * Runs the agent: `invocation` (ShellRunner.buildInvocation) in `root`, standard input closed, stdout and stderr into their evidence
 * (and to `echo` as they come). At `timeoutMs` its tree is killed (killTree). On the first interrupt, Linux and macOS pass SIGINT to its
 * process group (on Windows the console already gave every process of the tree its Ctrl-C) and the tree is killed after
 * INTERRUPT_GRACE_MS; a second interrupt kills it at once.
 */
async function runAgent({ invocation, root, env, timeoutMs, interrupts, echo, logs, platform = process.platform }) {
  const out = new StreamEvidence(logs.stdout);
  const err = new StreamEvidence(logs.stderr);
  const state = { timedOut: false, stuck: false, spawnError: null };
  const started = Date.now();
  let child;
  try {
    child = spawn(invocation.file, invocation.args, { cwd: root, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: platform !== 'win32' });
  } catch (error) {
    await Promise.all([out.close(), err.close(), invocation.cleanup?.()]);
    throw stop('shell_unavailable', { shell: null, message: String(error?.message ?? error).slice(0, 500) });
  }
  child.stdout.on('data', (chunk) => { out.push(chunk); echo?.stdout(chunk); });
  child.stderr.on('data', (chunk) => { err.push(chunk); echo?.stderr(chunk); });
  child.stdout.on('error', () => {});
  child.stderr.on('error', () => {});
  let finish;
  const finished = new Promise((resolve) => { finish = resolve; });
  let exitInfo = null;
  let lingerTimer = null;
  let hardStop = null;
  let graceTimer = null;
  const destroyStreams = () => { child.stdout.destroy(); child.stderr.destroy(); };
  child.once('error', (error) => { state.spawnError = error; finish({ code: null, signal: null, lingering: false }); });
  // A process of the tree that holds the pipes would keep "close" from firing; once the root exited the streams get a moment to drain.
  child.once('exit', (code, signal) => {
    exitInfo = { code, signal };
    lingerTimer = setTimeout(() => { destroyStreams(); finish({ ...exitInfo, lingering: true }); }, LINGER_MS);
  });
  child.once('close', (code, signal) => finish({ ...(exitInfo ?? { code, signal }), lingering: false }));
  const kill = () => {
    killTree(child);
    hardStop ??= setTimeout(() => { state.stuck = true; destroyStreams(); finish({ code: null, signal: 'SIGKILL', lingering: false }); }, KILL_GRACE_MS);
  };
  const timer = setTimeout(() => { state.timedOut = true; kill(); }, timeoutMs);
  interrupts.onAgent = (count) => {
    if (count > 1) { kill(); return; }
    if (platform !== 'win32') { try { process.kill(-child.pid, 'SIGINT'); } catch { /* it ended */ } }
    graceTimer ??= setTimeout(kill, INTERRUPT_GRACE_MS);
  };
  if (interrupts.count > 0) interrupts.onAgent(interrupts.count);
  let exit;
  try {
    exit = await finished;
  } finally {
    clearTimeout(timer);
    clearTimeout(lingerTimer);
    clearTimeout(hardStop);
    clearTimeout(graceTimer);
    interrupts.onAgent = null;
    await invocation.cleanup?.();
  }
  const durationMs = Date.now() - started;
  const treeLeft = state.spawnError ? false : await reapTree({ pid: child.pid, spawnedAt: started, platform });
  await Promise.all([out.close(), err.close()]);
  if (state.spawnError) throw stop('shell_unavailable', { shell: null, message: String(state.spawnError.message).slice(0, 500) });
  return {
    exit: exit.code, signal: exit.signal, timedOut: state.timedOut, interrupted: interrupts.count > 0, lingering: exit.lingering, stuck: state.stuck,
    treeLeft, durationMs, timeoutMs, out, err,
  };
}

// --------------------------------------------------------------------------------------------------------------------------- the answer
/** `text` cut to `max` UTF-16 units, never inside a surrogate pair. */
const cutText = (text, max) => {
  if (text.length <= max) return text;
  const end = max - (/[\ud800-\udbff]/.test(text[max - 1]) ? 1 : 0);
  return text.slice(0, end);
};
/** A free text of the record masked, then cut to its bound in the ledger's schema (masking can make a text longer); null stays null. */
const fit = (text, max) => (text === null ? null : cutText(maskSecrets(text, []), max));

/** The answer code of an exec, first match wins: Ctrl-C, the time limit, the agent's own failure, then its claim against the criteria. */
export function outcomeOf(agent, claim, criteria) {
  if (agent.interrupted) return 'exec_interrupted';
  if (agent.timedOut) return 'agent_timed_out';
  if (agent.exit !== 0 || agent.signal !== null) return 'agent_failed';
  if (claim.marker === 'BLOCKED') return 'agent_blocked';
  if (claim.marker !== 'DONE') return 'no_claim';
  if (criteria.some((criterion) => AGAINST.has(criterion.status))) return 'claim_refuted';
  return criteria.length > 0 && criteria.every((criterion) => SETTLED.has(criterion.status)) ? 'exec_evidenced' : 'claim_unverified';
}

/** The adapter's reading, or what is recorded when the output was too large to hand to it. */
async function adapterReading(name, run, logs) {
  if (!run.out.summary().truncated) return readAgentOutput(name, await fsp.readFile(logs.stdout, 'utf8'));
  const adapter = ADAPTERS[name];
  return { adapter: name, version: adapter.version, checked: adapter.checked, recognized: false, reason: 'output_too_large', finalMessage: null, cost: null, model: null, agentVersion: null, isError: null };
}

/** chatmcp verify exec [--shell] [--timeout] [--claim-marker] [--cost-usd] [--adapter] [--agent] [--agent-version] -- <agent command> */
export async function execCommand(ctx, steps) {
  const { options, words } = ctx.args;
  const { root, state, shim } = await steps.place(ctx);
  // 1. a trusted acceptance file, and the agent's command line: checked before anything is written or runs
  const found = await readAcceptance(shim);
  if (found.state === 'outside') throw stop('acceptance_outside');
  if (found.state !== 'present') throw stop('acceptance_missing', { file: ACCEPTANCE_FILE });
  steps.parsedOrStop(found.bytes);
  const acceptanceSha = acceptanceSha256(found.bytes);
  if ((await createTrustStore(state.hubDir).isTrusted(acceptanceSha)) !== true) {
    const where = ctx.args.workspace ? ` --workspace ${JSON.stringify(root)}` : '';
    throw stop('not_trusted', { file: ACCEPTANCE_FILE, sha256: acceptanceSha, trustCommand: `chatmcp verify trust --sha256 ${acceptanceSha}${where}` });
  }
  const runner = new ShellRunner({ workspace: shim, stateDirectory: state.shellState, env: ctx.env, secrets: () => [] });
  const shell = await steps.resolveShell(runner, options.shell);
  const command = joinCommand(words, shell.name);
  if (command.length > runner.maxCommandChars || command.includes('\0')) throw stop('bad_command', { max: runner.maxCommandChars });

  // 2. the snapshot: a new session, on a repository (the pack needs a patch)
  const session = await steps.startSession(ctx, { root, state, shim, source: 'chatmcp verify exec' });
  if (session.acceptance.sha256 !== acceptanceSha) throw stop('workspace_changed');
  const reason = session.record.patch.reason;
  if (session.record.patch.available !== true) throw stop(PATCH_CODES.has(reason) ? reason : 'not_a_repository');
  const evidence = state.evidence(session.taskId);
  await fsp.mkdir(evidence, { recursive: true });
  const logs = { stdout: path.join(evidence, 'stdout.log'), stderr: path.join(evidence, 'stderr.log') };
  const ledger = new ProofLedger({ file: session.ledgerFile, now: () => ctx.now() });

  const interrupts = new Interrupts(ctx.signals ?? process);
  const echo = ctx.json ? null : { stdout: (chunk) => ctx.stdout?.write(chunk), stderr: (chunk) => ctx.stderr?.write(chunk) };
  let run;
  let claim;
  let adapter = null;
  let cost = null;
  let costSource = null;
  let agent;
  let model = null;
  let entry;
  let criteriaRun = { results: [], interrupted: false };
  interrupts.listen();
  try {
    // 3, 4. the agent
    const invocation = await runner.buildInvocation(shell, command);
    run = await runAgent({ invocation, root, env: agentEnvironment(ctx.env, shell.name, process.platform), timeoutMs: options.timeoutSeconds * 1000, interrupts, echo, logs });
    // 5. the claim, from the adapter's reading of the documented output or from stdout as text
    let message = null;
    if (options.adapter) {
      const read = await adapterReading(options.adapter, run, logs);
      adapter = { name: read.adapter, version: read.version, checked: read.checked, recognized: read.recognized, reason: read.reason, isError: read.isError, model: read.model, agentVersion: read.agentVersion };
      if (read.recognized) message = read.finalMessage ?? '';
      if (read.cost) [cost, costSource] = [read.cost, 'adapter'];
      if (read.model) model = { provider: null, id: read.model, profileRevision: null };
    }
    if (options.costUsd !== null) [cost, costSource] = [{ currency: 'USD', knownSubtotal: options.costUsd, complete: true }, 'option'];
    const read = readClaim(message ?? claimText(run.out.window(), run.out.bytes), { pattern: options.claimMarker });
    // the free texts are masked, then cut to the bounds of exec's shape of `call`; the digests and the fixed words are left as they are
    claim = { ...read, reason: fit(read.reason, EXEC_CALL_TEXT.claim), pattern: fit(read.pattern, EXEC_CALL_TEXT.claim), line: fit(read.line, EXEC_CALL_TEXT.claim),
      from: message === null ? 'stdout' : 'adapter' };
    agent = { name: fit(options.agent ?? options.adapter ?? 'unknown', EXEC_CALL_TEXT.name), version: fit(options.agentVersion ?? adapter?.agentVersion ?? 'unknown', EXEC_CALL_TEXT.name) };
    if (adapter) adapter = { ...adapter, model: fit(adapter.model, EXEC_CALL_TEXT.name), agentVersion: fit(adapter.agentVersion, EXEC_CALL_TEXT.name) };
    const shownCommand = maskSecrets(command, []);
    const record = {
      kind: EXEC_CALL_KIND, format: EXEC_FORMAT, command: cutText(shownCommand, COMMAND_CHARS), commandTruncated: shownCommand.length > COMMAND_CHARS, commandSha256: commandSha256(command),
      shell: shell.name, cwd: '.', agent, exit: run.exit, signal: run.signal, timedOut: run.timedOut, interrupted: run.interrupted, lingering: run.lingering, stuck: run.stuck,
      treeLeft: run.treeLeft, durationMs: run.durationMs, timeoutMs: run.timeoutMs, stdout: run.out.summary(), stderr: run.err.summary(), claim, adapter,
      cost: cost ?? 'unknown', costSource,
    };
    entry = await ledger.append('call', record);
    // 6. the criteria, unless the person stopped exec
    if (!run.interrupted) {
      const acceptance = await resolveAcceptance({ baseline: session.acceptanceBytes, current: null, trustStore: createTrustStore(state.hubDir) });
      const checkRunner = new ShellRunner({ workspace: shim, stateDirectory: state.shellState, env: ctx.env, secrets: () => [], maxTimeoutMs: ACCEPTANCE_LIMITS.timeout.max * 1000 });
      const checkShell = await steps.resolveShell(checkRunner, null);
      const snapshotter = new TreeSnapshotter({ root, stateDir: state.treeState, env: ctx.env });
      const toolchain = new ToolchainProbe({ env: ctx.env });
      criteriaRun = await runCriteria({
        runnable: acceptance.runnable, signal: interrupts.signal,
        recordOne: (check) => recordCheck({ ledger, runner: checkRunner, snapshotter, toolchain, command: check.run, cwd: check.cwd, shell: checkShell.name, timeoutMs: check.timeout * 1000, signal: interrupts.signal, secrets: [] }),
      });
    }
  } finally {
    interrupts.stop();
  }
  const interrupted = run.interrupted || criteriaRun.interrupted;

  // 7. the pack
  const packed = interrupted ? null : await steps.buildPack(ctx, { root, state, shim, agent, model, cost });
  const criteria = packed?.criteria ?? [];
  const agentData = {
    name: agent.name, version: agent.version, exit: run.exit, signal: run.signal, timedOut: run.timedOut, interrupted, lingering: run.lingering, treeLeft: run.treeLeft,
    durationMs: run.durationMs, timeoutMs: run.timeoutMs, stdout: run.out.summary(), stderr: run.err.summary(),
  };
  const code = outcomeOf(agentData, claim, criteria);
  const notEvidenced = criteria.filter((criterion) => !SETTLED.has(criterion.status)).length;
  const data = {
    taskId: session.taskId, baselineId: session.base.id, command: maskSecrets(command.slice(0, 8192), []), commandTruncated: command.length > 8192, shell: shell.name,
    agent: agentData, claim, adapter, cost: cost ?? 'unknown', costSource, record: { seq: entry.seq, hash: entry.hash },
    checks: criteriaRun.results, criteria, checksModified: packed ? packed.statement.predicate.checkChanges.checksModified : null,
    pack: packed ? { file: packed.file, packFile: packed.packFile, digest: packed.digest, receipts: packed.statement.predicate.receipts.length, changes: packed.changes } : null,
    statement: packed?.statement ?? null,
    paths: { session: state.session, ledger: session.ledgerFile, baseline: session.base.file, acceptanceCopy: session.acceptanceBytes ? state.acceptanceCopy(session.taskId) : null, evidence, stdoutLog: logs.stdout, stderrLog: logs.stderr },
  };
  const seconds = (ms) => (ms / 1000).toFixed(1);
  const lines = [
    `  agent: ${run.timedOut ? 'timed out' : run.signal ? `signal ${run.signal}` : `exit ${run.exit}`} after ${seconds(run.durationMs)} s; claim ${claim.marker ?? 'none'}${claim.reason ? `: ${claim.reason}` : ''} (${claim.from})`,
    ...criteria.map((criterion) => `  ${criterion.id}: ${criterion.status}`),
    `  logs: ${evidence}`,
  ];
  // without --json the answer follows the agent's own output: on a line of its own, also after output that does not end with one
  const openLine = echo !== null && run.out.bytes > 0 && run.out.window().at(-1) !== 0x0a;
  return {
    code, data, lines, stdout: openLine ? '\n' : undefined,
    params: {
      total: criteria.length, notEvidenced, refuted: criteria.filter((criterion) => AGAINST.has(criterion.status)).length, file: packed?.file ?? null, reason: claim.reason,
      exit: run.exit, signal: run.signal, timedOut: false, cancelled: false, timeoutSeconds: options.timeoutSeconds,
    },
  };
}
