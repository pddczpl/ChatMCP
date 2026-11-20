// The seam between the MCP client manager and the agent (P2 slice C2, plan task ext-11; docs/MCP-CLIENT.md "The seam"). A real HubManager assembled
// the normal way, the real AgentRunner with a scripted model, a ConcurrentApiAgent child, the ChatGPT Web transport, and the stdio fixture
// tests/fixtures/mcp-seam-server.mjs. What must hold:
//
//   1. After its launch and its tools are approved, a server's tools, prompts and resources are in manager.internalCatalog() as <server>.<tool>, with
//      the server's own serverInfo and capabilities; mcp_call reaches the server, mcp_capabilities gets its prompt and reads its resource.
//   2. The gate decides as the owner set it in mcp-servers.json: an allowed tool runs in Autonomous, create_issue (no rule) asks with the MCP card,
//      a denied tool returns permission_denied without asking, and under Full Access a tool marked destructiveHint: true still asks.
//   3. A PreToolUse hook fires for an external call (matcher mcp__ext__echo).
//   4. A spawn_agent child ('auto' tool selection, its own HubManager) calls an external tool; a web-transport session lists and calls it.
//   5. With a 300-tool server the instruction text stays under a fixed byte budget (40 names at most, the rest summarised per server) and
//      mcp_catalog with a filter finds a given tool.
//   6. Images: a PNG reaches the model as an image, an SVG only as a text note. A transport failure stops the task as tool_transport_failed, with
//      exactly one invocation. A checkpoint is taken before a call to a server flagged touchesWorkspace, and only then.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HubManager } from '../lib/manager.mjs';
import { assembleStudio } from '../lib/assemble.mjs';
import { AgentRunner, createAgentInstructions, INSTRUCTION_NAME_LIMIT } from '../lib/agent.mjs';
import { compactAgentInstructions } from '../lib/gemini-compat.mjs';
import { ConcurrentApiAgent } from '../lib/concurrent-api-agent.mjs';
import { BrowserRunner } from '../lib/browser-runner.mjs';
import { HUB, counterLines, delay, descendants, missingReason, newDescendants, runtimeRoot } from './support/mcp-tools.mjs';

const missing = missingReason();
if (missing) {
  console.log(`CHATMCP_TEST_SKIP: ${missing}`);
  process.exit(0);
}
// A Hub assembled the normal way finds the SDK beside DATGOLD-HUB; a copy of the Hub (the mutation runner's) has none there, so it is named here.
process.env.CHATMCP_MCP_RUNTIME_DIR ??= runtimeRoot();
setTimeout(() => { console.error('FAIL: the MCP agent seam suite exceeded its own time budget'); process.exit(2); }, 240_000).unref();

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
const SEAM = path.join(HUB, 'tests', 'fixtures', 'mcp-seam-server.mjs');
const HOOK = path.join(HUB, 'tests', 'fixtures', 'hook-program.mjs');
const node = process.execPath;
// The instruction text of a run with a 308-tool server and an 8-tool server connected: 7,535 bytes measured on 2026-11-20 with the 40-name cap; the same
// run listing every name is about 12 KB, over this budget.
const INSTRUCTION_BUDGET_BYTES = 9 * 1024;
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'datgold-mcp-seam-')));
const baseline = await descendants();
async function until(test, label, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = await test(); if (value) return value; await delay(25); }
  throw new Error(`timed out waiting for ${label}`);
}
function git(cwd, ...args) { return execFileSync('git', args, { cwd, stdio: 'ignore' }); }
const work = path.join(root, 'project');
await fs.mkdir(work, { recursive: true });
git(work, 'init', '-b', 'main');
git(work, 'config', 'user.email', 'chatmcp-ci@example.invalid');
git(work, 'config', 'user.name', 'ChatMCP CI');
await fs.writeFile(path.join(work, 'README.md'), '# seam\n');
git(work, 'add', '.');
git(work, 'commit', '-m', 'fixture');
const counter = path.join(root, 'calls.txt');
const bigCounter = path.join(root, 'big-calls.txt');
const hubDirectory = path.join(root, 'hub');
await fs.mkdir(hubDirectory, { recursive: true });
await fs.writeFile(path.join(hubDirectory, 'mcp-servers.json'), JSON.stringify({ version: 1, servers: {
  ext: {
    transport: 'stdio', command: node, args: [SEAM, '--count-file', counter, '--workdir', work],
    policy: { tools: { echo: 'allow', forbidden: 'deny', images: 'allow', crash: 'allow', write_note: 'allow', wipe_cache: 'allow', bad_params: 'allow' } },
    trust: { annotations: true }, touchesWorkspace: true,
  },
  big: { transport: 'stdio', command: node, args: [SEAM, '--tools', '300', '--count-file', bigCounter], policy: { default: 'allow' } },
} }, null, 2));

const hub = new HubManager({ bundleRoot: HUB, dataDirectory: hubDirectory, log: () => {} });
await hub.load(work);
assembleStudio(hub, { bundleRoot: HUB });
await hub.mcp.reload();
await hub.permissions.load();
await hub.startLocal(work);
const gate = hub.permissions;
gate.configure({ mode: 'autonomous' });
const checkpoints = [];
const takeCheckpoint = hub.studio.checkpoint.bind(hub.studio);
hub.studio.checkpoint = async (request) => { checkpoints.push(request.label); return takeCheckpoint(request); };

// The scripted model: the user text says "Run <KEY>:", the script of KEY is a list of calls made one after the other, then a final answer.
const finalOutput = (text) => [{ type: 'message', role: 'assistant', phase: 'final', content: [{ type: 'output_text', text }] }];
const userTexts = (input) => input.filter((item) => item?.role === 'user' && Array.isArray(item.content)).map((item) => item.content.map((part) => part?.text ?? '').join(' '));
const scripts = new Map();
const script = (key, calls) => { const entry = { calls, outputs: [], instructions: null, tools: null, raw: [] }; scripts.set(key, entry); return entry; };
const mcpCall = (name, args = {}) => ({ name: 'mcp_call', args: { name, arguments_json: JSON.stringify(args) } });
const provider = {
  ready: () => true, snapshot: () => ({ provider: 'fixture', model: 'seam' }),
  async respond({ input, instructions, tools }) {
    const key = /Run ([A-Z0-9_]+):/.exec(userTexts(input).filter((line) => !line.startsWith('UNTRUSTED SKILL')).join(' '))?.[1];
    const entry = scripts.get(key);
    if (!entry) return { status: 'completed', output: finalOutput('no script') };
    entry.instructions ??= instructions;
    entry.tools ??= tools;
    const outputs = input.filter((item) => item.type === 'function_call_output');
    entry.raw = outputs.map((item) => item.output);
    entry.outputs = outputs.map((item) => (typeof item.output === 'string' ? item.output : JSON.stringify(item.output)));
    const next = entry.calls[outputs.length];
    if (next) return { status: 'completed', output: [{ type: 'function_call', status: 'completed', name: next.name, call_id: `${key}-${outputs.length}`, arguments: JSON.stringify(next.args) }] };
    return { status: 'completed', output: finalOutput(`${key} done`) };
  },
};
const runner = new AgentRunner({ manager: hub, provider, taskDirectory: path.join(root, 'tasks'), log: () => {} });
await runner.load();
async function run(key, prompt = 'do it') {
  await runner.start({ prompt: `Run ${key}: ${prompt}` });
  return runner.context.done.promise;
}
async function approveAll() {
  for (const id of ['ext', 'big']) {
    const shown = await hub.mcp.launchRecord(id);
    if (!shown.approved) await hub.mcp.approveLaunch(id, { expectedFingerprint: shown.fingerprint });
  }
  for (const id of ['ext', 'big']) await hub.mcp.connect(id);
  for (const id of ['ext', 'big']) {
    const review = hub.mcp.toolReview(id);
    if (review.state !== 'pinned') await hub.mcp.approveTools(id, { expectedFingerprint: review.fingerprint });
  }
}

let pool = null;
let browser = null;
try {
  // ------------------------------------------------------------------------------------------------------------------ 0. nothing before approval
  {
    const entry = script('NONE', [mcpCall('ext.echo', { text: 'too early' })]);
    const task = await run('NONE');
    assert.equal(task.status, 'completed', task.error);
    assert.match(entry.outputs[0], /unknown_tool/, 'an unapproved server has no tool in the catalog');
    assert.deepEqual(counterLines(counter), [], 'and nothing was started or called');
    ok('before the owner approved the launch, no tool of the server is in the catalog and no process is started');
  }
  await approveAll();

  // ------------------------------------------------------------------------------------------------------------------ 1. catalog and calls
  {
    const catalog = hub.internalCatalog();
    const echo = catalog.tools.find((tool) => tool.name === 'ext.echo');
    assert.ok(echo, 'ext.echo is in the catalog');
    assert.equal(echo.server, 'ext');
    assert.equal(echo.originalName, 'echo');
    assert.equal(echo.annotations.readOnlyHint, true);
    assert.equal(catalog.servers.ext.serverInfo.name, 'mcp-seam-fixture');
    assert.ok(catalog.servers.ext.capabilities.resources, 'the server\'s real capabilities');
    assert.equal(catalog.counts.big, 308);
    assert.ok(catalog.prompts.some((prompt) => prompt.server === 'ext' && prompt.originalName === 'greet'));
    assert.ok(catalog.resources.some((resource) => resource.server === 'ext' && resource.uri === 'mem://seam/notes'));
    assert.ok(catalog.tools.some((tool) => tool.name === 'local.read_file'), 'the local tools are still there');
    const entry = script('CALL', [
      mcpCall('ext.echo', { text: 'hi' }),
      { name: 'mcp_capabilities', args: { action: 'get_prompt', server: 'ext', name: 'greet', arguments_json: JSON.stringify({ name: 'Ada' }), uri: null, filter: null, offset: 0, limit: 10 } },
      { name: 'mcp_capabilities', args: { action: 'read_resource', server: 'ext', name: null, arguments_json: null, uri: 'mem://seam/notes', filter: null, offset: 0, limit: 10 } },
    ]);
    const task = await run('CALL');
    assert.equal(task.status, 'completed', task.error);
    assert.match(entry.outputs[0], /echo: hi/);
    assert.match(entry.outputs[1], /Say hello to Ada\./);
    assert.match(entry.outputs[2], /seam notes text/);
    assert.deepEqual(counterLines(counter), ['echo']);
    assert.equal(gate.state().pending.length, 0, 'an allowed tool runs in Autonomous without a question');
    ok('internalCatalog() carries ext.* and big.* with the server\'s serverInfo, capabilities, prompts and resources; mcp_call runs ext.echo once; mcp_capabilities gets the prompt and reads the resource');
  }

  // ------------------------------------------------------------------------------------------------------------------ 2. the gate
  {
    const entry = script('ASK', [mcpCall('ext.create_issue', { title: 'Bug' }), mcpCall('ext.forbidden')]);
    const started = run('ASK');
    const request = await until(() => gate.state().pending.find((item) => item.toolName === 'ext.create_issue'), 'the question about create_issue');
    assert.equal(request.category, 'external');
    assert.equal(request.detail.kind, 'mcp');
    assert.equal(request.detail.server, 'ext');
    assert.equal(request.detail.tool, 'create_issue');
    assert.equal(request.detail.transport, 'stdio');
    gate.decide(request.id, false);
    const task = await started;
    assert.equal(task.status, 'completed', task.error);
    assert.match(entry.outputs[0], /Permission denied/);
    assert.match(entry.outputs[1], /permission_denied|Permission denied/);
    assert.equal(gate.state().pending.length, 0);
    assert.deepEqual(counterLines(counter), ['echo'], 'neither the refused nor the denied call reached the server');
    ok('Autonomous: ext.create_issue (no rule) asks with the MCP card (server, tool, transport) and a "no" is permission denied; ext.forbidden (deny) is refused without a question; neither reached the server');
  }
  {
    gate.configure({ mode: 'full-access', confirmation: 'FULL ACCESS' });
    const entry = script('FULL', [mcpCall('ext.wipe_cache'), mcpCall('ext.create_issue', { title: 'Runs' }), mcpCall('ext.forbidden')]);
    const started = run('FULL');
    const request = await until(() => gate.state().pending.find((item) => item.toolName === 'ext.wipe_cache'), 'the question about wipe_cache');
    gate.decide(request.id, true);
    const task = await started;
    assert.equal(task.status, 'completed', task.error);
    assert.match(entry.outputs[0], /cache wiped/);
    assert.match(entry.outputs[1], /issue created: Runs/, 'Full Access runs an external tool without a rule');
    assert.match(entry.outputs[2], /Permission denied/, 'an explicit deny wins over Full Access');
    gate.configure({ mode: 'autonomous', leaveFullAccess: true });
    ok('Full Access: a tool marked destructiveHint: true (even allowed) still asks; one without a rule runs; an explicit deny still refuses');
  }
  {
    gate.configure({ mode: 'readonly' });
    const entry = script('READONLY', [mcpCall('ext.echo', { text: 'read only' }), mcpCall('ext.create_issue', { title: 'No' })]);
    const task = await run('READONLY');
    assert.equal(task.status, 'completed', task.error);
    assert.match(entry.outputs[0], /echo: read only/, 'allow + readOnlyHint + trust.annotations runs in Read Only');
    assert.match(entry.outputs[1], /Permission denied/);
    assert.equal(gate.state().pending.length, 0);
    gate.configure({ mode: 'autonomous' });
    ok('Read Only: ext.echo (allow, readOnlyHint, the owner trusts the server\'s annotations) runs; ext.create_issue is refused without a question');
  }
  {
    // the lists stop matching the pin while a task runs (the preflight had pinned them): the call is refused before anything is sent
    const entry = script('RUG', [mcpCall('ext.echo', { text: 'after the change' })]);
    const respond = provider.respond;
    provider.respond = async (request) => {
      if (/Run RUG:/.test(userTexts(request.input).join(' ')) && !request.input.some((item) => item.type === 'function_call_output')) hub.mcp.connections.get('ext').review = { state: 'needs_review', fingerprint: null };
      return respond(request);
    };
    const before = counterLines(counter).length;
    const task = await run('RUG');
    provider.respond = respond;
    assert.equal(task.status, 'completed', task.error);
    assert.match(entry.outputs[0], /mcp_needs_review/);
    assert.match(entry.outputs[0], /"executed":false|executed.{0,4}false/);
    assert.equal(counterLines(counter).length, before, 'nothing reached the server');
    await hub.mcp.listTools('ext', { refresh: true });
    assert.equal(hub.mcp.toolReview('ext').state, 'pinned', 'the lists still match the pin once listed again');
    ok('a server quarantined while a task runs: the call is refused as a result (mcp_needs_review, executed: false), nothing reaches the server, and the task goes on');
  }
  {
    const entry = script('PROTO', [mcpCall('ext.bad_params'), mcpCall('ext.echo', { text: 'still running' })]);
    const task = await run('PROTO');
    assert.equal(task.status, 'completed', task.error);
    assert.match(entry.outputs[0], /-32602/);
    assert.match(entry.outputs[0], /"isError":\s*true/);
    assert.match(entry.outputs[1], /echo: still running/, 'the task went on after the error result');
    ok('a JSON-RPC error from the server is an isError result the model reads (protocolCode -32602); the task goes on');
  }

  // ------------------------------------------------------------------------------------------------------------------ 3. hooks
  {
    const log = path.join(root, 'hook-log.jsonl');
    await fs.writeFile(path.join(hubDirectory, 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'mcp__ext__echo', hooks: [{ type: 'command', command: node, args: [HOOK, JSON.stringify({ logPayload: log })] }] }] } }));
    script('HOOK', [mcpCall('ext.echo', { text: 'hooked' })]);
    const task = await run('HOOK');
    assert.equal(task.status, 'completed', task.error);
    const rows = fsSync.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].hook_event_name, 'PreToolUse');
    assert.equal(rows[0].tool_name, 'ext.echo');
    await fs.rm(path.join(hubDirectory, 'hooks.json'), { force: true });
    ok('a PreToolUse hook with the matcher mcp__ext__echo fires once for the external call');
  }

  // ------------------------------------------------------------------------------------------------------------------ 4. instructions with 300 tools
  {
    const entry = script('BUDGET', [{ name: 'mcp_catalog', args: { filter: 'tool_250', offset: 0, limit: 20 } }]);
    const task = await run('BUDGET', 'look at the catalog');
    assert.equal(task.status, 'completed', task.error);
    const bytes = Buffer.byteLength(entry.instructions);
    console.log(`  (instructions with 308 + 8 external tools: ${bytes} bytes)`);
    assert.ok(bytes < INSTRUCTION_BUDGET_BYTES, `${bytes} bytes`);
    const listed = (entry.instructions.match(/^- (?:ext|big)\.\S+$/gm) ?? []).length;
    assert.ok(listed <= 40, `${listed} external names listed`);
    assert.match(entry.instructions, /server big: \d+ tools, use mcp_catalog filter=big/);
    const found = JSON.parse(entry.outputs[0]);
    assert.ok(found.tools.some((tool) => tool.name === 'big.tool_250'), entry.outputs[0].slice(0, 400));
    ok(`with a 308-tool server the instructions are ${bytes} bytes (budget ${INSTRUCTION_BUDGET_BYTES}), list at most 40 external names, summarise the rest per server, and mcp_catalog filter=tool_250 finds big.tool_250`);
    // the instructions of a run with no direct tools (createAgentInstructions) keep the same cap, and the text-only Gemini rewrite still finds its sentence
    const plain = createAgentInstructions(hub.internalCatalog(), { path: work });
    const names = (plain.match(/^- \S+$/gm) ?? []).length;
    assert.equal(INSTRUCTION_NAME_LIMIT, 40);
    assert.equal(names, INSTRUCTION_NAME_LIMIT, `${names} names listed`);
    assert.match(plain, /the first 40 names are listed below and the rest are summarised per server/);
    assert.match(plain, /- server big: \d+ tools, use mcp_catalog filter=big/);
    assert.match(compactAgentInstructions(plain), /discoverable using JSON text actions for mcp_catalog/);
    ok('the instructions without direct tools list 40 names and summarise the rest per server; the text-only Gemini rewrite still applies');
  }

  // ------------------------------------------------------------------------------------------------------------------ 5. images, checkpoint
  {
    const entry = script('MEDIA', [mcpCall('ext.images'), mcpCall('ext.write_note', { text: 'from the model' }), mcpCall('big.tool_1')]);
    const before = checkpoints.length;
    const task = await run('MEDIA');
    assert.equal(task.status, 'completed', task.error);
    const media = JSON.stringify(entry.raw[0]);
    assert.match(media, /input_image/, 'the PNG reaches the model as an image');
    assert.match(media, /data:image\/png;base64/);
    assert.doesNotMatch(media, /image\/svg\+xml;base64/, 'the SVG is not an image for the model');
    assert.match(media, /svg/i, 'a text note names it');
    assert.equal(fsSync.readFileSync(path.join(work, 'note.txt'), 'utf8'), 'from the model');
    const made = checkpoints.slice(before);
    assert.ok(made.some((label) => label.startsWith('Before ext.write_note')), JSON.stringify(made));
    assert.ok(!made.some((label) => label.startsWith('Before big.tool_1')), 'no checkpoint for a server that does not touch the workspace');
    ok('a PNG result reaches the model as input_image and an SVG only as a text note; a checkpoint is taken before ext.write_note (touchesWorkspace) and not before big.tool_1');
  }

  // ------------------------------------------------------------------------------------------------------------------ 6. a spawn_agent child, auto mode
  {
    const primary = new AgentRunner({ manager: hub, provider, taskDirectory: path.join(root, 'pool-tasks'), log: () => {} });
    await primary.load();
    pool = new ConcurrentApiAgent({ primary, manager: hub, provider, bundleRoot: HUB, directory: path.join(root, 'pool'), log: () => {} });
    hub.spawnBackgroundAgent = (parentId, request) => pool.spawnAgent(parentId, request);
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const parent = script('PARENT', []);
    const parentRespond = provider.respond;
    provider.respond = async (request) => {
      if (/Run PARENT:/.test(userTexts(request.input).join(' '))) await held;
      return parentRespond(request);
    };
    const child = script('CHILD', [mcpCall('ext.echo', { text: 'from the child' })]);
    const rootTask = await pool.start({ prompt: 'Run PARENT: wait.' });
    const spawned = await pool.spawnAgent(rootTask.id, { goal: 'Run CHILD: call the external echo.' });
    const status = await until(() => ['completed', 'failed', 'cancelled', 'paused'].includes(pool.get(spawned.id)?.status) && pool.get(spawned.id).status, 'the child to end', 60_000);
    assert.equal(status, 'completed', pool.get(spawned.id)?.error);
    assert.match(child.outputs[0], /echo: from the child/, child.outputs[0]);
    assert.match(child.instructions, /ext\.echo/, 'the child is told of the external tool in auto mode');
    release();
    provider.respond = parentRespond;
    await until(() => pool.get(rootTask.id)?.status === 'completed', 'the parent to end', 30_000);
    void parent;
    ok('a spawn_agent child (its own HubManager, auto tool selection) is told of ext.echo and calls it through the same client manager');
    await pool.shutdown?.().catch(() => {});
    pool = null;
  }

  // ------------------------------------------------------------------------------------------------------------------ 7. the web transport
  {
    browser = new BrowserRunner({ manager: hub, directory: path.join(root, 'browser'), log: () => {} });
    await browser.load();
    const pairing = await browser.createPairCode();
    const clientId = randomUUID(); const extensionId = 'b'.repeat(32);
    const pair = await browser.pair({ code: pairing.code, clientId, extensionId });
    browser.authenticate(pair.token, clientId, `chrome-extension://${extensionId}`);
    const task = await browser.start({ prompt: 'List the external tools.', workspacePath: work });
    const url = `https://chatgpt.com/c/${randomUUID()}`;
    const say = async (message, block, replyId) => {
      await browser.claim({ clientId, taskId: task.id, messageId: message.id });
      await browser.sent({ clientId, taskId: task.id, messageId: message.id, url });
      const nonce = browser.tasks.get(task.id).nonce;
      await browser.reply({ clientId, taskId: task.id, messageId: message.id, replyId, url, text: 'ok', blocks: [JSON.stringify({ chatmcp_hub: 'v1', task: task.id, turn: message.turn, nonce, ...block })] });
    };
    const first = (await browser.poll({ clientId, taskId: task.id, phase: 'waiting', note: 'Paired' })).message;
    await say(first, { kind: 'catalog', query: 'ext.echo' }, 'web-1');
    const second = await until(async () => { const view = (await browser.poll({ clientId, taskId: task.id })).message; return view && view.id !== first.id && view; }, 'the catalog answer');
    assert.match(second.text, /ext\.echo/, 'the web session lists the external tool');
    await say(second, { kind: 'tool', name: 'ext.echo', arguments: { text: 'from the web' } }, 'web-2');
    const third = await until(async () => { const view = (await browser.poll({ clientId, taskId: task.id })).message; return view && view.id !== second.id && view; }, 'the tool answer');
    assert.match(third.text, /echo: from the web/);
    await say(third, { kind: 'final', text: 'Listed.' }, 'web-3');
    await until(() => browser.context === null, 'the web task to finish', 20_000);
    // a web session on another registered workspace runs on a manager of its own, which is handed the same client manager
    const other = path.join(root, 'other');
    await fs.mkdir(other, { recursive: true });
    hub.workspaceRegistry = { resolve: async (value) => ({ path: await fs.realpath(value) }) };
    const { manager: execution, owned } = await browser.executionManager(other);
    assert.equal(owned, true);
    assert.equal(execution.mcp, hub.mcp, 'the same McpClientManager');
    assert.equal(execution.mcpOwned, false, 'which it does not close');
    assert.ok(execution.internalCatalog().tools.some((tool) => tool.name === 'ext.echo'), 'and the same external tools');
    await execution.shutdown();
    delete hub.workspaceRegistry;
    assert.equal(hub.mcp.closed, false, 'shutting the borrowed manager down left the client manager open');
    await browser.shutdown().catch(() => {});
    browser = null;
    ok('a web-transport session lists ext.echo and calls it; a web session on a second workspace gets a manager with the same client manager and catalog');
  }

  // ------------------------------------------------------------------------------------------------------------------ 8. transport failure
  {
    const entry = script('CRASH', [mcpCall('ext.crash'), mcpCall('ext.echo', { text: 'after the crash' })]);
    const callsBefore = counterLines(counter).length;
    const task = await run('CRASH');
    assert.equal(task.status, 'failed');
    assert.equal(task.errorCode, 'tool_transport_failed', task.error);
    assert.deepEqual(counterLines(counter).slice(callsBefore), ['crash'], 'exactly one invocation, nothing after it');
    assert.equal(entry.outputs.length, 0, 'the model got no result to go on from');
    ok('a server that dies during a call stops the task as tool_transport_failed after exactly one invocation; the call is not replayed');
  }
} finally {
  await pool?.shutdown?.().catch(() => {});
  await browser?.shutdown?.().catch(() => {});
  await runner.shutdown().catch(() => {});
  await hub.shutdown().catch(() => {});
  const strays = await newDescendants(baseline).catch(() => []);
  if (strays.length) { console.log(`not ok - processes left behind: ${strays.join(', ')}`); process.exitCode = 1; }
  await fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
}
if (!process.exitCode) console.log(`PASS mcp-agent-seam: ${checks} checks`);
