import test from 'node:test';
import assert from 'node:assert/strict';
import {
  describePlan, describeResult, lastRestoreOf, planSelection, planStepUndo, planTaskUndo, readLastRestore, restoreErrorKey, undoRequestOf, undoTarget, writeLastRestore,
} from '../src/lib/rollback.ts';

// What "undo" means to the page: a plan made from the Hub's preview (which files go back, which are left alone and why), the words for it, and the words for what happened. All plain data in,
// plain data out: nothing here touches the Hub or the screen. The expectations are written by hand.

const SHA = (letter) => letter.repeat(64);
const file = (path, action, extra = {}) => ({ path, kind: action === 'remove' ? 'absent' : 'copy', action, baselineSha: SHA('b'), currentSha: action === 'recreate' ? null : SHA('c'), changedSinceStep: false, willOverwriteNewer: action === 'overwrite' || action === 'remove', ...extra });
const preview = (files, extra = {}) => ({ checkpointId: 'cp', taskId: null, targeted: true, limitations: [], files, unsupported: [], ...extra });

test('undo this step: the files the step left are put back, those changed since are left alone and named, those already right are skipped', () => {
  const plan = planStepUndo(preview([
    file('a.txt', 'overwrite'),
    file('b.txt', 'recreate'),
    file('c.txt', 'remove'),
    file('d.txt', 'unchanged'),
    file('e.txt', 'overwrite', { changedSinceStep: true, currentSha: SHA('e') }),
    file('f.txt', 'overwrite', { changedSinceStep: null, currentSha: SHA('f') }),
  ]));
  assert.deepEqual(plan.rows, [
    { path: 'a.txt', action: 'overwrite', changedLater: false, stepUnknown: false },
    { path: 'b.txt', action: 'recreate', changedLater: false, stepUnknown: false },
    { path: 'c.txt', action: 'remove', changedLater: false, stepUnknown: false },
    { path: 'f.txt', action: 'overwrite', changedLater: false, stepUnknown: true },
  ], 'what will be done, in the Hub\'s order; a file whose step is unknown is marked');
  assert.deepEqual(plan.conflicts, ['e.txt'], 'a file that changed after the step is not touched');
  assert.deepEqual(plan.unchanged, ['d.txt']);
  assert.deepEqual(plan.expectedShas, { 'a.txt': SHA('c'), 'b.txt': null, 'c.txt': SHA('c'), 'f.txt': SHA('f') }, 'each file is expected to be what it is now (a missing one: null), and the conflict is not asked for');
  assert.equal(plan.incomplete, false);
  assert.equal(plan.unknownSteps, 1, 'one file for which the Hub did not note what the step left');
});

test('a snapshot taken before a command is incomplete, and what the Hub could not bring back is passed on', () => {
  const plan = planStepUndo(preview([file('a.txt', 'overwrite')], { targeted: false, unsupported: [{ path: 'made.bin', reason: 'created_not_recorded' }] }));
  assert.equal(plan.incomplete, true);
  assert.deepEqual(plan.unsupported, [{ path: 'made.bin', reason: 'created_not_recorded' }]);
  assert.deepEqual(planStepUndo(preview([file('a.txt', 'overwrite')])).unsupported, [], 'and nothing when there is nothing');
  const empty = planStepUndo(preview([]));
  assert.deepEqual([empty.rows, empty.conflicts, empty.unchanged, empty.expectedShas, empty.unknownSteps], [[], [], [], {}, 0]);
});

test('restore from a checkpoint: the files the person ticked go back, over newer changes if they say so, and nothing else', () => {
  const files = [file('a.txt', 'overwrite', { changedSinceStep: true }), file('b.txt', 'recreate'), file('c.txt', 'remove'), file('d.txt', 'unchanged')];
  const plan = planSelection(preview(files), new Set(['a.txt', 'c.txt', 'd.txt', 'zzz.txt']));
  assert.deepEqual(plan.rows.map((row) => [row.path, row.action]), [['a.txt', 'overwrite'], ['c.txt', 'remove']], 'the ticked files that have something to do, in the Hub\'s order');
  assert.deepEqual(plan.conflicts, [], 'a file changed since the step is not a conflict here: the person chose it, and is told that the later changes go too');
  assert.deepEqual(plan.rows.map((row) => row.changedLater), [true, false], 'and the row says so');
  assert.deepEqual(describePlan(plan).notes.map((note) => note.key), ['rollback_note_changed_later', 'rollback_note_backup']);
  assert.deepEqual(describePlan(plan).notes[0].values, { paths: 'a.txt', count: 1 });
  assert.deepEqual(plan.unchanged, ['d.txt'], 'a ticked file that is already right is said to be');
  assert.deepEqual(plan.expectedShas, { 'a.txt': SHA('c'), 'c.txt': SHA('c') });
  assert.deepEqual(planSelection(preview(files), new Set()).rows, [], 'nothing ticked, nothing to do');
  assert.equal(planSelection(preview(files, { targeted: false }), new Set(['a.txt'])).incomplete, true);
});

test('undo all changes of the task: only the files the person is looking at, as they were when the review was read', () => {
  const files = [
    file('a.txt', 'overwrite'),
    file('b.txt', 'overwrite', { currentSha: SHA('d') }),
    file('c.txt', 'remove'),
    file('d.txt', 'unchanged'),
    file('new-since.txt', 'overwrite'),
  ];
  const plan = planTaskUndo(preview(files, { unsupported: [{ path: 'made.bin', reason: 'created_not_recorded' }] }), { 'a.txt': SHA('c'), 'b.txt': SHA('b'), 'c.txt': SHA('c'), 'd.txt': SHA('b') });
  assert.deepEqual(plan.rows.map((row) => row.path), ['a.txt', 'c.txt'], 'a file that is in the review and has not changed since goes back');
  assert.deepEqual(plan.conflicts, ['b.txt'], 'a file that changed since the review was read is left alone and named');
  assert.deepEqual(plan.unchanged, ['d.txt']);
  assert.deepEqual(plan.expectedShas, { 'a.txt': SHA('c'), 'c.txt': SHA('c') }, 'the sha asked for is the one that was reviewed');
  assert.deepEqual(plan.unsupported, [{ path: 'made.bin', reason: 'created_not_recorded' }]);
  assert.equal(plan.rows.some((row) => row.path === 'new-since.txt'), false, 'a file the review does not show is not undone behind the person\'s back');
});

test('the words for a plan: one line for each file, and a note for everything the person should know before saying yes', () => {
  const plan = planStepUndo(preview([file('a.txt', 'overwrite'), file('b.txt', 'recreate'), file('c.txt', 'remove'), file('e.txt', 'overwrite', { changedSinceStep: true }), file('f.txt', 'overwrite', { changedSinceStep: null })], { targeted: false, unsupported: [{ path: 'made.bin', reason: 'created_not_recorded' }] }));
  const words = describePlan(plan);
  assert.deepEqual(words.details, [
    { key: 'rollback_row_overwrite', values: { path: 'a.txt' } },
    { key: 'rollback_row_recreate', values: { path: 'b.txt' } },
    { key: 'rollback_row_remove', values: { path: 'c.txt' } },
    { key: 'rollback_row_overwrite', values: { path: 'f.txt' } },
  ]);
  assert.deepEqual(words.notes.map((note) => [note.tone, note.key]), [
    ['warn', 'rollback_note_incomplete'],
    ['warn', 'rollback_note_conflicts'],
    ['warn', 'rollback_note_unsupported'],
    ['warn', 'rollback_note_unknown_step'],
    ['info', 'rollback_note_backup'],
  ], 'the notes come in the order of how much they matter; the backup is the last, and the only one that is good news');
  assert.deepEqual(words.notes.find((note) => note.key === 'rollback_note_conflicts').values, { paths: 'e.txt', count: 1 });
  assert.deepEqual(words.notes.find((note) => note.key === 'rollback_note_unsupported').values, { paths: 'made.bin', count: 1 });
  assert.deepEqual(words.notes.find((note) => note.key === 'rollback_note_unknown_step').values, { count: 1 });
  const plain = describePlan(planStepUndo(preview([file('a.txt', 'recreate')])));
  assert.deepEqual(plain.notes.map((note) => note.key), ['rollback_note_backup'], 'a plain plan has only the backup note');
  const nothing = describePlan(planStepUndo(preview([file('a.txt', 'unchanged')])));
  assert.deepEqual([nothing.details, nothing.notes], [[], []], 'and a plan with nothing to do says nothing');
  const many = describePlan(planStepUndo(preview(Array.from({ length: 12 }, (_, i) => file(`conflict-${i}.txt`, 'overwrite', { changedSinceStep: true })))));
  assert.equal(many.notes.find((note) => note.key === 'rollback_note_conflicts').values.paths, 'conflict-0.txt, conflict-1.txt, conflict-2.txt, conflict-3.txt, conflict-4.txt, conflict-5.txt, conflict-6.txt, conflict-7.txt, +4', 'a long list is cut after eight names and says how many are left (as +4: no word to translate)');
  assert.equal(many.notes.find((note) => note.key === 'rollback_note_conflicts').values.count, 12, 'and the note counts all of them');
});

test('a list of names is cut after eight: eight are all shown, nine say how many more', () => {
  const names = Array.from({ length: 8 }, (_, index) => `f${index}.txt`);
  const conflicts = (count) => describePlan(planStepUndo(preview(Array.from({ length: count }, (_, index) => file(`f${index}.txt`, 'overwrite', { changedSinceStep: true }))))).notes[0].values;
  assert.deepEqual(conflicts(1), { paths: 'f0.txt', count: 1 });
  assert.deepEqual(conflicts(8), { paths: names.join(', '), count: 8 });
  assert.deepEqual(conflicts(9), { paths: `${names.join(', ')}, +1`, count: 9 });
});

test('what happened: the count, the files that were left alone, and the tone', () => {
  const done = (extra) => ({ restoredCount: 2, restored: [], unchanged: [], conflicts: [], undoCheckpointId: 'u1', targeted: true, ...extra });
  assert.deepEqual(describeResult(done({})), { tone: 'ok', lines: [{ key: 'rollback_done_other', values: { count: 2 } }] });
  assert.deepEqual(describeResult(done({ restoredCount: 1 })), { tone: 'ok', lines: [{ key: 'rollback_done_one', values: { count: 1 } }] }, 'one file is said in the singular');
  assert.deepEqual(describeResult(done({ conflicts: [{ path: 'b.txt', expectedSha: SHA('a'), currentSha: SHA('b') }] })), {
    tone: 'warn', lines: [{ key: 'rollback_done_other', values: { count: 2 } }, { key: 'rollback_conflicts_left', values: { paths: 'b.txt', count: 1 } }],
  }, 'a conflict that came up while the restore ran is named, and the tone is a warning');
  assert.deepEqual(describeResult(done({ restoredCount: 1, conflicts: [{ path: 'b.txt', expectedSha: null, currentSha: SHA('b') }] }), ['a.txt', 'b.txt']), {
    tone: 'warn', lines: [{ key: 'rollback_done_one', values: { count: 1 } }, { key: 'rollback_conflicts_left', values: { paths: 'a.txt, b.txt', count: 2 } }],
  }, 'the files the plan had already left alone are named together with the ones that came up, each once');
  assert.deepEqual(describeResult(done({ restoredCount: 0, undoCheckpointId: null })), { tone: 'warn', lines: [{ key: 'rollback_done_none', values: {} }] }, 'nothing was undone: that is not a success');
  assert.deepEqual(describeResult(done({ restoredCount: 0, undoCheckpointId: null }), ['x.txt']).lines.map((line) => line.key), ['rollback_done_none', 'rollback_conflicts_left']);
});

test('an error of the Hub becomes a sentence the person can act on', () => {
  const error = (code, status = 409, message = 'raw message') => Object.assign(new Error(message), { code, status });
  assert.deepEqual(restoreErrorKey(error('task_in_progress')), { key: 'rollback_error_task_in_progress', values: {} });
  for (const code of ['stale_state', 'restore_busy', 'checkpoint_corrupt', 'checkpoint_missing', 'undo_backup_incomplete', 'restore_failed_rolled_back', 'restore_partial_failure', 'restore_verify_failed', 'not_in_checkpoint', 'missing_expected_shas', 'path_escape']) {
    assert.equal(restoreErrorKey(error(code)).key, `rollback_error_${code}`, code);
  }
  assert.deepEqual(restoreErrorKey(error('something_new', 500, 'disk on fire')), { key: 'rollback_error_generic', values: { message: 'disk on fire' } }, 'a code nobody wrote words for is shown with the Hub\'s own message');
  assert.deepEqual(restoreErrorKey(new Error('offline')), { key: 'rollback_error_generic', values: { message: 'offline' } });
  assert.deepEqual(restoreErrorKey('weird'), { key: 'rollback_error_generic', values: { message: '' } }, 'and something that is not an error at all does not crash it');
});

test('undo the last restore: what the restore left is remembered, and asked for when it is undone', () => {
  const result = { restoredCount: 2, restored: [{ path: 'a.txt', action: 'overwrite', sha256: SHA('a') }, { path: 'c.txt', action: 'remove', sha256: null }], unchanged: [], conflicts: [], undoCheckpointId: '11111111-1111-1111-1111-111111111111', targeted: true };
  const last = lastRestoreOf(result, 'step', '2026-11-04T10:00:00.000Z');
  assert.deepEqual(last, { undoCheckpointId: '11111111-1111-1111-1111-111111111111', files: 2, shas: { 'a.txt': SHA('a'), 'c.txt': null }, source: 'step', at: '2026-11-04T10:00:00.000Z' });
  assert.deepEqual(undoRequestOf(last), { checkpointId: '11111111-1111-1111-1111-111111111111', expectedShas: { 'a.txt': SHA('a'), 'c.txt': null } });
  assert.equal(lastRestoreOf({ ...result, undoCheckpointId: null, restoredCount: 0, restored: [] }, 'step', 'now'), null, 'a restore that changed nothing has nothing to undo');
  assert.equal(lastRestoreOf({ ...result, restoredCount: 0, restored: [] }, 'step', 'now'), null, 'a backup of nothing is not a way back');
  assert.equal(lastRestoreOf({ ...result, undoCheckpointId: null }, 'step', 'now'), null, 'and without a backup there is no way back');
  const request = undoRequestOf(last);
  request.expectedShas['a.txt'] = 'changed by the caller';
  assert.equal(last.shas['a.txt'], SHA('a'), 'the request is a copy: the record of the last restore is not changed through it');
});

test('the last restore survives a reload of the page, for the workspace it was made in, and only if it is well formed', () => {
  const memory = new Map();
  const storage = { getItem: (key) => (memory.has(key) ? memory.get(key) : null), setItem: (key, value) => { memory.set(key, value); }, removeItem: (key) => { memory.delete(key); } };
  const last = { undoCheckpointId: '22222222-2222-2222-2222-222222222222', files: 1, shas: { 'a.txt': SHA('a') }, source: 'task', at: '2026-11-04T10:00:00.000Z' };
  writeLastRestore(storage, 'F:/work/one', last);
  assert.deepEqual(readLastRestore(storage, 'F:/work/one'), last);
  assert.equal(readLastRestore(storage, 'F:/work/two'), null, 'another workspace has its own');
  writeLastRestore(storage, 'F:/work/two', null);
  assert.deepEqual(readLastRestore(storage, 'F:/work/one'), last, 'forgetting the restore of another workspace keeps this one');
  writeLastRestore(storage, 'F:/work/one', null);
  assert.equal(readLastRestore(storage, 'F:/work/one'), null, 'and it can be forgotten');
  assert.equal(memory.has('datgold:last-restore'), false, 'by removing the record');
  const removed = { ...last, shas: { 'a.txt': SHA('a'), 'c.txt': null } };
  writeLastRestore(storage, 'F:/work/one', removed);
  assert.deepEqual(readLastRestore(storage, 'F:/work/one'), removed, 'a file the restore removed has no sha, and that is a well formed record');
  for (const damaged of [JSON.stringify({ workspace: 'w', last: { ...last, at: 5 } }), JSON.stringify({ workspace: 'w', last: { ...last, files: 0 } }), JSON.stringify({ workspace: 'w', last: { ...last, files: 1.5 } }), JSON.stringify({ workspace: 'w', last: { ...last, shas: null } }), JSON.stringify({ workspace: 'w', last: null }), 'null']) {
    memory.set('datgold:last-restore', damaged);
    assert.equal(readLastRestore(storage, 'w'), null, `a damaged record is not believed: ${damaged.slice(0, 50)}`);
  }
  for (const damaged of ['not json', '{}', JSON.stringify({ workspace: 'w', last: { ...last, undoCheckpointId: 'x' } }), JSON.stringify({ workspace: 'w', last: { ...last, shas: { 'a.txt': 'not a sha' } } }), JSON.stringify({ workspace: 'w', last: { ...last, files: -1 } }), JSON.stringify({ workspace: 'w', last: { ...last, source: 'sideways' } })]) {
    memory.set('datgold:last-restore', damaged);
    assert.equal(readLastRestore(storage, 'w'), null, `a damaged record is not believed: ${damaged.slice(0, 40)}`);
  }
  const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } };
  assert.equal(readLastRestore(blocked, 'w'), null, 'storage that is blocked reads as nothing');
  assert.doesNotThrow(() => writeLastRestore(blocked, 'w', last), 'and writing to it does not break the page');
  assert.equal(readLastRestore(null, 'w'), null);
});

test('which receipts can be undone: an edit that went through, a command that ran, and only with the checkpoint of that very call', () => {
  const call = (name, status, checkpointId = 'cp1') => ({ name, status, checkpointId, args: {} });
  assert.deepEqual(undoTarget(call('local.edit_file', 'success')), { checkpointId: 'cp1' });
  assert.deepEqual(undoTarget(call('local.write_file', 'success')), { checkpointId: 'cp1' });
  assert.deepEqual(undoTarget(call('local.files_write_batch', 'success')), { checkpointId: 'cp1' });
  assert.deepEqual(undoTarget(call('local.run_command', 'success')), { checkpointId: 'cp1' });
  assert.deepEqual(undoTarget(call('local.run_command', 'error')), { checkpointId: 'cp1' }, 'a command that failed may have changed files before it did');
  assert.equal(undoTarget(call('local.edit_file', 'error')), null, 'an edit that failed changed nothing');
  assert.equal(undoTarget(call('local.edit_file', 'running')), null);
  assert.equal(undoTarget(call('local.run_command', 'running')), null, 'a command that is still running has not left anything yet');
  assert.equal(undoTarget(call('local.run_command', 'unknown')), null);
  assert.equal(undoTarget(call('local.edit_file', 'success', null)), null, 'no checkpoint, nothing to go back to');
  assert.equal(undoTarget(call('local.edit_file', 'success', '')), null);
  assert.equal(undoTarget(call('local.read_file', 'success')), null);
  assert.equal(undoTarget(call('local.search_files', 'success')), null);
  assert.equal(undoTarget(undefined), null);
});
