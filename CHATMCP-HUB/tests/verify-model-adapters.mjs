// Model adapters: Anthropic Messages, OpenAI-style Chat Completions, provider presets, model discovery, key storage.
// Everything runs against mock fetch functions, so no API key and no network are needed. What this does NOT prove is that
// a real provider accepts these requests: that needs a key (see docs/TESTING-WITH-REAL-MODELS.md).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GatewayProvider } from '../lib/gateway-provider.mjs';
import { AiProfiles } from '../lib/ai-profiles.mjs';
import { createHubServer } from '../hub.mjs';
import { createProtector } from '../lib/secret-box.mjs';
import { PRESETS, detectEnvKeys, isLoopbackUrl, presetById, presetForBaseUrl, publicPresets, supportsPromptCaching } from '../lib/provider-presets.mjs';
import { compactHistory, estimateTokens, historyBytes, pairToolCalls, safeToolId } from '../lib/model-history.mjs';
import { ANTHROPIC_VERSION, anthropicEndpoint, anthropicHeaders, asAnthropicMessages, buildAnthropicBody, normalizeAnthropic, parseAnthropicModels } from '../lib/anthropic-api.mjs';
import { asChatMessages, buildChatBody, normalizeChatCompletion } from '../lib/openai-chat-api.mjs';
import { backoffMs, classifyHttpError, errorDetail, outputTokenLimit, readBodyText, retryAfterMs, sleep } from '../lib/model-http.mjs';
import { finishModelList, modelsUrl, parseGeminiModels, parseOpenAiModels } from '../lib/model-list.mjs';
import { probeToolCalling } from '../lib/tool-probe.mjs';

const BUNDLE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-adapters-'));
let checks = 0;
const check = (value, label) => { assert.ok(value, label); checks += 1; };
const same = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks += 1; };
const rejects = async (promise, expected, label) => { await assert.rejects(promise, expected, label); checks += 1; };

const KEY = 'sk-test-0123456789abcdefABCDEF';
const userMsg = (text) => ({ role: 'user', content: [{ type: 'input_text', text }] });
const asstMsg = (text, phase = 'final') => ({ type: 'message', role: 'assistant', phase, content: [{ type: 'output_text', text }] });
const call = (id, name = 'read_file', args = { path: 'a.txt' }) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args), status: 'completed' });
const out = (id, output) => ({ type: 'function_call_output', call_id: id, output });
const TOOLS = [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }];
const headerBag = (values) => ({ get: (name) => values[name.toLowerCase()] ?? null });
const reply = (status, body, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: headerBag(headers), async text() { return typeof body === 'string' ? body : JSON.stringify(body); } });
const anthropicOk = (text, extra = {}) => ({ type: 'message', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 3 }, ...extra });
const chatOk = (text) => ({ choices: [{ finish_reason: 'stop', message: { content: text } }], usage: { prompt_tokens: 10, completion_tokens: 3 } });
const neverFetch = async () => { throw new Error('this test must not reach the network'); };

async function makeProvider(name, { fetchImpl = neverFetch, configure, env = {}, limits, platform = 'linux' } = {}) {
  const manager = { secrets: [] };
  const sleeps = [];
  const provider = new GatewayProvider({
    directory: path.join(root, name), bundleRoot: BUNDLE, manager, env, fetchImpl, platform, limits,
    sleep: async (ms, signal) => { sleeps.push(ms); signal?.throwIfAborted(); },
  });
  await provider.load();
  if (configure) await provider.configure(configure);
  return { provider, manager, sleeps, directory: path.join(root, name) };
}

try {
  // ---------------------------------------------------------------------------------------------------------------
  // Conversation helpers
  // ---------------------------------------------------------------------------------------------------------------
  same(safeToolId('toolu_01A-b_c'), 'toolu_01A-b_c', 'a valid tool id is kept');
  const odd = safeToolId('call.with.dots/and spaces');
  check(/^toolu_[0-9a-f]{24}$/.test(odd), 'an invalid tool id becomes a valid one');
  same(safeToolId('call.with.dots/and spaces'), odd, 'the mapping is stable, so a call and its result still match');
  check(/^[a-zA-Z0-9_-]{1,64}$/.test(safeToolId('x'.repeat(200))), 'an over-long id is shortened');

  const original = [userMsg('go'), call('c1'), call('c2'), out('c1', 'ok'), userMsg('again'), out('ghost', 'orphan')];
  const paired = pairToolCalls(original);
  same(paired.map((item) => item.type ?? item.role), ['user', 'function_call', 'function_call', 'function_call_output', 'function_call_output', 'user'], 'an unanswered call gets a result before the next user message; an orphan result is dropped');
  check(paired[4].call_id === 'c2' && /gián đoạn/.test(paired[4].output), 'the missing result says the session was interrupted');
  check(!paired.some((item) => item.call_id === 'ghost'), 'orphan result removed');
  check(paired[1] === original[1], 'untouched items are the same objects');
  same(pairToolCalls([userMsg('x'), call('c1')]).at(-1).type, 'function_call_output', 'a conversation that ends on a call gets its result too');

  const big = 'X'.repeat(60000);
  const convo = [userMsg('Fix the bug')];
  for (let i = 0; i < 8; i += 1) convo.push(call(`c${i}`, 'read_file', { path: `f${i}.js` }), out(`c${i}`, `${big}${i}`));
  convo.push(asstMsg('Reading done', 'commentary'), call('c8'), out('c8', 'latest small result'));
  const before = historyBytes(convo);
  const fit = compactHistory(convo, { maxBytes: 200 * 1024, keepRecent: 4 });
  check(fit.changed && fit.fits && fit.after <= 200 * 1024 && fit.after < before, 'compaction reaches the budget');
  same(historyBytes(fit.history), fit.after, 'the reported size is exact');
  same(fit.history[0], convo[0], 'the user message is never shortened');
  same(fit.history.slice(-4), convo.slice(-4), 'the most recent items are untouched');
  check(/đã rút gọn/.test(fit.history[2].output) && fit.history[2].call_id === 'c0', 'the oldest tool result became a stub that still names its call');
  same(fit.history.map((item) => item.call_id ?? item.role), convo.map((item) => item.call_id ?? item.role), 'calls and results stay paired and in order');
  same(historyBytes(convo), before, 'the full history is not modified');
  const noop = compactHistory(convo, { maxBytes: before + 1 });
  check(!noop.changed && noop.history === convo, 'nothing changes when the history already fits');
  const impossible = compactHistory(convo, { maxBytes: 100, keepRecent: 4 });
  check(impossible.changed && !impossible.fits, 'a budget that cannot be met is reported, not hidden');
  check(estimateTokens({ input: convo, instructions: 'x', tools: TOOLS }) > before / 4, 'token estimate is in the right range');

  // ---------------------------------------------------------------------------------------------------------------
  // Anthropic Messages wire format
  // ---------------------------------------------------------------------------------------------------------------
  same(anthropicEndpoint('https://api.anthropic.com'), 'https://api.anthropic.com/v1/messages');
  same(anthropicEndpoint('https://gw.example.com/v1/'), 'https://gw.example.com/v1/messages', 'a trailing slash does not duplicate /v1');
  same(anthropicHeaders(KEY), { 'Content-Type': 'application/json', 'anthropic-version': ANTHROPIC_VERSION, 'x-api-key': KEY });
  const bearer = anthropicHeaders(KEY, 'bearer');
  check(bearer.Authorization === `Bearer ${KEY}` && !('x-api-key' in bearer), 'bearer mode');
  check(!('x-api-key' in anthropicHeaders('')) && !('Authorization' in anthropicHeaders('')), 'no key, no auth header');

  const thread = [userMsg('List files'), asstMsg('Looking', 'commentary'), call('c1', 'list', { dir: '.' }), call('c2', 'read', { file: 'a' }), out('c1', 'a\nb'), out('c2', [{ type: 'input_text', text: 'content of a' }]), userMsg('Thanks, continue')];
  const messages = asAnthropicMessages(thread);
  same(messages.map((m) => m.role), ['user', 'assistant', 'user'], 'roles alternate');
  same(messages[1].content.map((b) => b.type), ['text', 'tool_use', 'tool_use']);
  same(messages[1].content[1].input, { dir: '.' }, 'arguments are sent as an object');
  same(messages[2].content.map((b) => b.type), ['tool_result', 'tool_result', 'text'], 'tool results come first, then the person\'s new text');
  same([messages[2].content[0].tool_use_id, messages[2].content[1].content], ['c1', 'content of a']);
  same(asAnthropicMessages([userMsg('hi'), asstMsg('   '), userMsg('again')]).map((m) => m.content.length), [2], 'blank assistant text is dropped and same-role messages merge');
  const mapped = asAnthropicMessages([userMsg('x'), call('a.b/c'), out('a.b/c', 'r')]);
  same(mapped[1].content[0].id, mapped[2].content[0].tool_use_id, 'a mapped tool id is used on both sides');

  const body = buildAnthropicBody({ model: 'claude-x', input: thread, instructions: 'SYS', tools: TOOLS, maxOutputTokens: 4096 });
  same([body.model, body.max_tokens], ['claude-x', 4096]);
  same(body.system, [{ type: 'text', text: 'SYS' }]);
  same(body.tools[0], { name: 'read_file', description: 'Read a file', input_schema: TOOLS[0].parameters });
  same(body.tool_choice, { type: 'auto', disable_parallel_tool_use: true });
  check(!JSON.stringify(body).includes('cache_control'), 'no cache markers unless asked');
  const cached = buildAnthropicBody({ model: 'claude-x', input: thread, instructions: 'SYS', tools: TOOLS, promptCaching: true });
  check(cached.system[0].cache_control && cached.tools.at(-1).cache_control && cached.messages.at(-1).content.at(-1).cache_control, 'caching marks the instructions, the tool list and the latest block');
  const plain = buildAnthropicBody({ model: 'm', input: [userMsg('hi')], instructions: 'S' });
  check(!('tools' in plain) && !('tool_choice' in plain), 'no tools, no tool fields');
  same(plain.max_tokens, 16384, 'default output budget');
  same(buildAnthropicBody({ model: 'm', input: [userMsg('x')], instructions: 'S', maxOutputTokens: 10 }).max_tokens, 256, 'a tiny budget is raised to a usable minimum');

  const tooled = normalizeAnthropic({ type: 'message', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'text', text: 'Let me look.' }, { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a.txt' } }], usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 50, cache_read_input_tokens: 10 } });
  same(tooled.output.map((item) => item.type), ['message', 'function_call']);
  same([tooled.output[0].phase, tooled.output[1].call_id, JSON.parse(tooled.output[1].arguments)], ['commentary', 'toolu_1', { path: 'a.txt' }]);
  same(tooled.usage, { input_tokens: 160, output_tokens: 20, cache_read_tokens: 10, cache_creation_tokens: 50 }, 'cached input is counted');
  same(normalizeAnthropic({content:[{type:'text',text:'ok'}],stop_reason:'end_turn'}).usage,
    {input_tokens:null,output_tokens:null,cache_read_tokens:null,cache_creation_tokens:null},
    'missing Anthropic usage is unknown');
  same(normalizeAnthropic(anthropicOk('Done.')).output[0].phase, 'final');
  const cut = normalizeAnthropic({ stop_reason: 'max_tokens', content: [{ type: 'text', text: 'part' }, { type: 'tool_use', id: 't', name: 'write_file', input: {} }], usage: {} });
  same([cut.status, cut.incomplete_details.reason], ['incomplete', 'max_output_tokens']);
  check(!cut.output.some((item) => item.type === 'function_call'), 'a tool call cut off by the limit is never returned');
  const refused = normalizeAnthropic({ stop_reason: 'refusal', content: [{ type: 'text', text: 'No.' }], usage: {} });
  same(refused.output[0].content[0], { type: 'refusal', refusal: 'No.' });
  assert.throws(() => normalizeAnthropic({ type: 'error', error: { message: 'x' } }), { code: 'model_empty' }); checks += 1;
  assert.throws(() => normalizeAnthropic({ content: [{ type: 'tool_use', name: 'x', input: {} }], stop_reason: 'tool_use' }), { code: 'model_invalid_function' }); checks += 1;
  same(parseAnthropicModels({ data: [{ id: 'claude-a', display_name: 'Claude A' }, { nope: 1 }] }), [{ id: 'claude-a', name: 'Claude A' }]);

  // ---------------------------------------------------------------------------------------------------------------
  // OpenAI-style responses are read leniently; truncation is not forgiven
  // ---------------------------------------------------------------------------------------------------------------
  const lenient = normalizeChatCompletion({ choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [
    { function: { name: 'a', arguments: { x: 1 } } },
    { id: 'dup', type: 'function', function: { name: 'b', arguments: '' } },
    { id: 'dup', type: 'function', function: { name: 'c', arguments: '{"y":2}' } },
  ] } }], usage: { prompt_tokens: 5, completion_tokens: 6 } }, { usedCallIds: new Set(['dup']) });
  const ids = lenient.output.map((item) => item.call_id);
  check(new Set(ids).size === 3 && !ids.includes('dup') && ids.every((id) => /^call_[0-9a-f]{24}$/.test(id)), 'missing and repeated ids are replaced by unique ones');
  same(lenient.output.map((item) => item.arguments), ['{"x":1}', '{}', '{"y":2}'], 'object and empty arguments become JSON text');
  same(lenient.usage, { input_tokens: 5, output_tokens: 6, cache_read_tokens: null, reasoning_tokens: null });
  const cachedReasoning=normalizeChatCompletion({choices:[{finish_reason:'stop',message:{content:'ok'}}],usage:{prompt_tokens:200,completion_tokens:40,prompt_tokens_details:{cached_tokens:130},completion_tokens_details:{reasoning_tokens:20}}});
  same(cachedReasoning.usage,{input_tokens:200,output_tokens:40,cache_read_tokens:130,reasoning_tokens:20});
  const missingChat=normalizeChatCompletion({choices:[{finish_reason:'stop',message:{content:'ok'}}]});
  same(missingChat.usage,{input_tokens:null,output_tokens:null,cache_read_tokens:null,reasoning_tokens:null},'missing Chat Completions usage is unknown, never confirmed zero');
  const actualZero=normalizeChatCompletion({choices:[{finish_reason:'stop',message:{content:'ok'}}],usage:{prompt_tokens:0,completion_tokens:0}});
  same([actualZero.usage.input_tokens,actualZero.usage.output_tokens],[0,0],'provider-reported zeros are preserved');
  const partialChat=normalizeChatCompletion({choices:[{finish_reason:'stop',message:{content:'ok'}}],usage:{prompt_tokens:7}});
  same([partialChat.usage.input_tokens,partialChat.usage.output_tokens],[7,null],'partial provider usage remains partial');
  same(normalizeChatCompletion({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'c9', type: 'function', function: { name: 'a', arguments: '{}' } }] } }] }).output[0].call_id, 'c9', 'a good id is kept');
  const truncated = normalizeChatCompletion({ choices: [{ finish_reason: 'length', message: { content: 'part', tool_calls: [{ id: 'x', type: 'function', function: { name: 'w', arguments: '{"a' } }] } }] });
  same([truncated.status, truncated.incomplete_details.reason, truncated.output.length], ['incomplete', 'max_output_tokens', 1]);
  check(!truncated.output.some((item) => item.type === 'function_call'), 'cut-off tool call dropped');
  same(normalizeChatCompletion({ choices: [{ finish_reason: 'content_filter', message: { content: '' } }] }).incomplete_details.reason, 'content_filter');
  same(normalizeChatCompletion({ choices: [{ finish_reason: 'eos', message: { content: 'fine' } }] }).status, 'completed', 'an unusual finish reason with content is accepted');
  same(normalizeChatCompletion({ choices: [{ finish_reason: 'stop', message: { content: null, refusal: 'I cannot help.' } }] }).output[0].content[0].type, 'refusal');
  assert.throws(() => normalizeChatCompletion({ choices: [{ finish_reason: 'stop', message: { content: '' } }] }), { code: 'model_empty' }); checks += 1;
  assert.throws(() => normalizeChatCompletion({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'a', type: 'function', function: { arguments: '{}' } }] } }] }), { code: 'model_invalid_function' }); checks += 1;
  assert.throws(() => normalizeChatCompletion({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'a', type: 'weird', function: { name: 'x', arguments: '{}' } }] } }] }), { code: 'model_invalid_function' }); checks += 1;
  assert.throws(() => normalizeChatCompletion({}), { code: 'model_incomplete' }); checks += 1;
  const thinking = normalizeChatCompletion({ choices: [{ finish_reason: 'tool_calls', message: { content: 'ok', reasoning_content: 'because', tool_calls: [{ id: 'k', type: 'function', function: { name: 'a', arguments: '{}' } }] } }] });
  same(thinking.output.map((item) => item.reasoningContent), ['because', undefined], 'reasoning text travels with the first item');
  const turn = [userMsg('q1'), thinking.output[0], thinking.output[1], out('k', 'r')];
  const sent = asChatMessages(turn, 'SYS');
  same(sent.map((m) => m.role), ['system', 'user', 'assistant', 'tool']);
  same([sent[2].reasoning_content, sent[2].tool_calls.length], ['because', 1], 'reasoning is returned while the turn is in progress');
  check(!asChatMessages([...turn, asstMsg('done'), userMsg('q2')], 'SYS').some((m) => 'reasoning_content' in m), 'and dropped once a new user message starts');
  same(asChatMessages([userMsg('q'), { ...call('c1'), reasoningContent: 'R2' }, out('c1', 'r')], 'S')[2].reasoning_content, 'R2', 'a turn that only calls tools keeps its reasoning too');
  const withTools = buildChatBody({ model: 'm', input: [userMsg('x')], instructions: 'S', tools: TOOLS });
  same([withTools.tool_choice, withTools.stream, withTools.tools[0].function.name], ['auto', false, 'read_file']);
  const noTools = buildChatBody({ model: 'm', input: [userMsg('x')], instructions: 'S', tools: [] });
  check(!('tools' in noTools) && !('tool_choice' in noTools), 'tool_choice is only sent together with tools');

  // ---------------------------------------------------------------------------------------------------------------
  // HTTP helpers and error classification
  // ---------------------------------------------------------------------------------------------------------------
  const NOW = Date.parse('2026-01-01T00:00:00Z');
  same(retryAfterMs(headerBag({ 'retry-after': '7' })), 7000);
  same(retryAfterMs(headerBag({ 'retry-after': 'Thu, 01 Jan 2026 00:00:09 GMT' }), NOW), 9000);
  same(retryAfterMs(headerBag({ 'retry-after': 'Wed, 31 Dec 2025 23:00:00 GMT' }), NOW), 0, 'a date in the past means now');
  same([retryAfterMs(undefined), retryAfterMs(headerBag({})), retryAfterMs(headerBag({ 'retry-after': 'soon' }))], [null, null, null]);
  same([1, 2, 3, 4, 5, 6].map((n) => backoffMs(n, { random: () => 0.5 })), [2000, 4000, 8000, 16000, 30000, 30000], 'exponential, capped');
  check(backoffMs(9, { random: () => 1 }) <= 30000 && backoffMs(1, { random: () => 0 }) === 1600, 'jitter stays within the cap');
  same([8192, 16384, 32768, null], [
    outputTokenLimit('max_tokens: 16384 > 8192, which is the maximum allowed number of output tokens for claude-x'),
    outputTokenLimit('This model supports at most 16384 completion tokens, whereas you provided 99999.'),
    outputTokenLimit('Invalid value. Expected a value <= 32768, but got 50000'),
    outputTokenLimit('something else entirely'),
  ]);
  same([errorDetail({ error: 'plain' }), errorDetail({ error: { message: '  a\n\tb  ' } }), errorDetail({ error: { code: 'x_code' } }), errorDetail({ message: 'top' }), errorDetail(null)], ['plain', 'a b', 'x_code', 'top', '']);
  check(errorDetail({ error: { message: 'y'.repeat(2000) } }).length === 650, 'error text is bounded');

  const redactKey = (text) => text.replaceAll('SECRETKEY', '[REDACTED]');
  const classify = (status, data, headers = {}) => classifyHttpError({ status, data, headers: headerBag(headers), redact: redactKey });
  const cases = [
    [classify(401, { error: { message: 'invalid x-api-key SECRETKEY' } }), 'auth', 'gateway_auth', false],
    [classify(403, {}), 'auth', 'gateway_auth', false],
    [classify(402, {}), 'quota', 'gateway_quota', false],
    [classify(429, { error: { message: 'You exceeded your current quota, please check your plan' } }), 'quota', 'gateway_quota', false],
    [classify(400, { error: { message: 'Your credit balance is too low to access the Anthropic API' } }), 'quota', 'gateway_quota', false],
    [classify(429, { error: { message: 'slow down' } }, { 'retry-after': '3' }), 'rate_limit', 'gateway_rate_limit', true],
    [classify(413, {}), 'context', 'gateway_context_length', false],
    [classify(400, { error: { message: 'prompt is too long: 250000 tokens > 200000 maximum' } }), 'context', 'gateway_context_length', false],
    [classify(400, { error: { message: "This model's maximum context length is 8192 tokens." } }), 'context', 'gateway_context_length', false],
    [classify(400, { error: { message: 'max_tokens: 64000 > 32000, which is the maximum allowed number of output tokens for claude-x' } }), 'max_tokens', 'gateway_http_error', false],
    [classify(404, { error: { type: 'not_found_error', message: 'model: claude-nope' } }), 'model', 'gateway_model_not_found', false],
    [classify(404, { error: { message: 'The model `gpt-9` does not exist or you do not have access to it.', code: 'model_not_found' } }), 'model', 'gateway_model_not_found', false],
    [classify(404, { error: { type: 'not_found_error', message: 'Not Found' } }), 'route', 'gateway_http_error', false],
    [classify(503, {}), 'overloaded', 'gateway_overloaded', true],
    [classify(529, {}), 'overloaded', 'gateway_overloaded', true],
    [classify(500, { error: { message: 'boom' } }), 'server', 'gateway_http_error', true],
    [classify(408, {}), 'server', 'gateway_http_error', true],
    [classify(400, { error: { message: 'messages.1: tool_use ids were found without tool_result blocks' } }), 'request', 'gateway_http_error', false],
  ];
  for (const [info, kind, code, retryable] of cases) same([info.kind, info.code, info.retryable], [kind, code, retryable], `${info.status} ${kind}`);
  check(/đường dẫn/.test(classify(404, { error: { type: 'not_found_error', message: 'Not Found' } }).message), 'an unknown route is reported as a URL problem, not an unknown model');
  check(!classify(401, { error: { message: 'invalid x-api-key SECRETKEY' } }).message.includes('SECRETKEY'), 'provider text is redacted');
  same(classify(429, { error: { message: 'slow' } }, { 'retry-after': '3' }).retryAfterMs, 3000);
  same(classify(400, { error: { message: 'max_tokens: 64000 > 32000, which is the maximum allowed number of output tokens for x' } }).limit, 32000);

  same(await readBodyText(new Response('hello')), 'hello');
  await rejects(readBodyText(new Response('x'.repeat(2000)), 1000), { code: 'gateway_too_large' }, 'a streamed body over the limit is refused');
  await rejects(readBodyText({ async text() { return 'x'.repeat(2000); } }, 1000), { code: 'gateway_too_large' }, 'so is a plain text body');
  const controller = new AbortController();
  const waiting = sleep(60_000, controller.signal);
  controller.abort(new Error('stop waiting'));
  await rejects(waiting, /stop waiting/, 'a wait ends when the run is cancelled');
  await rejects(sleep(10, AbortSignal.abort(new Error('already'))), /already/, 'and does not start when already cancelled');
  await sleep(5); checks += 1;

  // ---------------------------------------------------------------------------------------------------------------
  // Presets
  // ---------------------------------------------------------------------------------------------------------------
  check(PRESETS.length >= 10 && new Set(PRESETS.map((p) => p.id)).size === PRESETS.length, 'preset ids are unique');
  for (const p of PRESETS.filter((entry) => entry.apiBaseUrl)) {
    check(p.apiBaseUrl.startsWith('https://') || isLoopbackUrl(p.apiBaseUrl), `${p.id} uses HTTPS or loopback`);
    check(['anthropic', 'openai-chat', 'openai-responses', 'gemini'].includes(p.protocol), `${p.id} protocol`);
  }
  same(presetForBaseUrl('https://api.anthropic.com/v1/messages')?.id, 'anthropic');
  same(presetForBaseUrl('https://example.com'), null);
  same([isLoopbackUrl('http://localhost:11434/v1'), isLoopbackUrl('http://127.0.0.1:1'), isLoopbackUrl('http://[::1]:1'), isLoopbackUrl('http://10.0.0.5'), isLoopbackUrl('https://localhost.evil.example')], [true, true, true, false, false]);
  same(detectEnvKeys({ ANTHROPIC_API_KEY: ' k ', OPENAI_API_KEY: '', GOOGLE_API_KEY: 'g' }), [{ preset: 'anthropic', env: 'ANTHROPIC_API_KEY' }, { preset: 'gemini', env: 'GOOGLE_API_KEY' }]);
  check(!JSON.stringify(publicPresets({ ANTHROPIC_API_KEY: 'sk-secret-value' })).includes('sk-secret-value'), 'the preset list carries names, never values');
  same(publicPresets({ ANTHROPIC_API_KEY: 'x' }).find((p) => p.id === 'anthropic').envKey, 'ANTHROPIC_API_KEY');

  // Prompt caching (cache_control on the Messages API) is a property of the ENDPOINT, recorded on the preset. It used to be
  // `preset === 'anthropic'`, which no profile fork has, so every profile aimed at api.anthropic.com lost it silently.
  same(presetById('anthropic').promptCaching, true, 'Anthropic accepts cache_control');
  check(PRESETS.filter((entry) => entry.id.startsWith('custom-')).every((entry) => entry.promptCaching === false), 'a custom gateway may reject the field: off by default');
  same(PRESETS.filter((entry) => entry.promptCaching).map((entry) => entry.id), ['anthropic'], 'only presets known to accept it carry the flag');
  for (const later of ['bedrock-mantle', 'vertex-claude', 'foundry']) {
    const entry = presetById(later);
    check(entry === null || entry.promptCaching === true, `${later}: when this preset is added it carries the flag (Claude behind another front door still caches)`);
  }
  same(presetForBaseUrl('https://api.openai.com/v1', 'openai-responses')?.id, 'openai-responses', 'the protocol picks between presets that share an origin');
  same(presetForBaseUrl('https://api.openai.com/v1', 'anthropic'), null, 'and no preset matches an origin with another protocol');
  same(supportsPromptCaching({ apiBaseUrl: 'https://api.anthropic.com', protocol: 'anthropic' }), true, 'a profile has no preset: its origin decides');
  same(supportsPromptCaching({ apiBaseUrl: 'https://api.anthropic.com/v1/', protocol: 'anthropic', preset: 'custom-anthropic' }), true, 'a custom connection aimed at Anthropic itself still caches');
  same(supportsPromptCaching({ apiBaseUrl: 'https://gw.example.com', protocol: 'anthropic', preset: 'custom-anthropic' }), false, 'a custom gateway does not');
  same(supportsPromptCaching({ apiBaseUrl: 'https://api.anthropic.com', protocol: 'openai-chat' }), false, 'cache_control exists only on the Messages API');
  same(supportsPromptCaching({ apiBaseUrl: '', protocol: 'anthropic', preset: 'anthropic' }), true, 'a named preset answers for itself');
  same(supportsPromptCaching({}), false);
  same(publicPresets({}).find((entry) => entry.id === 'anthropic').promptCaching, true, 'Settings can show the capability');

  // ---------------------------------------------------------------------------------------------------------------
  // Configuration: presets, and a key never travels to another host
  // ---------------------------------------------------------------------------------------------------------------
  {
    const { provider, directory } = await makeProvider('config');
    await provider.configure({ preset: 'anthropic', apiKey: KEY });
    const state = provider.state();
    same([state.preset, state.protocol, state.apiBaseUrl, state.model, state.contextWindowTokens, state.agentRequestMode], ['anthropic', 'anthropic', 'https://api.anthropic.com', presetById('anthropic').defaultModel, 200000, 'anthropic-tool-use']);
    same([state.keySource, state.keyRequired, provider.ready()], ['session', true, true]);
    check(!JSON.stringify(state).includes(KEY), 'state never contains the key');
    await assert.rejects(fs.stat(path.join(directory, 'gateway-key.dpapi')), { code: 'ENOENT' }); checks += 1;
    const saved = JSON.parse(await fs.readFile(path.join(directory, 'gateway-config.json'), 'utf8'));
    same([saved.version, saved.preset, saved.protocol, saved.contextWindowTokens], [2, 'anthropic', 'anthropic', 200000]);
    check(!JSON.stringify(saved).includes(KEY), 'the config file never contains the key');

    // another provider without a new key: the old key is NOT carried over
    await provider.configure({ preset: 'openai' });
    same([provider.ready(), provider.state().keySource, provider.state().apiBaseUrl], [false, 'none', 'https://api.openai.com/v1'], 'switching provider drops the key');
    await rejects(provider.respond({ input: [userMsg('x')], instructions: 'S' }), { code: 'gateway_not_ready' }, 'nothing is sent without a key');
    await provider.configure({ preset: 'anthropic', apiKey: KEY });
    await provider.configure({ apiBaseUrl: 'https://evil.example.com' });
    same([provider.ready(), provider.state().preset, provider.state().keySource], [false, 'custom-anthropic', 'none'], 'editing the URL of a provider drops the key and makes it a custom connection');
    await provider.configure({ apiBaseUrl: 'https://gw.example.com', apiKey: KEY, model: 'claude-gw' });
    await provider.configure({ model: 'claude-gw-2' });
    same([provider.ready(), provider.state().keySource, provider.state().model], [true, 'session', 'claude-gw-2'], 'changing only the model keeps the key');

    // validation
    await rejects(provider.configure({ preset: 'nope' }), { code: 'invalid_preset' });
    await rejects(provider.configure({ contextWindowTokens: 5 }), { code: 'invalid_context_window' });
    await rejects(provider.configure({ contextWindowTokens: 'abc' }), { code: 'invalid_context_window' });
    // One bound for every validator (lib/context-window.mjs): below 4,096 the agent cannot even hold its tool schemas, so the value is refused
    // with the range in the message; above 2,000,000 it is clamped, never discarded.
    await rejects(provider.configure({ contextWindowTokens: 3000 }), { code: 'invalid_context_window', message: /4[.,]096.*2[.,]000[.,]000/ }, '3,000 tokens is refused with the allowed range, not silently dropped');
    await rejects(provider.configure({ contextWindowTokens: 4095 }), { code: 'invalid_context_window' }, 'the minimum is 4,096');
    await rejects(provider.configure({ contextWindowTokens: 2000.5 }), { code: 'invalid_context_window' }, 'a fraction of a token is not a window');
    await provider.configure({ contextWindowTokens: 4096 });
    same(provider.state().contextWindowTokens, 4096, '4,096 is accepted');
    await provider.configure({ contextWindowTokens: 5_000_000 });
    same(provider.state().contextWindowTokens, 2_000_000, 'a window above the cap is clamped to it');
    same(provider.validateConfiguration({ contextWindowTokens: 9_999_999_999 }).contextWindowTokens, 2_000_000, 'validation reports the clamped value');
    await provider.configure({ contextWindowTokens: null });
    await rejects(provider.configure({ protocol: 'soap' }), { code: 'invalid_protocol' });
    await rejects(provider.configure({ model: 'has space' }), { code: 'invalid_model' });
    await rejects(provider.configure({ authMode: 'google-key' }), { code: 'invalid_auth_mode' }, 'x-goog-api-key makes no sense for Anthropic');
    await rejects(provider.configure({ apiKey: 'short' }), { code: 'invalid_key' });
    await rejects(provider.configure({ apiBaseUrl: 'http://remote.example.com' }), { code: 'insecure_base_url' }, 'plain HTTP only for localhost');
    await rejects(provider.configure({ remember: true, preset: 'openai', apiBaseUrl: 'https://api.openai.com/v1' }), { code: 'missing_key' }, 'cannot remember a key that was not given');
    same(provider.state().model, 'claude-gw-2', 'a rejected configuration changes nothing');
    await provider.configure({ contextWindowTokens: 32768 });
    same(provider.state().contextWindowTokens, 32768);
    await provider.configure({ contextWindowTokens: null });
    same(provider.state().contextWindowTokens, null, 'null clears the context window');

    const snapshot = JSON.stringify(provider.state());
    const verdict = provider.validateConfiguration({ preset: 'openai', apiKey: KEY });
    same([verdict.ok, verdict.keyProvided, verdict.protocol], [true, true, 'openai-chat']);
    check(!JSON.stringify(verdict).includes(KEY) && JSON.stringify(provider.state()) === snapshot, 'validation neither leaks nor applies');
    same(provider.normalizeError(Object.assign(new Error(`bad ${KEY}`), { code: 'gateway_rate_limit', kind: 'rate_limit', upstreamStatus: 429 })), { code: 'gateway_rate_limit', kind: 'rate_limit', retryable: true, status: 429, message: 'bad [REDACTED]' });
    same(provider.normalizeError(new Error('x')).retryable, false);
    const usage = provider.estimateUsage({ input: [userMsg('hello')], instructions: 'S', tools: TOOLS });
    check(usage.estimated && usage.inputTokens > 0 && usage.fraction === null, 'usage estimate without a known window');
  }

  // keys from the environment: only for the matching provider, never written anywhere
  {
    const env = { ANTHROPIC_API_KEY: 'sk-env-anthropic-0123456789', OPENAI_API_KEY: 'sk-env-openai-0123456789' };
    const { provider, directory } = await makeProvider('env', { env });
    same(provider.envKeys().map((entry) => entry.preset).sort(), ['anthropic', 'openai', 'openai-responses'],
      'the same named OpenAI key may be offered for both OpenAI protocols, never for a custom gateway');
    check(!JSON.stringify(provider.envKeys()).includes('0123456789'), 'only variable names are listed');
    same(provider.ready(), false, 'an environment key is not used until the person chooses that provider');
    await provider.configure({ preset: 'anthropic', useEnvKey: true, remember: true });
    same([provider.state().keySource, provider.ready()], ['environment', true]);
    check(!JSON.stringify(provider.state()).includes('sk-env'), 'state does not show it');
    await assert.rejects(fs.stat(path.join(directory, 'gateway-key.dpapi')), { code: 'ENOENT' }); checks += 1;
    check(!(await fs.readFile(path.join(directory, 'gateway-config.json'), 'utf8')).includes('sk-env'), 'and nothing is saved to disk');
    await rejects(provider.configure({ preset: 'custom-openai', apiBaseUrl: 'https://gw.example.com/v1', model: 'm1', useEnvKey: true }), { code: 'missing_env_key' }, 'a custom endpoint never receives an environment key');
    await provider.configure({ model: 'claude-other' });
    same(provider.state().keySource, 'environment', 'the source is remembered across unrelated changes');
    const again = new GatewayProvider({ directory, bundleRoot: BUNDLE, manager: { secrets: [] }, env, fetchImpl: neverFetch, platform: 'linux' });
    await again.load();
    same([again.state().keySource, again.ready()], ['environment', true], 'after a restart the variable is read again');
    const without = new GatewayProvider({ directory, bundleRoot: BUNDLE, manager: { secrets: [] }, env: {}, fetchImpl: neverFetch, platform: 'linux' });
    await without.load();
    same(without.ready(), false, 'and without the variable there is no key');
  }

  // configurations written by older versions, damaged files, and the old Gemini environment variable
  {
    const dir = path.join(root, 'legacy');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'gateway-config.json'), JSON.stringify({ version: 1, apiBaseUrl: 'https://gw.example.com', protocol: 'openai-chat', model: 'm-old', authMode: 'bearer', customPath: '' }));
    const old = new GatewayProvider({ directory: dir, bundleRoot: BUNDLE, manager: { secrets: [] }, env: { OPENAI_API_KEY: 'sk-env-openai-0123456789' }, fetchImpl: neverFetch, platform: 'linux' });
    await old.load();
    same([old.state().protocol, old.state().preset, old.state().contextWindowTokens, old.state().authMode], ['openai-chat', '', null, 'bearer'], 'version 1 files still load');
    same(old.ready(), false, 'an OpenAI key in the environment is not sent to an unknown gateway');

    // A window that an older build accepted (2,000..4,095) or that is above the cap must not vanish without a word.
    const tinyDir = path.join(root, 'legacy-tiny-window');
    await fs.mkdir(tinyDir, { recursive: true });
    await fs.writeFile(path.join(tinyDir, 'gateway-config.json'), JSON.stringify({ version: 2, apiBaseUrl: 'https://gw.example.com', protocol: 'openai-chat', model: 'm-old', authMode: 'bearer', customPath: '', contextWindowTokens: 3000 }));
    const tiny = new GatewayProvider({ directory: tinyDir, bundleRoot: BUNDLE, manager: { secrets: [] }, env: {}, fetchImpl: neverFetch, platform: 'linux' });
    await tiny.load();
    same(tiny.state().contextWindowTokens, null, 'a saved window below the minimum is not used');
    check(/3[.,]000/.test(tiny.state().lastError) && /4[.,]096/.test(tiny.state().lastError), 'and the person is told which value was ignored and what the minimum is');
    const hugeDir = path.join(root, 'legacy-huge-window');
    await fs.mkdir(hugeDir, { recursive: true });
    await fs.writeFile(path.join(hugeDir, 'gateway-config.json'), JSON.stringify({ version: 2, apiBaseUrl: 'https://gw.example.com', protocol: 'openai-chat', model: 'm-old', authMode: 'bearer', customPath: '', contextWindowTokens: 9_000_000 }));
    const huge = new GatewayProvider({ directory: hugeDir, bundleRoot: BUNDLE, manager: { secrets: [] }, env: {}, fetchImpl: neverFetch, platform: 'linux' });
    await huge.load();
    same(huge.state().contextWindowTokens, 2_000_000, 'a saved window above the cap is clamped, as it is when typed');

    const gemini = await makeProvider('legacy-gemini', { env: { GOOGLE_API_KEY: 'g-0123456789abcdef' } });
    same([gemini.provider.ready(), gemini.provider.state().keySource], [true, 'environment'], 'GOOGLE_API_KEY keeps working for the default Gemini setup');

    const brokenDir = path.join(root, 'broken');
    await fs.mkdir(brokenDir, { recursive: true });
    await fs.writeFile(path.join(brokenDir, 'gateway-config.json'), 'not json {');
    const broken = new GatewayProvider({ directory: brokenDir, bundleRoot: BUNDLE, manager: { secrets: [] }, env: {}, fetchImpl: neverFetch, platform: 'linux' });
    await broken.load();
    check(/bị hỏng/.test(broken.state().lastError), 'a damaged config does not stop the Hub from starting');
    same(await fs.readFile(path.join(brokenDir, 'gateway-config.json'), 'utf8'), 'not json {', 'and the file is left for the person to inspect');
    await broken.configure({ preset: 'anthropic', apiKey: KEY });
    check(broken.ready() && JSON.parse(await fs.readFile(path.join(brokenDir, 'gateway-config.json'), 'utf8')).preset === 'anthropic', 'configuring again repairs it');
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Saved keys
  // ---------------------------------------------------------------------------------------------------------------
  {
    const dir = path.join(root, 'secret');
    const make = (env = {}) => new GatewayProvider({ directory: dir, bundleRoot: BUNDLE, manager: { secrets: [] }, env, fetchImpl: neverFetch, platform: 'linux' });
    const first = make();
    await first.load();
    await first.configure({ preset: 'anthropic', apiKey: KEY, remember: true });
    same([first.state().keySource, first.state().secretStorage.kind], ['saved', 'aes-gcm']);
    const record = JSON.parse(await fs.readFile(path.join(dir, 'gateway-key.dpapi'), 'utf8'));
    check(record.protected.startsWith('v1.file.') && record.scheme === 'aes-gcm' && !JSON.stringify(record).includes(KEY), 'the key file holds ciphertext only');
    if (process.platform !== 'win32') same((await fs.stat(path.join(dir, 'master.key'))).mode & 0o777, 0o600, 'the master key is private to the owner');
    const second = make();
    await second.load();
    same([second.state().keySource, second.ready()], ['saved', true], 'a saved key survives a restart');

    const protector = createProtector({ platform: 'linux', bundleRoot: BUNDLE, directory: dir, env: {} });
    const a = await protector.protect('same-secret ünïcode ✓');
    const b = await protector.protect('same-secret ünïcode ✓');
    check(a !== b, 'every protection uses a fresh salt and IV');
    same(await protector.unprotect(a), 'same-secret ünïcode ✓', 'round trip, non-ASCII included');

    const tampered = { ...record, protected: record.protected.slice(0, -2) + (record.protected.endsWith('AA') ? 'BB' : 'AA') };
    await fs.writeFile(path.join(dir, 'gateway-key.dpapi'), JSON.stringify(tampered));
    const third = make();
    await third.load();
    check(!third.ready() && /Không giải mã/.test(third.state().lastError), 'a modified key file is rejected, not half-used');
    await rejects(protector.unprotect('garbage'), { code: 'secret_unreadable' });

    const dirEnv = path.join(root, 'secret-env');
    await fs.mkdir(dirEnv, { recursive: true });
    const withEnv = createProtector({ platform: 'linux', bundleRoot: BUNDLE, directory: dirEnv, env: { CHATMCP_MASTER_KEY: 'a-long-enough-master-secret' } });
    const blob = await withEnv.protect('top-secret-value');
    check(blob.startsWith('v1.env.'), 'a master key from the environment is used when set');
    same(await withEnv.unprotect(blob), 'top-secret-value');
    await assert.rejects(fs.stat(path.join(dirEnv, 'master.key')), { code: 'ENOENT' }); checks += 1;
    await rejects(createProtector({ platform: 'linux', bundleRoot: BUNDLE, directory: dirEnv, env: {} }).unprotect(blob), { code: 'secret_master_missing' }, 'asks for the variable when it is missing');
    await rejects(createProtector({ platform: 'linux', bundleRoot: BUNDLE, directory: dirEnv, env: { CHATMCP_MASTER_KEY: 'another-long-master-secret' } }).unprotect(blob), { code: 'secret_unreadable' }, 'and refuses a different one');
    check((await createProtector({ platform: 'linux', bundleRoot: BUNDLE, directory: dirEnv, env: { CHATMCP_MASTER_KEY: 'short' } }).protect('x')).startsWith('v1.file.'), 'a too-short variable is ignored');

    const dirRace = path.join(root, 'secret-race');
    await fs.mkdir(dirRace, { recursive: true });
    const racer = createProtector({ platform: 'linux', bundleRoot: BUNDLE, directory: dirRace, env: {} });
    const blobs = await Promise.all(['one', 'two', 'three', 'four'].map((text) => racer.protect(text)));
    same(await Promise.all(blobs.map((blobText) => racer.unprotect(blobText))), ['one', 'two', 'three', 'four'], 'concurrent first use creates one master key');
    await fs.writeFile(path.join(dirRace, 'master.key'), 'garbage');
    await rejects(racer.protect('x'), { code: 'secret_master_invalid' }, 'a damaged master key is reported, never silently replaced');

    if (process.platform === 'win32') {
      const dpapiDir = path.join(root, 'dpapi');
      await fs.mkdir(dpapiDir, { recursive: true });
      const windows = createProtector({ platform: 'win32', bundleRoot: BUNDLE, directory: dpapiDir, env: {} });
      const text = `${KEY} ünïcode ✓`;
      const protectedText = await windows.protect(text);
      check(protectedText !== text && !protectedText.includes(KEY), 'DPAPI output does not contain the secret');
      same(await windows.unprotect(protectedText), text, 'DPAPI round trip through windows/Protect-ApiKey.ps1');
      const viaProvider = new GatewayProvider({ directory: dpapiDir, bundleRoot: BUNDLE, manager: { secrets: [] }, env: {}, fetchImpl: neverFetch });
      await viaProvider.load();
      await viaProvider.configure({ preset: 'anthropic', apiKey: KEY, remember: true });
      const reloaded = new GatewayProvider({ directory: dpapiDir, bundleRoot: BUNDLE, manager: { secrets: [] }, env: {}, fetchImpl: neverFetch });
      await reloaded.load();
      same([reloaded.state().keySource, reloaded.state().secretStorage.kind, reloaded.ready()], ['saved', 'windows-dpapi', true], 'a provider keeps its key through real DPAPI');
    } else {
      console.log('SKIP (not Windows): DPAPI round trip. It runs on the Windows test pass.');
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Anthropic through the provider
  // ---------------------------------------------------------------------------------------------------------------
  {
    const requests = [];
    const fetchImpl = async (url, opts) => {
      requests.push({ url, headers: opts.headers, body: JSON.parse(opts.body), redirect: opts.redirect });
      if (requests.length === 1) return reply(200, { type: 'message', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'text', text: 'Reading.' }, { type: 'tool_use', id: 'toolu_01', name: 'read_file', input: { path: 'a.txt' } }], usage: { input_tokens: 30, output_tokens: 10 } });
      return reply(200, anthropicOk('It says hello.', { usage: { input_tokens: 60, output_tokens: 5 } }));
    };
    const { provider } = await makeProvider('anthropic-loop', { fetchImpl, configure: { preset: 'anthropic', apiKey: KEY } });
    const first = await provider.respond({ input: [userMsg('Read a.txt')], instructions: 'SYS', tools: TOOLS, maxOutputTokens: 8000 });
    same(requests[0].url, 'https://api.anthropic.com/v1/messages');
    same([requests[0].headers['x-api-key'], requests[0].headers['anthropic-version'], 'Authorization' in requests[0].headers, requests[0].redirect], [KEY, '2023-06-01', false, 'error']);
    same(requests[0].body.max_tokens, 8000, 'the agent\'s output budget is used');
    check(requests[0].body.system[0].cache_control, 'prompt caching is requested from Anthropic itself');
    same(first.output.map((item) => item.type), ['message', 'function_call']);
    const second = await provider.respond({ input: [userMsg('Read a.txt'), ...first.output, out('toolu_01', 'hello')], instructions: 'SYS', tools: TOOLS });
    const result = requests[1].body.messages.at(-1).content[0];
    same([result.type, result.tool_use_id, result.content], ['tool_result', 'toolu_01', 'hello']);
    same([second.output[0].content[0].text, requests[1].body.max_tokens], ['It says hello.', 16384]);

    // gateways that speak the Anthropic protocol: no cache markers, optional Bearer auth
    const gateway = [];
    const { provider: custom } = await makeProvider('anthropic-gw', { fetchImpl: async (url, opts) => { gateway.push({ url, headers: opts.headers, body: JSON.parse(opts.body) }); return reply(200, anthropicOk('ok')); }, configure: { preset: 'custom-anthropic', apiBaseUrl: 'https://gw.example.com', model: 'claude-gw', apiKey: KEY, authMode: 'bearer' } });
    await custom.respond({ input: [userMsg('x')], instructions: 'S', tools: TOOLS });
    same(gateway[0].url, 'https://gw.example.com/v1/messages');
    check(gateway[0].headers.Authorization === `Bearer ${KEY}` && !('x-api-key' in gateway[0].headers), 'Bearer auth for gateways that want it');
    check(!JSON.stringify(gateway[0].body).includes('cache_control'), 'no cache markers for a compatible gateway');

    // a conversation interrupted between a call and its result is repaired, not rejected by the API
    const orphan = [];
    const { provider: repair } = await makeProvider('anthropic-orphan', { fetchImpl: async (url, opts) => { orphan.push(JSON.parse(opts.body)); return reply(200, anthropicOk('ok')); }, configure: { preset: 'anthropic', apiKey: KEY } });
    await repair.respond({ input: [userMsg('go'), call('c1')], instructions: 'S', tools: TOOLS });
    const tail = orphan[0].messages.slice(-2);
    same([tail[0].role, tail[0].content.at(-1).type, tail[1].role, tail[1].content[0].type, tail[1].content[0].tool_use_id], ['assistant', 'tool_use', 'user', 'tool_result', 'c1']);
    check(/gián đoạn/.test(tail[1].content[0].content), 'the missing result says what happened');
  }

  // retries
  {
    let n = 0;
    const { provider, sleeps } = await makeProvider('retry-429', { configure: { preset: 'anthropic', apiKey: KEY }, fetchImpl: async () => { n += 1; return n < 3 ? reply(429, { type: 'error', error: { type: 'rate_limit_error', message: `slow down ${KEY}` } }, { 'retry-after': '3' }) : reply(200, anthropicOk('fine')); } });
    const notes = [];
    const result = await provider.respond({ input: [userMsg('hi')], instructions: 'S', onStatus: async (message, kind) => notes.push([message, kind]) });
    same([n, sleeps.length, result.output[0].content[0].text], [3, 2, 'fine']);
    check(sleeps.every((ms) => ms >= 3000 && ms <= 60000), 'Retry-After is honoured');
    check(notes.length === 2 && notes.every(([message]) => !message.includes(KEY) && /không chạy lại công cụ/.test(message)), 'waiting is announced, without the key');

    n = 0;
    const down = await makeProvider('retry-503', { configure: { preset: 'anthropic', apiKey: KEY }, fetchImpl: async () => { n += 1; return reply(503, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }); } });
    const failure = await down.provider.respond({ input: [userMsg('hi')], instructions: 'S' }).catch((error) => error);
    same([failure.code, failure.kind, failure.upstreamStatus, n, down.sleeps.length], ['gateway_overloaded', 'overloaded', 503, 6, 5], 'a provider that stays down is retried a bounded number of times');

    n = 0;
    const long = await makeProvider('retry-long', { configure: { preset: 'anthropic', apiKey: KEY }, fetchImpl: async () => { n += 1; return reply(429, { error: { message: 'daily limit' } }, { 'retry-after': '600' }); } });
    const refusal = await long.provider.respond({ input: [userMsg('hi')], instructions: 'S' }).catch((error) => error);
    same([refusal.code, n, long.sleeps.length], ['gateway_rate_limit', 1, 0], 'a long Retry-After is reported instead of waited for');
    check(/600 giây/.test(refusal.message), 'and says how long');

    n = 0;
    const quota = await makeProvider('quota', { configure: { preset: 'anthropic', apiKey: KEY }, fetchImpl: async () => { n += 1; return reply(429, { error: { message: 'You exceeded your current quota' } }); } });
    same([(await quota.provider.respond({ input: [userMsg('hi')], instructions: 'S' }).catch((error) => error)).code, n], ['gateway_quota', 1], 'no credit is not retried');

    n = 0;
    const embedded = await makeProvider('embedded', { configure: { preset: 'openai', apiKey: KEY }, fetchImpl: async () => { n += 1; return n === 1 ? reply(200, { error: { code: 429, message: 'rate limited' } }) : reply(200, chatOk('fine')); } });
    same([(await embedded.provider.respond({ input: [userMsg('hi')], instructions: 'S' })).output[0].content[0].text, n], ['fine', 2], 'HTTP 200 carrying an error object is treated as the error');

    n = 0;
    const html = await makeProvider('html', { configure: { preset: 'openai', apiKey: KEY }, fetchImpl: async () => { n += 1; return reply(502, '<html><body>Bad gateway</body></html>'); } });
    const htmlError = await html.provider.respond({ input: [userMsg('hi')], instructions: 'S' }).catch((error) => error);
    check(htmlError.code === 'gateway_http_error' && !htmlError.message.includes('<html') && /trang lỗi/.test(htmlError.message) && n === 6, 'an HTML error page is summarised, not dumped');

    n = 0;
    const control = new AbortController();
    const cancelled = await makeProvider('cancel', { configure: { preset: 'anthropic', apiKey: KEY }, fetchImpl: async () => { n += 1; return reply(503, {}); } });
    await rejects(cancelled.provider.respond({ input: [userMsg('hi')], instructions: 'S', signal: control.signal, onStatus: async () => control.abort(new Error('user_cancelled')) }), /user_cancelled/, 'cancelling during a wait stops the run');
    same(n, 1, 'and no further request is sent');

    n = 0;
    const flaky = await makeProvider('network', { configure: { preset: 'anthropic', apiKey: KEY }, fetchImpl: async () => { n += 1; if (n === 1) throw new TypeError('fetch failed'); return reply(200, anthropicOk('back')); } });
    const flakyNotes = [];
    same((await flaky.provider.respond({ input: [userMsg('hi')], instructions: 'S', onStatus: async (message) => flakyNotes.push(message) })).output[0].content[0].text, 'back');
    check(flaky.sleeps.length === 1 && /Mất kết nối/.test(flakyNotes[0]), 'a lost connection is waited out');

    n = 0;
    const offline = await makeProvider('offline', { limits: { maxNetworkRetries: 2 }, configure: { preset: 'anthropic', apiKey: KEY }, fetchImpl: async () => { n += 1; throw new TypeError('fetch failed'); } });
    same([(await offline.provider.respond({ input: [userMsg('hi')], instructions: 'S' }).catch((error) => error)).code, n], ['gateway_network', 3], 'an outage ends the run after a bounded number of tries');

    n = 0;
    const slow = await makeProvider('timeouts', { configure: { preset: 'anthropic', apiKey: KEY }, fetchImpl: async () => { n += 1; throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); } });
    same([(await slow.provider.respond({ input: [userMsg('hi')], instructions: 'S' }).catch((error) => error)).code, n], ['gateway_timeout', 3], 'repeated timeouts are not repeated forever');

    await rejects((await makeProvider('bad-json', { configure: { preset: 'openai', apiKey: KEY }, fetchImpl: async () => reply(200, 'not json') })).provider.respond({ input: [userMsg('hi')], instructions: 'S' }), { code: 'gateway_invalid_json' });
  }

  // output limit learned from the provider
  {
    const sent = [];
    const { provider } = await makeProvider('limit', { configure: { preset: 'anthropic', apiKey: KEY }, fetchImpl: async (url, opts) => {
      const body = JSON.parse(opts.body);
      sent.push(body.max_tokens);
      return body.max_tokens > 8192
        ? reply(400, { type: 'error', error: { type: 'invalid_request_error', message: `max_tokens: ${body.max_tokens} > 8192, which is the maximum allowed number of output tokens for claude-test` } })
        : reply(200, anthropicOk('done'));
    } });
    await provider.respond({ input: [userMsg('x')], instructions: 'S', maxOutputTokens: 16384 });
    same([sent, provider.outputLimit], [[16384, 8192], 8192]);
    await provider.respond({ input: [userMsg('x')], instructions: 'S', maxOutputTokens: 16384 });
    same(sent, [16384, 8192, 8192], 'the learned cap is used from the start next time');
    await provider.configure({ model: 'claude-other' });
    same(provider.outputLimit, null, 'a new model starts without the old cap');
  }

  // Gemini: the output cap was a constant 8192. It now follows the caller's output budget (a thinking model spends the cap on thoughts and
  // ends MAX_TOKENS), keeps 8192 when the caller says nothing, and learns the range of a model that accepts less instead of failing.
  {
    const geminiOk = { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 } };
    const sent = [];
    let range = null;
    const { provider } = await makeProvider('gemini-cap', { configure: { preset: 'gemini', apiKey: KEY }, fetchImpl: async (url, opts) => {
      const body = JSON.parse(opts.body);
      sent.push(body.generationConfig?.maxOutputTokens);
      if (range !== null && body.generationConfig?.maxOutputTokens >= range) {
        return reply(400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: `Unable to submit request because it has a maxOutputTokens value of ${body.generationConfig.maxOutputTokens} but the supported range is from 1 (inclusive) to ${range} (exclusive). Update the value and try again.` } });
      }
      return reply(200, geminiOk);
    } });
    const ask = (maxOutputTokens) => provider.respond({ input: [userMsg('hi')], instructions: 'S', ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }) });
    await ask();
    await ask(16384);
    await ask(100);
    await ask(1_000_000);
    same(sent, [8192, 16384, 256, 65536], 'default 8,192; the caller\'s budget otherwise, within 256..65,536');
    sent.length = 0;
    range = 8193;
    await ask(16384);
    same([sent, provider.outputLimit], [[16384, 8192], 8192], 'a model that accepts at most 8,192 is asked again with 8,192 and the limit is remembered');
    await ask(16384);
    same(sent, [16384, 8192, 8192], 'the learned cap is used from the start next time');
    await provider.configure({ model: 'gemini-other' });
    same(provider.outputLimit, null, 'a new model starts without the old cap');

    // A gateway in front of Gemini words its refusal its own way: no range to parse. A 400 that names the cap is still answered once with
    // the 8,192 every Gemini model accepts, and remembered, instead of failing every step the way an unrecognised error would.
    const worded = [];
    const { provider: custom } = await makeProvider('gemini-cap-worded', { configure: { preset: 'custom-gemini', apiBaseUrl: 'https://gw.example.com', model: 'gemini-gw', apiKey: KEY }, fetchImpl: async (url, opts) => {
      const body = JSON.parse(opts.body);
      worded.push(body.generationConfig?.maxOutputTokens);
      return body.generationConfig?.maxOutputTokens > 8192
        ? reply(400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'generation_config.max_output_tokens: value must be less than or equal to 8192' } })
        : reply(200, geminiOk);
    } });
    await custom.respond({ input: [userMsg('hi')], instructions: 'S', maxOutputTokens: 16384 });
    same([worded, custom.outputLimit], [[16384, 8192], 8192], 'an error without a parseable range still lowers the cap to 8,192, once');
    await custom.respond({ input: [userMsg('hi')], instructions: 'S', maxOutputTokens: 16384 });
    same(worded, [16384, 8192, 8192], 'and the next step starts there');
    const unrelated = await makeProvider('gemini-cap-unrelated', { configure: { preset: 'custom-gemini', apiBaseUrl: 'https://gw.example.com', model: 'gemini-gw', apiKey: KEY }, fetchImpl: async () => reply(400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Invalid JSON payload received.' } }) });
    same((await unrelated.provider.respond({ input: [userMsg('hi')], instructions: 'S', maxOutputTokens: 16384 }).catch((error) => error)).code, 'gateway_http_error', 'a 400 that does not name the cap is not retried as one');
    same(unrelated.provider.outputLimit, null);
  }

  // context window: reactive and proactive compaction
  {
    const reads = [userMsg('Task')];
    for (let i = 0; i < 6; i += 1) reads.push(call(`c${i}`, 'read_file', { path: `f${i}.js` }), out(`c${i}`, `${'Y'.repeat(60000)}${i}`));
    const fullBytes = historyBytes(reads);
    const contextError = reply(400, { type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 300000 tokens > 200000 maximum' } });
    const sizes = [];
    const bodies = [];
    const { provider } = await makeProvider('context', { configure: { preset: 'anthropic', apiKey: KEY }, fetchImpl: async (url, opts) => { sizes.push(Buffer.byteLength(opts.body)); bodies.push(opts.body); return sizes.at(-1) > 150_000 ? contextError : reply(200, anthropicOk('ok')); } });
    const notes = [];
    await provider.respond({ input: reads, instructions: 'S', tools: TOOLS, onStatus: async (message, kind) => notes.push([message, kind]) });
    check(sizes.length >= 2 && sizes.length <= 4 && sizes.at(-1) <= 150_000 && sizes[0] > 150_000, 'a context error shortens the next request');
    check(!bodies[0].includes('đã rút gọn') && bodies.at(-1).includes('đã rút gọn'), 'the shortened request marks what was shortened');
    check(notes.some(([, kind]) => kind === 'context_compaction') && notes.every(([message]) => !message.includes(KEY)), 'the person is told');
    same(historyBytes(reads), fullBytes, 'the agent\'s own history is untouched');

    let n = 0;
    const stuck = await makeProvider('context-stuck', { configure: { preset: 'anthropic', apiKey: KEY }, fetchImpl: async () => { n += 1; return contextError; } });
    const stuckError = await stuck.provider.respond({ input: reads, instructions: 'S' }).catch((error) => error);
    check(stuckError.code === 'gateway_context_length' && /Chọn model/.test(stuckError.message) && n <= 4, 'an impossible conversation ends with advice, after a bounded number of requests');

    const many = [userMsg('Task')];
    for (let i = 0; i < 20; i += 1) many.push(call(`m${i}`), out(`m${i}`, 'Z'.repeat(30000)));
    const proactive = [];
    const { provider: windowed } = await makeProvider('window', { configure: { preset: 'anthropic', apiKey: KEY, contextWindowTokens: 60000 }, fetchImpl: async (url, opts) => { proactive.push(Buffer.byteLength(opts.body)); return reply(200, anthropicOk('ok')); } });
    const proactiveNotes = [];
    await windowed.respond({ input: many, instructions: 'S', tools: TOOLS, maxOutputTokens: 4096, onStatus: async (message, kind) => proactiveNotes.push(kind) });
    check(proactive.length === 1 && proactive[0] <= 180_000 && historyBytes(many) > 600_000, 'with a known window the request is shortened before it is sent');
    check(proactiveNotes.includes('context_compaction'), 'and announced');
  }

  // ---------------------------------------------------------------------------------------------------------------
  // OpenAI-compatible through the provider
  // ---------------------------------------------------------------------------------------------------------------
  {
    const requests = [];
    const fetchImpl = async (url, opts) => {
      requests.push({ url, headers: opts.headers, body: JSON.parse(opts.body) });
      return reply(200, { choices: [{ finish_reason: 'tool_calls', message: { content: 'Looking', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }] } }], usage: { prompt_tokens: 10, completion_tokens: 4 } });
    };
    const { provider } = await makeProvider('openai', { fetchImpl, configure: { preset: 'openai', apiKey: KEY } });
    const first = await provider.respond({ input: [userMsg('go')], instructions: 'S', tools: TOOLS });
    same(requests[0].url, 'https://api.openai.com/v1/chat/completions');
    same([requests[0].headers.Authorization, requests[0].body.tool_choice, 'max_tokens' in requests[0].body], [`Bearer ${KEY}`, 'auto', false], 'no output cap is imposed on providers that choose their own');
    await provider.respond({ input: [userMsg('go')], instructions: 'S', tools: [] });
    check(!('tools' in requests[1].body) && !('tool_choice' in requests[1].body), 'a request without tools has no tool fields');
    const third = await provider.respond({ input: [userMsg('go'), ...first.output, out('c1', 'x')], instructions: 'S', tools: TOOLS });
    check(third.output.find((item) => item.type === 'function_call').call_id !== 'c1', 'an id the server reuses is replaced, so the agent\'s duplicate check holds');
    same(requests[2].body.messages.at(-1), { role: 'tool', tool_call_id: 'c1', content: 'x' });

    // local servers need no key; a remote one does
    const local = [];
    const { provider: ollama } = await makeProvider('ollama', { fetchImpl: async (url, opts) => { local.push({ url, headers: opts.headers }); return reply(200, chatOk('hi')); }, configure: { preset: 'ollama' } });
    same([ollama.ready(), ollama.state().keyRequired, ollama.state().contextWindowTokens], [true, false, null]);
    await ollama.respond({ input: [userMsg('x')], instructions: 'S' });
    same([local[0].url, 'Authorization' in local[0].headers], ['http://localhost:11434/v1/chat/completions', false], 'no key, no auth header');
    await ollama.configure({ apiBaseUrl: 'https://remote.example.com/v1' });
    same([ollama.ready(), ollama.state().keyRequired, ollama.state().preset], [false, true, 'custom-openai'], 'a remote host needs a key');
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Model discovery
  // ---------------------------------------------------------------------------------------------------------------
  same(modelsUrl('openai-chat', 'https://api.openai.com/v1'), 'https://api.openai.com/v1/models');
  same(modelsUrl('openai-chat', 'https://api.deepseek.com'), 'https://api.deepseek.com/v1/models');
  same(modelsUrl('gemini', 'https://generativelanguage.googleapis.com'), 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000');
  same(modelsUrl('anthropic', 'https://api.anthropic.com'), 'https://api.anthropic.com/v1/models?limit=1000');
  same(modelsUrl('openai-chat', 'https://x.example', '/custom/path'), null);
  same(parseOpenAiModels({ data: [{ id: 'a' }, 'b', { nope: 1 }] }).map((m) => m.id), ['a', 'b']);
  same(parseGeminiModels({ models: [{ name: 'models/g1', displayName: 'G One', supportedGenerationMethods: ['generateContent'] }, { name: 'models/emb', supportedGenerationMethods: ['embedContent'] }] }), [{ id: 'g1', name: 'G One (g1)' }]);
  same(finishModelList([{ id: 'text-embedding-3' }, { id: 'b' }, { id: 'a' }, { id: 'a' }], 'z').map((m) => m.id), ['z', 'a', 'b'], 'embeddings dropped, sorted, configured model kept');

  {
    const urls = [];
    const { provider } = await makeProvider('list-openai', { configure: { preset: 'openai', apiKey: KEY }, fetchImpl: async (url, opts) => { urls.push([url, opts.headers.Authorization]); return reply(200, { data: [{ id: 'gpt-b' }, { id: 'text-embedding-3-small' }, { id: 'gpt-a' }, { id: 'whisper-1' }, { id: 'gpt-a' }] }); } });
    const result = await provider.discoverModels();
    same(urls, [['https://api.openai.com/v1/models', `Bearer ${KEY}`]]);
    same([result.source, result.models.map((m) => m.id)], ['provider', [presetById('openai').defaultModel, 'gpt-a', 'gpt-b']]);
    same([result.models[0].configured, result.models[0].listed], [true, false], 'a configured model the provider does not list is flagged');
    same((await provider.listModels()).length, 3, 'listModels returns just the list');
  }
  {
    const urls = [];
    const pages = [{ data: [{ id: 'claude-a', display_name: 'Claude A' }], has_more: true, last_id: 'claude-a' }, { data: [{ id: 'claude-b', display_name: 'Claude B' }], has_more: false }];
    const { provider } = await makeProvider('list-anthropic', { configure: { preset: 'anthropic', apiKey: KEY, model: 'claude-a' }, fetchImpl: async (url, opts) => { urls.push([url, opts.headers['x-api-key'], opts.headers['anthropic-version']]); return reply(200, pages[urls.length - 1]); } });
    const result = await provider.discoverModels();
    same(urls.map(([url]) => url), ['https://api.anthropic.com/v1/models?limit=1000', 'https://api.anthropic.com/v1/models?limit=1000&after_id=claude-a'], 'pages are followed');
    same([urls[0][1], urls[0][2]], [KEY, '2023-06-01']);
    same(result.models.map((m) => m.id), ['claude-a', 'claude-b']);
  }
  {
    const urls = [];
    const pages = [{ models: [{ name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', supportedGenerationMethods: ['generateContent'] }, { name: 'models/embedding-001', supportedGenerationMethods: ['embedContent'] }], nextPageToken: 'T2' }, { models: [{ name: 'models/gemini-pro', supportedGenerationMethods: ['generateContent'] }] }];
    const { provider } = await makeProvider('list-gemini', { configure: { preset: 'gemini', apiKey: KEY }, fetchImpl: async (url, opts) => { urls.push([url, opts.headers['x-goog-api-key']]); return reply(200, pages[urls.length - 1]); } });
    const result = await provider.discoverModels();
    same(urls.map(([url]) => url), ['https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&pageToken=T2']);
    same([urls[0][1], result.models.map((m) => m.id)], [KEY, ['gemini-2.5-flash', 'gemini-pro']]);
  }
  {
    let fetches = 0;
    const endless = await makeProvider('list-endless', { configure: { preset: 'anthropic', apiKey: KEY }, fetchImpl: async () => { fetches += 1; return reply(200, { data: [{ id: `claude-${fetches}` }], has_more: true, last_id: `claude-${fetches}` }); } });
    await endless.provider.discoverModels();
    same(fetches, 3, 'a server that never stops paging is cut off');

    const denied = await makeProvider('list-401', { configure: { preset: 'openai', apiKey: KEY }, fetchImpl: async () => reply(401, { error: { message: `Incorrect API key provided: ${KEY}` } }) });
    const refused = await denied.provider.discoverModels();
    check(refused.source === 'configured' && /từ chối khóa API/.test(refused.warning) && !refused.warning.includes(KEY) && refused.models.length === 1, 'a refused key gives a warning and the configured model, not an exception');
    const offline = await makeProvider('list-offline', { configure: { preset: 'openai', apiKey: KEY }, fetchImpl: async () => { throw new TypeError(`fetch failed for ${KEY}`); } });
    const lost = await offline.provider.discoverModels();
    check(lost.source === 'configured' && /Không lấy được danh sách model/.test(lost.warning) && !lost.warning.includes(KEY), 'a network failure too');
    check((await (await makeProvider('list-garbage', { configure: { preset: 'openai', apiKey: KEY }, fetchImpl: async () => reply(200, 'not json') })).provider.discoverModels()).source === 'configured', 'and unreadable output');
    check(/không trả model nào/.test((await (await makeProvider('list-empty', { configure: { preset: 'openai', apiKey: KEY }, fetchImpl: async () => reply(200, { data: [] }) })).provider.discoverModels()).warning), 'and an empty list');
    const custom = await makeProvider('list-custom', { configure: { preset: 'custom-openai', apiBaseUrl: 'https://gw.example.com', model: 'm1', apiKey: KEY, customPath: '/custom/chat' } });
    check(/Endpoint tùy chỉnh/.test((await custom.provider.discoverModels()).warning), 'a custom endpoint path is not guessed at (no request is made)');
    const keyless = await makeProvider('list-nokey', { configure: { preset: 'openai' } });
    const needKey = await keyless.provider.discoverModels();
    check(needKey.source === 'configured' && /API key/.test(needKey.warning), 'no key, no request (neverFetch would throw)');
    const lan = [];
    const localList = await makeProvider('list-local', { configure: { preset: 'ollama' }, fetchImpl: async (url, opts) => { lan.push(opts.headers); return reply(200, { data: [{ id: 'qwen2.5-coder:7b' }, { id: 'llama3.1:8b' }] }); } });
    same([(await localList.provider.discoverModels()).models.map((m) => m.id), 'Authorization' in lan[0]], [['llama3.1:8b', 'qwen2.5-coder:7b'], false], 'a local server is asked without a key');
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Custom header security and protected persistence (actual outbound fetch)
  // ---------------------------------------------------------------------------------------------------------------
  {
    const directory=path.join(root,'custom-headers');
    const manager={secrets:[]};
    const observed=[];
    // Only a test cryptographic stand-in; production uses platform protector.
    const protect=async plain=>'fixture:'+Buffer.from(plain).toString('base64');
    const unprotect=async cipher=>Buffer.from(cipher.slice('fixture:'.length),'base64').toString('utf8');
    const make=async()=>{
      const gateway=new GatewayProvider({
        directory,bundleRoot:BUNDLE,manager,env:{CHATMCP_REGION:'eu-west'},
        platform:'linux',protect,unprotect,
        fetchImpl:async(url,options)=>{observed.push({url,headers:options.headers});
          return reply(200,chatOk('ok'));}
      });
      await gateway.load();
      return gateway;
    };
    const p=await make();
    await p.configure({preset:'custom-openai',apiBaseUrl:'https://tenant.example/v1',
      model:'fixture-model',apiKey:KEY,remember:true,customHeaders:[
        {name:'X-Private-Tenant',value:'secret-tenant-value'},
        {name:'X-Region',envKeyName:'CHATMCP_REGION'},
      ]});
    same(p.state().customHeaders.map(h=>h.name),['X-Private-Tenant','X-Region']);
    check(!JSON.stringify(p.state()).includes('secret-tenant-value'),'public state redacts all custom header values');
    check(!(await fs.readFile(path.join(directory,'gateway-config.json'),'utf8')).includes('secret-tenant-value'),
      'public config never stores headers as plaintext');
    check(!(await fs.readFile(path.join(directory,'gateway-custom-headers.dpapi'),'utf8')).includes('secret-tenant-value'),
      'protected header file never stores plaintext values');
    const response=await p.respond({input:[userMsg('Hi')],instructions:'Say ok',tools:[]});
    same(response.status,'completed');
    same([observed[0].headers['X-Private-Tenant'],observed[0].headers['X-Region']],
      ['secret-tenant-value','eu-west'],'headers applied only at authorized provider');
    const restored=await make();
    same(restored.state().customHeaders.map(h=>h.name),['X-Private-Tenant','X-Region'],
      'restarts restore encrypted headers for matching origin');
    const validation=restored.validateConfiguration({model:'different-model'});
    same(validation.customHeaderNames,['X-Private-Tenant','X-Region']);
    await rejects(restored.configure({customHeaders:[{name:'Authorization',value:'attacker'}]}),
      {code:'invalid_custom_headers'});
    await rejects(restored.configure({customHeaders:[{name:'X-Bad',value:'abc\r\nInjected: 1'}]}),
      {code:'invalid_custom_headers'});
    await rejects(restored.configure({customHeaders:[{name:'X-Region',envKeyName:'CHATMCP_REGION'},
      {name:'x-region',value:'duplicate'}]}),{code:'invalid_custom_headers'});
    await restored.configure({apiBaseUrl:'https://other.example/v1',apiKey:KEY,model:'fixture-model'});
    same(restored.state().customHeaders,[],'changing origin discards headers');
    check(!(await fs.stat(path.join(directory,'gateway-custom-headers.dpapi')).then(()=>true,()=>false)),
      'changing origin deletes saved header payload');
    const missing=await make();
    await missing.configure({apiBaseUrl:'https://tenant.example/v1',apiKey:KEY,remember:false,
      customHeaders:[{name:'X-Unknown-Region',envKeyName:'MISSING_REGION'}]});
    await rejects(missing.respond({input:[userMsg('Hi')],instructions:'ok'}),
      {code:'invalid_header_environment'},'missing environment references never result in a request');
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Immutable per-task provider isolation and profile credential rebinding
  // ---------------------------------------------------------------------------------------------------------------
  {
    const base=(await makeProvider('profiles-base')).provider;
    const calls=[];
    base.fetch=async(url,opts)=>{
      const body=JSON.parse(opts.body);
      calls.push({url,model:body.model,headers:opts.headers});
      return reply(200,url.endsWith('/responses')
        ? {status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'ok'}]}]}
        : chatOk('ok'));
    };
    const api1=base.forkForTask({provider:'openai-chat',protocol:'openai-chat',
      apiBaseUrl:'https://one.example/v1',model:'coder-one',apiKey:'sk-fixture-profile-one-12345678'});
    const api2=base.forkForTask({provider:'openai-responses',protocol:'openai-responses',
      apiBaseUrl:'https://two.example/v1',model:'coder-two',apiKey:'sk-fixture-profile-two-12345678'});
    const both=await Promise.all([
      api1.respond({input:[userMsg('Hello')],instructions:'Say OK'}),
      api2.respond({input:[userMsg('Hello')],instructions:'Say OK'}),
    ]);
    same(both.map(x=>x.status),['completed','completed']);
    same(calls.map(x=>x.url).sort(),['https://one.example/v1/chat/completions','https://two.example/v1/responses']);
    same(calls.map(x=>x.model).sort(),['coder-one','coder-two']);
    same(calls.find(x=>x.model==='coder-one').headers.Authorization,'Bearer sk-fixture-profile-one-12345678');
    same(calls.find(x=>x.model==='coder-two').headers.Authorization,'Bearer sk-fixture-profile-two-12345678');
    check(!JSON.stringify(base.state()).includes('one.example'),'profile requests do not change global gateway configuration');
    await rejects(Promise.resolve().then(()=>base.forkForTask({protocol:'openai-chat',
      apiBaseUrl:'http://remote.example',model:'m',apiKey:KEY})),
      {code:'insecure_base_url'},'task profile never sends credentials to insecure remote HTTP');

    const profileDir=path.join(root,'profile-bound');
    const fakeStore={encrypt:async key=>'cipher:'+Buffer.from(key).toString('base64'),
      decrypt:async sealed=>Buffer.from(sealed.slice(7),'base64').toString()};
    const profiles=new AiProfiles({stateDir:profileDir,keyStore:fakeStore});
    await profiles.load();
    await profiles.upsert({id:'coding',provider:'openai-chat',protocol:'openai-chat',
      model:'coder-one',apiBaseUrl:'https://one.example/v1',apiKey:KEY});
    const original=await profiles.resolveConfig('coding');
    same(original.apiKey,KEY);
    check(typeof original.revision==='string','profiles retain a revision for task binding');
    await profiles.upsert({id:'coding',provider:'openai-chat',protocol:'openai-chat',
      model:'coder-two',apiBaseUrl:'https://two.example/v1'});
    const moved=await profiles.resolveConfig('coding');
    same(moved.apiKey,null,'changing origin invalidates saved credentials');
    check(moved.revision!==original.revision,'changing a profile updates revision');
    await rejects(Promise.resolve().then(()=>base.forkForTask(moved)),{code:'profile_not_ready'});
    await profiles.upsert({id:'coding',provider:'openai-chat',protocol:'openai-chat',
      model:'coder-two',apiBaseUrl:'https://two.example/v1',apiKey:KEY});
    const restored=new AiProfiles({stateDir:profileDir,keyStore:fakeStore});
    await restored.load();
    same((await restored.resolveConfig('coding')).apiKey,KEY,'protected profile credentials survive restart');
  }

  // ---------------------------------------------------------------------------------------------------------------
  // A profile fork keeps what the global connection of the same endpoint would have: prompt caching, the custom path and
  // the custom headers of THAT profile; and nothing of the global connection's headers.
  // ---------------------------------------------------------------------------------------------------------------
  {
    const seen = [];
    const { provider: base } = await makeProvider('fork-parity', { fetchImpl: async (url, opts) => { seen.push({ url, headers: opts.headers, body: JSON.parse(opts.body) }); return reply(200, anthropicOk('ok')); } });
    await base.configure({ preset: 'custom-anthropic', apiBaseUrl: 'https://global.example', model: 'claude-global', apiKey: KEY, customHeaders: [{ name: 'X-Global-Tenant', value: 'global-secret-value' }] });
    const profileKey = 'sk-fixture-profile-key-0123456789';
    const lastRequest = () => seen.at(-1);
    const forkAnthropic = base.forkForTask({ provider: 'anthropic', protocol: 'anthropic', apiBaseUrl: 'https://api.anthropic.com', model: 'claude-profile', apiKey: profileKey,
      customHeaders: [{ name: 'X-Profile-Tenant', value: 'profile-secret-value' }], customHeadersOrigin: 'https://api.anthropic.com' });
    await forkAnthropic.respond({ input: [userMsg('Hi')], instructions: 'SYS', tools: TOOLS });
    same(lastRequest().url, 'https://api.anthropic.com/v1/messages');
    same(lastRequest().body.system[0].cache_control, { type: 'ephemeral' }, 'a profile aimed at api.anthropic.com keeps prompt caching');
    same(lastRequest().body.tools.at(-1).cache_control, { type: 'ephemeral' });
    same(lastRequest().headers['X-Profile-Tenant'], 'profile-secret-value', 'the header of the profile is sent');
    check(!('X-Global-Tenant' in lastRequest().headers), 'the header of the global connection is not');
    same(lastRequest().headers['x-api-key'], profileKey, 'with the credential of the profile');
    same(forkAnthropic.state().preset, 'anthropic', 'the fork is a connection to a known provider, not the placeholder "profile"');
    same(forkAnthropic.state().customHeaders, [{ name: 'X-Profile-Tenant', source: 'protected' }], 'names only');

    const forkGateway = base.forkForTask({ provider: 'anthropic', protocol: 'anthropic', apiBaseUrl: 'https://llm-gateway.example', model: 'claude-gw', apiKey: profileKey,
      customPath: '/proxy/{model}/messages' });
    await forkGateway.respond({ input: [userMsg('Hi')], instructions: 'SYS', tools: TOOLS });
    same(lastRequest().url, 'https://llm-gateway.example/proxy/claude-gw/messages', 'the custom path of the profile is used (it was forced to empty)');
    check(lastRequest().body.system[0].cache_control === undefined && lastRequest().body.tools.at(-1).cache_control === undefined, 'another origin: a gateway may reject cache_control, so it is not sent');
    check(!('X-Global-Tenant' in lastRequest().headers) && !('X-Profile-Tenant' in lastRequest().headers), 'and no header that belongs to another origin');
    same(forkGateway.state().preset, 'custom-anthropic');

    const forkChat = base.forkForTask({ provider: 'openai-chat', protocol: 'openai-chat', apiBaseUrl: 'https://api.anthropic.com/v1', model: 'compat', apiKey: profileKey });
    same(forkChat.state().preset, 'custom-openai', 'same origin, other protocol: not the Anthropic preset');

    // The origin the headers were saved for travels with them; a fork that points elsewhere is refused, never sent.
    await rejects(Promise.resolve().then(() => base.forkForTask({ provider: 'anthropic', protocol: 'anthropic', apiBaseUrl: 'https://other.example', model: 'm', apiKey: profileKey,
      customHeaders: [{ name: 'X-Profile-Tenant', value: 'profile-secret-value' }], customHeadersOrigin: 'https://api.anthropic.com' })), { code: 'header_origin_mismatch' });
    await rejects(Promise.resolve().then(() => base.forkForTask({ provider: 'anthropic', protocol: 'anthropic', apiBaseUrl: 'https://other.example', model: 'm', apiKey: profileKey,
      customHeaders: [{ name: 'X-Profile-Tenant', value: 'profile-secret-value' }] })), { code: 'header_origin_mismatch' }, 'headers without a recorded origin are not trusted either');
    await rejects(Promise.resolve().then(() => base.forkForTask({ provider: 'anthropic', protocol: 'anthropic', apiBaseUrl: 'https://other.example', model: 'm', apiKey: profileKey,
      customPath: '/a/../b' })), { code: 'invalid_api_path' }, 'a custom path is validated again at fork time');
    await rejects(Promise.resolve().then(() => base.forkForTask({ provider: 'anthropic', protocol: 'anthropic', apiBaseUrl: 'https://other.example', model: 'm', apiKey: profileKey,
      customHeaders: [{ name: 'Authorization', value: 'x' }], customHeadersOrigin: 'https://other.example' })), { code: 'invalid_custom_headers' }, 'and so are the headers');
    check(base.manager.secrets.includes('profile-secret-value'), 'a literal header value is registered for redaction');
    check(!JSON.stringify(base.state()).includes('profile-secret-value') && !JSON.stringify(forkAnthropic.state()).includes('profile-secret-value'), 'and never appears in state');
    same(base.state().customHeaders, [{ name: 'X-Global-Tenant', source: 'protected' }], 'forking leaves the global connection alone');

    // A window the profile cannot honour fails the fork with the profile's own reason.
    await rejects(Promise.resolve().then(() => base.forkForTask({ provider: 'anthropic', protocol: 'anthropic', apiBaseUrl: 'https://other.example', model: 'm', apiKey: profileKey, contextWindow: 3000, id: 'old-profile' })),
      { code: 'invalid_context_window', statusCode: 409, message: /old-profile.*3,000.*4,096.*2,000,000.*AI Model/ }, 'a profile saved by an older build (2,000..4,095) says which window, which range and where to fix it');
    same(base.forkForTask({ provider: 'anthropic', protocol: 'anthropic', apiBaseUrl: 'https://other.example', model: 'm', apiKey: profileKey, contextWindow: 9_000_000 }).state().contextWindowTokens, 2_000_000, 'and one above the cap is clamped');
  }

  // Editing an existing profile must not silently forward an environment
  // credential to a different origin or ignore an explicit replacement key.
  {
    const name='profile-credential-controls';
    const stateDir=path.join(root,name);
    const keyStore={
      encrypt:async value=>'sealed:'+Buffer.from(value).toString('base64'),
      decrypt:async value=>Buffer.from(value.slice(7),'base64').toString('utf8'),
    };
    const profiles=new AiProfiles({stateDir,keyStore});
    await profiles.load();
    await rejects(profiles.upsert({id:'invalid',provider:'openai-chat',
      model:'gpt-test',apiBaseUrl:'https://api.example/v1',envKeyName:'BAD-VAR'}),
      {code:'invalid_env_key_name'});
    await profiles.upsert({id:'reviewer',provider:'openai-chat',protocol:'openai-chat',
      model:'gpt-test',apiBaseUrl:'https://api.example/v1',envKeyName:'OPENAI_API_KEY'});
    same(profiles.list()[0].envKeyName,'OPENAI_API_KEY');
    await profiles.upsert({id:'reviewer',provider:'openai-chat',protocol:'openai-chat',
      model:'gpt-test',apiBaseUrl:'https://api.example/v1',envKeyName:null});
    same(profiles.list()[0].envKeyName,null,'explicitly empty environment mapping can be cleared');
    await profiles.upsert({id:'reviewer',provider:'openai-chat',model:'gpt-test',
      apiBaseUrl:'https://api.example/v1',apiKey:KEY});
    same((await profiles.resolveConfig('reviewer')).apiKey,KEY);
    await profiles.upsert({id:'reviewer',provider:'openai-chat',model:'gpt-test',
      apiBaseUrl:'https://api.example/v1',clearCredentials:true});
    same((await profiles.resolveConfig('reviewer')).apiKey,null,'owner can explicitly clear stored credentials');
    await rejects(profiles.upsert({id:'invalid2',provider:'openai-chat',model:'gpt-test'}),
      {code:'missing_profile_endpoint'});
  }

  // A profile carries the custom path and custom headers a gateway connection can have. Header values are sealed with the same
  // protector as the key, stay bound to the origin they were saved for, and only their names ever leave the store.
  {
    const stateDir=path.join(root,'profile-path-headers');
    const sealed=[];
    const keyStore={
      encrypt:async value=>{sealed.push(value);return 'sealed:'+Buffer.from(value).toString('base64');},
      decrypt:async value=>Buffer.from(value.slice(7),'base64').toString('utf8'),
    };
    const profiles=new AiProfiles({stateDir,keyStore});
    await profiles.load();
    const base={id:'tenant',provider:'anthropic',protocol:'anthropic',model:'claude-x',apiBaseUrl:'https://gw.example.com',apiKey:KEY};
    const first=await profiles.upsert({...base,customPath:'/proxy/{model}/messages',
      customHeaders:[{name:'X-Tenant',value:'secret-tenant-value'},{name:'X-Region',envKeyName:'CHATMCP_REGION'}]});
    same(first.customPath,'/proxy/{model}/messages');
    same(first.customHeaders,[{name:'X-Tenant',source:'protected'},{name:'X-Region',source:'environment',envKeyName:'CHATMCP_REGION'}],'the store reports names and sources only');
    check(!JSON.stringify(profiles.list()).includes('secret-tenant-value')&&!JSON.stringify(profiles.get('tenant')).includes('secret-tenant-value'),'list and get never carry a value');
    const onDisk=await fs.readFile(profiles.filePath,'utf8');
    check(!onDisk.includes('secret-tenant-value'),'ai-profiles.json holds no plaintext header value');
    check(sealed.some(text=>text.includes('secret-tenant-value')),'the values were sealed by the key store');
    const config=await profiles.resolveConfig('tenant');
    same(config.customHeaders,[{name:'X-Tenant',value:'secret-tenant-value'},{name:'X-Region',envKeyName:'CHATMCP_REGION'}],'a task gets the values back, in memory only');
    same([config.customPath,config.customHeadersOrigin],['/proxy/{model}/messages','https://gw.example.com']);
    const reloaded=new AiProfiles({stateDir,keyStore});
    await reloaded.load();
    same((await reloaded.resolveConfig('tenant')).customHeaders.map(h=>h.name),['X-Tenant','X-Region'],'headers survive a restart');

    // Any save is a new revision; a task bound to the old one must be refused (hub.mjs compares revisions).
    const retained=await profiles.upsert({...base,model:'claude-y'});
    check(retained.revision!==first.revision,'saving the profile again is a new revision');
    same(retained.customHeaders.map(h=>h.name),['X-Tenant','X-Region'],'an omitted header list keeps the saved one');
    same(retained.customPath,'/proxy/{model}/messages','an omitted path keeps the saved one');
    const edited=await profiles.upsert({...base,customHeaders:[{name:'X-Tenant',value:'rotated-tenant-value'}]});
    check(edited.revision!==retained.revision,'editing a header is a new revision');
    same((await profiles.resolveConfig('tenant')).customHeaders,[{name:'X-Tenant',value:'rotated-tenant-value'}],'an explicit list replaces the saved one');
    check(!(await fs.readFile(profiles.filePath,'utf8')).includes('rotated-tenant-value'),'also on disk');
    await profiles.upsert({...base,customHeaders:[]});
    same((await profiles.resolveConfig('tenant')).customHeaders,[],'an empty list clears them');
    await profiles.upsert({...base,customHeaders:[{name:'X-Tenant',value:'again-tenant-value'}]});
    await profiles.upsert({...base,apiBaseUrl:'https://other.example.com',apiKey:KEY});
    same([(await profiles.resolveConfig('tenant')).customHeaders,profiles.get('tenant').customPath],[[],''],'a new destination drops headers and path of the old one');
    await profiles.upsert({...base,apiBaseUrl:'https://other.example.com',apiKey:KEY,customPath:'/v9/{model}',customHeaders:[{name:'X-Tenant',value:'again-tenant-value'}]});
    const {apiKey:_unused,...withoutKey}=base;
    await profiles.upsert({...withoutKey,apiBaseUrl:'https://other.example.com',clearCredentials:true});
    const cleared=await profiles.resolveConfig('tenant');
    same([cleared.apiKey,cleared.customHeaders],[null,[]],'clearing credentials clears the headers too');
    same(cleared.customPath,'/v9/{model}','the path is not a credential');

    await rejects(profiles.upsert({...base,customHeaders:[{name:'Authorization',value:'attacker'}]}),{code:'invalid_custom_headers'});
    await rejects(profiles.upsert({...base,customHeaders:[{name:'X-Bad',value:'a\r\nInjected: 1'}]}),{code:'invalid_custom_headers'});
    await rejects(profiles.upsert({...base,customHeaders:'X-Tenant: nope'}),{code:'invalid_custom_headers'});
    await rejects(profiles.upsert({...base,customPath:'/a/../b'}),{code:'invalid_api_path'});
    await rejects(profiles.upsert({...base,customPath:'//evil.example/x'}),{code:'invalid_api_path'});
    await rejects(profiles.upsert({...base,customPath:'relative/path'}),{code:'invalid_api_path'});

    // The same bound as the global connection (lib/context-window.mjs), enforced when the profile is SAVED, not when a task fails to start.
    await rejects(profiles.upsert({...base,contextWindow:3000}),{code:'invalid_context_window',message:/4,096.*2,000,000/});
    same((await profiles.upsert({...base,contextWindow:5_000_000})).contextWindow,2_000_000,'above the cap: clamped');
    same((await profiles.upsert({...base,contextWindow:64000})).contextWindow,64000);
    same((await profiles.upsert({...base})).contextWindow,64000,'an omitted window is kept');
    same((await profiles.upsert({...base,contextWindow:null})).contextWindow,null,'null clears it');
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Test API (diagnoseConnection) for Anthropic
  // ---------------------------------------------------------------------------------------------------------------
  {
    const seen = [];
    const ok = await makeProvider('diag-ok', { configure: { preset: 'anthropic', apiKey: KEY }, fetchImpl: async (url, opts) => { seen.push({ url, headers: opts.headers, body: JSON.parse(opts.body) }); return reply(200, anthropicOk('OK')); } });
    const verdict = await ok.provider.diagnoseConnection();
    same([verdict.ok, verdict.protocol, verdict.authMode, verdict.autoSelected, seen.length], [true, 'anthropic', 'auto', false, 2], 'one text probe, then one tool-calling probe');
    same([seen[0].url, seen[0].headers['x-api-key'], seen[0].body.max_tokens, seen[0].body.messages[0].content], ['https://api.anthropic.com/v1/messages', KEY, 32, 'Reply OK.']);
    same([verdict.toolCalling, ok.provider.state().toolCalling, seen[1].body.tools.length], ['unreliable', 'unreliable', 1], 'the mock answered in text, so tool calling is flagged and remembered in the state');
    await ok.provider.configure({ model: 'claude-other' });
    same(ok.provider.state().toolCalling, 'unchecked', 'a new configuration forgets the old probe result');

    const bearerOnly = await makeProvider('diag-bearer', { configure: { preset: 'custom-anthropic', apiBaseUrl: 'https://gw.example.com', model: 'claude-gw', apiKey: KEY }, fetchImpl: async (url, opts) => opts.headers.Authorization === `Bearer ${KEY}` ? reply(200, anthropicOk('OK')) : reply(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }) });
    const switched = await bearerOnly.provider.diagnoseConnection();
    same([switched.ok, switched.autoSelected, switched.authMode, bearerOnly.provider.state().authMode, bearerOnly.provider.ready()], [true, true, 'bearer', 'bearer', true], 'the working header style is adopted and the key kept');

    const rejected = await makeProvider('diag-fail', { configure: { preset: 'anthropic', apiKey: KEY }, fetchImpl: async () => reply(401, { type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key ${KEY}` } }) });
    const failed = await rejected.provider.diagnoseConnection().catch((error) => error);
    check(failed.code === 'gateway_probe_failed' && failed.attempts.length === 2 && failed.attempts.every((a) => a.kind === 'auth'), 'both header styles were tried');
    check(/từ chối khóa API/.test(failed.message) && !failed.message.includes(KEY), 'and the answer says the key was refused, without the key');
    same(rejected.provider.state().authMode, 'auto', 'a failed probe changes nothing');
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Tool-calling probe
  // ---------------------------------------------------------------------------------------------------------------
  {
    const probe = (protocol, fetchImpl, extra = {}) => probeToolCalling({
      protocol, endpoint: 'https://x.example/v1/endpoint', headers: { 'Content-Type': 'application/json' }, model: 'm', fetch: fetchImpl,
      redact: (text) => text.replaceAll(KEY, '[REDACTED]'), ...extra,
    });
    const sentBodies = [];
    const calling = (protocol) => async (url, opts) => {
      sentBodies.push({ protocol, opts, body: JSON.parse(opts.body) });
      return protocol === 'anthropic'
        ? reply(200, { type: 'message', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_p', name: 'record_probe', input: { value: 'ok' } }], usage: {} })
        : reply(200, { choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'p1', type: 'function', function: { name: 'record_probe', arguments: '{"value":"ok"}' } }] } }] });
    };
    same((await probe('openai-chat', calling('openai-chat'))).status, 'supported');
    same((await probe('anthropic', calling('anthropic'))).status, 'supported');
    same(sentBodies.length, 2, 'one request each, no retries');
    check(sentBodies.every(({ opts }) => opts.redirect === 'error'), 'the probe does not follow redirects');
    check(sentBodies.every(({ body }) => JSON.stringify(body).length < 2000 && (body.tools ?? []).length === 1), 'it is tiny and offers exactly one harmless tool');
    same(sentBodies[1].body.max_tokens, 256, 'the Anthropic probe asks for little output');
    same((await probe('openai-chat', async () => reply(200, chatOk('I would call it')))).status, 'unreliable', 'text instead of a call');
    same((await probe('openai-chat', async () => reply(200, { choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'z', type: 'function', function: { name: 'other_tool', arguments: '{}' } }] } }] }))).status, 'unreliable', 'a call to a function that was not offered');
    const refusedTools = await probe('openai-chat', async () => reply(400, { error: { message: 'registry.ollama.ai/library/gemma:2b does not support tools' } }));
    same(refusedTools.status, 'unsupported');
    check(/chọn model khác/.test(refusedTools.note), 'and says what to do');
    same((await probe('anthropic', async () => reply(400, { type: 'error', error: { type: 'invalid_request_error', message: 'tools are not supported for this model' } }))).status, 'unsupported');
    same((await probe('openai-chat', async () => reply(429, { error: { message: 'slow down' } }))).status, 'unknown', 'a rate limit says nothing about the model');
    same((await probe('openai-chat', async () => reply(400, { error: { message: 'Incorrect model name' } }))).status, 'unknown', 'and neither does an unrelated 400');
    const lostProbe = await probe('openai-chat', async () => { throw new TypeError(`fetch failed ${KEY}`); });
    check(lostProbe.status === 'unknown' && !lostProbe.note.includes(KEY), 'a network failure is unknown, and redacted');
    same((await probe('openai-chat', async () => reply(200, 'not json'))).status, 'unknown');
    let gemini = 0;
    same([(await probe('gemini', async () => { gemini += 1; return reply(200, {}); })).status, gemini], ['unknown', 0], 'Gemini is not probed (no request is sent)');
    await rejects(probe('openai-chat', async () => reply(200, chatOk('x')), { signal: AbortSignal.abort(new Error('cancelled')) }), /cancelled/, 'cancelling the test cancels the probe');
  }

  // ---------------------------------------------------------------------------------------------------------------
  // HTTP routes
  // ---------------------------------------------------------------------------------------------------------------
  {
    const port = await new Promise((resolve) => { const probe = net.createServer(); probe.listen(0, '127.0.0.1', () => { const { port: free } = probe.address(); probe.close(() => resolve(free)); }); });
    const origin = `http://127.0.0.1:${port}`;
    const calls = [];
    const { provider } = await makeProvider('http', { env: { OPENAI_API_KEY: 'sk-env-openai-0123456789' }, fetchImpl: async (url, opts) => {
      calls.push(url);
      if (url.endsWith('/models') || url.includes('/models?')) return reply(200, { data: [{ id: 'claude-http-a' }] });
      return reply(200, anthropicOk('OK'));
    } });
    const manager = { secrets: [], log: () => {}, catalog: { ready: true, tools: [] }, state: () => ({ version: '1.3.0', workspace: { path: 'C:\\Example' }, generation: 1, instanceId: 'mock', busy: false, services: {} }) };
    const agent = { state: () => ({ mode: 'api', activeTaskId: null, active: null, tasks: [] }), get: () => null, report: async () => '', shutdown: async () => {} };
    const browser = { browserState: () => ({ paired: false }), shutdown: async () => {} };
    const secret = 'model-adapters-test-secret-0123456789abcdef';
    const auth = { Authorization: `Bearer ${secret}` };
    const server = createHubServer(manager, { port, secret, browser, agent, provider });
    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
    try {
      const state = await fetch(`${origin}/api/state`, { headers: auth }).then((r) => r.json());
      const post = (route, body) => fetch(origin + route, { method: 'POST', headers: { ...auth, Origin: origin, 'Content-Type': 'application/json', 'X-ChatMCP-Request': 'local-dashboard', 'X-ChatMCP-CSRF': state.csrfToken }, body: JSON.stringify(body) });
      const presets = await fetch(`${origin}/api/ai/presets`, { headers: auth }).then((r) => r.json());
      check(presets.presets.some((p) => p.id === 'anthropic') && presets.envKeys.some((entry) => entry.preset === 'openai'), 'presets and detected variables are served');
      check(!JSON.stringify(presets).includes('0123456789'), 'without any value');
      let response = await post('/api/ai/config', { preset: 'anthropic', apiKey: KEY });
      const configured = await response.json();
      check(response.ok && configured.ai.preset === 'anthropic' && configured.ai.configured && configured.ai.secretStorage.kind === 'aes-gcm' && !JSON.stringify(configured).includes(KEY), 'config route: preset applied, key never echoed');
      const models = await fetch(`${origin}/api/ai/models`, { headers: auth }).then((r) => r.json());
      same([models.source, models.models.map((m) => m.id).includes('claude-http-a')], ['provider', true], 'models route');
      response = await post('/api/ai/test', {});
      const tested = await response.json();
      check(response.ok && tested.ok && tested.protocol === 'anthropic' && calls.at(-1) === 'https://api.anthropic.com/v1/messages', 'test route probes /v1/messages');
      response = await post('/api/ai/config', { preset: 'nope' });
      same(response.status, 400, 'an invalid preset is a client error');
      response = await post('/api/ai/config', { preset: 'openai', useEnvKey: true });
      const viaEnv = await response.json();
      same([response.ok, viaEnv.ai.keySource, viaEnv.ai.preset], [true, 'environment', 'openai'], 'the browser can ask for the environment key without ever seeing it');
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }

  console.log(`PASS ${checks} model adapter checks: Anthropic + OpenAI-style wire formats, lenient normalisation, bounded retries, context compaction, output-limit learning, model discovery, presets, key storage, no key crossing hosts`);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
