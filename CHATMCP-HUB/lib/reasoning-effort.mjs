// How much a model is asked to think: the one setting ("thinking effort"), what it means on each wire protocol, and what to do when a provider refuses it.
//
// The setting is a word: 'auto' (the default: send nothing, the model decides) or a level. A level is sent only where the model and the protocol can take it, and the
// answer to "why not" is a code, so the settings page can say it instead of leaving a person to wonder:
//   model_does_not_reason   the catalog says this model does not think
//   value_not_offered       the model thinks, but the catalog does not list this level for it (the levels it offers are in the catalog answer)
//   no_effort_control       the model thinks, but is controlled by a token budget or a switch, which this setting does not drive yet
//   value_not_valid_here    this protocol has no such level (Anthropic has no "none" or "minimal")
//   protocol_not_supported  the protocol has no field for it yet (Gemini)
// A model the catalog does not know gets the level as chosen: the person knows their endpoint better than a snapshot does, and if the provider refuses it the request
// is repeated once without it and the refusal is remembered (see refusesReasoning, and the callers).
import { errorDetail } from './model-http.mjs';

export const AUTO = 'auto';
/** From none (thinking off, where the model allows it) to max. The order is the order a settings page shows them in. */
export const EFFORT_LEVELS = Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
/** The levels `output_config.effort` of the Messages API takes. */
const ANTHROPIC_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

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
  const listed = known && info.reasoning.efforts.length > 0 ? EFFORT_LEVELS.filter((level) => info.reasoning.efforts.includes(level)) : GENERIC_LEVELS;
  return { levels: listed.filter((level) => reasoningDecision({ effort: level, protocol, apiBaseUrl, info }).send !== null), known, why: null };
}

/** Puts a decision into a request body. A field that is already an object (output_config may carry other keys) is merged into, not replaced. */
export function applyReasoning(body, send) {
  if (!send) return body;
  const held = body[send.field];
  body[send.field] = held && typeof held === 'object' && typeof send.value === 'object' ? { ...held, ...send.value } : send.value;
  return body;
}

const FIELD_WORDS = /\b(?:reasoning(?:_effort)?|effort|thinking|output_config)\b/i;
/**
 * Whether a response is the provider refusing the thinking setting we sent, and nothing else: a plain 400 (or 422) that names it in the parameter or the words. A 400 about the
 * context, the output cap, the quota or the model is not about it, and neither is a rate limit or a server error.
 */
export function refusesReasoning({ status, data, info, sent }) {
  if (!sent || (status !== 400 && status !== 422) || info?.kind !== 'request') return false;
  const param = data?.error?.param;
  return (typeof param === 'string' && FIELD_WORDS.test(param)) || FIELD_WORDS.test(errorDetail(data));
}
