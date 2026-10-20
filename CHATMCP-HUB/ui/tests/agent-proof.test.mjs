import test from 'node:test';
import assert from 'node:assert/strict';
import { analysisBlock, assessWorker, assessReport, awaitingCheckWorkers, canMerge, canPublishMerge, codingBlock, delegationTarget, effectiveReportStatus, grantState, groupBlock, outcomeToast, preselectIds, reviewKey, statusTone } from '../src/lib/agent-proof.ts';

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
    awaiting_test_grant: ['warning', 'awaiting-grant'], testing: ['neutral', 'working'],
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
  const ok = { selected: ['task-a', 'task-b'], reviewed: read('task-a', 'task-b'), hasMerge: false, locked: false, runStatus: 'ready_for_review' };
  assert.equal(canMerge(ok), true);
  assert.equal(canMerge({ ...ok, runStatus: 'partial_failure' }), true, 'the Hub also merges the ready workers of a run where some did not finish');
  assert.equal(canMerge({ ...ok, selected: [] }), false, 'nothing ticked');
  assert.equal(canMerge({ ...ok, reviewed: read('task-a') }), false, 'one diff not read');
  assert.equal(canMerge({ ...ok, reviewed: read() }), false, 'no diff read');
  assert.equal(canMerge({ ...ok, hasMerge: true }), false, 'the Hub keeps one merge per run');
  assert.equal(canMerge({ ...ok, locked: true }), false, 'a run or merge is going on');
  for (const runStatus of ['cancelled', 'failed', 'interrupted', 'running', 'needs_attention', undefined]) {
    assert.equal(canMerge({ ...ok, runStatus }), false, `the Hub refuses a merge of a run that is ${runStatus}`);
  }
});

test('the merge is published only when it exists, is ready for review, its own diff was read and nothing else is running', () => {
  const ok = { status: 'ready_for_review', reviewed: true, locked: false };
  assert.equal(canPublishMerge(ok), true);
  for (const status of [undefined, 'conflict', 'draft_pr_created', 'failed']) assert.equal(canPublishMerge({ ...ok, status }), false, String(status));
  assert.equal(canPublishMerge({ ...ok, reviewed: false }), false);
  assert.equal(canPublishMerge({ ...ok, locked: true }), false);
});

test('the end of a run is announced as information or a warning, never as a success', () => {
  for (const status of ['completed', 'ready_for_review', 'no_changes', 'cancelled', 'running', 'verified', 'published', undefined]) {
    assert.equal(outcomeToast(status), 'info', String(status));
  }
  for (const status of ['failed', 'needs_attention', 'partial_failure', 'interrupted', 'conflict', 'blocked']) {
    assert.equal(outcomeToast(status), 'warning', status);
  }
  for (const status of ['completed', 'ready_for_review', 'verified', 'published', 'draft_pr_created', 'failed', 'whatever', undefined]) {
    assert.notEqual(outcomeToast(status), 'success', String(status));
  }
});

test('the workers of a run that is no longer going are stopped, not working: nothing spins for something that will never run', () => {
  const pick = (proof) => [proof.tone, proof.kind];
  for (const status of ['queued', 'preparing', 'running', 'testing', 'committing', 'awaiting_test_grant']) {
    assert.deepEqual(pick(assessWorker(verifiedWorker({ status }), { runActive: false })), ['neutral', 'stopped'], status);
  }
  // by default (and while the run is going) they are working; a worker waiting for a test grant is waiting for the owner
  assert.deepEqual(pick(assessWorker(worker({ status: 'queued' }))), ['neutral', 'working']);
  assert.deepEqual(pick(assessWorker(worker({ status: 'queued' }), { runActive: true })), ['neutral', 'working']);
  assert.deepEqual(pick(assessWorker(worker({ status: 'awaiting_test_grant', verifyRequired: true }), { runActive: true })), ['warning', 'awaiting-grant']);
  // a finished worker is read the same whether the run is going or not
  for (const runActive of [true, false]) {
    assert.equal(assessWorker(worker({ status: 'ready_for_review' }), { runActive }).kind, 'unverified');
    assert.equal(assessWorker(worker({ status: 'failed' }), { runActive }).kind, 'failed');
    assert.equal(assessWorker(verifiedWorker(), { runActive }).kind, 'verified');
  }
});

test('a status the Hub saved as "running" while it is not running is an interrupted one', () => {
  assert.equal(effectiveReportStatus('running', false), 'interrupted');
  assert.equal(effectiveReportStatus('running', true), 'running');
  // every status that says "in progress" or "still to come" is cut off in the same way: nothing will start it any more
  for (const status of ['queued', 'pending', 'preparing', 'planning', 'testing', 'committing', 'awaiting_test_grant']) {
    assert.equal(effectiveReportStatus(status, false), 'interrupted', status);
    assert.equal(effectiveReportStatus(status, true), status, `${status}: while it is running it is what it says`);
  }
  for (const status of ['completed', 'failed', 'cancelled', 'needs_attention', 'blocked', 'interrupted', undefined]) assert.equal(effectiveReportStatus(status, false), status);
});

test('coding workers are refused while the main agent or a helper group is running, as the Hub refuses them', () => {
  const ok = { differentRoot: false, mode: 'autonomous', busy: false, recoveryFault: null };
  assert.equal(codingBlock({ ...ok, agentBusy: true }), 'agent-busy');
  assert.equal(codingBlock({ ...ok, groupRunning: true }), 'group-running');
  assert.equal(codingBlock({ ...ok, agentBusy: false, groupRunning: false }), null);
  // after the reasons the owner has to fix elsewhere, and before "a run is in progress"
  assert.equal(codingBlock({ ...ok, mode: 'review', agentBusy: true }), 'needs-autonomous');
  assert.equal(codingBlock({ ...ok, agentBusy: true, groupRunning: true, busy: true }), 'agent-busy');
  assert.equal(codingBlock({ ...ok, groupRunning: true, busy: true }), 'group-running');
  assert.equal(codingBlock({ ...ok, differentRoot: true, agentBusy: true }), 'other-workspace');
});

test('an analysis is refused while anything else of the Hub is running, as the Hub refuses it', () => {
  const ok = { differentRoot: false, agentBusy: false, codingActive: false, groupRunning: false, aiBusy: false };
  assert.equal(analysisBlock(ok), null);
  assert.equal(analysisBlock({ ...ok, differentRoot: true }), 'other-workspace');
  assert.equal(analysisBlock({ ...ok, agentBusy: true }), 'agent-busy');
  assert.equal(analysisBlock({ ...ok, codingActive: true }), 'coding-running');
  assert.equal(analysisBlock({ ...ok, groupRunning: true }), 'group-running');
  assert.equal(analysisBlock({ ...ok, aiBusy: true }), 'ai-busy');
  assert.equal(analysisBlock({ differentRoot: true, agentBusy: true, codingActive: true, groupRunning: true, aiBusy: true }), 'other-workspace');
  assert.equal(analysisBlock({ ...ok, agentBusy: true, codingActive: true }), 'agent-busy');
});

test('a hand-made group is refused only while the main agent is running (the Hub checks nothing else)', () => {
  assert.equal(groupBlock({ differentRoot: false, agentBusy: false }), null);
  assert.equal(groupBlock({ differentRoot: false, agentBusy: true }), 'agent-busy');
  assert.equal(groupBlock({ differentRoot: true, agentBusy: true }), 'other-workspace');
});

test('a run that has just ended pre-selects its ready workers only when the Hub would merge it', () => {
  const run = (status) => ({ status, workers: [{ id: 'a', status: 'ready_for_review' }, { id: 'b', status: 'failed' }, { id: 'c', status: 'ready_for_review' }, { id: 'd', status: 'no_changes' }] });
  assert.deepEqual(preselectIds(run('ready_for_review')), ['a', 'c']);
  assert.deepEqual(preselectIds(run('partial_failure')), ['a', 'c']);
  for (const status of ['cancelled', 'failed', 'interrupted', 'running', 'preparing', undefined]) assert.deepEqual(preselectIds(run(status)), [], String(status));
  assert.deepEqual(preselectIds({ status: 'ready_for_review' }), []);
  assert.deepEqual(preselectIds(null), []);
});

test('the key a review is kept under tells the merge from a worker, whatever the worker is called', () => {
  assert.equal(reviewKey('task-a'), 'worker:task-a');
  assert.equal(reviewKey(null), 'merge');
  assert.equal(reviewKey(undefined), 'merge');
  const names = ['merge', 'integration', 'worker:merge', 'a'];
  assert.equal(new Set([...names.map(reviewKey), reviewKey(null)]).size, names.length + 1, 'no worker name collides with the merge or with another worker');
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
