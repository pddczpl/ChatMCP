import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { bundleTsx, renderPrelude } from './support/bundle.mjs';
import { accessibleName, all, byTag, normalise, parseHtml, visibleWords } from './support/html.mjs';

// The screens of rolling back, rendered by the real components with the answers of the Hub in the cache of the page: the confirm dialog, the receipt of a step, the Review tab's undo-all button,
// the bar of the last restore and the list of checkpoints. What a click does against the Hub (the dialog, the keyboard, the bytes on disk) is in e2e/rollback.spec.mjs; the plans and the
// words behind it are in rollback.test.mjs.
const loaded = await bundleTsx(`
  ${renderPrelude}
  import { ConfirmDialog, useConfirm } from './src/components/ui/ConfirmDialog';
  import { ToolReceipt } from './src/components/conversation/ToolReceipt';
  import { ReviewTab } from './src/components/inspector/ReviewTab';
  import { GitTab } from './src/components/inspector/GitTab';
  import { translations } from './src/lib/i18n';
  let asked;
  const Probe = () => { asked = useConfirm(); return null; };
  export const withoutProvider = async (request) => { await renderWith(Probe, {}); return asked(request); };
  export { ConfirmDialog, ToolReceipt, ReviewTab, GitTab, translations };
`, 'chatmcp-rollback-components-');
after(loaded.dispose);
const { translations } = loaded.loaded;

const DIACRITICS = /[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/i;
const WORKSPACE = '/work/alpha';
const TASK = '0b9a3f3e-1d5c-4c1a-9d40-6b8f2a7c1e55';
const hub = (extra = {}) => ({ agent: { activeTaskId: null }, workspace: { path: WORKSPACE }, studio: { permissions: { executionPolicy: 'host-review' } }, ...extra });
const sha = (letter) => letter.repeat(64);
// every render starts with no restore remembered: the store of a render is the one the render before it left, but for the few things renderWith puts back
const render = (name, props, entries, store = {}, lang = 'vi') => loaded.loaded.renderWith(loaded.loaded[name], props, entries, [], { lang, lastRestores: {}, ...store });
const byTestId = (root, id) => all(root).filter((node) => node.attrs?.['data-testid'] === id);
const nameOf = (root, node) => normalise(accessibleName(root, node));

// ------------------------------------------------------------------ the confirm dialog
const REQUEST = { title: 'Gỡ nguồn?', body: 'owner/repo', details: ['Đưa a.txt về như trước', 'Xóa b.txt (do bước này tạo ra)'], notes: [{ tone: 'warn', text: 'Chưa đầy đủ.' }, { tone: 'info', text: 'Có bản sao lưu.' }], confirmLabel: 'Hoàn tác bước' };

test('the confirm dialog is a native dialog with the alertdialog role, its title and its question named, Cancel before the confirm button', async () => {
  const root = parseHtml(await render('ConfirmDialog', { request: REQUEST, onAnswer() {} }, []));
  const [dialog] = byTag(root, 'dialog');
  assert.equal(dialog.attrs.role, 'alertdialog');
  assert.ok(dialog.attrs['aria-labelledby'] && dialog.attrs['aria-describedby'], 'named by its title and described by its question');
  assert.equal(normalise(byTag(root, 'h3')[0].text), 'Gỡ nguồn?');
  const buttons = byTag(root, 'button');
  assert.deepEqual(buttons.map((button) => [normalise(button.text), button.attrs.type]), [['Hủy', 'button'], ['Hoàn tác bước', 'submit']], 'Cancel comes first, so a hasty Enter on the focus it was given does the least');
  assert.equal(buttons[1].attrs.disabled, undefined, 'the confirm button works when no phrase is asked for');
  assert.deepEqual(byTestId(root, 'confirm-details')[0] && all(byTestId(root, 'confirm-details')[0]).filter((node) => node.tag === 'li').map((node) => normalise(node.text)), ['Đưa a.txt về như trước', 'Xóa b.txt (do bước này tạo ra)'], 'a line for each file');
  assert.deepEqual(all(root).filter((node) => node.attrs?.role === 'note').map((node) => [node.attrs['data-tone'], normalise(node.text)]), [['warn', 'Chưa đầy đủ.'], ['info', 'Có bản sao lưu.']], 'the notes, with their tone');
});

test('a dialog that asks for a phrase has a named field, and the confirm button waits for the words', async () => {
  const root = parseHtml(await render('ConfirmDialog', { request: { title: 'Gỡ?', confirmLabel: 'Gỡ nguồn', phrase: 'REMOVE GITHUB SOURCE', tone: 'danger' }, onAnswer() {} }, []));
  const field = byTag(root, 'input')[0];
  assert.equal(field.attrs['aria-label'], 'Cụm từ xác nhận');
  assert.equal(field.attrs.autocomplete, 'off');
  assert.match(normalise(byTag(root, 'label')[0].text), /^Gõ "REMOVE GITHUB SOURCE" để xác nhận\.$/);
  assert.notEqual(byTag(root, 'button')[1].attrs.disabled, undefined, 'nothing typed yet: the button is disabled');
  assert.match(byTag(root, 'button')[1].attrs.class, /text-danger/, 'and red, since it destroys');
  const english = parseHtml(await render('ConfirmDialog', { request: { title: 'Remove?', confirmLabel: 'Remove', phrase: 'X' }, onAnswer() {} }, [], {}, 'en'));
  assert.equal(normalise(byTag(english, 'button')[0].text), 'Cancel');
  assert.equal(byTag(english, 'input')[0].attrs['aria-label'], 'Confirmation phrase');
});

test('with no question there is nothing to answer, and a screen without the dialog never confirms anything', async () => {
  const root = parseHtml(await render('ConfirmDialog', { request: null, onAnswer() {} }, []));
  assert.equal(byTag(root, 'button').length, 0);
  assert.equal(byTag(root, 'form').length, 0);
  assert.equal(await loaded.loaded.withoutProvider(REQUEST), false, 'a destructive action is never taken without a question that was shown');
});

// ------------------------------------------------------------------ the receipt of a step
const call = (name, args, extra = {}) => ({ id: 'tool:0', callId: 'call_1', name, args, status: 'success', result: 'ok', checkpointId: 'cp-1', ...extra });
const receipt = async (tool, { lang = 'vi', hubState = hub() } = {}) => {
  const html = await render('ToolReceipt', { tool }, [[['hubState'], hubState]], {}, lang);
  return { html, root: parseHtml(html), undo: byTestId(parseHtml(html), 'receipt-undo-step')[0] };
};

test('the receipt of an edit that went through, and of a command that ran, offers "Undo this step", named after what the step did', async () => {
  const edit = await receipt(call('local.edit_file', { path: 'src/a.txt' }));
  assert.ok(edit.undo, 'an edit with its checkpoint');
  assert.equal(edit.undo.attrs['aria-label'], 'Hoàn tác bước này: src/a.txt');
  assert.equal(normalise(edit.undo.text), 'Hoàn tác bước này');
  assert.equal(edit.undo.attrs.disabled, undefined);
  const english = await receipt(call('local.edit_file', { path: 'src/a.txt' }), { lang: 'en' });
  assert.equal(english.undo.attrs['aria-label'], 'Undo this step: src/a.txt');
  assert.equal(visibleWords(english.html).filter((word) => DIACRITICS.test(word)).length, 0, 'the English receipt reads English');
  const command = await receipt(call('local.run_command', { command: 'node tools/make.js' }));
  assert.ok(command.undo, 'a command that went through had a snapshot made before it');
  assert.match(command.undo.attrs['aria-label'], /^Hoàn tác bước này: /);
  assert.ok((await receipt(call('local.run_command', { command: 'node x.js' }, { status: 'error' }))).undo, 'also a command that failed: it may have changed files before it did');
});

test('no undo for what changed nothing, or had no checkpoint of its own', async () => {
  for (const tool of [
    call('local.edit_file', { path: 'a.txt' }, { status: 'error' }),
    call('local.edit_file', { path: 'a.txt' }, { status: 'running' }),
    call('local.edit_file', { path: 'a.txt' }, { checkpointId: undefined }),
    call('local.read_file', { path: 'a.txt' }),
    call('local.search_files', { query: 'x' }),
  ]) assert.equal((await receipt(tool)).undo, undefined, `${tool.name} ${tool.status}`);
});

test('while an agent runs the button is there and cannot be pressed, and says why', async () => {
  const running = await receipt(call('local.edit_file', { path: 'a.txt' }), { hubState: hub({ agent: { activeTaskId: TASK } }) });
  assert.notEqual(running.undo.attrs.disabled, undefined);
  assert.equal(running.undo.attrs.title, 'Đang có agent chạy. Chờ agent dừng rồi hãy hoàn tác.');
  const english = await receipt(call('local.edit_file', { path: 'a.txt' }), { hubState: hub({ agent: { activeTaskId: TASK } }), lang: 'en' });
  assert.equal(english.undo.attrs.title, 'An agent is running. Wait for it to stop before undoing.');
});

// ------------------------------------------------------------------ the Review tab
const FILE = (extra = {}) => ({ path: 'notes.txt', status: 'modified', change: 'modified', baselineText: 'a\n', currentText: 'b\n', baselineSha: sha('a'), currentSha: sha('b'), partial: false, accepted: false, baselineSource: 'checkpoint', checkpointId: 'cp-1', rejectable: false, ...extra });
const review = (files) => ({ taskId: TASK, files, truncated: false, omitted: { protected: 0 }, limitations: [] });
const reviewTab = async (files, { hubState = hub(), store = {}, lang = 'vi' } = {}) => {
  const entries = [[['hubState'], hubState], [['task', TASK], { id: TASK, status: 'completed', finishedAt: '2026-11-03T10:00:00Z', toolCalls: [] }], [['taskReview', TASK, 'completed:2026-11-03T10:00:00Z'], review(files)]];
  const html = await render('ReviewTab', {}, entries, { selectedTaskId: TASK, ...store }, lang);
  return { html, root: parseHtml(html) };
};
const LAST = { undoCheckpointId: '11111111-1111-1111-1111-111111111111', files: 3, shas: { 'a.txt': sha('a') }, source: 'task', at: '2026-11-04T10:00:00.000Z' };

test('the Review tab has "Undo all changes", beside accept and reject, and it waits for an agent that runs', async () => {
  const { root } = await reviewTab([FILE()]);
  const undo = byTestId(root, 'review-undo-all')[0];
  assert.equal(normalise(undo.text), 'Hoàn tác mọi thay đổi');
  assert.equal(undo.attrs.disabled, undefined);
  const busy = await reviewTab([FILE()], { hubState: hub({ agent: { activeTaskId: TASK } }) });
  assert.notEqual(byTestId(busy.root, 'review-undo-all')[0].attrs.disabled, undefined);
  assert.equal(byTestId(busy.root, 'review-undo-all')[0].attrs.title, 'Đang có agent chạy. Chờ agent dừng rồi hãy hoàn tác.');
  const sandbox = await reviewTab([FILE()], { hubState: hub({ studio: { permissions: { executionPolicy: 'sandbox-only' } } }) });
  assert.notEqual(byTestId(sandbox.root, 'review-undo-all')[0].attrs.disabled, undefined, 'the Hub does not write files in a sandbox-only policy');
  const empty = await reviewTab([]);
  assert.notEqual(byTestId(empty.root, 'review-undo-all')[0].attrs.disabled, undefined, 'a task that changed nothing has nothing to undo');
  const english = await reviewTab([FILE()], { lang: 'en' });
  assert.equal(normalise(byTestId(english.root, 'review-undo-all')[0].text), 'Undo all changes');
});

test('the last restore is shown with the way back from it, only for the workspace it was made in', async () => {
  const none = await reviewTab([FILE()]);
  assert.equal(byTestId(none.root, 'last-restore').length, 0, 'nothing was restored, nothing to undo');
  const shown = await reviewTab([FILE()], { store: { lastRestores: { [WORKSPACE]: LAST } } });
  const [bar] = byTestId(shown.root, 'last-restore');
  assert.match(normalise(bar.text), /^Lần khôi phục cuối · số file: 3 · .*Hoàn tác lần khôi phục cuốiẨn$/);
  assert.equal(nameOf(shown.root, byTestId(shown.root, 'undo-last-restore')[0]), 'Hoàn tác lần khôi phục cuối');
  const other = await reviewTab([FILE()], { store: { lastRestores: { '/work/beta': LAST } } });
  assert.equal(byTestId(other.root, 'last-restore').length, 0, 'another workspace\'s restore is not offered here');
  const busy = await reviewTab([FILE()], { store: { lastRestores: { [WORKSPACE]: LAST } }, hubState: hub({ agent: { activeTaskId: TASK } }) });
  assert.notEqual(byTestId(busy.root, 'undo-last-restore')[0].attrs.disabled, undefined);
  const english = await reviewTab([FILE()], { store: { lastRestores: { [WORKSPACE]: LAST } }, lang: 'en' });
  assert.match(normalise(byTestId(english.root, 'last-restore')[0].text), /^Last restore · files: 3 · .*Undo last restoreDismiss$/);
});

// ------------------------------------------------------------------ the checkpoints
const CHECKPOINTS = [
  { id: 'aaaaaaaa-1111-1111-1111-111111111111', at: '2026-11-04T10:00:00Z', label: 'Before local.write_file', fileCount: 1, absentCount: 2, targeted: true, partial: true, taskId: TASK },
  { id: 'bbbbbbbb-2222-2222-2222-222222222222', at: '2026-11-04T09:00:00Z', label: 'Before local.run_command', fileCount: 40, absentCount: 0, targeted: false, partial: true, taskId: TASK },
  { id: 'cccccccc-3333-3333-3333-333333333333', at: '2026-11-04T08:00:00Z', label: 'Undo backup before restoring checkpoint x', fileCount: 2, absentCount: 0, targeted: true, partial: true, taskId: null, kind: 'undo' },
  { id: 'dddddddd-4444-4444-4444-444444444444', at: '2026-11-04T07:00:00Z', label: '', fileCount: 5, partial: true },
];
const gitTab = async (checkpoints, { hubState = hub(), store = {}, lang = 'vi' } = {}) => {
  const entries = [[['hubState'], hubState], [['gitStatus', WORKSPACE], { branch: 'main', dirty: false }], [['checkpointsList', WORKSPACE], checkpoints], [['gitDiff', WORKSPACE, false], { diff: '' }]];
  const html = await render('GitTab', {}, entries, store, lang);
  return { html, root: parseHtml(html) };
};

test('each checkpoint says what it holds, which are only snapshots before a command, and which are the backup of a restore', async () => {
  const { root } = await gitTab(CHECKPOINTS);
  const rows = byTestId(root, 'checkpoint-row');
  assert.deepEqual(rows.map((row) => [row.attrs['data-kind'], row.attrs['data-targeted']]), [['checkpoint', 'true'], ['checkpoint', 'false'], ['undo', 'true'], ['checkpoint', 'false']]);
  assert.match(normalise(rows[0].text), /^Before local\.write_fileaaaaaaaa-111 · file: 1 · tạo mới: 2 · /, 'the file count and the count of files it recorded as not there yet');
  assert.equal(byTestId(rows[0], 'checkpoint-incomplete-badge').length + byTestId(rows[0], 'checkpoint-undo-badge').length, 0, 'a checkpoint of exactly the files of a call has no badge');
  assert.equal(normalise(byTestId(rows[1], 'checkpoint-incomplete-badge')[0].text), 'Chưa đầy đủ', 'a snapshot before a command is incomplete');
  assert.match(byTestId(rows[1], 'checkpoint-incomplete-badge')[0].attrs.title, /^Ảnh chụp các file nguồn trước một lệnh/, 'and says what that means');
  assert.equal(normalise(byTestId(rows[2], 'checkpoint-undo-badge')[0].text), 'Bản sao lưu để hoàn tác');
  assert.equal(byTestId(rows[2], 'checkpoint-incomplete-badge').length, 0, 'a backup is not called incomplete');
  assert.match(normalise(rows[3].text), /^ddddddddddddd?/, 'a checkpoint with no label is known by the start of its id');
});

test('a checkpoint opens to its files; both ways of restoring are there, and wait for an agent that runs', async () => {
  const { root } = await gitTab(CHECKPOINTS);
  const toggles = byTestId(root, 'checkpoint-toggle');
  assert.equal(toggles.length, 4);
  assert.deepEqual(toggles.map((toggle) => toggle.attrs['aria-expanded']), ['false', 'false', 'false', 'false']);
  assert.equal(normalise(toggles[0].text), 'Xem file');
  assert.equal(byTestId(root, 'checkpoint-files').length, 0, 'closed: no list of files');
  assert.equal(byTestId(root, 'checkpoints-blocked').length, 0);
  const restore = byTestId(root, 'checkpoint-restore-all')[0];
  assert.equal(normalise(restore.text), 'Khôi phục');
  assert.equal(restore.attrs.disabled, undefined);
  const busy = await gitTab(CHECKPOINTS, { hubState: hub({ agent: { activeTaskId: TASK } }) });
  assert.equal(normalise(byTestId(busy.root, 'checkpoints-blocked')[0].text), 'Đang có agent chạy. Chờ agent dừng rồi hãy khôi phục file.');
  assert.ok(byTestId(busy.root, 'checkpoint-restore-all').every((button) => button.attrs.disabled !== undefined), 'no restore while an agent runs');
  const english = await gitTab(CHECKPOINTS, { lang: 'en' });
  assert.equal(normalise(byTestId(english.root, 'checkpoint-toggle')[0].text), 'Show files');
  assert.equal(visibleWords(english.html).filter((word) => DIACRITICS.test(word)).length, 0, 'the English screen reads English');
  assert.equal(normalise(byTestId(english.root, 'checkpoint-incomplete-badge')[0].text), 'Incomplete');
  assert.match(normalise(byTestId(english.root, 'checkpoint-row')[0].text), / · files: 1 · created: 2 · /);
});

test('the last restore is shown above the list of checkpoints too', async () => {
  const { root } = await gitTab(CHECKPOINTS, { store: { lastRestores: { [WORKSPACE]: LAST } } });
  assert.equal(byTestId(root, 'last-restore').length, 1);
  assert.equal(byTestId((await gitTab(CHECKPOINTS)).root, 'last-restore').length, 0, 'and not when nothing was restored');
});

// ------------------------------------------------------------------ the words
test('every string of rolling back is in both languages with the same placeholders, English without a Vietnamese letter, Vietnamese in Vietnamese', () => {
  const keys = Object.keys(translations.vi).filter((key) => /^(rollback_|ckpt_|confirm_|skills_source_|models_profile_delete_|git_checkpoint_loading)/.test(key));
  assert.ok(keys.length > 70, `read ${keys.length} keys`);
  const holes = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort().join(',');
  for (const key of keys) {
    const vi = translations.vi[key];
    const en = translations.en[key];
    assert.equal(typeof en, 'string', `${key} exists in English`);
    assert.equal(holes(en), holes(vi), `${key}: the same placeholders in both languages`);
    assert.equal(DIACRITICS.test(en), false, `${key}: the English has no Vietnamese letter`);
  }
  assert.ok(keys.filter((key) => DIACRITICS.test(translations.vi[key])).length > keys.length * 0.8, 'and the Vietnamese is Vietnamese');
  assert.equal(translations.vi.rollback_done_one, translations.vi.rollback_done_other, 'Vietnamese has one form for a count');
  assert.match(translations.en.rollback_done_one, /^Undid \{count\} file\.$/);
  assert.match(translations.en.rollback_done_other, /^Undid \{count\} files\.$/);
});
