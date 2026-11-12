// End-to-end scenario: the task event streams of a real Hub process, with a scripted model server.
//
// `GET /api/tasks/events` (every task) and `GET /api/tasks/<id>/stream` (one task) are what the page listens to (ui/src/lib/useTaskStream.ts). The task engine of a real Hub is a
// DualAgent (the Model API workers and the ChatGPT Web runner behind one surface); for as long as it had no `subscribe`, both routes answered 200, said `: connected`, and then
// carried nothing but heartbeats, whatever a task did. This suite opens the streams BEFORE a task and looks at what arrives while it runs:
//   - the events of the task arrive on /api/tasks/events, in the order of the task's record, and each one is exactly the entry `GET /api/tasks/<id>` returns (so the stream tells an
//     authenticated client nothing the task route does not: the same masking, the same clipping);
//   - the state changes arrive too, and the last one is the state the task rests in;
//   - the pieces of the answer arrive as `token` events and add up to the answer, masked as the record masks it;
//   - the stream of ONE task starts with its snapshot and carries that task only, while another task runs;
//   - both routes refuse a request without the bearer.
// Only the Model API engine runs here: the ChatGPT Web engine needs the Companion in a browser. Its events are covered with the real BrowserRunner in verify-task-event-streams.mjs.
//
// The scripted model proves what the Hub does. It does not prove anything about a real model (docs/TESTING-WITH-REAL-MODELS.md).
import path from 'node:path';
import { eventually, runScenario } from './e2e/harness.mjs';
import { connectModel, continueTask, setMode, startTask, waitForState } from './e2e/hub-process.mjs';
import { gitInit, makeCalcProject } from './e2e/fixtures.mjs';
import { call, say } from './e2e/scenarios.mjs';
import { openTaskEventStream } from './support/task-event-stream.mjs';

const RESTING = ['completed', 'failed', 'uncertain', 'paused', 'cancelled'];
// A string of the shape the Hub masks wherever it records a task (lib/agent.mjs, #redact): not a real key.
const KEY_SHAPED = 'sk-' + 'e2eStreamProbe0123456789';

await runScenario({
  name: 'task-streams',
  summary: 'the task event streams of a real Hub: events in the order of the record and equal to it, state changes, answer pieces, one task per task stream, the bearer',
  budgetMs: 240_000,
}, async (t) => {
  const project = path.join(t.scratch, 'app');
  makeCalcProject(project);
  gitInit(project, t.scratch);
  const mock = await t.mock({
    scenario: 'look',
    scenarios: {
      // Reads a file (a tool call, with its tool_start / tool_result events), then answers.
      look(ctx) { return ctx.turn === 0 ? call('read_file', { path: 'calc.js' }) : say(`The add function subtracts. A key looks like ${KEY_SHAPED}.`); },
    },
  });
  const hub = await t.hub({ project });
  await connectModel(hub, mock);
  await setMode(hub, 'review');

  // ---- the bearer ----------------------------------------------------------------------------------------------------------------------------------
  const refused = await openTaskEventStream(hub.origin, '/api/tasks/events');
  t.equal(refused.status, 401, '/api/tasks/events without the bearer: 401');

  // ---- every task: opened before the task exists ---------------------------------------------------------------------------------------------------
  const all = await openTaskEventStream(hub.origin, '/api/tasks/events', { headers: hub.authHeaders });
  t.own(() => all.close());
  t.must(all.status === 200 && /text\/event-stream/.test(all.contentType), '/api/tasks/events answers 200 text/event-stream', `${all.status} ${all.contentType}`);
  t.equal(all.comments[0], 'connected', 'and says ": connected" first');
  t.equal(all.events.length, 0, 'nothing is sent before a task does something');

  const first = await startTask(hub, 'Look at calc.js and say what is wrong.');
  await waitForState(hub, first.id, RESTING);
  const record = await hub.task(first.id);
  t.must(record.state === 'completed' && record.events.length >= 3, 'the task completed and its record has events', `${record.state}, ${record.events?.length} events`);

  const of = (stream, id, type) => stream.events.filter((event) => event.taskId === id && event.type === type);
  // The record is complete when the task rests; the last event may still be on its way to this process.
  const arrived = await eventually(() => of(all, first.id, 'event').length >= record.events.length, { timeoutMs: 5000, label: 'the events of the task on /api/tasks/events' }).catch(() => false);
  t.must(Boolean(arrived), 'the events of the task arrive on /api/tasks/events while it runs', `${of(all, first.id, 'event').length} of ${record.events.length} arrived; the stream sent ${all.events.length} events in all`);
  const streamed = of(all, first.id, 'event');
  t.equal(streamed.map((event) => event.event), record.events, 'in the order of the record, each one exactly the entry GET /api/tasks/<id> returns');
  t.check(streamed.some((event) => event.event.type === 'tool_start') && streamed.some((event) => event.event.type === 'tool_result'), 'the tool call is among them (tool_start, tool_result)');
  t.check(all.events.every((event) => event.transport === 'api'), 'every event says which engine it came from (transport: "api")', JSON.stringify(all.events.find((event) => event.transport !== 'api'))?.slice(0, 200));

  const states = of(all, first.id, 'state').map((event) => event.state);
  t.check(states.length >= 2 && states.at(-1) === 'completed', 'the state changes arrive and the last is "completed"', states.join(' > '));
  // The history starts with the state the task was created in, which is not a move.
  t.equal(states, record.stateHistory?.slice(1).map((entry) => entry.to) ?? null,'they are the moves of the record\'s state history, in order');

  const pieces = of(all, first.id, 'token').map((event) => event.token).join('');
  t.check(pieces.includes('The add function subtracts.'), 'the pieces of the answer arrive as token events', pieces.slice(0, 120));

  // What a client is told: the record masks a key-shaped string wherever it keeps one. The events equal the record (above), so they are masked alike.
  t.check(!JSON.stringify(record).includes(KEY_SHAPED), 'the record holds no key-shaped string');
  t.check(!JSON.stringify(all.events.filter((event) => event.type !== 'token')).includes(KEY_SHAPED), 'nor does any event of the stream, the answer pieces aside');
  // The pieces go through a hold-back mask (lib/token-mask.mjs) before they are sent: a secret cut between two pieces is held until it can be masked whole.
  t.check(!pieces.includes(KEY_SHAPED) && !pieces.includes(KEY_SHAPED.slice(0, 8)), 'nor do the answer pieces: a client is shown what the record keeps', pieces.slice(-80));
  t.check(pieces.includes('A key looks like [REDACTED].'), 'the pieces end with the answer as the record masks it', pieces.slice(-80));

  // ---- one task ------------------------------------------------------------------------------------------------------------------------------------
  t.equal((await openTaskEventStream(hub.origin, `/api/tasks/${first.id}/stream`)).status, 401, '/api/tasks/<id>/stream without the bearer: 401');
  const one = await openTaskEventStream(hub.origin, `/api/tasks/${first.id}/stream`, { headers: hub.authHeaders });
  t.own(() => one.close());
  await eventually(() => one.events.length >= 1, { timeoutMs: 5000, label: 'the snapshot' }).catch(() => {});
  t.equal([one.status, one.events.length, one.events[0]?.type, one.events[0]?.task?.id], [200, 1, 'task_snapshot', first.id], 'the stream of one task starts with its snapshot');

  const before = all.events.length;
  const second = await startTask(hub, 'Look at calc.js once more.');
  await waitForState(hub, second.id, RESTING);
  const secondRecord = await hub.task(second.id);
  await eventually(() => of(all, second.id, 'event').length >= secondRecord.events.length, { timeoutMs: 5000, label: 'the second task on /api/tasks/events' }).catch(() => {});
  t.equal(of(all, second.id, 'event').map((event) => event.event), secondRecord.events, 'another task: its events arrive on /api/tasks/events');
  t.check(all.events.slice(before).every((event) => event.taskId === second.id), 'and nothing of the first task, which is at rest');
  t.equal(one.events.length, 1, 'the stream of the first task carries nothing of the second');

  await continueTask(hub, first.id, 'And once more, please.');
  await waitForState(hub, first.id, RESTING);
  const again = await hub.task(first.id);
  const fresh = again.events.slice(record.events.length);
  await eventually(() => of(one, first.id, 'event').length >= fresh.length, { timeoutMs: 5000, label: 'the next run on the stream of the task' }).catch(() => {});
  t.equal(of(one, first.id, 'event').map((event) => event.event), fresh, 'the first task goes on: its new events arrive on its own stream, in order');
  t.check(one.events.slice(1).every((event) => event.taskId === first.id), 'and every event there is of that task');

  // ---- a closed stream ---------------------------------------------------------------------------------------------------------------------------
  await one.close();
  await all.close();
  const third = await startTask(hub, 'Look at calc.js a last time.');
  await waitForState(hub, third.id, RESTING);
  t.equal((await hub.task(third.id)).state, 'completed', 'a task runs to its end after its watchers went away');
  t.check(!/Listener error/.test(hub.logText()), 'and the Hub logged no listener error');
});
