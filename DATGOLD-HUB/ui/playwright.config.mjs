import { defineConfig, devices } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * On the Windows machine of CI the browser writes a NetLog, one file per worker under test-results/netlog/ (the job uploads the folder with everything else). A
 * `net::ERR_NO_BUFFER_SPACE` has happened there about once in sixty runs and no other record says which socket call the system refused or what the browser's
 * socket pool was doing around it (docs/CI-HEALTH.md). Anywhere else, and for a person running the tests, the browser starts as it always did.
 */
export function netLogArguments({ ci = process.env.CI, platform = process.platform, root = path.dirname(fileURLToPath(import.meta.url)), pid = process.pid } = {}) {
  if (!ci || platform !== 'win32') return [];
  const folder = path.join(root, 'test-results', 'netlog');
  fs.mkdirSync(folder, { recursive: true }); // a worker evaluates this file after Playwright has emptied test-results, so the folder is made again here
  return [`--log-net-log=${path.join(folder, `chromium-${pid}.json`)}`];
}

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [
    ['list'],
    ['json', { outputFile: 'test-results/react-e2e.json' }],
    ['./e2e/required-reporter.mjs'],
  ],
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 1600, height: 1000 },
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: { args: netLogArguments() },
  },
});
