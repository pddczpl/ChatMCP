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
import { buildChatBody, normalizeChatCompletion } from './openai-chat-api.mjs';
import { compactHistory, historyBytes, pairToolCalls } from './model-history.mjs';
import { backoffMs, classifyHttpError, readBodyText } from './model-http.mjs';

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message, statusCode = 502) => Object.assign(new Error(message), { code, statusCode });
const kib = (bytes) => Math.round(bytes / 1024);

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
});

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
 * @param {object} [ctx.limits] overrides of LIMITS (tests)
 */
export async function respondStandard(ctx, { input, instructions, tools = [], signal, onStatus = async () => {}, maxOutputTokens, beforeModelRequest = () => {} } = {}) {
  const limits = { ...LIMITS, ...ctx.limits };
  const history = pairToolCalls(input);
  const usedCallIds = new Set(history.filter((item) => item?.type === 'function_call').map((item) => item.call_id));
  let outputTokens = Math.floor(Number.isFinite(maxOutputTokens) && maxOutputTokens > 0 ? maxOutputTokens : limits.defaultOutputTokens);
  if (ctx.outputLimit) outputTokens = Math.min(outputTokens, ctx.outputLimit);
  const fixedBytes = Buffer.byteLength(String(instructions)) + Buffer.byteLength(JSON.stringify(tools));
  let maxBytes = historyBudgetBytes({ contextWindowTokens: ctx.contextWindowTokens, outputTokens, fixedBytes, limits });
  const counters = { network: 0, http: 0, timeouts: 0, compactions: 0 };
  let limitRetried = false;
  let announcedBytes = null;
  let rejectedBytes = Infinity;

  const upstreamError = (info, extra = '') => Object.assign(fail(info.code, `${info.message}${extra}`, 502), { kind: info.kind, upstreamStatus: info.status, retryAfterMs: info.retryAfterMs });

  while (true) {
    signal?.throwIfAborted();
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
      ? buildAnthropicBody({ model: ctx.model, input: view.history, instructions, tools, maxOutputTokens: outputTokens, promptCaching: ctx.promptCaching === true })
      : buildChatBody({ model: ctx.model, input: view.history, instructions, tools });

    let response, raw;
    try {
      const timeout = AbortSignal.timeout(limits.requestTimeoutMs);
      beforeModelRequest();
      response = await ctx.fetch(ctx.endpoint, { method: 'POST', headers: ctx.headers, body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: 'error' });
      raw = await readBodyText(response);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error?.code?.startsWith?.('gateway_') || !isNetworkFailure(error)) throw error;
      if (error?.name === 'TimeoutError') {
        counters.timeouts += 1;
        if (counters.timeouts > limits.maxTimeouts) throw fail('gateway_timeout', `Model không phản hồi sau ${counters.timeouts} lần chờ ${Math.round(limits.requestTimeoutMs / 60000)} phút. Có thể yêu cầu quá lớn hoặc nhà cung cấp đang nghẽn; thử lại sau hoặc chọn model nhanh hơn.`);
      }
      counters.network += 1;
      if (counters.network > limits.maxNetworkRetries) throw fail('gateway_network', 'Không kết nối được tới nhà cung cấp model sau nhiều lần thử. Kiểm tra mạng, URL và proxy rồi gửi lại.');
      const wait = backoffMs(counters.network, { base: 3000, cap: 30000 });
      await onStatus(`Mất kết nối tới nhà cung cấp hoặc chưa nhận được phản hồi (lần thử ${counters.network}/${limits.maxNetworkRetries}). Chờ ${Math.ceil(wait / 1000)} giây rồi thử lại model; không chạy lại công cụ. Yêu cầu trước có thể vẫn bị tính phí.`);
      await ctx.sleep(wait, signal);
      continue;
    }

    const parsed = parseJson(raw);
    const status = response.ok ? embeddedErrorStatus(parsed) : response.status;
    if (status === null) {
      if (!parsed) throw fail('gateway_invalid_json', 'Nhà cung cấp không trả JSON hợp lệ; không tự gửi lại.');
      return ctx.protocol === 'anthropic' ? normalizeAnthropic(parsed) : normalizeChatCompletion(parsed, { usedCallIds });
    }

    const info = classifyHttpError({ status, data: parsed ?? { error: { message: plainDetail(raw) } }, headers: response.headers, redact: ctx.redact });

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
      await onStatus(`${info.message} Chờ ${Math.ceil(wait / 1000)} giây rồi thử lại (${counters.http}/${limits.maxHttpRetries}); không chạy lại công cụ.`);
      await ctx.sleep(wait, signal);
      continue;
    }
    throw upstreamError(info);
  }
}
