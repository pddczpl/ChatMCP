// lib/proof/pack.mjs and lib/proof/schema-validate.mjs: the proof pack, an in-toto Statement v1 with the agent-change predicate v0.1
// (P4 pod-29, docs/spec/agent-change-v0.1.md).
//
// What it proves:
//   1. the canonical JSON of a statement (RFC 8785 rules: keys in UTF-16 code unit order, numbers as ECMAScript prints them, strings
//      escaped as JSON.stringify does, no white space) on the RFC's own examples, its refusals (NaN, Infinity, undefined, BigInt, a lone
//      surrogate, a Date, a hole, too deep), and a digest that does not move with key order, across two builds and across two processes;
//   2. the small JSON-Schema validator: every keyword the schema uses, and only those, each one with a passing and a failing value and
//      the exact error path; a schema with an unknown keyword or a bad keyword value is refused, never half-read;
//   3. the published schema docs/spec/agent-change-v0.1.schema.json is byte for byte the schema the code validates with, and the spec
//      names every status, reason and check result, says the pack is unsigned and unconfined, and uses none of the forbidden words;
//   4. the status of a criterion, case by case, from the real outputs of pod-16 (ledger appends), pod-20 (resolveAcceptance with a
//      trust store) and pod-22 (detectCheckChanges): evidenced, failed, flaky, stale, tree unknown, another tree algorithm, too few
//      repeats, not run, another cwd, a timeout, another expected exit, checks modified, owner accepted (on the final tree and on
//      another one), manual; and every missing input (no acceptance trust, no check-changes report or a row missing, no ledger, a
//      broken ledger, a torn ledger) gives `unverified`, never `evidenced`;
//   5. the full chain on real temporary Git repositories: the pod-15 snapshot engine, recordCheck running real commands, the pod-22
//      detector on the baseline commit and the work tree, `git diff`, and the pack built from all of them validates; a secret
//      registered in the ledger's masking never appears in the pack;
//   6. at least 15 malformed statements are refused, each with its own error path and keyword;
//   7. the builder refuses bad inputs (it never guesses), and its limits hold.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AGENT_CHANGE_SCHEMA, CHECK_RESULTS, CRITERION_STATUS, PACK_LIMITS, PREDICATE_TYPE, REASON_CODES, SCHEMA_ID, STATEMENT_TYPE, SUBJECT_NAMES,
  buildAgentChangeStatement, canonicalJson, statementDigest, validateStatement,
} from '../lib/proof/pack.mjs';
import { SUPPORTED_KEYWORDS, SchemaError, compileSchema } from '../lib/proof/schema-validate.mjs';
import { GENESIS, ProofLedger, checkReceipt, ledgerPath, recordCheck } from '../lib/proof/ledger.mjs';
import { acceptanceSha256, parseAcceptance, resolveAcceptance } from '../lib/proof/acceptance.mjs';
import { createTrustStore } from '../lib/proof/trust-store.mjs';
import { detectCheckChanges, gitTreeSide, memorySide, workTreeSide } from '../lib/proof/tamper.mjs';
import { TreeSnapshotter } from '../lib/proof/tree-snapshot.mjs';
import { ShellRunner } from '../lib/shell-runner.mjs';
import { StudioWorkspace } from '../lib/studio-workspace.mjs';
import { commitAll, fresh, git, newRepo, write } from './support/proof-tree-fixtures.mjs';

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Under the mutation runner the Hub is a copy without the repository around it; the runner says where it came from.
const REPO = path.resolve(process.env.CHATMCP_MUTATION_SOURCE ? path.resolve(process.env.CHATMCP_MUTATION_SOURCE) : HUB, '..');

let checks = 0;
const suiteStart = performance.now();
const elapsed = () => `${((performance.now() - suiteStart) / 1000).toFixed(1)} s`;
const ok = (label) => { checks += 1; console.log(`  ok - ${label} [${elapsed()}]`); };
setTimeout(() => { console.error('FAIL: the proof pack suite exceeded its own time budget'); process.exit(2); }, 170_000).unref();

const sha256 = (data) => createHash('sha256').update(typeof data === 'string' ? Buffer.from(data, 'utf8') : data).digest('hex');
const clone = (value) => JSON.parse(JSON.stringify(value));
const FORBIDDEN_WORDS = /certified|tamper[-\s]?proof|guarantee/i;
const TREE_A = 'a'.repeat(40);
const TREE_B = 'b'.repeat(40);
const AGENT = { name: 'DatGold', version: '1.2.3-test' }; // any version: the pack copies it, it does not read the Hub's
const MODEL = { provider: 'test-provider', id: 'scripted-model', profileRevision: 'profile-7' };
const AT = '2026-11-22T10:00:00.000Z';

/** A pod-15 snapshot object as TreeSnapshotter returns it (format chatmcp.tree-snapshot/1). */
const snapshot = (tree, { treeAlgorithm = 'git-pinned-v1', objectFormat = 'sha1' } = {}) => ({
  format: 'chatmcp.tree-snapshot/1', status: 'ok', treeAlgorithm, tree, rawTree: null, objectFormat, full: true, engineReason: null, ignoreRules: 'git',
  files: 12, bytes: 3400, excluded: { protected: 1, runs: 0, gitlinks: 0 }, limits: { maxFiles: 200_000, maxBytes: 2 ** 31 },
  limitations: ['untracked-ignored-paths-not-covered'], takenAt: AT, durationMs: 4,
});

/** What ShellRunner.run() reports, for a command that exited with `exitCode` (null: it did not exit by itself). */
const runResult = ({ cwd = '.', exitCode = 0, timedOut = false, cancelled = false, signal = null, stdout = '' } = {}) => ({
  cwd, shell: 'bash', exitCode, signal, timedOut, cancelled, lingering: false, stdout, stderr: '', truncated: { stdout: false, stderr: false },
  outputSha256: { stdout: sha256(stdout), stderr: sha256('') }, outputBytes: { stdout: Buffer.byteLength(stdout), stderr: 0 }, durationMs: 7,
});

/** Every key of every object in reverse order: the same JSON value, another insertion order. */
const reversedKeys = (value) => {
  if (Array.isArray(value)) return value.map(reversedKeys);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reversedKeys(item)]));
  return value;
};

/** The structure of an in-toto Statement v1, written from the specification, independently of the schema under test. */
const DIGEST_ALGORITHMS = new Set(['sha256', 'sha224', 'sha384', 'sha512', 'sha512_224', 'sha512_256', 'sha3_224', 'sha3_256', 'sha3_384', 'sha3_512',
  'shake128', 'shake256', 'blake2b', 'blake2s', 'ripemd160', 'sm3', 'gost', 'sha1', 'md5', 'dirHash', 'gitBlob', 'gitCommit', 'gitTag', 'gitTree']);
function statementV1Problems(statement) {
  const problems = [];
  const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!object(statement)) return ['the statement is not an object'];
  if (statement._type !== 'https://in-toto.io/Statement/v1') problems.push('_type');
  if (!Array.isArray(statement.subject) || statement.subject.length === 0) problems.push('subject is a non-empty list');
  const names = new Set();
  for (const subject of statement.subject ?? []) {
    if (!object(subject) || !object(subject.digest) || Object.keys(subject.digest).length === 0) { problems.push('a subject has a digest set'); continue; }
    for (const [algorithm, value] of Object.entries(subject.digest)) {
      if (!DIGEST_ALGORITHMS.has(algorithm)) problems.push(`digest algorithm ${algorithm}`);
      if (typeof value !== 'string' || !/^[0-9a-f]+$/.test(value)) problems.push(`digest ${algorithm} is lowercase hex`);
    }
    if (subject.name !== undefined) {
      if (typeof subject.name !== 'string' || names.has(subject.name)) problems.push('subject names are unique strings');
      names.add(subject.name);
    }
  }
  let url = null;
  try { url = new URL(statement.predicateType); } catch { /* not a URI */ }
  if (!url || url.protocol !== 'https:') problems.push('predicateType is an absolute URI');
  if (!object(statement.predicate)) problems.push('predicate is an object');
  return problems;
}

// =====================================================================================================================
// 1. canonical JSON
// =====================================================================================================================
{
  // RFC 8785 section 3.2.2: literals, numbers and strings.
  const input = '{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],"string":"\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/","literals":[null,true,false]}';
  assert.equal(canonicalJson(JSON.parse(input)),
    '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}');
  // RFC 8785 section 3.2.3: property order is UTF-16 code units, so the emoji (U+D83D...) sorts before U+FB33.
  const sorted = canonicalJson({ '€': 'Euro Sign', '\r': 'Carriage Return', 'דּ': 'Hebrew Letter Dalet With Dagesh', 1: 'One',
    '😀': 'Emoji: Grinning Face', '\u0080': 'Control', 'ö': 'Latin Small Letter O With Diaeresis' });
  // (compared as text: Object.keys would put the integer-like key "1" first whatever the text says)
  assert.equal(sorted, '{"\\r":"Carriage Return","1":"One","\u0080":"Control","ö":"Latin Small Letter O With Diaeresis","€":"Euro Sign",'
    + '"😀":"Emoji: Grinning Face","דּ":"Hebrew Letter Dalet With Dagesh"}');
  // no white space, nested objects sorted too, -0 is 0, integers and fractions as ECMAScript prints them, no normalisation of text
  assert.equal(canonicalJson({ b: [1, { z: 1, a: -0 }], a: 'x y', c: 1e21, d: 1e-7, e: 0.1 + 0.2 }), '{"a":"x y","b":[1,{"a":0,"z":1}],"c":1e+21,"d":1e-7,"e":0.30000000000000004}');
  assert.notEqual(canonicalJson({ s: 'é' }), canonicalJson({ s: 'é' }), 'no Unicode normalisation: two spellings of é stay two');
  assert.equal(canonicalJson({ s: ' \u007f/' }), '{"s":" \u007f/"}', 'U+2028, DEL and / are not escaped');
  // refusals: a value that has no single JSON text
  const refusals = [NaN, Infinity, -Infinity, undefined, 10n, () => 1, Symbol('s'), new Date(0), new Map(), Buffer.from('x'), '\ud800', { k: '\udc00' },
    { ['\ud800']: 1 }, { u: undefined }, [1, , 2], Object.create({ inherited: 1 })];
  for (const value of refusals) assert.throws(() => canonicalJson(value), (error) => error.code === 'canonical_bad_value', `${String(typeof value)} must be refused`);
  let deep = 1;
  for (let i = 0; i < PACK_LIMITS.maxDepth + 2; i += 1) deep = [deep];
  assert.throws(() => canonicalJson(deep), (error) => error.code === 'canonical_too_deep');
  let fine = 1;
  for (let i = 0; i < PACK_LIMITS.maxDepth; i += 1) fine = [fine];
  assert.ok(canonicalJson(fine).startsWith('[[['), 'the depth limit leaves room for a value as deep as the limit');
  assert.equal(canonicalJson(Object.assign(Object.create(null), { b: 1, a: 2 })), '{"a":2,"b":1}', 'an object without a prototype is a plain object');
  ok('canonical JSON: the RFC 8785 examples (numbers, escapes, UTF-16 key order), no white space, no normalisation, the refusals, the depth limit');
}

// =====================================================================================================================
// 2. the JSON-Schema validator
// =====================================================================================================================
{
  // every supported keyword is used by the schema, and the schema uses no other: no dead code, no keyword read half-way
  const used = new Set();
  const walk = (node) => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      used.add(key);
      if (['properties', '$defs'].includes(key)) Object.values(value).forEach(walk);
      else if (['items', 'oneOf'].includes(key)) walk(value);
    }
  };
  walk(AGENT_CHANGE_SCHEMA);
  assert.deepEqual([...used].sort(), [...SUPPORTED_KEYWORDS].sort());

  const refusedSchema = (schema, at, reason) => assert.throws(() => compileSchema(schema), (error) => error instanceof SchemaError && error.code === 'schema_invalid'
    && error.path === at && error.reason === reason, `${JSON.stringify(schema).slice(0, 80)} -> ${at} ${reason}`);
  refusedSchema({ type: 'object', properties: { a: { type: 'string', format: 'email' } } }, '/properties/a/format', 'unknown_keyword');
  refusedSchema({ anyOf: [{ type: 'string' }] }, '/anyOf', 'unknown_keyword');
  refusedSchema({ type: 'object', additionalProperties: { type: 'string' } }, '/additionalProperties', 'bad_keyword_value');
  refusedSchema({ type: 'text' }, '/type', 'bad_keyword_value');
  refusedSchema({ type: ['string', 'string'] }, '/type', 'bad_keyword_value');
  refusedSchema({ type: 'string', pattern: '(' }, '/pattern', 'bad_keyword_value');
  refusedSchema({ type: 'string', maxLength: -1 }, '/maxLength', 'bad_keyword_value');
  refusedSchema({ type: 'number', minimum: Infinity }, '/minimum', 'bad_keyword_value');
  refusedSchema({ enum: [] }, '/enum', 'bad_keyword_value');
  refusedSchema({ required: ['a', 'a'] }, '/required', 'bad_keyword_value');
  refusedSchema({ $ref: '#/$defs/missing' }, '/$ref', 'unknown_reference');
  refusedSchema({ $ref: 'https://example.invalid/x' }, '/$ref', 'bad_keyword_value');
  refusedSchema({ properties: { a: { $defs: { b: {} } } } }, '/properties/a/$defs', 'bad_keyword_value');
  refusedSchema({ $schema: 'http://json-schema.org/draft-07/schema#' }, '/$schema', 'bad_keyword_value');
  refusedSchema({ properties: { a: 'string' } }, '/properties/a', 'not_a_schema');
  refusedSchema({ oneOf: [] }, '/oneOf', 'bad_keyword_value');
  refusedSchema(JSON.parse('{"properties":{"__proto__":{"type":"string"}}}'), '/properties/__proto__', 'bad_keyword_value');
  refusedSchema({ $defs: { a: { $ref: '#/$defs/b' }, b: { $ref: '#/$defs/a' } }, $ref: '#/$defs/a' }, '/$defs/a/$ref', 'reference_loop');
  // the path of a key holding '/' or '~' is escaped as RFC 6901 says
  refusedSchema({ properties: { 'a/b~c': { kind: 1 } } }, '/properties/a~1b~0c/kind', 'unknown_keyword');

  const errorsOf = (schema, value) => compileSchema(schema).validate(value).errors.map((error) => `${error.path} ${error.keyword}`);
  const pass = (schema, value) => assert.deepEqual(compileSchema(schema).validate(value), { valid: true, errors: [] }, JSON.stringify(value));
  // type: JSON types only; a number is finite; an integer is a safe integer; an object is a plain object
  pass({ type: 'number' }, 1.5);
  for (const value of [NaN, Infinity, '1', null]) assert.deepEqual(errorsOf({ type: 'number' }, value), [' type']);
  pass({ type: 'integer' }, 3);
  for (const value of [3.5, 2 ** 53, '3']) assert.deepEqual(errorsOf({ type: 'integer' }, value), [' type']);
  for (const value of [new Date(0), [], null, Object.create({ x: 1 })]) assert.deepEqual(errorsOf({ type: 'object' }, value), [' type']);
  pass({ type: 'object' }, Object.create(null));
  pass({ type: ['string', 'null'] }, null);
  assert.deepEqual(errorsOf({ type: 'array' }, undefined), [' type']);
  assert.deepEqual(errorsOf({ type: 'boolean' }, 0), [' type']);
  // enum, const: JSON equality, also of objects whatever their key order
  pass({ enum: ['a', { x: 1, y: 2 }] }, { y: 2, x: 1 });
  assert.deepEqual(errorsOf({ enum: ['a', 'b'] }, 'c'), [' enum']);
  pass({ const: [1, { a: null }] }, [1, { a: null }]);
  assert.deepEqual(errorsOf({ const: [1, 2] }, [2, 1]), [' const']);
  assert.deepEqual(errorsOf({ const: 0 }, false), [' const']);
  // strings: lengths in code points (an emoji is one), pattern with the u flag, well-formed text only
  pass({ type: 'string', minLength: 2, maxLength: 2 }, '😀x');
  assert.deepEqual(errorsOf({ type: 'string', maxLength: 2 }, 'abc'), [' maxLength']);
  assert.deepEqual(errorsOf({ type: 'string', minLength: 2 }, '😀'), [' minLength']);
  assert.deepEqual(errorsOf({ type: 'string', maxLength: 5 }, 'x'.repeat(1_000_000)), [' maxLength']);
  pass({ type: 'string', pattern: '^\\p{Lu}$' }, 'Ä');
  assert.deepEqual(errorsOf({ type: 'string', pattern: '^[a-f]+$' }, 'abz'), [' pattern']);
  assert.deepEqual(errorsOf({ type: 'string' }, 'a\ud800'), [' wellFormed']);
  assert.deepEqual(errorsOf({ enum: ['a'] }, '\udfff'), [' wellFormed'], 'a lone surrogate is refused whatever the schema says');
  pass({ type: 'integer', maxLength: 1, pattern: '^x$' }, 12, 'string keywords apply to strings only');
  // numbers
  assert.deepEqual(errorsOf({ type: 'number', minimum: 0, maximum: 10 }, -0.5), [' minimum']);
  assert.deepEqual(errorsOf({ type: 'number', minimum: 0, maximum: 10 }, 10.5), [' maximum']);
  pass({ type: 'number', minimum: 0, maximum: 10 }, 10);
  // objects: required at the missing key's path, properties, closed objects, property counts, forbidden keys
  const object = { type: 'object', required: ['a', 'b'], additionalProperties: false, properties: { a: { type: 'string' }, b: { type: 'integer' }, c: { type: 'null' } } };
  assert.deepEqual(errorsOf(object, { a: 'x' }), ['/b required']);
  assert.deepEqual(errorsOf(object, { a: 1, b: 2 }), ['/a type']);
  assert.deepEqual(errorsOf(object, { a: 'x', b: 2, z: 1, y: 2 }), ['/y additionalProperties', '/z additionalProperties']);
  assert.deepEqual(errorsOf(object, JSON.parse('{"a":"x","b":2,"__proto__":{"polluted":true}}')), ['/__proto__ forbiddenKey']);
  assert.deepEqual(errorsOf({ type: 'object' }, { constructor: 1 }), ['/constructor forbiddenKey']);
  assert.equal({}.polluted, undefined, 'validating never sets a prototype');
  assert.deepEqual(errorsOf({ type: 'object', minProperties: 1, maxProperties: 1 }, {}), [' minProperties']);
  assert.deepEqual(errorsOf({ type: 'object', minProperties: 1, maxProperties: 1 }, { a: 1, b: 2 }), [' maxProperties']);
  assert.deepEqual(errorsOf({ type: 'object', properties: { 'a/b': { type: 'string' } } }, { 'a/b': 1 }), ['/a~1b type']);
  // arrays
  const list = { type: 'array', minItems: 1, maxItems: 3, uniqueItems: true, items: { type: 'integer', minimum: 0 } };
  assert.deepEqual(errorsOf(list, []), [' minItems']);
  assert.deepEqual(errorsOf(list, [1, 2, 3, 4]), [' maxItems']);
  assert.deepEqual(errorsOf(list, [1, 2, 1]), ['/2 uniqueItems']);
  assert.deepEqual(errorsOf(list, [1, -2]), ['/1 minimum']);
  assert.deepEqual(errorsOf({ type: 'array', uniqueItems: true }, [{ a: 1, b: 2 }, { b: 2, a: 1 }]), ['/1 uniqueItems']);
  pass({ type: 'array', uniqueItems: true }, [1, '1', [1], { a: 1 }]);
  // $ref and $defs, oneOf: exactly one branch; when none passes, the errors of the branch that got furthest
  const refs = { $defs: { n: { type: 'integer' } }, type: 'object', properties: { a: { $ref: '#/$defs/n' } } };
  assert.deepEqual(errorsOf(refs, { a: 'x' }), ['/a type']);
  const either = { oneOf: [{ const: 'unknown' }, { type: 'object', required: ['n'], properties: { n: { type: 'number' } } }] };
  pass(either, 'unknown');
  pass(either, { n: 1 });
  assert.deepEqual(errorsOf(either, { n: NaN }), ['/n type']);
  assert.deepEqual(errorsOf(either, 'known'), [' const']);
  assert.deepEqual(errorsOf({ oneOf: [{ type: 'integer' }, { type: 'number' }] }, 1), [' oneOf'], 'two branches matching is an error');
  // annotations are read and ignored
  pass({ $comment: 'c', title: 't', description: 'd', type: 'string' }, 's');
  // depth: a value nested deeper than the limit is refused, not followed
  const deepSchema = { $defs: { node: { type: 'array', items: { $ref: '#/$defs/node' } } }, $ref: '#/$defs/node' };
  let deepValue = [];
  for (let i = 0; i < 80; i += 1) deepValue = [deepValue];
  assert.ok(errorsOf(deepSchema, deepValue).some((line) => line.endsWith(' maxDepth')));
  // a value of the wrong type is reported once, not again by the keywords of the type it has
  assert.deepEqual(errorsOf({ type: 'string', minimum: 5 }, 3), [' type']);
  assert.deepEqual(errorsOf({ type: 'array', required: ['a'] }, {}), [' type']);
  // errors are bounded, across values and within one object
  const many = compileSchema({ type: 'array', items: { type: 'string' } }, { maxErrors: 5 }).validate(Array.from({ length: 50 }, () => 1));
  assert.equal(many.errors.length, 5);
  const wide = compileSchema({ type: 'object', additionalProperties: false }, { maxErrors: 3 }).validate({ a: 1, b: 2, c: 3, d: 4, e: 5 });
  assert.deepEqual(wide.errors.map((error) => error.path), ['/a', '/b', '/c']);
  ok(`schema validator: the ${SUPPORTED_KEYWORDS.length} keywords the schema uses and no other, each refused value with its path; unknown keywords, bad keyword values, missing references and reference loops refused when the schema is compiled`);
}

// =====================================================================================================================
// 3. the published spec and schema
// =====================================================================================================================
const specDir = path.join(REPO, 'docs', 'spec');
{
  // A checkout on Windows writes text files with CRLF (.gitattributes: text=auto); the repository holds LF. Compared as LF text.
  const schemaText = fs.readFileSync(path.join(specDir, 'agent-change-v0.1.schema.json'), 'utf8').replaceAll('\r\n', '\n');
  assert.equal(schemaText, `${JSON.stringify(AGENT_CHANGE_SCHEMA, null, 2)}\n`, 'docs/spec/agent-change-v0.1.schema.json must be the schema of lib/proof/pack.mjs, byte for byte (LF)');
  assert.equal(AGENT_CHANGE_SCHEMA.$id, SCHEMA_ID);
  assert.equal(AGENT_CHANGE_SCHEMA.properties._type.const, STATEMENT_TYPE);
  assert.equal(AGENT_CHANGE_SCHEMA.properties.predicateType.const, PREDICATE_TYPE);
  assert.equal(STATEMENT_TYPE, 'https://in-toto.io/Statement/v1');
  assert.equal(PREDICATE_TYPE, 'https://github.com/pddczpl/ChatMCP/blob/main/docs/spec/agent-change-v0.1.md');
  assert.ok(fs.existsSync(path.join(specDir, 'agent-change-v0.1.md')), 'the predicate type URL names a file of the repository');
  assert.ok(Object.isFrozen(AGENT_CHANGE_SCHEMA) && Object.isFrozen(AGENT_CHANGE_SCHEMA.$defs), 'the schema cannot be changed at run time');
  const spec = fs.readFileSync(path.join(specDir, 'agent-change-v0.1.md'), 'utf8');
  for (const word of [...CRITERION_STATUS, ...REASON_CODES, ...CHECK_RESULTS, ...Object.values(SUBJECT_NAMES)]) assert.ok(spec.includes(`\`${word}\``), `the spec names \`${word}\``);
  for (const phrase of ['Apache-2.0', 'unsigned', 'DSSE', 'unconfined', 'RFC 8785', 'pod-33', PREDICATE_TYPE, 'gitTree', 'UTF-16']) assert.ok(spec.includes(phrase), `the spec mentions ${phrase}`);
  for (const [name, text] of [['spec', spec], ['schema', schemaText], ['pack.mjs', fs.readFileSync(path.join(HUB, 'lib', 'proof', 'pack.mjs'), 'utf8')],
    ['schema-validate.mjs', fs.readFileSync(path.join(HUB, 'lib', 'proof', 'schema-validate.mjs'), 'utf8')]]) {
    assert.doesNotMatch(text, FORBIDDEN_WORDS, `${name} uses a word the pack must never use`);
  }
  ok('docs/spec: the schema file is the code\'s schema byte for byte; the spec names every status, reason, check result and subject, says unsigned, DSSE later, unconfined, not wired yet; no forbidden word');
}

// =====================================================================================================================
// 4. the status of a criterion from real pod-16, pod-20 and pod-22 outputs (synthetic commands, real modules)
// =====================================================================================================================
const MATRIX = `version: 1
criteria:
  - id: c-pass
    text: passes on the final tree
    checks:
      - run: node pass.js
  - id: c-fail
    text: fails on the final tree
    checks:
      - run: node fail.js
  - id: c-flaky
    text: passes once and fails once on the final tree
    checks:
      - run: node flaky.js
  - id: c-stale
    text: passed on another tree
    checks:
      - run: node stale.js
  - id: c-tree-unknown
    text: ran without a tree snapshot
    checks:
      - run: node unknown.js
  - id: c-algorithm
    text: ran on a tree of another algorithm
    checks:
      - run: node algorithm.js
  - id: c-repeat
    text: must pass twice, passed once
    checks:
      - run: node repeat.js
        repeat: 2
  - id: c-not-run
    text: never ran
    checks:
      - run: node never.js
  - id: c-cwd
    text: the command ran in another folder
    checks:
      - run: node pass.js
        cwd: sub
  - id: c-timeout
    text: timed out
    checks:
      - run: node slow.js
  - id: c-exit
    text: exits with 3 as expected
    checks:
      - run: node three.js
        expect:
          exit: 3
  - id: c-flagged
    text: passes but its check script changed
    checks:
      - run: node tools/flag.js
  - id: c-flagged-fail
    text: fails and its check script changed
    checks:
      - run: node tools/flagfail.js
  - id: c-owner
    text: the owner accepted it on the final tree
    manual:
      note: look at it
  - id: c-owner-old
    text: the owner accepted it on another tree
    manual:
      note: look at it
  - id: c-manual
    text: nobody looked at it
    manual:
      note: look at it
  - id: c-owner-over-fail
    text: fails, and the owner accepted it on the final tree
    checks:
      - run: node ownerfail.js
  - id: c-two
    text: one check passed, the other only on another tree
    checks:
      - run: node pass.js
      - run: node stale.js
  - id: c-format
    text: ran on a tree of another object format
    checks:
      - run: node format.js
  - id: c-stops
    text: exited with 0 but was cancelled, exited with 0 but a signal ended it
    checks:
      - run: node cancel.js
      - run: node killed.js
  - id: c-subdir
    text: ran in sub/dir, written two other ways by the runner
    checks:
      - run: node sub.js
        cwd: sub/dir
      - run: node sub2.js
        cwd: ./sub/dir/
  - id: c-owner-algorithm
    text: the owner accepted the same tree id under another algorithm
    manual:
      note: look at it
`;
const EXPECTED_STATUS = {
  'c-pass': 'evidenced', 'c-fail': 'failed', 'c-flaky': 'failed', 'c-stale': 'stale', 'c-tree-unknown': 'unverified', 'c-algorithm': 'unverified',
  'c-repeat': 'unverified', 'c-not-run': 'unverified', 'c-cwd': 'unverified', 'c-timeout': 'failed', 'c-exit': 'evidenced', 'c-flagged': 'checks_modified',
  'c-flagged-fail': 'failed', 'c-owner': 'owner_accepted', 'c-owner-old': 'stale', 'c-manual': 'unverified', 'c-owner-over-fail': 'owner_accepted', 'c-two': 'stale',
  'c-format': 'unverified', 'c-stops': 'failed', 'c-subdir': 'evidenced', 'c-owner-algorithm': 'stale',
};
const EXPECTED_REASONS = {
  'c-pass': [], 'c-fail': ['check_failed'], 'c-flaky': ['check_failed'], 'c-stale': ['check_stale'], 'c-tree-unknown': ['check_tree_unknown'],
  'c-algorithm': ['check_tree_unknown'], 'c-repeat': ['check_repeats_short'], 'c-not-run': ['check_not_run'], 'c-cwd': ['check_not_run'],
  'c-timeout': ['check_failed'], 'c-exit': [], 'c-flagged': ['checks_modified'], 'c-flagged-fail': ['check_failed', 'checks_modified'],
  'c-owner': ['owner_accepted'], 'c-owner-old': ['owner_accepted_other_tree'], 'c-manual': ['manual_not_accepted'],
  'c-owner-over-fail': ['owner_accepted', 'check_failed'], 'c-two': ['check_stale'], 'c-format': ['check_tree_unknown'], 'c-stops': ['check_failed', 'check_failed'],
  'c-subdir': [], 'c-owner-algorithm': ['owner_accepted_other_tree'],
};
const FINAL = snapshot(TREE_A);
const OTHER = snapshot(TREE_B);
const SECRET = 'Quokka-Velvet-Ledger-7731';

const matrixHub = fresh('matrix-hub');
const trustStore = createTrustStore(matrixHub);
await trustStore.trust(acceptanceSha256(MATRIX), { approvedBy: 'owner', at: AT });
const trustedAcceptance = await resolveAcceptance({ baseline: MATRIX, current: MATRIX, trustStore });
assert.equal(trustedAcceptance.trusted, true);
const untrustedAcceptance = await resolveAcceptance({ baseline: MATRIX, current: MATRIX, trustStore: createTrustStore(fresh('untrusted-hub')) });
assert.equal(untrustedAcceptance.trusted, false);
// pod-22 on in-memory sides: the two scripts c-flagged and c-flagged-fail name were edited, nothing else
const sideFiles = (edited) => ({
  '.chatmcp/acceptance.yml': MATRIX, 'pass.js': 'pass\n', 'tools/flag.js': edited ? 'console.log(2)\n' : 'console.log(1)\n',
  'tools/flagfail.js': edited ? 'process.exit(1) // 2\n' : 'process.exit(1)\n', 'src/app.js': edited ? 'v2\n' : 'v1\n',
});
const matrixChanges = await detectCheckChanges({ baseline: memorySide(sideFiles(false)), final: memorySide(sideFiles(true)), acceptance: parseAcceptance(MATRIX) });
assert.deepEqual(matrixChanges.criteria.filter((row) => row.checks_modified).map((row) => row.id), ['c-flagged', 'c-flagged-fail']);

// pod-16: the receipts, appended to a real ledger
const matrixLedger = ProofLedger.forTask(matrixHub, 'matrix', { secrets: () => [SECRET], now: () => new Date(AT) });
const appendCheck = (command, result, treeBefore = FINAL, treeAfter = treeBefore) => matrixLedger.append('check', checkReceipt({ command, result, treeBefore, treeAfter }));
await matrixLedger.append('task_start', { taskId: 'matrix' });
await appendCheck('node pass.js', runResult());
await appendCheck('node fail.js', runResult({ exitCode: 1 }));
await appendCheck('node flaky.js', runResult());
await appendCheck('node flaky.js', runResult({ exitCode: 1 }));
await appendCheck('node stale.js', runResult(), OTHER);
await appendCheck('node unknown.js', runResult(), null, null);
await appendCheck('node algorithm.js', runResult(), snapshot(TREE_A, { treeAlgorithm: 'raw-v1' }));
await appendCheck('node repeat.js', runResult());
await appendCheck('node pass.js', runResult({ cwd: 'other' }));
await appendCheck('node slow.js', runResult({ exitCode: 0, timedOut: true })); // the exit code alone would pass
await appendCheck('node three.js', runResult({ exitCode: 3 }));
await appendCheck('node tools/flag.js', runResult());
await appendCheck('node tools/flagfail.js', runResult({ exitCode: 1 }));
await appendCheck('node ownerfail.js', runResult({ exitCode: 1 }));
await appendCheck(`node print.js ${SECRET}`, runResult({ stdout: `printed ${SECRET}\n` }));
await matrixLedger.append('permission', { decision: 'approved', toolName: 'run_command' });
await matrixLedger.append('permission', { decision: 'denied', toolName: 'write_file' });
await matrixLedger.append('permission', { decision: 'weird' });
await matrixLedger.append('uncertain', { reason: 'torn_tail', bytes: 3, sha256: sha256('abc') });
await matrixLedger.append('uncertain', { reason: 'Not A Code!' });
await appendCheck('node format.js', runResult(), snapshot(TREE_A, { objectFormat: 'sha256' }));
await appendCheck('node cancel.js', runResult({ exitCode: 0, cancelled: true }));
await appendCheck('node killed.js', runResult({ exitCode: 0, signal: 'SIGTERM' }));
await appendCheck('node sub.js', runResult({ cwd: 'sub\\dir' }));
await appendCheck('node sub2.js', runResult({ cwd: './sub/dir/' }));
const matrixBytes = fs.readFileSync(ledgerPath(matrixHub, 'matrix'));
const OWNERS = [
  { criterionId: 'c-owner', treeAlgorithm: 'git-pinned-v1', tree: TREE_A, by: 'owner', at: AT },
  { criterionId: 'c-owner-old', treeAlgorithm: 'git-pinned-v1', tree: TREE_A, by: 'owner', at: AT }, // replaced by the next one: the last counts
  { criterionId: 'c-owner-old', treeAlgorithm: 'git-pinned-v1', tree: TREE_B, by: 'owner', at: AT },
  { criterionId: 'c-owner-over-fail', treeAlgorithm: 'git-pinned-v1', tree: TREE_A, by: 'owner', at: AT },
  { criterionId: 'c-owner-algorithm', treeAlgorithm: 'raw-v1', tree: TREE_A, by: 'owner', at: AT },
];
const MATRIX_DIFF = 'diff --git a/src/app.js b/src/app.js\n+// Đạt đã sửa\n';
const matrixInput = (overrides = {}) => ({
  agent: AGENT, model: MODEL, baseCommit: 'c'.repeat(40), commit: null, trees: { before: OTHER, after: FINAL }, diff: MATRIX_DIFF,
  acceptance: trustedAcceptance, checkChanges: matrixChanges, ledger: matrixBytes, ownerAcceptances: OWNERS, cost: { currency: 'USD', knownSubtotal: 0.125, complete: false },
  secrets: [SECRET], ...overrides,
});
const statusesOf = (statement) => Object.fromEntries(statement.predicate.criteria.map((criterion) => [criterion.id, criterion.status]));
const reasonsOf = (statement) => Object.fromEntries(statement.predicate.criteria.map((criterion) => [criterion.id, criterion.reasons.map((reason) => reason.code)]));
const criterionOf = (statement, id) => statement.predicate.criteria.find((criterion) => criterion.id === id);
const valid = (statement) => { const result = validateStatement(statement); assert.deepEqual(result, { valid: true, errors: [] }, JSON.stringify(result.errors.slice(0, 5))); };

const matrix = buildAgentChangeStatement(matrixInput());
{
  valid(matrix);
  assert.deepEqual(statusesOf(matrix), EXPECTED_STATUS);
  assert.deepEqual(reasonsOf(matrix), EXPECTED_REASONS);
  const results = (id) => criterionOf(matrix, id).checks.map((check) => `${check.result}/${check.passes}`);
  assert.deepEqual(results('c-pass'), ['passed/1']);
  assert.deepEqual(results('c-flaky'), ['failed/1']);
  assert.deepEqual(results('c-repeat'), ['repeats_short/1']);
  assert.deepEqual(results('c-tree-unknown'), ['tree_unknown/0']);
  assert.deepEqual(results('c-algorithm'), ['tree_unknown/0']);
  assert.deepEqual(results('c-cwd'), ['not_run/0']);
  assert.deepEqual(results('c-two'), ['passed/1', 'stale/0']);
  assert.deepEqual(results('c-exit'), ['passed/1']);
  assert.deepEqual(criterionOf(matrix, 'c-owner').checks, []);
  assert.equal(criterionOf(matrix, 'c-owner').kind, 'manual');
  const pass = criterionOf(matrix, 'c-pass').checks[0];
  assert.deepEqual({ run: pass.run, cwd: pass.cwd, commandSha256: pass.commandSha256, expectExit: pass.expectExit, repeat: pass.repeat },
    { run: 'node pass.js', cwd: '.', commandSha256: sha256('node pass.js'), expectExit: 0, repeat: 1 });
  assert.equal(criterionOf(matrix, 'c-exit').checks[0].expectExit, 3);
  assert.equal(criterionOf(matrix, 'c-repeat').checks[0].repeat, 2);
  // the receipts a check lists are ledger seqs of the pack's receipts; a stale check lists the old receipt
  const seqs = new Set(matrix.predicate.receipts.map((receipt) => receipt.seq));
  for (const criterion of matrix.predicate.criteria) for (const check of criterion.checks) for (const seq of check.receipts) assert.ok(seqs.has(seq));
  assert.deepEqual(criterionOf(matrix, 'c-flaky').checks[0].receipts, [4, 5]);
  assert.deepEqual(criterionOf(matrix, 'c-stale').checks[0].receipts, [6]);
  assert.deepEqual(criterionOf(matrix, 'c-not-run').checks[0].receipts, []);
  // the details say what happened, in plain words
  const detail = (id, code) => criterionOf(matrix, id).reasons.find((reason) => reason.code === code).detail;
  assert.equal(detail('c-fail', 'check_failed'), 'exit 1, expected 0');
  assert.equal(detail('c-timeout', 'check_failed'), 'timed out');
  assert.deepEqual(criterionOf(matrix, 'c-stops').reasons.map((reason) => `${reason.check}: ${reason.detail}`), ['0: cancelled', '1: ended by signal SIGTERM']);
  assert.deepEqual(criterionOf(matrix, 'c-subdir').checks.map((check) => `${check.cwd} ${check.result}`), ['sub/dir passed', 'sub/dir passed']);
  assert.deepEqual(matrix.predicate.receipts.filter((receipt) => receipt.command.startsWith('node sub')).map((receipt) => receipt.cwd), ['sub/dir', 'sub/dir'],
    'a receipt\'s folder is written one way');
  assert.equal(detail('c-repeat', 'check_repeats_short'), '1 of 2 runs passed on the final tree');
  assert.match(detail('c-flagged', 'checks_modified'), /^check_script_changed tools\/flag\.js$/);
  assert.equal(detail('c-owner', 'owner_accepted'), `by owner at ${AT}`);
  assert.equal(criterionOf(matrix, 'c-fail').reasons[0].check, 0);
  assert.equal(criterionOf(matrix, 'c-flagged').reasons[0].check, null);
  // the receipts: every check record of the ledger, digests as written, output never included
  assert.equal(matrix.predicate.receipts.length, 20);
  const first = matrix.predicate.receipts[0];
  const line = JSON.parse(matrixBytes.toString('utf8').split('\n')[1]);
  assert.deepEqual(first, {
    seq: 2, hash: line.hash, ts: AT, command: 'node pass.js', commandTruncated: false, commandSha256: sha256('node pass.js'),
    argsSha256: line.record.argsSha256, cwd: '.', shell: 'bash', exit: 0, signal: null, timedOut: false, cancelled: false,
    stdout: { sha256: sha256(''), bytes: 0, truncated: false }, stderr: { sha256: sha256(''), bytes: 0, truncated: false },
    treeBefore: { treeAlgorithm: 'git-pinned-v1', objectFormat: 'sha1', tree: TREE_A }, treeAfter: { treeAlgorithm: 'git-pinned-v1', objectFormat: 'sha1', tree: TREE_A },
    toolchain: null, durationMs: 7,
  });
  assert.equal(matrix.predicate.receipts.find((receipt) => receipt.command.startsWith('node unknown')).treeBefore, null);
  // the rest of the predicate
  assert.deepEqual(matrix.predicate.ledger, { present: true, verified: true, records: 26, lastHash: JSON.parse(matrixBytes.toString('utf8').trim().split('\n').at(-1)).hash,
    brokenAt: null, reason: null, checks: 20, omittedReceipts: 0, omittedUncertain: 0 });
  assert.deepEqual(matrix.predicate.permissions, { records: 3, approved: 1, denied: 1, expired: 0, cancelled: 0, blocked: 0, policy: 0, other: 1 });
  assert.deepEqual(matrix.predicate.uncertain, [{ seq: 20, reason: 'torn_tail' }, { seq: 21, reason: 'unspecified' }]);
  assert.deepEqual(matrix.predicate.cost, { currency: 'USD', knownSubtotal: 0.125, complete: false });
  assert.deepEqual(matrix.predicate.integrity, { level: 'unconfined', signed: false });
  assert.deepEqual(matrix.predicate.acceptance, { baselineSha256: acceptanceSha256(MATRIX), trusted: true, edited: false });
  assert.deepEqual(matrix.predicate.checkChanges, { reported: true, checksModified: true });
  assert.deepEqual(matrix.predicate.agent, AGENT);
  assert.deepEqual(matrix.predicate.model, MODEL);
  assert.equal(matrix.predicate.baseCommit, 'c'.repeat(40));
  assert.deepEqual(matrix.predicate.trees.after, { treeAlgorithm: 'git-pinned-v1', objectFormat: 'sha1', engineReason: null, ignoreRules: 'git', files: 12, bytes: 3400,
    limitations: ['untracked-ignored-paths-not-covered'] });
  assert.deepEqual(matrix.predicate.excludedPaths, { classes: ['protected-files', 'runs-folder', 'untracked-ignored-paths', 'nested-repository-content'], protected: 1, runs: 0, gitlinks: 0 });
  assert.deepEqual(matrix.predicate.limitations, ['unsigned', 'integrity-unconfined', 'ledger-end-not-anchored', 'untracked-ignored-paths-not-covered',
    'heuristics-may-flag-legitimate-changes', 'test-selection-unknown', 'protected-files-not-read']);
  // subjects: the two trees, the diff, no commit (none given)
  assert.deepEqual(matrix.subject, [
    { name: 'workspace-tree-before', digest: { gitTree: TREE_B } },
    { name: 'workspace-tree-after', digest: { gitTree: TREE_A } },
    { name: 'change.diff', digest: { sha256: createHash('sha256').update(Buffer.from(MATRIX_DIFF, 'utf8')).digest('hex') } },
  ]);
  assert.deepEqual(statementV1Problems(matrix), []);
  // an acceptance file edited during the task: said so, the criteria stay the baseline's
  const edited = buildAgentChangeStatement(matrixInput({ acceptance: await resolveAcceptance({ baseline: MATRIX, current: `${MATRIX}# a note\n`, trustStore }) }));
  assert.deepEqual(edited.predicate.acceptance, { baselineSha256: acceptanceSha256(MATRIX), trusted: true, edited: true });
  assert.deepEqual(statusesOf(edited), EXPECTED_STATUS);
  // the secret of the ledger (and of the builder) is nowhere in the pack, its hash is
  const text = canonicalJson(matrix);
  assert.ok(!text.includes(SECRET), 'the registered secret is in the pack');
  assert.ok(matrixBytes.toString('utf8').includes('[REDACTED]') && !matrixBytes.toString('utf8').includes(SECRET), 'the ledger masked it on append');
  assert.ok(text.includes(sha256(`node print.js ${SECRET}`)), 'the hash of the exact command is kept');
  ok('criterion status from real pod-16/20/22 outputs: evidenced, failed (exit, flaky, timeout), stale, tree unknown, another algorithm, repeats short, not run, another cwd, another expected exit, checks modified, owner accepted on the final tree and on another one, manual; details, receipts, permissions, uncertain events, subjects');
}

{
  // the pack is a value of its inputs: two builds give the same text and digest, key order does not move the digest, nor JSON text
  const again = buildAgentChangeStatement(matrixInput());
  assert.equal(canonicalJson(again), canonicalJson(matrix));
  const digest = statementDigest(matrix);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(digest, sha256(canonicalJson(matrix)));
  assert.equal(statementDigest(reversedKeys(matrix)), digest);
  assert.notDeepEqual(Object.keys(reversedKeys(matrix)), Object.keys(matrix));
  assert.equal(statementDigest(JSON.parse(JSON.stringify(reversedKeys(matrix), null, 3))), digest);
  assert.equal(statementDigest(JSON.parse(canonicalJson(matrix))), digest);
  const changed = clone(matrix);
  changed.predicate.criteria[0].status = 'unverified';
  assert.notEqual(statementDigest(changed), digest);
  // another process, another run: the same inputs give the same digest
  const inputFile = path.join(fresh('two-runs'), 'input.json');
  fs.writeFileSync(inputFile, JSON.stringify({ ...matrixInput(), ledger: matrixBytes.toString('base64') }));
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { readFileSync } from 'node:fs';
    import { buildAgentChangeStatement, statementDigest } from ${JSON.stringify(new URL('../lib/proof/pack.mjs', import.meta.url).href)};
    const input = JSON.parse(readFileSync(process.argv[1], 'utf8'));
    input.ledger = Buffer.from(input.ledger, 'base64');
    process.stdout.write(statementDigest(buildAgentChangeStatement(input)));
  `, inputFile], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, digest);
  ok('canonical digest: stable across two builds, reversed key order, indented JSON text and another process; one changed field changes it');
}

{
  // every missing or weaker input gives unverified, never evidenced
  const untrusted = buildAgentChangeStatement(matrixInput({ acceptance: untrustedAcceptance }));
  valid(untrusted);
  assert.equal(criterionOf(untrusted, 'c-pass').status, 'unverified');
  assert.deepEqual(reasonsOf(untrusted)['c-pass'], ['acceptance_untrusted']);
  assert.equal(criterionOf(untrusted, 'c-fail').status, 'failed', 'a failure on the final tree is a fact whoever approved the file');
  assert.equal(criterionOf(untrusted, 'c-owner').status, 'owner_accepted');
  assert.ok(!reasonsOf(untrusted)['c-owner'].includes('acceptance_untrusted'), 'a manual criterion runs nothing');
  assert.equal(untrusted.predicate.acceptance.trusted, false);

  const noChanges = buildAgentChangeStatement(matrixInput({ checkChanges: null }));
  valid(noChanges);
  assert.equal(criterionOf(noChanges, 'c-pass').status, 'unverified');
  assert.equal(criterionOf(noChanges, 'c-flagged').status, 'unverified', 'without the report its pass is not evidence either');
  assert.deepEqual(reasonsOf(noChanges)['c-pass'], ['check_changes_unknown']);
  assert.deepEqual(noChanges.predicate.checkChanges, { reported: false, checksModified: false });
  assert.deepEqual(noChanges.predicate.lockfiles, []);
  assert.deepEqual(noChanges.predicate.limitations, ['unsigned', 'integrity-unconfined', 'ledger-end-not-anchored']);

  const missingRow = clone(matrixChanges);
  missingRow.criteria = missingRow.criteria.filter((row) => row.id !== 'c-pass');
  const rowless = buildAgentChangeStatement(matrixInput({ checkChanges: missingRow }));
  valid(rowless);
  assert.equal(criterionOf(rowless, 'c-pass').status, 'unverified');
  assert.deepEqual(reasonsOf(rowless)['c-pass'], ['check_changes_unknown']);
  assert.equal(criterionOf(rowless, 'c-exit').status, 'evidenced');

  const noLedger = buildAgentChangeStatement(matrixInput({ ledger: null }));
  valid(noLedger);
  assert.equal(criterionOf(noLedger, 'c-pass').status, 'unverified');
  assert.deepEqual(reasonsOf(noLedger)['c-pass'], ['check_not_run', 'ledger_not_verified']);
  assert.equal(criterionOf(noLedger, 'c-owner').status, 'owner_accepted');
  assert.deepEqual(noLedger.predicate.ledger, { present: false, verified: false, records: 0, lastHash: GENESIS, brokenAt: null, reason: null, checks: 0, omittedReceipts: 0, omittedUncertain: 0 });
  assert.deepEqual(noLedger.predicate.receipts, []);

  // a changed byte in a late line: the lines before it still count, but nothing is evidenced
  const lines = matrixBytes.toString('utf8').split('\n');
  const brokenLines = [...lines];
  brokenLines[16] = brokenLines[16].replace('"approved"', '"approvee"');
  const broken = buildAgentChangeStatement(matrixInput({ ledger: Buffer.from(brokenLines.join('\n')) }));
  valid(broken);
  assert.deepEqual([broken.predicate.ledger.verified, broken.predicate.ledger.brokenAt, broken.predicate.ledger.reason, broken.predicate.ledger.records], [false, 17, 'hash_mismatch', 16]);
  assert.equal(criterionOf(broken, 'c-pass').status, 'unverified');
  assert.deepEqual(reasonsOf(broken)['c-pass'], ['ledger_not_verified']);
  assert.equal(criterionOf(broken, 'c-fail').status, 'failed', 'a verified line before the break still counts');
  assert.equal(broken.predicate.permissions.records, 0, 'nothing after the break is read');

  const torn = buildAgentChangeStatement(matrixInput({ ledger: Buffer.concat([matrixBytes, Buffer.from('{"v":2,"seq":27')]) }));
  valid(torn);
  assert.deepEqual([torn.predicate.ledger.verified, torn.predicate.ledger.reason, torn.predicate.ledger.brokenAt], [false, 'torn_tail', 27]);
  assert.equal(criterionOf(torn, 'c-pass').status, 'unverified');

  const noAcceptance = buildAgentChangeStatement(matrixInput({ acceptance: null }));
  valid(noAcceptance);
  assert.deepEqual(noAcceptance.predicate.criteria, []);
  assert.deepEqual(noAcceptance.predicate.acceptance, { baselineSha256: null, trusted: false, edited: false });

  const noCost = buildAgentChangeStatement(matrixInput({ cost: null }));
  assert.equal(noCost.predicate.cost, 'unknown');
  valid(noCost);

  // in no variant is anything evidenced that the full inputs do not evidence
  for (const variant of [untrusted, noChanges, rowless, noLedger, broken, torn]) {
    for (const criterion of variant.predicate.criteria) if (criterion.status === 'evidenced') assert.equal(EXPECTED_STATUS[criterion.id], 'evidenced', criterion.id);
  }
  ok('missing inputs give unverified, never evidenced: untrusted acceptance, no check-changes report or a row missing, no ledger, a ledger broken at line 17 (lines before it count), a torn ledger; no acceptance file, unknown cost');
}

{
  // limits: refs per check and unreferenced receipts are bounded and counted; statuses are computed on all receipts
  const small = buildAgentChangeStatement(matrixInput({ limits: { maxReceiptsPerCheck: 1, maxOtherReceipts: 1, maxUncertain: 1 } }));
  valid(small);
  assert.deepEqual(statusesOf(small), EXPECTED_STATUS);
  assert.deepEqual(criterionOf(small, 'c-flaky').checks[0].receipts, [5], 'the latest one');
  assert.equal(criterionOf(small, 'c-flaky').checks[0].passes, 1);
  // listed: the one receipt each check keeps, and the latest of the others (4, the older flaky run, is no longer listed by its check)
  assert.deepEqual(small.predicate.receipts.map((receipt) => receipt.seq), [2, 3, 5, 6, 7, 8, 9, 11, 12, 13, 14, 15, 16, 22, 23, 24, 25, 26]);
  assert.equal(small.predicate.ledger.omittedReceipts, 2);
  assert.deepEqual([small.predicate.uncertain.length, small.predicate.ledger.omittedUncertain], [1, 1]);
  // a long command is cut after masking and says so
  const longHub = fresh('long-hub');
  const longLedger = ProofLedger.forTask(longHub, 'long', { now: () => new Date(AT) });
  const shortSecret = 'abcd';
  // 4,094 characters in the ledger; masked, 8,983: the cut at 8,192 falls between the two halves of an emoji, which is not split
  const longCommand = `node pass.js ${shortSecret.repeat(817)}${'😀'.repeat(400)}`;
  assert.ok(longCommand.length <= 4096);
  await longLedger.append('check', checkReceipt({ command: longCommand, result: runResult(), treeBefore: FINAL }));
  const long = buildAgentChangeStatement(matrixInput({ ledger: fs.readFileSync(ledgerPath(longHub, 'long')), secrets: [shortSecret] }));
  valid(long);
  assert.equal(long.predicate.receipts[0].commandTruncated, true);
  assert.equal(long.predicate.receipts[0].command.length, 8191);
  assert.ok(long.predicate.receipts[0].command.isWellFormed());
  assert.ok(!long.predicate.receipts[0].command.includes(shortSecret));
  assert.equal(long.predicate.receipts[0].commandSha256, sha256(longCommand), 'the hash is of the command as it ran');
  ok('limits: receipts per check and unreferenced receipts bounded and counted, uncertain events bounded, statuses from all receipts; a command masked longer is cut and marked');
}

// =====================================================================================================================
// 5. the full chain on real temporary Git repositories
// =====================================================================================================================
const REAL_ACCEPTANCE = `version: 1
criteria:
  - id: unit
    text: Unit tests pass
    checks:
      - run: node test/unit.js
  - id: lint
    text: Lint passes
    checks:
      - run: node scripts/lint.js
  - id: e2e
    text: The end-to-end test passes
    checks:
      - run: node test/e2e.js
  - id: twice
    text: Unit tests pass twice
    checks:
      - run: node test/unit.js twice
        repeat: 2
  - id: extra
    text: The extra test passes
    checks:
      - run: node test/extra.js
  - id: docs
    text: The README reads well
    manual:
      note: Read the README.
`;
const UNIT_TEST = `const assert = require('node:assert');
const { add } = require('../src/math');
assert.equal(add(1, 2), 3);
assert.equal(add(2, 2), 4);
console.log('unit ok', process.argv[2] ?? '');
`;
const LOCKFILE = `${JSON.stringify({ name: 'pack-fixture', lockfileVersion: 3, packages: {} }, null, 2)}\n`;

async function realRepository(label) {
  const root = newRepo(label);
  write(root, 'package.json', `${JSON.stringify({ name: 'pack-fixture', version: '1.0.0', private: true }, null, 2)}\n`);
  write(root, 'package-lock.json', LOCKFILE);
  write(root, 'src/math.js', 'exports.add = (a, b) => a + b;\n');
  write(root, 'test/unit.js', UNIT_TEST);
  write(root, 'test/e2e.js', "console.log('e2e ok');\n");
  write(root, 'test/extra.js', "console.log('extra ok');\n");
  write(root, 'scripts/lint.js', "console.error('lint: 1 problem'); process.exit(1);\n");
  write(root, 'tools/print.js', "console.log('printing', process.argv[2]);\n");
  write(root, 'README.md', '# Fixture\n');
  write(root, '.chatmcp/acceptance.yml', REAL_ACCEPTANCE);
  commitAll(root);
  const hub = fresh(`${label}-hub`);
  const state = fresh(`${label}-state`);
  const workspace = new StudioWorkspace({ manager: { workspace: root }, directory: state });
  const runner = new ShellRunner({ workspace, stateDirectory: state });
  const snapshotter = new TreeSnapshotter({ root, stateDir: fresh(`${label}-snapshots`) });
  const store = createTrustStore(hub);
  const baselineText = git(root, ['show', 'HEAD:.chatmcp/acceptance.yml']).stdout;
  await store.trust(acceptanceSha256(baselineText), { approvedBy: 'owner', at: AT });
  const toolchain = { versions: async () => ({ node: process.versions.node, python: null, dotnet: null, git: null }) };
  const baseCommit = git(root, ['rev-parse', 'HEAD']).stdout.trim();
  const before = await snapshotter.snapshot({ full: true });
  return { root, hub, runner, snapshotter, store, baselineText, toolchain, baseCommit, before };
}

async function finish(repo, ledger, { ownerAcceptances = [], secrets = [SECRET], extra = {} } = {}) {
  const after = await repo.snapshotter.snapshot({ full: true });
  const stateDir = fresh('tamper-state');
  const checkChanges = await detectCheckChanges({ baseline: await gitTreeSide({ root: repo.root, rev: 'HEAD', stateDir }), final: await workTreeSide({ root: repo.root, stateDir }) });
  const acceptance = await resolveAcceptance({ baseline: repo.baselineText, current: fs.readFileSync(path.join(repo.root, '.chatmcp', 'acceptance.yml')), trustStore: repo.store });
  const diff = git(repo.root, ['-c', 'core.autocrlf=false', 'diff', '--binary', '--no-color', 'HEAD']).stdout;
  const ledgerBytes = fs.readFileSync(ledger.file);
  const statement = buildAgentChangeStatement({
    agent: AGENT, model: MODEL, baseCommit: repo.baseCommit, commit: null, trees: { before: repo.before, after }, diff, acceptance, checkChanges, ledger: ledgerBytes,
    ownerAcceptances: ownerAcceptances.map((row) => ({ ...row, treeAlgorithm: after.treeAlgorithm, tree: after.tree })), cost: null, secrets, ...extra,
  });
  return { statement, after, checkChanges, acceptance, diff, ledgerBytes };
}

{
  // scenario A: an ordinary change; one check passes, one fails, one passed before the last edit, one passed once of twice, one never ran
  const repo = await realRepository('real-a');
  const ledger = ProofLedger.forTask(repo.hub, 'task-a', { secrets: () => [SECRET] });
  const check = async (command) => {
    const done = await recordCheck({ ledger, runner: repo.runner, snapshotter: repo.snapshotter, toolchain: repo.toolchain, command, timeoutMs: 60_000 });
    assert.notEqual(done.result.timedOut, true, command);
    return done;
  };
  assert.equal((await check('node test/e2e.js')).result.exitCode, 0);
  write(repo.root, 'src/math.js', 'exports.add = (a, b) => a + b; // reviewed\n');
  assert.equal((await check('node test/unit.js')).result.exitCode, 0);
  assert.equal((await check('node scripts/lint.js')).result.exitCode, 1);
  assert.equal((await check('node test/unit.js twice')).result.exitCode, 0);
  const printed = await check(`node tools/print.js ${SECRET}`);
  assert.ok(printed.result.stdout.includes(SECRET), 'the command really printed the secret');
  const { statement, after, checkChanges, acceptance, diff, ledgerBytes } = await finish(repo, ledger, { ownerAcceptances: [{ criterionId: 'docs', by: 'owner', at: AT }] });
  valid(statement);
  assert.deepEqual(statementV1Problems(statement), []);
  assert.equal(checkChanges.checks_modified, false);
  assert.deepEqual(statusesOf(statement), { unit: 'evidenced', lint: 'failed', e2e: 'stale', twice: 'unverified', extra: 'unverified', docs: 'owner_accepted' });
  assert.deepEqual(reasonsOf(statement), { unit: [], lint: ['check_failed'], e2e: ['check_stale'], twice: ['check_repeats_short'], extra: ['check_not_run'], docs: ['owner_accepted'] });
  assert.deepEqual(statement.subject, [
    { name: 'workspace-tree-before', digest: { gitTree: repo.before.tree } },
    { name: 'workspace-tree-after', digest: { gitTree: after.tree } },
    { name: 'change.diff', digest: { sha256: sha256(Buffer.from(diff, 'utf8')) } },
  ]);
  assert.notEqual(repo.before.tree, after.tree);
  assert.ok(diff.includes('// reviewed'));
  assert.equal(statement.predicate.baseCommit, repo.baseCommit);
  assert.equal(statement.predicate.trees.after.treeAlgorithm, after.treeAlgorithm);
  assert.deepEqual(statement.predicate.lockfiles, [{ path: 'package-lock.json', status: 'unchanged', sha256Before: sha256(LOCKFILE), sha256After: sha256(LOCKFILE) }]);
  assert.equal(statement.predicate.receipts.length, 5);
  assert.deepEqual(statement.predicate.receipts.map((receipt) => receipt.exit), [0, 0, 1, 0, 0]);
  assert.equal(statement.predicate.receipts[1].toolchain.node, process.versions.node);
  assert.equal(statement.predicate.ledger.verified, true);
  // the secret: the ledger masked it on append, the pack has none of it, in any field
  const text = canonicalJson(statement);
  assert.ok(!text.includes(SECRET));
  assert.ok(!ledgerBytes.toString('utf8').includes(SECRET));
  assert.ok(statement.predicate.receipts.at(-1).command.includes('[REDACTED]'));
  // the same secret, this time only the builder knows it: a ledger written without masking it, and inputs that hold it
  const plainHub = fresh('plain-hub');
  const plain = ProofLedger.forTask(plainHub, 'plain');
  await plain.append('check', checkReceipt({ command: `node tools/print.js ${SECRET}`, result: printed.result, treeBefore: after, treeAfter: after }));
  const plainBytes = fs.readFileSync(plain.file);
  assert.ok(plainBytes.toString('utf8').includes(SECRET), 'the unmasked ledger holds the secret');
  const leaky = buildAgentChangeStatement({
    agent: { name: 'DatGold', version: `1.2.3-test-${SECRET}` }, model: { provider: SECRET, id: `m-${SECRET}`, profileRevision: SECRET }, baseCommit: repo.baseCommit,
    trees: { before: repo.before, after }, diff, acceptance, checkChanges, ledger: plainBytes,
    ownerAcceptances: [{ criterionId: 'docs', treeAlgorithm: after.treeAlgorithm, tree: after.tree, by: SECRET, at: AT }], cost: null, secrets: [SECRET],
  });
  valid(leaky);
  assert.equal(criterionOf(leaky, 'docs').reasons[0].detail, `by [REDACTED] at ${AT}`);
  assert.equal(leaky.predicate.receipts[0].command, 'node tools/print.js [REDACTED]');
  assert.ok(!canonicalJson(leaky).includes(SECRET), 'a secret only the builder knows is masked in every field');
  ok(`real repository A (${after.treeAlgorithm}): snapshots, recordCheck on real commands, pod-22 on HEAD and the work tree, git diff: evidenced, failed, stale, repeats short, not run, owner accepted; lockfile hash; the registered secret never in the pack, also when only the builder knows it`);
}

{
  // scenario B: an assertion removed from the unit test: every criterion that runs a command has its checks modified; a failure stays failed
  const repo = await realRepository('real-b');
  const ledger = ProofLedger.forTask(repo.hub, 'task-b', { secrets: () => [SECRET] });
  write(repo.root, 'test/unit.js', UNIT_TEST.replace('assert.equal(add(2, 2), 4);\n', ''));
  for (const command of ['node test/unit.js', 'node scripts/lint.js']) await recordCheck({ ledger, runner: repo.runner, snapshotter: repo.snapshotter, command, timeoutMs: 60_000 });
  const { statement, checkChanges } = await finish(repo, ledger, { extra: { commit: repo.baseCommit } });
  valid(statement);
  assert.equal(checkChanges.checks_modified, true);
  assert.deepEqual(statusesOf(statement), { unit: 'checks_modified', lint: 'failed', e2e: 'checks_modified', twice: 'checks_modified', extra: 'checks_modified', docs: 'unverified' });
  const unit = criterionOf(statement, 'unit');
  assert.deepEqual(unit.checks.map((check) => check.result), ['passed']);
  assert.deepEqual(unit.reasons.map((reason) => `${reason.code}: ${reason.detail}`), ['checks_modified: assertions_removed test/unit.js']);
  assert.deepEqual(reasonsOf(statement).lint, ['check_failed', 'checks_modified']);
  assert.deepEqual(statement.subject.at(-1), { name: 'git-commit', digest: { gitCommit: repo.baseCommit } });
  assert.deepEqual(statementV1Problems(statement), []);
  ok('real repository B: an assertion removed gives checks_modified to every criterion that runs a command (lint still failed, the manual one untouched), with the detector\'s reason; the commit subject');
}

// =====================================================================================================================
// 6. malformed statements, each refused with its own path
// =====================================================================================================================
{
  const base = clone(matrix);
  valid(base);
  const cases = [
    ['a missing _type', (s) => { delete s._type; }, '/_type', 'required'],
    ['another _type', (s) => { s._type = 'https://in-toto.io/Statement/v0.1'; }, '/_type', 'const'],
    ['a wrong predicateType', (s) => { s.predicateType = 'https://slsa.dev/provenance/v1'; }, '/predicateType', 'const'],
    ['a subject without a digest', (s) => { delete s.subject[0].digest; }, '/subject/0/digest', 'required'],
    ['a digest in upper-case hex', (s) => { s.subject[1].digest.gitTree = 'A'.repeat(40); }, '/subject/1/digest/gitTree', 'pattern'],
    ['a digest that is not hex', (s) => { s.subject[2].digest.sha256 = 'z'.repeat(64); }, '/subject/2/digest/sha256', 'pattern'],
    ['a digest of 63 digits', (s) => { s.subject[2].digest.sha256 = 'a'.repeat(63); }, '/subject/2/digest/sha256', 'pattern'],
    ['an unknown digest algorithm', (s) => { s.subject[2].digest = { md4: 'a'.repeat(32) }; }, '/subject/2/digest/md4', 'additionalProperties'],
    ['two digests in one subject', (s) => { s.subject[2].digest.gitTree = TREE_A; }, '/subject/2/digest', 'maxProperties'],
    ['an unknown status', (s) => { s.predicate.criteria[0].status = 'done'; }, '/predicate/criteria/0/status', 'enum'],
    ['an extra top-level field', (s) => { s.signature = 'x'; }, '/signature', 'additionalProperties'],
    ['an extra predicate field', (s) => { s.predicate.certifiedBy = 'x'; }, '/predicate/certifiedBy', 'additionalProperties'],
    ['subject is not a list', (s) => { s.subject = { name: 'x' }; }, '/subject', 'type'],
    ['an exit code as text', (s) => { s.predicate.receipts[0].exit = '0'; }, '/predicate/receipts/0/exit', 'type'],
    ['a boolean as a string', (s) => { s.predicate.integrity.signed = 'false'; }, '/predicate/integrity/signed', 'const'],
    ['an empty subject list', (s) => { s.subject = []; }, '/subject', 'minItems'],
    ['a duplicate subject name', (s) => { s.subject[1] = clone(s.subject[0]); }, '/subject/1/name', 'semantic:duplicate_subject'],
    ['a NaN cost', (s) => { s.predicate.cost.knownSubtotal = NaN; }, '/predicate/cost/knownSubtotal', 'type'],
    ['an Infinity cost', (s) => { s.predicate.cost.knownSubtotal = Infinity; }, '/predicate/cost/knownSubtotal', 'type'],
    ['a negative cost', (s) => { s.predicate.cost.knownSubtotal = -1; }, '/predicate/cost/knownSubtotal', 'minimum'],
    ['a cost that is neither unknown nor a subtotal', (s) => { s.predicate.cost = 'free'; }, '/predicate/cost', 'const'],
    ['a very long string', (s) => { s.predicate.model.id = 'm'.repeat(200_001); }, '/predicate/model/id', 'maxLength'],
    ['a prototype-pollution key', (s) => JSON.parse(JSON.stringify(s).replace('"predicate":{', '"predicate":{"__proto__":{"polluted":true},')), '/predicate/__proto__', 'forbiddenKey'],
    ['a prototype-pollution key in a digest', (s) => JSON.parse(JSON.stringify(s).replace('"digest":{', '"digest":{"__proto__":"x",')), '/subject/0/digest/__proto__', 'forbiddenKey'],
    ['a lone surrogate', (s) => { s.predicate.agent.version = '3.\ud800'; }, '/predicate/agent/version', 'wellFormed'],
    ['another integrity level', (s) => { s.predicate.integrity.level = 'confined'; }, '/predicate/integrity/level', 'const'],
    ['a negative count', (s) => { s.predicate.ledger.records = -1; }, '/predicate/ledger/records', 'minimum'],
    ['a criteria list missing', (s) => { delete s.predicate.criteria; }, '/predicate/criteria', 'required'],
    ['a criterion id with capitals', (s) => { s.predicate.criteria[0].id = 'C-PASS'; }, '/predicate/criteria/0/id', 'pattern'],
    ['an unknown reason code', (s) => { s.predicate.criteria[1].reasons[0].code = 'cheated'; }, '/predicate/criteria/1/reasons/0/code', 'enum'],
    ['a fractional seq', (s) => { s.predicate.receipts[0].seq = 1.5; }, '/predicate/receipts/0/seq', 'type'],
    ['a timestamp without its zone', (s) => { s.predicate.receipts[0].ts = '2026-11-22T10:00:00.000'; }, '/predicate/receipts/0/ts', 'pattern'],
    ['the statement is a list', () => [], '', 'type'],
    ['the statement is null', () => null, '', 'type'],
    ['a tree digest of the wrong object format', (s) => { s.subject[1].digest.gitTree = 'a'.repeat(64); }, '/subject/1/digest/gitTree', 'semantic:digest_length'],
    ['a tree subject with a sha256 digest', (s) => { s.subject[0].digest = { sha256: 'a'.repeat(64) }; }, '/subject/0/digest', 'semantic:digest_algorithm'],
    ['no diff subject', (s) => { s.subject[2] = { name: 'git-commit', digest: { gitCommit: TREE_A } }; }, '/subject', 'semantic:missing_subject'],
    ['a duplicate criterion id', (s) => { s.predicate.criteria[1].id = s.predicate.criteria[0].id; }, '/predicate/criteria/1/id', 'semantic:duplicate_criterion'],
    ['receipts out of order', (s) => { s.predicate.receipts.reverse(); }, '/predicate/receipts/1/seq', 'semantic:receipt_order'],
    ['a check naming a receipt the pack does not hold', (s) => { s.predicate.criteria[0].checks[0].receipts = [999]; }, '/predicate/criteria/0/checks/0/receipts/0', 'semantic:unknown_receipt'],
    ['evidenced with a failed check', (s) => { s.predicate.criteria[1].status = 'evidenced'; }, '/predicate/criteria/1/status', 'semantic:status'],
    ['failed hidden as unverified', (s) => { s.predicate.criteria[1].status = 'unverified'; }, '/predicate/criteria/1/status', 'semantic:status'],
    ['evidenced while the ledger is not verified', (s) => { s.predicate.ledger.verified = false; }, '/predicate/criteria/0/reasons', 'semantic:missing_reason'],
    ['passed with too few passes', (s) => { s.predicate.criteria[0].checks[0].passes = 0; }, '/predicate/criteria/0/checks/0/passes', 'semantic:check_result'],
    ['a check index out of order', (s) => { s.predicate.criteria[0].checks[0].index = 1; }, '/predicate/criteria/0/checks/0/index', 'semantic:check_index'],
    ['a reason naming a check the criterion does not have', (s) => { s.predicate.criteria[1].reasons[0].check = 5; }, '/predicate/criteria/1/reasons/0/check', 'semantic:reason_check'],
    ['a manual criterion with checks', (s) => { s.predicate.criteria[13].checks = clone(s.predicate.criteria[0].checks); }, '/predicate/criteria/13/checks', 'semantic:manual_checks'],
    ['a criterion of kind checks without checks', (s) => { s.predicate.criteria[0].checks = []; }, '/predicate/criteria/0/checks', 'semantic:no_checks'],
    ['a receipt listed twice', (s) => { s.predicate.receipts[1] = clone(s.predicate.receipts[0]); }, '/predicate/receipts/1/seq', 'semantic:receipt_order'],
    ['a passed check without receipts', (s) => { s.predicate.criteria[0].checks[0].receipts = []; }, '/predicate/criteria/0/checks/0/receipts', 'semantic:no_receipt'],
    ['repeats short with enough passes', (s) => { s.predicate.criteria[6].checks[0].passes = 2; }, '/predicate/criteria/6/checks/0/passes', 'semantic:check_result'],
    ['not run with a pass', (s) => { s.predicate.criteria[7].checks[0].passes = 1; }, '/predicate/criteria/7/checks/0/passes', 'semantic:check_result'],
    ['reasons left out that are not checks_modified', (s) => { s.predicate.criteria[1].omittedReasons = 3; }, '/predicate/criteria/1/omittedReasons', 'semantic:omitted_reasons'],
    ['evidenced while the acceptance is untrusted', (s) => { s.predicate.acceptance.trusted = false; }, '/predicate/criteria/0/reasons', 'semantic:missing_reason'],
    ['evidenced without a check-changes report', (s) => { s.predicate.checkChanges.reported = false; }, '/predicate/criteria/0/reasons', 'semantic:missing_reason'],
  ];
  assert.ok(cases.length >= 15);
  for (const [name, mutate, at, keyword] of cases) {
    const statement = clone(base);
    const returned = mutate(statement);
    const changed = returned === undefined ? statement : returned; // a case that changes the statement in place returns nothing
    const result = validateStatement(changed);
    assert.equal(result.valid, false, `${name}: accepted`);
    assert.deepEqual({ path: result.errors[0]?.path, keyword: result.errors[0]?.keyword }, { path: at, keyword }, `${name}: ${JSON.stringify(result.errors.slice(0, 3))}`);
    assert.equal(typeof result.errors[0].message, 'string');
  }
  assert.equal({}.polluted, undefined);
  ok(`${cases.length} malformed statements refused, each with its own path and keyword (missing _type, wrong predicateType, no digest, bad hex, unknown status, extra fields, wrong types, empty subjects, duplicate subject, NaN and Infinity cost, a very long string, __proto__, and the cross-field rules)`);
}

// =====================================================================================================================
// 7. bad inputs: the builder refuses, never guesses
// =====================================================================================================================
{
  const refused = (overrides, label) => assert.throws(() => buildAgentChangeStatement(matrixInput(overrides)), (error) => error.code === 'pack_bad_input', label);
  refused({ agent: { name: '', version: '1' } }, 'an agent without a name');
  refused({ agent: null }, 'no agent');
  refused({ trees: { before: OTHER } }, 'no after tree');
  refused({ trees: { before: OTHER, after: { ...FINAL, status: 'unbounded', tree: null } } }, 'an unbounded tree has no id');
  refused({ trees: { before: { ...OTHER, status: 'unbounded' }, after: FINAL } }, 'the id of a snapshot that is not ok is not read');
  refused({ trees: { before: OTHER, after: { ...FINAL, tree: 'a'.repeat(64) } } }, 'a sha1 tree of 64 digits');
  refused({ trees: { before: OTHER, after: { ...FINAL, treeAlgorithm: 'git-v2' } } }, 'an unknown tree algorithm');
  refused({ diff: undefined }, 'no diff');
  refused({ diff: 42 }, 'a diff that is not text or bytes');
  refused({ cost: { currency: 'USD', knownSubtotal: NaN, complete: false } }, 'a NaN cost');
  refused({ cost: { currency: 'USD', knownSubtotal: Infinity, complete: false } }, 'an Infinity cost');
  refused({ cost: { currency: 'usd', knownSubtotal: 1, complete: false } }, 'a currency that is not ISO 4217 letters');
  refused({ cost: 'unknown' }, 'a cost given as text');
  refused({ baseCommit: 'xyz' }, 'a base commit that is not a Git id');
  refused({ commit: 'A'.repeat(40) }, 'a commit in upper case');
  refused({ ownerAcceptances: [{ criterionId: 'c-owner', treeAlgorithm: 'git-pinned-v1', tree: TREE_A, by: 'owner', at: 'yesterday' }] }, 'an acceptance time that is not ISO');
  refused({ ownerAcceptances: [{ criterionId: 'c-owner', tree: TREE_A, by: 'owner', at: AT }] }, 'an acceptance without its tree algorithm');
  refused({ ownerAcceptances: {} }, 'owner acceptances that are not a list');
  refused({ checkChanges: { format: 'other/1', criteria: [] } }, 'a check-changes report of another format');
  refused({ acceptance: { criteria: 'x' } }, 'an acceptance result without a list of criteria');
  refused({ ledger: 12 }, 'a ledger that is not bytes or text');
  refused({ secrets: 'one' }, 'secrets that are not a list');
  refused({ limits: { maxReceiptsPerCheck: 0 } }, 'a limit below one');
  refused({ limits: { maxOtherReceipts: 10 ** 9 } }, 'a limit above what the schema allows');
  // what the input checks let through but the statement cannot hold: the builder validates what it built and refuses to return it
  const handMade = (criteria) => ({ criteria, trusted: true, baselineSha256: null, edit: null });
  const check = { run: 'node pass.js', cwd: '.', timeout: 600, expect: { exit: 0 }, repeat: 1 };
  for (const [criteria, label] of [[[{ id: 'Not An Id', checks: [check] }], 'an id the schema refuses'], [[{ id: 'twin', checks: [check] }, { id: 'twin', checks: [check] }], 'a duplicate id']]) {
    assert.throws(() => buildAgentChangeStatement(matrixInput({ acceptance: handMade(criteria) })), (error) => error.code === 'pack_invalid' && Array.isArray(error.errors) && error.errors.length > 0, label);
  }
  // an acceptance result is read, never written to
  const frozen = structuredClone(trustedAcceptance);
  deepFreeze(frozen);
  assert.doesNotThrow(() => buildAgentChangeStatement(matrixInput({ acceptance: frozen })));
  // secrets as a function, as the ledger takes them
  assert.ok(!canonicalJson(buildAgentChangeStatement(matrixInput({ secrets: () => [SECRET] }))).includes(SECRET));
  ok('bad inputs refused with pack_bad_input: agent, trees (missing, unbounded, wrong length, unknown algorithm), diff, cost (NaN, Infinity, currency, text), commits, owner acceptances, report format, acceptance, ledger, secrets, limits; inputs are never written to');
}

function deepFreeze(value) {
  if (value && typeof value === 'object') { Object.freeze(value); for (const item of Object.values(value)) deepFreeze(item); }
  return value;
}

console.log(`verify-proof-pack: ${checks} checks passed [${elapsed()}]`);
