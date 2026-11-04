// Rolling back against the real Hub and the production build, with a scripted model: undo one step of a task (and only that one), undo the restore, a file that was changed after the step,
// undo all the changes of a task, restore some of the files of a checkpoint, and the rule that nothing is restored while an agent runs. What is asserted is what is on disk, byte for byte
// (a CRLF file, a file with a byte order mark), what the Hub kept (the backup of each restore is a checkpoint) and what the page says. Nothing is intercepted. Every page also listens
// for securitypolicyviolation: the dialog and the buttons must not need a looser Content-Security-Policy than the Hub serves.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, onboard, send, taskByPrompt, openWorkTab, openSettings, closeSettings, setTheme } from './fixtures.mjs';
import { answerApprovals, pendingApprovals, waitFor } from '../../tests/e2e/hub-process.mjs';
import { call, sequence, shaOf } from '../../tests/e2e/scenarios.mjs';

const BOM = '﻿';
const DIACRITICS = /[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/i;
/** The text as the bytes it is written with (UTF-8), one character per byte, so that a lost \r or a lost byte order mark shows. */
const bytesOf = (text) => Buffer.from(text, 'utf8').toString('latin1');
const put = (app, name, text) => fs.writeFileSync(path.join(app.project, name), Buffer.from(text, 'utf8'));
const disk = (app, name) => fs.readFileSync(path.join(app.project, name)).toString('latin1');
const exists = (app, name) => fs.existsSync(path.join(app.project, name));
const dialog = (page) => page.getByRole('alertdialog');
const undoStep = (page, file) => page.getByRole('button', { name: `Hoàn tác bước này: ${file}`, exact: true });
const lastRestore = (page) => page.getByTestId('last-restore');
const checkpoints = async (app) => (await app.hub.get('/api/studio/checkpoints')).json;

/** Every securitypolicyviolation the page sees, across navigations (the binding survives them). */
async function watchPolicy(page) {
  const violations = [];
  await page.exposeFunction('reportPolicyViolation', (line) => violations.push(line));
  await page.addInitScript(() => document.addEventListener('securitypolicyviolation', (event) => window.reportPolicyViolation(`${event.violatedDirective} ${event.blockedURI}`)));
  return violations;
}

/** The task the scripted model carries out (the whole script), answered yes to every approval; it is done when this returns. */
async function runTask(page, app, name, steps, prompt) {
  app.mock.define(name, sequence(steps, { final: 'Xong.' }));
  app.mock.setScenario(name);
  await onboard(page, app);
  app.mock.setScenario(name); // the connection check of the first-run dialog is not part of the script
  await send(page, prompt);
  const started = await taskByPrompt(app, prompt);
  const { task } = await answerApprovals(app.hub, started.id, () => true);
  expect(task.state).toBe('completed');
  // the calls of the turn are one line until it is opened: the receipts, and with them the way back from each step
  const group = page.getByTestId('tool-activity-group').first();
  await expect(group).toBeVisible();
  const toggle = group.getByRole('button').first();
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  return started;
}
const edit = (file, from, to) => [call('read_file', { path: file }), ({ last }) => call('edit_file', { path: file, old_string: from, new_string: to, expected_sha256: shaOf(last) })];
const contrast = (locator) => locator.evaluate((element) => {
  const parse = (color) => { const parts = color.match(/[\d.]+/g).map(Number); return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1]; };
  const luminance = ([r, g, b]) => [r, g, b].map((value) => { const c = value / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }).reduce((sum, c, index) => sum + c * [0.2126, 0.7152, 0.0722][index], 0);
  const layers = [];
  for (let node = element; node; node = node.parentElement) {
    const layer = parse(getComputedStyle(node).backgroundColor);
    if (layer[3] > 0) layers.push(layer);
    if (layer[3] === 1) break;
  }
  let back = [255, 255, 255];
  for (const layer of layers.reverse()) back = back.map((value, index) => layer[index] * layer[3] + value * (1 - layer[3]));
  const fore = luminance(parse(getComputedStyle(element).color));
  const ground = luminance(back);
  return (Math.max(fore, ground) + 0.05) / (Math.min(fore, ground) + 0.05);
});

test('undo one step of a task and only that one; Escape says no, Enter says yes; the restore can be undone, byte for byte', async ({ page, app }, testInfo) => {
  const violations = await watchPolicy(page);
  const ONE = 'alpha\r\nbeta\r\ngamma\r\n';
  const TWO = `${BOM}x line\ny line\n`;
  put(app, 'one.txt', ONE);
  put(app, 'two.txt', TWO);
  await runTask(page, app, 'rollback-two-edits', [...edit('one.txt', 'beta', 'BETA'), ...edit('two.txt', 'y line', 'Y LINE')], 'Sửa one.txt rồi two.txt.');
  const ONE_EDITED = 'alpha\r\nBETA\r\ngamma\r\n';
  const TWO_EDITED = `${BOM}x line\nY LINE\n`;
  expect([disk(app, 'one.txt'), disk(app, 'two.txt')]).toEqual([bytesOf(ONE_EDITED), bytesOf(TWO_EDITED)]);

  // two edits made two checkpoints, one for each, and each receipt has the way back to its own
  const first = undoStep(page, 'one.txt');
  await expect(first).toBeEnabled();
  await expect(undoStep(page, 'two.txt')).toBeEnabled();
  await expect(page.getByTestId('receipt-undo-step')).toHaveCount(2);

  // the question names what will happen; the focus is on the button that answers yes (the step is recoverable), and Escape answers no
  await first.click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).getByRole('heading', { name: 'Hoàn tác bước này?' })).toBeVisible();
  await expect(dialog(page).getByTestId('confirm-details')).toHaveText('Đưa one.txt về như trước');
  await expect(dialog(page).getByRole('note')).toContainText('Hub giữ một bản sao lưu');
  await expect(dialog(page).getByRole('button', { name: 'Hoàn tác bước', exact: true })).toBeFocused();
  await testInfo.attach('undo-step-dialog.png', { body: await page.screenshot(), contentType: 'image/png' });
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();
  await expect(first).toBeFocused();
  expect([disk(app, 'one.txt'), disk(app, 'two.txt')], 'a no changes nothing').toEqual([bytesOf(ONE_EDITED), bytesOf(TWO_EDITED)]);
  expect((await checkpoints(app)).filter((checkpoint) => checkpoint.kind === 'undo'), 'and makes no backup').toHaveLength(0);

  // Enter on the focused answer says yes: only that step goes back, to the byte (the CRLF line endings), and the other file keeps its edit
  await first.click();
  await expect(dialog(page).getByRole('button', { name: 'Hoàn tác bước', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog(page)).toBeHidden();
  await expect(page.getByText('Đã hoàn tác 1 file.')).toBeVisible();
  await expect(first, 'the focus is back on the button that asked, not lost to the page').toBeFocused();
  expect([disk(app, 'one.txt'), disk(app, 'two.txt')]).toEqual([bytesOf(ONE), bytesOf(TWO_EDITED)]);
  const backups = (await checkpoints(app)).filter((checkpoint) => checkpoint.kind === 'undo');
  expect(backups, 'the Hub saved the file before it wrote').toHaveLength(1);
  expect([backups[0].fileCount, backups[0].absentCount, backups[0].taskId]).toEqual([1, 0, null]);

  // the way back from the restore: it is offered where the restore was made from, and puts the edit back exactly
  await openWorkTab(page, 'Xem lại thay đổi');
  await expect(lastRestore(page)).toContainText('Lần khôi phục cuối · số file: 1');
  await expect(page.getByTestId('undo-last-restore')).toBeEnabled();
  await page.getByTestId('undo-last-restore').click();
  await expect(dialog(page).getByRole('heading', { name: 'Hoàn tác lần khôi phục cuối?' })).toBeVisible();
  await expect(dialog(page).getByTestId('confirm-details')).toHaveText('Đưa one.txt về như trước');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('review-status')).toHaveText('Đã hoàn tác 1 file.');
  expect([disk(app, 'one.txt'), disk(app, 'two.txt')], 'the edit is back, byte for byte').toEqual([bytesOf(ONE_EDITED), bytesOf(TWO_EDITED)]);
  // the counters agree: the review lists the two files the task changed, and says so
  await expect(page.getByTestId('review-summary')).toContainText('Tệp: 2');
  await expect(page.getByTestId('review-file')).toHaveCount(2);
  expect(violations).toEqual([]);
});

test('a file changed after the step is listed and left alone, in a step of one file and in a step of two', async ({ page, app }) => {
  const violations = await watchPolicy(page);
  put(app, 'a.txt', 'one\n');
  put(app, 'b.txt', 'two\n');
  put(app, 'c.txt', 'three\n');
  await runTask(page, app, 'rollback-conflicts', [
    call('files_write_batch', { files: [{ path: 'a.txt', content: 'ONE\n', overwrite: true }, { path: 'b.txt', content: 'TWO\n', overwrite: true }] }),
    ...edit('c.txt', 'three', 'THREE'),
  ], 'Sửa a, b và c.');
  await expect(page.getByTestId('receipt-undo-step')).toHaveCount(2);
  await expect(undoStep(page, 'c.txt')).toBeEnabled();

  // c.txt is typed over after the step: undoing the step has nothing it may do, says why, and touches nothing
  put(app, 'c.txt', 'three, and then somebody typed this\n');
  await undoStep(page, 'c.txt').click();
  await expect(page.getByText('Chưa hoàn tác gì: các file sau đã thay đổi sau bước này nên được giữ nguyên: c.txt.')).toBeVisible();
  await expect(dialog(page)).toBeHidden();
  expect(disk(app, 'c.txt')).toBe('three, and then somebody typed this\n');
  expect((await checkpoints(app)).filter((checkpoint) => checkpoint.kind === 'undo')).toHaveLength(0);

  // b.txt too, in the step that wrote a.txt and b.txt together: a.txt goes back, b.txt is named as left alone, and the dialog said so before
  put(app, 'b.txt', 'TWO, edited by hand\n');
  const batch = page.getByTestId('receipt-undo-step').first();
  await batch.click();
  await expect(dialog(page).getByTestId('confirm-details')).toHaveText('Đưa a.txt về như trước');
  await expect(dialog(page).getByRole('note').filter({ hasText: 'b.txt' })).toContainText('Đã thay đổi sau đó nên được giữ nguyên (1): b.txt.');
  await page.keyboard.press('Enter');
  await expect(page.getByText(/Đã hoàn tác 1 file\..*b\.txt/)).toBeVisible();
  expect([disk(app, 'a.txt'), disk(app, 'b.txt'), disk(app, 'c.txt')]).toEqual(['one\n', 'TWO, edited by hand\n', 'three, and then somebody typed this\n']);
  const backups = (await checkpoints(app)).filter((checkpoint) => checkpoint.kind === 'undo');
  expect(backups.map((checkpoint) => checkpoint.fileCount), 'the backup holds only what was restored').toEqual([1]);
  expect(violations).toEqual([]);
});

test('the step that created a file is undone by removing it, and the restore puts it back with the bytes it had', async ({ page, app }) => {
  const MADE = `${BOM}made\r\nby the model\r\n`;
  await runTask(page, app, 'rollback-created', [call('write_file', { path: 'made.txt', content: MADE })], 'Tạo made.txt.');
  expect(disk(app, 'made.txt')).toBe(bytesOf(MADE));
  await expect(undoStep(page, 'made.txt')).toBeEnabled();
  await undoStep(page, 'made.txt').click();
  await expect(dialog(page).getByTestId('confirm-details')).toHaveText('Xóa made.txt (do bước này tạo ra)');
  await page.keyboard.press('Enter');
  await expect(page.getByText('Đã hoàn tác 1 file.')).toBeVisible();
  expect(exists(app, 'made.txt'), 'the file the step created is gone').toBe(false);
  const [backup] = (await checkpoints(app)).filter((checkpoint) => checkpoint.kind === 'undo');
  expect([backup.fileCount, backup.absentCount], 'and was saved first').toEqual([1, 0]);

  await openWorkTab(page, 'Xem lại thay đổi');
  await page.getByTestId('undo-last-restore').click();
  await expect(dialog(page).getByTestId('confirm-details')).toHaveText('Khôi phục made.txt (đã bị xóa)');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('review-status')).toHaveText('Đã hoàn tác 1 file.');
  expect(disk(app, 'made.txt'), 'back with a BOM and its CRLF line endings').toBe(bytesOf(MADE));
});

test('undo all the changes of a task: an edit, a new file and a deleted one go back in one restore, which one undo puts back; the danger dialog starts on Cancel', async ({ page, app }, testInfo) => {
  const violations = await watchPolicy(page);
  put(app, 'one.txt', 'alpha\r\nbeta\r\n');
  put(app, 'old.txt', `${BOM}to be deleted\n`);
  await runTask(page, app, 'rollback-task', [...edit('one.txt', 'beta', 'BETA'), call('write_file', { path: 'new.txt', content: 'new\n' }), call('delete_path', { path: 'old.txt' })], 'Sửa one.txt, tạo new.txt, xóa old.txt.');
  const AFTER = [disk(app, 'one.txt'), exists(app, 'new.txt'), exists(app, 'old.txt')];
  expect(AFTER).toEqual([bytesOf('alpha\r\nBETA\r\n'), true, false]);
  await openWorkTab(page, 'Xem lại thay đổi');
  await expect(page.getByTestId('review-summary')).toContainText('Tệp: 3');
  await expect(page.getByTestId('review-file')).toHaveCount(3);
  await expect(page.getByTestId('review-undo-all')).toBeEnabled();

  await page.getByTestId('review-undo-all').click();
  await expect(dialog(page).getByRole('heading', { name: 'Hoàn tác mọi thay đổi của nhiệm vụ này?' })).toBeVisible();
  await expect(dialog(page).getByTestId('confirm-details').locator('li')).toHaveText(['Xóa new.txt (do bước này tạo ra)', 'Khôi phục old.txt (đã bị xóa)', 'Đưa one.txt về như trước']);
  await testInfo.attach('undo-all-dialog.png', { body: await page.screenshot(), contentType: 'image/png' });
  // it destroys the task's work, so the focus starts on Cancel: Enter there says no, Tab reaches the answer yes
  await expect(dialog(page).getByRole('button', { name: 'Hủy', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog(page)).toBeHidden();
  expect([disk(app, 'one.txt'), exists(app, 'new.txt'), exists(app, 'old.txt')], 'Enter on Cancel changed nothing').toEqual(AFTER);
  await page.getByTestId('review-undo-all').click();
  await expect(dialog(page).getByRole('button', { name: 'Hủy', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dialog(page).getByRole('button', { name: 'Hoàn tác tất cả', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('review-status')).toHaveText('Đã hoàn tác 3 file.');
  expect([disk(app, 'one.txt'), exists(app, 'new.txt'), disk(app, 'old.txt')]).toEqual([bytesOf('alpha\r\nbeta\r\n'), false, bytesOf(`${BOM}to be deleted\n`)]);
  // nothing is left to review, and the page agrees with itself
  await expect(page.getByTestId('review-file')).toHaveCount(0);
  await expect(page.getByTestId('review-undo-all')).toBeDisabled();
  // the button that asked has nothing left to do and is disabled: the focus goes to the panel it was in, not to the page
  await expect(page.getByTestId('review-tab')).toBeFocused();
  expect((await checkpoints(app)).filter((checkpoint) => checkpoint.kind === 'undo'), 'one backup for the three files').toHaveLength(1);

  // one click puts the three back
  await expect(lastRestore(page)).toContainText('số file: 3');
  await page.getByTestId('undo-last-restore').click();
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press('Enter');
  await expect.poll(() => [disk(app, 'one.txt'), exists(app, 'new.txt'), exists(app, 'old.txt')], { message: 'everything is as the task left it' }).toEqual(AFTER);
  await expect(page.getByTestId('review-status')).toHaveText('Đã hoàn tác 3 file.');
  await expect(page.getByTestId('review-file')).toHaveCount(3);
  await expect(page.getByTestId('review-summary')).toContainText('Tệp: 3');
  expect(violations).toEqual([]);
});

test('restore some of the files of a checkpoint; a snapshot before a command is called incomplete; the backup of a restore is a checkpoint that can be restored', async ({ page, app }, testInfo) => {
  const violations = await watchPolicy(page);
  put(app, 'a.txt', 'a one\n');
  put(app, 'b.txt', 'b one\n');
  put(app, 'three.md', 'original three\n');
  put(app, 'touch.js', "require('fs').writeFileSync('three.md', 'rewritten by a command\\n');\n");
  await runTask(page, app, 'rollback-panel', [
    call('files_write_batch', { files: [{ path: 'a.txt', content: 'a TWO\n', overwrite: true }, { path: 'b.txt', content: 'b TWO\n', overwrite: true }] }),
    call('run_command', { command: 'node touch.js', description: 'Rewrite three.md' }),
  ], 'Sửa a và b, rồi chạy một lệnh.');
  expect([disk(app, 'a.txt'), disk(app, 'b.txt'), disk(app, 'three.md')]).toEqual(['a TWO\n', 'b TWO\n', 'rewritten by a command\n']);

  await openWorkTab(page, 'Thay đổi');
  const rows = page.getByTestId('checkpoint-row');
  await expect(rows.first()).toBeVisible();
  // newest first: the snapshot before the command (incomplete), then the batch
  const command = rows.filter({ has: page.getByTestId('checkpoint-incomplete-badge') }).first();
  await expect(command.getByTestId('checkpoint-incomplete-badge')).toHaveText('Chưa đầy đủ');
  const batchRow = rows.filter({ hasText: 'files_write_batch' }).first();
  await expect(batchRow.getByTestId('checkpoint-incomplete-badge')).toHaveCount(0);
  await expect(batchRow).toContainText('file: 2');

  // the batch opened: both files differ; the diff of one is shown; one is unticked and only the other goes back
  const card = batchRow.locator('xpath=ancestor::div[contains(@class,"rounded-xl")][1]');
  await batchRow.getByTestId('checkpoint-toggle').click();
  const files = card.getByTestId('checkpoint-file');
  await expect(files).toHaveCount(2);
  await expect(files.nth(0)).toContainText('a.txt');
  await expect(files.nth(0).getByTestId('checkpoint-file-status')).toHaveText('Đã khác');
  await files.nth(0).getByTestId('checkpoint-diff-toggle').click();
  await expect(card.getByRole('region', { name: 'Thay đổi từ sau checkpoint: a.txt' })).toContainText('+a TWO');
  await testInfo.attach('checkpoint-files.png', { body: await page.screenshot(), contentType: 'image/png' });
  await card.getByRole('checkbox', { name: 'Chọn b.txt' }).uncheck();
  const restoreSelected = card.getByTestId('checkpoint-restore-selected');
  await expect(restoreSelected).toHaveText('Khôi phục đã chọn (1)');
  await restoreSelected.click();
  await expect(dialog(page).getByTestId('confirm-details')).toHaveText('Đưa a.txt về như trước');
  await expect(dialog(page).getByRole('button', { name: 'Hủy', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect.poll(() => [disk(app, 'a.txt'), disk(app, 'b.txt')], { message: 'only the file that stayed ticked went back' }).toEqual(['a one\n', 'b TWO\n']);
  await expect(page.getByText('Đã hoàn tác 1 file.').first()).toBeVisible();

  // the list now has the backup, marked as one; it holds the file as it was before the restore
  const backup = rows.filter({ has: page.getByTestId('checkpoint-undo-badge') }).first();
  await expect(backup.getByTestId('checkpoint-undo-badge')).toHaveText('Bản sao lưu để hoàn tác');
  await expect(backup.getByTestId('checkpoint-incomplete-badge')).toHaveCount(0);
  await expect(lastRestore(page)).toContainText('số file: 1');

  // the snapshot before the command brings back the one file the command changed (and says it is incomplete before it does)
  const snapshot = command.locator('xpath=ancestor::div[contains(@class,"rounded-xl")][1]');
  await command.getByTestId('checkpoint-toggle').click();
  await expect(snapshot.getByTestId('checkpoint-file').filter({ hasText: 'three.md' }).getByTestId('checkpoint-file-status')).toHaveText('Đã khác');
  await snapshot.getByTestId('checkpoint-restore-selected').click();
  await expect(dialog(page).getByTestId('confirm-details')).toHaveText('Đưa three.md về như trước');
  await expect(dialog(page).getByRole('note').first()).toContainText('Chưa đầy đủ');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect.poll(() => disk(app, 'three.md')).toBe('original three\n');
  expect(violations).toEqual([]);
});

test('nothing can be undone while an agent runs: the buttons wait and say why, and the Hub refuses with 409', async ({ page, app }) => {
  put(app, 'one.txt', 'alpha\n');
  await runTask(page, app, 'rollback-first', edit('one.txt', 'alpha', 'ALPHA'), 'Sửa one.txt.');
  await expect(undoStep(page, 'one.txt')).toBeEnabled();
  const checkpoint = (await checkpoints(app)).find((item) => item.kind !== 'undo');

  // a second task asks to write a file and nobody answers: the agent is running
  app.mock.define('rollback-second', sequence([call('write_file', { path: 'second.txt', content: 'x\n' })], { final: 'Xong.' }));
  app.mock.setScenario('rollback-second');
  await send(page, 'Tạo second.txt.');
  await waitFor(async () => (await pendingApprovals(app.hub)).length > 0);
  await expect(undoStep(page, 'one.txt')).toBeDisabled();
  await expect(undoStep(page, 'one.txt')).toHaveAttribute('title', 'Đang có agent chạy. Chờ agent dừng rồi hãy hoàn tác.');
  await openWorkTab(page, 'Thay đổi');
  await expect(page.getByTestId('checkpoints-blocked')).toHaveText('Đang có agent chạy. Chờ agent dừng rồi hãy khôi phục file.');
  await expect(page.getByTestId('checkpoint-restore-all').first()).toBeDisabled();
  const refused = await app.hub.request('POST', '/api/studio/restore-checkpoint', { checkpointId: checkpoint.id, expectedShas: { 'one.txt': '0'.repeat(64) } });
  expect([refused.status, refused.json.code]).toEqual([409, 'task_in_progress']);
  expect(disk(app, 'one.txt')).toBe('ALPHA\n');

  // the agent stops (the approval is refused): the buttons come back
  const [request] = await pendingApprovals(app.hub);
  await app.hub.post('/api/studio/permissions/decide', { id: request.id, approved: false });
  await waitFor(async () => !(await app.hub.state()).agent.activeTaskId);
  await expect(page.getByTestId('checkpoint-restore-all').first()).toBeEnabled();
});

test('in English and in both themes the new screens read in one language and keep a readable contrast', async ({ page, app }, testInfo) => {
  put(app, 'one.txt', 'alpha\nbeta\n');
  await runTask(page, app, 'rollback-english', [...edit('one.txt', 'beta', 'BETA'), call('write_file', { path: 'new.txt', content: 'new\n' })], 'Sửa one.txt, tạo new.txt.');
  await expect(undoStep(page, 'one.txt')).toBeEnabled();
  // the dialog of a step, in both themes (the page behind an open dialog cannot be clicked, so each theme opens it again)
  for (const theme of ['dark', 'light']) {
    await setTheme(page, theme);
    await undoStep(page, 'one.txt').click();
    await expect(dialog(page)).toBeVisible();
    for (const locator of [dialog(page).getByRole('heading'), dialog(page).getByTestId('confirm-details'), dialog(page).getByRole('note').first(), dialog(page).getByRole('button', { name: 'Hoàn tác bước', exact: true }), dialog(page).getByRole('button', { name: 'Hủy', exact: true })]) {
      expect(await contrast(locator), `${theme}: ${await locator.innerText()}`).toBeGreaterThanOrEqual(4.5);
    }
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeHidden();
  }
  // a restore leaves the bar to measure
  await undoStep(page, 'one.txt').click();
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Đã hoàn tác 1 file.')).toBeVisible();
  await openWorkTab(page, 'Xem lại thay đổi');
  for (const theme of ['light', 'dark']) {
    await setTheme(page, theme);
    // the colours of a button move for 150 ms when the theme changes: measured once they have settled
    for (const id of ['review-undo-all', 'undo-last-restore']) await expect.poll(() => contrast(page.getByTestId(id)), { message: `${theme}: ${id}` }).toBeGreaterThanOrEqual(4.5);
    await expect.poll(() => contrast(lastRestore(page).locator('p')), { message: `${theme}: the bar` }).toBeGreaterThanOrEqual(4.5);
  }

  // the same screens in English: not a Vietnamese letter on them, in the receipt, the dialog, the bar and the checkpoints
  const settings = await openSettings(page, 'Giao diện & ngôn ngữ');
  await settings.getByRole('button', { name: 'English' }).click();
  await closeSettings(page);
  await expect(page.getByTestId('review-undo-all')).toHaveText('Undo all changes');
  await expect(lastRestore(page)).toContainText('Last restore · files: 1');
  const english = async (locator, label) => expect(DIACRITICS.test(await locator.innerText()), `${label} reads English`).toBe(false);
  await english(lastRestore(page), 'the bar');
  await page.getByTestId('review-undo-all').click();
  await expect(dialog(page).getByRole('heading', { name: 'Undo all changes of this task?' })).toBeVisible();
  await english(dialog(page), 'the undo-all dialog');
  await expect(dialog(page).getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await testInfo.attach('undo-all-dialog-en.png', { body: await page.screenshot(), contentType: 'image/png' });
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();
  await openWorkTab(page, 'Changes');
  await expect(page.getByTestId('checkpoint-toggle').first()).toHaveText('Show files');
  await english(page.getByTestId('checkpoint-row').first(), 'the checkpoint row');
  await page.getByTestId('checkpoint-toggle').first().click();
  await english(page.getByTestId('checkpoint-files'), 'the files of a checkpoint');
});
