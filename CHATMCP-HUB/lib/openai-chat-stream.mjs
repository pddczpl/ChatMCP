// OpenAI-style Chat Completions as a stream (prov-13): `stream: true` answers with chat.completion.chunk events and a final `data: [DONE]`.
// https://platform.openai.com/docs/api-reference/chat-streaming
//
// The reader builds from the chunks the complete answer the same API gives when it does not stream (message.content, reasoning_content, refusal, tool_calls, finish_reason, usage) and hands it to
// the one normaliser of the plain path, so a streamed answer and a plain one cannot differ. The text is passed on as it arrives (`onToken`); nothing else is: a tool call is part of the answer only
// when the stream is confirmed complete, and a half-read answer is never used.
//
// Complete means: a chunk carried a `finish_reason`; or, for an answer that is text only, the `[DONE]` marker came (a few servers leave the finish reason out). A stream that ends otherwise is
// `interrupted`; an event that is not what a Chat stream sends is `invalid`; an `error` object inside the stream is the provider's failure (lib/model-stream.mjs).
import { normalizeChatCompletion } from './openai-chat-api.mjs';
import { streamErrorStatus, streamInterrupted, streamInvalid, streamProviderError } from './model-stream.mjs';
import { SSE_STOP } from './sse.mjs';

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const textOf = (value) => (typeof value === 'string' ? value : Array.isArray(value) ? value.filter((part) => typeof part?.text === 'string').map((part) => part.text).join('') : '');
/** The finish reasons after which the calls of the answer are not to be trusted: the output limit cut it, or a filter did. */
const CUT_SHORT = new Set(['length', 'content_filter']);

/**
 * @param {object} [options]
 * @param {(text: string) => void|Promise<void>} [options.onToken] called with each piece of the answer's text as it arrives
 * @param {Set<string>} [options.usedCallIds] call ids already in the conversation (the normaliser gives a repeated one a new id)
 * @returns {{event: (event: {data: string}) => Promise<symbol|undefined>, finish: () => object}}
 *   `event` returns SSE_STOP at [DONE]: the stream is over and the read may end.
 */
export function createChatStreamReader({ onToken = () => {}, usedCallIds = new Set() } = {}) {
  let text = '';
  let reasoning = '';
  let refusal = '';
  let finishReason = null;
  let usage = null;
  let marked = false;
  const calls = [];
  const slotOf = new Map();

  /** The call a fragment belongs to: the one with its index; a fragment with no index starts a new call when it names another id than the last, else it continues the last. */
  const callFor = (fragment) => {
    if (Number.isInteger(fragment.index)) {
      if (!slotOf.has(fragment.index)) { slotOf.set(fragment.index, calls.length); calls.push({ id: '', name: '', arguments: '' }); }
      return calls[slotOf.get(fragment.index)];
    }
    const last = calls.at(-1);
    if (!last || (typeof fragment.id === 'string' && fragment.id && last.id && fragment.id !== last.id)) calls.push({ id: '', name: '', arguments: '' });
    return calls.at(-1);
  };

  return {
    async event(sse) {
      const raw = typeof sse?.data === 'string' ? sse.data.trim() : '';
      if (marked || raw === '') return undefined;
      if (raw === '[DONE]') { marked = true; return SSE_STOP; }
      let chunk;
      try { chunk = JSON.parse(raw); } catch { throw streamInvalid('Một sự kiện của luồng Chat Completions không phải JSON.'); }
      if (!isObject(chunk)) throw streamInvalid('Một sự kiện của luồng Chat Completions không phải một đối tượng.');
      if (chunk.error) {
        const error = isObject(chunk.error) ? chunk.error : { message: String(chunk.error) };
        throw streamProviderError(error, streamErrorStatus(error));
      }
      if (isObject(chunk.usage)) usage = chunk.usage;
      const choice = Array.isArray(chunk.choices) ? chunk.choices.find((candidate) => (candidate?.index ?? 0) === 0) : undefined;
      if (!isObject(choice)) return undefined;
      const delta = isObject(choice.delta) ? choice.delta : {};
      const piece = textOf(delta.content);
      if (piece) {
        text += piece;
        await onToken(piece);
      }
      if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
      if (typeof delta.refusal === 'string') refusal += delta.refusal;
      if (Array.isArray(delta.tool_calls)) {
        for (const fragment of delta.tool_calls) {
          if (!isObject(fragment)) throw streamInvalid('Một mảnh tool_calls của luồng không hợp lệ.');
          const call = callFor(fragment);
          if (typeof fragment.id === 'string' && fragment.id && !call.id) call.id = fragment.id;
          const fn = fragment.function;
          if (!isObject(fn)) continue;
          // The name comes once, in the first fragment. A server that repeats it in every fragment keeps it as it is; one that sends it cumulatively ("read", "read_file") makes it longer; a name that is
          // neither (another name, or a piece of this one) is not the name of this call.
          if (typeof fn.name === 'string' && fn.name.startsWith(call.name)) call.name = fn.name;
          if (typeof fn.arguments === 'string') call.arguments += fn.arguments;
          else if (isObject(fn.arguments)) call.arguments = JSON.stringify(fn.arguments);
        }
      }
      if (typeof choice.finish_reason === 'string' && choice.finish_reason) finishReason = choice.finish_reason;
      return undefined;
    },

    /** The answer, as normalizeChatCompletion makes it from the plain response of the same API. Throws `interrupted` when the stream was not confirmed complete, `invalid` when a call is damaged. */
    finish() {
      const complete = finishReason !== null || (marked && calls.length === 0 && Boolean(text || reasoning || refusal));
      if (!complete) {
        throw streamInterrupted(calls.length && marked
          ? 'Luồng Chat Completions kết thúc mà không có finish_reason cho một lời gọi công cụ; không chạy công cụ.'
          : 'Luồng Chat Completions kết thúc mà không có finish_reason hay [DONE]; không dùng kết quả dở và không chạy công cụ.');
      }
      if (!CUT_SHORT.has(finishReason)) {
        for (const call of calls) {
          if (!call.name) throw streamInvalid('Một lời gọi công cụ trong luồng không có tên; không chạy công cụ.');
          let parsed = {};
          try { parsed = call.arguments.trim() ? JSON.parse(call.arguments) : {}; } catch { parsed = null; }
          if (!isObject(parsed)) throw streamInvalid(`Tham số của lời gọi ${call.name} trong luồng không phải một đối tượng JSON hợp lệ; không chạy công cụ.`);
        }
      }
      // A stream that completes with nothing in it may have lost what it carried: the plain path calls such an answer empty and fails; the stream is asked again without being one.
      if (!CUT_SHORT.has(finishReason) && !text.trim() && !refusal.trim() && calls.length === 0) throw streamInvalid('Luồng Chat Completions hoàn tất mà không có văn bản, lời gọi công cụ hay lời từ chối nào.');
      const message = { role: 'assistant', content: text };
      if (reasoning) message.reasoning_content = reasoning;
      if (refusal) message.refusal = refusal;
      if (calls.length) message.tool_calls = calls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } }));
      return normalizeChatCompletion({ choices: [{ index: 0, finish_reason: finishReason, message }], ...(usage ? { usage } : {}) }, { usedCallIds });
    },
  };
}
