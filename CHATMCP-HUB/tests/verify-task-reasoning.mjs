// The thinking effort of ONE task. The setting lives on the connection (the global one, or a model profile); a task may carry its own, which wins for that task and only for it:
//   1. The provider: respond({ reasoningEffort }) takes the task's setting over the connection's. Nothing named means the connection's; 'auto' means send nothing, whatever the
//      connection says; a word that is not a level is not obeyed and not an error in the middle of a run. The connection itself is not changed.
//   2. The runner (the real AgentRunner -> GatewayProvider -> the request body, only the network replaced): start({ reasoningEffort }) stores it on the task, every model request of
//      the run carries it, a word that is not a level is refused before the task exists, a follow-up keeps it, a follow-up may change it, and it survives a restart.
//   3. What the task shows: reasoningEffort is in the task as the owner chose it (null when the task follows its connection).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentRunner } from '../lib/agent.mjs';
import { createPrimaryAgentRunner } from '../hub.mjs';
import { GatewayProvider } from '../lib/gateway-provider.mjs';
import { LocalTools } from '../lib/local-tools.mjs';

const BUNDLE = path.resolve(import.meta.dirname, '..');
const base = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-task-reasoning-'));
let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
const KEY = 'sk-task-reasoning-key-0123456789';
let numbered = 0;

const chatAnswer = (text = 'Nothing to change.') => ({ ok: true, status: 200, headers: { get: () => null }, async text() {
  return JSON.stringify({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } });
} });
/** A connection to OpenAI Chat Completions whose network is a list: what was sent is in `requests`. */
async function connection({ reasoningEffort } = {}) {
  numbered += 1;
  const requests = [];
  const gateway = new GatewayProvider({ directory: path.join(base, `gateway-${numbered}`), bundleRoot: BUNDLE, manager: { secrets: [] }, env: {}, platform: 'linux', sleep: async () => {},
    fetchImpl: async (url, init) => { requests.push(JSON.parse(init.body)); return chatAnswer(); } });
  await gateway.load();
  await gateway.configure({ preset: 'openai', model: 'gpt-5.6-terra', apiKey: KEY, ...(reasoningEffort ? { reasoningEffort } : {}) });
  return { gateway, requests };
}
const HI = () => [{ role: 'user', content: [{ type: 'input_text', text: 'Hi' }] }];
const ask = (gateway, extra = {}) => gateway.respond({ input: HI(), instructions: 'Be brief.', tools: [], maxOutputTokens: 1024, signal: AbortSignal.timeout(8000), ...extra });
const effortOf = (body) => body.reasoning_effort;

try {
  // --------------------------------------------------------------------------------------------------------------------------- 1. the provider
  {
    const { gateway, requests } = await connection({ reasoningEffort: 'low' });
    await ask(gateway);
    assert.equal(effortOf(requests.at(-1)), 'low', '(premise) the connection\'s own setting is sent');
    await ask(gateway, { reasoningEffort: 'high' });
    assert.equal(effortOf(requests.at(-1)), 'high', 'the setting of the task wins');
    await ask(gateway, { reasoningEffort: 'auto' });
    assert.equal(effortOf(requests.at(-1)), undefined, 'auto sends nothing, whatever the connection says');
    await ask(gateway, { reasoningEffort: undefined });
    assert.equal(effortOf(requests.at(-1)), 'low', 'nothing named: the connection\'s');
    await ask(gateway, { reasoningEffort: null });
    assert.equal(effortOf(requests.at(-1)), 'low', 'null is nothing named too');
    await ask(gateway, { reasoningEffort: 'extreme' });
    assert.equal(effortOf(requests.at(-1)), 'low', 'a word that is not a level is not obeyed, and does not stop the run');
    await ask(gateway, { reasoningEffort: ' HIGH ' });
    assert.equal(effortOf(requests.at(-1)), 'high', 'the word is read as the setting reads it');
    assert.equal(gateway.state().reasoningEffort, 'low', 'the connection is not changed');
    const plain = await connection();
    await ask(plain.gateway, { reasoningEffort: 'medium' });
    assert.equal(effortOf(plain.requests.at(-1)), 'medium', 'a connection on auto can be asked for a level by one task');
    await ask(plain.gateway);
    assert.equal(effortOf(plain.requests.at(-1)), undefined, 'and the next task is back on auto');
    // a level the model does not list is not sent (the decision is the catalog's), whoever asks
    await ask(plain.gateway, { reasoningEffort: 'minimal' });
    assert.equal(effortOf(plain.requests.at(-1)), undefined, 'GPT-5.6 Terra has no minimal level: nothing is sent');
    ok('provider: the setting of a task wins over the connection\'s, auto sends nothing, nothing named follows the connection, a word that is not a level is ignored, and the connection is left as it was');
  }
  {
    // a refusal is about a (model, level) pair: the level one task asked for does not decide what another asks
    numbered += 1;
    const requests = [];
    const gateway = new GatewayProvider({ directory: path.join(base, `gateway-${numbered}`), bundleRoot: BUNDLE, manager: { secrets: [] }, env: {}, platform: 'linux', sleep: async () => {},
      fetchImpl: async (url, init) => {
        const body = JSON.parse(init.body);
        requests.push(body);
        if (body.reasoning_effort === 'high') {
          return { ok: false, status: 400, headers: { get: () => null }, async text() { return JSON.stringify({ error: { message: "Unsupported parameter: 'reasoning_effort' is not supported with this model.", type: 'invalid_request_error', param: 'reasoning_effort' } }); } };
        }
        return chatAnswer();
      } });
    await gateway.load();
    await gateway.configure({ preset: 'openai', model: 'gpt-5.6-terra', apiKey: KEY });
    await ask(gateway, { reasoningEffort: 'high' });
    assert.deepEqual(requests.map(effortOf), ['high', undefined], 'refused, then repeated once without it');
    await ask(gateway, { reasoningEffort: 'high' });
    assert.deepEqual(requests.slice(2).map(effortOf), [undefined], 'remembered: the next task that asks for high is not refused again');
    await ask(gateway, { reasoningEffort: 'low' });
    assert.deepEqual(requests.slice(3).map(effortOf), ['low'], 'another level is another question');
    ok('provider: a refusal of the level one task asked for is remembered for that level and does not hold back another');
  }

  // --------------------------------------------------------------------------------------------------------------------------- 2. the runner
  const catalogTools = new LocalTools({ workspace: { async resolve() { throw new Error('not called'); } }, shell: {}, git: {} }).definitions();
  let taskNumber = 0;
  async function runner({ reasoningEffort } = {}) {
    taskNumber += 1;
    const { gateway, requests } = await connection({ reasoningEffort });
    let locked = false;
    const root = path.join(base, `workspace-${taskNumber}`);
    await fs.mkdir(root, { recursive: true });
    const manager = { secrets: [], workspace: root, generation: 1, instanceId: 'task-reasoning', studio: { checks: async () => ({ suggested: [] }) },
      state() { return { workspace: { path: root }, generation: 1, instanceId: 'task-reasoning', services: {} }; },
      acquireTask() { if (locked) return false; locked = true; return true; }, releaseTask() { locked = false; },
      async createAgentSession() { return { catalog: { tools: catalogTools, prompts: [], resources: [], resourceTemplates: [], servers: {} }, async close() {}, async callTool() { throw new Error('no tool is called'); } }; } };
    const directory = path.join(base, `tasks-${taskNumber}`);
    const make = () => createPrimaryAgentRunner(AgentRunner, { manager, provider: gateway, taskDirectory: directory, log: () => {}, env: {} });
    const instance = make();
    await instance.load();
    const finish = async (active) => { await Promise.race([active.context.done.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('task timed out')), 20000))]); };
    return { instance, requests, make, finish };
  }
  {
    const { instance, requests, finish } = await runner({ reasoningEffort: 'low' });
    const { id } = await instance.start({ prompt: 'Say hello.', maxSteps: 3, maxMinutes: 1, reasoningEffort: 'high' });
    await finish(instance);
    assert.ok(requests.length >= 1 && requests.every((body) => effortOf(body) === 'high'), 'every model request of the run carries the setting of the task');
    assert.equal(instance.get(id).reasoningEffort, 'high', 'the task shows it');
    const before = requests.length;
    await instance.continue({ id, prompt: 'And again.', maxSteps: 3, maxMinutes: 1 });
    await finish(instance);
    assert.ok(requests.length > before && requests.slice(before).every((body) => effortOf(body) === 'high'), 'a follow-up keeps it');
    const second = requests.length;
    await instance.continue({ id, prompt: 'Think less.', maxSteps: 3, maxMinutes: 1, reasoningEffort: 'auto' });
    await finish(instance);
    assert.ok(requests.length > second && requests.slice(second).every((body) => effortOf(body) === undefined), 'a follow-up may change it (auto: nothing sent)');
    assert.equal(instance.get(id).reasoningEffort, 'auto');
    await instance.shutdown();
    ok('runner: every request of a run carries the setting of the task, a follow-up keeps it or changes it, and the task shows it');
  }
  {
    const { instance, requests, make, finish } = await runner({ reasoningEffort: 'low' });
    const followed = await instance.start({ prompt: 'Say hello.', maxSteps: 3, maxMinutes: 1 });
    await finish(instance);
    assert.ok(requests.every((body) => effortOf(body) === 'low'), 'a task that names none follows its connection');
    assert.equal(instance.get(followed.id).reasoningEffort, null, 'and shows none');
    await assert.rejects(() => instance.start({ prompt: 'Say hello.', reasoningEffort: 'extreme' }), (error) => error.code === 'invalid_reasoning_effort' && error.statusCode === 400 && /auto|low|high/.test(error.message));
    assert.equal(instance.state().activeTaskId, null, 'a refused setting starts nothing');
    const { id } = await instance.start({ prompt: 'Think hard.', maxSteps: 3, maxMinutes: 1, reasoningEffort: 'medium' });
    await finish(instance);
    await instance.shutdown();
    // a restart: the task is read from disk with the setting it had
    const again = make();
    await again.load();
    assert.equal(again.get(id).reasoningEffort, 'medium', 'it survives a restart');
    assert.equal(again.get(followed.id).reasoningEffort, null);
    await again.shutdown();
    ok('runner: a task that names none follows its connection, a word that is not a level starts nothing, and the setting survives a restart');
  }
} finally {
  await fs.rm(base, { recursive: true, force: true });
}

console.log(`\nPASS: ${checks} task reasoning checks`);
