// The hardening of lib/mcp/client-manager.mjs (P2 slice C2, plan task ext-13; docs/MCP-HARDENING.md "Wired into the client manager"), against the
// hostile stdio server tests/fixtures/mcp-malicious-server.mjs and small loopback HTTP servers. What must hold:
//
//   1. Launch approval: a stdio server is never spawned before the owner approved its launch record (command, args, cwd, env KEY names, the resolved
//      executable and its sha256); a stale expectedFingerprint, a missing one and the wrong key ({fingerprint}) are refused; any change of the record
//      asks again. The record carries no secret.
//   2. Pins: a server's tools are offered (catalogGroups) only while its lists match the approved pin. Unpinned or changed (the rug pull of
//      --change-after) is needs_review with the diff; its tools are absent and a call is refused (mcp_needs_review); approveTools refuses a stale
//      expectedFingerprint.
//   3. Lists through sanitizeList: a 1 MB description with hidden characters reaches the catalog as at most 2 KB without them; a name with hidden
//      characters is refused per item. One name rule: 1-128 characters (LIMITS.nameMaxLength === MAX_NAME_LENGTH).
//   4. Results through limitToolResult: a 50 MB text is capped at the 8 MiB ceiling with a note. A message over the read limit closes the connection
//      with mcp_message_too_large. stderr is kept by createStderrCollector (64 KiB of a 5 MB flood).
//   5. Calls: a hung call times out with exactly 1 invocation; a caller abort after the request was sent is executed: 'unknown' and not replayed.
//   6. HTTP: a cross-origin redirect is not followed, so the Authorization header never reaches the other origin.
//   7. A workspace .mcp.json starts nothing; HubManager.shutdown() leaves no child process (by parent pid).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { LineReader, McpClientManager, MAX_LIST_BYTES, MAX_LIST_ITEMS, MAX_MESSAGE_BYTES, MAX_NAME_LENGTH, PREPARE_WAIT_MS, listAll } from '../lib/mcp/client-manager.mjs';
import { LIMITS } from '../lib/mcp/sanitize.mjs';
import { RESULT_LIMITS } from '../lib/mcp/result-limits.mjs';
import { createProtector } from '../lib/secret-box.mjs';
import { HubManager } from '../lib/manager.mjs';
import { assembleStudio } from '../lib/assemble.mjs';
import { HUB, counterLines, delay, descendants, missingReason, newDescendants, runtimeRoot, waitFor } from './support/mcp-tools.mjs';

const missing = missingReason();
if (missing) {
  console.log(`CHATMCP_TEST_SKIP: ${missing}`);
  process.exit(0);
}
// A Hub assembled the normal way finds the SDK beside DATGOLD-HUB; a copy of the Hub (the mutation runner's) has none there, so it is named here.
process.env.CHATMCP_MCP_RUNTIME_DIR ??= runtimeRoot();

let failures = 0;
let passed = 0;
async function test(name, body) {
  try { await body(); passed += 1; console.log(`ok - ${name}`); }
  catch (error) { failures += 1; console.log(`not ok - ${name}\n  ${String(error?.stack ?? error).split('\n').slice(0, 8).join('\n  ')}`); }
}
const rejects = async (promise, code, label) => {
  let caught = null;
  try { await promise; } catch (error) { caught = error; }
  assert.ok(caught, `${label}: expected a rejection with ${code}`);
  assert.equal(caught.code, code, `${label}: ${caught.message}`);
  return caught;
};

const scratch = mkdtempSync(path.join(os.tmpdir(), 'datgold-mcp-hardening-'));
const node = process.execPath;
const MALICIOUS = path.join(HUB, 'tests', 'fixtures', 'mcp-malicious-server.mjs');
const SECRET = `hard-${Math.random().toString(36).slice(2)}-secret`;
const protector = createProtector({ bundleRoot: HUB, directory: scratch });
const registered = [];
const logLines = [];
const baseline = await descendants();
const managers = [];
let hub = null;

function newManager(extra = {}) {
  const manager = new McpClientManager({
    hubDirectory: path.join(scratch, 'hub'), protector, runtimeRoots: [runtimeRoot()],
    registerSecret: (value) => { if (!registered.includes(value)) registered.push(value); },
    secrets: () => registered, log: (line) => logLines.push(line), ...extra,
  });
  managers.push(manager);
  return manager;
}
const malicious = (extra = [], more = {}) => ({ transport: 'stdio', command: node, args: [MALICIOUS, ...extra], ...more });
async function approveLaunch(manager, id) {
  const shown = await manager.launchRecord(id);
  return manager.approveLaunch(id, { expectedFingerprint: shown.fingerprint });
}
async function approveTools(manager, id) {
  const shown = manager.toolReview(id);
  return manager.approveTools(id, { expectedFingerprint: shown.fingerprint });
}
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const serverStatus = (manager, id) => manager.status().servers.find((server) => server.id === id);

try {
  const manager = newManager();

  // -------------------------------------------------------------------------------------------------------------------------------- 1. launch
  await test('a stdio server is not spawned before its launch is approved; the record names the executable, its sha256 and env KEY names only', async () => {
    const counter = path.join(scratch, 'launch.txt');
    await manager.store.save('launch', malicious(['--count-file', counter], { env: { API_TOKEN: { value: SECRET, secret: true }, PLAIN: 'visible' } }));
    const before = await descendants();
    const refused = await rejects(manager.connect('launch'), 'mcp_launch_not_approved', 'connect before approval');
    assert.equal(refused.statusCode, 409);
    assert.deepEqual((await descendants()).filter((pid) => !before.includes(pid)), [], 'nothing was started');
    assert.equal(serverStatus(manager, 'launch').state, 'needs_launch_approval');
    assert.equal(serverStatus(manager, 'launch').launch.approved, false);
    const shown = await manager.launchRecord('launch');
    assert.equal(shown.required, true);
    assert.equal(shown.approved, false);
    assert.match(shown.fingerprint, /^[0-9a-f]{64}$/);
    assert.equal(shown.record.executable, realpathSync.native(node));
    assert.equal(shown.record.sha256, sha256(node));
    assert.deepEqual(shown.record.envKeys, ['API_TOKEN', 'PLAIN']);
    assert.deepEqual(shown.record.args, [MALICIOUS, '--count-file', counter]);
    assert.ok(!JSON.stringify(shown).includes(SECRET), 'no secret value in the record');
    assert.ok(!JSON.stringify(manager.status()).includes(MALICIOUS), 'status() carries no command line');
    // wrong forms of the approval
    await rejects(manager.approveLaunch('launch', {}), 'mcp_fingerprint_required', 'no expectedFingerprint');
    await rejects(manager.approveLaunch('launch', { fingerprint: shown.fingerprint }), 'mcp_fingerprint_required', '{fingerprint} is not the key');
    await rejects(manager.approveLaunch('launch', { expectedFingerprint: 'f'.repeat(64) }), 'mcp_launch_changed', 'a stale fingerprint');
    await rejects(manager.connect('launch'), 'mcp_launch_not_approved', 'still not approved');
    const approved = await manager.approveLaunch('launch', { expectedFingerprint: shown.fingerprint });
    assert.equal(approved.fingerprint, shown.fingerprint);
    assert.ok(existsSync(path.join(scratch, 'hub', 'mcp-approvals.json')));
    assert.ok(!readFileSync(path.join(scratch, 'hub', 'mcp-approvals.json'), 'utf8').includes(SECRET), 'the approvals file holds no secret');
    const summary = await manager.connect('launch');
    assert.equal(summary.launch.approved, true);
    await manager.disconnect('launch');
    // a change of the record (one more argument; an env key) asks again
    await manager.store.save('launch', malicious(['--count-file', counter, '--tools', '2'], { env: { API_TOKEN: { keep: true }, PLAIN: 'visible' } }));
    await rejects(manager.connect('launch'), 'mcp_launch_not_approved', 'changed args');
    await approveLaunch(manager, 'launch');
    await manager.connect('launch');
    await manager.disconnect('launch');
    await manager.store.save('launch', malicious(['--count-file', counter, '--tools', '2'], { env: { API_TOKEN: { keep: true }, PLAIN: 'visible', EXTRA: 'x' } }));
    await rejects(manager.connect('launch'), 'mcp_launch_not_approved', 'a new env key');
    // a value of an env entry is not part of the record (only its name): changing it does not ask again
    await approveLaunch(manager, 'launch');
    await manager.store.save('launch', malicious(['--count-file', counter, '--tools', '2'], { env: { API_TOKEN: { keep: true }, PLAIN: 'other', EXTRA: 'x' } }));
    await manager.connect('launch');
    await manager.disconnect('launch');
  });

  await test('a launch approval does not survive a different executable (the sha256 is checked at every connect)', async () => {
    const copy = path.join(scratch, path.basename(node));
    writeFileSync(copy, readFileSync(node), { mode: 0o755 });
    chmodSync(copy, 0o755); // POSIX: the copy must be executable (the umask may have taken the bit off)
    await manager.store.save('copied', { transport: 'stdio', command: copy, args: [MALICIOUS] });
    await approveLaunch(manager, 'copied');
    await manager.connect('copied');
    await manager.disconnect('copied');
    // the same path, other bytes: refused
    writeFileSync(copy, Buffer.concat([readFileSync(node), Buffer.from('tampered')]));
    await rejects(manager.connect('copied'), 'mcp_launch_not_approved', 'a changed executable');
    assert.notEqual((await manager.launchRecord('copied')).record.sha256, sha256(node));
    await manager.store.remove('copied');
    rmSync(copy, { force: true });
  });

  // -------------------------------------------------------------------------------------------------------------------------------- 2. pins
  await test('an unpinned server is needs_review: its tools are absent from the catalog and a call is refused; approveTools refuses a stale fingerprint', async () => {
    const counter = path.join(scratch, 'pins.txt');
    await manager.store.save('pins', malicious(['--count-file', counter, '--change-after', '1']));
    await approveLaunch(manager, 'pins');
    const summary = await manager.connect('pins');
    assert.equal(summary.state, 'needs_review');
    assert.equal(summary.review.state, 'unpinned');
    assert.deepEqual(manager.catalogGroups().map((group) => group.id), [], 'nothing of an unpinned server is offered');
    await rejects(manager.callTool('pins', 'tool_1', {}), 'mcp_needs_review', 'a call to an unpinned server');
    assert.deepEqual(counterLines(counter), [], 'the call did not reach the server');
    const shown = manager.toolReview('pins');
    assert.deepEqual(shown.tools.map((tool) => tool.name).sort(), ['big_result', 'hang', 'tool_1']);
    assert.deepEqual(shown.prompts.map((prompt) => prompt.name), ['summarize']);
    await rejects(manager.approveTools('pins', { expectedFingerprint: 'e'.repeat(64) }), 'mcp_fingerprint_mismatch', 'a stale fingerprint');
    await rejects(manager.approveTools('pins', {}), 'mcp_fingerprint_required', 'no fingerprint');
    await rejects(manager.approveTools('pins', { fingerprint: shown.fingerprint }), 'mcp_fingerprint_required', '{fingerprint} is ignored');
    assert.equal(manager.toolReview('pins').state, 'unpinned', 'nothing was pinned by the refused calls');
    await manager.approveTools('pins', { expectedFingerprint: shown.fingerprint });
    assert.equal(serverStatus(manager, 'pins').state, 'connected');
    const groups = manager.catalogGroups();
    assert.deepEqual(groups.map((group) => group.id), ['pins']);
    assert.deepEqual(groups[0].tools.map((tool) => tool.name).sort(), ['big_result', 'hang', 'tool_1']);
    assert.equal(groups[0].serverInfo.name, 'mcp-malicious-fixture');
    assert.ok(groups[0].capabilities.tools);
    const result = await manager.callTool('pins', 'tool_1', {});
    assert.equal(result.content[0].text, 'tool_1 ran');
    // the rug pull: the second tools/list changes tool_1's description; the task preflight (prepare) lists again and catches it
    await manager.prepare();
    // prepare() connected every other enabled server this manager has approved, too (as a task preflight does): they are closed again here
    for (const id of [...manager.connections.keys()]) if (id !== 'pins') await manager.disconnect(id);
    const changed = serverStatus(manager, 'pins');
    assert.equal(changed.state, 'needs_review');
    assert.equal(changed.review.state, 'needs_review');
    assert.ok(changed.review.diff.changed.some((entry) => entry.name === 'tool_1' && entry.fields.includes('description')), JSON.stringify(changed.review.diff));
    assert.deepEqual(manager.catalogGroups(), [], 'quarantined: absent from the catalog');
    await rejects(manager.callTool('pins', 'tool_1', {}), 'mcp_needs_review', 'a call after the rug pull');
    assert.deepEqual(counterLines(counter), ['tool_1'], 'only the call made while pinned reached the server');
    await manager.disconnect('pins');
  });

  // -------------------------------------------------------------------------------------------------------------------------------- 3. lists
  await test('a 1 MB description with hidden characters reaches the catalog cut to 2 KB without them; a name with hidden characters is refused alone', async () => {
    await manager.store.save('dirty', malicious(['--description-bytes', String(1024 * 1024), '--invisible']));
    await approveLaunch(manager, 'dirty');
    await manager.connect('dirty');
    await approveTools(manager, 'dirty');
    const [group] = manager.catalogGroups().filter((entry) => entry.id === 'dirty');
    const tool = group.tools.find((entry) => entry.name === 'tool_1');
    assert.ok(Buffer.byteLength(tool.description) <= 2048, `${Buffer.byteLength(tool.description)} bytes`);
    assert.ok(!/[\u200B-\u200D\u2060\uFEFF\u202A-\u202E\u2066-\u2069]|[\u{E0000}-\u{E0FFF}]/u.test(tool.description + (tool.title ?? '')), 'no hidden character left');
    assert.match(tool.description, /DatGold: invisible or control characters removed; cut to 2048 bytes/);
    assert.deepEqual(group.tools.map((entry) => entry.name).sort(), ['big_result', 'hang', 'tool_1'], 'the tool with a hidden name is not offered');
    assert.equal(serverStatus(manager, 'dirty').refused.tools, 1);
    assert.equal(LIMITS.nameMaxLength, 128);
    assert.equal(MAX_NAME_LENGTH, LIMITS.nameMaxLength, 'one name rule for the client manager and the sanitizer');
    await manager.disconnect('dirty');
  });

  // -------------------------------------------------------------------------------------------------------------------------------- 4. results
  await test('a 50 MB result is capped at the 8 MiB ceiling with a note', async () => {
    await manager.store.save('big', malicious(['--result-bytes', String(50 * 1024 * 1024)]));
    await approveLaunch(manager, 'big');
    await manager.connect('big');
    await approveTools(manager, 'big');
    const started = Date.now();
    const result = await manager.callTool('big', 'big_result', {}, { timeoutMs: 60_000 });
    const text = result.content.filter((part) => part.type === 'text').map((part) => part.text);
    assert.ok(Buffer.byteLength(text[0]) <= RESULT_LIMITS.maxReadBytes, `${Buffer.byteLength(text[0])} bytes`);
    assert.match(text.at(-1), /DatGold limited this result: text cut/);
    console.log(`  (50 MB result limited in ${Date.now() - started} ms)`);
    await manager.disconnect('big');
  });

  await test('the stdio line reader: messages split over chunks are joined, a line that never ends is refused once it passes the limit', () => {
    const seen = [];
    const reader = new LineReader({ maxBytes: 1024, parse: (text) => JSON.parse(text) });
    const line = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { text: 'x'.repeat(300) } })}\n${JSON.stringify({ jsonrpc: '2.0', id: 2, result: {} })}\n`);
    for (let at = 0; at < line.length; at += 7) reader.push(line.subarray(at, at + 7), (message) => seen.push(message.id));
    assert.deepEqual(seen, [1, 2], 'two messages read from 7-byte chunks');
    reader.push(Buffer.from('not json\n'), () => seen.push('bad'));
    assert.deepEqual(seen, [1, 2], 'a line that is not JSON is skipped');
    // no newline ever: refused at the chunk that passes the limit, not held for ever
    const endless = new LineReader({ maxBytes: 1024, parse: JSON.parse });
    endless.push(Buffer.alloc(600, 0x61), () => {});
    assert.throws(() => endless.push(Buffer.alloc(600, 0x61), () => {}), (error) => error.code === 'mcp_message_too_large');
    assert.equal(endless.size, 0, 'what was held is dropped');
    // one chunk holding a whole line over the limit, newline included
    assert.throws(() => new LineReader({ maxBytes: 1024, parse: JSON.parse }).push(Buffer.from(`"${'y'.repeat(2000)}"\n`), () => {}), (error) => error.code === 'mcp_message_too_large');
  });

  await test(`one incoming message over the read limit closes the connection with mcp_message_too_large (default ${MAX_MESSAGE_BYTES} bytes)`, async () => {
    assert.equal(MAX_MESSAGE_BYTES, 64 * 1024 * 1024);
    const small = newManager({ hubDirectory: path.join(scratch, 'small-hub'), maxMessageBytes: 1024 * 1024 });
    await small.store.save('flood', malicious(['--result-bytes', String(2 * 1024 * 1024)]));
    await approveLaunch(small, 'flood');
    await small.connect('flood');
    await approveTools(small, 'flood');
    const error = await rejects(small.callTool('flood', 'big_result', {}, { timeoutMs: 30_000 }), 'mcp_message_too_large', 'a 2 MiB message with a 1 MiB limit');
    assert.equal(error.executed, 'unknown');
    await waitFor(() => serverStatus(small, 'flood').state === 'lost', 'the connection to be closed');
    assert.equal(serverStatus(small, 'flood').lastError.code, 'mcp_message_too_large');
    // a message that arrives in one chunk, newline included, is refused too (the 8 KiB tools/list of a 4 KiB reader)
    const tiny = newManager({ hubDirectory: path.join(scratch, 'tiny-hub'), maxMessageBytes: 4096 });
    await tiny.store.save('wide', malicious(['--description-bytes', '8192']));
    await approveLaunch(tiny, 'wide');
    await rejects(tiny.connect('wide'), 'mcp_message_too_large', 'an 8 KiB list with a 4 KiB limit');
    assert.equal(serverStatus(tiny, 'wide').lastError.code, 'mcp_message_too_large');
    await small.close();
    await tiny.close();
  });

  await test('a bare command is resolved on the PATH the server gets (PATHEXT on Windows) to the file whose sha256 is approved', async () => {
    const bin = path.join(scratch, 'bin');
    mkdirSync(bin, { recursive: true });
    const shim = path.join(bin, process.platform === 'win32' ? 'fakeserver.cmd' : 'fakeserver');
    writeFileSync(shim, process.platform === 'win32' ? `@"${node}" "${MALICIOUS}" %*\r\n` : `#!/bin/sh\nexec "${node}" "${MALICIOUS}" "$@"\n`, { mode: 0o755 });
    await manager.store.save('bare', { transport: 'stdio', command: 'fakeserver', env: { PATH: bin } });
    const shown = await manager.launchRecord('bare');
    assert.equal(shown.record.command, 'fakeserver');
    assert.equal(shown.record.executable, realpathSync.native(shim));
    assert.equal(shown.record.sha256, sha256(shim));
    await manager.store.save('missing-bin', { transport: 'stdio', command: 'no-such-program-here', env: { PATH: bin } });
    assert.equal((await manager.launchRecord('missing-bin')).record.executable, null, 'a command that is found nowhere has no executable');
    await manager.store.remove('bare');
    await manager.store.remove('missing-bin');
  });

  await test('stderr is kept by the bounded collector: 64 KiB of a 5 MB flood', async () => {
    await manager.store.save('noisy', malicious(['--stderr-bytes', String(5 * 1024 * 1024)]));
    await approveLaunch(manager, 'noisy');
    await manager.connect('noisy');
    await waitFor(() => (serverStatus(manager, 'noisy').stderr?.totalBytes ?? 0) >= 5 * 1024 * 1024, 'the flood to be read', 20_000);
    const { stderr } = serverStatus(manager, 'noisy');
    assert.ok(stderr.keptBytes <= 64 * 1024, JSON.stringify(stderr));
    assert.ok(logLines.filter((line) => line.includes('noisy (stderr)')).length <= 200, 'at most 200 stderr lines reach the log');
    await manager.disconnect('noisy');
  });

  // -------------------------------------------------------------------------------------------------------------------------------- 5. calls
  await test('a hung call is aborted at its timeout with exactly one invocation, and is not replayed', async () => {
    const counter = path.join(scratch, 'hung.txt');
    await manager.store.save('hung', malicious(['--hang', '--count-file', counter]));
    await approveLaunch(manager, 'hung');
    await manager.connect('hung');
    await approveTools(manager, 'hung');
    const error = await rejects(manager.callTool('hung', 'hang', {}, { timeoutMs: 1000 }), 'mcp_call_timeout', 'the hung call');
    assert.equal(error.executed, 'unknown');
    await delay(1500);
    assert.deepEqual(counterLines(counter), ['hang'], 'exactly one invocation');
  });

  await test('a caller abort after the request was sent reports executed: unknown and is not replayed', async () => {
    const counter = path.join(scratch, 'hung.txt');
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('the owner pressed Stop')), 300);
    const error = await rejects(manager.callTool('hung', 'hang', {}, { signal: controller.signal, timeoutMs: 30_000 }), 'mcp_call_aborted', 'an aborted call');
    assert.equal(error.executed, 'unknown');
    await delay(800);
    assert.deepEqual(counterLines(counter), ['hang', 'hang'], 'one more invocation, never two');
    // aborted before it was sent: nothing reached the server
    const early = new AbortController();
    early.abort(new Error('stopped early'));
    let before = null;
    try { await manager.callTool('hung', 'hang', {}, { signal: early.signal }); } catch (caught) { before = caught; }
    assert.ok(before, 'an aborted signal refuses the call');
    assert.notEqual(before.executed, 'unknown', 'nothing was sent');
    assert.deepEqual(counterLines(counter), ['hang', 'hang']);
    await manager.disconnect('hung');
  });

  // -------------------------------------------------------------------------------------------------------------------------------- 6. HTTP
  // ------------------------------------------------------------------------------------------------------------- preflight and listings (audit F1, F3)
  await test('the task preflight waits a bounded time for servers that do not answer, backs a failed one off, and tries again after reload()', async () => {
    assert.ok(PREPARE_WAIT_MS >= 1000 && PREPARE_WAIT_MS <= 5000, `${PREPARE_WAIT_MS} ms`);
    const hung = newManager({ hubDirectory: path.join(scratch, 'hung-hub') });
    const spawns = path.join(scratch, 'hung-spawns.txt');
    const sockets = [];
    const silent = net.createServer((socket) => { sockets.push(socket); socket.on('error', () => {}); });
    await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve));
    try {
      await hung.store.save('silent-stdio', { transport: 'stdio', command: node, args: ['-e', `require('fs').appendFileSync(${JSON.stringify(spawns)}, 'x'); setInterval(() => {}, 1000)`], timeouts: { connectMs: 5000 } });
      await approveLaunch(hung, 'silent-stdio');
      await hung.store.save('silent-http', { transport: 'http', url: `http://127.0.0.1:${silent.address().port}/mcp`, timeouts: { connectMs: 5000 } });
      let started = Date.now();
      await hung.prepare();
      const first = Date.now() - started;
      assert.ok(first < PREPARE_WAIT_MS + 1500, `the first preflight waited ${first} ms, not at most about ${PREPARE_WAIT_MS}`);
      await waitFor(() => ['silent-stdio', 'silent-http'].every((id) => serverStatus(hung, id).state === 'failed'), 'both connects to time out in the background', 20_000);
      for (const id of ['silent-stdio', 'silent-http']) {
        const status = serverStatus(hung, id);
        assert.equal(status.lastError.code, 'mcp_connect_timeout', id);
        assert.ok(Date.parse(status.retryAt) > Date.now(), `${id}: retryAt ${status.retryAt} is in the future`);
      }
      assert.equal(readFileSync(spawns, 'utf8').length, 1, 'the stdio server was started once');
      started = Date.now();
      await hung.prepare();
      const second = Date.now() - started;
      assert.ok(second < 500, `the next preflight waited ${second} ms for servers that are backed off`);
      console.log(`  (preflight with two servers that never answer, connectMs 5000: ${first} ms, then ${second} ms while they are backed off)`);
      await delay(300);
      assert.equal(readFileSync(spawns, 'utf8').length, 1, 'a backed-off server is not started again by the preflight');
      // reload() (the owner changed the list) clears the back-off: the next preflight tries again
      await hung.reload();
      assert.equal(serverStatus(hung, 'silent-stdio').retryAt ?? null, null);
      await hung.prepare();
      await waitFor(() => readFileSync(spawns, 'utf8').length === 2, 'the stdio server to be started again after reload()');
    } finally {
      await hung.close();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => silent.close(resolve));
    }
  });

  await test(`a listing that passes ${MAX_LIST_ITEMS} items or ${MAX_LIST_BYTES} bytes in all is refused whole (mcp_list_too_large)`, async () => {
    assert.equal(MAX_LIST_ITEMS, 10_000);
    assert.equal(MAX_LIST_BYTES, 16 * 1024 * 1024);
    const pages = (count, size) => async ({ params }) => {
      const page = params.cursor ? Number(params.cursor) : 1;
      return { tools: Array.from({ length: size }, (_, index) => ({ name: `t${page}_${index}` })), ...(page < count ? { nextCursor: String(page + 1) } : {}) };
    };
    assert.equal((await listAll(pages(10, 1000), 'tools')).items.length, 10_000, 'exactly the item cap is read');
    await assert.rejects(listAll(pages(11, 1000), 'tools'), (error) => error.code === 'mcp_list_too_large', 'one item more');
    let asked = 0;
    const heavy = async () => { asked += 1; return { tools: [{ name: `big${asked}`, description: 'x'.repeat(9 * 1024 * 1024) }], nextCursor: `c${asked}` }; };
    await assert.rejects(listAll(heavy, 'tools'), (error) => error.code === 'mcp_list_too_large', 'two pages of 9 MiB');
    assert.equal(asked, 2, 'refused at the page that passed the byte cap, not read further');
  });

  await test('HTTP: a cross-origin redirect is not followed, so the Authorization header never reaches the other origin', async () => {
    const seenByOther = [];
    const other = http.createServer((request, response) => { seenByOther.push(request.headers); response.writeHead(500).end(); });
    await new Promise((resolve) => other.listen(0, '127.0.0.1', resolve));
    const target = `http://127.0.0.1:${other.address().port}/mcp`;
    const seenByFirst = [];
    const first = http.createServer((request, response) => { seenByFirst.push(request.headers); response.writeHead(307, { Location: target }).end(); });
    await new Promise((resolve) => first.listen(0, '127.0.0.1', resolve));
    try {
      await manager.store.save('redirect', { transport: 'http', url: `http://127.0.0.1:${first.address().port}/mcp`, headers: { Authorization: { value: `Bearer ${SECRET}`, secret: true } }, timeouts: { connectMs: 5000 } });
      const launch = await manager.launchRecord('redirect');
      assert.equal(launch.required, false, 'HTTP servers have no launch record');
      await assert.rejects(manager.connect('redirect'));
      assert.ok(seenByFirst.length >= 1 && seenByFirst.every((headers) => headers.authorization === `Bearer ${SECRET}`), 'the configured origin got the header');
      assert.ok(seenByOther.every((headers) => headers.authorization === undefined), 'the other origin never saw it');
      assert.equal(seenByOther.length, 0, 'the redirect was not followed at all');
    } finally {
      await new Promise((resolve) => first.close(resolve));
      await new Promise((resolve) => other.close(resolve));
    }
  });

  // -------------------------------------------------------------------------------------------------------------------------------- 7. the Hub
  await test('a workspace .mcp.json starts nothing; HubManager.shutdown() leaves no child process (by parent pid)', async () => {
    const work = path.join(scratch, 'work');
    mkdirSync(work, { recursive: true });
    const marker = path.join(scratch, 'dotmcp-started.txt');
    writeFileSync(path.join(work, '.mcp.json'), JSON.stringify({ mcpServers: { evil: { command: node, args: [MALICIOUS, '--count-file', marker] } } }));
    writeFileSync(path.join(work, 'README.md'), '# work\n');
    const hubDirectory = path.join(scratch, 'real-hub');
    mkdirSync(hubDirectory, { recursive: true });
    writeFileSync(path.join(hubDirectory, 'mcp-servers.json'), JSON.stringify({ version: 1, servers: { owned: { transport: 'stdio', command: node, args: [MALICIOUS] } } }));
    hub = new HubManager({ bundleRoot: HUB, dataDirectory: hubDirectory, log: () => {} });
    await hub.load(work);
    assembleStudio(hub, { bundleRoot: HUB });
    await hub.mcp.reload();
    await hub.startLocal(work);
    hub.acquireTask('hardening-task');
    const before = await descendants();
    const session = await hub.createAgentSession({});
    await session.close();
    assert.deepEqual((await descendants()).filter((pid) => !before.includes(pid)), [], 'the unapproved server was not started at preflight');
    assert.equal(existsSync(marker), false, '.mcp.json started nothing');
    assert.deepEqual(hub.mcp.status().servers.map((server) => server.id), ['owned'], 'only mcp-servers.json servers exist');
    await approveLaunch(hub.mcp, 'owned');
    const second = await hub.createAgentSession({});
    await second.close();
    hub.releaseTask('hardening-task');
    assert.equal(serverStatus(hub.mcp, 'owned').state, 'needs_review', 'preflight connected the approved server (its tools wait for review)');
    assert.ok((await descendants()).some((pid) => !before.includes(pid)), 'its process runs');
    await hub.shutdown();
    hub = null;
    assert.deepEqual(await newDescendants(baseline), [], 'no child process left after shutdown');
    assert.equal(existsSync(marker), false);
  });
} finally {
  await hub?.shutdown().catch(() => {});
  for (const manager of managers) await manager.close().catch(() => {});
  const strays = await newDescendants(baseline).catch(() => []);
  if (strays.length) { failures += 1; console.log(`not ok - processes left behind: ${strays.join(', ')}`); }
  rmSync(scratch, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
}

console.log(`${failures ? 'FAIL' : 'PASS'} mcp-hardening: ${passed} passed, ${failures} failed`);
if (failures) process.exit(1);
