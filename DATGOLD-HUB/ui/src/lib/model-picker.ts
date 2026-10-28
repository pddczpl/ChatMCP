// The model picker as data: which models the list shows, in which order, filtered how, with which badges. Kept out of the component so that the rules are testable without a browser.
//   * The list is the account's own (what the provider says this key can use) when the Hub could ask for it, each model with the facts the catalog has; else the catalog's list for the provider.
//   * A model the catalog marks deprecated is not offered (the provider has stopped serving it, or is about to; models.dev marks about one in ten so), unless it is the one that is configured: a
//     connection that uses it must still see it. The rest is by id.
//   * The badges say only what the catalog says: a number that is not there is not written as zero, a capability the model lacks is not a badge.
import type { AccountModel, CatalogModel, ModelInfo } from '../types/index.ts';
import type { Translate } from './i18n.ts';
import '@/lib/i18n-models'; // the strings only the picker asks for load with it (accountOutcome words one of them)

export interface PickerChoice {
  id: string;
  /** The catalog has facts about it. */
  inCatalog: boolean;
  /** The account's own list has it (the Hub asked the provider and it answered). */
  listed: boolean;
  contextWindow: number | null;
  maxInput: number | null;
  maxOutput: number | null;
  rates: { input: number; output: number } | null;
  tiered: boolean;
  reasoning: boolean;
  toolCall: boolean | null;
  vision: boolean | null;
  status: string | null;
}

const fromCatalog = (model: CatalogModel, listed: boolean): PickerChoice => ({
  id: model.id, inCatalog: true, listed, contextWindow: model.contextWindow, maxInput: model.maxInput, maxOutput: model.maxOutput, rates: model.rates,
  tiered: model.tiered, reasoning: model.reasoning, toolCall: model.toolCall, vision: model.vision, status: model.status,
});
const unknownModel = (id: string, listed: boolean): PickerChoice => ({
  id, inCatalog: false, listed, contextWindow: null, maxInput: null, maxOutput: null, rates: null, tiered: false, reasoning: false, toolCall: null, vision: null, status: null,
});
const order = (a: PickerChoice, b: PickerChoice) => Number(a.status === 'deprecated') - Number(b.status === 'deprecated') || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The models to choose from. An empty account list is no list. `keep`: ids that stay in the list even when deprecated (the model that is configured). */
export function mergeChoices(catalog: CatalogModel[] | undefined, account: AccountModel[] | undefined, { keep = [] }: { keep?: string[] } = {}): PickerChoice[] {
  const offered = (choice: PickerChoice) => choice.status !== 'deprecated' || keep.includes(choice.id);
  const known = new Map<string, CatalogModel>();
  for (const model of catalog ?? []) if (model?.id && !known.has(model.id)) known.set(model.id, model);
  if (account && account.length > 0) {
    const seen = new Set<string>();
    const choices: PickerChoice[] = [];
    for (const item of account) {
      if (!item?.id || seen.has(item.id)) continue;
      seen.add(item.id);
      const model = known.get(item.id);
      // The Hub adds the model that is configured to the list when the provider did not list it (`listed: false`), so that the choice is not lost: it is not one the account has.
      const listed = item.listed !== false;
      choices.push(model ? fromCatalog(model, listed) : unknownModel(item.id, listed));
    }
    return choices.filter(offered).sort(order);
  }
  return [...known.values()].map((model) => fromCatalog(model, false)).filter(offered).sort(order);
}

export type KeyAction = { type: 'none' } | { type: 'open' } | { type: 'close' } | { type: 'move'; active: number } | { type: 'pick'; index: number };

/**
 * What a key does in the field: the arrows open the list and move through it (stopping at its ends), Enter takes the model that is active, Escape closes. Anything else, and Enter in a
 * closed field, is left to the page.
 */
export function keyAction(key: string, open: boolean, active: number, count: number): KeyAction {
  if (key === 'ArrowDown') return open ? { type: 'move', active: Math.min(active + 1, Math.max(0, count - 1)) } : { type: 'open' };
  if (key === 'ArrowUp' && open) return { type: 'move', active: Math.max(active - 1, 0) };
  if (key === 'Enter' && open && active >= 0 && active < count) return { type: 'pick', index: active };
  if (key === 'Escape' && open) return { type: 'close' };
  return { type: 'none' };
}

/** The models whose id holds the text (any part of it, any case): the id itself first, then ids that start with it, then the rest in the order of the list; at most `limit`. */
export function filterChoices(choices: PickerChoice[], text: string, limit: number): { shown: PickerChoice[]; total: number } {
  const wanted = text.trim().toLowerCase();
  if (!wanted) return { shown: choices.slice(0, limit), total: choices.length };
  const ranked: { choice: PickerChoice; rank: number; at: number }[] = [];
  choices.forEach((choice, at) => {
    const id = choice.id.toLowerCase();
    const rank = id === wanted ? 0 : id.startsWith(wanted) ? 1 : id.includes(wanted) ? 2 : -1;
    if (rank >= 0) ranked.push({ choice, rank, at });
  });
  ranked.sort((a, b) => a.rank - b.rank || a.at - b.at);
  return { shown: ranked.slice(0, limit).map((item) => item.choice), total: ranked.length };
}

/**
 * What the Hub's answer about the account's models turns into: the list when the provider itself answered, else the Hub's own warning (or ours) and no list. The Hub answers with the
 * configured model alone (source "configured") when it could not ask the provider; that is not a list of the account's models.
 */
export function accountOutcome(answer: { models?: AccountModel[]; source?: string; warning?: string } | undefined, t: Translate): { ok: true; models: AccountModel[]; message: string } | { ok: false; message: string } {
  const models = answer?.models ?? [];
  const listed = models.filter((model) => model.listed !== false).length;
  if (answer?.source === 'provider' && listed > 0) return { ok: true, models, message: t('ai_model_account_loaded', { n: listed }) };
  return { ok: false, message: answer?.warning || t('ai_model_account_failed') };
}

/** 1,000,000 -> "1M", 1,048,576 -> "1M", 400,000 -> "400K", 8,192 -> "8K"; null for a size that is not there. */
export function formatTokens(value: number | null | undefined): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  if (value >= 1_000_000 || Math.round(value / 1000) >= 1000) {
    const millions = Math.round(value / 100_000) / 10;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  if (value >= 1000) return `${Math.round(value / 1000)}K`;
  return String(value);
}

const money = (value: number) => String(Number(value.toFixed(4)));
/** "$2 / $10": USD per million tokens, input then output. */
export function formatPrice(rates: { input: number; output: number } | null | undefined): string | null {
  if (!rates || !Number.isFinite(rates.input) || !Number.isFinite(rates.output)) return null;
  return `$${money(rates.input)} / $${money(rates.output)}`;
}

export interface Badge {
  /** The key of the badge's words in the dictionary is ai_model_badge_<kind>. */
  kind: 'context' | 'price' | 'tiered' | 'think' | 'tools' | 'vision' | 'status' | 'account';
  params?: Record<string, string>;
}

/**
 * The line under the model field: what the catalog says about the model typed there. `known` is a model the Hub relies on (the catalog is sure of it); `alias` looks like another
 * model of the catalog and is shown as such, but the Hub plans and prices from nothing of it. None for a model the catalog does not know and for a local runtime.
 */
export function factsOf(info: ModelInfo | undefined): { kind: 'known' | 'alias'; id: string; source: string; badges: Badge[] } | null {
  if (!info || !info.found) return null;
  const choice: PickerChoice = {
    id: info.catalogModel ?? info.model, inCatalog: true, listed: false, contextWindow: info.contextWindow, maxInput: info.maxInput ?? null, maxOutput: info.maxOutput,
    rates: info.rates ? { input: info.rates.input, output: info.rates.output } : null, tiered: (info.tiers ?? []).length > 0, reasoning: info.reasoning?.supported === true,
    toolCall: info.toolCall, vision: info.vision, status: info.status ?? null,
  };
  return { kind: info.confidence === 'exact' || info.confidence === 'normalized' ? 'known' : 'alias', id: choice.id, source: info.source ?? 'catalog', badges: badgesOf(choice) };
}

/** What to say about a model, in order: the window (with the input limit when it is lower), the price, a thinking model, tools, images, the status, and that the account has it. */
export function badgesOf(choice: PickerChoice): Badge[] {
  const badges: Badge[] = [];
  const size = formatTokens(choice.contextWindow);
  if (size !== null) {
    const input = choice.maxInput && choice.contextWindow !== null && choice.maxInput < choice.contextWindow ? formatTokens(choice.maxInput) : null;
    badges.push({ kind: 'context', params: { size, ...(input !== null ? { input } : {}) } });
  }
  const price = formatPrice(choice.rates);
  if (price !== null) badges.push({ kind: 'price', params: { price } });
  if (choice.tiered) badges.push({ kind: 'tiered' });
  if (choice.reasoning) badges.push({ kind: 'think' });
  if (choice.toolCall === true) badges.push({ kind: 'tools' });
  if (choice.vision === true) badges.push({ kind: 'vision' });
  if (choice.status) badges.push({ kind: 'status', params: { status: choice.status } });
  if (choice.listed) badges.push({ kind: 'account' });
  return badges;
}
