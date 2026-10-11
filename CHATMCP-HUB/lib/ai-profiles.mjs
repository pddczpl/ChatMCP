// Multi-profile AI configuration manager for ChatMCP (Phase 3).
//
// Supports managing multiple model configurations (e.g. Anthropic Claude 3.5 Sonnet for coding,
// OpenAI GPT-4o for review, local Ollama for privacy) with isolated credential storage
// and seamless profile switching per task.

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJson, writeJson } from './runtime.mjs';

const PROFILES_FILENAME = 'ai-profiles.json';
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,40}$/i;
const ALLOWED_PROVIDERS = ['anthropic', 'openai-chat', 'gemini', 'ollama', 'custom'];

const error = (code, message, statusCode = 400) => Object.assign(new Error(message), { code, statusCode });

export class AiProfiles {
  /**
   * @param {object} options
   * @param {string} options.stateDir Directory where ai-profiles.json is saved
   * @param {object} [options.keyStore] Key storage adapter (DPAPI or AES)
   */
  constructor({ stateDir, keyStore = null }) {
    if (!stateDir) throw error('missing_state_dir', 'Cần thư mục lưu trạng thái.', 500);
    this.filePath = path.join(stateDir, PROFILES_FILENAME);
    this.keyStore = keyStore;
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
    const profile = {
      id,
      name: input.name?.trim() || existing.name || id,
      provider,
      model,
      apiBaseUrl: input.apiBaseUrl?.trim() || existing.apiBaseUrl || null,
      contextWindow: Number.isFinite(input.contextWindow) ? input.contextWindow : existing.contextWindow || null,
      envKeyName: input.envKeyName?.trim() || existing.envKeyName || null,
      encryptedKey: existing.encryptedKey || null,
    };

    if (input.apiKey && typeof input.apiKey === 'string') {
      const key = input.apiKey.trim();
      if (this.keyStore && typeof this.keyStore.encrypt === 'function') {
        profile.encryptedKey = await this.keyStore.encrypt(key);
      } else {
        // Fallback: store reference or in-memory
        profile.encryptedKey = Buffer.from(key, 'utf8').toString('base64');
      }
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
      if (this.keyStore && typeof this.keyStore.decrypt === 'function') {
        apiKey = await this.keyStore.decrypt(p.encryptedKey);
      } else {
        apiKey = Buffer.from(p.encryptedKey, 'base64').toString('utf8');
      }
    }

    return {
      id: p.id,
      name: p.name,
      provider: p.provider,
      model: p.model,
      apiBaseUrl: p.apiBaseUrl,
      contextWindow: p.contextWindow,
      apiKey,
    };
  }
}
