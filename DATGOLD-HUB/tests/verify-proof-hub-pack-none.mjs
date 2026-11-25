// When the Hub writes no proof pack at the end of a run (plan task P5 pod-33, docs/PROOF-HUB-API.md), with the rig of verify-proof-gate-agent.mjs: the real HubManager,
// AgentRunner, done-gate, baseline store, check runner and proof service on temporary projects; only the model is scripted. What a pack holds is in verify-proof-hub-pack.mjs.
//  1. every reason for no pack that a run can meet, from the closed list, and that the run itself is not touched by it
//  2. a delete, a stop of the Hub and a new run while a pack is built; what a restart finds
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { AgentRunner } from '../lib/agent.mjs';
import { HubPacks, PACK_REASONS } from '../lib/proof/hub-pack.mjs';
import { ledgerPath } from '../lib/proof/ledger.mjs';
import {
  ACCEPT, answer, check, count, createHub, done, equal, fix, git, project, read, root, run, say, scripted, section, sleep, tool, trust, until, write,
} from './support/proof-gate-rig.mjs';

const settled = (agent, id) => until(() => { const { proof } = agent.get(id); return proof && proof.status !== 'building' && proof.reason !== 'run_in_progress' && !agent.packs.running.has(id) ? proof : null; }, 'the proof to settle');
const files = (manager, id) => { try { return fsSync.readdirSync(path.join(manager.hubDirectory, 'proof', 'packs', id)).map((name) => path.join(manager.hubDirectory, 'proof', 'packs', id, name)); } catch { return []; } };
/** A project whose checks pass as it is. */
const good = (name, { files: more = {}, ...options } = {}) => project(name, { ...options, files: { 'calc.js': 'exports.add = (a, b) => a + b;\n', ...more } });
const taskFile = (manager, id) => path.join(manager.hubDirectory, 'api-tasks', id, 'task.json');

try {
  const manager = await createHub('main');
  await trust(manager, ACCEPT());

  const reasons = new Set();
  const none = async (label, ran, reason) => {
    const proof = await settled(ran.agent, ran.id);
    equal([proof.status, proof.reason, proof.digest, proof.verdict, files(manager, ran.id)], ['none', reason, null, null, []], label);
    check(PACK_REASONS.includes(reason), `${reason} is in the closed list`);
    reasons.add(reason);
    return proof;
  };
  await section('1. why a run has no pack: before its final tree', async () => {
    await none('no acceptance file', await run(manager, await project('bare', { acceptance: null }), [done], { prompt: 'Look around.' }), 'no_acceptance');
    await none('an untrusted one', await run(manager, await project('untrusted', { acceptance: ACCEPT({ tests: 'node calc.test.js --untrusted' }) }), [done], { prompt: 'Look around.' }), 'acceptance_untrusted');
    await none('one that does not read', await run(manager, await project('invalid', { acceptance: 'version: 2\n' }), [done], { prompt: 'Look around.' }), 'acceptance_invalid');
    const MANUAL = 'version: 1\ncriteria:\n  - id: look\n    text: "Look."\n    manual:\n      note: "Look at it."\n';
    await trust(manager, MANUAL);
    await none('only manual criteria', await run(manager, await project('manual', { acceptance: MANUAL }), [done], { prompt: 'Look around.' }), 'no_checks');
    await none('Read Only', await run(manager, await project('readonly'), [done], { mode: 'readonly', prompt: 'Look around.' }), 'readonly');
    await none('plan mode', await run(manager, await project('planned'), [done], { prompt: 'Make a plan.', start: { planMode: true } }), 'plan_mode');
    await none('a run that fails', await run(manager, await project('broken'), [], { status: 'failed', prompt: 'Look around.' }), 'run_not_completed');
    const held = await project('cancelled');
    await none('a run that is stopped', await run(manager, held, [async () => { await sleep(15_000); return [say('late')]; }], { status: 'cancelled', prompt: 'Look around.', during: async ({ agent, id, model }) => { await until(() => model.seen.length > 0, 'the model'); await agent.cancel(id); } }), 'run_not_completed');
    manager.lifecycleAgent = { kind: 'subagent', role: 'worker' };
    try { await none('an agent another agent started', await run(manager, await project('sub'), [done], { prompt: 'Do a part.' }), 'subagent'); } finally { manager.lifecycleAgent = null; }
    manager.permissions.configure({ mode: 'autonomous', executionPolicy: 'host-review' });
    const sandboxed = await run(manager, await project('sandboxed'), [() => { manager.permissions.executionPolicy = 'sandbox-only'; return [say('Done.')]; }], { prompt: 'Look around.' });
    await none('sandbox-only', sandboxed, 'sandbox_only');
    manager.permissions.configure({ mode: 'autonomous', executionPolicy: 'host-review' });
    const { shellDisabled } = manager.localTools;
    const shellless = await run(manager, await project('shellless'), [() => { manager.localTools.shellDisabled = true; return [say('Done.')]; }], { prompt: 'Look around.' });
    manager.localTools.shellDisabled = shellDisabled;
    await none('a Hub whose shell is off', shellless, 'no_shell');
    const lost = await run(manager, await good('lost'), [done], { prompt: 'Look around.' });
    await settled(lost.agent, lost.id);
    await fs.rm(path.join(manager.hubDirectory, 'api-tasks', lost.id, 'acceptance.yml'));
    await fs.writeFile(path.join(manager.workspace, '.chatmcp', 'acceptance.yml'), ACCEPT({ other: 'node -v' }));
    const without = await run(manager, manager.workspace, [done], { runner: lost.agent, id: lost.id, prompt: 'Again.' });
    const proof = await settled(without.agent, without.id);
    equal([proof.status, proof.reason, proof.earlier.run], ['none', 'acceptance_lost', 1], 'the acceptance file of the start is gone');
    reasons.add('acceptance_lost');
  });

  await section('1b. why a run has no pack: the baseline, the folder, the final tree, the ledger, the size', async () => {
    const plain = await run(manager, await project('plain', { repository: false }), [read, fix, done]);
    equal(plain.view.proofGate.status, 'passed', '(premise) the gate passes in a plain folder');
    await none('a plain folder has no old bytes', plain, 'not_a_repository');
    const folder = path.join(manager.hubDirectory, 'proof', 'gate', 'proof', 'baselines');
    const current = (id) => JSON.parse(fsSync.readFileSync(taskFile(manager, id), 'utf8')).proofBaseline.id;
    const edit = async (id, change) => { for (const key of fsSync.readdirSync(folder)) { const file = path.join(folder, key, `${current(id)}.json`); if (fsSync.existsSync(file)) { await change(file); return; } } throw new Error('(premise) the baseline of the task is on disk'); };
    let target = null;
    const spoil = (change) => ({ prompt: 'Look around.', during: async ({ agent, id }) => { target = id; await until(() => fsSync.existsSync(taskFile(manager, id)) && agent.get(id).events.some((event) => event.gate === 'armed'), 'the baseline'); spoilt = change; } });
    let spoilt = null;
    const hold = async () => { await until(() => spoilt, 'the test to be ready'); await edit(target, spoilt); spoilt = null; return [say('Done.')]; };
    await none('an edited baseline', await run(manager, await good('spoilt'), [hold], spoil((file) => fs.writeFile(file, fsSync.readFileSync(file, 'utf8').replace('"format":"chatmcp', '"format":"Chatmcp')))), 'baseline_unreadable');
    await none('a removed baseline', await run(manager, await good('removed'), [hold], spoil((file) => fs.rm(file))), 'baseline_unreadable');
    await none('a baseline whose objects are gone', await run(manager, await project('objects'), [read, async ({ last }) => { await until(() => spoilt, 'ready'); return fix({ last }); }, hold], spoil(async (file) => { await fs.rm(file.replace(/\.json$/, '.git'), { recursive: true, force: true }); })), 'old_bytes_unreadable');
    // a process that goes on writing: the tree at the build is not the tree the run ended on
    const WRITER = "const { spawn } = require('child_process');\nspawn(process.execPath, ['-e', \"const fs = require('fs'); let n = 0; const t = setInterval(() => { fs.writeFileSync('notes.txt', String(n++)); if (n > 2000) clearInterval(t); }, 25)\"], { cwd: __dirname, detached: true, stdio: 'ignore' }).unref();\n";
    const writer = await run(manager, await good('writer', { files: { 'writer.js': WRITER } }), [() => [tool('run_command', { command: 'node writer.js', description: 'Start a helper' })], done], { prompt: 'Look around.' });
    await none('the files changed after the end of the run', writer, 'final_tree_changed');
    // the ledger is edited while the run goes on
    const broken = await run(manager, await good('ledger'), [hold], { prompt: 'Look around.', status: 'completed', during: async ({ id }) => {
      target = id;
      await until(() => fsSync.existsSync(ledgerPath(manager.hubDirectory, id)), 'the ledger');
      spoilt = async () => { const file = ledgerPath(manager.hubDirectory, id); const text = fsSync.readFileSync(file, 'utf8'); await fs.writeFile(file, text.replace('task_start', 'task_xtart')); };
    } }).catch((error) => { if (!/verifies/.test(String(error.message))) throw error; return null; });
    check(broken === null, '(premise) the ledger does not verify');
    const brokenTask = [...new Set(fsSync.readdirSync(path.join(manager.hubDirectory, 'api-tasks')))].includes(target);
    check(brokenTask, 'the task is there');
    const saved = await until(() => { const { proof } = JSON.parse(fsSync.readFileSync(taskFile(manager, target), 'utf8')); return proof?.status === 'none' && proof.reason !== 'run_in_progress' ? proof : null; }, 'its proof');
    check(['final_tree_unknown', 'ledger_broken'].includes(saved.reason), `an edited ledger: no pack (${saved.reason})`);
    reasons.add(saved.reason);
    const big = await run(manager, await good('big'), [write('big.txt', 'x'.repeat(400_000)), done], { prompt: 'Look around.', start: {}, during: async ({ agent }) => { agent.packs.limits = { ...agent.packs.limits, maxBytes: 100_000 }; } });
    await none('a pack over the limit', big, 'pack_too_large');
    const patch = await run(manager, await good('patch'), [write('big.txt', 'x'.repeat(400_000)), done], { prompt: 'Look around.', during: async ({ agent }) => { agent.packs.limits = { ...agent.packs.limits, maxPatchBytes: 100_000 }; } });
    await none('a patch over the limit', patch, 'patch_too_large');
    const late = await run(manager, await good('late'), [done], { prompt: 'Look around.', during: async ({ agent }) => { agent.packs.limits = { ...agent.packs.limits, timeoutMs: 1 }; } });
    await none('a build that takes too long', late, 'timeout');
    // the build that was given up comes to its end behind it, and removes its scratch files
    const scratchFiles = path.join(manager.hubDirectory, 'proof', 'packs', 'scratch');
    await until(() => fsSync.readdirSync(scratchFiles).length === 0, 'the build that was given up to clean up', 30_000);
    // a file where the folder of the packs should be
    const packs = path.join(manager.hubDirectory, 'proof', 'packs');
    await fs.mkdir(packs, { recursive: true });
    await fs.rename(packs, `${packs}-aside`);
    await fs.writeFile(packs, 'not a folder');
    const unwritable = await run(manager, await good('unwritable'), [done], { prompt: 'Look around.' });
    equal([(await settled(unwritable.agent, unwritable.id)).reason, unwritable.view.status], ['write_failed', 'completed'], 'a pack that cannot be written: a reason, and the task is not touched');
    reasons.add('write_failed');
    await fs.rm(packs);
    await fs.rename(`${packs}-aside`, packs);
    // a registered secret that is a folder of a check: the masked statement would not verify, so it is not written
    const SUB = `version: 1\ncriteria:\n  - id: tests\n    text: "In a folder."\n    checks:\n      - run: "node -v"\n        cwd: secretfolder9\n`;
    await trust(manager, SUB);
    manager.registerSecret('secretfolder9');
    const masked = await run(manager, await project('masked', { acceptance: SUB, files: { 'package.json': '{}\n' } }).then(async (dir) => { await fs.mkdir(path.join(dir, 'secretfolder9')); await fs.writeFile(path.join(dir, 'secretfolder9', 'a.txt'), 'a'); git(dir, ['add', '-A']); git(dir, ['commit', '-q', '-m', 'sub']); return dir; }), [done], { prompt: 'Look around.' });
    await none('a pack that would not verify', masked, 'pack_not_verified');
    manager.secrets = manager.secrets.filter((value) => value !== 'secretfolder9');
    // a data folder of the Hub inside the workspace
    const nest = await project('nest');
    const inner = await createHub('nest/inner');
    await trust(inner, ACCEPT());
    const within = await run(inner, nest, [read, fix, done]);
    const proof = await settled(within.agent, within.id);
    equal([proof.status, proof.reason], ['none', 'state_inside_workspace']);
    reasons.add('state_inside_workspace');
    await inner.shutdown();
  });

  await section('1c. the scratch files of a Hub that died are removed, those of a build that goes on are not', async () => {
    const scratch = path.join(manager.hubDirectory, 'proof', 'packs', 'scratch');
    const [old, fresh] = [path.join(scratch, 'work-old'), path.join(scratch, 'work-fresh')];
    for (const folder of [old, fresh]) { await fs.mkdir(folder, { recursive: true }); await fs.writeFile(path.join(folder, 'x'), 'x'); }
    const past = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await fs.utimes(old, past, past);
    const swept = await run(manager, await good('swept'), [done], { prompt: 'Look around.' });
    equal((await settled(swept.agent, swept.id)).status, 'ready');
    check(!fsSync.existsSync(old), 'the old one is gone');
    // (a build that was given up above removes its own when it gets to its end)
    await until(() => fsSync.readdirSync(scratch).join() === 'work-fresh', 'the builds to leave none of their own', 20_000);
    await fs.rm(fresh, { recursive: true });
  });

  await section('2. delete, stop and a new run while a pack is built; a restart', async () => {
    // a build that does not end, and does not look whether it was given up
    const forever = { build: () => new Promise(() => {}) };
    const slow = { during: async ({ agent }) => { agent.packs.deps = { ...agent.packs.deps, ...forever }; }, prompt: 'Look around.' };
    const deleted = await run(manager, await good('deleted'), [done], slow);
    equal(deleted.agent.get(deleted.id).proof.status, 'building');
    check(fsSync.existsSync(path.dirname(taskFile(manager, deleted.id))), '(premise) the task is on disk');
    const at = Date.now();
    await deleted.agent.delete(deleted.id);
    check(Date.now() - at < 3000, 'a delete does not wait for the build');
    await sleep(300);
    equal([fsSync.existsSync(path.dirname(taskFile(manager, deleted.id))), files(manager, deleted.id)], [false, []], 'and nothing comes back after it');
    const stopped = await run(manager, await good('stopped'), [done], slow);
    const began = Date.now();
    await stopped.agent.shutdown();
    check(Date.now() - began < 3000, 'a Hub that stops does not wait for the build');
    equal(stopped.agent.get(stopped.id).proof.reason, 'hub_stopped');
    reasons.add('hub_stopped');
    const onDisk = JSON.parse(fsSync.readFileSync(taskFile(manager, stopped.id), 'utf8')).proof;
    equal([onDisk.status, onDisk.reason], ['none', 'hub_stopped'], 'and it is saved');
    // a new run of the same task while its pack is built
    const twice = await run(manager, await good('twice'), [done], slow);
    twice.agent.packs.deps = { ...twice.agent.packs.deps, build: new HubPacks({ manager, gate: twice.agent.doneGate }).deps.build };
    const second = await run(manager, manager.workspace, [done], { runner: twice.agent, id: twice.id, prompt: 'Again.' });
    const proof = await settled(second.agent, second.id);
    equal([proof.status, proof.run, proof.earlier], ['ready', 2, null], 'the later run has its pack, the build of the earlier one is given up');
    // a Hub that died: what a task file says of a pack that was being built, or of a run that went on
    for (const state of [{ status: 'building', reason: null }, { status: 'none', reason: 'run_in_progress' }]) {
      const data = JSON.parse(fsSync.readFileSync(taskFile(manager, stopped.id), 'utf8'));
      await fs.writeFile(taskFile(manager, stopped.id), JSON.stringify({ ...data, proof: { ...data.proof, ...state } }));
      const again = new AgentRunner({ manager, provider: scripted([]), taskDirectory: path.join(manager.hubDirectory, 'api-tasks'), log: () => {} });
      await again.load();
      equal([again.get(stopped.id).proof.status, again.get(stopped.id).proof.reason], ['none', 'interrupted'], `after a restart: ${state.status}/${state.reason}`);
    }
    reasons.add('interrupted');
    // an old task
    const data = JSON.parse(fsSync.readFileSync(taskFile(manager, stopped.id), 'utf8'));
    delete data.proof;
    await fs.writeFile(taskFile(manager, stopped.id), JSON.stringify(data));
    const old = new AgentRunner({ manager, provider: scripted([]), taskDirectory: path.join(manager.hubDirectory, 'api-tasks'), log: () => {} });
    await old.load();
    equal([old.get(stopped.id).proof, old.state().tasks.find((task) => task.id === stopped.id).proof], [null, null], 'a task of an older Hub has no summary');
  });

  equal([...reasons].filter((reason) => !PACK_REASONS.includes(reason)), [], 'every reason met here is in the closed list');
  await manager.shutdown();
  console.log(`PASS: runs without a proof pack (${count()} checks, ${reasons.size} reasons)`);
} finally {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}
