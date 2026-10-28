import test from 'node:test';
import assert from 'node:assert/strict';
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
