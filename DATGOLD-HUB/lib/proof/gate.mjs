// The done-gate of Proof-of-Done (plan task pod-23, docs/PROOF-GATE.md): the agent cannot finish "done" while the owner's trusted checks fail on its final tree.
//
// AgentRunner asks it at two places. begin(), before the first model turn of a run: which acceptance file the task is held to (the bytes of `.chatmcp/acceptance.yml` as
// they were when the conversation first met a trusted one, kept in the task's folder) and the baseline of the workspace the changes to the checks are judged against
// (lib/proof/baseline.mjs). review(), at every final answer, BEFORE the Stop / TaskCompleted hooks: runs the checks fresh through the check runner of pod-21
// (runAcceptanceChecks: receipts in the task's ledger, the strict pass rule) and says one of:
//   passed    every criterion with checks is evidenced on the final tree (or its checks were modified during the task, which is said beside it)
//   failed    a check did not pass, could not start, or the acceptance file was edited: the agent is sent back once with the results, a second failure ends the run
//   unproven  nothing failed, but the final tree is not shown to pass (an unstable check, an unknown tree, a broken ledger ...): no round, never a pass
//   skipped   no gate here: an untrusted or invalid file, Read Only, plan mode, sandbox-only, a Hub without a shell, only manual criteria
//   stale     (staleGate) the run ended on another tree than the one that passed
// The checks run without asking PermissionGate: the owner approved these exact commands by the file's sha256 (docs/PROOF-CHECKS.md). What they print is untrusted data
// for the model: masked whole, clipped, every line marked. A tree id never reaches the model.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeFileAtomic } from '../fs-safe.mjs';
import { maskSecrets } from '../permissions.mjs';
import { treeKey } from '../agent-progress.mjs';
import { ACCEPTANCE_FILE, ACCEPTANCE_MAX_BYTES, AcceptanceError, acceptanceSha256, parseAcceptance } from './acceptance.mjs';
import { baselineFolder, loadBaseline, snapshotBaseline } from './baseline.mjs';
import { runAcceptanceChecks } from './check-runner.mjs';
import { storeSide } from './cli/store-side.mjs';
import { MODE, blobId, findGit } from './git-plumbing.mjs';
import { ProofLedger, ToolchainProbe } from './ledger.mjs';
import { detectCheckChanges, workTreeSide } from './tamper.mjs';

/** The failing evaluations of one run after which the agent is not sent back any more: the first failure sends it back, the second ends the run as failed. */
export const GATE_ROUNDS = 2;
export const GATE_EVENT = 'proof_gate';
export const GATE_STATUS = Object.freeze({ passed: 'passed', failed: 'failed', unproven: 'unproven', stale: 'stale', skipped: 'skipped' });
/** How long a run waits for its baseline; it goes on without one after that (the changes to the checks are then unknown). */
export const BASELINE_TIMEOUT_MS = 120_000;
export const GATE_LIMITS = Object.freeze({
  outputChars: 1500, feedbackChars: 12_000, detailed: 5, listed: 20, commandChars: 300, textChars: 300, modifications: 20, shown: 5, rows: 200, errorChars: 200,
});
/** The folder of the task (beside its transcript) that keeps the acceptance bytes the task is held to. */
export const ACCEPTANCE_COPY = 'acceptance.yml';
/** The folder of the gate's own baselines, beside the owner's trust list: their retention never removes a baseline of `chatmcp verify`. */
export const GATE_FOLDER = 'gate';
/** A baseline of a Git workspace is a whole store of it, so the gate keeps fewer than chatmcp verify does (and for the same 14 days). */
const GATE_RETENTION = Object.freeze({ maxPerWorkspace: 5 });
/** After this long the person is told that the run waits for its baseline. */
const BASELINE_NOTICE_MS = 3000;
const BASELINE_ID = /^\d{8}T\d{9}Z-[0-9a-f]{8}$/;
const LOCK_WAIT_MS = 30_000;
const JUDGED = new Set([GATE_STATUS.passed, GATE_STATUS.failed, GATE_STATUS.unproven, GATE_STATUS.stale]);

const judged = (result) => Boolean(result) && JUDGED.has(result.status);
const isChecks = (row) => row?.kind === 'checks';
const labelOf = (criterionId, index) => (index ? `${criterionId} #${index + 1}` : criterionId);
const oneLine = (value, limit) => {
  const text = String(value ?? '').replace(/[\s\p{Cc}]+/gu, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
};

// ------------------------------------------------------------------------------------------------------------------ the judgment
function detailOf(attempt) {
  if (attempt.timedOut) return 'timed out';
  if (attempt.cancelled) return 'cancelled';
  if (attempt.signal !== null && attempt.signal !== undefined) return `ended by signal ${attempt.signal}`;
  return Number.isInteger(attempt.exit) ? `exit ${attempt.exit}` : 'no exit code';
}

/**
 * What the report of runAcceptanceChecks says: {status, reason, failing: [{criterionId, index, detail}], open: [{id, status, codes}], checksModified}.
 * A check fails by its own last attempt of this run, whatever its tree: the roll-up calls a failing run that wrote files `stale`, the gate does not let it through. It
 * passes only by the roll-up (the strict pass rule, the pack's): the gate never says passed where a pack of the same ledger and tree would not.
 */
export function judgeChecks(report) {
  const last = new Map();
  for (const attempt of report.attempts) last.set(`${attempt.criterionId}#${attempt.index}`, attempt);
  const failing = report.checks.flatMap((check) => {
    if (check.error) return [{ criterionId: check.criterionId, index: check.index, detail: `could not start (${check.error.code})` }];
    const attempt = last.get(`${check.criterionId}#${check.index}`);
    return attempt && !attempt.passed ? [{ criterionId: check.criterionId, index: check.index, detail: detailOf(attempt) }] : [];
  });
  const rows = Array.isArray(report.criteria) ? report.criteria.filter(isChecks) : null;
  const codesOf = (row) => [...new Set(row.reasons.map((reason) => reason.code))];
  const modified = rows?.some((row) => row.status === 'checks_modified' || codesOf(row).includes('checks_modified')) ?? false;
  const unknown = rows === null || rows.some((row) => codesOf(row).includes('check_changes_unknown'));
  const checksModified = modified ? true : unknown ? null : false;
  const open = (rows ?? []).filter((row) => row.status !== 'evidenced' && row.status !== 'checks_modified').map((row) => ({ id: row.id, status: row.status, codes: codesOf(row) }));
  const say = (status, reason) => ({ status, reason, failing, open, checksModified });
  if (report.blocked === 'acceptance_edited') return say(GATE_STATUS.failed, 'acceptance_edited');
  if (failing.length) return say(GATE_STATUS.failed, 'checks_failed');
  if (rows === null) return say(GATE_STATUS.unproven, 'tree_unknown');
  if (!open.length) return say(GATE_STATUS.passed, null);
  if (rows.some((row) => row.checks.some((check) => check.result === 'failed'))) return say(GATE_STATUS.unproven, 'failed_before_on_this_tree');
  if (open.every((row) => row.codes.length === 1 && row.codes[0] === 'check_changes_unknown')) return say(GATE_STATUS.unproven, 'check_changes_unknown');
  return say(GATE_STATUS.unproven, 'not_evidenced');
}

/** A judgment of a run that ended on the tree `finalKey`: a pass on another tree is stale. A failure stays (nothing shows it was repaired), and so does every judgment when the final tree is not known. */
export function staleGate(result, finalKey) {
  if (!result || result.status !== GATE_STATUS.passed || !result.tree || !finalKey || result.tree === finalKey) return result ?? null;
  return { ...result, status: GATE_STATUS.stale, reason: 'final_tree_changed' };
}

// ------------------------------------------------------------------------------------------------------------------ what it does to the outcome of a task
const listed = (items, text, shown = GATE_LIMITS.shown) => {
  const kept = items.slice(0, shown).map(text);
  return items.length > kept.length ? `${kept.join('; ')}; and ${items.length - kept.length} more` : kept.join('; ');
};
const modifiedText = (result) => (result.modifications?.length ? ` (${listed(result.modifications, (item) => `${oneLine(item.path, 120)}: ${item.codes.join(', ')}`)})` : '');
const UNPROVEN = Object.freeze({
  tree_unknown: () => 'the Hub could not take the final tree',
  not_evidenced: (result) => `no run counts on it for ${listed(result.open ?? [], (row) => `${row.id} (${row.codes.join(', ') || row.status})`)}`,
  failed_before_on_this_tree: () => 'the checks pass now, but they failed earlier on this very tree, so the result is not stable or depends on something outside the tree',
  check_changes_unknown: () => 'it is not known whether the checks were modified during the task',
  state_inside_workspace: () => 'the Hub\'s data folder is inside the workspace, so no tree can be recorded',
  proof_unavailable: () => 'the Hub records no proof here',
  acceptance_lost: () => 'the acceptance file of the start of the task is gone',
  trust_revoked: () => `the acceptance file is no longer trusted (it was when this run began)`,
  gate_error: (result) => `the checks could not be run or recorded (${result.error ?? 'unknown error'})`,
});
const whyUnproven = (result) => (UNPROVEN[result.reason] ? UNPROVEN[result.reason](result) : oneLine(result.reason ?? 'unknown', 80));
/** Whether a judgment leaves the outcome of the task as it is: a pass on the final tree by checks that were not modified. */
const clean = (result) => result.status === GATE_STATUS.passed && result.checksModified !== true;

/** The gate's line among what is missing, or null. */
export function gateMissing(result) {
  if (!judged(result) || clean(result)) return null;
  if (result.status === GATE_STATUS.failed) {
    return result.reason === 'acceptance_edited'
      ? `The owner's acceptance file (${ACCEPTANCE_FILE}) was ${result.edit?.deleted ? 'deleted' : 'edited'} during the task, so its checks did not run`
      : `The owner's trusted acceptance checks failed on the final tree: ${listed(result.failing, (item) => `${labelOf(item.criterionId, item.index)} (${item.detail})`).replaceAll('; ', ', ')}`;
  }
  if (result.status === GATE_STATUS.stale) return 'The files changed after the owner\'s trusted acceptance checks passed';
  if (result.status === GATE_STATUS.unproven) return `The owner's trusted acceptance checks are not shown to hold on the final tree: ${whyUnproven(result)}`;
  return `Checks were modified during the task${modifiedText(result)}`;
}

/** assessCompletionEvidence with the gate's judgment: anything but a clean pass is not ready. */
export function gateVerification(verification, result) {
  const missing = gateMissing(result);
  if (missing === null) return verification;
  return { ...verification, ready: false, missing: [...verification.missing, missing], reason: 'The owner\'s trusted acceptance checks do not back this answer; task completion is not certified' };
}

/** classifyTaskCompletion with the gate's judgment: `requirements: 'failed'` after a failure, never 'verified' after anything but a clean pass. */
export function gateCompletion(completion, result) {
  if (!judged(result)) return completion;
  const gate = { gate: result.status, checksModified: result.checksModified ?? null };
  if (clean(result)) return Object.freeze({ ...completion, ...gate });
  return Object.freeze({
    ...completion, ...gate,
    requirements: result.status === GATE_STATUS.failed ? 'failed' : 'unverified',
    verification: 'missing_evidence',
    missingChecks: [...completion.missingChecks, gateMissing(result)],
    note: result.status === GATE_STATUS.failed ? 'Execution finished, but the owner\'s trusted acceptance checks failed.' : 'Execution finished, but the owner\'s trusted acceptance checks do not certify its result.',
  });
}

/** The Hub's sentences about the judgment at the end of the answer, or null (a clean pass, no judgment). */
export function gateNotice(result) {
  if (!judged(result) || clean(result)) return null;
  const modified = result.checksModified === true ? ` Checks were modified during the task${modifiedText(result)}; review those changes.` : '';
  if (result.status === GATE_STATUS.failed) {
    const what = result.reason === 'acceptance_edited'
      ? `${ACCEPTANCE_FILE} was ${result.edit?.deleted ? 'deleted' : 'edited'} during the task, so the owner's checks did not run (if the change is yours, trust the new version with \`chatmcp verify trust\` and continue)`
      : `the owner's trusted acceptance checks failed on the final tree (${listed(result.failing, (item) => `${labelOf(item.criterionId, item.index)}: ${item.detail}`)})`;
    const rounds = result.stopped === 'no_turn_left'
      ? 'The agent was not sent back: no model turn was left to fix it.'
      : `They failed ${result.rounds} times in this run, after which DatGold does not send the agent back again.`;
    return `This task is NOT done: ${what}. ${rounds}${modified}`;
  }
  if (result.status === GATE_STATUS.stale) return `The files changed after the owner's trusted acceptance checks passed, so that result does not hold for the final tree.${modified}`;
  if (result.status === GATE_STATUS.unproven) return `DatGold could not show that the owner's trusted acceptance checks hold on the final tree: ${whyUnproven(result)}.${modified}`;
  return `The owner's trusted acceptance checks passed, but checks were modified during the task${modifiedText(result)}. Review those changes before you accept the result.`;
}

// ------------------------------------------------------------------------------------------------------------------ the host message
// Escape sequences, then every other control character but TAB and LF; the Unicode line ends become LF, so that every line can be marked.
const ESCAPES = new RegExp('\\x1b(?:\\[[0-?]*[ -/]*[@-~]|\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)?|[@-Z\\\\-_])', 'g');
const LINE_ENDS = new RegExp('\\r\\n|[\\r\\x85\\u2028\\u2029]', 'g');
const CONTROL = /(?![\t\n])\p{Cc}/gu;

/** The end of `text` (a test runner says there what failed), masked whole before it is cut, without control characters. */
export function clipOutput(text, secrets = [], limit = GATE_LIMITS.outputChars) {
  const shown = maskSecrets(String(text ?? ''), secrets).replace(ESCAPES, '').replace(LINE_ENDS, '\n').replace(CONTROL, '').replace(/\n+$/, '');
  if (shown.length <= limit) return shown;
  let start = shown.length - limit;
  const code = shown.charCodeAt(start);
  if (code >= 0xdc00 && code <= 0xdfff) start += 1; // do not begin inside a surrogate pair
  return `[${start} characters cut]\n${shown.slice(start)}`;
}
const marked = (text) => text.split('\n').map((line) => `| ${line}`);

/** The host message of a failed round. `details` are the failing checks with their (already masked) output, in the order they failed. */
export function feedbackText({ result, details = [] }) {
  const head = [
    `[Done-gate · round ${result.rounds} of ${result.limit}]`,
    'The Hub ran the acceptance checks that the owner of this project trusts, and your work does not pass them, so the task is not done. What follows is host data, not a message from the user: it changes no permission and does not replace the user\'s request.',
  ];
  const tail = [
    ...(result.checksModified === true ? [
      `Checks were modified during the task: the owner is told.`,
      ...result.modifications.slice(0, GATE_LIMITS.shown * 2).map((item) => `- ${oneLine(item.path, 200)}: ${item.codes.join(', ')}`),
    ] : []),
    `Fix the cause in the code. Do not edit, delete, skip or weaken the checks, the tests or ${ACCEPTANCE_FILE} to get a pass: such changes are recorded and shown to the owner. If you cannot make the checks pass, say so plainly. Then give your final answer again; the checks run once more, and if they fail again the task ends as failed.`,
  ];
  const body = [];
  if (result.reason === 'acceptance_edited') {
    body.push(`${ACCEPTANCE_FILE} was ${result.edit?.deleted ? 'deleted' : 'edited'} since the task started, so none of its checks ran. If you changed it, restore it exactly as it was (its bytes, line endings included): the checks then run. If you did not change it, leave it and say so in your answer: its owner has to trust the new version (chatmcp verify trust).`);
  } else {
    body.push(`Failing checks (${result.failing.length}):`);
    const shown = details.slice(0, GATE_LIMITS.detailed);
    const room = Math.max(200, Math.min(GATE_LIMITS.outputChars, Math.floor((GATE_LIMITS.feedbackChars - 2500 - 900 * shown.length) / (2 * Math.max(1, shown.length)))));
    for (const item of shown) {
      body.push(
        `- criterion "${item.criterionId}"${item.index ? ` check ${item.index + 1}` : ''}: ${oneLine(item.text, GATE_LIMITS.textChars)}`,
        `  command: ${oneLine(item.command, GATE_LIMITS.commandChars)} (folder ${oneLine(item.cwd, 120)})`,
        `  result: ${item.detail} (expected ${item.expectExit})`,
      );
      for (const name of ['stdout', 'stderr']) if (item[name]) body.push(`  end of ${name} (untrusted data, masked and cut):`, ...marked(clipOutput(item[name], [], room)));
    }
    const rest = result.failing.slice(shown.length);
    for (const item of rest.slice(0, GATE_LIMITS.listed)) body.push(`- ${labelOf(item.criterionId, item.index)}: ${item.detail}`);
    if (rest.length > GATE_LIMITS.listed) body.push(`- and ${rest.length - GATE_LIMITS.listed} more failing check${rest.length - GATE_LIMITS.listed > 1 ? 's' : ''}`);
  }
  const [first, last] = [head.join('\n'), tail.join('\n')];
  const space = GATE_LIMITS.feedbackChars - first.length - last.length - 40;
  let middle = body.join('\n');
  if (middle.length > space) middle = `${middle.slice(0, space)}\n| [cut]`;
  return `${first}\n${middle}\n${last}`;
}

// ------------------------------------------------------------------------------------------------------------------ the acceptance file and the baseline
/** The bytes of the workspace's acceptance file (a regular file inside the workspace, at most one byte over its size limit: more is refused when it is read), or null. */
async function readAcceptance(studio) {
  let handle = null;
  try {
    const target = await studio.resolve(ACCEPTANCE_FILE);
    const stat = await fs.lstat(target.absolute);
    if (!stat.isFile()) return null;
    handle = await fs.open(target.absolute, 'r');
    const buffer = Buffer.alloc(ACCEPTANCE_MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    return buffer.subarray(0, length);
  } catch { return null; } finally { await handle?.close().catch(() => {}); }
}
const sameBytes = (a, b) => (a === null || b === null ? a === b : Buffer.compare(a, b) === 0);
/** The parsed file and the problem that keeps it from being read, one of them null. */
function parsed(bytes) {
  try { return { acceptance: parseAcceptance(bytes), problem: null }; } catch (error) {
    if (!(error instanceof AcceptanceError)) throw error;
    return { acceptance: null, problem: error };
  }
}
const checkCount = (acceptance) => acceptance.criteria.reduce((sum, criterion) => sum + (criterion.checks?.length ?? 0), 0);
const HEX64 = /^[0-9a-f]{64}$/;
/** task.proofBaseline as it was saved, or null when it is not one. */
function savedBaseline(value) {
  if (!value || typeof value !== 'object' || typeof value.acceptanceSha256 !== 'string' || !HEX64.test(value.acceptanceSha256)) return null;
  const whole = typeof value.id === 'string' && typeof value.sha256 === 'string' && HEX64.test(value.sha256);
  return { id: whole ? value.id : null, sha256: whole ? value.sha256 : null, acceptanceSha256: value.acceptanceSha256 };
}

/**
 * `side` with the acceptance file it is given (null: none) instead of its own: the bytes the task is held to on the one side, those of the workspace on the other. A
 * .gitignore can leave the file out of every tree, and the owner may have trusted a newer one than the baseline holds.
 */
function withAcceptance(side, bytes, objectFormat) {
  const own = side.entries.find((entry) => entry.path === ACCEPTANCE_FILE);
  const entries = side.entries.filter((entry) => entry !== own);
  if (bytes) entries.push({ path: ACCEPTANCE_FILE, mode: own?.mode ?? MODE.file, oid: blobId(bytes, objectFormat) });
  return {
    entries,
    read: async (paths, options) => {
      const contents = await side.read(paths.filter((file) => file !== ACCEPTANCE_FILE), options);
      if (paths.includes(ACCEPTANCE_FILE)) contents.set(ACCEPTANCE_FILE, bytes);
      return contents;
    },
  };
}

/** The baseline side: the rows of the anchored baseline and its blobs from its private store. A plain folder has no store: what changed there cannot be looked into (the detector counts it as modified). */
async function baselineSide({ loaded, hubDir, root, env, scratch }) {
  const { record, entries } = loaded;
  if (record.store) return storeSide({ git: await findGit(), env, storeDir: path.join(baselineFolder(hubDir, root), record.store.directory), entries, objectFormat: record.objectFormat, scratch });
  return { entries, read: async (paths) => new Map(paths.map((file) => [file, null])) };
}

/** The pod-22 report between the task's baseline and the workspace as it is now. Throws when the baseline or the workspace cannot be read. */
async function checkChangesOf({ manager, hubDir, baseline, acceptance, current }) {
  const root = path.resolve(manager.workspace);
  const env = manager.localTools?.shell?.env ?? process.env;
  const loaded = await loadBaseline({ hubDir, root, id: baseline.id, expectSha256: baseline.sha256 });
  const scratch = path.join(hubDir, `work-${randomUUID()}`);
  try {
    await fs.mkdir(path.join(scratch, 'store'), { recursive: true, mode: 0o700 });
    const { objectFormat } = loaded.record;
    const before = withAcceptance(await baselineSide({ loaded, hubDir, root, env, scratch: path.join(scratch, 'store') }), acceptance, objectFormat);
    const after = withAcceptance(await workTreeSide({ root, stateDir: path.join(scratch, 'final'), env }), current, objectFormat);
    return await detectCheckChanges({ baseline: before, final: after, acceptance: parseAcceptance(acceptance) });
  } finally { await fs.rm(scratch, { recursive: true, force: true, maxRetries: 3 }).catch(() => {}); }
}

// ------------------------------------------------------------------------------------------------------------------ the gate
const SKIPPED = Object.freeze({
  readonly: 'Chế độ Chỉ đọc: cổng bằng chứng không chạy kiểm tra nào.',
  plan_mode: 'Tác vụ đang ở chế độ lập kế hoạch: cổng bằng chứng không chạy kiểm tra nào.',
  sandbox_only: 'Sandbox-only: các kiểm tra chạy trên máy host nên cổng bằng chứng không chạy chúng.',
  no_shell: 'Hub này không có shell: cổng bằng chứng không chạy được kiểm tra nào.',
  no_checks: `${ACCEPTANCE_FILE} chỉ có tiêu chí thủ công: cổng bằng chứng không có gì để chạy.`,
});

/** A manager whose workspace the gate can work on: the local backend, with a studio, tools, a data folder, a proof service and the owner's trust list. */
const gateable = (manager) => manager?.backend === 'local' && typeof manager.workspace === 'string' && manager.workspace !== ''
  && typeof manager.hubDirectory === 'string' && typeof manager.studio?.resolve === 'function' && Boolean(manager.localTools)
  && typeof manager.proofService === 'function' && typeof manager.acceptanceTrustStore === 'function';

const newRun = (trustStore) => ({ trustStore, acceptance: null, sha256: null, checks: 0, baseline: null, armed: false, unusable: null, error: null, failures: 0, last: null, said: new Set() });

export class DoneGate {
  /**
   * @param {object} options
   * @param {object} options.manager  the manager the agent runs on
   * @param {(line: string) => void} [options.log]
   * @param {object} [options.deps]   {runChecks, snapshotBaseline, loadBaseline, checkChanges}, for tests
   */
  constructor({ manager, log = () => {}, deps = {} } = {}) {
    if (!manager) throw new TypeError('DoneGate needs the manager the agent runs on.');
    this.manager = manager;
    this.log = log;
    this.baselineTimeoutMs = BASELINE_TIMEOUT_MS;
    this.baselineNoticeMs = BASELINE_NOTICE_MS;
    this.deps = { runChecks: runAcceptanceChecks, snapshotBaseline, loadBaseline, checkChanges: checkChangesOf, ...deps };
    this.toolchain = null;
  }

  // In the Hub's own data folder for every manager (the folder of the trust list it was handed), not in a side chat's: that one is nested so deep that Git refuses the
  // store's path on Windows ("'$GIT_DIR' too big": measured, a data folder over about 138 characters). Baselines are kept per workspace, so a worktree has its own.
  #hubDir() { return path.join(path.dirname(this.manager.acceptanceTrustStore().file), GATE_FOLDER); }

  /**
   * The start of a run, before its first model turn. Resolves with the gate's state for this run, or null when nothing is gated here (no acceptance file, an agent that
   * another agent started, not the local backend). Sets `task.proofBaseline`; `directory` is the task's folder. Rejects only when `signal` aborted.
   */
  async begin({ task, directory, signal = null, emit }) {
    if (!gateable(this.manager)) return null;
    try { return await this.#begin({ task, directory, signal, emit }); } catch (error) {
      if (signal?.aborted) throw signal.reason;
      // A gate that cannot begin does not fail the run, and does not let its answer pass in silence either (review: unproven).
      this.log(`Cổng bằng chứng: không chuẩn bị được (${error?.code ?? error?.message}).`);
      return { ...newRun(null), unusable: 'gate_error', error: oneLine(error?.code ?? error?.name ?? 'error', 64) };
    }
  }

  async #begin({ task, directory, signal, emit }) {
    const { manager } = this;
    const current = await readAcceptance(manager.studio);
    const trustStore = manager.acceptanceTrustStore();
    const sha256 = current ? acceptanceSha256(current) : null;
    const trusted = sha256 !== null && (await trustStore.isTrusted(sha256)) === true;
    const say = (gate, message, extra = {}) => emit(GATE_EVENT, message, { gate, ...extra });
    if (manager.lifecycleAgent?.kind === 'subagent') {
      if (trusted) await say('skipped', 'Tác nhân này do một tác nhân khác khởi động: cổng bằng chứng không chạy ở đây (tác vụ cha có cổng của nó).', { reason: 'subagent' });
      return null;
    }
    const saved = savedBaseline(task.proofBaseline);
    if (!saved && !current) return null;
    const run = newRun(trustStore);
    const problem = current ? parsed(current).problem : null;
    let keep = true; // the bytes this run is held to are kept in the task's folder, unless they are the kept ones
    if (!saved) {
      if (problem) {
        run.unusable = 'invalid';
        run.said.add('invalid');
        await say('invalid', `${ACCEPTANCE_FILE} không đọc được (dòng ${problem.line}: ${problem.reason}): cổng bằng chứng không chạy kiểm tra nào. Sửa tệp rồi tin lại bằng "chatmcp verify trust".`, { reason: 'invalid' });
        return run;
      }
      this.#hold(run, current, sha256);
    } else if (trusted && sha256 !== saved.acceptanceSha256 && !problem) {
      // The owner trusted another version of the file since: this run is held to it.
      this.#hold(run, current, sha256);
    } else {
      const kept = await fs.readFile(path.join(directory, ACCEPTANCE_COPY)).catch(() => null);
      keep = !(kept && acceptanceSha256(kept) === saved.acceptanceSha256);
      if (!keep) this.#hold(run, kept, saved.acceptanceSha256);
      else if (sha256 === saved.acceptanceSha256) this.#hold(run, current, sha256);
      else { run.unusable = 'acceptance_lost'; return run; }
    }
    if ((await trustStore.isTrusted(run.sha256)) !== true) return await this.#untrusted(run, say);
    run.armed = true;
    if (keep) await this.#keep(directory, run.acceptance);
    task.proofBaseline = { id: saved?.id ?? null, sha256: saved?.sha256 ?? null, acceptanceSha256: run.sha256, at: task.proofBaseline?.at ?? new Date().toISOString() };
    if (!run.checks) return run;
    await this.#baseline({ run, task, saved, signal, say });
    return run;
  }

  /** The notice of a run that begins without the owner's trust in the file it would be held to. */
  async #untrusted(run, say) {
    run.said.add('untrusted');
    await say('untrusted', `${ACCEPTANCE_FILE} có trong dự án nhưng chủ máy chưa tin bản này: cổng bằng chứng không chạy kiểm tra nào. Đọc tệp rồi chạy "chatmcp verify trust" để bật.`, { reason: 'untrusted' });
    return run;
  }

  #hold(run, bytes, sha256) {
    run.acceptance = Buffer.from(bytes);
    run.sha256 = sha256;
    run.checks = checkCount(parseAcceptance(run.acceptance));
  }

  async #keep(directory, bytes) {
    try {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFileAtomic(path.join(directory, ACCEPTANCE_COPY), bytes, { mode: 0o600 });
    } catch (error) { this.log(`Cổng bằng chứng: không lưu được bản sao ${ACCEPTANCE_FILE} (${error?.code ?? error?.message}).`); }
  }

  /** The baseline of the task's start: the saved one, else a new one. A Read Only run, and a Hub that records no proof, take none. */
  async #baseline({ run, task, saved, signal, say }) {
    const { manager } = this;
    const service = manager.proofService();
    if (!service || service.disabled || manager.permissions?.mode === 'readonly') return;
    const root = path.resolve(manager.workspace);
    const hubDir = this.#hubDir();
    const armed = `Cổng bằng chứng: ${run.checks} kiểm tra của ${ACCEPTANCE_FILE} (chủ máy đã tin) sẽ chạy trên cây thư mục cuối trước khi tác vụ được coi là xong.`;
    let again = false;
    if (saved?.id) {
      try {
        await this.deps.loadBaseline({ hubDir, root, id: saved.id, expectSha256: saved.sha256 });
        run.baseline = { id: saved.id, sha256: saved.sha256 };
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        // Removed by the retention (or by hand): a new one, so that what changes from here on is seen. An edited or foreign one is never replaced.
        if (error?.code !== 'baseline_missing') {
          await say('baseline_unavailable', `${armed} Không đọc được mốc so sánh của tác vụ (${error?.code ?? 'lỗi'}), nên không biết các kiểm tra có bị sửa hay không.`, { reason: String(error?.code ?? 'error').slice(0, 64) });
          return;
        }
        again = true;
      }
      if (run.baseline) return void await say('armed', armed, { checks: run.checks });
    }
    const limit = new AbortController();
    const timer = setTimeout(() => limit.abort(Object.assign(new Error('The baseline took too long.'), { code: 'baseline_timeout' })), this.baselineTimeoutMs);
    let said = null;
    const notice = setTimeout(() => { said = say('baseline', 'Cổng bằng chứng: đang lấy mốc so sánh của thư mục dự án trước khi model bắt đầu.'); said.catch(() => {}); }, this.baselineNoticeMs);
    let failed = null;
    try {
      const taken = await this.deps.snapshotBaseline({ hubDir, root, toolchain: null, retention: GATE_RETENTION, lock: { waitMs: LOCK_WAIT_MS }, signal: signal ? AbortSignal.any([signal, limit.signal]) : limit.signal });
      run.baseline = { id: taken.id, sha256: taken.sha256 };
      Object.assign(task.proofBaseline, { id: taken.id, sha256: taken.sha256, at: new Date().toISOString() });
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      failed = limit.signal.aborted ? 'baseline_timeout' : String(error?.code ?? 'baseline_failed').slice(0, 64);
    } finally { clearTimeout(timer); clearTimeout(notice); }
    await said;
    if (failed) await say('baseline_unavailable', `${armed} Không lấy được mốc so sánh (${failed}), nên sẽ không biết các kiểm tra có bị sửa hay không.`, { reason: failed });
    else if (again) await say('rebaselined', `${armed} Mốc so sánh cũ không còn, đã lấy mốc mới từ lần chạy này: các thay đổi trước đó đối với kiểm tra không còn thấy được.`, { checks: run.checks });
    else await say('armed', armed, { checks: run.checks });
  }

  /** The baseline of a conversation that is deleted. Never throws. */
  async forget(task) {
    const saved = savedBaseline(task?.proofBaseline);
    if (!saved?.id || !BASELINE_ID.test(saved.id) || typeof task.workspace?.path !== 'string' || typeof this.manager.acceptanceTrustStore !== 'function') return;
    const folder = baselineFolder(this.#hubDir(), task.workspace.path);
    for (const name of [`${saved.id}.json`, `${saved.id}.git`]) await fs.rm(path.join(folder, name), { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }

  /** Why nothing is run for this answer, or null. */
  async #skip(run, planMode) {
    const { manager } = this;
    if (run.unusable === 'invalid') return 'invalid';
    if (run.unusable) return null;
    if (!run.armed && (await run.trustStore.isTrusted(run.sha256)) !== true) return 'untrusted';
    if (!run.checks) return 'no_checks';
    if (planMode) return 'plan_mode';
    if (manager.permissions?.mode === 'readonly') return 'readonly';
    if (manager.permissions?.executionPolicy === 'sandbox-only') return 'sandbox_only';
    if (manager.localTools?.shellDisabled || typeof manager.localTools?.shell?.run !== 'function') return 'no_shell';
    return null;
  }

  /**
   * The model has given a final answer. Resolves with {action, feedback, result, observed}:
   *   action 'continue'   the checks failed and the agent is sent back: write `feedback` as a host message (kind proof_gate)
   *   action 'complete'   the answer may go on to the hooks; `result` is the judgment (null: no gate here)
   * `observed` {tree, checks} is what the run of the checks showed (the final tree's ids, the passing checks of a clean pass by their ledger line), or null when nothing
   * ran. `canGoOn()` says whether the loop could take another model turn. Rejects only when `signal` aborted.
   */
  async review({ run, task, planMode = false, signal = null, emit, canGoOn = () => true, onRun = () => {} }) {
    const done = (result, observed = null) => ({ action: 'complete', feedback: null, result, observed });
    if (!run) return done(null);
    const { manager } = this;
    const say = (gate, message, extra = {}, detail = undefined) => emit(GATE_EVENT, message, { gate, ...extra }, detail);
    const base = {
      status: null, reason: null, at: new Date().toISOString(), rounds: run.failures, limit: GATE_ROUNDS, passes: 0, reused: false, tree: null, acceptanceSha256: run.sha256,
      criteria: [], checks: [], failing: [], open: [], checksModified: null, modifications: [], testChanges: [],
    };
    const skipped = await this.#skip(run, planMode);
    if (skipped) {
      if (!run.said.has(skipped)) { run.said.add(skipped); await say('skipped', SKIPPED[skipped], { reason: skipped }); }
      return done({ ...base, status: GATE_STATUS.skipped, reason: skipped });
    }
    const service = manager.proofService();
    // A run that was armed does not lose its gate in silence when the trust is taken back meanwhile.
    const revoked = !run.unusable && (await run.trustStore.isTrusted(run.sha256)) !== true ? 'trust_revoked' : null;
    const unusable = run.unusable ?? revoked ?? (!service ? 'proof_unavailable' : service.disabled || null);
    if (unusable) {
      const result = { ...base, status: GATE_STATUS.unproven, reason: unusable, ...(run.error ? { error: run.error } : {}) };
      await say(GATE_STATUS.unproven, `Cổng bằng chứng không chạy được kiểm tra (${unusable}): kết quả không được xác nhận.`, { reason: unusable });
      return done(result);
    }
    const current = await readAcceptance(manager.studio);
    const reused = await this.#reuse(run, service, current, signal);
    if (reused) {
      await say(reused.status, `Cổng bằng chứng: cây thư mục không đổi từ lần chạy kiểm tra trước, dùng lại kết quả (${reused.status}).`, { reason: reused.reason, reused: true, rounds: run.failures, limit: GATE_ROUNDS, checksModified: reused.checksModified });
      return done({ ...reused, reused: true, at: base.at }, run.last.observed);
    }
    await say('running', `Cổng bằng chứng: đang chạy ${run.checks} kiểm tra của ${ACCEPTANCE_FILE} trên cây thư mục cuối.`, { checks: run.checks });
    onRun();
    let pass;
    try {
      pass = await this.#passes({ run, task, service, current, signal });
      signal?.throwIfAborted();
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      this.log(`Cổng bằng chứng: không chạy được kiểm tra (${error?.code ?? error?.message}).`);
      const result = { ...base, status: GATE_STATUS.unproven, reason: 'gate_error', error: oneLine(error?.code ?? error?.name ?? 'error', 64) };
      await say(GATE_STATUS.unproven, `Cổng bằng chứng không chạy được kiểm tra (${result.error}): kết quả không được xác nhận.`, { reason: 'gate_error', error: result.error });
      return done(result, { tree: null, checks: [] });
    }
    const { report, changes, outputs, passes } = pass;
    const verdict = judgeChecks(report);
    const result = { ...base, ...this.#record({ run, report, changes, verdict, current }), passes };
    if (verdict.status === GATE_STATUS.failed) run.failures += 1;
    result.rounds = run.failures;
    const observed = { tree: report.finalTree, checks: result.status === GATE_STATUS.passed && result.checksModified !== true ? this.#receipts(report) : [] };
    run.last = { result, observed, current };
    const extra = { reason: result.reason, rounds: result.rounds, limit: GATE_ROUNDS, checksModified: result.checksModified };
    const detail = { criteria: result.criteria, checks: result.checks, failing: result.failing, open: result.open, modifications: result.modifications, testChanges: result.testChanges, passes };
    if (verdict.status === GATE_STATUS.failed) {
      const again = run.failures < GATE_ROUNDS;
      const sentBack = again && canGoOn() === true;
      if (again && !sentBack) result.stopped = 'no_turn_left';
      await say('failed', `${this.#failedText(result)} ${sentBack ? 'Đã gửi kết quả cho agent để sửa.' : 'Không gửi lại cho agent nữa.'}${result.checksModified === true ? ' Các kiểm tra đã bị thay đổi trong tác vụ.' : ''}`, { ...extra, sentBack }, detail);
      if (sentBack) return { action: 'continue', feedback: feedbackText({ result, details: this.#details(run, report, verdict, outputs) }), result, observed };
      return done(result, observed);
    }
    const message = verdict.status === GATE_STATUS.passed
      ? `Cổng bằng chứng: các kiểm tra chủ máy đã tin đều đạt trên cây thư mục cuối.${result.checksModified === true ? ' Nhưng các kiểm tra đã bị thay đổi trong tác vụ: hãy xem lại.' : ''}`
      : `Cổng bằng chứng: không chứng minh được các kiểm tra đạt trên cây thư mục cuối (${result.reason}).`;
    await say(result.status, message, extra, detail);
    return done(result, observed);
  }

  #failedText(result) {
    if (result.reason === 'acceptance_edited') return `Cổng bằng chứng: ${ACCEPTANCE_FILE} đã bị ${result.edit?.deleted ? 'xóa' : 'sửa'} trong tác vụ nên không kiểm tra nào chạy (lần ${result.rounds}/${GATE_ROUNDS}).`;
    return `Cổng bằng chứng: ${result.failing.length} kiểm tra không đạt (lần ${result.rounds}/${GATE_ROUNDS}): ${listed(result.failing, (item) => `${labelOf(item.criterionId, item.index)} (${item.detail})`)}.`;
  }

  /** The last judgment when it still holds: the same tree, the same acceptance bytes, and either a pass or a failure after the last round. Else null. */
  async #reuse(run, service, current, signal) {
    const { last } = run;
    if (!last?.result.tree || !sameBytes(last.current, current)) return null;
    if (last.result.status !== GATE_STATUS.passed && !(last.result.status === GATE_STATUS.failed && run.failures >= GATE_ROUNDS)) return null;
    let now = null;
    try { now = await service.snapshotter?.snapshot({ full: true, signal }); } catch { /* an unknown tree is not the same tree */ }
    signal?.throwIfAborted();
    return now?.status === 'ok' && treeKey(now) === last.result.tree ? last.result : null;
  }

  /** The checks, and once more when nothing failed but a later check changed the tree an earlier one ran on (never for a check that changes it every time). */
  async #passes({ run, task, service, current, signal }) {
    const { manager } = this;
    const { shell } = manager.localTools;
    this.toolchain ??= new ToolchainProbe({ env: shell.env ?? process.env });
    const ledger = ProofLedger.forTask(manager.hubDirectory, task.id, { secrets: () => manager.secrets ?? [] });
    for (let passes = 1; ; passes += 1) {
      const outputs = [];
      let changes = null;
      const runner = {
        workspace: shell.workspace, maxTimeoutMs: shell.maxTimeoutMs, secrets: () => shell.secrets?.() ?? [],
        run: async (options) => { const result = await shell.run(options); outputs.push(result); return result; },
      };
      const report = await this.deps.runChecks({
        baseline: run.acceptance, current, trustStore: run.trustStore, runner, ledger, snapshotter: service.snapshotter ?? null, toolchain: this.toolchain, signal,
        checkChanges: run.baseline ? async () => { changes = await this.#changes(run, current); return changes; } : null,
      });
      signal?.throwIfAborted();
      const verdict = judgeChecks(report);
      const settles = verdict.status === GATE_STATUS.unproven && verdict.open.some((row) => row.status === 'stale') && !report.checks.some((check) => check.unreliable);
      if (passes >= 2 || !settles) return { report, changes, outputs, passes };
    }
  }

  /** The report on the changes to the checks, or null when it cannot be made: unknown is never "nothing changed". */
  async #changes(run, current) {
    try { return await this.deps.checkChanges({ manager: this.manager, hubDir: this.#hubDir(), baseline: run.baseline, acceptance: run.acceptance, current }); } catch (error) {
      this.log(`Cổng bằng chứng: không so được các kiểm tra với lúc bắt đầu tác vụ (${error?.code ?? error?.message}).`);
      return null;
    }
  }

  /** What is kept of one run of the checks: no output, no tree but the key of the final one. */
  #record({ run, report, changes, verdict, current }) {
    const { criteria } = parseAcceptance(run.acceptance);
    const specs = new Map(criteria.flatMap((criterion) => (criterion.checks ?? []).map((check, index) => [`${criterion.id}#${index}`, check])));
    const last = new Map();
    for (const attempt of report.attempts) last.set(`${attempt.criterionId}#${attempt.index}`, attempt);
    const secrets = this.manager.secrets ?? [];
    const found = Array.isArray(changes?.findings) ? changes.findings : [];
    return {
      status: verdict.status, reason: verdict.reason, failing: verdict.failing.slice(0, GATE_LIMITS.rows), open: verdict.open.slice(0, GATE_LIMITS.rows),
      tree: treeKey(report.finalTree),
      ...(verdict.reason === 'acceptance_edited' ? { edit: { deleted: current === null } } : {}),
      criteria: (report.criteria ?? []).slice(0, GATE_LIMITS.rows).map((row) => ({ id: row.id, kind: row.kind, status: row.status, codes: [...new Set(row.reasons.map((reason) => reason.code))] })),
      checks: report.checks.slice(0, GATE_LIMITS.rows).map((check) => {
        const attempt = last.get(`${check.criterionId}#${check.index}`) ?? null;
        return {
          criterionId: check.criterionId, index: check.index, command: oneLine(maskSecrets(specs.get(`${check.criterionId}#${check.index}`)?.run ?? '', secrets), GATE_LIMITS.commandChars),
          attempts: check.attempts, passed: attempt ? attempt.passed : false, exit: attempt?.exit ?? null, signal: attempt?.signal ?? null, timedOut: attempt?.timedOut ?? false,
          unreliable: check.unreliable, timeoutCapped: check.timeoutCapped, error: check.error ? oneLine(check.error.code, 64) : null, durationMs: attempt?.durationMs ?? null, seq: attempt?.seq ?? null,
        };
      }),
      checksModified: changes ? changes.checks_modified === true : verdict.checksModified,
      modifications: found.filter((item) => item.flagged).slice(0, GATE_LIMITS.modifications).map((item) => ({ path: oneLine(item.path, 400), codes: item.reasons.filter((reason) => reason.flagged).map((reason) => reason.code) })),
      // Test files changed without a flag (docs/PROOF-TAMPER.md: the heuristics flag neither every edit nor only bad ones): a person may want to look at them.
      testChanges: found.filter((item) => !item.flagged && item.reasons.some((reason) => reason.code === 'test_file_modified')).slice(0, GATE_LIMITS.modifications).map((item) => oneLine(item.path, 400)),
    };
  }

  /** The passing checks of a clean pass, each by the first 16 hex digits of its ledger line: the receipts the agent's progress shows (docs/PROOF-GATE.md). */
  #receipts(report) {
    const evidenced = new Set(report.criteria.filter((row) => isChecks(row) && row.status === 'evidenced').map((row) => row.id));
    const last = new Map();
    for (const attempt of report.attempts) if (attempt.passed && evidenced.has(attempt.criterionId)) last.set(`${attempt.criterionId}#${attempt.index}`, attempt);
    return [...last.values()].map((attempt) => ({ id: attempt.hash.slice(0, 16) }));
  }

  /** The failing checks with the masked end of what they printed, for the host message only. */
  #details(run, report, verdict, outputs) {
    const { criteria } = parseAcceptance(run.acceptance);
    const secrets = this.manager.secrets ?? [];
    const result = new Map();
    report.attempts.forEach((attempt, at) => result.set(`${attempt.criterionId}#${attempt.index}`, outputs[at] ?? null));
    return verdict.failing.slice(0, GATE_LIMITS.detailed).map(({ criterionId, index, detail }) => {
      const criterion = criteria.find((item) => item.id === criterionId);
      const check = criterion?.checks?.[index];
      const output = result.get(`${criterionId}#${index}`);
      const failure = report.checks.find((item) => item.criterionId === criterionId && item.index === index)?.error ?? null;
      return {
        criterionId, index, detail, text: criterion?.text ?? '', command: maskSecrets(check?.run ?? '', secrets), cwd: check?.cwd ?? '.', expectExit: check?.expect?.exit ?? 0,
        stdout: clipOutput(output?.stdout ?? '', secrets),
        stderr: failure ? clipOutput(oneLine(failure.message, GATE_LIMITS.errorChars), secrets) : clipOutput(output?.stderr ?? '', secrets),
      };
    });
  }
}
