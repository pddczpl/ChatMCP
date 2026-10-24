#!/usr/bin/env node
// A scripted stand-in for a model server, used by the end-to-end tests. It speaks four wire protocols the way the real APIs do:
//   POST /v1/chat/completions   OpenAI Chat Completions, as JSON or as SSE (delta.tool_calls fragments, a usage chunk, [DONE])
//   POST /v1/messages           Anthropic Messages: tool_use, thinking with signature, redacted_thinking, cache usage fields,
//                               stop_reason max_tokens, SSE (message_start ... message_stop)
//   POST /v1/responses          OpenAI Responses, as JSON or as SSE (output_text and reasoning-summary deltas, response.completed
//                               with parallel function_call items)
//   POST /v1beta/models/<model>:generateContent   Gemini (JSON; functionCall parts, thought parts, thoughtSignature, usageMetadata)
//
// It is NOT a model. It answers with the next step of a fixed scenario (see scenarios.mjs), decided only by what the conversation
// already contains. A run is therefore repeatable and needs no API key, no network and no GPU. It listens on loopback only. It
// records what the Hub sent (never the Authorization value, only whether one was present).
//
// It also refuses what the real APIs refuse (protocol-validators.mjs): a tool result in the wrong place, an unknown parameter, a
// thinking block that was edited. The adapters under test stay real, so such a defect shows up as an HTTP 400 at the network seam.
// Anthropic, Responses and Gemini are strict by default. Chat Completions is strict only when asked (`strict: true`, or {chat: true}):
// the older suites were written against a lenient Chat route and the Playwright suites share it.
//
// As a library:   const mock = await startMockModel({ scenario: 'repair-add' }); mock.url; await mock.close();
// As a program:   node tests/e2e/mock-model-server.mjs [--port N] [--scenario NAME] [--strict]   (prints one "READY {json}" line)
// Options of startMockModel: scenario, scenarios, host, port, models, plus
//   strict       true | false | { chat, anthropic, responses, gemini }  which protocols refuse invalid requests (default: not chat)
//   chatDialect  'openai' | 'compat'                                   'compat' accepts and sends reasoning_content (DeepSeek and kin)
//   streamUsage  'on-request' | 'always'                               when a Chat stream carries its usage chunk
//   keepBodies   true | false                                          keep the whole body in each recorded request (state.requests[n].body); default false
// A field the server does not accept (library: mock.refuseParam(name, { message, on })): every request with that top-level field is answered HTTP 400 naming it,
// until mock.clearRefusals(). It is what a provider that has no "thinking effort" does with `reasoning_effort` or `output_config`.
// Faults, for the failures that only happen on a real network (library: mock.inject(spec); a scenario step may carry `fault: spec`):
//   { kind: 'stall', afterEvents }      the stream (or the body) stops after N events and nothing more is sent until the client gives up
//   { kind: 'cut', afterEvents, reset } the stream ends before its terminal event (reset: the connection is torn down instead)
//   { kind: 'payload-too-large' }       HTTP 413 in the protocol's own error format
//   { kind: 'stream-unsupported' }      HTTP 400 to a request with stream: true, "stream not supported" (a request without it passes)
//   { kind: 'status', status, message, headers }   any other HTTP status
//   common: on ('chat'|'anthropic'|'responses', default any), stream (true|false, default any), times (default 1)
// Control (loopback test traffic only):
//   GET  /__ping       {ok:true}
//   GET  /__requests   what the Hub has sent so far
//   GET  /__last       the body of the latest model request
//   POST /__scenario   {"name": "..."}  switch scenario and forget the recorded requests
//   POST /__watch      {"needles": ["...", ...]}  from now on, report whether any request body contains one of them
//   GET  /__watch      {watching, scanned, hits:[{needle: <index>, request: <number>}]}
// The watch exists to prove that a secret never left the machine inside a model request. It reports positions, never the
// needle's text, and `scanned` says how many requests were actually looked at, so "no hits" cannot be an empty promise.
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SCENARIOS, call } from './scenarios.mjs';
import { createThinkingSigner, errorBody, validateAnthropicRequest, validateChatRequest, validateGeminiRequest, validateResponsesRequest } from './protocol-validators.mjs';

export const MODEL_IDS = Object.freeze(['mock-coder', 'mock-coder-small']);
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const DEFAULT_STRICT = Object.freeze({ chat: false, anthropic: true, responses: true, gemini: true });
const PIECE = 8;

const contentText = (message) => {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('\n');
  return '';
};
const toolNames = (body) => (Array.isArray(body?.tools) ? body.tools : [])
  .flatMap((tool) => (Array.isArray(tool?.functionDeclarations) ? tool.functionDeclarations : [tool]))
  .map((tool) => tool?.function?.name ?? tool?.name).filter(Boolean);

/** What a scenario is allowed to see, from a conversation in the Chat Completions shape (system, user, assistant, tool). */
function describeMessages(messages, tools) {
  let lastUser = -1;
  messages.forEach((message, index) => { if (message?.role === 'user') lastUser = index; });
  const results = messages.slice(lastUser + 1).filter((message) => message?.role === 'tool').map(contentText);
  return {
    prompt: lastUser >= 0 ? contentText(messages[lastUser]) : '',
    // Every user-role message, oldest first. A continued conversation carries the Hub's notes about the earlier run in a
    // user message of its own, before the person's new request.
    users: messages.filter((message) => message?.role === 'user').map(contentText),
    turn: results.length,
    results,
    last: results.at(-1) ?? '',
    tools,
    system: messages.filter((message) => message?.role === 'system').map(contentText).join('\n'),
  };
}

export function describeConversation(body) {
  return describeMessages(Array.isArray(body?.messages) ? body.messages : [], toolNames(body));
}

/** Anthropic, Responses and Gemini carry the same conversation in another shape; this puts it in the Chat shape so one scenario serves all. */
function chatShape(protocol, body) {
  if (protocol === 'chat') return Array.isArray(body?.messages) ? body.messages : [];
  const messages = [];
  if (protocol === 'gemini') {
    const system = (Array.isArray(body?.systemInstruction?.parts) ? body.systemInstruction.parts : []).map((part) => part?.text ?? '').join('\n');
    if (system) messages.push({ role: 'system', content: system });
    for (const content of Array.isArray(body?.contents) ? body.contents : []) {
      const parts = Array.isArray(content?.parts) ? content.parts : [];
      if (content?.role === 'model') { messages.push({ role: 'assistant', content: parts.filter((part) => typeof part?.text === 'string' && part.thought !== true).map((part) => part.text).join('') }); continue; }
      // function responses lead a user turn like tool results do; the text after them is the person (or the host) speaking
      for (const part of parts) {
        if (part?.functionResponse) messages.push({ role: 'tool', tool_call_id: part.functionResponse.id, content: typeof part.functionResponse.response?.output === 'string' ? part.functionResponse.response.output : JSON.stringify(part.functionResponse.response ?? {}) });
      }
      const text = parts.filter((part) => typeof part?.text === 'string').map((part) => part.text).join('\n');
      if (text) messages.push({ role: 'user', content: text });
    }
    return messages;
  }
  if (protocol === 'anthropic') {
    const system = typeof body?.system === 'string' ? body.system : Array.isArray(body?.system) ? body.system.map((block) => block?.text ?? '').join('\n') : '';
    if (system) messages.push({ role: 'system', content: system });
    for (const message of Array.isArray(body?.messages) ? body.messages : []) {
      if (typeof message?.content === 'string' || !Array.isArray(message?.content)) { messages.push({ role: message?.role, content: contentText(message) }); continue; }
      if (message.role === 'user') {
        // tool_result blocks lead the message; a user message made only of them is not "the person speaking"
        for (const block of message.content) if (block?.type === 'tool_result') messages.push({ role: 'tool', tool_call_id: block.tool_use_id, content: typeof block.content === 'string' ? block.content : contentText({ content: block.content }) });
        const rest = message.content.filter((block) => block?.type !== 'tool_result');
        if (rest.length) messages.push({ role: 'user', content: contentText({ content: rest }) });
      } else messages.push({ role: message.role, content: contentText({ content: message.content.filter((block) => block?.type === 'text') }) });
    }
    return messages;
  }
  if (body?.instructions) messages.push({ role: 'system', content: String(body.instructions) });
  const items = typeof body?.input === 'string' ? [{ role: 'user', content: body.input }] : Array.isArray(body?.input) ? body.input : [];
  for (const item of items) {
    if (item?.type === 'function_call_output') messages.push({ role: 'tool', tool_call_id: item.call_id, content: typeof item.output === 'string' ? item.output : contentText({ content: item.output }) });
    else if ((item?.type === 'message' || item?.type === undefined) && item.role) messages.push({ role: item.role === 'developer' ? 'system' : item.role, content: contentText(item) });
  }
  return messages;
}

export function describeProtocolConversation(protocol, body) {
  return describeMessages(chatShape(protocol, body), toolNames(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { reject(Object.assign(new Error('request too large'), { statusCode: 413 })); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Reads a JSON request body and also hands back the exact text that was sent (the watch scans the text, not the parsed copy). */
async function readJsonWithText(req) {
  const text = await readBody(req);
  if (!text.trim()) return { text, json: {} };
  try { return { text, json: JSON.parse(text) }; } catch { throw Object.assign(new Error('body is not JSON'), { statusCode: 400 }); }
}
const readJson = async (req) => (await readJsonWithText(req)).json;

const pieces = (text, size = PIECE) => { const out = []; for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size)); return out; };
const tick = () => new Promise((resolve) => setImmediate(resolve));
const protocolOf = (route) => (route.endsWith('/chat/completions') ? 'chat' : route.endsWith('/messages') ? 'anthropic' : route.endsWith('/responses') ? 'responses' : route.endsWith(':generateContent') ? 'gemini' : null);

export async function startMockModel({ scenario = 'repair-add', scenarios: extra = {}, host = '127.0.0.1', port = 0, models = MODEL_IDS, strict = undefined, chatDialect = 'openai', streamUsage = 'on-request', keepBodies = false } = {}) {
  // `scenarios` lets a test bring its own scripted behaviour (a closure over the paths it created) next to the shared ones.
  const registry = { ...SCENARIOS, ...extra };
  if (!registry[scenario]) throw new Error(`unknown scenario "${scenario}"`);
  const state = { scenario, requests: [], lastBody: null, callCounter: 0, itemCounter: 0, needles: [], hits: [], scanned: 0, rejections: [], faultLog: [] };
  const strictness = typeof strict === 'boolean' ? { chat: strict, anthropic: strict, responses: strict } : { ...DEFAULT_STRICT, ...(strict ?? {}) };
  const faults = [];
  // Parameters this server does not accept, until cleared (mock.refuseParam): a provider that refuses a field refuses it every time, not once.
  const refusals = [];
  const signer = createThinkingSigner();

  /** A short needle would match ordinary text and make a clean report meaningless in the other direction, so it is refused. */
  const setNeedles = (needles) => {
    if (!Array.isArray(needles) || needles.some((needle) => typeof needle !== 'string' || needle.length < 6)) throw Object.assign(new Error('needles must be an array of strings of at least 6 characters'), { statusCode: 400 });
    state.needles = needles.slice(0, 50);
    state.hits = [];
    state.scanned = 0;
  };

  /** Looks for each watched needle in the raw request text, in both its plain and its JSON-escaped spelling. */
  const scanForNeedles = (text, requestNumber) => {
    if (!state.needles.length) return;
    state.scanned += 1;
    state.needles.forEach((needle, index) => {
      const escaped = JSON.stringify(needle).slice(1, -1);
      if (text.includes(needle) || text.includes(escaped)) state.hits.push({ needle: index, request: requestNumber });
    });
  };

  // -------------------------------------------------------------------------------------------------------------------
  // What a step says, independent of the protocol: one plan feeds the JSON answer and the stream, so the two cannot disagree.
  // -------------------------------------------------------------------------------------------------------------------
  const planOf = (step, protocol) => {
    const raw = step ?? { text: '' };
    const usage = { input: 120, output: 24, cacheRead: 0, cacheWrite: 0, reasoning: 0, ...(raw.usage ?? {}) };
    const truncated = raw.stop === 'max_tokens';
    const list = Array.isArray(raw.calls) ? raw.calls : [];
    return {
      text: typeof raw.text === 'string' ? raw.text : null,
      thinking: typeof raw.thinking === 'string' ? raw.thinking : null,
      redacted: raw.redactedThinking === true,
      // A call that the limit cut off carries half of its arguments (a JSON text that does not parse).
      calls: list.map((entry) => {
        state.callCounter += 1;
        const json = JSON.stringify(entry.args ?? {});
        return { id: `${protocol === 'anthropic' ? 'toolu' : 'call'}_mock_${state.callCounter}`, name: entry.name, args: entry.args ?? {}, argumentsJson: truncated ? json.slice(0, Math.max(1, Math.floor(json.length / 2))) : json };
      }),
      usage, truncated,
    };
  };
  const inputTotal = (usage) => usage.input + usage.cacheRead + usage.cacheWrite;

  // ---- Chat Completions
  const chatCompletion = (plan, model) => {
    const message = { role: 'assistant', content: plan.text };
    if (plan.thinking !== null && chatDialect === 'compat') message.reasoning_content = plan.thinking;
    if (plan.calls.length) message.tool_calls = plan.calls.map((entry) => ({ id: entry.id, type: 'function', function: { name: entry.name, arguments: entry.argumentsJson } }));
    return {
      id: `chatcmpl-mock-${state.callCounter}-${state.requests.length}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
      choices: [{ index: 0, finish_reason: plan.truncated ? 'length' : plan.calls.length ? 'tool_calls' : 'stop', message }],
      usage: chatUsage(plan.usage),
    };
  };
  const chatUsage = (usage) => {
    const total = inputTotal(usage);
    const out = { prompt_tokens: total, completion_tokens: usage.output, total_tokens: total + usage.output };
    if (usage.cacheRead) out.prompt_tokens_details = { cached_tokens: usage.cacheRead };
    if (usage.reasoning) out.completion_tokens_details = { reasoning_tokens: usage.reasoning };
    return out;
  };
  const chatFrames = (plan, model, body) => {
    const id = `chatcmpl-mock-${state.callCounter}-${state.requests.length}`;
    const created = Math.floor(Date.now() / 1000);
    const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    const frames = [chunk({ role: 'assistant', content: plan.text === null ? null : '' })];
    if (plan.thinking !== null && chatDialect === 'compat') for (const piece of pieces(plan.thinking)) frames.push(chunk({ reasoning_content: piece }));
    if (plan.text) for (const piece of pieces(plan.text)) frames.push(chunk({ content: piece }));
    plan.calls.forEach((entry, index) => {
      frames.push(chunk({ tool_calls: [{ index, id: entry.id, type: 'function', function: { name: entry.name, arguments: '' } }] }));
      for (const piece of pieces(entry.argumentsJson)) frames.push(chunk({ tool_calls: [{ index, function: { arguments: piece } }] }));
    });
    frames.push(chunk({}, plan.truncated ? 'length' : plan.calls.length ? 'tool_calls' : 'stop'));
    if (body?.stream_options?.include_usage === true || streamUsage === 'always') frames.push(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: chatUsage(plan.usage) })}\n\n`);
    frames.push('data: [DONE]\n\n');
    return { frames, terminal: 1 };
  };

  // ---- Anthropic Messages
  const anthropicMessage = (plan, model) => {
    state.itemCounter += 1;
    const content = [];
    if (plan.thinking !== null) content.push({ type: 'thinking', thinking: plan.thinking, signature: signer.signThinking(plan.thinking) });
    if (plan.redacted) content.push({ type: 'redacted_thinking', data: signer.redacted(`r${state.itemCounter}`) });
    if (plan.text) content.push({ type: 'text', text: plan.text });
    for (const entry of plan.calls) content.push({ type: 'tool_use', id: entry.id, name: entry.name, input: plan.truncated ? {} : entry.args });
    return {
      id: `msg_mock_${state.itemCounter}`, type: 'message', role: 'assistant', model, content,
      stop_reason: plan.truncated ? 'max_tokens' : plan.calls.length ? 'tool_use' : 'end_turn', stop_sequence: null,
      usage: { input_tokens: plan.usage.input, output_tokens: plan.usage.output, cache_creation_input_tokens: plan.usage.cacheWrite, cache_read_input_tokens: plan.usage.cacheRead },
    };
  };
  const anthropicFrames = (plan, model) => {
    const message = anthropicMessage(plan, model);
    const frames = [];
    const emit = (event, data) => frames.push(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    emit('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { ...message.usage, output_tokens: 1 } } });
    message.content.forEach((block, index) => {
      if (block.type === 'text') {
        emit('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
        if (index === 0) emit('ping', { type: 'ping' });
        for (const piece of pieces(block.text)) emit('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: piece } });
      } else if (block.type === 'thinking') {
        emit('content_block_start', { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } });
        if (index === 0) emit('ping', { type: 'ping' });
        for (const piece of pieces(block.thinking)) emit('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: piece } });
        emit('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: block.signature } });
      } else if (block.type === 'redacted_thinking') {
        emit('content_block_start', { type: 'content_block_start', index, content_block: block });
        if (index === 0) emit('ping', { type: 'ping' });
      } else {
        const entry = plan.calls.find((candidate) => candidate.id === block.id);
        emit('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
        if (index === 0) emit('ping', { type: 'ping' });
        emit('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: '' } });
        for (const piece of pieces(entry.argumentsJson)) emit('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: piece } });
      }
      emit('content_block_stop', { type: 'content_block_stop', index });
    });
    emit('message_delta', { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: plan.usage.output } });
    emit('message_stop', { type: 'message_stop' });
    return { frames, terminal: 1 };
  };

  // ---- Responses
  const responsesObject = (plan, model, body) => {
    state.itemCounter += 1;
    const n = state.itemCounter;
    const status = plan.truncated ? 'incomplete' : 'completed';
    const output = [];
    if (plan.thinking !== null) {
      const item = { type: 'reasoning', id: `rs_mock_${n}`, summary: [{ type: 'summary_text', text: plan.thinking }] };
      if (Array.isArray(body?.include) && body.include.includes('reasoning.encrypted_content')) item.encrypted_content = `mock-encrypted-${n}`;
      output.push(item);
    }
    if (plan.text) output.push({ type: 'message', id: `msg_mock_${n}`, status, role: 'assistant', content: [{ type: 'output_text', text: plan.text, annotations: [] }] });
    plan.calls.forEach((entry, index) => output.push({ type: 'function_call', id: `fc_mock_${n}_${index}`, call_id: entry.id, name: entry.name, arguments: entry.argumentsJson, status }));
    const total = inputTotal(plan.usage);
    return {
      id: `resp_mock_${n}`, object: 'response', created_at: Math.floor(Date.now() / 1000), status, error: null,
      incomplete_details: plan.truncated ? { reason: 'max_output_tokens' } : null,
      instructions: body?.instructions ?? null, model, output, parallel_tool_calls: body?.parallel_tool_calls ?? true, store: body?.store ?? true, tool_choice: body?.tool_choice ?? 'auto', tools: body?.tools ?? [],
      usage: { input_tokens: total, input_tokens_details: { cached_tokens: plan.usage.cacheRead, cache_write_tokens: plan.usage.cacheWrite }, output_tokens: plan.usage.output, output_tokens_details: { reasoning_tokens: plan.usage.reasoning }, total_tokens: total + plan.usage.output },
    };
  };
  const responsesFrames = (plan, model, body) => {
    const response = responsesObject(plan, model, body);
    const frames = [];
    let sequence = 0;
    const emit = (type, data) => frames.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...data, sequence_number: sequence++ })}\n\n`);
    const started = { ...response, status: 'in_progress', output: [], usage: null, incomplete_details: null };
    emit('response.created', { response: started });
    emit('response.in_progress', { response: started });
    response.output.forEach((item, output_index) => {
      if (item.type === 'reasoning') {
        const text = item.summary[0].text;
        emit('response.output_item.added', { output_index, item: { type: 'reasoning', id: item.id, summary: [] } });
        emit('response.reasoning_summary_part.added', { item_id: item.id, output_index, summary_index: 0, part: { type: 'summary_text', text: '' } });
        for (const delta of pieces(text)) emit('response.reasoning_summary_text.delta', { item_id: item.id, output_index, summary_index: 0, delta });
        emit('response.reasoning_summary_text.done', { item_id: item.id, output_index, summary_index: 0, text });
        emit('response.reasoning_summary_part.done', { item_id: item.id, output_index, summary_index: 0, part: { type: 'summary_text', text } });
      } else if (item.type === 'message') {
        const text = item.content[0].text;
        emit('response.output_item.added', { output_index, item: { type: 'message', id: item.id, status: 'in_progress', role: 'assistant', content: [] } });
        emit('response.content_part.added', { item_id: item.id, output_index, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
        for (const delta of pieces(text)) emit('response.output_text.delta', { item_id: item.id, output_index, content_index: 0, delta, logprobs: [] });
        emit('response.output_text.done', { item_id: item.id, output_index, content_index: 0, text, logprobs: [] });
        emit('response.content_part.done', { item_id: item.id, output_index, content_index: 0, part: { type: 'output_text', text, annotations: [] } });
      } else {
        emit('response.output_item.added', { output_index, item: { ...item, arguments: '', status: 'in_progress' } });
        for (const delta of pieces(item.arguments)) emit('response.function_call_arguments.delta', { item_id: item.id, output_index, delta });
        emit('response.function_call_arguments.done', { item_id: item.id, output_index, name: item.name, arguments: item.arguments });
      }
      emit('response.output_item.done', { output_index, item });
    });
    emit(response.status === 'completed' ? 'response.completed' : 'response.incomplete', { response });
    return { frames, terminal: 1 };
  };

  // ---- Gemini generateContent (JSON only: the Hub's Gemini loop does not stream)
  const geminiResponse = (plan, model) => {
    const parts = [];
    if (plan.thinking !== null) parts.push({ text: plan.thinking, thought: true });
    if (plan.text) parts.push({ text: plan.text });
    plan.calls.forEach((entry, index) => {
      const functionCall = { name: entry.name, args: plan.truncated ? {} : entry.args };
      // As with Gemini 3: when the model thought, the first function call of the turn carries a thoughtSignature that is passed back with it.
      parts.push(index === 0 && plan.thinking !== null ? { functionCall, thoughtSignature: signer.signGemini(functionCall) } : { functionCall });
    });
    const total = inputTotal(plan.usage);
    const usageMetadata = { promptTokenCount: total };
    if (plan.usage.cacheRead) usageMetadata.cachedContentTokenCount = plan.usage.cacheRead;
    usageMetadata.candidatesTokenCount = plan.usage.output;
    if (plan.usage.reasoning) usageMetadata.thoughtsTokenCount = plan.usage.reasoning;
    usageMetadata.totalTokenCount = total + plan.usage.output + plan.usage.reasoning;
    return {
      candidates: [{ content: { role: 'model', parts }, finishReason: plan.truncated ? 'MAX_TOKENS' : 'STOP', index: 0 }],
      usageMetadata, modelVersion: model ?? 'mock-gemini', responseId: `resp_mock_${state.callCounter}_${state.requests.length}`,
    };
  };

  const PROTOCOLS = {
    gemini: {
      validate: (body) => validateGeminiRequest(body, { signer }),
      json: (plan, model) => geminiResponse(plan, model),
      stream: null,
      count: (body) => (Array.isArray(body?.contents) ? body.contents.length : 0),
    },
    chat: {
      validate: (body) => validateChatRequest(body, { dialect: chatDialect }),
      json: (plan, model) => chatCompletion(plan, model),
      stream: (plan, model, body) => chatFrames(plan, model, body),
      count: (body) => (Array.isArray(body?.messages) ? body.messages.length : 0),
    },
    anthropic: {
      validate: (body) => validateAnthropicRequest(body, { signer }),
      json: (plan, model) => anthropicMessage(plan, model),
      stream: (plan, model) => anthropicFrames(plan, model),
      count: (body) => (Array.isArray(body?.messages) ? body.messages.length : 0),
    },
    responses: {
      validate: (body) => validateResponsesRequest(body),
      json: (plan, model, body) => responsesObject(plan, model, body),
      stream: (plan, model, body) => responsesFrames(plan, model, body),
      count: (body) => (Array.isArray(body?.input) ? body.input.length : body?.input === undefined ? 0 : 1),
    },
  };

  // ---- Faults
  const takeFault = (protocol, stream) => {
    const fault = faults.find((candidate) => candidate.remaining > 0 && (!candidate.on || candidate.on === protocol)
      && (candidate.stream === undefined || candidate.stream === stream) && (candidate.kind !== 'stream-unsupported' || stream));
    if (!fault) return null;
    fault.remaining -= 1;
    fault.used += 1;
    return fault;
  };
  const statusBody = (protocol, fault) => {
    if (fault.kind === 'payload-too-large') {
      if (protocol === 'gemini') return { status: 413, body: errorBody('gemini', { message: 'Request payload size exceeds the limit: 20971520 bytes.', status: 413 }) };
      return { status: 413, body: protocol === 'anthropic'
        ? errorBody('anthropic', { type: 'request_too_large', message: 'Request exceeds the maximum allowed number of bytes.' })
        : errorBody(protocol, { message: 'Request too large: the request body exceeds the size this endpoint accepts.', code: 'request_too_large' }) };
    }
    if (fault.kind === 'stream-unsupported') {
      return { status: 400, body: protocol === 'anthropic'
        ? errorBody('anthropic', { message: 'stream: streaming is not supported by this endpoint' })
        : errorBody(protocol, { message: "Unsupported value: 'stream' does not support true with this model. Supported values are: false.", param: 'stream', code: 'unsupported_value' }) };
    }
    const status = fault.status ?? 500;
    const type = fault.type ?? (status >= 500 ? 'api_error' : 'invalid_request_error');
    return { status, body: errorBody(protocol, { message: fault.message ?? 'mock failure', type, status }), headers: fault.headers };
  };

  const server = http.createServer(async (req, res) => {
    const reply = (status, body, headers = {}) => {
      const text = JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store', ...headers });
      res.end(text);
    };

    /** The answer as a JSON body, or the part of it that a mid-answer fault lets through. */
    const sendJson = async (body, fault) => {
      const text = JSON.stringify(body);
      if (!fault || (fault.kind !== 'stall' && fault.kind !== 'cut')) { reply(200, body); return; }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store' });
      res.write(text.slice(0, Math.max(1, Math.floor(text.length / 2))));
      if (fault.kind === 'cut') { res.destroy(); return; }
      await new Promise((resolve) => { res.on('close', resolve); if (Number.isFinite(fault.ms)) setTimeout(resolve, fault.ms); });
      if (!res.destroyed) { res.write(text.slice(Math.max(1, Math.floor(text.length / 2)))); res.end(); }
    };

    /** The answer as SSE. A fault stops it after `afterEvents` events: a stall waits, a cut ends the stream (or tears the connection down). */
    const sendStream = async ({ frames, terminal }, fault) => {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
      const limit = fault && (fault.kind === 'stall' || fault.kind === 'cut')
        ? Math.min(frames.length, Number.isInteger(fault.afterEvents) ? fault.afterEvents : fault.kind === 'cut' ? frames.length - terminal : 1)
        : frames.length;
      for (let i = 0; i < limit; i += 1) {
        if (res.destroyed) return;
        res.write(frames[i]);
        await tick();
      }
      if (fault?.kind === 'cut') { if (fault.reset) res.destroy(); else res.end(); return; }
      if (fault?.kind === 'stall') {
        await new Promise((resolve) => { res.on('close', resolve); if (Number.isFinite(fault.ms)) setTimeout(resolve, fault.ms); });
        if (res.destroyed) return;
        for (let i = limit; i < frames.length; i += 1) { res.write(frames[i]); await tick(); }
      }
      res.end();
    };

    try {
      const url = new URL(req.url, 'http://mock.invalid');
      const route = url.pathname.replace(/\/+$/, '');
      if (req.method === 'GET' && route === '/__ping') return reply(200, { ok: true });
      if (req.method === 'GET' && route === '/__requests') return reply(200, { scenario: state.scenario, requests: state.requests });
      if (req.method === 'GET' && route === '/__last') return reply(200, state.lastBody);
      if (req.method === 'POST' && route === '/__scenario') {
        const { name } = await readJson(req);
        if (!registry[name]) return reply(400, { error: { message: `unknown scenario "${name}"`, known: Object.keys(registry) } });
        state.scenario = name;
        state.requests.length = 0;
        state.lastBody = null;
        return reply(200, { scenario: name });
      }
      if (route === '/__watch' && req.method === 'POST') {
        setNeedles((await readJson(req)).needles);
        return reply(200, { watching: state.needles.length });
      }
      if (route === '/__watch' && req.method === 'GET') return reply(200, { watching: state.needles.length, scanned: state.scanned, hits: state.hits });
      if (req.method === 'GET' && route.endsWith('/models')) return reply(200, { object: 'list', data: models.map((id) => ({ id, object: 'model', owned_by: 'mock' })) });
      const protocol = req.method === 'POST' ? protocolOf(route) : null;
      if (protocol) {
        const adapter = PROTOCOLS[protocol];
        const { text: rawBody, json: body } = await readJsonWithText(req);
        // generateContent is never a stream (streaming is another method) and carries its model in the URL, not in the body.
        const stream = protocol !== 'gemini' && body?.stream === true;
        const model = body?.model ?? (protocol === 'gemini' ? decodeURIComponent(/\/models\/([^/:]+):generateContent$/.exec(route)?.[1] ?? '') || null : null);
        const info = describeProtocolConversation(protocol, body);
        const probe = info.tools.includes('record_probe');
        state.lastBody = body;
        const record = {
          at: new Date().toISOString(), model, probe, turn: info.turn, tools: info.tools, messages: adapter.count(body),
          hasAuthorization: Boolean(req.headers.authorization || req.headers['x-api-key'] || req.headers['x-goog-api-key']), promptStart: info.prompt.slice(0, 160),
          protocol, stream, bytes: Buffer.byteLength(rawBody), rejected: null, fault: null,
          // The whole body, for a test that looks at one field of every request (keepBodies: true); never by default, a long run would hold them all.
          ...(keepBodies ? { body } : {}),
        };
        state.requests.push(record);
        const number = state.requests.length;
        scanForNeedles(rawBody, number);

        // A gateway's own refusal (413, "stream not supported", any status) comes before it reads the request.
        const fault = takeFault(protocol, stream);
        if (fault) { record.fault = fault.kind; state.faultLog.push({ kind: fault.kind, protocol, request: number }); }
        if (fault && ['payload-too-large', 'stream-unsupported', 'status'].includes(fault.kind)) {
          const { status, body: errorJson, headers } = statusBody(protocol, fault);
          return reply(status, errorJson, headers);
        }
        // A provider that does not accept a field says so before it reads the rest, in the protocol's own error format, naming the field.
        const refusal = body && typeof body === 'object' ? refusals.find((entry) => Object.hasOwn(body, entry.param) && (!entry.on || entry.on === protocol)) : undefined;
        if (refusal) {
          refusal.used += 1;
          record.fault = 'refuse-param';
          state.faultLog.push({ kind: 'refuse-param', protocol, request: number });
          return reply(400, errorBody(protocol, { message: refusal.message, param: refusal.param }));
        }
        if (strictness[protocol] === true) {
          const outcome = adapter.validate(body);
          if (!outcome.ok) {
            const [first] = outcome.errors;
            record.rejected = { rule: first.rule, message: first.message };
            state.rejections.push({ request: number, protocol, errors: outcome.errors });
            return reply(first.status ?? 400, errorBody(protocol, first));
          }
        }
        let step;
        if (probe) step = call('record_probe', { value: 'ok' });
        // A request that offers no tools (the Hub's connectivity check) can only be answered in text, as with a real model.
        else if (!info.tools.length) step = { text: 'OK' };
        else step = await registry[state.scenario]({ ...info, protocol, stream });
        if (step?.http) return reply(step.http.status ?? 500, step.http.body ?? { error: { message: 'mock failure' } }, step.http.headers);
        const inline = step?.fault ? { times: 1, remaining: 1, used: 1, ...step.fault } : null;
        const midway = (fault && (fault.kind === 'stall' || fault.kind === 'cut') ? fault : null) ?? inline;
        if (inline) { record.fault = inline.kind; state.faultLog.push({ kind: inline.kind, protocol, request: number }); }
        const plan = planOf(step ?? { text: '' }, protocol);
        if (stream) return await sendStream(adapter.stream(plan, model, body), midway);
        return await sendJson(adapter.json(plan, model, body), midway);
      }
      return reply(404, { error: { message: `no route for ${req.method} ${url.pathname}` } });
    } catch (error) {
      if (res.headersSent) { res.destroy(); return undefined; }
      return reply(error?.statusCode ?? 500, { error: { message: String(error?.message ?? error) } });
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  const boundPort = server.address().port;
  const origin = `http://${host}:${boundPort}`;
  return {
    url: `${origin}/v1`, origin, port: boundPort, state,
    /** Signs and verifies the thinking blocks this server issues (a test that builds a request by hand uses it). */
    signer,
    setScenario(name) {
      if (!registry[name]) throw new Error(`unknown scenario "${name}"`);
      state.scenario = name; state.requests.length = 0; state.lastBody = null;
    },
    /** Adds or replaces a scenario while the server is running. */
    define(name, fn) {
      if (typeof fn !== 'function') throw new TypeError('a scenario is a function');
      registry[name] = fn;
    },
    /** Which protocols refuse invalid requests, changed while the server is running. */
    setStrict(protocol, value) { strictness[protocol] = value === true; },
    /** Arms a fault (see the top of this file). Returns it: `used` says how many requests it has hit. */
    inject(spec) {
      if (!spec || typeof spec.kind !== 'string') throw new TypeError('a fault needs a kind');
      const fault = { ...spec, remaining: spec.times ?? 1, used: 0 };
      faults.push(fault);
      return fault;
    },
    clearFaults() { faults.length = 0; },
    /**
     * From now on a request that has this top-level field is answered HTTP 400 naming it, whatever else it holds ("Unsupported parameter",
     * "Extra inputs are not permitted"), until clearRefusals(). `on` limits it to one protocol ('chat' | 'anthropic' | 'responses' | 'gemini').
     * Returns the entry: `used` says how many requests it has refused.
     */
    refuseParam(param, { message = `Unsupported parameter: '${param}'.`, on = null } = {}) {
      if (typeof param !== 'string' || !param) throw new TypeError('a refused parameter needs a name');
      const entry = { param, message, on, used: 0 };
      refusals.push(entry);
      return entry;
    },
    clearRefusals() { refusals.length = 0; },
    /** Starts watching request bodies for these strings (see /__watch). */
    watch: setNeedles,
    watchReport: () => ({ watching: state.needles.length, scanned: state.scanned, hits: state.hits.map((hit) => ({ ...hit })) }),
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

// ----------------------------------------------------------------------------------------------------------------
// Command line
// ----------------------------------------------------------------------------------------------------------------
const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const args = process.argv.slice(2);
  const option = (name, fallback) => { const at = args.indexOf(name); return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback; };
  const mock = await startMockModel({ scenario: option('--scenario', 'repair-add'), port: Number(option('--port', '0')), strict: args.includes('--strict') ? true : undefined });
  console.log(`READY ${JSON.stringify({ url: mock.url, origin: mock.origin, port: mock.port, scenario: mock.state.scenario })}`);
  const stop = () => mock.close().finally(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
