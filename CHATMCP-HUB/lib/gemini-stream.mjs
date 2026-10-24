// Gemini as a stream (prov-15): `models/<model>:streamGenerateContent?alt=sse` answers with server-sent events, each one a complete
// GenerateContentResponse that holds the next piece of the answer. https://ai.google.dev/api/generate-content#method:-models.streamgeneratecontent
//
// The reader rebuilds from the pieces the one response the same API gives when it does not stream, and the caller hands it to normalizeGemini, so a streamed answer and a plain one
// cannot differ. Consecutive pieces of text are one part (the plain response has them in one part); a piece that carries a thoughtSignature closes its part, so the signature stays
// on the text it belongs to, byte for byte. The visible text is passed on as it arrives (`onToken`); nothing else is: a function call is part of the answer only when a finishReason
// has come.
//
// Complete means: a piece carried a finishReason, or the prompt was blocked (promptFeedback.blockReason, no candidate to finish). A stream that ends otherwise is `interrupted`; an
// event that is not a Gemini response is `invalid`; an `error` object is the provider's failure (lib/model-stream.mjs).
import { streamErrorStatus, streamInterrupted, streamInvalid, streamProviderError } from './model-stream.mjs';

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const isTextPart = (part) => typeof part.text === 'string' && part.functionCall === undefined;
/** The finish reasons after which the plain path reads the parts: it refuses every other one (MAX_TOKENS, SAFETY ...) with an error of its own, and a stream says the same. */
const ENDS_NORMALLY = new Set(['STOP', 'FINISH_REASON_UNSPECIFIED']);

/** The streaming twin of a generateContent URL, or null when this route is not one that has a twin (a custom route is the owner's own word). */
export function geminiStreamEndpoint(endpoint) {
  let url;
  try { url = new URL(endpoint); } catch { return null; }
  if (!url.pathname.endsWith(':generateContent')) return null;
  url.pathname = `${url.pathname.slice(0, -':generateContent'.length)}:streamGenerateContent`;
  url.searchParams.set('alt', 'sse');
  return url.href;
}

/**
 * @param {object} [options]
 * @param {(text: string) => void|Promise<void>} [options.onToken] called with each piece of the visible text as it arrives
 * @returns {{event: (event: {data: string}) => Promise<undefined>, finish: () => object}}
 */
export function createGeminiStreamReader({ onToken = () => {} } = {}) {
  const parts = [];
  let run = null;
  let finishReason;
  let promptFeedback;
  let usageMetadata;
  let modelVersion;
  let responseId;
  let sawCandidate = false;

  return {
    async event(sse) {
      const raw = typeof sse?.data === 'string' ? sse.data.trim() : '';
      if (raw === '') return undefined;
      let chunk;
      try { chunk = JSON.parse(raw); } catch { throw streamInvalid('Một sự kiện của luồng Gemini không phải JSON.'); }
      if (!isObject(chunk)) throw streamInvalid('Một sự kiện của luồng Gemini không phải một đối tượng.');
      if (chunk.error) {
        const error = isObject(chunk.error) ? chunk.error : { message: String(chunk.error) };
        throw streamProviderError(error, streamErrorStatus(error));
      }
      if (isObject(chunk.usageMetadata)) usageMetadata = chunk.usageMetadata;
      if (typeof chunk.modelVersion === 'string') modelVersion = chunk.modelVersion;
      if (typeof chunk.responseId === 'string') responseId = chunk.responseId;
      if (isObject(chunk.promptFeedback)) promptFeedback = chunk.promptFeedback;
      const candidate = Array.isArray(chunk.candidates) ? chunk.candidates.find((entry) => (entry?.index ?? 0) === 0) : undefined;
      if (!isObject(candidate)) return undefined;
      sawCandidate = true;
      const incoming = candidate.content?.parts;
      if (incoming !== undefined && !Array.isArray(incoming)) throw streamInvalid('Một mảnh của luồng Gemini có content.parts không phải danh sách.');
      for (const part of incoming ?? []) {
        if (!isObject(part)) throw streamInvalid('Một part của luồng Gemini không phải đối tượng.');
        if (isTextPart(part)) {
          const thought = part.thought === true;
          if (run && run.thought === thought && !run.sealed) run.part.text += part.text;
          else {
            // The plain answer joins its runs of visible text with a line break; the text shown while it streams is the same text.
            if (!thought && parts.some((earlier) => earlier.thought !== true && typeof earlier.text === 'string')) await onToken('\n');
            run = { thought, sealed: false, part: { ...part, text: part.text } };
            parts.push(run.part);
          }
          if (typeof part.thoughtSignature === 'string' && part.thoughtSignature) { run.part.thoughtSignature = part.thoughtSignature; run.sealed = true; }
          if (!thought && part.text) await onToken(part.text);
        } else {
          parts.push(part); // a part that is not text stays as it came
          run = null; // and the text that follows it is a part of its own
        }
      }
      if (typeof candidate.finishReason === 'string' && candidate.finishReason) finishReason = candidate.finishReason;
      return undefined;
    },

    /** The response, as the plain call returns it. Throws `interrupted` when the stream was not confirmed complete, `invalid` when it completed with nothing in it. */
    finish() {
      const blocked = typeof promptFeedback?.blockReason === 'string' && promptFeedback.blockReason !== '';
      if (finishReason === undefined && !(blocked && !sawCandidate)) {
        throw streamInterrupted('Luồng Gemini kết thúc mà không có finishReason; không dùng kết quả dở và không chạy công cụ.');
      }
      // A stream that completes with nothing in it may have lost what it carried: the plain path calls such a response empty and fails; the stream is asked again without being one.
      if (finishReason !== undefined && ENDS_NORMALLY.has(finishReason) && !parts.some((part) => part.functionCall || (part.thought !== true && typeof part.text === 'string' && part.text.trim()))) {
        throw streamInvalid('Luồng Gemini hoàn tất mà không có văn bản hay lời gọi hàm nào.');
      }
      const response = {};
      if (sawCandidate) response.candidates = [{ content: { role: 'model', parts }, ...(finishReason !== undefined ? { finishReason } : {}), index: 0 }];
      if (promptFeedback) response.promptFeedback = promptFeedback;
      if (usageMetadata) response.usageMetadata = usageMetadata;
      if (modelVersion) response.modelVersion = modelVersion;
      if (responseId) response.responseId = responseId;
      return response;
    },
  };
}
