#!/usr/bin/env node
// Integration test of the local backend: HubManager (backend "local") + PermissionGate + LocalTools +
// AgentRunner, driven by a scripted model. It needs no Docker, Cloud Harness, MCP proxy, network or API key.
//
// What it proves: the Hub runs on its own; the model is offered the real tools; every call goes through the
// permission gate and a checkpoint; refusals reach the model as results; a command cannot be approved by
// accident; secrets never reach the transcript; a repository cannot run programs through Git settings.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HubManager, defaultDataDirectory } from '../lib/manager.mjs';
import { assembleStudio } from '../lib/assemble.mjs';
import { AgentRunner } from '../lib/agent.mjs';
import { parseArguments } from '../hub.mjs';

const bundleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let checks = 0;
const check = (condition, label) => { assert.ok(condition, label); checks += 1; };
const equal = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks += 1; };
const SECRET = 'sk-test-SECRET-DO-NOT-LEAK-0123456789';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-local-backend-'));
const root = await fs.realpath(temp);
const cleanups = [];
process.on('exit', () => { for (const child of cleanups) { try { child.kill('SIGKILL'); } catch { /* already gone */ } } });

// ------------------------------------------------------------------ fixtures
function git(cwd, args) {
  const result = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}
async function project(name) {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'calc.js'), 'exports.add = (a, b) => a - b;\n');
  await fs.writeFile(path.join(dir, 'check.js'), "const { add } = require('./calc.js');\nif (add(2, 3) !== 5) { console.error('FAIL add(2,3) =', add(2, 3)); process.exit(1); }\nconsole.log('OK 1 test');\n");
  await fs.writeFile(path.join(dir, 'package.json'), `${JSON.stringify({ name: 'demo', version: '1.0.0', scripts: { test: 'node check.js' } }, null, 2)}\n`);
  await fs.writeFile(path.join(dir, 'slow.js'), "const fs = require('fs');\nfs.writeFileSync('started.txt', '1');\nsetTimeout(() => { fs.writeFileSync('finished.txt', '1'); }, 6000);\n");
  await fs.writeFile(path.join(dir, '.env'), `API_KEY=${SECRET}\n`);
  await fs.writeFile(path.join(dir, '.gitignore'), '.env\nstarted.txt\nfinished.txt\n');
  git(dir, ['init', '-q']);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'initial']);
  return dir;
}
async function createHub(name) {
  const dataDirectory = path.join(root, `${name}-data`);
  const logs = [];
  const manager = new HubManager({ dataDirectory, bundleRoot, log: (line) => logs.push(line) });
  assembleStudio(manager, { bundleRoot });
  await manager.permissions.load();
  await manager.load();
  return { manager, logs, dataDirectory };
}

// ------------------------------------------------------------------ scripted model
const say = (text) => ({ kind: 'say', text });
const tool = (name, args = {}) => ({ kind: 'tool', name, args });
function scripted(steps) {
  let turn = 0;
  let counter = 0;
  const seen = [];
  const results = [];
  const provider = {
    seen, results,
    snapshot: () => ({ model: 'scripted-1', provider: 'scripted' }),
    ready: () => true,
    redact: (text) => text,
    state: () => ({ provider: 'scripted', model: 'scripted-1', configured: true }),
    async respond({ input, instructions, tools, signal }) {
      signal?.throwIfAborted();
      seen.push({ input: structuredClone(input), instructions, tools: tools.map((entry) => entry.name), toolDefinitions: structuredClone(tools) });
      const outputs = input.filter((item) => item.type === 'function_call_output');
      const last = outputs.length ? JSON.parse(typeof outputs.at(-1).output === 'string' ? outputs.at(-1).output : outputs.at(-1).output[0].text) : null;
      if (last && results.length < outputs.length) results.push(last);
      const step = steps[turn];
      turn += 1;
      if (!step) throw new Error(`The script has no step ${turn}.`);
      const produced = await step({ last, input });
      return {
        status: 'completed', usage: { input_tokens: 10, output_tokens: 5 },
        output: produced.map((item) => item.kind === 'tool'
          ? { type: 'function_call', call_id: `call_${(counter += 1)}`, name: item.name, arguments: typeof item.args === 'string' ? item.args : JSON.stringify(item.args), status: 'completed' }
          : { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: item.text }] }),
      };
    },
  };
  return provider;
}
const textOf = (result) => (result?.content ?? []).map((part) => part.text ?? '').join('\n');

/** Answers approval requests as they appear and remembers them. */
function approver(manager, decide) {
  const handled = new Set();
  const requests = [];
  const timer = setInterval(() => {
    for (const request of manager.permissions.state().pending) {
      if (handled.has(request.id)) continue;
      handled.add(request.id);
      requests.push(request);
      try { manager.permissions.decide(request.id, decide(request)); } catch { /* already decided */ }
    }
  }, 10);
  return { requests, stop: () => clearInterval(timer) };
}
async function finish(agent, id, { timeoutMs = 60_000 } = {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const task = agent.get(id);
    // The status changes first; the workspace lock is released a moment later.
    if (task.status !== 'running' && agent.state().activeTaskId === null) return task;
    await sleep(20);
  }
  throw new Error('The task did not finish in time.');
}
async function section(title, body) {
  const before = checks;
  const started = Date.now();
  await body();
  console.log(`  ok  ${title} (${checks - before} checks, ${((Date.now() - started) / 1000).toFixed(1)}s)`);
}
const agentFor = (manager, model, name) => new AgentRunner({ manager, provider: model, taskDirectory: path.join(manager.hubDirectory, 'api-tasks', name), log: () => {} });

try {
  // ---------------------------------------------------------------- construction and options
  await section('manager construction and command-line options', async () => {
    const standalone = new HubManager({ dataDirectory: path.join(root, 'standalone'), bundleRoot });
    equal(standalone.backend, 'local', 'without --repo-root the backend is local');
    equal(Object.keys(standalone.services),['local'],'only local services remain');
    equal(standalone.state().proxyUrl,null,'legacy proxy URL removed');
    assert.throws(()=>new HubManager({repoRoot:path.join(root,'old-cloud'),bundleRoot}),/Cloud Harness|backend local/);checks++;
    assert.throws(()=>new HubManager({bundleRoot,backend:'mcp',dataDirectory:root}),/Cloud Harness|backend local/);checks++;
    assert.throws(()=>new HubManager({bundleRoot,backend:'cloud',dataDirectory:root}),/Cloud Harness|backend local/);checks++;
    equal(new HubManager({bundleRoot}).backend,'local','per-user default requires no Cloud Harness');

    equal(defaultDataDirectory({ LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, 'win32', 'C:\\Users\\a').replaceAll('\\', '/').endsWith('ChatMCP/hub'), true, 'Windows state folder under LOCALAPPDATA');
    check(defaultDataDirectory({ XDG_STATE_HOME: '/state' }, 'linux', '/home/a').replaceAll('\\', '/').endsWith('/state/chatmcp'), 'XDG state folder on Linux');
    check(defaultDataDirectory({}, 'linux', '/home/a').replaceAll('\\', '/').endsWith('/home/a/.local/state/chatmcp'), 'fallback state folder on Linux');
    check(defaultDataDirectory({ CHATMCP_STATE_DIR: path.join(root, 'env-state') }, 'linux', '/home/a') === path.join(root, 'env-state'), 'CHATMCP_STATE_DIR wins');

    const none = parseArguments([], {});
    equal([none.repoRoot,none.backend,none.open,none.port],[null,'local',true,3007],'defaults');
    check(none.stateDir === defaultDataDirectory({}), 'default state folder');
    assert.throws(()=>parseArguments(['--repo-root','X'],{}),/unsupported|option/i); checks++;
    equal(parseArguments(['--no-open', '--port', '4000', '--backend', 'local', '--state-dir', root], {}).open, false, '--no-open');
    equal(parseArguments(['--state-dir', root], { CHATMCP_STATE_DIR: '/other' }).stateDir, root, '--state-dir beats the environment');
    equal(parseArguments([], { CHATMCP_NO_OPEN: '1' }).open, false, 'CHATMCP_NO_OPEN');
    for (const bad of [['--backend', 'cloud'], ['--backend', 'mcp'], ['--port', '3006'], ['--port', '80'], ['--bogus', '1'], ['--project']]) {
      assert.throws(() => parseArguments(bad, {})); checks += 1;
    }
  });

  // ---------------------------------------------------------------- lifecycle
  const { manager, logs, dataDirectory } = await createHub('main');
  await section('workspace selection starts the local tools', async () => {
    equal(manager.state().services.local.state, 'stopped', 'stopped before a workspace is chosen');
    assert.throws(() => manager.acquireTask('11111111-1111-4111-8111-111111111111'), /thư mục dự án/); checks += 1;
    assert.throws(() => manager.instructions(), /removed/); checks += 1;
    const dir = await project('first');
    const state = await manager.selectWorkspace(dir);
    equal(state.workspace.path, dir, 'workspace selected');
    equal(state.services.local.state, 'ready', 'local service ready');
    equal(state.backend, 'local', 'state reports the backend');
    equal(state.dataDirectory, dataDirectory, 'state reports the data folder');
    check(state.catalogReady === true && state.toolCounts.local === 95, `95 local tools (${state.toolCounts.local})`);
    check(state.toolCounts.studio > 0 && state.toolCounts.studio < 17, 'only the Studio tools that add something are listed');
    check(!manager.catalog.tools.some((entry) => ['studio.read', 'studio.tree', 'studio.plan_set'].includes(entry.name)), 'Studio tools that duplicate local.* are not offered');
    check(manager.catalog.tools.every((entry) => entry.name === `${entry.server}.${entry.originalName}`), 'catalog names are qualified');
    check(state.environment?.node === process.version, 'environment facts are reported');
    const saved = JSON.parse(await fs.readFile(manager.settingsFile, 'utf8'));
    equal(saved.workspace, dir, 'workspace remembered for the next start');
    check(logs.some((line) => line.includes('Công cụ cục bộ sẵn sàng')), 'start is logged');
    const generation = state.generation;
    await manager.stop();
    equal(manager.state().services.local.state, 'stopped', 'stop');
    assert.throws(() => manager.acquireTask('11111111-1111-4111-8111-111111111111'), /chưa sẵn sàng/); checks += 1;
    await manager.start();
    check(manager.state().generation > generation && manager.state().services.local.state === 'ready', 'start again bumps the generation');
    await assert.rejects(() => manager.selectWorkspace(path.join(root, 'does-not-exist')), /ENOENT|no such file/i); checks += 1;
    equal(manager.workspace, dir, 'a failed selection leaves the workspace unchanged');
    await assert.rejects(() => manager.selectWorkspace('relative/path'), /tuyệt đối/); checks += 1;
  });

  // ---------------------------------------------------------------- full agent run, autonomous
  await section('the model fixes a bug with the real tools (autonomous mode)', async () => {
    const dir = await project('fix');
    await manager.selectWorkspace(dir);
    manager.permissions.configure({ mode: 'autonomous', executionPolicy: 'host-review' });
    const model = scripted([
      () => [say('Đọc calc.js để tìm lỗi.'), tool('read_file', { path: 'calc.js' })],
      ({ last }) => [say('Sửa dấu trừ thành cộng.'), tool('edit_file', { path: 'calc.js', old_string: 'a - b', new_string: 'a + b', expected_sha256: last.structuredContent.sha256 })],
      () => [say('Chạy bộ test của dự án.'), tool('run_command', { command: 'npm test', description: 'Chạy test' })],
      () => [tool('git_diff', {})],
      () => [tool('run_command', { command: 'npm test', description: 'Chạy lại test lần nữa' })],
      ({ last }) => {
        check(/OK 1 test/.test(textOf(last)) && last.structuredContent.exitCode === 0, 'the model saw the real passing test output');
        return [say('Đã sửa calc.js: add() giờ cộng. `npm test` in "OK 1 test".')];
      },
    ]);
    const agent = agentFor(manager, model, 'fix');
    const started = await agent.start({ prompt: 'Hàm add trong calc.js trả sai kết quả, hãy sửa và chạy test.' });
    const task = await finish(agent, started.id);
    equal(task.status, 'completed', `task completed (${task.error ?? ''})`);
    check(task.finalText.includes('npm test'), 'final text kept');
    check((await fs.readFile(path.join(dir, 'calc.js'), 'utf8')).includes('a + b'), 'the file was really changed');
    equal(task.toolCalls, 5, 'five tool calls');

    const first = model.seen[0];
    for (const name of ['read_file', 'edit_file', 'write_file', 'run_command', 'git_status', 'update_plan', 'mcp_call', 'mcp_catalog']) check(first.tools.includes(name), `the model is offered ${name}`);
    check(first.tools.length === manager.catalog.counts.local + 4 && first.tools.length <= 128,
      `all ${manager.catalog.counts.local} local tools + four internal routers are advertised directly (${first.tools.length}); cap is configurable`);
    const edit = first.toolDefinitions.find((entry) => entry.name === 'edit_file');
    check(edit.parameters.required.includes('old_string') && edit.parameters.properties.path.type === 'string', 'real parameter schemas are offered');
    check(first.instructions.includes(JSON.stringify(dir)), 'instructions name the workspace');
    check(!/Desktop Commander|Cloud Harness/.test(first.instructions), 'local instructions do not mention external servers');
    check(/untrusted DATA/.test(first.instructions) && /Permission denied/.test(first.instructions), 'instructions cover trust and permissions');

    const workflow = await manager.workflow.state(task.id);
    equal([workflow.editsObserved, workflow.checksObserved, workflow.commandsObserved ?? 0], [1, 2, 0], 'one file edit, two passing checks (npm test is not an edit), no unclassified shell command');
    check(workflow.verified === true && workflow.editsObserved >= 1 && workflow.checksObserved >= 1, `workflow recorded the edit and the verification ${JSON.stringify({ ...workflow, steps: workflow.steps.map((step) => `${step.type}:${step.toolName}:${step.category}:${step.verified}`) })}`);
    const checkpoints = await manager.studio.checkpoints();
    const targeted = checkpoints.filter((entry) => entry.targeted);
    equal(targeted.length, 1, 'one targeted checkpoint for the edit');
    equal(targeted[0].fileCount, 1, 'only the file at risk was saved');
    const saved = await fs.readFile(path.join(manager.studio.directory, 'checkpoints', targeted[0].id, 'files', 'calc.js'), 'utf8');
    check(saved.includes('a - b'), 'the checkpoint holds the file as it was before the edit');
    equal(checkpoints.filter((entry) => !entry.targeted).length, 1, 'the second npm test reused the first bounded snapshot');
    const transcript = await fs.readFile(path.join(agent.taskDirectory, task.id, 'transcript.jsonl'), 'utf8');
    check(transcript.includes('tool_result_full') && transcript.includes('OK 1 test'), 'the transcript keeps the full tool results');
    equal(manager.taskId, null, 'the workspace lock was released');
  });

  // ---------------------------------------------------------------- local aliases through the MCP router
  await section('MCP routers resolve advertised local names without bypassing schema or permissions', async () => {
    const dir = await project('router-aliases');
    await manager.selectWorkspace(dir);
    manager.permissions.configure({ mode: 'readonly' });
    const routed = (name, args = {}) => tool('mcp_call', { name, arguments_json: JSON.stringify(args) });
    const model = scripted([
      () => [tool('mcp_describe', { name: 'read_file' })],
      ({ last }) => {
        equal(last.tool?.name, 'local.read_file', 'describe resolves only the advertised local alias to its real definition');
        check(last.tool.inputSchema.required.includes('path'), 'the actual required argument schema is returned');
        return [routed('read_file', { path: 'calc.js' })];
      },
      ({ last }) => {
        check(last.isError === false && textOf(last).includes('a - b'), 'the existing read_file works when wrapped in mcp_call');
        return [routed('find_files', { pattern: 'calc.js' })];
      },
      ({ last }) => {
        check(last.isError === false && textOf(last).includes('calc.js'), 'find_files alias resolves to the real local tool');
        return [routed('read_file', { path: 42 })];
      },
      ({ last }) => {
        equal(last.structuredContent?.error?.code, 'invalid_arguments', 'alias arguments still pass the real tool schema');
        equal(last.structuredContent?.executed, false, 'invalid arguments never execute');
        return [routed('run_command', { command: 'npm test' })];
      },
      ({ last }) => {
        check(last.isError && /Chế độ Chỉ đọc/.test(textOf(last)), 'run_command alias still goes through the readonly permission gate');
        return [routed('write_file', { path: 'must-not-exist.txt', content: 'x' })];
      },
      ({ last }) => {
        check(last.isError && /Chế độ Chỉ đọc/.test(textOf(last)), 'write_file alias still goes through the readonly permission gate');
        return [routed('invented.read_file', { path: 'calc.js' })];
      },
      ({ last }) => {
        equal([last.error?.code, last.executed], ['unknown_tool', false], 'an invented server prefix is never inferred from a matching basename');
        return [routed('missing_tool', {})];
      },
      ({ last }) => {
        equal([last.error?.code, last.executed], ['unknown_tool', false], 'an unknown short name is never installed or executed');
        return [routed('local.read_file', { path: 'calc.js' })];
      },
      ({ last }) => {
        check(last.isError === false && textOf(last).includes('a - b'), 'the canonical qualified name continues to work');
        return [say('Đã đọc file; không chạy lệnh hoặc ghi file trong chế độ Chỉ đọc.')];
      },
    ]);
    const agent = agentFor(manager, model, 'router-aliases');
    const task = await finish(agent, (await agent.start({ prompt: 'Inspect local tools through the MCP router.' })).id);
    equal(task.status, 'completed', `router alias task completed (${task.error ?? ''})`);
    await assert.rejects(() => fs.access(path.join(dir, 'must-not-exist.txt'))); checks += 1;
    equal(manager.permissions.state().pending.length, 0, 'readonly alias calls do not open an approval request');
    const transcript = (await fs.readFile(path.join(agent.taskDirectory, task.id, 'transcript.jsonl'), 'utf8'))
      .split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const fullResults = transcript.filter((entry) => entry.type === 'tool_result_full');
    check(fullResults.some((entry) => entry.toolName === 'local.read_file'), 'the journal records the resolved canonical tool identity');
    check(!fullResults.some((entry) => ['read_file', 'find_files', 'run_command', 'write_file'].includes(entry.toolName)), 'bare aliases never replace canonical journal identities');
    await agent.shutdown();
  });

  // ---------------------------------------------------------------- review mode
  await section('review mode asks, shows the change, and a denial reaches the model', async () => {
    const dir = await project('review');
    await manager.selectWorkspace(dir);
    manager.permissions.configure({ mode: 'review' });
    const model = scripted([
      () => [tool('write_file', { path: 'notes.md', content: '# Ghi chú\nviệc cần làm\n' })],
      () => [tool('write_file', { path: 'other.md', content: 'x' })],
      ({ last }) => {
        check(last.isError === true && /Permission denied/.test(textOf(last)) && last.structuredContent.executed === false, 'a denial is a result that says nothing ran');
        return [say('Đã tạo notes.md; other.md bị từ chối nên không tạo.')];
      },
    ]);
    const asked = approver(manager, (request) => request.detail?.path === 'notes.md');
    const agent = agentFor(manager, model, 'review');
    const task = await finish(agent, (await agent.start({ prompt: 'Tạo hai file ghi chú.' })).id);
    asked.stop();
    equal(task.status, 'completed', `task completed (${task.error ?? ''})`);
    equal(asked.requests.length, 2, 'both writes asked');
    equal(asked.requests[0].detail.kind, 'write', 'the request carries structured detail');
    equal([asked.requests[0].detail.path, asked.requests[0].detail.bytes > 0], ['notes.md', true], 'path and size are shown');
    check(/notes\.md/.test(asked.requests[0].summary), 'one-line summary');
    check((await fs.readFile(path.join(dir, 'notes.md'), 'utf8')).includes('việc cần làm'), 'approved write happened');
    await assert.rejects(() => fs.access(path.join(dir, 'other.md')), 'denied write did not happen'); checks += 1;
    const decisions = manager.permissions.state().recent.map((entry) => entry.decision);
    check(decisions.includes('approved') && decisions.includes('denied'), 'both decisions are in the audit trail');
    equal(manager.permissions.state().pending.length, 0, 'nothing left pending');
  });

  // ---------------------------------------------------------------- read only
  await section('read only mode refuses changes without asking', async () => {
    const dir = await project('readonly');
    await manager.selectWorkspace(dir);
    manager.permissions.configure({ mode: 'readonly' });
    const model = scripted([
      () => [tool('write_file', { path: 'new.txt', content: 'x' })],
      ({ last }) => { check(last.isError && /Chế độ Chỉ đọc/.test(textOf(last)), 'write refused'); return [tool('run_command', { command: 'npm test' })]; },
      ({ last }) => { check(last.isError && /Chế độ Chỉ đọc/.test(textOf(last)), 'a test command is refused too'); return [tool('git_status', {})]; },
      ({ last }) => { check(last.isError === false && /calc\.js|## |nothing|sạch|clean/i.test(textOf(last)) || last.isError === false, 'reading still works'); return [tool('list_directory', {})]; },
      ({ last }) => { check(textOf(last).includes('calc.js'), 'the directory listing works'); return [say('Chỉ đọc: tôi không sửa gì.')]; },
    ]);
    const asked = approver(manager, () => true);
    const agent = agentFor(manager, model, 'readonly');
    const task = await finish(agent, (await agent.start({ prompt: 'Thử ghi file.' })).id);
    asked.stop();
    equal(task.status, 'completed', `task completed (${task.error ?? ''})`);
    equal(asked.requests.length, 0, 'no approval box was shown');
    await assert.rejects(() => fs.access(path.join(dir, 'new.txt'))); checks += 1;
    equal((await manager.studio.checkpoints()).length, 0, 'no checkpoint for refused calls');
  });

  // ---------------------------------------------------------------- secrets and invalid calls
  await section('secrets stay out; invalid and unknown calls are recoverable', async () => {
    const dir = await project('secrets');
    await manager.selectWorkspace(dir);
    manager.permissions.configure({ mode: 'autonomous' });
    const model = scripted([
      () => [tool('read_file', { path: '.env' })],
      ({ last }) => { check(last.isError && /Permission denied/.test(textOf(last)) && !textOf(last).includes(SECRET), 'reading .env is refused'); return [tool('search_files', { pattern: 'API_KEY' })]; },
      ({ last }) => { check(!textOf(last).includes(SECRET), 'search does not return the secret'); return [tool('run_command', { command: 'cat .env' })]; },
      ({ last }) => { check(last.isError && /Permission denied/.test(textOf(last)), 'cat .env needs approval even in autonomous mode and was denied'); return [tool('edit_file', { path: 'calc.js', old_string: 'a - b' })]; },
      ({ last }) => { check(last.isError && last.structuredContent.error.code === 'invalid_arguments' && last.structuredContent.executed === false, 'invalid arguments are reported, not run'); return [tool('read_file', 'not json at all')]; },
      () => [tool('delete_everything', {})],
      () => [say('Không đọc được .env như mong đợi.')],
    ]);
    const asked = approver(manager, () => false);
    const agent = agentFor(manager, model, 'secrets');
    const task = await finish(agent, (await agent.start({ prompt: 'Cho tôi xem file .env.' })).id);
    asked.stop();
    equal(task.status, 'completed', `the run survived bad calls (${task.error ?? ''})`);
    equal(asked.requests.length, 1, 'only the shell command asked (the invalid edit never reached the user)');
    equal(asked.requests[0].detail.command, 'cat .env', 'the whole command was shown');
    check(model.results.length >= 5, 'the model saw each result');
    for (const file of ['task.json', 'transcript.jsonl', 'report.txt']) {
      check(!(await fs.readFile(path.join(agent.taskDirectory, task.id, file), 'utf8')).includes(SECRET), `${file} has no secret`);
    }
    check(!JSON.stringify(manager.permissions.state()).includes(SECRET), 'approval history has no secret');
  });

  // ---------------------------------------------------------------- checkpoint failure
  await section('a failed checkpoint stops the change and tells the model', async () => {
    const dir = await project('checkpoint');
    await manager.selectWorkspace(dir);
    manager.permissions.configure({ mode: 'autonomous' });
    const original = manager.studio.checkpoint;
    manager.studio.checkpoint = async () => { throw new Error('disk full'); };
    const model = scripted([
      () => [tool('edit_file', { path: 'calc.js', old_string: 'a - b', new_string: 'a + b' })],
      ({ last }) => { check(last.isError && /checkpoint/i.test(textOf(last)) && /NOT executed/.test(textOf(last)), 'the model is told nothing was changed'); return [say('Không sửa được vì không tạo được checkpoint.')]; },
    ]);
    const agent = agentFor(manager, model, 'checkpoint');
    try {
      const task = await finish(agent, (await agent.start({ prompt: 'Sửa add.' })).id);
      equal(task.status, 'completed', `task completed (${task.error ?? ''})`);
    } finally { manager.studio.checkpoint = original; }
    check((await fs.readFile(path.join(dir, 'calc.js'), 'utf8')).includes('a - b'), 'the file is unchanged');
  });

  // ---------------------------------------------------------------- cancel
  await section('Stop kills a running command and keeps the unverified call on record', async () => {
    const dir = await project('cancel');
    await manager.selectWorkspace(dir);
    manager.permissions.configure({ mode: 'autonomous' });
    const model = scripted([() => [say('Chạy script chậm.'), tool('run_command', { command: 'node slow.js', description: 'Script chậm' })]]);
    const agent = agentFor(manager, model, 'cancel');
    const started = await agent.start({ prompt: 'Chạy slow.js.' });
    const until = Date.now() + 20_000;
    while (Date.now() < until) { try { await fs.access(path.join(dir, 'started.txt')); break; } catch { await sleep(50); } }
    await fs.access(path.join(dir, 'started.txt'));
    checks += 1;
    const cancelled = await agent.cancel(started.id);
    equal(cancelled.status, 'cancelled', 'task cancelled');
    check(cancelled.pendingCall?.toolName === 'local.run_command', 'the interrupted call stays on record as unverified');
    check(/Không tự chạy lại/.test(cancelled.error), 'the report says it will not be replayed');
    equal(manager.taskId, null, 'the workspace lock was released');
    await sleep(6800);
    await assert.rejects(() => fs.access(path.join(dir, 'finished.txt')), 'the command was killed before it finished'); checks += 1;
  });

  // ---------------------------------------------------------------- hostile repository
  await section('a repository cannot run programs through its Git settings', async () => {
    const dir = await project('hostile');
    const marker = path.join(dir, 'PWNED.txt');
    const script = path.join(root, 'fsmonitor.mjs');
    await fs.writeFile(script, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'ran');\nprocess.stdout.write('\\0');\n`);
    // Quotes must survive Git's own config parser (which strips plain ones), hence the backslashes.
    const config = `[core]\n\tfsmonitor = \\"${process.execPath.replaceAll('\\', '/')}\\" \\"${script.replaceAll('\\', '/')}\\"\n`;
    await fs.appendFile(path.join(dir, '.git', 'config'), config);
    // Control: plain git really does run the program, so the hardened result below means something.
    spawnSync('git', ['-C', dir, 'status', '--short'], { encoding: 'utf8' });
    const controlRan = await fs.access(marker).then(() => true, () => false);
    if (controlRan) await fs.rm(marker);
    else console.log('  note: this Git version did not run core.fsmonitor in the control run; the hardened check is still executed');
    await manager.selectWorkspace(dir);
    manager.permissions.configure({ mode: 'autonomous' });
    const status = await manager.studio.gitStatus();
    check(Array.isArray(status.entries), 'Studio git status works');
    const viaTool = await manager.localTools.call('local.git_status', {}, { taskId: '11111111-1111-4111-8111-111111111111' });
    check(viaTool.isError === false, 'local git_status works');
    await manager.studio.gitDiff({});
    await manager.studio.gitDiffCheck();
    await assert.rejects(() => fs.access(marker), 'no program was run by Git settings'); checks += 1;
  });

  // ---------------------------------------------------------------- the real launcher
  await section('hub.mjs starts on its own and shuts down cleanly', async () => {
    const dir = await project('launch');
    const free = await new Promise((resolve) => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); }); });
    const state = path.join(root, 'launch-data');
    const child = spawn(process.execPath, [path.join(bundleRoot, 'hub.mjs'), '--state-dir', state, '--port', String(free), '--no-open', '--project', dir], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CHATMCP_BACKEND: '', OPENAI_API_KEY: '' } });
    cleanups.push(child);
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
    const base = `http://127.0.0.1:${free}`;
    let snapshot = null;
    const until = Date.now() + 30_000;
    while (Date.now() < until) {
      try {
        const health = await fetch(`${base}/api/health`).then((response) => response.json());
        if (health.initialized) {
          snapshot = await fetch(`${base}/api/state`).then((response) => response.json());
          if (snapshot.services?.local?.state === 'ready') break;
        }
      } catch { /* not listening yet */ }
      await sleep(100);
    }
    check(snapshot?.services?.local?.state === 'ready', `the Hub became ready on its own\n${output}`);
    equal([snapshot.backend, snapshot.agent.mode, snapshot.workspace.path], ['local', 'api', dir], 'local backend, API mode, project opened');
    equal(snapshot.dataDirectory, state, 'data goes where --state-dir says');
    check(snapshot.toolCounts.local === 95, 'tools registered');
    const text = await fetch(`${base}/api/instructions`).then((response) => response.status);
    equal(text, 410, 'removed legacy MCP instructions explicitly return Gone');
    const response = await fetch(`${base}/api/hub/shutdown`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, 'X-ChatMCP-Request': 'local-dashboard', 'X-ChatMCP-CSRF': snapshot.csrfToken }, body: '{}' });
    equal(response.status, 200, 'shutdown accepted');
    const code = await Promise.race([exited, sleep(20_000).then(() => 'timeout')]);
    equal(code, 0, `clean exit\n${output}`);
    await fs.access(path.join(state, 'hub-state.json'));
    checks += 1;
  });

  console.log(`PASS: ${checks} checks - local backend: standalone start, real tool loop, permission modes, checkpoints, secrets, cancellation, hostile Git settings`);
} finally {
  for (const child of cleanups) { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}
