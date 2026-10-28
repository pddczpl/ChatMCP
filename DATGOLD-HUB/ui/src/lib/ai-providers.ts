import type { AiProviderChoice } from './ai-config-form';

export interface AiProvider extends AiProviderChoice {
  name: string;
}

/**
 * The buttons of the connection form: one per preset of the Hub (lib/provider-presets.mjs), each with the address and the model the form starts from. The Hub owns the
 * list; this copy is held to it by tests/ai-providers.test.mjs (same ids, same address, same model, same protocol), so a preset added there cannot be left out here.
 * The popular providers have a button of their own; any other service is a "Custom" connection with its base URL and key.
 */
export const AI_PROVIDERS: readonly AiProvider[] = [
  { id: 'anthropic', name: 'Anthropic', defaultModel: 'claude-sonnet-5-5', defaultUrl: 'https://api.anthropic.com' },
  { id: 'openai', name: 'OpenAI (Chat Completions)', defaultModel: 'gpt-5.6-terra', defaultUrl: 'https://api.openai.com/v1' },
  { id: 'openai-responses', name: 'OpenAI Responses API', defaultModel: 'gpt-5.6-terra', defaultUrl: 'https://api.openai.com/v1' },
  { id: 'gemini', name: 'Google Gemini', defaultModel: 'gemini-2.5-flash', defaultUrl: 'https://generativelanguage.googleapis.com' },
  { id: 'openrouter', name: 'OpenRouter', defaultModel: 'anthropic/claude-sonnet-4.5', defaultUrl: 'https://openrouter.ai/api/v1' },
  { id: 'deepseek', name: 'DeepSeek', defaultModel: 'deepseek-flash', defaultUrl: 'https://api.deepseek.com' },
  { id: 'xai', name: 'xAI (Grok)', defaultModel: 'grok-4.3', defaultUrl: 'https://api.x.ai/v1' },
  { id: 'glm', name: 'Z.ai (GLM)', defaultModel: 'glm-5.3', defaultUrl: 'https://api.z.ai/api/paas/v4' },
  { id: 'qwen', name: 'Alibaba (Qwen)', defaultModel: 'qwen3.7-plus', defaultUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' },
  { id: 'minimax', name: 'MiniMax', defaultModel: 'MiniMax-M3', defaultUrl: 'https://api.minimax.io/anthropic' },
  { id: 'groq', name: 'Groq', defaultModel: 'llama-3.3-70b-versatile', defaultUrl: 'https://api.groq.com/openai/v1' },
  { id: 'mistral', name: 'Mistral', defaultModel: 'mistral-large-latest', defaultUrl: 'https://api.mistral.ai/v1' },
  { id: 'ollama', name: 'Ollama (Local)', defaultModel: 'qwen2.5-coder:7b', defaultUrl: 'http://localhost:11434/v1' },
  { id: 'lmstudio', name: 'LM Studio (Local)', defaultModel: 'local-model', defaultUrl: 'http://localhost:1234/v1' },
  { id: 'custom-openai', name: 'Custom (Chat Completions)', defaultModel: '', defaultUrl: '' },
  { id: 'custom-responses', name: 'Custom (Responses API)', defaultModel: '', defaultUrl: '' },
  { id: 'custom-gemini', name: 'Custom (Gemini)', defaultModel: '', defaultUrl: '' },
  { id: 'custom-anthropic', name: 'Custom (Anthropic)', defaultModel: '', defaultUrl: '' },
];
