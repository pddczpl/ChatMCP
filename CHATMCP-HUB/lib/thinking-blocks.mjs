// Anthropic thinking blocks, kept and sent back (prov-18).
//
// A Claude 5 model thinks by default, and an answer that thought begins with `thinking` blocks (the text is empty unless a summary was asked for; the signature carries the reasoning) or with
// `redacted_thinking` blocks. The signature records the model and the conversation before the block: the system prompt, the set of tools and every message. A request that sends the block
// back after any of them changed is refused on accounts created from 2026-08-31 on ("The block is bound to a different conversation"), while a request that sends no block at all is always
// accepted. So the blocks are worth sending back only where nothing before them changed, and the Hub does change its own history (it shortens old tool results to fit a window).
//
// What the Hub does, in four steps:
//   capture   the blocks of an answer are kept verbatim on the first item of that answer (`providerBlocks`, like Gemini's `providerParts`), or not at all when they cannot go back in their place;
//   bind      the adapter, which knows the request, ties them to it (`providerBinding`): the model, the origin and a digest of the system prompt, the tools and the messages the answer was made in;
//   replay    the next request puts them back, unchanged, first in the assistant message of the tool call that still waits for its result, when the binding still holds: the same model
//             and origin, the same digest of everything before that message, the very blocks that were bound. Anywhere else the blocks stay home;
//   forget    the view the agent measures and shortens holds the blocks of the waiting round only (withoutStaleThinking), so the signatures of old rounds, which can be large, do not count
//             as conversation.
// Dropping blocks is always allowed (the oldest first); the Hub drops all but the last round's, and any it cannot vouch for.
import { createHash } from 'node:crypto';

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const KINDS = new Set(['thinking', 'redacted_thinking']);

export const isThinkingBlock = (block) => isObject(block) && KINDS.has(block.type);

const wellFormed = (block) => (block.type === 'thinking'
  ? typeof block.thinking === 'string' && typeof block.signature === 'string' && block.signature !== ''
  : typeof block.data === 'string' && block.data !== '');

/**
 * The thinking blocks of one answer, as they came, ready to be sent back; null when there are none or when they cannot go back in their place. They go back first in the assistant message, so
 * a block after the text or after a call, or one without its signature (or its data), cannot: the set is kept whole or not at all, because a gap in the chain breaks the blocks after it.
 * @param {unknown[]} content the `content` of the Messages answer
 * @returns {object[]|null} copies
 */
export function captureThinkingBlocks(content) {
  if (!Array.isArray(content)) return null;
  const leading = [];
  let other = false;
  for (const block of content) {
    if (!isThinkingBlock(block)) { other = true; continue; }
    if (other || !wellFormed(block)) return null;
    leading.push(block);
  }
  return leading.length ? structuredClone(leading) : null;
}

/** Whether an answer that was cut off by the output limit had spent it on thinking: it thought, and wrote no text and no call. */
export function endedWhileThinking(content) {
  if (!Array.isArray(content) || !content.some(isThinkingBlock)) return null;
  return !content.some((block) => block?.type === 'tool_use' || (block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== ''));
}

const sortedKeys = (value) => (Array.isArray(value)
  ? value.map(sortedKeys)
  : isObject(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedKeys(value[key])])) : value);
const withoutCacheControl = (value) => (Array.isArray(value)
  ? value.map(withoutCacheControl)
  : isObject(value) ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'cache_control').map(([key, entry]) => [key, withoutCacheControl(entry)])) : value);
const digestOf = (value) => createHash('sha256').update(JSON.stringify(sortedKeys(value))).digest('hex');

/** A digest of the blocks themselves: the very bytes that were bound are the bytes that go back (a signature masked as a secret, or damaged, is not). */
export const blocksDigest = (blocks) => digestOf(blocks);

/**
 * A digest of what the thinking check compares in a request: the system prompt, the tools (as a set, with their whole definition) and the messages. It leaves out what the API leaves out:
 * cache_control markers, the thinking blocks themselves, the order of the tools and of keys. It is stricter than the API in everything else, which is the safe side: a digest that matches is
 * a conversation the API will find the same.
 */
export function conversationDigest({ system, tools, messages }) {
  return digestOf({
    system: withoutCacheControl(system ?? null),
    tools: (Array.isArray(tools) ? withoutCacheControl(tools) : []).sort((a, b) => (a?.name < b?.name ? -1 : a?.name > b?.name ? 1 : 0)),
    messages: (Array.isArray(messages) ? messages : []).map((entry) => withoutCacheControl({
      role: entry?.role,
      content: Array.isArray(entry?.content) ? entry.content.filter((block) => !isThinkingBlock(block)) : entry?.content,
    })),
  });
}

/**
 * Ties the blocks of an answer to the request it was the answer to. Called by whoever sent the request (the adapter), with the body as sent; the model and origin are those the call was
 * started with, so a configuration that changes while it is in flight cannot give blocks a binding they do not have.
 * @param {{output: object[]}} result the normalised answer (changed in place)
 */
export function bindThinking(result, { model, origin, body }) {
  const first = result?.output?.[0];
  if (!Array.isArray(first?.providerBlocks) || first.providerBlocks.length === 0) return result;
  first.providerBinding = { model, origin, blocks: blocksDigest(first.providerBlocks), digest: conversationDigest({ system: body.system, tools: body.tools, messages: body.messages }) };
  return result;
}

/**
 * The blocks that go back first in `messages[index]`, or null when the binding does not hold: the item has to carry blocks and a binding, for this model and origin, the blocks have to be the
 * bound ones, and everything before the message has to be what it was.
 * @returns {object[]|null} copies
 */
export function replayableBlocks(item, { model, origin, system, tools, messages, index }) {
  const binding = item?.providerBinding;
  if (!Array.isArray(item?.providerBlocks) || item.providerBlocks.length === 0 || !isObject(binding)) return null;
  if (binding.model !== model || binding.origin !== origin) return null;
  if (typeof binding.blocks !== 'string' || binding.blocks !== blocksDigest(item.providerBlocks)) return null;
  if (captureThinkingBlocks(item.providerBlocks) === null) return null;
  if (typeof binding.digest !== 'string' || binding.digest !== conversationDigest({ system, tools, messages: messages.slice(0, index) })) return null;
  return structuredClone(item.providerBlocks);
}

const isAssistantItem = (item) => (item?.type === 'message' && item?.role === 'assistant') || item?.type === 'function_call';
const isAnswerItem = (item) => item?.type === 'function_call_output' || item?.role === 'user';

/**
 * The history as the agent measures and shortens it, and as the adapter sends it: the thinking blocks (and their binding) stay only on the assistant items of the round that waits for a
 * tool result, the last one. The signature of a block can be large and an old round's is never sent again, so keeping it would make the conversation look longer than it is and the agent
 * would shorten it sooner. The items are not changed; the ones that lose their blocks are copies.
 */
export function withoutStaleThinking(history) {
  if (!Array.isArray(history)) return history;
  let answers = history.length;
  while (answers > 0 && isAnswerItem(history[answers - 1])) answers -= 1;
  let first = answers;
  while (first > 0 && isAssistantItem(history[first - 1])) first -= 1;
  // The assistant items before the results (and the host messages after them) are a round that waits when results follow them; a call that has none yet waits for nothing.
  const waits = first < answers && history.slice(answers).some((item) => item?.type === 'function_call_output');
  return history.map((item, index) => {
    if (!isObject(item) || (item.providerBlocks === undefined && item.providerBinding === undefined)) return item;
    if (waits && index >= first && index < answers) return item;
    const { providerBlocks, providerBinding, ...rest } = item;
    return rest;
  });
}

/**
 * The 400 of a server that does not accept the thinking blocks it was sent: the real API says the signature is invalid or bound to another conversation, or that the blocks cannot be
 * modified; a server that is not Anthropic's says what it likes about "thinking". Read only after a request that carried blocks.
 */
export const refusesThinkingReplay = (status, detail) => status === 400 && /thinking|signature|bound to a different conversation/i.test(String(detail ?? ''));
