import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ChatGPTAuth, ProviderError, abortError, API_RESOURCE, newHostId, validHostId } from './chatgpt-auth.mjs';
import { readJson, writeJson } from './runtime.mjs';

const DEFAULT_MODEL = 'gpt-6-astra';
const NAMESPACE = 'mcp';
const CODE_MESSAGES = {
  subscription_sharing_user_not_eligible: 'Tài khoản hoặc workspace này chưa đủ điều kiện dùng gói ChatGPT trong app.',
  subscription_sharing_usage_limit_exceeded: 'Đã đạt hạn mức dùng gói ChatGPT của app hoặc tài khoản. Xem ChatGPT Settings → Usage. App không tự chuyển sang tính phí API.',
  subscription_sharing_usage_unavailable: 'OpenAI tạm thời chưa kiểm tra được hạn mức gói ChatGPT. Có thể thử lại sau.',
  subscription_sharing_unsupported_capability: 'Yêu cầu chứa tính năng chưa được hỗ trợ khi dùng gói ChatGPT.',
  subscription_sharing_route_not_supported: 'Đường dẫn API này chưa được phép dùng gói ChatGPT.',
  subscription_sharing_invalid_user: 'Không xác minh được kết nối ChatGPT. Hãy kiểm tra tài khoản đã chọn.',
  subscription_sharing_user_unavailable: 'Thông tin tài khoản ChatGPT đang tạm thời không khả dụng.',
  chatpass_v2_scope_not_authorized: 'Kết nối chưa có quyền thực hiện yêu cầu này bằng gói ChatGPT.',
  chatpass_v2_invalid_authorization_context: 'Thông tin cấp quyền dùng gói ChatGPT chưa hợp lệ.',
  insufficient_quota: 'API key đã hết hạn mức hoặc chưa có thanh toán API. Xem Usage/Billing của tài khoản API.',
  invalid_api_key: 'API key không hợp lệ. Hãy cập nhật key trong phần kết nối mô hình.',
  model_not_found: 'Model đã chọn chưa khả dụng với tài khoản này. Chọn model khác trong phần kết nối.',
  rate_limit_exceeded: 'OpenAI đang giới hạn tốc độ yêu cầu. Hãy thử lại sau.',
};

function errorFromResponse(data, status = 502, requestId) {
  const value = data?.error ?? data?.response?.error ?? data;
  const code = typeof value?.code === 'string' ? value.code : typeof value?.type === 'string' && value.type !== 'error' ? value.type : 'model_request_failed';
  const base = CODE_MESSAGES[code] || (status === 401 ? 'Thông tin đăng nhập mô hình không được chấp nhận.' : status === 403 ? 'Tài khoản, khu vực hoặc quyền hiện tại không được phép thực hiện yêu cầu.' : status === 429 ? 'Đã đạt hạn mức hoặc giới hạn tốc độ yêu cầu. Hãy kiểm tra Usage của tài khoản.' : status === 503 ? 'Dịch vụ mô hình đang tạm thời không khả dụng.' : 'Mô hình chưa hoàn tất yêu cầu. Kiểm tra model, kết nối và hạn mức.');
  const param = typeof value?.param === 'string' && /^[A-Za-z0-9_.\[\]-]{1,100}$/.test(value.param) ? value.param : undefined;
  const error = new ProviderError(param ? `${base} Trường: ${param}.` : base, { code, statusCode: status >= 400 ? status : 502, requestId });
  if (param) error.param = param;
  return error;
}

function readAbortable(reader, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => { void reader.cancel().catch(() => {}); reject(abortError()); };
    signal?.addEventListener('abort', onAbort, { once: true });
    reader.read().then(resolve, reject).finally(() => signal?.removeEventListener('abort', onAbort));
  });
}

/** Consumes through response.completed; partial text is never reported as success. */
export async function readResponseStream(response, signal) {
  const requestId = response.headers.get('x-request-id') || undefined;
  if (!response.body) throw new ProviderError('Phản hồi mô hình không có nội dung.', { code: 'empty_response', requestId });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let total = 0;
  const jsonResponse = !response.ok || /^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '');
  try {
    while (true) {
      const { done, value } = await readAbortable(reader, signal);
      if (done) {
        buffer += decoder.decode();
        if (jsonResponse) {
          let data;
          try { data = JSON.parse(buffer); } catch { throw errorFromResponse({}, response.status, requestId); }
          if (response.ok && data.status === 'completed' && Array.isArray(data.output)) return data;
          throw errorFromResponse(data, response.status, requestId);
        }
        break;
      }
      total += value.length;
      if (total > 32 * 1024 * 1024 || (jsonResponse && total > 1024 * 1024)) throw new ProviderError('Phản hồi mô hình quá lớn.', { code: 'response_too_large', requestId });
      buffer += decoder.decode(value, { stream: true });
      if (jsonResponse) continue;
      let separator;
      while ((separator = /\r?\n\r?\n/.exec(buffer))) {
        const event = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator[0].length);
        const dataText = event.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, '')).join('\n');
        if (!dataText || dataText === '[DONE]') continue;
        let data;
        try { data = JSON.parse(dataText); } catch { throw new ProviderError('Luồng phản hồi mô hình có dữ liệu không hợp lệ.', { code: 'invalid_stream_json', requestId }); }
        if (data.type === 'response.completed') {
          if (data.response?.status !== 'completed' || !Array.isArray(data.response?.output)) throw new ProviderError('Sự kiện hoàn tất thiếu nội dung phản hồi.', { code: 'invalid_completed_response', requestId });
          return data.response;
        }
        if (data.type === 'response.failed' || data.type === 'error') throw errorFromResponse(data, response.status, requestId);
        if (data.type === 'response.incomplete') throw new ProviderError('Mô hình dừng khi phản hồi chưa hoàn tất. Chưa thực thi thêm công cụ.', { code: 'response_incomplete', requestId });
      }
      if (buffer.length > 8 * 1024 * 1024) throw new ProviderError('Sự kiện phản hồi mô hình quá lớn.', { code: 'stream_event_too_large', requestId });
    }
    throw new ProviderError('Kết nối bị ngắt trước khi mô hình báo hoàn tất. Có thể thử lại.', { code: 'stream_interrupted', requestId });
  } finally { await reader.cancel().catch(() => {}); }
}

function validModel(model) { return typeof model === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:\/-]{0,199}$/.test(model); }

function dpapi(bundleRoot, mode, text) {
  if (process.platform !== 'win32') return Promise.reject(new ProviderError('Lưu thông tin đăng nhập yêu cầu Windows DPAPI trên máy này.', { code: 'dpapi_unavailable' }));
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const helper = path.join(bundleRoot, 'windows', 'Protect-ApiKey.ps1');
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-File', helper, '-Mode', mode], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', bytes = 0, settled = false;
    const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(result); };
    const failure = () => new ProviderError('Không mã hóa hoặc đọc được thông tin đăng nhập bằng tài khoản Windows hiện tại.', { code: 'dpapi_failed' });
    const timer = setTimeout(() => { child.kill(); finish(failure()); }, 20_000);
    child.once('error', () => finish(failure()));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { bytes += Buffer.byteLength(chunk); if (bytes > 1024 * 1024) { child.kill(); finish(failure()); } else output += chunk; });
    child.stderr.resume(); // Never forward helper output that might contain tokens.
    child.stdin.on('error', () => {});
    child.once('close', (code) => finish(code === 0 && output.trim() ? null : failure(), output.trim().replace(/^\uFEFF/, '')));
    child.stdin.end(text, 'utf8');
  });
}

export class ModelProvider {
  constructor({ directory, bundleRoot, log = () => {}, registerSecret = () => {}, fetchImpl = fetch, protect, unprotect, now = Date.now, env = process.env }) {
    this.directory = directory;
    this.bundleRoot = bundleRoot;
    this.log = log;
    this.secretCallback = registerSecret;
    this.fetch = fetchImpl;
    this.now = now;
    this.env = env;
    this.protect = protect || ((text) => dpapi(bundleRoot, 'Protect', text));
    this.unprotect = unprotect || ((text) => dpapi(bundleRoot, 'Unprotect', text));
    this.configFile = path.join(directory, 'model-provider.json');
    this.credentialFile = path.join(directory, 'model-credentials.dpapi');
    this.hostFile = path.join(directory, 'chatgpt-host.json');
    this.provider = 'openai';
    this.model = DEFAULT_MODEL;
    this.modelsByProvider = { openai: DEFAULT_MODEL, chatgpt: '' };
    this.models = [];
    this.apiKey = '';
    this.keySource = 'none';
    this.credentials = {};
    this.secretValues = new Set();
    this.lastError = '';
    this.auth = null;
    this.persisting = Promise.resolve();
  }

  registerSecret(value) {
    if (typeof value !== 'string' || !value) return;
    this.secretValues.add(value);
    this.secretCallback(value);
  }

  redact(text) {
    let result = String(text);
    for (const secret of [...this.secretValues].sort((a,b) => b.length - a.length)) result = result.split(secret).join('[REDACTED]');
    return result.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]').replace(/\bsk-[A-Za-z0-9_-]{10,}/g, '[REDACTED]');
  }

  async load() {
    await fs.mkdir(this.directory, { recursive: true });
    const saved = await readJson(this.configFile);
    if (saved) {
      if (['openai', 'chatgpt'].includes(saved.provider)) this.provider = saved.provider;
      for (const name of ['openai', 'chatgpt']) if (validModel(saved.modelsByProvider?.[name])) this.modelsByProvider[name] = saved.modelsByProvider[name];
      if (validModel(saved.model)) this.modelsByProvider[this.provider] = saved.model;
      this.model = this.modelsByProvider[this.provider];
    }
    let ciphertext;
    try { ciphertext = await fs.readFile(this.credentialFile, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (ciphertext) {
      try {
        const decoded = JSON.parse(await this.unprotect(ciphertext.trim()));
        if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded) || decoded.version !== 1) throw new Error('Invalid credential record');
        this.credentials = decoded;
      } catch { this.lastError = 'Không đọc được kết nối đã lưu. Hãy đăng nhập lại hoặc nhập lại API key bằng tài khoản Windows hiện tại.'; }
    }
    if (typeof this.credentials.apiKey === 'string' && this.credentials.apiKey) { this.apiKey = this.credentials.apiKey; this.keySource = 'saved'; }
    else if (typeof this.env.OPENAI_API_KEY === 'string' && this.env.OPENAI_API_KEY.trim()) { this.apiKey = this.env.OPENAI_API_KEY.trim(); this.keySource = 'environment'; }
    this.registerSecret(this.apiKey);
    let host = await readJson(this.hostFile);
    if (!host) { host = { version: 1, hostId: newHostId() }; await writeJson(this.hostFile, host); }
    if (!validHostId(host.hostId)) throw new ProviderError('File host ID ChatGPT không hợp lệ; cần khôi phục file gốc.', { code: 'invalid_host_id' });
    this.auth = new ChatGPTAuth({ hostId: host.hostId, saved: this.credentials.chatgpt || {}, fetchImpl: this.fetch, registerSecret: (value) => this.registerSecret(value), now: this.now, persist: async (data) => { await this.saveCredentials({ chatgpt: data }); } });
    return this.state();
  }

  async saveCredentials(updates = {}) {
    // Serializes DPAPI + atomic replacement so key/config changes and rotating
    // OAuth credentials cannot overwrite one another with a stale snapshot.
    const saving = this.persisting.then(async () => {
      const next = { ...this.credentials, ...updates, version: 1 };
      if (this.auth && !Object.hasOwn(updates, 'chatgpt')) next.chatgpt = { ...this.auth.data };
      const serialized = JSON.stringify(next);
      const ciphertext = await this.protect(serialized);
      const temp = `${this.credentialFile}.${Date.now()}.tmp`;
      try { await fs.writeFile(temp, ciphertext + '\n', { mode: 0o600, flag: 'wx' }); await fs.rename(temp, this.credentialFile); this.credentials = next; }
      finally { await fs.unlink(temp).catch(() => {}); }
    });
    this.persisting = saving.catch(() => {});
    return saving;
  }

  async saveConfig() {
    this.modelsByProvider[this.provider] = this.model;
    await writeJson(this.configFile, { version: 1, provider: this.provider, model: this.model, modelsByProvider: this.modelsByProvider });
  }

  state() {
    return { provider: this.provider, model: this.model, configured: this.ready(), keySource: this.keySource, lastError: this.lastError, chatgpt: this.auth?.state() || { signedIn: false, planEnabled: false, email: '', loginPending: false, clientRegistered: false }, models: this.provider === 'chatgpt' ? this.models.map((m) => ({ ...m })) : [] };
  }

  ready() { return validModel(this.model) && (this.provider === 'openai' ? !!this.apiKey : !!this.auth?.ready()); }
  snapshot() { return { provider: this.provider, model: this.model }; }

  async configure({ provider = this.provider, model, apiKey, remember = true } = {}) {
    if (!['openai','chatgpt'].includes(provider)) throw new ProviderError('Chọn kết nối OpenAI API hoặc ChatGPT.', { code: 'invalid_provider', statusCode: 400 });
    const nextModel = model === undefined || model === '' ? this.modelsByProvider[provider] : String(model).trim();
    if (nextModel && !validModel(nextModel)) throw new ProviderError('Tên model không hợp lệ.', { code: 'invalid_model', statusCode: 400 });
    if (provider === 'chatgpt' && this.models.length && nextModel && !this.models.some((m) => m.id === nextModel)) throw new ProviderError('Model không có trong danh sách của kết nối ChatGPT hiện tại.', { code: 'model_not_available', statusCode: 400 });
    if (apiKey !== undefined && apiKey !== '') {
      if (typeof apiKey !== 'string' || apiKey.trim().length < 16 || apiKey.trim().length > 1000 || /\s/.test(apiKey.trim())) throw new ProviderError('API key không hợp lệ.', { code: 'invalid_api_key_format', statusCode: 400 });
      const nextKey = apiKey.trim();
      this.registerSecret(nextKey);
      // Do not need DPAPI for a first session-only API key with no saved secrets.
      if (remember || this.credentials.chatgpt || await fs.access(this.credentialFile).then(() => true, () => false)) await this.saveCredentials({ apiKey: remember ? nextKey : undefined });
      this.apiKey = nextKey;
      this.keySource = remember ? 'saved' : 'session';
    }
    this.provider = provider;
    this.model = nextModel || (provider === 'openai' ? DEFAULT_MODEL : '');
    this.lastError = '';
    await this.saveConfig();
    return this.state();
  }

  async beginLogin({ baseUrl }) {
    if (!this.auth) throw new ProviderError('Ứng dụng chưa tải cấu hình.', { code: 'provider_not_loaded' });
    if (this.provider !== 'chatgpt') throw new ProviderError('Hãy chọn kết nối ChatGPT trước khi đăng nhập.', { code: 'wrong_provider', statusCode: 400 });
    this.lastError = '';
    return this.auth.beginLogin({ baseUrl });
  }

  async completeLogin(parameters) {
    try {
      if (this.provider !== 'chatgpt') throw new ProviderError('Kết nối mô hình đã thay đổi; lần đăng nhập này không được áp dụng.', { code: 'wrong_provider', statusCode: 409 });
      await this.auth.completeLogin(parameters);
      if (this.auth.state().planEnabled) {
        try {
          await this.listModels();
          if (!this.models.some((m) => m.id === this.model)) this.model = this.models[0]?.id || '';
          this.modelsByProvider.chatgpt = this.model;
          await this.saveConfig();
          this.lastError = this.models.length ? '' : 'Đã đăng nhập nhưng chưa có model hiển thị cho tài khoản này.';
        } catch (error) { this.lastError = this.redact(error.message); }
      } else this.lastError = 'Đã đăng nhập, nhưng chưa cấp quyền dùng gói ChatGPT. Bấm kết nối ChatGPT để cấp quyền hoặc chọn OpenAI API.';
      return this.state();
    } catch (error) { this.lastError = this.redact(error.message); throw error; }
  }

  async listModels() {
    if (this.provider !== 'chatgpt') return [];
    const token = await this.auth.accessToken();
    let response;
    try { response = await this.fetch(`${API_RESOURCE}/models`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) }); }
    catch { throw new ProviderError('Chưa tải được danh sách model của ChatGPT.', { code: 'model_catalog_unavailable' }); }
    let data;
    try { data = await response.json(); } catch { throw new ProviderError('Danh sách model ChatGPT không hợp lệ.', { code: 'invalid_model_catalog' }); }
    if (!response.ok) throw errorFromResponse(data, response.status, response.headers.get('x-request-id'));
    if (!Array.isArray(data.models)) throw new ProviderError('ChatGPT chưa trả về danh sách model theo định dạng được hỗ trợ.', { code: 'invalid_model_catalog' });
    this.models = data.models.filter((m) => m.visibility === 'list' && validModel(m.slug)).map((m) => ({ id: m.slug, name: typeof m.display_name === 'string' ? m.display_name.slice(0,150) : m.slug }));
    return this.models.map((m) => ({ ...m }));
  }

  async logout() {
    try {
      const result = await this.auth.logout();
      this.models = [];
      this.lastError = result.revocationError || '';
      return this.state();
    } catch (error) { this.lastError = this.redact(error.message); throw error; }
  }

  async respond({ input, instructions, tools = [], signal, maxOutputTokens = 8192, parallel_tool_calls = false, include = ['reasoning.encrypted_content'] }) {
    if (!this.ready()) throw new ProviderError(this.provider === 'chatgpt' ? 'Hãy kết nối ChatGPT và chọn model trước.' : 'Hãy nhập OpenAI API key và chọn model trước.', { code: 'provider_not_configured', statusCode: 400 });
    if (!Array.isArray(input)) throw new ProviderError('Ngữ cảnh model phải là một danh sách input.', { code: 'invalid_model_input', statusCode: 400 });
    const selected = this.snapshot();
    const token = selected.provider === 'chatgpt' ? await this.auth.accessToken(signal) : this.apiKey;
    const timeout = AbortSignal.timeout(5 * 60_000);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let modelTools = tools;
    if (selected.provider === 'chatgpt' && tools.length) {
      if (!tools.every((tool) => tool && ['function','custom'].includes(tool.type))) throw new ProviderError('Kết nối ChatGPT này chỉ nhận các công cụ local dạng function/custom.', { code: 'unsupported_local_tool', statusCode: 400 });
      modelTools = [{ type: 'namespace', name: NAMESPACE, description: 'Tools executed locally through the user-selected MCP servers.', tools }];
    }
    const body = { model: selected.model, input, instructions, tools: modelTools, store: false, stream: true, parallel_tool_calls, include };
    if (selected.provider === 'openai') {
      if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 131072) throw new ProviderError('Giới hạn output không hợp lệ.', { code: 'invalid_output_limit', statusCode: 400 });
      body.max_output_tokens = maxOutputTokens;
    }
    try {
      const response = await this.fetch(`${API_RESOURCE}/responses`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: JSON.stringify(body), signal: requestSignal });
      const result = await readResponseStream(response, requestSignal);
      this.lastError = '';
      return result;
    } catch (error) {
      if (signal?.aborted) throw abortError();
      const safe = error instanceof ProviderError ? error : new ProviderError(timeout.aborted ? 'Mô hình chưa hoàn tất trong thời gian cho phép. Có thể thử lại.' : 'Không nhận được phản hồi hoàn tất từ mô hình. Kiểm tra mạng rồi thử lại.', { code: timeout.aborted ? 'model_timeout' : 'model_network_error' });
      this.lastError = this.redact(safe.message);
      throw safe;
    }
  }
}
