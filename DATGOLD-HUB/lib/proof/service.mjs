// The proof service of Proof-of-Done (plan task pod-17, docs/PROOF-SERVICE.md): the proof ledger of a task (lib/proof/ledger.mjs), written
// at the single guard seam, HubManager.#guardCalls. Every caller reaches its tools through that seam (the agent, the Browser Companion, a
// side chat or spawned agent in its own HubManager, the MCP host), so every one of them is covered without knowing about this module.
//
// One service per HubManager and workspace; the ledger is per task, <hubDir>/proof/<taskId>.jsonl. For one run of a task:
//   begin(taskId)    task_start (only when the ledger is new: a resumed task continues its chain), the uncertain records of a run that
//                    died before it (recovery), and a full tree snapshot (`tree`, event task_start or run_start)
//   beforeCall(...)  for a call the gate allowed in a category that can change files (scannedCall): a cached snapshot, `tree` call_start
//   afterCall(...)   a cached snapshot again and the `call` record: treeBefore, treeAfter, changed; returned for the guard's onProof
//   end(taskId)      a full snapshot (`tree`, event task_end) and task_end, also when the task was cancelled or failed
// A Hub that died between those leaves a ledger that ends without them; recover() (the next load of the task, or the next begin) writes
// what is missing as `uncertain` records. The tree ids go to the ledger and to the guard's caller, never into a tool's result.
//
// Budget: a scan costs 0.1 to 0.9 s on an ordinary workspace (docs/PROOF-TREE.md). When the mean of the scans around the calls of a run is
// over SCAN_BUDGET.meanScanMs, the run switches to `checks-only` (no per-call scans from then on; checks, the task's start and its end are
// still recorded) and the ledger says so with an `uncertain` record.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { LEDGER_FOLDER, ProofLedger, treeRef, verifyChain } from './ledger.mjs';
import { TreeSnapshotter } from './tree-snapshot.mjs';
import { workspaceKey } from './baseline.mjs';

export const SERVICE_FORMAT = 'chatmcp.proof-service/1';
/** The categories of PermissionGate whose allowed calls are scanned; `external` only for a server the owner flagged touchesWorkspace. */
export const SCANNED_CATEGORIES = Object.freeze(['workspace_edit', 'dangerous', 'execute', 'unknown']);
export const GRANULARITY = Object.freeze({ calls: 'calls', checksOnly: 'checks-only' });
/** The mean scan time (ms) above which a run switches to checks-only, and the number of scans the decision waits for. */
export const SCAN_BUDGET = Object.freeze({ meanScanMs: 1500, minScans: 2 });
export const TREE_EVENTS = Object.freeze(['task_start', 'run_start', 'call_start', 'task_end']);
export const UNCERTAIN_REASONS = Object.freeze({
  callInterrupted: 'call_interrupted',
  runInterrupted: 'run_interrupted',
  checksOnly: 'checks_only',
  callUnfinished: 'call_unfinished_at_end',
});
/** How long end() waits for a call that is still running (a stopped task does not wait for its tool) before it records it as unfinished. */
export const END_WAIT_MS = 15_000;
export const SNAPSHOT_FOLDER = 'snapshots';

/** Whether an allowed call of `category` is scanned. */
export function scannedCall({ category, touchesWorkspace = false } = {}) {
  if (category === 'external') return touchesWorkspace === true;
  return SCANNED_CATEGORIES.includes(category);
}

/** The ledger `file` read and checked: {report (verifyChain), entries: [{seq, type, record}] of the verified prefix}. A missing file is empty. */
export async function readLedgerEntries(file) {
  const bytes = await fs.readFile(file).catch((error) => { if (error?.code === 'ENOENT') return Buffer.alloc(0); throw error; });
  const report = verifyChain(bytes);
  const entries = bytes.subarray(0, report.verifiedBytes).toString('utf8').split('\n').filter(Boolean)
    .map((line) => { const { seq, type, record } = JSON.parse(line); return { seq, type, record }; });
  return { report, entries };
}

const inside = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};
const caseKey = (file) => (process.platform === 'win32' ? file.toLowerCase() : file);
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });
const meanOf = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0);
const comparable = (before, after) => Boolean(before?.tree && after?.tree && before.treeAlgorithm === after.treeAlgorithm && before.objectFormat === after.objectFormat);
/** What a caller is told of a tree reference: its ids and what they can be compared by. */
const idsOf = (ref) => (ref ? { status: ref.status, treeAlgorithm: ref.treeAlgorithm, objectFormat: ref.objectFormat, tree: ref.tree, rawTree: ref.rawTree } : null);

// One snapshotter per state folder for the whole process: two services on one folder (a manager made again for the same workspace) must not
// write one temporary index at the same time. Calls on one TreeSnapshotter are serialised. At most SNAPSHOTTERS are kept.
const SNAPSHOTTERS = 32;
const snapshotters = new Map();
function sharedSnapshotter(stateDir, root, options) {
  const key = caseKey(stateDir);
  let snapshotter = snapshotters.get(key);
  if (!snapshotter || snapshotter.root !== root) {
    snapshotter = new TreeSnapshotter({ root, stateDir, ...options });
    snapshotters.delete(key);
    snapshotters.set(key, snapshotter);
    while (snapshotters.size > SNAPSHOTTERS) snapshotters.delete(snapshotters.keys().next().value);
  }
  return snapshotter;
}

// The scanned calls in flight per workspace, for the whole process: a call that runs while another one does on the same folder (a second
// chat on the same checkout, parallel calls of an MCP client) cannot be told apart from it by its trees, and its record says `overlapped`.
const inFlight = new Map();

/** The uncertain records a ledger lacks: every run that has no end, every call_start of such a run that has no call record. */
function recoveryRecords(entries) {
  const runs = new Map();
  for (const { seq, type, record } of entries) {
    if (type === 'tree' && (record.event === 'task_start' || record.event === 'run_start')) { runs.set(record.run, { ended: false, open: new Map() }); continue; }
    const run = runs.get(record?.run);
    if (!run) continue;
    if (type === 'tree' && record.event === 'call_start') run.open.set(record.callId, { seq, record });
    else if (type === 'call') run.open.delete(record.callId);
    else if (type === 'uncertain' && [UNCERTAIN_REASONS.callInterrupted, UNCERTAIN_REASONS.callUnfinished].includes(record.reason)) run.open.delete(record.callId);
    else if (type === 'task_end' || (type === 'uncertain' && record.reason === UNCERTAIN_REASONS.runInterrupted)) run.ended = true;
  }
  const records = [];
  for (const [number, run] of runs) {
    if (run.ended) continue;
    for (const { seq, record } of run.open.values()) {
      records.push({ reason: UNCERTAIN_REASONS.callInterrupted, run: number, callId: record.callId, tool: record.tool, category: record.category, treeSeq: seq });
    }
    records.push({ reason: UNCERTAIN_REASONS.runInterrupted, run: number });
  }
  return records;
}

async function appendAll(ledger, type, records) {
  for (const record of records) await ledger.append(type, record);
  return records.length;
}

export class ProofService {
  /**
   * @param {object} options
   * @param {string} options.hubDir        the Hub's data folder of the manager (the ledgers are in its `proof` folder)
   * @param {string} options.root          the workspace the manager's tools work in (a side chat's worktree is its own)
   * @param {() => string[]} [options.secrets]  registered secrets, masked in every record (the ledger's masker)
   * @param {() => number} [options.clock] milliseconds, for the scan times the budget is decided on
   * @param {Partial<typeof SCAN_BUDGET>} [options.budget]
   * @param {(line: string) => void} [options.log]
   * @param {object} [options.snapshotter] a TreeSnapshotter (the shared one of the state folder when left out)
   */
  constructor({ hubDir, root, secrets = () => [], clock = () => performance.now(), budget = {}, log = () => {}, snapshotter = null, git, env, endWaitMs = END_WAIT_MS } = {}) {
    if (typeof hubDir !== 'string' || !hubDir || typeof root !== 'string' || !root) throw new TypeError('ProofService needs hubDir and root');
    this.hubDir = path.resolve(hubDir);
    this.root = path.resolve(root);
    this.secrets = secrets;
    this.clock = clock;
    this.log = log;
    this.endWaitMs = endWaitMs;
    this.budget = { ...SCAN_BUDGET, ...budget };
    // Every ledger line written inside the workspace would change the tree it records (docs/PROOF-BASELINE.md: the caller refuses such a folder).
    this.disabled = inside(this.root, this.hubDir) ? 'state_inside_workspace' : null;
    this.stateDir = path.join(this.hubDir, LEDGER_FOLDER, SNAPSHOT_FOLDER, workspaceKey(this.root));
    this.snapshotter = this.disabled ? null : (snapshotter ?? sharedSnapshotter(this.stateDir, this.root, { git, env }));
    this.task = null;
    this.placed = null;
  }

  /** The task whose calls are recorded now, or null. */
  get active() { return this.task?.id ?? null; }
  /** The granularity of the current run, or null. */
  get granularity() { return this.task?.granularity ?? null; }

  /**
   * The start of a run of `taskId`: task_start when the ledger is new, the uncertain records of a run that died before, and the full snapshot
   * of the run's start. Resolves with {run, resumed, seq} (seq of that snapshot's record), or null when nothing is recorded (the service is
   * disabled, the ledger is broken or cannot be written). Never throws: a cancelled snapshot is recorded as failed, and the caller stops.
   */
  async begin(taskId, { signal = null } = {}) {
    if (this.disabled || !(await this.#outside())) return null;
    if (this.task?.id === taskId) return { run: this.task.run, resumed: this.task.run > 1, seq: null };
    let ledger;
    let read;
    try {
      ledger = ProofLedger.forTask(this.hubDir, taskId, { secrets: this.secrets });
      read = await readLedgerEntries(ledger.file);
    } catch (error) { this.#warn(taskId, error); return null; }
    if (!read.report.ok && read.report.reason !== 'torn_tail') { this.#warn(taskId, { code: 'ledger_broken' }); return null; }
    const run = read.entries.filter(({ type, record }) => type === 'tree' && (record.event === 'task_start' || record.event === 'run_start')).length + 1;
    const task = { id: taskId, ledger, run, granularity: GRANULARITY.calls, scans: [], calls: 0, pending: new Set(), halted: null };
    // Set before the snapshot: a run stopped while it is taken still gets its end.
    this.task = task;
    try {
      await appendAll(ledger, 'uncertain', recoveryRecords(read.entries));
      if (!read.entries.length) await ledger.append('task_start', { format: SERVICE_FORMAT, taskId, workspace: this.root, granularity: GRANULARITY.calls, budgetMs: this.budget.meanScanMs });
      const { ref, ms } = await this.#scan({ full: true, signal });
      const entry = await ledger.append('tree', { event: run === 1 ? 'task_start' : 'run_start', run, callId: null, tool: null, category: null, tree: ref, scanMs: ms });
      return { run, resumed: run > 1, seq: entry.seq };
    } catch (error) { this.#halt(task, error); return null; }
  }

  /**
   * Before a call the gate allowed: a cached snapshot and its `tree` call_start record. Returns the token afterCall needs, or null when the
   * call is not recorded (another task, a category that is not scanned, checks-only, a ledger that failed). Throws only when `signal` aborted
   * during the snapshot: then the call must not run.
   */
  async beforeCall({ taskId, callId = null, name, category = null, touchesWorkspace = false, signal = null } = {}) {
    const task = this.task;
    if (!task || task.id !== taskId || task.halted || task.granularity !== GRANULARITY.calls || !scannedCall({ category, touchesWorkspace })) return null;
    const token = { service: this, task, callId: String(callId ?? `proof_${randomUUID()}`), name: String(name), category, before: null, beforeSeq: null, beforeMs: 0, overlapped: false, orphaned: false, done: deferred() };
    const key = caseKey(this.root);
    if (!inFlight.has(key)) inFlight.set(key, new Set());
    const peers = inFlight.get(key);
    if (peers.size) { token.overlapped = true; for (const peer of peers) peer.overlapped = true; }
    peers.add(token);
    task.pending.add(token);
    const { ref, ms } = await this.#scan({ signal });
    if (signal?.aborted) { this.#release(token); throw signal.reason ?? Object.assign(new Error('The call was stopped.'), { code: 'cancelled' }); }
    task.scans.push(ms);
    try {
      const entry = await task.ledger.append('tree', { event: 'call_start', run: task.run, callId: token.callId, tool: token.name, category, tree: ref, scanMs: ms });
      Object.assign(token, { before: ref, beforeSeq: entry.seq, beforeMs: ms });
      return token;
    } catch (error) {
      this.#halt(task, error);
      this.#release(token);
      return null;
    }
  }

  /**
   * After the call (it returned, reported an error or threw: `outcome` ok | error | threw): a cached snapshot and the `call` record. Resolves
   * with what the guard hands to onProof ({seq, callId, tool, category, outcome, changed, overlapped, treeBefore, treeAfter, granularity}), or
   * null. Takes no signal: the call has run, so its effect is looked at even when the task was stopped meanwhile.
   */
  async afterCall(token, { outcome = 'ok' } = {}) {
    if (!token) return null;
    const { task } = token;
    try {
      if (token.orphaned || task.halted) return null;
      const { ref, ms } = await this.#scan({});
      if (token.orphaned) return null;
      task.scans.push(ms);
      const changed = comparable(token.before, ref) ? token.before.tree !== ref.tree : null;
      const entry = await task.ledger.append('call', {
        run: task.run, callId: token.callId, tool: token.name, category: token.category, outcome, treeBefore: token.before, treeAfter: ref,
        changed, overlapped: token.overlapped, scanMs: token.beforeMs + ms, beforeSeq: token.beforeSeq,
      });
      task.calls += 1;
      await this.#checkBudget(task);
      return {
        seq: entry.seq, callId: token.callId, tool: token.name, category: token.category, outcome, changed, overlapped: token.overlapped,
        treeBefore: idsOf(token.before), treeAfter: idsOf(ref), granularity: task.granularity,
      };
    } catch (error) {
      this.#halt(task, error);
      return null;
    } finally { this.#release(token); }
  }

  /**
   * The end of the run of `taskId`, whatever its status (completed, failed, cancelled ...): waits (at most endWaitMs) for a call that is still
   * running, records one that did not finish as uncertain, takes the full final snapshot and writes task_end. Resolves with {seq} of
   * task_end, or null when this service has no such run. Never throws.
   */
  async end(taskId, { status = 'unknown', errorCode = null } = {}) {
    const task = this.task;
    if (!task || task.id !== taskId) return null;
    this.task = null;
    if (task.pending.size) await Promise.race([Promise.allSettled([...task.pending].map((token) => token.done.promise)), delay(this.endWaitMs)]);
    if (task.halted) return null;
    try {
      for (const token of [...task.pending]) {
        token.orphaned = true;
        await task.ledger.append('uncertain', { reason: UNCERTAIN_REASONS.callUnfinished, run: task.run, callId: token.callId, tool: token.name, category: token.category, treeSeq: token.beforeSeq });
      }
      const { ref, ms } = await this.#scan({ full: true });
      await task.ledger.append('tree', { event: 'task_end', run: task.run, callId: null, tool: null, category: null, tree: ref, scanMs: ms });
      const entry = await task.ledger.append('task_end', {
        format: SERVICE_FORMAT, run: task.run, status: String(status), errorCode: errorCode ?? null, granularity: task.granularity,
        calls: task.calls, scans: task.scans.length, meanScanMs: Math.round(meanOf(task.scans)),
      });
      return { seq: entry.seq };
    } catch (error) {
      this.#halt(task, error);
      return null;
    }
  }

  /**
   * After a Hub that died: the uncertain records the ledger of `taskId` lacks (a call that started and has no record, a run that has no end).
   * Written once; resolves with how many were written (0 for no ledger, a broken one, or one that lacks nothing).
   */
  static async recover({ hubDir, taskId, secrets = () => [] } = {}) {
    const ledger = ProofLedger.forTask(hubDir, taskId, { secrets });
    const { report, entries } = await readLedgerEntries(ledger.file);
    if (!entries.length || (!report.ok && report.reason !== 'torn_tail')) return 0;
    return appendAll(ledger, 'uncertain', recoveryRecords(entries));
  }

  async #scan({ full = false, signal = null } = {}) {
    const started = this.clock();
    let snapshot;
    try {
      await fs.mkdir(this.stateDir, { recursive: true, mode: 0o700 });
      snapshot = await this.snapshotter.snapshot({ full, signal });
    } catch (error) {
      snapshot = { status: 'failed', engineReason: String(error?.code ?? 'snapshot_failed').slice(0, 64) };
    }
    return { ref: treeRef(snapshot), ms: Math.max(0, Math.round(this.clock() - started)) };
  }

  async #checkBudget(task) {
    if (task.granularity !== GRANULARITY.calls || task.scans.length < this.budget.minScans) return;
    const mean = meanOf(task.scans);
    if (!(mean > this.budget.meanScanMs)) return;
    task.granularity = GRANULARITY.checksOnly;
    await task.ledger.append('uncertain', { reason: UNCERTAIN_REASONS.checksOnly, run: task.run, granularity: GRANULARITY.checksOnly, meanScanMs: Math.round(mean), scans: task.scans.length, budgetMs: this.budget.meanScanMs });
    this.log(`Sổ bằng chứng: mỗi lần chụp cây thư mục mất trung bình ${Math.round(mean)} ms (quá ${this.budget.meanScanMs} ms); từ giờ tác vụ chỉ ghi các lần kiểm tra, không chụp quanh từng lời gọi.`);
  }

  /** Whether the Hub's data folder is outside the workspace, with both paths resolved on disk (a short 8.3 name, a junction). */
  async #outside() {
    if (this.placed === null) {
      const real = async (file) => {
        try { return await fs.realpath(file); } catch {
          const parent = path.dirname(file);
          return parent === file ? file : path.join(await real(parent), path.basename(file));
        }
      };
      const [hub, root] = await Promise.all([real(this.hubDir), real(this.root)]);
      this.placed = !inside(root, hub);
      if (!this.placed) this.disabled = 'state_inside_workspace';
    }
    return this.placed;
  }

  #release(token) {
    inFlight.get(caseKey(this.root))?.delete(token);
    token.task.pending.delete(token);
    token.done.resolve();
  }

  #halt(task, error) {
    if (task.halted) return;
    task.halted = String(error?.code ?? 'ledger_failed');
    this.#warn(task.id, error);
  }

  #warn(taskId, error) {
    this.log(`Sổ bằng chứng của tác vụ ${String(taskId).slice(0, 60)}: không ghi được (${error?.code ?? error?.message ?? 'lỗi'}); các lời gọi sau đó không được ghi vào sổ.`);
  }
}
