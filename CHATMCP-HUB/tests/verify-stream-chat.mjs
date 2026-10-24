// Chat Completions as a stream (prov-13): `stream: true` answers with chat.completion.chunk events. The reader rebuilds the plain answer from them and gives it to the one normaliser of the
// plain path, so a streamed answer and a plain one cannot differ; a tool call is part of the answer only when the stream is confirmed complete.
//   1. Golden streams: twelve streams in the shape of OpenAI, OpenRouter, DeepSeek, Ollama, LM Studio, vLLM and Azure (tests/fixtures/streams/chat.json: each with the plain completion of the same
//      message, written from one plan) give, whatever the chunk size, exactly what the plain completion gives. The OpenAI-shaped ones also pass the strict stream validator.
//   2. Fail closed: a stream cut at every frame boundary, and at byte positions, never gives a tool call unless it is complete; an error inside the stream, a damaged fragment or a call that does not
//      parse is no answer; a text-only answer may end with [DONE] alone, a call may not.
//   3. Quirks the servers have: a name repeated or cumulative, an id that comes late, fragments with no index, an id used before, arguments as an object, a content in parts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeChatCompletion } from '../lib/openai-chat-api.mjs';
import { createChatStreamReader } from '../lib/openai-chat-stream.mjs';
import { SSE_STOP, readSse } from '../lib/sse.mjs';
import { parseSse, validateChatStream } from './e2e/protocol-validators.mjs';
import { HISTORY, TOOLS, bodyOf, deadline, drive, encoder, firstFrames, framesOf, jsonResponse, kinds, loadFixtures, sse } from './support/stream-harness.mjs';

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
const { fixtures, textOf, byName } = loadFixtures('chat');
const manifest = { fixtures };

/** Reads a stream text through the real SSE reader into the Chat reader. Resolves with what finish() gives, or rejects with its error. */
async function readChat(text, { chunkBytes = 97, usedCallIds = undefined } = {}) {
  const tokens = [];
  const reader = createChatStreamReader({ onToken: (token) => { tokens.push(token); }, usedCallIds });
  await deadline(readSse(bodyOf(text, chunkBytes), { onEvent: (event) => reader.event(event) }), 'readSse');
  return { result: reader.finish(), tokens, reader };
}
const attempt = async (text, options) => readChat(text, options).then((value) => ({ value }), (error) => ({ error }));
const callsOf = (result) => result.output.filter((item) => item.type === 'function_call');
const textOfResult = (result) => result.output.filter((item) => item.type === 'message').flatMap((item) => item.content).map((part) => part.text ?? '').join('');
const INTERRUPTED = 'gateway_stream_interrupted';
const INVALID = 'gateway_stream_invalid';
const frame = (object) => `data: ${JSON.stringify(object)}\n\n`;
const chunk = (delta, finish = null, extra = {}) => frame({ id: 'chatcmpl-x', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }], ...extra });

// ------------------------------------------------------------------ 1. golden streams
{
  assert.ok(manifest.fixtures.length >= 6, 'at least six recorded-shape streams');
  const sizes = [1, 7, 97, 100000];
  let streamsRead = 0;
  for (const fixture of manifest.fixtures) {
    const text = textOf(fixture);
    const plain = normalizeChatCompletion(fixture.completion);
    for (const chunkBytes of sizes) {
      const { result, tokens } = await readChat(text, { chunkBytes });
      assert.deepEqual(result, plain, `${fixture.name} (chunks of ${chunkBytes} bytes): the streamed result is the plain one`);
      assert.equal(tokens.join(''), fixture.summary.text, `${fixture.name}: the text that was shown while it streamed is the text of the answer`);
      streamsRead += 1;
    }
    // what the person who wrote the fixture says the answer is, in words
    const { result } = await readChat(text);
    assert.equal(result.status, fixture.summary.status, `${fixture.name}: status`);
    assert.equal(textOfResult(result), fixture.summary.text, `${fixture.name}: text`);
    assert.deepEqual(callsOf(result).map((call) => ({ id: call.call_id, name: call.name, arguments: call.arguments })), fixture.summary.calls, `${fixture.name}: calls`);
    assert.equal(result.output.map((item) => item.reasoningContent ?? '').join(''), fixture.summary.reasoning, `${fixture.name}: reasoning travels with the first item`);
    assert.deepEqual([result.usage.input_tokens, result.usage.output_tokens], [fixture.summary.usage.input_tokens, fixture.summary.usage.output_tokens], `${fixture.name}: usage`);
    if (fixture.summary.refusal) assert.equal(result.output[0].content[0].refusal, fixture.summary.refusal, `${fixture.name}: refusal`);
    // the fixture itself is a stream the real API could send, when it claims to be one
    if (fixture.strict) assert.deepEqual(validateChatStream(parseSse(text), { includeUsage: fixture.includeUsage }).errors, [], `${fixture.name}: a well-formed OpenAI stream`);
  }
  // usage that is not there is unavailable, not zero
  const vllm = manifest.fixtures.find((fixture) => fixture.name === 'vllm-text');
  assert.deepEqual((await readChat(textOf(vllm))).result.usage, { input_tokens: null, output_tokens: null, cache_read_tokens: null, reasoning_tokens: null });
  // the cached and the reasoning tokens of the usage chunk are read
  const tools = manifest.fixtures.find((fixture) => fixture.name === 'openai-tools');
  assert.equal((await readChat(textOf(tools))).result.usage.cache_read_tokens, 256);
  const deepseek = manifest.fixtures.find((fixture) => fixture.name === 'deepseek-reasoning');
  assert.equal((await readChat(textOf(deepseek))).result.usage.reasoning_tokens, 29, 'usage on the chunk that carries finish_reason');
  ok(`Chat golden streams: ${manifest.fixtures.length} streams x ${sizes.length} chunk sizes (${streamsRead} reads) equal the plain completion of the same message; the OpenAI-shaped ones pass the strict validator`);
}

// ------------------------------------------------------------------ 2. fail closed
{
  const splitFrames = (text) => text.split(/\r?\n\r?\n/).filter((piece) => piece.length > 0);
  const joinFrames = (frames) => frames.map((piece) => `${piece}\n\n`).join('');
  const finishIndex = (frames) => frames.findIndex((piece) => /"finish_reason":"(?!null)[a-z_]+"/.test(piece));
  let prefixes = 0;
  let cuts = 0;
  for (const fixture of manifest.fixtures) {
    const text = textOf(fixture);
    const full = (await readChat(text)).result;
    const frames = splitFrames(text);
    const finishAt = finishIndex(frames);
    assert.ok(finishAt > 0, `${fixture.name}: has a finish_reason frame`);
    // (a) the stream cut at every frame boundary: no answer until the chunk with finish_reason is in, and then the whole answer
    for (let k = 0; k <= frames.length; k += 1) {
      const outcome = await attempt(joinFrames(frames.slice(0, k)));
      prefixes += 1;
      if (k <= finishAt) {
        assert.equal(outcome.error?.code, INTERRUPTED, `${fixture.name}: ${k} of ${frames.length} frames (the finish_reason frame is ${finishAt + 1}th) is not an answer`);
        assert.equal(outcome.value, undefined);
      } else {
        assert.deepEqual(callsOf(outcome.value.result), callsOf(full), `${fixture.name}: from the finish_reason frame on, the calls are complete`);
        assert.equal(textOfResult(outcome.value.result), textOfResult(full));
      }
    }
    // (b) the stream cut anywhere in its bytes: an error, or the complete answer
    const bytes = encoder.encode(text);
    for (let cut = 0; cut < bytes.length; cut += 53) {
      const piece = new TextDecoder().decode(bytes.slice(0, cut));
      const outcome = await attempt(piece);
      cuts += 1;
      if (outcome.error) assert.ok([INTERRUPTED, INVALID].includes(outcome.error.code), `${fixture.name}: a cut at byte ${cut} is ${outcome.error.code}`);
      else assert.deepEqual(callsOf(outcome.value.result), callsOf(full), `${fixture.name}: a cut at byte ${cut} gave an answer, and then it is the whole answer`);
    }
  }
  ok(`Chat fail closed: ${prefixes} frame prefixes and ${cuts} byte cuts of ${manifest.fixtures.length} streams: no answer before finish_reason, and then every call complete`);

  // (c) an error inside the stream, after a tool call began, at every position: the provider's failure, with the status it would have had, and no tool
  const toolFrames = splitFrames(textOf(manifest.fixtures.find((fixture) => fixture.name === 'openai-tools')));
  const errors = [
    [{ error: { code: 'server_error', message: 'Provider disconnected unexpectedly' } }, 500],
    [{ error: { message: 'The server had an error while processing your request.', type: 'server_error', param: null, code: null } }, 500],
    [{ error: { message: 'Rate limit reached for gpt-5-mini', type: 'tokens', code: 'rate_limit_exceeded' } }, 429],
    [{ error: { code: 503, message: 'overloaded' } }, 503],
    [{ error: { message: 'something odd' } }, 502],
    [{ id: 'gen-1', provider: 'OpenAI', error: { code: 'server_error', message: 'Provider disconnected' }, choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }] }, 500],
    [{ error: 'just a string' }, 502],
  ];
  let errorCases = 0;
  for (const [body, status] of errors) {
    for (let k = 1; k < 6; k += 1) {
      const outcome = await attempt(joinFrames([...toolFrames.slice(0, k), JSON.stringify(body).replace(/^/, 'data: ')]));
      errorCases += 1;
      assert.equal(outcome.error?.code, 'gateway_stream_error', `${JSON.stringify(body).slice(0, 50)} after ${k} frames`);
      assert.equal(outcome.error.upstreamStatus, status);
      assert.equal(outcome.value, undefined, 'no answer, so no tool');
    }
  }
  assert.match((await attempt(joinFrames([toolFrames[0], 'data: ' + JSON.stringify(errors[0][0])]))).error.message, /Provider disconnected unexpectedly/);
  ok(`Chat error inside the stream: ${errorCases} cases (7 shapes x 5 positions after a tool call began): the provider's failure with its HTTP status, never an answer`);

  // (d) what is damaged is invalid, not interrupted
  const damaged = {
    'an event that is not JSON': 'data: this is not json\n\n',
    'an event that is an array': 'data: [1,2]\n\n',
    'a tool call fragment that is not an object': chunk({ tool_calls: ['x'] }),
  };
  for (const [label, text] of Object.entries(damaged)) assert.equal((await attempt(text)).error?.code, INVALID, label);
  const call = (arguments_, name = 'read_file') => chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name, arguments: arguments_ } }] });
  assert.equal((await attempt(call('{"path":"a') + chunk({}, 'tool_calls'))).error?.code, INVALID, 'a call whose arguments are cut in the middle, with a finish_reason that says the call is complete');
  assert.equal((await attempt(call('[1]') + chunk({}, 'tool_calls'))).error?.code, INVALID, 'arguments that are not an object');
  assert.equal((await attempt(call('not json') + chunk({}, 'tool_calls'))).error?.code, INVALID);
  assert.equal((await attempt(call('{}', '') + chunk({}, 'tool_calls'))).error?.code, INVALID, 'a call with no name');
  const cutByLimit = (await attempt(chunk({ content: 'Đã đọc ' }) + call('{"path":"a') + chunk({}, 'length'))).value.result;
  assert.deepEqual([cutByLimit.status, cutByLimit.incomplete_details.reason, callsOf(cutByLimit).length], ['incomplete', 'max_output_tokens', 0], 'a call the output limit cut is never returned, and that is not damage');
  const filtered = (await attempt(call('{"pa') + chunk({}, 'content_filter'))).value.result;
  assert.deepEqual([filtered.status, filtered.incomplete_details.reason, callsOf(filtered).length], ['incomplete', 'content_filter', 0]);
  ok('Chat damaged streams: not JSON, not an object, a fragment that is not an object, arguments that do not parse or are not an object, a call with no name; a cut by the limit is incomplete, with no call');

  // (e) the end marker
  const onlyText = (await attempt(chunk({ role: 'assistant', content: 'Xong.' }) + 'data: [DONE]\n\n')).value;
  assert.equal(textOfResult(onlyText.result), 'Xong.', 'a server that leaves the finish reason out: a text answer ended by [DONE] is complete');
  assert.equal((await attempt(call('{"path":"a"}') + 'data: [DONE]\n\n')).error?.code, INTERRUPTED, '[DONE] without a finish_reason does not complete a call');
  assert.equal((await attempt(chunk({ content: 'Xong.' }) + call('{"path":"a"}') + 'data: [DONE]\n\n')).error?.code, INTERRUPTED, 'nor a call that follows text');
  assert.equal((await attempt('data: [DONE]\n\n')).error?.code, INTERRUPTED, '[DONE] alone');
  assert.equal((await attempt('')).error?.code, INTERRUPTED, 'an empty stream');
  assert.equal((await attempt(': OPENROUTER PROCESSING\n\n: OPENROUTER PROCESSING\n\n')).error?.code, INTERRUPTED, 'a stream of keep-alives');
  assert.equal((await attempt(chunk({ content: 'x' }))).error?.code, INTERRUPTED, 'text and nothing else');
  const afterDone = await attempt(chunk({ content: 'a' }, 'stop') + 'data: [DONE]\n\n' + chunk({ content: ' late' }) + 'data: {"error":{"message":"after the end"}}\n\n');
  assert.equal(textOfResult(afterDone.value.result), 'a', 'nothing after [DONE] is read');
  assert.deepEqual(afterDone.value.tokens, ['a']);
  assert.equal(textOfResult((await attempt('data: \n\n' + chunk({ content: 'ok' }, 'stop') + 'data:   \n\n')).value.result), 'ok', 'an event with no data is nothing');
  ok('Chat end marker: [DONE] completes a text answer only; nothing after it is read; an empty stream, keep-alives, [DONE] alone and text with no end are interrupted');
}

// ------------------------------------------------------------------ 3. what servers do
{
  const call = (index, fields) => chunk({ tool_calls: [{ ...(index === null ? {} : { index }), ...fields }] });
  const fn = (name, arguments_) => ({ type: 'function', function: { ...(name === undefined ? {} : { name }), ...(arguments_ === undefined ? {} : { arguments: arguments_ }) } });
  const done = chunk({}, 'tool_calls') + 'data: [DONE]\n\n';
  const calls = async (text, options) => callsOf((await readChat(text, options)).result).map((item) => ({ id: item.call_id, name: item.name, arguments: item.arguments }));

  assert.deepEqual(await calls(call(0, { id: 'c1', ...fn('read_file', '{"pa') }) + call(0, fn('read_file', 'th":"a"}')) + done), [{ id: 'c1', name: 'read_file', arguments: '{"path":"a"}' }], 'a server that repeats the name in every fragment: one name');
  assert.deepEqual(await calls(call(0, { id: 'c1', ...fn('read', '') }) + call(0, fn('read_file', '{}')) + done), [{ id: 'c1', name: 'read_file', arguments: '{}' }], 'a name that grows (cumulative)');
  assert.deepEqual(await calls(call(0, { id: 'c1', ...fn('read_file', '') }) + call(0, fn('file', '{}')) + done), [{ id: 'c1', name: 'read_file', arguments: '{}' }], 'a later name that is not a longer form of the first changes nothing');
  assert.deepEqual(await calls(call(0, fn('read_file', '{')) + call(0, { id: 'late', ...fn(undefined, '}') }) + done), [{ id: 'late', name: 'read_file', arguments: '{}' }], 'the id that comes in a later fragment');
  assert.deepEqual(await calls(call(null, { id: 'a', ...fn('read_file', '{"path":"1"}') }) + call(null, { id: 'b', ...fn('read_file', '{"path":"2"}') }) + done), [
    { id: 'a', name: 'read_file', arguments: '{"path":"1"}' }, { id: 'b', name: 'read_file', arguments: '{"path":"2"}' },
  ], 'two calls with no index are told apart by their ids');
  assert.deepEqual(await calls(call(null, { id: 'a', ...fn('read_file', '{"pa') }) + call(null, fn(undefined, 'th":"1"}')) + done), [{ id: 'a', name: 'read_file', arguments: '{"path":"1"}' }], 'a fragment with no index and no id continues the last call');
  assert.deepEqual(await calls(call(1, { id: 'b', ...fn('read_file', '{}') }) + call(0, { id: 'a', ...fn('read_file', '{}') }) + done), [
    { id: 'b', name: 'read_file', arguments: '{}' }, { id: 'a', name: 'read_file', arguments: '{}' },
  ], 'calls come in the order they began, not the order of their index');
  const same = await calls(call(0, { id: 'dup', ...fn('read_file', '{}') }) + call(1, { id: 'dup', ...fn('read_file', '{"a":1}') }) + done);
  assert.equal(same[0].id, 'dup');
  assert.match(same[1].id, /^call_[0-9a-f]{24}$/, 'two calls that share an id: the second gets a new one');
  const reused = await calls(call(0, { id: 'old', ...fn('read_file', '{}') }) + done, { usedCallIds: new Set(['old']) });
  assert.match(reused[0].id, /^call_[0-9a-f]{24}$/, 'an id that an earlier turn used is not used again');
  const noId = await calls(call(0, fn('read_file', '{}')) + done);
  assert.match(noId[0].id, /^call_[0-9a-f]{24}$/, 'a call with no id gets one');
  assert.deepEqual(await calls(call(0, { id: 'o', type: 'function', function: { name: 'read_file', arguments: { path: 'a' } } }) + done), [{ id: 'o', name: 'read_file', arguments: '{"path":"a"}' }], 'arguments sent as an object');
  assert.deepEqual(await calls(call(0, { id: 'e', ...fn('list_dir') }) + done), [{ id: 'e', name: 'list_dir', arguments: '{}' }], 'a call that never sends arguments');
  assert.equal(textOfResult((await readChat(chunk({ content: [{ type: 'text', text: 'ab' }, { type: 'text', text: 'cd' }] }, 'stop'))).result), 'abcd', 'content in parts');
  const both = (await readChat(chunk({ content: 'Để tôi đọc tệp.' }) + call(0, { id: 'c', ...fn('read_file', '{}') }) + done)).result;
  assert.deepEqual(both.output.map((item) => [item.type, item.phase ?? null]), [['message', 'commentary'], ['function_call', null]], 'text before a call is commentary, as in the plain answer');
  const two = await readChat(frame({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 1, delta: { content: 'NOT THIS' } }, { index: 0, delta: { content: 'this' }, finish_reason: 'stop' }] }));
  assert.equal(textOfResult(two.result), 'this', 'only the first choice is read');
  assert.equal(textOfResult((await readChat(frame({ id: 'x', choices: [{ delta: { content: 'no index' }, finish_reason: 'stop' }] }))).result), 'no index', 'a choice with no index is the first');
  const usageFirst = (await readChat(frame({ id: 'x', choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } }) + chunk({ content: 'ok' }, 'stop'))).result;
  assert.deepEqual([usageFirst.usage.input_tokens, usageFirst.usage.output_tokens], [5, 2], 'a usage chunk before the answer');
  assert.equal(textOfResult((await readChat(frame({ id: 'x', choices: [{ index: 0, delta: { role: 'assistant', content: 'Z', unknown_field: { a: 1 } }, finish_reason: 'stop', extra: true }], more: [1] }))).result), 'Z', 'fields the Hub does not know are ignored');
  assert.deepEqual(await calls(call(0, { id: 'first', ...fn('read_file', '') }) + call(0, { id: 'second', ...fn(undefined, '{}') }) + done), [{ id: 'first', name: 'read_file', arguments: '{}' }], 'the id of a call is the first one it was given');
  assert.deepEqual(await calls(call(0, { id: 'c1', ...fn('read_file', '') }) + call(0, fn('list_directory', '{}')) + done), [{ id: 'c1', name: 'read_file', arguments: '{}' }], 'a later name that is another name, even a longer one, is not the name of the call');
  assert.deepEqual(await calls(call(0, { id: 'c1', ...fn('read_file', '{}') }) + chunk({ tool_calls: [{ index: 0, id: 'c1' }] }) + done), [{ id: 'c1', name: 'read_file', arguments: '{}' }], 'a fragment with no function in it changes nothing');
  assert.equal(textOfResult((await readChat(chunk({ content: 'x' }) + frame({ id: 'x', choices: [{ index: 0, finish_reason: 'stop' }] }))).result), 'x', 'a choice with no delta adds nothing');
  assert.equal((await attempt(frame({ id: 'x', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n')).error?.code, INVALID, 'a stream that completes with nothing in it is not an answer (the plain path calls it empty; a stream may have lost the rest, so it is asked again)');
  assert.equal((await attempt(chunk({ content: '  \n' }, 'stop'))).error?.code, INVALID, 'nor one with only white space');
  assert.equal((await readChat(chunk({}, 'length'))).result.status, 'incomplete', 'but an answer the limit cut before its first word is incomplete, as the plain path says');
  // a finish_reason that is empty or null is no finish_reason: only a word completes the answer
  for (const empty of ['', null]) assert.equal((await attempt(chunk({ content: 'abc' }, empty))).error?.code, INTERRUPTED, `finish_reason ${JSON.stringify(empty)}`);
  assert.match((await attempt(call(0, { id: 'c', ...fn('read_file', '{}') }) + 'data: [DONE]\n\n')).error.message, /finish_reason cho một lời gọi công cụ/, 'and the error says what was missing');
  assert.match((await attempt(chunk({ content: 'abc' }))).error.message, /finish_reason hay \[DONE\]/);
  assert.match((await attempt(`data: ${JSON.stringify({ error: 'just a string' })}\n\n`)).error.message, /just a string/, 'an error given as a string is the message');

  // the reader used on its own, event by event
  const direct = createChatStreamReader({});
  await direct.event({ data: JSON.stringify({ choices: [{ index: 0, delta: { content: 'a' }, finish_reason: 'stop' }] }) });
  assert.equal(await direct.event({ data: '[DONE]' }), SSE_STOP, '[DONE] says the stream is over');
  await direct.event({ data: JSON.stringify({ error: { message: 'after the end' } }) });
  await direct.event({ data: JSON.stringify({ choices: [{ index: 0, delta: { content: 'late' } }] }) });
  assert.equal(textOfResult(direct.finish()), 'a', 'whatever comes after [DONE] is not read');
  const failing = createChatStreamReader({ onToken: async () => { throw Object.assign(new Error('the handler failed'), { code: 'handler_failed' }); } });
  await assert.rejects(() => failing.event({ data: JSON.stringify({ choices: [{ index: 0, delta: { content: 'a' } }] }) }), { code: 'handler_failed' });
  const slowReader = [];
  const ordered = createChatStreamReader({ onToken: async (piece) => { await new Promise((resolve) => setTimeout(resolve, 5)); slowReader.push(piece); } });
  await ordered.event({ data: JSON.stringify({ choices: [{ index: 0, delta: { content: 'a' } }] }) });
  assert.deepEqual(slowReader, ['a'], 'a handler that takes time is waited for');
  ok('Chat reader on its own: [DONE] ends it, nothing after [DONE] is read, a failing or slow handler is waited for, a finish_reason that is empty or null completes nothing, an id and a name are the first ones');
}

// ------------------------------------------------------------------ 3b. what an error inside a stream is, as an HTTP status
{
  const { streamErrorStatus, isStreamFallback, streamInterrupted, streamInvalid, streamProviderError } = await import('../lib/model-stream.mjs');
  const table = {
    invalid_request_error: 400, authentication_error: 401, permission_error: 403, not_found_error: 404, request_too_large: 413, rate_limit_error: 429, api_error: 500, overloaded_error: 529,
    rate_limit_exceeded: 429, insufficient_quota: 429, context_length_exceeded: 400, server_error: 500, service_unavailable: 503, overloaded: 503, model_not_found: 404,
    invalid_argument: 400, unauthenticated: 401, permission_denied: 403, not_found: 404, resource_exhausted: 429, internal: 500, unavailable: 503, deadline_exceeded: 504,
  };
  for (const [name, status] of Object.entries(table)) {
    assert.equal(streamErrorStatus({ type: name }), status, `type ${name}`);
    assert.equal(streamErrorStatus({ code: name }), status, `code ${name}`);
    assert.equal(streamErrorStatus({ status: name.toUpperCase() }), status, `status ${name.toUpperCase()}`);
  }
  for (const [error, status] of [[{ code: 400 }, 400], [{ code: 599 }, 599], [{ code: '503' }, 503], [{ status: 429 }, 429], [{ code: 399 }, 502], [{ code: 600 }, 502], [{ code: 200 }, 502], [{ code: 1.5 }, 502], [{ code: 450.5 }, 502], [{ type: 'constructor' }, 502], [{ code: '__proto__' }, 502], [{ message: 'x' }, 502], [null, 502], [undefined, 502], ['text', 502], [{ code: 'weird', type: 'server_error' }, 500], [{ code: 503, type: 'server_error' }, 503]]) {
    assert.equal(streamErrorStatus(error), status, JSON.stringify(error));
  }
  assert.deepEqual([isStreamFallback(streamInterrupted('x')), isStreamFallback(streamInvalid('x')), isStreamFallback(streamProviderError({ message: 'x' }, 500)), isStreamFallback(new Error('x')), isStreamFallback(null)], [true, true, false, false, false]);
  const failure = streamProviderError({ message: 'Overloaded', type: 'overloaded_error' }, 529);
  assert.deepEqual([failure.code, failure.kind, failure.upstreamStatus, failure.statusCode, failure.data.error.type, failure.message], ['gateway_stream_error', 'stream_error', 529, 502, 'overloaded_error', 'Overloaded']);
  assert.equal(streamProviderError({}, 500).message, 'Nhà cung cấp báo lỗi giữa luồng.', 'an error with no message has one of its own');
  assert.deepEqual([streamInterrupted('x').code, streamInterrupted('x').kind, streamInvalid('x').code, streamInvalid('x').kind], ['gateway_stream_interrupted', 'stream_interrupted', 'gateway_stream_invalid', 'stream_invalid']);
  ok('Stream errors: every error name of Anthropic, OpenAI and Google is the HTTP status it stands for; a number is a status only between 400 and 599; the three failures have their own code and kind');
}

// ------------------------------------------------------------------ 4. the adapter: one model request, as a stream
const { LIMITS } = await import('../lib/standard-adapter.mjs');
const fixtureByName = byName;
{
  const text = fixtureByName('openai-text');
  const answer = textOf(text);

  // the request, and the answer
  const streamed = await drive([sse(answer)]);
  assert.deepEqual(streamed.value, normalizeChatCompletion(text.completion), 'the answer is the plain one');
  assert.equal(streamed.shown, text.summary.text, 'and its text was shown as it came');
  assert.equal(streamed.sent[0].stream, true);
  assert.deepEqual(streamed.sent[0].stream_options, { include_usage: true });
  assert.deepEqual(kinds(streamed.events).filter((event) => event !== 'token'), ['before', 'fetch'], 'one request, announced; nothing else to say');
  assert.ok(streamed.events.filter((event) => event.startsWith('token:')).length > 3, 'in pieces');
  const plain = await drive([jsonResponse(200, text.completion)], { ctx: { stream: false } });
  assert.deepEqual([plain.sent[0].stream, plain.sent[0].stream_options], [false, undefined], 'a call that did not ask for a stream does not get one');
  assert.deepEqual(kinds(plain.events), ['before', 'fetch'], 'and gets no tokens');
  assert.deepEqual(plain.value, streamed.value);
  const unset = await drive([jsonResponse(200, text.completion)], { ctx: { stream: undefined } });
  assert.equal(unset.sent[0].stream, false);

  // a server that ignores `stream` and answers with JSON: the answer is the same, the text comes at the end
  const ignored = await drive([jsonResponse(200, text.completion)]);
  assert.deepEqual(ignored.value, streamed.value);
  assert.deepEqual(ignored.events, ['before', 'fetch', `token:${text.summary.text}`], 'text at the end, once');
  assert.equal(ignored.events.includes('remembered'), false, 'a server that answers a stream request with JSON is not "refused": it works');

  // the usage chunk is only asked for when it is wanted and known to be accepted
  const refusedUsage = jsonResponse(400, { error: { message: "Unrecognized request argument supplied: stream_options", type: 'invalid_request_error', param: 'stream_options', code: null } });
  const dropped = await drive([refusedUsage, sse(answer)]);
  assert.deepEqual(dropped.sent.map((body) => [body.stream, body.stream_options]), [[true, { include_usage: true }], [true, undefined]], 'only the stream_options are taken out of the repeat');
  assert.deepEqual({ ...dropped.sent[1], stream: true }, (({ stream_options, ...rest }) => rest)(dropped.sent[0]), 'nothing else changed');
  assert.deepEqual(kinds(dropped.events).filter((event) => event !== 'token'), ['before', 'fetch', 'status', 'before', 'fetch', 'remembered-options'], 'announced; both requests counted; remembered once the repeat is accepted');
  assert.equal(dropped.shown, text.summary.text);
  for (const message of ['stream_options is not supported by this deployment.', 'Unknown field include_usage in stream_options.', "Extra inputs are not permitted: stream_options.include_usage"]) {
    const again = await drive([jsonResponse(400, { error: { message } }), sse(answer)]);
    assert.deepEqual(again.sent.map((body) => body.stream_options !== undefined), [true, false], message);
  }
  const byField = await drive([jsonResponse(400, { error: { message: 'Invalid value.', param: 'stream_options', code: 'invalid_value' } }), sse(answer)]);
  assert.deepEqual(byField.sent.map((body) => body.stream_options !== undefined), [true, false], 'a 400 that only names the field');
  const aboutContext = await drive([jsonResponse(400, { error: { message: "This model's maximum context length is 8192 tokens. Reduce the length of the messages (stream_options include_usage).", code: 'context_length_exceeded' } })], { ctx: { limits: { requestTimeoutMs: 5000, maxCompactions: 0 } } });
  assert.deepEqual([aboutContext.sent.length, aboutContext.error?.code], [1, 'gateway_context_length'], 'a 400 about the context that mentions the option is about the context');
  const knownUsage = await drive([sse(answer)], { ctx: { streamOptionsRefused: true } });
  assert.deepEqual([knownUsage.sent[0].stream, knownUsage.sent[0].stream_options], [true, undefined], 'a refusal the caller already knows is not asked again');
  assert.equal(knownUsage.events.includes('remembered-options'), false);
  const secondRefusal = await drive([refusedUsage, refusedUsage, sse(answer)]);
  assert.equal(secondRefusal.sent.length, 2, 'once');
  assert.equal(secondRefusal.error?.upstreamStatus, 400);

  // a server that cannot stream at all
  const refusedStream = jsonResponse(400, { error: { message: "Unsupported value: 'stream' does not support true with this model. Supported values are: false.", param: 'stream', code: 'unsupported_value' } });
  const repeated = await drive([refusedStream, jsonResponse(200, text.completion)]);
  assert.deepEqual(repeated.value, streamed.value);
  assert.deepEqual(repeated.sent.map((body) => [body.stream, body.stream_options]), [[true, { include_usage: true }], [false, undefined]], 'the same request, once more, without the stream (and without stream_options, which belong to it)');
  assert.deepEqual(kinds(repeated.events), ['before', 'fetch', 'status', 'before', 'fetch', 'remembered', 'token'], 'announced, both requests counted, remembered once the repeat is accepted, the text at the end');
  for (const body of [{ error: { message: 'Streaming is not supported for this deployment.' } }, { error: { message: 'Invalid value.', param: 'stream' } }, { error: { message: 'Your organization must be verified to stream this model.', param: 'stream', code: 'unsupported_value' } }]) {
    const again = await drive([jsonResponse(400, body), jsonResponse(200, text.completion)]);
    assert.deepEqual(again.sent.map((sentBody) => sentBody.stream), [true, false], JSON.stringify(body));
  }
  for (const [label, response, code] of [
    ['a 400 that does not mention the stream', jsonResponse(400, { error: { message: 'Invalid value: foo.' } }), 'gateway_http_error'],
    ['a 400 about the context that mentions the stream', jsonResponse(400, { error: { message: "This model's maximum context length is 8192 tokens. Reduce the length of the messages (stream).", code: 'context_length_exceeded' } }), 'gateway_context_length'],
    ['a 401', jsonResponse(401, { error: { message: 'Invalid key for stream requests.' } }), 'gateway_auth'],
    ['a 404', jsonResponse(404, { error: { message: 'No route for stream.' } }), 'gateway_http_error'],
  ]) {
    const only = await drive([response], { ctx: { limits: { requestTimeoutMs: 5000, maxCompactions: 0 } } });
    assert.equal(only.sent.length, 1, `${label}: no second attempt`);
    assert.equal(only.error?.code, code, label);
  }
  const bothFail = await drive([refusedStream, jsonResponse(500, { error: { message: 'upstream broke' } })], { ctx: { limits: { requestTimeoutMs: 5000, maxHttpRetries: 0 } } });
  assert.equal(bothFail.sent.length, 2);
  assert.equal(bothFail.events.includes('remembered'), false, 'a refusal is remembered only when the repeat was accepted');
  const knownStream = await drive([jsonResponse(200, text.completion)], { ctx: { streamRefused: true } });
  assert.deepEqual(knownStream.sent.map((body) => body.stream), [false], 'a refusal the caller already knows is not asked again');
  assert.deepEqual(knownStream.events, ['before', 'fetch', `token:${text.summary.text}`], 'and the text still arrives, at the end, with no announcement');
  // a call that does not stream has nothing to fall back from: a 400 that talks about the stream, or about stream_options, is an error like any other
  const quietStream = await drive([refusedStream], { ctx: { stream: false } });
  assert.deepEqual([quietStream.sent.length, quietStream.error?.upstreamStatus], [1, 400]);
  const quietOptions = await drive([refusedUsage], { ctx: { stream: false } });
  assert.deepEqual([quietOptions.sent.length, quietOptions.error?.upstreamStatus], [1, 400]);
  // an answer that says it is a stream and has no body
  const noBody = await drive([{ ok: true, status: 200, headers: new Headers({ 'content-type': 'text/event-stream' }), body: null }, jsonResponse(200, text.completion)]);
  assert.deepEqual(noBody.sent.map((body) => body.stream), [true, false]);
  assert.deepEqual(noBody.value, streamed.value);
  // the events of a stream are many times the size of its answer: the cap on a stream is its own, and a stream over it is not repeated
  const tooBig = await drive([sse(answer)], { ctx: { limits: { requestTimeoutMs: 5000, streamMaxBytes: 1000 } } });
  assert.equal(tooBig.error?.code, 'gateway_too_large');
  assert.equal(tooBig.sent.length, 1);
  assert.ok(LIMITS.streamMaxBytes >= 32 * 1024 * 1024, 'and by default it is far above the 12 MiB of a plain response');
  // an answer cut by the output limit that did not stream is not shown as text
  const unfinished = await drive([jsonResponse(200, fixtureByName('openai-length').completion)]);
  assert.equal(unfinished.value.status, 'incomplete');
  assert.deepEqual(kinds(unfinished.events), ['before', 'fetch'], 'an unfinished answer is not shown as text');
  ok('Chat adapter: stream and stream_options are asked for only when wanted, a server that ignores or refuses either is handled with one repeat, remembered when the repeat is accepted');
}

// ------------------------------------------------------------------ 5. a stream that ends early, or fails: nothing of it is used
{
  const tools = fixtureByName('openai-tools');
  const toolsText = textOf(tools);
  const textFixture = fixtureByName('openai-text');
  const answer = textOf(textFixture);
  const plainTools = normalizeChatCompletion(tools.completion);
  const executed = [];
  /** What an agent does with an answer: it runs the calls in it. Counting the runs is how the tests see "no tool". */
  const execute = (outcome) => { for (const item of outcome.value?.output ?? []) if (item.type === 'function_call') executed.push(item.call_id); };

  // cut in the middle of a call: the repeat without a stream is the only answer there is, and the half call is not run
  const cut = firstFrames(toolsText, 5);
  const afterCut = await drive([sse(cut), jsonResponse(200, tools.completion)]);
  execute(afterCut);
  assert.deepEqual(afterCut.value, plainTools, 'the answer is the repeat\'s');
  assert.deepEqual(afterCut.sent.map((body) => body.stream), [true, false], 'one repeat, without a stream');
  assert.deepEqual(kinds(afterCut.events), ['before', 'fetch', 'status', 'before', 'fetch', 'remembered'], 'announced; both requests counted; remembered once the repeat was accepted; no text, so no reset');
  assert.deepEqual(executed, [plainTools.output[0].call_id, plainTools.output[1].call_id], 'the calls of the repeat are the only ones that exist');
  executed.length = 0;
  const bothCut = await drive([sse(cut), jsonResponse(500, { error: { message: 'broken' } })], { ctx: { limits: { requestTimeoutMs: 5000, maxHttpRetries: 0 } } });
  execute(bothCut);
  assert.equal(bothCut.error?.upstreamStatus, 500);
  assert.equal(executed.length, 0, 'a cut stream and a repeat that fails: no tool at all');
  assert.equal(bothCut.events.includes('remembered'), false);

  // cut after some text: what was shown is taken back before the repeat, and the repeat's text comes whole
  const cutText = firstFrames(answer, 5);
  const afterText = await drive([sse(cutText), jsonResponse(200, textFixture.completion)]);
  assert.deepEqual(afterText.value, normalizeChatCompletion(textFixture.completion));
  const order = kinds(afterText.events);
  assert.deepEqual(order.slice(0, 2), ['before', 'fetch']);
  assert.ok(order.indexOf('reset') > order.lastIndexOf('token', order.indexOf('reset')), 'the reset comes after the pieces that were shown');
  assert.deepEqual(order.slice(order.indexOf('reset')), ['reset', 'status', 'before', 'fetch', 'remembered', 'token'], 'reset, announcement, the repeat, remembered, then the whole text');
  assert.equal(afterText.events.at(-1), `token:${textFixture.summary.text}`);
  assert.ok(afterText.shown.endsWith(textFixture.summary.text) && afterText.shown.length > textFixture.summary.text.length, 'the person saw the pieces, then (after the reset) the whole text');

  // an invalid stream is the same
  const garbled = await drive([sse(firstFrames(answer, 3) + 'data: this is not json\n\n'), jsonResponse(200, textFixture.completion)]);
  assert.deepEqual(garbled.sent.map((body) => body.stream), [true, false]);
  assert.equal(garbled.events.includes('reset'), true);
  const damagedCall = await drive([sse(firstFrames(toolsText, 3) + chunk({}, 'tool_calls')), jsonResponse(200, tools.completion)]);
  assert.deepEqual(damagedCall.sent.map((body) => body.stream), [true, false], 'a call whose arguments are cut but whose finish_reason says it is complete: the repeat');
  // a stream that ends at once with nothing in it
  const empty = await drive([sse(''), jsonResponse(200, textFixture.completion)]);
  assert.deepEqual(empty.sent.map((body) => body.stream), [true, false]);
  assert.equal(empty.events.includes('reset'), false, 'nothing was shown, so nothing is taken back');
  // after the repeat has been accepted the caller remembers, and does not stream any more: no second chance for the same cut
  const remembered = await drive([jsonResponse(200, tools.completion)], { ctx: { streamRefused: true } });
  assert.deepEqual(remembered.sent.map((body) => body.stream), [false]);

  // an error inside the stream is the HTTP error it would have been
  const inStream = (frames, error) => sse(frames + `data: ${JSON.stringify({ error })}\n\n`);
  const overloaded = await drive([inStream(firstFrames(answer, 4), { code: 'server_error', message: 'Provider disconnected' }), sse(answer)]);
  assert.deepEqual(overloaded.value, normalizeChatCompletion(textFixture.completion), 'a server error is retried, as a stream again');
  assert.deepEqual(overloaded.sent.map((body) => body.stream), [true, true]);
  const retried = kinds(overloaded.events);
  assert.deepEqual(retried.slice(retried.indexOf('reset')).filter((event) => event !== 'token'), ['reset', 'status', 'sleep', 'before', 'fetch'], 'the pieces are taken back, the wait is announced, the model request is made again');
  assert.equal(overloaded.events.includes('remembered'), false, 'an error is not a refusal to stream');
  const rejected = await drive([inStream(firstFrames(answer, 4), { type: 'invalid_request_error', message: 'Invalid value: foo.' })]);
  assert.equal(rejected.error?.code, 'gateway_http_error');
  assert.equal(rejected.error.upstreamStatus, 400, 'a refusal in the middle of the stream is a refusal: it is not repeated');
  assert.equal(rejected.sent.length, 1);
  assert.equal(rejected.events.includes('reset'), false, 'the run ends with the error: the failed state clears what was shown, the adapter has no new attempt to take it back for');
  const broke = await drive([inStream('', { message: 'You exceeded your current quota, please check your plan and billing details.', type: 'insufficient_quota', code: 'insufficient_quota' })]);
  assert.equal(broke.error?.code, 'gateway_quota', 'quota is quota whether it is said before the stream or in it');
  const secret = await drive([inStream('', { message: 'Bad key sk-abcdefghijklmnop', code: 401 })], { ctx: { redact: (value) => value.replace(/sk-[a-z]+/g, '[REDACTED]') } });
  assert.equal(secret.error?.code, 'gateway_auth');
  assert.ok(!secret.error.message.includes('sk-abc'), 'and the provider\'s words are redacted');
  ok('Chat adapter: a stream cut or damaged is repeated once without a stream (the half answer is never used, what was shown is taken back); an error in the stream is the HTTP error it would have been');

  // zero tools, whatever the way the stream fails
  executed.length = 0;
  const ways = [
    ['cut at every frame before the finish_reason of a call', Array.from({ length: framesOf(toolsText).findIndex((piece) => piece.includes('"finish_reason":"tool_calls"')) + 1 }, (_, k) => sse(firstFrames(toolsText, k)))],
    ['an error chunk after the call began', [inStream(firstFrames(toolsText, 3), { message: 'x', code: 400 })]],
    ['a damaged chunk after the call began', [sse(`${firstFrames(toolsText, 3)}data: {"choices"\n\n`)]],
  ];
  let runs = 0;
  for (const [label, streams] of ways) {
    for (const first of streams) {
      // the repeat is a plain refusal of service, so there is no answer and an agent would run nothing
      const outcome = await drive([first, jsonResponse(503, { error: { message: 'down' } })], { ctx: { limits: { requestTimeoutMs: 5000, maxHttpRetries: 0 } } });
      execute(outcome);
      runs += 1;
      assert.equal(outcome.value, undefined, label);
    }
  }
  assert.equal(executed.length, 0, `${runs} streams that failed after a call began: no tool was run`);
  ok(`Chat zero tools: ${runs} ways for a stream to fail after a call began, 0 tools executed`);
}

// ------------------------------------------------------------------ 6. the connection fails, or goes quiet
{
  const textFixture = fixtureByName('openai-text');
  const answer = textOf(textFixture);
  const plain = normalizeChatCompletion(textFixture.completion);
  /** A stream that sends its first frames, then fails the way a socket does. */
  const resets = (frames) => () => {
    let sent = false;
    const encoded = encoder.encode(frames);
    return { ok: true, status: 200, headers: new Headers({ 'content-type': 'text/event-stream' }), body: new ReadableStream({ pull(controller) { if (!sent) { sent = true; controller.enqueue(encoded); } else controller.error(Object.assign(new TypeError('terminated'), { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) })); } }) };
  };
  const reset = await drive([resets(firstFrames(answer, 4)), sse(answer)]);
  assert.deepEqual(reset.value, plain, 'a connection that drops in the middle of a stream: the request is made again, as a stream');
  assert.deepEqual(reset.sent.map((body) => body.stream), [true, true]);
  const resetOrder = kinds(reset.events);
  assert.deepEqual(resetOrder.slice(resetOrder.indexOf('reset')).filter((event) => event !== 'token'), ['reset', 'status', 'sleep', 'before', 'fetch'], 'what was shown is taken back; the wait is announced');
  assert.equal(reset.events.includes('remembered'), false, 'a dropped connection says nothing about whether the server streams');

  // silence: the idle clock starts when the response does and starts again with every byte
  const quiet = (frames) => (init) => {
    let controller;
    const body = new ReadableStream({ start(c) { controller = c; c.enqueue(encoder.encode(frames)); } });
    init.signal.addEventListener('abort', () => controller.error(new DOMException('This operation was aborted', 'AbortError')), { once: true });
    return { ok: true, status: 200, headers: new Headers({ 'content-type': 'text/event-stream' }), body };
  };
  const limits = (extra) => ({ requestTimeoutMs: 5000, idleTimeoutMs: 80, ...extra });
  const idle = await drive([quiet(firstFrames(answer, 4)), sse(answer)], { ctx: { limits: limits() } });
  assert.deepEqual(idle.value, plain, 'a stream that goes quiet is cut and the request is made again');
  assert.equal(idle.events.includes('reset'), true);
  const stalled = await drive([quiet(firstFrames(answer, 4)), quiet(firstFrames(answer, 4)), quiet(firstFrames(answer, 4))], { ctx: { limits: limits() } });
  assert.equal(stalled.error?.code, 'gateway_timeout', 'a provider that keeps going quiet ends the run with a reason');
  assert.match(stalled.error.message, /sau 3 lần chờ 1 giây/, 'and says how long it waited each time: the idle limit that ended the stream, not the request timeout');
  assert.equal(stalled.sent.length, 3);
  const trickle = (frames) => () => {
    const all = frames.slice();
    return { ok: true, status: 200, headers: new Headers({ 'content-type': 'text/event-stream' }), body: new ReadableStream({ async pull(controller) { if (!all.length) { controller.close(); return; } await new Promise((resolve) => setTimeout(resolve, 40)); controller.enqueue(encoder.encode(all.shift())); } }) };
  };
  const alive = await drive([trickle([': keep-alive\n\n', ...framesOf(answer)])], { ctx: { limits: limits({ idleTimeoutMs: 150 }) } });
  assert.deepEqual(alive.value, plain, 'a byte every 40 ms (keep-alives included) is not idle for 150 ms, however long the whole stream takes');
  const cappedAt = Date.now();
  const capped = await drive([trickle(Array.from({ length: 200 }, () => ': keep-alive\n\n'))], { ctx: { limits: limits({ idleTimeoutMs: 500, streamTotalMs: 120, maxTimeouts: 0 }) } });
  assert.equal(capped.error?.code, 'gateway_timeout', 'a stream that never finishes, however alive it looks, is cut by the total cap');
  assert.ok(Date.now() - cappedAt < 3000, 'at the cap, not when the stream happens to end (it would trickle for eight seconds)');
  const headersAt = Date.now();
  const beforeHeaders = await drive([(init) => new Promise((_, reject) => { const hold = setTimeout(() => {}, 5000); init.signal.addEventListener('abort', () => { clearTimeout(hold); reject(new DOMException('This operation was aborted', 'AbortError')); }, { once: true }); })], { ctx: { limits: limits({ requestTimeoutMs: 60, idleTimeoutMs: 5000, maxTimeouts: 0 }) } });
  assert.equal(beforeHeaders.error?.code, 'gateway_timeout', 'no response at all within the request timeout');
  assert.ok(Date.now() - headersAt < 2000, 'the request timeout, not the idle limit, is the wait for a response to begin');
  const emptyAt = Date.now();
  const noByte = (init) => {
    let controller;
    const body = new ReadableStream({ start(c) { controller = c; } });
    init.signal.addEventListener('abort', () => controller.error(new DOMException('This operation was aborted', 'AbortError')), { once: true });
    return { ok: true, status: 200, headers: new Headers({ 'content-type': 'text/event-stream' }), body };
  };
  const nothing = await drive([noByte, sse(answer)], { ctx: { limits: limits({ requestTimeoutMs: 5000, idleTimeoutMs: 80 }) } });
  assert.deepEqual(nothing.value, plain, 'a response that begins and sends nothing is cut by the idle limit and the request is made again');
  assert.ok(Date.now() - emptyAt < 2000, 'from the moment it began, not at the request timeout');
  const longer = await drive([trickle([...framesOf(answer)])], { ctx: { limits: limits({ requestTimeoutMs: 60, idleTimeoutMs: 500 }) } });
  assert.deepEqual(longer.value, plain, 'the request timeout is for the response to begin: a stream may take longer than it');

  // the person stops the task: their own reason, and the connection is closed
  const stop = new AbortController();
  let closed = false;
  const hanging = (init) => {
    let controller;
    const body = new ReadableStream({ start(c) { controller = c; c.enqueue(encoder.encode(firstFrames(answer, 3))); }, cancel() { closed = true; } });
    init.signal.addEventListener('abort', () => controller.error(new DOMException('This operation was aborted', 'AbortError')), { once: true });
    return { ok: true, status: 200, headers: new Headers({ 'content-type': 'text/event-stream' }), body };
  };
  setTimeout(() => stop.abort(Object.assign(new Error('cancelled by the person'), { code: 'user_cancelled' })), 40);
  const cancelled = await deadline(drive([hanging], { ctx: { limits: limits({ idleTimeoutMs: 5000 }) }, options: { signal: stop.signal } }), 'cancel');
  assert.equal(cancelled.error?.code, 'user_cancelled', 'the caller\'s own reason is not replaced by a timeout');
  assert.equal(cancelled.sent.length, 1);
  ok('Chat connection: a dropped or silent stream is made again as a stream (what was shown is taken back); keep-alives are life; a total cap; the request timeout is for the response to begin; the person\'s stop is their own');
}

// ------------------------------------------------------------------ 7. the text arrives while the stream does
{
  const names = ['openai-text', 'openrouter-text', 'deepseek-reasoning', 'ollama-text', 'vllm-text', 'azure-text', 'openai-length'];
  const pace = 12;
  for (const name of names) {
    const fixture = fixtureByName(name);
    const frames = framesOf(textOf(fixture));
    const last = frames.length - 1;
    let released = 0;
    let firstAt = null;
    let lastReleasedAt = null;
    let tokensBeforeLast = 0;
    const started = performance.now();
    const paced = () => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'text/event-stream' }), body: new ReadableStream({
      async pull(controller) {
        if (released >= frames.length) { controller.close(); return; }
        await new Promise((resolve) => setTimeout(resolve, pace));
        if (released === last) lastReleasedAt = performance.now();
        controller.enqueue(encoder.encode(frames[released]));
        released += 1;
      },
    }) });
    const outcome = await drive([paced], { options: { onToken: () => { if (firstAt === null) firstAt = performance.now(); if (released <= last) tokensBeforeLast += 1; } } });
    const total = performance.now() - started;
    assert.equal(outcome.error, undefined, name);
    assert.ok(tokensBeforeLast > 0, `${name}: onToken fired before the last chunk was sent`);
    assert.ok(firstAt !== null && firstAt < lastReleasedAt, `${name}: the first token came before the last chunk`);
    // a model that thinks first has no text for a while: its first token is later by nature, and only has to come before the end
    if (!fixture.summary.reasoning) assert.ok((firstAt - started) < total * 0.5, `${name}: first token after ${Math.round(firstAt - started)} ms of ${Math.round(total)} ms`);
  }
  ok(`Chat timing: for ${names.length} streams the first token came before the last chunk, and (but for the one that thinks first) in under half of the total time`);
}

// ------------------------------------------------------------------ 8. the provider: what is asked for, and what is remembered
{
  const { GatewayProvider } = await import('../lib/gateway-provider.mjs');
  const os = await import('node:os');
  const textFixture = fixtureByName('openai-text');
  const answer = textOf(textFixture);
  const plain = normalizeChatCompletion(textFixture.completion);
  const refusedStream = () => jsonResponse(400, { error: { message: "Unsupported value: 'stream' does not support true with this model.", param: 'stream', code: 'unsupported_value' } });
  const refusedUsage = () => jsonResponse(400, { error: { message: 'Unrecognized request argument supplied: stream_options', param: 'stream_options', type: 'invalid_request_error' } });
  const made = [];
  async function provider(script, { model = 'm', baseUrl = 'http://127.0.0.1:7333/v1', protocol = 'openai-chat' } = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chatmcp-stream-chat-'));
    made.push(directory);
    const sent = [];
    const queue = [...script];
    const gateway = new GatewayProvider({
      directory, manager: { secrets: [] }, env: {}, platform: 'linux', sleep: async () => {},
      fetchImpl: async (url, init) => { sent.push({ url, stream: JSON.parse(init.body).stream, options: JSON.parse(init.body).stream_options }); const next = queue.shift(); return typeof next === 'function' ? next(init) : next; },
    });
    await gateway.load();
    await gateway.configure({ preset: protocol === 'anthropic' ? 'custom-anthropic' : 'custom-openai', apiBaseUrl: baseUrl, protocol, model, authMode: 'bearer' });
    return { gateway, sent, queue };
  }
  const ask = (gateway, extra = {}) => gateway.respond({ input: HISTORY, instructions: 'Test', tools: TOOLS, maxOutputTokens: 1024, ...extra });
  try {
    // streamed when there is somebody to show the text to, and not otherwise
    const first = await provider([sse(answer), jsonResponse(200, textFixture.completion)]);
    const shown = [];
    assert.deepEqual(await ask(first.gateway, { onToken: (token) => shown.push(token) }), plain);
    assert.deepEqual(first.sent[0], { url: 'http://127.0.0.1:7333/v1/chat/completions', stream: true, options: { include_usage: true } });
    assert.equal(shown.join(''), textFixture.summary.text);
    assert.deepEqual(await ask(first.gateway), plain);
    assert.deepEqual([first.sent[1].stream, first.sent[1].options], [false, undefined], 'no onToken: nobody to show the text to, so no stream');

    // refused once: remembered, for this endpoint and model; a change of either (or of the configuration) asks again
    const refusing = await provider([refusedStream(), jsonResponse(200, textFixture.completion), jsonResponse(200, textFixture.completion), sse(answer), jsonResponse(200, textFixture.completion)]);
    const texts = [];
    const statuses = [];
    assert.deepEqual(await ask(refusing.gateway, { onToken: (token) => texts.push(token), onStatus: async (message) => statuses.push(message) }), plain);
    assert.equal(statuses.length, 1);
    assert.deepEqual(refusing.sent.map((entry) => entry.stream), [true, false]);
    assert.equal(texts.join(''), textFixture.summary.text, 'the text came at the end');
    texts.length = 0;
    await ask(refusing.gateway, { onToken: (token) => texts.push(token) });
    assert.deepEqual(refusing.sent.map((entry) => entry.stream), [true, false, false], 'the next call does not ask for a stream again');
    assert.equal(texts.join(''), textFixture.summary.text, 'and still gets its text');
    await refusing.gateway.configure({ apiBaseUrl: 'http://127.0.0.1:7333/v1', model: 'another-model' });
    await ask(refusing.gateway, { onToken: () => {} });
    assert.equal(refusing.sent[3].stream, true, 'another model: the refusal was about the first');
    await refusing.gateway.configure({ model: 'm' });
    await ask(refusing.gateway, { onToken: () => {} });
    assert.equal(refusing.sent[4].stream, true, 'back to the first model: a call for another model forgot the refusal, so it is asked again (one slot, as for the Responses protocol)');

    // stream_options refused once: remembered for the endpoint, whatever the model
    const options = await provider([refusedUsage(), sse(answer), sse(answer), sse(answer)]);
    await ask(options.gateway, { onToken: () => {} });
    await ask(options.gateway, { onToken: () => {} });
    assert.deepEqual(options.sent.map((entry) => [entry.stream, entry.options !== undefined]), [[true, true], [true, false], [true, false]], 'asked without them the next time');
    await options.gateway.configure({ model: 'another-model' });
    await ask(options.gateway, { onToken: () => {} });
    assert.deepEqual([options.sent[3].stream, options.sent[3].options], [true, undefined], 'for any model of that endpoint');

    // a stream that was cut: the repeat is the answer, remembered; what was shown is taken back
    const cutting = await provider([sse(firstFrames(answer, 5)), jsonResponse(200, textFixture.completion), jsonResponse(200, textFixture.completion)]);
    const events = [];
    assert.deepEqual(await ask(cutting.gateway, { onToken: (token) => events.push(`token:${token}`), onStreamReset: () => events.push('reset') }), plain);
    assert.equal(events.includes('reset'), true);
    assert.deepEqual(cutting.sent.map((entry) => entry.stream), [true, false]);
    await ask(cutting.gateway, { onToken: () => {} });
    assert.deepEqual(cutting.sent.map((entry) => entry.stream), [true, false, false], 'a cut stream is remembered like a refused one');

    // another endpoint: both refusals are forgotten (they were the other server's)
    const there = await provider([refusedStream(), jsonResponse(200, textFixture.completion), sse(answer)]);
    await ask(there.gateway, { onToken: () => {} });
    await there.gateway.configure({ apiBaseUrl: 'http://127.0.0.1:7334/v1' });
    await ask(there.gateway, { onToken: () => {} });
    assert.deepEqual(there.sent.map((entry) => [new URL(entry.url).port, entry.stream]), [['7333', true], ['7333', false], ['7334', true]], 'another endpoint is asked for a stream');
    const optionsThere = await provider([refusedUsage(), sse(answer), sse(answer)]);
    await ask(optionsThere.gateway, { onToken: () => {} });
    await optionsThere.gateway.configure({ apiBaseUrl: 'http://127.0.0.1:7334/v1' });
    await ask(optionsThere.gateway, { onToken: () => {} });
    assert.deepEqual(optionsThere.sent.map((entry) => [new URL(entry.url).port, entry.options !== undefined]), [['7333', true], ['7333', false], ['7334', true]], 'and for the usage chunk');

    // a task's own provider (a profile) starts from nothing
    const parent = await provider([refusedStream(), jsonResponse(200, textFixture.completion)]);
    await ask(parent.gateway, { onToken: () => {} });
    const child = parent.gateway.forkForTask({ protocol: 'openai-chat', apiBaseUrl: 'http://127.0.0.1:7333/v1', model: 'm', authMode: 'bearer', apiKey: '' });
    assert.ok(child);

    // Messages and Gemini do not stream yet in this slice of the work: nothing changes for them
    const anthropic = await provider([jsonResponse(200, { id: 'msg_1', type: 'message', role: 'assistant', model: 'm', content: [{ type: 'text', text: 'Hi' }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 1 } })], { protocol: 'anthropic', baseUrl: 'http://127.0.0.1:7333' });
    const anthropicTokens = [];
    await ask(anthropic.gateway, { onToken: (token) => anthropicTokens.push(token) });
    assert.equal(anthropic.sent[0].stream, undefined, 'the Messages request has no stream field');
    assert.deepEqual(anthropicTokens, [], 'and no text is delivered as tokens');
  } finally {
    for (const directory of made) fs.rmSync(directory, { recursive: true, force: true });
  }
  ok('Chat provider: streamed only for a caller that shows the text; a refused stream, a cut stream and a refused stream_options are remembered (per endpoint and model, per endpoint) and forgotten by another one');
}

// ------------------------------------------------------------------ 9. over a real connection: the mock server, with the failures a network has
{
  const { GatewayProvider } = await import('../lib/gateway-provider.mjs');
  const { startMockModel } = await import('./e2e/mock-model-server.mjs');
  const os = await import('node:os');
  const m = await startMockModel({ scenario: 'canned-answer', strict: true });
  const makeProvider = (limits) => new GatewayProvider({ directory: path.join(os.tmpdir(), 'chatmcp-stream-chat-unused'), bundleRoot: os.tmpdir(), manager: { secrets: [] }, env: {}, sleep: async () => {}, limits })
    .forkForTask({ protocol: 'openai-chat', apiBaseUrl: m.origin, model: 'mock-coder' });
  const ask = (provider, extra = {}) => provider.respond({ input: HISTORY, instructions: 'system', tools: TOOLS, maxOutputTokens: 1024, signal: AbortSignal.timeout(8000), ...extra });
  const listen = () => {
    const events = [];
    return { events, options: { onToken: (token) => events.push(`token:${token}`), onStreamReset: () => events.push('reset'), onStatus: async () => { events.push('status'); } } };
  };
  const tokensOf = (events) => events.filter((event) => event.startsWith('token:')).map((event) => event.slice(6)).join('');
  const streams = () => m.state.requests.map((request) => request.stream);
  try {
    // an ordinary answer, as a stream
    m.setScenario('canned-answer');
    const plain = listen();
    const first = await ask(makeProvider({ requestTimeoutMs: 5000 }), plain.options);
    assert.equal(first.status, 'completed');
    assert.equal(tokensOf(plain.events), 'Hello from the mock.');
    assert.deepEqual(streams(), [true]);
    assert.deepEqual([first.usage.input_tokens, first.usage.output_tokens], [120, 24], 'the usage chunk asked for with stream_options');
    assert.equal(m.state.requests[0].rejected, null, 'the strict server accepted what the Hub sent');

    // the stream is cut after some pieces: what was shown is taken back, the same request is made again without a stream, and that is the answer
    m.setScenario('canned-answer');
    const cut = m.inject({ kind: 'cut', on: 'chat', stream: true, afterEvents: 3 });
    const cutting = listen();
    const provider = makeProvider({ requestTimeoutMs: 5000 });
    const afterCut = await ask(provider, cutting.options);
    assert.equal(afterCut.status, 'completed');
    assert.deepEqual(streams(), [true, false], 'the same request, once more, without a stream');
    assert.equal(cut.used, 1);
    assert.equal(cutting.events.includes('reset'), true, 'what was shown is taken back');
    assert.equal(cutting.events.at(-1), 'token:Hello from the mock.', 'and the answer is shown whole');
    assert.equal(cutting.events.filter((event) => event === 'status').length, 1, 'the person is told once');
    m.setScenario('canned-answer');
    await ask(provider, listen().options);
    assert.deepEqual(streams(), [false], 'a cut stream is remembered: the next call does not ask for a stream');
    m.clearFaults();

    // the connection is torn down in the middle of the stream: a network failure, so the request is made again as a stream
    m.setScenario('canned-answer');
    m.inject({ kind: 'cut', on: 'chat', stream: true, afterEvents: 3, reset: true });
    const resetting = listen();
    const afterReset = await ask(makeProvider({ requestTimeoutMs: 5000 }), resetting.options);
    assert.equal(afterReset.status, 'completed');
    assert.deepEqual(streams(), [true, true], 'a dropped connection is retried as what it was');
    assert.equal(resetting.events.includes('reset'), true);
    assert.equal(tokensOf(resetting.events.slice(resetting.events.indexOf('reset'))), 'Hello from the mock.');
    m.clearFaults();

    // the server goes quiet in the middle of the stream: the idle clock ends it (its limit is the provider's), and the request is made again
    m.setScenario('canned-answer');
    m.inject({ kind: 'stall', on: 'chat', stream: true, afterEvents: 3 });
    const started = Date.now();
    const quiet = listen();
    const afterStall = await ask(makeProvider({ requestTimeoutMs: 5000, idleTimeoutMs: 300 }), quiet.options);
    assert.equal(afterStall.status, 'completed');
    assert.ok(Date.now() - started < 4000, 'the idle clock ended the wait, not the request timeout');
    assert.deepEqual(streams(), [true, true]);
    assert.equal(quiet.events.includes('reset'), true);
    m.clearFaults();

    // a server that answers 400 to stream: true
    m.setScenario('canned-answer');
    const refusal = m.inject({ kind: 'stream-unsupported', on: 'chat', times: 5 });
    const refusing = makeProvider({ requestTimeoutMs: 5000 });
    const refused = listen();
    assert.equal((await ask(refusing, refused.options)).status, 'completed');
    assert.equal((await ask(refusing, refused.options)).status, 'completed');
    assert.deepEqual(streams(), [true, false, false], 'the second call does not ask for a stream again');
    assert.equal(refusal.used, 1, 'the server refused once');
    assert.equal(tokensOf(refused.events), 'Hello from the mock.Hello from the mock.');
    m.clearFaults();
    assert.equal(m.state.rejections.length, 0, 'the strict server refused nothing in all of this');
    ok('Chat over HTTP against the strict mock: a stream, a stream cut (repeat without a stream, remembered), a connection torn down (retried as a stream), a server gone quiet (idle clock), a refused stream (once)');
  } finally {
    await m.close();
  }
}

console.log(`\nPASS: ${checks} chat stream checks`);
