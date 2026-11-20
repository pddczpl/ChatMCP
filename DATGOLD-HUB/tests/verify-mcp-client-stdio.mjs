// The MCP client manager over stdio (lib/mcp/client-manager.mjs, lib/mcp/server-config.mjs; docs/MCP-CLIENT.md), with REAL servers:
// the official reference servers @modelcontextprotocol/server-everything and server-filesystem (pinned in tests/fixtures/mcp-reference), a
// fixture of our own on the v2 server SDK (tests/fixtures/mcp-fixture-server.mjs) and a plain JSON-RPC server for the answers no SDK sends
// (tests/fixtures/mcp-raw-server.mjs). What must hold:
//
//   1. mcp-servers.json: ids, reserved ids, the refused HTTP+SSE transport, unknown settings, ${NAME} only for names the server's env map
//      declares, credentials always stored protected (createProtector), and no secret in what the UI may see (list/get/status).
//   2. Each real server connects; its tool count equals an independent tools/list (plain JSON-RPC, no SDK) in the protocol version the
//      client negotiated, which is recorded per server; echo round-trips.
//   3. Version negotiation: 2026-07-28 with the v2 servers, 2025-11-25 with a hand-wired 2025 server, and a server that exits on the probe is
//      started again with the 2025 handshake.
//   4. A .cmd-wrapped server (what npx is on Windows; a #! shell wrapper elsewhere) starts, and closing it stops the wrapper AND the server,
//      even one that ignores the end of its stdin, after its grace period, and resolves only once the child has exited. The client
//      declares no capability; an input_required answer is an error and is not answered; a server that never answers fails at the deadline.
//   5. The child's environment: a parent OPENAI_API_KEY is not there; a declared variable is; "X": "${X}" passes the Hub's X on.
//   6. Pagination: two pages are joined; a repeated cursor (also A -> B -> A) and more than 1,000 pages are refused, never cut short;
//      duplicate and empty names are refused.
//   7. A hung call is cancelled at its timeout, reached the server exactly once, and is not repeated; a call whose answer is lost (the server
//      dies) is reported as such, with executed: 'unknown', and is not repeated after the reconnect.
//   8. A result of an unknown resultType is treated as complete.
//   9. Secrets never appear in status() nor in a log line, even when the server prints one on stderr.
//  10. After close(), and after HubManager.shutdown() of a Hub assembled the normal way, no process that the manager started is left
//      (checked by parent pid and by the pids the servers reported, never by process name).
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpClientManager, MAX_LIST_PAGES, listAll, normalizeResultType } from '../lib/mcp/client-manager.mjs';
import { McpServerStore, normalizeServer, publicServer, resolveEnvironment } from '../lib/mcp/server-config.mjs';
import { createProtector } from '../lib/secret-box.mjs';
import { HubManager } from '../lib/manager.mjs';
import { assembleStudio } from '../lib/assemble.mjs';
import { FIXTURE_SERVER, HUB, RAW_SERVER, counterLines, delay, descendants, missingReason, newDescendants, rawToolsList, referenceFolder, referencePins, referenceServer, runtimeRoot, waitFor } from './support/mcp-tools.mjs';

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

const scratch = mkdtempSync(path.join(os.tmpdir(), 'datgold-mcp-stdio-'));
const node = process.execPath;
const SECRET = `sekret-${Math.random().toString(36).slice(2)}-value`;
const HEADER_SECRET = `hdr-${Math.random().toString(36).slice(2)}-token`;
const protector = createProtector({ bundleRoot: HUB, directory: scratch });
const registered = [];
const logLines = [];
const baseline = await descendants();
// pid -> parent pid that the servers told us (whoami): an orphan of a killed wrapper has no living parent to be found by, and the pair
// tells it from another process that has the same pid later.
const reported = new Map();
const reportedList = () => [...reported].map(([pid, ppid]) => ({ pid, ppid }));
let manager = null;
let hubManager = null;

function newManager({ hubDirectory = path.join(scratch, 'hub'), env = process.env } = {}) {
  return new McpClientManager({
    hubDirectory, protector, runtimeRoots: [runtimeRoot()], env,
    registerSecret: (value) => { if (!registered.includes(value)) registered.push(value); },
    secrets: () => registered,
    log: (line) => logLines.push(line),
  });
}
const reference = referenceFolder();
const fixture = (extra = []) => ({ transport: 'stdio', command: node, args: [FIXTURE_SERVER, '--reference', reference, ...extra] });
const raw = (mode, extra = []) => ({ transport: 'stdio', command: node, args: [RAW_SERVER, '--mode', mode, ...extra] });
const text = (result) => result.content.filter((part) => part.type === 'text').map((part) => part.text).join('');

try {
  // -------------------------------------------------------------------------------------------------------------------------------------
  // 1. Configuration
  // -------------------------------------------------------------------------------------------------------------------------------------
  await test('config: ids, reserved ids, the legacy SSE transport, unknown settings and plain-text credentials are refused', async () => {
    const bad = async (id, raw, code, label) => rejects(normalizeServer(id, raw), code, label);
    await bad('Fixture', fixture(), 'mcp_config_invalid', 'an upper-case id');
    await bad('9lives', fixture(), 'mcp_config_invalid', 'an id that starts with a digit');
    await bad('a'.repeat(33), fixture(), 'mcp_config_invalid', 'a 33-character id');
    for (const id of ['local', 'studio']) await bad(id, fixture(), 'mcp_config_invalid', `the reserved id ${id}`);
    await bad('legacy', { transport: 'sse', url: 'https://example.invalid/sse' }, 'mcp_transport_unsupported', 'the HTTP+SSE transport');
    await bad('typo', { ...fixture(), comand: 'x' }, 'mcp_config_invalid', 'an unknown setting');
    await bad('nocmd', { transport: 'stdio', command: '' }, 'mcp_config_invalid', 'an empty command');
    await bad('relcwd', { ...fixture(), cwd: 'relative/dir' }, 'mcp_config_invalid', 'a relative cwd');
    await bad('plainkey', { ...fixture(), env: { OPENAI_API_KEY: 'sk-plain' } }, 'mcp_config_invalid', 'a credential in plain text in the file');
    await bad('plainauth', { transport: 'http', url: 'https://example.invalid/mcp', headers: { Authorization: 'Bearer x' } }, 'mcp_config_invalid', 'an Authorization header in plain text in the file');
    await bad('far', { transport: 'http', url: 'http://example.invalid/mcp' }, 'mcp_config_invalid', 'plain http to a host that is not loopback');
    await bad('creds', { transport: 'http', url: 'https://user:pw@example.invalid/mcp' }, 'mcp_config_invalid', 'a URL with a password');
    await bad('hostheader', { transport: 'http', url: 'https://example.invalid/mcp', headers: { Host: 'other' } }, 'mcp_config_invalid', 'a header the transport sets');
    await bad('timeouts', { ...fixture(), timeouts: { connectMs: 10 } }, 'mcp_config_invalid', 'a connect timeout under 1 s');
    await bad('timeouts2', { ...fixture(), timeouts: { callMs: 1_000_000 } }, 'mcp_config_invalid', 'a call timeout over 900 s');
    await bad('enabled', { ...fixture(), enabled: 'yes' }, 'mcp_config_invalid', 'a non-boolean enabled');
    const accepted = await normalizeServer('local-ok', { transport: 'http', url: 'http://127.0.0.1:9/mcp' });
    assert.equal(accepted.url, 'http://127.0.0.1:9/mcp', 'plain http to 127.0.0.1 is accepted');
    assert.deepEqual(accepted.timeouts, { connectMs: 30_000, callMs: 120_000 }, 'the default deadlines');
  });

  await test('config: ${NAME} only for names the env map of the same server declares; pass-through, references and cycles', async () => {
    await rejects(normalizeServer('leak', { ...fixture(['${OPENAI_API_KEY}']) }), 'mcp_config_undeclared_variable', 'an argument that names an undeclared variable');
    await rejects(normalizeServer('leak2', { ...fixture(), env: { A: '${HOME}' } }), 'mcp_config_undeclared_variable', 'an env value that names an undeclared variable');
    await rejects(normalizeServer('leak3', { transport: 'http', url: 'https://example.invalid/${TOKEN}' }), 'mcp_config_undeclared_variable', 'a url that names an undeclared variable');
    await rejects(normalizeServer('bad', { ...fixture(['${not a name}']) }), 'mcp_config_invalid', 'a malformed reference');
    const parentEnv = { HUB_ONLY: 'from-the-hub', GITHUB_TOKEN: 'ghp_passed_on' };
    const resolved = await resolveEnvironment('x', { A: 'a', B: '${A}-b', HUB_ONLY: '${HUB_ONLY}', GITHUB_TOKEN: { secret: await protector.protect('unused') } }, { protector, parentEnv, platform: 'linux' });
    assert.equal(resolved.values.get('B'), 'a-b', 'a reference to another declared entry');
    assert.equal(resolved.values.get('HUB_ONLY'), 'from-the-hub', '"X": "${X}" passes the Hub\'s variable on');
    assert.ok(resolved.secret.has('GITHUB_TOKEN') && !resolved.secret.has('A'), 'the protected entry is a secret, a plain one is not');
    const passedOn = await normalizeServer('pass', { ...fixture(), env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' } });
    assert.equal(passedOn.env.GITHUB_TOKEN, '${GITHUB_TOKEN}', 'a reference under a credential name may stay plain: it holds no credential');
    const header = await normalizeServer('bearer', { transport: 'http', url: 'https://example.invalid/mcp', env: { API_TOKEN: { secret: 'blob' } }, headers: { Authorization: 'Bearer ${API_TOKEN}' } });
    assert.equal(header.headers.Authorization, 'Bearer ${API_TOKEN}', '"Bearer ${X}" is a reference too');
    await rejects(normalizeServer('literal', { ...fixture(), env: { GITHUB_TOKEN: 'ghp_${X}', X: 'x' } }), 'mcp_config_invalid', 'a literal part beside a reference is a credential in plain text');
    const resolvedPass = await resolveEnvironment('x', { GITHUB_TOKEN: '${GITHUB_TOKEN}' }, { protector, parentEnv, platform: 'linux' });
    assert.equal(resolvedPass.values.get('GITHUB_TOKEN'), 'ghp_passed_on');
    assert.ok(resolvedPass.secret.has('GITHUB_TOKEN'), 'what a credential-looking name passes on is a secret for the masker');
    await rejects(resolveEnvironment('x', { MISSING: '${MISSING}' }, { protector, parentEnv, platform: 'linux' }), 'mcp_env_missing', 'passing on a variable the Hub does not have');
    await rejects(resolveEnvironment('x', { A: '${B}', B: '${A}' }, { protector, parentEnv, platform: 'linux' }), 'mcp_config_invalid', 'a cycle');
  });

  await test('config: secrets are stored protected, never returned by list/get, and registered with the masker when a connection is made', async () => {
    const hubDirectory = path.join(scratch, 'config-check');
    const store = new McpServerStore({ hubDirectory, protector, registerSecret: (value) => registered.push(value) });
    const view = await store.save('secretive', { ...fixture(), env: { FIXTURE_TOKEN: { value: SECRET, secret: true }, PLAIN_SETTING: 'visible', OPENAI_API_KEY: SECRET, PASSED_TOKEN: '${PASSED_TOKEN}' } });
    assert.deepEqual(view.env.PASSED_TOKEN, { value: '${PASSED_TOKEN}', secret: false }, 'a pass-through reference is kept as it was typed');
    const file = readFileSync(path.join(hubDirectory, 'mcp-servers.json'), 'utf8');
    assert.ok(!file.includes(SECRET), 'the file does not hold the secret in plain text');
    assert.match(file, /"FIXTURE_TOKEN": \{\s*"secret": "/, 'it holds a protected blob');
    assert.deepEqual(view.env.FIXTURE_TOKEN, { secret: true }, 'save() returns that a secret is set, not the secret');
    assert.deepEqual(view.env.OPENAI_API_KEY, { secret: true }, 'a credential-looking name is a secret even when the caller sent it as plain text');
    assert.deepEqual(view.env.PLAIN_SETTING, { value: 'visible', secret: false });
    const listed = JSON.stringify([store.list(), store.get('secretive')]);
    assert.ok(!listed.includes(SECRET) && !listed.includes(JSON.parse(file).servers.secretive.env.FIXTURE_TOKEN.secret), 'list() and get() hold neither the secret nor its protected form');
    const reread = new McpServerStore({ hubDirectory, protector });
    await reread.load();
    await reread.save('secretive', { ...fixture(), env: { FIXTURE_TOKEN: { keep: true } } });
    const kept = await reread.resolveForConnect('secretive');
    assert.equal(kept.env.FIXTURE_TOKEN, SECRET, '{keep: true} keeps the stored secret');
    await rejects(reread.save('other', { ...fixture(), env: { FIXTURE_TOKEN: { keep: true } } }), 'mcp_config_invalid', 'keeping a secret that is not stored');
    const before = registered.length;
    await store.resolveForConnect('secretive', { parentEnv: { PASSED_TOKEN: 'passed-through-value' } });
    assert.ok(registered.slice(before).includes(SECRET), 'resolveForConnect registers the secret before anything starts');
    assert.ok(registered.slice(before).includes('passed-through-value'), 'and what a credential-looking name passes on');
    assert.ok(!JSON.stringify(publicServer('secretive', store.servers.get('secretive'))).includes(SECRET));
    await store.remove('secretive');
    assert.equal(store.get('secretive'), null);
  });

  await test('config: every credential-looking header and every URL with a password is a secret; an id has no "__" and no trailing "_"', async () => {
    // Audit of #123: F1 (header names outside the short list), F2 (a password inside a URL), F3 (mcp__<server>__<tool> must parse one way).
    const hubDirectory = path.join(scratch, 'config-credentials');
    const store = new McpServerStore({ hubDirectory, protector, registerSecret: (value) => registered.push(value) });
    const credentialHeaders = ['PRIVATE-TOKEN', 'X-Goog-Api-Key', 'X-API-Token', 'X-Figma-Token', 'Ocp-Apim-Subscription-Key', 'X-Auth-Key', 'Api-Token', 'X-Secret', 'Authorization', 'X-Api-Key'];
    const headers = Object.fromEntries(credentialHeaders.map((name, index) => [name, `hv${index}-${SECRET}`]));
    headers['X-Upstream'] = `https://user:url-pw-${SECRET}@proxy.example.invalid/`;
    headers['X-Client-Note'] = 'plain-note';
    const env = {
      DATABASE_URL: `postgres://u:db-pw-${SECRET}@db.example.invalid/x`, REDIS_URL: `redis://:redis-pw-${SECRET}@r.example.invalid:6379`,
      PLAIN_URL: 'postgres://db.example.invalid/x', DB_PASS: 'dbpass-123456', DSN: 'postgres://u:${DB_PASS}@db.example.invalid/x',
    };
    const view = await store.save('creds', { transport: 'http', url: 'https://example.invalid/mcp', headers, env });
    const file = readFileSync(path.join(hubDirectory, 'mcp-servers.json'), 'utf8');
    assert.ok(!file.includes(SECRET), 'no credential header and no URL password is in the file in plain text');
    for (const name of [...credentialHeaders, 'X-Upstream']) assert.deepEqual(view.headers[name], { secret: true }, `the header ${name} is stored as a secret`);
    assert.deepEqual(view.headers['X-Client-Note'], { value: 'plain-note', secret: false }, 'an ordinary header stays plain');
    assert.deepEqual(view.env.DATABASE_URL, { secret: true });
    assert.deepEqual(view.env.REDIS_URL, { secret: true }, 'a URL with an empty user and a password');
    assert.deepEqual(view.env.PLAIN_URL, { value: 'postgres://db.example.invalid/x', secret: false }, 'a URL without a password stays plain');
    assert.deepEqual(view.env.DSN, { value: 'postgres://u:${DB_PASS}@db.example.invalid/x', secret: false }, 'a URL whose password is a reference stays as typed');
    assert.ok(!JSON.stringify([store.list(), store.get('creds')]).includes(SECRET), 'list() and get() hold none of them');
    // Read from the file, the same values in plain text are refused; a reference under a credential name is not.
    for (const name of ['PRIVATE-TOKEN', 'X-Goog-Api-Key', 'Ocp-Apim-Subscription-Key']) {
      await rejects(normalizeServer('fromfile', { transport: 'http', url: 'https://example.invalid/mcp', headers: { [name]: 'plain-credential' } }), 'mcp_config_invalid', `${name} in plain text in the file`);
    }
    await rejects(normalizeServer('fromfile', { ...fixture(), env: { DATABASE_URL: 'postgres://u:hunter2@db/x' } }), 'mcp_config_invalid', 'a URL with a password in plain text in the file');
    await rejects(normalizeServer('fromfile', { transport: 'http', url: 'https://example.invalid/mcp', headers: { 'X-Upstream': 'https://u:p4ss@h/' } }), 'mcp_config_invalid', 'a header URL with a password in plain text in the file');
    const reference = await normalizeServer('fromfile', { transport: 'http', url: 'https://example.invalid/mcp', env: { GL: 'x' }, headers: { 'PRIVATE-TOKEN': '${GL}' } });
    assert.equal(reference.headers['PRIVATE-TOKEN'], '${GL}');
    // At connect time every one of them reaches the masker: the stored secrets, a URL put together from references, and a header made of a
    // plain, ordinary env value.
    const before = registered.length;
    await store.resolveForConnect('creds');
    const fresh = registered.slice(before);
    for (const value of Object.values(headers).filter((value) => value.includes(SECRET))) assert.ok(fresh.includes(value), `registered: ${value.slice(0, 24)}`);
    assert.ok(fresh.includes(env.DATABASE_URL) && fresh.includes(env.REDIS_URL), 'the URLs with a password are registered');
    assert.ok(fresh.includes(`db-pw-${SECRET}`) && fresh.includes(`redis-pw-${SECRET}`), 'and their passwords alone');
    assert.ok(fresh.includes('postgres://u:dbpass-123456@db.example.invalid/x') && fresh.includes('dbpass-123456'), 'a URL whose password came from a reference is registered after expansion');
    assert.ok(!fresh.includes('plain-note') && !fresh.includes('postgres://db.example.invalid/x'), 'ordinary values are not');
    await store.save('glref', { transport: 'http', url: 'https://example.invalid/mcp', env: { GL: 'glpat-from-plain-env-123' }, headers: { 'PRIVATE-TOKEN': '${GL}' } });
    const beforeRef = registered.length;
    await store.resolveForConnect('glref');
    assert.ok(registered.slice(beforeRef).includes('glpat-from-plain-env-123'), 'a credential header made of an ordinary env value is registered');
    // F3: the hook alias mcp__<server>__<tool> parses one way only if a server id has no "__" and does not end with "_".
    for (const id of ['a__b', 'a_', 'gitlab__tools']) await rejects(normalizeServer(id, fixture()), 'mcp_config_invalid', `the id ${id}`);
    for (const id of ['a_b', 'a-b', 'a1', 'git_lab-2']) assert.equal((await normalizeServer(id, fixture())).transport, 'stdio', `the id ${id} is accepted`);
  });

  // -------------------------------------------------------------------------------------------------------------------------------------
  // 2. and 3. Real servers, negotiation
  // -------------------------------------------------------------------------------------------------------------------------------------
  manager = newManager();
  const pins = referencePins();
  const everything = referenceServer('server-everything');
  const filesystem = referenceServer('server-filesystem');
  const allowed = mkdtempSync(path.join(scratch, 'allowed-'));
  writeFileSync(path.join(allowed, 'note.txt'), 'hello from the filesystem server\n');
  const negotiated = {};

  await test('the reference servers are the pinned versions', async () => {
    assert.equal(everything.version, pins['@modelcontextprotocol/server-everything']);
    assert.equal(filesystem.version, pins['@modelcontextprotocol/server-filesystem']);
  });

  for (const [id, config] of [
    ['everything', { transport: 'stdio', command: node, args: [everything.entry, 'stdio'] }],
    ['filesystem', { transport: 'stdio', command: node, args: [filesystem.entry, allowed] }],
    ['fixture', fixture()],
  ]) {
    await test(`${id}: connects, and its tool count equals an independent tools/list in the negotiated version`, async () => {
      await manager.store.save(id, config);
      const summary = await manager.connect(id);
      assert.equal(summary.state, 'connected');
      negotiated[id] = summary.protocolVersion;
      const listed = await manager.listTools(id);
      const independent = await rawToolsList({ command: config.command, args: config.args, protocolVersion: summary.protocolVersion });
      assert.ok(listed.length > 0);
      assert.equal(listed.length, independent.length, `${id}: the manager lists ${listed.length} tools, tools/list says ${independent.length}`);
      assert.deepEqual(listed.map((tool) => tool.name).sort(), [...independent].sort());
      assert.equal(summary.tools, listed.length);
      assert.match(summary.fingerprint, /^[0-9a-f]{64}$/, 'a fingerprint per server (lib/catalog.mjs)');
      console.log(`#   ${id}: protocol ${summary.protocolVersion} (${summary.era}), ${listed.length} tools, server ${summary.server?.name} ${summary.server?.version}`);
    });
  }

  await test('echo round-trips through the real server-everything and the fixture; the filesystem server reads a file', async () => {
    assert.equal(text(await manager.callTool('everything', 'echo', { message: 'round trip ✓' })), 'Echo: round trip ✓');
    assert.equal(text(await manager.callTool('fixture', 'echo', { message: 'hi' })), 'echo: hi');
    const added = await manager.callTool('fixture', 'add', { a: 2, b: 40 });
    assert.deepEqual(added.structuredContent, { sum: 42 }, 'structured content checked against the output schema');
    assert.match(text(await manager.callTool('filesystem', 'read_text_file', { path: path.join(allowed, 'note.txt') })), /hello from the filesystem server/);
    await rejects(manager.callTool('fixture', 'no_such_tool', {}), 'mcp_tool_unknown', 'a tool the server did not list');
    await rejects(manager.callTool('fixture', 'echo', ['not', 'an', 'object']), 'mcp_arguments_invalid', 'arguments that are not an object');
  });

  await test('negotiation: 2026-07-28 with the v2 servers, 2025-11-25 with a 2025 server, and a server that dies on the probe is started again', async () => {
    assert.equal(negotiated.everything, '2026-07-28');
    assert.equal(negotiated.filesystem, '2026-07-28');
    assert.equal(negotiated.fixture, '2026-07-28');
    await manager.store.save('legacy', fixture(['--era', 'legacy']));
    const legacy = await manager.connect('legacy');
    assert.equal(legacy.protocolVersion, '2025-11-25');
    assert.equal(legacy.era, 'legacy');
    const probeCounter = path.join(scratch, 'probe-exit.txt');
    await manager.store.save('dies-on-probe', raw('plain', ['--era', 'legacy', '--counter', probeCounter, '--mode', 'exit-on-probe']));
    const restarted = await manager.connect('dies-on-probe');
    assert.equal(restarted.protocolVersion, '2025-11-25');
    assert.equal(manager.connections.get('dies-on-probe').attempts, 2, 'one probe that killed the server, one plain 2025 start');
    assert.equal(text(await manager.callTool('dies-on-probe', 'probe', {})), 'called probe');
    assert.deepEqual(counterLines(probeCounter).filter((line) => line.startsWith('call')), ['call probe'], 'nothing was called during the failed attempt');
  });

  // -------------------------------------------------------------------------------------------------------------------------------------
  // 4. and 5. Wrappers, environment
  // -------------------------------------------------------------------------------------------------------------------------------------
  await test(`a ${process.platform === 'win32' ? '.cmd' : '#! shell'}-wrapped server starts, and closing it stops the wrapper and the server`, async () => {
    const wrapper = path.join(scratch, process.platform === 'win32' ? 'fixture-wrapper.cmd' : 'fixture-wrapper.sh');
    if (process.platform === 'win32') writeFileSync(wrapper, `@echo off\r\n"${node}" "${FIXTURE_SERVER}" %*\r\n`);
    else { writeFileSync(wrapper, `#!/bin/sh\n"${node}" "${FIXTURE_SERVER}" "$@"\n`); chmodSync(wrapper, 0o755); }
    // --linger: the server ignores the end of its stdin, so only stopping the whole tree ends it (killing the wrapper alone leaves it running).
    await manager.store.save('wrapped', { transport: 'stdio', command: wrapper, args: ['--reference', reference, '--pages', '1', '--stderr', 'wrapper says hello', '--linger', 'yes'] });
    const summary = await manager.connect('wrapped');
    assert.equal(summary.state, 'connected');
    const who = JSON.parse(text(await manager.callTool('wrapped', 'whoami', {})));
    reported.set(who.pid, who.ppid);
    const channel = manager.connections.get('wrapped').channel;
    const wrapperPid = channel.pid;
    assert.notEqual(who.pid, wrapperPid, 'the server runs below the wrapper');
    const tree = await descendants(wrapperPid);
    assert.ok(tree.includes(who.pid), 'the server is found below the wrapper by parent pid');
    const started = Date.now();
    await manager.disconnect('wrapped');
    assert.equal(channel.exited, true, 'disconnect() resolved only after the child had exited');
    assert.ok(Date.now() - started >= 1500, 'the server was given its grace period before the tree was stopped');
    const left = await descendants(process.pid, [{ pid: wrapperPid, ppid: process.pid }, { pid: who.pid, ppid: who.ppid }]);
    assert.ok(!left.includes(wrapperPid) && !left.includes(who.pid), `closing stopped the wrapper ${wrapperPid} and the server ${who.pid} (left: ${left.join(', ') || 'none'})`);
  });

  await test('the client declares no capability (no roots, sampling, elicitation or logging), in either era', async () => {
    for (const era of ['modern', 'legacy']) {
      const counter = path.join(scratch, `caps-${era}.txt`);
      await manager.store.save(`caps-${era}`, raw('plain', ['--era', era, '--counter', counter]));
      await manager.connect(`caps-${era}`);
      const declared = counterLines(counter).filter((line) => line.startsWith('caps '));
      assert.ok(declared.length >= 1, `${era}: the server saw the client's capabilities`);
      for (const line of declared) assert.equal(line, 'caps {}', `${era}: ${line}`);
      await manager.disconnect(`caps-${era}`);
    }
  });

  await test('an input_required result is an error, and the call is not sent again with answers', async () => {
    const counter = path.join(scratch, 'input-required.txt');
    await manager.store.save('asks', raw('input-required', ['--counter', counter]));
    await manager.connect('asks');
    const error = await manager.callTool('asks', 'probe', {}).catch((caught) => caught);
    assert.ok(error instanceof Error && error.code === 'mcp_call_failed', `${error?.code}: ${error?.message}`);
    await delay(500);
    assert.deepEqual(counterLines(counter).filter((line) => line.startsWith('call')), ['call probe'], 'sent once');
  });

  await test('a server that never answers fails at its connect deadline with mcp_connect_timeout, and is stopped', async () => {
    await manager.store.save('mute', { ...raw('mute'), timeouts: { connectMs: 3000 } });
    const started = Date.now();
    const error = await manager.connect('mute').catch((caught) => caught);
    const elapsed = Date.now() - started;
    assert.equal(error?.code, 'mcp_connect_timeout', error?.message);
    assert.ok(elapsed >= 2900 && elapsed < 9000, `at the deadline (${elapsed} ms)`);
    assert.equal(manager.connections.get('mute').channel, null, 'the process was disposed of');
  });

  await test('environment: a parent OPENAI_API_KEY is not passed; declared variables and "X": "${X}" are', async () => {
    const env = { ...process.env, OPENAI_API_KEY: 'sk-parent-must-not-leak-0123456789', DATGOLD_HUB_ONLY: 'hub-value', SOME_UNLISTED: 'not on the allow-list' };
    const isolated = newManager({ hubDirectory: path.join(scratch, 'env-hub'), env });
    try {
      await isolated.store.save('env', { ...fixture(), env: { DECLARED: 'declared-value', DATGOLD_HUB_ONLY: '${DATGOLD_HUB_ONLY}', COMBINED: '${DECLARED}+x' } });
      const names = JSON.parse(text(await isolated.callTool('env', 'env_names', {})));
      assert.ok(!names.some((name) => name.toUpperCase() === 'OPENAI_API_KEY'), 'OPENAI_API_KEY is not in the child');
      assert.ok(!names.includes('SOME_UNLISTED'), 'nor any variable outside the allow-list');
      assert.equal(text(await isolated.callTool('env', 'env_value', { name: 'OPENAI_API_KEY' })), '(unset)');
      assert.equal(text(await isolated.callTool('env', 'env_value', { name: 'DECLARED' })), 'declared-value');
      assert.equal(text(await isolated.callTool('env', 'env_value', { name: 'COMBINED' })), 'declared-value+x');
      assert.equal(text(await isolated.callTool('env', 'env_value', { name: 'DATGOLD_HUB_ONLY' })), 'hub-value');
      const pathName = names.find((name) => name.toUpperCase() === 'PATH');
      assert.ok(pathName, 'PATH (the allow-list) is there');
    } finally { await isolated.close(); }
  });

  // -------------------------------------------------------------------------------------------------------------------------------------
  // 6. Lists
  // -------------------------------------------------------------------------------------------------------------------------------------
  await test('pagination: two pages are joined into one list', async () => {
    await manager.store.save('paged', fixture(['--pages', '2']));
    const summary = await manager.connect('paged');
    const independent = await rawToolsList({ command: node, args: fixture(['--pages', '2']).args, protocolVersion: summary.protocolVersion });
    assert.equal(summary.tools, 7);
    assert.equal(independent.length, 7);
  });

  for (const [mode, code, pages] of [['repeat-cursor', 'mcp_list_cursor_repeated', 2], ['cycle-cursor', 'mcp_list_cursor_repeated', 3], ['duplicate', 'mcp_list_duplicate_name', 1], ['empty-name', 'mcp_list_invalid_name', 1]]) {
    await test(`a list with ${mode} is refused whole (${code}) and the server is not left running`, async () => {
      const counter = path.join(scratch, `${mode}.txt`);
      await manager.store.save(mode, raw(mode, ['--counter', counter]));
      await rejects(manager.connect(mode), code, mode);
      assert.equal(counterLines(counter).filter((line) => line.startsWith('list')).length, pages, `${pages} page request(s), then it stopped`);
      assert.equal(manager.status().servers.find((server) => server.id === mode).state, 'failed');
      assert.equal(manager.connections.get(mode).channel, null, 'the connection was disposed of');
    });
  }

  await test(`more than ${MAX_LIST_PAGES} pages are refused, after exactly ${MAX_LIST_PAGES} requests`, async () => {
    const counter = path.join(scratch, 'endless.txt');
    await manager.store.save('endless', { ...raw('endless', ['--counter', counter]), timeouts: { connectMs: 120_000 } });
    await rejects(manager.connect('endless'), 'mcp_list_too_many_pages', 'an endless list');
    assert.equal(counterLines(counter).filter((line) => line.startsWith('list')).length, MAX_LIST_PAGES);
    // The same walk on a scripted request function: page 1,000 may still end the list.
    const pagesOf = (count) => async ({ params }) => { const page = params.cursor ? Number(params.cursor) : 1; return { tools: [{ name: `t${page}` }], ...(page < count ? { nextCursor: String(page + 1) } : {}) }; };
    assert.equal((await listAll(pagesOf(MAX_LIST_PAGES), 'tools')).items.length, MAX_LIST_PAGES, 'exactly 1,000 pages are read');
    await rejects(listAll(pagesOf(MAX_LIST_PAGES + 1), 'tools'), 'mcp_list_too_many_pages', '1,001 pages');
    await rejects(listAll(async () => ({ tools: [{ name: 'a' }], nextCursor: '' }), 'tools'), 'mcp_list_cursor_invalid', 'an empty cursor');
    await rejects(listAll(async () => ({ tools: [{ name: 'x'.repeat(129) }] }), 'tools'), 'mcp_list_invalid_name', 'a 129-character name');
    await rejects(listAll(async () => ({ tools: [{ name: 'tab\there' }] }), 'tools'), 'mcp_list_invalid_name', 'a name with a control character');
    await rejects(listAll(async () => ({ notTools: [] }), 'tools'), 'mcp_list_invalid', 'a page without the list');
    assert.equal((await listAll(async () => ({ resources: [{ uri: 'file:///a' }, { uri: 'file:///b' }] }), 'resources')).items.length, 2, 'resources are told apart by uri');
    await rejects(listAll(async () => ({ resources: [{ uri: 'file:///a' }, { uri: 'file:///a' }] }), 'resources'), 'mcp_list_duplicate_name', 'two resources with one uri');
  });

  // -------------------------------------------------------------------------------------------------------------------------------------
  // 7. and 8. Calls
  // -------------------------------------------------------------------------------------------------------------------------------------
  await test('a hung call is cancelled at its timeout, reached the server exactly once and is not repeated', async () => {
    const counter = path.join(scratch, 'hung.txt');
    await manager.store.save('hung', fixture(['--counter', counter]));
    await manager.connect('hung');
    const started = Date.now();
    const error = await rejects(manager.callTool('hung', 'sleep', {}, { timeoutMs: 1500 }), 'mcp_call_timeout', 'the hung call');
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 1400 && elapsed < 6000, `it ended at its timeout (${elapsed} ms)`);
    assert.equal(error.executed, 'unknown');
    await waitFor(() => counterLines(counter).includes('cancelled sleep'), 'the server to see notifications/cancelled', 5000);
    await delay(1000);
    assert.deepEqual(counterLines(counter).filter((line) => line.startsWith('call')), ['call sleep'], 'one invocation, no replay');
    assert.equal(text(await manager.callTool('hung', 'echo', { message: 'still usable' })), 'echo: still usable', 'the connection is still usable');
    assert.deepEqual(counterLines(counter).filter((line) => line.startsWith('call')), ['call sleep', 'call echo']);
  });

  await test('a call whose answer is lost (the server dies) is reported, and not repeated after the reconnect', async () => {
    const counter = path.join(scratch, 'drop.txt');
    await manager.store.save('dropper', fixture(['--counter', counter]));
    await manager.connect('dropper');
    const error = await rejects(manager.callTool('dropper', 'drop', {}), 'mcp_connection_lost', 'the lost answer');
    assert.equal(error.executed, 'unknown');
    await waitFor(() => manager.status().servers.find((server) => server.id === 'dropper').state === 'lost', 'the state to say lost');
    assert.equal(text(await manager.callTool('dropper', 'echo', { message: 'after' })), 'echo: after', 'the next call reconnects');
    assert.deepEqual(counterLines(counter).filter((line) => line.startsWith('call')), ['call drop', 'call echo'], 'drop reached the server once');
  });

  await test('a result of an unknown resultType is treated as complete', async () => {
    await manager.store.save('future', raw('unknown-result'));
    const summary = await manager.connect('future');
    assert.equal(summary.protocolVersion, '2026-07-28');
    assert.equal(text(await manager.callTool('future', 'probe', {})), 'from a later revision');
    assert.equal(manager.status().servers.find((server) => server.id === 'future').unknownResultTypes, 1);
    assert.deepEqual(normalizeResultType({ id: 1, result: { resultType: 'complete', a: 1 } }), { id: 1, result: { resultType: 'complete', a: 1 } });
    assert.deepEqual(normalizeResultType({ id: 1, result: { resultType: 'input_required' } }).result.resultType, 'input_required', 'input_required is known');
    assert.deepEqual(normalizeResultType({ id: 1, result: { resultType: 'later' } }).result.resultType, 'complete');
    assert.deepEqual(normalizeResultType({ id: 1, error: { code: 1 } }), { id: 1, error: { code: 1 } });
  });

  // -------------------------------------------------------------------------------------------------------------------------------------
  // 9. Secrets
  // -------------------------------------------------------------------------------------------------------------------------------------
  await test('secrets never appear in status() nor in a log line, even when the server prints one', async () => {
    await manager.store.save('leaky', { ...fixture(['--stderr', 'my token is ${FIXTURE_TOKEN}']), env: { FIXTURE_TOKEN: { value: SECRET, secret: true }, OTHER_TOKEN: HEADER_SECRET } });
    await manager.connect('leaky');
    assert.equal(text(await manager.callTool('leaky', 'env_value', { name: 'FIXTURE_TOKEN' })), SECRET, 'the server did receive the secret');
    await waitFor(() => logLines.some((line) => line.includes('my token is')), 'the stderr line to be logged');
    const status = JSON.stringify(manager.status());
    assert.ok(!status.includes(SECRET) && !status.includes(HEADER_SECRET), 'status() holds no secret');
    for (const line of logLines) assert.ok(!line.includes(SECRET) && !line.includes(HEADER_SECRET), `a log line holds a secret: ${line.slice(0, 120)}`);
    assert.ok(logLines.some((line) => /my token is \[REDACTED\]/.test(line)), 'the line is logged with the secret masked');
    assert.ok(!/command|args|headers/.test(Object.keys(manager.status().servers[0]).join(',')), 'status() carries no command line');
  });

  // -------------------------------------------------------------------------------------------------------------------------------------
  // 10. Nothing left behind
  // -------------------------------------------------------------------------------------------------------------------------------------
  await test('close(): every server process has exited when it resolves, and later calls are refused', async () => {
    const fixtureWho = JSON.parse(text(await manager.callTool('fixture', 'whoami', {})));
    reported.set(fixtureWho.pid, fixtureWho.ppid);
    const running = await newDescendants(baseline);
    assert.ok(running.length >= 3, `servers were running before close (${running.length})`);
    await manager.close();
    const left = await newDescendants(baseline, reportedList());
    assert.deepEqual(left, [], `processes left after close(): ${left.join(', ')}`);
    await rejects(manager.connect('fixture'), 'mcp_closed', 'connect after close');
    await rejects(manager.callTool('fixture', 'echo', { message: 'x' }), 'mcp_closed', 'a call after close');
  });

  await test('HubManager.shutdown() of a Hub assembled the normal way closes its MCP servers and waits for them', async () => {
    const saved = process.env.CHATMCP_MCP_RUNTIME_DIR;
    process.env.CHATMCP_MCP_RUNTIME_DIR = runtimeRoot();
    try {
      hubManager = new HubManager({ bundleRoot: HUB, dataDirectory: path.join(scratch, 'hub-data'), log: () => {} });
      assembleStudio(hubManager, { bundleRoot: HUB });
    } finally { if (saved === undefined) delete process.env.CHATMCP_MCP_RUNTIME_DIR; else process.env.CHATMCP_MCP_RUNTIME_DIR = saved; }
    assert.ok(hubManager.mcp && hubManager.mcpOwned, 'assembleStudio gives the manager its MCP client manager');
    await hubManager.mcp.store.save('hubfixture', { ...fixture(), env: { FIXTURE_TOKEN: { value: SECRET, secret: true } } });
    await hubManager.mcp.connect('hubfixture');
    assert.ok(hubManager.secrets.includes(SECRET), 'the secret reached the Hub\'s masker (registerSecret)');
    const state = hubManager.state();
    assert.equal(state.mcp.runtime.state, 'ready');
    assert.equal(state.mcp.servers.find((server) => server.id === 'hubfixture').state, 'connected');
    assert.ok(!JSON.stringify(state).includes(SECRET), 'the Hub state holds no secret');
    const who = JSON.parse(text(await hubManager.mcp.callTool('hubfixture', 'whoami', {})));
    await hubManager.shutdown();
    const left = await newDescendants(baseline, [{ pid: who.pid, ppid: who.ppid }]);
    assert.deepEqual(left, [], `processes left after shutdown: ${left.join(', ')}`);
    hubManager = null;
  });
} finally {
  await manager?.close().catch(() => {});
  await hubManager?.shutdown().catch(() => {});
  const strays = await newDescendants(baseline, reportedList()).catch(() => []);
  for (const pid of strays) { try { process.kill(pid); } catch { /* gone */ } }
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
