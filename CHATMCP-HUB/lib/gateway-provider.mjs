import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readJson, writeJson } from './runtime.mjs';
import { geminiTextEnvelope, normalizeGeminiTextReply, unsupportedGeminiFields } from './gemini-compat.mjs';

// Direct API mode is deliberately independent of the ChatGPT Web companion.
// API credentials never pass through the browser extension or the MCP transport.
const FORMATS = ['gemini', 'openai-chat'];
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
  return protocol === 'gemini'
    ? { contents: [{ role: 'user', parts: [{ text: 'Reply OK.' }] }] }
    : { model, messages: [{ role: 'user', content: 'Reply OK.' }], stream: false };
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
  state() { return { provider: 'gateway', protocol: this.protocol, model: this.model, apiBaseUrl: this.apiBaseUrl, authMode: this.authMode, customPath: this.customPath, configured: this.ready(), keySource: this.keySource, lastError: this.lastError, agentRequestMode: this.protocol === 'gemini' ? (this.dialectConfirmed ? this.geminiDialect : 'chưa kiểm tra tool calling') : 'openai-tool-calls' }; }
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
    this.apiBaseUrl = base; this.protocol = protocol; this.model = model; this.authMode = authMode; this.customPath = customPath; this.lastError = ''; this.geminiDialect = 'native'; this.dialectConfirmed = false;
    return this.state();
  }
  // Called only by the user's explicit "Test API / Auto" action. Probe a
  // bounded set of standard dialects against the SAME configured origin. Do
  // not send MCP inventories or project content; these are minimal test calls.
  // If a dialect works, persist the corrected public format without losing a
  // DPAPI-protected key. No mutation occurs when all probes fail.
  async diagnoseConnection({ signal } = {}) {
    if (!this.ready()) throw bad('gateway_not_ready','Hãy nhập URL, model và API key trước khi kiểm tra.',409);
    const choices = [];
    const push = (protocol, authMode, apiBaseUrl, customPath = '') => {
      const endpoint = buildEndpoint(apiBaseUrl, protocol, this.model, customPath);
      if (new URL(endpoint).origin !== new URL(this.apiBaseUrl).origin) return;
      if (!choices.some(x => x.endpoint === endpoint && x.authMode === authMode)) choices.push({ protocol, authMode, apiBaseUrl, customPath, endpoint });
    };
    const currentAuth = this.authMode === 'auto' ? (this.protocol === 'gemini' ? 'google-key':'bearer') : this.authMode;
    push(this.protocol, currentAuth, this.apiBaseUrl, this.customPath);
    const stem = this.apiBaseUrl.replace(/\/v1(?:beta)?$/,'');
    push('gemini','google-key',stem);
    push('gemini','bearer',stem);
    push('openai-chat','bearer',stem);
    push('openai-chat','google-key',stem);
    const attempts=[];
    for (const item of choices.slice(0,5)) {
      signal?.throwIfAborted();
      let response;
      try {
        const timeout = AbortSignal.timeout(6000);
        const controller = signal ? AbortSignal.any([signal,timeout]):timeout;
        response = await this.fetch(item.endpoint,{
          method:'POST', redirect:'error',signal:controller,
          headers: item.authMode==='google-key' ? {'Content-Type':'application/json','x-goog-api-key':this.apiKey}
            : {'Content-Type':'application/json','Authorization':`Bearer ${this.apiKey}`},
          body:JSON.stringify(probePayload(item.protocol,this.model)),
        });
        // Protect memory against exceptionally large responses from custom gateways.
        const raw = (await response.text()).slice(0, 32000);
        let data;
        try { data=JSON.parse(raw); } catch { data={}; }
        const detail=noSecrets(gatewayErrorDetail(data),text=>this.redact(text));
        let good=false;
        if(response.ok) {
          try {
            const parsed=item.protocol==='gemini'?normalizeGemini(data):normalizeChatCompletion(data);
            good=parsed.output.some(x=>x.type==='message');
          } catch { /* HTTP 200 without a valid model response is not success */ }
        }
        attempts.push({protocol:item.protocol,authMode:item.authMode,status:response.status,success:good,detail:detail || (!good&&response.ok?'Response không có message hợp lệ':'')});
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
    const err=bad('gateway_probe_failed',`Không tìm được giao thức API tương thích trên gateway đã cấu hình. ${details}. Kiểm tra route và lỗi trong Cloud Run (không cần đổi model nếu model hợp lệ).`,502);
    err.attempts=attempts;
    this.lastError='Test API thất bại: gateway chưa trả response tương thích.';
    throw err;
  }

  async respond({ input, instructions, tools = [], signal, onStatus = async () => {} }) {
    if (!this.ready()) throw bad('gateway_not_ready', 'Hãy cấu hình API Base URL, model và API key.', 409);
    if (!Array.isArray(input)) throw bad('invalid_input', 'Ngữ cảnh Agent không hợp lệ.');
    const protocol = this.protocol;
    const sourceContextBytes = Buffer.byteLength(JSON.stringify(input),'utf8') + Buffer.byteLength(instructions,'utf8');
    const endpoint = buildEndpoint(this.apiBaseUrl, protocol, this.model, this.customPath);
    const nativeBody = protocol === 'gemini' ? {
      systemInstruction: { parts: [{ text: instructions }] },
      contents: asGeminiContents(input),
      tools: tools.length ? [{ functionDeclarations: tools.map((x) => ({ name: x.name, description: x.description, parameters: geminiSchema(x.parameters) })) }] : undefined,
      generationConfig: { maxOutputTokens: 8192 },
    } : null;
    const openaiBody = protocol === 'openai-chat' ? {
      model: this.model, messages: asChatMessages(input, instructions),
      tools: tools.map((x) => ({ type: 'function', function: { name: x.name, description: x.description, parameters: x.parameters } })),
      tool_choice: 'auto', stream: false,
    } : null;
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
      if(protocol !== 'gemini') return openaiBody;
      if(dialect === 'native') return nativeBody;
      if(dialect === 'no-generation-config') return {...nativeBody, generationConfig:undefined};
      if(dialect === 'inline-instructions') return {contents:inlineInstructions(), tools:nativeBody.tools};
      if(dialect === 'text-protocol') return geminiTextEnvelope(input, instructions, tools, {maxRequestBytes:textRequestBudget, repairHint});
      throw bad('gateway_dialect_invalid','Invalid gateway compatibility dialect');
    };
    // If a minimal Test API succeeds yet native agent tool fields are rejected,
    // discover a compatible payload on that same endpoint without ever changing
    // the authentication header or sending the credential to another origin.
    const dialects = protocol === 'gemini'
      ? ['native','no-generation-config','inline-instructions','text-protocol']
      : ['openai-chat'];
    let dialect = this.geminiDialect;
    let dialectIndex = protocol === 'gemini' ? Math.max(0, dialects.indexOf(dialect)) : 0;
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
        const useGoogleHeader = this.authMode === 'google-key' || (this.authMode === 'auto' && protocol === 'gemini');
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
        response = await this.fetch(endpoint, { method: 'POST', headers: useGoogleHeader
          ? { 'x-goog-api-key': this.apiKey, 'Content-Type': 'application/json' }
          : { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
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
        if (protocol === 'gemini' && response.status === 413) {
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
        if (protocol === 'gemini' && !response.ok && dialectIndex < dialects.length - 1 &&
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
      const detail = noSecrets(gatewayErrorDetail(data), text => this.redact(text));
      const hint = response.status === 413 ? 'Gateway vẫn từ chối request đã rút gọn. Không tự bỏ thêm bằng chứng hoặc lặp MCP; kiểm tra giới hạn body phía gateway.' : response.status === 400 ? 'Gateway đã nhận request nhưng từ chối dữ liệu. Hãy chạy Test API tự nhận dạng chuẩn; nếu vẫn lỗi, kiểm tra container log.'
        : response.status === 401 || response.status === 403 ? 'Kiểm tra key và kiểu header xác thực.'
        : response.status === 429 ? 'Kiểm tra hạn mức/rate limit.' : 'Kiểm tra gateway.';
      throw bad(code, `Gateway HTTP ${response.status}${detail ? ': ' + detail : '.'} ${hint}`, response.status || 502);
    }
    const normalized = protocol === 'gemini'
      ? dialects[dialectIndex] === 'text-protocol' ? normalizedTextReply : normalizeGemini(data)
      : normalizeChatCompletion(data);
    if(protocol === 'gemini') { this.geminiDialect = dialects[dialectIndex]; this.dialectConfirmed = true; }
    this.lastError = '';
    return normalized;
  }
}
