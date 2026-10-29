#!/usr/bin/env node
// Integration test of the local backend: HubManager (backend "local") + PermissionGate + LocalTools +
// AgentRunner, driven by a scripted model. It needs no Docker, Cloud Harness, MCP proxy, network or API key.
//
// What it proves: the Hub runs on its own; the model is offered the real tools; every call goes through the
// permission gate and a checkpoint; refusals reach the model as results; a command cannot be approved by
// accident; secrets never reach the transcript; a repository cannot run programs through Git settings; a tool that can change the files makes the receipts of a coding run stale.
// CLAIM: receipt-invalidation
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
import { mutatesTree } from '../lib/agent-progress.mjs';
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
    check(state.catalogReady === true && state.toolCounts.local === 99, `99 local tools (${state.toolCounts.local})`);
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
    // (skill_load is the host's own function, offered last whenever a skill is turned on because the index names the skills the model can read: it is not one of the local tools.)
    const advertised = first.tools.filter((name) => name !== 'skill_load');
    check(advertised.length === manager.catalog.counts.local + 4 && first.tools.length <= 128,
      `all ${manager.catalog.counts.local} local tools + four internal routers are advertised directly (${advertised.length}); cap is configurable`);
    const edit = first.toolDefinitions.find((entry) => entry.name === 'edit_file');
    // edit_file takes old_string + new_string or edits (several edits of one file): only the path is required by the schema, the call is checked when it is made
    check(edit.parameters.required.includes('path') && edit.parameters.properties.path.type === 'string' && edit.parameters.properties.old_string.type === 'string'
      && edit.parameters.properties.edits.type === 'array' && edit.parameters.properties.edits.items.required.includes('new_string'), 'real parameter schemas are offered');
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

  // ---------------------------------------------------------------- the review receipt of a real git_diff
  // The receipt is made from what the REAL local git_diff returns, in a run of the real loop. (tests/verify-agent-autonomy.mjs once fed the verifier a `diff` field that no tool returns: the receipt was never
  // made in a real run, and every coding run ended with "No independently recorded Git diff review".)
  await section('a git_diff after the last edit is a review receipt, one before a later edit is not (real tools)', async () => {
    const GOAL = 'Read calc.js and find out why add() returns the wrong sum; then fix it with the smallest change and run the project tests; finally review the Git diff and report what is still limited.';
    const NO_CHECK = 'No verified successful project check';
    const NO_REVIEW = 'No independently recorded Git diff review';
    /** One run of the real loop on a fresh project; the plan of the goal has a review phase, so the Hub has to judge the completion. */
    const run = async (name, steps) => {
      const dir = await project(name);
      await manager.selectWorkspace(dir);
      manager.permissions.configure({ mode: 'autonomous', executionPolicy: 'host-review' });
      const agent = agentFor(manager, scripted(steps), name);
      const started = await agent.start({ prompt: GOAL });
      const task = await finish(agent, started.id);
      equal(task.status, 'completed', `${name}: the task completed (${task.error ?? ''})`);
      check(task.goalPlan?.phases?.some((phase) => phase.id === 'review'), `${name}: (premise) the goal has a plan with a review phase`);
      return { dir, task };
    };
    const read = () => [tool('read_file', { path: 'calc.js' })];
    const fix = ({ last }) => [tool('edit_file', { path: 'calc.js', old_string: 'a - b', new_string: 'a + b', expected_sha256: last.structuredContent.sha256 })];
    const again = (sha) => () => [tool('edit_file', { path: 'calc.js', old_string: 'a + b', new_string: 'b + a', expected_sha256: sha() })];
    const test = () => [tool('run_command', { command: 'npm test', description: 'Chạy test' })];
    const diff = () => [tool('git_diff', {})];

    // A: read, edit, test, then the diff of the finished change.
    let shown;
    const a = await run('review-after', [read, fix, test, diff, ({ last }) => { shown = last; return [say('add() adds now and npm test prints OK 1 test; I read the diff.')]; }]);
    check((await fs.readFile(path.join(a.dir, 'calc.js'), 'utf8')).includes('a + b'), 'A: (premise) the file was really changed');
    check(shown.isError === false && textOf(shown).includes('+exports.add = (a, b) => a + b;'), 'A: (premise) the real git_diff returned the change');
    const progress = a.task.progress;
    equal(progress.gitReviews.length, 1, 'A: the diff taken after the last edit is one review receipt');
    check(progress.gitReviews[0]?.kind === 'review' && /^[a-f0-9]{16}$/.test(progress.gitReviews[0]?.id ?? ''), 'A: of the kind review, named by the diff');
    check(progress.verifiedFiles[0].step < progress.verifiedChecks[0].step && progress.verifiedChecks[0].step < progress.gitReviews[0]?.step, 'A: taken after the edit and after the passing test');
    equal(a.task.goalPlan.evidence.review, 1, 'A: the plan counts it');
    equal([a.task.verificationOutcome.ready, a.task.verificationOutcome.missing], [true, []], 'A: the Hub has every receipt the plan asks for');
    check(!/NOT independently verified/.test(a.task.finalText), 'A: and the answer carries no verification warning');
    // Receipts are not the owner's acceptance: no objective is accepted, so the completion still waits for the owner.
    equal([a.task.completionOutcome.requirements, a.task.completionOutcome.verification], ['unverified', 'evidence_present_not_objective_certified'], 'A: the objectives are still the owner\'s to accept');

    // B: the model edits once more after the diff: the diff and the passing test describe a file that is gone.
    let first;
    const b = await run('review-before-edit', [read, fix, ({ last }) => { first = last.structuredContent.sha256; return test(); }, diff, again(() => first), () => [say('I changed it once more after the diff.')]]);
    equal(b.task.progress.gitReviews, [], 'B: a diff taken before a later edit is not a review of what the file is now');
    equal(b.task.progress.verifiedChecks, [], 'B: nor is the passing test before it a check of the file');
    equal(b.task.progress.verifiedFiles.length, 1, 'B: only the last edit holds a file hash');
    check(b.task.progress.verifiedFiles[0].sha256 !== first, 'B: and it is the hash of the last edit');
    check(b.task.progress.invalidatedEvidence >= 3, 'B: the Hub counts what the last edit made stale');
    equal(b.task.verificationOutcome.missing, [NO_CHECK, NO_REVIEW], 'B: the Hub says what is missing');
    check(b.task.finalText.includes(NO_REVIEW), 'B: and so does the answer');

    // C: the model looks again after the later edit: that diff is the one that counts.
    let second;
    const c = await run('review-again', [read, fix, ({ last }) => { second = last.structuredContent.sha256; return diff(); }, again(() => second), diff, () => [say('Edited, then read the diff again.')]]);
    equal(c.task.progress.gitReviews.length, 1, 'C: only the diff taken after the last edit is kept');
    check(c.task.progress.gitReviews[0]?.step > c.task.progress.verifiedFiles[0].step, 'C: and it was taken after that edit');

    // D: nothing changed, nothing to review.
    let clean;
    const d = await run('review-nothing', [read, diff, ({ last }) => { clean = last; return [say('Nothing has changed yet.')]; }]);
    check(clean.isError === false && /Không có thay đổi/.test(textOf(clean)), 'D: (premise) the real git_diff of a clean tree says that nothing changed');
    equal(d.task.progress.gitReviews, [], 'D: a diff with no change is not a review');

    // E: a diff too long for the tool to show is shown in part: the Hub cannot say that the model read it.
    const big = `${Array.from({ length: 4000 }, (_, at) => `exports.line${at} = '${'x'.repeat(80)}';`).join('\n')}\n`;
    let cut;
    const e = await run('review-clipped', [read, ({ last }) => [tool('write_file', { path: 'calc.js', content: big, expected_sha256: last.structuredContent.sha256 })], diff, ({ last }) => { cut = last; return [say('The diff was long.')]; }]);
    check(cut.isError === false && /Diff quá lớn nên đã bị cắt/.test(textOf(cut)), 'E: (premise) the real git_diff cut the long diff');
    equal(e.task.progress.gitReviews, [], 'E: a diff shown in part is not a review');
  });

  // ---------------------------------------------------------------- which tools make the receipts stale
  // A receipt describes the files as they were when it was made, so a tool that can change the files makes every receipt stale: the passing test, the diff that was read, the hash of the edit
  // and what was read. The rule was a list of names (move_file, delete_file, rename_file ...) that no Hub tool has: after read, edit, `npm test` and git_diff, a move_path or a delete_path left
  // the review, the check and the edit receipt of a tree that had changed, and the run could still end "ready". The tools here are the Hub's own, called by the real loop.
  const held = (task) => ({ read: task.progress.verifiedInspections.length, edit: task.progress.verifiedFiles.length, check: task.progress.verifiedChecks.length, review: task.progress.gitReviews.length });
  await section('a tool that can change the files makes the receipts stale, one that cannot leaves them (real tools)', async () => {
    const GOAL = 'Read calc.js and find out why add() returns the wrong sum; then fix it with the smallest change and run the project tests; finally review the Git diff and report what is still limited.';
    const ALL = { read: 1, edit: 1, check: 1, review: 1 };
    const NONE = { read: 0, edit: 0, check: 0, review: 0 };
    const routed = (name, args) => tool('mcp_call', { name, arguments_json: JSON.stringify(args) });
    /** read, edit, a passing `npm test`, the diff, a second read: one receipt of each kind. Then the calls under test, one turn each, then the answer. */
    const run = async (name, calls) => {
      const dir = await project(name);
      git(dir, ['branch', 'side']);
      git(dir, ['config', 'user.name', 'Test']);
      git(dir, ['config', 'user.email', 'test@example.invalid']);
      await manager.selectWorkspace(dir);
      manager.permissions.configure({ mode: 'autonomous', executionPolicy: 'host-review' });
      const asked = approver(manager, () => true);
      let answer = null;
      const model = scripted([
        () => [tool('read_file', { path: 'calc.js' })],
        ({ last }) => [tool('edit_file', { path: 'calc.js', old_string: 'a - b', new_string: 'a + b', expected_sha256: last.structuredContent.sha256 })],
        () => [tool('run_command', { command: 'npm test', description: 'Run the tests' })],
        () => [tool('git_diff', {})],
        () => [tool('read_file', { path: 'calc.js' })],
        ...calls.map((call) => () => [call]),
        ({ last }) => { answer = last; return [say('Done.')]; },
      ]);
      const agent = agentFor(manager, model, name);
      const task = await finish(agent, (await agent.start({ prompt: GOAL })).id);
      asked.stop();
      return { dir, task, answer };
    };
    const problems = [];
    const judge = (label, ran, clears) => {
      const want = clears ? NONE : ALL;
      if (ran.task.status !== 'completed') problems.push(`${label}: (premise) the task ended ${ran.task.status}: ${ran.task.error ?? ''}`);
      if (ran.answer?.isError !== false) problems.push(`${label}: (premise) the last call did not succeed: ${textOf(ran.answer).slice(0, 160)}`);
      if (JSON.stringify(held(ran.task)) !== JSON.stringify(want)) problems.push(`${label}: holds ${JSON.stringify(held(ran.task))}, expected ${JSON.stringify(want)}`);
      if (ran.task.verificationOutcome.ready !== !clears) problems.push(`${label}: the Hub says ready=${ran.task.verificationOutcome.ready}, expected ${!clears}`);
    };
    const rows = [
      // The tools that can change the files, whatever they are given. The branch is switched through mcp_call: the arguments of the routed call decide it.
      ['move_path', [tool('move_path', { source: 'slow.js', destination: 'moved.js' })], true],
      ['delete_path', [tool('delete_path', { path: 'slow.js' })], true],
      ['git_checkout', [tool('git_checkout', { ref: 'side' })], true],
      ['git_merge', [tool('git_merge', { branch: 'side' })], true],
      ['git_branch switch (routed)', [routed('git_branch', { action: 'switch', name: 'side' })], true],
      // Control, and the tools that leave the files as they are: a plan, an empty folder, a list of branches, staging and committing what was reviewed.
      ['nothing after the review', [], false],
      ['make_directory', [tool('make_directory', { path: 'newdir' })], false],
      ['update_plan', [tool('update_plan', { items: [{ text: 'Fix add()', status: 'done', evidence: 'npm test printed OK 1 test' }] })], false],
      ['git_branch list', [tool('git_branch', { action: 'list' })], false],
      ['git_add and git_commit', [tool('git_add', { paths: ['calc.js'] }), tool('git_commit', { message: 'fix: add() adds' })], false],
    ];
    let committed = null;
    for (const [at, [label, calls, clears]] of rows.entries()) {
      const ran = await run(`stale-${at}`, calls);
      judge(label, ran, clears);
      if (label === 'git_add and git_commit') committed = git(ran.dir, ['rev-list', '--count', 'HEAD']).trim();
    }
    equal(committed, '2', '(premise) the reviewed change was really committed');
    equal(problems, [], 'every tool left the receipts as it left the files');
  });

  // ---------------------------------------------------------------- every tool is classified
  // mutatesTree (lib/agent-progress.mjs) is a list of names: the registry's category is about permission (npm test, git_add and make_directory are all workspace_edit) and cannot say which tool
  // changes what a file holds. So a tool added to the catalog later would stay out of the list unnoticed, and the receipts would survive it. Every tool that is not read-only is put here once,
  // with the arguments that make it change files or not, and the first check breaks when the catalog has a tool this list has not.
  await section('every tool of the real catalog that is not read-only is classified for the receipts', async () => {
    const RULES = [
      // Can change the files (with these arguments).
      ['local.write_file', {}, true], ['local.edit_file', {}, true], ['local.files_write_batch', {}, true], ['local.files_apply_patch', {}, true],
      ['local.move_path', {}, true], ['local.delete_path', {}, true],
      ['local.git_checkout', {}, true], ['local.git_merge', {}, true], ['local.git_branch', { action: 'create' }, true], ['local.git_branch', { action: 'switch' }, true],
      ['local.worktrees_create', {}, true], ['local.worktrees_remove', {}, true],
      ['local.rename_symbol', { apply: true }, true], ['local.format_document', { apply: true }, true], ['local.organize_imports', { apply: true }, true],
      // The same tools asked only to look.
      ['local.git_branch', { action: 'list' }, false], ['local.rename_symbol', {}, false], ['local.format_document', {}, false], ['local.organize_imports', {}, false],
      // Leave what the project's files hold as it is: a plan, a token profile, the Hub's own notes (.chatmcp/knowledge.json), an empty folder, staging and committing.
      ['local.update_plan', {}, false], ['local.token_profile', {}, false], ['local.knowledge_create', {}, false], ['local.make_directory', {}, false], ['local.git_add', {}, false], ['local.git_commit', {}, false],
      // Work outside the folder or in a browser, a debugger breakpoint, a stopped background task, a snapshot kept in the Hub's own folder.
      ['local.tasks_cancel', {}, false], ['local.debug_breakpoint', {}, false], ['studio.checkpoint', {}, false],
      ['local.github_action', {}, false], ['local.github_pr_merge', {}, false], ['local.github_release_create', {}, false], ['local.github_rerun_failed', {}, false], ['local.github_code_search', {}, false],
      ['local.web_fetch', {}, false], ['local.web_search', {}, false], ['local.web_extract', {}, false], ['local.docs_search', {}, false], ['local.dependency_lookup', {}, false],
      ['local.browser_launch', {}, false], ['local.browser_navigate', {}, false], ['local.browser_click', {}, false], ['local.browser_fill', {}, false], ['local.browser_screenshot', {}, false],
      ['local.browser_close', {}, false], ['local.browser_trace_start', {}, false], ['local.browser_trace_stop', {}, false], ['local.responsive_check', {}, false], ['local.screenshot_capture', {}, false],
      // Run code, so they can change files without the Hub seeing it: the documented limit. A shell command that edits a file leaves the receipts.
      ['local.run_command', { command: 'sed -i s/a/b/ calc.js' }, false], ['local.tasks_run', { command: 'sed -i s/a/b/ calc.js' }, false], ['local.test_run', {}, false], ['local.build_run', {}, false],
      ['local.debug_start', {}, false], ['local.debug_continue', {}, false], ['local.debug_step', {}, false], ['local.debug_evaluate', {}, false], ['local.debug_stop', {}, false],
      ['local.git_commit', { run_hooks: true }, false],
    ];
    const catalog = manager.catalog.tools;
    const writers = catalog.filter((entry) => entry.annotations?.readOnlyHint !== true).map((entry) => entry.name).sort();
    equal(writers, [...new Set(RULES.map(([name]) => name))].sort(), 'every tool that is not read-only is in the list above, and nothing else is');
    const wrong = RULES.filter(([name, args, mutates]) => mutatesTree(name, args) !== mutates).map(([name, args, mutates]) => `${name} ${JSON.stringify(args)} should ${mutates ? '' : 'not '}make the receipts stale`);
    equal(wrong, [], 'and mutatesTree says what the list says');
    equal(catalog.filter((entry) => entry.annotations?.readOnlyHint === true && mutatesTree(entry.name, {})).map((entry) => entry.name), [], 'a read-only tool never makes them stale');
  });

  // ---------------------------------------------------------------- the name a call is judged by
  // The loop runs a call under its catalog name (mcp_call turns the short read_file into local.read_file), but the receipts were judged by the name the model wrote, and the verifier only knows
  // the qualified one: through mcp_call the short name never left a receipt of any kind.
  await section('a call through mcp_call leaves the same receipts under its short name as under its full name (real tools)', async () => {
    const GOAL = 'Read calc.js and find out why add() returns the wrong sum; then fix it with the smallest change and run the project tests; finally review the Git diff and report what is still limited.';
    const routed = (name, args) => tool('mcp_call', { name, arguments_json: JSON.stringify(args) });
    const run = async (name, qualify) => {
      const dir = await project(name);
      await manager.selectWorkspace(dir);
      manager.permissions.configure({ mode: 'autonomous', executionPolicy: 'host-review' });
      const call = (short, args) => routed(qualify ? `local.${short}` : short, args);
      const model = scripted([
        () => [call('read_file', { path: 'calc.js' })],
        ({ last }) => [call('edit_file', { path: 'calc.js', old_string: 'a - b', new_string: 'a + b', expected_sha256: last.structuredContent.sha256 })],
        () => [call('run_command', { command: 'npm test', description: 'Run the tests' })],
        () => [call('git_diff', {})],
        () => [call('read_file', { path: 'calc.js' })],
        () => [say('Done.')],
      ]);
      const agent = agentFor(manager, model, name);
      const task = await finish(agent, (await agent.start({ prompt: GOAL })).id);
      equal(task.status, 'completed', `${name}: the task completed (${task.error ?? ''})`);
      check((await fs.readFile(path.join(dir, 'calc.js'), 'utf8')).includes('a + b'), `${name}: (premise) the routed call was really run`);
      return task;
    };
    // What a receipt says, less the id of a check or a review (made from the folder and the diff): the same script in two folders.
    const shape = (task) => Object.fromEntries(['verifiedInspections', 'verifiedFiles', 'verifiedChecks', 'gitReviews'].map((key) => [key, task.progress[key].map(({ kind, step, path: file, sha256 }) => ({ kind, step, file, sha256 }))]));
    const full = await run('names-full', true);
    const short = await run('names-short', false);
    equal(held(full), { read: 1, edit: 1, check: 1, review: 1 }, 'the full name: (premise) one receipt of each kind');
    equal(held(short), held(full), 'the short name leaves one receipt of each kind too');
    equal(shape(short), shape(full), 'the same receipts, at the same steps, for the same files');
    equal(short.goalPlan.evidence, full.goalPlan.evidence, 'and the plan counts the same evidence');
    equal([short.verificationOutcome.ready, full.verificationOutcome.ready], [true, true], 'and the Hub has every receipt the plan asks for');
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
    const secret = 'local-backend-test-secret-0123456789abcdef';
    const child = spawn(process.execPath, [path.join(bundleRoot, 'hub.mjs'), '--state-dir', state, '--port', String(free), '--no-open', '--project', dir], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CHATMCP_BACKEND: '', OPENAI_API_KEY: '', CHATMCP_HUB_SECRET: secret, CHATMCP_UPDATE_FEED_URL: 'http://127.0.0.1:9/RELEASE-MANIFEST.json' } });
    cleanups.push(child);
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
    const base = `http://127.0.0.1:${free}`;
    const auth = { Authorization: `Bearer ${secret}` };
    let snapshot = null;
    const until = Date.now() + 30_000;
    while (Date.now() < until) {
      try {
        const health = await fetch(`${base}/api/health`).then((response) => response.json());
        if (health.initialized) {
          snapshot = await fetch(`${base}/api/state`, { headers: auth }).then((response) => response.json());
          if (snapshot.services?.local?.state === 'ready') break;
        }
      } catch { /* not listening yet */ }
      await sleep(100);
    }
    check(snapshot?.services?.local?.state === 'ready', `the Hub became ready on its own\n${output}`);
    equal([snapshot.backend, snapshot.agent.mode, snapshot.workspace.path], ['local', 'api', dir], 'local backend, API mode, project opened');
    equal(snapshot.dataDirectory, state, 'data goes where --state-dir says');
    check(snapshot.toolCounts.local === 99, 'tools registered');
    equal((await fetch(`${base}/api/state`)).status, 401, 'no state without the session secret');
    const text = await fetch(`${base}/api/instructions`, { headers: auth }).then((response) => response.status);
    equal(text, 410, 'removed legacy MCP instructions explicitly return Gone');
    const response = await fetch(`${base}/api/hub/shutdown`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', Origin: base, 'X-ChatMCP-Request': 'local-dashboard', 'X-ChatMCP-CSRF': snapshot.csrfToken }, body: '{}' });
    equal(response.status, 200, 'shutdown accepted');
    const code = await Promise.race([exited, sleep(20_000).then(() => 'timeout')]);
    equal(code, 0, `clean exit\n${output}`);
    // close() writes one line per step as the step begins, and "done" before the exit: a log that ends in the middle names the step that hung (a Windows E2E teardown was once blamed on the Hub for lack of this).
    equal([...output.matchAll(/Stop: ([a-z ]+) \(\+\d+ ms\)/g)].map((match) => match[1]), ['downloads', 'terminal', 'agent', 'manager', 'server', 'session', 'instance lock', 'done'], 'the stop of the Hub leaves one line per step (the cut of a download in progress first), and ends with "done"');
    await fs.access(path.join(state, 'hub-state.json'));
    checks += 1;
  });

  console.log(`PASS: ${checks} checks - local backend: standalone start, real tool loop, permission modes, checkpoints, secrets, cancellation, hostile Git settings`);
} finally {
  for (const child of cleanups) { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}
