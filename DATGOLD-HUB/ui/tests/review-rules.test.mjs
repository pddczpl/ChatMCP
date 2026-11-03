import test from 'node:test';
import assert from 'node:assert/strict';
import { ROW_LIMIT, conflictKind, fileActions, fileMode, hunkAccepted, keyAction, lineBody, moveHunk, pendingTotal, planAccept, planReject, summarizeFile, terminatorOf, visibleRows, writeState } from '../src/lib/review-rules.ts';
import { diffFile } from '../src/lib/review-hunks.ts';

// What the Review tab may offer for a file, given what the Hub says about the file and about the moment: the rules, without a page.

const sha = (letter) => letter.repeat(64);
const modified = (extra = {}) => ({
  path: 'src/a.js', status: 'modified', change: 'modified', baselineText: 'one\ntwo\n', currentText: 'one\nTWO\n', baselineSha: sha('a'), currentSha: sha('b'),
  partial: false, accepted: false, rejectable: false, baselineSource: 'checkpoint', checkpointId: 'cp1', ...extra,
});
const created = (extra = {}) => modified({ path: 'new.txt', status: 'created', change: 'created', baselineText: null, baselineSha: null, currentText: 'a\nb\n', rejectable: true, ...extra });
const deleted = (extra = {}) => modified({ path: 'gone.txt', status: 'deleted', change: 'deleted', currentText: null, currentSha: null, ...extra });
const binary = (extra = {}) => modified({ path: 'logo.bin', status: 'binary', change: 'modified', baselineText: null, currentText: null, textUnavailable: 'binary', ...extra });
const unavailable = (reason, extra = {}) => modified({ path: 'big.txt', baselineText: null, currentText: null, textUnavailable: reason, ...extra });
const error = (status, code) => Object.assign(new Error('x'), { status, ...(code ? { code } : {}) });

test('the Hub refuses to write while any task runs, and under sandbox-only it refuses to write at all', () => {
  assert.equal(writeState({ activeTaskId: null, executionPolicy: 'host-review' }), 'ok');
  assert.equal(writeState({ activeTaskId: 'abc', executionPolicy: 'host-review' }), 'running');
  assert.equal(writeState({ activeTaskId: null, executionPolicy: 'sandbox-only' }), 'policy');
  assert.equal(writeState({ activeTaskId: 'abc', executionPolicy: 'sandbox-only' }), 'policy', 'sandbox-only is the reason that does not pass');
  assert.equal(writeState({ activeTaskId: '', executionPolicy: 'full-access' }), 'ok');
  assert.equal(writeState({}), 'ok');
  assert.equal(writeState(undefined), 'ok');
});

test('a file is reviewed as text, as a new file, as a deleted file, as a binary file, or not at all', () => {
  assert.equal(fileMode(modified()), 'text');
  assert.equal(fileMode(created()), 'created');
  assert.equal(fileMode(deleted()), 'deleted');
  assert.equal(fileMode(binary()), 'binary');
  assert.equal(fileMode(binary({ textUnavailable: 'not_utf8' })), 'binary');
  for (const reason of ['too_large', 'checkpoint_corrupt', 'budget', 'baseline_unavailable']) assert.equal(fileMode(unavailable(reason)), 'unavailable', reason);
  // a text the Hub did not send is not a text, whatever the status says
  assert.equal(fileMode(modified({ baselineText: null })), 'unavailable');
  assert.equal(fileMode(modified({ currentText: null })), 'unavailable');
  assert.equal(fileMode(created({ currentText: null })), 'unavailable');
  assert.equal(fileMode(deleted({ baselineText: null })), 'unavailable');
  // a reason wins over a status
  assert.equal(fileMode(created({ textUnavailable: 'too_large' })), 'unavailable');
});

test('a text file: hunks can be accepted at any time and put back when writing is allowed', () => {
  assert.deepEqual(fileActions(modified(), 'ok'), { mode: 'text', byHunk: true, acceptHunk: true, rejectHunk: true, acceptFile: true, rejectFile: true, note: null });
  assert.deepEqual(fileActions(modified(), 'running'), { mode: 'text', byHunk: true, acceptHunk: true, rejectHunk: false, acceptFile: true, rejectFile: false, note: 'running' });
  assert.deepEqual(fileActions(modified(), 'policy'), { mode: 'text', byHunk: true, acceptHunk: true, rejectHunk: false, acceptFile: false, rejectFile: false, note: 'policy' });
});

test('a file can be accepted only when the Hub can tie the acceptance to a checkpoint and to the sha that was reviewed', () => {
  assert.equal(fileActions(modified({ currentSha: null }), 'ok').acceptFile, false);
  assert.equal(fileActions(modified({ checkpointId: '' }), 'ok').acceptFile, false);
  assert.equal(fileActions(binary({ currentSha: null }), 'ok').acceptFile, false);
  assert.equal(fileActions(created({ checkpointId: '' }), 'ok').acceptFile, false);
});

test('a new file is put away as a whole; its lines are not undone one by one', () => {
  assert.deepEqual(fileActions(created(), 'ok'), { mode: 'created', byHunk: false, acceptHunk: false, rejectHunk: false, acceptFile: true, rejectFile: true, note: null });
  assert.deepEqual(fileActions(created({ rejectable: false }), 'ok'), { mode: 'created', byHunk: false, acceptHunk: false, rejectHunk: false, acceptFile: true, rejectFile: false, note: 'not_rejectable' });
  assert.deepEqual(fileActions(created(), 'running'), { mode: 'created', byHunk: false, acceptHunk: false, rejectHunk: false, acceptFile: true, rejectFile: false, note: 'running' });
  assert.deepEqual(fileActions(created(), 'policy'), { mode: 'created', byHunk: false, acceptHunk: false, rejectHunk: false, acceptFile: false, rejectFile: false, note: 'policy' });
  assert.equal(fileActions(created({ rejectable: false }), 'running').note, 'running', 'the moment is told before the file');
});

test('a deleted file can only be read: the Hub cannot write a file that is not there', () => {
  for (const state of ['ok', 'running', 'policy']) {
    assert.deepEqual(fileActions(deleted(), state), { mode: 'deleted', byHunk: false, acceptHunk: false, rejectHunk: false, acceptFile: false, rejectFile: false, note: 'deleted' }, state);
  }
});

test('a file with no text can be accepted but not undone, and says why it cannot be read', () => {
  assert.deepEqual(fileActions(binary(), 'ok'), { mode: 'binary', byHunk: false, acceptHunk: false, rejectHunk: false, acceptFile: true, rejectFile: false, note: 'binary' });
  assert.equal(fileActions(binary({ textUnavailable: 'not_utf8' }), 'ok').note, 'not_utf8');
  assert.equal(fileActions(binary(), 'policy').acceptFile, false);
  assert.equal(fileActions(binary(), 'policy').note, 'binary');
  for (const reason of ['too_large', 'checkpoint_corrupt', 'budget', 'baseline_unavailable']) {
    assert.deepEqual(fileActions(unavailable(reason), 'ok'), { mode: 'unavailable', byHunk: false, acceptHunk: false, rejectHunk: false, acceptFile: true, rejectFile: false, note: reason }, reason);
  }
});

test('an error of the Hub is told by what happened to the file, not by its words', () => {
  for (const code of ['stale_revision', 'stale_review', 'bad_revision', 'revision_required']) assert.equal(conflictKind(error(409, code)), 'stale', code);
  assert.equal(conflictKind(error(409)), 'busy', 'a save during a run is a 409 with no code');
  assert.equal(conflictKind(error(409, 'task_in_progress')), 'busy');
  assert.equal(conflictKind(error(409, 'not_rejectable')), 'other');
  assert.equal(conflictKind(error(403)), 'policy', 'the refusal of sandbox-only has a status and no code');
  assert.equal(conflictKind(error(403, 'file_type')), 'other', 'a 403 that has a code of its own (a symlink) is not that');
  assert.equal(conflictKind(error(423, 'file_locked')), 'locked');
  assert.equal(conflictKind(error(413, 'too_large')), 'too_large');
  assert.equal(conflictKind(error(415, 'binary_file')), 'unsupported');
  assert.equal(conflictKind(error(415, 'not_utf8')), 'unsupported');
  assert.equal(conflictKind(error(500)), 'other');
  assert.equal(conflictKind(new Error('no status')), 'other');
  for (const value of [null, undefined, 'stale_revision', 409, {}]) assert.equal(conflictKind(value), 'other', String(value));
});

test('single keys act on the hunk: j and k move, a accepts, r puts back; nothing else, and never with a modifier', () => {
  assert.equal(keyAction({ key: 'j' }), 'next');
  assert.equal(keyAction({ key: 'k' }), 'prev');
  assert.equal(keyAction({ key: 'a' }), 'accept');
  assert.equal(keyAction({ key: 'r' }), 'reject');
  for (const key of ['J', 'K', 'A', 'R', 'x', 'Enter', ' ', 'ArrowDown', 'Escape', 'Tab', 'jj', '']) assert.equal(keyAction({ key }), null, JSON.stringify(key));
  for (const modifier of ['ctrlKey', 'altKey', 'metaKey']) {
    for (const key of ['j', 'k', 'a', 'r']) assert.equal(keyAction({ key, [modifier]: true }), null, `${modifier}+${key} is the browser's, not ours`);
  }
  assert.equal(keyAction({ key: 'r', ctrlKey: false, altKey: false, metaKey: false }), 'reject');
  assert.equal(keyAction({}), null);
});

test('moving between hunks stops at the first and the last', () => {
  assert.equal(moveHunk(0, 1, 3), 1);
  assert.equal(moveHunk(1, 1, 3), 2);
  assert.equal(moveHunk(2, 1, 3), 2, 'the last stays the last');
  assert.equal(moveHunk(2, -1, 3), 1);
  assert.equal(moveHunk(0, -1, 3), 0, 'the first stays the first');
  assert.equal(moveHunk(-1, 1, 3), 0, 'from no hunk, next is the first');
  assert.equal(moveHunk(-1, -1, 3), 2, 'from no hunk, previous is the last');
  assert.equal(moveHunk(7, 1, 3), 2, 'a hunk that is no longer there');
  assert.equal(moveHunk(7, -1, 3), 2);
  assert.equal(moveHunk(0, 1, 0), -1, 'no hunks');
  assert.equal(moveHunk(-1, -1, 0), -1);
  assert.equal(moveHunk(0, 1, 1), 0);
});

test('a long hunk shows its first rows and says how many lines are still hidden', () => {
  assert.equal(ROW_LIMIT, 200);
  const rows = Array.from({ length: 450 }, (_, at) => ({ kind: 'added', text: `line ${at}\n` }));
  const first = visibleRows(rows);
  assert.equal(first.rows.length, 200);
  assert.equal(first.hidden, 250);
  assert.equal(first.rows[0], rows[0]);
  assert.equal(first.rows[199], rows[199]);
  assert.deepEqual([visibleRows(rows, 400).rows.length, visibleRows(rows, 400).hidden], [400, 50]);
  assert.deepEqual([visibleRows(rows, 450).rows.length, visibleRows(rows, 450).hidden], [450, 0]);
  assert.deepEqual([visibleRows(rows, 9999).rows.length, visibleRows(rows, 9999).hidden], [450, 0]);
  assert.deepEqual([visibleRows(rows, 0).rows.length, visibleRows(rows, 0).hidden], [0, 450]);
  assert.deepEqual([visibleRows(rows, -5).rows.length, visibleRows(rows, -5).hidden], [0, 450]);
  assert.deepEqual([visibleRows(rows, Number.NaN).rows.length, visibleRows(rows, Number.NaN).hidden], [200, 250], 'a count that is not a number is the default');
  assert.deepEqual(visibleRows([], 5), { rows: [], hidden: 0 });
});

test('a line is shown without its terminator, and the terminator is named', () => {
  assert.equal(terminatorOf('a\r\n'), 'crlf');
  assert.equal(terminatorOf('a\n'), 'lf');
  assert.equal(terminatorOf('a'), 'none');
  assert.equal(terminatorOf(''), 'none');
  assert.equal(terminatorOf('a\r'), 'none', 'a lone carriage return is part of the line');
  assert.equal(terminatorOf('\n'), 'lf');
  assert.equal(terminatorOf('\r\n'), 'crlf');
  assert.equal(lineBody('a\r\n'), 'a');
  assert.equal(lineBody('a\n'), 'a');
  assert.equal(lineBody('a'), 'a');
  assert.equal(lineBody('a\r'), 'a\r');
  assert.equal(lineBody(''), '');
  assert.equal(lineBody('\r\n'), '');
  assert.equal(lineBody('x\ry\r\n'), 'x\ry');
});

test('a file is summed up for the list: hunks, how many are still to be reviewed, and the lines added and taken away', () => {
  const file = modified({ baselineText: 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm\nn\n', currentText: 'a\nB\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nM\nN\nn2\n' });
  const diff = diffFile(file.baselineText, file.currentText);
  assert.equal(diff.hunks.length, 2);
  const none = summarizeFile(file, diff, new Set());
  assert.deepEqual(none, { hunks: 2, pending: 2, added: diff.hunks[0].added + diff.hunks[1].added, removed: diff.hunks[0].removed + diff.hunks[1].removed });
  assert.ok(none.added >= 3 && none.removed >= 3);
  assert.equal(summarizeFile(file, diff, new Set([diff.hunks[0].fingerprint])).pending, 1);
  assert.equal(summarizeFile(file, diff, new Set(diff.hunks.map((hunk) => hunk.fingerprint))).pending, 0);
  assert.equal(summarizeFile(file, diff, new Set(['0123456789abcdef'])).pending, 2, 'a mark for a hunk that is not there counts for nothing');
  const fresh = created();
  assert.deepEqual(summarizeFile(fresh, diffFile('', fresh.currentText), new Set()), { hunks: 1, pending: 1, added: 2, removed: 0 });
  const gone = deleted();
  assert.deepEqual(summarizeFile(gone, diffFile(gone.baselineText, ''), new Set()), { hunks: 1, pending: 1, added: 0, removed: 2 });
  assert.deepEqual(summarizeFile(binary(), null, new Set()), { hunks: 0, pending: 0, added: 0, removed: 0 });
});

const item = (file, accepted = new Set()) => ({ file, diff: file.baselineText !== null || file.currentText !== null ? diffFile(file.baselineText ?? '', file.currentText ?? '') : null, accepted });
const TWO_HUNKS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'].map((line) => `${line}\n`).join('');
const TWO_HUNKS_EDITED = TWO_HUNKS.replace('a\n', 'A\n').replace('l\n', 'L\n');

test('"put everything back" is planned from the review: files rewritten, hunks, new files moved away, and what stays as it is', () => {
  const items = [
    item(modified({ path: 'a.js', baselineText: TWO_HUNKS, currentText: TWO_HUNKS_EDITED })),
    item(modified({ path: 'b.js' })),
    item(created({ path: 'c.txt' })),
    item(created({ path: 'd.txt', rejectable: false })),
    item(deleted({ path: 'e.txt' })),
    item(binary({ path: 'f.bin' })),
    item(unavailable('too_large', { path: 'g.txt' })),
  ];
  assert.deepEqual(planReject(items, 'ok'), { rewrite: 2, hunks: 3, created: 1, left: 4 });
  for (const state of ['running', 'policy']) assert.deepEqual(planReject(items, state), { rewrite: 0, hunks: 0, created: 0, left: 7 }, state);
  assert.deepEqual(planReject([], 'ok'), { rewrite: 0, hunks: 0, created: 0, left: 0 });
  const same = modified({ baselineText: 'x\n', currentText: 'x\n' });
  assert.deepEqual(planReject([item(same)], 'ok'), { rewrite: 0, hunks: 0, created: 0, left: 1 }, 'a text file with no hunk has nothing to put back');
  assert.equal(planReject([item(created({ path: 'c.txt' }), new Set(['0123456789abcdef']))], 'ok').created, 1, 'what was accepted does not stop it: that is the person\'s call, told in the dialog');
});

test('"accept everything" is planned from the review: the files the Hub can record, and the hunks still to be marked', () => {
  const first = item(modified({ path: 'a.js', baselineText: TWO_HUNKS, currentText: TWO_HUNKS_EDITED }));
  const items = [
    first,
    item(modified({ path: 'b.js', accepted: true })),
    item(created({ path: 'c.txt' })),
    item(deleted({ path: 'e.txt' })),
    item(binary({ path: 'f.bin' })),
    item(modified({ path: 'h.js', currentSha: null })),
  ];
  // files: a.js, c.txt and f.bin (b.js is accepted already, e.txt has no sha to record, h.js has none either); hunks: the 2 of a.js and the one of h.js (b.js is accepted, so its hunk
  // counts as accepted; a new file is not accepted hunk by hunk)
  assert.deepEqual(planAccept(items, 'ok'), { files: 3, hunks: 3 });
  const oneMarked = [{ ...first, accepted: new Set([first.diff.hunks[0].fingerprint]) }, ...items.slice(1)];
  assert.deepEqual(planAccept(oneMarked, 'ok'), { files: 3, hunks: 2 }, 'a hunk that is accepted already is not counted again');
  assert.deepEqual(planAccept(items, 'running'), { files: 3, hunks: 3 }, 'accepting is not writing: it goes on while a task runs');
  assert.deepEqual(planAccept(items, 'policy'), { files: 0, hunks: 3 }, 'under sandbox-only the Hub records nothing, but the marks are the page\'s');
  assert.deepEqual(planAccept([], 'ok'), { files: 0, hunks: 0 });
});

test('the hunks still to be reviewed are counted in the text files only: a new or a deleted file is one block, not a list of hunks to go through', () => {
  const first = item(modified({ path: 'a.js', baselineText: TWO_HUNKS, currentText: TWO_HUNKS_EDITED }));
  const items = [first, item(modified({ path: 'b.js' })), item(created({ path: 'c.txt' })), item(deleted({ path: 'e.txt' })), item(binary({ path: 'f.bin' })), item(unavailable('too_large', { path: 'g.txt' }))];
  assert.equal(pendingTotal(items), 3, 'the two of a.js and the one of b.js');
  const marked = [{ ...first, accepted: new Set([first.diff.hunks[0].fingerprint]) }, ...items.slice(1)];
  assert.equal(pendingTotal(marked), 2, 'a hunk that is accepted is not to be reviewed');
  assert.equal(pendingTotal([]), 0);
  assert.equal(pendingTotal(items.slice(2)), 0, 'nothing to go through hunk by hunk');
});

test('a deleted file is never accepted, whatever sha it is given; a file the Hub sent no text for says so', () => {
  assert.equal(fileActions(deleted({ currentSha: sha('c') }), 'ok').acceptFile, false);
  const none = fileActions(modified({ baselineText: null }), 'ok');
  assert.deepEqual([none.mode, none.note, none.acceptFile, none.rejectFile], ['unavailable', 'no_text', true, false]);
  assert.equal(fileActions(modified({ currentText: null }), 'ok').note, 'no_text');
});

test('the name of a property that every object has is not a key', () => {
  for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) assert.equal(keyAction({ key }), null, key);
});

test('with no hunk there is no hunk to go to, from anywhere', () => {
  assert.equal(moveHunk(-1, 1, 0), -1);
  assert.equal(moveHunk(-1, -1, 0), -1);
  assert.equal(moveHunk(3, 1, 0), -1);
});

test('a count with a fraction shows whole rows and hides a whole number of them', () => {
  const rows = Array.from({ length: 450 }, (_, at) => ({ kind: 'added', text: `line ${at}\n` }));
  const shown = visibleRows(rows, 2.7);
  assert.deepEqual([shown.rows.length, shown.hidden], [2, 448]);
});

test('a text file that has no diff is summed up as nothing', () => {
  assert.deepEqual(summarizeFile(modified(), null, new Set()), { hunks: 0, pending: 0, added: 0, removed: 0 });
});

test('the guards do not depend on the caller: a file with no text is summed up as nothing even when a diff is handed over, and a text file with no diff has nothing to put back', () => {
  const diff = diffFile('a\n', 'b\n');
  assert.deepEqual(summarizeFile(binary(), diff, new Set()), { hunks: 0, pending: 0, added: 0, removed: 0 });
  assert.deepEqual(summarizeFile(unavailable('budget'), diff, new Set()), { hunks: 0, pending: 0, added: 0, removed: 0 });
  assert.deepEqual(planReject([{ file: modified(), diff: null, accepted: new Set() }], 'ok'), { rewrite: 0, hunks: 0, created: 0, left: 1 });
});

// ---- the audit of the tab: an accepted file, the place to land on after a hunk is put back, and what a write really did ------------------------------------------------

test('a file the Hub has recorded as accepted counts all its hunks as accepted: none is left to review, none is offered to be marked, and a mark on this page changes nothing', () => {
  const edited = { baselineText: TWO_HUNKS, currentText: TWO_HUNKS_EDITED };
  const accepted = modified({ ...edited, accepted: true });
  const open = modified({ ...edited });
  const diff = diffFile(edited.baselineText, edited.currentText);
  const [first, second] = diff.hunks;
  assert.equal(hunkAccepted(accepted, new Set(), first), true, 'the Hub has the file');
  assert.equal(hunkAccepted(accepted, new Set(['0123456789abcdef']), second), true, 'a mark that is about no hunk of it does not undo that');
  assert.equal(hunkAccepted(open, new Set(), first), false);
  assert.equal(hunkAccepted(open, new Set([first.fingerprint]), first), true, 'a mark on this page');
  assert.equal(hunkAccepted(open, new Set([first.fingerprint]), second), false, 'it is for that hunk only');
  const summed = summarizeFile(accepted, diff, new Set());
  assert.deepEqual([summed.hunks, summed.pending], [2, 0], 'the hunks are still there; none is left to review');
  assert.equal(pendingTotal([item(accepted)]), 0);
  assert.equal(pendingTotal([item(accepted), item(open)]), 2, 'the other file is still to be reviewed');
  assert.deepEqual(planAccept([item(accepted)], 'ok'), { files: 0, hunks: 0 }, 'nothing to record and nothing to mark');
  assert.deepEqual(planAccept([item(accepted), item(open)], 'ok'), { files: 1, hunks: 2 });
});

