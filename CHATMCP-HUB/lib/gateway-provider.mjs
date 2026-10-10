import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJson, writeJson } from './runtime.mjs';
import { geminiTextEnvelope, normalizeGeminiTextReply, unsupportedGeminiFields } from './gemini-compat.mjs';
import { createProtector } from './secret-box.mjs';
import { customPresetId, detectEnvKeys, isLoopbackUrl, originOf, presetById } from './provider-presets.mjs';
import { anthropicEndpoint, anthropicHeaders, normalizeAnthropic } from './anthropic-api.mjs';
import { asChatMessages, normalizeChatCompletion } from './openai-chat-api.mjs';
import { respondStandard } from './standard-adapter.mjs';
import { estimateTokens } from './model-history.mjs';
import { classifyHttpError, sleep as waitFor } from './model-http.mjs';
import { fetchModelList } from './model-list.mjs';

// These stay importable from here: other modules and the tests have always taken them from this file.
export { asChatMessages, normalizeChatCompletion };

// Direct API mode is deliberately independent of the ChatGPT Web companion.
// API credentials never pass through the browser extension or the MCP transport.
const FORMATS = ['gemini', 'openai-chat', 'anthropic'];
const AUTH_MODES = ['auto', 'google-key', 'bearer'];
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const modelOK = (v) => typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:\/-]{0,150}$/.test(v);
const bad = (code, message, statusCode = 400) => Object.assign(new Error(message), { code, statusCode });

// Provider errors are untrusted input. Show a bounded diagnostic, never raw
// request/response bodies or authentication headers. The caller additionally
// redacts all registered API keys before rendering/logging this message.
export function gatewayErrorDetail(data) {
  let candidate = '';
  const inner = data?.error;
  if (typeof inner === 'string') candidate = inner;
  else if (isObject(inner)) candidate = typeof inner.message === 'string' ? inner.message : (typeof inner.code === 'string' ? inner.code : '');
  else if (typeof data?.message === 'string') candidate = data.message;
  if (!candidate) return '';
  return candidate.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 650);
}
function noSecrets(message, redact) {
  return redact(message)
    .replace(/(?:x-goog-api-key|authorization|api[_-]?key|access[_-]?token)\s*[=:]\s*[^\s,;]+/gi, '[REDACTED]')
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[REDACTED]');
}
function probePayload(protocol, model) {
  if (protocol === 'gemini') return { contents: [{ role: 'user', parts: [{ text: 'Reply OK.' }] }] };
  if (protocol === 'anthropic') return { model, max_tokens: 32, messages: [{ role: 'user', content: 'Reply OK.' }] };
  return { model, messages: [{ role: 'user', content: 'Reply OK.' }], stream: false };
}


export function validateBaseUrl(value) {
  if (typeof value !== 'string' || value.length > 512 || !value.trim()) throw bad('invalid_base_url', 'Cần URL API Gateway hợp lệ.');
  let url;
  try { url = new URL(value.trim()); } catch { throw bad('invalid_base_url', 'Địa chỉ API Gateway không hợp lệ.'); }
  if (url.username || url.password || url.search || url.hash) throw bad('invalid_base_url', 'URL API không được chứa mật khẩu, query hoặc fragment.');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) {
    throw bad('insecure_base_url', 'API key chỉ được gửi tới HTTPS; chỉ localhost mới được dùng HTTP.');
  }
  return url.href.replace(/\/+$/, '');
}
export function buildEndpoint(base, protocol, model, customPath = '') {
  if (!FORMATS.includes(protocol) || !modelOK(model)) throw bad('invalid_gateway_config', 'Giao thức API hoặc model không hợp lệ.');
  const url = validateBaseUrl(base);
  if (customPath) {
    if (typeof customPath !== 'string' || customPath.length > 400 || customPath.startsWith('//') || customPath.split('/').includes('..') || !/^\/[A-Za-z0-9_./:{}-]+$/.test(customPath)) throw bad('invalid_api_path', 'Đường dẫn API tùy chỉnh không hợp lệ. Dùng ví dụ /v1beta/models/{model}:generateContent.');
    return new URL(customPath.replaceAll('{model}', encodeURIComponent(model)), new URL(url).origin).href;
  }
  if (protocol === 'gemini') {
    const stem = /\/v1beta$/.test(url) ? url : `${url}/v1beta`;
    return `${stem}/models/${encodeURIComponent(model)}:generateContent`;
  }
  if (protocol === 'anthropic') return anthropicEndpoint(url);
  const stem = /\/v1$/.test(url) ? url : `${url}/v1`;
  return `${stem}/chat/completions`;
}
function geminiSchema(schema) {
  if (!isObject(schema)) return { type: 'string' };
  let type = schema.type;
  if (Array.isArray(type)) type = type.find((x) => x !== 'null') || 'string';
  const result = { type: (type || 'object').toLowerCase() };
  if (schema.description) result.description = String(schema.description);
  if (Array.isArray(schema.enum)) result.enum = schema.enum.filter((v) => typeof v === 'string');
  if (isObject(schema.properties)) result.properties = Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, geminiSchema(v)]));
  if (schema.items) result.items = geminiSchema(schema.items);
  if (Array.isArray(schema.required)) result.required = schema.required;
  if (Array.isArray(schema.type) && schema.type.includes('null')) result.nullable = true;
  if (typeof schema.minimum === 'number') result.minimum = schema.minimum;
  if (typeof schema.maximum === 'number') result.maximum = schema.maximum;
  return result;
}
function contentText(items) {
  if (typeof items === 'string') return items;
  if (!Array.isArray(items)) return '';
  return items.map((x) => x?.text || '').filter(Boolean).join('\n');
}
function outputText(output) {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    return output.map((x) => {
      if (x?.type === 'input_text') return x.text || '';
      if (x?.type === 'input_image') return '[Image returned by MCP. This gateway adapter cannot inspect the image; do not claim to have viewed it.]';
      return JSON.stringify(x);
    }).join('\n');
  }
  return JSON.stringify(output ?? null);
}
function referencedCalls(history) {
  return new Map(history.filter((x) => x?.type === 'function_call' && x.call_id && x.name)
    .map((x) => [x.call_id, { name: x.name, providerCallId: x.providerCallId }]));
}
export function asGeminiContents(history) {
  const calls = referencedCalls(history);
  const result = [];
  function add(role, part) {
    if (!part) return;
    const prev = result.at(-1);
    if (prev?.role === role) prev.parts.push(part);
    else result.push({ role, parts: [part] });
  }
  for (const x of history) {
    if (x?.role === 'user') add('user', { text: contentText(x.content) });
    else if (x?.type === 'message' && x.role === 'assistant') {
      for (const part of (Array.isArray(x.providerParts) && x.providerParts.length ? x.providerParts : [{ text: contentText(x.content) }])) add('model', part);
    }
    else if (x?.type === 'function_call') {
      // Some Gemini gateways omit function-call IDs. Names still bind the reply.
      add('model', x.providerPart || { functionCall: { name: x.name, args: JSON.parse(x.arguments || '{}'), ...(x.providerCallId ? { id: x.providerCallId } : {}) } });
    } else if (x?.type === 'function_call_output') {
      const match = calls.get(x.call_id);
      if (!match) throw bad('unbound_tool_result', 'Kết quả công cụ không có lời gọi tương ứng.');
      add('user', { functionResponse: { name: match.name, ...(match.providerCallId ? { id: match.providerCallId } : {}), response: { output: outputText(x.output) } } });
    }
  }
  return result;
}
export function normalizeGemini(result) {
  if (!Array.isArray(result?.candidates) || !result.candidates.length) throw bad('model_empty', 'Gemini không trả candidate; kiểm tra safety/response của gateway.', 502);
  const candidate = result.candidates[0];
  if (!['STOP', 'FINISH_REASON_UNSPECIFIED', undefined].includes(candidate.finishReason)) throw bad('model_incomplete', `Gemini dừng trước khi hoàn tất (${candidate.finishReason}).`, 502);
  const parts = candidate.content?.parts;
  if (!Array.isArray(parts)) throw bad('model_empty', 'Gemini không trả nội dung hợp lệ.', 502);
  const output = [];
  const visible = parts.filter((part) => part?.thought !== true && typeof part?.text === 'string').map((part) => part.text).join('\n');
  if (visible) output.push({ type: 'message', role: 'assistant', phase: parts.some((x) => x?.functionCall) ? 'commentary' : 'final', content: [{ type: 'output_text', text: visible }], providerParts: parts.filter((p) => p?.thought !== true && typeof p?.text === 'string').map((p) => ({ text: p.text, ...(p.thoughtSignature ? { thoughtSignature: p.thoughtSignature } : {}) })) });
  for (const part of parts) {
    if (!part?.functionCall) continue;
    const { name, args = {}, id } = part.functionCall;
    if (typeof name !== 'string' || !isObject(args)) throw bad('model_invalid_function', 'Gemini trả lời gọi công cụ không hợp lệ.', 502);
    output.push({ type: 'function_call', name, call_id: randomUUID(), arguments: JSON.stringify(args), status: 'completed', ...(id ? { providerCallId: id } : {}), providerPart: structuredClone(part) });
  }
  if (!output.length) throw bad('model_empty', 'Gemini không trả văn bản hoặc lời gọi công cụ.', 502);
  return { status: 'completed', output, usage: { input_tokens: Number(result.usageMetadata?.promptTokenCount) || 0, output_tokens: Number(result.usageMetadata?.candidatesTokenCount) || 0 } };
}
const CONTEXT_MIN = 2000;
const CONTEXT_MAX = 10_000_000;
/** null = "not set" (also what clearing sends); undefined = not a valid window. */
function parseContextWindow(value) {
  if (value === null || value === '' || value === 0 || value === '0') return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= CONTEXT_MIN && number <= CONTEXT_MAX ? number : undefined;
}
/** Environment variables whose value may be used as the key for this endpoint: only the ones of a matching preset. */
function envNamesFor(presetId, protocol, base) {
  const entry = presetById(presetId);
  if (entry?.keyEnv.length && originOf(base) === originOf(entry.apiBaseUrl) && protocol === entry.protocol) return entry.keyEnv;
  // Installations that predate presets used GOOGLE_API_KEY for their Gemini gateway; keep that working.
  if (!entry && protocol === 'gemini') return ['GOOGLE_API_KEY'];
  return [];
}
function firstEnv(env, names) {
  for (const name of names) {
    const value = typeof env[name] === 'string' ? env[name].trim() : '';
    if (value) return { name, value };
  }
  return null;
}
const checkKey = (key) => {
  if (typeof key !== 'string' || (key && (key.trim().length < 12 || key.length > 2048 || /\s/.test(key)))) throw bad('invalid_key', 'API key không hợp lệ.');
};

export class GatewayProvider {
  constructor({ directory, bundleRoot, manager, fetchImpl = fetch, env = process.env, protect, unprotect, sleep = waitFor, platform = process.platform, limits } = {}) {
    this.directory = directory;
    this.bundleRoot = bundleRoot;
    this.manager = manager;
    this.fetch = fetchImpl;
    this.env = env;
    this.sleep = sleep;
    this.limits = limits; // overrides of the standard adapter's retry/timeout limits (tests)
    const protector = createProtector({ platform, bundleRoot, directory, env });
    this.protector = protect || unprotect
      ? { kind: 'custom', describe: () => ({ kind: 'custom', persistent: true, protection: 'bộ bảo vệ do ứng dụng nhúng cung cấp' }) }
      : protector;
    this.protect = protect || ((text) => protector.protect(text));
    this.unprotect = unprotect || ((blob) => protector.unprotect(blob));
    this.configFile = path.join(directory, 'gateway-config.json');
    this.keyFile = path.join(directory, 'gateway-key.dpapi'); // the name predates non-Windows storage; kept so existing installs still load
    this.apiBaseUrl = 'https://generativelanguage.googleapis.com';
    this.protocol = 'gemini';
    this.preset = '';
    this.authMode = 'auto';
    this.customPath = '';
    this.model = 'gemini-2.5-flash';
    this.contextWindowTokens = null;
    this.apiKey = '';
    this.keySource = 'none';
    this.lastError = '';
    this.outputLimit = null; // largest output the model accepted, learned from an error; reset when the configuration changes
    this.geminiDialect = 'native'; // Reset when gateway configuration changes.
    this.dialectConfirmed = false;
  }
  registerKey(key) { if (key) this.manager.secrets = [...new Set([...(this.manager.secrets ?? []), key])]; }
  redact(value) {
    let str = String(value);
    for (const key of this.manager.secrets ?? []) if (key && typeof key === 'string') str = str.split(key).join('[REDACTED]');
    return str.replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]');
  }
  async load() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    let data = null;
    try { data = await readJson(this.configFile); }
    catch { this.lastError = 'File cấu hình model bị hỏng; hãy nhập lại cấu hình (file cũ chưa bị xóa).'; }
    const base = data?.apiBaseUrl || this.env.GOOGLE_API_BASE_URL;
    if (base) try { this.apiBaseUrl = validateBaseUrl(base); } catch { this.lastError = 'URL API đã lưu không hợp lệ; cần nhập lại.'; }
    if (FORMATS.includes(data?.protocol)) this.protocol = data.protocol;
    if (AUTH_MODES.includes(data?.authMode) && !(this.protocol === 'anthropic' && data.authMode === 'google-key')) this.authMode = data.authMode;
    if (typeof data?.preset === 'string' && presetById(data.preset)) this.preset = data.preset;
    this.contextWindowTokens = parseContextWindow(data?.contextWindowTokens) ?? null;
    if (typeof data?.customPath === 'string') { try { buildEndpoint(this.apiBaseUrl, this.protocol, this.model, data.customPath); this.customPath = data.customPath; } catch { this.lastError = 'Đường dẫn endpoint lưu trước đây không hợp lệ.'; } }
    if (modelOK(data?.model || this.env.GEMINI_MODEL)) this.model = data?.model || this.env.GEMINI_MODEL;
    let encrypted = '';
    try { encrypted = (await fs.readFile(this.keyFile, 'utf8')).trim(); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (encrypted) {
      try { const record = JSON.parse(encrypted); this.apiKey = await this.unprotect(record.protected); this.keySource = 'saved'; }
      catch (error) { this.lastError = error?.code && /^(secret_|dpapi_)/.test(error.code) ? error.message : 'Không giải mã được key đã lưu. Nhập lại key.'; }
    }
    if (!this.apiKey) {
      const found = firstEnv(this.env, envNamesFor(this.preset, this.protocol, this.apiBaseUrl));
      if (found) { this.apiKey = found.value; this.keySource = 'environment'; }
    }
    this.registerKey(this.apiKey);
  }
  state() {
    return {
      provider: 'gateway', preset: this.preset, protocol: this.protocol, model: this.model, apiBaseUrl: this.apiBaseUrl, authMode: this.authMode, customPath: this.customPath,
      contextWindowTokens: this.contextWindowTokens, configured: this.ready(), keyRequired: this.keyRequired(), keySource: this.keySource,
      secretStorage: this.protector.describe(), lastError: this.lastError,
      agentRequestMode: this.protocol === 'gemini' ? (this.dialectConfirmed ? this.geminiDialect : 'chưa kiểm tra tool calling') : this.protocol === 'anthropic' ? 'anthropic-tool-use' : 'openai-tool-calls',
    };
  }
  snapshot() { return { provider: `gateway:${this.protocol}`, model: this.model }; }
  /** Names (never values) of provider key variables present in the environment, for the Settings page. */
  envKeys() { return detectEnvKeys(this.env); }
  keyRequired() { return !isLoopbackUrl(this.apiBaseUrl); }
  async clearKey() {
    await fs.unlink(this.keyFile).catch(e => { if (e.code !== 'ENOENT') throw e; });
    this.apiKey = ''; this.keySource = 'none';
    return this.state();
  }
  ready() { return (Boolean(this.apiKey) || !this.keyRequired()) && modelOK(this.model) && Boolean(this.apiBaseUrl); }

  /** Everything configure() decides, without changing anything. Throws on any invalid input. */
  #plan(input = {}) {
    const { preset: requested, apiBaseUrl, protocol, model, authMode, customPath, contextWindowTokens, apiKey, remember = false, useEnvKey = false } = input ?? {};
    let entry = null;
    if (requested !== undefined && requested !== null && requested !== '') {
      entry = presetById(String(requested));
      if (!entry) throw bad('invalid_preset', 'Nhà cung cấp không có trong danh sách.');
    }
    // Choosing another provider starts from ITS values; anything else keeps what is configured now.
    const switching = Boolean(entry) && entry.id !== this.preset;
    const defaults = switching
      ? { apiBaseUrl: entry.apiBaseUrl, protocol: entry.protocol, model: entry.defaultModel, authMode: entry.authMode, customPath: entry.customPath, contextWindowTokens: entry.contextWindowTokens }
      : { apiBaseUrl: this.apiBaseUrl, protocol: this.protocol, model: this.model, authMode: this.authMode, customPath: this.customPath, contextWindowTokens: this.contextWindowTokens };
    const base = validateBaseUrl(apiBaseUrl ?? defaults.apiBaseUrl);
    const nextProtocol = protocol ?? defaults.protocol;
    const nextModel = model ?? defaults.model;
    const nextAuth = authMode ?? defaults.authMode;
    const nextPath = customPath ?? defaults.customPath;
    if (!FORMATS.includes(nextProtocol)) throw bad('invalid_protocol', 'Chọn giao thức Gemini, OpenAI-compatible hoặc Anthropic.');
    if (!modelOK(nextModel)) throw bad('invalid_model', 'Tên model không hợp lệ.');
    if (!AUTH_MODES.includes(nextAuth) || (nextProtocol === 'anthropic' && nextAuth === 'google-key')) throw bad('invalid_auth_mode', 'Kiểu xác thực API không hợp lệ.');
    buildEndpoint(base, nextProtocol, nextModel, nextPath);
    const window = contextWindowTokens === undefined ? defaults.contextWindowTokens : parseContextWindow(contextWindowTokens);
    if (window === undefined) throw bad('invalid_context_window', `Ngữ cảnh model phải là số token từ ${CONTEXT_MIN.toLocaleString('en-US')} đến ${CONTEXT_MAX.toLocaleString('en-US')} (để trống nếu không biết).`);

    // A preset describes one provider. If the endpoint or protocol no longer matches, it is a custom connection now.
    let nextPreset = entry ? entry.id : this.preset;
    const current = presetById(nextPreset);
    if (current) {
      const custom = current.id.startsWith('custom-');
      const drifted = custom ? current.protocol !== nextProtocol : (originOf(base) !== originOf(current.apiBaseUrl) || nextProtocol !== current.protocol);
      if (drifted) nextPreset = customPresetId(nextProtocol);
    }

    // Which key goes to which host. A key is never carried over to a different origin or provider.
    let key, fromEnv = false;
    if (apiKey !== undefined && apiKey !== null && apiKey !== '') key = apiKey;
    else if (useEnvKey === true) {
      const names = envNamesFor(nextPreset, nextProtocol, base);
      const found = firstEnv(this.env, names);
      if (!found) throw bad('missing_env_key', names.length ? `Không thấy biến môi trường ${names.join(' hoặc ')} (hoặc nó đang trống). Đặt biến rồi khởi động lại Hub, hoặc nhập key trực tiếp.` : 'Kết nối này không có biến môi trường mặc định; nhập key trực tiếp.', 409);
      key = found.value; fromEnv = true;
    } else if (switching || originOf(base) !== originOf(this.apiBaseUrl)) key = '';
    else key = this.apiKey;
    checkKey(key);
    const keyRequired = !isLoopbackUrl(base);
    if (remember && !key && keyRequired) throw bad('missing_key', 'Nhập API key trước khi lưu.');
    return { base, protocol: nextProtocol, model: nextModel, authMode: nextAuth, customPath: nextPath, contextWindowTokens: window, preset: nextPreset, key, fromEnv, persist: Boolean(remember && key && !fromEnv), keyRequired };
  }
  /** Check a configuration without applying it. Never returns or logs the key. */
  validateConfiguration(input) {
    const plan = this.#plan(input);
    return { ok: true, preset: plan.preset, protocol: plan.protocol, apiBaseUrl: plan.base, model: plan.model, authMode: plan.authMode, customPath: plan.customPath, contextWindowTokens: plan.contextWindowTokens, keyRequired: plan.keyRequired, keyProvided: Boolean(plan.key), keyFromEnvironment: plan.fromEnv };
  }
  async configure(input = {}) {
    const plan = this.#plan(input);
    let ciphertext = null;
    if (plan.persist) {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      ciphertext = await this.protect(plan.key);
    }
    // Persist the public configuration first; never write plaintext credentials.
    await writeJson(this.configFile, { version: 2, preset: plan.preset, apiBaseUrl: plan.base, protocol: plan.protocol, model: plan.model, authMode: plan.authMode, customPath: plan.customPath, contextWindowTokens: plan.contextWindowTokens });
    if (ciphertext) await writeJson(this.keyFile, { protected: ciphertext, scheme: this.protector.kind });
    else await fs.unlink(this.keyFile).catch(e => { if (e.code !== 'ENOENT') throw e; });
    const sameKey = plan.key === this.apiKey;
    this.keySource = plan.fromEnv ? 'environment' : plan.persist ? 'saved' : !plan.key ? 'none' : (sameKey && this.keySource === 'environment' ? 'environment' : 'session');
    this.apiKey = plan.key;
    this.registerKey(plan.key);
    this.apiBaseUrl = plan.base; this.protocol = plan.protocol; this.model = plan.model; this.authMode = plan.authMode; this.customPath = plan.customPath;
    this.preset = plan.preset; this.contextWindowTokens = plan.contextWindowTokens; this.outputLimit = null;
    this.lastError = ''; this.geminiDialect = 'native'; this.dialectConfirmed = false;
    return this.state();
  }
  /** Rough size of a request, for budgets and the context meter. Estimated, not billed. */
  estimateUsage({ input = [], instructions = '', tools = [] } = {}) {
    const inputTokens = estimateTokens({ input, instructions, tools });
    return { estimated: true, inputTokens, contextWindowTokens: this.contextWindowTokens, fraction: this.contextWindowTokens ? inputTokens / this.contextWindowTokens : null };
  }
  /** An error from any model call in one shape the UI and the agent can rely on. Never contains the key. */
  normalizeError(error) {
    const kind = error?.kind ?? (error?.code === 'gateway_network' || error?.code === 'gateway_timeout' ? 'network' : 'unknown');
    return {
      code: error?.code ?? 'gateway_error', kind, retryable: ['rate_limit', 'overloaded', 'server', 'network'].includes(kind),
      status: error?.upstreamStatus ?? null, message: this.redact(String(error?.message ?? error)),
    };
  }
  /** Request headers for one protocol. The key is passed in so a call keeps the credential it started with. */
  #headers(protocol, authMode, apiKey) {
    if (protocol === 'anthropic') return anthropicHeaders(apiKey, authMode === 'bearer' ? 'bearer' : 'auto');
    const headers = { 'Content-Type': 'application/json' };
    if (!apiKey) return headers;
    const googleHeader = authMode === 'google-key' || (authMode === 'auto' && protocol === 'gemini');
    if (googleHeader) headers['x-goog-api-key'] = apiKey; else headers.Authorization = `Bearer ${apiKey}`;
    return headers;
  }
  /** Models the account can use. Falls back to the configured model, with a warning, when the provider cannot be asked. */
  async discoverModels({ signal } = {}) {
    const { protocol, apiBaseUrl: base, customPath, model, authMode, apiKey } = this;
    if (!this.ready()) return { models: [{ id: model, name: model, configured: true, listed: false }], source: 'configured', warning: 'Nhập API key để tải danh sách model.' };
    return await fetchModelList({
      protocol, base, customPath, model, fetch: this.fetch, signal, headers: this.#headers(protocol, authMode, apiKey),
      redact: (text) => noSecrets(String(text), (value) => this.redact(value)),
    });
  }
  async listModels(options) { return (await this.discoverModels(options)).models; }
  // Called only by the user's explicit "Test API / Auto" action. Probe a bounded set of standard dialects against the
  // SAME configured origin. Do not send MCP inventories or project content; these are minimal test calls. If a dialect
  // works, persist the corrected public format without losing a protected key. No mutation occurs when all probes fail.
  async diagnoseConnection({ signal } = {}) {
    if (!this.ready()) throw bad('gateway_not_ready','Hãy nhập URL, model và API key trước khi kiểm tra.',409);
    const apiKey = this.apiKey; // the probe keeps the credential it started with
    const choices = [];
    const push = (protocol, authMode, apiBaseUrl, customPath = '') => {
      const endpoint = buildEndpoint(apiBaseUrl, protocol, this.model, customPath);
      if (new URL(endpoint).origin !== new URL(this.apiBaseUrl).origin) return;
      if (!choices.some(x => x.endpoint === endpoint && x.authMode === authMode)) choices.push({ protocol, authMode, apiBaseUrl, customPath, endpoint });
    };
    if (this.protocol === 'anthropic') {
      // Anthropic and compatible gateways: x-api-key, or Authorization: Bearer for gateways that expect it.
      const [first, second] = this.authMode === 'bearer' ? ['bearer', 'auto'] : ['auto', 'bearer'];
      push('anthropic', first, this.apiBaseUrl, this.customPath);
      push('anthropic', second, this.apiBaseUrl, this.customPath);
    } else {
      const currentAuth = this.authMode === 'auto' ? (this.protocol === 'gemini' ? 'google-key':'bearer') : this.authMode;
      push(this.protocol, currentAuth, this.apiBaseUrl, this.customPath);
      const stem = this.apiBaseUrl.replace(/\/v1(?:beta)?$/,'');
      push('gemini','google-key',stem);
      push('gemini','bearer',stem);
      push('openai-chat','bearer',stem);
      push('openai-chat','google-key',stem);
    }
    const attempts=[];
    for (const item of choices.slice(0,5)) {
      signal?.throwIfAborted();
      let response;
      try {
        const timeout = AbortSignal.timeout(6000);
        const controller = signal ? AbortSignal.any([signal,timeout]):timeout;
        response = await this.fetch(item.endpoint,{
          method:'POST', redirect:'error',signal:controller,
          headers: this.#headers(item.protocol, item.authMode, apiKey),
          body:JSON.stringify(probePayload(item.protocol,this.model)),
        });
        // Protect memory against exceptionally large responses from custom gateways.
        const raw = (await response.text()).slice(0, 32000);
        let data;
        try { data=JSON.parse(raw); } catch { data={}; }
        const redactText = text => noSecrets(String(text), value => this.redact(value));
        const detail=redactText(gatewayErrorDetail(data));
        let good=false;
        if(response.ok) {
          try {
            const parsed=item.protocol==='gemini'?normalizeGemini(data):item.protocol==='anthropic'?normalizeAnthropic(data):normalizeChatCompletion(data);
            good=parsed.output.some(x=>x.type==='message');
          } catch { /* HTTP 200 without a valid model response is not success */ }
        }
        const failure = response.ok ? null : classifyHttpError({ status: response.status, data, headers: response.headers, redact: redactText });
        attempts.push({protocol:item.protocol,authMode:item.authMode,status:response.status,success:good,detail:detail || (!good&&response.ok?'Response không có message hợp lệ':''),...(failure?{kind:failure.kind,message:failure.message}:{})});
        if(good){
          const changed=this.protocol!==item.protocol || this.customPath!==item.customPath || this.authMode!==item.authMode || this.apiBaseUrl!==item.apiBaseUrl;
          if(changed)await this.configure({apiBaseUrl:item.apiBaseUrl,protocol:item.protocol,customPath:item.customPath,authMode:item.authMode,remember:this.keySource==='saved'});
          this.lastError='';
          return {ok:true,responsePresent:true,model:this.model,protocol:item.protocol,authMode:item.authMode,autoSelected:changed,attempts};
        }
      }catch(error){
        if(signal?.aborted)throw signal.reason;
        attempts.push({protocol:item.protocol,authMode:item.authMode,status:null,success:false,detail:noSecrets(String(error?.name==='TimeoutError'?'Quá thời gian 6 giây':error?.message||'Lỗi kết nối'),text=>this.redact(text)).slice(0,200)});
      }
    }
    const details=attempts.map(x=>`${x.protocol}/${x.authMode}: ${x.status?'HTTP '+x.status:'Network'}${x.detail?' ('+x.detail.slice(0,180)+')':''}`).join('; ');
    // A definite answer (bad key, no credit, unknown model, rate limit) says more than "no compatible protocol".
    const definite=attempts.find(x=>['auth','quota','model','rate_limit','overloaded'].includes(x.kind));
    const err=bad('gateway_probe_failed',`${definite?`${definite.message} `:''}Không tìm được giao thức API tương thích trên endpoint đã cấu hình. ${details}. Kiểm tra URL, đường dẫn route và nhật ký của máy chủ/gateway (không cần đổi model nếu model hợp lệ).`,502);
    err.attempts=attempts;
    this.lastError=definite?definite.message.slice(0,300):'Test API thất bại: gateway chưa trả response tương thích.';
    throw err;
  }

  /** One model step. `maxOutputTokens` is honoured by the Anthropic path (where it is required); the others use the provider's own cap. */
  async respond({ input, instructions, tools = [], signal, onStatus = async () => {}, maxOutputTokens } = {}) {
    if (!this.ready()) throw bad('gateway_not_ready', 'Hãy cấu hình API Base URL, model và API key.', 409);
    if (!Array.isArray(input)) throw bad('invalid_input', 'Ngữ cảnh Agent không hợp lệ.');
    if (this.protocol !== 'gemini') return await this.#respondStandard({ input, instructions, tools, signal, onStatus, maxOutputTokens });
    // Gemini keeps its own compatibility loop: gateways in front of it differ a lot (see gemini-compat.mjs).
    const protocol = 'gemini';
    const sourceContextBytes = Buffer.byteLength(JSON.stringify(input),'utf8') + Buffer.byteLength(instructions,'utf8');
    const endpoint = buildEndpoint(this.apiBaseUrl, protocol, this.model, this.customPath);
    const nativeBody = {
      systemInstruction: { parts: [{ text: instructions }] },
      contents: asGeminiContents(input),
      tools: tools.length ? [{ functionDeclarations: tools.map((x) => ({ name: x.name, description: x.description, parameters: geminiSchema(x.parameters) })) }] : undefined,
      generationConfig: { maxOutputTokens: 8192 },
    };
    const inlineInstructions = () => {
      const contents = asGeminiContents(input);
      const instructionPart = { text: `SYSTEM / AGENT INSTRUCTIONS (follow these rules):\n${instructions}` };
      const first = contents[0];
      if(first?.role==='user') first.parts.unshift(instructionPart);
      else contents.unshift({role:'user',parts:[instructionPart]});
      return contents;
    };
    let textRequestBudget = 96 * 1024;
    const bodyForDialect = dialect => {
      if(dialect === 'native') return nativeBody;
      if(dialect === 'no-generation-config') return {...nativeBody, generationConfig:undefined};
      if(dialect === 'inline-instructions') return {contents:inlineInstructions(), tools:nativeBody.tools};
      if(dialect === 'text-protocol') return geminiTextEnvelope(input, instructions, tools, {maxRequestBytes:textRequestBudget, repairHint});
      throw bad('gateway_dialect_invalid','Invalid gateway compatibility dialect');
    };
    // If a minimal Test API succeeds yet native agent tool fields are rejected,
    // discover a compatible payload on that same endpoint without ever changing
    // the authentication header or sending the credential to another origin.
    const dialects = ['native','no-generation-config','inline-instructions','text-protocol'];
    let dialect = this.geminiDialect;
    let dialectIndex = Math.max(0, dialects.indexOf(dialect));
    // A model request has not executed MCP tools yet. If its network response is
    // lost, retry only the model step after backoff, never the preceding MCP call.
    // A repeated model request can still be charged by the gateway; document it.
    let response, data, attempts = 0;
    // A 200 response may still contain an unfinished Gemini candidate.
    // Regeneration only retries the MODEL request; no MCP call has been made.
    const MAX_TEXT_REPAIRS = 2;
    let textRepairCount = 0, repairHint = '', normalizedTextReply, reportedCompaction = false;
    while (true) {
      signal?.throwIfAborted();
      const controller = AbortSignal.timeout(240000);
      const combined = signal ? AbortSignal.any([signal, controller]) : controller;
      try {
        const activeDialect = dialects[dialectIndex];
        const requestBody = bodyForDialect(activeDialect);
        // geminiTextEnvelope applies the byte budget AFTER appending any
        // model-only repair hint, so repair attempts cannot grow to HTTP 413.
        const wireBytes=Buffer.byteLength(JSON.stringify(requestBody),'utf8');
        if (activeDialect === 'text-protocol' && sourceContextBytes > wireBytes && !reportedCompaction) {
          reportedCompaction = true;
          await onStatus(`Đã rút gọn ngữ cảnh gửi Gemini: ${Math.round(sourceContextBytes/1024)} KiB lịch sử cục bộ → ${Math.round(wireBytes/1024)} KiB request. Kết quả MCP đầy đủ vẫn ở nhật ký trên máy; agent phải đọc lại đoạn cần thiết thay vì suy đoán.`, 'context_compaction');
        }
        if (activeDialect === 'text-protocol' && wireBytes > textRequestBudget)
          throw bad('gateway_context_budget','Gemini request vượt ngân sách byte cục bộ; không gửi.',413);
        response = await this.fetch(endpoint, { method: 'POST', headers: this.#headers('gemini', this.authMode, this.apiKey),
          body: JSON.stringify(requestBody), signal: combined, redirect: 'error' });
        let stream;
        if (response.body?.getReader) {
          const reader = response.body.getReader(); let size = 0; const buffers = [];
          try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength;
            if (size > 12*1024*1024) throw bad('gateway_too_large', 'Phản hồi gateway vượt giới hạn 12 MiB; không tự lặp lại.', 502);
            buffers.push(Buffer.from(part.value));
          } } finally { await reader.cancel().catch(()=>{}); }
          stream = Buffer.concat(buffers).toString('utf8');
        } else stream = await response.text();
        if (Buffer.byteLength(stream) > 12*1024*1024) throw bad('gateway_too_large', 'Phản hồi gateway vượt giới hạn 12 MiB; không tự lặp lại.', 502);
        try { data = JSON.parse(stream); }
        catch {
          // Cloud Run / reverse proxies can return HTTP 413 with a plain-text
          // or HTML body. It is still a SIZE error, not a malformed-model
          // success response: compact and retry only the model request.
          if (response.status === 413) data = { error: { message: 'Request body exceeds gateway size limit.' } };
          else throw bad('gateway_invalid_json', 'Gateway không trả JSON hợp lệ; không tự gửi lại.', 502);
        }
        if (response.status === 413) {
          // A gateway may enforce an unusually small request body. Downgrade
          // only the MODEL payload; preceding MCP calls are already journaled
          // and never replayed by this compatibility loop.
          if (activeDialect !== 'text-protocol') {
            dialectIndex = dialects.indexOf('text-protocol');
            await onStatus('Gateway trả HTTP 413 (request quá lớn); chuyển sang JSON text protocol có giới hạn kích thước. Không gọi lại MCP.','context_compaction');
            continue;
          }
          if (textRequestBudget > 32 * 1024) {
            textRequestBudget = textRequestBudget > 64 * 1024 ? 64 * 1024 : 32 * 1024;
            await onStatus(`Gateway trả HTTP 413; giảm request model còn tối đa ${Math.round(textRequestBudget/1024)} KiB và thử lại. Lịch sử MCP đầy đủ vẫn được lưu trên máy; không gọi lại MCP.`, 'context_compaction');
            continue;
          }
        }
        if (!response.ok && dialectIndex < dialects.length - 1 &&
            unsupportedGeminiFields(response.status, gatewayErrorDetail(data))) {
          dialectIndex++;
          await onStatus(`Gateway không chấp nhận field của kiểu request ${dialects[dialectIndex - 1]}; thử tương thích ${dialects[dialectIndex]} trên cùng endpoint (không gọi lại MCP).`);
          continue;
        }
        if (response.ok && activeDialect === 'text-protocol') {
          // Route support is known even when the candidate is unfinished.
          // Cache it, so a later explicit continuation does not repeat three
          // knowingly rejected native request variants.
          this.geminiDialect = 'text-protocol';
          this.dialectConfirmed = true;
          try {
            normalizedTextReply = normalizeGeminiTextReply(data, tools);
          } catch (error) {
            if (error?.retryable === true && textRepairCount < MAX_TEXT_REPAIRS) {
              textRepairCount++;
              const cause = error.finishReason === 'MAX_TOKENS' ? 'MAX_TOKENS'
                : error.finishReason === 'MALFORMED_FUNCTION_CALL' ? 'MALFORMED_FUNCTION_CALL' : 'invalid JSON';
              repairHint = cause === 'MALFORMED_FUNCTION_CALL'
                ? `PLAIN TEXT RECOVERY ${textRepairCount}/${MAX_TEXT_REPAIRS}: The previous candidate had finishReason=MALFORMED_FUNCTION_CALL (INVALID NATIVE FUNCTION CALL). It was NOT executed. This request has ZERO native Gemini tools. Do not invoke functions, tool APIs, Python, or default_api. Instead WRITE LITERAL CHARACTERS of ONE short JSON text object, with chatmcp_action="tool" and a listed router name if more work is needed, or chatmcp_action="final" only if verified complete. Fully escape all strings. No Markdown or explanation outside the JSON.`
                : error.formatIssue === 'action_shape' || error.formatIssue === 'tool_arguments_missing' || error.formatIssue === 'final_text_missing'
                  ? `SCHEMA RECOVERY ${textRepairCount}/${MAX_TEXT_REPAIRS}: Your previous response was valid JSON but did NOT match the ChatMCP action contract (${error.formatIssue}; keys: ${(error.observedKeys || []).join(', ') || 'unknown'}). That response was NOT executed. Output exactly ONE JSON object. For an additional MCP step: {"chatmcp_action":"tool","name":"mcp_catalog","arguments":{"filter":null,"offset":0,"limit":30}}. For a VERIFIED final answer: {"chatmcp_action":"final","text":"Short factual final answer"}. IMPORTANT: The most recent MCP tool result in the transcript has ALREADY BEEN EXECUTED; use it and do not rerun that tool merely to correct JSON formatting. No markdown, type/status/result substitutes, native functions or commentary.`
                  : `FORMAT RECOVERY ${textRepairCount}/${MAX_TEXT_REPAIRS}: Your previous answer ended with ${cause} and was NOT executed. Regenerate a fresh, COMPLETE, VERY SHORT JSON action from the beginning. Use exactly one chatmcp_action=tool or final JSON object, no reasoning, Markdown or explanations. Prefer a tool request when work is unfinished. If final, keep text under 600 characters. Close every JSON string and brace.`;
              await onStatus(`Gemini text-only: ${error.formatIssue === 'action_shape' ? 'JSON thiếu chatmcp_action' : cause}; thử sửa định dạng (${textRepairCount}/${MAX_TEXT_REPAIRS}). Không gọi lại MCP; mỗi request thử lại có thể phát sinh phí.`, 'model_repair');
              continue;
            }
            if (error?.retryable === true && textRepairCount >= MAX_TEXT_REPAIRS)
              error.message += error.finishReason === 'MALFORMED_FUNCTION_CALL'
                ? ` Đã thử phục hồi ${textRepairCount} lần trên cùng gateway; chưa gọi MCP ở lượt này. Model/gateway vẫn tạo lời gọi hàm native dù payload chỉ có contents. Cần gateway hỗ trợ function calling đúng chuẩn hoặc model thực sự xuất JSON text.`
                : ` Đã thử phục hồi ${textRepairCount} lần trên cùng gateway; chưa gọi MCP ở lượt này. ${(error.formatIssue === 'action_shape') ? 'JSON vẫn thiếu chatmcp_action; model/gateway chưa tuân thủ schema tool/final.' : 'Kiểm tra finishReason, schema chatmcp_action và output/thinking token budget.'}`;
            throw error;
          }
        }
        if (attempts) await onStatus('Kết nối Gateway đã khôi phục; đang xử lý kết quả model.');
        break;
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (error?.code?.startsWith('gateway_')) throw error;
        const networkFailure = error instanceof TypeError || ['TimeoutError', 'AbortError', 'NetworkError'].includes(error?.name) ||
          ['ECONNRESET', 'ENETUNREACH', 'EHOSTUNREACH', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED'].includes(error?.code);
        if (!networkFailure) throw error; // Unexpected programming/provider errors are not connection loss.
        attempts++;
        const seconds = Math.min(30, 3 * 2**Math.min(attempts - 1, 4));
        await onStatus(`Mất kết nối Gateway hoặc chưa nhận được phản hồi (lần thử ${attempts}). Đang chờ ${seconds} giây rồi thử lại model; không gọi lại MCP. Yêu cầu API trước có thể vẫn bị tính phí.`);
        await this.sleep(seconds * 1000, signal);
      }
    }
    if (!response.ok || data?.error) {
      const code = response.status === 401 || response.status === 403 ? 'gateway_auth' : response.status === 429 ? 'gateway_rate_limit' : 'gateway_http_error';
      const detail = noSecrets(gatewayErrorDetail(data), text => this.redact(text));
      const hint = response.status === 413 ? 'Gateway vẫn từ chối request đã rút gọn. Không tự bỏ thêm bằng chứng hoặc lặp MCP; kiểm tra giới hạn body phía gateway.' : response.status === 400 ? 'Gateway đã nhận request nhưng từ chối dữ liệu. Hãy chạy Test API tự nhận dạng chuẩn; nếu vẫn lỗi, kiểm tra container log.'
        : response.status === 401 || response.status === 403 ? 'Kiểm tra key và kiểu header xác thực.'
        : response.status === 429 ? 'Kiểm tra hạn mức/rate limit.' : 'Kiểm tra gateway.';
      throw bad(code, `Gateway HTTP ${response.status}${detail ? ': ' + detail : '.'} ${hint}`, response.status || 502);
    }
    const normalized = dialects[dialectIndex] === 'text-protocol' ? normalizedTextReply : normalizeGemini(data);
    this.geminiDialect = dialects[dialectIndex]; this.dialectConfirmed = true;
    this.lastError = '';
    return normalized;
  }

  /** OpenAI-style Chat Completions and Anthropic Messages. See standard-adapter.mjs for what it guarantees. */
  async #respondStandard({ input, instructions, tools, signal, onStatus, maxOutputTokens }) {
    const { protocol, model, authMode, apiKey, contextWindowTokens } = this;
    const ctx = {
      protocol, model, fetch: this.fetch, sleep: this.sleep, limits: this.limits,
      endpoint: buildEndpoint(this.apiBaseUrl, protocol, model, this.customPath),
      headers: this.#headers(protocol, authMode, apiKey),
      redact: (text) => noSecrets(String(text), (value) => this.redact(value)),
      contextWindowTokens,
      // Prompt caching is only requested from Anthropic itself; compatible gateways may reject the field.
      promptCaching: protocol === 'anthropic' && this.preset === 'anthropic',
      outputLimit: this.outputLimit,
      onOutputLimit: (limit) => { if (this.model === model) this.outputLimit = limit; },
    };
    const result = await respondStandard(ctx, { input, instructions, tools, signal, onStatus, maxOutputTokens });
    this.lastError = '';
    return result;
  }
}
