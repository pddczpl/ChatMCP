import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { netLogArguments } from '../playwright.config.mjs';

// The browser of the Windows job in CI writes a NetLog (docs/CI-HEALTH.md, "net::ERR_NO_BUFFER_SPACE"). Nothing else changes how Chromium starts.
const withRoot = (run) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatmcp-netlog-'));
  try { return run(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
};

test('the Windows job of CI starts Chromium with a NetLog file of its own under test-results/netlog', () => withRoot((root) => {
  const args = netLogArguments({ ci: 'true', platform: 'win32', root, pid: 4242 });
  assert.deepEqual(args, [`--log-net-log=${path.join(root, 'test-results', 'netlog', 'chromium-4242.json')}`]);
  assert.ok(fs.statSync(path.join(root, 'test-results', 'netlog')).isDirectory(), 'the folder exists when the browser starts');
}));

test('two workers do not write the same file', () => withRoot((root) => {
  const [first] = netLogArguments({ ci: '1', platform: 'win32', root, pid: 10 });
  const [second] = netLogArguments({ ci: '1', platform: 'win32', root, pid: 11 });
  assert.notEqual(first, second);
}));

test('a person running the tests, and the Linux job, start the browser as before', () => withRoot((root) => {
  assert.deepEqual(netLogArguments({ ci: '', platform: 'win32', root, pid: 1 }), []);
  assert.deepEqual(netLogArguments({ ci: null, platform: 'win32', root, pid: 1 }), []);
  assert.deepEqual(netLogArguments({ ci: 'true', platform: 'linux', root, pid: 1 }), []);
  assert.deepEqual(netLogArguments({ ci: 'true', platform: 'darwin', root, pid: 1 }), []);
  assert.equal(fs.existsSync(path.join(root, 'test-results')), false, 'and nothing is made on disk');
}));

// An argument that is left out reads the environment (the default of `ci` is process.env.CI), and the job that runs these tests has CI set: the case is made with the variable taken away and put back.
test('without a CI variable in the environment, the browser starts as before', () => withRoot((root) => {
  const saved = process.env.CI;
  delete process.env.CI;
  try {
    assert.deepEqual(netLogArguments({ platform: 'win32', root, pid: 1 }), []);
    assert.equal(fs.existsSync(path.join(root, 'test-results')), false, 'and nothing is made on disk');
    process.env.CI = 'true';
    assert.equal(netLogArguments({ platform: 'win32', root, pid: 1 }).length, 1, 'with the variable set, the Windows job gets its NetLog');
  } finally {
    if (saved === undefined) delete process.env.CI; else process.env.CI = saved;
  }
}));
