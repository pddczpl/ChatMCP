// The check runner of Proof-of-Done (plan task pod-21, docs/PROOF-CHECKS.md): runs the criterion checks of `.chatmcp/acceptance.yml`
// through ShellRunner and records every attempt as one check receipt of the pod-16 ledger (./ledger.mjs, checkReceipt).
//
// What runs: only the checks of the BASELINE file (the file as it was when the task started), only when the owner trusted that file's
// sha256 (./acceptance.mjs, resolveAcceptance), and only while the file in the workspace is still those bytes. An untrusted file, a file
// edited since the baseline and no file run nothing. The runner does not ask PermissionGate: the owner approved these exact commands by
// the file's sha256, and a check that asked again would be a second approval of the same text.
//
// How: one check at a time, in the file's order. An attempt is the pod-15 tree before (./tree-snapshot.mjs), ShellRunner.run (scrubbed
// environment, closed stdin, the command's tree killed on timeout and cancel, its timeout capped at the runner's maxTimeoutMs), the
// processes the command left behind reaped, the tree after, the toolchain versions, and one `check` line in the ledger. A failing
// attempt is never run again: a re-run could hide the failure. An attempt that passed but changed the tree is run again on the new tree,
// at most TREE_RERUNS times; a check still changing the tree after that is unreliable. A passing attempt that left the tree as it was
// counts towards `repeat`; a change of the tree starts the count again.
//
// The roll-up is pack.mjs's own (rollUpCriteria): the criteria of the report are exactly those of a pack built from the same ledger,
// final tree, acceptance result and check-changes report. A pass counts only when its run started and ended on the final tree.
import fs from 'node:fs/promises';
import { maskSecrets } from '../permissions.mjs';
import { MAX_TIMEOUT_MS } from '../shell-runner.mjs';
import { windowsProcessTree } from '../studio-terminal.mjs';
import { resolveAcceptance } from './acceptance.mjs';
import { checkReceipt, treeRef } from './ledger.mjs';
import { rollUpCriteria } from './pack.mjs';

export const CHECK_RUN_FORMAT = 'chatmcp.check-run/1';
/** Re-runs of a check whose passing attempt changed the tree; one more change makes it unreliable. */
export const TREE_RERUNS = 2;
const WATCH_GAP_MS = 250; // between two reads of the Windows process table while an attempt runs
const REAP_ROUNDS = 3; // kill-and-look-again rounds of the Windows reaper
const SLACK_MS = 2000; // clock slack between the moment a shell was spawned and its creation time in the process table
const GROUP_WAIT_MS = 1000; // how long the POSIX reaper waits for a signalled process group to be gone
const ERROR_CHARS = 300;

const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const key = (row) => `${row.pid}@${row.created}`;

/**
 * The processes of the tree of a shell with pid `rootPid`, spawned at `spawnedAt` (ms), in a process table `rows` ([{pid, ppid, created}],
 * the union of every read; null when unreadable gives null). Windows keeps the parent pid of an orphan, so a row is the shell's when the
 * holder of its parent pid AT ITS CREATION (the latest process with that pid created no later than it) is the shell's: a pid reused by a
 * newer process does not adopt the children of that process. The shell is its own row when the table saw it (created within the clock
 * slack of spawnedAt), else a stand-in created at spawnedAt less the slack. Oldest first.
 */
export function processTreeOf(rows, rootPid, spawnedAt, slackMs = SLACK_MS) {
  if (!Array.isArray(rows)) return null;
  const unique = new Map();
  for (const row of rows) {
    if (Number.isInteger(row?.pid) && Number.isInteger(row?.ppid) && Number.isFinite(row?.created)) unique.set(key(row), row);
  }
  const list = [...unique.values()].sort((a, b) => a.created - b.created || a.pid - b.pid);
  const holders = new Map();
  for (const row of list) {
    if (!holders.has(row.pid)) holders.set(row.pid, []);
    holders.get(row.pid).push(row);
  }
  const rootRow = (holders.get(rootPid) ?? []).find((row) => Math.abs(row.created - spawnedAt) <= slackMs) ?? null;
  const root = rootRow ?? { pid: rootPid, created: spawnedAt - slackMs };
  const parentOf = (row) => {
    const candidates = [...(holders.get(row.ppid) ?? []), ...(row.ppid === rootPid && !rootRow ? [root] : [])];
    let best = null;
    for (const holder of candidates) if (holder !== row && holder.created <= row.created && (!best || holder.created > best.created)) best = holder;
    return best;
  };
  const ours = new Set([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const row of list) {
      if (ours.has(row)) continue;
      const parent = parentOf(row);
      if (parent && ours.has(parent)) { ours.add(row); grew = true; }
    }
  }
  return list.filter((row) => ours.has(row));
}

/** Windows: reads the process table again and again while an attempt runs, so a parent that exits before the attempt ends is still known. */
function watchTable(processTree) {
  const rows = [];
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      const table = await processTree.list().catch(() => null);
      if (table) rows.push(...table);
      if (!stopped) await pause(WATCH_GAP_MS);
    }
  })();
  return { rows, stop: async () => { stopped = true; await loop; } };
}

/**
 * Kills what an attempt left behind and says what it found: {method, left, leftovers}. `left` is true when something of the shell's tree
 * was still alive after the shell exited (null: unknown); `leftovers` the pids still alive after the last round ([] none, null unknown).
 * POSIX: the shell led its own process group (ShellRunner spawns it detached), which is signalled as a whole; a process that left the
 * group (setsid) is not reached. Windows: the process table, read while the attempt ran and after it, walked by processTreeOf; every live
 * process of the tree is killed with its own tree, a few rounds; a process whose whole chain of parents exited unseen is not reached.
 */
export async function reapAttempt({ pid, spawnedAt, rows = [], platform = process.platform, processTree = windowsProcessTree }) {
  if (!Number.isInteger(pid)) return { method: null, left: null, leftovers: null };
  if (platform !== 'win32') {
    const exists = () => { try { process.kill(-pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
    if (!exists()) return { method: 'process-group', left: false, leftovers: [] };
    try { process.kill(-pid, 'SIGKILL'); } catch { /* gone in between */ }
    for (const until = Date.now() + GROUP_WAIT_MS; Date.now() < until; await pause(25)) {
      if (!exists()) return { method: 'process-group', left: true, leftovers: [] };
    }
    return { method: 'process-group', left: true, leftovers: null };
  }
  const seen = [...rows];
  let left = false;
  for (let round = 0; ; round += 1) {
    const table = await processTree.list();
    if (!table) return { method: 'process-table', left: left || null, leftovers: null };
    seen.push(...table);
    const now = new Set(table.map(key));
    const alive = (processTreeOf(seen, pid, spawnedAt) ?? []).filter((row) => now.has(key(row)));
    if (!alive.length) return { method: 'process-table', left, leftovers: [] };
    left = true;
    if (round === REAP_ROUNDS) return { method: 'process-table', left, leftovers: alive.map((row) => row.pid) };
    for (const row of alive) await processTree.kill(row.pid);
  }
}

async function takeTree(snapshotter, signal, options = {}) {
  if (!snapshotter) return null;
  try { return await snapshotter.snapshot({ ...options, signal }); } catch (error) {
    if (signal?.aborted) throw error;
    return { status: 'failed', engineReason: String(error?.code ?? 'snapshot_failed') };
  }
}

/** true or false when both trees are known and comparable, null otherwise. */
function treeChanged(before, after) {
  if (!before?.tree || !after?.tree || before.treeAlgorithm !== after.treeAlgorithm || before.objectFormat !== after.objectFormat) return null;
  return before.tree !== after.tree;
}

const passedRun = (receipt, expectExit) => receipt.exit === expectExit && !receipt.timedOut && !receipt.cancelled && receipt.signal === null;

/**
 * One attempt of one check: recordCheck of ./ledger.mjs with the left-behind processes reaped before the tree after is taken, and the
 * tree after taken even when the attempt was cancelled (so the cancelled run is recorded). Resolves {attempt} or, when ShellRunner refused
 * the command before it ran (a missing folder, no shell), {error}; nothing is recorded then.
 */
async function runAttempt({ check, number, timeoutMs, options }) {
  const { runner, ledger, snapshotter, toolchain, signal, maxOutputBytes, secrets, platform, processTree } = options;
  const startedAt = Date.now();
  const treeBefore = await takeTree(snapshotter, signal);
  const watch = platform === 'win32' ? watchTable(processTree) : null;
  const spawnedAt = Date.now();
  let result;
  try {
    result = await runner.run({ command: check.run, cwd: check.cwd === '.' ? '' : check.cwd, timeoutMs, maxOutputBytes, signal });
  } catch (error) {
    await watch?.stop();
    if (signal?.aborted) throw error;
    return { error: { code: String(error?.code ?? 'run_failed'), message: maskSecrets(String(error?.message ?? error), secrets).slice(0, ERROR_CHARS) } };
  }
  await watch?.stop();
  const reap = await reapAttempt({ pid: result.pid, spawnedAt, rows: watch?.rows ?? [], platform, processTree });
  const treeAfter = await takeTree(snapshotter, null);
  const versions = toolchain ? await toolchain.versions((await runner.workspace.resolve('')).root) : null;
  const receipt = checkReceipt({ command: check.run, result, toolchain: versions, treeBefore, treeAfter, secrets });
  const entry = await ledger.append('check', receipt);
  return {
    attempt: {
      criterionId: check.criterionId, index: check.index, attempt: number, seq: entry.seq, hash: entry.hash,
      passed: passedRun(receipt, check.expect.exit), treeChanged: treeChanged(receipt.treeBefore, receipt.treeAfter),
      exit: receipt.exit, signal: receipt.signal, timedOut: receipt.timedOut, cancelled: receipt.cancelled, lingering: receipt.lingering,
      durationMs: receipt.durationMs, startedAt, endedAt: Date.now(), reap,
    },
  };
}

/**
 * Runs the checks of a task's acceptance file and rolls them up.
 *   baseline, current, trustStore   as resolveAcceptance takes them (the baseline bytes are the only source of checks)
 *   runner      a ShellRunner of the workspace; ledger  the task's ProofLedger
 *   snapshotter a TreeSnapshotter of the workspace, or null (then nothing is rolled up: no run is fresh against an unknown tree)
 *   toolchain   a ToolchainProbe, or null; checkChanges  the pod-22 report, or an async function giving it after the runs, or null
 *   signal      cancels the running attempt and every check after it; maxOutputBytes  ShellRunner's capture budget
 * Resolves {format, blocked, cancelled, acceptance, finalTree, checks, attempts, criteria, ledger} (docs/PROOF-CHECKS.md). Throws for
 * what it cannot run at all: a baseline that does not read (AcceptanceError), a ledger that refuses a record.
 */
export async function runAcceptanceChecks({ baseline = null, current = null, trustStore, runner, ledger, snapshotter = null, toolchain = null, checkChanges = null,
  signal = null, maxOutputBytes, platform = process.platform, processTree = windowsProcessTree } = {}) {
  if (!runner || typeof runner.run !== 'function') throw new TypeError('runAcceptanceChecks needs a ShellRunner');
  if (!ledger || typeof ledger.append !== 'function' || typeof ledger.file !== 'string') throw new TypeError('runAcceptanceChecks needs the task\'s ProofLedger');
  const acceptance = await resolveAcceptance({ baseline, current, trustStore });
  const edited = acceptance.edit !== null;
  const blocked = acceptance.blocked ?? (edited ? 'acceptance_edited' : null);
  const secrets = runner.secrets?.() ?? [];
  const maxTimeoutMs = Number.isSafeInteger(runner.maxTimeoutMs) ? runner.maxTimeoutMs : MAX_TIMEOUT_MS;
  const options = { runner, ledger, snapshotter, toolchain, signal, maxOutputBytes, secrets, platform, processTree };
  const runnable = blocked ? [] : acceptance.runnable;
  const checks = runnable.map((check) => {
    const requested = check.timeout * 1000;
    return { criterionId: check.criterionId, index: check.index, attempts: 0, unreliable: false, error: null, timeoutMs: Math.min(requested, maxTimeoutMs), timeoutCapped: requested > maxTimeoutMs };
  });
  const attempts = [];
  run: for (const [position, check] of runnable.entries()) {
    const row = checks[position];
    let settled = 0;
    let changes = 0;
    for (let number = 1; ; number += 1) {
      let done;
      // An aborted signal stops the tree snapshot before a run, or the run itself (ShellRunner throws before it starts): nothing
      // more starts. A run it cut short is recorded as cancelled, did not pass, and is the last one.
      try { done = await runAttempt({ check, number, timeoutMs: row.timeoutMs, options }); } catch (error) {
        if (signal?.aborted) break run;
        throw error;
      }
      if (done.error) { row.error = done.error; break; }
      row.attempts += 1;
      attempts.push(done.attempt);
      if (!done.attempt.passed) break; // never run again: a re-run could hide the failure
      if (done.attempt.treeChanged === true) {
        changes += 1; settled = 0; // the passes before the change were on another tree
        if (changes > TREE_RERUNS) { row.unreliable = true; break; }
        continue;
      }
      settled += 1;
      if (settled >= check.repeat) break;
    }
  }
  const cancelled = signal?.aborted === true;
  const final = await takeTree(snapshotter, null, { full: true });
  const finalKnown = final?.status === 'ok' && typeof final.tree === 'string';
  let criteria = null;
  let ledgerSummary = null;
  if (finalKnown) {
    const ledgerBytes = await fs.readFile(ledger.file).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    const report = typeof checkChanges === 'function' ? await checkChanges({ finalTree: final }) : checkChanges;
    ({ criteria, ledger: ledgerSummary } = rollUpCriteria({ after: final, acceptance, checkChanges: report ?? null, ledger: ledgerBytes, secrets }));
  }
  return {
    format: CHECK_RUN_FORMAT,
    blocked,
    cancelled,
    acceptance: { baselineSha256: acceptance.baselineSha256, trusted: acceptance.trusted, edited },
    finalTree: finalKnown ? treeRef(final) : null,
    checks,
    attempts,
    criteria,
    ledger: ledgerSummary,
  };
}
