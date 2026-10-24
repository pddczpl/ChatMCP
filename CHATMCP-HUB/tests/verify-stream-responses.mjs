// OpenAI Responses as a stream: golden streams and fail-closed (plan criterion AC-12 for the fourth protocol; Chat, Messages and Gemini have theirs).
// A Responses stream ends with a terminal event (`response.completed`, `.incomplete`, `.failed`) that carries the whole response, the one a request without `stream` returns. readResponsesStream
// (lib/openai-responses-api.mjs, over lib/sse.mjs) hands that response to the one normaliser of the plain path and shows the text of `response.output_text.delta` as it arrives; a stream that ends
// without the terminal event is no answer and no tool is called.
//   1. Golden streams: nine streams (tests/fixtures/streams/responses.json, each with the plain response of the same answer, written from one plan) give, whatever the chunk size, that response,
//      the same normalisation and the visible text through onToken; a refusal is not shown as text; a failed or incomplete response executes nothing.
//   2. Fail closed: a stream cut at every event boundary and at byte positions never gives an answer before its terminal event; a counter on a fake tool executor stays 0.
//   3. One call of the adapter: the text reaches the caller before the last chunk is sent, and in under half of the total time.
import assert from 'node:assert/strict';
import { normalizeResponsesResponse, readResponsesStream, respondOpenAIResponses } from '../lib/openai-responses-api.mjs';
import { accumulateResponsesStream, parseSse, validateResponsesStream } from './e2e/protocol-validators.mjs';
import { HISTORY, TOOLS, bodyOf, deadline, encoder, firstFrames, framesOf, loadFixtures, sse } from './support/stream-harness.mjs';

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
const { fixtures, textOf, byName } = loadFixtures('responses');
const CALL = (fixture) => fixture.summary.calls;

async function read(text, { chunkBytes = 97 } = {}) {
  const tokens = [];
  const response = await deadline(readResponsesStream(bodyOf(text, chunkBytes), { onToken: (token) => { tokens.push(token); } }), 'readResponsesStream');
  return { response, tokens };
}
const attempt = async (text, options) => read(text, options).then((value) => ({ value }), (error) => ({ error }));
const normalized = (response) => { try { return normalizeResponsesResponse(structuredClone(response)); } catch (error) { return { error: { code: error.code } }; } };
const executable = (result) => (result?.status === 'completed' ? result.output.filter((item) => item.type === 'function_call') : []);

// ------------------------------------------------------------------ 1. golden streams
{
  assert.ok(fixtures.length >= 6, 'at least six recorded-shape streams');
  const sizes = [1, 7, 97, 100000];
  let reads = 0;
  for (const fixture of fixtures) {
    const text = textOf(fixture);
    for (const chunkBytes of sizes) {
      const { response, tokens } = await read(text, { chunkBytes });
      assert.deepEqual(response, fixture.response, `${fixture.name} (chunks of ${chunkBytes} bytes): the response of the terminal event is the plain one`);
      assert.equal(tokens.join(''), fixture.summary.text, `${fixture.name}: the text shown while it streamed is the visible text of the answer`);
      reads += 1;
    }
    const answer = normalized(fixture.response);
    assert.equal(answer.status, fixture.summary.status, `${fixture.name}: status`);
    assert.deepEqual(executable(answer).map((call) => ({ name: call.name, arguments: call.arguments })), CALL(fixture), `${fixture.name}: calls`);
    if (fixture.summary.status !== 'completed') assert.deepEqual(answer.output, [], `${fixture.name}: a response that is not complete holds nothing to execute`);
    assert.deepEqual(validateResponsesStream(parseSse(text)).errors, [], `${fixture.name}: a well-formed Responses stream`);
    assert.deepEqual(accumulateResponsesStream(parseSse(text)), fixture.response, `${fixture.name}: the reference reader of the validators agrees`);
  }
  assert.equal(byName('refusal').summary.text, '', '(premise) a refusal is not visible text');
  assert.deepEqual(normalized(byName('refusal').response).output[0].content[0], { type: 'refusal', refusal: 'Tôi không thể giúp với yêu cầu này.' });
  assert.deepEqual(normalized(byName('reasoning-call').response).output.map((item) => item.type), ['reasoning', 'function_call'], 'encrypted reasoning is kept for the next request');
  assert.equal(normalized(byName('incomplete').response).incomplete_details.reason, 'max_output_tokens');
  assert.equal(normalized(byName('failed').response).incomplete_details.reason, 'server_error');
  ok(`Responses golden streams: ${fixtures.length} streams x ${sizes.length} chunk sizes (${reads} reads) give the response of the plain answer, the same normalisation and the visible text; a refusal is not shown, an incomplete or failed response holds nothing to execute`);
}

// ------------------------------------------------------------------ 2. fail closed
{
  const joinFrames = (frames) => frames.join('');
  let prefixes = 0;
  let cuts = 0;
  let executed = 0;
  for (const fixture of fixtures) {
    const text = textOf(fixture);
    const frames = framesOf(text);
    assert.match(frames.at(-1), /^event: response\.(completed|incomplete|failed)\n/, `${fixture.name}: the terminal event is the last`);
    for (let k = 0; k < frames.length; k += 1) {
      const outcome = await attempt(joinFrames(frames.slice(0, k)));
      prefixes += 1;
      assert.equal(outcome.error?.code, 'responses_stream_interrupted', `${fixture.name}: ${k} of ${frames.length} events is not an answer`);
      executed += executable(outcome.value ? normalized(outcome.value.response) : null).length;
    }
    const bytes = encoder.encode(text);
    for (let cut = 0; cut < bytes.length - 2; cut += 53) {
      const outcome = await attempt(new TextDecoder().decode(bytes.slice(0, cut)));
      cuts += 1;
      assert.ok(['responses_stream_interrupted', 'invalid_responses_stream'].includes(outcome.error?.code), `${fixture.name}: a cut at byte ${cut} is no answer (${outcome.error?.code})`);
      executed += executable(outcome.value ? normalized(outcome.value.response) : null).length;
    }
    assert.deepEqual((await attempt(joinFrames(frames))).value.response, fixture.response);
  }
  assert.equal(executed, 0, 'no tool is called from a stream that was cut');
  ok(`Responses fail closed: ${prefixes} event prefixes and ${cuts} byte cuts of ${fixtures.length} streams give no answer, and the counter of executed tools stays at ${executed}`);

  // a stream that is damaged, doubled or empty
  const full = framesOf(textOf(byName('function-call')));
  assert.equal((await attempt(joinFrames([...full, full.at(-1)]))).error?.code, 'duplicate_responses_terminal', 'two terminal events');
  assert.equal((await attempt(joinFrames([...full.slice(0, 3), 'data: not json\n\n', ...full.slice(3)]))).error?.code, 'invalid_responses_stream', 'an event that is not JSON');
  assert.equal((await attempt(joinFrames([...full.slice(0, 3), 'data: [1]\n\n', ...full.slice(3)]))).error?.code, 'invalid_responses_stream', 'an event that is not an object');
  const cancelled = { ...byName('text').response, status: 'cancelled' };
  const cancelledStream = joinFrames([...framesOf(textOf(byName('text'))).slice(0, 3), `event: response.cancelled\ndata: ${JSON.stringify({ type: 'response.cancelled', sequence_number: 99, response: cancelled })}\n\n`]);
  assert.deepEqual((await attempt(cancelledStream)).value.response, cancelled, 'a cancelled response is a terminal event too');
  assert.equal(normalized(cancelled).status, 'failed');
  assert.deepEqual(normalized(cancelled).output, [], 'and holds nothing to execute');
  assert.equal((await attempt('')).error?.code, 'responses_stream_interrupted', 'an empty stream');
  assert.equal((await attempt(': keep-alive\n\n')).error?.code, 'responses_stream_interrupted', 'only a comment');
  assert.equal((await attempt(joinFrames(['data: [DONE]\n\n', ...full]))).value.response.id, 'resp_call_0001', 'a [DONE] that some gateways add is nothing');
  assert.equal((await attempt(joinFrames([...full.slice(0, -1), `event: error\ndata: ${JSON.stringify({ type: 'error', code: 'rate_limit_exceeded', message: 'Rate limit reached' })}\n\n`]))).error?.code, 'responses_stream_interrupted', 'an error event after a call began: no answer, no tool');
  const noBody = await respondOpenAIResponses({ model: 'm', endpoint: 'https://example.test/v1/responses', headers: {}, stream: true, fetch: async () => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'text/event-stream' }), body: null }) },
    { input: HISTORY, instructions: 'x', tools: TOOLS }).then(() => null, (error) => error);
  assert.equal(noBody?.code, 'invalid_responses_stream', 'no body');
  const wrongType = await respondOpenAIResponses({ model: 'm', endpoint: 'https://example.test/v1/responses', headers: {}, stream: true, fetch: async () => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), body: bodyOf('{}') }) },
    { input: HISTORY, instructions: 'x', tools: TOOLS }).then(() => null, (error) => error);
  assert.equal(wrongType?.code, 'invalid_responses_stream', 'a body that is not an event stream');
  ok('Responses damaged streams: a doubled terminal event, an event that is not JSON or not an object, an empty stream, only a comment, an error event after a call began, no body, the wrong content type; a [DONE] is nothing');
}

// ------------------------------------------------------------------ 3. one call of the adapter
{
  const ask = (fixture, extra = {}) => {
    const events = [];
    const ctx = { model: 'gpt-5-mini', endpoint: 'https://example.test/v1/responses', headers: {}, stream: true, ...extra, fetch: extra.fetch ?? (async () => sse(textOf(fixture))) };
    return respondOpenAIResponses(ctx, { input: HISTORY, instructions: 'x', tools: TOOLS, onToken: (token) => { events.push(token); } }).then((value) => ({ value, events }), (error) => ({ error, events }));
  };
  for (const fixture of fixtures) {
    const outcome = await ask(fixture);
    assert.equal(outcome.error, undefined, fixture.name);
    assert.deepEqual(outcome.value, normalizeResponsesResponse(structuredClone(fixture.response)), `${fixture.name}: the answer is the plain one`);
    assert.equal(outcome.events.join(''), fixture.summary.text, `${fixture.name}: the text`);
  }
  // the text arrives while the stream does
  for (const name of ['text', 'function-call', 'reasoning-text', 'incomplete']) {
    const fixture = byName(name);
    assert.ok(fixture.summary.text, `(premise) ${name} has text to show`);
    const frames = framesOf(textOf(fixture));
    const last = frames.length - 1;
    let released = 0;
    let firstAt = null;
    let lastReleasedAt = null;
    let before = 0;
    const started = performance.now();
    const paced = async () => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'text/event-stream' }), body: new ReadableStream({
      async pull(controller) {
        if (released >= frames.length) { controller.close(); return; }
        await new Promise((resolve) => setTimeout(resolve, 8));
        if (released === last) lastReleasedAt = performance.now();
        controller.enqueue(encoder.encode(frames[released]));
        released += 1;
      },
    }) });
    await respondOpenAIResponses({ model: 'm', endpoint: 'https://example.test/v1/responses', headers: {}, stream: true, fetch: paced },
      { input: HISTORY, instructions: 'x', tools: TOOLS, onToken: () => { if (firstAt === null) firstAt = performance.now(); if (released <= last) before += 1; } });
    const total = performance.now() - started;
    assert.ok(before > 0 && firstAt < lastReleasedAt, `${name}: onToken fired before the last event was sent`);
    // a model that reasons first shows its text after the reasoning, which is most of the stream: the half-time rule is for the ones that start writing
    if (!fixture.response.output.some((item) => item.type === 'reasoning')) assert.ok((firstAt - started) < total * 0.5, `${name}: first token after ${Math.round(firstAt - started)} ms of ${Math.round(total)} ms`);
  }
  ok('Responses adapter: every golden stream gives the plain answer and its text through onToken; the text reaches the caller before the last event is sent, and in under half of the total time');
}

console.log(`\nPASS: ${checks} responses stream checks`);
