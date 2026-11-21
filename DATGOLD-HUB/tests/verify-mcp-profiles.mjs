// The tool profiles of the Hub's MCP server (docs/MCP-SERVER.md "Tool profiles", roadmap P6 ext-19): what a client may call is decided by the
// scope of the token it presents, and a tool outside that scope is refused before it runs.
//
//   1. The table (lib/mcp/tool-profiles.mjs): three profiles, verify (the default), read and write, with the exact tools of each (11, 9, 18);
//      the annotations are the Hub's own definitions (local.* and studio.*), never restated; read and verify are read-only except verify's
//      three runners and every write tool says it is not; the plan names that do not exist map to real tools; verify_run, evidence_pack and
//      receipt_get are reserved and served by no profile; tasks_run in verify takes only the fixed check commands of test_run (the ones
//      test_discover finds); the check results carry an outputSchema. The table's own refusals: a read-only tool under write, a mutating
//      tool under read, a tool in two profiles, an unknown target or profile, an annotations override that differs from the definition.
//   2. Scope names: mixed case and spaces are normalised, unknown and empty scopes are refused; tool names stay exact.
//   3. A check's receipt (lib/verification-receipt.mjs): verify:<step>:<sha256>, which objectiveReceiptId accepts; an exit code never
//      makes a verified test outcome.
//   4. The token's scope (lib/mcp/server-token.mjs): a new token has verify; setScope writes it, load reads it, rotate keeps it; an ext-17
//      file (no scope) is verify; an unknown or empty scope in the file is no scope at all (fail closed).
//   5. The listener with the host (a primary HubManager assembled as hub.mjs does, the dashboard's server, startHubMcpServer, a real v2
//      client): tools/list per scope (exact counts); every write tool with a verify token is HTTP 403 insufficient_scope and the workspace
//      is unchanged, in both protocol eras; mixed-case names are no tool; tasks_run of a check returns a handle in under 5 s and
//      tasks_status completes it with a receipt; a command that is not a check is refused by the schema; the scope changes while a task
//      runs; an annotations mismatch refuses the call before the gate.
//   6. A real hub.mjs serves the profiles: verify by default, read opted in by the token's scope.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { HubManager } from '../lib/manager.mjs';
import { assembleStudio } from '../lib/assemble.mjs';
import { LocalTools } from '../lib/local-tools.mjs';
import { STUDIO_TOOLS } from '../lib/studio-tools.mjs';
import { objectiveReceiptId } from '../lib/objective-acceptance.mjs';
import { MCP_CHECK_EVIDENCE, mcpCheckReceipt } from '../lib/verification-receipt.mjs';
import { createHubServer } from '../hub.mjs';
import { loadMcpSdk } from '../lib/mcp/sdk.mjs';
import { startHubMcpServer } from '../lib/mcp/server.mjs';
import { DEFAULT_SCOPE, PROFILE_NAMES, normalizeScope, scopeOrNone } from '../lib/mcp/server-scope.mjs';
import { McpServerTokenStore } from '../lib/mcp/server-token.mjs';
import { MCP_SERVER_PORT_VARIABLE, MCP_SERVER_VARIABLE } from '../lib/mcp/server-setting.mjs';
import { McpHost } from '../lib/mcp/host.mjs';
import {
  CHECK_COMMANDS, PLAN_NAME_MAP, PROFILE_HOST_TOOLS, PROFILE_TABLE, RESERVED_VERIFY_TOOLS, buildToolProfiles, hubToolCatalog, mcpProfileProvider, profileOf,
} from '../lib/mcp/tool-profiles.mjs';
import { createProtector } from '../lib/secret-box.mjs';
import { HUB_ROOT, freePort, startHub, waitFor } from './e2e/hub-process.mjs';
import { RUNTIME_INSTALL, runtimeRoot } from './support/mcp-tools.mjs';

const runtime = runtimeRoot();
if (!runtime) {
  console.log(`CHATMCP_TEST_SKIP: the MCP SDK runtime is not installed (run: ${RUNTIME_INSTALL})`);
  process.exit(0);
}
const roots = [runtime];

let passed = 0;
let failures = 0;
async function test(name, body) {
  try { await body(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { failures += 1; console.error(`FAIL ${name}\n${error?.stack ?? error}`); }
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'chatmcp-mcp-profiles-'));
const folder = (name) => { const dir = path.join(scratch, name); fs.mkdirSync(dir, { recursive: true }); return dir; };
const fileProtector = (dir) => createProtector({ platform: 'linux', directory: dir, env: {} });
const clientSdk = await loadMcpSdk({ roots });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const textOf = (result) => (result?.content ?? []).map((part) => part.text ?? '').join('\n');
const codeOf = (result) => result?.structuredContent?.error?.code ?? null;
const sorted = (list) => [...list].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

const VERIFY = ['git_diff', 'git_status', 'studio_checks', 'studio_diff_check', 'studio_review', 'tasks_cancel', 'tasks_run', 'tasks_status', 'test_discover', 'test_results', 'test_run'];
const READ = ['code_symbols', 'find_definition', 'find_files', 'find_references', 'git_log', 'list_directory', 'read_file', 'repo_map', 'search_files'];
const WRITE = ['delete_path', 'edit_file', 'files_apply_patch', 'files_write_batch', 'format_document', 'git_add', 'git_branch', 'git_checkout', 'git_commit',
  'git_merge', 'knowledge_create', 'make_directory', 'move_path', 'organize_imports', 'rename_symbol', 'run_command', 'update_plan', 'write_file'];
const VERIFY_RUNNERS = ['tasks_cancel', 'tasks_run', 'test_run'];
/** One call per write tool with arguments its schema accepts, so that only the scope can stop it. */
const WRITE_CALLS = {
  delete_path: { path: 'notes.txt' }, edit_file: { path: 'notes.txt', old_string: 'alpha', new_string: 'gamma' },
  files_apply_patch: { path: 'notes.txt', old_text: 'alpha', new_text: 'gamma' }, files_write_batch: { files: [{ path: 'new.txt', content: 'x' }] },
  format_document: { path: 'notes.txt' }, git_add: { paths: ['.'] }, git_branch: { action: 'create', name: 'mcp' }, git_checkout: { ref: 'main', create: true },
  git_commit: { message: 'mcp' }, git_merge: { branch: 'main' }, knowledge_create: { title: 't', content: 'c' }, make_directory: { path: 'made' },
  move_path: { source: 'notes.txt', destination: 'moved.txt' }, organize_imports: { path: 'notes.txt' }, rename_symbol: { path: 'notes.txt', line: 1, character: 1, new_name: 'x' },
  run_command: { command: 'echo hacked > hacked.txt' }, update_plan: { items: [{ text: 'x', status: 'todo' }] }, write_file: { path: 'new.txt', content: 'x' },
};

/** Every file of a folder and its SHA-256 (the .git folder too): what "unchanged" means here. */
function snapshot(dir) {
  const out = {};
  const walk = (at) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) { out[`${path.relative(dir, full)}/`] = 'dir'; walk(full); } else out[path.relative(dir, full)] = createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

const JSON_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
const ENVELOPE = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'raw', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} };
/** A tools/call sent by hand, in the 2026-07-28 shape (modern) or the 2025 one (legacy, stateless: no initialize needed). */
async function rawCall(url, token, name, args, { era = 'modern' } = {}) {
  const body = era === 'modern'
    ? { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args, _meta: ENVELOPE } }
    : { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } };
  const headers = era === 'modern'
    ? { 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': name }
    : { 'mcp-protocol-version': '2025-06-18' };
  const response = await fetch(url, { method: 'POST', headers: { ...JSON_HEADERS, authorization: `Bearer ${token}`, ...headers }, body: JSON.stringify(body) });
  return { status: response.status, authenticate: response.headers.get('www-authenticate') ?? '', text: await response.text() };
}

/**
 * A primary HubManager on a fresh workspace (assembled as hub.mjs does), the dashboard's server on a free port with the host merged into its
 * state, the host with every profile tool (gate in Review, as hub.mjs makes it) and the listener (startHubMcpServer, port 0) with the profile
 * provider; the token's scope is set to `scope` before any client connects.
 */
async function setup({ scope = ['verify'], files = { 'notes.txt': 'alpha\nbeta\n' }, primaryBusy = () => false } = {}) {
  const root = folder(`case-${randomBytes(4).toString('hex')}`);
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  for (const [name, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(workspace, name)), { recursive: true }); fs.writeFileSync(path.join(workspace, name), text); }
  const logs = [];
  const primary = new HubManager({ bundleRoot: HUB_ROOT, dataDirectory: path.join(root, 'data'), log: (line) => logs.push(line) });
  await primary.load(workspace);
  assembleStudio(primary, { bundleRoot: HUB_ROOT });
  await primary.permissions.load();
  await primary.startLocal(workspace);
  const host = new McpHost({
    bundleRoot: HUB_ROOT, directory: path.join(primary.hubDirectory, 'mcp-host'), workspace: () => primary.workspace,
    primaryState: () => ({ busy: primaryBusy() }), hooks: primary.hooks, mcp: primary.mcp, pluginManager: primary.pluginManager, secrets: primary.secrets,
    scope: 'profiles', tools: PROFILE_HOST_TOOLS, log: (line) => logs.push(line),
  });
  primary.mcpHost = host;
  const port = await freePort();
  const secret = randomBytes(32).toString('hex');
  const server = createHubServer(primary, { port, secret, token: randomBytes(32).toString('hex') });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const mcpDirectory = folder(`mcp-${randomBytes(4).toString('hex')}`);
  const handle = await startHubMcpServer({
    env: { [MCP_SERVER_VARIABLE]: 'on', [MCP_SERVER_PORT_VARIABLE]: '0' }, directory: mcpDirectory, protector: fileProtector(mcpDirectory), roots,
    name: 'datgold-test', version: '0.0.1', dashboardPort: port, log: (line) => logs.push(line), ...mcpProfileProvider({ host, version: '0.0.1' }),
  });
  assert.equal(handle.status().state, 'listening', logs.join('\n'));
  await handle.setScope(scope);
  const token = await handle.tokens.reveal();
  const url = handle.status().url;
  const clients = [];
  return {
    root, workspace, primary, host, handle, logs, token, url, mcpDirectory,
    file: (name) => fs.readFileSync(path.join(workspace, name), 'utf8'),
    async client(name) {
      const client = new clientSdk.Client({ name, version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
      await client.connect(new clientSdk.StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
      clients.push(client);
      const callTool = client.callTool.bind(client);
      client.callTool = (...callArgs) => { const pending = callTool(...callArgs); pending.catch(() => {}); return pending; };
      return client;
    },
    /** Approves the first request the host's gates wait for, as the owner would in the dashboard. */
    async approveNext(timeoutMs = 10_000) {
      let found = null;
      await waitFor(() => { found = host.pendingApprovals()[0] ?? null; return found; }, { timeoutMs, intervalMs: 20, label: 'a pending approval of an MCP client' });
      assert.equal(host.decide(found.id, true) !== null, true);
      return found;
    },
    async close() {
      for (const client of clients) await client.close().catch(() => {});
      await handle.close();
      await host.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await primary.shutdown();
    },
  };
}

/** Polls tasks_status until the task has ended; returns its last result. */
async function untilEnded(client, taskId, timeoutMs = 60_000) {
  let last = null;
  await waitFor(async () => {
    last = await client.callTool({ name: 'tasks_status', arguments: { taskId } });
    return last.structuredContent?.status && last.structuredContent.status !== 'running' ? last : null;
  }, { timeoutMs, intervalMs: 150, label: `background task ${taskId} to end` });
  return last;
}

/** A workspace whose `node --test` passes (package.json without scripts.test: test_discover then says node --test). */
const NODE_TEST_FILES = (delayMs = 0) => ({
  'notes.txt': 'alpha\nbeta\n',
  'package.json': JSON.stringify({ name: 'fixture', private: true, type: 'module' }),
  'test/quick.test.mjs': `import test from 'node:test';\ntest('quick', async () => { await new Promise((r) => setTimeout(r, ${delayMs})); });\n`,
});

try {
  // ---------------------------------------------------------------------------------------------------------------------------------
  // 1. The table
  // ---------------------------------------------------------------------------------------------------------------------------------
  await test('three profiles; a new token\'s scope is verify alone', () => {
    assert.deepEqual([...PROFILE_NAMES], ['verify', 'read', 'write']);
    assert.deepEqual([...DEFAULT_SCOPE], ['verify']);
    assert.deepEqual(Object.keys(PROFILE_TABLE), ['verify', 'read', 'write']);
  });

  await test('the exact tools of each profile: verify 11, read 9, write 18, 38 in all, each tool in one profile only', () => {
    const profiles = buildToolProfiles();
    assert.deepEqual(sorted(profiles.byProfile.verify), VERIFY);
    assert.equal(profiles.byProfile.verify.length, 11);
    assert.deepEqual(sorted(profiles.byProfile.read), READ);
    assert.equal(profiles.byProfile.read.length, 9);
    assert.deepEqual(sorted(profiles.byProfile.write), WRITE);
    assert.equal(profiles.byProfile.write.length, 18);
    assert.equal(profiles.tools.size, 38);
    assert.equal(PROFILE_HOST_TOOLS.length, 38);
    assert.equal(new Set(PROFILE_HOST_TOOLS.map((tool) => tool.name)).size, 38, 'no name twice');
    for (const spec of PROFILE_HOST_TOOLS) assert.equal(profileOf(spec.name), spec.profile, spec.name);
    assert.equal(profileOf('hub_status'), null, 'the status tool belongs to no profile: every token may call it');
  });

  await test('the annotations and schemas are the Hub\'s own definitions (local.* and studio.*), not restated', () => {
    const local = new Map(new LocalTools({ workspace: { resolve: async () => { throw new Error('no workspace'); } } }).definitions().map((definition) => [definition.name, definition]));
    const studio = new Map(STUDIO_TOOLS.map((definition) => [definition.name, definition]));
    const catalog = hubToolCatalog();
    for (const spec of PROFILE_HOST_TOOLS) {
      const own = (spec.target.startsWith('studio.') ? studio : local).get(spec.target);
      assert.ok(own, `${spec.name} -> ${spec.target} is a real tool of the Hub`);
      assert.deepEqual(catalog.get(spec.target).annotations, own.annotations, spec.target);
      const definition = buildToolProfiles().tools.get(spec.name).definition;
      assert.deepEqual(definition.annotations, own.annotations, `${spec.name} advertises the annotations of ${spec.target}`);
      if (spec.name !== 'tasks_run') assert.deepEqual(definition.inputSchema, own.inputSchema, `${spec.name} keeps the input schema of ${spec.target}`);
    }
  });

  await test('read tools are read-only, verify tools too except its three runners, and every write tool says it is not read-only', () => {
    const profiles = buildToolProfiles();
    for (const name of [...READ, ...VERIFY]) {
      const { annotations } = profiles.tools.get(name).definition;
      if (VERIFY_RUNNERS.includes(name)) assert.equal(annotations.readOnlyHint, false, `${name} runs a check`);
      else assert.equal(annotations.readOnlyHint, true, name);
    }
    for (const name of WRITE) assert.equal(profiles.tools.get(name).definition.annotations.readOnlyHint, false, name);
    for (const name of WRITE) assert.equal(profiles.tools.get(name).write, true, `${name} takes the single-writer path`);
  });

  await test('plan names that are no tool map to real ones; verify_run, evidence_pack and receipt_get are reserved and served by no profile', () => {
    assert.equal(PLAN_NAME_MAP.checks_list, 'test_discover');
    assert.equal(PLAN_NAME_MAP.checks_run, 'tasks_run');
    assert.equal(PLAN_NAME_MAP['studio.checks'], 'studio_checks');
    assert.equal(PLAN_NAME_MAP['studio.diff_check'], 'studio_diff_check');
    assert.equal(PLAN_NAME_MAP['studio.review'], 'studio_review');
    for (const real of Object.values(PLAN_NAME_MAP)) assert.ok(profileOf(real), `${real} is in a profile`);
    assert.deepEqual([...RESERVED_VERIFY_TOOLS], ['verify_run', 'evidence_pack', 'receipt_get']);
    for (const name of RESERVED_VERIFY_TOOLS) assert.equal(profileOf(name), null, `${name} is not built yet`);
    for (const name of PROFILE_HOST_TOOLS.map((tool) => tool.name)) assert.match(name, /^[A-Za-z0-9_-]{1,64}$/, 'a name every client accepts (no dot)');
  });

  await test('tasks_run in verify takes only the fixed check commands of test_run; check results carry an outputSchema with a receipt', () => {
    assert.deepEqual([...CHECK_COMMANDS], ['npm test', 'node --test', 'python -m pytest', 'dotnet test']);
    const { definition } = buildToolProfiles().tools.get('tasks_run');
    assert.deepEqual(definition.inputSchema.properties.command.enum, [...CHECK_COMMANDS]);
    assert.equal(definition.inputSchema.additionalProperties, false);
    assert.deepEqual(definition.inputSchema.required, ['command']);
    for (const name of ['test_run', 'tasks_run', 'tasks_status']) {
      const schema = buildToolProfiles().tools.get(name).definition.outputSchema;
      assert.equal(schema?.type, 'object', name);
      if (name !== 'tasks_run') assert.equal(schema.properties.receipt.type, 'object', `${name} carries a receipt`);
    }
    for (const name of [...READ, ...WRITE, 'git_status', 'studio_checks']) assert.equal(buildToolProfiles().tools.get(name).definition.outputSchema, undefined, name);
  });

  await test('the fixed check commands are the ones test_discover finds in a project', async () => {
    const discover = async (files) => {
      const root = folder(`discover-${randomBytes(3).toString('hex')}`);
      for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(root, name), text);
      const tools = new LocalTools({ workspace: { resolve: async (relative = '') => ({ root, absolute: path.join(root, relative), relative }) } });
      const result = await tools.tools.get('test_discover').run({}, {});
      return result.structuredContent.commands.map((entry) => entry.command);
    };
    const found = new Set([
      ...await discover({ 'package.json': JSON.stringify({ scripts: { test: 'node x' } }) }),
      ...await discover({ 'package.json': '{}' }),
      ...await discover({ 'pyproject.toml': '' }),
      ...await discover({ 'app.sln': '' }),
    ]);
    assert.deepEqual(sorted(found), sorted(CHECK_COMMANDS));
  });

  await test('scope names: mixed case and spaces are normalised, canonical order, duplicates collapse; unknown, empty and non-list scopes are refused', () => {
    assert.deepEqual(normalizeScope(['Write', ' READ ', 'verify', 'read']), ['verify', 'read', 'write']);
    assert.deepEqual(normalizeScope(['VERIFY']), ['verify']);
    for (const [value, code] of [[['admin'], 'mcp_scope_unknown'], [['verify', 'root'], 'mcp_scope_unknown'], [[], 'mcp_scope_empty'], ['verify', 'mcp_scope_invalid'], [null, 'mcp_scope_invalid'], [[7], 'mcp_scope_invalid']]) {
      assert.throws(() => normalizeScope(value), (error) => error.code === code && error.statusCode === 400, JSON.stringify(value));
    }
    assert.deepEqual(scopeOrNone(['Read']), ['read']);
    assert.deepEqual(scopeOrNone(['admin']), [], 'fail closed: no profile at all');
    assert.deepEqual(scopeOrNone([]), []);
    assert.deepEqual(scopeOrNone(undefined), []);
  });

  await test('tool names are exact: READ_FILE, Edit_File and studio.checks belong to no profile', () => {
    for (const name of ['READ_FILE', 'Edit_File', 'Tasks_Run', 'studio.checks', ' read_file', 'read_file ']) assert.equal(profileOf(name), null, name);
  });

  await test('the table refuses a read-only tool under write, a mutating tool under read or verify, a tool twice, an unknown target or profile, and an annotations override', () => {
    const base = { verify: [{ name: 'git_status', target: 'local.git_status' }], read: [{ name: 'read_file', target: 'local.read_file' }], write: [{ name: 'edit_file', target: 'local.edit_file' }] };
    assert.equal(buildToolProfiles(base).tools.size, 3);
    assert.throws(() => buildToolProfiles({ ...base, write: [{ name: 'git_log', target: 'local.git_log' }] }), /read-only/, 'a read-only tool listed under write');
    assert.throws(() => buildToolProfiles({ ...base, read: [{ name: 'write_file', target: 'local.write_file' }] }), /not read-only/);
    assert.throws(() => buildToolProfiles({ ...base, verify: [{ name: 'run_command', target: 'local.run_command' }] }), /not read-only/, 'only a declared runner may be in verify');
    assert.throws(() => buildToolProfiles({ ...base, read: [{ name: 'git_status', target: 'local.git_status' }] }), /twice/, 'a tool in two profiles');
    assert.throws(() => buildToolProfiles({ ...base, read: [{ name: 'nope', target: 'local.no_such_tool' }] }), /no_such_tool/);
    assert.throws(() => buildToolProfiles({ ...base, admin: [] }), /profile/);
    assert.throws(() => buildToolProfiles({ verify: base.verify, read: base.read }), /profile/, 'all three profiles are declared');
    assert.throws(() => buildToolProfiles({ ...base, write: [{ name: 'edit_file', target: 'local.edit_file', annotations: { readOnlyHint: true } }] }), /annotations/);
    assert.throws(() => buildToolProfiles({ ...base, read: [{ name: 'READ.FILE', target: 'local.read_file' }] }), /name/);
  });

  // ---------------------------------------------------------------------------------------------------------------------------------
  // 2. Receipts
  // ---------------------------------------------------------------------------------------------------------------------------------
  await test('a check receipt is verify:<step>:<sha256>, accepted by objectiveReceiptId; another exit code is another digest; an exit code never verifies a test outcome', () => {
    const observed = { taskId: 'bg_1', status: 'completed', exitCode: 0 };
    const receipt = mcpCheckReceipt({ tool: 'tasks_status', client: 'claude-code', step: 3, observed, at: '2026-11-21T00:00:00.000Z' });
    assert.match(receipt.receiptId, /^verify:3:[a-f0-9]{64}$/);
    assert.equal(objectiveReceiptId({ kind: 'verify', step: 3, sha256: receipt.sha256 }), receipt.receiptId);
    assert.equal(receipt.kind, 'verify');
    assert.equal(receipt.commandSucceeded, true);
    assert.equal(receipt.testOutcomeVerified, false, 'an exit code alone never means a test suite passed');
    assert.equal(receipt.evidenceClassification, MCP_CHECK_EVIDENCE);
    assert.equal(MCP_CHECK_EVIDENCE, 'execution_observed_tests_unverified');
    assert.ok(Object.isFrozen(receipt));
    const failed = mcpCheckReceipt({ tool: 'tasks_status', client: 'claude-code', step: 3, observed: { ...observed, status: 'failed', exitCode: 1 }, at: '2026-11-21T00:00:00.000Z' });
    assert.notEqual(failed.sha256, receipt.sha256);
    assert.equal(failed.commandSucceeded, false);
    assert.equal(mcpCheckReceipt({ tool: 'test_run', client: null, step: 4, observed: { exitCode: 0, timedOut: true }, at: 'x' }).commandSucceeded, false, 'a timeout is no success');
    assert.equal(mcpCheckReceipt({ tool: 'test_run', client: null, step: 4, observed: { exitCode: 0, cancelled: true }, at: 'x' }).commandSucceeded, false);
    assert.throws(() => mcpCheckReceipt({ tool: 'tasks_status', client: null, step: -1, observed, at: 'x' }), /step/);
    assert.throws(() => mcpCheckReceipt({ tool: 'tasks_status', client: null, step: 1, observed: null, at: 'x' }), /observed/);
  });

  // ---------------------------------------------------------------------------------------------------------------------------------
  // 3. The token's scope
  // ---------------------------------------------------------------------------------------------------------------------------------
  await test('a new token has the verify scope; setScope writes it, load reads it, rotate keeps it', async () => {
    const dir = folder('token-scope');
    const store = new McpServerTokenStore({ directory: dir, protector: fileProtector(dir) });
    await store.load();
    await store.ensure();
    assert.deepEqual(store.scope(), ['verify']);
    assert.deepEqual(await store.setScope(['Read', 'verify']), ['verify', 'read']);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'mcp-server-token.json'), 'utf8')).scope, ['verify', 'read']);
    const again = new McpServerTokenStore({ directory: dir, protector: fileProtector(dir) });
    await again.load();
    assert.deepEqual(again.scope(), ['verify', 'read']);
    const token = await again.rotate();
    assert.ok(again.verify(token));
    assert.deepEqual(again.scope(), ['verify', 'read'], 'a new token keeps the owner\'s scope');
    assert.ok(Object.isFrozen(again.scope()));
  });

  await test('an ext-17 token file (no scope) is the verify scope; an unknown or empty scope in the file is no scope at all, and says so', async () => {
    const dir = folder('token-legacy');
    const store = new McpServerTokenStore({ directory: dir, protector: fileProtector(dir) });
    await store.load();
    await store.ensure();
    const file = path.join(dir, 'mcp-server-token.json');
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete record.scope;
    fs.writeFileSync(file, JSON.stringify(record));
    const legacy = new McpServerTokenStore({ directory: dir, protector: fileProtector(dir) });
    await legacy.load();
    assert.deepEqual(legacy.scope(), ['verify']);
    for (const bad of [['admin'], [], 'write', ['write', 42]]) {
      fs.writeFileSync(file, JSON.stringify({ ...record, scope: bad }));
      const lines = [];
      const damaged = new McpServerTokenStore({ directory: dir, protector: fileProtector(dir), log: (line) => lines.push(line) });
      await damaged.load();
      assert.deepEqual(damaged.scope(), [], JSON.stringify(bad));
      assert.equal(damaged.status().configured, true, 'the token itself still works');
      assert.match(lines.join('\n'), /scope/);
    }
  });

  await test('setScope refuses an unknown, empty or non-list scope and changes nothing; without a token it refuses', async () => {
    const dir = folder('token-refuse');
    const store = new McpServerTokenStore({ directory: dir, protector: fileProtector(dir) });
    await store.load();
    await assert.rejects(store.setScope(['read']), (error) => error.code === 'mcp_server_no_token');
    await store.ensure();
    const before = fs.readFileSync(path.join(dir, 'mcp-server-token.json'), 'utf8');
    for (const bad of [['admin'], [], 'read', null]) await assert.rejects(store.setScope(bad), (error) => error.statusCode === 400, JSON.stringify(bad));
    assert.equal(fs.readFileSync(path.join(dir, 'mcp-server-token.json'), 'utf8'), before);
    assert.deepEqual(store.scope(), ['verify']);
  });

  // ---------------------------------------------------------------------------------------------------------------------------------
  // 4. The listener with the host
  // ---------------------------------------------------------------------------------------------------------------------------------
  await test('tools/list per scope is exactly hub_status and the profiles\' tools (12, 10, 19, 39), with the definitions\' annotations; a change applies from the next request', async () => {
    const env = await setup({ scope: ['verify'] });
    try {
      const client = await env.client('lister');
      const catalog = hubToolCatalog();
      for (const [scope, names] of [[['verify'], VERIFY], [['read'], READ], [['write'], WRITE], [['verify', 'read'], [...VERIFY, ...READ]], [['verify', 'read', 'write'], [...VERIFY, ...READ, ...WRITE]]]) {
        await env.handle.setScope(scope);
        const { tools } = await client.listTools();
        assert.deepEqual(tools.map((tool) => tool.name), sorted(['hub_status', ...names]), scope.join('+'));
        assert.equal(tools.length, names.length + 1);
        for (const tool of tools.filter((entry) => entry.name !== 'hub_status')) {
          const spec = PROFILE_HOST_TOOLS.find((entry) => entry.name === tool.name);
          assert.deepEqual(tool.annotations, catalog.get(spec.target).annotations, tool.name);
        }
        const status = JSON.parse(textOf(await client.callTool({ name: 'hub_status', arguments: {} })));
        assert.deepEqual(status.scope, scope);
        assert.deepEqual(status.workspaceTools, sorted(names));
      }
      const { tools } = await client.listTools();
      assert.equal(tools.find((tool) => tool.name === 'tasks_status').outputSchema?.type, 'object', 'the outputSchema reaches the client');
      assert.equal(env.host.state().clients.length, 0, 'listing makes no manager');
    } finally { await env.close(); }
  });

  await test('an empty scope (a damaged scope in the token file) lists hub_status alone, and hub_status says so', async () => {
    const env = await setup({ scope: ['verify'] });
    try {
      const file = path.join(env.mcpDirectory, 'mcp-server-token.json');
      fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), scope: [] }));
      await env.handle.tokens.load();
      const client = await env.client('empty');
      assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ['hub_status']);
      const status = JSON.parse(textOf(await client.callTool({ name: 'hub_status', arguments: {} })));
      assert.deepEqual(status.scope, []);
      assert.deepEqual(status.workspaceTools, []);
      const refused = await rawCall(env.url, env.token, 'git_status', {});
      assert.equal(refused.status, 403);
      assert.match(refused.authenticate, /insufficient_scope/);
    } finally { await env.close(); }
  });

  await test('a verify token reaches no write tool: each of the 18 answers HTTP 403 insufficient_scope (scope "write") in both eras, and the workspace is byte-for-byte unchanged', async () => {
    const env = await setup({ scope: ['verify'] });
    try {
      const before = snapshot(env.workspace);
      for (const name of WRITE) {
        for (const era of ['modern', 'legacy']) {
          const answer = await rawCall(env.url, env.token, name, WRITE_CALLS[name], { era });
          assert.equal(answer.status, 403, `${name} (${era}): ${answer.text.slice(0, 300)}`);
          assert.match(answer.authenticate, /error="insufficient_scope"/, `${name} (${era})`);
          assert.match(answer.authenticate, /scope="write"/, `${name} (${era})`);
        }
      }
      const client = await env.client('verifier');
      await assert.rejects(client.callTool({ name: 'edit_file', arguments: WRITE_CALLS.edit_file }), 'the SDK client sees the refusal');
      await sleep(100);
      assert.deepEqual(snapshot(env.workspace), before, 'nothing in the workspace changed');
      assert.equal(env.file('notes.txt'), 'alpha\nbeta\n');
      assert.equal(env.host.pendingApprovals().length, 0, 'the owner was asked nothing');
      assert.equal(env.host.state().clients.length, 0, 'no manager was made: nothing ran');
    } finally { await env.close(); }
  });

  await test('mixed-case names are no tool: EDIT_FILE and Read_File are refused as unknown before anything runs', async () => {
    const env = await setup({ scope: ['verify', 'read', 'write'] });
    try {
      const before = snapshot(env.workspace);
      for (const name of ['EDIT_FILE', 'Edit_File', 'Read_File']) {
        const answer = await rawCall(env.url, env.token, name, name.toLowerCase() === 'edit_file' ? WRITE_CALLS.edit_file : { path: 'notes.txt' });
        assert.doesNotMatch(answer.text, /alpha|gamma/, `${name} read or wrote nothing`);
        assert.match(answer.text, /not found|unknown/i, name);
      }
      assert.deepEqual(snapshot(env.workspace), before);
      assert.equal(env.host.state().clients.length, 0);
    } finally { await env.close(); }
  });

  await test('a verify token gets 403 insufficient_scope (scope "read") for read_file; verify+read reads it; read alone cannot run a check', async () => {
    const env = await setup({ scope: ['verify'] });
    try {
      const refused = await rawCall(env.url, env.token, 'read_file', { path: 'notes.txt' });
      assert.equal(refused.status, 403);
      assert.match(refused.authenticate, /scope="read"/);
      assert.doesNotMatch(refused.text, /alpha/);
      await env.handle.setScope(['verify', 'read']);
      const client = await env.client('reader');
      const read = await client.callTool({ name: 'read_file', arguments: { path: 'notes.txt' } });
      assert.notEqual(read.isError, true, textOf(read));
      assert.match(textOf(read), /alpha/);
      await env.handle.setScope(['read']);
      const status = await rawCall(env.url, env.token, 'git_status', {});
      assert.equal(status.status, 403);
      assert.match(status.authenticate, /scope="verify"/);
      assert.equal(env.host.gate('reader').mode, 'review', 'the profiles host asks the owner for what is not a read');
      assert.throws(() => env.host.gate('reader').configure({ mode: 'autonomous' }), (error) => error.code === 'mcp_host_mode_refused');
    } finally { await env.close(); }
  });

  await test('checks_run: tasks_run of a check returns a handle in under 5 s once the owner approves, and tasks_status completes it with a receipt', async () => {
    const env = await setup({ scope: ['verify'], files: NODE_TEST_FILES(0) });
    try {
      const client = await env.client('checker');
      const discovered = await client.callTool({ name: 'test_discover', arguments: {} });
      assert.deepEqual(discovered.structuredContent.commands.map((entry) => entry.command), ['node --test']);
      const started = performance.now();
      const pending = client.callTool({ name: 'tasks_run', arguments: { command: 'node --test', description: 'the project tests' } });
      const asked = await env.approveNext();
      assert.equal(asked.toolName, 'local.tasks_run');
      assert.equal(asked.tag, 'mcp:checker');
      const handle = await pending;
      const elapsed = performance.now() - started;
      assert.notEqual(handle.isError, true, textOf(handle));
      assert.match(handle.structuredContent.taskId, /^bg_/);
      assert.equal(handle.structuredContent.status, 'running');
      assert.ok(elapsed < 5000, `the handle came after ${Math.round(elapsed)} ms`);
      const done = await untilEnded(client, handle.structuredContent.taskId);
      assert.equal(done.structuredContent.status, 'completed', textOf(done));
      assert.equal(done.structuredContent.exitCode, 0);
      const { receipt } = done.structuredContent;
      assert.match(receipt.receiptId, /^verify:\d+:[a-f0-9]{64}$/);
      assert.equal(receipt.tool, 'tasks_status');
      assert.equal(receipt.client, 'checker');
      assert.equal(receipt.commandSucceeded, true);
      assert.equal(receipt.testOutcomeVerified, false);
      const results = await client.callTool({ name: 'test_results', arguments: {} });
      assert.notEqual(results.isError, true);
      console.log(`  handle in ${Math.round(elapsed)} ms (approval included)`);
    } finally { await env.close(); }
  });

  await test('tasks_run refuses a command that is no check (echo, rm, a check with more after it) by its schema: nothing is asked, nothing runs', async () => {
    const env = await setup({ scope: ['verify'], files: NODE_TEST_FILES(0) });
    try {
      const before = snapshot(env.workspace);
      const client = await env.client('sneaky');
      for (const command of ['echo hacked > hacked.txt', 'rm -rf test', 'node --test && echo hacked > hacked.txt', 'NODE --TEST']) {
        const result = await client.callTool({ name: 'tasks_run', arguments: { command } });
        assert.equal(result.isError, true, command);
        assert.match(textOf(result), /command|enum|Invalid/i, command);
      }
      await sleep(200);
      assert.equal(env.host.pendingApprovals().length, 0);
      assert.deepEqual(snapshot(env.workspace), before);
    } finally { await env.close(); }
  });

  await test('the scope changes while a task runs: the next write is 403 and nothing changes, the task still completes; a write awaiting the owner when write is withdrawn is refused after the answer; without verify, tasks_status is 403', async () => {
    const env = await setup({ scope: ['verify', 'write'], files: NODE_TEST_FILES(2500) });
    try {
      const client = await env.client('changer');
      const pending = client.callTool({ name: 'tasks_run', arguments: { command: 'node --test' } });
      await env.approveNext();
      const handle = await pending;
      assert.equal(handle.structuredContent.status, 'running', textOf(handle));
      // A write that waits for the owner while the owner takes write away: refused when the answer comes, the file untouched.
      const edit = client.callTool({ name: 'edit_file', arguments: WRITE_CALLS.edit_file });
      let question = null;
      await waitFor(() => { question = env.host.pendingApprovals().find((item) => item.toolName === 'local.edit_file') ?? null; return question; }, { timeoutMs: 10_000, intervalMs: 20, label: 'the edit question' });
      await env.handle.setScope(['verify']);
      env.host.decide(question.id, true);
      const edited = await edit;
      assert.equal(edited.isError, true);
      assert.equal(codeOf(edited), 'mcp_scope_refused', textOf(edited));
      assert.equal(env.file('notes.txt'), 'alpha\nbeta\n');
      // The next write is refused by the scope before it runs.
      const next = await rawCall(env.url, env.token, 'write_file', WRITE_CALLS.write_file);
      assert.equal(next.status, 403);
      assert.equal(fs.existsSync(path.join(env.workspace, 'new.txt')), false);
      // The task the client started before keeps running and completes.
      const done = await untilEnded(client, handle.structuredContent.taskId);
      assert.equal(done.structuredContent.status, 'completed', textOf(done));
      // Without verify, the status of that task is out of reach.
      await env.handle.setScope(['read']);
      const status = await rawCall(env.url, env.token, 'tasks_status', { taskId: handle.structuredContent.taskId });
      assert.equal(status.status, 403);
      assert.match(status.authenticate, /scope="verify"/);
    } finally { await env.close(); }
  });

  await test('an annotations mismatch between what tools/list said and the live definition refuses the call before the gate is asked', async () => {
    const env = await setup({ scope: ['verify'] });
    try {
      const client = await env.client('drift');
      const first = await client.callTool({ name: 'git_status', arguments: {} });
      assert.notEqual(codeOf(first), 'mcp_annotations_mismatch', textOf(first));
      const live = env.host.managerOf('drift').catalog.tools.find((tool) => tool.name === 'local.git_status');
      live.annotations = { ...live.annotations, readOnlyHint: false, destructiveHint: true };
      const historyBefore = env.host.gate('drift').state().recent.length;
      const drifted = await client.callTool({ name: 'git_status', arguments: {} });
      assert.equal(drifted.isError, true);
      assert.equal(codeOf(drifted), 'mcp_annotations_mismatch', textOf(drifted));
      assert.equal(drifted.structuredContent.executed, false);
      assert.equal(env.host.gate('drift').state().recent.length, historyBefore, 'the gate was not asked');
      assert.equal(env.host.pendingApprovals().length, 0);
    } finally { await env.close(); }
  });

  // ---------------------------------------------------------------------------------------------------------------------------------
  // 5. A real hub.mjs
  // ---------------------------------------------------------------------------------------------------------------------------------
  await test('hub.mjs serves the profiles: verify by default; a token whose scope opts read in reads a file, and still cannot write', async () => {
    const port = await freePort();
    const scratchDir = folder('e2e-profiles');
    const project = path.join(scratchDir, 'project');
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, 'hello.txt'), 'hello from the workspace\n');
    const env = { [MCP_SERVER_VARIABLE]: 'on', [MCP_SERVER_PORT_VARIABLE]: String(port), CHATMCP_MCP_RUNTIME_DIR: runtime };
    const stateDir = path.join(scratchDir, 'state');
    let hub = await startHub({ scratch: scratchDir, stateDir, project, env });
    let token;
    try {
      await waitFor(() => hub.logText().includes(`MCP server: listening on http://127.0.0.1:${port}/mcp`), { timeoutMs: 20_000, label: 'the MCP listener' });
      const tokens = new McpServerTokenStore({ directory: hub.stateDir, protector: createProtector({ bundleRoot: HUB_ROOT, directory: hub.stateDir }) });
      await tokens.load();
      token = await tokens.reveal();
      assert.deepEqual(tokens.scope(), ['verify'], 'the Hub made its token with the verify scope');
      const client = new clientSdk.Client({ name: 'verify-ext19', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
      await client.connect(new clientSdk.StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
      try {
        assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), sorted(['hub_status', ...VERIFY]));
        const status = JSON.parse(textOf(await client.callTool({ name: 'hub_status', arguments: {} })));
        assert.deepEqual(status.scope, ['verify']);
        assert.equal(status.mcpServer, 'ext-19 profiles');
        const diff = await client.callTool({ name: 'git_status', arguments: {} });
        assert.equal(codeOf(diff) === 'unknown_tool', false, textOf(diff));
      } finally { await client.close(); }
      // The owner opts read in for this token (the connection kit of ext-20 will offer the switch): the store writes the file, and the Hub
      // reads it at its next start.
      await tokens.setScope(['verify', 'read']);
    } finally { await hub.stop(); }
    hub = await startHub({ scratch: scratchDir, stateDir, project, env, logName: 'hub-2.log' });
    try {
      await waitFor(() => hub.logText().includes(`MCP server: listening on http://127.0.0.1:${port}/mcp`), { timeoutMs: 20_000, label: 'the MCP listener' });
      const client = new clientSdk.Client({ name: 'verify-ext19', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
      await client.connect(new clientSdk.StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
      try {
        assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), sorted(['hub_status', ...VERIFY, ...READ]));
        const read = await client.callTool({ name: 'read_file', arguments: { path: 'hello.txt' } });
        assert.notEqual(read.isError, true, textOf(read));
        assert.match(textOf(read), /hello from the workspace/);
      } finally { await client.close(); }
      const write = await rawCall(`http://127.0.0.1:${port}/mcp`, token, 'write_file', { path: 'hello.txt', content: 'changed' });
      assert.equal(write.status, 403);
      assert.equal(fs.readFileSync(path.join(project, 'hello.txt'), 'utf8'), 'hello from the workspace\n');
      assert.ok(!hub.logText().includes(token), 'the Hub never logs the token');
    } finally { await hub.stop(); }
  });
} finally {
  await sleep(50);
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
