// Scripted provider E2E: proves React -> real Hub -> real tools/permissions/disk.
// It is deliberately NOT evidence for a live AI provider or Windows WebView2.
import fs from 'node:fs/promises';
import path from 'node:path';
import { test, expect, onboard, send, taskByPrompt, openWorkTab, openSettings, closeSettings } from './fixtures.mjs';
import { waitFor, waitForState } from '../../tests/e2e/hub-process.mjs';
import { BUGGY_CALC, FIXED_CALC } from '../../tests/e2e/fixtures.mjs';
import { call, say, shaOf, exitedZero } from '../../tests/e2e/scenarios.mjs';

async function expandToolActivity(page) {
  const groups=page.getByTestId('tool-activity-group');
  for(const group of await groups.all()) {
    const header=group.getByRole('button').first();
    if(await header.getAttribute('aria-expanded')==='false') await header.click();
  }
}

test('onboarding, blank conversation, real approvals/edit/test/diff/plan and Skills', async ({ page, app, browserErrors }) => {
  app.mock.define('planned-repair', ({ turn, last, results }) => {
    if (turn === 0) return call('read_file', { path: 'calc.js' });
    if (turn === 1) return call('update_plan', { title: 'Repair addition', items: [
      { text: 'Inspect calc.js', status: 'done', evidence: `read_file sha256 ${shaOf(last)}` },
      { text: 'Correct addition', status: 'doing' },
      { text: 'Run node test.js', status: 'todo' },
    ] });
    if (turn === 2) return call('edit_file', { path: 'calc.js', old_string: 'return a - b;', new_string: 'return a + b;', expected_sha256: shaOf(results[0]) });
    if (turn === 3) return call('run_command', { command: 'node test.js', description: 'Verify addition' });
    if (turn === 4) return call('update_plan', { title: 'Repair addition', items: [
      { text: 'Inspect calc.js', status: 'done', evidence: 'read_file completed' },
      { text: 'Correct addition', status: 'done', evidence: 'edit_file changed calc.js' },
      { text: 'Run node test.js', status: exitedZero(last) ? 'done' : 'blocked', evidence: exitedZero(last) ? 'node test.js: exit code 0, add() ok' : 'node test.js failed' },
    ] });
    return say('Verified addition: node test.js passed with exit code 0.');
  });
  app.mock.setScenario('planned-repair');
  await onboard(page, app);
  const callsBefore = app.mock.state.requests.length;
  await page.getByRole('button', { name: 'Hội thoại mới', exact: true }).click();
  await expect(page.locator('textarea')).toHaveValue('');
  expect((await app.hub.state()).agent.tasks).toHaveLength(0);
  expect(app.mock.state.requests).toHaveLength(callsBefore);
  await openWorkTab(page, 'Tiến độ');
  await expect(page.getByText('Chưa có kế hoạch', { exact: true })).toBeVisible();
  expect(app.runProjectTest().status).not.toBe(0);
  const prompt = 'Repair addition and verify its test, with an honest plan.';
  await send(page, prompt);
  const task = await taskByPrompt(app, prompt);
  await expect.poll(() => browserErrors.requests.has('/api/tasks/events')).toBe(true);
  await expect(page.getByRole('button', { name: 'Dừng', exact: true }).last()).toBeVisible();
  await expect(page.getByTestId('tool-activity-group')).toHaveCount(1);
  await expandToolActivity(page);
  await expect(page.getByRole('button', { name: /^local\.read_file:/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Phê duyệt', exact: true }).and(page.locator(':enabled'))).toBeVisible();
  await expect(page.getByText('Correct addition', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Task plan' })).toContainText(/1\s*\/\s*3/);
  expect(await fs.readFile(path.join(app.project, 'calc.js'), 'utf8')).toBe(BUGGY_CALC);
  await expandToolActivity(page);
  await expect(page.getByRole('button', { name: /^local\.edit_file:/ })).toBeVisible();
  await expect(page.getByText(/Phân loại rủi ro:/)).toBeVisible();
  await expect(page.getByText('+ return a + b;', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Phê duyệt', exact: true }).and(page.locator(':enabled')).click();
  await expect(page.getByRole('region', { name: 'Phê duyệt local.run_command' }).getByText('node test.js', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Phê duyệt', exact: true }).and(page.locator(':enabled')).click();
  await waitForState(app.hub, task.id, 'completed');
  await expect(page.locator('#panel-conversation').getByText('Verified addition: node test.js passed with exit code 0.', { exact: true })).toBeVisible();
  expect(await fs.readFile(path.join(app.project, 'calc.js'), 'utf8')).toBe(FIXED_CALC);
  expect(app.runProjectTest().status).toBe(0);
  await expect(page.getByRole('region', { name: 'Task plan' })).toContainText(/3\s*\/\s*3/);
  // The model ran `node test.js` and the file is fixed, but the Hub recorded no verified check: the strip must say so, never green.
  const proof = page.getByTestId('proof-strip');
  await expect(proof).toBeVisible();
  await expect(proof).toHaveAttribute('data-tone', 'warning');
  await expect(proof).toHaveAttribute('data-kind', 'no-evidence');
  await expect(proof).toContainText('1 tệp đã sửa');
  await openWorkTab(page, 'Thay đổi');
  await expect(page.getByLabel('Git diff', { exact: true })).toContainText('+  return a + b;');
  await expect(page.getByLabel('Git diff', { exact: true })).toContainText('-  return a - b;');
  await openWorkTab(page, 'Tệp');
  await expect(page.getByRole('region', { name: 'Workspace files' })).toContainText('M calc.js');
  await openWorkTab(page, 'Hoạt động');
  await expect(page.getByRole('region', { name: 'Task activity' })).toContainText('edit_file');
  // Seed a real manual terminal session through its normal protected API; the tab must read it.
  await app.hub.post('/api/studio/terminal/start', { command: 'node test.js' });
  await openWorkTab(page, 'Terminal');
  await expect(page.getByRole('region', { name: 'Terminal sessions' })).toContainText('add() ok');
  await expect(page.getByRole('region', { name: 'Terminal sessions' })).toContainText('Exit: 0');
  await openSettings(page, 'Kỹ năng');
  await expect(page.getByRole('heading', { name: 'Kỹ năng cho trợ lý', exact: true })).toBeVisible();
  await expect.poll(() => [...browserErrors.requests].some((route) => route === '/api/plugins/marketplace')).toBe(true);
  await expect.poll(() => [...browserErrors.requests].some((route) => route === '/api/plugins/registry')).toBe(true);
  const callsAfterCompletion = app.mock.state.requests.length;
  await closeSettings(page);
  await page.getByRole('button', { name: 'Hội thoại mới', exact: true }).click();
  await expect(page.locator('#panel-conversation').getByRole('heading', { name: 'ChatMCP Studio', exact: true })).toBeVisible();
  await expect(page.locator('#panel-conversation').getByText('Verified addition: node test.js passed with exit code 0.', { exact: true })).toHaveCount(0);
  await openWorkTab(page, 'Tiến độ');
  await expect(page.getByText('Chưa có kế hoạch', { exact: true })).toBeVisible();
  expect((await app.hub.state()).agent.tasks).toHaveLength(1);
  expect(app.mock.state.requests).toHaveLength(callsAfterCompletion);
});

test('Deny leaves the real file unchanged and displays the refusal', async ({ page, app }) => {
  await onboard(page, app);
  const prompt = 'Repair addition, but wait for my permission.';
  await send(page, prompt);
  const task = await taskByPrompt(app, prompt);
  await expect(page.getByRole('button', { name: 'Từ chối', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Từ chối', exact: true }).click();
  await page.getByRole('button', { name: 'Xác nhận từ chối', exact: true }).click();
  await waitForState(app.hub, task.id, ['completed', 'failed']);
  await expect(page.locator('#panel-conversation').getByText(/Tôi chưa sửa calc.js vì/)).toBeVisible();
  expect(await fs.readFile(path.join(app.project, 'calc.js'), 'utf8')).toBe(BUGGY_CALC);
  expect(app.runProjectTest().status).not.toBe(0);
  expect((await app.hub.state()).studio.permissions.pending).toHaveLength(0);
});

test('Settings persists read-only and review without an invalid execution policy', async ({ page, app }) => {
  await onboard(page, app);
  await openSettings(page, 'Quyền & thực thi');
  await expect.soft(page.getByText(/LEVEL:\s*ADMIN/i)).toHaveCount(0);
  await expect.soft(page.getByText(/RBAC/)).toHaveCount(0);
  await page.getByRole('button', { name: /^Chỉ đọc \(Read-only\)/ }).click();
  await expect.poll(async () => (await app.hub.state()).studio.permissions.mode).toBe('readonly');
  await page.getByRole('button', { name: /^Review \(Mặc định\)/ }).last().click();
  await expect.poll(async () => (await app.hub.state()).studio.permissions.mode).toBe('review');
  expect((await app.hub.state()).studio.permissions.executionPolicy).toBe('host-review');
});

test('FULL ACCESS needs the typed words, shows a permanent banner, and one click goes back to Review', async ({ page, app }) => {
  await onboard(page, app);
  const dialog = await openSettings(page, 'Quyền & thực thi');
  await expect(page.getByTestId('full-access-banner')).toHaveCount(0);
  // The confirmation opens above Settings (the permission list lives there), not behind it.
  await dialog.getByRole('button', { name: /^FULL ACCESS/ }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Xác nhận quyền FULL ACCESS' });
  await expect(confirm).toBeVisible();
  const activate = confirm.getByRole('button', { name: 'Kích hoạt FULL ACCESS', exact: true });
  await expect(activate).toBeDisabled();
  await confirm.getByLabel(/gõ chính xác cụm từ/).fill('full access');
  await expect(activate).toBeDisabled();
  await confirm.getByLabel(/gõ chính xác cụm từ/).fill('FULL ACCESS');
  await activate.click();
  await expect(confirm).toHaveCount(0);
  await expect.poll(async () => (await app.hub.state()).studio.permissions.executionPolicy).toBe('full-access');
  await closeSettings(page);
  const banner = page.getByTestId('full-access-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('FULL ACCESS đang bật');
  await expect(page.getByTestId('status-bar')).toContainText('FULL ACCESS');
  await banner.getByRole('button', { name: 'Quay về Review', exact: true }).click();
  await expect(banner).toHaveCount(0);
  await expect.poll(async () => (await app.hub.state()).studio.permissions).toMatchObject({ mode: 'review', executionPolicy: 'host-review' });
  await expect(page.getByTestId('status-bar')).not.toContainText('FULL ACCESS');
});

test('the FULL ACCESS banner and the way back to Review read in English, with no Vietnamese in them', async ({ page, app }) => {
  await onboard(page, app);
  const settings = await openSettings(page, 'Giao diện & ngôn ngữ');
  await settings.getByRole('button', { name: 'English' }).click();
  await closeSettings(page);
  // FULL ACCESS is turned on through the Hub the way the dialog does it (the dialog and its typed words are tested above)
  await app.hub.post('/api/studio/permissions/config', { mode: 'autonomous', executionPolicy: 'full-access', confirmation: 'FULL ACCESS' });
  await expect.poll(async () => (await app.hub.state()).studio.permissions.executionPolicy).toBe('full-access');
  const banner = page.getByTestId('full-access-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('FULL ACCESS is on: the agent can act outside the workspace. Dangerous actions (deleting data, push, merge, release) still ask.');
  expect(await banner.innerText(), 'the banner reads English').not.toMatch(/[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/i);
  await expect(page.getByTestId('status-bar')).toContainText('FULL ACCESS');
  await banner.getByRole('button', { name: 'Back to Review', exact: true }).click();
  await expect(page.getByText('Switched back to Review mode.')).toBeVisible();
  await expect(banner).toHaveCount(0);
  await expect.poll(async () => (await app.hub.state()).studio.permissions).toMatchObject({ mode: 'review', executionPolicy: 'host-review' });
  await expect(page.getByTestId('status-bar')).not.toContainText('FULL ACCESS');
});

/** The letters only Vietnamese has: a screen in English must hold none (the name of the Vietnamese language in the language selector is taken out first). */
const VIETNAMESE = /[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/i;
const inEnglish = (text) => text.replace('Tiếng Việt (Vietnamese)', '');

test('the first-run setup reads English from the first screen and sets up the same things', async ({ page, app }) => {
  await page.addInitScript(() => localStorage.setItem('chatmcp:language', 'en'));
  await page.goto(await app.signInUrl());
  const setup = page.getByRole('dialog', { name: 'ChatMCP setup' });
  await expect(setup.getByRole('heading', { name: 'Welcome to ChatMCP Studio' })).toBeVisible();
  expect(await setup.innerText(), 'step 1 reads English').not.toMatch(VIETNAMESE);
  await page.getByLabel('Workspace path', { exact: true }).fill(app.project);
  await page.getByRole('button', { name: 'Apply workspace', exact: true }).click();
  await expect.poll(async () => (await app.hub.state()).workspace?.path).toBe(app.project);
  await expect(setup.getByRole('status')).toContainText('Workspace selected:');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Ollama (Local)', exact: true }).click();
  await page.getByLabel('API base URL', { exact: true }).fill(app.mock.url);
  await page.getByLabel('Model', { exact: true }).fill('mock-coder');
  const checked = page.waitForResponse((response) => response.url().endsWith('/api/ai/test') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Save and test', exact: true }).click();
  expect((await checked).ok()).toBe(true);
  expect(await setup.innerText(), 'step 2 reads English').not.toMatch(VIETNAMESE);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  expect(await setup.innerText(), 'step 3 reads English').not.toMatch(VIETNAMESE);
  await page.getByRole('button', { name: /^Read-only/ }).click();
  await page.getByRole('button', { name: 'Start working now', exact: true }).click();
  await expect(page.getByText('Welcome to ChatMCP Studio!')).toBeVisible();
  await expect(setup).toHaveCount(0);
  await expect.poll(async () => (await app.hub.state()).studio.permissions.mode).toBe('readonly');
  expect((await app.hub.state()).ai.model).toBe('mock-coder');
});

test('Settings, the FULL ACCESS dialog and the command palette read English and do the same things', async ({ page, app }) => {
  await onboard(page, app);
  const vietnamese = await openSettings(page, 'Giao diện & ngôn ngữ');
  await vietnamese.getByRole('button', { name: 'English' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  const sections = settings.getByRole('navigation', { name: 'Settings sections' });
  for (const section of ['Project', 'AI model', 'Permissions & execution', 'Agent channel', 'Code intelligence', 'Appearance & language', 'About & data']) {
    await sections.getByRole('button', { name: section, exact: true }).click();
    await expect(sections.getByRole('button', { name: section, exact: true })).toHaveAttribute('aria-current', 'page');
    expect(inEnglish(await settings.innerText()), `${section} reads English`).not.toMatch(VIETNAMESE);
  }
  // FULL ACCESS needs the typed words, and says so in English
  await sections.getByRole('button', { name: 'Permissions & execution', exact: true }).click();
  await settings.getByRole('button', { name: /^FULL ACCESS/ }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Confirm FULL ACCESS permission' });
  await expect(confirm).toBeVisible();
  expect(await confirm.innerText(), 'the dialog reads English').not.toMatch(VIETNAMESE);
  const turnOn = confirm.getByRole('button', { name: 'Turn on FULL ACCESS', exact: true });
  await expect(turnOn).toBeDisabled();
  await confirm.getByLabel(/type exactly the phrase/).fill('full access');
  await expect(turnOn).toBeDisabled();
  await confirm.getByLabel(/type exactly the phrase/).fill('FULL ACCESS');
  await turnOn.click();
  await expect(confirm).toHaveCount(0);
  await expect(page.getByText('FULL ACCESS mode is on')).toBeVisible();
  await expect.poll(async () => (await app.hub.state()).studio.permissions.executionPolicy).toBe('full-access');
  await page.keyboard.press('Escape');
  await expect(settings).toHaveCount(0);
  // the command palette, in English, leaves FULL ACCESS the way the Settings list does, at once (the page does not have to wait for its next poll)
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  expect(await palette.innerText(), 'the palette reads English').not.toMatch(VIETNAMESE);
  await palette.getByRole('option', { name: /Read-only/ }).click();
  await expect(page.getByText('Switched permission mode to readonly')).toBeVisible();
  await expect.poll(async () => (await app.hub.state()).studio.permissions).toMatchObject({ mode: 'readonly', executionPolicy: 'host-review' });
});

test('a page that still holds the state from before Full Access leaves Full Access when a mode is chosen: palette, Settings and the composer menu', async ({ page, app }) => {
  await onboard(page, app);
  // For the whole test the page is told that the policy is host-review (every state it reads says so) while the Hub really is in Full Access:
  // the snapshot a page holds can be a few seconds older than the Hub's state, and this keeps it older.
  await page.route(/\/api\/state(\?|$)/, async (route) => {
    const response = await route.fetch();
    const state = await response.json();
    state.studio.permissions = { ...state.studio.permissions, executionPolicy: 'host-review', fullAccess: false };
    await route.fulfill({ response, json: state });
  });
  const fullAccessOn = async () => {
    await app.hub.post('/api/studio/permissions/config', { mode: 'autonomous', executionPolicy: 'full-access', confirmation: 'FULL ACCESS' });
    expect((await app.hub.state()).studio.permissions.executionPolicy).toBe('full-access');
  };
  const left = (mode) => expect.poll(async () => (await app.hub.state()).studio.permissions, { message: `the Hub left Full Access for ${mode}` })
    .toMatchObject({ mode, executionPolicy: 'host-review', fullAccess: false });

  // the command palette
  await fullAccessOn();
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Bảng lệnh' });
  await expect(palette).toBeVisible();
  await palette.getByRole('option', { name: /^Review/ }).click();
  await left('review');

  // the permission list in Settings
  await fullAccessOn();
  const settings = await openSettings(page, 'Quyền & thực thi');
  await settings.getByRole('button', { name: /^Review \(Mặc định\)/ }).click();
  await left('review');
  await closeSettings(page);

  // the mode menu of the composer
  await fullAccessOn();
  await page.getByTitle('Chế độ quyền thực thi của Agent').click();
  await page.getByRole('menuitemradio', { name: /^Review \(Mặc định\)/ }).click();
  await left('review');
});

test('AI config clears a typed fixture key after save and destination changes', async ({ page, app }) => {
  await onboard(page, app);
  await openSettings(page, 'Mô hình AI');
  const key = page.getByLabel('API key', { exact: true });
  // Deliberately fake, sent only to this fixture's own loopback server.
  await key.fill('E2E-DUMMY-NOT-A-REAL-KEY');
  const saved = page.waitForResponse((response) => response.url().endsWith('/api/ai/config') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Lưu cấu hình', exact: true }).click();
  expect((await saved).ok()).toBe(true);
  await expect.soft(key).toHaveValue('');
  await key.fill('E2E-DUMMY-UNSAVED-KEY');
  await page.getByRole('button', { name: 'LM Studio (Local)', exact: true }).click();
  await expect.soft(key).toHaveValue('');
  await key.fill('E2E-DUMMY-ANOTHER-KEY');
  await page.getByLabel('API base URL', { exact: true }).fill(app.mock.url.replace('127.0.0.1', 'localhost'));
  await expect.soft(key).toHaveValue('');
  const changed = page.waitForRequest((request) => request.url().endsWith('/api/ai/config') && request.method() === 'POST');
  const changedResponse = page.waitForResponse((response) => response.url().endsWith('/api/ai/config') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Lưu cấu hình', exact: true }).click();
  expect((await changed).postDataJSON()).not.toHaveProperty('apiKey');
  expect((await changedResponse).ok()).toBe(true);
});

test('saving a custom endpoint twice retains its canonical provider and saved fixture key', async ({ page, app }) => {
  await onboard(page, app);
  const callsBefore = app.mock.state.requests.length;
  await openSettings(page, 'Mô hình AI');
  await page.getByRole('button', { name: 'Ollama (Local)', exact: true }).click();
  await page.getByLabel('API base URL', { exact: true }).fill(app.mock.url);
  await page.getByLabel('Model', { exact: true }).fill('mock-coder');
  const key = page.getByLabel('API key', { exact: true });
  await key.fill('E2E-DUMMY-CUSTOM-ENDPOINT-KEY');
  const firstSave = page.waitForResponse((response) => response.url().endsWith('/api/ai/config') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Lưu cấu hình', exact: true }).click();
  expect((await firstSave).ok()).toBe(true);
  await expect(key).toHaveValue('');
  await expect.poll(async () => {
    const ai = (await app.hub.state()).ai;
    return { preset: ai.preset, keySource: ai.keySource };
  }).toEqual({ preset: 'custom-openai', keySource: 'saved' });
  const secondRequest = page.waitForRequest((request) => request.url().endsWith('/api/ai/config') && request.method() === 'POST');
  const secondResponse = page.waitForResponse((response) => response.url().endsWith('/api/ai/config') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Lưu cấu hình', exact: true }).click();
  const payload = (await secondRequest).postDataJSON();
  expect(payload.preset).toBe('custom-openai');
  expect(payload).not.toHaveProperty('apiKey');
  expect((await secondResponse).ok()).toBe(true);
  const ai = (await app.hub.state()).ai;
  expect(ai.preset).toBe('custom-openai');
  expect(ai.apiBaseUrl).toBe(app.mock.url);
  expect(ai.keySource).toBe('saved');
  expect(app.mock.state.requests).toHaveLength(callsBefore);
  expect((await app.hub.state()).agent.tasks).toHaveLength(0);
});

test('switching custom Gemini to custom OpenAI on the same gateway persists protocol without re-entering key', async ({ page, app }) => {
  await onboard(page, app);
  await openSettings(page, 'Mô hình AI');
  await page.getByRole('button', { name:'Custom (Gemini)',exact:true }).click();
  await page.getByLabel('API base URL', {exact:true}).fill(app.mock.url);
  await page.getByLabel('Model', {exact:true}).fill('cx/gpt-6-astra');
  await page.getByLabel('API key', {exact:true}).fill('E2E-DUMMY-GATEWAY-SECRET');
  await page.getByRole('button', {name:'Lưu cấu hình',exact:true}).click();
  await expect.poll(async()=>{
    const ai=(await app.hub.state()).ai;
    return {preset:ai.preset,protocol:ai.protocol,keySource:ai.keySource};
  }).toEqual({preset:'custom-gemini',protocol:'gemini',keySource:'saved'});
  const original=(await app.hub.state()).ai;
  await page.getByRole('button', {name:'Custom (Chat Completions)',exact:true}).click();
  await expect(page.getByLabel('API base URL',{exact:true})).toHaveValue(original.apiBaseUrl);
  await expect(page.getByLabel('Model',{exact:true})).toHaveValue('cx/gpt-6-astra');
  await expect(page.getByRole('status').filter({hasText:'Chưa áp dụng cấu hình mới'})).toContainText('custom-gemini / gemini');
  await page.getByRole('button', {name:'Lưu cấu hình',exact:true}).click();
  await expect.poll(async()=>{
    const ai=(await app.hub.state()).ai;
    return {preset:ai.preset,protocol:ai.protocol,keySource:ai.keySource,base:ai.apiBaseUrl,model:ai.model};
  }).toEqual({
    preset:'custom-openai',protocol:'openai-chat',keySource:'saved',
    base:original.apiBaseUrl,model:'cx/gpt-6-astra',
  });
  await expect(page.getByRole('status').filter({hasText:'Chưa áp dụng cấu hình mới'})).toHaveCount(0);
});

test('Stop, Resume and Hub restart preserve the same read-only conversation', async ({ page, context, app, browserErrors }) => {
  await onboard(page, app);
  app.mock.define('slow-read', async ({ turn }) => {
    if (turn === 0) return call('read_file', { path: 'calc.js' });
    await new Promise((resolve) => setTimeout(resolve, 20_000));
    return say('This delayed response must not become the resumed answer.');
  });
  app.mock.setScenario('slow-read');
  const prompt = 'Inspect addition, then wait for further direction.';
  await send(page, prompt);
  const task = await taskByPrompt(app, prompt);
  await waitFor(async () => app.mock.state.requests.some((request) => request.turn === 1));
  await expect(page.getByRole('button', { name: 'Dừng', exact: true }).last()).toBeVisible();
  await page.getByRole('button', { name: 'Dừng', exact: true }).last().click();
  await waitForState(app.hub, task.id, ['cancelled', 'paused']);
  app.mock.define('resume-read', () => say('Resumed the same conversation; no files were changed.'));
  app.mock.setScenario('resume-read');
  await page.getByRole('button', { name: 'Tiếp tục', exact: true }).click();
  await waitForState(app.hub, task.id, 'completed');
  await expect(page.locator('#panel-conversation').getByText('Resumed the same conversation; no files were changed.', { exact: true })).toBeVisible();
  expect((await app.hub.state()).agent.tasks).toHaveLength(1);
  // Disconnect the browser first: planned downtime is not an application runtime error.
  await browserErrors.closePage(page);
  await app.restart();
  const recovered = await context.newPage();
  await recovered.goto(await app.signInUrl());
  await expect(recovered.locator('#panel-conversation').getByText('Resumed the same conversation; no files were changed.', { exact: true })).toBeVisible();
  await expect(recovered.getByText(prompt, { exact: true }).last()).toBeVisible();
  expect((await app.hub.state()).agent.tasks.map((item) => item.id)).toEqual([task.id]);
  expect(await fs.readFile(path.join(app.project, 'calc.js'), 'utf8')).toBe(BUGGY_CALC);
});

test.describe('failed verification', () => {
  test.use({ failingProject: true });
  test('a finished model response does not claim passing tests when the real test exits nonzero', async ({ page, app }) => {
    await onboard(page, app);
    const prompt = 'Repair addition and run the project test.';
    await send(page, prompt);
    const task = await taskByPrompt(app, prompt);
    await page.getByRole('button', { name: 'Phê duyệt', exact: true }).and(page.locator(':enabled')).click();
    await expect(page.getByRole('region', { name: 'Phê duyệt local.run_command' }).getByText('node test.js', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Phê duyệt', exact: true }).and(page.locator(':enabled')).click();
    await waitForState(app.hub, task.id, ['completed', 'failed']);
    await expect(page.locator('#panel-conversation').getByText(/Đã sửa calc.js nhưng node test.js vẫn thất bại/)).toBeVisible();
    expect(app.runProjectTest().status).not.toBe(0);
    await expect(page.getByTestId('proof-strip')).toHaveAttribute('data-tone', 'danger');
    // Tool receipts are now hidden under an expandable activity summary.
    await expandToolActivity(page);
    await expect(page.getByText('Lỗi', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: /^local\.run_command:/ }).click();
    await expect(page.locator('pre').filter({ hasText: /exit code [1-9]/ })).toBeVisible();
    await expect(page.getByText('Đã hoàn tất thành công', { exact: true })).toHaveCount(0);
    const workflow = (await app.hub.get(`/api/studio/workflow?taskId=${task.id}`)).json;
    expect(workflow.verified).toBe(false);
  });
});


// A real React -> Hub -> task-agent round trip with a loopback mock model.
// Profile storage, default selection, immutable routing and task metadata are
// verified; this is NOT a test against paid/live provider credentials.
test('a saved local model profile routes a new task through the real Hub', async ({page, app}) => {
  app.mock.setScenario('explore');
  await onboard(page,app);
  await openSettings(page, 'Mô hình AI');
  await page.getByLabel('Model profile ID',{exact:true}).fill('local-e2e');
  await page.getByLabel('Model profile display name',{exact:true}).fill('Local test profile');
  await page.getByLabel('Model profile API base URL',{exact:true}).fill(app.mock.url);
  await page.getByLabel('Model profile model',{exact:true}).fill('mock-coder');
  await page.getByRole('button',{name:'Save model profile',exact:true}).click();
  await expect.poll(async()=>{
    const ai=(await app.hub.state()).ai;
    return {listed:ai.profiles.some(p=>p.id==='local-e2e'),selected:ai.defaultProfileId};
  }).toEqual({listed:true,selected:'local-e2e'});
  await closeSettings(page);
  await expect(page.getByLabel('Task model profile',{exact:true})).toBeVisible();
  await page.getByLabel('Task model profile',{exact:true}).selectOption('local-e2e');
  const prompt='Explore the fixture README using the configured task model profile.';
  await page.locator('#panel-conversation textarea').fill(prompt);
  await page.locator('#panel-conversation').getByRole('button',{name:'Gửi',exact:true}).click();
  const started=await taskByPrompt(app,prompt);
  await waitForState(app.hub,started.id,'completed');
  const task=await app.hub.task(started.id);
  expect(task.effectiveProfile.id).toBe('local-e2e');
  expect(task.effectiveProfile.model).toBe('mock-coder');
  expect(task.effectiveProfile.endpointOrigin).toBe(new URL(app.mock.url).origin);
  expect(task.effectiveProfile.revision).toMatch(/^[0-9a-f-]{16,}$/);
  expect(JSON.stringify(task)).not.toContain('gateway-key.dpapi');
  await expect(page.getByTestId('active-model-profile')).toContainText('Local test profile');
});

// The window policy through the real Hub (hub.mjs main() builds the foreground runner) and the real conversation view. The mock model is
// connected through the Ollama preset with no declared context window, and this Hub is NOT given the harness default CHATMCP_TOOL_SELECTION=full,
// so the Hub itself decides: an unknown window gets the task-selected tool schemas and the conversation says the window is unknown.
test.describe('a model with no declared context window', () => {
  test.use({ hubEnv: { CHATMCP_TOOL_SELECTION: '' } });
  test('gets task-selected tool schemas and a visible warning that names the fix', async ({ page, app }) => {
    app.mock.define('answer-only', () => say('calc.js subtracts where it should add.'));
    app.mock.setScenario('answer-only');
    await onboard(page, app);
    const prompt = 'Explain what calc.js does.';
    await send(page, prompt);
    const started = await taskByPrompt(app, prompt);
    await waitForState(app.hub, started.id, 'completed');
    const warning = page.getByTestId('context-window-warning');
    await expect(warning).toBeVisible();
    await expect(warning).toContainText('Chưa biết cửa sổ ngữ cảnh');
    await expect(warning).toContainText('Cài đặt → Mô hình AI');
    // It does not only say where the fix is: one click opens the field.
    await warning.getByRole('button', { name: 'Mở cài đặt' }).click();
    await expect(page.getByRole('dialog', { name: 'Cài đặt' })).toBeVisible();
    await expect(page.getByLabel('Context window tokens', { exact: true })).toBeVisible();
    await closeSettings(page);
    const task = await app.hub.task(started.id);
    expect(task.contextPolicy.source).toBe('conservative_fallback');
    expect(task.contextPolicy.reservedOutputTokens).toBeGreaterThanOrEqual(16384);
    expect(task.contextPolicy.maxHistoryTokens).toBeGreaterThanOrEqual(8000);
    expect(task.events.some((event) => event.type === 'tool_selection')).toBe(true);
    const offered = app.mock.state.requests.filter((request) => request.tools.includes('mcp_call')).at(-1).tools;
    expect(offered.length, 'the task-selected schemas plus the routers, not the full list of 100+').toBeLessThan(60);
    expect(offered).toContain('read_file');
  });
});
