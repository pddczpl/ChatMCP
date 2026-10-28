// The owner's switch for the project's AGENTS.md / CLAUDE.md, against the real Hub and the production build of the page: Settings → Dự án flips the Hub's setting
// (POST /api/agent/project-instructions), the next request of the model server follows it, and the line under a finished turn says what the Hub loaded without
// ever looking like evidence. The model is scripted; the Hub, the routes and the page are not.
import fs from 'node:fs/promises';
import path from 'node:path';
import { test, expect, onboard, openSettings, closeSettings, send, setTheme, taskByPrompt } from './fixtures.mjs';
import { pendingApprovals, waitFor, waitForState } from '../../tests/e2e/hub-process.mjs';
import { call, say } from '../../tests/e2e/scenarios.mjs';

const ROUTE = '/api/agent/project-instructions';
const MARK = 'PW-AGENTS-MARK-7d21';
const AGENTS = `# Quy ước\n${MARK}\nChạy node test.js trước khi kết thúc.\n`;
const isSwitch = (response) => new URL(response.url()).pathname === ROUTE && response.request().method() === 'POST';

/** What the model server was sent: the number of times AGENTS.md was in the system prompt of each request. */
function recordGuidance(app) {
  const seen = [];
  app.mock.define('record-guidance', (ctx) => { seen.push(ctx.system.split(MARK).length - 1); return say('Đã xem xong dự án.'); });
  app.mock.setScenario('record-guidance');
  return seen;
}

/** Sends the first message of a conversation and waits until the Hub has finished the run; returns the task id. */
async function firstTurn(page, app, prompt) {
  await send(page, prompt);
  const task = await taskByPrompt(app, prompt);
  await waitForState(app.hub, task.id, 'completed');
  return task.id;
}

test('Settings flips the switch, the Hub and the next request follow, and the line under the turn says what was loaded', async ({ page, app, browserErrors }, testInfo) => {
  await fs.writeFile(path.join(app.project, 'AGENTS.md'), AGENTS);
  const seen = recordGuidance(app);
  await onboard(page, app);

  // ---- Settings → Dự án: on by default, with the explanation in plain words ---------------------------------------------------------------------
  const dialog = await openSettings(page, 'Dự án');
  const card = dialog.getByTestId('project-instructions-settings');
  const toggle = card.getByTestId('project-instructions-toggle');
  await expect(dialog.getByRole('heading', { name: 'Hướng dẫn của dự án', exact: true })).toBeVisible();
  await expect(toggle).toBeChecked();
  await expect(toggle).toBeEnabled();
  await expect(card.getByTestId('project-instructions-status')).toContainText('Đang bật (mặc định).');
  await expect(card).toContainText('AGENTS.md · CLAUDE.md · .claude/CLAUDE.md');
  for (const words of ['văn bản không tin cậy do người viết dự án đặt', 'tối đa 8.192 byte', 'không thể nâng quyền hay bỏ qua bước duyệt', 'agent vẫn có thể mở các tệp này bằng công cụ đọc tệp', 'áp dụng từ lượt chạy kế tiếp']) {
    await expect(card, words).toContainText(words);
  }
  expect((await app.hub.state()).projectInstructions).toMatchObject({ enabled: true, source: 'default', saved: null });
  await page.screenshot({ path: testInfo.outputPath('settings-default.png'), animations: 'disabled' });

  // ---- turning it off ------------------------------------------------------------------------------------------------------------------------------
  const off = page.waitForResponse(isSwitch);
  await toggle.click(); // a controlled box: it shows the saved value once the Hub confirms
  const answered = await off;
  expect(answered.status()).toBe(200);
  expect(answered.request().postDataJSON()).toEqual({ enabled: false });
  await expect(toggle).not.toBeChecked();
  await expect(card.getByTestId('project-instructions-status')).toContainText('Đang tắt (bạn đã chọn).');
  await expect(dialog.getByText('Đã tắt nạp AGENTS.md / CLAUDE.md từ lượt chạy kế tiếp.', { exact: true })).toBeVisible();
  expect((await app.hub.state()).projectInstructions).toMatchObject({ enabled: false, source: 'config', saved: false });
  expect(JSON.parse(await fs.readFile(path.join(app.hub.stateDir, 'project-instructions.json'), 'utf8'))).toEqual({ version: 1, enabled: false });

  // The choice is the Hub's, not the tab's: a reloaded page finds it.
  await browserErrors.flush(page);
  await page.reload();
  await openSettings(page, 'Dự án');
  await expect(toggle).not.toBeChecked();
  await expect(card.getByTestId('project-instructions-status')).toContainText('Đang tắt (bạn đã chọn).');
  await closeSettings(page);

  // ---- a turn with it off ---------------------------------------------------------------------------------------------------------------------------
  const first = 'Hãy mô tả dự án này.';
  const taskId = await firstTurn(page, app, first);
  expect(seen, 'the model server was sent no AGENTS.md').toEqual([0]);
  const offNote = page.getByTestId('project-instructions-note');
  await expect(offNote).toBeVisible();
  await expect(offNote).toHaveAttribute('data-kind', 'off');
  await expect(offNote).toContainText('Hướng dẫn dự án: tắt');
  await expect(offNote).toContainText('agent vẫn có thể tự mở chúng bằng công cụ đọc tệp');
  await expect(page.getByTestId('project-instructions-file')).toHaveCount(0);

  // ---- turning it on, and the next turn of the same conversation ---------------------------------------------------------------------------------------
  await openSettings(page, 'Dự án');
  const on = page.waitForResponse(isSwitch);
  await toggle.click();
  expect((await on).status()).toBe(200);
  await expect(toggle).toBeChecked();
  await expect(card.getByTestId('project-instructions-status')).toContainText('Đang bật (bạn đã chọn).');
  expect((await app.hub.state()).projectInstructions).toMatchObject({ enabled: true, source: 'config', saved: true });
  await closeSettings(page);

  await send(page, 'Còn các bài kiểm thử thì sao?');
  await waitFor(async () => { const full = await app.hub.task(taskId); return full.runs?.length === 2 && full.state === 'completed'; }, { label: 'the second run to complete' });
  expect(seen, 'the second request was sent AGENTS.md once').toEqual([0, 1]);
  const record = (await app.hub.task(taskId)).projectInstructions;
  expect(record.files.map((file) => `${file.path}:${file.status}`)).toEqual(['AGENTS.md:loaded']);
  const note = page.getByTestId('project-instructions-note');
  await expect(note).toHaveAttribute('data-kind', 'files');
  await expect(page.getByTestId('project-instructions-file')).toHaveText(`AGENTS.md · ${record.files[0].loadedBytes} B`);
  await expect(note).toContainText('Hướng dẫn dự án đã nạp');
  await expect(note).toContainText('Nạp vào chỉ dẫn không có nghĩa là model đã làm theo');
  await expect(note).toContainText('không tin cậy');

  // The line under it that says which skills the Hub took for this run, or why none: this request names no skill, so it says that, and it is a record in the same neutral
  // colours, drawn after the project instructions.
  const skills = (await app.hub.task(taskId)).skillSelection;
  expect(skills, 'the Hub served the record of the run').toMatchObject({ reason: 'no_match', selected: [], threshold: 3 });
  const skillNote = page.getByTestId('skill-selection-note');
  await expect(skillNote).toHaveAttribute('data-kind', 'none');
  await expect(skillNote).toContainText('Không chọn kỹ năng nào cho lượt này');
  await expect(skillNote).toContainText(`Yêu cầu không nhắc tới việc nào của ${skills.considered} kỹ năng đang bật`);
  await expect(skillNote).toContainText('chỉ hiểu một số cụm tiếng Việt thường gặp, nên có thể bỏ sót');
  expect(await page.evaluate(() => {
    const first = document.querySelector('[data-testid="project-instructions-note"]');
    const second = document.querySelector('[data-testid="skill-selection-note"]');
    return Boolean(first && second && (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING));
  }), 'after the line about the project instructions').toBe(true);
  expect(await skillNote.evaluate((element) => element.outerHTML)).not.toMatch(/text-success|bg-success|border-success|text-danger|bg-danger|text-warning|bg-warning|lucide-check|lucide-shield|lucide-circle-check/);
  for (const theme of ['light', 'dark']) {
    await setTheme(page, theme);
    await page.screenshot({ path: testInfo.outputPath(`turn-note-${theme}.png`), animations: 'disabled' });
  }

  // Loaded is not proven: nothing in the line is drawn like a verified result.
  const html = await note.evaluate((element) => element.outerHTML);
  expect(html).not.toMatch(/success|danger|warning|lucide-check|lucide-shield|lucide-circle-check|xác minh|đã xác thực|bằng chứng/i);
  await expect(page.getByTestId('proof-strip')).toHaveCount(0);
  const borders = await note.evaluate((element) => { const style = getComputedStyle(element); return [style.borderTopColor, style.backgroundColor]; });
  expect(borders.join(' '), 'neutral surface and border, not the green of a verified check').not.toMatch(/rgb\((?:[0-9]{1,2}|1[0-4][0-9]), (?:1[5-9][0-9]|2[0-9]{2}), /);

  // ---- a narrow window: the line wraps and the card fits, nothing scrolls sideways --------------------------------------------------------------------------
  await page.setViewportSize({ width: 640, height: 900 });
  await expect(note).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'the conversation does not scroll sideways').toBe(true);
  await page.screenshot({ path: testInfo.outputPath('narrow-turn-note.png'), animations: 'disabled' });
  await openSettings(page, 'Dự án');
  await expect(card).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Settings does not scroll sideways').toBe(true);
  await page.screenshot({ path: testInfo.outputPath('narrow-settings-card.png'), animations: 'disabled' });
  await closeSettings(page);
  await page.setViewportSize({ width: 1600, height: 1000 });

  // ---- the same words in English, from the real language switch --------------------------------------------------------------------------------------
  await openSettings(page, 'Giao diện & ngôn ngữ');
  await page.getByRole('button', { name: 'English', exact: true }).click();
  const english = page.getByRole('dialog', { name: 'Settings', exact: true });
  await english.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Project', exact: true }).click();
  await expect(english.getByRole('heading', { name: 'Project instructions', exact: true })).toBeVisible();
  await expect(english.getByTestId('project-instructions-status')).toContainText('On (your choice).');
  await expect(english.getByTestId('project-instructions-settings')).toContainText('Off only means the Hub does not load them itself');
  await expect(english.getByTestId('project-instructions-settings')).toContainText('cannot raise permissions or skip an approval');
  await page.keyboard.press('Escape');
  await expect(english).toHaveCount(0);
  await expect(note).toContainText('Project instructions loaded');
  await expect(note).toContainText('does not mean the model followed it');
});

test('a task is waiting for an approval: the switch still works, says when the change applies, and that run keeps what it loaded', async ({ page, app }) => {
  await fs.writeFile(path.join(app.project, 'AGENTS.md'), AGENTS);
  const seen = [];
  app.mock.define('hold-for-approval', (ctx) => {
    seen.push(ctx.system.split(MARK).length - 1);
    return ctx.turn === 0 ? call('run_command', { command: 'echo hi > hi.txt', description: 'as AGENTS.md says' }) : say('Đã dừng: lệnh không được phép.');
  });
  app.mock.setScenario('hold-for-approval');
  await onboard(page, app);
  const prompt = 'Hãy chạy bản dựng theo AGENTS.md.';
  await send(page, prompt);
  const task = await taskByPrompt(app, prompt);
  const request = await waitFor(async () => (await pendingApprovals(app.hub)).find((entry) => entry.taskId === task.id), { label: 'the command to be put to the person' });
  expect(seen, 'the run began with the block').toEqual([1]);

  const dialog = await openSettings(page, 'Dự án');
  const card = dialog.getByTestId('project-instructions-settings');
  const toggle = card.getByTestId('project-instructions-toggle');
  await expect(card.getByTestId('project-instructions-running')).toContainText('Có tác vụ đang chạy: thay đổi áp dụng từ lượt chạy kế tiếp.');
  await expect(toggle, 'the Hub accepts the change while a task runs, so the page does not lock it').toBeEnabled();
  const saved = page.waitForResponse(isSwitch);
  await toggle.click();
  expect((await saved).status()).toBe(200);
  await expect(toggle).not.toBeChecked();
  expect((await app.hub.state()).projectInstructions).toMatchObject({ enabled: false, source: 'config', saved: false });
  await closeSettings(page);

  await app.hub.post('/api/studio/permissions/decide', { id: request.id, approved: false });
  await waitForState(app.hub, task.id, 'completed');
  expect(seen, 'the run that was going kept its block').toEqual([1, 1]);
  const note = page.getByTestId('project-instructions-note');
  await expect(note, 'and its line says what it was given, not what the setting is now').toHaveAttribute('data-kind', 'files');
  await expect(page.getByTestId('project-instructions-file')).toContainText('AGENTS.md');
});

test.describe('with CHATMCP_PROJECT_INSTRUCTIONS set in the environment of the Hub', () => {
  test.use({ hubEnv: { CHATMCP_PROJECT_INSTRUCTIONS: 'off' } });

  test('the switch shows what the variable says, cannot be used, and the turn still says what it did', async ({ page, app, browserErrors }) => {
    await fs.writeFile(path.join(app.project, 'AGENTS.md'), AGENTS);
    const seen = recordGuidance(app);
    await onboard(page, app);
    const dialog = await openSettings(page, 'Dự án');
    const card = dialog.getByTestId('project-instructions-settings');
    const toggle = card.getByTestId('project-instructions-toggle');
    await expect(toggle).not.toBeChecked();
    await expect(toggle).toBeDisabled();
    await expect(card.getByTestId('project-instructions-status')).toContainText('Đang tắt do biến môi trường của Hub:');
    await expect(card.getByTestId('project-instructions-status').locator('code')).toHaveText('CHATMCP_PROJECT_INSTRUCTIONS');
    await expect(card.getByTestId('project-instructions-locked')).toContainText('Không đổi được ở đây. Bỏ biến môi trường rồi khởi động lại Hub');
    expect((await app.hub.state()).projectInstructions).toMatchObject({ enabled: false, source: 'env', saved: null });
    // A disabled control sends nothing: the page never asks the Hub for what the Hub would refuse.
    expect([...browserErrors.requests]).not.toContain(ROUTE);
    // And the Hub refuses it all the same.
    const refused = await app.hub.request('POST', ROUTE, { enabled: true });
    expect([refused.status, refused.json?.code]).toEqual([409, 'project_instructions_env']);
    await closeSettings(page);

    await firstTurn(page, app, 'Hãy mô tả dự án này.');
    expect(seen).toEqual([0]);
    await expect(page.getByTestId('project-instructions-note')).toHaveAttribute('data-kind', 'off');
  });
});

test('the line under the turn names the skill the Hub took and on what grounds: a Vietnamese phrase counts as its English word, the kind of project supports it, an earlier message carries it', async ({ page, app }, testInfo) => {
  await fs.writeFile(path.join(app.project, 'Dockerfile'), 'FROM node:22\n');
  app.mock.define('quiet', () => say('Xong.'));
  app.mock.setScenario('quiet');
  await onboard(page, app);
  const taskId = await firstTurn(page, app, 'Tạo nhánh mới tên feature/export-csv rồi chuyển sang nhánh đó.');

  // What the real Hub served for the run ...
  const record = (await app.hub.task(taskId)).skillSelection;
  expect(record.reason).toBe('selected');
  expect(record.selected.map((item) => [item.id, item.source])).toContainEqual(['git-workflow-pro', 'run']);
  expect(record.concepts).toEqual([{ phrase: 'nhánh', words: ['branch'] }]);
  expect(record.project.map((signal) => signal.label)).toContain('Dockerfile');

  // ... and what the production page draws from it.
  const skillNote = page.getByTestId('skill-selection-note');
  const git = skillNote.getByTestId('skill-selection-skill').filter({ hasText: 'Git Workflow Pro' });
  await expect(skillNote).toHaveAttribute('data-kind', 'selected');
  await expect(skillNote).toContainText('Kỹ năng đã chọn cho lượt này');
  await expect(git).toContainText('“nhánh” → branch');
  await expect(skillNote).toContainText('Hub thấy dự án có:');
  await expect(skillNote).toContainText('Dockerfile');
  await expect(skillNote).toContainText('không có nghĩa là model đã làm theo');
  await page.screenshot({ path: testInfo.outputPath('skills-turn-note.png'), animations: 'disabled' });

  // The next message names no skill: the one of the first message is carried, and the line says where it comes from.
  await send(page, 'Cảm ơn nhé.');
  await waitFor(async () => { const full = await app.hub.task(taskId); return full.runs?.length === 2 && full.state === 'completed'; }, { label: 'the second run to complete' });
  await expect(git).toContainText('từ tin nhắn trước');
  expect((await app.hub.task(taskId)).skillSelection.selected.map((item) => item.source)).not.toContain('run');

  // A narrow window: the line wraps, nothing scrolls sideways.
  await page.setViewportSize({ width: 640, height: 900 });
  await expect(skillNote).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'the conversation does not scroll sideways').toBe(true);
  await page.setViewportSize({ width: 1600, height: 1000 });

  // The same line in English, from the real language switch.
  await openSettings(page, 'Giao diện & ngôn ngữ');
  await page.getByRole('button', { name: 'English', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(skillNote).toContainText(/Skills chosen for this turn: \d/);
  await expect(skillNote).toContainText('from an earlier message');
  await expect(skillNote).toContainText('does not mean the model followed it');
});
