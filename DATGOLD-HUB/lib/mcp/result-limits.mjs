// An MCP tool result is bounded before it reaches the model (P2 slice C1, part of plan task ext-13; a later slice wires it into the client manager).
// Plain data in, plain data out; nothing here imports the MCP SDK or talks to a server.
//
//  - One ceiling for what is kept of a result: 8 MiB, shared in order by the text of text blocks and embedded text resources, the base64 of images and
//    audio, the strings of resource links, and the JSON of structuredContent (which gets what the content left). 4 KiB of it are kept for the note that
//    tells the model what was cut or dropped. A text is cut at a code point.
//  - Images: 8 at most, 5 MiB each (decoded), image/png, jpeg, gif or webp (what the providers accept; any other image type is a note) and base64 data; audio: 2 clips, 5 MiB, audio/*. An embedded blob counts as an image when its
//    type is image/*, and is otherwise dropped. Unknown content types are dropped, and the note names them (escaped, five at most). _meta and the
//    annotations of content blocks are not passed on. isError is kept exactly when it is the boolean true; a result that is not an object is an error.
//  - Then the model-facing cap of lib/token-optimization.mjs: optimizeToolResult runs on the bounded result when a task is given. It compacts only the
//    tool names it knows (run_command, git_*, test_*, web_* ...): any other MCP tool reaches the model at up to the 8 MiB ceiling. docs/MCP-HARDENING.md
//    names that gap for the slice that wires this in.
//  - The text of a result is not cleaned of hidden characters (a file a server reads back must stay byte for byte what it is); only descriptions are.
//  - createStderrCollector keeps at most N bytes of a server's stderr (the first half and the last half) and counts what it dropped.
import { optimizeToolResult } from '../token-optimization.mjs';
import { copyJson, cutToBytes, preview, stripHidden } from './sanitize.mjs';

const MiB = 1024 * 1024;
export const RESULT_LIMITS = Object.freeze({
  maxReadBytes: 8 * MiB,
  noteReserveBytes: 4096,
  maxContentItems: 256,
  maxImages: 8,
  maxImageBytes: 5 * MiB,
  maxAudio: 2,
  maxAudioBytes: 5 * MiB,
  maxUriBytes: 2048,
  maxNameBytes: 256,
  maxDescriptionBytes: 2048,
  maxStructuredDepth: 64,
});
export const STDERR_DEFAULT_BYTES = 64 * 1024;

const NOTE_PREFIX = '[DatGold limited this result: ';
const BASE64 = /^[A-Za-z0-9+/\r\n]*={0,2}$/;
// The image types the model providers accept (OpenAI, Anthropic, Gemini): any other image/* type (svg+xml, bmp, tiff ...) is dropped with a note, never
// passed on as an image block.
export const PROVIDER_IMAGE_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
// The type is named (MEDIA_TYPE has already limited it to [A-Za-z0-9.+-]), so the model is told what it did not get.
const providerImage = (mimeType) => 'an image of type ' + JSON.stringify(mimeType) + ', which the model providers do not accept (only image/png, image/jpeg, image/gif and image/webp)';
const MEDIA_TYPE = { image: /^image\/[A-Za-z0-9.+-]{1,64}$/, audio: /^audio\/[A-Za-z0-9.+-]{1,64}$/ };
const ANY_TYPE = /^[A-Za-z0-9!#$&^_.+-]{1,64}\/[A-Za-z0-9!#$&^_.+-]{1,64}$/;
const MALFORMED = 'a malformed item';
const UNSUPPORTED = 'an unsupported type';
const OVER = 'over the result ceiling';
const SPACE = 'larger than the space left under the ceiling';
const MAX_TYPE_NAMES = 5;

const own = (object, key) => (Object.hasOwn(object, key) ? object[key] : undefined);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const utf8 = (text) => Buffer.byteLength(text, 'utf8');

function readLimits(options) {
  const limits = { ...RESULT_LIMITS };
  const given = options?.limits;
  if (given !== undefined && given !== null) {
    if (typeof given !== 'object') throw new TypeError('limits must be an object');
    for (const key of Object.keys(given)) {
      if (!Object.hasOwn(RESULT_LIMITS, key)) throw new TypeError(`unknown limit ${key}`);
      const value = given[key];
      if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`limit ${key} must be a whole number of 0 or more`);
      limits[key] = value;
    }
  }
  if (limits.maxReadBytes < 2 * limits.noteReserveBytes) throw new TypeError(`maxReadBytes must be at least ${2 * limits.noteReserveBytes}`);
  return limits;
}

function drop(state, reason, count = 1) {
  state.dropped += count;
  state.reasons.set(reason, (state.reasons.get(reason) ?? 0) + count);
  return null;
}
function spend(state, size) {
  if (size > state.budget - state.used) return false;
  state.used += size;
  return true;
}
// A text against the budget: the whole text, a prefix cut at a code point, or null when nothing of it fits.
function takeText(text, state) {
  const size = utf8(text);
  state.textTotal += size;
  if (spend(state, size)) {
    state.textShown += size;
    return text;
  }
  state.cut += 1;
  const kept = cutToBytes(text, state.budget - state.used);
  const keptSize = utf8(kept);
  state.used += keptSize;
  state.textShown += keptSize;
  if (kept === '') {
    state.dropped += 1;
    return null;
  }
  return kept;
}
// An image or an audio clip (or an image blob of an embedded resource): true when it is kept and paid for.
function takeMedia(kind, data, mimeType, extra, state, limits) {
  const most = kind === 'image' ? limits.maxImages : limits.maxAudio;
  if ((kind === 'image' ? state.images : state.audio) >= most) return drop(state, `more than ${most} ${kind === 'image' ? 'images' : 'audio clips'}`) ?? false;
  if (typeof data !== 'string' || typeof mimeType !== 'string' || !MEDIA_TYPE[kind].test(mimeType)) return drop(state, `not base64 data of an ${kind} type`) ?? false;
  if (kind === 'image' && !PROVIDER_IMAGE_TYPES.includes(mimeType)) return drop(state, providerImage(mimeType)) ?? false;
  const largest = kind === 'image' ? limits.maxImageBytes : limits.maxAudioBytes;
  const decoded = Math.floor((data.length * 3) / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
  if (decoded > largest) return drop(state, `${kind} larger than ${largest} bytes`) ?? false;
  const size = data.length + utf8(mimeType) + extra;
  if (size > state.budget - state.used) return drop(state, OVER) ?? false;
  if (!BASE64.test(data)) return drop(state, `not base64 data of an ${kind} type`) ?? false;
  state.used += size;
  if (kind === 'image') state.images += 1;
  else state.audio += 1;
  return true;
}
const goodUri = (uri, limits) => typeof uri === 'string' && uri.length > 0 && uri.length <= limits.maxUriBytes && utf8(uri) <= limits.maxUriBytes;

function readLink(item, state, limits) {
  const uri = own(item, 'uri');
  const name = own(item, 'name');
  if (!goodUri(uri, limits) || typeof name !== 'string') return drop(state, MALFORMED);
  const link = { type: 'resource_link', uri, name: cutToBytes(name, limits.maxNameBytes) };
  const title = own(item, 'title');
  if (typeof title === 'string') link.title = cutToBytes(title, limits.maxNameBytes);
  const description = own(item, 'description');
  if (typeof description === 'string') link.description = cutToBytes(description, limits.maxDescriptionBytes);
  const mimeType = own(item, 'mimeType');
  if (typeof mimeType === 'string' && ANY_TYPE.test(mimeType)) link.mimeType = mimeType;
  const size = own(item, 'size');
  if (Number.isSafeInteger(size) && size >= 0) link.size = size;
  let cost = 0;
  for (const key of ['uri', 'name', 'title', 'description', 'mimeType']) if (typeof link[key] === 'string') cost += utf8(link[key]);
  if (!spend(state, cost)) return drop(state, OVER);
  return link;
}

function readResource(item, state, limits) {
  const resource = own(item, 'resource');
  if (!isObject(resource)) return drop(state, MALFORMED);
  const uri = own(resource, 'uri');
  if (!goodUri(uri, limits)) return drop(state, MALFORMED);
  const rawType = own(resource, 'mimeType');
  const mimeType = typeof rawType === 'string' && ANY_TYPE.test(rawType) ? rawType : undefined;
  const text = own(resource, 'text');
  if (typeof text === 'string') {
    if (!spend(state, utf8(uri) + (mimeType ? utf8(mimeType) : 0))) return drop(state, OVER);
    const kept = takeText(text, state);
    if (kept === null) return null;
    return { type: 'resource', resource: mimeType ? { uri, mimeType, text: kept } : { uri, text: kept } };
  }
  const blob = own(resource, 'blob');
  if (typeof blob !== 'string') return drop(state, MALFORMED);
  if (!mimeType || !MEDIA_TYPE.image.test(mimeType)) return drop(state, 'a binary resource');
  if (!takeMedia('image', blob, mimeType, utf8(uri), state, limits)) return null;
  return { type: 'resource', resource: { uri, mimeType, blob } };
}

function readItem(item, state, limits) {
  if (!isObject(item)) return drop(state, MALFORMED);
  const type = own(item, 'type');
  if (type === 'text') {
    const text = own(item, 'text');
    if (typeof text !== 'string') return drop(state, MALFORMED);
    const kept = takeText(text, state);
    return kept === null ? null : { type: 'text', text: kept };
  }
  if (type === 'image' || type === 'audio') {
    const data = own(item, 'data');
    const mimeType = own(item, 'mimeType');
    return takeMedia(type, data, mimeType, 0, state, limits) ? { type, data, mimeType } : null;
  }
  if (type === 'resource_link') return readLink(item, state, limits);
  if (type === 'resource') return readResource(item, state, limits);
  state.types.add(typeof type === 'string' ? preview(type, 32) : typeof type);
  return drop(state, UNSUPPORTED);
}

function readStructured(value, state, limits, result) {
  if (value === undefined) return;
  if (!isObject(value)) {
    state.structured = 'not a JSON object';
    return;
  }
  const room = state.budget - state.used;
  const copy = room < 2 ? { ok: false, reason: 'too_large' } : copyJson(value, { maxBytes: room, maxDepth: limits.maxStructuredDepth });
  if (!copy.ok) {
    state.structured = copy.reason === 'too_large' ? SPACE : copy.reason === 'too_deep' ? `deeper than ${limits.maxStructuredDepth} levels` : 'not plain JSON';
    return;
  }
  state.used += copy.bytes;
  result.structuredContent = copy.value;
}

/**
 * The result of tools/call as it may reach the model: {result: {content, structuredContent?, isError?}, notes, stats: {bytes, items, dropped, cut}}.
 * options: {taskId, toolName, optimize = true, limits} (limits overrides RESULT_LIMITS; a bad limit is a programming error and throws a TypeError).
 * Whatever the server sent, this never throws.
 */
export function limitToolResult(raw, options) {
  const limits = readLimits(options);
  const state = {
    budget: limits.maxReadBytes - limits.noteReserveBytes, used: 0, items: 0, dropped: 0, cut: 0, textTotal: 0, textShown: 0,
    images: 0, audio: 0, reasons: new Map(), types: new Set(), general: [], structured: null,
  };
  const result = { content: [] };
  let isError = false;
  try {
    if (!isObject(raw)) {
      state.general.push('the server sent no result object');
      isError = true;
    } else {
      isError = own(raw, 'isError') === true;
      const content = own(raw, 'content');
      if (content !== undefined && !Array.isArray(content)) state.general.push('content was not a list');
      else if (content !== undefined) {
        const count = Math.min(content.length, limits.maxContentItems);
        for (let index = 0; index < count; index += 1) {
          let item;
          try { item = readItem(content[index], state, limits); } catch { item = drop(state, MALFORMED); }
          if (item) {
            result.content.push(item);
            state.items += 1;
          }
        }
        if (content.length > count) drop(state, `more than ${limits.maxContentItems} content items`, content.length - count);
      }
      if (Object.hasOwn(raw, 'structuredContent')) readStructured(raw.structuredContent, state, limits, result);
    }
  } catch {
    state.general.push('the result could not be read');
    isError = true;
  }

  const notes = [...state.general];
  if (state.cut > 0) notes.push(`text cut: ${state.textTotal - state.textShown} of ${state.textTotal} bytes not shown (ceiling ${limits.maxReadBytes} bytes)`);
  for (const [reason, count] of state.reasons) {
    if (reason !== UNSUPPORTED) notes.push(`${count} item(s) dropped: ${reason}`);
    else {
      const names = [...state.types];
      const listed = names.slice(0, MAX_TYPE_NAMES).map((name) => `"${name}"`).concat(names.length > MAX_TYPE_NAMES ? ['...'] : []);
      notes.push(`${count} item(s) dropped: ${reason} (${listed.join(', ')})`);
    }
  }
  if (state.structured) notes.push(`structured content dropped: ${state.structured}`);
  if (notes.length > 0) result.content.push({ type: 'text', text: `${NOTE_PREFIX}${notes.join('; ')}]` });
  if (isError) result.isError = true;

  let final = result;
  const taskId = options?.taskId;
  if (options?.optimize !== false && taskId) {
    try { final = optimizeToolResult(result, { taskId, toolName: String(options?.toolName ?? '') }); } catch { final = result; }
  }
  return { result: final, notes, stats: { bytes: state.used, items: state.items, dropped: state.dropped, cut: state.cut } };
}

// An incomplete UTF-8 sequence at the end of a buffer, or continuation bytes at its start, are where a cut fell inside a character: leave them out.
function wholeEnd(buffer) {
  for (let back = 1; back <= Math.min(4, buffer.length); back += 1) {
    const byte = buffer[buffer.length - back];
    if ((byte & 0xc0) === 0x80) continue;
    const length = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return length > back ? buffer.subarray(0, buffer.length - back) : buffer;
  }
  return buffer;
}
function wholeStart(buffer) {
  let start = 0;
  while (start < Math.min(3, buffer.length) && (buffer[start] & 0xc0) === 0x80) start += 1;
  return buffer.subarray(start);
}

/**
 * Collects a server's stderr in at most `maxBytes` (default 64 KiB, 1 KiB to 16 MiB): the first half of what was written and the most recent half.
 * push(chunk) takes a string or bytes (anything else is ignored and counted); text() is what was kept, decoded as UTF-8, with the hidden characters
 * removed and a line that says how many bytes were dropped between the halves; stats() = {totalBytes, keptBytes, droppedBytes, ignored}.
 */
export function createStderrCollector(options) {
  const maxBytes = options?.maxBytes ?? STDERR_DEFAULT_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 16 * MiB) throw new TypeError('maxBytes must be a whole number from 1024 to 16 MiB');
  const headMost = Math.floor(maxBytes / 2);
  const tailMost = maxBytes - headMost;
  const head = [];
  let headBytes = 0;
  let tail = [];
  let tailStart = 0;
  let tailBytes = 0;
  let total = 0;
  let ignored = 0;
  return {
    push(chunk) {
      let buffer = null;
      try {
        if (typeof chunk === 'string') buffer = Buffer.from(chunk, 'utf8');
        else if (chunk instanceof Uint8Array) buffer = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      } catch {
        buffer = null;
      }
      if (!buffer) {
        ignored += 1;
        return;
      }
      total += buffer.length;
      if (headBytes < headMost) {
        const take = Math.min(buffer.length, headMost - headBytes);
        head.push(Buffer.from(buffer.subarray(0, take)));
        headBytes += take;
        buffer = buffer.subarray(take);
      }
      if (buffer.length === 0) return;
      if (buffer.length >= tailMost) {
        tail = [Buffer.from(buffer.subarray(buffer.length - tailMost))];
        tailStart = 0;
        tailBytes = tailMost;
        return;
      }
      tail.push(Buffer.from(buffer));
      tailBytes += buffer.length;
      while (tailBytes - tail[tailStart].length >= tailMost) {
        tailBytes -= tail[tailStart].length;
        tailStart += 1;
      }
      if (tailBytes > tailMost) {
        tail[tailStart] = tail[tailStart].subarray(tailBytes - tailMost);
        tailBytes = tailMost;
      }
      if (tailStart > 1024 && tailStart * 2 > tail.length) {
        tail = tail.slice(tailStart);
        tailStart = 0;
      }
    },
    text() {
      const dropped = total - headBytes - tailBytes;
      const kept = tail.slice(tailStart);
      const text = dropped === 0
        ? Buffer.concat([...head, ...kept]).toString('utf8')
        : `${wholeEnd(Buffer.concat(head)).toString('utf8')}\n[DatGold dropped ${dropped} bytes of stderr]\n${wholeStart(Buffer.concat(kept)).toString('utf8')}`;
      return stripHidden(text).text;
    },
    stats() {
      return { totalBytes: total, keptBytes: headBytes + tailBytes, droppedBytes: total - headBytes - tailBytes, ignored };
    },
  };
}
