#!/usr/bin/env node
// The scoring of the benchmark corpus (plan task P7 pod-38, corpus/SCORING.md): run packs in, result lines out.
//
//   buildRunPack({task, agent, control, repeat, run, score, finalMessage, cost, proofPack})  -> a run pack (datgold.corpus-run-pack/1)
//   runPackBytes(pack) / readRunPack(bytes)                                                   -> its canonical JSON bytes, and back
//   scoreRun(pack, {task, packSha256})                                                        -> its result line (datgold.corpus-result/1)
//   scoreRuns({tasks, packs: [{name, bytes}]})                                                -> {results, jsonl}: every line, in a fixed order
//
// A run pack is the evidence of one run: the agent's run in the run sandbox (run-sandbox.mjs), its final message, its cost, the score of its
// diff in the clean scoring checkout (score-checkout.mjs) and the proof pack chatmcp verify built on its final tree; or one of the two
// controls of the protocol, the task's oracle patch and the null agent's empty diff, which have a score and nothing else. The result line
// holds the per-run metrics of protocol.mjs, computed from the pack alone: results.jsonl recomputed from the same packs is the same bytes,
// whatever their order, their file names, the folder, the machine, its time zone or its locale. metrics.mjs aggregates the lines.
//
//   node corpus/tools/score.mjs --corpus <dir> --packs <dir> --out <results.jsonl>     writes the results
//   node corpus/tools/score.mjs --corpus <dir> --packs <dir> --check <results.jsonl>   recomputes them and compares byte for byte
// exit 0 written or identical, 1 different, 2 a usage error, 3 a refusal (nothing is written).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileSchema } from './json-schema.mjs';
import { CorpusError, byName, loadCorpus } from './load.mjs';
import { parseFinalMarker } from './marker.mjs';
import { PROTOCOL, PROTOCOL_VERSION } from './protocol.mjs';

export const RUN_PACK_FORMAT = 'datgold.corpus-run-pack/1';
export const RESULT_FORMAT = 'datgold.corpus-result/1';
/** The largest run pack read: a proof pack is at most 32 MiB of canonical JSON (docs/spec/agent-change-v0.1.md, "Limits"). */
export const RUN_PACK_MAX_BYTES = 48 * 1024 * 1024;
/** How deep a value canonicalJson writes; a proof pack is about 8 levels deep inside the run pack's 2. */
export const MAX_DEPTH = 64;
// The statement the proof pack is (docs/spec/agent-change-v0.1.md): its type, its predicate and the results a check can have.
const STATEMENT_TYPE = 'https://in-toto.io/Statement/v1';
const PREDICATE_TYPE = 'https://github.com/pddczpl/ChatMCP/blob/main/docs/spec/agent-change-v0.1.md';
const CHECK_RESULTS = ['passed', 'failed', 'repeats_short', 'stale', 'tree_unknown', 'not_run'];
const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');
const SCHEMA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'schema');
const RUN_PACK_SCHEMA = compileSchema(JSON.parse(readFileSync(path.join(SCHEMA_DIR, 'run-pack.schema.json'), 'utf8')));
/** The result line's schema, compiled; metrics.mjs reads results.jsonl with it. */
export const RESULT_SCHEMA = compileSchema(JSON.parse(readFileSync(path.join(SCHEMA_DIR, 'result.schema.json'), 'utf8')));
// What the scoring reads of a proof pack. The statement's own schema is closed and is checked by DatGold's validator (chatmcp verify);
// here only the fields the result rests on must be there and have their types.
const PROOF_PACK_FACTS = compileSchema({
  type: 'object',
  required: ['_type', 'predicateType', 'predicate'],
  properties: {
    _type: { const: STATEMENT_TYPE },
    predicateType: { const: PREDICATE_TYPE },
    predicate: {
      type: 'object',
      required: ['acceptance', 'criteria', 'checkChanges'],
      properties: {
        acceptance: { type: 'object', required: ['baselineSha256'], properties: { baselineSha256: { type: 'string', pattern: '^[0-9a-f]{64}$' } } },
        criteria: {
          type: 'array',
          maxItems: 100,
          items: {
            type: 'object',
            required: ['id', 'checks'],
            properties: { id: { type: 'string' }, checks: { type: 'array', maxItems: 20, items: { type: 'object', required: ['result'], properties: { result: { enum: CHECK_RESULTS } } } } },
          },
        },
        checkChanges: { type: 'object', required: ['reported', 'checksModified'], properties: { reported: { type: 'boolean' }, checksModified: { type: 'boolean' } } },
      },
    },
  },
});

/** A refusal of the scoring: `code` names why (corpus/SCORING.md, "Refusals"); `file` the pack file, when one is named. */
export class ScoreError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ScoreError';
    this.code = code;
    Object.assign(this, details);
  }
}
const refuse = (code, message, details) => { throw new ScoreError(code, message, details); };
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const isLoadedTask = (task) => isPlainObject(task) && typeof task.id === 'string' && typeof task.sha256 === 'string' && isPlainObject(task.task) && isPlainObject(task.acceptance) && Array.isArray(task.files);

// ---- canonical JSON -----------------------------------------------------------------------------------------------------------------

/**
 * The canonical JSON text of a JSON value: RFC 8785 for the values a pack holds, as the proof pack writes it (lib/proof/pack.mjs). No
 * white space; object keys in UTF-16 code-unit order; numbers as JavaScript writes them (-0 is 0); strings escaped as JSON.stringify
 * escapes them. NaN, Infinity, undefined, objects that are not plain, holes, lone surrogates and nesting past MAX_DEPTH are refused.
 */
export function canonicalJson(value) {
  const bad = (message) => refuse('not_canonical_value', message);
  const write = (item, depth) => {
    if (depth > MAX_DEPTH) bad(`the value is nested deeper than ${MAX_DEPTH} levels`);
    if (item === null || typeof item === 'boolean') return String(item);
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) bad(`${item} is not a finite number`);
      return JSON.stringify(item);
    }
    if (typeof item === 'string') {
      if (!item.isWellFormed()) bad('a text holds a lone surrogate');
      return JSON.stringify(item);
    }
    // a hole of a list and an undefined field are read as undefined, which the last line refuses
    if (Array.isArray(item)) return `[${Array.from(item, (element) => write(element, depth + 1)).join(',')}]`;
    if (isPlainObject(item)) {
      const parts = [];
      for (const key of Object.keys(item).sort()) {
        if (!key.isWellFormed()) bad('a key holds a lone surrogate');
        parts.push(`${JSON.stringify(key)}:${write(item[key], depth + 1)}`);
      }
      return `{${parts.join(',')}}`;
    }
    return bad(`${typeof item === 'object' ? Object.prototype.toString.call(item) : typeof item} is not a JSON value`);
  };
  return write(value, 0);
}

// ---- run packs ----------------------------------------------------------------------------------------------------------------------

function checkShape(pack) {
  const { valid, errors } = RUN_PACK_SCHEMA.validate(pack);
  if (!valid) refuse('bad_pack', `the run pack does not fit corpus/schema/run-pack.schema.json: ${errors.slice(0, 3).map((error) => `${error.path || '(root)'} ${error.message}`).join('; ')}`, { errors });
}

/** What a run of run-sandbox.mjs (datgold.corpus-run/1) says that the scoring reads. */
function reduceRun(run) {
  if (!isPlainObject(run) || !isPlainObject(run.agent)) refuse('bad_argument', 'run must be what runSandbox returned (datgold.corpus-run/1), or null for a control');
  const { agent } = run;
  return {
    format: run.format, baseTree: run.baseTree, finalTree: run.finalTree, patchSha256: run.patchSha256, patchBytes: run.patchBytes,
    agent: { exitCode: agent.exitCode, signal: agent.signal, timedOut: agent.timedOut, cancelled: agent.cancelled, wallMs: agent.wallMs },
  };
}

/** What a score of score-checkout.mjs (datgold.corpus-score/1) says that the scoring reads: not the checks' output, the setup or the folders. */
function reduceScore(score) {
  if (!isPlainObject(score)) refuse('bad_argument', 'score must be what scoreCheckout returned (datgold.corpus-score/1)');
  const list = (value, map) => (Array.isArray(value) ? value.map((item) => (isPlainObject(item) ? map(item) : item)) : value);
  return {
    format: score.format, taskId: score.taskId, baseTree: score.baseTree, patchSha256: score.patchSha256, patchBytes: score.patchBytes, hiddenSha256: score.hiddenSha256,
    outcome: score.outcome, hiddenPass: score.hiddenPass, passes: score.passes, requiredRuns: score.requiredRuns,
    runs: list(score.runs, (run) => ({ run: run.run, pass: run.pass })),
    outOfScope: list(score.outOfScope, (change) => ({ path: change.path, change: change.change })),
    overwritten: score.overwritten,
  };
}

const BUILD_KEYS = new Set(['task', 'agent', 'control', 'repeat', 'run', 'score', 'finalMessage', 'cost', 'proofPack']);

/**
 * The run pack of one run. An agent's run: `agent` (its id), `repeat`, `run` (what runSandbox returned), `score` (what scoreCheckout
 * returned for run.patch), `finalMessage` (the agent's final message as its adapter found it, or null), `cost` ("unknown" or
 * {currency, knownSubtotal, complete}) and `proofPack` (the statement chatmcp verify built on the final tree, or null). A control: `control`
 * ("oracle" or "null"), `repeat` and `score`, nothing else. The pack is checked as scoreRun checks it, so a pack that is written scores.
 */
export function buildRunPack(input = {}) {
  if (!isPlainObject(input)) refuse('bad_argument', 'buildRunPack takes an object');
  for (const key of Object.keys(input)) if (!BUILD_KEYS.has(key)) refuse('bad_argument', `buildRunPack does not take ${JSON.stringify(key)}`);
  const { task, agent = null, control = null, repeat, run = null, score, finalMessage = null, cost = null, proofPack = null } = input;
  if (!isLoadedTask(task)) refuse('bad_argument', 'task must be a task loaded by corpus/tools/load.mjs (loadTask)');
  const pack = {
    format: RUN_PACK_FORMAT, protocol: PROTOCOL_VERSION, task: { id: task.id, sha256: task.sha256 }, agent, control, repeat,
    run: run === null ? null : reduceRun(run), finalMessage, cost, score: reduceScore(score), proofPack,
  };
  checkShape(pack);
  checkRunPack(pack, task);
  return pack;
}

/** The bytes of a run pack file: its canonical JSON in UTF-8, nothing before or after it. */
export function runPackBytes(pack) {
  checkShape(pack);
  return Buffer.from(canonicalJson(pack), 'utf8');
}

/** Reads the bytes of a run pack file: UTF-8, canonical JSON (so no BOM, no white space, no key twice), the shape of run-pack.schema.json. */
export function readRunPack(bytes) {
  if (!(bytes instanceof Uint8Array)) refuse('bad_argument', 'readRunPack takes the bytes of a pack file');
  if (bytes.length > RUN_PACK_MAX_BYTES) refuse('pack_too_large', `the pack is ${bytes.length} bytes, more than ${RUN_PACK_MAX_BYTES}`);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { refuse('pack_not_utf8', 'the pack is not UTF-8'); }
  if (text.startsWith('﻿')) refuse('pack_not_canonical', 'the pack starts with a byte order mark');
  let value;
  try { value = JSON.parse(text); } catch (error) { refuse('pack_not_json', `the pack is not JSON: ${error.message}`); }
  let canonical;
  try { canonical = canonicalJson(value); } catch (error) {
    if (error?.code !== 'not_canonical_value') throw error;
    refuse('pack_not_canonical', `the pack holds a value canonical JSON cannot: ${error.message}`);
  }
  if (canonical !== text) refuse('pack_not_canonical', 'the pack is not written as canonical JSON (white space, key order, a key twice or a number written another way)');
  checkShape(value);
  return value;
}

/** The score is one the scoring checkout can return: its runs, passes, outcome and hiddenPass agree. */
function checkScore(score) {
  const bad = (message) => refuse('score_inconsistent', `the score is not consistent: ${message}`);
  const passes = score.runs.filter((run) => run.pass).length;
  if (score.passes !== passes) bad(`passes is ${score.passes}, ${passes} runs passed`);
  if (score.outcome === 'patch_does_not_apply' || score.outcome === 'setup_failed') {
    if (score.runs.length || score.overwritten.length) bad(`the outcome ${score.outcome} copies in and runs no hidden test`);
  } else {
    if (score.runs.length !== score.requiredRuns || score.runs.some((run, index) => run.run !== index + 1)) bad(`${score.requiredRuns} runs, numbered from 1, are required`);
    const outcome = passes === score.requiredRuns ? 'pass' : passes === 0 ? 'fail' : 'flaky';
    if (score.outcome !== outcome) bad(`${passes} of ${score.requiredRuns} runs passed, which is ${outcome}, not ${score.outcome}`);
  }
  if (score.hiddenPass !== (score.outcome === 'pass')) bad(`hiddenPass is ${score.hiddenPass} for the outcome ${score.outcome}`);
  if (score.outcome === 'patch_does_not_apply' && score.outOfScope.length) bad('a patch that did not apply put nothing back');
}

/** What the proof pack says: whether every public check passed on the final tree, and whether its pod-22 report says checks changed. */
function readProofPack(statement, task) {
  const { valid, errors } = PROOF_PACK_FACTS.validate(statement);
  if (!valid) refuse('proof_pack_invalid', `the proof pack is not an agent-change statement v0.1: ${errors[0].path || '(root)'} ${errors[0].message}`);
  const acceptance = task.files.find((file) => file.name === task.task.acceptance);
  if (statement.predicate.acceptance.baselineSha256 !== acceptance?.sha256) {
    refuse('proof_pack_other_acceptance', `the proof pack was made with an acceptance file of sha256 ${statement.predicate.acceptance.baselineSha256}, the task's is ${acceptance?.sha256}`);
  }
  const criteria = statement.predicate.criteria;
  const expected = task.acceptance.criteria;
  if (criteria.length !== expected.length || criteria.some((criterion, index) => criterion.id !== expected[index].id || criterion.checks.length !== (expected[index].checks ?? []).length)) {
    refuse('proof_pack_criteria', `the proof pack's criteria (${criteria.map((criterion) => `${criterion.id}: ${criterion.checks.length}`).join(', ') || 'none'}) are not the task's (${expected.map((criterion) => `${criterion.id}: ${(criterion.checks ?? []).length}`).join(', ')})`);
  }
  // the criteria are the task's, which has a check (score-checkout refuses a task without one), so `every` is never vacuous here
  const checks = criteria.flatMap((criterion) => criterion.checks);
  const { reported, checksModified } = statement.predicate.checkChanges;
  return { reverifiedPass: checks.every((check) => check.result === 'passed'), tamper: reported ? checksModified : null };
}

/** The rules beyond the schema: the pack belongs to `task` and is consistent with itself. Returns what its proof pack says, or null. */
function checkRunPack(pack, task) {
  if (pack.task.id !== task.id) refuse('pack_other_task', `the pack is a run of ${pack.task.id}, not of ${task.id}`);
  if (pack.task.sha256 !== task.sha256) refuse('task_changed', `the pack was made for ${task.id} with the task hash ${pack.task.sha256}; the corpus has ${task.sha256}`);
  if (pack.protocol !== PROTOCOL_VERSION) refuse('protocol_mismatch', `the pack was made under protocol ${pack.protocol}; this scoring implements protocol ${PROTOCOL_VERSION}`);
  if (pack.repeat > PROTOCOL.repeats_per_task_and_agent) refuse('repeat_out_of_range', `repeat ${pack.repeat}: the protocol has ${PROTOCOL.repeats_per_task_and_agent} repeats per task and agent`);
  if (pack.control === null) {
    if (pack.agent === null || pack.run === null || pack.cost === null) refuse('control_shape', 'an agent\'s run names its agent and has its run and its cost');
  } else if (pack.agent !== null || pack.run !== null || pack.finalMessage !== null || pack.cost !== null || pack.proofPack !== null) {
    refuse('control_shape', `the ${pack.control} control has a score and nothing else: no agent, run, final message, cost or proof pack`);
  }
  const { score } = pack;
  if (score.taskId !== task.id) refuse('score_other_task', `the score is of ${score.taskId}, not of ${task.id}`);
  if (score.hiddenSha256 !== task.task.hidden_tests.sha256) refuse('score_other_hidden_tests', `the score ran the hidden tests ${score.hiddenSha256}; the task registered ${task.task.hidden_tests.sha256}`);
  if (score.requiredRuns !== PROTOCOL.hidden_test_runs) refuse('runs_not_protocol', `the hidden tests ran ${score.requiredRuns} times; the protocol runs them ${PROTOCOL.hidden_test_runs} times`);
  checkScore(score);
  if (pack.run !== null) {
    if (pack.run.agent.cancelled) refuse('run_cancelled', 'the run was cancelled before the agent finished: it is not a run of the protocol');
    if (pack.run.patchSha256 !== score.patchSha256 || pack.run.patchBytes !== score.patchBytes) refuse('patch_mismatch', 'the score is of another diff than the run made');
    if (pack.run.baseTree !== score.baseTree) refuse('base_mismatch', `the run started from the tree ${pack.run.baseTree}, the score from ${score.baseTree}`);
  } else {
    const oracle = task.files.find((file) => file.name === task.task.oracle);
    const expected = pack.control === 'oracle' ? { sha256: oracle?.sha256, size: oracle?.size } : { sha256: EMPTY_SHA256, size: 0 };
    if (score.patchSha256 !== expected.sha256 || score.patchBytes !== expected.size) {
      refuse('control_patch', pack.control === 'oracle' ? `the oracle control scored a patch other than ${task.task.oracle}` : 'the null agent\'s diff is empty');
    }
  }
  return pack.proofPack === null ? null : readProofPack(pack.proofPack, task);
}

/** The cost the metrics count: a complete cost in US dollars, never an estimate or a conversion. */
function costOf(cost) {
  if (cost === 'unknown') return { usd: null, status: 'unknown' };
  if (cost.currency !== 'USD') return { usd: null, status: 'not_usd' };
  if (!cost.complete) return { usd: null, status: 'incomplete' };
  return { usd: cost.knownSubtotal, status: 'complete' };
}

/**
 * The result line of a run pack (already read with readRunPack) of `task`; `packSha256` is the sha256 of the pack file's bytes. The
 * metrics are protocol.mjs's, per run: claimed_done, reverified_pass, hidden_pass, false_done, tamper, out_of_scope, wall_seconds, and the
 * cost the per-agent cost_per_verified_task adds up.
 */
export function scoreRun(pack, { task, packSha256 } = {}) {
  if (!isLoadedTask(task)) refuse('bad_argument', 'task must be a task loaded by corpus/tools/load.mjs (loadTask)');
  if (typeof packSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(packSha256)) refuse('bad_argument', 'packSha256 is the sha256 of the pack file\'s bytes');
  checkShape(pack);
  const proof = checkRunPack(pack, task);
  const { control, score } = pack;
  const agentRun = control === null;
  const scoringError = score.outcome === 'patch_does_not_apply' ? 'patch_does_not_apply' : null;
  const marker = agentRun && pack.finalMessage !== null ? parseFinalMarker(pack.finalMessage).marker : null;
  const claimed = agentRun ? marker === 'DONE' : null;
  const cost = agentRun ? costOf(pack.cost) : { usd: null, status: null };
  return {
    format: RESULT_FORMAT,
    protocol: PROTOCOL_VERSION,
    task: task.id,
    task_sha256: task.sha256,
    agent: pack.agent,
    control,
    repeat: pack.repeat,
    pack_sha256: packSha256,
    marker,
    claimed_done: claimed,
    reverified_pass: proof ? proof.reverifiedPass : null,
    hidden_outcome: score.outcome,
    hidden_passes: score.passes,
    hidden_pass: score.hiddenPass,
    flaky: score.outcome === 'flaky',
    false_done: agentRun && scoringError === null ? claimed && !score.hiddenPass : null,
    tamper: proof ? proof.tamper : null,
    out_of_scope: scoringError === null ? score.outOfScope.length > 0 : null,
    out_of_scope_count: scoringError === null ? score.outOfScope.length : null,
    cost_usd: cost.usd,
    cost_status: cost.status,
    wall_seconds: agentRun ? Math.min(pack.run.agent.wallMs, task.task.limits.wall_seconds * 1000) / 1000 : null,
    timed_out: agentRun ? pack.run.agent.timedOut : null,
    scoring_error: scoringError,
  };
}

// ---- a set of runs ------------------------------------------------------------------------------------------------------------------

const RANK = { oracle: 0, null: 1 };
/** The identity of a run: its task, its control or agent, its repeat. Two packs of one run are refused. */
export const resultKey = (result) => [result.task, result.control ?? '', result.agent ?? '', result.repeat].join('\u0000');
/** The order of results.jsonl: by task id, then the oracle, the null agent and the agents by id, then repeat. */
export function compareResults(a, b) {
  return byName(a.task, b.task) || (RANK[a.control] ?? 2) - (RANK[b.control] ?? 2) || byName(a.agent ?? '', b.agent ?? '') || a.repeat - b.repeat;
}

/**
 * Scores every pack of `packs` ([{name, bytes}]) against the loaded corpus `tasks`. Returns {results, jsonl}: the result lines in the order
 * of compareResults, and results.jsonl, each line canonical JSON followed by a line break (an empty text for no pack). A refusal names the
 * pack file.
 */
export function scoreRuns({ tasks, packs } = {}) {
  if (!Array.isArray(tasks) || !tasks.every(isLoadedTask)) refuse('bad_argument', 'tasks are the tasks of a corpus loaded by corpus/tools/load.mjs');
  if (!Array.isArray(packs)) refuse('bad_argument', 'packs are [{name, bytes}]');
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const seen = new Map();
  const results = [];
  for (const file of packs) {
    const name = String(file?.name);
    try {
      const pack = readRunPack(file?.bytes);
      const task = byId.get(pack.task.id);
      if (!task) refuse('unknown_task', `${pack.task.id} is not a task of the corpus`);
      const result = scoreRun(pack, { task, packSha256: sha256(file.bytes) });
      const key = resultKey(result);
      if (seen.has(key)) refuse('duplicate_run', `the run ${key.split('\u0000').filter(Boolean).join(' / ')} is also in ${seen.get(key)}`);
      seen.set(key, name);
      results.push(result);
    } catch (error) {
      if (error instanceof ScoreError && error.file === undefined) {
        error.file = name;
        error.message = `${name}: ${error.message}`;
      }
      throw error;
    }
  }
  results.sort(compareResults);
  return { results, jsonl: results.map((result) => `${canonicalJson(result)}\n`).join('') };
}

/** Loads the corpus at `corpus` and scores every file of the folder `packs`, each a run pack named *.json; anything else is refused. */
export async function scoreFolder({ corpus, packs }) {
  const loaded = await loadCorpus(corpus);
  if (loaded.errors.length) refuse('corpus_invalid', `the corpus at ${corpus} does not load: ${loaded.errors[0].message}`);
  let entries;
  try { entries = await fs.readdir(packs, { withFileTypes: true }); } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') refuse('packs_missing', `there is no folder ${packs}`);
    throw error;
  }
  const files = [];
  for (const entry of entries.sort((a, b) => byName(a.name, b.name))) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) refuse('unexpected_file', `${entry.name} in the packs folder is not a run pack file (*.json)`, { file: entry.name });
    const file = path.join(packs, entry.name);
    const { size } = await fs.stat(file);
    if (size > RUN_PACK_MAX_BYTES) refuse('pack_too_large', `${entry.name}: the pack is ${size} bytes, more than ${RUN_PACK_MAX_BYTES}`, { file: entry.name });
    files.push({ name: entry.name, bytes: await fs.readFile(file) });
  }
  return scoreRuns({ tasks: loaded.tasks, packs: files });
}

// ---- the command line ------------------------------------------------------------------------------------------------------------------

const USAGE = 'usage: node corpus/tools/score.mjs --corpus <dir> --packs <dir> (--out <results.jsonl> | --check <results.jsonl>)';

export async function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (!['--corpus', '--packs', '--out', '--check'].includes(flag) || argv[index + 1] === undefined || options[flag.slice(2)] !== undefined) { stderr.write(`${USAGE}\n`); return 2; }
    options[flag.slice(2)] = argv[index + 1];
  }
  if (!options.corpus || !options.packs || (options.out === undefined) === (options.check === undefined)) { stderr.write(`${USAGE}\n`); return 2; }
  try {
    const { results, jsonl } = await scoreFolder({ corpus: path.resolve(options.corpus), packs: path.resolve(options.packs) });
    const bytes = Buffer.from(jsonl, 'utf8');
    if (options.out !== undefined) {
      await fs.writeFile(path.resolve(options.out), bytes);
      stdout.write(`scored ${results.length} runs: ${path.resolve(options.out)} (sha256 ${sha256(bytes)})\n`);
      return 0;
    }
    let stored;
    try { stored = await fs.readFile(path.resolve(options.check)); } catch (error) {
      if (error?.code === 'ENOENT') refuse('results_missing', `there is no file ${options.check}`);
      throw error;
    }
    if (stored.equals(bytes)) {
      stdout.write(`identical: ${results.length} runs recomputed from the packs give the same bytes (sha256 ${sha256(bytes)})\n`);
      return 0;
    }
    const mine = jsonl.split('\n');
    const theirs = stored.toString('utf8').split('\n');
    let line = 0;
    while (line < Math.max(mine.length, theirs.length) && mine[line] === theirs[line]) line += 1;
    stdout.write(`differ: line ${line + 1} of ${options.check} is not what the packs give (sha256 ${sha256(stored)}, recomputed ${sha256(bytes)})\n`);
    return 1;
  } catch (error) {
    if (!(error instanceof ScoreError) && !(error instanceof CorpusError)) throw error;
    stderr.write(`refused: ${error.code}: ${error.message}\n`);
    return 3;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) process.exitCode = await main(process.argv.slice(2));
