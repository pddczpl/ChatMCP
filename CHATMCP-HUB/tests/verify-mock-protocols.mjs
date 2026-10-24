// Protocol-faithful mock model servers (tests/e2e/mock-model-server.mjs, protocol-validators.mjs, scenarios.mjs).
//
// The mock sits at the NETWORK: the adapters under test (respondStandard, respondOpenAIResponses, GatewayProvider) stay real, so a
// defect shows up where it happens. This suite proves four things:
//   1. Every validator rule rejects what the real API rejects and accepts what it accepts: one accept and one reject fixture each.
//   2. The servers (Chat Completions, Anthropic Messages, Responses, Gemini generateContent) answer in the real wire format, as JSON
//      and (all but Gemini, whose adapter does not stream) as SSE, with cache usage fields, thinking blocks with signatures,
//      reasoning summaries, parallel calls and truncation.
//   3. Real adapters complete six canned conversations against them (and are refused when they would be refused for real).
//   4. Faults at the network (idle stall, a cut before the terminal event, 413, 400 "stream not supported") reach the adapters.
//
// Where a rule or an error text comes from is written next to it in protocol-validators.mjs. Where the vendor documents a rule, the
// URL is there; where only a community report or experience confirms it, the comment says so.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  RULES, accumulateAnthropicStream, accumulateChatStream, accumulateGeminiStream, accumulateResponsesStream, createThinkingSigner, errorBody, parseSse,
  validateAnthropicRequest, validateAnthropicStream, validateChatRequest, validateChatStream, validateGeminiRequest, validateGeminiStream, validateResponsesRequest, validateResponsesStream,
} from './e2e/protocol-validators.mjs';
import { startMockModel } from './e2e/mock-model-server.mjs';
import { CANNED_CONVERSATIONS, SCENARIOS, call, redacted as withRedacted, say, thinking as withThinking, truncated } from './e2e/scenarios.mjs';
import { HistoryLedger } from '../lib/history-ledger.mjs';
import { respondStandard } from '../lib/standard-adapter.mjs';
import { respondOpenAIResponses } from '../lib/openai-responses-api.mjs';
import { anthropicHeaders } from '../lib/anthropic-api.mjs';
import { GatewayProvider } from '../lib/gateway-provider.mjs';
import { AgentRunner } from '../lib/agent.mjs';
import { buildChatBody } from '../lib/openai-chat-api.mjs';
import { pairToolCalls } from '../lib/model-history.mjs';

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
const note = (message) => console.log(`  note - ${message}`);

// ---------------------------------------------------------------------------------------------------------------------
// 1. Validator fixtures: every rule has at least one accept and one reject case
// ---------------------------------------------------------------------------------------------------------------------
const signer = createThinkingSigner('fixture-secret');
const VALIDATE = {
  chat: (body, options) => validateChatRequest(body, options),
  anthropic: (body, options) => validateAnthropicRequest(body, { signer, ...options }),
  responses: (body, options) => validateResponsesRequest(body, options),
  gemini: (body, options) => validateGeminiRequest(body, { signer, ...options }),
};

// ---- Chat Completions
const chatBase = () => ({ model: 'mock', messages: [{ role: 'system', content: 'You are a test.' }, { role: 'user', content: 'Hi' }] });
const readTool = { type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } };
const tc = (id, args = '{"path":"a"}') => ({ type: 'function', id, function: { name: 'read_file', arguments: args } });
const assistantCalls = (...ids) => ({ role: 'assistant', content: null, tool_calls: ids.map((id) => tc(id)) });
const toolMsg = (id, content = 'result') => ({ role: 'tool', tool_call_id: id, content });
const chatWith = (...messages) => ({ ...chatBase(), messages: [...chatBase().messages, ...messages] });

// ---- Anthropic Messages
const anthBase = () => ({ model: 'mock', max_tokens: 1024, messages: [{ role: 'user', content: 'Hi' }] });
const anthTool = { name: 'read_file', description: 'Read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } };
const use = (id, name = 'read_file', input = { path: 'a' }) => ({ type: 'tool_use', id, name, input });
const result = (id, content = 'result') => ({ type: 'tool_result', tool_use_id: id, content });
const anthWith = (...messages) => ({ ...anthBase(), messages: [...anthBase().messages, ...messages] });
const thinkingBlock = (text = 'I should read the file.') => ({ type: 'thinking', thinking: text, signature: signer.signThinking(text) });

// ---- Responses
const respBase = () => ({ model: 'mock', input: [{ role: 'user', content: 'Hi' }], store: false });
const fcall = (id, args = '{"path":"a"}') => ({ type: 'function_call', call_id: id, name: 'read_file', arguments: args });
const fout = (id, output = 'result') => ({ type: 'function_call_output', call_id: id, output });
const respWith = (...items) => ({ ...respBase(), input: [...respBase().input, ...items] });
const respTool = { type: 'function', name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } }, strict: false };

// ---- Gemini generateContent
const geminiBase = () => ({ contents: [{ role: 'user', parts: [{ text: 'Hi' }] }] });
const geminiTool = { functionDeclarations: [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }] };
const gcall = (name = 'read_file', args = { path: 'a' }) => ({ functionCall: { name, args } });
const gresp = (name = 'read_file', output = 'result') => ({ functionResponse: { name, response: { output } } });
const geminiWith = (...contents) => ({ ...geminiBase(), contents: [...geminiBase().contents, ...contents] });

// A fixture: [label, body, options?]. A reject fixture also says a piece of the message that the API's own text contains.
const FIXTURES = {
  // Chat Completions ---------------------------------------------------------------------------------------------------
  'chat.unknown_param': {
    api: 'chat',
    accept: [
      ['the parameters the Hub sends', { ...chatBase(), stream: false, tools: [readTool], tool_choice: 'auto' }],
      ['sampling, limits and stream options on a stream', { ...chatBase(), temperature: 0.2, max_completion_tokens: 100, stream: true, stream_options: { include_usage: true } }],
    ],
    reject: [
      ['a parameter of another API (thinking)', { ...chatBase(), thinking: { type: 'enabled' } }, 'Unrecognized request argument supplied: thinking'],
      ['a made-up parameter', { ...chatBase(), made_up: 1 }, 'made_up'],
    ],
  },
  'chat.required': {
    api: 'chat',
    accept: [['model and one message', chatBase()]],
    reject: [
      ['no model', { messages: chatBase().messages }, "Missing required parameter: 'model'"],
      ['no messages', { model: 'mock' }, "Missing required parameter: 'messages'"],
      ['an empty list of messages', { model: 'mock', messages: [] }, 'messages'],
    ],
  },
  'chat.message_fields': {
    api: 'chat',
    accept: [
      ['user content as a list of text and image parts', chatWith({ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==', detail: 'auto' } }] })],
      ['an assistant message that only carries calls, then their results', chatWith(assistantCalls('a'), toolMsg('a'))],
    ],
    reject: [
      ['an unknown role', chatWith({ role: 'robot', content: 'x' }), "Invalid value: 'robot'"],
      ['an unknown field on a user message', chatWith({ role: 'user', content: 'x', foo: 1 }), "Additional properties are not allowed ('foo' was unexpected)"],
      ['reasoning_content on an OpenAI message (DeepSeek only)', chatWith({ role: 'assistant', content: 'x', reasoning_content: 'because' }), 'reasoning_content'],
      ['a tool message with no tool_call_id', chatWith(assistantCalls('a'), { role: 'tool', content: 'x' }), 'tool_call_id'],
      ['an assistant message with neither content nor calls', chatWith({ role: 'assistant', content: null }), 'content'],
      ['tool call arguments sent as an object', chatWith({ role: 'assistant', content: null, tool_calls: [{ type: 'function', id: 'a', function: { name: 'read_file', arguments: { path: 'a' } } }] }, toolMsg('a')), 'arguments'],
    ],
  },
  'chat.tool_result_placement': {
    api: 'chat',
    accept: [
      ['calls, all their results, then a user message', chatWith(assistantCalls('a', 'b'), toolMsg('a'), toolMsg('b'), { role: 'user', content: 'HOST HINT' })],
      ['two turns of calls', chatWith(assistantCalls('a'), toolMsg('a'), assistantCalls('b'), toolMsg('b'))],
    ],
    reject: [
      ['a user message between two results (the defect the ledger fixes)', chatWith(assistantCalls('a', 'b'), toolMsg('a'), { role: 'user', content: 'HOST HINT' }, toolMsg('b')),
        "An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'. The following tool_call_ids did not have response messages: b"],
      ['a tool message with no assistant message that asked for it', chatWith(toolMsg('a')), "messages with role 'tool' must be a response to a preceeding message with 'tool_calls'"],
      ['a second result for one call', chatWith(assistantCalls('a'), toolMsg('a'), toolMsg('a')), "messages with role 'tool' must be a response to a preceeding message with 'tool_calls'"],
      ['calls that nothing answers (end of the list)', chatWith(assistantCalls('a')), 'did not have response messages: a'],
      ['a result for an id the assistant never used', chatWith(assistantCalls('a'), toolMsg('z')), "messages with role 'tool' must be a response"],
    ],
  },
  'chat.tool_choice_needs_tools': {
    api: 'chat',
    accept: [['tool_choice with tools', { ...chatBase(), tools: [readTool], tool_choice: 'auto' }], ['neither', chatBase()]],
    reject: [['tool_choice without tools', { ...chatBase(), tool_choice: 'auto' }, "'tool_choice' is only allowed when 'tools' are specified"]],
  },
  'chat.reasoning_effort': {
    api: 'chat',
    accept: [['a documented level', { ...chatBase(), reasoning_effort: 'high' }], ['none, where the model allows no thinking', { ...chatBase(), reasoning_effort: 'none' }], ['no field', chatBase()]],
    reject: [
      ['a level that does not exist', { ...chatBase(), reasoning_effort: 'extreme' }, "Invalid value: 'extreme'"],
      ['max, which is not a level of the OpenAI API', { ...chatBase(), reasoning_effort: 'max' }, "Invalid value: 'max'"],
    ],
  },
  'chat.stream_options_need_stream': {
    api: 'chat',
    accept: [['stream_options on a stream', { ...chatBase(), stream: true, stream_options: { include_usage: true } }]],
    reject: [['stream_options on a request that is not a stream', { ...chatBase(), stream_options: { include_usage: true } }, "'stream_options' parameter is only allowed when 'stream' is enabled"]],
  },
  'chat.tool_definition': {
    api: 'chat',
    accept: [['a function tool', { ...chatBase(), tools: [readTool] }]],
    reject: [
      ['a tool name with characters the API refuses', { ...chatBase(), tools: [{ type: 'function', function: { name: 'read file!', parameters: { type: 'object' } } }] }, 'name'],
      ['a tool without its function', { ...chatBase(), tools: [{ type: 'function' }] }, 'function'],
      ['a tool of an unknown type', { ...chatBase(), tools: [{ type: 'gadget', function: { name: 'x' } }] }, "Invalid value: 'gadget'"],
    ],
  },

  // Anthropic Messages --------------------------------------------------------------------------------------------------
  'anthropic.output_config': {
    api: 'anthropic',
    accept: [
      ['effort high', { ...anthBase(), output_config: { effort: 'high' } }],
      ['effort max', { ...anthBase(), output_config: { effort: 'max' } }],
      ['output_config with another key and no effort', { ...anthBase(), output_config: { format: { type: 'json_schema', schema: { type: 'object' } } } }],
    ],
    reject: [
      ['an effort that Claude does not have', { ...anthBase(), output_config: { effort: 'minimal' } }, 'output_config.effort'],
      ['none, which is not a Claude level either', { ...anthBase(), output_config: { effort: 'none' } }, 'output_config.effort'],
      ['output_config that is not an object', { ...anthBase(), output_config: 'high' }, 'output_config'],
    ],
  },
  'anthropic.unknown_param': {
    api: 'anthropic',
    accept: [['the parameters the Hub sends', { ...anthBase(), system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }], tools: [anthTool], tool_choice: { type: 'auto', disable_parallel_tool_use: true }, stream: true }]],
    reject: [
      ['an OpenAI parameter (parallel_tool_calls)', { ...anthBase(), parallel_tool_calls: false }, 'parallel_tool_calls: Extra inputs are not permitted'],
      ['an OpenAI parameter (stream_options)', { ...anthBase(), stream_options: { include_usage: true } }, 'stream_options: Extra inputs are not permitted'],
    ],
  },
  'anthropic.required': {
    api: 'anthropic',
    accept: [['model, max_tokens and one message', anthBase()]],
    reject: [
      ['no max_tokens', { model: 'mock', messages: anthBase().messages }, 'max_tokens: Field required'],
      ['max_tokens of zero', { ...anthBase(), max_tokens: 0 }, 'max_tokens'],
      ['no model', { max_tokens: 10, messages: anthBase().messages }, 'model: Field required'],
      ['no messages', { model: 'mock', max_tokens: 10 }, 'messages: Field required'],
      ['an empty list of messages', { model: 'mock', max_tokens: 10, messages: [] }, 'messages'],
    ],
  },
  'anthropic.content_blocks': {
    api: 'anthropic',
    accept: [
      ['text and an image in one user message', { ...anthBase(), messages: [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }] }] }],
      ['string content', { ...anthBase(), messages: [{ role: 'user', content: 'plain' }] }],
    ],
    reject: [
      ['an empty text block', { ...anthBase(), messages: [{ role: 'user', content: [{ type: 'text', text: '' }] }] }, 'text content blocks must be non-empty'],
      ['a text block of white space', { ...anthBase(), messages: [{ role: 'user', content: [{ type: 'text', text: '  \n' }] }] }, 'text content blocks must contain non-whitespace text'],
      ['a block type that does not exist', { ...anthBase(), messages: [{ role: 'user', content: [{ type: 'hologram' }] }] }, 'hologram'],
      ['a tool role (Anthropic has none)', { ...anthBase(), messages: [{ role: 'tool', content: 'x' }] }, 'role'],
    ],
  },
  'anthropic.tool_result_placement': {
    api: 'anthropic',
    accept: [
      ['results first, then text, in the user message right after the calls', anthWith({ role: 'assistant', content: [use('toolu_a'), use('toolu_b')] }, { role: 'user', content: [result('toolu_a'), result('toolu_b'), { type: 'text', text: 'HOST HINT' }] })],
    ],
    reject: [
      ['text before the results', anthWith({ role: 'assistant', content: [use('toolu_a')] }, { role: 'user', content: [{ type: 'text', text: 'Here are the results:' }, result('toolu_a')] }), 'tool_result` blocks must come first'],
      ['one call left without its result', anthWith({ role: 'assistant', content: [use('toolu_a'), use('toolu_b')] }, { role: 'user', content: [result('toolu_a')] }), '`tool_use` ids were found without `tool_result` blocks immediately after: toolu_b'],
      ['a user message between the call and its result (the API merges two assistant turns in a row, so it must be a user turn)', anthWith({ role: 'assistant', content: [use('toolu_a')] }, { role: 'user', content: [{ type: 'text', text: 'wait' }] }, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, { role: 'user', content: [result('toolu_a')] }), '`tool_use` ids were found without `tool_result` blocks immediately after: toolu_a'],
      ['a result for a call nobody made', anthWith({ role: 'assistant', content: [use('toolu_a')] }, { role: 'user', content: [result('toolu_a'), result('toolu_zzz')] }), 'unexpected `tool_use_id` found in `tool_result` blocks: toolu_zzz'],
      ['calls with nothing after them', anthWith({ role: 'assistant', content: [use('toolu_a')] }), '`tool_use` ids were found without `tool_result` blocks immediately after: toolu_a'],
    ],
  },
  'anthropic.tool_use_id': {
    api: 'anthropic',
    accept: [['an id of letters, digits, _ and -', anthWith({ role: 'assistant', content: [use('toolu_01A-b_9')] }, { role: 'user', content: [result('toolu_01A-b_9')] })]],
    reject: [
      ['an id with a dot (a UUID from another provider)', anthWith({ role: 'assistant', content: [use('call.1')] }, { role: 'user', content: [result('call.1')] }), "String should match pattern '^[a-zA-Z0-9_-]+$'"],
      ['an id longer than 64 characters', anthWith({ role: 'assistant', content: [use('t'.repeat(65))] }, { role: 'user', content: [result('t'.repeat(65))] }), 'at most 64'],
    ],
  },
  'anthropic.thinking_signature': {
    api: 'anthropic',
    accept: [
      ['a signed thinking block echoed back with its tool call', { ...anthWith({ role: 'assistant', content: [thinkingBlock(), use('toolu_a')] }, { role: 'user', content: [result('toolu_a')] }), thinking: { type: 'adaptive' } }],
      ['thinking blocks of an EARLIER turn (the API accepts and filters them)', { ...anthWith({ role: 'assistant', content: [thinkingBlock('old'), { type: 'text', text: 'answer' }] }, { role: 'user', content: 'next question' }), thinking: { type: 'adaptive' } }],
      ['a redacted_thinking block the server issued', anthWith({ role: 'assistant', content: [{ type: 'redacted_thinking', data: signer.redacted('r1') }, use('toolu_a')] }, { role: 'user', content: [result('toolu_a')] })],
    ],
    reject: [
      ['a thinking block with no signature', anthWith({ role: 'assistant', content: [{ type: 'thinking', thinking: 'x' }, use('toolu_a')] }, { role: 'user', content: [result('toolu_a')] }), 'thinking.signature: Field required'],
      ['a signature nobody issued', anthWith({ role: 'assistant', content: [{ type: 'thinking', thinking: 'x', signature: 'forged' }, use('toolu_a')] }, { role: 'user', content: [result('toolu_a')] }), 'Invalid `signature` in `thinking` block'],
      ['thinking text edited after it was signed (latest assistant message)', anthWith({ role: 'assistant', content: [{ type: 'thinking', thinking: 'edited text', signature: signer.signThinking('the text that was signed') }, use('toolu_a')] }, { role: 'user', content: [result('toolu_a')] }), '`thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified'],
      ['a redacted_thinking block the server did not issue', anthWith({ role: 'assistant', content: [{ type: 'redacted_thinking', data: 'not-issued' }, use('toolu_a')] }, { role: 'user', content: [result('toolu_a')] }), 'Invalid `data` in `redacted_thinking` block'],
    ],
  },
  'anthropic.thinking_first': {
    api: 'anthropic',
    accept: [
      ['extended thinking on, the tool turn starts with its thinking block', { ...anthWith({ role: 'assistant', content: [thinkingBlock(), use('toolu_a')] }, { role: 'user', content: [result('toolu_a')] }), thinking: { type: 'enabled', budget_tokens: 2048 }, max_tokens: 4096 }],
      ['thinking off: no thinking block needed', anthWith({ role: 'assistant', content: [use('toolu_a')] }, { role: 'user', content: [result('toolu_a')] })],
      ['adaptive thinking relaxes the rule', { ...anthWith({ role: 'assistant', content: [use('toolu_a')] }, { role: 'user', content: [result('toolu_a')] }), thinking: { type: 'adaptive' } }],
    ],
    reject: [
      ['extended thinking on, the tool turn was sent back without its thinking block', { ...anthWith({ role: 'assistant', content: [use('toolu_a')] }, { role: 'user', content: [result('toolu_a')] }), thinking: { type: 'enabled', budget_tokens: 2048 }, max_tokens: 4096 }, 'Expected `thinking` or `redacted_thinking`, but found `tool_use`'],
    ],
  },
  'anthropic.thinking_config': {
    api: 'anthropic',
    accept: [['a budget of 2048 below max_tokens', { ...anthBase(), thinking: { type: 'enabled', budget_tokens: 2048 }, max_tokens: 4096 }]],
    reject: [
      ['a budget below the minimum of 1024', { ...anthBase(), thinking: { type: 'enabled', budget_tokens: 500 }, max_tokens: 4096 }, 'greater than or equal to 1024'],
      ['a budget that is not below max_tokens', { ...anthBase(), thinking: { type: 'enabled', budget_tokens: 4096 }, max_tokens: 4096 }, 'max_tokens must be greater than thinking.budget_tokens'],
      ['forced tool use with extended thinking', { ...anthBase(), thinking: { type: 'enabled', budget_tokens: 2048 }, max_tokens: 4096, tools: [anthTool], tool_choice: { type: 'any' } }, 'Thinking may not be enabled when tool_choice forces tool use'],
    ],
  },

  // Responses -----------------------------------------------------------------------------------------------------------
  'responses.unknown_param': {
    api: 'responses',
    accept: [['the parameters the Hub sends', { ...respBase(), instructions: 'sys', truncation: 'disabled', max_output_tokens: 256, stream: true, tools: [respTool], tool_choice: 'auto', parallel_tool_calls: false, include: ['reasoning.encrypted_content'] }]],
    reject: [
      ['a Chat Completions parameter (messages)', { ...respBase(), messages: [] }, "Unknown parameter: 'messages'."],
      ['an Anthropic parameter (max_tokens)', { ...respBase(), max_tokens: 10 }, "Unknown parameter: 'max_tokens'."],
    ],
  },
  'responses.input': {
    api: 'responses',
    accept: [
      ['a string input', { model: 'mock', input: 'Hi' }],
      ['messages, a reasoning item and a call with its result', respWith({ type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'enc' }, fcall('a'), fout('a'), { role: 'assistant', content: 'ok' })],
      ['a tool output as a list of content items', respWith(fcall('a'), { type: 'function_call_output', call_id: 'a', output: [{ type: 'input_text', text: 'result' }] })],
    ],
    reject: [
      ['no input', { model: 'mock' }, "Missing required parameter: 'input'."],
      ['an item of an unknown type', respWith({ type: 'hologram' }), "Invalid value: 'hologram'"],
      ['a tool role (the Responses API has none)', respWith({ role: 'tool', content: 'x' }), "Invalid value: 'tool'"],
      ['a call without its arguments', respWith({ type: 'function_call', call_id: 'a', name: 'read_file' }), 'arguments'],
      ['call arguments sent as an object', respWith({ type: 'function_call', call_id: 'a', name: 'read_file', arguments: { path: 'a' } }, fout('a')), 'arguments'],
    ],
  },
  'responses.tool_result_pairing': {
    api: 'responses',
    accept: [
      ['two calls, then both results, then a user message', respWith(fcall('a'), fcall('b'), fout('a'), fout('b'), { role: 'user', content: 'HOST HINT' })],
    ],
    reject: [
      ['a result with no call', respWith(fout('a')), 'No tool call found for function call output with call_id a.'],
      ['a result that comes before its call', respWith(fout('a'), fcall('a')), 'No tool call found for function call output with call_id a.'],
      ['a call with no result', respWith(fcall('a')), 'No tool output found for function call a.'],
      ['one of two calls left without a result', respWith(fcall('a'), fcall('b'), fout('a')), 'No tool output found for function call b.'],
    ],
  },
  'responses.tool_definition': {
    api: 'responses',
    accept: [['a function tool', { ...respBase(), tools: [respTool] }]],
    reject: [
      ['a function tool without a name', { ...respBase(), tools: [{ type: 'function', parameters: { type: 'object' } }] }, 'name'],
      ['a tool of an unknown type', { ...respBase(), tools: [{ type: 'gadget', name: 'x' }] }, "Invalid value: 'gadget'"],
      ['a Chat-style tool (the function nested under function)', { ...respBase(), tools: [readTool] }, "Missing required parameter: 'tools[0].name'"],
    ],
  },
  'responses.reasoning': {
    api: 'responses',
    accept: [
      ['effort low', { ...respBase(), reasoning: { effort: 'low' } }],
      ['effort and a summary', { ...respBase(), reasoning: { effort: 'medium', summary: 'auto' } }],
      ['none', { ...respBase(), reasoning: { effort: 'none' } }],
    ],
    reject: [
      ['an effort that does not exist', { ...respBase(), reasoning: { effort: 'extreme' } }, "Invalid value: 'extreme'"],
      ['a summary that does not exist', { ...respBase(), reasoning: { effort: 'low', summary: 'long' } }, "Invalid value: 'long'"],
      ['reasoning that is not an object', { ...respBase(), reasoning: 'high' }, "Invalid type for 'reasoning'"],
    ],
  },
  'responses.stream_options_need_stream': {
    api: 'responses',
    accept: [['stream_options on a stream', { ...respBase(), stream: true, stream_options: { include_obfuscation: false } }]],
    reject: [['stream_options on a request that is not a stream', { ...respBase(), stream_options: { include_obfuscation: false } }, 'stream_options']],
  },

  // Gemini generateContent ----------------------------------------------------------------------------------------------
  'gemini.unknown_field': {
    api: 'gemini',
    accept: [['the fields the Hub sends', { ...geminiBase(), systemInstruction: { parts: [{ text: 'sys' }] }, tools: [geminiTool], generationConfig: { maxOutputTokens: 8192 } }]],
    reject: [
      ['the model in the body (it is in the URL)', { ...geminiBase(), model: 'gemini-2.5-flash' }, 'Invalid JSON payload received. Unknown name "model": Cannot find field.'],
      ['an OpenAI field (messages)', { ...geminiBase(), messages: [] }, 'Unknown name "messages"'],
    ],
  },
  'gemini.contents': {
    api: 'gemini',
    accept: [['text and an inline image', { contents: [{ role: 'user', parts: [{ text: 'look' }, { inlineData: { mimeType: 'image/png', data: 'AA==' } }] }] }]],
    reject: [
      ['no contents', { systemInstruction: { parts: [{ text: 'sys' }] } }, 'contents is not specified'],
      ['a role Gemini does not have (assistant)', { contents: [{ role: 'user', parts: [{ text: 'a' }] }, { role: 'assistant', parts: [{ text: 'b' }] }] }, 'Please use a valid role: user, model.'],
      ['a turn with no parts', { contents: [{ role: 'user', parts: [] }] }, 'at least one parts field'],
      ['a part with two kinds of data', { contents: [{ role: 'user', parts: [{ text: 'a', functionCall: { name: 'f' } }] }] }, 'exactly one of'],
    ],
  },
  'gemini.function_turns': {
    api: 'gemini',
    accept: [
      ['two calls, then two responses in the next turn, then text', geminiWith({ role: 'model', parts: [gcall('read_file', { path: 'a' }), gcall('read_file', { path: 'b' })] }, { role: 'user', parts: [gresp(), gresp()] }, { role: 'model', parts: [{ text: 'done' }] })],
      ['responses followed by a host message in the same user turn', geminiWith({ role: 'model', parts: [gcall()] }, { role: 'user', parts: [gresp(), { text: 'HOST HINT' }] })],
    ],
    reject: [
      ['two calls and one response', geminiWith({ role: 'model', parts: [gcall(), gcall()] }, { role: 'user', parts: [gresp()] }), 'number of function response parts should be equal to number of function call parts'],
      ['a response after a model turn that made no call', geminiWith({ role: 'model', parts: [{ text: 'ok' }] }, { role: 'user', parts: [gresp()] }), 'Please ensure that function response turn comes immediately after a function call turn.'],
      ['a call turn that does not follow a user turn', { contents: [{ role: 'model', parts: [gcall()] }, { role: 'user', parts: [gresp()] }] }, 'Please ensure that function call turn comes immediately after a user turn or after a function response turn.'],
      ['a call with nothing after it', geminiWith({ role: 'model', parts: [gcall()] }), 'Please ensure that function response turn comes immediately after a function call turn.'],
    ],
  },
  'gemini.tool_declarations': {
    api: 'gemini',
    accept: [['a function declaration with a name of letters, digits and underscores', { ...geminiBase(), tools: [geminiTool] }]],
    reject: [
      ['a name with a space', { ...geminiBase(), tools: [{ functionDeclarations: [{ name: 'read file', parameters: { type: 'object' } }] }] }, 'name'],
      ['functionDeclarations that is not a list', { ...geminiBase(), tools: [{ functionDeclarations: { name: 'x' } }] }, 'functionDeclarations'],
    ],
  },
  'gemini.thought_signature': {
    api: 'gemini',
    accept: [['a function call with the signature the server issued', geminiWith({ role: 'model', parts: [{ functionCall: { name: 'read_file', args: { path: 'a' } }, thoughtSignature: signer.signGemini({ name: 'read_file', args: { path: 'a' } }) }] }, { role: 'user', parts: [gresp()] })]],
    reject: [
      ['a signature nobody issued', geminiWith({ role: 'model', parts: [{ functionCall: { name: 'read_file', args: { path: 'a' } }, thoughtSignature: 'forged' }] }, { role: 'user', parts: [gresp()] }), 'Corrupted thought signature.'],
      ['a call whose arguments were edited after it was signed', geminiWith({ role: 'model', parts: [{ functionCall: { name: 'read_file', args: { path: 'edited' } }, thoughtSignature: signer.signGemini({ name: 'read_file', args: { path: 'a' } }) }] }, { role: 'user', parts: [gresp()] }), 'Corrupted thought signature.'],
    ],
  },
  'gemini.thinking_config': {
    api: 'gemini',
    accept: [
      ['a level (Gemini 3 and 4)', { ...geminiBase(), generationConfig: { maxOutputTokens: 1024, thinkingConfig: { thinkingLevel: 'low' } } }],
      ['a budget (Gemini 2.5)', { ...geminiBase(), generationConfig: { thinkingConfig: { thinkingBudget: 1024 } } }],
      ['a budget of 0: thinking off', { ...geminiBase(), generationConfig: { thinkingConfig: { thinkingBudget: 0 } } }],
      ['a budget of -1: dynamic thinking', { ...geminiBase(), generationConfig: { thinkingConfig: { thinkingBudget: -1 } } }],
      ['a level and the request for thought parts', { ...geminiBase(), generationConfig: { thinkingConfig: { thinkingLevel: 'high', includeThoughts: true } } }],
    ],
    reject: [
      ['a level and a budget together', { ...geminiBase(), generationConfig: { thinkingConfig: { thinkingBudget: 1024, thinkingLevel: 'low' } } }, 'thinking_budget and thinking_level'],
      ['a level Gemini does not have', { ...geminiBase(), generationConfig: { thinkingConfig: { thinkingLevel: 'extreme' } } }, "Invalid value at 'generation_config.thinking_config.thinking_level'"],
      ['a level of Claude (xhigh)', { ...geminiBase(), generationConfig: { thinkingConfig: { thinkingLevel: 'xhigh' } } }, "Invalid value at 'generation_config.thinking_config.thinking_level'"],
      ['a budget that is not a whole number', { ...geminiBase(), generationConfig: { thinkingConfig: { thinkingBudget: 1.5 } } }, "Invalid value at 'generation_config.thinking_config.thinking_budget'"],
      ['a budget below -1', { ...geminiBase(), generationConfig: { thinkingConfig: { thinkingBudget: -2 } } }, "Invalid value at 'generation_config.thinking_config.thinking_budget'"],
      ['includeThoughts that is not a boolean', { ...geminiBase(), generationConfig: { thinkingConfig: { includeThoughts: 'yes' } } }, "Invalid value at 'generation_config.thinking_config.include_thoughts'"],
      ['a thinkingConfig that is not an object', { ...geminiBase(), generationConfig: { thinkingConfig: 'high' } }, "Invalid value at 'generation_config.thinking_config'"],
      ['a generationConfig that is not an object', { ...geminiBase(), generationConfig: 'high' }, "Invalid value at 'generation_config'"],
      ['a field thinkingConfig does not have', { ...geminiBase(), generationConfig: { thinkingConfig: { thinkingMode: 'on' } } }, 'Unknown name "thinkingMode" at \'generation_config.thinking_config\''],
    ],
  },
};

{
  let accepted = 0;
  let rejected = 0;
  for (const [rule, fixture] of Object.entries(FIXTURES)) {
    assert.ok(RULES[rule], `the fixture table names a rule that RULES does not have: ${rule}`);
    assert.equal(RULES[rule].api, fixture.api, `${rule}: API`);
    assert.ok(fixture.accept.length >= 1 && fixture.reject.length >= 1, `${rule}: at least one accept and one reject fixture`);
    for (const [label, body, options] of fixture.accept) {
      const outcome = VALIDATE[fixture.api](structuredClone(body), options);
      assert.deepEqual(outcome.errors, [], `${rule} accept "${label}" must be accepted as a whole`);
      accepted += 1;
    }
    for (const [label, body, snippet, options] of fixture.reject) {
      const outcome = VALIDATE[fixture.api](structuredClone(body), options);
      assert.equal(outcome.ok, false, `${rule} reject "${label}" must be refused`);
      assert.equal(outcome.errors[0].rule, rule, `${rule} reject "${label}": the first error must be this rule (got ${outcome.errors.map((e) => `${e.rule}: ${e.message}`).join(' | ')})`);
      assert.ok(outcome.errors[0].message.includes(snippet), `${rule} reject "${label}": message "${outcome.errors[0].message}" should contain "${snippet}"`);
      rejected += 1;
    }
  }
  const requestRules = Object.keys(RULES).filter((rule) => !rule.endsWith('.stream_shape'));
  assert.deepEqual(Object.keys(FIXTURES).sort(), requestRules.sort(), 'every request rule has fixtures and every fixture names a rule');
  ok(`request validators: ${Object.keys(FIXTURES).length} rules, ${accepted} accept and ${rejected} reject fixtures, each refused for the rule it targets`);
}

{
  // A dialect that DeepSeek and other compatible servers speak: reasoning_content on an assistant message is theirs, not OpenAI's.
  const body = chatWith({ role: 'assistant', content: 'x', reasoning_content: 'because' });
  assert.equal(validateChatRequest(body).ok, false);
  assert.equal(validateChatRequest(body, { dialect: 'compat' }).ok, true);
  const first = validateChatRequest(chatWith(assistantCalls('a', 'b'), toolMsg('a'), { role: 'user', content: 'h' }, toolMsg('b')));
  assert.equal(first.errors.length >= 2, true, 'every problem is listed, not only the first');
  assert.equal(first.errors[0].message.startsWith("An assistant message with 'tool_calls'"), true, 'and the first one is the one the API reports');
  assert.deepEqual(errorBody('anthropic', { message: 'm' }), { type: 'error', error: { type: 'invalid_request_error', message: 'm' }, request_id: 'req_mock' });
  assert.deepEqual(errorBody('chat', { message: 'm', param: 'p', code: 'c' }), { error: { message: 'm', type: 'invalid_request_error', param: 'p', code: 'c' } });
  assert.deepEqual(errorBody('gemini', { message: 'm', status: 413 }), { error: { code: 413, message: 'm', status: 'INVALID_ARGUMENT' } });
  ok('the Chat dialect option, the complete error list and the error envelopes of the four APIs');
}

// ---- Streams: the shape of what a server sends
const sse = (...frames) => parseSse(frames.map(([event, data]) => `${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`).join(''));
const chunk = (delta, finish = null, extra = {}) => ['', { id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta, finish_reason: finish }], ...extra }];
const usageChunk = () => ['', { id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }];
const DONE = ['', '[DONE]'];

const STREAM_FIXTURES = {
  chat: {
    validate: (events, options) => validateChatStream(events, options),
    accept: [
      ['text, a usage chunk and [DONE]', sse(chunk({ role: 'assistant', content: '' }), chunk({ content: 'Hel' }), chunk({ content: 'lo' }), chunk({}, 'stop'), usageChunk(), DONE), { includeUsage: true }],
      ['two tool calls streamed as fragments', sse(chunk({ role: 'assistant', content: null }),
        chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '' } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] }),
        chunk({ tool_calls: [{ index: 1, id: 'call_2', type: 'function', function: { name: 'read_file', arguments: '' } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '"a"}' } }] }),
        chunk({ tool_calls: [{ index: 1, function: { arguments: '{"path":"b"}' } }] }),
        chunk({}, 'tool_calls'), DONE), { includeUsage: false }],
      ['a tool call that the output limit cut off (finish_reason length ends it mid-JSON)', sse(chunk({ role: 'assistant', content: null }), chunk({ tool_calls: [{ index: 0, id: 'c', type: 'function', function: { name: 'f', arguments: '' } }] }), chunk({ tool_calls: [{ index: 0, function: { arguments: '{"a":' } }] }), chunk({}, 'length'), DONE), { includeUsage: false }],
    ],
    reject: [
      ['no [DONE] at the end', sse(chunk({ role: 'assistant', content: 'x' }), chunk({}, 'stop')), { includeUsage: false }, 'must end with [DONE]'],
      ['tool call arguments that are not JSON when joined', sse(chunk({ role: 'assistant', content: null }), chunk({ tool_calls: [{ index: 0, id: 'c', type: 'function', function: { name: 'f', arguments: '{"a":' } }] }), chunk({}, 'tool_calls'), DONE), { includeUsage: false }, 'arguments'],
      ['a delta after the finish chunk', sse(chunk({ role: 'assistant', content: 'x' }), chunk({}, 'stop'), chunk({ content: 'late' }), DONE), { includeUsage: false }, 'after finish_reason'],
      ['a usage chunk that was not asked for', sse(chunk({ role: 'assistant', content: 'x' }), chunk({}, 'stop'), usageChunk(), DONE), { includeUsage: false }, 'usage'],
      ['no usage chunk when it was asked for', sse(chunk({ role: 'assistant', content: 'x' }), chunk({}, 'stop'), DONE), { includeUsage: true }, 'usage'],
    ],
  },
  anthropic: {
    validate: (events) => validateAnthropicStream(events),
    accept: [
      ['text', sse(['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], model: 'mock', stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['ping', { type: 'ping' }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } }],
        ['message_stop', { type: 'message_stop' }])],
      ['thinking with its signature, then a tool_use', sse(['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], model: 'mock', stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {} } }],
        ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"a"}' } }],
        ['content_block_stop', { type: 'content_block_stop', index: 1 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 9 } }],
        ['message_stop', { type: 'message_stop' }])],
      ['a tool_use block that the output limit cut off (max_tokens ends it mid-JSON)', sse(['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], model: 'mock', stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {} } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"pa' } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'max_tokens', stop_sequence: null }, usage: { output_tokens: 9 } }],
        ['message_stop', { type: 'message_stop' }])],
    ],
    reject: [
      ['a delta for a block that was never started', sse(['message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [], model: 'mock', stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }], ['message_stop', { type: 'message_stop' }]), undefined, 'before content_block_start'],
      ['no message_stop', sse(['message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [], model: 'mock', stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } }]), undefined, 'message_stop'],
      ['a thinking block without its signature_delta', sse(['message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [], model: 'mock', stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'x' } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }], ['message_stop', { type: 'message_stop' }]), undefined, 'signature_delta'],
      ['tool_use input that is not JSON when joined', sse(['message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [], model: 'mock', stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'f', input: {} } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"a":' } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } }], ['message_stop', { type: 'message_stop' }]), undefined, 'partial_json'],
    ],
  },
  responses: {
    validate: (events) => validateResponsesStream(events),
    accept: [
      ['text, then completed', sse(
        ['response.created', { type: 'response.created', sequence_number: 0, response: { id: 'resp_1', status: 'in_progress', output: [] } }],
        ['response.in_progress', { type: 'response.in_progress', sequence_number: 1, response: { id: 'resp_1', status: 'in_progress', output: [] } }],
        ['response.output_item.added', { type: 'response.output_item.added', sequence_number: 2, output_index: 0, item: { type: 'message', id: 'msg_1', status: 'in_progress', role: 'assistant', content: [] } }],
        ['response.content_part.added', { type: 'response.content_part.added', sequence_number: 3, item_id: 'msg_1', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }],
        ['response.output_text.delta', { type: 'response.output_text.delta', sequence_number: 4, item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'Hel', logprobs: [] }],
        ['response.output_text.delta', { type: 'response.output_text.delta', sequence_number: 5, item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'lo', logprobs: [] }],
        ['response.output_text.done', { type: 'response.output_text.done', sequence_number: 6, item_id: 'msg_1', output_index: 0, content_index: 0, text: 'Hello', logprobs: [] }],
        ['response.content_part.done', { type: 'response.content_part.done', sequence_number: 7, item_id: 'msg_1', output_index: 0, content_index: 0, part: { type: 'output_text', text: 'Hello', annotations: [] } }],
        ['response.output_item.done', { type: 'response.output_item.done', sequence_number: 8, output_index: 0, item: { type: 'message', id: 'msg_1', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'Hello', annotations: [] }] } }],
        ['response.completed', { type: 'response.completed', sequence_number: 9, response: { id: 'resp_1', status: 'completed', output: [{ type: 'message', id: 'msg_1', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'Hello', annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }])],
    ],
    reject: [
      ['sequence numbers that do not increase', sse(
        ['response.created', { type: 'response.created', sequence_number: 0, response: { id: 'resp_1', status: 'in_progress', output: [] } }],
        ['response.in_progress', { type: 'response.in_progress', sequence_number: 0, response: { id: 'resp_1', status: 'in_progress', output: [] } }],
        ['response.completed', { type: 'response.completed', sequence_number: 1, response: { id: 'resp_1', status: 'completed', output: [] } }]), undefined, 'sequence_number'],
      ['a text delta for an item that was never added', sse(
        ['response.created', { type: 'response.created', sequence_number: 0, response: { id: 'resp_1', status: 'in_progress', output: [] } }],
        ['response.output_text.delta', { type: 'response.output_text.delta', sequence_number: 1, item_id: 'msg_x', output_index: 0, content_index: 0, delta: 'x', logprobs: [] }],
        ['response.completed', { type: 'response.completed', sequence_number: 2, response: { id: 'resp_1', status: 'completed', output: [] } }]), undefined, 'msg_x'],
      ['a stream with no terminal event', sse(
        ['response.created', { type: 'response.created', sequence_number: 0, response: { id: 'resp_1', status: 'in_progress', output: [] } }]), undefined, 'terminal'],
      ['a completed response whose items disagree with the streamed text', sse(
        ['response.created', { type: 'response.created', sequence_number: 0, response: { id: 'resp_1', status: 'in_progress', output: [] } }],
        ['response.output_item.added', { type: 'response.output_item.added', sequence_number: 1, output_index: 0, item: { type: 'message', id: 'msg_1', status: 'in_progress', role: 'assistant', content: [] } }],
        ['response.output_text.delta', { type: 'response.output_text.delta', sequence_number: 2, item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'Hello', logprobs: [] }],
        ['response.output_item.done', { type: 'response.output_item.done', sequence_number: 3, output_index: 0, item: { type: 'message', id: 'msg_1', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'Hello', annotations: [] }] } }],
        ['response.completed', { type: 'response.completed', sequence_number: 4, response: { id: 'resp_1', status: 'completed', output: [{ type: 'message', id: 'msg_1', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'Goodbye', annotations: [] }] }] } }]), undefined, 'differs from the streamed'],
    ],
  },
  gemini: {
    validate: (events) => validateGeminiStream(events),
    accept: [
      ['text in pieces, usage in every event, finishReason in the last', sse(
        [null, { candidates: [{ content: { parts: [{ text: 'Hel' }], role: 'model' }, index: 0 }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1, totalTokenCount: 6 } }],
        [null, { candidates: [{ content: { parts: [{ text: 'lo' }], role: 'model' }, finishReason: 'STOP', index: 0 }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 } }])],
      ['thought parts, then a signed functionCall in the last chunk, and an empty text part with the finishReason', sse(
        [null, { candidates: [{ content: { parts: [{ text: 'thinking', thought: true }], role: 'model' }, index: 0 }], usageMetadata: { promptTokenCount: 9, totalTokenCount: 9 } }],
        [null, { candidates: [{ content: { parts: [{ functionCall: { name: 'read_file', args: { path: 'a' } }, thoughtSignature: 'sig' }], role: 'model' }, index: 0 }], usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4, totalTokenCount: 13 } }],
        [null, { candidates: [{ content: { parts: [{ text: '' }], role: 'model' }, finishReason: 'STOP', index: 0 }], usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4, totalTokenCount: 13 } }])],
      ['a blocked prompt: no candidate at all', sse([null, { promptFeedback: { blockReason: 'SAFETY' }, usageMetadata: { promptTokenCount: 3, totalTokenCount: 3 } }])],
    ],
    reject: [
      ['no finishReason: the stream was cut', sse([null, { candidates: [{ content: { parts: [{ text: 'x' }], role: 'model' }, index: 0 }] }]), undefined, 'finishReason'],
      ['text after the chunk that has the finishReason', sse(
        [null, { candidates: [{ content: { parts: [{ text: 'x' }], role: 'model' }, finishReason: 'STOP', index: 0 }] }],
        [null, { candidates: [{ content: { parts: [{ text: 'late' }], role: 'model' }, index: 0 }] }]), undefined, 'after the chunk with finishReason'],
      ['a [DONE] marker (Gemini streams have none)', sse([null, { candidates: [{ content: { parts: [{ text: 'x' }], role: 'model' }, finishReason: 'STOP', index: 0 }] }], [null, '[DONE]']), undefined, '[DONE]'],
      ['an event that is not an object', sse([null, '[1]']), undefined, 'not a GenerateContentResponse'],
      ['a functionCall with no name', sse([null, { candidates: [{ content: { parts: [{ functionCall: { args: {} } }], role: 'model' }, finishReason: 'STOP', index: 0 }] }]), undefined, 'needs a name'],
      ['a functionCall whose args are not an object', sse([null, { candidates: [{ content: { parts: [{ functionCall: { name: 'f', args: 'x' } }], role: 'model' }, finishReason: 'STOP', index: 0 }] }]), undefined, 'args must be an object'],
      ['a part that carries two kinds of data', sse([null, { candidates: [{ content: { parts: [{ text: 'x', functionCall: { name: 'f' } }], role: 'model' }, finishReason: 'STOP', index: 0 }] }]), undefined, 'exactly one kind'],
      ['a promptTokenCount that changes between events', sse(
        [null, { candidates: [{ content: { parts: [{ text: 'a' }], role: 'model' }, index: 0 }], usageMetadata: { promptTokenCount: 5, totalTokenCount: 5 } }],
        [null, { candidates: [{ content: { parts: [{ text: 'b' }], role: 'model' }, finishReason: 'STOP', index: 0 }], usageMetadata: { promptTokenCount: 6, totalTokenCount: 6 } }]), undefined, 'promptTokenCount'],
      ['a candidate token count that goes down', sse(
        [null, { candidates: [{ content: { parts: [{ text: 'a' }], role: 'model' }, index: 0 }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 4, totalTokenCount: 9 } }],
        [null, { candidates: [{ content: { parts: [{ text: 'b' }], role: 'model' }, finishReason: 'STOP', index: 0 }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 } }]), undefined, 'candidatesTokenCount decreases'],
      ['a role other than model', sse([null, { candidates: [{ content: { parts: [{ text: 'x' }], role: 'user' }, finishReason: 'STOP', index: 0 }] }]), undefined, 'role "model"'],
      ['a blocked prompt that also has a candidate', sse([null, { promptFeedback: { blockReason: 'SAFETY' }, candidates: [{ content: { parts: [{ text: 'x' }], role: 'model' }, finishReason: 'STOP', index: 0 }] }]), undefined, 'blocked prompt has no candidate'],
      ['an error object inside the stream', sse([null, { error: { code: 503, message: 'down', status: 'UNAVAILABLE' } }]), undefined, 'error object'],
      ['two events with a finishReason', sse(
        [null, { candidates: [{ content: { parts: [{ text: 'a' }], role: 'model' }, finishReason: 'STOP', index: 0 }] }],
        [null, { candidates: [{ content: { parts: [], role: 'model' }, finishReason: 'STOP', index: 0 }] }]), undefined, 'second finishReason'],
      ['candidates that are not a list', sse([null, { candidates: 'x' }]), undefined, 'non-empty list'],
    ],
  },
};

{
  let accepted = 0;
  let rejected = 0;
  for (const [api, fixture] of Object.entries(STREAM_FIXTURES)) {
    const rule = `${api}.stream_shape`;
    assert.ok(RULES[rule], `RULES has ${rule}`);
    for (const [label, events, options] of fixture.accept) {
      const outcome = fixture.validate(events, options);
      assert.deepEqual(outcome.errors, [], `${rule} accept "${label}"`);
      accepted += 1;
    }
    for (const [label, events, options, snippet] of fixture.reject) {
      const outcome = fixture.validate(events, options);
      assert.equal(outcome.ok, false, `${rule} reject "${label}" must be refused`);
      assert.equal(outcome.errors[0].rule, rule);
      assert.ok(outcome.errors.some((error) => error.message.includes(snippet)), `${rule} reject "${label}": "${outcome.errors.map((e) => e.message).join(' | ')}" should mention "${snippet}"`);
      rejected += 1;
    }
  }
  ok(`stream validators: ${Object.keys(STREAM_FIXTURES).length} rules, ${accepted} accept and ${rejected} reject fixtures`);
}

{
  const count = (table) => Object.values(table).reduce((sum, f) => sum + f.accept.length + f.reject.length, 0);
  const total = count(FIXTURES) + count(STREAM_FIXTURES);
  assert.ok(total >= 12, 'at least 12 validator cases');
  note(`validator cases in all: ${total} for ${Object.keys(RULES).length} rules (each rule has at least one accept and one reject fixture; the limit asked for is 12 cases)`);
}

// ---------------------------------------------------------------------------------------------------------------------
// 2. The servers: the real wire format, as JSON and as SSE
// ---------------------------------------------------------------------------------------------------------------------
const closers = [];
const server = async (options) => { const mock = await startMockModel(options); closers.push(() => mock.close()); return mock; };
const post = async (url, body, { signal, headers } = {}) => {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal });
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { /* an SSE body */ }
  return { status: response.status, headers: response.headers, text, json };
};
const ENDPOINTS = (mock) => ({ chat: `${mock.url}/chat/completions`, anthropic: `${mock.url}/messages`, responses: `${mock.url}/responses`, gemini: `${mock.origin}/v1beta/models/mock-gemini:generateContent` });
const bodies = {
  chat: (extra = {}) => ({ model: 'mock-coder', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'Hi' }], tools: [readTool], tool_choice: 'auto', ...extra }),
  anthropic: (extra = {}) => ({ model: 'mock-coder', max_tokens: 1024, system: [{ type: 'text', text: 'sys' }], messages: [{ role: 'user', content: 'Hi' }], tools: [anthTool], ...extra }),
  responses: (extra = {}) => ({ model: 'mock-coder', instructions: 'sys', input: [{ role: 'user', content: 'Hi' }], tools: [respTool], store: false, include: ['reasoning.encrypted_content'], ...extra }),
  gemini: (extra = {}) => ({ systemInstruction: { parts: [{ text: 'sys' }] }, contents: [{ role: 'user', parts: [{ text: 'Hi' }] }], tools: [geminiTool], generationConfig: { maxOutputTokens: 1024 }, ...extra }),
};
const TOOL_USE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

// What a step says, read back from each protocol's own answer (so JSON and SSE can be compared with each other).
const summary = {
  chat: ({ message, usage, finish }) => ({
    text: message.content ?? '',
    calls: (message.tool_calls ?? []).map((entry) => [entry.function.name, entry.function.arguments]),
    usage: usage ? { input: usage.prompt_tokens, output: usage.completion_tokens, cacheRead: usage.prompt_tokens_details?.cached_tokens ?? 0 } : null,
    stop: finish,
  }),
  anthropic: (message) => ({
    text: message.content.filter((block) => block.type === 'text').map((block) => block.text).join(''),
    thinking: message.content.filter((block) => block.type === 'thinking').map((block) => block.thinking).join(''),
    calls: message.content.filter((block) => block.type === 'tool_use').map((block) => [block.name, JSON.stringify(block.input)]),
    usage: { input: message.usage.input_tokens + (message.usage.cache_read_input_tokens ?? 0) + (message.usage.cache_creation_input_tokens ?? 0), output: message.usage.output_tokens, cacheRead: message.usage.cache_read_input_tokens ?? 0 },
    stop: message.stop_reason,
  }),
  responses: (response) => ({
    text: response.output.filter((item) => item.type === 'message').flatMap((item) => item.content).map((part) => part.text ?? part.refusal).join(''),
    thinking: response.output.filter((item) => item.type === 'reasoning').flatMap((item) => item.summary).map((part) => part.text).join(''),
    calls: response.output.filter((item) => item.type === 'function_call').map((item) => [item.name, item.arguments]),
    usage: { input: response.usage.input_tokens, output: response.usage.output_tokens, cacheRead: response.usage.input_tokens_details?.cached_tokens ?? 0 },
    stop: response.status === 'completed' ? 'completed' : response.incomplete_details?.reason,
  }),
};

const RICH = { thinking: 'I should read both files.', text: 'Reading both.', calls: [{ name: 'read_file', args: { path: 'a.txt' } }, { name: 'read_file', args: { path: 'b.txt' } }], usage: { input: 100, output: 20, cacheRead: 300, cacheWrite: 50, reasoning: 7 } };
const mock = await server({ scenario: 'canned-answer', strict: { chat: true } });
const URL = ENDPOINTS(mock);
mock.define('rich', () => RICH);
mock.setScenario('rich');

{
  const chat = await post(URL.chat, bodies.chat());
  assert.equal(chat.status, 200);
  assert.equal(chat.json.object, 'chat.completion');
  const message = chat.json.choices[0].message;
  assert.equal(chat.json.choices[0].finish_reason, 'tool_calls');
  assert.equal(message.content, 'Reading both.');
  assert.equal(message.reasoning_content, undefined, 'plain OpenAI Chat has no visible reasoning');
  assert.equal(message.tool_calls.length, 2, 'two calls in one turn');
  assert.notEqual(message.tool_calls[0].id, message.tool_calls[1].id);
  assert.deepEqual(message.tool_calls.map((entry) => entry.type), ['function', 'function']);
  assert.equal(message.tool_calls[0].function.arguments, '{"path":"a.txt"}', 'arguments are a JSON string');
  assert.deepEqual(chat.json.usage, { prompt_tokens: 450, completion_tokens: 20, total_tokens: 470, prompt_tokens_details: { cached_tokens: 300 }, completion_tokens_details: { reasoning_tokens: 7 } });
  ok('Chat Completions as JSON: parallel tool_calls, string arguments, finish_reason, usage with cached and reasoning tokens');

  const anthropic = await post(URL.anthropic, bodies.anthropic());
  assert.equal(anthropic.status, 200);
  assert.equal(anthropic.json.type, 'message');
  assert.equal(anthropic.json.role, 'assistant');
  const [first, second, ...uses] = anthropic.json.content;
  assert.equal(first.type, 'thinking');
  assert.equal(first.thinking, 'I should read both files.');
  assert.equal(mock.signer.verifyThinking(first), 'ok', 'the thinking block carries a signature the server can verify');
  assert.equal(second.type, 'text');
  assert.equal(uses.length, 2);
  for (const use of uses) { assert.equal(use.type, 'tool_use'); assert.match(use.id, TOOL_USE_ID_PATTERN); assert.deepEqual(Object.keys(use.input), ['path']); }
  assert.equal(anthropic.json.stop_reason, 'tool_use');
  assert.deepEqual(anthropic.json.usage, { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 50, cache_read_input_tokens: 300 });
  ok('Anthropic Messages as JSON: a signed thinking block, text, two tool_use blocks, stop_reason, the cache usage fields');

  const responses = await post(URL.responses, bodies.responses());
  assert.equal(responses.status, 200);
  assert.equal(responses.json.object, 'response');
  assert.equal(responses.json.status, 'completed');
  const [reasoning, messageItem, ...functionCalls] = responses.json.output;
  assert.equal(reasoning.type, 'reasoning');
  assert.equal(reasoning.summary[0].type, 'summary_text');
  assert.equal(reasoning.summary[0].text, 'I should read both files.');
  assert.equal(typeof reasoning.encrypted_content, 'string', 'encrypted reasoning is returned because the request asked for it');
  assert.equal(messageItem.type, 'message');
  assert.equal(messageItem.content[0].type, 'output_text');
  assert.equal(functionCalls.length, 2, 'parallel function_call items in one response');
  for (const item of functionCalls) { assert.equal(item.type, 'function_call'); assert.equal(item.status, 'completed'); assert.equal(typeof item.call_id, 'string'); assert.equal(typeof item.arguments, 'string'); }
  assert.deepEqual(responses.json.usage, { input_tokens: 450, input_tokens_details: { cached_tokens: 300, cache_write_tokens: 50 }, output_tokens: 20, output_tokens_details: { reasoning_tokens: 7 }, total_tokens: 470 });
  const plain = await post(URL.responses, bodies.responses({ include: undefined }));
  assert.equal(plain.json.output[0].encrypted_content, undefined, 'without include, no encrypted reasoning');
  ok('Responses as JSON: reasoning summary (encrypted content only when asked for), message, two function_call items, usage details');

  const gemini = await post(URL.gemini, bodies.gemini());
  assert.equal(gemini.status, 200);
  const candidate = gemini.json.candidates[0];
  assert.equal(candidate.finishReason, 'STOP');
  assert.equal(candidate.content.role, 'model');
  const [thoughtPart, textPart, ...callParts] = candidate.content.parts;
  assert.deepEqual(thoughtPart, { text: 'I should read both files.', thought: true }, 'the reasoning is a thought part');
  assert.deepEqual(textPart, { text: 'Reading both.' });
  assert.equal(callParts.length, 2, 'two functionCall parts in one model turn');
  assert.deepEqual(callParts[0].functionCall, { name: 'read_file', args: { path: 'a.txt' } });
  assert.equal(typeof callParts[0].thoughtSignature, 'string', 'the first call of a thinking turn carries a thoughtSignature');
  assert.equal(callParts[1].thoughtSignature, undefined, 'and the second does not (only the first call of a parallel turn is signed)');
  assert.equal(mock.signer.verifyGemini(callParts[0].functionCall, callParts[0].thoughtSignature), true);
  assert.deepEqual(gemini.json.usageMetadata, { promptTokenCount: 450, cachedContentTokenCount: 300, candidatesTokenCount: 20, thoughtsTokenCount: 7, totalTokenCount: 477 });
  ok('Gemini generateContent as JSON: a thought part, text, two functionCall parts (the first signed), finishReason, usageMetadata with cached and thought tokens');

  const recorded = mock.state.requests.slice(-5).map((request) => [request.protocol, request.stream, request.rejected]);
  assert.deepEqual(recorded, [['chat', false, null], ['anthropic', false, null], ['responses', false, null], ['responses', false, null], ['gemini', false, null]]);
  assert.equal(mock.state.requests.at(-1).model, 'mock-gemini', 'the model of a Gemini request is the one in the URL');
  assert.ok(mock.state.requests.at(-1).bytes > 100, 'the size of each request is recorded');
}

{
  // The same step as an SSE stream: valid in shape, and the same content as the JSON answer.
  const jsonAnswers = {
    chat: (await post(URL.chat, bodies.chat())).json,
    anthropic: (await post(URL.anthropic, bodies.anthropic())).json,
    responses: (await post(URL.responses, bodies.responses())).json,
  };
  const jsonSummary = {
    chat: summary.chat({ message: jsonAnswers.chat.choices[0].message, usage: jsonAnswers.chat.usage, finish: jsonAnswers.chat.choices[0].finish_reason }),
    anthropic: summary.anthropic(jsonAnswers.anthropic),
    responses: summary.responses(jsonAnswers.responses),
  };
  const sse = async (api, extra) => {
    const response = await fetch(URL[api], { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bodies[api]({ stream: true, ...extra })) });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/event-stream/);
    return parseSse(await response.text());
  };

  const chatEvents = await sse('chat', { stream_options: { include_usage: true } });
  assert.deepEqual(validateChatStream(chatEvents, { includeUsage: true }).errors, []);
  const chatDone = accumulateChatStream(chatEvents);
  assert.equal(chatDone.message.tool_calls.length, 2);
  assert.ok(chatEvents.filter((event) => event.json?.choices?.[0]?.delta?.tool_calls).length > 4, 'tool call arguments arrive in fragments, not in one piece');
  assert.deepEqual(summary.chat({ message: chatDone.message, usage: chatDone.usage, finish: chatDone.finish_reason }), jsonSummary.chat, 'Chat: the stream says what the JSON answer says');
  const withoutUsage = await sse('chat');
  assert.deepEqual(validateChatStream(withoutUsage, { includeUsage: false }).errors, [], 'no usage chunk unless stream_options.include_usage asks for it');

  const anthropicEvents = await sse('anthropic');
  assert.deepEqual(validateAnthropicStream(anthropicEvents).errors, []);
  const anthropicDone = accumulateAnthropicStream(anthropicEvents);
  assert.equal(mock.signer.verifyThinking(anthropicDone.content[0]), 'ok', 'the signature arrives as signature_delta and verifies');
  assert.deepEqual(summary.anthropic(anthropicDone), jsonSummary.anthropic, 'Anthropic: the stream says what the JSON answer says');
  assert.ok(anthropicEvents.some((event) => event.event === 'ping'), 'a ping is sent, as the real API does');

  const responsesEvents = await sse('responses');
  assert.deepEqual(validateResponsesStream(responsesEvents).errors, []);
  const names = new Set(responsesEvents.map((event) => event.event));
  for (const name of ['response.created', 'response.in_progress', 'response.output_item.added', 'response.reasoning_summary_text.delta', 'response.output_text.delta', 'response.function_call_arguments.delta', 'response.function_call_arguments.done', 'response.output_item.done', 'response.completed']) assert.ok(names.has(name), `the Responses stream has ${name}`);
  assert.deepEqual(summary.responses(accumulateResponsesStream(responsesEvents)), jsonSummary.responses, 'Responses: the stream says what the JSON answer says');
  assert.equal(accumulateResponsesStream(responsesEvents).output.filter((item) => item.type === 'function_call').length, 2, 'response.completed carries the parallel function_call items');
  const geminiRoute = `${mock.origin}/v1beta/models/mock-gemini:streamGenerateContent?alt=sse`;
  const geminiStream = await fetch(geminiRoute, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bodies.gemini()) });
  assert.equal(geminiStream.status, 200);
  assert.match(geminiStream.headers.get('content-type'), /^text\/event-stream/);
  const geminiEvents = parseSse(await geminiStream.text());
  assert.deepEqual(validateGeminiStream(geminiEvents).errors, []);
  const geminiDone = accumulateGeminiStream(geminiEvents);
  const geminiJson = (await post(URL.gemini, bodies.gemini())).json;
  const geminiParts = (response) => response.candidates[0].content.parts;
  assert.deepEqual(geminiParts(geminiDone), geminiParts(geminiJson), 'Gemini: the stream says what the JSON answer says (thought, text, two calls, the first one signed)');
  assert.deepEqual([geminiDone.candidates[0].finishReason, geminiDone.usageMetadata], [geminiJson.candidates[0].finishReason, geminiJson.usageMetadata]);
  assert.ok(geminiEvents.filter((event) => event.json?.candidates?.[0]?.content?.parts?.some((part) => part.text !== undefined && part.thought !== true)).length > 1, 'the text arrives in pieces');
  assert.equal(geminiEvents.filter((event) => event.json?.candidates?.[0]?.finishReason).length, 1, 'only the last event has the finishReason');
  assert.equal((await fetch(geminiRoute.replace('?alt=sse', ''), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bodies.gemini()) })).status, 400, 'a stream without alt=sse is refused: the Hub reads the SSE form only');
  ok('SSE: Chat (fragments and a usage chunk on request), Anthropic (signature_delta, ping), Responses (reasoning summary and text deltas, completed with parallel calls) and Gemini (alt=sse chunks, usage that grows, the finishReason in the last) are valid streams that carry what the JSON answer carries');
}

{
  // Strictness: Chat Completions is lenient unless asked (older suites were written against a lenient mock); the others are strict.
  const lenient = await server({ scenario: 'canned-answer' });
  const URLS = ENDPOINTS(lenient);
  const odd = await post(URLS.chat, bodies.chat({ thinking: { type: 'enabled' } }));
  assert.equal(odd.status, 200, 'by default the Chat route still answers a request with a parameter OpenAI would refuse');
  assert.equal((await post(URLS.anthropic, bodies.anthropic({ parallel_tool_calls: false }))).status, 400, 'Anthropic is strict by default');
  assert.equal((await post(URLS.responses, bodies.responses({ messages: [] }))).status, 400, 'Responses is strict by default');
  assert.equal((await post(URLS.gemini, bodies.gemini({ model: 'x' }))).status, 400, 'Gemini is strict by default');
  const loose = await server({ scenario: 'canned-answer', strict: false });
  assert.equal((await post(ENDPOINTS(loose).anthropic, bodies.anthropic({ parallel_tool_calls: false }))).status, 200, 'strict: false turns every check off');

  const refused = await post(URL.chat, bodies.chat({ thinking: { type: 'enabled' } }));
  assert.equal(refused.status, 400);
  assert.deepEqual(refused.json, { error: { message: 'Unrecognized request argument supplied: thinking', type: 'invalid_request_error', param: 'thinking', code: null } });
  const refusedAnthropic = await post(URL.anthropic, bodies.anthropic({ parallel_tool_calls: false }));
  assert.deepEqual(refusedAnthropic.json, { type: 'error', error: { type: 'invalid_request_error', message: 'parallel_tool_calls: Extra inputs are not permitted' }, request_id: 'req_mock' });
  const refusedResponses = await post(URL.responses, bodies.responses({ messages: [] }));
  assert.deepEqual(refusedResponses.json, { error: { message: "Unknown parameter: 'messages'.", type: 'invalid_request_error', param: 'messages', code: 'unknown_parameter' } });
  const last = mock.state.requests.at(-1);
  assert.equal(last.rejected.rule, 'responses.unknown_param', 'the server records which rule refused the request');
  const refusedGemini = await post(URL.gemini, bodies.gemini({ model: 'x' }));
  assert.deepEqual(refusedGemini.json, { error: { code: 400, message: 'Invalid JSON payload received. Unknown name "model": Cannot find field.', status: 'INVALID_ARGUMENT' } });
  assert.ok(mock.state.rejections.length >= 4);
  ok('strictness: refused requests get the API\'s own error envelope and status 400, and the rule is recorded; the Chat route is lenient unless strict is set');
}

{
  // A refused field can be a nested one (Gemini keeps its thinking setting in generationConfig): a dotted path names it, and a request without it is left alone.
  const m = await server({ scenario: 'canned-answer' });
  const G = ENDPOINTS(m).gemini;
  const message = 'Invalid JSON payload received. Unknown name "thinkingConfig" at \'generation_config\': Cannot find field.';
  const refusal = m.refuseParam('generationConfig.thinkingConfig', { message, on: 'gemini' });
  const withThinking = await post(G, bodies.gemini({ generationConfig: { maxOutputTokens: 1024, thinkingConfig: { thinkingLevel: 'low' } } }));
  assert.equal(withThinking.status, 400);
  assert.deepEqual(withThinking.json, { error: { code: 400, message, status: 'INVALID_ARGUMENT' } });
  assert.equal((await post(G, bodies.gemini())).status, 200, 'a request without the nested field is answered');
  assert.equal((await post(G, bodies.gemini({ generationConfig: { maxOutputTokens: 1024 } }))).status, 200, 'and so is one whose generationConfig has only other keys');
  assert.equal((await post(G, bodies.gemini({ generationConfig: 'x' }))).status, 400, '(a generationConfig that is not an object is refused by the strict check, not by the path)');
  assert.equal(refusal.used, 1, 'only the request that had the field was refused');
  m.clearRefusals();
  assert.equal((await post(G, bodies.gemini({ generationConfig: { thinkingConfig: { thinkingLevel: 'low' } } }))).status, 200, 'cleared: answered again');
  ok('a refused parameter may be a dotted path (generationConfig.thinkingConfig): only a request that has the nested field is refused');
}

{
  // The conversation view a scenario sees is the same whichever protocol carries it.
  const seen = [];
  const m = await server({ scenario: 'ctx', scenarios: { ctx: (ctx) => { seen.push({ prompt: ctx.prompt, users: ctx.users, turn: ctx.turn, last: ctx.last, tools: ctx.tools, system: ctx.system, protocol: ctx.protocol }); return ctx.turn === 0 ? call('read_file', { path: 'a' }) : say('done'); } }, strict: true });
  const U = ENDPOINTS(m);
  const chat1 = (await post(U.chat, bodies.chat())).json.choices[0].message;
  await post(U.chat, bodies.chat({ messages: [...bodies.chat().messages, { role: 'assistant', content: null, tool_calls: chat1.tool_calls }, { role: 'tool', tool_call_id: chat1.tool_calls[0].id, content: 'RESULT' }] }));
  const anthropic1 = (await post(U.anthropic, bodies.anthropic())).json;
  await post(U.anthropic, bodies.anthropic({ messages: [...bodies.anthropic().messages, { role: 'assistant', content: anthropic1.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: anthropic1.content[0].id, content: 'RESULT' }] }] }));
  const responses1 = (await post(U.responses, bodies.responses())).json;
  const calledItem = responses1.output.find((item) => item.type === 'function_call');
  await post(U.responses, bodies.responses({ input: [...bodies.responses().input, { type: 'function_call', call_id: calledItem.call_id, name: calledItem.name, arguments: calledItem.arguments }, { type: 'function_call_output', call_id: calledItem.call_id, output: 'RESULT' }] }));
  const geminiCall = (await post(U.gemini, bodies.gemini())).json.candidates[0].content.parts.find((part) => part.functionCall);
  await post(U.gemini, bodies.gemini({ contents: [...bodies.gemini().contents, { role: 'model', parts: [geminiCall] }, { role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { output: 'RESULT' } } }] }] }));
  const byProtocol = Object.fromEntries(['chat', 'anthropic', 'responses', 'gemini'].map((protocol) => [protocol, seen.filter((entry) => entry.protocol === protocol)]));
  for (const [protocol, entries] of Object.entries(byProtocol)) assert.equal(entries.length, 2, `${protocol}: two requests reached the scenario`);
  for (const protocol of ['chat', 'anthropic', 'responses', 'gemini']) {
    const [firstCtx, secondCtx] = byProtocol[protocol];
    assert.deepEqual({ prompt: firstCtx.prompt, turn: firstCtx.turn, last: firstCtx.last, tools: firstCtx.tools, system: firstCtx.system }, { prompt: 'Hi', turn: 0, last: '', tools: ['read_file'], system: 'sys' }, `${protocol}: first request`);
    assert.deepEqual({ prompt: secondCtx.prompt, turn: secondCtx.turn, last: secondCtx.last, tools: secondCtx.tools }, { prompt: 'Hi', turn: 1, last: 'RESULT', tools: ['read_file'] }, `${protocol}: after one tool result`);
  }
  ok('a scenario sees the same prompt, system text, tool names, turn and last result on Chat, Anthropic, Responses and Gemini');

  // The Hub's "Test API" button sends a probe with a record_probe tool, and a connectivity check with no tools at all.
  const probe = await server({ scenario: 'canned-answer' });
  const P = ENDPOINTS(probe);
  const chatProbe = await post(P.chat, bodies.chat({ tools: [{ type: 'function', function: { name: 'record_probe', parameters: { type: 'object' } } }] }));
  assert.equal(chatProbe.json.choices[0].message.tool_calls[0].function.name, 'record_probe', 'the Hub\'s tool probe is answered on Chat');
  const anthropicProbe = await post(P.anthropic, bodies.anthropic({ tools: [{ name: 'record_probe', input_schema: { type: 'object' } }] }));
  assert.equal(anthropicProbe.json.content.find((block) => block.type === 'tool_use').name, 'record_probe', '... on Anthropic');
  const responsesProbe = await post(P.responses, bodies.responses({ tools: [{ type: 'function', name: 'record_probe', parameters: { type: 'object' } }] }));
  assert.equal(responsesProbe.json.output.find((item) => item.type === 'function_call').name, 'record_probe', '... and on Responses');
  const noTools = await post(P.anthropic, bodies.anthropic({ tools: undefined }));
  assert.equal(noTools.json.content[0].text, 'OK', 'a request that offers no tools is answered in text, as before');
  ok('the Hub\'s tool probe and its connectivity check are answered on all three routes');
}

{
  // Thinking blocks round-trip as the documentation says.
  const m = await server({ scenario: 'think', scenarios: { think: ({ turn }) => (turn === 0 ? withThinking('Plan: read it.', call('read_file', { path: 'a' })) : say('done')) } });
  const U = ENDPOINTS(m);
  const manual = { thinking: { type: 'enabled', budget_tokens: 2048 }, max_tokens: 4096 };
  const first = (await post(U.anthropic, bodies.anthropic(manual))).json;
  const use = first.content.find((block) => block.type === 'tool_use');
  const follow = (assistantContent) => bodies.anthropic({ ...manual, messages: [...bodies.anthropic().messages, { role: 'assistant', content: assistantContent }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: use.id, content: 'RESULT' }] }] });
  assert.equal((await post(U.anthropic, follow(first.content))).status, 200, 'the turn echoed back unmodified is accepted');
  const noThinking = await post(U.anthropic, follow(first.content.filter((block) => block.type !== 'thinking')));
  assert.equal(noThinking.status, 400, 'with extended thinking on, dropping the thinking block of a tool turn is refused');
  assert.match(noThinking.json.error.message, /Expected `thinking` or `redacted_thinking`, but found `tool_use`/);
  const edited = await post(U.anthropic, follow(first.content.map((block) => (block.type === 'thinking' ? { ...block, thinking: 'Plan: something else.' } : block))));
  assert.equal(edited.status, 400);
  assert.match(edited.json.error.message, /cannot be modified/);
  const forged = await post(U.anthropic, follow(first.content.map((block) => (block.type === 'thinking' ? { ...block, signature: 'forged' } : block))));
  assert.match(forged.json.error.message, /Invalid `signature` in `thinking` block/);
  const earlier = bodies.anthropic({ thinking: { type: 'adaptive' }, messages: [...bodies.anthropic().messages, { role: 'assistant', content: [first.content[0], { type: 'text', text: 'earlier answer' }] }, { role: 'user', content: 'next question' }] });
  assert.equal((await post(U.anthropic, earlier)).status, 200, 'a thinking block of an EARLIER turn is accepted (the API filters it)');
  ok('thinking blocks: accepted unmodified (also from earlier turns); refused when dropped from an extended-thinking tool turn, edited, or forged');

  const r = await server({ scenario: 'redact', scenarios: { redact: ({ turn }) => (turn === 0 ? withRedacted(call('read_file', { path: 'a' })) : say('done')) } });
  const R = ENDPOINTS(r);
  const redactedAnswer = (await post(R.anthropic, bodies.anthropic())).json;
  assert.equal(redactedAnswer.content[0].type, 'redacted_thinking');
  assert.equal(r.signer.verifyRedacted(redactedAnswer.content[0].data), true);
  const echo = bodies.anthropic({ messages: [...bodies.anthropic().messages, { role: 'assistant', content: redactedAnswer.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: redactedAnswer.content.find((block) => block.type === 'tool_use').id, content: 'RESULT' }] }] });
  assert.equal((await post(R.anthropic, echo)).status, 200, 'a redacted_thinking block is accepted when echoed back');
  const streamed = parseSse((await post(R.anthropic, bodies.anthropic({ stream: true }))).text);
  assert.deepEqual(validateAnthropicStream(streamed).errors, []);
  assert.equal(accumulateAnthropicStream(streamed).content[0].type, 'redacted_thinking');
  ok('redacted_thinking: emitted as JSON and as SSE, verified, accepted when echoed back');

  // Gemini: the thoughtSignature of a function call is passed back with it, unmodified.
  const g = await server({ scenario: 'gthink', scenarios: { gthink: ({ turn }) => (turn === 0 ? withThinking('Plan: read it.', call('read_file', { path: 'a' })) : say('done')) } });
  const G = ENDPOINTS(g).gemini;
  const modelTurn = (await post(G, bodies.gemini())).json.candidates[0].content;
  const followGemini = (content) => bodies.gemini({ contents: [...bodies.gemini().contents, content, { role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { output: 'RESULT' } } }] }] });
  assert.equal((await post(G, followGemini(modelTurn))).status, 200, 'the model turn echoed back unmodified is accepted');
  const forgedTurn = structuredClone(modelTurn);
  forgedTurn.parts.find((part) => part.functionCall).thoughtSignature = 'forged';
  const forgedAnswer = await post(G, followGemini(forgedTurn));
  assert.equal(forgedAnswer.status, 400);
  assert.equal(forgedAnswer.json.error.message, 'Corrupted thought signature.');
  const editedTurn = structuredClone(modelTurn);
  editedTurn.parts.find((part) => part.functionCall).functionCall.args = { path: 'somewhere else' };
  assert.equal((await post(G, followGemini(editedTurn))).status, 400, 'a call edited after it was signed is refused too');
  assert.equal(g.state.requests.at(-1).rejected.rule, 'gemini.thought_signature');
  ok('Gemini: the thoughtSignature of a function call is accepted unmodified and refused when forged or when the call was edited');
}

{
  // Truncation: stop_reason max_tokens / finish_reason length / status incomplete, with a call that is cut off.
  const m = await server({ scenario: 'cut', scenarios: { cut: () => truncated({ text: 'The answer begins', calls: [{ name: 'read_file', args: { path: 'a' } }] }) }, strict: true });
  const U = ENDPOINTS(m);
  const chat = (await post(U.chat, bodies.chat())).json;
  assert.equal(chat.choices[0].finish_reason, 'length');
  const anthropic = (await post(U.anthropic, bodies.anthropic())).json;
  assert.equal(anthropic.stop_reason, 'max_tokens');
  const responses = (await post(U.responses, bodies.responses())).json;
  assert.equal(responses.status, 'incomplete');
  assert.deepEqual(responses.incomplete_details, { reason: 'max_output_tokens' });
  assert.equal((await post(U.gemini, bodies.gemini())).json.candidates[0].finishReason, 'MAX_TOKENS');
  assert.throws(() => JSON.parse(chat.choices[0].message.tool_calls[0].function.arguments), 'a call the limit cut off carries half of its arguments: not JSON');
  assert.deepEqual(anthropic.content.find((block) => block.type === 'tool_use').input, {}, 'Anthropic: a cut-off tool_use has an empty input');
  assert.equal(responses.output.find((item) => item.type === 'function_call').status, 'incomplete', 'Responses: the cut-off function_call is incomplete');
  const streamed = await post(U.anthropic, bodies.anthropic({ stream: true }));
  assert.equal(accumulateAnthropicStream(parseSse(streamed.text)).stop_reason, 'max_tokens');
  const streamedResponses = accumulateResponsesStream(parseSse((await post(U.responses, bodies.responses({ stream: true }))).text));
  assert.equal(streamedResponses.status, 'incomplete', 'a truncated Responses stream ends with response.incomplete');
  ok('stop_reason max_tokens, finish_reason length and status incomplete (with incomplete_details), as JSON and as SSE');
}

{
  // The existing control routes and the watch work on every route.
  const m = await server({ scenario: 'canned-answer' });
  const U = ENDPOINTS(m);
  assert.deepEqual(await (await fetch(`${m.origin}/__ping`)).json(), { ok: true });
  const needle = 'secret-needle-123456';
  m.watch([needle]);
  await post(U.chat, bodies.chat({ messages: [{ role: 'user', content: `a ${needle} b` }] }));
  await post(U.anthropic, bodies.anthropic({ messages: [{ role: 'user', content: [{ type: 'text', text: `a ${needle} b` }] }] }));
  await post(U.responses, bodies.responses({ input: `a ${needle} b` }));
  await post(U.responses, bodies.responses({ input: 'clean' }));
  await post(U.gemini, bodies.gemini({ contents: [{ role: 'user', parts: [{ text: `a ${needle} b` }] }] }));
  const report = m.watchReport();
  assert.equal(report.scanned, 5);
  assert.deepEqual(report.hits.map((hit) => hit.request), [1, 2, 3, 5], 'the watch looks inside the body of a request on every route');
  const listed = await (await fetch(`${m.origin}/__requests`)).json();
  assert.equal(listed.requests.length, 5);
  assert.deepEqual(listed.requests.map((request) => request.protocol), ['chat', 'anthropic', 'responses', 'responses', 'gemini']);
  assert.equal(listed.requests.every((request) => request.hasAuthorization === false), true);
  assert.equal(m.state.requests[1].promptStart.startsWith('a secret-needle'), true);
  ok('the control routes, the watch for secrets and the recorded requests work on Chat, Anthropic, Responses and Gemini');

  // A Chat stream carries its usage chunk when asked for, or always when the server is told to (some compatible servers do).
  const always = await server({ scenario: 'canned-answer', streamUsage: 'always' });
  const alwaysEvents = parseSse((await post(ENDPOINTS(always).chat, bodies.chat({ stream: true }))).text);
  assert.deepEqual(validateChatStream(alwaysEvents, { includeUsage: true }).errors, [], 'streamUsage: always sends the usage chunk without being asked');
  assert.equal(validateChatStream(alwaysEvents, { includeUsage: false }).ok, false, 'and a client that did not ask for it can tell');
  ok('streamUsage: always puts the usage chunk in a Chat stream that did not ask for it');
}

// ---------------------------------------------------------------------------------------------------------------------
// 3. Faults at the network
// ---------------------------------------------------------------------------------------------------------------------
const APIS = ['chat', 'anthropic', 'responses'];
{
  const m = await server({ scenario: 'canned-answer', strict: true });
  const U = ENDPOINTS(m);
  for (const api of [...APIS, 'gemini']) {
    const fault = m.inject({ kind: 'payload-too-large', on: api });
    const refused = await post(U[api], bodies[api]());
    assert.equal(refused.status, 413, `${api}: 413`);
    if (api === 'anthropic') assert.deepEqual(refused.json, { type: 'error', error: { type: 'request_too_large', message: 'Request exceeds the maximum allowed number of bytes.' }, request_id: 'req_mock' });
    else if (api === 'gemini') assert.deepEqual(refused.json, { error: { code: 413, message: 'Request payload size exceeds the limit: 20971520 bytes.', status: 'INVALID_ARGUMENT' } });
    else assert.equal(refused.json.error.code, 'request_too_large');
    assert.equal(fault.used, 1);
    assert.equal((await post(U[api], bodies[api]())).status, 200, `${api}: a fault hits one request, the next one is answered`);
  }
  for (const api of APIS) {
    const fault = m.inject({ kind: 'stream-unsupported', on: api });
    assert.equal((await post(U[api], bodies[api]())).status, 200, `${api}: a request that does not ask for a stream passes`);
    assert.equal(fault.used, 0, 'and does not use the fault up');
    const refused = await post(U[api], bodies[api]({ stream: true }));
    assert.equal(refused.status, 400, `${api}: "stream not supported"`);
    assert.match(refused.json.error.message, /stream/i);
    assert.equal(fault.used, 1);
    assert.match((await post(U[api], bodies[api]({ stream: true }))).headers.get('content-type'), /event-stream/, `${api}: the stream after the fault works`);
  }
  assert.deepEqual(m.state.faultLog.map((entry) => entry.kind), ['payload-too-large', 'payload-too-large', 'payload-too-large', 'payload-too-large', 'stream-unsupported', 'stream-unsupported', 'stream-unsupported']);
  const noStreamGemini = m.inject({ kind: 'stream-unsupported', on: 'gemini' });
  assert.equal((await post(U.gemini, bodies.gemini())).status, 200, 'generateContent is never a stream, so "stream not supported" never fires on it');
  assert.equal(noStreamGemini.used, 0);
  m.clearFaults();
  const only = m.inject({ kind: 'status', status: 529, message: 'Overloaded', on: 'anthropic', headers: { 'retry-after': '3' } });
  assert.equal((await post(U.chat, bodies.chat())).status, 200, 'a fault for Anthropic leaves Chat alone');
  const overloaded = await post(U.anthropic, bodies.anthropic());
  assert.equal(overloaded.status, 529);
  assert.equal(overloaded.headers.get('retry-after'), '3');
  assert.equal(only.used, 1);
  ok('faults: HTTP 413 and 400 "stream not supported" (only for a stream) in each protocol\'s own error format, any status with headers, one request at a time, per protocol');

  const completeCount = {};
  const TERMINAL = { chat: /\[DONE\]/, anthropic: /message_stop/, responses: /terminal event/ };
  const STREAM_RULE = { chat: (events) => validateChatStream(events), anthropic: validateAnthropicStream, responses: validateResponsesStream };
  for (const api of APIS) {
    completeCount[api] = parseSse((await post(U[api], bodies[api]({ stream: true }))).text).length;
    const fault = m.inject({ kind: 'cut', on: api });
    const cut = parseSse((await post(U[api], bodies[api]({ stream: true }))).text);
    assert.equal(fault.used, 1);
    assert.equal(cut.length, completeCount[api] - 1, `${api}: everything but the terminal event arrives`);
    const outcome = STREAM_RULE[api](cut);
    assert.equal(outcome.ok, false);
    assert.match(outcome.errors.map((error) => error.message).join(' | '), TERMINAL[api], `${api}: the stream check names the missing terminal event`);
  }
  const reset = m.inject({ kind: 'cut', on: 'chat', stream: false, reset: true });
  await assert.rejects(post(U.chat, bodies.chat()), undefined, 'a connection torn down in the middle of a JSON body');
  assert.equal(reset.used, 1);
  assert.equal((await post(U.chat, bodies.chat())).status, 200);
  ok('faults: a stream cut before its terminal event (all but the last event arrive, the stream check names it), a connection reset in the middle of a body');

  const stall = m.inject({ kind: 'stall', on: 'responses', afterEvents: 3 });
  const started = Date.now();
  let seen = '';
  let how = 'ended';
  try {
    const response = await fetch(U.responses, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bodies.responses({ stream: true })), signal: AbortSignal.timeout(400) });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    for (;;) { const { done, value } = await reader.read(); if (done) break; seen += decoder.decode(value, { stream: true }); }
  } catch (error) { how = error.name; }
  const waited = Date.now() - started;
  assert.equal(how, 'TimeoutError', 'the client gives up; the server does not end the stream');
  assert.ok(waited >= 350 && waited < 3000, `after the timeout (${waited} ms)`);
  assert.equal(parseSse(seen).length, 3, 'exactly the events before the stall arrived');
  assert.equal(stall.used, 1);
  const slow = m.inject({ kind: 'stall', on: 'responses', afterEvents: 2, ms: 150 });
  const resumed = Date.now();
  const whole = parseSse((await post(U.responses, bodies.responses({ stream: true }))).text);
  assert.ok(Date.now() - resumed >= 140, 'a stall with ms is a slow server: it resumes');
  assert.deepEqual(validateResponsesStream(whole).errors, [], 'and the stream is complete');
  assert.equal(slow.used, 1);
  ok('faults: an idle stall of a stream (the client times out after the events that arrived) and a stall that resumes');
}

// ---------------------------------------------------------------------------------------------------------------------
// 4. Contract: real adapters, six canned conversations, each protocol
// ---------------------------------------------------------------------------------------------------------------------
const TOOLS = [{ type: 'function', name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } }, strict: false }];
const userText = (value) => [{ type: 'input_text', text: value }];
const finalText = (turn) => turn.output.filter((item) => item.type === 'message').flatMap((item) => item.content).map((part) => part.text ?? part.refusal ?? '').join('');
const functionCalls = (turn) => turn.output.filter((item) => item.type === 'function_call');

/** The adapters under test, pointed at one mock server. */
const rows = (m, { limits, timeoutMs = 5000, idleTimeoutMs } = {}) => {
  const standard = (protocol, path, headers, stream = false) => (input, options = {}) => respondStandard(
    { protocol, endpoint: `${m.url}/${path}`, headers, model: 'mock-coder', fetch, sleep: async () => {}, redact: (value) => value, stream, limits: { requestTimeoutMs: 5000, ...limits } },
    { input, instructions: 'system', tools: TOOLS, maxOutputTokens: 1024, ...options });
  const responses = (stream) => (input, options = {}) => respondOpenAIResponses(
    { model: 'mock-coder', endpoint: `${m.url}/responses`, headers: { 'content-type': 'application/json' }, fetch, timeoutMs, idleTimeoutMs, redact: (value) => value, stream },
    { input, instructions: 'system', tools: TOOLS, maxOutputTokens: 1024, ...options });
  // Gemini has no function of its own: its loop is GatewayProvider.respond. A no-op sleep, because that loop retries a thrown
  // TypeError as a network failure with 3-30 s waits and no cap, which would turn a bug into a hang; and a signal to bound each call.
  const gemini = new GatewayProvider({ directory: path.join(os.tmpdir(), 'chatmcp-mock-gemini-unused'), bundleRoot: os.tmpdir(), manager: { secrets: [] }, env: {}, sleep: async () => {} })
    .forkForTask({ protocol: 'gemini', apiBaseUrl: m.origin, model: 'mock-gemini' });
  return {
    chat: { label: 'respondStandard / Chat Completions', api: 'chat', run: standard('openai-chat', 'chat/completions', { 'content-type': 'application/json' }) },
    'chat-sse': { label: 'respondStandard / Chat Completions / SSE', api: 'chat', run: standard('openai-chat', 'chat/completions', { 'content-type': 'application/json' }, true) },
    anthropic: { label: 'respondStandard / Anthropic Messages', api: 'anthropic', run: standard('anthropic', 'messages', anthropicHeaders('test-key')) },
    'anthropic-sse': { label: 'respondStandard / Anthropic Messages / SSE', api: 'anthropic', run: standard('anthropic', 'messages', anthropicHeaders('test-key'), true) },
    responses: { label: 'respondOpenAIResponses / JSON', api: 'responses', run: responses(false) },
    'responses-sse': { label: 'respondOpenAIResponses / SSE', api: 'responses', run: responses(true) },
    // The plain Gemini row never gets onToken (a caller that shows the text gets the stream route); the SSE row does.
    gemini: { label: 'GatewayProvider / Gemini generateContent', api: 'gemini', run: (input, options = {}) => gemini.respond({ input, instructions: 'system', tools: TOOLS, maxOutputTokens: 1024, signal: AbortSignal.timeout(8000), ...options, onToken: undefined, onStreamReset: undefined }) },
    'gemini-sse': { label: 'GatewayProvider / Gemini streamGenerateContent', api: 'gemini', run: (input, options = {}) => gemini.respond({ input, instructions: 'system', tools: TOOLS, maxOutputTokens: 1024, signal: AbortSignal.timeout(8000), ...options }) },
  };
};

/** The loop an agent runs, with the real ledger as its history: ask, run the calls, put the results in, ask again. */
async function converse(row, m, scenarioName, { prompt = 'Do the thing.' } = {}) {
  m.setScenario(scenarioName);
  const ledger = new HistoryLedger();
  ledger.appendUser(userText(prompt), { kind: 'prompt' });
  const turns = [];
  const tokens = [];
  for (let step = 0; step < 6; step += 1) {
    ledger.beginBatch();
    const turn = await row.run(ledger.snapshotForModel(), { onToken: (token) => tokens.push(token) });
    turns.push(turn);
    ledger.appendModelOutput(turn.output);
    const pending = turn.status === 'completed' ? functionCalls(turn) : [];
    for (const item of pending) ledger.appendToolOutput(item.call_id, `result of ${item.name} ${item.arguments}`);
    ledger.endBatch();
    if (!pending.length) break;
  }
  return { turns, ledger, tokens, requests: m.state.requests.slice() };
}

const contract = await server({ scenario: 'canned-answer', strict: true });
const ROWS = rows(contract);
const compat = await server({ scenario: 'canned-thinking', strict: true, chatDialect: 'compat' });
const findings = [];
for (const [name, row] of Object.entries(ROWS)) {
  const label = row.label;
  const accepted = (run) => assert.equal(run.requests.every((request) => request.rejected === null), true, `${label}: the strict server refused a request: ${JSON.stringify(run.requests.map((request) => request.rejected))}`);

  const answer = await converse(row, contract, 'canned-answer');
  assert.equal(answer.turns.length, 1, `${label}: one request`);
  assert.equal(answer.turns[0].status, 'completed');
  assert.equal(finalText(answer.turns[0]), 'Hello from the mock.');
  assert.deepEqual([answer.turns[0].usage.input_tokens, answer.turns[0].usage.output_tokens], [120, 24], `${label}: usage`);
  accepted(answer);
  if (name === 'responses-sse' || name === 'chat-sse' || name === 'anthropic-sse' || name === 'gemini-sse') assert.equal(answer.tokens.join(''), 'Hello from the mock.', 'the SSE row delivers the text as tokens');
  if (name === 'chat-sse' || name === 'anthropic-sse' || name === 'gemini-sse') assert.deepEqual(answer.requests.map((request) => request.stream), [true], 'and the request really was a stream');
  if (name === 'gemini') assert.deepEqual(answer.requests.map((request) => request.stream), [false], 'the plain row asks for the plain route');

  const one = await converse(row, contract, 'canned-one-tool');
  assert.equal(one.turns.length, 2, `${label}: a call, then the answer`);
  assert.equal(functionCalls(one.turns[0]).length, 1);
  assert.equal(functionCalls(one.turns[0])[0].name, 'read_file');
  assert.deepEqual(JSON.parse(functionCalls(one.turns[0])[0].arguments), { path: 'README.md' });
  assert.equal(finalText(one.turns[1]), 'README says: result of read_file {"path":"README.md"}', `${label}: the tool result went through the wire format and came back in the answer`);
  accepted(one);
  const last = contract.state.lastBody;
  if (row.api === 'chat') assert.deepEqual(last.messages.slice(-2).map((message) => message.role), ['assistant', 'tool']);
  if (row.api === 'anthropic') assert.deepEqual(last.messages.slice(-1)[0].content.map((block) => block.type), ['tool_result']);
  if (row.api === 'responses') assert.deepEqual(last.input.slice(-2).map((item) => item.type), ['function_call', 'function_call_output']);
  if (row.api === 'gemini') assert.deepEqual(last.contents.slice(-2).map((content) => [content.role, Object.keys(content.parts[0])[0]]), [['model', 'functionCall'], ['user', 'functionResponse']]);

  const parallel = await converse(row, contract, 'canned-parallel');
  assert.equal(parallel.turns.length, 2);
  const parallelCalls = functionCalls(parallel.turns[0]);
  assert.equal(parallelCalls.length, 2, `${label}: two calls in one model turn`);
  assert.notEqual(parallelCalls[0].call_id, parallelCalls[1].call_id);
  assert.equal(finalText(parallel.turns[1]), 'both: result of read_file {"path":"a.txt"} | result of read_file {"path":"b.txt"}', `${label}: both results, in order`);
  accepted(parallel);
  const lastParallel = contract.state.lastBody;
  if (row.api === 'chat') assert.deepEqual(lastParallel.messages.slice(-3).map((message) => message.role), ['assistant', 'tool', 'tool'], 'one assistant message with two calls, then both results');
  if (row.api === 'anthropic') assert.deepEqual(lastParallel.messages.slice(-1)[0].content.map((block) => block.type), ['tool_result', 'tool_result'], 'both results in ONE user message');
  if (row.api === 'responses') assert.deepEqual(lastParallel.input.slice(-4).map((item) => item.type), ['function_call', 'function_call', 'function_call_output', 'function_call_output']);
  if (row.api === 'gemini') assert.deepEqual(lastParallel.contents.slice(-2).map((content) => content.parts.map((part) => Object.keys(part)[0])), [['functionCall', 'functionCall'], ['functionResponse', 'functionResponse']], 'one model turn with two calls, one user turn with two responses');

  // Chat reasoning exists only in the compat dialect (reasoning_content, as DeepSeek sends it), so that row talks to the compat server.
  const thinkingServer = name === 'chat' || name === 'chat-sse' ? compat : contract;
  const thought = await converse(name === 'chat' || name === 'chat-sse' ? rows(compat)[name] : row, thinkingServer, 'canned-thinking');
  assert.equal(finalText(thought.turns.at(-1)), 'Done thinking.');
  assert.equal(thought.turns.length, 2);
  accepted(thought);
  const replayBody = thinkingServer.state.lastBody;
  if (row.api === 'responses') {
    assert.equal(thought.turns[0].output.some((item) => item.type === 'reasoning' && typeof item.encrypted_content === 'string'), true, `${label}: encrypted reasoning comes back`);
    assert.equal(replayBody.input.some((item) => item.type === 'reasoning' && typeof item.encrypted_content === 'string'), true, `${label}: and is sent back with the next request (store: false)`);
  }
  if (row.api === 'chat') {
    assert.equal(replayBody.messages.find((message) => message.role === 'assistant').reasoning_content, 'I should read c.txt first.', 'Chat (compat dialect): reasoning_content of the turn in progress is sent back');
  }
  if (name === 'anthropic') findings.push(`Anthropic: the thinking block of the previous turn was ${replayBody.messages.some((message) => Array.isArray(message.content) && message.content.some((block) => block.type === 'thinking')) ? '' : 'NOT '}sent back with the tool result`);

  if (row.api === 'gemini') {
    const modelTurn = replayBody.contents.find((content) => content.role === 'model');
    assert.equal(typeof modelTurn.parts.find((part) => part.functionCall).thoughtSignature, 'string', `${label}: the thoughtSignature of the call is sent back with it`);
  }

  if (row.api === 'gemini') {
    // The native Gemini path throws on MAX_TOKENS instead of returning an incomplete response, as the other protocols do.
    const failure = await converse(row, contract, 'canned-truncated').then(() => null, (error) => error);
    assert.equal(failure?.code, 'model_incomplete', `${label}: MAX_TOKENS is an error`);
    assert.equal(contract.state.requests.length, 1);
    assert.equal(contract.state.requests[0].rejected, null);
  } else {
    const cut = await converse(row, contract, 'canned-truncated');
    assert.equal(cut.turns.length, 1, `${label}: a truncated answer ends the conversation, no tool is run`);
    assert.equal(cut.turns[0].status, 'incomplete');
    assert.equal(cut.turns[0].incomplete_details.reason, 'max_output_tokens');
    assert.equal(functionCalls(cut.turns[0]).length, 0, 'the call that the limit cut off is never returned');
    assert.equal(cut.ledger.snapshotForModel().some((item) => item.type === 'function_call_output'), false);
    if (row.api !== 'responses') assert.equal(finalText(cut.turns[0]), 'The answer is cut o');
    accepted(cut);
  }

  const cached = await converse(row, contract, 'canned-cache-usage');
  const usage = cached.turns[0].usage;
  assert.deepEqual([usage.input_tokens, usage.output_tokens, usage.cache_read_tokens], [450, 20, 300], `${label}: input = uncached + cache read + cache write; output; cache read`);
  if (row.api === 'anthropic') assert.equal(usage.cache_creation_tokens, 50);
  accepted(cached);
}
assert.equal(CANNED_CONVERSATIONS.length, 6);
assert.ok(CANNED_CONVERSATIONS.every((name) => typeof SCENARIOS[name] === 'function'), 'the six canned conversations are registered scenarios');
ok(`contract: ${Object.keys(ROWS).length} adapter paths x ${CANNED_CONVERSATIONS.length} canned conversations (answer, one tool, parallel tools, thinking, truncation, cache usage) all complete against the strict servers, and the tool results make the round trip in each wire format`);
for (const finding of findings) note(finding);

// ---------------------------------------------------------------------------------------------------------------------
// 5. Faults reaching the real adapters
// ---------------------------------------------------------------------------------------------------------------------
{
  const m = await server({ scenario: 'canned-answer', strict: true });
  const bigHistory = () => {
    const ledger = new HistoryLedger();
    ledger.appendUser(userText('A long task.'));
    for (let i = 1; i <= 6; i += 1) {
      ledger.beginBatch();
      ledger.appendModelOutput([{ type: 'function_call', call_id: `old_${i}`, name: 'read_file', arguments: JSON.stringify({ path: `f${i}.txt` }), status: 'completed' }]);
      ledger.appendToolOutput(`old_${i}`, `file ${i}: ${'0123456789 '.repeat(600)}`);
      ledger.endBatch();
    }
    return ledger;
  };

  for (const name of ['chat', 'anthropic']) {
    const row = rows(m)[name];
    const history = bigHistory();
    const before = JSON.stringify(history.snapshotForModel());
    const fault = m.inject({ kind: 'payload-too-large', on: name });
    m.setScenario('canned-answer');
    const kinds = [];
    const result = await row.run(history.snapshotForModel(), { onStatus: async (message, kind) => kinds.push(kind) });
    assert.equal(result.status, 'completed', `${name}: the request is repeated after a 413`);
    const [first, second] = m.state.requests;
    assert.equal(first.fault, 'payload-too-large');
    assert.ok(second.bytes < first.bytes * 0.8, `${name}: the second request is smaller (${first.bytes} -> ${second.bytes} bytes): old tool results became stubs`);
    assert.ok(kinds.includes('context_compaction'), `${name}: the adapter said it compacted`);
    assert.equal(JSON.stringify(history.snapshotForModel()), before, `${name}: the agent's own history is untouched`);
    assert.equal(fault.used, 1);
  }
  ok('a 413 reaches respondStandard (Chat and Anthropic): it compacts the COPY it sends, repeats only the model request and leaves the history as it was');

  const row = rows(m, { limits: { requestTimeoutMs: 600 } }).chat;
  for (const spec of [{ kind: 'stall', stream: false, label: 'stalls in the middle of the body' }, { kind: 'cut', stream: false, reset: true, label: 'loses the connection in the middle of the body' }]) {
    m.setScenario('canned-answer');
    const fault = m.inject({ on: 'chat', ...spec });
    const notes = [];
    const started = Date.now();
    const result = await row.run(bigHistory().snapshotForModel(), { onStatus: async (message) => notes.push(message) });
    assert.equal(result.status, 'completed', `a server that ${spec.label}: the model request is repeated and answered`);
    assert.equal(m.state.requests.length, 2, 'exactly one repeat, and no tool was run twice');
    assert.ok(notes.some((message) => /Mất kết nối/.test(message)), 'the adapter reported the lost connection');
    assert.ok(Date.now() - started < 4000);
    assert.equal(fault.used, 1);
  }
  ok('respondStandard repeats the model request after a stalled body (its timeout) and after a torn-down connection');

  const streaming = rows(m, { timeoutMs: 600 })['responses-sse'];
  m.setScenario('canned-answer');
  const tokens = [];
  const cutFault = m.inject({ kind: 'cut', on: 'responses', stream: true });
  const interrupted = await streaming.run(userText('hi'), { onToken: (token) => tokens.push(token) }).then(() => null, (error) => error);
  assert.equal(interrupted?.code, 'responses_stream_interrupted', 'a Responses stream that ends without response.completed is an error');
  assert.equal(tokens.join(''), 'Hello from the mock.', 'the text reached onToken, but the answer was not accepted');
  assert.equal(m.state.requests.length, 1, 'and it is not repeated (no tool call can be replayed by accident)');
  assert.equal(cutFault.used, 1);

  // A stall in the middle of a stream can be ended by two clocks, and each one says so in its own code: the idle timeout (no bytes for
  // that long) and the timeout of the whole call. Here the idle clock is 300 ms and the whole call 2.5 s, so the time it takes tells which.
  const hi = () => [{ role: 'user', content: userText('hi') }];
  m.setScenario('canned-answer');
  const idleStall = m.inject({ kind: 'stall', on: 'responses', stream: true, afterEvents: 4 });
  const startedIdle = Date.now();
  const idled = await rows(m, { timeoutMs: 2500, idleTimeoutMs: 300 })['responses-sse'].run(hi()).then(() => null, (error) => error);
  const idleWaited = Date.now() - startedIdle;
  assert.equal(idled?.code, 'responses_idle_timeout', `a stalled stream ends with the idle timeout (got ${idled?.name} ${idled?.code})`);
  assert.equal(idled.kind, 'network', 'which is a network failure like the others');
  assert.ok(idleWaited >= 250 && idleWaited < 2000, `after the idle time, not after the timeout of the whole call (${idleWaited} ms)`);
  assert.equal(m.state.requests.length, 1, 'the model request is not repeated');
  assert.equal(idleStall.used, 1);

  m.setScenario('canned-answer');
  m.inject({ kind: 'stall', on: 'responses', stream: true, afterEvents: 4 });
  const startedStall = Date.now();
  const stalled = await streaming.run(hi()).then(() => null, (error) => error);
  const stallWaited = Date.now() - startedStall;
  assert.equal(stalled?.code, 'responses_timeout', `the timeout of the whole call in the middle of a stream is a coded error, not a raw ${stalled?.name}`);
  assert.equal(stalled.kind, 'network');
  assert.ok(stallWaited >= 550 && stallWaited < 3000, `after the whole-call timeout (${stallWaited} ms)`);
  assert.equal(m.state.requests.length, 1, 'and the model request is not repeated');

  // A JSON body that stalls is the whole call timing out too (this is also the path of a request repeated without a stream).
  m.setScenario('canned-answer');
  m.inject({ kind: 'stall', on: 'responses', stream: false });
  const bodyStalled = await rows(m, { timeoutMs: 600 }).responses.run(hi()).then(() => null, (error) => error);
  assert.equal(bodyStalled?.code, 'responses_timeout', `a stalled JSON body is the same coded error (got ${bodyStalled?.name} ${bodyStalled?.code})`);
  assert.equal(bodyStalled.kind, 'network');
  m.clearFaults();
  ok('respondOpenAIResponses: a stream cut before its terminal event ends with an error and is not repeated; a stalled stream ends with a coded network error (idle timeout, or the timeout of the whole call), also when the body is JSON');

  // A gateway that answers 400 to stream: true ("stream not supported"). AgentRunner always streams (it always passes onToken), so such
  // a gateway used to fail every task. The same model request is repeated once without the stream; no tool is involved.
  m.setScenario('canned-answer');
  const noStream = m.inject({ kind: 'stream-unsupported', on: 'responses' });
  const seenTokens = [];
  const statuses = [];
  let announced = 0;
  const repeated = await streaming.run(hi(), { onToken: (token) => seenTokens.push(token), onStatus: async (message) => statuses.push(message), beforeModelRequest: () => { announced += 1; } });
  assert.equal(repeated.status, 'completed', 'the model request is repeated once without stream: true and answered');
  assert.deepEqual(m.state.requests.map((request) => request.stream), [true, false], 'the refused request, then the same request without a stream');
  assert.equal(m.state.requests[0].fault, 'stream-unsupported');
  assert.deepEqual(m.state.requests.map((request) => request.rejected), [null, null], 'the strict server accepts the repeated request');
  const [refusedRequest, repeatedRequest] = m.state.requests;
  assert.deepEqual([repeatedRequest.messages, repeatedRequest.tools, repeatedRequest.turn, repeatedRequest.promptStart], [refusedRequest.messages, refusedRequest.tools, refusedRequest.turn, refusedRequest.promptStart], 'it is the same model request');
  assert.equal(announced, 2, 'both requests were announced to the caller, which counts the attempts');
  assert.equal(statuses.length, 1, 'the person is told once');
  assert.match(statuses[0], /stream: false/, 'what is being done');
  assert.match(statuses[0], /không chạy lại công cụ/, 'and that no tool runs again');
  assert.equal(seenTokens.join(''), 'Hello from the mock.', 'onToken still gets the text, at the end');
  assert.equal(noStream.used, 1);

  // The provider remembers a refusal for that endpoint and model: the next call does not ask for a stream again.
  const makeProvider = (limits) => new GatewayProvider({ directory: path.join(os.tmpdir(), 'chatmcp-mock-responses-unused'), bundleRoot: os.tmpdir(), manager: { secrets: [] }, env: {}, sleep: async () => {}, limits })
    .forkForTask({ protocol: 'openai-responses', apiBaseUrl: m.origin, model: 'mock-coder' });
  const provider = makeProvider({ requestTimeoutMs: 5000 });
  const ask = (options = {}) => provider.respond({ input: hi(), instructions: 'system', tools: TOOLS, maxOutputTokens: 1024, signal: AbortSignal.timeout(8000), ...options });
  const said = [];
  const gotText = [];
  const listen = { onToken: (token) => gotText.push(token), onStatus: async (message) => said.push(message) };
  m.setScenario('canned-answer');
  const refusal = m.inject({ kind: 'stream-unsupported', on: 'responses', times: 5 });
  assert.equal((await ask(listen)).status, 'completed');
  assert.equal((await ask(listen)).status, 'completed');
  assert.deepEqual(m.state.requests.map((request) => request.stream), [true, false, false], 'the second call does not try a stream again');
  assert.equal(refusal.used, 1, 'the gateway refused once');
  assert.equal(said.length, 1, 'and was announced once');
  assert.equal(gotText.join(''), 'Hello from the mock.Hello from the mock.', 'the text of both answers reached onToken');
  provider.model = 'mock-coder-2';
  assert.equal((await ask(listen)).status, 'completed');
  assert.deepEqual(m.state.requests.map((request) => request.stream), [true, false, false, true, false], 'another model asks for a stream again');
  assert.equal(refusal.used, 2);
  assert.equal((await ask(listen)).status, 'completed');
  assert.deepEqual(m.state.requests.slice(5).map((request) => request.stream), [false], 'and the refusal of that model is remembered too');
  provider.apiBaseUrl = `${m.origin}/gateway`;
  assert.equal((await ask(listen)).status, 'completed');
  assert.deepEqual(m.state.requests.slice(6).map((request) => request.stream), [true, false], 'another endpoint asks for a stream again');
  assert.equal(refusal.used, 3);
  m.clearFaults();
  ok('respondOpenAIResponses: a stream refused with HTTP 400 is repeated once without stream: true (announced, both requests counted, the text arrives at the end); the provider does not ask again for that endpoint and model, and does for another');

  // The idle timeout is a limit of the provider next to the request timeout.
  m.setScenario('canned-answer');
  m.inject({ kind: 'stall', on: 'responses', stream: true, afterEvents: 4 });
  const startedProvider = Date.now();
  const impatient = makeProvider({ requestTimeoutMs: 2500, idleTimeoutMs: 300 });
  const providerIdle = await impatient.respond({ input: hi(), instructions: 'system', tools: TOOLS, maxOutputTokens: 1024, signal: AbortSignal.timeout(8000), onToken: () => {} }).then(() => null, (error) => error);
  assert.equal(providerIdle?.code, 'responses_idle_timeout', `through GatewayProvider (got ${providerIdle?.name} ${providerIdle?.code})`);
  assert.ok(Date.now() - startedProvider < 2000);
  assert.deepEqual([impatient.normalizeError(providerIdle).kind, impatient.normalizeError(providerIdle).retryable], ['network', true], 'the provider reports it like the other network failures');
  m.clearFaults();
  ok('GatewayProvider passes limits.idleTimeoutMs to the Responses adapter, and its stall error is a retryable network failure');
}

// ---------------------------------------------------------------------------------------------------------------------
// 6. The real Hub code against the strict servers: AgentRunner -> GatewayProvider -> real adapters -> network -> mock
// ---------------------------------------------------------------------------------------------------------------------
{
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-mock-agent-'));
  try {
    const listing = { content: [{ type: 'text', text: '[FILE] README.md' }] };
    let toolRuns = 0;
    const manager = {
      secrets: [], generation: 1, instanceId: 'mock-agent', locked: false,
      state() { return { workspace: { path: root }, generation: 1, instanceId: this.instanceId }; },
      acquireTask() { if (this.locked) return false; this.locked = true; return true; },
      releaseTask() { this.locked = false; },
      async createAgentSession() {
        return {
          catalog: { tools: [{ name: 'desktop-commander.list_directory', server: 'desktop-commander', inputSchema: { type: 'object' } }], prompts: [], resources: [], resourceTemplates: [], servers: {} },
          async close() {},
          async callTool(name, args, { onDecision } = {}) { toolRuns += 1; await onDecision?.({ name, category: 'read', allowed: true }); return listing; },
        };
      },
    };
    const listDirectory = () => ({ name: 'mcp_call', args: { name: 'desktop-commander.list_directory', arguments_json: JSON.stringify({ path: root }) } });
    // Four identical listings, then one model turn with two calls (the first of them is the fifth identical observation, which makes
    // the host write a recovery hint), then the answer. A counter, not `turn`: the hint is a user message and moves the turn count.
    const script = () => { let step = 0; return () => { step += 1; return step <= 4 ? { calls: [listDirectory()] } : step === 5 ? { calls: [listDirectory(), listDirectory()] } : { text: 'Done.' }; }; };
    for (const [format, api] of [['openai-chat', 'chat'], ['anthropic', 'anthropic'], ['openai-responses', 'responses'], ['gemini', 'gemini']]) {
      const m = await server({ scenario: 'agent', scenarios: { agent: script() }, strict: true });
      const gateway = new GatewayProvider({ directory: path.join(root, `gateway-${api}`), bundleRoot: root, manager, env: {} });
      const provider = gateway.forkForTask({ protocol: format, apiBaseUrl: m.origin, model: 'mock-coder' });
      const runner = new AgentRunner({ manager, provider, taskDirectory: path.join(root, `tasks-${api}`) });
      await runner.load();
      await runner.start({ prompt: 'Look at the project until you know enough.' });
      const task = await Promise.race([runner.context.done.promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${api}: the agent run timed out`)), 15000))]);
      assert.equal(task.status, 'completed', `${api}: ${task.error ?? ''} ${JSON.stringify(m.state.rejections.at(-1)?.errors?.[0] ?? null)}`);
      assert.equal(m.state.requests.length, 6, `${api}: six model requests`);
      assert.deepEqual(m.state.requests.map((request) => request.rejected), Array(6).fill(null), `${api}: the strict server refused nothing the Hub sent`);
      assert.ok(task.events.some((event) => event.type === 'progress_warning' || event.type === 'progress_recovery'), `${api}: the recovery hint was really written`);
      const lastBody = m.state.lastBody;
      if (api === 'chat') {
        assert.deepEqual(lastBody.messages.slice(-4).map((message) => message.role), ['assistant', 'tool', 'tool', 'user'], 'Chat: the hint follows BOTH results');
        assert.match(lastBody.messages.at(-1).content, /^HOST STAGNATION RECOVERY 1\/2\./);
      }
      if (api === 'anthropic') {
        const tail = lastBody.messages.at(-1).content.map((block) => block.type);
        assert.deepEqual(tail, ['tool_result', 'tool_result', 'text'], 'Anthropic: both results lead the user message, the hint follows');
      }
      if (api === 'responses') assert.deepEqual(lastBody.input.slice(-5).map((item) => item.type ?? item.role), ['function_call', 'function_call', 'function_call_output', 'function_call_output', 'user']);
      if (api === 'gemini') {
        assert.deepEqual(lastBody.contents.slice(-2).map((content) => content.role), ['model', 'user']);
        assert.deepEqual(lastBody.contents.at(-1).parts.map((part) => Object.keys(part)[0]), ['functionResponse', 'functionResponse', 'text'], 'Gemini: both responses lead the user turn, the hint follows');
      }
      await runner.shutdown();
    }
    ok('real AgentRunner -> GatewayProvider -> real adapters -> network -> strict mock, on Chat, Anthropic, Responses and Gemini: a turn with two calls and a recovery hint is accepted, the hint follows both results');

    // AgentRunner always streams (it always passes onToken). A Responses gateway that answers 400 to stream: true used to fail the task at
    // its first model request. Now only that model request is repeated, once, and the later steps do not ask for a stream again.
    {
      const m = await server({ scenario: 'agent', scenarios: { agent: script() }, strict: true });
      const refusal = m.inject({ kind: 'stream-unsupported', on: 'responses', times: 50 });
      const gateway = new GatewayProvider({ directory: path.join(root, 'gateway-refused'), bundleRoot: root, manager, env: {} });
      const provider = gateway.forkForTask({ protocol: 'openai-responses', apiBaseUrl: m.origin, model: 'mock-coder' });
      const runner = new AgentRunner({ manager, provider, taskDirectory: path.join(root, 'tasks-refused') });
      await runner.load();
      const runsBefore = toolRuns;
      await runner.start({ prompt: 'Look at the project until you know enough.' });
      const task = await Promise.race([runner.context.done.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('refused stream: the agent run timed out')), 15000))]);
      assert.equal(task.status, 'completed', `a gateway that refuses stream: true no longer fails the task: ${task.error ?? ''}`);
      assert.deepEqual(m.state.requests.map((request) => request.stream), [true, false, false, false, false, false, false], 'one refused request, then the six model requests of the script, none of them with a stream');
      assert.equal(refusal.used, 1, 'the gateway was asked for a stream once');
      assert.equal(toolRuns - runsBefore, 6, 'the refused request repeated no tool: each of the six calls of the script ran once');
      assert.deepEqual(m.state.requests.map((request) => request.rejected), Array(7).fill(null));
      assert.equal(task.events.filter((event) => event.type === 'network_wait' && /stream: false/.test(event.message)).length, 1, 'the task says once, in its events, that the request was repeated without a stream');
      assert.equal(task.usage.httpRequests, 7, 'the request meter counted the refused request and its repeat');
      await runner.shutdown();
      ok('real AgentRunner against a Responses gateway that refuses stream: true: the task completes, only the first model request is repeated (without a stream), no tool runs twice, later steps do not ask for a stream, the request meter counts 7');
    }

    // The same gateway going quiet in the middle of the stream. The task used to end with the numeric code of a raw DOMException
    // (TimeoutError, 23) as its errorCode; now it ends with the code of the idle timeout, as a failed network call of any adapter does.
    {
      const m = await server({ scenario: 'agent', scenarios: { agent: script() }, strict: true });
      m.inject({ kind: 'stall', on: 'responses', stream: true, afterEvents: 4 });
      const gateway = new GatewayProvider({ directory: path.join(root, 'gateway-quiet'), bundleRoot: root, manager, env: {}, limits: { requestTimeoutMs: 2500, idleTimeoutMs: 300 } });
      const provider = gateway.forkForTask({ protocol: 'openai-responses', apiBaseUrl: m.origin, model: 'mock-coder' });
      const runner = new AgentRunner({ manager, provider, taskDirectory: path.join(root, 'tasks-quiet') });
      await runner.load();
      const runsBefore = toolRuns;
      const startedQuiet = Date.now();
      await runner.start({ prompt: 'Look at the project until you know enough.' });
      const task = await Promise.race([runner.context.done.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('stalled stream: the agent run timed out')), 15000))]);
      assert.equal(task.status, 'failed');
      assert.equal(task.errorCode, 'responses_idle_timeout', `the task reports the idle timeout (got ${task.errorCode}: ${task.error})`);
      assert.match(task.error, /no data for 300 ms/);
      assert.match(task.error, /No tool was run for this step/);
      assert.ok(Date.now() - startedQuiet < 2000, 'the idle clock ended it, not the whole-call timeout');
      assert.equal(m.state.requests.length, 1, 'the model request is not repeated');
      assert.equal(toolRuns, runsBefore, 'no tool ran');
      await runner.shutdown();
      ok('real AgentRunner against a Responses stream that goes quiet: the task fails with errorCode responses_idle_timeout (it was 23, the code of a raw TimeoutError), no model request is repeated, no tool runs');
    }

    // The same history written the OLD way (the hint between two results) is refused at the network by the strict Chat route.
    const m = await server({ scenario: 'canned-answer', strict: true });
    const old = [
      { role: 'user', content: userText('task') },
      { type: 'function_call', call_id: 'a', name: 'read_file', arguments: '{}' }, { type: 'function_call', call_id: 'b', name: 'read_file', arguments: '{}' },
      { type: 'function_call_output', call_id: 'a', output: 'result a' },
      { role: 'user', content: userText('HOST STAGNATION RECOVERY 1/2.') },
      { type: 'function_call_output', call_id: 'b', output: 'result b' },
    ];
    const refused = await post(ENDPOINTS(m).chat, buildChatBody({ model: 'mock-coder', input: pairToolCalls(old), instructions: 'system', tools: TOOLS }));
    assert.equal(refused.status, 400, 'the history the agent used to write is refused by the strict Chat route');
    assert.match(refused.json.error.message, /An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'. The following tool_call_ids did not have response messages: b/);
    assert.equal(m.state.requests.at(-1).rejected.rule, 'chat.tool_result_placement');
    ok('negative control: the same turn written the old way (hint between two results), through the real Chat converter, gets HTTP 400 from the strict mock');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

for (const close of closers.reverse()) await close();
console.log(`PASS: ${checks} checks (mock protocols)`);
