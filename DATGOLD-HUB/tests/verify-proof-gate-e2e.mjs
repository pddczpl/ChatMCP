// The done-gate end to end (plan task pod-23, docs/PROOF-GATE.md): a real Hub process (hub.mjs on a free port, never 3007) with its own state folder, the real
// `chatmcp verify trust` command line, and a scripted model behind the strict Chat Completions mock (no live model). The four scenarios of the plan:
//   1. the checks pass the first time
//   2. they fail, the agent fixes the code, they pass
//   3. they fail twice: the task ends with requirements "failed", it does not loop
//   4. the model edits a test to pass: the outcome and the criterion say the checks were modified
// and: an acceptance file nobody trusted gates nothing (the model mock sees one request), the trust of the command line reaches a running Hub, a Hub killed while a check
// runs (the next run of the conversation is gated on the same baseline).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { runScenario } from './e2e/harness.mjs';
import { HUB_ROOT, cleanEnvironment, connectModel, continueTask, setMode, startTask, waitFor, waitForState } from './e2e/hub-process.mjs';
import { call, say, shaOf } from './e2e/scenarios.mjs';
import { gitInit } from './e2e/fixtures.mjs';
import { ledgerPath } from '../lib/proof/ledger.mjs';
import { readLedgerEntries } from '../lib/proof/service.mjs';

const BUGGY = 'exports.add = (a, b) => a - b;\n';
const TEST = "const assert = require('node:assert');\nconst { add } = require('./calc.js');\nassert.equal(add(2, 3), 5);\nassert.equal(add(1, 1), 2);\nconsole.log('OK 2 tests');\n";
const WEAK = "const assert = require('node:assert');\nconst { add } = require('./calc.js');\nassert.ok(add);\nconsole.log('OK');\n";
const ACCEPT = 'version: 1\ncriteria:\n  - id: tests\n    text: "The tests of the calculator pass."\n    checks:\n      - run: "node calc.test.js"\n  - id: look\n    text: "The owner reads the diff."\n    manual:\n      note: "Read the diff."\n';
const GATE = '[Done-gate ·';
const gatesIn = (ctx) => ctx.users.filter((text) => text.startsWith(GATE)).length;
const fixSteps = (ctx, text) => {
  if (ctx.turn === 0) return call('read_file', { path: 'calc.js' });
  if (ctx.turn === 1) return call('edit_file', { path: 'calc.js', old_string: 'a - b', new_string: 'a + b', expected_sha256: shaOf(ctx.last) });
  return say(text);
};
const weaken = (ctx, text) => (ctx.turn === 0 ? call('write_file', { path: 'calc.test.js', content: WEAK, overwrite: true }) : say(text));
/** What the model does is decided by the person's request: it is the last user text that is not the Hub's. */
const asked = (ctx, word) => ctx.users.some((text) => text.includes(word));
const scenarios = {
  gate(ctx) {
    const after = gatesIn(ctx);
    if (asked(ctx, '[passes]')) return fixSteps(ctx, 'Fixed add().');
    if (asked(ctx, '[fixes]')) return after ? fixSteps(ctx, 'Now it is fixed.') : say('I think it is done.');
    if (asked(ctx, '[twice]')) return say(after ? 'It is really done.' : 'It is done.');
    if (asked(ctx, '[weakens]')) return after ? weaken(ctx, 'All checks pass now.') : say('It is done.');
    return say('Nothing to do.');
  },
};

await runScenario({
  name: 'proof-gate',
  summary: 'the owner\'s trusted checks run on the final answer: passes, fails then fixes, fails twice, a weakened test, no trust, a Hub killed during a check',
}, async (t) => {
  const project = path.join(t.scratch, 'calc-app');
  const reset = () => {
    fs.mkdirSync(path.join(project, '.chatmcp'), { recursive: true });
    fs.writeFileSync(path.join(project, 'calc.js'), BUGGY);
    fs.writeFileSync(path.join(project, 'calc.test.js'), TEST);
  };
  reset();
  fs.writeFileSync(path.join(project, '.chatmcp', 'acceptance.yml'), ACCEPT);
  gitInit(project, t.scratch);
  const mock = await t.mock({ scenario: 'gate', scenarios, strict: true, keepBodies: true });
  let hub = await t.hub({ project });
  t.check(hub.port !== 3007, 'the Hub is not on the owner\'s port');
  await connectModel(hub, mock);
  await setMode(hub, 'autonomous');
  const cli = (...args) => {
    const result = spawnSync(process.execPath, [path.join(HUB_ROOT, 'bin', 'chatmcp.mjs'), 'verify', ...args, '--json', '--workspace', project], {
      cwd: project, encoding: 'utf8', windowsHide: true, env: cleanEnvironment(t.scratch, { CHATMCP_STATE_DIR: hub.stateDir }),
    });
    return { code: result.status, json: JSON.parse(result.stdout) };
  };
  const requests = () => mock.state.requests.length;
  /** One task to its end: {task (the full one), asked: how many model requests it made, checks: the check receipts of its ledger, gates}. */
  async function play(prompt, { id = null } = {}) {
    const before = requests();
    const started = id ? await continueTask(hub, id, prompt) : await startTask(hub, prompt);
    await waitForState(hub, started.id, ['completed', 'failed', 'paused', 'cancelled'], { timeoutMs: 60_000 });
    const task = await hub.task(started.id);
    const { report, entries } = await readLedgerEntries(ledgerPath(hub.stateDir, started.id));
    t.check(report.ok, 'the ledger of the task verifies', JSON.stringify(report));
    const gates = task.events.filter((event) => event.type === 'proof_gate').map((event) => event.gate);
    return { id: started.id, task, asked: requests() - before, checks: entries.filter((entry) => entry.type === 'check').map((entry) => entry.record), gates };
  }

  // ---- nobody trusted the file yet -----------------------------------------------------------------------------------------
  const untrusted = await play('[twice] add() is wrong, fix it.');
  t.equal([untrusted.gates, untrusted.checks.length, untrusted.asked], [['untrusted'], 0, 1], 'an untrusted acceptance file: a notice, no check runs, the agent is not sent back');
  t.equal([untrusted.task.finalText, untrusted.task.completionOutcome.requirements, untrusted.task.proofGate.reason], ['It is done.', 'not_assessed', 'untrusted'], 'the outcome is what it was before the gate existed');

  // ---- the owner trusts it on the command line, while the Hub runs ----------------------------------------------------------
  const sha256 = cli('trust').json.data.sha256;
  t.equal(cli('trust', '--sha256', sha256).json.code, 'trusted', 'chatmcp verify trust writes the Hub\'s own trust list');

  const passes = await play('[passes] add() is wrong, fix it.');
  t.equal([passes.task.state, passes.gates, passes.checks.map((record) => record.exit)], ['completed', ['armed', 'running', 'passed'], [0]], '1. passes the first time: the check ran once, on the final tree');
  t.equal([passes.task.completionOutcome.gate, passes.task.completionOutcome.checksModified, passes.task.proofGate.rounds], ['passed', false, 0], '1. the outcome says the gate passed');
  t.equal(passes.task.proofGate.criteria.map((row) => [row.id, row.status]), [['tests', 'evidenced'], ['look', 'unverified']], '1. the criterion is evidenced; the manual one stays the owner\'s');
  t.equal(passes.task.finalText, 'Fixed add().', '1. a clean pass adds nothing to the answer');

  reset();
  const fixes = await play('[fixes] add() is wrong, fix it.');
  t.equal([fixes.gates, fixes.checks.map((record) => record.exit)], [['armed', 'running', 'failed', 'running', 'passed'], [1, 0]], '2. fails, then fixes: the check ran twice');
  t.equal([fixes.task.completionOutcome.gate, fixes.task.proofGate.rounds, fixes.task.finalText], ['passed', 1, 'Now it is fixed.'], '2. the task ends on the fixed answer');
  const sent = JSON.stringify(mock.state.requests.slice(-3).map((request) => request.body?.messages ?? []));
  t.check(sent.includes('exit 1 (expected 0)') && sent.includes('node calc.test.js') && sent.includes('AssertionError'), '2. the model was given the exit code, the command and the end of its output');
  t.check(mock.state.rejections.length === 0, '2. the strict mock refused no request (the host message keeps the protocol\'s order)', JSON.stringify(mock.state.rejections).slice(0, 300));
  const trees = fixes.checks.flatMap((record) => [record.treeBefore.tree, record.treeAfter.tree]);
  t.check(trees.every((tree) => !JSON.stringify(mock.state.requests.map((request) => request.body)).includes(tree)), '2. no tree id was sent to the model');

  reset();
  const twice = await play('[twice] add() is wrong, fix it.');
  t.equal([twice.task.state, twice.gates, twice.asked], ['completed', ['armed', 'running', 'failed', 'running', 'failed'], 2], '3. fails twice: two model requests, no loop');
  t.equal([twice.task.completionOutcome.requirements, twice.task.completionOutcome.gate, twice.task.verificationOutcome.ready], ['failed', 'failed', false], '3. requirements: failed');
  t.check(/^It is really done\.\n\n\[Done-gate notice\] This task is NOT done: .*tests: exit 1/.test(twice.task.finalText), '3. with a prominent notice', twice.task.finalText);
  const listed = (await hub.state()).agent.tasks.find((task) => task.id === twice.id);
  t.equal([listed.completionOutcome.requirements, listed.proofGate.status], ['failed', 'failed'], '3. the task list says it too');
  t.check((await hub.request('GET', `/api/tasks/${twice.id}/report`)).text.includes('"requirements": "failed"'), '3. and the report');

  reset();
  const weakens = await play('[weakens] add() is wrong, fix it.');
  t.equal([weakens.gates, weakens.checks.map((record) => record.exit)], [['armed', 'running', 'failed', 'running', 'passed'], [1, 0]], '4. the model edits the test until the check passes');
  t.equal([weakens.task.completionOutcome.gate, weakens.task.completionOutcome.checksModified, weakens.task.completionOutcome.requirements], ['passed', true, 'unverified'], '4. the outcome flags it: checks modified, nothing verified');
  t.equal([weakens.task.proofGate.criteria[0].status, weakens.task.proofGate.modifications], ['checks_modified', [{ path: 'calc.test.js', codes: ['assertions_removed'] }]], '4. the criterion is checks_modified (the pack\'s roll-up), with the file and why');
  t.check(/\[Done-gate notice\] .*checks were modified during the task \(calc\.test\.js: assertions_removed\)/.test(weakens.task.finalText), '4. and the answer says so', weakens.task.finalText);

  // ---- a Hub killed while a check runs -------------------------------------------------------------------------------------
  reset();
  const SLOW = ACCEPT.replace('node calc.test.js', 'node slow.js && node calc.test.js');
  fs.writeFileSync(path.join(project, 'slow.js'), "const fs = require('node:fs'); const path = require('node:path'); if (!fs.existsSync(path.join(__dirname, '..', 'go'))) { fs.writeFileSync(path.join(__dirname, '..', 'slow.started'), '1'); setTimeout(() => process.exit(0), 30000); }\n");
  fs.writeFileSync(path.join(project, '.chatmcp', 'acceptance.yml'), SLOW);
  cli('trust', '--sha256', cli('trust').json.data.sha256);
  const started = await startTask(hub, '[twice] add() is wrong, fix it.');
  await waitFor(() => fs.existsSync(path.join(t.scratch, 'slow.started')), { timeoutMs: 30_000, label: 'the check to start' });
  t.equal((await hub.task(started.id)).state, 'verifying', 'the task shows as verifying while a check runs');
  hub.killTree();
  await hub.exited;
  fs.writeFileSync(path.join(t.scratch, 'go'), '1');
  hub = await t.hub({ project, logName: 'hub-2.log', stateDir: hub.stateDir });
  const interrupted = await hub.task(started.id);
  t.equal([interrupted.state, interrupted.proofGate, interrupted.finalText], ['paused', null, ''], 'a Hub killed during a check: the task is paused, nothing was judged');
  const resumed = await play('[twice] go on.', { id: started.id });
  t.equal([resumed.task.completionOutcome.requirements, resumed.task.proofGate.rounds], ['failed', 2], 'the next run of the conversation is gated, with rounds of its own');
  t.equal(resumed.gates.filter((gate) => gate === 'rebaselined' || gate === 'baseline_unavailable'), [], 'on the baseline its first run took');
});
