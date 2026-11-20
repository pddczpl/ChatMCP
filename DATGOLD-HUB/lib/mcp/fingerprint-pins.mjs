// The rug-pull defence for MCP servers (P2 slice C1, part of plan task ext-13; a later slice wires it into the client manager and the catalog).
//
// When the owner approves a server, its tools, prompts and resources are pinned: for every item a hash of each field as the model and the approval dialog
// will see it, that is AFTER lib/mcp/sanitize.mjs. A later list is `pinned` when it hashes the same, `needs_review` with a diff (which items were added,
// removed or changed, and in which field) when it does not, and `unpinned` when the server was never approved. Plain data in, plain data out; nothing here
// imports the MCP SDK or talks to a server.
//
// What does NOT count as a change (noise that would otherwise quarantine a server for nothing):
//  - the order of the tools, prompts and resources, and of an object's keys (the hashes are over a canonical JSON with sorted keys, written here);
//  - runs of whitespace in descriptions and titles (at the top and inside input schemas), leading and trailing whitespace, and NFC versus NFD;
//  - the order of `required`, of a `type` list and of `enum` members (JSON Schema reads them as sets), and of a prompt's arguments;
//  - annotations written out at their MCP defaults (readOnlyHint false, destructiveHint true, idempotentHint false, openWorldHint true) or left out;
//  - whatever the sanitizer removes or never passes: hidden characters (once the marker is there, more or fewer of them change nothing), text beyond the
//    2 KB cut, _meta, icons, outputSchema, annotations.title, a resource's size, refused items (a duplicate, a bad name).
// What DOES count: any other change of a word (letters, case, two words joined), of a title, of a schema (a parameter added or removed, a new required
// parameter, a changed type, enum member, default or nested description), of an annotation's effective value, hidden characters where there were none
// (the marker appears), an added or removed item. A timestamp in a description is a change too: there is no telling it from an instruction.
//
// The store is one JSON file under a directory it is given, written whole (a temporary file, then a rename). A corrupt file is an empty store (every server
// is unpinned again, which fails closed), logged once and copied aside as <file>.corrupt; a file that cannot be READ refuses check and approve, so that
// the pins in it are never replaced by an empty store.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic } from '../fs-safe.mjs';
import { preview, sanitizeList } from './sanitize.mjs';

export const PIN_ALGORITHM = 'datgold-mcp-pin-1';
const STORE_VERSION = 1;
const KINDS = [['tools', 'tool'], ['prompts', 'prompt'], ['resources', 'resource']];
const FIELDS = { tool: ['title', 'description', 'inputSchema', 'annotations'], prompt: ['title', 'description', 'arguments'], resource: ['name', 'title', 'description', 'mimeType'] };
const DEFAULT_HINTS = Object.freeze({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
const SERVER_ID = /^[A-Za-z0-9_.-]{1,128}$/;
const RESERVED_IDS = new Set(['__proto__', 'constructor', 'prototype']);
const HASH = /^[0-9a-f]{64}$/;
const ALGORITHM_NAME = /^[a-z0-9-]{1,64}$/;
const MAX_ENTRIES = 3000;
// Keywords whose value is data, not a schema: kept as they are (an enum is still read as a set).
const LITERAL_KEYWORDS = new Set(['const', 'default', 'examples', 'enum']);
const SET_KEYWORDS = new Set(['required', 'type']);
// Keywords whose value maps names to schemas: the names are not keywords.
const MAP_KEYWORDS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);

const own = (object, key) => (Object.hasOwn(object, key) ? object[key] : undefined);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const validId = (id) => typeof id === 'string' && SERVER_ID.test(id) && !RESERVED_IDS.has(id);

// Canonical JSON: keys sorted by UTF-16 code units (never by locale), arrays in order. Only ever given sanitized data, which is plain JSON.
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort(byText).map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
const asSet = (values) => values.map((value) => [canonical(value), value]).sort((a, b) => byText(a[0], b[0])).map(([, value]) => value);
const normalizeText = (text) => text.normalize('NFC').replace(/\s+/gu, ' ').trim();

function normalizeSchema(value) {
  if (Array.isArray(value)) return value.map(normalizeSchema);
  if (!isObject(value)) return value;
  const out = {};
  for (const key of Object.keys(value)) {
    const child = value[key];
    if ((key === 'description' || key === 'title') && typeof child === 'string') out[key] = normalizeText(child);
    else if (key === 'enum' && Array.isArray(child)) out[key] = asSet(child);
    else if (LITERAL_KEYWORDS.has(key)) out[key] = child;
    else if (SET_KEYWORDS.has(key) && Array.isArray(child)) out[key] = asSet(child);
    else if (MAP_KEYWORDS.has(key) && isObject(child)) out[key] = Object.fromEntries(Object.keys(child).map((name) => [name, normalizeSchema(child[name])]));
    else out[key] = normalizeSchema(child);
  }
  return out;
}

const optionalText = (text) => (text === undefined ? '' : normalizeText(text));
const FORMS = {
  tool: (item) => ({
    title: optionalText(item.title),
    description: normalizeText(item.description),
    inputSchema: normalizeSchema(item.inputSchema),
    annotations: { ...DEFAULT_HINTS, ...item.annotations },
  }),
  prompt: (item) => ({
    title: optionalText(item.title),
    description: normalizeText(item.description),
    arguments: item.arguments
      .map((argument) => ({ name: argument.name, title: optionalText(argument.title), description: normalizeText(argument.description), required: argument.required }))
      .sort((a, b) => byText(a.name, b.name)),
  }),
  resource: (item) => ({ name: normalizeText(item.name), title: optionalText(item.title), description: normalizeText(item.description), mimeType: item.mimeType ?? '' }),
};

/**
 * The fingerprint of what a server lists: {ok: true, fingerprint, entries, counts, refusals, refusedCount, sanitized} or {ok: false, reason}.
 * `snapshot` is {tools?, prompts?, resources?} as the server sent them (a kind left out is an empty list); `entries` maps "tool:<name>",
 * "prompt:<name>" and "resource:<uri>" to {field: sha256}; `sanitized` holds the lists as lib/mcp/sanitize.mjs gives them back, in the server's order.
 */
export function fingerprintSnapshot(snapshot) {
  try {
    if (!isObject(snapshot)) return { ok: false, reason: 'snapshot_not_an_object' };
    const collected = [];
    const sanitized = {};
    const counts = {};
    const refusals = [];
    let refusedCount = 0;
    for (const [plural, singular] of KINDS) {
      const raw = own(snapshot, plural);
      const list = raw === undefined || raw === null ? { ok: true, items: [], refused: [], refusedCount: 0, overLimit: 0 } : sanitizeList(plural, raw);
      if (!list.ok) return { ok: false, reason: `${plural}_${list.reason}` };
      sanitized[plural] = list.items;
      counts[plural] = list.items.length;
      refusedCount += list.refusedCount + list.overLimit;
      for (const refusal of list.refused) refusals.push({ kind: singular, ...refusal });
      for (const item of list.items) {
        const form = FORMS[singular](item);
        const fields = {};
        for (const field of FIELDS[singular]) fields[field] = sha256(canonical(form[field]));
        collected.push([`${singular}:${singular === 'resource' ? item.uri : item.name}`, fields]);
      }
    }
    const entries = {};
    for (const [key, fields] of collected.sort((a, b) => byText(a[0], b[0]))) entries[key] = fields;
    return { ok: true, fingerprint: sha256(canonical({ algorithm: PIN_ALGORITHM, entries })), entries, counts, refusals, refusedCount, sanitized };
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
}

function entryMap(value) {
  const map = new Map();
  if (!isObject(value)) return map;
  for (const key of Object.keys(value)) if (isObject(value[key])) map.set(key, value[key]);
  return map;
}
const where = (key) => ({ kind: key.slice(0, key.indexOf(':')), name: key.slice(key.indexOf(':') + 1) });

/** What changed between two `entries` maps: {added: [{kind, name}], removed: [...], changed: [{kind, name, fields}]}, each sorted. Garbage is an empty map. */
export function diffEntries(approved, current) {
  const added = [];
  const removed = [];
  const changed = [];
  try {
    const before = entryMap(approved);
    const after = entryMap(current);
    for (const key of [...new Set([...before.keys(), ...after.keys()])].sort(byText)) {
      const old = before.get(key);
      const now = after.get(key);
      if (!old) added.push(where(key));
      else if (!now) removed.push(where(key));
      else {
        const fields = [...new Set([...Object.keys(old), ...Object.keys(now)])].filter((field) => own(old, field) !== own(now, field)).sort(byText);
        if (fields.length > 0) changed.push({ ...where(key), fields });
      }
    }
  } catch {
    return { added: [], removed: [], changed: [] };
  }
  return { added, removed, changed };
}

function validRecord(record) {
  if (!isObject(record)) return false;
  const algorithm = own(record, 'algorithm');
  const fingerprint = own(record, 'fingerprint');
  const approvedAt = own(record, 'approvedAt');
  const counts = own(record, 'counts');
  const entries = own(record, 'entries');
  if (typeof algorithm !== 'string' || !ALGORITHM_NAME.test(algorithm)) return false;
  if (typeof fingerprint !== 'string' || !HASH.test(fingerprint)) return false;
  if (typeof approvedAt !== 'string' || approvedAt.length > 64) return false;
  if (!isObject(counts) || !Object.values(counts).every((count) => Number.isSafeInteger(count) && count >= 0)) return false;
  if (!isObject(entries)) return false;
  const keys = Object.keys(entries);
  if (keys.length > MAX_ENTRIES) return false;
  return keys.every((key) => isObject(entries[key]) && Object.values(entries[key]).every((hash) => typeof hash === 'string' && HASH.test(hash)));
}

/**
 * A pin store kept in `<directory>/<fileName>` (default mcp-pins.json). `directory` must be absolute and `fileName` a plain name; anything else is a
 * programming error and throws a TypeError. The methods never throw; they answer one after the other in the order they were called.
 *   check(serverId, snapshot)  -> {ok: true, state: 'unpinned' | 'pinned' | 'needs_review', fingerprint, refusals, refusedCount, sanitized,
 *                                  pinned?, diff?, reason?: 'algorithm_changed'} or {ok: false, reason}
 *   approve(serverId, snapshot, {expectedFingerprint}?) -> {ok: true, fingerprint} or {ok: false, reason}; with expectedFingerprint (what the owner
 *                                  was shown) a snapshot that hashes otherwise is refused as fingerprint_mismatch
 *   remove(serverId) -> {ok: true, removed}; get(serverId) -> the record or null
 */
export function createPinStore(options) {
  const directory = options?.directory;
  if (typeof directory !== 'string' || directory === '' || !path.isAbsolute(directory)) throw new TypeError('createPinStore needs an absolute directory');
  const fileName = options.fileName ?? 'mcp-pins.json';
  if (typeof fileName !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(fileName) || fileName === '.' || fileName === '..') throw new TypeError('createPinStore: fileName must be a plain file name');
  const writeLog = typeof options.log === 'function' ? options.log : (message) => console.warn(`[mcp-pins] ${message}`);
  // A log that throws must not turn an answer into an exception, nor stop the calls queued after it.
  const log = (message) => {
    try { writeLog(message); } catch { /* the log is best effort */ }
  };
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const file = path.join(directory, fileName);
  let pins = null;
  let queue = Promise.resolve();
  const serial = (task) => {
    const run = queue.then(task).catch((error) => {
      log(`an operation on ${file} failed: ${preview(String(error?.message ?? error), 200)}`);
      return { ok: false, reason: 'internal_error' };
    });
    queue = run.then(() => {}, () => {});
    return run;
  };

  async function parse(text) {
    let data;
    try { data = JSON.parse(text); } catch { data = undefined; }
    const map = new Map();
    if (!isObject(data) || own(data, 'version') !== STORE_VERSION || !isObject(own(data, 'servers'))) {
      log(`the pin file ${file} is corrupt; it is kept as ${file}.corrupt and read as empty, so every server must be approved again`);
      await fs.copyFile(file, `${file}.corrupt`).catch(() => {});
      return map;
    }
    const servers = own(data, 'servers');
    for (const id of Object.keys(servers)) {
      if (validId(id) && validRecord(servers[id])) map.set(id, servers[id]);
      else log(`the pin of ${preview(id, 40)} in ${file} is not valid and was dropped`);
    }
    return map;
  }
  async function load() {
    if (pins) return pins;
    let text;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
        pins = new Map();
        return pins;
      }
      log(`the pin file ${file} could not be read (${error?.code ?? 'error'}); check and approve are refused until it can be`);
      return null;
    }
    pins = await parse(text);
    return pins;
  }
  async function save(map) {
    const servers = {};
    for (const id of [...map.keys()].sort(byText)) servers[id] = map.get(id);
    await fs.mkdir(directory, { recursive: true });
    await writeFileAtomic(file, `${JSON.stringify({ version: STORE_VERSION, servers }, null, 2)}\n`);
  }
  async function commit(next) {
    try {
      await save(next);
    } catch (error) {
      log(`the pin file ${file} could not be written (${error?.code ?? 'error'})`);
      return false;
    }
    pins = next;
    return true;
  }

  return {
    file,
    check: (serverId, snapshot) => serial(async () => {
      if (!validId(serverId)) return { ok: false, reason: 'bad_server_id' };
      const current = fingerprintSnapshot(snapshot);
      if (!current.ok) return { ok: false, reason: current.reason };
      const map = await load();
      if (!map) return { ok: false, reason: 'store_unreadable' };
      const answer = { ok: true, fingerprint: current.fingerprint, refusals: current.refusals, refusedCount: current.refusedCount, sanitized: current.sanitized };
      const pin = map.get(serverId);
      if (!pin) return { ...answer, state: 'unpinned' };
      if (pin.algorithm !== PIN_ALGORITHM) return { ...answer, state: 'needs_review', pinned: pin.fingerprint, reason: 'algorithm_changed', diff: null };
      if (pin.fingerprint === current.fingerprint) return { ...answer, state: 'pinned' };
      return { ...answer, state: 'needs_review', pinned: pin.fingerprint, diff: diffEntries(pin.entries, current.entries) };
    }),
    approve: (serverId, snapshot, approveOptions) => serial(async () => {
      if (!validId(serverId)) return { ok: false, reason: 'bad_server_id' };
      const current = fingerprintSnapshot(snapshot);
      if (!current.ok) return { ok: false, reason: current.reason };
      const expected = approveOptions?.expectedFingerprint;
      if (expected !== undefined && expected !== current.fingerprint) return { ok: false, reason: 'fingerprint_mismatch' };
      const map = await load();
      if (!map) return { ok: false, reason: 'store_unreadable' };
      const next = new Map(map);
      next.set(serverId, { algorithm: PIN_ALGORITHM, fingerprint: current.fingerprint, approvedAt: now().toISOString(), counts: current.counts, entries: current.entries });
      if (!(await commit(next))) return { ok: false, reason: 'write_failed' };
      return { ok: true, fingerprint: current.fingerprint };
    }),
    remove: (serverId) => serial(async () => {
      if (!validId(serverId)) return { ok: false, reason: 'bad_server_id' };
      const map = await load();
      if (!map) return { ok: false, reason: 'store_unreadable' };
      if (!map.has(serverId)) return { ok: true, removed: false };
      const next = new Map(map);
      next.delete(serverId);
      if (!(await commit(next))) return { ok: false, reason: 'write_failed' };
      return { ok: true, removed: true };
    }),
    get: (serverId) => serial(async () => {
      if (!validId(serverId)) return null;
      const record = (await load())?.get(serverId);
      return record ? structuredClone(record) : null;
    }),
  };
}
