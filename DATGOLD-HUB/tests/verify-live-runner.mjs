// The opt-in live runner (tests/evaluate-live.mjs, P7 bc-1), driven ONLY against the scripted model server: no real provider, no real key, no spend.
//
// What it proves:
//   - the gates: without CHATMCP_LIVE_OK=1, without a disposable-sandbox marker, without --provider or a usable --budget-usd, with a provider whose price
//     is unknown, without its key variable, or with a model that fails the tool-calling check, the runner refuses with exit 2 and the model hears nothing
//     (or, for the tool-calling check, nothing but the check);
//   - the environment of the Hub it starts holds exactly one provider key variable, the allow-listed one of the chosen provider (decoys planted next to it are
//     not forwarded: the Hub itself reports which provider key variables it sees);
//   - the key value is found nowhere: not in the Hub's state folder or log, the scratch project, the runner's output, its report, or any model request body
//     (scanned > 0, hits = 0);
//   - a scripted task completes through the runner (exit 0), the cost ledger is priced from the provider's rates, and with exaggerated mock prices the spend
//     governor cancels the task (exit 3, budget_exhausted; the governor itself is proved in verify-live-budget.mjs);
//   - tests/live/providers.json carries the numbers of the repository's models.dev snapshot, not invented ones.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findNeedles, runScenario } from './e2e/harness.mjs';
import { call, say, toolText, wasRefused, withUsage } from './e2e/scenarios.mjs';
import { ALLOWED_KEY_ENVS, liveEnvironment } from './live/lib/session.mjs';
import { checkGates, conservativeRates, entryCeiling, EXIT, loadProviders, redactor, sandboxMarker } from './evaluate-live.mjs';

const TESTS = path.dirname(fileURLToPath(import.meta.url));
const HUB = path.resolve(TESTS, '..');
const RUNNER = path.join(TESTS, 'evaluate-live.mjs');
const REAL_PROVIDERS = path.join(TESTS, 'live', 'providers.json');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const KEY = `sk-livetest-${randomBytes(18).toString('hex')}`;
const DECOYS = {
  OPENAI_API_KEY: `sk-decoy-openai-${randomBytes(12).toString('hex')}`,
  ANTHROPIC_API_KEY: `sk-decoy-anthropic-${randomBytes(12).toString('hex')}`,
  GEMINI_API_KEY: `decoy-gemini-${randomBytes(12).toString('hex')}`,
  GITHUB_TOKEN: `ghp_decoy${randomBytes(12).toString('hex')}`,
  SOME_SERVICE_PASSWORD: `decoy-password-${randomBytes(12).toString('hex')}`,
};

/** The caller's environment without anything that would open a gate by accident (a CI runner sets CI=true). */
function baseEnvironment() {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^CHATMCP_LIVE_/i.test(name) || name === 'CI' || name in DECOYS || name === 'DEEPSEEK_API_KEY') delete env[name];
  return env;
}

/** Runs the runner without blocking this process (the mock model lives here and must keep answering). */
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

const modelRequests = (mock) => mock.state.requests.filter((request) => !request.probe).length;

await runScenario({ name: 'live-runner', summary: 'live runner gates, one forwarded key, no key on disk or in output, a scripted task, the governor\'s budget stop', budgetMs: 170_000 }, async (t) => {
  // ---- unit: the sandbox marker ----------------------------------------------------------------------------------------------------------
  const none = () => false;
  t.equal(sandboxMarker({}, none), null, 'no marker: not a sandbox');
  t.equal(sandboxMarker({ CI: 'true' }, none), 'CI=true', 'CI=true is a marker');
  t.equal(sandboxMarker({ CI: '1' }, none), null, 'CI=1 is not (GitHub and the others set the word true)');
  t.equal(sandboxMarker({ CHATMCP_LIVE_SANDBOX: '1' }, none), 'CHATMCP_LIVE_SANDBOX=1', 'CHATMCP_LIVE_SANDBOX=1 is a marker');
  t.equal(sandboxMarker({ CHATMCP_LIVE_SANDBOX: 'yes' }, none), null, 'CHATMCP_LIVE_SANDBOX=yes is not');
  t.equal(sandboxMarker({}, (file) => file === '/.dockerenv'), '/.dockerenv', '/.dockerenv is a marker');

  // The budget stop, the step and minute limits and the upper bound for unpriced responses are the spend governor's (tests/live/lib/budget.mjs): their
  // unit checks are in verify-live-budget.mjs. This suite runs them end to end through the runner below.

  // ---- unit: the most expensive tier is the one sent to the ledger ------------------------------------------------------------------------
  t.equal(conservativeRates({ input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 }, [{ aboveInputTokens: 100000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 }]),
    { input: 0.5, output: 2.5, cacheWrite: 0.625 }, 'a provider with price tiers is charged at its highest tier, with its cache-write surcharge and without a cache-read discount');
  t.equal(conservativeRates({ input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: null }, []), { input: 0.15, output: 0.6 }, 'no tiers: input and output; no cache-read discount, an unknown cache-write rate left out');
  t.equal(conservativeRates({ input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.5 }, []), { input: 1, output: 2 }, 'a cache write cheaper than input is charged as input');
  t.equal(conservativeRates({ input: 1, output: 2 }, [{ aboveInputTokens: 10, input: 0.5, output: 1 }]), { input: 1, output: 2 }, 'a tier cheaper than the base is not chosen');

  // ---- unit: the redactor of everything the runner prints or writes ----------------------------------------------------------------------
  t.equal(redactor(KEY)(`a ${KEY} b ${KEY}`), 'a [redacted] b [redacted]', 'the key value is replaced wherever it appears in a message');
  t.equal(redactor(null)('nothing to hide'), 'nothing to hide', 'without a key the text is left alone');

  // ---- unit: the environment of the Hub --------------------------------------------------------------------------------------------------
  const home = t.dir('env-home');
  const planted = { ...baseEnvironment(), ...DECOYS, DEEPSEEK_API_KEY: KEY, CHATMCP_LIVE_OK: '1' };
  const env = liveEnvironment(home, { keyEnv: 'DEEPSEEK_API_KEY', env: planted });
  t.equal(env.DEEPSEEK_API_KEY, KEY, 'the allow-listed key variable of the chosen provider is forwarded');
  const keyLike = Object.keys(env).filter((name) => /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(name));
  t.equal(keyLike, ['DEEPSEEK_API_KEY'], 'it is the only KEY/TOKEN/SECRET/PASSWORD-like variable left');
  t.check(Object.values(env).every((value) => !Object.values(DECOYS).includes(value)), 'no decoy value is in the environment');
  t.check(!('CHATMCP_LIVE_OK' in env), 'the runner\'s own gate variable is not forwarded');
  t.equal(Object.keys(liveEnvironment(home, { keyEnv: null, env: planted })).filter((name) => /(KEY|TOKEN|SECRET|PASSWORD)/i.test(name)), [], 'a local provider gets no key variable at all');
  let refused = null;
  try { liveEnvironment(home, { keyEnv: 'OPENAI_API_KEY', env: planted }); } catch (error) { refused = error; }
  t.check(refused && /allow/i.test(refused.message), 'a key variable outside the allow-list is refused', refused?.message);
  t.equal([...ALLOWED_KEY_ENVS].sort(), ['ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY'], 'the allow-list is the three hosted providers of providers.json');

  // ---- unit: providers.json against the models.dev snapshot ------------------------------------------------------------------------------
  const snapshot = JSON.parse(fs.readFileSync(path.join(HUB, 'lib', 'model-catalog.data.json'), 'utf8'));
  const real = loadProviders(REAL_PROVIDERS);
  t.equal(real.source.generatedAt, snapshot.generatedAt, 'providers.json names the date of the snapshot it was read from');
  t.equal(real.source.sha256, snapshot.sha256, 'and its hash');
  t.equal(Object.keys(real.providers).sort(), ['claude-haiku-5-5', 'deepseek-flash', 'ollama-local', 'openrouter-deepseek-v4-flash'], 'the four providers of the plan');
  for (const [id, entry] of Object.entries(real.providers)) {
    t.check(typeof entry.model === 'string' && entry.model && typeof entry.preset === 'string' && entry.preset && 'contextWindow' in entry && entry.ratesUsdPerMillion !== undefined,
      `${id}: explicit model, preset, context window and prices`);
    t.check(entry.keyEnv === null || ALLOWED_KEY_ENVS.has(entry.keyEnv), `${id}: its key variable is allow-listed`, entry.keyEnv);
    if (!entry.catalog) { t.check(typeof entry.note === 'string' && entry.note.length > 20, `${id}: not in the snapshot, and the entry says why`); continue; }
    const rowIndex = snapshot.providers[entry.catalog.provider]?.[entry.catalog.model];
    t.must(Number.isInteger(rowIndex), `${id}: ${entry.catalog.provider}/${entry.catalog.model} is in the snapshot`);
    const row = snapshot.rows[rowIndex];
    t.equal(entry.contextWindow, row[0], `${id}: the context window is the snapshot's`);
    t.equal(entry.maxOutput, row[1] ?? null, `${id}: the maximum output is the snapshot's`);
    t.check(entryCeiling(entry).usd > 0, `${id}: the ceiling of one request is known`);
    const [input, output, cacheRead, cacheWrite] = row[3];
    t.equal(entry.ratesUsdPerMillion, { input, output, cacheRead, cacheWrite }, `${id}: the prices are the snapshot's`);
    t.equal((entry.tiers ?? []).map((tier) => [tier.aboveInputTokens, tier.input, tier.output, tier.cacheRead, tier.cacheWrite]), row[7] ?? [], `${id}: the price tiers are the snapshot's`);
  }

  // ---- process: refusals before anything starts ------------------------------------------------------------------------------------------
  let pushResult = null;
  const mock = await t.mock({
    scenario: 'live-smoke',
    scenarios: {
      // The forced push goes to a remote that exists nowhere: the Hub asks about it even in Full Access, the runner must deny it, and run anyway it could only fail.
      'live-smoke': ({ turn, last }) => {
        if (turn === 0) return call('write_file', { path: 'hello.txt', content: 'hello from the live runner\n' });
        if (turn === 1) return call('run_command', { command: 'git push --force nowhere-remote-of-the-live-test nothing-here' });
        pushResult = toolText(last);
        return say('Wrote hello.txt.');
      },
      // Never finishes on its own: one new file after another (progress, so the Hub's stall check does not end it), slowly, until the step limit (or the budget stop) ends it.
      'live-spender': async ({ turn }) => { await sleep(150); return call('write_file', { path: `notes-${turn}.txt`, content: `step ${turn}` }); },
      // The same, with large usage: each response costs about a third of a ceiling at the exaggerated prices below, so the governor stops it after a few.
      'live-priced-spender': async ({ turn }) => { await sleep(300); return withUsage({ input: 60000, output: 1500 }, call('write_file', { path: `notes-${turn}.txt`, content: `step ${turn}` })); },
    },
  });
  const work = t.dir('providers');
  const providersFile = (rates, extra = {}) => {
    const file = path.join(work, `providers-${randomBytes(4).toString('hex')}.json`);
    fs.writeFileSync(file, JSON.stringify({
      schema: 1, source: { note: 'test catalogue: the scripted model server' },
      providers: { mock: { preset: 'custom-openai', protocol: 'openai-chat', apiBaseUrl: mock.url, model: 'mock-coder', contextWindow: 128000, maxOutput: 4096, keyEnv: 'DEEPSEEK_API_KEY', ratesUsdPerMillion: rates, tiers: [], catalog: null, note: 'the scripted model server of the tests', ...extra } },
    }));
    return file;
  };
  // The monthly cap and the ledger of every run of this suite (never bench-results/ledger.jsonl), and a quicker poll than the default.
  const common = ['--monthly-cap-usd', '50', '--ledger', path.join(work, 'ledger.jsonl'), '--poll-ms', '100'];
  const cheap = providersFile({ input: 1, output: 2, cacheRead: 0.1, cacheWrite: null });
  const unpriced = providersFile({ input: 1, output: null, cacheRead: null, cacheWrite: null });
  const tasksFile = (tasks) => { const file = path.join(work, `tasks-${randomBytes(4).toString('hex')}.json`); fs.writeFileSync(file, JSON.stringify({ schema: 1, tasks })); return file; };
  const smokeTasks = tasksFile([{ id: 'smoke', prompt: 'Create hello.txt with one line of greeting.', files: { 'README.md': '# scratch\n' }, maxSteps: 6, maxMinutes: 2 }]);
  const gated = { ...baseEnvironment(), ...DECOYS, DEEPSEEK_API_KEY: KEY, CHATMCP_LIVE_OK: '1', CHATMCP_LIVE_SANDBOX: '1' };
  const usual = ['--providers', cheap, '--tasks', smokeTasks, '--provider', 'mock', ...common, '--budget-usd', '1'];
  // The gate function itself refuses (the spend governor's pre-flight would refuse these too, later: each layer must hold on its own).
  const openGates = { CHATMCP_LIVE_OK: '1', CHATMCP_LIVE_SANDBOX: '1', DEEPSEEK_API_KEY: KEY };
  const gateRefusal = (args) => { try { checkGates(args, openGates, () => false); return null; } catch (error) { return error.message; } };
  t.check(/--budget-usd is required/.test(gateRefusal(['--providers', cheap, '--tasks', smokeTasks, '--provider', 'mock', ...common]) ?? ''), 'checkGates() refuses a run without --budget-usd');
  t.check(/--budget-usd must be a positive amount/.test(gateRefusal([...usual.slice(0, -1), '0']) ?? ''), 'checkGates() refuses --budget-usd 0');
  t.check(/price is unknown/.test(gateRefusal(['--providers', unpriced, '--tasks', smokeTasks, '--provider', 'mock', ...common, '--budget-usd', '1']) ?? ''), 'checkGates() refuses a provider without an output price, as an unknown price');
  t.equal(gateRefusal(usual), null, 'and lets the usual arguments through');
  const outputs = [];
  const refusal = async (label, args, env, pattern) => {
    mock.setScenario('live-smoke');
    const result = await runRunner(args, env);
    outputs.push(result.text);
    t.equal(result.code, EXIT.REFUSED, `${label}: exit 2`);
    t.check(pattern.test(result.text), `${label}: the refusal says why`, result.text.slice(0, 300));
    t.equal(mock.state.requests.length, 0, `${label}: the model heard nothing`);
  };
  t.equal(EXIT, { OK: 0, TASK_FAILED: 1, REFUSED: 2, BUDGET_STOP: 3 }, 'the documented exit codes');
  await refusal('without CHATMCP_LIVE_OK', usual, { ...gated, CHATMCP_LIVE_OK: '' }, /CHATMCP_LIVE_OK/);
  await refusal('with CHATMCP_LIVE_OK=true instead of 1', usual, { ...gated, CHATMCP_LIVE_OK: 'true' }, /CHATMCP_LIVE_OK/);
  if (fs.existsSync('/.dockerenv')) t.note('this machine has /.dockerenv, so the no-sandbox refusal cannot be run as a process here (the unit checks above cover it)');
  else await refusal('without a sandbox marker', usual, { ...gated, CHATMCP_LIVE_SANDBOX: '' }, /sandbox/i);
  await refusal('without --budget-usd', ['--providers', cheap, '--tasks', smokeTasks, '--provider', 'mock', ...common], gated, /--budget-usd/);
  await refusal('with --budget-usd 0', [...usual.slice(0, -1), '0'], gated, /--budget-usd/);
  await refusal('with --budget-usd abc', [...usual.slice(0, -1), 'abc'], gated, /--budget-usd/);
  await refusal('without --provider', ['--providers', cheap, '--tasks', smokeTasks, ...common, '--budget-usd', '1'], gated, /--provider/);
  await refusal('with a provider that is not listed', ['--providers', cheap, '--tasks', smokeTasks, '--provider', 'nope', ...common, '--budget-usd', '1'], gated, /nope/);
  await refusal('with a provider whose price is unknown', ['--providers', unpriced, '--tasks', smokeTasks, '--provider', 'mock', ...common, '--budget-usd', '1'], gated, /price/i);
  await refusal('without the key variable', usual, { ...gated, DEEPSEEK_API_KEY: '' }, /DEEPSEEK_API_KEY/);
  await refusal('with an unknown flag', [...usual, '--live-anyway'], gated, /--live-anyway/);
  await refusal('with a task that has no step limit', ['--providers', cheap, '--tasks', tasksFile([{ id: 'x', prompt: 'Do it.', files: {}, maxMinutes: 1 }]), '--provider', 'mock', ...common, '--budget-usd', '1'], gated, /maxSteps/);
  await refusal('with a task above the step cap', ['--providers', cheap, '--tasks', tasksFile([{ id: 'x', prompt: 'Do it.', files: {}, maxSteps: 51, maxMinutes: 1 }]), '--provider', 'mock', ...common, '--budget-usd', '1'], gated, /maxSteps/);
  await refusal('with a task file outside the project', ['--providers', cheap, '--tasks', tasksFile([{ id: 'x', prompt: 'Do it.', files: { '../escape.txt': 'x' }, maxSteps: 2, maxMinutes: 1 }]), '--provider', 'mock', ...common, '--budget-usd', '1'], gated, /relative path/);
  t.check(!fs.existsSync(path.join(work, 'escape.txt')) && !fs.existsSync(path.join(t.scratch, 'escape.txt')), 'and nothing was written outside it');
  // The real catalogue, with THREE gates closed (no CHATMCP_LIVE_OK, no sandbox marker, no key): a mutant that breaks one gate (tests/mutation/live-runner.json) still
  // meets two more, so no run of this suite, mutated or not, can send a request to a real provider. The local entry has no price, so it is refused for that.
  const closed = { ...gated, CHATMCP_LIVE_OK: '', CHATMCP_LIVE_SANDBOX: '', DEEPSEEK_API_KEY: '' };
  await refusal('a real hosted provider, three gates closed', ['--provider', 'deepseek-flash', ...common, '--budget-usd', '0.10'], closed, /CHATMCP_LIVE_OK/);
  // The local entry has no price: checked through checkGates() itself (it starts nothing), so that even a mutant that lets an unknown price through cannot reach a local server.
  let localRefusal = null;
  try { checkGates(['--provider', 'ollama-local', ...common, '--budget-usd', '0.10'], { CHATMCP_LIVE_OK: '1', CHATMCP_LIVE_SANDBOX: '1' }, () => false); } catch (error) { localRefusal = error; }
  t.check(/price is unknown/.test(localRefusal?.message ?? ''), 'the real ollama-local entry is refused: its price is unknown', localRefusal?.message);

  // ---- process: the tool-calling check fails -> refused, no task --------------------------------------------------------------------------
  mock.setScenario('live-smoke');
  const refusal400 = mock.refuseParam('tools');
  const noTools = await runRunner(usual, gated);
  mock.clearRefusals();
  outputs.push(noTools.text);
  t.equal(noTools.code, EXIT.REFUSED, 'a model that fails the tool-calling check: exit 2');
  t.check(/tool calling/i.test(noTools.text), 'the refusal names the tool-calling check', noTools.text.slice(-400));
  t.check(refusal400.used > 0, 'the check did reach the model (and was refused there)');
  t.check(!mock.state.requests.some((request) => /hello\.txt/.test(request.promptStart ?? '')), 'no task was sent to the model');

  // ---- process: a scripted task completes ------------------------------------------------------------------------------------------------
  mock.setScenario('live-smoke');
  mock.watch([KEY, ...Object.values(DECOYS)]);
  const scratchA = path.join(t.scratch, 'run-smoke');
  const reportA = path.join(t.scratch, 'report-smoke.json');
  const smoke = await runRunner([...usual, '--scratch', scratchA, '--output', reportA], gated);
  outputs.push(smoke.text);
  t.must(smoke.code === EXIT.OK, 'the scripted task through the runner: exit 0', smoke.text.slice(-1500));
  const report = JSON.parse(fs.readFileSync(reportA, 'utf8'));
  t.equal(report.tasks.map((task) => [task.id, task.state]), [['smoke', 'completed']], 'the report has the task, completed');
  t.equal(report.stoppedBy, null, 'nothing stopped the run');
  t.equal(report.preflight.toolCalling, 'supported', 'the tool-calling check passed first');
  t.equal(report.hub.providerKeyVariables, ['DEEPSEEK_API_KEY'], 'the Hub itself sees exactly one provider key variable, the allow-listed one (decoys OPENAI/ANTHROPIC/GEMINI were planted)');
  t.equal(report.provider.ratesUsdPerMillion, { input: 1, output: 2 }, 'the report names the rates the ledger was given');
  t.equal(report.tasks[0].effectiveProfile, 'live-mock', 'the task ran on the profile the runner made');
  t.check(report.tasks[0].modelCost.pricedResponses > 0 && report.tasks[0].modelCost.unpricedResponses === 0 && report.spentUsd > 0, 'the cost ledger priced every response', JSON.stringify(report.tasks[0].modelCost));
  t.check(report.spentUsd <= 1, 'the spend stayed inside the budget', String(report.spentUsd));
  t.equal([report.tasks[0].maxSteps, report.tasks[0].maxMinutes, report.tasks[0].limitReached], [6, 2, null], 'the task ran under its limits and reached none');
  t.equal(report.tasks[0].deniedApprovals, 1, 'the one question the Hub still asks in Full Access (a forced push) was answered');
  t.check(wasRefused(pushResult), 'and answered no: the model was told the command was refused', pushResult?.slice(0, 200));
  t.equal(fs.readFileSync(path.join(scratchA, 'project', 'hello.txt'), 'utf8'), 'hello from the live runner\n', 'the file the scripted model wrote is in the scratch project');
  t.check(mock.state.requests.some((request) => request.hasAuthorization), 'the key reached the Hub (the model requests carried an Authorization header)');
  const watched = mock.watchReport();
  t.check(watched.scanned > 0 && watched.hits.length === 0, 'no model request body holds the key or a decoy', JSON.stringify(watched));

  // ---- process: the budget stop of the spend governor ----------------------------------------------------------------------------------------
  // At these prices one request costs at most (128000 x 0.05 + 4096 x 1) / 1e6 x 1.25 = 0.01312 USD, and each response of the scenario 0.0045 USD.
  mock.setScenario('live-priced-spender');
  const pricey = providersFile({ input: 0.05, output: 1, cacheRead: 0.05, cacheWrite: null });
  const priceyCeiling = (128000 * 0.05 + 4096 * 1) / 1e6 * 1.25;
  const spenderTasks = tasksFile([
    { id: 'spender', prompt: 'Keep reading.', files: { 'README.md': '# scratch\n' }, maxSteps: 30, maxMinutes: 2 },
    { id: 'never-started', prompt: 'Never run.', files: {}, maxSteps: 3, maxMinutes: 1 },
  ]);
  const scratchB = path.join(t.scratch, 'run-spender');
  const reportB = path.join(t.scratch, 'report-spender.json');
  const spender = await runRunner(['--providers', pricey, '--tasks', spenderTasks, '--provider', 'mock', ...common, '--budget-usd', '0.05', '--scratch', scratchB, '--output', reportB], gated);
  outputs.push(spender.text);
  t.equal(spender.code, EXIT.BUDGET_STOP, 'exaggerated prices: the budget stop ends the run with exit 3');
  const stopped = JSON.parse(fs.readFileSync(reportB, 'utf8'));
  t.equal(stopped.stoppedBy, 'budget_exhausted', 'the report says the budget stopped it (budget_exhausted)');
  t.check(stopped.spentUsd > 0 && stopped.spentUsd <= 0.05 + priceyCeiling + 1e-9, 'the run ended within the cap plus one ceiling', String(stopped.spentUsd));
  t.check(stopped.tasks[0].id === 'spender' && stopped.tasks[0].state !== 'completed', 'the running task was cancelled, not completed', JSON.stringify(stopped.tasks[0]?.state));
  t.equal(stopped.tasks.map((task) => task.id), ['spender'], 'the next task was never started');
  t.check(modelRequests(mock) < 30, 'the model was asked far fewer times than the step limit allows', String(modelRequests(mock)));

  // ---- process: the per-task limits, enforced by the runner -------------------------------------------------------------------------------
  mock.setScenario('live-spender');
  const limitTasks = tasksFile([
    { id: 'three-steps', prompt: 'Keep reading.', files: { 'README.md': '# scratch\n' }, maxSteps: 3, maxMinutes: 2 },
    { id: 'three-seconds', prompt: 'Keep reading.', files: {}, maxSteps: 50, maxMinutes: 0.05 },
  ]);
  const reportC = path.join(t.scratch, 'report-limits.json');
  const limited = await runRunner(['--providers', cheap, '--tasks', limitTasks, '--provider', 'mock', ...common, '--budget-usd', '5', '--scratch', path.join(t.scratch, 'run-limits'), '--output', reportC], gated);
  outputs.push(limited.text);
  t.equal(limited.code, EXIT.TASK_FAILED, 'tasks stopped at their limits did not complete: exit 1');
  const limitedReport = JSON.parse(fs.readFileSync(reportC, 'utf8'));
  t.equal(limitedReport.tasks.map((task) => [task.id, task.limitReached]), [['three-steps', 'max_steps'], ['three-seconds', 'max_minutes']], 'one task stopped at its step limit, the next at its minute limit (a task limit does not end the run)');
  t.check(limitedReport.tasks[0].steps <= 5 && limitedReport.tasks[0].state !== 'completed', 'the three-step task was cancelled within two steps of its limit', JSON.stringify([limitedReport.tasks[0].steps, limitedReport.tasks[0].state]));
  t.check(limitedReport.tasks[1].durationMs < 15_000 && limitedReport.tasks[1].steps < 50, 'the three-second task was cancelled long before its step limit', JSON.stringify([limitedReport.tasks[1].durationMs, limitedReport.tasks[1].steps]));
  t.equal(limitedReport.stoppedBy, null, 'and the run itself was not stopped');

  // ---- nowhere: the key and the decoys -----------------------------------------------------------------------------------------------------
  const needles = [KEY, ...Object.values(DECOYS)];
  const onDisk = findNeedles(t.scratch, needles);
  t.check(onDisk.scanned > 10 && onDisk.hits.length === 0, 'no file of either run (state folders, Hub logs, projects, reports) holds the key or a decoy', JSON.stringify(onDisk));
  const printed = outputs.join('\n');
  t.check(outputs.length > 10 && needles.every((needle) => !printed.includes(needle)), 'no output of the runner holds the key or a decoy');
  const all = mock.watchReport();
  t.check(all.scanned > watched.scanned && all.hits.length === 0, 'and no model request of the second run either', JSON.stringify(all));
});
