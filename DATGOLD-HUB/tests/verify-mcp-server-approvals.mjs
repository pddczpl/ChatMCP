// The Hub's MCP server for local clients, its HOST (docs/MCP-SERVER.md "The host", roadmap P6 ext-18): a client's tools/call goes through
// the Hub's own permission gate, the owner's hooks and the external-tool policy, on a HubManager of its own, under a task of its own (a
// synthetic UUID per client and workspace, the same at every start), never under the primary agent's task; its approvals are tagged
// mcp:<client>.
//
//   1. Write scope (Review): edit_file over MCP is a pending approval in /api/state within 1 s, tagged mcp:<client> (taskId, source,
//      client); POST /api/studio/permissions/decide approves it and the file changes; a denial leaves the file as it was.
//   2. No decision: an isError `approval_timeout` result when the host's approval timeout (2 s here; 90 s by default) runs out.
//   3. Single writer: a write while the primary agent holds its task, or while the workspace lock file is held, is `workspace_busy`
//      before anyone is asked, and a read still runs; an approval given after the primary agent started is `workspace_busy` too; a
//      second write while one waits for its approval is `workspace_busy`.
//   4. The host's gate refuses autonomous and full-access (configure and a direct assignment); the read scope is Read Only and stays so.
//   5. The primary agent's task, the lock file, its checkpoints, its plan and its permission history are untouched; the host's
//      checkpoint is in the host's own folder.
//   6. The owner's hooks (a PreToolUse veto) and the external-tool policy (`deny`, `allow`) apply to a client's call.
//   7. A real hub.mjs with the switch on: the client lists hub_status and read_file, and reads a workspace file through the host.
// Every listener binds port 0 or a port freePort() just found: never 3007 (the owner's Hub) and never a fixed 3008.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { HubManager } from '../lib/manager.mjs';
import { assembleStudio } from '../lib/assemble.mjs';
import { createHubServer } from '../hub.mjs';
import { loadMcpSdk } from '../lib/mcp/sdk.mjs';
import { startHubMcpServer } from '../lib/mcp/server.mjs';
import { McpServerTokenStore } from '../lib/mcp/server-token.mjs';
import { MCP_SERVER_PORT_VARIABLE, MCP_SERVER_VARIABLE } from '../lib/mcp/server-setting.mjs';
import { DEFAULT_APPROVAL_TIMEOUT_MS, HUB_HOST_TOOLS, MAX_CLIENTS, McpHost, clientIdOf, hostTaskId, mcpHostProvider } from '../lib/mcp/host.mjs';
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

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'chatmcp-mcp-host-'));
const folder = (name) => { const dir = path.join(scratch, name); fs.mkdirSync(dir, { recursive: true }); return dir; };
const fileProtector = (dir) => createProtector({ platform: 'linux', directory: dir, env: {} });
const clientSdk = await loadMcpSdk({ roots });
const READ = Object.freeze({ name: 'read_file', target: 'local.read_file' });
const EDIT = Object.freeze({ name: 'edit_file', target: 'local.edit_file' });
const PLAN = Object.freeze({ name: 'update_plan', target: 'local.update_plan' });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const textOf = (result) => (result?.content ?? []).map((part) => part.text ?? '').join('\n');
const codeOf = (result) => result?.structuredContent?.error?.code ?? null;

/**
 * A primary HubManager on a fresh workspace (assembled as hub.mjs does), the dashboard's server (createHubServer) on a free port with the
 * host merged into its state and decide route, and the MCP listener (startHubMcpServer) on port 0 with the host's provider.
 */
async function setup({ scope = 'write', timeout, tools = [READ, EDIT], hooks = null, mcp = null, files = { 'notes.txt': 'alpha\nbeta\n' } } = {}) {
  const root = folder(`case-${randomBytes(4).toString('hex')}`);
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(workspace, name), text);
  const logs = [];
  const primary = new HubManager({ bundleRoot: HUB_ROOT, dataDirectory: path.join(root, 'data'), log: (line) => logs.push(line) });
  await primary.load(workspace);
  if (hooks) primary.hooks = hooks;
  assembleStudio(primary, { bundleRoot: HUB_ROOT });
  await primary.permissions.load();
  await primary.startLocal(workspace);
  const host = new McpHost({
    bundleRoot: HUB_ROOT, directory: path.join(primary.hubDirectory, 'mcp-host'), workspace: () => primary.workspace,
    primaryState: () => ({ busy: primary.taskId !== null, taskId: primary.taskId }),
    hooks: primary.hooks, mcp: mcp ?? primary.mcp, pluginManager: primary.pluginManager, secrets: primary.secrets,
    scope, tools, ...(timeout ? { timeout } : {}), log: (line) => logs.push(line),
  });
  primary.mcpHost = host;
  const port = await freePort();
  const secret = randomBytes(32).toString('hex');
  const csrf = randomBytes(32).toString('hex');
  const server = createHubServer(primary, { port, secret, token: csrf });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${port}`;
  const mcpDirectory = folder(`mcp-${randomBytes(4).toString('hex')}`);
  const handle = await startHubMcpServer({
    env: { [MCP_SERVER_VARIABLE]: 'on', [MCP_SERVER_PORT_VARIABLE]: '0' }, directory: mcpDirectory, protector: fileProtector(mcpDirectory), roots,
    name: 'datgold-test', version: '0.0.1', dashboardPort: port, log: (line) => logs.push(line), ...mcpHostProvider({ host, version: '0.0.1' }),
  });
  assert.equal(handle.status().state, 'listening', logs.join('\n'));
  const token = await handle.tokens.reveal();
  const clients = [];
  return {
    root, workspace, primary, host, logs, origin,
    file: (name) => fs.readFileSync(path.join(workspace, name), 'utf8'),
    async client(name) {
      const client = new clientSdk.Client({ name, version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
      await client.connect(new clientSdk.StreamableHTTPClientTransport(new URL(handle.status().url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
      clients.push(client);
      return client;
    },
    async pending() {
      const response = await fetch(`${origin}/api/state`, { headers: { authorization: `Bearer ${secret}` } });
      assert.equal(response.status, 200);
      return (await response.json()).studio.permissions.pending;
    },
    async decide(id, approved) {
      const response = await fetch(`${origin}/api/studio/permissions/decide`, {
        method: 'POST', body: JSON.stringify({ id, approved }),
        headers: { authorization: `Bearer ${secret}`, origin, 'content-type': 'application/json', 'x-chatmcp-request': 'local-dashboard', 'x-chatmcp-csrf': csrf },
      });
      return { status: response.status, body: await response.json() };
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

/** Polls /api/state until a pending approval tagged `tag` (mcp:<client>) is there; returns it and how long it took from `since`. */
async function pendingOf(env, tag, since, timeoutMs = 10_000) {
  let found = null;
  await waitFor(async () => { found = (await env.pending()).find((item) => item.tag === tag) ?? null; return found; }, { timeoutMs, intervalMs: 25, label: `a pending approval tagged ${tag}` });
  return { item: found, ms: performance.now() - since };
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

try {
  // ---------------------------------------------------------------------------------------------------------------------------------
  // 0. The names, the defaults, the tools
  // ---------------------------------------------------------------------------------------------------------------------------------
  await test('a client id is the client\'s own name, cleaned and bounded; no name is "client"; the task id is a UUID per workspace and client; the defaults', () => {
    assert.equal(clientIdOf({ name: 'Claude Code', version: '2' }), 'claude-code');
    assert.equal(clientIdOf({ name: '../../etc/passwd' }), 'etc-passwd');
    assert.equal(clientIdOf({ name: 'x'.repeat(200) }).length, 64);
    assert.equal(clientIdOf({ name: '\u0000‮' }), 'client');
    assert.equal(clientIdOf(null), 'client');
    assert.equal(clientIdOf({ name: 42 }), 'client');
    const id = hostTaskId('C:\\work\\one', 'claude-code');
    assert.match(id, UUID, 'a task id the plan, the checkpoints and the workflow accept (they need a UUID; a colon is a stream on NTFS)');
    assert.equal(hostTaskId('C:\\work\\one', 'claude-code'), id, 'the same at every start');
    assert.notEqual(hostTaskId('C:\\work\\one', 'codex'), id);
    assert.notEqual(hostTaskId('C:\\work\\two', 'claude-code'), id);
    assert.equal(DEFAULT_APPROVAL_TIMEOUT_MS, 90_000);
    assert.equal(MAX_CLIENTS, 8);
    assert.deepEqual(HUB_HOST_TOOLS.map((tool) => tool.name), ['read_file'], 'the Hub itself exposes one read tool through the host in ext-18');
  });

  await test('the host refuses a scope it does not know, a tool name twice and a target that is not a local or an external tool', () => {
    const base = { bundleRoot: HUB_ROOT, directory: folder('bad-options'), workspace: () => null, primaryState: () => ({ busy: false }) };
    assert.throws(() => new McpHost({ ...base, scope: 'admin', tools: [READ] }), /scope/);
    assert.throws(() => new McpHost({ ...base, scope: 'read', tools: [READ, READ] }), /twice/);
    assert.throws(() => new McpHost({ ...base, scope: 'read', tools: [{ name: 'tree', target: 'studio.tree' }] }), /target/);
    assert.throws(() => new McpHost({ ...base, scope: 'read', tools: [{ name: 'nope', target: 'local.no_such_tool' }] }), /no_such_tool/);
    assert.throws(() => new McpHost({ ...base, scope: 'read', tools: [{ name: 'ext', target: 'srv.tool' }] }), /inputSchema/);
  });

  await test('tools/list: the host tools carry the local tool\'s schema and annotations, beside hub_status', async () => {
    const env = await setup({ tools: [READ, EDIT] });
    try {
      const client = await env.client('lister');
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((tool) => tool.name), ['edit_file', 'hub_status', 'read_file']);
      const read = tools.find((tool) => tool.name === 'read_file');
      assert.deepEqual(read.inputSchema.required, ['path']);
      assert.equal(read.annotations.readOnlyHint, true);
      const edit = tools.find((tool) => tool.name === 'edit_file');
      assert.equal(edit.annotations.readOnlyHint, false);
      assert.ok(edit.inputSchema.properties.old_string, 'the schema of local.edit_file');
      assert.equal(env.host.state().clients.length, 0, 'listing makes no manager');
    } finally { await env.close(); }
  });

  // ---------------------------------------------------------------------------------------------------------------------------------
  // 1. Write scope: the approval in the dashboard
  // ---------------------------------------------------------------------------------------------------------------------------------
  await test('write scope: edit_file is a pending approval tagged mcp:<client> in /api/state within 1 s; decide approves it and the file changes', async () => {
    const env = await setup({ scope: 'write' });
    try {
      const client = await env.client('Claude Code');
      // The first call of a client makes its manager (assembleStudio + startLocal); a read runs at once in Review.
      const firstStarted = performance.now();
      const read = await client.callTool({ name: 'read_file', arguments: { path: 'notes.txt' } });
      const firstMs = performance.now() - firstStarted;
      assert.notEqual(read.isError, true, textOf(read));
      assert.match(textOf(read), /alpha/);
      console.log(`  first call of a client (makes its manager): ${Math.round(firstMs)} ms`);
      const started = performance.now();
      const call = client.callTool({ name: 'edit_file', arguments: { path: 'notes.txt', old_string: 'alpha', new_string: 'gamma' } });
      const { item, ms } = await pendingOf(env, 'mcp:claude-code', started);
      console.log(`  pending approval in /api/state after ${Math.round(ms)} ms`);
      assert.ok(ms < 1000, `the approval reached /api/state in ${Math.round(ms)} ms, not within 1 s`);
      assert.equal(item.source, 'mcp');
      assert.equal(item.client, 'claude-code');
      assert.equal(item.tag, 'mcp:claude-code');
      assert.equal(item.taskId, hostTaskId(env.workspace, 'claude-code'), 'the client\'s own task, not the primary agent\'s');
      assert.equal(item.toolName, 'local.edit_file');
      assert.equal(item.category, 'workspace_edit');
      assert.equal(item.detail.path, 'notes.txt');
      assert.ok(Date.parse(item.expiresAt) - Date.parse(item.at) === DEFAULT_APPROVAL_TIMEOUT_MS, 'the host gate waits 90 s by default');
      assert.equal(env.file('notes.txt'), 'alpha\nbeta\n', 'nothing is written before the answer');
      const answer = await env.decide(item.id, true);
      assert.equal(answer.status, 200, JSON.stringify(answer.body));
      assert.deepEqual(answer.body, { ok: true, id: item.id, approved: true });
      const result = await call;
      assert.notEqual(result.isError, true, textOf(result));
      assert.equal(env.file('notes.txt'), 'gamma\nbeta\n');
      assert.deepEqual(await env.pending(), []);
      assert.equal((await env.decide(item.id, true)).status, 404, 'an answered request is gone');
    } finally { await env.close(); }
  });

  await test('write scope: a denial in the dashboard is a permission_denied result and the file stays as it was', async () => {
    const env = await setup({ scope: 'write' });
    try {
      const client = await env.client('codex');
      const call = client.callTool({ name: 'edit_file', arguments: { path: 'notes.txt', old_string: 'alpha', new_string: 'gamma' } });
      const { item } = await pendingOf(env, 'mcp:codex', performance.now());
      assert.equal((await env.decide(item.id, false)).status, 200);
      const result = await call;
      assert.equal(result.isError, true);
      assert.equal(codeOf(result), 'permission_denied', textOf(result));
      assert.equal(env.file('notes.txt'), 'alpha\nbeta\n');
    } finally { await env.close(); }
  });

  await test('two clients get two tasks: each approval carries its own tag, and the decide route reaches each', async () => {
    const env = await setup({ scope: 'write', files: { 'a.txt': 'one\n', 'b.txt': 'two\n' } });
    try {
      const first = await env.client('client-a');
      const second = await env.client('client-b');
      // One writer at a time: the second write waits until the first is answered and done.
      const callA = first.callTool({ name: 'edit_file', arguments: { path: 'a.txt', old_string: 'one', new_string: 'uno' } });
      const { item: itemA } = await pendingOf(env, 'mcp:client-a', performance.now());
      assert.equal((await env.decide(itemA.id, true)).status, 200);
      assert.notEqual((await callA).isError, true);
      const callB = second.callTool({ name: 'edit_file', arguments: { path: 'b.txt', old_string: 'two', new_string: 'dos' } });
      const { item: itemB } = await pendingOf(env, 'mcp:client-b', performance.now());
      assert.equal(itemB.client, 'client-b');
      assert.equal((await env.decide(itemB.id, true)).status, 200);
      assert.notEqual((await callB).isError, true);
      assert.equal(env.file('a.txt'), 'uno\n');
      assert.equal(env.file('b.txt'), 'dos\n');
      assert.deepEqual(env.host.state().clients.map((entry) => entry.tag).sort(), ['mcp:client-a', 'mcp:client-b']);
      assert.equal(new Set(env.host.state().clients.map((entry) => entry.taskId)).size, 2);
    } finally { await env.close(); }
  });

  // ---------------------------------------------------------------------------------------------------------------------------------
  // 2. No decision
  // ---------------------------------------------------------------------------------------------------------------------------------
  await test('no decision: an isError approval_timeout result when the host timeout runs out (2 s here), and nothing is written', async () => {
    const env = await setup({ scope: 'write', timeout: 2000 });
    try {
      const client = await env.client('waiting-client');
      await client.callTool({ name: 'read_file', arguments: { path: 'notes.txt' } }); // the manager exists before the clock starts
      const started = performance.now();
      const result = await client.callTool({ name: 'edit_file', arguments: { path: 'notes.txt', old_string: 'alpha', new_string: 'gamma' } });
      const ms = performance.now() - started;
      assert.equal(result.isError, true);
      assert.equal(codeOf(result), 'approval_timeout', textOf(result));
      assert.equal(result.structuredContent.executed, false);
      assert.match(textOf(result), /2 s/);
      assert.ok(ms >= 1900 && ms < 6000, `the call ended after ${Math.round(ms)} ms`);
      assert.equal(env.file('notes.txt'), 'alpha\nbeta\n');
      assert.deepEqual(await env.pending(), []);
      // A denial is still a denial, not a timeout.
      const call = client.callTool({ name: 'edit_file', arguments: { path: 'notes.txt', old_string: 'alpha', new_string: 'gamma' } });
      const { item } = await pendingOf(env, 'mcp:waiting-client', performance.now());
      await env.decide(item.id, false);
      assert.equal(codeOf(await call), 'permission_denied');
    } finally { await env.close(); }
  });

  // ---------------------------------------------------------------------------------------------------------------------------------
  // 3. Single writer
  // ---------------------------------------------------------------------------------------------------------------------------------
  await test('single writer: a write while the primary agent holds its task is workspace_busy before anyone is asked; a read still runs', async () => {
    const env = await setup({ scope: 'write' });
    try {
      const client = await env.client('busy-client');
      env.primary.acquireTask('primary-task-1');
      try {
        const result = await client.callTool({ name: 'edit_file', arguments: { path: 'notes.txt', old_string: 'alpha', new_string: 'gamma' } });
        assert.equal(result.isError, true);
        assert.equal(codeOf(result), 'workspace_busy', textOf(result));
        assert.equal(result.structuredContent.error.holder, 'agent');
        assert.equal(result.structuredContent.executed, false);
        assert.deepEqual(await env.pending(), [], 'nobody was asked');
        assert.deepEqual(env.host.gate('busy-client').state().recent, [], 'nothing reached the gate');
        const read = await client.callTool({ name: 'read_file', arguments: { path: 'notes.txt' } });
        assert.notEqual(read.isError, true, textOf(read));
        assert.equal(env.primary.taskId, 'primary-task-1', 'the primary agent keeps its task');
      } finally { env.primary.releaseTask('primary-task-1'); }
      assert.equal(env.file('notes.txt'), 'alpha\nbeta\n');
    } finally { await env.close(); }
  });

  await test('single writer: the workspace lock file held by another task makes a write workspace_busy', async () => {
    const env = await setup({ scope: 'write' });
    try {
      const client = await env.client('lock-client');
      const lockFile = path.join(env.workspace, '.chatmcp-workspace.lock');
      fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, taskId: 'other-hub-task', acquiredAt: Date.now(), workspaceRoot: env.workspace }));
      const result = await client.callTool({ name: 'edit_file', arguments: { path: 'notes.txt', old_string: 'alpha', new_string: 'gamma' } });
      assert.equal(codeOf(result), 'workspace_busy', textOf(result));
      assert.equal(result.structuredContent.error.holder, 'workspace_lock');
      assert.ok(fs.existsSync(lockFile), 'the host never removes a lock it does not hold');
      fs.rmSync(lockFile);
      fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, taskId: 'old', acquiredAt: Date.now() - 31 * 60 * 1000 }));
      const call = client.callTool({ name: 'edit_file', arguments: { path: 'notes.txt', old_string: 'alpha', new_string: 'gamma' } });
      const { item } = await pendingOf(env, 'mcp:lock-client', performance.now());
      await env.decide(item.id, true);
      assert.notEqual((await call).isError, true, 'a stale lock does not block');
      assert.equal(env.file('notes.txt'), 'gamma\nbeta\n');
    } finally { await env.close(); }
  });

  await test('single writer: an approval given after the primary agent started is workspace_busy, and nothing is written', async () => {
    const env = await setup({ scope: 'write' });
    try {
      const client = await env.client('late-client');
      const call = client.callTool({ name: 'edit_file', arguments: { path: 'notes.txt', old_string: 'alpha', new_string: 'gamma' } });
      const { item } = await pendingOf(env, 'mcp:late-client', performance.now());
      env.primary.acquireTask('primary-task-2');
      try {
        await env.decide(item.id, true);
        const result = await call;
        assert.equal(codeOf(result), 'workspace_busy', textOf(result));
        assert.equal(env.file('notes.txt'), 'alpha\nbeta\n');
      } finally { env.primary.releaseTask('primary-task-2'); }
    } finally { await env.close(); }
  });

  await test('single writer: a second write while the first waits for its approval is workspace_busy (holder mcp_client)', async () => {
    const env = await setup({ scope: 'write' });
    try {
      const first = await env.client('first-writer');
      const second = await env.client('second-writer');
      const call = first.callTool({ name: 'edit_file', arguments: { path: 'notes.txt', old_string: 'alpha', new_string: 'gamma' } });
      const { item } = await pendingOf(env, 'mcp:first-writer', performance.now());
      const result = await second.callTool({ name: 'edit_file', arguments: { path: 'notes.txt', old_string: 'beta', new_string: 'delta' } });
      assert.equal(codeOf(result), 'workspace_busy', textOf(result));
      assert.equal(result.structuredContent.error.holder, 'mcp_client');
      assert.equal((await env.pending()).length, 1, 'only the first write asks');
      await env.decide(item.id, true);
      assert.notEqual((await call).isError, true);
      const again = second.callTool({ name: 'edit_file', arguments: { path: 'notes.txt', old_string: 'beta', new_string: 'delta' } });
      const { item: next } = await pendingOf(env, 'mcp:second-writer', performance.now());
      await env.decide(next.id, true);
      assert.notEqual((await again).isError, true, 'the writer slot is free again once the first call ended');
      assert.equal(env.file('notes.txt'), 'gamma\ndelta\n');
    } finally { await env.close(); }
  });

  // ---------------------------------------------------------------------------------------------------------------------------------
  // 4. The host's gate
  // ---------------------------------------------------------------------------------------------------------------------------------
  await test('the host gate refuses autonomous and full-access, by configure and by assignment; Review and Read Only stay possible in the write scope', async () => {
    const env = await setup({ scope: 'write' });
    try {
      const client = await env.client('mode-client');
      await client.callTool({ name: 'read_file', arguments: { path: 'notes.txt' } });
      const gate = env.host.gate('mode-client');
      assert.equal(gate.mode, 'review');
      assert.equal(gate.executionPolicy, 'host-review');
      assert.equal(gate.timeout, DEFAULT_APPROVAL_TIMEOUT_MS);
      const refused = (error) => error.code === 'mcp_host_mode_refused' && error.statusCode === 403;
      assert.throws(() => gate.configure({ mode: 'autonomous' }), refused);
      assert.throws(() => gate.configure({ mode: 'full-access', confirmation: 'FULL ACCESS' }), refused);
      assert.throws(() => gate.configure({ executionPolicy: 'full-access', confirmation: 'FULL ACCESS' }), refused);
      assert.throws(() => gate.configure({ mode: 'manual', executionPolicy: 'full-access', confirmation: 'FULL ACCESS' }), refused);
      assert.throws(() => { gate.mode = 'autonomous'; }, refused);
      assert.throws(() => { gate.executionPolicy = 'full-access'; }, refused);
      assert.equal(gate.mode, 'review');
      assert.equal(gate.executionPolicy, 'host-review');
      assert.equal(gate.configure({ mode: 'readonly' }).mode, 'readonly');
      assert.equal(gate.configure({ mode: 'manual' }).mode, 'review', 'the legacy name of Review');
      assert.equal(gate.state().fullAccess, false);
    } finally { await env.close(); }
  });

  await test('read scope: the host gate is Read Only and cannot be raised; edit_file is refused without a question and read_file runs', async () => {
    const env = await setup({ scope: 'read' });
    try {
      const client = await env.client('reader');
      const result = await client.callTool({ name: 'edit_file', arguments: { path: 'notes.txt', old_string: 'alpha', new_string: 'gamma' } });
      assert.equal(codeOf(result), 'permission_denied', textOf(result));
      assert.deepEqual(await env.pending(), []);
      const gate = env.host.gate('reader');
      assert.equal(gate.mode, 'readonly');
      assert.throws(() => gate.configure({ mode: 'review' }), (error) => error.code === 'mcp_host_mode_refused');
      assert.throws(() => { gate.mode = 'review'; }, (error) => error.code === 'mcp_host_mode_refused');
      assert.notEqual((await client.callTool({ name: 'read_file', arguments: { path: 'notes.txt' } })).isError, true);
      assert.equal(env.file('notes.txt'), 'alpha\nbeta\n');
    } finally { await env.close(); }
  });

  await test('verify scope: Read Only as well', async () => {
    const env = await setup({ scope: 'verify', tools: [READ] });
    try {
      const client = await env.client('verifier');
      assert.notEqual((await client.callTool({ name: 'read_file', arguments: { path: 'notes.txt' } })).isError, true);
      assert.equal(env.host.gate('verifier').mode, 'readonly');
    } finally { await env.close(); }
  });

  // ---------------------------------------------------------------------------------------------------------------------------------
  // 5. The primary agent's state is untouched
  // ---------------------------------------------------------------------------------------------------------------------------------
  await test('the primary agent\'s task, the lock file, its checkpoints, its plan and its permission history are untouched by an approved MCP edit', async () => {
    const env = await setup({ scope: 'write', tools: [READ, EDIT, PLAN] });
    try {
      const { primary } = env;
      const primaryTask = randomUUID();
      await primary.studio.plan({ taskId: primaryTask, operation: 'set', title: 'primary plan', items: [{ text: 'step', status: 'doing' }] });
      const primaryCheckpoint = await primary.studio.checkpoint({ label: 'primary checkpoint', taskId: primaryTask, files: ['notes.txt'] });
      const before = {
        taskId: primary.taskId, checkpoints: (await primary.studio.checkpoints()).map((entry) => entry.id),
        plan: await primary.studio.plan({ taskId: primaryTask }), history: primary.permissions.state().recent.length,
      };
      const client = await env.client('isolated-client');
      const call = client.callTool({ name: 'edit_file', arguments: { path: 'notes.txt', old_string: 'alpha', new_string: 'gamma' } });
      const { item } = await pendingOf(env, 'mcp:isolated-client', performance.now());
      await env.decide(item.id, true);
      assert.notEqual((await call).isError, true);
      const planned = await client.callTool({ name: 'update_plan', arguments: { title: 'client plan', items: [{ text: 'mcp step', status: 'done' }] } });
      assert.notEqual(planned.isError, true, textOf(planned));
      assert.equal(primary.taskId, before.taskId);
      assert.deepEqual((await primary.studio.checkpoints()).map((entry) => entry.id), before.checkpoints, 'no checkpoint was added to the primary\'s list');
      assert.ok(before.checkpoints.includes(primaryCheckpoint.id));
      assert.deepEqual(await primary.studio.plan({ taskId: primaryTask }), before.plan);
      assert.equal(primary.permissions.state().recent.length, before.history, 'the primary gate recorded nothing');
      assert.equal(fs.existsSync(path.join(env.workspace, '.chatmcp-workspace.lock')), false, 'the host writes no lock file into the workspace');
      // The host's own records: its checkpoint before the edit, its plan, its history, in its own folder.
      const hostManager = env.host.managerOf('isolated-client');
      assert.notEqual(hostManager, primary);
      assert.ok(hostManager.hubDirectory.startsWith(path.join(primary.hubDirectory, 'mcp-host')));
      const clientTask = hostTaskId(env.workspace, 'isolated-client');
      const hostCheckpoints = await hostManager.studio.checkpoints();
      assert.ok(hostCheckpoints.some((entry) => entry.taskId === clientTask && entry.label === `Before local.edit_file · ${clientTask}`), JSON.stringify(hostCheckpoints));
      assert.equal((await hostManager.studio.plan({ taskId: clientTask })).title, 'client plan');
      assert.equal(hostManager.permissions.state().recent.find((entry) => entry.toolName === 'local.edit_file').decision, 'approved');
      assert.equal(hostManager.taskId, clientTask, 'the client\'s task id, held for the life of its manager');
    } finally { await env.close(); }
  });

  // ---------------------------------------------------------------------------------------------------------------------------------
  // 6. Hooks and the external-tool policy
  // ---------------------------------------------------------------------------------------------------------------------------------
  await test('the owner\'s PreToolUse hook sees a client\'s call under the client\'s task and its veto refuses it', async () => {
    const seen = [];
    const hooks = {
      async run(input) {
        seen.push({ event: input.event, toolName: input.toolName, taskId: input.taskId });
        const deny = input.event === 'PreToolUse' && input.toolName === 'local.read_file' && input.toolInput?.path === 'private.txt';
        return { event: input.event, feedback: [], additionalContext: [], ...(deny ? { permission: 'deny', reason: 'the owner\'s hook says no' } : {}) };
      },
      async close() {},
    };
    const env = await setup({ scope: 'write', hooks, files: { 'notes.txt': 'alpha\n', 'private.txt': 'hidden words\n' } });
    try {
      const client = await env.client('hooked-client');
      const result = await client.callTool({ name: 'read_file', arguments: { path: 'private.txt' } });
      assert.equal(codeOf(result), 'hook_denied', textOf(result));
      assert.doesNotMatch(textOf(result), /hidden words/);
      assert.notEqual((await client.callTool({ name: 'read_file', arguments: { path: 'notes.txt' } })).isError, true);
      const clientTask = hostTaskId(env.workspace, 'hooked-client');
      assert.ok(seen.some((entry) => entry.event === 'PreToolUse' && entry.taskId === clientTask), JSON.stringify(seen));
      assert.ok(seen.some((entry) => entry.event === 'PostToolUse' && entry.taskId === clientTask));
    } finally { await env.close(); }
  });

  await test('an external tool through the host follows the owner\'s policy: deny refuses in every scope, allow runs in Review', async () => {
    const calls = [];
    const policy = { echo: 'deny', shout: 'allow' };
    const fakeMcp = {
      store: { policyFor: ({ tool }) => policy[tool], trustsAnnotations: () => false, describe: () => ({ transport: 'stdio', command: ['fake-server'] }), touchesWorkspace: () => false },
      catalogGroups: () => [{
        id: 'fake', serverInfo: { name: 'fake', version: '1' }, capabilities: { tools: {} }, fingerprint: 'fake-1', prompts: [], resources: [],
        tools: ['echo', 'shout'].map((name) => ({ name, description: name, inputSchema: { type: 'object', properties: { text: { type: 'string' } } } })),
      }],
      async callTool(server, tool, args) { calls.push({ server, tool, args }); return { content: [{ type: 'text', text: `${tool}: ${args.text}` }] }; },
      status: () => null,
    };
    const schema = { type: 'object', properties: { text: { type: 'string' } } };
    const tools = [{ name: 'fake_echo', target: 'fake.echo', inputSchema: schema }, { name: 'fake_shout', target: 'fake.shout', inputSchema: schema }];
    const env = await setup({ scope: 'write', tools, mcp: fakeMcp });
    try {
      const client = await env.client('external-client');
      const denied = await client.callTool({ name: 'fake_echo', arguments: { text: 'hi' } });
      assert.equal(codeOf(denied), 'permission_denied', textOf(denied));
      assert.match(textOf(denied), /deny/);
      const allowed = await client.callTool({ name: 'fake_shout', arguments: { text: 'hi' } });
      assert.notEqual(allowed.isError, true, textOf(allowed));
      assert.equal(textOf(allowed), 'shout: hi');
      assert.deepEqual(calls, [{ server: 'fake', tool: 'shout', args: { text: 'hi' } }], 'the denied tool never reached its server');
    } finally { await env.close(); }
  });

  await test('the host makes at most 8 client managers; the ninth client is refused with mcp_client_limit', async () => {
    const env = await setup({ scope: 'read', tools: [READ] });
    try {
      for (let index = 0; index < MAX_CLIENTS; index += 1) {
        const client = await env.client(`many-${index}`);
        assert.notEqual((await client.callTool({ name: 'read_file', arguments: { path: 'notes.txt' } })).isError, true);
      }
      const ninth = await env.client('many-8');
      const result = await ninth.callTool({ name: 'read_file', arguments: { path: 'notes.txt' } });
      assert.equal(codeOf(result), 'mcp_client_limit', textOf(result));
      const known = await env.client('many-0');
      assert.notEqual((await known.callTool({ name: 'read_file', arguments: { path: 'notes.txt' } })).isError, true, 'a known client still works');
    } finally { await env.close(); }
  });

  await test('no workspace: a call is an isError workspace_missing result, and nothing is made', async () => {
    const env = await setup({ scope: 'read', tools: [READ] });
    try {
      env.primary.workspace = null;
      const client = await env.client('nowhere');
      const result = await client.callTool({ name: 'read_file', arguments: { path: 'notes.txt' } });
      assert.equal(codeOf(result), 'workspace_missing', textOf(result));
      assert.equal(env.host.state().clients.length, 0);
    } finally { await env.close(); }
  });

  await test('close(): a pending approval of a client ends (cancelled for the client, gone from /api/state) and the managers stop', async () => {
    const env = await setup({ scope: 'write' });
    let closed = false;
    try {
      const client = await env.client('closing-client');
      const call = client.callTool({ name: 'edit_file', arguments: { path: 'notes.txt', old_string: 'alpha', new_string: 'gamma' } });
      await pendingOf(env, 'mcp:closing-client', performance.now());
      await env.host.close();
      closed = true;
      const result = await call;
      assert.equal(result.isError, true, textOf(result));
      assert.deepEqual(await env.pending(), []);
      assert.equal(env.host.state().clients.length, 0);
      assert.equal(env.file('notes.txt'), 'alpha\nbeta\n');
      const after = await client.callTool({ name: 'read_file', arguments: { path: 'notes.txt' } });
      assert.equal(codeOf(after), 'mcp_host_closed', textOf(after));
    } finally { if (!closed) await env.host.close(); await env.close(); }
  });

  // ---------------------------------------------------------------------------------------------------------------------------------
  // 7. A real hub.mjs
  // ---------------------------------------------------------------------------------------------------------------------------------
  await test('hub.mjs: on, the client lists hub_status and read_file and reads a workspace file through the host (mcp:<client>)', async () => {
    const port = await freePort();
    const scratchDir = folder('e2e-host');
    const project = path.join(scratchDir, 'project');
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, 'hello.txt'), 'hello from the workspace\n');
    const hub = await startHub({ scratch: scratchDir, project, env: { [MCP_SERVER_VARIABLE]: 'on', [MCP_SERVER_PORT_VARIABLE]: String(port), CHATMCP_MCP_RUNTIME_DIR: runtime } });
    try {
      await waitFor(() => hub.logText().includes(`MCP server: listening on http://127.0.0.1:${port}/mcp`), { timeoutMs: 20_000, label: 'the MCP listener' });
      const tokens = new McpServerTokenStore({ directory: hub.stateDir, protector: createProtector({ bundleRoot: HUB_ROOT, directory: hub.stateDir }) });
      await tokens.load();
      const token = await tokens.reveal();
      const client = new clientSdk.Client({ name: 'verify-ext18', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
      await client.connect(new clientSdk.StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
      try {
        const { tools } = await client.listTools();
        assert.deepEqual(tools.map((tool) => tool.name), ['hub_status', 'read_file']);
        const read = await client.callTool({ name: 'read_file', arguments: { path: 'hello.txt' } });
        assert.notEqual(read.isError, true, textOf(read));
        assert.match(textOf(read), /hello from the workspace/);
        const secret = await client.callTool({ name: 'read_file', arguments: { path: '.env' } });
        assert.equal(secret.isError, true, 'a protected file is refused as for every agent');
      } finally { await client.close(); }
      assert.ok(fs.existsSync(path.join(hub.stateDir, 'mcp-host')), 'the host keeps its managers under <data>/mcp-host');
      assert.match(hub.logText(), /MCP host: a manager for mcp:verify-ext18 /);
    } finally { await hub.stop(); }
    assert.match(hub.logText(), /Stop: mcp server[^\n]*\n(?:[^\n]*\n)*?[^\n]*MCP host: closed\./, 'the host closes in the stop sequence');
  });
} finally {
  await sleep(50);
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
