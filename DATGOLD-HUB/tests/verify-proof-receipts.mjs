#!/usr/bin/env node
// Receipts bound to the workspace tree (plan task pod-18, docs/PROOF-RECEIPTS.md), on the real HubManager, PermissionGate, LocalTools, proof service and
// AgentRunner, on temporary Git projects; only the model is scripted. What it proves:
//   - the session carries the run's start tree, the one the proof ledger recorded, and the guard tells a caller which calls may change files;
//   - a coding run that ends where its receipts were made ends "fresh", its final tree is the ledger's task_end tree, and a follow-up run on unchanged files finds its
//     receipts fresh again, while one after an outside edit finds them stale;
//   - a check that changes the files it checks is no receipt (the strict pass rule);
//   - without trees (the checks-only budget switch, the Hub's data folder inside the workspace) freshness is unknown and never fresh: the run ends "missing evidence";
//   - a task saved by an older version loads, with its receipts of unknown freshness;
//   - no tree id, nor the prefix a receipt id carries, ever reaches the model.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HubManager } from '../lib/manager.mjs';
import { assembleStudio } from '../lib/assemble.mjs';
import { AgentRunner } from '../lib/agent.mjs';
import { MISSING } from '../lib/agent-autonomy.mjs';
import { treeKey } from '../lib/agent-progress.mjs';
import { readLedgerEntries } from '../lib/proof/service.mjs';
import { ledgerPath } from '../lib/proof/ledger.mjs';

const bundleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let checks = 0;
const check = (condition, label) => { assert.ok(condition, label); checks += 1; };
const equal = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks += 1; };
const STALE = ' on the final tree: its receipts are stale (the files changed after them)';
const UNKNOWN = ' on the final tree: freshness unknown (the Hub has no tree to compare them with)';
// A goal the Hub decomposes into a plan with an edit, a verify and a review phase, so that it judges the completion.
const GOAL = 'Read calc.js and find out why add() returns the wrong sum; then fix it with the smallest change and run the project tests; finally review the Git diff and report what is still limited.';

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-proof-receipts-')));

function git(cwd, args) {
  const result = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}
/** A Git project whose test passes once add() adds; `test` replaces the check script (one that writes a tracked file, say). */
async function project(name, { test = null, ignore = [] } = {}) {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'calc.js'), 'exports.add = (a, b) => a - b;\n');
  await fs.writeFile(path.join(dir, 'check.js'), test ?? "const { add } = require('./calc.js');\nif (add(2, 3) !== 5) { console.error('FAIL'); process.exit(1); }\nconsole.log('OK 1 test');\n");
  await fs.writeFile(path.join(dir, 'package.json'), `${JSON.stringify({ name: 'demo', version: '1.0.0', scripts: { test: 'node check.js' } }, null, 2)}\n`);
  await fs.writeFile(path.join(dir, 'notes.txt'), 'notes\n');
  await fs.writeFile(path.join(dir, '.gitignore'), ['cache.txt', ...ignore].join('\n') + '\n');
  git(dir, ['init', '-q']);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'initial']);
  return dir;
}
async function createHub(dataDirectory, proofOptions = null) {
  const manager = new HubManager({ dataDirectory, bundleRoot, log: () => {} });
  if (proofOptions) manager.proofOptions = proofOptions;
  assembleStudio(manager, { bundleRoot });
  await manager.permissions.load();
  await manager.load();
  return manager;
}

const say = (text) => ({ kind: 'say', text });
const tool = (name, args = {}) => ({ kind: 'tool', name, args });
function scripted(steps) {
  let turn = 0;
  let counter = 0;
  const seen = [];
  return {
    seen,
    snapshot: () => ({ model: 'scripted-1', provider: 'scripted' }),
    ready: () => true,
    redact: (text) => text,
    state: () => ({ provider: 'scripted', model: 'scripted-1', configured: true }),
    async respond({ input, instructions, signal }) {
      signal?.throwIfAborted();
      seen.push(JSON.stringify({ input, instructions }));
      const outputs = input.filter((item) => item.type === 'function_call_output');
      const last = outputs.length ? JSON.parse(typeof outputs.at(-1).output === 'string' ? outputs.at(-1).output : outputs.at(-1).output[0].text) : null;
      const step = steps[turn];
      turn += 1;
      if (!step) throw new Error(`The script has no step ${turn}.`);
      const produced = await step({ last });
      return {
        status: 'completed', usage: { input_tokens: 10, output_tokens: 5 },
        output: produced.map((item) => item.kind === 'tool'
          ? { type: 'function_call', call_id: `call_${(counter += 1)}`, name: item.name, arguments: JSON.stringify(item.args), status: 'completed' }
          : { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: item.text }] }),
      };
    },
  };
}
function approver(manager) {
  const handled = new Set();
  const timer = setInterval(() => {
    for (const request of manager.permissions.state().pending) {
      if (handled.has(request.id)) continue;
      handled.add(request.id);
      try { manager.permissions.decide(request.id, true); } catch { /* already decided */ }
    }
  }, 10);
  return () => clearInterval(timer);
}
async function finish(agent, id) {
  const until = Date.now() + 90_000;
  while (Date.now() < until) {
    const task = agent.get(id);
    if (task.status !== 'running' && agent.state().activeTaskId === null) return task;
    await sleep(20);
  }
  throw new Error('The task did not finish in time.');
}
async function section(title, body) {
  const before = checks;
  const started = Date.now();
  await body();
  console.log(`  ok  ${title} (${checks - before} checks, ${((Date.now() - started) / 1000).toFixed(1)}s)`);
}
// The steps of an ordinary coding run: read, the smallest fix, the project test, the diff.
const read = () => [tool('read_file', { path: 'calc.js' })];
const fix = ({ last }) => [tool('edit_file', { path: 'calc.js', old_string: 'a - b', new_string: 'a + b', expected_sha256: last.structuredContent.sha256 })];
const test = () => [tool('run_command', { command: 'npm test', description: 'Run the tests' })];
const diff = () => [tool('git_diff', {})];
const done = () => [say('Fixed add(), ran npm test, read the diff.')];
/** One run of the real loop; returns the task the runner keeps, and the ledger of the task. */
async function run(manager, dir, steps, { runner = null, id = null, prompt = GOAL } = {}) {
  await manager.selectWorkspace(dir);
  manager.permissions.configure({ mode: 'autonomous', executionPolicy: 'host-review' });
  const model = scripted(steps);
  const agent = runner ?? new AgentRunner({ manager, provider: model, taskDirectory: path.join(manager.hubDirectory, 'api-tasks'), log: () => {} });
  if (runner) agent.provider = model;
  if (!runner) await agent.load();
  const stop = approver(manager);
  try {
    const started = id ? await agent.continue({ id, prompt }) : await agent.start({ prompt });
    const task = await finish(agent, started.id);
    check(task.status === 'completed', `the task completed (${task.error ?? ''})`);
    const { entries } = await readLedgerEntries(ledgerPath(manager.hubDirectory, task.id));
    return { agent, task, model, entries, view: agent.get(task.id) };
  } finally { stop(); }
}
const trees = (entries, event) => entries.filter((entry) => entry.type === 'tree' && entry.record.event === event).map((entry) => entry.record.tree);
const ids = (entries) => [...new Set(entries.flatMap((entry) => [entry.record?.tree?.tree, entry.record?.treeBefore?.tree, entry.record?.treeAfter?.tree]).filter((value) => typeof value === 'string'))];

try {
  const data = path.join(root, 'hub-data');
  const manager = await createHub(data);

  await section('the session carries the start tree the ledger recorded, and the guard says which calls may change files', async () => {
    const dir = await project('session');
    await manager.selectWorkspace(dir);
    manager.permissions.configure({ mode: 'autonomous', executionPolicy: 'host-review' });
    const taskId = '123e4567-e89b-42d3-a456-426614174abc';
    manager.acquireTask(taskId);
    check(manager.taskId === taskId, '(premise) the task holds the workspace');
    try {
      const session = await manager.createAgentSession();
      const { entries } = await readLedgerEntries(ledgerPath(manager.hubDirectory, taskId));
      const [start] = trees(entries, 'task_start');
      check(typeof start?.tree === 'string', '(premise) the ledger recorded the start tree');
      equal(session.proofStart, { status: start.status, treeAlgorithm: start.treeAlgorithm, objectFormat: start.objectFormat, tree: start.tree, rawTree: start.rawTree ?? null }, 'the session carries it');
      const decisions = [];
      const onDecision = (info) => { decisions.push([info.name, info.mayChangeFiles]); };
      await session.callTool('local.read_file', { path: 'calc.js' }, { onDecision });
      await session.callTool('local.write_file', { path: 'new.txt', content: 'x\n' }, { onDecision });
      await session.callTool('local.git_status', {}, { onDecision });
      await session.callTool('local.run_command', { command: 'npm test', description: 'Run the tests' }, { onDecision });
      equal(decisions, [['local.read_file', false], ['local.write_file', true], ['local.git_status', false], ['local.run_command', true]], 'onDecision says which calls may change files: the categories the proof service scans');
      await session.close();
    } finally { await manager.finishProof(taskId, { status: 'completed' }); manager.releaseTask(taskId); }
  });

  let first;
  await section('a run that ends where its receipts were made is fresh; its final tree is the ledger\'s task_end tree; a follow-up run finds them fresh again, or stale after an outside edit', async () => {
    const dir = await project('fresh');
    first = await run(manager, dir, [read, fix, test, diff, done]);
    const { view, entries } = first;
    equal([view.verificationOutcome.ready, view.verificationOutcome.missing, view.verificationOutcome.freshness], [true, [], 'fresh'], 'every receipt the plan asks for is fresh on the final tree');
    equal([view.completionOutcome.verification, view.completionOutcome.freshness], ['evidence_present_not_objective_certified', 'fresh'], 'the completion is judged against the final tree');
    equal(view.receiptFreshness, { tree: true, fresh: 3, stale: 1, unknown: 0 }, 'the read was made on the start tree, before the edit: stale');
    const [end] = trees(entries, 'task_end');
    equal(first.task.progress.tree, treeKey(end), 'the latest tree the agent knew is the tree the ledger recorded at the end of the run');
    check(first.task.progress.verifiedChecks.every((receipt) => receipt.tree === treeKey(end)), 'and the passing check is bound to it');
    equal(view.objectiveReceipts.map((receipt) => receipt.kind), ['edit', 'verify', 'review'], 'only fresh receipts are offered for acceptance');
    check(view.objectiveReceipts.every((receipt) => receipt.receiptId.endsWith('@' + end.tree.slice(0, 12))), 'each id ends with the prefix of the final tree');
    const timeline = await manager.workflow.state(first.task.id);
    equal([timeline.verified, timeline.freshness], [true, 'fresh'], 'the guard gave the timeline the trees too: its passing check is fresh');
    // A follow-up question, no file changed: the run's start tree is the final tree of the first run, so the receipts are fresh again.
    const again = await run(manager, dir, [() => [say('Nothing else to do.')]], { runner: first.agent, id: first.task.id, prompt: 'Is anything left?' });
    equal(again.view.receiptFreshness, { tree: true, fresh: 3, stale: 1, unknown: 0 }, 'a follow-up run on unchanged files: the receipts are fresh again');
    equal(again.view.verificationOutcome.freshness, 'fresh');
    // An edit made outside the Hub between the runs: the start tree of the next run differs, so every receipt is stale.
    await fs.appendFile(path.join(dir, 'notes.txt'), 'edited by the person\n');
    const after = await run(manager, dir, [() => [say('Nothing else to do.')]], { runner: first.agent, id: first.task.id, prompt: 'And now?' });
    equal(after.view.receiptFreshness, { tree: true, fresh: 0, stale: 4, unknown: 0 }, 'after an outside edit between the runs: every receipt is stale');
    equal(after.view.verificationOutcome.missing, [MISSING.edit + STALE, MISSING.verify + STALE, MISSING.review + STALE], 'and the run is not certified');
    equal(after.view.objectiveReceipts, [], 'nothing can be accepted');
    // The owner cannot accept a receipt made on a tree that is gone (fresh at accept time).
    await assert.rejects(first.agent.acceptCriterion({ id: first.task.id, objectiveId: 'objective-1', criterionIndex: 0, receiptId: first.view.objectiveReceipts[0].receiptId, confirmed: true }), { code: 'stale_acceptance_receipt' });
    checks += 1;
  });

  await section('a change after the last scanned call (a process a command left running, the person\'s editor) shows in the final tree: the run ends stale', async () => {
    // late.js starts a detached process and exits at once: the command's own trees are the same; the process writes notes.txt 1.5 s later, after the last
    // scanned call. Only the full snapshot of the run's end (ProofService.end) sees it.
    const LATE = "const { spawn } = require('child_process');\nspawn(process.execPath, ['-e', \"setTimeout(() => require('fs').appendFileSync('notes.txt', 'late\\\\n'), 1500)\"], { cwd: __dirname, detached: true, stdio: 'ignore' }).unref();\nconsole.log('started');\n";
    const dir = await project('late-writer');
    await fs.writeFile(path.join(dir, 'late.js'), LATE);
    git(dir, ['add', 'late.js']);
    git(dir, ['commit', '-q', '-m', 'late']);
    const notes = path.join(dir, 'notes.txt');
    const waitForLate = async () => {
      for (let i = 0; i < 400 && !(await fs.readFile(notes, 'utf8')).includes('late'); i++) await sleep(25);
      check((await fs.readFile(notes, 'utf8')).includes('late'), '(premise) the background process wrote notes.txt after the last scanned call');
      return [say('Fixed add(), ran npm test, read the diff, started a helper.')];
    };
    const late = await run(manager, dir, [read, fix, test, diff, () => [tool('run_command', { command: 'node late.js', description: 'Start a helper' })], waitForLate]);
    const [end] = trees(late.entries, 'task_end');
    const calls = late.entries.filter((entry) => entry.type === 'call');
    check(calls.at(-1).record.changed === false, '(premise) the command that started the process changed nothing while it ran');
    check(end.tree !== calls.at(-1).record.treeAfter.tree, '(premise) the final tree differs from the tree after the last call');
    const { view } = late;
    equal(view.status, 'completed', 'the task status stays completed');
    equal([view.verificationOutcome.ready, view.verificationOutcome.missing, view.verificationOutcome.freshness], [false, [MISSING.edit + STALE, MISSING.verify + STALE, MISSING.review + STALE], 'stale'],
      'judged again against the final tree: every receipt is stale');
    equal([view.completionOutcome.verification, view.completionOutcome.freshness], ['missing_evidence', 'stale'], 'the completion is missing evidence, stale');
    equal(view.receiptFreshness, { tree: true, fresh: 0, stale: 5, unknown: 0 }, 'the receipts are kept, all stale');
    equal(late.task.progress.tree, treeKey(end), 'the current tree is the final tree of the ledger');
    check(/NOT independently verified/.test(view.finalText), 'the answer carries the Hub\'s warning');
    check(view.events.some((event) => event.type === 'verification_unverified' && event.reason === 'final_tree_changed'), 'and an event says the final tree changed');
    equal(view.objectiveReceipts, [], 'nothing can be accepted');
    // The downgrade is saved: a Hub that loads the task again shows it.
    const reloaded = new AgentRunner({ manager, provider: scripted([]), taskDirectory: path.join(manager.hubDirectory, 'api-tasks'), log: () => {} });
    await late.agent.shutdown();
    await reloaded.load();
    const again = reloaded.get(late.task.id);
    equal([again.verificationOutcome.ready, again.completionOutcome.verification, again.completionOutcome.freshness, again.receiptFreshness.fresh], [false, 'missing_evidence', 'stale', 0], 'the downgrade was saved');
    await reloaded.shutdown();

    // The person edits a file in their own editor while the model writes its answer: the same.
    const edited = await project('person-edits');
    const typing = await run(manager, edited, [read, fix, test, diff, async () => { await fs.appendFile(path.join(edited, 'notes.txt'), 'typed by the person\n'); return done(); }]);
    equal([typing.view.verificationOutcome.ready, typing.view.completionOutcome.freshness], [false, 'stale'], 'an edit made outside the Hub before the run ended: stale');
    // And nothing changed after the last call: the classification stands (the control).
    const quiet = await project('quiet');
    const calm = await run(manager, quiet, [read, fix, test, diff, done]);
    equal([calm.view.verificationOutcome.ready, calm.view.completionOutcome.freshness], [true, 'fresh'], 'no change after the last call: still fresh');
    check(!calm.view.events.some((event) => event.reason === 'final_tree_changed'), 'and no event');
  });

  await section('a check that changes the files it checks is no receipt (the strict pass rule)', async () => {
    const dir = await project('writing-check', { test: "const fs = require('fs');\nconst { add } = require('./calc.js');\nfs.appendFileSync('notes.txt', 'ran\\n');\nif (add(2, 3) !== 5) process.exit(1);\nconsole.log('OK 1 test');\n" });
    const { view, task } = await run(manager, dir, [read, fix, test, diff, done]);
    equal(task.progress.receipts.filter((receipt) => receipt.kind === 'verify'), [], 'the passing run that wrote notes.txt left no check receipt');
    equal(task.progress.checksChangedTree, 1, 'it is counted as a check that changed the files it checked');
    equal(view.verificationOutcome.missing, [MISSING.edit + STALE, MISSING.verify], 'the run misses a check, and the edit is stale too: the check changed the files after it (the diff, read after the check, is fresh)');
    // The same check writing a file Git ignores leaves the tree: a receipt.
    const ignored = await project('ignored-check', { test: "const fs = require('fs');\nconst { add } = require('./calc.js');\nfs.writeFileSync('cache.txt', 'ran');\nif (add(2, 3) !== 5) process.exit(1);\nconsole.log('OK 1 test');\n" });
    const fine = await run(manager, ignored, [read, fix, test, diff, done]);
    equal([fine.view.verificationOutcome.ready, fine.task.progress.checksChangedTree], [true, 0], 'a check that writes only an ignored file is a receipt');
  });

  await section('without trees freshness is unknown, never fresh: the checks-only budget switch', async () => {
    // Every scan is "too slow": after the first scanned call the run switches to checks-only, and the later calls have no trees.
    const slow = await createHub(path.join(root, 'hub-slow'), { budget: { meanScanMs: -1, minScans: 1 } });
    const dir = await project('checks-only');
    const { view, task, entries } = await run(slow, dir, [read, fix, test, diff, done]);
    check(entries.some((entry) => entry.type === 'uncertain' && entry.record.reason === 'checks_only'), '(premise) the run switched to checks-only');
    equal(task.progress.tree, null, 'after a call that may change files came back without trees, the tree is unknown');
    equal(view.receiptFreshness, { tree: false, fresh: 0, stale: 0, unknown: 4 }, 'every receipt is of unknown freshness');
    equal([view.verificationOutcome.ready, view.verificationOutcome.missing, view.verificationOutcome.freshness], [false, [MISSING.edit + UNKNOWN, MISSING.verify + UNKNOWN, MISSING.review + UNKNOWN], 'unknown'], 'the run is not certified: unknown is not fresh');
    equal([view.completionOutcome.verification, view.completionOutcome.freshness], ['missing_evidence', 'unknown'], 'it ends "missing evidence", with freshness unknown');
    check(/NOT independently verified/.test(view.finalText), 'and the answer says so');
    equal(view.objectiveReceipts, [], 'nothing can be accepted');
  });

  await section('without trees freshness is unknown, never fresh: the Hub\'s data folder inside the workspace', async () => {
    const dir = await project('inside', { ignore: ['.hub/'] });
    const inside = await createHub(path.join(dir, '.hub'));
    const { view, entries } = await run(inside, dir, [read, fix, test, diff, done]);
    equal(entries, [], '(premise) the proof service is disabled: no ledger');
    equal(view.receiptFreshness, { tree: false, fresh: 0, stale: 0, unknown: 4 }, 'every receipt is of unknown freshness');
    equal([view.verificationOutcome.ready, view.verificationOutcome.freshness, view.completionOutcome.verification], [false, 'unknown', 'missing_evidence'], 'the run ends "missing evidence", freshness unknown');
  });

  await section('a task saved by an older version loads, with its receipts of unknown freshness', async () => {
    const file = path.join(manager.hubDirectory, 'api-tasks', first.task.id, 'task.json');
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    // What an older version wrote: four lists of receipts without trees, a counter that is gone, no `receipts`, no `tree`.
    const strip = (list) => list.map(({ tree, ...rest }) => rest);
    const receipts = saved.progress.receipts;
    saved.progress = { ...saved.progress, invalidatedEvidence: 3, verifiedInspections: strip(receipts.filter((r) => r.kind === 'inspect')), verifiedFiles: strip(receipts.filter((r) => r.kind === 'edit')),
      verifiedChecks: strip(receipts.filter((r) => r.kind === 'verify')), gitReviews: strip(receipts.filter((r) => r.kind === 'review')) };
    delete saved.progress.receipts; delete saved.progress.tree; delete saved.progress.checksChangedTree;
    await first.agent.shutdown();
    await fs.writeFile(file, JSON.stringify(saved, null, 2));
    const reloaded = new AgentRunner({ manager, provider: scripted([]), taskDirectory: path.join(manager.hubDirectory, 'api-tasks'), log: () => {} });
    await reloaded.load();
    const view = reloaded.get(first.task.id);
    equal(view.receiptFreshness, { tree: false, fresh: 0, stale: 0, unknown: 4 }, 'the four receipts are there, of unknown freshness');
    equal([view.progress.verifiedFiles, view.progress.verifiedChecks, view.progress.gitReviews], [[], [], []], 'none is fresh');
    equal(view.objectiveReceipts, [], 'none can be accepted');
    equal(view.completionOutcome, saved.completionOutcome, 'the completion it was given is shown as it was saved');
    await reloaded.shutdown();
  });

  await section('a Hub that died during a call that may change files: after the restart the tree is unknown', async () => {
    const dir = await project('crashed');
    const ran = await run(manager, dir, [read, fix, test, diff, done]);
    await ran.agent.shutdown();
    const file = path.join(manager.hubDirectory, 'api-tasks', ran.task.id, 'task.json');
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    const load = async (task) => {
      await fs.writeFile(file, JSON.stringify(task, null, 2));
      const runner = new AgentRunner({ manager, provider: scripted([]), taskDirectory: path.join(manager.hubDirectory, 'api-tasks'), log: () => {} });
      await runner.load();
      const view = runner.get(ran.task.id);
      await runner.shutdown();
      return view;
    };
    // What a Hub that died while a command ran leaves: the task running, its call executing.
    const crashed = await load({ ...saved, status: 'running', state: 'running', pendingCall: { callId: 'call_9', toolName: 'local.run_command', startedAt: saved.startedAt, outcome: 'pending_or_unknown', phase: 'executing' } });
    equal([crashed.state, crashed.receiptFreshness.tree, crashed.receiptFreshness.fresh], ['uncertain', false, 0], 'the command may have changed the files: no receipt is fresh');
    // A Hub that died between calls: the tree the run saw last is still the tree.
    const between = await load({ ...saved, status: 'running', state: 'running', pendingCall: null });
    equal([between.state, between.receiptFreshness.tree, between.receiptFreshness.fresh], ['paused', true, 3], 'no call was running: the receipts keep their freshness');
  });

  await section('no tree id, nor the prefix a receipt id carries, reaches the model', async () => {
    const dir = await project('leak');
    const ran = await run(manager, dir, [read, fix, test, diff, done]);
    const again = await run(manager, dir, [() => [say('Done.')]], { runner: ran.agent, id: ran.task.id, prompt: 'Anything left?' });
    const all = ids(again.entries);
    check(all.length >= 2, '(premise) the ledger holds several tree ids');
    const sent = [...ran.model.seen, ...again.model.seen].join('\n');
    equal(all.filter((id) => sent.includes(id) || sent.includes(id.slice(0, 12))), [], 'none of them, whole or cut to the receipt prefix, is in any request to the model');
    await ran.agent.shutdown();
  });

  console.log(`PASS: ${checks} checks - receipts bound to the workspace tree (start tree, final tree, follow-up runs, strict pass rule, checks-only and disabled, old tasks, no tree id to the model)`);
} finally {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
}
