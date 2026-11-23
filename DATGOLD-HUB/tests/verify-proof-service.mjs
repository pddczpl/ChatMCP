// The proof service at the single guard seam (P4 pod-17, docs/PROOF-SERVICE.md): every call the permission gate allowed in a category that
// can change files gets a tree snapshot before and after it, written to the task's proof ledger (lib/proof/ledger.mjs), with the task's
// start and end around them. Real temporary Git repositories, the real snapshot engine (lib/proof/tree-snapshot.mjs) and the real ledger.
//  1. ProofService alone: the records of a task (task_start, the tree records, call records with treeBefore / treeAfter / changed, task_end),
//     the categories that are scanned, a resumed run that continues the same chain, recovery after a crash (uncertain records, written once),
//     a Hub data folder inside the workspace refused, tree ids kept whole when a registered secret occurs in them, the budget switch to
//     checks-only (measured on the scans around calls, strictly over 1.5 s, the full snapshots of the task's start left out)
//  2. the guard (HubManager.#guardCalls) through a real session: the task-start snapshot of createAgentSession, the awaited onProof callback,
//     a read call and a refused call leave no record, an onProof that throws changes no result, no tree id in the result
//  3. a real AgentRunner with the strict Chat Completions mock (no live model): a write_file call record whose trees differ, no record for the
//     read, no tree id in any request the model was sent, the proof lines of the task's transcript, a continued conversation in the same
//     chain, the budget switch through HubManager.proofOptions
//  4. a cancelled task (a command still running) gets its call record and its final snapshot
//  5. a side chat (ConcurrentApiAgent child, its own HubManager and worktree) has its own ledger
//  6. a real BrowserRunner with a scripted extension: the Companion's write is recorded at the same seam, its end too
//  7. kill -9 of a real Hub process (hub.mjs on a free port, never 3007) in the middle of run_command: the restarted Hub writes the uncertain
//     records of the interrupted call and run
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HubManager } from '../lib/manager.mjs';
import { assembleStudio } from '../lib/assemble.mjs';
import { AgentRunner } from '../lib/agent.mjs';
import { ConcurrentApiAgent } from '../lib/concurrent-api-agent.mjs';
import { BrowserRunner } from '../lib/browser-runner.mjs';
import { GatewayProvider } from '../lib/gateway-provider.mjs';
import { ledgerPath, verifyChain } from '../lib/proof/ledger.mjs';
import { snapshotTree } from '../lib/proof/tree-snapshot.mjs';
import {
  GRANULARITY, ProofService, SCAN_BUDGET, SCANNED_CATEGORIES, SERVICE_FORMAT, TREE_EVENTS, UNCERTAIN_REASONS, readLedgerEntries, scannedCall,
} from '../lib/proof/service.mjs';
import { startMockModel } from './e2e/mock-model-server.mjs';
import { call, say, sequence } from './e2e/scenarios.mjs';
import { startHub, connectModel } from './e2e/hub-process.mjs';

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
setTimeout(() => { console.error('FAIL: the proof-service suite exceeded its own time budget'); process.exit(2); }, 170_000).unref();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const bundleRoot = path.resolve(HERE, '..');
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-proof-service-')));
const cleanups = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(test, label, ms = 30_000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await test();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await delay(25);
  }
}
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });

async function makeRepo(name, files = { 'README.md': '# fixture\n', 'src/app.js': 'export const answer = 42;\n' }) {
  const repo = path.join(temp, name);
  await fs.mkdir(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'chatmcp-ci@example.invalid');
  git(repo, 'config', 'user.name', 'ChatMCP CI');
  for (const [file, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(repo, file)), { recursive: true });
    await fs.writeFile(path.join(repo, file), text);
  }
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'fixture');
  return repo;
}

/** The records of a ledger file as {seq, type, record}, after the chain was checked. */
async function ledgerOf(hubDir, taskId) {
  const { report, entries } = await readLedgerEntries(ledgerPath(hubDir, taskId));
  assert.equal(report.ok, true, `the ledger of ${taskId} verifies (${report.reason} at ${report.brokenAt})`);
  return entries;
}
const typesOf = (entries) => entries.map((entry) => entry.type === 'tree' ? `tree:${entry.record.event}` : entry.type === 'uncertain' ? `uncertain:${entry.record.reason}` : entry.type);
// What the scans cost on this machine, from the ledgers of the real-clock sections (printed at the end as one PROOF_SERVICE_COST line).
const cost = { perCall: [], full: [] };
const measure = (entries) => {
  for (const { type, record } of entries) {
    if (type === 'call') cost.perCall.push(record.scanMs);
    else if (type === 'tree' && record.event !== 'call_start') cost.full.push(record.scanMs);
  }
};
const summary = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { n: sorted.length, min: sorted[0], median: at(0.5), p95: at(0.95), max: sorted.at(-1) };
};
const callsOf = (entries) => entries.filter((entry) => entry.type === 'call');
/** Every tree id a ledger holds (tree and rawTree of every tree reference). */
const treeIdsOf = (entries) => entries.flatMap((entry) => {
  const refs = entry.type === 'tree' ? [entry.record.tree] : entry.type === 'call' ? [entry.record.treeBefore, entry.record.treeAfter] : [];
  return refs.filter(Boolean).flatMap((ref) => [ref.tree, ref.rawTree]).filter((id) => typeof id === 'string');
});

async function makeHub(name, { repo = null, mode = 'autonomous' } = {}) {
  const workspace = repo ?? await makeRepo(name);
  const data = path.join(temp, `${name}-hub`);
  const hub = new HubManager({ bundleRoot, dataDirectory: data, log: () => {} });
  await hub.load(workspace);
  assembleStudio(hub, { bundleRoot });
  await hub.permissions.load();
  hub.permissions.mode = mode;
  await hub.startLocal(workspace);
  cleanups.push(() => hub.shutdown().catch(() => {}));
  return { repo: workspace, data, hub };
}

try {
  // ---------------------------------------------------------------------------------------------------------------- 1. ProofService alone
  {
    assert.deepEqual([...SCANNED_CATEGORIES], ['workspace_edit', 'dangerous', 'execute', 'unknown']);
    for (const category of SCANNED_CATEGORIES) assert.equal(scannedCall({ category }), true, `${category} is scanned`);
    for (const category of ['read', 'checkpoint', 'external', 'plan', null, undefined]) assert.equal(scannedCall({ category }), false, `${category} is not scanned`);
    assert.equal(scannedCall({ category: 'external', touchesWorkspace: true }), true, 'an external tool of a server flagged touchesWorkspace is scanned');
    assert.equal(scannedCall({ category: 'read', touchesWorkspace: true }), false, 'the flag counts for external tools only');
    assert.equal(scannedCall({ category: 'external', touchesWorkspace: 'yes' }), false, 'only true counts');
    assert.deepEqual([...TREE_EVENTS], ['task_start', 'run_start', 'call_start', 'task_end']);
    assert.deepEqual({ ...GRANULARITY }, { calls: 'calls', checksOnly: 'checks-only' });
    assert.deepEqual({ ...SCAN_BUDGET }, { meanScanMs: 1500, minScans: 2 });
    ok('the scanned categories: workspace_edit, dangerous, execute, unknown, and external only for a server flagged touchesWorkspace');
  }
  {
    const repo = await makeRepo('alone');
    const hubDir = path.join(temp, 'alone-hub');
    const service = new ProofService({ hubDir, root: repo });
    assert.equal(service.disabled, null);
    const taskId = 'task-alone-1';
    const begun = await service.begin(taskId);
    assert.deepEqual([begun.run, begun.resumed], [1, false], 'the first run of a task');
    assert.equal(service.active, taskId);
    const token = await service.beforeCall({ taskId, callId: 'call-1', name: 'local.write_file', category: 'workspace_edit' });
    assert.ok(token, 'a scanned call of the active task gets a token');
    await fs.writeFile(path.join(repo, 'new.txt'), 'new\n');
    const first = await service.afterCall(token, { outcome: 'ok' });
    assert.equal(first.changed, true);
    assert.notEqual(first.treeBefore.tree, first.treeAfter.tree, 'the write changed the tree');
    const second = await service.afterCall(await service.beforeCall({ taskId, callId: 'call-2', name: 'local.run_command', category: 'execute' }), { outcome: 'error' });
    assert.equal(second.changed, false, 'a call that changed nothing');
    assert.equal(second.treeBefore.tree, first.treeAfter.tree);
    assert.equal(await service.beforeCall({ taskId: 'another-task', callId: 'call-3', name: 'local.write_file', category: 'workspace_edit' }), null, 'a call of another task is not recorded');
    assert.equal(await service.beforeCall({ taskId, callId: 'call-4', name: 'local.read_file', category: 'read' }), null, 'a read is not recorded');
    assert.equal(await service.afterCall(null, { outcome: 'ok' }), null);
    const ended = await service.end(taskId, { status: 'completed', errorCode: null });
    assert.ok(ended.seq > 0);
    assert.equal(service.active, null);
    assert.equal(await service.end(taskId, { status: 'completed' }), null, 'a second end writes nothing');

    const entries = await ledgerOf(hubDir, taskId);
    assert.deepEqual(typesOf(entries), ['task_start', 'tree:task_start', 'tree:call_start', 'call', 'tree:call_start', 'call', 'tree:task_end', 'task_end']);
    assert.deepEqual(entries.map((entry) => entry.seq), [1, 2, 3, 4, 5, 6, 7, 8]);
    const start = entries[0].record;
    assert.equal(start.format, SERVICE_FORMAT);
    assert.equal(start.taskId, taskId);
    assert.equal(start.workspace, repo);
    assert.equal(start.granularity, 'calls');
    assert.equal(start.budgetMs, 1500);
    const startTree = entries[1].record;
    assert.equal(startTree.run, 1);
    assert.equal(startTree.tree.full, true, 'the task-start snapshot is a full one');
    assert.equal(startTree.tree.status, 'ok');
    assert.match(startTree.tree.tree, /^[0-9a-f]{40}$/);
    assert.match(startTree.tree.rawTree, /^[0-9a-f]{40}$/);
    const callStart = entries[2].record;
    assert.deepEqual([callStart.callId, callStart.tool, callStart.category, callStart.tree.full], ['call-1', 'local.write_file', 'workspace_edit', false]);
    const writeRecord = entries[3].record;
    assert.deepEqual(Object.keys(writeRecord).sort(), ['beforeSeq', 'callId', 'category', 'changed', 'outcome', 'overlapped', 'run', 'scanMs', 'tool', 'treeAfter', 'treeBefore'].sort());
    assert.deepEqual([writeRecord.callId, writeRecord.tool, writeRecord.category, writeRecord.outcome, writeRecord.changed, writeRecord.overlapped, writeRecord.beforeSeq],
      ['call-1', 'local.write_file', 'workspace_edit', 'ok', true, false, 3]);
    assert.equal(writeRecord.treeBefore.tree, callStart.tree.tree, 'treeBefore is the tree of the call_start record');
    assert.notEqual(writeRecord.treeBefore.tree, writeRecord.treeAfter.tree);
    assert.ok(Number.isSafeInteger(writeRecord.scanMs) && writeRecord.scanMs >= 0);
    assert.deepEqual([entries[5].record.outcome, entries[5].record.changed], ['error', false]);
    const endTree = entries[6].record;
    assert.equal(endTree.tree.full, true, 'the final snapshot is a full one');
    assert.equal(endTree.tree.tree, writeRecord.treeAfter.tree);
    const end = entries[7].record;
    assert.deepEqual([end.format, end.run, end.status, end.errorCode, end.granularity, end.calls, end.scans], [SERVICE_FORMAT, 1, 'completed', null, 'calls', 2, 4]);
    assert.ok(typeof end.meanScanMs === 'number' && end.meanScanMs >= 0);

    // The next run of the same task continues the chain: no second task_start, the seq goes on, the file is one chain.
    const again = await service.begin(taskId);
    assert.deepEqual([again.run, again.resumed], [2, true]);
    await service.end(taskId, { status: 'failed', errorCode: 'task_failed' });
    const resumed = await ledgerOf(hubDir, taskId);
    assert.deepEqual(typesOf(resumed).slice(8), ['tree:run_start', 'tree:task_end', 'task_end']);
    assert.equal(resumed.filter((entry) => entry.type === 'task_start').length, 1, 'one task_start per ledger');
    assert.deepEqual([resumed[8].record.run, resumed.at(-1).record.run, resumed.at(-1).record.status, resumed.at(-1).record.errorCode], [2, 2, 'failed', 'task_failed']);
    assert.equal(verifyChain(await fs.readFile(ledgerPath(hubDir, taskId))).records, 11);
    ok('one task: task_start, the full task-start tree, a call_start tree and a call record (treeBefore, treeAfter, changed) per scanned call, the full final tree and task_end; reads and other tasks unrecorded; a later run continues the same chain without a second task_start');
  }
  {
    // A crash: a call started and never finished, no task_end. recover() writes it down once; the next run starts after it.
    const repo = await makeRepo('crash');
    const hubDir = path.join(temp, 'crash-hub');
    const taskId = 'task-crash-1';
    const before = new ProofService({ hubDir, root: repo });
    await before.begin(taskId);
    const open = await before.beforeCall({ taskId, callId: 'call-open', name: 'local.run_command', category: 'execute' });
    assert.ok(open);
    // (the process dies here)
    assert.equal(await ProofService.recover({ hubDir, taskId }), 2, 'two uncertain records: the call and the run');
    assert.equal(await ProofService.recover({ hubDir, taskId }), 0, 'recovering again writes nothing');
    assert.equal(await ProofService.recover({ hubDir, taskId: 'task-never-seen' }), 0, 'no ledger, nothing to recover');
    let entries = await ledgerOf(hubDir, taskId);
    assert.deepEqual(typesOf(entries), ['task_start', 'tree:task_start', 'tree:call_start', 'uncertain:call_interrupted', 'uncertain:run_interrupted']);
    assert.deepEqual(entries[3].record, { reason: UNCERTAIN_REASONS.callInterrupted, run: 1, callId: 'call-open', tool: 'local.run_command', category: 'execute', treeSeq: 3 });
    assert.deepEqual(entries[4].record, { reason: UNCERTAIN_REASONS.runInterrupted, run: 1 });
    const after = new ProofService({ hubDir, root: repo });
    const next = await after.begin(taskId);
    assert.deepEqual([next.run, next.resumed], [2, true]);
    entries = await ledgerOf(hubDir, taskId);
    assert.deepEqual(typesOf(entries).slice(5), ['tree:run_start'], 'the next run adds no uncertain record a second time');

    // Without an explicit recover(): begin() of the next run writes the uncertain records first.
    const second = 'task-crash-2';
    const one = new ProofService({ hubDir, root: repo });
    await one.begin(second);
    await one.beforeCall({ taskId: second, callId: 'call-a', name: 'local.write_file', category: 'workspace_edit' });
    await new ProofService({ hubDir, root: repo }).begin(second);
    assert.deepEqual(typesOf(await ledgerOf(hubDir, second)), ['task_start', 'tree:task_start', 'tree:call_start', 'uncertain:call_interrupted', 'uncertain:run_interrupted', 'tree:run_start']);
    ok('a crash in the middle of a call: recover() writes call_interrupted (call id, tool, category, the seq of its call_start tree) and run_interrupted once; begin() of the next run does the same when nobody recovered');
  }
  {
    // The Hub's data folder inside the workspace: every ledger write would change the tree it records. Refused (docs/PROOF-BASELINE.md).
    const repo = await makeRepo('inside');
    for (const hubDir of [path.join(repo, '.hub-state'), repo, path.join(repo, 'a', 'b')]) {
      const service = new ProofService({ hubDir, root: repo });
      assert.equal(service.disabled, 'state_inside_workspace', hubDir);
      assert.equal(await service.begin('task-inside'), null);
      assert.equal(await service.beforeCall({ taskId: 'task-inside', callId: 'c', name: 'local.write_file', category: 'workspace_edit' }), null);
      assert.equal(await service.end('task-inside', { status: 'completed' }), null);
    }
    await assert.rejects(fs.stat(path.join(repo, '.hub-state', 'proof')), { code: 'ENOENT' }, 'nothing was written');
    const beside = new ProofService({ hubDir: `${repo}-hub`, root: repo });
    assert.equal(beside.disabled, null, 'a folder whose name only starts like the workspace is outside it');
    ok('a Hub data folder inside the workspace (or the workspace itself) disables the service; nothing is written');
  }
  {
    // A registered secret that occurs inside a tree id: the ids of tree and call records are kept whole, the other strings are masked.
    const repo = await makeRepo('secret', { 'a.txt': 'a\n' });
    const probeDir = path.join(temp, 'secret-probe');
    await fs.mkdir(probeDir, { recursive: true });
    const id = (await snapshotTree({ root: repo, stateDir: probeDir })).tree;
    const secret = id.slice(8, 14);
    const hubDir = path.join(temp, 'secret-hub');
    const service = new ProofService({ hubDir, root: repo, secrets: () => [secret] });
    const taskId = 'task-secret';
    await service.begin(taskId);
    const info = await service.afterCall(await service.beforeCall({ taskId, callId: `call-${secret}`, name: 'local.write_file', category: 'workspace_edit' }), { outcome: 'ok' });
    await service.end(taskId, { status: 'completed' });
    const entries = await ledgerOf(hubDir, taskId);
    assert.equal(entries[1].record.tree.tree, id, 'the task-start tree id is whole');
    const record = callsOf(entries)[0].record;
    assert.equal(record.treeBefore.tree, id, 'treeBefore is whole');
    assert.equal(record.treeAfter.tree, id, 'treeAfter is whole');
    assert.equal(info.treeBefore.tree, id);
    assert.equal(record.callId, 'call-[REDACTED]', 'a call id that holds the secret is masked');
    assert.equal(entries[2].record.callId, 'call-[REDACTED]');
    ok('a registered secret inside a tree id: the ids of tree and call records stay whole, every other string is masked');
  }
  {
    // The budget: the mean of the scans around calls, strictly over 1.5 s, from the second scan on; the full snapshots of a run's start are not counted.
    const repo = await makeRepo('budget');
    const hubDir = path.join(temp, 'budget-hub');
    let clock = 0;
    const timed = (service, { full = 0, cached = 0 }) => {
      const real = service.snapshotter;
      service.snapshotter = { snapshot: async (options = {}) => { clock += options.full ? full : cached; return real.snapshot(options); } };
      return service;
    };
    const runCalls = async (service, taskId, count) => {
      const infos = [];
      for (let n = 0; n < count; n += 1) infos.push(await service.afterCall(await service.beforeCall({ taskId, callId: `call-${n}`, name: 'local.write_file', category: 'workspace_edit' }), { outcome: 'ok' }));
      return infos;
    };
    // exactly 1,500 ms per scan: no switch
    const even = timed(new ProofService({ hubDir, root: repo, clock: () => clock }), { full: 100_000, cached: 1500 });
    await even.begin('task-even');
    const evenInfos = await runCalls(even, 'task-even', 3);
    assert.ok(evenInfos.every(Boolean), 'every call is recorded at 1,500 ms a scan');
    assert.equal(even.granularity, 'calls');
    await even.end('task-even', { status: 'completed' });
    const evenEntries = await ledgerOf(hubDir, 'task-even');
    assert.equal(callsOf(evenEntries).length, 3);
    assert.equal(evenEntries.at(-1).record.granularity, 'calls');
    assert.equal(evenEntries.at(-1).record.meanScanMs, 1500, 'the task-start and final snapshots (100 s each) are not in the mean');
    assert.ok(!evenEntries.some((entry) => entry.type === 'uncertain'));
    // 1,501 ms: the first call is recorded whole, then the switch, then nothing per call
    const slow = timed(new ProofService({ hubDir, root: repo, clock: () => clock }), { cached: 1501 });
    await slow.begin('task-slow');
    const slowInfos = await runCalls(slow, 'task-slow', 3);
    assert.ok(slowInfos[0], 'the first call is recorded');
    assert.equal(slowInfos[0].granularity, 'checks-only', 'its proof says the granularity that now holds');
    assert.deepEqual(slowInfos.slice(1), [null, null], 'the calls after the switch are not scanned');
    assert.equal(slow.granularity, 'checks-only');
    await slow.end('task-slow', { status: 'completed' });
    const slowEntries = await ledgerOf(hubDir, 'task-slow');
    assert.deepEqual(typesOf(slowEntries), ['task_start', 'tree:task_start', 'tree:call_start', 'call', 'uncertain:checks_only', 'tree:task_end', 'task_end']);
    assert.deepEqual(slowEntries[4].record, { reason: UNCERTAIN_REASONS.checksOnly, run: 1, granularity: 'checks-only', meanScanMs: 1501, scans: 2, budgetMs: 1500 });
    assert.deepEqual([slowEntries.at(-1).record.granularity, slowEntries.at(-1).record.calls, slowEntries.at(-1).record.scans], ['checks-only', 1, 2]);
    // one slow scan alone does not switch: the decision waits for the second
    const lone = timed(new ProofService({ hubDir, root: repo, clock: () => clock, budget: { minScans: 3 } }), { cached: 4000 });
    await lone.begin('task-lone');
    const loneInfos = await runCalls(lone, 'task-lone', 3);
    assert.ok(loneInfos[0] && loneInfos[0].granularity === 'calls', 'two scans of 4 s do not switch when the budget waits for three');
    assert.ok(loneInfos[1] && loneInfos[1].granularity === 'checks-only', 'the fourth scan does');
    assert.equal(loneInfos[2], null);
    await lone.end('task-lone', { status: 'completed' });
    // a new run of the task starts again at the calls granularity
    const rerun = timed(new ProofService({ hubDir, root: repo, clock: () => clock }), { cached: 10 });
    await rerun.begin('task-slow');
    assert.equal(rerun.granularity, 'calls');
    assert.ok(await rerun.beforeCall({ taskId: 'task-slow', callId: 'call-r', name: 'local.write_file', category: 'workspace_edit' }));
    ok('the budget: a mean scan time of exactly 1,500 ms keeps per-call records; 1,501 ms switches to checks-only after the first call (an uncertain checks_only record with the mean, the scans and the budget); the switch waits for minScans; the task-start and final snapshots are not counted; a new run starts at calls again');
  }

  // ----------------------------------------------------------------------------------------------------------- 2. the guard through a session
  {
    const { repo, data, hub } = await makeHub('guard');
    const taskId = randomUUID(); // the workflow timeline of the guard takes task ids of the agent's shape
    hub.acquireTask(taskId);
    const session = await hub.createAgentSession();
    let entries = await ledgerOf(data, taskId);
    assert.deepEqual(typesOf(entries), ['task_start', 'tree:task_start'], 'createAgentSession took the task-start snapshot');
    let proof = null;
    const result = await session.callTool('local.write_file', { path: 'guard.txt', content: 'guard\n' }, { onProof: async (info) => { await delay(150); proof = info; } });
    assert.ok(proof, 'onProof was awaited before the call returned');
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.equal(await fs.readFile(path.join(repo, 'guard.txt'), 'utf8'), 'guard\n');
    assert.equal(proof.changed, true);
    assert.equal(proof.tool, 'local.write_file');
    assert.equal(proof.category, 'workspace_edit');
    assert.notEqual(proof.treeBefore.tree, proof.treeAfter.tree);
    entries = await ledgerOf(data, taskId);
    const record = callsOf(entries)[0];
    assert.equal(proof.seq, record.seq, 'onProof names the seq of the call record');
    assert.equal(proof.callId, record.record.callId);
    const ids = treeIdsOf(entries);
    assert.ok(ids.length >= 4);
    const text = JSON.stringify(result);
    for (const id of ids) assert.ok(!text.includes(id), 'no tree id in the result of the call');

    let readProof = null;
    const read = await session.callTool('local.read_file', { path: 'guard.txt' }, { onProof: (info) => { readProof = info; } });
    assert.notEqual(read.isError, true);
    assert.equal(readProof, null, 'a read call has no proof');
    const refused = await session.callTool('local.write_file', { path: 'guard.txt' }, { onProof: (info) => { readProof = info; } });
    assert.equal(refused.structuredContent?.executed, false, 'a call refused before it runs');
    assert.equal(readProof, null);
    hub.permissions.mode = 'readonly';
    const denied = await session.callTool('local.write_file', { path: 'denied.txt', content: 'x' }, { onProof: (info) => { readProof = info; } });
    assert.equal(denied.structuredContent?.error?.code, 'permission_denied');
    assert.equal(readProof, null, 'a call the gate refused has no proof');
    hub.permissions.mode = 'autonomous';
    assert.equal(callsOf(await ledgerOf(data, taskId)).length, 1, 'the read and the refused calls left no record');

    const kept = await session.callTool('local.write_file', { path: 'guard2.txt', content: 'two\n' }, { onProof: async () => { throw new Error('the caller could not store the proof'); } });
    assert.notEqual(kept.isError, true, 'an onProof that throws changes no result: the call has run');
    assert.equal(await fs.readFile(path.join(repo, 'guard2.txt'), 'utf8'), 'two\n');
    assert.equal(callsOf(await ledgerOf(data, taskId)).length, 2);

    await session.close();
    await hub.finishProof(taskId, { status: 'completed', errorCode: null });
    hub.releaseTask(taskId);
    entries = await ledgerOf(data, taskId);
    measure(entries);
    assert.deepEqual(typesOf(entries).slice(-2), ['tree:task_end', 'task_end']);
    assert.equal(entries.at(-1).record.status, 'completed');
    ok('the guard: createAgentSession takes the task-start snapshot; an allowed write gets a call record and an awaited onProof (seq, call id, both trees, changed) and its result holds no tree id; a read, an invalid call and a refused call get none; an onProof that throws changes no result; finishProof writes the end');
  }

  // ------------------------------------------------------------------------------------------- 3. a real AgentRunner and the strict model mock
  const gatewayOf = (manager, mock, label) => new GatewayProvider({ directory: path.join(temp, `gateway-${label}`), bundleRoot: temp, manager, env: {}, sleep: async () => {} })
    .forkForTask({ protocol: 'openai-chat', apiBaseUrl: mock.origin, model: 'mock-coder' });
  const settled = (runner, id, label) => until(() => { const task = runner.get(id); return task && task.status !== 'running' && runner.activeTaskId !== id ? task : null; }, label);
  {
    const { repo, data, hub } = await makeHub('agent');
    const script = (ctx) => {
      if (ctx.prompt.includes('Continue')) return ctx.turn === 0 ? call('write_file', { path: 'later.txt', content: 'later\n' }) : say('Wrote later.txt.');
      return sequence([call('read_file', { path: 'README.md' }), call('write_file', { path: 'src/new.js', content: 'export const added = 1;\n' })], { final: 'Read and wrote.' })(ctx);
    };
    const mock = await startMockModel({ scenario: 'agent', scenarios: { agent: script }, strict: true, keepBodies: true });
    cleanups.push(() => mock.close());
    const runner = new AgentRunner({ manager: hub, provider: gatewayOf(hub, mock, 'agent'), taskDirectory: path.join(data, 'api-tasks'), log: () => {}, toolSelectionMode: 'full' });
    await runner.load();
    const started = await runner.start({ prompt: 'Read the README, then add src/new.js.' });
    const done = await settled(runner, started.id, 'the agent task');
    assert.equal(done.status, 'completed', `${done.error ?? ''} ${JSON.stringify(mock.state.rejections?.at(-1)?.errors?.[0] ?? null)}`);
    assert.equal(await fs.readFile(path.join(repo, 'src', 'new.js'), 'utf8'), 'export const added = 1;\n');
    let entries = await ledgerOf(data, started.id);
    assert.deepEqual(typesOf(entries), ['task_start', 'tree:task_start', 'tree:call_start', 'call', 'tree:task_end', 'task_end'], 'the read left no record');
    const write = callsOf(entries)[0].record;
    assert.deepEqual([write.tool, write.category, write.outcome, write.changed], ['local.write_file', 'workspace_edit', 'ok', true]);
    assert.notEqual(write.treeBefore.tree, write.treeAfter.tree, 'the write_file call record: treeBefore differs from treeAfter');
    assert.equal(entries.at(-1).record.status, 'completed');
    // The transcript holds the proof the guard delivered; the model was never sent a tree id.
    const transcript = (await fs.readFile(path.join(data, 'api-tasks', started.id, 'transcript.jsonl'), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const proofs = transcript.filter((line) => line.type === 'proof');
    assert.equal(proofs.length, 1, 'one proof line: the write');
    assert.deepEqual([proofs[0].toolName, proofs[0].seq, proofs[0].changed, proofs[0].treeBefore.tree, proofs[0].treeAfter.tree],
      ['local.write_file', callsOf(entries)[0].seq, true, write.treeBefore.tree, write.treeAfter.tree]);
    assert.ok(typeof proofs[0].callId === 'string' && proofs[0].callId === transcript.find((line) => line.type === 'tool_result_full' && line.toolName === 'local.write_file')?.call_id, 'the proof line names the call of the model');
    assert.ok(transcript.indexOf(proofs[0]) < transcript.findIndex((line) => line.type === 'tool_result_full' && line.toolName === 'local.write_file'), 'the proof is written before the result of its call');
    const ids = treeIdsOf(entries);
    const bodies = mock.state.requests.map((request) => JSON.stringify(request.body ?? ''));
    assert.ok(bodies.length >= 3 && bodies.some((body) => body.includes('export const added')), '(premise) the requests carry the tool results');
    for (const id of ids) for (const body of bodies) assert.ok(!body.includes(id), 'no tree id in any request the model was sent');

    // The conversation goes on: the same chain.
    await runner.continue({ id: started.id, prompt: 'Continue with later.txt.' });
    const again = await settled(runner, started.id, 'the continued task');
    assert.equal(again.status, 'completed', again.error ?? '');
    entries = await ledgerOf(data, started.id);
    measure(entries);
    assert.deepEqual(typesOf(entries).slice(6), ['tree:run_start', 'tree:call_start', 'call', 'tree:task_end', 'task_end']);
    assert.equal(entries.filter((entry) => entry.type === 'task_start').length, 1);
    assert.deepEqual([entries[6].record.run, entries.at(-1).record.run], [2, 2]);
    for (const id of treeIdsOf(entries)) for (const request of mock.state.requests) assert.ok(!JSON.stringify(request.body ?? '').includes(id));
    await runner.shutdown();
    ok('a real AgentRunner and the strict Chat Completions mock: write_file gets a call record whose treeBefore differs from its treeAfter, read_file none; the transcript has the proof line before the result; no request to the model holds a tree id; the continued conversation is the same chain (run 2)');
  }
  {
    // The budget switch through the Hub: proofOptions reach the service of the manager.
    const { data, hub } = await makeHub('agent-budget');
    let clock = 0;
    hub.proofOptions = { clock: () => (clock += 2000) };
    const mock = await startMockModel({ scenario: 'budget', scenarios: { budget: sequence([call('write_file', { path: 'one.txt', content: '1' }), call('write_file', { path: 'two.txt', content: '2' })], { final: 'Two files.' }) }, strict: true });
    cleanups.push(() => mock.close());
    const runner = new AgentRunner({ manager: hub, provider: gatewayOf(hub, mock, 'budget'), taskDirectory: path.join(data, 'api-tasks'), log: () => {}, toolSelectionMode: 'full' });
    await runner.load();
    const started = await runner.start({ prompt: 'Write two files.' });
    const done = await settled(runner, started.id, 'the budget task');
    assert.equal(done.status, 'completed', done.error ?? '');
    const entries = await ledgerOf(data, started.id);
    assert.deepEqual(typesOf(entries), ['task_start', 'tree:task_start', 'tree:call_start', 'call', 'uncertain:checks_only', 'tree:task_end', 'task_end']);
    assert.equal(entries.at(-1).record.granularity, 'checks-only');
    await runner.shutdown();
    ok('HubManager.proofOptions reach its service: two-second scans switch the task to checks-only after its first write');
  }

  // ------------------------------------------------------------------------------------------------------------------- 4. a cancelled task
  {
    const { data, hub } = await makeHub('cancel');
    hub.permissions.configure({ mode: 'full-access', confirmation: 'FULL ACCESS' });
    const command = `node -e "setTimeout(() => {}, 60000)"`;
    const mock = await startMockModel({ scenario: 'cancel', scenarios: { cancel: sequence([call('run_command', { command })], { final: 'never' }) }, strict: true });
    cleanups.push(() => mock.close());
    const runner = new AgentRunner({ manager: hub, provider: gatewayOf(hub, mock, 'cancel'), taskDirectory: path.join(data, 'api-tasks'), log: () => {}, toolSelectionMode: 'full' });
    await runner.load();
    const started = await runner.start({ prompt: 'Run the long command.' });
    await until(async () => typesOf(await readLedgerEntries(ledgerPath(data, started.id)).then((read) => read.entries)).includes('tree:call_start'), 'the command to start');
    await delay(300);
    const cancelled = await runner.cancel(started.id);
    assert.equal(cancelled.status, 'cancelled');
    const entries = await ledgerOf(data, started.id);
    const types = typesOf(entries);
    assert.deepEqual(types.slice(0, 3), ['task_start', 'tree:task_start', 'tree:call_start']);
    assert.deepEqual(types.slice(-2), ['tree:task_end', 'task_end'], 'the cancelled task got its final snapshot');
    assert.ok(types.indexOf('call') > 2 && types.indexOf('call') < types.length - 2, 'the stopped command has its call record before the end');
    assert.deepEqual([entries.at(-1).record.status, entries.at(-1).record.errorCode], ['cancelled', 'user_cancelled']);
    assert.equal(entries.at(-2).record.tree.full, true);
    await runner.shutdown();
    ok('a task cancelled while its command runs: the command gets its call record, then the full final snapshot and task_end (cancelled, user_cancelled)');
  }

  // -------------------------------------------------------------------------------------------------------------------------- 5. a side chat
  {
    const { data, hub } = await makeHub('side');
    const CHILD_TAG = '[second chat]';
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const userTexts = (input) => input.filter((item) => item?.role === 'user').flatMap((item) => (Array.isArray(item.content) ? item.content.map((part) => String(part?.text ?? '')) : [String(item.content ?? '')]));
    const turn = (...items) => ({ status: 'completed', output: items });
    let calls = 0;
    const fcall = (name, args) => ({ type: 'function_call', status: 'completed', name, call_id: `side-call-${++calls}`, arguments: JSON.stringify(args) });
    const final = (text) => turn({ type: 'message', role: 'assistant', phase: 'final', content: [{ type: 'output_text', text }] });
    const queues = { main: [turn(fcall('write_file', { path: 'main.txt', content: 'main\n' })), async () => { await held; return final('Main done.'); }], child: [turn(fcall('write_file', { path: 'second.txt', content: 'second\n' })), final('Second done.')] };
    const model = {
      ready: () => true,
      snapshot: () => ({ provider: 'fixture', model: 'proof-service-fixture' }),
      state: () => ({ provider: 'fixture', model: 'proof-service-fixture', configured: true, keySource: 'none' }),
      async respond(request) {
        const key = userTexts(request.input).some((text) => text.includes(CHILD_TAG)) ? 'child' : 'main';
        const step = queues[key].shift();
        if (!step) return final('Nothing more.');
        return typeof step === 'function' ? step(request) : step;
      },
    };
    const runner = new AgentRunner({ manager: hub, provider: model, taskDirectory: path.join(data, 'api-tasks'), log: () => {}, toolSelectionMode: 'full' });
    await runner.load();
    const pool = new ConcurrentApiAgent({ primary: runner, manager: hub, provider: model, bundleRoot, directory: path.join(data, 'api-conversations'), log: () => {} });
    cleanups.unshift(() => pool.shutdown().catch(() => {}));
    const mainTask = await runner.start({ prompt: 'Write main.txt.' });
    await until(async () => callsOf((await readLedgerEntries(ledgerPath(data, mainTask.id))).entries).length === 1, 'the main write');
    const second = await pool.start({ prompt: `${CHILD_TAG} write second.txt.` });
    const record = await until(() => { const r = pool.records.get(second.id); return r?.worktree && pool.get(second.id)?.status === 'completed' ? r : null; }, 'the second chat to finish', 60_000);
    release();
    await settled(runner, mainTask.id, 'the main chat');
    const child = pool.children.get(second.id);
    assert.ok(child, 'the second chat ran in a child manager');
    const childTaskId = [...child.runner.tasks.keys()][0];
    assert.notEqual(child.manager.hubDirectory, hub.hubDirectory);
    const childEntries = await ledgerOf(child.manager.hubDirectory, childTaskId);
    measure(childEntries);
    assert.deepEqual(typesOf(childEntries), ['task_start', 'tree:task_start', 'tree:call_start', 'call', 'tree:task_end', 'task_end']);
    assert.equal(childEntries[0].record.workspace, await fs.realpath(record.worktree), 'the child ledger is keyed by its worktree');
    assert.equal(callsOf(childEntries)[0].record.changed, true);
    const mainEntries = await ledgerOf(data, mainTask.id);
    measure(mainEntries);
    assert.equal(callsOf(mainEntries).length, 1, 'the main ledger has its own write only');
    assert.deepEqual(new Set(callsOf(mainEntries).map((entry) => entry.record.callId)).intersection(new Set(callsOf(childEntries).map((entry) => entry.record.callId))).size, 0);
    assert.notEqual(callsOf(mainEntries)[0].record.treeAfter.tree, callsOf(childEntries)[0].record.treeAfter.tree);
    const mainFolder = (await fs.readdir(path.join(data, 'proof'))).filter((name) => name.endsWith('.jsonl'));
    assert.deepEqual(mainFolder, [`${mainTask.id}.jsonl`], 'the Hub\'s proof folder holds the main chat\'s ledger only');
    ok('a side chat: its child HubManager keeps its own ledger, keyed by its worktree, with its own write; the main chat\'s ledger holds only the main write');
  }

  // ------------------------------------------------------------------------------------------------- 6. the Companion (a real BrowserRunner)
  {
    const { repo, data, hub } = await makeHub('web');
    const browser = new BrowserRunner({ manager: hub, directory: path.join(data, 'browser'), log: () => {} });
    await browser.load();
    const pairing = await browser.createPairCode();
    const clientId = randomUUID(); const extensionId = 'a'.repeat(32);
    await browser.pair({ code: pairing.code, clientId, extensionId });
    cleanups.unshift(() => browser.shutdown().catch(() => {}));
    const url = `https://chatgpt.com/c/${randomUUID()}`;
    const answer = async (taskId, label, body) => {
      const polled = await until(async () => (await browser.poll({ clientId, taskId })).message, `the ${label} message`);
      await browser.claim({ clientId, taskId, messageId: polled.id });
      await browser.sent({ clientId, taskId, messageId: polled.id, url });
      const nonce = browser.tasks.get(taskId).nonce;
      await browser.reply({ clientId, taskId, messageId: polled.id, replyId: `${label}-${randomUUID()}`, url, text: label,
        blocks: [JSON.stringify({ chatmcp_hub: 'v1', task: taskId, turn: polled.turn, nonce, ...body })] });
      await browser.context?.work;
      return polled;
    };
    const task = await browser.start({ prompt: 'Write web.txt.', workspacePath: repo });
    await answer(task.id, 'write', { kind: 'tool', name: 'local.write_file', arguments: { path: 'web.txt', content: 'from the web\n' } });
    const result = await answer(task.id, 'final', { kind: 'final', text: 'done' });
    await until(() => browser.context === null, 'the web task to finish');
    assert.equal(await fs.readFile(path.join(repo, 'web.txt'), 'utf8'), 'from the web\n');
    const entries = await ledgerOf(data, task.id);
    measure(entries);
    assert.deepEqual(typesOf(entries), ['task_start', 'tree:task_start', 'tree:call_start', 'call', 'tree:task_end', 'task_end']);
    assert.equal(callsOf(entries)[0].record.changed, true);
    assert.equal(entries.at(-1).record.status, 'completed');
    for (const id of treeIdsOf(entries)) assert.ok(!result.text.includes(id), 'no tree id in the message the Companion hands to ChatGPT');
    // A cancelled web task gets its final snapshot too.
    const stopped = await browser.start({ prompt: 'Wait.', workspacePath: repo });
    await browser.cancel(stopped.id);
    const stoppedEntries = await ledgerOf(data, stopped.id);
    assert.deepEqual(typesOf(stoppedEntries), ['task_start', 'tree:task_start', 'tree:task_end', 'task_end']);
    assert.equal(stoppedEntries.at(-1).record.status, 'cancelled');
    ok('the Companion: a real BrowserRunner driven like the extension; its write_file is recorded at the same seam, no tree id goes to ChatGPT, a finished and a cancelled web task get their final snapshot');
  }

  // ------------------------------------------------------------------------------------------------ 7. kill -9 of a real Hub in the middle of a call
  {
    const repo = await makeRepo('killed');
    const scratch = path.join(temp, 'killed-scratch');
    const stateDir = path.join(temp, 'killed-state');
    const command = `node -e "setTimeout(() => {}, 120000)"`;
    const mock = await startMockModel({ scenario: 'killed', scenarios: { killed: sequence([call('run_command', { command })], { final: 'never' }) }, strict: true });
    cleanups.push(() => mock.close());
    let hub = await startHub({ scratch, stateDir, project: repo });
    cleanups.push(() => hub.stop().catch(() => {}));
    const check = await connectModel(hub, mock);
    assert.ok(check, 'the model is connected');
    const task = (await hub.post('/api/tasks/start', { prompt: 'Run the long command.' })).task;
    assert.ok(task?.id, 'the task started');
    const file = ledgerPath(stateDir, task.id);
    await until(async () => {
      const pending = (await hub.state()).studio.permissions.pending.filter((request) => request.taskId === task.id);
      for (const request of pending) await hub.post('/api/studio/permissions/decide', { id: request.id, approved: true });
      return typesOf((await readLedgerEntries(file)).entries).includes('tree:call_start');
    }, 'the command to start in the Hub process', 60_000);
    await delay(400);
    hub.killTree();
    await hub.exited;
    const killed = typesOf((await readLedgerEntries(file)).entries);
    assert.equal(killed.at(-1), 'tree:call_start', 'the Hub died in the middle of the call: no call record, no end');
    hub = await startHub({ scratch, stateDir, project: repo, logName: 'hub-2.log' });
    const entries = await until(async () => {
      const read = await readLedgerEntries(file);
      return typesOf(read.entries).includes('uncertain:call_interrupted') ? read.entries : null;
    }, 'the restarted Hub to recover the ledger');
    assert.equal(verifyChain(await fs.readFile(file)).ok, true);
    const types = typesOf(entries);
    assert.deepEqual(types.slice(-2), ['uncertain:call_interrupted', 'uncertain:run_interrupted']);
    const interrupted = entries.at(-2).record;
    const started = entries.find((entry) => entry.type === 'tree' && entry.record.event === 'call_start');
    assert.deepEqual([interrupted.tool, interrupted.category, interrupted.callId, interrupted.treeSeq], ['local.run_command', started.record.category, started.record.callId, started.seq]);
    await hub.stop();
    ok('kill -9 of a real Hub process in the middle of run_command: the ledger ends with the call_start tree; the restarted Hub appends uncertain call_interrupted (tool, category, call id, the seq of its call_start) and run_interrupted, and the chain verifies');
  }

  console.log(`PROOF_SERVICE_COST ${JSON.stringify({ platform: process.platform, perCallMs: summary(cost.perCall), fullSnapshotMs: summary(cost.full) })}`);
  console.log(`PASS: proof service (${checks} checks)`);
} finally {
  for (const cleanup of cleanups.reverse()) await cleanup();
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}
