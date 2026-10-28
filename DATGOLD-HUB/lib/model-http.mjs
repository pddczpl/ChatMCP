// Shared HTTP behaviour of the model adapters: bounded reads, retry timing, and turning an error response into
// something a person can act on. Nothing here talks to the network.
const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

export const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;

/** Read a response body without letting a misbehaving server fill the memory. */
export async function readBodyText(response, maxBytes = MAX_RESPONSE_BYTES) {
  const tooLarge = () => Object.assign(new Error('Phản hồi model vượt giới hạn 12 MiB; không tự lặp lại.'), { code: 'gateway_too_large', statusCode: 502 });
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > maxBytes) throw tooLarge();
        chunks.push(Buffer.from(part.value));
      }
    } finally { await reader.cancel().catch(() => {}); }
    return Buffer.concat(chunks).toString('utf8');
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > maxBytes) throw tooLarge();
  return text;
}

/** `Retry-After` is either a number of seconds or an HTTP date. Returns milliseconds, or null when absent. */
export function retryAfterMs(headers, now = Date.now()) {
  const raw = typeof headers?.get === 'function' ? headers.get('retry-after') : null;
  if (raw === null || raw === undefined || raw === '') return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

/** Waits unless the signal aborts first, in which case the abort reason is thrown. */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/** 2 s, 4 s, 8 s, 16 s ... with +-20 % jitter, never above `cap`. */
export function backoffMs(attempt, { base = 2000, cap = 30000, random = Math.random } = {}) {
  const raw = base * 2 ** Math.max(0, attempt - 1);
  return Math.min(cap, Math.round(raw * (0.8 + random() * 0.4)));
}

export function errorDetail(data) {
  let candidate = '';
  const inner = data?.error;
  if (typeof inner === 'string') candidate = inner;
  else if (isObject(inner)) candidate = typeof inner.message === 'string' ? inner.message : (typeof inner.code === 'string' ? inner.code : '');
  else if (typeof data?.message === 'string') candidate = data.message;
  return candidate.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 650);
}

const CONTEXT_PATTERNS = [
  /context[_ ]length/i, /maximum context/i, /context window/i, /prompt is too long/i, /too many tokens/i, /input is too long/i,
  /request (?:is )?too large/i, /exceeds? the (?:model'?s? )?(?:maximum|limit)/i, /reduce the length/i, /tokens? (?:>|exceed)/i,
];
const QUOTA_PATTERNS = [/insufficient[_ ]quota/i, /credit balance/i, /billing/i, /exceeded your current quota/i, /out of credits?/i, /payment required/i];
// "max_tokens: 16384 > 8192, which is the maximum allowed number of output tokens for ..." (Anthropic)
// "This model supports at most 16384 completion tokens" / "Expected a value <= 16384" (OpenAI)
const OUTPUT_LIMIT_PATTERNS = [/(\d{3,7})\s*,?\s*which is the maximum allowed number of output tokens/i, /supports at most (\d{3,7}) (?:completion|output) tokens/i, /expected a value <= (\d{3,7})/i];
export function outputTokenLimit(detail) {
  for (const pattern of OUTPUT_LIMIT_PATTERNS) {
    const match = pattern.exec(String(detail));
    if (match) return Number(match[1]);
  }
  return null;
}
const MODEL_PATTERNS = [/model.*not.*found/i, /model_not_found/i, /does not exist/i, /unknown model/i, /invalid model/i, /not_found_error/i];

/**
 * @returns {{code: string, kind: string, retryable: boolean, message: string, status: number, retryAfterMs: number|null, limit?: number}}
 *   kind: auth | quota | rate_limit | overloaded | server | context | max_tokens | model | route | request
 */
export function classifyHttpError({ status, data, headers, redact = (text) => text }) {
  const detail = redact(errorDetail(data));
  const retryAfter = retryAfterMs(headers);
  const suffix = detail ? `: ${detail}` : '.';
  const make = (kind, code, retryable, message, extra = {}) => ({ code, kind, retryable, message, status, retryAfterMs: retryAfter, ...extra });
  if (status === 401 || status === 403) return make('auth', 'gateway_auth', false, `Model từ chối khóa API (HTTP ${status})${suffix} Kiểm tra API key, quyền của key và kiểu header xác thực.`);
  if (status === 402 || (status === 429 && QUOTA_PATTERNS.some((pattern) => pattern.test(detail))) || (status === 400 && QUOTA_PATTERNS.some((pattern) => pattern.test(detail)))) {
    return make('quota', 'gateway_quota', false, `Tài khoản API hết hạn mức hoặc chưa có thanh toán (HTTP ${status})${suffix} Xem Billing/Usage của nhà cung cấp.`);
  }
  if (status === 429) return make('rate_limit', 'gateway_rate_limit', true, `Nhà cung cấp đang giới hạn tốc độ (HTTP 429)${suffix} Kiểm tra hạn mức/rate limit.`);
  if (status === 413 || (status === 400 && CONTEXT_PATTERNS.some((pattern) => pattern.test(detail)))) {
    return make('context', 'gateway_context_length', false, `Cuộc hội thoại vượt giới hạn ngữ cảnh của model (HTTP ${status})${suffix}`);
  }
  if (status === 400) {
    const limit = outputTokenLimit(detail);
    if (limit) return make('max_tokens', 'gateway_http_error', false, `Giới hạn token đầu ra không hợp lệ (HTTP 400)${suffix}`, { limit });
  }
  if (status === 404 || (status === 400 && MODEL_PATTERNS.some((pattern) => pattern.test(detail)))) {
    // Anthropic reports an unknown model as type "not_found_error" with the message "model: <id>"; an unknown route has the
    // same type, so the type alone is not enough.
    const typeText = [data?.error?.type, data?.error?.code].filter((value) => typeof value === 'string').join(' ');
    const model = MODEL_PATTERNS.some((pattern) => pattern.test(detail)) || /model_not_found/i.test(typeText) || (/not_found_error/i.test(typeText) && /\bmodel\b/i.test(detail));
    return make(model ? 'model' : 'route', model ? 'gateway_model_not_found' : 'gateway_http_error', false, model ? `Model đã chọn không khả dụng với tài khoản này (HTTP ${status})${suffix} Chọn model khác trong phần cấu hình.` : `Không tìm thấy đường dẫn API (HTTP 404)${suffix} Kiểm tra Base URL và giao thức.`);
  }
  if (status === 529 || status === 503) return make('overloaded', 'gateway_overloaded', true, `Nhà cung cấp đang quá tải (HTTP ${status})${suffix}`);
  if (status === 408 || status === 409 || (status >= 500 && status < 600)) return make('server', 'gateway_http_error', true, `Lỗi từ nhà cung cấp (HTTP ${status})${suffix}`);
  return make('request', 'gateway_http_error', false, `Nhà cung cấp từ chối yêu cầu (HTTP ${status})${suffix}`);
}
