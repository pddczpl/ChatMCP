import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeApproval } from '../src/lib/task-view.ts';
import { editStep, editText, editTitle, openDraft, reconcile } from '../src/lib/plan-draft.ts';
import {
  approvePlan, composerPlan, feedbackProblem, isPlanConflict, nextApproval, planCard, planEditable, planHead, planLine, planRequest, sendsPlanMode,
} from '../src/lib/plan-view.ts';

// What the page shows of plan mode and what it sends (P9 ac-11, docs/PLAN-MODE.md): the approval card of exit_plan_mode, the Plan entry of the composer (a flag of one
// task, never the permission mode every chat shares), the line of the banner and the head of the Plan tab.

const TASK = '0b0c5a52-6f0c-4b0e-9d0e-3a4a5b6c7d8e';
const request = (more = {}) => ({
  id: 'req-1', taskId: TASK, toolName: 'chatmcp.exit_plan_mode', category: 'plan', reason: 'why', summary: 'Duyệt kế hoạch, bản 2', preview: '1. Read.',
  detail: { kind: 'plan', plan: '1. Read [REDACTED].', revision: 2 }, expiresAt: '2026-11-23T10:10:00.000Z', ...more,
});
const item = (text, status = 'todo', evidence = '') => ({ text, status, evidence });
const plan = (revision, more = {}) => ({ version: 2, title: 'Repair', text: '1. Read key.', items: [item('Read')], revision, updatedBy: 'agent', updatedAt: null, approvedAt: null, approvedRevision: null, ...more });

// ---- the request ----------------------------------------------------------------------------------------------------------------------------------

test('a plan request is known by its category, its tool and its detail; anything else is drawn as an ordinary request', () => {
  assert.deepEqual(planRequest(normalizeApproval(request())), { taskId: TASK, text: '1. Read [REDACTED].', revision: 2 });
  for (const [what, more] of Object.entries({
    'another category': { category: 'execute' },
    'another tool': { toolName: 'github.exit_plan_mode' },
    'no task': { taskId: undefined },
    'no detail': { detail: undefined },
    'another kind of detail': { detail: { kind: 'mcp', plan: 'x', revision: 2 } },
    'a plan that is not text': { detail: { kind: 'plan', plan: { a: 1 }, revision: 2 } },
    'a blank plan': { detail: { kind: 'plan', plan: ' \n', revision: 2 } },
    'no revision': { detail: { kind: 'plan', plan: 'x' } },
    'a revision that is text': { detail: { kind: 'plan', plan: 'x', revision: '2' } },
    'revision 0': { detail: { kind: 'plan', plan: 'x', revision: 0 } },
    'a revision that is not whole': { detail: { kind: 'plan', plan: 'x', revision: 1.5 } },
    'a request that was answered': { decision: 'approved' },
  })) assert.equal(planRequest(normalizeApproval(request(more))), null, what);
});

test('the owner\'s feedback is kept with an answered request, when there was one', () => {
  assert.equal(normalizeApproval(request({ decision: 'denied', feedback: 'Smaller steps.' })).feedback, 'Smaller steps.');
  assert.equal(normalizeApproval(request({ decision: 'denied' })).feedback, undefined);
  assert.equal(normalizeApproval(request({ decision: 'denied', feedback: '   ' })).feedback, undefined);
  assert.equal(normalizeApproval(request({ decision: 'denied', feedback: { a: 1 } })).feedback, undefined);
});

// ---- the card -------------------------------------------------------------------------------------------------------------------------------------

test('the card shows the plan file, which is what an approval gives the model, not the masked copy of the request', () => {
  const asked = planRequest(normalizeApproval(request()));
  assert.deepEqual(planCard(asked, plan(2)), { text: '1. Read key.', title: 'Repair', steps: [item('Read')], revision: 2, loaded: true, changed: false, by: 'agent' });
});

test('until the plan is read, the card shows the request\'s copy under the request\'s revision, and offers no edit of it', () => {
  const asked = planRequest(normalizeApproval(request()));
  const bare = { text: '1. Read [REDACTED].', title: '', steps: [], revision: 2, loaded: false, changed: false, by: null };
  assert.deepEqual(planCard(asked, undefined), bare);
  assert.deepEqual(planCard(asked, plan(1)), bare, 'a copy the page read before the proposal is not the plan that waits');
  assert.deepEqual(planCard(asked, { title: 'old Hub' }), bare);
});

test('a plan written after the proposal is shown as it is now, and the card says who wrote it', () => {
  const asked = planRequest(normalizeApproval(request()));
  const card = planCard(asked, plan(3, { updatedBy: 'user', text: 'Edited.' }));
  assert.deepEqual([card.text, card.revision, card.changed, card.by, card.loaded], ['Edited.', 3, true, 'user', true]);
  assert.equal(planCard(asked, plan(4)).by, 'agent');
});

// ---- what Approve does ------------------------------------------------------------------------------------------------------------------------------

test('Approve answers the revision on the card; with unsaved edits it saves them first', () => {
  const asked = planRequest(normalizeApproval(request()));
  const card = planCard(asked, plan(2));
  assert.deepEqual(nextApproval(card, null, null), { kind: 'decide', revision: 2 });
  assert.deepEqual(nextApproval(planCard(asked, undefined), null, null), { kind: 'decide', revision: 2 }, 'the Hub checks the revision');
  const draft = openDraft(plan(2));
  assert.deepEqual(nextApproval(card, draft, null), { kind: 'decide', revision: 2 }, 'a draft with no edit is no edit');
  const edited = editText(draft, 'Mine.');
  assert.deepEqual(nextApproval(card, edited, null), { kind: 'save', body: { title: 'Repair', items: [item('Read')], baseRevision: 2, text: 'Mine.' } });
});

test('Approve is held back by a conflict, by a draft the Hub would refuse and by a plan with no text', () => {
  const asked = planRequest(normalizeApproval(request()));
  const card = planCard(asked, plan(2));
  const edited = editTitle(openDraft(plan(2)), 'Mine');
  const { draft, conflict } = reconcile(edited, plan(3, { text: 'Theirs' }));
  assert.deepEqual(nextApproval(card, draft, conflict), { kind: 'blocked', why: 'conflict' });
  assert.deepEqual(nextApproval(card, editStep(openDraft(plan(2)), 's0', ' '), null), { kind: 'blocked', why: 'empty_step' });
  assert.deepEqual(nextApproval(card, editText(openDraft(plan(2)), ''), null), { kind: 'blocked', why: 'empty_text' });
  assert.deepEqual(nextApproval(planCard(asked, plan(2, { text: ' ' })), null, null), { kind: 'blocked', why: 'empty_text' });
});

/** A Hub that records what it was asked; `fail` names the call that throws. */
function hub({ fail = null, revision = 3 } = {}) {
  const calls = [];
  const answer = (name, args, value) => { calls.push([name, ...args]); if (fail === name) throw Object.assign(new Error(`${name} failed`), { code: 'plan_conflict', status: 409 }); return value; };
  return {
    calls,
    savePlan: async (...args) => answer('savePlan', args, plan(revision, { updatedBy: 'user' })),
    decidePlan: async (...args) => answer('decidePlan', args, { ok: true }),
  };
}

test('approving sends the revision and the execution the owner chose, and nothing else', async () => {
  const client = hub();
  assert.equal(await approvePlan(client, TASK, { kind: 'decide', revision: 2 }, 'autonomous'), 2);
  assert.deepEqual(client.calls, [['decidePlan', TASK, 2, 'approve', { execution: 'autonomous' }]]);
});

test('approving an edit saves it on its base and approves the revision the save answered', async () => {
  const client = hub({ revision: 7 });
  const saved = [];
  const move = { kind: 'save', body: { title: 'T', items: [item('Read')], baseRevision: 2, text: 'Mine.' } };
  assert.equal(await approvePlan(client, TASK, move, 'review', (value) => saved.push([value.revision, client.calls.length])), 7);
  assert.deepEqual(client.calls, [['savePlan', TASK, 'T', [item('Read')], 2, 'Mine.'], ['decidePlan', TASK, 7, 'approve', { execution: 'review' }]]);
  assert.deepEqual(saved, [[7, 1]], 'the caller hears of the save before the decision is asked, so a decision that fails leaves no draft of a saved edit');
});

test('a save that is refused approves nothing, and a decision that is refused after a save says so', async () => {
  const refused = hub({ fail: 'savePlan' });
  const move = { kind: 'save', body: { title: 'T', items: [], baseRevision: 2 } };
  const saved = [];
  await assert.rejects(approvePlan(refused, TASK, move, 'review', (value) => saved.push(value)), { code: 'plan_conflict' });
  assert.deepEqual(refused.calls.map(([name]) => name), ['savePlan']);
  assert.deepEqual(saved, []);
  const late = hub({ fail: 'decidePlan' });
  await assert.rejects(approvePlan(late, TASK, move, 'review', (value) => saved.push(value.revision)), { code: 'plan_conflict' });
  assert.deepEqual(saved, [3]);
});

test('a plan that moved on is told by the Hub\'s code', () => {
  assert.equal(isPlanConflict(Object.assign(new Error('x'), { code: 'plan_conflict', status: 409 })), true);
  for (const other of [new Error('plan_conflict'), Object.assign(new Error('x'), { code: 'not_pending' }), null, undefined, 'plan_conflict']) assert.equal(isPlanConflict(other), false);
});

test('a request for changes needs words, and not more than the Hub takes', () => {
  assert.equal(feedbackProblem('Smaller steps.'), null);
  for (const blank of ['', '  ', '\n\t']) assert.equal(feedbackProblem(blank), 'empty');
  assert.equal(feedbackProblem('x'.repeat(4000)), null);
  assert.equal(feedbackProblem('x'.repeat(4001)), 'too_long');
});

// ---- the composer -----------------------------------------------------------------------------------------------------------------------------------

test('Plan is a flag of the next message: offered on the Model API, not on the Browser Companion', () => {
  assert.deepEqual(composerPlan({ agentMode: 'api', task: null, working: false, wanted: false }), { offered: true, checked: false, locked: null });
  assert.deepEqual(composerPlan({ agentMode: 'api', task: null, working: false, wanted: true }), { offered: true, checked: true, locked: null });
  const companion = composerPlan({ agentMode: 'chatgpt-web', task: null, working: false, wanted: true });
  assert.deepEqual(companion, { offered: false, checked: false, locked: null });
  assert.equal(sendsPlanMode(companion, true), false, 'nothing is sent to a transport that has no plan mode');
  assert.deepEqual(composerPlan({ agentMode: 'chatgpt-web', task: { planOnly: true }, working: false, wanted: true }), { offered: false, checked: false, locked: 'held' });
});

test('a task that is held shows Plan, locked: only the owner\'s approval ends it, and nothing more is sent', () => {
  for (const working of [true, false]) {
    const held = composerPlan({ agentMode: 'api', task: { planOnly: true }, working, wanted: false });
    assert.deepEqual(held, { offered: true, checked: true, locked: 'held' });
    assert.equal(sendsPlanMode(held, true), false);
  }
});

test('a task that runs outside plan mode cannot be put in it: the Hub refuses the message, so the entry is off', () => {
  const running = composerPlan({ agentMode: 'api', task: { planOnly: false }, working: true, wanted: true });
  assert.deepEqual(running, { offered: true, checked: false, locked: 'running' });
  assert.equal(sendsPlanMode(running, true), false);
  const resting = composerPlan({ agentMode: 'api', task: { planOnly: false }, working: false, wanted: true });
  assert.deepEqual(resting, { offered: true, checked: true, locked: null }, 'a follow-up of a resting one may enter it');
  assert.equal(sendsPlanMode(resting, true), true);
  assert.equal(sendsPlanMode(resting, false), false);
});

// ---- the banner ---------------------------------------------------------------------------------------------------------------------------------------

test('the banner says where a plan-mode task stands, and nothing about any other', () => {
  const approval = (status, more = {}) => ({ status, at: 'x', revision: 3, editedByUser: false, execution: null, ...more });
  for (const task of [null, undefined, {}, { planMode: false, planOnly: false }, { planMode: false, planApproval: approval('approved') }]) assert.equal(planLine(task, false), null);
  const held = (planApproval = null) => ({ planMode: true, planOnly: true, planApproval });
  assert.deepEqual(planLine(held(), false), { kind: 'planning', held: true, revision: null, execution: null, edited: false });
  assert.deepEqual(planLine(held(), true), { kind: 'waiting', held: true, revision: null, execution: null, edited: false });
  for (const status of ['denied', 'expired', 'unanswerable']) {
    assert.deepEqual(planLine(held(approval(status)), false), { kind: status, held: true, revision: 3, execution: null, edited: false });
    assert.equal(planLine(held(approval(status)), true).kind, 'waiting', 'a new proposal is what counts');
  }
  assert.equal(planLine(held(approval('something new')), false).kind, 'planning', 'a status this page does not know');
  const done = { planMode: true, planOnly: false, planApproval: approval('approved', { execution: 'autonomous', editedByUser: true }) };
  assert.deepEqual(planLine(done, false), { kind: 'approved', held: false, revision: 3, execution: 'autonomous', edited: true });
  assert.equal(planLine({ ...done, planApproval: approval('approved', { execution: 'full-access' }) }, false).execution, null, 'only a mode the Hub offers is named');
  assert.equal(planLine({ planMode: true, planOnly: false, planApproval: null }, false), null, 'neither held nor approved: nothing to say');
});

// ---- the Plan tab ---------------------------------------------------------------------------------------------------------------------------------------

test('the Plan tab can be edited for a task of the Model API, and not for one of the Browser Companion or one it does not know yet', () => {
  assert.equal(planEditable({ transport: 'api' }), true);
  assert.equal(planEditable({}), true, 'a task recorded before transports');
  assert.equal(planEditable({ transport: 'chatgpt-web' }), false);
  assert.equal(planEditable(null), false);
  assert.equal(planEditable(undefined), false);
});

test('the head of the plan: its revision, who wrote it, and whether what was approved is what it says now', () => {
  assert.equal(planHead(undefined), null);
  assert.equal(planHead({ title: '', items: [] }), null, 'nothing was written yet');
  assert.deepEqual(planHead(plan(2)), { revision: 2, by: 'agent', approved: null });
  assert.deepEqual(planHead(plan(3, { updatedBy: 'user', approvedRevision: 3 })), { revision: 3, by: 'user', approved: { revision: 3, current: true } });
  assert.deepEqual(planHead(plan(5, { approvedRevision: 3 })), { revision: 5, by: 'agent', approved: { revision: 3, current: false } });
  assert.equal(planHead(plan(1, { updatedBy: null })).by, null);
});
