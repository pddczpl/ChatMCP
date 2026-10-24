// Anthropic Messages as a stream (prov-14): `stream: true` answers with server-sent events
// message_start, (content_block_start, content_block_delta ..., content_block_stop) ..., message_delta, message_stop, with `ping` between them
// and `error` when the provider fails after the stream began. https://platform.claude.com/docs/en/build-with-claude/streaming
//
// The reader rebuilds from the events the complete Message the same API gives when it does not stream and hands it to the one normaliser of the
// plain path, so a streamed answer and a plain one cannot differ. The text is passed on as it arrives (`onToken`); nothing else is: a tool
// call is part of the answer only when `message_stop` has come, and its JSON is read once, when its block is closed.
//
// Complete means: message_stop, after a message_delta that named the stop reason, with every block closed. A stream that ends otherwise is
// `interrupted` (the connection closed without the end); an event that is not what a Messages stream sends is `invalid`; an `error` event is the
// provider's failure, with the status the same failure would have had as an HTTP answer (overloaded_error = 529, retryable). lib/model-stream.mjs.
import { normalizeAnthropic } from './anthropic-api.mjs';
import { streamErrorStatus, streamInterrupted, streamInvalid, streamProviderError } from './model-stream.mjs';
import { SSE_STOP } from './sse.mjs';

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
/** The stop reasons for which the plain path answers without text or calls (the limit, a pause, a refusal): an empty message with one of them is an answer. */
const MAY_BE_EMPTY = new Set(['max_tokens', 'pause_turn', 'refusal']);

/**
 * @param {object} [options]
 * @param {(text: string) => void|Promise<void>} [options.onToken] called with each piece of the answer's text as it arrives
 * @returns {{event: (event: {event?: string, data: string}) => Promise<symbol|undefined>, finish: () => object}}
 *   `event` returns SSE_STOP at message_stop: the stream is over and the read may end.
 */
export function createAnthropicStreamReader({ onToken = () => {} } = {}) {
  let message = null;
  let usage = {};
  let stopReason = null;
  let stopped = false;
  let open = null;
  const blocks = new Map();

  const block = (index, what) => {
    const found = blocks.get(index);
    if (!found || open !== index) throw streamInvalid(`${what} cho khối ${index} không đang mở trong luồng Messages.`);
    return found;
  };
  const show = async (piece) => {
    if (piece) await onToken(piece);
  };

  return {
    async event(sse) {
      const raw = typeof sse?.data === 'string' ? sse.data.trim() : '';
      if (stopped || raw === '') return undefined; // nothing after message_stop is read, and an event with no data is nothing
      let json;
      try { json = JSON.parse(raw); } catch { throw streamInvalid('Một sự kiện của luồng Messages không phải JSON.'); }
      if (!isObject(json)) throw streamInvalid('Một sự kiện của luồng Messages không phải một đối tượng.');
      const type = typeof json.type === 'string' ? json.type : sse?.event;
      if (type === 'error' || sse?.event === 'error') {
        const error = isObject(json.error) ? json.error : { message: String(json.message ?? 'Nhà cung cấp báo lỗi giữa luồng.') };
        throw streamProviderError(error, streamErrorStatus(error));
      }
      if (type === 'ping') return undefined;

      if (type === 'message_start') {
        if (message) throw streamInvalid('Luồng Messages có hai message_start.');
        if (!isObject(json.message)) throw streamInvalid('message_start không mang message.');
        message = json.message;
        usage = isObject(message.usage) ? { ...message.usage } : {};
        return undefined;
      }
      if (!message) throw streamInvalid(`Luồng Messages bắt đầu bằng ${type ?? 'một sự kiện lạ'} thay vì message_start.`);

      if (type === 'content_block_start') {
        const index = json.index;
        if (!Number.isInteger(index) || index < 0 || blocks.has(index) || open !== null) throw streamInvalid('content_block_start sai chỉ số hoặc khi một khối khác còn mở.');
        const begun = json.content_block;
        if (!isObject(begun) || typeof begun.type !== 'string') throw streamInvalid('content_block_start không mang content_block.');
        const entry = { ...begun, partial: [] };
        if (entry.type === 'thinking' && typeof entry.thinking !== 'string') entry.thinking = ''; // a thinking block always has its text field, empty when the thoughts are not shown
        if (entry.type === 'text') {
          entry.text = typeof entry.text === 'string' ? entry.text : '';
          // The plain answer joins its text blocks with a line break; the text shown while it streams is the same text.
          if ([...blocks.values()].some((earlier) => earlier.type === 'text')) await show('\n');
          await show(entry.text);
        }
        blocks.set(index, entry);
        open = index;
        return undefined;
      }
      if (type === 'content_block_delta') {
        const entry = block(json.index, 'content_block_delta');
        const piece = json.delta;
        if (!isObject(piece)) throw streamInvalid('content_block_delta không mang delta.');
        if (piece.type === 'text_delta' && entry.type === 'text' && typeof piece.text === 'string') {
          entry.text += piece.text;
          await show(piece.text);
        } else if (piece.type === 'input_json_delta' && entry.type === 'tool_use' && typeof piece.partial_json === 'string') entry.partial.push(piece.partial_json);
        else if (piece.type === 'thinking_delta' && entry.type === 'thinking' && typeof piece.thinking === 'string') entry.thinking = (entry.thinking ?? '') + piece.thinking;
        else if (piece.type === 'signature_delta' && entry.type === 'thinking' && typeof piece.signature === 'string') entry.signature = piece.signature;
        else if (piece.type === 'citations_delta' || !['text', 'tool_use', 'thinking'].includes(entry.type)) { /* nothing the Hub asks for: a block of another kind is kept as it started */ }
        else throw streamInvalid(`Một delta ${piece.type} không thuộc khối ${entry.type}.`);
        return undefined;
      }
      if (type === 'content_block_stop') {
        const entry = block(json.index, 'content_block_stop');
        if (entry.type === 'tool_use') {
          // The JSON of a call is read once, here. A call the output limit cut off does not parse: it is kept apart, and the stop reason decides below.
          const raw = entry.partial.join('');
          try {
            const input = raw.trim() ? JSON.parse(raw) : {};
            if (!isObject(input)) throw new Error('not an object');
            entry.input = input;
          } catch { entry.input = {}; entry.cut = true; }
        }
        delete entry.partial;
        open = null;
        return undefined;
      }
      if (type === 'message_delta') {
        if (open !== null) throw streamInvalid('message_delta khi một khối còn mở.');
        if (isObject(json.delta)) {
          if (typeof json.delta.stop_reason === 'string' && json.delta.stop_reason) stopReason = json.delta.stop_reason;
        }
        // Cumulative: every field the event names replaces the earlier value; none is added to it.
        if (isObject(json.usage)) usage = { ...usage, ...json.usage };
        return undefined;
      }
      if (type === 'message_stop') {
        if (open !== null) throw streamInvalid('message_stop khi một khối còn mở.');
        if (stopReason === null) throw streamInvalid('message_stop mà chưa có message_delta với stop_reason.');
        stopped = true;
        return SSE_STOP;
      }
      // Any other event type is one this client does not know: ignored, as the documentation asks ("handle unknown events gracefully").
      return undefined;
    },

    /** The answer, as normalizeAnthropic makes it from the plain response of the same API. Throws `interrupted` when the stream was not confirmed complete, `invalid` when it is damaged. */
    finish() {
      if (!stopped) throw streamInterrupted('Luồng Messages kết thúc mà không có message_stop; không dùng kết quả dở và không chạy công cụ.');
      const content = [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, entry]) => entry);
      // A call that does not parse is the output limit's doing only when the stop reason says so; otherwise the stream was damaged.
      if (stopReason !== 'max_tokens' && content.some((entry) => entry.cut)) throw streamInvalid('Tham số của một lời gọi công cụ trong luồng Messages không phải JSON hợp lệ.');
      // A stream that completes with nothing in it may have lost what it carried: the plain path calls such a message empty and fails; the stream is asked again without being one.
      if (!MAY_BE_EMPTY.has(stopReason) && !content.some((entry) => entry.type === 'tool_use' || (entry.type === 'text' && entry.text.trim()))) throw streamInvalid('Luồng Messages hoàn tất mà không có văn bản hay lời gọi công cụ nào.');
      return normalizeAnthropic({ ...message, content, stop_reason: stopReason, usage });
    },
  };
}
