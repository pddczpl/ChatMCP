// Ready-made connection settings so a person picks "Anthropic" or "Ollama" instead of typing URLs and protocols.
//
// A preset only fills in public values (endpoint, protocol, a starting model). It never carries a key. The default
// models are starting points: the Settings page asks the provider for the real list (GatewayProvider#discoverModels),
// and a model that does not exist for the account is reported by name instead of failing silently.
//
// `keyEnv` lists the environment variables that are accepted as the key for THAT provider only. A key found in the
// environment is never sent to a different host (see GatewayProvider#configure).
//
// `promptCaching` says that the endpoint accepts `cache_control` on the Anthropic Messages API, so the instructions, the tool list and
// the conversation so far are not paid for again on every step. It is a property of the ENDPOINT, never of a word in a name: a profile
// aimed at api.anthropic.com has the same endpoint as the global "anthropic" connection and so the same flag. Default false, because a
// gateway that does not know the field may reject the whole request; a preset for Claude behind another front door (Bedrock, Vertex AI,
// Azure AI Foundry) sets it to true when it is added.

const preset = (value) => Object.freeze({ keyEnv: [], local: false, authMode: 'auto', customPath: '', contextWindowTokens: null, promptCaching: false, keyUrl: '', notes: '', ...value });

export const PRESETS = Object.freeze([
  preset({
    id: 'anthropic', label: 'Anthropic (Claude)', protocol: 'anthropic', apiBaseUrl: 'https://api.anthropic.com', defaultModel: 'claude-sonnet-5-5',
    keyEnv: ['ANTHROPIC_API_KEY'], contextWindowTokens: 200000, promptCaching: true, keyUrl: 'https://console.anthropic.com/settings/keys',
    notes: 'Messages API gốc, có tool use và prompt caching.',
  }),
  preset({
    id: 'openai', label: 'OpenAI', protocol: 'openai-chat', apiBaseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-5-mini',
    keyEnv: ['OPENAI_API_KEY'], keyUrl: 'https://platform.openai.com/api-keys',
    notes: 'Chat Completions. Tên model mặc định chỉ là gợi ý; dùng "Tải danh sách model" để chọn model có trong tài khoản.',
  }),
  preset({
    id: 'openai-responses', label: 'OpenAI Responses API', protocol: 'openai-responses',
    apiBaseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-5-mini',
    keyEnv: ['OPENAI_API_KEY'], keyUrl: 'https://platform.openai.com/api-keys',
    notes: 'Native /v1/responses, function tools and SSE. Select only for genuinely compatible endpoints.',
  }),
  preset({
    id: 'gemini', label: 'Google Gemini', protocol: 'gemini', apiBaseUrl: 'https://generativelanguage.googleapis.com', defaultModel: 'gemini-2.5-flash',
    keyEnv: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], contextWindowTokens: 1000000, keyUrl: 'https://aistudio.google.com/apikey',
    notes: 'Gemini API gốc (generateContent).',
  }),
  preset({
    id: 'openrouter', label: 'OpenRouter', protocol: 'openai-chat', apiBaseUrl: 'https://openrouter.ai/api/v1', defaultModel: 'anthropic/claude-sonnet-4.5',
    keyEnv: ['OPENROUTER_API_KEY'], keyUrl: 'https://openrouter.ai/keys',
    notes: 'Một key cho nhiều model. Ngữ cảnh phụ thuộc model: đặt "Ngữ cảnh model" nếu biết.',
  }),
  preset({
    id: 'deepseek', label: 'DeepSeek', protocol: 'openai-chat', apiBaseUrl: 'https://api.deepseek.com', defaultModel: 'deepseek-chat',
    keyEnv: ['DEEPSEEK_API_KEY'], contextWindowTokens: 128000, keyUrl: 'https://platform.deepseek.com/api_keys',
  }),
  preset({
    id: 'groq', label: 'Groq', protocol: 'openai-chat', apiBaseUrl: 'https://api.groq.com/openai/v1', defaultModel: 'llama-3.3-70b-versatile',
    keyEnv: ['GROQ_API_KEY'], contextWindowTokens: 131072, keyUrl: 'https://console.groq.com/keys',
  }),
  preset({
    id: 'mistral', label: 'Mistral', protocol: 'openai-chat', apiBaseUrl: 'https://api.mistral.ai/v1', defaultModel: 'mistral-large-latest',
    keyEnv: ['MISTRAL_API_KEY'], contextWindowTokens: 128000, keyUrl: 'https://console.mistral.ai/api-keys',
  }),
  preset({
    id: 'ollama', label: 'Ollama (máy cục bộ)', protocol: 'openai-chat', apiBaseUrl: 'http://localhost:11434/v1', defaultModel: 'qwen2.5-coder:7b', local: true,
    notes: 'Không cần API key. Model phải hỗ trợ tool calling. Ollama có thể dùng ngữ cảnh rất nhỏ theo mặc định (vài nghìn token) và cắt bớt lặng lẽ; tăng OLLAMA_CONTEXT_LENGTH (ví dụ 32768) và đặt cùng giá trị ở "Ngữ cảnh model".',
  }),
  preset({
    id: 'lmstudio', label: 'LM Studio (máy cục bộ)', protocol: 'openai-chat', apiBaseUrl: 'http://localhost:1234/v1', defaultModel: 'local-model', local: true,
    notes: 'Không cần API key. Bật local server trong LM Studio, nạp model hỗ trợ tool calling và đặt đủ lớn "context length".',
  }),
  preset({ id: 'custom-openai', label: 'Khác: tương thích OpenAI', protocol: 'openai-chat', apiBaseUrl: '', defaultModel: '', notes: 'Bất kỳ máy chủ nào có /v1/chat/completions (vLLM, LiteLLM, gateway nội bộ…).' }),
  preset({ id: 'custom-responses', label: 'Khác: Responses API', protocol: 'openai-responses',
    apiBaseUrl: '', defaultModel: '', notes: 'Gateway implements /v1/responses with function calls and terminal SSE events.' }),
  preset({ id: 'custom-anthropic', label: 'Khác: tương thích Anthropic', protocol: 'anthropic', apiBaseUrl: '', defaultModel: '', notes: 'Gateway có /v1/messages. Chọn kiểu xác thực Bearer nếu gateway không dùng x-api-key.' }),
  preset({ id: 'custom-gemini', label: 'Khác: gateway Gemini', protocol: 'gemini', apiBaseUrl: '', defaultModel: 'gemini-2.5-flash', notes: 'Gateway chuyển tiếp Gemini generateContent (ví dụ Cloud Run).' }),
]);

const BY_ID = new Map(PRESETS.map((entry) => [entry.id, entry]));
export const presetById = (id) => BY_ID.get(id) ?? null;

/** The "something else" preset for a protocol: what a connection becomes once its URL no longer matches a known provider. */
export const customPresetId = (protocol) => ({ 'openai-chat': 'custom-openai',
  'openai-responses': 'custom-responses', anthropic: 'custom-anthropic', gemini: 'custom-gemini' })[protocol] ?? 'custom-openai';

export function originOf(value) {
  try { return new URL(value).origin; } catch { return null; }
}

/** localhost / loopback only: the places where plain HTTP and "no key" are acceptable. */
export function isLoopbackUrl(value) {
  try {
    const { hostname } = new URL(value);
    return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname);
  } catch { return false; }
}

/**
 * The preset whose endpoint is exactly this origin (custom-* presets have no endpoint and never match). Some origins serve more than
 * one protocol (api.openai.com has Chat Completions and Responses): pass the protocol to get the preset that speaks it.
 */
export function presetForBaseUrl(value, protocol) {
  const origin = originOf(value);
  if (!origin) return null;
  return PRESETS.find((entry) => entry.apiBaseUrl && originOf(entry.apiBaseUrl) === origin && (!protocol || entry.protocol === protocol)) ?? null;
}

/** The connection an endpoint amounts to: a known provider when origin AND protocol match one, else the "something else" preset of the protocol. */
export function presetIdFor(value, protocol) {
  return presetForBaseUrl(value, protocol)?.id ?? customPresetId(protocol);
}

/**
 * Whether requests to this endpoint may carry `cache_control`. A named provider answers for itself; a custom connection (and a
 * task profile, which has no preset at all) is judged by its origin, so one aimed at Anthropic itself caches and one aimed at an
 * unknown gateway does not. Only the Messages API has the field.
 */
export function supportsPromptCaching({ apiBaseUrl = '', protocol = '', preset = '' } = {}) {
  const named = presetById(preset);
  if (named && !named.id.startsWith('custom-')) return named.protocol === protocol && named.promptCaching === true;
  return Boolean(protocol) && presetForBaseUrl(apiBaseUrl, protocol)?.promptCaching === true;
}

/** A route template such as /v1beta/models/{model}:generateContent: absolute, not protocol-relative, no "..", plain characters. */
export function isValidCustomPath(value) {
  return typeof value === 'string' && value.length <= 400 && !value.startsWith('//') && !value.split('/').includes('..') && /^\/[A-Za-z0-9_./:{}-]+$/.test(value);
}

/**
 * Names (never values) of the provider key variables that are set in `env`, so Settings can offer "use ANTHROPIC_API_KEY".
 * @returns {{preset: string, env: string}[]}
 */
export function detectEnvKeys(env = process.env) {
  const found = [];
  for (const entry of PRESETS) {
    for (const name of entry.keyEnv) {
      if (typeof env[name] === 'string' && env[name].trim()) { found.push({ preset: entry.id, env: name }); break; }
    }
  }
  return found;
}

/** What the browser needs: everything except nothing secret. */
export function publicPresets(env = process.env) {
  const detected = new Map(detectEnvKeys(env).map((entry) => [entry.preset, entry.env]));
  return PRESETS.map((entry) => ({
    id: entry.id, label: entry.label, protocol: entry.protocol, apiBaseUrl: entry.apiBaseUrl, defaultModel: entry.defaultModel,
    authMode: entry.authMode, local: entry.local, keyRequired: !entry.local, contextWindowTokens: entry.contextWindowTokens,
    promptCaching: entry.promptCaching, keyUrl: entry.keyUrl, notes: entry.notes, envKey: detected.get(entry.id) ?? null,
  }));
}
