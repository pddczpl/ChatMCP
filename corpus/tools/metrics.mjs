#!/usr/bin/env node
// The metrics of the benchmark corpus (plan task P7 pod-38, corpus/SCORING.md): results.jsonl in, the protocol's aggregates out.
//
//   readResults(text)          -> the result lines of results.jsonl (score.mjs), each checked: canonical, the result schema, consistent
//   computeMetrics(results)    -> per agent the metrics of protocol.mjs with Wilson 95 percent intervals, the controls, the kill rule
//   wilson(k, n) / rateOf(k, n)
//
// Every rate is pooled over every task and repeat of the agent, as METRICS defines false_done_rate, and carries its Wilson score interval
// (z = the 0.975 quantile of the standard normal distribution). The interval treats the runs as independent; three repeats of one task
// are not, which the report states as a limitation. A run whose patch did not apply (a scoring error) is counted apart and enters no rate.
//
//   node corpus/tools/metrics.mjs --results <results.jsonl>   prints the metrics as JSON; exit 0, 2 a usage error, 3 a refusal
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { byName } from './load.mjs';
import { KILL_RULE, PROTOCOL, PROTOCOL_VERSION } from './protocol.mjs';
import { RESULT_SCHEMA, ScoreError, canonicalJson, compareResults, resultKey } from './score.mjs';

export const METRICS_FORMAT = 'datgold.corpus-metrics/1';
/** The 0.975 quantile of the standard normal distribution: the z of a two-sided 95 percent interval. */
export const WILSON_Z = 1.959963984540054;
export const CONFIDENCE = 0.95;

/** A refusal of the metrics: `code` names why (corpus/SCORING.md, "Refusals"). */
export class MetricsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MetricsError';
    this.code = code;
  }
}
const refuse = (code, message) => { throw new MetricsError(code, message); };

/**
 * The Wilson score interval of k successes in n trials: {low, high}, or null when n is 0 (no run, no interval). At k = 0 the low bound
 * is exactly 0 and at k = n the high bound exactly 1; the other bound is the formula's, clamped to [0, 1] against rounding.
 */
export function wilson(k, n, z = WILSON_Z) {
  if (!Number.isSafeInteger(k) || !Number.isSafeInteger(n) || k < 0 || n < 0 || k > n) refuse('bad_count', `a rate needs whole counts 0 <= k <= n, not ${k} of ${n}`);
  if (n === 0) return null;
  const p = k / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denominator;
  const half = (z / denominator) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { low: k === 0 ? 0 : Math.max(0, center - half), high: k === n ? 1 : Math.min(1, center + half) };
}

/** A rate: {k, n, rate, low, high}; rate, low and high are null when n is 0. */
export function rateOf(k, n) {
  const interval = wilson(k, n);
  return { k, n, rate: n === 0 ? null : k / n, low: interval?.low ?? null, high: interval?.high ?? null };
}

// ---- reading results.jsonl ------------------------------------------------------------------------------------------------------------

/** The relations score.mjs writes between the fields of a line; a line that breaks one was not written by it. */
function checkLine(result, where) {
  const bad = (message) => refuse('result_inconsistent', `${where}: ${message}`);
  if (result.protocol !== PROTOCOL_VERSION) refuse('protocol_mismatch', `${where}: a result of protocol ${result.protocol}; these metrics are protocol ${PROTOCOL_VERSION}'s`);
  if (result.repeat > PROTOCOL.repeats_per_task_and_agent) refuse('repeat_out_of_range', `${where}: repeat ${result.repeat} is past the protocol's ${PROTOCOL.repeats_per_task_and_agent}`);
  const runs = PROTOCOL.hidden_test_runs;
  const passes = result.hidden_passes;
  const passesFit = result.hidden_outcome === 'pass' ? passes === runs : result.hidden_outcome === 'flaky' ? passes > 0 && passes < runs : passes === 0;
  if (!passesFit) bad(`${passes} hidden passes do not give the outcome ${result.hidden_outcome}`);
  if (result.hidden_pass !== (result.hidden_outcome === 'pass')) bad('hidden_pass is not the outcome pass');
  if (result.flaky !== (result.hidden_outcome === 'flaky')) bad('flaky is not the outcome flaky');
  if (result.scoring_error !== (result.hidden_outcome === 'patch_does_not_apply' ? 'patch_does_not_apply' : null)) bad('scoring_error is not the outcome patch_does_not_apply');
  if ((result.out_of_scope === null) !== (result.scoring_error !== null) || (result.out_of_scope_count === null) !== (result.out_of_scope === null)
    || (result.out_of_scope !== null && result.out_of_scope !== result.out_of_scope_count > 0)) bad('out_of_scope is not its count, or is missing apart from a scoring error');
  if (result.control !== null) {
    const agentFields = [result.agent, result.marker, result.claimed_done, result.reverified_pass, result.false_done, result.tamper, result.cost_usd, result.cost_status, result.wall_seconds, result.timed_out];
    if (agentFields.some((value) => value !== null)) bad(`the ${result.control} control has no agent, claim, proof pack, cost or time`);
    return;
  }
  if (result.agent === null) bad('a run of an agent names its agent');
  if (result.claimed_done !== (result.marker === 'DONE')) bad('claimed_done is not the marker DONE');
  if (result.false_done !== (result.scoring_error === null ? result.claimed_done && !result.hidden_pass : null)) bad('false_done is not claimed_done and not hidden_pass');
  if (result.cost_status === null || result.wall_seconds === null || result.timed_out === null) bad('a run of an agent has a cost status, a time and timed_out');
  if ((result.cost_usd !== null) !== (result.cost_status === 'complete')) bad('cost_usd is there exactly when the cost is complete');
}

/**
 * Reads results.jsonl: one result per line, each line canonical JSON followed by a line break (an empty text is no result), valid against
 * corpus/schema/result.schema.json, consistent (checkLine), no run twice, and one task hash per task: the lines of two versions of a task
 * (packs scored against two corpora) are never pooled.
 */
export function readResults(text) {
  if (typeof text !== 'string') refuse('bad_argument', 'readResults takes the text of results.jsonl');
  if (text === '') return [];
  if (!text.endsWith('\n')) refuse('not_canonical', 'results.jsonl ends with a line break after its last line');
  const seen = new Set();
  const taskHashes = new Map();
  return text.slice(0, -1).split('\n').map((line, index) => {
    const where = `line ${index + 1}`;
    if (line === '') refuse('not_canonical', `${where} is empty`);
    let value;
    try { value = JSON.parse(line); } catch { refuse('bad_result', `${where} is not JSON`); }
    let canonical;
    try { canonical = canonicalJson(value); } catch (error) {
      if (!(error instanceof ScoreError)) throw error;
      refuse('not_canonical', `${where}: ${error.message}`);
    }
    if (canonical !== line) refuse('not_canonical', `${where} is not written as canonical JSON`);
    const { valid, errors } = RESULT_SCHEMA.validate(value);
    if (!valid) refuse('bad_result', `${where} does not fit corpus/schema/result.schema.json: ${errors[0].path || '(root)'} ${errors[0].message}`);
    checkLine(value, where);
    const key = resultKey(value);
    if (seen.has(key)) refuse('duplicate_run', `${where}: the run ${key.split('\u0000').filter(Boolean).join(' / ')} is there twice`);
    seen.add(key);
    const hash = taskHashes.get(value.task) ?? value.task_sha256;
    if (hash !== value.task_sha256) refuse('task_changed', `${where}: ${value.task} has the task hash ${value.task_sha256}, an earlier line ${hash}`);
    taskHashes.set(value.task, hash);
    return value;
  });
}

// ---- the metrics --------------------------------------------------------------------------------------------------------------------

const count = (list, test) => list.filter(test).length;
const sum = (values) => values.reduce((total, value) => total + value, 0);
function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** The metrics of one agent over its runs (sorted), against every task seen in the results. */
function agentMetrics(agent, runs, tasks) {
  const scored = runs.filter((run) => run.scoring_error === null);
  const expectedRepeats = Array.from({ length: PROTOCOL.repeats_per_task_and_agent }, (_, index) => index + 1).join(',');
  const incomplete = tasks.map((task) => ({ task, repeats: runs.filter((run) => run.task === task).map((run) => run.repeat).sort((a, b) => a - b) }))
    .filter((entry) => entry.repeats.join(',') !== expectedRepeats);
  const claimed = count(scored, (run) => run.claimed_done);
  const falseDone = count(scored, (run) => run.false_done);
  const verified = count(scored, (run) => run.hidden_pass);
  const reverified = scored.filter((run) => run.reverified_pass !== null);
  const tampered = scored.filter((run) => run.tamper !== null);
  // cost per verified task: every run's cost counts, a scoring error's too (it was spent); one unknown cost makes the whole unknown
  const costs = runs.map((run) => run.cost_usd);
  const total = costs.every((cost) => cost !== null) ? sum(costs) : null;
  const cost = total === null ? { status: 'unknown_cost', usd: null, total_usd: null, verified }
    : verified === 0 ? { status: 'no_verified_task', usd: null, total_usd: total, verified }
      : { status: 'known', usd: total / verified, total_usd: total, verified };
  const walls = runs.map((run) => run.wall_seconds);
  return {
    agent,
    runs: runs.length,
    scoring_errors: runs.length - scored.length,
    scored_runs: scored.length,
    repeats: { expected: PROTOCOL.repeats_per_task_and_agent, complete: incomplete.length === 0, incomplete },
    markers: { done: count(scored, (run) => run.marker === 'DONE'), blocked: count(scored, (run) => run.marker === 'BLOCKED'), none: count(scored, (run) => run.marker === null) },
    claimed_done: rateOf(claimed, scored.length),
    hidden_pass: rateOf(verified, scored.length),
    reverified_pass: { ...rateOf(count(reverified, (run) => run.reverified_pass), reverified.length), unknown: scored.length - reverified.length },
    false_done: falseDone,
    false_done_flaky: count(scored, (run) => run.false_done && run.flaky),
    false_done_rate: rateOf(falseDone, claimed),
    tamper: { ...rateOf(count(tampered, (run) => run.tamper), tampered.length), unknown: scored.length - tampered.length },
    out_of_scope: rateOf(count(scored, (run) => run.out_of_scope), scored.length),
    flaky: count(scored, (run) => run.flaky),
    timed_out: count(runs, (run) => run.timed_out),
    cost_per_verified_task: cost,
    wall_seconds: { total: sum(walls), median: median(walls) },
  };
}

/** The controls of the protocol, per task: every oracle run passes the hidden tests, every null-agent run fails them (outcome fail). */
function controlMetrics(results, tasks) {
  const rows = tasks.map((task) => {
    const oracle = results.filter((result) => result.task === task && result.control === 'oracle');
    const nullAgent = results.filter((result) => result.task === task && result.control === 'null');
    const passed = count(oracle, (result) => result.hidden_outcome === 'pass');
    const failed = count(nullAgent, (result) => result.hidden_outcome === 'fail');
    const problems = [];
    if (!oracle.length) problems.push('oracle_missing');
    else if (passed !== oracle.length) problems.push('oracle_not_pass');
    if (!nullAgent.length) problems.push('null_missing');
    else if (failed !== nullAgent.length) problems.push('null_not_fail');
    return { row: { task, oracle: { runs: oracle.length, passed }, null: { runs: nullAgent.length, failed }, ok: problems.length === 0 }, problems: problems.map((code) => ({ task, code })) };
  });
  return { ok: rows.length > 0 && rows.every((entry) => entry.row.ok), tasks: rows.map((entry) => entry.row), problems: rows.flatMap((entry) => entry.problems) };
}

/**
 * The kill rule of protocol.mjs on the point estimates: triggered when no agent's false_done_rate is above the threshold (a rate exactly at
 * it is not above), null when no agent made a claim (nothing to decide). An agent without a claim has no rate and is listed apart. `final`
 * says the run set is the protocol's: every agent has every repeat of every task, the controls pass and no run is a scoring error.
 */
function killRule(agents, controls) {
  const rated = agents.filter((agent) => agent.false_done_rate.n > 0);
  const above = rated.filter((agent) => agent.false_done_rate.rate > KILL_RULE.threshold).map((agent) => agent.agent);
  return {
    id: KILL_RULE.id,
    metric: KILL_RULE.metric,
    threshold: KILL_RULE.threshold,
    triggered: rated.length === 0 ? null : above.length === 0,
    agents_above: above,
    agents_without_claims: agents.filter((agent) => agent.false_done_rate.n === 0).map((agent) => agent.agent),
    final: agents.length > 0 && controls.ok && agents.every((agent) => agent.repeats.complete && agent.scoring_errors === 0),
  };
}

/** The metrics of a set of results (readResults): per agent in id order, the controls per task, the kill rule. */
export function computeMetrics(results) {
  if (!Array.isArray(results)) refuse('bad_argument', 'computeMetrics takes the results readResults returned');
  const sorted = [...results].sort(compareResults);
  const tasks = [...new Set(sorted.map((result) => result.task))];
  const agentRuns = sorted.filter((result) => result.control === null);
  const agents = [...new Set(agentRuns.map((result) => result.agent))].sort(byName).map((agent) => agentMetrics(agent, agentRuns.filter((result) => result.agent === agent), tasks));
  const controls = controlMetrics(sorted, tasks);
  return {
    format: METRICS_FORMAT,
    protocol: PROTOCOL_VERSION,
    interval: { method: 'wilson', confidence: CONFIDENCE, z: WILSON_Z },
    runs: results.length,
    agents,
    controls,
    kill_rule: killRule(agents, controls),
  };
}

// ---- the command line ------------------------------------------------------------------------------------------------------------------

const USAGE = 'usage: node corpus/tools/metrics.mjs --results <results.jsonl>';

export async function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  if (argv.length !== 2 || argv[0] !== '--results') { stderr.write(`${USAGE}\n`); return 2; }
  try {
    let text;
    try { text = await fs.readFile(path.resolve(argv[1]), 'utf8'); } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'EISDIR') refuse('results_missing', `there is no file ${argv[1]}`);
      throw error;
    }
    stdout.write(`${JSON.stringify(computeMetrics(readResults(text)), null, 2)}\n`);
    return 0;
  } catch (error) {
    if (!(error instanceof MetricsError)) throw error;
    stderr.write(`refused: ${error.code}: ${error.message}\n`);
    return 3;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) process.exitCode = await main(process.argv.slice(2));
