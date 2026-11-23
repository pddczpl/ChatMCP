// lib/proof/check-runner.mjs: the check runner of Proof-of-Done (P4 pod-21, docs/PROOF-CHECKS.md). It runs the trusted criterion checks of
// `.chatmcp/acceptance.yml` through ShellRunner and records every attempt as one pod-16 check receipt.
//
// What it proves, with real commands (Node scripts) through the real ShellRunner, the real pod-15 snapshot engine on real Git
// repositories, the real pod-20 trust store and the real pod-22 detector:
//   1. pass, fail, an expected exit code other than 0, a timeout (the tree of the command killed), a check whose output is cut (the hash
//      and the byte count cover every byte; the result does not change), `repeat`, a flaky check failing on its 2nd and on its 3rd of 3
//      runs (never retried), a check whose folder is missing (not run, the next check still runs), the timeout cap of ShellRunner;
//   2. a check that changes the tree once is run again on the new tree and counts there; a check that keeps changing it is unreliable
//      after two re-runs; a check that toggles a file is unreliable and never evidenced; a check that ran before another one changed the
//      tree is stale;
//   3. nothing runs for an untrusted file, an edited file or no file;
//   4. a cancel stops the running attempt (its receipt says cancelled) and every check after it;
//   5. a process a check leaves behind, with or without the output pipe, is reaped before the tree after is taken;
//   6. the roll-up is pack.mjs's own: the criteria of the report are the pack's criteria, and the pack built from the runner's ledger
//      validates;
//   7. the order of attempts is the file's and they never overlap; every attempt is one check line of a ledger whose chain verifies;
//   8. without a snapshot engine every attempt is recorded and nothing is rolled up;
//   9. the process table walk of the Windows reaper on hand-made tables (dead middles, reused pids, a root pid reused).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CHECK_RUN_FORMAT, TREE_RERUNS, processTreeOf, runAcceptanceChecks } from '../lib/proof/check-runner.mjs';
import { ProofLedger, verifyChain } from '../lib/proof/ledger.mjs';
import { acceptanceSha256, resolveAcceptance } from '../lib/proof/acceptance.mjs';
import { createTrustStore } from '../lib/proof/trust-store.mjs';
import { buildAgentChangeStatement, rollUpCriteria, validateStatement } from '../lib/proof/pack.mjs';
import { detectCheckChanges, gitTreeSide, workTreeSide } from '../lib/proof/tamper.mjs';
import { TreeSnapshotter } from '../lib/proof/tree-snapshot.mjs';
import { MAX_TIMEOUT_MS, ShellRunner } from '../lib/shell-runner.mjs';
import { StudioWorkspace } from '../lib/studio-workspace.mjs';
import { commitAll, fresh, git, newRepo, write } from './support/proof-tree-fixtures.mjs';

let checks = 0;
const suiteStart = performance.now();
const elapsed = () => `${((performance.now() - suiteStart) / 1000).toFixed(1)} s`;
const ok = (label) => { checks += 1; console.log(`  ok - ${label} [${elapsed()}]`); };
setTimeout(() => { console.error('FAIL: the proof checks suite exceeded its own time budget'); process.exit(2); }, 420_000).unref();

const sha256 = (data) => createHash('sha256').update(typeof data === 'string' ? Buffer.from(data, 'utf8') : data).digest('hex');
const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const AT = '2026-11-23T10:00:00.000Z';
const AGENT = { name: 'DatGold', version: '1.2.3-test' };

const TOOLS = {
  'tools/pass.js': "console.log('pass ok');\n",
  'tools/fail.js': "console.error('fail: 1 problem'); process.exit(1);\n",
  'tools/exit3.js': 'process.exit(3);\n',
  'tools/sleep.js': 'setTimeout(() => {}, Number(process.argv[2]));\n',
  'tools/big.js': "process.stdout.write('x'.repeat(Number(process.argv[2])));\n",
  // the n-th run (counted in a file outside the workspace, so the tree does not change) exits 1
  'tools/flaky.js': "const fs = require('fs'); const [file, failOn] = process.argv.slice(2); const n = (fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : 0) + 1; fs.writeFileSync(file, String(n)); process.exit(n === Number(failOn) ? 1 : 0);\n",
  'tools/write-once.js': "const fs = require('fs'); fs.mkdirSync('out', { recursive: true }); fs.writeFileSync('out/made.txt', 'made\\n');\n",
  'tools/append.js': "require('fs').appendFileSync('log.txt', 'run\\n');\n",
  'tools/toggle.js': "const fs = require('fs'); if (fs.existsSync('flag.txt')) fs.unlinkSync('flag.txt'); else fs.writeFileSync('flag.txt', 'on\\n');\n",
  'tools/started.js': "require('fs').writeFileSync(process.argv[2], String(process.pid)); setTimeout(() => {}, 60000);\n",
  'tools/sleeper.js': "require('fs').writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000);\n",
  'tools/marker.js': "require('fs').writeFileSync(process.argv[2], 'ran');\n",
  // writes new bytes into the workspace on every run, like a coverage report with a time stamp
  'tools/stamp.js': "const fs = require('fs'); fs.mkdirSync('cache', { recursive: true }); fs.writeFileSync('cache/stamp.txt', String(process.hrtime.bigint()));\n",
  // changes the tree on its 2nd run only (counted in a file outside the workspace)
  'tools/second.js': "const fs = require('fs'); const file = process.argv[2]; const n = (fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : 0) + 1; fs.writeFileSync(file, String(n)); if (n === 2) fs.writeFileSync('second.txt', '2\\n');\n",
};

const q = (text) => JSON.stringify(text);
/** An acceptance file: criteria [{id, checks: [{run, cwd?, timeout?, exit?, repeat?}]}]. */
function acceptanceText(criteria) {
  const lines = ['version: 1', 'criteria:'];
  for (const criterion of criteria) {
    lines.push(`  - id: ${criterion.id}`, `    text: ${q(`The criterion ${criterion.id}.`)}`, '    checks:');
    for (const check of criterion.checks) {
      lines.push(`      - run: ${q(check.run)}`);
      if (check.cwd) lines.push(`        cwd: ${q(check.cwd)}`);
      if (check.timeout) lines.push(`        timeout: ${check.timeout}`);
      if (check.repeat) lines.push(`        repeat: ${check.repeat}`);
      if (check.exit !== undefined) lines.push('        expect:', `          exit: ${check.exit}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/** A committed repository with the tools and an acceptance file, its ShellRunner, snapshot engine, ledger and trust store. */
async function scenario(label, criteria, { trust = true, snapshots = true, git: repository = true, files = {} } = {}) {
  const root = repository ? newRepo(label) : fresh(label);
  for (const [file, content] of Object.entries({ ...TOOLS, ...files })) write(root, file, content);
  write(root, 'README.md', `# ${label}\n`);
  const baselineText = acceptanceText(criteria);
  write(root, '.chatmcp/acceptance.yml', baselineText);
  if (repository) commitAll(root);
  const hub = fresh(`${label}-hub`);
  const state = fresh(`${label}-state`);
  const workspace = new StudioWorkspace({ manager: { workspace: root }, directory: state });
  const runner = new ShellRunner({ workspace, stateDirectory: state });
  const snapshotter = snapshots ? new TreeSnapshotter({ root, stateDir: fresh(`${label}-snapshots`) }) : null;
  const trustStore = createTrustStore(hub);
  if (trust) await trustStore.trust(acceptanceSha256(baselineText), { approvedBy: 'owner', at: AT });
  const ledger = ProofLedger.forTask(hub, `task-${label}`);
  const before = snapshotter ? await snapshotter.snapshot({ full: true }) : null;
  // `../<label>.<name>` from the workspace: outside the tree, so writing it changes nothing a snapshot sees
  const outside = (name) => path.join(path.dirname(root), `${label}.${name}`);
  const checkChanges = async () => {
    const stateDir = fresh(`${label}-tamper`);
    return detectCheckChanges({ baseline: await gitTreeSide({ root, rev: 'HEAD', stateDir }), final: await workTreeSide({ root, stateDir }) });
  };
  const current = () => fs.readFileSync(path.join(root, '.chatmcp', 'acceptance.yml'));
  return { label, root, hub, runner, snapshotter, trustStore, ledger, baselineText, before, outside, checkChanges, current };
}

const run = (s, extra = {}) => runAcceptanceChecks({
  baseline: s.baselineText, current: s.current(), trustStore: s.trustStore, runner: s.runner, ledger: s.ledger, snapshotter: s.snapshotter,
  checkChanges: s.checkChanges, ...extra,
});

/** The pack built from what the runner left (its ledger, the final tree), and the criteria the pack gives. */
async function packOf(s, report) {
  const after = await s.snapshotter.snapshot({ full: true });
  assert.equal(after.tree, report.finalTree.tree, `${s.label}: the runner's final tree is the tree now`);
  const acceptance = await resolveAcceptance({ baseline: s.baselineText, current: s.current(), trustStore: s.trustStore });
  const ledger = fs.existsSync(s.ledger.file) ? fs.readFileSync(s.ledger.file) : null;
  const statement = buildAgentChangeStatement({
    agent: AGENT, trees: { before: s.before, after }, diff: git(s.root, ['-c', 'core.autocrlf=false', 'diff', '--binary', '--no-color', 'HEAD']).stdout,
    acceptance, checkChanges: await s.checkChanges(), ledger, cost: null,
  });
  const validation = validateStatement(statement);
  assert.equal(validation.valid, true, `${s.label}: the pack validates: ${JSON.stringify(validation.errors.slice(0, 3))}`);
  assert.deepEqual(report.criteria, statement.predicate.criteria, `${s.label}: the runner's roll-up is the pack's`);
  return statement;
}

const byId = (report) => Object.fromEntries(report.criteria.map((criterion) => [criterion.id, criterion]));
const statusOf = (report) => Object.fromEntries(report.criteria.map((criterion) => [criterion.id, criterion.status]));
const runsOf = (report, id, index = 0) => report.checks.find((check) => check.criterionId === id && check.index === index);
const attemptsOf = (report, id, index = 0) => report.attempts.filter((attempt) => attempt.criterionId === id && attempt.index === index);
const ledgerChecks = (s) => {
  const bytes = fs.existsSync(s.ledger.file) ? fs.readFileSync(s.ledger.file) : Buffer.alloc(0);
  const report = verifyChain(bytes);
  assert.equal(report.ok, true, `${s.label}: the ledger chain verifies`);
  return bytes.toString('utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.type === 'check');
};
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
async function gone(pids, ms) {
  const until = Date.now() + ms;
  let left = pids.filter(alive);
  while (left.length && Date.now() < until) { await pause(100); left = left.filter(alive); }
  return left;
}

// ------------------------------------------------------------------ 9. the process table walk (pure)
{
  const T = 1_000_000;
  // root 10 (dead) -> 20 (dead, seen while it ran) -> 30 (alive) -> 40 (alive); 50 is someone else's
  const rows = [
    { pid: 20, ppid: 10, created: T + 10 }, { pid: 30, ppid: 20, created: T + 20 }, { pid: 40, ppid: 30, created: T + 30 },
    { pid: 50, ppid: 7, created: T + 15 }, { pid: 60, ppid: 50, created: T + 40 },
  ];
  assert.deepEqual(processTreeOf(rows, 10, T).map((row) => row.pid), [20, 30, 40]);
  // a child older than the shell is not its child (the pid belonged to an earlier process)
  assert.deepEqual(processTreeOf([{ pid: 21, ppid: 10, created: T - 5000 }, ...rows], 10, T).map((row) => row.pid), [20, 30, 40]);
  // pid 20 died and was reused by an unrelated process: the children of the new holder are not ours, the old holder's still are
  const reused = [...rows, { pid: 20, ppid: 99, created: T + 50 }, { pid: 70, ppid: 20, created: T + 60 }];
  assert.deepEqual(processTreeOf(reused, 10, T).map((row) => `${row.pid}@${row.created - T}`), ['20@10', '30@20', '40@30']);
  // the root's own pid reused by a newer process: what that process starts is not ours
  const rootReused = [...rows, { pid: 10, ppid: 3, created: T + 5000 }, { pid: 80, ppid: 10, created: T + 5010 }];
  assert.deepEqual(processTreeOf(rootReused, 10, T).map((row) => row.pid), [20, 30, 40]);
  // the root seen alive is listed; a parent and its child created in the same millisecond, in any order
  // (the child has the lower pid, so it comes first in the table's order)
  const same = [{ pid: 29, ppid: 30, created: T + 20 }, { pid: 10, ppid: 1, created: T + 1 }, ...rows];
  assert.deepEqual(processTreeOf(same, 10, T).map((row) => row.pid).sort((a, b) => a - b), [10, 20, 29, 30, 40]);
  // a table that could not be read is unknown, and the same row twice is listed once
  assert.equal(processTreeOf(null, 10, T), null);
  assert.deepEqual(processTreeOf([...rows, ...rows], 10, T).map((row) => row.pid), [20, 30, 40]);
  ok('process table walk: dead middles seen earlier, a child older than the shell, a reused pid and a reused root pid, same-millisecond parents, an unreadable table, duplicates');
}

// ------------------------------------------------------------------ 1. the ordinary results, the order, the ledger
{
  const s = await scenario('basic', [
    { id: 'pass', checks: [{ run: 'node tools/pass.js' }, { run: 'node tools/exit3.js', exit: 3, timeout: 3600 }] },
    { id: 'fail', checks: [{ run: 'node tools/fail.js' }] },
    { id: 'slow', checks: [{ run: 'node tools/sleep.js 30000', timeout: 1 }] },
    { id: 'big', checks: [{ run: 'node tools/big.js 100000' }] }, // under ShellRunner's default budget, over the 4,096 bytes asked for
    { id: 'flaky', checks: [{ run: 'node tools/flaky.js ../basic.flaky-2 2', repeat: 3 }] },
    { id: 'flaky-late', checks: [{ run: 'node tools/flaky.js ../basic.flaky-3 3', repeat: 3 }] },
    { id: 'nowhere', checks: [{ run: 'node tools/pass.js nowhere', cwd: 'nowhere' }, { run: 'node tools/pass.js after' }] },
    { id: 'twice', checks: [{ run: 'node tools/pass.js twice', repeat: 2 }] },
  ]);
  const started = Date.now();
  const report = await run(s, { maxOutputBytes: 4096 });
  assert.equal(report.format, CHECK_RUN_FORMAT);
  assert.equal(report.blocked, null);
  assert.equal(report.cancelled, false);
  assert.deepEqual(report.acceptance, { baselineSha256: acceptanceSha256(s.baselineText), trusted: true, edited: false });
  assert.deepEqual(statusOf(report), {
    pass: 'evidenced', fail: 'failed', slow: 'failed', big: 'evidenced', flaky: 'failed', 'flaky-late': 'failed', nowhere: 'unverified', twice: 'evidenced',
  });
  const c = byId(report);
  assert.deepEqual(c.pass.checks.map((check) => [check.result, check.passes]), [['passed', 1], ['passed', 1]]);
  assert.deepEqual(attemptsOf(report, 'pass', 1).map((attempt) => [attempt.exit, attempt.passed]), [[3, true]], 'exit 3 is a pass where 3 is expected');
  assert.deepEqual(attemptsOf(report, 'fail').map((attempt) => [attempt.exit, attempt.passed]), [[1, false]]);
  assert.equal(c.fail.reasons[0].detail, 'exit 1, expected 0');
  assert.equal(c.slow.reasons[0].detail, 'timed out');
  // the flaky checks: never retried after the failure, and the failure is the result
  assert.deepEqual(attemptsOf(report, 'flaky').map((attempt) => attempt.passed), [true, false]);
  assert.equal(fs.readFileSync(path.join(path.dirname(s.root), 'basic.flaky-2'), 'utf8'), '2', 'the 3rd run of a check that failed never ran');
  assert.deepEqual(attemptsOf(report, 'flaky-late').map((attempt) => attempt.passed), [true, true, false]);
  assert.deepEqual(c.flaky.checks.map((check) => [check.result, check.passes]), [['failed', 1]]);
  // repeat: two runs, both on the final tree
  assert.deepEqual(attemptsOf(report, 'twice').map((attempt) => attempt.passed), [true, true]);
  assert.deepEqual(c.twice.checks.map((check) => [check.result, check.passes, check.receipts.length]), [['passed', 2, 2]]);
  // a missing folder: not run, an error recorded, the next check of the criterion still runs
  assert.equal(runsOf(report, 'nowhere', 0).error.code, 'bad_cwd');
  assert.deepEqual(attemptsOf(report, 'nowhere', 0), []);
  assert.deepEqual(c.nowhere.checks.map((check) => check.result), ['not_run', 'passed']);
  // the timeout: the cap of ShellRunner, the default, and the killed command
  assert.equal(runsOf(report, 'pass', 1).timeoutMs, MAX_TIMEOUT_MS);
  assert.equal(runsOf(report, 'pass', 1).timeoutCapped, true);
  assert.equal(runsOf(report, 'pass', 0).timeoutMs, 600_000);
  assert.equal(runsOf(report, 'pass', 0).timeoutCapped, false);
  assert.equal(runsOf(report, 'slow').timeoutMs, 1000);
  const [slow] = attemptsOf(report, 'slow');
  assert.equal(slow.timedOut, true);
  assert.ok(slow.durationMs < 15_000, `a 1 s timeout ended the 30 s command (${slow.durationMs} ms)`);
  // every attempt is one check line, in the file's order, none overlapping another, the tree never changed
  const lines = ledgerChecks(s);
  assert.equal(lines.length, report.attempts.length);
  assert.deepEqual(report.attempts.map((attempt) => attempt.seq), lines.map((line) => line.seq));
  const order = report.attempts.map((attempt) => `${attempt.criterionId}/${attempt.index}`);
  assert.deepEqual([...new Set(order)], ['pass/0', 'pass/1', 'fail/0', 'slow/0', 'big/0', 'flaky/0', 'flaky-late/0', 'nowhere/1', 'twice/0']);
  for (let i = 1; i < report.attempts.length; i += 1) assert.ok(report.attempts[i].startedAt >= report.attempts[i - 1].endedAt, 'one attempt at a time');
  assert.ok(report.attempts[0].startedAt >= started);
  assert.ok(report.attempts.every((attempt) => attempt.treeChanged === false), 'no check of this scenario changes the tree');
  assert.ok(report.attempts.every((attempt) => attempt.attempt >= 1));
  assert.deepEqual(attemptsOf(report, 'flaky-late').map((attempt) => attempt.attempt), [1, 2, 3]);
  // the cut output: the receipt hashes and counts every byte, and the result is the exit code's
  const big = lines.find((line) => line.seq === attemptsOf(report, 'big')[0].seq).record;
  assert.equal(big.stdout.truncated, true);
  assert.equal(big.stdout.bytes, 100_000);
  assert.equal(big.stdout.sha256, sha256('x'.repeat(100_000)));
  assert.deepEqual(c.big.checks.map((check) => check.result), ['passed']);
  // toolchain versions: none without a probe
  assert.ok(lines.every((line) => line.record.toolchain === null));
  await packOf(s, report);
  ok('pass, fail, expected exit 3, a 1 s timeout, a cut output (hash of every byte), repeat 2, flaky checks failing on the 2nd and the 3rd of 3 runs (never retried), a missing folder; the timeout cap; file order, one at a time, one ledger line each; the pack agrees and validates');
}

// ------------------------------------------------------------------ 2. checks that change the tree
{
  const s = await scenario('settle', [
    { id: 'second', checks: [{ run: 'node tools/second.js ../settle.second', repeat: 2 }] },
    { id: 'early', checks: [{ run: 'node tools/pass.js' }] },
    { id: 'settle', checks: [{ run: 'node tools/write-once.js' }] },
    { id: 'late', checks: [{ run: 'node tools/pass.js late' }] },
  ]);
  const roots = [];
  const toolchain = { versions: async (root) => { roots.push(root); return { node: process.versions.node, python: null, dotnet: null, git: 'probe-test' }; } };
  const report = await run(s, { toolchain });
  assert.deepEqual(statusOf(report), { second: 'stale', early: 'stale', settle: 'evidenced', late: 'evidenced' });
  const lines = ledgerChecks(s);
  assert.ok(lines.every((line) => line.record.toolchain.node === process.versions.node && line.record.toolchain.git === 'probe-test'), 'every attempt records the toolchain');
  assert.equal(roots.length, lines.length);
  assert.ok(roots.every((root) => root === fs.realpathSync.native(s.root)), 'probed in the workspace folder');
  // a change of the tree starts the count of `repeat` again: the pass before it was on another tree
  assert.deepEqual(attemptsOf(report, 'second').map((attempt) => attempt.treeChanged), [false, true, false, false]);
  assert.equal(runsOf(report, 'second').unreliable, false);
  assert.deepEqual(attemptsOf(report, 'settle').map((attempt) => attempt.treeChanged), [true, false], 'run again once on the new tree, where it settles');
  assert.equal(runsOf(report, 'settle').unreliable, false);
  assert.equal(byId(report).early.reasons[0].code, 'check_stale');
  assert.notEqual(s.before.tree, report.finalTree.tree);
  await packOf(s, report);
  ok('a check that changes the tree once is run again on the new tree and counts there; a check that ran before it is stale; the pack agrees');
}
{
  const s = await scenario('unsettled', [
    { id: 'grow', checks: [{ run: 'node tools/append.js' }] },
    { id: 'grow-twice', checks: [{ run: 'node tools/append.js twice', repeat: 2 }] },
    { id: 'toggle', checks: [{ run: 'node tools/toggle.js' }] }, // last: its 2nd run starts on the final tree
  ]);
  const report = await run(s);
  assert.equal(TREE_RERUNS, 2);
  for (const id of ['grow', 'toggle', 'grow-twice']) {
    assert.deepEqual(attemptsOf(report, id).map((attempt) => attempt.treeChanged), [true, true, true], `${id}: the first run and two re-runs, all changing the tree`);
    assert.equal(runsOf(report, id).unreliable, true, `${id} is unreliable`);
  }
  // the toggle check: its 2nd run started on the final tree and passed, but changed it; it counts neither way
  assert.deepEqual(statusOf(report), { grow: 'stale', 'grow-twice': 'stale', toggle: 'stale' });
  assert.equal(byId(report).toggle.checks[0].passes, 0);
  assert.equal(byId(report).toggle.reasons[0].detail, 'ran on the final tree but did not leave it as it found it');
  await packOf(s, report);
  ok(`a check that keeps changing the tree is run again at most ${TREE_RERUNS} times and is unreliable; a toggling check passed on the final tree but changed it: never evidenced; the pack agrees`);
}

{
  // outputs a check writes: ignored in a Git workspace, part of the tree in a plain folder (raw-v1, no ignore rules)
  const criteria = [{ id: 'stamp', checks: [{ run: 'node tools/stamp.js' }] }];
  const ignored = await scenario('ignored', criteria, { files: { '.gitignore': 'cache/\n' } });
  const g = await run(ignored);
  assert.equal(g.finalTree.treeAlgorithm, 'git-pinned-v1');
  assert.deepEqual(attemptsOf(g, 'stamp').map((attempt) => attempt.treeChanged), [false], 'an ignored output leaves the tree as it was');
  assert.deepEqual(statusOf(g), { stamp: 'evidenced' });
  await packOf(ignored, g);
  const plain = await scenario('plain', criteria, { git: false });
  const p = await run(plain, { checkChanges: null });
  assert.equal(p.finalTree.treeAlgorithm, 'raw-v1');
  assert.deepEqual(attemptsOf(p, 'stamp').map((attempt) => attempt.treeChanged), [true, true, true]);
  assert.equal(runsOf(p, 'stamp').unreliable, true);
  assert.deepEqual(p.criteria.map((criterion) => [criterion.id, criterion.status, criterion.checks[0].result]), [['stamp', 'stale', 'stale']]);
  ok('a check writing new bytes on every run: evidenced in a Git workspace that ignores the output, unreliable and never evidenced in a plain folder (raw-v1 applies no ignore rules)');
}

// ------------------------------------------------------------------ 3. nothing runs without trust, with an edit, without a file
{
  const criteria = (s) => [{ id: 'marker', checks: [{ run: `node tools/marker.js ../${s}.marker` }] }];
  const untrusted = await scenario('untrusted', criteria('untrusted'), { trust: false });
  const u = await run(untrusted);
  assert.equal(u.blocked, 'acceptance_untrusted');
  assert.deepEqual(u.attempts, []);
  assert.equal(fs.existsSync(untrusted.outside('marker')), false, 'the check never ran');
  assert.equal(fs.existsSync(untrusted.ledger.file), false, 'nothing was recorded');
  assert.deepEqual(statusOf(u), { marker: 'unverified' });
  // no ledger was written at all, so it is also not verified
  assert.deepEqual(byId(u).marker.reasons.map((reason) => reason.code), ['check_not_run', 'acceptance_untrusted', 'ledger_not_verified']);
  await packOf(untrusted, u);

  const edited = await scenario('edited', criteria('edited'));
  write(edited.root, '.chatmcp/acceptance.yml', `${edited.baselineText}# a comment added after the task started\n`);
  const e = await run(edited);
  assert.equal(e.blocked, 'acceptance_edited');
  assert.deepEqual(e.acceptance, { baselineSha256: acceptanceSha256(edited.baselineText), trusted: true, edited: true });
  assert.deepEqual(e.attempts, []);
  assert.equal(fs.existsSync(edited.outside('marker')), false, 'the check never ran');
  assert.deepEqual(statusOf(e), { marker: 'unverified' });
  await packOf(edited, e);

  const none = await scenario('none', criteria('none'));
  const n = await runAcceptanceChecks({ baseline: null, current: null, trustStore: none.trustStore, runner: none.runner, ledger: none.ledger, snapshotter: none.snapshotter });
  assert.equal(n.blocked, 'no_baseline');
  assert.deepEqual(n.attempts, []);
  assert.deepEqual(n.criteria, []);
  assert.equal(fs.existsSync(none.outside('marker')), false);
  ok('nothing runs for an untrusted file, a file edited since the baseline or no file; the roll-up still says why; the pack agrees');
}

// ------------------------------------------------------------------ 4. cancel
{
  const s = await scenario('cancel', [
    { id: 'first', checks: [{ run: 'node tools/started.js ../cancel.started' }] },
    { id: 'second', checks: [{ run: 'node tools/marker.js ../cancel.marker' }] },
  ]);
  const controller = new AbortController();
  const pending = run(s, { signal: controller.signal });
  const startedFile = s.outside('started');
  const until = Date.now() + 30_000;
  while (!fs.existsSync(startedFile) && Date.now() < until) await pause(50);
  const pid = Number(fs.readFileSync(startedFile, 'utf8'));
  controller.abort();
  const report = await pending;
  assert.equal(report.cancelled, true);
  assert.equal(report.attempts.length, 1);
  assert.equal(report.attempts[0].cancelled, true);
  const lines = ledgerChecks(s);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].record.cancelled, true, 'the cancelled attempt is recorded');
  assert.ok(lines[0].record.treeAfter !== null && lines[0].record.treeAfter.tree !== null, 'with the tree after it');
  assert.equal(fs.existsSync(s.outside('marker')), false, 'no check runs after a cancel');
  assert.deepEqual(await gone([pid], 10_000), [], 'the cancelled command is gone');
  assert.deepEqual(statusOf(report), { first: 'failed', second: 'unverified' });
  assert.equal(byId(report).first.reasons[0].detail, 'cancelled');
  await packOf(s, report);
  const again = await run(s, { signal: AbortSignal.abort() });
  assert.equal(again.cancelled, true);
  assert.deepEqual(again.attempts, [], 'a signal aborted before the start runs nothing');
  ok('a cancel kills the running attempt, records it as cancelled with its tree after, and runs nothing after it; an aborted signal runs nothing');
}

// ------------------------------------------------------------------ 5. a process left behind is reaped
{
  const s = await scenario('linger', [
    { id: 'quiet', checks: [{ run: 'node tools/sleeper.js ../linger.quiet >/dev/null 2>&1 & node tools/sleep.js 2500' }] },
    { id: 'loud', checks: [{ run: 'node tools/sleeper.js ../linger.loud & node tools/sleep.js 2500' }] },
  ]);
  const report = await run(s);
  const lines = ledgerChecks(s);
  assert.ok(lines.every((line) => line.record.shell === 'bash'), 'these checks are bash commands');
  const pids = ['quiet', 'loud'].map((name) => Number(fs.readFileSync(s.outside(name), 'utf8')));
  assert.deepEqual(await gone(pids, 10_000), [], 'both children the checks left behind are gone');
  assert.equal(lines[1].record.lingering, true, 'the loud child held the output after the shell exited');
  assert.deepEqual(report.attempts.map((attempt) => attempt.reap.leftovers), [[], []]);
  assert.ok(report.attempts.every((attempt) => attempt.reap.left === true), 'the reaper found something left each time');
  assert.deepEqual(statusOf(report), { quiet: 'evidenced', loud: 'evidenced' });
  await packOf(s, report);
  ok(`a child left behind by a check, quiet or holding the output, is reaped (${process.platform === 'win32' ? 'the process table, read while the check ran and after it' : 'the process group'})`);
}

// ------------------------------------------------------------------ 8. no snapshot engine
{
  const s = await scenario('bare', [{ id: 'pass', checks: [{ run: 'node tools/pass.js', repeat: 2 }] }], { snapshots: false });
  const report = await run(s);
  assert.equal(report.finalTree, null);
  assert.equal(report.criteria, null, 'no roll-up without a final tree');
  assert.deepEqual(report.attempts.map((attempt) => attempt.treeChanged), [null, null]);
  assert.deepEqual(ledgerChecks(s).map((line) => [line.record.treeBefore, line.record.treeAfter]), [[null, null], [null, null]]);
  ok('without a snapshot engine every attempt is recorded with no tree, repeats still run, and nothing is rolled up');
}

// ------------------------------------------------------------------ 1b. a folder that leaves the workspace through a link
{
  const s = await scenario('escape', [{ id: 'escape', checks: [{ run: 'node marker.js ../escape.marker', cwd: 'link' }] }]);
  const away = fresh('escape-away');
  fs.writeFileSync(path.join(away, 'marker.js'), TOOLS['tools/marker.js']);
  // a junction needs no privilege on Windows (this machine cannot create symbolic links)
  fs.symlinkSync(away, path.join(s.root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  const report = await run(s, { checkChanges: null });
  assert.equal(runsOf(report, 'escape').error.code, 'symlink_escape');
  assert.deepEqual(report.attempts, []);
  assert.equal(fs.existsSync(s.outside('marker')), false, 'nothing ran in the folder outside');
  ok('a check folder that is a link leading out of the workspace is refused on its real path before anything runs');
}

// ------------------------------------------------------------------ 6. the roll-up is pack.mjs's (also checked in every scenario above)
{
  assert.equal(typeof rollUpCriteria, 'function');
  ok('the runner reports through rollUpCriteria of pack.mjs: in every scenario its criteria equal the pack built from its ledger');
}

console.log(`verify-proof-checks: ${checks} checks passed [${elapsed()}]`);
