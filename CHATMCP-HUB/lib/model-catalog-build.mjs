// The model catalog, built: from a models.dev document (https://models.dev/api.json, MIT) to the compact snapshot that lib/model-catalog.mjs answers from, and the capped download of that
// document. It lives in lib/ because two things use it: the maintainer script (scripts/update-model-catalog.mjs, which is not shipped) and the Hub itself, when its owner asks for the list of
// models to be updated (lib/model-catalog-store.mjs). Nothing here runs by itself and nothing here reads or writes a file.
//
// The snapshot: { version, generatedAt: 'YYYY-MM-DD', source, sha256, canon, rows, providers, hosts }, documented in lib/model-catalog.mjs. Format 2 adds, to a row, the price tiers of
// the model (a prompt above a size is priced at other rates) and refines the status bits.
import { createHash } from 'node:crypto';

export const SOURCE_URL = 'https://models.dev/api.json';
export const FORMAT_VERSION = 2;
/** The document is 5.8 MB today; twice that is room to grow, and still a bound on what an answer from the network can make the Hub hold in memory. */
export const MAX_DOWNLOAD_BYTES = 12 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30000;
const OPTION_TYPES = new Set(['effort', 'toggle', 'budget_tokens']);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const number = (value) => (Number.isFinite(value) && value >= 0 ? value : null);
const coded = (code, message) => Object.assign(new Error(message), { code });

// What a document, or a file saved from one, may call things. Real catalog ids are plain: 61 characters at most, printable, no space. The Hub takes a model id of 150 characters at most, so a
// longer one could never be used; and one with a line break in it is no id (it would be a line of the log, and the spelling of an id is worked on by patterns that grow with its length).
const MODEL_ID_OK = /^[^\s\u0000-\u001f\u007f]{1,150}$/u;
const PROVIDER_ID_OK = /^[a-z0-9][a-z0-9._-]{0,80}$/i; // not "__proto__", not a line
const HOST_OK = /^[a-z0-9.\-:[\]]{1,255}$/i;
export const isCatalogModelId = (value) => typeof value === 'string' && MODEL_ID_OK.test(value);
/** A text of the document, quoted for a message: one line, at most 60 characters. */
const shown = (value) => JSON.stringify(String(value).slice(0, 60));
const isRealDate = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const when = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(when.getTime()) && when.toISOString().slice(0, 10) === value;
};

/**
 * Flags of a model row: 1 tool calls, 2 reads images, 4 reasons, 8 open weights, 16 has a status other than stable, 32 beta, 64 deprecated, 128 alpha.
 * (A status the Hub does not know has bit 16 alone, and a format 1 snapshot has no more than that: "not stable".)
 */
export const FLAG = Object.freeze({ toolCall: 1, vision: 2, reasoning: 4, openWeights: 8, notStable: 16, beta: 32, deprecated: 64, alpha: 128 });

/** Throws on a shape the snapshot cannot be built from; unknown extra fields and unknown reasoning option types are ignored, a changed structure is not. */
export function validateRaw(raw) {
  if (!isObject(raw)) throw new Error('models.dev: the document is not an object of providers.');
  const providers = Object.entries(raw);
  if (providers.length < 20) throw new Error(`models.dev: only ${providers.length} providers; the document is not the catalog.`);
  let models = 0;
  for (const [providerId, provider] of providers) {
    if (!isObject(provider) || !isObject(provider.models)) throw new Error(`models.dev: provider ${shown(providerId)} has no models object.`);
    for (const [modelId, model] of Object.entries(provider.models)) {
      if (!isObject(model) || typeof (model.id ?? modelId) !== 'string') throw new Error(`models.dev: ${shown(providerId)}/${shown(modelId)} is not a model.`);
      if (model.limit !== undefined && !isObject(model.limit)) throw new Error(`models.dev: ${shown(providerId)}/${shown(modelId)}: "limit" is not an object.`);
      if (model.cost !== undefined && !isObject(model.cost)) throw new Error(`models.dev: ${shown(providerId)}/${shown(modelId)}: "cost" is not an object.`);
      if (isObject(model.cost) && model.cost.tiers !== undefined && !Array.isArray(model.cost.tiers)) throw new Error(`models.dev: ${shown(providerId)}/${shown(modelId)}: "cost.tiers" is not a list.`);
      if (model.reasoning_options !== undefined && !Array.isArray(model.reasoning_options)) throw new Error(`models.dev: ${shown(providerId)}/${shown(modelId)}: "reasoning_options" is not a list.`);
      models += 1;
    }
  }
  if (models < 5000) throw new Error(`models.dev: only ${models} models; the document is not the catalog.`);
  for (const required of ['anthropic', 'openai', 'google']) if (!isObject(raw[required])) throw new Error(`models.dev: provider "${required}" is missing.`);
  return { providers: providers.length, models };
}

/** [kind, ...] per reasoning option: ['e', ...efforts], ['t'], ['b', min|null, max|null]. */
function optionsOf(model) {
  const out = [];
  for (const option of model.reasoning_options ?? []) {
    if (!isObject(option) || !OPTION_TYPES.has(option.type)) continue;
    if (option.type === 'effort') {
      const values = (Array.isArray(option.values) ? option.values : []).filter((value) => typeof value === 'string' && /^[a-z]{2,12}$/.test(value));
      if (values.length) out.push(['e', ...values]);
    } else if (option.type === 'toggle') out.push(['t']);
    else out.push(['b', number(option.min), number(option.max)]);
  }
  return out;
}

/**
 * The price tiers of a model, [[size, input, output, cacheRead | null, cacheWrite | null]] going up in size: a prompt of MORE than `size` tokens is priced at these rates, for the whole
 * request. models.dev lists them in `cost.tiers` (only the ones of type "context"); the older `cost.context_over_200k` is read when there is no list. What is not a number, or has no size, is left out.
 */
function tiersOf(cost) {
  if (!isObject(cost)) return [];
  const tiers = [];
  const add = (size, tier) => {
    const input = number(tier.input), output = number(tier.output);
    const whole = Math.floor(size);
    if (!Number.isFinite(whole) || whole <= 0 || input === null || output === null) return;
    tiers.push([whole, input, output, number(tier.cache_read), number(tier.cache_write)]);
  };
  for (const tier of Array.isArray(cost.tiers) ? cost.tiers : []) {
    if (isObject(tier) && isObject(tier.tier) && tier.tier.type === 'context') add(tier.tier.size, tier);
  }
  if (!tiers.length && isObject(cost.context_over_200k)) add(200000, cost.context_over_200k);
  return tiers.sort((a, b) => a[0] - b[0]);
}

const statusFlags = (status) => (!status ? 0 : FLAG.notStable | (status === 'beta' ? FLAG.beta : status === 'deprecated' ? FLAG.deprecated : status === 'alpha' ? FLAG.alpha : 0));

/** The compact snapshot: {version, generatedAt, source, sha256, canon, rows, providers, hosts}. `generatedAt` is the date (YYYY-MM-DD) of the source document. */
export function compactCatalog(raw, { generatedAt, source = SOURCE_URL } = {}) {
  validateRaw(raw);
  if (!isRealDate(generatedAt)) throw new Error('generatedAt must be a date such as 2026-10-19.');
  const canon = [];
  const canonIndex = new Map();
  const rows = [];
  const rowIndex = new Map();
  // Built as lists of pairs and turned into objects at the end (Object.fromEntries defines every key as an own property, whatever it is called), and only from names the Hub can use.
  const providerPairs = [];
  for (const providerId of Object.keys(raw).sort()) {
    if (!PROVIDER_ID_OK.test(providerId)) continue;
    const entries = [];
    for (const modelId of Object.keys(raw[providerId].models).sort()) {
      if (!MODEL_ID_OK.test(modelId)) continue;
      const model = raw[providerId].models[modelId];
      const cost = isObject(model.cost) ? [number(model.cost.input), number(model.cost.output), number(model.cost.cache_read), number(model.cost.cache_write)] : null;
      const options = optionsOf(model);
      const flags = (model.tool_call ? FLAG.toolCall : 0) | (model.modalities?.input?.includes?.('image') ? FLAG.vision : 0) | (model.reasoning ? FLAG.reasoning : 0)
        | (model.open_weights ? FLAG.openWeights : 0) | statusFlags(model.status);
      const row = [number(model.limit?.context), number(model.limit?.output), number(model.limit?.input), cost, flags, options.length ? options : 0];
      let canonAt;
      if (isCatalogModelId(model.canonical_model_id)) {
        if (!canonIndex.has(model.canonical_model_id)) { canonIndex.set(model.canonical_model_id, canon.length); canon.push(model.canonical_model_id); }
        canonAt = canonIndex.get(model.canonical_model_id);
      }
      const tiers = tiersOf(model.cost);
      if (tiers.length) row.push(canonAt ?? null, tiers);
      else if (canonAt !== undefined) row.push(canonAt);
      const key = JSON.stringify(row);
      if (!rowIndex.has(key)) { rowIndex.set(key, rows.length); rows.push(row); }
      entries.push([modelId, rowIndex.get(key)]);
    }
    providerPairs.push([providerId, Object.fromEntries(entries)]);
  }
  const providers = Object.fromEntries(providerPairs);
  const hosts = hostsOf(raw);
  const body = { canon, rows, providers, hosts };
  const sha256 = createHash('sha256').update(JSON.stringify(body)).digest('hex');
  return { version: FORMAT_VERSION, generatedAt, source, sha256, ...body };
}

/** host -> provider id, for the providers that publish an endpoint (about 190 of them; the big first-party ones do not). A host two providers share, or a templated one, is left out. */
function hostsOf(raw) {
  const seen = new Map();
  for (const providerId of Object.keys(raw).sort()) {
    const api = raw[providerId].api;
    if (typeof api !== 'string' || /\$\{|\{[A-Za-z_]+\}/.test(api)) continue;
    if (!PROVIDER_ID_OK.test(providerId)) continue;
    let host;
    try { host = new URL(api).host.toLowerCase(); } catch { continue; }
    if (!HOST_OK.test(host)) continue;
    seen.set(host, seen.has(host) ? null : providerId);
  }
  return Object.fromEntries([...seen].filter(([, providerId]) => providerId !== null));
}

const MAX_SNAPSHOT_ROWS = 200000; // the one that ships has about 6,800
const MAX_SNAPSHOT_PROVIDERS = 5000;

/**
 * Throws unless the snapshot is a well-formed version 1 or 2 snapshot (the shape documented in lib/model-catalog.mjs). A snapshot made by compactCatalog always is; one read from the Hub's
 * data folder may not be (damaged, or edited), and the catalog reads rows by position without looking, so a snapshot is checked before it is used. The hash (snapshotIsIntact) tells
 * whether it is the one that was written; this tells whether it can be read.
 */
export function checkSnapshot(snapshot) {
  const bad = (what) => { throw coded('catalog_snapshot_invalid', `Model catalog snapshot: ${what}.`); };
  if (!isObject(snapshot)) bad('not an object');
  if (snapshot.version !== 1 && snapshot.version !== 2) bad('only versions 1 and 2 are read');
  if (!isRealDate(snapshot.generatedAt)) bad('it has no date');
  if (typeof snapshot.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(snapshot.sha256)) bad('it has no hash');
  const { rows, canon, providers, hosts } = snapshot;
  if (!Array.isArray(rows) || rows.length > MAX_SNAPSHOT_ROWS) bad('the rows are not a list of a sensible size');
  if (!Array.isArray(canon) || canon.length > MAX_SNAPSHOT_ROWS || canon.some((id) => !isCatalogModelId(id))) bad('the canonical ids are not a list of plain ids');
  if (!isObject(providers) || Object.keys(providers).length > MAX_SNAPSHOT_PROVIDERS) bad('the providers are not an object of a sensible size');
  if (!isObject(hosts)) bad('the hosts are not an object');
  const count = (value) => value === null || (Number.isFinite(value) && value >= 0);
  rows.forEach((row, index) => {
    if (!Array.isArray(row) || row.length < 6 || row.length > 8) bad(`row ${index} is not a row`);
    if (!count(row[0]) || !count(row[1]) || !count(row[2])) bad(`row ${index} has a limit that is not a number`);
    if (row[3] !== null && !(Array.isArray(row[3]) && row[3].length === 4 && row[3].every(count))) bad(`row ${index} has prices that are not four numbers`);
    if (!Number.isInteger(row[4]) || row[4] < 0) bad(`row ${index} has flags that are not a number`);
    if (row[5] !== 0 && !(Array.isArray(row[5]) && row[5].every((option) => Array.isArray(option) && typeof option[0] === 'string'))) bad(`row ${index} has reasoning options that are not a list`);
    if (row[6] !== undefined && row[6] !== null && !(Number.isInteger(row[6]) && row[6] >= 0 && row[6] < canon.length)) bad(`row ${index} names a canonical id that does not exist`);
    if (row[7] !== undefined && !(Array.isArray(row[7]) && row[7].every((tier) => Array.isArray(tier) && tier.length === 5 && Number.isFinite(tier[0]) && tier[0] > 0 && tier.slice(1).every(count)))) bad(`row ${index} has price tiers that are not five numbers each`);
  });
  for (const [providerId, models] of Object.entries(providers)) {
    if (!PROVIDER_ID_OK.test(providerId)) bad(`a provider is called ${shown(providerId)}`);
    if (!isObject(models)) bad(`provider ${shown(providerId)} is not an object of models`);
    for (const [modelId, rowIndex] of Object.entries(models)) {
      if (!MODEL_ID_OK.test(modelId)) bad(`provider ${shown(providerId)} has a model called ${shown(modelId)}`);
      if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= rows.length) bad(`provider ${shown(providerId)} names a row that does not exist`);
    }
  }
  for (const [host, providerId] of Object.entries(hosts)) {
    if (!HOST_OK.test(host)) bad(`a host is called ${shown(host)}`);
    if (typeof providerId !== 'string') bad(`host ${shown(host)} does not name a provider`);
  }
  return snapshot;
}

/** True when the snapshot's own hash matches its content. */
export function snapshotIsIntact(snapshot) {
  const { canon, rows, providers, hosts, sha256 } = snapshot ?? {};
  return typeof sha256 === 'string' && Array.isArray(canon) && Array.isArray(rows) && isObject(providers) && isObject(hosts)
    && createHash('sha256').update(JSON.stringify({ canon, rows, providers, hosts })).digest('hex') === sha256;
}

export function ageInDays(snapshot, now = new Date()) {
  const when = Date.parse(`${snapshot?.generatedAt}T00:00:00Z`);
  return Number.isFinite(when) ? Math.floor((now.getTime() - when) / 86400000) : Infinity;
}

/**
 * The address the document is fetched from: https://models.dev/api.json and nothing else, except a loopback address (a mirror on this machine, a test). A key or a person's data never
 * goes into this address; there is none to send.
 */
export function checkedSourceUrl(value = SOURCE_URL) {
  let url;
  try { url = new URL(value); } catch { throw coded('catalog_source_refused', 'The model catalog address is not a URL.'); }
  if (url.username || url.password || url.search || url.hash) throw coded('catalog_source_refused', 'The model catalog address must not carry a login, a query or a fragment.');
  if (url.href === SOURCE_URL) return url.href;
  if ((url.protocol === 'http:' || url.protocol === 'https:') && LOOPBACK_HOSTS.has(url.hostname)) return url.href;
  throw coded('catalog_source_refused', `The model catalog is read from ${SOURCE_URL} only (or from a loopback address); ${url.host} is refused.`);
}

async function readCapped(response, maxBytes) {
  const tooLarge = () => coded('catalog_too_large', `models.dev: the document is larger than ${maxBytes} bytes; it was not read.`);
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > maxBytes) throw tooLarge();
        chunks.push(Buffer.from(part.value));
      }
    } finally { await reader.cancel().catch(() => {}); }
    return Buffer.concat(chunks).toString('utf8');
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > maxBytes) throw tooLarge();
  return text;
}

/**
 * Fetch the models.dev document: HTTPS to models.dev only (see checkedSourceUrl), no redirect, no credentials, a time limit and a size limit enforced while the body is read.
 * Returns the parsed document; whether it is the catalog is validateRaw's question.
 * @param {{fetchImpl?: typeof fetch, url?: string, maxBytes?: number, timeoutMs?: number, signal?: AbortSignal}} [options]
 */
export async function fetchRawCatalog({ fetchImpl = fetch, url = SOURCE_URL, maxBytes = MAX_DOWNLOAD_BYTES, timeoutMs = DOWNLOAD_TIMEOUT_MS, signal } = {}) {
  const target = checkedSourceUrl(url);
  const timeout = AbortSignal.timeout(timeoutMs);
  let text;
  // The time limit covers the whole answer, the body included: a server that sends its headers and then nothing is cut off like one that sends nothing.
  try {
    const response = await fetchImpl(target, { method: 'GET', redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', headers: { accept: 'application/json' }, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!response.ok) throw coded('catalog_http', `models.dev answered HTTP ${response.status}.`);
    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) throw coded('catalog_too_large', `models.dev: the document is ${declared} bytes; the limit is ${maxBytes}.`);
    text = await readCapped(response, maxBytes);
  } catch (error) {
    if (typeof error?.code === 'string' && error.code.startsWith('catalog_')) throw error;
    if (signal?.aborted) throw signal.reason ?? error;
    const timedOut = error?.name === 'TimeoutError' || timeout.aborted;
    throw coded(timedOut ? 'catalog_timeout' : 'catalog_network', timedOut ? 'models.dev did not answer in time.' : `models.dev could not be reached: ${error?.cause?.code ?? error?.message ?? 'network error'}.`);
  }
  try { return JSON.parse(text); } catch { throw coded('catalog_invalid', 'models.dev: the answer is not JSON.'); }
}
