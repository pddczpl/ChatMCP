import { test, expect, onboard } from './fixtures.mjs';

test('Agents guides a new user, hides advanced options and keeps authorization before requests', async ({ page, app }, testInfo) => {
  await onboard(page, app);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: 'Trợ lý', exact: true }).click();
  const agents = page.getByLabel('Trợ lý AI', { exact: true });
  const start = agents.getByRole('button', { name: 'Bắt đầu phân tích', exact: true });
  const goal = agents.getByLabel('Yêu cầu của bạn', { exact: true });
  await expect(goal).toBeVisible();
  await expect(goal).toHaveValue('');
  await expect(start).toBeDisabled();
  await expect(agents.getByLabel('Số trợ lý làm cùng lúc')).toBeHidden();
  await expect(agents.getByLabel('Công việc 1', { exact: true })).toBeHidden();
  const workspaceButton = page.locator('button[title^="Thư mục:"]');
  await expect(workspaceButton).toHaveCSS('background-color', 'rgb(24, 32, 43)');
  await page.screenshot({ path: testInfo.outputPath('agents-dark-1280.png'), fullPage: true });
  await page.getByRole('button', { name: 'Chuyển theme sáng / tối', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(workspaceButton).toHaveCSS('background-color', 'rgb(241, 245, 249)');
  await page.screenshot({ path: testInfo.outputPath('agents-light-1280.png'), fullPage: true });

  const callsBefore = app.mock.state.requests.length;
  await agents.getByRole('button', { name: 'Tìm hiểu dự án', exact: true }).click();
  await expect(goal).toHaveValue(/Tìm hiểu cấu trúc dự án/);
  await expect(start).toBeEnabled();
  expect(app.mock.state.requests).toHaveLength(callsBefore);
  await start.click();
  const consent = page.getByRole('alertdialog', { name: 'Cho phép AI phân tích dự án?' });
  await expect(consent).toBeVisible();
  await expect(consent).toContainText('Không sửa tệp, chạy lệnh hay đưa mã lên GitHub');
  await expect(consent).toContainText('Phí sử dụng do nhà cung cấp AI tính');
  expect(app.mock.state.requests).toHaveLength(callsBefore);
  await expect(consent.getByRole('button', { name: 'Để sau', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(consent.getByRole('button', { name: 'Cho phép và bắt đầu', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(consent).toBeHidden();
  await expect(start).toBeFocused();
  await start.click();
  await consent.getByRole('button', { name: 'Để sau', exact: true }).click();
  await expect(consent).toBeHidden();
  await expect(start).toBeEnabled();
  expect(app.mock.state.requests).toHaveLength(callsBefore);
  expect((await app.hub.get('/api/studio/dynamic-delegates')).json.last).toBeNull();

  await agents.getByText('Tự chia việc cho từng trợ lý', { exact: true }).click();
  await expect(agents.getByLabel('Vai trò trợ lý 1', { exact: true })).toHaveValue('planner');
  await expect(agents.getByRole('option', { name: 'Lập kế hoạch', exact: true }).first()).toHaveAttribute('value', 'planner');
  await expect(agents.getByLabel('Mã trợ lý').first()).toBeHidden();
  await agents.getByText('Tự chia việc cho từng trợ lý', { exact: true }).click();

  await agents.getByText('Nhờ AI sửa mã nguồn', { exact: true }).click();
  const code = agents.getByLabel('Công việc 1', { exact: true });
  const runCode = agents.getByRole('button', { name: 'Bắt đầu sửa mã', exact: true });
  await expect(runCode).toBeDisabled();
  await code.fill('Cải thiện cách hiển thị kết quả tính toán.');
  await expect(runCode).toBeEnabled();
  await expect(agents.getByLabel('Mã công việc', { exact: true })).toBeHidden();
  let dialogText = '';
  page.once('dialog', async dialog => { dialogText = dialog.message(); await dialog.dismiss(); });
  await runCode.click();
  expect(dialogText).toContain('không tự gộp thay đổi');
  expect((await app.hub.get('/api/studio/coding')).json.jobs).toHaveLength(0);
  expect(app.mock.state.requests).toHaveLength(callsBefore);

  // The scripted provider returns plain OK for tool-free requests, so the real
  // Hub rejects its invalid plan. Verify authorization and honest failure UI.
  await agents.getByText('Nhờ AI sửa mã nguồn', { exact: true }).click();
  await start.click();
  const request = page.waitForRequest(value => value.url().endsWith('/api/studio/dynamic-delegates/run') && value.method() === 'POST');
  await consent.getByRole('button', { name: 'Cho phép và bắt đầu', exact: true }).click();
  expect((await request).postDataJSON()).toMatchObject({ confirmation: 'AUTHORIZE READONLY DELEGATION' });
  await expect(agents.getByRole('alert')).toContainText('Model did not return a valid JSON worker plan');
  await expect(agents).toContainText('Cần bạn kiểm tra');
  await expect(start).toBeEnabled();
});
