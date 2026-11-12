import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { bundleTsx } from './support/bundle.mjs';

// What the page does with the events the Hub's streams now carry. The events below have the shape the Hub sends (pinned on the Hub's side by tests/verify-task-event-streams.mjs
// and tests/verify-e2e-task-streams.mjs): every one carries `transport`; the Model API engine sends `state`, `event` (with the canonical `state`), `token` and `token_reset`; the
// ChatGPT Web engine sends `event` with the `status` of its task and no `state`. They go through the page's own handler (src/lib/task-stream.ts) into the page's own store, the
// way useTaskStream wires them, so what is asserted is what the conversation would show (`streamingToken`, for the task on screen) and what it would fetch again.
const scratch = [];
after(() => { for (const dispose of scratch) dispose(); for (const name of ['window', 'localStorage', 'document']) delete globalThis[name]; });

async function page() {
  globalThis.window = { matchMedia: () => ({ matches: false }) };
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.document = { documentElement: { lang: 'vi', setAttribute() {} } };
  const { loaded, dispose } = await bundleTsx("export { useAppStore } from './src/store/useAppStore';\nexport { handleTaskStreamEvent } from './src/lib/task-stream';", 'chatmcp-stream-events-');
  scratch.push(dispose);
  const store = loaded.useAppStore;
  const refreshed = [];
  const feed = (event) => loaded.handleTaskStreamEvent(JSON.parse(JSON.stringify(event)), {
    selectedTaskId: () => store.getState().selectedTaskId,
    append: (id, token) => store.getState().appendTaskToken(id, token),
    clear: () => store.getState().clearStreamingToken(),
    refresh: (id) => refreshed.push(id),
  });
  return { store, feed, refreshed, shown: () => store.getState().streamingToken };
}

const API = 'a1111111-1111-4111-8111-111111111111';
const OTHER = 'b2222222-2222-4222-8222-222222222222';
const WEB = 'c3333333-3333-4333-8333-333333333333';
const entry = (type, state, extra = {}) => ({ type: 'event', taskId: API, event: { at: '2026-11-11T10:00:00.000Z', type, message: type, state, ...extra }, state, transport: 'api' });
const token = (text, taskId = API) => ({ type: 'token', taskId, token: text, transport: 'api' });
const state = (to) => ({ type: 'state', taskId: API, state: to, reason: 'test', stateChangedAt: '2026-11-11T10:00:00.000Z', transport: 'api' });

test('a Model API task as the Hub streams it: the answer is shown once while it arrives and handed over to the record at each recorded turn', async () => {
  const { store, feed, refreshed, shown } = await page();
  store.getState().setSelectedTaskId(API);

  feed(state('queued'));
  feed(state('planning'));
  feed(entry('model', 'running', { status: 'running' }));
  assert.equal(shown(), '', 'nothing is shown before the first piece');
  feed(token('I will read '));
  feed(token('calc.js.'));
  assert.equal(shown(), 'I will read calc.js.', 'the pieces add up, each one once');
  // The text of the turn is now in the record: the pieces go, the record is fetched again.
  feed(entry('assistant', 'running'));
  assert.equal(shown(), '', 'the recorded text replaces the pieces: it is not shown twice');
  feed(entry('tool_start', 'running', { toolName: 'read_file', status: 'running', callId: 'call-1' }));
  feed(entry('tool_result', 'running', { toolName: 'read_file', status: 'ok', callId: 'call-1' }));
  feed(entry('model', 'running', { status: 'running' }));
  feed(token('The add '));
  // A piece of another task must not appear in this conversation.
  feed(token('text of another conversation', OTHER));
  feed(token('function subtracts.'));
  assert.equal(shown(), 'The add function subtracts.', 'the second answer starts from nothing and holds no piece of another task');
  feed(entry('assistant', 'running'));
  feed(entry('completed', 'completed'));
  feed(state('completed'));
  assert.equal(shown(), '', 'at rest no partial text is left');
  assert.equal(store.getState().streamingTaskId, '', 'and it belongs to no task');
  assert.deepEqual(refreshed, Array(10).fill(API), 'every state change and every recorded entry asks for the task again; a piece of text never does');
});

test('a stream that was replaced: the text shown is taken back and the answer starts again', async () => {
  const { store, feed, shown } = await page();
  store.getState().setSelectedTaskId(API);
  feed(token('The proj'));
  feed({ type: 'token_reset', taskId: API, transport: 'api' });
  assert.equal(shown(), '');
  feed(token('The project is a calculator.'));
  assert.equal(shown(), 'The project is a calculator.');
});

test('a ChatGPT Web task as the Hub streams it: every entry asks for the task again, and the status it carries is not read as a state', async () => {
  const { store, feed, refreshed, shown } = await page();
  store.getState().setSelectedTaskId(WEB);
  const web = (type, status) => ({ type: 'event', taskId: WEB, event: { at: '2026-11-11T10:00:00.000Z', type, message: type }, status, transport: 'chatgpt-web' });
  for (const [type, status] of [['preparing', 'preparing'], ['queued', 'queued'], ['browser_claimed', 'running'], ['browser_sent', 'running'], ['browser_reply', 'running'], ['completed', 'completed']]) feed(web(type, status));
  assert.deepEqual(refreshed, Array(6).fill(WEB), 'six entries, six requests for the task');
  assert.equal(shown(), '', 'a web task streams no text');
});

test('an event of a task that is not on screen changes nothing that is shown and still refreshes that task', async () => {
  const { store, feed, refreshed, shown } = await page();
  store.getState().setSelectedTaskId(API);
  feed(token('Half an answer'));
  feed({ ...entry('completed', 'completed'), taskId: OTHER });
  feed({ ...state('completed'), taskId: OTHER });
  assert.equal(shown(), 'Half an answer', 'the end of another task does not take the text of this one away');
  assert.deepEqual(refreshed, [OTHER, OTHER]);
});
