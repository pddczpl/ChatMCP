import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ui = fileURLToPath(new URL('..', import.meta.url));
const api = new URL('../node_modules/@playwright/test/index.mjs', import.meta.url).href;
const reporter = fileURLToPath(new URL('../e2e/required-reporter.mjs', import.meta.url));

test('required Playwright gate rejects skipped tests instead of reporting success', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-e2e-gate-'));
  try {
    const config = path.join(temp, 'playwright.config.mjs');
    await fs.writeFile(config, `export default ${JSON.stringify({ testDir: temp, workers: 1, reporter: [[reporter]], outputDir: path.join(temp, 'results') })};\n`);
    const suite = path.join(temp, 'gate.spec.mjs');
    await fs.writeFile(suite, `import { test } from ${JSON.stringify(api)};\ntest.skip('missing prerequisite', () => {});\n`);
    const run = () => spawnSync(process.execPath, [path.join(ui, 'node_modules/@playwright/test/cli.js'), 'test', '--config', config], { cwd: ui, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    const skipped = run();
    assert.equal(skipped.status, 1, skipped.stdout + skipped.stderr);
    assert.match(skipped.stderr, /Required React E2E gate: 1 skipped/);
    await fs.writeFile(suite, `import { test } from ${JSON.stringify(api)};\ntest('prerequisite available', () => {});\n`);
    const passed = run();
    assert.equal(passed.status, 0, passed.stdout + passed.stderr);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('browser error gate rejects malformed API responses and accepts explicit non-JSON contracts', async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-api-gate-')));
  const fixtures = new URL('../e2e/fixtures.mjs', import.meta.url).href;
  const taskId = '00000000-0000-0000-0000-000000000000';
  const cases = [
    { title: 'malformed JSON', route: '/api/plugins/marketplace', contentType: 'application/json', body: '<html>fallback</html>', error: 'Invalid API JSON' },
    { title: 'HTML fallback', route: '/api/plugins/registry', contentType: 'text/html', body: '<html>fallback</html>', error: 'Unexpected API content type' },
    { title: 'SSE on a JSON route', route: '/api/plugins/marketplace', contentType: 'text/event-stream', body: ': connected\n\n', error: 'Unexpected API content type' },
    { title: 'optional JSON null', route: '/api/studio/delegates', contentType: 'application/json; charset=utf-8', body: 'null' },
    { title: 'task event stream', route: '/api/tasks/events', contentType: 'text/event-stream; charset=utf-8', body: ': connected\n\n' },
    { title: 'individual task stream', route: `/api/tasks/${taskId}/stream`, contentType: 'text/event-stream', body: ': connected\n\n' },
    { title: 'task report', route: `/api/tasks/${taskId}/report`, contentType: 'text/plain; charset=utf-8', body: 'Task report' },
    { title: 'valid JSON body pending at close', route: '/api/state', contentType: 'application/json', body: '{}', closeAfterHeaders: true },
    { title: 'malformed JSON body pending at close', route: '/api/state', contentType: 'application/json', body: '<html>late fallback</html>', closeAfterHeaders: true, error: 'Invalid API JSON' },
  ];
  try {
    const config = path.join(temp, 'playwright.config.mjs');
    const report = path.join(temp, 'report.json');
    await fs.writeFile(config, `export default ${JSON.stringify({ testDir: temp, workers: 1, retries: 0, timeout: 15_000, reporter: [[reporter], ['json', { outputFile: report }]], outputDir: path.join(temp, 'results'), use: { headless: true } })};\n`);
    await fs.writeFile(path.join(temp, 'api-gate.spec.mjs'), `
      import http from 'node:http';
      import { test, expect } from ${JSON.stringify(fixtures)};
      for (const entry of ${JSON.stringify(cases)}) {
        test(entry.title, async ({ page, browserErrors }) => {
          const server = http.createServer((request, response) => {
            if (request.url === entry.route) {
              response.writeHead(200, { 'content-type': entry.contentType });
              if (entry.closeAfterHeaders) {
                response.flushHeaders();
                setTimeout(() => response.end(entry.body), 250);
              } else response.end(entry.body);
            } else {
              response.writeHead(200, { 'content-type': 'text/html' });
              response.end('<html><body>API gate fixture</body></html>');
            }
          });
          await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
          try {
            await page.goto('http://127.0.0.1:' + server.address().port);
            // A consumer such as React Query can handle its rejected JSON parse
            // without a console error. The automatic fixture must still fail.
            await page.evaluate(async entry => {
              try {
                const response = await fetch(entry.route);
                if (!entry.closeAfterHeaders) await response.json();
              } catch { /* handled by the consumer */ }
            }, entry);
            await expect.poll(() => browserErrors.requests.has(entry.route)).toBe(true);
          } finally {
            await browserErrors.closePage(page);
            // Manual closure followed by fixture cleanup is safe to repeat.
            await browserErrors.closePage(page);
            server.closeAllConnections?.();
            await new Promise(resolve => server.close(resolve));
          }
        });
      }
    `);
    // Parent Playwright report overrides must not redirect this nested run into
    // the main E2E report or another concurrently running test's output.
    const env = { ...process.env };
    for (const name of Object.keys(env)) if (name.startsWith('PLAYWRIGHT_JSON_')) delete env[name];
    const result = spawnSync(process.execPath, [path.join(ui, 'node_modules/@playwright/test/cli.js'), 'test', '--config', config], { cwd: ui, env, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const value = JSON.parse(await fs.readFile(report, 'utf8'));
    const specs = (suites) => suites.flatMap(suite => [...suite.specs, ...specs(suite.suites ?? [])]);
    const recorded = specs(value.suites);
    assert.equal(recorded.length, cases.length);
    for (const entry of cases) {
      const outcome = recorded.find(spec => spec.title === entry.title)?.tests[0]?.results[0];
      assert.equal(outcome?.status, entry.error ? 'failed' : 'passed', `${entry.title}: ${JSON.stringify(outcome)}`);
      if (entry.error) assert.ok(outcome.errors.some(error => error.message.includes(entry.error)), `${entry.title}: ${JSON.stringify(outcome.errors)}`);
    }
    assert.equal(value.stats.skipped, 0);
  } finally {
    const resolved = await fs.realpath(temp);
    if (path.dirname(resolved) !== await fs.realpath(os.tmpdir()) || !path.basename(resolved).startsWith('chatmcp-api-gate-')) throw new Error('Unsafe API gate cleanup path');
    await fs.rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
