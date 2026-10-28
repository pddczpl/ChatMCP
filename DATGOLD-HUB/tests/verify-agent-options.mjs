// The owner's two agent options (Settings): from which percent of its budget the history is compacted, and whether the Hub matches the checks it ran.
//
//   autoCompactPercent  a whole number from 50 to 95; 80 when the owner has chosen none (lib/compaction-v2.mjs).
//   autoAcceptChecks    OFF unless the owner turns it on; it relaxes "only the owner accepts" for the criteria that ask for a check (lib/objective-acceptance.mjs).
//
// Both are READ AT EVERY MODEL REQUEST, so a runner that already exists follows a change. This suite pins four things:
//   1. the view and the validation: the defaults, the limits, what is no choice (a value out of range, not a whole number, a switch that is not true);
//   2. the store: what it writes, that a restart finds it, what it refuses (400, nothing saved, whole patch or none), a file it cannot read, a write that fails, writes in order;
//   3. the real AgentRunner and the foreground factory of the Hub: the runner state and the task say what applied, a runner made BEFORE the change follows it, a source that
//      is not a source is refused when the runner is made;
//   4. the two other places a runner is made, each with a runner that already exists when the options change: a pooled chat in its own worktree and a coding worker.
//
// The model is the only scripted part. The route and the page are in verify-e2e-agent-options.mjs (a real Hub process) and ui/e2e/agent-options.spec.mjs.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPrimaryAgentRunner } from '../hub.mjs';
import { AGENT_OPTIONS_FILE, AgentOptionsStore, agentOptionsView } from '../lib/agent-options.mjs';
import { AgentRunner } from '../lib/agent.mjs';
import { assembleStudio } from '../lib/assemble.mjs';
import { CodingWorktreeOrchestrator } from '../lib/coding-orchestrator.mjs';
import { DEFAULT_COMPACT_PERCENT, MAX_COMPACT_PERCENT, MIN_COMPACT_PERCENT, cleanCompactPercent, compactTrigger } from '../lib/compaction-v2.mjs';
import { ConcurrentApiAgent } from '../lib/concurrent-api-agent.mjs';
import { HubManager } from '../lib/manager.mjs';

const hubRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (condition, label, tries = 600) => {
  for (let i = 0; i < tries; i += 1) { if (await condition()) return; await settle(25); }
  throw new Error(`Timed out: ${label}`);
};
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-agent-options-')));
let folders = 0;
const folder = async () => { const directory = path.join(root, `d-${(folders += 1)}`); await fs.mkdir(directory, { recursive: true }); return directory; };
const readFile = async (directory) => { try { return JSON.parse(await fs.readFile(path.join(directory, AGENT_OPTIONS_FILE), 'utf8')); } catch { return null; } };
const plain = (view) => ({ ...view });

try {
  // ---- 1. the view and the validation ---------------------------------------------------------------------------------------------------------------
  {
    assert.equal(AGENT_OPTIONS_FILE, 'agent-options.json');
    assert.deepEqual([DEFAULT_COMPACT_PERCENT, MIN_COMPACT_PERCENT, MAX_COMPACT_PERCENT], [80, 50, 95]);
    const none = agentOptionsView();
    assert.deepEqual(plain(none), { autoCompactPercent: 80, autoCompactSaved: null, autoAcceptChecks: false, defaultCompactPercent: 80, minCompactPercent: 50, maxCompactPercent: 95 },
      'nothing chosen: compaction from 80%, the Hub accepts no check, and the limits the page needs');
    assert.ok(Object.isFrozen(none) && Object.isFrozen(agentOptionsView({ autoCompactPercent: 60 })), 'a view cannot be edited by whoever holds it');
    assert.deepEqual(plain(agentOptionsView(null)), plain(none), 'no saved object is no choice');
    for (const good of [50, 51, 79, 80, 94, 95]) assert.equal(agentOptionsView({ autoCompactPercent: good }).autoCompactPercent, good, `${good} is a percent`);
    for (const bad of [49, 96, 0, -80, 100, 80.5, NaN, Infinity, 'x', '', ' ', null, undefined, true, {}, [80], [50]]) {
      assert.equal(cleanCompactPercent(bad), null, `${JSON.stringify(bad)} is no percent`);
      const view = agentOptionsView({ autoCompactPercent: bad });
      assert.deepEqual([view.autoCompactPercent, view.autoCompactSaved], [80, null], `a saved ${JSON.stringify(bad)} is no choice: 80 applies`);
    }
    for (const notTrue of [false, 'true', 'yes', 1, 0, null, undefined, {}, []]) assert.equal(agentOptionsView({ autoAcceptChecks: notTrue }).autoAcceptChecks, false, `a saved ${JSON.stringify(notTrue)} does not turn the Hub's acceptance on`);
    assert.equal(agentOptionsView({ autoAcceptChecks: true }).autoAcceptChecks, true, 'only true turns it on');
    // the trigger is the percent of the history budget of the run, and a percent that is no percent is 80
    const policy = { maxHistoryTokens: 20000 };
    assert.deepEqual([50, 80, 95].map((percent) => compactTrigger(policy, percent)), [10000, 16000, 19000]);
    assert.deepEqual([undefined, 49, 96, 'x', null].map((percent) => compactTrigger(policy, percent)), [16000, 16000, 16000, 16000, 16000], 'no percent, or one out of range: the default');
    assert.equal(compactTrigger({ maxHistoryTokens: 0 }, 80), 1000, 'a budget with no room still gets a floor');
  }
  ok('the defaults are 80% and "the Hub accepts no check"; only a whole number from 50 to 95 is a percent and only true turns the acceptance on; the trigger is the percent of the budget');

  // ---- 2. the store ----------------------------------------------------------------------------------------------------------------------------------
  {
    const directory = await folder();
    const store = new AgentOptionsStore({ directory });
    await store.load();
    assert.deepEqual(plain(store.current()), plain(agentOptionsView()), 'a new Hub: the defaults');
    assert.equal(await readFile(directory), null, 'no file is written until the owner chooses');
    const first = await store.set({ autoCompactPercent: 65 });
    assert.deepEqual([first.autoCompactPercent, first.autoCompactSaved, first.autoAcceptChecks], [65, 65, false], 'set() answers with what applies now');
    assert.deepEqual(await readFile(directory), { version: 1, autoCompactPercent: 65 }, 'and writes the version and the choice, nothing else');
    await store.set({ autoAcceptChecks: true });
    assert.deepEqual(await readFile(directory), { version: 1, autoCompactPercent: 65, autoAcceptChecks: true }, 'a change to one option keeps the other');
    const restarted = new AgentOptionsStore({ directory });
    await restarted.load();
    assert.deepEqual([restarted.current().autoCompactPercent, restarted.current().autoAcceptChecks], [65, true], 'a restart finds both');
    const reset = await store.set({ autoCompactPercent: null });
    assert.deepEqual([reset.autoCompactPercent, reset.autoCompactSaved, reset.autoAcceptChecks], [80, null, true], 'null goes back to the default (80) and keeps the other option');
    assert.deepEqual(await readFile(directory), { version: 1, autoAcceptChecks: true }, 'and the file no longer holds a percent');
    const both = await store.set({ autoCompactPercent: 90, autoAcceptChecks: false });
    assert.deepEqual([both.autoCompactPercent, both.autoAcceptChecks], [90, false], 'both options in one call');
    assert.deepEqual(await readFile(directory), { version: 1, autoCompactPercent: 90, autoAcceptChecks: false });
    assert.deepEqual((await store.set({ autoCompactPercent: 50 })).autoCompactPercent, 50);
    assert.deepEqual((await store.set({ autoCompactPercent: 95 })).autoCompactPercent, 95, 'the two ends are allowed');
    assert.throws(() => new AgentOptionsStore({}), TypeError, 'a store needs the data folder of the Hub');
  }
  ok('the options are kept as {version, ...choices} in the data folder, a restart finds them, null returns to the default, and one option never loses the other');

  {
    const directory = await folder();
    const store = new AgentOptionsStore({ directory });
    await store.load();
    await store.set({ autoCompactPercent: 70, autoAcceptChecks: true });
    const before = await readFile(directory);
    const refused = [
      undefined, null, [], [{ autoCompactPercent: 60 }], 'autoAcceptChecks', 5, true, {}, { other: 1 },
      { autoCompactPercent: 49 }, { autoCompactPercent: 96 }, { autoCompactPercent: 0 }, { autoCompactPercent: -1 }, { autoCompactPercent: 80.5 }, { autoCompactPercent: '80' }, { autoCompactPercent: NaN },
      { autoCompactPercent: Infinity }, { autoCompactPercent: true }, { autoCompactPercent: [80] }, { autoCompactPercent: {} }, { autoCompactPercent: undefined },
      { autoAcceptChecks: 'true' }, { autoAcceptChecks: 1 }, { autoAcceptChecks: 0 }, { autoAcceptChecks: null }, { autoAcceptChecks: undefined }, { autoAcceptChecks: {} },
      { autoCompactPercent: 60, other: true }, { autoCompactPercent: 60, autoAcceptChecks: 'yes' }, { autoCompactPercent: 20, autoAcceptChecks: false }, { enabled: true },
    ];
    for (const patch of refused) {
      await assert.rejects(store.set(patch), (error) => error.statusCode === 400 && error.code === 'agent_options_invalid' && typeof error.message === 'string' && error.message.length > 0, `${JSON.stringify(patch)} is refused with 400`);
      assert.deepEqual(plain(store.current()), plain(agentOptionsView({ autoCompactPercent: 70, autoAcceptChecks: true })), `${JSON.stringify(patch)} changed nothing in memory`);
      assert.deepEqual(await readFile(directory), before, `${JSON.stringify(patch)} wrote nothing`);
    }
  }
  ok('anything but autoCompactPercent (50 to 95, or null) and autoAcceptChecks (true or false) is refused with 400 as a whole: nothing is saved, not even the valid half of a bad patch');

  {
    // A file the Hub cannot use costs the owner the saved choices and nothing else.
    const logged = [];
    const open = async (content) => {
      const directory = await folder();
      if (content !== null) await fs.writeFile(path.join(directory, AGENT_OPTIONS_FILE), content);
      const store = new AgentOptionsStore({ directory, log: (line) => logged.push(line) });
      await store.load();
      return { store, directory };
    };
    for (const [label, content] of [['not JSON', '{ not json'], ['empty', ''], ['an array', '[1,2]'], ['a number', '7'], ['null', 'null'], ['values out of range', '{"autoCompactPercent":10,"autoAcceptChecks":"yes"}'], ['unknown keys', '{"enabled":true}']]) {
      logged.length = 0;
      const { store, directory } = await open(content);
      assert.deepEqual(plain(store.current()), plain(agentOptionsView()), `${label}: the defaults apply`);
      assert.ok(logged.length <= 1, `${label}: at most one line says so`);
      const chosen = await store.set({ autoCompactPercent: 60 });
      assert.equal(chosen.autoCompactPercent, 60, `${label}: the owner can choose again`);
      assert.deepEqual(await readFile(directory), { version: 1, autoCompactPercent: 60 }, `${label}: and the file is whole again`);
    }
    logged.length = 0;
    await open('{ not json');
    assert.ok(logged.some((line) => line.includes(AGENT_OPTIONS_FILE)), 'a file that cannot be read is said in the log, by name');
    const { store } = await open('{"autoCompactPercent":70,"autoAcceptChecks":"yes","extra":1}');
    assert.deepEqual([store.current().autoCompactPercent, store.current().autoAcceptChecks], [70, false], 'what is valid in a file is kept, what is not is the default');
    const missing = await open(null);
    assert.deepEqual(plain(missing.store.current()), plain(agentOptionsView()), 'no file: the defaults');
  }
  ok('a file that cannot be used does not stop the Hub: the defaults apply, the owner can choose again, and what is valid in it is kept');

  {
    // A write that fails changes nothing, and the next one is not stuck behind it.
    const blocker = path.join(root, 'blocked');
    await fs.writeFile(blocker, 'a file, so nothing can be created below it');
    const store = new AgentOptionsStore({ directory: path.join(blocker, 'data') });
    await store.load();
    await assert.rejects(store.set({ autoCompactPercent: 60 }));
    assert.deepEqual(plain(store.current()), plain(agentOptionsView()), 'the write failed: the memory still says what the file says (nothing)');
    await fs.rm(blocker);
    const after = await store.set({ autoCompactPercent: 60 });
    assert.equal(after.autoCompactPercent, 60, 'the next change works once the folder can be written');
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(blocker, 'data', AGENT_OPTIONS_FILE), 'utf8')), { version: 1, autoCompactPercent: 60 }, 'and the data folder is created when it is missing');
  }
  ok('a write that fails changes nothing and does not block the next change');

  {
    // Changes made one after another are applied in order, so the file and the memory cannot disagree.
    const directory = await folder();
    const store = new AgentOptionsStore({ directory });
    await store.load();
    await Promise.all([
      store.set({ autoCompactPercent: 60 }), store.set({ autoCompactPercent: 70 }), store.set({ autoAcceptChecks: true }),
      store.set({ autoCompactPercent: null }), store.set({ autoCompactPercent: 90 }), store.set({ autoAcceptChecks: false }), store.set({ autoAcceptChecks: true }),
    ]);
    assert.deepEqual([store.current().autoCompactPercent, store.current().autoAcceptChecks], [90, true], 'the last change of each option wins');
    assert.deepEqual(await readFile(directory), { version: 1, autoCompactPercent: 90, autoAcceptChecks: true }, 'and the file says the same');
  }
  ok('changes made at the same time are applied in the order they were made: the file and the memory agree');

  // ---- 3. the real AgentRunner ----------------------------------------------------------------------------------------------------------------
  const tool = (name) => ({ name: `local.${name}`, originalName: name, server: 'local', inputSchema: { type: 'object' } });
  const reply = (output) => ({ status: 'completed', usage: { input_tokens: 1, output_tokens: 1 }, output });
  const finalAnswer = (text = 'Done.') => reply([{ type: 'message', role: 'assistant', phase: 'final', content: [{ type: 'output_text', text }] }]);
  let sessions = 0;
  async function session({ runnerOptions = {} } = {}) {
    sessions += 1;
    const dir = await folder();
    let locked = false;
    let id = null;
    const manager = {
      backend: 'local', secrets: [], instanceId: `agent-options-${sessions}`, generation: 1,
      state() { return { workspace: { path: dir }, generation: this.generation, instanceId: this.instanceId }; },
      acquireTask() { if (locked) return false; locked = true; return true; },
      releaseTask() { locked = false; },
      studio: { async checks() { return { suggested: [] }; } },
      async createAgentSession() {
        return {
          catalog: { tools: [tool('read_file')], prompts: [], resources: [], resourceTemplates: [], servers: {} }, async close() {},
          async callTool() { return { isError: false, content: [{ type: 'text', text: '{}' }], structuredContent: { notVerified: true } }; },
        };
      },
    };
    const provider = { ready: () => true, snapshot: () => ({ provider: 'fixture', model: 'capture' }), async respond({ beforeModelRequest }) { beforeModelRequest?.(); return finalAnswer(); } };
    const runner = (runnerOptions.make ?? ((options) => new AgentRunner(options)))({ manager, provider, taskDirectory: path.join(root, `tasks-${sessions}`), ...runnerOptions.options });
    await runner.load();
    const say = async (prompt) => {
      id = (id === null ? await runner.start({ prompt, maxSteps: 8 }) : await runner.continue({ id, prompt, maxSteps: 8 })).id;
      for (let i = 0; i < 1500 && runner.get(id).status === 'running'; i += 1) await settle(10);
      assert.equal(runner.get(id).status, 'completed', runner.get(id).error ?? '');
      for (let i = 0; i < 300 && runner.state().activeTaskId !== null; i += 1) await settle(10);
    };
    return { runner, say, task: () => runner.get(id), manager };
  }
  const summary = (view) => [view.autoCompactPercent, view.autoAcceptChecks];

  {
    const store = new AgentOptionsStore({ directory: await folder() });
    await store.load();
    const s = await session({ runnerOptions: { options: { agentOptions: store } } });
    try {
      assert.deepEqual(summary(s.runner.state().agentOptions), [80, false], 'before any run: the state says the defaults');
      await s.say('Explain the layout of this project.');
      assert.deepEqual(summary(s.task().agentOptions), [80, false], 'the task records what applied when its run began');
      assert.deepEqual(summary(s.runner.state().agentOptions), [80, false]);
      // The runner exists, with the store in its hand, when the owner changes the options: it must not have copied the answer.
      await store.set({ autoCompactPercent: 60, autoAcceptChecks: true });
      assert.deepEqual(summary(s.runner.state().agentOptions), [60, true], 'the runner state follows the change at once');
      await s.say('And the tests?');
      assert.deepEqual(summary(s.task().agentOptions), [60, true], 'the next run of the same conversation records the new options');
      await store.set({ autoCompactPercent: null, autoAcceptChecks: false });
      await s.say('One more.');
      assert.deepEqual(summary(s.task().agentOptions), [80, false], 'and back to the defaults');
      assert.equal(s.task().agentOptions.autoCompactSaved, null);
    } finally { await s.runner.shutdown(); }
  }
  ok('a runner made before the options change follows them: its state at once, its next run in the task');

  {
    // No source is the defaults; anything that is not a source is refused when the runner is made, not at the first request.
    const s = await session();
    try {
      await s.say('Hello.');
      assert.deepEqual(summary(s.runner.state().agentOptions), [80, false], 'no store: the defaults');
      assert.deepEqual(summary(s.task().agentOptions), [80, false]);
    } finally { await s.runner.shutdown(); }
    const manager = { state: () => ({}) };
    for (const bad of [{}, 'store', 5, true, { current: 5 }, { current: 'x' }, []]) {
      assert.throws(() => new AgentRunner({ manager, provider: {}, taskDirectory: root, agentOptions: bad }), TypeError, `${JSON.stringify(bad)} is not a source of options`);
    }
    // a fixed source works, and is asked again at each use
    let percent = 90;
    const live = new AgentRunner({ manager, provider: {}, taskDirectory: root, agentOptions: { current: () => agentOptionsView({ autoCompactPercent: percent }) } });
    assert.equal(live.state().agentOptions.autoCompactPercent, 90);
    percent = 55;
    assert.equal(live.state().agentOptions.autoCompactPercent, 55, 'a source is asked at each use');
  }
  ok('with no store the defaults apply; anything that is not a store is refused when the runner is made; a store is asked at each use');

  {
    // The foreground runner of the Hub is made by hub.mjs with the manager's store.
    const store = new AgentOptionsStore({ directory: await folder() });
    await store.load();
    const s = await session({ runnerOptions: { make: (options) => createPrimaryAgentRunner(AgentRunner, { ...options, manager: Object.assign(options.manager, { agentOptions: store }), log: () => {}, env: {} }) } });
    try {
      await s.say('Hello.');
      assert.deepEqual(summary(s.task().agentOptions), [80, false]);
      await store.set({ autoCompactPercent: 75 });
      await s.say('Again.');
      assert.deepEqual(summary(s.task().agentOptions), [75, false], 'the foreground runner of the Hub is handed the store of the manager');
    } finally { await s.runner.shutdown(); }
  }
  ok('createPrimaryAgentRunner hands the foreground runner the manager\'s store');

  // ---- 4. the other places a runner is made ----------------------------------------------------------------------------------------------------
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', windowsHide: true });
  const repository = async (name) => {
    const dir = path.join(root, name);
    await fs.mkdir(dir, { recursive: true });
    git(dir, 'init', '-b', 'main');
    await fs.writeFile(path.join(dir, 'README.md'), '# fixture\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-m', 'fixture');
    return dir;
  };
  const parentOf = async (project, name, source) => {
    const parent = new HubManager({ bundleRoot: hubRoot, dataDirectory: path.join(root, `${name}-hub`), backend: 'local', log: () => {} });
    await parent.load(project);
    assembleStudio(parent, { bundleRoot: hubRoot });
    await parent.permissions.load();
    parent.permissions.mode = 'autonomous';
    await parent.startLocal(project);
    parent.agentOptions = source;
    return parent;
  };
  // A source that counts how often it is asked, and answers with the store.
  const spyOn = (store) => { const asked = { count: 0 }; return { asked, current: () => { asked.count += 1; return store.current(); } }; };

  {
    // A pooled chat that runs in its own worktree is a runner of its own, kept and reused for the next message: it must ask the Hub's store each time.
    const project = await repository('pool-project');
    const store = new AgentOptionsStore({ directory: await folder() });
    await store.load();
    const spy = spyOn(store);
    const hub = await parentOf(project, 'pool', spy);
    let holdFirst = null;
    const provider = {
      ready: () => true, snapshot: () => ({ provider: 'fake', model: 'mock' }),
      async respond({ input }) {
        const chat = JSON.stringify(input).includes('Chat ONE') ? 'one' : 'two';
        if (chat === 'one' && holdFirst) await holdFirst;
        return finalAnswer(`Answered ${chat}.`);
      },
    };
    const primary = new AgentRunner({ manager: hub, provider, taskDirectory: path.join(root, 'pool-hub', 'api-tasks'), log: () => {}, agentOptions: spy });
    await primary.load();
    const pool = new ConcurrentApiAgent({ primary, manager: hub, provider, bundleRoot: hubRoot, directory: path.join(root, 'pool-hub', 'api-conversations'), log: () => {} });
    try {
      let release;
      holdFirst = new Promise((resolve) => { release = resolve; });
      const one = await pool.start({ prompt: 'Chat ONE: inspect README' });
      await until(() => primary.get(one.id)?.status === 'running' || pool.get(one.id)?.status === 'running', 'the foreground chat to start');
      // The checkout is busy, so this chat gets a worktree and a runner of its own.
      const two = await pool.start({ prompt: 'Chat TWO: inspect README as an independent chat' });
      await until(() => pool.get(two.id)?.status === 'completed', 'the pooled chat to finish its first run');
      const child = pool.get(two.id);
      assert.ok(child.worktree && child.worktree !== project, 'the second chat runs in a worktree of its own');
      assert.deepEqual(summary(child.agentOptions), [80, false], 'on the defaults: the pooled chat\'s task says so');
      release();
      await until(() => pool.get(one.id)?.status === 'completed', 'the foreground chat to finish');

      await store.set({ autoCompactPercent: 65, autoAcceptChecks: true });
      await pool.continue({ id: two.id, prompt: 'Look again.' });
      await until(() => pool.get(two.id)?.agentOptions?.autoCompactPercent === 65 && pool.get(two.id)?.status === 'completed', 'the pooled chat to run again with the new options');
      assert.deepEqual(summary(pool.get(two.id).agentOptions), [65, true], 'the same pooled runner, run again, follows the change');
      await store.set({ autoCompactPercent: null, autoAcceptChecks: false });
      await pool.continue({ id: two.id, prompt: 'Once more.' });
      await until(() => pool.get(two.id)?.agentOptions?.autoCompactPercent === 80 && pool.get(two.id)?.status === 'completed', 'the pooled chat to run a third time');
      assert.deepEqual(summary(pool.get(two.id).agentOptions), [80, false], 'and back to the defaults');
      assert.ok(spy.asked.count > 0, 'the manager\'s store was the one asked');
    } finally { await pool.shutdown?.().catch(() => {}); await primary.shutdown(); await hub.shutdown(); }
  }
  ok('a pooled chat in its own worktree asks the Hub\'s store at each run, so a runner that already exists follows a change');

  {
    // A coding worker is a runner in a worktree made by the orchestrator; it asks the manager's store, or it would run on the defaults whatever the owner chose.
    const project = await repository('coding-project');
    const store = new AgentOptionsStore({ directory: await folder() });
    await store.load();
    await store.set({ autoCompactPercent: 55, autoAcceptChecks: true });
    const spy = spyOn(store);
    const hub = await parentOf(project, 'coding', spy);
    const provider = { ready: () => true, snapshot: () => ({ provider: 'fake', model: 'mock' }), async respond() { return finalAnswer('Inspected.'); } };
    const orchestrator = new CodingWorktreeOrchestrator({ manager: hub, provider, bundleRoot: hubRoot, directory: path.join(root, 'coding-agents') });
    try {
      const before = spy.asked.count;
      const job = await orchestrator.run({ tasks: [{ id: 'first', prompt: 'Inspect the README.' }], confirmation: 'CREATE WORKTREES', maxConcurrency: 1 });
      assert.equal(job.status, 'ready_for_review', JSON.stringify(job).slice(0, 300));
      assert.ok(spy.asked.count > before, 'the worker\'s runner asked the Hub\'s store (a build that forgets to hand it over runs on the defaults and never asks)');
    } finally { await hub.shutdown(); }
  }
  ok('a coding worker is handed the Hub\'s store');

  console.log(`PASS: ${checks} groups of checks - the owner's agent options: the view, the store, the runner, the Hub's factory, a pooled chat and a coding worker`);
} finally {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
