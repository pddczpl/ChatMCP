// `chatmcp verify reproduce <pack> --base <commit|folder>` (P5 pod-32, docs/PROOF-CLI.md, "reproduce"): a third party re-runs the checks of a
// pack and learns which of its receipts reproduce on another machine.
//
// A pack can come from someone else, so its checks and its `reproduce.setup` are commands written by someone else: nothing runs unless the
// person trusted the exact bytes of the pack's acceptance file (`chatmcp verify trust --pack <file> --sha256 <hex>`, the trust store and
// the rule of `run` and `exec`). Then, in a temporary folder that is removed at the end, also after a failure and after Ctrl-C:
//   1. the base: a copy of the folder (without its .git) in a new repository, or a clone of the workspace's repository that shares its
//      objects (it writes nothing into it) with the commit checked out; Git runs pinned (no system or global configuration, no line-end
//      conversion, no hooks). Its tree must be the pack's before tree, else nothing runs;
//   2. the pack's patch, applied with `git apply`: the tree must then be the pack's after tree;
//   3. the setup commands, in order; the first that fails stops everything;
//   4. the checks, through the check runner of pod-21 (runAcceptanceChecks: the same trust gate, timeouts, tree snapshots, re-runs on a
//      changed tree and reaping of what a check leaves running), recorded in a ledger of the temporary folder; when a receipt diverges,
//      the checks run once more, so that an outcome that changes between runs is told from one that is stable here;
//   5. every receipt of the pack that ran on its final tree a check of its acceptance file is compared with the runs here: the same
//      outcome (exit code, timeout, signal) is `reproduced`, anything else `divergent` with a reason. Output hashes are not compared:
//      they rarely match across machines (paths, times, versions), so only the outcome and its reason are.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { maskSecrets } from '../../permissions.mjs';
import { ShellRunner, scrubEnv } from '../../shell-runner.mjs';
import { ACCEPTANCE_LIMITS, acceptanceSha256 } from '../acceptance.mjs';
import { runAcceptanceChecks } from '../check-runner.mjs';
import { findGit, pinnedArgs, pinnedEnv, runGit } from '../git-plumbing.mjs';
import { ProofLedger, ToolchainProbe, commandSha256 } from '../ledger.mjs';
import { TreeSnapshotter } from '../tree-snapshot.mjs';
import { createTrustStore } from '../trust-store.mjs';
import { readPackBytes, readPackFile, sameTree, subjectTree } from './check.mjs';
import { CliStop, stop } from './codes.mjs';
import { Interrupts } from './exec.mjs';
import { workspaceShim } from './session.mjs';

/** Why a receipt is divergent, in the order they are tried. */
export const REPRODUCE_REASONS = Object.freeze(['setup_failed', 'not_run', 'flaky', 'timed_out', 'missing_environment', 'shell_differs', 'toolchain_mismatch', 'exit_differs']);
/** Why a receipt of the pack is not compared: it ran on another tree, it is not a check of the acceptance file, or it was stopped. */
export const NOT_COMPARED = Object.freeze(['other_tree', 'not_a_check', 'cancelled']);
/** How many times at most the checks run: once, and once more when a receipt diverged. */
export const REPRODUCE_PASSES = 2;
const WORK_PREFIX = 'chatmcp-reproduce-';
const TOOLS = Object.freeze(['node', 'python', 'dotnet', 'git']);
const SHOWN_RUNS = 20;
const DETAIL_CHARS = 600;
const OUTPUT_CHARS = 2000;
const GIT_TIMEOUT_MS = 600_000;
// the reasons a second pass can change: an outcome that is stable here may still change between runs
const RERUN = new Set(['timed_out', 'missing_environment', 'shell_differs', 'toolchain_mismatch', 'exit_differs']);

/** A run's outcome as one text: `exit <n>`, `timed out`, `cancelled` or `signal <name>`. */
export const runOutcome = (run) => (run.timedOut ? 'timed out' : run.cancelled ? 'cancelled' : run.signal ? `signal ${run.signal}` : `exit ${run.exit}`);

/** The environment variables a command names: $NAME, ${NAME}, $env:NAME (PowerShell); an escaped \$NAME and $_ are not variables. */
export function variablesNamed(command) {
  const names = [];
  for (const match of String(command).matchAll(/(\\?)\$(?:[eE][nN][vV]:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g)) {
    const name = match[2] ?? match[3] ?? match[4];
    if (!match[1] && name !== '_' && !names.includes(name)) names.push(name);
  }
  return names;
}

/** The variables `command` names that the checks here do not get (unset, empty, or removed as credentials by ShellRunner's scrub). */
function missingVariables(command, env, platform = process.platform) {
  const fold = (name) => (platform === 'win32' ? name.toUpperCase() : name);
  const present = new Set(Object.entries(scrubEnv(env)).filter(([, value]) => typeof value === 'string' && value !== '').map(([name]) => fold(name)));
  return variablesNamed(command).filter((name) => !present.has(fold(name)));
}

/** The tools whose version the pack recorded and that differ here: `node 24.1.0 in the pack, 22.12.0 here`. */
function toolchainChanges(packed, here) {
  if (!packed) return [];
  return TOOLS.filter((tool) => typeof packed[tool] === 'string' && here?.[tool] !== packed[tool]).map((tool) => `${tool} ${packed[tool]} in the pack, ${here?.[tool] ?? 'none'} here`);
}

/**
 * The verdict on one receipt of the pack: {status: 'reproduced' | 'divergent', reason, detail}. `attempts` are the runs of its check here
 * (every pass), `packOutcomes` the outcomes of the pack's compared receipts of the same check, `missing` the variables its command names
 * that are not set here, `shell` the shell the checks ran in here, `setupFailed` {command, outcome} when the setup stopped everything,
 * `error` why the check could not start here. The reasons are tried in the order of REPRODUCE_REASONS.
 */
export function verdictOf({ receipt, attempts, packOutcomes = [], missing = [], shell = null, setupFailed = null, error = null }) {
  const divergent = (reason, detail) => ({ status: 'divergent', reason, detail: String(detail).slice(0, DETAIL_CHARS) });
  const packed = runOutcome(receipt);
  if (setupFailed) return divergent('setup_failed', `the setup command ${setupFailed.command} ended with ${setupFailed.outcome}; no check ran`);
  if (!attempts.length) return divergent('not_run', error ? `the check did not run here (${error})` : 'the check did not run here');
  const here = [...new Set(attempts.map(runOutcome))];
  if (here.length > 1) return divergent('flaky', `the check gave ${here.join(' and ')} here`);
  const [outcome] = here;
  if (outcome === packed) return { status: 'reproduced', reason: null, detail: null };
  const outcomes = `${packed} in the pack, ${outcome} here`;
  if (packOutcomes.includes(outcome)) return divergent('flaky', `the pack itself has ${[...new Set(packOutcomes)].join(' and ')} for this check on its final tree; ${outcome} here`);
  if (outcome === 'timed out' || packed === 'timed out') return divergent('timed_out', outcomes);
  if (missing.length) return divergent('missing_environment', `the command names ${missing.map((name) => `$${name}`).join(', ')}, not set here; ${outcomes}`);
  if (shell && receipt.shell !== shell) return divergent('shell_differs', `${receipt.shell} in the pack, ${shell} here; ${outcomes}`);
  const tools = toolchainChanges(receipt.toolchain, attempts.at(-1).toolchain);
  if (tools.length) return divergent('toolchain_mismatch', `${tools.join(', ')}; ${outcomes}`);
  return divergent('exit_differs', outcomes);
}

const normalCwd = (cwd) => {
  const text = String(cwd ?? '').replaceAll('\\', '/').replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');
  return text === '' ? '.' : text;
};
const sameRef = (ref, side) => ref !== null && ref.treeAlgorithm === side.treeAlgorithm && ref.objectFormat === side.objectFormat && ref.tree === side.tree;

/**
 * Which receipts of the pack are compared, and with which check of its acceptance file: a receipt matches a check by the sha256 of its
 * command and its folder (the spec's rule); it is compared when it started on the pack's final tree and was not stopped.
 */
function planOf(statement, parsed) {
  const after = subjectTree(statement, 'after');
  const checks = (parsed?.criteria ?? []).flatMap((criterion) => (criterion.checks ?? []).map((check, index) => ({
    criterion: criterion.id, index, run: check.run, cwd: normalCwd(check.cwd), key: `${commandSha256(check.run)} ${normalCwd(check.cwd)}`,
  })));
  const compared = [];
  const notCompared = [];
  for (const receipt of statement.predicate.receipts) {
    const check = checks.find((candidate) => candidate.key === `${receipt.commandSha256} ${normalCwd(receipt.cwd)}`);
    if (!check) notCompared.push({ seq: receipt.seq, why: 'not_a_check' });
    else if (receipt.cancelled) notCompared.push({ seq: receipt.seq, why: 'cancelled' });
    else if (!sameRef(receipt.treeBefore, after)) notCompared.push({ seq: receipt.seq, why: 'other_tree' });
    else compared.push({ receipt, check });
  }
  return { checks, compared, notCompared };
}

/** The folder reproduce works in: the temporary folder of the environment it was given (TEMP or TMP on Windows, TMPDIR, TMP or TEMP elsewhere). */
function tempRootOf(env, platform = process.platform) {
  const names = platform === 'win32' ? ['TEMP', 'TMP'] : ['TMPDIR', 'TMP', 'TEMP'];
  const found = names.map((name) => env?.[name]).find((value) => typeof value === 'string' && value.trim() !== '');
  return path.resolve(found ?? os.tmpdir());
}
const caseFold = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
const within = (outer, inner) => {
  const relative = path.relative(caseFold(outer), caseFold(inner));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};
const firstLine = (text) => String(text ?? '').trim().split(/\r?\n/)[0].slice(0, 500);
const percentOf = (share) => (share === null ? 'none' : Number.isInteger(share * 100) ? `${share * 100}%` : `${(share * 100).toFixed(1)}%`);

/**
 * --base, before anything is made: an existing folder ({kind: 'folder', folder}), else a commit of the workspace's repository ({kind:
 * 'commit'}, resolved later by commitOf); bad_base when the workspace has no repository to name a commit in.
 */
async function baseOf({ value, cwd, root }) {
  const asked = path.resolve(cwd, value);
  if ((await fs.stat(asked).catch(() => null))?.isDirectory()) return { kind: 'folder', value, folder: await fs.realpath(asked), commit: null };
  if (!(await fs.stat(path.join(root, '.git')).catch(() => null))) throw stop('bad_base', { base: value, why: 'no_repository' });
  return { kind: 'commit', value, folder: null, commit: null };
}
/** The commit --base names, read in the workspace's repository (rev-parse only reads it), or bad_base. */
async function commitOf({ value, root, git, gitEnv, hooks, signal }) {
  const found = await runGit(git, [...pinnedArgs(hooks), 'rev-parse', '--verify', '--quiet', '--end-of-options', `${value}^{commit}`], { cwd: root, env: gitEnv, timeoutMs: GIT_TIMEOUT_MS, signal });
  const commit = found.stdout.toString('utf8').trim();
  if (found.code !== 0 || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) throw stop('bad_base', { base: value, why: 'unknown_commit' });
  return commit;
}

/** The temporary worktree at the base: a copy of the folder in a new repository, or a clone that shares the repository's objects. */
async function buildWorktree({ base, root, tree, git, gitEnv, hooks, objectFormat, signal }) {
  const run = async (args, cwd) => {
    const result = await runGit(git, [...pinnedArgs(hooks), ...args], { cwd, env: gitEnv, timeoutMs: GIT_TIMEOUT_MS, signal });
    if (result.code !== 0) throw stop('io_error', { message: `git ${args[0]}: ${firstLine(result.stderr)}` });
  };
  if (base.kind === 'folder') {
    const own = path.join(base.folder, '.git');
    await fs.cp(base.folder, tree, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false, filter: (source) => path.resolve(source) !== own });
    await run(['init', '-q', ...(objectFormat === 'sha256' ? ['--object-format=sha256'] : []), tree], path.dirname(tree));
  } else {
    await run(['clone', '--shared', '--no-checkout', '--quiet', '--', root, tree], path.dirname(tree));
    await run(['checkout', '--quiet', '--detach', base.commit], tree);
  }
}

/** The parsed records of the reproduction's own ledger, by seq. */
async function recordsOf(file) {
  const text = await fs.readFile(file, 'utf8').catch(() => '');
  return new Map(text.split('\n').filter(Boolean).map((line) => JSON.parse(line)).map((entry) => [entry.seq, entry.record]));
}

/** chatmcp verify reproduce (commands.mjs hands it `placeOutside`, `parsedOrStop` and `resolveShell`). */
export async function reproduceCommand(ctx, steps) {
  const { root, hubDir } = await steps.placeOutside(ctx);
  const file = path.resolve(ctx.cwd, ctx.args.pack);
  const read = readPackFile(await readPackBytes(file));
  const { statement, files } = read;
  const acceptanceBytes = files['acceptance.yml'] ?? null;
  const parsed = acceptanceBytes ? steps.parsedOrStop(acceptanceBytes) : null;
  const plan = planOf(statement, parsed);
  const count = (why) => plan.notCompared.filter((row) => row.why === why).length;
  if (!plan.compared.length) {
    throw stop('nothing_to_reproduce', { receipts: statement.predicate.receipts.length, otherTree: count('other_tree'), notACheck: count('not_a_check'), cancelled: count('cancelled') });
  }
  // nothing of the pack runs before the person trusted these exact bytes
  const sha256 = acceptanceSha256(acceptanceBytes);
  const trustStore = createTrustStore(hubDir);
  const listed = { setup: parsed.reproduce.setup, checks: plan.checks.map(({ criterion, run, cwd }) => ({ criterion, run, cwd })) };
  const trustCommand = `chatmcp verify trust --sha256 ${sha256} --pack ${JSON.stringify(file)}`;
  const untrusted = () => ({
    code: 'not_trusted', detail: { pack: file, sha256, trustCommand, ...listed }, params: { sha256, trustCommand },
    lines: [...listed.setup.map((command) => `  setup: ${command}`), ...listed.checks.map((check) => `  ${check.criterion}: ${check.run}${check.cwd === '.' ? '' : ` (cwd ${check.cwd})`}`)],
  });
  if ((await trustStore.isTrusted(sha256)) !== true) return untrusted();

  // the temporary folder lies outside the base folder, and outside the repository a base commit is cloned from: reproduce never writes
  // into either (with a base folder, the workspace is not read at all)
  const base = await baseOf({ value: ctx.args.options.base, cwd: ctx.cwd, root });
  const tempRoot = await fs.realpath(tempRootOf(ctx.env)).catch(() => tempRootOf(ctx.env));
  const kept = base.kind === 'commit' ? root : base.folder;
  if (within(kept, tempRoot)) throw stop('state_inside_workspace', { stateFolder: tempRoot, workspace: kept });
  const git = await findGit();
  if (!git) throw stop('git_missing');
  const interrupts = new Interrupts(ctx.signals ?? process);
  const { signal } = interrupts;
  interrupts.listen();
  let work = null;
  let answer = null;
  let failure = null;
  try {
    work = await fs.realpath(await fs.mkdtemp(path.join(tempRoot, WORK_PREFIX)));
    answer = await reproduceIn({ ctx, steps, work, root, base, file, read, parsed, plan, acceptanceBytes, trustStore, untrusted, git, signal });
  } catch (error) {
    // after a Ctrl-C, whatever a step threw is the interruption, unless it is an answer of its own
    failure = signal.aborted && !(error instanceof CliStop) ? stop('reproduce_interrupted', { step: 'unknown' }) : error;
  }
  // the temporary folder goes whatever happened; a second Ctrl-C meanwhile is still caught here
  const leftover = work ? await fs.rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).then(() => null, () => work) : null;
  interrupts.stop();
  if (failure) {
    if (failure instanceof CliStop && leftover) failure.detail = { ...failure.detail, leftover };
    throw failure;
  }
  if (answer.data) answer.data.leftover = leftover;
  return answer;
}

async function reproduceIn({ ctx, steps, work, root, base, file, read, parsed, plan, acceptanceBytes, trustStore, untrusted, git, signal }) {
  const { statement } = read;
  const before = subjectTree(statement, 'before');
  const after = subjectTree(statement, 'after');
  const tree = path.join(work, 'tree');
  const scratch = path.join(work, 'state');
  const hooks = path.join(scratch, 'hooks');
  const emptyConfig = path.join(scratch, 'empty.gitconfig');
  await fs.mkdir(hooks, { recursive: true });
  await fs.writeFile(emptyConfig, '');
  const gitEnv = pinnedEnv(ctx.env, { emptyConfig });
  const interrupted = (step) => stop('reproduce_interrupted', { step });
  const step = async (name, task) => {
    if (signal.aborted) throw interrupted(name);
    try { return await task(); } catch (error) { if (signal.aborted) throw interrupted(name); throw error; }
  };

  // 1. the base, which must be the pack's before tree
  if (base.kind === 'commit') base.commit = await step('base', () => commitOf({ value: base.value, root, git, gitEnv, hooks, signal }));
  await step('base', () => buildWorktree({ base, root, tree, git, gitEnv, hooks, objectFormat: before.objectFormat, signal }));
  const engine = before.treeAlgorithm === 'raw-v1' ? 'raw-v1' : 'auto';
  const snapshotter = new TreeSnapshotter({ root: tree, stateDir: path.join(scratch, 'tree'), env: ctx.env, engine });
  const atBase = await step('base', () => snapshotter.snapshot({ full: true, signal }));
  if (!sameTree(atBase, before)) throw stop('base_mismatch', { base: base.value, expected: before.tree, actual: atBase.tree ?? null, treeAlgorithm: atBase.treeAlgorithm ?? null });

  // 2. the patch, which must give the pack's after tree
  const patch = read.files['change.diff'];
  if (patch.length) {
    const patchFile = path.join(scratch, 'change.diff');
    await fs.writeFile(patchFile, patch);
    const applied = await step('patch', () => runGit(git, [...pinnedArgs(hooks), 'apply', '--binary', '--whitespace=nowarn', patchFile], { cwd: tree, env: gitEnv, timeoutMs: GIT_TIMEOUT_MS, signal }));
    if (applied.code !== 0) throw stop('patch_does_not_reproduce', { why: 'apply_failed', message: firstLine(applied.stderr) });
  }
  const patched = await step('patch', () => snapshotter.snapshot({ full: true, signal }));
  if (!sameTree(patched, after)) throw stop('patch_does_not_reproduce', { why: 'tree_differs', expected: after.tree, actual: patched.tree ?? null });

  // 3. the setup, in order; the first command that does not pass stops everything
  const runner = new ShellRunner({ workspace: workspaceShim(tree, { studio: path.join(scratch, 'studio') }), stateDirectory: path.join(scratch, 'shell'), env: ctx.env,
    secrets: () => [], maxTimeoutMs: ACCEPTANCE_LIMITS.timeout.max * 1000 });
  const shell = await steps.resolveShell(runner, null);
  const setup = [];
  let setupFailed = null;
  for (const command of parsed.reproduce.setup) {
    const result = await step('setup', () => runner.run({ command, cwd: '', timeoutMs: runner.maxTimeoutMs, signal }));
    if (signal.aborted) throw interrupted('setup');
    const run = { exit: Number.isInteger(result.exitCode) ? result.exitCode : null, signal: result.signal ?? null, timedOut: result.timedOut === true, cancelled: result.cancelled === true };
    const passed = run.exit === 0 && !run.timedOut && !run.cancelled && run.signal === null;
    const output = passed ? null : maskSecrets(`${result.stdout ?? ''}${result.stderr ?? ''}`, []).slice(-OUTPUT_CHARS) || null;
    setup.push({ command: maskSecrets(command, []), outcome: runOutcome(run), passed, durationMs: Number.isSafeInteger(result.durationMs) ? result.durationMs : 0, output });
    if (!passed) { setupFailed = { command: maskSecrets(command, []), outcome: runOutcome(run) }; break; }
  }

  // 4. the checks, through the check runner, once, and once more when a receipt diverged
  const ledger = new ProofLedger({ file: path.join(scratch, 'ledger.jsonl'), now: () => ctx.now() });
  const toolchain = new ToolchainProbe({ env: ctx.env });
  const keyOf = new Map(plan.checks.map((check) => [`${check.criterion}#${check.index}`, check.key]));
  const attempts = new Map();
  const errors = new Map();
  let passes = 0;
  let checksTree = null;
  const runPass = async () => {
    const result = await step('checks', () => runAcceptanceChecks({ baseline: acceptanceBytes, current: acceptanceBytes, trustStore, runner, ledger, snapshotter, toolchain, signal }));
    if (result.cancelled || signal.aborted) throw interrupted('checks');
    if (result.blocked) return false;
    passes += 1;
    const records = await recordsOf(ledger.file);
    for (const attempt of result.attempts) {
      const key = keyOf.get(`${attempt.criterionId}#${attempt.index}`);
      const record = records.get(attempt.seq) ?? null;
      if (checksTree === null && record?.treeBefore) checksTree = record.treeBefore;
      attempts.set(key, [...(attempts.get(key) ?? []), { exit: attempt.exit, signal: attempt.signal, timedOut: attempt.timedOut, cancelled: attempt.cancelled, toolchain: record?.toolchain ?? null }]);
    }
    for (const row of result.checks) if (row.error) errors.set(keyOf.get(`${row.criterionId}#${row.index}`), row.error.code);
    return true;
  };
  // 5. each compared receipt against the runs of its check here
  const outcomesOf = new Map();
  for (const { receipt, check } of plan.compared) outcomesOf.set(check.key, [...(outcomesOf.get(check.key) ?? []), runOutcome(receipt)]);
  const judge = () => plan.compared.map(({ receipt, check }) => {
    const runs = attempts.get(check.key) ?? [];
    const verdict = verdictOf({
      receipt, attempts: runs, packOutcomes: outcomesOf.get(check.key), missing: missingVariables(check.run, ctx.env), shell: shell.name, setupFailed, error: errors.get(check.key) ?? null,
    });
    return {
      seq: receipt.seq, criterion: check.criterion, index: check.index, command: receipt.command, cwd: normalCwd(receipt.cwd), ...verdict,
      pack: runOutcome(receipt), here: runs.slice(0, SHOWN_RUNS).map(runOutcome),
    };
  });
  if (!setupFailed) {
    if (!(await runPass())) return untrusted(); // the approval was revoked meanwhile
    if (judge().some((row) => RERUN.has(row.reason)) && passes < REPRODUCE_PASSES && !(await runPass())) return untrusted();
  }
  const receipts = judge();
  const compared = receipts.length;
  const reproduced = receipts.filter((row) => row.status === 'reproduced').length;
  const share = compared ? reproduced / compared : null;
  const percent = percentOf(share);
  const ref = (snap) => (snap ? { treeAlgorithm: snap.treeAlgorithm, objectFormat: snap.objectFormat, tree: snap.tree } : null);
  return {
    code: reproduced === compared ? 'reproduced' : 'reproduce_divergent',
    data: {
      pack: { file, digest: read.digest }, base: { kind: base.kind, value: base.value, folder: base.folder, commit: base.commit },
      trees: { before: before.tree, after: after.tree, checks: checksTree?.tree ?? null, checksOnPackTree: checksTree ? sameTree({ status: 'ok', ...ref(checksTree) }, after) : null },
      treeAlgorithm: after.treeAlgorithm, objectFormat: after.objectFormat, shell: shell.name, setup, passes,
      receipts, notCompared: plan.notCompared, compared, reproduced, divergent: compared - reproduced, share, leftover: null,
    },
    params: { reproduced, compared, divergent: compared - reproduced, percent },
    lines: [
      ...setup.map((row) => `  setup ${row.passed ? 'ok  ' : 'FAIL'} ${row.outcome}: ${row.command}`),
      ...receipts.map((row) => `  #${row.seq} ${row.status === 'reproduced' ? 'reproduced' : `divergent (${row.reason})`}: ${row.command}${row.detail ? ` - ${row.detail}` : ''}`),
      ...(plan.notCompared.length ? [`  not compared: ${NOT_COMPARED.map((why) => `${plan.notCompared.filter((row) => row.why === why).length} ${why}`).join(', ')}`] : []),
    ],
  };
}
