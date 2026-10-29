// The dashboard's copy of the task vocabulary (ui/src/lib/ui-logic.ts) must not drift from the Hub's (lib/task-state.mjs, lib/permissions.mjs).
// This replaces the "one vocabulary" and "task state presentation" sections of the removed tests/verify-ui-logic.mjs, which tested web/ui-logic.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTIVE_STATES, TASK_STATES, TASK_STATE_INFO } from '../../lib/task-state.mjs';
import { PERMISSION_MODES as HUB_MODES } from '../../lib/permissions.mjs';
import { ACTIVE, PERMISSION_MODES, STATES, describeTask, isActiveState, taskState } from '../src/lib/ui-logic.ts';

const plain = (value) => JSON.parse(JSON.stringify(value));

test('the page knows exactly the Hub task states, in the same order, with the same label, tone and hint', () => {
  assert.deepEqual(Object.keys(STATES), [...TASK_STATES]);
  for (const state of TASK_STATES) assert.deepEqual(plain(STATES[state]), plain(TASK_STATE_INFO[state]), state);
});

test('the same states count as "a run is in progress"', () => {
  assert.deepEqual([...ACTIVE].sort(), [...ACTIVE_STATES].sort());
  for (const state of TASK_STATES) assert.equal(isActiveState(state), ACTIVE_STATES.has(state), state);
});

test('permission modes match the gate, in the same order', () => {
  assert.deepEqual(PERMISSION_MODES.map((mode) => mode.id), [...HUB_MODES]);
});

test('a task is shown by its own state, never by the legacy status', () => {
  for (const state of TASK_STATES) {
    const view = describeTask({ state, status: 'running' });
    assert.deepEqual([view.state, view.label, view.hint], [state, TASK_STATE_INFO[state].label, TASK_STATE_INFO[state].hint], state);
  }
  assert.equal(describeTask({ state: 'uncertain', status: 'failed' }).state, 'uncertain');
  assert.equal(describeTask({ state: 'waiting_approval', status: 'running' }).kind, 'attention');
});

test('records saved before task states existed fall back to their status', () => {
  const legacy = { preparing: 'queued', queued: 'queued', running: 'running', completed: 'completed', cancelled: 'cancelled', failed: 'failed', paused: 'paused', interrupted: 'paused', limit: 'paused' };
  for (const [status, state] of Object.entries(legacy)) assert.equal(taskState({ status }), state, status);
  assert.equal(describeTask({ status: 'limit' }).label, 'Đạt giới hạn');
  assert.equal(describeTask({ status: 'interrupted' }).label, 'Gián đoạn');
  assert.equal(taskState({ state: 'nonsense', status: 'completed' }), 'completed');
  for (const bad of [null, undefined, 'x', 3, [], {}, { status: 'weird' }]) assert.equal(taskState(bad), null, JSON.stringify(bad));
  assert.equal(describeTask(null).label, 'Sẵn sàng');
});
