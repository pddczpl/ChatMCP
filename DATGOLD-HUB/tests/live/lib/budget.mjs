// The spend governor of the opt-in live runner (tests/evaluate-live.mjs, P7 bc-2; how to run it: docs/EVALUATION.md).
//
// The cap lives HERE, in the runner, and deliberately not in the Hub: the Hub imposes no request, token or money quota (lib/request-budget.mjs) and its
// scripted benchmark checks that it stays so (tests/benchmarks/run-offline.mjs, case no-local-token-cap). Nothing under lib/ imports this file.
//
// What it does:
//   - the CEILING of one request: (context window x input rate + max output x output rate) at the runner's conservative rates, plus a safety margin. It is
//     the most one request can cost by the provider's own limits, so it needs no trust in the Hub; a provider without one of those numbers is refused.
//   - SPEND of a task: the Hub's cost ledger (modelCost.knownSubtotalUsd) for the responses it priced, plus the ceiling for every request the Hub counted
//     (usage.httpRequests) that has no priced response: in flight, failed, retried, without usage, or without a price. A figure with such requests in it is
//     an UPPER BOUND and says so (basis 'upper_bound'); it is never presented as a bill.
//   - the STOP rule: spent + one ceiling > cap -> cancel the task (POST /api/tasks/cancel) and end the run with 'budget_exhausted'. A request in flight is
//     already in "spent" at the ceiling, so the rule leaves room for it and for the next one: the run ends within cap + one ceiling as long as no more than
//     one response comes back between two polls (each poll is at most MAX_POLL_MS apart). It cannot see what the provider does on its side (its own
//     retries, a gateway's fallbacks) nor what the Hub sends outside a task (the connection check): the provider-side cap is the real backstop.
//   - the PRE-FLIGHT: the effective cap is the smaller of --budget-usd and what the monthly cap leaves after this month's ledger and one ceiling of
//     overshoot; it must hold two ceilings (one request in flight and the next), and the calibrated estimate of the tasks (the 90th percentile of five or
//     more earlier unstopped runs of the same task on the same provider and model, from the ledger) plus two ceilings.
//   - the LEDGER (bench-results/ledger.jsonl): one JSON object per line, appended with O_APPEND in one write and fsync'ed, so that runs on this machine
//     share one monthly cap. A run first appends a reservation (its effective cap + one ceiling), re-reads the file and counts only the runs whose first
//     line comes before its own (two runs that reserve at the same moment are ordered by the file); then a line per task and a settlement. A run that
//     never settled (killed) counts as its whole reservation. An unreadable line (a truncated tail, a hand edit) is skipped and reported; an append first
//     closes a line that a killed writer left open.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
/** The global ledger of this machine's live runs (not committed: bench-results/ is ignored by git). */
export const DEFAULT_LEDGER = path.join(REPO, 'bench-results', 'ledger.jsonl');
/** Added to the ceiling of one request: the prices are a dated public list, not a bill. */
export const SAFETY_MARGIN = 0.25;
export const DEFAULT_POLL_MS = 500;
/** The plan's "poll every 2 s" is the slowest the governor may look. */
export const MAX_POLL_MS = 2000;
export const CANCEL_TIMEOUT_MS = 10_000;
/** How long a task may go on after the first cancel attempt before the Hub itself is stopped. */
export const CANCEL_GRACE_MS = 30_000;
export const CALIBRATION_MIN_SAMPLES = 5;
const LEDGER_VERSION = 1;
const RECORD_TYPES = new Set(['reserve', 'task', 'settle']);

/** A run the governor will not start (exit 2 in the runner). */
export class BudgetRefusal extends Error {}
const refuse = (message) => { throw new BudgetRefusal(message); };
const money = (value) => Number(value.toFixed(8));
const usd = (value) => `${money(value)} USD`;
const price = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const tokens = (value) => Number.isSafeInteger(value) && value > 0;
const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);

/** A cap is a positive, finite amount in USD; anything else (0, negative, NaN, Infinity, a string) is refused. */
export function checkCapUsd(value, label = 'the cap') {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) refuse(`${label} must be a positive amount in USD, not ${String(value)}`);
  return value;
}

/** The most one request can cost by the provider's own limits, with the safety margin. Refused (never guessed) when a number is missing. */
export function requestCeiling({ rates, contextWindow, maxOutput, margin = SAFETY_MARGIN } = {}) {
  if (!rates || !price(rates.input) || !price(rates.output)) refuse('the ceiling of one request needs the input and output price (USD per million tokens), and the provider has none');
  if (!tokens(contextWindow)) refuse(`the ceiling of one request needs the provider's context window (tokens), not ${String(contextWindow)}`);
  if (!tokens(maxOutput)) refuse(`the ceiling of one request needs the provider's maximum output (tokens), not ${String(maxOutput)}`);
  if (!price(margin)) throw new RangeError(`the safety margin must be 0 or more, not ${String(margin)}`);
  const bare = (contextWindow * rates.input + maxOutput * rates.output) / 1e6;
  return { usd: money(bare * (1 + margin)), contextWindow, maxOutput, rates: { input: rates.input, output: rates.output }, margin };
}

/**
 * What a task has spent, as the governor counts it: the Hub's priced responses, plus the ceiling for every counted request without a priced response.
 * A task without its request count cannot be bounded: that is an error, not a zero.
 */
export function taskSpend(task, ceilingUsd) {
  const httpRequests = task?.usage?.httpRequests;
  if (!Number.isSafeInteger(httpRequests) || httpRequests < 0) throw new TypeError(`task ${task?.id ?? '?'} has no request count (usage.httpRequests): its spend cannot be bounded`);
  const cost = task.modelCost ?? {};
  const knownUsd = price(cost.knownSubtotalUsd) ? cost.knownSubtotalUsd : 0;
  const pricedResponses = count(cost.pricedResponses);
  const chargedRequests = Math.max(0, httpRequests - pricedResponses);
  return {
    usd: money(knownUsd + chargedRequests * ceilingUsd), knownUsd: money(knownUsd), httpRequests, pricedResponses, chargedRequests,
    basis: chargedRequests > 0 ? 'upper_bound' : 'ledger',
  };
}

/** The stop rule: the next request could pass the cap. */
export function shouldStop({ spentUsd, ceilingUsd, capUsd }) {
  return money(spentUsd + ceilingUsd) > capUsd ? 'budget_exhausted' : null;
}

/** The nearest-rank 90th percentile, or null without samples. */
export function percentile90(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(0.9 * sorted.length) - 1];
}

/** Per task id: how many earlier unstopped runs of it on this provider and model the ledger holds, and their p90 once there are enough. */
export function calibrate(records, { provider, model, taskIds }) {
  const result = {};
  for (const id of taskIds) {
    const samples = records
      .filter((record) => record.type === 'task' && record.provider === provider && record.model === model && record.task === id && record.stoppedBy === null)
      .map((record) => record.usd);
    result[id] = { samples: samples.length, p90Usd: samples.length >= CALIBRATION_MIN_SAMPLES ? percentile90(samples) : null };
  }
  return result;
}

/** The pre-flight: the effective cap of a run and its estimate, or a BudgetRefusal that says which number does not fit. */
export function planRun({ tasks, ceilingUsd, budgetUsd, monthlyCapUsd, committedUsd = 0, calibration = {} }) {
  checkCapUsd(budgetUsd, '--budget-usd');
  checkCapUsd(monthlyCapUsd, '--monthly-cap-usd');
  const needed = money(2 * ceilingUsd);
  if (budgetUsd < needed) {
    refuse(`--budget-usd ${budgetUsd} cannot run one request: the governor needs two ceilings (${usd(needed)}: the request in flight and the next one), where one request costs at most ${usd(ceilingUsd)} by the provider's limits`);
  }
  const room = money(monthlyCapUsd - committedUsd - ceilingUsd);
  const effectiveCapUsd = money(Math.min(budgetUsd, room));
  if (effectiveCapUsd < needed) {
    refuse(`the monthly cap (--monthly-cap-usd ${monthlyCapUsd}) leaves ${usd(Math.max(0, monthlyCapUsd - committedUsd))} this month (${usd(committedUsd)} is in the ledger); less one ceiling of overshoot that is ${usd(Math.max(0, room))}, below the two ceilings (${usd(needed)}) one request needs`);
  }
  const calibrated = [];
  const uncalibrated = [];
  for (const task of tasks) {
    const entry = calibration[task.id];
    if (entry && entry.p90Usd !== null && entry.p90Usd !== undefined) calibrated.push({ task: task.id, samples: entry.samples, p90Usd: entry.p90Usd });
    else uncalibrated.push(task.id);
  }
  const estimateUsd = money(calibrated.reduce((sum, item) => sum + item.p90Usd, 0));
  const worstCaseUsd = money(estimateUsd + needed);
  if (worstCaseUsd > effectiveCapUsd) {
    refuse(`the calibrated estimate (p90 of earlier runs: ${calibrated.map((item) => `${item.task} ${usd(item.p90Usd)} of ${item.samples}`).join(', ')}) plus two ceilings is ${usd(worstCaseUsd)}, above the effective cap of ${usd(effectiveCapUsd)}`);
  }
  const warnings = [];
  if (ceilingUsd === 0) warnings.push('the price is 0: a request costs nothing by the providers file, so the runner cannot limit spend (only the step and minute limits apply)');
  return { effectiveCapUsd, estimateUsd, worstCaseUsd, calibrated, uncalibrated, warnings };
}

// ---- the ledger -------------------------------------------------------------------------------------------------------------------------------------

export const monthOf = (date) => date.toISOString().slice(0, 7);

function validRecord(record) {
  return Boolean(record) && typeof record === 'object' && !Array.isArray(record) && record.v === LEDGER_VERSION && RECORD_TYPES.has(record.type)
    && typeof record.run === 'string' && record.run.length > 0 && record.run.length <= 200
    && typeof record.month === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(record.month) && price(record.usd);
}

/** Every readable record, in file order with its line number; the numbers of the lines that are not one (an empty line is neither). */
export function readLedger(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return { records: [], corrupt: [] }; throw error; }
  const records = [];
  const corrupt = [];
  text.split('\n').forEach((raw, index) => {
    const line = raw.trim();
    if (!line) return;
    let record = null;
    try { record = JSON.parse(line); } catch { /* reported as corrupt */ }
    if (validRecord(record)) records.push({ ...record, line: index + 1 });
    else corrupt.push(index + 1);
  });
  return { records, corrupt };
}

/** Appends one record as one line: one write on a file opened for appending (whole lines even with several writers), then fsync. */
export function appendLedger(file, record) {
  if (!validRecord(record)) throw new TypeError(`not a ledger record: ${JSON.stringify(record)}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'a+');
  try {
    // A writer killed in the middle of a line left it open: close it first, or this record would be glued to it and lost with it.
    const { size } = fs.fstatSync(fd);
    let prefix = '';
    if (size > 0) {
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, size - 1);
      if (last[0] !== 0x0a) prefix = '\n';
    }
    const bytes = Buffer.from(`${prefix}${JSON.stringify(record)}\n`, 'utf8');
    const written = fs.writeSync(fd, bytes);
    if (written !== bytes.length) throw new Error(`the ledger ${file} took ${written} of ${bytes.length} bytes`);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}

/**
 * What the runs of `month` hold: a settled run its settlement, any other run the larger of its reservation and the sum of its tasks (a run that never
 * settled may have spent all it reserved). `beforeLine` keeps only the runs whose first line comes before it; `excludeRun` leaves one run out.
 */
export function monthCommitted(records, month, { beforeLine = Infinity, excludeRun = null } = {}) {
  const runs = new Map();
  for (const record of records) {
    let run = runs.get(record.run);
    if (!run) { run = { firstLine: record.line, month: record.month, reserve: 0, tasks: 0, settle: null }; runs.set(record.run, run); }
    if (record.type === 'reserve') run.reserve = Math.max(run.reserve, record.usd);
    else if (record.type === 'task') run.tasks += record.usd;
    else run.settle = record.usd;
  }
  let total = 0;
  for (const [id, run] of runs) {
    if (run.month !== month || run.firstLine >= beforeLine || id === excludeRun) continue;
    total += run.settle !== null ? run.settle : Math.max(run.reserve, run.tasks);
  }
  return money(total);
}

/**
 * Opens a run: the pre-flight against the ledger, the reservation, and the check that no run which reserved first took the room meanwhile (a run that
 * lost that race writes a release, a settlement of 0, and is refused). Refused before its reservation, a run leaves no line.
 */
export function openRun(file, { runId, now = new Date(), provider, model, tasks, ceilingUsd, budgetUsd, monthlyCapUsd, afterRead = null }) {
  const month = monthOf(now);
  const first = readLedger(file);
  const calibration = calibrate(first.records, { provider, model, taskIds: tasks.map((task) => task.id) });
  const plan = planRun({ tasks, ceilingUsd, budgetUsd, monthlyCapUsd, committedUsd: monthCommitted(first.records, month), calibration });
  // For the tests: another run that reserves between this run's read and its reservation (the race the second read is there for).
  afterRead?.();
  const reservedUsd = money(plan.effectiveCapUsd + ceilingUsd);
  const at = now.toISOString();
  appendLedger(file, { v: LEDGER_VERSION, type: 'reserve', run: runId, at, month, usd: reservedUsd, provider, model, budgetUsd, monthlyCapUsd, ceilingUsd });
  const second = readLedger(file);
  const mine = second.records.find((record) => record.run === runId && record.type === 'reserve');
  if (!mine) throw new Error(`the reservation of run ${runId} is not in ${file} after it was written`);
  const monthSpentBeforeUsd = monthCommitted(second.records, month, { beforeLine: mine.line, excludeRun: runId });
  let final;
  try {
    final = planRun({ tasks, ceilingUsd, budgetUsd, monthlyCapUsd, committedUsd: monthSpentBeforeUsd, calibration });
  } catch (error) {
    appendLedger(file, { v: LEDGER_VERSION, type: 'settle', run: runId, at: new Date().toISOString(), month, usd: 0, released: true, reason: String(error.message).slice(0, 300) });
    throw error;
  }
  return {
    runId, month, reservedUsd, monthSpentBeforeUsd, effectiveCapUsd: Math.min(plan.effectiveCapUsd, final.effectiveCapUsd),
    estimate: { estimateUsd: final.estimateUsd, worstCaseUsd: final.worstCaseUsd, calibrated: final.calibrated, uncalibrated: final.uncalibrated },
    warnings: final.warnings, corruptLines: second.corrupt,
  };
}

/** One line per task of a run: its figure, whether that is an upper bound, and what stopped it (the calibration reads these). */
export function recordTask(file, { runId, month, now = new Date(), provider, model, task, hubTaskId = null, usd: spent, knownUsd = null, basis, chargedRequests = 0, httpRequests = null, stoppedBy = null, state = null }) {
  appendLedger(file, { v: LEDGER_VERSION, type: 'task', run: runId, at: now.toISOString(), month, provider, model, task, hubTaskId, usd: spent, knownUsd, basis, chargedRequests, httpRequests, stoppedBy: stoppedBy ?? null, state });
}

/** The settlement of a run: from then on the month counts this figure for it, not its reservation. */
export function closeRun(file, { runId, month, now = new Date(), usd: spent, basis, stoppedBy = null, note = null }) {
  appendLedger(file, { v: LEDGER_VERSION, type: 'settle', run: runId, at: now.toISOString(), month, usd: spent, basis, stoppedBy: stoppedBy ?? null, ...(note ? { note } : {}) });
}

// ---- the loop that watches one task --------------------------------------------------------------------------------------------------------------

const TIMED_OUT = Symbol('timed out');
async function within(work, ms) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(work).then((value) => ({ value }), (error) => ({ error })),
      new Promise((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}

/**
 * Watches one task of the runner's Hub until it settles, through `client` (tests/live/lib/session.mjs hubClient, or a fake):
 *   observe(id) -> { task, settled, pending, others }   the task (GET /api/tasks/:id), whether the Hub let go of it, its approval requests, the other tasks
 *   deny(requestId), cancel(id) -> { ok, status }, final(id) -> task, escalate()   (escalate stops the Hub itself)
 * Every poll: deny the approvals the Hub still asks for (nobody is there to answer), add up the spend (this task, plus other tasks of the Hub that are not
 * in `ignoreTaskIds`, such as subagents), and cancel the task when the stop rule or its step or minute limit says so. A cancel the Hub refuses, or that
 * does not answer within `cancelTimeoutMs`, is tried again at the next poll; `cancelGraceMs` after the first attempt the Hub is stopped, and the figure
 * is then the last look plus one more request at the ceiling.
 */
export async function governTask(client, {
  taskId, capUsd, spentBeforeUsd = 0, ceilingUsd, maxSteps = Infinity, maxMinutes = Infinity, ignoreTaskIds = [],
  pollMs = DEFAULT_POLL_MS, cancelTimeoutMs = CANCEL_TIMEOUT_MS, cancelGraceMs = CANCEL_GRACE_MS,
  now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), onPoll = null,
}) {
  if (!Number.isFinite(pollMs) || pollMs < 1 || pollMs > MAX_POLL_MS) throw new RangeError(`the poll interval must be from 1 to ${MAX_POLL_MS} ms, not ${pollMs}`);
  checkCapUsd(capUsd, 'the cap');
  if (!price(ceilingUsd)) throw new RangeError(`the ceiling must be 0 USD or more, not ${String(ceilingUsd)}`);
  const ignored = new Set([taskId, ...ignoreTaskIds]);
  const started = now();
  const cancel = { attempts: 0, refused: 0, timedOut: 0, accepted: false, escalated: false };
  let firstCancelAt = null;
  let budgetStop = null;
  let limit = null;
  let last = null;
  let denied = 0;
  let othersUsd = 0;
  const othersSpend = (others = []) => others
    .filter((item) => item && !ignored.has(item.id) && Number.isSafeInteger(item.usage?.httpRequests))
    .reduce((sum, item) => sum + taskSpend(item, ceilingUsd).usd, 0);
  const result = (spend, final) => ({
    stoppedBy: budgetStop ?? limit, limitReached: limit, spend, othersUsd: money(othersUsd), final, steps: final?.steps ?? null, state: final?.state ?? null, denied, cancel: { ...cancel },
  });
  for (;;) {
    const seen = await client.observe(taskId);
    for (const request of seen.pending ?? []) { await client.deny(request.id); denied += 1; }
    if (seen.task) last = seen.task;
    othersUsd = othersSpend(seen.others);
    const spend = last ? taskSpend(last, ceilingUsd) : null;
    onPoll?.({ task: last, spend, settled: Boolean(seen.settled), othersUsd });
    if (seen.settled) {
      const final = (await client.final(taskId)) ?? last;
      const finalSpend = taskSpend(final, ceilingUsd);
      // A task that settled between two polls may have taken the last of the cap: the next task must not start if one more request does not fit.
      budgetStop ??= shouldStop({ spentUsd: spentBeforeUsd + othersUsd + finalSpend.usd, ceilingUsd, capUsd });
      return result(finalSpend, final);
    }
    budgetStop ??= shouldStop({ spentUsd: spentBeforeUsd + othersUsd + (spend?.usd ?? 0), ceilingUsd, capUsd });
    if (!limit && (last?.steps ?? 0) > maxSteps) limit = 'max_steps';
    if (!limit && now() - started > maxMinutes * 60_000) limit = 'max_minutes';
    if ((budgetStop || limit) && !cancel.accepted) {
      if (firstCancelAt === null) firstCancelAt = now();
      else if (now() - firstCancelAt > cancelGraceMs) {
        client.escalate();
        cancel.escalated = true;
        const lastSpend = last ? taskSpend(last, ceilingUsd) : { usd: 0, knownUsd: 0, httpRequests: 0, pricedResponses: 0, chargedRequests: 0 };
        // Stopped by force: a request may have started after the last look.
        return result({ ...lastSpend, usd: money(lastSpend.usd + ceilingUsd), chargedRequests: lastSpend.chargedRequests + 1, basis: 'upper_bound' }, last);
      }
      cancel.attempts += 1;
      const outcome = await within(() => client.cancel(taskId), cancelTimeoutMs);
      if (outcome === TIMED_OUT) cancel.timedOut += 1;
      else if (outcome.value?.ok === true) cancel.accepted = true;
      else cancel.refused += 1;
    }
    await sleep(pollMs);
  }
}
