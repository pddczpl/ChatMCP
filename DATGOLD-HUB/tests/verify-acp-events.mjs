// What the editor is told while a task runs (lib/acp/event-map.mjs, plan task ux-20): the record the Hub publishes for a task, turned into ACP session/update messages by pure functions.
//
//   A. The kind and the title of a tool call, for every tool of the Hub's catalogs (a tool added to the Hub must be given a kind here: the catalog is read, not copied).
//   B. A real task record (probe of a Hub, fixtures/acp-task-record.json): the exact updates, in order, and nothing of the Hub's own chatter.
//   C. The record is read again and again while the task runs: whatever the points at which it is read, nothing is said twice and nothing is lost.
//   D. A call that waits for an approval, a call that fails, a result that cannot be read, a record that has lost its oldest events.
//   E. Where a call happened: only a path inside the folder of the session is a location; text and sizes are bounded.
//   F. The plan, the usage, and the answer at the end.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalTools } from '../lib/local-tools.mjs';
import { StudioTools } from '../lib/studio-tools.mjs';
import { MAX_TITLE_CHARS, MAX_TOOL_OUTPUT_CHARS, TOOL_KINDS, createTurnMapper, kindOf, locationsOf, titleOf } from '../lib/acp/event-map.mjs';

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
const fixture = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'acp-task-record.json'), 'utf8')).task;
const CWD = process.platform === 'win32' ? 'C:\\work\\project' : '/work/project';
const inside = (...parts) => path.join(CWD, ...parts);

// ---- A. kinds and titles ---------------------------------------------------------------------------------------------------------------------------------------------
{
  const local = new LocalTools({ workspace: { resolve() { throw new Error('not used'); } }, stateDirectory: null }).definitions();
  const studio = new StudioTools({ workspace: {}, gate: {}, intelligence: null }).definitions();
  assert.ok(local.length >= 90 && studio.length >= 15, `the catalogs were read (${local.length} local tools, ${studio.length} studio tools)`);
  for (const definition of [...local, ...studio]) {
    const kind = kindOf(definition.name);
    assert.ok(TOOL_KINDS.includes(kind), `${definition.name} has a kind of the protocol (${kind})`);
    assert.notEqual(kindOf(definition.name, { strict: true }), null, `${definition.name} is in the table: a tool of the Hub that the table does not know must be given a kind on purpose`);
    if (definition.annotations?.readOnlyHint === true) assert.ok(['read', 'search', 'think', 'fetch', 'other'].includes(kind), `${definition.name} only reads, so it is not ${kind}`);
    if (definition.annotations?.destructiveHint === true) assert.ok(['delete', 'execute', 'edit', 'other', 'move', 'fetch'].includes(kind), `${definition.name} is destructive, so it is not ${kind}`);
    const title = titleOf(definition.name, { path: 'src/a.js', command: 'npm test' });
    assert.ok(typeof title === 'string' && title.length > 2 && title.length <= MAX_TITLE_CHARS, `${definition.name} has a title: ${title}`);
  }
  ok(`every one of the ${local.length} local tools and ${studio.length} studio tools of the Hub has a kind of the protocol and a title, and a tool that only reads is not shown as a change`);

  const expectations = [
    ['local.read_file', { path: 'calc.js' }, 'read', 'Read calc.js'],
    ['local.write_file', { path: 'out.txt' }, 'edit', 'Write out.txt'],
    ['local.edit_file', { path: 'a/b.js' }, 'edit', 'Edit a/b.js'],
    ['local.delete_path', { path: 'old.txt' }, 'delete', 'Delete old.txt'],
    ['local.move_path', { source: 'a.txt', destination: 'b.txt' }, 'move', 'Move a.txt to b.txt'],
    ['local.search_files', {}, 'search', 'Search files'],
    ['local.search_files', { path: 'src' }, 'search', 'Search files in src'],
    ['local.run_command', { command: 'npm test' }, 'execute', 'Run npm test'],
    ['local.files_write_batch', { paths: ['a.txt', 'b.txt', 'c.txt'] }, 'edit', 'Write 3 files'],
    ['local.files_write_batch', { paths: ['a.txt'] }, 'edit', 'Write a.txt'],
    ['local.web_fetch', {}, 'fetch', 'Fetch a web page'],
    ['studio.read', { path: 'README.md' }, 'read', 'Read README.md'],
    ['studio.plan_set', {}, 'think', 'Update the plan'],
    ['github.create_issue', {}, 'other', 'Create issue'],
    ['spawn_agent', {}, 'think', 'Start a helper agent'],
  ];
  for (const [name, input, kind, title] of expectations) {
    assert.equal(kindOf(name), kind, `${name} is ${kind}`);
    assert.equal(titleOf(name, input), title, `${name} ${JSON.stringify(input)}`);
  }
  assert.equal(kindOf('something.new'), 'other');
  assert.equal(kindOf('something.new', { strict: true }), null, 'strict: a name that is not in the table is null');
  assert.equal(titleOf(undefined, undefined), 'Tool call');
  assert.equal(titleOf('local.run_command', { command: 'x'.repeat(500) }).length, MAX_TITLE_CHARS);
  ok('the kind and the title of the calls an editor sees most, a name the table does not know (another program\'s tool) is "other" with a title made of its words, and a title is bounded');
}

// ---- B. a real record --------------------------------------------------------------------------------------------------------------------------------------------------
const toolEvents = fixture.events.filter((event) => event.type === 'tool_start' || event.type === 'tool_result');
{
  const mapper = createTurnMapper({ cwd: CWD });
  const updates = mapper.next(fixture);
  assert.deepEqual(updates.map((u) => u.sessionUpdate), ['tool_call', 'tool_call_update', 'tool_call', 'tool_call_update', 'tool_call', 'tool_call_update', 'agent_message_chunk']);
  assert.deepEqual(updates[0], { sessionUpdate: 'tool_call', toolCallId: 'call_mock_2', title: 'Read calc.js', kind: 'read', status: 'in_progress', locations: [{ path: inside('calc.js') }], rawInput: { path: 'calc.js' } });
  assert.equal(updates[1].sessionUpdate, 'tool_call_update');
  assert.equal(updates[1].toolCallId, 'call_mock_2');
  assert.equal(updates[1].status, 'completed');
  assert.equal(updates[1].content[0].type, 'content');
  assert.equal(updates[1].content[0].content.type, 'text');
  assert.match(updates[1].content[0].content.text, /function add\(a, b\)/, 'the text of the result is the Hub\'s');
  assert.equal(updates[2].title, 'Write out.txt');
  assert.equal(updates[2].kind, 'edit');
  assert.equal(updates[3].toolCallId, 'call_mock_3');
  assert.equal(updates[3].checkpointId, undefined, 'a checkpoint id is the Hub\'s and goes nowhere');
  assert.deepEqual(updates[6], { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'WRITE-DONE all good.' } });
  assert.equal(mapper.cursor, fixture.eventCount);
  const said = JSON.stringify(updates);
  for (const chatter of ['preflight', 'repo_map', 'context_budget', 'goal_evidence', 'instructions_loaded', 'Đang chuẩn bị', 'Model đang xử lý']) assert.ok(!said.includes(chatter), `the Hub's own ${chatter} is not said`);
  assert.deepEqual(mapper.next(fixture), [], 'the same record again says nothing');
  assert.deepEqual(mapper.finalText(fixture), '', 'the answer was said as a message of the model: it is not said again at the end');
  ok('a real record of a task (a read, a write and an edit, then the answer): the updates are exactly these, in order, with the paths of the folder, and nothing of the Hub\'s preparation and bookkeeping');
}

// ---- C. read again and again ------------------------------------------------------------------------------------------------------------------------------------------
{
  const whole = createTurnMapper({ cwd: CWD }).next(fixture);
  const total = fixture.events.length;
  for (let first = 0; first <= total; first += 1) {
    for (const second of [first, Math.min(total, first + 1), Math.min(total, first + 5), total]) {
      const mapper = createTurnMapper({ cwd: CWD });
      const part = (n) => ({ ...fixture, events: fixture.events.slice(0, n), eventCount: n, ...(n < total ? { finalText: '', state: 'running' } : {}) });
      const got = [...mapper.next(part(first)), ...mapper.next(part(second)), ...mapper.next(part(total))];
      assert.deepEqual(got, whole, `read after ${first} events, then ${second}, then all`);
    }
  }
  ok(`the record read after any number of events, then after any later number, then whole (${(total + 1) * 4} orders) says exactly what the whole record says: nothing twice, nothing lost`);

  // The Hub keeps a bounded list of events: a record that starts later than the cursor is read from its first event.
  const mapper = createTurnMapper({ cwd: CWD });
  const trimmed = { ...fixture, events: fixture.events.slice(10), eventCount: fixture.eventCount };
  const got = mapper.next(trimmed);
  assert.ok(got.length > 0 && got.every((u) => u.sessionUpdate !== undefined));
  assert.equal(mapper.missed, 10, 'the 10 events that were trimmed before the record was read are counted as missed');
  const resumed = createTurnMapper({ cwd: CWD, from: fixture.eventCount });
  assert.deepEqual(resumed.next(fixture), [], 'a turn that continues a task starts after the events of the earlier turns');
  ok('a record that has lost its oldest events is read from its first event and the loss is counted, and a turn that continues a task starts after what was said before');
}

// ---- D. approvals, failures, results that cannot be read ---------------------------------------------------------------------------------------------------------
{
  const start = { at: 't', type: 'tool_start', message: '', state: 'planning', toolName: 'local.write_file', callId: 'c1', status: 'running', input: { path: 'out.txt' } };
  const waiting = { id: 'task', state: 'waiting_approval', events: [start], eventCount: 1, pendingCall: { callId: 'c1', toolName: 'local.write_file', phase: 'awaiting_approval' } };
  const mapper = createTurnMapper({ cwd: CWD });
  const first = mapper.next(waiting);
  assert.equal(first.length, 1);
  assert.equal(first[0].status, 'pending', 'a call that waits for an approval has not started');
  assert.deepEqual(mapper.next(waiting), []);
  const running = { ...waiting, state: 'running', pendingCall: { callId: 'c1', toolName: 'local.write_file', phase: 'executing' } };
  assert.deepEqual(mapper.next(running), [{ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'in_progress' }], 'once it is approved it runs');
  assert.deepEqual(mapper.next(running), []);
  const done = { ...running, events: [start, { type: 'tool_result', callId: 'c1', toolName: 'local.write_file', status: 'completed', message: JSON.stringify({ isError: false, content: [{ type: 'text', text: 'Created out.txt' }] }) }], eventCount: 2, pendingCall: null };
  const finished = mapper.next(done);
  assert.deepEqual(finished.map((u) => [u.sessionUpdate, u.status]), [['tool_call_update', 'completed']]);
  ok('a call that waits for an approval is announced as pending, becomes in progress when the Hub says it executes, and completes once');

  const refused = createTurnMapper({ cwd: CWD });
  const refusedRecord = { id: 'task', state: 'running', events: [start, { type: 'tool_result', callId: 'c1', toolName: 'local.write_file', status: 'completed', message: JSON.stringify({ isError: true, content: [{ type: 'text', text: 'The owner refused.' }] }) }], eventCount: 2, pendingCall: null };
  const refusedUpdates = refused.next(refusedRecord);
  assert.equal(refusedUpdates[0].status, 'in_progress');
  assert.equal(refusedUpdates[1].status, 'failed', 'a result with isError is a failed call');
  assert.equal(refusedUpdates[1].content[0].content.text, 'The owner refused.');

  for (const message of ['not json at all', '', '{"isError":"yes"}', '[1,2]', 'null', JSON.stringify({ content: 'text' }), JSON.stringify({ isError: false, content: [{ type: 'image', data: 'AAAA' }] })]) {
    const odd = createTurnMapper({ cwd: CWD });
    const updates = odd.next({ id: 'task', state: 'running', events: [start, { type: 'tool_result', callId: 'c1', toolName: 'local.write_file', status: 'completed', message }], eventCount: 2 });
    assert.equal(updates.length, 2, `a result that reads ${JSON.stringify(message).slice(0, 30)} is still an update`);
    assert.ok(['completed', 'failed'].includes(updates[1].status));
  }
  // The Hub records a call that was refused (by the owner, by the permission gate, for a protected path) or that failed as an event of its own: `tool_error`, with the same message, or plain words.
  for (const message of [JSON.stringify({ isError: true, content: [{ type: 'text', text: 'Permission denied: the owner refused' }] }), 'The tool lost its connection']) {
    const refusedByHub = createTurnMapper({ cwd: CWD }).next({ id: 't', state: 'running', events: [start, { type: 'tool_error', callId: 'c1', toolName: 'local.write_file', status: 'error', message }], eventCount: 2 });
    assert.deepEqual(refusedByHub.map((u) => [u.sessionUpdate, u.status]), [['tool_call', 'in_progress'], ['tool_call_update', 'failed']], 'a tool_error is a failed call');
    assert.match(refusedByHub[1].content[0].content.text, /refused|lost its connection/);
  }
  assert.deepEqual(createTurnMapper({ cwd: CWD }).next({ id: 't', state: 'running', events: [{ type: 'tool_error', callId: 'x', toolName: 'local.read_file', status: 'error', message: 'blocked' }], eventCount: 1 }).map((u) => [u.sessionUpdate, u.toolCallId, u.status]), [['tool_call', 'x', 'failed']], 'a tool_error whose start was never seen introduces the call itself');
  const failedByStatus = createTurnMapper({ cwd: CWD }).next({ id: 't', state: 'running', events: [start, { type: 'tool_result', callId: 'c1', toolName: 'local.write_file', status: 'failed', message: 'boom' }], eventCount: 2 });
  assert.equal(failedByStatus[1].status, 'failed', 'the status of the event counts when the result says nothing');
  const orphan = createTurnMapper({ cwd: CWD }).next({ id: 't', state: 'running', events: [{ type: 'tool_result', callId: 'lost', toolName: 'local.read_file', status: 'completed', input: { path: 'a.js' }, message: JSON.stringify({ isError: false, content: [{ type: 'text', text: 'x' }] }) }], eventCount: 1 });
  assert.deepEqual(orphan.map((u) => [u.sessionUpdate, u.toolCallId, u.status]), [['tool_call', 'lost', 'completed']], 'a result whose start was never seen introduces the call itself');
  assert.deepEqual(createTurnMapper({ cwd: CWD }).next({ id: 't', state: 'running', events: [{ type: 'tool_start', toolName: 'local.read_file' }, { type: 'tool_result' }, { type: 'assistant', message: '   ' }, null, 7, 'x', { type: 'assistant', message: 5 }], eventCount: 7 }), [], 'events without a call id, an empty answer and things that are not events say nothing');
  ok('a refused or failed call, a result that is not JSON or not what the Hub writes, a result without its start, and events that are not events: each is an update or nothing, never an exception');
}

// ---- E. locations and bounds ---------------------------------------------------------------------------------------------------------------------------------------------
{
  assert.deepEqual(locationsOf({ path: 'a/b.js' }, CWD), [{ path: inside('a', 'b.js') }]);
  assert.deepEqual(locationsOf({ paths: ['a.js', 'b/c.js'] }, CWD), [{ path: inside('a.js') }, { path: inside('b', 'c.js') }]);
  assert.deepEqual(locationsOf({ source: 'a.js', destination: 'b.js' }, CWD), [{ path: inside('a.js') }, { path: inside('b.js') }]);
  assert.deepEqual(locationsOf({ path: '../outside.txt' }, CWD), [], 'a path that leaves the folder is not a location');
  assert.deepEqual(locationsOf({ path: path.resolve(CWD, '..', 'other', 'x.txt') }, CWD), [], 'an absolute path outside the folder neither');
  assert.deepEqual(locationsOf({ path: inside('in', 'side.txt') }, CWD), [{ path: inside('in', 'side.txt') }], 'an absolute path inside does');
  assert.deepEqual(locationsOf({ path: '' }, CWD), []);
  assert.deepEqual(locationsOf({ path: 5, paths: 'x', source: null }, CWD), []);
  assert.deepEqual(locationsOf(undefined, CWD), []);
  assert.deepEqual(locationsOf({ path: 'a\u0000b' }, CWD), [], 'a path with a NUL is not a path');
  assert.equal(locationsOf({ paths: Array.from({ length: 500 }, (_, i) => `f${i}.txt`) }, CWD).length, 50, 'at most 50 locations');
  ok('only a path inside the folder of the session is a location (relative, absolute, a list, a source and a destination); outside, empty, not a string, with a NUL: none; at most 50');

  const big = 'x'.repeat(MAX_TOOL_OUTPUT_CHARS * 3);
  const mapper = createTurnMapper({ cwd: CWD });
  const [, result] = mapper.next({ id: 't', state: 'running', events: [{ type: 'tool_start', callId: 'c', toolName: 'local.read_file', input: { path: 'big' } }, { type: 'tool_result', callId: 'c', toolName: 'local.read_file', status: 'completed', message: JSON.stringify({ isError: false, content: [{ type: 'text', text: big }] }) }], eventCount: 2 });
  const text = result.content[0].content.text;
  assert.ok(text.length <= MAX_TOOL_OUTPUT_CHARS + 200 && text.startsWith('xxx') && /characters? (left out|not shown)/.test(text), `the output is bounded and says that it was cut (${text.length} characters)`);
  const many = createTurnMapper({ cwd: CWD }).next({ id: 't', state: 'running', events: [{ type: 'tool_start', callId: 'c', toolName: 'local.read_file', input: { path: 'a', truncated: true } }, { type: 'tool_result', callId: 'c', toolName: 'local.read_file', status: 'completed', message: JSON.stringify({ isError: false, content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }, { type: 'image', data: 'AAAA' }] }) }], eventCount: 2 });
  assert.equal(many[1].content.length, 1, 'the text blocks of a result are one block of text');
  assert.equal(many[1].content[0].content.text, 'one\n\ntwo');
  ok('the output of a tool is bounded and says it was cut, several text blocks are one, and an image of a result is not sent');
}

// ---- F. the plan, the usage, the answer ---------------------------------------------------------------------------------------------------------------------------------
{
  const plan = (statuses) => ({ version: 1, origin: 'host-proposed-not-model-verified', goal: 'g', objectives: [], evidence: {}, phases: [['inspect', 'Inspect project instructions and relevant code'], ['edit', 'Implement bounded changes'], ['verify', 'Run relevant checks and diagnose results'], ['review', 'Review actual changes and report limitations']].map(([id, title], i) => ({ id, title, proof: 'p', status: statuses[i], receipts: 0 })) });
  const mapper = createTurnMapper({ cwd: CWD });
  const first = mapper.next({ id: 't', state: 'running', events: [], eventCount: 0, goalPlan: plan(['working', 'todo', 'todo', 'todo']) });
  assert.deepEqual(first, [{ sessionUpdate: 'plan', entries: [
    { content: 'Inspect project instructions and relevant code', priority: 'medium', status: 'in_progress' },
    { content: 'Implement bounded changes', priority: 'medium', status: 'pending' },
    { content: 'Run relevant checks and diagnose results', priority: 'medium', status: 'pending' },
    { content: 'Review actual changes and report limitations', priority: 'medium', status: 'pending' },
  ] }]);
  assert.deepEqual(mapper.next({ id: 't', state: 'running', events: [], eventCount: 0, goalPlan: plan(['working', 'todo', 'todo', 'todo']) }), [], 'the same plan is not said again');
  const moved = mapper.next({ id: 't', state: 'running', events: [], eventCount: 0, goalPlan: plan(['has_evidence', 'working', 'todo', 'todo']) });
  assert.deepEqual(moved[0].entries.map((e) => e.status), ['completed', 'in_progress', 'pending', 'pending']);
  for (const odd of [null, undefined, {}, { version: 1, phases: 'x' }, { version: 1, phases: [{ title: 5 }, null, { title: '' }] }, { version: 2, phases: [{ title: 'x', status: 'working' }] }]) {
    assert.deepEqual(createTurnMapper({ cwd: CWD }).next({ id: 't', state: 'running', events: [], eventCount: 0, goalPlan: odd }), [], `a goal plan that is ${JSON.stringify(odd)} says nothing`);
  }
  ok('the plan of the Hub (its phases) is said when it first exists and each time a phase changes, with the statuses of the protocol, and never from something that is not a plan');

  const usage = (requests, input, output, extra = {}) => ({ inputTokens: input, outputTokens: output, httpRequests: requests, inputUsageReported: requests, inputUsageMissing: 0, outputUsageReported: requests, outputUsageMissing: 0, ...extra });
  const policy = { source: 'catalog', capacityTokens: 200_000, approximate: false };
  const meter = createTurnMapper({ cwd: CWD });
  assert.deepEqual(meter.next({ id: 't', state: 'running', events: [], eventCount: 0, usage: usage(0, 0, 0), contextPolicy: policy }), [], 'before the first response there is nothing to say');
  assert.deepEqual(meter.next({ id: 't', state: 'running', events: [], eventCount: 0, usage: usage(1, 1200, 300), contextPolicy: policy }), [{ sessionUpdate: 'usage_update', used: 1500, size: 200_000 }]);
  assert.deepEqual(meter.next({ id: 't', state: 'running', events: [], eventCount: 0, usage: usage(1, 1200, 300), contextPolicy: policy }), [], 'the same numbers are not said again');
  assert.deepEqual(meter.next({ id: 't', state: 'running', events: [], eventCount: 0, usage: usage(3, 5200, 800), contextPolicy: policy }), [], 'two responses since the last look: the size of the context is not known from the sums, so nothing is said');
  assert.deepEqual(meter.next({ id: 't', state: 'running', events: [], eventCount: 0, usage: usage(4, 7000, 900), contextPolicy: policy }), [{ sessionUpdate: 'usage_update', used: 1900, size: 200_000 }], 'one response since the last look: its tokens are what the context holds');
  for (const [name, record] of [
    ['a window that is a fallback', { usage: usage(1, 100, 10), contextPolicy: { ...policy, source: 'conservative_fallback' } }],
    ['a window that is approximate', { usage: usage(1, 100, 10), contextPolicy: { ...policy, approximate: true } }],
    ['no window', { usage: usage(1, 100, 10) }],
    ['a window that is not a number', { usage: usage(1, 100, 10), contextPolicy: { ...policy, capacityTokens: '200000' } }],
    ['tokens the provider did not report', { usage: usage(1, 100, 10, { inputUsageMissing: 1 }), contextPolicy: policy }],
    ['output tokens the provider did not report', { usage: usage(1, 100, 10, { outputUsageMissing: 1 }), contextPolicy: policy }],
    ['no usage', { contextPolicy: policy }],
    ['usage that is not numbers', { usage: { inputTokens: 'a', outputTokens: 2, httpRequests: 1, inputUsageMissing: 0, outputUsageMissing: 0 }, contextPolicy: policy }],
    ['negative numbers', { usage: usage(1, -5, 10), contextPolicy: policy }],
    ['more used than the window', { usage: usage(1, 300_000, 10), contextPolicy: policy }],
  ]) {
    assert.deepEqual(createTurnMapper({ cwd: CWD }).next({ id: 't', state: 'running', events: [], eventCount: 0, ...record }), [], `${name}: nothing is said`);
  }
  ok('the usage is said only from what the provider reported, for one response at a time, against a window that is not a fallback or an estimate; in every other case nothing');

  const answered = createTurnMapper({ cwd: CWD });
  answered.next({ id: 't', state: 'running', events: [{ type: 'assistant', message: 'First I look.' }, { type: 'assistant', message: 'All done.' }], eventCount: 2 });
  assert.equal(answered.finalText({ finalText: 'All done.', finalParts: { words: 'All done.', verificationNotice: null, hookNotice: null } }), '', 'the words were said as a message');
  assert.equal(answered.finalText({ finalText: 'All done.\n\n[Verification notice] Nothing was checked.', finalParts: { words: 'All done.', verificationNotice: '[Verification notice] Nothing was checked.', hookNotice: null } }), '[Verification notice] Nothing was checked.', 'a sentence of the Hub that follows the words is said');
  assert.equal(answered.finalText({ finalText: 'Something else entirely.', finalParts: { words: 'Something else entirely.' } }), 'Something else entirely.', 'words that were not said are said');
  assert.equal(answered.finalText({ finalText: 'Plain text', finalParts: null }), 'Plain text', 'a record without parts: the final text, if it was not said');
  assert.equal(answered.finalText({ finalText: '  ' }), '');
  assert.equal(answered.finalText({}), '');
  assert.equal(answered.finalText(null), '');
  assert.equal(answered.finalText({ finalText: 'All done.' }), '', 'a final text that was said, without parts, is not said again');
  ok('the answer at the end is what was not already said as a message of the model: nothing when it was, the sentences of the Hub that follow it, and the whole of it when no message carried it');
}

// ---- G. the edges that the mutation work found (tests/mutation/acp-events.json) -----------------------------------------------------------------------------------------
{
  const fresh = () => createTurnMapper({ cwd: CWD });
  const start = (callId = 'c1', extra = {}) => ({ type: 'tool_start', callId, toolName: 'local.read_file', input: { path: 'a.js' }, ...extra });
  const result = (message, extra = {}) => ({ type: 'tool_result', callId: 'c1', toolName: 'local.read_file', status: 'completed', message, ...extra });
  const words = (text) => JSON.stringify({ content: [{ type: 'text', text }] });
  const said = (text) => ({ type: 'assistant', message: text });
  const record = (events, extra = {}) => ({ eventCount: events.length, events, ...extra });
  const textOf = (update) => update.content?.[0]?.content?.text;

  // titles
  assert.equal(titleOf(undefined, { path: 'a.js' }), 'Tool call', 'a call without a name has no detail');
  assert.equal(titleOf('', { command: 'x' }), 'Tool call');
  assert.equal(titleOf('local.update_plan', {}), 'Update the plan');
  assert.equal(titleOf('local.read_file', {}), 'Read file', 'a verb without a detail is the words of the name');
  assert.equal(titleOf('local.files_write_batch', { paths: ['a.txt', 'b.txt'] }), 'Write 2 files');
  assert.equal(titleOf('local.search_files', { path: 'p'.repeat(500) }).length, MAX_TITLE_CHARS, 'the title of a search is bounded');
  assert.equal(titleOf('github.create_issue', { command: 'x'.repeat(500) }).length, MAX_TITLE_CHARS, 'the title of another program\'s tool is bounded');
  assert.equal(titleOf('github.create_issue', { path: 'a.md', command: 'run' }), 'Create issue run', 'the command is the detail before the path');
  assert.equal(titleOf('local.read_file', { path: '  a.js  ' }), 'Read a.js', 'a path is taken without the spaces around it');
  assert.equal(titleOf('local.read_file', { path: '   ' }), 'Read file', 'a path of spaces is no path');
  // locations
  assert.deepEqual(locationsOf({ path: '..' }, CWD), [], 'the folder above the folder of the session is not a location');
  assert.deepEqual(locationsOf({ path: '.' }, CWD), [], 'the folder of the session itself is not a location');
  assert.deepEqual(locationsOf({ path: 'a.js', paths: ['a.js', 'b.js', './a.js'] }, CWD), [{ path: inside('a.js') }, { path: inside('b.js') }], 'a file named three times is one location');
  assert.deepEqual(locationsOf({ path: 'a.js' }, ''), [], 'without the folder of the session nothing is a location');
  if (process.platform === 'win32') assert.deepEqual(locationsOf({ path: 'D:\\elsewhere\\a.js' }, 'C:\\work\\project'), [], 'a file on another drive is not a location');
  ok('the edges of a title (no name, no detail, two files, spaces around a path, a bound on every branch, the command before the path) and of a location (the folder above, the folder itself, a file named twice, no folder of the session, another drive)');

  // the result of a call
  let told = fresh().next(record([start(), result(JSON.stringify({ isError: 'yes', content: [{ type: 'text', text: 'fine' }] }))]));
  assert.equal(told[1].status, 'completed', 'only the value true means an error');
  told = fresh().next(record([start(), result(JSON.stringify({ content: [{ type: 'image', text: 'not words' }, { type: 'text', text: 'words' }] }))]));
  assert.deepEqual(told[1].content, [{ type: 'content', content: { type: 'text', text: 'words' } }], 'only a block of type text holds words');
  const exact = 'x'.repeat(MAX_TOOL_OUTPUT_CHARS);
  assert.equal(textOf(fresh().next(record([start(), result(words(exact))]))[1]), exact, 'text of exactly the limit is not cut');
  assert.ok(textOf(fresh().next(record([start(), result(words(`${exact}y`))]))[1]).endsWith('1 characters not shown'), 'one more character is cut, and the cut says how much');
  assert.equal(textOf(fresh().next(record([start(), result('42')]))[1]), '42', 'words that happen to be a JSON number are words');
  assert.equal(textOf(fresh().next(record([start(), result('[1,2]')]))[1]), '[1,2]', 'and so are words that happen to be a JSON list');
  told = fresh().next(record([start('c1', { input: ['a.js'] })]));
  assert.ok(!('rawInput' in told[0]) && !('locations' in told[0]), 'an input that is a list is no input');
  told = fresh().next(record([start(), start()]));
  assert.equal(told.filter((update) => update.sessionUpdate === 'tool_call').length, 1, 'a call that starts twice is announced once');
  told = fresh().next(record([start('mine')], { pendingCall: { callId: 'other', phase: 'awaiting_approval' } }));
  assert.equal(told[0].status, 'in_progress', 'the call that waits for an approval is the one the Hub names, and not every call');
  told = fresh().next(record([start(), { type: 'tool_error', callId: 'c1', toolName: 'local.read_file', message: 'Permission denied' }]));
  assert.equal(told[1].status, 'failed', 'a tool_error is a failure whatever its status field says (here it has none)');
  told = fresh().next(record([result(words('late'))]));
  assert.deepEqual(told[0].content, [{ type: 'content', content: { type: 'text', text: 'late' } }], 'a result whose start was never seen is told with its words');
  told = fresh().next(record([result('x', { callId: 'z' }), result('y', { callId: 'z' })]));
  assert.deepEqual(told.map((update) => update.sessionUpdate), ['tool_call', 'tool_call_update'], 'a call announced by its result is known afterwards');
  {
    const mapper = fresh();
    mapper.next(record([start('c9')], { pendingCall: { callId: 'c9', phase: 'awaiting_approval' } }));
    const later = mapper.next({ eventCount: 2, events: [start('c9'), result(words('done'), { callId: 'c9' })], pendingCall: { callId: 'c9', phase: 'executing' } });
    assert.deepEqual(later.map((update) => update.status), ['completed'], 'a call that is done is not told as running again because the Hub has not cleared its pending call yet');
  }
  ok('the edges of a result: only true is an error, only text blocks are words, the limit of the text to the character, words that are JSON, an input that is a list, a call that starts twice, the call that waits, a tool_error without a status, a result without a start, and a finished call that the Hub still lists as pending');

  // the model, the record and the cursor
  assert.deepEqual(fresh().next(record([said('  keep my spaces  ')]))[0].content, { type: 'text', text: '  keep my spaces  ' }, 'the message of the model is sent as it is');
  {
    const mapper = createTurnMapper({ cwd: CWD, from: 5 });
    const told5 = mapper.next({ eventCount: 10, events: [7, 8, 9].map((n) => said(`m${n}`)) });
    assert.deepEqual(told5.map((update) => update.content.text), ['m7', 'm8', 'm9'], 'when the Hub has dropped some of the events that were not read yet, all the ones it kept are told');
    assert.equal(mapper.missed, 2);
    assert.equal(mapper.cursor, 10);
  }
  assert.deepEqual(fresh().next({ eventCount: 1, events: [said('a'), said('b'), said('c')] }).map((update) => update.content.text), ['a', 'b', 'c'], 'a count that is smaller than the list is not believed');
  for (const odd of [null, undefined, 'a task', 7, [1]]) assert.deepEqual(fresh().next(odd), [], `a record that is ${JSON.stringify(odd)} says nothing`);
  ok('the edges of the record: the message of the model as it is, events the Hub dropped in the middle of what was unread, a count smaller than the list, and records that are not objects');

  // the plan, the usage and the end
  assert.equal(fresh().next({ goalPlan: { version: 1, phases: [{ title: 't'.repeat(500), status: 'working' }] } })[0].entries[0].content.length, MAX_TITLE_CHARS, 'the title of a phase is bounded');
  const meter = (usage, capacityTokens = 1000) => ({ usage: { inputUsageMissing: 0, outputUsageMissing: 0, ...usage }, contextPolicy: { source: 'catalog', capacityTokens, approximate: false } });
  const marked = () => createTurnMapper({ cwd: CWD, usageMark: { requests: 1, input: 10, output: 5 } });
  assert.deepEqual(marked().next(meter({ httpRequests: 2, inputTokens: 40, outputTokens: '9' })), [], 'a count that is a string is not a count');
  assert.deepEqual(marked().next(meter({ httpRequests: 1, inputTokens: 40, outputTokens: 9 })), [], 'tokens that grew without a new response are not the use of one');
  assert.deepEqual(marked().next(meter({ httpRequests: 2, inputTokens: 10, outputTokens: 5 })), [], 'a response that used nothing says nothing');
  assert.deepEqual(marked().next(meter({ httpRequests: 2, inputTokens: 510, outputTokens: 500 }, 995)), [{ sessionUpdate: 'usage_update', used: 995, size: 995 }], 'a use that fills the window is told');
  assert.deepEqual(marked().next(meter({ httpRequests: 2, inputTokens: 510, outputTokens: 500 }, 994)), [], 'a use larger than the window is not');
  const closing = fresh();
  assert.equal(closing.finalText({ finalParts: { words: 'W', verificationNotice: 'V', hookNotice: 'H' } }), 'W\n\nV\n\nH', 'the parts of the end are told in order with a blank line between them');
  assert.equal(closing.finalText({ finalParts: { words: null, verificationNotice: null, hookNotice: 'only the hook' } }), 'only the hook', 'the notice of a hook is told');
  assert.equal(closing.finalText({ finalParts: { words: 'W', verificationNotice: '   ', hookNotice: null } }), 'W', 'a part of white space is no part');
  ok('the edges of the plan (a bounded title), of the usage (strings, tokens without a response, no use, the use that equals the window and the one that exceeds it) and of the end (all three parts, the hook alone)');
}

console.log(`PASS: ${checks} checks (kinds and titles of every tool of the Hub, the updates of a real record, reading a record again and again, approvals and failures, locations and bounds, the plan, the usage, the answer, and the edges the mutation work found)`);
