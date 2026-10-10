// Asking a provider which models an account can use. URL building and parsing are pure; fetchModelList does the HTTP.
import { anthropicEndpoint, parseAnthropicModels } from './anthropic-api.mjs';
import { classifyHttpError, readBodyText } from './model-http.mjs';

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
export const MODEL_LIST_LIMIT = 300;
export const MODEL_LIST_MAX_PAGES = 3;

/** URL of the first page of the model list for a protocol, or null when it cannot be derived (custom endpoint paths). */
export function modelsUrl(protocol, base, customPath = '') {
  if (customPath) return null;
  const trimmed = base.replace(/\/+$/, '');
  if (protocol === 'anthropic') return `${anthropicEndpoint(base, 'models')}?limit=1000`;
  if (protocol === 'gemini') return `${/\/v1beta$/.test(trimmed) ? trimmed : `${trimmed}/v1beta`}/models?pageSize=1000`;
  return `${/\/v1$/.test(trimmed) ? trimmed : `${trimmed}/v1`}/models`;
}

/** URL of the next page, or null when the provider says there is none. */
export function nextModelsUrl(protocol, firstUrl, data) {
  const url = new URL(firstUrl);
  if (protocol === 'anthropic' && data?.has_more === true && typeof data.last_id === 'string') {
    url.searchParams.set('after_id', data.last_id);
    return url.href;
  }
  if (protocol === 'gemini' && typeof data?.nextPageToken === 'string' && data.nextPageToken) {
    url.searchParams.set('pageToken', data.nextPageToken);
    return url.href;
  }
  return null;
}

// Not usable for an agent that talks and calls tools. Matching is on the id only, so a local model that merely has
// "audio" somewhere in its name is the only thing that could be hidden; typing its id by hand still works.
const NOT_FOR_CHAT = /(?:embed|whisper|tts|dall-e|moderation|gpt-image|transcribe|realtime|rerank|\bsora\b|davinci|babbage|text-search|text-similarity|imagen|veo)/i;

export function parseOpenAiModels(data) {
  const list = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
  return list
    .map((entry) => (typeof entry === 'string' ? { id: entry } : entry))
    .filter((entry) => isObject(entry) && typeof (entry.id ?? entry.name) === 'string')
    .map((entry) => ({ id: entry.id ?? entry.name, name: entry.id ?? entry.name }));
}

export function parseGeminiModels(data) {
  if (!Array.isArray(data?.models)) return [];
  return data.models
    .filter((entry) => typeof entry?.name === 'string' && (!Array.isArray(entry.supportedGenerationMethods) || entry.supportedGenerationMethods.includes('generateContent')))
    .map((entry) => {
      const id = entry.name.replace(/^models\//, '');
      return { id, name: typeof entry.displayName === 'string' && entry.displayName ? `${entry.displayName} (${id})` : id };
    });
}

export function parseModels(protocol, data) {
  if (protocol === 'anthropic') return parseAnthropicModels(data);
  if (protocol === 'gemini') return parseGeminiModels(data);
  return parseOpenAiModels(data);
}

/** De-duplicated, chat-capable, sorted, bounded. The configured model is always present so a selection is never lost. */
export function finishModelList(models, configuredId) {
  const seen = new Set();
  const kept = [];
  for (const model of models) {
    if (!model?.id || seen.has(model.id) || NOT_FOR_CHAT.test(model.id) || model.id.length > 150) continue;
    seen.add(model.id);
    kept.push(model);
  }
  kept.sort((a, b) => a.id.localeCompare(b.id));
  const bounded = kept.slice(0, MODEL_LIST_LIMIT);
  if (configuredId && !seen.has(configuredId)) bounded.unshift({ id: configuredId, name: configuredId, configured: true, listed: false });
  return bounded;
}

/**
 * Ask the provider for its models. Never throws for a provider problem: the caller gets the configured model back with a
 * warning, so the Settings page still works (the model name can be typed by hand).
 *
 * @param {object} ctx fixed for the whole call: {protocol, base, customPath, headers, model, fetch, redact, signal?, timeoutMs?}
 * @returns {Promise<{models: object[], source: 'provider'|'configured', warning?: string}>}
 */
export async function fetchModelList(ctx) {
  const configured = finishModelList([], ctx.model);
  const fallback = (warning) => ({ models: configured, source: 'configured', warning });
  const first = modelsUrl(ctx.protocol, ctx.base, ctx.customPath);
  if (!first) return fallback('Endpoint tùy chỉnh: Hub không đoán được đường dẫn danh sách model. Nhập tên model thủ công.');
  const collected = [];
  let url = first;
  for (let page = 0; page < MODEL_LIST_MAX_PAGES && url; page += 1) {
    ctx.signal?.throwIfAborted();
    let response, raw;
    try {
      const timeout = AbortSignal.timeout(ctx.timeoutMs ?? 10000);
      response = await ctx.fetch(url, { method: 'GET', headers: ctx.headers, signal: ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout, redirect: 'error' });
      raw = await readBodyText(response, 4 * 1024 * 1024);
    } catch (error) {
      if (ctx.signal?.aborted) throw ctx.signal.reason;
      return fallback(`Không lấy được danh sách model: ${ctx.redact(error?.name === 'TimeoutError' ? 'quá thời gian chờ' : (error?.message || 'lỗi kết nối'))}. Nhập tên model thủ công.`);
    }
    let data = null;
    try { data = JSON.parse(raw); } catch { /* handled below */ }
    if (!response.ok) return fallback(`${classifyHttpError({ status: response.status, data, headers: response.headers, redact: ctx.redact }).message} Nhập tên model thủ công.`);
    if (!isObject(data)) return fallback('Danh sách model nhận được không đúng định dạng. Nhập tên model thủ công.');
    collected.push(...parseModels(ctx.protocol, data));
    url = nextModelsUrl(ctx.protocol, first, data);
  }
  if (!collected.length) return fallback('Nhà cung cấp không trả model nào cho tài khoản này. Nhập tên model thủ công.');
  return { models: finishModelList(collected, ctx.model), source: 'provider' };
}
