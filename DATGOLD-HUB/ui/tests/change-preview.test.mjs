import test from 'node:test';
import assert from 'node:assert/strict';
import { CHANGE_FILES_SHOWN, CHANGE_ROWS_SHOWN, detailWithoutPreview, parseChangePreview, refusalSentenceKey } from '../src/lib/change-preview.ts';
import { planEdit, planWrite } from '../../lib/local-tools.mjs';
import { buildChangePreview } from '../../lib/approval-preview.mjs';

// The part of the approval card that reads the request (ui/src/lib/change-preview.ts): what it accepts of the preview the Hub sends, and how much of it. It arrives as JSON, so every
// shape is possible and none may throw. The page that draws it is tested in approval-changes.test.mjs, with the real components.
const at = (relative) => ({ relative });
const bytes = (text) => Buffer.from(text);
const editPlan = () => planEdit({ path: 'src/app.js', old_string: 'const b = 2;', new_string: 'const b = 20;' }, bytes('const a = 1;\nconst b = 2;\nconst c = 3;\n'), at('src/app.js'));
const withFiles = (files, extra = {}) => ({ preview: { files, ...extra } });
const rowsOf = (hunks) => hunks.flatMap((hunk) => hunk.rows);

test('parseChangePreview reads only what it knows', () => {
  assert.equal(parseChangePreview(undefined), null);
  assert.equal(parseChangePreview({ kind: 'edit' }), null);
  assert.equal(parseChangePreview({ preview: [] }), null);
  assert.equal(parseChangePreview({ preview: null }), null);
  assert.equal(parseChangePreview({ preview: {} }), null, 'a preview with no files and no refusal is not a preview');
  assert.equal(parseChangePreview({ preview: { files: 'nope' } }), null);
  assert.equal(parseChangePreview('x'), null);
  assert.equal(CHANGE_FILES_SHOWN, 20);
  assert.equal(CHANGE_ROWS_SHOWN, 200);
  const view = parseChangePreview({ preview: buildChangePreview([editPlan()]) });
  assert.equal(view.files.length, 1);
  assert.deepEqual({ ...view.files[0], hunks: view.files[0].hunks.length }, {
    path: 'src/app.js', action: 'edit', baseSha: view.files[0].baseSha, additions: 1, deletions: 1, unchanged: false, oldUnreadable: false, hunks: 1, shownRows: 4, hiddenRows: 0, hiddenKeyRows: 0, truncated: false,
  });
  assert.equal(view.files[0].baseSha?.length, 64);
  assert.deepEqual([view.fileCount, view.hiddenFiles, view.truncated, view.error], [1, 0, false, null]);
  assert.deepEqual(view.files[0].hunks[0].rows.map((row) => row.kind), ['context', 'removed', 'added', 'context']);
  const created = parseChangePreview({ preview: buildChangePreview([planWrite({ path: 'n.txt', content: 'a\n' }, null, at('n.txt'))]) });
  assert.deepEqual([created.files[0].action, created.files[0].baseSha], ['create', null]);
  assert.equal(parseChangePreview({ preview: buildChangePreview([planWrite({ path: 'n.txt', content: 'a\n', overwrite: true }, bytes('b\n'), at('n.txt'))]) }).files[0].action, 'overwrite');
});

test('parseChangePreview takes no more than the card shows, whatever was sent', () => {
  const flood = parseChangePreview(withFiles(
    Array.from({ length: 60 }, (_, n) => ({ path: `f${n}`, action: 'edit', hunks: [{ rows: Array.from({ length: 900 }, () => ({ kind: 'added', text: 'x'.repeat(5000) })) }] })), { fileCount: 60 }));
  assert.equal(flood.files.length, 20, 'twenty files');
  assert.equal(flood.hiddenFiles, 40);
  assert.equal(flood.fileCount, 60);
  assert.equal(rowsOf(flood.files[0].hunks).length, 200, 'two hundred rows');
  assert.equal(flood.files[0].hunks[0].rows[0].text.length, 410, 'a line is cut at 410 characters');
  assert.equal(flood.truncated, true);
  // rows are shared out among the hunks in order, and there are at most a hundred hunks
  const shared = parseChangePreview(withFiles([{ path: 'p', hunks: [{ rows: Array.from({ length: 150 }, () => ({ kind: 'added', text: 'a' })) }, { rows: Array.from({ length: 150 }, () => ({ kind: 'removed', text: 'r' })) }, { rows: [{ kind: 'context', text: 'c' }] }] }]));
  assert.deepEqual(shared.files[0].hunks.map((hunk) => hunk.rows.length), [150, 50], 'the second hunk gets what is left, the third none');
  const many = parseChangePreview(withFiles([{ path: 'p', hunks: Array.from({ length: 300 }, () => ({ rows: [{ kind: 'added', text: 'a' }] })) }]));
  assert.equal(many.files[0].hunks.length, 100, 'a hundred hunks at most');
  // the number of files the call has is what the Hub said, or what was sent when that is more
  assert.equal(parseChangePreview(withFiles([{ path: 'a' }, { path: 'b' }])).fileCount, 2);
  assert.equal(parseChangePreview(withFiles([{ path: 'a' }], { fileCount: 7 })).hiddenFiles, 6);
  assert.equal(parseChangePreview(withFiles([{ path: 'a' }], { fileCount: 7, hiddenFiles: 9 })).hiddenFiles, 9);
});

test('parseChangePreview is strict about each field', () => {
  const [file] = parseChangePreview(withFiles([{ path: 'p', action: 'rm -rf', additions: -5, deletions: 'x', baseSha: 'not a hash', unchanged: 'yes', oldUnreadable: 1, hunks: [] }])).files;
  assert.equal(file.action, 'edit', 'an action it does not know is an edit');
  assert.deepEqual([file.additions, file.deletions, file.baseSha, file.unchanged, file.oldUnreadable], [0, 0, null, false, false]);
  assert.equal(parseChangePreview(withFiles([{ path: 'p', baseSha: 'A'.repeat(64) }])).files[0].baseSha, null, 'a hash is lower-case hex');
  assert.deepEqual(parseChangePreview(withFiles([{ path: 'p', additions: 2.7, deletions: 1.2, shownRows: 3.9, hiddenRows: 4.5 }])).files.map((item) => [item.additions, item.deletions, item.shownRows, item.hiddenRows]), [[2, 1, 3, 4]], 'a count is a whole number');
  assert.deepEqual(parseChangePreview(withFiles([{ path: 'p', hiddenKeyRows: 3.9 }, { path: 'q', hiddenKeyRows: -2 }, { path: 'r', hiddenKeyRows: 'many' }, { path: 's' }])).files.map((item) => item.hiddenKeyRows), [3, 0, 0, 0],
    'the rows that the Hub hid as private key material are a whole number, and 0 when the Hub says nothing');
  assert.equal(parseChangePreview(withFiles([{ path: 'p', baseSha: 'a'.repeat(63) }])).files[0].baseSha, null);
  assert.equal(parseChangePreview(withFiles([{ path: 'p', baseSha: 'a'.repeat(64) }])).files[0].baseSha, 'a'.repeat(64));
  assert.deepEqual(parseChangePreview(withFiles([{ path: 'p', unchanged: true, oldUnreadable: true, action: 'create' }])).files.map((item) => [item.unchanged, item.oldUnreadable, item.action]), [[true, true, 'create']]);
  for (const action of ['create', 'overwrite', 'edit']) assert.equal(parseChangePreview(withFiles([{ path: 'p', action }])).files[0].action, action);
  assert.equal(parseChangePreview(withFiles([null, 5, 'x', { path: 7 }, { path: '' }, { path: 'only' }])).files.length, 1, 'only an entry that is a file is a file');
  assert.equal(parseChangePreview(withFiles([{ path: 'p'.repeat(900) }])).files[0].path.length, 500);
  // counts of the file as the Hub gave them
  const [counted] = parseChangePreview(withFiles([{ path: 'p', shownRows: 4, hiddenRows: 6, truncated: false, hunks: [{ rows: [{ kind: 'added', text: 'a' }] }] }])).files;
  assert.deepEqual([counted.shownRows, counted.hiddenRows, counted.truncated], [4, 6, true], 'rows left out make the file truncated');
  assert.equal(parseChangePreview(withFiles([{ path: 'p', hunks: [{ rows: [{ kind: 'added', text: 'a' }, { kind: 'added', text: 'b' }] }] }])).files[0].shownRows, 2, 'without a count, the rows that were read');
  assert.equal(parseChangePreview(withFiles([{ path: 'p', truncated: true }])).files[0].truncated, true);
  assert.equal(parseChangePreview(withFiles([{ path: 'p' }])).truncated, false);
  assert.equal(parseChangePreview(withFiles([{ path: 'p', truncated: true }])).truncated, true, 'a truncated file makes the call truncated');
  assert.equal(parseChangePreview(withFiles([{ path: 'p' }], { truncated: true })).truncated, true);
  assert.equal(parseChangePreview(withFiles([{ path: 'p' }], { fileCount: 3 })).truncated, true, 'files that are not shown do too');
});

test('parseChangePreview reads rows and hunks strictly', () => {
  const rows = [null, 5, 'x', { kind: 'weird', text: 'a' }, { kind: 'added', text: 5 }, { kind: 'added' }, { kind: 'added', text: 'ok\n' }, { kind: 'removed', text: 'r', omitted: 7 }, { kind: 'context', text: 'c', omitted: 0 },
    { kind: 'context', text: 'd', omitted: -3 }, { kind: 'context', text: 'e', omitted: 'many' }];
  const [hunk] = parseChangePreview(withFiles([{ path: 'p', hunks: [null, 5, { rows: 'x' }, { baselineStart: 1 }, { rows: [] }, { rows: [{ kind: 'weird', text: 'only' }] }, { baselineStart: 3, baselineEnd: 4, currentStart: 5, currentEnd: 6, removed: 1, added: 2, invisibleOnly: true, rows }] }])).files[0].hunks;
  assert.deepEqual(hunk.rows, [{ kind: 'added', text: 'ok\n' }, { kind: 'removed', text: 'r', omitted: 7 }, { kind: 'context', text: 'c' }, { kind: 'context', text: 'd' }, { kind: 'context', text: 'e' }], 'only a row of a known kind with a text is a row; omitted is kept only when it is a positive number');
  assert.deepEqual([hunk.baselineStart, hunk.baselineEnd, hunk.currentStart, hunk.currentEnd, hunk.removed, hunk.added, hunk.invisibleOnly], [3, 4, 5, 6, 1, 2, true]);
  assert.equal(parseChangePreview(withFiles([{ path: 'p', hunks: [null, { rows: [] }, { rows: [{ kind: 'weird', text: 'only' }] }] }])).files[0].hunks.length, 0, 'a hunk that has no row is not a hunk');
  assert.equal(parseChangePreview(withFiles([{ path: 'p', hunks: [{ invisibleOnly: 'yes', rows: [{ kind: 'added', text: 'a' }] }] }])).files[0].hunks[0].invisibleOnly, false);
  assert.deepEqual(parseChangePreview(withFiles([{ path: 'p', hunks: [{ currentStart: -2, added: 'x', rows: [{ kind: 'added', text: 'a' }] }] }])).files[0].hunks[0].currentStart, 0);
});

test('parseChangePreview reads the refusal', () => {
  const refused = parseChangePreview({ preview: { files: [], error: { code: 'not_found', message: 'm'.repeat(900) } } });
  assert.deepEqual([refused.error.code, refused.error.message.length, refused.files.length], ['not_found', 600, 0]);
  assert.deepEqual(parseChangePreview({ preview: { error: { code: 7, message: 'm' } } }).error, { code: 'local_error', message: 'm' }, 'a refusal with no files is a card of its own');
  assert.deepEqual(parseChangePreview({ preview: { error: { code: '', message: 5 } } }).error, { code: 'local_error', message: '' });
  assert.equal(parseChangePreview({ preview: { error: { code: 'c'.repeat(200), message: 'm' } } }).error.code.length, 64);
  assert.equal(parseChangePreview({ preview: { files: [{ path: 'p' }], error: 5 } }).error, null, 'a refusal that is not an object is none');
  assert.equal(parseChangePreview({ preview: { error: [] } }), null);
});

test('every refusal the planners make, and every code the tools refuse a file change with, has a sentence in the page', () => {
  const big = 'x'.repeat(2 * 1024 * 1024 + 1);
  const refusals = [
    () => planEdit({ path: 'x', old_string: 'zz', new_string: 'y' }, bytes('a'), at('x')),
    () => planEdit({ path: 'x', old_string: 'a', new_string: 'y' }, bytes('aa'), at('x')),
    () => planEdit({ path: 'x', old_string: '', new_string: 'y' }, bytes('a'), at('x')),
    () => planEdit({ path: 'x', old_string: 'a', new_string: 'y', expected_sha256: 'f'.repeat(64) }, bytes('a'), at('x')),
    () => planEdit({ path: 'x', old_string: 'a', new_string: 'y' }, Buffer.from([0, 1]), at('x')),
    () => planEdit({ path: 'x', old_string: 'a', new_string: 'y' }, Buffer.from([0xe9, 0x74]), at('x')),
    () => planEdit({ path: 'x', old_string: 'a', new_string: 'y\ud800' }, bytes('a'), at('x')),
    () => planWrite({ path: 'x', content: 'y' }, bytes('a'), at('x')),
    () => planWrite({ path: 'x', content: big }, null, at('x')),
    () => planWrite({ path: 'x', content: 'a\0' }, null, at('x')),
  ];
  const codes = refusals.map((run) => { try { run(); } catch (error) { return error.code; } throw new Error('a refusal did not refuse'); });
  // the batch, and the ones the tools raise while they look at the disk (lib/local-tools.mjs: #target, #loadBatchItem, #preflightWrite, #preflightEdit)
  codes.push('bad_files', 'bad_path', 'bad_revision', 'duplicate_path', 'not_directory', 'file_too_large', 'protected_path', 'symlink', 'is_directory', 'not_file', 'outside_workspace', 'alternate_stream', 'bad_name');
  const missing = [...new Set(codes)].filter((code) => refusalSentenceKey(code) === null);
  assert.deepEqual(missing, [], 'codes the card would show in the Hub\'s own words');
  assert.equal(refusalSentenceKey('constructor'), null, 'a code is looked up by its own name, never through the prototype');
  assert.equal(refusalSentenceKey('__proto__'), null);
  assert.equal(refusalSentenceKey('file_locked'), null);
  // each sentence is the one for its meaning
  assert.equal(refusalSentenceKey('not_found'), 'agents_apr_changes_why_not_found');
  assert.equal(refusalSentenceKey('ambiguous_match'), 'agents_apr_changes_why_ambiguous_match');
  assert.equal(refusalSentenceKey('stale_revision'), 'agents_apr_changes_why_stale_revision');
  assert.equal(refusalSentenceKey('file_exists'), 'agents_apr_changes_why_file_exists');
  assert.equal(refusalSentenceKey('protected_path'), 'agents_apr_changes_why_protected_path');
  assert.equal(refusalSentenceKey('binary_file'), refusalSentenceKey('invalid_unicode'));
  assert.equal(refusalSentenceKey('symlink'), refusalSentenceKey('not_directory'));
  assert.equal(refusalSentenceKey('file_too_large'), refusalSentenceKey('content_too_large'));
  assert.equal(new Set(['not_found', 'ambiguous_match', 'bad_edit', 'stale_revision', 'file_exists', 'protected_path', 'binary_file', 'symlink', 'file_too_large', 'bad_path'].map(refusalSentenceKey)).size, 10, 'ten meanings, ten sentences');
});

test('the details below the card do not carry the preview a second time', () => {
  const detail = { kind: 'edit', path: 'a.txt', preview: { files: [{ path: 'a.txt' }] }, previews: 2, nested: { preview: 1 } };
  assert.deepEqual(detailWithoutPreview(detail), { kind: 'edit', path: 'a.txt', previews: 2, nested: { preview: 1 } }, 'only the member called preview, at the top');
  assert.deepEqual(detailWithoutPreview({}), {});
  assert.ok('preview' in detail, 'and the request itself is not changed');
});
