#!/usr/bin/env node
// Task state machine: the pure rules (lib/task-state.mjs), how AgentRunner applies them while a task runs, and what is
// concluded about a task found on disk after the Hub died.
//
// The claims that matter are proven with real files and the real permission guard, not with mocks of them:
//   - `waiting_approval` is visible while a person is being asked, and nothing has run at that point
//   - a call that was only waiting for approval is never reported as "may have run", even if the Hub dies right then
//   - a command killed mid-flight is `uncertain`, never plain `cancelled`; a read cannot make a task uncertain
//   - a task file from an older release, or one saved mid-run, is classified from its evidence on load
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRunner } from '../lib/agent.mjs';
import { HubManager } from '../lib/manager.mjs';
import { assembleStudio } from '../lib/assemble.mjs';
import { PermissionGate } from '../lib/permissions.mjs';
import * as S from '../lib/task-state.mjs';

const bundleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let checks = 0;
const check = (condition, label) => { assert.ok(condition, label); checks += 1; };
const equal = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks += 1; };
setTimeout(() => { console.error('FAIL: the task-state suite exceeded its own time budget'); process.exit(2); }, 240_000).unref();

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-task-state-'));
const root = await fs.realpath(temp);

async function until(read, { timeoutMs = 20_000, step = 10, label = 'condition' } = {}) {
  const limit = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > limit) throw new Error(`Timed out waiting for ${label}.`);
    await sleep(step);
  }
}
async function section(title, body) {
  const before = checks;
  const started = Date.now();
  await body();
  console.log(`  ok  ${title} (${checks - before} checks, ${((Date.now() - started) / 1000).toFixed(1)}s)`);
}
const path_ = (view) => view.stateHistory.map((entry) => entry.to);
const reasons = (view) => view.stateHistory.map((entry) => entry.reason);

// ==================================================================== 1. the vocabulary and the table
let manager = null;
try {
await section('the eleven states and the transition table', async () => {
  equal([...S.TASK_STATES], ['created', 'queued', 'planning', 'running', 'waiting_approval', 'verifying', 'paused', 'completed', 'failed', 'cancelled', 'uncertain'], 'the states of the specification, in life-cycle order');
  const parts = [...S.ACTIVE_STATES, ...S.REST_STATES, 'created'];
  equal([new Set(parts).size, parts.length], [11, 11], 'created, active and resting states partition the eleven states, with no overlap');
  equal(Object.keys(S.TRANSITIONS).sort(), [...S.TASK_STATES].sort(), 'every state has a row in the table');
  for (const [from, targets] of Object.entries(S.TRANSITIONS)) {
    check(targets.every((to) => S.isTaskState(to) && to !== from), `${from}: every target is a different, real state`);
    check(targets.length > 0, `${from}: no dead end`);
  }
  // Every state can be reached from `created`, and every running state can end.
  const reach = new Set(['created']);
  for (let grew = true; grew;) { grew = false; for (const from of [...reach]) for (const to of S.TRANSITIONS[from]) if (!reach.has(to)) { reach.add(to); grew = true; } }
  equal([...reach].sort(), [...S.TASK_STATES].sort(), 'all eleven states are reachable');
  for (const state of S.ACTIVE_STATES) check(S.TRANSITIONS[state].some((to) => S.REST_STATES.has(to)), `${state} can end`);
  for (const state of S.REST_STATES) equal(S.TRANSITIONS[state], ['queued'], `${state}: a stopped task moves on only by starting a new run`);
  const legal = [['created', 'queued'], ['queued', 'planning'], ['planning', 'running'], ['planning', 'completed'], ['running', 'waiting_approval'], ['waiting_approval', 'running'], ['waiting_approval', 'planning'], ['running', 'verifying'], ['verifying', 'running'], ['running', 'uncertain'], ['planning', 'paused'], ['queued', 'paused'], ['paused', 'queued'], ['uncertain', 'queued'], ['completed', 'queued']];
  const illegal = [['created', 'running'], ['queued', 'completed'], ['queued', 'uncertain'], ['waiting_approval', 'completed'], ['completed', 'running'], ['completed', 'failed'], ['failed', 'completed'], ['uncertain', 'completed'], ['cancelled', 'planning'], ['paused', 'running']];
  for (const [from, to] of legal) check(S.canTransition(from, to), `${from} → ${to} is legal`);
  for (const [from, to] of illegal) check(!S.canTransition(from, to), `${from} → ${to} is refused`);
  check(!S.canTransition('running', 'nonsense') && S.canTransition(undefined, 'running'), 'unknown targets are refused; a task with no recorded state has no history to contradict');
});

await section('applyTransition records, refuses and bounds', async () => {
  const task = {};
  const first = S.applyTransition(task, 'created', { reason: 'task_created', at: 'T0' });
  equal([first.ok, first.changed, task.state, task.stateReason, task.stateChangedAt], [true, true, 'created', 'task_created', 'T0'], 'first state recorded');
  equal(task.stateHistory, [{ at: 'T0', from: null, to: 'created', reason: 'task_created' }], 'history entry shape');
  const same = S.applyTransition(task, 'created', { reason: 'again' });
  equal([same.ok, same.changed, task.stateHistory.length], [true, false, 1], 'the same state again is a no-op');
  const bad = S.applyTransition(task, 'completed', { reason: 'skipped ahead' });
  equal([bad.ok, bad.changed, task.state, task.stateHistory.length], [false, false, 'created', 1], 'an illegal move changes nothing');
  check(/created → completed/.test(bad.error), 'and says which move it refused');
  equal(S.applyTransition(task, 'flying').ok, false, 'an unknown state is refused');
  const forced = S.applyTransition(task, 'uncertain', { reason: 'persistence_failed', force: true });
  equal([forced.ok, forced.entry.forced, task.state], [true, true, 'uncertain'], 'force records the truth and marks it as forced');
  const legalForce = S.applyTransition({ state: 'running' }, 'paused', { force: true });
  equal(legalForce.entry.forced, undefined, 'force on a legal move is not marked as forced');
  const clipped = S.applyTransition({}, 'queued', { reason: 'x'.repeat(500) });
  equal(clipped.entry.reason.length, 200, 'reasons are clipped');
  // history is bounded
  const long = {};
  S.applyTransition(long, 'queued', { reason: 'start' });
  for (let i = 0; i < 150; i += 1) { S.applyTransition(long, i % 2 ? 'planning' : 'running', { force: true, reason: `n${i}` }); }
  equal([long.stateHistory.length, long.stateHistory.at(-1).reason], [100, 'n149'], 'only the latest 100 transitions are kept');
});

await section('restState: the evidence decides', async () => {
  const risky = { callId: 'c1', toolName: 'local.run_command', phase: 'executing' };
  const rows = [
    ['completed', { status: 'completed' }, 'completed'],
    ['completed after an old unverified call', { status: 'completed', unverifiedOperations: [risky] }, 'completed'],
    ['failed', { status: 'failed' }, 'failed'],
    ['cancelled', { status: 'cancelled' }, 'cancelled'],
    ['hit a limit', { status: 'limit' }, 'paused'],
    ['paused', { status: 'paused' }, 'paused'],
    ['"interrupted" (an old name)', { status: 'interrupted' }, 'paused'],
    ['running but nobody is running it', { status: 'running' }, 'paused'],
    ['an unknown status', { status: 'weird' }, 'paused'],
    ['failed with a call in flight', { status: 'failed', pendingCall: risky }, 'uncertain'],
    ['cancelled with a call in flight', { status: 'cancelled', pendingCall: risky }, 'uncertain'],
    ['paused with a call in flight', { status: 'paused', pendingCall: risky }, 'uncertain'],
    ['a call record from an older file (no phase)', { status: 'failed', pendingCall: { callId: 'c', toolName: 'x' } }, 'uncertain'],
    ['cancelled while a call waited for approval', { status: 'cancelled', pendingCall: { ...risky, phase: 'awaiting_approval' } }, 'cancelled'],
    ['failed after a call was refused', { status: 'failed', pendingCall: { ...risky, phase: 'refused' } }, 'failed'],
    ['failed during a read', { status: 'failed', pendingCall: { ...risky, readOnly: true } }, 'failed'],
    ['failed with an earlier call never confirmed', { status: 'failed', unverifiedOperations: [risky] }, 'uncertain'],
    ['paused with only earlier reads unconfirmed', { status: 'paused', unverifiedOperations: [{ ...risky, readOnly: true }] }, 'paused'],
    ['cancelled with an earlier call never confirmed', { status: 'cancelled', unverifiedOperations: [risky] }, 'uncertain'],
  ];
  for (const [label, task, expected] of rows) equal(S.restState(task), expected, label);
  equal(S.hasUnknownOutcome(null), false, 'no task, no unknown outcome');

  equal(S.deriveState({ status: 'running', state: 'verifying' }, { live: true }), 'verifying', 'a live task keeps the state the runner recorded');
  equal(S.deriveState({ status: 'running', state: 'paused' }, { live: true }), 'running', 'a live task never shows a resting state');
  equal(S.deriveState({ status: 'running', state: 'planning' }, { live: true, pendingApprovals: 1 }), 'waiting_approval', 'an open approval request wins');
  equal(S.deriveState({ status: 'running', state: 'running' }, { live: false }), 'paused', 'the same record, not live, is paused');
  equal(S.deriveState({ status: 'completed', state: 'running' }, { live: false }), 'completed', 'a stale active state on a finished task is ignored');

  for (const state of S.TASK_STATES) {
    const info = S.describeState(state);
    check(info.label && info.hint && ['idle', 'active', 'attention', 'warn', 'ok', 'error'].includes(info.tone), `${state} has a label, a hint and a tone`);
  }
  equal(S.describeState('nonsense').label, 'nonsense', 'an unknown state is shown as is');
});

// ==================================================================== 2. the gate's watchers
await section('PermissionGate.subscribe: several watchers, none of which can change a decision', async () => {
  const gate = new PermissionGate({ manager: { secrets: [] }, workspace: null, timeout: 5000 });
  const seen = [];
  const legacy = [];
  gate.onEvent = (event) => legacy.push(event.type);
  const stop = gate.subscribe((event) => seen.push(event.type));
  gate.subscribe(() => { throw new Error('a broken watcher'); });
  assert.throws(() => gate.subscribe('nope'), /Listener/); checks += 1;

  gate.configure({ mode: 'readonly' });
  const refusal = await gate.authorize({ name: 'desktop-commander.write_file', args: { path: 'a.txt', content: 'x' }, taskId: 't1' });
  equal(refusal.allowed, false, 'a watcher that throws does not change the decision');
  equal([seen, legacy], [['tool_policy'], ['tool_policy']], 'both the watcher and the legacy hook saw the refusal');

  gate.configure({ mode: 'review' });
  const asking = gate.authorize({ name: 'desktop-commander.write_file', args: { path: 'a.txt', content: 'x' }, taskId: 't1' });
  const request = await until(() => gate.state().pending[0], { label: 'the approval request' });
  gate.decide(request.id, true);
  equal((await asking).allowed, true, 'approved');
  equal(seen, ['tool_policy', 'approval_requested', 'approval_approved'], 'an approval is announced when asked and when answered');

  stop();
  gate.configure({ mode: 'readonly' });
  await gate.authorize({ name: 'desktop-commander.write_file', args: { path: 'b.txt', content: 'x' }, taskId: 't1' });
  equal(seen.length, 3, 'after unsubscribing the watcher hears nothing more');
  check(legacy.length === 4, 'the legacy hook still hears everything');
  gate.shutdown();
});

// ==================================================================== 3. a task file found on disk
const WORKSPACE = path.join(root, 'workspace');
await fs.mkdir(WORKSPACE, { recursive: true });
let held = null;
const stubManager = (makeSession) => ({
  secrets: [], instanceId: 'hub-test', backend: 'mcp',
  state() { return { instanceId: 'hub-test', generation: 1, workspace: { path: WORKSPACE } }; },
  acquireTask(id) { if (held) return false; held = id; return true; },
  releaseTask(id) { if (held === id) held = null; },
  async createAgentSession() { return makeSession(); },
});
const T = '2026-01-01T00:00:00.000Z';
function taskFile(status, extra = {}) {
  const id = randomUUID();
  return {
    id,
    data: {
      formatVersion: 1, id, prompt: 'Sửa lỗi trong calc.js', status, workspace: { path: WORKSPACE, generation: 1, instanceId: 'hub-test' }, model: 'm', provider: 'p',
      createdAt: T, startedAt: T, updatedAt: T, finishedAt: status === 'running' ? null : T, finalText: '', error: null, errorCode: null, steps: 2, toolCalls: 1, maxSteps: null, maxMinutes: null,
      usage: { inputTokens: 1, outputTokens: 1 }, events: [], eventCount: 0, pendingCall: null, cancelRequested: false,
      prompts: [{ at: T, text: 'Sửa lỗi trong calc.js' }], runs: [{ startedAt: T, finishedAt: null, status, startStep: 0 }], dialogue: [], ...extra,
    },
  };
}
const idleProvider = { snapshot: () => ({ model: 'm', provider: 'p' }), ready: () => true, redact: (text) => text, state: () => ({}), async respond() { throw new Error('not used'); } };

await section('a task file from an older release, or saved mid-run, is classified from its evidence', async () => {
  const dir = path.join(root, 'recovery');
  const risky = { callId: 'c1', toolName: 'local.run_command', startedAt: T, outcome: 'pending_or_unknown' };
  const cases = {
    legacyCompleted: taskFile('completed', { finalText: 'xong' }),
    legacyFailed: taskFile('failed', { errorCode: 'task_failed', error: 'lỗi' }),
    legacyLimit: taskFile('limit', { errorCode: 'step_limit' }),
    legacyCancelled: taskFile('cancelled', { errorCode: 'user_cancelled' }),
    midRunPlain: taskFile('running', { state: 'planning' }),
    midRunLegacy: taskFile('running'),
    midRunCommand: taskFile('running', { state: 'verifying', pendingCall: { ...risky, phase: 'executing' } }),
    midRunOldRecord: taskFile('running', { pendingCall: risky }),
    midRunApproval: taskFile('running', { state: 'waiting_approval', pendingCall: { ...risky, toolName: 'local.write_file', phase: 'awaiting_approval' } }),
    midRunRead: taskFile('running', { state: 'planning', pendingCall: { ...risky, toolName: 'local.read_file', phase: 'executing', readOnly: true } }),
    failedUnconfirmed: taskFile('failed', { unverifiedOperations: [risky] }),
    completedUnconfirmed: taskFile('completed', { unverifiedOperations: [risky] }),
    staleActive: taskFile('completed', { state: 'running' }),
  };
  for (const { id, data } of Object.values(cases)) {
    await fs.mkdir(path.join(dir, id), { recursive: true });
    await fs.writeFile(path.join(dir, id, 'task.json'), JSON.stringify(data));
  }
  const agent = new AgentRunner({ manager: stubManager(() => { throw new Error('unused'); }), provider: idleProvider, taskDirectory: dir });
  await agent.load();
  const view = (name) => agent.get(cases[name].id);
  const expectState = (name, status, state, reason) => equal([view(name).status, view(name).state, view(name).stateReason], [status, state, reason], name);

  expectState('legacyCompleted', 'completed', 'completed', 'migrated_from_status');
  expectState('legacyFailed', 'failed', 'failed', 'migrated_from_status');
  expectState('legacyLimit', 'limit', 'paused', 'migrated_from_status');
  expectState('legacyCancelled', 'cancelled', 'cancelled', 'migrated_from_status');
  expectState('midRunPlain', 'paused', 'paused', 'hub_restarted');
  expectState('midRunLegacy', 'paused', 'paused', 'hub_restarted');
  expectState('midRunCommand', 'paused', 'uncertain', 'hub_restarted');
  expectState('midRunOldRecord', 'paused', 'uncertain', 'hub_restarted');
  expectState('midRunApproval', 'paused', 'paused', 'hub_restarted');
  expectState('midRunRead', 'paused', 'paused', 'hub_restarted');
  expectState('failedUnconfirmed', 'failed', 'uncertain', 'migrated_from_status');
  expectState('completedUnconfirmed', 'completed', 'completed', 'migrated_from_status');
  expectState('staleActive', 'completed', 'completed', 'reconciled_on_load');

  equal(view('midRunPlain').errorCode, 'process_interrupted', 'the legacy marker the auto-resume scheduler looks for is kept');
  equal(view('midRunCommand').pendingCall.toolName, 'local.run_command', 'a call that may have run stays on record');
  equal(view('midRunCommand').stateHistory.map((entry) => [entry.from, entry.to]), [['verifying', 'uncertain']], 'the history shows what the Hub found');
  equal(view('midRunApproval').pendingCall, null, 'a call that was only waiting for approval never ran, so no unverified call is kept');
  check(/local\.write_file chưa được chạy/.test(view('midRunApproval').error), 'and the message says so');
  equal(view('midRunRead').pendingCall, null, 'a read in flight is not an unverified operation');
  equal(view('failedUnconfirmed').unverifiedCount, 1, 'the summary counts unconfirmed operations');
  equal(view('legacyCompleted').stateHistory.length, 1, 'a migrated task starts its history at the migration');

  // Loading again changes nothing: recovery is idempotent.
  const again = new AgentRunner({ manager: stubManager(() => { throw new Error('unused'); }), provider: idleProvider, taskDirectory: dir });
  await again.load();
  for (const [name, { id }] of Object.entries(cases)) {
    equal([again.get(id).state, again.get(id).stateHistory.length], [agent.get(id).state, agent.get(id).stateHistory.length], `${name}: a second load agrees with the first`);
  }
  // The summary list carries the state too.
  const summary = agent.state().tasks.find((item) => item.id === cases.midRunCommand.id);
  equal([summary.state, summary.unverifiedCount, summary.stateHistory], ['uncertain', 0, undefined], 'the list shows the state without the history');
  // The persisted file now says the same.
  const saved = JSON.parse(await fs.readFile(path.join(dir, cases.midRunCommand.id, 'task.json'), 'utf8'));
  equal([saved.state, saved.status], ['uncertain', 'paused'], 'and so does the file on disk');
});

// ==================================================================== 4. a run with a controllable tool session
function scriptedModel(steps) {
  let turn = 0;
  let counter = 0;
  return {
    inputs: [],
    snapshot: () => ({ model: 'scripted-1', provider: 'scripted' }),
    ready: () => true, redact: (text) => text, state: () => ({ provider: 'scripted', model: 'scripted-1', configured: true }),
    async respond({ input, signal }) {
      signal?.throwIfAborted();
      this.inputs.push(structuredClone(input));
      const produce = steps[turn];
      turn += 1;
      if (!produce) throw new Error(`The script has no step ${turn}.`);
      const out = await produce();
      return {
        status: 'completed', usage: { input_tokens: 1, output_tokens: 1 },
        output: out.map((item) => item.say !== undefined
          ? { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: item.say }] }
          : { type: 'function_call', call_id: `call_${(counter += 1)}`, name: 'mcp_call', arguments: JSON.stringify({ name: item.tool, arguments_json: JSON.stringify(item.args ?? {}) }), status: 'completed' }),
      };
    },
  };
}
const say = (text) => ({ say: text });
const call = (tool, args) => ({ tool, args });
const catalogTools = ['desktop-commander.list_directory', 'desktop-commander.write_file'].map((name) => ({ name, originalName: name.split('.')[1], server: 'desktop-commander', description: name, inputSchema: { type: 'object' } }));
const sessionWith = (handler) => () => ({ catalog: { tools: structuredClone(catalogTools), prompts: [], resources: [], resourceTemplates: [], servers: {} }, callTool: handler, async close() {} });
const blockUntilAborted = (signal) => new Promise((_, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
async function finished(agent, id) {
  return await until(() => { const view = agent.get(id); return view.status !== 'running' && agent.state().activeTaskId === null ? view : null; }, { label: 'the task to finish' });
}

await section('a stop during a read is not uncertain; a stop during a change is', async () => {
  const dir = path.join(root, 'stubs');
  // --- a read in flight
  let started;
  const readSession = sessionWith(async (name, args, options) => { await options.onDecision({ name, allowed: true, category: 'read', kind: null }); started = true; await blockUntilAborted(options.signal); });
  const reader = new AgentRunner({ manager: stubManager(readSession), provider: scriptedModel([() => [call('desktop-commander.list_directory')]]), taskDirectory: path.join(dir, 'read') });
  const first = await reader.start({ prompt: 'Liệt kê thư mục.' });
  await until(() => started, { label: 'the read to start' });
  let live = reader.get(first.id);
  equal([live.state, live.pendingCall.phase, live.pendingCall.readOnly], ['planning', 'executing', true], 'while a read runs the task is still planning, and the call is marked read-only');
  const stopped = await reader.cancel(first.id);
  equal([stopped.status, stopped.state, stopped.pendingCall, stopped.unverifiedCount], ['cancelled', 'cancelled', null, 0], 'stopping during a read leaves nothing unconfirmed');
  equal(path_(stopped), ['created', 'queued', 'planning', 'cancelled'], 'history of a stopped read');
  check(!/Không tự chạy lại/.test(stopped.error), 'the message does not warn about an operation that cannot have changed anything');

  // --- a change in flight
  started = false;
  const writeSession = sessionWith(async (name, args, options) => { await options.onDecision({ name, allowed: true, category: 'workspace_edit', kind: null }); started = true; await blockUntilAborted(options.signal); });
  const model = scriptedModel([() => [call('desktop-commander.write_file', { path: 'a.txt' })]]);
  const writer = new AgentRunner({ manager: stubManager(writeSession), provider: model, taskDirectory: path.join(dir, 'write') });
  const second = await writer.start({ prompt: 'Ghi file.' });
  await until(() => started, { label: 'the change to start' });
  live = writer.get(second.id);
  equal([live.state, live.pendingCall.phase, live.pendingCall.readOnly], ['running', 'executing', undefined], 'while a change runs the task is running');
  const killed = await writer.cancel(second.id);
  equal([killed.status, killed.state, killed.pendingCall?.toolName], ['cancelled', 'uncertain', 'desktop-commander.write_file'], 'stopping during a change is uncertain and keeps the call on record');
  equal(path_(killed), ['created', 'queued', 'planning', 'running', 'uncertain'], 'history of a stopped change');
  equal(reasons(killed), ['task_created', 'start_requested', 'preflight_done', 'act:desktop-commander.write_file', 'user_cancelled'], 'with the reason for each step');
  check(/Không tự chạy lại/.test(killed.error), 'the message says the operation will not be repeated');
  equal(killed.runs.at(-1).state, 'uncertain', 'the run record carries the state too');
  equal(held, null, 'the workspace lock is released');

  // --- the same conversation can be continued; the unknown call is carried as unconfirmed, and finishing is `completed`
  const followUp = scriptedModel([() => [say('Đã kiểm tra lại thư mục, không lặp lại thao tác ghi.')]]);
  const continuing = new AgentRunner({ manager: stubManager(writeSession), provider: followUp, taskDirectory: path.join(dir, 'write') });
  await continuing.load();
  equal([continuing.get(second.id).state, continuing.get(second.id).status], ['uncertain', 'cancelled'], 'after a restart the task is still uncertain');
  await continuing.continue({ id: second.id, prompt: 'Kiểm tra rồi tiếp tục.' });
  const done = await finished(continuing, second.id);
  equal([done.status, done.state], ['completed', 'completed'], 'the follow-up completes');
  equal(path_(done).slice(-4), ['uncertain', 'queued', 'planning', 'completed'], 'uncertain → queued → planning → completed');
  equal([done.unverifiedCount, done.unverifiedOperations[0].toolName, done.pendingCall], [1, 'desktop-commander.write_file', null], 'the unconfirmed call is carried forward, not replayed');
  check(JSON.stringify(followUp.inputs[0]).includes('desktop-commander.write_file'), 'and the model is told about it');

  // --- a tool that breaks mid-call: failed with a call in flight is uncertain too
  started = false;
  const broken = sessionWith(async (name, args, options) => { await options.onDecision({ name, allowed: true, category: 'workspace_edit', kind: null }); throw new Error('connection reset'); });
  const crasher = new AgentRunner({ manager: stubManager(broken), provider: scriptedModel([() => [call('desktop-commander.write_file', { path: 'b.txt' })]]), taskDirectory: path.join(dir, 'broken') });
  const third = await crasher.start({ prompt: 'Ghi file khác.' });
  const crashed = await finished(crasher, third.id);
  equal([crashed.status, crashed.errorCode, crashed.state], ['failed', 'tool_transport_failed', 'uncertain'], 'a lost connection during a change is uncertain, not just failed');

  // --- a refused call and an ordinary failure
  const refusing = sessionWith(async (name, args, options) => { await options.onDecision({ name, allowed: false, category: 'workspace_edit', kind: null }); return { isError: true, content: [{ type: 'text', text: 'Permission denied' }], structuredContent: { executed: false } }; });
  const polite = new AgentRunner({ manager: stubManager(refusing), provider: scriptedModel([() => [call('desktop-commander.write_file', { path: 'c.txt' })], () => [say('Không được phép ghi.')]]), taskDirectory: path.join(dir, 'refused') });
  const fourth = await polite.start({ prompt: 'Ghi file thứ ba.' });
  const refused = await finished(polite, fourth.id);
  equal([refused.status, refused.state, refused.pendingCall], ['completed', 'completed', null], 'a refusal is a result the model can answer; the task completes');
  equal(path_(refused), ['created', 'queued', 'planning', 'completed'], 'and a refused change never made the task look like it was working');

  const limited = new AgentRunner({ manager: stubManager(sessionWith(async (name, args, options) => { await options.onDecision({ name, allowed: true, category: 'read', kind: null }); return { content: [{ type: 'text', text: '[]' }] }; })), provider: scriptedModel([() => [call('desktop-commander.list_directory')], () => [call('desktop-commander.list_directory')], () => [say('không bao giờ tới')]]), taskDirectory: path.join(dir, 'limit') });
  const fifth = await limited.start({ prompt: 'Lặp lại.', maxSteps: 2 });
  const capped = await finished(limited, fifth.id);
  equal([capped.status, capped.errorCode, capped.state], ['limit', 'step_limit', 'paused'], 'running out of steps is a pause that can be continued');
  const failing = new AgentRunner({ manager: stubManager(() => { throw new Error('không nối được công cụ'); }), provider: scriptedModel([]), taskDirectory: path.join(dir, 'preflight') });
  await assert.rejects(() => failing.start({ prompt: 'Không thể bắt đầu.' }), /không nối được công cụ/); checks += 1;
  const [only] = failing.state().tasks;
  equal([only.status, only.state], ['failed', 'failed'], 'a task that cannot even start fails');
  equal(held, null, 'and releases the lock');
});

// ==================================================================== 5. the real guard, real tools, real files
function git(cwd, args) {
  const result = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}
async function project(name) {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'calc.js'), 'exports.add = (a, b) => a - b;\n');
  await fs.writeFile(path.join(dir, 'check.js'), "const { add } = require('./calc.js');\nif (add(2, 3) !== 5) { console.error('FAIL'); process.exit(1); }\nconsole.log('OK 1 test');\n");
  await fs.writeFile(path.join(dir, 'package.json'), `${JSON.stringify({ name: 'demo', version: '1.0.0', scripts: { test: 'node check.js' } }, null, 2)}\n`);
  await fs.writeFile(path.join(dir, 'slow.js'), "const fs = require('fs');\nfs.writeFileSync('started.txt', '1');\nsetTimeout(() => { fs.writeFileSync('finished.txt', '1'); }, 4000);\n");
  await fs.writeFile(path.join(dir, '.gitignore'), 'started.txt\nfinished.txt\n');
  git(dir, ['init', '-q']); git(dir, ['add', '-A']); git(dir, ['commit', '-q', '-m', 'initial']);
  return dir;
}
const logs = [];
manager = new HubManager({ dataDirectory: path.join(root, 'hub-data'), bundleRoot, log: (line) => logs.push(line) });
assembleStudio(manager, { bundleRoot });
await manager.permissions.load();
await manager.load();
const tool = (name, args = {}) => ({ kind: 'tool', name, args });
function hubModel(steps) {
  let turn = 0;
  let counter = 0;
  return {
    snapshot: () => ({ model: 'scripted-1', provider: 'scripted' }), ready: () => true, redact: (text) => text, state: () => ({ provider: 'scripted', model: 'scripted-1', configured: true }),
    async respond({ signal }) {
      signal?.throwIfAborted();
      const produce = steps[turn];
      turn += 1;
      if (!produce) throw new Error(`The script has no step ${turn}.`);
      const out = await produce();
      return {
        status: 'completed', usage: { input_tokens: 1, output_tokens: 1 },
        output: out.map((item) => item.kind === 'tool'
          ? { type: 'function_call', call_id: `call_${(counter += 1)}`, name: item.name, arguments: JSON.stringify(item.args), status: 'completed' }
          : { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: item.text }] }),
      };
    },
  };
}
const hubAgent = (model, name) => new AgentRunner({ manager, provider: model, taskDirectory: path.join(manager.hubDirectory, 'api-tasks', name), log: () => {} });
const finalText = (text) => ({ kind: 'say', text });

await section('autonomous run: planning → running → verifying → running → completed', async () => {
  const dir = await project('fix');
  await manager.selectWorkspace(dir);
  manager.permissions.configure({ mode: 'autonomous', executionPolicy: 'host-review' });
  const model = hubModel([
    () => [tool('read_file', { path: 'calc.js' })],
    () => [tool('edit_file', { path: 'calc.js', old_string: 'a - b', new_string: 'a + b' })],
    () => [tool('run_command', { command: 'npm test', description: 'Chạy test' })],
    () => [finalText('Đã sửa calc.js và `npm test` qua.')],
  ]);
  const agent = hubAgent(model, 'fix');
  const started = await agent.start({ prompt: 'Sửa add.' });
  equal(agent.get(started.id).state, 'planning', 'a started task is planning until it acts');
  const done = await finished(agent, started.id);
  equal([done.status, done.state], ['completed', 'completed'], `completed (${done.error ?? ''})`);
  equal(path_(done), ['created', 'queued', 'planning', 'running', 'verifying', 'running', 'completed'], 'the life cycle of a fix');
  equal(reasons(done), ['task_created', 'start_requested', 'preflight_done', 'act:local.edit_file', 'check:local.run_command', 'check_finished', 'final_answer'], 'with the reason for each step');
  check((await fs.readFile(path.join(dir, 'calc.js'), 'utf8')).includes('a + b'), 'the file really changed');
  check(done.events.every((event) => typeof event.state === 'string'), 'every timeline event carries the state it happened in');
  equal(done.events.find((event) => event.type === 'tool_start' && /read_file/.test(event.message)).state, 'planning', 'a read happened while planning');
  equal(done.events.find((event) => event.type === 'tool_start' && /edit_file/.test(event.message)).state, 'planning', 'the state changes when the guard decides, after the call is announced');
  const saved = JSON.parse(await fs.readFile(path.join(agent.taskDirectory, started.id, 'task.json'), 'utf8'));
  equal([saved.state, saved.stateHistory.length, saved.runs[0].state], ['completed', 7, 'completed'], 'the file on disk agrees');
  check(new RegExp('Hoàn tất \\(completed\\)').test(await agent.report(started.id)), 'the report names the state');
  equal(manager.taskId, null, 'the lock is released');
  equal(manager.permissions.listeners.size, 0, 'the runner stops watching the permission gate when its run ends');
});

await section('review mode: waiting_approval is visible, and nothing has run while it is', async () => {
  const dir = await project('review');
  await manager.selectWorkspace(dir);
  manager.permissions.configure({ mode: 'review' });
  const target = path.join(dir, 'notes.md');
  const model = hubModel([() => [tool('write_file', { path: 'notes.md', content: '# Ghi chú\n' })], () => [finalText('Đã tạo notes.md.')]]);
  const agent = hubAgent(model, 'review-approve');
  const taskJson = (id) => path.join(agent.taskDirectory, id, 'task.json');
  // What is on disk when the guard lets the write through: the "waiting" marker must be gone by then.
  const original = manager.localTools.call.bind(manager.localTools);
  const onDiskWhenRun = [];
  manager.localTools.call = async (name, args, options) => {
    if (name === 'local.write_file') onDiskWhenRun.push(JSON.parse(await fs.readFile(taskJson(options.taskId), 'utf8')).pendingCall?.phase ?? null);
    return original(name, args, options);
  };
  try {
    const started = await agent.start({ prompt: 'Tạo notes.md.' });
    const request = await until(() => manager.permissions.state().pending[0], { label: 'the approval request' });
    equal(request.taskId, started.id, 'the request belongs to the task');
    const waiting = agent.get(started.id);
    equal([waiting.state, waiting.pendingCall.phase, waiting.stateReason], ['waiting_approval', 'awaiting_approval', 'approval:local.write_file'], 'the task shows that it is waiting for a person');
    equal(agent.state().tasks.find((item) => item.id === started.id).state, 'waiting_approval', 'the task list shows it too');
    await assert.rejects(() => fs.access(target)); checks += 1;
    // The marker reaches the disk while the person decides.
    await until(async () => JSON.parse(await fs.readFile(taskJson(started.id), 'utf8')).pendingCall?.phase === 'awaiting_approval', { label: 'the waiting marker on disk' });
    // A Hub that dies right now must not claim the write may have happened: copy the files as they are and load them.
    const crashDir = path.join(root, 'crash-while-waiting');
    await agent.writes.get(started.id)?.catch(() => {}); // let the in-flight write finish so the copy is a consistent picture
    await fs.cp(agent.taskDirectory, crashDir, { recursive: true });
    const survivor = new AgentRunner({ manager: stubManager(() => { throw new Error('unused'); }), provider: idleProvider, taskDirectory: crashDir });
    await survivor.load();
    const recovered = survivor.get(started.id);
    equal([recovered.status, recovered.state, recovered.pendingCall, recovered.unverifiedCount], ['paused', 'paused', null, 0], 'after a crash while waiting, the task is paused, not uncertain: the write never ran');
    check(/local\.write_file chưa được chạy/.test(recovered.error), 'and the message says the write was not run');
    await assert.rejects(() => fs.access(target)); checks += 1;

    // Make the disk slow for a moment: the guard must still wait until the record no longer says "waiting" before the
    // write is allowed to run (this is what an approval followed by a crash depends on).
    agent.writes.set(started.id, (agent.writes.get(started.id) ?? Promise.resolve()).catch(() => {}).then(() => sleep(300)));
    manager.permissions.decide(request.id, true);
    const done = await finished(agent, started.id);
    equal([done.status, done.state, done.pendingCall], ['completed', 'completed', null], `completed after approval (${done.error ?? ''})`);
    equal(path_(done), ['created', 'queued', 'planning', 'waiting_approval', 'running', 'completed'], 'planning → waiting_approval → running → completed');
    equal(reasons(done).slice(3, 5), ['approval:local.write_file', 'approval_approved'], 'the reasons name the approval');
    equal(onDiskWhenRun, ['executing'], 'by the time the write ran, the disk no longer said "waiting for approval"');
    check((await fs.readFile(target, 'utf8')).includes('Ghi chú'), 'the approved write happened');
    const transcript = await fs.readFile(path.join(agent.taskDirectory, started.id, 'transcript.jsonl'), 'utf8');
    check(transcript.includes('"type":"state"') && transcript.includes('"type":"tool_decision"'), 'the audit transcript records the approval steps');
  } finally { manager.localTools.call = original; }
});

await section('review mode: a denial returns the task to where it was', async () => {
  const dir = await project('deny');
  await manager.selectWorkspace(dir);
  manager.permissions.configure({ mode: 'review' });
  const model = hubModel([() => [tool('write_file', { path: 'no.md', content: 'x' })], () => [finalText('Không được phép ghi file.')]]);
  const agent = hubAgent(model, 'review-deny');
  const started = await agent.start({ prompt: 'Tạo no.md.' });
  const request = await until(() => manager.permissions.state().pending[0], { label: 'the approval request' });
  manager.permissions.decide(request.id, false);
  const done = await finished(agent, started.id);
  equal([done.status, done.state, done.pendingCall], ['completed', 'completed', null], 'the model saw the denial and finished');
  equal(path_(done), ['created', 'queued', 'planning', 'waiting_approval', 'planning', 'completed'], 'a denial goes back to planning: nothing has been done yet');
  equal(reasons(done)[4], 'approval_denied', 'and says why');
  await assert.rejects(() => fs.access(path.join(dir, 'no.md'))); checks += 1;
});

await section('stopping a task that waits for approval: cancelled, and the write never ran', async () => {
  const dir = await project('cancel-wait');
  await manager.selectWorkspace(dir);
  manager.permissions.configure({ mode: 'review' });
  const model = hubModel([() => [tool('write_file', { path: 'late.md', content: 'x' })]]);
  const agent = hubAgent(model, 'cancel-wait');
  const started = await agent.start({ prompt: 'Tạo late.md.' });
  await until(() => manager.permissions.state().pending[0], { label: 'the approval request' });
  equal(agent.get(started.id).state, 'waiting_approval', 'waiting');
  const stopped = await agent.cancel(started.id);
  equal([stopped.status, stopped.state, stopped.pendingCall, stopped.unverifiedCount], ['cancelled', 'cancelled', null, 0], 'cancelled, with nothing unconfirmed: the call was still waiting');
  check(/local\.write_file chưa được chạy/.test(stopped.error) && !/Không tự chạy lại/.test(stopped.error), 'the message says the write was not run');
  equal(path_(stopped).slice(-3), ['waiting_approval', 'planning', 'cancelled'], 'the approval was withdrawn before the task ended');
  equal(manager.permissions.state().pending.length, 0, 'no request is left open');
  equal(manager.taskId, null, 'the lock is released');
  equal(manager.permissions.listeners.size, 0, 'and the runner stopped watching the gate');
  await assert.rejects(() => fs.access(path.join(dir, 'late.md'))); checks += 1;
});

await section('stopping a running command: uncertain, and the command is not repeated', async () => {
  const dir = await project('cancel-run');
  await manager.selectWorkspace(dir);
  manager.permissions.configure({ mode: 'autonomous' });
  const model = hubModel([() => [tool('run_command', { command: 'node slow.js', description: 'Script chậm' })]]);
  const agent = hubAgent(model, 'cancel-run');
  const started = await agent.start({ prompt: 'Chạy slow.js.' });
  await until(() => fs.access(path.join(dir, 'started.txt')).then(() => true, () => false), { label: 'the script to start' });
  equal(agent.get(started.id).state, 'verifying', 'a project command is being verified while it runs');
  const stopped = await agent.cancel(started.id);
  equal([stopped.status, stopped.state, stopped.pendingCall?.toolName], ['cancelled', 'uncertain', 'local.run_command'], 'stopping mid-command is uncertain and keeps the command on record');
  equal(path_(stopped).slice(-3), ['planning', 'verifying', 'uncertain'], 'planning → verifying → uncertain');
  check(/Không tự chạy lại/.test(stopped.error), 'the message says it will not run again');
  equal(manager.taskId, null, 'the lock is released');

  // A restart afterwards agrees.
  const reloaded = hubAgent(hubModel([]), 'cancel-run');
  await reloaded.load();
  equal([reloaded.get(started.id).state, reloaded.get(started.id).status], ['uncertain', 'cancelled'], 'after a restart the task is still uncertain');
  manager.permissions.configure({ mode: 'review' });
});

console.log(`PASS ${checks} task state checks: the table, the evidence rules, the gate's watchers, recovery of older and mid-run files, real approvals and real stops`);
} finally {
  await manager?.stop?.().catch(() => {});
  manager?.permissions?.shutdown();
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}
