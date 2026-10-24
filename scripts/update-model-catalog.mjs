#!/usr/bin/env node
// Builds CHATMCP-HUB/lib/model-catalog.data.json, the compact snapshot of https://models.dev/api.json (MIT) that lib/model-catalog.mjs answers from.
//
//   node scripts/update-model-catalog.mjs                     download api.json (HTTPS, 20 MB cap, 30 s) and write the snapshot
//   node scripts/update-model-catalog.mjs --from api.json     build it from a file instead (what the tests do; no network)
//   node scripts/update-model-catalog.mjs --check [--max-age-days 90]   exit 1 when the snapshot is older than that (or damaged)
//   --out <file>                                              write somewhere else (the default is the snapshot of the Hub)
//
// The snapshot is a data file, not code: nothing is downloaded when the Hub runs. Updating it is a maintainer action, so the date in it says how old the
// answers are, and `--check` is what a release gate can call. The format is documented in lib/model-catalog.mjs.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SNAPSHOT_FILE = path.resolve(HERE, '..', 'CHATMCP-HUB', 'lib', 'model-catalog.data.json');
export const SOURCE_URL = 'https://models.dev/api.json';
export const FORMAT_VERSION = 1;
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const OPTION_TYPES = new Set(['effort', 'toggle', 'budget_tokens']);

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const number = (value) => (Number.isFinite(value) && value >= 0 ? value : null);

/** Flags of a model row: 1 tool calls, 2 reads images, 4 reasons, 8 open weights, 16 has a status other than stable (beta, alpha, deprecated). */
export const FLAG = Object.freeze({ toolCall: 1, vision: 2, reasoning: 4, openWeights: 8, notStable: 16 });

/** Throws on a shape the snapshot cannot be built from; unknown extra fields and unknown reasoning option types are ignored, a changed structure is not. */
export function validateRaw(raw) {
  if (!isObject(raw)) throw new Error('models.dev: the document is not an object of providers.');
  const providers = Object.entries(raw);
  if (providers.length < 20) throw new Error(`models.dev: only ${providers.length} providers; the document is not the catalog.`);
  let models = 0;
  for (const [providerId, provider] of providers) {
    if (!isObject(provider) || !isObject(provider.models)) throw new Error(`models.dev: provider "${providerId}" has no models object.`);
    for (const [modelId, model] of Object.entries(provider.models)) {
      if (!isObject(model) || typeof (model.id ?? modelId) !== 'string') throw new Error(`models.dev: ${providerId}/${modelId} is not a model.`);
      if (model.limit !== undefined && !isObject(model.limit)) throw new Error(`models.dev: ${providerId}/${modelId}: "limit" is not an object.`);
      if (model.cost !== undefined && !isObject(model.cost)) throw new Error(`models.dev: ${providerId}/${modelId}: "cost" is not an object.`);
      if (model.reasoning_options !== undefined && !Array.isArray(model.reasoning_options)) throw new Error(`models.dev: ${providerId}/${modelId}: "reasoning_options" is not a list.`);
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

/** The compact snapshot: {version, generatedAt, source, sha256, canon, rows, providers}. `generatedAt` is the date (YYYY-MM-DD) of the source document. */
export function compactCatalog(raw, { generatedAt, source = SOURCE_URL } = {}) {
  validateRaw(raw);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(generatedAt ?? '')) throw new Error('generatedAt must be a date such as 2026-10-19.');
  const canon = [];
  const canonIndex = new Map();
  const rows = [];
  const rowIndex = new Map();
  const providers = {};
  for (const providerId of Object.keys(raw).sort()) {
    const entries = {};
    for (const modelId of Object.keys(raw[providerId].models).sort()) {
      const model = raw[providerId].models[modelId];
      const cost = isObject(model.cost) ? [number(model.cost.input), number(model.cost.output), number(model.cost.cache_read), number(model.cost.cache_write)] : null;
      const options = optionsOf(model);
      const flags = (model.tool_call ? FLAG.toolCall : 0) | (model.modalities?.input?.includes?.('image') ? FLAG.vision : 0) | (model.reasoning ? FLAG.reasoning : 0)
        | (model.open_weights ? FLAG.openWeights : 0) | (model.status ? FLAG.notStable : 0);
      const row = [number(model.limit?.context), number(model.limit?.output), number(model.limit?.input), cost, flags, options.length ? options : 0];
      if (typeof model.canonical_model_id === 'string' && model.canonical_model_id) {
        if (!canonIndex.has(model.canonical_model_id)) { canonIndex.set(model.canonical_model_id, canon.length); canon.push(model.canonical_model_id); }
        row.push(canonIndex.get(model.canonical_model_id));
      }
      const key = JSON.stringify(row);
      if (!rowIndex.has(key)) { rowIndex.set(key, rows.length); rows.push(row); }
      entries[modelId] = rowIndex.get(key);
    }
    providers[providerId] = entries;
  }
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
    let host;
    try { host = new URL(api).host.toLowerCase(); } catch { continue; }
    seen.set(host, seen.has(host) ? null : providerId);
  }
  return Object.fromEntries([...seen].filter(([, providerId]) => providerId !== null));
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

async function download(fetchImpl = fetch) {
  const response = await fetchImpl(SOURCE_URL, { redirect: 'error', signal: AbortSignal.timeout(30000), headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`models.dev answered HTTP ${response.status}.`);
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) throw new Error(`models.dev: the document is ${declared} bytes; the cap is ${MAX_DOWNLOAD_BYTES}.`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_DOWNLOAD_BYTES) throw new Error(`models.dev: the document is ${buffer.length} bytes; the cap is ${MAX_DOWNLOAD_BYTES}.`);
  return JSON.parse(buffer.toString('utf8'));
}

function option(args, name) {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

export async function main(args = process.argv.slice(2), { now = new Date(), out = console.log } = {}) {
  const target = path.resolve(option(args, '--out') ?? SNAPSHOT_FILE);
  if (args.includes('--check')) {
    const maxAge = Number(option(args, '--max-age-days') ?? 90);
    if (!existsSync(target)) { out(`No snapshot at ${target}.`); return 1; }
    const snapshot = JSON.parse(readFileSync(target, 'utf8'));
    if (!snapshotIsIntact(snapshot)) { out('The snapshot does not match its own hash: it was edited by hand or damaged.'); return 1; }
    const age = ageInDays(snapshot, now);
    out(`Model catalog snapshot of ${snapshot.generatedAt}: ${age} days old (limit ${maxAge}).`);
    return age > maxAge ? 1 : 0;
  }
  const from = option(args, '--from');
  const raw = from ? JSON.parse(readFileSync(path.resolve(from), 'utf8')) : await download();
  const generatedAt = option(args, '--date') ?? now.toISOString().slice(0, 10);
  const snapshot = compactCatalog(raw, { generatedAt });
  writeFileSync(target, JSON.stringify(snapshot));
  out(`Wrote ${target}: ${Object.keys(snapshot.providers).length} providers, ${snapshot.rows.length} distinct rows, dated ${generatedAt}.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code), (error) => { console.error(error.message); process.exit(1); });
}
