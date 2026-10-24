// The Model field of Settings → Mô hình AI, against the real Hub and the production build of the page: the list of the provider's models with what the Hub knows of each, the line under the field
// and the note under the context window following the model that is typed, the account's own models asked of the provider only when the owner presses the button, and the promise that nothing is
// fetched from the internet unless the owner presses "Cập nhật từ models.dev" (this test never does, so that it never reaches models.dev; the update itself is tested against a server on this
// machine in tests/verify-model-catalog-refresh.mjs, and the button in ui/tests/model-picker-component.test.mjs).
import fs from 'node:fs/promises';
import path from 'node:path';
import { test, expect, onboard, openSettings } from './fixtures.mjs';

const money = (value) => String(Number(value.toFixed(4)));
const exists = (file) => fs.access(file).then(() => true, () => false);
const isRefresh = (request) => new URL(request.url()).pathname === '/api/ai/catalog/refresh';
const modelInfoUrl = (model) => `/api/ai/model-info?preset=anthropic&protocol=anthropic&apiBaseUrl=${encodeURIComponent('https://api.anthropic.com')}&model=${encodeURIComponent(model)}`;

test('on the saved connection the picker can list what the provider says the account has, and a local runtime gets no box that says there is no list', async ({ page, app }, testInfo) => {
  await onboard(page, app);
  const dialog = await openSettings(page, 'Mô hình AI');
  const model = dialog.getByRole('combobox', { name: 'Model', exact: true });
  await expect(model).toHaveValue('mock-coder');
  await expect(dialog.getByTestId('model-facts'), 'a local runtime: the catalog says nothing of a model it cannot know').toHaveCount(0);

  // typing a name on a connection the Hub has no list for draws nothing
  await model.fill('qwen2.5-coder:7b');
  await expect(dialog.getByRole('listbox')).toHaveCount(0);
  await expect(model).toHaveAttribute('aria-expanded', 'false');
  await model.fill('mock-coder');

  // the browse button opens the list whatever it holds, and says why when it is empty
  const browse = dialog.getByRole('button', { name: 'Chọn model từ danh sách', exact: true }).first();
  await browse.click();
  const list = dialog.getByRole('listbox', { name: 'Danh sách model' });
  await expect(list).toBeVisible();
  await expect(dialog.getByTestId('model-list-note')).toContainText('Hub chưa có danh sách model cho kết nối này');
  await expect(model).toHaveAttribute('aria-expanded', 'true');

  // this is the connection the Hub holds: the provider can be asked which models the saved key can use
  const accountButton = dialog.getByRole('button', { name: 'Chỉ hiện model của tài khoản', exact: true });
  await expect(accountButton).toBeVisible();
  const asked = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/ai/models');
  await accountButton.click();
  expect((await asked).status()).toBe(200);
  const options = list.getByRole('option');
  await expect(options).toHaveCount(2);
  await expect(options.nth(0)).toHaveText('mock-coder trong tài khoản');
  await expect(options.nth(1)).toHaveText('mock-coder-small trong tài khoản');
  await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');
  await expect(dialog.getByTestId('model-list-note')).toHaveText('Đã tải 2 model của tài khoản.');
  await page.screenshot({ path: testInfo.outputPath('account-models.png'), animations: 'disabled' });

  // a choice with the mouse is the value of the form, and the list closes
  await options.nth(1).click();
  await expect(model).toHaveValue('mock-coder-small');
  await expect(list).toHaveCount(0);
  expect((await app.hub.state()).ai.model, 'choosing is not saving').toBe('mock-coder');

  // the answer belongs to the connection it was asked for: choosing another provider in the form shows that provider's list, with no trace of this account's models
  await dialog.getByRole('button', { name: 'Anthropic', exact: true }).click();
  await expect(model).toHaveValue('claude-sonnet-5-5');
  await browse.click();
  await expect.poll(() => options.count(), 'the list of the other provider arrives').toBeGreaterThan(5);
  await expect(list.getByText('trong tài khoản'), 'nothing is said to be in the account').toHaveCount(0);
  await expect(options.filter({ hasText: /^mock-coder/ }), 'and none of the models of the other connection is there').toHaveCount(0);
  await expect(dialog.getByTestId('model-list-note')).toContainText('Danh sách: catalog@');
  await expect(dialog.getByRole('button', { name: 'Chỉ hiện model của tài khoản', exact: true }), 'and the account of the saved connection cannot be asked for from this form').toHaveCount(0);
});

/** True when an ancestor that scrolls or clips hides part of `locator` (the box of an open list can reach below the visible part of a dialog's body). */
const clippedByAScroller = (locator) => locator.evaluate((element) => {
  const rect = element.getBoundingClientRect();
  for (let node = element.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === 'visible') continue;
    const box = node.getBoundingClientRect();
    if (rect.bottom > box.bottom + 1 || rect.top < box.top - 1) return true;
  }
  return false;
});

test('in the first-run dialog an open list is brought into view, whole, instead of being cut off by the dialog\'s scrolling body', async ({ page, app }) => {
  await page.goto(await app.signInUrl());
  await expect(page.getByRole('heading', { name: 'Chào mừng đến với DatGold Studio' })).toBeVisible();
  await page.getByLabel('Đường dẫn workspace', { exact: true }).fill(app.project);
  await page.getByRole('button', { name: 'Áp dụng workspace', exact: true }).click();
  await expect.poll(async () => (await app.hub.state()).workspace?.path).toBe(app.project);
  await page.getByRole('button', { name: 'Tiếp tục', exact: true }).click();
  await page.getByRole('button', { name: 'Anthropic', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Chọn model từ danh sách', exact: true }).first().click();
  const note = dialog.getByTestId('model-list-note');
  await expect(dialog.getByRole('listbox', { name: 'Danh sách model' })).toBeVisible();
  await expect.poll(() => dialog.getByRole('option').count(), 'the list of the provider arrives').toBeGreaterThan(5);
  await expect(note).toBeVisible();
  await expect.poll(() => clippedByAScroller(note), 'the note at the foot of the list is not cut off by the dialog\'s body').toBe(false);
  // the first model is still where the person is looking: the field above it is not scrolled out of the dialog either
  await expect.poll(() => clippedByAScroller(dialog.getByRole('combobox', { name: 'Model', exact: true })), 'and neither is the field').toBe(false);
});

test('the Model field lists the provider\'s models with what the Hub knows of each; the notes under the fields follow the model typed; nothing is fetched or saved unless the owner presses update', async ({ page, app }, testInfo) => {
  const refreshes = [];
  page.on('request', (request) => { if (isRefresh(request)) refreshes.push(request.method()); });
  await onboard(page, app);
  const dialog = await openSettings(page, 'Mô hình AI');
  const catalog = (await app.hub.get('/api/ai/catalog')).json;
  expect(catalog).toMatchObject({ source: 'bundled', ignored: null, lastRefresh: null, refreshing: false, url: 'https://models.dev/api.json' });

  // ---- the Hub's list of models says which one it is, how old it is, and what its button contacts ----------------------------------------------------
  const status = dialog.getByTestId('catalog-status');
  await expect(status).toBeVisible();
  await expect(status.getByTestId('catalog-line')).toContainText(`${catalog.label} · đi kèm Hub`);
  await expect(status).toContainText('Chỉ khi bạn bấm: Hub tải một danh sách công khai từ models.dev. Không gửi khóa API, dự án hay nội dung của bạn.');
  await expect(status.getByTestId('catalog-update')).toBeEnabled();

  // ---- Anthropic: the model the preset names is one the catalog is sure of ------------------------------------------------------------------------
  await dialog.getByRole('button', { name: 'Anthropic', exact: true }).click();
  const model = dialog.getByRole('combobox', { name: 'Model', exact: true });
  await expect(model).toHaveValue('claude-sonnet-5-5');
  const truth = (await app.hub.get(modelInfoUrl('claude-sonnet-5-5'))).json;
  expect(truth).toMatchObject({ found: true, confidence: 'exact', trusted: true, local: false });
  const facts = dialog.getByTestId('model-facts');
  await expect(facts).toContainText(`Danh mục (${truth.source}):`);
  await expect(facts).toContainText('ngữ cảnh');
  await expect(facts).toContainText(`$${money(truth.rates.input)} / $${money(truth.rates.output)} mỗi 1M token`);
  // the window the Hub plans with is the catalog's, and nothing is written into the field
  const hint = dialog.getByTestId('context-window-hint');
  await expect(hint).toContainText(`Lấy từ danh mục model: ${truth.capacity.toLocaleString('en-US')} token (${truth.source})`);
  await expect(dialog.getByLabel('Context window tokens', { exact: true })).toHaveValue('');

  // ---- the list ---------------------------------------------------------------------------------------------------------------------------------
  const browse = dialog.getByRole('button', { name: 'Chọn model từ danh sách', exact: true }).first();
  await browse.click();
  const list = dialog.getByRole('listbox', { name: 'Danh sách model' });
  await expect(list).toBeVisible();
  const options = list.getByRole('option');
  await expect.poll(() => options.count(), 'the list of the provider arrives').toBeGreaterThan(5);
  const current = options.filter({ hasText: /^claude-sonnet-5-5 / });
  await expect(current).toHaveCount(1);
  await expect(current).toHaveAttribute('aria-selected', 'true');
  await expect(current).toContainText('ngữ cảnh');
  await expect(current).toContainText(`$${money(truth.rates.input)} / $${money(truth.rates.output)} mỗi 1M token`);
  await expect(dialog.getByTestId('model-list-note')).toContainText(`Danh sách: ${truth.source}`);
  // this is not the connection the Hub holds (it holds the local runtime): the account's models cannot be asked for yet, and the list says so
  await expect(dialog.getByText('Lưu cấu hình này trước, rồi mới tải được model của tài khoản.', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Chỉ hiện model của tài khoản', exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('catalog-list.png'), animations: 'disabled' });

  // ---- the keyboard: the arrows move the active model, Enter chooses it, and what is known of the new model follows ----------------------------------
  await expect(model).toHaveAttribute('aria-activedescendant', (await options.nth(0).getAttribute('id')) ?? '');
  await model.press('ArrowDown');
  await expect(model).toHaveAttribute('aria-activedescendant', (await options.nth(1).getAttribute('id')) ?? '');
  const second = (await options.nth(1).locator('span.font-mono').innerText()).trim();
  const answered = page.waitForResponse((response) => response.url().includes('/api/ai/model-info') && response.url().includes(encodeURIComponent(second)));
  await model.press('Enter');
  await expect(model).toHaveValue(second);
  await expect(list).toHaveCount(0);
  expect((await answered).status()).toBe(200);
  await expect(facts).toContainText('Danh mục (');

  // ---- typing narrows the list; Escape closes the list and leaves Settings open ---------------------------------------------------------------------
  await model.fill('claude-sonnet');
  await expect(list).toBeVisible();
  const matches = await list.getByRole('option').allInnerTexts();
  expect(matches.length).toBeGreaterThan(0);
  for (const text of matches) expect(text, 'every model listed has the typed text in its name').toContain('claude-sonnet');
  await model.press('Escape');
  await expect(list).toHaveCount(0);
  await expect(dialog, 'Escape closed the list, not Settings').toBeVisible();

  // ---- a name the catalog does not have: no box, no line about it, and the window is said to be unknown ------------------------------------------------
  await model.fill('my-private-deployment');
  await expect(list).toHaveCount(0);
  await expect(model).toHaveAttribute('aria-expanded', 'false');
  await expect(facts).toHaveCount(0);
  await expect(hint).toContainText('Unknown: the agent plans with a conservative estimate and shows a warning on every task.');

  // ---- the model profiles below have a picker of their own, without the account's models and without the Hub's list ----------------------------------
  const profile = dialog.getByRole('combobox', { name: 'Model profile model', exact: true });
  await profile.scrollIntoViewIfNeeded();
  await expect(profile).toBeVisible();
  await dialog.getByRole('button', { name: 'Chọn model từ danh sách', exact: true }).nth(1).click();
  await expect(dialog.getByTestId('model-list-note'), 'a profile has a protocol and no preset: there is no list to show until it names an endpoint').toContainText('Hub chưa có danh sách model cho kết nối này');
  await expect(dialog.getByRole('button', { name: 'Chỉ hiện model của tài khoản', exact: true })).toHaveCount(0);
  await expect(dialog.getByText('Lưu cấu hình này trước', { exact: false })).toHaveCount(0);
  await expect(dialog.getByTestId('catalog-status'), 'the Hub\'s list of models is named once, in the connection').toHaveCount(1);
  await profile.press('Escape');
  await expect(dialog).toBeVisible();

  // ---- nothing was fetched, nothing was saved ---------------------------------------------------------------------------------------------------------
  expect(refreshes, 'no request to update the list of models').toEqual([]);
  expect(await exists(path.join(app.hub.stateDir, 'model-catalog.json')), 'no list of models saved in the Hub\'s data folder').toBe(false);
  expect((await app.hub.get('/api/ai/catalog')).json).toMatchObject({ source: 'bundled', lastRefresh: null, refreshing: false });
  expect((await app.hub.state()).ai.model, 'choosing and typing are not saving').toBe('mock-coder');
});

test('a model whose price rises with the length of the prompt is planned only up to the rise, and the note under the window says why; a window the owner types goes past it', async ({ page, app }) => {
  await onboard(page, app);
  const dialog = await openSettings(page, 'Mô hình AI');
  await dialog.getByRole('button', { name: 'Google Gemini', exact: true }).click();
  const model = dialog.getByRole('combobox', { name: 'Model', exact: true });
  const ask = async (name) => (await app.hub.get(`/api/ai/model-info?preset=gemini&protocol=gemini&apiBaseUrl=${encodeURIComponent('https://generativelanguage.googleapis.com')}&model=${encodeURIComponent(name)}`)).json;
  const grouped = (value) => value.toLocaleString('en-US');
  const rates = (pair) => `$${money(pair.input)} / $${money(pair.output)}`;

  // gemini-2.5-pro: its price rises above 200,000 tokens, so the Hub plans on 200,000 although the model takes about a million
  await model.fill('gemini-2.5-pro');
  const pro = await ask('gemini-2.5-pro');
  expect(pro).toMatchObject({ found: true, confidence: 'exact', trusted: true });
  expect(pro.priceCap, 'the Hub says which price rise stopped the plan').toMatchObject({ aboveTokens: 200000, tokens: 200000, floored: false });
  expect([pro.capacity, pro.modelCapacity]).toEqual([200000, pro.contextWindow]);
  const hint = dialog.getByTestId('context-window-hint');
  await expect(hint).toContainText(`Hub lập kế hoạch trên 200,000 token (${pro.source}) dù cửa sổ của model là ${grouped(pro.contextWindow)}`);
  await expect(hint).toContainText(`vì khi lời nhắc dài hơn 200,000 token giá tăng từ ${rates(pro.priceCap.from)} lên ${rates(pro.priceCap.to)} mỗi 1M token (vào / ra)`);
  await expect(dialog.getByLabel('Context window tokens', { exact: true }), 'nothing is written into the owner\'s field').toHaveValue('');

  // a model whose price does not rise keeps the plain note, with all the window the model allows
  await model.fill('gemini-2.5-flash');
  const flash = await ask('gemini-2.5-flash');
  expect(flash.priceCap).toBeNull();
  await expect(hint).toContainText(`Lấy từ danh mục model: ${grouped(flash.capacity)} token (${flash.source})`);
  await expect(hint).not.toContainText('giá tăng');

  // the owner's own window is planned on whatever the catalog says: the note stops talking about the catalog
  await model.fill('gemini-2.5-pro');
  await expect(hint).toContainText('vì khi lời nhắc dài hơn 200,000 token');
  await dialog.getByLabel('Context window tokens', { exact: true }).fill('500000');
  await expect(hint).not.toContainText('Hub lập kế hoạch');
  await expect(hint).toContainText('Allowed: 4,096 - 2,000,000 tokens');
});
