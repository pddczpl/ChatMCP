import fs from 'node:fs/promises';
import path from 'node:path';
import { test, expect, onboard, send, taskByPrompt, openWorkTab, openSettings, closeSettings, setTheme } from './fixtures.mjs';
import { waitForState } from '../../tests/e2e/hub-process.mjs';
import { say, call, toolText } from '../../tests/e2e/scenarios.mjs';

// The page of plan mode (P9 ac-11, docs/PLAN-MODE.md "The page"), with the production build, the real Hub and a scripted model. The model writes a checklist, proposes a plan
// with exit_plan_mode and waits; the owner reads it in a card of its own, edits it, approves it for an execution, or asks for changes. What is pinned is on the Hub and on disk:
// the flag is the task's (the permission mode never changes), the plan approved is the one the owner edited, the write runs, and the feedback is in the model's next turn.
// Nothing here waits for a time: every wait is for a thing on the page, an answer of the Hub or a file.

const STEPS = [{ text: 'Read calc.js', status: 'done', evidence: 'read_file calc.js' }, { text: 'Write result.txt', status: 'todo' }];
const PLAN = '## Plan\n\n1. Read **calc.js**.\n2. Write `result.txt`.';
const PROMPT = 'Plan it first, then write result.txt.';

/**
 * A model that plans, waits and then carries out what it was given. `heard` keeps what reached it: the text of the approved plan (a user message) and what exit_plan_mode answered
 * when it was not approved. The second proposal says what it was asked for.
 */
function planner(heard) {
  return (ctx) => {
    if (ctx.prompt.startsWith('APPROVED PLAN')) {
      if (ctx.turn === 0) heard.approved.push(ctx.prompt);
      return ctx.turn === 0 ? call('write_file', { path: 'result.txt', content: 'planned\n' }) : say('Written.');
    }
    if (ctx.turn === 0) return call('update_plan', { title: 'Result file', items: STEPS });
    if (ctx.turn === 1) return call('exit_plan_mode', { plan: PLAN });
    if (ctx.turn === 2) {
      heard.denied.push(toolText(ctx.last));
      return call('exit_plan_mode', { plan: `${PLAN}\n3. Check it.` });
    }
    return say('I wait.');
  };
}
async function setUp(app, page) {
  const heard = { approved: [], denied: [] };
  app.mock.define('planner', planner(heard));
  app.mock.setScenario('planner');
  await onboard(page, app);
  return heard;
}
const modeChip = (page) => page.locator('button[aria-haspopup="menu"][aria-expanded]').filter({ hasText: /Review|Kế hoạch/ });
const planItem = (page) => page.getByRole('menuitemcheckbox', { name: /^Kế hoạch/ });
async function choosePlan(page) {
  await modeChip(page).click();
  await planItem(page).click();
  await expect(modeChip(page)).toHaveText(/Kế hoạch · Review/);
}
const card = (page) => page.getByRole('region', { name: 'Duyệt kế hoạch', exact: true });
const composer = (page) => page.getByRole('textbox', { name: 'Tin nhắn cho agent' });
const planOf = async (app, id) => (await app.hub.get(`/api/studio/plan?taskId=${id}`)).json;
const result = (app) => fs.readFile(path.join(app.project, 'result.txt'), 'utf8').catch(() => null);
const permissions = async (app) => (await app.hub.state()).studio.permissions;
/** The task once its plan waits on the approval stack; `revision`: the proposal the card is about. */
async function planWaits(app, page, revision) {
  const task = await taskByPrompt(app, PROMPT);
  await expect.poll(async () => (await permissions(app)).pending.find((item) => item.taskId === task.id && item.category === 'plan')?.detail.revision).toBe(revision);
  await expect(card(page)).toBeVisible();
  await expect(card(page).getByText(`Bản ${revision}`, { exact: true })).toBeVisible();
  return task;
}
async function picture(page, testInfo, name, locator = page) {
  const body = await locator.screenshot({ animations: 'disabled' });
  await testInfo.attach(`${name}.png`, { body, contentType: 'image/png' });
  if (process.env.PLAN_MODE_SHOTS) await fs.writeFile(path.join(process.env.PLAN_MODE_SHOTS, `${name}.png`), body);
}
/** Every page of a test says whether the Content-Security-Policy of the Hub stopped anything on it. */
async function watchPolicy(page) {
  await page.addInitScript(() => { window.__violations = []; document.addEventListener('securitypolicyviolation', (event) => window.__violations.push(`${event.violatedDirective} ${event.blockedURI}`)); });
  return async () => expect(await page.evaluate(() => window.__violations)).toEqual([]);
}

test('a conversation starts in plan mode, the owner edits a step and the text in the card, approves for Autonomous, and the write runs', async ({ page, app }, testInfo) => {
  const clean = await watchPolicy(page);
  const heard = await setUp(app, page);

  // ---- the composer: a flag of this conversation, not the mode every conversation shares
  await modeChip(page).click();
  await expect(planItem(page)).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByRole('menuitemradio', { name: /^Review/ })).toHaveAttribute('aria-checked', 'true');
  await picture(page, testInfo, 'plan-composer-menu');
  await planItem(page).click();
  await expect(modeChip(page)).toHaveText(/Kế hoạch · Review/);
  expect((await permissions(app)).mode).toBe('review');
  await send(page, PROMPT);

  // ---- the card
  const task = await planWaits(app, page, 2);
  const held = await app.hub.task(task.id);
  expect([held.planMode, held.planOnly, held.planApproval]).toEqual([true, true, null]);
  expect((await permissions(app)).mode, 'choosing Plan changed no mode').toBe('review');
  await expect(page.getByTestId('plan-line')).toHaveText(/chờ bạn trả lời/);
  await expect(card(page).getByText('calc.js', { exact: true })).toHaveJSProperty('tagName', 'STRONG');
  await expect(card(page).getByTestId('plan-steps').getByRole('listitem')).toHaveCount(2);
  await expect(card(page).getByTestId('step-evidence')).toHaveText('read_file calc.js');
  await expect(modeChip(page), 'a held conversation shows Plan').toHaveText(/Kế hoạch · Review/);
  expect(await result(app), 'nothing is written while the plan waits').toBeNull();
  await picture(page, testInfo, 'plan-card', card(page));

  // ---- the editor of the card
  await card(page).getByRole('button', { name: 'Sửa kế hoạch', exact: true }).click();
  await expect(card(page).getByLabel('Tên kế hoạch', { exact: true })).toBeFocused();
  await card(page).getByRole('textbox', { name: 'Bước 2', exact: true }).fill('Write result.txt and say so');
  await card(page).getByLabel('Nội dung kế hoạch (Markdown)', { exact: true }).fill(`${PLAN}\n3. Edited by the owner.`);
  await picture(page, testInfo, 'plan-card-editor', card(page));
  await card(page).getByRole('button', { name: 'Xong', exact: true }).click();
  await expect(card(page).getByText('Có sửa đổi chưa lưu', { exact: true })).toBeVisible();
  await expect(card(page).getByTestId('plan-text')).toContainText('Edited by the owner.');
  expect((await planOf(app, task.id)).revision, 'an edit is not saved until it is approved or saved').toBe(2);

  // ---- approve: the edit is saved and approved, and the focus goes to the message box
  await card(page).getByRole('button', { name: 'Duyệt và chạy ở Tự động', exact: true }).click();
  await expect(composer(page)).toBeFocused();
  await expect(card(page)).toHaveCount(0);
  await waitForState(app.hub, task.id, 'completed');
  expect(await result(app), 'the write ran').toBe('planned\n');
  const done = await app.hub.task(task.id);
  expect(done.planApproval).toMatchObject({ status: 'approved', revision: 3, editedByUser: true, execution: 'autonomous' });
  expect(done.planOnly).toBe(false);
  const plan = await planOf(app, task.id);
  expect([plan.revision, plan.updatedBy, plan.approvedRevision]).toEqual([3, 'user', 3]);
  expect(plan.items).toEqual([{ text: 'Read calc.js', status: 'done', evidence: 'read_file calc.js' }, { text: 'Write result.txt and say so', status: 'todo', evidence: '' }]);
  expect(heard.approved, 'the model was given the edited plan, once').toHaveLength(1);
  expect(heard.approved[0]).toContain('Edited by the owner.');
  const gate = await permissions(app);
  expect(gate.recent.filter((entry) => entry.taskId === task.id && entry.toolName === 'local.write_file'), 'Autonomous asked nothing').toEqual([]);
  expect(gate.mode, 'and the mode of every other conversation is as it was').toBe('review');

  // ---- afterwards: Plan is off, the Plan tab says which revision was approved, the history keeps the answer
  await expect(modeChip(page)).toHaveText(/^Review/);
  await openWorkTab(page, 'Tiến độ');
  const tab = page.getByRole('region', { name: 'Kế hoạch của tác vụ' });
  await expect(tab.getByText('Bản này đã được duyệt', { exact: true })).toBeVisible();
  await expect(tab.getByText(/Bản 3 · bạn ghi lần cuối/)).toBeVisible();
  await picture(page, testInfo, 'plan-tab', tab);
  await clean();
});

test('the owner asks for changes: the feedback reaches the model, which proposes again, and a plan approved for Review asks before it writes', async ({ page, app }, testInfo) => {
  const clean = await watchPolicy(page);
  const heard = await setUp(app, page);
  await choosePlan(page);
  await send(page, PROMPT);
  const task = await planWaits(app, page, 2);

  // ---- Escape closes the box and gives the focus back; a request with no words cannot be sent
  const changes = card(page).getByRole('button', { name: 'Yêu cầu sửa', exact: true });
  await changes.focus();
  await page.keyboard.press('Enter');
  const box = card(page).getByLabel('Cần sửa gì trong kế hoạch?', { exact: true });
  await expect(box).toBeFocused();
  await expect(card(page).getByRole('button', { name: 'Gửi yêu cầu sửa', exact: true })).toBeDisabled();
  await page.keyboard.type('Half a thought');
  await page.keyboard.press('Escape');
  await expect(changes).toBeFocused();
  expect((await app.hub.task(task.id)).planApproval).toBeNull();

  // ---- with the keyboard alone: open, write, Tab to the button, send
  await page.keyboard.press('Enter');
  await expect(box, 'the words are still there').toHaveValue('Half a thought');
  await box.fill('FEEDBACK-7Q: check the file afterwards.');
  await picture(page, testInfo, 'plan-card-request-changes', card(page));
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(card(page).getByRole('button', { name: 'Gửi yêu cầu sửa', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(composer(page)).toBeFocused();

  // ---- the model read it and proposed again
  await planWaits(app, page, 3);
  expect(heard.denied, 'the answer of exit_plan_mode').toHaveLength(1);
  expect(heard.denied[0]).toContain('FEEDBACK-7Q: check the file afterwards.');
  await expect(card(page).getByTestId('plan-text')).toContainText('Check it.');
  expect((await app.hub.task(task.id)).planApproval).toMatchObject({ status: 'denied', revision: 2 });
  expect(await result(app), 'and nothing was written').toBeNull();

  // ---- approved for Review: the write is asked like any other
  await card(page).getByRole('button', { name: 'Duyệt và chạy ở Review', exact: true }).click();
  await expect(card(page)).toHaveCount(0);
  const write = page.getByRole('region', { name: 'Phê duyệt local.write_file' });
  await expect(write).toBeVisible();
  expect(await result(app)).toBeNull();
  await write.getByRole('button', { name: 'Phê duyệt', exact: true }).click();
  await waitForState(app.hub, task.id, 'completed');
  expect(await result(app)).toBe('planned\n');
  expect((await app.hub.task(task.id)).planApproval).toMatchObject({ status: 'approved', revision: 3, editedByUser: false, execution: 'review' });

  // ---- the history has the owner's words
  await page.getByText(/^Lịch sử phê duyệt/).click();
  await expect(page.getByText('Phản hồi của bạn: FEEDBACK-7Q: check the file afterwards.', { exact: true })).toBeVisible();
  await clean();
});

test('the Plan tab: a draft outlives the refetch and the tab, a change behind it is a conflict the owner settles, and the keyboard is enough', async ({ page, app }, testInfo) => {
  const clean = await watchPolicy(page);
  await setUp(app, page);
  await choosePlan(page);
  await send(page, PROMPT);
  const task = await planWaits(app, page, 2);
  await openWorkTab(page, 'Tiến độ');
  const tab = page.getByRole('region', { name: 'Kế hoạch của tác vụ' });
  const edit = tab.getByRole('button', { name: 'Sửa kế hoạch', exact: true });
  const step = (n) => tab.getByRole('textbox', { name: `Bước ${n}`, exact: true });
  const planRead = () => page.waitForResponse((response) => response.url().includes('/api/studio/plan?taskId=') && response.ok());

  // ---- open with the keyboard, reword, add, move and delete; the focus goes where the next key belongs
  await edit.focus();
  await page.keyboard.press('Enter');
  await expect(tab.getByLabel('Tên kế hoạch', { exact: true })).toBeFocused();
  await step(2).focus();
  await page.keyboard.press('Enter');
  await expect(step(3), 'Enter adds a step under this one').toBeFocused();
  await page.keyboard.type('Check the file');
  await expect(step(3)).toHaveValue('Check the file');
  await tab.getByRole('button', { name: 'Đưa bước 3 lên', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(step(2)).toHaveValue('Check the file');
  await expect(tab.getByRole('button', { name: 'Đưa bước 2 lên', exact: true }), 'the focus stays with the step that moved').toBeFocused();
  await page.keyboard.press('Enter');
  await expect(step(1)).toHaveValue('Check the file');
  await expect(tab.getByRole('button', { name: 'Đưa bước 1 xuống', exact: true }), 'the first step cannot go up').toBeFocused();
  await page.keyboard.press('Enter');
  await expect(step(2)).toHaveValue('Check the file');
  await tab.getByRole('button', { name: 'Thêm bước', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(step(4)).toBeFocused();
  await expect(tab.getByTestId('plan-why')).toHaveText(/chưa có nội dung/);
  await expect(tab.getByRole('button', { name: 'Lưu kế hoạch', exact: true })).toBeDisabled();
  await tab.getByRole('button', { name: 'Xóa bước 4', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(step(3), 'the step that is there now').toBeFocused();
  await expect(step(4)).toHaveCount(0);
  await step(1).fill('Read calc.js and test.js');
  await expect(tab.getByText(/Dấu hoàn tất và bằng chứng của agent là cho lời cũ/)).toBeVisible();
  await step(1).fill('Read calc.js');
  await expect(tab.getByTestId('step-evidence'), 'the old words have their evidence again').toHaveText('read_file calc.js');

  // ---- two more reads of the plan by the page, another tab and back: the draft is as it was left
  await planRead();
  await planRead();
  await openWorkTab(page, 'Tệp');
  await openWorkTab(page, 'Tiến độ');
  await expect(step(2)).toHaveValue('Check the file');
  await expect(tab.getByText('Có sửa đổi chưa lưu', { exact: true })).toBeVisible();
  expect((await planOf(app, task.id)).revision).toBe(2);
  await picture(page, testInfo, 'plan-tab-editor', tab);

  // ---- another window of the owner saves: the page hears of it at its next read, says so and takes nothing away
  const other = await planOf(app, task.id);
  await app.hub.post('/api/studio/plan/set', { taskId: task.id, title: 'From another window', items: other.items, text: `${PLAN}\n3. From another window.`, baseRevision: 2 });
  const conflict = tab.getByTestId('plan-conflict');
  await expect(conflict).toBeVisible();
  await expect(conflict).toContainText('Bản 3 đã được lưu từ một cửa sổ khác của bạn trong lúc bạn sửa bản 2');
  await expect(step(2), 'the draft is there').toHaveValue('Check the file');
  await expect(tab.getByRole('button', { name: 'Lưu kế hoạch', exact: true })).toBeDisabled();
  await expect(card(page).getByTestId('plan-conflict'), 'the card of the same plan says the same').toBeVisible();
  await expect(card(page).getByRole('button', { name: 'Duyệt và chạy ở Review', exact: true })).toBeDisabled();
  await conflict.getByText('Xem bản 3', { exact: true }).click();
  await expect(conflict.getByText('From another window', { exact: true })).toBeVisible();
  await picture(page, testInfo, 'plan-tab-conflict', tab);
  await conflict.getByRole('button', { name: 'Giữ sửa đổi của tôi trên bản 3', exact: true }).click();
  await expect(conflict).toHaveCount(0);
  await expect(tab.getByLabel('Tên kế hoạch', { exact: true }), 'what the owner did not touch is the other window\'s').toHaveValue('From another window');
  await expect(step(2)).toHaveValue('Check the file');

  // ---- save with the keyboard: the edit button has the focus back, the evidence is the agent's
  await tab.getByRole('button', { name: 'Lưu kế hoạch', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(edit).toBeFocused();
  await expect(tab.getByText(/Bản 4 · bạn ghi lần cuối/)).toBeVisible();
  expect((await planOf(app, task.id)).items).toEqual([
    { text: 'Read calc.js', status: 'done', evidence: 'read_file calc.js' }, { text: 'Check the file', status: 'todo', evidence: '' }, { text: 'Write result.txt', status: 'todo', evidence: '' },
  ]);

  // ---- dropping edits asks first
  await edit.click();
  await step(1).fill('Something else');
  await tab.getByRole('button', { name: 'Bỏ sửa đổi', exact: true }).click();
  const question = page.getByRole('alertdialog', { name: 'Bỏ các sửa đổi chưa lưu?' });
  await question.getByRole('button', { name: 'Hủy', exact: true }).click();
  await expect(step(1)).toHaveValue('Something else');
  await tab.getByRole('button', { name: 'Bỏ sửa đổi', exact: true }).click();
  await question.getByRole('button', { name: 'Bỏ sửa đổi', exact: true }).click();
  await expect(edit).toBeVisible();

  // ---- the card is about the plan as it is now: the owner's edit, saved, is what an approval answers
  await expect(card(page).getByText('Bạn đã sửa kế hoạch sau khi agent đề xuất (bản 2).', { exact: true })).toBeVisible();
  await setTheme(page, 'light');
  await picture(page, testInfo, 'plan-card-light');
  await card(page).getByRole('button', { name: 'Duyệt và chạy ở Tự động', exact: true }).click();
  await waitForState(app.hub, task.id, 'completed');
  expect((await app.hub.task(task.id)).planApproval).toMatchObject({ status: 'approved', revision: 4, editedByUser: true, execution: 'autonomous' });
  await clean();
});

test('a plan that moved on behind the card is not approved: the Hub answers 409, the card shows the plan as it is now, and that is what the next approval is about', async ({ page, app, browserErrors }) => {
  // The page's timers are stopped at the right moment (they run as usual until then), so that it cannot read the plan again between the other window's save and the click.
  await page.clock.install();
  await setUp(app, page);
  await choosePlan(page);
  await send(page, PROMPT);
  const task = await planWaits(app, page, 2);
  const reading = new Set();
  const isPlanRead = (request) => request.method() === 'GET' && request.url().includes('/api/studio/plan?taskId=');
  page.on('request', (request) => { if (isPlanRead(request)) reading.add(request); });
  for (const event of ['requestfinished', 'requestfailed']) page.on(event, (request) => reading.delete(request));
  await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 1_000);
  await expect.poll(() => reading.size, { message: 'no read of the plan is under way' }).toBe(0);
  await expect(card(page).getByText('Bản 2', { exact: true })).toBeVisible();

  const other = await planOf(app, task.id);
  await app.hub.post('/api/studio/plan/set', { taskId: task.id, title: other.title, items: other.items, text: 'Another plan.', baseRevision: 2 });
  const decided = page.waitForResponse((response) => response.url().endsWith('/api/studio/plan/decide'));
  await card(page).getByRole('button', { name: 'Duyệt và chạy ở Tự động', exact: true }).click();
  const refused = await decided;
  expect(refused.status()).toBe(409);
  expect(refused.request().postDataJSON()).toEqual({ taskId: task.id, revision: 2, decision: 'approve', execution: 'autonomous' });
  await page.clock.resume();

  await expect(page.getByText('Kế hoạch vừa đổi: chưa lưu hay duyệt gì. Đọc bản hiện tại rồi thử lại.', { exact: true })).toBeVisible();
  await expect(card(page).getByText('Bản 3', { exact: true })).toBeVisible();
  await expect(card(page).getByTestId('plan-text')).toContainText('Another plan.');
  expect((await app.hub.task(task.id)).planOnly, 'nothing was approved').toBe(true);
  expect(await result(app)).toBeNull();
  await card(page).getByRole('button', { name: 'Duyệt và chạy ở Tự động', exact: true }).click();
  await waitForState(app.hub, task.id, 'completed');
  expect((await app.hub.task(task.id)).planApproval).toMatchObject({ status: 'approved', revision: 3, editedByUser: true });

  // The only complaints are about the one 409 that was provoked on purpose; anything else still fails the test.
  await browserErrors.flush(page);
  const provoked = browserErrors.errors.splice(0);
  expect(provoked.filter((line) => /^HTTP 409: .*\/api\/studio\/plan\/decide$/.test(line))).toHaveLength(1);
  expect(provoked.filter((line) => /^Console: Failed to load resource: the server responded with a status of 409/.test(line))).toHaveLength(1);
  expect(provoked.filter((line) => /^API error: .*\/api\/studio\/plan\/decide: .*plan_conflict/.test(line))).toHaveLength(1);
  expect(provoked, `nothing else: ${JSON.stringify(provoked)}`).toHaveLength(3);
});

test('with the Browser Companion as the transport there is no Plan entry, and a follow-up of a plan-mode conversation on the Model API keeps it', async ({ page, app }) => {
  await setUp(app, page);
  await modeChip(page).click();
  await expect(planItem(page)).toBeVisible();
  await planItem(page).click();
  await app.hub.post('/api/agent/mode', { mode: 'chatgpt-web' });
  await expect(page.getByTestId('chatgpt-web-mode-banner')).toBeVisible();
  await expect(modeChip(page), 'a Plan that was chosen is not shown either').toHaveText(/^Review/);
  await modeChip(page).click();
  await expect(page.getByRole('menuitemradio', { name: /^Review/ })).toBeVisible();
  await expect(planItem(page)).toHaveCount(0);
  await page.keyboard.press('Escape');
  await app.hub.post('/api/agent/mode', { mode: 'api' });
  await expect(page.getByTestId('chatgpt-web-mode-banner')).toHaveCount(0);

  await expect(modeChip(page)).toHaveText(/Kế hoạch · Review/);
  await send(page, PROMPT);
  const task = await planWaits(app, page, 2);
  await page.getByTestId('task-status').getByRole('button', { name: 'Dừng agent', exact: true }).click();
  await waitForState(app.hub, task.id, 'cancelled');
  await expect(page.getByTestId('plan-line')).toHaveText(/không sửa được gì cho tới khi bạn duyệt/);
  await modeChip(page).click();
  await expect(planItem(page), 'a held conversation cannot leave plan mode from here').toHaveAttribute('aria-disabled', 'true');
  await expect(planItem(page)).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Tiếp tục', exact: true }).click();
  await expect.poll(async () => (await permissions(app)).pending.some((item) => item.taskId === task.id && item.category === 'plan')).toBe(true);
  const again = await app.hub.task(task.id);
  expect([again.planMode, again.planOnly]).toEqual([true, true]);
  await expect(card(page)).toBeVisible();
});

const VIETNAMESE = /[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/i;
/** No Vietnamese in the text of a panel, nor in a title, a label or a placeholder of it. */
async function expectEnglish(panel, label) {
  expect(await panel.innerText(), label).not.toMatch(VIETNAMESE);
  const named = await panel.evaluate((root) => [...root.querySelectorAll('[title],[aria-label],[placeholder]')].flatMap((node) => ['title', 'aria-label', 'placeholder'].map((name) => node.getAttribute(name) ?? '')));
  expect(named.filter((text) => VIETNAMESE.test(text)), `${label}: a title, a label or a placeholder`).toEqual([]);
}

test('in English the card, its editor, the feedback box, the menu, the banner and the Plan tab read in one language', async ({ page, app }, testInfo) => {
  await setUp(app, page);
  await choosePlan(page);
  await send(page, PROMPT);
  const task = await planWaits(app, page, 2);
  const dialog = await openSettings(page, 'Giao diện & ngôn ngữ');
  await dialog.getByRole('button', { name: 'English' }).click();
  await closeSettings(page);
  const english = page.getByRole('region', { name: 'Plan approval', exact: true });
  await expect(english).toBeVisible();
  await expectEnglish(english, 'the card');
  await expect(page.getByTestId('plan-line')).toHaveText('The plan waits for your answer in the card below; the task is read-only.');
  await picture(page, testInfo, 'plan-card-english', english);
  await english.getByRole('button', { name: 'Edit plan', exact: true }).click();
  await expectEnglish(english, 'the editor');
  await english.getByRole('textbox', { name: 'Step 1', exact: true }).fill('Read calc.js and test.js');
  await expect(english.getByText("The agent's mark and evidence were for the old words: saving drops them.", { exact: true })).toBeVisible();
  await english.getByRole('button', { name: 'Request changes', exact: true }).click();
  await expect(english.getByText('Your unsaved edits are not sent with it: save them in the Progress tab if the agent should see them.', { exact: true })).toBeVisible();
  await expectEnglish(english, 'the feedback box');
  await english.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.locator('button[aria-haspopup="menu"]').filter({ hasText: /Plan · Review/ }).click();
  await expect(page.getByRole('menuitemcheckbox', { name: /^Plan/ })).toContainText('This conversation is read-only until you approve its plan.');
  await expectEnglish(page.getByRole('menu'), 'the menu');
  await page.keyboard.press('Escape');
  await openWorkTab(page, 'Progress');
  const tab = page.getByRole('region', { name: 'Task plan' });
  await expect(tab.getByRole('textbox', { name: 'Step 1', exact: true }), 'the tab has the draft of the card').toHaveValue('Read calc.js and test.js');
  await expectEnglish(tab, 'the editor of the tab');
  await english.getByRole('button', { name: 'Approve and run in Autonomous', exact: true }).click();
  await waitForState(app.hub, task.id, 'completed');
  await expect(tab.getByText('Revision 3 · last written by you')).toBeVisible();
  await expectEnglish(tab, 'the tab');
  expect((await planOf(app, task.id)).items[0], 'a step the owner reworded has no mark of the agent').toEqual({ text: 'Read calc.js and test.js', status: 'todo', evidence: '' });
});
