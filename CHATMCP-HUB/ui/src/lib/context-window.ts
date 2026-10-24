// The settings forms' copy of CHATMCP-HUB/lib/context-window.mjs. ui/tests/model-profile-form.test.mjs compares the two, so a change
// on one side that is not made on the other fails a test. The Hub validates again: this only saves a round trip and names the fix.
//
// Below the minimum the agent cannot hold its own tool schemas, so the value is refused with the range. Above the maximum it is
// clamped, never discarded. Empty means "unknown", which the Hub answers with a conservative estimate and a visible warning.

import type { ModelInfo } from '../types/index.ts';

export const CONTEXT_WINDOW_MIN = 4096;
export const CONTEXT_WINDOW_MAX = 2_000_000;

export type ContextWindowInput =
  | { ok: true; value: number | null; clamped: boolean }
  | { ok: false; message: string };

const grouped = (value: number) => value.toLocaleString('en-US');

export function contextWindowRangeText(): string {
  return `${grouped(CONTEXT_WINDOW_MIN)} - ${grouped(CONTEXT_WINDOW_MAX)}`;
}

export function parseContextWindowInput(raw: string): ContextWindowInput {
  const text = raw.trim();
  if (text === '' || text === '0') return { ok: true, value: null, clamped: false };
  const number = Number(text);
  if (!Number.isInteger(number) || number < CONTEXT_WINDOW_MIN) {
    return {
      ok: false,
      message: `Context window must be a whole number of tokens from ${contextWindowRangeText()}, or empty if unknown. Smaller windows leave the agent no room for its tools.`,
    };
  }
  if (number > CONTEXT_WINDOW_MAX) return { ok: true, value: CONTEXT_WINDOW_MAX, clamped: true };
  return { ok: true, value: number, clamped: false };
}

export type WindowHint =
  /** A window is set (saved, or being typed). */
  | { kind: 'owner' }
  /** None is set and the model catalog is sure of the model: the Hub plans on this, and writes nothing into the field. */
  | { kind: 'catalog'; tokens: string; source: string }
  /** The same, for a model that takes in less than its window: the Hub plans on the window the input limit leaves. */
  | { kind: 'catalog_limited'; tokens: string; window: string; input: string; source: string }
  /** None is set and the Hub has nothing to rely on: it plans with a conservative estimate and says so on every task. */
  | { kind: 'unknown' };

/**
 * Where the window the Hub plans with comes from, for the note under the field. `shown` is what the field shows (a saved number, or the text being typed); `info` is the Hub's
 * answer for the model in the form (GET /api/ai/model-info), which is not there until the Hub has answered.
 */
export function contextWindowHint(shown: string | number | null | undefined, info: ModelInfo | undefined): WindowHint {
  const text = String(shown ?? '').trim();
  if (text !== '' && text !== '0') return { kind: 'owner' };
  if (!info || info.trusted !== true || !info.capacity) return { kind: 'unknown' };
  const source = info.source || 'catalog';
  if (info.maxInput && info.contextWindow && info.maxInput < info.contextWindow) {
    return { kind: 'catalog_limited', tokens: grouped(info.capacity), window: grouped(info.contextWindow), input: grouped(info.maxInput), source };
  }
  return { kind: 'catalog', tokens: grouped(info.capacity), source };
}

/** The part of a save request that carries the window: nothing unless the field was edited (an untouched form must not reset it). */
export function contextWindowField(raw: string, edited: boolean): { contextWindowTokens?: number | null } {
  if (!edited) return {};
  const parsed = parseContextWindowInput(raw);
  if (!parsed.ok) throw new Error(parsed.message);
  return { contextWindowTokens: parsed.value };
}
