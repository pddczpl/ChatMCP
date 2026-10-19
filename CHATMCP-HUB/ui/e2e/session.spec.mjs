// The dashboard's sign-in with the Hub's per-launch secret, against the real Hub and the production build.
import { test, expect } from './fixtures.mjs';

const STORAGE_KEY = 'chatmcp.hub-session';
const welcome = (page) => page.getByRole('heading', { name: 'Chào mừng đến với ChatMCP Studio' });
const reopenScreen = (page) => page.getByRole('alert').filter({ hasText: 'Session required' });

test('a one-time ticket signs the tab in, leaves no trace in the address, and the task stream carries the bearer', async ({ page, app }) => {
  const streamRequest = page.waitForRequest((request) => new URL(request.url()).pathname === '/api/tasks/events');
  await page.goto(await app.signInUrl());
  await expect(welcome(page)).toBeVisible();
  expect(page.url(), 'the ticket is removed from the address bar').toBe(`${app.hub.origin}/`);
  expect(await page.evaluate(() => location.hash)).toBe('');
  expect(await page.evaluate(() => history.length), 'and the page did not push a history entry').toBeLessThanOrEqual(2);

  const request = await streamRequest;
  expect(request.headers().authorization, 'EventSource cannot send this header; the stream is a fetch').toBe(`Bearer ${app.hub.secret}`);
  const response = await request.response();
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('text/event-stream');

  const stored = await page.evaluate((key) => ({ session: sessionStorage.getItem(key), local: JSON.stringify({ ...localStorage }) }), STORAGE_KEY);
  expect(stored.session, 'kept for this tab only').toBe(app.hub.secret);
  expect(stored.local, 'never in localStorage').not.toContain(app.hub.secret);
});

test('a tab opened without ChatMCP asks to reopen it and calls no API', async ({ page, app, browserErrors }) => {
  await page.goto(app.hub.origin);
  await expect(reopenScreen(page)).toBeVisible();
  expect([...browserErrors.requests], 'no API route was called').toEqual([]);
  // The same refusal for any local program that did not read the session file.
  expect((await fetch(`${app.hub.origin}/api/state`)).status).toBe(401);
});

test('a sign-in ticket works once', async ({ page, context, app, browserErrors }) => {
  const url = await app.signInUrl();
  await page.goto(url);
  await expect(welcome(page)).toBeVisible();
  const replay = await context.newPage();
  await replay.goto(url);
  await expect(reopenScreen(replay)).toBeVisible();
  const refused = browserErrors.errors.splice(0);
  expect(refused.length, 'the refused redemption is the only error').toBeGreaterThan(0);
  expect(refused.every((message) => /401|session\/redeem/.test(message)), refused.join(' | ')).toBe(true);
});

test('after a Hub restart a tab with the old secret asks to reopen, and a new sign-in works', async ({ page, context, app, browserErrors }) => {
  await page.goto(await app.signInUrl());
  await expect(welcome(page)).toBeVisible();
  const oldSecret = await page.evaluate((key) => sessionStorage.getItem(key), STORAGE_KEY);
  expect(oldSecret).toBe(app.hub.secret);
  // Planned downtime is not an application error: disconnect first, as the restart scenario in studio.spec does.
  await browserErrors.closePage(page);
  await app.restart();
  expect(app.hub.secret).not.toBe(oldSecret);

  const stale = await context.newPage();
  await stale.addInitScript(([key, value]) => sessionStorage.setItem(key, value), [STORAGE_KEY, oldSecret]);
  await stale.goto(app.hub.origin);
  await expect(reopenScreen(stale)).toBeVisible();
  expect(await stale.evaluate((key) => sessionStorage.getItem(key), STORAGE_KEY), 'the refused secret is forgotten').toBeNull();
  const refused = browserErrors.errors.splice(0);
  expect(refused.length).toBeGreaterThan(0);
  expect(refused.every((message) => /401|hub_auth_required/.test(message)), refused.join(' | ')).toBe(true);

  const fresh = await context.newPage();
  await fresh.goto(await app.signInUrl());
  await expect(welcome(fresh)).toBeVisible();
});
