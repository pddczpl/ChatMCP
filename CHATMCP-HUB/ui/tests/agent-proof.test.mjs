import test from 'node:test';
import assert from 'node:assert/strict';
import { analysisBlock, assessWorker, assessReport, awaitingCheckWorkers, canMerge, canPublishMerge, codingBlock, delegationTarget, effectiveReportStatus, grantState, groupBlock, hubNoteOf, outcomeToast, preselectIds, reviewKey, runnerErrorCodeOf, runnerErrorOf, runnerNoticeOf, runsOfFolder, statusTone } from '../src/lib/agent-proof.ts';

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

test('the runs of a folder are those the Hub recorded for exactly that folder: the others are counted, never shown', () => {
  const a = { id: 'a', workspace: '/project' };
  const b = { id: 'b', workspace: '/other' };
  const c = { id: 'c', workspace: '/project' };
  assert.deepEqual(runsOfFolder([a, b, c], '/project'), { shown: [a, c], hidden: 1 });
  assert.deepEqual(runsOfFolder([a, b, c], '/other'), { shown: [b], hidden: 2 });
  assert.deepEqual(runsOfFolder([a, b, c], '/nowhere'), { shown: [], hidden: 3 });
  assert.equal(runsOfFolder([a, b, c], '/project').shown[0], a, 'the very runs of the Hub, in the order the Hub gave them');
  assert.deepEqual(runsOfFolder([], '/project'), { shown: [], hidden: 0 });
});

test('a run whose folder the Hub did not record belongs to no folder: it is counted, as the Hub would not read it either', () => {
  for (const workspace of [null, undefined, '', 42, {}, ['/project']]) {
    assert.deepEqual(runsOfFolder([{ id: 'x', workspace }], '/project'), { shown: [], hidden: 1 }, String(workspace));
  }
  assert.deepEqual(runsOfFolder([{ id: 'x' }, { id: 'y', workspace: '/project' }], '/project'), { shown: [{ id: 'y', workspace: '/project' }], hidden: 1 });
});

test('with no folder in view no run is shown, and a list that is not a list has no runs', () => {
  const run = { id: 'a', workspace: '/project' };
  for (const folder of ['', undefined, null]) assert.deepEqual(runsOfFolder([run], folder), { shown: [], hidden: 1 }, String(folder));
  assert.deepEqual(runsOfFolder([{ id: 'x', workspace: '' }], ''), { shown: [], hidden: 1 }, 'an empty string is no folder, on either side');
  for (const jobs of [undefined, null, {}, 'runs', 7]) assert.deepEqual(runsOfFolder(jobs, '/project'), { shown: [], hidden: 0 }, String(jobs));
  assert.deepEqual(runsOfFolder([null, undefined, run], '/project'), { shown: [run], hidden: 2 }, 'an entry that is not a run is not a run of the folder');
});

test('folders are compared as the Hub compares them, exactly: another spelling is another folder', () => {
  const run = { id: 'a', workspace: 'C:\\Projects\\App' };
  assert.deepEqual(runsOfFolder([run], 'C:\\Projects\\App').shown, [run]);
  for (const folder of ['c:\\projects\\app', 'C:\\Projects\\App\\', 'C:/Projects/App', ' C:\\Projects\\App']) assert.deepEqual(runsOfFolder([run], folder), { shown: [], hidden: 1 }, folder);
});

const note = (overrides = {}) => ({ code: 'blocked', text: 'Verified coding blocked: Repair/test retry budget exhausted.', detail: 'Repair/test retry budget exhausted.', ...overrides });
const proofOf = (record, options) => assessWorker(record, options);

test('the Hub’s note about a verification that did not finish is shown beside the card, whatever the card says', () => {
  for (const [code, status] of [['no_checks', 'needs_attention'], ['grant_timeout', 'needs_attention'], ['blocked', 'needs_attention'], ['blocked', 'interrupted'], ['no_checks', 'failed']]) {
    const record = worker({ status, verifyRequired: true, verificationNote: note({ code }) });
    assert.equal(hubNoteOf(record, proofOf(record))?.code, code, `${code} on ${status}`);
  }
  const shown = hubNoteOf(worker({ status: 'needs_attention', verificationNote: note() }), proofOf(worker({ status: 'needs_attention' })));
  assert.deepEqual(shown, { code: 'blocked', text: 'Verified coding blocked: Repair/test retry budget exhausted.', detail: 'Repair/test retry budget exhausted.' });
});

test('the note that every check has fresh evidence is shown only where the card’s own evidence says the same', () => {
  const verifiedNote = { code: 'verified', text: 'All registered pinned Node checks have fresh signed TAP evidence.' };
  const ok = verifiedWorker({ verificationNote: verifiedNote });
  assert.equal(proofOf(ok).kind, 'verified');
  assert.deepEqual(hubNoteOf(ok, proofOf(ok)), verifiedNote, 'the Hub’s record agrees: the note is shown');
  // the realistic ways a worker carries that note without being verified: the commit or file check failed after the loop, a restart, a later attempt that failed,
  // an attempt the Hub did not verify, a loop that did not end as ready, a worker that was not asked to verify, nothing changed, the run was stopped
  const mismatches = {
    'the commit failed after the verification': verifiedWorker({ status: 'failed', verificationNote: verifiedNote }),
    'the Hub restarted': verifiedWorker({ status: 'interrupted', verificationNote: verifiedNote }),
    'the run was cancelled': verifiedWorker({ status: 'cancelled', verificationNote: verifiedNote }),
    'nothing was changed': verifiedWorker({ status: 'no_changes', verificationNote: verifiedNote }),
    'it needs attention': verifiedWorker({ status: 'needs_attention', verificationNote: verifiedNote }),
    'a later attempt failed': verifiedWorker({ verificationAttempts: [attempt(), attempt({ id: 'a2', status: 'failed', exitCode: 1, testOutcomeVerified: false })], verificationNote: verifiedNote }),
    'an attempt was not verified by the Hub': verifiedWorker({ verificationAttempts: [attempt({ testOutcomeVerified: false })], verificationNote: verifiedNote }),
    'no attempt is on record': verifiedWorker({ verificationAttempts: [], verificationNote: verifiedNote }),
    'the loop did not end as ready': verifiedWorker({ verificationOutcome: { state: 'needs_attention' }, verificationNote: verifiedNote }),
    'verification was not asked for': verifiedWorker({ verifyRequired: false, verificationNote: verifiedNote }),
  };
  for (const [label, record] of Object.entries(mismatches)) {
    assert.notEqual(proofOf(record).kind, 'verified', `(premise) ${label}`);
    assert.equal(hubNoteOf(record, proofOf(record)), null, `${label}: the note is not shown as proof`);
  }
  // a worker still working in a run that is not going any more is stopped, and a stopped worker has no proof to repeat
  const stopped = verifiedWorker({ status: 'running', verificationNote: verifiedNote });
  assert.equal(hubNoteOf(stopped, proofOf(stopped, { runActive: false })), null);
});

test('the model’s words are not the Hub’s: a summary that says the Hub verified everything shows no Hub note', () => {
  const record = worker({ summary: 'All registered pinned Node checks have fresh signed TAP evidence.' });
  assert.equal(hubNoteOf(record, proofOf(record)), null);
});

test('a note that is not a note is not shown, and only text that is text is passed on', () => {
  const record = (verificationNote) => worker({ status: 'needs_attention', verificationNote });
  for (const bad of [undefined, null, 'blocked', 7, [], [note()], {}, { code: '' }, { code: 7 }, { code: null }, { text: 'Verified coding blocked' }]) {
    assert.equal(hubNoteOf(record(bad), proofOf(record(bad))), null, JSON.stringify(bad));
  }
  const clean = hubNoteOf(record({ code: 'blocked', text: 5, detail: { reason: 'x' }, extra: 'dropped' }), proofOf(record()));
  assert.deepEqual(clean, { code: 'blocked' }, 'a text or a detail that is not a string is dropped, and so is anything else');
  assert.equal(hubNoteOf(null, proofOf(null)), null);
  assert.equal(hubNoteOf(undefined, proofOf(undefined)), null);
  // a code this page does not know is passed on with the Hub’s own text; it is not made up into proof
  assert.deepEqual(hubNoteOf(record({ code: 'something_new', text: 'The Hub says so.' }), proofOf(record())), { code: 'something_new', text: 'The Hub says so.' });
});

const RUNNER_SENTENCE = 'Model kết thúc nhưng không đưa ra kết quả văn bản cuối cùng. Thông báo tiến độ không được coi là kết quả hoàn tất.';

test('the runner’s record of why a run stopped is passed on as the text it is, for a worker in any state', () => {
  for (const status of ['failed', 'cancelled', 'needs_attention', 'interrupted', 'ready_for_review']) {
    assert.equal(runnerErrorOf(worker({ status, summary: '', runnerError: RUNNER_SENTENCE })), RUNNER_SENTENCE, status);
  }
  // exactly as the Hub sent it: not trimmed, not translated, not cut. What cannot be seen at either end is for the page to show as a marker
  const marked = String.fromCharCode(0x202E) + ' Stopped by the provider\n';
  assert.equal(runnerErrorOf(worker({ runnerError: marked })), marked);
});

test('a runner error that is not text, or says nothing, is none; the model’s summary is never taken for one', () => {
  for (const bad of [undefined, null, '', ' ', '\n\t  ', 7, true, {}, [], ['x'], { text: RUNNER_SENTENCE }]) {
    assert.equal(runnerErrorOf(worker({ runnerError: bad })), null, JSON.stringify(bad));
  }
  assert.equal(runnerErrorOf(null), null);
  assert.equal(runnerErrorOf(undefined), null);
  assert.equal(runnerErrorOf(worker()), null, 'a worker that has none');
  // a record saved before the field existed, or a model that wrote the very sentence: that is its summary, which stays the model’s
  assert.equal(runnerErrorOf(worker({ status: 'failed', summary: RUNNER_SENTENCE })), null);
});

test('what the runner recorded changes nothing about how a worker is read: the colour is the evidence rule’s', () => {
  for (const status of ['queued', 'running', 'awaiting_test_grant', 'ready_for_review', 'no_changes', 'failed', 'needs_attention', 'cancelled', 'interrupted']) {
    for (const options of [{}, { runActive: false }]) {
      assert.deepEqual(assessWorker(worker({ status, runnerError: RUNNER_SENTENCE }), options), assessWorker(worker({ status }), options), `${status} ${JSON.stringify(options)}`);
    }
  }
  const claim = verifiedWorker({ runnerError: RUNNER_SENTENCE });
  assert.equal(proofOf(claim).kind, 'verified', 'and it cannot take away what the Hub verified either');
  assert.equal(hubNoteOf(worker({ status: 'failed', runnerError: RUNNER_SENTENCE }), proofOf(worker({ status: 'failed' }))), null, 'nor is it a verification note');
});

test('the code of the runner’s record is passed on as the short plain code it is, for a worker in any state', () => {
  for (const status of ['failed', 'cancelled', 'needs_attention', 'interrupted', 'ready_for_review']) {
    assert.equal(runnerErrorCodeOf(worker({ status, summary: '', runnerError: RUNNER_SENTENCE, runnerErrorCode: 'empty_final' })), 'empty_final', status);
  }
  for (const code of ['a', 'a1', 'a_', 'gateway_rate_limit', 'x'.repeat(64)]) assert.equal(runnerErrorCodeOf(worker({ runnerErrorCode: code })), code, code);
});

test('a code that is not a short plain code is none: the page looks a sentence up by it, so nothing else may reach the dictionary', () => {
  const notCodes = [undefined, null, '', ' ', ' empty_final', 'empty_final ', 'empty_final\n', 'ECONNRESET', 'Empty_final', 'empty-final', 'empty final', '_x', '1x', 'x'.repeat(65), 'kém',
    '../agent_status_failed', 'a.b', '__proto__', 7, 0, true, {}, [], ['empty_final'], { code: 'empty_final' }];
  for (const bad of notCodes) assert.equal(runnerErrorCodeOf(worker({ runnerErrorCode: bad })), null, typeof bad === 'object' ? JSON.stringify(bad) : String(bad));
  assert.equal(runnerErrorCodeOf(null), null);
  assert.equal(runnerErrorCodeOf(undefined), null);
  assert.equal(runnerErrorCodeOf(worker()), null, 'a worker that has none');
  // the code belongs to the Hub’s record; the model’s summary and the Hub’s sentence are never taken for it
  assert.equal(runnerErrorCodeOf(worker({ status: 'failed', summary: 'empty_final', runnerError: RUNNER_SENTENCE })), null);
  assert.equal(runnerErrorCodeOf(worker({ verificationNote: { code: 'no_checks', text: 'x' }, runnerNotice: 'x' })), null);
});

test('the code changes nothing about how a worker is read: the colour is the evidence rule’s', () => {
  for (const status of ['queued', 'running', 'awaiting_test_grant', 'ready_for_review', 'no_changes', 'failed', 'needs_attention', 'cancelled', 'interrupted']) {
    for (const options of [{}, { runActive: false }]) {
      assert.deepEqual(assessWorker(worker({ status, runnerError: RUNNER_SENTENCE, runnerErrorCode: 'empty_final' }), options), assessWorker(worker({ status }), options), `${status} ${JSON.stringify(options)}`);
    }
  }
  assert.equal(proofOf(verifiedWorker({ runnerError: RUNNER_SENTENCE, runnerErrorCode: 'user_cancelled' })).kind, 'verified', 'and it cannot take away what the Hub verified either');
  const failed = worker({ status: 'failed', runnerError: RUNNER_SENTENCE, runnerErrorCode: 'empty_final' });
  assert.equal(hubNoteOf(failed, proofOf(failed)), null, 'nor is it a verification note');
  assert.equal(runnerNoticeOf(failed), null, 'nor a notice on the AI’s report');
});

const NOTICE_SENTENCE = 'ChatMCP has NOT independently verified full completion: No verified successful project check; No independently recorded Git diff review.';

test('the Hub’s notice on the AI’s report is passed on as the text it is, for a worker in any state', () => {
  for (const status of ['ready_for_review', 'failed', 'needs_attention', 'interrupted', 'cancelled', 'no_changes', 'running']) {
    assert.equal(runnerNoticeOf(worker({ status, runnerNotice: NOTICE_SENTENCE })), NOTICE_SENTENCE, status);
  }
  // exactly as the Hub sent it: not trimmed, not translated, not cut. What cannot be seen at either end is for the page to show as a marker
  const marked = String.fromCharCode(0x202E) + ' ChatMCP has NOT verified it\n';
  assert.equal(runnerNoticeOf(worker({ runnerNotice: marked })), marked);
});

test('a notice that is not text, or says nothing, is none; the model’s summary is never taken for one', () => {
  for (const bad of [undefined, null, '', ' ', '\n\t  ', 7, true, {}, [], ['x'], { text: NOTICE_SENTENCE }]) {
    assert.equal(runnerNoticeOf(worker({ runnerNotice: bad })), null, JSON.stringify(bad));
  }
  assert.equal(runnerNoticeOf(null), null);
  assert.equal(runnerNoticeOf(undefined), null);
  assert.equal(runnerNoticeOf(worker()), null, 'a worker that has none');
  // a record saved before the field existed has the sentence inside its summary, or a model wrote the very sentence: that is its summary, which stays the model’s
  assert.equal(runnerNoticeOf(worker({ summary: `Done.\n\n[Verification notice] ${NOTICE_SENTENCE}` })), null);
});

test('a caution is not withdrawn by a green card: the notice is passed on beside a worker the Hub verified itself, and wherever it did not', () => {
  // the Hub wrote it when the AI reported done, before it ran any check of its own; what the checks proved afterwards does not make it untrue (the Git diff was still not read)
  const green = verifiedWorker({ runnerNotice: NOTICE_SENTENCE });
  assert.equal(proofOf(green).kind, 'verified', '(premise)');
  assert.equal(runnerNoticeOf(green), NOTICE_SENTENCE);
  const open = {
    'a later attempt failed': verifiedWorker({ verificationAttempts: [attempt(), attempt({ id: 'a2', status: 'failed', exitCode: 1, testOutcomeVerified: false })] }),
    'an attempt the Hub did not verify': verifiedWorker({ verificationAttempts: [attempt({ testOutcomeVerified: false })] }),
    'no attempt on record': verifiedWorker({ verificationAttempts: [] }),
    'the loop did not end as ready': verifiedWorker({ verificationOutcome: { state: 'needs_attention' } }),
    'verification was not asked for': verifiedWorker({ verifyRequired: false }),
  };
  for (const [label, record] of Object.entries(open)) {
    const given = { ...record, runnerNotice: NOTICE_SENTENCE };
    assert.notEqual(proofOf(given).kind, 'verified', `(premise) ${label}`);
    assert.equal(runnerNoticeOf(given), NOTICE_SENTENCE, label);
  }
});

test('what the Hub says on the AI’s report changes nothing about how a worker is read: the colour is the evidence rule’s, and it is no verification note', () => {
  for (const status of ['queued', 'running', 'awaiting_test_grant', 'ready_for_review', 'no_changes', 'failed', 'needs_attention', 'cancelled', 'interrupted']) {
    for (const options of [{}, { runActive: false }]) {
      assert.deepEqual(assessWorker(worker({ status, runnerNotice: NOTICE_SENTENCE }), options), assessWorker(worker({ status }), options), `${status} ${JSON.stringify(options)}`);
    }
  }
  const claim = verifiedWorker({ runnerNotice: NOTICE_SENTENCE });
  assert.equal(proofOf(claim).kind, 'verified', 'and it cannot take away what the Hub verified either');
  const other = worker({ status: 'needs_attention', runnerNotice: NOTICE_SENTENCE });
  assert.equal(hubNoteOf(other, proofOf(other)), null, 'nor is it a verification note');
  assert.equal(runnerErrorOf(other), null, 'nor the runner’s record of why a run stopped');
  const stopped = worker({ status: 'failed', runnerError: 'x' });
  assert.equal(runnerNoticeOf(stopped), null, 'and that record is not a notice');
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
