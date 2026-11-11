// What the editor is told during a turn, and the approvals it answers (plan task ux-20), on a Hub that is a script. The pure parts are in verify-acp-events.mjs and verify-acp-permissions.mjs; this suite
// is the agent that reads the record of the task again and again and speaks to the editor.
//
//   A. Updates while the task runs: tool calls and their results, the messages of the model, the answer at the end (not twice), a task that is continued, the plan and the use of the context.
//   B. An approval: asked of the editor with the change the Hub worked out, once; allow, reject, cancel, an answer that cannot be read, an editor that cannot be asked; answered elsewhere; another task's.
//   C. A cancel while an approval waits; a Hub that fails while the approvals are looked at.
//   D. What leaves: a key in a command, in a path and in a planned change is masked in the updates and in the request; the source has one place to send and one to ask.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAKE_BEARER, FAKE_KEY, connect, eventually, scriptedHub, sleep } from './support/acp-scripted.mjs';

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
const here = path.dirname(fileURLToPath(import.meta.url));
const real = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'acp-approval-request.json'), 'utf8')).request;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-turn-'));
const say = (text) => [{ type: 'text', text }];
const event = (type, extra = {}) => ({ at: 't', type, message: '', state: 'running', ...extra });
const toolStart = (callId, toolName, input) => event('tool_start', { callId, toolName, input, status: 'running' });
const toolResult = (callId, toolName, words, isError = false) => event('tool_result', { callId, toolName, status: 'completed', message: JSON.stringify({ isError, content: [{ type: 'text', text: words }] }) });
const assistant = (message) => event('assistant', { message });
/** Adds events to the record of a task, as the Hub does while it runs. */
const grow = (c, id, events, extra = {}) => {
  const task = c.hub.tasks.get(id);
  const all = [...(task.events ?? []), ...events];
  Object.assign(task, { events: all, eventCount: all.length, ...extra });
};
const waitingFor = (callId, toolName = 'local.write_file') => ({ state: 'waiting_approval', pendingCall: { callId, toolName, phase: 'awaiting_approval' } });
const request = (taskId, extra = {}) => ({ ...structuredClone(real), taskId, expiresAt: new Date(Date.now() + 600_000).toISOString(), ...extra });
const done = (c, id, words = 'Done.') => c.hub.finish(id, { state: 'completed', status: 'completed', finalText: words, finalParts: { words, verificationNotice: null, hookNotice: null }, pendingCall: null });

/** A session, and a prompt that has reached the Hub. */
async function begin({ options = {}, hub = scriptedHub() } = {}) {
  const c = connect({ hub, options });
  await c.initialize();
  const sessionId = (await c.request('session/new', { cwd: dir, mcpServers: [] })).result.sessionId;
  const prompt = (text = 'go') => c.requestLater('session/prompt', { sessionId, prompt: say(text) });
  const first = prompt();
  await eventually(() => c.hub.of('startTask').length === 1, 'the task is started');
  const taskId = [...c.hub.tasks.keys()][0];
  return { c, sessionId, first, taskId, prompt };
}
const allow = { outcome: { outcome: 'selected', optionId: 'allow_once' } };

try {
  // ---- A. updates while the task runs -----------------------------------------------------------------------------------------------------------------------------------
  {
    const { c, sessionId, first, taskId } = await begin();
    grow(c, taskId, [toolStart('c1', 'local.read_file', { path: 'calc.js' })]);
    await eventually(() => c.updates(sessionId).length === 1, 'the call is announced while the task runs');
    assert.deepEqual(c.updates(sessionId)[0], { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'Read calc.js', kind: 'read', status: 'in_progress', locations: [{ path: path.join(dir, 'calc.js') }], rawInput: { path: 'calc.js' } });
    assert.equal(c.messages().some((m) => m.id === first.id), false, 'the turn goes on');
    grow(c, taskId, [toolResult('c1', 'local.read_file', 'function add(a, b) {}'), assistant('All done.')]);
    done(c, taskId, 'All done.');
    assert.deepEqual((await first.answer()).result, { stopReason: 'end_turn' });
    const updates = c.updates(sessionId);
    assert.deepEqual(updates.map((u) => u.sessionUpdate), ['tool_call', 'tool_call_update', 'agent_message_chunk'], 'the answer was said as a message of the model: it is not said again at the end');
    assert.equal(updates[1].content[0].content.text, 'function add(a, b) {}');
    const order = c.messages().map((m) => (m.method === 'session/update' ? 'update' : m.id === first.id ? 'RESPONSE' : '?'));
    assert.equal(order.at(-1), 'RESPONSE', 'every update comes before the response that ends the turn');
    ok('while a task runs the editor is told of its calls and of the messages of the model, as they appear in the record; the answer at the end is not said a second time; every update comes before the response');
  }
  {
    const { c, sessionId, first, taskId, prompt } = await begin();
    grow(c, taskId, [toolStart('c1', 'local.read_file', { path: 'a.js' }), toolResult('c1', 'local.read_file', 'one'), assistant('First answer.')]);
    done(c, taskId, 'First answer.');
    await first.answer();
    const afterFirst = c.updates(sessionId).length;
    assert.equal(afterFirst, 3);
    const second = prompt('and now?');
    await eventually(() => c.hub.of('continueTask').length === 1, 'continued');
    grow(c, taskId, [toolStart('c2', 'local.edit_file', { path: 'b.js' }), toolResult('c2', 'local.edit_file', 'edited'), assistant('Second answer.')]);
    done(c, taskId, 'Second answer.');
    await second.answer();
    const later = c.updates(sessionId).slice(afterFirst);
    assert.deepEqual(later.map((u) => [u.sessionUpdate, u.toolCallId ?? u.content?.text]), [['tool_call', 'c2'], ['tool_call_update', 'c2'], ['agent_message_chunk', 'Second answer.']], 'the second turn says only what is new in the record');
    ok('a task that is continued: the second turn tells the editor of the new calls and messages only, not of the first turn again');
  }
  {
    const { c, sessionId, first, taskId } = await begin();
    c.hub.tasks.get(taskId).goalPlan = { version: 1, phases: [{ id: 'inspect', title: 'Inspect', status: 'working' }, { id: 'edit', title: 'Edit', status: 'todo' }] };
    c.hub.tasks.get(taskId).contextPolicy = { source: 'catalog', capacityTokens: 100_000, approximate: false };
    c.hub.tasks.get(taskId).usage = { inputTokens: 900, outputTokens: 100, httpRequests: 1, inputUsageMissing: 0, outputUsageMissing: 0 };
    await eventually(() => c.updates(sessionId).length === 2, 'the plan and the use of the context are said');
    assert.deepEqual(c.updates(sessionId).map((u) => u.sessionUpdate).sort(), ['plan', 'usage_update']);
    assert.deepEqual(c.updates(sessionId).find((u) => u.sessionUpdate === 'usage_update'), { sessionUpdate: 'usage_update', used: 1000, size: 100_000 });
    done(c, taskId, '');
    await first.answer();
    assert.equal(c.updates(sessionId).length, 2, 'an empty answer is no message');
    ok('the plan of the Hub and the use of the context, when the record has them, are said once');
  }

  // ---- B. an approval ---------------------------------------------------------------------------------------------------------------------------------------------------
  {
    const { c, sessionId, first, taskId } = await begin();
    grow(c, taskId, [toolStart('c1', 'local.write_file', { path: 'out.txt' })], waitingFor('c1'));
    c.hub.pending.push(request(taskId));
    const [ask] = await eventually(() => { const list = c.asked('session/request_permission'); return list.length ? list : null; }, 'the editor is asked');
    assert.equal(ask.params.sessionId, sessionId);
    assert.equal(ask.params.toolCall.toolCallId, 'c1', 'it is the call the editor was told of');
    assert.equal(ask.params.toolCall.title, 'Write out.txt');
    assert.deepEqual(ask.params.toolCall.content, [{ type: 'diff', path: path.join(dir, 'out.txt'), oldText: null, newText: 'from probe\n' }], 'with the change the Hub worked out');
    assert.deepEqual(ask.params.options.map((o) => o.optionId), ['allow_once', 'reject_once']);
    assert.equal(c.updates(sessionId)[0].status, 'pending', 'the call was announced as one that waits');
    await sleep(60);
    assert.equal(c.asked('session/request_permission').length, 1, 'asked once, however often the record is read');
    assert.equal(c.hub.decisions.length, 0, 'nothing is decided until the editor answers');
    c.respond(ask.id, allow);
    await eventually(() => c.hub.decisions.length === 1, 'the answer reaches the Hub');
    assert.deepEqual(c.hub.decisions[0], { id: real.id, approved: true });
    grow(c, taskId, [toolResult('c1', 'local.write_file', 'Created out.txt')], { state: 'running', pendingCall: null });
    done(c, taskId, 'Written.');
    assert.deepEqual((await first.answer()).result, { stopReason: 'end_turn' });
    assert.ok(!c.updates(sessionId).some((u) => /could not be asked/i.test(JSON.stringify(u))), 'an editor that answered is not told that it could not be asked');
    ok('an approval is asked of the editor once, with the call it concerns, the change the Hub worked out and two options; "allow" reaches the Hub as approved');
  }
  for (const [name, answer, why] of [
    ['reject', { outcome: { outcome: 'selected', optionId: 'reject_once' } }, 'rejected'],
    ['cancelled', { outcome: { outcome: 'cancelled' } }, 'cancelled'],
    ['an option nobody offered', { outcome: { outcome: 'selected', optionId: 'allow_always' } }, 'unreadable'],
    ['nothing that can be read', { surprise: true }, 'unreadable'],
    ['an empty result', {}, 'unreadable'],
  ]) {
    const { c, first, taskId } = await begin();
    grow(c, taskId, [toolStart('c1', 'local.write_file', { path: 'out.txt' })], waitingFor('c1'));
    c.hub.pending.push(request(taskId));
    const [ask] = await eventually(() => { const list = c.asked('session/request_permission'); return list.length ? list : null; }, 'asked');
    c.respond(ask.id, answer);
    await eventually(() => c.hub.decisions.length === 1, `${name}: the Hub is told`);
    assert.deepEqual(c.hub.decisions[0], { id: real.id, approved: false }, name);
    assert.ok(c.logs.some((line) => line.includes(`approval ${real.id}`) && line.includes(why)), `${name} is logged as ${why}: ${c.logs.join(' | ').slice(0, 300)}`);
    grow(c, taskId, [toolResult('c1', 'local.write_file', 'The owner refused.', true)], { state: 'running', pendingCall: null });
    done(c, taskId, 'Not written.');
    await first.answer();
  }
  ok('a rejection, a cancellation, an option nobody offered and answers that cannot be read each reach the Hub as a refusal, and the turn goes on');
  {
    const { c, sessionId, first, taskId } = await begin();
    grow(c, taskId, [toolStart('c1', 'local.write_file', { path: 'out.txt' })], waitingFor('c1'));
    c.hub.pending.push(request(taskId));
    const [ask] = await eventually(() => { const list = c.asked('session/request_permission'); return list.length ? list : null; }, 'asked');
    c.respondError(ask.id, -32601, 'Method not found');
    await eventually(() => c.hub.decisions.length === 1, 'an editor that cannot be asked refuses the call');
    assert.deepEqual(c.hub.decisions[0], { id: real.id, approved: false });
    await eventually(() => c.updates(sessionId).some((u) => u.sessionUpdate === 'agent_message_chunk' && /could not be asked/i.test(u.content.text)), 'and the person is told');
    done(c, taskId, 'Done.');
    await first.answer();
    ok('an editor that answers the request with an error cannot be asked: the call is refused and the person is told that it was');
  }
  {
    const { c, first, taskId } = await begin();
    grow(c, taskId, [toolStart('c1', 'local.write_file', { path: 'out.txt' })], waitingFor('c1'));
    c.hub.pending.push(request(taskId));
    const [ask] = await eventually(() => { const list = c.asked('session/request_permission'); return list.length ? list : null; }, 'asked');
    c.hub.pending.length = 0; // somebody answered in the desktop app
    grow(c, taskId, [toolResult('c1', 'local.write_file', 'Created out.txt')], { state: 'running', pendingCall: null });
    c.respond(ask.id, allow);
    await eventually(() => c.hub.calls.some(([name]) => name === 'decide'), 'the late answer is sent');
    assert.deepEqual(c.hub.decisions, [], 'the Hub no longer had the request: nothing was decided twice');
    done(c, taskId, 'Done.');
    assert.deepEqual((await first.answer()).result, { stopReason: 'end_turn' });
    ok('an approval that was answered in the desktop app meanwhile: the late answer of the editor finds nothing to decide and harms nothing');
  }
  {
    const { c, first, taskId } = await begin();
    grow(c, taskId, [toolStart('c1', 'local.write_file', { path: 'out.txt' })], waitingFor('c1'));
    c.hub.pending.push(request('11111111-1111-4111-8111-111111111111', { id: 'someone-elses' }), request(taskId));
    await eventually(() => c.asked('session/request_permission').length >= 1, 'asked');
    await sleep(40);
    assert.equal(c.asked('session/request_permission').length, 1, 'only the request of the task of the turn is asked');
    assert.equal(c.asked('session/request_permission')[0].params.toolCall.toolCallId, 'c1');
    assert.ok(c.hub.of('pendingApprovals').every(([, id]) => id === taskId), 'the Hub is asked about this task only');
    c.respond(c.asked('session/request_permission')[0].id, allow);
    await eventually(() => c.hub.decisions.length === 1, 'decided');
    assert.equal(c.hub.pending.length, 1, 'the request of the other task is untouched');
    done(c, taskId, 'Done.');
    await first.answer();
    ok('only the approval requests of the task of the turn are asked and answered: the owner\'s other tasks in the same Hub are never touched');
  }

  // ---- C. a cancel, a Hub that fails ---------------------------------------------------------------------------------------------------------------------------------------
  {
    const { c, sessionId, first, taskId } = await begin();
    grow(c, taskId, [toolStart('c1', 'local.write_file', { path: 'out.txt' })], waitingFor('c1'));
    c.hub.pending.push(request(taskId));
    const [ask] = await eventually(() => { const list = c.asked('session/request_permission'); return list.length ? list : null; }, 'asked');
    c.notify('session/cancel', { sessionId });
    assert.deepEqual((await first.answer()).result, { stopReason: 'cancelled' }, 'the turn ends when the Hub has stopped the task');
    assert.equal(c.hub.pending.length, 0, 'the Hub dropped the request with the task');
    await eventually(() => c.hub.of('decide').length === 1, 'the request that waited is answered as refused the moment the turn is cancelled, without waiting for the editor');
    assert.deepEqual(c.hub.of('decide')[0], ['decide', real.id, false]);
    assert.ok(!c.updates(sessionId).some((u) => /could not be asked/i.test(JSON.stringify(u))), 'and the person is not told that the editor could not be asked: it was a cancel');
    c.respond(ask.id, { outcome: { outcome: 'cancelled' } });
    await eventually(() => c.hub.calls.some(([name]) => name === 'decide'), 'the editor answers "cancelled" to the request it was asked');
    assert.deepEqual(c.hub.decisions, [], 'which finds nothing to decide');
    ok('a cancel while an approval waits: the task stops, the turn answers "cancelled", and the answer of the editor to the request it was asked harms nothing');
  }
  {
    const { c, first, taskId } = await begin();
    grow(c, taskId, [toolStart('c1', 'local.write_file', { path: 'out.txt' })], waitingFor('c1'));
    c.hub.pending.push(request(taskId));
    c.hub.failOn.set('pendingApprovals', Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' }));
    await sleep(400); // longer than the time a Hub that does not answer is waited for in this test (120 ms): this is not that
    assert.equal(c.asked('session/request_permission').length, 0, 'while the Hub cannot say what waits, nothing is asked');
    assert.equal(c.messages().some((m) => m.id === first.id), false, 'and the turn goes on: the Hub answers about the task, so contact is not lost');
    assert.ok(c.logs.some((line) => line.includes('could not tell the editor what the task did') && line.includes('fetch failed')), 'and the failure is logged');
    c.hub.failOn.delete('pendingApprovals');
    const [ask] = await eventually(() => { const list = c.asked('session/request_permission'); return list.length ? list : null; }, 'asked once the Hub answers');
    c.respond(ask.id, allow);
    await eventually(() => c.hub.decisions.length === 1, 'decided');
    done(c, taskId, 'Done.');
    await first.answer();
    ok('a Hub that fails when the approvals are looked at is looked at again: the turn does not end and nothing is asked in the meantime');
  }

  // ---- D. what leaves ---------------------------------------------------------------------------------------------------------------------------------------------------
  {
    const { c, sessionId, first, taskId } = await begin();
    const secretCommand = `curl -H "Authorization: Bearer ${FAKE_KEY}" https://api.example.com --password hunter2hunter2 -u admin:${FAKE_BEARER}`;
    grow(c, taskId, [toolStart('c1', 'local.run_command', { command: secretCommand }), toolResult('c1', 'local.run_command', `token=${FAKE_KEY}\nAPI_KEY=${FAKE_KEY}\nfine`)], {});
    await eventually(() => c.updates(sessionId).length === 2, 'the call and its result are said');
    const keyedRequest = request(taskId, {
      toolName: 'local.edit_file',
      detail: { kind: 'edit', path: 'cfg.js', preview: { files: [{ path: 'cfg.js', action: 'edit', hunks: [{ rows: [{ kind: 'removed', text: 'const a = 1;\n' }, { kind: 'added', text: `const API_KEY = "${FAKE_KEY}";\n` }] }], additions: 1, deletions: 1 }], fileCount: 1, hiddenFiles: 0, truncated: false } },
    });
    grow(c, taskId, [toolStart('c2', 'local.edit_file', { path: 'cfg.js' })], waitingFor('c2', 'local.edit_file'));
    c.hub.pending.push(keyedRequest);
    const [ask] = await eventually(() => { const list = c.asked('session/request_permission'); return list.length ? list : null; }, 'asked');
    c.respond(ask.id, allow);
    await eventually(() => c.hub.decisions.length === 1, 'decided');
    done(c, taskId, `The key is ${FAKE_KEY}.`);
    await first.answer();
    const everything = c.raw() + c.logs.join('\n');
    for (const secret of [FAKE_KEY, FAKE_BEARER, 'hunter2hunter2']) assert.ok(!everything.includes(secret), `${secret.slice(0, 8)}... is nowhere in what the agent said or logged`);
    assert.ok(everything.includes('[REDACTED]'), 'and it was masked, not dropped');
    const call = c.updates(sessionId)[0];
    assert.ok(call.title.startsWith('Run curl') && !call.title.includes(FAKE_KEY), 'the title of a call is masked');
    assert.ok(!JSON.stringify(ask.params).includes(FAKE_KEY), 'the planned change that is asked about is masked');
    assert.ok(JSON.stringify(ask.params).includes('API_KEY'), 'the name of the setting stays: the person sees what changes');
    ok('a key in a command, in the output of a call, in a planned change and in the answer is masked in every update, in the request to the editor and in the log (the bearer of the Hub too)');
  }
  {
    const source = fs.readFileSync(path.join(here, '..', 'lib', 'acp', 'agent.mjs'), 'utf8');
    const lines = source.split('\n').filter((line) => !line.trim().startsWith('//'));
    assert.equal(lines.filter((line) => /peer\.notify\(/.test(line)).length, 1, 'one place sends');
    assert.equal(lines.filter((line) => /peer\.request\(/.test(line)).length, 1, 'one place asks');
    assert.ok(!/safePreview/.test(source));
    const outbound = source.slice(source.indexOf('const outbound = {'), source.indexOf('};', source.indexOf('const outbound = {')));
    assert.ok(/peer\.notify\(method, masker\.value\(params\)\)/.test(outbound) && /peer\.request\(method, masker\.value\(params\)/.test(outbound), 'and both mask the decoded value first');
    ok('in the source of the agent a message can leave in one place and a request in one place, and both mask the decoded value first; safePreview is not used');
  }

  // ---- E. the edges that the mutation work found (tests/mutation/acp-turn.json) ---------------------------------------------------------------------------------------------
  {
    // The Hub is asked what waits when its state says the task waits, or its pending call does, and not otherwise.
    for (const [name, patch] of [['its state', { state: 'waiting_approval', pendingCall: null }], ['its pending call', { state: 'running', pendingCall: { callId: 'c1', toolName: 'local.write_file', phase: 'awaiting_approval' } }]]) {
      const { c, first, taskId } = await begin();
      grow(c, taskId, [toolStart('c1', 'local.write_file', { path: 'out.txt' })], patch);
      c.hub.pending.push(request(taskId));
      const [ask] = await eventually(() => { const list = c.asked('session/request_permission'); return list.length ? list : null; }, `asked when ${name} says the task waits`);
      c.respond(ask.id, allow);
      await eventually(() => c.hub.decisions.length === 1, `${name}: decided`);
      done(c, taskId, 'Done.');
      await first.answer();
    }
    {
      const { c, first, taskId } = await begin();
      c.hub.pending.push(request(taskId));
      await sleep(80);
      assert.equal(c.hub.of('pendingApprovals').length, 0, 'a task that does not wait is not looked at for approvals');
      assert.equal(c.asked('session/request_permission').length, 0);
      c.hub.pending.length = 0;
      done(c, taskId, 'Done.');
      await first.answer();
    }
    {
      const { c, first, taskId } = await begin();
      grow(c, taskId, [toolStart('c1', 'local.write_file', { path: 'out.txt' })], waitingFor('c1'));
      c.hub.pending.push({ taskId, toolName: 'local.write_file', detail: {} }, request(taskId, { id: 7 }));
      await sleep(80);
      assert.equal(c.asked('session/request_permission').length, 0, 'a request without a text id is not put to the person');
      c.hub.pending.length = 0;
      done(c, taskId, 'Done.');
      await first.answer();
    }
    ok('the Hub is asked what waits when its state says so or its pending call does, and never for a task that does not wait; a request without a text id is not put to the person');
  }
  {
    // The time the editor is given: a request about to expire still gets a second, and an editor that does not answer in time is refused and the person is told.
    const { c, sessionId, first, taskId } = await begin();
    grow(c, taskId, [toolStart('c1', 'local.write_file', { path: 'out.txt' })], waitingFor('c1'));
    c.hub.pending.push(request(taskId, { expiresAt: new Date(Date.now() + 200).toISOString() }));
    await eventually(() => c.asked('session/request_permission').length === 1, 'asked');
    await sleep(500);
    assert.equal(c.hub.of('decide').length, 0, 'a request that is about to expire is still put to the person for a second');
    await eventually(() => c.hub.of('decide').length === 1, 'when the time is up the call is refused', 6000);
    assert.deepEqual(c.hub.of('decide')[0], ['decide', real.id, false]);
    await eventually(() => c.updates(sessionId).some((u) => /could not be asked/i.test(JSON.stringify(u))), 'and the person is told');
    done(c, taskId, 'Done.');
    await first.answer();
    ok('an editor that does not answer in the time it is given: the call is refused after at least a second, and the person is told');
  }
  {
    // The questions still open when the turn ends are closed and answered as refused, and the Hub that no longer has them, or fails, is no reason to stop.
    const { c, first, taskId } = await begin();
    grow(c, taskId, [toolStart('c1', 'local.write_file', { path: 'out.txt' })], waitingFor('c1'));
    c.hub.pending.push(request(taskId));
    await eventually(() => c.asked('session/request_permission').length === 1, 'asked');
    c.hub.pending.length = 0; // answered in the desktop app
    grow(c, taskId, [toolResult('c1', 'local.write_file', 'Created out.txt')], { state: 'running', pendingCall: null });
    done(c, taskId, 'Done.');
    await first.answer();
    await eventually(() => c.hub.of('decide').length === 1, 'when the turn ends the question nobody answered is closed, and the Hub is told it was refused');
    assert.deepEqual(c.hub.of('decide')[0], ['decide', real.id, false]);
    await eventually(() => c.logs.some((line) => line.includes(`the Hub no longer had the approval ${real.id}`)), 'and that the Hub no longer had it is logged');
  }
  {
    const { c, first, taskId } = await begin();
    grow(c, taskId, [toolStart('c1', 'local.write_file', { path: 'out.txt' })], waitingFor('c1'));
    c.hub.pending.push(request(taskId));
    c.hub.failOn.set('decide', Object.assign(new Error('the Hub refused the answer'), { status: 500 }));
    const [ask] = await eventually(() => { const list = c.asked('session/request_permission'); return list.length ? list : null; }, 'asked');
    c.respond(ask.id, allow);
    await eventually(() => c.logs.some((line) => line.includes(`could not answer the approval ${real.id}`) && line.includes('the Hub refused the answer')), 'the failure is logged');
    assert.equal(c.messages().some((m) => m.id === first.id), false, 'and the turn goes on');
    c.hub.failOn.delete('decide');
    c.hub.pending.length = 0;
    done(c, taskId, 'Done.');
    assert.deepEqual((await first.answer()).result, { stopReason: 'end_turn' });
    ok('a question still open when the turn ends is closed and answered as refused; a Hub that no longer has the request, or that fails to take the answer, is logged and the turn goes on');
  }
  {
    // The use of the context is counted from where the turn before stopped, and the answer at the end is told when no message of the model carried it.
    const { c, sessionId, first, taskId, prompt } = await begin();
    const task = c.hub.tasks.get(taskId);
    task.contextPolicy = { source: 'catalog', capacityTokens: 100_000, approximate: false };
    task.usage = { inputTokens: 900, outputTokens: 100, httpRequests: 1, inputUsageMissing: 0, outputUsageMissing: 0 };
    await eventually(() => c.updates(sessionId).some((u) => u.sessionUpdate === 'usage_update'), 'the first response is told');
    done(c, taskId, 'One.');
    await first.answer();
    assert.deepEqual(c.updates(sessionId).filter((u) => u.sessionUpdate === 'agent_message_chunk'), [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'One.' } }], 'the answer is told at the end when no message of the model carried it');
    const second = prompt('again');
    await eventually(() => c.hub.of('continueTask').length === 1, 'continued');
    Object.assign(c.hub.tasks.get(taskId), { usage: { inputTokens: 1500, outputTokens: 180, httpRequests: 2, inputUsageMissing: 0, outputUsageMissing: 0 } });
    await eventually(() => c.updates(sessionId).filter((u) => u.sessionUpdate === 'usage_update').length === 2, 'the second turn tells the use of its own response');
    assert.deepEqual(c.updates(sessionId).filter((u) => u.sessionUpdate === 'usage_update').at(-1), { sessionUpdate: 'usage_update', used: 680, size: 100_000 }, 'what the second response used, and not the sum of the two');
    done(c, taskId, 'Two.');
    await second.answer();
    ok('the use of the context is counted from where the turn before stopped (the Hub keeps sums), and the answer at the end is told when no message of the model carried it');
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`PASS: ${checks} checks (updates while a task runs, approvals asked of the editor, a cancel and a failing Hub, what leaves)`);
