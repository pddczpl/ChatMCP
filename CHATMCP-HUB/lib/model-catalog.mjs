// The model catalog: what the Hub knows about a model before it asks the provider. Its context window, its output cap, its prices and how it can be told
// to think, from a compact snapshot (lib/model-catalog.data.json) of https://models.dev/api.json (MIT, see THIRD-PARTY-NOTICES.md).
//
// Nothing here touches the network: the snapshot is a file in the Hub, dated, and updated by a maintainer (scripts/update-model-catalog.mjs). An answer carries
// where it came from ("catalog@2026-10-19") and how sure it is, because the catalog can be wrong or stale and a person must be able to tell:
//   confidence 'exact'       the provider and the id are in the catalog as written
//   confidence 'normalized'  the same model under another spelling (a region prefix, a date, dots for dashes: "us.anthropic.claude-sonnet-4-5-20250929-v1:0")
//   confidence 'alias'       another provider's listing of it, found through the catalog's canonical id ("anthropic/claude-sonnet-4.5" on OpenRouter)
//   confidence 'none'        not found. A user's own alias, a local runtime's tag. Never a guess: a wrong model is worse than none.
//
// Snapshot format (version 1): { version, generatedAt: 'YYYY-MM-DD', source, sha256, canon: [canonical id], hosts: { host: provider id },
//   providers: { provider id: { model id: row index } }, rows: [[context, output, input limit, [in, out, cacheRead, cacheWrite] | null, flags, options | 0, canon index?]] }
//   flags: 1 tool calls, 2 reads images, 4 reasons, 8 open weights, 16 not stable (beta, alpha, deprecated). Prices are USD per million tokens.
//   options: [['e', ...efforts], ['t'], ['b', min, max]] = an effort level, an on/off switch, a token budget; 0 for none.
import { readFileSync } from 'node:fs';
import { usableContextWindow } from './context-window.mjs';
import { EFFORT_LEVELS } from './reasoning-effort.mjs';

const SNAPSHOT_URL = new URL('./model-catalog.data.json', import.meta.url);
const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

/** Preset id -> provider id in the catalog. Local runtimes and the "custom" presets have none: the endpoint decides. */
export const CATALOG_PROVIDER_OF_PRESET = Object.freeze({
  anthropic: 'anthropic', openai: 'openai', 'openai-responses': 'openai', gemini: 'google', openrouter: 'openrouter', deepseek: 'deepseek', groq: 'groq', mistral: 'mistral',
});
/** Hosts of the first-party providers, which the catalog does not list (it lists the endpoints of the others). */
const FIRST_PARTY_HOSTS = Object.freeze({
  'api.anthropic.com': 'anthropic', 'api.openai.com': 'openai', 'generativelanguage.googleapis.com': 'google', 'api.groq.com': 'groq', 'api.mistral.ai': 'mistral', 'api.x.ai': 'xai',
  'openrouter.ai': 'openrouter', 'api.deepseek.com': 'deepseek',
});
/** The makers of models that other endpoints serve under the same id. */
const MAKERS = Object.freeze(['anthropic', 'openai', 'google', 'xai', 'mistral', 'deepseek']);
const LOCAL_PRESETS = new Set(['ollama', 'lmstudio']);
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * One spelling for the ids of one model: lower case, without the region prefix of a cloud ("us.", "global."), the vendor ("anthropic/", "anthropic."), the version
 * suffix ("-v1:0", "@20250929", ":latest"), the date ("-20250929"), and with dots written as dashes ("4.5" -> "4-5").
 */
export function normalizeModelId(id) {
  return String(id).trim().toLowerCase()
    .replace(/^(global|us|eu|apac|jp|au|in)\./, '').replace(/^[a-z0-9-]+\//, '').replace(/^anthropic\./, '')
    .replace(/[:@](latest|\d{8}.*|v\d.*)$/, '').replace(/-v\d+(:\d+)?$/, '').replace(/-\d{8}$/, '').replace(/\./g, '-');
}

function hostOf(apiBaseUrl) {
  try { return new URL(apiBaseUrl).host.toLowerCase(); } catch { return null; }
}

const LOCAL_RESULT = Object.freeze({ local: true });

/** A catalog over a snapshot. `createCatalog(snapshot)` is for tests with a small one; `lookup` below is the Hub's, over the file. */
export function createCatalog(snapshot) {
  if (!isObject(snapshot) || snapshot.version !== 1 || !Array.isArray(snapshot.rows) || !isObject(snapshot.providers) || !Array.isArray(snapshot.canon)) {
    throw new Error('model catalog: the snapshot is not a version 1 catalog.');
  }
  const { rows, providers, canon } = snapshot;
  const hosts = isObject(snapshot.hosts) ? snapshot.hosts : {};
  const source = `catalog@${snapshot.generatedAt}`;
  let byNormalized = null;
  let byCanonical = null;

  const normalizedIn = (providerId) => {
    byNormalized ??= new Map();
    if (!byNormalized.has(providerId)) {
      const map = new Map();
      for (const modelId of Object.keys(providers[providerId] ?? {})) { const key = normalizeModelId(modelId); if (!map.has(key)) map.set(key, modelId); }
      byNormalized.set(providerId, map);
    }
    return byNormalized.get(providerId);
  };
  const canonical = () => {
    if (byCanonical) return byCanonical;
    byCanonical = new Map();
    for (const [providerId, models] of Object.entries(providers)) {
      for (const [modelId, rowIndex] of Object.entries(models)) {
        const at = rows[rowIndex][6];
        if (at === undefined) continue;
        const key = canon[at].toLowerCase();
        const creator = key.startsWith(`${providerId}/`);
        const held = byCanonical.get(key);
        // The listing of the model's own maker is the one to answer from; failing that, the first.
        if (!held || (creator && !held.creator)) byCanonical.set(key, { providerId, modelId, rowIndex, creator });
      }
    }
    return byCanonical;
  };

  const reasoningOf = (row) => {
    const options = Array.isArray(row[5]) ? row[5] : [];
    const effort = options.find((option) => option[0] === 'e');
    const budget = options.find((option) => option[0] === 'b');
    return {
      supported: (row[4] & 4) !== 0,
      efforts: effort ? effort.slice(1).filter((level) => EFFORT_LEVELS.includes(level)) : [], // a word the Hub has no setting for ("default") is left out
      toggle: options.some((option) => option[0] === 't'),
      budget: budget ? { min: budget[1], max: budget[2] } : null,
    };
  };
  const answer = (providerId, modelId, rowIndex, confidence) => {
    const row = rows[rowIndex];
    return {
      found: true, confidence, local: false, provider: providerId, modelId, source,
      contextWindow: usableContextWindow(row[0]), maxOutput: row[1] ?? null, maxInput: row[2] ?? null,
      rates: row[3] ? { input: row[3][0], output: row[3][1], cacheRead: row[3][2], cacheWrite: row[3][3] } : null,
      toolCall: (row[4] & 1) !== 0, vision: (row[4] & 2) !== 0, openWeights: (row[4] & 8) !== 0, notStable: (row[4] & 16) !== 0,
      reasoning: reasoningOf(row),
    };
  };
  const nothing = (extra = {}) => ({
    found: false, confidence: 'none', local: false, provider: null, modelId: null, source: null, contextWindow: null, maxOutput: null, maxInput: null, rates: null,
    toolCall: null, vision: null, openWeights: null, notStable: null, reasoning: { supported: null, efforts: [], toggle: false, budget: null }, ...extra,
  });

  /** The catalog providers an endpoint can be, most certain first: the host it is aimed at, then the preset. */
  const candidates = ({ presetId, apiBaseUrl, provider }) => {
    const found = [];
    const add = (id) => { if (id && providers[id] && !found.includes(id)) found.push(id); };
    add(provider);
    const host = hostOf(apiBaseUrl);
    if (host) {
      add(FIRST_PARTY_HOSTS[host] ?? hosts[host]);
      if (/\.openai\.azure\.com$|\.cognitiveservices\.azure\.com$/.test(host)) add('azure');
      if (/^bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com$/.test(host)) add('amazon-bedrock');
    }
    add(CATALOG_PROVIDER_OF_PRESET[presetId]);
    return found;
  };

  /**
   * @param {{presetId?: string, protocol?: string, apiBaseUrl?: string, model: string, provider?: string}} query `provider` names a catalog provider outright (tests)
   */
  function lookup({ presetId = '', apiBaseUrl = '', model, provider } = {}) {
    const id = typeof model === 'string' ? model.trim() : '';
    if (!id) return nothing();
    const host = hostOf(apiBaseUrl);
    if (LOCAL_PRESETS.has(presetId) || (host && LOOPBACK.has(host.replace(/:\d+$/, '')) && !provider)) return nothing(LOCAL_RESULT);
    const ofProviders = candidates({ presetId, apiBaseUrl, provider });
    for (const providerId of ofProviders) {
      if (Object.hasOwn(providers[providerId], id)) return answer(providerId, id, providers[providerId][id], 'exact');
    }
    const wanted = normalizeModelId(id);
    for (const providerId of ofProviders) {
      const modelId = normalizedIn(providerId).get(wanted);
      if (modelId !== undefined) return answer(providerId, modelId, providers[providerId][modelId], 'normalized');
    }
    // A gateway's own spelling of a model of another maker ("anthropic/claude-sonnet-4.5"): the catalog's canonical ids name it.
    const viaCanonical = canonical().get(id.toLowerCase()) ?? canonical().get(`${id.toLowerCase().split('/')[0]}/${wanted}`);
    if (viaCanonical && (ofProviders.length > 0 || /\//.test(id))) return answer(viaCanonical.providerId, viaCanonical.modelId, viaCanonical.rowIndex, 'alias');
    // An endpoint the catalog does not know (a company proxy, a LiteLLM in front of Bedrock) with the id of a model of one of the makers: their own listing answers, only
    // when exactly one of them has it.
    if (ofProviders.length === 0) {
      const hits = MAKERS.filter((makerId) => providers[makerId]).map((makerId) => [makerId, Object.hasOwn(providers[makerId], id) ? id : normalizedIn(makerId).get(wanted)]).filter(([, modelId]) => modelId !== undefined);
      if (hits.length === 1) return answer(hits[0][0], hits[0][1], providers[hits[0][0]][hits[0][1]], 'alias');
    }
    return nothing();
  }

  const modelCount = Object.values(providers).reduce((sum, models) => sum + Object.keys(models).length, 0);
  const info = () => ({
    version: snapshot.version, generatedAt: snapshot.generatedAt, source: snapshot.source, sha256: snapshot.sha256, label: source,
    providers: Object.keys(providers).length, models: modelCount, ageDays: Math.floor((Date.now() - Date.parse(`${snapshot.generatedAt}T00:00:00Z`)) / 86400000),
  });
  return { lookup, info, providerIds: () => Object.keys(providers), modelIds: (providerId) => Object.keys(providers[providerId] ?? {}) };
}

let shared = null;
/** The Hub's catalog, read from the snapshot file the first time it is needed (not when the Hub starts). */
export function defaultCatalog() {
  shared ??= createCatalog(JSON.parse(readFileSync(SNAPSHOT_URL, 'utf8')));
  return shared;
}
export const lookup = (query) => defaultCatalog().lookup(query);
export const catalogInfo = () => defaultCatalog().info();
