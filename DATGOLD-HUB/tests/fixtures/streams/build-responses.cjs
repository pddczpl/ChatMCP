// Writes the OpenAI Responses stream fixtures: node build-responses.cjs [outDir]  (default: the folder this file is in)
// Each fixture is a stream (.sse, `POST /v1/responses` with `stream: true`) in the shape of the Responses API (https://platform.openai.com/docs/api-reference/responses-streaming) and the plain
// response of the SAME answer, which is the object the terminal event (`response.completed`, `.incomplete`, `.failed`) carries. Both are written from one plan, here. They are written from the
// documentation and from what gateways are known to send, NOT recorded from an account.
const fs = require('node:fs');
const path = require('node:path');
const out = process.argv[2] ?? __dirname;
fs.mkdirSync(path.join(out, 'responses'), { recursive: true });

const pieces = (text, size) => { const list = []; const chars = [...text]; for (let i = 0; i < chars.length; i += size) list.push(chars.slice(i, i + size).join('')); return list; };
const fixtures = [];
const CREATED = 1760000000;

function make(name, source, { id, model = 'gpt-5-mini', items, status = 'completed', incomplete = null, failure = null, usage }) {
  let sequence = 0;
  const event = (type, body) => `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: (sequence += 1) - 1, ...body })}\n\n`;
  const shell = (state, output) => ({
    id, object: 'response', created_at: CREATED, status: state, background: false, error: state === 'failed' ? failure : null, incomplete_details: state === 'incomplete' ? incomplete : null,
    instructions: null, max_output_tokens: 16384, model, output, parallel_tool_calls: false, previous_response_id: null, store: false, tool_choice: 'auto', tools: [],
    ...(state === 'in_progress' ? {} : { usage }),
  });
  let text = event('response.created', { response: shell('in_progress', []) }) + event('response.in_progress', { response: shell('in_progress', []) });
  const done = [];
  let visible = '';
  const calls = [];
  items.forEach((item, index) => {
    if (item.kind === 'message' || item.kind === 'refusal') {
      const itemId = `msg_${id}_${index}`;
      const refusal = item.kind === 'refusal';
      const body = refusal ? item.refusal : item.text;
      text += event('response.output_item.added', { output_index: index, item: { id: itemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] } });
      text += event('response.content_part.added', { item_id: itemId, output_index: index, content_index: 0, part: refusal ? { type: 'refusal', refusal: '' } : { type: 'output_text', text: '', annotations: [] } });
      for (const piece of pieces(body, item.size ?? 9)) text += event(refusal ? 'response.refusal.delta' : 'response.output_text.delta', { item_id: itemId, output_index: index, content_index: 0, delta: piece });
      const part = refusal ? { type: 'refusal', refusal: body } : { type: 'output_text', text: body, annotations: [] };
      text += event(refusal ? 'response.refusal.done' : 'response.output_text.done', { item_id: itemId, output_index: index, content_index: 0, ...(refusal ? { refusal: body } : { text: body }) });
      text += event('response.content_part.done', { item_id: itemId, output_index: index, content_index: 0, part });
      const finished = { id: itemId, type: 'message', status: 'completed', role: 'assistant', content: [part] };
      text += event('response.output_item.done', { output_index: index, item: finished });
      done.push(finished);
      if (!refusal) visible += body;
    } else if (item.kind === 'call') {
      const itemId = `fc_${id}_${index}`;
      const args = JSON.stringify(item.args);
      text += event('response.output_item.added', { output_index: index, item: { id: itemId, type: 'function_call', status: 'in_progress', arguments: '', call_id: item.callId, name: item.name } });
      for (const piece of pieces(args, item.size ?? 7)) text += event('response.function_call_arguments.delta', { item_id: itemId, output_index: index, delta: piece });
      text += event('response.function_call_arguments.done', { item_id: itemId, output_index: index, arguments: args });
      const finished = { id: itemId, type: 'function_call', status: 'completed', arguments: args, call_id: item.callId, name: item.name };
      text += event('response.output_item.done', { output_index: index, item: finished });
      done.push(finished);
      calls.push({ name: item.name, arguments: args });
    } else if (item.kind === 'reasoning') {
      const itemId = `rs_${id}_${index}`;
      text += event('response.output_item.added', { output_index: index, item: { id: itemId, type: 'reasoning', summary: [] } });
      text += event('response.reasoning_summary_part.added', { item_id: itemId, output_index: index, summary_index: 0, part: { type: 'summary_text', text: '' } });
      for (const piece of pieces(item.summary, 11)) text += event('response.reasoning_summary_text.delta', { item_id: itemId, output_index: index, summary_index: 0, delta: piece });
      text += event('response.reasoning_summary_text.done', { item_id: itemId, output_index: index, summary_index: 0, text: item.summary });
      text += event('response.reasoning_summary_part.done', { item_id: itemId, output_index: index, summary_index: 0, part: { type: 'summary_text', text: item.summary } });
      const finished = { id: itemId, type: 'reasoning', summary: [{ type: 'summary_text', text: item.summary }], encrypted_content: item.encrypted };
      text += event('response.output_item.done', { output_index: index, item: finished });
      done.push(finished);
    }
  });
  const terminal = status === 'completed' ? 'response.completed' : status === 'incomplete' ? 'response.incomplete' : 'response.failed';
  const response = shell(status, done);
  text += event(terminal, { response });
  fs.writeFileSync(path.join(out, 'responses', `${name}.sse`), text);
  fixtures.push({ name, file: `responses/${name}.sse`, source, strict: true, response, summary: { status, text: visible, calls, error: status !== 'completed' } });
}

const ENCRYPTED = 'gAAAAABo_encrypted_reasoning_state_0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ==';

make('text', 'Responses: a message in fragments, usage with cached tokens, response.completed', {
  id: 'resp_text_0001', usage: { input_tokens: 36, input_tokens_details: { cached_tokens: 0 }, output_tokens: 24, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 60 },
  items: [{ kind: 'message', text: 'Xin chào! Đây là một câu trả lời được truyền theo từng mảnh. 😀' }],
});
make('function-call', 'Responses: a short message, then a function_call whose arguments arrive in fragments', {
  id: 'resp_call_0001', usage: { input_tokens: 148, input_tokens_details: { cached_tokens: 64 }, output_tokens: 31, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 179 },
  items: [{ kind: 'message', text: 'Để tôi đọc tệp.' }, { kind: 'call', name: 'read_file', callId: 'call_read_0001', args: { path: 'README.md', max_lines: 40 } }],
});
make('two-calls', 'Responses: two function_call items in one turn, in output order', {
  id: 'resp_two_0001', usage: { input_tokens: 160, input_tokens_details: { cached_tokens: 0 }, output_tokens: 52, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 212 },
  items: [{ kind: 'call', name: 'read_file', callId: 'call_a_0001', args: { path: 'a.txt' } }, { kind: 'call', name: 'read_file', callId: 'call_b_0001', args: { path: 'b.txt' } }],
});
make('reasoning-call', 'Responses with store: false: a reasoning item with encrypted_content (asked for with include), a summary in fragments, then a function_call', {
  id: 'resp_reason_0001', usage: { input_tokens: 190, input_tokens_details: { cached_tokens: 128 }, output_tokens: 120, output_tokens_details: { reasoning_tokens: 96 }, total_tokens: 310 },
  items: [{ kind: 'reasoning', summary: 'I should read the file before changing it.', encrypted: ENCRYPTED }, { kind: 'call', name: 'read_file', callId: 'call_reason_0001', args: { path: 'src/main.rs' } }],
});
make('reasoning-text', 'Responses: reasoning, then the final message', {
  id: 'resp_reasontext_0001', usage: { input_tokens: 210, input_tokens_details: { cached_tokens: 0 }, output_tokens: 88, output_tokens_details: { reasoning_tokens: 64 }, total_tokens: 298 },
  items: [{ kind: 'reasoning', summary: 'The result is already in the tool output.', encrypted: ENCRYPTED }, { kind: 'message', text: 'Xong: tệp có 42 dòng.' }],
});
make('no-args-call', 'Responses: a function_call with empty arguments', {
  id: 'resp_noargs_0001', usage: { input_tokens: 120, input_tokens_details: { cached_tokens: 0 }, output_tokens: 12, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 132 },
  items: [{ kind: 'call', name: 'list_files', callId: 'call_noargs_0001', args: {} }],
});
make('refusal', 'Responses: the model refuses (a refusal content part)', {
  id: 'resp_refusal_0001', usage: { input_tokens: 40, input_tokens_details: { cached_tokens: 0 }, output_tokens: 14, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 54 },
  items: [{ kind: 'refusal', refusal: 'Tôi không thể giúp với yêu cầu này.' }],
});
make('incomplete', 'Responses: the output limit is reached (response.incomplete, max_output_tokens), with a function_call that was cut off', {
  id: 'resp_incomplete_0001', status: 'incomplete', incomplete: { reason: 'max_output_tokens' },
  usage: { input_tokens: 150, input_tokens_details: { cached_tokens: 0 }, output_tokens: 16384, output_tokens_details: { reasoning_tokens: 16000 }, total_tokens: 16534 },
  items: [{ kind: 'message', text: 'The answer is cut o' }],
});
make('failed', 'Responses: the provider fails after the stream began (response.failed with an error object)', {
  id: 'resp_failed_0001', status: 'failed', failure: { code: 'server_error', message: 'The server had an error while processing your request.' },
  usage: { input_tokens: 150, input_tokens_details: { cached_tokens: 0 }, output_tokens: 0, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 150 },
  items: [{ kind: 'message', text: 'Partial text before the failure.' }],
});

fs.writeFileSync(path.join(out, 'responses.json'), JSON.stringify({ about: 'OpenAI Responses stream fixtures, written by build-responses.cjs from one plan per stream; the plain response of each answer is the object its terminal event carries. Not recorded from an account.', fixtures }, null, 2) + '\n');
console.log(`${fixtures.length} Responses streams written to ${out}`);
