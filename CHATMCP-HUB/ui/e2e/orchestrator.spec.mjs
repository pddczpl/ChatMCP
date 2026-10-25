import { test, expect, onboard, send, taskByPrompt, openWorkTab, openSettings, closeSettings, delayLayoutChanges } from './fixtures.mjs';
import { say, call } from '../../tests/e2e/scenarios.mjs';
import { setMode, waitForState, continueTask } from '../../tests/e2e/hub-process.mjs';
import { git, gitInit, makeCalcProject } from '../../tests/e2e/fixtures.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The Agents tab against the real Hub and the scripted model: the owner hands work out and reads what comes back.
// The scripted model answers "OK" to a request that offers no tools, and writes one file when it is a coding worker; that is enough to see
// the whole path from the form to the diff, and to see what must never happen: an AI saying "all tests pass" turning anything green.

const NOTE = 'AGENT-NOTE.md';
const CLAIM = 'I created AGENT-NOTE.md. All tests pass and the task is complete.';
/** The program the hook suites start as a hook (tests/fixtures/hook-program.mjs): it answers as the JSON it is given says. */
const HOOK_PROGRAM = fileURLToPath(new URL('../../tests/fixtures/hook-program.mjs', import.meta.url));
/** The tone colours of src/index.css as the browser computes them, so that a test does not repeat hex values. */
const WARNING = { dark: 'rgb(243, 185, 77)', light: 'rgb(154, 90, 0)' };
const SUCCESS = { dark: 'rgb(63, 217, 155)', light: 'rgb(11, 122, 82)' };
/** What a missing dictionary string would look like on screen: its key (the unit tests use the same pattern on server-rendered HTML). */
const RAW_KEY = /\b(?:agent|agents|group|coding)_[a-z_]+\b/;
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
  await expect(card.getByTestId('runner-notice'), 'a task too short to be planned has nothing for the Hub to add').toHaveCount(0);
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
  // the model had said nothing when it was stopped: the runner's sentence about the stop is the Hub's, and there is no AI report to hold it
  await expect(coding.getByTestId('coding-worker').first().getByTestId('runner-error')).toContainText('Đã dừng theo yêu cầu');
  // the Vietnamese sentence for the code is the runner's own, so the Vietnamese screen shows it once; the code reached the page all the same
  await expect(coding.getByTestId('coding-worker').first().getByTestId('runner-error-lead')).toHaveCount(0);
  expect((await app.hub.get('/api/studio/coding')).json.jobs.at(-1).workers[0].runnerErrorCode, 'the code is what the Hub sent').toBe('user_cancelled');
  await expect(coding.getByTestId('coding-worker').first().getByTestId('ai-report')).toHaveCount(0);
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

for (const late of [0, 30, 1500]) test(`narrow windows (600 and 900 px): the Agents tab fits its panel in every section, with a real run on screen${late ? `, when the page hears of the new width ${late} ms late` : ''}`, async ({ page, app }, testInfo) => {
  test.setTimeout(240_000);
  await delayLayoutChanges(page, late);
  defineNoteWorker(app.mock);
  await onboard(page, app);
  await setMode(app.hub, 'autonomous');
  // a real run, started through the Hub the way the tab does, so that a worker card with a long branch name is on screen
  const run = await app.hub.post('/api/studio/coding/run', { tasks: [{ id: 'task-a', prompt: 'Add a file named AGENT-NOTE.md that explains this project' }], maxConcurrency: 1, confirmation: 'CREATE WORKTREES' });
  expect(run.status).toBe('ready_for_review');
  for (const [width, height] of [[600, 900], [900, 800]]) {
    const wasWide = page.viewportSize().width >= 1100;
    await page.setViewportSize({ width, height });
    // Under 1100 px the page draws the compact layout and closes the work panel, in one step. The browser tells the page of a new width at its next frame and
    // setViewportSize does not wait for that, so for a moment the panel on screen is the wide layout's, which is about to go. Whatever is done to it then can
    // never end (a click waits for a tab that has gone, and these actions have no timeout of their own), and a retry around it cannot help: it starts again
    // only when the callback ends. So wait for the end of the step, which is the header button that opens the panel, and use it. From 600 to 900 px the window
    // stays compact: nothing closes, and the panel stays as it was.
    if (wasWide) {
      const opener = page.locator('header button[title="Mở Inspector (Ctrl+J)"]');
      await expect(opener).toBeVisible();
      await opener.click();
    }
    await expect(page.locator('#panel-inspector')).toBeVisible();
    await openAgents(page, 'Sửa mã');
    await expect(page.getByTestId('coding-worker')).toBeVisible();
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

test('with another folder in view the delegation forms are off, the Hub’s runs are not shown (and the page says so), and background tasks stay usable', async ({ page, app }) => {
  test.setTimeout(180_000);
  defineNoteWorker(app.mock);
  await onboard(page, app);
  await setMode(app.hub, 'autonomous');
  // a finished run of the project folder, so that what the other folder shows of it can be tried
  const run = await app.hub.post('/api/studio/coding/run', { tasks: [{ id: 'task-a', prompt: 'Add a file named AGENT-NOTE.md that explains this project' }], maxConcurrency: 1, confirmation: 'CREATE WORKTREES' });
  expect(run.status).toBe('ready_for_review');
  // the Hub names the folder a run belongs to: the very string it reports for its own folder, which is what the page compares
  const listed = (await app.hub.get('/api/studio/coding')).json.jobs.at(-1);
  expect(listed.workspace).toBe((await app.hub.state()).workspace.path);
  expect(listed.workspace).toBe(app.project);
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
  await expect(coding.getByRole('status').filter({ hasText: 'khác với thư mục chính của Hub' })).toContainText(app.project);
  await expect(coding.getByRole('textbox', { name: 'Chia công việc từ một yêu cầu' })).toBeDisabled();
  await expect(coding.getByRole('button', { name: 'Bắt đầu sửa mã', exact: true })).toBeDisabled();
  // the run of the project folder is the Hub’s folder’s and not the one in view: it is not shown, and the page says that it exists and why it is not
  await expect(coding.getByTestId('coding-worker')).toHaveCount(0);
  await expect(coding.getByTestId('coding-result')).toHaveCount(0);
  await expect(coding.getByTestId('isolated-checks-panel')).toHaveCount(0);
  await expect(coding.getByTestId('coding-other-folders')).toHaveText(`Chỉ hiện các lần sửa mã của thư mục đang xem. 1 lần sửa mã của thư mục chính của Hub (${app.project}) không hiện ở đây, vì bạn đang xem thư mục khác.`);
  await expect(coding.getByText('Hub chỉ sửa mã ở thư mục chính của nó, nên thư mục đang xem chưa có lần sửa mã nào.')).toBeVisible();
  await expect(coding.getByText('Mô tả việc cần làm ở trên')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Công việc nền', exact: true }).click();
  await expect(page.getByText('Chưa có công việc nền.', { exact: false })).toBeVisible();
  // back on the project folder the forms work again, its run is shown (nothing is left out), and so does the merge once the changes have been read
  await page.getByRole('button', { name: path.basename(app.project), exact: true }).click();
  await openAgents(page, 'Nhóm trợ lý');
  await expect(groups.getByRole('textbox', { name: 'Yêu cầu của bạn' })).toBeEnabled();
  await page.getByRole('tab', { name: 'Sửa mã', exact: true }).click();
  const card = coding.getByTestId('coding-worker');
  await expect(card).toHaveCount(1);
  await expect(coding.getByTestId('coding-other-folders')).toHaveCount(0);
  await expect(coding.getByTestId('coding-run-foreign')).toHaveCount(0);
  await card.getByRole('checkbox', { name: /Chọn công việc task-a/ }).check();
  await card.getByRole('button', { name: 'Xem thay đổi', exact: true }).click();
  await expect(card.getByRole('region', { name: /^Thay đổi của chatmcp\/coder\// })).toContainText(`+++ b/${NOTE}`);
  await expect(coding.getByRole('button', { name: 'Gộp các công việc đã chọn', exact: true })).toBeEnabled();
});

test('runs of two folders: each folder shows its own, and the run of the folder the Hub has left is a record that the Hub itself would not read', async ({ page, app }, testInfo) => {
  test.setTimeout(240_000);
  defineNoteWorker(app.mock);
  await onboard(page, app);
  await setMode(app.hub, 'autonomous');
  await page.setViewportSize({ width: 1440, height: 1000 });
  const start = (id) => ({ tasks: [{ id, prompt: 'Add a file named AGENT-NOTE.md that explains this project' }], maxConcurrency: 1, confirmation: 'CREATE WORKTREES' });
  // a run in the project folder; then the Hub is pointed at a second project and makes a run there: one list holds both, and says whose each is
  const first = await app.hub.post('/api/studio/coding/run', start('task-a'));
  expect(first.status).toBe('ready_for_review');
  const second = path.join(app.scratch, 'second-project');
  makeCalcProject(second);
  gitInit(second, app.scratch);
  await app.hub.post('/api/workspace/select', { path: second });
  expect((await app.hub.state()).workspace.path).toBe(second);
  const next = await app.hub.post('/api/studio/coding/run', start('task-b'));
  expect(next.status).toBe('ready_for_review');
  expect((await app.hub.get('/api/studio/coding')).json.jobs.map((job) => [job.id, job.workspace])).toEqual([[first.id, app.project], [next.id, second]]);

  // the page still looks at the project folder, which the Hub has left: its run is a record, and the page says what the Hub says about it
  await openAgents(page, 'Sửa mã');
  const coding = page.getByTestId('coding-agents');
  const card = coding.getByTestId('coding-worker');
  await expect(card).toHaveCount(1);
  await expect(card).toHaveAttribute('data-worker', 'task-a');
  await expect(coding.getByTestId('coding-result')).toHaveAttribute('data-run', first.id);
  await expect(coding.getByTestId('coding-run-foreign')).toContainText(`(${second})`);
  await expect(coding.getByTestId('coding-other-folders')).toHaveText(`Chỉ hiện các lần sửa mã của thư mục đang xem. 1 lần sửa mã của thư mục chính của Hub (${second}) không hiện ở đây, vì bạn đang xem thư mục khác.`);
  for (const name of ['Xem thay đổi', 'Xem nội dung tệp', 'Tạo bản nháp trên GitHub']) await expect(card.getByRole('button', { name, exact: true }), name).toBeDisabled();
  await expect(coding.getByRole('button', { name: 'Gộp các công việc đã chọn', exact: true })).toBeDisabled();
  await coding.getByTestId('coding-result').evaluate((element) => element.scrollIntoView({ block: 'center' }));
  await shot(page, testInfo, 'coding-two-folders-record');
  // the tab is not stricter than the Hub: the Hub answers a read of that run with "not in the selected workspace", and reads the run of the folder it works on
  const refused = await app.hub.get(`/api/studio/coding/review?runId=${first.id}&workerId=task-a`);
  expect([refused.status, refused.json.code]).toEqual([404, 'run_not_found']);
  expect((await app.hub.get(`/api/studio/coding/review?runId=${next.id}&workerId=task-b`)).status).toBe(200);

  // the folder the Hub works on: its own run is shown and read as usual, and the other folder’s is counted
  await page.getByRole('button', { name: 'second-project', exact: true }).click();
  await expect(card).toHaveCount(1);
  await expect(card).toHaveAttribute('data-worker', 'task-b');
  await expect(coding.getByTestId('coding-run-foreign')).toHaveCount(0);
  await expect(coding.getByTestId('coding-other-folders')).toHaveText('Chỉ hiện các lần sửa mã của thư mục đang xem. 1 lần sửa mã thuộc thư mục khác nên không hiện ở đây.');
  await card.getByRole('button', { name: 'Xem thay đổi', exact: true }).click();
  await expect(card.getByRole('region', { name: /^Thay đổi của chatmcp\/coder\// })).toContainText(`+++ b/${NOTE}`);
  // and back to the first folder
  await page.getByRole('button', { name: path.basename(app.project), exact: true }).click();
  await expect(card).toHaveAttribute('data-worker', 'task-a');
  await expect(coding.getByTestId('coding-run-foreign')).toBeVisible();
});

test('a worker that was asked to verify and could not be: the Hub’s note says why in the Hub’s name, and the AI’s report keeps only the AI’s words', async ({ page, app }, testInfo) => {
  test.setTimeout(240_000);
  defineNoteWorker(app.mock);
  await onboard(page, app);
  await setMode(app.hub, 'autonomous');
  await page.setViewportSize({ width: 1440, height: 1000 });
  // The project has a Node test file and no `node --test` script: the Hub finds no check it could run in isolation, so the worker needs the owner.
  const run = await app.hub.post('/api/studio/coding/run', { tasks: [{ id: 'task-1', prompt: 'Add a file named AGENT-NOTE.md that explains this project', verify: true }], maxConcurrency: 1, confirmation: 'CREATE WORKTREES' });
  expect(run.status).toBe('partial_failure');
  const [record] = run.workers;
  expect(record).toMatchObject({ id: 'task-1', status: 'needs_attention', verifyRequired: true });
  expect(record.summary, 'the summary is what the model said and nothing else').toBe(CLAIM);
  expect(record.verificationNote).toEqual({ code: 'no_checks', text: 'No supported pinned Node test definition was discovered.' });

  await openAgents(page, 'Sửa mã');
  const coding = page.getByTestId('coding-agents');
  const card = coding.getByTestId('coding-worker').filter({ hasText: 'task-1' });
  await expect(card).toHaveAttribute('data-kind', 'attention');
  await expect(card.getByTestId('agent-proof')).toHaveAttribute('data-tone', 'warning');
  const note = card.getByTestId('hub-note');
  await expect(note).toHaveText('Ghi chú của Hub: Hub không tìm thấy lệnh kiểm thử Node nào được hỗ trợ trong dự án này, nên không chạy kiểm thử cách ly nào.');
  await expect(note).toHaveAttribute('data-code', 'no_checks');
  await expect(note).not.toHaveClass(/success|danger|warning/);
  // beside the evidence line, before the AI's report, which holds the model’s words and none of the Hub’s
  const parts = await card.locator('[data-testid="agent-proof"], [data-testid="hub-note"], [data-testid="ai-report"]').evaluateAll((nodes) => nodes.map((node) => node.dataset.testid));
  expect(parts).toEqual(['agent-proof', 'hub-note', 'ai-report']);
  const report = card.getByTestId('ai-report');
  await expect(report).toContainText('All tests pass and the task is complete.');
  await expect(report).not.toContainText('Hub');
  await expect(report).not.toContainText('Ghi chú');
  await expect(coding.locator('[data-tone="success"]')).toHaveCount(0);
  await card.scrollIntoViewIfNeeded();
  await shot(page, testInfo, 'coding-hub-note');

  // the same in English
  const dialog = await openSettings(page, 'Giao diện & ngôn ngữ');
  await dialog.getByRole('button', { name: 'English' }).click();
  await closeSettings(page);
  await openWorkTab(page, 'Agents');
  await page.getByRole('tab', { name: 'Code edits', exact: true }).click();
  await expect(card.getByTestId('hub-note')).toHaveText('Hub note: The Hub found no supported pinned Node test in this project, so it ran no isolated check.');
  await expect(card.getByTestId('ai-report')).toContainText('AI report');
  await expect(card.getByTestId('hub-note')).not.toHaveText(VIETNAMESE);
  await shot(page, testInfo, 'coding-hub-note-english');
});

test('a worker whose model said nothing: the card has no AI report, and the Hub’s record of why it stopped is shown as the Hub’s', async ({ page, app }, testInfo) => {
  test.setTimeout(240_000);
  // every request of the coding worker is answered with an empty message: no text and no tool call, so the Hub's own AgentRunner ends the run with an error of its own
  app.mock.define('silent-worker', (ctx) => (ctx.prompt.startsWith('TASK: ') ? say('') : say('Xong.')));
  app.mock.setScenario('silent-worker');
  await onboard(page, app);
  await setMode(app.hub, 'autonomous');
  await page.setViewportSize({ width: 1440, height: 1000 });
  const run = await app.hub.post('/api/studio/coding/run', { tasks: [{ id: 'task-1', prompt: 'Add a file named AGENT-NOTE.md that explains this project' }], maxConcurrency: 1, confirmation: 'CREATE WORKTREES' });
  const [record] = run.workers;
  expect(record).toMatchObject({ id: 'task-1', status: 'failed', summary: '' });
  expect(typeof record.runnerError, 'the runner’s sentence is a field of its own').toBe('string');
  expect(record.runnerError.trim().length).toBeGreaterThan(0);
  // the empty message reaches the Hub through the model adapter, which names it with a code of its own (and not the runner's `empty_final`): that code is what the page tells
  expect(record.runnerErrorCode, 'the code of the sentence is a field of its own too').toBe('model_empty');
  const listed = (await app.hub.get('/api/studio/coding')).json.jobs.at(-1).workers[0];
  expect(listed.runnerError, 'and it is what the page is sent').toBe(record.runnerError);
  expect(listed.runnerErrorCode, 'with its code').toBe('model_empty');

  await openAgents(page, 'Sửa mã');
  const coding = page.getByTestId('coding-agents');
  const card = coding.getByTestId('coding-worker').filter({ hasText: 'task-1' });
  await expect(card).toHaveAttribute('data-kind', 'failed');
  const reason = card.getByTestId('runner-error');
  await expect(reason).toHaveText(`Lý do công việc dừng, Hub ghi nguyên văn: ${record.runnerError}`);
  await expect(reason).not.toHaveClass(/success|danger|warning/);
  // what the code means, in the language on screen, above the Hub's sentence, which is not changed by it
  const lead = card.getByTestId('runner-error-lead');
  await expect(lead).toHaveText('Model trả về phản hồi rỗng hoặc không dùng được.');
  await expect(lead).toHaveAttribute('data-code', 'model_empty');
  await expect(lead).not.toHaveClass(/success|danger|warning/);
  // the model said nothing, so there is no AI report; before this the runner's sentence sat under that label
  await expect(card.getByTestId('ai-report')).toHaveCount(0);
  await expect(card.getByText('Báo cáo của AI')).toHaveCount(0);
  const parts = await card.locator('[data-testid="agent-proof"], [data-testid="runner-error-lead"], [data-testid="runner-error"], [data-testid="ai-report"]').evaluateAll((nodes) => nodes.map((node) => node.dataset.testid));
  expect(parts).toEqual(['agent-proof', 'runner-error-lead', 'runner-error']);
  await expect(coding.locator('[data-tone="success"]')).toHaveCount(0);
  await card.scrollIntoViewIfNeeded();
  await shot(page, testInfo, 'coding-runner-error');

  // in English the label and the page's line follow the language on screen; the Hub's sentence stays as the Hub wrote it
  const dialog = await openSettings(page, 'Giao diện & ngôn ngữ');
  await dialog.getByRole('button', { name: 'English' }).click();
  await closeSettings(page);
  await openWorkTab(page, 'Agents');
  await page.getByRole('tab', { name: 'Code edits', exact: true }).click();
  await expect(card.getByTestId('runner-error-lead')).toHaveText('The model sent back an empty or unusable reply.');
  await expect(card.getByTestId('runner-error')).toHaveText(`Why the task stopped, as the Hub recorded it: ${record.runnerError}`);
  await expect(card.getByTestId('runner-error-lead')).not.toHaveText(VIETNAMESE);
  await expect(card.getByTestId('ai-report')).toHaveCount(0);
  await expect(card.getByText('AI report')).toHaveCount(0);
  await shot(page, testInfo, 'coding-runner-error-english');
});

test('a worker whose provider rejected the API key: the page says what that means in the language on screen, and the Hub’s sentence with the provider’s own words stays whole', async ({ page, app }, testInfo) => {
  test.setTimeout(240_000);
  // the provider answers every request of the coding worker with HTTP 401 and a message of its own; the Hub's adapter names it `gateway_auth` and keeps the provider's words in its sentence
  app.mock.define('rejected-worker', () => say('Xong.'));
  app.mock.setScenario('rejected-worker');
  await onboard(page, app);
  await setMode(app.hub, 'autonomous');
  await page.setViewportSize({ width: 1440, height: 1000 });
  app.mock.inject({ kind: 'status', status: 401, message: 'Invalid API key (rejected by the mock).', times: 20 });
  const run = await app.hub.post('/api/studio/coding/run', { tasks: [{ id: 'task-1', prompt: 'Add a file named AGENT-NOTE.md that explains this project' }], maxConcurrency: 1, confirmation: 'CREATE WORKTREES' });
  const [record] = run.workers;
  expect(record).toMatchObject({ id: 'task-1', status: 'failed', summary: '', runnerErrorCode: 'gateway_auth' });
  expect(record.runnerError, 'the Hub’s sentence keeps what the provider said, as it was said').toContain('Invalid API key (rejected by the mock).');
  expect(record.runnerError).toContain('HTTP 401');

  await openAgents(page, 'Sửa mã');
  const coding = page.getByTestId('coding-agents');
  const card = coding.getByTestId('coding-worker').filter({ hasText: 'task-1' });
  await expect(card.getByTestId('runner-error-lead')).toHaveText('Nhà cung cấp model từ chối API key. Kiểm tra key và quyền của nó trong cấu hình AI.');
  await expect(card.getByTestId('runner-error')).toHaveText(`Lý do công việc dừng, Hub ghi nguyên văn: ${record.runnerError}`);

  const dialog = await openSettings(page, 'Giao diện & ngôn ngữ');
  await dialog.getByRole('button', { name: 'English' }).click();
  await closeSettings(page);
  await openWorkTab(page, 'Agents');
  await page.getByRole('tab', { name: 'Code edits', exact: true }).click();
  // the English reader gets what to do about it; the provider's words, and the Hub's, are below it exactly as they were
  await expect(card.getByTestId('runner-error-lead')).toHaveText('The model provider rejected the API key. Check the key and its permissions in the AI settings.');
  await expect(card.getByTestId('runner-error')).toHaveText(`Why the task stopped, as the Hub recorded it: ${record.runnerError}`);
  await expect(card.getByTestId('runner-error')).toContainText('Invalid API key (rejected by the mock).');
  await expect(card.getByTestId('ai-report')).toHaveCount(0);
  await expect(coding.locator('[data-tone="success"]')).toHaveCount(0);
  await card.scrollIntoViewIfNeeded();
  await shot(page, testInfo, 'coding-runner-error-provider-english');
});

test('a worker whose task the Hub planned in phases: the AI report keeps the AI’s words, and the Hub’s notice on it is shown as the Hub’s', async ({ page, app }, testInfo) => {
  test.setTimeout(240_000);
  defineNoteWorker(app.mock);
  await onboard(page, app);
  await setMode(app.hub, 'autonomous');
  await page.setViewportSize({ width: 1440, height: 1000 });
  // A task of 160+ characters in two clauses is planned in phases (inspect, edit, verify, review). The scripted worker writes its file and says it is done: it runs no
  // check and reads no diff, so the Hub cannot back the plan and its AgentRunner ends the AI's answer with a sentence of its own, as it does for any such worker.
  const goal = 'Add a file named AGENT-NOTE.md that explains this project in two sentences. Then check that nothing else in the project changed, and report exactly which files this task touched.';
  expect(goal.length).toBeGreaterThanOrEqual(160);
  const run = await app.hub.post('/api/studio/coding/run', { tasks: [{ id: 'task-1', prompt: goal }], maxConcurrency: 1, confirmation: 'CREATE WORKTREES' });
  expect(run.status).toBe('ready_for_review');
  const [record] = run.workers;
  expect(record.summary, 'the summary is what the model said and nothing else').toBe(CLAIM);
  expect(typeof record.runnerNotice, 'and the Hub’s sentence is a field of its own').toBe('string');
  expect(record.runnerNotice).toMatch(/^DatGold has NOT independently verified full completion: .+\.$/);
  expect((await app.hub.get('/api/studio/coding')).json.jobs.at(-1).workers[0].runnerNotice, 'which is what the page is sent').toBe(record.runnerNotice);

  await openAgents(page, 'Sửa mã');
  const coding = page.getByTestId('coding-agents');
  const card = coding.getByTestId('coding-worker').filter({ hasText: 'task-1' });
  await expect(card).toHaveAttribute('data-kind', 'unverified');
  const notice = card.getByTestId('runner-notice');
  await expect(notice).toHaveText(`Ghi chú của Hub lúc AI báo xong, nguyên văn: ${record.runnerNotice}`);
  await expect(notice).not.toHaveClass(/success|danger|warning/);
  // beside the evidence line, before the AI's report, which holds the AI's words and none of the Hub's
  const parts = await card.locator('[data-testid="agent-proof"], [data-testid="runner-notice"], [data-testid="ai-report"]').evaluateAll((nodes) => nodes.map((node) => node.dataset.testid));
  expect(parts).toEqual(['agent-proof', 'runner-notice', 'ai-report']);
  const report = card.getByTestId('ai-report');
  await expect(report).toContainText('All tests pass and the task is complete.');
  await expect(report).not.toContainText('NOT independently verified');
  await expect(report).not.toContainText('Verification notice');
  await expect(card.getByTestId('agent-proof')).toHaveAttribute('data-tone', 'warning');
  await expect(coding.locator('[data-tone="success"]')).toHaveCount(0);
  await card.scrollIntoViewIfNeeded();
  await shot(page, testInfo, 'coding-runner-notice');

  // in English the label follows the language on screen; the Hub's sentence stays as the Hub wrote it
  const dialog = await openSettings(page, 'Giao diện & ngôn ngữ');
  await dialog.getByRole('button', { name: 'English' }).click();
  await closeSettings(page);
  await openWorkTab(page, 'Agents');
  await page.getByRole('tab', { name: 'Code edits', exact: true }).click();
  await expect(card.getByTestId('runner-notice')).toHaveText(`The Hub’s note when the AI reported done, as it wrote it: ${record.runnerNotice}`);
  await expect(card.getByTestId('ai-report')).toContainText('AI report');
  await expect(card.getByTestId('ai-report')).not.toContainText('NOT independently verified');
  await shot(page, testInfo, 'coding-runner-notice-english');
});

test('a worker whose SubagentStop hook never gives way: the AI report keeps the AI’s words, and the Hub’s note about the hook is shown as the Hub’s', async ({ page, app }, testInfo) => {
  test.setTimeout(240_000);
  // The scripted worker writes its file, then says the same thing every time it is asked, however the Hub's host messages (a hook's objection) change the last message it sees.
  app.mock.define('hook-worker', (ctx) => {
    if (ctx.turn > 0 || !ctx.prompt.startsWith('TASK: ')) return say(CLAIM);
    const args = { path: NOTE, content: '# Agent note\n\nWritten by a scripted worker.\n' };
    return ctx.tools.includes('write_file') ? call('write_file', args) : call('mcp_call', { name: 'local.write_file', arguments_json: JSON.stringify(args) });
  });
  app.mock.setScenario('hook-worker');
  // The owner's hooks file, where the owner keeps it (the Hub's data folder): a hook that objects to every answer, so that after eight blocks the Hub lets the worker finish and says so.
  const objection = { plan: { file: path.join(app.scratch, 'hook-plan.txt'), steps: [{ exit: 2, stderr: 'Mention the file you created.' }] } };
  await fs.writeFile(path.join(app.scratch, 'state', 'hooks.json'), JSON.stringify({ hooks: { SubagentStop: [{ hooks: [{ type: 'command', command: process.execPath, args: [HOOK_PROGRAM, JSON.stringify(objection)] }] }] } }));
  await onboard(page, app);
  await setMode(app.hub, 'autonomous');
  await page.setViewportSize({ width: 1440, height: 1000 });
  const run = await app.hub.post('/api/studio/coding/run', { tasks: [{ id: 'task-1', prompt: 'Add a file named AGENT-NOTE.md that explains this project' }], maxConcurrency: 1, confirmation: 'CREATE WORKTREES' });
  expect(run.status).toBe('ready_for_review');
  const [record] = run.workers;
  expect(record.summary, 'the summary is what the model said and nothing else').toBe(CLAIM);
  expect(record.runnerHookNotice).toMatch(/^The SubagentStop hook blocked 8 times; that is the limit for one run, so DatGold completed the task although a hook still objected \(SubagentStop: Mention the file you created\.\)/);
  expect(Object.hasOwn(record, 'runnerNotice'), 'a task this short has no verification notice, so the hook’s note is the only sentence of the Hub’s').toBe(false);
  expect((await app.hub.get('/api/studio/coding')).json.jobs.at(-1).workers[0].runnerHookNotice, 'which is what the page is sent').toBe(record.runnerHookNotice);

  await openAgents(page, 'Sửa mã');
  const coding = page.getByTestId('coding-agents');
  const card = coding.getByTestId('coding-worker').filter({ hasText: 'task-1' });
  const note = card.getByTestId('runner-hook-notice');
  await expect(note).toHaveText(`Ghi chú của Hub về hook vẫn phản đối, ghi lúc lượt chạy kết thúc, nguyên văn: ${record.runnerHookNotice}`);
  await expect(note).not.toHaveClass(/success|danger|warning/);
  // beside the evidence line, before the AI's report, which holds the AI's words and none of the Hub's
  const parts = await card.locator('[data-testid="agent-proof"], [data-testid="runner-notice"], [data-testid="runner-hook-notice"], [data-testid="ai-report"]').evaluateAll((nodes) => nodes.map((node) => node.dataset.testid));
  expect(parts).toEqual(['agent-proof', 'runner-hook-notice', 'ai-report']);
  const report = card.getByTestId('ai-report');
  await expect(report).toContainText('All tests pass and the task is complete.');
  await expect(report).not.toContainText('Hook notice');
  await expect(report).not.toContainText('blocked 8 times');
  await expect(coding.locator('[data-tone="success"]')).toHaveCount(0);
  await card.scrollIntoViewIfNeeded();
  await shot(page, testInfo, 'coding-runner-hook-notice');

  // in English the label follows the language on screen; the Hub's sentence stays as the Hub wrote it
  const dialog = await openSettings(page, 'Giao diện & ngôn ngữ');
  await dialog.getByRole('button', { name: 'English' }).click();
  await closeSettings(page);
  await openWorkTab(page, 'Agents');
  await page.getByRole('tab', { name: 'Code edits', exact: true }).click();
  await expect(card.getByTestId('runner-hook-notice')).toHaveText(`The Hub’s note about a hook that still objected, written when the run ended, as it wrote it: ${record.runnerHookNotice}`);
  await expect(card.getByTestId('ai-report')).toContainText('AI report');
  await expect(card.getByTestId('ai-report')).not.toContainText('blocked 8 times');
  await shot(page, testInfo, 'coding-runner-hook-notice-english');
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
  const chat = await taskByPrompt(app, prompt);
  await waitForState(app.hub, chat.id, 'completed');
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
    // the English words of a section arrive with its script (src/lib/i18n-agents-sections.ts): none may be missing, and none may show as its key
    const html = await page.getByRole('tabpanel', { name: section }).evaluate((panel) => panel.outerHTML);
    expect(html, `${section} shows a dictionary key instead of its words`).not.toMatch(RAW_KEY);
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

  // The conversation that chat made: the ribbon above it in English (its state, then the facts under Details), and after a second run that is held
  // back and stopped from the ribbon, the banner it leaves. What the Hub wrote about a stop (task.error) is the Hub's own Vietnamese sentence and is
  // shown as written, so the banner is read for its title and its button; the ribbon is read whole.
  const ribbon = page.getByTestId('task-status');
  await expect(ribbon).toHaveAttribute('data-status', 'completed');
  await expect(ribbon).toContainText('Final reply received');
  await expect(ribbon).toContainText(prompt);
  await expectEnglishOnly(ribbon, 'Ribbon (completed)');
  await ribbon.getByRole('button', { name: 'Details', exact: true }).click();
  const budget = ribbon.getByTestId('agent-request-budget');
  await expect(budget).toContainText('Model HTTP requests');
  await expect(budget).toContainText('Input tokens (provider-reported)');
  await expect(budget).toContainText('Context window');
  await expectEnglishOnly(ribbon, 'Ribbon (details open)');
  await shot(page, testInfo, 'english-ribbon', ribbon);

  let release;
  const held = new Promise((resolve) => { release = resolve; });
  app.mock.define('held-answer', async () => { await held; return say('Xong.'); });
  app.mock.setScenario('held-answer');
  try {
    await continueTask(app.hub, chat.id, 'Say it once more.');
    const stop = ribbon.getByRole('button', { name: 'Stop agent', exact: true });
    await expect(stop).toBeVisible();
    await expect(ribbon).toContainText(/Reading and planning|Running/);
    await expectEnglishOnly(ribbon, 'Ribbon (running)');
    await expect(page.getByRole('status').filter({ has: page.getByRole('button', { name: 'Continue', exact: true }) })).toHaveCount(0);
    await stop.click();
    // the toast that click leaves behind is English too (it was Vietnamese on this screen)
    await expect(page.getByText('Stop requested for the task', { exact: true })).toBeVisible();
    const stopped = await waitForState(app.hub, chat.id, ['cancelled', 'paused']);
    const word = { cancelled: 'Stopped', paused: 'Paused' }[stopped.state];
    const banner = page.getByRole('status').filter({ has: page.getByRole('button', { name: 'Continue', exact: true }) });
    await expect(banner).toHaveCount(1);
    await expect(banner.getByText(word, { exact: true })).toBeVisible();
    await expect(ribbon).toContainText(word);
    await expect(stop).toHaveCount(0);
    await shot(page, testInfo, 'english-banner', banner);

    // the banner's one next step, in English: the same conversation runs again, the banner goes away and the ribbon says what the model did
    release();
    app.mock.define('answer', () => say('Xong.'));
    app.mock.setScenario('answer');
    await banner.getByRole('button', { name: 'Continue', exact: true }).click();
    await waitForState(app.hub, chat.id, 'completed');
    await expect(banner).toHaveCount(0);
    await expect(ribbon).toContainText('Final reply received');
    await expectEnglishOnly(ribbon, 'Ribbon (continued)');
    // the button wrote the person's next message itself, and on this screen it is English (the Hub keeps it as the user's message)
    const asked = (await app.hub.task(chat.id)).dialogue.filter((entry) => entry.role === 'user').at(-1)?.text;
    expect(asked).toBe('Continue the task in the same conversation. Check the current state before acting; do not re-run an action whose result is unclear.');
  } finally {
    release();
  }

  // The sidebar, read whole (its text, its titles, its labels and its placeholder), a group folded and unfolded, and the two questions it asks before
  // it lets go of a folder or a conversation: real browser dialogs, answered with "no" so that nothing is removed.
  const sidebar = page.locator('aside').filter({ has: page.getByRole('button', { name: 'New Session', exact: true }) });
  await expect(sidebar).toHaveCount(1);
  await expectEnglishOnly(sidebar, 'Sidebar');
  // The bar above the conversation, the one below it and the Git branch picker the first one holds are English too (they were Vietnamese on this screen)
  const picker = page.getByRole('button', { name: 'Choose a Git branch and worktree', exact: true });
  const header = page.locator('header').filter({ has: picker });
  await expect(header).toHaveCount(1);
  await expectEnglishOnly(header, 'Header');
  await expect(header.getByRole('button', { name: 'Collapse conversations', exact: true })).toHaveAttribute('title', 'Conversation list (Ctrl+B)');
  await expect(header.getByRole('button', { name: 'Search or command', exact: true })).toBeVisible();
  await expectEnglishOnly(page.getByTestId('status-bar'), 'Status bar');
  await expect(page.getByTestId('status-bar')).toHaveAttribute('aria-label', 'Status');
  await picker.click();
  await expect(page.getByLabel('Git source branch', { exact: true })).toContainText('Current HEAD');
  await expect(page.getByText('Existing Git worktrees', { exact: true })).toBeVisible();
  await expectEnglishOnly(header, 'Header (the Git picker open)');
  await picker.click();
  const folder = path.basename(app.project);
  await expect(sidebar.getByLabel('Search conversations', { exact: true })).toBeVisible();
  await expect(sidebar.getByRole('button', { name: 'Add workspace', exact: true })).toHaveAttribute('title', 'Choose a folder with Windows Explorer');
  await sidebar.getByRole('button', { name: `Collapse group ${folder}`, exact: true }).click();
  await expect(sidebar.getByRole('button', { name: /^Delete conversation: / })).toHaveCount(0);
  await sidebar.getByRole('button', { name: `Expand group ${folder}`, exact: true }).click();
  await expect(sidebar.getByRole('button', { name: `Delete conversation: ${prompt}`, exact: true })).toHaveAttribute('title', 'Delete the conversation and its task history (files are not deleted)');
  const removeFolder = sidebar.getByRole('button', { name: `Remove workspace ${folder}`, exact: true });
  await expect(removeFolder).toHaveAttribute('title', 'Remove from DatGold — the folder on disk is not deleted');
  const question = async (target) => {
    const seen = new Promise((resolve) => page.once('dialog', (dialog) => { resolve(dialog.message()); void dialog.dismiss(); }));
    await target.click();
    return seen;
  };
  const conversations = await sidebar.getByRole('button', { name: /^Delete conversation: / }).count();
  expect(await question(removeFolder)).toBe(`Remove the workspace "${folder}" from DatGold?\n\n${conversations} conversation${conversations === 1 ? '' : 's'} and the workspace’s background tasks will be hidden from the interface. The history stays saved and comes back when you add the same folder again.\n\nThis does NOT delete the folder, files, Git branches or worktrees on this computer.`);
  expect(await question(sidebar.getByRole('button', { name: `Delete conversation: ${prompt}`, exact: true })))
    .toBe(`Delete the conversation "${prompt}"?\n\nThe history of its task turns will be removed from DatGold. This cannot be undone.\n\nThis does NOT delete project files, Git branches or worktrees.`);
  await expect(sidebar.getByRole('button', { name: `Delete conversation: ${prompt}`, exact: true })).toHaveCount(1);
  expect((await app.hub.task(chat.id)).id).toBe(chat.id);

  // The permission mode and the approvals: the toast of each click, and the history that stays under the conversation
  app.mock.define('write-after-asking', (ctx) => {
    if (ctx.turn > 0) return say('Xong.');
    const args = { path: ctx.prompt.includes('second') ? 'SECOND.md' : 'FIRST.md', content: 'hello\n' };
    return ctx.tools.includes('write_file') ? call('write_file', args) : call('mcp_call', { name: 'local.write_file', arguments_json: JSON.stringify(args) });
  });
  app.mock.setScenario('write-after-asking');
  await page.getByTitle('Agent Execution Mode', { exact: true }).click();
  await page.getByRole('menuitemradio', { name: /^Review/ }).click();
  await expect(page.getByText('Switched to review mode', { exact: true })).toBeVisible();
  const sendHere = async (text) => {
    // the Agents tab on the right has text boxes of its own: this is the one under the conversation
    await page.locator('#panel-conversation textarea').fill(text);
    await page.locator('#panel-conversation').getByRole('button', { name: 'Send', exact: true }).click();
  };
  const pending = page.getByRole('region', { name: /^Approval: local\./ });
  await sendHere('Please write the first file.');
  await expect(pending).toHaveCount(1);
  await page.getByRole('button', { name: 'Approve', exact: true }).and(page.locator(':enabled')).click();
  await expect(page.getByText('Action approved', { exact: true })).toBeVisible();
  await waitForState(app.hub, chat.id, 'completed');
  await expect(page.getByText('Approval history (1)', { exact: true })).toBeVisible();
  await sendHere('Please write the second file.');
  await expect(pending).toHaveCount(1);
  await page.getByRole('button', { name: 'Deny', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm denial', exact: true }).click();
  await expect(page.getByText('Action denied', { exact: true })).toBeVisible();
  await waitForState(app.hub, chat.id, 'completed');
  await expect(page.getByText('Approval history (2)', { exact: true })).toBeVisible();
  await expect(fs.stat(path.join(app.project, 'FIRST.md'))).resolves.toBeTruthy();
  await expect(fs.stat(path.join(app.project, 'SECOND.md'))).rejects.toThrow();

  // The channel: with the Hub set to ChatGPT Web, the open conversation says the next turn changes channel (and names the new one in bold), and a new
  // conversation shows the ChatGPT Web banner, with its hint in the tooltip
  await app.hub.post('/api/agent/mode', { mode: 'chatgpt-web' });
  const notice = page.getByTestId('transport-switch-notice');
  await expect(notice).toBeVisible();
  expect(await notice.innerText()).toBe('The next turn uses ChatGPT Web Companion. DatGold keeps the link to the earlier turns and passes on a summary of the context, but it does not assume the two models share a history. File writes that were not verified are not replayed automatically.');
  await expect(notice.locator('strong')).toHaveText('ChatGPT Web Companion');
  await expectEnglishOnly(notice, 'Channel notice');
  await sidebar.getByRole('button', { name: 'New Session', exact: true }).click();
  const web = page.getByTestId('chatgpt-web-mode-banner');
  await expect(web).toBeVisible();
  await expect(web.locator('span').first()).toHaveText('ChatGPT Web (text-only) · Pair the DatGold Hub Companion before sending a task');
  await expect(web.locator('span').first()).toHaveAttribute('title', 'The Web Companion channel only sends text through the ChatGPT tab for now; use the Model API to send images or attached files.');
  await expect(web.getByRole('button', { name: 'Set up', exact: true })).toBeVisible();
  await expectEnglishOnly(web, 'ChatGPT Web banner');
  await app.hub.post('/api/agent/mode', { mode: 'api' });
  await expect(web).toHaveCount(0);
});
