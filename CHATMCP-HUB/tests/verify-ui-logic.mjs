#!/usr/bin/env node
// The decisions the dashboard makes (web/ui-logic.js), tested without a browser and against the REAL server pieces.
//
// What this proves, and how:
//   - the page's copy of the vocabulary (task states, permission modes, protocols, categories) cannot drift from the
//     server's: the test imports both and compares them
//   - "can a prompt be sent, and what is in the way" for the local backend and the legacy MCP backend. The local
//     backend case is the regression that made the dashboard unusable: its proxy/desktop services are "disabled" by design
//   - what an approval request shows is taken from requests produced by the real PermissionGate for the real local
//     tools (a long command is shown in full; secrets are already masked by the gate)
//   - every provider preset the Hub offers, filled in by the form logic, is accepted by the real GatewayProvider
//   - the page code never builds HTML from data
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { HubManager } from '../lib/manager.mjs';
import { assembleStudio } from '../lib/assemble.mjs';
import { AUTH_MODES, FORMATS, GatewayProvider } from '../lib/gateway-provider.mjs';
import { PERMISSION_MODES } from '../lib/permissions.mjs';
import { publicPresets } from '../lib/provider-presets.mjs';
import { ACTIVE_STATES, TASK_STATES, TASK_STATE_INFO } from '../lib/task-state.mjs';

const bundleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let checks = 0;
const check = (condition, label) => { assert.ok(condition, label); checks += 1; };
const plain = (value) => JSON.parse(JSON.stringify(value));
const equal = (actual, expected, label) => { assert.deepEqual(plain(actual), plain(expected), label); checks += 1; };
async function section(title, body) {
  const before = checks;
  await body();
  console.log(`  ok  ${title} (${checks - before} checks)`);
}

// The file is evaluated exactly as the browser receives it, in a context that has only a `window`.
const source = await fs.readFile(path.join(bundleRoot, 'web', 'ui-logic.js'), 'utf8');
const sandbox = { URL }; // the few globals every browser has and a bare vm context does not
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'ui-logic.js' });
const ui = sandbox.ChatMcpUi;
check(ui && typeof ui.readiness === 'function', 'ui-logic.js publishes window.ChatMcpUi');
check(Object.isFrozen(ui), 'the published API cannot be replaced from the page');

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-ui-logic-'));
const root = await fs.realpath(temp);
let manager = null;

try {
// ==================================================================== 1. no drift from the server
await section('the page and the server share one vocabulary', async () => {
  equal(Object.keys(ui.STATES), [...TASK_STATES], 'the page knows exactly the server\'s task states, in the same order');
  for (const state of TASK_STATES) equal(ui.STATES[state], TASK_STATE_INFO[state], `${state}: label, tone and hint are identical`);
  equal([...ui.ACTIVE].sort(), [...ACTIVE_STATES].sort(), 'the same states count as "a run is in progress"');
  for (const state of TASK_STATES) check(ui.isActiveState(state) === ACTIVE_STATES.has(state), `${state}: active or resting agrees with the server`);
  equal(ui.PERMISSION_MODES.map((mode) => mode.id), [...PERMISSION_MODES], 'permission modes match the gate, in the same order');
  equal(ui.PROTOCOLS.map((protocol) => protocol.id).sort(), [...FORMATS].sort(), 'protocols match what the gateway accepts');
  equal([...ui.AUTH_MODES].sort(), [...AUTH_MODES].sort(), 'authentication modes match what the gateway accepts');
  for (const mode of ui.PERMISSION_MODES) check(mode.label && mode.hint.length > 20 && ['low', 'medium', 'high'].includes(mode.risk), `${mode.id}: has a label, an explanation and a risk level`);
  equal(ui.PERMISSION_MODES.map((mode) => mode.risk), ['low', 'medium', 'high'], 'the modes run from least to most permissive');
  for (const category of ['read', 'checkpoint', 'workspace_edit', 'execute', 'dangerous', 'unknown']) check(ui.CATEGORY[category]?.label, `category ${category} has a label`);
});

// ==================================================================== 2. task state presentation
await section('a task is shown by its canonical state, with a fallback for old records', async () => {
  for (const state of TASK_STATES) {
    const view = ui.describeTask({ state, status: 'running' });
    equal([view.state, view.label, view.hint], [state, TASK_STATE_INFO[state].label, TASK_STATE_INFO[state].hint], `${state}: shown by its own state, not by the legacy status`);
    check(['neutral', 'working', 'attention', 'warn', 'success', 'error'].includes(view.kind), `${state}: has a badge kind`);
  }
  equal(ui.describeTask({ state: 'uncertain', status: 'failed' }).state, 'uncertain', 'an uncertain task is never shown as failed');
  equal(ui.describeTask({ state: 'waiting_approval', status: 'running' }).kind, 'attention', 'waiting for a person stands out');
  const legacy = { preparing: 'queued', queued: 'queued', running: 'running', completed: 'completed', cancelled: 'cancelled', failed: 'failed', paused: 'paused', interrupted: 'paused', limit: 'paused' };
  for (const [status, state] of Object.entries(legacy)) equal(ui.taskState({ status }), state, `legacy status ${status} → ${state}`);
  equal(ui.describeTask({ status: 'limit' }).label, 'Đạt giới hạn', 'a legacy limit keeps its precise name');
  equal(ui.describeTask({ status: 'interrupted' }).label, 'Gián đoạn', 'a legacy interruption keeps its name');
  equal(ui.describeTask({ state: 'paused', status: 'limit' }).label, TASK_STATE_INFO.paused.label, 'a record that has a state uses the state\'s name');
  equal(ui.taskState({ state: 'nonsense', status: 'completed' }), 'completed', 'an unknown state falls back to the status');
  for (const bad of [null, undefined, 'x', 3, [], {}, { status: 'weird' }]) equal(ui.taskState(bad), null, `no state for ${JSON.stringify(bad)}`);
  equal(ui.describeTask(null).label, 'Sẵn sàng', 'no task: ready');
  check(ui.describeTask({ status: 'running' }).active && !ui.describeTask({ status: 'completed' }).active, 'active flag follows the state');
});

// ==================================================================== 3. readiness
const localHub = (patch = {}) => ({
  version: '2.3.0', backend: 'local', catalogReady: true, workspace: { path: '/work/proj' },
  services: { local: { state: 'ready', detail: '18 công cụ cục bộ' }, docker: { state: 'disabled' }, cloud: { state: 'disabled' }, proxy: { state: 'disabled' }, desktop: { state: 'disabled' } },
  agent: { mode: 'api', activeTaskId: null, active: null, tasks: [] },
  ai: { configured: true, provider: 'gateway' }, browser: { paired: false },
  studio: { permissions: { mode: 'review', pending: [] } },
  ...patch,
});
const mcpHub = (patch = {}) => ({
  version: '2.3.0', workspace: { path: 'C:\\Projects\\lab' },
  services: Object.fromEntries(['docker', 'cloud', 'proxy', 'desktop'].map((name) => [name, { state: 'ready' }])),
  agent: { mode: 'chatgpt-web', activeTaskId: null, active: null, tasks: [] },
  ai: { configured: true }, browser: { paired: true }, studio: { permissions: { mode: 'review', pending: [] } },
  ...patch,
});
const ids = (r) => r.blockers.map((blocker) => blocker.id);

await section('readiness: local backend', async () => {
  let r = ui.readiness(localHub());
  equal([r.ready, r.startsTools, r.mode, r.backend, ids(r)], [true, false, 'api', 'local', []], 'configured and started: nothing in the way');
  // The regression: proxy and desktop are "disabled" in local mode and must not be treated as "not ready".
  r = ui.readiness(localHub({ services: { ...localHub().services, local: { state: 'stopped', detail: 'Chưa khởi động' } }, catalogReady: false }));
  equal([r.ready, r.startsTools, ids(r)], [true, true, []], 'tools stopped: the prompt starts them, it is not a blocker');
  r = ui.readiness(localHub({ services: { ...localHub().services, local: { state: 'error', detail: 'git không chạy' } } }));
  equal([r.ready, r.startsTools], [true, true], 'tools in error: sending retries the start');
  r = ui.readiness(localHub({ services: { ...localHub().services, local: { state: 'starting' } } }));
  equal([r.ready, ids(r), r.blockers[0].fix], [false, ['tools-starting'], 'wait'], 'tools starting: wait, do not start a second time');
  r = ui.readiness(localHub({ workspace: { path: null } }));
  equal([r.ready, ids(r), r.blockers[0].fix], [false, ['workspace'], 'workspace'], 'no workspace: pick one');
  r = ui.readiness(localHub({ workspace: undefined }));
  equal(ids(r), ['workspace'], 'a missing workspace object is the same as none');
  r = ui.readiness(localHub({ ai: { configured: false } }));
  equal([r.ready, ids(r), r.blockers[0].fix], [false, ['ai'], 'ai'], 'AI not configured: configure it');
  r = ui.readiness(localHub({ agent: {} }));
  equal(r.mode, 'api', 'local backend with no saved mode means API');
  r = ui.readiness(localHub({ agent: { mode: 'chatgpt-web' }, ai: { configured: false } }));
  equal(ids(r), ['companion'], 'ChatGPT Web mode needs the companion, not an API key');
  r = ui.readiness(localHub({ agent: { mode: 'chatgpt-web' }, browser: { paired: true } }));
  equal(r.ready, true, 'ChatGPT Web mode with a paired companion is ready');
  r = ui.readiness(localHub({ workspace: { path: null }, ai: { configured: false } }));
  equal(ids(r), ['workspace', 'ai'], 'several things to fix are listed in the order to fix them');
  r = ui.readiness(localHub(), { connected: false });
  equal([ids(r), r.blockers[0].fix], [['connection'], 'retry'], 'no connection to the Hub');
  r = ui.readiness(localHub(), { mismatch: true });
  equal([ids(r), r.blockers[0].fix], [['version'], 'restart'], 'UI and Hub of different versions: restart the Hub');
  r = ui.readiness(localHub(), { wrongTransport: 'chatgpt-web' });
  equal([ids(r), r.blockers[0].fix], [['mode'], 'mode'], 'a conversation from the other mode cannot be continued here');
  for (const blocker of ui.readiness(localHub({ workspace: undefined, ai: { configured: false } }), { connected: false, mismatch: true, wrongTransport: 'api' }).blockers) check(['retry', 'restart', 'workspace', 'ai', 'companion', 'mode', 'wait'].includes(blocker.fix) && blocker.label.length > 10, `blocker ${blocker.id} names a fix and says it in words`);
  equal(ui.toolsState(localHub({ catalogReady: false })).ready, false, 'a ready service with an empty catalog is not ready');
});

await section('readiness: legacy MCP backend (no "backend" field, as in older Hubs and the mock API)', async () => {
  let r = ui.readiness(mcpHub());
  equal([r.ready, r.startsTools, r.mode, r.backend], [true, false, 'chatgpt-web', 'mcp'], 'proxy and desktop ready');
  r = ui.readiness(mcpHub({ services: { ...mcpHub().services, proxy: { state: 'stopped' }, desktop: { state: 'stopped' } } }));
  equal([r.ready, r.startsTools], [true, true], 'MCP stopped: the prompt starts it (the older, still-supported behaviour)');
  r = ui.readiness(mcpHub({ services: { ...mcpHub().services, desktop: { state: 'stopped' } } }));
  equal(r.startsTools, true, 'one of the two stopped is enough to start');
  r = ui.readiness(mcpHub({ services: { ...mcpHub().services, proxy: { state: 'starting' } } }));
  equal(ids(r), ['tools-starting'], 'starting: wait');
  r = ui.readiness(mcpHub({ browser: { paired: false } }));
  equal(ids(r), ['companion'], 'ChatGPT Web without a companion');
  r = ui.readiness(mcpHub({ agent: { mode: 'api' }, ai: { configured: false } }));
  equal(ids(r), ['ai'], 'API mode without a configured model');
  equal(ui.backendOf(null), 'mcp', 'no data: treated as the legacy backend');
  equal(ui.readiness(null).ready, false, 'no Hub data at all is never ready');
});

await section('the line under the composer says what matters', async () => {
  const ready = ui.readiness(localHub());
  check(/Enter để gửi/.test(ui.composerHint(ready)), 'ready: how to send');
  check(/tự khởi động/.test(ui.composerHint(ui.readiness(localHub({ services: { ...localHub().services, local: { state: 'stopped' } } })))), 'tools stopped: says the prompt starts them');
  equal(ui.composerHint(ui.readiness(localHub({ ai: { configured: false } }))), ui.readiness(localHub({ ai: { configured: false } })).blockers[0].label, 'blocked: the first thing to fix');
  check(/đang chạy/i.test(ui.composerHint(ready, { running: true })), 'running: says so');
  check(/chờ bạn duyệt/i.test(ui.composerHint(ready, { running: true, pending: 1 })) && !/Dừng/.test(ui.composerHint(ready, { running: true, pending: 1 })), 'running with an approval waiting: points at the request instead of suggesting to stop');
  check(/chờ Hub/i.test(ui.composerHint(ready, { connected: false })), 'offline: says so');
});

// ==================================================================== 4. permission modes
await section('permission modes: names, the old alias, and safe fallbacks', async () => {
  equal(ui.normalizeMode('manual'), 'review', 'the old name "manual" is review');
  for (const mode of PERMISSION_MODES) equal(ui.normalizeMode(mode), mode, `${mode} stays`);
  for (const bad of [undefined, null, '', 'root', 'FULL ACCESS', 3]) equal(ui.normalizeMode(bad), 'review', `${JSON.stringify(bad)} falls back to the safe default, never to something more permissive`);
  equal(ui.modeInfo('manual').id, 'review', 'modeInfo resolves aliases');
});

// ==================================================================== 5. approvals, from the real gate
await section('what an approval asks for, from requests made by the real gate', async () => {
  const project = path.join(root, 'proj');
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, 'calc.js'), 'exports.add = (a, b) => a - b;\n');
  await fs.writeFile(path.join(project, 'package.json'), '{"name":"demo","scripts":{"test":"node check.js"}}\n');
  manager = new HubManager({ dataDirectory: path.join(root, 'data'), bundleRoot, log: () => {} });
  assembleStudio(manager, { bundleRoot });
  await manager.permissions.load();
  await manager.load(project);
  await manager.start();
  const gate = manager.permissions;
  gate.configure({ mode: 'review' });
  const SECRET = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const longCommand = `node scripts/build.js ${'a'.repeat(3000)}`; // not "echo": a read-only command is never put to the person
  const asks = [
    ['local.run_command', { command: 'npm test', description: 'chạy bộ test' }],
    ['local.run_command', { command: longCommand }],
    ['local.run_command', { command: 'rm -rf build' }],
    ['local.run_command', { command: `curl -H "Authorization: Bearer ${SECRET}" https://example.invalid` }],
    ['local.write_file', { path: 'notes/new.txt', content: 'xin chào\n'.repeat(200), overwrite: true }],
    ['local.write_file', { path: 'notes/other.txt', content: 'x' }],
    ['local.edit_file', { path: 'calc.js', old_string: 'a - b', new_string: 'a + b', replace_all: true }],
    ['local.git_commit', { message: 'fix add' }],
    ['local.delete_path', { path: 'calc.js' }],
    ['desktop-commander.write_file', { path: 'x.txt', content: 'x' }],
  ];
  const pending = asks.map(([name, args]) => gate.authorize({ name, args, taskId: '11111111-1111-4111-8111-111111111111' }).catch((error) => error));
  const waitUntil = Date.now() + 15_000;
  while (gate.state().pending.length < asks.length) {
    if (Date.now() > waitUntil) throw new Error(`Only ${gate.state().pending.length} of ${asks.length} calls reached the person: ${gate.state().pending.map((request) => request.toolName).join(', ')}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const list = gate.state().pending;
  const described = list.map((request) => ui.describeApproval(request, Date.parse(request.at)));
  const by = (predicate) => described.find(predicate);
  for (const entry of described) {
    check(entry.id && entry.taskId && entry.tool && entry.title && entry.categoryLabel, `${entry.tool}: id, task, tool, title and category are shown`);
    check(['low', 'medium', 'high'].includes(entry.risk), `${entry.tool}: has a risk level`);
    check(entry.secondsLeft > 0 && entry.secondsLeft <= gate.timeout / 1000, `${entry.tool}: knows how long the request will wait`);
  }
  equal(list.every((request) => Date.parse(request.expiresAt) - Date.parse(request.at) === gate.timeout), true, 'the gate reports when each request expires');
  equal(gate.state().approvalTimeoutMs, gate.timeout, 'and the timeout itself');

  const npm = by((entry) => entry.kind === 'command' && entry.blocks[0].text === 'npm test');
  equal([npm.title, npm.category, npm.risk], ['Chạy lệnh trên máy của bạn', 'workspace_edit', 'medium'], 'npm test: a command, but a check');
  check(npm.rows.some((row) => row.label === 'Phân loại' && /kiểm tra/.test(row.value)), 'npm test: shown as a check command');
  check(npm.rows.some((row) => row.label === 'Agent mô tả' && row.value === 'chạy bộ test'), 'the agent\'s own description is shown as the agent\'s');
  check(npm.rows.some((row) => row.label === 'Thư mục'), 'the working directory is shown');

  const long = by((entry) => entry.kind === 'command' && entry.blocks[0].text === longCommand);
  check(long, 'a 3000-character command is shown whole, not as a prefix');

  const rm = by((entry) => entry.kind === 'command' && /rm -rf build/.test(entry.blocks[0].text));
  equal([rm.category, rm.risk], ['dangerous', 'high'], 'rm -rf: dangerous, high risk');
  check(rm.rows.some((row) => row.label === 'Phân loại' && /nguy hiểm/.test(row.value)), 'and says why in words');

  const curl = by((entry) => entry.kind === 'command' && /curl/.test(entry.blocks[0].text));
  check(!JSON.stringify(curl).includes(SECRET), 'a credential in a command is masked before it reaches the page');

  const write = by((entry) => entry.kind === 'write' && /new\.txt/.test(entry.rows[0].value));
  equal([write.title, write.rows[0].value], ['Ghi file', 'notes/new.txt'], 'write: the path');
  check(write.rows.some((row) => row.label === 'Kích thước' && /byte/.test(row.value)), 'write: the size');
  check(write.rows.some((row) => row.label === 'Ghi đè' && /^Có/.test(row.value)), 'write with overwrite: says it replaces the whole file');
  check(write.blocks[0].label === 'Nội dung (phần đầu)' && write.blocks[0].text.length <= 700, 'write: only the start of the content is shown, and it says so');
  const writeSafe = by((entry) => entry.kind === 'write' && /other\.txt/.test(entry.rows[0].value));
  check(writeSafe.rows.some((row) => row.label === 'Ghi đè' && /^Không/.test(row.value)), 'write without overwrite: says it will not replace a file by accident');

  const edit = by((entry) => entry.kind === 'edit');
  equal([edit.title, edit.blocks.map((block) => block.kind), edit.blocks.map((block) => block.text)], ['Sửa file', ['before', 'after'], ['a - b', 'a + b']], 'edit: old and new text side by side');
  check(edit.rows.some((row) => row.label === 'Phạm vi' && /TẤT CẢ/.test(row.value)), 'edit with replace_all: says ALL matches');

  const commit = by((entry) => entry.tool === 'local.git_commit');
  equal([commit.kind, commit.title, commit.category], ['tool', 'Gọi công cụ local.git_commit', 'workspace_edit'], 'other local tools: their name and arguments');
  check(/fix add/.test(commit.blocks[0].text), 'git commit: the message is visible');
  const remove = by((entry) => entry.tool === 'local.delete_path');
  equal([remove.category, remove.risk], ['dangerous', 'high'], 'delete: dangerous');
  const external = by((entry) => entry.tool === 'desktop-commander.write_file');
  equal(external.kind, 'raw', 'a tool without structured detail falls back to its preview');
  check(/x\.txt/.test(external.blocks[0].text), 'and the preview shows its arguments');

  // Nothing in a description is anything but text.
  for (const entry of described) {
    for (const row of entry.rows) check(typeof row.label === 'string' && typeof row.value === 'string', 'rows are plain strings');
    for (const block of entry.blocks) check(typeof block.text === 'string', 'blocks are plain strings');
  }
  // Time left
  const sample = list[0];
  equal(ui.describeApproval(sample, Date.parse(sample.expiresAt) - 61_000).secondsLeft, 61, 'time left is counted from the gate\'s expiry');
  equal(ui.describeApproval(sample, Date.parse(sample.expiresAt) + 5000).secondsLeft, 0, 'never negative');
  equal([ui.countdown(61), ui.countdown(600), ui.countdown(9), ui.countdown(0), ui.countdown(NaN), ui.countdown(null)], ['1:01', '10:00', '0:09', '0:00', '', ''], 'countdown text');
  equal(ui.describeApproval({}).kind, 'raw', 'an empty request does not break the page');
  equal(ui.describeApproval(null).category, 'unknown', 'neither does a missing one');
  equal(ui.describeApproval({ category: 'surprise', toolName: 'x' }).risk, 'high', 'an unknown category is treated as high risk');

  // Tab title
  const hubWith = (count, active) => ({ studio: { permissions: { pending: new Array(count).fill({}) } }, agent: { activeTaskId: active } });
  equal([ui.documentTitle(hubWith(2, 'a')), ui.documentTitle(hubWith(0, 'a')), ui.documentTitle(hubWith(0, null)), ui.documentTitle(null)], ['(2) Cần duyệt — ChatMCP Studio', 'Đang chạy — ChatMCP Studio', 'ChatMCP Studio', 'ChatMCP Studio'], 'the tab title announces approvals and runs');

  // Leave nothing waiting: deny them all, and see that the gate says so.
  for (const request of list) gate.decide(request.id, false);
  const outcomes = await Promise.all(pending);
  check(outcomes.every((outcome) => outcome.allowed === false), 'all requests were denied cleanly');
});

// ==================================================================== 6. the AI connection form
await section('every preset, filled in by the form logic, is accepted by the real gateway', async () => {
  const keyEnv = { ANTHROPIC_API_KEY: 'sk-ant-env-0123456789abcdef' };
  const provider = new GatewayProvider({ directory: path.join(root, 'gateway'), bundleRoot, manager: { secrets: [] }, fetchImpl: async () => { throw new Error('no network in this test'); }, env: keyEnv });
  const presets = publicPresets(keyEnv);
  check(presets.length >= 10, 'the Hub offers a real list of providers');
  for (const preset of presets) {
    const draft = ui.draftFromPreset(preset, null);
    equal([draft.preset, draft.protocol, draft.apiBaseUrl, draft.model, draft.apiKey, draft.useEnvKey], [preset.id, preset.protocol, preset.apiBaseUrl, preset.defaultModel, '', false], `${preset.id}: the form starts from the preset's own values and no key`);
    // Custom providers have nothing to start from; the person fills in the endpoint and the model.
    if (!draft.apiBaseUrl) draft.apiBaseUrl = 'https://llm.example.invalid/v1';
    if (!draft.model) draft.model = 'my-model';
    const problems = ui.validateDraft(draft, preset, { keySource: 'none' });
    const local = preset.local;
    equal(problems.map((problem) => problem.field), local ? [] : ['apiKey'], `${preset.id}: the form asks for exactly what is missing (${local ? 'a local server needs no key' : 'the key'})`);
    if (!local) draft.apiKey = 'sk-test-0123456789abcdef';
    equal(ui.validateDraft(draft, preset, { keySource: 'none' }), [], `${preset.id}: complete`);
    const payload = ui.configPayload(draft);
    const accepted = provider.validateConfiguration(payload);
    equal([accepted.ok, accepted.protocol, accepted.model, accepted.keyProvided || local], [true, preset.protocol, draft.model, true], `${preset.id}: the real gateway accepts the form's payload`);
    check(!JSON.stringify(accepted).includes('sk-test-0123456789abcdef'), `${preset.id}: the key is not echoed back`);
  }
  // Using the key the Hub found in the environment
  const anthropic = presets.find((preset) => preset.id === 'anthropic');
  check(anthropic.envKey === 'ANTHROPIC_API_KEY', 'the Hub reports the NAME of the variable it found, not its value');
  const draft = ui.draftFromPreset(anthropic, null);
  draft.useEnvKey = true;
  equal(ui.validateDraft(draft, anthropic, { keySource: 'none' }), [], 'choosing the environment key satisfies the form');
  const envPayload = ui.configPayload(draft);
  equal([envPayload.useEnvKey, 'apiKey' in envPayload], [true, false], 'the payload asks for the environment key and carries no key');
  const envAccepted = provider.validateConfiguration(envPayload);
  equal([envAccepted.keyFromEnvironment, envAccepted.keyProvided], [true, true], 'the real gateway resolves it');
  draft.apiKey = 'sk-ant-typed-0123456789abcdef';
  const typed = ui.configPayload(draft);
  equal([typed.apiKey, 'useEnvKey' in typed], ['sk-ant-typed-0123456789abcdef', false], 'a typed key wins over the environment key');
});

await section('the form: validation, payload and key handling', async () => {
  const preset = { id: 'openai', local: false };
  const base = { preset: 'openai', protocol: 'openai-chat', apiBaseUrl: 'https://api.openai.com/v1', model: 'gpt-5-mini', authMode: 'auto', customPath: '', contextWindowTokens: '', apiKey: '', useEnvKey: false, remember: false };
  const fields = (draft, ai = { keySource: 'none' }, p = preset) => ui.validateDraft(draft, p, ai).map((problem) => problem.field);
  equal(fields(base), ['apiKey'], 'a hosted provider needs a key');
  equal(fields(base, { keySource: 'saved', apiBaseUrl: 'https://api.openai.com/v1', preset: 'openai' }), [], 'a stored key for the same provider is enough');
  equal(fields(base, { keySource: 'saved', apiBaseUrl: 'https://other.example/v1', preset: 'openai' }), ['apiKey'], 'a stored key is NOT carried to another host');
  equal(fields(base, { keySource: 'saved', apiBaseUrl: 'https://api.openai.com/v1', preset: 'gemini' }), ['apiKey'], 'nor to another provider');
  equal(fields({ ...base, apiKey: ' ' }), ['apiKey'], 'a blank key is no key');
  equal(fields({ ...base, apiBaseUrl: '' , apiKey: 'sk-test-0123456789'}), ['apiBaseUrl'], 'a missing URL');
  equal(fields({ ...base, apiBaseUrl: 'ftp://x', apiKey: 'sk-test-0123456789' }), ['apiBaseUrl'], 'a URL that is not http(s)');
  equal(fields({ ...base, model: ' ', apiKey: 'sk-test-0123456789' }), ['model'], 'a missing model');
  equal(fields({ ...base, contextWindowTokens: '12k', apiKey: 'sk-test-0123456789' }), ['contextWindowTokens'], 'a context window that is not a number');
  equal(fields({ ...base, apiBaseUrl: 'http://localhost:11434/v1', preset: 'custom-openai' }, { keySource: 'none' }, { id: 'custom-openai', local: false }), [], 'a custom endpoint on localhost needs no key');
  equal(fields({ ...base, apiBaseUrl: 'http://127.0.0.1:8080/v1' }), [], 'neither does 127.0.0.1');
  equal(fields({ ...base, apiBaseUrl: 'http://localhost.evil.example/v1' }), ['apiKey'], 'but a host that merely starts with "localhost" does');
  const payload = ui.configPayload({ ...base, apiKey: '  sk-test-0123456789  ', contextWindowTokens: ' 32768 ', remember: true, model: ' gpt-5-mini ', apiBaseUrl: ' https://api.openai.com/v1 ' });
  equal([payload.apiKey, payload.contextWindowTokens, payload.remember, payload.model, payload.apiBaseUrl], ['sk-test-0123456789', 32768, true, 'gpt-5-mini', 'https://api.openai.com/v1'], 'the payload is trimmed and typed');
  const noKey = ui.configPayload(base);
  equal(['apiKey' in noKey, 'useEnvKey' in noKey, noKey.contextWindowTokens], [false, false, null], 'an empty key field never sends (and so never erases) a key; an empty window clears it');
  equal('preset' in ui.configPayload({ ...base, preset: '' }), false, 'no preset: none is sent');
  // draftFromState round trip
  const state = { preset: 'ollama', protocol: 'openai-chat', apiBaseUrl: 'http://localhost:11434/v1', model: 'qwen2.5-coder:7b', authMode: 'auto', customPath: '', contextWindowTokens: 32768 };
  equal(ui.draftFromState(state), { preset: 'ollama', protocol: 'openai-chat', apiBaseUrl: 'http://localhost:11434/v1', model: 'qwen2.5-coder:7b', authMode: 'auto', customPath: '', contextWindowTokens: '32768', apiKey: '', useEnvKey: false, remember: false }, 'the form reflects what the Hub has');
  equal(ui.draftFromState(null).protocol, 'gemini', 'and survives having nothing');
  equal(ui.draftFromPreset({ id: 'x', protocol: 'anthropic', apiBaseUrl: 'https://a', defaultModel: 'm', contextWindowTokens: 200000 }, { remember: true }).remember, true, 'the "remember" choice survives switching provider');
  equal(ui.draftFromPreset({ id: 'x', contextWindowTokens: null }, null).contextWindowTokens, '', 'a preset with no known window leaves it empty');
});

await section('tool-calling badge, key status, model list', async () => {
  const cases = { supported: 'success', unsupported: 'error', unreliable: 'warn', unknown: 'neutral', unchecked: 'neutral' };
  for (const [status, kind] of Object.entries(cases)) equal(ui.toolCallingBadge({ toolCalling: status, toolCallingNote: 'ghi chú' }).kind, kind, `tool calling ${status} → ${kind}`);
  check(/Test API/.test(ui.toolCallingBadge({}).label), 'unchecked tells the person how to check');
  check(/không hỗ trợ/.test(ui.toolCallingBadge({ toolCalling: 'unsupported' }).label), 'unsupported says so plainly');
  equal(ui.toolCallingBadge({ toolCalling: 'unreliable', toolCallingNote: 'n' }).note, 'n', 'the Hub\'s explanation is passed through');
  equal(ui.toolCallingBadge({ toolCalling: 'bogus' }).status, 'unchecked', 'an unknown value is "unchecked"');
  equal(ui.keyStatus({ keySource: 'saved', secretStorage: { protection: 'Windows DPAPI' } }).text, 'Key đã lưu (Windows DPAPI).', 'saved key');
  equal(ui.keyStatus({ keySource: 'environment' }).kind, 'success', 'environment key');
  equal(ui.keyStatus({ keySource: 'session' }).kind, 'warn', 'a session-only key warns that it is lost on exit');
  equal(ui.keyStatus({ keySource: 'none', keyRequired: false }).kind, 'neutral', 'a local server needs none');
  equal(ui.keyStatus({ keySource: 'none', keyRequired: true }).kind, 'error', 'a hosted provider with no key is an error');
  equal(ui.keyStatus(null).source, 'none', 'nothing at all');
  const choices = ui.modelChoices([{ id: 'a' }, { id: 'b' }, { id: '' }, null, 'x'], 'b');
  equal([choices.ids, choices.currentListed, choices.onlyConfigured], [['a', 'b'], true, false], 'model choices ignore junk entries');
  equal(ui.modelChoices([{ id: 'm', configured: true, listed: false }], 'm').onlyConfigured, true, 'a list that is only the configured model means the provider could not be asked');
  equal(ui.modelChoices(undefined, 'm').ids, [], 'no list');
});

// ==================================================================== 7. evidence, errors, onboarding
await section('evidence, error actions, first-run guidance', async () => {
  equal(ui.evidenceSummary(null), null, 'no workflow record: nothing claimed');
  let evidence = ui.evidenceSummary({ editsObserved: 2, checksObserved: 1, verified: true });
  equal([evidence.verified, evidence.kind], [true, 'success'], 'a passing check is verification');
  check(/2 thao tác sửa/.test(evidence.text) && /đạt \(exit code 0\)/.test(evidence.text), 'and the text says how many edits and checks');
  evidence = ui.evidenceSummary({ editsObserved: 3, checksObserved: 0, verified: false });
  equal([evidence.verified, evidence.kind], [false, 'warn'], 'edits without a passing check are a warning, not a success');
  check(/CHƯA có lệnh kiểm tra/.test(evidence.text), 'and the text says it plainly');
  equal(ui.evidenceSummary({ editsObserved: 0, checksObserved: 0, verified: false }).kind, 'neutral', 'a read-only task needs no check');
  equal(ui.evidenceSummary({ editsObserved: 1, checksObserved: 2, verified: 'yes' }).verified, false, 'only a real true counts as verified');
  evidence = ui.evidenceSummary({ editsObserved: 0, commandsObserved: 2, checksObserved: 0, verified: false });
  equal([evidence.edits, evidence.commands, evidence.kind], [0, 2, 'warn'], 'shell commands that may have changed files are a warning, never "no change"');
  check(/2 lệnh shell có thể đã thay đổi file/.test(evidence.text) && !/Chưa sửa file nào/.test(evidence.text), 'and the text does not claim that no file was touched');
  evidence = ui.evidenceSummary({ editsObserved: 1, commandsObserved: 1, checksObserved: 1, verified: true });
  check(/1 thao tác sửa file/.test(evidence.text) && /1 lệnh shell/.test(evidence.text) && /đạt \(exit code 0\)/.test(evidence.text), 'edits, commands and checks are reported separately');
  equal(ui.evidenceSummary({ editsObserved: 1, checksObserved: 0, verified: false }).commands, 0, 'an older record without commandsObserved counts as none');
  const toolEvent = (type, payload) => ({ type, message: JSON.stringify(payload, null, 2), toolName: 'local.run_command' });
  equal(ui.eventText(toolEvent('tool_result', { isError: false, content: [{ type: 'text', text: 'exit code 0 · bash · 0.1s\nadd() ok' }], structuredContent: { exitCode: 0 } })), 'exit code 0 · bash · 0.1s\nadd() ok', 'a tool result shows the text inside it, not the JSON');
  equal(ui.eventText(toolEvent('tool_error', { isError: true, content: [{ type: 'text', text: 'Permission denied: x' }] })), 'Permission denied: x', 'so does a tool error');
  equal(ui.eventText({ type: 'tool_result', message: '{ "isError": false, "content": [ { "type": "text", "text": "cut o' }), '{ "isError": false, "content": [ { "type": "text", "text": "cut o', 'a cut-off result is shown as it is');
  equal(ui.eventText({ type: 'assistant', message: '{"content":[{"text":"x"}]}' }), '{"content":[{"text":"x"}]}', 'only tool events are unwrapped');
  equal(ui.eventText({ type: 'model', message: 'a'.repeat(50) }, 10), 'a'.repeat(10) + '…', 'long text is clipped');
  equal([ui.eventText(null), ui.eventText({ type: 'completed' }), ui.eventText({ message: 5 })], ['', 'completed', ''], 'missing or odd events never throw');
  equal(ui.reasonText('approval:local.edit_file'), 'Chờ bạn duyệt: local.edit_file', 'an approval reason names the tool in words');
  equal(ui.reasonText('check:local.run_command'), 'Đang chạy kiểm tra: local.run_command', 'a check reason is in words');
  equal(ui.reasonText('act:local.write_file'), 'Đang thực hiện: local.write_file', 'an action reason is in words');
  equal(ui.reasonText('approval_denied'), 'Bạn đã từ chối', 'a plain reason is translated');
  equal([ui.reasonText('some_new_code'), ui.reasonText(''), ui.reasonText(null), ui.reasonText({ x: 1 })], ['some_new_code', '', '', ''], 'an unknown code is shown as it is, a non-string as nothing');
  for (const code of ['task_created', 'start_requested', 'continue_requested', 'preflight_done', 'approval_approved', 'approval_denied', 'approval_expired', 'approval_cancelled', 'check_finished', 'final_answer', 'user_cancelled', 'time_limit', 'step_limit', 'hub_restarted', 'persistence_failed']) check(ui.reasonText(code) !== code && /[ạ-ỹà-ỵ ]/i.test(ui.reasonText(code)), `${code} has a Vietnamese text`);
  for (const code of ['gateway_auth', 'gateway_quota', 'gateway_model_not_found', 'provider_not_ready', 'gateway_context_length']) equal(ui.errorFix(code), 'ai', `${code}: fixed in the AI settings`);
  for (const code of ['workspace_missing', 'workspace_changed']) equal(ui.errorFix(code), 'workspace', `${code}: fixed by choosing the folder`);
  for (const code of ['step_limit', 'time_limit', undefined, null, 'whatever']) equal(ui.errorFix(code), null, `${code}: nothing to fix in a screen`);

  let o = ui.onboarding(localHub({ workspace: { path: null }, ai: { configured: false } }));
  equal([o.shouldOpen, o.complete, o.current], [true, false, 'workspace'], 'a fresh local install starts with the folder');
  o = ui.onboarding(localHub({ ai: { configured: false } }));
  equal([o.shouldOpen, o.current, o.steps.find((s) => s.id === 'workspace').done], [true, 'ai', true], 'folder chosen, model missing: continue at the model');
  o = ui.onboarding(localHub());
  equal([o.shouldOpen, o.complete, o.current], [false, true, 'safety'], 'everything set: no wizard');
  o = ui.onboarding(localHub({ ai: { configured: false } }), { dismissed: true });
  equal(o.shouldOpen, false, 'dismissed: never opens by itself again');
  o = ui.onboarding(mcpHub({ ai: { configured: false }, browser: { paired: false } }));
  equal(o.shouldOpen, false, 'the legacy backend never gets the wizard');
  o = ui.onboarding(localHub({ agent: { mode: 'chatgpt-web' }, browser: { paired: false } }));
  equal([o.shouldOpen, o.steps.find((s) => s.id === 'ai').title], [true, 'Ghép Companion'], 'ChatGPT Web mode asks for the companion instead');
  o = ui.onboarding(localHub({ services: { ...localHub().services, local: { state: 'stopped' } } }));
  equal(o.steps.find((s) => s.id === 'workspace').done, false, 'a folder whose tools are not up is not "done"');
  equal(o.complete, true, 'but a task can still be sent (the prompt starts the tools)');
});

// ==================================================================== 7b. resuming after a stop
await section('what the page calls "unconfirmed" is what the server calls an unknown outcome', async () => {
  const { hasUnknownOutcome, restState } = await import('../lib/task-state.mjs');
  const call = (patch = {}) => ({ callId: 'c1', toolName: 'write_file', phase: 'executing', readOnly: false, startedAt: '2026-01-01T10:00:00.000Z', ...patch });
  const cases = [
    ['a write in flight', { status: 'failed', pendingCall: call() }, true],
    ['a command in flight', { status: 'running', pendingCall: call({ toolName: 'run_command' }) }, true],
    ['a read in flight', { status: 'failed', pendingCall: call({ toolName: 'read_file', readOnly: true }) }, false],
    ['a call still waiting for approval', { status: 'running', pendingCall: call({ phase: 'awaiting_approval' }) }, false],
    ['a refused call', { status: 'failed', pendingCall: call({ phase: 'refused' }) }, false],
    ['an unverified write from an earlier run', { status: 'paused', unverifiedOperations: [call()] }, true],
    ['an unverified read from an earlier run', { status: 'paused', unverifiedOperations: [call({ readOnly: true })] }, false],
    ['nothing recorded', { status: 'failed' }, false],
  ];
  for (const [name, task, expected] of cases) {
    equal([hasUnknownOutcome(task), ui.unconfirmedOperations(task).length > 0], [expected, expected], `${name}: the server and the page agree (${expected ? 'unknown' : 'known'})`);
  }
  const both = { status: 'failed', pendingCall: call(), unverifiedOperations: [call(), call({ callId: 'c2', toolName: 'run_command' })] };
  equal(ui.unconfirmedOperations(both).map((operation) => operation.tool), ['write_file', 'run_command'], 'the same call is listed once, in the order it happened');
  equal(ui.unconfirmedOperations(null), [], 'no task, nothing to list');
  equal(ui.unconfirmedOperations({ pendingCall: 'garbage', unverifiedOperations: [null, 7, 'x'] }), [], 'malformed records are ignored, not shown');
  // The state the page would show for these records is the one the server derives.
  for (const [name, task] of cases) check(ui.taskState({ ...task, state: restState(task) }) === restState(task), `${name}: state ${restState(task)} is shown as itself`);
});

await section('the message that continues a stopped task', async () => {
  const uncertain = { state: 'uncertain', status: 'failed', pendingCall: { callId: 'c1', toolName: 'write_file', phase: 'executing' }, unverifiedOperations: [{ callId: 'c0', toolName: 'run_command', phase: 'executing' }] };
  const afterUncertain = ui.resumePrompt(uncertain);
  check(/write_file/.test(afterUncertain) && /run_command/.test(afterUncertain), 'names the steps whose outcome is unknown');
  check(/Đừng giả định/.test(afterUncertain) && /git status/.test(afterUncertain) && /git diff/.test(afterUncertain), 'tells the model to look at the project before assuming anything');
  check(!/chạy lại|thử lại thao tác/.test(afterUncertain), 'never tells the model to repeat the unknown step');
  const afterPause = ui.resumePrompt({ state: 'paused', status: 'paused' });
  check(/tiếp tục/i.test(afterPause) && /git status/.test(afterPause), 'an ordinary pause: continue, after checking the project');
  check(ui.resumePrompt(null).length > 20 && ui.resumePrompt({ state: 'uncertain' }).length > 20, 'always returns a usable message, even for an empty record');
  check(!/<|>/.test(afterUncertain), 'plain text only');
});

// ==================================================================== 7c. the first-run wizard
await section('the first-run wizard: gating, choices and nothing but text', async () => {
  const wizardSource = await fs.readFile(path.join(bundleRoot, 'web', 'onboarding.js'), 'utf8');
  const wizardSandbox = { ChatMcpUi: ui };
  wizardSandbox.window = wizardSandbox;
  vm.createContext(wizardSandbox);
  vm.runInContext(wizardSource, wizardSandbox, { filename: 'onboarding.js' });
  const wizard = wizardSandbox.ChatMcpOnboarding;
  check(wizard && typeof wizard.render === 'function' && Object.isFrozen(wizard), 'onboarding.js publishes a frozen window.ChatMcpOnboarding');
  equal(wizard.STEPS.map((step) => step.id), ['workspace', 'ai', 'safety', 'ready'], 'four steps, in the order to do them');

  // A tiny element factory: enough to inspect what would be rendered, without React or a browser.
  const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) });
  const Icon = function Icon() {}; const Button = function Button() {}; const Tag = function Tag() {};
  const all = (node, found = []) => { if (node && typeof node === 'object') { found.push(node); for (const child of node.children) all(child, found); } return found; };
  const textOf = (node) => (node && typeof node === 'object') ? node.children.map(textOf).join('') : (node === null || node === undefined || node === false ? '' : String(node));
  const buttons = (tree, label) => all(tree).filter((node) => node.type === Button && textOf(node) === label);
  const calls = [];
  const ctx = (patch = {}) => ({
    UI: ui, Icon, Button, Tag, hub: localHub(), step: 'workspace', ready: ui.readiness(localHub()), busy: false, running: false, workspaceDraft: '/work/proj', permission: 'review',
    providerForm: () => h('div', { className: 'stub-provider-form' }), setStep: (id) => calls.push(['step', id]), setWorkspaceDraft: (v) => calls.push(['draft', v]),
    browse: () => calls.push(['browse']), applyWorkspace: () => calls.push(['apply']), setPermission: (m) => calls.push(['permission', m]),
    useExample: (t) => calls.push(['example', t]), close: (f) => calls.push(['close', f]), ...patch,
  });
  const tree = (patch) => wizard.render(h, ctx(patch));
  const next = (patch) => buttons(tree(patch), 'Tiếp tục')[0];

  // gating
  check(next({ hub: localHub() }).props.disabled === false, 'workspace chosen: can continue');
  check(next({ hub: localHub({ workspace: { path: null } }) }).props.disabled === true, 'no workspace: cannot continue');
  check(next({ step: 'ai', hub: localHub() }).props.disabled === false, 'AI configured: can continue');
  check(next({ step: 'ai', hub: localHub({ ai: { configured: false } }) }).props.disabled === true, 'AI not configured: cannot continue');
  check(next({ step: 'ai', hub: localHub({ agent: { mode: 'chatgpt-web' }, browser: { paired: true } }) }).props.disabled === false, 'ChatGPT Web mode with a paired companion: can continue');
  check(next({ step: 'ai', hub: localHub({ agent: { mode: 'chatgpt-web' }, browser: { paired: false } }) }).props.disabled === true, 'ChatGPT Web mode without a companion: cannot continue');
  check(next({ step: 'safety' }).props.disabled === false, 'the safety step never blocks');
  check(buttons(tree({ step: 'ready' }), 'Tiếp tục').length === 0, 'the last step has no "continue"');
  check(buttons(tree({ step: 'workspace' }), 'Quay lại').length === 0 && buttons(tree({ step: 'ai' }), 'Quay lại').length === 1, 'back exists from the second step on');

  // the form is the shared one, not a copy
  check(all(tree({ step: 'ai' })).some((node) => node.props.className === 'stub-provider-form'), 'the AI step shows the shared connection form');

  // permission choice
  const safety = tree({ step: 'safety', permission: 'readonly' });
  const cards = all(safety).filter((node) => node.type === 'button' && String(node.props.className).includes('perm-card'));
  equal(cards.length, 3, 'one card per permission mode');
  equal(cards.map((card) => card.props['aria-pressed']), [true, false, false], 'the current mode is the pressed one');
  cards[2].props.onClick(); equal(calls.pop(), ['permission', 'autonomous'], 'choosing a card sets that mode');
  check(textOf(safety).includes('Khuyến nghị'), 'review is marked as recommended');

  // closing is always possible and remembered
  const final = tree({ step: 'ready' });
  buttons(final, 'Bắt đầu dùng')[0].props.onClick(); equal(calls.pop(), ['close', true], 'finishing closes for good');
  buttons(final, 'Bỏ qua, thiết lập sau')[0].props.onClick(); equal(calls.pop(), ['close', true], 'skipping closes for good');
  const closeX = all(final).find((node) => node.props['aria-label'] === 'Đóng hướng dẫn'); closeX.props.onClick(); equal(calls.pop(), ['close', true], 'the close button closes for good');
  const examples = all(all(final).find((node) => node.props.className === 'onboarding-examples')).filter((node) => node.type === 'button');
  check(examples.length >= 2, 'example prompts are offered');
  examples[0].props.onClick(); const [exampleCall, exampleText] = calls.pop();
  equal(exampleCall, 'example', 'an example prompt is handed to the page');
  check(/không sửa file/i.test(exampleText) && examples.every((example) => /không sửa file/i.test(textOf(example))), 'every first example is read-only: it says no file will be changed');

  // steps can be revisited; the dialog is a real dialog
  const dialog = all(tree()).find((node) => node.props.role === 'dialog');
  check(dialog && dialog.props['aria-modal'] === 'true' && /Thiết lập/.test(dialog.props['aria-label']), 'it is an accessible modal dialog');
  const stepList = all(tree({ step: 'ai' })).find((node) => node.type === 'ol');
  const stepButtons = all(stepList).filter((node) => node.type === 'button');
  equal(stepButtons.length, 4, 'every step in the list is a button');
  equal(stepButtons.map((button) => button.props['aria-current']), [undefined, 'step', undefined, undefined], 'the current step is marked for assistive technology');
  stepButtons[0].props.onClick(); equal(calls.pop(), ['step', 'workspace'], 'a finished step can be revisited');

  // data from the Hub is only ever text: a hostile folder name or model name stays a string child
  const hostile = '<img src=x onerror=alert(1)>';
  const hostileTree = tree({ step: 'ready', hub: localHub({ workspace: { path: hostile }, ai: { configured: true, model: hostile } }) });
  const nodes = all(hostileTree);
  check(nodes.every((node) => typeof node.type === 'string' || typeof node.type === 'function'), 'only elements and components are produced');
  check(!nodes.some((node) => node.type === 'img' || Object.hasOwn(node.props, 'dangerouslySetInnerHTML')), 'no element is created from hub-supplied text');
  check(textOf(hostileTree).includes(hostile), 'the hostile text is displayed literally');

  // the wizard's picture of "done" agrees with the logic module's
  for (const patch of [{}, { workspace: { path: null } }, { ai: { configured: false } }, { agent: { mode: 'chatgpt-web' }, browser: { paired: true } }]) {
    const hub = localHub(patch);
    const guide = ui.onboarding(hub);
    check(wizard.canAdvance(ctx({ hub }), 'workspace') === Boolean(hub.workspace?.path) && wizard.canAdvance(ctx({ hub }), 'ai') === guide.steps.find((step) => step.id === 'ai').done, `canAdvance agrees with onboarding() for ${JSON.stringify(patch)}`);
  }
});

// ==================================================================== 8. the page code never builds HTML from data
await section('page code renders data as text only', async () => {
  const forbidden = [
    [/\.innerHTML\b/, 'innerHTML'], [/\.outerHTML\b/, 'outerHTML'], [/dangerouslySetInnerHTML/, 'dangerouslySetInnerHTML'],
    [/\binsertAdjacentHTML\b/, 'insertAdjacentHTML'], [/\bdocument\.write(?:ln)?\s*\(/, 'document.write'], [/\beval\s*\(/, 'eval'],
    [/\bnew\s+Function\s*\(/, 'new Function'], [/\bsetTimeout\s*\(\s*['"`]/, 'setTimeout with a string'], [/\bsetInterval\s*\(\s*['"`]/, 'setInterval with a string'],
    [/\bon(?:click|error|load|mouseover)\s*=\s*["']/, 'inline event attribute'],
  ];
  for (const file of ['ui-logic.js', 'onboarding.js', 'react-app.js']) {
    const text = await fs.readFile(path.join(bundleRoot, 'web', file), 'utf8');
    for (const [pattern, name] of forbidden) check(!pattern.test(text), `${file}: no ${name}`);
  }
});

} finally {
  await manager?.permissions?.shutdown?.();
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}

console.log(`PASS verify-ui-logic: ${checks} checks`);
process.exit(0);
