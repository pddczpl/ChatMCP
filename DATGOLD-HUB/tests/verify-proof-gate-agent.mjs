// The done-gate in the agent loop (plan task pod-23, docs/PROOF-GATE.md), on the real HubManager, PermissionGate, LocalTools, proof service, baseline store, check runner,
// hooks and AgentRunner, with real check commands on temporary projects; only the model is scripted. The rules of the gate alone are in verify-proof-gate.mjs, where it runs and
// what interrupts it in verify-proof-gate-places.mjs, a real Hub process in verify-proof-gate-e2e.mjs.
//  1. a pass: the checks are the evidence the receipts show, before the hooks judge the answer; no tree id reaches the model
//  2. fails, then fixes: the host message, the stall counters, the tool calls in between
//  3. fails twice: ends failed, not looping; the notice; the owner's acceptance of an objective does not undo it; a follow-up run starts again
//  4. the model weakens a test: the pass is flagged, the criterion is checks_modified by the pack's own roll-up, in the follow-up run too
//  5. the hooks: after the gate; a block does not run the checks again on the same tree; a hook that changes a file after a pass makes it stale
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { AgentRunner } from '../lib/agent.mjs';
import { createTurnMapper } from '../lib/acp/event-map.mjs';
import { treeKey } from '../lib/agent-progress.mjs';
import { finalPartsOf } from '../lib/final-text.mjs';
import { resolveAcceptance } from '../lib/proof/acceptance.mjs';
import { GATE_EVENT } from '../lib/proof/gate.mjs';
import { ledgerPath } from '../lib/proof/ledger.mjs';
import { rollUpCriteria } from '../lib/proof/pack.mjs';
import {
  ACCEPT, TEST, WEAK, answer, check, checksOf, count, createHub, diff, done, equal, feedback, fix, git, handler, hooksFile, project, read, root, run, say, scripted, section, textsOf, tool, treeIds, trust, write,
} from './support/proof-gate-rig.mjs';

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

  await manager.shutdown();
  console.log(`PASS: done-gate in the agent loop (${count()} checks)`);
} finally {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}
