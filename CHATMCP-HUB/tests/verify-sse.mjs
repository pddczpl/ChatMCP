// lib/sse.mjs: the one Server-Sent Events reader of the Hub (Chat Completions, Messages, Gemini and Responses streams all go through it).
//   1. The format: events end at a blank line, lines end in LF, CRLF or a lone CR, `data` lines of one event are joined with a line feed, a comment line (": ping") is
//      not an event, one space after the colon is dropped, `event` names the event, an event with no data is not an event, a stream may end without its last blank line,
//      a byte order mark at the start is skipped.
//   2. Chunk boundaries do not matter: 200 generated streams, cut at random byte positions (inside a UTF-8 character, between a CR and its LF, inside a field name)
//      give the events of the whole stream read at once.
//   3. The limits: more than the byte cap is refused, an abort stops the read and cancels the stream, a stream that sends nothing for the idle time is stopped with the error
//      the caller chose, a stream that fails is not mistaken for one that ended.
//   4. The OpenAI Responses stream is read by this reader too (readResponsesStream keeps its name, its terminal rule and its error codes).
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { SSE_STOP, createSseParser, readSse as readSseUnbounded } from '../lib/sse.mjs';

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
const encoder = new TextEncoder();
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);
/** A read that never ends is a failure of the test, not a hang of the suite: every read here is over within a few seconds. */
const deadline = (promise, label, ms = 5000) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} was still waiting after ${ms} ms`)), ms).unref())]);
const readSse = (body, options) => deadline(readSseUnbounded(body, options), 'readSse');

/** A ReadableStream of the byte chunks given; `cancelled` says whether the reader cancelled it. */
function streamOf(chunks, { failAfter = null, hangAfter = null } = {}) {
  const state = { cancelled: false, reads: 0 };
  let index = 0;
  const body = new ReadableStream({
    async pull(controller) {
      state.reads += 1;
      if (hangAfter !== null && index >= hangAfter) return new Promise(() => {});
      if (failAfter !== null && index >= failAfter) { controller.error(Object.assign(new Error('connection reset'), { code: 'ECONNRESET' })); return undefined; }
      if (index >= chunks.length) { controller.close(); return undefined; }
      controller.enqueue(typeof chunks[index] === 'string' ? encoder.encode(chunks[index]) : chunks[index]);
      index += 1;
      return undefined;
    },
    cancel() { state.cancelled = true; },
  });
  return { body, state };
}
const collect = async (body, options = {}) => {
  const events = [];
  const outcome = await readSse(body, { ...options, onEvent: (event) => { events.push(event); } });
  return { events, outcome };
};
const simple = (events) => events.map((event) => [event.event, event.data]);

// ------------------------------------------------------------------ 1. the format
{
  const one = async (text) => simple((await collect(streamOf([text]).body)).events);
  assert.deepEqual(await one('data: hello\n\n'), [['message', 'hello']]);
  assert.deepEqual(await one('event: ping\ndata: {"a":1}\n\n'), [['ping', '{"a":1}']]);
  assert.deepEqual(await one('data: one\ndata: two\n\n'), [['message', 'one\ntwo']], 'data lines are joined with a line feed');
  assert.deepEqual(await one('data:no-space\n\n'), [['message', 'no-space']]);
  assert.deepEqual(await one('data:  two spaces\n\n'), [['message', ' two spaces']], 'exactly one space is dropped');
  assert.deepEqual(await one(': keep-alive\n\ndata: x\n\n'), [['message', 'x']], 'a comment is not an event');
  assert.deepEqual(await one(': a\ndata: x\n: b\n\n'), [['message', 'x']], 'and does not break an event');
  assert.deepEqual(await one('event: only-a-name\n\ndata: x\n\n'), [['message', 'x']], 'an event with no data is not an event, and does not leave its name behind');
  assert.deepEqual(await one('data: a\r\n\r\ndata: b\r\n\r\n'), [['message', 'a'], ['message', 'b']], 'CRLF');
  assert.deepEqual(await one('data: a\r\rdata: b\r\r'), [['message', 'a'], ['message', 'b']], 'a lone CR');
  assert.deepEqual(await one('data: a\n\r\ndata: b\r\n\n'), [['message', 'a'], ['message', 'b']], 'and any mix of them');
  assert.deepEqual(await one('data: last without a blank line'), [['message', 'last without a blank line']], 'the stream may end inside the last event');
  assert.deepEqual(await one(BYTE_ORDER_MARK + 'data: after a byte order mark\n\n'), [['message', 'after a byte order mark']]);
  assert.deepEqual(await one('data\n\ndata:\n\ndata: x\n\n'), [['message', ''], ['message', ''], ['message', 'x']], 'a data line with an empty value is an event with empty data');
  assert.deepEqual(await one('data: [DONE]\n\n'), [['message', '[DONE]']], 'the marker of the Chat stream is data like any other; the protocol reads it');
  assert.deepEqual(await one('id: 7\nretry: 1000\nfoo: bar\ndata: x\n\n'), [['message', 'x']], 'fields the Hub does not use are ignored');
  const withId = (await collect(streamOf(['id: 42\nevent: e\ndata: x\n\n']).body)).events[0];
  assert.deepEqual([withId.event, withId.data, withId.id], ['e', 'x', '42']);
  assert.deepEqual(await one('data: {"text":"xin chào 😀"}\n\n'), [['message', '{"text":"xin chào 😀"}']], 'text in any script');
  assert.deepEqual(await one(''), [], 'an empty stream has no event');
  assert.deepEqual(await one('\n\n\n'), []);
  ok('SSE format: LF, CRLF and CR, joined data lines, comments, names, one space, no data no event, an unfinished last event, a byte order mark');
}

// ------------------------------------------------------------------ 2. chunk boundaries do not matter
{
  let seed = 20260724;
  const random = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const pick = (list) => list[Math.floor(random() * list.length)];
  const words = ['alpha', 'beta', 'xin chào', 'thế giới', '😀', 'ü', '{"a":[1,2,3]}', 'data', 'event: x', ' lead', 'trail ', ''];
  const endings = ['\n', '\r\n', '\r'];
  const generate = () => {
    const eol = pick(endings);
    const expected = [];
    let text = random() < 0.2 ? BYTE_ORDER_MARK : '';
    const count = 1 + Math.floor(random() * 6);
    for (let i = 0; i < count; i += 1) {
      if (random() < 0.3) text += `: ${pick(words)}${eol}`;
      const name = random() < 0.5 ? pick(['ping', 'delta', 'error', 'done']) : null;
      if (name) text += `event: ${name}${eol}`;
      const values = [];
      const lines = 1 + Math.floor(random() * 3);
      for (let l = 0; l < lines; l += 1) {
        const value = pick(words);
        if (random() < 0.5) { text += `data: ${value}${eol}`; values.push(value); } else { text += `data:${value}${eol}`; values.push(value.startsWith(' ') ? value.slice(1) : value); }
      }
      expected.push([name ?? 'message', values.join('\n')]);
      text += eol;
    }
    return { text, expected };
  };
  let streams = 0;
  let chunks = 0;
  for (let n = 0; n < 200; n += 1) {
    const { text, expected } = generate();
    const bytes = encoder.encode(text);
    const whole = simple((await collect(streamOf([bytes]).body)).events);
    assert.deepEqual(whole, expected, `stream ${n}: read at once`);
    // random cut points: anywhere, so inside multi-byte characters, between CR and LF, and inside field names
    const cuts = new Set();
    const pieces = 1 + Math.floor(random() * 12);
    for (let i = 0; i < pieces; i += 1) cuts.add(Math.floor(random() * (bytes.length + 1)));
    const ordered = [0, ...[...cuts].sort((a, b) => a - b), bytes.length];
    const parts = [];
    for (let i = 1; i < ordered.length; i += 1) parts.push(bytes.slice(ordered[i - 1], ordered[i]));
    const cut = simple((await collect(streamOf(parts).body)).events);
    assert.deepEqual(cut, whole, `stream ${n}: cut into ${parts.length} chunks`);
    // one byte at a time is the worst case
    if (n % 10 === 0) assert.deepEqual(simple((await collect(streamOf(Array.from(bytes, (byte) => Uint8Array.of(byte))).body)).events), whole, `stream ${n}: byte by byte`);
    streams += 1;
    chunks += parts.length;
  }
  // a hand-made case for the two cuts that are easiest to get wrong
  const text = 'data: xin chào 😀\r\n\r\ndata: tiếp\r\n\r\n';
  const bytes = encoder.encode(text);
  for (let cut = 1; cut < bytes.length; cut += 1) {
    const got = simple((await collect(streamOf([bytes.slice(0, cut), bytes.slice(cut)]).body)).events);
    assert.deepEqual(got, [['message', 'xin chào 😀'], ['message', 'tiếp']], `a cut at byte ${cut}`);
  }
  ok(`SSE chunks: ${streams} generated streams in ${chunks} random chunks (and byte by byte), and every cut point of a hand-made one, decode like the whole stream`);
}

// ------------------------------------------------------------------ 3. the parser on its own, for a caller that already has the text
{
  const events = [];
  const parser = createSseParser((event) => events.push([event.event, event.data]));
  parser.push('data: a\r');
  assert.deepEqual(events, [], 'a CR at the end of a chunk may be the first half of a CRLF: nothing is decided yet');
  parser.push('\n\r');
  parser.push('\ndata: b\n\n');
  parser.end();
  assert.deepEqual(events, [['message', 'a'], ['message', 'b']]);
  const later = [];
  const second = createSseParser((event) => later.push(event.data));
  second.push('data: a\n\n');
  second.push(BYTE_ORDER_MARK + 'data: b\n\n');
  second.end();
  assert.deepEqual(later, ['a'], 'a byte order mark is skipped at the start of the stream only: later it is part of the line, which then names no field');
  const first = [];
  const third = createSseParser((event) => first.push(event.data));
  third.push(BYTE_ORDER_MARK + 'data: a\n\n');
  assert.deepEqual(first, ['a'], 'the parser skips a byte order mark at the start itself (the decoder of a stream does it too, but the parser is used on its own)');
  // an event is handed over at its blank line, not at the end of the stream: a live stream may never end
  const live = [];
  const fourth = createSseParser((event) => live.push(event.data));
  fourth.push('data: a\r\rdata: b\n\n');
  assert.deepEqual(live, ['a', 'b'], 'a CR that is followed by an ordinary character is not the first half of a CRLF');
  ok('SSE parser: a CR at the end of a chunk waits for the next one; a byte order mark counts at the start only');
}

// ------------------------------------------------------------------ 4. the limits
{
  // the byte cap
  const big = 'data: ' + 'x'.repeat(1000) + '\n\n';
  const capped = streamOf(Array.from({ length: 20 }, () => big));
  await assert.rejects(() => collect(capped.body, { maxBytes: 5000 }), (error) => error.code === 'sse_too_large' && /5000|4\.9|KiB|MiB/.test(error.message));
  assert.equal(capped.state.cancelled, true, 'and the stream is cancelled');
  const lowered = streamOf([big, big]);
  assert.equal((await collect(lowered.body, { maxBytes: 12 * 1024 * 1024 })).events.length, 2, 'the default cap is far above an ordinary stream');

  // an abort
  const controller = new AbortController();
  const aborted = streamOf(['data: a\n\n', 'data: b\n\n', 'data: c\n\n']);
  const seen = [];
  await assert.rejects(() => readSse(aborted.body, { signal: controller.signal, onEvent: (event) => { seen.push(event.data); if (event.data === 'a') controller.abort(new Error('stopped by the owner')); } }), /stopped by the owner/);
  assert.deepEqual(seen, ['a'], 'nothing is delivered after the abort');
  assert.equal(aborted.state.cancelled, true, 'and the stream is cancelled');
  const together = new AbortController();
  const seenTogether = [];
  await assert.rejects(() => readSse(streamOf(['data: a\n\ndata: b\n\ndata: c\n\n']).body, { signal: together.signal, onEvent: (event) => { seenTogether.push(event.data); together.abort(new Error('stopped at the first')); } }), /stopped at the first/);
  assert.deepEqual(seenTogether, ['a'], 'the events that were already read in the same chunk are not delivered either');
  // an abort that comes while the last event is delivered (it has no blank line after it, so it is made by the end of the stream)
  const lastOne = new AbortController();
  await assert.rejects(() => readSse(streamOf(['data: last, with no blank line']).body, { signal: lastOne.signal, onEvent: () => lastOne.abort(new Error('stopped at the very end')) }), /stopped at the very end/);
  const already = new AbortController(); already.abort(new Error('already'));
  await assert.rejects(() => readSse(streamOf(['data: a\n\n']).body, { signal: already.signal, onEvent() {} }), /already/);

  // the idle clock
  const stalled = streamOf(['data: a\n\n'], { hangAfter: 1 });
  const idleError = Object.assign(new Error('no data for 40 ms'), { code: 'idle_for_test' });
  const delivered = [];
  const started = Date.now();
  await assert.rejects(() => readSse(stalled.body, { idleTimeoutMs: 40, idleError: () => idleError, onEvent: (event) => { delivered.push(event.data); } }), (error) => error === idleError);
  assert.deepEqual(delivered, ['a'], 'what arrived before the silence was delivered');
  assert.ok(Date.now() - started < 2000, 'and the silence ended the read');
  assert.equal(stalled.state.cancelled, true);
  const silent = streamOf([], { hangAfter: 0 });
  await assert.rejects(() => readSse(silent.body, { idleTimeoutMs: 40, idleError: () => idleError, onEvent() {} }), (error) => error === idleError);
  assert.equal(silent.state.cancelled, true, 'a stream that never sends a byte is silent too');
  // a stream that keeps sending never trips it, even when each pause is most of the allowance
  const slow = new ReadableStream({ async start(controller) { for (let i = 0; i < 4; i += 1) { await new Promise((resolve) => setTimeout(resolve, 30)); controller.enqueue(encoder.encode(`data: ${i}\n\n`)); } controller.close(); } });
  assert.equal((await collect(slow, { idleTimeoutMs: 80, idleError: () => new Error('too slow') })).events.length, 4, 'every byte starts the clock again');

  // a stream that breaks is an error, not an end
  const broken = streamOf(['data: a\n\n', 'data: b\n\n'], { failAfter: 1 });
  await assert.rejects(() => collect(broken.body), (error) => error.code === 'ECONNRESET');
  // a body that is not a stream
  await assert.rejects(() => readSse(null, { onEvent() {} }), (error) => error.code === 'sse_no_stream');
  await assert.rejects(() => readSse({}, { onEvent() {} }), (error) => error.code === 'sse_no_stream');

  // activity is reported for every chunk, comment-only ones too
  let chunksSeen = 0;
  await readSse(streamOf([': a\n\n', ': b\n\n', 'data: x\n\n']).body, { onChunk: () => { chunksSeen += 1; }, onEvent() {} });
  assert.equal(chunksSeen, 3, 'a keep-alive comment is a sign of life');
  // an error in the handler stops the read and surfaces
  const failing = streamOf(['data: a\n\n', 'data: b\n\n']);
  await assert.rejects(() => readSse(failing.body, { onEvent() { throw Object.assign(new Error('handler said no'), { code: 'handler' }); } }), (error) => error.code === 'handler');
  assert.equal(failing.state.cancelled, true);
  // the reason of the signal, not the error that a fetch gives to the body it was aborted in the middle of
  const person = new AbortController();
  let bodyController;
  const erroring = new ReadableStream({ start(c) { bodyController = c; c.enqueue(encoder.encode('data: a\n\n')); } });
  person.signal.addEventListener('abort', () => bodyController.error(new DOMException('This operation was aborted', 'AbortError')), { once: true });
  setTimeout(() => person.abort(Object.assign(new Error('the person pressed stop'), { code: 'user_cancelled' })), 30);
  await assert.rejects(() => readSse(erroring, { signal: person.signal, onEvent() {} }), (error) => error.code === 'user_cancelled');
  // nothing is left behind by a read that finished
  const watched = new AbortController();
  await readSse(streamOf(['data: a\n\n']).body, { signal: watched.signal, onEvent() {} });
  assert.equal(getEventListeners(watched.signal, 'abort').length, 0, 'the listener on the signal is removed');
  const timers = () => process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;
  const baseline = timers();
  await readSse(streamOf(['data: a\n\n']).body, { idleTimeoutMs: 60000, idleError: () => new Error('too slow'), onEvent() {} });
  assert.equal(timers(), baseline, 'and so is the idle timer');
  ok('SSE limits: the byte cap, an abort, the idle clock (restarted by every byte), a stream that breaks, a body that is not a stream, keep-alives as life, an error in the handler');
}

// ------------------------------------------------------------------ 4b. a protocol that knows its stream is over can say so
{
  // The Chat stream ends with [DONE], the Messages stream with message_stop: after that nothing is read, whether the server closes the connection or keeps it open.
  const open = streamOf(['data: a\n\ndata: [DONE]\n\ndata: late\n\ndata: later'], { hangAfter: 1 });
  const seen = [];
  const outcome = await readSse(open.body, { onEvent: (event) => { seen.push(event.data); return event.data === '[DONE]' ? SSE_STOP : undefined; } });
  assert.deepEqual(seen, ['a', '[DONE]'], 'events after the one that ended the stream are not delivered, even when they came in the same chunk');
  assert.equal(outcome.halted, true);
  assert.equal(open.state.cancelled, true, 'and the connection is closed');
  // an event produced by the end of the stream can end it too
  const last = [];
  const ended = await readSse(streamOf(['data: a\n\ndata: b']).body, { onEvent: (event) => { last.push(event.data); return event.data === 'b' ? SSE_STOP : undefined; } });
  assert.deepEqual(last, ['a', 'b']);
  assert.equal(ended.halted, true);
  // a stream that is read to its end says it was not halted
  assert.equal((await readSse(streamOf(['data: a\n\n']).body, { onEvent() {} })).halted, false);
  // what a handler returns is otherwise not looked at
  assert.equal((await readSse(streamOf(['data: a\n\ndata: b\n\n']).body, { onEvent: () => 'stop' })).halted, false, 'only the exported marker ends a stream');
  ok('SSE: a handler ends the read with SSE_STOP (nothing after it is delivered, the connection is closed)');
}

// ------------------------------------------------------------------ 5. the Responses stream is read by the same reader, with the codes its callers know
{
  const { readResponsesStream: readResponsesUnbounded } = await import('../lib/openai-responses-api.mjs');
  const readResponsesStream = (body, options) => deadline(readResponsesUnbounded(body, options), 'readResponsesStream');
  const completed = { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }] };
  const frame = (event, eol = '\n') => `data: ${JSON.stringify(event)}${eol}${eol}`;
  const lines = (eol) => [
    frame({ type: 'response.output_text.delta', delta: 'do' }, eol),
    `: keep-alive${eol}${eol}`,
    frame({ type: 'response.output_text.delta', delta: 'ne' }, eol),
    frame({ type: 'response.completed', response: completed }, eol),
  ];
  for (const eol of ['\n', '\r\n', '\r']) {
    const tokens = [];
    const terminal = await readResponsesStream(streamOf(lines(eol)).body, { onToken: (token) => tokens.push(token) });
    assert.equal(tokens.join(''), 'done', `the text of a Responses stream whose lines end in ${JSON.stringify(eol)}`);
    assert.equal(terminal.status, 'completed');
  }
  // every cut point of one Responses stream, inside a UTF-8 character included
  const vietnamese = lines('\r\n').map((text) => text.replace('"do"', '"xin chào 😀"')).join('');
  const bytes = encoder.encode(vietnamese);
  for (let cut = 1; cut < bytes.length; cut += 1) {
    const tokens = [];
    await readResponsesStream(streamOf([bytes.slice(0, cut), bytes.slice(cut)]).body, { onToken: (token) => tokens.push(token) });
    assert.equal(tokens.join(''), 'xin chào 😀ne', `a cut at byte ${cut}`);
  }
  await assert.rejects(() => readResponsesStream(streamOf(lines('\n').slice(0, 3)).body), { code: 'responses_stream_interrupted' }, 'a stream with no terminal event is not an answer');
  await assert.rejects(() => readResponsesStream(streamOf(['data: {not json}\n\n']).body), { code: 'invalid_responses_stream' });
  for (const text of ['null', '[1]', '"text"', '3']) await assert.rejects(() => readResponsesStream(streamOf([`data: ${text}\n\n`]).body), { code: 'invalid_responses_stream' }, `an event that is JSON but not an object (${text}) is a stream that is not a Responses stream`);
  await assert.rejects(() => readResponsesStream(streamOf([frame({ type: 'response.completed', response: completed }), frame({ type: 'response.failed', response: completed })]).body), { code: 'duplicate_responses_terminal' });
  await assert.rejects(() => readResponsesStream(null), { code: 'invalid_responses_stream' });
  // the 12 MiB cap, with the code and the words the Responses callers have always had
  const filler = encoder.encode(`: ${'x'.repeat(1024 * 1024 - 3)}\n`);
  const huge = streamOf(Array.from({ length: 13 }, () => filler));
  await assert.rejects(() => readResponsesStream(huge.body), { code: 'responses_stream_too_large', message: 'Response stream exceeded 12 MiB.' });
  assert.equal(huge.state.cancelled, true, 'and the connection is closed');
  // a [DONE] marker after the terminal event (some gateways send one) is not an event
  assert.equal((await readResponsesStream(streamOf([...lines('\n'), 'data: [DONE]\n\n']).body)).status, 'completed');
  // every chunk is a sign of life for the idle clock of the caller
  let chunkCount = 0;
  await readResponsesStream(streamOf(lines('\n')).body, { onChunk: () => { chunkCount += 1; } });
  assert.equal(chunkCount, 4);
  // an async handler is waited for, and its failure is not lost
  await assert.rejects(() => readResponsesStream(streamOf(lines('\n')).body, { onToken: async () => { await Promise.resolve(); throw Object.assign(new Error('async failure'), { code: 'async_handler_failed' }); } }), { code: 'async_handler_failed' });
  // the caller's cancel stops it with the caller's own reason, and a handler that throws is not swallowed
  const stop = new AbortController();
  const waiting = streamOf([lines('\n')[0]], { hangAfter: 1 });
  const pending = readResponsesStream(waiting.body, { signal: stop.signal, onToken: () => stop.abort(Object.assign(new Error('cancelled by the person'), { code: 'user_cancelled' })) });
  await assert.rejects(() => pending, { code: 'user_cancelled' });
  assert.equal(waiting.state.cancelled, true);
  await assert.rejects(() => readResponsesStream(streamOf(lines('\n')).body, { onToken: () => { throw Object.assign(new Error('the handler failed'), { code: 'handler_failed' }); } }), { code: 'handler_failed' });
  ok('Responses stream: lone CR / CRLF / LF, every cut point, and the codes responses_stream_interrupted / invalid_responses_stream / duplicate_responses_terminal / responses_stream_too_large / the caller\'s own reason');
}

console.log(`\nPASS: ${checks} sse checks`);
