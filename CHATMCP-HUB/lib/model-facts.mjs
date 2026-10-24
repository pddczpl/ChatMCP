// What the Hub relies on about a model before it asks the provider: the model catalog's answer (lib/model-catalog.mjs) when the catalog is SURE of the model, turned into the numbers the agent
// plans with: the capacity its conversation is planned against, the most it is asked to write, and the prices a task is estimated at. Pure: it asks the catalog it is given and does nothing else.
//
// "Sure" is exact (the id as the catalog has it) or normalized (the same id in another spelling). A gateway's alias of a maker's model, a local runtime and a miss are not relied on: a window
// or a price of the wrong model is worse than none, and none is what the Hub has always planned with (a conservative estimate, said on screen). The settings page may still SHOW what the
// catalog says about an alias; it is only never budgeted or priced from.
import { isTrusted, lookup } from './model-catalog.mjs';
import { CONTEXT_WINDOW_MIN, usableContextWindow } from './context-window.mjs';
import { plannedOutputFor, safetyMarginFor } from './context-reserve.mjs';

/** The most the agent asks a model to write in one answer. A smaller cap of the model's own lowers it; a larger one does not raise it. */
export const AGENT_OUTPUT_TOKENS = 16384;
/** A cap below this cannot hold an answer worth asking for: it is taken for a gap in the catalog, not for a limit. */
const MIN_USABLE_OUTPUT_CAP = 1024;

/**
 * The largest capacity, not above `ceiling`, whose planned prompt is not longer than the model takes in. The prompt a run plans is the capacity less the output it reserves and the margin it keeps
 * (lib/context-reserve.mjs, the same formulas as the budget of a run): for an input limit not far above the output, adding the whole output to the limit would plan a prompt the model refuses.
 * When even the smallest usable window plans a longer one, the smallest is what there is.
 */
function capacityWithinInput(maxInput, outputLimit, ceiling) {
  const promptFor = (capacity) => capacity - plannedOutputFor(capacity, outputLimit) - safetyMarginFor(capacity);
  if (promptFor(ceiling) <= maxInput) return ceiling;
  let fits = CONTEXT_WINDOW_MIN;
  if (promptFor(fits) > maxInput) return fits;
  let over = ceiling;
  while (over - fits > 1) {
    const middle = Math.floor((fits + over) / 2);
    if (promptFor(middle) <= maxInput) fits = middle; else over = middle;
  }
  return fits;
}

/**
 * The facts of one catalog answer, or null when the Hub does not rely on it.
 * @returns {{source: string, confidence: string, provider: string, modelId: string, contextWindow: number|null, maxInput: number|null, maxOutput: number|null,
 *   outputCap: number|null, capacity: number|null, pricing: {source: string, confidence: string, rates: object, tiers: object[]}|null}|null}
 *   `capacity` is the number a conversation is planned against: the window, unless the model lists an input limit below it, in which case the largest capacity, at most the input limit plus the output
 *   the agent reserves, whose planned prompt is not longer than the model takes in (`capacityWithinInput`). `outputCap` is what the agent may ask the model to write. `pricing` is what the cost estimate is made from.
 */
export function factsFromInfo(info) {
  if (!isTrusted(info)) return null;
  const outputCap = Number.isInteger(info.maxOutput) && info.maxOutput >= MIN_USABLE_OUTPUT_CAP ? Math.min(AGENT_OUTPUT_TOKENS, info.maxOutput) : null;
  const window = info.contextWindow ?? null;
  const limited = window !== null && Number.isInteger(info.maxInput) && info.maxInput > 0 && info.maxInput < window;
  const outputLimit = outputCap ?? AGENT_OUTPUT_TOKENS;
  const ceiling = limited ? usableContextWindow(Math.min(window, info.maxInput + outputLimit)) : window;
  const capacity = limited && ceiling !== null ? capacityWithinInput(info.maxInput, outputLimit, ceiling) : ceiling;
  const priced = info.rates && Number.isFinite(info.rates.input) && Number.isFinite(info.rates.output);
  return {
    source: info.source, confidence: info.confidence, provider: info.provider, modelId: info.modelId,
    contextWindow: window, maxInput: info.maxInput ?? null, maxOutput: info.maxOutput ?? null, outputCap, capacity,
    pricing: priced ? { source: info.source, confidence: info.confidence, rates: info.rates, tiers: info.tiers ?? [] } : null,
  };
}

/** The facts for a connection: `{presetId, apiBaseUrl, protocol, model}`, answered by `lookupModel` (the Hub's catalog unless a test brings its own). */
export function modelFacts(query, lookupModel = lookup) {
  return factsFromInfo(lookupModel(query));
}
