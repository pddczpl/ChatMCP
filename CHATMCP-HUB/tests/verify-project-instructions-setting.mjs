// The owner's switch for the project instructions is a saved setting, and every runner that starts a task follows it.
//
// P1-D read CHATMCP_PROJECT_INSTRUCTIONS once, when a runner was made, and there was no other way to say it. The owner can now also say it in Settings: a choice kept
// with the Hub's data that applies from the next run, whichever runner starts it (the foreground one, a pooled chat that runs in its own worktree, a coding worker).
// This suite pins four things:
//   1. the rule: the environment variable (read once, when the Hub starts) beats the saved choice, which beats the default (on), and the setting says which of the
//      three decided;
//   2. the store: what it writes, that a restart finds it, what it refuses (a value that is not true or false, a change the variable has already decided), that a
//      file it cannot read costs the owner nothing but the saved choice, and that a write that fails changes nothing;
//   3. the real AgentRunner: a runner made BEFORE the choice is changed obeys it on its next run, a fixed setting keeps working as it did, a source that answers
//      with nothing usable is an error and not a quiet "on";
//   4. the two other places a runner is made, each with a runner that already exists when the choice changes: a pooled chat that runs in its own worktree (and is
//      reused for the next message) and a coding worker. A build that forgets to hand them the setting reads the environment instead and fails here.
//
// The model is the only scripted part. The route and the Settings page are in verify-e2e-project-instructions-switch.mjs (a real Hub process).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRunner } from '../lib/agent.mjs';
import { assembleStudio } from '../lib/assemble.mjs';
import { CodingWorktreeOrchestrator } from '../lib/coding-orchestrator.mjs';
import { ConcurrentApiAgent } from '../lib/concurrent-api-agent.mjs';
import { HubManager } from '../lib/manager.mjs';
import {
  PROJECT_INSTRUCTIONS_FILE, PROJECT_INSTRUCTIONS_MAX_BYTES, PROJECT_INSTRUCTIONS_VARIABLE, PROJECT_INSTRUCTION_FILES, ProjectInstructionsStore, projectInstructionsSetting,
} from '../lib/project-instructions.mjs';

const hubRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
const count = (haystack, needle) => haystack.split(needle).length - 1;
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (condition, label, tries = 600) => {
  for (let i = 0; i < tries; i += 1) { if (await condition()) return; await settle(25); }
  throw new Error(`Timed out: ${label}`);
};

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-pi-setting-')));
let folders = 0;
const folder = async () => { const directory = path.join(root, `d-${(folders += 1)}`); await fs.mkdir(directory, { recursive: true }); return directory; };
const VARIABLE = PROJECT_INSTRUCTIONS_VARIABLE;
const MARK = 'SWITCH-GUIDANCE-MARK-7b3e';
const GUIDED = { 'AGENTS.md': `# Rules\n${MARK}\nRun \`npm test\` before you finish.\n` };

try {
  // ---- 1. the rule ------------------------------------------------------------------------------------------------------------------------
  {
    assert.equal(PROJECT_INSTRUCTIONS_FILE, 'project-instructions.json');
    const rows = [];
    // [environment value, saved choice, enabled, source]
    for (const [value, saved, enabled, source] of [
      [undefined, null, true, 'default'], ['', null, true, 'default'], ['  ', null, true, 'default'], ['maybe', null, true, 'default'],
      [undefined, true, true, 'config'], [undefined, false, false, 'config'], ['', false, false, 'config'], ['maybe', false, false, 'config'],
      ['off', null, false, 'env'], ['OFF', true, false, 'env'], [' 0 ', true, false, 'env'], ['false', false, false, 'env'], ['no', true, false, 'env'], ['disabled', true, false, 'env'],
      ['on', null, true, 'env'], ['ON', false, true, 'env'], ['1', false, true, 'env'], ['true', false, true, 'env'], ['yes', false, true, 'env'], ['enabled', false, true, 'env'],
    ]) {
      const setting = projectInstructionsSetting(value === undefined ? {} : { [VARIABLE]: value }, saved);
      rows.push([value, saved, setting.enabled, setting.source]);
      assert.deepEqual([setting.enabled, setting.source, setting.saved], [enabled, source, saved], `variable ${JSON.stringify(value)}, saved ${saved}`);
    }
    // What is not a boolean is not a saved choice.
    for (const bad of [undefined, 'false', 'off', 0, 1, {}, [], NaN]) {
      const setting = projectInstructionsSetting({}, bad);
      assert.deepEqual([setting.enabled, setting.source, setting.saved], [true, 'default', null], `a saved ${JSON.stringify(bad)} is no choice`);
    }
    const setting = projectInstructionsSetting({}, false);
    assert.deepEqual([setting.variable, setting.maxBytes, setting.files], [VARIABLE, PROJECT_INSTRUCTIONS_MAX_BYTES, [...PROJECT_INSTRUCTION_FILES]], 'the setting still says which variable, how much and which files');
    assert.ok(Object.isFrozen(setting) && Object.isFrozen(projectInstructionsSetting()), 'a setting cannot be edited by whoever holds it');
    assert.equal(projectInstructionsSetting().saved, null, 'with no argument: the process environment and no saved choice');
  }
  ok('the environment variable beats the saved choice, which beats the default (on); the setting says which of them decided, and a saved value that is not true or false is no choice');

  // ---- 2. the store -----------------------------------------------------------------------------------------------------------------------
  const readFile = async (directory) => fs.readFile(path.join(directory, PROJECT_INSTRUCTIONS_FILE), 'utf8');
  {
    const directory = await folder();
    const logged = [];
    const store = new ProjectInstructionsStore({ directory, env: {}, log: (line) => logged.push(line) });
    await store.load();
    assert.deepEqual([store.current().enabled, store.current().source, store.current().saved], [true, 'default', null], 'nothing saved: on, by default');
    assert.equal(await fs.stat(path.join(directory, PROJECT_INSTRUCTIONS_FILE)).catch(() => null), null, 'and loading writes nothing');
    assert.equal(store.file, path.join(directory, PROJECT_INSTRUCTIONS_FILE), 'the file lives in the data folder it was given');

    const off = await store.set(false);
    assert.deepEqual([off.enabled, off.source, off.saved], [false, 'config', false], 'set(false) answers with the setting that now applies');
    assert.deepEqual(JSON.parse(await readFile(directory)), { version: 1, enabled: false }, 'and keeps exactly the version and the choice (nothing about the files or the workspace)');
    assert.deepEqual([store.current().enabled, store.current().source], [false, 'config'], 'current() agrees');

    // A restart: a new store over the same folder finds the choice.
    const restarted = new ProjectInstructionsStore({ directory, env: {} });
    assert.deepEqual([restarted.current().enabled, restarted.current().source], [true, 'default'], 'before it loads, a store knows no saved choice');
    await restarted.load();
    assert.deepEqual([restarted.current().enabled, restarted.current().source, restarted.current().saved], [false, 'config', false], 'after a restart the choice is still there');
    const on = await restarted.set(true);
    assert.deepEqual([on.enabled, on.source, on.saved], [true, 'config', true], 'on again is a saved choice too, not the default');
    assert.deepEqual(JSON.parse(await readFile(directory)), { version: 1, enabled: true });
    assert.equal(logged.length, 1, 'loading a healthy folder logs nothing; the one change that was made is logged once');
    assert.match(logged[0], /tắt/, 'and the line says what the choice was');
    // The temporary file of the atomic write is gone.
    assert.deepEqual((await fs.readdir(directory)).sort(), [PROJECT_INSTRUCTIONS_FILE], 'and leaves nothing else behind');
  }
  ok('the choice is kept as {version, enabled} in the data folder, a restart finds it, and nothing else is written');

  {
    const directory = await folder();
    const store = new ProjectInstructionsStore({ directory, env: {} });
    await store.load();
    for (const bad of ['false', 'true', 'off', 0, 1, null, undefined, {}, [], NaN]) {
      await assert.rejects(() => store.set(bad), (error) => error.statusCode === 400 && error.code === 'project_instructions_invalid', `${JSON.stringify(bad)} is refused with 400`);
    }
    assert.deepEqual([store.current().enabled, store.current().source], [true, 'default'], 'a refused value changes nothing');
    assert.equal(await fs.stat(path.join(directory, PROJECT_INSTRUCTIONS_FILE)).catch(() => null), null, 'and writes nothing');
  }
  ok('set() takes true or false and nothing else: any other value is refused with 400 and changes nothing');

  {
    for (const [value, expected] of [['off', false], ['on', true], ['0', false], ['yes', true]]) {
      const directory = await folder();
      const store = new ProjectInstructionsStore({ directory, env: { [VARIABLE]: value } });
      await store.load();
      for (const wanted of [true, false]) {
        await assert.rejects(() => store.set(wanted), (error) => error.statusCode === 409 && error.code === 'project_instructions_env' && error.message.includes(VARIABLE), `variable ${value}: set(${wanted}) is refused with 409 and names the variable`);
      }
      assert.deepEqual([store.current().enabled, store.current().source, store.current().saved], [expected, 'env', null], `variable ${value}: the setting stays what the variable says`);
      assert.equal(await fs.stat(path.join(directory, PROJECT_INSTRUCTIONS_FILE)).catch(() => null), null, `variable ${value}: and nothing is saved`);
    }
    // A choice saved earlier is kept, shown and not applied while the variable decides; it applies again when the variable is gone.
    const directory = await folder();
    await fs.writeFile(path.join(directory, PROJECT_INSTRUCTIONS_FILE), JSON.stringify({ version: 1, enabled: false }));
    const locked = new ProjectInstructionsStore({ directory, env: { [VARIABLE]: 'on' } });
    await locked.load();
    assert.deepEqual([locked.current().enabled, locked.current().source, locked.current().saved], [true, 'env', false], 'variable on, saved off: on, decided by the variable, with the saved choice still visible');
    const free = new ProjectInstructionsStore({ directory, env: {} });
    await free.load();
    assert.deepEqual([free.current().enabled, free.current().source, free.current().saved], [false, 'config', false], 'without the variable the saved choice applies');
    // A value that means nothing is not a variable.
    const vague = new ProjectInstructionsStore({ directory: await folder(), env: { [VARIABLE]: 'maybe' } });
    await vague.load();
    assert.equal((await vague.set(false)).source, 'config', 'a variable that is neither on nor off decides nothing, so the owner can still choose');
  }
  ok('while the environment variable decides, set() is refused with 409, nothing is saved, and the saved choice is kept for when the variable is gone');

  {
    // The variable is read once, when the store is made (as a runner always read it): the setting does not follow the process environment.
    const env = { [VARIABLE]: 'off' };
    const store = new ProjectInstructionsStore({ directory: await folder(), env });
    delete env[VARIABLE];
    assert.deepEqual([store.current().enabled, store.current().source], [false, 'env'], 'a variable removed afterwards is still the one the Hub started with');
    const later = {};
    const other = new ProjectInstructionsStore({ directory: await folder(), env: later });
    later[VARIABLE] = 'off';
    assert.deepEqual([other.current().enabled, other.current().source], [true, 'default'], 'and one added afterwards is not seen');
    const real = process.env[VARIABLE];
    try {
      process.env[VARIABLE] = 'off';
      assert.deepEqual([new ProjectInstructionsStore({ directory: await folder() }).current().enabled], [false], 'with no env argument the process environment is read, once');
    } finally { if (real === undefined) delete process.env[VARIABLE]; else process.env[VARIABLE] = real; }
  }
  ok('the variable is read once, when the Hub starts: only the saved choice is read live');

  {
    // A file that cannot be used costs the owner the saved choice and nothing else: the Hub starts, the setting is the default, the owner can choose again.
    for (const [label, text] of [
      ['invalid JSON', '{ not json'], ['an empty file', ''], ['an array', '[true]'], ['null', 'null'], ['a string for enabled', '{"version":1,"enabled":"false"}'],
      ['a number for enabled', '{"version":1,"enabled":0}'], ['no enabled', '{"version":1}'], ['a binary file', '\u0000\u0001\u0002'],
    ]) {
      const directory = await folder();
      await fs.writeFile(path.join(directory, PROJECT_INSTRUCTIONS_FILE), text);
      const logged = [];
      const store = new ProjectInstructionsStore({ directory, env: {}, log: (line) => logged.push(line) });
      await assert.doesNotReject(() => store.load(), `${label}: loading does not throw`);
      assert.deepEqual([store.current().enabled, store.current().source, store.current().saved], [true, 'default', null], `${label}: the default applies`);
      // 'null' is valid JSON that holds nothing (nothing was saved); an unreadable file and a file of the wrong shape each get one line, and the line never quotes the file.
      const unreadable = ['invalid JSON', 'an empty file', 'a binary file'].includes(label);
      assert.equal(logged.length, label === 'null' ? 0 : 1, `${label}: ${label === 'null' ? 'nothing to say' : 'one line says that the file is of no use'}`);
      if (unreadable) assert.match(logged[0], /^Không đọc được project-instructions\.json \(dữ liệu không hợp lệ\); dùng mặc định: nạp hướng dẫn dự án\.$/, `${label}: says it could not be read, and why, without the path or the text`);
      else if (label !== 'null') assert.match(logged[0], /^project-instructions\.json không có lựa chọn hợp lệ; dùng mặc định: nạp hướng dẫn dự án\.$/, `${label}: says the file holds no valid choice`);
      assert.ok(logged.every((line) => !line.includes(text.slice(0, 6)) || text.length < 6), `${label}: without quoting the file`);
      const chosen = await store.set(false);
      assert.deepEqual([chosen.enabled, chosen.source], [false, 'config'], `${label}: the owner can choose again`);
      assert.deepEqual(JSON.parse(await readFile(directory)), { version: 1, enabled: false }, `${label}: and the file is valid afterwards`);
    }
    // A byte order mark (an editor on Windows) is not a problem.
    const directory = await folder();
    await fs.writeFile(path.join(directory, PROJECT_INSTRUCTIONS_FILE), `${String.fromCharCode(0xfeff)}${JSON.stringify({ version: 1, enabled: false })}`);
    const store = new ProjectInstructionsStore({ directory, env: {} });
    await store.load();
    assert.deepEqual([store.current().enabled, store.current().source], [false, 'config'], 'a byte order mark is dropped');
  }
  ok('a file that cannot be used does not stop the Hub: the default applies, one line says so, and the owner can choose again');

  {
    // A write that fails changes nothing: the file is written first and the memory follows.
    const directory = await folder();
    const blocker = path.join(directory, 'in-the-way');
    await fs.writeFile(blocker, 'a file where the data folder should be');
    const store = new ProjectInstructionsStore({ directory: blocker, env: {} });
    await store.load();
    await assert.rejects(() => store.set(false), 'the write fails');
    assert.deepEqual([store.current().enabled, store.current().source, store.current().saved], [true, 'default', null], 'and the setting is still what it was');
    assert.equal((await fs.readFile(blocker, 'utf8')), 'a file where the data folder should be', 'the file in the way is untouched');
    // Even a first success after a failure is not confused by it.
    const moved = new ProjectInstructionsStore({ directory: path.join(directory, 'fresh', 'deep'), env: {} });
    assert.equal((await moved.set(false)).enabled, false, 'a folder that does not exist yet is created');
  }
  ok('a write that fails changes nothing, and the data folder is created when it is missing');

  {
    // Quick clicks: the last one asked is the one that stays, in memory and on disk.
    const directory = await folder();
    const store = new ProjectInstructionsStore({ directory, env: {} });
    await store.load();
    const results = await Promise.all([store.set(false), store.set(true), store.set(false), store.set(true), store.set(false)]);
    assert.deepEqual(results.map((setting) => setting.enabled), [false, true, false, true, false], 'each call is answered with the setting it made');
    assert.equal(store.current().enabled, false, 'the last call decides');
    assert.deepEqual(JSON.parse(await readFile(directory)), { version: 1, enabled: false }, 'and the file agrees with the memory');
  }
  ok('changes made one after another are applied in order, so the file and the memory cannot disagree');

  // ---- 3. the real AgentRunner ----------------------------------------------------------------------------------------------------------------
  const tool = (name) => ({ name: `local.${name}`, originalName: name, server: 'local', inputSchema: { type: 'object' } });
  const reply = (output) => ({ status: 'completed', usage: { input_tokens: 1, output_tokens: 1 }, output });
  const finalAnswer = (text = 'Done.') => reply([{ type: 'message', role: 'assistant', phase: 'final', content: [{ type: 'output_text', text }] }]);
  const toolCall = (callId, name = 'read_file', args = { path: 'package.json' }) => reply([{ type: 'function_call', call_id: callId, name, status: 'completed', arguments: JSON.stringify(args) }]);
  const twoTurns = ({ input, requests }) => (input.at(-1)?.type === 'function_call_output' ? finalAnswer() : toolCall(`call-${requests.length}`));
  let sessions = 0;
  async function session({ files = GUIDED, runnerOptions = {} } = {}) {
    sessions += 1;
    const dir = await folder();
    for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(dir, name), content);
    const requests = [];
    let locked = false;
    let id = null;
    const manager = {
      backend: 'local', secrets: [], instanceId: `pi-setting-${sessions}`, generation: 1,
      state() { return { workspace: { path: dir }, generation: this.generation, instanceId: this.instanceId }; },
      acquireTask() { if (locked) return false; locked = true; return true; },
      releaseTask() { locked = false; },
      studio: { async checks() { return { suggested: [] }; } },
      async createAgentSession() {
        return {
          catalog: { tools: [tool('read_file')], prompts: [], resources: [], resourceTemplates: [], servers: {} }, async close() {},
          async callTool() { return { isError: false, content: [{ type: 'text', text: '{"name":"demo"}' }], structuredContent: { notVerified: true } }; },
        };
      },
    };
    const provider = {
      ready: () => true, snapshot: () => ({ provider: 'fixture', model: 'capture' }),
      async respond({ input, instructions, beforeModelRequest }) {
        beforeModelRequest?.();
        requests.push({ input: structuredClone(input), instructions: String(instructions ?? '') });
        return twoTurns({ input, requests });
      },
    };
    const runner = new AgentRunner({ manager, provider, taskDirectory: path.join(root, `tasks-${sessions}`), ...runnerOptions });
    await runner.load();
    const say = async (prompt) => {
      const before = requests.length;
      id = (id === null ? await runner.start({ prompt, maxSteps: 8 }) : await runner.continue({ id, prompt, maxSteps: 8 })).id;
      for (let i = 0; i < 1500 && runner.get(id).status === 'running'; i += 1) await settle(10);
      assert.equal(runner.get(id).status, 'completed', runner.get(id).error ?? '');
      for (let i = 0; i < 300 && runner.state().activeTaskId !== null; i += 1) await settle(10);
      return requests.slice(before);
    };
    return { runner, say, task: () => runner.get(id) };
  }

  {
    const store = new ProjectInstructionsStore({ directory: await folder(), env: {} });
    await store.load();
    const s = await session({ runnerOptions: { projectInstructions: store } });
    try {
      // The runner exists, with the setting in its hand, when the owner changes his mind: it must not have copied the answer.
      const first = await s.say('Explain the layout of this project.');
      assert.equal(first.length, 2, 'a tool call and then the answer: two requests');
      assert.ok(first.every((request) => count(request.instructions, MARK) === 1), 'on: the guidance is in the instructions of each request');
      assert.deepEqual([s.task().projectInstructions.enabled, s.runner.state().projectInstructions.source], [true, 'default'], 'the task and the runner state say it was on, by default');

      await store.set(false);
      assert.deepEqual([s.runner.state().projectInstructions.enabled, s.runner.state().projectInstructions.source, s.runner.state().projectInstructions.saved], [false, 'config', false], 'the runner state follows the choice at once');
      const second = await s.say('And what about the tests?');
      assert.ok(second.every((request) => count(request.instructions, MARK) === 0 && !request.instructions.includes('PROJECT GUIDANCE')), 'off: the next message of the same conversation carries no guidance');
      assert.equal(s.task().projectInstructions.enabled, false, 'the task records that this run was off');
      assert.equal(s.task().events.filter((event) => event.type === 'instructions_loaded').at(-1).projectInstructions.enabled, false, 'and so does its event');
      assert.match(s.task().events.filter((event) => event.type === 'instructions_loaded').at(-1).message, /đang tắt/, 'which says it is off');

      await store.set(true);
      const third = await s.say('One more question.');
      assert.ok(third.every((request) => count(request.instructions, MARK) === 1), 'on again: the guidance is back, once per request');
      assert.equal(s.task().projectInstructions.enabled, true);
    } finally { await s.runner.shutdown(); }
  }
  ok('a runner made before the choice changes follows it on its next run, both ways, in the same conversation');

  {
    // A message that arrives while a run is going does not start a new run, so it cannot change what that run was told; the next run does.
    const store = new ProjectInstructionsStore({ directory: await folder(), env: {} });
    await store.load();
    const a = await session({ runnerOptions: { projectInstructions: store } });
    const b = await session({ runnerOptions: { projectInstructions: store } });
    try {
      await store.set(false);
      const [ra, rb] = await Promise.all([a.say('Question one.'), b.say('Question two.')]);
      assert.ok([...ra, ...rb].every((request) => count(request.instructions, MARK) === 0), 'two runners given the same store are both off');
      await store.set(true);
      const [ra2, rb2] = await Promise.all([a.say('Question three.'), b.say('Question four.')]);
      assert.ok([...ra2, ...rb2].every((request) => count(request.instructions, MARK) === 1), 'and both on again');
    } finally { await a.runner.shutdown(); await b.runner.shutdown(); }
  }
  ok('every runner given the one store follows it');

  {
    // The environment variable decides before the first message and stays: a runner whose store was made with it off never loads, whatever was saved.
    const directory = await folder();
    await fs.writeFile(path.join(directory, PROJECT_INSTRUCTIONS_FILE), JSON.stringify({ version: 1, enabled: true }));
    const store = new ProjectInstructionsStore({ directory, env: { [VARIABLE]: 'off' } });
    await store.load();
    const s = await session({ runnerOptions: { projectInstructions: store } });
    try {
      const requests = await s.say('Explain the layout of this project.');
      assert.ok(requests.every((request) => count(request.instructions, MARK) === 0), 'variable off, saved on: no guidance');
      assert.deepEqual([s.runner.state().projectInstructions.enabled, s.runner.state().projectInstructions.source, s.runner.state().projectInstructions.saved], [false, 'env', true], 'and the state says the variable decided, and keeps the saved choice');
    } finally { await s.runner.shutdown(); }
  }
  ok('the environment variable decides over a saved choice in the runner as well');

  {
    // Fixed settings (what the environment gave a runner made without a store, and what tests hand in) work as they did.
    const off = await session({ runnerOptions: { projectInstructions: { enabled: false } } });
    try {
      assert.ok((await off.say('Explain.')).every((request) => count(request.instructions, MARK) === 0), 'a fixed {enabled: false} loads nothing');
      assert.deepEqual([off.runner.state().projectInstructions.enabled, off.runner.state().projectInstructions.source], [false, 'option'], 'and says the caller chose it');
    } finally { await off.runner.shutdown(); }
    const plain = await session();
    try {
      assert.ok((await plain.say('Explain.')).every((request) => count(request.instructions, MARK) === 1), 'no option: on, as before');
      assert.deepEqual([plain.runner.state().projectInstructions.enabled, plain.runner.state().projectInstructions.source, plain.runner.state().projectInstructions.saved], [true, 'default', null]);
    } finally { await plain.runner.shutdown(); }
    const manager = { backend: 'local', secrets: [], state: () => ({}) };
    for (const bad of ['off', true, 1, {}, [], { enabled: 'no' }, { enabled: 1 }, { current: 'x' }, { current: true }, { current: null, enabled: 'x' }]) {
      assert.throws(() => new AgentRunner({ manager, provider: {}, taskDirectory: root, projectInstructions: bad }), TypeError, `${JSON.stringify(bad)} is not a setting`);
    }
    // Any object with a current() is a source, and it is asked at each run: the Hub's store is the only one in production.
    let asks = 0;
    const counting = await session({ runnerOptions: { projectInstructions: { current: () => { asks += 1; return { enabled: false, source: 'config' }; } } } });
    try {
      assert.ok((await counting.say('Explain.')).every((request) => count(request.instructions, MARK) === 0), 'a source that says off is obeyed');
      const asksForOneRun = asks;
      assert.ok(asksForOneRun >= 1, 'it was asked');
      await counting.say('Again.');
      assert.ok(asks > asksForOneRun, 'and asked again for the next run');
    } finally { await counting.runner.shutdown(); }
  }
  ok('a fixed setting works as before, anything that is not a setting is refused when the runner is made, and a source is asked at each run');

  // ---- 4. the other places a runner is made ----------------------------------------------------------------------------------------------------
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', windowsHide: true });
  const repository = async (name) => {
    const dir = path.join(root, name);
    await fs.mkdir(dir, { recursive: true });
    git(dir, 'init', '-b', 'main');
    await fs.writeFile(path.join(dir, 'README.md'), '# fixture\n');
    await fs.writeFile(path.join(dir, 'AGENTS.md'), GUIDED['AGENTS.md']);
    git(dir, 'add', '.');
    git(dir, 'commit', '-m', 'fixture');
    return dir;
  };
  const parentOf = async (project, name, store) => {
    const parent = new HubManager({ bundleRoot: hubRoot, dataDirectory: path.join(root, `${name}-hub`), backend: 'local', log: () => {} });
    await parent.load(project);
    assembleStudio(parent, { bundleRoot: hubRoot });
    await parent.permissions.load();
    parent.permissions.mode = 'autonomous';
    await parent.startLocal(project);
    parent.projectInstructionsSetting = store;
    return parent;
  };

  {
    // A pooled chat that runs in its own worktree is a runner of its own, kept and reused for the next message: it must ask the Hub's setting each time.
    const project = await repository('pool-project');
    const store = new ProjectInstructionsStore({ directory: await folder(), env: {} });
    await store.load();
    const hub = await parentOf(project, 'pool', store);
    const asked = [];
    let holdFirst = null;
    const provider = {
      ready: () => true, snapshot: () => ({ provider: 'fake', model: 'mock' }),
      async respond({ input, instructions }) {
        const text = JSON.stringify(input);
        const chat = text.includes('Chat ONE') ? 'one' : 'two';
        asked.push({ chat, guidance: count(String(instructions), MARK), prompt: text.includes('FOLLOW-UP') ? 'follow-up' : 'first' });
        if (chat === 'one' && holdFirst) await holdFirst;
        return finalAnswer(`Answered ${chat}.`);
      },
    };
    const primary = new AgentRunner({ manager: hub, provider, taskDirectory: path.join(root, 'pool-hub', 'api-tasks'), log: () => {}, projectInstructions: store });
    await primary.load();
    const pool = new ConcurrentApiAgent({ primary, manager: hub, provider, bundleRoot: hubRoot, directory: path.join(root, 'pool-hub', 'api-conversations'), log: () => {} });
    try {
      let release;
      holdFirst = new Promise((resolve) => { release = resolve; });
      const one = await pool.start({ prompt: 'Chat ONE: inspect README' });
      await until(() => asked.some((entry) => entry.chat === 'one'), 'the foreground chat to reach the model');
      // The checkout is busy, so this chat gets a worktree and a runner of its own.
      const two = await pool.start({ prompt: 'Chat TWO: inspect README as an independent chat' });
      await until(() => pool.get(two.id)?.status === 'completed', 'the pooled chat to finish its first run');
      const child = pool.get(two.id);
      assert.ok(child.worktree && child.worktree !== project, 'the second chat runs in a worktree of its own');
      assert.deepEqual(asked.filter((entry) => entry.chat === 'two').map((entry) => entry.guidance), [1], 'on: the worktree\'s AGENTS.md is in the pooled chat\'s instructions');
      release();
      await until(() => pool.get(one.id)?.status === 'completed', 'the foreground chat to finish');

      await store.set(false);
      await pool.continue({ id: two.id, prompt: 'Look again.' });
      await until(() => asked.filter((entry) => entry.chat === 'two').length === 2 && pool.get(two.id)?.status === 'completed', 'the pooled chat to run again');
      assert.equal(asked.filter((entry) => entry.chat === 'two').at(-1).guidance, 0, 'off: the same pooled runner, run again, loads nothing');
      assert.equal(pool.get(two.id).projectInstructions?.enabled, false, 'and its own task says it was off');

      await store.set(true);
      await pool.continue({ id: two.id, prompt: 'Once more.' });
      await until(() => asked.filter((entry) => entry.chat === 'two').length === 3 && pool.get(two.id)?.status === 'completed', 'the pooled chat to run a third time');
      assert.equal(asked.filter((entry) => entry.chat === 'two').at(-1).guidance, 1, 'on again: loaded again');
    } finally { await pool.shutdown?.().catch(() => {}); await primary.shutdown(); await hub.shutdown(); }
  }
  ok('a pooled chat in its own worktree asks the Hub\'s setting at each run, so a runner that already exists follows a change');

  {
    // Three orchestrators exist before the choice is changed; each starts a worker (a runner in a worktree) afterwards.
    const project = await repository('coding-project');
    const store = new ProjectInstructionsStore({ directory: await folder(), env: {} });
    await store.load();
    const hub = await parentOf(project, 'coding', store);
    const seen = [];
    const provider = {
      ready: () => true, snapshot: () => ({ provider: 'fake', model: 'fixture' }),
      async respond({ input, instructions }) { seen.push({ guidance: count(String(instructions), MARK), who: JSON.stringify(input).includes('TASK: Inspect') ? 'worker' : 'other' }); return finalAnswer('Reported.'); },
    };
    const orchestrator = (name) => new CodingWorktreeOrchestrator({ manager: hub, provider, bundleRoot: hubRoot, directory: path.join(root, `coding-${name}`) });
    const [a, b, c] = [orchestrator('a'), orchestrator('b'), orchestrator('c')];
    const run = async (agent, id) => {
      const before = seen.length;
      const job = await agent.run({ tasks: [{ id, prompt: 'Inspect the README.' }], confirmation: 'CREATE WORKTREES', maxConcurrency: 1 });
      assert.equal(job.status, 'ready_for_review', JSON.stringify(job).slice(0, 300));
      const mine = seen.slice(before).filter((entry) => entry.who === 'worker');
      assert.equal(mine.length, 1, 'the worker asked the model once');
      return mine[0].guidance;
    };
    try {
      assert.equal(await run(a, 'first'), 1, 'on: the worker\'s instructions carry the worktree\'s AGENTS.md');
      await store.set(false);
      assert.equal(await run(b, 'second'), 0, 'off: a worker started by an orchestrator that existed before the change loads nothing');
      await store.set(true);
      assert.equal(await run(c, 'third'), 1, 'on again: loaded');
    } finally { await hub.shutdown(); }
  }
  ok('a coding worker asks the Hub\'s setting when it starts, so an orchestrator that already exists follows a change');

  console.log(`PASS: ${checks} groups of checks - the owner's project-instructions switch: precedence, the store, the runner, a pooled chat and a coding worker`);
} finally {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
