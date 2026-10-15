// OpenAI-style Chat Completions (https://platform.openai.com/docs/api-reference/chat) as spoken by OpenAI itself and
// by most other providers and local servers (OpenRouter, DeepSeek, Groq, Mistral, vLLM, LiteLLM, Ollama, LM Studio...).
// Pure functions. Servers differ in small ways, so what comes back is read leniently and what goes out is kept plain.
import { randomUUID } from 'node:crypto';
import { contentText, outputText } from './model-history.mjs';

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message, statusCode = 502) => Object.assign(new Error(message), { code, statusCode });

/**
 * Conversation -> `messages`. A run of function calls becomes ONE assistant message carrying `tool_calls`.
 * Reasoning text that a provider returned is sent back only for the turn in progress (after the last user message):
 * DeepSeek thinking mode requires it between tool calls, and rejects or ignores it for earlier turns.
 */
export function asChatMessages(history, instructions) {
  const messages = [{ role: 'system', content: instructions }];
  let lastUser = -1;
  history.forEach((item, index) => { if (item?.role === 'user') lastUser = index; });
  const reasoningOf = (item, index) => (index > lastUser && typeof item.reasoningContent === 'string' && item.reasoningContent ? item.reasoningContent : '');
  history.forEach((item, index) => {
    if (item?.role === 'user') messages.push({ role: 'user', content: contentText(item.content) });
    else if (item?.type === 'message' && item.role === 'assistant') {
      const message = { role: 'assistant', content: contentText(item.content) };
      const reasoning = reasoningOf(item, index);
      if (reasoning) message.reasoning_content = reasoning;
      messages.push(message);
    } else if (item?.type === 'function_call') {
      let message = messages.at(-1);
      if (message?.role !== 'assistant' || !Array.isArray(message.tool_calls)) {
        if (message?.role === 'assistant' && !message.tool_calls) message.tool_calls = [];
        else {
          message = { role: 'assistant', content: null, tool_calls: [] };
          const reasoning = reasoningOf(item, index);
          if (reasoning) message.reasoning_content = reasoning;
          messages.push(message);
        }
      }
      message.tool_calls.push({ type: 'function', id: item.call_id, function: { name: item.name, arguments: item.arguments } });
    } else if (item?.type === 'function_call_output') messages.push({ role: 'tool', tool_call_id: item.call_id, content: outputText(item.output) });
  });
  return messages;
}

/** Tools are only sent when there are some: several servers reject `tool_choice` without `tools`. */
export function buildChatBody({ model, input, instructions, tools = [] }) {
  const body = { model, messages: asChatMessages(input, instructions), stream: false };
  if (tools.length) {
    body.tools = tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
    body.tool_choice = 'auto';
  }
  return body;
}

const uniqueId = (taken) => {
  let id;
  do { id = `call_${randomUUID().replaceAll('-', '').slice(0, 24)}`; } while (taken.has(id));
  return id;
};

/**
 * Chat Completions response -> the agent's item list.
 *
 * Read leniently, because local and third-party servers are not uniform: a missing or repeated tool-call id gets a fresh
 * one, arguments sent as an object are re-encoded, an unknown finish reason is accepted when there is usable content.
 * Truncation is NOT lenient: `length` yields an incomplete response and a call cut off by the limit is never returned.
 *
 * @param {object} result parsed response body
 * @param {{usedCallIds?: Set<string>}} [options] ids already present in the conversation (a repeat is re-keyed)
 */
export function normalizeChatCompletion(result, { usedCallIds = new Set() } = {}) {
  const choice = result?.choices?.[0];
  if (!isObject(choice) || !isObject(choice.message)) throw fail('model_incomplete', 'Chat Completions chưa hoàn tất (hoặc response không đúng định dạng).');
  const message = choice.message;
  const usage = {
    input_tokens: Number(result.usage?.prompt_tokens) || 0,
    output_tokens: Number(result.usage?.completion_tokens) || 0,
    cache_read_tokens: Number(result.usage?.prompt_tokens_details?.cached_tokens) || 0,
    reasoning_tokens: Number(result.usage?.completion_tokens_details?.reasoning_tokens) || 0,
  };
  const text = typeof message.content === 'string' ? message.content
    : Array.isArray(message.content) ? message.content.filter((part) => typeof part?.text === 'string' && (!part.type || part.type === 'text')).map((part) => part.text).join('\n') : '';
  const reasoning = typeof message.reasoning_content === 'string' ? message.reasoning_content : '';
  const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  // The reasoning text travels with the first item of the turn, so it can be returned to the provider with it.
  let reasoningPending = reasoning;
  const withReasoning = (item) => {
    if (!reasoningPending) return item;
    const tagged = { ...item, reasoningContent: reasoningPending };
    reasoningPending = '';
    return tagged;
  };
  const textItem = () => withReasoning({ type: 'message', role: 'assistant', phase: rawCalls.length ? 'commentary' : 'final', content: [{ type: 'output_text', text }] });

  if (choice.finish_reason === 'length' || choice.finish_reason === 'content_filter') {
    return {
      status: 'incomplete',
      incomplete_details: { reason: choice.finish_reason === 'length' ? 'max_output_tokens' : 'content_filter' },
      output: text.trim() ? [textItem()] : [],
      usage,
    };
  }
  const output = [];
  if (text.trim()) output.push(textItem());
  const taken = new Set(usedCallIds);
  for (const call of rawCalls) {
    const fn = call?.function;
    if (!isObject(call) || (call.type !== undefined && call.type !== 'function') || !isObject(fn) || typeof fn.name !== 'string' || !fn.name) throw fail('model_invalid_function', 'Gateway trả tool_calls không hợp lệ.');
    let args = fn.arguments;
    if (isObject(args)) args = JSON.stringify(args);
    else if (args === undefined || args === null || (typeof args === 'string' && !args.trim())) args = '{}';
    else if (typeof args !== 'string') throw fail('model_invalid_function', 'Gateway trả tham số công cụ không hợp lệ.');
    let id = typeof call.id === 'string' ? call.id.trim() : '';
    if (!id || taken.has(id)) id = uniqueId(taken);
    taken.add(id);
    output.push(withReasoning({ type: 'function_call', name: fn.name, call_id: id, arguments: args, status: 'completed' }));
  }
  if (!output.length && typeof message.refusal === 'string' && message.refusal.trim()) {
    return { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: message.refusal }] }], usage };
  }
  if (!output.length) throw fail('model_empty', 'Gateway trả phản hồi rỗng.');
  return { status: 'completed', output, usage };
}
