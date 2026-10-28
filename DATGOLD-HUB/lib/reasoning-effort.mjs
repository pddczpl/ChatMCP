// How much a model is asked to think: the one setting ("thinking effort"), what it means on each wire protocol, and what to do when a provider refuses it.
//
// The setting is a word: 'auto' (the default: send nothing, the model decides) or a level. A level is sent only where the model and the protocol can take it, and the
// answer to "why not" is a code, so the settings page can say it instead of leaving a person to wonder:
//   model_does_not_reason   the catalog says this model does not think
//   value_not_offered       the model thinks, but the catalog does not list this level for it (the levels it offers are in the catalog answer)
//   no_effort_control       the model thinks, but is controlled by a switch, or by a token budget on a protocol that has no ladder for it (only Gemini does)
//   value_not_valid_here    this protocol has no such level (Anthropic has no "none" or "minimal"; Gemini has no "none", "xhigh" or "max" level)
//   protocol_not_supported  the protocol has no field for it (none of the four has none, but a new one would start here)
// Gemini keeps the setting in generationConfig.thinkingConfig, and the two models of it are driven differently: Gemini 3 and 4 by a level (thinkingLevel), Gemini 2.5 by a token
// budget (thinkingBudget). The catalog says which, and the levels of this setting are mapped onto a ladder of budgets for the second (geminiBudgetFor). The two are never sent
// together: the API answers 400.
// A model the catalog does not know gets the level as chosen: the person knows their endpoint better than a snapshot does, and if the provider refuses it the request
// is repeated once without it and the refusal is remembered (see refusesReasoning, and the callers).
import { errorDetail } from './model-http.mjs';

export const AUTO = 'auto';
/** From none (thinking off, where the model allows it) to max. The order is the order a settings page shows them in. */
export const EFFORT_LEVELS = Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
/** The levels `output_config.effort` of the Messages API takes. */
const ANTHROPIC_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
/** The levels `generationConfig.thinkingConfig.thinkingLevel` of Gemini takes (a model lists the ones it accepts; "minimal" is refused by some). */
const GEMINI_LEVELS = Object.freeze(['minimal', 'low', 'medium', 'high']);
/** What a level is worth, in thinking tokens, on a Gemini 2.5 model (a model driven by a budget). The top level, "max", is the largest budget the model takes. */
const GEMINI_BUDGET_RUNGS = Object.freeze({ minimal: 512, low: 1024, medium: 8192, high: 24576 });

/**
 * The `thinkingBudget` for a level on a model driven by a budget, held to the range the catalog lists for it, or null when the model does not take the level: "none" is a
 * budget of 0 and only a model that can be switched off has it (2.5 Flash and Flash-Lite; 2.5 Pro cannot), and "xhigh" is not a rung.
 * @param {string} effort
 * @param {{toggle: boolean, budget: {min: number|null, max: number}}} reasoning the catalog's description of the model's thinking
 */
export function geminiBudgetFor(effort, reasoning) {
  const { min, max } = reasoning.budget;
  if (effort === 'none') return reasoning.toggle || min === 0 ? 0 : null;
  if (effort === 'max') return max;
  const rung = GEMINI_BUDGET_RUNGS[effort];
  return rung === undefined ? null : Math.min(max, Math.max(min ?? 0, rung));
}

/** Gemini: a level for a model of the catalog that lists levels, a budget for one that lists a budget, the level as chosen for a model the catalog does not describe. */
function geminiDecision(effort, reasoning) {
  const send = (thinkingConfig) => ({ send: { field: 'generationConfig', value: { thinkingConfig } }, why: null });
  if (reasoning && reasoning.efforts.length > 0) {
    if (!reasoning.efforts.includes(effort)) return { send: null, why: 'value_not_offered' };
    return GEMINI_LEVELS.includes(effort) ? send({ thinkingLevel: effort }) : { send: null, why: 'value_not_valid_here' };
  }
  if (reasoning && reasoning.supported === true) {
    if (!reasoning.budget || !Number.isInteger(reasoning.budget.max)) return { send: null, why: 'no_effort_control' };
    const thinkingBudget = geminiBudgetFor(effort, reasoning);
    return thinkingBudget === null ? { send: null, why: 'value_not_offered' } : send({ thinkingBudget });
  }
  return GEMINI_LEVELS.includes(effort) ? send({ thinkingLevel: effort }) : { send: null, why: 'value_not_valid_here' };
}

/** @returns {'auto'|string|undefined} 'auto' for nothing chosen, the level, or undefined for a word that is not a level (the caller refuses it). */
export function parseReasoningEffort(value) {
  if (value === undefined || value === null) return AUTO;
  if (typeof value !== 'string') return undefined;
  const text = value.trim().toLowerCase();
  if (text === '' || text === AUTO) return AUTO;
  return EFFORT_LEVELS.includes(text) ? text : undefined;
}

const isOpenRouter = (apiBaseUrl) => { try { return new URL(apiBaseUrl).hostname === 'openrouter.ai'; } catch { return false; } };

/**
 * @param {{effort?: string, protocol: string, apiBaseUrl?: string, info?: object|null}} request `info` is the catalog answer for the model (lib/model-catalog.mjs lookup)
 * @returns {{send: {field: string, value: unknown}|null, why: string|null}}
 */
export function reasoningDecision({ effort, protocol, apiBaseUrl = '', info = null } = {}) {
  if (!effort || effort === AUTO) return { send: null, why: null };
  const reasoning = info?.found === true ? info.reasoning : null;
  if (reasoning?.supported === false) return { send: null, why: 'model_does_not_reason' };
  if (protocol === 'gemini') return geminiDecision(effort, reasoning);
  if (reasoning && reasoning.efforts.length > 0 && !reasoning.efforts.includes(effort)) return { send: null, why: 'value_not_offered' };
  if (reasoning && reasoning.supported === true && reasoning.efforts.length === 0) return { send: null, why: 'no_effort_control' };
  switch (protocol) {
    case 'openai-responses': return { send: { field: 'reasoning', value: { effort } }, why: null };
    case 'openai-chat': return { send: isOpenRouter(apiBaseUrl) ? { field: 'reasoning', value: { effort } } : { field: 'reasoning_effort', value: effort }, why: null };
    case 'anthropic': return ANTHROPIC_LEVELS.includes(effort) ? { send: { field: 'output_config', value: { effort } }, why: null } : { send: null, why: 'value_not_valid_here' };
    default: return { send: null, why: 'protocol_not_supported' };
  }
}

const GENERIC_LEVELS = Object.freeze(['low', 'medium', 'high']);
const BLOCKS_EVERY_LEVEL = new Set(['model_does_not_reason', 'no_effort_control', 'protocol_not_supported']);

/**
 * The levels a settings page offers for a connection, in the order of EFFORT_LEVELS, and why there are none when there are none. They are the levels reasoningDecision would
 * send: the ones the catalog lists for the model that the protocol can carry or, for a model the catalog does not know, the three that every provider that has the setting
 * takes (`known: false` lets the page say that the list is a guess the provider may refuse).
 * @returns {{levels: string[], known: boolean, why: string|null}}
 */
export function offeredLevels({ protocol, apiBaseUrl = '', info = null } = {}) {
  const known = info?.found === true;
  const probe = reasoningDecision({ effort: 'high', protocol, apiBaseUrl, info });
  if (probe.send === null && BLOCKS_EVERY_LEVEL.has(probe.why)) return { levels: [], known, why: probe.why };
  // A model driven by a budget (Gemini 2.5) is offered the whole ladder; two levels that come to the same budget on it (high and max on 2.5 Flash) are offered once.
  const budgeted = known && protocol === 'gemini' && info.reasoning.efforts.length === 0 && info.reasoning.budget !== null;
  const listed = known && info.reasoning.efforts.length > 0 ? EFFORT_LEVELS.filter((level) => info.reasoning.efforts.includes(level)) : budgeted ? EFFORT_LEVELS : GENERIC_LEVELS;
  const budgets = new Set();
  const levels = listed.filter((level) => {
    const { send } = reasoningDecision({ effort: level, protocol, apiBaseUrl, info });
    if (send === null) return false;
    const budget = send.value?.thinkingConfig?.thinkingBudget;
    if (budget === undefined) return true;
    if (budgets.has(budget)) return false;
    budgets.add(budget);
    return true;
  });
  return { levels, known, why: null };
}

/** Puts a decision into a request body. A field that is already an object (output_config may carry other keys) is merged into, not replaced. */
export function applyReasoning(body, send) {
  if (!send) return body;
  const held = body[send.field];
  body[send.field] = held && typeof held === 'object' && typeof send.value === 'object' ? { ...held, ...send.value } : send.value;
  return body;
}

// The setting under its names on the four APIs, in snake or camel case: reasoning_effort, reasoning.effort, output_config.effort, thinking, thinkingConfig / thinking_config,
// thinkingBudget / thinking_budget, thinkingLevel / thinking_level.
const FIELD_WORDS = /\b(?:reasoning(?:_effort)?|effort|thinking(?:_?(?:config|budget|level))?|output_config)\b/i;
/**
 * Whether a response is the provider refusing the thinking setting we sent, and nothing else: a plain 400 (or 422) that names it in the parameter or the words. A 400 about the
 * context, the output cap, the quota or the model is not about it, and neither is a rate limit or a server error.
 */
export function refusesReasoning({ status, data, info, sent }) {
  if (!sent || (status !== 400 && status !== 422) || info?.kind !== 'request') return false;
  const param = data?.error?.param;
  return (typeof param === 'string' && FIELD_WORDS.test(param)) || FIELD_WORDS.test(errorDetail(data));
}
