// The wire of the ACP agent (lib/acp/rpc.mjs): newline-delimited JSON-RPC 2.0 over a byte stream, on in-memory streams.
//
// What an editor can send is not always a well-formed message, and what the agent writes on stdout is the protocol and nothing else, so every defined answer is pinned here
// in both directions: the input that must be taken (a message split in the middle of a character, CRLF, a byte order mark, a last line with no line end, an id used again after
// its answer) and the input that must be refused (garbage, a batch, a wrong envelope, an id in flight twice, a line over the limit, an invalid character).
//
//   A. Framing on bytes: lines, split characters, CRLF, BOM, blank lines, the last line, the limit (the excess is dropped, never buffered), invalid UTF-8.
//   B. What the agent writes: one line per message, escaped, in order, under back-pressure, flushed at the end, nothing on a closed or broken output.
//   C. Requests and notifications: the envelope, ids, an unknown method, a duplicate id, handler errors, a handler that returns nothing.
//   D. Requests of our own (the agent asks the client): matched by id, errors, timeout, abort, close.
//   E. The end of the input.
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { ERROR_CODES, RpcError, createRpcPeer } from '../lib/acp/rpc.mjs';

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = async () => { for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

/** A peer on memory streams. `lines()` are the parsed lines written so far, `raw()` the text; `feed()` writes bytes to the input. */
function rig(options = {}) {
  const input = new PassThrough();
  const written = [];
  const output = options.output ?? new Writable({ write(chunk, _encoding, callback) { written.push(chunk.toString('utf8')); callback(); } });
  const logs = [];
  const peer = createRpcPeer({ input, output, log: (line) => logs.push(line), ...options.peer });
  return {
    peer, input, output, logs, written,
    raw: () => written.join(''),
    lines: () => written.join('').split('\n').filter(Boolean).map((line) => JSON.parse(line)),
    feed: (data) => input.write(Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8')),
    end: () => input.end(),
  };
}
const line = (message) => `${JSON.stringify(message)}\n`;

// ---- A. framing on bytes --------------------------------------------------------------------------------------------------------------------------------------
{
  const r = rig();
  const seen = [];
  r.peer.handle('echo', async (params) => { seen.push(params); return { echoed: params }; });
  r.peer.start();
  r.feed(line({ jsonrpc: '2.0', id: 1, method: 'echo', params: { n: 1 } }) + line({ jsonrpc: '2.0', id: 2, method: 'echo', params: { n: 2 } }));
  await settle();
  assert.deepEqual(seen, [{ n: 1 }, { n: 2 }]);
  assert.deepEqual(r.lines().map((m) => m.id), [1, 2]);
  ok('two messages in one chunk are handled, in order');

  // The message is split in three pieces, and the split falls inside a two-byte and a four-byte character.
  const text = JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'echo', params: { s: 'caf\u00e9 \u{1F600} end' } }) + '\n';
  const bytes = Buffer.from(text, 'utf8');
  const e = bytes.indexOf(Buffer.from('\u00e9', 'utf8'));
  const smile = bytes.indexOf(Buffer.from('\u{1F600}', 'utf8'));
  r.feed(bytes.subarray(0, e + 1)); // half of the é
  await settle();
  r.feed(bytes.subarray(e + 1, smile + 2)); // the rest of the é and half of the emoji
  await settle();
  assert.equal(r.lines().length, 2, 'nothing is handled before the line is complete');
  r.feed(bytes.subarray(smile + 2));
  await settle();
  assert.deepEqual(seen.at(-1), { s: 'caf\u00e9 \u{1F600} end' });
  ok('a message cut in the middle of a character (2 and 4 bytes) is decoded whole, because lines are cut on bytes');

  r.feed('{"jsonrpc":"2.0","id":4,"method":"echo","params":{"crlf":true}}\r\n');
  await settle();
  assert.deepEqual(seen.at(-1), { crlf: true });
  ok('a line that ends in CRLF is read like one that ends in LF');

  const before = r.lines().length;
  r.feed('\n\r\n   \n');
  await settle();
  assert.equal(r.lines().length, before);
  assert.equal(r.logs.length, 0);
  ok('blank lines are ignored in silence: no answer, no log');

  r.feed('{"jsonrpc":"2.0","id":5,"method":"echo","params":{"last":true}}'); // no line end
  await settle();
  assert.equal(seen.at(-1).last, undefined, 'a line is not complete before its line end');
  r.end();
  await r.peer.closed;
  assert.deepEqual(seen.at(-1), { last: true });
  assert.equal(r.lines().at(-1).id, 5);
  ok('the last line of the input counts even without a line end, and its answer is written before the peer is closed');
}

{
  const r = rig();
  const seen = [];
  r.peer.handle('echo', async (params) => { seen.push(params); return {}; });
  r.peer.start();
  r.feed(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(line({ jsonrpc: '2.0', id: 1, method: 'echo', params: { bom: true } }))]));
  await settle();
  assert.deepEqual(seen, [{ bom: true }]);
  ok('a byte order mark at the very start of the stream is skipped (a PowerShell pipe writes one)');
  r.feed(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(line({ jsonrpc: '2.0', id: 2, method: 'echo', params: {} }))]));
  await settle();
  assert.equal(r.lines().at(-1).error?.code, ERROR_CODES.PARSE);
  ok('but not in the middle: a second byte order mark makes that line a parse error');
}

{
  const r = rig();
  r.peer.handle('echo', async () => ({ fine: true }));
  r.peer.start();
  r.feed(Buffer.concat([Buffer.from('{"jsonrpc":"2.0","id":1,"method":"echo","params":{"s":"'), Buffer.from([0xff, 0xfe, 0xc3, 0x28]), Buffer.from('"}}\n')]));
  r.feed(line({ jsonrpc: '2.0', id: 2, method: 'echo', params: {} }));
  await settle();
  const [first, second] = r.lines();
  assert.deepEqual(first, { jsonrpc: '2.0', id: null, error: { code: ERROR_CODES.PARSE, message: 'Parse error', data: { reason: 'invalid_utf8' } } });
  assert.deepEqual(second, { jsonrpc: '2.0', id: 2, result: { fine: true } });
  ok('invalid UTF-8 is a parse error (-32700, id null), not a message with replacement characters, and the next line is read normally');
}

{
  const limit = 200;
  const r = rig({ peer: { maxLineBytes: limit } });
  const seen = [];
  r.peer.handle('echo', async (params) => { seen.push(params); return {}; });
  r.peer.start();
  const padded = (size) => { // a request whose line is exactly `size` bytes without its line end
    const base = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'echo', params: { pad: '' } });
    return JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'echo', params: { pad: 'x'.repeat(size - Buffer.byteLength(base)) } });
  };
  assert.equal(Buffer.byteLength(padded(limit)), limit);
  r.feed(`${padded(limit)}\n`);
  await settle();
  assert.equal(seen.length, 1);
  ok(`a line of exactly the limit (${limit} bytes) is taken`);
  r.feed(`${padded(limit + 1).replace('"id":1', '"id":2')}\n`);
  await settle();
  assert.equal(seen.length, 1);
  const refusal = r.lines().at(-1);
  assert.deepEqual(refusal, { jsonrpc: '2.0', id: null, error: { code: ERROR_CODES.INVALID_REQUEST, message: 'Message too large', data: { limitBytes: limit } } });
  ok('a line of one byte more is refused: Invalid Request, id null, with the limit in data');

  // A long line in many pieces: the answer comes when the limit is passed (the client need not finish sending), the rest is dropped, and the buffer never grows past the limit plus one piece.
  const before = r.lines().length;
  for (let i = 0; i < 50; i += 1) r.feed('y'.repeat(100));
  await settle();
  assert.equal(r.lines().length, before + 1, 'one answer for the whole long line');
  assert.ok(r.peer.stats.maxBufferedBytes <= limit + 100, `buffered at most the limit and one piece, saw ${r.peer.stats.maxBufferedBytes}`);
  assert.ok(r.peer.stats.discardedBytes >= 4900, `the rest was counted as dropped, saw ${r.peer.stats.discardedBytes}`);
  r.feed(`\n${line({ jsonrpc: '2.0', id: 9, method: 'echo', params: { after: true } })}`);
  await settle();
  assert.deepEqual(seen.at(-1), { after: true });
  ok('a line of 5 000 bytes in 50 pieces: one refusal, the excess is dropped without being kept, and the line after it is read normally');
}

// ---- B. what the agent writes -------------------------------------------------------------------------------------------------------------------------------
{
  const r = rig();
  r.peer.handle('echo', async (params) => params);
  r.peer.start();
  const tricky = { text: 'line one\nline two\r\nU+2028:\u2028 U+2029:\u2029 tab\t quote" backslash\\ lone \ud800 surrogate', nested: { deep: [1, 2, { x: 'y' }] } };
  r.feed(line({ jsonrpc: '2.0', id: 'a', method: 'echo', params: tricky }));
  await settle();
  const raw = r.raw();
  assert.equal(raw.split('\n').length, 2, 'one line and the empty piece after its line end');
  assert.ok(raw.endsWith('\n') && !raw.includes('\r'));
  const separators = [0x2028, 0x2029, 0x0085].map((code) => String.fromCharCode(code)); // built, not written: they are line ends to some readers and to some editors of source
  assert.ok(separators.every((character) => tricky.text.includes(character) || character === separators[2]), 'the test text holds the two separators');
  assert.ok(separators.every((character) => !raw.includes(character)), 'none of the three characters that some readers take for a line end is on the wire as itself');
  const answer = JSON.parse(raw);
  assert.equal(answer.result.text, tricky.text, 'the client reads back exactly what the handler returned');
  assert.equal(answer.id, 'a');
  ok('a message is ONE line that ends in LF: line breaks, U+2028 and U+2029 inside strings are escaped, and no CR is written');
  assert.ok(raw.includes('\\ud800'), 'a lone surrogate is written as a JSON escape');
  assert.ok(!raw.includes('�'), 'and never as the replacement character that UTF-8 would make of it');
  ok('a lone surrogate leaves as a JSON escape and not as a broken character');
}

{
  const chunks = [];
  let pending = null;
  const slow = new Writable({
    highWaterMark: 8,
    write(chunk, _encoding, callback) { chunks.push(chunk.toString('utf8')); pending = callback; setTimeout(() => { const done = pending; pending = null; done(); }, 3); },
  });
  const r = rig({ output: slow });
  r.peer.handle('echo', async (params) => ({ big: 'z'.repeat(2000), ...params }));
  r.peer.start();
  for (let i = 0; i < 20; i += 1) r.feed(line({ jsonrpc: '2.0', id: i, method: 'echo', params: { i } }));
  r.end();
  await r.peer.closed;
  const joined = chunks.join('');
  const messages = joined.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(messages.map((m) => m.id), Array.from({ length: 20 }, (_, i) => i));
  assert.ok(joined.length > 40000);
  ok('20 answers of 2 000 bytes to an output that takes 8 bytes at a time: all arrive, whole, in order (back-pressure is waited for, nothing is interleaved)');
}

{
  const r = rig();
  r.peer.start();
  r.output.destroy(new Error('EPIPE'));
  await settle();
  assert.doesNotThrow(() => r.peer.notify('x', { a: 1 }));
  await r.peer.flush();
  ok('a write to an output that is broken (the editor closed its end) is dropped: no throw, no unhandled error');
  assert.ok(r.logs.some((l) => /output/i.test(l)), 'and it is logged once');
}

// ---- C. requests and notifications ---------------------------------------------------------------------------------------------------------------------------
{
  const r = rig();
  let ran = 0;
  r.peer.handle('ping', async (params, context) => { ran += 1; return { pong: params?.n ?? null, id: context.id }; });
  r.peer.handle('boom', async () => { throw new Error('secret path C:\\Users\\x\\.env was unreadable'); });
  r.peer.handle('refuse', async () => { throw new RpcError(ERROR_CODES.INVALID_PARAMS, 'cwd must be absolute', { field: 'cwd' }); });
  r.peer.handle('nothing', async () => undefined);
  r.peer.handle('slow', async () => { await sleep(60); return { slow: true }; });
  r.peer.handle('fast', async () => ({ fast: true }));
  const notifications = [];
  r.peer.onNotification('seen', (params) => { notifications.push(params); });
  r.peer.onNotification('thrower', () => { throw new Error('a notification handler failed'); });
  r.peer.start();

  for (const id of ['abc', 0, 7, -3, 9007199254740991]) r.feed(line({ jsonrpc: '2.0', id, method: 'ping', params: { n: 1 } }));
  await settle();
  assert.deepEqual(r.lines().map((m) => m.id), ['abc', 0, 7, -3, 9007199254740991]);
  assert.ok(r.lines().every((m) => m.jsonrpc === '2.0' && m.result.pong === 1 && m.result.id === m.id && !('error' in m)));
  ok('a request is answered with its own id, whether the id is a string, 0, negative or the largest safe integer');

  r.feed(line({ jsonrpc: '2.0', id: 20, method: 'no.such.method', params: {} }));
  await settle();
  assert.deepEqual(r.lines().at(-1), { jsonrpc: '2.0', id: 20, error: { code: ERROR_CODES.METHOD_NOT_FOUND, message: 'Method not found: no.such.method' } });
  ok('an unknown method gets Method not found (-32601) with its id');

  const countBefore = r.lines().length;
  r.feed(line({ jsonrpc: '2.0', method: 'no.such.notification', params: {} }) + line({ jsonrpc: '2.0', method: '$/cancel_request', params: { requestId: 1 } }));
  await settle();
  assert.equal(r.lines().length, countBefore, 'a notification gets no answer, known or not');
  assert.ok(r.logs.some((l) => l.includes('no.such.notification')), 'an unknown notification is logged on the log, which is stderr');
  ok('an unknown notification (and a $/ one) is ignored in silence on stdout, and the first is logged');

  r.feed(line({ jsonrpc: '2.0', method: 'seen', params: { k: 1 } }) + line({ jsonrpc: '2.0', method: 'thrower', params: {} }) + line({ jsonrpc: '2.0', method: 'seen', params: { k: 2 } }));
  await settle();
  assert.deepEqual(notifications, [{ k: 1 }, { k: 2 }]);
  assert.equal(r.lines().length, countBefore, 'a notification handler that throws is logged and answers nothing');
  assert.ok(r.logs.some((l) => l.includes('a notification handler failed')));
  ok('notifications reach their handlers in order; one that throws neither answers nor stops the next');

  r.feed(line({ jsonrpc: '2.0', id: 30, method: 'boom', params: {} }));
  await settle();
  assert.deepEqual(r.lines().at(-1), { jsonrpc: '2.0', id: 30, error: { code: ERROR_CODES.INTERNAL, message: 'Internal error' } });
  assert.ok(r.logs.some((l) => l.includes('was unreadable')), 'the real reason is on the log');
  assert.ok(!r.raw().includes('was unreadable'), 'and not in the answer');
  ok('a handler that throws an ordinary error answers Internal error (-32603) without its words: what went wrong stays on stderr');

  r.feed(line({ jsonrpc: '2.0', id: 31, method: 'refuse', params: {} }));
  await settle();
  assert.deepEqual(r.lines().at(-1), { jsonrpc: '2.0', id: 31, error: { code: -32602, message: 'cwd must be absolute', data: { field: 'cwd' } } });
  ok('an RpcError carries its code, its message and its data to the client');

  r.feed(line({ jsonrpc: '2.0', id: 32, method: 'nothing', params: {} }));
  await settle();
  assert.equal(r.lines().at(-1).error?.code, ERROR_CODES.INTERNAL);
  ok('a handler that returns nothing is a defect and answers Internal error: an empty result is never invented');

  r.feed(line({ jsonrpc: '2.0', id: 40, method: 'slow', params: {} }) + line({ jsonrpc: '2.0', id: 41, method: 'fast', params: {} }));
  await sleep(120);
  assert.deepEqual(r.lines().slice(-2).map((m) => m.id), [41, 40]);
  ok('requests run at the same time: a slow one does not hold up a fast one, and the answers are written as they finish');

  // The same id twice while the first is in flight.
  r.feed(line({ jsonrpc: '2.0', id: 50, method: 'slow', params: {} }) + line({ jsonrpc: '2.0', id: 50, method: 'fast', params: {} }));
  await sleep(120);
  const duplicates = r.lines().filter((m) => m.id === 50 || (m.id === null && /duplicate/i.test(m.error?.message ?? '')));
  assert.equal(duplicates.length, 2);
  const refusalOfDuplicate = duplicates.find((m) => m.error);
  assert.deepEqual(refusalOfDuplicate, { jsonrpc: '2.0', id: null, error: { code: ERROR_CODES.INVALID_REQUEST, message: 'Duplicate request id', data: { id: 50 } } });
  assert.deepEqual(duplicates.find((m) => m.result), { jsonrpc: '2.0', id: 50, result: { slow: true } });
  ok('an id that is already in flight is refused (Invalid Request, id null, so that it cannot be taken for the answer of the first), and the first request is still answered');
  r.feed(line({ jsonrpc: '2.0', id: 50, method: 'fast', params: {} }));
  await settle();
  assert.deepEqual(r.lines().at(-1), { jsonrpc: '2.0', id: 50, result: { fast: true } });
  ok('once answered, the same id may be used again');
}

{
  const r = rig();
  r.peer.handle('ping', async () => ({ pong: true }));
  r.peer.start();
  const cases = [
    ['not json', 'this is not json\n', { id: null, code: ERROR_CODES.PARSE }],
    ['a truncated object', '{"jsonrpc":"2.0","id":1,"method":"ping"\n', { id: null, code: ERROR_CODES.PARSE }],
    ['a number', '42\n', { id: null, code: ERROR_CODES.INVALID_REQUEST }],
    ['a string', '"hello"\n', { id: null, code: ERROR_CODES.INVALID_REQUEST }],
    ['null', 'null\n', { id: null, code: ERROR_CODES.INVALID_REQUEST }],
    ['a batch', `[${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}]\n`, { id: null, code: ERROR_CODES.INVALID_REQUEST, message: 'Batch requests are not supported' }],
    ['an empty batch', '[]\n', { id: null, code: ERROR_CODES.INVALID_REQUEST }],
    ['no jsonrpc member', '{"id":1,"method":"ping"}\n', { id: 1, code: ERROR_CODES.INVALID_REQUEST }],
    ['jsonrpc 1.0', '{"jsonrpc":"1.0","id":2,"method":"ping"}\n', { id: 2, code: ERROR_CODES.INVALID_REQUEST }],
    ['a method that is not a string', '{"jsonrpc":"2.0","id":3,"method":5}\n', { id: 3, code: ERROR_CODES.INVALID_REQUEST }],
    ['an empty method', '{"jsonrpc":"2.0","id":4,"method":""}\n', { id: 4, code: ERROR_CODES.INVALID_REQUEST }],
    ['a fractional id', '{"jsonrpc":"2.0","id":1.5,"method":"ping"}\n', { id: null, code: ERROR_CODES.INVALID_REQUEST }],
    ['an object id', '{"jsonrpc":"2.0","id":{"a":1},"method":"ping"}\n', { id: null, code: ERROR_CODES.INVALID_REQUEST }],
    ['a boolean id', '{"jsonrpc":"2.0","id":true,"method":"ping"}\n', { id: null, code: ERROR_CODES.INVALID_REQUEST }],
    ['a null id on a request', '{"jsonrpc":"2.0","id":null,"method":"ping"}\n', { id: null, code: ERROR_CODES.INVALID_REQUEST }],
    ['an id beyond the safe integers', '{"jsonrpc":"2.0","id":9007199254740993,"method":"ping"}\n', { id: null, code: ERROR_CODES.INVALID_REQUEST }],
    ['params that are a number', '{"jsonrpc":"2.0","id":5,"method":"ping","params":7}\n', { id: 5, code: ERROR_CODES.INVALID_PARAMS }],
    ['params that are a string', '{"jsonrpc":"2.0","id":6,"method":"ping","params":"x"}\n', { id: 6, code: ERROR_CODES.INVALID_PARAMS }],
    ['both a method and a result', '{"jsonrpc":"2.0","id":8,"method":"ping","result":{}}\n', { id: 8, code: ERROR_CODES.INVALID_REQUEST }],
  ];
  for (const [label, text, expected] of cases) {
    const before = r.lines().length;
    r.feed(text);
    r.feed(line({ jsonrpc: '2.0', id: 'next', method: 'ping', params: {} }));
    await settle();
    const added = r.lines().slice(before);
    assert.equal(added.length, 2, `${label}: one refusal and one answer for the next line, saw ${JSON.stringify(added)}`);
    const [refusal, next] = added;
    assert.equal(refusal.jsonrpc, '2.0', label);
    assert.equal(refusal.id, expected.id, `${label}: id`);
    assert.equal(refusal.error?.code, expected.code, `${label}: code, saw ${JSON.stringify(refusal)}`);
    if (expected.message) assert.equal(refusal.error.message, expected.message, label);
    assert.deepEqual(next, { jsonrpc: '2.0', id: 'next', result: { pong: true } }, `${label}: the line after it is read normally`);
  }
  ok(`${cases.length} kinds of broken input (not JSON, truncated, scalars, a batch, a wrong envelope, bad ids, bad params) each get one defined error, and the next line is still read`);

  const before = r.lines().length;
  r.feed(line({ jsonrpc: '2.0', method: 'ping', params: 7 }) + line({ jsonrpc: '2.0', method: 5 }) + line({ jsonrpc: '2.0', method: 'ping', id: undefined }));
  await settle();
  assert.equal(r.lines().length, before + 0, 'broken notifications get no answer on stdout (there is nobody to answer)');
  ok('a notification with a broken envelope or broken params is dropped in silence on stdout and logged');
}

// ---- D. requests of our own -------------------------------------------------------------------------------------------------------------------------------
{
  const r = rig();
  r.peer.start();
  const asked = r.peer.request('session/request_permission', { sessionId: 's' });
  await settle();
  const [request] = r.lines();
  assert.equal(request.method, 'session/request_permission');
  assert.equal(request.jsonrpc, '2.0');
  assert.ok(Number.isSafeInteger(request.id));
  r.feed(line({ jsonrpc: '2.0', id: request.id, result: { outcome: { outcome: 'cancelled' } } }));
  assert.deepEqual(await asked, { outcome: { outcome: 'cancelled' } });
  ok('a request of our own is sent with an id of its own and resolves with the result of the response that has that id');

  const failing = r.peer.request('fs/read_text_file', { path: 'x' });
  await settle();
  const failingId = r.lines().at(-1).id;
  r.feed(line({ jsonrpc: '2.0', id: failingId, error: { code: -32002, message: 'not found', data: { path: 'x' } } }));
  await assert.rejects(failing, (error) => error instanceof RpcError && error.code === -32002 && error.message === 'not found' && error.data?.path === 'x');
  ok('an error response rejects it with an RpcError that has the code, the message and the data');

  const lines = r.logs.length;
  r.feed(line({ jsonrpc: '2.0', id: 99999, result: {} }) + line({ jsonrpc: '2.0', id: failingId, result: {} }) + line({ jsonrpc: '2.0', id: 'x', result: {}, error: { code: 1, message: 'm' } }));
  await settle();
  assert.ok(r.logs.length >= lines + 3, 'each response nobody asked for is logged');
  ok('a response that matches no request (unknown id, answered twice, a result with an error) is logged and ignored');

  const ids = new Set();
  for (let i = 0; i < 5; i += 1) { r.peer.request('m', {}).catch(() => {}); }
  await settle();
  for (const message of r.lines().filter((m) => m.method === 'm')) ids.add(message.id);
  assert.equal(ids.size, 5);
  ok('the ids of requests of our own never repeat');

  const timed = r.peer.request('slow', {}, { timeoutMs: 30 });
  await assert.rejects(timed, (error) => error instanceof RpcError && /timed out/i.test(error.message));
  ok('a request of our own that is not answered in time rejects (the client can be gone without closing its end)');

  const controller = new AbortController();
  const aborted = r.peer.request('slow2', {}, { signal: controller.signal });
  controller.abort(new Error('cancelled by the turn'));
  await assert.rejects(aborted, /cancelled by the turn/);
  const lateId = r.lines().filter((m) => m.method === 'slow2').at(-1).id;
  const logsBefore = r.logs.length;
  r.feed(line({ jsonrpc: '2.0', id: lateId, result: {} }));
  await settle();
  assert.ok(r.logs.length > logsBefore, 'the answer that comes after an abort is logged and ignored');
  ok('an abort rejects the request at once, and its late answer is ignored');

  const pending = r.peer.request('never', {});
  const handled = assert.rejects(pending, (error) => error instanceof RpcError && /closed/i.test(error.message));
  r.end();
  await r.peer.closed;
  await handled;
  ok('closing the input rejects every request of our own that is still waiting');
}

// ---- E. the end of the input ------------------------------------------------------------------------------------------------------------------------------
{
  const r = rig();
  let aborted = false;
  r.peer.handle('long', async (_params, context) => { await new Promise((resolve) => context.signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true })); return { late: true }; });
  r.peer.start();
  r.feed(line({ jsonrpc: '2.0', id: 1, method: 'long', params: {} }));
  await settle();
  let closedCalls = 0;
  r.peer.onClose(() => { closedCalls += 1; });
  r.end();
  await r.peer.closed;
  await settle();
  assert.equal(aborted, true);
  assert.equal(closedCalls, 1);
  assert.equal(r.peer.isClosed, true);
  ok('when the input ends, the signal of every request in flight is aborted and the close callbacks run once');
  assert.deepEqual(r.lines(), [{ jsonrpc: '2.0', id: 1, result: { late: true } }]);
  ok('a request that finishes within the grace period after the end of the input is still answered (the output may be open), before the peer is closed');

  // A handler that never finishes does not hold the peer: it is closed when the grace period is over, and nothing is written for that request.
  const stuck = rig({ peer: { graceMs: 60 } });
  stuck.peer.handle('stuck', () => new Promise(() => {}));
  stuck.peer.start();
  stuck.feed(line({ jsonrpc: '2.0', id: 1, method: 'stuck', params: {} }));
  await settle();
  const began = Date.now();
  stuck.end();
  await stuck.peer.closed;
  assert.ok(Date.now() - began >= 50 && Date.now() - began < 1500, `closed after the grace period, saw ${Date.now() - began} ms`);
  assert.equal(stuck.lines().length, 0);
  ok('a handler that never finishes is waited for only for the grace period (60 ms here, 1.5 s by default), then the peer closes with nothing written for it');

  const second = rig();
  second.peer.start();
  second.input.destroy(new Error('read error'));
  await second.peer.closed;
  assert.ok(second.logs.some((l) => /input/i.test(l)));
  ok('an error on the input closes the peer the same way, and is logged');

  const idle = rig();
  idle.peer.start();
  idle.end();
  await idle.peer.closed;
  await idle.peer.closed;
  assert.equal(idle.lines().length, 0);
  ok('an input that ends with nothing in it closes the peer without a word on the output');
}

// ---- F. what the lists of mutations asked for ---------------------------------------------------------------------------------------------------------------
{
  // Two of the three bytes of a byte order mark are not one.
  const r = rig();
  r.peer.handle('echo', async () => ({}));
  r.peer.start();
  r.feed(Buffer.concat([Buffer.from([0xef, 0xbb]), Buffer.from('{"jsonrpc":"2.0","id":1,"method":"echo"}\n')]));
  await settle();
  assert.equal(r.lines().at(-1).error?.data?.reason, 'invalid_utf8');
  ok('a line that starts with two of the three bytes of a byte order mark is invalid UTF-8: nothing is stripped from it');
}

{
  // The limit counts the line without its line end, whether that is LF or CRLF.
  const limit = 120;
  const r = rig({ peer: { maxLineBytes: limit } });
  const seen = [];
  r.peer.handle('echo', async (params) => { seen.push(params); return {}; });
  r.peer.start();
  const padded = (size, id) => {
    const base = JSON.stringify({ jsonrpc: '2.0', id, method: 'echo', params: { pad: '' } });
    return JSON.stringify({ jsonrpc: '2.0', id, method: 'echo', params: { pad: 'x'.repeat(size - Buffer.byteLength(base)) } });
  };
  r.feed(`${padded(limit, 1)}\r\n`);
  await settle();
  assert.equal(seen.length, 1);
  r.feed(`${padded(limit + 1, 2)}\r\n`);
  await settle();
  assert.equal(seen.length, 1);
  assert.equal(r.lines().at(-1).error?.message, 'Message too large');
  assert.ok(r.peer.stats.maxBufferedBytes >= limit, `the buffer did reach the limit before the line was refused, saw ${r.peer.stats.maxBufferedBytes}`);
  assert.ok(r.peer.stats.maxBufferedBytes <= limit + 1);
  ok(`with CRLF a line of exactly the limit (${limit} bytes before its line end) is taken and one byte more is refused, and the buffer reached the limit but not more than one byte beyond it`);
  r.feed('\t \t\n');
  await settle();
  assert.equal(r.lines().filter((m) => m.error?.code === ERROR_CODES.PARSE).length, 0);
  ok('a line of tabs and spaces is blank like an empty one');
}

{
  const nextLine = String.fromCharCode(0x85); // built, not written: it is a line end to some readers
  const r = rig();
  r.peer.handle('echo', async (params) => params);
  r.peer.start();
  r.feed(line({ jsonrpc: '2.0', id: 1, method: 'echo', params: { s: `a${nextLine}b` } }));
  await settle();
  const raw = r.raw();
  assert.ok(!raw.includes(nextLine) && raw.includes('\\u0085'), 'NEL is written as the six characters backslash u 0085');
  assert.equal(r.lines()[0].result.s, `a${nextLine}b`);
  ok('U+0085 leaves as an escape that reads back as itself (the escape has four digits)');
}

{
  const r = rig();
  const circular = {};
  circular.self = circular;
  r.peer.handle('cycle', async () => circular);
  r.peer.handle('big', async () => ({ n: 10n }));
  r.peer.handle('fn', async () => () => 1);
  r.peer.handle('sym', async () => Symbol('x'));
  r.peer.start();
  r.feed(line({ jsonrpc: '2.0', id: 1, method: 'cycle' }) + line({ jsonrpc: '2.0', id: 2, method: 'big' }) + line({ jsonrpc: '2.0', id: 3, method: 'fn' }) + line({ jsonrpc: '2.0', id: 4, method: 'sym' }));
  await settle();
  assert.deepEqual(r.lines().map((m) => [m.id, m.error?.code, m.error?.message]), [1, 2, 3, 4].map((id) => [id, ERROR_CODES.INTERNAL, 'Internal error']));
  ok('a result that cannot be serialized (a cycle, a BigInt) or is not data (a function, a symbol) answers Internal error and does not crash the agent');
  const logged = r.logs.length;
  r.peer.notify('x', { n: 10n });
  assert.equal(r.logs.length, logged + 1);
  ok('and a notification that cannot be serialized is logged and not written');
}

{
  // A handler that finishes after the grace period has run out is not answered: the peer is finished.
  const r = rig({ peer: { graceMs: 30 } });
  r.peer.handle('late', async () => { await sleep(150); return { late: true }; });
  r.peer.start();
  r.feed(line({ jsonrpc: '2.0', id: 1, method: 'late' }));
  await settle();
  r.end();
  await r.peer.closed;
  await sleep(250);
  assert.equal(r.lines().length, 0);
  ok('the answer of a handler that finishes after the grace period is not written: once closed, the peer writes nothing');
}

{
  const r = rig();
  r.peer.onNotification('seen', () => {});
  r.peer.start();
  const logged = r.logs.length;
  r.feed(line({ jsonrpc: '2.0', method: '$/cancel_request', params: {} }) + line({ jsonrpc: '2.0', method: '$/progress', params: {} }));
  await settle();
  assert.equal(r.logs.length, logged);
  r.feed(line({ jsonrpc: '2.0', method: 'seen' }).replace('"jsonrpc":"2.0",', ''));
  await settle();
  assert.equal(r.lines().length, 0);
  assert.ok(r.logs.some((l) => /jsonrpc/.test(l)));
  ok('a $/ notification the agent does not implement is ignored without even a log line, and a notification without "jsonrpc" is dropped, logged, and not answered');
  assert.equal(r.peer.stats.messagesIn, 3);
  assert.equal(r.peer.stats.messagesOut, 0);
  ok('the peer counts the messages that came in and went out');
}

{
  const r = rig();
  r.peer.start();
  const pending = r.peer.request('ask', {});
  await settle();
  const { id } = r.lines().at(-1);
  r.feed(line({ jsonrpc: '2.0', id, result: { fine: false }, error: { code: 1, message: 'both' } }));
  await settle();
  let settled = false;
  pending.then(() => { settled = true; }, () => { settled = true; });
  await settle();
  assert.equal(settled, false, 'a response with a result and an error is ignored: the request is still waiting');
  r.feed(line({ jsonrpc: '2.0', id, error: 'oops' }));
  await assert.rejects(pending, (error) => error instanceof RpcError && error.code === ERROR_CODES.INTERNAL && /malformed error/i.test(error.message));
  ok('a response that has both a result and an error is ignored, and an error that is not an error object rejects the request with a plain sentence');
}

{
  const r = rig();
  r.peer.start();
  const controller = new AbortController();
  controller.abort(new Error('already aborted'));
  const written = r.lines().length;
  await assert.rejects(r.peer.request('x', {}, { signal: controller.signal }), /already aborted/);
  await settle();
  assert.equal(r.lines().length, written, 'a request that was aborted before it was made is never sent');
  ok('a request made with a signal that is already aborted rejects at once and is not sent');
}

{
  const r = rig();
  const callbacks = [];
  r.peer.onClose(() => callbacks.push('closed'));
  r.peer.start();
  void r.peer.close('first');
  void r.peer.close('second');
  r.end();
  await r.peer.closed;
  assert.deepEqual(callbacks, ['closed']);
  assert.equal(r.logs.filter((l) => l === 'first' || l === 'second').length, 1, 'only the first reason is logged');
  await assert.rejects(r.peer.request('after', {}), (error) => error instanceof RpcError && /closed/i.test(error.message));
  ok('closing twice is closing once, and a request made after the close rejects at once');

  const seen = [];
  const late = rig();
  late.peer.handle('echo', async (p) => { seen.push(p); return {}; });
  late.peer.start();
  await late.peer.close('we close');
  late.input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'echo', params: { late: true } })}\n`);
  await settle();
  assert.deepEqual(seen, []);
  ok('what the other side sends after we closed is not read');

  const destroyed = rig();
  destroyed.peer.start();
  destroyed.input.destroy(); // no error, no end: only "close"
  await Promise.race([destroyed.peer.closed, sleep(2000).then(() => assert.fail('the peer did not close when the input was destroyed'))]);
  assert.ok(destroyed.logs.some((l) => /input closed/.test(l)));
  ok('an input that is destroyed without an error or an end closes the peer too');
}

{
  const r = rig();
  r.peer.start();
  r.output.destroy(new Error('EPIPE'));
  await settle();
  r.peer.notify('x', {});
  r.peer.notify('y', {});
  await r.peer.flush();
  assert.equal(r.logs.filter((l) => /output closed or broken/.test(l)).length, 1);
  ok('a broken output is logged once, however many messages follow');
}


// ---- G. more of what the lists of mutations asked for -------------------------------------------------------------------------------------------------------
{
  const r = rig();
  const seen = [];
  r.peer.handle('echo', async (params) => { seen.push(params); return {}; });
  r.peer.start();
  r.peer.start(); // a second start does not read everything twice
  r.feed(line({ jsonrpc: '2.0', id: 1, method: 'echo', params: { once: true } }));
  await settle();
  assert.deepEqual(seen, [{ once: true }]);
  assert.equal(r.lines().length, 1);
  ok('start() twice reads the input once: a message is handled once and answered once');

  const order = [];
  const failing = rig();
  failing.peer.onClose(() => { order.push('first'); throw new Error('a callback that fails'); });
  failing.peer.onClose(() => order.push('second'));
  failing.peer.start();
  failing.end();
  await failing.peer.closed;
  assert.deepEqual(order, ['first', 'second']);
  assert.ok(failing.logs.some((l) => /close callback failed: a callback that fails/.test(l)));
  ok('a close callback that throws is logged and does not stop the next one');
}

{
  const { getEventListeners } = await import('node:events');
  const r = rig();
  r.peer.start();
  const controller = new AbortController();
  const asked = r.peer.request('ask', {}, { signal: controller.signal, timeoutMs: 10_000 });
  await settle();
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
  const { id } = r.lines().at(-1);
  r.feed(line({ jsonrpc: '2.0', id, result: {} }));
  await asked;
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  ok('a request that was answered lets go of its signal (a long-lived signal would otherwise collect a listener for every request)');

  await assert.rejects(r.peer.request('ask', { n: 10n }), (error) => error instanceof RpcError && error.code === ERROR_CODES.INTERNAL && /could not be serialized/.test(error.message));
  ok('a request whose parameters cannot be serialized rejects at once instead of waiting for an answer that cannot come');
}

{
  const lines = [];
  const throwing = { write() { throw new Error('write failed'); }, on() {} };
  const logs = [];
  const input = new PassThrough();
  const peer = createRpcPeer({ input, output: throwing, log: (l) => logs.push(l) });
  peer.handle('echo', async () => ({}));
  peer.start();
  input.write(line({ jsonrpc: '2.0', id: 1, method: 'echo' }));
  await settle();
  await peer.flush();
  assert.ok(logs.some((l) => /output closed or broken \(write failed\)/.test(l)));
  assert.equal(lines.length, 0);
  ok('an output whose write throws is marked broken and logged, and the agent goes on');
}

{
  const r = rig();
  r.peer.handle('echo', async () => ({}));
  r.peer.start();
  r.feed(line({ jsonrpc: '2.0', id: 1, method: 'echo' }) + line({ jsonrpc: '2.0', id: 2, method: 'echo' }));
  await settle();
  r.peer.notify('n', {});
  await r.peer.flush();
  assert.equal(r.peer.stats.messagesIn, 2);
  assert.equal(r.peer.stats.messagesOut, r.lines().length);
  assert.equal(r.peer.stats.messagesOut, 3);
  ok('the counts of messages in and out are the messages that came and the lines that were written');

  const closing = rig();
  closing.peer.start();
  const waiting = closing.peer.request('never', {});
  const rejected = assert.rejects(waiting, (error) => error instanceof RpcError && error.code === ERROR_CODES.CANCELLED);
  closing.end();
  await closing.peer.closed;
  await rejected;
  await assert.rejects(closing.peer.request('after', {}), (error) => error.code === ERROR_CODES.CANCELLED);
  ok('a request that is waiting when the connection closes, and one made afterwards, reject with the code of a cancelled request (-32800)');

  const partial = rig();
  const seen = [];
  partial.peer.handle('echo', async (p) => { seen.push(p); return {}; });
  partial.peer.start();
  await partial.peer.close('we close');
  partial.input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'echo', params: { partial: true } })); // no line end
  partial.input.end();
  await settle();
  assert.deepEqual(seen, []);
  ok('and a last line without a line end that arrives after we closed is not handled either');
}


// ---- H. the second round of the lists of mutations --------------------------------------------------------------------------------------------------------
{
  // The numbers are the ones JSON-RPC and ACP define; a test that compares a code with the constant of the module would pass for any value.
  assert.deepEqual({ ...ERROR_CODES }, { PARSE: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602, INTERNAL: -32603, AUTH_REQUIRED: -32000, NOT_FOUND: -32002, CANCELLED: -32800 });
  const r = rig();
  r.peer.start();
  r.feed('not json\n');
  await settle();
  assert.equal(r.lines()[0].error.code, -32700);
  const waiting = r.peer.request('x', {});
  const rejected = assert.rejects(waiting, (error) => error.code === -32800);
  r.end();
  await r.peer.closed;
  await rejected;
  ok('the error codes are the numbers of the specifications (-32700, -32600, -32601, -32602, -32603, -32000, -32002, -32800), and they are what goes on the wire');
}

{
  // The line that was started before we closed, and the end of the input after.
  const seen = [];
  const r = rig();
  r.peer.handle('echo', async (p) => { seen.push(p); return {}; });
  r.peer.start();
  r.input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'echo', params: { started: true } })); // no line end yet
  await settle();
  await r.peer.close('we close first');
  r.input.end();
  await settle();
  assert.deepEqual(seen, []);
  ok('a last line that was still unfinished when we closed is not handled when the input ends afterwards');
}

{
  // An output that fails a write AND emits the error event: one line in the log.
  const logs = [];
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(new Error('boom')); } });
  const input = new PassThrough();
  const peer = createRpcPeer({ input, output, log: (l) => logs.push(l) });
  peer.start();
  peer.notify('x', {});
  await settle();
  await peer.flush();
  assert.equal(logs.filter((l) => /output closed or broken/.test(l)).length, 1);
  ok('an output that fails a write is reported once even though two things report it (the callback and the error event)');
}

// ---- I. properties, with a seed (the same seed is the same run) ----------------------------------------------------------------------------------------------
{
  // mulberry32
  const generator = (seed) => () => { let t = (seed += 0x6d2b79f5) | 0; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const turn = () => new Promise((resolve) => setImmediate(resolve));

  // 1. Where the bytes are cut never changes what the peer does with them.
  const text = [
    line({ jsonrpc: '2.0', id: 1, method: 'echo', params: { s: 'café \u{1F600}', n: [1, 2, 3] } }),
    line({ jsonrpc: '2.0', method: 'note', params: { a: 1 } }),
    'this is not json\n',
    '\r\n',
    line({ jsonrpc: '2.0', id: 'two', method: 'echo', params: null }),
    line({ jsonrpc: '2.0', id: 3, method: 'nope' }),
    '[1,2]\n',
    line({ jsonrpc: '2.0', id: 4, method: 'echo', params: { s: 'line separator and é\u{1F600}' } }),
    '{"jsonrpc":"2.0","id":5,"method":"echo","params":{"x":1}}', // a last line with no line end
  ].join('');
  const bytes = Buffer.from(text, 'utf8');
  const play = async (cuts) => {
    const r = rig();
    const notes = [];
    r.peer.handle('echo', async (params) => ({ echoed: params ?? null }));
    r.peer.onNotification('note', (params) => notes.push(params));
    r.peer.start();
    let from = 0;
    for (const cut of cuts) { r.feed(bytes.subarray(from, cut)); from = cut; await turn(); }
    r.feed(bytes.subarray(from));
    await turn();
    r.end();
    await r.peer.closed;
    return { answers: r.raw().split('\n').filter(Boolean).sort(), notes, logs: r.logs.slice().sort() };
  };
  const whole = await play([]);
  assert.equal(whole.answers.length, 7, `seven answers when the stream is delivered whole: ${whole.answers.join(' | ')}`);
  const random = generator(20_261_107);
  for (let trial = 0; trial < 150; trial += 1) {
    const cuts = [...new Set(Array.from({ length: 1 + Math.floor(random() * 30) }, () => Math.floor(random() * bytes.length)))].sort((a, b) => a - b);
    const result = await play(cuts);
    assert.deepEqual(result, whole, `cut at ${JSON.stringify(cuts)}`);
  }
  ok('150 random ways of cutting the same stream into pieces (inside characters, inside a CRLF, at every kind of line) give the same answers, the same notifications and the same log');

  // 2. Whatever arrives, the peer writes only lines that are messages, never exceeds its limit, answers a valid request that follows, and ends.
  const alphabet = [0x7b, 0x7d, 0x5b, 0x5d, 0x22, 0x3a, 0x2c, 0x5c, 0x0a, 0x0a, 0x0d, 0x00, 0xff, 0xc3, 0x28, 0xe2, 0x80, 0xa8, 0x30, 0x31, 0x39, 0x20, 0x09, 0x74, 0x72, 0x75, 0x65, 0x6e, 0x75, 0x6c, ...Buffer.from('jsonrpc2.0idmethodparamsresulterror')];
  const fuzz = generator(31_337);
  let refusals = 0;
  for (let trial = 0; trial < 300; trial += 1) {
    const size = Math.floor(fuzz() * 2500);
    const junk = Buffer.alloc(size);
    for (let i = 0; i < size; i += 1) junk[i] = fuzz() < 0.85 ? alphabet[Math.floor(fuzz() * alphabet.length)] : Math.floor(fuzz() * 256);
    const r = rig({ peer: { maxLineBytes: 700 } });
    r.peer.handle('echo', async (params) => ({ echoed: params ?? null }));
    r.peer.start();
    let from = 0;
    while (from < junk.length) { const to = Math.min(junk.length, from + 1 + Math.floor(fuzz() * 400)); r.feed(junk.subarray(from, to)); from = to; if (fuzz() < 0.2) await turn(); }
    r.feed(Buffer.from(`\n${line({ jsonrpc: '2.0', id: 'after-garbage', method: 'echo', params: { trial } })}`, 'utf8'));
    await turn();
    r.end();
    await r.peer.closed;
    const out = r.raw().split('\n').filter(Boolean);
    for (const row of out) {
      const message = JSON.parse(row); // every line is JSON
      assert.equal(message.jsonrpc, '2.0', row);
      assert.ok('result' in message || 'error' in message || 'method' in message, row);
      if ('error' in message) { refusals += 1; assert.ok(Number.isInteger(message.error.code) && typeof message.error.message === 'string', row); }
    }
    assert.ok(out.some((row) => { const m = JSON.parse(row); return m.id === 'after-garbage' && m.result?.echoed?.trial === trial; }), `the valid request after the garbage of trial ${trial} was answered`);
    assert.ok(r.peer.stats.maxBufferedBytes <= 700, `never more than the limit is held (${r.peer.stats.maxBufferedBytes})`);
  }
  assert.ok(refusals > 100, `the garbage was refused ${refusals} times: the run meant something`);
  ok(`300 random inputs of up to 2,500 bytes (limit 700 per line): every line written is a JSON-RPC message, nothing above the limit is held, the next valid request is answered, the peer ends (${refusals} refusals seen)`);
}

console.log(`PASS: ${checks} checks (the ACP wire: framing on bytes, the envelope, ids, limits, back-pressure, requests of our own, the end of the input, properties with a seed)`);
