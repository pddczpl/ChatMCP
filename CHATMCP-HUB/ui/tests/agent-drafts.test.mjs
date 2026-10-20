import test from 'node:test';
import assert from 'node:assert/strict';
import { useAgentDrafts, clampConcurrency } from '../src/store/useAgentDrafts.ts';

// What the owner typed in the Agents tab survives a visit to another work-panel tab (the panel unmounts the tab it leaves).

test('a draft starts empty, with the hand-made group and the coding tasks not yet created', () => {
  const drafts = useAgentDrafts.getInitialState().defaults();
  assert.equal(drafts.goal, '');
  assert.equal(drafts.codingGoal, '');
  assert.equal(drafts.groupNodes, null);
  assert.equal(drafts.codingTasks, null);
  assert.equal(drafts.codingModelAssist, false);
  assert.equal(drafts.codingPlanCount, null);
  assert.ok(drafts.groupConcurrency >= 1 && drafts.groupConcurrency <= 3);
  assert.ok(drafts.codingConcurrency >= 1 && drafts.codingConcurrency <= 2);
});

test('set merges a change into the draft and leaves the rest', () => {
  useAgentDrafts.setState(useAgentDrafts.getInitialState().defaults());
  useAgentDrafts.getState().set({ goal: 'Find the slow query' });
  useAgentDrafts.getState().set({ codingGoal: 'Add a README section' });
  const state = useAgentDrafts.getState();
  assert.equal(state.goal, 'Find the slow query');
  assert.equal(state.codingGoal, 'Add a README section');
  assert.equal(state.codingModelAssist, false);
});

test('the defaults are new objects each time, so one draft cannot leak into another', () => {
  const one = useAgentDrafts.getInitialState().defaults();
  const two = useAgentDrafts.getInitialState().defaults();
  assert.notEqual(one, two);
  one.goal = 'changed';
  assert.equal(two.goal, '');
});

test('the number of helpers or tasks at once is kept inside what the Hub accepts', () => {
  assert.equal(clampConcurrency(0, 3), 1);
  assert.equal(clampConcurrency(2, 3), 2);
  assert.equal(clampConcurrency(9, 3), 3);
  assert.equal(clampConcurrency(9, 2), 2);
  assert.equal(clampConcurrency(Number.NaN, 2), 2);
  assert.equal(clampConcurrency(1.7, 3), 1);
});
