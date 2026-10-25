import test from 'node:test';
import assert from 'node:assert/strict';
import { useCheckGrants } from '../src/store/useCheckGrants.ts';

// What the Hub answered when the owner allowed a test command survives a visit to another work-panel tab (the panel unmounts the tab it leaves).

test('what the Hub answered when a check was allowed is kept by worker and check, and a fresh store remembers none', () => {
  useCheckGrants.setState(useCheckGrants.getInitialState());
  assert.deepEqual(useCheckGrants.getState().checkGrants, {});
  useCheckGrants.getState().rememberGrant('w1:c1', { expiresAt: 5, maxAttempts: 3 });
  useCheckGrants.getState().rememberGrant('w1:c2', { expiresAt: 9, maxAttempts: 2 });
  useCheckGrants.getState().rememberGrant('w1:c1', { expiresAt: 7, maxAttempts: 3 });
  assert.deepEqual(useCheckGrants.getState().checkGrants, { 'w1:c1': { expiresAt: 7, maxAttempts: 3 }, 'w1:c2': { expiresAt: 9, maxAttempts: 2 } });
  assert.deepEqual(useCheckGrants.getInitialState().checkGrants, {}, 'the starting state is not touched by what was remembered');
});

test('a grant of one worker never takes the place of the same check of another', () => {
  useCheckGrants.setState(useCheckGrants.getInitialState());
  useCheckGrants.getState().rememberGrant('w1:c1', { expiresAt: 5, maxAttempts: 3 });
  useCheckGrants.getState().rememberGrant('w2:c1', { expiresAt: 8, maxAttempts: 1 });
  assert.deepEqual(Object.keys(useCheckGrants.getState().checkGrants).sort(), ['w1:c1', 'w2:c1']);
  assert.equal(useCheckGrants.getState().checkGrants['w1:c1'].expiresAt, 5);
});
