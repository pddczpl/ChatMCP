import { hasTranslation, type Translate, type TranslationKey } from './i18n.ts';

/**
 * The dictionary key of the sentence for a code, when the page has one. The key is always `agent_error_` + the code, and only a key that exists is used, so no other
 * dictionary entry can be reached through a code. One lookup for every code the Hub names: why a route refused something (`stale_revision`) and why a worker's run
 * ended (`model_empty`, `user_cancelled`).
 */
export function errorSentenceKey(code: unknown): TranslationKey | null {
  if (typeof code !== 'string') return null;
  const key = `agent_error_${code}`;
  return hasTranslation(key) ? key : null;
}

/**
 * What an error from an agent route says to the owner. The Hub names why it refused with a code (`stale_revision`); the sentence for a code is in
 * the dictionary, in the language on screen. A code with no sentence shows the Hub's own message (which may be in the other language), and an
 * error with neither shows `fallback`.
 */
export function agentErrorText(error: unknown, t: Translate, fallback: string): string {
  const key = errorSentenceKey((error as { code?: unknown } | null | undefined)?.code);
  if (key) return t(key);
  const message = (error as { message?: unknown } | null | undefined)?.message;
  return typeof message === 'string' && message.trim() !== '' ? message : fallback;
}
