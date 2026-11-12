// The task events of the Hub, from the two engines to the two stream routes, in one process.
//
// The task surface of a Hub is a DualAgent: the Model API engine and the ChatGPT Web engine (BrowserRunner) behind one object. `GET /api/tasks/events` and
// `GET /api/tasks/<id>/stream` (hub.mjs) subscribe to that object. This suite uses the real engines (an AgentRunner with a scripted provider, a BrowserRunner driven the way the
// extension drives it), the real DualAgent and the real HTTP server (createHubServer), and looks at:
//   1. DualAgent.subscribe on its own: it forwards both engines, says which one an event came from (`transport`), changes no other field, gives ONE function that removes both
//      listeners, works when an engine has no `subscribe`, and a listener that throws reaches neither the engine nor the other listeners;
//   2. the ChatGPT Web engine: every entry it adds to a task's record is announced, in order, exactly as `get()` returns it (masked alike), with the task's status;
//   3. both engines through the DualAgent: in order, each with its transport, and nothing after dispose;
//   4. the two routes: every task on /api/tasks/events in the order of emission, one task on /api/tasks/<id>/stream, and a closed connection takes its listener away
//      (counted on both engines, before, during and after 50 connections).
// That a real Hub process wires all this together is tests/verify-e2e-task-streams.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { AgentRunner } from '../lib/agent.mjs';
import { DualAgent } from '../lib/dual-agent.mjs';
import { HookRunner } from '../lib/hooks.mjs';
import { createHubServer } from '../hub.mjs';
import { makeFlow, textResult } from './fixtures/companion-flow.mjs';
import { openTaskEventStream } from './support/task-event-stream.mjs';

let checks = 0;
const check = (condition, label, detail = '') => { assert.ok(condition, `${label}${detail ? `: ${detail}` : ''}`); checks += 1; };
const same = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks += 1; };
// As JSON, which is what a stream carries: the API engine's cleaned objects have no prototype, a copy of them has one.
const plain = (value) => JSON.parse(JSON.stringify(value));
const until = async (test, label, ms = 10_000) => {
  const deadline = Date.now() + ms;
  while (!test()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-task-event-streams-'));
const closers = [];

// ---- 1. DualAgent.subscribe on its own ---------------------------------------------------------------------------------------------------------------
// An engine as plain as it can be: a set of listeners and an emit that does NOT protect itself, so a listener's exception that got past the DualAgent would show here.
const plainEngine = () => {
  const listeners = new Set();
  return { listeners, subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; }, emit(event) { for (const listener of [...listeners]) listener(event); } };
};
const dualOf = (browser, api) => new DualAgent({ browser, api, directory: root, defaultMode: 'api' });
{
  const api = plainEngine(), browser = plainEngine();
  const dual = dualOf(browser, api);
  const seen = [];
  const dispose = dual.subscribe((event) => seen.push(event));
  check(typeof dispose === 'function', 'subscribe returns a function');
  same([api.listeners.size, browser.listeners.size], [1, 1], 'one listener on each engine');
  const fromApi = Object.freeze({ type: 'state', taskId: 'a', state: 'running', reason: 'start', stateChangedAt: 't0' });
  const fromWeb = Object.freeze({ type: 'event', taskId: 'w', event: Object.freeze({ at: 't1', type: 'queued', message: 'm' }), status: 'queued' });
  api.emit(fromApi);
  browser.emit(fromWeb);
  api.emit(Object.freeze({ type: 'token', taskId: 'a', token: 'Xin ' }));
  same(seen, [{ ...fromApi, transport: 'api' }, { ...fromWeb, transport: 'chatgpt-web' }, { type: 'token', taskId: 'a', token: 'Xin ', transport: 'api' }],
    'the events of both engines arrive in the order they were sent, each with its transport and every field it had');
  check(!('transport' in fromApi) && !('transport' in fromWeb), 'the engine\'s own event object is not changed (it was frozen: a write would have thrown)');
  dispose();
  same([api.listeners.size, browser.listeners.size], [0, 0], 'the one dispose function removes the listener of each engine');
  api.emit({ type: 'token', taskId: 'a', token: 'late' });
  browser.emit({ type: 'event', taskId: 'w', event: {}, status: 'completed' });
  same(seen.length, 3, 'a disposed subscriber gets nothing more');
  dispose();
  same([api.listeners.size, browser.listeners.size], [0, 0], 'disposing twice is harmless');

  // Two subscribers: one is disposed, the other goes on.
  const first = [], second = [];
  const disposeFirst = dual.subscribe((event) => first.push(event.taskId));
  const disposeSecond = dual.subscribe((event) => second.push(event.taskId));
  api.emit({ type: 'token', taskId: '1', token: 'x' });
  disposeFirst();
  browser.emit({ type: 'event', taskId: '2', event: {}, status: 'queued' });
  same([first, second], [['1'], ['1', '2']], 'disposing one subscriber leaves the other');
  disposeSecond();

  // A listener that throws: the engine (which does not protect itself here) is not reached, nor is the next listener.
  const after = [];
  const disposeBad = dual.subscribe(() => { throw new Error('a watcher broke'); });
  const disposeGood = dual.subscribe((event) => after.push(event.taskId));
  assert.doesNotThrow(() => api.emit({ type: 'token', taskId: '3', token: 'x' }), 'the api engine is not reached by a listener\'s exception'); checks += 1;
  assert.doesNotThrow(() => browser.emit({ type: 'event', taskId: '4', event: {}, status: 'queued' }), 'nor is the web engine'); checks += 1;
  same(after, ['3', '4'], 'and the other listener still gets every event');
  disposeBad(); disposeGood();

  // What is not a function is not registered.
  for (const bad of [undefined, null, 'listener', {}]) {
    const nothing = dual.subscribe(bad);
    check(typeof nothing === 'function' && api.listeners.size === 0 && browser.listeners.size === 0, `subscribe(${JSON.stringify(bad) ?? 'undefined'}) registers nothing and still returns a function`);
    nothing();
  }
  console.log('PASS DualAgent.subscribe: both engines, transport, one dispose, a throwing listener, a non-function');
}
{
  // An engine without subscribe (an older runner, a stand-in of a test): the other one is still forwarded.
  const api = plainEngine(), browser = plainEngine();
  const seen = [];
  const noWeb = dualOf({}, api);
  const disposeNoWeb = noWeb.subscribe((event) => seen.push(event));
  api.emit({ type: 'token', taskId: 'a', token: '1' });
  const noApi = dualOf(browser, {});
  const disposeNoApi = noApi.subscribe((event) => seen.push(event));
  browser.emit({ type: 'event', taskId: 'w', event: {}, status: 'queued' });
  same(seen.map((event) => event.transport), ['api', 'chatgpt-web'], 'an engine without subscribe is passed over, the other is forwarded');
  disposeNoWeb(); disposeNoApi();
  same([api.listeners.size, browser.listeners.size], [0, 0], 'and dispose still removes what was registered');
  const neither = dualOf({}, {}).subscribe(() => {});
  check(typeof neither === 'function', 'no engine can be watched: still a function'); neither();
  console.log('PASS DualAgent.subscribe: an engine without subscribe');
}

// ---- the real engines ---------------------------------------------------------------------------------------------------------------------------------
const REGISTERED = 'registered-secret-7d1c0b9e';
const FILE = 'desktop-commander.read_file';
const flow = await makeFlow({ tools: { [FILE]: ({ path: file }) => textResult(`contents of ${file}`) }, registeredSecrets: [REGISTERED] });
closers.push(() => flow.close());
const web = flow.runner;

/** One ChatGPT Web task from the request to the final answer, with one tool call whose arguments hold a registered secret. */
async function webTask(prompt) {
  const task = await flow.start({ prompt });
  let message = await flow.deliver();
  await flow.reply(message, { kind: 'tool', name: FILE, arguments: { path: `notes/${REGISTERED}.txt` }, progress: 'Reading the notes.' });
  message = await flow.deliver();
  await flow.reply(message, { kind: 'final', text: 'The notes say nothing new.' });
  await web.settle();
  return task.id;
}

const work = path.join(root, 'work');
await fs.mkdir(work, { recursive: true });
const apiLog = [];
const apiManager = {
  secrets: [], generation: 1, instanceId: 'task-event-streams', locked: false, workspace: work, hooks: new HookRunner({ hubDirectory: path.join(root, 'hub'), log: () => {} }), hooksProjectRoot: null, lifecycleAgent: null,
  permissions: { mode: 'review', executionPolicy: 'host-review' }, pluginManager: null,
  state() { return { workspace: { path: work }, generation: 1, instanceId: this.instanceId }; },
  acquireTask() { if (this.locked) return false; this.locked = true; return true; },
  releaseTask() { this.locked = false; },
  async createAgentSession() {
    return { catalog: { tools: [{ name: 'desktop-commander.list_directory', server: 'desktop-commander', inputSchema: { type: 'object' } }], prompts: [], resources: [], resourceTemplates: [], servers: {} }, async close() {}, async callTool() { return textResult('[FILE] README.md'); } };
  },
};
const provider = {
  ready: () => true, snapshot: () => ({ provider: 'fixture', model: 'fixture' }),
  async respond(request) {
    await request.onToken('The project ');
    await request.onToken('is a calculator.');
    return { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 }, output: [{ type: 'message', role: 'assistant', phase: 'final', content: [{ type: 'output_text', text: 'The project is a calculator.' }] }] };
  },
};
const api = new AgentRunner({ manager: apiManager, provider, taskDirectory: path.join(root, 'api-tasks'), toolSelectionMode: 'auto', log: (line) => apiLog.push(String(line)) });
await api.load();
/** One Model API task to its end. */
async function apiTask(prompt) {
  const started = await api.start({ prompt });
  const done = await Promise.race([api.context.done.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('the API task did not end within 60 s')), 60_000).unref())]);
  assert.equal(done.status, 'completed', done.error);
  return started.id;
}

try {
  // ---- 2. the ChatGPT Web engine announces what it records -----------------------------------------------------------------------------------------
  {
    check(typeof web.subscribe === 'function', 'the ChatGPT Web engine can be watched');
    const seen = [], other = [];
    const dispose = web.subscribe((event) => seen.push(structuredClone(event)));
    const disposeBad = web.subscribe(() => { throw new Error('a watcher broke'); });
    const disposeOther = web.subscribe((event) => other.push(event));
    const id = await webTask('Read the notes.');
    const record = web.get(id);
    same(record.status, 'completed', 'the web task completed although one of its watchers throws at every event');
    check(record.events.length >= 8, 'its record has the events of a start, two deliveries, a tool call and the end', String(record.events.length));
    same(seen.map((event) => event.event), record.events, 'every entry of the record was announced, in order, exactly as get() returns it');
    check(seen.every((event) => event.type === 'event' && event.taskId === id && Object.keys(event).sort().join() === 'event,status,taskId,type'), 'each announcement is {type: "event", taskId, event, status}');
    same(seen.at(-1).status, 'completed', 'the last one says the status the task rests in');
    same(seen.map((event) => event.event.type).filter((type) => ['tool_start', 'tool_result', 'progress', 'completed'].includes(type)), ['progress', 'tool_start', 'tool_result', 'completed'], 'the tool call and the end are among them, in that order');
    const start = seen.find((event) => event.event.type === 'tool_start');
    check(start.event.message.includes('notes/') && !JSON.stringify(seen).includes(REGISTERED) && !JSON.stringify(record).includes(REGISTERED), 'a registered secret in the arguments of a tool call is masked in the announcement as it is in the record', start.event.message.slice(0, 160));
    same(other.length, seen.length, 'the listener after the one that throws got every event');
    // What a watcher is handed is a copy: writing to it does not rewrite the record.
    other[0].event.message = 'rewritten by a watcher';
    same(web.get(id).events[0].message, seen[0].event.message, 'a watcher that writes to the entry it was handed does not change the record');
    dispose(); disposeBad(); disposeOther();
    same(web.listeners.size, 0, 'dispose removes the listeners');
    const before = seen.length;
    await webTask('Read the notes again.');
    same(seen.length, before, 'a disposed subscriber gets nothing of the next task');
    check(typeof web.subscribe('nothing') === 'function' && web.listeners.size === 0, 'what is not a function is not registered');
    console.log('PASS the ChatGPT Web engine announces every entry of a task\'s record, masked as the record is');
  }

  // ---- 3. both real engines through the DualAgent ------------------------------------------------------------------------------------------------
  const dual = dualOf(web, api);
  {
    const seen = [];
    const dispose = dual.subscribe((event) => seen.push(event));
    const disposeBad = dual.subscribe(() => { throw new Error('a watcher broke'); });
    const apiId = await apiTask('What does this project do?');
    const webId = await webTask('Read the notes a third time.');
    const fromApi = seen.filter((event) => event.taskId === apiId), fromWeb = seen.filter((event) => event.taskId === webId);
    same(seen.length, fromApi.length + fromWeb.length, 'every event belongs to one of the two tasks');
    check(fromApi.length > 0 && fromApi.every((event) => event.transport === 'api'), 'the events of the API task say transport "api"');
    check(fromWeb.length > 0 && fromWeb.every((event) => event.transport === 'chatgpt-web'), 'the events of the web task say transport "chatgpt-web"');
    same(plain(fromApi.filter((event) => event.type === 'event').map((event) => event.event)), plain(api.get(apiId).events), 'the API task: the entries of its record, in order');
    same(fromApi.filter((event) => event.type === 'token').map((event) => event.token), ['The project ', 'is a calculator.'], 'and the pieces of its answer, in order');
    same(fromApi.filter((event) => event.type === 'state').at(-1)?.state, 'completed', 'and its state changes, the last one "completed"');
    same(fromWeb.map((event) => event.event), web.get(webId).events, 'the web task: the entries of its record, in order');
    same(dual.get(apiId).transport, 'api', 'the transport of an event is the one the task route says');
    same(dual.get(webId).transport, 'chatgpt-web', 'for the web task too');
    check(!apiLog.some((line) => /Listener error/.test(line)), 'the exception of a watcher did not reach the API engine', apiLog.join(' | ').slice(0, 200));
    dispose(); disposeBad();
    same([api.listeners.size, web.listeners.size], [0, 0], 'dispose leaves no listener on either engine');
    const before = seen.length;
    await apiTask('And once more?');
    same(seen.length, before, 'a disposed subscriber gets nothing more');
    console.log('PASS both real engines through DualAgent.subscribe');
  }

  // ---- 4. the two routes -----------------------------------------------------------------------------------------------------------------------------
  {
    const port = await new Promise((resolve) => { const probe = net.createServer(); probe.listen(0, '127.0.0.1', () => { const { port: free } = probe.address(); probe.close(() => resolve(free)); }); });
    const origin = `http://127.0.0.1:${port}`;
    const secret = 'task-event-streams-secret-0123456789abcdef';
    const headers = { authorization: `Bearer ${secret}` };
    const manager = { secrets: [], log: () => {}, catalog: { ready: true, tools: [] }, state: () => ({ version: 'test', workspace: { path: work }, generation: 1, instanceId: 'mock', busy: false, services: {} }) };
    const server = createHubServer(manager, { port, secret, browser: web, agent: dual });
    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
    closers.push(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
    const counts = () => [api.listeners.size, web.listeners.size];
    const base = counts();
    same(base, [0, 0], 'no listener before a connection');

    // A task of each engine that exists before the streams open (the task stream needs its task).
    const oldApi = await apiTask('First question.');
    const oldWeb = await webTask('First web request.');

    const all = await openTaskEventStream(origin, '/api/tasks/events', { headers });
    const oneApi = await openTaskEventStream(origin, `/api/tasks/${oldApi}/stream`, { headers });
    const oneWeb = await openTaskEventStream(origin, `/api/tasks/${oldWeb}/stream`, { headers });
    same([all.status, oneApi.status, oneWeb.status], [200, 200, 200], 'the three streams open');
    same(counts(), [3, 3], 'each open stream holds one listener on each engine');
    await until(() => oneApi.events.length === 1 && oneWeb.events.length === 1, 'the snapshots');
    same([oneApi.events[0].type, oneApi.events[0].task.id, oneWeb.events[0].type, oneWeb.events[0].task.id], ['task_snapshot', oldApi, 'task_snapshot', oldWeb], 'a task stream starts with the snapshot of its task');
    same(all.events.length, 0, 'the stream of every task sends nothing while no task does anything');

    // What a listener in the process sees is the reference for what the streams must carry.
    const reference = [];
    const disposeReference = dual.subscribe((event) => reference.push(plain(event)));
    const newApi = await apiTask('Second question.');
    const newWeb = await webTask('Second web request.');
    await api.continue({ id: oldApi, prompt: 'A follow-up.' });
    await Promise.race([api.context.done.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('the continued API task did not end within 60 s')), 60_000).unref())]);
    disposeReference();
    const total = reference.length;
    check(new Set(reference.map((event) => event.taskId)).size === 3 && reference.some((event) => event.taskId === oldApi) && reference.some((event) => event.taskId === newApi) && reference.some((event) => event.taskId === newWeb), 'three tasks did something meanwhile: a new one of each engine, and the old API task went on');
    await until(() => all.events.length >= total, 'the events on /api/tasks/events');
    same(all.events, reference, '/api/tasks/events carries every event of every task, in the order they were sent');
    const ofOldApi = reference.filter((event) => event.taskId === oldApi);
    await until(() => oneApi.events.length >= 1 + ofOldApi.length, 'the events on the stream of the old API task');
    same(oneApi.events.slice(1), ofOldApi, 'the stream of one task carries the events of that task, in order');
    check(ofOldApi.length > 0 && ofOldApi.length < total, 'which are some of the events, not all', `${ofOldApi.length} of ${total}`);
    same(oneWeb.events.length, 1, 'and the stream of a task that did nothing carries nothing after its snapshot');

    // A stream of a task nobody knows, and one without the bearer.
    same((await openTaskEventStream(origin, '/api/tasks/00000000-0000-4000-8000-000000000000/stream', { headers })).status, 404, 'the stream of an unknown task: 404');
    same((await openTaskEventStream(origin, '/api/tasks/events')).status, 401, '/api/tasks/events without the bearer: 401');
    same((await openTaskEventStream(origin, `/api/tasks/${oldApi}/stream`)).status, 401, '/api/tasks/<id>/stream without the bearer: 401');
    same(counts(), [3, 3], 'a refused request registers nothing');

    await Promise.all([all.close(), oneApi.close(), oneWeb.close()]);
    await until(() => counts().join() === '0,0', 'the listeners of the three closed streams to go away');
    same(counts(), [0, 0], 'a closed stream takes its listener off both engines');

    // 50 connections, half of each route: counted while open and after they closed.
    const many = [];
    for (let index = 0; index < 50; index += 1) many.push(await openTaskEventStream(origin, index % 2 ? `/api/tasks/${oldWeb}/stream` : '/api/tasks/events', { headers }));
    check(many.every((stream) => stream.status === 200), '50 streams open');
    same(counts(), [50, 50], '50 open streams hold 50 listeners on each engine');
    await Promise.all(many.map((stream) => stream.close()));
    await until(() => counts().join() === '0,0', 'the listeners of 50 closed streams to go away');
    same(counts(), base, 'after 50 connections closed, as many listeners as before them');
    const afterClose = await apiTask('A question nobody watches.');
    same(api.get(afterClose).status, 'completed', 'a task runs to its end after every watcher went away');
    console.log('PASS the two routes: order, one task per task stream, 404 and 401, no listener left by 50 connections');
  }
  console.log(`PASS verify-task-event-streams: ${checks} checks`);
} finally {
  for (const close of closers.reverse()) await close().catch(() => {});
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
}
