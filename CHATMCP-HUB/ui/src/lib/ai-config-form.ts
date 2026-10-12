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
