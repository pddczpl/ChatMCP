// Multi-profile AI configuration manager for ChatMCP (Phase 3).
//
// Supports managing multiple model configurations (e.g. Anthropic Claude 3.5 Sonnet for coding,
// OpenAI GPT-4o for review, local Ollama for privacy) with isolated credential storage
// and seamless profile switching per task.

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { readJson, writeJson } from './runtime.mjs';
import { createProtector } from './secret-box.mjs';
import { parseModelRates } from './model-cost.mjs';
import { normalizeCustomHeaders, publicCustomHeaders } from './gateway-custom-headers.mjs';
import { isValidCustomPath } from './provider-presets.mjs';
import { contextWindowRangeText, parseContextWindow } from './context-window.mjs';
import { AUTO, EFFORT_LEVELS, parseReasoningEffort } from './reasoning-effort.mjs';

const PROFILES_FILENAME = 'ai-profiles.json';
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,40}$/i;
const ALLOWED_PROVIDERS = ['anthropic', 'openai-chat', 'openai-responses', 'gemini', 'ollama', 'custom'];
const ALLOWED_PROTOCOLS = ['anthropic','openai-chat','openai-responses','gemini'];
function safeOrigin(value) {
  if(!value)return null;
  let url;try{url=new URL(value);}catch{throw error('invalid_profile_endpoint','Profile endpoint is not a valid URL.');}
  if(url.username||url.password||url.hash||url.search||
      !(url.protocol==='https:'||(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname))))
    throw error('invalid_profile_endpoint','Profile must use HTTPS or loopback HTTP without embedded credentials.');
  return url.origin;
}
const DEFAULT_BUNDLE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const error = (code, message, statusCode = 400) => Object.assign(new Error(message), { code, statusCode });

export function defaultProfilesDirectory(env = process.env, home = os.homedir()) {
  if (env.CHATMCP_STATE_DIR) return path.resolve(env.CHATMCP_STATE_DIR);
  return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'ChatMCP', 'hub');
}

export function createDpapiKeyStore({ bundleRoot = DEFAULT_BUNDLE_ROOT, directory = defaultProfilesDirectory(), platform = process.platform, env = process.env } = {}) {
  const protector = createProtector({ platform, bundleRoot, directory, env });
  return {
    kind: protector.kind,
    encrypt: async (text) => {
      if (protector.kind !== 'windows-dpapi') {
        throw error('dpapi_required', 'Bắt buộc mã hóa API key bằng Windows DPAPI.', 500);
      }
      return await protector.protect(text);
    },
    decrypt: async (blob) => {
      if (protector.kind !== 'windows-dpapi') {
        throw error('dpapi_required', 'Bắt buộc giải mã API key bằng Windows DPAPI.', 500);
      }
      return await protector.unprotect(blob);
    },
    describe: () => protector.describe(),
  };
}

export class AiProfiles {
  /**
   * @param {object} [options]
   * @param {string} [options.stateDir] Directory where ai-profiles.json is saved (defaults to %LOCALAPPDATA%\ChatMCP\hub)
   * @param {object} [options.keyStore] Key storage adapter (DPAPI required for API keys)
   * @param {string} [options.bundleRoot] Hub bundle root for locating Windows DPAPI scripts
   */
  constructor({ stateDir = defaultProfilesDirectory(), keyStore = null, bundleRoot = DEFAULT_BUNDLE_ROOT } = {}) {
    const resolvedStateDir = stateDir ? path.resolve(stateDir) : defaultProfilesDirectory();
    if (!resolvedStateDir) throw error('missing_state_dir', 'Cần thư mục lưu trạng thái.', 500);
    this.stateDir = resolvedStateDir;
    this.filePath = path.join(resolvedStateDir, PROFILES_FILENAME);
    this.keyStore = keyStore || createDpapiKeyStore({ bundleRoot, directory: resolvedStateDir });
    this.profiles = new Map();
    this.defaultProfileId = null;
    this.loaded = false;
  }

  async load() {
    try {
      const data = await readJson(this.filePath);
      if (data && Array.isArray(data.profiles)) {
        this.profiles.clear();
        for (const p of data.profiles) {
          if (p && p.id) this.profiles.set(p.id, p);
        }
        this.defaultProfileId = data.defaultProfileId || (data.profiles[0]?.id ?? null);
      }
    } catch {
      // Missing or unreadable file: start with empty profiles
      this.profiles.clear();
      this.defaultProfileId = null;
    }
    this.loaded = true;
  }

  async save() {
    const payload = {
      defaultProfileId: this.defaultProfileId,
      profiles: Array.from(this.profiles.values()),
      updatedAt: new Date().toISOString(),
    };
    await writeJson(this.filePath, payload);
  }

  /**
   * Lists all profiles with API keys redacted.
   * @returns {Array<object>}
   */
  list() {
    return Array.from(this.profiles.values()).map((p) => ({
      id: p.id,
      name: p.name || p.id,
      provider: p.provider,
      model: p.model,
      apiBaseUrl: p.apiBaseUrl || null,
      contextWindow: p.contextWindow || null,
      reasoningEffort: p.reasoningEffort || AUTO,
      protocol: p.protocol || (ALLOWED_PROTOCOLS.includes(p.provider)?p.provider:null),
      authMode: p.authMode || 'auto',
      customPath: p.customPath || '',
      customHeaders: p.customHeaders || [],
      revision: p.revision || null,
      ratesUsdPerMillion: p.ratesUsdPerMillion ?? null,
      hasKey: Boolean(p.encryptedKey || p.envKeyName),
      isDefault: p.id === this.defaultProfileId,
      envKeyName: p.envKeyName || null,
    }));
  }

  /**
   * Retrieves a single profile by ID without decrypted key.
   * @param {string} id
   * @returns {object|null}
   */
  get(id) {
    const p = this.profiles.get(id);
    if (!p) return null;
    return {
      id: p.id,
      name: p.name || p.id,
      provider: p.provider,
      model: p.model,
      apiBaseUrl: p.apiBaseUrl || null,
      contextWindow: p.contextWindow || null,
      reasoningEffort: p.reasoningEffort || AUTO,
      protocol: p.protocol || (ALLOWED_PROTOCOLS.includes(p.provider)?p.provider:null),
      authMode: p.authMode || 'auto',
      // Names and sources of the custom headers, never a value: the values exist only sealed (encryptedHeaders) and in a task's memory.
      customPath: p.customPath || '',
      customHeaders: p.customHeaders || [],
      revision: p.revision || null,
      ratesUsdPerMillion: p.ratesUsdPerMillion ?? null,
      hasKey: Boolean(p.encryptedKey || p.envKeyName),
      isDefault: p.id === this.defaultProfileId,
    };
  }

  /**
   * Adds or updates a profile.
   * @param {object} input
   */
  async upsert(input) {
    if (!input || typeof input !== 'object') throw error('invalid_profile', 'Dữ liệu cấu hình không hợp lệ.');
    const id = (input.id || randomUUID().slice(0, 8)).toLowerCase().trim();
    if (!ID_PATTERN.test(id)) {
      throw error('invalid_id', 'Mã profile chỉ gồm chữ, số, gạch ngang, gạch dưới và dấu chấm (tối đa 40 ký tự).');
    }
    const provider = String(input.provider || 'openai-chat').toLowerCase().trim();
    if (!ALLOWED_PROVIDERS.includes(provider)) {
      throw error('invalid_provider', `Nhà cung cấp không hợp lệ. Cho phép: ${ALLOWED_PROVIDERS.join(', ')}.`);
    }
    const model = String(input.model || '').trim();
    if (!model) throw error('missing_model', 'Tên model không được để trống.');

    const existing = this.profiles.get(id) || {};
    const protocol=String(input.protocol || existing.protocol ||
      (ALLOWED_PROTOCOLS.includes(provider)?provider:'openai-chat')).toLowerCase();
    if(!ALLOWED_PROTOCOLS.includes(protocol))throw error('invalid_profile_protocol','Unsupported provider profile protocol.');
    const authMode=String(input.authMode || existing.authMode || 'auto').toLowerCase();
    if(!['auto','bearer','google-key'].includes(authMode) ||
       (protocol==='anthropic'&&authMode==='google-key'))
      throw error('invalid_profile_auth','Unsupported profile authentication mode.');
    const nextBase=input.apiBaseUrl?.trim() || existing.apiBaseUrl || null;
    const oldOrigin=safeOrigin(existing.apiBaseUrl);
    const nextOrigin=safeOrigin(nextBase);
    // The protected credential cannot be silently reused at a different
    // endpoint, provider or API protocol.
    const destinationChanged=Boolean(existing.id) && (
      oldOrigin!==nextOrigin || existing.provider!==provider ||
      (existing.protocol || existing.provider)!==protocol);
    if(!nextBase)throw error('missing_profile_endpoint','A profile API base URL is required.');
    if(!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,150}$/.test(model))
      throw error('invalid_profile_model','The profile model name is invalid.');
    const explicitEnv=Object.prototype.hasOwnProperty.call(input,'envKeyName');
    let envReference=destinationChanged?null:existing.envKeyName || null;
    if(explicitEnv){
      const reference=String(input.envKeyName??'').trim();
      if(reference&&!/^[A-Z_][A-Z0-9_]{0,95}$/.test(reference))
        throw error('invalid_env_key_name','Environment variable name must be uppercase letters, digits and underscores.');
      envReference=reference || null;
    }else if(typeof input.apiKey==='string'&&input.apiKey.trim()){
      // An explicit replacement key supersedes the previous environment
      // credential rather than silently ignoring the new secret.
      envReference=null;
    }
    // The window obeys the bound of the global connection (context-window.mjs), here when the profile is SAVED rather than when a task
    // fails to start: below the minimum is refused, above the maximum is clamped, null clears, an omitted field keeps what was saved.
    let reasoningEffort = existing.reasoningEffort || AUTO;
    if (input.reasoningEffort !== undefined) {
      reasoningEffort = parseReasoningEffort(input.reasoningEffort);
      if (reasoningEffort === undefined)
        throw error('invalid_reasoning_effort', `Thinking effort ${JSON.stringify(input.reasoningEffort)} is not a level: use auto or one of ${EFFORT_LEVELS.join(', ')}.`);
    }
    let contextWindow = existing.contextWindow || null;
    if (input.contextWindow !== undefined) {
      contextWindow = parseContextWindow(input.contextWindow);
      if (contextWindow === undefined)
        throw error('invalid_context_window', `Context window ${JSON.stringify(input.contextWindow)} is not usable: enter a whole number of tokens from ${contextWindowRangeText()}, or leave it empty if unknown. Larger values are reduced to the maximum.`);
    }
    // A route is not a secret and stays with the profile; it belongs to one destination, so a new destination starts without it.
    let customPath = input.customPath === undefined ? (destinationChanged ? '' : existing.customPath || '') : String(input.customPath ?? '').trim();
    if (customPath && !isValidCustomPath(customPath))
      throw error('invalid_api_path', 'The custom API path is invalid. Use an absolute path such as /v1beta/models/{model}:generateContent.');
    // Custom header values are secrets. They are sealed by the same key store as the API key, are bound to the origin they were saved
    // for, are dropped with the key when the destination changes or the credentials are cleared, and are replaced as a whole.
    const headersGiven = input.customHeaders !== undefined;
    const headerSpecs = headersGiven ? normalizeCustomHeaders(input.customHeaders) : null;
    const keepHeaders = !headersGiven && !destinationChanged && input.clearCredentials !== true;
    const profile = {
      id,
      name: input.name?.trim() || existing.name || id,
      provider, protocol, authMode,
      model, revision:randomUUID(),
      ratesUsdPerMillion: input.ratesUsdPerMillion === undefined
        ? (existing.ratesUsdPerMillion??null)
        : parseModelRates(input.ratesUsdPerMillion),
      apiBaseUrl:nextBase,
      contextWindow,
      reasoningEffort,
      customPath,
      customHeaders: keepHeaders ? existing.customHeaders || [] : headerSpecs ? publicCustomHeaders(headerSpecs) : [],
      encryptedHeaders: keepHeaders ? existing.encryptedHeaders || null : null,
      customHeadersOrigin: keepHeaders ? existing.customHeadersOrigin || null : null,
      envKeyName: envReference,
      encryptedKey: input.clearCredentials === true ? null
        : destinationChanged ? null : existing.encryptedKey || null,
    };

    if (input.clearCredentials === true)profile.envKeyName=null;
    const seal = async (text) => {
      const encryptFn = this.keyStore?.encrypt || this.keyStore?.protect;
      if (typeof encryptFn !== 'function') {
        throw error('dpapi_required', 'Bắt buộc có bộ mã hóa Windows DPAPI để lưu API key; không cho phép lưu dạng văn bản hoặc Base64.', 500);
      }
      return await encryptFn.call(this.keyStore, text);
    };
    if (headerSpecs?.length) {
      profile.encryptedHeaders = await seal(JSON.stringify(headerSpecs));
      profile.customHeadersOrigin = nextOrigin;
    }
    if (input.apiKey && typeof input.apiKey === 'string') {
      const key = input.apiKey.trim();
      if (key) profile.encryptedKey = await seal(key);
    }

    this.profiles.set(id, profile);
    if (!this.defaultProfileId || input.isDefault) {
      this.defaultProfileId = id;
    }
    await this.save();
    return this.get(id);
  }

  /**
   * Deletes a profile by ID.
   * @param {string} id
   */
  async delete(id) {
    if (!this.profiles.has(id)) throw error('profile_not_found', 'Không tìm thấy profile.', 404);
    this.profiles.delete(id);
    if (this.defaultProfileId === id) {
      this.defaultProfileId = this.profiles.keys().next().value || null;
    }
    await this.save();
    return { ok: true, id };
  }

  /**
   * Sets the default active profile ID.
   * @param {string} id
   */
  async setDefault(id) {
    if (!this.profiles.has(id)) throw error('profile_not_found', 'Không tìm thấy profile.', 404);
    this.defaultProfileId = id;
    await this.save();
    return { ok: true, defaultProfileId: id };
  }

  /**
   * Resolves a fully usable config with decrypted API key for GatewayProvider.
   * @param {string} [id]
   * @returns {Promise<object>}
   */
  async resolveConfig(id = null) {
    const targetId = id || this.defaultProfileId;
    if (!targetId || !this.profiles.has(targetId)) {
      throw error('no_active_profile', 'Chưa có cấu hình AI profile nào.', 400);
    }
    const p = this.profiles.get(targetId);
    let apiKey = null;

    if (p.envKeyName && process.env[p.envKeyName]) {
      apiKey = process.env[p.envKeyName];
    } else if (p.encryptedKey) {
      const decryptFn = this.keyStore?.decrypt || this.keyStore?.unprotect;
      if (typeof decryptFn !== 'function') {
        throw error('dpapi_required', 'Bắt buộc có bộ giải mã Windows DPAPI để đọc API key; không hỗ trợ Base64.', 500);
      }
      apiKey = await decryptFn.call(this.keyStore, p.encryptedKey);
    }

    // A task that cannot have its headers must not start without them: a missing header can send the request to the wrong tenant.
    let customHeaders = [];
    if (p.encryptedHeaders) {
      const decryptFn = this.keyStore?.decrypt || this.keyStore?.unprotect;
      try {
        if (typeof decryptFn !== 'function') throw new Error('no key store');
        customHeaders = normalizeCustomHeaders(JSON.parse(await decryptFn.call(this.keyStore, p.encryptedHeaders)));
      } catch {
        throw error('profile_headers_unreadable', 'The protected custom headers of this model profile cannot be read. Save the profile again with its headers.', 409);
      }
    }

    return {
      id: p.id,
      name: p.name,
      provider: p.provider,protocol:p.protocol || (ALLOWED_PROTOCOLS.includes(p.provider)?p.provider:null),
      authMode:p.authMode || 'auto',revision:p.revision || null,
      ratesUsdPerMillion:p.ratesUsdPerMillion??null,
      model: p.model,
      apiBaseUrl: p.apiBaseUrl,
      contextWindow: p.contextWindow,
      reasoningEffort: p.reasoningEffort || AUTO,
      customPath: p.customPath || '',
      // Literal values are in memory for this call only; customHeadersOrigin is the origin they were sealed for.
      customHeaders,
      customHeadersOrigin: p.customHeadersOrigin || null,
      apiKey,
    };
  }
}
