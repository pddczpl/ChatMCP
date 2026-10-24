// Writes the Gemini stream fixtures: node build-gemini.cjs [outDir]  (default: the folder this file is in)
// Each fixture is a stream (.sse, `models/<model>:streamGenerateContent?alt=sse`: every event is a complete GenerateContentResponse) in the shape of the Gemini API
// (https://ai.google.dev/api/generate-content#method:-models.streamgeneratecontent) and the plain generateContent response of the SAME answer. Both are written from one plan, here.
const fs = require('node:fs');
const path = require('node:path');
const out = process.argv[2] ?? __dirname;
fs.mkdirSync(path.join(out, 'gemini'), { recursive: true });

const pieces = (text, size) => { const list = []; const chars = [...text]; for (let i = 0; i < chars.length; i += size) list.push(chars.slice(i, i + size).join('')); return list; };
const fixtures = [];
const SIGNATURE = 'CiQBjz1rX6hYq5uV0Zk8Wc3oN9mAeLpTsRdGfHjKlQwErTyUiOpAsDfGhJkLzXcVbNm1234567890==';
const SIGNATURE_2 = 'CiQBjz1rXsecondSignature0000000000000000000000000000000000000000000000000==';

const chunk = (base, parts, { finish, usage, role = 'model' } = {}) => `data: ${JSON.stringify({
  candidates: [{ content: { parts, role }, ...(finish ? { finishReason: finish } : {}), index: 0 }],
  ...(usage ? { usageMetadata: usage } : {}), modelVersion: base.modelVersion, responseId: base.responseId,
})}\r\n\r\n`;

/** One scenario: the parts of the whole answer in the order they come, how they are cut into chunks, usage. */
function make(name, source, { modelVersion = 'gemini-2.5-flash', responseId, chunks, finish = 'STOP', usage, strict = true, tail = null, promptFeedback = null }) {
  const base = { modelVersion, responseId };
  let text = '';
  chunks.forEach((parts, index) => {
    const last = index === chunks.length - 1;
    text += chunk(base, parts, last ? { finish, usage } : { usage: usage ? { ...usage, candidatesTokenCount: Math.max(1, Math.floor((usage.candidatesTokenCount ?? 2) / 2)), totalTokenCount: usage.promptTokenCount } : undefined });
  });
  if (tail) text += tail;
  if (promptFeedback) text = `data: ${JSON.stringify({ promptFeedback, usageMetadata: usage, modelVersion, responseId })}\r\n\r\n`;
  fs.writeFileSync(path.join(out, 'gemini', `${name}.sse`), text);

  // the plain response of the same answer: the text parts of a run are ONE part (the signature on the part it was issued for), the other parts as they are
  const parts = [];
  let run = null;
  for (const chunkParts of chunks) {
    for (const part of chunkParts) {
      if (typeof part.text === 'string' && !part.functionCall) {
        const thought = part.thought === true;
        if (run && run.thought === thought && !run.sealed) run.part.text += part.text;
        else { run = { thought, sealed: false, part: { ...part } }; parts.push(run.part); }
        if (part.thoughtSignature) { run.part.thoughtSignature = part.thoughtSignature; run.sealed = true; }
      } else { parts.push(JSON.parse(JSON.stringify(part))); run = null; }
    }
  }
  const response = promptFeedback
    ? { promptFeedback, usageMetadata: usage, modelVersion, responseId }
    : { candidates: [{ content: { role: 'model', parts }, finishReason: finish, index: 0 }], usageMetadata: usage, modelVersion, responseId };
  const visible = parts.filter((part) => part.thought !== true && typeof part.text === 'string').map((part) => part.text).join('\n');
  const calls = parts.filter((part) => part.functionCall).map((part) => ({ name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args ?? {}) }));
  fixtures.push({ name, file: `gemini/${name}.sse`, source, strict, response, summary: { finish, text: visible, calls, error: finish !== 'STOP' || Boolean(promptFeedback) } });
}

make('text', 'Gemini streamGenerateContent: a plain answer in chunks, usageMetadata in every chunk (cumulative), finishReason in the last', {
  responseId: 'r-text-0001', usage: { promptTokenCount: 12, candidatesTokenCount: 18, totalTokenCount: 30 },
  chunks: [[{ text: 'Xin chào! ' }], [{ text: 'Đây là một câu trả lời ' }], [{ text: 'được truyền theo từng mảnh. 😀' }]],
});
make('function-call', 'Gemini: a functionCall part in the last chunk, with its finishReason', {
  responseId: 'r-call-0001', usage: { promptTokenCount: 140, candidatesTokenCount: 22, totalTokenCount: 162 },
  chunks: [[{ text: 'Để tôi đọc tệp. ' }], [{ functionCall: { name: 'read_file', args: { path: 'README.md', max_lines: 40 } } }]],
});
make('thought-signature-call', 'Gemini 3: thought summaries (thought: true) then a signed functionCall (the signature is passed back with the call, byte for byte)', {
  modelVersion: 'gemini-3-pro-preview', responseId: 'r-sig-0001', usage: { promptTokenCount: 310, candidatesTokenCount: 30, thoughtsTokenCount: 120, totalTokenCount: 460 },
  chunks: [[{ text: '**Đọc README**\n\nCần mở tệp README.md trước.', thought: true }], [{ text: ' Sau đó tóm tắt.', thought: true }], [{ functionCall: { name: 'read_file', args: { path: 'README.md' } }, thoughtSignature: SIGNATURE }]],
});
make('signature-on-text', 'Gemini 3: the thoughtSignature arrives on a chunk with empty text after the answer (it belongs to the text before it)', {
  modelVersion: 'gemini-3-flash-preview', responseId: 'r-sigtext-0001', usage: { promptTokenCount: 50, candidatesTokenCount: 14, thoughtsTokenCount: 40, totalTokenCount: 104 },
  chunks: [[{ text: 'Kết quả là ' }], [{ text: '42.' }], [{ text: '', thoughtSignature: SIGNATURE }]],
});
make('two-calls', 'Gemini: two functionCall parts in one chunk (parallel calls); the first carries the signature', {
  modelVersion: 'gemini-3-pro-preview', responseId: 'r-two-0001', usage: { promptTokenCount: 200, candidatesTokenCount: 40, totalTokenCount: 240 },
  chunks: [[{ functionCall: { name: 'read_file', args: { path: 'a.txt' } }, thoughtSignature: SIGNATURE }, { functionCall: { name: 'read_file', args: { path: 'b.txt' } } }]],
});
make('text-call-text', 'Gemini: text, a functionCall, then more text: the two runs of text stay two parts', {
  responseId: 'r-mixed-0001', usage: { promptTokenCount: 77, candidatesTokenCount: 25, totalTokenCount: 102 },
  chunks: [[{ text: 'Trước: ' }], [{ text: 'đọc tệp.' }], [{ functionCall: { name: 'read_file', args: { path: 'x.md' } } }], [{ text: 'Sau: ' }], [{ text: 'báo cáo.' }]],
});
make('signed-text-then-text', 'Gemini: a signature closes its part: text that follows it is a part of its own', {
  modelVersion: 'gemini-3-pro-preview', responseId: 'r-sealed-0001', usage: { promptTokenCount: 33, candidatesTokenCount: 9, totalTokenCount: 42 },
  chunks: [[{ text: 'Một. ', thoughtSignature: SIGNATURE }], [{ text: 'Hai.' }]],
});
make('no-args-call', 'Gemini: a functionCall with no args', {
  responseId: 'r-noargs-0001', usage: { promptTokenCount: 44, candidatesTokenCount: 6, totalTokenCount: 50 },
  chunks: [[{ functionCall: { name: 'git_status' } }]],
});
make('max-tokens', 'Gemini: finishReason MAX_TOKENS: the plain path refuses it (model_incomplete) and so does the stream', {
  responseId: 'r-max-0001', finish: 'MAX_TOKENS', usage: { promptTokenCount: 60, candidatesTokenCount: 8192, totalTokenCount: 8252 },
  chunks: [[{ text: 'Một câu trả lời rất dài bị cắt ' }], [{ text: 'giữa chừng' }]],
});
make('safety', 'Gemini: finishReason SAFETY', {
  responseId: 'r-safety-0001', finish: 'SAFETY', usage: { promptTokenCount: 20, candidatesTokenCount: 1, totalTokenCount: 21 },
  chunks: [[{ text: 'Tôi' }]],
});
make('blocked-prompt', 'Gemini: the prompt was blocked (promptFeedback.blockReason, no candidate)', {
  responseId: 'r-block-0001', usage: { promptTokenCount: 15, totalTokenCount: 15 }, promptFeedback: { blockReason: 'SAFETY', safetyRatings: [{ category: 'HARM_CATEGORY_DANGEROUS_CONTENT', probability: 'HIGH' }] },
  chunks: [[{ text: '' }]], strict: false,
});

fs.writeFileSync(path.join(out, 'gemini.json'), JSON.stringify({ about: 'Gemini streams and the plain response of the same answer. Written from one plan by a generator (shape per the Gemini API reference), not captured from a live account.', fixtures }, null, 2) + '\n');
console.log(`wrote ${fixtures.length} gemini fixtures to ${out}`);
