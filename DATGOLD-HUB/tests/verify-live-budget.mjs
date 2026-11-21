// The spend governor of the opt-in live runner (tests/live/lib/budget.mjs, P7 bc-2), driven ONLY against the scripted model server and a fake Hub client:
// no real provider, no real key, no spend.
//
// What it proves:
//   - the arithmetic: a cap must be a positive finite amount; the ceiling of one request is (context window x input rate + max output x output rate) at the
//     runner's rates plus a safety margin, and it is refused when a number is missing; a request the Hub's cost ledger did not price (in flight, failed,
//     retried, usage missing) is charged at that ceiling, so the figure is an upper bound and says so; the stop rule is "spent + one ceiling > cap";
//   - the pre-flight: the 90th percentile of earlier unstopped runs of the same task on the same provider (5 or more) plus two ceilings must fit the
//     effective cap, which is the smaller of --budget-usd and what the monthly cap leaves; a cap below two ceilings cannot run one request and is refused;
//   - the ledger (bench-results/ledger.jsonl): append-only lines written with fsync; a truncated last line or a corrupt line is skipped, reported and does
//     not swallow the next line; concurrent appends from several processes all survive; two runs reserving at the same moment against a monthly cap that
//     fits one: exactly one goes on; a run that never settled counts as its whole reservation;
//   - the governor loop (fake client): a task that finishes between two polls, a cancel the Hub refuses, a cancel that hangs (both retried, then the Hub
//     is stopped), approvals denied, other tasks of the Hub counted, the step and minute limits;
//   - against a real Hub and the mock, 20 seeded runs with random usage at exaggerated prices and a $0.05 cap: every run ends with budget_exhausted, its
//     recorded spend is at most cap + one ceiling and never below what the mock billed (the seeds are printed on failure);
//   - the runner (process): the $0.05 cap stops a run with exit 3, a provider that omits usage takes the upper-bound path and prints "upper bound", two
//     sequential invocations share one monthly cap (the third is refused), a zero / negative / NaN cap or a missing price row is refused before the model
//     hears anything, a price of 0 runs and says the runner cannot limit it, a corrupt ledger line is reported and survived;
//   - the cap lives in the runner, not the Hub: run-offline.mjs still reports 'unlimited' for no-local-token-cap, lib/request-budget.mjs still says the Hub
//     imposes no quota, and nothing under lib/ imports the governor.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gitInit } from './e2e/fixtures.mjs';
import { runScenario } from './e2e/harness.mjs';
import { call, say, withUsage } from './e2e/scenarios.mjs';
import {
  appendLedger, BudgetRefusal, CALIBRATION_MIN_SAMPLES, calibrate, checkCapUsd, closeRun, governTask, MAX_POLL_MS, monthCommitted, monthOf, openRun,
  percentile90, planRun, readLedger, recordTask, requestCeiling, SAFETY_MARGIN, shouldStop, taskSpend,
} from './live/lib/budget.mjs';
import { configureConnection, fullAccess, hubClient, startTask, upsertProfile } from './live/lib/session.mjs';
import { EXIT } from './evaluate-live.mjs';

const TESTS = path.dirname(fileURLToPath(import.meta.url));
const HUB = path.resolve(TESTS, '..');
const RUNNER = path.join(TESTS, 'evaluate-live.mjs');
const BUDGET = path.join(TESTS, 'live', 'lib', 'budget.mjs');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const KEY = `sk-budgettest-${randomBytes(18).toString('hex')}`;
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

/** A small seeded generator (mulberry32): a failing run is repeated by its seed. */
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let x = a; x = Math.imul(x ^ (x >>> 15), x | 1); x ^= x + Math.imul(x ^ (x >>> 7), x | 61); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
}
const between = (random, low, high) => low + Math.floor(random() * (high - low + 1));

/** The caller's environment without anything that would open a gate by accident (a CI runner sets CI=true). */
function baseEnvironment() {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^CHATMCP_LIVE_/i.test(name) || name === 'CI' || /(KEY|TOKEN|SECRET|PASSWORD)/i.test(name)) delete env[name];
  return env;
}

function runRunner(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [RUNNER, ...args], { cwd: HUB, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr, text: `${stdout}\n${stderr}` }); });
  });
}

/** A Node child that imports budget.mjs and runs `body` (an async function body with `budget` and `args` in scope); resolves with its JSON line. */
function budgetChild(body, args) {
  const source = `import * as budget from ${JSON.stringify(pathToFileURL(BUDGET).href)};\nconst args = JSON.parse(process.argv[1]);\nconst result = await (async () => { ${body} })();\nconsole.log(JSON.stringify(result ?? null));`;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, JSON.stringify(args)], { cwd: HUB, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('close', (code) => { let json = null; try { json = JSON.parse(stdout.trim().split('\n').pop()); } catch { /* reported below */ } resolve({ code, json, stderr }); });
  });
}

const refusedBy = (fn) => { try { fn(); return null; } catch (error) { return error; } };

/** A task as GET /api/tasks/:id shows the parts the governor reads. */
const hubTask = ({ http = 0, priced = 0, unpriced = 0, unknown = 0, known = 0, steps = 0, state = 'running' } = {}) => ({
  id: 'task-1', state, steps,
  usage: { httpRequests: http, inputTokens: 0, outputTokens: 0 },
  modelCost: { schema: 1, knownSubtotalUsd: known, pricedResponses: priced, unpricedResponses: unpriced, unknownResponses: unknown, estimatedResponses: 0 },
});

/** A Hub client whose answers are scripted: one snapshot per observe() (the last repeats), a cancel that is accepted, refused, throws or hangs. */
function fakeClient({ snapshots, final = null, cancel = 'ok', others = [] }) {
  const calls = { observe: 0, cancel: 0, cancelAt: [], cancelIds: [], deny: [], escalate: 0, final: 0 };
  return {
    calls,
    async observe() { const shot = snapshots[Math.min(calls.observe, snapshots.length - 1)]; calls.observe += 1; return { pending: [], others, ...shot }; },
    async deny(id) { calls.deny.push(id); },
    cancel(id) {
      calls.cancel += 1;
      calls.cancelAt.push(calls.observe);
      calls.cancelIds.push(id);
      if (cancel === 'ok') return Promise.resolve({ ok: true, status: 200 });
      if (cancel === 'refuse') return Promise.resolve({ ok: false, status: 500 });
      if (cancel === 'throw') return Promise.reject(new Error('ECONNRESET'));
      return new Promise(() => {}); // hangs
    },
    async final() { calls.final += 1; return final ?? snapshots[snapshots.length - 1].task; },
    escalate() { calls.escalate += 1; },
  };
}

/** A clock that only moves when the governor sleeps: a poll loop with no real waiting. */
function fakeTime(start = 1_000_000) {
  let now = start;
  return { now: () => now, sleep: async (ms) => { now += ms; } };
}

await runScenario({ name: 'live-budget', summary: 'spend governor: ceiling, upper bound, pre-flight, ledger, cancel, 20 seeded runs, runner exits', budgetMs: 280_000 }, async (t) => {
  // ---- unit: the cap ------------------------------------------------------------------------------------------------------------------------
  t.equal(checkCapUsd(0.05, 'cap'), 0.05, 'a positive amount is a cap');
  for (const bad of [0, -1, -0.01, Number.NaN, Infinity, '0.05', null, undefined]) {
    const error = refusedBy(() => checkCapUsd(bad, 'cap'));
    t.check(error instanceof BudgetRefusal, `a cap of ${String(bad)} (${typeof bad}) is refused`, error?.message);
  }

  // ---- unit: the ceiling of one request --------------------------------------------------------------------------------------------------------
  t.equal(SAFETY_MARGIN, 0.25, 'the safety margin is 25 %');
  const ceilingA = requestCeiling({ rates: { input: 1, output: 2 }, contextWindow: 1000, maxOutput: 500 });
  t.check(near(ceilingA.usd, ((1000 * 1 + 500 * 2) / 1e6) * 1.25), 'ceiling = (window x input + max output x output) / 1e6 x (1 + margin)', JSON.stringify(ceilingA));
  t.equal([ceilingA.contextWindow, ceilingA.maxOutput, ceilingA.margin], [1000, 500, 0.25], 'and it names what it was made of');
  t.check(near(requestCeiling({ rates: { input: 1, output: 2 }, contextWindow: 1000, maxOutput: 500, margin: 0 }).usd, 0.002), 'without a margin it is the bare product');
  t.equal(requestCeiling({ rates: { input: 0, output: 0 }, contextWindow: 1000, maxOutput: 500 }).usd, 0, 'a price of 0 gives a ceiling of 0');
  for (const [label, input] of [
    ['no context window', { rates: { input: 1, output: 2 }, contextWindow: null, maxOutput: 500 }],
    ['no max output', { rates: { input: 1, output: 2 }, contextWindow: 1000, maxOutput: null }],
    ['a zero context window', { rates: { input: 1, output: 2 }, contextWindow: 0, maxOutput: 500 }],
    ['no output price', { rates: { input: 1, output: null }, contextWindow: 1000, maxOutput: 500 }],
    ['no price row at all', { rates: null, contextWindow: 1000, maxOutput: 500 }],
    ['a negative price', { rates: { input: -1, output: 2 }, contextWindow: 1000, maxOutput: 500 }],
    ['a NaN price', { rates: { input: Number.NaN, output: 2 }, contextWindow: 1000, maxOutput: 500 }],
  ]) {
    const error = refusedBy(() => requestCeiling(input));
    t.check(error instanceof BudgetRefusal && /ceiling/i.test(error.message), `the ceiling with ${label} is refused, not guessed`, error?.message);
  }

  // ---- unit: what a task has spent, as the governor counts it ------------------------------------------------------------------------------
  const C = 0.01;
  const exact = taskSpend(hubTask({ http: 3, priced: 3, known: 0.012 }), C);
  t.equal([exact.usd, exact.knownUsd, exact.chargedRequests, exact.basis], [0.012, 0.012, 0, 'ledger'], 'every request priced by the Hub ledger: the ledger figure, basis "ledger"');
  const inFlight = taskSpend(hubTask({ http: 4, priced: 3, known: 0.012 }), C);
  t.equal([inFlight.chargedRequests, inFlight.basis], [1, 'upper_bound'], 'a request still in flight (counted by the Hub, not yet priced) is charged at the ceiling');
  t.check(near(inFlight.usd, 0.022), 'known + one ceiling', String(inFlight.usd));
  const noUsage = taskSpend(hubTask({ http: 2, priced: 0, unknown: 2 }), C);
  t.check(noUsage.basis === 'upper_bound' && noUsage.chargedRequests === 2 && near(noUsage.usd, 0.02), 'responses without usage: each charged at the ceiling (upper bound)', JSON.stringify(noUsage));
  const unpricedTask = taskSpend(hubTask({ http: 1, priced: 0, unpriced: 1 }), C);
  t.check(unpricedTask.chargedRequests === 1 && near(unpricedTask.usd, 0.01), 'a response the ledger could not price: charged at the ceiling');
  const retried = taskSpend(hubTask({ http: 5, priced: 2, known: 0.004 }), C);
  t.check(retried.chargedRequests === 3 && near(retried.usd, 0.034), 'retried or failed sends the Hub counted but no response priced: each charged at the ceiling', JSON.stringify(retried));
  t.check(taskSpend(hubTask({ http: 1, priced: 2, known: 0.01 }), C).chargedRequests === 0, 'more priced responses than counted requests never charges a negative number');
  t.check(refusedBy(() => taskSpend({ id: 'x', modelCost: hubTask().modelCost }, C)) instanceof Error, 'a task without its request count cannot be bounded: an error, not a zero');
  t.equal(taskSpend(hubTask({ http: 2, priced: 2, known: 0 }), 0).usd, 0, 'a price of 0: nothing spent');

  // ---- unit: the stop rule ------------------------------------------------------------------------------------------------------------------
  t.equal(shouldStop({ spentUsd: 0.04, ceilingUsd: 0.01, capUsd: 0.05 }), null, 'spent + one ceiling exactly at the cap: go on');
  t.equal(shouldStop({ spentUsd: 0.0400001, ceilingUsd: 0.01, capUsd: 0.05 }), 'budget_exhausted', 'spent + one ceiling past the cap: budget_exhausted');
  t.equal(shouldStop({ spentUsd: 0, ceilingUsd: 0, capUsd: 0.05 }), null, 'a price of 0 never trips the budget');

  // ---- unit: calibration ------------------------------------------------------------------------------------------------------------------------
  t.equal(percentile90([]), null, 'no samples: no percentile');
  t.equal(percentile90([7]), 7, 'one sample: itself');
  t.equal(percentile90([10, 1, 9, 2, 8, 3, 7, 4, 6, 5]), 9, 'nearest-rank 90th percentile of 1..10 is 9');
  t.equal(percentile90(Array.from({ length: 20 }, (_, i) => i + 1)), 18, 'of 1..20 it is 18');
  t.equal(percentile90([1, 2]), 2, 'of two samples it is the larger');
  const sample = (usd, extra = {}) => ({ v: 1, type: 'task', run: `r${Math.random()}`, at: '2026-01-02T00:00:00.000Z', month: '2026-01', provider: 'mock', model: 'mock-coder', task: 'smoke', usd, stoppedBy: null, ...extra });
  t.equal(CALIBRATION_MIN_SAMPLES, 5, 'five earlier runs make a calibration');
  const four = calibrate([0.01, 0.02, 0.03, 0.04].map((usd) => sample(usd)), { provider: 'mock', model: 'mock-coder', taskIds: ['smoke'] });
  t.equal(four.smoke, { samples: 4, p90Usd: null }, 'four samples: uncalibrated');
  const five = calibrate([0.01, 0.02, 0.03, 0.04, 0.05].map((usd) => sample(usd)), { provider: 'mock', model: 'mock-coder', taskIds: ['smoke', 'other'] });
  t.equal(five.smoke, { samples: 5, p90Usd: 0.05 }, 'five samples: their 90th percentile');
  t.equal(five.other, { samples: 0, p90Usd: null }, 'a task never run: uncalibrated');
  const mixed = calibrate([...[0.01, 0.01, 0.01, 0.01, 0.01].map((usd) => sample(usd)), sample(9, { stoppedBy: 'budget_exhausted' }), sample(9, { provider: 'other' }), sample(9, { model: 'other' })],
    { provider: 'mock', model: 'mock-coder', taskIds: ['smoke'] });
  t.equal(mixed.smoke, { samples: 5, p90Usd: 0.01 }, 'a stopped run, another provider and another model do not calibrate');

  // ---- unit: the plan of a run (pre-flight) -----------------------------------------------------------------------------------------------------
  const tasks = [{ id: 'a' }, { id: 'b' }];
  const plan = planRun({ tasks, ceilingUsd: 0.01, budgetUsd: 0.05, monthlyCapUsd: 1, committedUsd: 0, calibration: { a: { samples: 5, p90Usd: 0.01 }, b: { samples: 1, p90Usd: null } } });
  t.check(near(plan.effectiveCapUsd, 0.05) && near(plan.estimateUsd, 0.01) && near(plan.worstCaseUsd, 0.03), 'cap 0.05, one calibrated task at 0.01: estimate 0.01, worst case 0.01 + two ceilings', JSON.stringify(plan));
  t.equal(plan.uncalibrated, ['b'], 'the uncalibrated task is named');
  const tight = planRun({ tasks, ceilingUsd: 0.01, budgetUsd: 0.5, monthlyCapUsd: 1, committedUsd: 0.92, calibration: {} });
  t.check(near(tight.effectiveCapUsd, 0.07), 'the monthly cap leaves 0.08, minus one ceiling of overshoot: the effective cap is 0.07, below --budget-usd', JSON.stringify(tight));
  const tooSmall = refusedBy(() => planRun({ tasks, ceilingUsd: 0.01, budgetUsd: 0.0199, monthlyCapUsd: 1, committedUsd: 0, calibration: {} }));
  t.check(tooSmall instanceof BudgetRefusal && /one request/i.test(tooSmall.message), 'a cap below two ceilings cannot run one request: refused', tooSmall?.message);
  t.check(planRun({ tasks, ceilingUsd: 0.01, budgetUsd: 0.02, monthlyCapUsd: 1, committedUsd: 0, calibration: {} }).effectiveCapUsd === 0.02, 'exactly two ceilings is enough');
  const overEstimate = refusedBy(() => planRun({ tasks, ceilingUsd: 0.01, budgetUsd: 0.05, monthlyCapUsd: 1, committedUsd: 0, calibration: { a: { samples: 5, p90Usd: 0.02 }, b: { samples: 6, p90Usd: 0.0101 } } }));
  t.check(overEstimate instanceof BudgetRefusal && /p90|calibrat/i.test(overEstimate.message), 'calibrated estimate + two ceilings above the cap: refused, with the numbers', overEstimate?.message);
  const monthFull = refusedBy(() => planRun({ tasks, ceilingUsd: 0.01, budgetUsd: 0.05, monthlyCapUsd: 1, committedUsd: 0.975, calibration: {} }));
  t.check(monthFull instanceof BudgetRefusal && /month/i.test(monthFull.message), 'a month with less than three ceilings left: refused, naming the monthly cap', monthFull?.message);
  t.check(planRun({ tasks, ceilingUsd: 0, budgetUsd: 0.05, monthlyCapUsd: 1, committedUsd: 0, calibration: {} }).warnings.some((w) => /price is 0/i.test(w)), 'a price of 0 runs, with a warning that the runner cannot limit it');

  // ---- unit: the ledger ------------------------------------------------------------------------------------------------------------------------
  const ledgerDir = t.dir('ledgers');
  const ledgerFile = (name) => path.join(ledgerDir, `${name}-${randomBytes(3).toString('hex')}.jsonl`);
  t.equal(readLedger(path.join(ledgerDir, 'missing.jsonl')), { records: [], corrupt: [] }, 'a ledger that does not exist yet is empty');
  t.equal(monthOf(new Date('2026-11-21T23:59:59.999Z')), '2026-11', 'the month is the UTC month');
  const L1 = ledgerFile('basic');
  appendLedger(L1, { v: 1, type: 'reserve', run: 'r1', at: '2026-11-01T00:00:00.000Z', month: '2026-11', usd: 0.06 });
  appendLedger(L1, { v: 1, type: 'task', run: 'r1', at: '2026-11-01T00:00:01.000Z', month: '2026-11', provider: 'mock', model: 'mock-coder', task: 'a', usd: 0.02, stoppedBy: null });
  t.equal(readLedger(L1).records.map((record) => [record.line, record.type]), [[1, 'reserve'], [2, 'task']], 'records come back in file order with their line numbers');
  t.check(fs.readFileSync(L1, 'utf8').endsWith('\n'), 'every record ends its line');
  t.check(near(monthCommitted(readLedger(L1).records, '2026-11'), 0.06), 'an unsettled run counts as its reservation (it may have spent all of it)');
  appendLedger(L1, { v: 1, type: 'task', run: 'r1', at: '2026-11-01T00:00:02.000Z', month: '2026-11', provider: 'mock', model: 'mock-coder', task: 'b', usd: 0.05, stoppedBy: null });
  t.check(near(monthCommitted(readLedger(L1).records, '2026-11'), 0.07), 'or as the sum of its tasks when that is more');
  appendLedger(L1, { v: 1, type: 'settle', run: 'r1', at: '2026-11-01T00:00:03.000Z', month: '2026-11', usd: 0.07 });
  appendLedger(L1, { v: 1, type: 'reserve', run: 'r0', at: '2026-10-31T00:00:00.000Z', month: '2026-10', usd: 5 });
  t.check(near(monthCommitted(readLedger(L1).records, '2026-11'), 0.07), 'a settled run counts as what it settled; another month does not count');
  // A writer killed in the middle of a line: the next append must not glue its record to the broken one.
  fs.appendFileSync(L1, '{"v":1,"type":"task","run":"r9","usd":0.0');
  t.equal(readLedger(L1).corrupt, [6], 'a truncated last line is skipped and reported');
  appendLedger(L1, { v: 1, type: 'reserve', run: 'r2', at: '2026-11-02T00:00:00.000Z', month: '2026-11', usd: 0.01 });
  const healed = readLedger(L1);
  t.check(healed.records.some((record) => record.run === 'r2' && record.type === 'reserve') && healed.corrupt.length === 1, 'the record after it still parses (the broken line is closed first)', JSON.stringify(healed.corrupt));
  const L2 = ledgerFile('corrupt');
  fs.writeFileSync(L2, `${JSON.stringify({ v: 1, type: 'settle', run: 'a', at: '2026-11-01T00:00:00.000Z', month: '2026-11', usd: 0.01 })}\nnot json at all\n{"v":2,"type":"settle","run":"b","month":"2026-11","usd":1}\n{"v":1,"type":"settle","run":"c","at":"2026-11-01T00:00:00.000Z","month":"2026-11","usd":-5}\n\n${JSON.stringify({ v: 1, type: 'settle', run: 'd', at: '2026-11-01T00:00:00.000Z', month: '2026-11', usd: 0.02 })}\n`);
  const corruptRead = readLedger(L2);
  t.equal(corruptRead.corrupt, [2, 3, 4], 'a line that is not JSON, an unknown version and a negative amount are corrupt (an empty line is not)');
  t.check(near(monthCommitted(corruptRead.records, '2026-11'), 0.03), 'the good lines around them still count');

  // ---- concurrent appends: six processes, forty records each, all at once -----------------------------------------------------------------
  const L3 = ledgerFile('concurrent');
  const startAt = Date.now() + 1500;
  const writers = await Promise.all(Array.from({ length: 6 }, (_, writer) => budgetChild(
    `while (Date.now() < args.startAt) {} for (let i = 0; i < 40; i++) budget.appendLedger(args.file, { v: 1, type: 'task', run: 'w' + args.writer, at: new Date().toISOString(), month: '2026-11', provider: 'mock', model: 'm', task: 't' + i, usd: 0.001, stoppedBy: null, pad: 'x'.repeat(300) }); return { ok: true };`,
    { file: L3, writer, startAt },
  )));
  t.check(writers.every((writer) => writer.code === 0 && writer.json?.ok), 'six writers ran', writers.map((writer) => writer.stderr).join(' ').slice(0, 300));
  const concurrentRead = readLedger(L3);
  t.equal([concurrentRead.records.length, concurrentRead.corrupt.length], [240, 0], '240 concurrent appends: 240 whole records, none torn');

  // ---- concurrent reservations against a monthly cap that fits one run ----------------------------------------------------------------------
  for (let round = 0; round < 3; round++) {
    const L4 = ledgerFile(`race-${round}`);
    const raceAt = Date.now() + 1500;
    const racers = await Promise.all(['A', 'B'].map((name) => budgetChild(
      `while (Date.now() < args.raceAt) {} try { const run = budget.openRun(args.file, { runId: args.name, now: new Date('2026-11-15T00:00:00.000Z'), provider: 'mock', model: 'mock-coder', tasks: [{ id: 'a' }], ceilingUsd: 0.01, budgetUsd: 0.05, monthlyCapUsd: 0.08 }); return { ok: true, cap: run.effectiveCapUsd }; } catch (error) { return { ok: false, refusal: error instanceof budget.BudgetRefusal, message: error.message }; }`,
      { file: L4, name, raceAt },
    )));
    const went = racers.filter((racer) => racer.json?.ok).length;
    const refusedProperly = racers.filter((racer) => racer.json && !racer.json.ok && racer.json.refusal).length;
    t.check(went === 1 && refusedProperly === 1, `race ${round + 1}: two runs reserve at once against a monthly cap that fits one: exactly one goes on`, JSON.stringify(racers.map((racer) => racer.json ?? racer.stderr.slice(0, 200))));
    t.check(monthCommitted(readLedger(L4).records, '2026-11') <= 0.08 + 1e-9, `race ${round + 1}: the refused run released its reservation (the month holds only the winner)`, String(monthCommitted(readLedger(L4).records, '2026-11')));
  }

  // The same race, made certain: run B reserves after A has read the ledger and before A reserves. A's second read finds B first in the file.
  {
    const L6 = ledgerFile('race-certain');
    const lostRace = refusedBy(() => openRun(L6, {
      runId: 'A', now: new Date('2026-11-15T00:00:00.000Z'), provider: 'mock', model: 'mock-coder', tasks: [{ id: 'a' }], ceilingUsd: 0.01, budgetUsd: 0.05, monthlyCapUsd: 0.08,
      afterRead: () => appendLedger(L6, { v: 1, type: 'reserve', run: 'B', at: '2026-11-15T00:00:00.000Z', month: '2026-11', usd: 0.06 }),
    }));
    t.check(lostRace instanceof BudgetRefusal && /month/i.test(lostRace.message), 'a run that another reserved ahead of between its read and its reservation is refused', lostRace?.message);
    const raced = readLedger(L6).records;
    t.equal(raced.filter((record) => record.run === 'A').map((record) => [record.type, record.usd]), [['reserve', 0.06], ['settle', 0]], 'its reservation is released at once (a settlement of 0)');
    t.check(near(monthCommitted(raced, '2026-11'), 0.06), 'and the month holds only the run that reserved first');
    t.check(near(monthCommitted(raced, '2026-11', { beforeLine: 2 }), 0.06) && monthCommitted(raced, '2026-11', { beforeLine: 1 }) === 0, 'a run counts only the runs whose first line comes before its own');
  }

  // ---- openRun / recordTask / closeRun: calibration and a crashed run ------------------------------------------------------------------------
  const L5 = ledgerFile('lifecycle');
  const now = new Date('2026-11-15T00:00:00.000Z');
  const runA = openRun(L5, { runId: 'A', now, provider: 'mock', model: 'mock-coder', tasks: [{ id: 'a' }], ceilingUsd: 0.01, budgetUsd: 0.05, monthlyCapUsd: 0.175 });
  t.check(near(runA.effectiveCapUsd, 0.05) && runA.monthSpentBeforeUsd === 0 && runA.month === '2026-11', 'the first run of the month has its whole budget', JSON.stringify(runA));
  recordTask(L5, { runId: 'A', month: runA.month, now, provider: 'mock', model: 'mock-coder', task: 'a', usd: 0.03, knownUsd: 0.02, basis: 'upper_bound', chargedRequests: 1, stoppedBy: null, state: 'completed' });
  closeRun(L5, { runId: 'A', month: runA.month, now, usd: 0.03, basis: 'upper_bound', stoppedBy: null });
  // A run that dies after its reservation (no settle line): it holds its whole reservation, 0.06.
  openRun(L5, { runId: 'B', now, provider: 'mock', model: 'mock-coder', tasks: [{ id: 'a' }], ceilingUsd: 0.01, budgetUsd: 0.05, monthlyCapUsd: 0.175 });
  const runC = openRun(L5, { runId: 'C', now, provider: 'mock', model: 'mock-coder', tasks: [{ id: 'a' }], ceilingUsd: 0.01, budgetUsd: 0.05, monthlyCapUsd: 0.175 });
  t.check(near(runC.monthSpentBeforeUsd, 0.09) && near(runC.effectiveCapUsd, 0.05), 'the next run sees 0.03 settled + 0.06 held by the run that never settled', JSON.stringify(runC));
  const runD = refusedBy(() => openRun(L5, { runId: 'D', now, provider: 'mock', model: 'mock-coder', tasks: [{ id: 'a' }], ceilingUsd: 0.01, budgetUsd: 0.05, monthlyCapUsd: 0.175 }));
  t.check(runD instanceof BudgetRefusal && /month/i.test(runD.message), 'a fourth run finds the month full and is refused', runD?.message);
  const lines = readLedger(L5).records;
  t.equal(lines.filter((record) => record.run === 'D').length, 0, 'a run refused before its reservation leaves no line');
  t.equal(lines.find((record) => record.run === 'A' && record.type === 'task')?.basis, 'upper_bound', 'a task line says whether its figure is an upper bound');

  // ---- governTask with a fake client ----------------------------------------------------------------------------------------------------------
  const options = { taskId: 'task-1', capUsd: 0.05, spentBeforeUsd: 0, ceilingUsd: 0.01, maxSteps: 50, maxMinutes: 10, pollMs: 500 };
  {
    const clock = fakeTime();
    const client = fakeClient({ snapshots: [{ settled: true, task: hubTask({ http: 1, priced: 1, known: 0.01, state: 'completed', steps: 1 }) }] });
    const result = await governTask(client, { ...options, ...clock });
    t.equal([result.stoppedBy, client.calls.cancel, result.spend.usd, result.spend.basis], [null, 0, 0.01, 'ledger'], 'a task that finished before the first poll: no cancel, its final ledger figure');
    t.equal(client.calls.final, 1, 'the final figure is read once the task has settled');
  }
  {
    const clock = fakeTime();
    const client = fakeClient({ snapshots: [{ settled: false, task: hubTask({ http: 1, priced: 0 }) }, { settled: true, task: hubTask({ http: 2, priced: 2, known: 0.045, state: 'completed', steps: 2 }) }] });
    const result = await governTask(client, { ...options, ...clock });
    t.equal([result.stoppedBy, client.calls.cancel], ['budget_exhausted', 0], 'a task whose last response passed the cap between two polls: the run stops (the next task would not fit one request), no cancel needed');
  }
  {
    const clock = fakeTime();
    const client = fakeClient({
      snapshots: [
        { settled: false, task: hubTask({ http: 1, priced: 0 }) },
        { settled: false, task: hubTask({ http: 2, priced: 1, known: 0.02 }) },
        { settled: false, task: hubTask({ http: 3, priced: 2, known: 0.0301 }) },
        { settled: true, task: hubTask({ http: 3, priced: 2, known: 0.0301, state: 'cancelled', steps: 3 }) },
      ],
    });
    const result = await governTask(client, { ...options, ...clock });
    t.equal([result.stoppedBy, client.calls.cancel, result.cancel.accepted], ['budget_exhausted', 1, true], 'spent + in flight + one ceiling past the cap: one cancel, accepted');
    t.check(near(result.spend.usd, 0.0401) && result.spend.basis === 'upper_bound', 'the cancelled request is charged at the ceiling', JSON.stringify(result.spend));
    t.check(result.spend.usd <= options.capUsd + options.ceilingUsd, 'and the run ends within cap + one ceiling');
  }
  {
    const clock = fakeTime();
    const running = { settled: false, task: hubTask({ http: 3, priced: 2, known: 0.04 }) };
    const client = fakeClient({ snapshots: [running], cancel: 'refuse' });
    const result = await governTask(client, { ...options, ...clock, cancelGraceMs: 5000 });
    t.check(result.cancel.refused >= 2 && result.cancel.refused === client.calls.cancel, 'a cancel the Hub refuses is tried again at the next poll', JSON.stringify(result.cancel));
    t.equal([client.calls.escalate, result.cancel.escalated], [1, true], 'and once the grace period is over, the Hub is stopped');
    t.check(near(result.spend.usd, 0.04 + 0.01 + 0.01), 'the figure after a stop by force: the last look plus one more request at the ceiling', String(result.spend.usd));
  }
  {
    const client = fakeClient({ snapshots: [{ settled: false, task: hubTask({ http: 3, priced: 2, known: 0.04 }) }], cancel: 'hang' });
    const result = await Promise.race([governTask(client, { ...options, pollMs: 20, cancelTimeoutMs: 60, cancelGraceMs: 400 }), sleep(5000).then(() => null)]);
    t.check(result !== null, 'a cancel that never answers does not hold the governor (it returned within 5 s)');
    t.check(result?.cancel.timedOut >= 2 && result?.cancel.escalated === true && client.calls.escalate === 1, 'it times out, is retried, then the Hub is stopped', JSON.stringify(result?.cancel));
  }
  {
    const clock = fakeTime();
    const client = fakeClient({ snapshots: [{ settled: false, task: hubTask({ http: 1, priced: 0 }) }, { settled: true, task: hubTask({ http: 1, priced: 1, known: 0.001, state: 'cancelled' }) }] });
    const result = await governTask(client, { ...options, ...clock, spentBeforeUsd: 0.035 });
    t.equal([result.stoppedBy, client.calls.cancelAt], ['budget_exhausted', [1]], 'what the earlier tasks of the run spent counts: 0.035 before + one request in flight + one ceiling passes 0.05 at the first poll');
  }
  {
    const clock = fakeTime();
    const client = fakeClient({ snapshots: [{ settled: false, task: hubTask({ http: 3, priced: 2, known: 0.04 }) }, { settled: true, task: hubTask({ http: 3, priced: 2, known: 0.04, state: 'cancelled' }) }], cancel: 'throw' });
    const result = await governTask(client, { ...options, ...clock });
    t.check(result.cancel.refused === 1 && client.calls.escalate === 0, 'a cancel that fails on the network counts as refused; the task then settled, so nothing is stopped by force', JSON.stringify(result.cancel));
  }
  {
    const clock = fakeTime();
    const client = fakeClient({ snapshots: [{ settled: false, pending: [{ id: 'ask-1' }, { id: 'ask-2' }], task: hubTask({ http: 1 }) }, { settled: true, task: hubTask({ http: 1, priced: 1, known: 0.001, state: 'completed' }) }] });
    const result = await governTask(client, { ...options, ...clock });
    t.equal([client.calls.deny, result.denied], [['ask-1', 'ask-2'], 2], 'every approval the Hub still asks for is denied');
  }
  {
    const clock = fakeTime();
    const client = fakeClient({ snapshots: [{ settled: false, task: hubTask({ http: 1, priced: 0 }) }, { settled: true, task: hubTask({ http: 1, priced: 1, known: 0.001, state: 'cancelled' }) }], others: [{ ...hubTask({ http: 2, priced: 2, known: 0.035, state: 'completed' }), id: 'subagent-1', settled: true }] });
    const result = await governTask(client, { ...options, ...clock });
    t.equal(result.stoppedBy, 'budget_exhausted', 'spend of another task of the same Hub (a subagent) counts toward the cap');
  }
  // The spend of the other tasks is part of the run's figure, each Hub task counted once (audit of #144, F1), and the governor waits for them (Q2).
  const subagent = (extra, settled) => ({ ...hubTask(extra), id: 'child-1', settled });
  {
    const clock = fakeTime();
    const client = fakeClient({ snapshots: [
      { settled: false, task: hubTask({ http: 1, priced: 0 }), others: [subagent({ http: 1, priced: 0 }, false)] },
      { settled: true, task: hubTask({ http: 2, priced: 2, known: 0.004, state: 'completed', steps: 2 }), others: [subagent({ http: 2, priced: 1, known: 0.003 }, false)] },
      { settled: true, task: hubTask({ http: 2, priced: 2, known: 0.004, state: 'completed', steps: 2 }), others: [subagent({ http: 2, priced: 2, known: 0.006, state: 'completed' }, true)] },
    ] });
    const result = await governTask(client, { ...options, ...clock, capUsd: 1 });
    t.equal(client.calls.observe, 3, 'a task that settled before the subagent it started: the governor waits until the subagent has settled too');
    t.check(near(result.totalUsd, 0.01) && near(result.spends.get('child-1')?.usd, 0.006) && near(result.spends.get('task-1')?.usd, 0.004), 'the figure of the run is the task plus its subagent, each at its last value', JSON.stringify([result.totalUsd, [...(result.spends ?? new Map())]]));
    t.check(near(result.othersUsd, 0.006), 'and the subagent\'s part is reported apart', String(result.othersUsd));
  }
  {
    const clock = fakeTime();
    const earlierSpend = taskSpend({ ...hubTask({ http: 1, priced: 1, known: 0.01, state: 'completed' }), id: 'earlier-1' }, 0.01);
    const client = fakeClient({ snapshots: [{ settled: true, task: hubTask({ http: 1, priced: 1, known: 0.002, state: 'completed' }), others: [{ ...hubTask({ http: 1, priced: 1, known: 0.01, state: 'completed' }), id: 'earlier-1', settled: true }] }] });
    const result = await governTask(client, { ...options, ...clock, spentByTask: new Map([['earlier-1', earlierSpend]]) });
    t.check(near(result.totalUsd, 0.012) && result.spends.size === 2, 'an earlier task of the run, listed again by the Hub, is counted once', JSON.stringify([result.totalUsd, result.spends?.size]));
    t.equal(result.othersUsd, 0, 'and it is not reported as a subagent of this task');
  }
  {
    const clock = fakeTime();
    const client = fakeClient({ snapshots: [
      { settled: false, task: hubTask({ http: 1, priced: 0 }), others: [subagent({ http: 3, priced: 2, known: 0.021 }, false)] },
      { settled: true, task: hubTask({ http: 1, priced: 0, state: 'cancelled' }), others: [subagent({ http: 3, priced: 2, known: 0.021, state: 'cancelled' }, true)] },
    ] });
    const result = await governTask(client, { ...options, ...clock });
    t.equal([result.stoppedBy, [...client.calls.cancelIds].sort()], ['budget_exhausted', ['child-1', 'task-1']], 'a budget stop cancels the subagent as well as the task');
  }
  {
    const clock = fakeTime();
    const client = fakeClient({ snapshots: [
      { settled: false, task: hubTask({ http: 3, priced: 3, known: 0.001, steps: 3 }) },
      { settled: false, task: hubTask({ http: 4, priced: 4, known: 0.001, steps: 4 }) },
      { settled: true, task: hubTask({ http: 4, priced: 4, known: 0.001, steps: 4, state: 'cancelled' }) },
    ] });
    const result = await governTask(client, { ...options, ...clock, maxSteps: 3 });
    t.equal([result.stoppedBy, result.limitReached, client.calls.cancelAt], ['max_steps', 'max_steps', [2]], 'at its step limit the task goes on; one step past it, it is cancelled (max_steps)');
  }
  {
    const clock = fakeTime();
    const running = { settled: false, task: hubTask({ http: 1, priced: 1, known: 0.001, steps: 1 }) };
    const client = fakeClient({ snapshots: [running, running, running, running, running, { settled: true, task: hubTask({ http: 1, priced: 1, known: 0.001, state: 'cancelled' }) }] });
    const result = await governTask(client, { ...options, ...clock, pollMs: 500, maxMinutes: 1 / 60 });
    t.equal([result.stoppedBy, client.calls.cancelAt], ['max_minutes', [4]], 'at its minute limit (1 s, the third poll) the task goes on; past it (the fourth) it is cancelled (max_minutes)');
  }
  for (const bad of [0, -1, MAX_POLL_MS + 1, Number.NaN]) {
    const error = await governTask(fakeClient({ snapshots: [{ settled: true, task: hubTask() }] }), { ...options, pollMs: bad }).then(() => null, (failure) => failure);
    t.check(error instanceof Error, `a poll interval of ${bad} ms is refused (the plan: at least every ${MAX_POLL_MS} ms)`);
  }

  // ---- against a real Hub: 20 seeded runs, random usage at exaggerated prices, a $0.05 cap -----------------------------------------------------
  // The mock answers request k only after a poll of the governor has seen the k responses before it: at most one response between two polls, which is
  // the assumption under which the governor promises "cap + one ceiling" (docs/EVALUATION.md). The random part is the usage of every response.
  const RATES = { input: 0.05, output: 1 };
  const WINDOW = 128000;
  const MAX_OUTPUT = 2048;
  const ceiling = requestCeiling({ rates: RATES, contextWindow: WINDOW, maxOutput: MAX_OUTPUT }).usd;
  const CAP = 0.05;
  const gate = { seen: 0, open: false, waiters: [] };
  const passGate = () => { gate.waiters = gate.waiters.filter((waiter) => { if (gate.open || gate.seen >= waiter.turn) { waiter.resolve(); return false; } return true; }); };
  const untilSeen = (turn) => new Promise((resolve) => { gate.waiters.push({ turn, resolve }); passGate(); });
  let random = rng(1);
  let billed = [];
  const mock = await t.mock({
    scenario: 'budget-random',
    scenarios: {
      'budget-random': async ({ turn }) => {
        const usage = { input: between(random, 500, WINDOW), output: between(random, 1, MAX_OUTPUT) };
        billed.push((usage.input * RATES.input + usage.output * RATES.output) / 1e6);
        await untilSeen(turn);
        return withUsage(usage, call('write_file', { path: `notes-${turn}.txt`, content: `step ${turn}` }));
      },
      'budget-spender': async ({ turn }) => { await sleep(500); return withUsage({ input: 60000, output: 1500 }, call('write_file', { path: `spend-${turn}.txt`, content: `step ${turn}` })); },
      // NaN is written as null in JSON: the response carries "prompt_tokens": null and no completion count, what a gateway without usage sends.
      'budget-no-usage': ({ turn }) => (turn === 0 ? withUsage({ input: Number.NaN, output: Number.NaN }, call('write_file', { path: 'a.txt', content: 'a' })) : withUsage({ input: Number.NaN, output: Number.NaN }, say('Done.'))),
      'budget-smoke': ({ turn }) => (turn === 0 ? call('write_file', { path: 'hello.txt', content: 'hello\n' }) : say('Done.')),
      // A task that starts a background subagent (spawn_agent) and finishes before it: the subagent's model calls are the Hub's too, and the run pays them.
      'budget-spawn': ({ users, turn, tools }) => {
        const who = /(Parent|Child) S1:/.exec((users ?? []).filter((text) => !String(text).startsWith('UNTRUSTED SKILL')).join('\n'))?.[0] ?? 'unknown';
        if (who.startsWith('Child')) {
          const usage = { input: 40000, output: 1000 };
          spawnBill.child += (usage.input * RATES.input + usage.output * RATES.output) / 1e6;
          return withUsage(usage, turn === 0 ? call('write_file', { path: 'child-note.txt', content: 'from the child\n' }) : say('Child S1 done.'));
        }
        const usage = { input: 2000, output: 100 };
        spawnBill.parent += (usage.input * RATES.input + usage.output * RATES.output) / 1e6;
        if (turn === 0) spawnBill.parentTools = tools ?? [];
        return withUsage(usage, turn === 0 ? call('spawn_agent', { goal: 'Child S1: write a short note in a file.' }) : say('Parent S1 started its helper.'));
      },
    },
  });
  const spawnBill = { parent: 0, child: 0, parentTools: [] };
  const project = t.dir('seeded-project');
  fs.writeFileSync(path.join(project, 'README.md'), '# scratch\n');
  const hub = await t.hub({ project });
  const entry = { preset: 'ollama', protocol: 'openai-chat', apiBaseUrl: mock.url, model: 'mock-coder', contextWindow: WINDOW, keyEnv: null, local: true };
  const connected = await configureConnection(hub, entry, null);
  t.must(connected?.toolCalling === 'supported', 'the mock passes the Hub\'s tool-calling check', JSON.stringify(connected));
  await upsertProfile(hub, 'budget-seeded', entry, RATES);
  await fullAccess(hub);
  const client = hubClient(hub);
  const failedSeeds = [];
  const earlier = [];
  const requestCounts = [];
  for (let run = 0; run < 20; run++) {
    const seed = 20261121 + run;
    random = rng(seed);
    billed = [];
    gate.seen = 0; gate.open = false;
    const created = await startTask(hub, `Write notes until told to stop (seed ${seed}).`);
    let result;
    try {
      result = await governTask(client, {
        taskId: created.id, ignoreTaskIds: earlier, capUsd: CAP, spentBeforeUsd: 0, ceilingUsd: ceiling, maxSteps: 50, maxMinutes: 2, pollMs: 50,
        onPoll: ({ task }) => { const cost = task?.modelCost ?? {}; gate.seen = (cost.pricedResponses ?? 0) + (cost.unpricedResponses ?? 0) + (cost.unknownResponses ?? 0); passGate(); },
      });
    } finally { gate.open = true; passGate(); earlier.push(created.id); }
    const bill = billed.reduce((sum, usd) => sum + usd, 0);
    requestCounts.push(billed.length);
    const problems = [];
    if (result.stoppedBy !== 'budget_exhausted') problems.push(`stoppedBy ${result.stoppedBy}`);
    if (!(result.spend.usd <= CAP + ceiling + 1e-9)) problems.push(`spend ${result.spend.usd} > cap + ceiling ${CAP + ceiling}`);
    if (!(result.spend.usd + 1e-9 >= bill)) problems.push(`spend ${result.spend.usd} < mock bill ${bill}`);
    if (problems.length) failedSeeds.push(`seed ${seed}: ${problems.join('; ')} (requests ${billed.length}, known ${result.spend.knownUsd}, charged ${result.spend.chargedRequests})`);
  }
  t.check(failedSeeds.length === 0, '20 seeded runs at a $0.05 cap: every one ends with budget_exhausted, within cap + one ceiling, never below the mock\'s bill', failedSeeds.join(' | '));
  // Two responses cost at most 2 x 0.008448 USD, so the third request always fits (0.0169 + two ceilings <= 0.05): every run reaches the mock 3 times or more.
  t.check(Math.min(...requestCounts) >= 3, 'every run sent at least the three requests the cap leaves room for (no run was stopped early by another run\'s spend)', JSON.stringify(requestCounts));
  t.note(`seeded runs: ceiling ${ceiling.toFixed(6)} USD, requests per run ${JSON.stringify(requestCounts)}`);

  // ---- the runner, as a process ----------------------------------------------------------------------------------------------------------------
  const work = t.dir('runner');
  const providersFile = (rates, extra = {}) => {
    const file = path.join(work, `providers-${randomBytes(4).toString('hex')}.json`);
    fs.writeFileSync(file, JSON.stringify({
      schema: 1, source: { note: 'test catalogue: the scripted model server' },
      providers: { mock: { preset: 'custom-openai', protocol: 'openai-chat', apiBaseUrl: mock.url, model: 'mock-coder', contextWindow: WINDOW, maxOutput: MAX_OUTPUT, keyEnv: 'DEEPSEEK_API_KEY', ratesUsdPerMillion: rates, tiers: [], catalog: null, note: 'the scripted model server of the tests', ...extra } },
    }));
    return file;
  };
  const tasksFile = (tasksList) => { const file = path.join(work, `tasks-${randomBytes(4).toString('hex')}.json`); fs.writeFileSync(file, JSON.stringify({ schema: 1, tasks: tasksList })); return file; };
  const exaggerated = providersFile({ input: 0.05, output: 1, cacheRead: null, cacheWrite: null });
  const one = tasksFile([{ id: 'smoke', prompt: 'Write a file.', files: { 'README.md': '# scratch\n' }, maxSteps: 6, maxMinutes: 2 }]);
  const gated = { ...baseEnvironment(), DEEPSEEK_API_KEY: KEY, CHATMCP_LIVE_OK: '1', CHATMCP_LIVE_SANDBOX: '1' };
  const modelRequests = () => mock.state.requests.length;
  const live = (args, ledger) => ['--providers', exaggerated, '--tasks', one, '--provider', 'mock', '--poll-ms', '50', '--ledger', ledger, ...args];
  const refusal = async (label, args, pattern) => {
    const before = modelRequests();
    const result = await runRunner(args, gated);
    t.equal(result.code, EXIT.REFUSED, `${label}: exit 2`);
    t.check(pattern.test(result.text), `${label}: the refusal says why`, result.text.slice(0, 400));
    t.equal(modelRequests() - before, 0, `${label}: the model heard nothing`);
    return result;
  };
  const ledgerR = ledgerFile('refusals');
  await refusal('--budget-usd 0', live(['--budget-usd', '0', '--monthly-cap-usd', '1'], ledgerR), /--budget-usd/);
  await refusal('--budget-usd -1', live(['--budget-usd', '-1', '--monthly-cap-usd', '1'], ledgerR), /--budget-usd/);
  await refusal('--budget-usd NaN', live(['--budget-usd', 'NaN', '--monthly-cap-usd', '1'], ledgerR), /--budget-usd/);
  await refusal('without --monthly-cap-usd', live(['--budget-usd', '0.05'], ledgerR), /--monthly-cap-usd/);
  await refusal('--monthly-cap-usd 0', live(['--budget-usd', '0.05', '--monthly-cap-usd', '0'], ledgerR), /--monthly-cap-usd/);
  await refusal('--poll-ms 5000', live(['--budget-usd', '0.05', '--monthly-cap-usd', '1', '--poll-ms', '5000'], ledgerR), /--poll-ms/);
  await refusal('a budget below two ceilings', live(['--budget-usd', String((2 * ceiling - 0.001).toFixed(6)), '--monthly-cap-usd', '1'], ledgerR), /one request/i);
  await refusal('a provider without a max output (missing price row for the ceiling)', ['--providers', providersFile({ input: 0.05, output: 1, cacheRead: null, cacheWrite: null }, { maxOutput: null }), '--tasks', one, '--provider', 'mock', '--budget-usd', '0.05', '--monthly-cap-usd', '1', '--ledger', ledgerR], /ceiling/i);
  t.equal(readLedger(ledgerR).records.length, 0, 'no refusal wrote to the ledger');
  // Calibration: five earlier unstopped runs of this task on this provider at 0.04 (last January: they calibrate, they do not use this month's cap).
  const ledgerCal = ledgerFile('calibrated');
  for (let i = 0; i < 5; i++) appendLedger(ledgerCal, { v: 1, type: 'task', run: `old-${i}`, at: '2026-01-10T00:00:00.000Z', month: '2026-01', provider: 'mock', model: 'mock-coder', task: 'smoke', usd: 0.04, knownUsd: 0.04, basis: 'ledger', stoppedBy: null, state: 'completed' });
  await refusal('a calibrated p90 that leaves no room for two ceilings', live(['--budget-usd', '0.05', '--monthly-cap-usd', '1'], ledgerCal), /p90|calibrat/i);

  // The $0.05 cap stops a run.
  mock.setScenario('budget-spender');
  const ledgerS = ledgerFile('spender');
  const reportS = path.join(work, 'report-spender.json');
  const spenderTasks = tasksFile([
    { id: 'spender', prompt: 'Keep writing.', files: { 'README.md': '# scratch\n' }, maxSteps: 40, maxMinutes: 2 },
    { id: 'never-started', prompt: 'Never run.', files: {}, maxSteps: 3, maxMinutes: 1 },
  ]);
  const spender = await runRunner(['--providers', exaggerated, '--tasks', spenderTasks, '--provider', 'mock', '--budget-usd', '0.05', '--monthly-cap-usd', '1', '--poll-ms', '50', '--ledger', ledgerS, '--scratch', path.join(work, 'run-spender'), '--output', reportS], gated);
  t.must(spender.code === EXIT.BUDGET_STOP, 'the $0.05 cap: exit 3', spender.text.slice(-1500));
  const stopped = JSON.parse(fs.readFileSync(reportS, 'utf8'));
  t.equal(stopped.stoppedBy, 'budget_exhausted', 'the report says budget_exhausted');
  t.check(stopped.spentUsd > 0 && stopped.spentUsd <= 0.05 + ceiling + 1e-9, 'the spend is within cap + one ceiling', `${stopped.spentUsd} vs ${0.05 + ceiling}`);
  t.equal(stopped.tasks.map((task) => task.id), ['spender'], 'the next task was never started');
  t.check(near(stopped.ceiling.usd, ceiling) && stopped.ceiling.contextWindow === WINDOW && stopped.ceiling.maxOutput === MAX_OUTPUT, 'the report names the ceiling and what it was made of', JSON.stringify(stopped.ceiling));
  const spenderLedger = readLedger(ledgerS).records;
  t.equal(spenderLedger.map((record) => record.type), ['reserve', 'task', 'settle'], 'the ledger has the reservation, the task and the settlement');
  t.check(near(spenderLedger[2].usd, stopped.spentUsd) && spenderLedger[1].stoppedBy === 'budget_exhausted', 'the settlement is the reported spend; the task line says what stopped it', JSON.stringify(spenderLedger));
  t.check(/connection check/i.test(spender.text), 'the output says the connection check is not counted');

  // The monthly cap is enforced inside the run too: a month that leaves 0.025 USD (after one ceiling of overshoot) stops the spender long before 0.05.
  const ledgerRoom = ledgerFile('room');
  appendLedger(ledgerRoom, { v: 1, type: 'settle', run: 'earlier', at: new Date().toISOString(), month: monthOf(new Date()), usd: Number((0.1 - 0.025 - ceiling).toFixed(8)) });
  const reportRoom = path.join(work, 'report-room.json');
  const roomRun = await runRunner(['--providers', exaggerated, '--tasks', spenderTasks, '--provider', 'mock', '--budget-usd', '0.05', '--monthly-cap-usd', '0.1', '--poll-ms', '50', '--ledger', ledgerRoom, '--output', reportRoom], gated);
  t.must(roomRun.code === EXIT.BUDGET_STOP, 'a month with 0.025 USD of room: exit 3', roomRun.text.slice(-1500));
  const room = JSON.parse(fs.readFileSync(reportRoom, 'utf8'));
  t.check(near(room.effectiveCapUsd, 0.025) && room.spentUsd <= 0.025 + ceiling + 1e-9, 'the effective cap is what the month leaves, and the run ended within it plus one ceiling', JSON.stringify([room.effectiveCapUsd, room.spentUsd]));

  // A provider that omits usage: the upper-bound path, then a second and a third invocation on the same ledger (one monthly cap).
  mock.setScenario('budget-no-usage');
  const ledgerM = ledgerFile('monthly');
  const monthly = ['--budget-usd', '0.05', '--monthly-cap-usd', '0.07'];
  const reportU1 = path.join(work, 'report-no-usage-1.json');
  const first = await runRunner([...live(monthly, ledgerM), '--output', reportU1], gated);
  t.must(first.code === EXIT.OK, 'a task without usage completes: exit 0', first.text.slice(-1500));
  const u1 = JSON.parse(fs.readFileSync(reportU1, 'utf8'));
  t.check(u1.spentBasis === 'upper_bound' && u1.chargedRequests === 2 && near(u1.spentUsd, 2 * ceiling), 'two responses without usage: charged at two ceilings, basis upper_bound', JSON.stringify([u1.spentBasis, u1.chargedRequests, u1.spentUsd]));
  t.check(/upper bound/i.test(first.stdout), 'the printed total says it is an upper bound', first.stdout.slice(-400));
  t.equal(readLedger(ledgerM).records.find((record) => record.type === 'task')?.basis, 'upper_bound', 'and so does its ledger line');
  const reportU2 = path.join(work, 'report-no-usage-2.json');
  const second = await runRunner([...live(monthly, ledgerM), '--output', reportU2], gated);
  t.must(second.code === EXIT.OK, 'the second invocation runs', second.text.slice(-1500));
  const u2 = JSON.parse(fs.readFileSync(reportU2, 'utf8'));
  t.check(near(u2.ledger.monthSpentBeforeUsd, u1.spentUsd) && near(u2.effectiveCapUsd, 0.07 - u1.spentUsd - ceiling), 'it sees the first run\'s spend in the shared ledger and gets what the monthly cap leaves', JSON.stringify([u2.ledger.monthSpentBeforeUsd, u2.effectiveCapUsd]));
  const third = await refusal('a third invocation once the month is spent', live(monthly, ledgerM), /month/i);
  t.check(/0\.07/.test(third.text), 'the refusal names the monthly cap', third.text.slice(0, 400));
  t.check(near(monthCommitted(readLedger(ledgerM).records, monthOf(new Date())), u1.spentUsd + u2.spentUsd), 'the month holds exactly the two settled runs');

  // A price of 0 runs, and says the runner cannot limit it.
  mock.setScenario('budget-smoke');
  const reportZ = path.join(work, 'report-zero.json');
  const zero = await runRunner(['--providers', providersFile({ input: 0, output: 0, cacheRead: null, cacheWrite: null }), '--tasks', one, '--provider', 'mock', '--budget-usd', '0.05', '--monthly-cap-usd', '1', '--poll-ms', '50', '--ledger', ledgerFile('zero'), '--output', reportZ], gated);
  t.must(zero.code === EXIT.OK, 'a price of 0: the task runs (exit 0)', zero.text.slice(-1500));
  const z = JSON.parse(fs.readFileSync(reportZ, 'utf8'));
  t.check(z.spentUsd === 0 && z.stoppedBy === null && z.warnings.some((warning) => /price is 0/i.test(warning)), 'nothing spent, nothing stopped, and a warning that the runner cannot limit spend', JSON.stringify([z.spentUsd, z.stoppedBy, z.warnings]));

  // A corrupt line in the middle and a truncated last line: reported, survived, and the runner's own lines still parse.
  const ledgerC = ledgerFile('damaged');
  fs.writeFileSync(ledgerC, `${JSON.stringify({ v: 1, type: 'settle', run: 'earlier', at: new Date().toISOString(), month: monthOf(new Date()), usd: 0.01 })}\n{this is not json}\n{"v":1,"type":"task","run":"cut-off","usd":0.0`);
  const reportC = path.join(work, 'report-damaged.json');
  const damaged = await runRunner([...live(['--budget-usd', '0.05', '--monthly-cap-usd', '1'], ledgerC), '--output', reportC], gated);
  t.must(damaged.code === EXIT.OK, 'a damaged ledger: the run still goes', damaged.text.slice(-1500));
  const c = JSON.parse(fs.readFileSync(reportC, 'utf8'));
  t.equal(c.ledger.corruptLines, [2, 3], 'the report names the corrupt lines');
  t.check(/ledger/i.test(damaged.stderr) && /2, 3|2,3/.test(damaged.stderr), 'and a warning names them', damaged.stderr.slice(0, 400));
  t.check(near(c.ledger.monthSpentBeforeUsd, 0.01), 'the good line before them still counts');
  const after = readLedger(ledgerC);
  t.equal([after.corrupt, after.records.filter((record) => record.run === c.ledger.runId).map((record) => record.type)], [[2, 3], ['reserve', 'task', 'settle']], 'the runner\'s own lines parse after the truncated one');

  // A task that starts a background subagent with spawn_agent (a Git project is needed for its worktree, so the scratch project is one before the
  // runner writes the task's files into it) and finishes first. The subagent is a task of the same Hub: the governor waits for it, and its spend is in
  // the report, the task line and the settlement, once (audit of #144, F1 and Q2).
  mock.setScenario('budget-spawn');
  const spawnScratch = path.join(work, 'run-spawn');
  const spawnProject = path.join(spawnScratch, 'project');
  fs.mkdirSync(spawnProject, { recursive: true });
  fs.writeFileSync(path.join(spawnProject, 'README.md'), '# scratch\n');
  gitInit(spawnProject, t.scratch);
  const ledgerSpawn = ledgerFile('spawn');
  const reportSpawn = path.join(work, 'report-spawn.json');
  const spawnTasks = tasksFile([{ id: 'parent', prompt: 'Parent S1: start one helper agent for a note, then say you started it.', files: { 'README.md': '# scratch\n' }, maxSteps: 6, maxMinutes: 2 }]);
  const spawned = await runRunner(['--providers', exaggerated, '--tasks', spawnTasks, '--provider', 'mock', '--budget-usd', '0.05', '--monthly-cap-usd', '1', '--poll-ms', '50', '--ledger', ledgerSpawn, '--scratch', spawnScratch, '--output', reportSpawn], gated);
  t.must(spawned.code === EXIT.OK, 'a task that starts a subagent: exit 0', spawned.text.slice(-1500));
  t.check(spawnBill.parentTools.includes('spawn_agent') && spawnBill.child > 0, 'the task was offered spawn_agent and its subagent called the model', JSON.stringify(spawnBill));
  const s = JSON.parse(fs.readFileSync(reportSpawn, 'utf8'));
  const bill = spawnBill.parent + spawnBill.child;
  t.check(near(s.spentUsd, bill, 1e-7), 'the run\'s figure is the task plus its subagent (what the mock billed, every response priced)', JSON.stringify([s.spentUsd, spawnBill]));
  t.check(Array.isArray(s.hubTasks) && s.hubTasks.length === 2 && s.hubTasks.some((item) => item.id !== s.tasks[0].hubTaskId && near(item.usd, spawnBill.child, 1e-7)), 'the report lists both Hub tasks, the subagent with its own figure', JSON.stringify(s.hubTasks));
  t.check(near(s.tasks[0].othersUsd, spawnBill.child, 1e-7), 'the task\'s record names the part its subagent spent', String(s.tasks[0].othersUsd));
  const spawnLines = readLedger(ledgerSpawn).records;
  const spawnTaskLine = spawnLines.find((record) => record.type === 'task');
  const spawnSettle = spawnLines.find((record) => record.type === 'settle');
  t.check(near(spawnTaskLine?.usd, s.spentUsd) && near(spawnTaskLine?.othersUsd, spawnBill.child, 1e-7) && near(spawnSettle?.usd, s.spentUsd), 'the task line and the settlement in the ledger hold the subagent\'s spend too', JSON.stringify([spawnTaskLine, spawnSettle]));

  // ---- the cap lives in the runner, not the Hub ----------------------------------------------------------------------------------------------
  const offline = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(TESTS, 'benchmarks', 'run-offline.mjs')], { cwd: HUB, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.on('close', (code) => resolve({ code, stdout }));
  });
  let offlineReport = null;
  try { offlineReport = JSON.parse(offline.stdout); } catch { /* reported below */ }
  t.equal([offline.code, offlineReport?.results?.find((row) => row.id === 'no-local-token-cap')?.actual], [0, 'unlimited'], 'run-offline.mjs still reports no-local-token-cap as unlimited');
  const requestBudget = fs.readFileSync(path.join(HUB, 'lib', 'request-budget.mjs'), 'utf8').replace(/\r\n/g, '\n');
  t.check(requestBudget.includes('No ChatMCP-imposed request, token,\n// monetary, session-duration or multi-worker quota: the user/provider controls\n// consumption.'), 'lib/request-budget.mjs still says the Hub imposes no quota');
  const importers = [];
  const walk = (dir) => { for (const item of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, item.name); if (item.isDirectory()) walk(full); else if (/\.m?js$/.test(item.name) && /live[\\/]lib[\\/]budget\.mjs|tests[\\/]live/.test(fs.readFileSync(full, 'utf8'))) importers.push(path.relative(HUB, full)); } };
  walk(path.join(HUB, 'lib'));
  t.equal(importers, [], 'nothing under lib/ imports the governor or anything under tests/live');
});
