// Anthropic thinking blocks, kept and sent back (prov-18).
//
// Claude 5 models think by default, and a response that thinks starts with `thinking` blocks whose signature carries the reasoning (the text is empty unless a summary is asked for) or with
// `redacted_thinking`. Until now the Hub threw them away. On these models the signature records the model and the conversation before the block: the system prompt, the set of tools and every
// message; a request that replays the block after any of them changed is refused, on accounts created from 2026-08-31 on by default ("bound to a different conversation"). So sending the
// blocks back is only safe where nothing before them changed, and the Hub edits its own history (it shortens old tool results to fit a window). What this file checks:
//   1. Capture: normalizeAnthropic keeps the blocks verbatim (an empty thinking text included) on the first item of the answer, or none at all when they cannot be kept in their place.
//   2. The binding: the answer is tied to the conversation it was made in (digest of the system prompt, the tools and the messages, never cache_control or thinking blocks), the model and the origin.
//   3. Replay: buildAnthropicBody puts the blocks back first in the assistant message of the tool call that still waits for its result, and only there, and only where the binding holds.
//   4. History: blocks of earlier turns leave the view the agent measures and shortens (withoutStaleThinking).
//   5. The wire: the real adapter against a strict mock server that refuses a block replayed in another conversation, as a JSON answer and as a stream, over sessions that shorten their own history.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildAnthropicBody, normalizeAnthropic } from '../lib/anthropic-api.mjs';
import { AgentRunner } from '../lib/agent.mjs';
import { buildChatBody } from '../lib/openai-chat-api.mjs';
import { buildResponsesBody } from '../lib/openai-responses-api.mjs';
import { createAnthropicStreamReader } from '../lib/anthropic-stream.mjs';
import { GatewayProvider, asGeminiContents } from '../lib/gateway-provider.mjs';
import { HistoryLedger } from '../lib/history-ledger.mjs';
import { respondStandard } from '../lib/standard-adapter.mjs';
import { bindThinking, blocksDigest, conversationDigest, refusesThinkingReplay, withoutStaleThinking } from '../lib/thinking-blocks.mjs';
import { startMockModel } from './e2e/mock-model-server.mjs';
import { validateChatRequest, validateGeminiRequest, validateResponsesRequest } from './e2e/protocol-validators.mjs';
import { call, redacted as withRedacted, sequence, thinking as withThinking, truncated } from './e2e/scenarios.mjs';
import { jsonResponse, sse } from './support/stream-harness.mjs';

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };

const ORIGIN = 'https://api.example.test';
const MODEL = 'claude-sonnet-5-5';
const sig = (n) => `EqQBCkYIBxgCKkD${String(n).repeat(40)}==`;
const thinkingBlock = (n, thinking = '') => ({ type: 'thinking', thinking, signature: sig(n) });
const redactedBlock = (n) => ({ type: 'redacted_thinking', data: `Er4BCkYICxgCKkD${String(n).repeat(30)}==` });
const textBlock = (text) => ({ type: 'text', text });
const toolUse = (id, input = { path: 'a.txt' }) => ({ type: 'tool_use', id, name: 'read_file', input });
const message = (content, stop_reason = 'tool_use') => ({ id: 'msg_1', type: 'message', role: 'assistant', model: MODEL, content, stop_reason, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } });
const clone = (value) => structuredClone(value);

const TOOLS = [
  { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'list_files', description: 'List files', parameters: { type: 'object', properties: {} } },
];
const user = (text) => ({ role: 'user', content: [{ type: 'input_text', text }] });
const result = (callId, output = 'file content') => ({ type: 'function_call_output', call_id: callId, output });
const SYSTEM = 'You are a coding agent.';
const bodyOf = (input, extra = {}) => buildAnthropicBody({ model: MODEL, input, instructions: SYSTEM, tools: TOOLS, ...extra });
const REPLAY = { origin: ORIGIN };

/** One model step of a session: the request goes out, the answer is normalised and tied to the conversation it was made in, as the adapter does. */
function step(input, raw, { instructions = SYSTEM, tools = TOOLS, model = MODEL, origin = ORIGIN, replay = REPLAY } = {}) {
  const body = buildAnthropicBody({ model, input, instructions, tools, replay });
  const answer = normalizeAnthropic(clone(raw));
  bindThinking(answer, { model, origin, body });
  return { body, answer };
}

// ------------------------------------------------------------------ 1. capture
{
  const t1 = thinkingBlock(1);
  const withText = normalizeAnthropic(message([t1, textBlock('Let me look.'), toolUse('toolu_1')]));
  assert.deepEqual(withText.output.map((item) => item.type), ['message', 'function_call']);
  assert.deepEqual(withText.output[0].providerBlocks, [t1], 'the block is kept as it came, an empty thinking text included');
  assert.equal(withText.output[1].providerBlocks, undefined, 'and only on the first item of the answer');
  assert.equal(withText.output[0].providerBinding, undefined, 'the binding is made by the caller, who knows the request');

  const noText = normalizeAnthropic(message([thinkingBlock(2, 'a summary'), toolUse('toolu_2')]));
  assert.deepEqual(noText.output.map((item) => item.type), ['function_call']);
  assert.deepEqual(noText.output[0].providerBlocks, [thinkingBlock(2, 'a summary')], 'with no text, the first item is the call');

  const redactedFinal = normalizeAnthropic(message([redactedBlock(3), textBlock('Done.')], 'end_turn'));
  assert.deepEqual(redactedFinal.output[0].providerBlocks, [redactedBlock(3)]);
  assert.equal(redactedFinal.output[0].phase, 'final');

  const two = normalizeAnthropic(message([thinkingBlock(4), redactedBlock(5), toolUse('toolu_3')]));
  assert.deepEqual(two.output[0].providerBlocks, [thinkingBlock(4), redactedBlock(5)], 'several blocks, in their order');

  const extra = { type: 'thinking', thinking: '', signature: sig(6), future_field: { nested: [1, 2] } };
  const kept = normalizeAnthropic(message([extra, toolUse('toolu_4')]));
  assert.deepEqual(kept.output[0].providerBlocks, [extra], 'a field this client does not know stays');
  extra.future_field.nested.push(3);
  assert.deepEqual(kept.output[0].providerBlocks[0].future_field.nested, [1, 2], 'the kept block is a copy');

  assert.equal(normalizeAnthropic(message([textBlock('plain'), toolUse('toolu_5')])).output.some((item) => item.providerBlocks), false, 'no thinking, nothing kept');

  // blocks that cannot be sent back in their place are not kept at all: a partial set would break the chain of the signatures
  const dropped = {
    'a thinking block after the text': [textBlock('first'), thinkingBlock(1), toolUse('toolu_6')],
    'a thinking block between two calls': [toolUse('toolu_7'), thinkingBlock(1), toolUse('toolu_8')],
    'a thinking block with no signature': [{ type: 'thinking', thinking: 'x' }, toolUse('toolu_9')],
    'a thinking block with an empty signature': [{ type: 'thinking', thinking: '', signature: '' }, toolUse('toolu_10')],
    'a thinking block with no text field': [{ type: 'thinking', signature: sig(1) }, toolUse('toolu_11')],
    'a redacted block with no data': [{ type: 'redacted_thinking' }, toolUse('toolu_12')],
    'a redacted block with empty data': [{ type: 'redacted_thinking', data: '' }, toolUse('toolu_12')],
    'one good block and one without a signature': [thinkingBlock(1), { type: 'thinking', thinking: 'y' }, toolUse('toolu_13')],
  };
  for (const [label, content] of Object.entries(dropped)) {
    const answer = normalizeAnthropic(message(content));
    assert.equal(answer.output.some((item) => item.providerBlocks !== undefined), false, label);
    assert.equal(answer.output.some((item) => item.type === 'function_call'), true, `${label}: the call itself is still the answer`);
  }

  // an answer that was cut off keeps nothing, and says whether it was cut off while thinking
  const cutThinking = normalizeAnthropic(message([{ type: 'thinking', thinking: 'long reasoning', signature: '' }], 'max_tokens'));
  assert.equal(cutThinking.status, 'incomplete');
  assert.deepEqual(cutThinking.incomplete_details, { reason: 'max_output_tokens', during_thinking: true });
  assert.equal(cutThinking.output.length, 0);
  const cutWithCall = normalizeAnthropic(message([{ type: 'thinking', thinking: 'x', signature: '' }, toolUse('toolu_cut', {})], 'max_tokens'));
  assert.deepEqual(cutWithCall.incomplete_details, { reason: 'max_output_tokens', during_thinking: false }, 'a call that was begun is something written');
  const cutWithSpace = normalizeAnthropic(message([{ type: 'thinking', thinking: 'x', signature: '' }, textBlock(' \n')], 'max_tokens'));
  assert.deepEqual(cutWithSpace.incomplete_details, { reason: 'max_output_tokens', during_thinking: true }, 'white space is not an answer');
  const cutRedacted = normalizeAnthropic(message([redactedBlock(1)], 'max_tokens'));
  assert.equal(cutRedacted.incomplete_details.during_thinking, true);
  const cutAnswer = normalizeAnthropic(message([thinkingBlock(1), textBlock('The answer is cut o')], 'max_tokens'));
  assert.deepEqual(cutAnswer.incomplete_details, { reason: 'max_output_tokens', during_thinking: false }, 'cut while writing: not the thoughts that used the budget');
  assert.equal(cutAnswer.output.some((item) => item.providerBlocks !== undefined), false, 'nothing is kept of a cut answer');
  assert.deepEqual(normalizeAnthropic(message([textBlock('The answer is cut o')], 'max_tokens')).incomplete_details, { reason: 'max_output_tokens' }, 'an answer with no thinking says nothing about it');
  const paused = normalizeAnthropic(message([thinkingBlock(1)], 'pause_turn'));
  assert.deepEqual(paused.incomplete_details, { reason: 'pause_turn' });
  const refused = normalizeAnthropic(message([thinkingBlock(1), textBlock('No.')], 'refusal'));
  assert.equal(refused.output.some((item) => item.providerBlocks !== undefined), false, 'a refusal keeps nothing');
  ok('capture: thinking and redacted_thinking blocks stay verbatim on the first item (an empty text included); blocks that cannot go back in their place are not kept; a cut answer keeps none and says if it was cut while thinking');
}

// ------------------------------------------------------------------ 2. the binding
{
  const body = bodyOf([user('Read a.txt')]);
  const first = normalizeAnthropic(message([thinkingBlock(1), textBlock('Looking.'), toolUse('toolu_1')]));
  bindThinking(first, { model: MODEL, origin: ORIGIN, body });
  const binding = first.output[0].providerBinding;
  assert.deepEqual(Object.keys(binding).sort(), ['blocks', 'digest', 'model', 'origin']);
  assert.equal(binding.model, MODEL);
  assert.equal(binding.origin, ORIGIN);
  assert.equal(binding.blocks, blocksDigest(first.output[0].providerBlocks));
  assert.equal(binding.digest, conversationDigest({ system: body.system, tools: body.tools, messages: body.messages }));
  assert.match(binding.digest, /^[0-9a-f]{64}$/);

  const noBlocks = normalizeAnthropic(message([textBlock('plain'), toolUse('toolu_2')]));
  bindThinking(noBlocks, { model: MODEL, origin: ORIGIN, body });
  assert.equal(noBlocks.output.some((item) => item.providerBinding !== undefined), false, 'an answer with no blocks has no binding');

  // what the digest counts
  const base = { system: body.system, tools: body.tools, messages: body.messages };
  const digest = (changes = {}) => conversationDigest({ ...base, ...changes });
  const reference = digest();
  assert.equal(digest(), reference, 'it is a function of its input');
  assert.notEqual(digest({ system: [{ type: 'text', text: `${SYSTEM} Today is Tuesday.` }] }), reference, 'the system prompt');
  assert.notEqual(digest({ tools: [{ ...base.tools[0], description: 'Read a file (changed)' }, base.tools[1]] }), reference, 'a tool description');
  assert.notEqual(digest({ tools: [base.tools[0]] }), reference, 'a tool that is not there');
  assert.notEqual(digest({ messages: [{ role: 'user', content: [{ type: 'text', text: 'Read b.txt' }] }] }), reference, 'a message');
  assert.notEqual(digest({ messages: [...base.messages, { role: 'assistant', content: [{ type: 'text', text: 'x' }] }] }), reference, 'one more message');
  // what it does not count
  const withCache = clone(base);
  withCache.system[0].cache_control = { type: 'ephemeral' };
  withCache.tools.at(-1).cache_control = { type: 'ephemeral' };
  withCache.messages.at(-1).content.at(-1).cache_control = { type: 'ephemeral' };
  assert.equal(conversationDigest(withCache), reference, 'cache_control markers');
  const withThinking = { ...base, messages: [...base.messages, { role: 'assistant', content: [thinkingBlock(1), toolUse('toolu_1')] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'x' }] }] };
  const withoutThinking = { ...base, messages: [...base.messages, { role: 'assistant', content: [toolUse('toolu_1')] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'x' }] }] };
  assert.equal(conversationDigest(withThinking), conversationDigest(withoutThinking), 'thinking blocks, whether they are sent or not');
  const redactedOnly = { ...base, messages: [...base.messages, { role: 'assistant', content: [redactedBlock(1), toolUse('toolu_1')] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'x' }] }] };
  assert.equal(conversationDigest(redactedOnly), conversationDigest(withoutThinking), 'redacted_thinking blocks');
  assert.equal(conversationDigest({ ...base, tools: [...base.tools].reverse() }), reference, 'the order of the tools (compared as a set)');
  assert.equal(conversationDigest({ ...base, messages: [{ role: 'user', content: [{ type: 'text', text: 'Read a.txt', extra_key_order: undefined }] }] }), reference, 'a key with no value');
  const keyOrder = clone(base);
  keyOrder.tools[0] = { input_schema: keyOrder.tools[0].input_schema, description: keyOrder.tools[0].description, name: keyOrder.tools[0].name };
  assert.equal(conversationDigest(keyOrder), reference, 'the order of keys');

  assert.notEqual(blocksDigest([thinkingBlock(1)]), blocksDigest([thinkingBlock(2)]), 'a block digest sees the signature');
  assert.notEqual(blocksDigest([thinkingBlock(1)]), blocksDigest([thinkingBlock(1, 'x')]), 'and the text');
  assert.notEqual(blocksDigest([thinkingBlock(1), redactedBlock(2)]), blocksDigest([redactedBlock(2), thinkingBlock(1)]), 'and the order');
  assert.equal(blocksDigest([{ type: 'thinking', thinking: '', signature: 's' }]), blocksDigest([{ signature: 's', thinking: '', type: 'thinking' }]), 'but not the order of keys');
  ok('binding: the answer is tied to the model, the origin and the conversation (system prompt, tools, messages; not cache_control, thinking blocks, tool order or key order) it was made in');
}

// ------------------------------------------------------------------ 3. replay
const thinkingOf = (body) => body.messages.flatMap((entry) => (Array.isArray(entry.content) ? entry.content : [])).filter((block) => block.type === 'thinking' || block.type === 'redacted_thinking');
const contentTypes = (body, index) => body.messages[index].content.map((block) => block.type);
{
  const prompt = [user('Read a.txt')];
  const raw1 = message([thinkingBlock(1), textBlock('Looking.'), toolUse('toolu_1')]);
  const one = step(prompt, raw1);
  const history1 = [...prompt, ...one.answer.output, result('toolu_1')];

  const replayed = bodyOf(history1, { replay: REPLAY });
  assert.deepEqual(contentTypes(replayed, 1), ['thinking', 'text', 'tool_use'], 'the block comes first in the assistant message, ahead of the text and the call');
  assert.deepEqual(replayed.messages[1].content[0], thinkingBlock(1), 'unchanged, an empty text included');
  assert.equal(thinkingOf(replayed).length, 1);

  const plain = bodyOf(history1);
  assert.equal(thinkingOf(plain).length, 0, 'without the replay option the body is the one the Hub has always built');
  assert.deepEqual(plain.messages[1].content, replayed.messages[1].content.slice(1), 'the rest of the message is identical whether or not its thinking is sent');
  assert.deepEqual({ ...replayed, messages: replayed.messages.map((entry, i) => (i === 1 ? { ...entry, content: entry.content.slice(1) } : entry)) }, plain);

  // with no text the blocks lead the call; two blocks keep their order; a redacted block is sent as it came
  const bare = step(prompt, message([thinkingBlock(2, 'summary'), redactedBlock(3), toolUse('toolu_1')]));
  const bareBody = bodyOf([...prompt, ...bare.answer.output, result('toolu_1')], { replay: REPLAY });
  assert.deepEqual(bareBody.messages[1].content.slice(0, 2), [thinkingBlock(2, 'summary'), redactedBlock(3)]);
  assert.deepEqual(contentTypes(bareBody, 1), ['thinking', 'redacted_thinking', 'tool_use']);

  // the blocks are not the history's: changing the body does not change the item
  replayed.messages[1].content[0].signature = 'changed';
  assert.equal(history1[1].providerBlocks[0].signature, sig(1), 'the body holds a copy');

  // only the tool call that waits for its result takes its blocks back: an earlier round does not
  const raw2 = message([thinkingBlock(2), toolUse('toolu_2', { path: 'b.txt' })]);
  const history1Body = bodyOf(history1, { replay: REPLAY });
  const two = (() => {
    const answer = normalizeAnthropic(clone(raw2));
    bindThinking(answer, { model: MODEL, origin: ORIGIN, body: history1Body });
    return answer;
  })();
  const history2 = [...history1, ...two.output, result('toolu_2')];
  const body2 = bodyOf(history2, { replay: REPLAY });
  assert.equal(thinkingOf(body2).length, 1, 'one set of blocks: the last assistant message');
  assert.deepEqual(contentTypes(body2, 1), ['text', 'tool_use'], 'the first round lost its thinking (the oldest may go)');
  assert.deepEqual(contentTypes(body2, 3), ['thinking', 'tool_use']);
  assert.deepEqual(body2.messages[3].content[0], thinkingBlock(2));

  // not when the conversation goes on with the person's words after a finished answer
  const finished = normalizeAnthropic(message([thinkingBlock(5), textBlock('Done.')], 'end_turn'));
  bindThinking(finished, { model: MODEL, origin: ORIGIN, body: body2 });
  const later = bodyOf([...history2, ...finished.output, user('Thanks, now b.txt')], { replay: REPLAY });
  assert.equal(thinkingOf(later).length, 0, 'a new request of the person: no block goes back');
  // not for a final answer that a result follows (nothing waits for a tool)
  assert.equal(thinkingOf(bodyOf([...prompt, ...finished.output, user('more')], { replay: REPLAY })).length, 0);

  // where the binding does not hold, the blocks stay home
  const tail = (changes = {}) => bodyOf(changes.input ?? history1, { replay: REPLAY, ...changes.options });
  assert.equal(thinkingOf(tail({ options: { model: 'claude-opus-5-5' } })).length, 0, 'another model');
  assert.equal(thinkingOf(bodyOf(history1, { replay: { origin: 'https://gateway.example.test' } })).length, 0, 'another origin');
  assert.equal(thinkingOf(bodyOf(history1, { replay: REPLAY, instructions: `${SYSTEM} Be brief.` })).length, 0, 'another system prompt');
  assert.equal(thinkingOf(bodyOf(history1, { replay: REPLAY, tools: [TOOLS[0]] })).length, 0, 'another set of tools');
  assert.equal(thinkingOf(bodyOf(history1, { replay: REPLAY, tools: [{ ...TOOLS[0], description: 'Read a file, quickly' }, TOOLS[1]] })).length, 0, 'a tool with another description');
  assert.equal(thinkingOf(bodyOf([user('Read b.txt, please'), ...history1.slice(1)], { replay: REPLAY })).length, 0, 'an earlier message that is not what it was');
  assert.equal(thinkingOf(bodyOf([user('Read a.txt'), user('And b.txt'), ...history1.slice(1)], { replay: REPLAY })).length, 0, 'a message that was not there');
  const promptCaching = bodyOf(history1, { replay: REPLAY, promptCaching: true });
  assert.equal(thinkingOf(promptCaching).length, 1, 'cache_control is not part of the conversation');
  const stubbed = history2.map((item) => (item.call_id === 'toolu_1' && item.type === 'function_call_output' ? { ...item, output: '[shortened]' } : item));
  assert.equal(thinkingOf(bodyOf(stubbed, { replay: REPLAY })).length, 0, 'a result before the block that was shortened after the block was made (the Hub does this to fit a window)');

  const tampered = clone(history1);
  tampered[1].providerBlocks[0].signature = sig(9);
  assert.equal(thinkingOf(bodyOf(tampered, { replay: REPLAY })).length, 0, 'blocks that are not the ones that were bound (damaged on the way)');
  const unbound = clone(history1);
  delete unbound[1].providerBinding;
  assert.equal(thinkingOf(bodyOf(unbound, { replay: REPLAY })).length, 0, 'blocks with no binding');
  const masked = clone(history1);
  masked[1].providerBlocks[0].signature = '[REDACTED]';
  assert.equal(thinkingOf(bodyOf(masked, { replay: REPLAY })).length, 0, 'blocks whose signature was masked as a secret');
  const noSuchBinding = clone(history1);
  noSuchBinding[1].providerBinding = { model: MODEL, origin: ORIGIN };
  assert.equal(thinkingOf(bodyOf(noSuchBinding, { replay: REPLAY })).length, 0, 'a binding that is missing its digests');
  assert.equal(thinkingOf(bodyOf(history1, { replay: null })).length, 0, 'replay switched off');

  // the item that holds the blocks must be the one that began the assistant message
  const split = [...prompt, { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'first, a word' }] }, ...clone(history1.slice(1))];
  assert.equal(thinkingOf(bodyOf(split, { replay: REPLAY })).length, 0, 'blocks on an item that does not begin its assistant message');

  // a host message that waited for the end of the turn rides in the same user message as the result: the call still waits for its result
  const withHint = bodyOf([...history1, user('HOST HINT')], { replay: REPLAY });
  assert.deepEqual(withHint.messages.map((entry) => entry.role), ['user', 'assistant', 'user']);
  assert.equal(thinkingOf(withHint).length, 1, 'a hint after the result');
  ok('replay: the blocks lead the assistant message of the call that waits for its result, unchanged; nowhere else; not where the model, the origin, the system prompt, the tools or any earlier message differ, nor when the blocks are not the bound ones');
}

// ------------------------------------------------------------------ 4. the view the agent measures
{
  const prompt = [user('Read a.txt')];
  const first = step(prompt, message([thinkingBlock(1), textBlock('Looking.'), toolUse('toolu_1')]));
  const history1 = [...prompt, ...first.answer.output, result('toolu_1')];
  const second = step(history1, message([thinkingBlock(2), toolUse('toolu_2')]));
  const history2 = [...history1, ...second.answer.output, result('toolu_2')];
  const frozen = (value) => { Object.freeze(value); for (const child of Object.values(value)) if (child && typeof child === 'object' && !Object.isFrozen(child)) frozen(child); return value; };
  frozen(history2);

  const view = withoutStaleThinking(history2);
  assert.equal(view.length, history2.length);
  assert.equal(view[1].providerBlocks, undefined, 'the first round is stale');
  assert.equal(view[1].providerBinding, undefined);
  assert.deepEqual(view[1].content, history2[1].content, 'the rest of the item stays');
  assert.equal(view[2], history2[2], 'items with nothing to strip are the same objects');
  assert.equal(view[4], history2[4], 'the round that waits for its result keeps its blocks');
  assert.equal(view[4].providerBlocks[0].signature, sig(2));
  assert.equal(history2[1].providerBlocks[0].signature, sig(1), 'the history itself is not touched');

  assert.equal(withoutStaleThinking(history1)[1], history1[1], 'with one round, it is the one that waits');
  const finished = [...history2, ...normalizeAnthropic(message([thinkingBlock(3), textBlock('Done.')], 'end_turn')).output];
  assert.equal(withoutStaleThinking(finished).some((item) => item.providerBlocks !== undefined), false, 'after the final answer nothing waits');
  const nextTurn = [...finished, user('And now?')];
  assert.equal(withoutStaleThinking(nextTurn).some((item) => item.providerBlocks !== undefined), false);
  assert.equal(withoutStaleThinking([user('Hi')]).length, 1);
  assert.deepEqual(withoutStaleThinking([]), []);
  const hinted = [...history2, user('HOST HINT')];
  assert.equal(withoutStaleThinking(hinted)[4].providerBlocks.length, 1, 'a host message after the results does not end the round');
  const plainOnly = [...prompt, { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'x' }], providerBlocks: [thinkingBlock(1)] }, { type: 'function_call', call_id: 'c', name: 'read_file', arguments: '{}' }, result('c')];
  assert.equal(withoutStaleThinking(plainOnly)[1].providerBlocks.length, 1, 'an assistant message and its call are one round');
  ok('history: the blocks of earlier turns leave the view the agent measures and shortens; the round that waits for a result keeps its own; the history is never written to');
}

// ------------------------------------------------------------------ 5. the wire
const TOOL_DEFS = TOOLS;
const ROUNDS = (count, { redactedEvery = 0 } = {}) => sequence(
  Array.from({ length: count }, (_, i) => (redactedEvery && i % redactedEvery === redactedEvery - 1
    ? withRedacted(call('read_file', { path: `f${i}.txt` }))
    : withThinking(`thoughts ${i}`, call('read_file', { path: `f${i}.txt` })))),
  { final: 'All read.' },
);
const wire = await startMockModel({
  scenario: 'rounds-6',
  scenarios: { 'rounds-6': ROUNDS(6), 'rounds-30': ROUNDS(30), 'mixed-8': ROUNDS(8, { redactedEvery: 3 }) },
  strict: true, bindThinking: true, keepBodies: true,
});
const unused = path.join(os.tmpdir(), 'chatmcp-thinking-unused');
const makeProvider = ({ contextWindow, limits } = {}) => new GatewayProvider({ directory: unused, bundleRoot: os.tmpdir(), manager: { secrets: [] }, env: {}, sleep: async () => {}, limits })
  .forkForTask({ protocol: 'anthropic', apiBaseUrl: wire.origin, model: 'mock-claude', ...(contextWindow ? { contextWindow } : {}) });
const findThinking = (body) => body.messages.flatMap((entry, index) => (Array.isArray(entry.content) ? entry.content.map((block, at) => ({ block, index, at })) : [])).filter(({ block }) => block.type === 'thinking' || block.type === 'redacted_thinking');

/** A session as the agent runs it: ask, keep the answer, run its calls (a result of the size given), ask again, until an answer with no call. */
async function session(provider, { scenario, resultSize = 40, stream = false, maxSteps = 60, server = wire, onStatus = undefined } = {}) {
  server.setScenario(scenario);
  const ledger = new HistoryLedger();
  ledger.appendUser([{ type: 'input_text', text: 'Read the files.' }], { kind: 'prompt' });
  const answers = [];
  for (let n = 0; n < maxSteps; n += 1) {
    ledger.beginBatch();
    const answer = await provider.respond({
      input: withoutStaleThinking(ledger.snapshotForModel()), instructions: SYSTEM, tools: TOOL_DEFS, maxOutputTokens: 4096, signal: AbortSignal.timeout(20000),
      ...(stream ? { onToken: () => {} } : {}), ...(onStatus ? { onStatus } : {}),
    });
    answers.push(answer);
    ledger.appendModelOutput(answer.output);
    const calls = answer.output.filter((item) => item.type === 'function_call');
    for (const item of calls) ledger.appendToolOutput(item.call_id, `${JSON.parse(item.arguments).path}: ${'x'.repeat(resultSize)}`);
    ledger.endBatch();
    if (!calls.length) break;
  }
  return { ledger, answers, requests: server.state.requests.slice() };
}
/** Every request after the first sends the blocks of the answer before it, first in the message of its call, byte for byte as the server issued them. */
function assertReplayed(run, label, { from = 1, to = run.requests.length - 1 } = {}) {
  for (let k = from; k <= to; k += 1) {
    const found = findThinking(run.requests[k].body);
    assert.equal(found.length, run.answers[k - 1].output[0].providerBlocks.length, `${label}: request ${k} sends the blocks of the answer before it`);
    assert.deepEqual(found.map(({ block }) => block), run.answers[k - 1].output[0].providerBlocks, `${label}: request ${k}: as issued`);
    assert.equal(found.every(({ index }) => index === run.requests[k].body.messages.length - 2), true, `${label}: request ${k}: in the message of the call that waits`);
    assert.deepEqual(found.map(({ at }) => at), found.map((_, i) => i), `${label}: request ${k}: first in that message`);
  }
}
try {
  const refused = () => wire.state.rejections.map((entry) => entry.errors[0].message);
  for (const stream of [false, true]) {
    const label = stream ? 'stream' : 'JSON';
    const run = await session(makeProvider(), { scenario: 'rounds-6', stream });
    assert.equal(run.answers.length, 7);
    assert.equal(run.answers.at(-1).status, 'completed');
    assert.equal(findThinking(run.requests[0].body).length, 0, `${label}: nothing to send back at first`);
    assertReplayed(run, label);
    assert.deepEqual(refused(), [], `${label}: the strict server refused nothing`);
    wire.state.rejections.length = 0;
  }
  const mixed = await session(makeProvider(), { scenario: 'mixed-8', stream: true });
  assert.deepEqual(mixed.requests.map((request) => findThinking(request.body).map(({ block }) => block.type)).slice(1, 5), [['thinking'], ['thinking'], ['redacted_thinking'], ['thinking']], 'redacted_thinking blocks go back like the others');
  assertReplayed(mixed, 'mixed');
  assert.deepEqual(refused(), []);
  ok('wire: against a server that refuses a block replayed in another conversation, six tool rounds (as JSON and as a stream) send each answer\'s thinking back, byte for byte, first in the message of the waiting call; redacted blocks too');

  // a window that is too small for the whole history: the Hub shortens old tool results, which changes the conversation before the blocks, so they stay home from then on and nothing is refused
  const tight = await session(makeProvider({ contextWindow: 12000 }), { scenario: 'rounds-30', resultSize: 3000, stream: true });
  assert.equal(tight.answers.at(-1).status, 'completed');
  assert.equal(tight.answers.length, 31);
  const replayed = tight.requests.map((request, k) => (k > 0 && findThinking(request.body).length > 0 ? k : 0)).filter(Boolean);
  const shortened = tight.requests.findIndex((request) => JSON.stringify(request.body).includes('đã rút gọn'));
  assert.ok(shortened > 0, '(premise) the Hub did shorten old results in this session');
  assert.ok(replayed.length > 0 && replayed.every((k) => k <= shortened), `blocks went back until the history was shortened (requests ${replayed.join(', ')}; first shortened at ${shortened})`);
  assert.equal(tight.requests.slice(shortened).some((request) => findThinking(request.body).length > 0), false, 'and none after: the conversation before them had changed');
  assert.deepEqual(refused(), [], 'the strict server refused nothing in 30 rounds of a session that shortens its own history');
  ok(`wire: 30 tool rounds in a window that forces the Hub to shorten old results: blocks went back for the first ${replayed.length} rounds, stayed home after the history was shortened (request ${shortened}), and the server that refuses a bound block in another conversation refused nothing`);

  // and when nothing is shortened, every round after the first sends its blocks
  const roomy = await session(makeProvider({ contextWindow: 1000000 }), { scenario: 'rounds-30', stream: false });
  assert.equal(roomy.answers.length, 31);
  assertReplayed(roomy, 'roomy');
  assert.deepEqual(refused(), []);
  ok('wire: 30 tool rounds in a roomy window: all 30 follow-up requests send the blocks of the answer before them, none refused');
} finally {
  await wire.close();
}

// ------------------------------------------------------------------ 6. the real agent
{
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-thinking-agent-'));
  const closers = [];
  try {
    const listing = { content: [{ type: 'text', text: '[FILE] README.md' }] };
    const manager = {
      secrets: [], generation: 1, instanceId: 'thinking-agent', locked: false,
      state() { return { workspace: { path: root }, generation: 1, instanceId: this.instanceId }; },
      acquireTask() { if (this.locked) return false; this.locked = true; return true; },
      releaseTask() { this.locked = false; },
      async createAgentSession() {
        return {
          catalog: { tools: [{ name: 'desktop-commander.list_directory', server: 'desktop-commander', inputSchema: { type: 'object' } }], prompts: [], resources: [], resourceTemplates: [], servers: {} },
          async close() {},
          async callTool(name, args, { onDecision } = {}) { await onDecision?.({ name, category: 'read', allowed: true }); return listing; },
        };
      },
    };
    const listDirectory = (n) => ({ name: 'mcp_call', args: { name: 'desktop-commander.list_directory', arguments_json: JSON.stringify({ path: path.join(root, `d${n}`) }) } });
    const runAgent = async (script, label, { providerSettings = {} } = {}) => {
      const m = await startMockModel({ scenario: 'agent', scenarios: { agent: script }, strict: true, bindThinking: true, keepBodies: true });
      closers.push(() => m.close());
      const gateway = new GatewayProvider({ directory: path.join(root, `gateway-${label}`), bundleRoot: root, manager, env: {} });
      const provider = gateway.forkForTask({ protocol: 'anthropic', apiBaseUrl: m.origin, model: 'mock-claude', ...providerSettings });
      const runner = new AgentRunner({ manager, provider, taskDirectory: path.join(root, `tasks-${label}`) });
      await runner.load();
      await runner.start({ prompt: 'Look at the project until you know enough.' });
      const task = await Promise.race([runner.context.done.promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${label}: the agent run timed out`)), 20000))]);
      await runner.shutdown();
      return { m, task, directory: path.join(root, `tasks-${label}`) };
    };
    const filesUnder = async (directory) => {
      const found = [];
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) found.push(...await filesUnder(full)); else found.push(full);
      }
      return found;
    };

    // five steps that think, then an answer that thinks: every request after the first carries the blocks of the answer before it, and the transcript on disk has neither signature nor thoughts
    {
      let step = 0;
      const { m, task, directory } = await runAgent(() => {
        step += 1;
        if (step === 3) return withRedacted({ calls: [listDirectory(step)] });
        return step <= 5 ? withThinking(`thoughts ${step}`, { calls: [listDirectory(step)] }) : withThinking('closing thoughts', { text: 'Done.' });
      }, 'replay');
      assert.equal(task.status, 'completed', `${task.error ?? ''} ${JSON.stringify(m.state.rejections.at(-1)?.errors?.[0] ?? null)}`);
      assert.equal(m.state.requests.length, 6);
      assert.deepEqual(m.state.requests.map((request) => request.rejected), Array(6).fill(null), 'the server that binds thinking to its conversation refused nothing the agent sent');
      m.state.requests.forEach((request, k) => {
        const found = findThinking(request.body);
        assert.equal(found.length, k === 0 ? 0 : 1, `request ${k}`);
        if (k === 3) {
          assert.equal(found[0].block.type, 'redacted_thinking', 'a redacted block goes back too');
          assert.equal(m.signer.verifyRedacted(found[0].block.data), true);
        } else if (k > 0) {
          assert.equal(found[0].block.thinking, `thoughts ${k}`, `request ${k} carries the thoughts of the answer before it`);
          assert.equal(m.signer.verifyThinking(found[0].block), 'ok');
        }
        if (k > 0) assert.equal(found[0].index, request.body.messages.length - 2);
      });
      const written = (await Promise.all((await filesUnder(directory)).map((file) => fs.readFile(file, 'utf8')))).join('\n');
      assert.equal(written.includes('mock-sig.'), false, 'no signature reaches the disk');
      assert.equal(written.includes('mock-redacted.'), false, 'nor the payload of a redacted block');
      assert.equal(/thoughts \d|closing thoughts/.test(written), false, 'nor the thoughts');
      assert.ok(written.includes('[Opaque model context retained only in memory for the next model request]'), '(premise) the transcript did record the answers, with the opaque part left out');
      assert.ok(written.includes('[Private reasoning content is not part of the task transcript]'));
    }
    ok('agent: five tool rounds that think are accepted by a server that binds thinking to its conversation, each request carries the thoughts of the answer before it, and the transcript on disk holds neither the signature nor the thoughts');

    // the thoughts of old rounds are not conversation: five rounds of 60 KB of thinking in a window of 100,000 tokens make the agent shorten nothing, since only the last round's go back
    {
      let step = 0;
      const { m, task } = await runAgent(() => {
        step += 1;
        return step <= 5 ? withThinking('t'.repeat(60000), { calls: [listDirectory(step)] }) : { text: 'Done.' };
      }, 'stale', { providerSettings: { contextWindow: 100000 } });
      assert.equal(task.status, 'completed', `${task.error ?? ''} ${JSON.stringify(m.state.rejections.at(-1)?.errors?.[0] ?? null)}`);
      assert.equal(task.events.some((event) => event.type === 'context_compaction'), false, 'the signatures of old rounds did not make the agent shorten the history');
      assert.deepEqual(m.state.requests.map((request) => request.rejected), Array(6).fill(null));
      assert.deepEqual(m.state.requests.map((request) => findThinking(request.body).length), [0, 1, 1, 1, 1, 1], 'and the last round\'s blocks went back every time');
    }
    ok('agent: five rounds with 60 KB of thoughts each, in a window of 100,000 tokens: nothing is shortened, and each request carries the blocks of the round before it only');

    // a model that spends all of its output limit on thinking is told so, not "incomplete"
    {
      const { task } = await runAgent(() => truncated({ thinking: 'thinking, thinking, thinking' }), 'cut');
      assert.equal(task.status, 'limit');
      assert.equal(task.errorCode ?? task.error?.code, 'output_limit');
      assert.match(task.error, /suy luận \(thinking\)/);
      assert.match(task.error, /Hạ mức suy luận/);
      assert.doesNotMatch(task.error, /chưa hoàn tất phản hồi/);
    }
    {
      const { task } = await runAgent(() => truncated({ text: 'The answer is cut o' }), 'cut-answer');
      assert.equal(task.status, 'limit');
      assert.match(task.error, /Model chưa hoàn tất phản hồi \(max_output_tokens\)/, 'a cut answer keeps the old words');
    }
    ok('agent: a response cut off while it was still thinking is reported as that (output_limit, with the remedy), a cut answer keeps its old message');
  } finally {
    for (const close of closers) await close();
    await fs.rm(root, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ 7. a server that does not take the blocks back
{
  // A gateway in front of Claude, or a check of the API that disagrees with the Hub's own reading of "the same conversation", answers 400 to the blocks. The same model request is
  // made once more without them (no tool has run, nothing can be repeated), and the endpoint and model are remembered, as a refused stream is.
  let server;
  const unwilling = (inner) => (ctx) => (findThinking(server.state.lastBody).length > 0
    ? { http: { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'messages.1.content.0: Invalid `signature` in `thinking` block' } } } }
    : inner(ctx));
  server = await startMockModel({ scenario: 'unwilling', scenarios: { unwilling: unwilling(ROUNDS(5)) }, strict: true, bindThinking: true, keepBodies: true });
  const withBlocks = (run) => run.requests.map((request, k) => (findThinking(request.body).length > 0 ? k : -1)).filter((k) => k >= 0);
  try {
    const provider = new GatewayProvider({ directory: unused, bundleRoot: os.tmpdir(), manager: { secrets: [] }, env: {}, sleep: async () => {} })
      .forkForTask({ protocol: 'anthropic', apiBaseUrl: server.origin, model: 'mock-claude' });
    const statuses = [];
    const first = await session(provider, { scenario: 'unwilling', stream: true, server, onStatus: async (text) => { statuses.push(text); } });
    assert.equal(first.answers.at(-1).status, 'completed');
    assert.equal(first.requests.length, 7, 'six answers and the one request that was refused');
    assert.deepEqual(withBlocks(first), [1], 'the second request carried the blocks of the first answer, was refused, and no later request carried any');
    assert.equal(statuses.filter((text) => /thinking/.test(text)).length, 1, 'the person is told once');
    const refusedBody = first.requests[1].body;
    const repeated = first.requests[2].body;
    assert.deepEqual(repeated.messages.map((entry) => ({ ...entry, content: entry.content.filter((block) => block.type !== 'thinking') })), refusedBody.messages.map((entry) => ({ ...entry, content: entry.content.filter((block) => block.type !== 'thinking') })), 'the repeat is the same request without the blocks');
    assert.equal(findThinking(repeated).length, 0);
    // the next session of the same connection does not even try
    const second = await session(provider, { scenario: 'unwilling', stream: false, server });
    assert.equal(second.answers.at(-1).status, 'completed');
    assert.deepEqual(withBlocks(second), [], 'remembered for this endpoint and model');
    // another model asks again
    provider.model = 'mock-claude-2';
    const third = await session(provider, { scenario: 'unwilling', stream: true, server });
    assert.deepEqual(withBlocks(third), [1], 'a refusal is about one model on one endpoint');
    assert.equal(third.answers.at(-1).status, 'completed');
    ok('refused replay: a server that answers 400 to the blocks gets the same request once more without them, the person is told once, and the endpoint and model are not asked again; another model asks again');
  } finally {
    await server.close();
  }

  // the edges, with the adapter alone and scripted responses
  const ctxFor = (extra = {}) => ({ protocol: 'anthropic', model: MODEL, endpoint: `${ORIGIN}/v1/messages`, headers: {}, sleep: async () => {}, redact: (text) => text, ...extra });
  const prompt = [user('Read a.txt')];
  const answerOne = step(prompt, message([thinkingBlock(1), toolUse('toolu_1')]));
  const waiting = [...prompt, ...answerOne.answer.output, result('toolu_1')];
  const finalAnswer = message([textBlock('Done.')], 'end_turn');
  const refusal = (text) => jsonResponse(400, { type: 'error', error: { type: 'invalid_request_error', message: text } });
  const scripted = (responses) => { const bodies = []; return { bodies, fetch: async (url, init) => { bodies.push(JSON.parse(init.body)); const next = responses.shift(); if (!next) throw new Error('no more scripted responses'); return next; } }; };
  const call_ = (ctx, input = waiting) => respondStandard(ctx, { input, instructions: SYSTEM, tools: TOOLS, maxOutputTokens: 4096 });
  {
    const script = scripted([refusal('messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.'), jsonResponse(200, finalAnswer)]);
    const learned = [];
    const done = await call_(ctxFor({ fetch: script.fetch, onThinkingReplayRefused: () => learned.push('refused') }));
    assert.equal(done.status, 'completed');
    assert.deepEqual(script.bodies.map((body) => findThinking(body).length), [1, 0]);
    assert.deepEqual(learned, ['refused'], 'told once, after the repeat was accepted');
  }
  {
    const script = scripted([refusal('The block is bound to a different conversation.'), refusal('The block is bound to a different conversation.')]);
    const learned = [];
    const failure = await call_(ctxFor({ fetch: script.fetch, onThinkingReplayRefused: () => learned.push('refused') })).then(() => null, (error) => error);
    assert.equal(failure?.code, 'gateway_http_error');
    assert.equal(script.bodies.length, 2, 'once, not for ever');
    assert.deepEqual(learned, [], 'a refusal that the repeat did not cure is not remembered');
  }
  {
    const script = scripted([refusal('messages.1.content.0: Invalid `signature` in `thinking` block')]);
    const failure = await call_(ctxFor({ fetch: script.fetch }), prompt).then(() => null, (error) => error);
    assert.equal(failure?.code, 'gateway_http_error');
    assert.equal(script.bodies.length, 1, 'no blocks were sent, so there is nothing to take out');
  }
  {
    const script = scripted([refusal('prompt is too long: 250000 tokens > 200000 maximum'), jsonResponse(200, finalAnswer)]);
    const learned = [];
    await call_(ctxFor({ fetch: script.fetch, onThinkingReplayRefused: () => learned.push('refused'), contextWindowTokens: 200000 })).then(() => null, () => null);
    assert.deepEqual(learned, [], 'a 400 about the size is not about the blocks');
  }
  {
    const script = scripted([jsonResponse(200, finalAnswer)]);
    await call_(ctxFor({ fetch: script.fetch, thinkingReplayRefused: true }));
    assert.equal(findThinking(script.bodies[0]).length, 0, 'known to refuse: the blocks are not even sent');
  }
  {
    // a refusal that comes as an error inside a stream is the same 400
    const frames = (text) => `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: text } })}\n\n`;
    const script = scripted([sse(frames('messages.1.content.0: Invalid `signature` in `thinking` block')), jsonResponse(200, finalAnswer)]);
    const done = await call_(ctxFor({ fetch: script.fetch, stream: true }));
    assert.equal(done.status, 'completed');
    assert.deepEqual(script.bodies.map((body) => findThinking(body).length), [1, 0], 'an error event of a stream is answered like the HTTP error it stands for');
  }
  ok('refused replay, the edges: once and not for ever; nothing to take out when nothing was sent; a 400 about the size is not about the blocks; a refusal the repeat did not cure is not remembered; a known refusal sends no block; an error event of a stream counts');
}

// ------------------------------------------------------------------ 8. room for the thoughts
{
  // max_tokens counts the thoughts: a model that thinks (the catalog says so) needs room for them and for the answer, but never beyond what the model, the window or a cap learned from the provider allow
  const ctxFor = (extra = {}) => ({ protocol: 'anthropic', model: MODEL, endpoint: `${ORIGIN}/v1/messages`, headers: {}, sleep: async () => {}, redact: (text) => text, ...extra });
  const asked = async (extra, maxOutputTokens, input = [user('Hi')]) => {
    const bodies = [];
    await respondStandard(ctxFor({ fetch: async (url, init) => { bodies.push(JSON.parse(init.body)); return jsonResponse(200, message([textBlock('ok')], 'end_turn')); }, ...extra }), { input, instructions: SYSTEM, tools: TOOLS, maxOutputTokens });
    return bodies[0].max_tokens;
  };
  assert.equal(await asked({ thinks: true, modelOutputLimit: 128000 }, 5898), 32000, 'a quarter of what the model can write, when that is more than the default');
  assert.equal(await asked({ thinks: true, modelOutputLimit: 64000 }, 5898), 16384, 'the default room otherwise');
  assert.equal(await asked({ thinks: true }, 5898), 16384, 'the default room for a model whose own limit is not known');
  assert.equal(await asked({ thinks: true, modelOutputLimit: 128000 }, 40000), 40000, 'what the caller asked for, when that is more');
  assert.equal(await asked({ thinks: true, modelOutputLimit: 8000 }, 1024), 8000, 'never more than the model can write');
  assert.equal(await asked({ thinks: true, modelOutputLimit: 128000, contextWindowTokens: 24576 }, 1024), 6144, 'nor more than a quarter of the window: the history needs the rest');
  assert.equal(await asked({ thinks: true, modelOutputLimit: 128000, outputLimit: 8192 }, 1024), 8192, 'nor more than the provider said it takes');
  assert.equal(await asked({ thinks: false, modelOutputLimit: 128000 }, 5898), 5898, 'a model that does not think keeps the cap that was asked for');
  assert.equal(await asked({}, 5898), 5898, 'and so does one the catalog does not know');
  assert.equal(await asked({ thinks: true, modelOutputLimit: 128000, contextWindowTokens: 1000000 }, 1024), 32000, 'a roomy window');
  ok('room for the thoughts: a model that thinks gets max(what was asked, the default, a quarter of its own output limit), never beyond its limit, a quarter of the window or a cap the provider named; others keep the cap asked for');

  // the provider hands the adapter what the catalog says
  const catalogOf = ({ reasoning = true, maxOutput = 128000, confidence = 'exact' } = {}) => ({ lookup: (query) => ({ found: true, source: 'catalog@test', confidence, provider: 'anthropic', modelId: query.model, contextWindow: 1000000, maxInput: null, maxOutput, rates: null, tiers: [], reasoning: { supported: reasoning, efforts: reasoning ? ['low', 'medium', 'high'] : [], toggle: false, budget: null } }) });
  const sizes = async (catalog) => {
    const bodies = [];
    const fetchImpl = async (url, init) => { bodies.push(JSON.parse(init.body)); return jsonResponse(200, message([textBlock('ok')], 'end_turn')); };
    const provider = new GatewayProvider({ directory: unused, bundleRoot: os.tmpdir(), manager: { secrets: [] }, env: {}, sleep: async () => {}, catalog, fetchImpl })
      .forkForTask({ protocol: 'anthropic', apiBaseUrl: 'http://127.0.0.1:7333', model: 'claude-opus-5-5' });
    await provider.respond({ input: [user('Hi')], instructions: SYSTEM, tools: TOOLS, maxOutputTokens: 5898, signal: AbortSignal.timeout(5000) });
    return bodies[0].max_tokens;
  };
  assert.equal(await sizes(catalogOf()), 32000, 'through the provider: the catalog says the model thinks and writes up to 128,000');
  assert.equal(await sizes(catalogOf({ reasoning: false })), 5898);
  assert.equal(await sizes(catalogOf({ maxOutput: 8192 })), 8192);
  assert.equal(await sizes(catalogOf({ confidence: 'fuzzy' })), 5898, 'a match the catalog is not sure of is not believed');
  assert.equal(await sizes(null), 5898, 'no catalog answer, no change');
  ok('room for the thoughts: the provider tells the adapter from the catalog whether the model thinks and how much it can write');

  // the room is a cap on what may be written: the history is planned with the output as asked, so the room does not make the adapter shorten it earlier
  {
    const rounds = [user('Read the files')];
    for (let n = 1; n <= 6; n += 1) rounds.push({ type: 'function_call', call_id: `toolu_${n}`, name: 'read_file', arguments: JSON.stringify({ path: `f${n}.txt` }), status: 'completed' }, result(`toolu_${n}`, 'x'.repeat(15000)));
    const statuses = [];
    const bodies = [];
    const fetch = async (url, init) => { bodies.push(JSON.parse(init.body)); return jsonResponse(200, message([textBlock('ok')], 'end_turn')); };
    const run = (thinks) => respondStandard(ctxFor({ fetch, contextWindowTokens: 40000, thinks, modelOutputLimit: 128000 }), { input: rounds, instructions: SYSTEM, tools: TOOLS, maxOutputTokens: 4096, onStatus: async (text, kind) => { statuses.push(kind ?? text); } });
    await run(true);
    assert.equal(bodies.at(-1).max_tokens, 10000, '(premise) the room is a quarter of the window');
    assert.equal(statuses.includes('context_compaction'), false, 'the history of 90 KB fits a window of 40,000 tokens planned with 4,096 of output; the room for the thoughts did not shorten it');
    assert.equal(JSON.stringify(bodies.at(-1)).includes('đã rút gọn'), false);
  }
  ok('room for the thoughts: it is a cap on what may be written, the history is planned with the output as asked');
}

// ------------------------------------------------------------------ 9. the edges of the binding
{
  // the role is part of a message: the same words said by the other side are another conversation
  const base = bodyOf([user('Read a.txt')]);
  const asAssistant = { system: base.system, tools: base.tools, messages: [{ role: 'assistant', content: base.messages[0].content }] };
  assert.notEqual(conversationDigest(asAssistant), conversationDigest({ system: base.system, tools: base.tools, messages: base.messages }), 'the role');

  // blocks that were bound but cannot go back in their place are not sent, whatever their binding says
  const body = bodyOf([user('Read a.txt')]);
  const answer = normalizeAnthropic(message([thinkingBlock(1), toolUse('toolu_1')]));
  answer.output[0].providerBlocks[0].signature = '';
  bindThinking(answer, { model: MODEL, origin: ORIGIN, body });
  assert.equal(thinkingOf(bodyOf([user('Read a.txt'), ...answer.output, result('toolu_1')], { replay: REPLAY })).length, 0, 'a block with no signature, though it was bound');

  // a call that has no result yet is not a round that waits for one: the agent never sends that history, a repaired one has an invented result
  const pending = step([user('Read a.txt')], message([thinkingBlock(1), toolUse('toolu_1')]));
  const unanswered = [user('Read a.txt'), ...pending.answer.output];
  assert.equal(withoutStaleThinking(unanswered).some((item) => item.providerBlocks !== undefined), false, 'a call with no result: nothing waits');
  assert.equal(withoutStaleThinking([...unanswered, user('hint')]).some((item) => item.providerBlocks !== undefined), false, 'nor with a message after it and still no result');

  // the body builder does not trust its caller to have paired the calls: blocks go back only to a message that holds a call whose result comes next
  const text = step([user('Say hi')], message([thinkingBlock(1), textBlock('Hi.')], 'end_turn'));
  assert.equal(thinkingOf(bodyOf([user('Say hi'), ...text.answer.output, result('toolu_stray')], { replay: REPLAY })).length, 0, 'a text answer followed by a stray result');
  const unpaired = step([user('Read a.txt')], message([thinkingBlock(2), toolUse('toolu_9')]));
  assert.equal(thinkingOf(bodyOf([user('Read a.txt'), ...unpaired.answer.output, user('never mind')], { replay: REPLAY })).length, 0, 'a call followed by words instead of its result');

  // the refusal test is about the blocks, and only about them
  assert.equal(refusesThinkingReplay(400, 'messages.1.content.0: Invalid `signature` in `thinking` block'), true);
  assert.equal(refusesThinkingReplay(400, 'The block is bound to a different conversation.'), true);
  assert.equal(refusesThinkingReplay(400, '`thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified'), true);
  assert.equal(refusesThinkingReplay(400, 'Unsupported content type: thinking'), true, 'a gateway that is not Anthropic\'s says it its own way');
  assert.equal(refusesThinkingReplay(400, 'Invalid signature.'), true);
  assert.equal(refusesThinkingReplay(400, 'prompt is too long: 250000 tokens > 200000 maximum'), false);
  assert.equal(refusesThinkingReplay(400, 'max_tokens: 99999 > 8192, which is the maximum allowed number of output tokens'), false);
  assert.equal(refusesThinkingReplay(500, 'thinking service unavailable'), false, 'only a 400');
  assert.equal(refusesThinkingReplay(400, undefined), false);
  assert.equal(refusesThinkingReplay(undefined, 'Invalid signature in thinking block'), false);
  ok('edges: the role is part of a message; blocks that cannot go back in their place are not sent although they are bound; a call with no result does not wait; only a 400 about the blocks is a refusal of them');
}
{
  // the origin the blocks were made for is the origin they go back to
  const ctxFor = (extra = {}) => ({ protocol: 'anthropic', model: MODEL, headers: {}, sleep: async () => {}, redact: (text) => text, ...extra });
  const prompt = [user('Read a.txt')];
  const minted = step(prompt, message([thinkingBlock(1), toolUse('toolu_1')]));
  const waiting = [...prompt, ...minted.answer.output, result('toolu_1')];
  const sentTo = async (endpoint) => {
    const bodies = [];
    await respondStandard(ctxFor({ endpoint, fetch: async (url, init) => { bodies.push(JSON.parse(init.body)); return jsonResponse(200, message([textBlock('ok')], 'end_turn')); } }), { input: waiting, instructions: SYSTEM, tools: TOOLS, maxOutputTokens: 4096 });
    return findThinking(bodies[0]).length;
  };
  assert.equal(await sentTo(`${ORIGIN}/v1/messages`), 1, 'the origin it was made for');
  assert.equal(await sentTo(`${ORIGIN}/proxy/v1/messages`), 1, 'the same origin, another path');
  assert.equal(await sentTo('https://gateway.example.test/v1/messages'), 0, 'another origin');
  assert.equal(await sentTo('http://api.example.test/v1/messages'), 0, 'the same host over another scheme');

  // blocks of old rounds do not count as conversation: three rounds of 50 KB of thoughts each in a window that holds one of them are not "too long"
  const big = (n) => thinkingBlock(n, 'x'.repeat(50000));
  let history = prompt;
  for (let n = 1; n <= 3; n += 1) {
    const round = step(history, message([big(n), toolUse(`toolu_${n}`, { path: `f${n}.txt` })]));
    history = [...history, ...round.answer.output, result(`toolu_${n}`, `content ${n}`)];
  }
  const statuses = [];
  const bodies = [];
  await respondStandard(ctxFor({ endpoint: `${ORIGIN}/v1/messages`, contextWindowTokens: 40000, fetch: async (url, init) => { bodies.push(JSON.parse(init.body)); return jsonResponse(200, message([textBlock('ok')], 'end_turn')); } }),
    { input: history, instructions: SYSTEM, tools: TOOLS, maxOutputTokens: 4096, onStatus: async (text, kind) => { statuses.push(kind ?? text); } });
  assert.equal(statuses.includes('context_compaction'), false, 'the old signatures did not make the history look too long');
  assert.equal(findThinking(bodies[0]).length, 1, 'and the blocks of the waiting round went back');
  assert.equal(findThinking(bodies[0])[0].block.signature, sig(3));
  ok('edges: blocks go back only to the origin they were made for; the blocks of old rounds do not count toward the window, so they do not make the Hub shorten the history');
}
{
  // the provider remembers a refusal for the model and endpoint it was made for, not for what the connection was changed to while the request was in flight
  const A = 'http://127.0.0.1:7333';
  const B = 'http://127.0.0.1:7444';
  const prompt = [user('Read a.txt')];
  const mintedAt = (origin, model) => {
    const made = step(prompt, message([thinkingBlock(1), toolUse('toolu_1')]), { origin, model });
    return [...prompt, ...made.answer.output, result('toolu_1')];
  };
  const finalAnswer = message([textBlock('Done.')], 'end_turn');
  const refusal = jsonResponse(400, { type: 'error', error: { type: 'invalid_request_error', message: 'messages.1.content.0: Invalid `signature` in `thinking` block' } });
  const seen = [];
  let onRequest = () => {};
  const provider = new GatewayProvider({ directory: unused, bundleRoot: os.tmpdir(), manager: { secrets: [] }, env: {}, sleep: async () => {},
    fetchImpl: async (url, init) => { const body = JSON.parse(init.body); seen.push({ url: String(url), blocks: findThinking(body).length }); return onRequest(); } })
    .forkForTask({ protocol: 'anthropic', apiBaseUrl: A, model: 'm1' });
  const ask = (input) => provider.respond({ input, instructions: SYSTEM, tools: TOOLS, maxOutputTokens: 4096, signal: AbortSignal.timeout(5000) });
  // 1. the connection changes while the refused request is in flight: nothing is remembered
  onRequest = (() => { const queue = [() => { provider.model = 'm2'; return refusal; }, () => jsonResponse(200, finalAnswer)]; return () => queue.shift()(); })();
  await ask(mintedAt(A, 'm1'));
  provider.model = 'm1';
  onRequest = () => jsonResponse(200, finalAnswer);
  seen.length = 0;
  await ask(mintedAt(A, 'm1'));
  assert.deepEqual(seen.map((entry) => entry.blocks), [1], 'a refusal for a model that is no longer the configured one is not recorded');
  // 2. a refusal that is confirmed is remembered for m1 on A...
  onRequest = (() => { const queue = [() => refusal, () => jsonResponse(200, finalAnswer)]; return () => queue.shift()(); })();
  await ask(mintedAt(A, 'm1'));
  seen.length = 0;
  onRequest = () => jsonResponse(200, finalAnswer);
  await ask(mintedAt(A, 'm1'));
  assert.deepEqual(seen.map((entry) => entry.blocks), [0], 'remembered for this model on this endpoint');
  // 3. ... and not for the same model on another endpoint
  provider.apiBaseUrl = B;
  seen.length = 0;
  await ask(mintedAt(B, 'm1'));
  assert.deepEqual(seen.map((entry) => entry.blocks), [1], 'another endpoint asks again');
  provider.apiBaseUrl = A;
  seen.length = 0;
  await ask(mintedAt(A, 'm1'));
  assert.deepEqual(seen.map((entry) => entry.blocks), [1], 'the slot holds one pair: going back asks again');
  ok('edges: the provider remembers a refused replay for one endpoint and model, and not for what the connection was changed to while the refused request was in flight');
}

// ------------------------------------------------------------------ 10. the blocks of a stream
{
  const events = async (list) => {
    const reader = createAnthropicStreamReader();
    for (const [event, data] of list) await reader.event({ event, data: JSON.stringify(data) });
    return reader.finish();
  };
  const start = ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: MODEL, content: [], usage: { input_tokens: 1, output_tokens: 1 } } }];
  const block = (index, content_block) => ['content_block_start', { type: 'content_block_start', index, content_block }];
  const delta = (index, piece) => ['content_block_delta', { type: 'content_block_delta', index, delta: piece }];
  const stop = (index) => ['content_block_stop', { type: 'content_block_stop', index }];
  const finish = (reason) => [['message_delta', { type: 'message_delta', delta: { stop_reason: reason }, usage: { output_tokens: 5 } }], ['message_stop', { type: 'message_stop' }]];
  const callBlock = (index) => [block(index, { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {} }), delta(index, { type: 'input_json_delta', partial_json: '{"path":"a"}' }), stop(index)];

  // the thoughts arrive in pieces and the signature after them; the kept block has exactly the fields of the plain answer, and nothing the reader needed on the way
  const summarized = await events([start, block(0, { type: 'thinking', thinking: '', signature: '' }), delta(0, { type: 'thinking_delta', thinking: 'first, ' }), delta(0, { type: 'thinking_delta', thinking: 'then ' }), delta(0, { type: 'thinking_delta', thinking: 'last.' }),
    delta(0, { type: 'signature_delta', signature: sig(1) }), stop(0), ...callBlock(1), ...finish('tool_use')]);
  assert.deepEqual(summarized.output[0].providerBlocks, [{ type: 'thinking', thinking: 'first, then last.', signature: sig(1) }]);
  assert.deepEqual(summarized, normalizeAnthropic({ ...message([{ type: 'thinking', thinking: 'first, then last.', signature: sig(1) }, toolUse('toolu_1', { path: 'a' })]), usage: { input_tokens: 1, output_tokens: 5 } }), 'streamed and plain');

  // the text of the thoughts is empty when they are not shown, and the start event may leave the field out
  const omitted = await events([start, block(0, { type: 'thinking', signature: '' }), delta(0, { type: 'signature_delta', signature: sig(2) }), stop(0), ...callBlock(1), ...finish('tool_use')]);
  assert.deepEqual(omitted.output[0].providerBlocks, [{ type: 'thinking', thinking: '', signature: sig(2) }]);

  const redactedStream = await events([start, block(0, redactedBlock(3)), stop(0), block(1, { type: 'text', text: '' }), delta(1, { type: 'text_delta', text: 'Done.' }), stop(1), ...finish('end_turn')]);
  assert.deepEqual(redactedStream.output[0].providerBlocks, [redactedBlock(3)]);

  // a stream that ends in the middle of its thoughts is a cut answer, whose signature never came
  const cut = await events([start, block(0, { type: 'thinking', thinking: '', signature: '' }), delta(0, { type: 'thinking_delta', thinking: 'still thinking' }), stop(0), ...finish('max_tokens')]);
  assert.equal(cut.status, 'incomplete');
  assert.deepEqual(cut.incomplete_details, { reason: 'max_output_tokens', during_thinking: true });
  assert.equal(cut.output.length, 0);
  ok('stream: thinking blocks are rebuilt from their pieces exactly (text, signature, redacted payload; nothing else), equal to the plain answer; a stream cut while thinking says so');
}

// ------------------------------------------------------------------ 11. the blocks stay with Anthropic
{
  // the item of the waiting round carries the blocks and their binding; no other protocol's converter may forward them
  const prompt = [user('Read a.txt')];
  const minted = step(prompt, message([thinkingBlock(1), textBlock('Looking.'), toolUse('toolu_1')]));
  const history = withoutStaleThinking([...prompt, ...minted.answer.output, result('toolu_1')]);
  assert.ok(history.some((item) => item.providerBlocks && item.providerBinding), '(premise) the waiting round carries both');
  const bodies = {
    'Chat Completions': buildChatBody({ model: 'm', input: history, instructions: SYSTEM, tools: TOOLS }),
    Responses: buildResponsesBody({ model: 'm', input: history, instructions: SYSTEM, tools: TOOLS }),
    Gemini: { contents: asGeminiContents(history) },
  };
  for (const [name, body] of Object.entries(bodies)) {
    const sent = JSON.stringify(body);
    for (const word of ['providerBlocks', 'providerBinding', 'thinking', 'signature', 'redacted_thinking', sig(1)]) assert.equal(sent.includes(word), false, `${name}: no ${word}`);
  }
  assert.deepEqual(validateChatRequest(bodies['Chat Completions'], {}).errors, [], 'Chat Completions: the strict validator accepts it');
  assert.deepEqual(validateResponsesRequest(bodies.Responses).errors, [], 'Responses: the strict validator accepts it');
  assert.deepEqual(validateGeminiRequest({ ...bodies.Gemini, systemInstruction: { parts: [{ text: SYSTEM }] } }).errors, [], 'Gemini: the strict validator accepts it');
  ok('the blocks stay with Anthropic: a history whose waiting round carries thinking blocks and their binding gives Chat Completions, Responses and Gemini requests without a trace of them, accepted by the strict validators');
}

console.log(`\nPASS: ${checks} thinking round trip checks`);
