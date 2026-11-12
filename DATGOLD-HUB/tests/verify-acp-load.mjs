// session/load of the ACP agent (plan task ux-21), the pure parts: where the agent keeps which session is which task (lib/acp/session-store.mjs), and what a task the editor
// loads again is replayed as (lib/acp/replay.mjs).
//
//   A. The store: a file of its own in the state folder, written whole and atomically, read again for each look (another agent process may have written it), bounded, and
//      a file that cannot be read is an empty store and not an error.
//   B. The replay: the messages of the person and of the model in the order they were said, the calls of the task with their results, the plan; nothing said twice; and
//      where the next turn must start reading (the cursor) and counting the use of the context.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAX_STORED_SESSIONS, createMemoryStore, createSessionStore } from '../lib/acp/session-store.mjs';
import { replayUpdates } from '../lib/acp/replay.mjs';
import { ERROR_CODES } from '../lib/acp/rpc.mjs';
import { connect, eventually, scriptedHub } from './support/acp-scripted.mjs';

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-load-'));
const CWD = process.platform === 'win32' ? 'C:\\work\\project' : '/work/project';

try {
  // ---- A. the store ---------------------------------------------------------------------------------------------------------------------------------------------------------
  {
    const file = path.join(dir, 'state', 'acp-sessions.json');
    const store = createSessionStore({ file });
    assert.equal(await store.get('nobody'), null, 'a store without a file has no session');
    await store.put('s1', { taskId: 't1', cwd: CWD, workspacePath: CWD });
    assert.deepEqual(await store.get('s1'), { taskId: 't1', cwd: CWD, workspacePath: CWD }, 'what was put is what is read');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(raw.version, 1);
    assert.equal(raw.sessions.s1.taskId, 't1');
    assert.match(raw.sessions.s1.at, /^\d{4}-\d{2}-\d{2}T/, 'and when');
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['acp-sessions.json'], 'it is written whole: no temporary file is left');
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'only the owner can read it');
    const other = createSessionStore({ file });
    await other.put('s2', { taskId: 't2', cwd: CWD, workspacePath: CWD });
    assert.equal((await store.get('s2'))?.taskId, 't2', 'a store reads the file again: what another agent process wrote is seen');
    assert.equal((await store.get('s1'))?.taskId, 't1', 'and nothing it wrote is lost');
    await store.put('s1', { taskId: 't1b', cwd: CWD, workspacePath: CWD });
    assert.equal((await other.get('s1'))?.taskId, 't1b', 'a session that is put again is replaced');
    ok('the store of sessions is a file of the state folder, written whole, read again at each look, and a session put again is replaced');

    fs.writeFileSync(file, '{ not json');
    const logs = [];
    const broken = createSessionStore({ file, log: (line) => logs.push(line) });
    assert.equal(await broken.get('s1'), null, 'a file that cannot be read is an empty store');
    assert.ok(logs.some((line) => /could not read/i.test(line)), 'and that is logged');
    await broken.put('s3', { taskId: 't3', cwd: CWD, workspacePath: CWD });
    assert.equal((await broken.get('s3'))?.taskId, 't3', 'and the next put writes a good file');
    for (const odd of ['[]', 'null', '{"version":2,"sessions":{"x":{"taskId":"t","cwd":"c","workspacePath":"w"}}}', '{"version":1,"sessions":[]}', '{"version":1,"sessions":{"x":{"taskId":5}}}']) {
      fs.writeFileSync(file, odd);
      assert.equal(await broken.get('x'), null, `a file that holds ${odd} has no session x`);
    }
    ok('a file that is not what the store writes (not JSON, another version, a wrong shape, an entry without a task) is an empty store and is logged, never an error');

    fs.rmSync(file);
    const full = createSessionStore({ file });
    for (let i = 0; i < MAX_STORED_SESSIONS + 5; i += 1) await full.put(`s${i}`, { taskId: `t${i}`, cwd: CWD, workspacePath: CWD });
    const kept = Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).sessions);
    assert.equal(kept.length, MAX_STORED_SESSIONS, `at most ${MAX_STORED_SESSIONS} sessions are kept`);
    assert.equal(await full.get('s0'), null, 'the oldest go first');
    assert.equal((await full.get(`s${MAX_STORED_SESSIONS + 4}`))?.taskId, `t${MAX_STORED_SESSIONS + 4}`);
    ok(`the store keeps the ${MAX_STORED_SESSIONS} most recent sessions`);

    const memory = createMemoryStore();
    assert.equal(await memory.get('a'), null);
    await memory.put('a', { taskId: 'ta', cwd: CWD, workspacePath: CWD });
    assert.equal((await memory.get('a')).taskId, 'ta');
    for (let i = 0; i < MAX_STORED_SESSIONS + 3; i += 1) await memory.put(`m${i}`, { taskId: `t${i}`, cwd: CWD, workspacePath: CWD });
    assert.equal(await memory.get('m0'), null, 'the store in memory keeps the most recent too');
    assert.equal((await memory.get(`m${MAX_STORED_SESSIONS + 2}`)).taskId, `t${MAX_STORED_SESSIONS + 2}`);
    assert.equal(MAX_STORED_SESSIONS, 256);
    const leaky = createSessionStore({ file: path.join(dir, 'leaky', 'acp-sessions.json') });
    await leaky.put('s', { taskId: 't', cwd: CWD, workspacePath: CWD, prompt: 'SECRET-PROMPT-TEXT', secret: 'b3a1' });
    const leakyText = fs.readFileSync(path.join(dir, 'leaky', 'acp-sessions.json'), 'utf8');
    assert.ok(!leakyText.includes('SECRET-PROMPT-TEXT') && !leakyText.includes('b3a1'), 'the store keeps the task and the folders only, whatever else it is given');
    ok('a store in memory keeps the same shape and the same limit of 256; the file keeps the task and the folders only');
  }

  // ---- B. the replay ------------------------------------------------------------------------------------------------------------------------------------------------------
  {
    const task = {
      id: 't1', state: 'completed', eventCount: 6,
      dialogue: [
        { role: 'user', at: '2026-11-12T10:00:00.000Z', text: 'Fix the bug', run: 1 },
        { role: 'assistant', at: '2026-11-12T10:00:05.000Z', text: 'Fixed it.', run: 1 },
        { role: 'user', at: '2026-11-12T10:01:00.000Z', text: 'Add a test', run: 2 },
        { role: 'assistant', at: '2026-11-12T10:01:09.000Z', text: 'Added a test.\n\n[Verification notice] Nothing was run.', run: 2 },
      ],
      events: [
        { at: '2026-11-12T10:00:01.000Z', type: 'tool_start', callId: 'c1', toolName: 'local.read_file', input: { path: 'calc.js' } },
        { at: '2026-11-12T10:00:02.000Z', type: 'tool_result', callId: 'c1', toolName: 'local.read_file', status: 'completed', message: JSON.stringify({ content: [{ type: 'text', text: 'function add() {}' }] }) },
        { at: '2026-11-12T10:00:04.000Z', type: 'assistant', message: 'Fixed it.' },
        { at: '2026-11-12T10:01:02.000Z', type: 'tool_start', callId: 'c2', toolName: 'local.write_file', input: { path: 'calc.test.js' } },
        { at: '2026-11-12T10:01:03.000Z', type: 'tool_error', callId: 'c2', toolName: 'local.write_file', status: 'error', message: 'Permission denied' },
        { at: '2026-11-12T10:01:08.000Z', type: 'assistant', message: 'Added a test.' },
      ],
      goalPlan: { version: 1, phases: [{ title: 'Inspect', status: 'has_evidence' }, { title: 'Edit', status: 'working' }] },
      usage: { httpRequests: 4, inputTokens: 900, outputTokens: 120, inputUsageMissing: 0, outputUsageMissing: 0 },
      contextPolicy: { source: 'catalog', capacityTokens: 100_000, approximate: false },
    };
    const replay = replayUpdates(task, { cwd: CWD });
    const kinds = replay.updates.map((update) => [update.sessionUpdate, update.toolCallId ?? update.content?.text ?? update.status ?? '']);
    assert.deepEqual(kinds, [
      ['user_message_chunk', 'Fix the bug'],
      ['tool_call', 'c1'],
      ['tool_call_update', 'c1'],
      ['agent_message_chunk', 'Fixed it.'],
      ['user_message_chunk', 'Add a test'],
      ['tool_call', 'c2'],
      ['tool_call_update', 'c2'],
      ['agent_message_chunk', 'Added a test.'],
      ['agent_message_chunk', '[Verification notice] Nothing was run.'],
      ['plan', ''],
    ], 'the person and the model in the order they spoke, the calls with their results, an answer told once, and the plan at the end');
    assert.equal(replay.updates[6].status, 'failed', 'a refused call is replayed as failed');
    assert.ok(!replay.updates.some((update) => update.sessionUpdate === 'usage_update'), 'the use of the context is not replayed: it was the size at a moment that has passed');
    assert.equal(replay.cursor, 6, 'the next turn starts after the events that were replayed');
    assert.deepEqual(replay.usageMark, { requests: 4, input: 900, output: 120 }, 'and counts the use of the context from where the task stands');
    ok('a task is replayed as what was said and done in order: the messages of the person, the calls and their results (a refused one failed), the messages of the model, an answer only for what no message said, the plan; not the use of the context; the next turn starts after it');

    const bare = replayUpdates({ id: 't2', state: 'completed' }, { cwd: CWD });
    assert.deepEqual(bare, { updates: [], cursor: 0, usageMark: null }, 'a task with no record replays nothing');
    const dropped = replayUpdates({ id: 't3', eventCount: 40, events: [{ at: '2026-11-12T10:00:00.000Z', type: 'assistant', message: 'late' }], dialogue: [] }, { cwd: CWD });
    assert.equal(dropped.cursor, 40, 'when the Hub has dropped older events the next turn still starts after all of them');
    const odd = replayUpdates({ dialogue: [null, { role: 'system', text: 'x' }, { role: 'user', text: '   ' }, { role: 'user', text: 'kept' }], events: 'no', usage: { httpRequests: 'x' } }, { cwd: CWD });
    assert.deepEqual(odd.updates.map((update) => update.content?.text), ['kept'], 'entries that are not messages of the person or the model, and empty ones, are left out');
    assert.equal(odd.usageMark, null);
    assert.deepEqual(replayUpdates(null, { cwd: CWD }), { updates: [], cursor: 0, usageMark: null }, 'a record that is not an object replays nothing');
    ok('a task without a record, one that dropped its oldest events, and entries that are not messages are replayed without an error');
  }
  // ---- C. the agent: session/load on a Hub that is a script ---------------------------------------------------------------------------------------------------------------
  {
    const say = (text) => [{ type: 'text', text }];
    const project = fs.mkdtempSync(path.join(dir, 'project-'));
    const store = createMemoryStore();
    const hub = scriptedHub();
    const c = connect({ hub, options: { store } });
    assert.equal((await c.initialize()).result.agentCapabilities.loadSession, true, 'the agent says it can load a session');
    const sessionId = (await c.request('session/new', { cwd: project, mcpServers: [] })).result.sessionId;
    const first = c.requestLater('session/prompt', { sessionId, prompt: say('Fix the bug') });
    await eventually(() => hub.of('startTask').length === 1, 'the task is started');
    const taskId = [...hub.tasks.keys()][0];
    await eventually(async () => (await store.get(sessionId))?.taskId === taskId, 'the session and its task are kept as soon as the task exists');
    Object.assign(hub.tasks.get(taskId), {
      dialogue: [{ role: 'user', at: '2026-11-12T10:00:00.000Z', text: 'Fix the bug', run: 1 }, { role: 'assistant', at: '2026-11-12T10:00:05.000Z', text: 'Fixed it.', run: 1 }],
      events: [
        { at: '2026-11-12T10:00:01.000Z', type: 'tool_start', callId: 'c1', toolName: 'local.read_file', input: { path: 'calc.js' } },
        { at: '2026-11-12T10:00:02.000Z', type: 'tool_result', callId: 'c1', toolName: 'local.read_file', status: 'completed', message: 'function add() {}' },
        { at: '2026-11-12T10:00:04.000Z', type: 'assistant', message: 'Fixed it.' },
      ],
      eventCount: 3,
    });
    hub.finish(taskId, { state: 'completed', status: 'completed', finalText: 'Fixed it.', finalParts: { words: 'Fixed it.', verificationNotice: null, hookNotice: null } });
    await first.answer();

    // The editor starts the agent again (a new connection, the same store) and loads the session.
    const d = connect({ hub, options: { store } });
    await d.initialize();
    const registeredBefore = hub.of('ensureWorkspace').length;
    const loaded = d.requestLater('session/load', { sessionId, cwd: project, mcpServers: [] });
    assert.deepEqual((await loaded.answer()).result, {}, 'the load answers with an empty result');
    const replayed = d.updates(sessionId);
    assert.deepEqual(replayed.map((update) => update.sessionUpdate), ['user_message_chunk', 'tool_call', 'tool_call_update', 'agent_message_chunk'], 'the conversation is replayed: the person, the call and its result, the model');
    const order = d.messages().filter((m) => m.method === 'session/update' || m.id === loaded.id).map((m) => (m.method ? 'update' : 'RESPONSE'));
    assert.equal(order.at(-1), 'RESPONSE', 'every replayed update comes before the answer to the load');
    assert.ok(hub.of('ensureWorkspace').length === registeredBefore + 1 && hub.of('ensureWorkspace').at(-1)[1] === project, 'the folder is put in the list of workspaces again (never selected)');
    const next = d.requestLater('session/prompt', { sessionId, prompt: say('Now add a test') });
    await eventually(() => hub.of('continueTask').length === 1, 'the next prompt continues the task of the session');
    assert.equal(hub.of('continueTask')[0][1].id, taskId);
    Object.assign(hub.tasks.get(taskId), { events: [...hub.tasks.get(taskId).events, { at: '2026-11-12T10:01:00.000Z', type: 'assistant', message: 'Added a test.' }], eventCount: 4 });
    hub.finish(taskId, { state: 'completed', status: 'completed', finalText: 'Added a test.', finalParts: { words: 'Added a test.', verificationNotice: null, hookNotice: null } });
    await next.answer();
    assert.deepEqual(d.updates(sessionId).slice(replayed.length).map((update) => update.content?.text), ['Added a test.'], 'and tells only what is new, not the replayed record again');
    ok('a session is kept with its task, and loaded on a new connection: the conversation is replayed before the answer, the folder is registered again, and the next prompt continues the same task and tells only what is new');

    // What cannot be loaded.
    const e = connect({ hub, options: { store } });
    await e.initialize();
    const unknown = await e.request('session/load', { sessionId: 'never-made', cwd: project, mcpServers: [] });
    assert.ok(unknown.error?.code === ERROR_CODES.NOT_FOUND && /not known/i.test(unknown.error.message), `an unknown session is not found: ${JSON.stringify(unknown.error)}`);
    const otherFolder = fs.mkdtempSync(path.join(dir, 'other-'));
    const moved = await e.request('session/load', { sessionId, cwd: otherFolder, mcpServers: [] });
    assert.ok(moved.error?.code === ERROR_CODES.INVALID_PARAMS && /another folder/i.test(moved.error.message), `a session of another folder is refused: ${JSON.stringify(moved.error)}`);
    const goneFolder = path.join(dir, 'gone');
    await store.put('in-a-gone-folder', { taskId, cwd: goneFolder, workspacePath: goneFolder });
    const missing = await e.request('session/load', { sessionId: 'in-a-gone-folder', cwd: goneFolder, mcpServers: [] });
    assert.ok(missing.error?.code === ERROR_CODES.INVALID_PARAMS && /does not exist/.test(missing.error.message), 'a folder that does not exist is refused, also for a session made there');
    if (process.platform === 'win32') {
      const upper = connect({ hub, options: { store } });
      await upper.initialize();
      assert.ok((await upper.request('session/load', { sessionId, cwd: project.toUpperCase(), mcpServers: [] })).result, 'on Windows the same folder written in other case is the same folder');
    }
    assert.ok((await e.request('session/load', { sessionId, cwd: project })).result, 'mcpServers may be left out');
    const twice = await e.request('session/load', { sessionId, cwd: project, mcpServers: [] });
    assert.ok(twice.error?.code === ERROR_CODES.INVALID_REQUEST && /already open/i.test(twice.error.message), 'a session that is open on this connection is not loaded again');
    const lostStore = createMemoryStore();
    await lostStore.put('lost', { taskId: 'no-such-task', cwd: project, workspacePath: project });
    const f = connect({ hub, options: { store: lostStore } });
    await f.initialize();
    const lost = await f.request('session/load', { sessionId: 'lost', cwd: project, mcpServers: [] });
    assert.ok(lost.error?.code === ERROR_CODES.NOT_FOUND && /no longer has/i.test(lost.error.message), `a task the Hub no longer has is said to be gone: ${JSON.stringify(lost.error)}`);
    for (const bad of [null, {}, { sessionId: '', cwd: project }, { sessionId: 'x', cwd: 'relative' }, { sessionId: 'x'.repeat(300), cwd: project }]) {
      assert.equal((await f.request('session/load', bad)).error?.code, ERROR_CODES.INVALID_PARAMS, `params ${JSON.stringify(bad)?.slice(0, 40)} are refused`);
    }
    ok('what cannot be loaded is refused with a sentence: an unknown session, another folder, a folder that does not exist, a session already open, a task the Hub no longer has, parameters that do not fit');

    // The MCP servers an editor passes are not started: the person is told, on session/new and on session/load.
    const g = connect({ hub, options: { store } });
    await g.initialize();
    const withServers = (await g.request('session/new', { cwd: project, mcpServers: [{ name: 'fs', command: 'mcp-fs', args: [], env: [] }, { name: 'web', type: 'http', url: 'https://x', headers: [] }] })).result.sessionId;
    await eventually(() => g.updates(withServers).some((update) => /MCP servers/i.test(JSON.stringify(update))), 'the person is told about the MCP servers');
    assert.match(JSON.stringify(g.updates(withServers)), /2 MCP servers.*not started/i, 'with how many and that they were not started');
    const without = (await g.request('session/new', { cwd: project, mcpServers: [] })).result.sessionId;
    assert.equal(g.updates(without).length, 0, 'no word when there are none');
    const h = connect({ hub, options: { store } });
    await h.initialize();
    await h.request('session/load', { sessionId, cwd: project, mcpServers: [{ name: 'fs', command: 'mcp-fs', args: [], env: [] }] });
    assert.match(JSON.stringify(h.updates(sessionId)), /passed 1 MCP server \(fs\).*not started/i, 'and on session/load');
    ok('the MCP servers the editor passes are not started, and the person is told how many, on session/new and on session/load; nothing is said when there are none');
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`PASS: ${checks} checks (the store of sessions, the replay of a task)`);
