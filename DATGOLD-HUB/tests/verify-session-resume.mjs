// True resume (P9 ac-17): the history journal a task writes into its transcript.jsonl, and the loader that rebuilds the model history from it
// when the conversation goes on (lib/history-journal.mjs, HistoryLedger.seed, AgentRunner.start({resumeId})).
//
// What this proves, on the real code:
//   A. HistoryLedger.seed: only into an empty ledger, every call with its result, nothing told to the listeners, the size kept.
//   B. The loader's own rules, on hand-written transcripts: no journal, a truncated last line, a damaged middle, a gap, an unknown version,
//      a reference whose record is missing, the interrupted tail turn (cut, and named), a run that started from the checkpoint text, the
//      reserved summary record, the opaque reasoning that is never written, the size cap, the counters, the run that is starting.
//   C. Five scripted conversations through AgentRunner -> GatewayProvider -> real adapters -> network -> the strict mock (Chat, Responses
//      with reasoning, Anthropic with thinking, Gemini with signatures, and Chat with the router tools and an argument error): the journal
//      read back after the run equals the history the run held in memory at its end, less the opaque reasoning; the run that continues it
//      sends, in its first request, every earlier tool result under its own call id, and nothing ran again to rebuild it; at its end the
//      journal again equals the history in memory.
//   D. A Hub that died while a call that changes files was running (the files it leaves, copied while the call hangs): the first request of
//      the resumed run carries the 3 completed results with their call ids, the interrupted turn is left out, the call is listed as
//      unverified with its arguments, and nothing is run again.
//   E. A task written before the journal existed, and a journal with a hole: the checkpoint text, as before, and a resume_fallback event.
//   F. A 60 MB transcript loads under the 48 MiB cap and in under 2 s.
//   G. The replay is masked with the secret list of the process that loads it; an output the token optimiser shortened comes back whole;
//      a tool result is written once (the history record refers to it).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { AgentRunner } from '../lib/agent.mjs';
import { GatewayProvider } from '../lib/gateway-provider.mjs';
import { HistoryLedger } from '../lib/history-ledger.mjs';
import { JOURNAL_VERSION, RESUME_NOTE_HEADER, historyBytes, loadHistoryJournal, stripOpaque } from '../lib/history-journal.mjs';
import { pairToolCalls } from '../lib/model-history.mjs';
import { startMockModel } from './e2e/mock-model-server.mjs';
import { call, calls, say, sequence, thinking } from './e2e/scenarios.mjs';

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
const plain = (value) => JSON.parse(JSON.stringify(value));
const fails = (fn, code, label) => {
  let error = null;
  try { fn(); } catch (caught) { error = caught; }
  assert.ok(error, `${label}: it must throw`);
  assert.equal(error.code, code, `${label}: error code (${error.message})`);
};
const MAX_CONTEXT_BYTES = 48 * 1024 * 1024;
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-session-resume-'));
const closers = [];

// The in-memory history of every run at its end: #finish clears the ledger, and this keeps what it held just before.
const finished = [];
const realClear = HistoryLedger.prototype.clear;
HistoryLedger.prototype.clear = function clear() { finished.push(this.snapshotForModel()); return realClear.call(this); };

const user = (text) => ({ role: 'user', content: [{ type: 'input_text', text }] });
const fcall = (id, name = 'read_file', args = {}) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args), status: 'completed' });
const said = (text) => ({ type: 'message', role: 'assistant', phase: 'final', content: [{ type: 'output_text', text }] });
const out = (id, output) => ({ type: 'function_call_output', call_id: id, output });

try {
  // ------------------------------------------------------------------------------------------------------------------------------
  // A. HistoryLedger.seed
  // ------------------------------------------------------------------------------------------------------------------------------
  {
    const told = [];
    const ledger = new HistoryLedger({ onAppend: (item, meta) => told.push(meta.index) });
    const items = [user('first'), fcall('a'), out('a', 'A'), said('done')];
    assert.equal(ledger.seed(items), 4);
    assert.deepEqual(told, [], 'seeded items are not new: no listener is told');
    assert.equal(ledger.length, 4);
    assert.equal(ledger.byteLength(), Buffer.byteLength(JSON.stringify(items)), 'the size of a seeded ledger is the size of its JSON');
    assert.equal(ledger.byteLength(), historyBytes(items), 'historyBytes counts the way the ledger does');
    assert.equal(historyBytes([]), 2);
    assert.equal(ledger.snapshotForModel()[1], items[1], 'taken as they are: the caller hands them over');
    fails(() => ledger.appendToolOutput('a', 'again'), 'duplicate_output', 'a seeded call already has its result');
    fails(() => ledger.seed([user('x')]), 'ledger_not_empty', 'a ledger that holds items');
    ledger.appendUser([{ type: 'input_text', text: 'next' }], { kind: 'prompt' });
    assert.deepEqual(told, [4], 'what comes after the seed is told, at the index after it');
    ledger.beginBatch();
    ledger.appendModelOutput([fcall('a', 'read_file', { again: true })]);
    fails(() => ledger.appendToolOutput('a', 'second'), 'duplicate_output', 'a new call that reuses a seeded id does not open it again');

    const busy = new HistoryLedger();
    busy.beginBatch();
    fails(() => busy.seed([user('x')]), 'ledger_not_empty', 'a ledger with a batch open');
    const unpaired = new HistoryLedger();
    fails(() => unpaired.seed([user('x'), fcall('b')]), 'unpaired_seed', 'a call without its result');
    assert.equal(unpaired.length, 0, 'and a refused seed leaves the ledger empty');
    assert.equal(unpaired.byteLength(), 2);
    fails(() => new HistoryLedger().seed('nope'), 'invalid_item', 'a seed that is not a list');
    fails(() => new HistoryLedger().seed([null]), 'invalid_item', 'an item that is not an object');
    const empty = new HistoryLedger();
    assert.equal(empty.seed([]), 0);
    empty.appendUser('hello');
    assert.equal(empty.length, 1);
  }
  ok('HistoryLedger.seed: only into an empty ledger with no batch open, every call paired (a refusal leaves it empty), the listeners are not told, the size is the JSON size, a seeded call id cannot take a second result');

  // ------------------------------------------------------------------------------------------------------------------------------
  // B. The loader on hand-written transcripts
  // ------------------------------------------------------------------------------------------------------------------------------
  const AT = '2026-11-21T00:00:00.000Z';
  const line = (record) => JSON.stringify({ at: AT, ...record });
  const start = (run, source = run === 1 ? 'none' : 'journal', extra = {}) => line({ type: 'history_run', v: 1, run, seed: { source, items: 0, bytes: 2, dropped: 0, cut: 0 }, counters: { hookBlocks: null, noticeTurns: 0, doneGate: null }, ...extra });
  const hist = (run, seq, item, { role = item.role === 'user' ? 'user' : item.type === 'function_call_output' ? 'tool' : 'model', kind = role === 'user' ? 'prompt' : role === 'tool' ? 'tool_output' : 'model_output', batch = role === 'user' ? null : 1, ...extra } = {}) => line({ type: 'history', v: 1, run, seq, role, kind, batch, item, ...extra });
  const ref = (id, source = 'tool_result_full') => ({ type: 'function_call_output', call_id: id, output_ref: source });
  const full = (id, text, type = 'tool_result_full') => line({ type, toolName: 'local.read_file', call_id: id, result: { content: [{ type: 'text', text }] } });
  const end = (run, items, extra = {}) => line({ type: 'history_end', v: 1, run, items, ...extra });
  const event = (type, message = 'x') => line({ type, message, state: 'running' });
  let fileNumber = 0;
  const write = async (lines, { trailing = '\n' } = {}) => {
    fileNumber += 1;
    const file = path.join(temp, `transcript-${fileNumber}.jsonl`);
    await fs.writeFile(file, lines.join('\n') + trailing);
    return file;
  };
  const outputsMade = [];
  const modelOutput = (result) => { outputsMade.push(result); return JSON.stringify(result); };
  const load = (file, options = {}) => loadHistoryJournal(file, { modelOutput, redact: (text) => text, maxBytes: MAX_CONTEXT_BYTES, beforeRun: Infinity, ...options });
  const resultText = (text) => JSON.stringify({ content: [{ type: 'text', text }] });

  // B1 no journal
  {
    assert.equal((await load(path.join(temp, 'missing.jsonl'))).reason, 'no_journal', 'a task with no transcript');
    const legacy = await write([event('started'), line({ type: 'model_response', step: 1, response: { output: [] } }), full('c1', 'old result'), event('completed')]);
    const result = await load(legacy);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no_journal', 'a transcript written before the journal existed has no history records');
  }
  ok('loader: a transcript with no history records (a task written before the journal) is reported as no_journal, never as an empty history');

  // B2 a plain run, references resolved
  const simple = [
    start(1),
    hist(1, 0, user('read a')),
    event('model'),
    hist(1, 1, fcall('c1', 'read_file', { path: 'a' }), { batch: 1 }),
    event('tool_start'),
    full('c1', 'content of a'),
    hist(1, 2, ref('c1'), { batch: 1 }),
    line({ type: 'model_response', step: 2, response: { output: [said('a says hi')] } }),
    hist(1, 3, said('a says hi'), { batch: 2 }),
    end(1, 4),
  ];
  {
    outputsMade.length = 0;
    const result = await load(await write(simple));
    assert.equal(result.ok, true, result.reason);
    assert.deepEqual(plain(result.items), [user('read a'), fcall('c1', 'read_file', { path: 'a' }), out('c1', resultText('content of a')), said('a says hi')]);
    assert.equal(result.bytes, historyBytes(result.items));
    assert.equal(outputsMade.length, 1, 'the output was made once, from the result record');
    assert.equal(result.dropped, 0);
    assert.deepEqual(result.interrupted, []);
    assert.equal(result.skippedLastLine, false);
    assert.deepEqual(result.counters, { hookBlocks: null, noticeTurns: 0, doneGate: null }, 'the counters the run started with');
    const catalog = await load(await write([start(1), hist(1, 0, user('list')), hist(1, 1, fcall('k1', 'mcp_catalog')), full('k1', 'the list', 'catalog_result'), hist(1, 2, ref('k1', 'catalog_result')), hist(1, 3, out('k2', 'inline'), { role: 'tool' })]));
    assert.equal(catalog.ok, true, catalog.reason);
    assert.equal(catalog.items[2].output, resultText('the list'), 'a reference to a catalog_result record');
    assert.equal(catalog.items.some((item) => item.call_id === 'k2'), false, 'an output whose call is not in the history is dropped by the pairing repair');
  }
  ok('loader: a run of the journal comes back in order, every reference made into the output the model was given from its result record (once), the size counted as the ledger counts it');

  // B3 a truncated or damaged last line
  {
    const truncated = await load(await write([...simple, '{"at":"2026-11-21T00:00:00.000Z","type":"history","v":1,"run":1,"seq":4,"ite'], { trailing: '' }));
    assert.equal(truncated.ok, true, truncated.reason);
    assert.equal(truncated.items.length, 4);
    assert.equal(truncated.skippedLastLine, true, 'a line the dying process did not finish is skipped');
    const garbage = await load(await write([...simple, '\u0000\u0000garbage'], { trailing: '\n' }));
    assert.equal(garbage.ok, true, garbage.reason);
    assert.equal(garbage.skippedLastLine, true);
    const unterminated = await load(await write(simple, { trailing: '' }));
    assert.equal(unterminated.ok, true, unterminated.reason);
    assert.equal(unterminated.items.length, 4, 'a whole last record without its newline counts');
    assert.equal(unterminated.skippedLastLine, false);
    const middle = [...simple];
    middle.splice(3, 0, '{"at":"2026-11-21T00:00:00.000Z","type":"history","v":1,"run":1,"seq":');
    assert.equal((await load(await write(middle))).reason, 'corrupt', 'a damaged line in the middle is not skipped silently');
    const damagedOther = [...simple];
    damagedOther.splice(3, 0, '{"at":"2026-11-21T00:00:00.000Z","type":"model_response","step":1,"response":{"out');
    assert.equal((await load(await write(damagedOther))).ok, true, 'a damaged record the history does not use does not matter');
  }
  ok('loader: a truncated or damaged LAST line is skipped, a whole last record without its newline counts, a damaged history line in the middle makes the journal unusable (corrupt)');

  // B4 holes and versions
  {
    const gap = simple.filter((entry, index) => index !== 3);
    assert.equal((await load(await write(gap))).reason, 'journal_gap', 'a missing history record (seq 1)');
    const missingTarget = simple.filter((entry, index) => index !== 5);
    assert.equal((await load(await write(missingTarget))).reason, 'journal_gap', 'a reference whose result record is missing');
    const lastLost = simple.filter((entry, index) => index !== 8);
    assert.equal((await load(await write(lastLost))).reason, 'journal_gap', 'the run ended with 4 items and only 3 are there');
    const noStart = simple.slice(1);
    assert.equal((await load(await write(noStart))).reason, 'journal_gap', 'history of a run whose start record is missing');
    const newer = simple.map((entry, index) => (index === 3 ? entry.replace('"v":1', '"v":2') : entry));
    assert.equal((await load(await write(newer))).reason, 'unknown_version', 'a record a newer Hub wrote');
    const strangeRef = simple.map((entry, index) => (index === 6 ? entry.replace('"output_ref":"tool_result_full"', '"output_ref":"blob_store"') : entry));
    assert.equal((await load(await write(strangeRef))).reason, 'unknown_version', 'a reference to a kind of record this Hub does not know');
    const order = [start(1), hist(1, 0, user('a')), start(2), hist(1, 1, user('b'))];
    assert.equal((await load(await write(order))).reason, 'corrupt', 'a record of an earlier run after a later run began');
    const backwards = [start(2), hist(2, 0, user('a')), start(1, 'none'), hist(1, 0, user('b'))];
    assert.equal((await load(await write(backwards))).reason, 'corrupt', 'runs out of order');
    const repeated = [start(1), hist(1, 0, user('a')), hist(1, 0, user('a'))];
    assert.equal((await load(await write(repeated))).reason, 'journal_gap', 'a seq written twice');
    const notAnItem = [start(1), hist(1, 0, user('a')), line({ type: 'history', v: 1, run: 1, seq: 1, role: 'model', kind: 'model_output', batch: 1, item: 'text' })];
    assert.equal((await load(await write(notAnItem))).reason, 'corrupt', 'an item that is not an object');
    assert.equal((await load(await write([start(1), end(1, 0)]))).reason, 'empty', 'a journal with no item in it');
  }
  ok('loader: a missing record (seq gap, the result a reference points to, an item the end record counts, the start of a run), a newer version, an unknown reference kind, records out of order and an empty history are each refused with their reason');

  // B5 the interrupted tail turn
  {
    const lines = [
      start(1),
      hist(1, 0, user('three reads')),
      hist(1, 1, fcall('c1', 'read_file', { path: 'a' }), { batch: 1 }),
      full('c1', 'A'), hist(1, 2, ref('c1'), { batch: 1 }),
      hist(1, 3, said('now two at once'), { batch: 2 }),
      hist(1, 4, fcall('c2', 'read_file', { path: 'b' }), { batch: 2 }),
      hist(1, 5, fcall('c3', 'write_file', { path: 'c' }), { batch: 2 }),
      full('c2', 'B'), hist(1, 6, ref('c2'), { batch: 2 }),
    ];
    const result = await load(await write(lines));
    assert.equal(result.ok, true, result.reason);
    assert.deepEqual(plain(result.items), [user('three reads'), fcall('c1', 'read_file', { path: 'a' }), out('c1', resultText('A'))], 'the turn whose calls are not all answered is cut whole: its text, both calls and the one result');
    assert.deepEqual(result.interrupted.map(({ callId, name, result: had }) => [callId, name, had]), [['c2', 'read_file', true], ['c3', 'write_file', false]], 'and its calls are named, with whether a result was recorded');
    assert.equal(result.interrupted[1].arguments, JSON.stringify({ path: 'c' }));
    assert.deepEqual(result.calls.get('c3'), { name: 'write_file', arguments: JSON.stringify({ path: 'c' }), run: 1 }, 'the calls of the journal, cut ones too, for the note');

    // an interrupted run in the middle: cut at its own end, the next run follows
    const twoRuns = [...lines, start(2), hist(2, 0, user('go on')), hist(2, 1, fcall('d1', 'read_file', { path: 'd' }), { batch: 1 }), full('d1', 'D'), hist(2, 2, ref('d1'), { batch: 1 }), hist(2, 3, said('done'), { batch: 2 }), end(2, 4)];
    const both = await load(await write(twoRuns));
    assert.equal(both.ok, true, both.reason);
    assert.deepEqual(plain(both.items).map((item) => item.call_id ?? item.content?.[0]?.text), ['three reads', 'c1', 'c1', 'go on', 'd1', 'd1', 'done'], 'run 1 cut at its own end, run 2 after it');
    assert.deepEqual(both.interrupted, [], 'the note names the cut calls of the last run only');
    assert.equal(both.runs, 2);

    // a call that never got its result because the model sent a repeated id: the run ended there
    const repeatedIds = [start(1), hist(1, 0, user('x')), hist(1, 1, fcall('r1'), { batch: 1 }), hist(1, 2, fcall('r1'), { batch: 1 })];
    const repeatedResult = await load(await write(repeatedIds));
    assert.deepEqual(plain(repeatedResult.items), [user('x')]);
    // a final answer with no call is a complete turn
    const answered = await load(await write([start(1), hist(1, 0, user('x')), hist(1, 1, said('y'), { batch: 1 })]));
    assert.deepEqual(plain(answered.items), [user('x'), said('y')]);
  }
  ok('loader: the last turn of a run whose calls are not all answered is cut whole (Anthropic would need its thinking blocks, which are never written), at the end of every run, and its calls are named for the note');

  // B6 a run that started from the checkpoint text starts the history again
  {
    const lines = [
      start(1), hist(1, 0, user('first')), hist(1, 2, user('a gap')), // run 1 has a hole...
      start(2, 'checkpoint'), hist(2, 0, user('CONVERSATION CHECKPOINT ... (the old summary)'), { kind: 'resume_evidence' }), hist(2, 1, user('second')), hist(2, 2, said('ok'), { batch: 1 }), end(2, 3),
    ];
    const result = await load(await write(lines));
    assert.equal(result.ok, true, result.reason);
    assert.deepEqual(plain(result.items).map((item) => item.content[0].text), ['CONVERSATION CHECKPOINT ... (the old summary)', 'second', 'ok'], '...but run 2 began from the checkpoint text: its history is its own');
    const fresh = await load(await write([...lines, start(3, 'none'), hist(3, 0, user('a new task?')), end(3, 1)]));
    assert.deepEqual(plain(fresh.items).map((item) => item.content[0].text), ['a new task?']);
    const followed = await load(await write([...lines.slice(0, 3), start(2, 'journal'), hist(2, 0, user('second'))]));
    assert.equal(followed.reason, 'journal_gap', 'a run that went on from a journal with a hole keeps the hole');
  }
  ok('loader: a run that began from the checkpoint text (or as a new task) starts the history again, so a hole before it does not matter; a run that went on from the journal keeps what came before, holes included');

  // B7 the reserved summary record
  {
    const lines = [...simple, start(2), hist(2, 0, user('more')), hist(2, 1, said('fine'), { batch: 1 }), end(2, 2),
      line({ type: 'context_summary', v: 1, run: 2, through: { run: 1, seq: 1 }, item: user('SUMMARY of the start') })];
    const result = await load(await write(lines));
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.summaryApplied, true);
    assert.deepEqual(plain(result.items), [user('SUMMARY of the start'), said('a says hi'), user('more'), said('fine')], 'the items through (1, 1) are replaced by the summary; the result of the summarised call is dropped by the pairing repair');
    const two = await load(await write([...lines, line({ type: 'context_summary', v: 1, run: 2, through: { run: 1, seq: 3 }, item: user('LATER SUMMARY') })]));
    assert.deepEqual(plain(two.items), [user('LATER SUMMARY'), user('more'), said('fine')], 'only the latest summary applies');
    const nowhere = await load(await write([...simple, line({ type: 'context_summary', v: 1, run: 9, through: { run: 9, seq: 9 }, item: user('lost') })]));
    assert.equal(nowhere.summaryApplied, false, 'a summary of items that are not there is not applied');
    assert.equal(nowhere.items.length, 4);
  }
  ok('loader: the reserved context_summary record (ac-7) replaces the items through the one it names, only the latest one counts, and pairing is repaired after it');

  // B8 what is never written does not come back
  {
    const placeholder = '[Opaque model context retained only in memory for the next model request]';
    const items = [
      user('think'),
      { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'hm' }], encrypted_content: placeholder },
      { ...said('with blocks'), providerBlocks: [{ type: 'thinking', thinking: '[Private reasoning content is not part of the task transcript]', signature: placeholder }], providerBinding: { model: 'm', origin: 'o', blocks: 'x', digest: 'y' } },
      { ...fcall('g1'), providerPart: { functionCall: { name: 'read_file', args: {} }, thoughtSignature: placeholder }, providerCallId: 'p1' },
      { ...said('gemini text'), providerParts: [{ text: 'gemini text', thoughtSignature: placeholder }], reasoningContent: 'deepseek thoughts' },
    ];
    const stripped = stripOpaque(items);
    assert.deepEqual(plain(stripped), [user('think'), said('with blocks'), { ...fcall('g1'), providerCallId: 'p1' }, said('gemini text')]);
    assert.equal(items[2].providerBlocks.length, 1, 'stripOpaque copies, it does not change the items it was given');
    const result = await load(await write([start(1), ...items.map((item, seq) => hist(1, seq, item, { batch: seq ? 1 : null })), full('g1', 'G'), hist(1, 5, ref('g1'))]));
    assert.equal(result.ok, true, result.reason);
    assert.deepEqual(plain(result.items).map((item) => item.type ?? item.role), ['user', 'message', 'function_call', 'message', 'function_call_output']);
    assert.equal(JSON.stringify(result.items).includes(placeholder), false, 'no placeholder of an opaque value reaches the model');
  }
  ok('loader: Responses reasoning items, Anthropic thinking blocks and their binding, Gemini parts with their signatures and Chat reasoning text are left out (the transcript never had them); the rest of each item stays');

  // B9 the size cap
  {
    const big = 'x'.repeat(4000);
    const lines = [start(1), hist(1, 0, user('start'))];
    let seq = 1;
    for (let turn = 1; turn <= 30; turn += 1) {
      lines.push(hist(1, seq++, fcall(`t${turn}`), { batch: turn }), full(`t${turn}`, `${turn}:${big}`), hist(1, seq++, ref(`t${turn}`), { batch: turn }));
      if (turn % 10 === 0) lines.push(hist(1, seq++, user(`checkpoint ${turn}`), { kind: 'queued_message' }));
    }
    lines.push(hist(1, seq++, said('end'), { batch: 31 }));
    const file = await write(lines);
    const whole = await load(file);
    assert.equal(whole.ok, true, whole.reason);
    assert.equal(whole.dropped, 0);
    const cap = Math.floor(whole.bytes / 3);
    const result = await load(file, { maxBytes: cap });
    assert.equal(result.ok, true, result.reason);
    assert.ok(result.bytes <= cap, `under the cap (${result.bytes} <= ${cap})`);
    assert.equal(result.bytes, historyBytes(result.items));
    assert.ok(result.dropped > 0);
    assert.equal(result.items[0].role, 'user', 'the history still starts with a user message (Anthropic and Gemini need one)');
    assert.match(result.items[0].content[0].text, new RegExp(`^\\[HISTORY LEFT OUT: the first ${result.dropped} items`));
    assert.ok(result.items[1].type === 'function_call' || result.items[1].role === 'user', 'it starts again at the first item of a turn, or at a user message');
    assert.deepEqual(plain(pairToolCalls(result.items)), plain(result.items), 'no call lost its result and no result its call');
    assert.equal(result.items.at(-1).content[0].text, 'end', 'the newest items are kept');
    const more = await load(file, { maxBytes: cap + 9000 });
    assert.ok(more.items.length > result.items.length, 'a larger cap keeps more: the trim keeps as much as fits');
    assert.equal((await load(file, { maxBytes: 100 })).reason, 'too_large', 'nothing that fits: refused, not cut inside a turn');
  }
  ok('loader: a history over the cap loses its oldest whole turns, starts with a note that says how many items were left out, keeps every call with its result, and fits; one that cannot fit is too_large');

  // B10 counters, the run that is starting, the skill index of earlier runs, masking
  {
    const lines = [
      start(1), hist(1, 0, user('UNTRUSTED SKILL REFERENCES run 1'), { kind: 'skill_context' }), hist(1, 1, user('first')),
      hist(1, 2, said('answer'), { batch: 1, counters: { hookBlocks: { limit: 8, used: 0, byEvent: { Stop: 0, SubagentStop: 0, TaskCompleted: 0 } }, noticeTurns: 0, doneGate: null } }),
      hist(1, 3, user('[Hook feedback · Stop · block 1 of 8]'), { kind: 'stop_hook', counters: { hookBlocks: { limit: 8, used: 1, byEvent: { Stop: 1, SubagentStop: 0, TaskCompleted: 0 } }, noticeTurns: 0, doneGate: null } }),
      hist(1, 4, said('better answer with sk-live-1234567890abcdefgh'), { batch: 2 }),
      end(1, 5, { counters: { hookBlocks: { limit: 8, used: 1, byEvent: { Stop: 1, SubagentStop: 0, TaskCompleted: 0 } }, noticeTurns: 2, doneGate: null } }),
      start(2), hist(2, 0, user('UNTRUSTED SKILL REFERENCES run 2'), { kind: 'skill_context' }), hist(2, 1, user('second')),
    ];
    const file = await write(lines);
    const asOfRun2 = await load(file, { beforeRun: 2 });
    assert.equal(asOfRun2.ok, true, asOfRun2.reason);
    assert.equal(asOfRun2.runs, 1, 'the run that is starting is not read');
    assert.deepEqual(asOfRun2.counters, { hookBlocks: { limit: 8, used: 1, byEvent: { Stop: 1, SubagentStop: 0, TaskCompleted: 0 } }, noticeTurns: 2, doneGate: null }, 'the latest counters of the last run read (its end record)');
    assert.equal(asOfRun2.items.some((item) => /SKILL REFERENCES/.test(item.content?.[0]?.text ?? '')), false, 'a seed carries no skill index: the run that starts writes its own');
    const all = await load(file);
    assert.deepEqual(plain(all.items).filter((item) => item.role === 'user').map((item) => item.content[0].text), ['first', '[Hook feedback · Stop · block 1 of 8]', 'UNTRUSTED SKILL REFERENCES run 2', 'second'], 'read whole, the skill index of the last run stays and the earlier ones go');
    assert.deepEqual(all.counters, { hookBlocks: null, noticeTurns: 0, doneGate: null });
    const masked = await load(file, { redact: (text) => text.replaceAll('sk-live-1234567890abcdefgh', '[REDACTED]') });
    assert.equal(JSON.stringify(masked.items).includes('sk-live-1234567890abcdefgh'), false, 'the loader masks with the redaction it is given');
    assert.ok(JSON.stringify(masked.items).includes('better answer with [REDACTED]'));
    const media = await load(await write([start(1), hist(1, 0, { role: 'user', content: [{ type: 'input_text', text: 'look' }, { type: 'input_image', image_url: `data:image/png;base64,${PNG}`, detail: 'auto' }] })]), { redact: () => 'MASKED' });
    assert.equal(media.items[0].content[1].image_url, `data:image/png;base64,${PNG}`, 'picture bytes are never passed through the masking');
    assert.equal(media.items[0].content[0].text, 'MASKED');
  }
  ok('loader: the counters of the last run read are returned (reserved doneGate included), the run that is starting is not read, a seed carries no skill index of earlier runs, every string except picture bytes is masked with the redaction of the process that loads');

  // ------------------------------------------------------------------------------------------------------------------------------
  // C. Five conversations through the real runner, the real adapters and the strict mock server
  // ------------------------------------------------------------------------------------------------------------------------------
  const TOOLS = ['read_file', 'write_file', 'run_command', 'screenshot'].map((name) => ({ name: `local.${name}`, server: 'local', originalName: name, description: `${name} tool`, inputSchema: { type: 'object', properties: { path: { type: 'string' }, command: { type: 'string' } } } }));
  const SECRET = 'hunter2-secret-value-42';
  const LOG = Array.from({ length: 400 }, (_, i) => (i % 40 === 0 ? `step ${i} ok` : 'same noisy line of the build')).join('\n');
  const results = {
    'local.read_file': (args) => ({ content: [{ type: 'text', text: args.path === 'secret.txt' ? `the key is ${SECRET}` : `content of ${args.path}` }] }),
    'local.write_file': (args) => ({ content: [{ type: 'text', text: `wrote ${args.path}` }] }),
    'local.run_command': () => ({ content: [{ type: 'text', text: `exit code 0 · pwsh\n--- stdout ---\n${LOG}` }] }),
    'local.screenshot': () => ({ content: [{ type: 'text', text: 'a picture' }, { type: 'image', data: PNG, mimeType: 'image/png' }] }),
  };
  const makeManager = (root, { hang = null } = {}) => {
    const manager = {
      secrets: [], generation: 1, instanceId: 'session-resume', locked: false, calls: [],
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
            return results[name](args);
          },
        };
      },
    };
    return manager;
  };
  const FORMATS = { chat: 'openai-chat', responses: 'openai-responses', anthropic: 'anthropic', gemini: 'gemini' };
  const settle = (runner, label, ms = 30000) => Promise.race([runner.context.done.promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${label}: timed out`)), ms))]);
  const records = async (directory, id) => (await fs.readFile(path.join(directory, id, 'transcript.jsonl'), 'utf8')).split('\n').filter(Boolean).map((text) => JSON.parse(text));
  /** The calls and the results of a request body, per protocol. Gemini names its calls (the mock gives no ids). */
  const wire = (protocol, body) => {
    const callIds = [], outputs = [];
    if (protocol === 'chat') for (const message of body.messages) { for (const toolCall of message.tool_calls ?? []) callIds.push(toolCall.id); if (message.role === 'tool') outputs.push({ id: message.tool_call_id, text: message.content }); }
    if (protocol === 'responses') for (const item of body.input) { if (item.type === 'function_call') callIds.push(item.call_id); if (item.type === 'function_call_output') outputs.push({ id: item.call_id, text: item.output }); }
    if (protocol === 'anthropic') for (const message of body.messages) for (const block of Array.isArray(message.content) ? message.content : []) { if (block.type === 'tool_use') callIds.push(block.id); if (block.type === 'tool_result') outputs.push({ id: block.tool_use_id, text: typeof block.content === 'string' ? block.content : JSON.stringify(block.content) }); }
    if (protocol === 'gemini') for (const content of body.contents) for (const part of content.parts ?? []) { if (part.functionCall) callIds.push(part.functionCall.name); if (part.functionResponse) outputs.push({ id: part.functionResponse.name, text: JSON.stringify(part.functionResponse.response) }); }
    return { callIds, outputs };
  };
  const RESUME_PROMPT = 'Go on: one more look.';
  // A step is chosen by the number of results so far (ctx.turn): after a turn with two calls the next step is two further on.
  const unused = say('(never reached)');
  const scenarios = {
    chat: [call('read_file', { path: 'a.txt' }), call('read_file', { path: 'b.txt' }), call('screenshot', {})],
    responses: [thinking('look at two files', calls(['read_file', { path: 'a.txt' }], ['read_file', { path: 'b.txt' }])), unused, thinking('and a picture', call('screenshot', {}))],
    anthropic: [thinking('first a', call('read_file', { path: 'a.txt' })), thinking('then b', call('read_file', { path: 'b.txt' })), call('screenshot', {})],
    gemini: [thinking('two at once', calls(['read_file', { path: 'a.txt' }], ['read_file', { path: 'b.txt' }])), unused, call('screenshot', {})],
    router: [call('mcp_catalog', { filter: null, offset: 0, limit: 5 }), call('mcp_call', { name: 'nope.tool', arguments_json: '{}' }), call('read_file', { path: 'a.txt' })],
  };
  const opaque = {
    chat: () => true,
    router: () => true,
    responses: (items) => items.some((item) => item.type === 'reasoning' && typeof item.encrypted_content === 'string'),
    anthropic: (items) => items.some((item) => Array.isArray(item.providerBlocks) && item.providerBlocks.length > 0),
    gemini: (items) => items.some((item) => typeof item.providerPart?.thoughtSignature === 'string'),
  };
  for (const [name, steps] of Object.entries(scenarios)) {
    const protocol = name === 'router' ? 'chat' : name;
    const root = path.join(temp, `c-${name}`);
    await fs.mkdir(root, { recursive: true });
    const manager = makeManager(root);
    const probe = { callsAtResume: null };
    const script = (ctx) => {
      if (ctx.prompt.includes(RESUME_PROMPT)) {
        if (ctx.turn === 0) { probe.callsAtResume = manager.calls.length; return call('read_file', { path: 'again.txt' }); }
        return say('Second answer.');
      }
      return sequence(protocol === 'chat' ? steps : [...steps, () => thinking('closing', say('First answer.'))], { final: 'First answer.' })(ctx);
    };
    const mock = await startMockModel({ scenario: 'resume', scenarios: { resume: script }, strict: true, keepBodies: true, bindThinking: protocol === 'anthropic' });
    closers.push(() => mock.close());
    const gateway = new GatewayProvider({ directory: path.join(root, 'gateway'), bundleRoot: root, manager, env: {}, sleep: async () => {} });
    const provider = gateway.forkForTask({ protocol: FORMATS[protocol], apiBaseUrl: mock.origin, model: 'mock-coder' });
    const tasks = path.join(root, 'tasks');
    const runner = new AgentRunner({ manager, provider, taskDirectory: tasks });
    await runner.load();
    const started = await runner.start({ prompt: 'Look at the project and the screen.' });
    const first = await settle(runner, `${name} run 1`);
    assert.equal(first.status, 'completed', `${name}: ${first.error ?? ''} ${JSON.stringify(mock.state.rejections.at(-1)?.errors?.[0] ?? null)}`);
    const memory1 = finished.at(-1);
    assert.ok(opaque[name](memory1), `${name}: (premise) the history in memory held the opaque reasoning of this protocol`);
    const journal1 = await runner.historyFromJournal(started.id);
    assert.equal(journal1.ok, true, `${name}: ${journal1.reason}`);
    assert.deepEqual(plain(journal1.items), plain(stripOpaque(memory1)), `${name}: the journal read back equals the history in memory at the end of run 1, less the opaque reasoning`);
    const run1Calls = memory1.filter((item) => item.type === 'function_call');
    const run1Outputs = memory1.filter((item) => item.type === 'function_call_output');
    assert.ok(run1Calls.length >= 3, `${name}: (premise) run 1 made ${run1Calls.length} calls`);

    const toolCallsBefore = manager.calls.length;
    const requestsBefore = mock.state.requests.length;
    await runner.continue({ id: started.id, prompt: RESUME_PROMPT });
    const second = await settle(runner, `${name} run 2`);
    assert.equal(second.status, 'completed', `${name} run 2: ${second.error ?? ''} ${JSON.stringify(mock.state.rejections.at(-1)?.errors?.[0] ?? null)}`);
    assert.deepEqual(mock.state.requests.map((request) => request.rejected), Array(mock.state.requests.length).fill(null), `${name}: the strict server refused nothing, the resumed requests included`);
    assert.equal(probe.callsAtResume, toolCallsBefore, `${name}: when the model was first asked in run 2, no tool had run since run 1 (0 calls replayed)`);
    const body = mock.state.requests[requestsBefore].body;
    const sent = wire(protocol, body);
    if (protocol === 'gemini') {
      assert.equal(sent.outputs.length, run1Outputs.length, 'gemini: every earlier result is in the first request');
    } else {
      for (const item of run1Calls) assert.ok(sent.callIds.includes(item.call_id), `${name}: the earlier call ${item.call_id} is in the first request`);
      for (const item of run1Outputs) assert.ok(sent.outputs.some((entry) => entry.id === item.call_id), `${name}: the earlier result of ${item.call_id} is in the first request, under its call id`);
    }
    for (const text of name === 'router' ? ['content of a.txt', '"total"'] : ['content of a.txt', 'a picture']) assert.ok(sent.outputs.some((entry) => entry.text.includes(text)), `${name}: the earlier result "${text}" reached the model again`);
    assert.ok(JSON.stringify(body).includes(RESUME_NOTE_HEADER), `${name}: the short resumed note is there`);
    assert.equal(JSON.stringify(body).includes('CONVERSATION CHECKPOINT'), false, `${name}: and not the old checkpoint text`);
    const memory2 = finished.at(-1);
    const journal2 = await runner.historyFromJournal(started.id);
    assert.equal(journal2.ok, true, journal2.reason);
    assert.deepEqual(plain(journal2.items), plain(stripOpaque(memory2)), `${name}: at the end of run 2, the journal again equals the history in memory (the seed and run 2)`);
    const written = await records(tasks, started.id);
    const runStarts = written.filter((record) => record.type === 'history_run');
    assert.deepEqual(runStarts.map((record) => [record.v, record.run, record.seed.source]), [[JOURNAL_VERSION, 1, 'none'], [JOURNAL_VERSION, 2, 'journal']], `${name}: two runs, the second seeded from the journal`);
    assert.deepEqual(runStarts[0].counters, { hookBlocks: null, noticeTurns: 0, doneGate: null }, `${name}: the counters are carried (doneGate reserved)`);
    assert.deepEqual(written.filter((record) => record.type === 'history_end').map((record) => record.run), [1, 2]);
    assert.equal(written.some((record) => record.type === 'resume_fallback' || record.type === 'history' && record.v !== JOURNAL_VERSION), false);
    if (name === 'router') {
      const refs = written.filter((record) => record.type === 'history' && record.item.type === 'function_call_output');
      assert.deepEqual(refs.slice(0, 3).map((record) => record.item.output_ref ?? 'inline'), ['catalog_result', 'inline', 'tool_result_full'], 'router: a catalog result is a reference to its catalog_result record, an argument error is written as it is, a tool result refers to its tool_result_full');
    }
    await runner.shutdown();
  }
  ok('five conversations (Chat, Responses with reasoning, Anthropic with thinking, Gemini with signatures, Chat with the router and an argument error) through the real runner and the strict mock: the journal equals the history in memory at the end of each run less the opaque reasoning; the resumed run\'s first request carries every earlier call and result under its call id, the short note and no checkpoint text, nothing ran again, and the strict server refused nothing');

  // ------------------------------------------------------------------------------------------------------------------------------
  // D. The Hub died while a call that changes files was running
  // ------------------------------------------------------------------------------------------------------------------------------
  {
    const root = path.join(temp, 'd-killed');
    await fs.mkdir(root, { recursive: true });
    const manager = makeManager(root, { hang: (name) => name === 'local.write_file' });
    const steps = [call('read_file', { path: 'a.txt' }), call('read_file', { path: 'b.txt' }), call('read_file', { path: 'c.txt' }), call('write_file', { path: 'calc.js' })];
    const probe = { callsAtResume: null, users: null };
    const after = { manager: null };
    const script = (ctx) => {
      if (ctx.prompt.includes('Continue where you stopped.')) {
        if (ctx.turn === 0) { probe.callsAtResume = after.manager.calls.length; probe.users = ctx.users; return call('read_file', { path: 'calc.js' }); }
        return say('calc.js is as it was; I did not write it again.');
      }
      return sequence(steps)(ctx);
    };
    const mock = await startMockModel({ scenario: 'kill', scenarios: { kill: script }, strict: true, keepBodies: true });
    closers.push(() => mock.close());
    const gatewayOf = (manager, label) => new GatewayProvider({ directory: path.join(root, `gateway-${label}`), bundleRoot: root, manager, env: {}, sleep: async () => {} }).forkForTask({ protocol: 'openai-chat', apiBaseUrl: mock.origin, model: 'mock-coder' });
    const tasks = path.join(root, 'tasks');
    const runner = new AgentRunner({ manager, provider: gatewayOf(manager, 'before'), taskDirectory: tasks });
    await runner.load();
    const started = await runner.start({ prompt: 'Read three files, then fix calc.js.' });
    const deadline = Date.now() + 20000;
    while (!(manager.calls.length === 4 && runner.get(started.id)?.pendingCall?.toolName === 'local.write_file')) {
      if (Date.now() > deadline) throw new Error('the write never started');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await runner.writes.get(started.id);
    // What a Hub killed at this moment leaves on disk: copy it, then let this one go.
    const crashed = path.join(root, 'tasks-after-crash');
    await fs.cp(tasks, crashed, { recursive: true });
    await runner.cancel(started.id);
    await runner.shutdown();

    const manager2 = makeManager(root);
    after.manager = manager2;
    const revived = new AgentRunner({ manager: manager2, provider: gatewayOf(manager2, 'after'), taskDirectory: crashed });
    await revived.load();
    const paused = revived.get(started.id);
    assert.deepEqual([paused.status, paused.errorCode, paused.state], ['paused', 'process_interrupted', 'uncertain'], 'after the restart: paused, interrupted, uncertain');
    assert.equal(paused.pendingCall?.toolName, 'local.write_file');
    const requestsBefore = mock.state.requests.length;
    await revived.continue({ id: started.id, prompt: 'Continue where you stopped.' });
    const done = await settle(revived, 'killed run resumed');
    assert.equal(done.status, 'completed', `${done.error ?? ''} ${JSON.stringify(mock.state.rejections.at(-1)?.errors?.[0] ?? null)}`);
    assert.equal(probe.callsAtResume, 0, 'when the model was first asked, nothing had run in the new process');
    assert.deepEqual(manager2.calls.map((entry) => entry.name), ['local.read_file'], 'and afterwards only the read the model asked for: the write was never run again');
    const body = mock.state.requests[requestsBefore].body;
    const sent = wire('chat', body);
    const originalCalls = (await records(crashed, started.id)).filter((record) => record.type === 'history' && record.run === 1 && record.item.type === 'function_call').map((record) => record.item);
    assert.equal(originalCalls.length, 4, '(premise) run 1 wrote four calls');
    assert.deepEqual(sent.outputs.map((entry) => entry.id), originalCalls.slice(0, 3).map((item) => item.call_id), 'the first request carries the three completed results, under their call ids');
    assert.deepEqual(sent.callIds, originalCalls.slice(0, 3).map((item) => item.call_id), 'and their calls; the interrupted write is not in the history');
    for (const file of ['a.txt', 'b.txt', 'c.txt']) assert.ok(sent.outputs.some((entry) => entry.text.includes(`content of ${file}`)));
    const note = probe.users.find((text) => text.startsWith(RESUME_NOTE_HEADER)) ?? '';
    assert.match(note, /UNVERIFIED OPERATIONS[^\n]*\n- local\.write_file \(call [^)]*executing\): \{"path":"calc\.js"\}/, 'the note lists the write as unverified, with its arguments');
    assert.match(note, /Do NOT replay/);
    assert.match(note, /PREVIOUS RUN ENDED: paused \(process_interrupted\)/);
    assert.match(note, /CALLS OF THE INTERRUPTED TURN[^\n]*\n- write_file \(call [^)]*\): no result was recorded/);
    assert.ok(probe.users.indexOf(note) < probe.users.length - 1 && probe.users.at(-1) === 'Continue where you stopped.', 'the note comes before the person\'s request');
  }
  ok('a Hub that died while a write was running (its files copied mid-call): the resumed run\'s first request carries the 3 completed results with their call ids and not the interrupted turn, the write is listed as unverified with its arguments, and nothing ran again');

  // ------------------------------------------------------------------------------------------------------------------------------
  // E. A task written before the journal, and a journal with a hole
  // ------------------------------------------------------------------------------------------------------------------------------
  {
    const root = path.join(temp, 'e-legacy');
    const tasks = path.join(root, 'tasks');
    const id = randomUUID();
    await fs.mkdir(path.join(tasks, id), { recursive: true });
    const at = '2026-01-01T00:00:00.000Z';
    const old = {
      formatVersion: 1, id, prompt: 'Old request about calc.js', status: 'completed', workspace: { path: root, generation: 1, instanceId: 'session-resume' },
      model: 'mock-coder', provider: null, createdAt: at, startedAt: at, updatedAt: at, finishedAt: at, finalText: 'Old answer: calc.js adds.', error: null, errorCode: null,
      steps: 2, toolCalls: 1, maxSteps: null, maxMinutes: null, usage: { inputTokens: 1, outputTokens: 1, httpRequests: 2 },
      events: [{ at, type: 'tool_result', message: 'content of calc.js', toolName: 'local.read_file', status: 'completed' }], eventCount: 1, pendingCall: null,
      prompts: [{ at, text: 'Old request about calc.js' }], runs: [{ startedAt: at, finishedAt: at, status: 'completed', startStep: 0 }], dialogue: [],
    };
    await fs.writeFile(path.join(tasks, id, 'task.json'), JSON.stringify(old));
    await fs.writeFile(path.join(tasks, id, 'transcript.jsonl'), [
      JSON.stringify({ at, type: 'started', message: 'started' }),
      JSON.stringify({ at, type: 'model_response', step: 1, response: { output: [fcall('old1', 'read_file', { path: 'calc.js' })] } }),
      JSON.stringify({ at, type: 'tool_result_full', toolName: 'local.read_file', call_id: 'old1', result: { content: [{ type: 'text', text: 'content of calc.js' }] } }),
      JSON.stringify({ at, type: 'completed', message: 'done' }),
    ].join('\n') + '\n');
    await fs.mkdir(root, { recursive: true });
    const manager = makeManager(root);
    const seen = [];
    const mock = await startMockModel({ scenario: 'legacy', scenarios: { legacy: (ctx) => { seen.push(ctx.users); return say('Continued.'); } }, strict: true, keepBodies: true });
    closers.push(() => mock.close());
    const provider = new GatewayProvider({ directory: path.join(root, 'gateway'), bundleRoot: root, manager, env: {}, sleep: async () => {} }).forkForTask({ protocol: 'openai-chat', apiBaseUrl: mock.origin, model: 'mock-coder' });
    const runner = new AgentRunner({ manager, provider, taskDirectory: tasks });
    await runner.load();
    assert.equal((await runner.historyFromJournal(id)).reason, 'no_journal');
    await runner.continue({ id, prompt: 'And now?' });
    const done = await settle(runner, 'legacy');
    assert.equal(done.status, 'completed', done.error ?? '');
    const fallback = done.events.find((entry) => entry.type === 'resume_fallback');
    assert.ok(fallback, 'a resume_fallback event says why the checkpoint text was used');
    const transcript = await records(tasks, id);
    assert.equal(transcript.find((record) => record.type === 'resume_fallback')?.detail?.reason, 'no_journal');
    assert.equal(transcript.find((record) => record.type === 'history_run')?.seed?.source, 'checkpoint');
    assert.equal(transcript.find((record) => record.type === 'history_run')?.seed?.reason, 'no_journal');
    const users = seen[0].join('\n');
    assert.match(users, /^CONVERSATION CHECKPOINT/m, 'the model got the checkpoint text, as before');
    assert.match(users, /Old request about calc\.js/);
    assert.equal(users.includes(RESUME_NOTE_HEADER), false);
    // the next run reads the journal that run 2 wrote: the checkpoint text of the old run is part of it
    const again = await runner.historyFromJournal(id);
    assert.equal(again.ok, true, again.reason);
    assert.match(again.items[0].content[0].text, /^CONVERSATION CHECKPOINT/, 'from now on the journal carries the checkpoint text as the start of the history');

    // a hole in the journal: the next run falls back instead of sending a history with a gap
    const file = path.join(tasks, id, 'transcript.jsonl');
    const lines = (await fs.readFile(file, 'utf8')).split('\n');
    const victim = lines.findIndex((text) => text.includes('"type":"history"') && text.includes('"seq":1'));
    assert.ok(victim > 0);
    lines.splice(victim, 1);
    await fs.writeFile(file, lines.join('\n'));
    await runner.continue({ id, prompt: 'Once more?' });
    const holed = await settle(runner, 'hole');
    assert.equal(holed.status, 'completed', holed.error ?? '');
    assert.equal((await records(tasks, id)).filter((record) => record.type === 'resume_fallback').at(-1)?.detail?.reason, 'journal_gap');
    assert.match(seen.at(-1).join('\n'), /^CONVERSATION CHECKPOINT/m);
    await runner.shutdown();
  }
  ok('a task written before the journal existed, and one whose journal lost a record: the run goes on from the checkpoint text, as before, with a resume_fallback event that names the reason (no_journal, journal_gap); the run that fell back starts a journal of its own');

  // ------------------------------------------------------------------------------------------------------------------------------
  // F. A 60 MB transcript
  // ------------------------------------------------------------------------------------------------------------------------------
  {
    const root = path.join(temp, 'f-large');
    const tasks = path.join(root, 'tasks');
    const id = randomUUID();
    await fs.mkdir(path.join(tasks, id), { recursive: true });
    const at = '2026-11-21T00:00:00.000Z';
    await fs.writeFile(path.join(tasks, id, 'task.json'), JSON.stringify({
      formatVersion: 1, id, prompt: 'Big', status: 'completed', workspace: { path: root, generation: 1, instanceId: 'session-resume' }, model: 'mock-coder', provider: null,
      createdAt: at, startedAt: at, updatedAt: at, finishedAt: at, finalText: 'Done.', error: null, errorCode: null, steps: 1, toolCalls: 1, maxSteps: null, maxMinutes: null,
      usage: { inputTokens: 0, outputTokens: 0, httpRequests: 0 }, events: [], eventCount: 0, pendingCall: null, prompts: [{ at, text: 'Big' }], runs: [{ startedAt: at, finishedAt: at, status: 'completed', startStep: 0 }], dialogue: [],
    }));
    const handle = await fs.open(path.join(tasks, id, 'transcript.jsonl'), 'w');
    const chunk = ('0123456789abcdef'.repeat(8) + '\n').repeat(1600); // about 210 KB of text per result
    let seq = 0;
    await handle.write(JSON.stringify({ at, type: 'history_run', v: 1, run: 1, seed: { source: 'none', items: 0, bytes: 2, dropped: 0, cut: 0 }, counters: { hookBlocks: null, noticeTurns: 0, doneGate: null } }) + '\n');
    await handle.write(JSON.stringify({ at, type: 'history', v: 1, run: 1, seq: seq++, role: 'user', kind: 'prompt', batch: null, item: user('Big') }) + '\n');
    for (let turn = 1; turn <= 300; turn += 1) {
      const callId = `big_${turn}`;
      const item = fcall(callId, 'read_file', { path: `part-${turn}.txt` });
      await handle.write(JSON.stringify({ at, type: 'model_response', step: turn, response: { status: 'completed', output: [item] } }) + '\n');
      await handle.write(JSON.stringify({ at, type: 'history', v: 1, run: 1, seq: seq++, role: 'model', kind: 'model_output', batch: turn, item }) + '\n');
      await handle.write(JSON.stringify({ at, type: 'tool_start', message: 'read', state: 'running', toolName: 'local.read_file', callId }) + '\n');
      await handle.write(JSON.stringify({ at, type: 'tool_result_full', toolName: 'local.read_file', call_id: callId, result: { content: [{ type: 'text', text: `${turn}\n${chunk}` }] } }) + '\n');
      await handle.write(JSON.stringify({ at, type: 'history', v: 1, run: 1, seq: seq++, role: 'tool', kind: 'tool_output', batch: turn, item: ref(callId) }) + '\n');
    }
    await handle.write(JSON.stringify({ at, type: 'history', v: 1, run: 1, seq: seq++, role: 'model', kind: 'model_output', batch: 301, item: said('Done.') }) + '\n');
    await handle.write(JSON.stringify({ at, type: 'history_end', v: 1, run: 1, items: seq }) + '\n');
    await handle.close();
    const size = (await fs.stat(path.join(tasks, id, 'transcript.jsonl'))).size;
    assert.ok(size > 60_000_000, `(premise) the transcript is ${size} bytes`);
    await fs.mkdir(root, { recursive: true });
    const manager = makeManager(root);
    const provider = new GatewayProvider({ directory: path.join(root, 'gateway'), bundleRoot: root, manager, env: {}, sleep: async () => {} }).forkForTask({ protocol: 'openai-chat', apiBaseUrl: 'http://127.0.0.1:9', model: 'mock-coder' });
    const runner = new AgentRunner({ manager, provider, taskDirectory: tasks });
    await runner.load();
    const begin = performance.now();
    const loaded = await runner.historyFromJournal(id);
    const elapsed = performance.now() - begin;
    assert.equal(loaded.ok, true, loaded.reason);
    assert.ok(loaded.bytes <= MAX_CONTEXT_BYTES, `under the 48 MiB cap (${loaded.bytes})`);
    assert.ok(loaded.dropped > 0, '(premise) the whole history did not fit');
    assert.equal(loaded.items.at(-1).content[0].text, 'Done.');
    assert.deepEqual(loaded.items.slice(1).map((item) => item.call_id ?? 'text'), pairToolCalls(loaded.items).slice(1).map((item) => item.call_id ?? 'text'));
    assert.ok(elapsed < 2000, `loaded in ${Math.round(elapsed)} ms (< 2000)`);
    console.log(`  note - ${Math.round(size / 1e6)} MB transcript: ${loaded.items.length} items, ${Math.round(loaded.bytes / 1048576)} MiB, ${loaded.dropped} items left out, ${Math.round(elapsed)} ms`);
    await runner.shutdown();
  }
  ok('a 60 MB transcript: the journal loads under the 48 MiB cap (the oldest turns left out, every call with its result) in under 2 s');

  // ------------------------------------------------------------------------------------------------------------------------------
  // G. Masking with the current secret list, the optimiser's receipts, a result written once
  // ------------------------------------------------------------------------------------------------------------------------------
  {
    const root = path.join(temp, 'g-mask');
    await fs.mkdir(root, { recursive: true });
    const manager = makeManager(root);
    const mock = await startMockModel({ scenario: 'mask', scenarios: { mask: sequence([call('read_file', { path: 'secret.txt' }), call('run_command', { command: 'npm test' })], { final: 'Read and ran.' }) }, strict: true });
    closers.push(() => mock.close());
    const provider = new GatewayProvider({ directory: path.join(root, 'gateway'), bundleRoot: root, manager, env: {}, sleep: async () => {} }).forkForTask({ protocol: 'openai-chat', apiBaseUrl: mock.origin, model: 'mock-coder' });
    const tasks = path.join(root, 'tasks');
    const runner = new AgentRunner({ manager, provider, taskDirectory: tasks });
    await runner.load();
    const started = await runner.start({ prompt: 'Read the secret file and run the tests.' });
    assert.equal((await settle(runner, 'mask')).status, 'completed');
    const memory = finished.at(-1);
    const commandOutput = memory.find((item) => item.type === 'function_call_output' && String(item.output).includes('stdout'));
    assert.match(String(commandOutput.output), /TOKEN OPTIMIZED/, '(premise) the optimiser shortened the command output in memory');
    manager.secrets = [SECRET];
    const loaded = await runner.historyFromJournal(started.id);
    assert.equal(loaded.ok, true, loaded.reason);
    const text = JSON.stringify(loaded.items);
    assert.equal(text.includes(SECRET), false, 'a secret the loading process knows is masked in the replay');
    assert.ok(text.includes('the key is [REDACTED]'));
    const replayedCommand = loaded.items.find((item) => item.type === 'function_call_output' && item.call_id === commandOutput.call_id);
    assert.equal(String(replayedCommand.output).includes('TOKEN OPTIMIZED'), false, 'the receipts of the optimiser live in memory only: the replay is the whole output');
    assert.ok(String(replayedCommand.output).includes('same noisy line of the build\\nsame noisy line'), 'with every line');
    const raw = await fs.readFile(path.join(tasks, started.id, 'transcript.jsonl'), 'utf8');
    assert.ok(raw.includes(SECRET), '(documented) a line written while the secret was not known still holds it on disk');
    const outputLine = raw.split('\n').find((entry) => entry.includes('"type":"history"') && entry.includes(`"call_id":"${commandOutput.call_id}"`) && entry.includes('function_call_output'));
    assert.ok(outputLine && outputLine.length < 400, `the history record of a tool output refers to its result record (${outputLine?.length} bytes), it does not copy it`);
    assert.equal(raw.split('\n').filter((entry) => entry.includes('"type":"history"') && entry.includes('same noisy line of the build')).length, 0, 'no history record copies a tool output');
    await runner.shutdown();
  }
  ok('the replay is masked with the secret list of the process that loads it (a line written before the secret was known still holds it on disk), an output the optimiser shortened comes back whole, and a tool result is written once: its history record refers to it');
} finally {
  HistoryLedger.prototype.clear = realClear;
  for (const close of closers) await close().catch(() => {});
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }).catch(() => {});
}

console.log(`PASS: ${checks} checks (session resume)`);
