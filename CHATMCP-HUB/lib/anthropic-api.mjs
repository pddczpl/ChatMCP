// Anthropic Messages API (https://docs.anthropic.com/en/api/messages): request building, response normalising,
// model listing. Pure functions, no network and no state, so the wire format can be tested without a key.
import { contentText, outputText, parseArguments, safeToolId } from './model-history.mjs';
import { reportedTokenCount } from './request-budget.mjs';

export const ANTHROPIC_VERSION = '2023-06-01';
const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message, statusCode = 502) => Object.assign(new Error(message), { code, statusCode });
export function anthropicUserBlocks(content) {
  if (!Array.isArray(content) || !content.some(part => part?.type === 'input_image'))
    return [{type:'text',text:contentText(content)}].filter(block=>block.text.trim());
  return content.map(part => {
    if(part?.type === 'input_text') return {type:'text',text:String(part.text||'')};
    if(part?.type === 'input_image') {
      const url=String(part.image_url||'');
      const m=/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(url);
      if(!m)throw fail('unsupported_image','Invalid base64 image for Anthropic Messages.',415);
      if(m[1]==='image/gif')throw fail('unsupported_image','Anthropic Messages does not support GIF images. Convert to PNG/JPEG/WebP.',415);
      return {type:'image',source:{type:'base64',media_type:m[1],data:m[2]}};
    }
    throw fail('unsupported_media','Unsupported user attachment.',415);
  });
}

export function anthropicEndpoint(base, path = 'messages') {
  const trimmed = base.replace(/\/+$/, '');
  const stem = /\/v1$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
  return `${stem}/${path}`;
}

/** Headers. authMode 'bearer' is for Anthropic-compatible gateways that expect Authorization instead of x-api-key. */
export function anthropicHeaders(apiKey, authMode = 'auto') {
  const headers = { 'Content-Type': 'application/json', 'anthropic-version': ANTHROPIC_VERSION };
  if (apiKey) {
    if (authMode === 'bearer') headers.Authorization = `Bearer ${apiKey}`;
    else headers['x-api-key'] = apiKey;
  }
  return headers;
}

/** Conversation -> Anthropic `messages`. Consecutive messages of one role are merged; tool results come first. */
export function asAnthropicMessages(history) {
  const messages = [];
  const push = (role, block) => {
    const last = messages.at(-1);
    if (last?.role === role) last.content.push(block);
    else messages.push({ role, content: [block] });
  };
  for (const item of history) {
    if (item?.role === 'user') {
      for(const block of anthropicUserBlocks(item.content))push('user',block);
    } else if (item?.type === 'message' && item.role === 'assistant') {
      const text = contentText(item.content);
      if (text.trim()) push('assistant', { type: 'text', text });
    } else if (item?.type === 'function_call') {
      push('assistant', { type: 'tool_use', id: safeToolId(item.call_id), name: item.name, input: parseArguments(item.arguments) });
    } else if (item?.type === 'function_call_output') {
      push('user', { type: 'tool_result', tool_use_id: safeToolId(item.call_id), content: outputText(item.output) || '(không có nội dung)' });
    }
  }
  for (const message of messages) {
    if (message.role !== 'user') continue;
    const results = message.content.filter((block) => block.type === 'tool_result');
    if (results.length) message.content = [...results, ...message.content.filter((block) => block.type !== 'tool_result')];
  }
  return messages;
}

export function anthropicTools(tools) {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description || tool.name,
    input_schema: isObject(tool.parameters) && tool.parameters.type === 'object' ? tool.parameters : { type: 'object', properties: isObject(tool.parameters?.properties) ? tool.parameters.properties : {} },
  }));
}

/**
 * @param {{model: string, input: object[], instructions: string, tools?: object[], maxOutputTokens?: number, promptCaching?: boolean}} request
 */
export function buildAnthropicBody({ model, input, instructions, tools = [], maxOutputTokens = 16384, promptCaching = false }) {
  const messages = asAnthropicMessages(input);
  const body = { model, max_tokens: Math.max(256, Math.floor(maxOutputTokens)), system: [{ type: 'text', text: String(instructions) }], messages };
  if (tools.length) {
    body.tools = anthropicTools(tools);
    // One call at a time: the agent runs them in order and a half-finished batch is harder to recover than one step.
    body.tool_choice = { type: 'auto', disable_parallel_tool_use: true };
  }
  if (promptCaching) {
    // The instructions, the tool list and the conversation so far are re-sent on every step; let the API reuse them.
    body.system[0].cache_control = { type: 'ephemeral' };
    if (body.tools?.length) body.tools.at(-1).cache_control = { type: 'ephemeral' };
    const lastBlock = messages.at(-1)?.content?.at(-1);
    if (lastBlock) lastBlock.cache_control = { type: 'ephemeral' };
  }
  return body;
}

export function normalizeAnthropic(result) {
  if (!isObject(result) || result.type === 'error') throw fail('model_empty', 'Anthropic không trả message hợp lệ.');
  if (!Array.isArray(result.content)) throw fail('model_empty', 'Anthropic không trả nội dung hợp lệ.');
  const baseInput=reportedTokenCount(result.usage?.input_tokens);
  const cacheRead=reportedTokenCount(result.usage?.cache_read_input_tokens);
  const cacheWrite=reportedTokenCount(result.usage?.cache_creation_input_tokens);
  const usage = {
    // Anthropic input_tokens excludes cache read/write, which are included
    // in the total only once. Missing base input remains unavailable.
    input_tokens: baseInput === null ? null : baseInput + (cacheRead ?? 0) + (cacheWrite ?? 0),
    output_tokens: reportedTokenCount(result.usage?.output_tokens),
    cache_read_tokens: cacheRead,
    cache_creation_tokens: cacheWrite,
  };
  const stop = result.stop_reason;
  const calls = result.content.filter((block) => block?.type === 'tool_use');
  const text = result.content.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n');
  const output = [];
  if (stop === 'refusal') {
    output.push({ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: text || 'Model từ chối yêu cầu này.' }] });
    return { status: 'completed', output, usage };
  }
  if (text.trim()) output.push({ type: 'message', role: 'assistant', phase: calls.length ? 'commentary' : 'final', content: [{ type: 'output_text', text }] });
  if (stop === 'max_tokens' || stop === 'pause_turn') {
    // Only the text so far is returned: a tool call cut off by the limit is never executed.
    return { status: 'incomplete', incomplete_details: { reason: stop === 'max_tokens' ? 'max_output_tokens' : 'pause_turn' }, output, usage };
  }
  for (const block of calls) {
    if (typeof block.id !== 'string' || typeof block.name !== 'string' || !isObject(block.input ?? {})) throw fail('model_invalid_function', 'Anthropic trả lời gọi công cụ không hợp lệ.');
    output.push({ type: 'function_call', name: block.name, call_id: block.id, arguments: JSON.stringify(block.input ?? {}), status: 'completed' });
  }
  if (!output.length) throw fail('model_empty', 'Anthropic không trả văn bản hoặc lời gọi công cụ.');
  return { status: 'completed', output, usage };
}

/** GET /v1/models -> [{id, name}] */
export function parseAnthropicModels(data) {
  if (!Array.isArray(data?.data)) return [];
  return data.data.filter((entry) => typeof entry?.id === 'string').map((entry) => ({ id: entry.id, name: typeof entry.display_name === 'string' ? entry.display_name : entry.id }));
}
