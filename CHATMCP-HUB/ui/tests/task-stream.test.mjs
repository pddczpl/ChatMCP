import test from 'node:test';
import assert from 'node:assert/strict';
import { handleTaskStreamEvent } from '../src/lib/task-stream.ts';

test('tokens are scoped to their conversation; persisted events invalidate actual task data', () => {
  const calls = [];
  const sink = { selectedTaskId: () => 'selected', append: (id, text) => calls.push(['token', id, text]), clear: () => calls.push(['clear']), refresh: (id) => calls.push(['refresh', id]) };
  handleTaskStreamEvent({ type: 'token', taskId: 'other', token: 'private other text' }, sink);
  handleTaskStreamEvent({ type: 'token', taskId: 'selected', token: 'hello' }, sink);
  handleTaskStreamEvent({ type: 'event', taskId: 'selected', event: { type: 'assistant' } }, sink);
  assert.deepEqual(calls, [['token', 'selected', 'hello'], ['clear'], ['refresh', 'selected']]);
});

test('completion clears partial text; malformed events cannot create messages', () => {
  const calls = [];
  const sink = { selectedTaskId: () => 'one', append: () => calls.push('token'), clear: () => calls.push('clear'), refresh: (id) => calls.push(id) };
  for (const value of [null, {}, { type: 'token', token: 3 }, { type: 'token', taskId: 'one', token: {} }]) handleTaskStreamEvent(value, sink);
  handleTaskStreamEvent({ type: 'state', taskId: 'one', state: 'cancelled' }, sink);
  assert.deepEqual(calls, ['clear', 'one']);
});
