import test from 'node:test';
import assert from 'node:assert/strict';
import { awaitingCheckWorkers, delegationTarget, grantState } from '../src/lib/agent-proof.ts';

// What is left of the coding-worker logic on this page, which no longer starts, reviews or merges workers: which workers may be waiting for the owner to
// allow a test command, whether the folder in view is the Hub's own, and whether a permission the owner gave still stands.

const worker = (overrides = {}) => ({ id: 'task-a', status: 'ready_for_review', branch: 'chatmcp/coder/x/task-a', verifyRequired: false, ...overrides });

test('only a worker that asked for verification and is mid-run can have checks to grant (no 404 polling for the rest)', () => {
  const job = { workers: [
    worker({ id: 'plain', status: 'running' }),
    worker({ id: 'wants', status: 'running', verifyRequired: true }),
    worker({ id: 'waiting', status: 'awaiting_test_grant', verifyRequired: true }),
    worker({ id: 'testing', status: 'testing', verifyRequired: true }),
    worker({ id: 'done', status: 'ready_for_review', verifyRequired: true }),
    worker({ id: 'queued', status: 'queued', verifyRequired: true }),
  ] };
  assert.deepEqual(awaitingCheckWorkers(job).map(item => item.id), ['wants', 'waiting', 'testing']);
  assert.deepEqual(awaitingCheckWorkers(null), []);
  assert.deepEqual(awaitingCheckWorkers({}), []);
});

test('the second workspace case: coding workers act on the Hub’s primary folder, not the one being viewed', () => {
  assert.deepEqual(delegationTarget({ selectedWorkspacePath: '/a', primaryPath: '/a' }), { blocked: false, primary: '/a', viewing: '/a' });
  assert.deepEqual(delegationTarget({ selectedWorkspacePath: '/b', primaryPath: '/a' }), { blocked: true, primary: '/a', viewing: '/b' });
  // nothing selected: the Hub’s active folder is what is being viewed
  assert.equal(delegationTarget({ selectedWorkspacePath: '', activePath: '/a', primaryPath: '/a' }).blocked, false);
  assert.equal(delegationTarget({ selectedWorkspacePath: '', activePath: '/b', primaryPath: '/a' }).blocked, true);
  // either side unknown: nothing to compare, nothing blocked (same rule as the work panel)
  assert.equal(delegationTarget({ selectedWorkspacePath: '/b' }).blocked, false);
  assert.equal(delegationTarget({ primaryPath: '/a' }).blocked, false);
});

test('an allowed check counts until the Hub’s grant runs out; one that was never allowed, or whose time has passed, does not', () => {
  const now = 1_000_000;
  assert.equal(grantState(undefined, now), 'none');
  assert.equal(grantState(null, now), 'none');
  assert.equal(grantState({ expiresAt: now + 1, maxAttempts: 3 }, now), 'active');
  assert.equal(grantState({ expiresAt: now, maxAttempts: 3 }, now), 'expired', 'at the very moment it runs out it is over');
  assert.equal(grantState({ expiresAt: now - 5000, maxAttempts: 3 }, now), 'expired');
  assert.equal(grantState({ expiresAt: Number.NaN, maxAttempts: 3 }, now), 'expired', 'a time nobody can read is not a permission');
  assert.equal(grantState({ maxAttempts: 3 }, now), 'expired');
});
