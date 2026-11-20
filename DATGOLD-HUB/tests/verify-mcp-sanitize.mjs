// lib/mcp/sanitize.mjs: what of an MCP server's lists may reach the model or an approval dialog (P2 slice C1, plan task ext-13).
//
//  1. names: the character set [A-Za-z0-9_.-], 1-256 characters, three reserved words; a bad name is refused with a reason, never rewritten
//  2. text (descriptions, titles): the hidden classes are removed BEFORE the cut, the cut is by UTF-8 bytes at a code point, the marker fits inside the limit
//  3. property tests over seeded random Unicode (astral, lone surrogates, every removed class): never throws, never over the limit, never a removed class
//  4. input schemas: depth 32, 64 KB, plain JSON only, no __proto__, no hidden characters in keys or values, local $ref only, cycles end
//  5. annotations: only the four known booleans, own properties only
//  6. tools, prompts, resources and lists: the refusal names the field; duplicates; the item cap; sanitizing twice changes nothing
//  7. totality: a corpus of garbage through every export never throws
//  8. timing: 10,000 calls on 2 KB inputs and 1 MB inputs stay under the stated budgets
import assert from 'node:assert/strict';
import {
  LIMITS, checkName, checkSchema, copyJson, cutToBytes, preview, sanitizeAnnotations, sanitizeList, sanitizePrompt, sanitizeResource, sanitizeText,
  sanitizeTool, stripHidden,
} from '../lib/mcp/sanitize.mjs';

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
setTimeout(() => { console.error('FAIL: the MCP sanitize suite exceeded its own time budget'); process.exit(2); }, 150_000).unref();

const bytes = (text) => Buffer.byteLength(text, 'utf8');
const cp = (...points) => String.fromCodePoint(...points);
const hex = (point) => point.toString(16).toUpperCase().padStart(4, '0');
const REMOVED = '[DatGold: invisible or control characters removed]';
const CUT = '[DatGold: cut to 2048 bytes]';
const BOTH = '[DatGold: invisible or control characters removed; cut to 2048 bytes]';
const RESERVE = bytes(` ${BOTH}`);
const KEPT = 2048 - RESERVE;

// The classes the task names, written out here independently of the module: C0 except tab and newline, DEL and C1, the bidirectional
// embeddings, overrides and isolates, the zero-width characters, the tag block, and any surrogate code unit that is not half of a pair.
function namedClass(point) {
  if (point <= 0x1f) return point !== 0x09 && point !== 0x0a ? 'C0' : null;
  if (point >= 0x7f && point <= 0x9f) return 'C1';
  if ((point >= 0x202a && point <= 0x202e) || (point >= 0x2066 && point <= 0x2069)) return 'bidi';
  if ([0x200b, 0x200c, 0x200d, 0x2060, 0xfeff].includes(point)) return 'zero-width';
  if (point >= 0xe0000 && point <= 0xe007f) return 'tag';
  if (point >= 0xd800 && point <= 0xdfff) return 'lone surrogate';
  return null;
}
// The wider set the module removes (every Cc and Cf code point plus the invisible fillers and variation selectors), used for the prefix property.
const WIDER = /(?![\t\n])[\p{Cc}\p{Cf}\u034F\u115F\u1160\u17B4\u17B5\u180B-\u180F\u3164\uFE00-\uFE0F\uFFA0\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}\uD800-\uDFFF]/gu;
const independentClean = (text) => text.replace(/\r\n/g, '\n').replace(WIDER, '');
function firstNamed(text) {
  for (const char of text) {
    const label = namedClass(char.codePointAt(0));
    if (label) return `${label} U+${hex(char.codePointAt(0))}`;
  }
  return null;
}

// ------------------------------------------------------------------ 1. names
{
  for (const name of ['read_file', 'a', 'A-Z.0_9', 'x'.repeat(256), 'git.status', '...', '-', 'Read_File-2']) assert.deepEqual(checkName(name), { ok: true, name });
  const refused = (value, reason, options) => {
    const result = checkName(value, options);
    assert.equal(result.ok, false, `${preview(value)} must be refused`);
    assert.equal(result.reason, reason, `${preview(value)}: ${result.reason}`);
    assert.equal(typeof result.preview, 'string');
    return result;
  };
  refused('x'.repeat(257), 'name_too_long');
  refused('', 'name_empty');
  for (const value of [undefined, null, 42, {}, [], true, Symbol('s'), 1n]) refused(value, 'name_not_a_string');
  for (const bad of ['read file', 'read/file', 'read:file', 'r\u00e9ad', 'read\u200Bfile', 'read\u202Efile', `read${cp(0xe0041)}`, 'tab\there', 'new\nline', 'a\u0000b', '\uD800',
    `emoji${cp(0x1f600)}`, 'semi;colon', 'quote"', 'back\\slash', 'read\u00A0file']) refused(bad, 'name_bad_characters');
  for (const reserved of ['__proto__', 'constructor', 'prototype']) refused(reserved, 'name_reserved');
  assert.equal(checkName('read\u200Bfile').preview, 'read\\u{200B}file', 'the preview spells a hidden character out');
  assert.equal(checkName('a\\b c').preview, 'a\\\\b c', 'a backslash is doubled in the preview, so an escape cannot be faked');
  const long = checkName('\u00e9'.repeat(1000));
  assert.ok(long.preview.length <= 80 && long.preview.endsWith('...'), long.preview);
  refused('abcd', 'name_too_long', { maxLength: 3 });
  assert.deepEqual(checkName('abc', { maxLength: 3 }), { ok: true, name: 'abc' });
  for (const maxLength of [0, -1, 1.5, '256', NaN, 100_000]) refused('abc', 'bad_limit', { maxLength });
  const started = performance.now();
  refused('a'.repeat(10_000_000), 'name_too_long');
  refused(`${'a'.repeat(200)} `, 'name_bad_characters');
  assert.ok(performance.now() - started < 200, 'a 10 MB name is refused by its length before the pattern runs');
  assert.equal(LIMITS.nameMaxLength, 256);
  ok('names: [A-Za-z0-9_.-]{1,256}, reserved words refused, a refusal names the reason and an escaped preview, never a rewrite');
}

// ------------------------------------------------------------------ 2. text
{
  const plain = 'Reads a file from the workspace.\n\tTabs and newlines stay, and so does caf\u00e9, \u20ac and \u{1F600}.';
  assert.deepEqual(sanitizeText(plain), { ok: true, text: plain, removed: 0, cut: false });
  assert.deepEqual(sanitizeText(''), { ok: true, text: '', removed: 0, cut: false });
  assert.equal(LIMITS.textMaxBytes, 2048);

  const classes = {
    C0: [0x00, 0x01, 0x08, 0x0b, 0x0c, 0x0e, 0x1b, 0x1f], DEL: [0x7f], C1: [0x80, 0x85, 0x9f],
    bidi: [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200e, 0x200f, 0x061c],
    'zero-width': [0x200b, 0x200c, 0x200d, 0x2060, 0xfeff], tags: [0xe0000, 0xe0001, 0xe0002, 0xe0041, 0xe007f],
    other: [0x00ad, 0x034f, 0x180e, 0x180b, 0xfe00, 0xfe0f, 0xe0100, 0xe01ef, 0x115f, 0x1160, 0x3164, 0xffa0, 0x17b4, 0x2062, 0x206a, 0xfff9, 0x1d173],
  };
  let count = 0;
  for (const [label, points] of Object.entries(classes)) {
    for (const point of points) {
      assert.deepEqual(sanitizeText(`ab${cp(point)}cd`), { ok: true, text: `abcd ${REMOVED}`, removed: 1, cut: false }, `${label} U+${hex(point)}`);
      count += 1;
    }
  }
  for (const [input, text, removed] of [['ab\uD800cd', 'abcd', 1], ['ab\uDC00cd', 'abcd', 1], ['ab\uDBFF', 'ab', 1], ['\uDC00\uD800x', 'x', 2]]) {
    assert.deepEqual(sanitizeText(input), { ok: true, text: `${text} ${REMOVED}`, removed, cut: false }, `lone surrogates in ${JSON.stringify(input)}`);
  }
  assert.deepEqual(sanitizeText('\u200B\u200B'), { ok: true, text: REMOVED, removed: 2, cut: false }, 'a text that was only hidden characters is the marker alone');
  assert.deepEqual(sanitizeText('a\r\nb\r\n'), { ok: true, text: 'a\nb\n', removed: 0, cut: false }, 'CRLF becomes LF without a marker');
  assert.deepEqual(sanitizeText('a\rb'), { ok: true, text: `ab ${REMOVED}`, removed: 1, cut: false }, 'a lone CR is a control character');
  assert.deepEqual(sanitizeText('a\r\r\nb'), { ok: true, text: `a\nb ${REMOVED}`, removed: 1, cut: false }, 'only the CR of a CRLF is not counted');
  assert.deepEqual(sanitizeText(`a${'\u200B'.repeat(5)}${cp(0xe0041).repeat(3)}\u202Eb`), { ok: true, text: `ab ${REMOVED}`, removed: 9, cut: false }, 'a run counts its code points');
  ok(`text: ${count} hidden code points of ${Object.keys(classes).length} classes and lone surrogates removed, tab/newline kept, CRLF folded silently`);

  // the cut
  assert.deepEqual(sanitizeText('x'.repeat(2048)), { ok: true, text: 'x'.repeat(2048), removed: 0, cut: false }, 'exactly 2048 bytes is not cut');
  assert.deepEqual(sanitizeText('x'.repeat(2049)), { ok: true, text: `${'x'.repeat(KEPT)} ${CUT}`, removed: 0, cut: true });
  assert.deepEqual(sanitizeText('x'.repeat(1_000_000)), { ok: true, text: `${'x'.repeat(KEPT)} ${CUT}`, removed: 0, cut: true });
  for (const char of ['\u00e9', '\u20ac', '\u{1F600}', '\u{10FFFF}']) {
    const width = bytes(char);
    const result = sanitizeText(char.repeat(3000));
    const body = result.text.slice(0, -(CUT.length + 1));
    assert.equal(body, char.repeat(Math.floor(KEPT / width)), `the cut keeps whole ${width}-byte characters only`);
    assert.ok(result.text.isWellFormed() && bytes(result.text) <= 2048);
  }
  // removal happens before the cut: hidden characters never use up the budget
  const interleaved = 'ab\u200B'.repeat(4000);
  const cleanedInterleaved = 'ab'.repeat(4000);
  const both = sanitizeText(interleaved);
  assert.equal(both.text, `${cleanedInterleaved.slice(0, KEPT)} ${BOTH}`);
  assert.ok(both.cut && both.removed > 0);
  const huge = `${'\u200B'.repeat(500_000)}Reads a file.${cp(0xe0041).repeat(100_000)}`;
  assert.deepEqual(sanitizeText(huge), { ok: true, text: `Reads a file. ${REMOVED}`, removed: 600_000, cut: false }, 'a 1 MB description of hidden characters around a short text');
  assert.equal(sanitizeText(`${'x'.repeat(2047)}${'\u200B'.repeat(10)}`).text, `${'x'.repeat(KEPT)} ${CUT}`, 'text that fits only without its marker is cut to make room for it');
  assert.equal(sanitizeText('x'.repeat(400), { maxBytes: 200 }).text, `${'x'.repeat(200 - bytes(' [DatGold: invisible or control characters removed; cut to 200 bytes]'))} [DatGold: cut to 200 bytes]`);
  assert.deepEqual(sanitizeText('x'.repeat(128), { maxBytes: 128 }), { ok: true, text: 'x'.repeat(128), removed: 0, cut: false }, 'the smallest limit is 128 bytes, room for the longest marker');
  assert.ok(bytes(sanitizeText('\u200B'.repeat(10) + 'x'.repeat(500), { maxBytes: 128 }).text) <= 128);
  assert.deepEqual(sanitizeText('x', null), { ok: true, text: 'x', removed: 0, cut: false }, 'null options are the defaults');
  for (const maxBytes of [127, 0, -1, 1.5, '2048', NaN, 2 ** 40]) assert.deepEqual(sanitizeText('x', { maxBytes }), { ok: false, reason: 'bad_limit' }, `maxBytes ${String(maxBytes)}`);
  for (const value of [undefined, null, 42, {}, [], Symbol('s'), 10n, () => 'x', new String('x')]) assert.deepEqual(sanitizeText(value), { ok: false, reason: 'not_a_string' });
  ok(`text: cut at 2048 UTF-8 bytes including the marker (${RESERVE} bytes reserved), whole code points only, removal before the cut, limits checked`);

  assert.deepEqual(stripHidden('a\u200Bb\r\nc\u001b[31m'), { ok: true, text: 'ab\nc[31m', removed: 2 });
  assert.equal(stripHidden('x'.repeat(1_000_000)).text.length, 1_000_000, 'stripHidden never cuts');
  assert.deepEqual(stripHidden(42), { ok: false, reason: 'not_a_string' });
  assert.equal(cutToBytes('\u{1F600}'.repeat(10), 5), '\u{1F600}');
  assert.equal(cutToBytes('\u{1F600}'.repeat(10), 3), '');
  assert.equal(cutToBytes('abc', 3), 'abc');
  assert.equal(cutToBytes('abc', 2), 'ab');
  assert.equal(cutToBytes('a\uD800b', 4), 'a\uD800', 'a lone surrogate counts as the three bytes of U+FFFD');
  assert.equal(cutToBytes('a\uD800b', 3), 'a');
  assert.equal(cutToBytes('', 0), '');
  assert.equal(cutToBytes('x'.repeat(10), 0), '');
  for (const [value, limit] of [[42, 10], ['abc', -1], ['abc', NaN], ['abc', '2'], [null, 5]]) assert.equal(cutToBytes(value, limit), '', `${preview(value)} / ${String(limit)}`);
  const longCut = cutToBytes('\u00e9'.repeat(5_000_000), 8 * 1024 * 1024);
  assert.equal(longCut.length, 4 * 1024 * 1024);
  ok('stripHidden removes without cutting; cutToBytes cuts a prefix by bytes at a code point and is total');
}

// ------------------------------------------------------------------ 3. property tests
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const SEED = 0x5eed2c1;
const CASES = 6000;
{
  const random = mulberry32(SEED);
  const pick = (low, high) => low + Math.floor(random() * (high - low + 1));
  const POOLS = [
    () => String.fromCharCode(pick(0x20, 0x7e)), () => String.fromCharCode(pick(0x20, 0x7e)), () => String.fromCharCode(pick(0x20, 0x7e)),
    () => ['\t', '\n', '\r', '\r\n'][pick(0, 3)],
    () => String.fromCharCode(pick(0x00, 0x1f)), () => String.fromCharCode(pick(0x7f, 0x9f)),
    () => String.fromCharCode([0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200e, 0x200f, 0x061c][pick(0, 11)]),
    () => String.fromCharCode([0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x00ad, 0x180e][pick(0, 6)]),
    () => cp(pick(0xe0000, 0xe007f)), () => cp(pick(0xe0100, 0xe01ef)), () => String.fromCharCode(pick(0xfe00, 0xfe0f)),
    () => String.fromCharCode(pick(0xa0, 0x7ff)), () => { const point = pick(0x800, 0xffff); return point >= 0xd800 && point <= 0xdfff ? '\u4e2d' : String.fromCharCode(point); },
    () => cp(pick(0x10000, 0x10ffff)), () => cp(pick(0x1f600, 0x1f64f)),
    () => String.fromCharCode(pick(0xd800, 0xdbff)), () => String.fromCharCode(pick(0xdc00, 0xdfff)),
    () => String.fromCharCode([0x2028, 0x2029, 0x00a0, 0x3000, 0x0301][pick(0, 4)]),
  ];
  const VISIBLE = [POOLS[0], POOLS[1], () => ['\t', '\n', '\r\n'][pick(0, 2)], POOLS[11], POOLS[12], POOLS[13], POOLS[14], POOLS[17]];
  assert.ok(VISIBLE.every((draw) => typeof draw === 'function'));
  let total = 0;
  let cut = 0;
  let removedCases = 0;
  let identical = 0;
  for (let index = 0; index < CASES; index += 1) {
    const length = pick(0, index % 10 === 0 ? 3000 : 900);
    let input = '';
    const bias = pick(0, POOLS.length - 1);
    // every fifth text is drawn from visible characters only (ASCII, tab/newline/CRLF, 2-, 3- and 4-byte characters), so the identity property is exercised
    const pool = index % 5 === 1 ? () => VISIBLE[pick(0, VISIBLE.length - 1)]() : () => (random() < 0.3 ? POOLS[bias] : POOLS[pick(0, POOLS.length - 1)])();
    for (let i = 0; i < length; i += 1) input += pool();
    const maxBytes = index % 3 === 0 ? 2048 : pick(128, 4096);
    let result;
    assert.doesNotThrow(() => { result = sanitizeText(input, { maxBytes }); }, `case ${index}`);
    total += 1;
    const where = `seed ${SEED.toString(16)} case ${index} (maxBytes ${maxBytes}, input ${JSON.stringify(input.slice(0, 40))}...)`;
    assert.equal(result.ok, true, where);
    assert.ok(bytes(result.text) <= maxBytes, `${where}: ${bytes(result.text)} bytes`);
    assert.ok(result.text.isWellFormed(), `${where}: not well-formed`);
    assert.equal(firstNamed(result.text), null, `${where}: a removed class is still there`);
    const clean = independentClean(input);
    const marker = result.cut || result.removed > 0;
    const markerPattern = /( |^)\[DatGold: (?:invisible or control characters removed|cut to \d+ bytes|invisible or control characters removed; cut to \d+ bytes)\]$/;
    assert.equal(markerPattern.test(result.text), marker, `${where}: the marker is there exactly when something was cut or removed`);
    const body = marker ? result.text.replace(markerPattern, '') : result.text;
    assert.ok(clean.startsWith(body), `${where}: the kept text is a prefix of the cleaned text`);
    assert.equal(result.cut, body.length < clean.length, `${where}: cut says whether cleaned text was left out`);
    if (clean === input.replace(/\r\n/g, '\n') && bytes(clean) <= maxBytes) {
      assert.deepEqual(result, { ok: true, text: clean, removed: 0, cut: false }, `${where}: a clean text that fits comes back as it is`);
      identical += 1;
    }
    if (result.cut) cut += 1;
    if (result.removed) removedCases += 1;
  }
  assert.equal(total, CASES);
  assert.ok(cut > 300 && removedCases > 3000 && identical > 50, `the generator must reach every branch: cut ${cut}, removed ${removedCases}, identical ${identical}`);
  ok(`property: seed 0x${SEED.toString(16)}, ${CASES} random texts (${cut} cut, ${removedCases} with removals, ${identical} unchanged): never throws, never over the limit, well-formed, no removed class, a prefix of the cleaned text`);

  // names: the property is the pattern, checked against a regular expression written here
  let accepted = 0;
  for (let index = 0; index < 3000; index += 1) {
    const length = pick(0, index % 50 === 0 ? 300 : 12);
    let name = '';
    for (let i = 0; i < length; i += 1) name += random() < 0.8 ? 'aZ09_.-'[pick(0, 6)] : POOLS[pick(0, POOLS.length - 1)]();
    const expected = /^[A-Za-z0-9_.-]{1,256}$/.test(name) && !['__proto__', 'constructor', 'prototype'].includes(name);
    assert.equal(checkName(name).ok, expected, `name ${JSON.stringify(name)}`);
    if (expected) accepted += 1;
  }
  assert.ok(accepted > 500 && accepted < 2900, `names accepted: ${accepted}`);
  ok(`property: 3000 random names (${accepted} accepted) are accepted exactly when they match [A-Za-z0-9_.-]{1,256} and are not reserved`);
}

// ------------------------------------------------------------------ 4. input schemas
const base = () => ({ type: 'object', properties: { path: { type: 'string', description: 'The file.' }, mode: { type: 'string', enum: ['soft', 'hard'] } }, required: ['path'] });
{
  const input = base();
  const result = checkSchema(input);
  assert.equal(result.ok, true);
  assert.deepEqual(result.schema, input);
  assert.notEqual(result.schema, input, 'the schema is a copy');
  assert.equal(result.bytes, bytes(JSON.stringify(input)));
  result.schema.properties.path.type = 'number';
  assert.equal(input.properties.path.type, 'string', 'changing the copy leaves the input alone');
  assert.deepEqual([LIMITS.schemaMaxBytes, LIMITS.schemaMaxDepth], [65536, 32]);

  const chain = (depth) => { let node = {}; for (let i = 2; i < depth; i += 1) node = { n: node }; return depth === 1 ? { type: 'object' } : { type: 'object', n: node }; };
  assert.equal(checkSchema(chain(1)).ok, true);
  assert.equal(checkSchema(chain(32)).ok, true, 'depth 32 is allowed');
  const deep = checkSchema(chain(33));
  assert.equal(deep.reason, 'schema_too_deep');
  assert.equal(deep.path, `/${Array(32).fill('n').join('/')}`, 'the refusal says where: the 33rd container, under 32 keys');
  assert.equal(checkSchema({ type: 'object', a: [[[[]]]] }, { maxDepth: 5 }).ok, true);
  assert.equal(checkSchema({ type: 'object', a: [[[[[]]]]] }, { maxDepth: 5 }).reason, 'schema_too_deep', 'arrays count as levels');

  const sized = (total) => {
    const shell = bytes(JSON.stringify({ type: 'object', pad: '' }));
    return { type: 'object', pad: 'd'.repeat(total - shell) };
  };
  assert.deepEqual([checkSchema(sized(65536)).ok, checkSchema(sized(65536)).bytes], [true, 65536], 'exactly 64 KB is allowed');
  assert.equal(checkSchema(sized(65537)).reason, 'schema_too_large');
  assert.equal(checkSchema(sized(100), { maxBytes: 100 }).ok, true);
  assert.equal(checkSchema(sized(101), { maxBytes: 100 }).reason, 'schema_too_large');
  assert.equal(checkSchema({ type: 'object', pad: '\u20ac'.repeat(21_846) }).reason, 'schema_too_large', 'the size is counted in UTF-8 bytes');
  for (const options of [{ maxBytes: 0 }, { maxBytes: -1 }, { maxDepth: 0 }, { maxDepth: 1.5 }, { maxBytes: 'x' }, { maxDepth: 10_000 }]) {
    assert.equal(checkSchema(base(), options).reason, 'bad_limit', JSON.stringify(options));
  }
  let started = performance.now();
  assert.equal(checkSchema({ type: 'object', pad: 'x'.repeat(50_000_000) }).reason, 'schema_too_large');
  assert.ok(performance.now() - started < 300, 'a 50 MB string is refused by its length');
  ok('schemas: a copy, exact byte count, depth 32 and 64 KB inclusive, refused one over, arrays count, the path of a refusal');

  const nonJson = [['undefined', undefined], ['function', () => 1], ['NaN', NaN], ['Infinity', -Infinity], ['bigint', 1n], ['symbol', Symbol('s')], ['Date', new Date(0)],
    ['Map', new Map()], ['class instance', new (class Thing {})()], ['sparse array', [, 1]], ['RegExp', /x/], ['typed array', new Uint8Array(2)]]; // eslint-disable-line no-sparse-arrays
  for (const [label, value] of nonJson) assert.equal(checkSchema({ type: 'object', bad: value }).reason, 'schema_not_json', label);
  assert.equal(checkSchema(Object.assign(Object.create(null), { type: 'object' })).ok, true, 'an object without a prototype is plain JSON');
  const proto = checkSchema(JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}}}'));
  assert.deepEqual([proto.reason, proto.path], ['schema_reserved_key', '/properties/__proto__']);
  assert.equal({}.type, undefined, 'nothing reached Object.prototype');
  const badKey = checkSchema({ type: 'object', properties: { 'pa\u200Bth': { type: 'string' } } });
  assert.deepEqual([badKey.reason, badKey.path], ['schema_bad_key', '/properties/pa\\u{200B}th']);
  const badString = checkSchema({ type: 'object', properties: { mode: { enum: ['read', 'wr\u202Eite'] } } });
  assert.deepEqual([badString.reason, badString.path], ['schema_bad_string', '/properties/mode/enum/1']);
  assert.equal(checkSchema({ type: 'object', properties: { m: { const: `x${cp(0xe0041)}` } } }).reason, 'schema_bad_string', 'tag characters in a value');
  assert.equal(checkSchema({ type: 'object', properties: { m: { default: 'a\tb\nc' } } }).ok, true, 'tab and newline are allowed in values');

  const dirty = checkSchema({ type: 'object', properties: { p: { type: 'string', description: `Pa\u200Bth${cp(0xe0041)}`, title: 'T\u202Eitle' }, q: { description: 'q'.repeat(10_000) } } });
  assert.equal(dirty.ok, true);
  assert.equal(dirty.schema.properties.p.description, `Path ${REMOVED}`, 'a description inside the schema is cleaned');
  assert.equal(dirty.schema.properties.p.title, `Title ${REMOVED}`, 'a title inside the schema is cleaned');
  assert.equal(dirty.schema.properties.q.description, `${'q'.repeat(KEPT)} ${CUT}`, 'and cut to 2 KB');
  assert.deepEqual(checkSchema({ type: 'object', properties: { description: { type: 'string' }, title: { type: 'number' } } }).schema,
    { type: 'object', properties: { description: { type: 'string' }, title: { type: 'number' } } }, 'parameters named description and title are schemas, not text');

  const remote = checkSchema({ type: 'object', properties: { a: { $ref: 'https://evil.example/schema.json' } } });
  assert.deepEqual([remote.reason, remote.path], ['schema_remote_ref', '/properties/a/$ref']);
  assert.equal(checkSchema({ type: 'object', properties: { a: { $ref: 'file:///C:/x.json#/a' } } }).reason, 'schema_remote_ref');
  assert.equal(checkSchema({ type: 'object', properties: { a: { $ref: '#/$defs/a' } }, $defs: { a: { type: 'string' } } }).ok, true);
  started = performance.now();
  const cycle = checkSchema({ type: 'object', properties: { node: { $ref: '#/$defs/a' } }, $defs: { a: { $ref: '#/$defs/b' }, b: { $ref: '#/$defs/a' }, self: { $ref: '#' } } });
  assert.equal(cycle.ok, true, 'a $ref cycle is legal JSON Schema; it is never resolved, so it cannot hang');
  assert.deepEqual(cycle.schema.$defs.a, { $ref: '#/$defs/b' });
  assert.ok(performance.now() - started < 50);
  ok('schemas: non-JSON values, __proto__, hidden characters in keys and values refused; descriptions inside cleaned; remote $ref refused, $ref cycles end');

  for (const value of [undefined, null]) assert.equal(checkSchema(value).reason, 'schema_missing');
  for (const value of ['x', 42, [], true, () => 1]) assert.equal(checkSchema(value).reason, 'schema_not_object');
  assert.equal(checkSchema({ type: 'string' }).reason, 'schema_not_object_type');
  assert.equal(checkSchema({}).reason, 'schema_not_object_type');
  assert.equal(checkSchema({ type: ['object'] }).reason, 'schema_not_object_type');
  const getter = { type: 'object' };
  Object.defineProperty(getter, 'bad', { enumerable: true, get() { throw new Error('boom'); } });
  assert.equal(checkSchema(getter).reason, 'schema_unreadable');
  assert.equal(checkSchema(new Proxy({ type: 'object' }, { ownKeys() { throw new Error('proxy'); } })).reason, 'schema_unreadable');
  const loop = { type: 'object' };
  loop.self = loop;
  started = performance.now();
  assert.equal(checkSchema(loop).reason, 'schema_too_deep', 'an object that contains itself ends at the depth limit');
  let dag = {};
  for (let i = 0; i < 29; i += 1) dag = { a: dag, b: dag };
  assert.equal(checkSchema({ type: 'object', d: dag }).reason, 'schema_too_large', 'a shared-reference graph of 2^29 leaves ends at the size limit');
  assert.ok(performance.now() - started < 300);
  ok('schemas: missing, not an object, not type "object", throwing getters and proxies, self-containing and exponential graphs all refused fast');

  const copied = copyJson({ a: [1, 'two', null, true, { b: -0 }] });
  assert.deepEqual(copied, { ok: true, value: { a: [1, 'two', null, true, { b: 0 }] }, bytes: bytes(JSON.stringify({ a: [1, 'two', null, true, { b: 0 }] })) });
  const pollution = copyJson(JSON.parse('{"__proto__":{"polluted":1},"x":1}'));
  assert.equal(pollution.ok, true);
  assert.ok(Object.hasOwn(pollution.value, '__proto__'), '__proto__ stays an own property of the copy');
  assert.equal(Object.getPrototypeOf(pollution.value), Object.prototype);
  assert.equal({}.polluted, undefined);
  assert.equal(copyJson({ a: 'x'.repeat(100) }, { maxBytes: 50 }).reason, 'too_large');
  assert.equal(copyJson([[[[]]]], { maxDepth: 3 }).reason, 'too_deep');
  assert.equal(copyJson({ a: undefined }).reason, 'not_json');
  assert.equal(copyJson(getter).reason, 'unreadable');
  assert.deepEqual(copyJson('text'), { ok: true, value: 'text', bytes: 6 });
  assert.equal(copyJson(1, { maxBytes: -1 }).reason, 'bad_limit');
  ok('copyJson: a bounded copy of plain JSON with its byte count; __proto__ cannot pollute; the same refusals');
}

// ------------------------------------------------------------------ 5. annotations
{
  const all = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  assert.deepEqual(sanitizeAnnotations(all), { annotations: all, dropped: [] });
  assert.deepEqual(sanitizeAnnotations({ readOnlyHint: 'true', title: 'Delete', destructiveHint: 1, extra: { deep: true } }),
    { annotations: {}, dropped: ['readOnlyHint', 'destructiveHint', 'title', 'extra'] });
  assert.deepEqual(sanitizeAnnotations({ openWorldHint: true, 'x\u200By': 1 }), { annotations: { openWorldHint: true }, dropped: ['x\\u{200B}y'] });
  for (const value of [undefined, null]) assert.deepEqual(sanitizeAnnotations(value), { annotations: {}, dropped: [] });
  for (const value of ['x', 42, [], true]) assert.deepEqual(sanitizeAnnotations(value), { annotations: {}, dropped: ['(not an object)'] });
  Object.prototype.destructiveHint = false; // eslint-disable-line no-extend-native
  try {
    assert.deepEqual(sanitizeAnnotations({}), { annotations: {}, dropped: [] }, 'an inherited property is not an annotation');
  } finally { delete Object.prototype.destructiveHint; }
  assert.deepEqual(sanitizeAnnotations(JSON.parse('{"__proto__":{"readOnlyHint":true}}')), { annotations: {}, dropped: ['__proto__'] });
  const getter = {};
  Object.defineProperty(getter, 'readOnlyHint', { enumerable: true, get() { throw new Error('boom'); } });
  assert.deepEqual(sanitizeAnnotations(getter), { annotations: {}, dropped: ['(unreadable)'] });
  const many = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, i]));
  assert.equal(sanitizeAnnotations(many).dropped.length, 16, 'at most 16 dropped keys are named');
  ok('annotations: only the four known booleans, own properties only, the rest named as dropped (at most 16)');
}

// ------------------------------------------------------------------ 6. tools, prompts, resources, lists
const goodTool = () => ({
  name: 'read_file', title: 'Read file', description: 'Reads a file.', inputSchema: base(), annotations: { readOnlyHint: true, title: 'Read' },
  outputSchema: { type: 'object' }, _meta: { x: 1 }, icons: [{ src: 'https://example.invalid/a.png' }],
});
{
  assert.deepEqual(sanitizeTool(goodTool()), {
    ok: true,
    item: { name: 'read_file', title: 'Read file', description: 'Reads a file.', inputSchema: base(), annotations: { readOnlyHint: true } },
    notes: [{ field: 'annotations', dropped: ['title'] }],
  });
  const bare = sanitizeTool({ name: 'x', inputSchema: { type: 'object' } });
  assert.deepEqual(bare, { ok: true, item: { name: 'x', description: '', inputSchema: { type: 'object' }, annotations: {} }, notes: [] });
  assert.equal(Object.hasOwn(bare.item, 'title'), false, 'no title means no title key');
  assert.deepEqual(sanitizeTool({ name: 'x', title: null, description: null, inputSchema: { type: 'object' } }).item, bare.item, 'null is absent');
  const dirty = sanitizeTool({ name: 'x', title: 'T\u200B', description: `Reads${cp(0xe0041, 0xe0042)} a file.${'!'.repeat(3000)}`, inputSchema: { type: 'object' } });
  assert.equal(dirty.ok, true);
  assert.equal(dirty.item.title, `T ${REMOVED}`);
  assert.ok(bytes(dirty.item.description) <= 2048 && dirty.item.description.endsWith(BOTH));
  assert.deepEqual(dirty.notes, [{ field: 'title', removed: 1, cut: false }, { field: 'description', removed: 2, cut: true }]);
  assert.deepEqual(sanitizeTool({ name: 'x', description: 'y'.repeat(3000), inputSchema: { type: 'object' } }).notes, [{ field: 'description', removed: 0, cut: true }], 'a cut alone is noted too');

  const refusal = (value, reason, field) => {
    const result = sanitizeTool(value);
    assert.equal(result.ok, false, `${field} must refuse`);
    assert.deepEqual([result.reason, result.field], [reason, field]);
    assert.equal(typeof result.preview, 'string');
    return result;
  };
  for (const value of [null, 42, 'x', [], undefined]) refusal(value, 'not_an_object', '');
  refusal({ inputSchema: { type: 'object' } }, 'name_not_a_string', 'name');
  assert.equal(refusal({ name: 'read file', inputSchema: { type: 'object' } }, 'name_bad_characters', 'name').preview, 'read file');
  refusal({ name: 'x', description: 42, inputSchema: { type: 'object' } }, 'description_not_a_string', 'description');
  refusal({ name: 'x', title: {}, inputSchema: { type: 'object' } }, 'title_not_a_string', 'title');
  refusal({ name: 'x' }, 'schema_missing', 'inputSchema');
  assert.equal(refusal({ name: 'x', inputSchema: { type: 'object', a: { b: undefined } } }, 'schema_not_json', 'inputSchema').path, '/a/b');
  const throwing = { inputSchema: { type: 'object' } };
  Object.defineProperty(throwing, 'name', { enumerable: true, get() { throw new Error('boom'); } });
  refusal(throwing, 'unreadable', '');
  Object.prototype.name = 'polluted'; // eslint-disable-line no-extend-native
  try { refusal({ inputSchema: { type: 'object' } }, 'name_not_a_string', 'name'); } finally { delete Object.prototype.name; }
  ok('tools: the item holds name, title, description, inputSchema, annotations and nothing else; a refusal names reason, field and preview');

  const prompt = { name: 'summarize', description: 'Summarize.', arguments: [{ name: 'text', description: 'The text.', required: true }, { name: 'style', required: 'yes' }], _meta: {} };
  assert.deepEqual(sanitizePrompt(prompt), {
    ok: true,
    item: { name: 'summarize', description: 'Summarize.', arguments: [{ name: 'text', description: 'The text.', required: true }, { name: 'style', description: '', required: false }] },
    notes: [],
  });
  assert.deepEqual(sanitizePrompt({ name: 'p', title: 'P' }), { ok: true, item: { name: 'p', title: 'P', description: '', arguments: [] }, notes: [] });
  const promptRefusal = (value, reason, field) => { const result = sanitizePrompt(value); assert.deepEqual([result.ok, result.reason, result.field], [false, reason, field]); };
  promptRefusal({ name: 'p', arguments: 'x' }, 'arguments_not_an_array', 'arguments');
  promptRefusal({ name: 'p', arguments: Array.from({ length: 65 }, (_, i) => ({ name: `a${i}` })) }, 'too_many_arguments', 'arguments');
  promptRefusal({ name: 'p', arguments: [{ name: 'ok' }, { name: 'bad name' }] }, 'name_bad_characters', 'arguments[1].name');
  promptRefusal({ name: 'p', arguments: [{ name: 'a' }, { name: 'a' }] }, 'duplicate_argument', 'arguments[1].name');
  promptRefusal({ name: 'p', arguments: [null] }, 'argument_not_an_object', 'arguments[0]');
  promptRefusal({ name: 'p', arguments: [{ name: 'a', description: 5 }] }, 'description_not_a_string', 'arguments[0].description');
  promptRefusal({ name: 'p p' }, 'name_bad_characters', 'name');
  const dirtyPrompt = sanitizePrompt({ name: 'p', arguments: [{ name: 'a', description: 'x\u200B' }] });
  assert.deepEqual(dirtyPrompt.notes, [{ field: 'arguments[0].description', removed: 1, cut: false }]);
  assert.equal(sanitizePrompt({ name: 'p', arguments: Array.from({ length: 64 }, (_, i) => ({ name: `a${i}` })) }).ok, true, '64 arguments are allowed');
  ok('prompts: arguments become {name, description, required}; 64 at most, names checked, duplicates refused');

  const resource = { uri: 'file:///workspace/a.txt', name: 'a.txt', title: 'A', description: 'A file', mimeType: 'text/plain', size: 12, _meta: {} };
  assert.deepEqual(sanitizeResource(resource), { ok: true, item: { uri: 'file:///workspace/a.txt', name: 'a.txt', title: 'A', description: 'A file', mimeType: 'text/plain', size: 12 }, notes: [] });
  const named = sanitizeResource({ uri: 'mem://x', name: `My notes\u200B ${'n'.repeat(400)}`, mimeType: 'not a type', size: -1 });
  assert.equal(named.ok, true);
  assert.ok(bytes(named.item.name) <= 256 && named.item.name.startsWith('My notes n'), named.item.name);
  assert.deepEqual(named.item, { uri: 'mem://x', name: named.item.name, description: '' });
  assert.deepEqual(named.notes, [{ field: 'name', removed: 1, cut: true }, { field: 'mimeType', dropped: true }, { field: 'size', dropped: true }]);
  const resourceRefusal = (value, reason, field) => { const result = sanitizeResource(value); assert.deepEqual([result.ok, result.reason, result.field], [false, reason, field], JSON.stringify(result)); };
  resourceRefusal({ name: 'a' }, 'uri_not_a_string', 'uri');
  resourceRefusal({ uri: '', name: 'a' }, 'uri_empty', 'uri');
  resourceRefusal({ uri: `mem://${'x'.repeat(2043)}`, name: 'a' }, 'uri_too_long', 'uri');
  assert.equal(sanitizeResource({ uri: `mem://${'x'.repeat(2042)}`, name: 'a' }).ok, true, 'a URI of 2048 bytes is allowed');
  for (const bad of ['file:///a b', 'mem://a\u200Bb', 'mem://a\u0000', 'mem://\u202E', 'mem://a\nb', 'mem://\uD800']) resourceRefusal({ uri: bad, name: 'a' }, 'uri_bad_characters', 'uri');
  resourceRefusal({ uri: 'mem://a' }, 'name_not_a_string', 'name');
  resourceRefusal({ uri: 'mem://a', name: 'a', description: [] }, 'description_not_a_string', 'description');
  ok('resources: URI 1-2048 bytes without spaces or hidden characters, the name is text cut to 256 bytes, a bad mimeType or size is dropped with a note');

  const list = sanitizeList('tools', [goodTool(), null, { ...goodTool(), name: 'bad name' }, goodTool(), { name: 'second', inputSchema: { type: 'object' }, description: 'x\u200B' }]);
  assert.equal(list.ok, true);
  assert.deepEqual(list.items.map((item) => item.name), ['read_file', 'second']);
  assert.deepEqual(list.refused, [
    { index: 1, reason: 'not_an_object', field: '', preview: 'null' },
    { index: 2, reason: 'name_bad_characters', field: 'name', preview: 'bad name' },
    { index: 3, reason: 'duplicate_name', field: 'name', preview: 'read_file' },
  ]);
  assert.equal(list.refusedCount, 3);
  assert.equal(list.overLimit, 0);
  assert.deepEqual(list.notes, [{ index: 0, field: 'annotations', dropped: ['title'] }, { index: 4, field: 'description', removed: 1, cut: false }]);
  const many = sanitizeList('tools', Array.from({ length: 1005 }, (_, i) => ({ name: `t${i}`, inputSchema: { type: 'object' } })));
  assert.deepEqual([many.items.length, many.overLimit, many.items.at(-1).name], [1000, 5, 't999']);
  assert.equal(LIMITS.maxItems, 1000);
  assert.deepEqual(sanitizeList('tools', [{ name: 'a', inputSchema: { type: 'object' } }, { name: 'b', inputSchema: { type: 'object' } }, { name: 'c', inputSchema: { type: 'object' } }], { maxItems: 2 }).overLimit, 1);
  const bad = sanitizeList('tools', Array.from({ length: 500 }, () => null));
  assert.deepEqual([bad.items.length, bad.refused.length, bad.refusedCount], [0, 100, 500], 'at most 100 refusals are listed, all are counted');
  const resources = sanitizeList('resources', [{ uri: 'mem://a', name: 'a' }, { uri: 'mem://a', name: 'b' }, { uri: 'mem://b', name: 'a' }]);
  assert.deepEqual([resources.items.length, resources.refused[0].reason, resources.refused[0].field], [2, 'duplicate_uri', 'uri']);
  const prompts = sanitizeList('prompts', [{ name: 'p' }, { name: 'p' }]);
  assert.deepEqual([prompts.items.length, prompts.refused[0].reason], [1, 'duplicate_name']);
  assert.deepEqual(sanitizeList('widgets', []), { ok: false, reason: 'unknown_kind' });
  assert.deepEqual(sanitizeList('tools', { length: 3 }), { ok: false, reason: 'list_not_an_array' });
  assert.deepEqual(sanitizeList('__proto__', []), { ok: false, reason: 'unknown_kind' });
  assert.equal(sanitizeList('tools', [], { maxItems: 0 }).reason, 'bad_limit');
  ok('lists: refusals with their index (100 listed, all counted), duplicate names and URIs refused, 1000 items at most, notes carry the index');

  // idempotence: what the sanitizer gives back passes through it unchanged
  const random = mulberry32(SEED + 1);
  const pieces = ['Reads ', 'a\u200B', cp(0xe0041), '\u202E', 'file', '\r\n', '\u00e9', cp(0x1f600), '\uD800', ' ', 'x'.repeat(700)];
  const text = () => Array.from({ length: Math.floor(random() * 12) }, () => pieces[Math.floor(random() * pieces.length)]).join('');
  for (let index = 0; index < 500; index += 1) {
    const raw = { name: `t${index}`, title: text(), description: text(), inputSchema: { type: 'object', properties: { p: { description: text(), type: 'string' } } }, annotations: { readOnlyHint: random() < 0.5 } };
    const once = sanitizeTool(raw);
    assert.equal(once.ok, true);
    assert.deepEqual(sanitizeTool(once.item), { ok: true, item: once.item, notes: [] }, `case ${index}`);
  }
  ok('idempotence: 500 random dirty tools, sanitized twice, come back the same with no notes');
}

// ------------------------------------------------------------------ 7. totality
{
  let deepObject = {};
  for (let i = 0; i < 100_000; i += 1) deepObject = { v: deepObject };
  let deepArray = [];
  for (let i = 0; i < 100_000; i += 1) deepArray = [deepArray];
  const throwing = {};
  for (const key of ['name', 'description', 'title', 'inputSchema', 'annotations', 'arguments', 'uri', 'type', 'readOnlyHint', 'maxBytes', 'maxDepth', 'maxLength', 'maxItems']) {
    Object.defineProperty(throwing, key, { enumerable: true, get() { throw new Error(`getter ${key}`); } });
  }
  const trap = () => { throw new Error('proxy trap'); };
  const proxy = new Proxy({}, { get: trap, has: trap, ownKeys: trap, getOwnPropertyDescriptor: trap, getPrototypeOf: trap });
  const garbage = [undefined, null, true, 0, -0, NaN, Infinity, 1n, Symbol('s'), () => {}, '', 'x'.repeat(5_000_000), '\uD800', [], [null], {}, Object.create(null),
    JSON.parse('{"__proto__":{"name":"x","type":"object"}}'), deepObject, deepArray, throwing, proxy, new Date(0), new Map(), /re/, new Uint8Array(4), Promise.resolve(),
    { name: 'x', inputSchema: deepObject }, { name: 'x', inputSchema: proxy }, { name: 'x', inputSchema: { type: 'object' }, annotations: proxy }, { uri: proxy, name: proxy },
    { name: 'p', arguments: [proxy] }, { name: 'p', arguments: deepArray }];
  const functions = {
    checkName, sanitizeText, stripHidden, checkSchema, copyJson, sanitizeAnnotations, sanitizeTool, sanitizePrompt, sanitizeResource, preview,
    cutToBytes: (value) => cutToBytes(value, 10), 'sanitizeList(tools)': (value) => sanitizeList('tools', value), 'sanitizeList(prompts, [v])': (value) => sanitizeList('prompts', [value]),
    'sanitizeList(resources, [v])': (value) => sanitizeList('resources', [value]), 'sanitizeList(v, [])': (value) => sanitizeList(value, []),
    'sanitizeText options': (value) => sanitizeText('x', value), 'checkSchema options': (value) => checkSchema({ type: 'object' }, value), 'checkName options': (value) => checkName('x', value),
    'copyJson options': (value) => copyJson({}, value), 'sanitizeList options': (value) => sanitizeList('tools', [], value), 'cutToBytes limit': (value) => cutToBytes('abc', value),
    'sanitizeText(huge, options)': (value) => sanitizeText('y'.repeat(100_000), value),
  };
  let calls = 0;
  const started = performance.now();
  for (const [label, fn] of Object.entries(functions)) {
    for (const [index, value] of garbage.entries()) {
      let result;
      assert.doesNotThrow(() => { result = fn(value); }, `${label}(garbage ${index})`);
      assert.notEqual(result, undefined, `${label}(garbage ${index}) answered`);
      if (result && typeof result === 'object' && 'ok' in result) assert.equal(typeof result.ok, 'boolean');
      calls += 1;
    }
  }
  assert.equal({}.name, undefined, 'nothing reached Object.prototype');
  ok(`totality: ${calls} calls of ${Object.keys(functions).length} entry points with ${garbage.length} kinds of garbage (100,000-deep values, throwing getters and proxies, 5 MB strings) never throw (${Math.round(performance.now() - started)} ms)`);
}

// ------------------------------------------------------------------ 8. timing
// Budgets: 10,000 calls on 2 KB inputs in 2,500 ms, and each 1 MB input in 300 ms. Measured on the development machine (Windows 11, Node 24.19): about
// 500 ms and at most 35 ms; the margin is for a loaded CI runner.
const BUDGET_SMALL_MS = 2500;
const BUDGET_LARGE_MS = 300;
{
  const random = mulberry32(SEED + 2);
  const inputs = Array.from({ length: 100 }, (_, index) => {
    let text = '';
    while (bytes(text) < 2048) {
      const roll = random();
      text += roll < 0.7 ? 'word ' : roll < 0.8 ? '\u00e9t\u00e9 ' : roll < 0.85 ? '\u{1F600}' : index % 2 ? '\u200B' : cp(0xe0041);
    }
    return text;
  });
  for (let i = 0; i < 200; i += 1) sanitizeText(inputs[i % 100]);
  let started = performance.now();
  for (let i = 0; i < 10_000; i += 1) sanitizeText(inputs[i % 100]);
  const small = performance.now() - started;
  assert.ok(small < BUDGET_SMALL_MS, `10,000 calls on 2 KB inputs took ${Math.round(small)} ms (budget ${BUDGET_SMALL_MS} ms)`);

  const large = {
    'plain ASCII': 'word '.repeat(209_716),
    'all hidden': '\u200B'.repeat(1_048_576),
    'every third hidden': 'ab\u200B'.repeat(349_526),
    'tags then text': `${cp(0xe0041).repeat(262_144)}tail`,
    'multibyte': '\u20ac'.repeat(349_526),
    'hidden with a tail of text': `${'\u202E\u0001'.repeat(524_288)}${'x'.repeat(4000)}`,
  };
  const timings = [];
  for (const [label, input] of Object.entries(large)) {
    started = performance.now();
    const result = sanitizeText(input);
    const elapsed = performance.now() - started;
    assert.ok(result.ok && bytes(result.text) <= 2048);
    assert.ok(elapsed < BUDGET_LARGE_MS, `1 MB input (${label}) took ${Math.round(elapsed)} ms (budget ${BUDGET_LARGE_MS} ms)`);
    timings.push(`${label} ${elapsed.toFixed(1)} ms`);
  }
  started = performance.now();
  const tool = sanitizeTool({ name: 'big', description: 'd\u200B'.repeat(524_288), inputSchema: { type: 'object' } });
  const toolElapsed = performance.now() - started;
  assert.ok(tool.ok && toolElapsed < BUDGET_LARGE_MS, `a tool with a 1 MB description took ${Math.round(toolElapsed)} ms`);
  ok(`timing: 10,000 x 2 KB in ${Math.round(small)} ms (budget ${BUDGET_SMALL_MS}); 1 MB inputs: ${timings.join(', ')}; a tool with a 1 MB description ${toolElapsed.toFixed(1)} ms (budget ${BUDGET_LARGE_MS} each)`);
}

console.log(`PASS: ${checks} MCP sanitize checks`);
