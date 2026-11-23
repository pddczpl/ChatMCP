// The done-gate in the agent loop, where it runs and what interrupts it (plan task pod-23, docs/PROOF-GATE.md), with the rig of verify-proof-gate-agent.mjs: the real HubManager,
// AgentRunner, check runner, baseline store and hooks, a scripted model.
//  1. a step limit; a message queued while the checks run; a stop while a check runs (its process is gone, the attempt is recorded)
//  2. no gate: no acceptance file, an untrusted one, Read Only, plan mode, an agent another agent started
//  3. checks-only; a plain folder; a removed baseline; an ignored and a deleted acceptance file
//  4. a second chat in its own worktree (the owner's trust list is the Hub's), with core.autocrlf off and on
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { AgentRunner } from '../lib/agent.mjs';
import { ConcurrentApiAgent } from '../lib/concurrent-api-agent.mjs';
import {
  ACCEPT, WEAK, answer, approver, bundleRoot, check, checksOf, count, createHub, diff, done, equal, fix, handler, hooksFile, project, read, root, run, say, section, textsOf, tool, trust, until, write,
} from './support/proof-gate-rig.mjs';

try {
  const manager = await createHub('main');
  await trust(manager, ACCEPT());

  await section('1. a step limit, a message queued while the checks run, a stop while a check runs', async () => {
    const dir = await project('limits');
    const limited = await run(manager, dir, [answer('Done.')], { start: { maxSteps: 1 } });
    equal([limited.view.status, limited.view.completionOutcome.requirements, limited.view.proofGate.stopped], ['completed', 'failed', 'no_turn_left'], 'no further turn: failed at once, and the answer is not lost to the step limit');
    check(/no model turn was left/.test(limited.view.finalText));
    const broken = await run(manager, dir, [], { runner: limited.agent, id: limited.id, prompt: 'Again.', status: 'failed' });
    equal(broken.view.proofGate, null, 'a run that ends in an error is not judged, and does not keep the judgment of the run before');

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

  await section('2. no gate: no acceptance file, an untrusted one, Read Only, plan mode, an agent that another agent started', async () => {
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

  await section('3. checks-only (the scan budget of the proof service); a plain folder; a baseline that was removed; an ignored and a deleted acceptance file', async () => {
    // two-second scans: the proof service stops scanning around calls, so the Hub knows no tree until the gate takes its own
    let clock = 0;
    manager.proofOptions = { clock: () => (clock += 2000) };
    const slow = await run(manager, await project('checks-only'), [read, fix, write('notes.txt', 'more notes'), diff, done]);
    manager.proofOptions = null;
    check(slow.entries.some((entry) => entry.type === 'uncertain' && entry.record.reason === 'checks_only'), '(premise) the run switched to checks-only');
    equal([slow.view.completionOutcome.gate, slow.view.proofGate.criteria[0].status, slow.view.progress.verifiedChecks.length], ['passed', 'evidenced', 1], 'checks-only: the gate runs the same, and its check is a fresh receipt');
    equal(slow.view.verificationOutcome.ready, false, 'what the calls before it left without trees stays of unknown freshness');
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
    equal([rebased.view.completionOutcome.checksModified, rebased.view.proofGate.modifications], [true, [{ path: 'calc.test.js', codes: ['not_analyzed'] }]], 'and what was modified before it is still said');
    const held = JSON.parse(fsSync.readFileSync(path.join(manager.hubDirectory, 'api-tasks', first.id, 'task.json'), 'utf8')).proofBaseline.id;
    check(fsSync.readdirSync(folder).some((key) => fsSync.existsSync(path.join(folder, key, `${held}.json`))), '(premise) its baseline is on disk');
    await first.agent.delete(first.id);
    check(!fsSync.readdirSync(folder).some((key) => fsSync.existsSync(path.join(folder, key, `${held}.json`))), 'a deleted conversation takes its baseline with it');
    // an acceptance file that .gitignore leaves out of every tree
    const hidden = await run(manager, await project('ignored', { files: { '.gitignore': '.chatmcp/\n', 'calc.js': 'exports.add = (a, b) => a + b;\n' } }), [done], { prompt: 'Look around.' });
    equal([hidden.view.completionOutcome.gate, hidden.view.completionOutcome.checksModified, hidden.view.proofGate.modifications], ['passed', false, []], 'an ignored acceptance file is neither missing nor deleted: its own bytes are compared');
    const gone = await run(manager, manager.workspace, [() => [tool('run_command', { command: 'node -e "require(\'fs\').rmSync(\'.chatmcp/acceptance.yml\')"', description: 'Remove a file' })], answer('Done.'), answer('Done.')], { runner: hidden.agent, id: hidden.id, prompt: 'Tidy up.' });
    equal([gone.view.completionOutcome.requirements, gone.view.proofGate.reason, gone.view.proofGate.edit], ['failed', 'acceptance_edited', { deleted: true }], 'deleting it is no way out either');

  });

  for (const autocrlf of [false, true]) {
    await section(`4. a second chat in its own worktree uses the Hub's trust list, with core.autocrlf=${autocrlf} (the default of Git for Windows is true: the worktree's acceptance file has other bytes than the trusted one)`, async () => {
      // The worktree is made by the Hub's own Git, which reads the machine's configuration: this run's is the test's, on every system.
      const config = path.join(root, `autocrlf-${autocrlf}.gitconfig`);
      await fs.writeFile(config, `[core]\n\tautocrlf = ${autocrlf}\n`);
      const before = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM };
      Object.assign(process.env, { GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1' });
      try {
        const shared = await project(`shared-${autocrlf}`);
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
        const runner = new AgentRunner({ manager, provider: model, taskDirectory: path.join(manager.hubDirectory, `side-tasks-${autocrlf}`), log: () => {}, toolSelectionMode: 'full' });
        await runner.load();
        const pool = new ConcurrentApiAgent({ bundleRoot, manager, primary: runner, provider: model, directory: path.join(manager.hubDirectory, `side-chats-${autocrlf}`), log: () => {} });
        await pool.load?.();
        const stop = approver(manager);
        try {
          const main = await runner.start({ prompt: 'Fix add() in the main chat.' });
          const child = await pool.start({ prompt: '[second chat] Fix add().' });
          const view = await until(() => { const task = pool.get(child.id); return task && ['completed', 'failed'].includes(task.status) ? task : null; }, 'the second chat to end', 60_000);
          const onDisk = await fs.readFile(path.join(view.worktree, '.chatmcp', 'acceptance.yml'), 'utf8');
          equal(onDisk, autocrlf ? ACCEPT().replaceAll('\n', '\r\n') : ACCEPT(), `(premise) the worktree was checked out with core.autocrlf=${autocrlf}`);
          equal([view.status, view.completionOutcome?.gate, view.proofGate?.rounds, view.completionOutcome?.checksModified], ['completed', 'passed', 1, false], 'the second chat is gated in its own worktree, by the Hub\'s trust list');
          release();
          const ended = await until(() => { const task = runner.get(main.id); return task.status !== 'running' ? task : null; }, 'the main chat to end', 60_000);
          equal(ended.completionOutcome.requirements, 'failed', 'and the main chat by its own tree');
        } finally { stop(); release?.(); await pool.shutdown?.(); await runner.shutdown(); }
      } finally {
        for (const [name, value] of Object.entries(before)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
    });
  }

  await manager.shutdown();
  console.log(`PASS: done-gate, where it runs (${count()} checks)`);
} finally {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}
