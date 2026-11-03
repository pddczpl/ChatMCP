import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeTask, isTaskActive, taskTimeline, normalizeApproval } from '../src/lib/task-view.ts';

const at = (second) => `2026-10-12T00:00:${String(second).padStart(2, '0')}Z`;

test('native running and limit states control stop/continue correctly', () => {
  const running = normalizeTask({ id: 'one', status: 'running', state: 'waiting_approval', prompt: 'Fix bug' });
  assert.equal(running.status, 'waiting_approval');
  assert.equal(running.runnerStatus, 'running');
  assert.equal(isTaskActive(running), true);
  assert.equal(normalizeTask({ id: 'two', status: 'limit' }).status, 'paused');
  assert.equal(isTaskActive(normalizeTask({ id: 'two', status: 'cancelled' })), false);
});

test('dialogue retains repeated real turns, assistant commentary and ordered tool evidence', () => {
  const task = normalizeTask({ id: 'one', prompt: 'Fix bug', status: 'completed', finalText: 'Done',
    dialogue: [{ role: 'user', text: 'Fix bug', at: at(0), run: 1 }, { role: 'assistant', text: 'Done', at: at(5), run: 1 }, { role: 'user', text: 'Again', at: at(10), run: 2 }, { role: 'assistant', text: 'Done', at: at(15), run: 2 }],
    runs: [{ startedAt: at(0) }, { startedAt: at(10) }],
    events: [{ type: 'assistant', message: 'Inspecting files', at: at(1) }, { type: 'tool_start', toolName: 'local.read_file', message: 'Read index.js', at: at(2) }, { type: 'tool_result', toolName: 'local.read_file', message: 'source text', at: at(3) }, { type: 'assistant', message: 'Done', at: at(4) }, { type: 'assistant', message: 'Done', at: at(14) }],
  });
  assert.deepEqual(task.messages.map(m => [m.role, m.content]), [['user', 'Fix bug'], ['assistant', 'Inspecting files'], ['assistant', 'Done'], ['user', 'Again'], ['assistant', 'Done']]);
  assert.equal(task.toolCalls[0].result, 'source text');
  assert.equal(task.toolCalls[0].status, 'success');
  assert.deepEqual(taskTimeline(task).map(item => item.kind), ['message', 'message', 'tool', 'message', 'message', 'message']);
});

test('stored prompts and runs recover history without presenting errors as assistant success', () => {
  const task = normalizeTask({ id: 'legacy', status: 'failed', prompts: [{ text: 'First', at: at(0) }, { text: 'Next', at: at(10) }], runs: [{ status: 'completed', startedAt: at(0), finishedAt: at(5), finalText: 'First answer' }, { status: 'failed', startedAt: at(10), finishedAt: at(15), finalText: 'Network error' }] });
  assert.deepEqual(task.messages.map(m => [m.role, m.content]), [['user', 'First'], ['assistant', 'First answer'], ['user', 'Next'], ['system', 'Network error']]);
  assert.deepEqual(normalizeTask({ id: 'empty', status: 'paused' }).messages, []);
});

test('unfinished tool receipt after stop is unknown and failed command is not success', () => {
  const task = normalizeTask({ id: 'one', status: 'cancelled', events: [{ type: 'tool_start', toolName: 'local.write_file', message: 'Write', at: at(0) }, { type: 'tool_start', toolName: 'local.run_command', message: 'node test.js', at: at(1) }, { type: 'tool_result', toolName: 'local.run_command', message: '{"exitCode":1,"output":"failed test"}', at: at(2) }] });
  assert.deepEqual(task.toolCalls.map(t => t.status), ['unknown', 'error']);
});

test('continuing a legacy conversation retains earlier runs absent from its newer dialogue', () => {
  const task = normalizeTask({ id: 'legacy', status: 'completed',
    prompts: [{ text: 'Before upgrade', at: at(0) }, { text: 'After upgrade', at: at(10) }],
    runs: [{ status: 'completed', startedAt: at(0), finishedAt: at(5), finalText: 'Earlier answer' }, { status: 'completed', startedAt: at(10), finishedAt: at(15), finalText: 'Latest answer' }],
    dialogue: [{ role: 'user', text: 'After upgrade', at: at(10), run: 2 }, { role: 'assistant', text: 'Latest answer', at: at(15), run: 2 }],
  });
  assert.deepEqual(task.messages.map(m => m.content), ['Before upgrade', 'Earlier answer', 'After upgrade', 'Latest answer']);
});

test('resume does not revive an unresolved old tool or attach a new run result to it', () => {
  const task = normalizeTask({ id: 'resumed', status: 'running',
    runs: [{ startedAt: at(0), status: 'cancelled' }, { startedAt: at(10), status: 'running' }],
    events: [{ type: 'tool_start', toolName: 'local.write_file', message: 'Uncertain old write', at: at(1) },
      { type: 'tool_start', toolName: 'local.read_file', message: 'Inspect current file', at: at(11) }],
  });
  assert.deepEqual(task.toolCalls.map(call => call.status), ['unknown', 'running']);
  const withError = normalizeTask({ id: 'resumed', status: 'running',
    runs: [{ startedAt: at(0), status: 'cancelled' }, { startedAt: at(10), status: 'running' }],
    events: [{ type: 'tool_start', toolName: 'local.write_file', message: 'Uncertain old write', at: at(1) },
      { type: 'tool_error', toolName: 'local.write_file', message: 'New call rejected before execution', at: at(11) }],
  });
  assert.deepEqual(withError.toolCalls.map(call => [call.status, call.result]), [['unknown', undefined], ['error', 'New call rejected before execution']]);
});

test('the Hub clipped final event is replaced by its full recorded answer only in the same run', () => {
  const prefix = 'A'.repeat(12000);
  const answer = `${prefix} complete ending`;
  const preview = `${prefix}\n[Phần còn lại được lưu trong bản ghi trên máy.]`;
  const task = normalizeTask({ id: 'long', status: 'completed', finalText: answer,
    runs: [{ startedAt: at(0), status: 'failed' }, { startedAt: at(10), status: 'completed' }],
    dialogue: [{ role: 'user', text: 'First request', at: at(0), run: 1 }, { role: 'user', text: 'Continue', at: at(10), run: 2 }, { role: 'assistant', text: answer, at: at(15), run: 2 }],
    events: [{ type: 'assistant', message: preview, at: at(1) }, { type: 'assistant', message: 'Separate commentary', at: at(11) }, { type: 'assistant', message: preview, at: at(14) }],
  });
  assert.deepEqual(task.messages.filter(message => message.role === 'assistant').map(message => message.content), [preview, 'Separate commentary', answer]);
  const finalOnly = normalizeTask({ id: 'final-only', status: 'completed', finalText: answer, finishedAt: at(15), events: [{ type: 'assistant', message: preview, at: at(14) }] });
  assert.deepEqual(finalOnly.messages.map(message => message.content), [answer]);
});

test('PermissionGate structured preview maps exactly and terminal decisions remain visible', () => {
  const approval = normalizeApproval({ id: 'a', taskId: 'one', toolName: 'local.edit_file', category: 'workspace_edit', reason: 'Changes project files', summary: 'Edit source', at: at(0), expiresAt: at(50), detail: { kind: 'edit', path: 'index.js', old_string: 'old', new_string: 'new' } });
  assert.equal(approval.tool, 'local.edit_file');
  assert.equal(approval.targetPath, 'index.js');
  assert.equal(approval.oldContent, 'old');
  assert.equal(approval.newContent, 'new');
  assert.equal(approval.risk, 'workspace_edit');
  assert.equal(approval.expiresAt, at(50));
  assert.equal(normalizeApproval({ id: 'a', toolName: 'local.run_command', category: 'execute', decision: 'cancelled', preview: '{"command":"npm test"}' }).decision, 'cancelled');
});

// ---- Tool calls are paired by the id the model gave them (docs/REVIEW-API.md, "Events of a tool call") ----

const started = (second, toolName, callId, input, extra = {}) => ({ type: 'tool_start', toolName, callId, input, message: `Đang gọi ${toolName}.`, at: at(second), ...extra });
const finished = (second, toolName, callId, message, extra = {}) => ({ type: 'tool_result', toolName, callId, message, at: at(second), ...extra });
const errored = (second, toolName, callId, message, extra = {}) => ({ type: 'tool_error', toolName, callId, message, at: at(second), ...extra });
const view = (events, extra = {}) => normalizeTask({ id: 'ids', status: 'completed', runs: [{ startedAt: at(0) }], events, ...extra }).toolCalls;
const summary = (calls) => calls.map(call => [call.callId, call.status, call.result, call.checkpointId]);

test('a result settles the call that has its id, not the last open call of the same tool', () => {
  const calls = view([
    started(1, 'local.edit_file', 'call_a', { path: 'a.js' }),
    started(2, 'local.edit_file', 'call_b', { path: 'b.js' }),
    finished(3, 'local.edit_file', 'call_a', 'edited a', { checkpointId: 'cp-a' }),
    errored(4, 'local.edit_file', 'call_b', 'could not edit b', { checkpointId: 'cp-b' }),
  ]);
  assert.deepEqual(summary(calls), [['call_a', 'success', 'edited a', 'cp-a'], ['call_b', 'error', 'could not edit b', 'cp-b']]);
  assert.deepEqual(calls.map(call => call.args.path), ['a.js', 'b.js'], 'each call keeps the input of its own start');
  assert.deepEqual(calls.map(call => call.durationMs), [2000, 2000], 'the time of a call runs from its own start to its own result');
});

test('results that come in the other order still settle their own calls', () => {
  const calls = view([
    started(1, 'local.edit_file', 'call_a', { path: 'a.js' }),
    started(2, 'local.edit_file', 'call_b', { path: 'b.js' }),
    errored(3, 'local.edit_file', 'call_b', 'could not edit b', { checkpointId: 'cp-b' }),
    finished(4, 'local.edit_file', 'call_a', 'edited a', { checkpointId: 'cp-a' }),
  ]);
  assert.deepEqual(summary(calls), [['call_a', 'success', 'edited a', 'cp-a'], ['call_b', 'error', 'could not edit b', 'cp-b']]);
  assert.deepEqual(calls.map(call => call.durationMs), [3000, 1000]);
});

test('a call that made no checkpoint has none, whatever its neighbours have', () => {
  const calls = view([
    started(1, 'local.read_file', 'call_r', { path: 'a.js' }),
    started(2, 'local.edit_file', 'call_e', { path: 'a.js' }),
    finished(3, 'local.read_file', 'call_r', 'text'),
    finished(4, 'local.edit_file', 'call_e', 'edited', { checkpointId: 'cp-e' }),
  ]);
  assert.deepEqual(calls.map(call => call.checkpointId), [undefined, 'cp-e']);
  assert.equal(Object.hasOwn(calls[0], 'checkpointId'), false, 'the field is absent, not set to undefined');
});

test('a result for a call the page never saw is an entry of its own and settles no other call', () => {
  // The Hub refuses a call it cannot dispatch (an unknown function, bad arguments): that tool_error has an id and no start.
  const calls = view([
    started(1, 'local.write_file', 'call_w', { path: 'w.js' }),
    errored(2, 'local.write_file', 'call_refused', 'invalid arguments'),
    finished(3, 'local.write_file', 'call_w', 'written', { checkpointId: 'cp-w' }),
  ]);
  assert.deepEqual(summary(calls), [['call_w', 'success', 'written', 'cp-w'], ['call_refused', 'error', 'invalid arguments', undefined]]);
});

test('a result for an id that already has its result does not overwrite it', () => {
  const calls = view([started(1, 'local.read_file', 'call_r', { path: 'a.js' }), finished(2, 'local.read_file', 'call_r', 'first'), finished(3, 'local.read_file', 'call_r', 'again')]);
  assert.deepEqual(summary(calls), [['call_r', 'success', 'first', undefined], ['call_r', 'success', 'again', undefined]]);
});

test('the same id in a later run never settles a call that was left open in an earlier run', () => {
  const runs = [{ startedAt: at(0), status: 'cancelled' }, { startedAt: at(10), status: 'completed' }];
  const calls = view([started(1, 'local.write_file', 'call_1', { path: 'a.js' }), finished(11, 'local.write_file', 'call_1', 'late')], { runs });
  assert.deepEqual(summary(calls), [['call_1', 'unknown', undefined, undefined], ['call_1', 'success', 'late', undefined]]);
});

test('a provider that numbers its calls again in every turn still pairs each result with its own start', () => {
  const calls = view([
    started(1, 'local.read_file', 'call_0', { path: 'a.js' }), finished(2, 'local.read_file', 'call_0', 'a text'),
    started(3, 'local.edit_file', 'call_0', { path: 'a.js' }), finished(4, 'local.edit_file', 'call_0', 'a edited', { checkpointId: 'cp-1' }),
    started(5, 'local.read_file', 'call_0', { path: 'b.js' }), finished(6, 'local.read_file', 'call_0', 'b text'),
  ]);
  assert.deepEqual(calls.map(call => [call.name, call.args.path, call.result, call.checkpointId]), [
    ['local.read_file', 'a.js', 'a text', undefined], ['local.edit_file', 'a.js', 'a edited', 'cp-1'], ['local.read_file', 'b.js', 'b text', undefined],
  ]);
});

test('a call without a result is running while its run is, and unknown once the task has stopped', () => {
  const events = [started(1, 'local.run_command', 'call_c', { command: 'npm test' })];
  assert.equal(view(events, { status: 'running' })[0].status, 'running');
  assert.equal(view(events, { status: 'cancelled' })[0].status, 'unknown');
});

test('a result that comes before its start does not throw and loses neither event', () => {
  const calls = view([finished(1, 'local.read_file', 'call_r', 'text'), started(2, 'local.read_file', 'call_r', { path: 'a.js' })]);
  assert.deepEqual(summary(calls), [['call_r', 'success', 'text', undefined], ['call_r', 'unknown', undefined, undefined]]);
});

test('an id that is not text is no id: the result is paired by tool name, and an event without a tool name is skipped', () => {
  const calls = view([
    started(1, 'local.read_file', 'call_1', { path: 'a.js' }), finished(2, 'local.read_file', 42, 'a number'),
    started(3, 'local.read_file', 'call_2', { path: 'b.js' }), finished(4, 'local.read_file', '', 'an empty string'),
    started(5, 'local.read_file', 'call_3', { path: 'c.js' }), finished(6, 'local.read_file', null, 'null'),
    { type: 'tool_result', message: 'no tool name', at: at(7) },
  ]);
  assert.deepEqual(summary(calls), [['call_1', 'success', 'a number', undefined], ['call_2', 'success', 'an empty string', undefined], ['call_3', 'success', 'null', undefined]]);
});

test('a result without an id is paired by tool name, even with a start that has one', () => {
  const calls = view([started(1, 'local.read_file', 'call_r', { path: 'a.js' }), finished(2, 'local.read_file', undefined, 'text')]);
  assert.deepEqual(summary(calls), [['call_r', 'success', 'text', undefined]]);
});

test('an orphan result keeps its own id, input and checkpoint', () => {
  const [orphan] = view([finished(1, 'local.edit_file', 'call_x', 'edited', { input: { path: 'x.js' }, checkpointId: 'cp-x' })]);
  assert.deepEqual([orphan.callId, orphan.args, orphan.checkpointId, orphan.status], ['call_x', { path: 'x.js' }, 'cp-x', 'success']);
});

test('a task saved before the Hub sent call ids renders exactly as it did with the name-based pairing', () => {
  const fixture = JSON.parse(readFileSync(new URL('./support/task-before-call-ids.json', import.meta.url), 'utf8'));
  for (const status of ['completed', 'running']) {
    const task = normalizeTask({ ...fixture.task, status });
    assert.deepEqual(JSON.parse(JSON.stringify(task.toolCalls)), fixture.expected[status].toolCalls, `tool calls (${status})`);
    assert.deepEqual(taskTimeline(task).map(item => `${item.kind}:${item.value.id ?? ''}`), fixture.expected[status].timeline, `timeline (${status})`);
    assert.ok(task.toolCalls.every(call => call.callId === undefined && call.checkpointId === undefined), 'no id is invented');
  }
});
