import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { bundleTsx, renderPrelude } from './support/bundle.mjs';
import { accessibleName, byTag, normalise, parseHtml, visibleWords } from './support/html.mjs';

// The Review tab, its way in under a finished turn, the link in a receipt and its dialog, rendered by the real components with the answers of the Hub in the cache of the page.
// What a click does against the Hub is in e2e/review.spec.mjs; the rules behind it are in review-rules.test.mjs and review-actions.test.mjs.
const loaded = await bundleTsx(`
  ${renderPrelude}
  import { ReviewTab } from './src/components/inspector/ReviewTab';
  import { ReviewConfirm } from './src/components/inspector/ReviewConfirm';
  import { ReviewOffer } from './src/components/conversation/ReviewOffer';
  import { ToolReceipt } from './src/components/conversation/ToolReceipt';
  export { ReviewTab, ReviewConfirm, ReviewOffer, ToolReceipt, useAppStore };
`, 'chatmcp-review-tab-', { recordJsx: true });
after(loaded.dispose);

const DIACRITICS = /[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/i;
const TASK = '0b9a3f3e-1d5c-4c1a-9d40-6b8f2a7c1e55';
const FINISHED = '2026-11-03T10:00:00Z';
const sha = (letter) => letter.repeat(64);
const NOTES_BEFORE = Array.from({ length: 40 }, (_, at) => `line ${String(at + 1).padStart(2, '0')}\r\n`).join('');
const NOTES_AFTER = NOTES_BEFORE.replace('line 03', 'line 03 CHANGED').replace('line 20', 'line 20 CHANGED');

const FILE = (extra = {}) => ({ path: 'notes.txt', status: 'modified', change: 'modified', baselineText: NOTES_BEFORE, currentText: NOTES_AFTER, baselineSha: sha('a'), currentSha: sha('b'), partial: false, accepted: false, rejectable: false, baselineSource: 'checkpoint', checkpointId: 'cp1', ...extra });
const CREATED = (extra = {}) => FILE({ path: 'created.txt', status: 'created', change: 'created', baselineText: null, baselineSha: null, currentText: 'brand new\nsecond line\n', rejectable: true, ...extra });
const DELETED = (extra = {}) => FILE({ path: 'old.txt', status: 'deleted', change: 'deleted', currentText: null, currentSha: null, baselineText: 'to be deleted\n', ...extra });
const BINARY = (extra = {}) => FILE({ path: 'blob.dat', status: 'binary', baselineText: null, currentText: null, textUnavailable: 'binary', ...extra });
const HUB = (extra = {}) => ({ agent: { activeTaskId: null }, studio: { permissions: { executionPolicy: 'host-review' } }, ...extra });
const snapshot = (files, extra = {}) => ({ taskId: TASK, files, truncated: false, omitted: { protected: 0 }, limitations: [], ...extra });

/** The tab for one review (the first file is the one that is open), in a language, with the Hub in a state. */
async function tab(files, { lang = 'vi', hub = HUB(), review = snapshot(files), taskId = TASK, errors = [], withReview = true } = {}) {
  const key = ['taskReview', TASK, `completed:${FINISHED}`];
  const entries = [[['hubState'], hub], [['task', TASK], { id: TASK, status: 'completed', finishedAt: FINISHED, toolCalls: [] }], ...(withReview ? [[key, review]] : [])];
  const html = await loaded.loaded.renderWith(loaded.loaded.ReviewTab, {}, entries, errors, { lang, selectedTaskId: taskId });
  return { html, root: parseHtml(html) };
}
const byTestId = (root, id) => byTag(root, ...new Set(['div', 'p', 'section', 'span', 'button', 'ul', 'h3', 'li'])).filter((node) => node.attrs['data-testid'] === id);
const buttons = (root) => byTag(root, 'button').map((node) => ({ name: normalise(accessibleName(root, node)), disabled: node.attrs.disabled !== undefined }));
const button = (root, name) => buttons(root).find((candidate) => candidate.name === name);

test('a file with two hunks shows its numbers, each hunk with its two buttons, and the keys to use', async () => {
  const { html, root } = await tab([FILE()]);
  assert.equal(normalise(byTestId(root, 'review-summary')[0].text), 'Tệp: 1 · Đoạn chờ xem lại: 2');
  assert.deepEqual(byTestId(root, 'review-file').map((node) => [node.attrs['data-path'], node.attrs['data-status']]), [['notes.txt', 'modified']]);
  assert.match(normalise(byTestId(root, 'review-file')[0].text), /^notes\.txtĐã sửa\+2 -2Chờ xem lại: 2\/2$/);
  assert.equal(byTestId(root, 'review-hunk').length, 2);
  assert.deepEqual(byTestId(root, 'review-hunk').map((node) => node.attrs['aria-label']), ['Đoạn 1/2 của notes.txt', 'Đoạn 2/2 của notes.txt']);
  for (const name of ['Chấp nhận đoạn 1/2 của notes.txt', 'Từ chối đoạn 1/2 của notes.txt', 'Chấp nhận đoạn 2/2 của notes.txt', 'Từ chối đoạn 2/2 của notes.txt', 'Chấp nhận tệp notes.txt', 'Từ chối tệp notes.txt', 'Tải lại', 'Chấp nhận tất cả', 'Từ chối tất cả']) {
    assert.equal(button(root, name)?.disabled, false, `${name} is there and can be pressed`);
  }
  assert.match(html, /line 03 CHANGED/);
  assert.match(html, /line 20 CHANGED/);
  assert.equal(byTestId(root, 'review-note').length, 0, 'nothing is held back');
  assert.match(normalise(visibleWords(html).join(' ')), /j và k đổi đoạn, a chấp nhận, r từ chối/);
  assert.equal(byTestId(root, 'review-hunk')[0].attrs.tabindex, '-1', 'no hunk is the open one until the person moves');
  assert.equal(byTestId(root, 'review-hunk')[0].attrs['data-state'], 'pending');
});

test('the English screen reads English from the first word to the last', async () => {
  const { html, root } = await tab([FILE(), CREATED(), DELETED(), BINARY()], { lang: 'en' });
  assert.equal(visibleWords(html).filter((word) => DIACRITICS.test(word)).length, 0, 'no Vietnamese letter');
  assert.equal(normalise(byTestId(root, 'review-summary')[0].text), 'Files: 4 · Hunks to review: 2');
  for (const name of ['Accept hunk 1 of 2 in notes.txt', 'Reject hunk 2 of 2 in notes.txt', 'Accept file notes.txt', 'Reject file notes.txt', 'Reload', 'Accept all', 'Reject all']) assert.ok(button(root, name), name);
  assert.deepEqual(byTestId(root, 'review-file').map((node) => node.attrs['data-status']), ['modified', 'created', 'deleted', 'binary']);
  assert.match(normalise(byTestId(root, 'review-file')[1].text), /^created\.txtNew\+2 -0$/);
});

test('a file that is not text is listed and says why it has no hunks', async () => {
  for (const [file, note, text] of [
    [BINARY(), 'binary', 'Tệp nhị phân: không xem lại từng đoạn được.'],
    [BINARY({ textUnavailable: 'not_utf8' }), 'not_utf8', 'Tệp không phải UTF-8: không xem lại từng đoạn được.'],
    [FILE({ baselineText: null, currentText: null, textUnavailable: 'too_large' }), 'too_large', 'Tệp quá lớn (trên 300 KB mỗi bên) để hiện từng đoạn.'],
    [FILE({ baselineText: null, currentText: null, textUnavailable: 'budget' }), 'budget', 'Đã vượt giới hạn dung lượng của một lần xem lại nên nội dung tệp này không được kèm.'],
  ]) {
    const { root } = await tab([file]);
    assert.equal(byTestId(root, 'review-note')[0].attrs['data-note'], note);
    assert.equal(normalise(byTestId(root, 'review-note')[0].text), text);
    assert.equal(byTestId(root, 'review-hunk').length, 0);
    assert.equal(button(root, `Từ chối tệp ${file.path}`).disabled, true, 'it cannot be undone from here');
    assert.equal(button(root, `Chấp nhận tệp ${file.path}`).disabled, false, 'but the Hub can record that it was looked at');
  }
});

test('a new file shows its lines and can be moved away; one the Hub cannot move says so', async () => {
  const { root } = await tab([CREATED()]);
  assert.match(normalise(byTestId(root, 'review-new-file')[0].text), /^brand newsecond line$/);
  assert.equal(byTestId(root, 'review-hunk').length, 0, 'its lines are not undone one by one');
  assert.equal(button(root, 'Từ chối tệp created.txt').disabled, false);
  assert.equal(byTestId(root, 'review-note').length, 0);
  const fixed = await tab([CREATED({ rejectable: false })]);
  assert.equal(button(fixed.root, 'Từ chối tệp created.txt').disabled, true);
  assert.equal(byTestId(fixed.root, 'review-note')[0].attrs['data-note'], 'not_rejectable');
});

test('a deleted file can be read, and nothing is offered for it', async () => {
  const { root } = await tab([DELETED()]);
  assert.match(normalise(byTestId(root, 'review-deleted-file')[0].text), /to be deleted/);
  assert.equal(byTestId(root, 'review-note')[0].attrs['data-note'], 'deleted');
  assert.equal(button(root, 'Từ chối tệp old.txt').disabled, true);
  assert.equal(button(root, 'Chấp nhận tệp old.txt').disabled, true);
  assert.equal(byTestId(root, 'review-file')[0].attrs['data-status'], 'deleted');
});

test('a baseline that is only approximate is said to be, in the list and under the name of the file', async () => {
  const { root } = await tab([FILE({ partial: true })]);
  assert.equal(byTestId(root, 'review-partial-note').length, 1);
  assert.match(normalise(byTestId(root, 'review-partial-note')[0].text), /Bản gốc chỉ gần đúng/);
  assert.match(normalise(byTestId(root, 'review-file')[0].text), /Gần đúng/);
  const accepted = await tab([FILE({ accepted: true })]);
  assert.match(normalise(byTestId(accepted.root, 'review-file')[0].text), /Đã chấp nhận/);
  assert.equal(button(accepted.root, 'Chấp nhận tệp notes.txt').disabled, true, 'it was recorded already');
});

test('while any task runs, or under sandbox-only, nothing that writes is offered, and the tab says why', async () => {
  const running = await tab([FILE(), CREATED()], { hub: HUB({ agent: { activeTaskId: 'another' } }) });
  assert.equal(byTestId(running.root, 'review-note')[0].attrs['data-note'], 'running');
  assert.equal(button(running.root, 'Từ chối đoạn 1/2 của notes.txt').disabled, true);
  assert.equal(button(running.root, 'Từ chối tệp notes.txt').disabled, true);
  assert.equal(button(running.root, 'Từ chối tất cả').disabled, true);
  assert.equal(button(running.root, 'Chấp nhận đoạn 1/2 của notes.txt').disabled, false, 'accepting writes nothing');
  assert.equal(button(running.root, 'Chấp nhận tệp notes.txt').disabled, false);
  assert.equal(button(running.root, 'Chấp nhận tất cả').disabled, false);
  const sandbox = await tab([FILE()], { hub: HUB({ studio: { permissions: { executionPolicy: 'sandbox-only' } } }) });
  assert.equal(byTestId(sandbox.root, 'review-note')[0].attrs['data-note'], 'policy');
  assert.equal(button(sandbox.root, 'Từ chối đoạn 1/2 của notes.txt').disabled, true);
  assert.equal(button(sandbox.root, 'Chấp nhận tệp notes.txt').disabled, true, 'the Hub records nothing under sandbox-only');
  assert.equal(button(sandbox.root, 'Chấp nhận đoạn 1/2 của notes.txt').disabled, false, 'a mark on this page is still the page\'s');
  const english = await tab([FILE()], { lang: 'en', hub: HUB({ agent: { activeTaskId: 'another' } }) });
  assert.match(normalise(byTestId(english.root, 'review-note')[0].text), /^A task is running, so the Hub will not write/);
});

test('no conversation, a review that is still coming, and a review that failed are three different screens', async () => {
  const none = await tab([], { taskId: '', withReview: false });
  assert.match(none.html, /Chọn một cuộc trò chuyện để xem lại các tệp nó đã thay đổi\./);
  const loading = await tab([], { withReview: false });
  assert.match(loading.html, /Đang tải các thay đổi…/);
  assert.equal(byTestId(loading.root, 'review-summary').length, 0);
  const failed = await tab([], { withReview: false, errors: [[['taskReview', TASK, `completed:${FINISHED}`], 'Hub không trả lời']] });
  assert.match(failed.html, /role="alert"[^>]*>Không tải được các thay đổi: Hub không trả lời</);
  const empty = await tab([]);
  assert.match(empty.html, /Cuộc trò chuyện này chưa thay đổi tệp nào, hoặc mọi thay đổi đã được trả lại\./);
  assert.equal(byTestId(empty.root, 'review-summary').length, 1);
  assert.equal(button(empty.root, 'Từ chối tất cả').disabled, true);
  assert.equal(button(empty.root, 'Chấp nhận tất cả').disabled, true);
});

test('what the review cannot see is said in the language of the screen when the code is known, and in the Hub\'s words when it is not', async () => {
  const review = snapshot([FILE()], { limitations: [{ code: 'git_unavailable', message: 'Hub ghi bằng tiếng Việt' }, { code: 'something_new', message: 'The Hub wrote this itself' }], omitted: { protected: 3 } });
  const vi = await tab([FILE()], { review });
  assert.deepEqual(byTestId(vi.root, 'review-limitation').map((node) => [node.attrs['data-code'], normalise(node.text)]), [
    ['git_unavailable', 'Hub không hỏi được Git, nên không thấy các tệp mà lệnh shell đã ghi ngoài ảnh chụp workspace.'],
    ['something_new', 'The Hub wrote this itself'],
  ]);
  assert.equal(normalise(byTestId(vi.root, 'review-protected')[0].text), 'Tệp được bảo vệ (khóa, .env, .git) không hiện ở đây: 3');
  const en = await tab([FILE()], { review, lang: 'en' });
  assert.match(normalise(byTestId(en.root, 'review-limitation')[0].text), /^The Hub could not ask Git/);
  assert.equal(normalise(byTestId(en.root, 'review-protected')[0].text), 'Protected files (keys, .env, .git) are not shown here: 3');
});

test('under a finished turn that changed files the conversation offers the tab, and the offer opens it', async () => {
  const edit = (path, extra = {}) => ({ name: 'local.edit_file', args: { path }, status: 'success', checkpointId: 'cp', ...extra });
  const render = (toolCalls, lang = 'vi') => loaded.loaded.renderWith(loaded.loaded.ReviewOffer, { task: { id: TASK, toolCalls } }, [], [], { lang });
  assert.equal(await render([]), '', 'a turn that changed nothing offers nothing');
  assert.equal(await render([{ name: 'local.read_file', args: { path: 'a.js' }, status: 'success' }, edit('a.js', { status: 'error' })]), '', 'neither a read nor an edit that failed');
  const html = await render([edit('a.js'), edit('b.js'), edit('a.js')]);
  assert.match(normalise(visibleWords(html).join(' ')), /Tệp đã thay đổi trong cuộc trò chuyện này: 2 Xem lại thay đổi/);
  assert.match(await render([edit('a.js')], 'en'), /Files changed in this conversation: 1/);
  assert.match(await render([edit('a.js')], 'en'), />Review changes</);
  globalThis.__chatmcpJsx = [];
  loaded.loaded.useAppStore.setState({ activeTab: 'plan', inspectorOpen: false });
  await render([edit('a.js')]);
  globalThis.__chatmcpJsx.find((element) => element.type === 'button' && typeof element.props.onClick === 'function').props.onClick();
  assert.equal(loaded.loaded.useAppStore.getState().activeTab, 'review');
  assert.equal(loaded.loaded.useAppStore.getState().inspectorOpen, true);
});

test('the receipt of an edit that went through links to the file; a read, a failed edit and an edit with no checkpoint have no link', async () => {
  const render = (tool, lang = 'vi') => loaded.loaded.renderWith(loaded.loaded.ToolReceipt, { tool }, [], [], { lang });
  const edit = { name: 'local.edit_file', args: { path: 'src/a.js' }, status: 'success', checkpointId: 'cp1' };
  const html = await render(edit);
  assert.match(html, /data-testid="receipt-review-link"/);
  assert.match(html, /aria-label="Xem lại thay đổi của src\/a\.js"/);
  assert.match(await render(edit, 'en'), /aria-label="Review the changes to src\/a\.js"/);
  for (const tool of [{ ...edit, checkpointId: undefined }, { ...edit, status: 'error' }, { name: 'local.read_file', args: { path: 'src/a.js' }, status: 'success' }, { ...edit, args: {} }]) {
    assert.doesNotMatch(await render(tool), /receipt-review-link/, JSON.stringify(tool));
  }
  // the link is beside the row, not inside it: a button inside a button is not one control
  const root = parseHtml(html);
  const link = byTestId(root, 'receipt-review-link')[0];
  assert.equal(link.tag, 'button');
  assert.ok(!(function inside(node) { for (let at = node.parent; at; at = at.parent) if (at.attrs.role === 'button') return true; return false; })(link));
  globalThis.__chatmcpJsx = [];
  loaded.loaded.useAppStore.setState({ activeTab: 'plan', reviewFocus: null });
  await render(edit);
  globalThis.__chatmcpJsx.find((element) => element.type === 'button' && element.props['data-testid'] === 'receipt-review-link').props.onClick();
  const store = loaded.loaded.useAppStore.getState();
  assert.equal(store.activeTab, 'review');
  assert.equal(store.reviewFocus.path, 'src/a.js');
});

test('the dialog says what would be done, in numbers, puts Cancel first so that it has the focus, and is an alert dialog the project\'s own way', async () => {
  const render = (kind, lang = 'vi') => loaded.loaded.renderWith(loaded.loaded.ReviewConfirm, { kind, accept: { files: 4, hunks: 7 }, reject: { rewrite: 3, hunks: 5, created: 1, left: 2 }, busy: false, onCancel() {}, onConfirm() {} }, [], [], { lang });
  const closed = parseHtml(await render(null));
  const dialog = byTag(closed, 'dialog')[0];
  assert.equal(dialog.attrs.role, 'alertdialog');
  assert.equal(dialog.attrs.open, undefined, 'closed');
  assert.equal(byTag(closed, 'button').length, 0, 'no button is there to take the focus before it is asked for');
  const reject = parseHtml(await render('reject'));
  assert.equal(normalise(byTag(reject, 'h3')[0].text), 'Từ chối tất cả thay đổi?');
  assert.equal(normalise(byTag(reject, 'p')[0].text), 'Các tệp được trả về nội dung trước khi cuộc trò chuyện này sửa. Tệp được ghi lại: 3 (đoạn được trả lại: 5). Tệp mới được chuyển vào thư mục hoàn tác: 1. Tệp để nguyên: 2. Mỗi lần ghi đều tạo một checkpoint để quay lại.');
  assert.deepEqual(byTag(reject, 'button').map((node) => normalise(node.text)), ['Hủy', 'Từ chối tất cả']);
  const accept = parseHtml(await render('accept'));
  assert.equal(normalise(byTag(accept, 'h3')[0].text), 'Chấp nhận tất cả thay đổi?');
  assert.equal(normalise(byTag(accept, 'p')[0].text), 'Đánh dấu đã xem các đoạn: 7. Ghi nhận chấp nhận tại Hub cho các tệp: 4. Không có tệp nào bị sửa.');
  assert.deepEqual(byTag(accept, 'button').map((node) => normalise(node.text)), ['Hủy', 'Chấp nhận tất cả']);
  const english = parseHtml(await render('reject', 'en'));
  assert.equal(normalise(byTag(english, 'p')[0].text), 'The files go back to what they were before this conversation changed them. Files rewritten: 3 (hunks put back: 5). New files moved to the undo folder: 1. Files left as they are: 2. Every write makes a checkpoint you can go back to.');
  assert.deepEqual(byTag(english, 'button').map((node) => normalise(node.text)), ['Cancel', 'Reject all']);
});

test('a file the Hub has recorded as accepted shows its hunks accepted: in the summary, in the list, on the hunks and on their buttons, with no mark made on this page', async () => {
  const { root } = await tab([FILE({ accepted: true })]);
  assert.equal(normalise(byTestId(root, 'review-summary')[0].text), 'Tệp: 1 · Đoạn chờ xem lại: 0');
  assert.match(normalise(byTestId(root, 'review-file')[0].text), /^notes\.txtĐã sửa\+2 -2Chờ xem lại: 0\/2Đã chấp nhận$/);
  assert.deepEqual(byTestId(root, 'review-hunk').map((node) => node.attrs['data-state']), ['accepted', 'accepted']);
  assert.equal(button(root, 'Chấp nhận đoạn 1/2 của notes.txt').disabled, true);
  assert.equal(button(root, 'Chấp nhận đoạn 2/2 của notes.txt').disabled, true);
  assert.equal(button(root, 'Chấp nhận tất cả').disabled, true, 'nothing is left to accept');
  assert.equal(button(root, 'Từ chối đoạn 1/2 của notes.txt').disabled, false, 'an accepted hunk can still be put back');
  const open = await tab([FILE()]);
  assert.deepEqual(byTestId(open.root, 'review-hunk').map((node) => node.attrs['data-state']), ['pending', 'pending'], 'a file that was not accepted is as before');
  assert.equal(button(open.root, 'Chấp nhận tất cả').disabled, false);
});
