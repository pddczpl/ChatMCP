import test from 'node:test';
import assert from 'node:assert/strict';
import { assessWorker, assessReport, awaitingCheckWorkers, canMerge, canPublishMerge, codingBlock, delegationTarget, statusTone } from '../src/lib/agent-proof.ts';

// "Reported done" is not "proven done" (see proof.test.mjs for a conversation turn). A coding worker is a model: what it says about itself is its
// own claim. The only thing that turns a worker green is a check the Hub itself ran and verified; every other path must stay below success.

const attempt = (overrides = {}) => ({ id: 'a1', checkId: 'test-1', status: 'completed', exitCode: 0, testOutcomeVerified: true, snapshotHash: 'a'.repeat(64), ...overrides });
const worker = (overrides = {}) => ({ id: 'task-a', status: 'ready_for_review', branch: 'chatmcp/coder/x/task-a', summary: 'All tests pass and the task is complete.', verifyRequired: false, ...overrides });
const verifiedWorker = (overrides = {}) => worker({
  verifyRequired: true, verificationOutcome: { state: 'ready_for_review', repairs: 0 }, verificationAttempts: [attempt()], ...overrides,
});

test('a worker the model says is complete is waiting for review, not verified', () => {
  const proof = assessWorker(worker());
  assert.equal(proof.kind, 'unverified');
  assert.equal(proof.tone, 'warning');
  assert.equal(proof.verifiedChecks, 0);
});

test('the words of the model never change the assessment', () => {
  for (const summary of ['Tests passed.', 'All registered pinned Node checks have fresh signed TAP evidence.', 'Verified by the Hub.', '']) {
    assert.notEqual(assessWorker(worker({ summary })).tone, 'success', summary);
  }
});

test('a worker is green only with a Hub-verified check behind a ready_for_review outcome', () => {
  const proof = assessWorker(verifiedWorker());
  assert.equal(proof.tone, 'success');
  assert.equal(proof.kind, 'verified');
  assert.equal(proof.verifiedChecks, 1);
  assert.equal(proof.checks, 1);
});

test('the outcome alone is not evidence: no recorded attempt, or an attempt the Hub did not verify, stays amber', () => {
  assert.equal(assessWorker(verifiedWorker({ verificationAttempts: [] })).tone, 'warning');
  assert.equal(assessWorker(verifiedWorker({ verificationAttempts: undefined })).tone, 'warning');
  assert.equal(assessWorker(verifiedWorker({ verificationAttempts: [attempt({ testOutcomeVerified: false })] })).kind, 'unverified');
  // exit code 0 is not a verified test outcome
  assert.equal(assessWorker(verifiedWorker({ verificationAttempts: [attempt({ testOutcomeVerified: false, exitCode: 0, status: 'completed' })] })).tone, 'warning');
});

test('a verified attempt without a ready_for_review outcome is not enough', () => {
  for (const state of ['needs_attention', 'cancelled', undefined]) {
    const proof = assessWorker(verifiedWorker({ verificationOutcome: state ? { state } : null }));
    assert.notEqual(proof.tone, 'success', String(state));
  }
});

test('evidence is read only when verification was asked for: a stray attempt on a plain worker does not turn it green', () => {
  assert.notEqual(assessWorker(worker({ verifyRequired: false, verificationOutcome: { state: 'ready_for_review' }, verificationAttempts: [attempt()] })).tone, 'success');
});

test('a failed check is red even after an earlier verified one', () => {
  const proof = assessWorker(verifiedWorker({ verificationAttempts: [attempt(), attempt({ id: 'a2', status: 'failed', exitCode: 1, testOutcomeVerified: false })] }));
  assert.equal(proof.tone, 'danger');
  assert.equal(proof.kind, 'check-failed');
});

test('a check that exited non-zero is red even if its record says "completed", and one recorded as failed is red without an exit code', () => {
  const proof = assessWorker(verifiedWorker({ verificationAttempts: [attempt({ status: 'completed', exitCode: 2, testOutcomeVerified: false })] }));
  assert.equal(proof.tone, 'danger');
  assert.equal(proof.kind, 'check-failed');
  for (const exitCode of [null, undefined]) {
    assert.equal(assessWorker(verifiedWorker({ verificationAttempts: [attempt({ status: 'failed', exitCode, testOutcomeVerified: false })] })).kind, 'check-failed', String(exitCode));
  }
});

test('with several checks every one needs its own latest attempt verified: one verified check does not vouch for the others', () => {
  const second = (overrides = {}) => attempt({ id: 'b1', checkId: 'test-2', ...overrides });
  // the first check passed, the second was never verified (blocked): amber, however many verified attempts exist
  const blocked = assessWorker(verifiedWorker({ verificationAttempts: [attempt(), attempt({ id: 'a2' }), second({ testOutcomeVerified: false })] }));
  assert.equal(blocked.tone, 'warning');
  assert.equal(blocked.verifiedChecks, 2);
  // the first check passed, the second failed: red
  assert.equal(assessWorker(verifiedWorker({ verificationAttempts: [attempt(), second({ status: 'failed', exitCode: 1, testOutcomeVerified: false })] })).tone, 'danger');
  // both verified: green
  assert.equal(assessWorker(verifiedWorker({ verificationAttempts: [attempt(), second()] })).tone, 'success');
  // the second check failed, was repaired and verified, and the first check was verified: green
  assert.equal(assessWorker(verifiedWorker({ verificationAttempts: [attempt(), second({ status: 'failed', exitCode: 1, testOutcomeVerified: false }), second({ id: 'b2' })] })).tone, 'success');
  // an earlier verified attempt of a check does not outvote its latest, unverified one
  assert.equal(assessWorker(verifiedWorker({ verificationAttempts: [attempt(), attempt({ id: 'a2', testOutcomeVerified: false })] })).tone, 'warning');
  // the order the attempts arrived in does not matter: a verified attempt of one check coming last does not vouch for another check's latest
  assert.equal(assessWorker(verifiedWorker({ verificationAttempts: [second({ testOutcomeVerified: false }), attempt()] })).tone, 'warning');
  assert.equal(assessWorker(verifiedWorker({ verificationAttempts: [second({ status: 'failed', exitCode: 1, testOutcomeVerified: false }), attempt()] })).tone, 'danger');
});

test('a worker that repaired itself is green on its last verified attempt, counting all attempts', () => {
  const proof = assessWorker(verifiedWorker({
    verificationOutcome: { state: 'ready_for_review', repairs: 1 },
    verificationAttempts: [attempt({ id: 'a1', status: 'failed', exitCode: 1, testOutcomeVerified: false }), attempt({ id: 'a2' })],
  }));
  assert.equal(proof.tone, 'success');
  assert.equal(proof.checks, 2);
  assert.equal(proof.verifiedChecks, 1);
});

test('every state that is not "finished with a commit" gets its own non-green reading', () => {
  const cases = {
    queued: ['neutral', 'working'], preparing: ['neutral', 'working'], running: ['neutral', 'working'],
    awaiting_test_grant: ['neutral', 'working'], testing: ['neutral', 'working'],
    no_changes: ['neutral', 'no-changes'], cancelled: ['neutral', 'stopped'],
    failed: ['danger', 'failed'], blocked: ['warning', 'attention'], needs_attention: ['warning', 'attention'], interrupted: ['warning', 'attention'],
  };
  for (const [status, [tone, kind]] of Object.entries(cases)) {
    // even with a verified attempt on record, only a finished worker can be green
    const proof = assessWorker(verifiedWorker({ status }));
    assert.deepEqual([proof.tone, proof.kind], [tone, kind], status);
  }
});

test('an unknown status is flagged for attention, never read as success', () => {
  const proof = assessWorker(verifiedWorker({ status: 'something_new' }));
  assert.equal(proof.tone, 'warning');
  assert.equal(proof.kind, 'attention');
});

test('a read-only report is the AI saying something, never green', () => {
  assert.deepEqual(assessReport('completed'), { tone: 'neutral', kind: 'ai-report' });
  for (const status of ['completed', 'running', 'queued', 'needs_attention', 'failed', 'cancelled', 'interrupted', 'whatever']) {
    assert.notEqual(assessReport(status).tone, 'success', status);
  }
  assert.equal(assessReport('running').kind, 'working');
  assert.equal(assessReport('failed').tone, 'danger');
  assert.equal(assessReport('needs_attention').tone, 'warning');
  assert.equal(assessReport('cancelled').kind, 'stopped');
});

test('the colour of a run or merge status word is only ever a warning: green belongs to the evidence of a worker', () => {
  for (const status of ['completed', 'ready_for_review', 'verified', 'published', 'draft_pr_created', 'running', 'queued', 'no_changes', 'whatever']) {
    assert.equal(statusTone(status), 'neutral', status);
  }
  assert.equal(statusTone('failed'), 'danger');
  for (const status of ['needs_attention', 'partial_failure', 'interrupted', 'conflict', 'blocked']) assert.equal(statusTone(status), 'warning', status);
  assert.equal(statusTone(undefined), 'neutral');
});

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

test('the second workspace case: delegation acts on the Hub’s primary folder, not the one being viewed', () => {
  assert.deepEqual(delegationTarget({ selectedWorkspacePath: '/a', primaryPath: '/a' }), { blocked: false, primary: '/a', viewing: '/a' });
  assert.deepEqual(delegationTarget({ selectedWorkspacePath: '/b', primaryPath: '/a' }), { blocked: true, primary: '/a', viewing: '/b' });
  // nothing selected: the Hub’s active folder is what is being viewed
  assert.equal(delegationTarget({ selectedWorkspacePath: '', activePath: '/a', primaryPath: '/a' }).blocked, false);
  assert.equal(delegationTarget({ selectedWorkspacePath: '', activePath: '/b', primaryPath: '/a' }).blocked, true);
  // either side unknown: nothing to compare, nothing blocked (same rule as the work panel)
  assert.equal(delegationTarget({ selectedWorkspacePath: '/b' }).blocked, false);
  assert.equal(delegationTarget({ primaryPath: '/a' }).blocked, false);
});

test('coding workers are refused for a reason the owner can read, in the order the Hub would refuse them', () => {
  const ok = { differentRoot: false, mode: 'autonomous', busy: false, recoveryFault: null };
  assert.equal(codingBlock(ok), null);
  assert.equal(codingBlock({ ...ok, mode: 'review' }), 'needs-autonomous');
  assert.equal(codingBlock({ ...ok, mode: 'readonly' }), 'needs-autonomous');
  assert.equal(codingBlock({ ...ok, mode: undefined }), 'needs-autonomous');
  assert.equal(codingBlock({ ...ok, busy: true }), 'busy');
  assert.equal(codingBlock({ ...ok, recoveryFault: 'Unreadable saved coding jobs' }), 'recovery');
  assert.equal(codingBlock({ ...ok, differentRoot: true }), 'other-workspace');
  // the folder is the most basic reason, then a damaged journal, then permissions, then a run in progress
  assert.equal(codingBlock({ differentRoot: true, mode: 'review', busy: true, recoveryFault: 'x' }), 'other-workspace');
  assert.equal(codingBlock({ differentRoot: false, mode: 'review', busy: true, recoveryFault: 'x' }), 'recovery');
  assert.equal(codingBlock({ differentRoot: false, mode: 'review', busy: true, recoveryFault: null }), 'needs-autonomous');
});

test('a merge needs something ticked, every ticked diff read, no merge yet for the run, and nothing else running', () => {
  const read = (...ids) => (id) => ids.includes(id);
  const ok = { selected: ['task-a', 'task-b'], reviewed: read('task-a', 'task-b'), hasMerge: false, locked: false };
  assert.equal(canMerge(ok), true);
  assert.equal(canMerge({ ...ok, selected: [] }), false, 'nothing ticked');
  assert.equal(canMerge({ ...ok, reviewed: read('task-a') }), false, 'one diff not read');
  assert.equal(canMerge({ ...ok, reviewed: read() }), false, 'no diff read');
  assert.equal(canMerge({ ...ok, hasMerge: true }), false, 'the Hub keeps one merge per run');
  assert.equal(canMerge({ ...ok, locked: true }), false, 'a run or merge is going on');
});

test('the merge is published only when it exists, is ready for review, its own diff was read and nothing else is running', () => {
  const ok = { status: 'ready_for_review', reviewed: true, locked: false };
  assert.equal(canPublishMerge(ok), true);
  for (const status of [undefined, 'conflict', 'draft_pr_created', 'failed']) assert.equal(canPublishMerge({ ...ok, status }), false, String(status));
  assert.equal(canPublishMerge({ ...ok, reviewed: false }), false);
  assert.equal(canPublishMerge({ ...ok, locked: true }), false);
});
