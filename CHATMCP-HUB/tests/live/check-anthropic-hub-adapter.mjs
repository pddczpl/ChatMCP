// check-anthropic-hub-adapter.mjs - the SECOND Anthropic check: the questions of the first one, asked through the Hub's OWN code. Run by the owner against the REAL Anthropic API
// (it needs a key and spends a few cents), so CI never runs it against the real API; tests/verify-live-checks.mjs runs it in CI, offline and with no key, against stand-ins for the API,
// so that it cannot rot, and checks that it reports a Hub defect.
//
//   node CHATMCP-HUB/tests/live/check-anthropic-hub-adapter.mjs [--model <id>] [--mode json|stream|both] [--effort auto|low|medium|high|xhigh|max]
//                                        [--hub <folder CHATMCP-HUB>] [--base-url <url>] [--tries <n>] [--no-tamper] [--dry-run]
//
// On record: 2026-10-25, claude-sonnet-5-5, the owner's account, Hub 3.10.1, JSON and stream, 14 requests: every scenario behaved as the Hub promises (docs/ARCHITECTURE.md,
// "Khối suy luận của Anthropic (prov-18)"). The model thought only in the first request of each mode, so one replay per mode was exercised.
//
// The first check (check-anthropic-thinking.mjs) sent hand-made requests, so it proved what the API does, not what the HUB does. This one builds a real
// GatewayProvider from the Hub's source (lib/gateway-provider.mjs, lib/standard-adapter.mjs, lib/anthropic-api.mjs, lib/thinking-blocks.mjs) and lets
// it talk to the real API, with a fetch that only WATCHES (status, thinking blocks in the body, request id) and never changes a request - except in
// scenario C, where it edits one request on purpose. The key is read from ANTHROPIC_API_KEY (x-api-key) or ANTHROPIC_AUTH_TOKEN (bearer) and is
// scrubbed from everything this script writes.
//
// Per mode (JSON, and STREAM, which is what the Hub uses while the agent shows text as it arrives) it asks:
//   [1] A first request: a question that needs a tool call. The Hub keeps the thinking blocks of the answer (if the model thought) and ties them to
//       the request they came from. (Tried up to --tries times: the model decides whether to think.)
//   [A] The tool loop: the Hub sends the tool result back WITH the blocks. Expect HTTP 200 on the first try with the same blocks the API issued.
//       This is the question the first check could not answer: does the API read "the same conversation" the way the Hub's digest does?
//   [B] The conversation changes before the blocks would go back (the system prompt differs, as after a compaction). Expect: the Hub sends NO
//       blocks (part a) and the API answers 200 at once.
//   [C] The Hub is sure the conversation is unchanged, but the API is not: this script edits that one request after the Hub built it. Expect: the
//       API answers 400 "bound to a different conversation", the Hub repeats the request once WITHOUT the blocks (part c), the repeat gets 200, and
//       the next round sends no blocks (the Hub remembers).
// Every HTTP request is printed with its status. About 12-20 short requests, a few cents. If the model never thinks, there is nothing to test.
//
// Exit code: 0 = every scenario that could be run did what the Hub promises; 1 = at least one did NOT (read the PROBLEM lines); 2 = could not
// decide (key refused, model never thought, API busy); 3 = no key or the Hub folder was not found.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The Hub whose code is tested: the folder this file is in (CHATMCP-HUB/tests/live -> CHATMCP-HUB), or another one with --hub or CHATMCP_HUB_DIR (an installed copy has the same lib folder).
const DEFAULTS = { model: 'claude-sonnet-5-5', baseUrl: 'https://api.anthropic.com', mode: 'both', effort: 'auto', tries: 5, hub: process.env.CHATMCP_HUB_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..') };

function printHelp() {
  console.log([
    'Usage: node CHATMCP-HUB/tests/live/check-anthropic-hub-adapter.mjs [options]',
    '  --model <id>        model to test (default ' + DEFAULTS.model + '; others: claude-opus-5-5, claude-haiku-5-5, claude-fable-5-1)',
    '  --mode json|stream|both   how the Hub asks (default both)',
    '  --effort <level>    the Hub\'s thinking-effort setting: auto sends nothing (default), or low, medium, high, xhigh, max',
    '  --hub <folder>      the CHATMCP-HUB folder whose code is tested (default ' + DEFAULTS.hub + ';',
    '                      the environment variable CHATMCP_HUB_DIR also works; an installed copy has the same lib folder)',
    '  --base-url <url>    API base (default ' + DEFAULTS.baseUrl + ')',
    '  --tries <n>         how many times the first request is repeated until the model thinks (default ' + DEFAULTS.tries + ')',
    '  --no-tamper         skip scenario C (the one that edits a request on purpose)',
    '  --dry-run           print what would be asked and send nothing; needs no key',
    '  --help',
    '',
    'The key comes from ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN). In PowerShell, for this window only:',
    '  $env:ANTHROPIC_API_KEY = "<your key>"',
    '  node CHATMCP-HUB/tests/live/check-anthropic-hub-adapter.mjs',
    '  Remove-Item Env:ANTHROPIC_API_KEY',
  ].join('\n'));
}

function fail(message, code = 3) {
  console.error('ERROR: ' + message);
  process.exit(code);
}

const options = { ...DEFAULTS, tamper: true, dryRun: false };
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) fail(a + ' needs a value');
      i += 1;
      return argv[i];
    };
    if (a === '--model') options.model = next();
    else if (a === '--mode') options.mode = next();
    else if (a === '--effort') options.effort = next();
    else if (a === '--hub') options.hub = next();
    else if (a === '--base-url') options.baseUrl = next();
    else if (a === '--tries') options.tries = Number(next());
    else if (a === '--no-tamper') options.tamper = false;
    else if (a === '--dry-run') options.dryRun = true;
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else fail('unknown option ' + a + ' (try --help)');
  }
  if (!['json', 'stream', 'both'].includes(options.mode)) fail('--mode must be json, stream or both');
  if (!Number.isInteger(options.tries) || options.tries < 1 || options.tries > 10) fail('--tries must be a whole number from 1 to 10');
}

const token = process.env.ANTHROPIC_AUTH_TOKEN || '';
const apiKey = process.env.ANTHROPIC_API_KEY || '';
const secret = token || apiKey;

// everything printed goes through scrub(): the key itself and anything shaped like an Anthropic key become [key]
function scrub(value) {
  let text = String(value);
  if (secret) text = text.split(secret).join('[key]');
  return text.replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, '[key]');
}
const out = (line = '') => console.log(scrub(line));
const clip = (text, n) => {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > n ? flat.slice(0, n - 3) + '...' : flat;
};

// ---- the conversation ------------------------------------------------------------------------------------------------------------
const TOOLS = [{ name: 'get_weather', description: 'Get the weather forecast for a city.', parameters: { type: 'object', properties: { city: { type: 'string', description: 'City name' } }, required: ['city'] } }];
const SYSTEM = 'You are a careful assistant. Use the tools you are given instead of guessing, and think before you act.';
const SYSTEM_CHANGED = SYSTEM + '\nNote: the project folder was renamed since the last step.';
const TAMPER_SUFFIX = ' [edited by the live check]';
const PROMPTS = [
  'Compare Hanoi and Da Nang for a weekend trip and decide which one to visit. Think carefully about what you need to know, then call the get_weather tool for Hanoi first, and after you have it call it for Da Nang.',
  'I am deciding whether to bring an umbrella to Hanoi tomorrow. Think it through, then call the get_weather tool for Hanoi before you answer.',
  'Plan tomorrow in Hanoi and Hue: first work out what you need to know, then call get_weather for Hanoi, and after you have it call it for Hue, then give one sentence of advice.',
];
const userItem = (text) => ({ role: 'user', content: [{ type: 'input_text', text }] });
const weatherFor = (city) => (/hanoi/i.test(city) ? 'Light rain, 24 C, 80 percent chance of rain tomorrow.' : 'Sunny, 31 C, 10 percent chance of rain tomorrow.');
const cityOf = (call) => { try { return String(JSON.parse(call.arguments).city ?? '?'); } catch { return '?'; } };
const resultItem = (call) => ({ type: 'function_call_output', call_id: call.call_id, output: weatherFor(cityOf(call)) });
const callsOf = (answer) => (answer?.output ?? []).filter((item) => item.type === 'function_call');
const isThinking = (block) => block && (block.type === 'thinking' || block.type === 'redacted_thinking');
const fingerprint = (block) => crypto.createHash('sha256').update(String(block.signature ?? block.data ?? '')).digest('hex').slice(0, 8);
const issuedOf = (answer) => (Array.isArray(answer?.output?.[0]?.providerBlocks) ? answer.output[0].providerBlocks.map(fingerprint) : []);
const blocksIn = (body) => (Array.isArray(body?.messages)
  ? body.messages.flatMap((message) => (Array.isArray(message?.content) ? message.content.filter(isThinking) : []))
  : []);

// ---- dry run -----------------------------------------------------------------------------------------------------------------------
if (options.dryRun) {
  out('Dry run: nothing is sent, no key is needed.');
  out('model ' + options.model + ' at ' + options.baseUrl + ', modes: ' + (options.mode === 'both' ? 'json, stream' : options.mode) + ', Hub code from ' + options.hub);
  out('Per mode: [1] a first request that needs get_weather (tried up to ' + options.tries + ' times until the model thinks); [A] the tool loop, up to 3 more requests; [B] one request after the system prompt changed;'
    + (options.tamper ? ' [C] one request edited on purpose (the API should answer 400), its repeat, and the next round.' : ' [C] skipped (--no-tamper).'));
  out('The system prompt is: ' + SYSTEM);
  PROMPTS.forEach((prompt, i) => out('first-request prompt ' + (i + 1) + ': ' + prompt));
  process.exit(0);
}

if (!secret) {
  console.error('ERROR: no key found. Set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) in this window first, or use --dry-run.');
  printHelp();
  process.exit(3);
}
const providerFile = path.join(options.hub, 'lib', 'gateway-provider.mjs');
if (!fs.existsSync(providerFile)) {
  console.error('ERROR: the Hub code was not found at ' + providerFile + '. Use --hub <the CHATMCP-HUB folder> (a checkout, or the installed copy under %LOCALAPPDATA%\\Programs\\ChatMCP).');
  process.exit(3);
}
let hubVersion = '?';
try { hubVersion = JSON.parse(fs.readFileSync(path.join(options.hub, 'package.json'), 'utf8')).version; } catch { /* the version is only shown */ }
let GatewayProvider;
try {
  ({ GatewayProvider } = await import(pathToFileURL(providerFile).href));
} catch (error) {
  console.error('ERROR: the Hub code could not be loaded from ' + providerFile + ': ' + scrub(error && error.message ? error.message : error));
  process.exit(3);
}

// ---- watching the wire --------------------------------------------------------------------------------------------------------------
const requestIds = [];
const realFetch = globalThis.fetch;

/** A fetch for ONE provider: it passes every request on unchanged and records what the Hub sent and what came back; only `tamperNext` edits one request. */
function makeTransport() {
  const state = { entries: [], tamperNext: false };
  const watching = async (url, init = {}) => {
    let body = null;
    try { body = typeof init.body === 'string' ? JSON.parse(init.body) : null; } catch { body = null; }
    const blocks = blocksIn(body);
    let sentBody = init.body;
    let edited = false;
    if (state.tamperNext && blocks.length > 0 && body && Array.isArray(body.system) && body.system[0] && typeof body.system[0].text === 'string') {
      const copy = structuredClone(body);
      copy.system[0].text += TAMPER_SUFFIX;
      sentBody = JSON.stringify(copy);
      edited = true;
      state.tamperNext = false;
    }
    const entry = { n: 0, status: 0, seconds: '0.0', blocks: blocks.length, fingerprints: blocks.map(fingerprint), edited, stream: body?.stream === true, error: '', requestId: null };
    const started = Date.now();
    let response;
    try {
      response = await realFetch(url, { ...init, body: sentBody });
    } catch (error) {
      entry.seconds = ((Date.now() - started) / 1000).toFixed(1);
      entry.error = 'network error: ' + scrub(error && error.message ? error.message : error);
      state.entries.push(entry);
      entry.n = state.entries.length;
      printAttempt(entry);
      throw error;
    }
    entry.status = response.status;
    entry.seconds = ((Date.now() - started) / 1000).toFixed(1);
    entry.requestId = response.headers.get('request-id');
    if (entry.requestId) requestIds.push(entry.requestId);
    if (!response.ok) {
      try {
        const text = await response.clone().text();
        let message = text;
        try { message = JSON.parse(text)?.error?.message ?? text; } catch { /* plain text */ }
        entry.error = clip(scrub(message), 420);
      } catch { entry.error = '(the error text could not be read)'; }
    }
    state.entries.push(entry);
    entry.n = state.entries.length;
    printAttempt(entry);
    return response;
  };
  return { state, fetch: watching };
}

function printAttempt(entry) {
  const sent = entry.blocks ? entry.blocks + ' thinking block(s) sent [' + entry.fingerprints.join(',') + ']' : 'no thinking blocks sent';
  const flags = (entry.stream ? ' | stream' : '') + (entry.edited ? ' | THIS REQUEST WAS EDITED ON PURPOSE by the script' : '');
  if (entry.status === 0) out('      HTTP request: NO ANSWER (' + entry.error + ') | ' + sent + flags);
  else out('      HTTP request: HTTP ' + entry.status + ' in ' + entry.seconds + ' s ' + (entry.status < 400 ? 'OK' : 'REJECTED') + ' | ' + sent + flags + (entry.error ? '\n        reason from the API: ' + entry.error : ''));
}

function makeProvider(transport) {
  const unused = path.join(os.tmpdir(), 'chatmcp-live-check-unused');
  const base = new GatewayProvider({ directory: unused, bundleRoot: os.tmpdir(), manager: { secrets: [] }, env: {}, fetchImpl: transport.fetch });
  return base.forkForTask({
    protocol: 'anthropic', apiBaseUrl: options.baseUrl, model: options.model, apiKey: secret, authMode: token ? 'bearer' : 'auto', reasoningEffort: options.effort,
  });
}

/** One model step through the Hub's provider. Never throws: the outcome says what happened. */
async function ask(provider, transport, input, instructions, stream) {
  const before = transport.state.entries.length;
  const notes = [];
  try {
    const answer = await provider.respond({
      input, instructions, tools: TOOLS, maxOutputTokens: 4096, signal: AbortSignal.timeout(300000),
      onStatus: async (text) => { notes.push(String(text)); },
      ...(stream ? { onToken: () => {} } : {}),
    });
    const attempts = transport.state.entries.slice(before);
    out('      answer: ' + describeAnswer(answer) + (attempts.length > 1 ? ' | the Hub needed ' + attempts.length + ' HTTP requests for this step' : ''));
    for (const note of notes) out('      the Hub tells the user: ' + clip(note, 360));
    return { ok: true, answer, attempts, notes };
  } catch (error) {
    const attempts = transport.state.entries.slice(before);
    out('      the Hub raised an error: ' + clip(scrub((error && error.code ? '[' + error.code + '] ' : '') + (error && error.message ? error.message : error)), 420));
    for (const note of notes) out('      the Hub tells the user: ' + clip(note, 360));
    return { ok: false, error, attempts, notes };
  }
}
function describeAnswer(answer) {
  const kinds = (answer.output || []).map((item) => (item.type === 'function_call' ? 'call ' + item.name + '(' + cityOf(item) + ')' : item.type)).join(', ') || '(nothing)';
  const kept = issuedOf(answer);
  return kinds + ' | thinking blocks kept by the Hub: ' + (kept.length ? kept.length + ' [' + kept.join(',') + '], tied to this request' : 'none');
}
const fatalStatus = (attempts) => attempts.find((a) => [401, 403, 404].includes(a.status));
const busyStatus = (attempts) => attempts.find((a) => a.status === 0 || a.status === 429 || a.status >= 500);
const lastStatus = (attempts) => (attempts.length ? attempts[attempts.length - 1].status : 0);

// ---- the judges: what each scenario must show ----------------------------------------------------------------------------------------
const verdict = (kind, text) => ({ kind, text });

/** [A] and the later rounds: the blocks of the answer before go back, unchanged, at once. */
function judgeReplay(result, issued) {
  if (!result.ok) return verdict('problem', 'the Hub raised an error instead of answering.');
  const carried = result.attempts.find((a) => a.blocks > 0);
  const end = lastStatus(result.attempts);
  if (issued.length === 0) {
    if (carried) return verdict('problem', 'the Hub sent thinking blocks although the answer before had none.');
    return end === 200 ? verdict('ok', 'no blocks were issued in the answer before (the model did not think that round), so none were sent; HTTP 200.') : verdict('problem', 'HTTP ' + end + ' with no blocks involved.');
  }
  if (!carried) return verdict('held', 'the Hub held the blocks back although nothing changed in the conversation. Harmless (the model just thinks again), but part a is stricter than it needs to be.');
  if (carried.status !== 200) {
    const recovered = end === 200 && result.attempts.some((a, i) => i > result.attempts.indexOf(carried) && a.blocks === 0 && a.status === 200);
    return verdict('problem', 'the API answered HTTP ' + carried.status + ' to blocks the Hub sent back in an UNCHANGED conversation (' + clip(carried.error, 200) + '). The Hub\'s idea of "the same conversation" differs from the API\'s.'
      + (recovered ? ' The Hub recovered by repeating without the blocks (part c), at the price of one extra request and the blocks from then on.' : ' The Hub did not recover.'));
  }
  const same = carried.fingerprints.join(',') === issued.join(',');
  return same
    ? verdict('ok', 'HTTP 200 on the first try with exactly the ' + issued.length + ' block(s) the API issued [' + issued.join(',') + '].')
    : verdict('problem', 'the blocks sent [' + carried.fingerprints.join(',') + '] are not the ones issued [' + issued.join(',') + '].');
}
/** [B] the conversation changed: no block may go back, and the API must accept the request at once. */
function judgeHeldBack(result) {
  if (!result.ok) return verdict('problem', 'the Hub raised an error instead of answering.');
  const carried = result.attempts.find((a) => a.blocks > 0);
  if (carried) return verdict('problem', 'the Hub sent blocks although the system prompt changed (its digest did not notice); the API answered HTTP ' + carried.status + '.');
  return lastStatus(result.attempts) === 200 ? verdict('ok', 'no block was sent and the API answered HTTP 200 at once.') : verdict('problem', 'no block was sent but the final HTTP status was ' + lastStatus(result.attempts) + '.');
}
/** [C] the API refuses what the Hub vouched for: one repeat without the blocks, accepted. */
function judgeRefusal(result) {
  const edited = result.attempts.find((a) => a.edited);
  if (!edited) return verdict('unknown', 'the script could not edit a request (the Hub sent no blocks), so there was nothing to test.');
  if (edited.status === 200) return verdict('unknown', 'the API accepted the edited request (HTTP 200): it did not notice the edit on this account or model, so the refusal path could not be exercised.');
  if (edited.status !== 400) return verdict('unknown', 'the edited request got HTTP ' + edited.status + ' (' + clip(edited.error, 160) + '), not the 400 this scenario needs.');
  if (!result.ok) return verdict('problem', 'the API refused the blocks (400) and the Hub did NOT recover: it raised an error. Part c did not work against the real API.');
  const index = result.attempts.indexOf(edited);
  const repeat = result.attempts.slice(index + 1).find((a) => a.blocks === 0);
  if (!repeat) return verdict('problem', 'after the 400 the Hub made no repeat without the blocks.');
  if (repeat.status !== 200) return verdict('problem', 'the repeat without the blocks got HTTP ' + repeat.status + ' (' + clip(repeat.error, 160) + ').');
  const again = result.attempts.slice(index + 1).filter((a) => a.blocks > 0);
  if (again.length) return verdict('problem', 'the Hub sent the blocks again after the refusal.');
  return verdict('ok', 'the API answered 400 to the edited request, the Hub repeated it ONCE without the blocks, and the repeat got HTTP 200.');
}
function judgeRemembered(result) {
  if (!result.ok) return verdict('problem', 'the Hub raised an error instead of answering.');
  const carried = result.attempts.find((a) => a.blocks > 0);
  if (carried) return verdict('problem', 'the Hub sent blocks again in the next round although the refusal should be remembered.');
  return lastStatus(result.attempts) === 200 ? verdict('ok', 'the next round sent no blocks (the Hub remembers the refusal for this endpoint and model); HTTP 200.') : verdict('problem', 'the next round got HTTP ' + lastStatus(result.attempts) + '.');
}
function show(v) {
  const label = { ok: 'OK', problem: 'PROBLEM', held: 'NOTE', unknown: 'NOT DECIDED' }[v.kind];
  out('      => ' + label + ': ' + v.text);
  return v;
}

// ---- one mode -----------------------------------------------------------------------------------------------------------------------
async function runMode(mode) {
  const stream = mode === 'stream';
  const results = [];
  const record = (scenario, v) => results.push({ mode, scenario, ...v });
  out('==== mode: ' + (stream ? 'STREAM (what the Hub uses while the agent shows text as it arrives)' : 'JSON (no stream)'));

  // [1] a first request whose answer holds a tool call and thinking blocks
  const transport1 = makeTransport();
  const provider1 = makeProvider(transport1);
  let first = null;
  let sawToolWithoutThinking = false;
  let stopped = null;
  for (let i = 0; i < options.tries && !first && !stopped; i += 1) {
    const prompt = PROMPTS[i % PROMPTS.length];
    out('[1] First request' + (i ? ' (try ' + (i + 1) + ')' : '') + ': ask for a tool call (the model decides whether to think)');
    const input = [userItem(prompt)];
    const r = await ask(provider1, transport1, input, SYSTEM, stream);
    if (!r.ok) {
      if (fatalStatus(r.attempts)) stopped = { fatal: fatalStatus(r.attempts) };
      else if (busyStatus(r.attempts)) stopped = { busy: busyStatus(r.attempts) };
      continue;
    }
    const calls = callsOf(r.answer);
    if (calls.length && issuedOf(r.answer).length) first = { prompt, answer: r.answer, input };
    else if (calls.length) sawToolWithoutThinking = true;
  }
  if (!first) {
    const why = stopped?.fatal ? 'the key or the model was refused (HTTP ' + stopped.fatal.status + ')'
      : stopped?.busy ? 'the API was busy or unreachable (HTTP ' + stopped.busy.status + ')'
        : sawToolWithoutThinking ? 'the model called the tool WITHOUT thinking in every try, so the Hub had no blocks to keep'
          : 'no answer with a tool call and thinking blocks';
    out('      => NOT DECIDED: ' + why + '. Nothing more can be tested in this mode.');
    record('1', verdict('unknown', why));
    return results;
  }
  out('      => OK: the Hub kept ' + issuedOf(first.answer).length + ' thinking block(s) from the answer and tied them to the request.');
  record('1', verdict('ok', 'blocks kept'));

  const firstCalls = callsOf(first.answer);
  const history1 = [...first.input, ...first.answer.output, ...firstCalls.map(resultItem)];

  // [A] the tool loop
  out('[A] The tool loop: the Hub sends each tool result back together with the blocks of the answer before it');
  {
    const transport = makeTransport();
    const provider = makeProvider(transport);
    let history = history1;
    let previous = first.answer;
    for (let round = 2; round <= 4; round += 1) {
      const calls = callsOf(previous);
      if (!calls.length) break;
      if (round > 2) history = [...history, ...calls.map(resultItem)];
      const issued = issuedOf(previous);
      out('    round ' + round + ': tool result(s) for ' + calls.map((c) => c.name + '(' + cityOf(c) + ')').join(', ') + ' go back; blocks issued by the answer before: ' + issued.length);
      const r = await ask(provider, transport, history, SYSTEM, stream);
      const v = show(judgeReplay(r, issued));
      record('A round ' + round, v);
      if (!r.ok) break;
      history = [...history, ...r.answer.output];
      previous = r.answer;
    }
  }

  // [B] the conversation changes
  out('[B] The conversation changes before the blocks would go back (the system prompt differs, as it does after a compaction)');
  {
    const transport = makeTransport();
    const provider = makeProvider(transport);
    const r = await ask(provider, transport, history1, SYSTEM_CHANGED, stream);
    record('B', show(judgeHeldBack(r)));
  }

  // [C] the API refuses what the Hub vouched for
  if (options.tamper) {
    out('[C] The Hub is sure nothing changed, the API disagrees (this script edits ONE request after the Hub built it)');
    const transport = makeTransport();
    const provider = makeProvider(transport);
    transport.state.tamperNext = true;
    const r = await ask(provider, transport, history1, SYSTEM, stream);
    const v = show(judgeRefusal(r));
    record('C', v);
    if (v.kind === 'ok') {
      const calls = callsOf(r.answer);
      if (calls.length) {
        out('    next round on the same provider: does the Hub remember?');
        const history2 = [...history1, ...r.answer.output, ...calls.map(resultItem)];
        const next = await ask(provider, transport, history2, SYSTEM, stream);
        record('C remembered', show(judgeRemembered(next)));
      } else {
        out('      (the answer after the repeat had no tool call, so the "remembers" step was not run)');
        record('C remembered', verdict('unknown', 'no further tool round'));
      }
    }
  }
  return results;
}

// ---- the experiment ------------------------------------------------------------------------------------------------------------------
// It RETURNS the exit code: calling process.exit() while fetch connections are still closing makes Node on Windows abort with a libuv assertion, so the code is
// set on process.exitCode and the process ends by itself.
async function experiment() {
  out('== Anthropic check 2: the Hub\'s own code against the real API');
  out('Hub code: ' + options.hub + ' (version ' + hubVersion + ') | model: ' + options.model + ' | endpoint: ' + options.baseUrl + ' | effort: ' + options.effort);
  out('Short requests, billed at the model\'s normal rates (a few cents). The key (' + (token ? 'ANTHROPIC_AUTH_TOKEN' : 'ANTHROPIC_API_KEY') + ') is never printed.');
  out();
  const modes = options.mode === 'both' ? ['json', 'stream'] : [options.mode];
  const all = [];
  for (const mode of modes) {
    all.push(...await runMode(mode));
    out();
  }

  out('== Reading');
  const real = all.filter((entry) => entry.scenario !== '1');
  const decided = real.filter((entry) => entry.kind !== 'unknown');
  const problems = real.filter((entry) => entry.kind === 'problem');
  const notes = real.filter((entry) => entry.kind === 'held');
  const byScenario = (name) => real.filter((entry) => (name === 'A' ? entry.scenario.startsWith('A round') : entry.scenario === name));
  const line = (title, entries, goodText) => {
    if (!entries.length) { out(title + ': not run.'); return; }
    const bad = entries.filter((e) => e.kind === 'problem');
    const open = entries.filter((e) => e.kind === 'unknown');
    if (bad.length) out(title + ': PROBLEM in ' + bad.map((e) => e.mode + ' ' + e.scenario).join('; ') + '.');
    else if (open.length === entries.length) out(title + ': not decided (' + open[0].text + ').');
    else out(title + ': OK in ' + entries.filter((e) => e.kind !== 'unknown').map((e) => e.mode + (e.scenario.startsWith('A round') ? ' ' + e.scenario.slice(2) : '')).join(', ') + '. ' + goodText);
  };
  line('[A] tool loop', byScenario('A'), 'The API read "the same conversation" the way the Hub\'s digest does: the blocks go back and are accepted.');
  line('[B] conversation changed', byScenario('B'), 'The Hub keeps the blocks home, so a compaction does not cause a 400 (part a).');
  line('[C] API refuses the blocks', byScenario('C'), 'The Hub recovers with one repeat (part c) against the real 400 text.');
  line('[C] remembered', byScenario('C remembered'), 'Later rounds do not retry the blocks.');
  for (const note of notes) out('NOTE (' + note.mode + ' ' + note.scenario + '): ' + note.text);
  for (const problem of problems) out('PROBLEM (' + problem.mode + ' ' + problem.scenario + '): ' + problem.text);

  out();
  let code;
  if (!decided.length) {
    out('RESULT: nothing could be decided (see the NOT DECIDED lines above): the model did not think, the key was refused, or the API was busy. Run it again, or try --model with another id.');
    code = 2;
  } else if (problems.length) {
    out('RESULT: at least one scenario did NOT behave as the Hub promises (' + problems.length + ' PROBLEM line(s) above). Send this whole output to the person who maintains the Hub.');
    code = 1;
  } else {
    out('RESULT: every scenario that could be run behaved as the Hub promises (' + decided.length + ' decided, ' + (real.length - decided.length) + ' not decided). '
      + 'For ' + options.model + ' this matches the evidence recorded in docs/ARCHITECTURE.md (thinking blocks, prov-18); it says nothing about other models.');
    code = 0;
  }
  if (requestIds.length) out('request ids (give them to Anthropic support if something looks wrong): ' + requestIds.join(' '));
  return code;
}

process.exitCode = await experiment();
