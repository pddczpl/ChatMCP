// lib/mcp/result-limits.mjs: an MCP tool result is bounded before it reaches the model (P2 slice C1, plan task ext-13).
//
//  1. the ceiling: text, base64 media, URIs and the JSON of structured content share one 8 MB budget (4 KB of it kept for the notes); a 50 MB text is cut
//     at a code point, and the model is told what was left out
//  2. structured content: a bounded copy, dropped with a note when it does not fit, is not an object, is too deep or is not plain JSON; __proto__ cannot pollute
//  3. media: images and audio limited by count and bytes, base64 and the media type checked; embedded resources and resource links bounded
//  4. unknown content types dropped with a note that spells their names out safely; isError kept exactly when it is true
//  5. the model-facing cap: lib/token-optimization.mjs optimizeToolResult runs on the bounded result (and only compacts the tool names it knows)
//  6. the stderr collector: at most N bytes kept (the first half and the last half), the rest counted, whole UTF-8 characters, control characters removed
//  7. totality and timing
import assert from 'node:assert/strict';
import { PROVIDER_IMAGE_TYPES, RESULT_LIMITS, STDERR_DEFAULT_BYTES, createStderrCollector, limitToolResult } from '../lib/mcp/result-limits.mjs';
import { setTokenProfile } from '../lib/token-optimization.mjs';

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
setTimeout(() => { console.error('FAIL: the MCP result limits suite exceeded its own time budget'); process.exit(2); }, 120_000).unref();

const bytes = (text) => Buffer.byteLength(text, 'utf8');
const MiB = 1024 * 1024;
const NOTE_PREFIX = '[DatGold limited this result: ';
// What the ceiling counts: the UTF-8 bytes of every kept string that carries content, and the JSON of the structured content.
function weight(result) {
  let total = 0;
  for (const item of result.content) {
    for (const key of ['text', 'data', 'uri', 'name', 'title', 'description', 'mimeType']) if (typeof item[key] === 'string') total += bytes(item[key]);
    if (item.resource) for (const key of ['uri', 'text', 'blob', 'mimeType']) if (typeof item.resource[key] === 'string') total += bytes(item.resource[key]);
  }
  if (result.structuredContent !== undefined) total += bytes(JSON.stringify(result.structuredContent));
  return total;
}
const noteOf = (result) => {
  const last = result.content.at(-1);
  return last?.type === 'text' && last.text.startsWith(NOTE_PREFIX) ? last.text : null;
};
const png = (decodedBytes) => Buffer.alloc(decodedBytes, 7).toString('base64');

// ------------------------------------------------------------------ 1. the ceiling
{
  assert.deepEqual([RESULT_LIMITS.maxReadBytes, RESULT_LIMITS.noteReserveBytes, RESULT_LIMITS.maxContentItems, RESULT_LIMITS.maxImages, RESULT_LIMITS.maxImageBytes, RESULT_LIMITS.maxAudio, RESULT_LIMITS.maxAudioBytes],
    [8 * MiB, 4096, 256, 8, 5 * MiB, 2, 5 * MiB]);
  const small = { content: [{ type: 'text', text: 'hello' }], structuredContent: { a: 1 } };
  assert.deepEqual(limitToolResult(small), { result: { content: [{ type: 'text', text: 'hello' }], structuredContent: { a: 1 } }, notes: [], stats: { bytes: 12, items: 1, dropped: 0, cut: 0 } });
  const copy = limitToolResult(small).result;
  assert.notEqual(copy.structuredContent, small.structuredContent, 'structured content is a copy');
  assert.deepEqual(limitToolResult({ content: [{ type: 'text', text: 'x', annotations: { audience: ['user'] }, _meta: { a: 1 } }], _meta: { b: 2 } }).result, { content: [{ type: 'text', text: 'x' }] }, '_meta and content annotations do not pass');

  const fifty = 'x'.repeat(50 * MiB);
  let started = performance.now();
  const big = limitToolResult({ content: [{ type: 'text', text: fifty }] });
  const elapsed = performance.now() - started;
  const budget = 8 * MiB - 4096;
  assert.equal(big.result.content[0].text.length, budget, 'a 50 MB text is cut to the ceiling less the note reserve');
  assert.deepEqual(big.notes, [`text cut: ${50 * MiB - budget} of ${50 * MiB} bytes not shown (ceiling ${8 * MiB} bytes)`]);
  assert.equal(noteOf(big.result), `${NOTE_PREFIX}${big.notes[0]}]`);
  assert.ok(weight(big.result) <= 8 * MiB, `${weight(big.result)} bytes`);
  assert.deepEqual(big.stats, { bytes: budget, items: 1, dropped: 0, cut: 1 });
  assert.ok(elapsed < 1500, `50 MB took ${Math.round(elapsed)} ms`);

  const emoji = limitToolResult({ content: [{ type: 'text', text: `a${'\u{1F600}'.repeat(3 * MiB)}` }] });
  assert.ok(emoji.result.content[0].text.isWellFormed() && bytes(emoji.result.content[0].text) === 1 + Math.floor((budget - 1) / 4) * 4, 'the cut keeps whole code points');

  const tight = { limits: { maxReadBytes: 10_000 } };
  assert.deepEqual(limitToolResult({ content: [{ type: 'text', text: 'y'.repeat(5904) }] }, tight).notes, [], 'exactly the budget is not cut');
  assert.deepEqual(limitToolResult({ content: [{ type: 'text', text: 'y'.repeat(5905) }] }, tight).notes, ['text cut: 1 of 5905 bytes not shown (ceiling 10000 bytes)']);
  const shared = limitToolResult({ content: [{ type: 'text', text: 'a'.repeat(4000) }, { type: 'text', text: 'b'.repeat(4000) }, { type: 'text', text: 'c'.repeat(10) }] }, tight);
  assert.deepEqual(shared.result.content.slice(0, 2).map((item) => item.text.length), [4000, 1904], 'blocks share the budget in order');
  assert.equal(shared.result.content.length, 3, 'a block with no room left is dropped; the third item is the note');
  assert.deepEqual(shared.notes, ['text cut: 2106 of 8010 bytes not shown (ceiling 10000 bytes)']);
  assert.deepEqual(shared.stats, { bytes: 5904, items: 2, dropped: 1, cut: 2 });
  for (const limits of [{ maxReadBytes: 8191 }, { maxReadBytes: -1 }, { maxImages: 1.5 }, { maxAudio: '2' }, { maxContentItems: NaN }, { maxImageBytes: -5 }]) {
    assert.throws(() => limitToolResult(small, { limits }), TypeError, JSON.stringify(limits));
  }
  assert.equal(limitToolResult({ content: [{ type: 'image', data: png(10), mimeType: 'image/png' }] }, { limits: { maxImages: 0 } }).result.content[0].type, 'text', 'maxImages 0 keeps no image');
  ok(`ceiling: 8 MiB shared by every block (4 KiB kept for the note); a 50 MB text cut in ${Math.round(elapsed)} ms at a code point with a note that says how much is missing`);
}

// ------------------------------------------------------------------ 2. structured content
{
  const tight = { limits: { maxReadBytes: 10_000 } };
  const fits = limitToolResult({ content: [], structuredContent: { rows: [1, 2, 3], name: 'x' } });
  assert.deepEqual(fits.result, { content: [], structuredContent: { rows: [1, 2, 3], name: 'x' } });
  const tooBig = limitToolResult({ content: [{ type: 'text', text: '{"rows": "..."}' }], structuredContent: { rows: 'r'.repeat(6000) } }, tight);
  assert.deepEqual(tooBig.notes, ['structured content dropped: larger than the space left under the ceiling']);
  assert.equal(Object.hasOwn(tooBig.result, 'structuredContent'), false);
  assert.equal(tooBig.result.content[0].text, '{"rows": "..."}', 'the text copy stays');
  const cases = [
    [[1, 2], 'not a JSON object'], ['text', 'not a JSON object'], [null, 'not a JSON object'], [42, 'not a JSON object'],
    [(() => { let value = {}; for (let i = 0; i < 100; i += 1) value = { value }; return value; })(), 'deeper than 64 levels'],
    [{ when: new Date(0) }, 'not plain JSON'], [{ f: () => 1 }, 'not plain JSON'], [{ n: NaN }, 'not plain JSON'],
    [(() => { const loop = {}; loop.loop = loop; return loop; })(), 'deeper than 64 levels'],
    [Object.defineProperty({}, 'bad', { enumerable: true, get() { throw new Error('boom'); } }), 'not plain JSON'],
  ];
  for (const [structuredContent, reason] of cases) {
    let limited;
    assert.doesNotThrow(() => { limited = limitToolResult({ content: [], structuredContent }); });
    assert.deepEqual(limited.notes, [`structured content dropped: ${reason}`], reason);
    assert.equal(Object.hasOwn(limited.result, 'structuredContent'), false);
  }
  const polluted = limitToolResult(JSON.parse('{"content":[],"structuredContent":{"__proto__":{"isAdmin":true},"ok":1}}'));
  assert.ok(Object.hasOwn(polluted.result.structuredContent, '__proto__'));
  assert.equal({}.isAdmin, undefined);
  assert.equal(polluted.result.structuredContent.isAdmin, undefined, 'the copy does not inherit from the __proto__ key');
  const afterText = limitToolResult({ content: [{ type: 'text', text: 'a'.repeat(5000) }], structuredContent: { a: 'b'.repeat(1000) } }, tight);
  assert.deepEqual(afterText.notes, ['structured content dropped: larger than the space left under the ceiling'], 'structured content gets what the content left');
  ok(`structured content: kept as a bounded copy, dropped with the reason in ${cases.length + 1} cases, never inheriting from a __proto__ key`);
}

// ------------------------------------------------------------------ 3. media and resources
{
  const image = (decoded, mimeType = 'image/png') => ({ type: 'image', data: png(decoded), mimeType });
  const kept = limitToolResult({ content: [image(100)] });
  assert.deepEqual(kept.result.content, [image(100)]);
  const nine = limitToolResult({ content: Array.from({ length: 9 }, () => image(10)) });
  assert.equal(nine.result.content.filter((item) => item.type === 'image').length, 8);
  assert.deepEqual(nine.notes, ['1 item(s) dropped: more than 8 images']);
  const large = limitToolResult({ content: [image(5 * MiB + 3)] });
  assert.deepEqual(large.notes, [`1 item(s) dropped: image larger than ${5 * MiB} bytes`]);
  assert.deepEqual(limitToolResult({ content: [image(5 * MiB)] }).notes, [], 'an image of exactly 5 MiB is kept');
  const two = limitToolResult({ content: [image(4 * MiB), image(4 * MiB)] });
  assert.deepEqual([two.result.content.filter((item) => item.type === 'image').length, two.notes], [1, ['1 item(s) dropped: over the result ceiling']], 'base64 counts against the ceiling');
  for (const bad of [{ type: 'image', data: 'not base64!', mimeType: 'image/png' }, { type: 'image', data: png(3), mimeType: 'text/html' }, { type: 'image', data: 42, mimeType: 'image/png' },
    { type: 'image', data: png(3) }, { type: 'image', data: png(3), mimeType: 'image/svg+xml\u202E' }]) {
    assert.deepEqual(limitToolResult({ content: [bad] }).notes, ['1 item(s) dropped: not base64 data of an image type'], JSON.stringify(bad).slice(0, 80));
  }
  // Only the types the model providers accept are passed on as images; any other image type becomes a note, never an image block.
  assert.deepEqual(PROVIDER_IMAGE_TYPES, ['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
  for (const mimeType of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) assert.equal(limitToolResult({ content: [image(3, mimeType)] }).result.content[0].type, 'image', mimeType);
  for (const mimeType of ['image/svg+xml', 'image/bmp', 'image/tiff', 'image/x-icon', 'image/heic']) {
    const other = limitToolResult({ content: [image(3, mimeType)] });
    assert.deepEqual(other.result.content.map((item) => item.type), ['text'], mimeType);
    assert.deepEqual(other.notes, ['1 item(s) dropped: an image of a type the model providers do not accept (only image/png, image/jpeg, image/gif and image/webp)'], mimeType);
  }
  const svgBlob = limitToolResult({ content: [{ type: 'resource', resource: { uri: 'mem://s', mimeType: 'image/svg+xml', blob: png(3) } }] });
  assert.deepEqual(svgBlob.result.content.map((item) => item.type), ['text'], 'an embedded SVG blob is not an image either');
  const audio = (decoded) => ({ type: 'audio', data: png(decoded), mimeType: 'audio/wav' });
  const three = limitToolResult({ content: [audio(10), audio(10), audio(10)] });
  assert.deepEqual([three.result.content.filter((item) => item.type === 'audio').length, three.notes], [2, ['1 item(s) dropped: more than 2 audio clips']]);
  assert.deepEqual(limitToolResult({ content: [audio(5 * MiB + 3)] }).notes, [`1 item(s) dropped: audio larger than ${5 * MiB} bytes`]);
  assert.deepEqual(limitToolResult({ content: [{ type: 'audio', data: png(3), mimeType: 'image/png' }] }).notes, ['1 item(s) dropped: not base64 data of an audio type']);

  const link = { type: 'resource_link', uri: 'file:///w/a.txt', name: 'a.txt', description: 'd'.repeat(3000), mimeType: 'text/plain', _meta: {} };
  const linked = limitToolResult({ content: [link] });
  assert.deepEqual(linked.result.content, [{ type: 'resource_link', uri: 'file:///w/a.txt', name: 'a.txt', description: 'd'.repeat(2048), mimeType: 'text/plain' }]);
  assert.deepEqual(limitToolResult({ content: [{ ...link, uri: 'x'.repeat(2049) }] }).notes, ['1 item(s) dropped: a malformed item']);
  assert.deepEqual(limitToolResult({ content: [{ type: 'resource_link', name: 'a' }] }).notes, ['1 item(s) dropped: a malformed item']);
  const embeddedText = limitToolResult({ content: [{ type: 'resource', resource: { uri: 'mem://a', mimeType: 'text/plain', text: 'z'.repeat(6000) } }] }, { limits: { maxReadBytes: 10_000 } });
  assert.equal(embeddedText.result.content[0].resource.text.length, 5904 - bytes('mem://a') - bytes('text/plain'));
  assert.deepEqual(embeddedText.notes, [`text cut: ${6000 - embeddedText.result.content[0].resource.text.length} of 6000 bytes not shown (ceiling 10000 bytes)`]);
  const blobImage = { type: 'resource', resource: { uri: 'mem://p', mimeType: 'image/png', blob: png(10) } };
  assert.deepEqual(limitToolResult({ content: [blobImage] }).result.content, [blobImage], 'an embedded image counts as an image');
  assert.deepEqual(limitToolResult({ content: [{ type: 'resource', resource: { uri: 'mem://b', mimeType: 'application/zip', blob: png(10) } }] }).notes, ['1 item(s) dropped: a binary resource']);
  assert.deepEqual(limitToolResult({ content: [{ type: 'resource', resource: 'x' }] }).notes, ['1 item(s) dropped: a malformed item']);
  ok('media: 8 images and 2 audio clips of 5 MiB at most, base64 and type checked, counted against the ceiling; resource links and embedded resources bounded');
}

// ------------------------------------------------------------------ 4. unknown types, isError, garbage
{
  const unknown = limitToolResult({ content: [{ type: 'video', data: 'x' }, { type: 'x\u200By' }, { type: 'video' }, { type: 42 }, { text: 'no type' }, { type: 'text', text: 'kept' }] });
  assert.deepEqual(unknown.result.content[0], { type: 'text', text: 'kept' });
  assert.deepEqual(unknown.notes, ['5 item(s) dropped: an unsupported type ("video", "x\\u{200B}y", "number", "undefined")']);
  const many = limitToolResult({ content: Array.from({ length: 20 }, (_, i) => ({ type: `t${i}` })) });
  assert.deepEqual(many.notes, ['20 item(s) dropped: an unsupported type ("t0", "t1", "t2", "t3", "t4", ...)'], 'at most five type names are spelled out');
  const flood = limitToolResult({ content: Array.from({ length: 100_000 }, () => ({ type: 'text', text: 'a' })) });
  assert.deepEqual([flood.result.content.length, flood.notes], [257, ['99744 item(s) dropped: more than 256 content items']]);

  assert.equal(limitToolResult({ content: [{ type: 'text', text: 'failed' }], isError: true }).result.isError, true);
  for (const isError of [false, 'true', 1, undefined, null]) assert.equal(Object.hasOwn(limitToolResult({ content: [], isError }).result, 'isError'), false, String(isError));
  const failedBig = limitToolResult({ content: [{ type: 'text', text: 'e'.repeat(9 * MiB) }, { type: 'mystery' }], isError: true });
  assert.equal(failedBig.result.isError, true, 'an error result that was cut is still an error');

  for (const [raw, note] of [[null, 'the server sent no result object'], [42, 'the server sent no result object'], ['x', 'the server sent no result object'], [[], 'the server sent no result object'],
    [{ content: 'x' }, 'content was not a list'], [{ content: { length: 2 } }, 'content was not a list']]) {
    const limited = limitToolResult(raw);
    assert.deepEqual(limited.notes, [note], JSON.stringify(raw));
  }
  assert.equal(limitToolResult(null).result.isError, true, 'a missing result is an error');
  assert.equal(Object.hasOwn(limitToolResult({ content: 'x' }).result, 'isError'), false);
  assert.deepEqual(limitToolResult({}).result, { content: [] }, 'no content is an empty list');
  assert.deepEqual(limitToolResult({ content: [null, 5, 'x', []] }).notes, ['4 item(s) dropped: a malformed item']);
  ok('unknown types dropped with escaped names (5 at most), 256 items at most, isError kept only when true, garbage results become a note');
}

// ------------------------------------------------------------------ 5. the model-facing cap of optimizeToolResult
{
  setTokenProfile('mcp-limits-task', 'safe');
  const log = Array.from({ length: 2000 }, (_, i) => (i % 400 === 0 ? `step ${i} error: failed` : 'same line again')).join('\n');
  const optimized = limitToolResult({ content: [{ type: 'text', text: log }] }, { taskId: 'mcp-limits-task', toolName: 'mcp.fixture.run_command' });
  assert.match(optimized.result.content[0].text, /^\[TOKEN OPTIMIZED: safe, raw receipt tok_[0-9a-f-]+;/, 'optimizeToolResult ran on the bounded result');
  assert.ok(optimized.result.content[0].text.length < log.length / 3);
  const off = limitToolResult({ content: [{ type: 'text', text: log }] }, { taskId: 'mcp-limits-task', toolName: 'mcp.fixture.run_command', optimize: false });
  assert.equal(off.result.content[0].text, log, 'optimize: false leaves it to the caller');
  const noTask = limitToolResult({ content: [{ type: 'text', text: log }] }, { toolName: 'mcp.fixture.run_command' });
  assert.equal(noTask.result.content[0].text, log, 'without a task there is nothing to optimize for');
  const unknownName = limitToolResult({ content: [{ type: 'text', text: log }] }, { taskId: 'mcp-limits-task', toolName: 'mcp.fixture.big_result' });
  assert.equal(unknownName.result.content[0].text, log, 'optimizeToolResult compacts only the tool names it knows: the gap docs/MCP-HARDENING.md names');
  const error = limitToolResult({ content: [{ type: 'text', text: log }], isError: true }, { taskId: 'mcp-limits-task', toolName: 'mcp.fixture.run_command' });
  assert.equal(error.result.content[0].text, log, 'an error result is never compacted');
  ok('optimizeToolResult is applied after the ceiling (with a task and a known tool name), can be switched off, and leaves unknown names and errors alone');
}

// ------------------------------------------------------------------ 6. the stderr collector
{
  assert.equal(STDERR_DEFAULT_BYTES, 64 * 1024);
  const quiet = createStderrCollector();
  quiet.push('hello ');
  quiet.push(Buffer.from('world\n'));
  quiet.push(new Uint8Array([0x6f, 0x6b]));
  assert.equal(quiet.text(), 'hello world\nok');
  assert.deepEqual(quiet.stats(), { totalBytes: 14, keptBytes: 14, droppedBytes: 0, ignored: 0 });

  const collector = createStderrCollector({ maxBytes: 4096 });
  let total = 0;
  let first = '';
  let last = '';
  let line = 0;
  let pushes = 0;
  const sizes = [1, 7, 100, 4095, 4096, 4097, 65_536, 3];
  while (total < 10 * MiB) {
    let chunk = '';
    const size = sizes[pushes % sizes.length];
    while (chunk.length < size) chunk += `line ${line++}\n`;
    chunk = chunk.slice(0, size);
    collector.push(pushes % 2 ? chunk : Buffer.from(chunk));
    pushes += 1;
    total += chunk.length;
    if (first.length < 2048) first = (first + chunk).slice(0, 2048);
    last = (last + chunk).slice(-2048);
  }
  const stats = collector.stats();
  assert.deepEqual(stats, { totalBytes: total, keptBytes: 4096, droppedBytes: total - 4096, ignored: 0 });
  const text = collector.text();
  assert.ok(text.includes(`[DatGold dropped ${total - 4096} bytes of stderr]`));
  const [head, tail] = text.split(/\n\[DatGold dropped \d+ bytes of stderr\]\n/);
  assert.equal(head, first, 'the first half of what was kept is the start of the output');
  assert.equal(tail, last, 'the second half is its end');
  ok(`stderr: 10 MiB in chunks of 1 B to 64 KiB keeps 4096 bytes (the first 2048 and the last 2048) and counts ${total - 4096} dropped`);

  const one = createStderrCollector({ maxBytes: 1024 });
  const single = Buffer.from(Array.from({ length: 1 * MiB }, (_, i) => 65 + (i % 26)));
  one.push(single);
  assert.equal(one.text(), `${single.subarray(0, 512).toString()}\n[DatGold dropped ${MiB - 1024} bytes of stderr]\n${single.subarray(MiB - 512).toString()}`);

  const partial = createStderrCollector({ maxBytes: 1024 });
  partial.push('a'.repeat(600));
  partial.push('b'.repeat(500));
  assert.deepEqual(partial.stats(), { totalBytes: 1100, keptBytes: 1024, droppedBytes: 76, ignored: 0 }, 'the oldest bytes of the second half are cut off, not whole chunks only');
  assert.equal(partial.text(), `${'a'.repeat(512)}\n[DatGold dropped 76 bytes of stderr]\n${'a'.repeat(12)}${'b'.repeat(500)}`);

  const euro = createStderrCollector({ maxBytes: 1024 });
  euro.push('\u20AC'.repeat(10_000));
  const euroText = euro.text();
  assert.ok(!euroText.includes('\uFFFD'), 'no character is split at either end of what was kept');
  assert.ok(/^\u20AC+\n\[DatGold dropped \d+ bytes of stderr\]\n\u20AC+$/.test(euroText));

  const colours = createStderrCollector();
  colours.push('\u001b[31mred\u001b[0m \u202Eevil\u200B\r\n');
  assert.equal(colours.text(), '[31mred[0m evil\n', 'control, bidi and zero-width characters are removed from the text');

  const junk = createStderrCollector();
  for (const value of [null, undefined, 42, {}, [], Symbol('s'), () => 1]) assert.doesNotThrow(() => junk.push(value));
  assert.deepEqual(junk.stats(), { totalBytes: 0, keptBytes: 0, droppedBytes: 0, ignored: 7 });
  assert.equal(junk.text(), '');
  for (const options of [{ maxBytes: 1023 }, { maxBytes: 1.5 }, { maxBytes: '4096' }, { maxBytes: 17 * MiB }]) assert.throws(() => createStderrCollector(options), TypeError, JSON.stringify(options));

  const bytesOne = Buffer.from('x');
  const fast = createStderrCollector();
  const started = performance.now();
  for (let i = 0; i < 1_000_000; i += 1) fast.push(bytesOne);
  const elapsed = performance.now() - started;
  assert.deepEqual(fast.stats(), { totalBytes: 1_000_000, keptBytes: 65_536, droppedBytes: 1_000_000 - 65_536, ignored: 0 });
  assert.ok(elapsed < 3000, `1,000,000 one-byte chunks took ${Math.round(elapsed)} ms`);
  ok(`stderr: one 1 MiB chunk split head/tail, whole characters at both ends, hidden characters removed, garbage ignored and counted, 1,000,000 pushes in ${Math.round(elapsed)} ms (budget 3000)`);
}

// ------------------------------------------------------------------ 7. totality
{
  let deep = [];
  for (let i = 0; i < 100_000; i += 1) deep = [deep];
  const trap = () => { throw new Error('trap'); };
  const proxy = new Proxy({}, { get: trap, has: trap, ownKeys: trap, getOwnPropertyDescriptor: trap, getPrototypeOf: trap });
  const garbage = [undefined, null, 0, NaN, 1n, Symbol('s'), '', 'x', [], {}, proxy, { content: proxy }, { content: [proxy] }, { content: deep }, { content: [{ type: 'text', text: proxy }] },
    { content: [{ type: 'image', data: proxy, mimeType: 'image/png' }] }, { structuredContent: proxy }, { isError: proxy }, Object.defineProperty({}, 'content', { get: trap }),
    { content: [{ type: 'resource', resource: proxy }] }, { content: [{ type: 'resource_link', uri: proxy }] }, { content: [Object.defineProperty({}, 'type', { get: trap })] }];
  let calls = 0;
  for (const [index, raw] of garbage.entries()) {
    let limited;
    assert.doesNotThrow(() => { limited = limitToolResult(raw); }, `garbage ${index}`);
    assert.ok(Array.isArray(limited.result.content) && Array.isArray(limited.notes), `garbage ${index}`);
    calls += 1;
  }
  ok(`totality: ${calls} garbage results (proxies, throwing getters, 100,000-deep content) never throw and always give a content list and notes`);
}

console.log(`PASS: ${checks} MCP result limit checks`);
