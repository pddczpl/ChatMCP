// Strict validators for the three wire protocols the Hub speaks (OpenAI Chat Completions, Anthropic Messages, OpenAI Responses):
// pure functions that say what the real APIs refuse, plus readers and shape checks for the SSE streams a server sends back.
//
// They exist so that a mock model server can refuse a request the way the real API would, and a defect in what the Hub sends shows up
// as an HTTP 400 at the network seam instead of passing silently. A rule is here for one of four reasons, named in `provenance`:
//   doc       the vendor documents it (the URL is in `source`)
//   sdk       the vendor's SDK type definitions, generated from the API spec, say so (parameter lists)
//   report    quoted in a third-party or community report (the error text is the real one)
//   recalled  observed with the real API earlier but not confirmed again while writing this file; the wording of the message is ours
// The lists of accepted parameters are the documented sets, not the sets today's Hub happens to send, so a new Hub feature is not
// refused by the mock for being new. Where something is only partly known the validator is lenient: refusing a valid request would make
// the mock lie in the other direction.
//
// A validator returns { ok, errors: [{ rule, message, status, param?, code? }] }. All problems are listed, in the order the API would
// meet them; errors[0] is the one a server reports.
import crypto from 'node:crypto';

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string';
const isNonEmptyText = (value) => typeof value === 'string' && value.length > 0;
const list = (values) => values.join(', ');

export const RULES = Object.freeze({
  'chat.unknown_param': { api: 'chat', provenance: 'sdk', source: 'https://github.com/openai/openai-python (src/openai/types/chat/completion_create_params.py); the wording "Unrecognized request argument supplied" is quoted in OpenAI community threads', summary: 'a top-level parameter the API does not know is refused' },
  'chat.required': { api: 'chat', provenance: 'sdk', source: 'completion_create_params.py: messages and model are the required fields', summary: 'model and a non-empty messages list' },
  'chat.message_fields': { api: 'chat', provenance: 'recalled', source: 'roles, fields and content types of the message params in the OpenAI API reference', summary: 'roles, per-role fields (no extras), content types, tool call shape' },
  'chat.tool_result_placement': { api: 'chat', provenance: 'report', source: 'https://docs.langchain.com/oss/python/langchain/errors/INVALID_TOOL_RESULTS and OpenAI community threads quote both error texts', summary: 'an assistant message with tool_calls is followed directly by one tool message per call, and a tool message only ever answers such a call' },
  'chat.tool_choice_needs_tools': { api: 'chat', provenance: 'recalled', source: 'the Hub sends tool_choice only with tools for this reason (buildChatBody)', summary: 'tool_choice only together with tools' },
  'chat.stream_options_need_stream': { api: 'chat', provenance: 'recalled', source: 'OpenAI API reference: stream_options is for stream: true', summary: 'stream_options only on a stream' },
  'chat.tool_definition': { api: 'chat', provenance: 'recalled', source: 'OpenAI API reference: tools', summary: 'type function, a function with a name of letters, digits, _ and -' },
  'anthropic.unknown_param': { api: 'anthropic', provenance: 'doc', source: 'https://platform.claude.com/docs/en/api/messages and the SDK type message_create_params.py', summary: 'a top-level parameter the API does not know is refused ("Extra inputs are not permitted")' },
  'anthropic.required': { api: 'anthropic', provenance: 'doc', source: 'https://platform.claude.com/docs/en/api/messages: max_tokens, messages and model are required', summary: 'model, max_tokens >= 1 and a non-empty messages list' },
  'anthropic.content_blocks': { api: 'anthropic', provenance: 'recalled', source: 'https://platform.claude.com/docs/en/api/messages (block types); empty text blocks are refused by the real API, which is why anthropicUserBlocks drops blank text', summary: 'roles user/assistant, known block types, no empty or white-space text blocks' },
  'anthropic.tool_result_placement': { api: 'anthropic', provenance: 'doc', source: 'https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls ("Important formatting requirements"); consecutive turns of one role are combined: https://platform.claude.com/docs/en/api/messages', summary: 'tool_result blocks are the leading blocks of the user message right after the assistant message with their tool_use, one per call' },
  'anthropic.tool_use_id': { api: 'anthropic', provenance: 'recalled', source: 'the pattern ^[a-zA-Z0-9_-]{1,64}$ that safeToolId() in lib/model-history.mjs maps ids to', summary: 'tool_use ids of letters, digits, _ and - (at most 64)' },
  'anthropic.thinking_signature': { api: 'anthropic', provenance: 'doc', source: 'https://platform.claude.com/docs/en/build-with-claude/thinking ("Preserving thinking blocks") and /thinking-troubleshooting (the two error texts); thinking blocks of EARLIER turns are accepted and filtered by the API', summary: 'thinking and redacted_thinking blocks carry what the server issued, unmodified' },
  'anthropic.thinking_first': { api: 'anthropic', provenance: 'doc', source: 'https://platform.claude.com/docs/en/build-with-claude/thinking ("Thinking with tool use": in extended (manual) mode the final assistant turn begins with a thinking block); the error text is the older wording of the same rule', summary: 'with extended thinking on, the assistant turn of a tool loop starts with its thinking block' },
  'anthropic.thinking_config': { api: 'anthropic', provenance: 'doc', source: 'https://platform.claude.com/docs/en/build-with-claude/extended-thinking ("Budget rules": at least 1024, below max_tokens) and /thinking ("Tool choice limitation")', summary: 'budget_tokens >= 1024 and < max_tokens; no forced tool use while extended thinking is on' },
  'responses.unknown_param': { api: 'responses', provenance: 'sdk', source: 'https://github.com/openai/openai-python (src/openai/types/responses/response_create_params.py); "Unknown parameter" is quoted in community reports', summary: 'a top-level parameter the API does not know is refused' },
  'responses.input': { api: 'responses', provenance: 'recalled', source: 'OpenAI API reference: input items', summary: 'input is a string or a list of known items with their required fields' },
  'responses.tool_result_pairing': { api: 'responses', provenance: 'report', source: 'https://community.openai.com/t/issue-with-new-responses-api-400-no-tool-call-found-for-function-call-output-with-call-id/1142327 (first text); the second text is recalled', summary: 'every function_call_output follows a function_call with its call_id, and every function_call is answered' },
  'responses.tool_definition': { api: 'responses', provenance: 'recalled', source: 'OpenAI API reference: tools (a function tool has type, name and parameters at the top level)', summary: 'known tool types; a function tool has a name' },
  'responses.stream_options_need_stream': { api: 'responses', provenance: 'sdk', source: 'response_create_params.py: stream_options is only for stream: true', summary: 'stream_options only on a stream' },
  'chat.stream_shape': { api: 'chat', provenance: 'sdk', source: 'openai-python chat_completion_chunk.py: chunks, tool call fragments, a usage chunk with no choices, [DONE]', summary: 'what a Chat Completions SSE stream looks like' },
  'anthropic.stream_shape': { api: 'anthropic', provenance: 'doc', source: 'https://platform.claude.com/docs/en/build-with-claude/streaming', summary: 'message_start, blocks with start/delta/stop, message_delta, message_stop' },
  'responses.stream_shape': { api: 'responses', provenance: 'sdk', source: 'openai-python src/openai/types/responses/response_*_event.py', summary: 'response.created ... response.completed with increasing sequence_number and items that match their deltas' },
});

function collector() {
  const errors = [];
  return {
    add(rule, message, extra = {}) { errors.push({ rule, message, status: 400, ...extra }); },
    result: () => ({ ok: errors.length === 0, errors }),
  };
}

/** The JSON body of an error answer, in the envelope each API uses. */
export function errorBody(api, { message, param = null, code = null, type = 'invalid_request_error' }) {
  if (api === 'anthropic') return { type: 'error', error: { type, message }, request_id: 'req_mock' };
  return { error: { message, type, param, code } };
}

// ---------------------------------------------------------------------------------------------------------------------
// Thinking signatures. The server signs what it emits; a request that echoes a thinking block back is checked against it.
// ---------------------------------------------------------------------------------------------------------------------
export function createThinkingSigner(secret = crypto.randomBytes(16).toString('hex')) {
  const mac = (label, text) => crypto.createHmac('sha256', secret).update(`${label}\0${text}`).digest('base64url');
  const SIGNATURE = /^mock-sig\.[A-Za-z0-9_-]{43}$/;
  return {
    signThinking: (text) => `mock-sig.${mac('thinking', String(text))}`,
    /** The opaque payload of a redacted_thinking block. */
    redacted: (label = 'redacted') => `mock-redacted.${Buffer.from(String(label)).toString('base64url')}.${mac('redacted', String(label))}`,
    /** 'ok', 'modified' (a signature of this server that belongs to another text) or 'invalid' (not a signature of this server). */
    verifyThinking({ thinking, signature }) {
      if (!isNonEmptyText(signature) || !SIGNATURE.test(signature)) return 'invalid';
      return signature === `mock-sig.${mac('thinking', String(thinking ?? ''))}` ? 'ok' : 'modified';
    },
    verifyRedacted(data) {
      const match = /^mock-redacted\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(String(data));
      return Boolean(match) && match[2] === mac('redacted', Buffer.from(match[1], 'base64url').toString());
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// OpenAI Chat Completions
// ---------------------------------------------------------------------------------------------------------------------
const CHAT_PARAMS = new Set(['messages', 'model', 'audio', 'frequency_penalty', 'function_call', 'functions', 'logit_bias', 'logprobs', 'max_completion_tokens', 'max_tokens', 'metadata', 'modalities', 'moderation', 'n', 'parallel_tool_calls', 'prediction', 'presence_penalty', 'prompt_cache_key', 'prompt_cache_options', 'prompt_cache_retention', 'reasoning_effort', 'response_format', 'safety_identifier', 'seed', 'service_tier', 'stop', 'store', 'stream', 'stream_options', 'temperature', 'tool_choice', 'tools', 'top_logprobs', 'top_p', 'user', 'verbosity', 'web_search_options']);
const CHAT_MESSAGE_FIELDS = {
  system: ['role', 'content', 'name'],
  developer: ['role', 'content', 'name'],
  user: ['role', 'content', 'name'],
  assistant: ['role', 'content', 'name', 'refusal', 'audio', 'tool_calls', 'function_call'],
  tool: ['role', 'content', 'tool_call_id'],
  function: ['role', 'content', 'name'],
};
const CHAT_USER_PARTS = new Set(['text', 'image_url', 'input_audio', 'file']);
const TOOL_NAME = /^[a-zA-Z0-9_-]+$/;

/**
 * @param {object} body the parsed request body
 * @param {{dialect?: 'openai'|'compat'}} [options] 'compat' also accepts what DeepSeek and similar servers add (reasoning_content)
 */
export function validateChatRequest(body, { dialect = 'openai' } = {}) {
  const c = collector();
  if (!isObject(body)) { c.add('chat.required', 'Invalid request: the body must be a JSON object.'); return c.result(); }
  for (const key of Object.keys(body)) {
    if (!CHAT_PARAMS.has(key)) c.add('chat.unknown_param', `Unrecognized request argument supplied: ${key}`, { param: key });
  }
  if (!isNonEmptyText(body.model)) c.add('chat.required', "Missing required parameter: 'model'.", { param: 'model', code: 'missing_required_parameter' });
  const messages = body.messages;
  if (messages === undefined) c.add('chat.required', "Missing required parameter: 'messages'.", { param: 'messages', code: 'missing_required_parameter' });
  else if (!Array.isArray(messages)) c.add('chat.required', "Invalid type for 'messages': expected an array of objects.", { param: 'messages' });
  else if (messages.length === 0) c.add('chat.required', "Invalid 'messages': empty array. Expected an array with minimum length 1, but got an empty array instead.", { param: 'messages' });

  if (body.tool_choice !== undefined && !(Array.isArray(body.tools) && body.tools.length)) {
    c.add('chat.tool_choice_needs_tools', "Invalid value for 'tool_choice': 'tool_choice' is only allowed when 'tools' are specified.", { param: 'tool_choice' });
  }
  if (body.stream_options !== undefined && body.stream !== true) {
    c.add('chat.stream_options_need_stream', "The 'stream_options' parameter is only allowed when 'stream' is enabled.", { param: 'stream_options' });
  }
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) c.add('chat.tool_definition', "Invalid type for 'tools': expected an array of objects.", { param: 'tools' });
    else body.tools.forEach((tool, i) => {
      if (!isObject(tool)) { c.add('chat.tool_definition', `Invalid type for 'tools[${i}]': expected an object.`, { param: `tools[${i}]` }); return; }
      if (tool.type !== 'function' && tool.type !== 'custom') { c.add('chat.tool_definition', `Invalid value: '${tool.type}'. Supported values are: 'function' and 'custom'.`, { param: `tools[${i}].type`, code: 'invalid_value' }); return; }
      if (tool.type === 'function') {
        if (!isObject(tool.function)) { c.add('chat.tool_definition', `Missing required parameter: 'tools[${i}].function'.`, { param: `tools[${i}].function`, code: 'missing_required_parameter' }); return; }
        if (!isText(tool.function.name) || !TOOL_NAME.test(tool.function.name) || tool.function.name.length > 64) {
          c.add('chat.tool_definition', `Invalid 'tools[${i}].function.name': string does not match pattern. Expected a string that matches the pattern '^[a-zA-Z0-9_-]+$'.`, { param: `tools[${i}].function.name` });
        }
        if (tool.function.parameters !== undefined && !isObject(tool.function.parameters)) c.add('chat.tool_definition', `Invalid type for 'tools[${i}].function.parameters': expected an object.`, { param: `tools[${i}].function.parameters` });
      }
    });
  }
  if (!Array.isArray(messages)) return c.result();

  messages.forEach((message, i) => {
    const at = `messages[${i}]`;
    if (!isObject(message)) { c.add('chat.message_fields', `Invalid type for '${at}': expected an object.`, { param: at }); return; }
    const fields = CHAT_MESSAGE_FIELDS[message.role];
    if (!fields) { c.add('chat.message_fields', `Invalid value: '${message.role}'. Supported values are: 'developer', 'system', 'user', 'assistant', 'tool', and 'function'.`, { param: `${at}.role`, code: 'invalid_value' }); return; }
    const allowed = new Set(dialect === 'compat' && message.role === 'assistant' ? [...fields, 'reasoning_content'] : fields);
    for (const key of Object.keys(message)) if (!allowed.has(key)) c.add('chat.message_fields', `Additional properties are not allowed ('${key}' was unexpected)`, { param: at });
    const content = message.content;
    const textParts = (value) => Array.isArray(value) && value.every((part) => isObject(part) && part.type === 'text' && isText(part.text));
    if (message.role === 'user') {
      const parts = Array.isArray(content) && content.every((part) => isObject(part) && CHAT_USER_PARTS.has(part.type));
      if (!isText(content) && !parts) c.add('chat.message_fields', `Invalid type for '${at}.content': expected a string or an array of content parts.`, { param: `${at}.content` });
    } else if (message.role === 'assistant') {
      const calls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
      if (content === null || content === undefined) {
        if (!calls && message.function_call === undefined && message.refusal === undefined && message.audio === undefined) c.add('chat.message_fields', "Invalid value for 'content': expected a string, got null.", { param: `${at}.content` });
      } else if (!isText(content) && !(Array.isArray(content))) c.add('chat.message_fields', `Invalid type for '${at}.content': expected a string.`, { param: `${at}.content` });
      if (message.tool_calls !== undefined) {
        if (!Array.isArray(message.tool_calls)) c.add('chat.message_fields', `Invalid type for '${at}.tool_calls': expected an array of objects.`, { param: `${at}.tool_calls` });
        else message.tool_calls.forEach((entry, j) => {
          const where = `${at}.tool_calls[${j}]`;
          if (!isObject(entry) || entry.type !== 'function' || !isObject(entry.function)) { c.add('chat.message_fields', `Invalid '${where}': expected an object with type 'function' and a function.`, { param: where }); return; }
          if (!isNonEmptyText(entry.id)) c.add('chat.message_fields', `Missing required parameter: '${where}.id'.`, { param: `${where}.id`, code: 'missing_required_parameter' });
          if (!isNonEmptyText(entry.function.name)) c.add('chat.message_fields', `Missing required parameter: '${where}.function.name'.`, { param: `${where}.function.name`, code: 'missing_required_parameter' });
          if (!isText(entry.function.arguments)) c.add('chat.message_fields', `Invalid type for '${where}.function.arguments': expected a string, but got ${isObject(entry.function.arguments) ? 'an object' : typeof entry.function.arguments} instead.`, { param: `${where}.function.arguments` });
        });
      }
    } else if (message.role === 'tool') {
      if (!isNonEmptyText(message.tool_call_id)) c.add('chat.message_fields', `Missing required parameter: '${at}.tool_call_id'.`, { param: `${at}.tool_call_id`, code: 'missing_required_parameter' });
      if (!isText(content) && !textParts(content)) c.add('chat.message_fields', `Invalid type for '${at}.content': expected a string or an array of text parts.`, { param: `${at}.content` });
    } else if (!isText(content) && !textParts(content)) {
      c.add('chat.message_fields', `Invalid type for '${at}.content': expected a string or an array of text parts.`, { param: `${at}.content` });
    }
  });

  // An assistant message with tool_calls is followed by tool messages answering each id, with nothing in between.
  let pending = null;
  const missing = (set, i) => c.add('chat.tool_result_placement', `An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'. The following tool_call_ids did not have response messages: ${list([...set])}`, { param: `messages[${i}].role` });
  const orphan = (i) => c.add('chat.tool_result_placement', "Invalid parameter: messages with role 'tool' must be a response to a preceeding message with 'tool_calls'.", { param: `messages[${i}].role` });
  messages.forEach((message, i) => {
    if (!isObject(message)) return;
    if (pending && pending.size) {
      if (message.role === 'tool' && pending.has(message.tool_call_id)) pending.delete(message.tool_call_id);
      else if (message.role === 'tool') orphan(i);
      else { missing(pending, i); pending = null; }
    } else if (message.role === 'tool') orphan(i);
    if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      pending = new Set(message.tool_calls.map((entry) => entry?.id).filter(isText));
    }
  });
  if (pending && pending.size) missing(pending, messages.length);
  return c.result();
}

// ---------------------------------------------------------------------------------------------------------------------
// Anthropic Messages
// ---------------------------------------------------------------------------------------------------------------------
// https://platform.claude.com/docs/en/api/messages and the SDK type; the last three are older sampling parameters and two betas.
const ANTHROPIC_PARAMS = new Set(['max_tokens', 'messages', 'model', 'cache_control', 'container', 'diagnostics', 'inference_geo', 'metadata', 'output_config', 'service_tier', 'speed', 'stop_sequences', 'stream', 'system', 'thinking', 'tool_choice', 'tools', 'user_profile_id', 'workspace_id', 'temperature', 'top_p', 'top_k', 'mcp_servers', 'context_management']);
const ANTHROPIC_BLOCKS = new Set(['text', 'image', 'document', 'search_result', 'thinking', 'redacted_thinking', 'tool_use', 'tool_result', 'server_tool_use', 'web_search_tool_result', 'web_fetch_tool_result', 'code_execution_tool_result', 'bash_code_execution_tool_result', 'text_editor_code_execution_tool_result', 'tool_search_tool_result', 'container_upload']);
const TOOL_USE_ID = /^[a-zA-Z0-9_-]+$/;

/** Consecutive turns of one role are combined into one turn (the API says so); the checks below work on the combined list. */
function mergeTurns(messages) {
  const turns = [];
  for (const message of messages) {
    if (!isObject(message) || (message.role !== 'user' && message.role !== 'assistant')) { turns.push(message); continue; }
    const blocks = isText(message.content) ? (message.content ? [{ type: 'text', text: message.content }] : []) : Array.isArray(message.content) ? message.content : [];
    const last = turns.at(-1);
    if (isObject(last) && last.role === message.role) last.content = [...last.content, ...blocks];
    else turns.push({ role: message.role, content: [...blocks] });
  }
  return turns;
}

/**
 * @param {object} body the parsed request body
 * @param {{signer?: ReturnType<typeof createThinkingSigner>}} [options] with a signer, thinking blocks are checked against it
 */
export function validateAnthropicRequest(body, { signer = null } = {}) {
  const c = collector();
  if (!isObject(body)) { c.add('anthropic.required', 'Invalid request: the body must be a JSON object.'); return c.result(); }
  for (const key of Object.keys(body)) if (!ANTHROPIC_PARAMS.has(key)) c.add('anthropic.unknown_param', `${key}: Extra inputs are not permitted`, { param: key });
  if (!isNonEmptyText(body.model)) c.add('anthropic.required', 'model: Field required', { param: 'model' });
  if (body.max_tokens === undefined) c.add('anthropic.required', 'max_tokens: Field required', { param: 'max_tokens' });
  else if (!Number.isInteger(body.max_tokens) || body.max_tokens < 1) c.add('anthropic.required', 'max_tokens: Input should be a valid integer greater than or equal to 1', { param: 'max_tokens' });
  if (body.messages === undefined) c.add('anthropic.required', 'messages: Field required', { param: 'messages' });
  else if (!Array.isArray(body.messages)) c.add('anthropic.required', 'messages: Input should be a valid list', { param: 'messages' });
  else if (body.messages.length === 0) c.add('anthropic.required', 'messages: at least one message is required', { param: 'messages' });
  if (!Array.isArray(body.messages)) return c.result();

  const roleProblem = body.messages.some((message) => !isObject(message) || (message.role !== 'user' && message.role !== 'assistant'));
  body.messages.forEach((message, i) => {
    if (!isObject(message) || (message.role !== 'user' && message.role !== 'assistant')) {
      c.add('anthropic.content_blocks', `messages.${i}.role: Input should be 'user' or 'assistant'`, { param: `messages.${i}.role` });
      return;
    }
    if (isText(message.content)) {
      if (!message.content.length) c.add('anthropic.content_blocks', `messages.${i}: all messages must have non-empty content except for the optional final assistant message`, { param: `messages.${i}` });
      return;
    }
    if (!Array.isArray(message.content)) { c.add('anthropic.content_blocks', `messages.${i}.content: Input should be a valid string or a list of content blocks`, { param: `messages.${i}.content` }); return; }
    message.content.forEach((block, j) => {
      const at = `messages.${i}.content.${j}`;
      if (!isObject(block) || !ANTHROPIC_BLOCKS.has(block.type)) { c.add('anthropic.content_blocks', `${at}.type: Input tag '${block?.type}' found using 'type' does not match any of the expected tags`, { param: `${at}.type` }); return; }
      if (block.type === 'text') {
        if (!isText(block.text)) c.add('anthropic.content_blocks', `${at}.text: Field required`, { param: `${at}.text` });
        else if (block.text.length === 0) c.add('anthropic.content_blocks', `${at}.text: text content blocks must be non-empty`, { param: `${at}.text` });
        else if (!block.text.trim()) c.add('anthropic.content_blocks', `${at}.text: text content blocks must contain non-whitespace text`, { param: `${at}.text` });
      }
      if (block.type === 'tool_use' && message.role !== 'assistant') c.add('anthropic.content_blocks', `${at}: tool_use blocks can only be in assistant messages`, { param: at });
      if (block.type === 'tool_result' && message.role !== 'user') c.add('anthropic.content_blocks', `${at}: tool_result blocks can only be in user messages`, { param: at });
      if (block.type === 'tool_use') {
        if (!isText(block.id) || !TOOL_USE_ID.test(block.id)) c.add('anthropic.tool_use_id', `${at}.tool_use.id: String should match pattern '^[a-zA-Z0-9_-]+$'`, { param: `${at}.id` });
        else if (block.id.length > 64) c.add('anthropic.tool_use_id', `${at}.tool_use.id: String should have at most 64 characters`, { param: `${at}.id` });
      }
    });
  });
  if (roleProblem) return c.result();

  // tool_result placement, on the combined turns
  const turns = mergeTurns(body.messages);
  const idsOf = (turn, type) => turn.content.filter((block) => block?.type === type).map((block) => (type === 'tool_use' ? block.id : block.tool_use_id)).filter(isText);
  const missingResults = (ids, i) => c.add('anthropic.tool_result_placement', `messages.${i}: \`tool_use\` ids were found without \`tool_result\` blocks immediately after: ${list(ids)}. Each \`tool_use\` block must have a corresponding \`tool_result\` block in the next message.`, { param: `messages.${i}` });
  const strayResults = (ids, i) => c.add('anthropic.tool_result_placement', `messages.${i}.content.0: unexpected \`tool_use_id\` found in \`tool_result\` blocks: ${list(ids)}. Each \`tool_result\` block must have a corresponding \`tool_use\` block in the previous message.`, { param: `messages.${i}.content.0` });
  turns.forEach((turn, i) => {
    const previous = turns[i - 1];
    const calls = previous?.role === 'assistant' ? idsOf(previous, 'tool_use') : [];
    if (turn.role === 'assistant') return;
    const leading = [];
    for (const block of turn.content) { if (block?.type === 'tool_result') leading.push(block); else break; }
    if (turn.content.length > leading.length && turn.content.slice(leading.length).some((block) => block?.type === 'tool_result')) {
      c.add('anthropic.tool_result_placement', `messages.${i}.content: \`tool_result\` blocks must come first in the user message's content array; any text must come after all tool results.`, { param: `messages.${i}.content` });
    }
    const answered = leading.map((block) => block.tool_use_id).filter(isText);
    const unanswered = calls.filter((id) => !answered.includes(id));
    if (unanswered.length) missingResults(unanswered, i - 1);
    const stray = idsOf(turn, 'tool_result').filter((id) => !calls.includes(id));
    if (stray.length) strayResults(stray, i);
  });
  const last = turns.at(-1);
  if (last?.role === 'assistant') {
    const calls = idsOf(last, 'tool_use');
    if (calls.length) missingResults(calls, turns.length - 1);
  }

  // thinking blocks: what the server issued, unmodified (earlier turns too: a signature that does not verify is refused anywhere)
  const latestAssistant = turns.findLastIndex((turn) => turn?.role === 'assistant');
  turns.forEach((turn, i) => {
    if (turn.role !== 'assistant') return;
    turn.content.forEach((block, j) => {
      const at = `messages.${i}.content.${j}`;
      if (block?.type === 'thinking') {
        if (!isNonEmptyText(block.signature)) { c.add('anthropic.thinking_signature', `${at}.thinking.signature: Field required`, { param: `${at}.signature` }); return; }
        if (!isText(block.thinking)) { c.add('anthropic.thinking_signature', `${at}.thinking.thinking: Field required`, { param: `${at}.thinking` }); return; }
        const verdict = signer ? signer.verifyThinking(block) : 'ok';
        if (verdict === 'invalid') c.add('anthropic.thinking_signature', `${at}: Invalid \`signature\` in \`thinking\` block`, { param: at });
        else if (verdict === 'modified') {
          c.add('anthropic.thinking_signature', i === latestAssistant
            ? `${at}: \`thinking\` or \`redacted_thinking\` blocks in the latest assistant message cannot be modified`
            : `${at}: Invalid \`signature\` in \`thinking\` block`, { param: at });
        }
      } else if (block?.type === 'redacted_thinking') {
        if (!isNonEmptyText(block.data)) c.add('anthropic.thinking_signature', `${at}.redacted_thinking.data: Field required`, { param: `${at}.data` });
        else if (signer && !signer.verifyRedacted(block.data)) c.add('anthropic.thinking_signature', `${at}: Invalid \`data\` in \`redacted_thinking\` block`, { param: at });
      }
    });
  });

  const thinking = body.thinking;
  if (isObject(thinking) && thinking.type === 'enabled') {
    // extended (manual) thinking: a tool loop continues an assistant turn that began with its thinking block
    const lastTurn = turns.at(-1);
    const before = turns.at(-2);
    const continuing = lastTurn?.role === 'user' && before?.role === 'assistant' && idsOf(before, 'tool_use').length > 0 && lastTurn.content[0]?.type === 'tool_result';
    if (continuing) {
      const first = before.content[0]?.type;
      if (first !== 'thinking' && first !== 'redacted_thinking') {
        c.add('anthropic.thinking_first', `messages.${turns.length - 2}.content.0.type: Expected \`thinking\` or \`redacted_thinking\`, but found \`${first}\`. When \`thinking\` is enabled, a final \`assistant\` message must start with a thinking block (preceeding the lastmost set of \`tool_use\` and \`tool_result\` blocks). We recommend you include thinking blocks from previous turns. To avoid this requirement, disable \`thinking\`.`, { param: `messages.${turns.length - 2}.content.0.type` });
      }
    }
    if (!Number.isInteger(thinking.budget_tokens) || thinking.budget_tokens < 1024) c.add('anthropic.thinking_config', 'thinking.enabled.budget_tokens: Input should be greater than or equal to 1024', { param: 'thinking.budget_tokens' });
    else if (Number.isInteger(body.max_tokens) && body.max_tokens <= thinking.budget_tokens) c.add('anthropic.thinking_config', 'max_tokens must be greater than thinking.budget_tokens. Please consult our documentation at https://docs.claude.com/en/docs/build-with-claude/extended-thinking#max-tokens-and-context-window-size', { param: 'max_tokens' });
    if (isObject(body.tool_choice) && (body.tool_choice.type === 'any' || body.tool_choice.type === 'tool')) c.add('anthropic.thinking_config', 'Thinking may not be enabled when tool_choice forces tool use.', { param: 'tool_choice' });
  } else if (thinking !== undefined && (!isObject(thinking) || !['disabled', 'adaptive', 'between_tools'].includes(thinking.type))) {
    c.add('anthropic.thinking_config', "thinking.type: Input should be 'enabled', 'disabled' or 'adaptive'", { param: 'thinking.type' });
  }
  return c.result();
}

// ---------------------------------------------------------------------------------------------------------------------
// OpenAI Responses
// ---------------------------------------------------------------------------------------------------------------------
const RESPONSES_PARAMS = new Set(['access_programs', 'background', 'context_management', 'conversation', 'include', 'input', 'instructions', 'max_output_tokens', 'max_tool_calls', 'metadata', 'model', 'moderation', 'parallel_tool_calls', 'previous_response_id', 'prompt', 'prompt_cache_key', 'prompt_cache_options', 'prompt_cache_retention', 'reasoning', 'safety_identifier', 'service_tier', 'store', 'stream', 'stream_options', 'temperature', 'text', 'tool_choice', 'tools', 'top_logprobs', 'top_p', 'truncation', 'user']);
const RESPONSES_ROLES = new Set(['user', 'assistant', 'system', 'developer']);
const RESPONSES_ITEMS = new Set(['message', 'function_call', 'function_call_output', 'reasoning', 'item_reference', 'custom_tool_call', 'custom_tool_call_output', 'web_search_call', 'file_search_call', 'computer_call', 'computer_call_output', 'code_interpreter_call', 'image_generation_call', 'mcp_call', 'mcp_list_tools', 'mcp_approval_request', 'mcp_approval_response', 'local_shell_call', 'local_shell_call_output', 'shell_call', 'shell_call_output', 'apply_patch_call', 'apply_patch_call_output', 'compaction']);
const RESPONSES_TOOLS = new Set(['function', 'custom', 'web_search', 'web_search_preview', 'file_search', 'computer_use_preview', 'computer', 'code_interpreter', 'mcp', 'image_generation', 'local_shell', 'shell', 'apply_patch', 'tool_search']);

export function validateResponsesRequest(body) {
  const c = collector();
  if (!isObject(body)) { c.add('responses.input', 'Invalid request: the body must be a JSON object.'); return c.result(); }
  for (const key of Object.keys(body)) if (!RESPONSES_PARAMS.has(key)) c.add('responses.unknown_param', `Unknown parameter: '${key}'.`, { param: key, code: 'unknown_parameter' });
  const stored = body.previous_response_id !== undefined || body.conversation !== undefined || body.prompt !== undefined;
  if (body.input === undefined && !stored) c.add('responses.input', "Missing required parameter: 'input'.", { param: 'input', code: 'missing_required_parameter' });
  if (body.stream_options !== undefined && body.stream !== true) c.add('responses.stream_options_need_stream', "The 'stream_options' parameter is only allowed when 'stream' is enabled.", { param: 'stream_options' });

  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) c.add('responses.tool_definition', "Invalid type for 'tools': expected an array of objects.", { param: 'tools' });
    else body.tools.forEach((tool, i) => {
      if (!isObject(tool) || !RESPONSES_TOOLS.has(tool.type)) { c.add('responses.tool_definition', `Invalid value: '${tool?.type}'. Supported values are: ${list([...RESPONSES_TOOLS].map((name) => `'${name}'`))}.`, { param: `tools[${i}].type`, code: 'invalid_value' }); return; }
      if (tool.type === 'function') {
        if (!isNonEmptyText(tool.name)) c.add('responses.tool_definition', `Missing required parameter: 'tools[${i}].name'.`, { param: `tools[${i}].name`, code: 'missing_required_parameter' });
        else if (!TOOL_NAME.test(tool.name) || tool.name.length > 64) c.add('responses.tool_definition', `Invalid 'tools[${i}].name': string does not match pattern. Expected a string that matches the pattern '^[a-zA-Z0-9_-]+$'.`, { param: `tools[${i}].name` });
        if (tool.parameters !== undefined && tool.parameters !== null && !isObject(tool.parameters)) c.add('responses.tool_definition', `Invalid type for 'tools[${i}].parameters': expected an object.`, { param: `tools[${i}].parameters` });
      }
    });
  }

  if (!Array.isArray(body.input)) {
    if (body.input !== undefined && !isText(body.input)) c.add('responses.input', "Invalid type for 'input': expected one of a string or array of input items.", { param: 'input' });
    return c.result();
  }
  body.input.forEach((item, i) => {
    const at = `input[${i}]`;
    if (!isObject(item)) { c.add('responses.input', `Invalid type for '${at}': expected an object.`, { param: at }); return; }
    const type = item.type ?? 'message';
    if (!RESPONSES_ITEMS.has(type)) { c.add('responses.input', `Invalid value: '${item.type}'. Supported values are: ${list([...RESPONSES_ITEMS].slice(0, 6).map((name) => `'${name}'`))}, and more.`, { param: `${at}.type`, code: 'invalid_value' }); return; }
    if (type === 'message') {
      if (!RESPONSES_ROLES.has(item.role)) c.add('responses.input', `Invalid value: '${item.role}'. Supported values are: 'assistant', 'system', 'developer', and 'user'.`, { param: `${at}.role`, code: 'invalid_value' });
      if (!isText(item.content) && !Array.isArray(item.content)) c.add('responses.input', `Invalid type for '${at}.content': expected one of a string or an array of content items.`, { param: `${at}.content` });
    } else if (type === 'function_call') {
      if (!isNonEmptyText(item.call_id)) c.add('responses.input', `Missing required parameter: '${at}.call_id'.`, { param: `${at}.call_id`, code: 'missing_required_parameter' });
      if (!isNonEmptyText(item.name)) c.add('responses.input', `Missing required parameter: '${at}.name'.`, { param: `${at}.name`, code: 'missing_required_parameter' });
      if (item.arguments === undefined) c.add('responses.input', `Missing required parameter: '${at}.arguments'.`, { param: `${at}.arguments`, code: 'missing_required_parameter' });
      else if (!isText(item.arguments)) c.add('responses.input', `Invalid type for '${at}.arguments': expected a string, but got ${isObject(item.arguments) ? 'an object' : typeof item.arguments} instead.`, { param: `${at}.arguments` });
    } else if (type === 'function_call_output') {
      if (!isNonEmptyText(item.call_id)) c.add('responses.input', `Missing required parameter: '${at}.call_id'.`, { param: `${at}.call_id`, code: 'missing_required_parameter' });
      if (!isText(item.output) && !Array.isArray(item.output)) c.add('responses.input', `Invalid type for '${at}.output': expected one of a string or an array of content items.`, { param: `${at}.output` });
    }
  });

  const callIndex = new Map();
  body.input.forEach((item, i) => { if (isObject(item) && item.type === 'function_call' && isText(item.call_id) && !callIndex.has(item.call_id)) callIndex.set(item.call_id, i); });
  const answered = new Set();
  body.input.forEach((item, i) => {
    if (!isObject(item) || item.type !== 'function_call_output' || !isText(item.call_id)) return;
    if (!(callIndex.has(item.call_id) && callIndex.get(item.call_id) < i)) {
      c.add('responses.tool_result_pairing', `No tool call found for function call output with call_id ${item.call_id}.`, { param: `input[${i}].call_id` });
    } else answered.add(item.call_id);
  });
  for (const [callId, i] of callIndex) {
    if (!answered.has(callId)) c.add('responses.tool_result_pairing', `No tool output found for function call ${callId}.`, { param: `input[${i}]` });
  }
  return c.result();
}

// ---------------------------------------------------------------------------------------------------------------------
// Server-sent events: a reader, and checks of the shape of what a server sent
// ---------------------------------------------------------------------------------------------------------------------
/** Splits an SSE body into events { event, data, json } (json is undefined when data is not JSON, as for [DONE]). Comments are skipped. */
export function parseSse(text) {
  const events = [];
  for (const block of String(text).split(/\r?\n\r?\n/)) {
    if (!block.trim()) continue;
    let event = null;
    const data = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith(':')) continue;
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (event === null && !data.length) continue;
    const raw = data.join('\n');
    let json;
    try { json = JSON.parse(raw); } catch { /* [DONE] and other non-JSON data */ }
    events.push({ event, data: raw, json });
  }
  return events;
}

const joinsToObject = (parts) => { try { return isObject(JSON.parse(parts.join(''))); } catch { return false; } };

// Reference readers: what a client that follows the documentation builds from a stream. Tests compare them with the JSON answer.
export function accumulateChatStream(events) {
  const message = { role: 'assistant', content: '', tool_calls: [] };
  const calls = new Map();
  let finishReason = null;
  let usage = null;
  for (const event of events) {
    if (event.data === '[DONE]' || !isObject(event.json)) continue;
    if (event.json.usage) usage = event.json.usage;
    const choice = event.json.choices?.[0];
    if (!choice) continue;
    if (typeof choice.delta?.content === 'string') message.content += choice.delta.content;
    if (typeof choice.delta?.reasoning_content === 'string') message.reasoning_content = (message.reasoning_content ?? '') + choice.delta.reasoning_content;
    for (const fragment of choice.delta?.tool_calls ?? []) {
      const call = calls.get(fragment.index) ?? { id: fragment.id, type: 'function', function: { name: fragment.function?.name, arguments: '' } };
      if (fragment.function?.arguments) call.function.arguments += fragment.function.arguments;
      calls.set(fragment.index, call);
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  }
  message.tool_calls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => call);
  return { message, finish_reason: finishReason, usage };
}

export function accumulateAnthropicStream(events) {
  const message = { content: [], stop_reason: null, usage: {} };
  const blocks = new Map();
  for (const { json } of events) {
    if (!isObject(json)) continue;
    if (json.type === 'message_start') { Object.assign(message, { id: json.message.id, role: json.message.role, model: json.message.model }); message.usage = { ...json.message.usage }; }
    else if (json.type === 'content_block_start') blocks.set(json.index, { ...json.content_block, partial: [] });
    else if (json.type === 'content_block_delta') {
      const block = blocks.get(json.index);
      const delta = json.delta;
      if (delta.type === 'text_delta') block.text += delta.text;
      else if (delta.type === 'thinking_delta') block.thinking += delta.thinking;
      else if (delta.type === 'signature_delta') block.signature = delta.signature;
      else if (delta.type === 'input_json_delta') block.partial.push(delta.partial_json);
    } else if (json.type === 'content_block_stop') {
      const block = blocks.get(json.index);
      // JSON that does not parse is a call the output limit cut off: its input stays {}, as in the JSON answer.
      if (block.type === 'tool_use') { try { block.input = JSON.parse(block.partial.join('') || '{}'); } catch { block.input = {}; } }
      delete block.partial;
      message.content[json.index] = block;
    } else if (json.type === 'message_delta') { message.stop_reason = json.delta.stop_reason; Object.assign(message.usage, json.usage); }
  }
  return message;
}

/** The terminal event carries the authoritative response (that is also how respondOpenAIResponses reads it). */
export function accumulateResponsesStream(events) {
  return events.findLast((event) => ['response.completed', 'response.incomplete', 'response.failed'].includes(event.event))?.json?.response ?? null;
}

export function validateChatStream(events, { includeUsage = false } = {}) {
  const c = collector();
  const rule = 'chat.stream_shape';
  const done = events.findIndex((event) => event.data === '[DONE]');
  if (done !== events.length - 1) c.add(rule, 'the stream must end with [DONE], exactly once');
  let finished = false;
  let finishReason = null;
  let usage = false;
  let first = true;
  const calls = new Map();
  events.forEach((event, i) => {
    if (event.data === '[DONE]') return;
    const chunk = event.json;
    if (!isObject(chunk) || chunk.object !== 'chat.completion.chunk' || !Array.isArray(chunk.choices)) { c.add(rule, `event ${i} is not a chat.completion.chunk`); return; }
    if (usage) c.add(rule, `event ${i} comes after the usage chunk`);
    if (chunk.choices.length === 0) {
      if (!isObject(chunk.usage)) c.add(rule, `event ${i} has no choices and no usage`);
      else usage = true;
      if (!finished) c.add(rule, `the usage chunk (event ${i}) comes before the chunk with finish_reason`);
      return;
    }
    if (chunk.usage) c.add(rule, `event ${i}: usage on a chunk that has choices`);
    const choice = chunk.choices[0];
    if (finished) c.add(rule, `event ${i}: a delta after finish_reason`);
    if (first && choice.delta?.role !== 'assistant') c.add(rule, 'the first chunk must carry delta.role "assistant"');
    first = false;
    for (const fragment of choice.delta?.tool_calls ?? []) {
      if (!Number.isInteger(fragment.index)) { c.add(rule, `event ${i}: a tool call fragment without an index`); continue; }
      let call = calls.get(fragment.index);
      if (!call) {
        if (!isNonEmptyText(fragment.id) || !isNonEmptyText(fragment.function?.name)) c.add(rule, `event ${i}: the first fragment of tool call ${fragment.index} must carry id and function.name`);
        call = { arguments: [] };
        calls.set(fragment.index, call);
      } else if (fragment.id !== undefined || fragment.function?.name !== undefined) c.add(rule, `event ${i}: a later fragment of tool call ${fragment.index} repeats id or name`);
      if (fragment.function?.arguments !== undefined) call.arguments.push(fragment.function.arguments);
    }
    if (choice.finish_reason !== null && choice.finish_reason !== undefined) { finished = true; finishReason = choice.finish_reason; }
  });
  if (!finished) c.add(rule, 'no chunk carries finish_reason');
  // A call that the output limit cut off ends in the middle of its JSON: that is what finish_reason "length" means.
  if (finishReason !== 'length') for (const [index, call] of calls) if (!joinsToObject(call.arguments)) c.add(rule, `the arguments of tool call ${index} are not a JSON object when the fragments are joined`);
  if (includeUsage && !usage) c.add(rule, 'stream_options.include_usage was set but the stream has no usage chunk');
  if (!includeUsage && usage) c.add(rule, 'the stream has a usage chunk although stream_options.include_usage was not set');
  return c.result();
}

export function validateAnthropicStream(events) {
  const c = collector();
  const rule = 'anthropic.stream_shape';
  const frames = events.filter((event) => event.event !== 'ping');
  if (frames[0]?.event !== 'message_start') c.add(rule, 'the stream must begin with message_start');
  else if (frames[0].json?.message?.role !== 'assistant' || !Array.isArray(frames[0].json?.message?.content)) c.add(rule, 'message_start must carry an assistant message with an empty content list');
  const blocks = new Map();
  const unjoined = [];
  let stopReason = null;
  let open = null;
  let next = 0;
  let delta = false;
  let stopped = false;
  frames.forEach((event, i) => {
    const json = event.json;
    if (event.event === 'error') { c.add(rule, `the stream carries an error event: ${event.data.slice(0, 120)}`); return; }
    if (!isObject(json) || json.type !== event.event) { c.add(rule, `event ${i}: the event name "${event.event}" does not match the type in its data`); return; }
    if (stopped) c.add(rule, `event ${i} comes after message_stop`);
    if (event.event === 'content_block_start') {
      if (open !== null) c.add(rule, `event ${i}: content_block_start while block ${open} is still open`);
      if (json.index !== next) c.add(rule, `event ${i}: block index ${json.index}, expected ${next}`);
      blocks.set(json.index, { type: json.content_block?.type, parts: [], signature: false });
      open = json.index;
      next = json.index + 1;
    } else if (event.event === 'content_block_delta') {
      const block = blocks.get(json.index);
      if (!block || open !== json.index) { c.add(rule, `event ${i}: content_block_delta for block ${json.index} before content_block_start (or after its stop)`); return; }
      const expected = { text: ['text_delta'], tool_use: ['input_json_delta'], thinking: ['thinking_delta', 'signature_delta'] }[block.type];
      if (!expected || !expected.includes(json.delta?.type)) c.add(rule, `event ${i}: a ${json.delta?.type} delta for a ${block.type} block`);
      if (json.delta?.type === 'input_json_delta') block.parts.push(json.delta.partial_json ?? '');
      if (json.delta?.type === 'signature_delta') block.signature = true;
    } else if (event.event === 'content_block_stop') {
      const block = blocks.get(json.index);
      if (!block || open !== json.index) { c.add(rule, `event ${i}: content_block_stop for block ${json.index} that is not open`); return; }
      if (block.type === 'thinking' && !block.signature) c.add(rule, `block ${json.index} is a thinking block closed without a signature_delta`);
      if (block.type === 'tool_use' && !joinsToObject(block.parts)) unjoined.push(json.index);
      open = null;
    } else if (event.event === 'message_delta') {
      if (open !== null) c.add(rule, `event ${i}: message_delta while block ${open} is open`);
      if (!isNonEmptyText(json.delta?.stop_reason)) c.add(rule, `event ${i}: message_delta without delta.stop_reason`);
      else stopReason = json.delta.stop_reason;
      if (!Number.isInteger(json.usage?.output_tokens)) c.add(rule, `event ${i}: message_delta without usage.output_tokens`);
      delta = true;
    } else if (event.event === 'message_stop') {
      if (!delta) c.add(rule, 'message_stop before any message_delta');
      stopped = true;
    }
  });
  // A tool_use block that the output limit cut off ends in the middle of its JSON: that is what stop_reason "max_tokens" means.
  if (stopReason !== 'max_tokens') for (const index of unjoined) c.add(rule, `the partial_json fragments of block ${index} do not join into a JSON object`);
  if (!stopped) c.add(rule, 'the stream must end with message_stop');
  return c.result();
}

export function validateResponsesStream(events) {
  const c = collector();
  const rule = 'responses.stream_shape';
  if (events[0]?.event !== 'response.created') c.add(rule, 'the stream must begin with response.created');
  const items = new Map();
  let sequence = -1;
  let terminal = null;
  events.forEach((event, i) => {
    const json = event.json;
    if (!isObject(json) || json.type !== event.event) { c.add(rule, `event ${i}: the event name "${event.event}" does not match the type in its data`); return; }
    if (!Number.isInteger(json.sequence_number) || json.sequence_number <= sequence) c.add(rule, `event ${i}: sequence_number ${json.sequence_number} does not increase (previous ${sequence})`);
    else sequence = json.sequence_number;
    if (terminal) c.add(rule, `event ${i} comes after the terminal event`);
    if (event.event === 'response.output_item.added') {
      items.set(json.item?.id, { index: json.output_index, type: json.item?.type, text: new Map(), args: [], summary: new Map() });
    } else if (['response.output_text.delta', 'response.function_call_arguments.delta', 'response.reasoning_summary_text.delta'].includes(event.event)) {
      const item = items.get(json.item_id);
      if (!item) { c.add(rule, `event ${i}: a delta for item ${json.item_id}, which was never added`); return; }
      if (event.event === 'response.output_text.delta') item.text.set(json.content_index, (item.text.get(json.content_index) ?? '') + json.delta);
      else if (event.event === 'response.function_call_arguments.delta') item.args.push(json.delta);
      else item.summary.set(json.summary_index, (item.summary.get(json.summary_index) ?? '') + json.delta);
    } else if (['response.completed', 'response.incomplete', 'response.failed'].includes(event.event)) {
      terminal = event;
      const output = json.response?.output;
      if (!Array.isArray(output)) c.add(rule, `event ${i}: the terminal response has no output list`);
      else for (const [id, streamed] of items) {
        const final = output.find((item) => item?.id === id);
        if (!final) { c.add(rule, `the terminal response has no item ${id} that was streamed`); continue; }
        if (final.type === 'message') {
          (final.content ?? []).forEach((part, k) => { if (part?.type === 'output_text' && streamed.text.has(k) && part.text !== streamed.text.get(k)) c.add(rule, `item ${id}: the text of the completed response differs from the streamed deltas`); });
        } else if (final.type === 'function_call' && streamed.args.length && final.arguments !== streamed.args.join('')) {
          c.add(rule, `item ${id}: the arguments of the completed response differ from the streamed deltas`);
        } else if (final.type === 'reasoning') {
          (final.summary ?? []).forEach((part, k) => { if (streamed.summary.has(k) && part?.text !== streamed.summary.get(k)) c.add(rule, `item ${id}: the summary of the completed response differs from the streamed deltas`); });
        }
      }
    }
  });
  if (!terminal) c.add(rule, 'the stream has no terminal event (response.completed, response.incomplete or response.failed)');
  else if (terminal !== events.at(-1)) c.add(rule, 'the terminal event is not the last event');
  return c.result();
}
