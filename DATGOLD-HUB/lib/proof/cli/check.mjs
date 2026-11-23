// `chatmcp verify check <pack> [--tree]` (P5 pod-32, docs/PROOF-CLI.md, "check" and "The pack file"): the pack file that `pack` writes
// beside the statement, and the check a third party runs on it. The pack file is one line of canonical JSON (RFC 8785, the spec's own
// canonicalJson) holding the in-toto statement, its digest and the three files a statement only names by their hashes: the patch
// (change.diff), the session's ledger (ledger.jsonl) and the acceptance file of the baseline (acceptance.yml). Nothing here runs a
// command or writes a file; --tree takes one tree snapshot of the workspace into the state folder.
import fs from 'node:fs/promises';
import path from 'node:path';
import { sha256Hex, verifyChain } from '../ledger.mjs';
import { STATEMENT_TYPE, SUBJECT_NAMES, canonicalJson, statementDigest, validateStatement } from '../pack.mjs';
import { compileSchema } from '../schema-validate.mjs';
import { TreeSnapshotter } from '../tree-snapshot.mjs';
import { stop } from './codes.mjs';

/** The format of a pack file. */
export const PACK_FILE_FORMAT = 'chatmcp.proof-pack/1';
/** The largest pack file written or read: the statement (32 MiB at most) and the patch (128 MiB at most) in base64 fit with room. */
export const PACK_FILE_MAX_BYTES = 256 * 1024 * 1024;
/** The files of a pack, in the order of their names: the patch, the ledger, the acceptance file (only when the statement names one). */
export const PACK_FILE_NAMES = Object.freeze(['change.diff', 'ledger.jsonl', 'acceptance.yml']);
const SHOWN_ERRORS = 5;
const SETTLED = new Set(['evidenced', 'owner_accepted']);

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hex64 = { type: 'string', pattern: '^[0-9a-f]{64}$' };
const attached = {
  type: 'object', additionalProperties: false, required: ['sha256', 'bytes', 'base64'],
  properties: { sha256: hex64, bytes: { type: 'integer', minimum: 0 }, base64: { type: 'string', pattern: '^[A-Za-z0-9+/]*={0,2}$' } },
};
/** The JSON Schema of a pack file around its statement (the statement has its own: docs/spec/agent-change-v0.1.schema.json). */
export const PACK_FILE_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false, required: ['format', 'statement', 'statementDigest', 'files'],
  properties: {
    format: { const: PACK_FILE_FORMAT },
    statement: { type: 'object' },
    statementDigest: hex64,
    files: {
      type: 'object', additionalProperties: false, required: ['change.diff', 'ledger.jsonl'],
      properties: { 'change.diff': attached, 'ledger.jsonl': attached, 'acceptance.yml': attached },
    },
  },
});
const envelope = compileSchema(PACK_FILE_SCHEMA);
const errorsOf = (errors) => errors.slice(0, SHOWN_ERRORS).map(({ path: at, keyword, message }) => ({ path: at, keyword, message: String(message).slice(0, 300) }));

/**
 * The bytes of the pack file of a statement: canonical JSON and a line end. `acceptance` is null when the statement names no acceptance
 * file. Throws pack_too_large (exit 4) beyond `maxBytes`.
 */
export function encodePackFile({ statement, diff, ledger, acceptance = null, maxBytes = PACK_FILE_MAX_BYTES }) {
  const file = (bytes) => ({ sha256: sha256Hex(bytes), bytes: bytes.length, base64: Buffer.from(bytes).toString('base64') });
  const files = { 'change.diff': file(diff), 'ledger.jsonl': file(ledger) };
  if (acceptance) files['acceptance.yml'] = file(acceptance);
  const bytes = Buffer.from(`${canonicalJson({ format: PACK_FILE_FORMAT, statement, statementDigest: statementDigest(statement), files })}\n`, 'utf8');
  if (bytes.length > maxBytes) throw stop('pack_too_large', { bytes: bytes.length, max: maxBytes });
  return bytes;
}

const unreadable = (why, extra = {}) => stop('pack_unreadable', { why, ...extra });
const fileMismatch = (file, why, expected = null, actual = null) => stop('pack_file_mismatch', { file, why, expected, actual });
const ledgerBroken = (why, detail) => stop('pack_ledger_broken', { why, ...detail });

/** The text of the pack: UTF-8 (a byte order mark is kept, so it is refused below), its one line end (LF or CRLF) taken off. */
function textOf(bytes) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw unreadable('not_utf8'); }
  if (text.endsWith('\r\n')) return text.slice(0, -2);
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

/** The pack's files decoded and held to their recorded size and sha256; base64 must be the one form Node writes. */
function decodeFiles(files) {
  const decoded = {};
  for (const name of PACK_FILE_NAMES) {
    if (!Object.hasOwn(files, name)) continue;
    const entry = files[name];
    const bytes = Buffer.from(entry.base64, 'base64');
    if (bytes.toString('base64') !== entry.base64) throw fileMismatch(name, 'base64');
    if (bytes.length !== entry.bytes) throw fileMismatch(name, 'bytes', entry.bytes, bytes.length);
    const sha256 = sha256Hex(bytes);
    if (sha256 !== entry.sha256) throw fileMismatch(name, 'sha256', entry.sha256, sha256);
    decoded[name] = bytes;
  }
  return decoded;
}

const sameRef = (ref, recorded) => (ref === null ? recorded === null || recorded === undefined
  : isPlainObject(recorded) && ref.tree === (recorded.tree ?? null) && ref.treeAlgorithm === (recorded.treeAlgorithm ?? null) && ref.objectFormat === (recorded.objectFormat ?? null));
const sameStream = (stream, recorded) => isPlainObject(recorded) && stream.sha256 === recorded.sha256 && stream.bytes === recorded.bytes && stream.truncated === (recorded.truncated === true);

/**
 * The ledger of the pack against the statement: its whole chain verifies, the statement's summary is the chain's, and every receipt is the
 * check record of the ledger with that seq (its line hash, its time, the hashes of its command and output, its outcome and trees; the
 * texts are masked and cut in the statement, so they are not compared). Resolves the parsed entries.
 */
function bindLedger(bytes, predicate) {
  const report = verifyChain(bytes);
  if (!report.ok) throw ledgerBroken('chain', { brokenAt: report.brokenAt, reason: report.reason });
  const entries = bytes.toString('utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const checks = entries.filter((entry) => entry.type === 'check');
  const summary = predicate.ledger;
  const expected = { present: true, verified: true, records: report.records, lastHash: report.lastHash, brokenAt: null, reason: null, checks: checks.length };
  for (const [field, value] of Object.entries(expected)) {
    if (summary[field] !== value) throw ledgerBroken('summary', { field, expected: value, actual: summary[field] });
  }
  if (predicate.receipts.length + summary.omittedReceipts !== checks.length) {
    throw ledgerBroken('summary', { field: 'omittedReceipts', expected: checks.length - predicate.receipts.length, actual: summary.omittedReceipts });
  }
  const bySeq = new Map(entries.map((entry) => [entry.seq, entry]));
  for (const receipt of predicate.receipts) {
    const entry = bySeq.get(receipt.seq);
    const record = entry?.record;
    const fields = entry?.type !== 'check' ? ['type'] : [
      ['hash', receipt.hash === entry.hash], ['ts', receipt.ts === entry.ts], ['commandSha256', receipt.commandSha256 === record.commandSha256],
      ['argsSha256', receipt.argsSha256 === record.argsSha256], ['exit', receipt.exit === record.exit], ['timedOut', receipt.timedOut === record.timedOut],
      ['cancelled', receipt.cancelled === record.cancelled], ['signal', (receipt.signal === null) === (record.signal === null)], ['durationMs', receipt.durationMs === record.durationMs],
      ['stdout', sameStream(receipt.stdout, record.stdout)], ['stderr', sameStream(receipt.stderr, record.stderr)],
      ['treeBefore', sameRef(receipt.treeBefore, record.treeBefore)], ['treeAfter', sameRef(receipt.treeAfter, record.treeAfter)],
    ].filter(([, same]) => !same).map(([field]) => field);
    if (fields.length) throw ledgerBroken('receipt', { seq: receipt.seq, field: fields[0] });
  }
  return entries;
}

/**
 * Reads and checks a pack file. Throws, first failure wins: pack_unreadable (too large, not UTF-8, not JSON, a statement alone, not
 * canonical), pack_invalid (the pack's schema), pack_digest_mismatch, pack_file_mismatch (a file against its size and sha256),
 * pack_invalid (the statement against the spec's schema and rules), pack_file_mismatch (a file against the statement), pack_ledger_broken.
 * The cheap checks come first, so that a changed byte is found before the statement's rules run. Resolves {pack, statement, digest, files,
 * entries}, `files` by name ({'change.diff', 'ledger.jsonl', 'acceptance.yml'?}).
 */
export function readPackFile(bytes, { maxBytes = PACK_FILE_MAX_BYTES } = {}) {
  if (bytes.length > maxBytes) throw unreadable('too_large', { bytes: bytes.length, max: maxBytes });
  const text = textOf(bytes);
  let value;
  try { value = JSON.parse(text); } catch { throw unreadable('not_json'); }
  if (isPlainObject(value) && value._type === STATEMENT_TYPE && !Object.hasOwn(value, 'format')) throw unreadable('statement_only');
  let canonical = null;
  try { canonical = canonicalJson(value); } catch { /* a value canonical JSON refuses is not canonical */ }
  // canonical JSON has one spelling: white space, key order, number and string forms and duplicate keys all change the text
  if (canonical !== text) throw unreadable('not_canonical');
  const shape = envelope.validate(value);
  if (!shape.valid) throw stop('pack_invalid', { part: 'pack', errors: errorsOf(shape.errors) });
  const digest = statementDigest(value.statement);
  if (digest !== value.statementDigest) throw stop('pack_digest_mismatch', { recorded: value.statementDigest, computed: digest });
  const files = decodeFiles(value.files);
  const ledgerEntries = files['ledger.jsonl'];
  const checked = validateStatement(value.statement);
  if (!checked.valid) throw stop('pack_invalid', { part: 'statement', errors: errorsOf(checked.errors) });
  const { statement } = value;
  const named = statement.subject.find((subject) => subject.name === SUBJECT_NAMES.diff).digest.sha256;
  if (sha256Hex(files['change.diff']) !== named) throw fileMismatch('change.diff', 'subject', named, sha256Hex(files['change.diff']));
  const acceptanceSha = statement.predicate.acceptance.baselineSha256;
  if ((acceptanceSha === null) !== !files['acceptance.yml']) throw fileMismatch('acceptance.yml', 'presence', acceptanceSha !== null, Boolean(files['acceptance.yml']));
  if (acceptanceSha !== null && sha256Hex(files['acceptance.yml']) !== acceptanceSha) throw fileMismatch('acceptance.yml', 'statement', acceptanceSha, sha256Hex(files['acceptance.yml']));
  const entries = bindLedger(ledgerEntries, statement.predicate);
  return { pack: value, statement, digest, files, entries };
}

/** The bytes of the pack file at `file`, or bad_pack (2) when it is not a regular file. */
export async function readPackBytes(file) {
  const stat = await fs.stat(file).catch(() => null);
  if (!stat?.isFile()) throw stop('bad_pack', { path: file });
  if (stat.size > PACK_FILE_MAX_BYTES) throw unreadable('too_large', { bytes: stat.size, max: PACK_FILE_MAX_BYTES });
  return fs.readFile(file);
}

/** A subject's tree: {treeAlgorithm, objectFormat, tree} of `side` ('before' or 'after'). */
export function subjectTree(statement, side) {
  const tree = statement.subject.find((subject) => subject.name === SUBJECT_NAMES[side]).digest.gitTree;
  const { treeAlgorithm, objectFormat } = statement.predicate.trees[side];
  return { treeAlgorithm, objectFormat, tree };
}
/** True when snapshot `snap` (pod-15) is the tree `ref` names: the same algorithm, object format and id. */
export const sameTree = (snap, ref) => snap?.status === 'ok' && snap.treeAlgorithm === ref.treeAlgorithm && snap.objectFormat === ref.objectFormat && snap.tree === ref.tree;

/** chatmcp verify check (commands.mjs hands it `place`, which resolves the workspace and the state folder for --tree). */
export async function checkCommand(ctx, { place }) {
  const file = path.resolve(ctx.cwd, ctx.args.pack);
  const read = readPackFile(await readPackBytes(file));
  const { statement, digest, files } = read;
  const { predicate } = statement;
  const after = subjectTree(statement, 'after');
  let tree = null;
  if (ctx.args.options.tree) {
    const { root, state } = await place(ctx);
    const engine = after.treeAlgorithm === 'raw-v1' ? 'raw-v1' : 'auto';
    const snap = await new TreeSnapshotter({ root, stateDir: state.treeState, env: ctx.env, engine }).snapshot({ full: true });
    tree = { treeAlgorithm: snap.treeAlgorithm ?? null, objectFormat: snap.objectFormat ?? null, tree: snap.tree ?? null, matches: sameTree(snap, after) };
  }
  const criteria = predicate.criteria.map((criterion) => ({ id: criterion.id, status: criterion.status }));
  const evidenced = criteria.filter((criterion) => SETTLED.has(criterion.status)).length;
  const commit = statement.subject.find((subject) => subject.name === SUBJECT_NAMES.commit);
  const data = {
    file, format: PACK_FILE_FORMAT, digest,
    subjects: {
      before: subjectTree(statement, 'before').tree, after: after.tree, diff: sha256Hex(files['change.diff']), commit: commit ? commit.digest.gitCommit : null,
    },
    treeAlgorithm: after.treeAlgorithm, objectFormat: after.objectFormat, baseCommit: predicate.baseCommit, agent: predicate.agent,
    acceptance: { sha256: predicate.acceptance.baselineSha256, trusted: predicate.acceptance.trusted, edited: predicate.acceptance.edited },
    criteria, receipts: predicate.receipts.length, ledger: { records: predicate.ledger.records, lastHash: predicate.ledger.lastHash },
    files: PACK_FILE_NAMES.filter((name) => files[name]).sort().map((name) => ({ name, sha256: sha256Hex(files[name]), bytes: files[name].length })),
    tree,
  };
  let code = criteria.length > 0 && evidenced === criteria.length ? 'pack_verified' : 'pack_not_evidenced';
  if (tree && !tree.matches) code = 'tree_mismatch';
  return {
    code, data,
    params: { total: criteria.length, notEvidenced: criteria.length - evidenced, actual: tree?.tree ?? null, expected: after.tree },
    lines: [
      ...criteria.map((criterion) => `  ${criterion.id}: ${criterion.status}`),
      `  ${predicate.receipts.length} receipts, ledger of ${predicate.ledger.records} records; statement ${digest}`,
      ...(tree ? [`  workspace tree ${tree.tree ?? 'unknown'}: ${tree.matches ? 'the pack\'s final tree' : `not the pack's final tree ${after.tree}`}`] : []),
    ],
  };
}
