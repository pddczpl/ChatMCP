// One model request for the "standard" protocols (OpenAI-style Chat Completions and the Anthropic Messages API):
// build it, send it, and survive what a real network and a real provider do. Gemini keeps its own, older loop in
// gateway-provider.mjs.
//
// What this guarantees to the agent:
//   * Only the MODEL request is ever repeated. A tool is never run twice because a model call was retried.
//   * Waiting is bounded: a provider that keeps failing ends the run with a clear reason instead of hanging.
//   * A conversation that no longer fits the model's context is shortened in the COPY that is sent. The agent keeps
//     the full history; stubs say how to get the data back (see compactHistory).
//   * The endpoint and the headers (so the key) are fixed when the call starts. Changing the settings while a call is
//     in flight cannot redirect a key to another host.
import { buildAnthropicBody, normalizeAnthropic } from './anthropic-api.mjs';
import { createAnthropicStreamReader } from './anthropic-stream.mjs';
import { buildChatBody, normalizeChatCompletion } from './openai-chat-api.mjs';
import { createChatStreamReader } from './openai-chat-stream.mjs';
import { compactHistory, historyBytes, pairToolCalls } from './model-history.mjs';
import { backoffMs, classifyHttpError, errorDetail, readBodyText } from './model-http.mjs';
import { createStreamClock, deliverText, isEventStream, isStreamFallback } from './model-stream.mjs';
import { applyReasoning, refusesReasoning } from './reasoning-effort.mjs';
import { readSse } from './sse.mjs';
import { bindThinking, isThinkingBlock, refusesThinkingReplay, withoutStaleThinking } from './thinking-blocks.mjs';

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message, statusCode = 502) => Object.assign(new Error(message), { code, statusCode });
const kib = (bytes) => Math.round(bytes / 1024);

const HEAVY_THINKING = new Set(['high', 'xhigh', 'max']);

export const LIMITS = Object.freeze({
  requestTimeoutMs: 240000,
  maxNetworkRetries: 10,
  maxTimeouts: 2,
  maxHttpRetries: 5,
  maxWaitMs: 60000,
  /** A provider that asks for a longer pause than this (a daily quota, say) is reported, not waited for. */
  giveUpAfterMs: 120000,
  maxCompactions: 3,
  keepRecent: Object.freeze([10, 4, 2, 2]),
  defaultOutputTokens: 16384,
  bytesPerToken: 3.5,
  contextFill: 0.85,
  /** A stream that sends no byte for this long is given up; every byte (a keep-alive comment too) starts the clock again. Reasoning models can be silent for a while, so it is well above a healthy pause. */
  idleTimeoutMs: 120000,
  /** A stream is cut at this age, however alive it looks: a model that writes for ten minutes is not an error, one that never finishes is. */
  streamTotalMs: 1800000,
  /** The cap on the bytes of one stream. The events of a stream are many times the size of the answer they carry (a Chat chunk is a few hundred bytes for a word or two), so a long answer is far above the 12 MiB a plain response is held to; only the answer itself is kept in memory. */
  streamMaxBytes: 64 * 1024 * 1024,
});

/** The protocols whose answers can be read as a stream, and the reader of each (lib/*-stream.mjs). */
const STREAM_READERS = Object.freeze({ 'openai-chat': createChatStreamReader, anthropic: createAnthropicStreamReader });

const NETWORK_CODES = ['ECONNRESET', 'ENETUNREACH', 'EHOSTUNREACH', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'];
export function isNetworkFailure(error) {
  return error instanceof TypeError || ['TimeoutError', 'AbortError', 'NetworkError'].includes(error?.name)
    || NETWORK_CODES.includes(error?.code) || NETWORK_CODES.includes(error?.cause?.code);
}

/** Bytes of conversation that fit the model, or null when the window is unknown or too small to plan with. */
export function historyBudgetBytes({ contextWindowTokens, outputTokens, fixedBytes, limits = LIMITS }) {
  if (!Number.isFinite(contextWindowTokens) || contextWindowTokens <= 0) return null;
  const tokens = Math.max(1000, contextWindowTokens * limits.contextFill - outputTokens);
  const budget = Math.floor(tokens * limits.bytesPerToken) - fixedBytes;
  return budget >= 8 * 1024 ? budget : null;
}

function parseJson(raw) {
  try { const value = JSON.parse(raw); return isObject(value) ? value : null; } catch { return null; }
}
function plainDetail(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  if (text.startsWith('<')) return 'Phản hồi lỗi không phải JSON (trang lỗi của proxy hoặc gateway).';
  return text.slice(0, 300);
}
/** HTTP 200 whose body is an error object (some gateways do this). Returns the status to treat it as, or null. */
function embeddedErrorStatus(body) {
  if (!isObject(body) || !body.error || body.choices || (Array.isArray(body.content) && body.type !== 'error')) return null;
  const code = Number(body.error?.code ?? body.error?.status);
  return Number.isInteger(code) && code >= 400 && code <= 599 ? code : 502;
}
// The 400 of a server that does not take `stream_options` (it streams, but does not know the option): it names the field or says "include_usage".
const refusesStreamOptions = (status, data, info) => status === 400 && info.kind === 'request' && (data?.error?.param === 'stream_options' || /stream_options|include_usage/i.test(errorDetail(data)));
// The 400 of a server that cannot stream this model. It says so in the field it names or in its words ("Unsupported value: 'stream' does not support true with this model", "Your organization
// must be verified to stream this model"). A plain refusal only: a 400 about the context, the output cap, the quota or the model is not about the stream; nor is one about stream_options,
// which is answered once (above) and, when it comes again, is an error like any other.
const refusesStream = (status, data, info) => status === 400 && info.kind === 'request' && (data?.error?.param === 'stream' || /\bstream(?!_options)/i.test(errorDetail(data)));
const hasThinkingBlocks = (body) => Array.isArray(body?.messages) && body.messages.some((entry) => Array.isArray(entry?.content) && entry.content.some(isThinkingBlock));
/** The output a model that thinks is given room for: the default, or a quarter of what it can write when that is more; within what it can write and a quarter of the window (the history needs the rest). */
function thinkingRoom(ctx, limits) {
  const model = Number.isInteger(ctx.modelOutputLimit) && ctx.modelOutputLimit > 0 ? ctx.modelOutputLimit : Infinity;
  const quarterOfWindow = Number.isFinite(ctx.contextWindowTokens) && ctx.contextWindowTokens > 0 ? Math.max(1024, Math.floor(ctx.contextWindowTokens / 4)) : Infinity;
  return Math.min(Math.max(limits.defaultOutputTokens, Number.isFinite(model) ? Math.floor(model / 4) : 0), model, quarterOfWindow);
}
const originOf = (endpoint) => { try { return new URL(endpoint).origin; } catch { return ''; } };
const waited = (ms) => (ms >= 60000 ? `${Math.round(ms / 60000)} phút` : `${Math.max(1, Math.round(ms / 1000))} giây`);

/**
 * @param {object} ctx fixed for the whole call
 * @param {'openai-chat'|'anthropic'} ctx.protocol
 * @param {string} ctx.endpoint
 * @param {object} ctx.headers
 * @param {string} ctx.model
 * @param {Function} ctx.fetch
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>} ctx.sleep
 * @param {(text: string) => string} ctx.redact removes keys and other secrets from provider text
 * @param {number|null} [ctx.contextWindowTokens]
 * @param {boolean} [ctx.promptCaching]
 * @param {number|null} [ctx.outputLimit] a cap learned earlier from the provider
 * @param {(limit: number) => void} [ctx.onOutputLimit]
 * @param {{field: string, value: unknown}|null} [ctx.reasoning] the thinking setting to put in the request (lib/reasoning-effort.mjs), or nothing
 * @param {boolean} [ctx.reasoningRefused] this endpoint and model are known to refuse it, so do not send it
 * @param {() => void} [ctx.onReasoningRefused] a refusal is confirmed: the repeat without the setting was accepted
 * @param {boolean} [ctx.stream] the caller wants the text as it arrives (onToken). Only a protocol that has a stream reader streams; for the others the text is not delivered at all
 * @param {boolean} [ctx.streamRefused] this endpoint and model are known not to stream (they refused it, or their stream was cut): do not ask; onToken still gets the text, at the end
 * @param {() => void} [ctx.onStreamRefused] a refusal is confirmed: the repeat without a stream was accepted
 * @param {boolean} [ctx.streamOptionsRefused] (Chat Completions) this endpoint does not take `stream_options`: stream without asking for the usage chunk
 * @param {() => void} [ctx.onStreamOptionsRefused] the repeat without `stream_options` was accepted
 * @param {boolean} [ctx.thinks] (Anthropic) the catalog is sure that the model can reason (the Claude 5 models think whatever they are asked): max_tokens counts the thoughts, so it is given room for them
 * @param {number|null} [ctx.modelOutputLimit] (Anthropic) the most the catalog says the model can write in one answer
 * @param {boolean} [ctx.thinkingReplayRefused] (Anthropic) this endpoint and model are known to refuse the thinking blocks they are sent back, so do not send them
 * @param {() => void} [ctx.onThinkingReplayRefused] a refusal is confirmed: the repeat without the blocks was accepted
 * @param {object} [ctx.limits] overrides of LIMITS (tests)
 *
 * What a stream adds (lib/model-stream.mjs says what the failures are): a stream is read to its terminal event and the answer is made from the whole of it, never from a part.
 * A stream that is cut or damaged is NOT an answer; the same model request is made once more without a stream (no tool has run, so nothing can be replayed), and the caller is told
 * to remember. What had been shown is taken back (`onStreamReset`) before anything is repeated. An error inside the stream is handled as the HTTP error it would have been.
 */
export async function respondStandard(ctx, { input, instructions, tools = [], signal, onStatus = async () => {}, onToken = () => {}, onStreamReset = () => {}, maxOutputTokens, beforeModelRequest = () => {} } = {}) {
  const limits = { ...LIMITS, ...ctx.limits };
  // Thinking blocks (Anthropic): only the round that waits for a tool result keeps its own; the signatures of older rounds are never sent again and must not count as conversation.
  const history = withoutStaleThinking(pairToolCalls(input));
  const origin = originOf(ctx.endpoint);
  const usedCallIds = new Set(history.filter((item) => item?.type === 'function_call').map((item) => item.call_id));
  let outputTokens = Math.floor(Number.isFinite(maxOutputTokens) && maxOutputTokens > 0 ? maxOutputTokens : limits.defaultOutputTokens);
  if (ctx.outputLimit) outputTokens = Math.min(outputTokens, ctx.outputLimit);
  let reasoning = ctx.reasoning && ctx.reasoningRefused !== true ? ctx.reasoning : null;
  // A Claude model asked to think hard spends output tokens on it before it writes the answer: under a small cap the answer is cut off by the limit.
  if (reasoning && ctx.protocol === 'anthropic' && HEAVY_THINKING.has(reasoning.value?.effort)) {
    outputTokens = Math.max(outputTokens, limits.defaultOutputTokens);
    if (ctx.outputLimit) outputTokens = Math.min(outputTokens, ctx.outputLimit);
  }
  // ... and a model the catalog says can reason needs room for the thoughts and the answer, since max_tokens counts both. That room is a cap on what may be written, not conversation to make room
  // for: the history is still planned with the output as asked (the agent's reserve), as models that think do not refuse a prompt and a max_tokens that together pass the window; one that does
  // answers a context error, which shortens the history as it always has.
  const plannedOutputTokens = outputTokens;
  if (ctx.protocol === 'anthropic' && ctx.thinks === true) outputTokens = Math.min(Math.max(outputTokens, thinkingRoom(ctx, limits)), ctx.outputLimit || Infinity);
  const fixedBytes = Buffer.byteLength(String(instructions)) + Buffer.byteLength(JSON.stringify(tools));
  let maxBytes = historyBudgetBytes({ contextWindowTokens: ctx.contextWindowTokens, outputTokens: plannedOutputTokens, fixedBytes, limits });
  const counters = { network: 0, http: 0, timeouts: 0, compactions: 0 };
  let limitRetried = false;
  let reasoningDropped = false;
  let replaying = ctx.protocol === 'anthropic' && ctx.thinkingReplayRefused !== true; // whether the thinking blocks of the waiting round go back (lib/thinking-blocks.mjs)
  let replayDropped = false; // the server refused them and the attempts from here on have none: the caller remembers once one of them is accepted
  let announcedBytes = null;
  let rejectedBytes = Infinity;
  // Streaming. `streaming` is whether THIS attempt asks for a stream; `wantsStream` is whether the caller gets its text through onToken at all (it does, at the end, when no stream could be had).
  const makeReader = STREAM_READERS[ctx.protocol];
  const wantsStream = ctx.stream === true && makeReader !== undefined;
  let streaming = wantsStream && ctx.streamRefused !== true;
  let includeUsage = ctx.streamOptionsRefused !== true;
  let streamGaveUp = false; // the stream was refused or cut, and the attempts from here on have none: the caller remembers once one of them is accepted
  let usageDropped = false; // the same for stream_options
  let shown = 0; // the characters of text the attempt in progress has handed to onToken
  const takeBack = async () => {
    if (shown > 0) { shown = 0; await onStreamReset(); }
  };

  const upstreamError = (info, extra = '') => Object.assign(fail(info.code, `${info.message}${extra}`, 502), { kind: info.kind, upstreamStatus: info.status, retryAfterMs: info.retryAfterMs });
  /** The request was accepted: whatever it took to be accepted (a setting, stream_options or the stream itself left out) is confirmed to the caller, once. */
  const accepted = () => {
    if (reasoningDropped) ctx.onReasoningRefused?.();
    if (replayDropped) { replayDropped = false; ctx.onThinkingReplayRefused?.(); }
    if (usageDropped) { usageDropped = false; ctx.onStreamOptionsRefused?.(); }
    if (streamGaveUp) { streamGaveUp = false; ctx.onStreamRefused?.(); }
  };

  while (true) {
    signal?.throwIfAborted();
    await takeBack(); // text of an attempt that is being replaced, when a branch below did not take it back before
    const view = maxBytes === null
      ? { history, changed: false, after: null }
      : compactHistory(history, { maxBytes, keepRecent: limits.keepRecent[Math.min(counters.compactions, limits.keepRecent.length - 1)] });
    if (counters.compactions > 0 && view.after !== null && view.after >= rejectedBytes) {
      throw fail('gateway_context_length', 'Cuộc hội thoại vẫn vượt giới hạn ngữ cảnh của model dù đã rút gọn tối đa. Chọn model có ngữ cảnh lớn hơn, đặt đúng "Ngữ cảnh model" trong cấu hình, hoặc bắt đầu phiên mới.');
    }
    if (view.changed && announcedBytes !== view.after) {
      announcedBytes = view.after;
      await onStatus(`Đã rút gọn ngữ cảnh gửi tới model: ${kib(view.before)} KiB → ${kib(view.after)} KiB (kết quả công cụ cũ được thay bằng bản tóm tắt). Lịch sử đầy đủ vẫn ở trên máy và không công cụ nào bị chạy lại.`, 'context_compaction');
    }
    const body = ctx.protocol === 'anthropic'
      ? buildAnthropicBody({ model: ctx.model, input: view.history, instructions, tools, maxOutputTokens: outputTokens, promptCaching: ctx.promptCaching === true, stream: streaming, replay: replaying ? { origin } : null })
      : buildChatBody({ model: ctx.model, input: view.history, instructions, tools, stream: streaming, includeUsage });
    if (reasoning) applyReasoning(body, reasoning);

    let response, raw, streamed = null, streamError = null;
    // A request that streams is bounded by clocks of its own (see createStreamClock); one that does not, by the request timeout alone.
    const clock = streaming ? createStreamClock({ signal, headersMs: limits.requestTimeoutMs, idleMs: limits.idleTimeoutMs, totalMs: limits.streamTotalMs }) : null;
    try {
      const guard = clock ? clock.signal : (signal ? AbortSignal.any([signal, AbortSignal.timeout(limits.requestTimeoutMs)]) : AbortSignal.timeout(limits.requestTimeoutMs));
      beforeModelRequest();
      response = await ctx.fetch(ctx.endpoint, { method: 'POST', headers: ctx.headers, body: JSON.stringify(body), signal: guard, redirect: 'error' });
      clock?.started();
      if (streaming && response.ok && isEventStream(response)) {
        const reader = makeReader({ onToken: async (piece) => { shown += piece.length; await onToken(piece); }, usedCallIds });
        await readSse(response.body, { signal: clock.signal, maxBytes: limits.streamMaxBytes, onChunk: () => clock.touch(), onEvent: (event) => reader.event(event) });
        streamed = reader.finish();
      } else raw = await readBodyText(response);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      // An aborted fetch does not always pass the reason on: when a clock of ours ended the request, the failure is the one it names.
      const failure = clock?.reason() ?? error;
      if (failure?.code === 'sse_too_large') throw fail('gateway_too_large', 'Phản hồi model vượt giới hạn dung lượng; không tự lặp lại.');
      if (failure?.kind === 'stream_error') streamError = failure;
      else if (streaming && (isStreamFallback(failure) || failure?.code === 'sse_no_stream')) {
        // Cut or damaged: nothing of it is used. The same model request without a stream, once; no tool can have run.
        streaming = false; // cut or damaged: the repeat has no stream
        streamGaveUp = true; // ... and the caller is told to remember it, once the repeat is accepted
        await takeBack(); // what was shown is taken back before anything is said or repeated
        await onStatus(`Luồng trả lời của nhà cung cấp kết thúc hoặc hỏng trước khi hoàn tất (${ctx.redact(String(failure.message)).slice(0, 200)}). Không dùng phần dở và không chạy công cụ nào từ nó. Gửi lại đúng yêu cầu model này một lần với stream: false; các bước sau không dùng stream cho model này nữa, văn bản trả lời hiện khi model trả xong. Yêu cầu trước có thể vẫn bị tính phí.`);
        continue;
      } else {
        if (failure?.code?.startsWith?.('gateway_') || !isNetworkFailure(failure)) throw failure;
        if (failure?.name === 'TimeoutError') {
          counters.timeouts += 1;
          if (counters.timeouts > limits.maxTimeouts) throw fail('gateway_timeout', `Model không phản hồi sau ${counters.timeouts} lần chờ ${waited(failure.waitedMs ?? limits.requestTimeoutMs)}. Có thể yêu cầu quá lớn hoặc nhà cung cấp đang nghẽn; thử lại sau hoặc chọn model nhanh hơn.`);
        }
        counters.network += 1;
        if (counters.network > limits.maxNetworkRetries) throw fail('gateway_network', 'Không kết nối được tới nhà cung cấp model sau nhiều lần thử. Kiểm tra mạng, URL và proxy rồi gửi lại.');
        const wait = backoffMs(counters.network, { base: 3000, cap: 30000 });
        await takeBack(); // a lost connection: what was shown is taken back before the wait
        await onStatus(`Mất kết nối tới nhà cung cấp hoặc chưa nhận được phản hồi (lần thử ${counters.network}/${limits.maxNetworkRetries}). Chờ ${Math.ceil(wait / 1000)} giây rồi thử lại model; không chạy lại công cụ. Yêu cầu trước có thể vẫn bị tính phí.`);
        await ctx.sleep(wait, signal);
        continue;
      }
    } finally { clock?.stop(); }

    if (streamed) {
      accepted(); // a stream that was read to its end
      return ctx.protocol === 'anthropic' ? bindThinking(streamed, { model: ctx.model, origin, body }) : streamed;
    }
    let parsed, status;
    if (streamError) {
      // The provider said, inside a stream that began with HTTP 200, what an HTTP answer would have said: it is handled as that answer.
      parsed = streamError.data;
      status = streamError.upstreamStatus;
    } else {
      parsed = parseJson(raw);
      status = response.ok ? embeddedErrorStatus(parsed) : response.status;
      if (status === null) {
        if (!parsed) throw fail('gateway_invalid_json', 'Nhà cung cấp không trả JSON hợp lệ; không tự gửi lại.');
        // The provider refused the thinking setting, stream_options or the stream, and accepted the same request without it.
        accepted(); // a plain answer
        const result = ctx.protocol === 'anthropic' ? bindThinking(normalizeAnthropic(parsed), { model: ctx.model, origin, body }) : normalizeChatCompletion(parsed, { usedCallIds });
        if (wantsStream) await deliverText(result, onToken);
        return result;
      }
    }

    const info = classifyHttpError({ status, data: parsed ?? { error: { message: plainDetail(raw) } }, headers: response?.headers, redact: ctx.redact });

    // The server streams but does not know `stream_options`: the same request once more without them.
    if (streaming && includeUsage && ctx.protocol === 'openai-chat' && refusesStreamOptions(status, parsed, info)) {
      includeUsage = false; // stream_options refused: the repeat has none
      usageDropped = true; // ... and the caller is told to remember it, once the repeat is accepted
      await takeBack();
      const detail = ctx.redact(errorDetail(parsed)).slice(0, 200);
      await onStatus(`Nhà cung cấp không nhận stream_options (HTTP ${status}${detail ? `: ${detail}` : ''}). Gửi lại đúng yêu cầu model này một lần, không kèm stream_options (stream vẫn bật, nhưng không có số token trong luồng); không chạy lại công cụ. Các yêu cầu sau không gửi nó tới endpoint này nữa.`);
      continue;
    }
    // The server cannot stream this model: the same request once more without a stream.
    if (streaming && refusesStream(status, parsed, info)) {
      streaming = false; // refused: the repeat has no stream
      streamGaveUp = true; // the refusal is remembered once the repeat is accepted
      await takeBack(); // a refusal that came inside a stream: what was shown before it
      const detail = ctx.redact(errorDetail(parsed)).slice(0, 200);
      await onStatus(`Nhà cung cấp từ chối stream: true (HTTP ${status}${detail ? `: ${detail}` : ''}). Gửi lại đúng yêu cầu model này một lần với stream: false; không chạy lại công cụ. Các bước sau không thử stream nữa, văn bản trả lời hiện khi model trả xong.`);
      continue;
    }

    // The provider does not take the thinking setting (for this model): the same model request once more without it. Never a tool call, so nothing can be replayed.
    if (reasoning && refusesReasoning({ status, data: parsed, info, sent: true })) {
      reasoning = null;
      reasoningDropped = true;
      const detail = ctx.redact(errorDetail(parsed)).slice(0, 200);
      await onStatus(`Nhà cung cấp từ chối thiết lập mức suy luận (thinking effort) cho model này (HTTP ${status}${detail ? `: ${detail}` : ''}). Gửi lại đúng yêu cầu model này một lần, không kèm thiết lập đó; không chạy lại công cụ. Các yêu cầu sau không gửi nó cho model này nữa.`);
      continue;
    }

    // The server does not take the thinking blocks it was sent back (a gateway that is not Anthropic's, or a check that reads "the same conversation" otherwise than the Hub does): the same
    // model request once more without them. Never a tool call, so nothing can be replayed; the caller remembers the refusal for this endpoint and model.
    if (hasThinkingBlocks(body) && refusesThinkingReplay(status, errorDetail(parsed))) {
      replaying = false;
      replayDropped = true;
      await takeBack();
      const detail = ctx.redact(errorDetail(parsed)).slice(0, 200);
      await onStatus(`Nhà cung cấp từ chối các khối thinking được gửi lại (HTTP ${status}${detail ? `: ${detail}` : ''}). Gửi lại đúng yêu cầu model này một lần, không kèm các khối đó; không chạy lại công cụ. Các yêu cầu sau không gửi lại khối thinking cho model này nữa.`);
      continue;
    }

    if (info.kind === 'context') {
      counters.compactions += 1;
      const sentBytes = historyBytes(view.history);
      if (counters.compactions > limits.maxCompactions || sentBytes < 8 * 1024) {
        throw upstreamError(info, ' Hội thoại đã được rút gọn nhưng vẫn quá lớn cho model này. Chọn model có ngữ cảnh lớn hơn, đặt đúng "Ngữ cảnh model", hoặc bắt đầu phiên mới.');
      }
      rejectedBytes = sentBytes;
      maxBytes = Math.floor(sentBytes * 0.7);
      announcedBytes = null;
      continue;
    }
    if (info.kind === 'max_tokens' && info.limit && info.limit < outputTokens && !limitRetried) {
      limitRetried = true;
      outputTokens = info.limit;
      ctx.onOutputLimit?.(info.limit);
      await onStatus(`Model chỉ cho phép tối đa ${info.limit} token đầu ra; thử lại với giới hạn này.`);
      continue;
    }
    if (info.retryable) {
      counters.http += 1;
      if (counters.http > limits.maxHttpRetries || (info.retryAfterMs ?? 0) > limits.giveUpAfterMs) {
        throw upstreamError(info, info.retryAfterMs ? ` Nhà cung cấp yêu cầu chờ khoảng ${Math.ceil(info.retryAfterMs / 1000)} giây; Hub không chờ lâu như vậy. Thử lại sau.` : ` Đã thử ${counters.http - 1} lần; dừng thay vì chờ vô hạn.`);
      }
      const wait = Math.min(limits.maxWaitMs, Math.max(info.retryAfterMs ?? 0, backoffMs(counters.http)));
      await takeBack(); // a retried HTTP error: what was shown is taken back before the wait
      await onStatus(`${info.message} Chờ ${Math.ceil(wait / 1000)} giây rồi thử lại (${counters.http}/${limits.maxHttpRetries}); không chạy lại công cụ.`);
      await ctx.sleep(wait, signal);
      continue;
    }
    throw upstreamError(info);
  }
}
