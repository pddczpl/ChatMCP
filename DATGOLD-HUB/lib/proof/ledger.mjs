// The proof ledger of Proof-of-Done (plan task pod-16, docs/PROOF-LEDGER.md): one append-only JSONL file per task,
// <hubDir>/proof/<taskId>.jsonl, whose lines are receipt v2 records chained by sha256.
//
// A line is the JSON text of {v, seq, prev, ts, type, record} with `,"hash":"<sha256 of that JSON text>"` put in front of its closing
// brace, then a line end. `seq` counts from 1 and `prev` is the hash of the line before (GENESIS for the first), so a change of any byte
// shows at its own line, and a line rewritten with its own hash recomputed shows at the next one. A line is committed only with its line
// end: a crash that tore the last line leaves bytes without one, which verifyChain reports (`torn_tail`) and the next append drops,
// recording what it dropped as an `uncertain` record.
//
// The chain is not a seal. The agent runs as the same Windows user as the Hub and can rewrite the whole file, hashes included; the chain
// detects only edits that leave the later lines alone, so a proof pack built on it keeps the integrity level "unconfined".
//
// Output is never stored: a check receipt holds the sha256 and the byte count of stdout and stderr and a redacted preview of at most
// 2 KiB. Every string of every record is masked by maskSecrets (lib/permissions.mjs, the masker of the approval card) before it is
// written, but for the digests and Git object ids of a check record and the tree ids of a tree or call record, which their schemas hold
// to hex. The agent's ledger is written by the proof service at the guard seam (pod-17, lib/proof/service.mjs, docs/PROOF-SERVICE.md).
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { maskSecrets } from '../permissions.mjs';
import { scrubEnv } from '../shell-runner.mjs';

export const LEDGER_VERSION = 2;
export const RECORD_TYPES = Object.freeze(['task_start', 'tree', 'call', 'check', 'permission', 'outbound', 'uncertain', 'task_end']);
export const GENESIS = '0'.repeat(64);
export const PREVIEW_BYTES = 2048;
export const COMMAND_CHARS = 4096;
export const MAX_LINE_BYTES = 65_536;
export const LEDGER_FOLDER = 'proof';
export const TORN_DETAIL = 'the last line has no line end: a write that did not finish';

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DEVICE_NAME = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i;
const HEX64 = /^[0-9a-f]{64}$/;
const TREE_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const HASH_SUFFIX = /,"hash":"([0-9a-f]{64})"\}$/;
const ENVELOPE = 'v,seq,prev,ts,type,record';
const CHECK_FIELDS = Object.freeze(['command', 'commandTruncated', 'commandSha256', 'argsSha256', 'cwd', 'shell', 'exit', 'signal', 'timedOut',
  'cancelled', 'lingering', 'stdout', 'stderr', 'toolchain', 'treeBefore', 'treeAfter', 'durationMs']);
const STREAM_FIELDS = Object.freeze(['sha256', 'bytes', 'truncated', 'preview', 'previewTruncated']);
const TOOLCHAIN_FIELDS = Object.freeze(['node', 'python', 'dotnet', 'git']);
const TREE_FIELDS = Object.freeze(['status', 'treeAlgorithm', 'objectFormat', 'tree', 'rawTree', 'full', 'engineReason', 'files', 'bytes',
  'limitations', 'takenAt', 'unbounded']);
// The records of the proof service (pod-17, lib/proof/service.mjs, docs/PROOF-SERVICE.md): a tree snapshot with what it was taken for, and
// one tool call with the trees around it. Closed like `check`, so that their tree ids can be kept whole and no field can carry output.
const TREE_RECORD_FIELDS = Object.freeze(['event', 'run', 'callId', 'tool', 'category', 'tree', 'scanMs']);
const CALL_FIELDS = Object.freeze(['run', 'callId', 'tool', 'category', 'outcome', 'treeBefore', 'treeAfter', 'changed', 'overlapped', 'scanMs', 'beforeSeq']);
// The other shape of `call`: the run of an external agent that `chatmcp verify exec` wrapped (pod-26, lib/proof/cli/exec.mjs,
// docs/PROOF-CLI.md), told apart by `kind`. Closed too: digests, counts, flags and short bounded texts, never the agent's output.
export const EXEC_CALL_KIND = 'agent_exec';
export const EXEC_CALL_FORMAT = 'chatmcp.verify-exec/1';
const EXEC_CALL_FIELDS = Object.freeze(['kind', 'format', 'command', 'commandTruncated', 'commandSha256', 'shell', 'cwd', 'agent', 'exit', 'signal', 'timedOut',
  'interrupted', 'lingering', 'stuck', 'treeLeft', 'durationMs', 'timeoutMs', 'stdout', 'stderr', 'claim', 'adapter', 'cost', 'costSource']);
const EXEC_STREAM_FIELDS = Object.freeze(['sha256', 'bytes', 'logged', 'truncated']);
const EXEC_CLAIM_FIELDS = Object.freeze(['marker', 'reason', 'rule', 'pattern', 'line', 'markerTimedOut', 'from']);
const EXEC_ADAPTER_FIELDS = Object.freeze(['name', 'version', 'checked', 'recognized', 'reason', 'isError', 'model', 'agentVersion']);
const EXEC_COST_FIELDS = Object.freeze(['currency', 'knownSubtotal', 'complete']);
// The longest text of each kind: the claim's reason (500 written) and its pattern (200 written) have room for what masking adds.
export const EXEC_CALL_TEXT = Object.freeze({ cwd: 1024, name: 256, signal: 32, claim: 1000 });
const WORD = /^[a-z][a-z0-9_]{0,31}$/;
const NAME_CHARS = 256;
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

const fault = (code, message) => Object.assign(new Error(message), { code });
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const sameFields = (value, fields) => {
  const keys = Object.keys(value);
  return keys.length === fields.length && fields.every((field) => Object.hasOwn(value, field));
};

/** sha256 in hex of bytes, or of the UTF-8 bytes of a string. */
export const sha256Hex = (data) => createHash('sha256').update(typeof data === 'string' ? Buffer.from(data, 'utf8') : data).digest('hex');

/** The hash of a command: sha256 of the UTF-8 bytes of the exact text that ran (never of its redacted form). */
export const commandSha256 = (command) => sha256Hex(String(command));

/** The hash of what a check ran with: sha256 of JSON.stringify({command, cwd, shell}), keys in that order, cwd as the run reports it. */
export const argsSha256 = ({ command, cwd, shell }) => sha256Hex(JSON.stringify({ command: String(command), cwd: String(cwd), shell: String(shell) }));

/** `<hubDir>/proof/<taskId>.jsonl`. A task id that could leave the folder or name a Windows device is refused. */
export function ledgerPath(hubDir, taskId) {
  if (typeof hubDir !== 'string' || !hubDir) throw fault('ledger_bad_task', 'a ledger needs the Hub data folder');
  if (typeof taskId !== 'string' || !TASK_ID.test(taskId) || DEVICE_NAME.test(taskId)) {
    throw fault('ledger_bad_task', `not a task id a ledger can be named after: ${JSON.stringify(String(taskId).slice(0, 60))}`);
  }
  return path.join(hubDir, LEDGER_FOLDER, `${taskId}.jsonl`);
}

/** The first `maxBytes` UTF-8 bytes of `text`, cut on a character boundary. */
function cutUtf8(text, maxBytes) {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return { text, cut: false };
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return { text: bytes.subarray(0, end).toString('utf8'), cut: true };
}

function cutChars(text, maxChars) {
  if (text.length <= maxChars) return { text, cut: false };
  let end = maxChars;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: text.slice(0, end), cut: true };
}

// The digests and Git object ids of a check record: hex the Hub computed, not text. A short registered secret occurs inside a random
// digest by chance (a 4-digit one in about one sha256 of a thousand), and masking it there would break the receipt while it hides
// nothing. They are written as they are; the schema holds each of them to hex, so no text passes through them unmasked.
const CHECK_DIGESTS = new Set([['commandSha256'], ['argsSha256'], ['stdout', 'sha256'], ['stderr', 'sha256'], ['treeBefore', 'tree'],
  ['treeBefore', 'rawTree'], ['treeAfter', 'tree'], ['treeAfter', 'rawTree']].map((at) => JSON.stringify(at)));
// The proof service's records keep their tree ids for the same reason (their schemas hold each of them to hex), and the words the Hub picks
// from fixed lists (event, category, outcome): masked, a short secret that is part of a word would leave a record its schema refuses.
const ids = (...names) => names.flatMap((name) => [[name, 'tree'], [name, 'rawTree']]);
const kept = (paths) => new Set(paths.map((at) => JSON.stringify(at)));
const KEPT_WHOLE = Object.freeze({
  check: CHECK_DIGESTS,
  tree: kept([['event'], ['category'], ...ids('tree')]),
  call: kept([['category'], ['outcome'], ...ids('treeBefore', 'treeAfter')]),
});
// exec's shape of `call` keeps its three digests and the words its schema holds to fixed values.
const EXEC_CALL_KEPT = kept([['kind'], ['format'], ['commandSha256'], ...['stdout', 'stderr'].map((stream) => [stream, 'sha256']), ['shell'], ['claim', 'marker'], ['claim', 'rule'],
  ['claim', 'from'], ['adapter', 'name'], ['adapter', 'checked'], ['adapter', 'reason'], ['cost'], ['cost', 'currency'], ['costSource']]);
const keptFor = (type, record) => (type === 'call' && record?.kind === EXEC_CALL_KIND ? EXEC_CALL_KEPT : KEPT_WHOLE[type] ?? null);

/** Every string of `value` masked, but for the strings at the paths `keep` names (JSON of the list of keys; nothing inside an array). */
const maskDeep = (value, secrets, keep = null, at = []) => {
  if (typeof value === 'string') return keep?.has(JSON.stringify(at)) ? value : maskSecrets(value, secrets);
  if (Array.isArray(value)) return value.map((item) => maskDeep(item, secrets));
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, maskDeep(item, secrets, keep, [...at, key])]));
  return value;
};

function streamReceipt(result, name, secrets) {
  const sha256 = result.outputSha256?.[name];
  const bytes = result.outputBytes?.[name];
  if (typeof sha256 !== 'string' || !HEX64.test(sha256) || !Number.isSafeInteger(bytes) || bytes < 0) {
    throw fault('ledger_bad_result', `the run reports no sha256 and byte count of ${name}`);
  }
  // Masked whole, then cut: a cut first could split a secret into a piece that no rule recognises any more.
  const preview = cutUtf8(maskSecrets(String(result[name] ?? ''), secrets), PREVIEW_BYTES);
  return { sha256, bytes, truncated: result.truncated?.[name] === true, preview: preview.text, previewTruncated: preview.cut };
}

/** What a receipt keeps of a pod-15 snapshot (lib/proof/tree-snapshot.mjs); null stays null. */
export function treeRef(snapshot) {
  if (snapshot === null || snapshot === undefined) return null;
  if (!isPlainObject(snapshot)) throw fault('ledger_bad_record', 'a tree snapshot is an object');
  return Object.fromEntries(TREE_FIELDS.map((field) => [field, snapshot[field] ?? null]));
}

/**
 * The check receipt (record type `check`) of one finished ShellRunner run. The output itself is never in it: the sha256 of every byte
 * each stream wrote, the byte count, whether the capture dropped a middle, and the first 2 KiB of the captured text, masked.
 */
export function checkReceipt({ command, result, toolchain = null, treeBefore = null, treeAfter = null, secrets = [] }) {
  if (typeof command !== 'string') throw new TypeError('checkReceipt needs the command that ran');
  if (!isPlainObject(result)) throw new TypeError('checkReceipt needs the result of ShellRunner.run()');
  const shown = cutChars(maskSecrets(command, secrets), COMMAND_CHARS);
  return {
    command: shown.text,
    commandTruncated: shown.cut,
    commandSha256: commandSha256(command),
    argsSha256: argsSha256({ command, cwd: result.cwd, shell: result.shell }),
    cwd: String(result.cwd),
    shell: String(result.shell),
    exit: Number.isInteger(result.exitCode) ? result.exitCode : null,
    signal: typeof result.signal === 'string' ? result.signal : null,
    timedOut: result.timedOut === true,
    cancelled: result.cancelled === true,
    lingering: result.lingering === true,
    stdout: streamReceipt(result, 'stdout', secrets),
    stderr: streamReceipt(result, 'stderr', secrets),
    toolchain: toolchain ? Object.fromEntries(TOOLCHAIN_FIELDS.map((name) => [name, typeof toolchain[name] === 'string' ? toolchain[name] : null])) : null,
    treeBefore: treeRef(treeBefore),
    treeAfter: treeRef(treeAfter),
    durationMs: Number.isSafeInteger(result.durationMs) && result.durationMs >= 0 ? result.durationMs : 0,
  };
}

function streamProblem(stream) {
  if (!isPlainObject(stream) || !sameFields(stream, STREAM_FIELDS)) return `fields are ${STREAM_FIELDS.join(', ')}`;
  if (typeof stream.sha256 !== 'string' || !HEX64.test(stream.sha256)) return 'sha256 is 64 hex digits';
  if (!Number.isSafeInteger(stream.bytes) || stream.bytes < 0) return 'bytes is a count';
  if (typeof stream.truncated !== 'boolean' || typeof stream.previewTruncated !== 'boolean') return 'the truncation flags are booleans';
  if (typeof stream.preview !== 'string' || Buffer.byteLength(stream.preview) > PREVIEW_BYTES) return `the preview is text of at most ${PREVIEW_BYTES} bytes`;
  return null;
}

function checkProblem(record) {
  if (!sameFields(record, CHECK_FIELDS)) return `a check record has exactly the fields ${CHECK_FIELDS.join(', ')}`;
  if (typeof record.command !== 'string' || record.command.length > COMMAND_CHARS || typeof record.commandTruncated !== 'boolean') return 'command';
  if ([record.commandSha256, record.argsSha256].some((hash) => typeof hash !== 'string' || !HEX64.test(hash))) return 'commandSha256 and argsSha256 are 64 hex digits';
  if (typeof record.cwd !== 'string' || typeof record.shell !== 'string') return 'cwd and shell are text';
  if (record.exit !== null && !Number.isInteger(record.exit)) return 'exit is an integer or null';
  if (record.signal !== null && typeof record.signal !== 'string') return 'signal is text or null';
  for (const flag of ['timedOut', 'cancelled', 'lingering']) if (typeof record[flag] !== 'boolean') return `${flag} is a boolean`;
  for (const name of ['stdout', 'stderr']) {
    const problem = streamProblem(record[name]);
    if (problem) return `${name}: ${problem}`;
  }
  if (record.toolchain !== null && (!isPlainObject(record.toolchain) || !sameFields(record.toolchain, TOOLCHAIN_FIELDS)
    || TOOLCHAIN_FIELDS.some((name) => record.toolchain[name] !== null && typeof record.toolchain[name] !== 'string'))) return `toolchain is null or {${TOOLCHAIN_FIELDS.join(', ')}}`;
  for (const name of ['treeBefore', 'treeAfter']) {
    const problem = treeRefProblem(record[name], name);
    if (problem) return problem;
  }
  if (!Number.isSafeInteger(record.durationMs) || record.durationMs < 0) return 'durationMs is a count';
  return null;
}

/** null when `ref` is null or a tree reference (treeRef) whose two ids are null or hex, else what is wrong. */
function treeRefProblem(ref, name) {
  if (ref === null) return null;
  if (!isPlainObject(ref) || !sameFields(ref, TREE_FIELDS)) return `${name} is null or a tree reference`;
  for (const id of ['tree', 'rawTree']) if (ref[id] !== null && (typeof ref[id] !== 'string' || !TREE_ID.test(ref[id]))) return `${name}.${id} is null or a Git object id in hex`;
  return null;
}

const nullableText = (value, max) => value === null || (typeof value === 'string' && value.length <= max);
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const position = (value) => Number.isSafeInteger(value) && value >= 1;

/** The schema of everything the two pod-17 records share: the run, the call (null for a snapshot of a run's start or end) and the scan time. */
function callFieldsProblem(record) {
  if (!position(record.run)) return 'run is a count from 1';
  if (!nullableText(record.callId, NAME_CHARS) || !nullableText(record.tool, NAME_CHARS)) return `callId and tool are null or text of at most ${NAME_CHARS} characters`;
  if (record.category !== null && (typeof record.category !== 'string' || !WORD.test(record.category))) return 'category is null or a word';
  if (!count(record.scanMs)) return 'scanMs is a count of milliseconds';
  return null;
}

function treeRecordProblem(record) {
  if (!sameFields(record, TREE_RECORD_FIELDS)) return `a tree record has exactly the fields ${TREE_RECORD_FIELDS.join(', ')}`;
  if (typeof record.event !== 'string' || !WORD.test(record.event)) return 'event is a word';
  if (record.tree === null) return 'tree is a tree reference';
  return callFieldsProblem(record) ?? treeRefProblem(record.tree, 'tree');
}

const isHex64 = (value) => typeof value === 'string' && HEX64.test(value);
const boundedText = (value, max, min = 0) => typeof value === 'string' && value.length >= min && value.length <= max;
const isWord = (value) => typeof value === 'string' && WORD.test(value);

/** exec's shape of `call` (kind agent_exec): what `chatmcp verify exec` records of the agent's run and its claim. */
function execCallProblem(record) {
  if (!sameFields(record, EXEC_CALL_FIELDS)) return `an exec call record has exactly the fields ${EXEC_CALL_FIELDS.join(', ')}`;
  if (record.format !== EXEC_CALL_FORMAT) return `format is ${EXEC_CALL_FORMAT}`;
  if (!boundedText(record.command, COMMAND_CHARS)) return `command is text of at most ${COMMAND_CHARS} characters`;
  if (typeof record.commandTruncated !== 'boolean') return 'commandTruncated is a boolean';
  if (!isHex64(record.commandSha256)) return 'commandSha256 is 64 hex digits';
  if (!['bash', 'sh', 'powershell'].includes(record.shell)) return 'shell is bash, sh or powershell';
  if (!boundedText(record.cwd, EXEC_CALL_TEXT.cwd)) return `cwd is text of at most ${EXEC_CALL_TEXT.cwd} characters`;
  const { agent } = record;
  if (!isPlainObject(agent) || !sameFields(agent, ['name', 'version']) || !boundedText(agent.name, EXEC_CALL_TEXT.name, 1) || !boundedText(agent.version, EXEC_CALL_TEXT.name, 1)) {
    return `agent is {name, version}, each text of 1 to ${EXEC_CALL_TEXT.name} characters`;
  }
  if (record.exit !== null && !Number.isSafeInteger(record.exit)) return 'exit is an integer or null';
  if (!nullableText(record.signal, EXEC_CALL_TEXT.signal)) return `signal is null or text of at most ${EXEC_CALL_TEXT.signal} characters`;
  for (const name of ['timedOut', 'interrupted', 'lingering', 'stuck']) if (typeof record[name] !== 'boolean') return `${name} is a boolean`;
  if (record.treeLeft !== null && typeof record.treeLeft !== 'boolean') return 'treeLeft is a boolean or null';
  if (!count(record.durationMs) || !count(record.timeoutMs)) return 'durationMs and timeoutMs are counts';
  for (const name of ['stdout', 'stderr']) {
    const stream = record[name];
    if (!isPlainObject(stream) || !sameFields(stream, EXEC_STREAM_FIELDS) || !isHex64(stream.sha256) || !count(stream.bytes) || !count(stream.logged)
      || stream.logged > stream.bytes || typeof stream.truncated !== 'boolean') return `${name} is {sha256, bytes, logged (at most bytes), truncated}`;
  }
  const { claim } = record;
  if (!isPlainObject(claim) || !sameFields(claim, EXEC_CLAIM_FIELDS)) return `claim has exactly the fields ${EXEC_CLAIM_FIELDS.join(', ')}`;
  if (!['DONE', 'BLOCKED', null].includes(claim.marker)) return 'claim.marker is DONE, BLOCKED or null';
  if ((claim.marker === 'BLOCKED') !== (claim.reason !== null)) return 'claim.reason is the reason of BLOCKED, and null otherwise';
  for (const name of ['reason', 'pattern', 'line']) if (!nullableText(claim[name], EXEC_CALL_TEXT.claim)) return `claim.${name} is null or text of at most ${EXEC_CALL_TEXT.claim} characters`;
  if (!['contract', 'claim-marker'].includes(claim.rule)) return 'claim.rule is contract or claim-marker';
  if (!['stdout', 'adapter'].includes(claim.from)) return 'claim.from is stdout or adapter';
  if (typeof claim.markerTimedOut !== 'boolean') return 'claim.markerTimedOut is a boolean';
  const { adapter } = record;
  if (adapter !== null) {
    if (!isPlainObject(adapter) || !sameFields(adapter, EXEC_ADAPTER_FIELDS)) return `adapter is null or has exactly the fields ${EXEC_ADAPTER_FIELDS.join(', ')}`;
    if (!isWord(adapter.name) || !position(adapter.version) || typeof adapter.checked !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(adapter.checked)) return 'adapter is named by a word, with its version and the day it was checked';
    if (typeof adapter.recognized !== 'boolean' || (adapter.reason !== null && !isWord(adapter.reason))) return 'adapter.recognized is a boolean and adapter.reason null or a word';
    if (adapter.isError !== null && typeof adapter.isError !== 'boolean') return 'adapter.isError is a boolean or null';
    if (!nullableText(adapter.model, EXEC_CALL_TEXT.name) || !nullableText(adapter.agentVersion, EXEC_CALL_TEXT.name)) return `adapter.model and adapter.agentVersion are null or text of at most ${EXEC_CALL_TEXT.name} characters`;
  }
  const { cost } = record;
  if (cost !== 'unknown' && !(isPlainObject(cost) && sameFields(cost, EXEC_COST_FIELDS) && typeof cost.currency === 'string' && /^[A-Z]{3}$/.test(cost.currency)
    && typeof cost.knownSubtotal === 'number' && Number.isFinite(cost.knownSubtotal) && cost.knownSubtotal >= 0 && cost.knownSubtotal <= 1e9 && typeof cost.complete === 'boolean')) {
    return 'cost is "unknown" or {currency, knownSubtotal, complete}';
  }
  if (![null, 'adapter', 'option'].includes(record.costSource)) return 'costSource is null, adapter or option';
  return null;
}

function callProblem(record) {
  // two closed shapes: exec's, named by its kind, and the guard seam's, which has no kind at all
  if (Object.hasOwn(record, 'kind')) return record.kind === EXEC_CALL_KIND ? execCallProblem(record) : `the kind of a call record is ${EXEC_CALL_KIND}, or it has none`;
  if (!sameFields(record, CALL_FIELDS)) return `a call record has exactly the fields ${CALL_FIELDS.join(', ')}`;
  if (typeof record.outcome !== 'string' || !WORD.test(record.outcome)) return 'outcome is a word';
  if (record.changed !== null && typeof record.changed !== 'boolean') return 'changed is a boolean or null';
  if (typeof record.overlapped !== 'boolean') return 'overlapped is a boolean';
  if (record.beforeSeq !== null && !position(record.beforeSeq)) return 'beforeSeq is null or a seq';
  return callFieldsProblem(record) ?? treeRefProblem(record.treeBefore, 'treeBefore') ?? treeRefProblem(record.treeAfter, 'treeAfter');
}

const SCHEMAS = Object.freeze({ check: checkProblem, tree: treeRecordProblem, call: callProblem });

/** null when `record` is a valid record of `type`, else what is wrong. `check`, `tree` and `call` have schemas of their own here. */
export function validateRecord(type, record) {
  if (!RECORD_TYPES.includes(type)) return `unknown record type ${JSON.stringify(String(type).slice(0, 40))}`;
  if (!isPlainObject(record)) return 'a record is a JSON object';
  return SCHEMAS[type]?.(record) ?? null;
}

function lineProblem(line, expectedSeq, prev) {
  const bad = (reason, detail) => ({ reason, detail });
  if (line.length > MAX_LINE_BYTES) return bad('line_too_long', `${line.length} bytes, at most ${MAX_LINE_BYTES}`);
  let text;
  try { text = UTF8.decode(line); } catch { return bad('not_utf8', 'the line is not UTF-8'); }
  const suffix = HASH_SUFFIX.exec(text);
  if (!suffix) return bad('bad_envelope', 'the line does not end with its "hash"');
  const body = `${text.slice(0, suffix.index)}}`;
  const hash = sha256Hex(body);
  if (hash !== suffix[1]) return bad('hash_mismatch', 'the line is not the text its hash was made of');
  let entry;
  try { entry = JSON.parse(body); } catch { return bad('not_json', 'the line is not JSON'); }
  if (!isPlainObject(entry) || Object.keys(entry).join(',') !== ENVELOPE) return bad('bad_envelope', `the fields are ${ENVELOPE},hash`);
  if (entry.v !== LEDGER_VERSION) return bad('bad_version', `version ${JSON.stringify(entry.v)}, this reader knows ${LEDGER_VERSION}`);
  if (entry.seq !== expectedSeq) return bad('seq_mismatch', `seq ${JSON.stringify(entry.seq)} where ${expectedSeq} was expected`);
  if (entry.prev !== prev) return bad('prev_mismatch', 'prev is not the hash of the line before');
  if (typeof entry.ts !== 'string' || !TIMESTAMP.test(entry.ts) || Number.isNaN(Date.parse(entry.ts))) return bad('bad_envelope', 'ts is not an ISO time in UTC');
  if (!RECORD_TYPES.includes(entry.type)) return bad('unknown_type', `unknown record type ${JSON.stringify(String(entry.type).slice(0, 40))}`);
  const problem = validateRecord(entry.type, entry.record);
  if (problem) return bad('bad_record', problem);
  return { reason: null, hash };
}

/**
 * Checks a ledger (bytes, or text read as its UTF-8 bytes) from its first line. Returns
 * {ok, records, lastSeq, lastHash, brokenAt, reason, detail, verifiedBytes, torn}: `brokenAt` is the seq of the first line that is not
 * what was written (the line that holds a changed byte; the line after one rewritten with its own hash recomputed), `records`,
 * `lastSeq`, `lastHash` and `verifiedBytes` describe the good prefix before it. A last line without a line end is `torn_tail`, with the
 * size and the sha256 of its bytes in `torn`.
 */
export function verifyChain(input) {
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.isBuffer(input) ? input : Buffer.from(input);
  let offset = 0;
  let seq = 0;
  let prev = GENESIS;
  const report = (fields) => ({ ok: false, records: seq, lastSeq: seq, lastHash: prev, brokenAt: seq + 1, reason: null, detail: null, verifiedBytes: offset, torn: null, ...fields });
  while (offset < bytes.length) {
    const end = bytes.indexOf(0x0a, offset);
    if (end === -1) {
      const rest = bytes.subarray(offset);
      return report({ reason: 'torn_tail', detail: TORN_DETAIL, torn: { bytes: rest.length, sha256: sha256Hex(rest) } });
    }
    const checked = lineProblem(bytes.subarray(offset, end), seq + 1, prev);
    if (checked.reason) return report({ reason: checked.reason, detail: checked.detail });
    prev = checked.hash;
    seq += 1;
    offset = end + 1;
  }
  return { ok: true, records: seq, lastSeq: seq, lastHash: prev, brokenAt: null, reason: null, detail: null, verifiedBytes: offset, torn: null };
}

// One state per file for the whole process, so two ledger objects on one file append in turn and share the chain's end. Another process
// that appends to the same file is not coordinated with (the Hub holds a lock on its data folder); a change of size is noticed and read.
const states = new Map();

export class ProofLedger {
  /**
   * @param {object} options
   * @param {string} options.file          the ledger file (ProofLedger.forTask names it)
   * @param {() => string[]} [options.secrets]  registered secret values, masked in every record with the masker's own rules
   * @param {() => Date} [options.now]     the clock of `ts`
   */
  constructor({ file, secrets = () => [], now = () => new Date() } = {}) {
    if (typeof file !== 'string' || !file) throw new TypeError('ProofLedger needs a file');
    this.file = path.resolve(file);
    this.secrets = secrets;
    this.now = now;
    this.key = process.platform === 'win32' ? this.file.toLowerCase() : this.file;
  }

  static forTask(hubDir, taskId, options = {}) {
    return new ProofLedger({ ...options, file: ledgerPath(hubDir, taskId) });
  }

  /** Appends one record; resolves with {seq, prev, hash, ts}. A refused record (`ledger_bad_record`, `ledger_record_too_large`) writes nothing. */
  async append(type, record) {
    const prepared = this.#prepare(type, record);
    return this.#enqueue((state) => this.#write(state, type, prepared));
  }

  /** verifyChain of the file as it is now (a missing file is an empty ledger). */
  async verify() {
    const bytes = await fs.readFile(this.file).catch((error) => { if (error.code === 'ENOENT') return Buffer.alloc(0); throw error; });
    return verifyChain(bytes);
  }

  #prepare(type, record) {
    if (!RECORD_TYPES.includes(type)) throw fault('ledger_bad_record', validateRecord(type, record));
    if (!isPlainObject(record)) throw fault('ledger_bad_record', 'a record is a JSON object');
    let copy;
    try { copy = JSON.parse(JSON.stringify(record)); } catch (error) { throw fault('ledger_bad_record', `the record is not JSON: ${error.message}`); }
    const masked = maskDeep(copy, this.secrets() ?? [], keptFor(type, copy));
    if (type === 'check') {
      // A secret the receipt's builder did not know can be longer once masked: the command stays within its 4,096 characters and the
      // preview within its 2 KiB.
      if (typeof masked.command === 'string') {
        const cut = cutChars(masked.command, COMMAND_CHARS);
        if (cut.cut) Object.assign(masked, { command: cut.text, commandTruncated: true });
      }
      for (const name of ['stdout', 'stderr']) {
        if (!isPlainObject(masked[name]) || typeof masked[name].preview !== 'string') continue;
        const cut = cutUtf8(masked[name].preview, PREVIEW_BYTES);
        if (cut.cut) Object.assign(masked[name], { preview: cut.text, previewTruncated: true });
      }
    }
    const problem = validateRecord(type, masked);
    if (problem) throw fault('ledger_bad_record', problem);
    return masked;
  }

  #enqueue(job) {
    let state = states.get(this.key);
    if (!state) { state = { tail: Promise.resolve(), loaded: false, seq: 0, hash: GENESIS, size: 0, mtimeMs: null, broken: null }; states.set(this.key, state); }
    const run = state.tail.then(() => job(state));
    state.tail = run.catch(() => {});
    return run;
  }

  async #write(state, type, record) {
    await this.#sync(state);
    if (state.broken) throw fault('ledger_broken', `the ledger ${path.basename(this.file)} is broken at seq ${state.broken.brokenAt} (${state.broken.reason}); nothing is appended to it`);
    return this.#appendLine(state, type, record);
  }

  /** Reads the file again when it is new to this process, or its size or modification time is not what this process left. */
  async #sync(state) {
    const stat = await fs.stat(this.file).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    const size = stat ? stat.size : 0;
    const mtimeMs = stat ? stat.mtimeMs : null;
    if (state.loaded && size === state.size && mtimeMs === state.mtimeMs) return;
    const bytes = stat ? await fs.readFile(this.file) : Buffer.alloc(0);
    const report = verifyChain(bytes);
    Object.assign(state, { loaded: true, seq: report.lastSeq, hash: report.lastHash, size: bytes.length, mtimeMs, broken: null });
    if (report.ok) return;
    if (report.reason !== 'torn_tail') { state.broken = report; return; }
    // Bytes without a line end were never a record. Only they are dropped, and the loss is recorded.
    await fs.truncate(this.file, report.verifiedBytes);
    state.size = report.verifiedBytes;
    await this.#appendLine(state, 'uncertain', { reason: 'torn_tail', bytes: report.torn.bytes, sha256: report.torn.sha256 });
  }

  async #appendLine(state, type, record) {
    const seq = state.seq + 1;
    const prev = state.hash;
    const ts = this.now().toISOString();
    const body = JSON.stringify({ v: LEDGER_VERSION, seq, prev, ts, type, record });
    const hash = sha256Hex(body);
    const line = Buffer.from(`${body.slice(0, -1)},"hash":"${hash}"}\n`, 'utf8');
    if (line.length - 1 > MAX_LINE_BYTES) throw fault('ledger_record_too_large', `a ledger line is at most ${MAX_LINE_BYTES} bytes, this one would be ${line.length - 1}`);
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const handle = await fs.open(this.file, 'a', 0o600);
    let written;
    try {
      await handle.writeFile(line);
      await handle.sync();
      written = await handle.stat();
    } finally {
      await handle.close();
    }
    Object.assign(state, { seq, hash, size: written.size, mtimeMs: written.mtimeMs });
    return { seq, prev, hash, ts };
  }
}

// ------------------------------------------------------------------ toolchain versions
const PROBES = Object.freeze([
  { name: 'node', programs: ['node'], pattern: /^v?(\d+\.\d+\.\d+[0-9A-Za-z.+-]*)\s*$/m },
  { name: 'python', programs: process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python'], pattern: /^Python (\d+\.\d+\.\d+[0-9A-Za-z.+-]*)\s*$/m },
  { name: 'dotnet', programs: ['dotnet'], pattern: /^(\d+\.\d+\.\d+[0-9A-Za-z.+-]*)\s*$/m },
  { name: 'git', programs: ['git'], pattern: /^git version (\S+)\s*$/m },
]);

const runFile = (file, args, options) => new Promise((resolve, reject) => {
  execFile(file, args, { ...options, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
    if (error) reject(Object.assign(error, { stdout, stderr })); else resolve({ stdout, stderr });
  });
});

/** The program `name` in an ABSOLUTE entry of PATH: a relative entry ("." included) would let the workspace pick the program. */
async function locate(name, env) {
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === 'PATH');
  const windows = process.platform === 'win32';
  for (const entry of String(key ? env[key] : '').split(path.delimiter)) {
    const folder = entry.trim().replace(/^"(.*)"$/, '$1');
    if (!folder || !path.isAbsolute(folder)) continue;
    const file = path.join(folder, windows ? `${name}.exe` : name);
    try {
      if (!(await fs.stat(file)).isFile()) continue;
      if (!windows) await fs.access(file, fsConstants.X_OK);
      return file;
    } catch { /* not there */ }
  }
  return null;
}

/** `--version` of node, python, dotnet and git as the agent's PATH finds them, once per workspace (global.json and the like are read from it). */
export class ToolchainProbe {
  constructor({ env = process.env, exec = runFile, timeoutMs = 10_000 } = {}) {
    this.env = env;
    this.exec = exec;
    this.timeoutMs = timeoutMs;
    this.cache = new Map();
  }

  async versions(root) {
    const folder = path.resolve(String(root));
    const key = process.platform === 'win32' ? folder.toLowerCase() : folder;
    if (!this.cache.has(key)) this.cache.set(key, this.#probe(folder));
    return { ...(await this.cache.get(key)) };
  }

  clear() { this.cache.clear(); }

  async #probe(folder) {
    const env = { ...scrubEnv(this.env), DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1' };
    const found = await Promise.all(PROBES.map(async ({ name, programs, pattern }) => [name, await this.#version(folder, env, programs, pattern)]));
    return Object.fromEntries(found);
  }

  async #version(folder, env, programs, pattern) {
    for (const program of programs) {
      const file = await locate(program, this.env);
      if (!file) continue;
      try {
        const { stdout = '', stderr = '' } = await this.exec(file, ['--version'], { cwd: folder, env, timeout: this.timeoutMs });
        const match = pattern.exec(`${stdout}\n${stderr}`);
        if (match) return match[1];
      } catch { /* a program that fails or times out has no version to report */ }
    }
    return null;
  }
}

/**
 * Runs one check and appends its receipt: a tree snapshot before and after the command (the pod-15 engine; null without a snapshotter),
 * the toolchain versions of the workspace, and the receipt of the run. Resolves with {result, receipt, entry}.
 */
export async function recordCheck({ ledger, runner, snapshotter = null, toolchain = null, command, cwd = '', shell, timeoutMs, maxOutputBytes, signal, secrets = runner?.secrets?.() ?? [] }) {
  const tree = async () => {
    if (!snapshotter) return null;
    try { return await snapshotter.snapshot({ signal }); } catch (error) {
      if (signal?.aborted) throw error;
      return { status: 'failed', engineReason: String(error?.code ?? 'snapshot_failed') };
    }
  };
  const treeBefore = await tree();
  const result = await runner.run({ command, cwd, shell, timeoutMs, maxOutputBytes, signal });
  const treeAfter = await tree();
  const versions = toolchain ? await toolchain.versions((await runner.workspace.resolve('')).root) : null;
  const receipt = checkReceipt({ command, result, toolchain: versions, treeBefore, treeAfter, secrets });
  const entry = await ledger.append('check', receipt);
  return { result, receipt, entry };
}
