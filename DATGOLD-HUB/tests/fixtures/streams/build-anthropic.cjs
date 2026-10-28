// Writes the Anthropic Messages stream fixtures: node build-anthropic.cjs [outDir]  (default: the folder this file is in)
// Each fixture is a stream (.sse) in the shape of the streaming documentation (https://platform.claude.com/docs/en/build-with-claude/streaming) and the plain Message of the SAME
// answer. Both are written from one plan, here, so the test compares two spellings of one answer and not the output of the code under test.
const fs = require('node:fs');
const path = require('node:path');
const out = process.argv[2] ?? __dirname;
fs.mkdirSync(path.join(out, 'anthropic'), { recursive: true });

const pieces = (text, size) => { const list = []; const chars = [...text]; for (let i = 0; i < chars.length; i += size) list.push(chars.slice(i, i + size).join('')); return list; };
const fixtures = [];
const SIGNATURE = 'EuYBCkQYAiJAm3F4h2tNn0cVwq6oD9yA1Zb5PxLkS7eRtUiOpAsDfGhJkLzXcVbNm1234567890QwErTyUiOpAsDfGhJkLzXcVbNmQwErTy==';
const REDACTED = 'EmwKAhgBEgy3va3pzix/LafPsn4aDFIT2Xlxh0L5L8rLVyIwxtE3rAFBa8cr3qpPkNRj2YfWXGmKDxH4mPnZ5sQRkpRtZjTqCp9LdYvNeQoUhA6MbVwIsJ3fK1aG2DxE';

/** One scenario: a list of content blocks, a stop reason, usage. Writes both the stream and the plain message. */
function make(name, source, { id, model = 'claude-sonnet-5-5', blocks, stop, usage, startUsage, deltaUsage, strict = true, noPing = false, pace = 8, extraEvents = [] }) {
  const events = [];
  const emit = (event, data) => events.push(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const message = { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: startUsage };
  emit('message_start', { type: 'message_start', message });
  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      emit('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      if (index === 0 && !noPing) emit('ping', { type: 'ping' });
      for (const piece of pieces(block.text, pace)) emit('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: piece } });
    } else if (block.type === 'thinking') {
      emit('content_block_start', { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } });
      if (index === 0 && !noPing) emit('ping', { type: 'ping' });
      for (const piece of pieces(block.thinking, pace)) emit('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: piece } });
      emit('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: block.signature } });
    } else if (block.type === 'redacted_thinking') {
      emit('content_block_start', { type: 'content_block_start', index, content_block: { type: 'redacted_thinking', data: block.data } });
      if (index === 0 && !noPing) emit('ping', { type: 'ping' });
    } else if (block.type === 'tool_use') {
      emit('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
      if (index === 0 && !noPing) emit('ping', { type: 'ping' });
      emit('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: '' } });
      for (const piece of pieces(block.json, 7)) emit('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: piece } });
    }
    emit('content_block_stop', { type: 'content_block_stop', index });
    if (block.pingAfter) emit('ping', { type: 'ping' });
  });
  for (const [event, data] of extraEvents) emit(event, data);
  emit('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: deltaUsage });
  emit('message_stop', { type: 'message_stop' });
  fs.writeFileSync(path.join(out, 'anthropic', `${name}.sse`), events.join(''));

  // the plain message of the same answer: a tool_use block the output limit cut has no input worth keeping
  const cut = stop === 'max_tokens';
  const content = blocks.map((block) => {
    if (block.type === 'text') return { type: 'text', text: block.text };
    if (block.type === 'thinking') return { type: 'thinking', thinking: block.thinking, signature: block.signature };
    if (block.type === 'redacted_thinking') return { type: 'redacted_thinking', data: block.data };
    let input = {};
    if (!cut) input = JSON.parse(block.json || '{}');
    return { type: 'tool_use', id: block.id, name: block.name, input };
  });
  const plain = { id, type: 'message', role: 'assistant', model, content, stop_reason: stop, stop_sequence: null, usage: { ...startUsage, ...deltaUsage } };
  const texts = blocks.filter((block) => block.type === 'text').map((block) => block.text);
  const calls = cut ? [] : blocks.filter((block) => block.type === 'tool_use').map((block) => ({ id: block.id, name: block.name, arguments: JSON.stringify(JSON.parse(block.json || '{}')) }));
  fixtures.push({
    name, file: `anthropic/${name}.sse`, source, strict, message: plain,
    summary: { status: stop === 'max_tokens' || stop === 'pause_turn' ? 'incomplete' : 'completed', text: stop === 'refusal' ? '' : texts.join('\n'), refusal: stop === 'refusal' ? texts.join('\n') : '', calls },
  });
}

make('text', 'Messages API: a plain answer with a ping after the first block starts (the documented example)', {
  id: 'msg_01XFDUDYJgAACzvnptvVoYEL', blocks: [{ type: 'text', text: 'Xin chào! Hôm nay tôi có thể giúp gì cho bạn? 😀' }], stop: 'end_turn',
  startUsage: { input_tokens: 25, output_tokens: 1 }, deltaUsage: { output_tokens: 15 },
});
make('tool-use', 'Messages API: text, then a tool_use block whose input arrives as partial JSON (the documented example)', {
  id: 'msg_014p7gG3wDgGV9EUtLvnow3U', blocks: [
    { type: 'text', text: 'Tôi sẽ đọc tệp đó.' },
    { type: 'tool_use', id: 'toolu_01T1x1fJ34qAmk2tNTrN7Up6', name: 'read_file', json: '{"path":"docs/ARCHITECTURE.md","max_lines":80}' },
  ], stop: 'tool_use', startUsage: { input_tokens: 472, output_tokens: 2 }, deltaUsage: { output_tokens: 89 },
});
make('thinking-tool', 'Messages API with extended thinking: a thinking block with its signature, text, then a tool_use block', {
  id: 'msg_01Aq9w938a90dw8q', blocks: [
    { type: 'thinking', thinking: 'Cần đọc README.md trước, rồi mới trả lời. Hai bước: đọc tệp và tóm tắt.', signature: SIGNATURE },
    { type: 'text', text: 'Để tôi mở README.md.' },
    { type: 'tool_use', id: 'toolu_01WnZ3q9r5LpVxYb2CdEfGhJ', name: 'read_file', json: '{"path":"README.md"}' },
  ], stop: 'tool_use', startUsage: { input_tokens: 1034, output_tokens: 4, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, deltaUsage: { output_tokens: 156 },
});
make('thinking-omitted', 'Messages API with thinking display "omitted": the thinking block has no text, only its signature', {
  id: 'msg_01OmittedThinking00000001', blocks: [
    { type: 'thinking', thinking: '', signature: SIGNATURE },
    { type: 'text', text: 'Đã xong.' },
  ], stop: 'end_turn', startUsage: { input_tokens: 80, output_tokens: 3 }, deltaUsage: { output_tokens: 40 },
});
make('redacted-thinking', 'Messages API: a redacted_thinking block (safety-encrypted), then text', {
  id: 'msg_01RedactedThinking0000001', blocks: [
    { type: 'redacted_thinking', data: REDACTED },
    { type: 'text', text: 'Tôi không thể chia sẻ phần suy nghĩ đó, nhưng đây là kết quả.' },
  ], stop: 'end_turn', startUsage: { input_tokens: 64, output_tokens: 2 }, deltaUsage: { output_tokens: 33 },
});
make('cache-usage', 'Messages API with prompt caching: cache usage in message_start, a cumulative usage in message_delta (the totals replace, they are not added)', {
  id: 'msg_01CacheUsage00000000000001', blocks: [{ type: 'text', text: 'Từ bộ nhớ đệm.' }], stop: 'end_turn',
  startUsage: { input_tokens: 40, cache_creation_input_tokens: 50, cache_read_input_tokens: 300, output_tokens: 1 }, deltaUsage: { input_tokens: 40, cache_creation_input_tokens: 50, cache_read_input_tokens: 300, output_tokens: 20 },
});
make('max-tokens-cut-call', 'Messages API: stop_reason max_tokens in the middle of a tool_use block: its JSON does not parse and no call exists', {
  id: 'msg_01MaxTokensCutCall0000001', blocks: [
    { type: 'text', text: 'Tôi sẽ ghi tệp:' },
    { type: 'tool_use', id: 'toolu_01CutCall00000000000001', name: 'write_file', json: '{"path":"notes.txt","content":"dòng một\\ndòng ha' },
  ], stop: 'max_tokens', startUsage: { input_tokens: 90, output_tokens: 2 }, deltaUsage: { output_tokens: 16384 },
});
make('refusal', 'Messages API: stop_reason refusal', {
  id: 'msg_01Refusal000000000000001', blocks: [{ type: 'text', text: 'Tôi không thể giúp với yêu cầu này.' }], stop: 'refusal',
  startUsage: { input_tokens: 30, output_tokens: 1 }, deltaUsage: { output_tokens: 12 },
});
make('pause-turn', 'Messages API: stop_reason pause_turn (a long turn the server paused): incomplete, nothing to run', {
  id: 'msg_01PauseTurn0000000000001', blocks: [{ type: 'text', text: 'Đang tìm kiếm' }], stop: 'pause_turn',
  startUsage: { input_tokens: 55, output_tokens: 1 }, deltaUsage: { output_tokens: 5 },
});
make('two-calls', 'Messages API (a gateway that allows parallel tool use): two tool_use blocks in one message', {
  id: 'msg_01TwoCalls00000000000001', blocks: [
    { type: 'tool_use', id: 'toolu_01AAAAAAAAAAAAAAAAAAAAAA', name: 'read_file', json: '{"path":"a.txt"}' },
    { type: 'tool_use', id: 'toolu_01BBBBBBBBBBBBBBBBBBBBBB', name: 'read_file', json: '{"path":"b.txt"}' },
  ], stop: 'tool_use', startUsage: { input_tokens: 200, output_tokens: 2 }, deltaUsage: { output_tokens: 60 },
});
make('no-input-tool', 'Messages API: a tool with no parameters: its input is {}', {
  id: 'msg_01NoInputTool000000000001', blocks: [{ type: 'tool_use', id: 'toolu_01NoInput0000000000001', name: 'git_status', json: '{}' }],
  stop: 'tool_use', startUsage: { input_tokens: 120, output_tokens: 2 }, deltaUsage: { output_tokens: 18 },
});
make('empty-input-tool', 'A gateway that streams no JSON at all for a tool with no parameters (an empty partial_json): the input is {}', {
  id: 'msg_01EmptyInputTool0000000001', strict: false, blocks: [{ type: 'tool_use', id: 'toolu_01EmptyInput000000000001', name: 'git_status', json: '' }],
  stop: 'tool_use', startUsage: { input_tokens: 120, output_tokens: 2 }, deltaUsage: { output_tokens: 18 },
});
make('bedrock-no-ping', 'Messages API as a gateway (Bedrock, Vertex) sends it: no ping events, two text blocks', {
  id: 'msg_01Gateway00000000000001', noPing: true, blocks: [
    { type: 'text', text: 'Phần một.' },
    { type: 'text', text: 'Phần hai.' },
  ], stop: 'end_turn', startUsage: { input_tokens: 21, output_tokens: 1 }, deltaUsage: { output_tokens: 9 },
});

fs.writeFileSync(path.join(out, 'anthropic.json'), JSON.stringify({ about: 'Messages API streams and the plain message of the same answer. Written from one plan by a generator (shape per the streaming documentation), not captured from a live account.', fixtures }, null, 2) + '\n');
console.log(`wrote ${fixtures.length} anthropic fixtures to ${out}`);
