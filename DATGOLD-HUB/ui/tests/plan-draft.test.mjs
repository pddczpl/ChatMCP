import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PLAN_LIMITS, addStep, draftProblem, editStep, editText, editTitle, isDirty, keepMine, moveStep, openDraft, reconcile, removeStep, saveBody, stepView,
} from '../src/lib/plan-draft.ts';

// The owner's draft of a plan (P9 ac-11): what they type lives apart from the plan the page fetches every 2.5 s, so a refetch never takes a word away. A draft knows
// the revision it was opened from. When the plan moves on, a change of the agent's own marks (status, evidence) is merged without a word; a change of the words is a
// conflict that the owner settles. Evidence belongs to the agent: the owner can move, reword or delete a step, never write evidence for it.

const item = (text, status = 'todo', evidence = '') => ({ text, status, evidence });
const plan = (revision, items, more = {}) => ({ version: 2, title: 'Repair', text: '1. Read.\n2. Edit.', revision, updatedBy: 'agent', updatedAt: null, approvedAt: null, approvedRevision: null, items, ...more });
const base = () => plan(4, [item('Read calc.js', 'done', 'read_file calc.js'), item('Fix add()', 'doing'), item('Run the tests')]);
const texts = (draft) => draft.steps.map((step) => step.text);
const ids = (draft) => draft.steps.map((step) => step.id);

// ---- opening ----------------------------------------------------------------------------------------------------------------------------------

test('a draft holds the words of the plan and the revision it was opened from, and is not dirty', () => {
  const draft = openDraft(base());
  assert.equal(draft.basis.revision, 4);
  assert.deepEqual([draft.title, draft.text], ['Repair', '1. Read.\n2. Edit.']);
  assert.deepEqual(texts(draft), ['Read calc.js', 'Fix add()', 'Run the tests']);
  assert.equal(new Set(ids(draft)).size, 3, 'every step has an id of its own');
  assert.equal(isDirty(draft), false);
  assert.equal(draftProblem(draft), null);
});

test('a plan of an old Hub or an empty one opens as revision 0 with no text and no steps', () => {
  const draft = openDraft({ title: 'Old', items: [item('A')] });
  assert.deepEqual([draft.basis.revision, draft.basis.updatedBy, draft.text, draft.title], [0, null, '', 'Old']);
  assert.deepEqual(texts(draft), ['A']);
  const empty = openDraft({});
  assert.deepEqual([empty.title, empty.text, texts(empty)], ['', '', []]);
  assert.equal(isDirty(empty), false);
  assert.deepEqual(openDraft({ items: [{ text: 'No evidence', status: 'done' }] }).basis.items, [item('No evidence', 'done', '')]);
});

test('the same plan opened twice gives the same ids, so a list that is drawn again keeps its inputs', () => {
  assert.deepEqual(ids(openDraft(base())), ids(openDraft(base())));
});

// ---- editing ----------------------------------------------------------------------------------------------------------------------------------

test('every edit makes the draft dirty, and taking it back makes it clean again', () => {
  const draft = openDraft(base());
  const [first] = ids(draft);
  for (const [what, changed, back] of [
    ['title', (d) => editTitle(d, 'Other'), (d) => editTitle(d, 'Repair')],
    ['text', (d) => editText(d, 'Other'), (d) => editText(d, '1. Read.\n2. Edit.')],
    ['a step', (d) => editStep(d, first, 'Read it'), (d) => editStep(d, first, 'Read calc.js')],
    ['the order', (d) => moveStep(d, first, 1), (d) => moveStep(d, first, -1)],
  ]) {
    assert.equal(isDirty(changed(draft)), true, `${what} changed`);
    assert.equal(isDirty(back(changed(draft))), false, `${what} put back`);
  }
  for (const id of ids(draft)) assert.equal(isDirty(removeStep(draft, id)), true, 'a step deleted, the last one too');
  assert.equal(isDirty(addStep(draft).draft), true, 'a step added');
  assert.equal(isDirty(draft), false, 'no edit changes the draft it was given');
});

test('a step deleted and one added of the same words is still an edit: the agent wrote neither', () => {
  const draft = openDraft(plan(1, [item('A')]));
  const added = addStep(removeStep(draft, ids(draft)[0]));
  assert.equal(isDirty(editStep(added.draft, added.id, 'A')), true);
});

test('a step is added at the end or under another one, empty, with an id nothing else has', () => {
  const draft = openDraft(base());
  const end = addStep(draft);
  assert.deepEqual(texts(end.draft), ['Read calc.js', 'Fix add()', 'Run the tests', '']);
  assert.equal(end.draft.steps.at(-1).id, end.id);
  const under = addStep(end.draft, ids(draft)[0]);
  assert.deepEqual(texts(under.draft), ['Read calc.js', '', 'Fix add()', 'Run the tests', '']);
  assert.equal(under.draft.steps[1].id, under.id);
  assert.equal(new Set(ids(under.draft)).size, 5, 'no id is used twice');
  const unknown = addStep(draft, 'nobody');
  assert.deepEqual(texts(unknown.draft), ['Read calc.js', 'Fix add()', 'Run the tests', ''], 'under a step that is not there: at the end');
});

test('an id is not used again after its step was deleted', () => {
  const draft = openDraft(plan(1, [item('A')]));
  const one = addStep(draft);
  const two = addStep(removeStep(one.draft, one.id));
  assert.notEqual(two.id, one.id);
});

test('a step moves one place up or down, and not past an end', () => {
  const draft = openDraft(base());
  const [a, b, c] = ids(draft);
  assert.deepEqual(texts(moveStep(draft, b, -1)), ['Fix add()', 'Read calc.js', 'Run the tests']);
  assert.deepEqual(texts(moveStep(draft, b, 1)), ['Read calc.js', 'Run the tests', 'Fix add()']);
  assert.equal(moveStep(draft, a, -1), draft, 'the first one cannot go up');
  assert.equal(moveStep(draft, c, 1), draft, 'the last one cannot go down');
  assert.equal(moveStep(draft, 'nobody', 1), draft);
});

// ---- what is wrong with a draft -------------------------------------------------------------------------------------------------------------

test('a draft that the Hub would refuse says why, and the limits are the Hub\'s', () => {
  assert.deepEqual(PLAN_LIMITS, { steps: 100, stepChars: 500, titleChars: 240, textChars: 40_000, feedbackChars: 4_000 });
  const draft = openDraft(base());
  const [first] = ids(draft);
  assert.equal(draftProblem(editStep(draft, first, '   ')), 'empty_step');
  assert.equal(draftProblem(editStep(draft, first, 'x'.repeat(500))), null);
  assert.equal(draftProblem(editStep(draft, first, 'x'.repeat(501))), 'step_too_long');
  assert.equal(draftProblem(editStep(draft, first, `${'x'.repeat(500)}  `)), null, 'the spaces around a step are not sent, so they do not count');
  assert.equal(draftProblem(editText(draft, 'x'.repeat(40_000))), null);
  assert.equal(draftProblem(editText(draft, 'x'.repeat(40_001))), 'text_too_long');
  assert.equal(draftProblem(editText(draft, ' \n ')), 'empty_text', 'a plan that had a text keeps one');
  assert.equal(draftProblem(editText(openDraft(plan(1, [item('A')], { text: '' })), '')), null, 'a plan that never had one needs none');
  const hundred = openDraft(plan(1, Array.from({ length: 100 }, (_, n) => item(`Step ${n}`))));
  assert.equal(draftProblem(hundred), null);
  const more = addStep(hundred);
  assert.equal(draftProblem(editStep(more.draft, more.id, 'One more')), 'too_many_steps');
});

// ---- what is saved ----------------------------------------------------------------------------------------------------------------------------

test('what is saved names the revision it is based on, and sends the text only when the owner changed it', () => {
  const draft = editTitle(openDraft(base()), '  New title ');
  assert.deepEqual(saveBody(draft), { title: 'New title', items: base().items, baseRevision: 4 });
  assert.equal('text' in saveBody(draft), false);
  assert.equal(saveBody(editText(draft, '1. Only this.\n')).text, '1. Only this.\n', 'the text goes as typed');
});

test('evidence is the agent\'s: a moved step keeps its status and evidence, a reworded one loses them, and an added one has none', () => {
  const draft = openDraft(base());
  const [read, fix, run] = ids(draft);
  assert.deepEqual(saveBody(moveStep(draft, read, 1)).items, [item('Fix add()', 'doing'), item('Read calc.js', 'done', 'read_file calc.js'), item('Run the tests')]);
  assert.deepEqual(saveBody(editStep(draft, read, 'Read calc.js and test.js')).items[0], item('Read calc.js and test.js', 'todo', ''), 'what the agent proved was another step');
  assert.deepEqual(saveBody(editStep(draft, fix, 'Fix add() and sub()')).items[1], item('Fix add() and sub()', 'doing', ''), 'a step that is under way stays under way');
  assert.deepEqual(saveBody(editStep(draft, read, '  Read calc.js ')).items[0], item('Read calc.js', 'done', 'read_file calc.js'), 'spaces are not words');
  const spaced = openDraft(plan(1, [item(' Read calc.js ', 'done', 'read_file calc.js')]));
  assert.deepEqual(saveBody(spaced).items, [item('Read calc.js', 'done', 'read_file calc.js')], 'nor are the spaces the agent wrote');
  const added = addStep(draft, run);
  assert.deepEqual(saveBody(editStep(added.draft, added.id, ' Say what changed ')).items.at(-1), item('Say what changed', 'todo', ''));
  assert.deepEqual(saveBody(removeStep(draft, fix)).items, [item('Read calc.js', 'done', 'read_file calc.js'), item('Run the tests')]);
  const blocked = openDraft(plan(1, [item('Deploy', 'blocked', 'No access')]));
  assert.deepEqual(saveBody(editStep(blocked, ids(blocked)[0], 'Deploy later')).items[0], item('Deploy later', 'blocked', ''));
});

test('the editor is told, step by step, what the agent recorded and whether the owner\'s words take it away', () => {
  const draft = openDraft(base());
  const [read, fix] = draft.steps;
  assert.deepEqual(stepView(draft, read), { status: 'done', evidence: 'read_file calc.js', loses: false });
  assert.deepEqual(stepView(draft, fix), { status: 'doing', evidence: '', loses: false });
  const reworded = editStep(draft, read.id, 'Read everything');
  assert.deepEqual(stepView(reworded, reworded.steps[0]), { status: 'todo', evidence: '', loses: true });
  const doing = editStep(draft, fix.id, 'Fix add() well');
  assert.deepEqual(stepView(doing, doing.steps[1]), { status: 'doing', evidence: '', loses: false }, 'nothing recorded, nothing lost');
  const done = openDraft(plan(1, [item('A', 'done', '')]));
  const doneAgain = editStep(done, done.steps[0].id, 'B');
  assert.equal(stepView(doneAgain, doneAgain.steps[0]).loses, true, 'the word "done" is the agent\'s too');
  const noted = openDraft(plan(1, [item('A', 'blocked', 'No access')]));
  const notedAgain = editStep(noted, noted.steps[0].id, 'B');
  assert.equal(stepView(notedAgain, notedAgain.steps[0]).loses, true);
  const blank = openDraft(plan(1, [item('A', 'doing', '   ')]));
  const blankAgain = editStep(blank, blank.steps[0].id, 'B');
  assert.equal(stepView(blankAgain, blankAgain.steps[0]).loses, false, 'blank evidence is none');
  const added = addStep(draft);
  assert.deepEqual(stepView(added.draft, added.draft.steps.at(-1)), { status: 'todo', evidence: '', loses: false });
});

// ---- the plan moves on while the owner types --------------------------------------------------------------------------------------------------

test('a refetch of the same revision changes nothing: the draft is the very same one', () => {
  const draft = editTitle(openDraft(base()), 'Mine');
  const after = reconcile(draft, base());
  assert.equal(after.draft, draft);
  assert.equal(after.conflict, null);
});

test('the agent marking its steps is merged under the owner\'s words, without a conflict', () => {
  const draft = openDraft(base());
  const mine = moveStep(editStep(draft, ids(draft)[2], 'Run all the tests'), ids(draft)[2], -1);
  const marked = plan(5, [item('Read calc.js', 'done', 'read_file calc.js'), item('Fix add()', 'done', 'edit_file calc.js'), item('Run the tests', 'doing')]);
  const { draft: merged, conflict } = reconcile(mine, marked);
  assert.equal(conflict, null);
  assert.deepEqual(texts(merged), ['Read calc.js', 'Run all the tests', 'Fix add()'], 'the owner\'s words and order');
  assert.equal(isDirty(merged), true);
  assert.deepEqual(saveBody(merged), { title: 'Repair', baseRevision: 5, items: [
    item('Read calc.js', 'done', 'read_file calc.js'), item('Run all the tests', 'doing', ''), item('Fix add()', 'done', 'edit_file calc.js'),
  ] }, 'saved from the new revision, with the marks the agent made meanwhile');
});

test('a draft nobody typed in follows the plan', () => {
  const { draft, conflict } = reconcile(openDraft(base()), plan(5, [item('Another plan')], { title: 'Two', text: 'Other' }));
  assert.equal(conflict, null);
  assert.deepEqual([draft.basis.revision, draft.title, draft.text, texts(draft)], [5, 'Two', 'Other', ['Another plan']]);
});

test('a change of the words under a draft with edits is a conflict that says who wrote what, and takes nothing away', () => {
  const mine = editTitle(openDraft(base()), 'Mine');
  const changes = {
    title: plan(5, base().items, { title: 'Theirs' }),
    text: plan(5, base().items, { text: 'Theirs' }),
    'the words of a step': plan(5, [item('Read calc.js', 'done', 'read_file calc.js'), item('Fix it'), item('Run the tests')]),
    'a step more': plan(5, [...base().items, item('Report')]),
    'a step less': plan(5, base().items.slice(0, 2)),
    'the order': plan(5, [...base().items].reverse()),
  };
  for (const [what, now] of Object.entries(changes)) {
    const after = reconcile(mine, { ...now, updatedBy: 'user' });
    assert.deepEqual(after.conflict, { base: 4, revision: 5, by: 'user' }, what);
    assert.equal(after.draft, mine, `${what}: the draft is as the owner left it`);
  }
  assert.equal(reconcile(mine, changes.title).conflict.by, 'agent');
});

test('a plan at a lower revision than the draft is a conflict too: nobody saves over a plan they have not read', () => {
  const mine = editTitle(openDraft(base()), 'Mine');
  assert.deepEqual(reconcile(mine, plan(2, [item('Earlier')])).conflict, { base: 4, revision: 2, by: 'agent' });
});

// ---- settling a conflict ------------------------------------------------------------------------------------------------------------------------

test('"keep mine" puts the owner\'s edits on the new revision and takes what they did not touch from it', () => {
  const draft = openDraft(base());
  const mine = editStep(draft, ids(draft)[1], 'Fix add() with a test');
  const now = plan(6, [item('Read calc.js', 'done', 'read again'), item('Fix add()', 'done', 'edit_file calc.js'), item('Report')], { title: 'Theirs', text: 'Their text', updatedBy: 'agent' });
  const kept = keepMine(mine, now);
  assert.equal(reconcile(kept, now).conflict, null, 'the conflict is settled');
  assert.equal(kept.basis.revision, 6);
  assert.deepEqual([kept.title, kept.text], ['Theirs', 'Their text'], 'the title and the text were not the owner\'s to keep');
  assert.deepEqual(texts(kept), ['Read calc.js', 'Fix add() with a test', 'Run the tests'], 'the list is the owner\'s, whole');
  assert.deepEqual(saveBody(kept).items, [item('Read calc.js', 'done', 'read again'), item('Fix add() with a test', 'todo', ''), item('Run the tests', 'todo', '')],
    'a step of the same words has the marks of the new revision; a step the new revision does not have has none');
  assert.equal(saveBody(kept).baseRevision, 6);
});

test('a step the owner reworded is the one of its old words in "keep mine": one that is under way stays under way', () => {
  const draft = openDraft(base());
  const mine = editStep(draft, ids(draft)[2], 'Run all the tests');
  const kept = keepMine(mine, plan(6, [item('Read calc.js', 'done', 'read_file calc.js'), item('Run the tests', 'doing'), item('Run all the tests', 'blocked', 'theirs')]));
  assert.deepEqual(saveBody(kept).items.at(-1), item('Run all the tests', 'doing', ''));
});

test('"keep mine" keeps the title and the text the owner wrote, and takes the list they did not touch', () => {
  const mine = editText(editTitle(openDraft(base()), 'My title'), 'My text');
  const now = plan(6, [item('New list')], { title: 'Theirs', text: 'Their text' });
  const kept = keepMine(mine, now);
  assert.deepEqual([kept.title, kept.text, texts(kept)], ['My title', 'My text', ['New list']]);
  assert.equal(isDirty(kept), true);
  assert.equal(kept.steps[0].from, 0);
});

test('two steps of the same words are matched one to one, and the owner\'s added steps match nothing that was not there', () => {
  const twice = plan(1, [item('Run tests', 'done', 'first'), item('Run tests', 'todo', '')]);
  const draft = openDraft(twice);
  const added = addStep(draft);
  const mine = editStep(added.draft, added.id, 'Run tests');
  const kept = keepMine(mine, plan(2, [item('Run tests', 'done', 'first'), item('Run tests', 'done', 'second'), item('Other')]));
  assert.deepEqual(saveBody(kept).items, [item('Run tests', 'done', 'first'), item('Run tests', 'done', 'second'), item('Run tests', 'todo', '')]);
});

test('a step the owner added takes a mark in "keep mine" only when the agent recorded it for the very same words', () => {
  const draft = openDraft(plan(1, [item('A')]));
  const added = addStep(draft);
  const mine = editStep(added.draft, added.id, 'B');
  const kept = keepMine(mine, plan(2, [item('B', 'done', 'proof of B'), item('A')]));
  assert.deepEqual(saveBody(kept).items, [item('A', 'todo', ''), item('B', 'done', 'proof of B')], 'the same words: the mark is the agent\'s own, on the agent\'s own step');
});

test('ids stay what they were in "keep mine", so the input under the cursor stays', () => {
  const draft = openDraft(base());
  const added = addStep(draft);
  const mine = editStep(added.draft, added.id, 'Mine');
  const kept = keepMine(mine, plan(6, [item('Other')]));
  assert.deepEqual(ids(kept), ids(mine));
  const next = addStep(kept);
  assert.equal(new Set(ids(next.draft)).size, 5);
});
