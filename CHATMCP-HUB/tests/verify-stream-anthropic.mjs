// Anthropic Messages as a stream (prov-14): `stream: true` answers with message_start, content blocks (content_block_start, content_block_delta ..., content_block_stop), message_delta and
// message_stop, with `ping` between them and an `error` event when the provider fails after the stream began. The reader rebuilds the plain Message from the events and gives it to the one
// normaliser of the plain path, so a streamed answer and a plain one cannot differ; a tool call is part of the answer only when message_stop has come.
//   1. Golden streams: twelve streams in the shape of the streaming documentation and of the gateways that serve the API (tests/fixtures/streams/anthropic.json: each with the plain message of
//      the same answer, written from one plan) give, whatever the chunk size, exactly what the plain message gives. All of them pass the strict stream validator.
//   2. Fail closed: a stream cut at every frame boundary, and at byte positions, never gives a tool call before message_stop; an error event, a damaged event or a call that does not parse is no answer.
//   3. The adapter: what is asked for, a stream refused or cut (once, without a stream), errors inside the stream (overloaded_error is retried), the clocks, the text arriving while the stream does.
//   4. The provider remembers what it was told; and the same over a real connection against the strict mock.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeAnthropic } from '../lib/anthropic-api.mjs';
import { createAnthropicStreamReader } from '../lib/anthropic-stream.mjs';
import { LIMITS } from '../lib/standard-adapter.mjs';
import { SSE_STOP, readSse } from '../lib/sse.mjs';
import { parseSse, validateAnthropicStream } from './e2e/protocol-validators.mjs';
import { HISTORY, TOOLS, bodyOf, deadline, drive, encoder, firstFrames, framesOf, jsonResponse, kinds, loadFixtures, sse } from './support/stream-harness.mjs';

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
const { fixtures, textOf, byName } = loadFixtures('anthropic');
const INTERRUPTED = 'gateway_stream_interrupted';
const INVALID = 'gateway_stream_invalid';
const event = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
const start = (usage = { input_tokens: 10, output_tokens: 1 }) => event('message_start', { type: 'message_start', message: { id: 'msg_x', type: 'message', role: 'assistant', model: 'm', content: [], stop_reason: null, stop_sequence: null, usage } });
const blockStart = (index, block) => event('content_block_start', { type: 'content_block_start', index, content_block: block });
const delta = (index, piece) => event('content_block_delta', { type: 'content_block_delta', index, delta: piece });
const blockStop = (index) => event('content_block_stop', { type: 'content_block_stop', index });
const messageDelta = (stop, usage = { output_tokens: 5 }) => event('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage });
const messageStop = () => event('message_stop', { type: 'message_stop' });
const textBlock = (index, text) => blockStart(index, { type: 'text', text: '' }) + delta(index, { type: 'text_delta', text }) + blockStop(index);
const toolBlock = (index, id, name, json) => blockStart(index, { type: 'tool_use', id, name, input: {} }) + delta(index, { type: 'input_json_delta', partial_json: json }) + blockStop(index);
const complete = (blocks, stop = 'end_turn') => start() + blocks + messageDelta(stop) + messageStop();

/** Reads a stream text through the real SSE reader into the Messages reader. */
async function readMessages(text, { chunkBytes = 97 } = {}) {
  const tokens = [];
  const reader = createAnthropicStreamReader({ onToken: (token) => { tokens.push(token); } });
  await deadline(readSse(bodyOf(text, chunkBytes), { onEvent: (parsed) => reader.event(parsed) }), 'readSse');
  return { result: reader.finish(), tokens };
}
const attempt = async (text, options) => readMessages(text, options).then((value) => ({ value }), (error) => ({ error }));
const callsOf = (result) => result.output.filter((item) => item.type === 'function_call');
const textOfResult = (result) => result.output.filter((item) => item.type === 'message').flatMap((item) => item.content).map((part) => part.text ?? part.refusal ?? '').join('');

// ------------------------------------------------------------------ 1. golden streams
{
  assert.ok(fixtures.length >= 6, 'at least six recorded-shape streams');
  const sizes = [1, 7, 97, 100000];
  let reads = 0;
  for (const fixture of fixtures) {
    const text = textOf(fixture);
    const plain = normalizeAnthropic(fixture.message);
    for (const chunkBytes of sizes) {
      const { result, tokens } = await readMessages(text, { chunkBytes });
      assert.deepEqual(result, plain, `${fixture.name} (chunks of ${chunkBytes} bytes): the streamed result is the plain one`);
      assert.equal(tokens.join(''), fixture.summary.text || fixture.summary.refusal, `${fixture.name}: the text shown while it streamed is the text of the answer`);
      reads += 1;
    }
    const { result } = await readMessages(text);
    assert.equal(result.status, fixture.summary.status, `${fixture.name}: status`);
    assert.equal(fixture.summary.refusal ? '' : textOfResult(result), fixture.summary.text, `${fixture.name}: text`);
    if (fixture.summary.refusal) assert.equal(result.output[0].content[0].refusal, fixture.summary.refusal, `${fixture.name}: refusal`);
    assert.deepEqual(callsOf(result).map((call) => ({ id: call.call_id, name: call.name, arguments: call.arguments })), fixture.summary.calls, `${fixture.name}: calls`);
    if (fixture.strict) assert.deepEqual(validateAnthropicStream(parseSse(text)).errors, [], `${fixture.name}: a well-formed Messages stream`);
  }
  // usage: the totals of message_delta replace those of message_start, they are not added to them
  const cache = (await readMessages(textOf(byName('cache-usage')))).result.usage;
  assert.deepEqual(cache, { input_tokens: 390, output_tokens: 20, cache_read_tokens: 300, cache_creation_tokens: 50 }, 'input = uncached + cache read + cache write; output once');
  const plainUsage = (await readMessages(textOf(byName('text')))).result.usage;
  assert.deepEqual([plainUsage.input_tokens, plainUsage.output_tokens], [25, 15], 'message_delta names only output_tokens: the input tokens of message_start stay');
  // the text blocks are joined with a line break in the plain answer, and in the text shown while it streams
  assert.equal((await readMessages(textOf(byName('bedrock-no-ping')))).tokens.join(''), 'Phần một.\nPhần hai.');
  // a call the limit cut is not a call
  const cut = (await readMessages(textOf(byName('max-tokens-cut-call')))).result;
  assert.deepEqual([cut.status, cut.incomplete_details.reason, callsOf(cut).length], ['incomplete', 'max_output_tokens', 0]);
  ok(`Messages golden streams: ${fixtures.length} streams x ${sizes.length} chunk sizes (${reads} reads) equal the plain message of the same answer; all pass the strict validator`);
}

// ------------------------------------------------------------------ 2. fail closed
{
  const joinFrames = (frames) => frames.map((piece) => `${piece}\n\n`).join('');
  const splitFrames = (text) => framesOf(text).map((piece) => piece.replace(/\n\n$/, ''));
  let prefixes = 0;
  let cuts = 0;
  for (const fixture of fixtures) {
    const text = textOf(fixture);
    const full = (await readMessages(text)).result;
    const frames = splitFrames(text);
    const stopAt = frames.findIndex((piece) => piece.startsWith('event: message_stop'));
    assert.equal(stopAt, frames.length - 1, `${fixture.name}: message_stop is the last event`);
    // (a) cut at every frame boundary: no answer until message_stop is in
    for (let k = 0; k < frames.length; k += 1) {
      const outcome = await attempt(joinFrames(frames.slice(0, k)));
      prefixes += 1;
      assert.equal(outcome.error?.code, INTERRUPTED, `${fixture.name}: ${k} of ${frames.length} frames is not an answer`);
    }
    assert.deepEqual((await attempt(joinFrames(frames))).value.result, full);
    // (b) cut anywhere in the bytes: an error, or the whole answer
    const bytes = encoder.encode(text);
    for (let cut = 0; cut < bytes.length; cut += 61) {
      const outcome = await attempt(new TextDecoder().decode(bytes.slice(0, cut)));
      cuts += 1;
      if (outcome.error) assert.ok([INTERRUPTED, INVALID].includes(outcome.error.code), `${fixture.name}: a cut at byte ${cut} is ${outcome.error.code}`);
      else assert.deepEqual(outcome.value.result, full, `${fixture.name}: a cut at byte ${cut} gave an answer, and then it is the whole answer`);
    }
  }
  ok(`Messages fail closed: ${prefixes} frame prefixes and ${cuts} byte cuts of ${fixtures.length} streams: no answer before message_stop, and then the whole answer`);

  // (c) an error event after a tool_use block began, at every position
  const toolFrames = splitFrames(textOf(byName('tool-use')));
  const errors = [
    [{ type: 'overloaded_error', message: 'Overloaded' }, 529], [{ type: 'api_error', message: 'Internal server error' }, 500], [{ type: 'rate_limit_error', message: 'Number of request tokens has exceeded your per-minute rate limit' }, 429],
    [{ type: 'invalid_request_error', message: 'messages: text content blocks must be non-empty' }, 400], [{ type: 'authentication_error', message: 'invalid x-api-key' }, 401], [{ type: 'permission_error', message: 'forbidden' }, 403],
    [{ type: 'request_too_large', message: 'too large' }, 413], [{ type: 'not_found_error', message: 'model: x' }, 404], [{ type: 'something_new', message: 'odd' }, 502], [{ message: 'no type at all' }, 502],
  ];
  let errorCases = 0;
  for (const [error, status] of errors) {
    for (let k = 1; k < toolFrames.length - 2; k += 3) {
      const outcome = await attempt(joinFrames([...toolFrames.slice(0, k), `event: error\ndata: ${JSON.stringify({ type: 'error', error })}`]));
      errorCases += 1;
      assert.equal(outcome.error?.code, 'gateway_stream_error', `${error.type} after ${k} frames`);
      assert.equal(outcome.error.upstreamStatus, status);
      assert.equal(outcome.value, undefined, 'no answer, so no tool');
    }
  }
  assert.match((await attempt(joinFrames([toolFrames[0], 'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}']))).error.message, /Overloaded/);
  // an error is an error whatever name the event has: the type is in the data
  assert.equal((await attempt(start() + 'data: {"type":"error","error":{"type":"overloaded_error","message":"x"}}\n\n')).error?.upstreamStatus, 529);
  assert.equal((await attempt(start() + 'event: error\ndata: {"error":{"type":"overloaded_error","message":"x"}}\n\n')).error?.upstreamStatus, 529);
  ok(`Messages error event: ${errorCases} cases (${errors.length} error types x positions after a tool call began): the provider's failure with its HTTP status, never an answer`);

  // (d) damaged streams are invalid, not interrupted
  const damaged = {
    'an event that is not JSON': start() + 'event: content_block_start\ndata: this is not json\n\n',
    'an event that is an array': start() + 'data: [1,2]\n\n',
    'a stream that does not begin with message_start': blockStart(0, { type: 'text', text: '' }),
    'a message_start without a message': 'event: message_start\ndata: {"type":"message_start"}\n\n',
    'two message_start': start() + start(),
    'a delta for a block that was never started': start() + delta(0, { type: 'text_delta', text: 'x' }),
    'a delta after the block was stopped': start() + textBlock(0, 'a') + delta(0, { type: 'text_delta', text: 'late' }),
    'a stop for a block that was never started': start() + blockStop(0),
    'a block started twice': start() + blockStart(0, { type: 'text', text: '' }) + blockStop(0) + blockStart(0, { type: 'text', text: '' }),
    'a block started while another is open': start() + blockStart(0, { type: 'text', text: '' }) + blockStart(1, { type: 'text', text: '' }),
    'a block with no content_block': start() + 'event: content_block_start\ndata: {"type":"content_block_start","index":0}\n\n',
    'a block with a negative index': start() + blockStart(-1, { type: 'text', text: '' }),
    'a delta of another kind than its block': start() + blockStart(0, { type: 'text', text: '' }) + delta(0, { type: 'input_json_delta', partial_json: '{}' }),
    'a thinking delta in a text block': start() + blockStart(0, { type: 'text', text: '' }) + delta(0, { type: 'thinking_delta', thinking: 'x' }),
    'a delta with no delta': start() + blockStart(0, { type: 'text', text: '' }) + 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0}\n\n',
    'message_delta while a block is open': start() + blockStart(0, { type: 'text', text: '' }) + messageDelta('end_turn'),
    'message_stop while a block is open': start() + blockStart(0, { type: 'text', text: '' }) + messageStop(),
    'message_stop while a block is open, after the message_delta': start() + textBlock(0, 'a') + messageDelta('end_turn') + blockStart(1, { type: 'text', text: '' }) + messageStop(),
    'a stop reason that is empty': start() + textBlock(0, 'a') + messageDelta('') + messageStop(),
    'message_stop without message_delta': start() + textBlock(0, 'a') + messageStop(),
    'message_stop with a message_delta that names no stop reason': start() + textBlock(0, 'a') + event('message_delta', { type: 'message_delta', delta: {}, usage: { output_tokens: 1 } }) + messageStop(),
    'a tool call whose JSON is cut, with a stop reason that says it is whole': complete(toolBlock(0, 'toolu_1', 'read_file', '{"path":"a'), 'tool_use'),
    'a tool call whose input is not an object': complete(toolBlock(0, 'toolu_1', 'read_file', '[1,2]'), 'tool_use'),
    'a tool call whose input is not JSON': complete(toolBlock(0, 'toolu_1', 'read_file', 'not json'), 'tool_use'),
  };
  for (const [label, text] of Object.entries(damaged)) assert.equal((await attempt(text)).error?.code, INVALID, label);
  assert.equal((await attempt(complete(textBlock(0, 'x') + blockStart(1, { type: 'tool_use', id: 't', name: 'read_file', input: {} }) + delta(1, { type: 'input_json_delta', partial_json: '{"a' }) + blockStop(1), 'max_tokens'))).value.result.status, 'incomplete', 'but the same call cut by the output limit is incomplete, not damaged');
  // an event this client does not know is ignored, as the documentation asks
  const future = (await attempt(start() + event('some_future_event', { type: 'some_future_event', payload: 1 }) + textBlock(0, 'ok') + event('citations_like', { type: 'citations_like' }) + messageDelta('end_turn') + messageStop())).value.result;
  assert.equal(textOfResult(future), 'ok');
  const starting = (await attempt(start() + blockStart(0, { type: 'text', text: 'abc' }) + delta(0, { type: 'citations_delta', citation: {} }) + delta(0, { type: 'text_delta', text: 'def' }) + blockStop(0) + messageDelta('end_turn') + messageStop())).value;
  assert.equal(textOfResult(starting.result), 'abcdef', 'a block that starts with text keeps it; a citations_delta changes nothing');
  assert.equal(starting.tokens.join(''), 'abcdef', 'and shows it');
  assert.equal((await attempt(start() + blockStart(0, { type: 'server_tool_use', id: 's', name: 'web_search', input: {} }) + delta(0, { type: 'input_json_delta', partial_json: '{}' }) + blockStop(0) + textBlock(1, 'k') + messageDelta('end_turn') + messageStop())).value.tokens.join(''), 'k', 'a block of another kind is kept out of the way');
  // what a gateway may do that the API does not: events whose data has no type take it from the name of the event, a ping comes first, blocks are numbered out of order
  const named = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  const untyped = named('message_start', { message: { id: 'm', type: 'message', role: 'assistant', model: 'm', content: [], usage: { input_tokens: 3, output_tokens: 1 } } })
    + named('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) + named('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'ok' } }) + named('content_block_stop', { index: 0 })
    + named('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }) + named('message_stop', {});
  assert.equal(textOfResult((await attempt(untyped)).value.result), 'ok', 'events whose data has no type take it from the name of the event');
  assert.equal(textOfResult((await attempt('event: ping\ndata: {"type":"ping"}\n\n' + complete(textBlock(0, 'p')))).value.result), 'p', 'a ping before message_start');
  assert.equal(textOfResult((await attempt(start() + textBlock(1, 'Hai.') + textBlock(0, 'Một.') + messageDelta('end_turn') + messageStop())).value.result), 'Một.\nHai.', 'blocks are put in the order of their index, as the plain message has them');
  assert.match((await attempt(start() + 'event: error\ndata: {"type":"error","message":"top-level words"}\n\n')).error.message, /top-level words/, 'an error with its words at the top');
  assert.equal((await attempt(start() + 'event: error\ndata: {"type":"error"}\n\n')).error.message, 'Nhà cung cấp báo lỗi giữa luồng.', 'and one with no words');
  assert.equal(textOfResult((await attempt(complete(blockStart(0, { type: 'text' }) + delta(0, { type: 'text_delta', text: 'ab' }) + blockStop(0)))).value.result), 'ab', 'a text block that starts with no text field');
  for (const index of ['0', 0.5, null, undefined]) assert.equal((await attempt(start() + `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })}\n\n`)).error?.code, INVALID, `block index ${JSON.stringify(index)}`);
  // the stop reasons that may come with nothing in the message, and the ones that may not
  for (const stop of ['max_tokens', 'pause_turn']) assert.equal((await attempt(complete('', stop))).value.result.status, 'incomplete', `${stop} with nothing`);
  assert.equal((await attempt(complete('', 'refusal'))).value.result.output[0].content[0].refusal, 'Model từ chối yêu cầu này.', 'a refusal with no words has the Hub\'s');
  assert.equal((await attempt(complete(textBlock(0, '  \n')))).error?.code, INVALID, 'white space is not an answer');
  assert.equal((await attempt(complete(''))).error?.code, INVALID, 'nor is nothing');
  assert.equal((await attempt(complete(blockStart(0, { type: 'thinking', thinking: '', signature: '' }) + delta(0, { type: 'thinking_delta', thinking: 'x' }) + delta(0, { type: 'signature_delta', signature: 's' }) + blockStop(0)))).error?.code, INVALID, 'nor is thinking alone');
  // what ends the stream
  assert.equal((await attempt('')).error?.code, INTERRUPTED, 'an empty stream');
  assert.equal((await attempt(start())).error?.code, INTERRUPTED, 'a start and nothing else');
  assert.equal((await attempt(': keep-alive\n\n')).error?.code, INTERRUPTED, 'keep-alives only');
  const afterStop = await attempt(complete(textBlock(0, 'a')) + textBlock(1, ' late') + 'event: error\ndata: {"type":"error","error":{"message":"after the end"}}\n\n');
  assert.equal(textOfResult(afterStop.value.result), 'a', 'nothing after message_stop is read');
  assert.deepEqual(afterStop.value.tokens, ['a']);
  assert.equal((await attempt('event: ping\ndata: \n\n' + complete(textBlock(0, 'z')))).value.tokens.join(''), 'z', 'a ping is nothing');
  ok('Messages damaged streams: not JSON, not an object, out of order, mismatched deltas, a block left open at the end, no message_delta, calls that do not parse; unknown events and blocks are left alone; nothing after message_stop is read');

  // the reader on its own
  const direct = createAnthropicStreamReader({});
  for (const piece of [start(), textBlock(0, 'a'), messageDelta('end_turn')]) for (const parsed of parseSse(piece)) assert.equal(await direct.event({ event: parsed.event, data: parsed.data }), undefined);
  assert.equal(await direct.event({ event: 'message_stop', data: '{"type":"message_stop"}' }), SSE_STOP, 'message_stop says the stream is over');
  await direct.event({ event: 'error', data: '{"type":"error","error":{"message":"x"}}' });
  assert.equal(textOfResult(direct.finish()), 'a');
  const failing = createAnthropicStreamReader({ onToken: async () => { throw Object.assign(new Error('the handler failed'), { code: 'handler_failed' }); } });
  await failing.event({ data: parseSse(start())[0].data });
  await failing.event({ data: parseSse(blockStart(0, { type: 'text', text: '' }))[0].data });
  await assert.rejects(() => failing.event({ data: parseSse(delta(0, { type: 'text_delta', text: 'a' }))[0].data }), { code: 'handler_failed' });
  ok('Messages reader on its own: message_stop ends it, nothing after it is read, a failing handler is not swallowed');
}

// ------------------------------------------------------------------ 3. the adapter
{
  const text = byName('text');
  const answer = textOf(text);
  const plainText = normalizeAnthropic(text.message);
  const tool = byName('tool-use');
  const toolText = textOf(tool);
  const plainTool = normalizeAnthropic(tool.message);
  const ctx = (extra = {}) => ({ protocol: 'anthropic', ...extra });
  const run = (responses, extra = {}) => drive(responses, { protocol: 'anthropic', ...extra });

  // the request
  const streamed = await run([sse(answer)]);
  assert.deepEqual(streamed.value, plainText);
  assert.equal(streamed.shown, text.summary.text);
  assert.equal(streamed.sent[0].stream, true);
  assert.equal('stream_options' in streamed.sent[0], false, 'stream_options belong to Chat Completions');
  const plain = await run([jsonResponse(200, text.message)], { ctx: { stream: false } });
  assert.equal('stream' in plain.sent[0], false, 'a call that does not stream does not say stream: false (the Messages request never did)');
  assert.deepEqual(plain.value, plainText);
  const withEffort = await run([sse(answer)], { ctx: { reasoning: { field: 'output_config', value: { effort: 'high' } }, promptCaching: true } });
  assert.deepEqual([withEffort.sent[0].stream, withEffort.sent[0].output_config, withEffort.sent[0].system[0].cache_control], [true, { effort: 'high' }, { type: 'ephemeral' }], 'the thinking setting and the cache marks go with the stream');

  // a server that answers a stream request with JSON; one that refuses the stream
  const ignored = await run([jsonResponse(200, text.message)]);
  assert.deepEqual(ignored.events, ['before', 'fetch', `token:${text.summary.text}`]);
  const refusedStream = jsonResponse(400, { type: 'error', error: { type: 'invalid_request_error', message: 'stream: streaming is not supported by this endpoint' } });
  const repeated = await run([refusedStream, jsonResponse(200, text.message)]);
  assert.deepEqual(repeated.sent.map((body) => 'stream' in body), [true, false], 'the same request, once more, without the stream');
  assert.deepEqual(kinds(repeated.events), ['before', 'fetch', 'status', 'before', 'fetch', 'remembered', 'token']);
  assert.deepEqual(repeated.value, plainText);
  const known = await run([jsonResponse(200, text.message)], { ctx: { streamRefused: true } });
  assert.deepEqual(known.sent.map((body) => 'stream' in body), [false]);
  assert.deepEqual(kinds(known.events), ['before', 'fetch', 'token']);
  const quiet = await run([refusedStream], { ctx: { stream: false } });
  assert.deepEqual([quiet.sent.length, quiet.error?.upstreamStatus], [1, 400], 'a call that does not stream has nothing to fall back from');
  const other = await run([jsonResponse(400, { type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens: 99999 is too large for streaming' } })], { ctx: { limits: { requestTimeoutMs: 5000, maxCompactions: 0 } } });
  assert.equal(other.sent.length >= 1, true);
  // stream_options is no Messages business: a 400 that names it is an ordinary error there
  const options = await run([jsonResponse(400, { type: 'error', error: { type: 'invalid_request_error', message: 'stream_options: Extra inputs are not permitted' } })]);
  assert.deepEqual([options.sent.length, options.error?.upstreamStatus], [1, 400]);

  // cut or damaged: the repeat is the only answer, and the half call is never run
  const executed = [];
  const execute = (outcome) => { for (const item of outcome.value?.output ?? []) if (item.type === 'function_call') executed.push(item.call_id); };
  const afterCut = await run([sse(firstFrames(toolText, 8)), jsonResponse(200, tool.message)]);
  execute(afterCut);
  assert.deepEqual(afterCut.value, plainTool);
  assert.deepEqual(afterCut.sent.map((body) => 'stream' in body), [true, false]);
  assert.deepEqual(executed, ['toolu_01T1x1fJ34qAmk2tNTrN7Up6'], 'the call of the repeat is the only one that exists');
  executed.length = 0;
  const bothCut = await run([sse(firstFrames(toolText, 8)), jsonResponse(500, { type: 'error', error: { type: 'api_error', message: 'broken' } })], { ctx: { limits: { requestTimeoutMs: 5000, maxHttpRetries: 0 } } });
  execute(bothCut);
  assert.deepEqual([executed.length, bothCut.error?.upstreamStatus, bothCut.events.includes('remembered')], [0, 500, false]);
  const afterText = await run([sse(firstFrames(answer, 6)), jsonResponse(200, text.message)]);
  const order = kinds(afterText.events);
  assert.deepEqual(order.slice(order.indexOf('reset')), ['reset', 'status', 'before', 'fetch', 'remembered', 'token'], 'what was shown is taken back before the repeat');
  const garbled = await run([sse(firstFrames(answer, 4) + 'event: content_block_delta\ndata: {broken\n\n'), jsonResponse(200, text.message)]);
  assert.deepEqual(garbled.sent.map((body) => 'stream' in body), [true, false]);

  // an error inside the stream is the HTTP error it would have been
  const inStream = (frames, error) => sse(`${frames}event: error\ndata: ${JSON.stringify({ type: 'error', error })}\n\n`);
  const overloaded = await run([inStream(firstFrames(answer, 6), { type: 'overloaded_error', message: 'Overloaded' }), sse(answer)]);
  assert.deepEqual(overloaded.value, plainText, 'overloaded_error (529) is retried, as a stream again');
  assert.deepEqual(overloaded.sent.map((body) => body.stream), [true, true]);
  const retried = kinds(overloaded.events);
  assert.deepEqual(retried.slice(retried.indexOf('reset')).filter((name) => name !== 'token'), ['reset', 'status', 'sleep', 'before', 'fetch']);
  assert.equal(overloaded.events.includes('remembered'), false);
  const limited = await run([inStream(firstFrames(answer, 6), { type: 'rate_limit_error', message: 'Rate limit' }), sse(answer)]);
  assert.deepEqual(limited.value, plainText, 'rate_limit_error (429) too');
  for (const [error, code, status] of [[{ type: 'invalid_request_error', message: 'bad' }, 'gateway_http_error', 400], [{ type: 'authentication_error', message: 'invalid x-api-key' }, 'gateway_auth', 401], [{ type: 'permission_error', message: 'no' }, 'gateway_auth', 403]]) {
    const fatal = await run([inStream(firstFrames(answer, 6), error)]);
    assert.deepEqual([fatal.error?.code, fatal.error?.upstreamStatus, fatal.sent.length], [code, status, 1], error.type);
  }
  ok('Messages adapter: the stream flag, no stream_options, the thinking setting and cache marks kept; a refused or cut stream is repeated once without a stream; an error event is the HTTP error it stands for');

  // zero tools, whatever the way the stream fails
  executed.length = 0;
  const stopAt = framesOf(toolText).findIndex((piece) => piece.startsWith('event: message_stop'));
  let runs = 0;
  for (let k = 0; k < stopAt; k += 1) {
    const outcome = await run([sse(firstFrames(toolText, k)), jsonResponse(503, { type: 'error', error: { type: 'overloaded_error', message: 'down' } })], { ctx: { limits: { requestTimeoutMs: 5000, maxHttpRetries: 0 } } });
    execute(outcome);
    runs += 1;
    assert.equal(outcome.value, undefined);
  }
  for (const error of [{ type: 'overloaded_error', message: 'x' }, { type: 'api_error', message: 'x' }]) {
    const outcome = await run([inStream(firstFrames(toolText, 6), error), jsonResponse(503, { type: 'error', error: { type: 'overloaded_error', message: 'down' } })], { ctx: { limits: { requestTimeoutMs: 5000, maxHttpRetries: 0 } } });
    execute(outcome);
    runs += 1;
  }
  assert.equal(executed.length, 0, `${runs} ways for a stream to fail after a tool_use began: no tool was run`);
  ok(`Messages zero tools: ${runs} ways for a stream to fail after a call began, 0 tools executed`);

  // the connection fails or goes quiet
  const resets = (frames) => () => {
    let sent = false;
    const encoded = encoder.encode(frames);
    return { ok: true, status: 200, headers: new Headers({ 'content-type': 'text/event-stream' }), body: new ReadableStream({ pull(controller) { if (!sent) { sent = true; controller.enqueue(encoded); } else controller.error(Object.assign(new TypeError('terminated'), { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) })); } }) };
  };
  const reset = await run([resets(firstFrames(answer, 6)), sse(answer)]);
  assert.deepEqual(reset.value, plainText);
  assert.deepEqual(reset.sent.map((body) => body.stream), [true, true], 'a dropped connection is retried as a stream');
  const silent = (frames) => (init) => {
    let controller;
    const body = new ReadableStream({ start(c) { controller = c; c.enqueue(encoder.encode(frames)); } });
    init.signal.addEventListener('abort', () => controller.error(new DOMException('This operation was aborted', 'AbortError')), { once: true });
    return { ok: true, status: 200, headers: new Headers({ 'content-type': 'text/event-stream' }), body };
  };
  const idle = await run([silent(firstFrames(answer, 6)), sse(answer)], { ctx: { limits: { requestTimeoutMs: 5000, idleTimeoutMs: 80 } } });
  assert.deepEqual(idle.value, plainText, 'a stream that goes quiet is cut and the request is made again');
  const kept = await run([() => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'text/event-stream' }), body: new ReadableStream({ async pull(controller) { await new Promise((resolve) => setTimeout(resolve, 40)); controller.enqueue(encoder.encode(': keep-alive\n\n')); } }) })], { ctx: { limits: { requestTimeoutMs: 5000, idleTimeoutMs: 500, streamTotalMs: 150, maxTimeouts: 0 } } });
  assert.equal(kept.error?.code, 'gateway_timeout', 'ping and keep-alive comments are life, but not for ever');
  ok('Messages connection: a dropped or silent stream is made again as a stream; keep-alives are life, with a total cap');

  // the text arrives while the stream does
  const names = ['text', 'thinking-tool', 'thinking-omitted', 'redacted-thinking', 'cache-usage', 'bedrock-no-ping', 'refusal'];
  for (const name of names) {
    const fixture = byName(name);
    const frames = framesOf(textOf(fixture));
    const last = frames.length - 1;
    let released = 0;
    let firstAt = null;
    let lastReleasedAt = null;
    let before = 0;
    const started = performance.now();
    const paced = () => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'text/event-stream' }), body: new ReadableStream({
      async pull(controller) {
        if (released >= frames.length) { controller.close(); return; }
        await new Promise((resolve) => setTimeout(resolve, 12));
        if (released === last) lastReleasedAt = performance.now();
        controller.enqueue(encoder.encode(frames[released]));
        released += 1;
      },
    }) });
    const outcome = await run([paced], { options: { onToken: () => { if (firstAt === null) firstAt = performance.now(); if (released <= last) before += 1; } } });
    const total = performance.now() - started;
    assert.equal(outcome.error, undefined, name);
    assert.ok(before > 0 && firstAt < lastReleasedAt, `${name}: onToken fired before the last chunk was sent`);
    if (!/thinking|redacted/.test(name)) assert.ok((firstAt - started) < total * 0.5, `${name}: first token after ${Math.round(firstAt - started)} ms of ${Math.round(total)} ms`);
  }
  ok(`Messages timing: for ${names.length} streams the first token came before the last chunk, and (but for those that think first) in under half of the total time`);
}

// ------------------------------------------------------------------ 4. the provider, and a real connection
{
  const { GatewayProvider } = await import('../lib/gateway-provider.mjs');
  const { startMockModel } = await import('./e2e/mock-model-server.mjs');
  const text = byName('text');
  const answer = textOf(text);
  const plain = normalizeAnthropic(text.message);
  const made = [];
  async function provider(script, { model = 'm', baseUrl = 'http://127.0.0.1:7333' } = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chatmcp-stream-anthropic-'));
    made.push(directory);
    const sent = [];
    const queue = [...script];
    const gateway = new GatewayProvider({ directory, manager: { secrets: [] }, env: {}, platform: 'linux', sleep: async () => {}, fetchImpl: async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); const next = queue.shift(); return typeof next === 'function' ? next(init) : next; } });
    await gateway.load();
    await gateway.configure({ preset: 'custom-anthropic', apiBaseUrl: baseUrl, protocol: 'anthropic', model, authMode: 'bearer' });
    return { gateway, sent };
  }
  const ask = (gateway, extra = {}) => gateway.respond({ input: HISTORY, instructions: 'Test', tools: TOOLS, maxOutputTokens: 1024, ...extra });
  try {
    const first = await provider([sse(answer), jsonResponse(200, text.message)]);
    const shown = [];
    assert.deepEqual(await ask(first.gateway, { onToken: (token) => shown.push(token) }), plain);
    assert.equal(first.sent[0].body.stream, true);
    assert.equal(shown.join(''), text.summary.text);
    await ask(first.gateway);
    assert.equal('stream' in first.sent[1].body, false, 'no onToken: nobody to show the text to, so no stream');

    const refusing = await provider([jsonResponse(400, { type: 'error', error: { type: 'invalid_request_error', message: 'stream: streaming is not supported by this endpoint' } }), jsonResponse(200, text.message), jsonResponse(200, text.message), sse(answer)]);
    await ask(refusing.gateway, { onToken: () => {} });
    await ask(refusing.gateway, { onToken: () => {} });
    assert.deepEqual(refusing.sent.map((entry) => 'stream' in entry.body), [true, false, false], 'a refusal is remembered');
    await refusing.gateway.configure({ model: 'another-model' });
    await ask(refusing.gateway, { onToken: () => {} });
    assert.equal(refusing.sent[3].body.stream, true, 'another model asks again');

    const cutting = await provider([sse(firstFrames(answer, 6)), jsonResponse(200, text.message), jsonResponse(200, text.message)]);
    const events = [];
    assert.deepEqual(await ask(cutting.gateway, { onToken: (token) => events.push(`token:${token}`), onStreamReset: () => events.push('reset') }), plain);
    assert.equal(events.includes('reset'), true);
    await ask(cutting.gateway, { onToken: () => {} });
    assert.deepEqual(cutting.sent.map((entry) => 'stream' in entry.body), [true, false, false], 'a cut stream is remembered like a refused one');
  } finally {
    for (const directory of made) fs.rmSync(directory, { recursive: true, force: true });
  }

  const m = await startMockModel({ scenario: 'canned-answer', strict: true });
  const makeProvider = (limits) => new GatewayProvider({ directory: path.join(os.tmpdir(), 'chatmcp-stream-anthropic-unused'), bundleRoot: os.tmpdir(), manager: { secrets: [] }, env: {}, sleep: async () => {}, limits })
    .forkForTask({ protocol: 'anthropic', apiBaseUrl: m.origin, model: 'mock-coder' });
  const askMock = (gateway, extra = {}) => gateway.respond({ input: HISTORY, instructions: 'system', tools: TOOLS, maxOutputTokens: 1024, signal: AbortSignal.timeout(8000), ...extra });
  const listen = () => { const events = []; return { events, options: { onToken: (token) => events.push(`token:${token}`), onStreamReset: () => events.push('reset'), onStatus: async () => { events.push('status'); } } }; };
  const tokensOf = (events) => events.filter((name) => name.startsWith('token:')).map((name) => name.slice(6)).join('');
  const streams = () => m.state.requests.map((request) => request.stream);
  try {
    m.setScenario('canned-answer');
    const normal = listen();
    const answered = await askMock(makeProvider({ requestTimeoutMs: 5000 }), normal.options);
    assert.equal(answered.status, 'completed');
    assert.equal(tokensOf(normal.events), 'Hello from the mock.');
    assert.deepEqual(streams(), [true]);
    assert.deepEqual([answered.usage.input_tokens, answered.usage.output_tokens], [120, 24]);

    m.setScenario('canned-answer');
    const cut = m.inject({ kind: 'cut', on: 'anthropic', stream: true, afterEvents: 5 });
    const cutting = listen();
    const gateway = makeProvider({ requestTimeoutMs: 5000 });
    assert.equal((await askMock(gateway, cutting.options)).status, 'completed');
    assert.deepEqual(streams(), [true, false]);
    assert.equal(cut.used, 1);
    assert.equal(cutting.events.includes('reset'), true);
    assert.equal(cutting.events.at(-1), 'token:Hello from the mock.');
    m.setScenario('canned-answer');
    await askMock(gateway, listen().options);
    assert.deepEqual(streams(), [false], 'remembered');
    m.clearFaults();

    m.setScenario('canned-answer');
    m.inject({ kind: 'cut', on: 'anthropic', stream: true, afterEvents: 5, reset: true });
    const resetting = listen();
    assert.equal((await askMock(makeProvider({ requestTimeoutMs: 5000 }), resetting.options)).status, 'completed');
    assert.deepEqual(streams(), [true, true]);
    m.clearFaults();

    m.setScenario('canned-answer');
    m.inject({ kind: 'stall', on: 'anthropic', stream: true, afterEvents: 5 });
    const started = Date.now();
    assert.equal((await askMock(makeProvider({ requestTimeoutMs: 5000, idleTimeoutMs: 300 }), listen().options)).status, 'completed');
    assert.ok(Date.now() - started < 4000);
    assert.deepEqual(streams(), [true, true]);
    m.clearFaults();

    m.setScenario('canned-answer');
    const refusal = m.inject({ kind: 'stream-unsupported', on: 'anthropic', times: 5 });
    const refusing = makeProvider({ requestTimeoutMs: 5000 });
    const refused = listen();
    await askMock(refusing, refused.options);
    await askMock(refusing, refused.options);
    assert.deepEqual(streams(), [true, false, false]);
    assert.equal(refusal.used, 1);
    assert.equal(tokensOf(refused.events), 'Hello from the mock.Hello from the mock.');
    m.clearFaults();
    assert.equal(m.state.rejections.length, 0, 'the strict server refused nothing in all of this');
    ok('Messages over HTTP against the strict mock: a stream, a stream cut (repeat without a stream, remembered), a connection torn down, a server gone quiet, a refused stream (once)');
  } finally {
    await m.close();
  }
  assert.ok(LIMITS.streamMaxBytes > 0);
}

console.log(`\nPASS: ${checks} messages stream checks`);
