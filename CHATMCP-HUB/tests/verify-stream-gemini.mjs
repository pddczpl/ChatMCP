// Gemini as a stream (prov-15): `models/<model>:streamGenerateContent?alt=sse` answers with server-sent events, each one a complete GenerateContentResponse that holds the next piece of the answer.
// The reader rebuilds the one response the same API gives when it does not stream, and normalizeGemini reads it as it reads the plain one, so a streamed answer and a plain one cannot differ; a
// function call is part of the answer only when a finishReason has come. Only the native dialect streams: the other three (gemini-compat.mjs) keep the plain path.
//   1. Golden streams: eleven streams (tests/fixtures/streams/gemini.json, each with the plain response of the same answer, written from one plan) give, whatever the chunk size, the plain response
//      and the same answer after normalizeGemini; the ones that the plain path refuses (MAX_TOKENS, SAFETY, a blocked prompt) are refused with the same error.
//   2. Fail closed: a stream cut at every frame boundary, and at byte positions, never gives a call before its finishReason; an error chunk, a damaged chunk, or an answer with nothing in it is no answer.
//   3. The loop of GatewayProvider.respond: the stream URL, the four dialects, a route that does not exist, a cut stream (once, without a stream), the clocks, and the thinking setting and output range that
//      are still answered while streaming; and the output cap that comes from the catalog.
//   4. The same over a real connection against the strict mock.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GatewayProvider, normalizeGemini } from '../lib/gateway-provider.mjs';
import { createGeminiStreamReader, geminiStreamEndpoint } from '../lib/gemini-stream.mjs';
import { readSse } from '../lib/sse.mjs';
import { accumulateGeminiStream, parseSse, validateGeminiStream } from './e2e/protocol-validators.mjs';
import { HISTORY, TOOLS, bodyOf, deadline, encoder, firstFrames, framesOf, jsonResponse, loadFixtures, sse } from './support/stream-harness.mjs';

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
const { fixtures, textOf, byName } = loadFixtures('gemini');
const INTERRUPTED = 'gateway_stream_interrupted';
const INVALID = 'gateway_stream_invalid';
const chunk = (parts, extra = {}) => `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts }, index: 0, ...extra }] })}\r\n\r\n`;
const finishing = (parts, reason = 'STOP') => chunk(parts, { finishReason: reason });

async function readGemini(text, { chunkBytes = 97 } = {}) {
  const tokens = [];
  const reader = createGeminiStreamReader({ onToken: (token) => { tokens.push(token); } });
  await deadline(readSse(bodyOf(text, chunkBytes), { onEvent: (event) => reader.event(event) }), 'readSse');
  return { response: reader.finish(), tokens };
}
const attempt = async (text, options) => readGemini(text, options).then((value) => ({ value }), (error) => ({ error }));
/** What normalizeGemini makes of a response, with the random ids of the calls replaced by their place: two spellings of one answer compare equal. */
function normalized(response) {
  try {
    const result = normalizeGemini(structuredClone(response));
    let n = 0;
    return JSON.parse(JSON.stringify(result, (key, value) => (key === 'call_id' ? `call-${n += 1}` : value)));
  } catch (error) {
    return { error: { code: error.code, message: error.message } };
  }
}
const visibleText = (result) => (result.output ?? []).filter((item) => item.type === 'message').flatMap((item) => item.content).map((part) => part.text).join('');
const callsOf = (result) => (result.output ?? []).filter((item) => item.type === 'function_call');

// ------------------------------------------------------------------ 1. golden streams
{
  assert.ok(fixtures.length >= 6, 'at least six recorded-shape streams');
  const sizes = [1, 7, 97, 100000];
  let reads = 0;
  for (const fixture of fixtures) {
    const text = textOf(fixture);
    for (const chunkBytes of sizes) {
      const { response, tokens } = await readGemini(text, { chunkBytes });
      assert.deepEqual(response, fixture.response, `${fixture.name} (chunks of ${chunkBytes} bytes): the merged response is the plain one`);
      assert.deepEqual(normalized(response), normalized(fixture.response), `${fixture.name}: and so is the answer`);
      assert.equal(tokens.join(''), fixture.summary.text, `${fixture.name}: the text shown while it streamed is the visible text of the answer`);
      reads += 1;
    }
    const answer = normalized(fixture.response);
    if (fixture.summary.error) assert.ok(answer.error, `${fixture.name}: the plain path refuses it, and so does the stream`);
    else {
      assert.equal(visibleText(answer), fixture.summary.text, `${fixture.name}: text`);
      assert.deepEqual(callsOf(answer).map((call) => ({ name: call.name, arguments: call.arguments })), fixture.summary.calls, `${fixture.name}: calls`);
    }
    if (fixture.strict) assert.deepEqual(validateGeminiStream(parseSse(text)).errors, [], `${fixture.name}: a well-formed Gemini stream`);
    // the reference reader of the validators (what a client that follows the documentation builds) agrees with the response
    if (fixture.strict) assert.deepEqual(accumulateGeminiStream(parseSse(text)).candidates[0].content.parts.map((part) => part.text ?? Object.keys(part)[0]).join('|'), fixture.response.candidates[0].content.parts.map((part) => part.text ?? Object.keys(part)[0]).join('|'), `${fixture.name}: same parts as the reference reader`);
  }
  // signatures stay on the part they were issued for, byte for byte, and a signature closes its part
  const signed = normalized((await readGemini(textOf(byName('signature-on-text')))).response);
  assert.deepEqual(signed.output[0].providerParts, [{ text: 'Kết quả là 42.', thoughtSignature: fixtures.find((f) => f.name === 'signature-on-text').response.candidates[0].content.parts[0].thoughtSignature }], 'text, then the signature that arrived in a chunk of its own, are one part');
  const sealed = normalized((await readGemini(textOf(byName('signed-text-then-text')))).response);
  assert.deepEqual(sealed.output[0].providerParts.map((part) => [part.text, Boolean(part.thoughtSignature)]), [['Một. ', true], ['Hai.', false]], 'text after a signed part is a part of its own');
  const called = normalized((await readGemini(textOf(byName('thought-signature-call')))).response);
  assert.equal(called.output.find((item) => item.type === 'function_call').providerPart.thoughtSignature, fixtures.find((f) => f.name === 'thought-signature-call').response.candidates[0].content.parts.at(-1).thoughtSignature, 'the signature of a call is passed back with it');
  ok(`Gemini golden streams: ${fixtures.length} streams x ${sizes.length} chunk sizes (${reads} reads) equal the plain response of the same answer, also after normalizeGemini; signatures stay where they belong`);
}

// ------------------------------------------------------------------ 2. fail closed
{
  const joinFrames = (frames) => frames.map((piece) => `${piece.replace(/\n\n$/, '')}\r\n\r\n`).join('');
  let prefixes = 0;
  let cuts = 0;
  for (const fixture of fixtures) {
    const text = textOf(fixture);
    const full = (await readGemini(text)).response;
    const frames = framesOf(text);
    const finishAt = frames.findIndex((piece) => /"finishReason":"|"blockReason":"/.test(piece));
    assert.equal(finishAt, frames.length - 1, `${fixture.name}: the finish is in the last event`);
    for (let k = 0; k < frames.length; k += 1) {
      const outcome = await attempt(joinFrames(frames.slice(0, k)));
      prefixes += 1;
      assert.equal(outcome.error?.code, INTERRUPTED, `${fixture.name}: ${k} of ${frames.length} frames is not an answer`);
    }
    assert.deepEqual((await attempt(joinFrames(frames))).value.response, full);
    const bytes = encoder.encode(text);
    for (let cut = 0; cut < bytes.length; cut += 47) {
      const outcome = await attempt(new TextDecoder().decode(bytes.slice(0, cut)));
      cuts += 1;
      if (outcome.error) assert.ok([INTERRUPTED, INVALID].includes(outcome.error.code), `${fixture.name}: a cut at byte ${cut} is ${outcome.error.code}`);
      else assert.deepEqual(outcome.value.response, full, `${fixture.name}: a cut at byte ${cut} gave an answer, and then it is the whole answer`);
    }
  }
  ok(`Gemini fail closed: ${prefixes} frame prefixes and ${cuts} byte cuts of ${fixtures.length} streams: no answer before the finishReason, and then the whole answer`);

  // an error chunk after a functionCall came, at every position
  const callFrames = framesOf(textOf(byName('text-call-text')));
  const errors = [
    [{ code: 503, message: 'The model is overloaded. Please try again later.', status: 'UNAVAILABLE' }, 503], [{ code: 429, message: 'Resource has been exhausted (e.g. check quota).', status: 'RESOURCE_EXHAUSTED' }, 429],
    [{ code: 400, message: 'Request contains an invalid argument.', status: 'INVALID_ARGUMENT' }, 400], [{ code: 500, message: 'An internal error has occurred.', status: 'INTERNAL' }, 500],
    [{ message: 'status only', status: 'UNAVAILABLE' }, 503], [{ message: 'nothing to tell it by' }, 502], [{ code: 403, message: 'API key not valid', status: 'PERMISSION_DENIED' }, 403],
  ];
  let errorCases = 0;
  for (const [error, status] of errors) {
    for (let k = 1; k <= callFrames.length - 1; k += 1) {
      const outcome = await attempt(joinFrames([...callFrames.slice(0, k), `data: ${JSON.stringify({ error })}`]));
      errorCases += 1;
      assert.equal(outcome.error?.code, 'gateway_stream_error', `${error.status ?? error.message} after ${k} frames`);
      assert.equal(outcome.error.upstreamStatus, status);
      assert.equal(outcome.value, undefined, 'no answer, so no tool');
    }
  }
  const worded = await attempt('data: {"error":"the words of the provider"}\r\n\r\n');
  assert.deepEqual([worded.error?.code, worded.error?.message, worded.error?.upstreamStatus], ['gateway_stream_error', 'the words of the provider', 502], 'an error that is only a string is the provider\'s words, with no status to tell it by');
  ok(`Gemini error chunk: ${errorCases} cases (${errors.length} errors x positions after a call came): the provider's failure with its HTTP status, never an answer`);

  // damaged, or complete with nothing
  const damaged = {
    'a chunk that is not JSON': 'data: not json\r\n\r\n',
    'a chunk that is an array': 'data: [1]\r\n\r\n',
    'parts that are not a list': 'data: {"candidates":[{"content":{"parts":"x"},"index":0}]}\r\n\r\n',
    'parts that are an object': 'data: {"candidates":[{"content":{"parts":{}},"index":0}]}\r\n\r\n',
    'parts that are an empty string': 'data: {"candidates":[{"content":{"parts":""},"index":0}]}\r\n\r\n',
    'a part that is not an object': chunk(['text']),
    'an answer with an empty text': finishing([{ text: '' }]),
    'an answer with only thoughts': finishing([{ text: 'thinking', thought: true }]),
    'an answer with no parts': 'data: {"candidates":[{"content":{"role":"model"},"finishReason":"STOP","index":0}]}\r\n\r\n',
    'an answer that is only white space': finishing([{ text: ' \n' }]),
  };
  for (const [label, text] of Object.entries(damaged)) assert.equal((await attempt(text)).error?.code, INVALID, label);
  assert.equal((await attempt(finishing([{ text: '' }], 'MAX_TOKENS'))).value.response.candidates[0].finishReason, 'MAX_TOKENS', 'an empty answer that the plain path refuses for its own reason is left to it');
  assert.equal((await attempt(finishing([{ text: '' }], 'FINISH_REASON_UNSPECIFIED'))).error?.code, INVALID, 'a finish reason that says nothing, with nothing in the answer');
  assert.equal((await attempt('data: {"promptFeedback":{"safetyRatings":[]}}\r\n\r\n' + chunk([{ text: 'abc' }]))).error?.code, INTERRUPTED, 'prompt feedback that blocks nothing is not a finish');
  assert.equal((await attempt('data: {"promptFeedback":{"blockReason":"SAFETY"},"candidates":[{"content":{"parts":[{"text":"x"}],"role":"model"},"index":0}]}\r\n\r\n')).error?.code, INTERRUPTED, 'a block reason does not finish a stream that has a candidate');
  assert.equal((await attempt('data: {"promptFeedback":{"safetyRatings":[]}}\r\n\r\n')).error?.code, INTERRUPTED, 'prompt feedback with no block reason, and no candidate, is not a finish either');
  assert.equal((await attempt('data: {"promptFeedback":{"blockReason":""}}\r\n\r\n')).error?.code, INTERRUPTED, 'an empty block reason blocks nothing');
  assert.equal((await attempt('data: {"promptFeedback":{"blockReason":"SAFETY"}}\r\n\r\n')).value.response.promptFeedback.blockReason, 'SAFETY', '(premise) a block reason, and no candidate, is a finish');
  assert.equal((await attempt('')).error?.code, INTERRUPTED, 'an empty stream');
  assert.equal((await attempt(chunk([{ text: 'abc' }]))).error?.code, INTERRUPTED, 'text with no finishReason');
  assert.equal((await attempt(chunk([{ text: 'abc' }], { finishReason: '' }))).error?.code, INTERRUPTED, 'an empty finishReason is none');
  assert.equal((await attempt(chunk([{ functionCall: { name: 'read_file', args: {} } }]))).error?.code, INTERRUPTED, 'a call with no finishReason');
  assert.equal((await attempt('data:\r\n\r\n' + finishing([{ text: 'ok' }]))).value.tokens.join(''), 'ok', 'an event with no data is nothing');
  // the shape of the merged answer
  const mixed = (await readGemini(chunk([{ text: 'a' }]) + chunk([{ text: 'b', thought: true }]) + chunk([{ inlineData: { mimeType: 'image/png', data: 'AAAA' } }]) + chunk([{ text: 'c' }]) + chunk([{ text: 'x' }], { index: 1 }) + finishing([{ text: 'd' }]))).response;
  assert.deepEqual(mixed.candidates[0].content.parts, [{ text: 'a' }, { text: 'b', thought: true }, { inlineData: { mimeType: 'image/png', data: 'AAAA' } }, { text: 'cd' }], 'text runs are merged, other parts stay as they are, only the first candidate is read');
  assert.equal(mixed.candidates[0].finishReason, 'STOP');
  // a part that holds a function call is never a run of text: what follows it is a part of its own, so the merged response is the one the server would have sent whole
  const heldCall = { name: 'read_file', args: {} };
  const odd = (await readGemini(chunk([{ text: 'a', functionCall: heldCall }]) + finishing([{ text: 'b' }]))).response;
  assert.deepEqual(odd.candidates[0].content.parts, [{ text: 'a', functionCall: heldCall }, { text: 'b' }], 'no text is merged into a part that holds a function call');
  const usage = (await readGemini(`data: ${JSON.stringify({ usageMetadata: { promptTokenCount: 5 } })}\r\n\r\n` + finishing([{ text: 'ok' }]) + `data: ${JSON.stringify({ usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 }, modelVersion: 'v9', responseId: 'rid' })}\r\n\r\n`)).response;
  assert.deepEqual([usage.usageMetadata.candidatesTokenCount, usage.modelVersion, usage.responseId], [2, 'v9', 'rid'], 'the last usage wins; the version and the id are kept');
  const blockedAfter = (await attempt('data: {"promptFeedback":{"blockReason":"SAFETY"}}\r\n\r\n')).value.response;
  assert.equal(blockedAfter.candidates, undefined, 'a blocked prompt completes the stream with no candidate');
  const direct = createGeminiStreamReader({});
  assert.equal(await direct.event({ data: finishing([{ text: 'a' }]).slice(6) }), undefined);
  const failing = createGeminiStreamReader({ onToken: async () => { throw Object.assign(new Error('the handler failed'), { code: 'handler_failed' }); } });
  await assert.rejects(() => failing.event({ data: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'a' }] }, index: 0 }] }) }), { code: 'handler_failed' });
  ok('Gemini damaged streams: not JSON, not an object, parts that are not a list, an answer that completes with nothing; text runs merge, other parts stay, only the first candidate is read, the last usage wins');
}

// ------------------------------------------------------------------ 3. the stream URL
{
  assert.equal(geminiStreamEndpoint('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent'), 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse');
  assert.equal(geminiStreamEndpoint('http://127.0.0.1:7333/v1beta/models/m:generateContent?key=abc'), 'http://127.0.0.1:7333/v1beta/models/m:streamGenerateContent?key=abc&alt=sse', 'a query the owner wrote is kept');
  assert.equal(geminiStreamEndpoint('https://gw.example/custom/route'), null, 'a route that is not a generateContent route has no twin');
  assert.equal(geminiStreamEndpoint('https://gw.example/v1beta/models/m:streamGenerateContent'), null, 'nor does a route that already streams');
  assert.equal(geminiStreamEndpoint('not a url'), null);
  ok('Gemini stream URL: :generateContent becomes :streamGenerateContent with alt=sse; any other route has none');
}

// ------------------------------------------------------------------ 4. the loop of GatewayProvider.respond
const made = [];
async function provider(script, { model = 'gemini-2.5-flash', baseUrl = 'http://127.0.0.1:7333', customPath = '', limits = undefined, preset = 'custom-gemini', apiKey = undefined, catalog = null, reasoningEffort = undefined } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chatmcp-stream-gemini-'));
  made.push(directory);
  const sent = [];
  const queue = [...script];
  const gateway = new GatewayProvider({
    directory, manager: { secrets: [] }, env: {}, platform: 'linux', sleep: async () => {}, limits, catalog,
    fetchImpl: async (url, init) => { sent.push({ url: String(url), body: JSON.parse(init.body) }); const next = queue.shift(); return typeof next === 'function' ? next(init) : next; },
  });
  await gateway.load();
  await gateway.configure({ preset, apiBaseUrl: baseUrl, protocol: 'gemini', model, customPath, ...(apiKey ? { apiKey } : {}), ...(reasoningEffort ? { reasoningEffort } : {}) });
  return { gateway, sent, queue };
}
const ask = (gateway, extra = {}) => gateway.respond({ input: HISTORY, instructions: 'Test', tools: TOOLS, maxOutputTokens: 1024, ...extra });
const numbered = (result) => { let n = 0; return JSON.parse(JSON.stringify(result, (key, value) => (key === 'call_id' ? `call-${n += 1}` : value))); };
const streamed = (entry) => entry.url.includes(':streamGenerateContent');
const error = (status, message, name) => jsonResponse(status, { error: { code: status, message, status: name } });
const listen = () => { const events = []; return { events, options: { onToken: (token) => events.push(`token:${token}`), onStreamReset: () => events.push('reset'), onStatus: async () => { events.push('status'); } } }; };
const tokensOf = (events) => events.filter((name) => name.startsWith('token:')).map((name) => name.slice(6)).join('');

try {
  const call = byName('function-call');
  const callText = textOf(call);
  const callAnswer = normalized(call.response);
  const plainText = byName('text');
  const textAnswer = normalized(plainText.response);

  // the stream URL, the body of the plain request, and what is delivered
  {
    const g = await provider([sse(callText), jsonResponse(200, call.response)]);
    const listener = listen();
    assert.deepEqual(numbered(await ask(g.gateway, listener.options)), callAnswer, 'the answer is the plain one');
    assert.equal(g.sent[0].url, 'http://127.0.0.1:7333/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse');
    assert.equal('stream' in g.sent[0].body, false, 'the request body has no stream field: the method is the stream');
    assert.equal(tokensOf(listener.events), call.summary.text);
    await ask(g.gateway);
    assert.equal(g.sent[1].url, 'http://127.0.0.1:7333/v1beta/models/gemini-2.5-flash:generateContent', 'no onToken: nobody to show the text to, so no stream');
    assert.deepEqual(g.sent[1].body, g.sent[0].body, 'and the same request body');
  }
  // a route of the owner's own that has no streaming twin
  {
    const g = await provider([jsonResponse(200, plainText.response)], { customPath: '/gw/models/{model}:predict' });
    const listener = listen();
    await ask(g.gateway, listener.options);
    assert.equal(g.sent[0].url, 'http://127.0.0.1:7333/gw/models/gemini-2.5-flash:predict');
    assert.deepEqual(listener.events, [`token:${plainText.summary.text}`], 'the text still comes, at the end');
  }
  // the four dialects: only the native one streams
  {
    const unsupported = error(400, 'Invalid JSON payload received. Unknown name "generationConfig": Cannot find field.', 'INVALID_ARGUMENT');
    const g = await provider([unsupported, jsonResponse(200, plainText.response), jsonResponse(200, plainText.response)]);
    const listener = listen();
    assert.deepEqual(numbered(await ask(g.gateway, listener.options)), textAnswer);
    assert.deepEqual(g.sent.map(streamed), [true, false], 'the stream request is refused for its fields; the dialect it steps down to does not stream');
    assert.equal('generationConfig' in g.sent[1].body, false, 'it is the dialect without generationConfig');
    assert.equal(tokensOf(listener.events), plainText.summary.text, 'the text arrives at the end');
    assert.equal(listener.events.includes('reset'), false, 'nothing was shown, so nothing is taken back');
    await ask(g.gateway, listen().options);
    assert.deepEqual(g.sent.map(streamed), [true, false, false], 'the dialect that worked is remembered, and it does not stream');
    await g.gateway.configure({ preset: 'custom-gemini', apiBaseUrl: 'http://127.0.0.1:7333', protocol: 'gemini', model: 'gemini-2.5-flash' });
    g.queue.push(sse(textOf(plainText)));
    await ask(g.gateway, listen().options);
    assert.equal(streamed(g.sent[3]), true, 'a new configuration starts from the native dialect, which streams: the dialect step down was not a refusal of the stream');
  }
  {
    const tooLarge = error(413, 'Request body exceeds gateway size limit.', 'INVALID_ARGUMENT');
    const finalJson = { candidates: [{ content: { role: 'model', parts: [{ text: '{"chatmcp_action":"final","text":"Xong."}' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, totalTokenCount: 7 } };
    const g = await provider([tooLarge, jsonResponse(200, finalJson)]);
    const listener = listen();
    const reply = await ask(g.gateway, listener.options);
    assert.deepEqual(g.sent.map(streamed), [true, false], 'HTTP 413 steps down to the text protocol, which does not stream');
    assert.equal(tokensOf(listener.events), 'Xong.');
    assert.equal(reply.status, 'completed');
  }
  // a stream route that does not exist, or a gateway that cannot stream
  for (const [label, response] of [
    ['404', error(404, 'Not Found', 'NOT_FOUND')], ['405', error(405, 'Method Not Allowed', 'UNKNOWN')], ['501', error(501, 'Not Implemented', 'UNIMPLEMENTED')],
    ['400 that says so', error(400, 'streamGenerateContent is not supported for this model.', 'INVALID_ARGUMENT')],
  ]) {
    const g = await provider([response, jsonResponse(200, plainText.response), jsonResponse(200, plainText.response), sse(textOf(plainText))]);
    const listener = listen();
    assert.deepEqual(numbered(await ask(g.gateway, listener.options)), textAnswer, label);
    assert.deepEqual(g.sent.map(streamed), [true, false], `${label}: the same request on the plain route, once`);
    assert.deepEqual(g.sent[1].body, g.sent[0].body, `${label}: the same body`);
    assert.equal(listener.events.filter((name) => name === 'status').length, 1, `${label}: the person is told once`);
    assert.equal(tokensOf(listener.events), plainText.summary.text);
    await ask(g.gateway, listen().options);
    assert.deepEqual(g.sent.map(streamed), [true, false, false], `${label}: remembered`);
    await g.gateway.configure({ preset: 'custom-gemini', apiBaseUrl: 'http://127.0.0.1:7333', protocol: 'gemini', model: 'gemini-2.5-pro' });
    await ask(g.gateway, listen().options);
    assert.equal(streamed(g.sent[3]), true, `${label}: another model asks again`);
  }
  for (const [label, response, code] of [['401', error(401, 'API key not valid', 'UNAUTHENTICATED'), 'gateway_auth'], ['403', error(403, 'Permission denied', 'PERMISSION_DENIED'), 'gateway_auth'], ['429', error(429, 'Quota', 'RESOURCE_EXHAUSTED'), 'gateway_rate_limit'], ['500', error(500, 'Internal', 'INTERNAL'), 'gateway_http_error'], ['400 about something else', error(400, 'Request contains an invalid argument.', 'INVALID_ARGUMENT'), 'gateway_http_error']]) {
    const g = await provider([response, jsonResponse(200, plainText.response)]);
    const failure = await ask(g.gateway, listen().options).then(() => null, (e) => e);
    assert.equal(failure?.code, code, label);
    assert.equal(g.sent.length, 1, `${label}: an error that is not about the stream is not asked again on the plain route`);
  }
  ok('Gemini loop: the stream URL and the plain body, a route of the owner\'s own, the four dialects (only the native one streams), a stream route that is missing (once, remembered per model), errors that are not about the stream');

  // a stream that was cut: the plain route is the answer, what was shown is taken back, and it is remembered
  {
    const g = await provider([sse(firstFrames(textOf(plainText), 2)), jsonResponse(200, plainText.response), jsonResponse(200, plainText.response)]);
    const listener = listen();
    assert.deepEqual(numbered(await ask(g.gateway, listener.options)), textAnswer);
    const order = listener.events.map((name) => (name.startsWith('token:') ? 'token' : name));
    assert.deepEqual(order.slice(order.indexOf('reset')), ['reset', 'status', 'token'], 'what was shown is taken back, the person is told, the whole text comes');
    assert.deepEqual(g.sent.map(streamed), [true, false]);
    await ask(g.gateway, listen().options);
    assert.deepEqual(g.sent.map(streamed), [true, false, false], 'a cut stream is remembered like a missing route');
    // the half call is never an answer: a stream cut after a call began, and a repeat that fails, give no tool
    const half = await provider([sse(firstFrames(callText, 1)), error(503, 'down', 'UNAVAILABLE')]);
    const outcome = await ask(half.gateway, listen().options).then((value) => ({ value }), (e) => ({ error: e }));
    assert.equal(outcome.value, undefined);
    assert.equal(outcome.error?.code, 'gateway_http_error');
    // a stream that is damaged is the same
    const damaged = await provider([sse(firstFrames(textOf(plainText), 1) + 'data: {broken\r\n\r\n'), jsonResponse(200, plainText.response)]);
    await ask(damaged.gateway, listen().options);
    assert.deepEqual(damaged.sent.map(streamed), [true, false]);
  }
  // an error inside the stream is the HTTP error it stands for, as on the plain route (the Gemini loop does not retry a 503 or a 429)
  for (const [label, body, code, status] of [
    ['503', { code: 503, message: 'The model is overloaded.', status: 'UNAVAILABLE' }, 'gateway_http_error', 503], ['429', { code: 429, message: 'Quota', status: 'RESOURCE_EXHAUSTED' }, 'gateway_rate_limit', 429],
    ['401', { code: 401, message: 'API key not valid', status: 'UNAUTHENTICATED' }, 'gateway_auth', 401],
  ]) {
    const g = await provider([sse(firstFrames(callText, 1) + `data: ${JSON.stringify({ error: body })}\r\n\r\n`), jsonResponse(200, call.response)]);
    const listener = listen();
    const failure = await ask(g.gateway, listener.options).then(() => null, (e) => e);
    assert.equal(failure?.code, code, label);
    assert.equal(failure.statusCode, status, label);
    assert.equal(g.sent.length, 1, `${label}: not repeated`);
    assert.match(failure.message, label === '503' ? /overloaded/ : label === '429' ? /Quota/ : /API key not valid/, `${label}: the words of the provider`);
  }
  {
    // a gateway that ignored alt=sse and answered with the JSON array of the chunks: not a stream this reader reads
    const chunks = framesOf(textOf(plainText)).map((piece) => JSON.parse(piece.replace(/^data: /, '').trim()));
    const g = await provider([jsonResponse(200, chunks), jsonResponse(200, plainText.response), jsonResponse(200, plainText.response)]);
    const listener = listen();
    assert.deepEqual(numbered(await ask(g.gateway, listener.options)), textAnswer);
    assert.deepEqual(g.sent.map(streamed), [true, false], 'the plain route is asked instead');
    await ask(g.gateway, listen().options);
    assert.deepEqual(g.sent.map(streamed), [true, false, false], 'and remembered');
    // a plain route that says 404 is an error, asked once (the call has no stream to give up)
    const plain = await provider([error(404, 'Not Found', 'NOT_FOUND'), jsonResponse(200, plainText.response)]);
    const failure = await ask(plain.gateway).then(() => null, (e) => e);
    assert.deepEqual([failure?.code, plain.sent.length], ['gateway_http_error', 1], 'a call that does not stream has nothing to fall back from');
    // the configuration changes while a call is in flight: what that call learns is about the model it was made for
    const flight = { gateway: null };
    const racing = await provider([(init) => { flight.gateway.model = 'gemini-2.5-pro'; return error(404, 'Not Found', 'NOT_FOUND'); }, jsonResponse(200, plainText.response), sse(textOf(plainText))]);
    flight.gateway = racing.gateway;
    await ask(racing.gateway, listen().options);
    racing.gateway.model = 'gemini-2.5-flash';
    await ask(racing.gateway, listen().options);
    assert.equal(streamed(racing.sent[2]), true, 'a refusal learned for a model that is no longer the configured one is not recorded');
  }
  // the connection drops, or goes quiet: the request is made again as a stream
  {
    const resets = (frames) => () => {
      let sent = false;
      const encoded = encoder.encode(frames);
      return { ok: true, status: 200, headers: new Headers({ 'content-type': 'text/event-stream' }), body: new ReadableStream({ pull(controller) { if (!sent) { sent = true; controller.enqueue(encoded); } else controller.error(Object.assign(new TypeError('terminated'), { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) })); } }) };
    };
    const g = await provider([resets(firstFrames(textOf(plainText), 2)), sse(textOf(plainText))]);
    const listener = listen();
    assert.deepEqual(numbered(await ask(g.gateway, listener.options)), textAnswer);
    assert.deepEqual(g.sent.map(streamed), [true, true]);
    const order = listener.events.map((name) => (name.startsWith('token:') ? 'token' : name));
    assert.deepEqual(order.slice(order.indexOf('reset'), order.indexOf('reset') + 2), ['reset', 'status']);
    const silent = (frames) => (init) => {
      let controller;
      const body = new ReadableStream({ start(c) { controller = c; c.enqueue(encoder.encode(frames)); } });
      init.signal.addEventListener('abort', () => controller.error(new DOMException('This operation was aborted', 'AbortError')), { once: true });
      return { ok: true, status: 200, headers: new Headers({ 'content-type': 'text/event-stream' }), body };
    };
    const quiet = await provider([silent(firstFrames(textOf(plainText), 2)), sse(textOf(plainText))], { limits: { requestTimeoutMs: 5000, idleTimeoutMs: 80 } });
    const started = Date.now();
    assert.deepEqual(numbered(await ask(quiet.gateway, listen().options)), textAnswer);
    assert.ok(Date.now() - started < 3000, 'the idle limit of the provider ended the wait');
    assert.deepEqual(quiet.sent.map(streamed), [true, true]);
    const noByte = (init) => {
      let controller;
      const body = new ReadableStream({ start(c) { controller = c; } });
      init.signal.addEventListener('abort', () => controller.error(new DOMException('This operation was aborted', 'AbortError')), { once: true });
      return { ok: true, status: 200, headers: new Headers({ 'content-type': 'text/event-stream' }), body };
    };
    const empty = await provider([noByte, sse(textOf(plainText))], { limits: { requestTimeoutMs: 5000, idleTimeoutMs: 80 } });
    const emptyAt = Date.now();
    await ask(empty.gateway, listen().options);
    assert.ok(Date.now() - emptyAt < 3000, 'a response that begins and sends nothing is cut by the idle limit');
    // the wait for a response to begin is the request timeout, whatever the idle limit is: a server that takes 250 ms to answer is not idle for 80 ms
    const late = (init) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(sse(textOf(plainText))), 250);
      init.signal.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal.reason); }, { once: true });
    });
    const slow = await provider([late, sse(textOf(plainText))], { limits: { requestTimeoutMs: 5000, idleTimeoutMs: 80 } });
    assert.deepEqual(numbered(await ask(slow.gateway, listen().options)), textAnswer);
    assert.equal(slow.sent.length, 1, 'a response that is slow to begin is waited for, once: the idle clock starts with the response');
    // a stream that goes on for longer than the idle limit, a byte at a time, is not idle: every byte starts the clock again, a keep-alive comment too
    const tricklePieces = [...Array(8).fill(': keep-alive\r\n\r\n'), ...framesOf(textOf(plainText)).map((piece) => piece.replace(/\n\n$/, '\r\n\r\n'))];
    const trickle = () => { const all = tricklePieces.slice(); return { ok: true, status: 200, headers: new Headers({ 'content-type': 'text/event-stream' }), body: new ReadableStream({ async pull(controller) { if (!all.length) { controller.close(); return; } await new Promise((resolve) => setTimeout(resolve, 40)); controller.enqueue(encoder.encode(all.shift())); } }) }; };
    const alive = await provider([trickle, sse(textOf(plainText))], { limits: { requestTimeoutMs: 5000, idleTimeoutMs: 200 } });
    assert.ok(tricklePieces.length * 40 > 2 * 200, '(premise) the stream lasts much longer than the idle limit');
    assert.deepEqual(numbered(await ask(alive.gateway, listen().options)), textAnswer, 'a byte every 40 ms is not idle for 200 ms');
    assert.equal(alive.sent.length, 1, 'and it is read to its end, once');
    const forever = () => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'text/event-stream' }), body: new ReadableStream({ async pull(controller) { await new Promise((resolve) => setTimeout(resolve, 40)); controller.enqueue(encoder.encode(': keep-alive\r\n\r\n')); } }) });
    const capped = await provider([forever, sse(textOf(plainText))], { limits: { requestTimeoutMs: 5000, idleTimeoutMs: 500, streamTotalMs: 150 } });
    const cappedAt = Date.now();
    assert.deepEqual(numbered(await ask(capped.gateway, listen().options)), textAnswer);
    assert.ok(Date.now() - cappedAt < 3000, 'a stream that never finishes is cut at the total cap, and the request is made again');
    // the person's stop
    const stop = new AbortController();
    setTimeout(() => stop.abort(Object.assign(new Error('cancelled by the person'), { code: 'user_cancelled' })), 40);
    const hanging = await provider([silent(firstFrames(textOf(plainText), 2))], { limits: { requestTimeoutMs: 5000, idleTimeoutMs: 5000 } });
    const cancelled = await deadline(ask(hanging.gateway, { ...listen().options, signal: stop.signal }).then(() => null, (e) => e), 'cancel');
    assert.equal(cancelled?.code, 'user_cancelled', 'the person\'s own reason is not replaced by a timeout');
  }
  // too many bytes, and no body
  {
    const g = await provider([sse(textOf(plainText))], { limits: { requestTimeoutMs: 5000, streamMaxBytes: 500 } });
    const failure = await ask(g.gateway, listen().options).then(() => null, (e) => e);
    assert.equal(failure?.code, 'gateway_too_large');
    assert.equal(g.sent.length, 1, 'and it is not repeated');
    const noBody = await provider([{ ok: true, status: 200, headers: new Headers({ 'content-type': 'text/event-stream' }), body: null }, jsonResponse(200, plainText.response)]);
    await ask(noBody.gateway, listen().options);
    assert.deepEqual(noBody.sent.map(streamed), [true, false]);
    const ignored = await provider([jsonResponse(200, plainText.response)]);
    const listener = listen();
    assert.deepEqual(numbered(await ask(ignored.gateway, listener.options)), textAnswer);
    assert.deepEqual(listener.events, [`token:${plainText.summary.text}`], 'a server that answers the stream route with JSON is read as JSON, the text at the end');
  }
  ok('Gemini loop: a cut or damaged stream is repeated once on the plain route (taken back, remembered); an error in the stream is the HTTP error it stands for; a dropped, silent or endless stream is made again as a stream; the person\'s stop; the byte cap');

  // the thinking setting and the output range are answered while the stream goes on
  {
    const refuseThinking = error(400, 'Invalid JSON payload received. Unknown name "thinkingConfig" at \'generation_config\': Cannot find field.', 'INVALID_ARGUMENT');
    const g = await provider([refuseThinking, sse(textOf(plainText))]);
    await g.gateway.configure({ preset: 'custom-gemini', apiBaseUrl: 'http://127.0.0.1:7333', protocol: 'gemini', model: 'gemini-2.5-flash', reasoningEffort: 'high' });
    assert.deepEqual(numbered(await ask(g.gateway, listen().options)), textAnswer);
    assert.equal(g.sent[0].body.generationConfig.thinkingConfig !== undefined, true, '(premise) the first request carries the thinking setting');
    assert.deepEqual(g.sent.map(streamed), [true, true], 'the refusal of the thinking setting is answered with the same request without it, still as a stream');
    assert.equal(g.sent[1].body.generationConfig.thinkingConfig, undefined);
    const range = error(400, 'Unable to submit request because it has a maxOutputTokens value of 16384 but the supported range is from 1 (inclusive) to 8193 (exclusive).', 'INVALID_ARGUMENT');
    const h = await provider([range, sse(textOf(plainText))]);
    assert.deepEqual(numbered(await ask(h.gateway, { ...listen().options, maxOutputTokens: 16384 })), textAnswer);
    assert.deepEqual(h.sent.map((entry) => [streamed(entry), entry.body.generationConfig.maxOutputTokens]), [[true, 16384], [true, 8192]], 'the output range is learned and the request goes on as a stream');
  }
  ok('Gemini loop: the refusal of the thinking setting and the output range are answered while the request keeps streaming');

  // the output cap comes from the catalog: the Hub's own for a model it is sure of, a small one of the test for a model with a small limit
  {
    const key = 'dummy-key-for-the-test-0000';
    const small = { lookup: (query) => ({ found: true, source: 'catalog@test', confidence: 'exact', provider: 'google', modelId: query.model, contextWindow: 1048576, maxInput: null, maxOutput: 8192, rates: null, tiers: [] }) };
    const big = { lookup: (query) => ({ found: true, source: 'catalog@test', confidence: 'exact', provider: 'google', modelId: query.model, contextWindow: 2097152, maxInput: null, maxOutput: 131072, rates: null, tiers: [] }) };
    const cap = async (model, extra = {}, options = {}) => {
      const g = await provider([jsonResponse(200, plainText.response)], { model, preset: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', apiKey: key, ...options });
      await ask(g.gateway, extra);
      assert.equal(new URL(g.sent[0].url).pathname.startsWith('/v1beta/models/'), true);
      return g.sent[0].body.generationConfig.maxOutputTokens;
    };
    assert.equal(await cap('gemini-2.5-flash', { maxOutputTokens: undefined }), 16384, 'no budget given: what the agent may ask of the model (the catalog says it takes 65,536)');
    assert.equal(await cap('gemini-2.5-flash', { maxOutputTokens: 4096 }), 4096, 'a budget given is kept');
    assert.equal(await cap('gemini-2.5-flash', { maxOutputTokens: 30000 }), 30000, 'also above what the agent asks, when the model takes it');
    assert.equal(await cap('gemini-2.5-flash', { maxOutputTokens: 1000000 }), 65536, 'and never above the limit of the model');
    assert.equal(await cap('gemini-small', { maxOutputTokens: 30000 }, { catalog: small }), 8192, 'a model with a smaller limit is not asked for more');
    assert.equal(await cap('gemini-small', { maxOutputTokens: undefined }, { catalog: small }), 8192);
    assert.equal(await cap('gemini-big', { maxOutputTokens: 100000 }, { catalog: big }), 65536, 'a model whose limit in the catalog is higher still gets no more than the 65,536 that Gemini takes');
    assert.equal(await cap('gemini-big', { maxOutputTokens: undefined }, { catalog: big }), 16384, 'and with no budget, what the agent may ask');
    // a thinking level leaves room for the thoughts above the budget, and that room is held to the limit of the model as well
    assert.equal(await cap('some-model-the-catalog-does-not-know', { maxOutputTokens: 1024 }, { reasoningEffort: 'high' }), 16384, '(premise) the level gives the thoughts the room of a heavy level');
    assert.equal(await cap('gemini-small', { maxOutputTokens: 1024 }, { catalog: small, reasoningEffort: 'high' }), 8192, 'but not above what the model takes');
    assert.equal(await cap('some-model-the-catalog-does-not-know', { maxOutputTokens: undefined }), 8192, 'a model the catalog does not know: the old default');
    assert.equal(await cap('some-model-the-catalog-does-not-know', { maxOutputTokens: 30000 }), 30000, 'and the budget as before');
    // a gateway of the owner's is not the maker's endpoint: the catalog is not relied on for it, whatever the model is called
    assert.equal(await cap('gemini-2.5-flash', { maxOutputTokens: undefined }, { preset: 'custom-gemini', baseUrl: 'http://127.0.0.1:7333', apiKey: undefined }), 8192, 'a local gateway: the old default');
  }
  ok('Gemini output cap: the catalog replaces the fixed 8,192 (the agent-sized cap when no budget is given, the model\'s own limit as the ceiling); a model or a gateway the catalog is not sure of keeps the old default');

  // the text arrives while the stream does
  {
    const names = ['text', 'text-call-text', 'signature-on-text', 'signed-text-then-text', 'function-call', 'max-tokens'];
    for (const name of names) {
      const fixture = byName(name);
      assert.ok(fixture.summary.text, `(premise) ${name} has text to show`);
      const frames = framesOf(textOf(fixture)).map((piece) => piece.replace(/\n\n$/, '\r\n\r\n'));
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
      const g = await provider([paced]);
      const outcome = await ask(g.gateway, { onToken: () => { if (firstAt === null) firstAt = performance.now(); if (released <= last) before += 1; } }).then((value) => ({ value }), (e) => ({ error: e }));
      const total = performance.now() - started;
      if (fixture.summary.error) assert.equal(outcome.error?.code, 'model_incomplete', `${name}: the plain path refuses it, and so does the stream`);
      else assert.equal(outcome.error, undefined, name);
      assert.ok(before > 0 && firstAt < lastReleasedAt, `${name}: onToken fired before the last chunk was sent`);
      if (frames.length >= 4) assert.ok((firstAt - started) < total * 0.5, `${name}: first token after ${Math.round(firstAt - started)} ms of ${Math.round(total)} ms`);
    }
  }
  ok('Gemini timing: for six streams the text reached the caller before the last chunk was sent, and in under half of the total time for the longer ones');

  // over a real connection: the strict mock server, with the failures a network has
  {
    const { startMockModel } = await import('./e2e/mock-model-server.mjs');
    const m = await startMockModel({ scenario: 'canned-answer', strict: true });
    const makeProvider = (limits) => new GatewayProvider({ directory: path.join(os.tmpdir(), 'chatmcp-stream-gemini-unused'), bundleRoot: os.tmpdir(), manager: { secrets: [] }, env: {}, sleep: async () => {}, limits })
      .forkForTask({ protocol: 'gemini', apiBaseUrl: m.origin, model: 'mock-gemini' });
    const askMock = (gateway, extra = {}) => gateway.respond({ input: HISTORY, instructions: 'system', tools: TOOLS, maxOutputTokens: 1024, signal: AbortSignal.timeout(8000), ...extra });
    const streams = () => m.state.requests.map((request) => request.stream);
    try {
      m.setScenario('canned-answer');
      const normal = listen();
      const answered = await askMock(makeProvider({ requestTimeoutMs: 5000 }), normal.options);
      assert.equal(answered.status, 'completed');
      assert.equal(tokensOf(normal.events), 'Hello from the mock.');
      assert.deepEqual(streams(), [true]);
      assert.deepEqual([answered.usage.input_tokens, answered.usage.output_tokens], [120, 24], 'the usage of the last event');
      assert.equal(m.state.requests[0].rejected, null, 'the strict server accepted what the Hub sent');

      // the stream is cut after some pieces
      m.setScenario('canned-answer');
      const cut = m.inject({ kind: 'cut', on: 'gemini', stream: true, afterEvents: 2 });
      const cutting = listen();
      const gateway = makeProvider({ requestTimeoutMs: 5000 });
      assert.equal((await askMock(gateway, cutting.options)).status, 'completed');
      assert.deepEqual(streams(), [true, false], 'the same request on the plain route');
      assert.equal(cut.used, 1);
      assert.equal(cutting.events.includes('reset'), true);
      assert.equal(cutting.events.at(-1), 'token:Hello from the mock.');
      m.setScenario('canned-answer');
      await askMock(gateway, listen().options);
      assert.deepEqual(streams(), [false], 'remembered');
      m.clearFaults();

      // the cut that takes the last event only (the one with the finishReason)
      m.setScenario('canned-answer');
      m.inject({ kind: 'cut', on: 'gemini', stream: true });
      const lastCut = listen();
      assert.equal((await askMock(makeProvider({ requestTimeoutMs: 5000 }), lastCut.options)).status, 'completed');
      assert.deepEqual(streams(), [true, false], 'a stream with everything but its last event is not an answer');
      m.clearFaults();

      // the connection torn down
      m.setScenario('canned-answer');
      m.inject({ kind: 'cut', on: 'gemini', stream: true, afterEvents: 2, reset: true });
      assert.equal((await askMock(makeProvider({ requestTimeoutMs: 5000 }), listen().options)).status, 'completed');
      assert.deepEqual(streams(), [true, true], 'retried as a stream');
      m.clearFaults();

      // the server goes quiet
      m.setScenario('canned-answer');
      m.inject({ kind: 'stall', on: 'gemini', stream: true, afterEvents: 2 });
      const started = Date.now();
      assert.equal((await askMock(makeProvider({ requestTimeoutMs: 5000, idleTimeoutMs: 300 }), listen().options)).status, 'completed');
      assert.ok(Date.now() - started < 4000, 'the idle clock ended the wait, not the request timeout');
      assert.deepEqual(streams(), [true, true]);
      m.clearFaults();

      // a server that answers 400 to the stream
      m.setScenario('canned-answer');
      const refusal = m.inject({ kind: 'stream-unsupported', on: 'gemini', times: 5 });
      const refusing = makeProvider({ requestTimeoutMs: 5000 });
      const refused = listen();
      await askMock(refusing, refused.options);
      await askMock(refusing, refused.options);
      assert.deepEqual(streams(), [true, false, false]);
      assert.equal(refusal.used, 1, 'the server refused once');
      assert.equal(tokensOf(refused.events), 'Hello from the mock.Hello from the mock.');
      m.clearFaults();

      // a tool call over the wire: the signed call comes back in the next request, byte for byte (the strict server verifies the signature)
      m.setScenario('canned-thinking');
      const ledger = [{ role: 'user', content: [{ type: 'input_text', text: 'Do it.' }] }];
      const first = await askMock(makeProvider({ requestTimeoutMs: 5000 }), { ...listen().options, input: ledger });
      const call = first.output.find((item) => item.type === 'function_call');
      assert.ok(call?.providerPart?.thoughtSignature, 'the call came with its signature');
      const second = await askMock(makeProvider({ requestTimeoutMs: 5000 }), { ...listen().options, input: [...ledger, ...first.output, { type: 'function_call_output', call_id: call.call_id, output: 'content of c.txt' }] });
      assert.equal(second.status, 'completed');
      assert.equal(m.state.rejections.length, 0, 'the strict server refused nothing: the signature went back unmodified');
      assert.equal(m.state.requests.every((request) => request.rejected === null), true);
    } finally {
      await m.close();
    }
    ok('Gemini over HTTP against the strict mock: a stream, a stream cut (repeat on the plain route, remembered), a cut that takes only the last event, a connection torn down, a server gone quiet, a refused stream (once), a signed call that goes back unmodified');
  }
} finally {
  for (const directory of made) fs.rmSync(directory, { recursive: true, force: true });
}

console.log(`\nPASS: ${checks} gemini stream checks`);
