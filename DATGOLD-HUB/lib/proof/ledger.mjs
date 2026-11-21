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
// written, but for the digests and Git object ids of a check record, which its schema holds to hex. Nothing in the agent writes a
// ledger yet: the wiring is pod-17's.
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
    const ref = record[name];
    if (ref === null) continue;
    if (!isPlainObject(ref) || !sameFields(ref, TREE_FIELDS)) return `${name} is null or a tree reference`;
    for (const id of ['tree', 'rawTree']) if (ref[id] !== null && (typeof ref[id] !== 'string' || !TREE_ID.test(ref[id]))) return `${name}.${id} is null or a Git object id in hex`;
  }
  if (!Number.isSafeInteger(record.durationMs) || record.durationMs < 0) return 'durationMs is a count';
  return null;
}

/** null when `record` is a valid record of `type`, else what is wrong. Only `check` has a schema of its own here. */
export function validateRecord(type, record) {
  if (!RECORD_TYPES.includes(type)) return `unknown record type ${JSON.stringify(String(type).slice(0, 40))}`;
  if (!isPlainObject(record)) return 'a record is a JSON object';
  return type === 'check' ? checkProblem(record) : null;
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
    const masked = maskDeep(copy, this.secrets() ?? [], type === 'check' ? CHECK_DIGESTS : null);
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
