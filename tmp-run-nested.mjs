// THROWAWAY (proof branch only). Runs ONE nested gate case, the same spec text as CHATMCP-HUB/ui/tests/e2e-gate.test.mjs, and prints the timeline and the
// Playwright output: how long closePage() takes after a reload cut a response off, and what Playwright says when it does not return.
// Usage (from CHATMCP-HUB/ui): node ../../tmp-run-nested.mjs "<case title substring>"
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const ui = path.resolve('.');
const fixtures = pathToFileURL(path.join(ui, 'e2e', 'fixtures.mjs')).href;
const wanted = process.argv[2] ?? 'cut off by a reload';
const cases = [
  { title: 'JSON body cut off by a reload', route: '/api/state', contentType: 'application/json', body: '{"half":', hold: true, reload: true },
  { title: 'JSON body that never arrives on a page that stays', route: '/api/state', contentType: 'application/json', body: '{"half":', hold: true },
].filter((entry) => entry.title.includes(wanted));
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-api-gate-scratch-')));
try {
  const config = path.join(temp, 'playwright.config.mjs');
  await fs.writeFile(config, `export default ${JSON.stringify({ testDir: temp, workers: 1, retries: 0, timeout: 15_000, reporter: [['list']], outputDir: path.join(temp, 'results'), use: { headless: true } })};\n`);
  await fs.writeFile(path.join(temp, 'api-gate.spec.mjs'), `
      import http from 'node:http';
      import { test, expect } from ${JSON.stringify(fixtures)};
      test.use({ bodyLimitMs: 1500 });
      for (const entry of ${JSON.stringify(cases)}) {
        test(entry.title, async ({ page, browserErrors }) => {
          const server = http.createServer((request, response) => {
            if (request.url === entry.route) {
              response.writeHead(200, { 'content-type': entry.contentType });
              if (entry.hold) response.write(entry.body); else response.end(entry.body);
            } else {
              response.writeHead(200, { 'content-type': 'text/html' });
              response.end('<html><body>API gate fixture</body></html>');
            }
          });
          await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
          const t0 = Date.now();
          const note = (what) => console.log('  [nested +' + (Date.now() - t0) + ' ms] ' + what);
          try {
            await page.goto('http://127.0.0.1:' + server.address().port);
            await page.evaluate(async entry => { try { const response = await fetch(entry.route); if (!entry.hold) await response.json(); } catch {} }, entry);
            await expect.poll(() => browserErrors.requests.has(entry.route)).toBe(true);
            note('response seen');
            if (entry.reload) { await page.reload(); note('reloaded'); }
          } finally {
            note('closePage...');
            await browserErrors.closePage(page);
            note('closePage returned');
            server.closeAllConnections?.();
            await new Promise(resolve => server.close(resolve));
          }
        });
      }
    `);
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith('PLAYWRIGHT_JSON_')) delete env[name];
  const started = Date.now();
  const result = spawnSync(process.execPath, [path.join(ui, 'node_modules', '@playwright', 'test', 'cli.js'), 'test', '--config', config], { cwd: ui, env, encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  console.log(`nested run: status ${result.status}, signal ${result.signal}, ${Date.now() - started} ms`);
  console.log((result.stdout + result.stderr).replace(/\u001b\[[0-9;]*m/g, '').split('\n').filter((line) => line.trim() && !/^\s+at /.test(line)).slice(0, 40).join('\n'));
} finally {
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
