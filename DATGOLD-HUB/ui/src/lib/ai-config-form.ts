export interface AiConfigForm {
  provider: string;
  apiBaseUrl: string;
  model: string;
  apiKey: string;
}

interface SavedAiConfig {
  preset?: string;
  apiBaseUrl?: string;
  model?: string;
}

/** Accept the Hub's canonical connection without replacing newer form edits. */
export function reconcileSavedAiConfig(current: AiConfigForm, submitted: AiConfigForm, saved: SavedAiConfig): AiConfigForm {
  if (current.provider !== submitted.provider || current.apiBaseUrl !== submitted.apiBaseUrl) return current;
  return {
    ...current,
    provider: saved.preset || current.provider,
    apiBaseUrl: saved.apiBaseUrl || current.apiBaseUrl,
    model: current.model === submitted.model ? saved.model || current.model : current.model,
    apiKey: current.apiKey === submitted.apiKey ? '' : current.apiKey,
  };
}

export interface AiProviderChoice {
  id: string;
  defaultModel: string;
  defaultUrl: string;
}

/** Selecting a different API dialect at the SAME custom gateway is not switching services.
 * Keep the host and model so that an existing protected key can be reused by the Hub.
 * Switching to a named provider or another origin still requires fresh credentials.
 */
export function selectAiProviderDraft(current: AiConfigForm, next: AiProviderChoice): AiConfigForm {
  if (current.provider === next.id) return current;
  const sameCustomGateway = current.provider.startsWith('custom-') && next.id.startsWith('custom-');
  return {
    ...current,
    provider: next.id,
    apiBaseUrl: sameCustomGateway ? current.apiBaseUrl : next.defaultUrl,
    model: sameCustomGateway ? current.model : next.defaultModel,
    apiKey: sameCustomGateway ? current.apiKey : '',
  };
}

/** Provider names from the React selector map one-to-one to wire protocols. */
export function aiProtocolForPreset(preset: string): 'gemini' | 'openai-chat' | 'openai-responses' | 'anthropic' | null {
  if (preset === 'gemini' || preset === 'custom-gemini') return 'gemini';
  if (preset === 'anthropic' || preset === 'custom-anthropic' || preset === 'minimax') return 'anthropic';
  if (preset === 'openai-responses' || preset === 'custom-responses') return 'openai-responses';
  if (['openai','openrouter','deepseek','xai','glm','qwen','groq','ollama','lmstudio','custom-openai','mistral','kimi'].includes(preset)) return 'openai-chat';
  return null;
}

/** Compare the editable draft to confirmed Hub state, not to the visible provider card. */
export function aiDraftHasChanges(
  form: AiConfigForm,
  saved: SavedAiConfig & { protocol?: string },
): boolean {
  return form.provider !== saved.preset
    || form.apiBaseUrl.trim() !== (saved.apiBaseUrl || '')
    || form.model.trim() !== (saved.model || '')
    || !!form.apiKey.trim();
}
