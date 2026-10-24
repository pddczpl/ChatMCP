// Screenshot gallery of the real UI: a real Hub, a scripted model and a real Chromium, driven the way a person uses the app.
//
//   npm run build && npm run gallery -- [outDir] [width] [height]        (defaults: test-results/gallery 1440 900)
//
// It is how the design is reviewed (before/after, dark/light, narrow/wide) and a cheap smoke test of every screen: it fails if
// the page logs an error. Nothing here reaches the network: the model is the loopback scripted server of the e2e tests.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { startHub, waitFor } from '../../tests/e2e/hub-process.mjs';
import { startMockModel } from '../../tests/e2e/mock-model-server.mjs';
import { makeCalcProject, gitInit } from '../../tests/e2e/fixtures.mjs';
import { call, say, shaOf, exitedZero } from '../../tests/e2e/scenarios.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(process.argv[2] || path.join(here, '..', 'test-results', 'gallery'));
const width = Number(process.argv[3] || 1440);
const height = Number(process.argv[4] || 900);
fs.mkdirSync(out, { recursive: true });

const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'chatmcp-gallery-')));
const project = path.join(scratch, 'workspace');
makeCalcProject(project);
gitInit(project, scratch);
const mock = await startMockModel();
const hub = await startHub({ scratch });
let browser;
const errors = [];
const shot = async (page, name) => {
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(out, `${name}.png`), animations: 'disabled' });
  console.log('shot', name);
};

try {
  // A turn with reading, a plan, an edit that needs approval, a command that needs approval, and a Markdown answer.
  mock.define('gallery', ({ turn, last, results }) => {
    if (turn === 0) return call('list_directory', {});
    if (turn === 1) return call('read_file', { path: 'calc.js' });
    if (turn === 2) return call('update_plan', { title: 'Sửa phép cộng', items: [
      { text: 'Đọc calc.js', status: 'done', evidence: `read_file sha256 ${shaOf(last)}` },
      { text: 'Sửa phép cộng', status: 'doing' },
      { text: 'Chạy node test.js', status: 'todo' },
    ] });
    if (turn === 3) return call('edit_file', { path: 'calc.js', old_string: 'return a - b;', new_string: 'return a + b;', expected_sha256: shaOf(results[1]) });
    if (turn === 4) return call('run_command', { command: 'node test.js', description: 'Kiểm tra hàm add()' });
    if (turn === 5) return call('update_plan', { title: 'Sửa phép cộng', items: [
      { text: 'Đọc calc.js', status: 'done', evidence: 'read_file completed' },
      { text: 'Sửa phép cộng', status: 'done', evidence: 'edit_file changed calc.js' },
      { text: 'Chạy node test.js', status: exitedZero(last) ? 'done' : 'blocked', evidence: exitedZero(last) ? 'exit code 0' : 'failed' },
    ] });
    return say('## Kết quả\n\nĐã sửa `add()` trong `calc.js`:\n\n- `a - b` → `a + b`\n- Chạy `node test.js`: **thành công**, exit code 0\n\n```js\nfunction add(a, b) {\n  return a + b;\n}\n```\n\n| Bước | Trạng thái |\n|---|---|\n| Đọc file | xong |\n| Sửa | xong |\n| Test | đạt |\n\nBạn muốn mình viết thêm test cho trường hợp số âm không?');
  });
  mock.setScenario('gallery');

  browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 })).newPage();
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });

  const { ticket } = await hub.post('/api/session/ticket', {});
  await page.goto(`${hub.origin}/#chatmcp-boot=${ticket}`);
  await page.getByRole('heading', { name: 'Chào mừng đến với DatGold Studio' }).waitFor();
  await shot(page, '01-onboarding-workspace');
  await page.getByLabel('Đường dẫn workspace', { exact: true }).fill(project);
  await page.getByRole('button', { name: 'Áp dụng workspace', exact: true }).click();
  await waitFor(async () => (await hub.state()).workspace?.path === project);
  await page.getByRole('button', { name: 'Tiếp tục', exact: true }).click();
  await page.getByRole('button', { name: 'Ollama (Local)', exact: true }).click();
  await page.getByLabel('API base URL', { exact: true }).fill(mock.url);
  await page.getByLabel('Model', { exact: true }).fill('mock-coder');
  const checked = page.waitForResponse((response) => response.url().endsWith('/api/ai/test') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Lưu & kiểm tra', exact: true }).click();
  await checked;
  await shot(page, '02-onboarding-model');
  await page.getByRole('button', { name: 'Tiếp tục', exact: true }).click();
  await page.getByRole('button', { name: /Review \(Khuyên dùng\)/ }).click();
  await shot(page, '03-onboarding-permissions');
  await page.getByRole('button', { name: 'Bắt đầu làm việc ngay', exact: true }).click();
  await waitFor(async () => { const state = await hub.state(); return state.catalogReady && !state.busy; });
  await page.waitForTimeout(500);
  await shot(page, '10-empty');

  // the work panel
  const tabs = page.getByRole('tab');
  const names = (await tabs.allTextContents()).map((name) => name.trim());
  for (let index = 0; index < names.length; index++) {
    await tabs.nth(index).click();
    await shot(page, `2${index}-work-${names[index].toLowerCase().replace(/đ/g, 'd').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-')}`);
  }

  // the Agents tab has sections of its own: groups of read-only helpers and coding workers
  await page.getByRole('tab', { name: 'Tác nhân', exact: true }).click();
  for (const [section, slug, marker] of [['Nhóm trợ lý', 'groups', 'agent-groups'], ['Sửa mã', 'coding', 'coding-agents']]) {
    await page.getByRole('tab', { name: section, exact: true }).click();
    await page.getByTestId(marker).waitFor(); // a section is a script fetched when its tab is first opened
    await shot(page, `26-work-agents-${slug}`);
  }
  await page.getByRole('tab', { name: 'Tiến độ', exact: true }).click();

  // Settings, one page per section
  await page.getByRole('button', { name: 'Cài đặt', exact: true }).first().click();
  const menu = page.getByRole('navigation', { name: 'Các mục cài đặt' }).getByRole('button');
  const sections = (await menu.allTextContents()).map((name) => name.trim());
  for (let index = 0; index < sections.length; index++) {
    await menu.nth(index).click();
    await shot(page, `3${index}-settings-${sections[index].toLowerCase().replace(/đ/g, 'd').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-')}`);
  }
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+k');
  await shot(page, '40-command-palette');
  await page.keyboard.press('Escape');

  // a real turn, with both approvals
  await tabs.first().click();
  await page.locator('textarea').fill('Sửa lỗi phép cộng trong calc.js rồi chạy test để chứng minh.');
  await page.getByRole('button', { name: 'Gửi', exact: true }).click();
  const approve = page.getByRole('button', { name: 'Phê duyệt', exact: true }).and(page.locator(':enabled'));
  await approve.waitFor({ timeout: 40000 });
  await shot(page, '50-approval-edit');
  await approve.click();
  await page.getByRole('region', { name: /Phê duyệt local.run_command/ }).waitFor({ timeout: 40000 });
  await shot(page, '51-approval-command');
  await approve.click();
  await page.locator('#panel-conversation').getByText('Bạn muốn mình viết thêm test', { exact: false }).waitFor({ timeout: 40000 });
  await shot(page, '52-conversation-done');
  await page.getByRole('tab', { name: 'Thay đổi' }).click();
  await shot(page, '53-changes');

  // Activity and Preview live under "⋯" until they are chosen
  await page.getByRole('button', { name: 'Thêm', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Hoạt động', exact: true }).click();
  await shot(page, '54-work-activity');
  await page.getByRole('button', { name: 'Thêm', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Xem trước', exact: true }).click();
  await shot(page, '55-work-preview');

  // light theme: the conversation, every work tab and every Settings page
  await page.getByTitle('Chuyển theme sáng / tối').click();
  await page.getByRole('tab', { name: 'Tiến độ' }).click();
  await shot(page, '60-light-conversation');
  for (let index = 0; index < names.length; index++) {
    await tabs.nth(index).click();
    await shot(page, `61-light-work-${index}`);
  }
  await page.getByRole('tab', { name: 'Tác nhân', exact: true }).click();
  for (const [section, slug, marker] of [['Nhóm trợ lý', 'groups', 'agent-groups'], ['Sửa mã', 'coding', 'coding-agents']]) {
    await page.getByRole('tab', { name: section, exact: true }).click();
    await page.getByTestId(marker).waitFor();
    await shot(page, `64-light-agents-${slug}`);
  }
  await page.getByRole('tab', { name: 'Tiến độ', exact: true }).click();
  await page.getByRole('button', { name: 'Cài đặt', exact: true }).first().click();
  for (let index = 0; index < sections.length; index++) {
    await menu.nth(index).click();
    await shot(page, `62-light-settings-${index}`);
  }
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+k');
  await shot(page, '63-light-command-palette');
  await page.keyboard.press('Escape');
  await page.getByTitle('Chuyển theme sáng / tối').click();

  // narrow and wide
  for (const [w, h] of [[1920, 1080], [1280, 800], [1100, 800], [940, 700], [600, 900]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(300);
    await shot(page, `7-width-${w}x${h}`);
  }
  if (errors.length) throw new Error(`the page logged ${errors.length} error(s):\n${errors.join('\n')}`);
  console.log(`gallery: ${fs.readdirSync(out).length} screenshots in ${out}, no console errors`);
} finally {
  await browser?.close().catch(() => {});
  await hub.stop().catch(() => {});
  await mock.close().catch(() => {});
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}
