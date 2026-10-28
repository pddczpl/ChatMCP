import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptInOrder, kindFor, pendingSuggestions, suggestReceipt } from '../src/lib/objective-suggestions.ts';
import { decomposeCodingTask } from '../../lib/agent-autonomy.mjs';
import { acceptObjectiveCriterion, acceptanceKind, acceptedObjectiveIds, availableObjectiveReceipts } from '../../lib/objective-acceptance.mjs';

// The acceptance panel made the owner build every choice from an empty list: one receipt for each criterion of each objective, with nothing to say which one. It now shows the latest receipt of the
// kind each criterion needs, already chosen, and one button confirms the whole plan in the order the Hub needs. What is accepted is still decided by the Hub (lib/objective-acceptance.mjs): these
// tests run the REAL plan builder and the REAL acceptance function against what the page suggests.
const PROMPT = '1. Inspect source files and project requirements, capture independently verified read evidence before editing any source code.\n2. Implement a bounded source patch and test the changed code thoroughly with real command exit status and actual Git review evidence.';
const progress = {
  verifiedInspections: [{ kind: 'inspect', step: 1, id: 'read-1' }, { kind: 'inspect', step: 5, id: 'read-2' }],
  verifiedFiles: [{ kind: 'edit', step: 2, path: 'source.js', sha256: 'a'.repeat(64) }, { kind: 'edit', step: 6, path: 'other.js', sha256: 'b'.repeat(64) }],
  verifiedChecks: [{ kind: 'verify', step: 3, id: 'check-1' }],
  gitReviews: [{ kind: 'review', step: 4, id: 'diff-1' }],
};
const receipts = availableObjectiveReceipts(progress);

test('the page reads a criterion as the Hub does', () => {
  const plan = decomposeCodingTask(PROMPT);
  const criteria = plan.objectives.flatMap((objective) => objective.acceptanceCriteria);
  assert.ok(criteria.length >= 4);
  for (const criterion of [...criteria, '', 'Something else', 'observe workspace evidence', 'If code changes', ' Run required supported checks']) {
    assert.equal(kindFor(criterion), acceptanceKind(criterion), JSON.stringify(criterion));
  }
});

test('the suggestion is the latest receipt of the kind the criterion needs, and none for a criterion no receipt can match', () => {
  const [first] = decomposeCodingTask(PROMPT).objectives;
  assert.equal(suggestReceipt(first.acceptanceCriteria[0], receipts).receiptId, 'inspect:5:read-2', 'the later of two inspections');
  const second = decomposeCodingTask(PROMPT).objectives[1];
  assert.equal(suggestReceipt(second.acceptanceCriteria[1], receipts).kind, 'edit');
  assert.equal(suggestReceipt(second.acceptanceCriteria[1], receipts).step, 6, 'the later of two edits');
  assert.equal(suggestReceipt(second.acceptanceCriteria[2], receipts).kind, 'verify');
  assert.equal(suggestReceipt('Something else', receipts), null, 'a criterion the Hub cannot map to a receipt has no suggestion');
  assert.equal(suggestReceipt(first.acceptanceCriteria[0], receipts.filter((receipt) => receipt.kind !== 'inspect')), null, 'no receipt of the kind: none');
  const tie = [{ receiptId: 'verify:3:a', kind: 'verify', step: 3 }, { receiptId: 'verify:3:b', kind: 'verify', step: 3 }];
  assert.equal(suggestReceipt('Run required supported checks and record real exit code', tie).receiptId, 'verify:3:b', 'at the same step, the one recorded last');
  assert.equal(suggestReceipt('Run required supported checks and record real exit code', []), null);
});

test('one confirmation of the whole plan: every criterion in the order of the plan, the second objective reached because the first is completed before it', () => {
  const plan = decomposeCodingTask(PROMPT);
  const suggestions = pendingSuggestions(plan.objectives, receipts);
  assert.deepEqual(suggestions.map((item) => `${item.objectiveId}:${item.criterionIndex}`), ['objective-1:0', 'objective-2:0', 'objective-2:1', 'objective-2:2']);
  assert.deepEqual(suggestions.map((item) => item.receipt.kind), ['inspect', 'inspect', 'edit', 'verify']);
});

test('the Hub accepts what the page sends, in that order, and the whole plan is accepted at the end (no refusal, no dependency error)', async () => {
  let current = decomposeCodingTask(PROMPT);
  const calls = [];
  const outcome = await acceptInOrder(pendingSuggestions(current.objectives, receipts), {}, async (item) => {
    calls.push(`${item.objectiveId}:${item.criterionIndex}:${item.receiptId}`);
    current = acceptObjectiveCriterion(current, progress, { ...item, confirmed: true }); // the real function: it throws when a receipt is stale or a predecessor is not verified
  });
  assert.equal(outcome.failed, undefined);
  assert.equal(outcome.done, 4);
  assert.deepEqual(acceptedObjectiveIds(current, progress), ['objective-1', 'objective-2']);
  assert.deepEqual(calls, ['objective-1:0:inspect:5:read-2', 'objective-2:0:inspect:5:read-2', 'objective-2:1:edit:6:' + 'b'.repeat(64), 'objective-2:2:verify:3:check-1']);
  assert.deepEqual(pendingSuggestions(current.objectives, receipts), [], 'and nothing is left to suggest');
});

test('a receipt the owner chose in a list wins over the suggestion, for that criterion only', async () => {
  const plan = decomposeCodingTask(PROMPT);
  const sent = [];
  await acceptInOrder(pendingSuggestions(plan.objectives, receipts), { 'objective-2:0': 'inspect:1:read-1' }, async (item) => { sent.push(`${item.objectiveId}:${item.criterionIndex}:${item.receiptId}`); });
  assert.deepEqual(sent.slice(0, 2), ['objective-1:0:inspect:5:read-2', 'objective-2:0:inspect:1:read-1']);
  assert.equal(sent[2], 'objective-2:1:edit:6:' + 'b'.repeat(64), 'the others keep the suggestion');
});

test('the first refusal of the Hub stops it: what was accepted stays, the rest is not tried', async () => {
  const plan = decomposeCodingTask(PROMPT);
  const tried = [];
  const refusal = Object.assign(new Error('Select a fresh first-party receipt for this criterion.'), { code: 'stale_acceptance_receipt' });
  const outcome = await acceptInOrder(pendingSuggestions(plan.objectives, receipts), {}, async (item) => {
    tried.push(`${item.objectiveId}:${item.criterionIndex}`);
    if (item.objectiveId === 'objective-2' && item.criterionIndex === 1) throw refusal;
  });
  assert.equal(outcome.done, 2);
  assert.equal(outcome.failed.error, refusal);
  assert.deepEqual([outcome.failed.suggestion.objectiveId, outcome.failed.suggestion.criterionIndex], ['objective-2', 1]);
  assert.deepEqual(tried, ['objective-1:0', 'objective-2:0', 'objective-2:1'], 'the criterion after the refused one was not sent');
  assert.deepEqual(await acceptInOrder([], {}, async () => { throw new Error('never'); }), { done: 0 }, 'nothing to confirm is not a failure');
});

test('a criterion that is matched to a receipt that is still current is not suggested again, and one matched to a stale receipt is', () => {
  const plan = decomposeCodingTask(PROMPT);
  const [first, second] = plan.objectives;
  const matched = [{ ...first, status: 'verified', evidence: [{ criterionIndex: 0, receiptId: 'inspect:1:read-1' }] }, second];
  assert.deepEqual(pendingSuggestions(matched, receipts).map((item) => `${item.objectiveId}:${item.criterionIndex}`), ['objective-2:0', 'objective-2:1', 'objective-2:2'], 'objective-1 is verified: its criterion is not offered, and objective-2 is reached');
  const partly = { ...second, status: 'has_evidence', evidence: [{ criterionIndex: 0, receiptId: 'inspect:1:read-1' }, { criterionIndex: 2, receiptId: 'verify:9:gone' }] };
  assert.deepEqual(pendingSuggestions([{ ...first, status: 'verified' }, partly], receipts).map((item) => item.criterionIndex), [1, 2], 'criterion 0 is current; criterion 2 names a receipt that is gone, so the current one is suggested');
});

test('an objective that cannot be completed holds back the ones that depend on it, and one that depends on nothing is not held back', () => {
  const plan = decomposeCodingTask(PROMPT);
  const [first, second] = plan.objectives;
  const third = { id: 'objective-3', text: 'after', status: 'todo', dependsOn: ['objective-2'], acceptanceCriteria: ['Observe workspace evidence directly relevant to this objective'] };
  const free = { id: 'objective-4', text: 'free', status: 'todo', dependsOn: [], acceptanceCriteria: ['Observe workspace evidence directly relevant to this objective'] };
  const noChecks = receipts.filter((receipt) => receipt.kind !== 'verify');
  const ids = (list) => pendingSuggestions([first, second, third, free], list).map((item) => `${item.objectiveId}:${item.criterionIndex}`);
  assert.deepEqual(ids(noChecks), ['objective-1:0', 'objective-2:0', 'objective-2:1', 'objective-4:0'], 'no check was run: objective-2 is not completed by the batch, so objective-3 is not reached; objective-4 is');
  assert.deepEqual(ids(receipts), ['objective-1:0', 'objective-2:0', 'objective-2:1', 'objective-2:2', 'objective-3:0', 'objective-4:0'], 'with a check, it is');
  assert.deepEqual(pendingSuggestions([first, second], []), [], 'no receipt at all: nothing to confirm');
  const odd = { id: 'objective-5', text: 'odd', status: 'todo', dependsOn: [], acceptanceCriteria: ['Do something the Hub cannot map', 'Observe workspace evidence directly relevant to this objective'] };
  assert.deepEqual(pendingSuggestions([odd, { ...third, id: 'objective-6', dependsOn: ['objective-5'] }], receipts).map((item) => `${item.objectiveId}:${item.criterionIndex}`), ['objective-5:1'], 'a criterion with no kind is never completed: its objective stays open and the dependent is not reached');
  const empty = { id: 'objective-7', text: 'nothing to accept', status: 'todo', dependsOn: [], acceptanceCriteria: [] };
  assert.deepEqual(pendingSuggestions([empty, { ...third, id: 'objective-8', dependsOn: ['objective-7'] }], receipts), [], 'an objective with no criterion is never accepted (the Hub requires at least one): nothing after it is reached');
});
