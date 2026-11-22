// The proof pack of Proof-of-Done (plan task pod-29, docs/spec/agent-change-v0.1.md): an in-toto Statement v1 whose predicate, the
// agent-change predicate v0.1, says what an agent changed and what is known about each acceptance criterion of the task.
//
// buildAgentChangeStatement() is pure: data in, a Statement out. It reads the outputs of the merged Proof-of-Done pieces and nothing
// else - the tree snapshots of pod-15 (./tree-snapshot.mjs), the bytes of a pod-16 ledger (./ledger.mjs, checked with verifyChain), the
// result of pod-20's resolveAcceptance (./acceptance.mjs) and the report of pod-22's detectCheckChanges (./tamper.mjs) - and computes
// no hash of the workspace itself, runs nothing and writes nothing. Where an input is missing the criterion is `unverified`, never
// `evidenced`. Nothing in the agent or the Hub calls this module yet: pod-33 stores packs, pod-30 renders them, pod-32 verifies them.
//
// The pack is unsigned in v0.1 (a DSSE envelope comes later) and its integrity level is "unconfined": the agent runs as the same
// Windows user as the Hub and could rewrite every input. The predicate is versioned; its fields will change after outside feedback.
//
// canonicalJson() is the byte form a digest is taken of: RFC 8785 (JSON Canonicalization Scheme) for the values a statement holds.
import { createHash } from 'node:crypto';
import { maskSecrets } from '../permissions.mjs';
import { GENESIS, verifyChain } from './ledger.mjs';
import { CHECK_CHANGES_FORMAT, LIMITATION_CODES } from './tamper.mjs';
import { LIMITATION, TREE_ALGORITHM } from './tree-snapshot.mjs';
import { compileSchema } from './schema-validate.mjs';

export const STATEMENT_TYPE = 'https://in-toto.io/Statement/v1';
const SPEC_BASE = 'https://github.com/pddczpl/ChatMCP/blob/main/docs/spec/';
export const PREDICATE_TYPE = `${SPEC_BASE}agent-change-v0.1.md`;
export const SCHEMA_ID = `${SPEC_BASE}agent-change-v0.1.schema.json`;

/** The status of a criterion; docs/spec/agent-change-v0.1.md says when each one is given. */
export const CRITERION_STATUS = Object.freeze(['evidenced', 'owner_accepted', 'unverified', 'failed', 'stale', 'checks_modified']);
/** The result of one check of a criterion. */
export const CHECK_RESULTS = Object.freeze(['passed', 'failed', 'repeats_short', 'stale', 'tree_unknown', 'not_run']);
/** Why a criterion has its status. */
export const REASON_CODES = Object.freeze(['owner_accepted', 'owner_accepted_other_tree', 'check_failed', 'check_repeats_short', 'check_stale',
  'check_tree_unknown', 'check_not_run', 'checks_modified', 'acceptance_untrusted', 'check_changes_unknown', 'ledger_not_verified', 'manual_not_accepted']);
export const SUBJECT_NAMES = Object.freeze({ before: 'workspace-tree-before', after: 'workspace-tree-after', diff: 'change.diff', commit: 'git-commit' });
/** The bounds of a pack. A caller may lower the first four (`limits`), never raise them: the schema's bounds are made of them. */
export const PACK_LIMITS = Object.freeze({
  maxReceiptsPerCheck: 10, // receipts a check lists: its latest ones on the final tree, else its latest ones at all
  maxOtherReceipts: 1000, // receipts no check lists (other commands the agent ran), latest first; the rest are counted
  maxUncertain: 500, // uncertain events listed, in ledger order; the rest are counted
  maxReasons: 64, // reasons listed per criterion; the rest are counted
  maxDepth: 32, // nesting of a value canonicalJson accepts (a statement is about 8 deep)
  maxBytes: 32 * 1024 * 1024, // canonical JSON of one statement
});
const LOWERABLE = ['maxReceiptsPerCheck', 'maxOtherReceipts', 'maxUncertain', 'maxReasons'];
const MAX_CRITERIA = 100; // ACCEPTANCE_LIMITS of pod-20: criteria per file, checks per criterion
const MAX_CHECKS = 20;
const MAX_LOCKFILES = 2000; // lockfiles of the pod-22 report listed, in its (path) order
const TEXT = Object.freeze({ agentName: 100, version: 64, model: 200, command: 8192, cwd: 1024, shell: 32, signal: 32, detail: 600, path: 1024, engineReason: 512, toolchain: 100 });
const PACK_LIMITATIONS = Object.freeze(['unsigned', 'integrity-unconfined', 'ledger-end-not-anchored']);
const EXCLUDED_CLASSES = Object.freeze(['protected-files', 'runs-folder', 'untracked-ignored-paths', 'nested-repository-content']);
const TREE_LIMITATIONS = Object.freeze(Object.values(LIMITATION));
const TREE_ALGORITHMS = Object.freeze(Object.values(TREE_ALGORITHM));
const PERMISSION_DECISIONS = Object.freeze(['approved', 'denied', 'expired', 'cancelled', 'blocked', 'policy']); // PermissionGate history (lib/permissions.mjs)
const LEDGER_REASONS = Object.freeze(['line_too_long', 'not_utf8', 'bad_envelope', 'hash_mismatch', 'not_json', 'bad_version', 'seq_mismatch', 'prev_mismatch',
  'unknown_type', 'bad_record', 'torn_tail']);
const LOCKFILE_STATUS = Object.freeze(['unchanged', 'modified', 'added', 'deleted']);
// A criterion whose reasons hold one of these is not evidenced, whatever its checks did.
const BLOCKING = Object.freeze(['acceptance_untrusted', 'check_changes_unknown', 'ledger_not_verified']);

const HEX64 = '^[0-9a-f]{64}$';
const GIT_ID = '^(?:[0-9a-f]{40}|[0-9a-f]{64})$';
const TIMESTAMP = '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]{1,9})?Z$';
const ref = (name) => ({ $ref: `#/$defs/${name}` });
const closed = (properties, extra = {}) => ({ type: 'object', required: Object.keys(properties), additionalProperties: false, properties, ...extra });
const text = (maxLength, extra = {}) => ({ type: 'string', maxLength, ...extra });
const textOrNull = (maxLength) => ({ type: ['string', 'null'], maxLength });
const list = (items, maxItems, extra = {}) => ({ type: 'array', maxItems, ...extra, items });
const deepFreeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const item of Object.values(value)) deepFreeze(item); }
  return value;
};

/** The JSON Schema (draft 2020-12) of a statement; docs/spec/agent-change-v0.1.schema.json is this object, written with two-space indents. */
export const AGENT_CHANGE_SCHEMA = deepFreeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: SCHEMA_ID,
  title: 'DatGold agent-change predicate v0.1 in an in-toto Statement v1',
  description: 'What an agent changed in a workspace and what is known about each acceptance criterion of the task. Versioned: the fields will change after outside feedback.',
  $comment: 'Apache-2.0, like the DatGold repository. Unsigned in v0.1 (a DSSE envelope comes later); integrity level unconfined. The rules a schema cannot say (unique subject names, digest lengths, statuses that follow from the listed facts) are in docs/spec/agent-change-v0.1.md, section "Rules beyond the schema".',
  type: 'object',
  required: ['_type', 'subject', 'predicateType', 'predicate'],
  additionalProperties: false,
  properties: {
    _type: { const: STATEMENT_TYPE },
    subject: list(ref('subject'), 4, { minItems: 3 }),
    predicateType: { const: PREDICATE_TYPE },
    predicate: ref('predicate'),
  },
  $defs: {
    hex64: { type: 'string', pattern: HEX64 },
    hex64OrNull: { type: ['string', 'null'], pattern: HEX64 },
    gitId: { type: 'string', pattern: GIT_ID },
    gitIdOrNull: { type: ['string', 'null'], pattern: GIT_ID },
    count: { type: 'integer', minimum: 0 },
    seq: { type: 'integer', minimum: 1 },
    timestamp: { type: 'string', maxLength: 40, pattern: TIMESTAMP },
    treeAlgorithm: { enum: TREE_ALGORITHMS },
    objectFormat: { enum: ['sha1', 'sha256'] },
    subject: closed({
      name: { enum: Object.values(SUBJECT_NAMES) },
      digest: closed({ gitTree: ref('gitId'), gitCommit: ref('gitId'), sha256: ref('hex64') }, { required: [], minProperties: 1, maxProperties: 1 }),
    }),
    tree: closed({
      treeAlgorithm: ref('treeAlgorithm'),
      objectFormat: ref('objectFormat'),
      engineReason: textOrNull(TEXT.engineReason),
      ignoreRules: { enum: ['git', 'none'] },
      files: ref('count'),
      bytes: ref('count'),
      limitations: list({ enum: TREE_LIMITATIONS }, TREE_LIMITATIONS.length, { uniqueItems: true }),
    }),
    reason: closed({
      code: { enum: REASON_CODES },
      check: { type: ['integer', 'null'], minimum: 0, maximum: MAX_CHECKS - 1 },
      detail: textOrNull(TEXT.detail),
    }),
    check: closed({
      index: { type: 'integer', minimum: 0, maximum: MAX_CHECKS - 1 },
      run: text(TEXT.command),
      cwd: text(TEXT.cwd),
      commandSha256: ref('hex64'),
      expectExit: { type: 'integer', minimum: 0, maximum: 255 },
      repeat: { type: 'integer', minimum: 1, maximum: MAX_CHECKS },
      result: { enum: CHECK_RESULTS },
      passes: ref('count'),
      receipts: list(ref('seq'), PACK_LIMITS.maxReceiptsPerCheck, { uniqueItems: true }),
    }),
    criterion: closed({
      id: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{0,63}$' },
      kind: { enum: ['checks', 'manual'] },
      status: { enum: CRITERION_STATUS },
      checks: list(ref('check'), MAX_CHECKS),
      reasons: list(ref('reason'), PACK_LIMITS.maxReasons),
      omittedReasons: ref('count'),
    }),
    stream: closed({ sha256: ref('hex64'), bytes: ref('count'), truncated: { type: 'boolean' } }),
    treeRef: {
      type: ['object', 'null'],
      required: ['treeAlgorithm', 'objectFormat', 'tree'],
      additionalProperties: false,
      properties: { treeAlgorithm: { enum: [...TREE_ALGORITHMS, null] }, objectFormat: { enum: ['sha1', 'sha256', null] }, tree: ref('gitIdOrNull') },
    },
    toolchain: {
      type: ['object', 'null'],
      required: ['node', 'python', 'dotnet', 'git'],
      additionalProperties: false,
      properties: Object.fromEntries(['node', 'python', 'dotnet', 'git'].map((name) => [name, textOrNull(TEXT.toolchain)])),
    },
    receipt: closed({
      seq: ref('seq'),
      hash: ref('hex64'),
      ts: ref('timestamp'),
      command: text(TEXT.command),
      commandTruncated: { type: 'boolean' },
      commandSha256: ref('hex64'),
      argsSha256: ref('hex64'),
      cwd: text(TEXT.cwd),
      shell: text(TEXT.shell),
      exit: { type: ['integer', 'null'] },
      signal: textOrNull(TEXT.signal),
      timedOut: { type: 'boolean' },
      cancelled: { type: 'boolean' },
      stdout: ref('stream'),
      stderr: ref('stream'),
      treeBefore: ref('treeRef'),
      treeAfter: ref('treeRef'),
      toolchain: ref('toolchain'),
      durationMs: ref('count'),
    }),
    predicate: closed({
      agent: closed({ name: text(TEXT.agentName, { minLength: 1 }), version: text(TEXT.version, { minLength: 1 }) }),
      model: closed({ provider: textOrNull(TEXT.model), id: textOrNull(TEXT.model), profileRevision: textOrNull(TEXT.model) }),
      baseCommit: ref('gitIdOrNull'),
      trees: closed({ before: ref('tree'), after: ref('tree') }),
      excludedPaths: closed({
        classes: list({ enum: EXCLUDED_CLASSES }, EXCLUDED_CLASSES.length, { uniqueItems: true }),
        protected: ref('count'),
        runs: ref('count'),
        gitlinks: ref('count'),
      }),
      lockfiles: list(closed({
        path: text(TEXT.path, { minLength: 1 }),
        status: { enum: LOCKFILE_STATUS },
        sha256Before: ref('hex64OrNull'),
        sha256After: ref('hex64OrNull'),
      }), MAX_LOCKFILES),
      acceptance: closed({ baselineSha256: ref('hex64OrNull'), trusted: { type: 'boolean' }, edited: { type: 'boolean' } }),
      checkChanges: closed({ reported: { type: 'boolean' }, checksModified: { type: 'boolean' } }),
      criteria: list(ref('criterion'), MAX_CRITERIA),
      receipts: list(ref('receipt'), MAX_CRITERIA * MAX_CHECKS * PACK_LIMITS.maxReceiptsPerCheck + PACK_LIMITS.maxOtherReceipts),
      ledger: closed({
        present: { type: 'boolean' },
        verified: { type: 'boolean' },
        records: ref('count'),
        lastHash: ref('hex64'),
        brokenAt: { type: ['integer', 'null'], minimum: 1 },
        reason: { enum: [...LEDGER_REASONS, null] },
        checks: ref('count'),
        omittedReceipts: ref('count'),
        omittedUncertain: ref('count'),
      }),
      permissions: closed(Object.fromEntries(['records', ...PERMISSION_DECISIONS, 'other'].map((name) => [name, ref('count')]))),
      uncertain: list(closed({ seq: ref('seq'), reason: { type: 'string', pattern: '^[a-z0-9_]{1,64}$' } }), PACK_LIMITS.maxUncertain),
      cost: {
        oneOf: [
          { const: 'unknown' },
          closed({ currency: { type: 'string', pattern: '^[A-Z]{3}$' }, knownSubtotal: { type: 'number', minimum: 0, maximum: 1e9 }, complete: { type: 'boolean' } }),
        ],
      },
      integrity: closed({ level: { const: 'unconfined' }, signed: { const: false } }),
      limitations: list({ enum: [...PACK_LIMITATIONS, ...LIMITATION_CODES] }, PACK_LIMITATIONS.length + LIMITATION_CODES.length, { uniqueItems: true }),
    }),
  },
});

// ------------------------------------------------------------------ canonical JSON (RFC 8785) and the digest
export class PackError extends Error {
  constructor(code, message, errors = undefined) {
    super(message);
    this.name = 'PackError';
    this.code = code;
    if (errors) this.errors = errors;
  }
}
const fault = (code, message) => new PackError(code, message);
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

function encode(value, depth) {
  if (depth > PACK_LIMITS.maxDepth) throw fault('canonical_too_deep', `a value nested deeper than ${PACK_LIMITS.maxDepth} levels`);
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean': return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw fault('canonical_bad_value', `${value} is not a JSON number`);
      return JSON.stringify(value); // ECMAScript Number::toString, as RFC 8785 section 3.2.2.3 says; -0 is "0"
    case 'string':
      if (!value.isWellFormed()) throw fault('canonical_bad_value', 'a text with a lone surrogate has no UTF-8 form');
      return JSON.stringify(value); // the escapes of RFC 8785 section 3.2.2.2 are those of JSON.stringify
    case 'object': {
      if (Array.isArray(value)) {
        const items = [];
        // a hole reads as undefined, which is refused below like any undefined
        for (let index = 0; index < value.length; index += 1) items.push(encode(value[index], depth + 1));
        return `[${items.join(',')}]`;
      }
      if (!isPlainObject(value)) throw fault('canonical_bad_value', `a ${value.constructor?.name ?? 'non-plain'} object is not JSON`);
      // Array.prototype.sort without a comparator orders strings by UTF-16 code units: RFC 8785 section 3.2.3.
      const keys = Object.keys(value).sort();
      return `{${keys.map((key) => {
        if (!key.isWellFormed()) throw fault('canonical_bad_value', 'a key with a lone surrogate has no UTF-8 form');
        return `${JSON.stringify(key)}:${encode(value[key], depth + 1)}`;
      }).join(',')}}`;
    }
    default:
      throw fault('canonical_bad_value', `a ${typeof value} is not JSON`);
  }
}

/** The canonical JSON text of a JSON value (RFC 8785): no white space, keys in UTF-16 code unit order, ECMAScript number form. */
export const canonicalJson = (value) => encode(value, 0);

const sha256Hex = (data) => createHash('sha256').update(typeof data === 'string' ? Buffer.from(data, 'utf8') : data).digest('hex');

/** sha256 in hex of the UTF-8 bytes of the canonical JSON of a statement: the same statement gives the same digest, whatever its key order. */
export const statementDigest = (statement) => sha256Hex(canonicalJson(statement));

// ------------------------------------------------------------------ the status of a criterion
/**
 * The status that follows from the listed facts of a criterion, first match wins:
 * the owner accepted it for the final tree; a check failed on the final tree; the checks were modified; every check passed on the final
 * tree with nothing missing; some evidence is for another tree; else unverified. The builder and validateStatement both use it.
 */
function statusOf(kind, results, codes) {
  if (codes.has('owner_accepted')) return 'owner_accepted';
  if (results.includes('failed')) return 'failed';
  if (codes.has('checks_modified')) return 'checks_modified';
  if (kind === 'checks' && results.length > 0 && results.every((result) => result === 'passed') && !BLOCKING.some((code) => codes.has(code))) return 'evidenced';
  if (results.includes('stale') || codes.has('owner_accepted_other_tree')) return 'stale';
  return 'unverified';
}

const normalCwd = (cwd) => String(cwd ?? '').replaceAll('\\', '/').replace(/^(?:\.\/)+/, '').replace(/\/+$/, '') || '.';
const sameTree = (ref, tree) => ref !== null && ref.tree !== null && ref.treeAlgorithm === tree.treeAlgorithm && ref.objectFormat === tree.objectFormat;
const passed = (receipt, expectExit) => receipt.exit === expectExit && !receipt.timedOut && !receipt.cancelled && receipt.signal === null;
function failure(receipt, expectExit) {
  if (receipt.timedOut) return 'timed out';
  if (receipt.cancelled) return 'cancelled';
  if (receipt.signal !== null) return `ended by signal ${receipt.signal}`;
  return `exit ${receipt.exit === null ? 'unknown' : receipt.exit}, expected ${expectExit}`;
}

/** One check of a criterion against the receipts: its result, how many runs passed on the final tree, the receipts it lists. */
function evaluateCheck(check, index, context) {
  const run = String(check.run);
  const hash = sha256Hex(run);
  const cwd = normalCwd(check.cwd ?? '.');
  const expectExit = Number.isSafeInteger(check.expect?.exit) ? check.expect.exit : 0;
  const repeat = Number.isSafeInteger(check.repeat) && check.repeat >= 1 ? check.repeat : 1;
  const matching = (context.byCommand.get(hash) ?? []).filter((receipt) => receipt.cwd === cwd);
  const current = matching.filter((receipt) => sameTree(receipt.treeBefore, context.after) && receipt.treeBefore.tree === context.after.tree);
  const passes = current.filter((receipt) => passed(receipt, expectExit)).length;
  let result;
  let reason = null;
  if (current.length > passes) {
    result = 'failed';
    reason = { code: 'check_failed', detail: failure(current.findLast((receipt) => !passed(receipt, expectExit)), expectExit) };
  } else if (passes >= repeat) result = 'passed';
  else if (passes > 0) { result = 'repeats_short'; reason = { code: 'check_repeats_short', detail: `${passes} of ${repeat} runs passed on the final tree` }; }
  else if (matching.some((receipt) => sameTree(receipt.treeBefore, context.after))) {
    result = 'stale';
    reason = { code: 'check_stale', detail: `ran on tree ${matching.findLast((receipt) => sameTree(receipt.treeBefore, context.after)).treeBefore.tree}, not the final tree` };
  } else if (matching.length) { result = 'tree_unknown'; reason = { code: 'check_tree_unknown', detail: 'ran on a tree that cannot be compared with the final tree' }; }
  else { result = 'not_run'; reason = { code: 'check_not_run', detail: null }; }
  const listed = (current.length ? current : matching).slice(-context.limits.maxReceiptsPerCheck).map((receipt) => receipt.seq);
  return {
    check: { index, run: context.text(run, TEXT.command).text, cwd: context.text(cwd, TEXT.cwd).text, commandSha256: hash, expectExit, repeat, result, passes, receipts: listed },
    reason: reason && { code: reason.code, check: index, detail: reason.detail === null ? null : context.text(reason.detail, TEXT.detail).text },
  };
}

function evaluateCriterion(criterion, context) {
  const id = String(criterion.id);
  const reasons = [];
  const owner = context.owners.get(id) ?? null;
  const ownerCurrent = owner !== null && owner.treeAlgorithm === context.after.treeAlgorithm && owner.tree === context.after.tree;
  if (owner) reasons.push({ code: ownerCurrent ? 'owner_accepted' : 'owner_accepted_other_tree', check: null, detail: context.text(`by ${owner.by} at ${owner.at}`, TEXT.detail).text });
  const evaluated = (Array.isArray(criterion.checks) ? criterion.checks : []).map((check, index) => evaluateCheck(check, index, context));
  const kind = evaluated.length ? 'checks' : 'manual';
  for (const { reason } of evaluated) if (reason) reasons.push(reason);
  const row = context.changes ? context.changes.get(id) : undefined;
  if (kind === 'checks') {
    if (!context.trusted) reasons.push({ code: 'acceptance_untrusted', check: null, detail: null });
    if (!row) reasons.push({ code: 'check_changes_unknown', check: null, detail: null });
    if (!context.ledger.verified) reasons.push({ code: 'ledger_not_verified', check: null, detail: null });
  } else if (!owner) reasons.push({ code: 'manual_not_accepted', check: null, detail: null });
  // Last, as they can be many (one per finding of pod-22): only they are ever cut by maxReasons, so every other code stays listed.
  if (row?.checks_modified === true) {
    const found = Array.isArray(row.reasons) && row.reasons.length ? row.reasons : [{}];
    for (const item of found) {
      const detail = item.code ? `${item.code} ${item.path ?? ''}`.trim() : null;
      reasons.push({ code: 'checks_modified', check: null, detail: detail === null ? null : context.text(detail, TEXT.detail).text });
    }
  }
  const checks = evaluated.map((item) => item.check);
  const status = statusOf(kind, checks.map((check) => check.result), new Set(reasons.map((reason) => reason.code)));
  const kept = reasons.slice(0, context.limits.maxReasons);
  return { id, kind, status, checks, reasons: kept, omittedReasons: reasons.length - kept.length };
}

// ------------------------------------------------------------------ reading the inputs
const HEX64_RE = new RegExp(HEX64);
const GIT_ID_RE = new RegExp(GIT_ID);
const TIMESTAMP_RE = new RegExp(TIMESTAMP);
const idLength = (objectFormat) => (objectFormat === 'sha1' ? 40 : 64);
const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);

function readTree(snapshot, side) {
  const bad = (why) => fault('pack_bad_input', `trees.${side}: ${why}`);
  if (!isPlainObject(snapshot)) throw bad('a tree snapshot of lib/proof/tree-snapshot.mjs is required');
  if (snapshot.status !== 'ok') throw bad(`a snapshot with status ${JSON.stringify(snapshot.status)} has no tree id`);
  if (!TREE_ALGORITHMS.includes(snapshot.treeAlgorithm)) throw bad(`unknown tree algorithm ${JSON.stringify(snapshot.treeAlgorithm)}`);
  if (!['sha1', 'sha256'].includes(snapshot.objectFormat)) throw bad(`unknown object format ${JSON.stringify(snapshot.objectFormat)}`);
  if (typeof snapshot.tree !== 'string' || !GIT_ID_RE.test(snapshot.tree) || snapshot.tree.length !== idLength(snapshot.objectFormat)) throw bad(`the tree id is not a ${snapshot.objectFormat} id in hex`);
  return snapshot;
}

function readCost(cost) {
  if (cost === null || cost === undefined) return 'unknown';
  if (!isPlainObject(cost)) throw fault('pack_bad_input', 'cost is null (unknown) or {currency, knownSubtotal, complete}');
  const { currency, knownSubtotal, complete } = cost;
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) throw fault('pack_bad_input', 'cost.currency is three capital letters (ISO 4217)');
  if (typeof knownSubtotal !== 'number' || !Number.isFinite(knownSubtotal) || knownSubtotal < 0 || knownSubtotal > 1e9) throw fault('pack_bad_input', 'cost.knownSubtotal is a finite number from 0 to 1e9');
  if (typeof complete !== 'boolean') throw fault('pack_bad_input', 'cost.complete is a boolean');
  return { currency, knownSubtotal, complete };
}

function readOwners(list) {
  if (list === null || list === undefined) return new Map();
  if (!Array.isArray(list)) throw fault('pack_bad_input', 'ownerAcceptances is a list');
  const owners = new Map();
  for (const [index, row] of list.entries()) {
    const bad = (why) => fault('pack_bad_input', `ownerAcceptances[${index}]: ${why}`);
    if (!isPlainObject(row) || typeof row.criterionId !== 'string') throw bad('{criterionId, treeAlgorithm, tree, by, at} is required');
    if (!TREE_ALGORITHMS.includes(row.treeAlgorithm)) throw bad('treeAlgorithm names the algorithm of the tree the owner saw');
    if (typeof row.tree !== 'string' || !GIT_ID_RE.test(row.tree)) throw bad('tree is a Git tree id in hex');
    if (typeof row.by !== 'string' || !row.by) throw bad('by names who accepted');
    if (typeof row.at !== 'string' || !TIMESTAMP_RE.test(row.at)) throw bad('at is an ISO time in UTC');
    owners.set(row.criterionId, row); // the last one given for a criterion counts
  }
  return owners;
}

const toolchainOf = (value, context) => (isPlainObject(value)
  ? Object.fromEntries(['node', 'python', 'dotnet', 'git'].map((name) => [name, typeof value[name] === 'string' ? context.text(value[name], TEXT.toolchain).text : null]))
  : null);
const treeRefOf = (ref) => (isPlainObject(ref)
  ? {
    treeAlgorithm: TREE_ALGORITHMS.includes(ref.treeAlgorithm) ? ref.treeAlgorithm : null,
    objectFormat: ['sha1', 'sha256'].includes(ref.objectFormat) ? ref.objectFormat : null,
    tree: typeof ref.tree === 'string' && GIT_ID_RE.test(ref.tree) ? ref.tree : null,
  }
  : null);

/** The verified prefix of a ledger (verifyChain of ./ledger.mjs): its summary and its records, parsed from the lines that verified. */
function readLedger(input) {
  if (input === null || input === undefined) return { summary: { present: false, verified: false, records: 0, lastHash: GENESIS, brokenAt: null, reason: null }, entries: [] };
  if (!(typeof input === 'string' || input instanceof Uint8Array)) throw fault('pack_bad_input', 'ledger is the bytes (or text) of a proof ledger, or null');
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const report = verifyChain(bytes);
  const entries = bytes.subarray(0, report.verifiedBytes).toString('utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return {
    summary: { present: true, verified: report.ok, records: report.records, lastHash: report.lastHash, brokenAt: report.brokenAt, reason: report.reason },
    entries,
  };
}

function receiptOf(entry, context) {
  const record = entry.record;
  const command = context.text(record.command, TEXT.command);
  const stream = (value) => ({ sha256: value.sha256, bytes: value.bytes, truncated: value.truncated === true });
  return {
    seq: entry.seq,
    hash: entry.hash,
    ts: entry.ts,
    command: command.text,
    commandTruncated: record.commandTruncated === true || command.cut,
    commandSha256: record.commandSha256,
    argsSha256: record.argsSha256,
    cwd: context.text(normalCwd(record.cwd), TEXT.cwd).text,
    shell: context.text(record.shell, TEXT.shell).text,
    exit: record.exit,
    signal: record.signal === null ? null : context.text(record.signal, TEXT.signal).text,
    timedOut: record.timedOut,
    cancelled: record.cancelled,
    stdout: stream(record.stdout),
    stderr: stream(record.stderr),
    treeBefore: treeRefOf(record.treeBefore),
    treeAfter: treeRefOf(record.treeAfter),
    toolchain: toolchainOf(record.toolchain, context),
    durationMs: record.durationMs,
  };
}

/** The first `max` characters of `value`, without cutting a surrogate pair. */
function cut(value, max) {
  if (value.length <= max) return { text: value, cut: false };
  let end = max;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: value.slice(0, end), cut: true };
}

/**
 * Builds the Statement. Inputs (docs/spec/agent-change-v0.1.md, "Inputs"):
 *   agent {name, version}; model {provider, id, profileRevision} (each text or null); baseCommit and commit (a Git id or null; commit
 *   adds the git-commit subject); trees {before, after} (pod-15 snapshots); diff (the bytes or text of the change); acceptance (pod-20
 *   resolveAcceptance result, or null); checkChanges (pod-22 detectCheckChanges report, or null); ledger (the bytes of a pod-16 ledger,
 *   or null); ownerAcceptances [{criterionId, treeAlgorithm, tree, by, at}]; cost (null for unknown, or {currency, knownSubtotal,
 *   complete}); secrets (a list, or a function returning one: masked in every text of the pack); limits (lower bounds than PACK_LIMITS).
 * Throws PackError 'pack_bad_input' for an input it cannot read, never guesses; the statement it returns validates.
 */
export function buildAgentChangeStatement(input = {}) {
  if (!isPlainObject(input)) throw fault('pack_bad_input', 'the inputs are an object');
  const { agent, model = null, baseCommit = null, commit = null, trees, diff, acceptance = null, checkChanges = null, ledger = null, ownerAcceptances = [], cost = null,
    secrets = [], limits = {} } = input;
  // limits
  if (!isPlainObject(limits)) throw fault('pack_bad_input', 'limits is an object');
  const L = { ...PACK_LIMITS };
  for (const [name, value] of Object.entries(limits)) {
    if (!LOWERABLE.includes(name) || !Number.isSafeInteger(value) || value < 1 || value > PACK_LIMITS[name]) {
      throw fault('pack_bad_input', `limits.${name} is an integer from 1 to ${PACK_LIMITS[name] ?? '(not a limit)'}`);
    }
    L[name] = value;
  }
  // secrets, and the masking every text goes through
  const secretList = typeof secrets === 'function' ? secrets() : secrets;
  if (!Array.isArray(secretList) || !secretList.every((secret) => typeof secret === 'string')) throw fault('pack_bad_input', 'secrets is a list of texts (or a function returning one)');
  const maskText = (value, max) => cut(maskSecrets(String(value), secretList), max);
  // agent and model
  if (!isPlainObject(agent) || typeof agent.name !== 'string' || !agent.name || typeof agent.version !== 'string' || !agent.version) throw fault('pack_bad_input', 'agent is {name, version}, both text');
  if (model !== null && !isPlainObject(model)) throw fault('pack_bad_input', 'model is {provider, id, profileRevision} or null');
  const modelText = (name) => {
    const value = model?.[name] ?? null;
    if (value !== null && typeof value !== 'string') throw fault('pack_bad_input', `model.${name} is text or null`);
    return value === null ? null : maskText(value, TEXT.model).text;
  };
  for (const [name, value] of [['baseCommit', baseCommit], ['commit', commit]]) {
    if (value !== null && (typeof value !== 'string' || !GIT_ID_RE.test(value))) throw fault('pack_bad_input', `${name} is a Git commit id in lowercase hex, or null`);
  }
  // trees, diff
  if (!isPlainObject(trees)) throw fault('pack_bad_input', 'trees is {before, after}');
  const before = readTree(trees.before, 'before');
  const after = readTree(trees.after, 'after');
  if (!(typeof diff === 'string' || diff instanceof Uint8Array)) throw fault('pack_bad_input', 'diff is the bytes or the text of the change');
  // acceptance (pod-20), check changes (pod-22), ledger (pod-16), owner acceptances, cost
  if (acceptance !== null && (!isPlainObject(acceptance) || !Array.isArray(acceptance.criteria))) throw fault('pack_bad_input', 'acceptance is the result of resolveAcceptance (lib/proof/acceptance.mjs) or null');
  if (checkChanges !== null && (!isPlainObject(checkChanges) || checkChanges.format !== CHECK_CHANGES_FORMAT || !Array.isArray(checkChanges.criteria))) {
    throw fault('pack_bad_input', `checkChanges is a ${CHECK_CHANGES_FORMAT} report of detectCheckChanges (lib/proof/tamper.mjs) or null`);
  }
  const readLedgerResult = readLedger(ledger);
  const owners = readOwners(ownerAcceptances);
  const costValue = readCost(cost);
  if ((acceptance?.criteria.length ?? 0) > MAX_CRITERIA) throw fault('pack_bad_input', `at most ${MAX_CRITERIA} criteria`);
  for (const criterion of acceptance?.criteria ?? []) {
    if (!isPlainObject(criterion) || typeof criterion.id !== 'string') throw fault('pack_bad_input', 'a criterion has an id');
    if (criterion.checks !== undefined && criterion.checks !== null && (!Array.isArray(criterion.checks) || criterion.checks.length > MAX_CHECKS)) throw fault('pack_bad_input', `criterion ${criterion.id}: at most ${MAX_CHECKS} checks`);
  }

  const entries = readLedgerResult.entries;
  const checkEntries = entries.filter((entry) => entry.type === 'check');
  const context = {
    after, limits: L, owners, text: maskText,
    trusted: acceptance?.trusted === true,
    changes: checkChanges ? new Map(checkChanges.criteria.filter(isPlainObject).map((row) => [String(row.id), row])) : null,
    ledger: readLedgerResult.summary,
    byCommand: new Map(), // commandSha256 -> the receipts of that exact command, in ledger order, cwd normalised once
  };
  for (const entry of checkEntries) {
    const receipt = { ...entry.record, seq: entry.seq, cwd: normalCwd(entry.record.cwd), treeBefore: treeRefOf(entry.record.treeBefore) };
    if (!context.byCommand.has(receipt.commandSha256)) context.byCommand.set(receipt.commandSha256, []);
    context.byCommand.get(receipt.commandSha256).push(receipt);
  }
  const criteria = (acceptance?.criteria ?? []).map((criterion) => evaluateCriterion(criterion, context));

  // receipts: every one a check lists, then the latest others up to the limit
  const referenced = new Set(criteria.flatMap((criterion) => criterion.checks.flatMap((check) => check.receipts)));
  const others = checkEntries.filter((entry) => !referenced.has(entry.seq));
  const keptOthers = new Set(others.slice(-L.maxOtherReceipts).map((entry) => entry.seq));
  const receipts = checkEntries.filter((entry) => referenced.has(entry.seq) || keptOthers.has(entry.seq)).map((entry) => receiptOf(entry, context));

  // permissions and uncertain events
  const permissions = Object.fromEntries(['records', ...PERMISSION_DECISIONS, 'other'].map((name) => [name, 0]));
  for (const entry of entries.filter((item) => item.type === 'permission')) {
    permissions.records += 1;
    const decision = entry.record?.decision;
    permissions[PERMISSION_DECISIONS.includes(decision) ? decision : 'other'] += 1;
  }
  const uncertainEntries = entries.filter((entry) => entry.type === 'uncertain');
  const uncertain = uncertainEntries.slice(0, L.maxUncertain).map((entry) => ({
    seq: entry.seq,
    reason: typeof entry.record?.reason === 'string' && /^[a-z0-9_]{1,64}$/.test(entry.record.reason) ? entry.record.reason : 'unspecified',
  }));

  const treeInfo = (snapshot) => ({
    treeAlgorithm: snapshot.treeAlgorithm,
    objectFormat: snapshot.objectFormat,
    engineReason: typeof snapshot.engineReason === 'string' ? maskText(snapshot.engineReason, TEXT.engineReason).text : null,
    ignoreRules: snapshot.ignoreRules === 'none' ? 'none' : 'git',
    files: count(snapshot.files),
    bytes: count(snapshot.bytes),
    limitations: [...new Set((Array.isArray(snapshot.limitations) ? snapshot.limitations : []).filter((code) => TREE_LIMITATIONS.includes(code)))],
  });
  const lockfiles = (checkChanges && Array.isArray(checkChanges.lockfiles) ? checkChanges.lockfiles : []).filter(isPlainObject).slice(0, MAX_LOCKFILES).map((row) => ({
    path: maskText(row.path, TEXT.path).text,
    status: LOCKFILE_STATUS.includes(row.status) ? row.status : 'modified',
    sha256Before: typeof row.sha256Before === 'string' && HEX64_RE.test(row.sha256Before) ? row.sha256Before : null,
    sha256After: typeof row.sha256After === 'string' && HEX64_RE.test(row.sha256After) ? row.sha256After : null,
  }));
  const excluded = isPlainObject(after.excluded) ? after.excluded : {};

  const subject = [
    { name: SUBJECT_NAMES.before, digest: { gitTree: before.tree } },
    { name: SUBJECT_NAMES.after, digest: { gitTree: after.tree } },
    { name: SUBJECT_NAMES.diff, digest: { sha256: sha256Hex(diff instanceof Uint8Array ? diff : Buffer.from(diff, 'utf8')) } },
    ...(commit !== null ? [{ name: SUBJECT_NAMES.commit, digest: { gitCommit: commit } }] : []),
  ];
  const statement = {
    _type: STATEMENT_TYPE,
    subject,
    predicateType: PREDICATE_TYPE,
    predicate: {
      agent: { name: maskText(agent.name, TEXT.agentName).text, version: maskText(agent.version, TEXT.version).text },
      model: { provider: modelText('provider'), id: modelText('id'), profileRevision: modelText('profileRevision') },
      baseCommit,
      trees: { before: treeInfo(before), after: treeInfo(after) },
      excludedPaths: { classes: [...EXCLUDED_CLASSES], protected: count(excluded.protected), runs: count(excluded.runs), gitlinks: count(excluded.gitlinks) },
      lockfiles,
      acceptance: {
        baselineSha256: typeof acceptance?.baselineSha256 === 'string' && HEX64_RE.test(acceptance.baselineSha256) ? acceptance.baselineSha256 : null,
        trusted: context.trusted,
        edited: Boolean(acceptance?.edit),
      },
      checkChanges: { reported: checkChanges !== null, checksModified: checkChanges?.checks_modified === true },
      criteria,
      receipts,
      ledger: {
        ...readLedgerResult.summary,
        checks: checkEntries.length,
        omittedReceipts: checkEntries.length - receipts.length,
        omittedUncertain: uncertainEntries.length - uncertain.length,
      },
      permissions,
      uncertain,
      cost: costValue,
      integrity: { level: 'unconfined', signed: false },
      limitations: [...PACK_LIMITATIONS, ...(checkChanges ? LIMITATION_CODES : [])],
    },
  };
  const result = validateStatement(statement);
  if (!result.valid) throw new PackError('pack_invalid', `the statement built does not validate: ${result.errors.slice(0, 3).map((error) => `${error.path} ${error.message}`).join('; ')}`, result.errors);
  return statement;
}

// ------------------------------------------------------------------ validation: the schema, then the rules a schema cannot say
const compiled = compileSchema(AGENT_CHANGE_SCHEMA);
const DIGEST_OF = Object.freeze({ [SUBJECT_NAMES.before]: 'gitTree', [SUBJECT_NAMES.after]: 'gitTree', [SUBJECT_NAMES.diff]: 'sha256', [SUBJECT_NAMES.commit]: 'gitCommit' });

function semanticErrors(statement) {
  const errors = [];
  const add = (path, keyword, message) => errors.push({ path, keyword: `semantic:${keyword}`, message });
  const predicate = statement.predicate;
  // subjects: each name once, the digest its name calls for, a tree id as long as its object format
  const names = new Set();
  statement.subject.forEach((subject, index) => {
    const at = `/subject/${index}`;
    if (names.has(subject.name)) add(`${at}/name`, 'duplicate_subject', `the subject ${subject.name} occurs twice`);
    names.add(subject.name);
    const [algorithm] = Object.keys(subject.digest);
    if (algorithm !== DIGEST_OF[subject.name]) { add(`${at}/digest`, 'digest_algorithm', `${subject.name} has a ${DIGEST_OF[subject.name]} digest`); return; }
    const side = subject.name === SUBJECT_NAMES.before ? 'before' : subject.name === SUBJECT_NAMES.after ? 'after' : null;
    if (side && subject.digest.gitTree.length !== idLength(predicate.trees[side].objectFormat)) {
      add(`${at}/digest/gitTree`, 'digest_length', `a ${predicate.trees[side].objectFormat} tree id has ${idLength(predicate.trees[side].objectFormat)} digits`);
    }
  });
  for (const name of [SUBJECT_NAMES.before, SUBJECT_NAMES.after, SUBJECT_NAMES.diff]) if (!names.has(name)) add('/subject', 'missing_subject', `the subject ${name} is required`);
  // receipts in ledger order, each seq once
  predicate.receipts.forEach((receipt, index) => {
    if (index > 0 && receipt.seq <= predicate.receipts[index - 1].seq) add(`/predicate/receipts/${index}/seq`, 'receipt_order', 'receipts are listed in ledger order, each once');
  });
  const listed = new Set(predicate.receipts.map((receipt) => receipt.seq));
  // criteria: ids once, checks consistent, the reasons the predicate-level facts call for, and the status that follows from all of it
  const ids = new Set();
  predicate.criteria.forEach((criterion, index) => {
    const at = `/predicate/criteria/${index}`;
    if (ids.has(criterion.id)) add(`${at}/id`, 'duplicate_criterion', `the criterion ${criterion.id} occurs twice`);
    ids.add(criterion.id);
    if (criterion.kind === 'manual' && criterion.checks.length) add(`${at}/checks`, 'manual_checks', 'a manual criterion has no checks');
    if (criterion.kind === 'checks' && !criterion.checks.length) add(`${at}/checks`, 'no_checks', 'a criterion of kind checks has at least one');
    criterion.checks.forEach((check, position) => {
      const where = `${at}/checks/${position}`;
      if (check.index !== position) add(`${where}/index`, 'check_index', `the check at ${position} has index ${position}`);
      check.receipts.forEach((seq, item) => { if (!listed.has(seq)) add(`${where}/receipts/${item}`, 'unknown_receipt', `no receipt ${seq} in the pack`); });
      if (['passed', 'failed'].includes(check.result) && !check.receipts.length) add(`${where}/receipts`, 'no_receipt', `a ${check.result} check lists its receipts`);
      const passesFit = check.result === 'passed' ? check.passes >= check.repeat
        : check.result === 'repeats_short' ? check.passes > 0 && check.passes < check.repeat
          : check.result === 'failed' ? true : check.passes === 0;
      if (!passesFit) add(`${where}/passes`, 'check_result', `${check.passes} passes of ${check.repeat} do not give ${check.result}`);
    });
    criterion.reasons.forEach((reason, item) => {
      if (reason.check !== null && reason.check >= criterion.checks.length) add(`${at}/reasons/${item}/check`, 'reason_check', `the criterion has no check ${reason.check}`);
    });
    const codes = new Set(criterion.reasons.map((reason) => reason.code));
    if (criterion.omittedReasons > 0 && criterion.reasons.at(-1)?.code !== 'checks_modified') add(`${at}/omittedReasons`, 'omitted_reasons', 'only checks_modified reasons are ever left out');
    if (criterion.kind === 'checks') {
      const wanted = [[!predicate.acceptance.trusted, 'acceptance_untrusted'], [!predicate.checkChanges.reported, 'check_changes_unknown'], [!predicate.ledger.verified, 'ledger_not_verified']];
      for (const [missing, code] of wanted) if (missing && !codes.has(code)) add(`${at}/reasons`, 'missing_reason', `${code} is listed while that input is missing`);
    }
    const expected = statusOf(criterion.kind, criterion.checks.map((check) => check.result), codes);
    if (criterion.status !== expected) add(`${at}/status`, 'status', `the listed facts give ${expected}, not ${criterion.status}`);
  });
  return errors;
}

/**
 * Checks a statement against the schema of the agent-change predicate v0.1, then against the rules a schema cannot say
 * (docs/spec/agent-change-v0.1.md, "Rules beyond the schema"). Returns {valid, errors: [{path, keyword, message}]}: schema errors first;
 * the rules are checked only on a statement that passes the schema.
 */
export function validateStatement(statement) {
  const result = compiled.validate(statement);
  if (!result.valid) return result;
  const errors = semanticErrors(statement);
  if (!errors.length) {
    const bytes = Buffer.byteLength(canonicalJson(statement), 'utf8');
    if (bytes > PACK_LIMITS.maxBytes) errors.push({ path: '', keyword: 'semantic:too_large', message: `${bytes} bytes, at most ${PACK_LIMITS.maxBytes}` });
  }
  return { valid: errors.length === 0, errors };
}
