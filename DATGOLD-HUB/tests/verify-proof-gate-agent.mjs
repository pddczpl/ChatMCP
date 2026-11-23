// The done-gate in the agent loop (plan task pod-23, docs/PROOF-GATE.md), on the real HubManager, PermissionGate, LocalTools, proof service, baseline store, check runner,
// hooks and AgentRunner, with real check commands on temporary projects; only the model is scripted. The rules of the gate alone are in verify-proof-gate.mjs, a real Hub
// process is in verify-proof-gate-e2e.mjs.
//  1. a pass: the checks are the evidence the receipts show, before the hooks judge the answer; no tree id reaches the model
//  2. fails, then fixes: the host message, the stall counters, the tool calls in between
//  3. fails twice: ends failed, not looping; the notice; the owner's acceptance of an objective does not undo it; a follow-up run starts again
//  4. the model weakens a test: the pass is flagged, the criterion is checks_modified by the pack's own roll-up, in the follow-up run too
//  5. the hooks: after the gate; a block does not run the checks again on the same tree; a hook that changes a file after a pass makes it stale
//  6. a step limit; a message queued while the checks run; a stop while a check runs (its process is gone, the attempt is recorded)
//  7. no gate: no acceptance file, an untrusted one, Read Only, plan mode, an agent another agent started
//  8. a plain folder; a second chat in its own worktree (the owner's trust list is the Hub's); a killed baseline
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HubManager } from '../lib/manager.mjs';
import { assembleStudio } from '../lib/assemble.mjs';
import { AgentRunner } from '../lib/agent.mjs';
import { ConcurrentApiAgent } from '../lib/concurrent-api-agent.mjs';
import { createTurnMapper } from '../lib/acp/event-map.mjs';
import { treeKey } from '../lib/agent-progress.mjs';
import { finalPartsOf } from '../lib/final-text.mjs';
import { acceptanceSha256, resolveAcceptance } from '../lib/proof/acceptance.mjs';
import { GATE_EVENT } from '../lib/proof/gate.mjs';
import { ledgerPath } from '../lib/proof/ledger.mjs';
import { rollUpCriteria } from '../lib/proof/pack.mjs';
import { readLedgerEntries } from '../lib/proof/service.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const bundleRoot = path.resolve(HERE, '..');
const HOOK = path.join(HERE, 'fixtures', 'hook-program.mjs');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let checks = 0;
const check = (condition, label) => { assert.ok(condition, label); checks += 1; };
const equal = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks += 1; };
setTimeout(() => { console.error('FAIL: the done-gate agent suite exceeded its own time budget'); process.exit(2); }, 172_000).unref();
// A goal the Hub decomposes into a plan with an edit, a verify and a review phase, so that it judges the completion.
const GOAL = 'Read calc.js and find out why add() returns the wrong sum; then fix it with the smallest change and run the project tests; finally review the Git diff and report what is still limited.';

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-proof-gate-agent-')));
function git(cwd, args) {
  const result = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}
const TEST = "const assert = require('node:assert');\nconst { add } = require('./calc.js');\nconsole.log('password=hunter2hunter2hunter2 running');\nassert.equal(add(2, 3), 5);\nassert.equal(add(1, 1), 2);\nconsole.log('OK 2 tests');\n";
const WEAK = "const assert = require('node:assert');\nconst { add } = require('./calc.js');\nassert.ok(add);\nconsole.log('OK');\n";
const ACCEPT = (runs = { tests: 'node calc.test.js' }) => `version: 1\ncriteria:\n${Object.entries(runs).map(([id, run]) => `  - id: ${id}\n    text: "The criterion ${id}."\n    checks:\n      - run: ${JSON.stringify(run)}\n`).join('')}`;
async function project(name, { acceptance = ACCEPT(), repository = true, files = {} } = {}) {
  const dir = path.join(root, name);
  await fs.mkdir(path.join(dir, '.chatmcp'), { recursive: true });
  const all = { 'calc.js': 'exports.add = (a, b) => a - b;\n', 'calc.test.js': TEST, 'notes.txt': 'notes\n', '.gitignore': 'cache/\n', ...(acceptance === null ? {} : { '.chatmcp/acceptance.yml': acceptance }), ...files };
  for (const [file, text] of Object.entries(all)) await fs.writeFile(path.join(dir, file), text);
  if (repository) { git(dir, ['init', '-q', '-b', 'main']); git(dir, ['add', '-A']); git(dir, ['commit', '-q', '-m', 'initial']); }
  return dir;
}
async function createHub(name) {
  const manager = new HubManager({ dataDirectory: path.join(root, `${name}-hub`), bundleRoot, log: () => {} });
  assembleStudio(manager, { bundleRoot });
  await manager.permissions.load();
  await manager.load();
  return manager;
}
const trust = (manager, text) => manager.acceptanceTrustStore().trust(acceptanceSha256(text), { approvedBy: 'owner' });

const say = (text) => ({ kind: 'say', text });
const tool = (name, args = {}) => ({ kind: 'tool', name, args });
const textsOf = (input) => input.filter((item) => item?.role === 'user').map((item) => item.content.map((part) => part.text ?? '').join(''));
function scripted(steps) {
  let turn = 0;
  let counter = 0;
  const model = {
    seen: [], requests: [],
    snapshot: () => ({ model: 'scripted-1', provider: 'scripted' }),
    ready: () => true,
    redact: (text) => text,
    state: () => ({ provider: 'scripted', model: 'scripted-1', configured: true }),
    async respond({ input, instructions, signal }) {
      signal?.throwIfAborted();
      model.seen.push(JSON.stringify({ input, instructions }));
      model.requests.push(structuredClone(input));
      const outputs = input.filter((item) => item.type === 'function_call_output');
      const last = outputs.length ? JSON.parse(typeof outputs.at(-1).output === 'string' ? outputs.at(-1).output : outputs.at(-1).output[0].text) : null;
      const step = steps[turn];
      turn += 1;
      if (!step) throw new Error(`The script has no step ${turn}.`);
      const produced = await step({ last, input, users: textsOf(input) });
      return {
        status: 'completed', usage: { input_tokens: 10, output_tokens: 5 },
        output: produced.map((item) => item.kind === 'tool'
          ? { type: 'function_call', call_id: `call_${(counter += 1)}_${Math.random().toString(36).slice(2, 8)}`, name: item.name, arguments: JSON.stringify(item.args), status: 'completed' }
          : { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: item.text }] }),
      };
    },
  };
  return model;
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
async function until(test, label, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await test();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await sleep(20);
  }
}
async function section(title, body) {
  const before = checks;
  const started = Date.now();
  await body();
  console.log(`  ok  ${title} (${checks - before} checks, ${((Date.now() - started) / 1000).toFixed(1)}s)`);
}
const read = () => [tool('read_file', { path: 'calc.js' })];
const fix = ({ last }) => [tool('edit_file', { path: 'calc.js', old_string: 'a - b', new_string: 'a + b', expected_sha256: last.structuredContent.sha256 })];
const diff = () => [tool('git_diff', {})];
const write = (file, content) => () => [tool('write_file', { path: file, content, overwrite: true })];
const answer = (text) => () => [say(text)];
const done = answer('Done.');

/** One run of the real loop on `dir`: {agent, task, model, entries, gate events, view}. */
async function run(manager, dir, steps, { runner = null, id = null, prompt = GOAL, start = {}, mode = 'autonomous', status = 'completed', during = null } = {}) {
  if (manager.workspace !== dir) await manager.selectWorkspace(dir);
  manager.permissions.configure({ mode, executionPolicy: 'host-review' });
  const model = scripted(steps);
  const agent = runner ?? new AgentRunner({ manager, provider: model, taskDirectory: path.join(manager.hubDirectory, 'api-tasks'), log: () => {} });
  if (runner) agent.provider = model;
  if (!runner) await agent.load();
  const stop = approver(manager);
  try {
    const started = id ? await agent.continue({ id, prompt, ...start }) : await agent.start({ prompt, ...start });
    const before = agent.get(started.id).eventCount;
    if (during) await during({ agent, id: started.id, model });
    const view = await until(() => { const task = agent.get(started.id); return task.status !== 'running' && agent.state().activeTaskId === null ? task : null; }, 'the task to end', 90_000);
    equal(view.status, status, `the task ended ${status} (${view.error ?? ''})`);
    const { entries, report } = await readLedgerEntries(ledgerPath(manager.hubDirectory, view.id));
    check(report.ok, 'the ledger verifies');
    const events = view.events.filter((event) => event.type === GATE_EVENT && event.run === undefined);
    return { agent, id: view.id, model, entries, events, gates: events.map((event) => event.gate), view, before };
  } finally { stop(); }
}
const checksOf = (entries) => entries.filter((entry) => entry.type === 'check').map((entry) => entry.record);
const treeIds = (entries) => [...new Set(entries.flatMap(({ record }) => [record?.tree?.tree, record?.tree?.rawTree, record?.treeBefore?.tree, record?.treeBefore?.rawTree, record?.treeAfter?.tree, record?.treeAfter?.rawTree]).filter((value) => typeof value === 'string'))];
const feedback = (request) => textsOf(request).filter((text) => text.startsWith('[Done-gate'));
const hooksFile = (manager) => path.join(manager.hubDirectory, 'hooks.json');
const handler = (spec) => ({ type: 'command', command: process.execPath, args: [HOOK, JSON.stringify(spec)] });

try {
  const manager = await createHub('main');
  await trust(manager, ACCEPT());

  await section('1. a pass: the owner\'s checks run fresh on the final tree, before the hooks, and are the evidence the receipts show', async () => {
    const dir = await project('pass');
    const log = path.join(root, 'pass-hooks.txt');
    await fs.writeFile(hooksFile(manager), JSON.stringify({ hooks: { TaskCompleted: [{ hooks: [handler({ logPayload: log })] }] } }));
    const one = await run(manager, dir, [read, fix, diff, done]);
    await fs.rm(hooksFile(manager));
    equal(one.model.requests.length, 4, 'one answer: nothing sent the agent back');
    equal(one.gates, ['armed', 'running', 'passed']);
    const { view } = one;
    equal([view.completionOutcome.gate, view.completionOutcome.checksModified, view.proofGate.status, view.proofGate.rounds], ['passed', false, 'passed', 0]);
    equal(view.proofGate.criteria, [{ id: 'tests', kind: 'checks', status: 'evidenced', codes: [] }], 'by the strict pass rule');
    const records = checksOf(one.entries);
    equal(records.map((record) => [record.command, record.exit]), [['node calc.test.js', 0]], 'one check receipt in the task\'s ledger');
    check(records[0].treeBefore.tree === records[0].treeAfter.tree, 'on one tree');
    const end = one.entries.findLast((entry) => entry.type === 'tree' && entry.record.event === 'task_end').record.tree;
    equal([view.proofGate.tree, records[0].treeAfter.tree], [treeKey(end), end.tree], 'which is the tree the run ended on');
    // No run_command was made: the verify receipt of the plan is the gate's check, named by its ledger line.
    const line = fsSync.readFileSync(ledgerPath(manager.hubDirectory, view.id), 'utf8').split('\n').filter(Boolean).map((text) => JSON.parse(text)).find((entry) => entry.type === 'check');
    equal(view.progress.verifiedChecks.map((receipt) => [receipt.id, receipt.tree]), [[line.hash.slice(0, 16), treeKey(end)]], 'the gate\'s passing check is the verify receipt, fresh on the final tree');
    equal([view.verificationOutcome.ready, view.verificationOutcome.freshness], [true, 'fresh'], 'so the plan\'s evidence is complete without a check the model ran itself');
    check(view.goalPlan.phases.find((phase) => phase.id === 'verify').status === 'has_evidence', 'and the verify phase of the plan has its evidence');
    equal(view.finalText, 'Done.', 'a clean pass adds nothing to the answer');
    const payload = JSON.parse(fsSync.readFileSync(log, 'utf8').trim().split('\n').at(-1));
    equal(payload.chatmcp_verification.ready, true, 'the TaskCompleted hook judged the gated answer (its evidence holds the gate\'s check)');
    const order = view.events.map((event) => (event.type === GATE_EVENT ? event.gate : event.type)).filter((type) => ['running', 'passed', 'hook_passed', 'completed'].includes(type));
    equal(order, ['running', 'passed', 'hook_passed', 'completed'], 'the gate first, then the hooks');
    check(view.stateHistory.some((entry) => entry.to === 'verifying' && entry.reason === 'proof_gate'), 'the task shows as verifying while the checks run');
    for (const id of treeIds(one.entries)) check(one.model.seen.every((request) => !request.includes(id)), 'no tree id in any request');
    check(fsSync.readdirSync(path.join(manager.hubDirectory, 'proof', 'gate', 'proof', 'baselines')).length === 1, 'the baseline is in the gate\'s own folder');
    check(!fsSync.existsSync(path.join(manager.hubDirectory, 'proof', 'baselines')), 'and not among those of chatmcp verify');
    equal(git(dir, ['status', '--porcelain']).trim(), 'M calc.js', 'the gate wrote nothing into the workspace');
  });

  await section('2. fails, then fixes: the host message with the exit code and the masked output, and the stall counters start again', async () => {
    const dir = await project('fixes');
    // Nine unchanged re-reads: one more and the run would end as stalled.
    const reread = () => [tool('read_file', { path: 'notes.txt' })];
    const steps = [read, reread, ...Array.from({ length: 9 }, () => reread), answer('All good.'), reread, read, fix, diff, answer('Fixed it.')];
    const two = await run(manager, dir, steps);
    equal(two.gates, ['armed', 'running', 'failed', 'running', 'passed']);
    const atGate = two.model.requests[12];
    const [message] = feedback(atGate);
    equal(feedback(atGate).length, 1);
    check(textsOf(atGate).at(-1) === message && atGate.at(-1).role === 'user', 'the message follows the answer it is about');
    check(/^\[Done-gate · round 1 of 2\]/.test(message) && /node calc\.test\.js/.test(message) && /exit 1 \(expected 0\)/.test(message), 'it names the round, the command and the exit code');
    check(/^\| .*AssertionError/m.test(message), 'with the end of what the check printed');
    check(!message.includes('hunter2') && !two.model.seen.some((request) => request.includes('hunter2hunter2')), 'masked');
    const { view } = two;
    equal([view.completionOutcome.gate, view.proofGate.rounds, view.finalText], ['passed', 1, 'Fixed it.'], 'the fixed answer is the result');
    equal(view.dialogue.filter((entry) => entry.role === 'assistant').map((entry) => entry.text), ['Fixed it.'], 'the refused answer is not');
    equal(view.prompts.length, 1, 'and the host message is not a prompt');
    equal(checksOf(two.entries).map((record) => record.exit), [1, 0]);
    equal([view.events.find((event) => event.gate === 'failed').sentBack, view.events.find((event) => event.gate === 'failed').rounds], [true, 1]);
    check(!view.events.some((event) => event.type === GATE_EVENT && /AssertionError|hunter2/.test(event.message)), 'no output in the events');
  });

  let failedRun;
  await section('3. fails twice: ends failed with a notice, not looping; the owner\'s acceptance does not undo it; a follow-up run starts again', async () => {
    const dir = await project('twice');
    const log = path.join(root, 'failed-hooks.txt');
    await fs.writeFile(hooksFile(manager), JSON.stringify({ hooks: { TaskCompleted: [{ hooks: [handler({ logPayload: log })] }] } }));
    failedRun = await run(manager, dir, [read, answer('It is done.'), answer('Really done.')]);
    await fs.rm(hooksFile(manager));
    const payloads = fsSync.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    equal(payloads.map((payload) => [payload.chatmcp_completion.requirements, payload.chatmcp_verification.ready]), [['failed', false]], 'a hook is asked once, about the answer the gate judged');
    const { view, model } = failedRun;
    equal(model.requests.length, 3, 'one send-back, then the end');
    equal(failedRun.gates, ['armed', 'running', 'failed', 'running', 'failed']);
    equal([view.status, view.completionOutcome.requirements, view.completionOutcome.verification, view.completionOutcome.gate], ['completed', 'failed', 'missing_evidence', 'failed']);
    equal([view.proofGate.rounds, view.proofGate.limit, view.proofGate.failing], [2, 2, [{ criterionId: 'tests', index: 0, detail: 'exit 1' }]]);
    check(/^Really done\.\n\n\[Done-gate notice\] This task is NOT done: the owner's trusted acceptance checks failed on the final tree \(tests: exit 1\)\./.test(view.finalText), 'a prominent notice right behind the words');
    equal(view.verificationOutcome.ready, false);
    const parts = finalPartsOf(view);
    equal([parts.words, typeof parts.gateNotice], ['Really done.', 'string'], 'the record tells the words from the notice');
    check(view.verificationOutcome.missing.some((item) => /trusted acceptance checks failed/.test(item)), 'the gate is among what is missing');
    check(parts.verificationNotice !== null && !parts.verificationNotice.includes('trusted acceptance checks'), 'and not said twice');
    equal(view.progress.verifiedChecks, [], 'a failed gate leaves no verify receipt');
    check(/This task is NOT done/.test(createTurnMapper({ cwd: dir }).finalText(view)), 'an editor that runs the task is told too');
    check(/"requirements": "failed"/.test(await failedRun.agent.report(view.id)), 'the report says failed');
    // a reload of the tasks keeps it
    const again = new AgentRunner({ manager, provider: scripted([]), taskDirectory: path.join(manager.hubDirectory, 'api-tasks'), log: () => {} });
    await again.load();
    equal([again.get(view.id).completionOutcome.requirements, again.get(view.id).proofGate.status], ['failed', 'failed'], 'after a restart');
    const listed = again.state().tasks.find((task) => task.id === view.id);
    equal([listed.proofGate.status, listed.proofGate.checks], ['failed', undefined], 'the list carries the status only');
    // the owner's acceptance of an objective does not make a failed gate verified
    const objective = view.goalPlan.objectives[0];
    const receipt = view.objectiveReceipts.find((item) => item.kind === 'inspect');
    check(receipt, '(premise) there is a fresh receipt to accept');
    const accepted = await failedRun.agent.acceptCriterion({ id: view.id, objectiveId: objective.id, criterionIndex: 0, receiptId: receipt.receiptId, confirmed: true });
    equal([accepted.completionOutcome.requirements, accepted.completionOutcome.gate], ['failed', 'failed'], 'an acceptance of an objective does not undo a failed gate');
    // a follow-up run of the conversation has its own rounds
    const next = await run(manager, dir, [answer('Still done.'), ({ users }) => { check(/round 1 of 2/.test(users.at(-1)), 'the rounds start again'); return [tool('read_file', { path: 'calc.js' })]; }, fix, answer('Fixed now.')], { runner: failedRun.agent, id: view.id, prompt: 'Please fix it.' });
    equal([next.view.completionOutcome.gate, next.view.proofGate.rounds], ['passed', 1]);
    check(!/Done-gate notice/.test(next.view.finalText), 'and its own result');
  });

  await section('4. the model weakens a test to pass: the pass is flagged, the pack\'s roll-up calls it checks_modified, a follow-up run still sees it, a failing round says it too', async () => {
    const dir = await project('weaken');
    const weak = await run(manager, dir, [read, answer('Done.'), write('calc.test.js', WEAK), answer('All checks pass.')]);
    const { view } = weak;
    equal(weak.gates, ['armed', 'running', 'failed', 'running', 'passed']);
    equal([view.completionOutcome.gate, view.completionOutcome.checksModified, view.completionOutcome.requirements], ['passed', true, 'unverified'], 'the checks pass and nothing is certified');
    equal(view.proofGate.criteria[0].status, 'checks_modified');
    equal(view.proofGate.modifications, [{ path: 'calc.test.js', codes: ['assertions_removed'] }]);
    equal(view.progress.verifiedChecks, [], 'a pass with modified checks is no receipt');
    equal([view.verificationOutcome.ready, view.status], [false, 'completed']);
    check(/\[Done-gate notice\] The owner's trusted acceptance checks passed, but checks were modified during the task \(calc\.test\.js: assertions_removed\)/.test(view.finalText), 'the notice names the change');
    equal(view.events.findLast((event) => event.gate === 'passed').checksModified, true);
    // the same ledger, tree and acceptance through the pack's own roll-up
    const last = checksOf(weak.entries).at(-1);
    const acceptance = await resolveAcceptance({ baseline: ACCEPT(), current: ACCEPT(), trustStore: manager.acceptanceTrustStore() });
    const rolled = rollUpCriteria({ after: { ...last.treeAfter }, acceptance, checkChanges: { format: 'chatmcp.check-changes/1', checks_modified: true, criteria: [{ id: 'tests', checks_modified: true, reasons: [{ code: 'assertions_removed', path: 'calc.test.js' }] }] }, ledger: await fs.readFile(ledgerPath(manager.hubDirectory, view.id)) });
    equal(rolled.criteria[0].status, 'checks_modified', 'a pack of this ledger and tree says the same');
    equal(fsSync.readdirSync(path.join(manager.hubDirectory, 'proof', 'gate')), ['proof'], 'the scratch folder of the report is gone');
    const next = await run(manager, dir, [answer('Anything else?')], { runner: weak.agent, id: view.id, prompt: 'Thanks.' });
    equal([next.view.completionOutcome.gate, next.view.completionOutcome.checksModified], ['passed', true], 'the baseline is the one of the conversation\'s start: a follow-up run still sees the change');
    // skipping the test while it still fails
    const still = await project('weaken-fails');
    const fails = await run(manager, still, [answer('Done.'), write('calc.test.js', TEST.replace("assert.equal(add(1, 1), 2);\n", '')), answer('Done.')]);
    equal([fails.view.completionOutcome.requirements, fails.view.completionOutcome.checksModified], ['failed', true], 'a failure with modified checks says both');
    check(/This task is NOT done.*Checks were modified during the task \(calc\.test\.js: assertions_removed\)/.test(fails.view.finalText));
    // on the gate message itself: the test is changed before the first answer
    const early = await project('weaken-early');
    const told = await run(manager, early, [write('calc.test.js', TEST.replace("assert.equal(add(1, 1), 2);\n", '')), answer('Done.'), ({ users }) => { check(/Checks were modified during the task/.test(users.at(-1)) && /calc\.test\.js: assertions_removed/.test(users.at(-1)), 'the gate message carries the flag'); return [say('I cannot fix it.')]; }]);
    equal(told.view.completionOutcome.requirements, 'failed');
    // an edited acceptance file runs nothing and is no way out
    const edited = await project('edit-acceptance');
    const out = await run(manager, edited, [write('.chatmcp/acceptance.yml', ACCEPT({ tests: 'node -e ""' })), answer('Done.'), ({ users }) => { check(/acceptance\.yml was edited/.test(users.at(-1)), 'the agent is told'); return [say('Done.')]; }]);
    equal([out.view.completionOutcome.requirements, out.view.proofGate.reason, checksOf(out.entries).length], ['failed', 'acceptance_edited', 0]);
  });

  await section('5. the hooks: a block does not run the checks again on the same tree; a file changed after the pass makes it stale', async () => {
    const dir = await project('hooks', { files: { 'calc.js': 'exports.add = (a, b) => a + b;\n' } });
    const count = path.join(root, 'stop-count.txt');
    await fs.writeFile(hooksFile(manager), JSON.stringify({ hooks: { Stop: [{ hooks: [handler({ plan: { file: count, steps: [{ exit: 2, stderr: 'Add a summary.' }, { exit: 0 }] } })] }] } }));
    const held = await run(manager, dir, [answer('First.'), answer('Second, with a summary.')]);
    equal([held.gates, checksOf(held.entries).length], [['armed', 'running', 'passed', 'passed'], 1], 'the checks ran once for two answers on one tree');
    equal([held.view.completionOutcome.gate, held.view.proofGate.reused, held.view.goalPlan.phases.find((phase) => phase.id === 'verify').receipts], ['passed', true, 1], 'a reused judgment is no second receipt');
    // a Stop hook that writes a tracked file after the gate passed
    await fs.writeFile(hooksFile(manager), JSON.stringify({ hooks: { Stop: [{ hooks: [handler({ write: path.join(dir, 'notes.txt') })] }] } }));
    const late = await run(manager, dir, [answer('Done.')]);
    await fs.rm(hooksFile(manager));
    equal([late.view.proofGate.status, late.view.completionOutcome.gate, late.view.completionOutcome.requirements, late.view.verificationOutcome.ready], ['stale', 'stale', 'unverified', false], 'the pass was on another tree than the one the run ended on');
    check(/\[Done-gate notice\] The files changed after the owner's trusted acceptance checks passed/.test(late.view.finalText));
    equal(late.view.runs.at(-1).finalText, late.view.finalText, 'the run keeps the answer as it reads');
  });

  await section('6. a step limit, a message queued while the checks run, a stop while a check runs', async () => {
    const dir = await project('limits');
    const limited = await run(manager, dir, [answer('Done.')], { start: { maxSteps: 1 } });
    equal([limited.view.status, limited.view.completionOutcome.requirements, limited.view.proofGate.stopped], ['completed', 'failed', 'no_turn_left'], 'no further turn: failed at once, and the answer is not lost to the step limit');
    check(/no model turn was left/.test(limited.view.finalText));

    const slowFile = "require('node:fs').writeFileSync(require('node:path').join(__dirname, '..', 'slow.pid'), String(process.pid)); setTimeout(() => process.exit(0), 60000);\n";
    const SLOW = ACCEPT({ slow: 'node slow.js' });
    await trust(manager, SLOW);
    const slow = await project('stopped', { acceptance: SLOW, files: { 'slow.js': slowFile } });
    const pidFile = path.join(root, 'slow.pid');
    const started = Date.now();
    const cancelled = await run(manager, slow, [answer('Done.')], { status: 'cancelled', during: async ({ agent, id }) => {
      await until(() => fsSync.existsSync(pidFile) && fsSync.readFileSync(pidFile, 'utf8').length > 0, 'the check to start');
      equal(agent.get(id).state, 'verifying', 'the task shows as verifying');
      await agent.cancel(id);
    } });
    check(Date.now() - started < 45_000, 'the stop does not wait for the check');
    const pid = Number(fsSync.readFileSync(pidFile, 'utf8'));
    check(await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 'the check\'s process to be gone', 10_000), 'the check is killed');
    equal([cancelled.view.errorCode, cancelled.view.proofGate, cancelled.view.finalText], ['user_cancelled', null, ''], 'a stopped run is not judged');
    equal(checksOf(cancelled.entries).map((record) => record.cancelled), [true], 'the cut attempt is recorded');
    await fs.rm(pidFile, { force: true });

    const WAIT = ACCEPT({ wait: 'node wait.js' });
    await trust(manager, WAIT);
    const queued = await project('queued', { acceptance: WAIT, files: { 'wait.js': "require('node:fs').writeFileSync(require('node:path').join(__dirname, '..', 'wait.pid'), '1'); setTimeout(() => process.exit(0), 1500);\n" } });
    const stops = path.join(root, 'queued-hooks.txt');
    await fs.writeFile(hooksFile(manager), JSON.stringify({ hooks: { Stop: [{ hooks: [handler({ logPayload: stops })] }] } }));
    const asked = await run(manager, queued, [answer('First.'), ({ users }) => { check(users.at(-1).includes('One more thing'), 'the queued message is delivered after the gate'); return [say('Second.')]; }], { prompt: 'Look around.', during: async ({ agent, id }) => {
      await until(() => fsSync.existsSync(path.join(root, 'wait.pid')), 'the check to start');
      await agent.enqueueMessage({ id, prompt: 'One more thing.' });
    } });
    await fs.rm(hooksFile(manager));
    equal(fsSync.readFileSync(stops, 'utf8').trim().split('\n').map((line) => JSON.parse(line).last_assistant_message), ['Second.'], 'the hooks are not asked about an answer that is not the last');
    equal([asked.view.finalText, asked.view.completionOutcome.gate], ['Second.', 'passed'], 'the answer the person\'s message replaced is not the result');
    equal(asked.view.dialogue.filter((entry) => entry.role === 'assistant').map((entry) => entry.text), ['First.', 'Second.'], 'and stays in the dialogue');
  });

  await section('7. no gate: no acceptance file, an untrusted one, Read Only, plan mode, an agent that another agent started', async () => {
    const bare = await run(manager, await project('bare', { acceptance: null }), [done], { prompt: 'Look around.' });
    equal([bare.events, bare.view.proofGate, bare.view.completionOutcome.gate], [[], null, undefined], 'no file: no gate and no event');
    const UNTRUSTED = ACCEPT({ tests: 'node calc.test.js --untrusted' });
    const untrusted = await run(manager, await project('untrusted', { acceptance: UNTRUSTED }), [done], { prompt: 'Look around.' });
    equal([untrusted.gates, checksOf(untrusted.entries).length, untrusted.view.finalText], [['untrusted'], 0, 'Done.'], 'untrusted: a notice, nothing runs, the answer is untouched');
    equal([untrusted.view.proofGate.status, untrusted.view.proofGate.reason, untrusted.view.completionOutcome.requirements, untrusted.view.verificationOutcome.ready], ['skipped', 'untrusted', 'not_assessed', true]);
    const readonly = await run(manager, await project('readonly'), [done], { mode: 'readonly', prompt: 'Look around.' });
    equal([readonly.gates, checksOf(readonly.entries).length, readonly.view.proofGate.reason], [['skipped'], 0, 'readonly']);
    const planned = await run(manager, await project('planned'), [done], { prompt: 'Make a plan.', start: { planMode: true } });
    equal([planned.gates.at(-1), checksOf(planned.entries).length, planned.view.proofGate.reason], ['skipped', 0, 'plan_mode']);
    manager.lifecycleAgent = { kind: 'subagent', role: 'worker' };
    try {
      const sub = await run(manager, await project('sub'), [done], { prompt: 'Do a part.' });
      equal([sub.gates, sub.events[0].reason, checksOf(sub.entries).length, sub.view.proofGate], [['skipped'], 'subagent', 0, null]);
    } finally { manager.lifecycleAgent = null; }
  });

  await section('8. a plain folder; a baseline that was removed; a second chat in its own worktree uses the Hub\'s trust list', async () => {
    const plain = await project('plain', { repository: false });
    const first = await run(manager, plain, [read, answer('Done.'), read, fix, answer('Fixed.')]);
    equal([first.view.completionOutcome.gate, first.view.completionOutcome.checksModified, first.view.proofGate.criteria[0].status], ['passed', false, 'evidenced'], 'no Git repository: the same gate, and an untouched test is known to be untouched');
    const weak = await run(manager, plain, [write('calc.test.js', WEAK), answer('Done.')], { runner: first.agent, id: first.id, prompt: 'Tidy up.' });
    equal([weak.view.completionOutcome.checksModified, weak.view.proofGate.modifications], [true, [{ path: 'calc.test.js', codes: ['not_analyzed'] }]], 'a changed test cannot be compared without its old bytes: it counts as modified');
    const { proofBaseline } = JSON.parse(fsSync.readFileSync(path.join(manager.hubDirectory, 'api-tasks', first.id, 'task.json'), 'utf8'));
    const folder = path.join(manager.hubDirectory, 'proof', 'gate', 'proof', 'baselines');
    for (const key of fsSync.readdirSync(folder)) await fs.rm(path.join(folder, key, `${proofBaseline.id}.json`), { force: true });
    const rebased = await run(manager, plain, [answer('Done.')], { runner: first.agent, id: first.id, prompt: 'Again.' });
    check(rebased.gates.includes('rebaselined'), 'a removed baseline is taken again, and said');
    const held = JSON.parse(fsSync.readFileSync(path.join(manager.hubDirectory, 'api-tasks', first.id, 'task.json'), 'utf8')).proofBaseline.id;
    check(fsSync.readdirSync(folder).some((key) => fsSync.existsSync(path.join(folder, key, `${held}.json`))), '(premise) its baseline is on disk');
    await first.agent.delete(first.id);
    check(!fsSync.readdirSync(folder).some((key) => fsSync.existsSync(path.join(folder, key, `${held}.json`))), 'a deleted conversation takes its baseline with it');
    // an acceptance file that .gitignore leaves out of every tree
    const hidden = await run(manager, await project('ignored', { files: { '.gitignore': '.chatmcp/\n', 'calc.js': 'exports.add = (a, b) => a + b;\n' } }), [done], { prompt: 'Look around.' });
    equal([hidden.view.completionOutcome.gate, hidden.view.completionOutcome.checksModified, hidden.view.proofGate.modifications], ['passed', false, []], 'an ignored acceptance file is neither missing nor deleted: its own bytes are compared');
    const gone = await run(manager, manager.workspace, [() => [tool('run_command', { command: 'node -e "require(\'fs\').rmSync(\'.chatmcp/acceptance.yml\')"', description: 'Remove a file' })], answer('Done.'), answer('Done.')], { runner: hidden.agent, id: hidden.id, prompt: 'Tidy up.' });
    equal([gone.view.completionOutcome.requirements, gone.view.proofGate.reason, gone.view.proofGate.edit], ['failed', 'acceptance_edited', { deleted: true }], 'deleting it is no way out either');

    const shared = await project('shared');
    await manager.selectWorkspace(shared);
    manager.permissions.configure({ mode: 'autonomous', executionPolicy: 'host-review' });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let count = 0;
    const call = (name, args) => ({ type: 'function_call', status: 'completed', name, call_id: `side-${(count += 1)}`, arguments: JSON.stringify(args) });
    const final = (text) => ({ type: 'message', role: 'assistant', phase: 'final', content: [{ type: 'output_text', text }] });
    const queues = {
      main: [async () => { await gate; return final('Main done.'); }, () => final('Main really done.')],
      child: [() => final('Child done.'), () => call('write_file', { path: 'calc.js', content: 'exports.add = (a, b) => a + b;\n', overwrite: true }), () => final('Child fixed it.')],
    };
    const model = {
      ready: () => true, snapshot: () => ({ provider: 'fixture', model: 'gate-fixture' }), state: () => ({ provider: 'fixture', model: 'gate-fixture', configured: true, keySource: 'none' }),
      async respond({ input }) {
        const key = textsOf(input).some((text) => text.includes('[second chat]')) ? 'child' : 'main';
        const step = queues[key].shift();
        return { status: 'completed', output: [step ? await step() : final('Nothing more.')] };
      },
    };
    const runner = new AgentRunner({ manager, provider: model, taskDirectory: path.join(manager.hubDirectory, 'side-tasks'), log: () => {}, toolSelectionMode: 'full' });
    await runner.load();
    const pool = new ConcurrentApiAgent({ bundleRoot, manager, primary: runner, provider: model, directory: path.join(manager.hubDirectory, 'side-chats'), log: () => {} });
    await pool.load?.();
    const stop = approver(manager);
    try {
      const main = await runner.start({ prompt: 'Fix add() in the main chat.' });
      const child = await pool.start({ prompt: '[second chat] Fix add().' });
      const view = await until(() => { const task = pool.get(child.id); return task && ['completed', 'failed'].includes(task.status) ? task : null; }, 'the second chat to end', 60_000);
      equal([view.status, view.completionOutcome?.gate, view.proofGate?.rounds], ['completed', 'passed', 1], 'the second chat is gated in its own worktree, by the Hub\'s trust list');
      release();
      const ended = await until(() => { const task = runner.get(main.id); return task.status !== 'running' ? task : null; }, 'the main chat to end', 60_000);
      equal(ended.completionOutcome.requirements, 'failed', 'and the main chat by its own tree');
    } finally { stop(); release?.(); await pool.shutdown?.(); await runner.shutdown(); }
  });

  await manager.shutdown();
  console.log(`PASS: done-gate in the agent loop (${checks} checks)`);
} finally {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}
