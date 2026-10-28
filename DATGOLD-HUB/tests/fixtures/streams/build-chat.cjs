// Writes the Chat Completions stream fixtures: node build-chat.cjs [outDir]  (default: the folder this file is in)
// Each fixture is a stream (.sse) in the shape the named server is documented or reported to send, and the plain (non-streaming) completion of the SAME message. The two
// are written from one plan, here, so what the test compares is two spellings of one answer and not the output of the code under test.
const fs = require('node:fs');
const path = require('node:path');
const out = process.argv[2] ?? __dirname;
fs.mkdirSync(path.join(out, 'chat'), { recursive: true });

const frame = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const comment = (text) => `: ${text}\n\n`;
const pieces = (text, size) => { const list = []; const chars = [...text]; for (let i = 0; i < chars.length; i += size) list.push(chars.slice(i, i + size).join('')); return list; };

const fixtures = [];
const add = (fixture) => fixtures.push(fixture);
const write = (name, text) => fs.writeFileSync(path.join(out, 'chat', `${name}.sse`), text);

/** The plain completion of a plan. */
const completionOf = (base, plan) => {
  const message = { role: 'assistant', content: plan.text ?? null };
  if (plan.reasoning) message.reasoning_content = plan.reasoning;
  if (plan.refusal) message.refusal = plan.refusal;
  if (plan.calls?.length) message.tool_calls = plan.calls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } }));
  const completion = { id: base.id, object: 'chat.completion', created: base.created, model: base.model, choices: [{ index: 0, message, finish_reason: plan.finish }] };
  if (plan.usage) completion.usage = plan.usage;
  return completion;
};
const summaryOf = (plan) => ({
  status: plan.finish === 'length' || plan.finish === 'content_filter' ? 'incomplete' : 'completed',
  text: plan.text ?? '',
  reasoning: plan.reasoning ?? '',
  refusal: plan.refusal ?? '',
  calls: (plan.calls ?? []).map((call) => ({ id: call.id ?? null, name: call.name, arguments: call.arguments })),
  usage: plan.usage ? { input_tokens: plan.usage.prompt_tokens, output_tokens: plan.usage.completion_tokens } : { input_tokens: null, output_tokens: null },
});

// ---------------------------------------------------------------------------------------------------------------- OpenAI: plain text, usage chunk
{
  const base = { id: 'chatcmpl-Bq3VtM2kUhN0WgPzXyEoA1sD', object: 'chat.completion.chunk', created: 1760000000, model: 'gpt-5-mini-2025-08-07', service_tier: 'default', system_fingerprint: null };
  const plan = { text: 'Xin chào! Đây là một câu trả lời được truyền theo từng mảnh. 😀', finish: 'stop', usage: { prompt_tokens: 24, completion_tokens: 17, total_tokens: 41, prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 } } };
  const chunk = (delta, finish = null) => frame({ ...base, choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }], obfuscation: 'Q1' });
  let text = chunk({ role: 'assistant', content: '', refusal: null });
  for (const piece of pieces(plan.text, 9)) text += chunk({ content: piece });
  text += chunk({}, 'stop');
  text += frame({ ...base, choices: [], usage: plan.usage });
  text += 'data: [DONE]\n\n';
  write('openai-text', text);
  add({ name: 'openai-text', file: 'chat/openai-text.sse', source: 'OpenAI Chat Completions: a plain answer with stream_options.include_usage (shape of the API reference)', strict: true, includeUsage: true, completion: completionOf(base, plan), summary: summaryOf(plan) });
}

// ---------------------------------------------------------------------------------------------------------------- OpenAI: two tool calls, cached tokens
{
  const base = { id: 'chatcmpl-Bq3WxH7yTnR2LkPaVbCdEfGh', object: 'chat.completion.chunk', created: 1760000100, model: 'gpt-5-mini-2025-08-07', service_tier: 'default', system_fingerprint: null };
  const calls = [
    { id: 'call_7GkVx2NwQpR4sTyU8iOaBc3d', name: 'read_file', arguments: '{"path":"README.md"}' },
    { id: 'call_Hq9ZfLm5JtW1eXvYb6NrCo0A', name: 'read_file', arguments: '{"path":"docs/ARCHITECTURE.md","max_lines":120}' },
  ];
  const plan = { text: null, calls, finish: 'tool_calls', usage: { prompt_tokens: 311, completion_tokens: 48, total_tokens: 359, prompt_tokens_details: { cached_tokens: 256, audio_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 } } };
  const chunk = (delta, finish = null) => frame({ ...base, choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }], obfuscation: 'Q2' });
  let text = chunk({ role: 'assistant', content: null, refusal: null });
  calls.forEach((call, index) => {
    text += chunk({ tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.name, arguments: '' } }] });
    for (const piece of pieces(call.arguments, 6)) text += chunk({ tool_calls: [{ index, function: { arguments: piece } }] });
  });
  text += chunk({}, 'tool_calls');
  text += frame({ ...base, choices: [], usage: plan.usage });
  text += 'data: [DONE]\n\n';
  write('openai-tools', text);
  add({ name: 'openai-tools', file: 'chat/openai-tools.sse', source: 'OpenAI Chat Completions: two tool calls whose arguments arrive in fragments, cached prompt tokens in the usage chunk', strict: true, includeUsage: true, completion: completionOf(base, plan), summary: summaryOf(plan) });
}

// ---------------------------------------------------------------------------------------------------------------- OpenRouter: keep-alive comments, provider, cost
{
  const base = { id: 'gen-1760000200-aBcDeFgHiJkLmNoPqRsT', provider: 'OpenAI', model: 'openai/gpt-5-mini', object: 'chat.completion.chunk', created: 1760000200 };
  const plan = { text: 'The build passed. Three files changed: lib/sse.mjs, tests/verify-sse.mjs and docs/DEVELOPMENT.md.', finish: 'stop', usage: { prompt_tokens: 58, completion_tokens: 30, total_tokens: 88, cost: 0.0000755, is_byok: false, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } } };
  const chunk = (delta, finish = null, extra = {}) => frame({ ...base, choices: [{ index: 0, delta, finish_reason: finish, native_finish_reason: finish, logprobs: null }], ...extra });
  let text = comment('OPENROUTER PROCESSING') + comment('OPENROUTER PROCESSING');
  text += chunk({ role: 'assistant', content: '' });
  text += comment('OPENROUTER PROCESSING');
  for (const piece of pieces(plan.text, 14)) text += chunk({ role: 'assistant', content: piece });
  text += chunk({ role: 'assistant', content: '' }, 'stop');
  text += frame({ ...base, choices: [], usage: plan.usage });
  text += 'data: [DONE]\n\n';
  write('openrouter-text', text);
  add({ name: 'openrouter-text', file: 'chat/openrouter-text.sse', source: 'OpenRouter: processing comments before and inside the stream, provider and native_finish_reason fields, usage with cost', strict: false, includeUsage: true, completion: completionOf(base, plan), summary: summaryOf(plan) });
}

// ---------------------------------------------------------------------------------------------------------------- DeepSeek: reasoning_content, usage on the last chunk
{
  const base = { id: '5b0d7e9c-6f1a-4c2e-8d3b-9a4f2e1c7b60', object: 'chat.completion.chunk', created: 1760000300, model: 'deepseek-v4-flash', system_fingerprint: 'fp_deepseek_v4' };
  const plan = {
    reasoning: 'Người dùng hỏi về tệp cấu hình. Cần đọc package.json trước khi trả lời.', text: 'Tệp package.json khai báo hai script: build và test.', finish: 'stop',
    usage: { prompt_tokens: 40, completion_tokens: 61, total_tokens: 101, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 29 }, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 40 },
  };
  const chunk = (delta, finish = null, extra = {}) => frame({ ...base, choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }], ...extra });
  let text = chunk({ role: 'assistant', content: null, reasoning_content: '' });
  for (const piece of pieces(plan.reasoning, 12)) text += chunk({ content: null, reasoning_content: piece });
  for (const piece of pieces(plan.text, 11)) text += chunk({ content: piece, reasoning_content: null });
  text += chunk({ content: '', reasoning_content: null }, 'stop', { usage: plan.usage });
  text += 'data: [DONE]\n\n';
  write('deepseek-reasoning', text);
  add({ name: 'deepseek-reasoning', file: 'chat/deepseek-reasoning.sse', source: 'DeepSeek thinking mode: reasoning_content deltas before the answer, usage on the chunk that carries finish_reason', strict: false, includeUsage: false, completion: completionOf(base, plan), summary: summaryOf(plan) });
}

// ---------------------------------------------------------------------------------------------------------------- DeepSeek: reasoning, then a tool call
{
  const base = { id: '0c9e1f77-aa21-4b6d-9a5e-3c8d7f2b1e44', object: 'chat.completion.chunk', created: 1760000400, model: 'deepseek-v4-flash', system_fingerprint: 'fp_deepseek_v4' };
  const calls = [{ id: 'call_00_Zk3QmWvXyTnR8sLpHb2CdEfG', name: 'list_dir', arguments: '{"path":"lib"}' }];
  const plan = {
    reasoning: 'Cần xem thư mục lib trước.', text: null, calls, finish: 'tool_calls',
    usage: { prompt_tokens: 77, completion_tokens: 22, total_tokens: 99, prompt_tokens_details: { cached_tokens: 64 }, completion_tokens_details: { reasoning_tokens: 9 }, prompt_cache_hit_tokens: 64, prompt_cache_miss_tokens: 13 },
  };
  const chunk = (delta, finish = null, extra = {}) => frame({ ...base, choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }], ...extra });
  let text = chunk({ role: 'assistant', content: null, reasoning_content: '' });
  for (const piece of pieces(plan.reasoning, 9)) text += chunk({ content: null, reasoning_content: piece });
  text += chunk({ content: null, reasoning_content: null, tool_calls: [{ index: 0, id: calls[0].id, type: 'function', function: { name: calls[0].name, arguments: '' } }] });
  for (const piece of pieces(calls[0].arguments, 5)) text += chunk({ content: null, reasoning_content: null, tool_calls: [{ index: 0, function: { arguments: piece } }] });
  text += chunk({ content: '', reasoning_content: null }, 'tool_calls', { usage: plan.usage });
  text += 'data: [DONE]\n\n';
  write('deepseek-reasoning-tool', text);
  add({ name: 'deepseek-reasoning-tool', file: 'chat/deepseek-reasoning-tool.sse', source: 'DeepSeek thinking mode with a tool call: the reasoning text travels with the first item of the turn (it is sent back between tool calls)', strict: false, includeUsage: false, completion: completionOf(base, plan), summary: summaryOf(plan) });
}

// ---------------------------------------------------------------------------------------------------------------- Ollama (older): a whole call in one chunk, no index, finish_reason stop
{
  const base = { id: 'chatcmpl-418', object: 'chat.completion.chunk', created: 1760000500, model: 'qwen3:8b', system_fingerprint: 'fp_ollama' };
  const calls = [{ id: 'call_a1b2c3d4', name: 'read_file', arguments: '{"path":"main.py"}' }];
  const plan = { text: null, calls, finish: 'stop' };
  let text = frame({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '', tool_calls: [{ id: calls[0].id, type: 'function', function: { name: calls[0].name, arguments: calls[0].arguments } }] }, finish_reason: null }] });
  text += frame({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: 'stop' }] });
  text += 'data: [DONE]\n\n';
  write('ollama-tool-no-index', text);
  add({ name: 'ollama-tool-no-index', file: 'chat/ollama-tool-no-index.sse', source: 'Ollama (OpenAI compatibility, older builds): the whole call in one chunk, no index, finish_reason "stop" although a tool was called, no usage', strict: false, includeUsage: false, completion: completionOf(base, plan), summary: summaryOf(plan) });
}

// ---------------------------------------------------------------------------------------------------------------- Ollama (newer): text, with usage
{
  const base = { id: 'chatcmpl-702', object: 'chat.completion.chunk', created: 1760000550, model: 'llama3.2:3b', system_fingerprint: 'fp_ollama' };
  const plan = { text: 'Hello! Streaming from a local model works.', finish: 'stop', usage: { prompt_tokens: 31, completion_tokens: 9, total_tokens: 40 } };
  const chunk = (delta, finish = null) => frame({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] });
  let text = '';
  for (const piece of pieces(plan.text, 7)) text += chunk({ role: 'assistant', content: piece });
  text += chunk({ role: 'assistant', content: '' }, 'stop');
  text += frame({ ...base, choices: [], usage: plan.usage });
  text += 'data: [DONE]\n\n';
  write('ollama-text', text);
  add({ name: 'ollama-text', file: 'chat/ollama-text.sse', source: 'Ollama (OpenAI compatibility): no role-only first chunk, role on every chunk, a usage chunk', strict: false, includeUsage: true, completion: completionOf(base, plan), summary: summaryOf(plan) });
}

// ---------------------------------------------------------------------------------------------------------------- LM Studio: a call whose arguments come in pieces
{
  const base = { id: 'chatcmpl-8dj0v3xqk9n1w2e5r7t6y', object: 'chat.completion.chunk', created: 1760000600, model: 'qwen2.5-coder-7b-instruct' , system_fingerprint: 'qwen2.5-coder-7b-instruct' };
  const calls = [{ id: '379615821', name: 'write_file', arguments: '{"path":"notes.txt","content":"dòng 1\\ndòng 2"}' }];
  const plan = { text: null, calls, finish: 'tool_calls', usage: { prompt_tokens: 120, completion_tokens: 35, total_tokens: 155 } };
  const chunk = (delta, finish = null) => frame({ ...base, choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }] });
  let text = chunk({ role: 'assistant', content: '' });
  text += chunk({ tool_calls: [{ index: 0, id: calls[0].id, type: 'function', function: { name: calls[0].name, arguments: '' } }] });
  for (const piece of pieces(calls[0].arguments, 8)) text += chunk({ tool_calls: [{ index: 0, function: { arguments: piece } }] });
  text += chunk({}, 'tool_calls');
  text += frame({ ...base, choices: [], usage: plan.usage, stats: {} });
  text += 'data: [DONE]\n\n';
  write('lmstudio-tool', text);
  add({ name: 'lmstudio-tool', file: 'chat/lmstudio-tool.sse', source: 'LM Studio: a numeric string as call id, arguments with escaped line breaks in pieces, a usage chunk with stats', strict: false, includeUsage: true, completion: completionOf(base, plan), summary: summaryOf(plan) });
}

// ---------------------------------------------------------------------------------------------------------------- vLLM: text, no usage chunk
{
  const base = { id: 'chatcmpl-9f3b1d6a2c8e4f7a8b5c0d1e2f3a4b5c', object: 'chat.completion.chunk', created: 1760000700, model: 'Qwen/Qwen3-Coder-30B-A3B-Instruct' };
  const plan = { text: 'Chạy `node tests/verify-sse.mjs` để kiểm tra bộ đọc SSE.', finish: 'stop' };
  const chunk = (delta, finish = null) => frame({ ...base, choices: [{ index: 0, delta, logprobs: null, finish_reason: finish, stop_reason: null }], usage: null });
  let text = chunk({ role: 'assistant', content: '' });
  for (const piece of pieces(plan.text, 10)) text += chunk({ content: piece });
  text += chunk({ content: '' }, 'stop');
  text += 'data: [DONE]\n\n';
  write('vllm-text', text);
  add({ name: 'vllm-text', file: 'chat/vllm-text.sse', source: 'vLLM: usage null on every chunk and no usage chunk (stream_options not asked for), stop_reason field', strict: false, includeUsage: false, completion: completionOf(base, plan), summary: summaryOf(plan) });
}

// ---------------------------------------------------------------------------------------------------------------- Azure OpenAI: empty-choices chunk first, content filter fields
{
  const base = { id: 'chatcmpl-AzR0nX5pQwErTyUiOpAsDfGhJkLz', object: 'chat.completion.chunk', created: 1760000800, model: 'gpt-5-mini-2025-08-07', system_fingerprint: 'fp_azure_1' };
  const plan = { text: 'Đã ghi tệp và chạy kiểm tra.', finish: 'stop', usage: { prompt_tokens: 19, completion_tokens: 12, total_tokens: 31 } };
  const filters = { hate: { filtered: false, severity: 'safe' }, self_harm: { filtered: false, severity: 'safe' }, sexual: { filtered: false, severity: 'safe' }, violence: { filtered: false, severity: 'safe' } };
  const chunk = (delta, finish = null) => frame({ ...base, choices: [{ index: 0, delta, finish_reason: finish, content_filter_results: filters }] });
  let text = frame({ id: '', object: '', created: 0, model: '', prompt_filter_results: [{ prompt_index: 0, content_filter_results: filters }], choices: [] });
  text += chunk({ role: 'assistant', content: '' });
  for (const piece of pieces(plan.text, 8)) text += chunk({ content: piece });
  text += chunk({}, 'stop');
  text += frame({ ...base, choices: [], usage: plan.usage });
  text += 'data: [DONE]\n\n';
  write('azure-text', text);
  add({ name: 'azure-text', file: 'chat/azure-text.sse', source: 'Azure OpenAI: a first chunk with no choices (prompt_filter_results), content_filter_results on every choice', strict: false, includeUsage: true, completion: completionOf(base, plan), summary: summaryOf(plan) });
}

// ---------------------------------------------------------------------------------------------------------------- OpenAI: the answer was cut by the output limit
{
  const base = { id: 'chatcmpl-Bq3Y1LengTh0000000000000001', object: 'chat.completion.chunk', created: 1760000900, model: 'gpt-5-mini-2025-08-07', service_tier: 'default', system_fingerprint: null };
  const plan = { text: 'Một câu trả lời rất dài bị cắt giữa chừng bởi giới hạn token đầu r', finish: 'length', usage: { prompt_tokens: 50, completion_tokens: 16, total_tokens: 66 } };
  const chunk = (delta, finish = null) => frame({ ...base, choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }] });
  let text = chunk({ role: 'assistant', content: '' });
  for (const piece of pieces(plan.text, 13)) text += chunk({ content: piece });
  text += chunk({}, 'length');
  text += frame({ ...base, choices: [], usage: plan.usage });
  text += 'data: [DONE]\n\n';
  write('openai-length', text);
  add({ name: 'openai-length', file: 'chat/openai-length.sse', source: 'OpenAI Chat Completions: finish_reason "length": the answer is incomplete and nothing in it is a call', strict: true, includeUsage: true, completion: completionOf(base, plan), summary: summaryOf(plan) });
}

// ---------------------------------------------------------------------------------------------------------------- OpenAI: a refusal
{
  const base = { id: 'chatcmpl-Bq3Z2RefUsaL0000000000000002', object: 'chat.completion.chunk', created: 1760001000, model: 'gpt-5-mini-2025-08-07', service_tier: 'default', system_fingerprint: null };
  const plan = { text: null, refusal: "I'm sorry, I can't help with that request.", finish: 'stop', usage: { prompt_tokens: 28, completion_tokens: 11, total_tokens: 39 } };
  const chunk = (delta, finish = null) => frame({ ...base, choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }] });
  let text = chunk({ role: 'assistant', content: null, refusal: '' });
  for (const piece of pieces(plan.refusal, 12)) text += chunk({ refusal: piece });
  text += chunk({}, 'stop');
  text += frame({ ...base, choices: [], usage: plan.usage });
  text += 'data: [DONE]\n\n';
  write('openai-refusal', text);
  add({ name: 'openai-refusal', file: 'chat/openai-refusal.sse', source: 'OpenAI Chat Completions: the model refused (delta.refusal)', strict: false, includeUsage: true, completion: completionOf(base, plan), summary: summaryOf(plan) });
}

fs.writeFileSync(path.join(out, 'chat.json'), JSON.stringify({ about: 'Chat Completions streams and the plain completion of the same message. Written from one plan by a generator (shape per server as documented or reported), not captured from a live account.', fixtures }, null, 2) + '\n');
console.log(`wrote ${fixtures.length} chat fixtures to ${out}`);
