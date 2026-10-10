import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readJson, writeJson } from './runtime.mjs';

// Direct API mode is deliberately independent of the ChatGPT Web companion.
// API credentials never pass through the browser extension or the MCP transport.
const FORMATS = ['gemini', 'openai-chat'];
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const modelOK = (v) => typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:\/-]{0,150}$/.test(v);
const bad = (code, message, statusCode = 400) => Object.assign(new Error(message), { code, statusCode });

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
export function asChatMessages(history, instructions) {
  const messages = [{ role: 'system', content: instructions }];
  for (const x of history) {
    if (x?.role === 'user') messages.push({ role: 'user', content: contentText(x.content) });
    else if (x?.type === 'message' && x.role === 'assistant') messages.push({ role: 'assistant', content: contentText(x.content) });
    else if (x?.type === 'function_call') {
      let msg = messages.at(-1);
      if (msg?.role !== 'assistant' || !Array.isArray(msg.tool_calls)) {
        if (msg?.role === 'assistant' && !msg.tool_calls) msg.tool_calls = [];
        else { msg = { role: 'assistant', content: null, tool_calls: [] }; messages.push(msg); }
      }
      msg.tool_calls.push({ type: 'function', id: x.call_id, function: { name: x.name, arguments: x.arguments } });
    } else if (x?.type === 'function_call_output') messages.push({ role: 'tool', tool_call_id: x.call_id, content: outputText(x.output) });
  }
  return messages;
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
export function normalizeChatCompletion(result) {
  const choice = result?.choices?.[0];
  if (!choice || !choice.message || !['stop', 'tool_calls'].includes(choice.finish_reason)) throw bad('model_incomplete', 'Chat Completions chưa hoàn tất (hoặc response không đúng định dạng).', 502);
  const output = [];
  const message = choice.message;
  const text = typeof message.content === 'string' ? message.content : Array.isArray(message.content) ? message.content.filter((x) => x?.type === 'text').map((x) => x.text).join('\n') : '';
  if (text.trim()) output.push({ type: 'message', role: 'assistant', phase: message.tool_calls?.length ? 'commentary' : 'final', content: [{ type: 'output_text', text }] });
  for (const call of message.tool_calls || []) {
    if (call.type !== 'function' || typeof call.id !== 'string' || typeof call.function?.name !== 'string' || typeof call.function?.arguments !== 'string') throw bad('model_invalid_function', 'Gateway trả tool_calls không hợp lệ.', 502);
    output.push({ type: 'function_call', name: call.function.name, call_id: call.id, arguments: call.function.arguments, status: 'completed' });
  }
  if (!output.length) throw bad('model_empty', 'Gateway trả phản hồi rỗng.', 502);
  return { status: 'completed', output, usage: { input_tokens: Number(result.usage?.prompt_tokens) || 0, output_tokens: Number(result.usage?.completion_tokens) || 0 } };
}
async function protectWindows(mode, text, bundleRoot) {
  if (process.platform !== 'win32') throw bad('dpapi_unavailable', 'Chỉ Windows hỗ trợ lưu API key bằng DPAPI trong phiên bản này.');
  const binary = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = path.join(bundleRoot, 'windows', 'Protect-ApiKey.ps1');
  return await new Promise((resolve, reject) => {
    const proc = spawn(binary, ['-NoProfile', '-NonInteractive', '-File', script, '-Mode', mode], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let chunks = '', size = 0, settled = false;
    const done = (error, result) => { if (settled) return; settled = true; clearTimeout(timeout); error ? reject(error) : resolve(result); };
    const timeout = setTimeout(() => { proc.kill(); done(bad('dpapi_timeout', 'Windows chưa thể bảo vệ API key.')); }, 20000);
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (s) => { size += Buffer.byteLength(s); if (size > 1024*1024) { proc.kill(); done(bad('dpapi_overflow', 'Credential quá dài.')); } else chunks += s; });
    proc.stderr.resume(); proc.stdin.on('error', () => {});
    proc.once('error', () => done(bad('dpapi_failed', 'Không gọi được Windows DPAPI.')));
    proc.once('close', (code) => done(code === 0 && chunks.trim() ? null : bad('dpapi_failed', 'Không thể lưu/đọc API key dưới tài khoản Windows hiện tại.'), chunks.trim()));
    proc.stdin.end(text, 'utf8');
  });
}

export class GatewayProvider {
  constructor({ directory, bundleRoot, manager, fetchImpl = fetch, env = process.env, protect, unprotect }) {
    this.directory = directory;
    this.bundleRoot = bundleRoot;
    this.manager = manager;
    this.fetch = fetchImpl;
    this.env = env;
    this.protect = protect || (x => protectWindows('Protect', x, bundleRoot));
    this.unprotect = unprotect || (x => protectWindows('Unprotect', x, bundleRoot));
    this.configFile = path.join(directory, 'gateway-config.json');
    this.keyFile = path.join(directory, 'gateway-key.dpapi');
    this.apiBaseUrl = 'https://generativelanguage.googleapis.com';
    this.protocol = 'gemini';
    this.authMode = 'auto';
    this.customPath = '';
    this.model = 'gemini-2.5-flash';
    this.apiKey = '';
    this.keySource = 'none';
    this.lastError = '';
  }
  registerKey(key) { if (key) this.manager.secrets = [...new Set([...(this.manager.secrets ?? []), key])]; }
  redact(value) {
    let str = String(value);
    for (const key of this.manager.secrets ?? []) if (key && typeof key === 'string') str = str.split(key).join('[REDACTED]');
    return str.replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]');
  }
  async load() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const data = await readJson(this.configFile);
    const base = data?.apiBaseUrl || this.env.GOOGLE_API_BASE_URL;
    if (base) try { this.apiBaseUrl = validateBaseUrl(base); } catch { this.lastError = 'URL API đã lưu không hợp lệ; cần nhập lại.'; }
    if (FORMATS.includes(data?.protocol)) this.protocol = data.protocol;
    if (['auto','google-key','bearer'].includes(data?.authMode)) this.authMode = data.authMode;
    if (typeof data?.customPath === 'string') { try { buildEndpoint(this.apiBaseUrl, this.protocol, this.model, data.customPath); this.customPath = data.customPath; } catch { this.lastError = 'Đường dẫn endpoint lưu trước đây không hợp lệ.'; } }
    if (modelOK(data?.model || this.env.GEMINI_MODEL)) this.model = data?.model || this.env.GEMINI_MODEL;
    let encrypted = '';
    try { encrypted = (await fs.readFile(this.keyFile, 'utf8')).trim(); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (encrypted) {
      try { const record = JSON.parse(encrypted); this.apiKey = await this.unprotect(record.protected); this.keySource = 'saved'; }
      catch { this.lastError = 'Không giải mã được key đã lưu bằng tài khoản Windows hiện tại. Nhập lại key.'; }
    }
    if (!this.apiKey && this.env.GOOGLE_API_KEY) { this.apiKey = String(this.env.GOOGLE_API_KEY).trim(); this.keySource = 'environment'; }
    this.registerKey(this.apiKey);
  }
  state() { return { provider: 'gateway', protocol: this.protocol, model: this.model, apiBaseUrl: this.apiBaseUrl, authMode: this.authMode, customPath: this.customPath, configured: this.ready(), keySource: this.keySource, lastError: this.lastError }; }
  snapshot() { return { provider: `gateway:${this.protocol}`, model: this.model }; }
  async listModels() { return [{ id: this.model, name: this.model }]; }
  async clearKey() {
    await fs.unlink(this.keyFile).catch(e => { if (e.code !== 'ENOENT') throw e; });
    this.apiKey = ''; this.keySource = 'none';
    return this.state();
  }
  ready() { return Boolean(this.apiKey) && modelOK(this.model) && Boolean(this.apiBaseUrl); }
  async configure({ apiBaseUrl = this.apiBaseUrl, protocol = this.protocol, model = this.model, authMode = this.authMode, customPath = this.customPath, apiKey, remember = false } = {}) {
    const base = validateBaseUrl(apiBaseUrl);
    if (!FORMATS.includes(protocol)) throw bad('invalid_protocol', 'Chọn Gemini native hoặc OpenAI-compatible Chat Completions.');
    if (!modelOK(model)) throw bad('invalid_model', 'Tên model không hợp lệ.');
    if (!['auto','google-key','bearer'].includes(authMode)) throw bad('invalid_auth_mode', 'Kiểu xác thực API không hợp lệ.');
    buildEndpoint(base, protocol, model, customPath);
    const newKey = apiKey === undefined || apiKey === '' ? this.apiKey : apiKey;
    if (typeof newKey !== 'string' || (newKey && (newKey.trim().length < 12 || newKey.length > 2048 || /\s/.test(newKey)))) throw bad('invalid_key', 'API key không hợp lệ.');
    if (remember && !newKey) throw bad('missing_key', 'Nhập API key trước khi lưu.');
    let ciphertext = null;
    if (remember) ciphertext = await this.protect(newKey);
    // Persist the public configuration first; never write plaintext credentials.
    await writeJson(this.configFile, { version: 1, apiBaseUrl: base, protocol, model, authMode, customPath });
    if (ciphertext) await writeJson(this.keyFile, { protected: ciphertext });
    else if (!remember) await fs.unlink(this.keyFile).catch(e => { if (e.code !== 'ENOENT') throw e; });
    this.apiKey = newKey;
    this.registerKey(newKey);
    this.keySource = remember ? 'saved' : newKey ? 'session' : 'none';
    this.apiBaseUrl = base; this.protocol = protocol; this.model = model; this.authMode = authMode; this.customPath = customPath; this.lastError = '';
    return this.state();
  }
  async respond({ input, instructions, tools = [], signal, onStatus = async () => {} }) {
    if (!this.ready()) throw bad('gateway_not_ready', 'Hãy cấu hình API Base URL, model và API key.', 409);
    if (!Array.isArray(input)) throw bad('invalid_input', 'Ngữ cảnh Agent không hợp lệ.');
    const protocol = this.protocol;
    const endpoint = buildEndpoint(this.apiBaseUrl, protocol, this.model, this.customPath);
    const body = protocol === 'gemini' ? {
      systemInstruction: { parts: [{ text: instructions }] },
      contents: asGeminiContents(input),
      tools: tools.length ? [{ functionDeclarations: tools.map((x) => ({ name: x.name, description: x.description, parameters: geminiSchema(x.parameters) })) }] : undefined,
      generationConfig: { maxOutputTokens: 8192 },
    } : {
      model: this.model, messages: asChatMessages(input, instructions),
      tools: tools.map((x) => ({ type: 'function', function: { name: x.name, description: x.description, parameters: x.parameters } })),
      tool_choice: 'auto', stream: false,
    };
    // A model request has not executed MCP tools yet. If its network response is
    // lost, retry only the model step after backoff, never the preceding MCP call.
    // A repeated model request can still be charged by the gateway; document it.
    let response, data, attempts = 0;
    while (true) {
      signal?.throwIfAborted();
      const controller = AbortSignal.timeout(240000);
      const combined = signal ? AbortSignal.any([signal, controller]) : controller;
      try {
        const useGoogleHeader = this.authMode === 'google-key' || (this.authMode === 'auto' && protocol === 'gemini');
        response = await this.fetch(endpoint, { method: 'POST', headers: useGoogleHeader
          ? { 'x-goog-api-key': this.apiKey, 'Content-Type': 'application/json' }
          : { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body), signal: combined, redirect: 'error' });
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
        catch { throw bad('gateway_invalid_json', 'Gateway không trả JSON hợp lệ; không tự gửi lại.', 502); }
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
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, seconds*1000);
          const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
          signal?.addEventListener('abort', abort, { once: true });
          if (signal?.aborted) abort();
        });
      }
    }
    if (!response.ok || data?.error) {
      const code = response.status === 401 || response.status === 403 ? 'gateway_auth' : response.status === 429 ? 'gateway_rate_limit' : 'gateway_http_error';
      throw bad(code, `Gateway từ chối yêu cầu (HTTP ${response.status}). Kiểm tra key, model, định dạng API và hạn mức.`, response.status || 502);
    }
    const normalized = protocol === 'gemini' ? normalizeGemini(data) : normalizeChatCompletion(data);
    this.lastError = '';
    return normalized;
  }
}
