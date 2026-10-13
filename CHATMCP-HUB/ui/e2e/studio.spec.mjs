// Scripted provider E2E: proves React -> real Hub -> real tools/permissions/disk.
// It is deliberately NOT evidence for a live AI provider or Windows WebView2.
import fs from 'node:fs/promises';
import path from 'node:path';
import { test, expect, onboard, send, taskByPrompt } from './fixtures.mjs';
import { waitFor, waitForState } from '../../tests/e2e/hub-process.mjs';
import { BUGGY_CALC, FIXED_CALC } from '../../tests/e2e/fixtures.mjs';
import { call, say, shaOf, exitedZero } from '../../tests/e2e/scenarios.mjs';

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
  await page.getByRole('button', { name: 'Kế hoạch', exact: true }).click();
  await expect(page.getByText('Chưa có kế hoạch', { exact: true })).toBeVisible();
  expect(app.runProjectTest().status).not.toBe(0);
  const prompt = 'Repair addition and verify its test, with an honest plan.';
  await send(page, prompt);
  const task = await taskByPrompt(app, prompt);
  await expect.poll(() => browserErrors.requests.has('/api/tasks/events')).toBe(true);
  await expect(page.getByRole('button', { name: 'Dừng', exact: true }).last()).toBeVisible();
  await expect(page.getByRole('button', { name: /^local\.read_file:/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Phê duyệt', exact: true }).and(page.locator(':enabled'))).toBeVisible();
  await expect(page.getByText('Correct addition', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Task plan' })).toContainText(/1\s*\/\s*3/);
  expect(await fs.readFile(path.join(app.project, 'calc.js'), 'utf8')).toBe(BUGGY_CALC);
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
  await page.getByRole('button', { name: 'Git', exact: true }).click();
  await expect(page.getByLabel('Git diff', { exact: true })).toContainText('+  return a + b;');
  await expect(page.getByLabel('Git diff', { exact: true })).toContainText('-  return a - b;');
  await page.getByRole('button', { name: 'Tệp', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Workspace files' })).toContainText('M calc.js');
  await page.getByRole('button', { name: 'Hoạt động', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Task activity' })).toContainText('edit_file');
  // Seed a real manual terminal session through its normal protected API; the tab must read it.
  await app.hub.post('/api/studio/terminal/start', { command: 'node test.js' });
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Terminal sessions' })).toContainText('add() ok');
  await expect(page.getByRole('region', { name: 'Terminal sessions' })).toContainText('Exit: 0');
  await page.getByRole('button', { name: 'Skills', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Kỹ năng cho trợ lý', exact: true })).toBeVisible();
  await expect.poll(() => [...browserErrors.requests].some((route) => route === '/api/plugins/marketplace')).toBe(true);
  await expect.poll(() => [...browserErrors.requests].some((route) => route === '/api/plugins/registry')).toBe(true);
  const callsAfterCompletion = app.mock.state.requests.length;
  await page.getByRole('button', { name: 'Hội thoại mới', exact: true }).click();
  await expect(page.locator('#panel-conversation').getByRole('heading', { name: 'ChatMCP Studio', exact: true })).toBeVisible();
  await expect(page.locator('#panel-conversation').getByText('Verified addition: node test.js passed with exit code 0.', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Kế hoạch', exact: true }).click();
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
  await page.getByRole('button', { name: 'Cài đặt', exact: true }).last().click();
  await expect.soft(page.getByText(/LEVEL:\s*ADMIN/i)).toHaveCount(0);
  await expect.soft(page.getByText(/RBAC/)).toHaveCount(0);
  await page.getByRole('button', { name: /^Chỉ đọc \(Read-only\)/ }).click();
  await expect.poll(async () => (await app.hub.state()).studio.permissions.mode).toBe('readonly');
  await page.getByRole('button', { name: /^Review \(Mặc định\)/ }).last().click();
  await expect.poll(async () => (await app.hub.state()).studio.permissions.mode).toBe('review');
  expect((await app.hub.state()).studio.permissions.executionPolicy).toBe('host-review');
});

test('AI config clears a typed fixture key after save and destination changes', async ({ page, app }) => {
  await onboard(page, app);
  await page.getByRole('button', { name: 'AI Model', exact: true }).click();
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
  await page.getByRole('button', { name: 'AI Model', exact: true }).click();
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
  await recovered.goto(app.hub.origin);
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
    await expect(page.getByText('Lỗi', { exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: /^local\.run_command:/ }).click();
    await expect(page.locator('pre').filter({ hasText: /exit code [1-9]/ })).toBeVisible();
    await expect(page.getByText('Đã hoàn tất thành công', { exact: true })).toHaveCount(0);
    const workflow = (await app.hub.get(`/api/studio/workflow?taskId=${task.id}`)).json;
    expect(workflow.verified).toBe(false);
  });
});
