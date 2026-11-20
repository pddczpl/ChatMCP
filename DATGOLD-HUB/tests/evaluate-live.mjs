#!/usr/bin/env node
// The opt-in LIVE runner (P7 bc-1): runs tasks through a real Hub against a real model provider, which costs money. It is not part of run-all and the
// deterministic harness (tests/evaluate.mjs) still refuses --live. How to run it and its safety rules: docs/EVALUATION.md.
//
// Gates, all checked before a Hub is started or a byte is sent (each refusal exits 2):
//   CHATMCP_LIVE_OK=1                 the owner's explicit yes for this command
//   --provider <id>                    an entry of tests/live/providers.json (or of --providers <file>) with a known input and output price
//   --budget-usd <n>                   a positive amount; the run stops once the Hub's cost ledger passes it (coarse, see budgetVerdict)
//   a disposable sandbox               CI=true, /.dockerenv, or CHATMCP_LIVE_SANDBOX=1: the tasks run in Full Access, so the model's commands run on this
//                                      machine with this user's rights
//   the provider's key variable        set and non-empty (only that one variable reaches the Hub: tests/live/lib/session.mjs)
//   every task has maxSteps/maxMinutes within the runner's caps
// Then the Hub's own "Test API" check must report tool calling as supported, or the run is refused (exit 2) before any task.
//
// Exit codes: 0 every task completed; 1 a task did not complete (or the run failed); 2 refused / usage; 3 stopped by the budget (or by a response whose
// cost the ledger could not price).
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALLOWED_KEY_ENVS, configureConnection, forwardedKey, fullAccess, providerKeyVariables, settledTask, startLiveHub, startTask, upsertProfile } from './live/lib/session.mjs';

const TESTS = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(TESTS, '..', '..');
export const DEFAULT_PROVIDERS = path.join(TESTS, 'live', 'providers.json');
export const DEFAULT_TASKS = path.join(TESTS, 'live', 'tasks', 'smoke.json');
export const EXIT = Object.freeze({ OK: 0, TASK_FAILED: 1, REFUSED: 2, BUDGET_STOP: 3 });
export const CAPS = Object.freeze({ maxSteps: 50, maxMinutes: 30 });
const POLL_MS = 250;

class Refusal extends Error {}
const refuse = (message) => { throw new Refusal(message); };

const USAGE = `usage: CHATMCP_LIVE_OK=1 node tests/evaluate-live.mjs --provider <id> --budget-usd <usd> [--tasks <file>] [--providers <file>] [--output <report.json>] [--scratch <dir>]
       node tests/evaluate-live.mjs --list
A disposable sandbox is required (CI=true, /.dockerenv or CHATMCP_LIVE_SANDBOX=1). Exit codes: 0 ok, 1 a task failed, 2 refused, 3 budget stop.`;

export function parseArguments(argv) {
  const o = { provider: null, budgetUsd: null, tasks: DEFAULT_TASKS, providers: DEFAULT_PROVIDERS, output: null, scratch: null, list: false };
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
    } else if (flag === '--tasks') o.tasks = path.resolve(value(flag, i++));
    else if (flag === '--providers') o.providers = path.resolve(value(flag, i++));
    else if (flag === '--output') o.output = path.resolve(value(flag, i++));
    else if (flag === '--scratch') o.scratch = path.resolve(value(flag, i++));
    else refuse(`unknown argument ${flag}\n${USAGE}`);
  }
  if (o.list) return o;
  if (!o.provider) refuse(`--provider is required\n${USAGE}`);
  if (o.budgetUsd === null) refuse(`--budget-usd is required: a live run spends money and needs an explicit cap\n${USAGE}`);
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

/**
 * The coarse budget stop (the spend governor is bc-2): the sum of the Hub's cost ledgers so far, and whether to stop. It looks only at responses that
 * already came back, so a run can end above the budget by one response (plus whatever a retried or failed send cost, which no ledger sees). A response
 * the ledger could not price (no usage, no rate) stops the run too: the spend is no longer known.
 */
export function budgetVerdict(ledgers, budgetUsd) {
  let spent = 0;
  let unknown = 0;
  for (const ledger of ledgers) {
    spent += Number(ledger?.knownSubtotalUsd) || 0;
    unknown += (ledger?.unpricedResponses ?? 0) + (ledger?.unknownResponses ?? 0);
  }
  const spentUsd = Number(spent.toFixed(8));
  return { spentUsd, stop: unknown > 0 ? 'cost_unknown' : spentUsd > budgetUsd ? 'budget' : null };
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
  return { options, catalogue, entry, tasks, key: entry.keyEnv ? key[entry.keyEnv] : null, rates, marker };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const git = (...args) => { const r = spawnSync('git', args, { cwd: REPO, encoding: 'utf8', timeout: 10000, windowsHide: true }); return r.status === 0 ? r.stdout.trim() : null; };

/** Why a task must be stopped now: 'budget' / 'cost_unknown' (the whole run stops), 'max_steps' / 'max_minutes' (only this task), or null. */
export function taskStop({ ledgers, budgetUsd, steps, maxSteps, elapsedMs, maxMinutes }) {
  const run = budgetVerdict(ledgers, budgetUsd).stop;
  if (run) return run;
  if (steps > maxSteps) return 'max_steps';
  if (elapsedMs > maxMinutes * 60_000) return 'max_minutes';
  return null;
}
const RUN_STOPS = new Set(['budget', 'cost_unknown']);

/**
 * Runs one task to its end, or until the runner stops it. The Hub's task API takes no step or time limit (POST /api/tasks/start ignores maxSteps and
 * maxMinutes), so the runner enforces both: it cancels the task once it is past its limit (coarse, like the budget: the step that was running when the
 * limit was seen may finish). Every approval the Hub still asks for (Full Access asks about a few tools, such as a push) is denied.
 */
async function runTask(hub, task, { budgetUsd, earlier }) {
  const started = Date.now();
  const created = await startTask(hub, task.prompt);
  let denied = 0;
  let stoppedBy = null;
  let cancelledAt = null;
  for (;;) {
    const state = await hub.state();
    for (const request of state.studio.permissions.pending.filter((item) => item.taskId === created.id)) {
      await hub.post('/api/studio/permissions/decide', { id: request.id, approved: false });
      denied++;
    }
    const summary = state.agent.tasks.find((item) => item.id === created.id);
    const settled = settledTask(state, created.id);
    if (!stoppedBy && !settled) {
      stoppedBy = taskStop({ ledgers: [...earlier, summary?.modelCost], budgetUsd, steps: summary?.steps ?? 0, maxSteps: task.maxSteps, elapsedMs: Date.now() - started, maxMinutes: task.maxMinutes });
    }
    if (stoppedBy && cancelledAt === null) {
      cancelledAt = Date.now();
      await hub.request('POST', '/api/tasks/cancel', { id: created.id });
    }
    if (settled) {
      const full = await hub.task(created.id);
      // A run stop seen only once the task had settled still counts: the next task must not start past the budget.
      const after = budgetVerdict([...earlier, full.modelCost], budgetUsd).stop;
      return {
        stoppedBy: RUN_STOPS.has(stoppedBy) ? stoppedBy : after,
        record: {
          id: task.id, hubTaskId: created.id, state: full.state, errorCode: full.errorCode ?? null, steps: full.steps, toolCalls: full.toolCalls,
          maxSteps: task.maxSteps, maxMinutes: task.maxMinutes, limitReached: stoppedBy && !RUN_STOPS.has(stoppedBy) ? stoppedBy : null, deniedApprovals: denied,
          effectiveProfile: full.effectiveProfile?.id ?? null, usage: full.usage ?? null, modelCost: full.modelCost, durationMs: Date.now() - started,
        },
      };
    }
    if (cancelledAt !== null && Date.now() - cancelledAt > 60_000) throw new Error(`task ${task.id} did not stop within 60 s of its cancellation`);
    await sleep(POLL_MS);
  }
}

async function writeProject(project, files = {}) {
  await mkdir(project, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(project, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, String(content), 'utf8');
  }
}

export async function runLive(gates, { log = console.log } = {}) {
  const { options, entry, tasks, key, rates, marker } = gates;
  const report = {
    schema: 'chatmcp-live-evaluation-v0', kind: 'live-runner-skeleton',
    source: { commit: git('rev-parse', 'HEAD'), dirty: (git('status', '--porcelain') || '').length > 0 },
    runtime: { node: process.version, platform: process.platform, arch: process.arch, sandbox: marker },
    startedAt: new Date().toISOString(), completedAt: null,
    provider: { id: options.provider, preset: entry.preset, protocol: entry.protocol, apiOrigin: new URL(entry.apiBaseUrl).origin, model: entry.model, contextWindow: entry.contextWindow ?? null, ratesUsdPerMillion: rates, priceSource: gates.catalogue.source ?? null },
    budgetUsd: options.budgetUsd, spentUsd: 0,
    budgetNote: 'Coarse: the run stops after the Hub cost ledger passes the budget, so it can end above it by one response; retries and failed sends are not in any ledger.',
    stoppedBy: null, hub: null, preflight: null, tasks: [], error: null,
  };
  const scratch = options.scratch ?? await mkdtemp(path.join(os.tmpdir(), 'chatmcp-live-'));
  await mkdir(scratch, { recursive: true });
  const project = path.join(scratch, 'project');
  await writeProject(project, tasks[0].files);
  let hub = null;
  let code = EXIT.TASK_FAILED;
  try {
    hub = await startLiveHub({ scratch, project, keyEnv: entry.keyEnv });
    report.hub = { providerKeyVariables: await providerKeyVariables(hub) };
    const test = await configureConnection(hub, entry, key);
    report.preflight = { ok: test?.ok === true, toolCalling: test?.toolCalling ?? null, protocol: test?.protocol ?? null, model: test?.model ?? null };
    if (test?.ok !== true || test.toolCalling !== 'supported') {
      report.error = `tool calling is not supported by ${entry.model} (the Hub's check said ${JSON.stringify(test?.toolCalling ?? null)}${test?.toolCallingNote ? `: ${test.toolCallingNote}` : ''}); no task was started`;
      code = EXIT.REFUSED;
      return { code, report };
    }
    await upsertProfile(hub, `live-${options.provider}`.slice(0, 40), entry, rates);
    await fullAccess(hub);
    const ledgers = [];
    for (const [index, task] of tasks.entries()) {
      if (index > 0) await writeProject(project, task.files);
      log(`RUN ${task.id} (maxSteps ${task.maxSteps}, maxMinutes ${task.maxMinutes})`);
      const outcome = await runTask(hub, task, { budgetUsd: options.budgetUsd, earlier: ledgers });
      report.tasks.push(outcome.record);
      ledgers.push(outcome.record.modelCost);
      report.spentUsd = budgetVerdict(ledgers, options.budgetUsd).spentUsd;
      log(`${outcome.record.state.toUpperCase()} ${task.id} ${outcome.record.steps} steps, ${report.spentUsd} USD so far`);
      if (outcome.stoppedBy) { report.stoppedBy = outcome.stoppedBy; break; }
    }
    code = report.stoppedBy ? EXIT.BUDGET_STOP : report.tasks.every((task) => task.state === 'completed') ? EXIT.OK : EXIT.TASK_FAILED;
    return { code, report };
  } catch (error) {
    report.error = error instanceof Refusal ? error.message : `the run failed: ${error?.message ?? error}`;
    code = error instanceof Refusal ? EXIT.REFUSED : EXIT.TASK_FAILED;
    return { code, report };
  } finally {
    report.completedAt = new Date().toISOString();
    if (hub) { try { await hub.stop(); } catch { hub.killTree(); } }
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
    for (const [id, entry] of Object.entries(catalogue.providers)) console.log(`${id}\t${entry.model}\t${entry.ratesUsdPerMillion?.input ?? 'unknown'} / ${entry.ratesUsdPerMillion?.output ?? 'unknown'} USD per MTok`);
    return EXIT.OK;
  }
  const redact = redactor(gates.key);
  const { code, report } = await runLive(gates, { log: (line) => console.log(redact(line)) });
  const text = redact(`${JSON.stringify(report, null, 2)}\n`);
  if (gates.options.output) { await mkdir(path.dirname(gates.options.output), { recursive: true }); await writeFile(gates.options.output, text, 'utf8'); console.log(`Live report: ${gates.options.output}`); }
  if (report.error) console.error(redact(`${code === EXIT.REFUSED ? 'REFUSED' : 'FAILED'}: ${report.error}`));
  if (report.stoppedBy) console.error(`STOPPED: ${report.stoppedBy} (${report.spentUsd} USD spent of a ${report.budgetUsd} USD budget)`);
  console.log(`exit ${code}: ${report.tasks.length} task(s), ${report.spentUsd} USD`);
  return code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
