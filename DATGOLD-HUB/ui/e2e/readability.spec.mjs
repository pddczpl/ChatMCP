import { test, expect, onboard, send, taskByPrompt, setTheme, SURFACE } from './fixtures.mjs';
import { waitForState } from '../../tests/e2e/hub-process.mjs';
import { call, say } from '../../tests/e2e/scenarios.mjs';

const answer = 'Đã đọc tệp.\n\n```js\nconst lờiChào = "Xin chào";\n```';
const clipboardText = page => page.evaluate(async () => (await navigator.clipboard.readText()).replace(/\r\n/g, '\n'));

async function contrast(locator) {
  return locator.evaluate(el => {
    const luminance = color => {
      const channels = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => {
        const c = v / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    };
    let parent = el;
    while (parent && getComputedStyle(parent).backgroundColor === 'rgba(0, 0, 0, 0)') parent = parent.parentElement;
    const fore = luminance(getComputedStyle(el).color);
    const back = luminance(getComputedStyle(parent).backgroundColor);
    return (Math.max(fore, back) + 0.05) / (Math.min(fore, back) + 0.05);
  });
}

test('output and code stay readable in both themes and copy exact text', async ({ page, context, app }, testInfo) => {
  app.mock.define('readable-result', ({ turn }) => turn === 0 ? call('read_file', { path: 'calc.js' }) : say(answer));
  app.mock.setScenario('readable-result');
  await onboard(page, app);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await send(page, 'Read calc.js and explain it.');
  const task = await taskByPrompt(app, 'Read calc.js and explain it.');
  await waitForState(app.hub, task.id, 'completed');
  const message = page.getByTestId('conversation-message').filter({ hasText: 'Đã đọc tệp.' });
  await expect(message).toBeVisible();
  await message.getByRole('button', { name: 'Sao chép tin nhắn', exact: true }).click();
  await expect.poll(() => clipboardText(page)).toBe(answer);
  await page.getByTestId('tool-activity-group').first().getByRole('button').first().click();
  const receipt = page.getByTestId('tool-receipt').first();
  await receipt.getByRole('button', { name: /^local\.read_file:/ }).click();
  const output = receipt.getByTestId('tool-output');
  await expect(output.locator('pre')).toContainText('function add');
  await output.getByRole('button', { name: 'Sao chép kết quả' }).click();
  expect(await clipboardText(page)).toBe((await output.locator('pre').textContent()).replace(/\r\n/g, '\n'));
  const code = message.getByTestId('message-code');
  await code.getByRole('button', { name: 'Sao chép mã' }).click();
  await expect.poll(() => clipboardText(page)).toBe('const lờiChào = "Xin chào";');

  for (const theme of ['light', 'dark']) {
    await setTheme(page, theme);
    await expect(page.locator('header button[title^="Thư mục:"]')).toHaveCSS('background-color', theme === 'light' ? SURFACE.light : SURFACE.dark);
    expect(await contrast(output.locator('pre'))).toBeGreaterThanOrEqual(4.5);
    expect(await contrast(code.locator('code'))).toBeGreaterThanOrEqual(4.5);
    expect(await message.locator('.conversation-copy').evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(15);
    await page.screenshot({ path: testInfo.outputPath(`conversation-${theme}.png`), animations: 'disabled' });
  }

  // Denied clipboard must not falsely report success.
  await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error('Clipboard denied'); }; });
  await message.getByRole('button', { name: 'Sao chép tin nhắn', exact: true }).click();
  await expect(page.getByText('Không thể sao chép. Hãy chọn văn bản và nhấn Ctrl+C.', { exact: true })).toBeVisible();
  await expect(message.getByRole('button', { name: 'Sao chép tin nhắn', exact: true })).not.toContainText('Đã sao chép');
  await page.setViewportSize({ width: 760, height: 850 });
  await expect(page.getByTitle('Mở Inspector (Ctrl+J)')).toBeVisible();
  await page.getByTitle('Mở Inspector (Ctrl+J)').click();
  await expect(page.getByRole('tab', { name: 'Tiến độ', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Tác nhân', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('compact.png'), animations: 'disabled' });
});

test('reading earlier output stays in place when task polling refreshes', async ({ page, app }) => {
  app.mock.define('long-answer', () => say(Array.from({ length: 55 }, (_, index) => `Dòng ${index + 1}: Nội dung để đọc và sao chép.`).join('\n\n')));
  app.mock.setScenario('long-answer');
  await onboard(page, app);
  const prompt = 'Show a long readable answer.';
  await send(page, prompt);
  const task = await taskByPrompt(app, prompt);
  await waitForState(app.hub, task.id, 'completed');
  await expect(page.getByTestId('conversation-message').last()).toContainText('Dòng 55:');
  const scroll = page.getByTestId('conversation-scroll');
  await scroll.evaluate(el => { el.scrollTop = 0; });
  const latest = page.getByRole('button', { name: 'Về nội dung mới nhất ↓' });
  await expect(latest).toBeVisible();
  await page.waitForResponse(response => new URL(response.url()).pathname === `/api/tasks/${task.id}` && response.request().method() === 'GET');
  await expect.poll(() => scroll.evaluate(el => el.scrollTop)).toBe(0);
  await latest.click();
  await expect.poll(() => scroll.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(80);
});
