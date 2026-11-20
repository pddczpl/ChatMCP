// The MCP servers tab against a real Hub and the production build of the page (P2 slice D, ext-14; docs/MCP-CLIENT.md "The screen and its routes").
// The owner adds the stdio fixture tests/fixtures/mcp-seam-server.mjs with a secret in its env, reads its launch record and approves it (the page sends
// the fingerprint it showed), the page starts the server, the owner reads its tools and approves them (again the fingerprint shown), sees the tools
// with their rules and sets one of them to deny. The Hub, its routes and the server are real; nothing is stubbed. That the rule then refuses the tool
// in a task is pinned against the same routes in tests/verify-mcp-http.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { test, expect, onboard, openWorkTab } from './fixtures.mjs';
import { HUB_ROOT } from '../../tests/e2e/hub-process.mjs';
import { runtimeRoot } from '../../tests/support/mcp-tools.mjs';

const SEAM = path.join(HUB_ROOT, 'tests', 'fixtures', 'mcp-seam-server.mjs');
const TOOLS = ['echo', 'create_issue', 'wipe_cache', 'forbidden', 'write_note', 'images', 'crash', 'bad_params'];
const runtime = runtimeRoot();
// A copy of the Hub has no SDK beside it; this checkout's (scripts/mcp-runtime) is named for the Hub the fixture starts.
test.use({ hubEnv: runtime ? { CHATMCP_MCP_RUNTIME_DIR: runtime } : {} });
const isPost = (route) => (response) => new URL(response.url()).pathname === route && response.request().method() === 'POST';

test('the MCP tab adds a stdio server, approves its launch and its tools by the fingerprints shown, lists the tools and denies one', async ({ page, app }, testInfo) => {
  expect(runtime, 'the MCP client SDK must be installed: npm ci --ignore-scripts --no-audit --no-fund --prefix scripts/mcp-runtime').toBeTruthy();
  const secret = `sk-e2e-${randomBytes(12).toString('hex')}`;
  const counts = path.join(app.scratch, 'seam-calls.txt');
  await onboard(page, app);
  await openWorkTab(page, 'Máy chủ MCP');
  const tab = page.getByTestId('mcp-tab');
  await expect(tab.getByRole('heading', { name: /Máy chủ MCP bên ngoài/ })).toBeVisible();
  await expect(tab.getByText('Chưa có máy chủ MCP nào.', { exact: true })).toBeVisible();

  // ---- the owner adds the server --------------------------------------------------------------------------------------------------------------------
  await tab.getByRole('button', { name: 'Thêm máy chủ', exact: true }).click();
  const form = tab.getByTestId('mcp-server-form');
  await form.getByLabel('Mã máy chủ (a-z, 0-9, _ và -)', { exact: true }).fill('seam');
  await form.getByLabel('Lệnh', { exact: true }).fill(process.execPath);
  await form.getByLabel('Tham số (mỗi dòng một tham số)', { exact: true }).fill([SEAM, '--count-file', counts].join('\n'));
  await form.getByRole('button', { name: 'Thêm biến', exact: true }).click();
  await form.getByLabel('Tên', { exact: true }).fill('API_TOKEN');
  await form.getByLabel('Giá trị', { exact: true }).fill(secret);
  const saving = page.waitForResponse(isPost('/api/mcp/server/upsert'));
  await form.getByRole('button', { name: 'Lưu máy chủ', exact: true }).click();
  const saved = await saving;
  expect(saved.status()).toBe(200);
  expect(saved.request().postDataJSON()).toEqual({ id: 'seam', server: { transport: 'stdio', command: process.execPath, args: [SEAM, '--count-file', counts], env: { API_TOKEN: secret }, enabled: true, trust: { annotations: false }, touchesWorkspace: false } });
  expect((await saved.json()).server.env, 'a credential name is stored as a secret and comes back only as "set"').toEqual({ API_TOKEN: { secret: true } });
  await expect(form).toHaveCount(0);
  const card = tab.getByTestId('mcp-server-seam');
  await expect(card.getByTestId('mcp-state-seam')).toHaveText('Chưa kết nối');
  await expect(card).toContainText('Máy chủ này chưa được khởi động: bạn cần duyệt lệnh khởi động của nó.');
  expect(fs.existsSync(counts), 'nothing was started').toBe(false);
  await page.screenshot({ path: testInfo.outputPath('mcp-1-added.png'), animations: 'disabled' });

  // ---- the launch record and its approval --------------------------------------------------------------------------------------------------------
  const recording = page.waitForResponse(isPost('/api/mcp/server/launch-record'));
  await card.getByRole('button', { name: 'Xem lệnh khởi động', exact: true }).click();
  const record = await (await recording).json();
  const shown = card.getByTestId('mcp-launch-record');
  for (const text of [SEAM, '--count-file', 'API_TOKEN', record.record.executable, record.record.sha256, record.fingerprint]) await expect(shown).toContainText(text);
  await expect(shown).not.toContainText(secret);
  await page.screenshot({ path: testInfo.outputPath('mcp-2-launch-record.png'), animations: 'disabled' });
  const approving = page.waitForResponse(isPost('/api/mcp/server/approve-launch'));
  const testing = page.waitForResponse(isPost('/api/mcp/server/test'));
  await shown.getByRole('button', { name: 'Duyệt lệnh khởi động này', exact: true }).click();
  const approved = await approving;
  expect(approved.status()).toBe(200);
  expect(approved.request().postDataJSON(), 'the page approves the fingerprint it showed').toEqual({ id: 'seam', expectedFingerprint: record.fingerprint });
  const tested = await (await testing).json();
  expect(tested).toMatchObject({ ok: true, error: null, status: { state: 'needs_review', tools: TOOLS.length } });
  await expect(card.getByTestId('mcp-state-seam')).toHaveText('Cần duyệt công cụ');
  await expect(card).toContainText('Lệnh khởi động đã được duyệt.');
  await expect(card).toContainText('Danh sách công cụ chưa được duyệt: agent chưa thấy công cụ nào của máy chủ này.');

  // ---- the tools and their approval --------------------------------------------------------------------------------------------------------------
  const reviewing = page.waitForResponse(isPost('/api/mcp/server/tool-review'));
  await card.getByRole('button', { name: 'Xem danh sách để duyệt', exact: true }).click();
  const review = await (await reviewing).json();
  const list = card.getByTestId('mcp-tool-review');
  await expect(list).toContainText('Lần duyệt đầu');
  for (const name of TOOLS) await expect(list).toContainText(name);
  await expect(list).toContainText('phá huỷ (lời máy chủ)');
  await page.screenshot({ path: testInfo.outputPath('mcp-3-tool-review.png'), animations: 'disabled' });
  const pinning = page.waitForResponse(isPost('/api/mcp/server/approve-tools'));
  await list.getByRole('button', { name: 'Duyệt danh sách này', exact: true }).click();
  const pinned = await pinning;
  expect(pinned.status()).toBe(200);
  expect(pinned.request().postDataJSON(), 'the page approves the lists it showed').toEqual({ id: 'seam', expectedFingerprint: review.fingerprint });
  await expect(card.getByTestId('mcp-state-seam')).toHaveText('Đã kết nối');
  await expect(list).toHaveCount(0);
  for (const name of TOOLS) await expect(card.getByTestId(`mcp-tool-seam-${name}`)).toBeVisible();
  await expect(card.getByTestId('mcp-tool-seam-echo')).toContainText('chỉ đọc (lời máy chủ)');
  await expect(card.getByTestId('mcp-tool-seam-forbidden').getByRole('combobox')).toHaveValue('');
  await page.screenshot({ path: testInfo.outputPath('mcp-4-connected.png'), animations: 'disabled' });

  // ---- one tool set to deny -----------------------------------------------------------------------------------------------------------------------
  const row = card.getByTestId('mcp-tool-seam-forbidden');
  const choosing = page.waitForResponse(isPost('/api/mcp/server/tool-policy'));
  await row.getByRole('combobox', { name: 'Quy tắc cho forbidden', exact: true }).selectOption('deny');
  const chosen = await choosing;
  expect(chosen.status()).toBe(200);
  expect(chosen.request().postDataJSON()).toEqual({ id: 'seam', tools: { forbidden: 'deny' } });
  await expect(row.getByRole('combobox')).toHaveValue('deny');
  const listed = await app.hub.get('/api/mcp/servers');
  expect(listed.json.servers.find((server) => server.id === 'seam').tools.find((tool) => tool.name === 'forbidden')).toMatchObject({ rule: 'deny', policy: 'deny' });
  expect(JSON.parse(fs.readFileSync(path.join(app.hub.stateDir, 'mcp-servers.json'), 'utf8')).servers.seam.policy).toEqual({ tools: { forbidden: 'deny' } });
  await page.screenshot({ path: testInfo.outputPath('mcp-5-denied.png'), animations: 'disabled' });

  // ---- what never showed -------------------------------------------------------------------------------------------------------------------------
  expect(listed.text).not.toContain(secret);
  expect(await page.content()).not.toContain(secret);
  expect(fs.existsSync(counts), 'no tool of the server was called').toBe(false);
});
