// The Hub as an MCP SERVER for local clients (docs/MCP-SERVER.md, roadmap P6 ext-17): the listener's core.
//
//   1. The setting: off by default; CHATMCP_MCP_SERVER beats the saved choice, which beats the default; the port (3008 unless set).
//   2. The token: 256 bits, kept as SHA-256 plus a protector-sealed copy, never in clear on disk; checked in constant time; rotation.
//   3. The SDK: a real v2 client (lib/mcp/sdk.mjs) against the listener lists the provider's exact tools with their annotations, in a
//      deterministic order; a 2025 `initialize` works without a session; `server/discover` with the full _meta envelope answers 2026-07-28.
//   4. The gate in front of it: no token / wrong token -> 401 with WWW-Authenticate; a foreign Host or Origin -> 403; an oversize body -> 413;
//      the rate limit -> 429; bound to 127.0.0.1 only; the request log never carries the token; a rotated token is refused at once.
//   5. startHubMcpServer: off -> nothing listens; the SDK missing -> no throw, `mcp_runtime_missing`; on -> listens, close() frees the port.
//   6. A real hub.mjs (the e2e helper): off by default (nothing on the configured port), the SDK missing (the Hub starts and logs
//      mcp_runtime_missing), on (a client with the token lists hub_status; a shutdown closes the listener).
// Every listener here binds port 0 or a port freePort() just found: never 3007 (the owner's Hub) and never a fixed 3008.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { loadMcpSdk } from '../lib/mcp/sdk.mjs';
import { loadMcpServerSdk, locateMcpServerRuntime, MCP_NODE_VERSION, MCP_SERVER_VERSION } from '../lib/mcp/server-sdk.mjs';
import { createMcpServerFactory, createRateLimiter, startHubMcpServer, startMcpListener, MCP_SERVER_PATH } from '../lib/mcp/server.mjs';
import { McpServerTokenStore, MCP_TOKEN_FILE } from '../lib/mcp/server-token.mjs';
import { DEFAULT_MCP_SERVER_PORT, MCP_SERVER_FILE, MCP_SERVER_PORT_VARIABLE, MCP_SERVER_VARIABLE, McpServerSettingStore, mcpServerSetting } from '../lib/mcp/server-setting.mjs';
import { createProtector } from '../lib/secret-box.mjs';
import { HUB_ROOT, freePort, startHub, waitFor } from './e2e/hub-process.mjs';

let passed = 0;
let failures = 0;
async function test(name, body) {
  try { await body(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { failures += 1; console.error(`FAIL ${name}\n${error?.stack ?? error}`); }
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'chatmcp-mcp-server-'));
const folder = (name) => { const dir = path.join(scratch, name); fs.mkdirSync(dir, { recursive: true }); return dir; };
// A file-key protector (aes-gcm) keeps the unit tests fast and the same on every platform; the Hub itself uses createProtector's default.
const fileProtector = (dir) => createProtector({ platform: 'linux', directory: dir, env: {} });
const object = (properties = {}, required = []) => ({ type: 'object', properties, required });
// The fixture provider: given out of order on purpose, so that the order the client sees is the server's, not the provider's.
const FIXTURE_TOOLS = Object.freeze([
  { name: 'zeta_write', title: 'Zeta', description: 'Pretends to write', inputSchema: object({ path: { type: 'string' } }, ['path']), annotations: { destructiveHint: true, readOnlyHint: false } },
  { name: 'alpha_read', description: 'Pretends to read', inputSchema: object(), annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'mid_echo', description: 'Echoes', inputSchema: object({ message: { type: 'string' } }, ['message']), annotations: { idempotentHint: true } },
]);
const calls = [];
const fixtureCall = async (name, args) => { calls.push({ name, args }); return { content: [{ type: 'text', text: `${name}: ${JSON.stringify(args)}` }] }; };
const refused = (port) => new Promise((resolve) => {
  const socket = net.connect({ host: '127.0.0.1', port });
  socket.once('connect', () => { socket.destroy(); resolve(false); });
  socket.once('error', () => resolve(true));
});

const clientSdk = await loadMcpSdk();
const serverSdk = await loadMcpServerSdk();

/** A listener on port 0 with the fixture provider and a fresh token; `lines` collects its request log. */
async function fixtureListener(options = {}) {
  const dir = folder(`listener-${randomBytes(4).toString('hex')}`);
  const tokens = new McpServerTokenStore({ directory: dir, protector: fileProtector(dir) });
  await tokens.load();
  const token = (await tokens.ensure()).token;
  const lines = [];
  const factory = createMcpServerFactory(serverSdk, { name: 'datgold-test', version: '0.0.1', tools: FIXTURE_TOOLS, call: fixtureCall });
  const listener = await startMcpListener({ sdk: serverSdk, port: 0, factory, verifyToken: (candidate) => tokens.verify(candidate), log: (line) => lines.push(line), ...options });
  return { listener, tokens, token, lines, url: `http://127.0.0.1:${listener.port}${MCP_SERVER_PATH}` };
}

async function connectClient(url, token) {
  const client = new clientSdk.Client({ name: 'verify-mcp-server', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(new clientSdk.StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return client;
}

const JSON_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
const post = async (url, body, headers = {}) => {
  const response = await fetch(url, { method: 'POST', headers: { ...JSON_HEADERS, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: response.status, headers: response.headers, text: await response.text() };
};
/** The JSON-RPC message of a JSON or a one-event SSE answer. */
const messageOf = (text) => JSON.parse(text.startsWith('event:') || text.startsWith('data:') ? text.split('\n').find((line) => line.startsWith('data: ')).slice(6) : text);
const INITIALIZE = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } } };
const ENVELOPE = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'raw', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} };
const DISCOVER = { jsonrpc: '2.0', id: 2, method: 'server/discover', params: { _meta: ENVELOPE } };
const MODERN = { 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'server/discover' };

try {
  // ---------------------------------------------------------------------------------------------------------------------------------
  // 1. The setting
  // ---------------------------------------------------------------------------------------------------------------------------------
  await test('the setting is off by default, on port 3008, and the variable beats the saved choice', async () => {
    const plain = mcpServerSetting({}, null);
    assert.equal(plain.enabled, false);
    assert.equal(plain.source, 'default');
    assert.equal(plain.port, DEFAULT_MCP_SERVER_PORT);
    assert.equal(DEFAULT_MCP_SERVER_PORT, 3008);
    assert.equal(MCP_SERVER_VARIABLE, 'CHATMCP_MCP_SERVER');
    assert.equal(MCP_SERVER_PORT_VARIABLE, 'CHATMCP_MCP_SERVER_PORT');
    for (const value of ['on', '1', 'TRUE', ' yes ', 'enabled']) assert.equal(mcpServerSetting({ CHATMCP_MCP_SERVER: value }, { enabled: false }).enabled, true, value);
    for (const value of ['off', '0', 'false', 'no', 'disabled']) {
      const setting = mcpServerSetting({ CHATMCP_MCP_SERVER: value }, { enabled: true });
      assert.equal(setting.enabled, false, value);
      assert.equal(setting.source, 'env', value);
    }
    const saved = mcpServerSetting({ CHATMCP_MCP_SERVER: 'maybe' }, { enabled: true, port: 4555 });
    assert.equal(saved.enabled, true, 'a value that is neither on nor off decides nothing');
    assert.equal(saved.source, 'config');
    assert.equal(saved.port, 4555);
    assert.equal(mcpServerSetting({ CHATMCP_MCP_SERVER_PORT: '4666' }, { enabled: true, port: 4555 }).port, 4666, 'the port variable beats the saved port');
    assert.equal(mcpServerSetting({}, { enabled: 'yes' }).enabled, false, 'a saved value that is not a boolean is no choice');
    for (const bad of ['80', '70000', '3006', 'abc', '4000.5']) {
      const setting = mcpServerSetting({ CHATMCP_MCP_SERVER: 'on', CHATMCP_MCP_SERVER_PORT: bad }, null);
      assert.equal(setting.port, null, bad);
      assert.equal(setting.portError, 'mcp_server_port_invalid', bad);
    }
    assert.equal(mcpServerSetting({ CHATMCP_MCP_SERVER_PORT: '0' }, null).port, 0, 'port 0 (any free port) is allowed: the Hub logs the real one');
  });

  await test('the setting store reads and writes mcp-server.json, and refuses to change what the variable decides', async () => {
    const dir = folder('setting');
    assert.equal(MCP_SERVER_FILE, 'mcp-server.json');
    const store = new McpServerSettingStore({ directory: dir, env: {} });
    await store.load();
    assert.equal(store.current().enabled, false);
    await store.set({ enabled: true, port: 4777 });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, MCP_SERVER_FILE), 'utf8')), { version: 1, enabled: true, port: 4777 });
    const again = new McpServerSettingStore({ directory: dir, env: {} });
    await again.load();
    assert.equal(again.current().enabled, true);
    assert.equal(again.current().port, 4777);
    await assert.rejects(again.set({ enabled: 'on' }), (error) => error.statusCode === 400);
    await assert.rejects(again.set({ enabled: true, port: 22 }), (error) => error.statusCode === 400);
    const pinned = new McpServerSettingStore({ directory: dir, env: { CHATMCP_MCP_SERVER: 'off' } });
    await pinned.load();
    assert.equal(pinned.current().enabled, false);
    await assert.rejects(pinned.set({ enabled: true }), (error) => error.statusCode === 409);
    fs.writeFileSync(path.join(dir, MCP_SERVER_FILE), '{not json');
    const broken = new McpServerSettingStore({ directory: dir, env: {}, log: () => {} });
    await broken.load();
    assert.equal(broken.current().enabled, false, 'an unreadable file falls back to off');
  });

  // ---------------------------------------------------------------------------------------------------------------------------------
  // 2. The token
  // ---------------------------------------------------------------------------------------------------------------------------------
  await test('the token is 256 random bits, stored as SHA-256 plus a sealed copy, never in clear', async () => {
    const dir = folder('token');
    const store = new McpServerTokenStore({ directory: dir, protector: fileProtector(dir) });
    await store.load();
    assert.equal(store.status().configured, false);
    assert.equal(store.verify('anything'), false, 'no token: nothing verifies');
    const first = await store.ensure();
    assert.equal(first.created, true);
    assert.match(first.token, /^dgmcp_[A-Za-z0-9_-]{43}$/, '32 bytes, base64url');
    assert.equal((await store.ensure()).created, false, 'ensure() keeps an existing token');
    assert.equal((await store.ensure()).token, null, 'and does not hand it out again');
    const file = fs.readFileSync(path.join(dir, MCP_TOKEN_FILE), 'utf8');
    assert.ok(!file.includes(first.token), 'the file does not hold the token in clear');
    const record = JSON.parse(file);
    assert.match(record.sha256, /^[a-f0-9]{64}$/);
    assert.equal(typeof record.sealed, 'string');
    assert.equal(store.verify(first.token), true);
    for (const wrong of [first.token.slice(0, -1), `${first.token}x`, first.token.toUpperCase(), '', null, undefined, 42, {}]) assert.equal(store.verify(wrong), false, String(wrong));
    assert.equal(await store.reveal(), first.token, 'the sealed copy opens to the token');
    const reloaded = new McpServerTokenStore({ directory: dir, protector: fileProtector(dir) });
    await reloaded.load();
    assert.equal(reloaded.verify(first.token), true, 'a restart keeps the token');
    const second = await reloaded.rotate();
    assert.notEqual(second, first.token);
    assert.equal(reloaded.verify(first.token), false, 'rotation retires the old token');
    assert.equal(reloaded.verify(second), true);
    fs.writeFileSync(path.join(dir, MCP_TOKEN_FILE), '{"version":1,"sha256":"nothex"}');
    const broken = new McpServerTokenStore({ directory: dir, protector: fileProtector(dir), log: () => {} });
    await broken.load();
    assert.equal(broken.status().configured, false, 'a damaged file is no token');
    assert.equal(broken.verify(second), false);
  });

  // ---------------------------------------------------------------------------------------------------------------------------------
  // 3. The SDK: tools, legacy initialize, discover
  // ---------------------------------------------------------------------------------------------------------------------------------
  await test('the server SDK is the pinned one', async () => {
    assert.equal(MCP_SERVER_VERSION, '2.4.0');
    assert.equal(MCP_NODE_VERSION, '2.1.2');
    assert.deepEqual(serverSdk.versions, { server: '2.4.0', node: '2.1.2' });
    const other = folder('fake-runtime');
    const fake = path.join(other, 'node_modules', '@modelcontextprotocol', 'server');
    fs.mkdirSync(fake, { recursive: true });
    fs.writeFileSync(path.join(fake, 'package.json'), JSON.stringify({ name: '@modelcontextprotocol/server', version: '9.9.9', exports: { '.': { import: { default: './x.mjs' } } } }));
    const located = locateMcpServerRuntime([other]);
    assert.equal(located.state, 'invalid');
    assert.equal(located.code, 'mcp_runtime_invalid');
    assert.equal(locateMcpServerRuntime([folder('empty-runtime')]).code, 'mcp_runtime_missing');
  });

  await test('a v2 client with the token lists the exact tools of the provider, with their annotations, in name order, and calls one', async () => {
    const { listener, token, url } = await fixtureListener();
    try {
      assert.equal(listener.server.address().address, '127.0.0.1', 'loopback only');
      const client = await connectClient(url, token);
      try {
        assert.equal(client.getNegotiatedProtocolVersion(), '2026-07-28', 'the installed SDK pair negotiates the 2026-07-28 revision');
        const listed = await client.listTools();
        assert.equal(listed.tools.length, FIXTURE_TOOLS.length);
        assert.deepEqual(listed.tools.map((tool) => tool.name), ['alpha_read', 'mid_echo', 'zeta_write']);
        for (const tool of listed.tools) {
          const source = FIXTURE_TOOLS.find((item) => item.name === tool.name);
          assert.deepEqual(tool.annotations, { ...(source.title ? { title: source.title } : {}), ...source.annotations }, `${tool.name}: annotations kept`);
          assert.deepEqual(tool.inputSchema, source.inputSchema, `${tool.name}: the input schema is the provider's`);
          assert.equal(tool.description, source.description);
        }
        assert.equal(listed.ttlMs, 0, 'the list carries the cache hint of the 2026-07-28 revision');
        assert.equal(listed.cacheScope, 'private');
        const result = await client.callTool({ name: 'mid_echo', arguments: { message: 'hi' } });
        assert.equal(result.content[0].text, 'mid_echo: {"message":"hi"}');
        assert.deepEqual(calls.at(-1), { name: 'mid_echo', args: { message: 'hi' } });
        const invalid = await client.callTool({ name: 'mid_echo', arguments: {} });
        assert.equal(invalid.isError, true, 'the input schema is enforced before the provider is called');
        assert.equal(calls.length, 1);
      } finally { await client.close(); }
    } finally { await listener.close(); }
  });

  await test('a legacy initialize is answered statelessly (no session id); server/discover with the envelope answers 2026-07-28', async () => {
    const { listener, token, url } = await fixtureListener();
    try {
      const auth = { authorization: `Bearer ${token}` };
      const initialize = await post(url, INITIALIZE, auth);
      assert.equal(initialize.status, 200);
      assert.equal(initialize.headers.get('mcp-session-id'), null, 'stateless: no session');
      const answer = messageOf(initialize.text);
      assert.equal(answer.result.protocolVersion, '2025-06-18');
      assert.equal(answer.result.serverInfo.name, 'datgold-test');
      assert.ok(answer.result.capabilities.tools);
      const discover = await post(url, DISCOVER, { ...auth, ...MODERN });
      assert.equal(discover.status, 200);
      const found = messageOf(discover.text);
      // The SDK pair (server 2.4.0) supports exactly one modern revision, so discover lists it alone.
      assert.deepEqual(found.result.supportedVersions, ['2026-07-28']);
      assert.ok(found.result.capabilities.tools);
      const get = await fetch(url, { headers: { ...auth, accept: 'text/event-stream' } });
      assert.equal(get.status, 405, 'no sessions: GET (a 2025 session stream) is refused');
    } finally { await listener.close(); }
  });

  await test('the factory refuses a tool list it cannot serve faithfully', async () => {
    const build = (tools) => createMcpServerFactory(serverSdk, { name: 'x', version: '1', tools, call: fixtureCall })();
    assert.throws(() => build([FIXTURE_TOOLS[0], FIXTURE_TOOLS[0]]), /duplicate/i);
    assert.throws(() => build([{ name: 'bad name', inputSchema: object() }]), /name/i);
    assert.throws(() => build([{ name: 'ok', inputSchema: { type: 'string' } }]), /object/i);
    assert.throws(() => createMcpServerFactory(serverSdk, { name: 'x', version: '1', tools: [], call: null }), /call/i);
    const empty = build([]);
    assert.ok(empty, 'an empty list is a valid provider (the Hub of ext-17 exposes no workspace tool)');
    const dynamic = createMcpServerFactory(serverSdk, { name: 'x', version: '1', tools: () => [FIXTURE_TOOLS[1]], call: fixtureCall });
    assert.ok(dynamic(), 'a function provider is asked per request');
  });

  // ---------------------------------------------------------------------------------------------------------------------------------
  // 4. The gate
  // ---------------------------------------------------------------------------------------------------------------------------------
  await test('no token and a wrong token get 401 with WWW-Authenticate', async () => {
    const { listener, token, url } = await fixtureListener();
    try {
      const none = await post(url, INITIALIZE);
      assert.equal(none.status, 401);
      assert.match(none.headers.get('www-authenticate') ?? '', /^Bearer realm="DatGold MCP"/);
      const wrong = await post(url, INITIALIZE, { authorization: `Bearer ${token.slice(0, -2)}xx` });
      assert.equal(wrong.status, 401);
      assert.match(wrong.headers.get('www-authenticate') ?? '', /error="invalid_token"/);
      for (const header of [`Basic ${token}`, token, `Bearer  ${token}`, `Bearer ${token} extra`]) assert.equal((await post(url, INITIALIZE, { authorization: header })).status, 401, header);
      assert.equal((await post(url, INITIALIZE, { authorization: `bearer ${token}` })).status, 200, 'the scheme is case-insensitive');
    } finally { await listener.close(); }
  });

  await test('a foreign Host or Origin is refused with 403 before the token is looked at', async () => {
    const { listener, token, url } = await fixtureListener();
    try {
      const auth = { authorization: `Bearer ${token}` };
      const raw = (headers) => new Promise((resolve, reject) => {
        const socket = net.connect({ host: '127.0.0.1', port: listener.port });
        let data = '';
        socket.on('data', (chunk) => { data += chunk; });
        socket.on('end', () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(data)?.[1])));
        socket.on('error', reject);
        const body = JSON.stringify(INITIALIZE);
        socket.end(`POST /mcp HTTP/1.1\r\n${Object.entries({ 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'content-length': Buffer.byteLength(body), connection: 'close', ...headers }).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n${body}`);
      });
      assert.equal(await raw({ host: 'evil.test', ...auth }), 403, 'a DNS-rebinding Host');
      assert.equal(await raw({ host: `evil.test:${listener.port}`, ...auth }), 403);
      assert.equal(await raw({ host: '127.0.0.1:1', ...auth }), 403, 'the port must be the listener\'s');
      assert.equal(await raw({ host: 'evil.test' }), 403, '403 even without a token');
      assert.equal(await raw({ host: `localhost:${listener.port}`, ...auth }), 200, 'localhost:<port> is the listener');
      assert.equal((await post(url, INITIALIZE, { ...auth, origin: 'http://evil.test' })).status, 403, 'a foreign Origin');
      assert.equal((await post(url, INITIALIZE, { ...auth, origin: 'null' })).status, 403, 'an opaque Origin');
      assert.equal((await post(url, INITIALIZE, { ...auth, origin: 'http://127.0.0.1:3007' })).status, 403, 'another local origin (the dashboard) is foreign too');
      assert.equal((await post(url, INITIALIZE, { ...auth, origin: `http://127.0.0.1:${listener.port}` })).status, 200, 'its own origin is not');
    } finally { await listener.close(); }
  });

  await test('a body over the limit gets 413; an unknown path 404', async () => {
    const { listener, token, url } = await fixtureListener({ bodyLimit: 4096 });
    try {
      const auth = { authorization: `Bearer ${token}` };
      const big = { ...INITIALIZE, params: { ...INITIALIZE.params, pad: 'x'.repeat(5000) } };
      assert.equal((await post(url, big, auth)).status, 413);
      assert.equal((await post(url, INITIALIZE, auth)).status, 200, 'a normal body passes');
      assert.equal((await post(`http://127.0.0.1:${listener.port}/other`, INITIALIZE, auth)).status, 404);
    } finally { await listener.close(); }
  });

  await test('the rate limit trips with 429 and Retry-After, also for requests without a token', async () => {
    let clock = 1_000;
    const { listener, token, url } = await fixtureListener({ rateLimit: { windowMs: 60_000, max: 3 }, now: () => clock });
    try {
      const auth = { authorization: `Bearer ${token}` };
      assert.equal((await post(url, INITIALIZE, auth)).status, 200);
      assert.equal((await post(url, INITIALIZE)).status, 401);
      assert.equal((await post(url, INITIALIZE, auth)).status, 200);
      const limited = await post(url, INITIALIZE, auth);
      assert.equal(limited.status, 429);
      assert.equal(limited.headers.get('retry-after'), '60');
      clock += 60_000;
      assert.equal((await post(url, INITIALIZE, auth)).status, 200, 'a new window lets requests through again');
    } finally { await listener.close(); }
    const limiter = createRateLimiter({ windowMs: 1000, max: 2, now: () => 0 });
    assert.equal(limiter.take('a').ok, true);
    assert.equal(limiter.take('a').ok, true);
    assert.equal(limiter.take('a').ok, false);
    assert.equal(limiter.take('b').ok, true, 'per client key');
  });

  await test('the request log names method, path and status, and never the token', async () => {
    const { listener, token, url, lines } = await fixtureListener();
    try {
      await post(url, INITIALIZE, { authorization: `Bearer ${token}` });
      await post(`${url}?token=${token}`, INITIALIZE, { authorization: `Bearer ${token}` });
      await post(`http://127.0.0.1:${listener.port}/${token}`, INITIALIZE);
      await post(url, INITIALIZE, { authorization: `Bearer ${token}x` });
      await waitFor(() => lines.length >= 4, { timeoutMs: 5000, label: 'four log lines' });
      const text = lines.join('\n');
      assert.ok(!text.includes(token), 'the token is not in the log');
      assert.ok(!text.includes(token.slice(6, 20)), 'nor a piece of it');
      assert.ok(!/bearer/i.test(text), 'nor the word that makes the Hub hide a whole line');
      assert.match(lines[0], /^MCP server: POST \/mcp 200 /);
      assert.match(text, /POST \(other path\) 404/);
      assert.match(text, /POST \/mcp 401/);
    } finally { await listener.close(); }
  });

  await test('a rotated token is refused at once; the new one works', async () => {
    const { listener, tokens, token, url } = await fixtureListener();
    try {
      const fresh = await tokens.rotate();
      assert.equal((await post(url, INITIALIZE, { authorization: `Bearer ${token}` })).status, 401);
      assert.equal((await post(url, INITIALIZE, { authorization: `Bearer ${fresh}` })).status, 200);
    } finally { await listener.close(); }
  });

  await test('close() frees the port', async () => {
    const { listener } = await fixtureListener();
    const { port } = listener;
    assert.equal(await refused(port), false);
    await listener.close();
    assert.equal(await refused(port), true);
    await listener.close();
  });

  // ---------------------------------------------------------------------------------------------------------------------------------
  // 5. startHubMcpServer
  // ---------------------------------------------------------------------------------------------------------------------------------
  const hubOptions = (dir, env, extra = {}) => ({ env, directory: dir, protector: fileProtector(dir), name: 'DatGold Hub', version: '0.0.0-test', dashboardPort: 3007, log: () => {}, tools: FIXTURE_TOOLS, call: fixtureCall, ...extra });

  await test('startHubMcpServer: off by default, nothing listens and no token is made', async () => {
    const dir = folder('hub-off');
    const port = await freePort();
    const handle = await startHubMcpServer(hubOptions(dir, { [MCP_SERVER_PORT_VARIABLE]: String(port) }));
    assert.equal(handle.status().state, 'off');
    assert.equal(handle.status().port, null);
    assert.equal(await refused(port), true);
    assert.equal(fs.existsSync(path.join(dir, MCP_TOKEN_FILE)), false);
    await handle.close();
  });

  await test('startHubMcpServer: the SDK missing is reported as mcp_runtime_missing, without a throw', async () => {
    const dir = folder('hub-missing');
    const port = await freePort();
    const lines = [];
    const handle = await startHubMcpServer(hubOptions(dir, { [MCP_SERVER_VARIABLE]: 'on', [MCP_SERVER_PORT_VARIABLE]: String(port) }, { roots: [folder('no-runtime')], log: (line) => lines.push(line) }));
    assert.equal(handle.status().state, 'unavailable');
    assert.equal(handle.status().code, 'mcp_runtime_missing');
    assert.ok(lines.some((line) => line.includes('mcp_runtime_missing')));
    assert.equal(await refused(port), true);
    await handle.close();
  });

  await test('startHubMcpServer: the dashboard port and a bad port are refused', async () => {
    const dir = folder('hub-port');
    const same = await startHubMcpServer(hubOptions(dir, { [MCP_SERVER_VARIABLE]: 'on', [MCP_SERVER_PORT_VARIABLE]: '4999' }, { dashboardPort: 4999 }));
    assert.equal(same.status().state, 'failed');
    assert.equal(same.status().code, 'mcp_server_port_invalid');
    const bad = await startHubMcpServer(hubOptions(dir, { [MCP_SERVER_VARIABLE]: 'on', [MCP_SERVER_PORT_VARIABLE]: '99' }));
    assert.equal(bad.status().code, 'mcp_server_port_invalid');
  });

  await test('startHubMcpServer: a port in use is a failed status, not a crash', async () => {
    const dir = folder('hub-busy');
    const blocker = net.createServer();
    await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    try {
      const handle = await startHubMcpServer(hubOptions(dir, { [MCP_SERVER_VARIABLE]: 'on', [MCP_SERVER_PORT_VARIABLE]: String(blocker.address().port) }));
      assert.equal(handle.status().state, 'failed');
      assert.equal(handle.status().code, 'mcp_server_port_in_use');
    } finally { await new Promise((resolve) => blocker.close(resolve)); }
  });

  await test('startHubMcpServer: on, it listens with a token the store can reveal, registers it as a secret, and close() frees the port', async () => {
    const dir = folder('hub-on');
    const port = await freePort();
    const secrets = [];
    const handle = await startHubMcpServer(hubOptions(dir, { [MCP_SERVER_VARIABLE]: 'on', [MCP_SERVER_PORT_VARIABLE]: String(port) }, { registerSecret: (value) => secrets.push(value) }));
    try {
      assert.equal(handle.status().state, 'listening');
      assert.equal(handle.status().port, port);
      assert.equal(handle.status().url, `http://127.0.0.1:${port}/mcp`);
      const token = await handle.tokens.reveal();
      assert.deepEqual(secrets, [token], 'the Hub log redacts the token');
      const client = await connectClient(handle.status().url, token);
      assert.equal((await client.listTools()).tools.length, FIXTURE_TOOLS.length);
      await client.close();
    } finally { await handle.close(); }
    assert.equal(handle.status().state, 'closed');
    assert.equal(await refused(port), true);
  });

  // ---------------------------------------------------------------------------------------------------------------------------------
  // 6. A real hub.mjs
  // ---------------------------------------------------------------------------------------------------------------------------------
  await test('hub.mjs: off by default, nothing listens on the configured port', async () => {
    const port = await freePort();
    const hub = await startHub({ scratch: folder('e2e-off'), env: { [MCP_SERVER_PORT_VARIABLE]: String(port) } });
    try {
      assert.equal(await refused(port), true);
      assert.match(hub.logText(), /MCP server: off/);
    } finally { await hub.stop(); }
  });

  await test('hub.mjs: the SDK missing, the Hub still starts and reports mcp_runtime_missing', async () => {
    const port = await freePort();
    const hub = await startHub({ scratch: folder('e2e-missing'), env: { [MCP_SERVER_VARIABLE]: 'on', [MCP_SERVER_PORT_VARIABLE]: String(port), CHATMCP_MCP_RUNTIME_DIR: folder('e2e-no-runtime') } });
    try {
      const health = await fetch(`${hub.origin}/api/health`).then((response) => response.json());
      assert.equal(health.initialized, true);
      await waitFor(() => /mcp_runtime_missing/.test(hub.logText()), { timeoutMs: 10_000, label: 'the log line' });
      assert.equal(await refused(port), true);
    } finally { await hub.stop(); }
  });

  await test('hub.mjs: on, a client with the token lists hub_status only, and a shutdown closes the listener', async () => {
    const port = await freePort();
    const scratchDir = folder('e2e-on');
    const hub = await startHub({ scratch: scratchDir, env: { [MCP_SERVER_VARIABLE]: 'on', [MCP_SERVER_PORT_VARIABLE]: String(port) } });
    try {
      await waitFor(() => hub.logText().includes(`MCP server: listening on http://127.0.0.1:${port}/mcp`), { timeoutMs: 20_000, label: 'the MCP listener' });
      const tokens = new McpServerTokenStore({ directory: hub.stateDir, protector: createProtector({ bundleRoot: HUB_ROOT, directory: hub.stateDir }) });
      await tokens.load();
      const token = await tokens.reveal();
      assert.ok(!hub.logText().includes(token), 'the Hub never logs the token');
      const client = await connectClient(`http://127.0.0.1:${port}/mcp`, token);
      try {
        const { tools } = await client.listTools();
        assert.deepEqual(tools.map((tool) => tool.name), ['hub_status'], 'ext-17 exposes no workspace tool');
        assert.equal(tools[0].annotations.readOnlyHint, true);
        const status = await client.callTool({ name: 'hub_status', arguments: {} });
        assert.match(status.content[0].text, /"product":"DatGold"/);
        assert.ok(!status.content[0].text.includes(scratchDir), 'it names no folder');
      } finally { await client.close(); }
      assert.equal((await post(`http://127.0.0.1:${port}/mcp`, INITIALIZE)).status, 401);
    } finally { await hub.stop(); }
    assert.equal(await refused(port), true, 'the shutdown closed the MCP listener');
  });
} finally {
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
