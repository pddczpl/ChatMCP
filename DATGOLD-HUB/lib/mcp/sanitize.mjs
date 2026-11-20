// What of an MCP server's lists may reach the model or an approval dialog (P2 slice C1, part of plan task ext-13; a later slice wires it into the client
// manager and the catalog). Plain data in, plain data out: nothing here talks to a server or imports the MCP SDK.
//
// Every export is total: garbage (null, numbers, huge strings, 100,000-deep objects, throwing getters, proxies, __proto__ keys) gives a refusal with a
// reason, never an exception. Only own properties are read, so a polluted Object.prototype adds nothing. docs/MCP-HARDENING.md says what each function
// guarantees and what it does not.
//
//  - Names: [A-Za-z0-9_.-], 1-128 characters (the tool-name rule of the MCP specification; the client manager reads the same limit), not __proto__, constructor or prototype. A bad name is refused, never rewritten: a rewritten name would ask the
//    server for something other than what the owner approved.
//  - Text (descriptions, titles): hidden characters are removed FIRST, then the text is cut to 2 KB of UTF-8 at a code point (never half of a surrogate
//    pair), and a marker inside the limit says what happened. Hidden = every Cc and Cf code point except tab and newline (C0, DEL, C1, soft hyphen, the
//    bidirectional marks, embeddings, overrides and isolates, the zero-width characters, word joiner, invisible operators, BOM, interlinear annotation, the
//    tag characters), every Default_Ignorable_Code_Point (the invisible fillers, the variation selectors, U+2065, U+FFF0-U+FFF8, the whole block
//    U+E0000-U+E0FFF, assigned or not), and lone surrogates. The CR of a CRLF becomes nothing, and U+2028 / U+2029 become a newline, without a marker.
//  - Input schemas: plain JSON only, 32 levels and 64 KB at most, both counted while walking (a 50 MB string, an object that contains itself or a graph of
//    shared references ends early); no __proto__ key; no hidden character in a key or a string value, except that descriptions and titles inside are cleaned
//    and cut like the text above; $ref, $dynamicRef and $recursiveRef must be local ('#...') and $id must not be an absolute URI. No reference is
//    ever resolved, so a cycle of them cannot hang anything.
//  - Annotations: readOnlyHint, destructiveHint, idempotentHint and openWorldHint, only as own boolean properties; everything else is named as dropped.

export const LIMITS = Object.freeze({
  nameMaxLength: 128,
  textMaxBytes: 2048,
  schemaMaxBytes: 64 * 1024,
  schemaMaxDepth: 32,
  uriMaxBytes: 2048,
  resourceNameMaxBytes: 256,
  maxItems: 1000,
  maxPromptArguments: 64,
  maxListedRefusals: 100,
  maxListedNotes: 100,
});
// The smallest text limit leaves room for the longest marker (69 bytes at 128).
const MIN_TEXT_BYTES = 128;
const MAX_TEXT_BYTES = 1024 * 1024;
const JSON_MAX_BYTES = 8 * 1024 * 1024;
const JSON_MAX_DEPTH = 64;
const MAX_DROPPED_NAMED = 16;

const HIDDEN_CLASS = String.raw`[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\p{Cs}]`;
const NOT_TAB_OR_NEWLINE = String.raw`(?![\t\n])`;
const HIDDEN_RUN = new RegExp(`(?:${NOT_TAB_OR_NEWLINE}${HIDDEN_CLASS})+`, 'gu');
const HIDDEN_ONE = new RegExp(`${NOT_TAB_OR_NEWLINE}${HIDDEN_CLASS}`, 'u');
const URI_BAD = new RegExp(String.raw`\s|${HIDDEN_CLASS}`, 'u');
const LINE_BREAKS = /[\p{Zl}\p{Zp}]/gu;
// The keywords that point somewhere must stay inside the schema; an absolute $id would move the base that every '#...' reference below it resolves against.
// $schema only names a dialect and is never fetched, so it is not checked.
const REFERENCES = new Set(['$ref', '$dynamicRef', '$recursiveRef']);
const ABSOLUTE_URI = /^(?:[A-Za-z][A-Za-z0-9+.-]*:|\/\/)/;
const NAME = /^[A-Za-z0-9_.-]+$/;
const RESERVED_NAMES = new Set(['__proto__', 'constructor', 'prototype']);
const MIME = /^[A-Za-z0-9!#$&^_.+-]{1,64}\/[A-Za-z0-9!#$&^_.+-]{1,64}$/;
const HINTS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'];
const REMOVED_NOTE = 'invisible or control characters removed';

const own = (object, key) => (Object.hasOwn(object, key) ? object[key] : undefined);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const utf8 = (text) => Buffer.byteLength(text, 'utf8');
const isLimit = (value, low, high) => Number.isSafeInteger(value) && value >= low && value <= high;
function option(options, key, fallback) {
  if (options === undefined || options === null) return fallback;
  const value = options[key];
  return value === undefined ? fallback : value;
}

/** An ASCII-only, at most `max`-character picture of a value for a refusal or a log line: hidden and non-ASCII characters are spelled \u{...}. */
export function preview(value, max = 80) {
  try {
    if (typeof value !== 'string') return value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    let out = '';
    for (let index = 0; index < value.length;) {
      const point = value.codePointAt(index);
      index += point > 0xffff ? 2 : 1;
      const piece = point === 0x5c ? '\\\\' : point >= 0x20 && point < 0x7f ? String.fromCharCode(point) : `\\u{${point.toString(16).toUpperCase()}}`;
      if (out.length + piece.length > max - 3) return `${out}...`;
      out += piece;
    }
    return out;
  } catch {
    return 'unreadable';
  }
}

// How many UTF-16 units of `text`, from its start, fit in `room` UTF-8 bytes without splitting a surrogate pair (a lone surrogate counts as U+FFFD, 3 bytes).
function fitUnits(text, room) {
  let used = 0;
  let index = 0;
  while (index < text.length) {
    const unit = text.charCodeAt(index);
    let size = 3;
    let width = 1;
    if (unit < 0x80) size = 1;
    else if (unit < 0x800) size = 2;
    else if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { size = 4; width = 2; }
    }
    if (used + size > room) break;
    used += size;
    index += width;
  }
  return index;
}

/** The longest prefix of `text` that is at most `maxBytes` UTF-8 bytes and does not split a surrogate pair. Anything that is not a string gives ''. */
export function cutToBytes(text, maxBytes) {
  try {
    if (typeof text !== 'string' || !Number.isSafeInteger(maxBytes) || maxBytes < 0) return '';
    if (text.length * 3 <= maxBytes || utf8(text) <= maxBytes) return text;
    return text.slice(0, fitUnits(text, maxBytes));
  } catch {
    return '';
  }
}

function codePoints(text) {
  let count = text.length;
  for (let index = 0; index < text.length - 1; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { count -= 1; index += 1; }
    }
  }
  return count;
}
// How many code points of a run of hidden characters count as removed: the CR of a CRLF is not counted, it only folds the line end.
function countRun(run, input, offset) {
  const crOfCrlf = run.charCodeAt(run.length - 1) === 0x0d && input.charCodeAt(offset + run.length) === 0x0a;
  return codePoints(run) - (crOfCrlf ? 1 : 0);
}

// Removes the hidden runs and keeps at most `budget` bytes of what is left. It stops reading as soon as the budget is full, so the cost of a huge input is
// the hidden characters before that point plus `budget`, not the length of the input.
function cleanPrefix(input, budget) {
  let text = '';
  let used = 0;
  let removed = 0;
  let position = 0;
  while (position < input.length) {
    HIDDEN_RUN.lastIndex = position;
    const match = HIDDEN_RUN.exec(input);
    const end = match ? match.index : input.length;
    if (end > position) {
      const room = budget - used;
      // A UTF-16 unit is at least one byte, so a segment of more than `room` units cannot fit: look at no more of it than could.
      // U+2028 and U+2029 become a newline: one UTF-16 unit for one, so the unit counts below stay true.
      const segment = input.slice(position, end - position > room ? position + room + 1 : end).replace(LINE_BREAKS, '\n');
      const size = utf8(segment);
      if (segment.length < end - position || size > room) return { text: text + segment.slice(0, fitUnits(segment, room)), removed, cut: true };
      text += segment;
      used += size;
    }
    if (!match) break;
    removed += countRun(match[0], input, match.index);
    position = match.index + match[0].length;
  }
  return { text, removed, cut: false };
}

function marker(removed, cut, maxBytes) {
  const parts = [];
  if (removed > 0) parts.push(REMOVED_NOTE);
  if (cut) parts.push(`cut to ${maxBytes} bytes`);
  return `[DatGold: ${parts.join('; ')}]`;
}

/**
 * A description or title as it may be shown: hidden characters removed, then cut to `maxBytes` (default 2048) UTF-8 bytes at a code point, with a marker
 * that fits inside the limit when anything was removed or cut. {ok: true, text, removed, cut} or {ok: false, reason}.
 */
export function sanitizeText(value, options) {
  try {
    if (typeof value !== 'string') return { ok: false, reason: 'not_a_string' };
    const maxBytes = option(options, 'maxBytes', LIMITS.textMaxBytes);
    if (!isLimit(maxBytes, MIN_TEXT_BYTES, MAX_TEXT_BYTES)) return { ok: false, reason: 'bad_limit' };
    const whole = cleanPrefix(value, maxBytes);
    if (!whole.cut && whole.removed === 0) return { ok: true, text: whole.text, removed: 0, cut: false };
    // Something will be said, so make room for the longest thing that can be said and look again.
    const reserve = utf8(` ${marker(1, true, maxBytes)}`);
    const kept = cleanPrefix(value, maxBytes - reserve);
    const note = marker(kept.removed, kept.cut, maxBytes);
    return { ok: true, text: kept.text ? `${kept.text} ${note}` : note, removed: kept.removed, cut: kept.cut };
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
}

/** The hidden characters of `value` removed, nothing cut (for logs such as a server's stderr). {ok: true, text, removed} or {ok: false, reason}. */
export function stripHidden(value) {
  try {
    if (typeof value !== 'string') return { ok: false, reason: 'not_a_string' };
    let removed = 0;
    const text = value.replace(HIDDEN_RUN, (run, offset) => {
      removed += countRun(run, value, offset);
      return '';
    });
    return { ok: true, text: text.replace(LINE_BREAKS, '\n'), removed };
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
}

/** A tool, prompt or argument name: {ok: true, name} or {ok: false, reason, preview}. */
export function checkName(value, options) {
  try {
    const maxLength = option(options, 'maxLength', LIMITS.nameMaxLength);
    const refuse = (reason) => ({ ok: false, reason, preview: preview(value) });
    if (!isLimit(maxLength, 1, 4096)) return refuse('bad_limit');
    if (typeof value !== 'string') return refuse('name_not_a_string');
    if (value.length === 0) return refuse('name_empty');
    if (value.length > maxLength) return refuse('name_too_long');
    if (!NAME.test(value)) return refuse('name_bad_characters');
    if (RESERVED_NAMES.has(value)) return refuse('name_reserved');
    return { ok: true, name: value };
  } catch {
    return { ok: false, reason: 'unreadable', preview: '' };
  }
}

class Stop {
  constructor(reason, path) {
    this.reason = reason;
    this.path = path;
  }
}

// A bounded copy of plain JSON. `depth` is the level of `value` if it is an array or an object (the root is 1). The size is counted as the bytes of its
// JSON text while walking, so the walk ends as soon as it is too large; keys are defined, never assigned, so a "__proto__" key is an own property.
function walkJson(value, state, depth, path, key) {
  switch (typeof value) {
    case 'string':
      if (value.length > state.maxBytes - state.bytes) throw new Stop('too_large', path);
      state.add(utf8(JSON.stringify(value)), path);
      return state.string(value, path, key);
    case 'number':
      if (!Number.isFinite(value)) throw new Stop('not_json', path);
      state.add(JSON.stringify(value).length, path);
      return value === 0 ? 0 : value;
    case 'boolean':
      state.add(value ? 4 : 5, path);
      return value;
    case 'object':
      break;
    default:
      throw new Stop('not_json', path);
  }
  if (value === null) {
    state.add(4, path);
    return null;
  }
  if (depth > state.maxDepth) throw new Stop('too_deep', path);
  if (Array.isArray(value)) {
    state.add(2, path);
    const out = [];
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) state.add(1, path);
      out.push(walkJson(value[index], state, depth + 1, `${path}/${index}`, null));
    }
    return out;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Stop('not_json', path);
  state.add(2, path);
  const out = {};
  const keys = Object.keys(value);
  for (let index = 0; index < keys.length; index += 1) {
    const name = keys[index];
    const where = `${path}/${name}`;
    if (name.length > state.maxBytes - state.bytes) throw new Stop('too_large', where);
    state.key(name, where);
    state.add(utf8(JSON.stringify(name)) + (index > 0 ? 2 : 1), where);
    Object.defineProperty(out, name, { value: walkJson(value[name], state, depth + 1, where, name), enumerable: true, writable: true, configurable: true });
  }
  return out;
}

function counter(maxBytes, maxDepth) {
  return {
    bytes: 0,
    maxBytes,
    maxDepth,
    add(count, path) {
      this.bytes += count;
      if (this.bytes > this.maxBytes) throw new Stop('too_large', path);
    },
    key() {},
    string: (text) => text,
  };
}

/** A bounded copy of plain JSON (default 8 MB, 64 levels): {ok: true, value, bytes} or {ok: false, reason: too_large | too_deep | not_json | unreadable | bad_limit}. */
export function copyJson(value, options) {
  try {
    const maxBytes = option(options, 'maxBytes', JSON_MAX_BYTES);
    const maxDepth = option(options, 'maxDepth', JSON_MAX_DEPTH);
    if (!isLimit(maxBytes, 1, 64 * 1024 * 1024) || !isLimit(maxDepth, 1, 256)) return { ok: false, reason: 'bad_limit' };
    const state = counter(maxBytes, maxDepth);
    const copy = walkJson(value, state, 1, '', null);
    return { ok: true, value: copy, bytes: state.bytes };
  } catch (error) {
    return { ok: false, reason: error instanceof Stop ? error.reason : 'unreadable' };
  }
}

/** An input schema as it may be shown: {ok: true, schema, bytes} (a copy; bytes = the input's JSON size) or {ok: false, reason, path}. */
export function checkSchema(value, options) {
  try {
    const maxBytes = option(options, 'maxBytes', LIMITS.schemaMaxBytes);
    const maxDepth = option(options, 'maxDepth', LIMITS.schemaMaxDepth);
    if (!isLimit(maxBytes, 2, 16 * 1024 * 1024) || !isLimit(maxDepth, 1, 256)) return { ok: false, reason: 'bad_limit', path: '' };
    if (value === undefined || value === null) return { ok: false, reason: 'schema_missing', path: '' };
    if (!isObject(value)) return { ok: false, reason: 'schema_not_object', path: '' };
    const state = counter(maxBytes, maxDepth);
    state.key = (name, where) => {
      if (name === '__proto__') throw new Stop('reserved_key', where);
      if (HIDDEN_ONE.test(name)) throw new Stop('bad_key', where);
    };
    state.string = (text, path, key) => {
      if (key === 'description' || key === 'title') return sanitizeText(text).text;
      if (HIDDEN_ONE.test(text)) throw new Stop('bad_string', path);
      if (REFERENCES.has(key) && !text.startsWith('#')) throw new Stop('remote_ref', path);
      if (key === '$id' && ABSOLUTE_URI.test(text)) throw new Stop('remote_id', path);
      return text;
    };
    const schema = walkJson(value, state, 1, '', null);
    if (schema.type !== 'object') return { ok: false, reason: 'schema_not_object_type', path: '/type' };
    return { ok: true, schema, bytes: state.bytes };
  } catch (error) {
    if (error instanceof Stop) return { ok: false, reason: `schema_${error.reason}`, path: preview(error.path, 200) };
    return { ok: false, reason: 'schema_unreadable', path: '' };
  }
}

/** Tool annotations: {annotations, dropped}; annotations holds only the four known hints, and only when they are own booleans. Never refuses. */
export function sanitizeAnnotations(value) {
  try {
    if (value === undefined || value === null) return { annotations: {}, dropped: [] };
    if (!isObject(value)) return { annotations: {}, dropped: ['(not an object)'] };
    const annotations = {};
    const dropped = [];
    for (const hint of HINTS) {
      if (!Object.hasOwn(value, hint)) continue;
      const flag = value[hint];
      if (typeof flag === 'boolean') annotations[hint] = flag;
      else dropped.push(hint);
    }
    for (const key of Object.keys(value)) {
      if (dropped.length >= MAX_DROPPED_NAMED) break;
      if (!HINTS.includes(key)) dropped.push(preview(key, 40));
    }
    return { annotations, dropped };
  } catch {
    return { annotations: {}, dropped: ['(unreadable)'] };
  }
}

const notAnObject = (value) => ({ ok: false, reason: 'not_an_object', field: '', preview: preview(value) });
const unreadable = () => ({ ok: false, reason: 'unreadable', field: '', preview: '' });
// An optional text field: absent (undefined or null) gives text undefined; a string is sanitized and a note is kept when something was removed or cut.
function readText(raw, kind, field, notes, maxBytes = LIMITS.textMaxBytes) {
  if (raw === undefined || raw === null) return { ok: true, text: undefined };
  if (typeof raw !== 'string') return { ok: false, reason: `${kind}_not_a_string`, field, preview: preview(raw) };
  const clean = sanitizeText(raw, { maxBytes });
  if (clean.removed > 0 || clean.cut) notes.push({ field, removed: clean.removed, cut: clean.cut });
  return { ok: true, text: clean.text };
}
function readName(raw, field) {
  const name = checkName(raw);
  return name.ok ? name : { ok: false, reason: name.reason, field, preview: name.preview };
}

/** One tool of tools/list: {ok: true, item: {name, title?, description, inputSchema, annotations}, notes} or {ok: false, reason, field, preview, path?}. */
export function sanitizeTool(value) {
  try {
    if (!isObject(value)) return notAnObject(value);
    const name = readName(own(value, 'name'), 'name');
    if (!name.ok) return name;
    const notes = [];
    const title = readText(own(value, 'title'), 'title', 'title', notes);
    if (!title.ok) return title;
    const description = readText(own(value, 'description'), 'description', 'description', notes);
    if (!description.ok) return description;
    const schema = checkSchema(own(value, 'inputSchema'));
    if (!schema.ok) return { ok: false, reason: schema.reason, field: 'inputSchema', preview: '', path: schema.path };
    const { annotations, dropped } = sanitizeAnnotations(own(value, 'annotations'));
    if (dropped.length > 0) notes.push({ field: 'annotations', dropped });
    const item = { name: name.name };
    if (title.text !== undefined) item.title = title.text;
    item.description = description.text ?? '';
    item.inputSchema = schema.schema;
    item.annotations = annotations;
    return { ok: true, item, notes };
  } catch {
    return unreadable();
  }
}

/** One prompt of prompts/list: {ok: true, item: {name, title?, description, arguments: [{name, title?, description, required}]}, notes} or a refusal. */
export function sanitizePrompt(value) {
  try {
    if (!isObject(value)) return notAnObject(value);
    const name = readName(own(value, 'name'), 'name');
    if (!name.ok) return name;
    const notes = [];
    const title = readText(own(value, 'title'), 'title', 'title', notes);
    if (!title.ok) return title;
    const description = readText(own(value, 'description'), 'description', 'description', notes);
    if (!description.ok) return description;
    const raw = own(value, 'arguments');
    const args = [];
    if (raw !== undefined && raw !== null) {
      if (!Array.isArray(raw)) return { ok: false, reason: 'arguments_not_an_array', field: 'arguments', preview: preview(raw) };
      if (raw.length > LIMITS.maxPromptArguments) return { ok: false, reason: 'too_many_arguments', field: 'arguments', preview: String(raw.length) };
      const seen = new Set();
      for (let index = 0; index < raw.length; index += 1) {
        const field = `arguments[${index}]`;
        const argument = raw[index];
        if (!isObject(argument)) return { ok: false, reason: 'argument_not_an_object', field, preview: preview(argument) };
        const argumentName = readName(own(argument, 'name'), `${field}.name`);
        if (!argumentName.ok) return argumentName;
        if (seen.has(argumentName.name)) return { ok: false, reason: 'duplicate_argument', field: `${field}.name`, preview: argumentName.name };
        seen.add(argumentName.name);
        const argumentTitle = readText(own(argument, 'title'), 'title', `${field}.title`, notes);
        if (!argumentTitle.ok) return argumentTitle;
        const argumentDescription = readText(own(argument, 'description'), 'description', `${field}.description`, notes);
        if (!argumentDescription.ok) return argumentDescription;
        const entry = { name: argumentName.name };
        if (argumentTitle.text !== undefined) entry.title = argumentTitle.text;
        entry.description = argumentDescription.text ?? '';
        entry.required = own(argument, 'required') === true;
        args.push(entry);
      }
    }
    const item = { name: name.name };
    if (title.text !== undefined) item.title = title.text;
    item.description = description.text ?? '';
    item.arguments = args;
    return { ok: true, item, notes };
  } catch {
    return unreadable();
  }
}

/** One resource of resources/list: {ok: true, item: {uri, name, title?, description, mimeType?, size?}, notes} or a refusal. */
export function sanitizeResource(value) {
  try {
    if (!isObject(value)) return notAnObject(value);
    const uri = own(value, 'uri');
    const refuseUri = (reason) => ({ ok: false, reason, field: 'uri', preview: preview(uri) });
    if (typeof uri !== 'string') return refuseUri('uri_not_a_string');
    if (uri.length === 0) return refuseUri('uri_empty');
    if (uri.length > LIMITS.uriMaxBytes || utf8(uri) > LIMITS.uriMaxBytes) return refuseUri('uri_too_long');
    if (URI_BAD.test(uri)) return refuseUri('uri_bad_characters');
    const notes = [];
    const rawName = own(value, 'name');
    if (typeof rawName !== 'string') return { ok: false, reason: 'name_not_a_string', field: 'name', preview: preview(rawName) };
    const name = readText(rawName, 'name', 'name', notes, LIMITS.resourceNameMaxBytes);
    const title = readText(own(value, 'title'), 'title', 'title', notes);
    if (!title.ok) return title;
    const description = readText(own(value, 'description'), 'description', 'description', notes);
    if (!description.ok) return description;
    const item = { uri, name: name.text };
    if (title.text !== undefined) item.title = title.text;
    item.description = description.text ?? '';
    const mimeType = own(value, 'mimeType');
    if (mimeType !== undefined && mimeType !== null) {
      if (typeof mimeType === 'string' && MIME.test(mimeType)) item.mimeType = mimeType;
      else notes.push({ field: 'mimeType', dropped: true });
    }
    const size = own(value, 'size');
    if (size !== undefined && size !== null) {
      if (Number.isSafeInteger(size) && size >= 0) item.size = size;
      else notes.push({ field: 'size', dropped: true });
    }
    return { ok: true, item, notes };
  } catch {
    return unreadable();
  }
}

const KINDS = Object.freeze({
  tools: { one: sanitizeTool, key: 'name', duplicate: 'duplicate_name' },
  prompts: { one: sanitizePrompt, key: 'name', duplicate: 'duplicate_name' },
  resources: { one: sanitizeResource, key: 'uri', duplicate: 'duplicate_uri' },
});

/**
 * A whole list ('tools', 'prompts' or 'resources'): {ok: true, items, refused, refusedCount, overLimit, notes}. The first of two items with one name (or URI)
 * wins; at most `maxItems` (default 1000) items are read, `overLimit` counts the rest; at most 100 refusals and 100 notes are listed, each with its index.
 */
export function sanitizeList(kind, value, options) {
  try {
    if (typeof kind !== 'string' || !Object.hasOwn(KINDS, kind)) return { ok: false, reason: 'unknown_kind' };
    const maxItems = option(options, 'maxItems', LIMITS.maxItems);
    if (!isLimit(maxItems, 1, 100_000)) return { ok: false, reason: 'bad_limit' };
    if (!Array.isArray(value)) return { ok: false, reason: 'list_not_an_array' };
    const { one, key, duplicate } = KINDS[kind];
    const items = [];
    const refused = [];
    const notes = [];
    const seen = new Set();
    let refusedCount = 0;
    const length = Math.min(value.length, maxItems);
    for (let index = 0; index < length; index += 1) {
      const result = one(value[index]);
      let refusal = null;
      if (!result.ok) {
        const { ok, ...rest } = result; // eslint-disable-line no-unused-vars
        refusal = rest;
      } else if (seen.has(result.item[key])) refusal = { reason: duplicate, field: key, preview: preview(result.item[key]) };
      if (refusal) {
        refusedCount += 1;
        if (refused.length < LIMITS.maxListedRefusals) refused.push({ index, ...refusal });
        continue;
      }
      seen.add(result.item[key]);
      items.push(result.item);
      for (const note of result.notes) if (notes.length < LIMITS.maxListedNotes) notes.push({ index, ...note });
    }
    return { ok: true, items, refused, refusedCount, overLimit: value.length - length, notes };
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
}
