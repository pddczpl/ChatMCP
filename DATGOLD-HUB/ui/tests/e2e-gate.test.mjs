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
    // A reload cuts a response off between its headers and the end of its body. Chromium then neither delivers the body nor fails the read, and
    // Playwright raises no event: response.json() stays pending until the browser closes. The gate used to wait for it for good, so the
    // teardown of a test that reloaded the page ran into the test timeout (twice on windows-latest, with the Hub idle and healthy).
    // `within` is how long the case may take, teardown included: a second to let go of the response, not the 10 s a body is waited for on a page that stays, and not the 15 s of the test timeout.
    { title: 'JSON body cut off by a reload', route: '/api/state', contentType: 'application/json', body: '{"half":', hold: true, reload: true, warning: 'API response dropped by a navigation: GET ', within: 8000 },
    // Without a navigation nothing explains a body that does not come: that is a real hang of the response, and it fails the test at once (after the 1,500 ms the test asks for).
    { title: 'JSON body that never arrives on a page that stays', route: '/api/state', contentType: 'application/json', body: '{"half":', hold: true, error: 'API response body did not arrive in 1500 ms: GET ', within: 8000 },
  ];
  try {
    const config = path.join(temp, 'playwright.config.mjs');
    const report = path.join(temp, 'report.json');
    await fs.writeFile(config, `export default ${JSON.stringify({ testDir: temp, workers: 1, retries: 0, timeout: 15_000, reporter: [[reporter], ['json', { outputFile: report }]], outputDir: path.join(temp, 'results'), use: { headless: true } })};\n`);
    await fs.writeFile(path.join(temp, 'api-gate.spec.mjs'), `
      import http from 'node:http';
      import { test, expect } from ${JSON.stringify(fixtures)};
      // The gate waits this long for a body that the page keeps on screen; the default is longer than a test of the gate should take.
      test.use({ bodyLimitMs: 1500 });
      for (const entry of ${JSON.stringify(cases)}) {
        test(entry.title, async ({ page, browserErrors }) => {
          const server = http.createServer((request, response) => {
            if (request.url === entry.route) {
              response.writeHead(200, { 'content-type': entry.contentType });
              if (entry.closeAfterHeaders) {
                response.flushHeaders();
                setTimeout(() => response.end(entry.body), 250);
              } else if (entry.hold) {
                // The headers and the first bytes, and then nothing: the response is never ended (the browser hangs up when it cancels the request).
                response.write(entry.body);
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
                if (!entry.closeAfterHeaders && !entry.hold) await response.json();
              } catch { /* handled by the consumer */ }
            }, entry);
            await expect.poll(() => browserErrors.requests.has(entry.route)).toBe(true);
            if (entry.reload) await page.reload();
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
    // The nested run has eleven cases of up to 15 s each: it takes 9-15 s on a healthy runner, but a Windows runner once needed more than 60 s and the old limit of 60 s killed it, which ended the test with a
    // status of null and told nobody which case it was in. The limit is now the worst case of the cases (their own timeouts), and an end without a status says so.
    const result = spawnSync(process.execPath, [path.join(ui, 'node_modules/@playwright/test/cli.js'), 'test', '--config', config], { cwd: ui, env, encoding: 'utf8', windowsHide: true, timeout: cases.length * 15_000 + 30_000 });
    assert.equal(result.status, 1, `the nested run ended with status ${result.status}, signal ${result.signal}, ${result.error?.message ?? 'no error'} (null is a run that was killed at the limit)\n${result.stdout}${result.stderr}`);
    const value = JSON.parse(await fs.readFile(report, 'utf8'));
    const specs = (suites) => suites.flatMap(suite => [...suite.specs, ...specs(suite.suites ?? [])]);
    const recorded = specs(value.suites);
    assert.equal(recorded.length, cases.length);
    for (const entry of cases) {
      const outcome = recorded.find(spec => spec.title === entry.title)?.tests[0]?.results[0];
      assert.equal(outcome?.status, entry.error ? 'failed' : 'passed', `${entry.title}: ${JSON.stringify(outcome)}`);
      if (entry.error) assert.ok(outcome.errors.some(error => error.message.includes(entry.error)), `${entry.title}: ${JSON.stringify(outcome.errors)}`);
      if (entry.within) assert.ok(outcome.duration <= entry.within, `${entry.title}: took ${outcome.duration} ms, more than ${entry.within} ms`);
      // What the gate let go of is not an error, but it is written down where a person reading the result finds it.
      if (entry.warning) {
        const warnings = outcome.attachments.find(attachment => attachment.name === 'browser-warnings.json');
        assert.ok(warnings && Buffer.from(warnings.body, 'base64').toString('utf8').includes(entry.warning), `${entry.title}: ${JSON.stringify(outcome.attachments)}`);
      }
    }
    assert.equal(value.stats.skipped, 0);
  } finally {
    const resolved = await fs.realpath(temp);
    if (path.dirname(resolved) !== await fs.realpath(os.tmpdir()) || !path.basename(resolved).startsWith('chatmcp-api-gate-')) throw new Error('Unsafe API gate cleanup path');
    await fs.rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
