// check-anthropic-thinking.mjs - the "Anthropic check" of the DatGold roadmap, in one command. Run by the owner against the REAL Anthropic API: CI never runs it (it needs a
// key and spends a few cents); tests/verify-live-checks.mjs checks, offline and with no key, that it still works.
//
//   node CHATMCP-HUB/tests/live/check-anthropic-thinking.mjs [--model <id>] [--thinking default|adaptive] [--api-version <v>] [--base-url <url>] [--dry-run]
//
// On record: 2026-10-25, claude-sonnet-5-5, the owner's account: step 3 = 200 (a tool_use turn needs no thinking block), step 4 = 400 "bound to a different conversation",
// step 5 = 200 with thinking_dropped (docs/ARCHITECTURE.md, "Khối suy luận của Anthropic (prov-18)"). Run it again for another model, or when Anthropic changes its rules.
// It sends hand-made requests, so it says what the API does; tests/live/check-anthropic-hub-adapter.mjs asks what the HUB does, through the Hub's own code.
//
// The key is read from the environment: ANTHROPIC_API_KEY (sent as x-api-key) or ANTHROPIC_AUTH_TOKEN (sent as a bearer token; when both are
// set only the token is sent). It is never printed: it is scrubbed from everything this script writes.
//
// What it asks Anthropic, in five short requests (HTTP status printed for every one):
//   1. A turn that calls a tool, so that the answer holds a thinking block and a tool_use block.
//   2. CONTROL: the same turn sent back WITH its thinking block (what the Hub does when it can). Expect 200.
//   3. THE CHECK: the same turn sent back WITHOUT its thinking block. 200 = the block is not required (the rest of prov-19 can be dropped);
//      400 = a tool_use turn needs its block (prov-19 part b becomes needed).
//   4. The first user message edited, the thinking block replayed: tells whether this account enforces the "prefix binding" check (a 400 that
//      says the block is bound to a different conversation) or not (200).
//   5. Like 4, with thinking.block_binding.prefix_mismatch_behavior = "drop_block" and the beta header thinking-binding-controls-2026-08-01:
//      tells whether the API can drop a stale block itself (200 and a thinking_dropped entry) - the thing prov-19 part b would send.
// If the control (2) is not 200 the later answers mean nothing and the script says so. Costs a few cents.

const DEFAULTS = { model: 'claude-sonnet-5-5', apiVersion: '2023-06-01', baseUrl: 'https://api.anthropic.com', thinking: 'default' };
const BETA = 'thinking-binding-controls-2026-08-01';
const TIMEOUT_MS = 120000;

function printHelp() {
  console.log([
    'Usage: node CHATMCP-HUB/tests/live/check-anthropic-thinking.mjs [options]',
    '  --model <id>             model to test (default ' + DEFAULTS.model + '; others: claude-opus-5-5, claude-haiku-5-5, claude-fable-5-1)',
    '  --thinking default|adaptive  default sends no thinking field, as the Hub does; adaptive sends {"type":"adaptive"} (default: default;',
    '                           if the model does not think without it, adaptive is tried automatically)',
    '  --api-version <v>        anthropic-version header (default ' + DEFAULTS.apiVersion + ', the one the Hub sends)',
    '  --base-url <url>         API base (default ' + DEFAULTS.baseUrl + ')',
    '  --dry-run                print the five request bodies (with a made-up thinking block) and send nothing; needs no key',
    '  --help',
    '',
    'The key comes from ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN). In PowerShell, for this window only:',
    '  $env:ANTHROPIC_API_KEY = "<your key>"',
    '  node CHATMCP-HUB/tests/live/check-anthropic-thinking.mjs',
    '  Remove-Item Env:ANTHROPIC_API_KEY',
  ].join('\n'));
}

function fail(message, code = 3) {
  console.error('ERROR: ' + message);
  process.exit(code);
}

const options = { ...DEFAULTS, dryRun: false };
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
    else if (a === '--thinking') options.thinking = next();
    else if (a === '--api-version') options.apiVersion = next();
    else if (a === '--base-url') options.baseUrl = next();
    else if (a === '--dry-run') options.dryRun = true;
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else fail('unknown option ' + a + ' (try --help)');
  }
  if (!['default', 'adaptive'].includes(options.thinking)) fail('--thinking must be default or adaptive');
}

const token = process.env.ANTHROPIC_AUTH_TOKEN || '';
const apiKey = process.env.ANTHROPIC_API_KEY || '';
const secret = token || apiKey;
if (!secret && !options.dryRun) {
  console.error('ERROR: no key found. Set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) in this window first, or use --dry-run.');
  printHelp();
  process.exit(3);
}

// everything printed goes through scrub(): the key itself and anything shaped like an Anthropic key become [key]
function scrub(value) {
  let text = String(value);
  if (secret) text = text.split(secret).join('[key]');
  return text.replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, '[key]');
}
const say = (line = '') => console.log(scrub(line));
const clip = (text, n) => {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > n ? flat.slice(0, n - 3) + '...' : flat;
};

const endpoint = options.baseUrl.replace(/\/+$/, '') + '/v1/messages';
const requestIds = [];

async function send(body, { beta = null } = {}) {
  const headers = { 'content-type': 'application/json', 'anthropic-version': options.apiVersion };
  if (token) headers.authorization = 'Bearer ' + token;
  else headers['x-api-key'] = apiKey;
  if (beta) headers['anthropic-beta'] = beta;
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response;
  let text;
  try {
    response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
    text = await response.text();
  } catch (error) {
    return { status: 0, networkError: scrub(error && error.message ? error.message : error), seconds: ((Date.now() - started) / 1000).toFixed(1) };
  } finally {
    clearTimeout(timer);
  }
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  const requestId = response.headers.get('request-id') || (json && json.request_id) || null;
  if (requestId) requestIds.push(requestId);
  return { status: response.status, json, text: scrub(text), requestId, seconds: ((Date.now() - started) / 1000).toFixed(1) };
}

// ---- the conversation ------------------------------------------------------------------------------------------------------------
const TOOL = {
  name: 'get_weather',
  description: 'Get the weather forecast for a city.',
  input_schema: { type: 'object', properties: { city: { type: 'string', description: 'City name' } }, required: ['city'] },
};
const PROMPT_1 = 'I am deciding whether to bring an umbrella to Hanoi tomorrow. Think it through, then call the get_weather tool for Hanoi before you answer.';
const PROMPT_2 = 'Compare Hanoi and Da Nang for a weekend trip and decide which one to visit. Think carefully about what you need to know, then call the get_weather tool for Hanoi first.';
const EDIT = ' Please answer in one short sentence.';
const isThinking = (block) => block && (block.type === 'thinking' || block.type === 'redacted_thinking');

function bodyOf(messages, thinking, maxTokens) {
  const body = { model: options.model, max_tokens: maxTokens, tools: [TOOL], messages };
  if (thinking) body.thinking = thinking;
  return body;
}
function followUp(prompt, assistantContent) {
  const results = assistantContent
    .filter((block) => block.type === 'tool_use')
    .map((block) => ({ type: 'tool_result', tool_use_id: block.id, content: 'Light rain, 24 C, 80 percent chance of rain tomorrow.' }));
  return [
    { role: 'user', content: prompt },
    { role: 'assistant', content: assistantContent },
    { role: 'user', content: results },
  ];
}

// ---- reporting -------------------------------------------------------------------------------------------------------------------
function describe(result) {
  if (result.status === 0) return 'NO ANSWER (network error: ' + result.networkError + ')';
  const head = 'HTTP ' + result.status + ' in ' + result.seconds + ' s';
  if (result.status === 200 && result.json) {
    const types = (result.json.content || []).map((block) => block.type).join(', ') || '(no blocks)';
    const usage = result.json.usage ? ' | tokens in/out: ' + result.json.usage.input_tokens + '/' + result.json.usage.output_tokens : '';
    const changes = Array.isArray(result.json.input_transformations) ? result.json.input_transformations : null;
    const changeText = changes === null ? '' : ' | input_transformations: ' + (changes.length === 0 ? '[] (nothing dropped)'
      : changes.map((entry) => entry.type + ' ' + (entry.path || '') + ' ' + (entry.reason || '')).join('; '));
    return head + ' OK | blocks: ' + types + ' | stop_reason: ' + result.json.stop_reason + usage + changeText;
  }
  const error = result.json && result.json.error;
  const kind = error && error.type ? error.type : 'error';
  const message = error && error.message ? error.message : result.text;
  return head + ' REJECTED | ' + kind + ': ' + clip(message, 420);
}
function stepLine(n, title, result) {
  say('[' + n + '/5] ' + title);
  say('      -> ' + describe(result));
}
const errorText = (result) => (result.json && result.json.error && result.json.error.message) || result.text || '';

// ---- dry run ----------------------------------------------------------------------------------------------------------------------
if (options.dryRun) {
  const fake = [
    { type: 'thinking', thinking: '', signature: 'DRY-RUN-SIGNATURE' },
    { type: 'tool_use', id: 'toolu_dry_run', name: 'get_weather', input: { city: 'Hanoi' } },
  ];
  const adaptive = { type: 'adaptive' };
  const dropping = { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } };
  const show = (n, title, body, beta) => {
    say('--- request ' + n + ': ' + title);
    say('POST ' + endpoint + '  (anthropic-version: ' + options.apiVersion + (beta ? ', anthropic-beta: ' + beta : '') + ', key header: ' + (token ? 'authorization: Bearer [key]' : 'x-api-key: [key]') + ')');
    say(JSON.stringify(body, null, 2));
  };
  show(1, 'ask for a tool call', bodyOf([{ role: 'user', content: PROMPT_1 }], null, 4096), null);
  show(2, 'CONTROL, with the thinking block', bodyOf(followUp(PROMPT_1, fake), null, 2048), null);
  show(3, 'THE CHECK, without the thinking block', bodyOf(followUp(PROMPT_1, fake.filter((b) => !isThinking(b))), null, 2048), null);
  show(4, 'edited first message, block replayed', bodyOf(followUp(PROMPT_1 + EDIT, fake), null, 2048), null);
  show(5, 'edited first message, drop_block and the beta header', bodyOf(followUp(PROMPT_1 + EDIT, fake), dropping, 2048), BETA);
  say('(dry run: nothing was sent; a real thinking block carries a long signature that the API recognises)');
  void adaptive;
  process.exit(0);
}

// ---- the experiment ---------------------------------------------------------------------------------------------------------------
// The experiment is a function that RETURNS the exit code: calling process.exit() while fetch connections are still closing makes Node on Windows
// abort with a libuv assertion (exit code 3221226505), so the code is set on process.exitCode and the process ends by itself.
async function experiment() {
say('== Anthropic check: is a tool_use turn accepted WITHOUT its thinking block?');
say('model: ' + options.model + ' | anthropic-version: ' + options.apiVersion + ' | endpoint: ' + endpoint);
say('Five short requests, billed at the model\'s normal rates (a few cents). The key (' + (token ? 'ANTHROPIC_AUTH_TOKEN' : 'ANTHROPIC_API_KEY') + ') is never printed.');
say();

// step 1: get a turn with a thinking block and a tool call; the model may need a nudge to think
const adaptiveField = { type: 'adaptive' };
const attempts = options.thinking === 'adaptive'
  ? [{ thinking: adaptiveField, prompt: PROMPT_1 }, { thinking: adaptiveField, prompt: PROMPT_2 }]
  : [{ thinking: null, prompt: PROMPT_1 }, { thinking: adaptiveField, prompt: PROMPT_1 }, { thinking: adaptiveField, prompt: PROMPT_2 }];
let chosen = null;
let sawToolWithoutThinking = false;
let firstFailure = null;
for (let i = 0; i < attempts.length && !chosen; i += 1) {
  const attempt = attempts[i];
  const label = 'Ask for a tool call, thinking field: ' + (attempt.thinking ? JSON.stringify(attempt.thinking) : '(none, the model\'s default)') + (i > 0 ? ' [attempt ' + (i + 1) + ']' : '');
  const result = await send(bodyOf([{ role: 'user', content: attempt.prompt }], attempt.thinking, 4096));
  stepLine(1, label, result);
  if (result.status === 401 || result.status === 403 || result.status === 404 || result.status === 429 || result.status >= 500 || result.status === 0) {
    firstFailure = result;
    break;
  }
  if (result.status !== 200 || !result.json) {
    if (!firstFailure) firstFailure = result;
    continue;
  }
  const content = result.json.content || [];
  const hasTool = content.some((block) => block.type === 'tool_use');
  const hasThinking = content.some(isThinking);
  if (hasTool && hasThinking) chosen = { content, thinking: attempt.thinking, prompt: attempt.prompt };
  else if (hasTool) sawToolWithoutThinking = true;
}
if (!chosen) {
  say();
  if (firstFailure && (firstFailure.status === 401 || firstFailure.status === 403)) say('INCONCLUSIVE: the key was refused (HTTP ' + firstFailure.status + '). Check the key and that it belongs to the Anthropic API.');
  else if (firstFailure && firstFailure.status === 404) say('INCONCLUSIVE: the model "' + options.model + '" was not found for this key. Try --model with another id.');
  else if (firstFailure && (firstFailure.status === 429 || firstFailure.status >= 500 || firstFailure.status === 0)) say('INCONCLUSIVE: the API was busy or unreachable (HTTP ' + firstFailure.status + '). Run it again later.');
  else if (sawToolWithoutThinking) say('NOTHING TO TEST: this model called the tool WITHOUT a thinking block in every try, so there is no block to leave out. The Hub would send none either. Try another --model.');
  else say('INCONCLUSIVE: no answer with a tool call and a thinking block (see the lines above). Try --model with another id, or --thinking adaptive.');
  if (requestIds.length) say('request ids: ' + requestIds.join(' '));
  return 2;
}
const blocksText =chosen.content.map((block) => block.type).join(', ');
say('      (using this turn: ' + blocksText + ')');

// steps 2-5: the same turn, four ways
const withBlock = followUp(chosen.prompt, chosen.content);
const withoutBlock = followUp(chosen.prompt, chosen.content.filter((block) => !isThinking(block)));
const edited = followUp(chosen.prompt + EDIT, chosen.content);

const r2 = await send(bodyOf(withBlock, chosen.thinking, 2048));
stepLine(2, 'CONTROL: the turn sent back WITH its thinking block (what the Hub does when it can)', r2);
if (r2.status !== 200) {
  say();
  say('INCONCLUSIVE: the control request failed, so the next answers would mean nothing (a wrong request shape, the key or the model, not the thing under test).');
  say('Stopping. Reason from the API: ' + clip(errorText(r2), 300));
  if (requestIds.length) say('request ids: ' + requestIds.join(' '));
  return 2;
}
const r3 = await send(bodyOf(withoutBlock, chosen.thinking, 2048));
stepLine(3, 'THE CHECK: the same turn sent back WITHOUT its thinking block', r3);
const r4 = await send(bodyOf(edited, chosen.thinking, 2048));
stepLine(4, 'Edited first message, thinking block replayed (does this account enforce the prefix binding?)', r4);
const r5 = await send(bodyOf(edited, { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } }, 2048), { beta: BETA });
stepLine(5, 'Edited first message, drop_block + beta header ' + BETA, r5);

// ---- reading ----------------------------------------------------------------------------------------------------------------------
say();
say('== Reading');
let needB = null;
if (r3.status === 200) {
  say('3. WITHOUT the block: ACCEPTED (200). A tool_use turn does not need its thinking block here, so a Hub step that sends no block does not fail.');
  needB = false;
} else if (r3.status === 400) {
  say('3. WITHOUT the block: REJECTED (400): "' + clip(errorText(r3), 260) + '"');
  say('   A tool_use turn needs its thinking block. A Hub step that has to send no block (history shortened) would fail with this.');
  needB = true;
} else {
  say('3. WITHOUT the block: HTTP ' + r3.status + ' - not a clear answer (' + clip(errorText(r3), 200) + '). Run it again.');
}
if (r4.status === 400 && /different conversation|bound to/i.test(errorText(r4))) {
  say('4. Edited history + block: REJECTED (400) "bound to a different conversation": this account ENFORCES the prefix binding. Any edit before a replayed block (for example a compaction) breaks it.');
} else if (r4.status === 200) {
  const listed = Array.isArray(r4.json && r4.json.input_transformations) ? r4.json.input_transformations.length : 0;
  say('4. Edited history + block: ACCEPTED (200): this account does not enforce the prefix binding by default' + (listed ? ' (' + listed + ' entries in input_transformations)' : '') + '.');
} else {
  say('4. Edited history + block: HTTP ' + r4.status + ' - ' + clip(errorText(r4), 240));
}
const dropped = r5.status === 200 && Array.isArray(r5.json && r5.json.input_transformations)
  && r5.json.input_transformations.some((entry) => entry.type === 'thinking_dropped');
if (dropped) say('5. drop_block + beta header: ACCEPTED (200) and the API listed thinking_dropped: it removes a stale block itself, which is what prov-19 part b would ask for.');
else if (r5.status === 200) say('5. drop_block + beta header: ACCEPTED (200) but nothing was dropped (the edited history was not caught, or the account is not on the check yet).');
else say('5. drop_block + beta header: HTTP ' + r5.status + ' - ' + clip(errorText(r5), 240));

say();
if (needB === false) say('RESULT: step 3 returned 200 - no block is required; the rest of prov-19 (part b) can be dropped.');
else if (needB === true && dropped) say('RESULT: step 3 returned 400 and drop_block works (step 5) - prov-19 part b is NEEDED and the API supports it.');
else if (needB === true) say('RESULT: step 3 returned 400 and drop_block did not work here (step 5) - prov-19 part b is needed; read the lines above before building it.');
else say('RESULT: inconclusive for step 3 - run it again.');
if (requestIds.length) say('request ids (give them to Anthropic support if something looks wrong): ' + requestIds.join(' '));
return 0;
}

process.exitCode = await experiment();
