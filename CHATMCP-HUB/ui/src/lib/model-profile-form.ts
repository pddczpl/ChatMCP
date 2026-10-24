// The model-profile form as data: what an empty form is, how a saved profile fills it, and the exact request a filled form sends.
// Kept out of the component so that the rules (shared context-window range, headers that are replaced as a whole, nothing secret
// ever copied back into a field) are testable without a browser.
import type { AiProfile } from '../types/index.ts';
import { parseContextWindowInput } from './context-window.ts';

export type ProfileProtocol = 'openai-chat' | 'openai-responses' | 'anthropic' | 'gemini';
export const PROFILE_PROTOCOLS: ProfileProtocol[] = ['openai-chat', 'openai-responses', 'anthropic', 'gemini'];

export type ProfileDraft = {
  id: string; name: string; protocol: ProfileProtocol; model: string; apiBaseUrl: string;
  authMode: 'auto' | 'bearer' | 'google-key'; apiKey: string; envKeyName: string; contextWindow: string;
  /** The route the endpoint is reached at, e.g. /proxy/{model}/messages. Not a secret. */
  customPath: string;
  /** JSON array typed by the person. Never filled from the Hub: header values are not returned by any API. */
  customHeadersText: string;
  /** Only an edited field replaces the headers sealed on the Hub; an untouched one keeps them. */
  customHeadersDirty: boolean;
  isDefault: boolean; clearCredentials: boolean; rateInput: string; rateOutput: string;
  rateCacheRead: string; rateCacheWrite: string;
  /** 'auto' (send nothing) or a level of thinking effort. Always sent: 'auto' is how a saved level is cleared. */
  reasoningEffort: string;
};

export const emptyProfileDraft = (): ProfileDraft => ({
  id: '', name: '', protocol: 'openai-chat', model: '', apiBaseUrl: '',
  authMode: 'auto', apiKey: '', envKeyName: '', contextWindow: '',
  customPath: '', customHeadersText: '', customHeadersDirty: false,
  isDefault: false, clearCredentials: false,
  rateInput: '', rateOutput: '', rateCacheRead: '', rateCacheWrite: '',
  reasoningEffort: 'auto',
});

export function draftFromProfile(profile: AiProfile): ProfileDraft {
  return {
    id: profile.id, name: profile.name || profile.id,
    protocol: PROFILE_PROTOCOLS.includes(profile.protocol as ProfileProtocol) ? profile.protocol as ProfileProtocol : 'openai-chat',
    model: profile.model || '', apiBaseUrl: profile.apiBaseUrl || '',
    authMode: profile.authMode === 'bearer' || profile.authMode === 'google-key' ? profile.authMode : 'auto',
    apiKey: '', envKeyName: profile.envKeyName || '', contextWindow: profile.contextWindow ? String(profile.contextWindow) : '',
    customPath: profile.customPath || '', customHeadersText: '', customHeadersDirty: false,
    isDefault: !!profile.isDefault, clearCredentials: false,
    rateInput: profile.ratesUsdPerMillion?.input?.toString() || '',
    rateOutput: profile.ratesUsdPerMillion?.output?.toString() || '',
    rateCacheRead: profile.ratesUsdPerMillion?.cacheRead?.toString() || '',
    rateCacheWrite: profile.ratesUsdPerMillion?.cacheWrite?.toString() || '',
    reasoningEffort: profile.reasoningEffort || 'auto',
  };
}

/** The headers field is a JSON array; the Hub checks every name and value and refuses the forbidden ones. */
export function parseHeadersInput(text: string): unknown[] {
  let parsed: unknown;
  try { parsed = JSON.parse(text.trim() || '[]'); }
  catch { throw new Error('Custom headers must be valid JSON, for example [{"name":"X-Tenant","envKeyName":"CHATMCP_TENANT"}].'); }
  if (!Array.isArray(parsed)) throw new Error('Custom headers must be a JSON array of {"name", "value" or "envKeyName"} objects.');
  return parsed;
}

/** Everything api.upsertProfile receives for this draft; throws an Error whose message is meant for the person. */
export function buildProfilePayload(draft: ProfileDraft): Record<string, unknown> {
  if (!draft.model.trim() || !draft.apiBaseUrl.trim()) throw new Error('Enter a model and API base URL for this profile.');
  if (draft.apiKey.trim() && draft.envKeyName.trim()) throw new Error('Choose either an API key or environment key for one profile.');
  const window = parseContextWindowInput(draft.contextWindow);
  if (!window.ok) throw new Error(window.message);
  const priceKeys = [
    ['rateInput', 'input'], ['rateOutput', 'output'],
    ['rateCacheRead', 'cacheRead'], ['rateCacheWrite', 'cacheWrite'],
  ] as const;
  const rates: Record<string, number> = {};
  for (const [field, key] of priceKeys) {
    const raw = draft[field].trim();
    if (!raw) continue;
    if (!/^(?:0|[0-9]+)(?:\.[0-9]+)?$/.test(raw) || !Number.isFinite(Number(raw)) || Number(raw) > 10000)
      throw new Error('Model token prices must be numbers 0..10000 USD per 1M tokens.');
    rates[key] = Number(raw);
  }
  if (Object.keys(rates).length && (!Object.hasOwn(rates, 'input') || !Object.hasOwn(rates, 'output')))
    throw new Error('Both input and output rates must be provided.');
  const headers = draft.customHeadersDirty ? parseHeadersInput(draft.customHeadersText) : undefined;
  return {
    ...(draft.id.trim() ? { id: draft.id.trim() } : {}),
    name: draft.name.trim() || draft.id.trim() || draft.model.trim(),
    provider: draft.protocol, protocol: draft.protocol, model: draft.model.trim(),
    apiBaseUrl: draft.apiBaseUrl.trim(), authMode: draft.authMode,
    // null clears a saved window; the Hub clamps one above the maximum, so the clamped value is what is sent.
    contextWindow: window.value,
    reasoningEffort: draft.reasoningEffort || 'auto',
    customPath: draft.customPath.trim(),
    ...(headers !== undefined ? { customHeaders: headers } : {}),
    ratesUsdPerMillion: Object.keys(rates).length ? rates : null,
    ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim(), envKeyName: null } : { envKeyName: draft.envKeyName.trim() || null }),
    isDefault: draft.isDefault, clearCredentials: draft.clearCredentials,
  };
}
