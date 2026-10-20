import test from 'node:test';
import assert from 'node:assert/strict';
import { draftIssues, parseDeps, GROUP_LIMITS, CODING_LIMITS } from '../src/lib/agent-draft.ts';

// The Hub refuses a bad id, an unknown dependency or a cycle with a 400. The form says so before the owner presses start.

const node = (id, extra = {}) => ({ id, prompt: `do ${id}`, dependsOn: [], ...extra });
const codes = (issues) => issues.map(issue => `${issue.index}:${issue.field}:${issue.code}`).sort();

test('a clean draft has no issues', () => {
  assert.deepEqual(draftIssues([node('task-a'), node('task-b', { dependsOn: ['task-a'] })], CODING_LIMITS), []);
});

test('an empty description is reported as empty, not as invalid', () => {
  assert.deepEqual(codes(draftIssues([node('task-a', { prompt: '  ' })], CODING_LIMITS)), ['0:text:empty']);
});

test('an id is a lowercase slug the Hub accepts; coding ids may not use "_", helper ids may', () => {
  for (const id of ['', 'Task', '1task', 'task a', 'task/a', 'x'.repeat(40)]) {
    assert.deepEqual(codes(draftIssues([node(id)], CODING_LIMITS)).filter(code => code.includes(':id:')), ['0:id:invalid'], JSON.stringify(id));
  }
  assert.deepEqual(draftIssues([node('task_a')], CODING_LIMITS).map(issue => issue.code), ['invalid']);
  assert.deepEqual(draftIssues([node('task_a')], GROUP_LIMITS), []);
  assert.deepEqual(draftIssues([node('a'.repeat(31))], CODING_LIMITS), []);
  assert.deepEqual(codes(draftIssues([node('a'.repeat(32))], CODING_LIMITS)), ['0:id:invalid']);
  assert.deepEqual(draftIssues([node('a'.repeat(32))], GROUP_LIMITS), []);
});

test('ids are unique: the later ones are flagged', () => {
  assert.deepEqual(codes(draftIssues([node('same'), node('other'), node('same')], CODING_LIMITS)), ['2:id:duplicate']);
});

test('a dependency must be another task of the draft', () => {
  assert.deepEqual(codes(draftIssues([node('task-a', { dependsOn: ['ghost'] })], CODING_LIMITS)), ['0:deps:unknown']);
  assert.deepEqual(codes(draftIssues([node('task-a', { dependsOn: ['task-a'] })], CODING_LIMITS)), ['0:deps:self']);
});

test('a dependency listed twice is flagged, and a task that only waits for a loop is not part of it', () => {
  assert.deepEqual(codes(draftIssues([node('task-a'), node('task-b', { dependsOn: ['task-a', 'task-a'] })], CODING_LIMITS)), ['1:deps:duplicate']);
  const tail = [node('task-a', { dependsOn: ['task-b'] }), node('task-b', { dependsOn: ['task-a'] }), node('task-c', { dependsOn: ['task-a'] })];
  assert.deepEqual(codes(draftIssues(tail, CODING_LIMITS)), ['0:deps:cycle', '1:deps:cycle']);
});

test('the number of dependencies and of tasks is bounded as the Hub bounds it', () => {
  const many = ['a', 'b', 'c', 'd'].map(id => node(`task-${id}`));
  const needy = node('task-z', { dependsOn: many.map(item => item.id) });
  assert.ok(codes(draftIssues([...many, needy], CODING_LIMITS)).includes('4:deps:too_many'));
  assert.deepEqual(codes(draftIssues([node('a'), node('b'), node('c'), node('d'), node('e')], CODING_LIMITS)), ['4:list:too_many']);
  assert.deepEqual(codes(draftIssues([], CODING_LIMITS)), ['0:list:empty']);
});

test('tasks that wait for each other in a loop are flagged on every task of the loop', () => {
  const loop = [node('task-a', { dependsOn: ['task-b'] }), node('task-b', { dependsOn: ['task-a'] }), node('task-c')];
  assert.deepEqual(codes(draftIssues(loop, CODING_LIMITS)), ['0:deps:cycle', '1:deps:cycle']);
});

test('a description of exactly the limit is accepted', () => {
  assert.deepEqual(draftIssues([node('task-a', { prompt: 'x'.repeat(CODING_LIMITS.textMax) })], CODING_LIMITS), []);
  assert.deepEqual(draftIssues([{ id: 'plan', question: 'x'.repeat(GROUP_LIMITS.textMax), dependsOn: [] }], GROUP_LIMITS), []);
});

test('a description over the limit is flagged with the limit', () => {
  const issues = draftIssues([node('task-a', { prompt: 'x'.repeat(CODING_LIMITS.textMax + 1) })], CODING_LIMITS);
  assert.deepEqual(issues.map(issue => [issue.field, issue.code, issue.max]), [['text', 'too_long', CODING_LIMITS.textMax]]);
});

test('the helper group takes its text from "question" and allows more helpers and more dependencies', () => {
  const group = [{ id: 'plan', question: 'Plan it', dependsOn: [] }, { id: 'review', question: '', dependsOn: ['plan'] }];
  assert.deepEqual(codes(draftIssues(group, GROUP_LIMITS)), ['1:text:empty']);
  assert.equal(GROUP_LIMITS.maxItems, 8);
  assert.equal(GROUP_LIMITS.maxDeps, 7);
  assert.equal(GROUP_LIMITS.textMax, 500);
  assert.equal(CODING_LIMITS.maxItems, 4);
  assert.equal(CODING_LIMITS.maxDeps, 3);
  assert.equal(CODING_LIMITS.textMax, 3000);
});

test('the "waits for" box is read as a list of ids: trimmed, without blanks, each id once', () => {
  assert.deepEqual(parseDeps('plan, research'), ['plan', 'research']);
  assert.deepEqual(parseDeps(' a ,, a , b ,'), ['a', 'b']);
  assert.deepEqual(parseDeps(''), []);
  assert.deepEqual(parseDeps('plan,'), ['plan'], 'a comma on its way to a second id');
});

test('a draft is not read twice: the same input gives the same issues', () => {
  const draft = [node('task-a', { dependsOn: ['ghost'] }), node('task-a')];
  assert.deepEqual(draftIssues(draft, CODING_LIMITS), draftIssues(draft, CODING_LIMITS));
});
