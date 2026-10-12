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
  app: async ({ failingProject, context }, use, testInfo) => {
    // Windows TEMP may use an 8.3 alias; compare the canonical path the Hub returns.
    const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-react-e2e-')));
    const project = path.join(scratch, 'workspace');
    let mock;
    let hub;
    const app = {
      scratch, project,
      get mock() { return mock; },
      get hub() { return hub; },
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
      hub = await startHub({ scratch });
      const html = await (await fetch(hub.origin)).text();
      expect(html).toContain('id="root"');
      expect(html).toMatch(/assets\/index-[^" ]+\.js/);
      await use(app);
    } finally {
      await Promise.all(context.pages().map((page) => page.close()));
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
    const inspectPage = (page) => {
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
      page.on('response', (response) => {
        if (!new URL(response.url()).pathname.startsWith('/api/')) return;
        requests.add(new URL(response.url()).pathname);
        checks.push((async () => {
          if (!response.ok()) errors.push(`HTTP ${response.status()}: ${response.url()}`);
          if (response.headers()['content-type']?.includes('application/json')) {
            const value = await response.json().catch(() => null);
            // A task's persisted cancellation/failure is domain data, not an API failure envelope.
            if (value?.ok === false || (value?.error && !value?.id)) errors.push(`API error: ${response.url()}: ${JSON.stringify(value)}`);
          }
        })());
      });
    };
    context.on('page', inspectPage);
    context.pages().forEach(inspectPage);
    await use({ errors, requests });
    await Promise.all(checks);
    await testInfo.attach('browser-errors.json', { body: JSON.stringify(errors, null, 2), contentType: 'application/json' });
    await testInfo.attach('browser-warnings.json', { body: JSON.stringify(warnings, null, 2), contentType: 'application/json' });
    expect(errors, 'React must not hide runtime or API errors').toEqual([]);
  }, { auto: true }],
});

export { expect };

export async function onboard(page, app) {
  await page.goto(app.hub.origin);
  await expect(page.getByRole('heading', { name: 'Chào mừng đến với ChatMCP Studio' })).toBeVisible();
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
  await expect(page.getByRole('heading', { name: 'Chào mừng đến với ChatMCP Studio' })).toHaveCount(0);
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
