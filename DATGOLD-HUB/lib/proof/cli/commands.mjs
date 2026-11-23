// The commands of `chatmcp verify` (docs/PROOF-CLI.md). Each one wires the module that does the work: proposeAcceptance and the trust store
// (pod-20), snapshotBaseline / loadBaseline / diffBaseline (pod-25), the ledger and recordCheck (pod-16) with ShellRunner over the
// StudioWorkspace shim, detectCheckChanges (pod-22) and buildAgentChangeStatement (pod-29). A command returns {code, data, params, ...} or
// throws a CliStop; it writes into the workspace only in `init`, and only .chatmcp/acceptance.yml.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { VERSION, defaultDataDirectory } from '../../manager.mjs';
import { DEFAULT_TIMEOUT_MS, ShellRunner } from '../../shell-runner.mjs';
import { ACCEPTANCE_FILE, AcceptanceError, acceptanceSha256, parseAcceptance, proposeAcceptance, resolveAcceptance } from '../acceptance.mjs';
import { baselineFolder, diffBaseline, loadBaseline, snapshotBaseline } from '../baseline.mjs';
import { findGit } from '../git-plumbing.mjs';
import { ProofLedger, ToolchainProbe, recordCheck, sha256Hex } from '../ledger.mjs';
import { buildAgentChangeStatement, canonicalJson, statementDigest } from '../pack.mjs';
import { detectCheckChanges, workTreeSide } from '../tamper.mjs';
import { TreeSnapshotter } from '../tree-snapshot.mjs';
import { createTrustStore } from '../trust-store.mjs';
import { CODES, NOT_BUILT, SESSION_FORMAT, stop } from './codes.mjs';
import { joinCommand } from './args.mjs';
import { usage } from './messages.mjs';
import { loadSession, readAcceptance, resolveWorkspace, stateOf, workspaceShim, writeAtomic, writeSession } from './session.mjs';
import { storeSide } from './store-side.mjs';

/** Who an approval made through the CLI is recorded as (no user name: the approval stays on this machine, its author is the person at it). */
export const APPROVED_BY = 'chatmcp verify trust';
const SHOWN_RECEIPTS = 50;
const passedRun = (record) => record.exit === 0 && record.timedOut !== true && record.cancelled !== true && record.signal === null;
const GIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Reads the acceptance file or stops with acceptance_invalid (its line and reason). */
function parsedOrStop(bytes) {
  try { return parseAcceptance(bytes); } catch (error) {
    if (error instanceof AcceptanceError) throw stop('acceptance_invalid', { file: ACCEPTANCE_FILE, line: error.line ?? null, reason: error.reason ?? error.message });
    throw error;
  }
}
const checksOf = (parsed) => ({
  checks: parsed.criteria.flatMap((criterion) => (criterion.checks ?? []).map((check) => ({ criterion: criterion.id, run: check.run, cwd: check.cwd ?? '.' }))),
  manual: parsed.criteria.filter((criterion) => criterion.manual).map((criterion) => criterion.id),
});

/** The workspace and the state folder of a command that keeps state; `ctx.root` is set for the answer. */
async function place(ctx) {
  ctx.root = await resolveWorkspace(ctx.args.workspace, ctx.cwd);
  const state = await stateOf(ctx.root, ctx.env);
  return { root: ctx.root, state, shim: workspaceShim(ctx.root, state) };
}

async function session(ctx, state, options) {
  const loaded = await loadSession(state, options);
  Object.assign(ctx, { taskId: loaded.taskId, baselineId: loaded.baselineId });
  return loaded;
}

const pathsOf = (state, loaded, baselineFile) => ({
  session: state.session, ledger: loaded.ledgerFile, baseline: baselineFile, acceptanceCopy: loaded.acceptanceBytes ? state.acceptanceCopy(loaded.taskId) : null,
});

// ------------------------------------------------------------------------------------------------------------------------------ help, version
function help(ctx) {
  const text = usage(ctx.lang);
  return { code: 'help', data: { topic: ctx.args.topic, usage: text }, stdout: text, quiet: true };
}
function version() {
  return { code: 'version', data: { version: VERSION }, params: { version: VERSION }, stdout: `${VERSION}\n`, quiet: true };
}

// ------------------------------------------------------------------------------------------------------------------------------ init
async function init(ctx) {
  ctx.root = await resolveWorkspace(ctx.args.workspace, ctx.cwd);
  // the shim's own folder is never written by what init calls; it does not need the state folder
  const shim = workspaceShim(ctx.root, { studio: path.join(defaultDataDirectory(ctx.env), 'proof', 'cli', 'studio') });
  const found = await readAcceptance(shim);
  if (found.state === 'outside') throw stop('acceptance_outside');
  if (found.exists) throw stop('acceptance_exists', { file: ACCEPTANCE_FILE });
  const proposal = await proposeAcceptance(ctx.root);
  const data = {
    file: ACCEPTANCE_FILE, written: false, sha256: proposal.sha256, criteria: proposal.acceptance.criteria.length,
    checks: proposal.acceptance.criteria.flatMap((criterion) => (criterion.checks ?? []).map((check) => check.run)),
    skipped: proposal.skipped.map(({ command, from, reason }) => ({ command: String(command), from: String(from), reason: String(reason) })),
    text: proposal.text,
  };
  const params = { file: ACCEPTANCE_FILE, criteria: data.criteria };
  if (ctx.args.options.print) return { code: 'acceptance_printed', data, params, stdout: proposal.text, quiet: true };
  const target = await shim.resolve(ACCEPTANCE_FILE);
  await fs.mkdir(path.dirname(target.absolute), { recursive: true });
  try { await fs.writeFile(target.absolute, proposal.text, { flag: 'wx' }); } catch (error) {
    if (error?.code === 'EEXIST') throw stop('acceptance_exists', { file: ACCEPTANCE_FILE });
    throw error;
  }
  return { code: 'acceptance_written', data: { ...data, written: true }, params };
}

// ------------------------------------------------------------------------------------------------------------------------------ trust
async function trust(ctx) {
  const { state, shim } = await place(ctx);
  const { sha256: asked, revoke } = ctx.args.options;
  const found = await readAcceptance(shim);
  if (found.state === 'outside') throw stop('acceptance_outside');
  const store = createTrustStore(state.hubDir);
  const base = { file: ACCEPTANCE_FILE, approvedBy: null, at: null, trustCommand: null };
  if (revoke) {
    if (found.state !== 'present' && !asked) throw stop('acceptance_missing', { file: ACCEPTANCE_FILE });
    const digest = asked ?? acceptanceSha256(found.bytes);
    let listed = { checks: [], manual: [] };
    if (found.state === 'present' && acceptanceSha256(found.bytes) === digest) { try { listed = checksOf(parseAcceptance(found.bytes)); } catch { /* revoking needs no readable file */ } }
    const removed = await store.revoke(digest);
    return { code: removed ? 'revoked' : 'already_untrusted', data: { ...base, sha256: digest, trusted: false, ...listed }, params: { sha256: digest } };
  }
  if (found.state !== 'present') throw stop('acceptance_missing', { file: ACCEPTANCE_FILE });
  const listed = checksOf(parsedOrStop(found.bytes));
  const sha256 = acceptanceSha256(found.bytes);
  const where = ctx.args.workspace ? ` --workspace ${JSON.stringify(ctx.root)}` : '';
  const trustCommand = `chatmcp verify trust --sha256 ${sha256}${where}`;
  const lines = listed.checks.map((check) => `  ${check.criterion}: ${check.run}${check.cwd === '.' ? '' : ` (cwd ${check.cwd})`}`);
  if (asked) {
    if (asked !== sha256) throw stop('sha256_mismatch', { expected: asked, actual: sha256 });
    const entry = await store.trust(sha256, { approvedBy: APPROVED_BY, at: ctx.now() });
    return { code: 'trusted', data: { ...base, sha256, trusted: true, approvedBy: entry.approvedBy, at: entry.at, ...listed }, params: { sha256 }, lines };
  }
  const entry = (await store.list()).find((row) => row.sha256 === sha256);
  if (entry) return { code: 'trusted', data: { ...base, sha256, trusted: true, approvedBy: entry.approvedBy, at: entry.at, ...listed }, params: { sha256 }, lines };
  return { code: 'not_trusted', data: { ...base, sha256, trusted: false, ...listed, trustCommand }, params: { sha256, trustCommand }, lines };
}

// ------------------------------------------------------------------------------------------------------------------------------ snapshot
async function snapshot(ctx) {
  const { root, state, shim } = await place(ctx);
  const before = await readAcceptance(shim);
  if (before.state === 'outside') throw stop('acceptance_outside');
  const base = await snapshotBaseline({ hubDir: state.hubDir, root, env: ctx.env, now: () => ctx.now() });
  // the raw bytes the trust store hashes, read on both sides of the snapshot: the same bytes are the baseline's acceptance file
  const after = await readAcceptance(shim);
  if (before.state !== after.state || (before.bytes && !before.bytes.equals(after.bytes))) throw stop('workspace_changed');
  const { record } = base;
  const taskId = `cli-${base.id}`;
  const bytes = before.state === 'present' ? before.bytes : null;
  const acceptance = { present: bytes !== null, sha256: bytes ? sha256Hex(bytes) : null, bytes: bytes ? bytes.length : null };
  if (bytes) await writeAtomic(state.acceptanceCopy(taskId), bytes);
  const ledger = ProofLedger.forTask(state.hubDir, taskId, { now: () => ctx.now() });
  await ledger.append('task_start', {
    format: SESSION_FORMAT, source: 'chatmcp verify snapshot', baselineId: base.id, baselineSha256: base.sha256,
    treeAlgorithm: record.treeAlgorithm, objectFormat: record.objectFormat, tree: record.tree, acceptance,
  });
  await writeSession(state, { taskId, baselineId: base.id, root, startedAt: record.createdAt });
  Object.assign(ctx, { taskId, baselineId: base.id });
  const trusted = bytes ? (await createTrustStore(state.hubDir).isTrusted(acceptance.sha256)) === true : false;
  return {
    code: 'snapshot_taken',
    data: {
      taskId, baselineId: base.id, baselineSha256: base.sha256, createdAt: record.createdAt, treeAlgorithm: record.treeAlgorithm, objectFormat: record.objectFormat,
      tree: record.tree, files: record.snapshot.files, bytes: record.snapshot.bytes, repository: record.git?.repository === true,
      patchAvailable: record.patch.available === true, patchReason: record.patch.reason ?? null,
      acceptance: { present: acceptance.present, sha256: acceptance.sha256, trusted },
      paths: { session: state.session, ledger: ledger.file, baseline: base.file, acceptanceCopy: bytes ? state.acceptanceCopy(taskId) : null },
    },
    params: { taskId, baselineId: base.id },
    lines: [`  ${record.treeAlgorithm} ${record.tree} (${record.snapshot.files} files)`, `  ledger: ${ledger.file}`],
  };
}

// ------------------------------------------------------------------------------------------------------------------------------ run
async function run(ctx) {
  const { root, state, shim } = await place(ctx);
  const loaded = await session(ctx, state, { allowTorn: true });
  const { options } = ctx.args;
  const runner = new ShellRunner({ workspace: shim, stateDirectory: state.shellState, env: ctx.env, secrets: () => [] });
  let shell;
  try { shell = await runner.resolveShell(options.shell ?? undefined); } catch (error) {
    if (['no_shell', 'shell_unavailable'].includes(error?.code)) throw stop('shell_unavailable', { shell: options.shell });
    throw error;
  }
  const command = joinCommand(ctx.args.words, shell.name);
  if (command.length > runner.maxCommandChars || command.includes('\0')) throw stop('bad_command', { max: runner.maxCommandChars });
  let cwd;
  try { cwd = await shim.resolve(options.cwd); } catch { throw stop('bad_cwd', { cwd: options.cwd }); }
  if (!(await fs.stat(cwd.absolute).catch(() => null))?.isDirectory()) throw stop('bad_cwd', { cwd: options.cwd });
  const ledger = new ProofLedger({ file: loaded.ledgerFile, now: () => ctx.now() });
  const snapshotter = new TreeSnapshotter({ root, stateDir: state.treeState, env: ctx.env });
  const toolchain = new ToolchainProbe({ env: ctx.env });
  const timeoutMs = options.timeoutSeconds === null ? DEFAULT_TIMEOUT_MS : options.timeoutSeconds * 1000;
  const { result, receipt, entry } = await recordCheck({ ledger, runner, snapshotter, toolchain, command, cwd: cwd.relative, shell: shell.name, timeoutMs, secrets: [] });
  const passed = passedRun(receipt);
  const stream = (value) => ({ sha256: value.sha256, bytes: value.bytes, truncated: value.truncated, preview: value.preview, previewTruncated: value.previewTruncated });
  return {
    code: passed ? 'check_passed' : 'check_failed',
    data: {
      taskId: loaded.taskId, command, shell: shell.name, cwd: result.cwd,
      receipt: {
        seq: entry.seq, hash: entry.hash, commandSha256: receipt.commandSha256, argsSha256: receipt.argsSha256, exit: receipt.exit, signal: receipt.signal,
        timedOut: receipt.timedOut, cancelled: receipt.cancelled, durationMs: receipt.durationMs, passed, stdout: stream(receipt.stdout), stderr: stream(receipt.stderr),
        treeBefore: receipt.treeBefore?.tree ?? null, treeAfter: receipt.treeAfter?.tree ?? null,
      },
    },
    params: { seq: entry.seq, exit: receipt.exit, timedOut: receipt.timedOut, cancelled: receipt.cancelled, signal: receipt.signal },
    // without --json the person sees what the command printed, then the receipt
    stdout: result.stdout, stderr: result.stderr,
  };
}

// ------------------------------------------------------------------------------------------------------------------------------ show
async function show(ctx) {
  const { root, state, shim } = await place(ctx);
  const loaded = await session(ctx, state);
  const baseline = await loadBaseline({ hubDir: state.hubDir, root, id: loaded.baselineId, expectSha256: loaded.anchor });
  const { record } = baseline;
  const store = createTrustStore(state.hubDir);
  const atStart = loaded.start.acceptance ?? {};
  const baselineAcceptance = { present: atStart.present === true, sha256: atStart.present === true ? atStart.sha256 : null, trusted: false };
  if (baselineAcceptance.sha256) baselineAcceptance.trusted = (await store.isTrusted(baselineAcceptance.sha256)) === true;
  const now = await readAcceptance(shim);
  const nowSha = now.state === 'present' ? sha256Hex(now.bytes) : null;
  const current = { present: nowSha !== null, sha256: nowSha, trusted: nowSha ? (await store.isTrusted(nowSha)) === true : false, changed: nowSha !== baselineAcceptance.sha256 };
  const checks = loaded.entries.filter((entry) => entry.type === 'check');
  const receipts = checks.slice(-SHOWN_RECEIPTS).map((entry) => ({
    seq: entry.seq, ts: entry.ts, command: entry.record.command, cwd: entry.record.cwd, shell: entry.record.shell, exit: entry.record.exit,
    passed: passedRun(entry.record), treeBefore: entry.record.treeBefore?.tree ?? null,
  }));
  return {
    code: 'session_intact',
    data: {
      taskId: loaded.taskId,
      baseline: {
        id: record.id, createdAt: record.createdAt, sha256: baseline.sha256, verifiedAgainst: baseline.verifiedAgainst, treeAlgorithm: record.treeAlgorithm,
        objectFormat: record.objectFormat, tree: record.tree, files: record.snapshot.files, bytes: record.snapshot.bytes, repository: record.git?.repository === true,
        patchAvailable: record.patch.available === true, patchReason: record.patch.reason ?? null,
      },
      ledger: { records: loaded.report.records, verified: loaded.report.ok, checks: checks.length, lastHash: loaded.report.lastHash },
      acceptance: { baseline: baselineAcceptance, current },
      receipts, receiptsOmitted: checks.length - receipts.length,
      paths: pathsOf(state, loaded, baseline.file),
    },
    params: { taskId: loaded.taskId },
    lines: [
      `  baseline ${record.id}: ${record.treeAlgorithm} ${record.tree} (${record.snapshot.files} files)`,
      `  ledger: ${loaded.report.records} records, ${checks.length} receipts`,
      ...receipts.map((receipt) => `  #${receipt.seq} ${receipt.passed ? 'ok  ' : 'FAIL'} exit ${receipt.exit}: ${receipt.command}`),
    ],
  };
}

// ------------------------------------------------------------------------------------------------------------------------------ pack
async function pack(ctx) {
  const { root, state, shim } = await place(ctx);
  const loaded = await session(ctx, state);
  const baseline = await loadBaseline({ hubDir: state.hubDir, root, id: loaded.baselineId, expectSha256: loaded.anchor });
  const { record } = baseline;
  const diff = await diffBaseline({ hubDir: state.hubDir, root, id: loaded.baselineId, expectSha256: loaded.anchor, env: ctx.env });
  if (diff.patch.status !== 'ok') throw stop(Object.hasOwn(CODES, diff.patch.reason) ? diff.patch.reason : 'baseline_objects_missing', { reason: diff.patch.reason });
  const current = await readAcceptance(shim);
  let acceptance;
  let parsedBaseline = null;
  try {
    acceptance = await resolveAcceptance({ baseline: loaded.acceptanceBytes, current: current.state === 'present' ? current.bytes : null, trustStore: createTrustStore(state.hubDir) });
    if (loaded.acceptanceBytes) parsedBaseline = parseAcceptance(loaded.acceptanceBytes);
  } catch (error) {
    if (error instanceof AcceptanceError) throw stop('acceptance_invalid', { file: ACCEPTANCE_FILE, line: error.line ?? null, reason: error.reason ?? error.message });
    throw error;
  }
  const work = path.join(state.folder, `work-${randomUUID()}`);
  let checkChanges;
  try {
    const baselineSide = await storeSide({
      git: await findGit(), env: ctx.env, storeDir: path.join(baselineFolder(state.hubDir, root), record.store.directory), entries: baseline.entries,
      objectFormat: record.objectFormat, scratch: path.join(work, 'store'),
    });
    const finalSide = await workTreeSide({ root, stateDir: path.join(work, 'final'), env: ctx.env });
    checkChanges = await detectCheckChanges({ baseline: baselineSide, final: finalSide, acceptance: parsedBaseline });
  } finally {
    await fs.rm(work, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
  const statement = buildAgentChangeStatement({
    agent: { name: ctx.args.options.agent, version: ctx.args.options.agentVersion },
    baseCommit: typeof record.git?.head === 'string' && GIT_ID.test(record.git.head) ? record.git.head : null,
    trees: {
      before: { status: 'ok', treeAlgorithm: record.treeAlgorithm, objectFormat: record.objectFormat, tree: record.tree, rawTree: record.rawTree, ...record.snapshot },
      after: { status: 'ok', ...diff.final },
    },
    diff: diff.patchBytes, acceptance, checkChanges, ledger: loaded.ledgerBytes, ownerAcceptances: [], cost: null, secrets: [],
  });
  const file = state.statement(loaded.taskId);
  await writeAtomic(file, `${canonicalJson(statement)}\n`);
  const criteria = statement.predicate.criteria.map((criterion) => ({ id: criterion.id, status: criterion.status }));
  const evidenced = criteria.filter((criterion) => criterion.status === 'evidenced' || criterion.status === 'owner_accepted').length;
  return {
    code: criteria.length > 0 && evidenced === criteria.length ? 'pack_evidenced' : 'pack_unverified',
    data: { taskId: loaded.taskId, file, digest: statementDigest(statement), statement, criteria, changes: diff.counts, receipts: statement.predicate.receipts.length },
    params: { file, total: criteria.length, notEvidenced: criteria.length - evidenced },
    lines: criteria.map((criterion) => `  ${criterion.id}: ${criterion.status}`),
  };
}

// ------------------------------------------------------------------------------------------------------------------------------ not built yet
function notBuilt(ctx) {
  throw stop('not_built', { command: ctx.args.command, plannedIn: NOT_BUILT[ctx.args.command] });
}

export const COMMAND_TABLE = Object.freeze({ help, version, init, trust, snapshot, run, exec: notBuilt, check: notBuilt, show, pack });
