// What the streaming readers of the three protocols (Chat Completions, Messages, Gemini) and the adapter that calls them share. A stream is read to a terminal
// confirmation and a tool call is made only after it: nothing here, and nothing built on it, hands a half-read answer to the agent.
//
// A stream can fail without the connection failing, in three ways:
//   interrupted  the connection closed without error, but the event that says the answer is complete never came (a proxy that cut the stream, a server that stopped)
//   invalid      what came is not a stream of that protocol (an event that is not JSON, a block that was never opened ...)
//   error        the provider reports, inside a stream that began with HTTP 200, that it failed (an `error` event or object)
// Nothing of an interrupted or invalid stream is used: the same model request is made once more WITHOUT a stream (no tool has run, so nothing can be replayed), and the endpoint
// is remembered as one that cannot stream. An error inside a stream is handled as the HTTP error it would have been (see streamErrorStatus).
const make = (kind, code, message, extra = {}) => Object.assign(new Error(message), { code, statusCode: 502, kind, ...extra });

export const streamInterrupted = (message) => make('stream_interrupted', 'gateway_stream_interrupted', message);
export const streamInvalid = (message) => make('stream_invalid', 'gateway_stream_invalid', message);
export const streamProviderError = (error, status) => make('stream_error', 'gateway_stream_error', typeof error?.message === 'string' ? error.message : 'Nhà cung cấp báo lỗi giữa luồng.', { upstreamStatus: status, data: { error } });

/** True for the two failures after which the same request is made again without a stream. */
export const isStreamFallback = (error) => error?.kind === 'stream_interrupted' || error?.kind === 'stream_invalid';

const STATUS_OF_NAME = Object.freeze({
  // Anthropic (error types of the Messages API)
  invalid_request_error: 400, authentication_error: 401, permission_error: 403, not_found_error: 404, request_too_large: 413, rate_limit_error: 429, api_error: 500, overloaded_error: 529,
  // OpenAI and compatible servers
  rate_limit_exceeded: 429, insufficient_quota: 429, context_length_exceeded: 400, server_error: 500, service_unavailable: 503, overloaded: 503, model_not_found: 404,
  // Google (the status field of an error)
  invalid_argument: 400, unauthenticated: 401, permission_denied: 403, not_found: 404, resource_exhausted: 429, internal: 500, unavailable: 503, deadline_exceeded: 504,
});

/** An error object found inside a stream -> the HTTP status the same failure would have had (502 when it cannot be told). */
export function streamErrorStatus(error) {
  const number = Number(error?.code ?? error?.status);
  if (Number.isInteger(number) && number >= 400 && number <= 599) return number;
  for (const name of [error?.type, error?.code, error?.status]) {
    if (typeof name === 'string' && Object.hasOwn(STATUS_OF_NAME, name.toLowerCase())) return STATUS_OF_NAME[name.toLowerCase()];
  }
  return 502;
}

const lapse = (ms) => (ms >= 60000 ? `${Math.round(ms / 60000)} phút` : `${Math.max(1, Math.round(ms / 1000))} giây`);
const clockError = (code, waitedMs, message) => Object.assign(new Error(message), { name: 'TimeoutError', code, kind: 'network', waitedMs });

/**
 * The clocks of one streaming request. Before the response begins, the request is bounded by `headersMs` (the same wait a request without a stream has). From the moment the response
 * begins, a stream is bounded by `idleMs`, which every byte starts again (a keep-alive comment is a byte), and by `totalMs` for the whole of it: a model that writes for ten minutes is
 * not an error, one that goes quiet or never finishes is. The signal it gives is the caller's signal and the clocks together; when a clock ends the request, `reason()` is a coded
 * TimeoutError (kind 'network'), because an aborted fetch does not always pass the reason on. The caller's own reason is never replaced: `reason()` is null then.
 */
export function createStreamClock({ signal = null, headersMs, idleMs, totalMs }) {
  const own = new AbortController();
  let timer = null;
  let totalTimer = null;
  let begun = false;
  const arm = (ms, code, text) => {
    clearTimeout(timer);
    timer = setTimeout(() => own.abort(clockError(code, ms, text)), ms);
  };
  arm(headersMs, 'stream_headers_timeout', `Nhà cung cấp chưa trả lời sau ${lapse(headersMs)}.`);
  return {
    signal: signal ? AbortSignal.any([signal, own.signal]) : own.signal,
    /** The response has begun: from now on the idle clock and the total cap run. */
    started() {
      if (begun) return;
      begun = true;
      arm(idleMs, 'stream_idle_timeout', `Luồng trả lời không có dữ liệu mới trong ${lapse(idleMs)}.`); // the idle clock runs from the response on
      totalTimer = setTimeout(() => own.abort(clockError('stream_total_timeout', totalMs, `Luồng trả lời vẫn chưa xong sau ${lapse(totalMs)}.`)), totalMs);
    },
    /** Bytes arrived: the idle clock starts again. */
    touch() {
      if (begun && !own.signal.aborted) arm(idleMs, 'stream_idle_timeout', `Luồng trả lời không có dữ liệu mới trong ${lapse(idleMs)}.`);
    },
    stop() { clearTimeout(timer); clearTimeout(totalTimer); },
    reason: () => (signal?.aborted ? null : own.signal.aborted ? own.signal.reason : null),
  };
}

/** The text of a finished answer, handed to onToken in one piece: for a call that did not stream (the stream was refused, or the server answered with JSON). An unfinished answer is not shown as text. */
export async function deliverText(result, onToken) {
  if (result.status !== 'completed') return;
  for (const item of result.output) {
    if (item.type === 'message') for (const part of item.content) if (part.type === 'output_text') await onToken(part.text);
  }
}

/** The answer says it was streamed as `text/event-stream`; anything else (a server that ignores `stream`) is read as the JSON it is. */
export const isEventStream = (response) => String(response?.headers?.get?.('content-type') ?? '').toLowerCase().includes('text/event-stream');
