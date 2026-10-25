import { test as base, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { startHub, cleanEnvironment, waitFor } from '../../tests/e2e/hub-process.mjs';
import { startMockModel } from '../../tests/e2e/mock-model-server.mjs';
import { makeCalcProject, gitInit, WRONG_EXPECTATION_TEST } from '../../tests/e2e/fixtures.mjs';

export const test = base.extend({
  failingProject: [false, { option: true }],
  // Extra environment for the Hub process. The shared harness sets CHATMCP_TOOL_SELECTION=full (tests/e2e/hub-process.mjs) because scripted
  // models call tools by name; a test of the Hub's own choice sets it to '' so that the context window decides.
  hubEnv: [{}, { option: true }],
  app: async ({ failingProject, hubEnv, context, browserErrors }, use, testInfo) => {
    // Windows TEMP may use an 8.3 alias; compare the canonical path the Hub returns.
    const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-react-e2e-')));
    const project = path.join(scratch, 'workspace');
    let mock;
    let hub;
    const app = {
      scratch, project,
      get mock() { return mock; },
      get hub() { return hub; },
      /**
       * The address a person (or the desktop shell) opens: the dashboard plus a one-time ticket in the fragment, which the page
       * trades for the Hub's per-launch secret. A Hub restart makes a new secret, so open a page again afterwards.
       */
      async signInUrl() {
        const { ticket } = await hub.post('/api/session/ticket', {});
        return `${hub.origin}/#chatmcp-boot=${ticket}`;
      },
      async restart() {
        const port = hub.port;
        await hub.stop();
        hub = await startHub({ scratch, port, logName: 'hub-restart.log' });
      },
      runProjectTest() {
        return spawnSync(process.execPath, ['test.js'], { cwd: project, env: cleanEnvironment(scratch), encoding: 'utf8', windowsHide: true });
      },
    };
    try {
      makeCalcProject(project, failingProject ? { test: WRONG_EXPECTATION_TEST } : {});
      gitInit(project, scratch);
      mock = await startMockModel();
      // The same real production React build the desktop serves; no API/page routes are stubbed.
      hub = await startHub({ scratch, env: hubEnv });
      const html = await (await fetch(hub.origin)).text();
      expect(html).toContain('id="root"');
      expect(html).toMatch(/assets\/index-[^" ]+\.js/);
      await use(app);
    } finally {
      await Promise.all(context.pages().map((page) => browserErrors.closePage(page)));
      await hub?.stop();
      await mock?.close();
      for (const name of ['hub.log', 'hub-restart.log']) {
        const file = path.join(scratch, name);
        if (await fs.stat(file).catch(() => null)) await testInfo.attach(name, { path: file, contentType: 'text/plain' });
      }
      // Only this fixture's random temporary directory is eligible for cleanup.
      const resolved = await fs.realpath(scratch);
      const temp = await fs.realpath(os.tmpdir());
      if (path.dirname(resolved) !== temp || !path.basename(resolved).startsWith('chatmcp-react-e2e-')) throw new Error('Unsafe E2E cleanup path');
      await fs.rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    }
  },
  browserErrors: [async ({ context }, use, testInfo) => {
    const errors = [];
    const warnings = [];
    const requests = new Set();
    const checks = [];
    const observedPages = new Map();
    const inspectPage = (page) => {
      const pageChecks = [];
      let navigationVersion = 0;
      const onNavigation = frame => { if (frame === page.mainFrame()) navigationVersion++; };
      page.on('framenavigated', onNavigation);
      page.on('pageerror', (error) => errors.push(`Runtime: ${error.message}`));
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(`Console: ${message.text()}`);
        else if (message.type() === 'warning') warnings.push(message.text());
      });
      page.on('requestfailed', (request) => {
        const reason = request.failure()?.errorText ?? 'unknown network failure';
        // Navigation/closing a page cancels its live SSE request intentionally.
        if (!reason.includes('ERR_ABORTED')) errors.push(`Network: ${request.url()}: ${reason}`);
      });
      const onResponse = (response) => {
        const responseNavigation = navigationVersion;
        const route = new URL(response.url()).pathname;
        if (!route.startsWith('/api/')) return;
        requests.add(route);
        const check = (async () => {
          if (!response.ok()) errors.push(`HTTP ${response.status()}: ${response.url()}`);
          const mediaType = (response.headers()['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
          const taskStream = route === '/api/tasks/events' || /^\/api\/tasks\/[0-9a-f-]{36}\/stream$/.test(route);
          // These are the Hub's explicit non-JSON API contracts. An HTML fallback
          // or an unexpected event stream on another API route is still a failure.
          if (taskStream && mediaType === 'text/event-stream') return;
          if (/^\/api\/tasks\/[0-9a-f-]{36}\/report$/.test(route) && mediaType === 'text/plain') return;
          if (mediaType !== 'application/json') {
            errors.push(`Unexpected API content type: ${response.url()}: ${mediaType || '(missing)'}`);
            return;
          }
          let value;
          try { value = await response.json(); }
          catch (error) {
            const message = String(error?.message || error);
            // During deliberate page.reload/close on Windows Chromium the CDP
            // response-body handle can disappear AFTER status and MIME were read.
            // Do not misreport that navigation race as malformed JSON. Genuine
            // malformed JSON on a stable page remains a hard E2E failure.
            const disposedByNavigation = (page.isClosed() || navigationVersion !== responseNavigation)
              && /Network\.getResponseBody|response body is not available|Target page.*closed/i.test(message);
            if (!disposedByNavigation) errors.push(`Invalid API JSON: ${response.url()}: ${message}`);
            return;
          }
          // A task's persisted cancellation/failure is domain data, not an API failure envelope.
          if (value?.ok === false || (value?.error && !value?.id)) errors.push(`API error: ${response.url()}: ${JSON.stringify(value)}`);
        })();
        checks.push(check);
        pageChecks.push(check);
      };
      observedPages.set(page, { onResponse, onNavigation, checks: pageChecks });
      page.on('response', onResponse);
    };
    const closePage = async (page) => {
      const observed = observedPages.get(page);
      if (observed) {
        // Seal capture at the deliberate close boundary, then finish reading
        // every response already observed before destroying its browser page.
        page.off('response', observed.onResponse);
        page.off('framenavigated', observed.onNavigation);
        await Promise.all(observed.checks);
      }
      await page.close();
    };
    // Drain API response bodies before deliberate navigation. Chromium may discard
    // Network.getResponseBody after page.reload(), even for successful JSON.
    // Keep all HTTP/status/content-type/API error assertions intact.
    const flush = async (page) => {
      const observed = observedPages.get(page);
      if (observed) await Promise.all([...observed.checks]);
    };
    context.on('page', inspectPage);
    context.pages().forEach(inspectPage);
    await use({ errors, requests, closePage, flush });
    await Promise.all(checks);
    await testInfo.attach('browser-errors.json', { body: JSON.stringify(errors, null, 2), contentType: 'application/json' });
    await testInfo.attach('browser-warnings.json', { body: JSON.stringify(warnings, null, 2), contentType: 'application/json' });
    expect(errors, 'React must not hide runtime or API errors').toEqual([]);
  }, { auto: true }],
});

export { expect };

export async function onboard(page, app) {
  await page.goto(await app.signInUrl());
  await expect(page.getByRole('heading', { name: 'Chào mừng đến với DatGold Studio' })).toBeVisible();
  await page.getByLabel('Đường dẫn workspace', { exact: true }).fill(app.project);
  await page.getByRole('button', { name: 'Áp dụng workspace', exact: true }).click();
  await expect.poll(async () => (await app.hub.state()).workspace?.path).toBe(app.project);
  await page.getByRole('button', { name: 'Tiếp tục', exact: true }).click();
  await page.getByRole('button', { name: 'Ollama (Local)', exact: true }).click();
  await page.getByLabel('API base URL', { exact: true }).fill(app.mock.url);
  await page.getByLabel('Model', { exact: true }).fill('mock-coder');
  const checked = page.waitForResponse((response) => response.url().endsWith('/api/ai/test') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Lưu & kiểm tra', exact: true }).click();
  expect((await checked).ok()).toBe(true);
  await page.getByRole('button', { name: 'Tiếp tục', exact: true }).click();
  await page.getByRole('button', { name: /Review \(Khuyên dùng\)/ }).click();
  await page.getByRole('button', { name: 'Bắt đầu làm việc ngay', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Chào mừng đến với DatGold Studio' })).toHaveCount(0);
  await waitFor(async () => { const state = await app.hub.state(); return state.catalogReady && !state.busy; });
  const state = await app.hub.state();
  expect(state.ai.model).toBe('mock-coder');
  expect(state.studio.permissions.mode).toBe('review');
  expect(state.agent.tasks).toHaveLength(0);
}

export async function send(page, prompt) {
  await page.locator('textarea').fill(prompt);
  await page.getByRole('button', { name: 'Gửi', exact: true }).click();
}

export async function taskByPrompt(app, prompt) {
  return waitFor(async () => (await app.hub.state()).agent.tasks.find((task) => task.prompt === prompt || task.task === prompt));
}

/** The work panel on the right: choose a tab by its visible name (Tiến độ, Thay đổi, Tệp, Terminal, Hoạt động, Tác nhân). */
export async function openWorkTab(page, name) {
  const tab = page.getByRole('tab', { name, exact: true });
  if (!(await tab.count())) {
    // Preview lives under "Thêm" until it is chosen.
    await page.getByRole('button', { name: 'Thêm', exact: true }).click();
    await page.getByRole('menuitem', { name, exact: true }).click();
    return;
  }
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
}

/**
 * The page hears of a new window width `ms` late, as it does on a slow machine. The browser reports a change of width to the page at its next frame
 * and not when `setViewportSize` returns, and a loaded runner can take a long while to get to that frame. Install it before the page is opened.
 */
export async function delayLayoutChanges(page, ms) {
  if (!ms) return;
  await page.addInitScript((delay) => {
    const add = MediaQueryList.prototype.addEventListener;
    const remove = MediaQueryList.prototype.removeEventListener;
    const late = new WeakMap();
    MediaQueryList.prototype.addEventListener = function (type, listener, options) {
      if (type !== 'change' || typeof listener !== 'function') return add.call(this, type, listener, options);
      if (!late.has(listener)) late.set(listener, function (event) { setTimeout(() => listener.call(this, event), delay); });
      return add.call(this, type, late.get(listener), options);
    };
    MediaQueryList.prototype.removeEventListener = function (type, listener, options) {
      return remove.call(this, type, late.get(listener) ?? listener, options);
    };
  }, ms);
}

/** Settings is a full-page dialog. `section` is the visible name of an entry in its left menu (Mô hình AI, Kỹ năng, ...). */
export async function openSettings(page, section) {
  const dialog = page.getByRole('dialog', { name: 'Cài đặt' });
  if (!(await dialog.isVisible().catch(() => false))) await page.getByRole('button', { name: 'Cài đặt', exact: true }).click();
  await expect(dialog).toBeVisible();
  if (section) await dialog.getByRole('navigation', { name: 'Các mục cài đặt' }).getByRole('button', { name: section, exact: true }).click();
  return dialog;
}

export async function closeSettings(page) {
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Cài đặt' })).toHaveCount(0);
}

/** Light or dark, from wherever the person is: the header toggle, or the Appearance section when Settings covers the page. */
export async function setTheme(page, theme) {
  if (await page.locator('html').getAttribute('data-theme') === theme) return;
  const dialog = page.getByRole('dialog', { name: 'Cài đặt' });
  if (await dialog.isVisible().catch(() => false)) {
    const menu = dialog.getByRole('navigation', { name: 'Các mục cài đặt' });
    const current = (await menu.locator('[aria-current="page"]').innerText()).trim();
    await menu.getByRole('button', { name: 'Giao diện & ngôn ngữ', exact: true }).click();
    await dialog.getByRole('button', { name: theme === 'light' ? 'Sáng' : 'Tối', exact: true }).click();
    await menu.getByRole('button', { name: current, exact: true }).click();
  } else {
    await page.getByTitle('Chuyển theme sáng / tối').click();
  }
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}

/** The tokens of src/index.css as computed colours, so a test does not repeat hex values. */
export const SURFACE = { light: 'rgb(246, 248, 251)', dark: 'rgb(23, 28, 36)' };

