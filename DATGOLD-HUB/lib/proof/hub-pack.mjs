// The proof packs of the Hub (plan task P5 pod-33, docs/PROOF-HUB-API.md): at the end of a run that was judged by the done-gate (./gate.mjs) the Hub builds the pack of the
// conversation with the builder `chatmcp verify pack` uses (./pack-build.mjs) and keeps the latest one per task under its own proof folder.
//
// AgentRunner asks HubPacks at three places of a run's end: early() (is there anything to build, as far as it is known before the final tree), prepare() (while the task still
// holds the workspace: the ledger, the acceptance bytes and the final tree, read now) and start() (the build, in the background, once the task has let go of everything).
// What can go wrong is a reason of PACK_REASONS and never an error of the task. A pack is written only when
//   - its final tree is the tree ProofService.end() recorded for this run, taken again by the builder after everything else was read;
//   - readPackFile, the check a third party runs, accepts the bytes.
// The build is bounded in time and size, is given up when the Hub stops or the task is deleted, and gives way to a run that needs the workspace's baseline lock (giveWay).
import fs from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic } from '../fs-safe.mjs';
import { treeKey } from '../agent-progress.mjs';
import { VERSION } from '../manager.mjs';
import { loadBaseline } from './baseline.mjs';
import { readPackFile } from './cli/check.mjs';
import { ledgerPath, verifyChain } from './ledger.mjs';
import { CRITERION_STATUS } from './pack.mjs';
import { buildPackBytes } from './pack-build.mjs';
import { VERDICTS, verdictOf } from './render/model.mjs';

export const PACK_EVENT = 'proof_pack';
export const PACKS_FOLDER = 'packs';
/** The folder of the scratch files of the builds, beside the packs (the gate's own folder is the gate's). */
const SCRATCH_FOLDER = 'scratch';
const SCRATCH_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const PACK_AGENT = 'DatGold';
/** What a task says of the pack of its last run. */
export const PACK_STATUS = Object.freeze({ ready: 'ready', building: 'building', none: 'none' });
/** Whether a pack starts at the tree the task's first run started on, or at a baseline that was taken later. */
export const PACK_COVERAGE = Object.freeze({ task: 'task', baseline: 'baseline' });
/** Why the last run of a task has no pack: the closed list of docs/PROOF-HUB-API.md. */
export const PACK_REASONS = Object.freeze([
  // known before the final tree
  'run_in_progress', 'run_not_completed', 'unsupported', 'subagent', 'no_acceptance', 'acceptance_untrusted', 'acceptance_invalid', 'acceptance_lost', 'no_checks',
  'readonly', 'plan_mode', 'sandbox_only', 'no_shell', 'proof_unavailable', 'state_inside_workspace', 'gate_error', 'no_baseline',
  // found when it was built
  'final_tree_unknown', 'final_tree_changed', 'ledger_broken', 'baseline_unreadable', 'baseline_busy', 'not_a_repository', 'repository_unreadable', 'git_missing', 'object_format_changed',
  'old_bytes_unreadable', 'patch_too_large', 'pack_too_large', 'pack_not_verified', 'write_failed', 'build_failed',
  // given up
  'timeout', 'superseded', 'hub_stopped', 'task_deleted', 'interrupted',
  // found when it is asked for
  'building', 'pack_missing', 'not_recorded', 'companion',
]);
export const PACK_LIMITS = Object.freeze({
  timeoutMs: 120_000, // one build
  maxBytes: 64 * 1024 * 1024, // a pack file the Hub writes or reads (the format allows 256 MiB): building and checking one holds the Hub's only thread
  maxPatchBytes: 32 * 1024 * 1024,
  lockMs: 30_000, // the wait for the lock of the workspace's baselines
  giveWayMs: 5000, // how long a run that needs that lock waits for a build before it is given up
  stopMs: 5000, // how long a stop of the Hub or a delete waits for a build that was given up
});

const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const fault = (code, message = code) => Object.assign(new Error(message), { code });
const positive = (value) => Number.isSafeInteger(value) && value >= 1;
const isTime = (value) => typeof value === 'string' && !Number.isNaN(Date.parse(value));

// ------------------------------------------------------------------------------------------------------------------ what a task says of its pack
/** The facts of a stored pack as a task file holds them, or null when they are not such facts. */
function loadedPack(value) {
  if (!isObject(value) || !positive(value.run) || !isTime(value.at) || typeof value.digest !== 'string' || !DIGEST.test(value.digest)) return null;
  if (!VERDICTS.includes(value.verdict) || !Object.hasOwn(PACK_COVERAGE, value.coverage) || ![true, false, null].includes(value.checksModified)) return null;
  if (!Number.isSafeInteger(value.bytes) || value.bytes < 0 || !isObject(value.counts) || Object.keys(value.counts).length !== CRITERION_STATUS.length) return null;
  if (!CRITERION_STATUS.every((status) => Number.isSafeInteger(value.counts[status]) && value.counts[status] >= 0)) return null;
  const { run, at, digest, verdict, checksModified, coverage, bytes } = value;
  return { run, at, digest, verdict, counts: Object.fromEntries(CRITERION_STATUS.map((status) => [status, value.counts[status]])), checksModified, coverage, bytes };
}

/**
 * task.proof as a task file holds it, or null when it is none (a task of an older Hub, an edited file). A pack that was being built, and a run that was going on, when the
 * Hub ended are `interrupted`; `ready` without a whole record of that run's pack is none.
 */
export function loadedProof(value) {
  if (!isObject(value) || !Object.hasOwn(PACK_STATUS, value.status) || !positive(value.run) || !isTime(value.at)) return null;
  const pack = loadedPack(value.pack);
  const { run, at } = value;
  if (value.status === PACK_STATUS.ready) return pack?.run === run ? { status: value.status, reason: null, run, at, pack } : { status: PACK_STATUS.none, reason: 'not_recorded', run, at, pack: null };
  if (value.status === PACK_STATUS.building || value.reason === 'run_in_progress') return { status: PACK_STATUS.none, reason: 'interrupted', run, at, pack };
  return PACK_REASONS.includes(value.reason) ? { status: PACK_STATUS.none, reason: value.reason, run, at, pack } : null;
}

/** What the public task says: the last run's status and reason, and the facts of its pack (null without one); `earlier` is a stored pack of an earlier run. */
export function publicProof(proof, { summary = false } = {}) {
  if (!proof) return null;
  const { status, reason, run, at, pack } = proof;
  const own = status === PACK_STATUS.ready ? pack : null;
  if (summary) return { status, reason, run, verdict: own?.verdict ?? null };
  return {
    status, reason, run, at, digest: own?.digest ?? null, verdict: own?.verdict ?? null, counts: own?.counts ?? null, checksModified: own?.checksModified ?? null, coverage: own?.coverage ?? null,
    earlier: !own && pack ? { run: pack.run, at: pack.at, digest: pack.digest, verdict: pack.verdict } : null,
  };
}

// ------------------------------------------------------------------------------------------------------------------ the files
/** The folder of the Hub's packs, for every manager (a second chat too): beside the owner's trust list it was handed, where paths are short. */
export const packsDirectory = (manager) => path.join(path.dirname(manager.acceptanceTrustStore().file), PACKS_FOLDER);

/** The pack files: `<directory>/<task id>/<first 16 hex digits of the digest>.pack.json`. No path is made of an id or a digest that was not checked. */
export class PackStore {
  constructor(directory, { maxBytes = PACK_LIMITS.maxBytes } = {}) {
    this.directory = directory;
    this.maxBytes = maxBytes;
  }

  #folder(taskId) {
    if (typeof taskId !== 'string' || !TASK_ID.test(taskId)) throw fault('bad_task_id', 'not a task id');
    return path.join(this.directory, taskId);
  }

  file(taskId, digest) {
    const folder = this.#folder(taskId);
    if (typeof digest !== 'string' || !DIGEST.test(digest)) throw fault('bad_digest', 'not a digest');
    return path.join(folder, `${digest.slice(0, 16)}.pack.json`);
  }

  async write(taskId, digest, bytes) {
    const file = this.file(taskId, digest);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFileAtomic(file, bytes, { mode: 0o600 });
  }

  /** The bytes of a stored pack, or null when there is none. Throws pack_too_large, not_a_file or what the file system says. */
  async read(taskId, digest) {
    const file = this.file(taskId, digest);
    let handle;
    try { handle = await fs.open(file, 'r'); } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
      throw error?.code === 'EISDIR' ? fault('not_a_file', 'a folder in the place of a pack') : error;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw fault('not_a_file', 'not a regular file in the place of a pack');
      if (stat.size > this.maxBytes) throw fault('pack_too_large', 'a pack over the limit');
      return await handle.readFile();
    } finally { await handle.close().catch(() => {}); }
  }

  /** Removes every other file of the task's folder: earlier packs, and what a Hub that died while it wrote one left behind. */
  async keepOnly(taskId, digest) {
    const keep = path.basename(this.file(taskId, digest));
    const folder = this.#folder(taskId);
    for (const name of await fs.readdir(folder).catch(() => [])) {
      if (name !== keep) await fs.rm(path.join(folder, name), { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    }
  }

  async remove(taskId) {
    await fs.rm(this.#folder(taskId), { recursive: true, force: true, maxRetries: 3 });
  }
}

// ------------------------------------------------------------------------------------------------------------------ the build
/** The reason of a build that failed with `error`. */
export function reasonOf(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  if (['baseline_missing', 'baseline_edited', 'baseline_mismatch', 'baseline_bad_record', 'baseline_wrong_workspace', 'baseline_bad_id', 'baseline_bad_anchor'].includes(code)) return 'baseline_unreadable';
  // (a plain folder, or a repository Git could not be used on, has no old bytes either: not_a_repository, repository_unreadable and git_missing are reasons of their own)
  if (['baseline_objects_missing', 'baseline_objects_mismatch', 'baseline_objects_unreadable', 'patch_does_not_reproduce', 'store_object_mismatch'].includes(code)) return 'old_bytes_unreadable';
  if (code === 'workspace_changed' || code === 'baseline_store_mismatch') return 'final_tree_changed';
  if (code === 'workspace_too_large') return 'final_tree_unknown';
  if (code === 'pack_ledger_broken') return 'ledger_broken';
  if (['pack_unreadable', 'pack_invalid', 'pack_digest_mismatch', 'pack_file_mismatch'].includes(code)) return 'pack_not_verified';
  return PACK_REASONS.includes(code) ? code : 'build_failed';
}

/** Whether the baseline `record` is the tree the task's ledger starts on. */
function coverageOf(ledgerBytes, record) {
  for (const line of ledgerBytes.subarray(0, 1 << 20).toString('utf8').split('\n')) {
    let entry;
    try { entry = JSON.parse(line); } catch { break; }
    if (entry?.type !== 'tree') continue;
    return entry.record?.event === 'task_start' && treeKey(entry.record.tree) !== null && treeKey(entry.record.tree) === treeKey(record) ? PACK_COVERAGE.task : PACK_COVERAGE.baseline;
  }
  return PACK_COVERAGE.baseline;
}

/** The task whose ledger a pack carries (the task_start record the proof service wrote), or null. */
export const taskOfPack = (entries) => (entries[0]?.type === 'task_start' && typeof entries[0].record?.taskId === 'string' ? entries[0].record.taskId : null);

/** Builds and checks the pack of a run from what prepare() read. Resolves {bytes, facts}. Writes nothing but scratch files; throws what reasonOf() names. */
export async function buildHubPack({ taskId, number, inputs, ledgerBytes, final, model, cost, secrets, limits, signal }) {
  const { hubDir, root, env, baseline, acceptance, current, trustStore, changes } = inputs;
  const { record } = await loadBaseline({ hubDir, root, id: baseline.id, expectSha256: baseline.sha256 });
  const coverage = coverageOf(ledgerBytes, record);
  // The report on the checks reads the workspace before the diff takes the final tree: a file that changed meanwhile shows in that tree.
  const report = await changes();
  signal.throwIfAborted();
  const built = await buildPackBytes({
    hubDir, root, baselineId: baseline.id, anchor: baseline.sha256, env, scratch: null, acceptanceBytes: acceptance, readCurrent: async () => current, trustStore, ledgerBytes,
    agent: { name: PACK_AGENT, version: VERSION }, model, cost: coverage === PACK_COVERAGE.task ? cost : null, secrets, checkChanges: async () => report,
    onDiff: (diff) => { if (treeKey(diff.final) !== treeKey(final)) throw fault('final_tree_changed', 'the workspace is not the tree the run ended on'); },
    lock: { waitMs: limits.lockMs }, diffLimits: { maxPatchBytes: limits.maxPatchBytes }, maxBytes: limits.maxBytes, signal,
  });
  // What the Hub writes, `chatmcp verify check` accepts: the same function reads it here first. (Both halves hold the Hub's only thread while they run; others get a turn between.)
  await new Promise((resolve) => { setImmediate(resolve); });
  signal.throwIfAborted();
  const read = readPackFile(built.packBytes, { maxBytes: limits.maxBytes });
  if (read.digest !== built.digest || taskOfPack(read.entries) !== taskId) throw fault('pack_not_verified', 'the pack read back is not the one that was built');
  const { predicate } = built.statement;
  const { kind } = verdictOf(predicate.criteria);
  const counts = Object.fromEntries(CRITERION_STATUS.map((status) => [status, predicate.criteria.filter((criterion) => criterion.status === status).length]));
  return {
    bytes: built.packBytes,
    facts: {
      run: number, at: new Date().toISOString(), digest: built.digest, verdict: kind, counts,
      checksModified: predicate.checkChanges.reported ? predicate.checkChanges.checksModified : null, coverage, bytes: built.packBytes.length,
    },
  };
}

const textOrNull = (value) => (typeof value === 'string' && value ? value : null);
/** The known cost of the task's own model calls: priced at the owner's rates, all of it; an estimate from the catalog is not known. Whole only when every call was priced and no other agent was started. */
function costOf(task, manager) {
  const ledger = task.modelCost;
  if (!isObject(ledger) || ledger.approximate === true || !(ledger.pricedResponses > 0) || !Number.isFinite(ledger.knownSubtotalUsd) || ledger.knownSubtotalUsd < 0 || ledger.knownSubtotalUsd > 1e9) return null;
  const agents = typeof manager.listSubagents === 'function' ? manager.listSubagents(task.id).length : 0;
  return { currency: 'USD', knownSubtotal: ledger.knownSubtotalUsd, complete: ledger.complete === true && agents === 0 };
}

// The builds that go on, per workspace, for the whole process: a run that needs the lock of the workspace's baselines is not the one that waits (giveWay).
const builds = new Map();
const rootKey = (root) => (process.platform === 'win32' ? path.resolve(root).toLowerCase() : path.resolve(root));
const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref(); });

/** Waits a moment for the builds of the workspace `root`, then gives up those that go on. Called by the done-gate before it takes a baseline. Never throws. */
export async function giveWay(root, { signal = null } = {}) {
  const going = [...(builds.get(rootKey(root)) ?? [])];
  if (!going.length) return;
  const stopped = signal ? new Promise((resolve) => { signal.addEventListener('abort', resolve, { once: true }); }) : new Promise(() => {});
  await Promise.race([Promise.all(going.map((build) => build.settled)), wait(Math.max(...going.map((build) => build.giveWayMs))), stopped]);
  for (const build of going) if (!build.done) build.controller.abort(fault('superseded', 'a run needs the workspace'));
}

/** `promise`, or the reason of `signal` as soon as it aborts; what the promise does later is nobody's. */
function unless(signal, promise) {
  promise.catch(() => {});
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** A manager whose runs the done-gate can judge (lib/proof/gate.mjs). */
const supported = (manager) => manager?.backend === 'local' && typeof manager.hubDirectory === 'string' && typeof manager.proofService === 'function' && typeof manager.acceptanceTrustStore === 'function'
  && typeof manager.studio?.resolve === 'function' && Boolean(manager.localTools);
const SKIPPED = Object.freeze({ untrusted: 'acceptance_untrusted', invalid: 'acceptance_invalid', no_checks: 'no_checks', readonly: 'readonly', plan_mode: 'plan_mode', sandbox_only: 'sandbox_only', no_shell: 'no_shell' });

export class HubPacks {
  /**
   * @param {object} options
   * @param {object} options.manager  the manager the agent runs on
   * @param {object} options.gate     its DoneGate
   * @param {(line: string) => void} [options.log]
   * @param {Partial<typeof PACK_LIMITS>} [options.limits]
   * @param {object} [options.deps]   {build}, for tests
   */
  constructor({ manager, gate, log = () => {}, limits = {}, deps = {} } = {}) {
    this.manager = manager;
    this.gate = gate;
    this.log = log;
    this.limits = { ...PACK_LIMITS, ...limits };
    this.deps = { build: buildHubPack, ...deps };
    this.running = new Map(); // task id -> the build that goes on
  }

  /** The files; null when the manager has no data folder for them. */
  get store() { return supported(this.manager) ? new PackStore(packsDirectory(this.manager)) : null; }

  /** Why a run that ended as `task` says has no pack, as far as it is known before its final tree; null when one is to be built. `run` is the gate's state of the run. */
  early(task, run) {
    if (task.status !== 'completed') return 'run_not_completed';
    if (!supported(this.manager)) return 'unsupported';
    if (this.manager.lifecycleAgent?.kind === 'subagent') return 'subagent';
    if (!run) return 'no_acceptance';
    const judged = task.proofGate;
    if (!judged) return 'gate_error';
    if (judged.status === 'skipped') return SKIPPED[judged.reason] ?? 'gate_error';
    if (run.unusable) return PACK_REASONS.includes(run.unusable) ? run.unusable : 'gate_error';
    if (['proof_unavailable', 'state_inside_workspace'].includes(judged.reason)) return judged.reason;
    return run.baseline ? null : 'no_baseline';
  }

  /**
   * What the build of this run's pack needs, read while the task still holds the workspace: {reason}, or the job start() takes. `ended` is what ProofService.end() resolved
   * with. A build of an earlier run of the task is given up.
   */
  async prepare({ task, run, number, ended }) {
    const { manager } = this;
    await this.stop(task.id, 'superseded');
    const service = manager.proofService();
    if (!service) return { reason: 'proof_unavailable' };
    if (service.disabled) return { reason: 'state_inside_workspace' };
    const ledgerBytes = await fs.readFile(ledgerPath(manager.hubDirectory, task.id)).catch(() => null);
    if (!ledgerBytes) return { reason: 'ledger_broken' };
    if (!ended) return { reason: verifyChain(ledgerBytes).ok ? 'final_tree_unknown' : 'ledger_broken' };
    if (treeKey(ended.tree) === null) return { reason: 'final_tree_unknown' };
    if (ledgerBytes.length > this.limits.maxBytes) return { reason: 'pack_too_large' };
    await this.#sweep();
    return {
      taskId: task.id, number, inputs: await this.gate.packInputs({ run, task, scratchDir: path.join(packsDirectory(manager), SCRATCH_FOLDER) }), ledgerBytes, final: ended.tree, cost: costOf(task, manager),
      model: { provider: textOrNull(task.provider), id: textOrNull(task.model), profileRevision: textOrNull(task.effectiveProfile?.revision) },
      secrets: (manager.secrets ?? []).filter((secret) => typeof secret === 'string'),
    };
  }

  /** What a Hub that died while it built a pack left of its scratch files. Never throws. */
  async #sweep() {
    const folder = path.join(packsDirectory(this.manager), SCRATCH_FOLDER);
    for (const name of await fs.readdir(folder).catch(() => [])) {
      const stat = await fs.stat(path.join(folder, name)).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > SCRATCH_MAX_AGE_MS) await fs.rm(path.join(folder, name), { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    }
  }

  /** Builds and writes the pack of `job` in the background, then calls `settle({facts} or {reason})`. Returns at once; the promise (never rejected) ends after `settle`. */
  start(job, settle) {
    const controller = new AbortController();
    const build = { controller, done: false, giveWayMs: this.limits.giveWayMs, settled: null };
    const key = rootKey(job.inputs.root);
    if (!builds.has(key)) builds.set(key, new Set());
    builds.get(key).add(build);
    this.running.set(job.taskId, build);
    build.settled = (async () => {
      const result = await this.#build(job, controller);
      // from here on nothing of the workspace is used: whoever waits for the folder may go on
      build.done = true;
      builds.get(key)?.delete(build);
      if (!builds.get(key)?.size) builds.delete(key);
      try { await settle(result); } catch (error) { this.log(`Gói bằng chứng: không lưu được kết quả (${error?.code ?? error?.message}).`); }
      if (this.running.get(job.taskId) === build) this.running.delete(job.taskId);
    })();
    return build.settled;
  }

  async #build(job, controller) {
    const { signal } = controller;
    const timer = setTimeout(() => controller.abort(fault('timeout', 'the pack took too long')), this.limits.timeoutMs);
    try {
      const { bytes, facts } = await unless(signal, Promise.resolve().then(() => this.deps.build({ ...job, limits: this.limits, signal })));
      signal.throwIfAborted();
      const { store } = this;
      try { await store.write(job.taskId, facts.digest, bytes); } catch (error) { throw fault('write_failed', String(error?.code ?? error?.message)); }
      signal.throwIfAborted();
      return { facts };
    } catch (error) {
      const reason = signal.aborted ? reasonOf(signal.reason) : reasonOf(error);
      this.log(`Gói bằng chứng của tác vụ ${job.taskId}: không có (${reason}${error?.code && error.code !== reason ? `, ${error.code}` : ''}).`);
      return { reason };
    } finally { clearTimeout(timer); }
  }

  /** Gives up the build of `taskId` that goes on, if any, and waits for it (a build stops at once; its write, if it has begun, ends first). Never throws. */
  async stop(taskId, why) {
    const build = this.running.get(taskId);
    if (!build) return;
    if (!build.controller.signal.aborted) build.controller.abort(fault(why, why));
    await Promise.race([build.settled, wait(this.limits.stopMs)]);
  }

  async stopAll(why) {
    await Promise.all([...this.running.keys()].map((taskId) => this.stop(taskId, why)));
  }

  /** The packs of a task that is deleted. Never throws. */
  async forget(taskId) {
    try { await this.store?.remove(taskId); } catch (error) { this.log(`Gói bằng chứng: không xóa được (${error?.code ?? error?.message}).`); }
  }
}
