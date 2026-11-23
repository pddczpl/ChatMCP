// The scoring and the metrics of the Proof-of-Done benchmark corpus (plan task P7 pod-38, corpus/SCORING.md):
//
//   corpus/tools/score.mjs     a run pack (one run's evidence: the run, the hidden-test score, the final message, the cost, the proof pack)
//                              -> one result line; every pack of a folder -> results.jsonl, recomputable byte for byte
//   corpus/tools/metrics.mjs   results.jsonl -> the metrics of corpus/tools/protocol.mjs per agent, Wilson 95 percent intervals, the
//                              oracle and null-agent controls, the kill rule
//
// No model and no vendor CLI runs here. The result sets are synthetic, with answers worked out by hand; the proof packs are real
// statements of DatGold's pack builder (pod-29) over synthetic receipts; the last part runs scripted agents through the real run sandbox
// and scoring checkout (pod-36) and scores what they did.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

let checks = 0;
const suiteStart = performance.now();
const ok = (label) => { checks += 1; console.log(`  ok - ${label} [${((performance.now() - suiteStart) / 1000).toFixed(1)} s]`); };

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The corpus stands beside the Hub: in the repository, and in a copy the mutation runner makes (tests/mutation/corpus-scoring.json).
const CORPUS = path.resolve(HUB, '..', 'corpus');
if (!existsSync(CORPUS) && !existsSync(path.join(HUB, '..', 'README.md'))) {
  console.log('CHATMCP_TEST_SKIP: corpus/ was not found next to DATGOLD-HUB (the corpus tools need the whole repository)');
  process.exit(0);
}
const TOOLS = path.join(CORPUS, 'tools');
const importTool = (name) => import(pathToFileURL(path.join(TOOLS, name)).href);
const importHub = (name) => import(pathToFileURL(path.join(HUB, ...name.split('/'))).href);
const scoring = await importTool('score.mjs');
const metricsTool = await importTool('metrics.mjs');
const { loadCorpus, loadTask } = await importTool('load.mjs');
const { PROTOCOL, PROTOCOL_VERSION, METRICS, KILL_RULE, THRESHOLDS } = await importTool('protocol.mjs');
const { MARKER_CONTRACT } = await importTool('marker.mjs');
const { AGENT_ID } = await importTool('freeze.mjs');
const { OUTCOMES } = await importTool('score-checkout.mjs');
const { canonicalJson, buildRunPack, runPackBytes, readRunPack, scoreRun, scoreRuns, RUN_PACK_FORMAT, RESULT_FORMAT } = scoring;
const { wilson, rateOf, readResults, computeMetrics, WILSON_Z, METRICS_FORMAT } = metricsTool;
const pack = await importHub('lib/proof/pack.mjs');
const { ProofLedger, checkReceipt, ledgerPath } = await importHub('lib/proof/ledger.mjs');
const { acceptanceSha256, parseAcceptance, resolveAcceptance } = await importHub('lib/proof/acceptance.mjs');
const { createTrustStore } = await importHub('lib/proof/trust-store.mjs');
const { detectCheckChanges, memorySide } = await importHub('lib/proof/tamper.mjs');

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const clone = (value) => JSON.parse(JSON.stringify(value));
const ROOT = realpathSync.native(await fs.mkdtemp(path.join(os.tmpdir(), 'datgold-corpus-scoring-')));
const SCORE = path.join(TOOLS, 'score.mjs');
const METRICS_CLI = path.join(TOOLS, 'metrics.mjs');
const node = (script, args, env = process.env) => spawnSync(process.execPath, [script, ...args], { cwd: ROOT, env, encoding: 'utf8', windowsHide: true, timeout: 120_000 });

/** Runs `fn` and expects a refusal of the tool with `code` (the error's name is ScoreError or MetricsError). */
function refused(fn, code, what) {
  let caught = null;
  try { fn(); } catch (error) { caught = error; }
  assert.ok(caught, `${what}: refused`);
  assert.ok(['ScoreError', 'MetricsError'].includes(caught.name), `${what}: ${caught.stack}`);
  assert.equal(caught.code, code, `${what}: ${caught.message}`);
  return caught;
}

// The example corpus: two tasks (example-slugify, example-sum) whose hashes, acceptance files and oracle patches are real files.
const EXAMPLES = path.join(CORPUS, 'examples');
const loaded = await loadCorpus(EXAMPLES);
assert.deepEqual(loaded.errors, []);
const TASKS = loaded.tasks;
const [T1, T2] = TASKS;
assert.deepEqual(TASKS.map((task) => task.id), ['example-slugify', 'example-sum']);
const fileOf = (task, name) => task.files.find((entry) => entry.name === name);

// =====================================================================================================================
// 1. the Wilson score interval
// =====================================================================================================================
{
  // z is the 0.975 quantile of the standard normal distribution
  assert.equal(WILSON_Z, 1.959963984540054);
  // published values: Newcombe (1998), "Two-sided confidence intervals for the single proportion", Table I, method 3 (score, no
  // continuity correction), and the textbook 1 of 10
  const published = [[81, 263, 0.2553, 0.3662], [15, 148, 0.0624, 0.1605], [0, 20, 0, 0.1611], [1, 29, 0.0061, 0.1718], [1, 10, 0.0179, 0.4042], [0, 10, 0, 0.2775]];
  for (const [k, n, low, high] of published) {
    const interval = wilson(k, n);
    assert.equal(Number(interval.low.toFixed(4)), low, `${k}/${n}: low ${interval.low}`);
    assert.equal(Number(interval.high.toFixed(4)), high, `${k}/${n}: high ${interval.high}`);
  }
  // the other closed form of the same interval, over every k of every n up to 60
  const z2 = WILSON_Z * WILSON_Z;
  let compared = 0;
  for (let n = 1; n <= 60; n += 1) {
    for (let k = 0; k <= n; k += 1) {
      const root = WILSON_Z * Math.sqrt(z2 + (4 * k * (n - k)) / n);
      const { low, high } = wilson(k, n);
      assert.ok(Math.abs(low - Math.max(0, (2 * k + z2 - root) / (2 * (n + z2)))) < 1e-12, `${k}/${n} low`);
      assert.ok(Math.abs(high - Math.min(1, (2 * k + z2 + root) / (2 * (n + z2)))) < 1e-12, `${k}/${n} high`);
      assert.ok(low >= 0 && low <= k / n && k / n <= high && high <= 1, `${k}/${n}: 0 <= low <= p <= high <= 1`);
      assert.ok(Math.abs(low - (1 - wilson(n - k, n).high)) < 1e-12, `${k}/${n}: symmetric`);
      compared += 1;
    }
  }
  // p = 0 and p = 1: the bound at the edge is exactly 0 or 1, the other is z^2 / (n + z^2) away from it
  for (let n = 1; n <= 5000; n += 1) {
    assert.ok(Object.is(wilson(0, n).low, 0), `0/${n}: low is exactly 0, not ${wilson(0, n).low}`);
    assert.ok(Object.is(wilson(n, n).high, 1), `${n}/${n}: high is exactly 1, not ${wilson(n, n).high}`);
  }
  for (const n of [1, 2, 3, 10, 1000, 2 ** 40]) {
    assert.equal(wilson(0, n).low, 0);
    assert.equal(wilson(n, n).high, 1);
    assert.ok(Math.abs(wilson(0, n).high - z2 / (n + z2)) < 1e-12, `0/${n} high`);
    assert.ok(Math.abs(wilson(n, n).low - n / (n + z2)) < 1e-12, `${n}/${n} low`);
  }
  assert.ok(Math.abs(wilson(0, 3).high - 0.5614970) < 1e-7, `0/3: ${wilson(0, 3).high}`);
  // no run, no interval; and a rate says so too
  assert.equal(wilson(0, 0), null);
  assert.deepEqual(rateOf(0, 0), { k: 0, n: 0, rate: null, low: null, high: null });
  assert.deepEqual(rateOf(2, 4), { k: 2, n: 4, rate: 0.5, ...wilson(2, 4) });
  for (const [k, n] of [[1, 0], [-1, 3], [4, 3], [1.5, 3], [1, 2.5], [Number.NaN, 3], [1, Number.NaN], [1, Infinity], ['1', 3], [null, 3], [1, 2 ** 53]]) {
    refused(() => wilson(k, n), 'bad_count', `wilson(${k}, ${n})`);
  }
  ok(`Wilson 95 percent: Newcombe's published intervals, the other closed form over ${compared} counts, exact 0 and 1 at p = 0 and p = 1, no interval for n = 0, bad counts refused`);
}

// =====================================================================================================================
// 2. canonical JSON
// =====================================================================================================================
{
  assert.equal(canonicalJson({ b: 1, a: [true, null, 'x'], c: { z: 0.5, y: -0 } }), '{"a":[true,null,"x"],"b":1,"c":{"y":0,"z":0.5}}');
  // keys sorted by UTF-16 code units, as RFC 8785 and Array.prototype.sort sort them
  assert.equal(canonicalJson({ '\u{1F600}': 1, 'דּ': 2, a: 3, 'é': 4 }), '{"a":3,"é":4,"\u{1F600}":1,"דּ":2}');
  assert.equal(canonicalJson({ n: 1e21, m: 2e-7, s: 'line\nbreak "q"  ' }), '{"m":2e-7,"n":1e+21,"s":"line\\nbreak \\"q\\"  "}');
  const sample = { b: [1, { d: 2, c: 'x' }], a: 0.1, e: 'é\n\u0001', f: 1e-7, g: -0, h: 123456789012345680000 };
  assert.equal(canonicalJson(sample), pack.canonicalJson(sample));
  const deep = (levels) => { let value = 1; for (let level = 0; level < levels; level += 1) value = [value]; return value; };
  assert.equal(canonicalJson(deep(64)).length, 129);
  const holes = [1]; holes[2] = 3;
  for (const [label, value] of [['NaN', Number.NaN], ['Infinity', Infinity], ['undefined', undefined], ['an undefined field', { a: undefined }], ['a Date', new Date(0)],
    ['a Map', new Map()], ['a Buffer', Buffer.from('x')], ['a BigInt', 1n], ['a function', () => 1], ['a hole', holes], ['a lone surrogate', '\uD800'],
    ['a lone surrogate as a key', { '\uDC00': 1 }], ['65 levels', deep(65)], ['a million levels', deep(1_000_000)]]) {
    refused(() => canonicalJson(value), 'not_canonical_value', label);
  }
  ok('canonical JSON: keys in UTF-16 order, no white space, numbers as JavaScript writes them (-0 is 0), the same bytes as the proof pack\'s RFC 8785 writer; NaN, Infinity, undefined, non-plain objects, holes, lone surrogates and nesting past 64 levels refused');
}

// =====================================================================================================================
// 3. run packs and the result of one run
// =====================================================================================================================
const BASE_TREE = '1'.repeat(40);
const FINAL_TREE = '2'.repeat(40);
const AT = '2026-11-22T10:00:00.000Z';
const snapshot = (tree) => ({
  format: 'chatmcp.tree-snapshot/1', status: 'ok', treeAlgorithm: 'git-pinned-v1', tree, rawTree: null, objectFormat: 'sha1', full: true, engineReason: null, ignoreRules: 'git',
  files: 12, bytes: 3400, excluded: { protected: 1, runs: 0, gitlinks: 0 }, limits: { maxFiles: 200_000, maxBytes: 2 ** 31 }, limitations: ['untracked-ignored-paths-not-covered'], takenAt: AT, durationMs: 4,
});
const shellResult = ({ cwd = '.', exitCode = 0 } = {}) => ({
  cwd, shell: 'bash', exitCode, signal: null, timedOut: false, cancelled: false, lingering: false, stdout: '', stderr: '', truncated: { stdout: false, stderr: false },
  outputSha256: { stdout: sha256(''), stderr: sha256('') }, outputBytes: { stdout: 0, stderr: 0 }, durationMs: 7,
});
let hubCount = 0;
/**
 * A real agent-change statement (pod-29) of `task`: its acceptance file trusted, one receipt per check on the final tree that passed or
 * failed, and the pod-22 report of a change that removed an assertion from a test (tamper) or only changed src (no tamper), or no report.
 */
async function realStatement(task, { pass = true, tamper = false, report = true, acceptanceText = readFileSync(path.join(task.dir, task.task.acceptance), 'utf8') } = {}) {
  let checkIndex = 0;
  const passes = () => (Array.isArray(pass) ? pass[checkIndex++] : pass);
  const hub = path.join(ROOT, 'hubs', `h${(hubCount += 1)}`);
  await fs.mkdir(hub, { recursive: true });
  const trustStore = createTrustStore(hub);
  await trustStore.trust(acceptanceSha256(acceptanceText), { approvedBy: 'owner', at: AT });
  const acceptance = await resolveAcceptance({ baseline: acceptanceText, current: acceptanceText, trustStore });
  const ledger = ProofLedger.forTask(hub, 'run', { now: () => new Date(AT) });
  await ledger.append('task_start', { taskId: 'run' });
  for (const criterion of parseAcceptance(acceptanceText).criteria) {
    for (const check of criterion.checks ?? []) {
      await ledger.append('check', checkReceipt({ command: check.run, result: shellResult({ cwd: check.cwd, exitCode: passes() ? check.expect.exit : 1 }), treeBefore: snapshot(FINAL_TREE), treeAfter: snapshot(FINAL_TREE) }));
    }
  }
  const before = { '.chatmcp/acceptance.yml': acceptanceText, 'test/a.test.mjs': "import assert from 'node:assert';\nassert.equal(1, 1);\nassert.equal(2, 2);\n", 'src/a.mjs': 'v1\n' };
  const after = { ...before, 'src/a.mjs': 'v2\n', ...(tamper ? { 'test/a.test.mjs': "import assert from 'node:assert';\nassert.equal(1, 1);\n" } : {}) };
  const checkChanges = report ? await detectCheckChanges({ baseline: memorySide(before), final: memorySide(after), acceptance: parseAcceptance(acceptanceText) }) : null;
  const statement = pack.buildAgentChangeStatement({
    agent: { name: 'scripted', version: '1' }, trees: { before: snapshot(BASE_TREE), after: snapshot(FINAL_TREE) }, diff: 'a diff', acceptance, checkChanges,
    ledger: readFileSync(ledgerPath(hub, 'run')), cost: null,
  });
  assert.deepEqual(pack.validateStatement(statement), { valid: true, errors: [] });
  return statement;
}
const STATEMENTS = {
  pass: { [T1.id]: await realStatement(T1), [T2.id]: await realStatement(T2) },
  fail: { [T1.id]: await realStatement(T1, { pass: false }), [T2.id]: await realStatement(T2, { pass: false }) },
  tamper: { [T1.id]: await realStatement(T1, { tamper: true }), [T2.id]: await realStatement(T2, { tamper: true }) },
  noReport: { [T1.id]: await realStatement(T1, { report: false }), [T2.id]: await realStatement(T2, { report: false }) },
};
assert.equal(STATEMENTS.tamper[T1.id].predicate.checkChanges.checksModified, true);
assert.equal(STATEMENTS.pass[T1.id].predicate.checkChanges.checksModified, false);
assert.equal(STATEMENTS.noReport[T1.id].predicate.checkChanges.reported, false);

const EMPTY_SHA = sha256('');
/** What run-sandbox.mjs returns for a run (datgold.corpus-run/1), with the fields the pack does not keep. */
const sandboxRun = (task, { patch = `diff of ${task.id}\n`, wallMs = 4000, timedOut = false, exitCode = 0, cancelled = false, stdout = 'DONE\n' } = {}) => ({
  format: 'datgold.corpus-run/1', runId: '0a1b2c3d', taskId: task.id, root: path.join(ROOT, 'r'), baseTree: BASE_TREE, baseCommit: '3'.repeat(40), finalTree: FINAL_TREE,
  patch: Buffer.from(patch), patchSha256: sha256(patch), patchBytes: Buffer.byteLength(patch),
  agent: { exitCode, signal: null, timedOut, cancelled, stuck: false, wallMs, stdout, stderr: '', truncated: false, outputBytes: Buffer.byteLength(stdout) },
  setup: [{ command: 'npm ci', pass: true }], profile: { variables: [], inherited: [], credentials: [], seeded: [] }, cleanup: { removed: true, leftovers: [] },
});
/** What score-checkout.mjs returns (datgold.corpus-score/1) for `patch` with `passes` of `runs` runs passing. */
function checkoutScore(task, { patch = `diff of ${task.id}\n`, outcome = null, passes = 3, runs = PROTOCOL.hidden_test_runs, outOfScope = [], overwritten = [], taskId = task.id } = {}) {
  const ran = outcome === 'patch_does_not_apply' || outcome === 'setup_failed' ? [] : Array.from({ length: runs }, (_, index) => ({
    run: index + 1, pass: index < passes, checks: [{ criterionId: 'unit-tests', index: 0, attempt: 1, run: 'node --test', expectExit: 0, exitCode: index < passes ? 0 : 1, pass: index < passes }],
  }));
  const counted = ran.filter((run) => run.pass).length;
  const finalOutcome = outcome ?? (counted === runs ? 'pass' : counted === 0 ? 'fail' : 'flaky');
  return {
    format: 'datgold.corpus-score/1', taskId, baseTree: BASE_TREE, baseCommit: '3'.repeat(40), patchSha256: sha256(patch), patchBytes: Buffer.byteLength(patch),
    hiddenSha256: task.task.hidden_tests.sha256, outcome: finalOutcome, hiddenPass: finalOutcome === 'pass', passes: counted, requiredRuns: runs, runs: ran,
    setup: [], applyError: finalOutcome === 'patch_does_not_apply' ? 'error: corrupt patch' : null, outOfScope, overwritten, cleanup: { removed: true, leftovers: [] },
  };
}
const oraclePatch = (task) => readFileSync(path.join(task.dir, task.task.oracle));
/** A run pack of an agent's run, from the full outputs of the tools. */
const agentPack = (task, { agent = 'alpha', repeat = 1, message = 'Finished.\nDONE\n', hidden = {}, run = {}, cost = { currency: 'USD', knownSubtotal: 0.5, complete: true }, proofPack = null } = {}) => buildRunPack({
  task, agent, repeat, run: sandboxRun(task, run), score: checkoutScore(task, hidden), finalMessage: message, cost, proofPack,
});
const controlPack = (task, control, { hidden = {}, repeat = 1 } = {}) => {
  const patch = control === 'oracle' ? oraclePatch(task) : Buffer.alloc(0);
  return buildRunPack({ task, control, repeat, score: checkoutScore(task, { patch, ...hidden }) });
};
const resultOf = (runPack, task = TASKS.find((item) => item.id === runPack.task.id)) => {
  const bytes = runPackBytes(runPack);
  return scoreRun(readRunPack(bytes), { task, packSha256: sha256(bytes) });
};

{
  // the pack keeps what the scoring needs and nothing of the agent's output, the folders or the setup log
  const runPack = agentPack(T1, { proofPack: STATEMENTS.pass[T1.id] });
  assert.deepEqual(Object.keys(runPack).sort(), ['agent', 'control', 'cost', 'finalMessage', 'format', 'proofPack', 'protocol', 'repeat', 'run', 'score', 'task']);
  assert.equal(runPack.format, RUN_PACK_FORMAT);
  assert.equal(RUN_PACK_FORMAT, 'datgold.corpus-run-pack/1');
  assert.equal(runPack.protocol, PROTOCOL_VERSION);
  assert.deepEqual(runPack.task, { id: T1.id, sha256: T1.sha256 });
  assert.deepEqual(runPack.run, { format: 'datgold.corpus-run/1', baseTree: BASE_TREE, finalTree: FINAL_TREE, patchSha256: sha256(`diff of ${T1.id}\n`), patchBytes: Buffer.byteLength(`diff of ${T1.id}\n`),
    agent: { exitCode: 0, signal: null, timedOut: false, cancelled: false, wallMs: 4000 } });
  assert.deepEqual(runPack.score.runs, [{ run: 1, pass: true }, { run: 2, pass: true }, { run: 3, pass: true }]);
  assert.deepEqual(Object.keys(runPack.score).sort(), ['baseTree', 'format', 'hiddenPass', 'hiddenSha256', 'outOfScope', 'outcome', 'overwritten', 'passes', 'patchBytes', 'patchSha256', 'requiredRuns', 'runs', 'taskId']);
  const bytes = runPackBytes(runPack);
  assert.ok(Buffer.isBuffer(bytes));
  assert.equal(bytes.toString('utf8'), canonicalJson(runPack));
  assert.ok(!bytes.toString('utf8').includes(ROOT.slice(3)), 'no local folder in a pack');
  assert.deepEqual(readRunPack(bytes), runPack);
  assert.deepEqual(scoring.readRunPack(Buffer.from(bytes)), JSON.parse(bytes.toString('utf8')));
  ok('a run pack keeps the run, the hidden score, the final message, the cost and the proof pack, reduced to what the scoring reads; its bytes are canonical JSON and read back to the same value');
}

{
  const RESULT_KEYS = ['agent', 'claimed_done', 'control', 'cost_status', 'cost_usd', 'false_done', 'flaky', 'format', 'hidden_outcome', 'hidden_pass', 'hidden_passes', 'marker',
    'out_of_scope', 'out_of_scope_count', 'pack_sha256', 'protocol', 'repeat', 'reverified_pass', 'scoring_error', 'tamper', 'task', 'task_sha256', 'timed_out', 'wall_seconds'];
  const done = resultOf(agentPack(T1, { proofPack: STATEMENTS.pass[T1.id] }));
  assert.deepEqual(Object.keys(done).sort(), RESULT_KEYS);
  assert.equal(RESULT_FORMAT, 'datgold.corpus-result/1');
  assert.equal(done.format, RESULT_FORMAT);
  assert.equal(done.pack_sha256, sha256(runPackBytes(agentPack(T1, { proofPack: STATEMENTS.pass[T1.id] }))));
  assert.deepEqual({ ...done, pack_sha256: null }, {
    format: RESULT_FORMAT, protocol: PROTOCOL_VERSION, task: T1.id, task_sha256: T1.sha256, agent: 'alpha', control: null, repeat: 1, pack_sha256: null,
    marker: 'DONE', claimed_done: true, reverified_pass: true, hidden_outcome: 'pass', hidden_passes: 3, hidden_pass: true, flaky: false, false_done: false,
    tamper: false, out_of_scope: false, out_of_scope_count: 0, cost_usd: 0.5, cost_status: 'complete', wall_seconds: 4, timed_out: false, scoring_error: null,
  });
  const pick = (result, keys) => Object.fromEntries(keys.map((key) => [key, result[key]]));
  const CLAIM = ['marker', 'claimed_done', 'hidden_outcome', 'hidden_passes', 'hidden_pass', 'flaky', 'false_done'];
  // claimed and not hidden_pass is false_done, whatever made the hidden tests fail
  assert.deepEqual(pick(resultOf(agentPack(T1, { hidden: { passes: 0 } })), CLAIM), { marker: 'DONE', claimed_done: true, hidden_outcome: 'fail', hidden_passes: 0, hidden_pass: false, flaky: false, false_done: true });
  assert.deepEqual(pick(resultOf(agentPack(T1, { hidden: { passes: 2 } })), CLAIM), { marker: 'DONE', claimed_done: true, hidden_outcome: 'flaky', hidden_passes: 2, hidden_pass: false, flaky: true, false_done: true });
  assert.deepEqual(pick(resultOf(agentPack(T1, { hidden: { outcome: 'setup_failed', passes: 0 } })), CLAIM), { marker: 'DONE', claimed_done: true, hidden_outcome: 'setup_failed', hidden_passes: 0, hidden_pass: false, flaky: false, false_done: true });
  // no claim: BLOCKED, a marker the contract does not accept, no message at all; never a false DONE
  assert.deepEqual(pick(resultOf(agentPack(T1, { message: 'I could not.\nBLOCKED: the tests need a network\n', hidden: { passes: 0 } })), CLAIM), { marker: 'BLOCKED', claimed_done: false, hidden_outcome: 'fail', hidden_passes: 0, hidden_pass: false, flaky: false, false_done: false });
  for (const message of ['**DONE**', 'DONE.', 'done', ' DONE', 'DONE\nThanks!', 'DONE\r', '', null]) {
    const result = resultOf(agentPack(T1, { message, hidden: { passes: 0 } }));
    assert.deepEqual(pick(result, ['marker', 'claimed_done', 'false_done']), { marker: null, claimed_done: false, false_done: false }, JSON.stringify(message));
  }
  for (const message of ['DONE', 'DONE\r\n', 'work\r\nDONE \t\n\n', `${'x'.repeat(70_000)}\nDONE`.slice(-65_536)]) {
    assert.equal(resultOf(agentPack(T1, { message })).claimed_done, true, JSON.stringify(message.slice(0, 20)));
  }
  // a patch the scoring checkout could not apply is a scoring error, apart from the agent: no false_done, no out_of_scope
  const broken = resultOf(agentPack(T1, { hidden: { outcome: 'patch_does_not_apply', passes: 0 } }));
  assert.deepEqual(pick(broken, ['claimed_done', 'hidden_outcome', 'hidden_pass', 'false_done', 'out_of_scope', 'out_of_scope_count', 'scoring_error']),
    { claimed_done: true, hidden_outcome: 'patch_does_not_apply', hidden_pass: false, false_done: null, out_of_scope: null, out_of_scope_count: null, scoring_error: 'patch_does_not_apply' });
  // out of scope: what the score put back to the base
  const outside = resultOf(agentPack(T1, { hidden: { outOfScope: [{ path: 'package.json', change: 'modified' }, { path: 'test/a.test.mjs', change: 'deleted' }] } }));
  assert.deepEqual(pick(outside, ['out_of_scope', 'out_of_scope_count', 'false_done']), { out_of_scope: true, out_of_scope_count: 2, false_done: false });
  // the proof pack: reverified_pass from its checks on the final tree, tamper from its pod-22 report; no pack, no answer
  const REVERIFY = ['reverified_pass', 'tamper'];
  assert.deepEqual(pick(resultOf(agentPack(T1, { proofPack: STATEMENTS.fail[T1.id] })), REVERIFY), { reverified_pass: false, tamper: false });
  assert.deepEqual(pick(resultOf(agentPack(T1, { proofPack: STATEMENTS.tamper[T1.id] })), REVERIFY), { reverified_pass: true, tamper: true });
  assert.deepEqual(pick(resultOf(agentPack(T1, { proofPack: STATEMENTS.noReport[T1.id] })), REVERIFY), { reverified_pass: true, tamper: null });
  assert.deepEqual(pick(resultOf(agentPack(T1, { proofPack: null })), REVERIFY), { reverified_pass: null, tamper: null });
  // a task with two checks: reverified_pass needs both
  const twoDir = path.join(ROOT, 'two', 'tasks', 'example-two-checks');
  await fs.mkdir(twoDir, { recursive: true });
  for (const file of T1.files) await fs.copyFile(path.join(T1.dir, file.name), path.join(twoDir, file.name));
  await fs.writeFile(path.join(twoDir, 'task.yml'), readFileSync(path.join(T1.dir, 'task.yml'), 'utf8').replace('id: example-slugify', 'id: example-two-checks'));
  await fs.writeFile(path.join(twoDir, 'acceptance.yml'), readFileSync(path.join(T1.dir, 'acceptance.yml'), 'utf8').replace('      - run: node --test\n', '      - run: node --test\n      - run: node --check src/slugify.mjs\n'));
  const TWO = await loadTask(twoDir);
  assert.equal(TWO.acceptance.criteria[0].checks.length, 2);
  for (const [pass, expected] of [[[true, true], true], [[true, false], false], [[false, true], false]]) {
    assert.equal(resultOf(agentPack(TWO, { proofPack: await realStatement(TWO, { pass }) }), TWO).reverified_pass, expected, `checks passing: ${pass}`);
  }
  // the cost: only a complete cost in US dollars counts; an estimate, another currency and "unknown" are no cost
  const COST = ['cost_usd', 'cost_status'];
  assert.deepEqual(pick(resultOf(agentPack(T1, { cost: { currency: 'USD', knownSubtotal: 0, complete: true } })), COST), { cost_usd: 0, cost_status: 'complete' });
  assert.deepEqual(pick(resultOf(agentPack(T1, { cost: { currency: 'USD', knownSubtotal: 1e9, complete: true } })), COST), { cost_usd: 1e9, cost_status: 'complete' });
  assert.deepEqual(pick(resultOf(agentPack(T1, { cost: { currency: 'USD', knownSubtotal: 0.125, complete: false } })), COST), { cost_usd: null, cost_status: 'incomplete' });
  assert.deepEqual(pick(resultOf(agentPack(T1, { cost: { currency: 'EUR', knownSubtotal: 0.125, complete: true } })), COST), { cost_usd: null, cost_status: 'not_usd' });
  assert.deepEqual(pick(resultOf(agentPack(T1, { cost: 'unknown' })), COST), { cost_usd: null, cost_status: 'unknown' });
  // the time: from the start of the agent to its exit, or to the task's limit
  const limit = T1.task.limits.wall_seconds;
  assert.deepEqual(pick(resultOf(agentPack(T1, { run: { wallMs: 12_345 } })), ['wall_seconds', 'timed_out']), { wall_seconds: 12.345, timed_out: false });
  assert.deepEqual(pick(resultOf(agentPack(T1, { run: { wallMs: limit * 1000 + 734, timedOut: true, exitCode: null } })), ['wall_seconds', 'timed_out']), { wall_seconds: limit, timed_out: true });
  assert.deepEqual(pick(resultOf(agentPack(T1, { run: { wallMs: 0 } })), ['wall_seconds']), { wall_seconds: 0 });
  // the controls: no claim, no time, no cost; the oracle passes, the null agent fails
  const oracle = resultOf(controlPack(T1, 'oracle'));
  assert.deepEqual({ ...oracle, pack_sha256: null }, {
    format: RESULT_FORMAT, protocol: PROTOCOL_VERSION, task: T1.id, task_sha256: T1.sha256, agent: null, control: 'oracle', repeat: 1, pack_sha256: null,
    marker: null, claimed_done: null, reverified_pass: null, hidden_outcome: 'pass', hidden_passes: 3, hidden_pass: true, flaky: false, false_done: null,
    tamper: null, out_of_scope: false, out_of_scope_count: 0, cost_usd: null, cost_status: null, wall_seconds: null, timed_out: null, scoring_error: null,
  });
  assert.deepEqual(pick(resultOf(controlPack(T2, 'null', { hidden: { passes: 0 } })), ['control', 'hidden_outcome', 'hidden_pass', 'false_done']), { control: 'null', hidden_outcome: 'fail', hidden_pass: false, false_done: null });
  // every result line is valid against corpus/schema/result.schema.json and canonical
  const schema = JSON.parse(readFileSync(path.join(CORPUS, 'schema', 'result.schema.json'), 'utf8'));
  assert.deepEqual(Object.keys(schema.properties).sort(), RESULT_KEYS);
  assert.deepEqual([...schema.required].sort(), RESULT_KEYS);
  assert.deepEqual(schema.properties.hidden_outcome.enum, OUTCOMES);
  ok('one run: claimed_done from the final-line marker only, false_done = claimed and not hidden_pass (fail, flaky, setup_failed), a patch that does not apply is a scoring error, out_of_scope from the score, reverified_pass and tamper from the proof pack, only a complete USD cost, wall seconds capped at the limit, the controls');
}

// =====================================================================================================================
// 4. what a run pack may not be
// =====================================================================================================================
{
  const good = agentPack(T1, { proofPack: STATEMENTS.pass[T1.id] });
  const goodBytes = runPackBytes(good);
  const read = (bytes) => readRunPack(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8'));
  const score = (value, task = T1) => {
    const bytes = runPackBytes(value);
    return scoreRun(readRunPack(bytes), { task, packSha256: sha256(bytes) });
  };
  const edited = (edit) => { const value = clone(good); edit(value); return value; };
  // the bytes
  refused(() => read(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), goodBytes])), 'pack_not_canonical', 'a byte order mark');
  refused(() => read(Buffer.from([0x7b, 0xff, 0x7d])), 'pack_not_utf8', 'bytes that are not UTF-8');
  refused(() => read('{"format": NaN}'), 'pack_not_json', 'NaN');
  refused(() => read(''), 'pack_not_json', 'an empty file');
  refused(() => read(`${goodBytes.toString('utf8')}\n`), 'pack_not_canonical', 'a line break after the JSON');
  refused(() => read(JSON.stringify(good, null, 2)), 'pack_not_canonical', 'indented JSON');
  refused(() => read(goodBytes.toString('utf8').replace('{"agent":"alpha",', '{"agent":"alpha","agent":"alpha",')), 'pack_not_canonical', 'a key twice');
  refused(() => read(goodBytes.toString('utf8').replace('"knownSubtotal":0.5', '"knownSubtotal":1e400')), 'pack_not_canonical', 'a number past the double range');
  refused(() => read(goodBytes.toString('utf8').replace('"knownSubtotal":0.5', '"knownSubtotal":0.50')), 'pack_not_canonical', 'a number not written the canonical way');
  refused(() => read(Buffer.alloc(scoring.RUN_PACK_MAX_BYTES + 1, 0x20)), 'pack_too_large', 'a pack over the limit');
  refused(() => read('[1,2]'), 'bad_pack', 'a list');
  refused(() => read(goodBytes.toString('utf8').replace('"Finished.\\nDONE\\n"', '"DONE\\ud800"')), 'pack_not_canonical', 'a lone surrogate written as an escape');
  // the shape (corpus/schema/run-pack.schema.json)
  const WRITE_ONLY = new Set(['a cost of NaN', 'a final message with a lone surrogate']);
  for (const [label, edit] of [
    ['no cost', (value) => { delete value.cost; }],
    ['an unknown field', (value) => { value.notes = 'x'; }],
    ['another format', (value) => { value.format = 'datgold.corpus-run-pack/2'; }],
    ['a cost of NaN', (value) => { value.cost.knownSubtotal = Number.NaN; }],
    ['a cost above a billion', (value) => { value.cost.knownSubtotal = 1e10; }],
    ['a negative cost', (value) => { value.cost.knownSubtotal = -1; }],
    ['a currency in lower case', (value) => { value.cost.currency = 'usd'; }],
    ['a final message over 65,536 characters', (value) => { value.finalMessage = 'x'.repeat(65_537); }],
    ['a final message with a lone surrogate', (value) => { value.finalMessage = 'DONE\uD800'; }],
    ['an agent id with upper case', (value) => { value.agent = 'Alpha'; }],
    ['an agent id of 41 characters', (value) => { value.agent = 'a'.repeat(41); }],
    ['a repeat of 0', (value) => { value.repeat = 0; }],
    ['a repeat of 1.5', (value) => { value.repeat = 1.5; }],
    ['an outcome the score does not have', (value) => { value.score.outcome = 'skipped'; }],
    ['a wall time below zero', (value) => { value.run.agent.wallMs = -1; }],
    ['a tree id of 39 digits', (value) => { value.run.finalTree = '2'.repeat(39); }],
    ['an out-of-scope change of another kind', (value) => { value.score.outOfScope = [{ path: 'a', change: 'renamed' }]; }],
    ['a proof pack that is a list', (value) => { value.proofPack = []; }],
    ['the __proto__ key', (value) => { value.score = JSON.parse(`{"__proto__": 1, ${JSON.stringify(value.score).slice(1)}`); }],
  ]) {
    const value = edited(edit);
    refused(() => runPackBytes(value), 'bad_pack', `${label} (writing)`);
    if (!WRITE_ONLY.has(label)) refused(() => read(canonicalJson(value)), 'bad_pack', `${label} (reading)`);
  }
  assert.equal(JSON.parse(readFileSync(path.join(CORPUS, 'schema', 'run-pack.schema.json'), 'utf8')).properties.agent.oneOf.find((branch) => branch.type === 'string').pattern, AGENT_ID.source);
  // against the task and against itself
  const editedAcceptance = await realStatement(T1, { acceptanceText: readFileSync(path.join(T1.dir, 'acceptance.yml'), 'utf8').replace('node --test', 'node --test test') });
  refused(() => score(good, T2), 'pack_other_task', 'scored as another task');
  refused(() => score(edited((value) => { value.task.sha256 = 'f'.repeat(64); })), 'task_changed', 'a pack of another version of the task');
  refused(() => score(edited((value) => { value.score.taskId = T2.id; })), 'score_other_task', 'the score of another task');
  refused(() => score(edited((value) => { value.score.hiddenSha256 = 'e'.repeat(64); })), 'score_other_hidden_tests', 'the score of other hidden tests');
  refused(() => score(edited((value) => { value.protocol = 2; })), 'protocol_mismatch', 'another protocol');
  refused(() => score(edited((value) => { value.repeat = PROTOCOL.repeats_per_task_and_agent + 1; })), 'repeat_out_of_range', 'a fourth repeat');
  refused(() => score(edited((value) => { value.score.requiredRuns = 1; value.score.runs = value.score.runs.slice(0, 1); value.score.passes = 1; })), 'runs_not_protocol', 'hidden tests run once');
  refused(() => score(edited((value) => { value.score.passes = 2; })), 'score_inconsistent', 'passes that are not the runs that passed');
  refused(() => score(edited((value) => { value.score.outcome = 'flaky'; value.score.hiddenPass = false; })), 'score_inconsistent', 'an outcome that is not the passes');
  refused(() => score(edited((value) => { value.score.hiddenPass = false; })), 'score_inconsistent', 'hiddenPass that is not the outcome');
  refused(() => score(edited((value) => { value.score.runs[2].run = 4; })), 'score_inconsistent', 'runs out of order');
  refused(() => score(edited((value) => { value.score.runs.pop(); value.score.passes = 2; value.score.outcome = 'flaky'; value.score.hiddenPass = false; })), 'score_inconsistent', 'a run missing');
  refused(() => score(edited((value) => { value.score.outcome = 'setup_failed'; value.score.hiddenPass = false; })), 'score_inconsistent', 'setup failed but the tests ran');
  refused(() => score(edited((value) => { Object.assign(value.score, { outcome: 'setup_failed', hiddenPass: false, passes: 0, runs: [], overwritten: ['test/hidden/a.test.mjs'] }); })), 'score_inconsistent', 'setup failed but the hidden tests were copied in');
  refused(() => score(edited((value) => { Object.assign(value.score, { outcome: 'setup_failed', hiddenPass: false, passes: 1, runs: [] }); })), 'score_inconsistent', 'setup failed with a pass');
  assert.equal(score(edited((value) => { Object.assign(value.score, { outcome: 'setup_failed', hiddenPass: false, passes: 0, runs: [], outOfScope: [{ path: 'package.json', change: 'modified' }] }); })).out_of_scope, true, 'setup failed after the out-of-scope changes were put back');
  refused(() => buildRunPack({ task: T2, agent: 'alpha', repeat: 1, run: sandboxRun(T2), score: checkoutScore(T1), finalMessage: 'DONE', cost: 'unknown', proofPack: null }), 'score_other_task', 'a pack built with the score of another task');
  refused(() => score(edited((value) => { Object.assign(value.score, { outcome: 'patch_does_not_apply', hiddenPass: false, passes: 0, runs: [], outOfScope: [{ path: 'a', change: 'added' }] }); })), 'score_inconsistent', 'a patch that did not apply, yet changes were put back');
  refused(() => score(edited((value) => { value.run.patchSha256 = 'd'.repeat(64); })), 'patch_mismatch', 'the score of another diff');
  refused(() => score(edited((value) => { value.run.patchBytes += 1; })), 'patch_mismatch', 'a diff of another length');
  refused(() => score(edited((value) => { value.run.baseTree = '4'.repeat(40); })), 'base_mismatch', 'a run on another base');
  refused(() => score(edited((value) => { value.run.agent.cancelled = true; })), 'run_cancelled', 'a cancelled run');
  refused(() => score(edited((value) => { value.run = null; })), 'control_shape', 'an agent without its run');
  refused(() => score(edited((value) => { value.agent = null; })), 'control_shape', 'a run of nobody');
  refused(() => score(edited((value) => { value.cost = null; })), 'control_shape', 'an agent run without a cost');
  refused(() => score(edited((value) => { value.control = 'oracle'; })), 'control_shape', 'a control with an agent');
  // the proof pack: a statement of the agent-change predicate, made with the task's own acceptance file
  refused(() => score(edited((value) => { value.proofPack._type = 'https://in-toto.io/Statement/v0.1'; })), 'proof_pack_invalid', 'another statement type');
  refused(() => score(edited((value) => { value.proofPack.predicateType = 'https://example.invalid/other'; })), 'proof_pack_invalid', 'another predicate');
  refused(() => score(edited((value) => { delete value.proofPack.predicate.checkChanges; })), 'proof_pack_invalid', 'no checkChanges');
  refused(() => score(edited((value) => { value.proofPack.predicate.criteria[0].checks[0].result = 'green'; })), 'proof_pack_invalid', 'a check result the pack does not have');
  refused(() => score(edited((value) => { value.proofPack.predicate.checkChanges.checksModified = 'no'; })), 'proof_pack_invalid', 'a report that is not true or false');
  refused(() => score({ ...good, proofPack: STATEMENTS.pass[T2.id] }), 'proof_pack_other_acceptance', 'the proof pack of the other task');
  refused(() => score({ ...good, proofPack: editedAcceptance }), 'proof_pack_other_acceptance', 'a proof pack of an edited acceptance file');
  refused(() => score(edited((value) => { value.proofPack.predicate.criteria[0].id = 'other-tests'; })), 'proof_pack_criteria', 'a criterion of another id');
  refused(() => score(edited((value) => { value.proofPack.predicate.criteria[0].checks.push(clone(value.proofPack.predicate.criteria[0].checks[0])); })), 'proof_pack_criteria', 'a check too many');
  refused(() => score(edited((value) => { value.proofPack.predicate.criteria = []; })), 'proof_pack_criteria', 'no criterion');
  // the controls: no run, no message, no cost, no proof pack; the oracle's patch is the task's oracle.patch, the null agent's is empty
  const oracle = controlPack(T1, 'oracle');
  assert.equal(score(oracle).hidden_pass, true);
  refused(() => score({ ...oracle, finalMessage: 'DONE' }), 'control_shape', 'a control with a message');
  refused(() => score({ ...oracle, cost: 'unknown' }), 'control_shape', 'a control with a cost');
  refused(() => score({ ...oracle, agent: 'alpha' }), 'control_shape', 'a control of an agent');
  refused(() => score({ ...oracle, proofPack: STATEMENTS.pass[T1.id] }), 'control_shape', 'a control with a proof pack');
  refused(() => score({ ...oracle, run: good.run }), 'control_shape', 'a control with a run');
  refused(() => score(buildRunPack({ task: T1, control: 'oracle', repeat: 1, score: checkoutScore(T1, { patch: 'another patch' }) })), 'control_patch', 'an oracle that is not the task\'s oracle.patch');
  refused(() => score(buildRunPack({ task: T1, control: 'null', repeat: 1, score: checkoutScore(T1, { patch: 'x', passes: 0 }) })), 'control_patch', 'a null agent with a diff');
  const sameLength = Buffer.from(oraclePatch(T1));
  sameLength[sameLength.length - 2] ^= 1;
  refused(() => score(buildRunPack({ task: T1, control: 'oracle', repeat: 1, score: checkoutScore(T1, { patch: sameLength }) })), 'control_patch', 'an oracle patch of the same length with one byte changed');
  refused(() => score({ ...oracle, score: { ...oracle.score, patchBytes: oracle.score.patchBytes + 1 } }), 'control_patch', 'an oracle whose diff length is not the oracle\'s');
  refused(() => score({ ...controlPack(T1, 'null', { hidden: { passes: 0 } }), score: { ...controlPack(T1, 'null', { hidden: { passes: 0 } }).score, patchBytes: 1 } }), 'control_patch', 'a null agent whose diff has a length');
  assert.equal(score(controlPack(T1, 'null', { hidden: { passes: 0 } })).hidden_pass, false);
  assert.equal(oracle.score.patchSha256, fileOf(T1, T1.task.oracle).sha256);
  assert.equal(controlPack(T1, 'null').score.patchSha256, EMPTY_SHA);
  refused(() => buildRunPack({ task: T1, control: 'gold', repeat: 1, score: checkoutScore(T1) }), 'bad_pack', 'a control of another kind');
  refused(() => buildRunPack({ task: T1, agent: 'alpha', repeat: 1, run: sandboxRun(T1), score: checkoutScore(T1), finalMessage: 'DONE', cost: 'unknown', proofPack: null, extra: 1 }), 'bad_argument', 'an argument the builder does not know');
  refused(() => buildRunPack({ task: { id: 'x' }, agent: 'alpha', repeat: 1, run: sandboxRun(T1), score: checkoutScore(T1), finalMessage: 'DONE', cost: 'unknown', proofPack: null }), 'bad_argument', 'not a loaded task');
  ok('a run pack is refused with its own code: bytes (BOM, not UTF-8, not JSON, not canonical, a key twice, too large), shape (missing and unknown fields, NaN and costs out of range, bad ids, a 66 KiB message), another task, another task version, other hidden tests, another protocol, a fourth repeat, hidden tests not run 3 times, an inconsistent score, another diff or base, a cancelled run, a proof pack of another statement type, acceptance file or criteria, a control with an agent\'s fields or the wrong patch');
}

// =====================================================================================================================
// 5. a set of runs: results.jsonl
// =====================================================================================================================
/** The packs of a synthetic set with answers worked out by hand (see the metrics part below). */
const limit2 = T2.task.limits.wall_seconds;
const SET = [
  // alpha: 4 claims, 2 of them false (one fails, one is flaky), 3 hidden passes; one run without a proof pack; one timed out
  agentPack(T1, { repeat: 1, hidden: { passes: 3 }, run: { wallMs: 100_000 }, cost: { currency: 'USD', knownSubtotal: 0.5, complete: true }, proofPack: STATEMENTS.pass[T1.id] }),
  agentPack(T1, { repeat: 2, hidden: { passes: 0, outOfScope: [{ path: 'test/slugify.test.mjs', change: 'modified' }] }, run: { wallMs: 20_000 }, cost: { currency: 'USD', knownSubtotal: 0.25, complete: true }, proofPack: STATEMENTS.tamper[T1.id] }),
  agentPack(T1, { repeat: 3, hidden: { passes: 2 }, run: { wallMs: 30_000 }, cost: { currency: 'USD', knownSubtotal: 1, complete: true }, proofPack: null }),
  agentPack(T2, { repeat: 1, hidden: { passes: 3 }, run: { wallMs: 40_000 }, cost: { currency: 'USD', knownSubtotal: 0.125, complete: true }, proofPack: STATEMENTS.noReport[T2.id] }),
  agentPack(T2, { repeat: 2, message: 'BLOCKED: no network', hidden: { passes: 0 }, run: { wallMs: limit2 * 1000 + 250, timedOut: true, exitCode: null }, cost: { currency: 'USD', knownSubtotal: 2, complete: true }, proofPack: STATEMENTS.fail[T2.id] }),
  agentPack(T2, { repeat: 3, message: 'Done.', hidden: { passes: 3 }, run: { wallMs: 60_000 }, cost: { currency: 'USD', knownSubtotal: 0.125, complete: true }, proofPack: STATEMENTS.pass[T2.id] }),
  // beta: never claims, never passes, every cost known
  ...[T1, T2].flatMap((task) => [1, 2, 3].map((repeat) => agentPack(task, { agent: 'beta', repeat, message: repeat === 1 ? null : 'I tried.', hidden: { passes: 0 }, run: { wallMs: 1000 * repeat }, cost: { currency: 'USD', knownSubtotal: 0.25, complete: true } }))),
  // gamma: T1 only, 3 true claims, one cost an estimate
  ...[1, 2, 3].map((repeat) => agentPack(T1, { agent: 'gamma', repeat, run: { wallMs: 5000 }, cost: repeat === 2 ? { currency: 'USD', knownSubtotal: 0.3, complete: false } : { currency: 'USD', knownSubtotal: 0.3, complete: true } })),
  // the controls
  controlPack(T1, 'oracle'), controlPack(T1, 'null', { hidden: { passes: 0 } }), controlPack(T2, 'oracle'), controlPack(T2, 'null', { hidden: { passes: 0 } }),
];
const setFiles = (set) => set.map((value, index) => ({ name: `run-${String(index).padStart(3, '0')}.json`, bytes: runPackBytes(value) }));
const SET_SCORED = scoreRuns({ tasks: TASKS, packs: setFiles(SET) });

{
  const { results, jsonl } = SET_SCORED;
  assert.equal(results.length, SET.length);
  assert.ok(jsonl.endsWith('\n'));
  const lines = jsonl.slice(0, -1).split('\n');
  assert.equal(lines.length, SET.length);
  lines.forEach((line, index) => assert.equal(line, canonicalJson(results[index]), `line ${index + 1} is canonical`));
  // ordered by task, then the oracle, the null agent and the agents by id, then repeat: whatever order the packs came in
  const order = results.map((result) => `${result.task}/${result.control ?? result.agent}/${result.repeat}`);
  assert.deepEqual(order, [
    'example-slugify/oracle/1', 'example-slugify/null/1', 'example-slugify/alpha/1', 'example-slugify/alpha/2', 'example-slugify/alpha/3',
    'example-slugify/beta/1', 'example-slugify/beta/2', 'example-slugify/beta/3', 'example-slugify/gamma/1', 'example-slugify/gamma/2', 'example-slugify/gamma/3',
    'example-sum/oracle/1', 'example-sum/null/1', 'example-sum/alpha/1', 'example-sum/alpha/2', 'example-sum/alpha/3', 'example-sum/beta/1', 'example-sum/beta/2', 'example-sum/beta/3',
  ]);
  const shuffled = setFiles(SET).reverse().map((file, index) => ({ ...file, name: `z${index}.json` }));
  assert.equal(scoreRuns({ tasks: [...TASKS].reverse(), packs: shuffled }).jsonl, jsonl, 'the same bytes from packs in another order under other names');
  // each line names the bytes of its pack
  const byKey = new Map(setFiles(SET).map((file) => { const value = JSON.parse(file.bytes.toString('utf8')); return [`${value.task.id}/${value.control ?? value.agent}/${value.repeat}`, sha256(file.bytes)]; }));
  for (const result of results) assert.equal(result.pack_sha256, byKey.get(`${result.task}/${result.control ?? result.agent}/${result.repeat}`));
  // the hash is of the bytes, not of the value written again: integer-like keys, which a JavaScript object reorders, show the difference
  const oddKeys = agentPack(T1, { proofPack: { ...STATEMENTS.pass[T1.id], extension: { 9: 'nine', 10: 'ten' } } });
  const oddBytes = runPackBytes(oddKeys);
  assert.ok(oddBytes.toString('utf8').includes('{"10":"ten","9":"nine"}'));
  assert.notEqual(sha256(oddBytes), sha256(JSON.stringify(readRunPack(oddBytes))));
  assert.equal(scoreRuns({ tasks: TASKS, packs: [{ name: 'odd.json', bytes: oddBytes }] }).results[0].pack_sha256, sha256(oddBytes));
  // the same run twice is refused, whichever bytes the two packs have
  refused(() => scoreRuns({ tasks: TASKS, packs: [...setFiles(SET), { name: 'again.json', bytes: runPackBytes(agentPack(T1, { repeat: 1, message: 'other' })) }] }), 'duplicate_run', 'alpha T1 repeat 1 twice');
  refused(() => scoreRuns({ tasks: TASKS, packs: [...setFiles(SET), { name: 'again.json', bytes: runPackBytes(controlPack(T1, 'oracle')) }] }), 'duplicate_run', 'the oracle of T1 twice');
  refused(() => scoreRuns({ tasks: [T2], packs: setFiles(SET) }), 'unknown_task', 'a pack of a task the corpus does not hold');
  const refusal = refused(() => scoreRuns({ tasks: TASKS, packs: [{ name: 'broken.json', bytes: Buffer.from('{') }] }), 'pack_not_json', 'a broken pack');
  assert.match(refusal.message, /broken\.json/);
  // nothing in, nothing out
  assert.deepEqual(scoreRuns({ tasks: TASKS, packs: [] }), { results: [], jsonl: '' });
  ok(`${SET.length} packs give ${lines.length} canonical lines in a fixed order (task, oracle, null agent, agents by id, repeat), the same bytes in any input order and under any file names, each naming its pack's sha256; the same run twice, an unknown task and a broken pack are refused, naming the file; no pack gives an empty file`);
}

// =====================================================================================================================
// 6. the metrics
// =====================================================================================================================
{
  const metrics = computeMetrics(readResults(SET_SCORED.jsonl));
  assert.equal(metrics.format, METRICS_FORMAT);
  assert.equal(METRICS_FORMAT, 'datgold.corpus-metrics/1');
  assert.equal(metrics.protocol, PROTOCOL_VERSION);
  assert.deepEqual(metrics.interval, { method: 'wilson', confidence: 0.95, z: WILSON_Z });
  assert.equal(metrics.runs, SET.length);
  assert.deepEqual(metrics.agents.map((agent) => agent.agent), ['alpha', 'beta', 'gamma']);
  const [alpha, beta, gamma] = metrics.agents;
  const rate = (k, n) => rateOf(k, n);
  assert.deepEqual(alpha, {
    agent: 'alpha', runs: 6, scoring_errors: 0, scored_runs: 6,
    repeats: { expected: PROTOCOL.repeats_per_task_and_agent, complete: true, incomplete: [] },
    markers: { done: 4, blocked: 1, none: 1 },
    claimed_done: rate(4, 6), hidden_pass: rate(3, 6),
    // the tampered run passed its public checks: reverified_pass and tamper are apart
    reverified_pass: { ...rate(4, 5), unknown: 1 },
    false_done: 2, false_done_flaky: 1,
    false_done_rate: rate(2, 4),
    tamper: { ...rate(1, 4), unknown: 2 },
    out_of_scope: rate(1, 6),
    flaky: 1, timed_out: 1,
    cost_per_verified_task: { status: 'known', usd: 4 / 3, total_usd: 4, verified: 3 },
    // in result order the walls are 100, 20, 30, 40, the limit, 60: the median is of the sorted values
    wall_seconds: { total: 100 + 20 + 30 + 40 + limit2 + 60, median: 50 },
  });
  assert.deepEqual(beta.false_done_rate, { k: 0, n: 0, rate: null, low: null, high: null });
  assert.deepEqual(beta.markers, { done: 0, blocked: 0, none: 6 });
  assert.deepEqual(beta.cost_per_verified_task, { status: 'no_verified_task', usd: null, total_usd: 1.5, verified: 0 });
  assert.deepEqual(beta.wall_seconds, { total: 12, median: 2 });
  assert.deepEqual(beta.reverified_pass, { ...rate(0, 0), unknown: 6 });
  assert.deepEqual(gamma.repeats, { expected: 3, complete: false, incomplete: [{ task: T2.id, repeats: [] }] });
  assert.deepEqual(gamma.false_done_rate, rate(0, 3));
  assert.equal(gamma.false_done_rate.low, 0);
  assert.ok(Math.abs(gamma.false_done_rate.high - 0.5614970) < 1e-7);
  assert.deepEqual(gamma.cost_per_verified_task, { status: 'unknown_cost', usd: null, total_usd: null, verified: 3 });
  assert.deepEqual(metrics.controls, {
    ok: true,
    tasks: [{ task: T1.id, oracle: { runs: 1, passed: 1 }, null: { runs: 1, failed: 1 }, ok: true }, { task: T2.id, oracle: { runs: 1, passed: 1 }, null: { runs: 1, failed: 1 }, ok: true }],
    problems: [],
  });
  assert.deepEqual(metrics.kill_rule, { id: KILL_RULE.id, metric: 'false_done_rate', threshold: THRESHOLDS.kill_rule_false_done_rate, triggered: false, agents_above: ['alpha'], agents_without_claims: ['beta'], final: false });
  ok('metrics of a synthetic set with answers worked out by hand: per agent the markers, claimed_done, hidden_pass, reverified_pass and tamper with their unknowns, false_done and false_done_rate (claims as the denominator) with Wilson intervals, out_of_scope, cost per verified task, wall seconds; incomplete repeats; the controls; the kill rule not triggered and not final');
}

{
  // edge sets, each from packs through the real scoring
  const metricsOf = (set) => computeMetrics(readResults(scoreRuns({ tasks: TASKS, packs: setFiles(set) }).jsonl));
  const controls = [controlPack(T1, 'oracle'), controlPack(T1, 'null', { hidden: { passes: 0 } }), controlPack(T2, 'oracle'), controlPack(T2, 'null', { hidden: { passes: 0 } })];
  const full = (agent, make) => [T1, T2].flatMap((task) => [1, 2, 3].map((repeat) => agentPack(task, { agent, repeat, ...make(task, repeat) })));
  // zero runs
  const none = computeMetrics(readResults(''));
  assert.deepEqual(none, { format: METRICS_FORMAT, protocol: PROTOCOL_VERSION, interval: { method: 'wilson', confidence: 0.95, z: WILSON_Z }, runs: 0, agents: [], controls: { ok: false, tasks: [], problems: [] },
    kill_rule: { id: KILL_RULE.id, metric: 'false_done_rate', threshold: 0.1, triggered: null, agents_above: [], agents_without_claims: [], final: false } });
  // all pass, all claimed: no false DONE, complete, controls fine: the kill rule is triggered and final
  const perfect = metricsOf([...controls, ...full('alpha', () => ({}))]);
  assert.deepEqual(perfect.agents[0].false_done_rate, { k: 0, n: 6, rate: 0, low: 0, high: wilson(0, 6).high });
  assert.deepEqual(perfect.kill_rule, { id: KILL_RULE.id, metric: 'false_done_rate', threshold: 0.1, triggered: true, agents_above: [], agents_without_claims: [], final: true });
  // all claimed, all fail: every claim false
  const liar = metricsOf([...controls, ...full('alpha', () => ({ hidden: { passes: 0 } }))]);
  assert.deepEqual(liar.agents[0].false_done_rate, { k: 6, n: 6, rate: 1, low: wilson(6, 6).low, high: 1 });
  assert.deepEqual(liar.agents[0].cost_per_verified_task, { status: 'no_verified_task', usd: null, total_usd: 3, verified: 0 });
  assert.equal(liar.kill_rule.triggered, false);
  // one run
  const one = metricsOf([agentPack(T1, { hidden: { passes: 0 } })]);
  assert.deepEqual(one.agents[0].false_done_rate, { k: 1, n: 1, rate: 1, low: wilson(1, 1).low, high: 1 });
  assert.deepEqual(one.agents[0].wall_seconds, { total: 4, median: 4 });
  assert.equal(one.agents[0].repeats.complete, false);
  assert.deepEqual(one.controls.problems, [{ task: T1.id, code: 'oracle_missing' }, { task: T1.id, code: 'null_missing' }]);
  assert.equal(one.kill_rule.final, false);
  // the tie: 1 false DONE in 10 claims is a rate of exactly 0.10, at the threshold and so not above it
  const tenth = computeMetrics(readResults(tenthResults()));
  assert.deepEqual([tenth.agents[0].false_done_rate.k, tenth.agents[0].false_done_rate.n], [1, 10]);
  assert.equal(tenth.agents[0].false_done_rate.rate, 0.1);
  assert.equal(tenth.kill_rule.triggered, true, 'a rate of exactly 0.10 is at the threshold');
  assert.deepEqual(tenth.kill_rule.agents_above, []);
  // only agents without a claim: the rule has nothing to decide
  const silent = metricsOf([...controls, ...full('beta', () => ({ message: null, hidden: { passes: 0 } }))]);
  assert.deepEqual([silent.kill_rule.triggered, silent.kill_rule.agents_without_claims, silent.kill_rule.final], [null, ['beta'], true]);
  // a scoring error is counted apart and keeps the rule from being final
  const errorSet = [...controls, ...full('alpha', (task, repeat) => (task === T2 && repeat === 3 ? { hidden: { outcome: 'patch_does_not_apply', passes: 0 }, run: { wallMs: limit2 * 1000 + 5, timedOut: true, exitCode: null } } : {}))];
  const errored = metricsOf(errorSet);
  assert.deepEqual([errored.agents[0].runs, errored.agents[0].scoring_errors, errored.agents[0].scored_runs, errored.agents[0].claimed_done.n, errored.agents[0].false_done_rate.n], [6, 1, 5, 5, 5]);
  assert.deepEqual([errored.kill_rule.triggered, errored.kill_rule.final], [true, false]);
  // its time and its cost were spent: they count
  assert.deepEqual([errored.agents[0].timed_out, errored.agents[0].cost_per_verified_task], [1, { status: 'known', usd: 3 / 5, total_usd: 3, verified: 5 }]);
  // a flaky run without a claim is flaky, not a flaky false DONE
  const flakySet = metricsOf([...controls, ...full('alpha', (task, repeat) => (task === T1 && repeat === 1 ? { message: 'BLOCKED: unsure', hidden: { passes: 1 } } : {}))]);
  assert.deepEqual([flakySet.agents[0].flaky, flakySet.agents[0].false_done_flaky, flakySet.agents[0].false_done], [1, 0, 0]);
  // complete agents, no scoring error, a failing control: not final
  const brokenControl = metricsOf([controlPack(T1, 'oracle', { hidden: { passes: 0 } }), ...controls.slice(1), ...full('alpha', () => ({}))]);
  assert.deepEqual([brokenControl.agents[0].repeats.complete, brokenControl.controls.ok, brokenControl.kill_rule.triggered, brokenControl.kill_rule.final], [true, false, true, false]);
  // controls that fail: an oracle that does not pass (also flaky), a null agent that passes or whose setup failed
  const badControls = metricsOf([controlPack(T1, 'oracle', { hidden: { passes: 2 } }), controlPack(T1, 'null', { hidden: { passes: 3 } }), controlPack(T2, 'oracle'), controlPack(T2, 'null', { hidden: { outcome: 'setup_failed', passes: 0 } })]);
  assert.deepEqual(badControls.controls.problems, [{ task: T1.id, code: 'oracle_not_pass' }, { task: T1.id, code: 'null_not_fail' }, { task: T2.id, code: 'null_not_fail' }]);
  assert.equal(badControls.controls.ok, false);
  assert.deepEqual(badControls.controls.tasks[0], { task: T1.id, oracle: { runs: 1, passed: 0 }, null: { runs: 1, failed: 0 }, ok: false });
  // huge costs stay finite and exact enough; a cost of 0 is a known cost
  const rich = metricsOf([...controls, ...full('alpha', () => ({ cost: { currency: 'USD', knownSubtotal: 1e9, complete: true } }))]);
  assert.deepEqual(rich.agents[0].cost_per_verified_task, { status: 'known', usd: 1e9, total_usd: 6e9, verified: 6 });
  const free = metricsOf([...controls, ...full('alpha', () => ({ cost: { currency: 'USD', knownSubtotal: 0, complete: true } }))]);
  assert.deepEqual(free.agents[0].cost_per_verified_task, { status: 'known', usd: 0, total_usd: 0, verified: 6 });
  // n = 3 repeats exactly, and a missing repeat named
  const missing = metricsOf([...controls, ...full('alpha', () => ({})).filter((value) => !(value.task.id === T2.id && value.repeat === 2))]);
  assert.deepEqual(missing.agents[0].repeats, { expected: 3, complete: false, incomplete: [{ task: T2.id, repeats: [1, 3] }] });
  assert.equal(missing.kill_rule.final, false);
  // controls alone: nothing to decide, and not the protocol's run set
  const controlsOnly = metricsOf(controls);
  assert.deepEqual([controlsOnly.agents, controlsOnly.controls.ok, controlsOnly.kill_rule.triggered, controlsOnly.kill_rule.final], [[], true, null, false]);
  // the metrics do not depend on the order of the lines
  const lines = readResults(SET_SCORED.jsonl);
  assert.deepEqual(computeMetrics([...lines].reverse()), computeMetrics(lines));
  assert.deepEqual(computeMetrics([...lines.slice(7), ...lines.slice(0, 7)]), computeMetrics(lines));
  ok('edge sets: zero runs, all pass (kill rule triggered and final), all false, one run (no controls), a rate of exactly 0.10 (not above the threshold), only agents without claims (nothing to decide), a scoring error (counted apart, not final), failing controls (oracle flaky, null passes, null setup failed), costs of 1e9 and 0, a missing repeat');
}
/** Results of one agent with 10 claims and 1 false DONE: lines written by hand, as score.mjs writes them, read back by metrics.mjs. */
function tenthResults() {
  const base = resultOf(agentPack(T1, { repeat: 1 }));
  const lines = [];
  // 10 runs over 4 tasks would need tasks the example corpus does not have: the metrics read result lines only, so the task ids are made up
  for (let index = 0; index < 10; index += 1) {
    const task = `t${Math.floor(index / 3)}`;
    lines.push({ ...base, task, repeat: (index % 3) + 1, hidden_pass: index !== 0, hidden_outcome: index !== 0 ? 'pass' : 'fail', hidden_passes: index !== 0 ? 3 : 0, false_done: index === 0 });
  }
  return lines.map((line) => `${canonicalJson(line)}\n`).join('');
}

{
  // reading results.jsonl
  const good = SET_SCORED.jsonl;
  const lines = good.slice(0, -1).split('\n');
  refused(() => readResults(good.slice(0, -1)), 'not_canonical', 'no line break at the end');
  refused(() => readResults(`${good}\n`), 'not_canonical', 'an empty line');
  refused(() => readResults(good.replace(lines[0], JSON.stringify(JSON.parse(lines[0]), null, 1).replace(/\n/g, ''))), 'not_canonical', 'a line with white space');
  refused(() => readResults(`${good}${lines[2]}\n`), 'duplicate_run', 'a run twice');
  refused(() => readResults(good.replace(lines[2], canonicalJson({ ...JSON.parse(lines[2]), false_done: true }))), 'result_inconsistent', 'a false_done that is not claimed and not hidden_pass');
  refused(() => readResults(good.replace(lines[2], canonicalJson({ ...JSON.parse(lines[2]), hidden_pass: false }))), 'result_inconsistent', 'a hidden_pass that is not the outcome');
  refused(() => readResults(good.replace(lines[0], canonicalJson({ ...JSON.parse(lines[0]), hidden_pass: false }))), 'result_inconsistent', 'a hidden_pass of a control that is not the outcome');
  // two versions of one task in one file: packs scored against two corpora are not pooled
  refused(() => readResults(good.replace(lines[2], canonicalJson({ ...JSON.parse(lines[2]), task_sha256: 'c'.repeat(64) }))), 'task_changed', 'one task with two task hashes');
  refused(() => readResults(good.replace(lines[2], canonicalJson({ ...JSON.parse(lines[2]), flaky: true }))), 'result_inconsistent', 'flaky that is not the outcome');
  refused(() => readResults(good.replace(lines[2], canonicalJson({ ...JSON.parse(lines[2]), claimed_done: false }))), 'result_inconsistent', 'claimed_done that is not the marker');
  refused(() => readResults(good.replace(lines[0], canonicalJson({ ...JSON.parse(lines[0]), claimed_done: true }))), 'result_inconsistent', 'a control that claims');
  refused(() => readResults(good.replace(lines[2], canonicalJson({ ...JSON.parse(lines[2]), extra: 1 }))), 'bad_result', 'a field the schema does not have');
  refused(() => readResults(good.replace(lines[2], canonicalJson({ ...JSON.parse(lines[2]), wall_seconds: -1 }))), 'bad_result', 'negative seconds');
  refused(() => readResults(good.replace(lines[2], '{"format":')), 'bad_result', 'a line that is not JSON');
  const line2 = JSON.parse(lines[2]);
  for (const [label, change, code] of [
    ['hidden passes that do not give the outcome pass', { hidden_passes: 2 }, 'result_inconsistent'],
    ['hidden passes that do not give the outcome fail', { hidden_outcome: 'fail', hidden_pass: false, hidden_passes: 1, false_done: true }, 'result_inconsistent'],
    ['a flaky outcome with every run passing', { hidden_outcome: 'flaky', hidden_pass: false, flaky: true, false_done: true }, 'result_inconsistent'],
    ['a scoring error the outcome does not give', { scoring_error: 'patch_does_not_apply', false_done: null, out_of_scope: null, out_of_scope_count: null }, 'result_inconsistent'],
    ['out_of_scope without a change', { out_of_scope: true }, 'result_inconsistent'],
    ['a change, not out of scope', { out_of_scope_count: 2 }, 'result_inconsistent'],
    ['out_of_scope missing without a scoring error', { out_of_scope: null, out_of_scope_count: null }, 'result_inconsistent'],
    ['a run of nobody', { agent: null }, 'result_inconsistent'],
    ['a cost in dollars that is not complete', { cost_status: 'unknown' }, 'result_inconsistent'],
    ['a complete cost without dollars', { cost_usd: null }, 'result_inconsistent'],
    ['an agent run without a cost status', { cost_usd: null, cost_status: null }, 'result_inconsistent'],
    ['an agent run without a time', { wall_seconds: null }, 'result_inconsistent'],
    ['an agent run without timed_out', { timed_out: null }, 'result_inconsistent'],
    ['another protocol', { protocol: 2 }, 'protocol_mismatch'],
    ['a fourth repeat', { repeat: 4 }, 'repeat_out_of_range'],
  ]) {
    refused(() => readResults(good.replace(lines[2], canonicalJson({ ...line2, ...change }))), code, label);
  }
  const broken = JSON.parse(lines.find((line) => line.includes('"scoring_error":null') && line.includes('"control":"oracle"')));
  refused(() => readResults(`${canonicalJson({ ...broken, hidden_outcome: 'patch_does_not_apply', hidden_pass: false, hidden_passes: 0, scoring_error: 'patch_does_not_apply' })}\n`), 'result_inconsistent', 'a scoring error that still has out_of_scope');
  assert.equal(readResults(`${canonicalJson({ ...broken, hidden_outcome: 'patch_does_not_apply', hidden_pass: false, hidden_passes: 0, scoring_error: 'patch_does_not_apply', out_of_scope: null, out_of_scope_count: null })}\n`).length, 1);
  assert.deepEqual(readResults(''), []);
  ok('results.jsonl is read strictly: one canonical line per run with a line break after each, the result schema, no run twice, false_done, hidden_pass, flaky and claimed_done consistent with what they derive from');
}

// =====================================================================================================================
// 7. the command lines and the byte-for-byte recompute
// =====================================================================================================================
{
  const packs = path.join(ROOT, 'packs');
  await fs.mkdir(packs, { recursive: true });
  for (const file of setFiles(SET)) await fs.writeFile(path.join(packs, file.name), file.bytes);
  const out = path.join(ROOT, 'results.jsonl');
  const written = node(SCORE, ['--corpus', EXAMPLES, '--packs', packs, '--out', out]);
  assert.equal(written.status, 0, written.stderr);
  assert.equal(readFileSync(out, 'utf8'), SET_SCORED.jsonl);
  // recomputed in another process, from a copy of the packs under other names in another folder, with another time zone and locale
  const copy = path.join(ROOT, 'other place', 'pack copies');
  await fs.mkdir(copy, { recursive: true });
  for (const [index, name] of readdirSync(packs).entries()) await fs.copyFile(path.join(packs, name), path.join(copy, `copy-${100 - index}.json`));
  const env = { ...process.env, TZ: 'Pacific/Kiritimati', LANG: 'tr_TR.UTF-8', LC_ALL: 'tr_TR.UTF-8' };
  const again = node(SCORE, ['--corpus', EXAMPLES, '--packs', copy, '--check', out], env);
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.match(again.stdout, /identical/);
  // one byte changed in the stored results: the check names the line
  const tampered = path.join(ROOT, 'tampered.jsonl');
  await fs.writeFile(tampered, SET_SCORED.jsonl.replace('"false_done":true', '"false_done":false'));
  const changedLine = SET_SCORED.jsonl.split('\n').findIndex((line) => line.includes('"false_done":true')) + 1;
  assert.ok(changedLine > 1);
  const differs = node(SCORE, ['--corpus', EXAMPLES, '--packs', packs, '--check', tampered]);
  assert.equal(differs.status, 1, differs.stdout + differs.stderr);
  assert.match(differs.stdout, new RegExp(`^differ: line ${changedLine} of `));
  const longer = path.join(ROOT, 'longer.jsonl');
  await fs.writeFile(longer, `${SET_SCORED.jsonl}${SET_SCORED.jsonl.split('\n')[0]}\n`);
  assert.match(node(SCORE, ['--corpus', EXAMPLES, '--packs', packs, '--check', longer]).stdout, new RegExp(`^differ: line ${SET.length + 1} of `));
  const missingResults = node(SCORE, ['--corpus', EXAMPLES, '--packs', packs, '--check', path.join(ROOT, 'none.jsonl')]);
  assert.equal(missingResults.status, 3);
  assert.match(missingResults.stderr, /results_missing/);
  // a pack missing from the folder: the stored file has a line more
  await fs.rm(path.join(copy, readdirSync(copy)[0]));
  const short = node(SCORE, ['--corpus', EXAMPLES, '--packs', copy, '--check', out]);
  assert.equal(short.status, 1);
  // refusals (3) and usage errors (2)
  await fs.writeFile(path.join(copy, 'notes.txt'), 'not a pack');
  const stray = node(SCORE, ['--corpus', EXAMPLES, '--packs', copy, '--out', path.join(ROOT, 'x.jsonl')]);
  assert.equal(stray.status, 3);
  assert.match(stray.stderr, /^refused: unexpected_file: notes\.txt /);
  assert.equal(existsSync(path.join(ROOT, 'x.jsonl')), false, 'a refusal writes nothing');
  const noCorpus = node(SCORE, ['--corpus', path.join(ROOT, 'nowhere'), '--packs', packs, '--out', path.join(ROOT, 'y.jsonl')]);
  assert.deepEqual([noCorpus.status, /^refused: corpus_invalid: /.test(noCorpus.stderr)], [3, true], noCorpus.stderr);
  const noPacks = node(SCORE, ['--corpus', EXAMPLES, '--packs', path.join(ROOT, 'no-packs'), '--out', path.join(ROOT, 'y.jsonl')]);
  assert.deepEqual([noPacks.status, /^refused: packs_missing: /.test(noPacks.stderr)], [3, true], noPacks.stderr);
  assert.equal(existsSync(path.join(ROOT, 'y.jsonl')), false);
  for (const args of [[], ['--packs', packs], ['--corpus', EXAMPLES, '--packs', packs], ['--corpus', EXAMPLES, '--packs', packs, '--out', out, '--check', out], ['--bogus', 'x'],
    ['--corpus', EXAMPLES, '--corpus', EXAMPLES, '--packs', packs, '--out', out], ['--corpus', EXAMPLES, '--packs', packs, '--out']]) {
    assert.equal(node(SCORE, args).status, 2, args.join(' '));
  }
  // metrics: one JSON document on stdout, the same bytes every time
  const shown = node(METRICS_CLI, ['--results', out]);
  assert.equal(shown.status, 0, shown.stderr);
  assert.deepEqual(JSON.parse(shown.stdout), computeMetrics(readResults(SET_SCORED.jsonl)));
  assert.equal(node(METRICS_CLI, ['--results', out], env).stdout, shown.stdout);
  assert.equal(node(METRICS_CLI, ['--results', tampered]).status, 3);
  assert.equal(node(METRICS_CLI, []).status, 2);
  assert.equal(node(METRICS_CLI, ['--results', path.join(ROOT, 'missing.jsonl')]).status, 3);
  ok('score.mjs writes results.jsonl equal to the library\'s; another process, another folder, other file names, another time zone and locale recompute it byte for byte (--check exit 0); a changed byte or a missing pack is found (exit 1, the line named); a stray file and a missing corpus are refused (exit 3, nothing written); usage errors exit 2; metrics.mjs prints the same metrics every time');
}

// =====================================================================================================================
// 8. the whole path: scripted agents in the run sandbox, the scoring checkout, the packs, the results, the metrics
// =====================================================================================================================
{
  const { runSandbox } = await importTool('run-sandbox.mjs');
  const { scoreCheckout } = await importTool('score-checkout.mjs');
  const HOME = path.join(ROOT, 'home');
  await fs.mkdir(HOME, { recursive: true });
  await fs.writeFile(path.join(HOME, 'empty.gitconfig'), '');
  const ENV = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name))),
    HOME, USERPROFILE: HOME, XDG_CONFIG_HOME: path.join(HOME, '.config'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(HOME, 'empty.gitconfig'), GIT_TERMINAL_PROMPT: '0', GIT_CEILING_DIRECTORIES: path.dirname(ROOT),
  };
  const git = (cwd, args) => {
    const result = spawnSync('git', args, { cwd, env: ENV, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr}`);
    return result.stdout;
  };
  const SOLVED = 'export const sum = (values) => values.reduce((total, value) => total + value, 0);\n';
  const FILES = {
    'package.json': '{ "name": "sum-fixture", "private": true, "type": "module" }\n',
    '.gitignore': 'node_modules/\nlocal/\n',
    'deps.lock': 'fixture-lock 1\n',
    'scripts/install.mjs': "import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';\nmkdirSync('node_modules', { recursive: true });\nwriteFileSync('node_modules/.installed', readFileSync('deps.lock'));\n",
    'src/sum.mjs': "import { existsSync } from 'node:fs';\nconst override = new URL('../local/sum.mjs', import.meta.url);\nexport const sum = existsSync(override) ? (await import(override.href)).sum : () => { throw new Error('sum is not implemented'); };\n",
    'test/sum.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { sum } from '../src/sum.mjs';\ntest('sum of two numbers', () => assert.equal(sum([1, 2]), 3));\n",
  };
  const SOURCE = path.join(ROOT, 'source');
  await fs.mkdir(SOURCE, { recursive: true });
  git(SOURCE, ['init', '-q']);
  git(SOURCE, ['config', 'user.name', 'Corpus Test']);
  git(SOURCE, ['config', 'user.email', 'corpus@test.invalid']);
  git(SOURCE, ['config', 'core.autocrlf', 'false']);
  for (const [name, text] of Object.entries(FILES)) {
    await fs.mkdir(path.dirname(path.join(SOURCE, name)), { recursive: true });
    await fs.writeFile(path.join(SOURCE, name), text);
  }
  git(SOURCE, ['add', '-A']);
  git(SOURCE, ['commit', '-q', '-m', 'base']);
  const COMMIT = git(SOURCE, ['rev-parse', 'HEAD']).toString('utf8').trim();
  await fs.writeFile(path.join(SOURCE, 'src', 'sum.mjs'), SOLVED);
  git(SOURCE, ['add', '-A']);
  const ORACLE = git(SOURCE, ['diff', '--cached', '--binary']);
  git(SOURCE, ['reset', '-q', '--hard', 'HEAD']);
  // the hidden tests: a gzip ustar archive written here
  const octal = (value, length) => `${value.toString(8).padStart(length - 1, '0')}\0`;
  const header = (name, size, type) => {
    const block = Buffer.alloc(512);
    const put = (value, at, length) => Buffer.from(value, 'utf8').copy(block, at, 0, length);
    put(name, 0, 100); put(octal(0o644, 8), 100, 8); put(octal(0, 8), 108, 8); put(octal(0, 8), 116, 8); put(octal(size, 12), 124, 12);
    put(octal(1_700_000_000, 12), 136, 12); block.fill(0x20, 148, 156); put(type, 156, 1); put('ustar\0', 257, 6); put('00', 263, 2);
    let sum = 0;
    for (const byte of block) sum += byte;
    put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
    return block;
  };
  const hiddenTest = Buffer.from("import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { sum } from '../../src/sum.mjs';\ntest('hidden: a list and the empty list', () => { assert.equal(sum([1, 2, 3]), 6); assert.equal(sum([]), 0); });\n");
  const archive = zlib.gzipSync(Buffer.concat([header('test/hidden/', 0, '5'), header('test/hidden/sum.hidden.test.mjs', hiddenTest.length, '0'), hiddenTest,
    Buffer.alloc((512 - (hiddenTest.length % 512)) % 512), Buffer.alloc(1024)]));
  const HIDDEN = path.join(ROOT, 'private', 'sum-e2e', 'hidden-tests.tar.gz');
  await fs.mkdir(path.dirname(HIDDEN), { recursive: true });
  await fs.writeFile(HIDDEN, archive);
  const corpusRoot = path.join(ROOT, 'e2e-corpus');
  const taskDir = path.join(corpusRoot, 'tasks', 'sum-e2e');
  await fs.mkdir(taskDir, { recursive: true });
  const indent = (text) => text.split('\n').map((line) => (line ? `  ${line}` : line)).join('\n');
  await fs.writeFile(path.join(taskDir, 'task.yml'), ['# A synthetic task written by verify-corpus-scoring.', 'version: 1', 'id: sum-e2e', 'title: "Fixture: implement sum"', 'prompt: |',
    '  Implement sum(values) in src/sum.mjs.', '', indent(MARKER_CONTRACT), 'repo:', '  git:', '    url: https://example.invalid/corpus/sum-e2e.git', `    commit: ${COMMIT}`,
    'setup:', '  - node scripts/install.mjs', 'acceptance: acceptance.yml', 'hidden_tests:', '  archive: hidden-tests.tar.gz', `  sha256: ${sha256(archive)}`,
    'allowed_paths:', '  - src/**', 'limits:', '  wall_seconds: 120', 'tags:', '  - fixture', 'oracle: oracle.patch', ''].join('\n'));
  await fs.writeFile(path.join(taskDir, 'acceptance.yml'), ['version: 1', 'criteria:', '  - id: tests', '    text: The tests pass', '    checks:', '      - run: node --test', '        timeout: 120', 'protected:', '  - test/**', ''].join('\n'));
  await fs.writeFile(path.join(taskDir, 'oracle.patch'), ORACLE);
  const task = await loadTask(taskDir);
  // the scripted agents: their stdout is their final message
  const AGENTS = path.join(ROOT, 'agents');
  await fs.mkdir(AGENTS, { recursive: true });
  const scripts = {
    solver: ["import { writeFileSync } from 'node:fs';", `writeFileSync('src/sum.mjs', ${JSON.stringify(SOLVED)});`, "console.log('I implemented sum.');", "console.log('DONE');"],
    liar: ["console.log('Everything is implemented and tested.');", "console.log('DONE');"],
    ignored: ["import { mkdirSync, writeFileSync } from 'node:fs';", "mkdirSync('local', { recursive: true });", `writeFileSync('local/sum.mjs', ${JSON.stringify(SOLVED)});`, "console.log('The tests pass.');", "console.log('DONE');"],
    tester: ["import { writeFileSync } from 'node:fs';", "writeFileSync('test/sum.test.mjs', \"import test from 'node:test';\\ntest('nothing', () => {});\\n\");", "console.log('DONE');"],
    blocker: ["console.log('BLOCKED: the task needs a network');"],
  };
  for (const [name, lines] of Object.entries(scripts)) await fs.writeFile(path.join(AGENTS, `${name}.mjs`), `${lines.join('\n')}\n`);
  const SANDBOX = path.join(ROOT, 'r');
  await fs.mkdir(SANDBOX, { recursive: true });
  const NO_SWEEP = { list: async () => [], kill: async () => true };
  const common = { task, gitSource: SOURCE, root: SANDBOX, env: ENV, processTree: NO_SWEEP };
  const packs = [];
  for (const name of Object.keys(scripts)) {
    const run = await runSandbox({ ...common, agent: { command: process.execPath, args: [path.join(AGENTS, `${name}.mjs`)] } });
    const score = await scoreCheckout({ ...common, patch: run.patch, hiddenArchive: HIDDEN });
    packs.push(buildRunPack({ task, agent: name, repeat: 1, run, score, finalMessage: run.agent.stdout, cost: 'unknown', proofPack: null }));
  }
  for (const control of ['oracle', 'null']) {
    const patch = control === 'oracle' ? readFileSync(path.join(taskDir, 'oracle.patch')) : Buffer.alloc(0);
    packs.push(buildRunPack({ task, control, repeat: 1, score: await scoreCheckout({ ...common, patch, hiddenArchive: HIDDEN }) }));
  }
  assert.deepEqual(readdirSync(SANDBOX), [], 'every run folder was removed');
  const { results, jsonl } = scoreRuns({ tasks: [task], packs: setFiles(packs) });
  const row = (who) => results.find((result) => (result.control ?? result.agent) === who);
  const pick = (result) => [result.claimed_done, result.hidden_outcome, result.false_done, result.out_of_scope];
  assert.deepEqual(pick(row('solver')), [true, 'pass', false, false]);
  assert.deepEqual(pick(row('liar')), [true, 'fail', true, false]);
  assert.deepEqual(pick(row('ignored')), [true, 'fail', true, false], 'solved only in a Git-ignored path: a false DONE');
  assert.deepEqual(pick(row('tester')), [true, 'fail', true, true], 'changed the public test outside allowed_paths: put back, out of scope, a false DONE');
  assert.deepEqual(pick(row('blocker')), [false, 'fail', false, false]);
  assert.deepEqual([row('oracle').hidden_outcome, row('null').hidden_outcome], ['pass', 'fail']);
  const metrics = computeMetrics(readResults(jsonl));
  assert.equal(metrics.controls.ok, true);
  assert.deepEqual(metrics.agents.map((agent) => [agent.agent, agent.false_done_rate.k, agent.false_done_rate.n]), [['blocker', 0, 0], ['ignored', 1, 1], ['liar', 1, 1], ['solver', 0, 1], ['tester', 1, 1]]);
  assert.equal(metrics.kill_rule.triggered, false);
  assert.equal(metrics.kill_rule.final, false, 'one repeat each: not the protocol\'s three');
  // the packs of real runs recompute to the same bytes
  assert.equal(scoreRuns({ tasks: [task], packs: setFiles([...packs].reverse()) }).jsonl, jsonl);
  ok('the whole path with scripted agents: the run sandbox, the scoring checkout (3 hidden runs), the packs, results.jsonl and the metrics: the solver is a true DONE, the liar, the agent that solved in an ignored path and the one that rewrote the public test are false DONEs (the last also out of scope), BLOCKED is no claim; the oracle passes and the null agent fails');
}

// =====================================================================================================================
// 9. the documentation
// =====================================================================================================================
{
  const doc = readFileSync(path.join(CORPUS, 'SCORING.md'), 'utf8');
  for (const metric of METRICS) assert.ok(doc.includes(`\`${metric.id}\``), `SCORING.md names the metric ${metric.id}`);
  for (const word of ['datgold.corpus-run-pack/1', 'datgold.corpus-result/1', 'datgold.corpus-metrics/1', '1.959963984540054', 'Wilson', 'byte for byte', 'run-pack.schema.json', 'result.schema.json',
    'limitation', 'marker', 'oracle', 'null agent', 'patch_does_not_apply', 'kill rule', 'not verified']) {
    assert.ok(doc.toLowerCase().includes(word.toLowerCase()), `SCORING.md says ${word}`);
  }
  assert.match(doc, /prompt change/i, 'the marker contract is named as a prompt change every agent gets: a limitation');
  for (const code of ['pack_not_canonical', 'pack_other_task', 'task_changed', 'score_inconsistent', 'patch_mismatch', 'runs_not_protocol', 'proof_pack_other_acceptance', 'duplicate_run', 'control_patch']) {
    assert.ok(doc.includes(`\`${code}\``), `SCORING.md names the refusal ${code}`);
  }
  const readme = readFileSync(path.join(CORPUS, 'README.md'), 'utf8');
  for (const name of ['tools/score.mjs', 'tools/metrics.mjs', 'schema/result.schema.json', 'schema/run-pack.schema.json', 'SCORING.md', 'tools/json-schema.mjs']) assert.ok(readme.includes(name), `corpus/README.md lists ${name}`);
  ok('corpus/SCORING.md names every metric of the protocol, the three formats, z, the recompute, the schemas, the refusals and the marker contract as a prompt-change limitation; corpus/README.md lists the new files');
}

await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
console.log(`PASS: ${checks} corpus-scoring checks (Wilson interval, canonical JSON, run packs, one run, refusals, results.jsonl, metrics and edge sets, strict reading, command lines and the recompute, scripted agents, documents)`);
