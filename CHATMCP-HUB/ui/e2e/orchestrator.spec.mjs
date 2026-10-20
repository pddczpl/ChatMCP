import { test, expect, onboard, send, taskByPrompt, openWorkTab, openSettings, closeSettings } from './fixtures.mjs';
import { say, call } from '../../tests/e2e/scenarios.mjs';
import { setMode, waitForState } from '../../tests/e2e/hub-process.mjs';
import { git } from '../../tests/e2e/fixtures.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';

// The Agents tab against the real Hub and the scripted model: the owner hands work out and reads what comes back.
// The scripted model answers "OK" to a request that offers no tools, and writes one file when it is a coding worker; that is enough to see
// the whole path from the form to the diff, and to see what must never happen: an AI saying "all tests pass" turning anything green.

const NOTE = 'AGENT-NOTE.md';
const CLAIM = 'I created AGENT-NOTE.md. All tests pass and the task is complete.';
/** The tone colours of src/index.css as the browser computes them, so that a test does not repeat hex values. */
const WARNING = { dark: 'rgb(243, 185, 77)', light: 'rgb(154, 90, 0)' };
const SUCCESS = { dark: 'rgb(63, 217, 155)', light: 'rgb(11, 122, 82)' };
const VIETNAMESE = /[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/i;

/** A coding worker that writes one new file and then says it is done, claiming tests it never ran. */
function defineNoteWorker(mock, { onTools = () => {} } = {}) {
  mock.define('note-worker', (ctx) => {
    if (!ctx.prompt.startsWith('TASK: ')) return say('Xong.');
    if (ctx.turn === 0) {
      onTools(ctx.tools);
      const args = { path: NOTE, content: '# Agent note\n\nWritten by a scripted worker.\u200B\n' };
      // the worker is offered the tools its goal selects; whatever it is offered, the file is written through a tool the Hub runs
      return ctx.tools.includes('write_file') ? call('write_file', args) : call('mcp_call', { name: 'local.write_file', arguments_json: JSON.stringify(args) });
    }
    return say(CLAIM);
  });
  mock.setScenario('note-worker');
}

/** A screenshot with animations finished (a theme change or a dialog closing is still moving for a moment). */
async function shot(page, testInfo, name, target = page) {
  await page.waitForTimeout(250);
  await target.screenshot({ path: testInfo.outputPath(`${name}.png`), animations: 'disabled' });
}

/**
 * A panel of the English screen holds no Vietnamese: not in its text, and not in a title, an accessible label or a placeholder either (those
 * never show up in the text of a panel, and they are where a string that was forgotten is most likely to hide).
 */
async function expectEnglishOnly(panel, label) {
  expect(await panel.innerText(), `${label} still holds Vietnamese`).not.toMatch(VIETNAMESE);
  const attributes = await panel.evaluate((root) => [...root.querySelectorAll('[title],[aria-label],[placeholder]')]
    .map((element) => ['title', 'aria-label', 'placeholder'].map((name) => element.getAttribute(name)).filter(Boolean).join(' | ')));
  expect(attributes.filter((text) => VIETNAMESE.test(text)), `${label}: a title, a label or a placeholder still holds Vietnamese`).toEqual([]);
}

async function openAgents(page, section) {
  await openWorkTab(page, 'Tác nhân');
  if (section) {
    const tab = page.getByRole('tab', { name: section, exact: true });
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
  }
}

/** The main checkout after a delegated run: the same commit, nothing changed, no file the worker wrote. */
async function expectCheckoutUntouched(app, head) {
  expect(git(app.project, app.scratch, ['rev-parse', 'HEAD']).stdout).toBe(head);
  expect(git(app.project, app.scratch, ['status', '--porcelain']).stdout).toBe('');
  await expect(fs.stat(path.join(app.project, NOTE))).rejects.toThrow();
}

test('a coding worker: plan, start, read the diff, merge on a new branch — and the AI’s claim is never taken for proof', async ({ page, app }, testInfo) => {
  test.setTimeout(240_000);
  let offered = [];
  defineNoteWorker(app.mock, { onTools: (tools) => { offered = tools; } });
  await onboard(page, app);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const head = git(app.project, app.scratch, ['rev-parse', 'HEAD']).stdout;
  expect(git(app.project, app.scratch, ['status', '--porcelain']).stdout, 'the project is clean after onboarding, which the Hub requires').toBe('');

  await openAgents(page, 'Sửa mã');
  const coding = page.getByTestId('coding-agents');
  await expect(page.getByRole('tabpanel', { name: 'Sửa mã' })).toBeVisible();
  await expect(coding.getByText('Chưa có lần sửa mã nào')).toBeVisible();

  // Review mode (what onboarding chose): the Hub would answer 403, so the tab says so and points at the setting
  await expect(coding.getByTestId('coding-needs-autonomous')).toContainText('Review');
  await expect(coding.getByRole('button', { name: 'Bắt đầu sửa mã', exact: true })).toBeDisabled();
  await shot(page, testInfo, 'coding-1-needs-autonomous');
  await coding.getByRole('button', { name: 'Mở cài đặt quyền' }).click();
  const settings = page.getByRole('dialog', { name: 'Cài đặt' });
  await expect(settings.getByRole('navigation', { name: 'Các mục cài đặt' }).locator('[aria-current="page"]')).toHaveText('Quyền & thực thi');
  await settings.getByRole('button', { name: /Tự động \(Autonomous\)/ }).click();
  await expect.poll(async () => (await app.hub.state()).studio.permissions.mode).toBe('autonomous');
  await closeSettings(page);
  await expect(coding.getByTestId('coding-needs-autonomous')).toHaveCount(0);

  // plan from a goal (no model request: the plan is read from the owner's own words), then edit nothing and start
  await coding.getByRole('textbox', { name: 'Chia công việc từ một yêu cầu' }).fill('Add a file named AGENT-NOTE.md that explains this project in two sentences');
  const requestsBefore = app.mock.state.requests.length;
  await coding.getByRole('button', { name: 'Đề xuất chia công việc', exact: true }).click();
  await expect(coding.getByRole('status').filter({ hasText: 'Bản xem trước gồm 1 công việc' })).toBeVisible();
  expect(app.mock.state.requests.length, 'planning without "let the AI propose" asks the model nothing').toBe(requestsBefore);
  await expect(coding.getByRole('textbox', { name: 'Công việc 1', exact: true })).toHaveValue(/AGENT-NOTE\.md/);

  await coding.getByRole('button', { name: 'Bắt đầu sửa mã', exact: true }).click();
  const ask = page.getByRole('alertdialog', { name: /Cho phép AI sửa tệp/ });
  await expect(ask).toBeVisible();
  await expect(ask).toContainText('AGENT-NOTE.md');
  await expect(ask.getByRole('button', { name: 'Để sau' })).toBeFocused();
  await shot(page, testInfo, 'coding-2-confirm');
  await ask.getByRole('button', { name: 'Cho phép và bắt đầu' }).click();
  // the button that asked has turned into "working": focus goes to the section's heading and not to nowhere
  await expect(ask).toBeHidden();
  await expect(coding.getByRole('heading', { name: 'Nhờ AI sửa mã nguồn' })).toBeFocused();

  // the end of a run is announced as plain information ("waiting for your review"), never as a success: it is not a verdict on the work
  const ended = page.getByRole('status').filter({ hasText: 'Chờ bạn duyệt' });
  await expect(ended).toBeVisible({ timeout: 120_000 });
  await expect(ended).toHaveClass(/border-l-primary/);
  await expect(ended).not.toHaveClass(/border-l-success/);

  // the worker's card appears while it works, and ends waiting for review
  const card = coding.getByTestId('coding-worker').filter({ hasText: 'task-1' });
  await expect(card).toBeVisible({ timeout: 90_000 });
  await expect(card).toHaveAttribute('data-kind', 'unverified', { timeout: 120_000 });
  expect(offered.length, 'the scripted worker was asked to act').toBeGreaterThan(0);

  // what the Hub recorded versus what the AI said
  const record = (await app.hub.get('/api/studio/coding')).json.jobs.at(-1);
  expect(record.status).toBe('ready_for_review');
  expect(record.workers[0]).toMatchObject({ id: 'task-1', status: 'ready_for_review', verifyRequired: false });
  expect(record.workers[0].verificationAttempts ?? []).toEqual([]);
  expect(record.workers[0].changedFiles).toEqual([NOTE]);
  const proof = card.getByTestId('agent-proof');
  await expect(proof).toContainText('AI báo xong · Hub chưa xác minh');
  await expect(proof).toHaveAttribute('data-tone', 'warning');
  await expect(proof.getByText('AI báo xong · Hub chưa xác minh')).toHaveCSS('color', WARNING.dark);
  const report = card.getByTestId('ai-report');
  await expect(report).toContainText('Báo cáo của AI');
  await expect(report).toContainText('All tests pass');
  await expect(coding.locator('[data-tone="success"]')).toHaveCount(0);
  await expect(card.getByText('Hub đã xác minh', { exact: false })).toHaveCount(0);
  await card.scrollIntoViewIfNeeded();
  await shot(page, testInfo, 'coding-3-reported-not-proven');

  // publishing is locked until the diff has been read
  const publish = card.getByRole('button', { name: 'Tạo bản nháp trên GitHub' });
  await expect(publish).toBeDisabled();
  await expect(card.getByText('Đọc thay đổi trước khi tạo bản nháp.')).toBeVisible();
  await expect(coding.getByRole('button', { name: 'Gộp các công việc đã chọn', exact: true })).toBeDisabled();
  await card.getByRole('button', { name: 'Xem thay đổi', exact: true }).click();
  const diff = card.getByRole('region', { name: /^Thay đổi của chatmcp\/coder\// });
  await expect(diff).toContainText(`+++ b/${NOTE}`);
  await expect(diff).toContainText('+# Agent note');
  await expect(diff, 'opening the review moves the reader into it').toBeFocused();
  // a character nobody can see is made visible, and the diff says so
  await expect(diff).toContainText('Written by a scripted worker.‹U+200B›');
  await expect(diff).toContainText('ký tự ẩn hoặc ký tự đổi chiều chữ');
  await expect(publish).toBeEnabled();
  // closing the review hands focus back to the button that opened it, and what was read stays read
  await diff.getByRole('button', { name: 'Đóng', exact: true }).click();
  await expect(diff).toBeHidden();
  await expect(card.getByRole('button', { name: 'Xem thay đổi', exact: true })).toBeFocused();
  await expect(publish).toBeEnabled();
  await card.getByRole('button', { name: 'Xem thay đổi', exact: true }).click();
  await expect(diff).toContainText(`+++ b/${NOTE}`);
  await card.getByRole('button', { name: 'Xem nội dung tệp' }).click();
  const files = card.getByTestId('coding-context-preview');
  await expect(files).toContainText(NOTE);
  await expect(files).toContainText('Written by a scripted worker.');
  await expect(files).toContainText('‹U+200B›');
  await expect(files).toContainText('không tự gửi tới AI');
  await expect(files).toBeFocused();
  await diff.scrollIntoViewIfNeeded();
  await shot(page, testInfo, 'coding-4-diff');

  // merging asks for its phrase, exactly
  const merge = coding.getByRole('button', { name: 'Gộp các công việc đã chọn', exact: true });
  await expect(merge).toBeEnabled();
  await merge.click();
  const phrase = page.getByRole('alertdialog', { name: 'Gộp các công việc đã chọn?' });
  const confirm = phrase.getByRole('button', { name: 'Xác nhận', exact: true });
  const box = phrase.getByRole('textbox', { name: 'Nhập đúng cụm từ để xác nhận' });
  await expect(box).toBeFocused();
  await expect(confirm).toBeDisabled();
  await box.fill('integrate worktrees');
  await expect(confirm).toBeDisabled();
  await box.fill('INTEGRATE WORKTREES');
  await expect(confirm).toBeEnabled();
  await confirm.click();
  // "merge" is off once there is a merge: focus goes to the heading of the result, not to nowhere
  await expect(coding.locator('#coding-result-title')).toBeFocused();
  const integration = coding.getByTestId('coding-integration');
  await expect(integration).toContainText('Bản gộp: Chờ bạn duyệt', { timeout: 60_000 });
  await expect(integration).toContainText('chatmcp/integration/');
  await expect(merge, 'one merge per run').toBeDisabled();
  expect((await app.hub.get('/api/studio/coding')).json.jobs.at(-1).integration.status).toBe('ready_for_review');

  // the merge can be read, and publishing it asks for its own phrase (never sent here: this project has no GitHub remote)
  const publishMerge = integration.getByRole('button', { name: 'Đưa bản gộp lên GitHub' });
  await expect(publishMerge).toBeDisabled();
  await integration.getByRole('button', { name: 'Xem thay đổi của bản gộp' }).click();
  await expect(integration.getByRole('region', { name: /^Thay đổi của chatmcp\/integration\// })).toContainText(`+++ b/${NOTE}`);
  await expect(publishMerge).toBeEnabled();
  await publishMerge.click();
  const publishAsk = page.getByRole('alertdialog', { name: 'Đưa bản gộp lên GitHub?' });
  await expect(publishAsk.getByRole('button', { name: 'Xác nhận', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(publishAsk).toBeHidden();
  await expect(publishMerge, 'focus returns to the button that asked').toBeFocused();
  await integration.scrollIntoViewIfNeeded();
  await shot(page, testInfo, 'coding-5-merged');

  // all of it happened on branches; the owner’s checkout is as it was
  await expectCheckoutUntouched(app, head);
  const branches = git(app.project, app.scratch, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']).stdout.split('\n');
  expect(branches.some((name) => name.startsWith('chatmcp/coder/'))).toBe(true);
  expect(branches.some((name) => name.startsWith('chatmcp/integration/'))).toBe(true);
  expect(git(app.project, app.scratch, ['branch', '--show-current']).stdout).toBe('main');
});

test('a run in progress is the Hub’s state, not the page’s: another tab and back keeps start off, and Stop stops it', async ({ page, app }) => {
  test.setTimeout(180_000);
  app.mock.define('slow-worker', async (ctx) => {
    if (!ctx.prompt.startsWith('TASK: ')) return say('Xong.');
    if (ctx.turn === 0) {
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      const args = { path: NOTE, content: '# Agent note\n' };
      return ctx.tools.includes('write_file') ? call('write_file', args) : call('mcp_call', { name: 'local.write_file', arguments_json: JSON.stringify(args) });
    }
    return say(CLAIM);
  });
  app.mock.setScenario('slow-worker');
  await onboard(page, app);
  await setMode(app.hub, 'autonomous');
  await page.setViewportSize({ width: 1440, height: 1000 });
  const head = git(app.project, app.scratch, ['rev-parse', 'HEAD']).stdout;
  await openAgents(page, 'Sửa mã');
  const coding = page.getByTestId('coding-agents');
  await coding.getByRole('textbox', { name: 'Công việc 1', exact: true }).fill('Add a file named AGENT-NOTE.md');
  await coding.getByRole('button', { name: 'Bắt đầu sửa mã', exact: true }).click();
  await page.getByRole('alertdialog', { name: /Cho phép AI sửa tệp/ }).getByRole('button', { name: 'Cho phép và bắt đầu' }).click();
  await expect(coding.getByRole('button', { name: 'Đang sửa mã…' })).toBeDisabled();
  await expect(coding.getByRole('button', { name: 'Dừng sửa mã' })).toBeEnabled();
  await expect.poll(async () => (await app.hub.get('/api/studio/coding')).json.activeRunId).not.toBeNull();

  // leaving the tab drops the page’s own state; what the Hub says is all that is left, and it is enough
  await openWorkTab(page, 'Thay đổi');
  await openAgents(page, 'Sửa mã');
  await expect(coding.getByRole('button', { name: 'Đang sửa mã…' })).toBeDisabled();
  await expect(coding.getByRole('button', { name: 'Dừng sửa mã' })).toBeEnabled();
  await expect(coding.getByText('Đang có một lần sửa mã hoặc gộp thay đổi chạy', { exact: false })).toBeVisible();
  await expect(coding.getByTestId('coding-worker').first()).toHaveAttribute('data-kind', 'working');
  await expect(coding.getByRole('textbox', { name: 'Chia công việc từ một yêu cầu' })).toBeDisabled();

  // the other section knows too: the Hub would refuse an analysis while a code edit is running, so the tab says so
  await page.getByRole('tab', { name: 'Nhóm trợ lý', exact: true }).click();
  const groups = page.getByTestId('agent-groups');
  await groups.getByRole('textbox', { name: 'Yêu cầu của bạn' }).fill('Why is the page slow?');
  await expect(groups.getByTestId('analysis-block-coding-running')).toContainText('Đang có một lần sửa mã chạy');
  await expect(groups.getByRole('button', { name: 'Bắt đầu phân tích', exact: true })).toBeDisabled();
  await page.getByRole('tab', { name: 'Sửa mã', exact: true }).click();

  await coding.getByRole('button', { name: 'Dừng sửa mã' }).click();
  await expect.poll(async () => (await app.hub.get('/api/studio/coding')).json.jobs.at(-1)?.status, { timeout: 60_000 }).toBe('cancelled');
  await expect(coding.getByRole('button', { name: 'Bắt đầu sửa mã', exact: true })).toBeEnabled({ timeout: 30_000 });
  await expect(coding.getByTestId('coding-result')).toHaveAttribute('data-status', 'cancelled');
  await expect(coding.getByTestId('coding-worker').first()).not.toHaveAttribute('data-tone', 'success');
  // a worker of a run that was stopped is stopped; nothing keeps spinning for work that will never finish
  await expect(coding.getByTestId('coding-worker').first()).toHaveAttribute('data-kind', 'stopped');
  await expect(coding.getByTestId('coding-worker').first().getByTestId('agent-proof')).toContainText('Đã dừng');
  // and the analysis can be started again now that nothing else is running
  await page.getByRole('tab', { name: 'Nhóm trợ lý', exact: true }).click();
  await expect(groups.getByTestId('analysis-block-coding-running')).toHaveCount(0);
  await expect(groups.getByRole('button', { name: 'Bắt đầu phân tích', exact: true })).toBeEnabled();
  await expectCheckoutUntouched(app, head);
});

test('a stopped run keeps the worker that had finished, but the Hub merges only a finished run: the tab says so beside the button, and the Hub agrees', async ({ page, app }) => {
  test.setTimeout(180_000);
  app.mock.define('mixed-worker', async (ctx) => {
    if (!ctx.prompt.startsWith('TASK: ')) return say('Xong.');
    const slow = ctx.prompt.includes('SLOW-ONE');
    if (ctx.turn === 0) {
      if (slow) await new Promise((resolve) => setTimeout(resolve, 15_000));
      const args = { path: slow ? 'SLOW.md' : 'FAST.md', content: '# A note\n' };
      return ctx.tools.includes('write_file') ? call('write_file', args) : call('mcp_call', { name: 'local.write_file', arguments_json: JSON.stringify(args) });
    }
    return say(CLAIM);
  });
  app.mock.setScenario('mixed-worker');
  await onboard(page, app);
  await setMode(app.hub, 'autonomous');
  await page.setViewportSize({ width: 1440, height: 1000 });
  // two tasks at once: one is quick and commits, the other is slow and is still working when the owner stops the run
  const running = app.hub.request('POST', '/api/studio/coding/run', { tasks: [{ id: 'fast', prompt: 'Add FAST.md' }, { id: 'slow', prompt: 'SLOW-ONE: add SLOW.md' }], maxConcurrency: 2, confirmation: 'CREATE WORKTREES' }).catch(() => null);
  await expect.poll(async () => (await app.hub.get('/api/studio/coding')).json.jobs.at(-1)?.workers.find((worker) => worker.id === 'fast')?.status, { timeout: 60_000 }).toBe('ready_for_review');
  await openAgents(page, 'Sửa mã');
  const coding = page.getByTestId('coding-agents');
  await coding.getByRole('button', { name: 'Dừng sửa mã' }).click();
  await running;
  await expect(coding.getByTestId('coding-result')).toHaveAttribute('data-status', 'cancelled', { timeout: 60_000 });

  // the worker that committed is waiting for the owner; the one that was cut off is stopped, not "working"
  const fast = coding.locator('[data-testid="coding-worker"][data-worker="fast"]');
  const slow = coding.locator('[data-testid="coding-worker"][data-worker="slow"]');
  await expect(fast).toHaveAttribute('data-kind', 'unverified');
  await expect(slow).toHaveAttribute('data-kind', 'stopped');
  await expect(slow.getByTestId('agent-proof')).toContainText('Đã dừng');

  // read what it committed and tick it: the merge stays off, and the tab says why next to the button
  await fast.getByRole('checkbox', { name: /Chọn công việc fast/ }).check();
  await fast.getByRole('button', { name: 'Xem thay đổi', exact: true }).click();
  await expect(fast.getByRole('region', { name: /^Thay đổi của chatmcp\/coder\// })).toContainText('+++ b/FAST.md');
  const merge = coding.getByRole('button', { name: 'Gộp các công việc đã chọn', exact: true });
  await expect(merge).toBeDisabled();
  await expect(merge).toHaveAttribute('aria-describedby', 'coding-merge-status-hint');
  await expect(coding.getByTestId('coding-integration')).toContainText('Hub chỉ gộp lần chạy đã sẵn sàng để duyệt hoặc chạy hỏng một phần; lần này đang ở trạng thái “Đã dừng”');

  // the Hub would have refused it as well: the tab is not stricter than the Hub, it is saying what the Hub says
  const record = (await app.hub.get('/api/studio/coding')).json.jobs.at(-1);
  const review = (await app.hub.get(`/api/studio/coding/review?runId=${record.id}&workerId=fast`)).json;
  const integrate = await app.hub.request('POST', '/api/studio/coding/integrate', { runId: record.id, workerIds: ['fast'], reviewTokens: { fast: review.reviewToken }, confirmation: 'INTEGRATE WORKTREES' });
  expect(integrate.status).toBe(409);
  expect(integrate.json.code).toBe('run_not_ready');
  expect(git(app.project, app.scratch, ['status', '--porcelain']).stdout).toBe('');
});

test('the task list: a problem is described by its field and not shouted, the plan note goes when the list changes, and removing a task keeps focus', async ({ page, app }) => {
  await onboard(page, app);
  await setMode(app.hub, 'autonomous');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openAgents(page, 'Sửa mã');
  const coding = page.getByTestId('coding-agents');
  await coding.getByRole('textbox', { name: 'Chia công việc từ một yêu cầu' }).fill('Add a file named AGENT-NOTE.md');
  await coding.getByRole('button', { name: 'Đề xuất chia công việc', exact: true }).click();
  const note = coding.getByRole('status').filter({ hasText: 'Bản xem trước gồm 1 công việc' });
  await expect(note).toBeVisible();

  // adding a task makes "the preview has 1 task" wrong, so the note goes
  const add = coding.getByRole('button', { name: 'Thêm công việc', exact: true });
  await add.click();
  await expect(coding.getByTestId('coding-task')).toHaveCount(2);
  await expect(note).toHaveCount(0);

  // a problem with a field is the field's description: read when the field is reached, never an alert announced on every key
  const second = coding.getByTestId('coding-task').nth(1);
  await second.getByRole('textbox', { name: 'Công việc 2', exact: true }).fill('Another note');
  await second.locator('summary').click();
  const id = second.locator('#coding-id-1');
  await id.fill('Bad Id');
  await expect(id).toHaveAttribute('aria-invalid', 'true');
  await expect(id).toHaveAccessibleDescription(/Mã gồm chữ thường không dấu/);
  await expect(second.locator('#coding-id-1-issues')).toContainText('Mã gồm chữ thường không dấu');
  await expect(second.getByRole('alert')).toHaveCount(0);
  await expect(coding.getByRole('button', { name: 'Bắt đầu sửa mã', exact: true })).toBeDisabled();
  await id.fill('task-2');
  await expect(id).not.toHaveAttribute('aria-invalid', 'true');
  await expect(second.locator('#coding-id-1-issues')).toHaveCount(0);
  await expect(coding.getByRole('button', { name: 'Bắt đầu sửa mã', exact: true })).toBeEnabled();

  // removing a task takes the focused button away: focus goes to "add a task" and not to nowhere
  await second.getByRole('button', { name: 'Xóa công việc 2' }).focus();
  await page.keyboard.press('Enter');
  await expect(coding.getByTestId('coding-task')).toHaveCount(1);
  await expect(add).toBeFocused();
});

test('agent groups: the AI’s words are a report, labelled and never green, and what is typed survives a visit to another tab', async ({ page, app }, testInfo) => {
  test.setTimeout(180_000);
  await onboard(page, app);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openAgents(page, 'Nhóm trợ lý');
  const groups = page.getByTestId('agent-groups');
  await shot(page, testInfo, 'groups-1-empty');

  // a request the owner types is kept when they look at another tab and come back
  await groups.getByRole('textbox', { name: 'Yêu cầu của bạn' }).fill('Why is the page slow?');
  await openWorkTab(page, 'Thay đổi');
  await openAgents(page, 'Nhóm trợ lý');
  await expect(groups.getByRole('textbox', { name: 'Yêu cầu của bạn' })).toHaveValue('Why is the page slow?');

  // the AI plans its own helpers: the scripted model answers "OK", which is no plan, so the run ends needing the owner
  await groups.getByRole('button', { name: 'Bắt đầu phân tích', exact: true }).click();
  const ask = page.getByRole('alertdialog', { name: 'Cho phép AI phân tích dự án?' });
  await expect(ask).toContainText('Why is the page slow?');
  await ask.getByRole('button', { name: 'Cho phép và bắt đầu' }).click();
  await expect(ask).toBeHidden();
  await expect(page.locator('#agent-goal-heading'), 'the start button turned into "working"; focus goes to the heading').toBeFocused();
  // a run that needs the owner is announced as a warning
  const needs = page.getByRole('status').filter({ hasText: 'Cần bạn kiểm tra' });
  await expect(needs).toBeVisible({ timeout: 60_000 });
  await expect(needs).toHaveClass(/border-l-warning/);
  const analysis = groups.getByTestId('analysis-result');
  await expect(analysis).toHaveAttribute('data-kind', 'attention', { timeout: 60_000 });
  await expect(analysis.getByRole('alert')).toContainText('Model did not return a valid JSON worker plan');
  await expect(analysis).toContainText('Cần bạn kiểm tra');
  await expect(analysis.locator('[data-tone="success"]')).toHaveCount(0);

  // the hand-made group: three helpers, each answered "OK" by the scripted model
  await groups.getByText('Tự chia việc cho từng trợ lý', { exact: true }).click();
  const manual = groups.getByTestId('manual-agents');
  await expect(manual.getByRole('textbox', { name: 'Việc cần làm của trợ lý 1' })).toHaveValue(/kế hoạch triển khai/);
  await manual.getByRole('button', { name: 'Bắt đầu với nhóm này' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Cho phép AI phân tích dự án?' });
  await confirm.getByRole('button', { name: 'Cho phép và bắt đầu' }).click();
  await expect(confirm).toBeHidden();
  await expect(groups.getByText('Tự chia việc cho từng trợ lý', { exact: true }), 'focus stays in the group form').toBeFocused();
  // a group that finished is announced as information, not as a success: what it wrote has not been checked
  const finished = page.getByRole('status').filter({ hasText: 'Đã hoàn tất' });
  await expect(finished).toBeVisible({ timeout: 90_000 });
  await expect(finished).toHaveClass(/border-l-primary/);
  await expect(finished).not.toHaveClass(/border-l-success/);
  const result = manual.getByTestId('group-result');
  await expect(result).toHaveAttribute('data-kind', 'ai-report', { timeout: 90_000 });
  await expect(result.getByTestId('ai-report')).toHaveCount(4);
  await expect(result.getByTestId('ai-report').first()).toContainText('Báo cáo của AI');
  await expect(result.getByTestId('ai-report').last()).toContainText('Báo cáo của AI · Tổng hợp kết quả');
  await expect(result.getByTestId('agent-proof')).toContainText('AI báo cáo · Hub chưa kiểm chứng');
  await expect(result.getByTestId('agent-proof')).toHaveAttribute('data-tone', 'neutral');
  await expect(result.locator('[data-tone="success"]')).toHaveCount(0);
  await result.scrollIntoViewIfNeeded();
  await shot(page, testInfo, 'groups-2-report');

  // the Hub kept the run: reopening the tab shows it again, and the start button is not left disabled
  await openWorkTab(page, 'Tiến độ');
  await openAgents(page, 'Nhóm trợ lý');
  await groups.getByText('Tự chia việc cho từng trợ lý', { exact: true }).click();
  await expect(groups.getByTestId('group-result').getByTestId('ai-report')).toHaveCount(4);
  await expect(groups.getByTestId('manual-agents').getByRole('button', { name: 'Bắt đầu với nhóm này' })).toBeEnabled();
});

test('the section switch is a tablist: arrows, Home and End move and select, and the panel follows', async ({ page, app }) => {
  await onboard(page, app);
  await openAgents(page);
  const strip = page.getByRole('tablist', { name: 'Các mục của Tác nhân' });
  const tabs = strip.getByRole('tab');
  await expect(tabs).toHaveText(['Công việc nền', 'Nhóm trợ lý', 'Sửa mã']);
  // what a screen reader is told: one tablist, three tabs, the first one selected
  await expect(strip).toMatchAriaSnapshot(`
    - tablist "Các mục của Tác nhân":
      - tab "Công việc nền" [selected]
      - tab "Nhóm trợ lý"
      - tab "Sửa mã"
  `);
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel', { name: 'Công việc nền' })).toBeVisible();
  // a roving tabindex: one stop for the whole switch
  await expect(tabs.nth(0)).toHaveAttribute('tabindex', '0');
  await expect(tabs.nth(1)).toHaveAttribute('tabindex', '-1');

  await tabs.nth(0).focus();
  await page.keyboard.press('ArrowRight');
  await expect(tabs.nth(1)).toBeFocused();
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('agent-groups')).toBeVisible();
  await expect(page.getByRole('tabpanel', { name: 'Nhóm trợ lý' })).toBeVisible();
  await page.keyboard.press('End');
  await expect(tabs.nth(2)).toBeFocused();
  await expect(page.getByTestId('coding-agents')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(tabs.nth(0)).toBeFocused();
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowLeft');
  await expect(tabs.nth(2)).toBeFocused();
  await page.keyboard.press('Home');
  await expect(tabs.nth(0)).toBeFocused();

  // Tab leaves the switch for the panel instead of walking through the other sections
  await page.keyboard.press('Tab');
  await expect(tabs.nth(1)).not.toBeFocused();
  await expect(tabs.nth(2)).not.toBeFocused();

  // the work panel's own tablist is a separate one and still works the same way
  const outer = page.getByRole('tablist', { name: 'Công cụ làm việc' });
  await outer.getByRole('tab', { name: 'Tác nhân', exact: true }).focus();
  await page.keyboard.press('ArrowLeft');
  await expect(outer.getByRole('tab', { name: 'Terminal', exact: true })).toBeFocused();
  await expect(outer.getByRole('tab', { name: 'Terminal', exact: true })).toHaveAttribute('aria-selected', 'true');
});

test('narrow windows (600 and 900 px): the Agents tab fits its panel in every section, with a real run on screen', async ({ page, app }, testInfo) => {
  test.setTimeout(240_000);
  defineNoteWorker(app.mock);
  await onboard(page, app);
  await setMode(app.hub, 'autonomous');
  // a real run, started through the Hub the way the tab does, so that a worker card with a long branch name is on screen
  const run = await app.hub.post('/api/studio/coding/run', { tasks: [{ id: 'task-a', prompt: 'Add a file named AGENT-NOTE.md that explains this project' }], maxConcurrency: 1, confirmation: 'CREATE WORKTREES' });
  expect(run.status).toBe('ready_for_review');
  for (const [width, height] of [[600, 900], [900, 800]]) {
    await page.setViewportSize({ width, height });
    // compact windows close the work panel, a moment after the size changes; the header button opens it. The block is retried as a whole
    // because for that moment the panel of the old layout is still on screen and is about to go.
    await expect(async () => {
      const opener = page.locator('header button[title="Mở Inspector (Ctrl+J)"]');
      if (await opener.isVisible()) await opener.click();
      await openAgents(page, 'Sửa mã');
      await expect(page.getByTestId('coding-worker')).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    for (const [section, id] of [['Công việc nền', null], ['Nhóm trợ lý', 'agent-groups'], ['Sửa mã', 'coding-agents']]) {
      await page.getByRole('tab', { name: section, exact: true }).click();
      if (id) {
        const body = page.getByTestId(id);
        await expect(body).toBeVisible();
        const [scrollWidth, clientWidth] = await body.evaluate((element) => [element.scrollWidth, element.clientWidth]);
        expect(scrollWidth, `${section} at ${width}px scrolls sideways`).toBeLessThanOrEqual(clientWidth + 1);
      }
      const panel = await page.locator('#panel-inspector').boundingBox();
      expect(panel.width).toBeLessThanOrEqual(width);
      if (id === 'coding-agents') await page.getByTestId('coding-worker').scrollIntoViewIfNeeded();
      await shot(page, testInfo, `narrow-${width}-${id ?? 'background'}`);
    }
    // the switch itself stays inside the panel and scrolls rather than wrapping
    const strip = await page.getByRole('tablist', { name: 'Các mục của Tác nhân' }).evaluate((element) => [element.scrollWidth, element.clientWidth, element.getBoundingClientRect().right]);
    expect(strip[2]).toBeLessThanOrEqual(width);
  }
});

test('with another folder in view the delegation forms are off and the notice names both folders; background tasks stay usable', async ({ page, app }) => {
  test.setTimeout(180_000);
  defineNoteWorker(app.mock);
  await onboard(page, app);
  await setMode(app.hub, 'autonomous');
  // a finished run of the project folder, so that what is done to it from the other folder can be tried
  const run = await app.hub.post('/api/studio/coding/run', { tasks: [{ id: 'task-a', prompt: 'Add a file named AGENT-NOTE.md that explains this project' }], maxConcurrency: 1, confirmation: 'CREATE WORKTREES' });
  expect(run.status).toBe('ready_for_review');
  await page.setViewportSize({ width: 1440, height: 1000 });
  const other = path.join(app.scratch, 'second-workspace');
  await fs.mkdir(other, { recursive: true });
  await fs.writeFile(path.join(other, 'README.md'), '# Second workspace\n');
  await app.hub.post('/api/workspaces/add', { path: other });
  await page.getByRole('button', { name: 'second-workspace', exact: true }).click();
  await openAgents(page, 'Nhóm trợ lý');
  const groups = page.getByTestId('agent-groups');
  await expect(groups.getByRole('status').filter({ hasText: app.project })).toContainText('second-workspace');
  await expect(groups.getByRole('textbox', { name: 'Yêu cầu của bạn' })).toBeDisabled();
  await expect(groups.getByRole('button', { name: 'Bắt đầu phân tích', exact: true })).toBeDisabled();
  await page.getByRole('tab', { name: 'Sửa mã', exact: true }).click();
  const coding = page.getByTestId('coding-agents');
  await expect(coding.getByRole('status').filter({ hasText: app.project })).toBeVisible();
  await expect(coding.getByRole('textbox', { name: 'Chia công việc từ một yêu cầu' })).toBeDisabled();
  await expect(coding.getByRole('button', { name: 'Bắt đầu sửa mã', exact: true })).toBeDisabled();
  // the run of the project folder can be read from here, but nothing is changed from here: not a merge, not a draft on GitHub
  const card = coding.getByTestId('coding-worker');
  await card.getByRole('checkbox', { name: /Chọn công việc task-a/ }).check();
  await card.getByRole('button', { name: 'Xem thay đổi', exact: true }).click();
  await expect(card.getByRole('region', { name: /^Thay đổi của chatmcp\/coder\// })).toContainText(`+++ b/${NOTE}`);
  await expect(coding.getByRole('button', { name: 'Gộp các công việc đã chọn', exact: true })).toBeDisabled();
  await expect(card.getByRole('button', { name: 'Tạo bản nháp trên GitHub' })).toBeDisabled();
  await page.getByRole('tab', { name: 'Công việc nền', exact: true }).click();
  await expect(page.getByText('Chưa có công việc nền.', { exact: false })).toBeVisible();
  // back on the project folder the forms work again, and so does the merge once the changes have been read
  await page.getByRole('button', { name: path.basename(app.project), exact: true }).click();
  await openAgents(page, 'Nhóm trợ lý');
  await expect(groups.getByRole('textbox', { name: 'Yêu cầu của bạn' })).toBeEnabled();
  await page.getByRole('tab', { name: 'Sửa mã', exact: true }).click();
  await card.getByRole('checkbox', { name: /Chọn công việc task-a/ }).check();
  await card.getByRole('button', { name: 'Xem thay đổi', exact: true }).click();
  await expect(card.getByRole('region', { name: /^Thay đổi của chatmcp\/coder\// })).toContainText(`+++ b/${NOTE}`);
  await expect(coding.getByRole('button', { name: 'Gộp các công việc đã chọn', exact: true })).toBeEnabled();
});

test('in English, and in the light theme, the tab reads in one language and keeps the evidence colours', async ({ page, app }, testInfo) => {
  test.setTimeout(240_000);
  defineNoteWorker(app.mock);
  await onboard(page, app);
  await setMode(app.hub, 'autonomous');
  const run = await app.hub.post('/api/studio/coding/run', { tasks: [{ id: 'task-a', prompt: 'Add a file named AGENT-NOTE.md that explains this project' }], maxConcurrency: 1, confirmation: 'CREATE WORKTREES' });
  expect(run.status).toBe('ready_for_review');
  await page.setViewportSize({ width: 1440, height: 1000 });
  // something for the Background section to list: an ordinary chat, sent while the screen is still Vietnamese (the send button is named there)
  const prompt = 'Please say hello in one short line.';
  await send(page, prompt);
  await waitForState(app.hub, (await taskByPrompt(app, prompt)).id, 'completed');
  const dialog = await openSettings(page, 'Giao diện & ngôn ngữ');
  await dialog.getByRole('button', { name: 'English' }).click();
  await closeSettings(page);

  await openWorkTab(page, 'Agents');
  await expect(page.getByRole('tablist', { name: 'Agent sections' }).getByRole('tab')).toHaveText(['Background', 'Agent groups', 'Code edits']);

  // Background: the list first, then a card opened (its detail holds the longest sentences), all of it in one language
  const background = page.getByRole('tabpanel', { name: 'Background' });
  await expect(background.getByTestId('background-task')).toHaveCount(1);
  await expect(background).toContainText('In progress: 0 · Tasks: 1 (conversations not counted)');
  await expect(background.getByLabel('Filter background tasks').getByRole('button')).toHaveText(['All', 'This workspace', 'This conversation']);
  const task = background.getByTestId('background-task');
  await expect(task).toContainText('Final reply received');
  await expect(task).toContainText('0 subagents');
  await expect(background.getByTestId('background-workspace')).toContainText('1 task');
  await expectEnglishOnly(background, 'Background (list)');
  await task.getByRole('button', { name: prompt }).click();
  await expect(task.getByRole('button', { name: prompt })).toHaveAttribute('aria-expanded', 'true');
  await expect(task).toContainText('Workspace: ');
  await expect(task).toContainText(`Conversation: ${prompt}`);
  await expect(task.getByRole('button', { name: 'Open this conversation', exact: true })).toBeVisible();
  await expectEnglishOnly(background, 'Background (a card opened)');
  await shot(page, testInfo, 'english-background', background);

  for (const [section, marker] of [['Agent groups', 'agent-groups'], ['Code edits', 'coding-agents']]) {
    await page.getByRole('tab', { name: section, exact: true }).click();
    await expect(page.getByRole('tabpanel', { name: section })).toBeVisible();
    // a section is a script fetched when its tab is first opened: read its words once it is there, not the line that stands in for it
    await expect(page.getByTestId(marker)).toBeVisible();
    await expectEnglishOnly(page.getByRole('tabpanel', { name: section }), section);
  }
  const card = page.getByTestId('coding-worker');
  await expect(card.getByTestId('agent-proof')).toContainText('Reported done by the AI · not verified by the Hub');
  await expect(card.getByTestId('ai-report')).toContainText('AI report');
  await expect(card.getByTestId('agent-proof').getByText('Reported done by the AI')).toHaveCSS('color', WARNING.dark);
  await card.scrollIntoViewIfNeeded();
  await shot(page, testInfo, 'english-dark');

  // the toggle is named in the language on screen
  await page.getByTitle('Switch light / dark theme').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(card.getByTestId('agent-proof').getByText('Reported done by the AI')).toHaveCSS('color', WARNING.light);
  await expect(page.getByTestId('coding-agents').locator('[data-tone="success"]')).toHaveCount(0);
  await shot(page, testInfo, 'english-light');
  expect(WARNING.light).not.toBe(SUCCESS.light);
});
