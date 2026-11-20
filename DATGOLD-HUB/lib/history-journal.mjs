// The history journal (P9 ac-17): the model history of a task, written into its transcript.jsonl as it grows, and read back when the
// conversation goes on, so that the next run starts from what the model really saw instead of a summary of it. docs/SESSION-RESUME.md
// describes it for a reader; this comment is the contract the code keeps.
//
// WHAT IS WRITTEN (version 1). Every record is a line of the task's transcript.jsonl and starts with "at" and "type", as every record of
// the transcript does (lib/agent.mjs writes them in order with the others):
//   history_run      {v, run, seed, counters}            a run of the task starts. seed = {source, items, bytes, dropped, cut, reason?}: where
//                                                        its history came from ('journal': replayed from the records below; 'checkpoint':
//                                                        the checkpoint text of the old path, because there was no journal or it could not
//                                                        be read, reason saying why; 'none': a new task), how many items, how many bytes,
//                                                        how many old items were left out for size, how many calls of an interrupted turn
//                                                        were cut.
//   history          {v, run, seq, role, kind, batch, item, counters?}
//                                                        one item that entered the HistoryLedger of the run (lib/history-ledger.mjs), with
//                                                        the ledger's own metadata: seq 0, 1, 2 ... within the run, in ledger order (items
//                                                        a run was seeded with are not written again). A tool result whose whole result is
//                                                        already a record of the transcript (tool_result_full, catalog_result) is written
//                                                        as a REFERENCE to it, {type:'function_call_output', call_id, output_ref}, and the
//                                                        output the model was given is made again from that record when the journal is
//                                                        read: a result is never written twice. Any other result (an argument error the
//                                                        runner answered itself) is written as it is. `counters` is there when the run's
//                                                        counters changed since the record before it, so a counter and the item it caused
//                                                        (a hook's feedback) are written together.
//   history_end      {v, run, items, counters}           the run ended having committed `items` items (a run that was killed has none).
//   context_summary  {v, run, through: {run, seq}, item} reserved for a summary of the history up to an item (ac-7, not scheduled; nothing
//                                                        writes it yet): the loader replaces the items through the one named with `item`.
// counters = { hookBlocks: {limit, used, byEvent} | null  the Stop / SubagentStop / TaskCompleted budget of the run (lib/lifecycle-hooks.mjs),
//              noticeTurns                                 the final answers held back for a notice of a background agent,
//              doneGate: null }                            reserved: the Hub has no done-gate yet.
// The record goes through the transcript's own masking when it is written (AgentRunner #clean with transcript: true): secrets the writing
// process knew are masked, and the opaque reasoning (Responses encrypted_content, Anthropic thinking signatures and text, Gemini
// thoughtSignature) is replaced by a placeholder. It is never on disk, so it never comes back.
//
// WHAT READING DOES (loadHistoryJournal). It streams the file once and parses only the lines it needs (the type is read from the start of a
// line; a model_response line is skipped unread). Then, in this order:
//   1. Damage. A last line that is truncated or not JSON is skipped (a process killed while it wrote). Anything else that does not hold
//      together makes the journal unusable, with a reason: 'corrupt' (a history line in the middle that is not JSON, records out of order,
//      an item that is not an object), 'journal_gap' (a seq missing or repeated, a reference whose record is not there, a run that ended
//      with more items than are there, history without the start of its run), 'unknown_version' (a record or a kind of reference a newer
//      Hub wrote). 'no_journal' is a transcript with no history record at all (a task written before the journal existed), 'empty' one
//      whose history has no item. The caller then uses the checkpoint text, as before.
//   2. Runs. The history is the runs in order. A run that began from the checkpoint text or as a new task starts the history again (and a
//      damage before it no longer matters); a run that began from the journal follows what came before. The run that is starting
//      (`beforeRun` and later) is not read.
//   3. The interrupted turn. At the end of every run, a model turn whose calls do not all have their result is cut whole: its text, its
//      calls and the results it has. Anthropic needs the thinking blocks of a tool-use turn that is continued, and they are never written;
//      the loop of a run that went on would have finished the turn. The calls cut from the last run are returned (`interrupted`) for the
//      note that tells the model about them.
//   4. The skill index (kind 'skill_context') of a run is that run's own: a seed carries none (the run that starts writes its own), a
//      history read whole keeps the last run's.
//   5. The latest context_summary that names an item of the history replaces the items through that one.
//   6. The outputs that are references are made again with `modelOutput(result)` (the caller's: the runner's #modelOutput with the token
//      optimiser off, because its receipts live in memory only and are gone).
//   7. The opaque reasoning is left out (stripOpaque): Responses reasoning items, and the fields that carry thinking blocks, signatures and
//      reasoning text. They are placeholders on disk, and a placeholder sent back is refused.
//   8. Every string is passed through `redact` (the secret list of the process that loads, which may know secrets the writing process did
//      not, and the reverse: a line written while a secret was unknown holds it on disk), except the bytes of a picture.
//   9. pairToolCalls (lib/model-history.mjs) repairs the pairing: a call without a result gets an explicit "no result", a result without its
//      call is dropped (a summary can cut a turn in two).
//  10. The size cap: a history over `maxBytes` loses its oldest whole turns and starts with a note that says how many items were left out
//      (a user message: Anthropic and Gemini need the conversation to start with one). One that cannot fit is 'too_large'.
// Reading runs nothing: it only rebuilds what the model is sent.
import fs from 'node:fs';
import { pairToolCalls } from './model-history.mjs';

export const JOURNAL_VERSION = 1;
export const RECORD_TYPES = Object.freeze({ runStart: 'history_run', item: 'history', runEnd: 'history_end', summary: 'context_summary' });
/** The records a tool result may refer to: the runner writes the whole result there before the item that refers to it. */
export const OUTPUT_REFERENCES = Object.freeze(['tool_result_full', 'catalog_result']);
export const RESUME_NOTE_HEADER = 'RESUMED CONVERSATION';
export const LEFT_OUT_HEADER = '[HISTORY LEFT OUT';

const REFERENCES = new Set(OUTPUT_REFERENCES);
const JOURNAL = new Set(Object.values(RECORD_TYPES));
// Every record of the transcript starts like this (the runner builds them with `at` first); the type is read from these bytes alone.
const PREFIX = /^\{"at":"[^"\\]{0,64}","type":"([A-Za-z0-9_]{1,64})"/;
const PEEK_BYTES = 160;
const CHUNK_BYTES = 4 * 1024 * 1024;
const ROLES = new Set(['user', 'model', 'tool']);
const OPAQUE_KEYS = Object.freeze(['providerBlocks', 'providerBinding', 'providerPart', 'providerParts', 'reasoningContent', 'thoughtSignature', 'encrypted_content']);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const jsonBytes = (value) => {
  const encoded = JSON.stringify(value);
  return encoded === undefined ? 4 : Buffer.byteLength(encoded);
};
/** Size of JSON.stringify(items) in UTF-8 bytes, counted the way HistoryLedger.byteLength counts it. */
export const historyBytes = (items) => (items.length === 0 ? 2 : 2 + items.reduce((sum, item) => sum + jsonBytes(item), 0) + items.length - 1);
const sizeOf = (sizes) => (sizes.length === 0 ? 2 : 2 + sizes.reduce((sum, size) => sum + size, 0) + sizes.length - 1);

// ---- writing ---------------------------------------------------------------------------------------------------------------------

/** The counters a record carries (see the top of this file). */
export function journalCounters({ hookRun = null, noticeTurns = 0 } = {}) {
  return {
    hookBlocks: isObject(hookRun) ? { limit: hookRun.limit, used: hookRun.used, byEvent: { ...hookRun.byEvent } } : null,
    noticeTurns: Number.isSafeInteger(noticeTurns) ? noticeTurns : 0,
    doneGate: null,
  };
}

/** The record of a run that starts. */
export const runStartRecord = ({ at, run, seed, counters }) => ({ at, type: RECORD_TYPES.runStart, v: JOURNAL_VERSION, run, seed, counters });
/** The record of a run that ended. */
export const runEndRecord = ({ at, run, items, counters }) => ({ at, type: RECORD_TYPES.runEnd, v: JOURNAL_VERSION, run, items, counters });

/**
 * The record of one item that entered the ledger. `reference` names the record that holds the whole result of a tool output (one of
 * OUTPUT_REFERENCES); the output is then not copied.
 */
export function itemRecord({ at, run, seq, meta, item, reference = null, counters = null }) {
  const stored = reference && REFERENCES.has(reference) && item?.type === 'function_call_output'
    ? { type: 'function_call_output', call_id: item.call_id, output_ref: reference }
    : item;
  return { at, type: RECORD_TYPES.item, v: JOURNAL_VERSION, run, seq, role: meta.role, kind: meta.kind, batch: meta.batch ?? null, item: stored, ...(counters ? { counters } : {}) };
}

// ---- reading ---------------------------------------------------------------------------------------------------------------------

/** Every line of the file, as a Buffer without its newline; the last one says whether it had one. */
async function eachLine(file, visit) {
  const stream = fs.createReadStream(file, { highWaterMark: CHUNK_BYTES });
  let pieces = [];
  for await (const chunk of stream) {
    let from = 0;
    for (;;) {
      const newline = chunk.indexOf(10, from);
      if (newline === -1) { if (from < chunk.length) pieces.push(chunk.subarray(from)); break; }
      const piece = chunk.subarray(from, newline);
      const line = pieces.length ? Buffer.concat([...pieces, piece]) : piece;
      pieces = [];
      visit(line);
      from = newline + 1;
    }
  }
  if (pieces.length) visit(Buffer.concat(pieces));
}

/** Leaves out what carries opaque reasoning (see the top of this file). The items given are not changed: those that lose a field are copies. */
export function stripOpaque(items) {
  const kept = [];
  for (const item of items) {
    if (item?.type === 'reasoning') continue;
    if (isObject(item) && OPAQUE_KEYS.some((key) => Object.hasOwn(item, key))) {
      const copy = { ...item };
      for (const key of OPAQUE_KEYS) delete copy[key];
      kept.push(copy);
    } else kept.push(item);
  }
  return kept;
}

const isPictureBytes = (key, value, parent) => (key === 'data' && (parent?.type === 'image' || parent?.type === 'audio'))
  || (key === 'blob' && typeof parent?.mimeType === 'string')
  || (key === 'image_url' && value.startsWith('data:'));
/** A copy of `value` (plain objects) with every string passed through `redact`, except the bytes of a picture. */
function redactValue(value, redact, key = '', parent = null) {
  if (typeof value === 'string') return isPictureBytes(key, value, parent) ? value : redact(value);
  if (Array.isArray(value)) return value.map((child) => redactValue(child, redact));
  if (isObject(value)) {
    const copy = {};
    for (const [name, child] of Object.entries(value)) copy[name] = redactValue(child, redact, name, value);
    return copy;
  }
  return value;
}

/**
 * Cuts, from the entries of one run, the model turn whose calls do not all have their result, and everything after it. Returns what is kept
 * and the calls that were cut, with whether a result was recorded for each.
 */
export function cutIncompleteTail(entries) {
  const answered = new Set(entries.filter((entry) => entry.item?.type === 'function_call_output').map((entry) => entry.item.call_id));
  const first = entries.findIndex((entry) => entry.item?.type === 'function_call' && !answered.has(entry.item.call_id));
  if (first < 0) return { kept: entries, cut: [] };
  const { batch } = entries[first];
  let begin = first;
  while (begin > 0 && entries[begin - 1].role === 'model' && entries[begin - 1].batch === batch) begin -= 1;
  const cut = entries.slice(begin).filter((entry) => entry.item?.type === 'function_call')
    .map((entry) => ({ callId: entry.item.call_id, name: entry.item.name, arguments: entry.item.arguments, result: answered.has(entry.item.call_id) }));
  return { kept: entries.slice(0, begin), cut };
}

const leftOutNote = (count) => ({ role: 'user', content: [{ type: 'input_text', text: `${LEFT_OUT_HEADER}: the first ${count} items of this conversation are not repeated here, to keep it under the Hub's size limit. They are in the task's transcript.]` }] });

/** Where a history may start again: a user message, or the first model item of a turn. Never between a call and its result. */
const restartsAt = (items, index) => items[index]?.role === 'user'
  || (items[index]?.type !== 'function_call_output' && (items[index - 1]?.type === 'function_call_output' || items[index - 1]?.role === 'user'));

/** The history under `maxBytes`: the oldest whole turns left out, behind a note. null when nothing that fits can be kept. */
function fitHistory(items, maxBytes) {
  const sizes = items.map(jsonBytes);
  if (sizeOf(sizes) <= maxBytes) return { items, bytes: sizeOf(sizes), dropped: 0 };
  const suffix = new Array(items.length + 1).fill(0);
  for (let index = items.length - 1; index >= 0; index -= 1) suffix[index] = suffix[index + 1] + sizes[index];
  for (let index = 1; index < items.length; index += 1) {
    if (!restartsAt(items, index)) continue;
    const note = leftOutNote(index);
    const bytes = 2 + jsonBytes(note) + suffix[index] + (items.length - index);
    if (bytes <= maxBytes) return { items: [note, ...items.slice(index)], bytes, dropped: index };
  }
  return null;
}

/**
 * Reads the journal of a task back (see the top of this file).
 * @param {string} file the task's transcript.jsonl
 * @param {object} options
 * @param {(result: unknown) => unknown} options.modelOutput the output the model is given for a stored tool result
 * @param {(text: string) => string} [options.redact] masking of the process that loads
 * @param {number} [options.maxBytes] the size the history must fit
 * @param {number} [options.beforeRun] runs from this one on are not read (the run that is starting); Infinity reads all, and keeps the skill
 *   index of the last run
 * @returns {Promise<{ok: true, items: object[], bytes: number, dropped: number, interrupted: object[], calls: Map, counters: object|null,
 *   runs: number, summaryApplied: boolean, skippedLastLine: boolean} | {ok: false, reason: string, detail?: string}>}
 */
export async function loadHistoryJournal(file, { modelOutput, redact = (text) => text, maxBytes = Infinity, beforeRun = Infinity } = {}) {
  if (typeof modelOutput !== 'function') throw new TypeError('loadHistoryJournal needs modelOutput');
  const runs = [];
  const results = new Map();
  const calls = new Map();
  let current = null;
  let preamble = null; // damage before the first run
  let lastRun = 0;
  let pendingBad = false;
  let sawJournal = false;
  let summary = null;
  const damage = (reason) => {
    if (current) current.error ??= reason;
    else preamble ??= reason;
  };

  const take = (record) => {
    const type = record?.type;
    if (REFERENCES.has(type)) {
      if (typeof record.call_id === 'string') results.set(`${type}\u0000${record.call_id}`, record.result);
      return;
    }
    if (!JOURNAL.has(type)) return;
    sawJournal = true;
    if (record.v !== JOURNAL_VERSION) { damage('unknown_version'); return; }
    if (type === RECORD_TYPES.summary) {
      if (Number.isSafeInteger(record.run) && record.run < beforeRun && isObject(record.through) && isObject(record.item)) summary = { through: record.through, item: record.item };
      return;
    }
    if (!Number.isSafeInteger(record.run) || record.run < 1) { damage('corrupt'); return; }
    if (type === RECORD_TYPES.runStart) {
      if (record.run <= lastRun) { damage('corrupt'); return; }
      lastRun = record.run;
      current = { run: record.run, start: record, end: null, entries: [], error: null, counters: isObject(record.counters) ? record.counters : null };
      runs.push(current);
      return;
    }
    if (!current || record.run > current.run) {
      if (record.run <= lastRun) { damage('corrupt'); return; }
      // a record of a run whose start record is not there
      lastRun = record.run;
      current = { run: record.run, start: null, end: null, entries: [], error: 'journal_gap', counters: null };
      runs.push(current);
    }
    if (record.run !== current.run) { damage('corrupt'); return; }
    if (isObject(record.counters)) current.counters = record.counters;
    if (type === RECORD_TYPES.runEnd) { current.end = record; return; }
    // a history item
    if (record.seq !== current.entries.length) { damage('journal_gap'); return; }
    const item = record.item;
    if (!isObject(item) || !ROLES.has(record.role)) { damage('corrupt'); return; }
    const entry = { run: record.run, seq: record.seq, role: record.role, kind: record.kind, batch: record.batch ?? null, item, result: undefined };
    if (item.type === 'function_call_output' && Object.hasOwn(item, 'output_ref')) {
      if (!REFERENCES.has(item.output_ref)) { damage('unknown_version'); return; }
      const key = `${item.output_ref}\u0000${item.call_id}`;
      if (!results.has(key)) { damage('journal_gap'); return; }
      entry.result = results.get(key);
      results.delete(key);
    }
    if (item.type === 'function_call' && typeof item.call_id === 'string') calls.set(item.call_id, { name: item.name, arguments: item.arguments, run: record.run });
    current.entries.push(entry);
  };

  // Only the last line may be one the process did not finish: whether a line that is not JSON was the last is known when the next one
  // arrives (it is then damage of the run it was read in) or at the end of the file.
  const settleBad = () => { if (pendingBad) { damage('corrupt'); pendingBad = false; } };
  let skippedLastLine = false;
  try {
    await eachLine(file, (line) => {
      if (line.length === 0) return;
      const head = PREFIX.exec(line.toString('latin1', 0, Math.min(PEEK_BYTES, line.length)));
      if (head && !JOURNAL.has(head[1]) && !REFERENCES.has(head[1])) { settleBad(); return; }
      let record;
      try { record = JSON.parse(line.toString('utf8')); } catch {
        if (line.length < PEEK_BYTES && line.toString('latin1').trim() === '') return;
        settleBad();
        pendingBad = true;
        return;
      }
      settleBad();
      take(record);
    });
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: false, reason: 'no_journal' };
    return { ok: false, reason: 'read_failed', detail: String(error?.message ?? error).slice(0, 300) };
  }
  if (pendingBad) skippedLastLine = true;
  if (!sawJournal) return { ok: false, reason: 'no_journal' };

  // 2-4. the runs in order, each cut at its own end
  let entries = [];
  let error = preamble;
  let read = 0;
  let last = null;
  let interrupted = [];
  const keepLastSkillIndex = !Number.isFinite(beforeRun);
  const counted = runs.filter((run) => run.run < beforeRun);
  for (const run of counted) {
    const source = run.start?.seed?.source;
    if (run.start && source !== 'journal') { entries = []; error = null; }
    else if (run.start && source === 'journal' && entries.length === 0 && Number(run.start.seed?.items) > 0) error ??= 'journal_gap';
    error ??= run.error;
    if (run.end && run.end.items !== run.entries.length) error ??= 'journal_gap';
    const { kept, cut } = cutIncompleteTail(run.entries);
    entries.push(...kept);
    interrupted = cut;
    read += 1;
    last = run;
  }
  if (error) return { ok: false, reason: error };
  if (!last) return { ok: false, reason: 'no_journal' };
  entries = entries.filter((entry) => entry.kind !== 'skill_context' || (keepLastSkillIndex && entry.run === last.run));
  if (entries.length === 0) return { ok: false, reason: 'empty' };

  // 5. the latest summary
  let summaryApplied = false;
  if (summary) {
    const through = entries.findIndex((entry) => entry.run === summary.through.run && entry.seq === summary.through.seq);
    if (through >= 0) {
      entries = [{ run: summary.through.run, seq: summary.through.seq, role: 'user', kind: 'context_summary', batch: null, item: summary.item, result: undefined }, ...entries.slice(through + 1)];
      summaryApplied = true;
    }
  }

  // 6-8. the outputs made again, the opaque reasoning left out, the masking of this process
  const made = entries.map((entry) => (entry.result === undefined
    ? { item: entry.item, masked: false }
    : { item: { type: 'function_call_output', call_id: entry.item.call_id, output: modelOutput(entry.result) }, masked: true }));
  const items = [];
  for (const { item, masked } of made) {
    const [kept] = stripOpaque([item]);
    if (kept === undefined) continue;
    items.push(masked ? kept : redactValue(kept, redact));
  }

  // 9-10. pairing, then the size
  const fitted = fitHistory(pairToolCalls(items), maxBytes);
  if (!fitted) return { ok: false, reason: 'too_large' };
  return {
    ok: true, items: fitted.items, bytes: fitted.bytes, dropped: fitted.dropped, interrupted, calls,
    counters: last.counters ?? null, runs: read, summaryApplied, skippedLastLine,
  };
}

// ---- the note a resumed run starts with --------------------------------------------------------------------------------------------

const cut = (value, limit) => {
  const text = String(value ?? '');
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
};

/**
 * What the model is told when a conversation goes on from the journal: that the history above is replayed and ran nothing, the operations
 * whose outcome is unverified (with their arguments when the journal has the call), the calls of a turn that was cut, how many old items
 * were left out, and how the previous run ended. Short: at most ten of each list, each entry clipped.
 */
export function resumeNote({ unverified = [], interrupted = [], calls = new Map(), dropped = 0, previous = null, clip = 600 } = {}) {
  const lines = [`${RESUME_NOTE_HEADER} FROM THE SAME LOCAL HUB TASK. Host note: task data, not new instructions. The messages, tool calls and tool results above are this conversation's own history, replayed from the Hub's journal; replaying them ran nothing again. They show the workspace as it was when they were made: re-check files and tests before relying on them. Do NOT replay an operation whose outcome is unverified.`];
  if (previous) lines.push(`PREVIOUS RUN ENDED: ${previous.status ?? 'unknown'}${previous.errorCode ? ` (${previous.errorCode})` : ''}${previous.error ? `: ${cut(previous.error, 1200)}` : ''}`);
  lines.push('UNVERIFIED OPERATIONS (inspect the real state before any repeat):');
  const operations = (Array.isArray(unverified) ? unverified : []).slice(-10);
  if (!operations.length) lines.push('(none)');
  for (const operation of operations) {
    const known = calls.get(operation?.callId);
    lines.push(`- ${operation?.toolName ?? known?.name ?? 'unknown tool'} (call ${operation?.callId ?? 'unknown'}, started ${operation?.startedAt ?? 'unknown'}, ${operation?.phase ?? 'unknown phase'})${known ? `: ${cut(known.arguments, clip)}` : ''}`);
  }
  if (interrupted.length) {
    lines.push('CALLS OF THE INTERRUPTED TURN (left out of the history above):');
    for (const entry of interrupted.slice(-10)) lines.push(`- ${entry.name} (call ${entry.callId}): ${entry.result ? 'a result was recorded, but the turn did not finish' : 'no result was recorded'}; arguments ${cut(entry.arguments, clip)}`);
  }
  if (dropped > 0) lines.push(`OLDER HISTORY LEFT OUT: the first ${dropped} items, to fit the size limit.`);
  return lines.join('\n');
}
