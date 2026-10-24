// What the Hub knows about a model before anything is sent to it, in the shape the settings page asks for (GET /api/ai/model-info): the limits the catalog lists, and
// the levels of thinking effort that can be offered for this model on this protocol, with the reason when there are none. Nothing here touches the network.
import { catalogInfo, lookup } from './model-catalog.mjs';
import { offeredLevels } from './reasoning-effort.mjs';
import { presetById } from './provider-presets.mjs';

const PROTOCOLS = Object.freeze(['gemini', 'openai-chat', 'openai-responses', 'anthropic']);
const MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,150}$/;
const invalid = (message) => Object.assign(new Error(message), { code: 'invalid_model_info_query', statusCode: 400 });

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

/** The answer for a checked query. */
export function modelInfo({ presetId, protocol, apiBaseUrl, model }) {
  const info = lookup({ presetId, protocol, apiBaseUrl, model });
  const levels = offeredLevels({ protocol, apiBaseUrl, info });
  const { generatedAt, ageDays } = catalogInfo();
  return {
    model, protocol, preset: presetId || null,
    found: info.found, confidence: info.confidence, source: info.source, provider: info.provider, local: info.local,
    contextWindow: info.contextWindow, maxOutput: info.maxOutput, toolCall: info.toolCall, vision: info.vision,
    reasoning: { supported: info.reasoning.supported, toggle: info.reasoning.toggle, budget: info.reasoning.budget, efforts: info.reasoning.efforts, levels: levels.levels, known: levels.known, why: levels.why },
    catalog: { generatedAt, ageDays },
  };
}
