import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { bundleTsx, renderPrelude } from './support/bundle.mjs';
import { planEdit, planWrite, planWriteBatch } from '../../lib/local-tools.mjs';
import { buildChangePreview, PREVIEW_LIMITS } from '../../lib/approval-preview.mjs';

// The change an approval card shows (P8 ux-7), rendered by the real ApprovalStack for requests shaped by the Hub's own planners and buildChangePreview(), so that the page and the Hub
// cannot drift apart. What is pinned is what the owner reads before saying yes: for each file what it does (new, overwrite, edit), its counts, the hunks as the Review tab draws them,
// what is not shown and how much of it, and that nothing of it can be taken for markup. The card is read-only: the only buttons are the two of the request.
const { loaded, dispose } = await bundleTsx(`
  ${renderPrelude}
  import { ApprovalStack } from './src/components/approval/ApprovalStack';
  import { parseChangePreview, refusalSentenceKey, CHANGE_FILES_SHOWN, CHANGE_ROWS_SHOWN } from './src/lib/change-preview';
  import { normalizeApproval } from './src/lib/task-view';
  import { translations } from './src/lib/i18n';
  export { ApprovalStack, parseChangePreview, refusalSentenceKey, CHANGE_FILES_SHOWN, CHANGE_ROWS_SHOWN, normalizeApproval, translations };
`, 'chatmcp-approval-changes-');
after(dispose);
const { renderWith, ApprovalStack, parseChangePreview, refusalSentenceKey, CHANGE_FILES_SHOWN, CHANGE_ROWS_SHOWN, normalizeApproval, translations } = loaded;

const DIACRITICS = /[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/i;
const at = (relative) => ({ relative });
const bytes = (text) => Buffer.from(text);
const SOURCE = 'const a = 1;\nconst b = 2;\nconst c = 3;\n';
const editPlan = () => planEdit({ path: 'src/app.js', old_string: 'const b = 2;', new_string: 'const b = 20;' }, bytes(SOURCE), at('src/app.js'));
const detailOf = (plans, extra = {}) => ({ kind: 'edit', path: plans[0]?.relative, replace_all: false, old_string: 'const b = 2;', new_string: 'const b = 20;', preview: buildChangePreview(plans), ...extra });
const approval = (detail, overrides = {}) => ({ id: 'req-1', tool: 'local.edit_file', description: 'Sửa src/app.js', risk: 'workspace_edit', reason: 'x', detail, ...overrides });
const render = (detail, lang = 'vi', overrides = {}) => renderWith(ApprovalStack, { approvals: [approval(detail, overrides)], onApprove() {}, onDeny() {} }, [], [], { lang }, {});
const decode = (html) => html.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&gt;/g, '>').replace(/&lt;/g, '<');
/** The inside of the first element with this data-testid. */
const inner = (html, testid) => {
  const open = new RegExp(`<([a-z0-9]+)[^>]*data-testid="${testid}"[^>]*>`).exec(html);
  if (!open) return null;
  const rest = html.slice(open.index + open[0].length);
  return decode(rest.slice(0, rest.indexOf(`</${open[1]}>`)));
};
/** Every <details data-testid="change-file"> of the card, as html. */
const fileBlocks = (html) => [...html.matchAll(/<details[^>]*data-testid="change-file"[\s\S]*?<\/details>/g)].map((match) => match[0]);
const rowsIn = (html, kind) => (html.match(new RegExp(`data-row="${kind}"`, 'g')) ?? []).length;

test('the card of an edit says what it does to the file, with the hunk as the Review tab draws it (Vietnamese)', async () => {
  const html = await render(detailOf([editPlan()]));
  assert.match(html, /data-testid="change-preview"/);
  assert.equal(inner(html, 'change-title'), 'Thay đổi sẽ được ghi');
  assert.equal(inner(html, 'change-count'), '1 tệp');
  const [block] = fileBlocks(html);
  assert.ok(block, 'one file');
  assert.doesNotMatch(block.slice(0, block.indexOf('>') + 1), /\sopen[\s=>]/, 'a file is collapsed until the owner opens it');
  assert.match(block, /data-path="src\/app\.js"/);
  assert.equal(inner(block, 'change-file-action'), 'Sửa');
  assert.equal(inner(block, 'change-file-path'), 'src/app.js');
  assert.equal(inner(block, 'change-file-counts'), '+1 -1');
  assert.match(block, /<summary[^>]*aria-label="Sửa src\/app\.js, thêm 1, bớt 1"/, 'a screen reader hears the same');
  assert.equal(rowsIn(block, 'removed'), 1);
  assert.equal(rowsIn(block, 'added'), 1);
  assert.equal(rowsIn(block, 'context'), 2, 'the lines around the change');
  assert.match(inner(block, 'change-hunk-title'), /Từ dòng 2/);
  assert.match(inner(block, 'change-base'), /Dựa trên tệp có mã [0-9a-f]{8}\b/);
  assert.match(decode(block), /const b = 2;/);
  assert.match(decode(block), /const b = 20;/);
  assert.match(html, /Hub tính bản xem trước này từ các tệp ngay lúc hỏi/, 'the note about a file that changes before the answer');
  assert.equal(inner(html, 'change-total'), '+1 -1');
});

test('the same card in English', async () => {
  const html = await render(detailOf([editPlan()]), 'en');
  assert.equal(inner(html, 'change-title'), 'Changes that will be written');
  assert.equal(inner(html, 'change-count'), '1 file(s)');
  assert.equal(inner(html, 'change-file-action'), 'Edit');
  assert.match(html, /aria-label="Edit src\/app\.js, 1 added, 1 removed"/);
  assert.match(inner(html, 'change-hunk-title'), /From line 2/);
  assert.match(html, /The Hub works this preview out from the files at the moment it asks/);
  assert.doesNotMatch(html, /Thay đổi sẽ|Từ dòng|Dựa trên/, 'nothing of the other language');
});

test('a new file, a file that is replaced, and a call with several files', async () => {
  const created = planWrite({ path: 'deep/new.txt', content: 'one\ntwo\n' }, null, at('deep/new.txt'));
  const html = await render(detailOf([created], { kind: 'write' }), 'vi', { tool: 'local.write_file' });
  const [block] = fileBlocks(html);
  assert.equal(inner(block, 'change-file-action'), 'Tạo mới');
  assert.equal(inner(block, 'change-file-counts'), '+2 -0');
  assert.equal(inner(block, 'change-base'), 'Tệp chưa tồn tại');
  assert.equal(rowsIn(block, 'added'), 2);
  const replaced = planWrite({ path: 'win.txt', content: 'keep\nnew\n', overwrite: true }, bytes('keep\r\nold\r\n'), at('win.txt'));
  const both = await render(detailOf([created, replaced], { kind: 'batch' }), 'vi', { tool: 'local.files_write_batch' });
  const blocks = fileBlocks(both);
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks.map((item) => inner(item, 'change-file-action')), ['Tạo mới', 'Ghi đè']);
  assert.deepEqual(blocks.map((item) => inner(item, 'change-file-path')), ['deep/new.txt', 'win.txt']);
  assert.equal(inner(both, 'change-count'), '2 tệp');
  assert.equal(inner(both, 'change-total'), '+3 -1');
  const english = await render(detailOf([created, replaced], { kind: 'batch' }), 'en', { tool: 'local.files_write_batch' });
  assert.deepEqual(fileBlocks(english).map((item) => inner(item, 'change-file-action')), ['New file', 'Overwrite']);
});

test('the old crude diff is gone when the real change is there, and stays for a request from an older Hub', async () => {
  // the request as the Hub sends it, through the normalisation the page does, so that the old strings (oldContent, newContent) are there as they are in the app
  const raw = (detail) => ({ id: 'req-1', taskId: 't', toolName: 'local.edit_file', category: 'workspace_edit', summary: 'Sửa src/app.js', reason: 'x', detail, preview: JSON.stringify(detail), at: '2026-11-03T10:00:00Z' });
  const draw = (detail) => renderWith(ApprovalStack, { approvals: [normalizeApproval(raw(detail))], onApprove() {}, onDeny() {} }, [], [], { lang: 'vi' }, {});
  const withChange = await draw(detailOf([editPlan()]));
  assert.doesNotMatch(withChange, /aria-label="Diff được yêu cầu"/, 'the two lines the model wrote are not shown as a diff next to the real one');
  const details = /<details[^>]*>\s*<summary[^>]*>Chi tiết thao tác[\s\S]*?<\/details>/.exec(withChange)?.[0] ?? '';
  assert.ok(details, 'the technical details are there');
  assert.match(details, /const b = 2;/, 'the technical details are still below');
  assert.doesNotMatch(details, /"rows"|"hunks"|"preview"/, 'but they do not carry the whole preview a second time');
  const legacy = await draw({ kind: 'edit', path: 'src/app.js', replace_all: false, old_string: 'const b = 2;', new_string: 'const b = 20;' });
  assert.match(legacy, /aria-label="Diff được yêu cầu"/, 'a request without the preview is drawn as before');
  assert.doesNotMatch(legacy, /data-testid="change-preview"/);
});

test('a hunk that only changes line endings says so', async () => {
  const crlfOnly = {
    files: [{ path: 'w.txt', action: 'overwrite', baseSha: 'a'.repeat(64), additions: 2, deletions: 2, unchanged: false, shownRows: 4, hiddenRows: 0, truncated: false,
      hunks: [{ baselineStart: 0, baselineEnd: 2, currentStart: 0, currentEnd: 2, removed: 2, added: 2, invisibleOnly: true, rows: [
        { kind: 'removed', text: 'a\n' }, { kind: 'removed', text: 'b\n' }, { kind: 'added', text: 'a\r\n' }, { kind: 'added', text: 'b\r\n' }] }] }],
    fileCount: 1, hiddenFiles: 0, truncated: false,
  };
  const html = await render({ kind: 'write', path: 'w.txt', preview: crlfOnly });
  assert.ok(decode(html).includes(translations.vi.review_hunk_invisible), 'the same sentence as the Review tab');
  assert.ok(decode(html).includes(translations.vi.review_eol_lf), 'and which ending each line has');
  assert.ok(decode(html).includes(translations.vi.review_eol_crlf));
});

test('what is not shown is counted: rows of a file, files of a call, characters of a line', async () => {
  const lines = Array.from({ length: 1000 }, (_, n) => `line ${n + 1}\n`).join('');
  const big = planWrite({ path: 'big.txt', content: lines }, null, at('big.txt'));
  const files = Array.from({ length: 25 }, (_, n) => planWrite({ path: `f${n}.txt`, content: `${n}\n` }, null, at(`f${n}.txt`)));
  const detail = detailOf([big, ...files.slice(0, 24)], { kind: 'batch' });
  const html = await render(detail);
  const [first] = fileBlocks(html);
  assert.equal(rowsIn(first, 'added'), PREVIEW_LIMITS.rows, '200 rows are drawn');
  assert.equal(inner(first, 'change-file-counts'), '+1000 -0', 'the counts are those of the whole file');
  assert.equal(inner(first, 'change-more-rows'), '… 800 dòng nữa không hiển thị ở đây');
  assert.equal(fileBlocks(html).length, PREVIEW_LIMITS.files);
  assert.equal(inner(html, 'change-more-files'), '… 5 tệp nữa không hiển thị ở đây; lệnh vẫn áp dụng cho các tệp đó');
  assert.equal(inner(html, 'change-count'), '25 tệp');
  assert.equal(html.includes('data-testid="change-total"'), false, 'no total when some files are not shown: it would be a total of part of the call');
  const english = await render(detail, 'en');
  assert.equal(inner(english, 'change-more-rows'), '… 800 more lines not shown here');
  assert.equal(inner(english, 'change-more-files'), '… 5 more files not shown here; the call applies to them too');
  const wide = planWrite({ path: 'wide.txt', content: `${'x'.repeat(5000)}\n`, overwrite: true }, bytes('short\n'), at('wide.txt'));
  const cut = await render(detailOf([wide]));
  assert.match(inner(cut, 'row-cut'), /\+4600 ký tự/);
  assert.match(inner(await render(detailOf([wide]), 'en'), 'row-cut'), /\+4600 characters/);
});

test('a call that would be refused says why, a file that does not change says so, and an old file that is not text is named', async () => {
  const refused = buildChangePreview([], { code: 'ambiguous_match', message: 'old_string xuất hiện 3 lần' });
  const html = await render({ kind: 'edit', path: 'a.txt', preview: refused });
  assert.equal(inner(html, 'change-error'), 'Lệnh này sẽ bị từ chối khi chạy (ambiguous_match): Đoạn văn bản cần thay xuất hiện nhiều hơn một lần trong tệp.', 'a code the page knows is told in the language on screen');
  assert.equal(fileBlocks(html).length, 0);
  assert.equal(inner(await render({ kind: 'edit', path: 'a.txt', preview: refused }, 'en'), 'change-error'), 'This call would be refused when it runs (ambiguous_match): The text to replace is in the file more than once.');
  const unknown = await render({ kind: 'edit', path: 'a.txt', preview: buildChangePreview([], { code: 'file_locked', message: 'Đang bị chương trình khác khóa' }) });
  assert.equal(inner(unknown, 'change-error'), 'Lệnh này sẽ bị từ chối khi chạy (file_locked): Đang bị chương trình khác khóa', 'any other code is told in the Hub\'s own words');
  const same = planWrite({ path: 'same.txt', content: 'x\n', overwrite: true }, bytes('x\n'), at('same.txt'));
  const quiet = await render(detailOf([same], { kind: 'write' }));
  assert.equal(inner(quiet, 'change-unchanged'), 'Nội dung không đổi, sẽ không ghi gì.');
  const blob = planWrite({ path: 'blob.bin', content: 'text\n', overwrite: true }, Buffer.from([0, 1, 2, 3]), at('blob.bin'));
  assert.match(inner(await render(detailOf([blob], { kind: 'write' })), 'change-unreadable'), /không phải văn bản đọc được/);
  assert.match(inner(await render(detailOf([blob], { kind: 'write' }), 'en'), 'change-unreadable'), /not readable text/);
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
  assert.equal(refusalSentenceKey('file_locked'), null);
});

test('lines are text, never markup, and characters nobody can see are shown as markers', async () => {
  const nasty = planWrite({ path: 'x.html', content: '<img src=x onerror=alert(1)> & "q"\n</pre><script>alert(1)</script>\nsafe‮evil\n' }, null, at('x.html'));
  const html = await render(detailOf([nasty], { kind: 'write' }));
  assert.doesNotMatch(html, /<img src=x|<script>alert/, 'escaped by React');
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /‹U\+202E›/, 'a direction override is a visible marker, not a reordering of the line');
  assert.doesNotMatch(html, /‮/);
  const secret = planWrite({ path: 'c.js', content: 'const key = "[REDACTED]";\n' }, null, at('c.js'));
  assert.match(decode(await render(detailOf([secret], { kind: 'write' }))), /const key = "\[REDACTED\]";/, 'what the Hub masked stays masked');
});

test('the card is read-only: the only buttons are the two of the request', async () => {
  const html = await render(detailOf([editPlan()]));
  const labels = [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((match) => decode(match[1]).trim());
  assert.deepEqual(labels, ['Từ chối', 'Phê duyệt'], 'no accept or reject of a hunk here: the owner decides on the whole call');
});

test('a broken preview does not break the page', async () => {
  for (const preview of [undefined, null, 'text', 5, [], {}, { files: 'nope' }, { files: [null, 5, 'x', { path: 7 }, { path: 'ok.txt', hunks: 'nope' }, { path: 'ok2.txt', hunks: [null, { rows: 'x' }, { rows: [null, { kind: 'weird', text: 'x' }, { kind: 'added', text: 5 }, { kind: 'added', text: 'fine\n' }] }] }] }, { error: 5 }, { error: { code: 5, message: {} } }]) {
    const html = await render({ kind: 'edit', path: 'a.txt', preview });
    assert.match(html, /data-approval-id="req-1"/, `the card still renders for ${JSON.stringify(preview)}`);
  }
  const html = await render({ kind: 'edit', path: 'a.txt', preview: { files: [{ path: 'ok2.txt', hunks: [{ rows: [{ kind: 'weird', text: 'x' }, { kind: 'added', text: 'fine\n' }, { kind: 'added', text: 5 }] }] }] } });
  assert.equal(rowsIn(html, 'added'), 1, 'only the row that is a row is drawn');
  assert.equal(rowsIn(html, 'removed') + rowsIn(html, 'context'), 0);
});

test('parseChangePreview reads only what it knows, bounded', () => {
  assert.equal(parseChangePreview(undefined), null);
  assert.equal(parseChangePreview({ kind: 'edit' }), null);
  assert.equal(parseChangePreview({ preview: [] }), null);
  assert.equal(parseChangePreview({ preview: null }), null);
  assert.equal(parseChangePreview('x'), null);
  assert.equal(CHANGE_FILES_SHOWN, 20);
  assert.equal(CHANGE_ROWS_SHOWN, 200);
  const view = parseChangePreview({ preview: buildChangePreview([editPlan()]) });
  assert.equal(view.files.length, 1);
  assert.deepEqual({ ...view.files[0], hunks: view.files[0].hunks.length }, {
    path: 'src/app.js', action: 'edit', baseSha: view.files[0].baseSha, additions: 1, deletions: 1, unchanged: false, oldUnreadable: false, hunks: 1, shownRows: 4, hiddenRows: 0, truncated: false,
  });
  assert.equal(view.files[0].baseSha?.length, 64);
  assert.deepEqual([view.fileCount, view.hiddenFiles, view.truncated, view.error], [1, 0, false, null]);
  assert.deepEqual(view.files[0].hunks[0].rows.map((row) => row.kind), ['context', 'removed', 'added', 'context']);
  // never more than the card shows, whatever was sent
  const flood = parseChangePreview({ preview: {
    files: Array.from({ length: 60 }, (_, n) => ({ path: `f${n}`, action: 'edit', hunks: [{ rows: Array.from({ length: 900 }, () => ({ kind: 'added', text: 'x'.repeat(5000) })) }] })), fileCount: 60 } });
  assert.equal(flood.files.length, 20, 'twenty files');
  assert.equal(flood.hiddenFiles, 40);
  assert.equal(flood.files[0].hunks.flatMap((hunk) => hunk.rows).length, 200, 'two hundred rows');
  assert.ok(flood.files[0].hunks[0].rows[0].text.length <= 410, 'a line is cut');
  assert.equal(flood.files[0].action, 'edit');
  const strange = parseChangePreview({ preview: { files: [{ path: 'p', action: 'rm -rf', additions: -5, deletions: 'x', baseSha: 'not a hash', hunks: [] }], fileCount: -1, hiddenFiles: 'a', error: { code: 7, message: 'm' } } });
  assert.equal(strange.files[0].action, 'edit', 'an action it does not know is an edit');
  assert.deepEqual([strange.files[0].additions, strange.files[0].deletions, strange.files[0].baseSha], [0, 0, null]);
  assert.equal(strange.fileCount, 1);
  assert.equal(strange.hiddenFiles, 0);
  assert.deepEqual(strange.error, { code: 'local_error', message: 'm' });
});

test('every string of the card exists in both languages, the Vietnamese has its diacritics and the English none', () => {
  const keys = Object.keys(translations.vi).filter((key) => key.startsWith('agents_apr_changes_') || key === 'review_row_cut');
  assert.ok(keys.length >= 15, `the strings: ${keys.length}`);
  for (const key of keys) {
    assert.equal(typeof translations.en[key], 'string', `${key} in English`);
    assert.notEqual(translations.en[key], translations.vi[key], `${key} is translated, not copied`);
    assert.deepEqual(translations.en[key].match(/\{\w+\}/g)?.sort() ?? [], translations.vi[key].match(/\{\w+\}/g)?.sort() ?? [], `${key}: the same placeholders in both`);
    assert.doesNotMatch(translations.en[key], DIACRITICS, `${key}: no diacritics in English`);
  }
  for (const key of ['agents_apr_changes_title', 'agents_apr_changes_note', 'agents_apr_changes_unchanged', 'agents_apr_changes_error']) assert.match(translations.vi[key], DIACRITICS, `${key} is written with diacritics`);
  assert.deepEqual(Object.keys(translations.en).filter((key) => key.startsWith('agents_apr_changes_')).sort(), Object.keys(translations.vi).filter((key) => key.startsWith('agents_apr_changes_')).sort(), 'no key in only one language');
});

test('the planners and the card agree on a batch read through the loader (the shape the page receives)', async () => {
  const disk = new Map([['old.txt', bytes('o\r\nl\r\n')]]);
  const plans = await planWriteBatch([{ path: 'new.txt', content: 'N\n' }, { path: 'old.txt', content: 'o\nL\n', overwrite: true }], async (item) => ({ relative: item.path, absolute: `/w/${item.path}`, existing: disk.get(item.path) ?? null, mode: 0o644, parentIsFile: false }));
  const html = await render({ kind: 'batch', count: 2, files: [], preview: buildChangePreview(plans) });
  assert.deepEqual(fileBlocks(html).map((block) => inner(block, 'change-file-counts')), ['+1 -0', '+1 -1']);
  const old = fileBlocks(html)[1];
  assert.deepEqual([...old.matchAll(/data-row="(\w+)"[^>]*>[\s\S]*?<\/div>/g)].map((match) => match[1]), ['context', 'removed', 'added']);
});
