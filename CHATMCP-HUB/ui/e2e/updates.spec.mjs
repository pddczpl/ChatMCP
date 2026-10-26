// The update notice against the real Hub and the production build of the page: the strip under the header asks the owner once, a "yes" makes one look at the feed (a loopback server that
// stands in for GitHub: tests/e2e/update-feed-server.mjs), the release on offer is announced with a link to its notes and a button to skip it, and the skip, the choice and the notice
// survive a reload and a Hub restart. Settings → Cập nhật / Updates shows the versions, "Check now" and the owner's choice, in both languages. Nothing is mocked in the page, and nothing is
// intercepted but in the last test, which hands the page an answer to its poll that only a window that had been asleep would get (the Hub cannot make the page sleep).
//
// The link to the notes is never clicked: it goes to github.com. Its address, target and rel are read instead. Inside the desktop shell the same link goes through the shell's
// new-window path (a preview tab), which this suite does not exercise (docs/THREAT-MODEL.md, Surface 8).
import { test as base, expect, openSettings, closeSettings, setTheme } from './fixtures.mjs';
import { startUpdateFeed, feedManifest } from '../../tests/e2e/update-feed-server.mjs';
import { throwawayKey } from '../../tests/support/release-keys.mjs';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const test = base.extend({
  feed: async ({}, use) => { // eslint-disable-line no-empty-pattern
    const feed = await startUpdateFeed();
    try { await use(feed); } finally { await feed.close(); }
  },
  // The Hub reads the stand-in instead of GitHub (the one hook, and it takes a loopback address only), and its first look after "yes" comes after 0.3 s instead of half a minute.
  hubEnv: async ({ feed }, use) => { await use({ CHATMCP_UPDATE_FEED_URL: feed.url, CHATMCP_UPDATE_FIRST_CHECK_MS: '300' }); },
});

const VIETNAMESE = /[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/i;
const AUTO = '/api/update/auto-check';
const CHECK = '/api/update/check';
const SKIP = '/api/update/skip';
const post = (route) => (response) => new URL(response.url()).pathname === route && response.request().method() === 'POST';
const STATE = (app) => path.join(app.hub.stateDir, 'update-check.json');
const SETTINGS = (app) => path.join(app.hub.stateDir, 'update-settings.json');

/** The page without the first-run walkthrough: this suite is about the strip under the header and Settings, not about the setup. */
async function open(page, app) {
  await page.addInitScript(() => localStorage.setItem('chatmcp:onboarding-completed', '1'));
  await page.goto(await app.signInUrl());
  await expect(page.getByRole('button', { name: 'Cài đặt', exact: true })).toBeVisible();
}
const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

/** The contrast ratio of the text of an element against what it is really drawn on: the translucent backgrounds of its ancestors are laid over each other, over white. */
const contrast = (locator) => locator.evaluate((element) => {
  const parse = (color) => { const parts = color.match(/[\d.]+/g).map(Number); return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1]; };
  const luminance = ([r, g, b]) => [r, g, b].map((value) => { const c = value / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }).reduce((sum, c, index) => sum + c * [0.2126, 0.7152, 0.0722][index], 0);
  const layers = [];
  for (let node = element; node; node = node.parentElement) {
    const layer = parse(getComputedStyle(node).backgroundColor);
    if (layer[3] > 0) layers.push(layer);
    if (layer[3] === 1) break;
  }
  let back = [255, 255, 255];
  for (const layer of layers.reverse()) back = back.map((value, index) => layer[index] * layer[3] + value * (1 - layer[3]));
  const fore = luminance(parse(getComputedStyle(element).color));
  const ground = luminance(back);
  return (Math.max(fore, ground) + 0.05) / (Math.min(fore, ground) + 0.05);
});

test('the owner is asked once, a yes makes one look, the release is announced and can be skipped, and it all survives a reload and a restart', async ({ page, context, app, feed, browserErrors }, testInfo) => {
  await open(page, app);

  // ---- the question: shown to a Hub nobody has answered, and the Hub is quiet until it is answered ---------------------------------------------
  const question = page.getByTestId('update-question');
  await expect(question).toBeVisible();
  await expect(question).toHaveAttribute('role', 'status');
  await expect(page.getByTestId('update-question-title')).toHaveText('DatGold có thể báo khi có bản mới. Bạn có muốn không?');
  await expect(page.getByTestId('update-question-body')).toContainText('GitHub thấy địa chỉ IP của bạn và dòng "DatGold/3.10.2"');
  await expect(page.getByTestId('update-question-body')).toContainText('không tải gì về trừ khi bạn bấm Tải về, và không cài gì');
  await expect(page.getByTestId('update-notice')).toHaveCount(0);
  expect((await app.hub.state()).update.autoCheck).toEqual({ enabled: false, saved: null, needsChoice: true });
  await page.waitForTimeout(1500); // five times the 0.3 s the Hub would wait if it were allowed to ask
  expect(feed.requests.length, 'ZERO requests to the feed while the owner has not answered').toBe(0);
  await page.screenshot({ path: testInfo.outputPath('question.png'), animations: 'disabled' });
  const unreadable = [];
  for (const theme of ['light', 'dark']) {
    await setTheme(page, theme);
    await page.waitForTimeout(400); // the buttons change colour over 150 ms: read them at rest
    for (const id of ['update-question-title', 'update-question-body', 'update-yes', 'update-no', 'update-details']) {
      const ratio = await contrast(page.getByTestId(id));
      if (ratio < 4.5) unreadable.push(`${id} in the ${theme} theme: ${ratio.toFixed(2)} ${await page.getByTestId(id).evaluate((el) => `${getComputedStyle(el).color} on ${getComputedStyle(el).backgroundColor}`)}`);
    }
  }
  expect(unreadable, 'the question reads at 4.5:1 or better in both themes').toEqual([]);

  // ---- yes: the choice is saved, one look is made at once, and the strip becomes the notice --------------------------------------------------------
  const saved = page.waitForResponse(post(AUTO));
  const looked = page.waitForResponse(post(CHECK));
  await page.getByTestId('update-yes').click();
  const savedAnswer = await saved;
  expect(savedAnswer.status()).toBe(200);
  expect(savedAnswer.request().postDataJSON()).toEqual({ enabled: true });
  const lookedAnswer = await looked;
  expect(lookedAnswer.status()).toBe(200);
  const body = await lookedAnswer.json();
  expect(Object.keys(body).sort(), 'the state is under "update": a top-level "error" would read as a failed request').toEqual(['checked', 'csrfToken', 'throttled', 'update']);
  expect([body.checked, body.throttled]).toEqual([true, false]);
  const notice = page.getByTestId('update-notice');
  await expect(notice).toBeVisible();
  await expect(question).toHaveCount(0);
  await expect(page.getByTestId('update-notice-text')).toHaveText('Đã có DatGold 3.10.3.');
  await expect(notice).toHaveAttribute('data-version', '3.10.3');
  expect(feed.checks(), 'POSITIVE CONTROL: after a yes the Hub asked, once').toBe(1);
  expect((await app.hub.state()).update).toMatchObject({ current: '3.10.2', latest: '3.10.3', available: true, installerName: 'DatGoldSetup.exe', skippedVersion: null, error: null, signature: 'missing', autoCheck: { enabled: true, saved: true, needsChoice: false } });
  // the stand-in has no signature for it (the owner has not signed): the release is announced, and the strip says why there is no button
  await expect(page.getByTestId('update-signature-note')).toContainText('Bản này chưa được ký nên DatGold sẽ không tải');
  await expect(page.getByTestId('update-download')).toHaveCount(0);
  expect(JSON.parse(await fs.readFile(SETTINGS(app), 'utf8'))).toEqual({ version: 1, autoCheckUpdates: true });

  // the link to the notes: GitHub's tag page of that release, opened outside the page (read, not clicked: it is the internet)
  const notes = page.getByTestId('update-notes');
  await expect(notes).toHaveText('Có gì mới');
  await expect(notes).toHaveAttribute('href', 'https://github.com/pddczpl/ChatMCP/releases/tag/v3.10.3');
  await expect(notes).toHaveAttribute('target', '_blank');
  await expect(notes).toHaveAttribute('rel', 'noopener noreferrer');
  // inside the desktop shell the link may open nothing (the preview tab cannot show github.com): the address can always be copied
  const copy = page.getByTestId('update-copy').getByRole('button', { name: 'Sao chép liên kết ghi chú phát hành', exact: true });
  await expect(copy).toBeVisible();
  for (const theme of ['light', 'dark']) {
    await setTheme(page, theme);
    await page.waitForTimeout(400);
    for (const [name, element] of [['update-notice-text', page.getByTestId('update-notice-text')], ['update-notes', notes], ['update-copy', copy], ['update-skip', page.getByTestId('update-skip')], ['update-signature-note', page.getByTestId('update-signature-note')]]) {
      const ratio = await contrast(element);
      if (ratio < 4.5) unreadable.push(`${name} in the ${theme} theme: ${ratio.toFixed(2)}`);
    }
    await page.screenshot({ path: testInfo.outputPath(`notice-${theme}.png`), animations: 'disabled' });
  }
  expect(unreadable, 'the notice reads at 4.5:1 or better in both themes').toEqual([]);
  // a narrow window: the strip wraps and nothing scrolls sideways
  await page.setViewportSize({ width: 640, height: 900 });
  await expect(notice).toBeVisible();
  expect(await noSideways(page), 'the notice does not scroll the page sideways').toBe(true);
  await page.screenshot({ path: testInfo.outputPath('notice-narrow.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 1600, height: 1000 });

  // ---- skip: the Hub keeps it, and the page does not show that release again ------------------------------------------------------------------------
  const skipped = page.waitForResponse(post(SKIP));
  await page.getByTestId('update-skip').click();
  const skipAnswer = await skipped;
  expect(skipAnswer.status()).toBe(200);
  expect(skipAnswer.request().postDataJSON()).toEqual({ version: '3.10.3' });
  await expect(notice).toHaveCount(0);
  expect(JSON.parse(await fs.readFile(STATE(app), 'utf8')).skippedVersion).toBe('3.10.3');
  await browserErrors.flush(page);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Cài đặt', exact: true })).toBeVisible();
  await expect(notice, 'a reloaded page finds the skip: it is the Hub\'s, not the tab\'s').toHaveCount(0);
  await expect(question).toHaveCount(0);

  // ---- a Hub restart: the notice is known at once, the skip is still there, and nothing is asked inside the 15-minute floor ----------------------
  await browserErrors.closePage(page);
  await app.restart();
  const next = await context.newPage();
  await open(next, app);
  await expect(next.getByTestId('update-notice'), 'skipped before the restart: not shown after it').toHaveCount(0);
  await expect(next.getByTestId('update-question')).toHaveCount(0);
  expect((await app.hub.state()).update).toMatchObject({ latest: '3.10.3', available: true, skippedVersion: '3.10.3' });
  await next.waitForTimeout(1500);
  expect(feed.checks(), 'the restarted Hub, allowed to ask but inside the floor of the last attempt, asked nothing').toBe(1);
  const dialog = await openSettings(next, 'Cập nhật');
  await expect(dialog.getByTestId('updates-current')).toHaveText('v3.10.2');
  await expect(dialog.getByTestId('updates-latest')).toHaveText('v3.10.3');
  await expect(dialog.getByTestId('updates-status')).toHaveText('Có DatGold 3.10.3, nhưng bạn đã bỏ qua bản này.');
  await expect(dialog.getByTestId('updates-skip')).toHaveCount(0);
  const remind = next.waitForResponse(post(SKIP));
  await dialog.getByTestId('updates-unskip').click();
  expect((await remind).request().postDataJSON()).toEqual({ version: null });
  await expect(dialog.getByTestId('updates-status')).toHaveText('Có DatGold 3.10.3.');
  await closeSettings(next);
  await expect(next.getByTestId('update-notice'), 'taking the skip back shows the notice again').toBeVisible();
  expect(feed.requests.every((request) => !/\.exe|\.zip/i.test(request.url.split('?')[0])), 'the feed was never asked for an installer: nobody pressed Download').toBe(true);
  // a restarted Hub has not looked at the signature yet (nothing about it is saved): the strip says why there is no button, offers to look, and offers no way to install
  await expect(next.getByTestId('update-signature-note')).toContainText('chưa xem chữ ký của bản này');
  await expect(next.getByTestId('update-recheck')).toHaveText('Kiểm tra ngay');
  await expect(next.getByTestId('update-download')).toHaveCount(0);
});

test('No: nothing is asked; "Check now" in Settings finds the release, a second press waits; the screens read English too', async ({ page, app, feed }, testInfo) => {
  await open(page, app);
  const declined = page.waitForResponse(post(AUTO));
  await page.getByTestId('update-no').click();
  expect((await declined).request().postDataJSON()).toEqual({ enabled: false });
  await expect(page.getByTestId('update-question')).toHaveCount(0);
  await expect(page.getByTestId('update-notice')).toHaveCount(0);
  expect(JSON.parse(await fs.readFile(SETTINGS(app), 'utf8'))).toEqual({ version: 1, autoCheckUpdates: false });
  await page.waitForTimeout(1500);
  expect(feed.requests.length, 'ZERO requests after a no, in the timing in which a yes asks (see the test above)').toBe(0);

  const dialog = await openSettings(page, 'Cập nhật');
  await expect(dialog.getByRole('heading', { name: 'Cập nhật DatGold', exact: true })).toBeVisible();
  await expect(dialog.getByTestId('updates-current')).toHaveText('v3.10.2');
  await expect(dialog.getByTestId('updates-latest')).toHaveText('–');
  await expect(dialog.getByTestId('updates-checked')).toHaveText('Chưa kiểm tra');
  await expect(dialog.getByTestId('updates-status')).toHaveText('Chưa biết bản mới nhất.');
  const auto = dialog.getByTestId('updates-auto-toggle');
  await expect(auto).not.toBeChecked();
  await expect(dialog.getByTestId('updates-auto-status')).toContainText('Đang tắt (bạn đã chọn).');
  await page.screenshot({ path: testInfo.outputPath('settings-before.png'), animations: 'disabled' });

  const checked = page.waitForResponse(post(CHECK));
  await dialog.getByTestId('updates-check').click();
  expect((await checked).status()).toBe(200);
  await expect(dialog.getByTestId('updates-latest')).toHaveText('v3.10.3');
  await expect(dialog.getByTestId('updates-status')).toHaveText('Có DatGold 3.10.3.');
  await expect(dialog.getByTestId('updates-checked')).not.toHaveText('Chưa kiểm tra');
  await expect(dialog.getByTestId('updates-check'), 'a second press is held back for the minute the Hub keeps').toBeDisabled();
  await expect(dialog.getByTestId('updates-wait')).toHaveText(/^Vừa kiểm tra xong\. Kiểm tra lại được sau \d+ giây\.$/);
  expect(feed.checks(), 'one look, made because the owner pressed the button').toBe(1);
  await expect(dialog.getByTestId('updates-notes')).toHaveAttribute('href', 'https://github.com/pddczpl/ChatMCP/releases/tag/v3.10.3');
  await expect(dialog.getByTestId('updates-copy')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('settings-after.png'), animations: 'disabled' });
  await closeSettings(page);
  await expect(page.getByTestId('update-notice'), 'said no, and a manual look found a release: it is announced').toBeVisible();

  // the same words in English, from the real language switch
  const vietnamese = await openSettings(page, 'Giao diện & ngôn ngữ');
  await vietnamese.getByRole('button', { name: 'English', exact: true }).click();
  const english = page.getByRole('dialog', { name: 'Settings', exact: true });
  await english.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Updates', exact: true }).click();
  await expect(english.getByRole('heading', { name: 'DatGold updates', exact: true })).toBeVisible();
  await expect(english.getByTestId('updates-status')).toHaveText('DatGold 3.10.3 is available.');
  await expect(english.getByTestId('updates-auto-status')).toContainText('Off (your choice).');
  expect(await english.innerText(), 'Settings → Updates reads English').not.toMatch(VIETNAMESE);
  await page.keyboard.press('Escape');
  await expect(english).toHaveCount(0);
  await expect(page.getByTestId('update-notice-text')).toHaveText('DatGold 3.10.3 is available.');
  await expect(page.getByTestId('update-skip')).toHaveText('Skip this version');
  await expect(page.getByTestId('update-notes')).toHaveText("What's new");
  expect(await page.getByTestId('update-notice').innerText(), 'the strip reads English').not.toMatch(VIETNAMESE);
});

test('a look that does not work is said in words, keeps the page up, and a feed that changes its mind is believed', async ({ page, app, feed }) => {
  await open(page, app);
  await page.getByTestId('update-no').click();
  await expect(page.getByTestId('update-question')).toHaveCount(0);
  feed.mode('status', { status: 503 });
  const dialog = await openSettings(page, 'Cập nhật');
  const failed = page.waitForResponse(post(CHECK));
  await dialog.getByTestId('updates-check').click();
  expect((await failed).status(), 'a failed look is still a 200 with the state: the error is data, not a failed request').toBe(200);
  await expect(dialog.getByTestId('updates-error')).toHaveText('Lần thử gần nhất không thành công: GitHub trả về lỗi (HTTP 503).');
  await expect(dialog.getByTestId('updates-status')).toHaveText('Chưa biết bản mới nhất.');
  await expect(dialog.getByTestId('updates-latest')).toHaveText('–');
  expect((await app.hub.state()).update.error).toMatchObject({ code: 'update_http', status: 503 });
  await closeSettings(page);
  await expect(page.getByTestId('update-notice')).toHaveCount(0);
  feed.mode('chain');
  feed.publish(feedManifest({ version: '3.10.2' }));
  expect((await fetch(`${app.hub.origin}/api/health`)).ok, 'the Hub is up').toBe(true);
});

test('Settings → Updates: a look the page hears of late does not leave "Check now" waiting', async ({ page, app }) => {
  // The page asks the Hub for its state every 3 s, and a window that was minimised stops asking: it can hear of a look when the minute that look asks for is long over. It must then count
  // from the time it is, not from the time it last painted (it used to keep that time and show a frozen "1 s" with the button disabled until Settings was opened again).
  await open(page, app);
  await page.getByTestId('update-no').click();
  await expect(page.getByTestId('update-question')).toHaveCount(0);
  const dialog = await openSettings(page, 'Cập nhật');
  await expect(dialog.getByTestId('updates-check')).toBeEnabled();
  const opened = await page.evaluate(() => Date.now());
  await page.route(/\/api\/state(\?|$)/, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await new Promise((resolve) => setTimeout(resolve, 400)); // the page hears of it a little after it opened: by then the minute (it ends 200 ms after `opened`) is over
    body.update = {
      ...body.update, latest: '3.10.9', available: true, notesUrl: 'https://github.com/pddczpl/ChatMCP/releases/tag/v3.10.9',
      checkedAt: new Date(opened - 59_800).toISOString(), lastAttemptAt: new Date(opened - 59_800).toISOString(), manualCheckAfter: new Date(opened + 200).toISOString(),
    };
    await route.fulfill({ response, json: body });
  });
  await expect(dialog.getByTestId('updates-latest'), 'the page took in the state it was given').toHaveText('v3.10.9', { timeout: 10_000 });
  await expect(dialog.getByTestId('updates-check'), 'and the minute of that look is over: Check now is not held back').toBeEnabled();
  await expect(dialog.getByTestId('updates-wait')).toHaveCount(0);
});

// ---- the download, with a release the owner signed -------------------------------------------------------------------------------------------------

const MiB = 1024 * 1024;
const signedTest = base.extend({
  owner: async ({}, use) => { await use(throwawayKey()); }, // eslint-disable-line no-empty-pattern
  installer: async ({}, use) => { // eslint-disable-line no-empty-pattern
    const bytes = Buffer.alloc(6 * MiB);
    for (let index = 0; index < bytes.length; index += 4) bytes.writeUInt32LE((Math.imul(index + 1, 2654435761) ^ (index >>> 3)) >>> 0, index);
    await use({ bytes, sha256: createHash('sha256').update(bytes).digest('hex') });
  },
  feed: async ({ owner, installer }, use) => {
    const feed = await startUpdateFeed({ key: owner, manifest: feedManifest({ assets: [{ name: 'DatGoldSetup.exe', sha256: installer.sha256, bytes: installer.bytes.length }] }) });
    feed.installer.set({ name: 'DatGoldSetup.exe', bytes: installer.bytes });
    try { await use(feed); } finally { await feed.close(); }
  },
  // the Hub reads the stand-in, trusts the owner's key of this run (a hook that counts only beside a loopback feed) and believes it runs on Windows (the same)
  hubEnv: async ({ feed, owner }, use) => {
    await use({ CHATMCP_UPDATE_FEED_URL: feed.url, CHATMCP_UPDATE_FIRST_CHECK_MS: '300', CHATMCP_UPDATE_TEST_KEY: owner.spkiBase64, CHATMCP_UPDATE_TEST_PLATFORM: 'win32' });
  },
});
const DOWNLOAD = '/api/update/download';
const CANCEL = '/api/update/download-cancel';

signedTest('a signed release is downloaded on a click: the bar moves, Cancel stops it, the installer arrives whole, and nothing offers to install it', async ({ page, app, feed, installer, browserErrors }, testInfo) => {
  await open(page, app);
  await page.getByTestId('update-yes').click();
  const notice = page.getByTestId('update-notice');
  await expect(notice).toBeVisible();
  const button = page.getByTestId('update-download');
  await expect(button, 'a release whose signature checked can be downloaded').toHaveText('Tải về (6,0 MB)');
  await expect(page.getByTestId('update-signature-note')).toHaveCount(0);
  expect((await app.hub.state()).update).toMatchObject({ latest: '3.10.3', signature: 'valid', installerBytes: 6 * MiB, download: { state: 'idle' } });
  await page.waitForTimeout(1500);
  expect(feed.installer.hits(), 'ZERO requests for the installer before the click, although the first automatic look found a signed release').toBe(0);
  const updates = path.join(app.hub.stateDir, 'updates');

  // ---- the click: the stand-in holds the stream at a third, and the page shows it ----------------------------------------------------------------
  feed.installer.mode('chain', { pauseAfter: 2 * MiB });
  const clicked = page.waitForResponse(post(DOWNLOAD));
  await button.click();
  const started = await clicked;
  expect(started.request().postDataJSON(), 'the click carries the version the page showed and nothing else').toEqual({ version: '3.10.3' });
  expect(started.status()).toBe(200);
  expect((await started.json()).started).toBe(true);
  const bar = page.getByTestId('update-download-progress');
  await expect(bar).toBeVisible();
  await expect(bar).toHaveAttribute('aria-valuenow', '33');
  await expect(page.getByTestId('update-download-progress-text')).toHaveText('Đang tải… 33% (2,0 MB / 6,0 MB)');
  await expect(page.getByTestId('update-download'), 'while it runs there is no second button').toHaveCount(0);
  const unreadable = [];
  for (const theme of ['light', 'dark']) {
    await setTheme(page, theme);
    await page.waitForTimeout(400);
    for (const id of ['update-download-progress-text', 'update-cancel']) {
      const ratio = await contrast(page.getByTestId(id));
      if (ratio < 4.5) unreadable.push(`${id} in the ${theme} theme: ${ratio.toFixed(2)}`);
    }
    await page.screenshot({ path: testInfo.outputPath(`downloading-${theme}.png`), animations: 'disabled' });
  }
  expect(unreadable, 'the progress reads at 4.5:1 or better in both themes').toEqual([]);
  await page.setViewportSize({ width: 640, height: 900 });
  expect(await noSideways(page), 'the progress does not scroll the page sideways').toBe(true);
  await page.setViewportSize({ width: 1600, height: 1000 });
  // Settings shows the same
  const dialog = await openSettings(page, 'Cập nhật');
  await expect(dialog.getByTestId('updates-signature')).toHaveText(/^Hợp lệ \(khóa [0-9a-f]{8}\)$/);
  await expect(dialog.getByTestId('updates-size')).toHaveText('6,0 MB');
  await expect(dialog.getByTestId('updates-download-progress')).toHaveAttribute('aria-valuenow', '33');
  await closeSettings(page);

  // ---- cancel: the connection is closed, the file and its folder are gone, and the button is back ------------------------------------------------
  const cancelled = page.waitForResponse(post(CANCEL));
  await page.getByTestId('update-cancel').click();
  expect((await (await cancelled).json()).cancelled).toBe(true);
  await expect(button).toBeVisible();
  await expect(bar).toHaveCount(0);
  expect((await app.hub.state()).update.download, 'a cancel is not a failure').toEqual({ state: 'idle' });
  feed.installer.resume();
  await expect.poll(() => feed.installer.openCount(), { message: 'the Hub closed the connection' }).toBe(0);
  expect(feed.installer.sent(), 'the rest of the installer was never sent').toBe(2 * MiB);
  await expect.poll(async () => fs.readdir(updates).catch(() => []), { message: 'the .part file and its folder are gone' }).toEqual([]);

  // ---- a whole download -------------------------------------------------------------------------------------------------------------------------------
  feed.installer.mode('chain');
  await button.click();
  const ready = page.getByTestId('update-download-ready');
  await expect(ready).toHaveText('Đã tải xong và đã kiểm tra.', { timeout: 30_000 });
  await expect(page.getByTestId('update-download-ready-note')).toContainText('Cài đặt từ trong ứng dụng chưa có ở phiên bản này');
  expect(await fs.readFile(path.join(updates, '3.10.3', 'DatGoldSetup.exe')), 'the installer on disk is the bytes the stand-in served').toEqual(installer.bytes);
  expect(await fs.readdir(path.join(updates, '3.10.3'))).toEqual(expect.arrayContaining(['DatGoldSetup.exe', 'RELEASE-MANIFEST.json', 'RELEASE-MANIFEST.json.sig', 'state.json']));
  await expect(page.locator('[data-testid*="install"], [data-testid*="apply"], [data-testid*="restart"]'), 'no way to install it, not even a hidden one').toHaveCount(0);
  expect(await notice.innerText(), 'and no word that offers it').not.toMatch(/\b(?:Cài đặt ngay|Cập nhật ngay|Install|Restart|Relaunch)\b/i);
  for (const theme of ['light', 'dark']) {
    await setTheme(page, theme);
    await page.waitForTimeout(400);
    for (const id of ['update-download-ready', 'update-download-ready-note']) {
      const ratio = await contrast(page.getByTestId(id));
      if (ratio < 4.5) unreadable.push(`${id} in the ${theme} theme: ${ratio.toFixed(2)}`);
    }
    await page.screenshot({ path: testInfo.outputPath(`ready-${theme}.png`), animations: 'disabled' });
  }
  expect(unreadable, 'the ready state reads at 4.5:1 or better in both themes').toEqual([]);
  const before = feed.installer.hits();
  await page.reload();
  await expect(page.getByTestId('update-download-ready'), 'a reloaded page finds it ready: it is the Hub\'s').toBeVisible();

  // ---- a Hub restart: ready from the folder alone, with no request ---------------------------------------------------------------------------------------
  await browserErrors.closePage(page);
  await app.restart();
  const next = await page.context().newPage();
  await open(next, app);
  await expect(next.getByTestId('update-download-ready')).toBeVisible();
  expect(feed.installer.hits(), 'nothing was fetched again').toBe(before);
  expect((await app.hub.state()).update).toMatchObject({ signature: null, download: { state: 'ready', version: '3.10.3', bytes: 6 * MiB } });

  // ---- the same words in English, from the real language switch -----------------------------------------------------------------------------------------
  const vietnamese = await openSettings(next, 'Giao diện & ngôn ngữ');
  await vietnamese.getByRole('button', { name: 'English', exact: true }).click();
  const english = next.getByRole('dialog', { name: 'Settings', exact: true });
  await english.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Updates', exact: true }).click();
  await expect(english.getByTestId('updates-download-ready')).toHaveText('Downloaded and checked.');
  await expect(english.getByTestId('updates-signature'), 'after a restart the signature has not been looked at yet in this session').toHaveText('Not looked at in this session');
  expect(await english.innerText(), 'Settings → Updates reads English').not.toMatch(VIETNAMESE);
  await next.keyboard.press('Escape');
  await expect(english).toHaveCount(0);
  await expect(next.getByTestId('update-download-ready')).toHaveText('Downloaded and checked.');
  expect(await next.getByTestId('update-notice').innerText(), 'the strip reads English').not.toMatch(VIETNAMESE);
});

signedTest('a download that fails says why in words and can be tried again; an unsigned release is not offered; neither installs anything', async ({ page, app, feed, installer }) => {
  await open(page, app);
  await page.getByTestId('update-yes').click();
  const button = page.getByTestId('update-download');
  await expect(button).toBeVisible();
  feed.installer.set({ name: 'DatGoldSetup.exe', bytes: Buffer.concat([installer.bytes.subarray(0, installer.bytes.length - 1), Buffer.from([installer.bytes[installer.bytes.length - 1] ^ 1])]) });
  await button.click();
  await expect(page.getByTestId('update-download-error')).toContainText('Tải về không thành công: Tệp tải về không phải tệp mà danh sách đã ký mô tả', { timeout: 30_000 });
  expect((await app.hub.state()).update.download).toEqual({ state: 'failed', version: '3.10.3', code: 'update_download_hash' });
  await expect.poll(async () => fs.readdir(path.join(app.hub.stateDir, 'updates')).catch(() => []), { message: 'nothing is left of the file that did not match' }).toEqual([]);
  // tried again with the right bytes
  feed.installer.set({ name: 'DatGoldSetup.exe', bytes: installer.bytes });
  await expect(button, 'a failure can be tried again').toBeVisible();
  await button.click();
  await expect(page.getByTestId('update-download-ready')).toBeVisible({ timeout: 30_000 });
  await page.reload();
  await expect(page.getByTestId('update-download-ready')).toBeVisible();
});

signedTest('a release that is not signed, or whose signature does not check, is announced with the reason and without a download button', async ({ page, app, feed }) => {
  feed.signature.mode('missing');
  await open(page, app);
  await page.getByTestId('update-yes').click();
  await expect(page.getByTestId('update-notice')).toBeVisible();
  await expect(page.getByTestId('update-signature-note')).toContainText('Bản này chưa được ký nên DatGold sẽ không tải');
  await expect(page.getByTestId('update-download')).toHaveCount(0);
  await expect(page.getByTestId('update-notes'), 'the notes and the copy button stay: the owner can still go and get it himself').toBeVisible();
  const dialog = await openSettings(page, 'Cập nhật');
  await expect(dialog.getByTestId('updates-signature')).toHaveText('Chưa được ký');
  await expect(dialog.getByTestId('updates-download')).toHaveCount(0);
  await closeSettings(page);
});
