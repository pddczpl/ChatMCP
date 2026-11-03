// The Review tab against the real Hub and the production build, with a scripted model that edits two files (one in three places), creates one, deletes one and rewrites a fourth. What is
// asserted is what is on disk, byte for byte, after each thing a person can do in the tab, and what the Hub kept (checkpoints, the undo folder, the acceptance). Nothing is intercepted.
// Every page also listens for securitypolicyviolation: the tab, the dialog and the keys must not need a looser Content-Security-Policy than the Hub serves.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { test, expect, onboard, send, taskByPrompt, openWorkTab } from './fixtures.mjs';
import { answerApprovals } from '../../tests/e2e/hub-process.mjs';
import { call, sequence, shaOf } from '../../tests/e2e/scenarios.mjs';
import { BUGGY_CALC, FIXED_CALC } from '../../tests/e2e/fixtures.mjs';

const PROMPT = 'Sửa notes.txt và calc.js, tạo created.txt, xóa old.txt và sửa blob.dat.';
// Forty lines with Windows line endings: the model changes three of them, far enough apart to be three hunks.
const NOTES_BEFORE = Array.from({ length: 40 }, (_, at) => `line ${String(at + 1).padStart(2, '0')}\r\n`).join('');
const EDITS = [['line 03', 'line 03 CHANGED'], ['line 20', 'line 20 CHANGED'], ['line 37', 'line 37 CHANGED']];
const NOTES_AFTER = EDITS.reduce((text, [from, to]) => text.replace(from, to), NOTES_BEFORE);
const OLD_TEXT = 'to be deleted\n';
const BLOB_BEFORE = 'plain text\n';
const BLOB_AFTER = 'plain text changed\n';
const CREATED_TEXT = 'brand new\nsecond line\n';
const DIACRITICS = /[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/i;

const sha256 = (text) => createHash('sha256').update(Buffer.from(text, 'latin1')).digest('hex');
/** The file as the bytes it holds, one character per byte, so that a difference of one \r shows. */
const disk = (app, name) => fs.readFileSync(path.join(app.project, name)).toString('latin1');
const exists = (app, name) => fs.existsSync(path.join(app.project, name));

/** Every securitypolicyviolation the page sees, across navigations (the binding survives them). */
async function watchPolicy(page) {
  const violations = [];
  await page.exposeFunction('reportPolicyViolation', (line) => violations.push(line));
  await page.addInitScript(() => document.addEventListener('securitypolicyviolation', (event) => window.reportPolicyViolation(`${event.violatedDirective} ${event.blockedURI}`)));
  return violations;
}

/** The task the scripted model carries out in a project that has notes.txt, old.txt and blob.dat on top of the usual calc project. It is done when this returns. */
async function runWork(page, app) {
  fs.writeFileSync(path.join(app.project, 'notes.txt'), Buffer.from(NOTES_BEFORE, 'latin1'));
  fs.writeFileSync(path.join(app.project, 'old.txt'), OLD_TEXT);
  fs.writeFileSync(path.join(app.project, 'blob.dat'), BLOB_BEFORE);
  app.mock.define('review-work', sequence([
    call('read_file', { path: 'notes.txt' }),
    ({ last }) => call('edit_file', { path: 'notes.txt', edits: EDITS.map(([old_string, new_string]) => ({ old_string, new_string })), expected_sha256: shaOf(last) }),
    call('read_file', { path: 'calc.js' }),
    ({ last }) => call('edit_file', { path: 'calc.js', old_string: 'return a - b;', new_string: 'return a + b;', expected_sha256: shaOf(last) }),
    call('write_file', { path: 'created.txt', content: CREATED_TEXT }),
    call('delete_path', { path: 'old.txt' }),
    call('read_file', { path: 'blob.dat' }),
    ({ last }) => call('write_file', { path: 'blob.dat', content: BLOB_AFTER, expected_sha256: shaOf(last) }),
  ], { final: 'Đã sửa notes.txt, calc.js và blob.dat, tạo created.txt và xóa old.txt.' }));
  app.mock.setScenario('review-work');
  await onboard(page, app);
  app.mock.setScenario('review-work'); // the connection check of the first-run dialog is not part of the script
  await send(page, PROMPT);
  const started = await taskByPrompt(app, PROMPT);
  const { task } = await answerApprovals(app.hub, started.id, () => true);
  expect(task.state).toBe('completed');
  for (const [name, expected] of [['notes.txt', NOTES_AFTER], ['calc.js', FIXED_CALC], ['created.txt', CREATED_TEXT], ['blob.dat', BLOB_AFTER]]) expect(disk(app, name), `${name} after the task`).toBe(expected);
  expect(exists(app, 'old.txt'), 'old.txt after the task').toBe(false);
  return started;
}

const openReview = async (page, name = 'Xem lại thay đổi') => {
  await openWorkTab(page, name);
  await expect(page.getByTestId('review-tab')).toBeVisible();
};
/**
 * The page knows that no task runs: it learns that from the Hub's state, a poll after the task ended, and until then it offers no write (a key pressed in that moment does nothing, and a button
 * waits). "Reject all" is on only when there is something to put back and writing is allowed, so it is the sign. Waiting for it also lets the review settle, so that it is not read again
 * (the end of the run changes its key) between a file being changed behind the page and the click that must find it changed.
 */
const writesAllowed = (page, name = 'Từ chối tất cả') => expect(page.getByRole('button', { name, exact: true })).toBeEnabled();
const openFile = async (page, name) => {
  await page.getByTestId('review-file').filter({ hasText: name }).click();
  await expect(page.getByTestId('review-file-view')).toHaveAttribute('data-path', name);
};
/** The checkpoints the Hub made because a person saved a file (the label is the Hub's), which is what a hunk put back adds. */
const manualCheckpoints = async (app) => (await app.hub.get('/api/studio/checkpoints')).json.filter((checkpoint) => String(checkpoint.label).startsWith('Before manual edit')).length;
const status = (page) => page.getByTestId('review-status');
const shot = async (page, testInfo, name) => testInfo.attach(name, { body: await page.screenshot(), contentType: 'image/png' });

test('a hunk is put back byte for byte, the mark of its neighbour stays, a reload keeps it, and a whole file goes back to what it was', async ({ page, app }, testInfo) => {
  const violations = await watchPolicy(page);
  await runWork(page, app);

  // The turn is over and it changed files: the conversation offers the tab, and the offer opens it.
  await expect(page.getByTestId('review-offer')).toContainText('Tệp đã thay đổi trong cuộc trò chuyện này: 5');
  await page.getByTestId('review-offer').getByRole('button', { name: 'Xem lại thay đổi' }).click();
  await expect(page.getByRole('tab', { name: 'Xem lại thay đổi', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('review-summary')).toHaveText('Tệp: 5 · Đoạn chờ xem lại: 5');
  const files = page.getByTestId('review-file');
  await expect(files).toHaveCount(5);
  await writesAllowed(page);
  expect(await files.evaluateAll((nodes) => nodes.map((node) => `${node.dataset.path}:${node.dataset.status}`))).toEqual(['blob.dat:modified', 'calc.js:modified', 'created.txt:created', 'notes.txt:modified', 'old.txt:deleted']);

  await openFile(page, 'notes.txt');
  const hunks = page.getByTestId('review-hunk');
  await expect(hunks).toHaveCount(3);
  await expect(hunks.nth(1)).toContainText('line 20 CHANGED');
  await shot(page, testInfo, 'review-hunks-vi.png');

  // Accept the first hunk (a mark on this page), then put the second back (a write).
  await page.getByRole('button', { name: 'Chấp nhận đoạn 1/3 của notes.txt', exact: true }).click();
  await expect(hunks.nth(0)).toHaveAttribute('data-state', 'accepted');
  const before = await manualCheckpoints(app);
  await page.getByRole('button', { name: 'Từ chối đoạn 2/3 của notes.txt', exact: true }).click();
  await expect(status(page)).toHaveText('Đã trả lại một đoạn của notes.txt.');
  expect(disk(app, 'notes.txt'), 'only the second change was undone, every line ending is still CRLF').toBe(NOTES_AFTER.replace('line 20 CHANGED', 'line 20'));
  expect(await manualCheckpoints(app), 'one write, one checkpoint to go back to').toBe(before + 1);
  // What is left is still measured against the task\'s baseline, and the first hunk kept its mark.
  await expect(hunks).toHaveCount(2);
  await expect(hunks.nth(0)).toHaveAttribute('data-state', 'accepted');
  await expect(hunks.nth(0)).toContainText('line 03 CHANGED');
  await expect(hunks.nth(1)).toHaveAttribute('data-state', 'pending');
  await expect(hunks.nth(1)).toContainText('line 37 CHANGED');

  // A reload keeps the mark: it is kept for this conversation, this file and this version of the file.
  await page.reload();
  await openReview(page);
  await writesAllowed(page);
  await openFile(page, 'notes.txt');
  await expect(hunks).toHaveCount(2);
  await expect(hunks.nth(0)).toHaveAttribute('data-state', 'accepted');
  await expect(hunks.nth(1)).toHaveAttribute('data-state', 'pending');

  // The whole file back: the bytes it had before the task, and it leaves the list (a file the task left as it found it is not a change).
  await page.getByRole('button', { name: 'Từ chối tệp notes.txt', exact: true }).click();
  await expect(status(page)).toHaveText('Đã trả notes.txt về nội dung cũ.');
  expect(disk(app, 'notes.txt')).toBe(NOTES_BEFORE);
  expect(await manualCheckpoints(app)).toBe(before + 2);
  await expect(page.getByTestId('review-file').filter({ hasText: 'notes.txt' })).toHaveCount(0);
  await expect(page.getByTestId('review-summary')).toHaveText('Tệp: 4 · Đoạn chờ xem lại: 2');
  expect(violations, 'no securitypolicyviolation').toEqual([]);
});

test('a file that changed behind the page is not overwritten: the Hub refuses with 409, nothing is written, and the review is read again', async ({ page, app, browserErrors }) => {
  const violations = await watchPolicy(page);
  await runWork(page, app);
  await openReview(page);
  await writesAllowed(page);
  await openFile(page, 'notes.txt');
  const hunks = page.getByTestId('review-hunk');
  await expect(hunks).toHaveCount(3);
  await page.getByRole('button', { name: 'Chấp nhận đoạn 1/3 của notes.txt', exact: true }).click();
  await expect(hunks.nth(0)).toHaveAttribute('data-state', 'accepted');

  const saves = [];
  page.on('request', (request) => { if (request.url().endsWith('/api/studio/file/save')) saves.push({ body: request.postDataJSON(), response: request.response() }); });
  const reviewed = sha256(NOTES_AFTER);
  const byHand = `${NOTES_AFTER}line 41 by hand\r\n`;
  fs.writeFileSync(path.join(app.project, 'notes.txt'), Buffer.from(byHand, 'latin1'));
  const checkpoints = await manualCheckpoints(app);
  await page.getByRole('button', { name: 'Từ chối đoạn 3/3 của notes.txt', exact: true }).click();

  await expect(status(page)).toHaveText('notes.txt đã thay đổi kể từ khi bạn xem; bản xem lại đã được tải lại. Chưa có gì bị ghi.');
  await expect(status(page)).toHaveAttribute('data-tone', 'warn');
  expect(disk(app, 'notes.txt'), 'the click wrote nothing: the file is what the person wrote').toBe(byHand);
  expect(await manualCheckpoints(app), 'and made no checkpoint').toBe(checkpoints);
  expect(saves).toHaveLength(1);
  expect(saves[0].body.expectedSha, 'the write was guarded by the sha that was reviewed').toBe(reviewed);
  expect((await saves[0].response.then((response) => response?.status()))).toBe(409);
  // The review was read again: the line written by hand is three lines from the last change, so it is part of that hunk, and the mark is gone with the old version of the file.
  await expect(hunks).toHaveCount(3);
  await expect(hunks.nth(2)).toContainText('line 41 by hand');
  await expect(page.locator('[data-testid="review-hunk"][data-state="accepted"]')).toHaveCount(0);

  // The only complaints are about the one 409 that was provoked on purpose: the status, the browser's own line about it in the console, and the Hub's answer (stale_revision). They are taken
  // out of the fixture's list so that anything else still fails the test.
  await browserErrors.flush(page);
  const provoked = browserErrors.errors.splice(0);
  expect(provoked.filter((line) => /^HTTP 409: .*\/api\/studio\/file\/save$/.test(line))).toHaveLength(1);
  expect(provoked.filter((line) => /^Console: Failed to load resource: the server responded with a status of 409/.test(line))).toHaveLength(1);
  expect(provoked.filter((line) => /^API error: .*\/api\/studio\/file\/save: .*stale_revision/.test(line))).toHaveLength(1);
  expect(provoked, `nothing else: ${JSON.stringify(provoked)}`).toHaveLength(3);
  expect(violations).toEqual([]);
});

test('a new file is moved to the undo folder, a deleted file is only read, a binary file is accepted but not undone, an acceptance reaches the Hub, and a receipt leads here', async ({ page, app }, testInfo) => {
  const violations = await watchPolicy(page);
  const started = await runWork(page, app);

  // The receipt of an edit has a link to the file it changed.
  await page.getByTestId('tool-activity-group').first().getByRole('button').first().click();
  await page.getByRole('button', { name: 'Xem lại thay đổi của calc.js', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Xem lại thay đổi', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('review-file-view')).toHaveAttribute('data-path', 'calc.js');
  await expect(page.getByTestId('review-hunk')).toHaveCount(1);
  await writesAllowed(page);
  // Only the five calls that changed a file have a link; the three reads have none.
  await expect(page.getByTestId('tool-receipt')).toHaveCount(8);
  await expect(page.getByTestId('receipt-review-link')).toHaveCount(5);

  // Accept the file: the Hub records that sha for that file.
  await page.getByRole('button', { name: 'Chấp nhận tệp calc.js', exact: true }).click();
  await expect(status(page)).toHaveText('Đã chấp nhận calc.js.');
  await expect.poll(async () => (await app.hub.get(`/api/studio/task-review?taskId=${started.id}`)).json.files.find((file) => file.path === 'calc.js')?.accepted).toBe(true);
  await expect(page.getByTestId('review-file-view').getByText('Đã chấp nhận', { exact: true })).toBeVisible();

  // A new file: its lines are shown, and rejecting it moves it away (nothing is deleted) without making a checkpoint.
  await openFile(page, 'created.txt');
  await expect(page.getByTestId('review-new-file')).toContainText('second line');
  await expect(page.getByTestId('review-hunk')).toHaveCount(0);
  const checkpoints = await manualCheckpoints(app);
  await page.getByRole('button', { name: 'Từ chối tệp created.txt', exact: true }).click();
  await expect(status(page)).toHaveText('Đã chuyển created.txt vào thư mục hoàn tác.');
  expect(exists(app, 'created.txt')).toBe(false);
  const undone = [];
  const walk = (folder) => { for (const entry of fs.readdirSync(folder, { withFileTypes: true })) { const full = path.join(folder, entry.name); if (entry.isDirectory()) walk(full); else if (/[\\/]undo[\\/]/.test(full) && entry.name === 'created.txt') undone.push(full); } };
  walk(app.hub.stateDir);
  expect(undone, 'the file is in the undo folder').toHaveLength(1);
  expect(fs.readFileSync(undone[0], 'utf8')).toBe(CREATED_TEXT);
  expect(await manualCheckpoints(app), 'moving a file away is not a save').toBe(checkpoints);
  await expect(page.getByTestId('review-file').filter({ hasText: 'created.txt' })).toHaveCount(0);

  // A deleted file: it can be read, and nothing is offered, because the Hub can only overwrite a file that is there.
  await openFile(page, 'old.txt');
  await expect(page.getByTestId('review-deleted-file')).toContainText('to be deleted');
  await shot(page, testInfo, 'review-deleted-vi.png');
  await expect(page.getByTestId('review-note')).toHaveAttribute('data-note', 'deleted');
  await expect(page.getByRole('button', { name: 'Từ chối tệp old.txt', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Chấp nhận tệp old.txt', exact: true })).toBeDisabled();
  expect(exists(app, 'old.txt')).toBe(false);

  // A file that is not text any more: the person (or a tool) wrote bytes into it after the task. It is listed, it can be accepted, and nothing can be undone by hunk.
  const bytes = Buffer.from([0x62, 0x69, 0x6e, 0x00, 0x01, 0x02, 0xff, 0x00]);
  fs.writeFileSync(path.join(app.project, 'blob.dat'), bytes);
  await page.getByRole('button', { name: 'Tải lại', exact: true }).click();
  await expect(page.getByTestId('review-file').filter({ hasText: 'blob.dat' })).toHaveAttribute('data-status', 'binary');
  await openFile(page, 'blob.dat');
  await expect(page.getByTestId('review-note')).toHaveAttribute('data-note', 'binary');
  await expect(page.getByTestId('review-note')).toHaveText('Tệp nhị phân: không xem lại từng đoạn được.');
  await expect(page.getByTestId('review-hunk')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Từ chối tệp blob.dat', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Chấp nhận tệp blob.dat', exact: true }).click();
  await expect(status(page)).toHaveText('Đã chấp nhận blob.dat.');
  expect(fs.readFileSync(path.join(app.project, 'blob.dat')).equals(bytes), 'the bytes are untouched').toBe(true);
  expect(violations).toEqual([]);
});

test('the keys move between hunks, accept and put back; accept all and reject all ask first, Cancel and Escape change nothing, and the answer is exact', async ({ page, app }, testInfo) => {
  const violations = await watchPolicy(page);
  await runWork(page, app);
  await openReview(page);
  await writesAllowed(page);
  await openFile(page, 'notes.txt');
  const hunks = page.getByTestId('review-hunk');
  await expect(hunks).toHaveCount(3);

  // j and k move the focus; a accepts; Ctrl+a is the browser's and accepts nothing; r puts the hunk back.
  await hunks.first().focus();
  await page.keyboard.press('j');
  await expect(hunks.nth(1)).toBeFocused();
  await expect(hunks.nth(1)).toHaveAttribute('aria-current', 'true');
  await page.keyboard.press('k');
  await expect(hunks.nth(0)).toBeFocused();
  await page.keyboard.press('Control+a');
  await expect(hunks.nth(0)).toHaveAttribute('data-state', 'pending');
  await page.keyboard.press('a');
  await expect(hunks.nth(0)).toHaveAttribute('data-state', 'accepted');
  await page.keyboard.press('j');
  await page.keyboard.press('j');
  await expect(hunks.nth(2)).toBeFocused();
  await page.keyboard.press('j');
  await expect(hunks.nth(2)).toBeFocused();
  await page.keyboard.press('r');
  await expect(status(page)).toHaveText('Đã trả lại một đoạn của notes.txt.');
  expect(disk(app, 'notes.txt')).toBe(NOTES_AFTER.replace('line 37 CHANGED', 'line 37'));

  // Reject all asks first, with the numbers: notes.txt (2 hunks left), calc.js and blob.dat are rewritten, created.txt is moved away, old.txt stays.
  await page.getByRole('button', { name: 'Từ chối tất cả', exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Từ chối tất cả thay đổi?' });
  await expect(dialog).toBeVisible();
  await shot(page, testInfo, 'review-dialog-vi.png');
  await expect(dialog).toContainText('Tệp được ghi lại: 3 (đoạn được trả lại: 4). Tệp mới được chuyển vào thư mục hoàn tác: 1. Tệp để nguyên: 1.');
  await expect(dialog.getByRole('button', { name: 'Hủy', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: 'Từ chối tất cả', exact: true }).click();
  await dialog.getByRole('button', { name: 'Hủy', exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(disk(app, 'notes.txt'), 'Escape and Cancel changed nothing').toBe(NOTES_AFTER.replace('line 37 CHANGED', 'line 37'));
  expect(disk(app, 'calc.js')).toBe(FIXED_CALC);
  expect(exists(app, 'created.txt')).toBe(true);

  await page.getByRole('button', { name: 'Từ chối tất cả', exact: true }).click();
  await dialog.getByRole('button', { name: 'Từ chối tất cả', exact: true }).click();
  await expect(status(page)).toHaveText('Tệp đã xong: 4. Lỗi: 0. Bỏ qua: 1.');
  expect(disk(app, 'notes.txt')).toBe(NOTES_BEFORE);
  expect(disk(app, 'calc.js')).toBe(BUGGY_CALC);
  expect(disk(app, 'blob.dat')).toBe(BLOB_BEFORE);
  expect(exists(app, 'created.txt')).toBe(false);
  expect(exists(app, 'old.txt'), 'a deleted file is left alone').toBe(false);
  await expect(page.getByTestId('review-file')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Từ chối tất cả', exact: true })).toBeDisabled();
  expect(violations).toEqual([]);
});

test('accept all asks first and marks every hunk without touching a file; the Hub records the files', async ({ page, app }) => {
  const violations = await watchPolicy(page);
  const started = await runWork(page, app);
  await openReview(page);
  await page.getByRole('button', { name: 'Chấp nhận tất cả', exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Chấp nhận tất cả thay đổi?' });
  await expect(dialog).toContainText('Đánh dấu đã xem các đoạn: 5. Ghi nhận chấp nhận tại Hub cho các tệp: 4. Không có tệp nào bị sửa.');
  await dialog.getByRole('button', { name: 'Chấp nhận tất cả', exact: true }).click();
  await expect(status(page)).toHaveText('Tệp đã xong: 4. Lỗi: 0. Bỏ qua: 1.');
  await expect(page.getByTestId('review-summary')).toHaveText('Tệp: 5 · Đoạn chờ xem lại: 0');
  await openFile(page, 'notes.txt');
  await expect(page.locator('[data-testid="review-hunk"][data-state="accepted"]')).toHaveCount(3);
  const review = (await app.hub.get(`/api/studio/task-review?taskId=${started.id}`)).json;
  expect(Object.fromEntries(review.files.map((file) => [file.path, file.accepted]))).toEqual({ 'blob.dat': true, 'calc.js': true, 'created.txt': true, 'notes.txt': true, 'old.txt': false });
  expect(disk(app, 'notes.txt'), 'nothing was written').toBe(NOTES_AFTER);
  expect(violations).toEqual([]);
});

test('the English screen of the tab, its dialog and its notes read English from the first word to the last', async ({ page, app }, testInfo) => {
  const violations = await watchPolicy(page);
  await runWork(page, app);
  await page.evaluate(() => localStorage.setItem('chatmcp:language', 'en'));
  await page.reload();
  await expect(page.getByTestId('review-offer')).toContainText('Files changed in this conversation: 5');
  await expect(page.getByTestId('review-offer').getByRole('button', { name: 'Review changes' })).toBeVisible();
  await openReview(page, 'Review changes');
  await expect(page.getByTestId('review-summary')).toHaveText('Files: 5 · Hunks to review: 5');
  await openFile(page, 'notes.txt');
  await expect(page.getByRole('button', { name: 'Reject hunk 2 of 3 in notes.txt', exact: true })).toBeVisible();
  await shot(page, testInfo, 'review-hunks-en.png');
  await page.getByTestId('review-file').filter({ hasText: 'old.txt' }).click();
  await expect(page.getByTestId('review-note')).toContainText('This file was deleted.');
  await page.getByRole('button', { name: 'Reject all', exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Reject all the changes?' });
  await expect(dialog).toContainText('Files rewritten: 3 (hunks put back: 5). New files moved to the undo folder: 1. Files left as they are: 1.');
  const texts = [await page.getByTestId('review-tab').innerText(), await page.getByTestId('review-offer').innerText(), await dialog.innerText()];
  await page.keyboard.press('Escape');
  for (const text of texts) expect(text, 'no Vietnamese letter on the English screen').not.toMatch(DIACRITICS);
  expect(violations).toEqual([]);
});

// ---- three things the audit of the tab found, each pinned against the real Hub -------------------------------------------------------------------------------------


test('accepting a file counts its hunks as accepted: in the summary, in the list, on the hunks and on their buttons, after a reload, and after one of them is put back', async ({ page, app }) => {
  const violations = await watchPolicy(page);
  await runWork(page, app);
  await openReview(page);
  await writesAllowed(page);
  await expect(page.getByTestId('review-summary')).toHaveText('Tệp: 5 · Đoạn chờ xem lại: 5');
  await openFile(page, 'notes.txt');
  const hunks = page.getByTestId('review-hunk');
  const accepted = page.locator('[data-testid="review-hunk"][data-state="accepted"]');
  await expect(hunks).toHaveCount(3);

  await page.getByRole('button', { name: 'Chấp nhận tệp notes.txt', exact: true }).click();
  await expect(status(page)).toHaveText('Đã chấp nhận notes.txt.');
  const everywhere = async () => {
    await expect(page.getByTestId('review-summary')).toHaveText('Tệp: 5 · Đoạn chờ xem lại: 2');
    await expect(page.getByTestId('review-file').filter({ hasText: 'notes.txt' })).toContainText('Chờ xem lại: 0/3');
    await expect(accepted).toHaveCount(3);
    await expect(page.getByRole('button', { name: 'Chấp nhận đoạn 1/3 của notes.txt', exact: true })).toBeDisabled();
  };
  await everywhere();

  // A page that never made a mark says the same, because it is what the Hub recorded.
  await page.reload();
  await openReview(page);
  await writesAllowed(page);
  await openFile(page, 'notes.txt');
  await everywhere();

  // Putting one hunk back changes the file, so the Hub's record of the old version no longer applies; the hunks that are left stay accepted.
  await page.getByRole('button', { name: 'Từ chối đoạn 2/3 của notes.txt', exact: true }).click();
  await expect(status(page)).toHaveText('Đã trả lại một đoạn của notes.txt.');
  await expect(hunks).toHaveCount(2);
  await expect(accepted).toHaveCount(2);
  await expect(page.getByTestId('review-summary')).toHaveText('Tệp: 5 · Đoạn chờ xem lại: 2');
  expect(violations).toEqual([]);
});

