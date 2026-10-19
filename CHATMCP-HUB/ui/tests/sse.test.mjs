import test from 'node:test';
import assert from 'node:assert/strict';
import { SseParser, openEventStream } from '../src/lib/sse.ts';
import { setHubSecret } from '../src/lib/session.ts';

test('the parser returns whole events and ignores heartbeats and comments', () => {
  const parser = new SseParser();
  assert.deepEqual(parser.push(': connected\n\n'), []);
  assert.deepEqual(parser.push('data: {"a":1}\n\n: heartbeat\n\ndata: two\n'), ['{"a":1}']);
  assert.deepEqual(parser.push('\n'), ['two']);
});

test('events split across chunks, CRLF line ends and multi-line data are reassembled', () => {
  const parser = new SseParser();
  assert.deepEqual(parser.push('data: par'), []);
  assert.deepEqual(parser.push('tial\r\n\r\nda'), ['partial']);
  assert.deepEqual(parser.push('ta: one\r\ndata: two\r\n\r\n'), ['one\ntwo']);
  assert.deepEqual(parser.push('event: ping\nid: 7\n\n'), [], 'a block without data is not a message');
});

function streamOf(...chunks) {
  const encoder = new TextEncoder();
  return new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(encoder.encode(chunk)); controller.close(); } });
}

test('the stream sends the bearer and delivers events, then reports the drop and reconnects', async () => {
  const original = globalThis.fetch;
  const secret = 'q'.repeat(48);
  setHubSecret(secret);
  const requests = [];
  globalThis.fetch = async (route, init) => {
    requests.push({ route, headers: init.headers });
    return new Response(streamOf(': connected\n\n', 'data: {"type":"x"}\n\n'), { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
  };
  const seen = [];
  let opens = 0;
  let errors = 0;
  const reconnected = new Promise((resolve) => {
    const close = openEventStream('/api/tasks/events', {
      onOpen: () => { opens += 1; },
      onMessage: (data) => seen.push(data),
      onError: () => { errors += 1; if (errors === 2) { close(); resolve(); } },
    }, { retryMs: 5 });
  });
  try {
    await reconnected;
    assert.equal(requests[0].headers.Authorization, 'Bearer ' + secret);
    assert.equal(requests[0].headers.Accept, 'text/event-stream');
    assert.ok(opens >= 2 && seen.length >= 2 && seen.every((data) => data === '{"type":"x"}'));
  } finally { globalThis.fetch = original; setHubSecret(''); }
});

test('a 401 ends the stream and says the session is lost instead of retrying forever', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response('{}', { status: 401 }); };
  setHubSecret('z'.repeat(40));
  try {
    openEventStream('/api/tasks/events', { onMessage() {} }, { retryMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; setHubSecret(''); }
});
