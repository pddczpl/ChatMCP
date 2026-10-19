// The one definition of "how large a context window may be configured". Everything that takes a window uses it: the gateway
// configuration (GatewayProvider), model profiles (AiProfiles), the effective context budget (context-compaction.mjs) and, through
// ui/src/lib/context-window.ts (a test compares the two), the settings forms.
//
// Below the minimum the agent cannot hold its own tool schemas, so a smaller value is refused with the range in the message; it is
// never silently turned into "unknown". Above the maximum the value is clamped to it, never discarded: nobody typed a huge number
// to mean "I don't know".

export const CONTEXT_WINDOW_MIN = 4096;
export const CONTEXT_WINDOW_MAX = 2_000_000;

const grouped = (number) => number.toLocaleString('en-US');

/** "4,096 - 2,000,000", for messages. */
export function contextWindowRangeText() {
  return `${grouped(CONTEXT_WINDOW_MIN)} - ${grouped(CONTEXT_WINDOW_MAX)}`;
}

/**
 * @returns {number|null|undefined} null = not set (what clearing sends); undefined = not a usable window;
 *   otherwise a whole number of tokens, at most CONTEXT_WINDOW_MAX.
 */
export function parseContextWindow(value) {
  if (value === undefined || value === null || value === '' || value === 0 || value === '0') return null;
  const number = typeof value === 'number' || typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isInteger(number) || number < CONTEXT_WINDOW_MIN) return undefined;
  return Math.min(number, CONTEXT_WINDOW_MAX);
}

/** A window that is usable as it stands or after clamping, else null. For values that come from provider metadata. */
export function usableContextWindow(value) {
  const parsed = Number.isSafeInteger(value) ? parseContextWindow(value) : undefined;
  return typeof parsed === 'number' ? parsed : null;
}
