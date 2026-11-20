// The MCP client manager over Streamable HTTP (lib/mcp/client-manager.mjs; docs/MCP-CLIENT.md), with REAL servers: the official
// @modelcontextprotocol/server-everything in its streamableHttp mode, and the fixture of tests/fixtures/mcp-fixture-server.mjs on the v2
// server SDK's createMcpHandler. What must hold:
//
//   1. Each server connects; its tool count equals an independent tools/list (fetch only, no SDK) in the negotiated version, which is
//      recorded; echo round-trips; two pages are joined.
//   2. A configured secret header reaches the server (the fixture writes down its SHA-256, never the value) and appears neither in status()
//      nor in a log line.
//   3. A hung call is cancelled at its timeout: one POST, one invocation, no replay. A call whose answer is lost (the socket is destroyed)
//      is reported with executed: 'unknown' and was POSTed once; the next call works.
//   4. There is no HTTP+SSE fallback: a server that only speaks the legacy SSE transport is not connected, and the manager has no SSE code.
//   5. A server that is not there fails within its deadline with a reason; nothing is left running.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpClientManager } from '../lib/mcp/client-manager.mjs';
import { createProtector } from '../lib/secret-box.mjs';
import { FIXTURE_SERVER, HUB, counterLines, delay, descendants, freePort, missingReason, newDescendants, rawHttpToolsList, referenceServer, runtimeRoot, startHttpServer, waitFor } from './support/mcp-tools.mjs';

const missing = missingReason();
if (missing) {
  console.log(`CHATMCP_TEST_SKIP: ${missing}`);
  process.exit(0);
}

let failures = 0;
let passed = 0;
async function test(name, body) {
  try { await body(); passed += 1; console.log(`ok - ${name}`); }
  catch (error) { failures += 1; console.log(`not ok - ${name}\n  ${String(error?.stack ?? error).split('\n').slice(0, 6).join('\n  ')}`); }
}
const rejects = async (promise, code, label) => {
  let caught = null;
  try { await promise; } catch (error) { caught = error; }
  assert.ok(caught, `${label}: expected a rejection with ${code}`);
  assert.equal(caught.code, code, `${label}: ${caught.message}`);
  return caught;
};
const text = (result) => result.content.filter((part) => part.type === 'text').map((part) => part.text).join('');

const scratch = mkdtempSync(path.join(os.tmpdir(), 'datgold-mcp-http-'));
const node = process.execPath;
const SECRET = `bearer-${Math.random().toString(36).slice(2)}-secret`;
const protector = createProtector({ bundleRoot: HUB, directory: scratch });
const registered = [];
const logLines = [];
const baseline = await descendants();
const servers = [];
let manager = null;

try {
  const counter = path.join(scratch, 'fixture.txt');
  const fixture = await startHttpServer(node, [FIXTURE_SERVER, '--transport', 'http', '--port', '0', '--counter', counter]);
  servers.push(fixture);
  const paged = await startHttpServer(node, [FIXTURE_SERVER, '--transport', 'http', '--port', '0', '--pages', '2']);
  servers.push(paged);
  const legacy = await startHttpServer(node, [FIXTURE_SERVER, '--transport', 'http', '--port', '0', '--era', 'legacy']);
  servers.push(legacy);
  const everythingPort = await freePort();
  const everything = await startHttpServer(node, [referenceServer('server-everything').entry, 'streamableHttp'], { env: { ...process.env, PORT: String(everythingPort), HOST: '127.0.0.1' } });
  servers.push(everything);
  const sseOnlyPort = await freePort();
  const sseOnly = await startHttpServer(node, [referenceServer('server-everything').entry, 'sse'], { env: { ...process.env, PORT: String(sseOnlyPort), HOST: '127.0.0.1' } });
  servers.push(sseOnly);

  manager = new McpClientManager({
    hubDirectory: path.join(scratch, 'hub'), protector, runtimeRoots: [runtimeRoot()],
    registerSecret: (value) => { if (!registered.includes(value)) registered.push(value); },
    secrets: () => registered,
    log: (line) => logLines.push(line),
  });

  const negotiated = {};
  for (const [id, url] of [['everything', `http://127.0.0.1:${everythingPort}/mcp`], ['fixture', fixture.url], ['paged', paged.url], ['legacy', legacy.url]]) {
    await test(`${id}: connects over Streamable HTTP, and its tool count equals an independent tools/list in the negotiated version`, async () => {
      await manager.store.save(id, { transport: 'http', url });
      const summary = await manager.connect(id);
      assert.equal(summary.state, 'connected');
      const listed = await manager.listTools(id);
      const independent = await rawHttpToolsList({ url, protocolVersion: summary.protocolVersion });
      assert.ok(listed.length > 0);
      assert.equal(listed.length, independent.length, `${id}: the manager lists ${listed.length} tools, tools/list says ${independent.length}`);
      assert.deepEqual(listed.map((tool) => tool.name).sort(), [...independent].sort());
      if (id === 'paged') assert.equal(listed.length, 7, 'the two pages are joined');
      negotiated[id] = summary.protocolVersion;
      console.log(`#   ${id}: protocol ${summary.protocolVersion} (${summary.era}), ${listed.length} tools, server ${summary.server?.name} ${summary.server?.version}`);
    });
  }

  await test('negotiation over HTTP: 2026-07-28 with the v2 servers, 2025-11-25 with a server that does not know server/discover', async () => {
    assert.deepEqual(negotiated, { everything: '2026-07-28', fixture: '2026-07-28', paged: '2026-07-28', legacy: '2025-11-25' });
    assert.equal(text(await manager.callTool('legacy', 'echo', { message: 'old era' })), 'echo: old era');
  });

  await test('echo round-trips over HTTP (server-everything and the fixture)', async () => {
    assert.equal(text(await manager.callTool('everything', 'echo', { message: 'over http' })), 'Echo: over http');
    assert.equal(text(await manager.callTool('fixture', 'echo', { message: 'hi' })), 'echo: hi');
    assert.deepEqual((await manager.callTool('fixture', 'add', { a: 1, b: 2 })).structuredContent, { sum: 3 });
  });

  await test('a secret header reaches the server and appears neither in status() nor in a log line', async () => {
    await manager.store.save('authed', { transport: 'http', url: fixture.url, headers: { Authorization: { value: `Bearer ${SECRET}`, secret: true }, 'X-Client-Note': 'plain' } });
    const file = readFileSync(path.join(scratch, 'hub', 'mcp-servers.json'), 'utf8');
    assert.ok(!file.includes(SECRET), 'the stored file holds no plain secret');
    assert.deepEqual(manager.store.get('authed').headers, { Authorization: { secret: true }, 'X-Client-Note': { value: 'plain', secret: false } });
    await manager.connect('authed');
    await manager.callTool('authed', 'echo', { message: 'with a header' });
    const digest = createHash('sha256').update(`Bearer ${SECRET}`).digest('hex');
    assert.ok(counterLines(counter).includes(`auth ${digest}`), 'the server received the configured Authorization header');
    assert.ok(registered.some((value) => value.includes(SECRET)), 'the header value was registered with the masker');
    const status = JSON.stringify(manager.status());
    assert.ok(!status.includes(SECRET), 'status() holds no secret');
    for (const line of logLines) assert.ok(!line.includes(SECRET), `a log line holds the secret: ${line.slice(0, 120)}`);
    assert.ok(!/headers|url/.test(Object.keys(manager.status().servers.find((server) => server.id === 'authed')).join(',')), 'status() carries neither the url nor the headers');
  });

  await test('a hung call is cancelled at its timeout: one POST, one invocation, no replay', async () => {
    const before = counterLines(counter).length;
    const started = Date.now();
    const error = await rejects(manager.callTool('fixture', 'sleep', {}, { timeoutMs: 1500 }), 'mcp_call_timeout', 'the hung call');
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 1400 && elapsed < 6000, `it ended at its timeout (${elapsed} ms)`);
    assert.equal(error.executed, 'unknown');
    await delay(1500);
    const lines = counterLines(counter).slice(before);
    assert.equal(lines.filter((line) => line === 'post sleep').length, 1, `one POST of the call (${lines.join(', ')})`);
    assert.equal(lines.filter((line) => line === 'call sleep').length, 1, 'one invocation');
  });

  await test('a call whose answer is lost is reported with executed: unknown, was POSTed once, and the next call works', async () => {
    const before = counterLines(counter).length;
    let caught = null;
    try { await manager.callTool('fixture', 'drop', {}, { timeoutMs: 10_000 }); } catch (error) { caught = error; }
    assert.ok(caught, 'the lost answer is an error');
    assert.equal(caught.code, 'mcp_connection_lost', caught.message);
    assert.equal(caught.executed, 'unknown');
    await delay(1500);
    assert.equal(text(await manager.callTool('fixture', 'echo', { message: 'after' })), 'echo: after');
    const lines = counterLines(counter).slice(before);
    assert.equal(lines.filter((line) => line === 'post drop').length, 1, `drop was POSTed once (${lines.join(', ')})`);
  });

  await test('there is no HTTP+SSE fallback: a server that only speaks the legacy SSE transport is not connected', async () => {
    await manager.store.save('sse-only', { transport: 'http', url: `http://127.0.0.1:${sseOnlyPort}/sse`, timeouts: { connectMs: 10_000 } });
    await rejects(manager.connect('sse-only'), 'mcp_connect_failed', 'the SSE-only server');
    const source = readFileSync(path.join(HUB, 'lib', 'mcp', 'client-manager.mjs'), 'utf8');
    assert.ok(!/SSEClientTransport/.test(source), 'the manager never constructs the legacy SSE transport');
  });

  await test('a server that is not there fails within its deadline, with a reason that holds no secret', async () => {
    const port = await freePort();
    await manager.store.save('absent', { transport: 'http', url: `http://127.0.0.1:${port}/mcp`, headers: { 'X-Api-Key': { value: SECRET } }, timeouts: { connectMs: 5000 } });
    const started = Date.now();
    const error = await manager.connect('absent').catch((caught) => caught);
    assert.ok(error instanceof Error && /^mcp_/.test(error.code), `a coded failure (${error?.code})`);
    assert.ok(Date.now() - started < 8000, 'within its deadline');
    const state = manager.status().servers.find((server) => server.id === 'absent');
    assert.equal(state.state, 'failed');
    assert.ok(state.lastError.message && !state.lastError.message.includes(SECRET));
  });

  await test('close() resolves with no process of the manager left', async () => {
    await manager.close();
    for (const server of servers) await server.stop();
    servers.length = 0;
    const left = await newDescendants(baseline);
    assert.deepEqual(left, [], `processes left: ${left.join(', ')}`);
    await rejects(manager.connect('fixture'), 'mcp_closed', 'connect after close');
  });
} finally {
  await manager?.close().catch(() => {});
  for (const server of servers) await server.stop().catch(() => {});
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
