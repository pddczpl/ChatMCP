// The packs the Hub writes at the end of a run (plan task P5 pod-33, docs/PROOF-HUB-API.md), with the rig of verify-proof-gate-agent.mjs: the real HubManager, AgentRunner,
// done-gate, baseline store, check runner and proof service on temporary projects, only the model is scripted; the real `chatmcp verify check` on what was written. The HTTP
// routes are in verify-proof-http.mjs, a real Hub process.
//  1. what a pack holds: the run's own final tree, the bytes the run was held to, the gate's report on the checks, the cost; the command line accepts it
//  2. a pack never slows or fails a run: it is built after the task is free, and gives way to a run that needs a baseline
//  3. a second chat
//  4. the folder of the packs: ids, names, sizes, leftovers; the summary of a task file somebody edited
//  5. the owner's acceptance of an objective: the receipt is held to the task's ledger (lib/proof/accept-receipt.mjs)
// The reasons for no pack, and what interrupts a build, are in verify-proof-hub-pack-none.mjs.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { treeKey } from '../lib/agent-progress.mjs';
import { objectiveReceiptId } from '../lib/objective-acceptance.mjs';
import { ACCEPT_CODES, receiptProblem } from '../lib/proof/accept-receipt.mjs';
import { AgentRunner } from '../lib/agent.mjs';
import { ConcurrentApiAgent } from '../lib/concurrent-api-agent.mjs';
import { readPackFile } from '../lib/proof/cli/check.mjs';
import { HubPacks, PACK_REASONS, PACK_LIMITS, PackStore, loadedProof, publicProof } from '../lib/proof/hub-pack.mjs';
import { ProofLedger, ledgerPath, treeRef } from '../lib/proof/ledger.mjs';
import {
  ACCEPT, WEAK, answer, approver, bundleRoot, check, count, createHub, diff, done, equal, fix, git, project, read, root, run, say, scripted, section, sleep, textsOf, tool, trust, until, write,
} from './support/proof-gate-rig.mjs';

const settled = (agent, id) => until(() => { const { proof } = agent.get(id); return proof && proof.status !== 'building' && proof.reason !== 'run_in_progress' && !agent.packs.running.has(id) ? proof : null; }, 'the proof to settle');
const files = (manager, id) => { try { return fsSync.readdirSync(path.join(manager.hubDirectory, 'proof', 'packs', id)).map((name) => path.join(manager.hubDirectory, 'proof', 'packs', id, name)); } catch { return []; } };
const packOf = (manager, id) => readPackFile(fsSync.readFileSync(files(manager, id)[0]));
const cli = (file) => {
  const result = spawnSync(process.execPath, [path.join(bundleRoot, 'bin', 'chatmcp.mjs'), 'verify', 'check', file, '--json'], { encoding: 'utf8', windowsHide: true, env: { ...process.env, CHATMCP_STATE_DIR: path.join(root, 'cli-state') } });
  return JSON.parse(result.stdout).code;
};
/** A project whose checks pass as it is. */
const good = (name, { files: more = {}, ...options } = {}) => project(name, { ...options, files: { 'calc.js': 'exports.add = (a, b) => a + b;\n', ...more } });
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

  await section('2. the end of a run does not wait for its pack; a run that needs a baseline is not held up by one', async () => {
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
    check(PACK_REASONS.includes('superseded'));
    await settled(other.agent, other.id);
  });

  await section('3. a second chat: its pack is in the Hub\'s own folder and goes with it', async () => {
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

  await section('4. the folder of the packs, and the summary of a task file', async () => {
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
  });

  await section('5. the receipt an objective is accepted with is held to the ledger of the task', async () => {
    const hubDir = path.join(root, 'ledgers');
    const snap = (char, extra = {}) => treeRef({ status: 'ok', treeAlgorithm: 'git-pinned-v1', objectFormat: 'sha1', tree: char.repeat(40), rawTree: char.repeat(40), full: true, engineReason: null, files: 1, bytes: 1, limitations: [], takenAt: '2026-11-25T00:00:00.000Z', ...extra });
    const [A, B] = [snap('a'), snap('b')];
    const none = treeRef({ status: 'failed', engineReason: 'snapshot_failed' });
    const at = (event, tree) => ['tree', { event, run: 1, callId: null, tool: null, category: null, tree, scanMs: 1 }];
    const call = (treeBefore, treeAfter, extra = {}) => ['call', { run: 1, callId: 'c', tool: 'local.run_command', category: 'execute', outcome: 'ok', treeBefore, treeAfter, changed: treeBefore.tree !== treeAfter.tree, overlapped: false, scanMs: 1, beforeSeq: 1, ...extra }];
    const stream = { sha256: 'e'.repeat(64), bytes: 0, truncated: false, preview: '', previewTruncated: false };
    const checked = (treeBefore, treeAfter) => ['check', { command: 'x', commandTruncated: false, commandSha256: 'c'.repeat(64), argsSha256: 'd'.repeat(64), cwd: '.', shell: 'cmd', exit: 0, signal: null, timedOut: false, cancelled: false, lingering: false, stdout: stream, stderr: stream, toolchain: null, treeBefore, treeAfter, durationMs: 1 }];
    const problem = async (records, receipt) => {
      const taskId = randomUUID();
      const ledger = ProofLedger.forTask(hubDir, taskId);
      let last = null;
      for (const [type, record] of records) last = await ledger.append(type, record);
      const made = typeof receipt === 'function' ? receipt(last) : receipt;
      return (await receiptProblem({ hubDir, taskId, receipt: made }))?.code ?? null;
    };
    const on = (kind, tree, extra = {}) => ({ kind, step: 1, tree: treeKey(tree), ...extra });
    const start = ['task_start', { taskId: 'x' }];
    const verify = on('verify', A, { id: '0123456789abcdef' });
    equal(await problem([], verify), ACCEPT_CODES.unreadable, 'no ledger');
    equal(await problem([start], verify), ACCEPT_CODES.treeUnknown, 'a ledger without a tree');
    equal(await problem([start, at('task_start', A), at('task_end', none)], verify), ACCEPT_CODES.treeUnknown, 'a final tree that could not be taken: not shown to be current');
    equal(await problem([start, at('task_start', A), at('task_end', B)], on('inspect', A)), ACCEPT_CODES.stale, 'another final tree');
    equal(await problem([start, call(A, B), at('run_start', A)], on('inspect', B)), ACCEPT_CODES.stale, 'a run that began on another tree');
    equal(await problem([start, at('task_start', A)], undefined), ACCEPT_CODES.stale, 'no such receipt');
    equal(await problem([start, at('task_start', A), at('task_end', A)], on('inspect', A)), null, 'a read on the final tree');
    equal(await problem([start, at('task_start', A), at('task_end', A)], on('review', A)), null, 'a diff review on it');
    equal(await problem([start, at('task_start', A), at('task_end', A)], verify), ACCEPT_CODES.notHeld, 'a check nothing in the ledger shows');
    equal(await problem([start, call(A, A), at('task_end', A)], verify), null, 'a command that left the tree as it found it');
    equal(await problem([start, call(A, A, { tool: 'local.write_file' }), at('task_end', A)], verify), ACCEPT_CODES.notHeld, 'another tool is no check');
    equal(await problem([start, call(A, A, { outcome: 'error' }), at('task_end', A)], verify), ACCEPT_CODES.notHeld, 'a call that failed');
    equal(await problem([start, call(A, A, { overlapped: true }), at('task_end', A)], verify), ACCEPT_CODES.notHeld, 'a call beside another one');
    equal(await problem([start, call(B, A), at('task_end', A)], verify), ACCEPT_CODES.notHeld, 'a command that changed the files');
    equal(await problem([start, checked(A, A), at('task_end', A)], verify), ACCEPT_CODES.notHeld, 'a check of the gate by another name');
    const named = (entry) => on('verify', A, { id: entry.hash.slice(0, 16) });
    equal(await problem([start, at('task_start', A), checked(A, A)], named), null, 'a check of the gate, by its ledger line');
    equal(await problem([start, at('task_start', A), checked(A, A)], (entry) => on('verify', A, { id: entry.hash.slice(0, 4) })), ACCEPT_CODES.notHeld, 'not by a part of it');
    equal(await problem([start, at('task_start', A), checked(B, A)], named), ACCEPT_CODES.notHeld, 'nor one that started on another tree');
    equal(await problem([start, call(B, A, { tool: 'local.edit_file', category: 'workspace_edit' }), at('task_end', A)], on('edit', A, { path: 'x', sha256: 'f'.repeat(64) })), null, 'an edit that led to the final tree');
    equal(await problem([start, call(A, B, { tool: 'local.edit_file' }), at('run_start', A)], on('edit', A)), ACCEPT_CODES.notHeld, 'an edit that led away from it');
    equal(await problem([start, call(B, A, { outcome: 'threw' }), at('task_end', A)], on('edit', A)), ACCEPT_CODES.notHeld, 'an edit that threw');
    // a task file somebody edited: its latest tree is made the tree of an old receipt
    const ran = await run(manager, await project('accept'), [read, fix, diff, done]);
    await settled(ran.agent, ran.id);
    const stale = ran.agent.tasks.get(ran.id).progress.receipts.find((item) => item.kind === 'inspect');
    check(stale.tree !== ran.agent.tasks.get(ran.id).progress.tree, '(premise) the read was made on the start tree');
    const objective = ran.view.goalPlan.objectives[0];
    const inspect = objective.acceptanceCriteria.findIndex((text) => text.startsWith('Observe'));
    const data = JSON.parse(fsSync.readFileSync(taskFile(manager, ran.id), 'utf8'));
    data.progress.tree = stale.tree;
    await fs.writeFile(taskFile(manager, ran.id), JSON.stringify(data));
    const again = new AgentRunner({ manager, provider: scripted([]), taskDirectory: path.join(manager.hubDirectory, 'api-tasks'), log: () => {} });
    await again.load();
    const forged = objectiveReceiptId(stale);
    check(again.get(ran.id).objectiveReceipts.some((item) => item.receiptId === forged), '(premise) the edited file offers it');
    await assert.rejects(again.acceptCriterion({ id: ran.id, objectiveId: objective.id, criterionIndex: inspect, receiptId: forged, confirmed: true }), { code: 'stale_acceptance_receipt', statusCode: 409 });
    equal(again.get(ran.id).goalPlan.objectives[0].evidence ?? [], [], 'nothing was accepted');
    // two acceptances at once: both are kept
    const edit = objective.acceptanceCriteria.findIndex((text) => text.startsWith('If code'));
    const review = ran.agent.get(ran.id).objectiveReceipts;
    const pick = (kind) => review.find((item) => item.kind === kind).receiptId;
    const run2 = objective.acceptanceCriteria.findIndex((text) => text.startsWith('Run required'));
    const both = [[edit, 'edit'], [run2, 'verify']].filter(([index]) => index >= 0);
    check(both.length === 2, '(premise) two criteria to accept');
    await Promise.all(both.map(([criterionIndex, kind]) => ran.agent.acceptCriterion({ id: ran.id, objectiveId: objective.id, criterionIndex, receiptId: pick(kind), confirmed: true })));
    equal(ran.agent.get(ran.id).goalPlan.objectives[0].evidence.map((item) => item.criterionIndex).sort(), both.map(([index]) => index).sort(), 'two acceptances at once are both kept');
  });

  await manager.shutdown();
  console.log(`PASS: proof packs at the end of a run (${count()} checks)`);
} finally {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}
