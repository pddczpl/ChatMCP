// The thinking-effort field of the AI settings as data: which options the select shows and which note stands under it. Kept out of the component so that the rules (a level
// the model does not take is never offered as if it were, and is never hidden when it is the one that is set) are testable without a browser.
import type { ModelInfo } from '../types/index.ts';

export const REASONING_AUTO = 'auto';

export interface ReasoningChoice {
  value: string;
  /** false: the level is the one that is set now, but the model does not list it, so the Hub sends nothing for it. */
  offered: boolean;
}

/**
 * Auto first, then the levels the Hub says this model takes, then, only when it is not among them, the level that is set now (marked as not offered, so that the page
 * never shows Auto when something else is saved). While the Hub's answer is not there yet, the level that is set is shown as it is.
 */
export function reasoningChoices(info: ModelInfo | undefined, current: string): ReasoningChoice[] {
  const levels = info?.reasoning.levels ?? [];
  const choices: ReasoningChoice[] = [{ value: REASONING_AUTO, offered: true }, ...levels.map((value) => ({ value, offered: true }))];
  if (current !== REASONING_AUTO && !levels.includes(current)) choices.push({ value: current, offered: info === undefined });
  return choices;
}

export interface ReasoningHint {
  /** A key of the dictionary. */
  key: string;
  tone: 'muted' | 'warning';
  params?: Record<string, string>;
}

/** The note under the select, or none. `refused` is the Hub's own word that the provider refused the saved level. */
export function reasoningHint(info: ModelInfo | undefined, current: string, refused: boolean): ReasoningHint | null {
  if (refused) return { key: 'ai_reasoning_hint_refused', tone: 'warning' };
  if (!info) return null;
  if (info.reasoning.why) return { key: `ai_reasoning_why_${info.reasoning.why}`, tone: 'muted' };
  if (current !== REASONING_AUTO && !info.reasoning.levels.includes(current)) return { key: 'ai_reasoning_hint_not_offered', tone: 'warning' };
  return info.reasoning.known
    ? { key: 'ai_reasoning_hint_known', tone: 'muted', params: { date: info.catalog.generatedAt } }
    : { key: 'ai_reasoning_hint_unknown', tone: 'muted' };
}

/** The key of the dictionary for the name of a level. */
export const reasoningLabelKey = (value: string): string => (value === REASONING_AUTO ? 'ai_reasoning_auto' : `ai_reasoning_level_${value}`);

/** The key of the query that fetches the answer for a model, so that a page and a test name the same one. */
export const modelInfoKey = (preset: string | undefined, protocol: string | undefined, apiBaseUrl: string, model: string) => ['modelInfo', preset ?? '', protocol ?? '', apiBaseUrl.trim(), model.trim()] as const;
