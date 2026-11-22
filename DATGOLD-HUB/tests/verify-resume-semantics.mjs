// Resume semantics (P9 ac-18, docs/SESSION-RESUME.md "What a continued run shows"): what a continued run says about the way it started, built on
// the history journal of ac-17 (lib/history-journal.mjs) and the persisted plan state of ac-9 (docs/PLAN-MODE.md).
//
// What this proves, on the real code:
//   A. The loader returns the real numbers the event shows: how many journal items of the interrupted last turn it cut (cutItems), and which call
//      ids have a recorded result (answered). callsWithoutResult names the prior calls with no recorded result (cut calls without one, unverified
//      operations the journal has no result for), once each; the resumed note lists them in a section of its own, and still lists the unverified
//      operations and the calls of the interrupted turn as before.
//   B. Through AgentRunner and a scripted model: a continued run that replays the journal emits `resumed_from_transcript` {items, bytes,
//      droppedTailItems, droppedOldItems, summaryUsed, interruptedCalls, noResultCalls, unverified} (to the task's events, the transcript and the
//      listeners), its public task says resumeMode 'transcript' with the same numbers (the payload continue() returns, the task list, a Hub that
//      loads it again), and the report has the resume line. The numbers are checked against what the model was really sent: the seed is the
//      items before the resumed note, its size is their JSON size, the tail is the journal records of the cut turn, the left-out count is the one
//      the left-out note names, a context_summary record is used. A write in flight when the run was stopped stays an unverified operation and is
//      named as a call with no recorded result. A task the journal cannot serve resumes from the checkpoint text: resumeMode 'checkpoint' with the
//      reason, no resumed_from_transcript, the pending call still in the checkpoint text.
//   C. Plan mode (the real HubManager, PermissionGate, LocalTools): a plan task continued after a stop, after a Hub that reloads it, and after a
//      Hub that died while its plan waited, stays read-only (its write is refused, the workspace is unchanged) and emits resumed_from_transcript.
//   D. A second chat (a child runner of ConcurrentApiAgent, its own task folder): continued over HTTP (/api/tasks/continue) its payload says
//      resumeMode 'transcript', the event reaches the pool's listeners, the report has the line, and the same after a Hub that loads it again.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { delay } from '../lib/runtime.mjs';
import { AgentRunner } from '../lib/agent.mjs';
import { HubManager } from '../lib/manager.mjs';
import { assembleStudio } from '../lib/assemble.mjs';
import { ConcurrentApiAgent } from '../lib/concurrent-api-agent.mjs';
import { DualAgent } from '../lib/dual-agent.mjs';
import { createHubServer } from '../hub.mjs';
import { LEFT_OUT_HEADER, NO_RESULT_HEADER, RESUME_NOTE_HEADER, callsWithoutResult, historyBytes, loadHistoryJournal, resumeNote } from '../lib/history-journal.mjs';
import { SKILL_REFERENCES_HEADER } from '../lib/skill-index.mjs';

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
setTimeout(() => { console.error('FAIL: the resume-semantics suite exceeded its own time budget'); process.exit(2); }, 240_000).unref();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const bundleRoot = path.resolve(HERE, '..');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-resume-semantics-'));
const cleanups = [];
const MAX_CONTEXT_BYTES = 48 * 1024 * 1024;
const STATS = ['items', 'bytes', 'droppedTailItems', 'droppedOldItems', 'summaryUsed', 'interruptedCalls', 'noResultCalls', 'unverified'];
const pick = (value, keys) => Object.fromEntries(keys.map((key) => [key, value?.[key]]));

async function until(test, label, ms = 20_000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await test();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await delay(20);
  }
}

// ------------------------------------------------------------------ journal lines and model items
const AT = '2026-11-22T00:00:00.000Z';
const line = (record) => JSON.stringify({ at: AT, ...record });
const start = (run, source = run === 1 ? 'none' : 'journal') => line({ type: 'history_run', v: 1, run, seed: { source, items: 0, bytes: 2, dropped: 0, cut: 0 }, counters: { hookBlocks: null, noticeTurns: 0, doneGate: null } });
const hist = (run, seq, item, { role = item.role === 'user' ? 'user' : item.type === 'function_call_output' ? 'tool' : 'model', kind = role === 'user' ? 'prompt' : role === 'tool' ? 'tool_output' : 'model_output', batch = role === 'user' ? null : 1 } = {}) => line({ type: 'history', v: 1, run, seq, role, kind, batch, item });
const ref = (id) => ({ type: 'function_call_output', call_id: id, output_ref: 'tool_result_full' });
const full = (id, text) => line({ type: 'tool_result_full', toolName: 'local.read_file', call_id: id, result: { content: [{ type: 'text', text }] } });
const end = (run, items) => line({ type: 'history_end', v: 1, run, items });
const user = (text) => ({ role: 'user', content: [{ type: 'input_text', text }] });
const fcall = (id, name = 'read_file', args = {}) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args), status: 'completed' });
const said = (text) => ({ type: 'message', role: 'assistant', phase: 'final', content: [{ type: 'output_text', text }] });

let callCount = 0;
const call = (name, args) => ({ type: 'function_call', status: 'completed', name, call_id: `call-${++callCount}`, arguments: JSON.stringify(args) });
const turn = (...items) => ({ status: 'completed', output: items });
const final = (text) => turn(said(text));
const commentary = (text) => ({ type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text }] });
const outputText = (item) => (typeof item.output === 'string' ? item.output : JSON.stringify(item.output));
const outputsOf = (input) => new Map(input.filter((item) => item?.type === 'function_call_output').map((item) => [item.call_id, outputText(item)]));
const textOf = (item) => (Array.isArray(item?.content) ? item.content.map((part) => String(part?.text ?? '')).join('') : String(item?.content ?? ''));
const userTexts = (input) => input.filter((item) => item?.role === 'user').map(textOf);
/** Where the replayed history ends in a request: at the first item the new run adds (its skill index, else the resumed note). */
const noteIndex = (input) => input.findIndex((item) => item?.role === 'user' && (textOf(item).startsWith(RESUME_NOTE_HEADER) || textOf(item).startsWith(SKILL_REFERENCES_HEADER)));
const records = async (file) => (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean).map((text) => JSON.parse(text));
/** The lines of one section of the note: from its header to the next line that is not an entry. */
const section = (note, header) => {
  const lines = note.split('\n');
  const at = lines.findIndex((text) => text.startsWith(header));
  if (at < 0) return null;
  const out = [];
  for (const text of lines.slice(at + 1)) { if (!text.startsWith('- ') && text !== '(none)') break; out.push(text); }
  return out;
};

/** A model that answers from a list (a step is a response or a function of the request), and keeps every request. */
class Script {
  constructor(...steps) { this.steps = steps; this.requests = []; }
  push(...steps) { this.steps.push(...steps); }
  ready() { return true; }
  snapshot() { return { provider: 'fixture', model: 'resume-fixture' }; }
  state() { return { provider: 'fixture', model: 'resume-fixture', configured: true, keySource: 'none' }; }
  async respond(request) {
    this.requests.push(request);
    const step = this.steps.shift();
    if (!step) return final('Nothing more to do.');
    return typeof step === 'function' ? step(request) : step;
  }
}

const TOOLS = ['read_file', 'write_file'].map((name) => ({ name: `local.${name}`, server: 'local', originalName: name, description: `${name} tool`, inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }));
/** A manager with two local tools; `hang(name)` makes a call never return (a write in flight). */
const makeManager = (root, { hang = null } = {}) => {
  const manager = {
    secrets: [], generation: 1, instanceId: 'resume-semantics', locked: false, calls: [],
    state() { return { workspace: { path: root }, generation: 1, instanceId: this.instanceId }; },
    acquireTask() { if (this.locked) return false; this.locked = true; return true; },
    releaseTask() { this.locked = false; },
    async createAgentSession() {
      return {
        catalog: { tools: structuredClone(TOOLS), prompts: [], resources: [], resourceTemplates: [], servers: { local: {} } },
        async close() {},
        async callTool(name, args, { onDecision } = {}) {
          manager.calls.push({ name, args });
          await onDecision?.({ name, category: name === 'local.write_file' ? 'workspace_edit' : 'read', allowed: true });
          if (hang?.(name, args)) return new Promise(() => {});
          return { content: [{ type: 'text', text: `content of ${args.path}` }] };
        },
      };
    },
  };
  return manager;
};
const settle = (runner, label, ms = 30_000) => Promise.race([runner.context.done.promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${label}: timed out`)), ms))]);
const reportLine = (report) => report.split('\n').find((text) => text.startsWith('Resume (latest run):')) ?? null;

try {
  // ------------------------------------------------------------------------------------------------------------------------------
  // A. The loader's numbers and the note
  // ------------------------------------------------------------------------------------------------------------------------------
  let fileNumber = 0;
  const write = async (lines) => {
    fileNumber += 1;
    const file = path.join(temp, `transcript-${fileNumber}.jsonl`);
    await fs.writeFile(file, lines.join('\n') + '\n');
    return file;
  };
  const load = (file, options = {}) => loadHistoryJournal(file, { modelOutput: (result) => JSON.stringify(result), maxBytes: MAX_CONTEXT_BYTES, beforeRun: Infinity, ...options });
  const interruptedRun = [
    start(1),
    hist(1, 0, user('three reads')),
    hist(1, 1, fcall('c1', 'read_file', { path: 'a' }), { batch: 1 }),
    full('c1', 'A'), hist(1, 2, ref('c1'), { batch: 1 }),
    hist(1, 3, said('now two at once'), { batch: 2 }),
    hist(1, 4, fcall('c2', 'read_file', { path: 'b' }), { batch: 2 }),
    hist(1, 5, fcall('c3', 'write_file', { path: 'c' }), { batch: 2 }),
    full('c2', 'B'), hist(1, 6, ref('c2'), { batch: 2 }),
  ];
  {
    const cut = await load(await write(interruptedRun));
    assert.equal(cut.ok, true, cut.reason);
    assert.equal(cut.items.length, 3, '(premise) the turn of batch 2 is cut');
    assert.equal(cut.cutItems, 4, 'the cut turn had 4 journal items: its text, two calls and the one result it got');
    assert.deepEqual([...cut.answered].sort(), ['c1', 'c2'], 'a result recorded in the cut turn is still a recorded result; c3 has none');
    const whole = await load(await write([start(1), hist(1, 0, user('x')), hist(1, 1, fcall('w1'), { batch: 1 }), full('w1', 'W'), hist(1, 2, ref('w1'), { batch: 1 }), hist(1, 3, said('y'), { batch: 2 }), end(1, 4)]));
    assert.equal(whole.cutItems, 0, 'a run that ended cleanly has no cut tail');
    const twoRuns = await load(await write([...interruptedRun, start(2), hist(2, 0, user('go on')), hist(2, 1, said('done'), { batch: 1 }), end(2, 2)]));
    assert.equal(twoRuns.cutItems, 0, 'the count is the last run\'s, like the interrupted calls the note names');
    assert.deepEqual(twoRuns.interrupted, []);
    assert.ok(twoRuns.answered.has('c2') && !twoRuns.answered.has('c3'), 'answered covers every run read');
    const beforeTwo = await load(await write([...interruptedRun, start(2), hist(2, 0, user('go on')), hist(2, 1, fcall('n1'), { batch: 1 }), full('n1', 'N'), hist(2, 2, ref('n1'), { batch: 1 })]), { beforeRun: 2 });
    assert.equal(beforeTwo.answered.has('n1'), false, 'a run that is not read answers nothing');
    assert.equal(beforeTwo.cutItems, 4);

    const calls = cut.calls;
    const unverified = [
      { callId: 'c3', toolName: 'local.write_file', phase: 'executing', startedAt: AT },
      { callId: 'c1', toolName: 'local.read_file', phase: 'executing', startedAt: AT },
      { toolName: 'local.run_command', phase: 'executing', startedAt: AT },
    ];
    const missing = callsWithoutResult({ unverified, interrupted: cut.interrupted, calls, answered: cut.answered });
    assert.deepEqual(missing, [
      { callId: 'c3', name: 'local.write_file', run: 1 },
      { callId: null, name: 'local.run_command', run: null },
    ], 'c3 once (cut without a result and unverified, named as the Hub recorded it), the operation with no call id, and neither c2 (its result was recorded) nor c1 (unverified, but the journal has its result)');
    assert.deepEqual(callsWithoutResult({ interrupted: cut.interrupted, calls, answered: cut.answered }), [{ callId: 'c3', name: 'write_file', run: 1 }], 'a cut call alone is named by the model\'s name for it');
    assert.deepEqual(callsWithoutResult(), [], 'nothing to name');

    const note = resumeNote({ unverified, interrupted: cut.interrupted, calls, answered: cut.answered, dropped: 0, previous: { status: 'cancelled', errorCode: 'user_cancelled', error: 'stopped' } });
    assert.deepEqual(section(note, NO_RESULT_HEADER), ['- local.write_file (call c3, run 1)', '- local.run_command (call unknown, run unknown)'], 'the note names the prior calls with no recorded result');
    assert.ok(note.split('\n').some((text) => text.startsWith('- local.write_file (call c3, started ') && text.includes('executing')), 'the unverified operations are still injected');
    assert.match(note, /CALLS OF THE INTERRUPTED TURN[^\n]*\n- read_file \(call c2\): a result was recorded, but the turn did not finish/);
    const clean = resumeNote({ unverified: [], interrupted: [], calls: new Map(), answered: new Set() });
    assert.deepEqual(section(clean, NO_RESULT_HEADER), ['(none)'], 'a note with nothing missing says so');
    assert.ok(clean.indexOf(NO_RESULT_HEADER) > clean.indexOf('UNVERIFIED OPERATIONS'), 'after the unverified operations');
  }
  ok('loader: cutItems is the number of journal items of the cut last turn, answered the call ids with a recorded result (cut turns too, runs not read excluded); callsWithoutResult names each prior call with no recorded result once; the note lists them in their own section and keeps the unverified operations');

  // ------------------------------------------------------------------------------------------------------------------------------
  // B. Through the runner
  // ------------------------------------------------------------------------------------------------------------------------------
  // B1 a plain continue
  {
    const root = path.join(temp, 'b-plain');
    await fs.mkdir(root, { recursive: true });
    const manager = makeManager(root);
    const model = new Script(turn(call('read_file', { path: 'a.txt' })), final('First answer.'));
    const tasks = path.join(root, 'tasks');
    const runner = new AgentRunner({ manager, provider: model, taskDirectory: tasks, toolSelectionMode: 'full' });
    await runner.load();
    const heard = [];
    runner.subscribe((event) => { if (event.type === 'event') heard.push(event); });
    const started = await runner.start({ prompt: 'Read a.' });
    assert.equal(started.resumeMode, null, 'a new conversation did not resume');
    assert.equal(started.resume, null);
    const first = await settle(runner, 'b1 run 1');
    assert.equal(first.status, 'completed', first.error ?? '');
    assert.equal(reportLine(await runner.report(started.id)), 'Resume (latest run): none (this run did not continue an earlier one)');

    let firstRequest = null;
    model.push((request) => { firstRequest = request; return final('Second answer.'); });
    const continued = await runner.continue({ id: started.id, prompt: 'Go on.' });
    assert.equal(continued.resumeMode, 'transcript', 'the payload continue returns says how the run resumed');
    const done = await settle(runner, 'b1 run 2');
    assert.equal(done.status, 'completed', done.error ?? '');
    const seedItems = noteIndex(firstRequest.input);
    assert.ok(seedItems >= 4, `(premise) the replayed history is before the note (${seedItems} items)`);
    const expected = { items: seedItems, bytes: historyBytes(firstRequest.input.slice(0, seedItems)), droppedTailItems: 0, droppedOldItems: 0, summaryUsed: false, interruptedCalls: 0, noResultCalls: 0, unverified: 0 };
    assert.deepEqual(pick(continued.resume, STATS), expected, 'the numbers are those of what the model was sent: the items before the note, their JSON size');
    assert.equal(continued.resume.mode, 'transcript');
    assert.equal(continued.resume.run, 2);
    const events = done.events.filter((event) => event.type === 'resumed_from_transcript');
    assert.equal(events.length, 1, 'one resumed_from_transcript event');
    assert.deepEqual(pick(events[0], STATS), expected, 'the event carries the same numbers');
    assert.ok(done.events.findIndex((event) => event.type === 'resumed_from_transcript') < done.events.findIndex((event) => event.type === 'continuation'), 'before the run says it goes on');
    assert.ok(heard.some((event) => event.taskId === started.id && event.event.type === 'resumed_from_transcript' && event.event.items === expected.items), 'the listeners hear it');
    const transcript = await records(path.join(tasks, started.id, 'transcript.jsonl'));
    const written = transcript.find((record) => record.type === 'resumed_from_transcript');
    assert.deepEqual(pick(written, STATS), expected, 'the transcript has it');
    const seed = transcript.filter((record) => record.type === 'history_run').at(-1).seed;
    assert.deepEqual([seed.source, seed.items, seed.bytes], ['journal', expected.items, expected.bytes], 'and it agrees with the seed the journal recorded');
    assert.equal(runner.state().tasks.find((task) => task.id === started.id)?.resumeMode, 'transcript', 'the task list says it too');
    assert.equal(reportLine(await runner.report(started.id)), `Resume (latest run): transcript; ${expected.items} items, ${expected.bytes} bytes replayed; 0 items of an interrupted turn left out; 0 older items left out for size; summary used: no; calls with no recorded result: 0; unverified operations: 0`);

    model.push(final('Third answer.'));
    const third = await runner.continue({ id: started.id, prompt: 'Once more.' });
    assert.equal(third.resume.run, 3, 'every continue records its own run');
    await settle(runner, 'b1 run 3');
    await runner.shutdown();
    const again = new AgentRunner({ manager, provider: model, taskDirectory: tasks, toolSelectionMode: 'full' });
    await again.load();
    const reloaded = again.get(started.id);
    assert.equal(reloaded.resumeMode, 'transcript', 'a Hub that loads the task again shows how its last run resumed');
    assert.equal(reloaded.resume.run, 3);
    await again.shutdown();
  }
  ok('a continued run that replays the journal: resumed_from_transcript with the real numbers (the items before the note, their JSON size) in the events, the transcript and the listeners; resumeMode transcript in the payload of continue, the task list and after a reload; the report line');

  // B2 a write in flight when the run was stopped
  {
    const root = path.join(temp, 'b-inflight');
    await fs.mkdir(root, { recursive: true });
    const manager = makeManager(root, { hang: (name) => name === 'local.write_file' });
    const writeCall = call('write_file', { path: 'calc.js' });
    const readCall = call('read_file', { path: 'a.txt' });
    const model = new Script(turn(readCall), turn(commentary('Now the write.'), writeCall));
    const tasks = path.join(root, 'tasks');
    const runner = new AgentRunner({ manager, provider: model, taskDirectory: tasks, toolSelectionMode: 'full' });
    await runner.load();
    const started = await runner.start({ prompt: 'Read a, then fix calc.js.' });
    await until(() => runner.get(started.id)?.pendingCall?.toolName === 'local.write_file', 'the write to start');
    await runner.writes.get(started.id);
    const stopped = await runner.cancel(started.id);
    assert.equal(stopped.status, 'cancelled');
    assert.equal(stopped.pendingCall?.callId, writeCall.call_id, '(premise) the write is still in flight on the record');
    const run1 = (await records(path.join(tasks, started.id, 'transcript.jsonl'))).filter((record) => record.type === 'history' && record.run === 1);
    const writeRecord = run1.find((record) => record.item.call_id === writeCall.call_id && record.item.type === 'function_call');
    const begin = Math.min(...run1.filter((record) => record.role === 'model' && record.batch === writeRecord.batch).map((record) => record.seq));
    const tail = run1.filter((record) => record.seq >= begin).length;
    assert.ok(tail >= 2, `(premise) the cut turn has its text and its call: ${tail} records`);

    let note = null;
    let firstRequest = null;
    model.push((request) => { firstRequest = request; note = userTexts(request.input).find((text) => text.startsWith(RESUME_NOTE_HEADER)); return final('I will look at calc.js before anything else.'); });
    const continued = await runner.continue({ id: started.id, prompt: 'Continue.' });
    const done = await settle(runner, 'b2 run 2');
    assert.equal(done.status, 'completed', done.error ?? '');
    const seedItems = noteIndex(firstRequest.input);
    assert.deepEqual(pick(continued.resume, STATS), { items: seedItems, bytes: historyBytes(firstRequest.input.slice(0, seedItems)), droppedTailItems: tail, droppedOldItems: 0, summaryUsed: false, interruptedCalls: 1, noResultCalls: 1, unverified: 1 }, 'the cut tail is the journal records of the interrupted turn');
    assert.deepEqual(pick(done.events.find((event) => event.type === 'resumed_from_transcript'), STATS), pick(continued.resume, STATS));
    assert.equal(done.unverifiedOperations.at(-1)?.callId, writeCall.call_id, 'the write in flight is kept as an unverified operation');
    assert.ok(note.split('\n').some((text) => text.startsWith(`- local.write_file (call ${writeCall.call_id}, started `) && text.endsWith('executing): {"path":"calc.js"}')), 'and injected as one, with its arguments');
    assert.deepEqual(section(note, NO_RESULT_HEADER), [`- local.write_file (call ${writeCall.call_id}, run 1)`], 'the note names it as the one prior call with no recorded result, and not the read, whose result is recorded');
    assert.equal(reportLine(await runner.report(started.id)), `Resume (latest run): transcript; ${seedItems} items, ${continued.resume.bytes} bytes replayed; ${tail} items of an interrupted turn left out; 0 older items left out for size; summary used: no; calls with no recorded result: 1; unverified operations: 1`);
    assert.equal(manager.calls.filter((entry) => entry.name === 'local.write_file').length, 1, 'the write was not run again');
    await runner.shutdown();
  }
  ok('a write in flight when the run was stopped: it stays an unverified operation (injected with its arguments), the note names it as a call with no recorded result, droppedTailItems is the number of journal records of the cut turn, nothing ran again');

  // B3 a summary record is used
  {
    const root = path.join(temp, 'b-summary');
    await fs.mkdir(root, { recursive: true });
    const manager = makeManager(root);
    const model = new Script(turn(call('read_file', { path: 'a.txt' })), final('Read.'));
    const tasks = path.join(root, 'tasks');
    const runner = new AgentRunner({ manager, provider: model, taskDirectory: tasks, toolSelectionMode: 'full' });
    await runner.load();
    const started = await runner.start({ prompt: 'Read a.' });
    await settle(runner, 'b3 run 1');
    await runner.writes.get(started.id);
    const file = path.join(tasks, started.id, 'transcript.jsonl');
    const output = (await records(file)).find((record) => record.type === 'history' && record.item.type === 'function_call_output');
    await fs.appendFile(file, JSON.stringify({ at: AT, type: 'context_summary', v: 1, run: 1, through: { run: 1, seq: output.seq }, item: user('SUMMARY OF THE EARLIER WORK') }) + '\n');
    let firstRequest = null;
    model.push((request) => { firstRequest = request; return final('Done.'); });
    const continued = await runner.continue({ id: started.id, prompt: 'Go on.' });
    await settle(runner, 'b3 run 2');
    assert.equal(continued.resume.summaryUsed, true, 'the event says the summary record was used');
    assert.equal(textOf(firstRequest.input[0]), 'SUMMARY OF THE EARLIER WORK', '(premise) the model got the summary first');
    assert.equal(continued.resume.items, noteIndex(firstRequest.input));
    assert.match(reportLine(await runner.report(started.id)), /; summary used: yes;/);
    await runner.shutdown();
  }
  ok('a history whose context_summary record replaced earlier items: summaryUsed is true in the event, the payload and the report');

  // B4 a task the journal cannot serve: the checkpoint text, with the call that was in flight
  {
    const root = path.join(temp, 'b-legacy');
    const tasks = path.join(root, 'tasks');
    const id = randomUUID();
    await fs.mkdir(path.join(tasks, id), { recursive: true });
    const at = '2026-01-01T00:00:00.000Z';
    const pendingCall = { callId: 'old-write-1', toolName: 'local.write_file', startedAt: at, outcome: 'pending_or_unknown', phase: 'executing' };
    await fs.writeFile(path.join(tasks, id, 'task.json'), JSON.stringify({
      formatVersion: 1, id, prompt: 'Old request about calc.js', status: 'paused', workspace: { path: root, generation: 1, instanceId: 'resume-semantics' },
      model: 'resume-fixture', provider: 'fixture', createdAt: at, startedAt: at, updatedAt: at, finishedAt: at, finalText: '', error: 'Hub restarted.', errorCode: 'process_interrupted',
      steps: 2, toolCalls: 1, maxSteps: null, maxMinutes: null, usage: { inputTokens: 1, outputTokens: 1, httpRequests: 2 },
      events: [{ at, type: 'tool_start', message: 'writing calc.js', toolName: 'local.write_file', status: 'running' }], eventCount: 1, pendingCall,
      prompts: [{ at, text: 'Old request about calc.js' }], runs: [{ startedAt: at, finishedAt: at, status: 'paused', startStep: 0 }], dialogue: [],
    }));
    await fs.writeFile(path.join(tasks, id, 'transcript.jsonl'), JSON.stringify({ at, type: 'started', message: 'started' }) + '\n');
    const manager = makeManager(root);
    let firstRequest = null;
    const model = new Script((request) => { firstRequest = request; return final('Continued from the checkpoint.'); });
    const runner = new AgentRunner({ manager, provider: model, taskDirectory: tasks, toolSelectionMode: 'full' });
    await runner.load();
    const continued = await runner.continue({ id, prompt: 'And now?' });
    const done = await settle(runner, 'b4');
    assert.equal(done.status, 'completed', done.error ?? '');
    assert.equal(continued.resumeMode, 'checkpoint', 'the payload says the run resumed from the checkpoint text');
    const checkpoint = userTexts(firstRequest.input).find((text) => text.startsWith('CONVERSATION CHECKPOINT'));
    assert.ok(checkpoint, '(premise) the model got the checkpoint text');
    assert.deepEqual(pick(continued.resume, ['mode', 'run', 'reason', 'bytes', 'unverified']), { mode: 'checkpoint', run: 2, reason: 'no_journal', bytes: Buffer.byteLength(checkpoint), unverified: 1 }, 'with the reason and the size of the checkpoint text');
    assert.match(checkpoint, /UNVERIFIED MCP OPERATIONS \(inspect before any repeat\):\n[^\n]*"callId":"old-write-1"/, 'the call that was in flight is still injected');
    assert.ok(done.events.some((event) => event.type === 'resume_fallback'), 'the fallback event says why');
    assert.equal(done.events.some((event) => event.type === 'resumed_from_transcript'), false, 'and no transcript resume is claimed');
    assert.equal(reportLine(await runner.report(id)), `Resume (latest run): checkpoint (the journal could not be used: no_journal); checkpoint text ${Buffer.byteLength(checkpoint)} bytes; unverified operations: 1`);
    await runner.shutdown();
  }
  ok('a task written before the journal: resumeMode checkpoint with the reason and the size of the checkpoint text, the call that was in flight still in it, no resumed_from_transcript, the report line');

  // B5 a history over the cap: the oldest turns left out, and the count is the one the note names
  {
    const root = path.join(temp, 'b-large');
    const tasks = path.join(root, 'tasks');
    const id = randomUUID();
    await fs.mkdir(path.join(tasks, id), { recursive: true });
    const at = '2026-11-22T00:00:00.000Z';
    await fs.writeFile(path.join(tasks, id, 'task.json'), JSON.stringify({
      formatVersion: 1, id, prompt: 'Big', status: 'completed', workspace: { path: root, generation: 1, instanceId: 'resume-semantics' }, model: 'resume-fixture', provider: 'fixture',
      createdAt: at, startedAt: at, updatedAt: at, finishedAt: at, finalText: 'Done.', error: null, errorCode: null, steps: 1, toolCalls: 1, maxSteps: null, maxMinutes: null,
      usage: { inputTokens: 0, outputTokens: 0, httpRequests: 0 }, events: [], eventCount: 0, pendingCall: null, prompts: [{ at, text: 'Big' }], runs: [{ startedAt: at, finishedAt: at, status: 'completed', startStep: 0 }], dialogue: [],
    }));
    const handle = await fs.open(path.join(tasks, id, 'transcript.jsonl'), 'w');
    const chunk = ('0123456789abcdef'.repeat(8) + '\n').repeat(1600);
    let seq = 0;
    await handle.write(start(1) + '\n');
    await handle.write(hist(1, seq++, user('Big')) + '\n');
    for (let index = 1; index <= 250; index += 1) {
      const callId = `big_${index}`;
      await handle.write(hist(1, seq++, fcall(callId, 'read_file', { path: `part-${index}.txt` }), { batch: index }) + '\n');
      await handle.write(full(callId, `${index}\n${chunk}`) + '\n');
      await handle.write(hist(1, seq++, ref(callId), { batch: index }) + '\n');
    }
    await handle.write(hist(1, seq++, said('Done.'), { batch: 251 }) + '\n');
    await handle.write(end(1, seq) + '\n');
    await handle.close();
    const manager = makeManager(root);
    let firstRequest = null;
    const model = new Script((request) => { firstRequest = request; return final('Done again.'); });
    const runner = new AgentRunner({ manager, provider: model, taskDirectory: tasks, toolSelectionMode: 'full' });
    await runner.load();
    const continued = await runner.continue({ id, prompt: 'Anything else?' });
    await settle(runner, 'b5', 60_000);
    const leftOut = textOf(firstRequest.input[0]);
    assert.ok(leftOut.startsWith(LEFT_OUT_HEADER), '(premise) the history starts with the left-out note');
    const named = Number(/the first (\d+) items/.exec(leftOut)?.[1]);
    assert.ok(named > 0);
    assert.equal(continued.resume.droppedOldItems, named, 'droppedOldItems is the count the left-out note names');
    assert.equal(continued.resume.items, noteIndex(firstRequest.input));
    assert.ok(continued.resume.bytes <= MAX_CONTEXT_BYTES);
    await runner.shutdown();
  }
  ok('a history over the 48 MiB cap: droppedOldItems is the number of old items the left-out note names');

  // ------------------------------------------------------------------------------------------------------------------------------
  // C. Plan mode, D. a second chat: the real Hub stack
  // ------------------------------------------------------------------------------------------------------------------------------
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  const PLAN = '1. Read src/app.js.\n2. Rename answer to theAnswer.';
  const PLAN_REFUSAL = /exit_plan_mode/;
  async function makeRepo(name) {
    const repo = path.join(temp, name);
    await fs.mkdir(path.join(repo, 'src'), { recursive: true });
    git(repo, 'init', '-b', 'main');
    git(repo, 'config', 'user.email', 'chatmcp-ci@example.invalid');
    git(repo, 'config', 'user.name', 'ChatMCP CI');
    await fs.writeFile(path.join(repo, 'README.md'), '# fixture\n');
    await fs.writeFile(path.join(repo, 'src', 'app.js'), 'export const answer = 42;\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'fixture');
    return repo;
  }
  /** HEAD, the refs and every file the work tree holds (untracked ones too). */
  const fingerprint = (repo) => ({ head: git(repo, 'rev-parse', 'HEAD').trim(), status: git(repo, 'status', '--porcelain=v1', '--untracked-files=all') });

  // One model for every runner of a stack (ConcurrentApiAgent gives the primary runner the pool's provider): a request whose conversation holds
  // CHILD_TAG is the second chat's.
  const CHILD_TAG = '[second chat]';
  class Model {
    constructor() { this.queues = { main: [], child: [] }; }
    ready() { return true; }
    snapshot() { return { provider: 'fixture', model: 'resume-fixture' }; }
    state() { return { provider: 'fixture', model: 'resume-fixture', configured: true, keySource: 'none' }; }
    script(...steps) { this.queues.main.push(...steps); }
    scriptChild(...steps) { this.queues.child.push(...steps); }
    async respond(request) {
      const key = userTexts(request.input).some((text) => text.includes(CHILD_TAG)) ? 'child' : 'main';
      const step = this.queues[key].shift();
      if (!step) return final('Nothing more to do.');
      return typeof step === 'function' ? step(request) : step;
    }
  }
  async function makeStack(name, { repo = null, data = null } = {}) {
    const workspace = repo ?? await makeRepo(name);
    const directory = data ?? path.join(temp, `${name}-hub`);
    const hub = new HubManager({ bundleRoot, dataDirectory: directory, log: () => {} });
    await hub.load(workspace);
    assembleStudio(hub, { bundleRoot });
    await hub.permissions.load();
    await hub.startLocal(workspace);
    const model = new Model();
    const runner = new AgentRunner({ manager: hub, provider: model, taskDirectory: path.join(directory, 'api-tasks'), log: () => {}, toolSelectionMode: 'full' });
    await runner.load();
    const pool = new ConcurrentApiAgent({ primary: runner, manager: hub, provider: model, bundleRoot, directory: path.join(directory, 'api-conversations'), log: () => {} });
    const heard = [];
    pool.subscribe((event) => { if (event.type === 'event') heard.push(event); });
    let closed = false;
    const close = async () => { if (closed) return; closed = true; await pool.shutdown().catch(() => {}); await hub.shutdown().catch(() => {}); };
    cleanups.push(close);
    return { repo: workspace, data: directory, hub, gate: hub.permissions, runner, pool, model, heard, close };
  }
  const settled = (runner, id, label = 'the task to stop') => until(() => { const task = runner.get(id); return task && task.status !== 'running' && runner.activeTaskId !== id ? task : null; }, label);
  const pendingPlan = (gate, taskId) => until(() => gate.state().pending.find((item) => item.category === 'plan' && item.taskId === taskId), 'the plan approval request');
  /** Scripts a run that tries to write and reports the refusal; returns what the model saw. */
  const scriptWrite = (queue, file) => {
    const write = call('write_file', { path: file, content: 'x' });
    const seen = { users: null, output: null };
    queue((request) => { seen.users = userTexts(request.input); return turn(write); }, (request) => { seen.output = outputsOf(request.input).get(write.call_id); return final('Still planning.'); });
    return seen;
  };

  // C1 a plan task stopped while its plan waited, continued, then continued again by a Hub that loads it
  {
    const stack = await makeStack('plan-stop');
    const { repo, gate, runner, pool, model } = stack;
    const before = fingerprint(repo);
    model.script(turn(call('exit_plan_mode', { plan: PLAN })));
    const task = await pool.start({ prompt: 'Plan the rename only.', planMode: true });
    await pendingPlan(gate, task.id);
    await pool.cancel(task.id);
    const stopped = await settled(runner, task.id);
    assert.equal(stopped.planOnly, true, '(premise) the stopped task is still in plan mode');
    const seen = scriptWrite((...steps) => model.script(...steps), 'resumed.txt');
    const continued = await pool.continue({ id: task.id, prompt: 'Go on with the plan.' });
    assert.equal(continued.resumeMode, 'transcript', 'the plan task resumed from its journal');
    assert.equal(continued.planOnly, true);
    const done = await settled(runner, task.id);
    const event = done.events.find((entry) => entry.type === 'resumed_from_transcript');
    assert.ok(event, 'resumed_from_transcript is emitted for a plan task');
    assert.ok(event.droppedTailItems >= 1, 'the exit_plan_mode turn that never got its answer is cut');
    assert.deepEqual(section(seen.users.find((text) => text.startsWith(RESUME_NOTE_HEADER)), NO_RESULT_HEADER).map((text) => text.replace(/\(call [^,]*,/, '(call X,')), ['- exit_plan_mode (call X, run 1)'], 'the note names the plan call that has no recorded answer');
    assert.match(seen.output, PLAN_REFUSAL, 'the write of the resumed run is refused');
    assert.equal(gate.taskPolicy(task.id)?.planOnly, true, 'the gate still holds it read-only');
    assert.deepEqual(fingerprint(repo), before, 'the workspace is unchanged');
    assert.ok(stack.heard.some((entry) => entry.taskId === task.id && entry.event.type === 'resumed_from_transcript'), 'the pool\'s listeners hear the event');

    // a Hub that loads it again (the first one shut down cleanly)
    await stack.close();
    const again = await makeStack('plan-stop-again', { repo, data: stack.data });
    const reloaded = again.runner.get(task.id);
    assert.equal(reloaded.planOnly, true);
    assert.equal(reloaded.resumeMode, 'transcript', 'the reloaded task says how its last run resumed');
    assert.equal(again.gate.taskPolicy(task.id)?.planOnly, true, 'the new Hub holds it read-only from the start');
    const seenAgain = scriptWrite((...steps) => again.model.script(...steps), 'reloaded.txt');
    const third = await again.pool.continue({ id: task.id, prompt: 'Continue after the reload.' });
    assert.equal(third.resumeMode, 'transcript');
    assert.equal(third.resume.run, 3);
    const doneAgain = await settled(again.runner, task.id);
    assert.equal(doneAgain.events.filter((entry) => entry.type === 'resumed_from_transcript').length >= 1, true);
    assert.match(seenAgain.output, PLAN_REFUSAL);
    assert.deepEqual(fingerprint(repo), before);
    await again.close();
  }
  ok('plan mode: a plan task stopped while its plan waited, continued, and continued again by a Hub that loads it, resumes from the transcript (resumed_from_transcript, resumeMode transcript, the unanswered plan call named) and stays read-only: its writes are refused, the workspace is unchanged');

  // C2 a Hub that died while the plan waited
  {
    const stackA = await makeStack('plan-crash');
    const { repo, gate, runner, model } = stackA;
    const before = fingerprint(repo);
    model.script(turn(call('exit_plan_mode', { plan: PLAN })));
    const task = await runner.start({ prompt: 'Plan before the crash.', planMode: true });
    const card = await pendingPlan(gate, task.id);
    const taskDir = path.join(stackA.data, 'api-tasks', task.id);
    await until(async () => { try { return JSON.parse(await fs.readFile(path.join(taskDir, 'task.json'), 'utf8')).state === 'waiting_approval'; } catch { return false; } }, 'the waiting state on disk');
    await runner.writes.get(task.id);
    const dataB = path.join(temp, 'plan-crash-hub-b');
    await fs.mkdir(path.join(dataB, 'api-tasks'), { recursive: true });
    await fs.cp(taskDir, path.join(dataB, 'api-tasks', task.id), { recursive: true });
    const stackB = await makeStack('plan-crash-b', { repo, data: dataB });
    assert.equal(stackB.runner.get(task.id).planOnly, true);
    const seen = scriptWrite((...steps) => stackB.model.script(...steps), 'after-crash.txt');
    const continued = await stackB.pool.continue({ id: task.id, prompt: 'Continue after the crash.' });
    assert.equal(continued.resumeMode, 'transcript');
    const done = await settled(stackB.runner, task.id);
    assert.ok(done.events.some((entry) => entry.type === 'resumed_from_transcript'), 'resumed_from_transcript after a crash');
    assert.match(seen.output, PLAN_REFUSAL, 'the write is refused');
    assert.equal(stackB.gate.taskPolicy(task.id)?.planOnly, true);
    gate.decide(card.id, false);
    await settled(runner, task.id);
    assert.deepEqual(fingerprint(repo), before);
  }
  ok('plan mode: a Hub that died while the plan waited (its files copied mid-wait) resumes the task from the transcript, emits resumed_from_transcript, and its write is refused');

  // D a second chat, over HTTP, and after a Hub that loads it again
  {
    const stack = await makeStack('second');
    const { repo, gate, runner, pool, model } = stack;
    model.script(turn(call('exit_plan_mode', { plan: PLAN })));
    const planTask = await runner.start({ prompt: 'Plan only, keep the main checkout busy.', planMode: true });
    const planCard = await pendingPlan(gate, planTask.id);
    model.scriptChild(turn(call('read_file', { path: 'src/app.js' })), final('Second chat read it.'));
    const second = await pool.start({ prompt: `${CHILD_TAG} read src/app.js.` });
    assert.equal(second.resumeMode, null, 'a second chat that waits for its worktree has not resumed');
    const worktreeCard = await until(() => gate.state().pending.find((item) => item.toolName === 'local.worktrees_create' && item.taskId === second.id), 'the worktree question of the second chat');
    gate.decide(worktreeCard.id, true);
    await until(() => pool.get(second.id)?.status === 'completed', 'the second chat to finish');
    assert.equal(pool.get(second.id).resumeMode, null, 'a second chat that only started did not resume');
    const childDirectory = pool.children.get(second.id).runner.taskDirectory;
    assert.notEqual(childDirectory, path.join(stack.data, 'api-tasks'), '(premise) the second chat keeps its own task folder');

    const browserStub = { state: () => ({ tasks: [], active: null, activeTaskId: null }), browserState: () => ({ paired: false }), get: () => null, subscribe: () => () => {}, settle: async () => {}, shutdown: async () => {}, decidePermission: () => null };
    const dual = new DualAgent({ browser: browserStub, api: pool, directory: path.join(stack.data, 'dual'), defaultMode: 'api' });
    const port = await new Promise((resolve) => { const probe = net.createServer(); probe.listen(0, '127.0.0.1', () => { const { port: free } = probe.address(); probe.close(() => resolve(free)); }); });
    const secret = 'resume-semantics-secret-'.padEnd(40, 'x');
    const server = createHubServer(stack.hub, { port, secret, agent: dual, browser: browserStub, provider: model, bundleRoot });
    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
    cleanups.unshift(async () => { await new Promise((resolve) => server.close(resolve)); });
    const origin = `http://127.0.0.1:${port}`;
    const auth = { Authorization: `Bearer ${secret}` };
    const state = await fetch(`${origin}/api/state`, { headers: auth }).then((response) => response.json());
    assert.equal(typeof state.csrfToken, 'string', 'the state route answers');
    const post = (route, body) => fetch(origin + route, { method: 'POST', headers: { ...auth, Origin: origin, 'Content-Type': 'application/json', 'X-ChatMCP-Request': 'local-dashboard', 'X-ChatMCP-CSRF': state.csrfToken }, body: JSON.stringify(body) });

    let childRequest = null;
    model.scriptChild((request) => { childRequest = request; return final('Second chat went on.'); });
    const response = await post('/api/tasks/continue', { id: second.id, prompt: `${CHILD_TAG} go on.` });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body).slice(0, 400));
    assert.equal(body.task.id, second.id);
    assert.equal(body.task.resumeMode, 'transcript', '/api/tasks/continue says the second chat resumed from its transcript');
    await until(() => pool.get(second.id)?.status === 'completed', 'the second chat to finish again');
    assert.equal(body.task.resume.items, noteIndex(childRequest.input), 'with the real seed of its own journal');
    assert.equal(body.task.resume.bytes, historyBytes(childRequest.input.slice(0, body.task.resume.items)));
    const detail = await fetch(`${origin}/api/tasks/${second.id}`, { headers: auth }).then((reply) => reply.json());
    assert.equal(detail.resumeMode, 'transcript', 'the task the page reads (GET /api/tasks/:id) carries it for the chip');
    assert.ok(detail.events.some((entry) => entry.type === 'resumed_from_transcript'));
    assert.ok(stack.heard.some((entry) => entry.taskId === second.id && entry.event.type === 'resumed_from_transcript'), 'the event of the child runner reaches the pool\'s listeners');
    const childTranscript = await records(path.join(childDirectory, second.id, 'transcript.jsonl'));
    assert.deepEqual(childTranscript.filter((record) => record.type === 'history_run').map((record) => record.seed.source), ['none', 'journal'], 'read from the journal in the child\'s own folder');
    assert.equal(reportLine(await pool.report(second.id)), `Resume (latest run): transcript; ${body.task.resume.items} items, ${body.task.resume.bytes} bytes replayed; 0 items of an interrupted turn left out; 0 older items left out for size; summary used: no; calls with no recorded result: 0; unverified operations: 0`);

    gate.decide(planCard.id, false);
    await settled(runner, planTask.id);
    model.script(final('Primary went on.'));
    const primary = await post('/api/tasks/continue', { id: planTask.id, prompt: 'Go on.' });
    assert.equal(primary.status, 200);
    assert.equal((await primary.json()).task.resumeMode, 'transcript', 'and for the primary runner');
    await settled(runner, planTask.id);

    // a Hub that loads both again
    await new Promise((resolve) => server.close(resolve));
    await stack.close();
    const again = await makeStack('second-again', { repo, data: stack.data });
    await again.pool.load();
    assert.equal(again.pool.get(second.id)?.resumeMode, 'transcript', 'a reloaded second chat says how its last run resumed');
    again.model.scriptChild(final('Second chat after the reload.'));
    const third = await again.pool.continue({ id: second.id, prompt: `${CHILD_TAG} after the reload.` });
    assert.equal(third.resumeMode, 'transcript');
    assert.equal(third.resume.run, 3);
    await until(() => again.pool.get(second.id)?.status === 'completed', 'the reloaded second chat to finish');
    assert.ok(again.heard.some((entry) => entry.taskId === second.id && entry.event.type === 'resumed_from_transcript'));
    await again.close();
  }
  ok('a second chat (a child runner with its own task folder): /api/tasks/continue returns resumeMode transcript with the numbers of its own journal, GET /api/tasks/:id carries it, the event reaches the pool, the report has the line; the primary too; and the same after a Hub that loads it again');
} finally {
  for (const cleanup of cleanups) { try { await cleanup(); } catch { /* best effort */ } }
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }).catch(() => {});
}

console.log(`PASS: ${checks} checks (resume semantics)`);
process.exit(0);
