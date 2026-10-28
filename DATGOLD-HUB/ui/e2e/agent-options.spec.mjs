// The owner's two agent options, against the real Hub and the production build of the page. Settings → Dự án shows the percent from which the history is compacted (80 when none is chosen) and
// the switch "the Hub accepts the checks it ran", with the warning that it relaxes "only you accept"; each is saved by the Hub (POST /api/agent/options) and found again after a reload. With the
// switch on, the Hub matches the check it ran to the criterion that asks for one, but only after the owner accepted the objective before it; the page tags that criterion, the evidence says
// acceptedBy "auto_hub_check", and the owner can take it over. With the switch off (the default) the Hub accepts nothing. The model is scripted; the Hub, the routes and the page are not.
import fs from 'node:fs/promises';
import path from 'node:path';
import { test, expect, onboard, openSettings, closeSettings, send, taskByPrompt } from './fixtures.mjs';
import { answerApprovals } from '../../tests/e2e/hub-process.mjs';
import { call, sequence, shaOf } from '../../tests/e2e/scenarios.mjs';

const ROUTE = '/api/agent/options';
const isOptions = (response) => new URL(response.url()).pathname === ROUTE && response.request().method() === 'POST';
const PROMPT = '1. Inspect source files and project requirements, capture independently verified read evidence before editing any source code.\n2. Implement a bounded source patch and test the changed code thoroughly with real command exit status and actual Git review evidence.';
const optionsFile = (app) => path.join(app.hub.stateDir, 'agent-options.json');
const readOptionsFile = async (app) => { try { return JSON.parse(await fs.readFile(optionsFile(app), 'utf8')); } catch { return null; } };

/** The scripted model: reads calc.js, edits it, reads it again and runs node test.js, so that the Hub holds a receipt of each kind (an edit clears the inspections made before it). */
function repairScenario(app) {
  app.mock.define('repair-read-test', sequence([
    call('read_file', { path: 'calc.js' }),
    ({ last }) => call('edit_file', { path: 'calc.js', old_string: 'return a - b;', new_string: 'return a + b;', expected_sha256: shaOf(last) }),
    call('read_file', { path: 'calc.js' }),
    call('run_command', { command: 'node test.js', description: 'Chạy kiểm thử của hàm add()' }),
  ], { final: 'Đã sửa add() trong calc.js và chạy node test.js: thành công.' }));
  app.mock.setScenario('repair-read-test');
}

test('Settings shows both options with the warning, saves each through the Hub, refuses what is not a percent, and a reload finds them', async ({ page, app, browserErrors }, testInfo) => {
  await onboard(page, app);
  const dialog = await openSettings(page, 'Dự án');
  const card = dialog.getByTestId('agent-options-settings');
  const percent = card.getByTestId('agent-options-percent');
  const save = card.getByTestId('agent-options-percent-save');
  const reset = card.getByTestId('agent-options-percent-reset');
  const toggle = card.getByTestId('agent-options-auto-accept');
  await expect(dialog.getByRole('heading', { name: 'Tác tử: nén ngữ cảnh và chấp nhận check', exact: true })).toBeVisible();

  // ---- the defaults, and the warning that is always on the page ---------------------------------------------------------------------------------
  await expect(percent).toHaveValue('80');
  await expect(card.getByTestId('agent-options-percent-status')).toContainText('Đang nén từ 80% (mặc định).');
  await expect(save).toBeDisabled();
  await expect(reset).toBeDisabled();
  await expect(toggle).not.toBeChecked();
  await expect(card.getByTestId('agent-options-auto-accept-status')).toContainText('Đang tắt (mặc định): chỉ bạn chấp nhận bằng chứng.');
  for (const words of ['nới lỏng cam kết "chỉ bạn chấp nhận"', 'acceptedBy "auto_hub_check"', 'vẫn chỉ do bạn chấp nhận', 'thoát với mã 0', 'ít nhất ba cặp lời gọi/kết quả mới nhất', 'Kiểm tra giữ lại thông tin: n/m']) {
    await expect(card, words).toContainText(words);
  }
  expect((await app.hub.state()).agentOptions).toMatchObject({ autoCompactPercent: 80, autoCompactSaved: null, autoAcceptChecks: false, defaultCompactPercent: 80, minCompactPercent: 50, maxCompactPercent: 95 });
  expect(await readOptionsFile(app), 'nothing is written until the owner chooses').toBeNull();
  await page.screenshot({ path: testInfo.outputPath('settings-default.png'), animations: 'disabled' });

  // ---- what is not a percent is not sent --------------------------------------------------------------------------------------------------------
  const sent = [];
  page.on('request', (request) => { if (request.method() === 'POST' && new URL(request.url()).pathname === ROUTE) sent.push(request.postData()); });
  for (const bad of ['49', '96', '8.5', '1e1', '-80']) { // a number field takes no letters but "e": a person can still type 1e1
    await percent.fill(bad);
    await expect(save, `"${bad}" cannot be saved`).toBeDisabled();
    await expect(card.getByTestId('agent-options-percent-invalid'), `"${bad}" says why`).toContainText('Nhập số nguyên từ 50 đến 95.');
  }
  await percent.fill('80');
  await expect(save, 'what the Hub already says is not a change').toBeDisabled();
  expect(sent, 'nothing was sent for any of those').toEqual([]);

  // ---- choosing a percent -----------------------------------------------------------------------------------------------------------------------
  await percent.fill('65');
  await expect(save).toBeEnabled();
  const saving = page.waitForResponse(isOptions);
  await save.click();
  const answered = await saving;
  expect(answered.status()).toBe(200);
  expect(answered.request().postDataJSON()).toEqual({ autoCompactPercent: 65 });
  await expect(card.getByTestId('agent-options-percent-status')).toContainText('Đang nén từ 65% (bạn đã chọn).');
  await expect(dialog.getByText('Đã lưu: nén ngữ cảnh từ 65% ở lượt gọi model kế tiếp.', { exact: true })).toBeVisible();
  await expect(reset).toBeEnabled();
  expect((await app.hub.state()).agentOptions).toMatchObject({ autoCompactPercent: 65, autoCompactSaved: 65, autoAcceptChecks: false });
  expect(await readOptionsFile(app)).toEqual({ version: 1, autoCompactPercent: 65 });

  // ---- turning the Hub's acceptance on ------------------------------------------------------------------------------------------------------------
  const switching = page.waitForResponse(isOptions);
  await toggle.click(); // a controlled box: it shows the saved value once the Hub confirms
  expect((await switching).request().postDataJSON()).toEqual({ autoAcceptChecks: true });
  await expect(toggle).toBeChecked();
  await expect(card.getByTestId('agent-options-auto-accept-status')).toContainText('Đang bật (bạn đã chọn).');
  await expect(card.getByTestId('agent-options-auto-accept-warning'), 'and the warning stays while it is on').toBeVisible();
  expect(await readOptionsFile(app)).toEqual({ version: 1, autoCompactPercent: 65, autoAcceptChecks: true });
  await page.screenshot({ path: testInfo.outputPath('settings-chosen.png'), animations: 'disabled' });

  // The choice is the Hub's, not the tab's: a reloaded page finds both.
  await browserErrors.flush(page);
  await page.reload();
  await openSettings(page, 'Dự án');
  await expect(percent).toHaveValue('65');
  await expect(toggle).toBeChecked();
  await expect(card.getByTestId('agent-options-percent-status')).toContainText('Đang nén từ 65% (bạn đã chọn).');

  // ---- back to the default ------------------------------------------------------------------------------------------------------------------------
  const resetting = page.waitForResponse(isOptions);
  await reset.click();
  expect((await resetting).request().postDataJSON()).toEqual({ autoCompactPercent: null });
  await expect(percent).toHaveValue('80');
  await expect(card.getByTestId('agent-options-percent-status')).toContainText('Đang nén từ 80% (mặc định).');
  await expect(reset).toBeDisabled();
  expect(await readOptionsFile(app), 'the file holds no percent any more, and still the switch').toEqual({ version: 1, autoAcceptChecks: true });
  await closeSettings(page);
});

test('with the switch on, the Hub matches the check it ran only after the owner accepted the objective before it; the page tags it and the owner can take it over', async ({ page, app }) => {
  repairScenario(app);
  await onboard(page, app);
  repairScenario(app); // the connection check of the first-run dialog is not part of the script
  const on = await app.hub.request('POST', ROUTE, { autoAcceptChecks: true });
  expect(on.status).toBe(200);
  await send(page, PROMPT);
  const started = await taskByPrompt(app, PROMPT);
  await answerApprovals(app.hub, started.id, () => true); // the edit and the command the scripted model asks for
  const run = await app.hub.task(started.id);
  expect(run.agentOptions, 'the run records that the switch was on').toMatchObject({ autoAcceptChecks: true });
  expect(run.goalPlan.objectives.map((objective) => objective.id)).toEqual(['objective-1', 'objective-2']);
  expect(run.goalPlan.objectives.flatMap((objective) => objective.evidence ?? []), 'nothing is matched while the objective before it is not accepted: the Hub keeps the order the owner has').toEqual([]);
  expect(run.events.some((event) => event.type === 'objective_auto_accepted')).toBe(false);

  const panel = page.getByTestId('objective-acceptance');
  await expect(panel).toBeVisible();
  await panel.locator('summary').click();
  await expect(panel.locator('summary')).toContainText('0/2 đã xác minh');
  await expect(panel.getByTestId('objective-by-hub')).toHaveCount(0);
  const confirm = (key) => page.getByLabel(`Bằng chứng chấp nhận ${key}`).locator('xpath=following-sibling::button');

  // The owner accepts the one criterion of objective-1; the Hub then matches the check of objective-2 (and says so), the other two criteria of objective-2 stay the owner's.
  await confirm('objective-1:0').click();
  await expect.poll(async () => (await app.hub.task(started.id)).goalPlan.objectives.map((objective) => objective.status), { message: 'the Hub accepted objective-1 on the owner\'s click' }).toEqual(['verified', 'has_evidence']);
  const afterFirst = await app.hub.task(started.id);
  expect(afterFirst.goalPlan.objectives[0].evidence.map((entry) => entry.acceptedBy), 'objective-1 is the owner\'s').toEqual(['local_owner']);
  const second = afterFirst.goalPlan.objectives[1];
  expect(second.evidence.map((entry) => [entry.criterionIndex, entry.acceptedBy]), 'only the criterion that asks for a check, marked as the Hub\'s').toEqual([[2, 'auto_hub_check']]);
  expect(second.evidence[0].receiptId, 'with the check the Hub ran').toMatch(/^verify:/);
  expect(afterFirst.events.filter((event) => event.type === 'objective_auto_accepted').length, 'and the activity log says so once').toBe(1);
  await expect(panel.getByTestId('objective-by-hub'), 'the page tags exactly that criterion').toHaveCount(1);
  await expect(panel.getByTestId('objective-auto-note')).toContainText('không phải là chấp nhận của bạn');
  await expect(panel.locator('summary')).toContainText('1/2 đã xác minh');

  // The owner accepts the other two criteria: the objective is verified, and the completion says that the Hub accepted a check (it is not "accepted by the owner").
  await confirm('objective-2:0').click();
  await expect.poll(async () => (await app.hub.task(started.id)).goalPlan.objectives[1].evidence.length).toBe(2);
  await confirm('objective-2:1').click();
  await expect.poll(async () => (await app.hub.task(started.id)).goalPlan.objectives.map((objective) => objective.status)).toEqual(['verified', 'verified']);
  const done = await app.hub.task(started.id);
  // The word the completion gets for a check the Hub accepted (accepted_with_fresh_receipts_checks_by_hub) is pinned in tests/verify-objective-acceptance.mjs with receipts made by hand: a run through the real
  // tools cannot reach it, because the local git_diff tool leaves no review receipt and a coding plan needs one before the Hub calls its completion ready.
  expect(done.completionOutcome).toMatchObject({ requirements: 'verified', unresolvedObjectiveIds: [] });
  expect(done.goalPlan.objectives[1].evidence.map((entry) => entry.acceptedBy).sort()).toEqual(['auto_hub_check', 'local_owner', 'local_owner']);
  await expect(panel.locator('summary')).toContainText('2/2 đã xác minh');

  // The owner takes the Hub's acceptance over: the tag goes, the evidence says local_owner, and the completion is the owner's again.
  await confirm('objective-2:2').click();
  await expect.poll(async () => (await app.hub.task(started.id)).goalPlan.objectives[1].evidence.map((entry) => entry.acceptedBy).sort()).toEqual(['local_owner', 'local_owner', 'local_owner']);
  await expect(panel.getByTestId('objective-by-hub')).toHaveCount(0);
  await expect(panel.getByTestId('objective-auto-note')).toHaveCount(0);
});

test('with the switch off, which is the default, the Hub accepts nothing: after the owner accepted objective-1 the check of objective-2 is still the owner\'s to accept', async ({ page, app }) => {
  repairScenario(app);
  await onboard(page, app);
  repairScenario(app);
  expect((await app.hub.state()).agentOptions.autoAcceptChecks).toBe(false);
  await send(page, PROMPT);
  const started = await taskByPrompt(app, PROMPT);
  await answerApprovals(app.hub, started.id, () => true);
  expect((await app.hub.task(started.id)).agentOptions).toMatchObject({ autoAcceptChecks: false });

  const panel = page.getByTestId('objective-acceptance');
  await expect(panel).toBeVisible();
  await panel.locator('summary').click();
  await page.getByLabel('Bằng chứng chấp nhận objective-1:0').locator('xpath=following-sibling::button').click();
  await expect.poll(async () => (await app.hub.task(started.id)).goalPlan.objectives[0].status).toBe('verified');
  const after = await app.hub.task(started.id);
  expect(after.goalPlan.objectives[1].evidence ?? [], 'the check of objective-2 was not matched by anyone').toEqual([]);
  expect(after.goalPlan.objectives[1].status).not.toBe('verified');
  expect(after.events.some((event) => event.type === 'objective_auto_accepted')).toBe(false);
  await expect(panel.getByTestId('objective-by-hub')).toHaveCount(0);
  await expect(panel.getByTestId('objective-auto-note')).toHaveCount(0);
});
