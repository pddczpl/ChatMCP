// The one Server-Sent Events reader of the Hub (prov-12): the Chat Completions, Messages and Gemini streams go through it. It knows the format and nothing of any protocol:
// what an event means, which event ends a stream and what to do when none did belong to the caller.
//
// The format (https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream): lines end in LF, CRLF or a lone CR; an event ends at a blank line; its
// `data` lines are joined with a line feed; `event` names it ("message" when it has no name); a line that starts with a colon is a comment (a keep-alive); one space after the
// colon of a field is dropped; an event with no `data` line is not an event; a stream may end without the last blank line; a byte order mark at the start is skipped.
//
// What the reader adds: whatever the chunk boundaries are the events are the same (a chunk may end inside a UTF-8 character, between a CR and its LF, inside a field name); the
// total is bounded; an abort or a silence stops the read and cancels the stream; a stream that breaks is an error and not an end.
import { MAX_RESPONSE_BYTES } from './model-http.mjs';

const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

/** What a handler returns to say that the stream is over (the Chat stream's [DONE], the Messages stream's message_stop): nothing after it is delivered and the connection is closed. */
export const SSE_STOP = Symbol('sse-stop');
const fail = (code, message, statusCode = 502) => Object.assign(new Error(message), { code, statusCode });

/**
 * A parser for text that is already decoded: `push(text)` for each piece, `end()` when the stream is over. `onEvent({event, data, id})` is called for each event, in order.
 * A CR at the end of a piece waits for the next one: it may be the first half of a CRLF.
 */
export function createSseParser(onEvent) {
  let line = '';
  let afterCarriageReturn = false;
  let started = false;
  let name = '';
  let data = [];
  let id;
  const finishLine = () => {
    const text = line;
    line = '';
    if (text === '') {
      if (data.length) onEvent({ event: name || 'message', data: data.join('\n'), ...(id === undefined ? {} : { id }) });
      name = '';
      data = [];
      return;
    }
    if (text[0] === ':') return;
    const colon = text.indexOf(':');
    const field = colon === -1 ? text : text.slice(0, colon);
    let value = colon === -1 ? '' : text.slice(colon + 1);
    if (value[0] === ' ') value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'event') name = value;
    else if (field === 'id' && !value.includes('\0')) id = value;
  };
  return {
    push(text) {
      let from = 0;
      if (!started && text.length) { started = true; if (text[0] === BYTE_ORDER_MARK) from = 1; }
      for (let at = from; at < text.length; at += 1) {
        const char = text[at];
        if (char === '\n') {
          if (afterCarriageReturn) { afterCarriageReturn = false; continue; }
          finishLine();
        } else if (char === '\r') {
          finishLine();
          afterCarriageReturn = true;
        } else {
          afterCarriageReturn = false; // an ordinary character: an LF after it is a line end of its own
          line += char;
        }
      }
    },
    /** The stream is over: the last line and the last event count even without their line ends. */
    end() {
      if (line !== '') finishLine(); // a last line with no line end
      finishLine(); // a last event with no blank line
      afterCarriageReturn = false;
    },
  };
}

/**
 * Reads a stream (the `body` of a fetch response) to its end and calls `onEvent` for each event, one after the other (an async handler is waited for).
 * @param {ReadableStream} body
 * @param {object} options
 * @param {(event: {event: string, data: string, id?: string}) => void|typeof SSE_STOP|Promise<void|typeof SSE_STOP>} options.onEvent returns SSE_STOP to end the read
 * @param {() => void} [options.onChunk] called for every chunk of bytes, a comment included: it is how a caller knows that the stream is alive
 * @param {AbortSignal} [options.signal] an abort cancels the stream and rejects with the reason of the signal
 * @param {number} [options.maxBytes] more than this is refused (`sse_too_large`)
 * @param {number} [options.idleTimeoutMs] no byte for this long cancels the stream; every byte starts the clock again
 * @param {() => Error} [options.idleError] the error for that silence
 * @returns {Promise<{bytes: number, halted: boolean}>} halted: a handler ended the read with SSE_STOP
 */
export async function readSse(body, { onEvent, onChunk = () => {}, signal = null, maxBytes = MAX_RESPONSE_BYTES, idleTimeoutMs = 0, idleError = null } = {}) {
  if (!body || typeof body.getReader !== 'function') throw fail('sse_no_stream', 'Nhà cung cấp không trả một luồng sự kiện (SSE).');
  signal?.throwIfAborted?.();
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  const queue = [];
  const parser = createSseParser((event) => { queue.push(event); });
  let total = 0;
  let stopped = null;
  let halted = false;
  let idleTimer = null;
  const stop = (error) => {
    if (stopped) return; // the first reason stands
    stopped = error;
    reader.cancel(error).catch(() => {});
  };
  const watch = () => {
    if (!(idleTimeoutMs > 0)) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => stop(idleError ? idleError() : fail('sse_idle', `Luồng không gửi dữ liệu trong ${idleTimeoutMs} ms.`)), idleTimeoutMs);
  };
  const onAbort = () => stop(signal.reason ?? fail('cancelled', 'Tác vụ đã dừng.', 499));
  signal?.addEventListener('abort', onAbort, { once: true });
  const deliver = async () => {
    while (queue.length) {
      if (stopped) return;
      if (await onEvent(queue.shift()) === SSE_STOP) { halted = true; return; }
    }
  };
  try {
    watch(); // the clock starts with the read
    for (;;) {
      const { done, value } = await reader.read(); // a stop cancels the stream, so a read that waits ends here
      if (done) break;
      watch(); // every byte starts the clock again
      onChunk();
      total += value?.byteLength ?? 0;
      if (total > maxBytes) throw fail('sse_too_large', `Luồng phản hồi vượt giới hạn ${maxBytes >= 1024 * 1024 ? Math.round(maxBytes / 1024 / 1024) + ' MiB' : Math.round(maxBytes / 1024) + ' KiB'}.`);
      parser.push(decoder.decode(value, { stream: true }));
      await deliver(); // the events of this chunk, before the next chunk is read
      if (halted) break; // a handler said the stream is over
    }
    if (!halted) {
      parser.push(decoder.decode());
      parser.end();
      await deliver(); // the events of the end of the stream
    }
    if (stopped) throw stopped; // a stop, from wherever it came, is an error and not an end
    return { bytes: total, halted };
  } catch (error) {
    stop(error);
    throw stopped ?? error;
  } finally {
    clearTimeout(idleTimer); // a finished read leaves no timer behind
    signal?.removeEventListener('abort', onAbort);
    try { await reader.cancel(); } catch { /* already closed or failed */ }
    try { reader.releaseLock(); } catch { /* a read is still pending */ }
  }
}
