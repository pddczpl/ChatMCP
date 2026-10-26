import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { HubProcess, freePort, taskkillTree, within } from '../../tests/e2e/hub-process.mjs';

// The harness that stops the real Hub at the end of every end-to-end test (tests/e2e/hub-process.mjs). A wait with no end in it turned a stuck
// Hub (or a taskkill that never returned) into the whole test timeout, with nothing to say which. These tests use a real process that ignores
// the request to stop, so what is checked is what the harness does about it, on the operating system it runs on.
const timeouts = () => process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A process that never ends by itself, wrapped the way startHub wraps the Hub; its log has `logLines`. */
async function stubbornHub(directory, logLines = ['[CHATMCP-HUB] Dashboard: http://127.0.0.1:1', '[CHATMCP-HUB] Đang dừng DatGold local Hub...']) {
  const logFile = path.join(directory, 'hub.log');
  fs.writeFileSync(logFile, `${logLines.join('\n')}\n`);
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: process.platform !== 'win32', windowsHide: true });
  const hub = new HubProcess({ child, port: await freePort(), logFile, stateDir: directory, secret: 'secret' });
  return hub;
}

const inTemporaryFolder = async (body) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chatmcp-hub-process-'));
  try { await body(directory); } finally { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
};

test('within gives the value, or null at the bound, and leaves no timer behind', async () => {
  const before = timeouts();
  assert.equal(await within(Promise.resolve('exit'), 1000), 'exit');
  assert.equal(await within(new Promise(() => {}), 40), null);
  assert.equal(timeouts(), before, 'a timer of the wait outlived it');
});

test('taskkillTree says whether taskkill ended the tree, and gives it a bound', () => {
  const calls = [];
  const answering = (result) => (...call) => { calls.push(call); return result; };
  assert.equal(taskkillTree(4242, { run: answering({ status: 0 }) }), true);
  assert.deepEqual(calls[0].slice(0, 2), ['taskkill', ['/PID', '4242', '/T', '/F']]);
  assert.equal(calls[0][2].timeout, 10_000, 'taskkill runs synchronously: unbounded, a hang of it stops everything else in the process');
  assert.equal(taskkillTree(4242, { run: answering({ status: null, error: Object.assign(new Error('spawnSync taskkill ETIMEDOUT'), { code: 'ETIMEDOUT' }) }) }), false);
  assert.equal(taskkillTree(4242, { run: answering({ status: 128 }) }), false, 'a process that taskkill could not find or end');
  assert.equal(taskkillTree(4242, { timeoutMs: 123, run: answering({ status: 0 }) }), true);
  assert.equal(calls.at(-1)[2].timeout, 123);
});

test('a Hub that does not exit when asked is ended by force, and its log is printed', async () => {
  await inTemporaryFolder(async (directory) => {
    const hub = await stubbornHub(directory);
    const printed = [];
    const original = console.error;
    console.error = (...parts) => printed.push(parts.join(' '));
    const started = Date.now();
    try {
      const outcome = await hub.stop({ graceMs: 300 });
      assert.ok(outcome, 'the exit of the Hub is returned');
      assert.equal(hub.running, false);
    } finally {
      console.error = original;
      hub.killTree();
    }
    assert.ok(Date.now() - started < 10_000, `took ${Date.now() - started} ms`);
    const report = printed.join('\n');
    assert.match(report, /did not exit within 300 ms of the shutdown request/);
    assert.match(report, /Đang dừng DatGold local Hub/, 'the end of the Hub log is in the report');
  });
});

test('a Hub that is still there after it was ended by force is an error that carries its log', async () => {
  await inTemporaryFolder(async (directory) => {
    const hub = await stubbornHub(directory, ['first line', 'last line of the log']);
    const original = console.error;
    const killTree = hub.killTree.bind(hub);
    console.error = () => {};
    hub.killTree = () => {}; // whatever ends the process fails to
    const started = Date.now();
    try {
      await assert.rejects(() => hub.stop({ graceMs: 100, killMs: 200 }), (error) => {
        assert.match(error.message, /still running 200 ms after it was ended by force/);
        assert.match(error.message, /last line of the log/);
        return true;
      });
      assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
    } finally {
      console.error = original;
      killTree();
      await within(hub.exited, 15_000);
    }
  });
});

test('a Hub that exits when asked is stopped at once, with nothing printed and no timer left', async () => {
  await inTemporaryFolder(async (directory) => {
    const hub = await stubbornHub(directory);
    // what the Hub does: it answers the request and ends 100 ms later
    const server = http.createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      if (request.url === '/api/state') response.end(JSON.stringify({ csrfToken: 'token' }));
      else { response.end('{"ok":true}'); setTimeout(() => hub.child.kill('SIGKILL'), 100); }
    });
    await new Promise((resolve) => server.listen(hub.port, '127.0.0.1', resolve));
    const printed = [];
    const original = console.error;
    console.error = (...parts) => printed.push(parts.join(' '));
    const before = timeouts();
    try {
      const outcome = await hub.stop({ graceMs: 5000 });
      assert.ok(outcome);
      assert.equal(hub.running, false);
    } finally {
      console.error = original;
      hub.killTree();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    await sleep(50);
    assert.deepEqual(printed, []);
    assert.equal(timeouts(), before, 'the 5 s wait for the exit was still running after the Hub had exited');
  });
});
