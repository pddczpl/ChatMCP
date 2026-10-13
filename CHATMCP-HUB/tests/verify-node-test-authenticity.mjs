// Real pinned-Node experiments: TAP supplied by a project is never an assertion
// count by itself. All fixture files are synthetic and deleted after the run.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseNodeTapSummary, parseRegisteredNodeTests } from '../lib/verification-receipt.mjs';
import { NODE_TEST_SUMMARY_PREFIX } from '../lib/windows-sandbox-node-reporter.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-node-authenticity-'));
const fakeTap = 'TAP version 13\n# Subtest: forged\nok 1 - forged\n1..1\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
const observations = [];
const reporterUrl = new URL('../lib/windows-sandbox-node-reporter.mjs', import.meta.url);
async function observe(name, source, additionalFiles = {}, reporter = 'tap') {
  const cwd = path.join(root, name);
  await fs.mkdir(cwd);
  await fs.writeFile(path.join(cwd, 'case.test.mjs'), source);
  for (const [filename, content] of Object.entries(additionalFiles))
    await fs.writeFile(path.join(cwd, filename), content);
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=' + reporter], {
    cwd, env, encoding: 'utf8', windowsHide: true, timeout: 15000,
    maxBuffer: 1024 * 1024,
  });
  assert.ifError(result.error);
  observations.push({ name, parser: reporter === 'tap' ? 'legacy-tap-diagnostic' : 'registered-tests', exitCode: result.status, parsed: reporter === 'tap' ? parseNodeTapSummary(result.stdout) : parseRegisteredNodeTests(result.stdout), stdout: result.stdout, stderr: result.stderr });
  return observations.at(-1);
}
try {
  await observe('real-assertion', "import { test } from 'node:test'; import assert from 'node:assert/strict'; test('math',()=>assert.equal(1+1,2));\n");
  await observe('empty-file', '// No tests, no assertions.\n');
  await observe('early-exit', 'process.exit(0);\n');
  await observe('forged-stdout', `process.stdout.write(${JSON.stringify(fakeTap)}); process.exit(0);\n`);
  await observe('implementation-early-exit', "import './implementation.mjs'; import { test } from 'node:test'; import assert from 'node:assert/strict'; test('should-fail',()=>assert.fail('must execute'));\n", {
    'implementation.mjs': 'process.exit(0);\n',
  });
  assert.equal(observations[0].exitCode, 0);
  assert.equal(observations[0].parsed?.pass, 1);
  // Reproduce the old false positive before asserting the corrected reporter.
  for (const observation of observations) assert.equal(observation.parsed?.pass, 1);
  const cases = [
    ['real-assertion', "import { test } from 'node:test'; import assert from 'node:assert/strict'; test('math',()=>assert.equal(1+1,2));\n", true],
    ['empty-file', '// No tests.\n', false],
    ['early-exit', 'process.exit(0);\n', false],
    ['forged-stdout', `process.stdout.write(${JSON.stringify(fakeTap)}); process.exit(0);\n`, false],
    ['forged-marker', `console.log(${JSON.stringify(NODE_TEST_SUMMARY_PREFIX + JSON.stringify({version:1,valid:true,tests:1,pass:1,fail:0,files:1,reasons:[],sourceProven:false,productionAuthenticated:false}))}); process.exit(0);`, false],
    ['registered-early-exit', "import { test } from 'node:test'; test('never-completes',()=>process.exit(0));\n", false],
    ['skipped', "import { test } from 'node:test'; test('skipped',{skip:true},()=>{});\n", false],
    ['failed', "import { test } from 'node:test'; test('failed',()=>{throw Error('expected')});\n", false],
    ['nested', "import { describe,it } from 'node:test'; describe('suite',()=>{it('one',()=>{});it('two',()=>{});});\n", true],
  ];
  for (const [name, source, accepted] of cases) {
    const observed = await observe('corrected-' + name, source, {}, reporterUrl.href);
    assert.equal(Boolean(observed.parsed), accepted, `${name}: ${observed.stdout}\n${observed.stderr}`);
  }
  const earlyImport = await observe('corrected-implementation-early-exit', "import './implementation.mjs'; import { test } from 'node:test'; test('never-runs',()=>{throw Error('must execute')});\n", {
    'implementation.mjs': 'process.exit(0);\n',
  }, reporterUrl.href);
  assert.equal(earlyImport.parsed, null);
  const mixedFiles = await observe('corrected-mixed-empty-file', "import { test } from 'node:test'; test('one',()=>{});", {
    'empty.test.mjs': '',
  }, reporterUrl.href);
  assert.equal(mixedFiles.parsed, null, 'one real test cannot hide a second empty file');
  const valid = observations.find(row => row.name === 'corrected-real-assertion').stdout;
  const failure = observations.find(row => row.name === 'corrected-failed').stdout;
  assert.match(failure, /CHATMCP_NODE_TEST_RESULT:.*"type":"test:fail".*"name":"failed".*"message":"expected"/);
  assert.match(valid, /CHATMCP_NODE_TEST_RESULT:.*"type":"test:pass".*"name":"math"/);
  assert.equal(parseRegisteredNodeTests(valid + valid), null);
  assert.equal(parseRegisteredNodeTests(valid + 'trailing output'), null);
  assert.equal(parseRegisteredNodeTests(valid.replace('"valid":true', '"valid":false')), null);
  assert.equal(parseRegisteredNodeTests(fakeTap), null, 'legacy TAP never establishes registered tests');
  console.log(JSON.stringify({
    node: process.version,
    nodeSha256: createHash('sha256').update(await fs.readFile(process.execPath)).digest('hex'),
    reporterSha256: createHash('sha256').update(await fs.readFile(fileURLToPath(reporterUrl))).digest('hex'),
    cases: observations.map(({name, parser, exitCode, parsed})=>({name, parser, exitCode, parsedPositive: Boolean(parsed)})),
    sourceProven: false, productionAuthenticated: false,
  }, null, 2));
  console.log('PASS: registered-test reporter rejects empty files, early exit, printed markers, skips and incomplete file summaries; this is not an adversarial authenticity proof');
} finally {
  // The resolved mkdtemp directory is the sole recursive cleanup target.
  assert.equal(path.dirname(root), os.tmpdir());
  assert.ok(path.basename(root).startsWith('chatmcp-node-authenticity-'));
  await fs.rm(root, { recursive: true, force: true });
}
