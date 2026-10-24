// What the Hub knows about a model before anything is sent to it, in the shape the settings page asks for (GET /api/ai/model-info): the limits and prices the catalog lists, what the Hub
// would plan on from them, and the levels of thinking effort that can be offered for this model on this protocol, with the reason when there are none; and the list of a provider's
// models for the model picker (GET /api/ai/catalog/models). Nothing here touches the network.
import { catalogInfo, lookup, models } from './model-catalog.mjs';
import { factsFromInfo } from './model-facts.mjs';
import { offeredLevels } from './reasoning-effort.mjs';
import { presetById } from './provider-presets.mjs';

const PROTOCOLS = Object.freeze(['gemini', 'openai-chat', 'openai-responses', 'anthropic']);
const MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,150}$/;
const MODELS_LIMIT = 1000;
const invalid = (message, code = 'invalid_model_info_query') => Object.assign(new Error(message), { code, statusCode: 400 });

/**
 * The query of the route, checked. `preset` is a connection preset (anthropic, openai, custom-openai ...), `protocol` defaults to the preset's, `apiBaseUrl` is optional and
 * only its host is used.
 * @param {URLSearchParams} params
 * @returns {{presetId: string, protocol: string, apiBaseUrl: string, model: string}}
 */
export function modelInfoQuery(params) {
  const model = (params.get('model') ?? '').trim();
  if (!MODEL_ID.test(model)) throw invalid('model: give the model id (letters, digits and . _ : / -, at most 151 characters).');
  const presetId = (params.get('preset') ?? '').trim();
  const preset = presetId ? presetById(presetId) : null;
  if (presetId && !preset) throw invalid('preset: not a connection preset of this Hub.');
  const protocol = (params.get('protocol') ?? '').trim() || preset?.protocol || '';
  if (!PROTOCOLS.includes(protocol)) throw invalid(`protocol: give a preset or one of ${PROTOCOLS.join(', ')}.`);
  const apiBaseUrl = (params.get('apiBaseUrl') ?? '').trim();
  if (apiBaseUrl) {
    let url;
    try { url = new URL(apiBaseUrl); } catch { throw invalid('apiBaseUrl: not a URL.'); }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw invalid('apiBaseUrl: http or https only.');
  }
  return { presetId, protocol, apiBaseUrl: apiBaseUrl || preset?.apiBaseUrl || '', model };
}

/**
 * The answer for a checked query. `trusted` says whether the Hub plans and prices from this answer (the catalog is sure of the model: lib/model-facts.mjs); `capacity` is the window it
 * would plan a conversation on when the owner typed none, `modelCapacity` what the model itself allows and `priceCap` the price rise that stopped it short of that (null when none did),
 * `outputCap` the most it would ask the model to write. An alias of a gateway is shown with its facts, but is not trusted.
 */
export function modelInfo({ presetId, protocol, apiBaseUrl, model }) {
  const info = lookup({ presetId, protocol, apiBaseUrl, model });
  const levels = offeredLevels({ protocol, apiBaseUrl, info });
  const facts = factsFromInfo(info);
  const { generatedAt, ageDays } = catalogInfo();
  return {
    model, protocol, preset: presetId || null,
    found: info.found, confidence: info.confidence, source: info.source, provider: info.provider, catalogModel: info.modelId, local: info.local,
    contextWindow: info.contextWindow, maxInput: info.maxInput, maxOutput: info.maxOutput, rates: info.rates, tiers: info.tiers, status: info.status,
    toolCall: info.toolCall, vision: info.vision, openWeights: info.openWeights,
    trusted: facts !== null, capacity: facts?.capacity ?? null, modelCapacity: facts?.modelCapacity ?? null, priceCap: facts?.priceCap ?? null, outputCap: facts?.outputCap ?? null,
    reasoning: { supported: info.reasoning.supported, toggle: info.reasoning.toggle, budget: info.reasoning.budget, efforts: info.reasoning.efforts, levels: levels.levels, known: levels.known, why: levels.why },
    catalog: { generatedAt, ageDays },
  };
}

/**
 * The query of the list route, checked: a `preset` (anthropic, openai, custom-openai ...) or an `apiBaseUrl` (or both: the endpoint decides when the preset does not), and a `limit` of
 * 1..1000 models (1000 when none is given).
 * @param {URLSearchParams} params
 */
export function modelsQuery(params) {
  const code = 'invalid_model_list_query';
  const presetId = (params.get('preset') ?? '').trim();
  const preset = presetId ? presetById(presetId) : null;
  if (presetId && !preset) throw invalid('preset: not a connection preset of this Hub.', code);
  const apiBaseUrl = (params.get('apiBaseUrl') ?? '').trim();
  if (apiBaseUrl) {
    let url;
    try { url = new URL(apiBaseUrl); } catch { throw invalid('apiBaseUrl: not a URL.', code); }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw invalid('apiBaseUrl: http or https only.', code);
  }
  if (!presetId && !apiBaseUrl) throw invalid('give a preset or an apiBaseUrl.', code);
  let limit = MODELS_LIMIT;
  if (params.has('limit')) {
    limit = Number(params.get('limit'));
    if (!Number.isInteger(limit) || limit < 1 || limit > MODELS_LIMIT) throw invalid(`limit: a whole number from 1 to ${MODELS_LIMIT}.`, code);
  }
  return { presetId, apiBaseUrl: apiBaseUrl || preset?.apiBaseUrl || '', limit };
}

/** The models of the provider an endpoint is, in the compact form the picker lists (nothing about an alias or a local runtime: the catalog does not guess what they serve), and only ids the Hub accepts as a model: it refuses to save the others. */
export function modelsList({ presetId, apiBaseUrl, limit }) {
  const list = models({ presetId, apiBaseUrl }, { limit, accept: (id) => MODEL_ID.test(id) });
  return {
    provider: list.provider, source: list.source, local: list.local, total: list.total, truncated: list.truncated,
    models: list.models.map((entry) => ({
      id: entry.modelId, contextWindow: entry.contextWindow, maxInput: entry.maxInput, maxOutput: entry.maxOutput,
      rates: entry.rates ? { input: entry.rates.input, output: entry.rates.output } : null, tiered: entry.tiers.length > 0,
      reasoning: entry.reasoning.supported === true, toolCall: entry.toolCall, vision: entry.vision, status: entry.status,
    })),
  };
}
