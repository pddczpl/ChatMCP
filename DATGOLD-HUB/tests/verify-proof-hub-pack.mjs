// The packs the Hub writes at the end of a run (plan task P5 pod-33, docs/PROOF-HUB-API.md), with the rig of verify-proof-gate-agent.mjs: the real HubManager, AgentRunner,
// done-gate, baseline store, check runner and proof service on temporary projects, only the model is scripted; the real `chatmcp verify check` on what was written. The HTTP
// routes are in verify-proof-http.mjs, a real Hub process.
//  1. what a pack holds: the run's own final tree, the bytes the run was held to, the gate's report on the checks, the cost; the command line accepts it
//  2. every reason for no pack that a run can meet, from the closed list
//  3. a pack never slows or fails a run: it is built after the task is free, in bounded time, and gives way to a run that needs a baseline
//  4. a delete, a stop of the Hub and a new run while a pack is built; what a restart finds
//  5. the folder of the packs: ids, names, sizes, leftovers; the summary of a task file somebody edited
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentRunner } from '../lib/agent.mjs';
import { ConcurrentApiAgent } from '../lib/concurrent-api-agent.mjs';
import { readPackFile } from '../lib/proof/cli/check.mjs';
import { HubPacks, PACK_REASONS, PACK_LIMITS, PackStore, loadedProof, publicProof } from '../lib/proof/hub-pack.mjs';
import { ledgerPath } from '../lib/proof/ledger.mjs';
import {
  ACCEPT, WEAK, answer, approver, bundleRoot, check, count, createHub, diff, done, equal, fix, git, project, read, root, run, say, scripted, section, sleep, textsOf, tool, trust, until, write,
} from './support/proof-gate-rig.mjs';

const settled = (agent, id) => until(() => { const { proof } = agent.get(id); return proof && proof.status !== 'building' && proof.reason !== 'run_in_progress' ? proof : null; }, 'the proof to settle');
const files = (manager, id) => { try { return fsSync.readdirSync(path.join(manager.hubDirectory, 'proof', 'packs', id)).map((name) => path.join(manager.hubDirectory, 'proof', 'packs', id, name)); } catch { return []; } };
const packOf = (manager, id) => readPackFile(fsSync.readFileSync(files(manager, id)[0]));
const cli = (file) => {
  const result = spawnSync(process.execPath, [path.join(bundleRoot, 'bin', 'chatmcp.mjs'), 'verify', 'check', file, '--json'], { encoding: 'utf8', windowsHide: true, env: { ...process.env, CHATMCP_STATE_DIR: path.join(root, 'cli-state') } });
  return JSON.parse(result.stdout).code;
};
const taskFile = (manager, id) => path.join(manager.hubDirectory, 'api-tasks', id, 'task.json');
const codes = (pack) => pack.statement.predicate.criteria.map((row) => [row.id, row.status, [...new Set(row.reasons.map((reason) => reason.code))]]);

try {
  const manager = await createHub('main');
  await trust(manager, ACCEPT());

  let passing;
  await section('1. a pack: the final tree of the run, the bytes it was held to, the model and the cost; the command line accepts it; the next run covers the conversation', async () => {
    const dir = await project('pass');
    passing = await run(manager, dir, [read, fix, diff, done]);
    const proof = await settled(passing.agent, passing.id);
    equal([proof.status, proof.reason, proof.run, proof.verdict, proof.coverage, proof.checksModified], ['ready', null, 1, 'evidenced', 'task', false]);
    const pack = packOf(manager, passing.id);
    const end = passing.entries.findLast((entry) => entry.type === 'tree' && entry.record.event === 'task_end').record.tree;
    const start = passing.entries.find((entry) => entry.type === 'tree' && entry.record.event === 'task_start').record.tree;
    const { predicate, subject } = pack.statement;
    equal([subject[0].digest.gitTree, subject[1].digest.gitTree], [start.tree, end.tree], 'from the tree the task started on to the tree the run ended on');
    equal([predicate.trees.after.treeAlgorithm, predicate.baseCommit], [end.treeAlgorithm, git(dir, ['rev-parse', 'HEAD']).trim()]);
    equal(pack.files['acceptance.yml'].toString(), ACCEPT(), 'the acceptance file of the run');
    check(pack.files['change.diff'].toString().includes('+exports.add = (a, b) => a + b;'), 'the patch');
    check(pack.files['ledger.jsonl'].equals(fsSync.readFileSync(ledgerPath(manager.hubDirectory, passing.id))), 'the whole ledger of the task, up to the end of the run');
    equal([predicate.agent.name, predicate.model, predicate.cost, predicate.acceptance.trusted, predicate.acceptance.edited, predicate.checkChanges], ['DatGold', { provider: 'scripted', id: 'scripted-1', profileRevision: null }, 'unknown', true, false, { reported: true, checksModified: false }]);
    equal([pack.digest, proof.digest, cli(files(manager, passing.id)[0])], [proof.digest, pack.digest, 'pack_verified']);
    const event = passing.agent.get(passing.id).events.findLast((item) => item.type === 'proof_pack');
    equal([event.pack, event.reason, event.run, event.verdict], ['ready', null, 1, 'evidenced'], 'an event says so');
    const saved = JSON.parse(fsSync.readFileSync(taskFile(manager, passing.id), 'utf8')).proof;
    equal([saved.status, saved.pack.digest], ['ready', proof.digest], 'and the task file');
    // the gate's status and the pack's agree
    equal(codes(pack), [['tests', 'evidenced', []]]);
    const again = await run(manager, dir, [write('notes.txt', 'more'), done], { runner: passing.agent, id: passing.id, prompt: 'Add a note.' });
    const second = await settled(again.agent, again.id);
    equal([second.run, second.coverage, files(manager, again.id).length], [2, 'task', 1], 'one pack per task: the latest');
    const later = packOf(manager, again.id);
    equal([later.statement.subject[0].digest.gitTree, later.statement.predicate.ledger.checks], [start.tree, 2], 'from the start of the conversation, with the receipts of both runs');
  });

  await section('1b. modified checks, an edited acceptance file, an ignored one, a removed baseline: the pack says what the gate says', async () => {
    const weak = await run(manager, await project('weak'), [write('calc.test.js', WEAK), done]);
    const weakProof = await settled(weak.agent, weak.id);
    equal([weak.view.proofGate.checksModified, weakProof.verdict, weakProof.checksModified, weakProof.counts.checks_modified], [true, 'checks_modified', true, 1]);
    equal(cli(files(manager, weak.id)[0]), 'pack_not_evidenced');
    // the baseline is gone and taken again: what was modified before it is still said
    const { proofBaseline } = JSON.parse(fsSync.readFileSync(taskFile(manager, weak.id), 'utf8'));
    const folder = path.join(manager.hubDirectory, 'proof', 'gate', 'proof', 'baselines');
    for (const key of fsSync.readdirSync(folder)) await fs.rm(path.join(folder, key, `${proofBaseline.id}.json`), { force: true });
    const rebased = await run(manager, manager.workspace, [done], { runner: weak.agent, id: weak.id, prompt: 'Again.' });
    check(rebased.gates.includes('rebaselined'), '(premise) the baseline was taken again');
    const rebasedProof = await settled(weak.agent, weak.id);
    equal([rebasedProof.verdict, rebasedProof.coverage, rebasedProof.checksModified], ['checks_modified', 'baseline', true], 'a later baseline: the modification is carried, and the summary says the pack does not cover the whole task');
    equal(packOf(manager, weak.id).statement.predicate.cost, 'unknown', 'no cost for a part of the task');
    // unknown before the new baseline: never evidenced
    const unknown = await run(manager, await project('unknown'), [read, fix, done]);
    await settled(unknown.agent, unknown.id);
    const held = JSON.parse(fsSync.readFileSync(taskFile(manager, unknown.id), 'utf8')).proofBaseline;
    for (const key of fsSync.readdirSync(folder)) await fs.rm(path.join(folder, key, `${held.id}.json`), { force: true });
    await fs.appendFile(path.join(manager.workspace, 'notes.txt'), 'by the person');
    const lost = await run(manager, manager.workspace, [done], { runner: unknown.agent, id: unknown.id, prompt: 'Again.' });
    equal(lost.view.proofGate.reason, 'check_changes_unknown', '(premise) what changed before the new baseline is not known');
    const lostProof = await settled(unknown.agent, unknown.id);
    equal([lostProof.verdict, lostProof.checksModified, codes(packOf(manager, unknown.id))], ['not_evidenced', null, [['tests', 'unverified', ['check_changes_unknown']]]], 'the pack does not know either: not evidenced');
    const hidden = await run(manager, await project('ignored', { files: { '.gitignore': '.chatmcp/\n', 'calc.js': 'exports.add = (a, b) => a + b;\n' } }), [done], { prompt: 'Look around.' });
    equal([(await settled(hidden.agent, hidden.id)).verdict, packOf(manager, hidden.id).statement.predicate.acceptance.edited], ['evidenced', false], 'an ignored acceptance file is neither missing nor edited');
    const edited = await run(manager, await project('edited'), [write('.chatmcp/acceptance.yml', ACCEPT({ tests: 'node -v' })), done, done]);
    const editedProof = await settled(edited.agent, edited.id);
    const editedPack = packOf(manager, edited.id);
    equal([edited.view.proofGate.reason, editedPack.statement.predicate.acceptance.edited, editedPack.files['acceptance.yml'].toString() === ACCEPT(), editedProof.status], ['acceptance_edited', true, true, 'ready'], 'an edited file: the pack holds the bytes the run was held to and says it was edited');
    check(editedProof.verdict !== 'evidenced', 'and is not evidenced');
  });

  await section('1c. line ends: a checkout with CRLF of the trusted file is no edit', async () => {
    const crlf = await project('crlf', { acceptance: ACCEPT().replaceAll('\n', '\r\n') });
    check(fsSync.readFileSync(path.join(crlf, '.chatmcp', 'acceptance.yml')).includes('\r\n'), '(premise) CRLF on disk');
    const ran = await run(manager, crlf, [read, fix, done]);
    const proof = await settled(ran.agent, ran.id);
    const pack = packOf(manager, ran.id);
    equal([ran.view.proofGate.status, proof.verdict, pack.statement.predicate.acceptance.edited, pack.files['acceptance.yml'].toString() === ACCEPT(), cli(files(manager, ran.id)[0])], ['passed', 'evidenced', false, true, 'pack_verified']);
  });

  const reasons = new Set();
  const none = async (label, ran, reason) => {
    const proof = await settled(ran.agent, ran.id);
    equal([proof.status, proof.reason, proof.digest, proof.verdict, files(manager, ran.id)], ['none', reason, null, null, []], label);
    check(PACK_REASONS.includes(reason), `${reason} is in the closed list`);
    reasons.add(reason);
    return proof;
  };
  await section('2. why a run has no pack: before its final tree', async () => {
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
    const lost = await run(manager, await project('lost'), [done], { prompt: 'Look around.' });
    await settled(lost.agent, lost.id);
    await fs.rm(path.join(manager.hubDirectory, 'api-tasks', lost.id, 'acceptance.yml'));
    await fs.writeFile(path.join(manager.workspace, '.chatmcp', 'acceptance.yml'), ACCEPT({ other: 'node -v' }));
    const without = await run(manager, manager.workspace, [done], { runner: lost.agent, id: lost.id, prompt: 'Again.' });
    const proof = await settled(without.agent, without.id);
    equal([proof.status, proof.reason, proof.earlier.run], ['none', 'acceptance_lost', 1], 'the acceptance file of the start is gone');
    reasons.add('acceptance_lost');
  });

  await section('2b. why a run has no pack: the baseline, the folder, the final tree, the ledger, the size', async () => {
    const plain = await run(manager, await project('plain', { repository: false }), [read, fix, done]);
    equal(plain.view.proofGate.status, 'passed', '(premise) the gate passes in a plain folder');
    await none('a plain folder has no old bytes', plain, 'not_a_repository');
    const folder = path.join(manager.hubDirectory, 'proof', 'gate', 'proof', 'baselines');
    const current = (id) => JSON.parse(fsSync.readFileSync(taskFile(manager, id), 'utf8')).proofBaseline.id;
    const edit = async (id, change) => { for (const key of fsSync.readdirSync(folder)) { const file = path.join(folder, key, `${current(id)}.json`); if (fsSync.existsSync(file)) await change(file); } };
    let target = null;
    const spoil = (change) => ({ prompt: 'Look around.', during: async ({ agent, id }) => { target = id; await until(() => fsSync.existsSync(taskFile(manager, id)) && agent.get(id).events.some((event) => event.gate === 'armed'), 'the baseline'); spoilt = change; } });
    let spoilt = null;
    const hold = async () => { await until(() => spoilt, 'the test to be ready'); await edit(target, spoilt); spoilt = null; return [say('Done.')]; };
    await none('an edited baseline', await run(manager, await project('spoilt'), [hold], spoil((file) => fs.writeFile(file, fsSync.readFileSync(file, 'utf8').replace(/"tree":"[0-9a-f]/, '"tree":"0')))), 'baseline_unreadable');
    await none('a removed baseline', await run(manager, await project('removed'), [hold], spoil((file) => fs.rm(file))), 'baseline_unreadable');
    await none('a baseline whose objects are gone', await run(manager, await project('objects'), [read, async ({ last }) => { await until(() => spoilt, 'ready'); return fix({ last }); }, hold], spoil(async (file) => { await fs.rm(file.replace(/\.json$/, '.git'), { recursive: true, force: true }); })), 'old_bytes_unreadable');
    // a process that goes on writing: the tree at the build is not the tree the run ended on
    const WRITER = "const { spawn } = require('child_process');\nspawn(process.execPath, ['-e', \"const fs = require('fs'); let n = 0; const t = setInterval(() => { fs.writeFileSync('notes.txt', String(n++)); if (n > 400) clearInterval(t); }, 25)\"], { cwd: __dirname, detached: true, stdio: 'ignore' }).unref();\n";
    const writer = await run(manager, await project('writer', { files: { 'writer.js': WRITER } }), [() => [tool('run_command', { command: 'node writer.js', description: 'Start a helper' })], done], { prompt: 'Look around.' });
    await none('the files changed after the end of the run', writer, 'final_tree_changed');
    // the ledger is edited while the run goes on
    const broken = await run(manager, await project('ledger'), [hold], { prompt: 'Look around.', status: 'completed', during: async ({ id }) => {
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
    const big = await run(manager, await project('big'), [write('big.txt', 'x'.repeat(400_000)), done], { prompt: 'Look around.', start: {}, during: async ({ agent }) => { agent.packs.limits = { ...agent.packs.limits, maxBytes: 100_000 }; } });
    await none('a pack over the limit', big, 'pack_too_large');
    const patch = await run(manager, await project('patch'), [write('big.txt', 'x'.repeat(400_000)), done], { prompt: 'Look around.', during: async ({ agent }) => { agent.packs.limits = { ...agent.packs.limits, maxPatchBytes: 100_000 }; } });
    await none('a patch over the limit', patch, 'patch_too_large');
    const late = await run(manager, await project('late'), [done], { prompt: 'Look around.', during: async ({ agent }) => { agent.packs.limits = { ...agent.packs.limits, timeoutMs: 1 }; } });
    await none('a build that takes too long', late, 'timeout');
    // a file where the folder of the packs should be
    const packs = path.join(manager.hubDirectory, 'proof', 'packs');
    await fs.rename(packs, `${packs}-aside`);
    await fs.writeFile(packs, 'not a folder');
    const unwritable = await run(manager, await project('unwritable'), [done], { prompt: 'Look around.' });
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

  await section('3. the end of a run does not wait for its pack; a run that needs a baseline is not held up by one', async () => {
    const dir = await project('free', { files: Object.fromEntries(Array.from({ length: 300 }, (_, n) => [`f${n}.txt`, `file ${n}\n`.repeat(20)])) });
    const free = await run(manager, dir, [read, fix, done]);
    equal(free.agent.get(free.id).proof.status, 'building', 'the task is free while its pack is built');
    equal([free.agent.state().activeTaskId, manager.taskId, free.view.status], [null, null, 'completed']);
    // another conversation on the same folder starts at once, and takes its own baseline
    const next = await run(manager, dir, [answer('Nothing to do.')], { prompt: 'Look around.' });
    check(next.gates.includes('armed') && !next.gates.includes('baseline_unavailable'), 'it has its baseline');
    equal([(await settled(free.agent, free.id)).status, (await settled(next.agent, next.id)).status], ['ready', 'ready'], 'both have a pack');
    // a build that does not end gives way: the run that needs the folder is not the one that waits
    const stuck = await run(manager, dir, [done], { prompt: 'Look around.', during: async ({ agent }) => {
      agent.packs.limits = { ...agent.packs.limits, giveWayMs: 300 };
      agent.packs.deps = { ...agent.packs.deps, build: ({ signal }) => new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }) };
    } });
    const started = Date.now();
    const other = await run(manager, dir, [done], { prompt: 'Look around.' });
    check(Date.now() - started < 30_000 && other.gates.includes('armed'), 'the run after a stuck build starts');
    equal((await settled(stuck.agent, stuck.id)).reason, 'superseded', 'and the build is given up');
    reasons.add('superseded');
    await settled(other.agent, other.id);
  });

  await section('4. delete, stop and a new run while a pack is built; a restart', async () => {
    const forever = { build: ({ signal }) => new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }) };
    const slow = { during: async ({ agent }) => { agent.packs.deps = { ...agent.packs.deps, ...forever }; }, prompt: 'Look around.' };
    const deleted = await run(manager, await project('deleted'), [done], slow);
    equal(deleted.agent.get(deleted.id).proof.status, 'building');
    const at = Date.now();
    await deleted.agent.delete(deleted.id);
    check(Date.now() - at < 8000, 'a delete does not wait for the build');
    await sleep(300);
    equal([fsSync.existsSync(path.dirname(taskFile(manager, deleted.id))), files(manager, deleted.id)], [false, []], 'and nothing comes back after it');
    const stopped = await run(manager, await project('stopped'), [done], slow);
    const began = Date.now();
    await stopped.agent.shutdown();
    check(Date.now() - began < 8000, 'a Hub that stops does not wait for the build');
    equal(stopped.agent.get(stopped.id).proof.reason, 'hub_stopped');
    reasons.add('hub_stopped');
    const onDisk = JSON.parse(fsSync.readFileSync(taskFile(manager, stopped.id), 'utf8')).proof;
    equal([onDisk.status, onDisk.reason], ['none', 'hub_stopped'], 'and it is saved');
    // a new run of the same task while its pack is built
    const twice = await run(manager, await project('twice'), [done], slow);
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

  await section('4b. a second chat: its pack is in the Hub\'s own folder and goes with it', async () => {
    await manager.selectWorkspace(await project('shared'));
    manager.permissions.configure({ mode: 'autonomous', executionPolicy: 'host-review' });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const final = (text) => ({ type: 'message', role: 'assistant', phase: 'final', content: [{ type: 'output_text', text }] });
    const queues = { main: [async () => { await gate; return final('Main done.'); }], child: [() => ({ type: 'function_call', status: 'completed', name: 'write_file', call_id: 'side-1', arguments: JSON.stringify({ path: 'calc.js', content: 'exports.add = (a, b) => a + b;\n', overwrite: true }) }), () => final('Fixed.')] };
    const model = { ready: () => true, snapshot: () => ({ provider: 'fixture', model: 'fixture' }), state: () => ({ provider: 'fixture', model: 'fixture', configured: true, keySource: 'none' }),
      async respond({ input }) { const step = queues[textsOf(input).some((text) => text.includes('[second chat]')) ? 'child' : 'main'].shift(); return { status: 'completed', output: [step ? await step() : final('Nothing more.')] }; } };
    const runner = new AgentRunner({ manager, provider: model, taskDirectory: path.join(manager.hubDirectory, 'side-tasks'), log: () => {}, toolSelectionMode: 'full' });
    await runner.load();
    const pool = new ConcurrentApiAgent({ bundleRoot, manager, primary: runner, provider: model, directory: path.join(manager.hubDirectory, 'side-chats'), log: () => {} });
    await pool.load();
    const stop = approver(manager);
    try {
      await runner.start({ prompt: 'Wait.' });
      const child = await pool.start({ prompt: '[second chat] Fix add().' });
      equal(pool.get(child.id).proof, null, 'a chat that has not run has no summary');
      const view = await until(() => { const task = pool.get(child.id); return task?.proof?.status === 'ready' ? task : null; }, 'the pack of the second chat', 90_000);
      equal([view.proof.verdict, files(manager, child.id).length, cli(files(manager, child.id)[0])], ['evidenced', 1, 'pack_verified']);
      check(!fsSync.existsSync(path.join(manager.hubDirectory, 'side-chats', child.id, 'state', 'proof', 'packs')), 'not in the second chat\'s own data folder');
      release();
      await pool.delete(child.id);
      equal(files(manager, child.id), [], 'deleting it removes its pack');
    } finally { stop(); release?.(); await pool.shutdown(); await runner.shutdown(); }
  });

  await section('5. the folder of the packs, and the summary of a task file', async () => {
    const directory = path.join(root, 'store', 'packs');
    const store = new PackStore(directory);
    const id = randomUUID();
    const digest = 'ab'.repeat(32);
    for (const bad of ['', '..', '../x', 'CON', `${id}/..`, `${id}\0`, '-'.repeat(36), null, undefined, 5, {}, id.slice(1)]) {
      assert.throws(() => store.file(bad, digest), { code: 'bad_task_id' });
      await assert.rejects(store.write(bad, digest, Buffer.from('x')), { code: 'bad_task_id' });
      await assert.rejects(store.read(bad, digest), { code: 'bad_task_id' });
      await assert.rejects(store.remove(bad), { code: 'bad_task_id' });
    }
    for (const bad of ['', '..', 'ab', 'AB'.repeat(32), `${digest}/`, null, undefined]) assert.throws(() => store.file(id, bad), { code: 'bad_digest' });
    await store.write(id, digest, Buffer.from('one'));
    await fs.writeFile(path.join(directory, id, 'left.pack.json.tmp'), 'half');
    const other = 'cd'.repeat(32);
    await store.write(id, other, Buffer.from('two'));
    equal([(await store.read(id, digest)).toString(), (await store.read(id, other)).toString()], ['one', 'two'], 'a new pack does not touch the one that is shown');
    await store.keepOnly(id, other);
    equal([fsSync.readdirSync(path.join(directory, id)), await store.read(id, digest)], [[`${other.slice(0, 16)}.pack.json`], null], 'then only the last is kept, and no leftover');
    if (process.platform !== 'win32') equal([fsSync.statSync(path.join(directory, id)).mode & 0o777, fsSync.statSync(store.file(id, other)).mode & 0o777], [0o700, 0o600]);
    const small = new PackStore(directory, { maxBytes: 2 });
    await assert.rejects(small.read(id, other), { code: 'pack_too_large' });
    await store.remove(id);
    await store.remove(id);
    equal([fsSync.existsSync(path.join(directory, id)), await store.read(id, other)], [false, null], 'removed with the task');

    const pack = { run: 1, at: '2026-11-25T00:00:00.000Z', digest, verdict: 'evidenced', counts: { evidenced: 1, owner_accepted: 0, unverified: 0, failed: 0, stale: 0, checks_modified: 0 }, checksModified: false, coverage: 'task', bytes: 10 };
    const good = { status: 'ready', reason: null, run: 1, at: pack.at, pack };
    equal(loadedProof(good), good);
    for (const bad of [undefined, null, 'ready', [], 5, {}, { ...good, status: 'fine' }, { ...good, run: -1 }, { ...good, run: '1' }, { ...good, status: 'none', reason: 'because' }, { ...good, at: 'yesterday' }]) equal(loadedProof(bad), null, `not a summary: ${JSON.stringify(bad)?.slice(0, 60)}`);
    for (const bad of [{ ...pack, digest: '../x' }, { ...pack, verdict: '<b>' }, { ...pack, run: 1.5 }, { ...pack, counts: { evidenced: 'many' } }, { ...pack, coverage: 'all' }, { ...pack, checksModified: 'no' }, { ...pack, bytes: -1 }, 'x']) {
      equal(loadedProof({ ...good, pack: bad }), { status: 'none', reason: 'not_recorded', run: 1, at: pack.at, pack: null }, `an edited pack record is no pack: ${JSON.stringify(bad).slice(0, 80)}`);
    }
    equal(loadedProof({ ...good, pack: { ...pack, run: 2 } }).status, 'none', 'ready means the pack of that run');
    equal(publicProof({ status: 'none', reason: 'readonly', run: 2, at: pack.at, pack }), { status: 'none', reason: 'readonly', run: 2, at: pack.at, digest: null, verdict: null, counts: null, checksModified: null, coverage: null, earlier: { run: 1, at: pack.at, digest, verdict: 'evidenced' } });
    equal([publicProof(null), publicProof(good, { summary: true })], [null, { status: 'ready', reason: null, run: 1, verdict: 'evidenced' }]);
    equal([Object.isFrozen(PACK_REASONS), new Set(PACK_REASONS).size === PACK_REASONS.length, PACK_LIMITS.timeoutMs <= 120_000], [true, true, true]);
    const missing = [...reasons].filter((reason) => !PACK_REASONS.includes(reason));
    equal(missing, [], 'every reason met here is in the closed list');
  });

  await manager.shutdown();
  console.log(`PASS: proof packs at the end of a run (${count()} checks)`);
} finally {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}
