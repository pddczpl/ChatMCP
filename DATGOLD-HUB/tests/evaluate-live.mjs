#!/usr/bin/env node
// The opt-in LIVE runner (P7 bc-1): runs tasks through a real Hub against a real model provider, which costs money. It is not part of run-all and the
// deterministic harness (tests/evaluate.mjs) still refuses --live. How to run it and its safety rules: docs/EVALUATION.md.
//
// Gates, all checked before a Hub is started or a byte is sent (each refusal exits 2):
//   CHATMCP_LIVE_OK=1                 the owner's explicit yes for this command
//   --provider <id>                    an entry of tests/live/providers.json (or of --providers <file>) with a known input and output price
//   --budget-usd <n>                   a positive amount: the cap of this run (the spend governor, tests/live/lib/budget.mjs)
//   --monthly-cap-usd <n>              a positive amount: the cap of every run of this month together, kept in the ledger (--ledger, default
//                                      bench-results/ledger.jsonl at the repository root)
//   a disposable sandbox              CI=true, /.dockerenv, or CHATMCP_LIVE_SANDBOX=1: the tasks run in Full Access, so the model's commands run on this
//                                      machine with this user's rights
//   the provider's key variable        set and non-empty (only that one variable reaches the Hub: tests/live/lib/session.mjs)
//   every task has maxSteps/maxMinutes within the runner's caps
//   the ceiling of one request         the provider's context window, maximum output and prices are all known (budget.mjs requestCeiling)
// Then, still before a Hub starts, the pre-flight against the ledger (budget.mjs openRun: two ceilings must fit the effective cap, and so must the
// calibrated estimate of the tasks) and the reservation of the run; then the Hub's own "Test API" check must report tool calling as supported, or the run
// is refused (exit 2) before any task.
//
// Exit codes: 0 every task completed; 1 a task did not complete (or the run failed); 2 refused / usage; 3 stopped by the budget (budget_exhausted).
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BudgetRefusal, closeRun, DEFAULT_LEDGER, DEFAULT_POLL_MS, governTask, MAX_POLL_MS, openRun, recordTask, requestCeiling, runTotal } from './live/lib/budget.mjs';
import { ALLOWED_KEY_ENVS, configureConnection, forwardedKey, fullAccess, hubClient, providerKeyVariables, startLiveHub, startTask, upsertProfile } from './live/lib/session.mjs';

const TESTS = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(TESTS, '..', '..');
export const DEFAULT_PROVIDERS = path.join(TESTS, 'live', 'providers.json');
export const DEFAULT_TASKS = path.join(TESTS, 'live', 'tasks', 'smoke.json');
export const EXIT = Object.freeze({ OK: 0, TASK_FAILED: 1, REFUSED: 2, BUDGET_STOP: 3 });
export const CAPS = Object.freeze({ maxSteps: 50, maxMinutes: 30 });
/** The fastest poll the command line takes (the slowest is budget.mjs MAX_POLL_MS). */
const MIN_POLL_MS = 50;

class Refusal extends Error {}
const refuse = (message) => { throw new Refusal(message); };
const usdText = (value) => `${Number(value.toFixed(8))} USD`;

const USAGE = `usage: CHATMCP_LIVE_OK=1 node tests/evaluate-live.mjs --provider <id> --budget-usd <usd> --monthly-cap-usd <usd> [--ledger <file>] [--poll-ms <ms>]
                                       [--tasks <file>] [--providers <file>] [--output <report.json>] [--scratch <dir>]
       node tests/evaluate-live.mjs --list
A disposable sandbox is required (CI=true, /.dockerenv or CHATMCP_LIVE_SANDBOX=1). Exit codes: 0 ok, 1 a task failed, 2 refused, 3 budget stop.`;

export function parseArguments(argv) {
  const o = { provider: null, budgetUsd: null, monthlyCapUsd: null, ledger: DEFAULT_LEDGER, pollMs: DEFAULT_POLL_MS, tasks: DEFAULT_TASKS, providers: DEFAULT_PROVIDERS, output: null, scratch: null, list: false };
  const value = (flag, i) => { const next = argv[i + 1]; if (next === undefined || next.startsWith('--')) refuse(`${flag} needs a value\n${USAGE}`); return next; };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--list') o.list = true;
    else if (flag === '--provider') o.provider = value(flag, i++);
    else if (flag === '--budget-usd') {
      const raw = value(flag, i++);
      const usd = /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : NaN;
      if (!(Number.isFinite(usd) && usd > 0)) refuse(`--budget-usd must be a positive amount in USD, not ${JSON.stringify(raw)}`);
      o.budgetUsd = usd;
    } else if (flag === '--monthly-cap-usd') {
      const raw = value(flag, i++);
      const cap = /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : NaN;
      if (!(Number.isFinite(cap) && cap > 0)) refuse(`--monthly-cap-usd must be a positive amount in USD, not ${JSON.stringify(raw)}`);
      o.monthlyCapUsd = cap;
    } else if (flag === '--poll-ms') {
      const raw = value(flag, i++);
      const ms = /^\d+$/.test(raw) ? Number(raw) : NaN;
      if (!(ms >= MIN_POLL_MS && ms <= MAX_POLL_MS)) refuse(`--poll-ms must be a whole number of milliseconds from ${MIN_POLL_MS} to ${MAX_POLL_MS}, not ${JSON.stringify(raw)}`);
      o.pollMs = ms;
    } else if (flag === '--ledger') o.ledger = path.resolve(value(flag, i++));
    else if (flag === '--tasks') o.tasks = path.resolve(value(flag, i++));
    else if (flag === '--providers') o.providers = path.resolve(value(flag, i++));
    else if (flag === '--output') o.output = path.resolve(value(flag, i++));
    else if (flag === '--scratch') o.scratch = path.resolve(value(flag, i++));
    else refuse(`unknown argument ${flag}\n${USAGE}`);
  }
  if (o.list) return o;
  if (!o.provider) refuse(`--provider is required\n${USAGE}`);
  if (o.budgetUsd === null) refuse(`--budget-usd is required: a live run spends money and needs an explicit cap\n${USAGE}`);
  if (o.monthlyCapUsd === null) refuse(`--monthly-cap-usd is required: every run of the month shares it through the ledger (${o.ledger})\n${USAGE}`);
  return o;
}

/** Which marker says this is a disposable sandbox, or null. Only these three: anything looser could open the gate on the owner's own machine. */
export function sandboxMarker(env = process.env, exists = fs.existsSync) {
  if (env.CI === 'true') return 'CI=true';
  if (env.CHATMCP_LIVE_SANDBOX === '1') return 'CHATMCP_LIVE_SANDBOX=1';
  if (exists('/.dockerenv')) return '/.dockerenv';
  return null;
}

/**
 * The rates the ledger is given, chosen so that its count is too high rather than too low: the provider's highest price tier; no cache-read discount
 * (a cached prompt token is charged as input, which also keeps the ledger able to price a provider that does not report the cache split: lib/model-cost.mjs
 * calls a response with a cheaper cache rate and no split "unknown"); a cache-write rate only when it is a surcharge above the input rate.
 */
export function conservativeRates(rates, tiers = []) {
  let chosen = rates;
  for (const tier of tiers) if (tier.input >= chosen.input && tier.output >= chosen.output) chosen = tier;
  const result = { input: chosen.input, output: chosen.output };
  if (typeof chosen.cacheWrite === 'number' && chosen.cacheWrite > chosen.input) result.cacheWrite = chosen.cacheWrite;
  return result;
}

/** The ceiling of one request of a provider entry, at the rates the ledger is given (budget.mjs requestCeiling; a missing number is a refusal). */
export function entryCeiling(entry) {
  const rates = conservativeRates(entry.ratesUsdPerMillion, entry.tiers ?? []);
  return requestCeiling({ rates, contextWindow: entry.contextWindow, maxOutput: entry.maxOutput });
}

export function loadProviders(file) {
  const catalogue = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (catalogue?.schema !== 1 || !catalogue.providers || typeof catalogue.providers !== 'object') throw new Error(`${file}: not a providers file (schema 1)`);
  return catalogue;
}

function providerEntry(catalogue, id) {
  const entry = Object.hasOwn(catalogue.providers, id) ? catalogue.providers[id] : null;
  if (!entry) refuse(`provider ${JSON.stringify(id)} is not listed (known: ${Object.keys(catalogue.providers).join(', ')})`);
  for (const field of ['preset', 'protocol', 'apiBaseUrl', 'model']) if (typeof entry[field] !== 'string' || !entry[field]) refuse(`provider ${id}: ${field} is missing`);
  const rates = entry.ratesUsdPerMillion;
  if (!rates || typeof rates.input !== 'number' || typeof rates.output !== 'number') refuse(`provider ${id}: its price is unknown (input and output USD per million tokens are required)${entry.note ? `: ${entry.note}` : ''}`);
  if (entry.keyEnv !== null && !ALLOWED_KEY_ENVS.has(entry.keyEnv)) refuse(`provider ${id}: key variable ${entry.keyEnv} is not on the allow-list`);
  return entry;
}

function loadTasks(file) {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { refuse(`cannot read the tasks file ${file}: ${error.message}`); }
  const tasks = parsed?.tasks;
  if (parsed?.schema !== 1 || !Array.isArray(tasks) || !tasks.length) refuse(`${file}: expected {"schema": 1, "tasks": [...]}`);
  const ids = new Set();
  for (const task of tasks) {
    if (typeof task?.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(task.id) || ids.has(task.id)) refuse(`${file}: a task needs a unique id of lower-case letters, digits and dashes`);
    ids.add(task.id);
    if (typeof task.prompt !== 'string' || !task.prompt.trim()) refuse(`task ${task.id}: prompt is missing`);
    if (!Number.isSafeInteger(task.maxSteps) || task.maxSteps < 1 || task.maxSteps > CAPS.maxSteps) refuse(`task ${task.id}: maxSteps must be a whole number from 1 to ${CAPS.maxSteps}`);
    if (!Number.isFinite(task.maxMinutes) || task.maxMinutes <= 0 || task.maxMinutes > CAPS.maxMinutes) refuse(`task ${task.id}: maxMinutes must be above 0 and at most ${CAPS.maxMinutes}`);
    for (const name of Object.keys(task.files ?? {})) {
      const parts = name.split(/[\\/]/);
      if (path.isAbsolute(name) || parts.includes('..') || !name) refuse(`task ${task.id}: file ${JSON.stringify(name)} is not a relative path inside the project`);
    }
  }
  return tasks;
}

/** Every gate, in order. Returns what the run needs, or throws a Refusal. Nothing here starts a process or opens a socket. */
export function checkGates(argv, env = process.env, exists = fs.existsSync) {
  const options = parseArguments(argv);
  if (options.list) return { options };
  if (env.CHATMCP_LIVE_OK !== '1') refuse('CHATMCP_LIVE_OK=1 is required: a live run sends your tasks to a paid model provider and spends money');
  const marker = sandboxMarker(env, exists);
  if (!marker) refuse('no disposable sandbox detected (CI=true, /.dockerenv or CHATMCP_LIVE_SANDBOX=1): the tasks run in Full Access, so the model\'s commands would run on this machine with your rights');
  let catalogue;
  try { catalogue = loadProviders(options.providers); } catch (error) { refuse(error.message); }
  const entry = providerEntry(catalogue, options.provider);
  const tasks = loadTasks(options.tasks);
  let key;
  try { key = forwardedKey({ keyEnv: entry.keyEnv, env }); } catch (error) { refuse(`provider ${options.provider}: ${error.message}`); }
  const rates = conservativeRates(entry.ratesUsdPerMillion, entry.tiers ?? []);
  let ceiling;
  try { ceiling = entryCeiling(entry); } catch (error) { if (error instanceof BudgetRefusal) refuse(`provider ${options.provider}: ${error.message}`); throw error; }
  return { options, catalogue, entry, tasks, key: entry.keyEnv ? key[entry.keyEnv] : null, rates, ceiling, marker };
}

const git = (...args) => { const r = spawnSync('git', args, { cwd: REPO, encoding: 'utf8', timeout: 10000, windowsHide: true }); return r.status === 0 ? r.stdout.trim() : null; };

/**
 * Runs one task to its end, or until the governor stops it (tests/live/lib/budget.mjs governTask). The Hub's task API takes no step or time limit
 * (POST /api/tasks/start ignores maxSteps and maxMinutes), so the governor enforces both, with the cap: it cancels the task (the step that was running when
 * the limit was seen may finish). Every approval the Hub still asks for (Full Access asks about a few tools, such as a push) is denied.
 */
async function runTask(hub, client, task, { capUsd, spentByTask, ceilingUsd, pollMs }) {
  const started = Date.now();
  const created = await startTask(hub, task.prompt);
  const outcome = await governTask(client, {
    taskId: created.id, spentByTask, capUsd, ceilingUsd, maxSteps: task.maxSteps, maxMinutes: task.maxMinutes, pollMs,
  });
  const full = outcome.final ?? {};
  return {
    outcome,
    record: {
      id: task.id, hubTaskId: created.id, state: full.state ?? null, errorCode: full.errorCode ?? null, steps: full.steps ?? null, toolCalls: full.toolCalls ?? null,
      maxSteps: task.maxSteps, maxMinutes: task.maxMinutes, limitReached: outcome.limitReached, deniedApprovals: outcome.denied,
      effectiveProfile: full.effectiveProfile?.id ?? null, usage: full.usage ?? null, modelCost: full.modelCost ?? null,
      spend: outcome.spend, othersUsd: outcome.othersUsd, cancel: outcome.cancel, durationMs: Date.now() - started,
    },
  };
}

async function writeProject(project, files = {}) {
  await mkdir(project, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(project, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, String(content), 'utf8');
  }
}

/** The total of a run as it is printed: never a bare number when part of it is an upper bound. */
export function spendText(report) {
  const total = usdText(report.spentUsd);
  if (report.spentBasis === 'upper_bound') return `${total} (an UPPER BOUND: ${report.chargedRequests} request(s) without a priced response counted at the ${usdText(report.ceiling.usd)} ceiling)`;
  return `${total} (the Hub's cost ledger, at the runner's rates)`;
}

export async function runLive(gates, { log = console.log, warn = console.error } = {}) {
  const { options, entry, tasks, key, rates, ceiling, marker } = gates;
  const report = {
    schema: 'chatmcp-live-evaluation-v0', kind: 'live-runner-skeleton',
    source: { commit: git('rev-parse', 'HEAD'), dirty: (git('status', '--porcelain') || '').length > 0 },
    runtime: { node: process.version, platform: process.platform, arch: process.arch, sandbox: marker },
    startedAt: new Date().toISOString(), completedAt: null,
    provider: { id: options.provider, preset: entry.preset, protocol: entry.protocol, apiOrigin: new URL(entry.apiBaseUrl).origin, model: entry.model, contextWindow: entry.contextWindow ?? null, maxOutput: entry.maxOutput ?? null, ratesUsdPerMillion: rates, priceSource: gates.catalogue.source ?? null },
    budgetUsd: options.budgetUsd, monthlyCapUsd: options.monthlyCapUsd, effectiveCapUsd: null, ceiling, estimate: null, warnings: [],
    spentUsd: 0, spentBasis: 'ledger', chargedRequests: 0, hubTasks: [],
    budgetNote: 'The spend governor (tests/live/lib/budget.mjs): a request without a priced response is counted at the ceiling of one request, so a figure with such requests is an upper bound; the run is cancelled when spent + one ceiling passes the cap, and ends within cap + one ceiling while no more than one response comes back between two polls. Provider-side retries and the Hub\'s connection check are not seen: the provider-side cap is the backstop.',
    uncounted: null, ledger: null, stoppedBy: null, hub: null, preflight: null, tasks: [], error: null,
  };
  const runId = `${new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)}-${randomBytes(4).toString('hex')}`;
  let run;
  try {
    run = openRun(options.ledger, { runId, provider: options.provider, model: entry.model, tasks, ceilingUsd: ceiling.usd, budgetUsd: options.budgetUsd, monthlyCapUsd: options.monthlyCapUsd });
  } catch (error) {
    if (!(error instanceof BudgetRefusal)) throw error;
    report.error = error.message;
    report.completedAt = new Date().toISOString();
    return { code: EXIT.REFUSED, report };
  }
  report.effectiveCapUsd = run.effectiveCapUsd;
  report.estimate = run.estimate;
  report.warnings = [...run.warnings];
  report.ledger = { file: options.ledger, runId, month: run.month, monthSpentBeforeUsd: run.monthSpentBeforeUsd, reservedUsd: run.reservedUsd, corruptLines: run.corruptLines };
  if (run.corruptLines.length) warn(`WARNING: the ledger ${options.ledger} has unreadable lines ${run.corruptLines.join(', ')}: they were skipped (a run that never settled still counts as its whole reservation)`);
  for (const warning of report.warnings) warn(`WARNING: ${warning}`);
  const scratch = options.scratch ?? await mkdtemp(path.join(os.tmpdir(), 'chatmcp-live-'));
  await mkdir(scratch, { recursive: true });
  const project = path.join(scratch, 'project');
  let hub = null;
  let code = EXIT.TASK_FAILED;
  // A task under way when the run fails has an unknown spend: the run then settles at its whole reservation.
  let taskUnderWay = false;
  // Every Hub task of the run (the runner's tasks and the subagents they started), once, at its last value: the report, the task lines and the settlement
  // all come from it.
  let runSpends = new Map();
  const account = (spends) => {
    runSpends = spends;
    const items = [...spends];
    report.hubTasks = items.map(([id, spend]) => ({ id, usd: spend.usd, knownUsd: spend.knownUsd, chargedRequests: spend.chargedRequests, basis: spend.basis }));
    report.spentUsd = runTotal(spends);
    report.chargedRequests = items.reduce((sum, [, spend]) => sum + spend.chargedRequests, 0);
    report.spentBasis = items.some(([, spend]) => spend.basis === 'upper_bound') ? 'upper_bound' : 'ledger';
  };
  try {
    await writeProject(project, tasks[0].files);
    hub = await startLiveHub({ scratch, project, keyEnv: entry.keyEnv });
    report.hub = { providerKeyVariables: await providerKeyVariables(hub) };
    const test = await configureConnection(hub, entry, key);
    report.preflight = { ok: test?.ok === true, toolCalling: test?.toolCalling ?? null, protocol: test?.protocol ?? null, model: test?.model ?? null };
    const checkRequests = (Array.isArray(test?.attempts) ? test.attempts.length : 0) + (test?.ok === true ? 1 : 0);
    report.uncounted = { connectionCheckRequests: checkRequests, note: 'The Hub\'s connection check (its "Test API": up to 5 protocol attempts and one tool-calling probe) reports no usage, so it is in no figure of this report or of the ledger.' };
    if (test?.ok !== true || test.toolCalling !== 'supported') {
      report.error = `tool calling is not supported by ${entry.model} (the Hub's check said ${JSON.stringify(test?.toolCalling ?? null)}${test?.toolCallingNote ? `: ${test.toolCallingNote}` : ''}); no task was started`;
      code = EXIT.REFUSED;
      return { code, report };
    }
    await upsertProfile(hub, `live-${options.provider}`.slice(0, 40), entry, rates);
    await fullAccess(hub);
    const client = hubClient(hub);
    for (const [index, task] of tasks.entries()) {
      if (index > 0) await writeProject(project, task.files);
      log(`RUN ${task.id} (maxSteps ${task.maxSteps}, maxMinutes ${task.maxMinutes}; cap ${usdText(run.effectiveCapUsd)}, ${usdText(report.spentUsd)} spent)`);
      taskUnderWay = true;
      const spentBefore = report.spentUsd;
      const earlierIds = new Set(runSpends.keys());
      const { outcome, record } = await runTask(hub, client, task, { capUsd: run.effectiveCapUsd, spentByTask: runSpends, ceilingUsd: ceiling.usd, pollMs: options.pollMs });
      taskUnderWay = false;
      report.tasks.push(record);
      account(outcome.spends);
      // The line of a task is what the run's figure grew by while it ran: its own spend and its subagents' (the Hub tasks that came up meanwhile).
      const window = [...outcome.spends].filter(([id]) => !earlierIds.has(id)).map(([, spend]) => spend);
      recordTask(options.ledger, {
        runId, month: run.month, provider: options.provider, model: entry.model, task: task.id, hubTaskId: record.hubTaskId,
        usd: Math.max(0, Number((report.spentUsd - spentBefore).toFixed(8))), ownUsd: outcome.spend.usd, othersUsd: outcome.othersUsd, knownUsd: outcome.spend.knownUsd,
        basis: window.some((spend) => spend.basis === 'upper_bound') ? 'upper_bound' : 'ledger',
        chargedRequests: window.reduce((sum, spend) => sum + spend.chargedRequests, 0), httpRequests: outcome.spend.httpRequests, stoppedBy: outcome.stoppedBy, state: record.state,
      });
      log(`${String(record.state ?? 'unknown').toUpperCase()} ${task.id} ${record.steps ?? '?'} steps, ${spendText(report)} so far`);
      if (outcome.cancel.escalated) {
        report.stoppedBy = outcome.stoppedBy === 'budget_exhausted' ? 'budget_exhausted' : null;
        report.error = `task ${task.id} could not be cancelled (refused ${outcome.cancel.refused}, timed out ${outcome.cancel.timedOut}): the Hub was stopped`;
        break;
      }
      if (outcome.stoppedBy === 'budget_exhausted') { report.stoppedBy = 'budget_exhausted'; break; }
    }
    code = report.stoppedBy ? EXIT.BUDGET_STOP : !report.error && report.tasks.every((task) => task.state === 'completed') ? EXIT.OK : EXIT.TASK_FAILED;
    return { code, report };
  } catch (error) {
    report.error = error instanceof Refusal ? error.message : `the run failed: ${error?.message ?? error}`;
    code = error instanceof Refusal ? EXIT.REFUSED : EXIT.TASK_FAILED;
    return { code, report };
  } finally {
    report.completedAt = new Date().toISOString();
    if (hub) { try { await hub.stop(); } catch { hub.killTree(); } }
    if (taskUnderWay) {
      report.spentUsd = Math.max(report.spentUsd, run.reservedUsd);
      report.spentBasis = 'upper_bound';
      report.warnings.push('the run failed while a task was under way: its spend is unknown, so the run is settled at its whole reservation');
    }
    closeRun(options.ledger, { runId, month: run.month, usd: report.spentUsd, basis: report.spentBasis, stoppedBy: report.stoppedBy, ...(taskUnderWay ? { note: 'failed during a task: settled at the reservation' } : {}) });
    if (!options.scratch) await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(() => {});
  }
}

/** Belt and braces: the key value never leaves this process in a message or the report, whatever text a failure carries. */
export const redactor = (key) => (text) => (key ? String(text).split(key).join('[redacted]') : String(text));

async function main(argv = process.argv.slice(2), env = process.env) {
  let gates;
  try { gates = checkGates(argv, env); } catch (error) {
    if (error instanceof Refusal) { console.error(`REFUSED: ${error.message}`); return EXIT.REFUSED; }
    throw error;
  }
  if (gates.options.list) {
    const catalogue = loadProviders(gates.options.providers);
    for (const [id, entry] of Object.entries(catalogue.providers)) {
      let ceiling = 'unknown';
      try { ceiling = usdText(entryCeiling(entry).usd); } catch { /* a missing number: the runner refuses this entry */ }
      console.log(`${id}\t${entry.model}\t${entry.ratesUsdPerMillion?.input ?? 'unknown'} / ${entry.ratesUsdPerMillion?.output ?? 'unknown'} USD per MTok\tone request at most ${ceiling} (a run needs two)`);
    }
    return EXIT.OK;
  }
  const redact = redactor(gates.key);
  const { code, report } = await runLive(gates, { log: (line) => console.log(redact(line)), warn: (line) => console.error(redact(line)) });
  const text = redact(`${JSON.stringify(report, null, 2)}\n`);
  if (gates.options.output) { await mkdir(path.dirname(gates.options.output), { recursive: true }); await writeFile(gates.options.output, text, 'utf8'); console.log(`Live report: ${gates.options.output}`); }
  if (report.error) console.error(redact(`${code === EXIT.REFUSED ? 'REFUSED' : 'FAILED'}: ${report.error}`));
  if (report.stoppedBy) console.error(`STOPPED: ${report.stoppedBy} (${spendText(report)} spent; the cap of this run was ${usdText(report.effectiveCapUsd)})`);
  console.log(`exit ${code}: ${report.tasks.length} task(s), ${spendText(report)}`);
  if (report.uncounted) console.log(`not counted: the connection check (${report.uncounted.connectionCheckRequests} request(s); the Hub reports no usage for it)`);
  return code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
