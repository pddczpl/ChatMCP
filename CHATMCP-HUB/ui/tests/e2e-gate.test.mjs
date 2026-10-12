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
