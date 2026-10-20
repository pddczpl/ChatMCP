import { hasTranslation, type Translate } from './i18n.ts';

/**
 * What an error from an agent route says to the owner. The Hub names why it refused with a code (`stale_revision`); the sentence for a code is in
 * the dictionary, in the language on screen. A code with no sentence shows the Hub's own message (which may be in the other language), and an
 * error with neither shows `fallback`. The key is always `agent_error_` + the code, and only a key that exists is used, so no other dictionary
 * entry can be reached through a code.
 */
export function agentErrorText(error: unknown, t: Translate, fallback: string): string {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (typeof code === 'string') {
    const key = `agent_error_${code}`;
    if (hasTranslation(key)) return t(key);
  }
  const message = (error as { message?: unknown } | null | undefined)?.message;
  return typeof message === 'string' && message.trim() !== '' ? message : fallback;
}
