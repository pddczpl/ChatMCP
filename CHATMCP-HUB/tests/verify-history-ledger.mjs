// HistoryLedger (lib/history-ledger.mjs): the one writer of the model history.
//
// What this proves, on the real code:
//   1. The ledger's own rules (order, batches that defer host messages, the append hook, its guards, its running size).
//   2. G1-1: across randomized batches with host messages injected at every position (a recovery hint, a Stop-hook continue
//      message, a completion notice), the conversation the REAL converters build for Chat Completions, Responses and
//      Anthropic never has a tool message after a user message that follows an assistant message with tool calls. The same
//      random plan written into a plain array the old way (every host message appended the moment it arrives) is the
//      negative control: the checker must find the defect there, or a clean count would mean nothing.
//   3. A snapshot of a 20 MB history is cheap (the agent used to deep-clone the whole history on every step).
//   4. The adapters and compaction passes only READ the items a shallow snapshot shares with the ledger.
//   5. The real AgentRunner: a turn with two tool calls whose first result triggers a recovery hint puts the hint after BOTH
//      results, and no step deep-clones the history.
//
// The random plan is seeded: CHATMCP_LEDGER_SEED=<integer> repeats a run, and the seed is printed.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { HistoryLedger } from '../lib/history-ledger.mjs';
import { compactHistory, estimateTokens, pairToolCalls } from '../lib/model-history.mjs';
import { buildChatBody } from '../lib/openai-chat-api.mjs';
import { asResponsesInput, buildResponsesBody, respondOpenAIResponses } from '../lib/openai-responses-api.mjs';
import { buildAnthropicBody } from '../lib/anthropic-api.mjs';
import { respondStandard } from '../lib/standard-adapter.mjs';
import { asGeminiContents } from '../lib/gateway-provider.mjs';
import { geminiTextEnvelope } from '../lib/gemini-compat.mjs';
import { compactConversationHistory, compactRollingContext, estimateTokens as estimateContextTokens } from '../lib/context-compaction.mjs';
import { AgentRunner } from '../lib/agent.mjs';

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
const note = (message) => console.log(`  note - ${message}`);

const SEED = Number.parseInt(process.env.CHATMCP_LEDGER_SEED ?? '', 10) || 0x1ed6e4;
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
note(`random seed ${SEED} (CHATMCP_LEDGER_SEED=<integer> repeats a run)`);

const text = (value) => [{ type: 'input_text', text: value }];
const call = (id, name = 'read_file', args = {}) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args), status: 'completed' });
const assistantText = (value, phase = 'commentary') => ({ type: 'message', role: 'assistant', phase, content: [{ type: 'output_text', text: value }] });
const shape = (items) => items.map((item) => (item.role === 'user' ? `user:${item.content[0].text}`
  : item.type === 'function_call' ? `call:${item.call_id}`
  : item.type === 'function_call_output' ? `out:${item.call_id}`
  : item.type === 'message' ? 'assistant' : item.type));
const fails = (fn, code, label) => {
  let error = null;
  try { fn(); } catch (caught) { error = caught; }
  assert.ok(error, `${label}: it must throw`);
  assert.equal(error.code, code, `${label}: error code (${error.message})`);
};

// ---------------------------------------------------------------------------------------------------------------------
// 1. The ledger's own rules
// ---------------------------------------------------------------------------------------------------------------------
{
  const ledger = new HistoryLedger();
  const parts = text('hello');
  ledger.appendUser(parts, { kind: 'prompt' });
  parts[0].text = 'changed by the caller afterwards';
  const output = [assistantText('thinking'), call('c1')];
  ledger.appendModelOutput(output);
  output[1].name = 'changed by the caller afterwards';
  ledger.appendToolOutput('c1', 'result');
  assert.deepEqual(ledger.snapshotForModel(), [
    { role: 'user', content: text('hello') },
    assistantText('thinking'),
    call('c1'),
    { type: 'function_call_output', call_id: 'c1', output: 'result' },
  ]);
  assert.equal(ledger.length, 4);
  ok('items are appended in order, and the ledger keeps its own copy of what it was handed');
}

{
  const ledger = new HistoryLedger();
  ledger.appendUser(text('a'));
  const first = ledger.snapshotForModel();
  ledger.appendUser(text('b'));
  assert.equal(first.length, 1, 'a snapshot does not grow when the ledger does');
  first.push({ role: 'user' });
  first[0] = null;
  first.length = 0;
  assert.equal(ledger.length, 2, 'writing to a snapshot never reaches the ledger');
  assert.equal(ledger.snapshotForModel()[0].content[0].text, 'a');
  const one = ledger.snapshotForModel();
  const two = ledger.snapshotForModel();
  assert.notEqual(one, two, 'every snapshot is a new array (the compaction pass writes into the array it is given)');
  assert.equal(one[0], two[0], 'but the items are shared: it is a shallow copy, not a deep clone');
  ok('snapshotForModel() is a fresh shallow copy: independent array, shared items');
}

{
  const ledger = new HistoryLedger();
  ledger.appendUser(text('prompt'));
  assert.equal(ledger.batchOpen, false);
  const batch = ledger.beginBatch();
  assert.equal(ledger.batchOpen, true);
  assert.equal(typeof batch, 'number');
  ledger.appendModelOutput([call('a'), call('b'), call('c')]);
  ledger.appendToolOutput('a', 'ra');
  ledger.appendUser(text('HINT'), { kind: 'recovery_hint' });
  ledger.appendToolOutput('b', 'rb');
  ledger.appendUser(text('NOTICE'), { kind: 'completion_notice' });
  assert.deepEqual(shape(ledger.snapshotForModel()), ['user:prompt', 'call:a', 'call:b', 'call:c', 'out:a', 'out:b'], 'host messages wait while the batch is open');
  assert.equal(ledger.deferredCount, 2);
  assert.equal(ledger.length, 6, 'a waiting message is not part of the history yet');
  ledger.appendToolOutput('c', 'rc');
  assert.equal(ledger.endBatch(), 2, 'endBatch reports how many messages it released');
  assert.deepEqual(shape(ledger.snapshotForModel()), ['user:prompt', 'call:a', 'call:b', 'call:c', 'out:a', 'out:b', 'out:c', 'user:HINT', 'user:NOTICE'], 'they follow the last result, in the order they arrived');
  assert.equal(ledger.batchOpen, false);
  assert.equal(ledger.deferredCount, 0);
  ledger.appendUser(text('LATER'));
  assert.equal(shape(ledger.snapshotForModel()).at(-1), 'user:LATER', 'with no batch open a message is appended at once');
  ok('beginBatch/endBatch: host messages that arrive inside a model turn follow all of its results, in arrival order');
}

{
  const ledger = new HistoryLedger();
  assert.equal(ledger.endBatch(), 0, 'closing a batch that is not open is a no-op (the agent closes at the top of every loop)');
  ledger.beginBatch();
  fails(() => ledger.beginBatch(), 'batch_already_open', 'a second batch while one is open means two writers');
  assert.equal(ledger.endBatch(), 0);
  ledger.beginBatch();
  ledger.clear();
  assert.equal(ledger.batchOpen, false, 'clear() closes the batch');
  ledger.beginBatch();
  ok('batches do not nest, endBatch is idempotent, clear() resets the batch state');
}

{
  const events = [];
  const ledger = new HistoryLedger({ onAppend: (item, meta) => events.push({ what: shape([item])[0], ...meta, inHistory: ledger.snapshotForModel()[meta.index] === item }) });
  ledger.appendUser(text('prompt'), { kind: 'prompt' });
  ledger.beginBatch();
  ledger.appendModelOutput([assistantText('x'), call('a')]);
  ledger.appendUser(text('HINT'), { kind: 'recovery_hint' });
  assert.equal(events.length, 3, 'a waiting message has not been appended, so the hook has not run for it');
  ledger.appendToolOutput('a', 'r');
  ledger.endBatch();
  assert.deepEqual(events, [
    { what: 'user:prompt', index: 0, role: 'user', kind: 'prompt', deferred: false, batch: null, inHistory: true },
    { what: 'assistant', index: 1, role: 'model', kind: 'model_output', deferred: false, batch: 1, inHistory: true },
    { what: 'call:a', index: 2, role: 'model', kind: 'model_output', deferred: false, batch: 1, inHistory: true },
    { what: 'out:a', index: 3, role: 'tool', kind: 'tool_output', deferred: false, batch: 1, inHistory: true },
    { what: 'user:HINT', index: 4, role: 'user', kind: 'recovery_hint', deferred: true, batch: 1, inHistory: true },
  ]);
  const other = [];
  const stop = ledger.onAppend((item) => other.push(shape([item])[0]));
  ledger.appendUser(text('one'));
  stop();
  ledger.appendUser(text('two'));
  assert.deepEqual(other, ['user:one'], 'extra listeners can be added and removed (the journal and the summary boundary both listen)');
  ok('onAppend runs once per appended item, in order, after the item is in; a waiting message reports deferred and its batch');
}

{
  let broken = false;
  let calls = 0;
  const ledger = new HistoryLedger({ onAppend: () => { calls += 1; if (broken) throw new Error('journal write failed'); } });
  ledger.beginBatch();
  ledger.appendModelOutput([call('a')]);
  ledger.appendUser(text('h1'));
  ledger.appendUser(text('h2'));
  ledger.appendToolOutput('a', 'r');
  broken = true;
  calls = 0;
  assert.throws(() => ledger.endBatch(), /journal write failed/, 'a failing hook is not swallowed');
  assert.equal(calls, 2, 'the listener still saw both messages');
  assert.equal(ledger.length, 4, 'both messages are in the history even though the hook failed on the first');
  assert.equal(ledger.batchOpen, false);
  assert.throws(() => ledger.appendUser(text('h3')), /journal write failed/);
  assert.equal(ledger.length, 5, 'an append whose hook throws has still happened');
  ok('a throwing append hook never leaves the ledger half-written');
}

{
  const ledger = new HistoryLedger();
  fails(() => ledger.appendToolOutput('nope', 'x'), 'unknown_call', 'a result with no call');
  ledger.appendModelOutput([call('a')]);
  ledger.appendToolOutput('a', 'x');
  fails(() => ledger.appendToolOutput('a', 'again'), 'duplicate_output', 'a second result for one call');
  ledger.appendModelOutput([call('b')]);
  ledger.appendUser(text('squeezed in with no batch open'));
  fails(() => ledger.appendToolOutput('b', 'late'), 'late_output', 'a result that would follow a user message');
  assert.equal(ledger.length, 4, 'a refused append changes nothing');
  ok('the ledger refuses a result with no call, a second result, and a result that would follow a user message');
}

{
  const ledger = new HistoryLedger();
  ledger.appendModelOutput([call('a'), call('a'), { type: 'function_call', name: 'no_id' }, { type: 'function_call', call_id: '', name: 'empty_id' }]);
  assert.equal(ledger.length, 4, 'what a model sends is stored faithfully; the agent judges it (invalid_call_id), the ledger does not throw first');
  ledger.appendToolOutput('a', 'x');
  ok('malformed model output (repeated or missing call ids) is stored as it came');
}

{
  const ledger = new HistoryLedger();
  ledger.beginBatch();
  ledger.appendUser(text('waiting'));
  ledger.appendModelOutput([call('a')]);
  ledger.clear();
  assert.equal(ledger.length, 0);
  assert.equal(ledger.deferredCount, 0);
  assert.equal(ledger.byteLength(), 2);
  fails(() => ledger.appendToolOutput('a', 'x'), 'unknown_call', 'after clear() the calls are forgotten');
  ok('clear() empties the history, the waiting messages and the open calls');
}

{
  const rand = mulberry32(SEED ^ 0x5b);
  const pieces = ['plain', 'Đọc tệp README rồi báo cáo', '🙂 emoji and "quotes" and \\ backslash', 'line\nbreak\ttab', '', 'a'.repeat(300)];
  const pick = () => pieces[Math.floor(rand() * pieces.length)];
  const empty = new HistoryLedger();
  assert.equal(empty.byteLength(), Buffer.byteLength(JSON.stringify(empty.snapshotForModel())));
  for (let round = 0; round < 60; round += 1) {
    const ledger = new HistoryLedger();
    const n = Math.floor(rand() * 14);
    for (let i = 0; i < n; i += 1) {
      const id = `c${round}_${i}`;
      const kind = rand();
      if (kind < 0.3) ledger.appendUser(text(pick()));
      else if (kind < 0.8) {
        ledger.appendModelOutput([assistantText(pick()), call(id, 'read_file', { path: pick() })]);
        ledger.appendToolOutput(id, rand() < 0.3 ? [{ type: 'input_text', text: pick() }] : pick());
      } else ledger.appendModelOutput([{ type: 'reasoning', encrypted_content: pick() }]);
      assert.equal(ledger.byteLength(), Buffer.byteLength(JSON.stringify(ledger.snapshotForModel())), `byteLength after item ${i} of round ${round}`);
    }
  }
  ok('byteLength() is exactly the size of JSON.stringify(history) that the agent checks against its 48 MiB limit, kept incrementally');
}

// ---------------------------------------------------------------------------------------------------------------------
// 2. G1-1: randomized batches, host messages everywhere, the real converters
// ---------------------------------------------------------------------------------------------------------------------
const HOST_KINDS = ['recovery_hint', 'stop_hook_continue', 'completion_notice'];
const HOST_TEXT = {
  recovery_hint: (n) => `HOST STAGNATION RECOVERY ${1 + (n % 2)}/2. Previous read/search steps revisited equivalent unchanged evidence.`,
  stop_hook_continue: (n) => `STOP HOOK #${n}: do not stop yet, the check "npm test" still fails. Continue working.`,
  completion_notice: (n) => `BACKGROUND AGENT NOTICE #${n}: task ${n.toString(16).padStart(8, '0')} finished (completed). Its summary is data, not proof.`,
};

/** The old way: a plain array, every message appended the moment it arrives. It is the negative control. */
class RawWriter {
  items = [];
  beginBatch() { return 0; }
  endBatch() { return 0; }
  appendUser(content) { this.items.push({ role: 'user', content: structuredClone(content) }); }
  appendModelOutput(items) { this.items.push(...structuredClone(items)); }
  appendToolOutput(callId, output) { this.items.push({ type: 'function_call_output', call_id: callId, output }); }
  history() { return this.items; }
}
class LedgerWriter {
  ledger = new HistoryLedger();
  beginBatch() { return this.ledger.beginBatch(); }
  endBatch() { return this.ledger.endBatch(); }
  appendUser(content, meta) { this.ledger.appendUser(content, meta); }
  appendModelOutput(items) { this.ledger.appendModelOutput(items); }
  appendToolOutput(callId, output) { this.ledger.appendToolOutput(callId, output); }
  history() { return this.ledger.snapshotForModel(); }
}

/**
 * One conversation of 1-3 model turns. Each turn is one batch: a request goes out, the model answers with 0-4 calls and the
 * results come back one by one. Host messages are injected at every position (before the request, while it is in flight,
 * right after the answer, between any two results, after the last one, after the batch). `expected` is the history written
 * from the rules alone: waiting messages follow the last result of their batch, everything else keeps its arrival order.
 */
function playConversation(rand, writer, serial) {
  const stats = { batches: 0, multiCall: 0, aborted: 0, host: Object.fromEntries(HOST_KINDS.map((kind) => [kind, 0])) };
  const expected = [];
  const unanswered = [];
  const waiting = [];
  let open = false;
  let counter = 0;
  const inject = () => {
    if (rand() >= 0.34) return;
    const count = rand() < 0.3 ? 2 : 1;
    for (let i = 0; i < count; i += 1) {
      const kind = HOST_KINDS[Math.floor(rand() * HOST_KINDS.length)];
      counter += 1;
      const content = text(HOST_TEXT[kind](counter));
      writer.appendUser(content, { kind });
      stats.host[kind] += 1;
      (open ? waiting : expected).push({ role: 'user', content });
    }
  };
  const prompt = text(`task ${serial.value}`);
  writer.appendUser(prompt, { kind: 'prompt' });
  expected.push({ role: 'user', content: prompt });
  const turns = 1 + Math.floor(rand() * 3);
  for (let turn = 0; turn < turns; turn += 1) {
    const die = rand();
    const callCount = die < 0.7 ? 2 + Math.floor(rand() * 3) : die < 0.9 ? 1 : 0;
    inject();
    writer.beginBatch();
    open = true;
    stats.batches += 1;
    if (callCount > 1) stats.multiCall += 1;
    inject();
    const calls = Array.from({ length: callCount }, () => { serial.value += 1; return call(`call_${serial.value}`, 'read_file', { path: `src/f${serial.value}.mjs` }); });
    const output = [];
    if (rand() < 0.5) output.push(assistantText(`step ${turn}`, callCount ? 'commentary' : 'final'));
    if (rand() < 0.3) output.push({ type: 'reasoning', encrypted_content: `enc-${serial.value}-${turn}` });
    output.push(...calls);
    if (!output.length) output.push(assistantText('done', 'final'));
    writer.appendModelOutput(output);
    expected.push(...output);
    inject();
    const aborted = callCount > 0 && turn === turns - 1 && rand() < 0.12;
    const answered = aborted ? Math.floor(rand() * callCount) : callCount;
    if (aborted) { stats.aborted += 1; unanswered.push(...calls.slice(answered).map((entry) => entry.call_id)); }
    for (let i = 0; i < answered; i += 1) {
      const result = `result of ${calls[i].call_id}`;
      writer.appendToolOutput(calls[i].call_id, result);
      expected.push({ type: 'function_call_output', call_id: calls[i].call_id, output: result });
      inject();
    }
    writer.endBatch();
    open = false;
    expected.push(...waiting.splice(0));
    inject();
  }
  return { expected, stats, unanswered };
}

/** A tool message after a user message that follows the assistant message which asked for it. */
function chatViolations(messages) {
  const found = [];
  messages.forEach((message, index) => {
    if (message.role !== 'assistant' || !Array.isArray(message.tool_calls) || !message.tool_calls.length) return;
    const ids = new Set(message.tool_calls.map((entry) => entry.id));
    let sawUser = false;
    for (let j = index + 1; j < messages.length; j += 1) {
      const later = messages[j];
      if (later.role === 'assistant') break;
      if (later.role === 'user') sawUser = true;
      else if (later.role === 'tool' && sawUser && ids.has(later.tool_call_id)) found.push({ at: j, id: later.tool_call_id });
    }
  });
  return found;
}
/** A function_call_output item after a user item that follows its function_call item. */
function responsesViolations(items) {
  const found = [];
  items.forEach((item, index) => {
    if (item.type !== 'function_call') return;
    let sawUser = false;
    for (let j = index + 1; j < items.length; j += 1) {
      const later = items[j];
      if (later.role === 'assistant') break;
      if (later.role === 'user') sawUser = true;
      if (later.type === 'function_call_output' && later.call_id === item.call_id) { if (sawUser) found.push({ at: j, id: item.call_id }); break; }
    }
  });
  return found;
}
/**
 * A tool_result that is not among the leading blocks of the user message right after the assistant message with its tool_use.
 * NOTE: this check does not discriminate. asAnthropicMessages merges consecutive user messages and moves tool_result blocks
 * to the front, so a host message cannot split the results on this protocol whichever way the history is written.
 */
function anthropicViolations(messages) {
  const found = [];
  messages.forEach((message, index) => {
    if (message.role !== 'assistant') return;
    const ids = new Set(message.content.filter((block) => block.type === 'tool_use').map((block) => block.id));
    if (!ids.size) return;
    for (let j = index + 1; j < messages.length; j += 1) {
      const later = messages[j];
      if (later.role === 'assistant') break;
      later.content.forEach((block, k) => {
        if (block.type !== 'tool_result' || !ids.has(block.tool_use_id)) return;
        const leading = j === index + 1 && later.content.slice(0, k).every((other) => other.type === 'tool_result');
        if (!leading) found.push({ at: j, id: block.tool_use_id });
      });
    }
  });
  return found;
}

// The pipelines are what the adapters really do: respondStandard pairs the calls and then builds the body; asResponsesInput pairs
// them itself. An adapter that refuses the history counts as a violation too.
const PIPELINES = {
  chat: (history) => chatViolations(buildChatBody({ model: 'mock', input: pairToolCalls(history), instructions: 'system', tools: [] }).messages),
  responses: (history) => responsesViolations(asResponsesInput(history)),
  anthropic: (history) => anthropicViolations(buildAnthropicBody({ model: 'mock', input: pairToolCalls(history), instructions: 'system', tools: [] }).messages),
};
const violationsOf = (protocol, history) => {
  try { return PIPELINES[protocol](history); } catch (error) { return [{ refused: error.code ?? error.message }]; }
};

const CONVERSATIONS = 200;
const G11 = {};
for (const [index, protocol] of Object.keys(PIPELINES).entries()) {
  const result = { conversations: 0, batches: 0, multiCall: 0, aborted: 0, host: 0, hostByKind: Object.fromEntries(HOST_KINDS.map((kind) => [kind, 0])), ledger: 0, raw: 0, unchanged: 0, repaired: 0 };
  for (let n = 0; n < CONVERSATIONS; n += 1) {
    const seed = (SEED + index * 1000003 + n * 7919) >>> 0;
    const viaLedger = new LedgerWriter();
    const planned = playConversation(mulberry32(seed), viaLedger, { value: n * 100 });
    const viaRaw = new RawWriter();
    playConversation(mulberry32(seed), viaRaw, { value: n * 100 });
    assert.deepEqual(viaLedger.history(), planned.expected, `conversation ${n} (${protocol}): the ledger holds exactly the history the rules describe`);
    // The ledger produces the layout pairToolCalls() assumes (calls, all their results, then the rest), so the adapters' repair is the
    // identity on it. For a turn that was cut short the only thing it adds is a result for each call that never got one, placed
    // before the host messages that follow, and it removes nothing.
    const kept = viaLedger.history();
    const paired = pairToolCalls(kept);
    const added = paired.filter((item) => !kept.includes(item));
    assert.deepEqual(paired.filter((item) => kept.includes(item)), kept, `conversation ${n} (${protocol}): pairToolCalls drops and reorders nothing`);
    assert.deepEqual(added.map((item) => item.call_id).sort(), [...planned.unanswered].sort(), `conversation ${n} (${protocol}): it adds results for exactly the calls that never got one`);
    assert.ok(added.every((item) => item.type === 'function_call_output'));
    paired.forEach((item, index) => {
      if (!added.includes(item)) return;
      let after = index + 1;
      while (added.includes(paired[after])) after += 1;
      assert.ok(paired[after] === undefined || paired[after].role === 'user', `conversation ${n} (${protocol}): a repaired result is followed by a host message or the end, never by another model item`);
    });
    result.unchanged += added.length === 0 ? 1 : 0;
    result.repaired += added.length === 0 ? 0 : 1;
    const mine = violationsOf(protocol, viaLedger.history());
    assert.deepEqual(mine, [], `conversation ${n} (${protocol}): tool>user>tool through the ledger: ${JSON.stringify(mine)}`);
    result.conversations += 1;
    result.batches += planned.stats.batches;
    result.multiCall += planned.stats.multiCall;
    result.aborted += planned.stats.aborted;
    for (const kind of HOST_KINDS) { result.hostByKind[kind] += planned.stats.host[kind]; result.host += planned.stats.host[kind]; }
    result.ledger += mine.length;
    result.raw += violationsOf(protocol, viaRaw.history()).length;
  }
  G11[protocol] = result;
  assert.ok(result.batches >= 200, `${protocol}: at least 200 randomized batches (got ${result.batches})`);
  assert.ok(result.multiCall >= 100, `${protocol}: most batches must have 2+ calls, the only ones that can show the defect (got ${result.multiCall})`);
  for (const kind of HOST_KINDS) assert.ok(result.hostByKind[kind] >= 50, `${protocol}: host message kind ${kind} was injected enough (got ${result.hostByKind[kind]})`);
  assert.equal(result.ledger, 0, `${protocol}: violations through the ledger`);
  note(`G1-1 ${protocol}: ${result.conversations} conversations, ${result.batches} batches (${result.multiCall} with 2+ calls, ${result.aborted} cut short), ${result.host} host messages (${HOST_KINDS.map((kind) => `${kind} ${result.hostByKind[kind]}`).join(', ')}); tool>user>tool violations: ledger ${result.ledger}, raw-array control ${result.raw}; pairToolCalls is the identity on ${result.unchanged} of these histories and repairs only ${result.repaired} cut-short ones`);
  assert.equal(result.repaired, result.aborted, `${protocol}: pairToolCalls repairs exactly the conversations that were cut short`);
}
assert.ok(G11.chat.raw > 0, 'the control must show the defect on Chat Completions or the checker is blind');
assert.ok(G11.responses.raw > 0, 'the control must show the defect on Responses or the checker is blind');
ok(`G1-1: 0 tool>user>tool violations in ${G11.chat.batches}/${G11.responses.batches}/${G11.anthropic.batches} randomized batches (Chat/Responses/Anthropic) with a recovery hint, a Stop-hook continue message and a completion notice injected; the plain-array control shows ${G11.chat.raw}/${G11.responses.raw}/${G11.anthropic.raw}`);
note('Anthropic does not discriminate: its adapter merges consecutive user messages and moves tool_result blocks first, so the raw-array control cannot split the results there either');

// ---------------------------------------------------------------------------------------------------------------------
// 3. A snapshot of a 20 MB history
// ---------------------------------------------------------------------------------------------------------------------
{
  const ledger = new HistoryLedger();
  ledger.appendUser(text('prompt'));
  const filler = 'tool output line with some path src/lib/module.mjs and a number 12345 '.repeat(20);
  let turn = 0;
  while (ledger.byteLength() < 20 * 1024 * 1024) {
    turn += 1;
    ledger.appendModelOutput([assistantText(`step ${turn}`), call(`bench_${turn}`, 'read_file', { path: `src/f${turn}.mjs` })]);
    ledger.appendToolOutput(`bench_${turn}`, `${turn} ${filler}`);
  }
  const median = (fn, runs) => {
    const times = [];
    for (let i = 0; i < runs; i += 1) { const start = performance.now(); fn(); times.push(performance.now() - start); }
    return times.sort((a, b) => a - b)[Math.floor(runs / 2)];
  };
  const items = ledger.snapshotForModel();
  assert.ok(Buffer.byteLength(JSON.stringify(items)) >= 20 * 1024 * 1024, 'the history is at least 20 MB');
  const snapshotMs = median(() => ledger.snapshotForModel(), 9);
  const cloneMs = median(() => structuredClone(items), 3);
  note(`20 MB history (${items.length} items): snapshotForModel() ${snapshotMs.toFixed(3)} ms, structuredClone baseline ${cloneMs.toFixed(1)} ms`);
  assert.ok(snapshotMs < 50, `a 20 MB snapshot must take under 50 ms (took ${snapshotMs.toFixed(3)})`);
  assert.ok(snapshotMs * 5 < cloneMs, `and far less than the deep clone it replaces (${snapshotMs.toFixed(3)} vs ${cloneMs.toFixed(1)})`);
  ok(`a 20 MB history snapshots in ${snapshotMs.toFixed(3)} ms against ${cloneMs.toFixed(1)} ms for structuredClone (limit 50 ms)`);
}

// ---------------------------------------------------------------------------------------------------------------------
// 4. The consumers only read: every adapter path and both compaction passes on a deep-frozen copy of a ledger snapshot
// ---------------------------------------------------------------------------------------------------------------------
const deepFreeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const inner of Object.values(value)) deepFreeze(inner); }
  return value;
};
{
  const image = 'data:image/png;base64,AA==';
  const big = (label) => `${label}: ${'tool output line 0123456789 abcdefghij\n'.repeat(400)}`;
  /** A realistic history: a prompt, twelve tool turns with reasoning and provider fields, host hints, one image result. */
  const makeLedger = ({ images }) => {
    const ledger = new HistoryLedger();
    ledger.appendUser(images ? [...text('Fix the bug in calc.js'), { type: 'input_image', image_url: image, detail: 'auto' }] : text('Fix the bug in calc.js'), { kind: 'prompt' });
    for (let i = 1; i <= 12; i += 1) {
      ledger.beginBatch();
      ledger.appendModelOutput([
        { type: 'reasoning', id: `rs_${i}`, encrypted_content: `enc${i}` },
        { ...assistantText(`looking at step ${i}`), reasoningContent: `because ${i}`, providerParts: [{ text: `looking at step ${i}`, thoughtSignature: `sig${i}` }] },
        { ...call(`k${i}`, 'read_file', { path: `src/${i}.mjs` }), providerCallId: `g${i}`, providerPart: { functionCall: { name: 'read_file', args: { path: `src/${i}.mjs` }, id: `g${i}` } } },
      ]);
      ledger.appendToolOutput(`k${i}`, images && i === 7 ? [...text('diagram'), { type: 'input_image', image_url: image, detail: 'auto' }] : big(`result ${i}`));
      if (i % 4 === 0) ledger.appendUser(text(HOST_TEXT.recovery_hint(i)), { kind: 'recovery_hint' });
      ledger.endBatch();
    }
    return ledger;
  };
  const withImages = makeLedger({ images: true });
  const plain = makeLedger({ images: false });
  const frozenView = (ledger) => deepFreeze(structuredClone(ledger.snapshotForModel()));
  const tools = [{ type: 'function', name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } }, strict: false }];
  const before = JSON.stringify(withImages.snapshotForModel());

  buildChatBody({ model: 'm', input: pairToolCalls(frozenView(withImages)), instructions: 'system', tools });
  buildAnthropicBody({ model: 'm', input: pairToolCalls(frozenView(withImages)), instructions: 'system', tools, promptCaching: true });
  buildAnthropicBody({ model: 'm', input: pairToolCalls(frozenView(withImages)), instructions: 'system', tools, promptCaching: false });
  buildResponsesBody({ model: 'm', input: frozenView(withImages), instructions: 'system', tools });
  asGeminiContents(frozenView(withImages));
  geminiTextEnvelope(frozenView(plain), 'system', tools, { maxRequestBytes: 32 * 1024, repairHint: 'FORMAT RECOVERY 1/2' });
  compactHistory(frozenView(withImages), { maxBytes: 20 * 1024, keepRecent: 4 });
  estimateTokens({ input: frozenView(withImages), instructions: 'system', tools });
  estimateContextTokens(frozenView(withImages));
  ok('the body builders, the Gemini converters and the byte compaction accept deep-frozen history items (they do not write to them)');

  // Both compaction passes get a snapshot COPY: frozen items, a normal array they may write slots into.
  const compacted = compactConversationHistory(frozenView(withImages).slice(), { maxHistoryTokens: 500, preserveRecentOutputs: 2 });
  assert.equal(compacted.compacted, true, 'the compaction pass really ran on this history');
  const rolled = compactRollingContext(frozenView(withImages).slice(), { maxTokens: 12000, tailTokens: 9000, taskCheckpoint: 'checkpoint' });
  assert.equal(rolled.compacted, true, 'the rolling pass really ran on this history');
  ok('conversation compaction and rolling compaction run on frozen items without writing to them');

  // The real adapter functions over a real (in-process) Response, a frozen history, a small context window so that the
  // byte compaction inside respondStandard has to run.
  const json = (value) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
  const replies = {
    'openai-chat': () => json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
    anthropic: () => json({ type: 'message', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } }),
  };
  for (const protocol of ['openai-chat', 'anthropic']) {
    const sent = [];
    const result = await respondStandard(
      { protocol, endpoint: 'http://127.0.0.1:1/v1/x', headers: {}, model: 'm', fetch: async (url, init) => { sent.push(JSON.parse(init.body)); return replies[protocol](); }, sleep: async () => {}, redact: (s) => s, limits: { requestTimeoutMs: 5000 }, contextWindowTokens: 4000 },
      { input: frozenView(withImages), instructions: 'system', tools, maxOutputTokens: 512 });
    assert.equal(result.status, 'completed');
    assert.equal(sent.length, 1);
    assert.ok(JSON.stringify(sent[0]).includes('đã rút gọn'), `${protocol}: the byte compaction ran inside respondStandard`);
  }
  const answered = await respondOpenAIResponses(
    { model: 'm', endpoint: 'http://127.0.0.1:1/v1/responses', headers: {}, timeoutMs: 5000, fetch: async () => json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }], usage: { input_tokens: 1, output_tokens: 1 } }) },
    { input: frozenView(withImages), instructions: 'system', tools });
  assert.equal(answered.status, 'completed');
  assert.equal(JSON.stringify(withImages.snapshotForModel()), before, 'nothing above changed the ledger');
  ok('respondStandard (Chat and Anthropic, with its byte compaction) and respondOpenAIResponses accept a frozen history and leave the ledger as it was');
}

// ---------------------------------------------------------------------------------------------------------------------
// 5. The real AgentRunner
// ---------------------------------------------------------------------------------------------------------------------
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-ledger-agent-'));
try {
  const listing = { content: [{ type: 'text', text: '[FILE] README.md' }] };
  const manager = {
    secrets: [], generation: 1, instanceId: 'ledger-agent', locked: false,
    state() { return { workspace: { path: root }, generation: 1, instanceId: this.instanceId }; },
    acquireTask() { if (this.locked) return false; this.locked = true; return true; },
    releaseTask() { this.locked = false; },
    async createAgentSession() {
      return {
        catalog: { tools: [{ name: 'desktop-commander.list_directory', server: 'desktop-commander', inputSchema: { type: 'object' } }], prompts: [], resources: [], resourceTemplates: [], servers: {} },
        async close() {},
        async callTool(name, args, { onDecision } = {}) { await onDecision?.({ name, category: 'read', allowed: true }); return listing; },
      };
    },
  };
  const listDirectory = (id) => ({ type: 'function_call', call_id: id, name: 'mcp_call', status: 'completed', arguments: JSON.stringify({ name: 'desktop-commander.list_directory', arguments_json: JSON.stringify({ path: root }) }) });
  const finalAnswer = { type: 'message', role: 'assistant', phase: 'final', content: [{ type: 'output_text', text: 'Done.' }] };

  // Four identical directory listings, then ONE model turn with two calls. The first of those results is the fifth identical
  // observation, which makes the host write a stagnation-recovery hint while the second call has not run yet.
  const requests = [];
  let step = 0;
  const provider = {
    ready: () => true,
    snapshot: () => ({ provider: 'fixture', model: 'fixture' }),
    async respond({ input }) {
      step += 1;
      requests.push(input);
      const output = step <= 4 ? [listDirectory(`c${step}`)] : step === 5 ? [listDirectory('c5a'), listDirectory('c5b')] : [finalAnswer];
      return { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 }, output };
    },
  };
  const realClone = globalThis.structuredClone;
  const wholeHistoryClones = [];
  globalThis.structuredClone = (value, options) => {
    if (Array.isArray(value) && value.some((item) => item?.type === 'function_call_output')) wholeHistoryClones.push(value.length);
    return realClone(value, options);
  };
  let task;
  const runner = new AgentRunner({ manager, provider, taskDirectory: path.join(root, 'tasks') });
  try {
    await runner.load();
    await runner.start({ prompt: 'Look at the project until you know enough.' });
    task = await Promise.race([runner.context.done.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('ledger agent test timed out')), 10000))]);
  } finally {
    globalThis.structuredClone = realClone;
  }
  assert.equal(task.status, 'completed', task.error);
  assert.equal(requests.length, 6, 'six model requests');
  assert.ok(task.events.some((event) => event.type === 'progress_warning' || event.type === 'progress_recovery'), 'the stagnation recovery really fired');

  const sixth = shape(requests[5]);
  assert.deepEqual(sixth.slice(-5, -1), ['call:c5a', 'call:c5b', 'out:c5a', 'out:c5b'], 'both results follow both calls');
  assert.match(sixth.at(-1), /^user:HOST STAGNATION RECOVERY 1\/2\./, 'the recovery hint comes after BOTH results, not between them');
  ok('real AgentRunner: a recovery hint written while the first of two results is in goes after the second result');

  for (const [index, input] of requests.entries()) {
    for (const protocol of Object.keys(PIPELINES)) assert.deepEqual(violationsOf(protocol, input), [], `request ${index + 1} as ${protocol}`);
  }
  ok('real AgentRunner: every request of the run converts to a valid Chat, Responses and Anthropic conversation (no tool>user>tool)');

  assert.deepEqual(wholeHistoryClones, [], 'no model step deep-clones the history');
  ok('real AgentRunner: no model step deep-clones the history (structuredClone was never given the history)');
  await runner.shutdown();
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

console.log(`PASS: ${checks} checks (history ledger)`);
