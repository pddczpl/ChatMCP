// The model catalog (lib/model-catalog.mjs) answers from a dated snapshot of models.dev. This suite checks, on the real snapshot file:
//
//   1. The snapshot: its own hash matches (nobody edited it by hand), it is dated, it holds the models of the providers a person is likely to use, and it stays small.
//   2. Resolution of the ids people really type, by provider and endpoint: exact, normalized (region prefix, date, dots), alias (a gateway's spelling of another maker's
//      model), and none. None is the right answer for a user's own alias and a local runtime's tag: a wrong model is worse than no model.
//   3. Every model of the snapshot resolves to itself (the indexes do not collide), and an absurd context window comes out inside the bounds the Hub accepts.
//   4. The reasoning options: the levels Claude, GPT-5 and the others offer, and models that are driven by a switch or a token budget instead.
//   5. The maintainer script: it builds the snapshot from a models.dev document, refuses a document that is not the catalog, and `--check` fails on an old or damaged one.
//   6. Negative controls: the same checks fail on a snapshot with one defect put in at a time.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CONTEXT_WINDOW_MAX, CONTEXT_WINDOW_MIN } from '../lib/context-window.mjs';
import { catalogInfo, createCatalog, lookup, normalizeModelId } from '../lib/model-catalog.mjs';
import { EFFORT_LEVELS } from '../lib/reasoning-effort.mjs';

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(HUB, '..');
const SNAPSHOT = path.join(HUB, 'lib', 'model-catalog.data.json');

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
const snapshot = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
const scriptFile = path.join(REPO, 'scripts', 'update-model-catalog.mjs');
const script = existsSync(scriptFile) ? await import(pathToFileURL(scriptFile).href) : null;

// ------------------------------------------------------------------------------------------------------------------------------- 1. the snapshot
{
  const info = catalogInfo();
  assert.equal(snapshot.version, 1);
  assert.match(snapshot.generatedAt, /^\d{4}-\d{2}-\d{2}$/, 'the snapshot is dated');
  assert.ok(info.models >= 9000, `at least 9,000 models: ${info.models}`);
  assert.ok(info.providers >= 200, `at least 200 providers: ${info.providers}`);
  for (const provider of ['anthropic', 'openai', 'google', 'openrouter', 'amazon-bedrock', 'azure', 'deepseek', 'groq', 'mistral', 'google-vertex-anthropic']) {
    assert.ok(Object.keys(snapshot.providers[provider] ?? {}).length >= 3, `${provider} is in the snapshot`);
  }
  const size = statSync(SNAPSHOT).size;
  assert.ok(size <= 760 * 1024, `the snapshot stays under 760 KB: ${size} bytes`);
  if (script) {
    assert.equal(script.snapshotIsIntact(snapshot), true, 'the snapshot matches its own hash');
    // How old the snapshot may be is the maintainer's `--check` (90 days, section 5 runs it on a fixed date): a suite that turns red with the calendar fails unrelated work.
    assert.ok(script.ageInDays(snapshot) >= 0, 'the snapshot is not dated in the future (a hand edit of its date)');
  }
  assert.equal(info.source, snapshot.source);
  assert.match(readFileSync(path.join(HUB, 'THIRD-PARTY-NOTICES.txt'), 'utf8'), /models\.dev - MIT License \(Copyright \(c\) 2025 models\.dev/, 'the attribution of the data is in THIRD-PARTY-NOTICES.txt');
  if (existsSync(path.join(REPO, 'THIRD-PARTY-NOTICES.md'))) assert.match(readFileSync(path.join(REPO, 'THIRD-PARTY-NOTICES.md'), 'utf8'), /models\.dev/, 'and in THIRD-PARTY-NOTICES.md');
  ok(`snapshot of ${snapshot.generatedAt}: ${info.models} models of ${info.providers} providers, ${Math.round(size / 1024)} KB, intact, attributed`);
}

// ------------------------------------------------------------------------------------------------------------------------------- 2. resolution
{
  const cases = [
    // [query, confidence, provider, model id]
    [{ presetId: 'anthropic', model: 'claude-sonnet-5-5' }, 'exact', 'anthropic', 'claude-sonnet-5-5'],
    [{ presetId: 'anthropic', model: 'claude-sonnet-4-5-20250929' }, 'exact', 'anthropic', 'claude-sonnet-4-5-20250929'],
    [{ presetId: 'openai', model: 'gpt-5-mini' }, 'exact', 'openai', 'gpt-5-mini'],
    [{ presetId: 'openai-responses', model: 'gpt-5.1' }, 'exact', 'openai', 'gpt-5.1'],
    [{ presetId: 'gemini', model: 'gemini-2.5-pro' }, 'exact', 'google', 'gemini-2.5-pro'],
    [{ presetId: 'openrouter', model: 'anthropic/claude-sonnet-4.5' }, 'exact', 'openrouter', 'anthropic/claude-sonnet-4.5'],
    [{ presetId: 'openrouter', model: 'anthropic/claude-sonnet-5-5' }, 'normalized', 'openrouter', 'anthropic/claude-sonnet-5.5'],
    [{ presetId: 'groq', model: 'openai/gpt-oss-120b' }, 'exact', 'groq', 'openai/gpt-oss-120b'],
    [{ presetId: 'mistral', model: 'magistral-medium-latest' }, 'exact', 'mistral', 'magistral-medium-latest'],
    // an endpoint decides when the preset does not: a "custom" connection aimed at Anthropic, Azure, Bedrock, GitHub Copilot
    [{ presetId: 'custom-openai', apiBaseUrl: 'https://api.anthropic.com', model: 'claude-opus-5-5' }, 'exact', 'anthropic', 'claude-opus-5-5'],
    [{ presetId: 'custom-openai', apiBaseUrl: 'https://x.openai.azure.com/openai/v1', model: 'gpt-5-mini' }, 'exact', 'azure', 'gpt-5-mini'],
    [{ presetId: 'custom-openai', apiBaseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com', model: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0' }, 'exact', 'amazon-bedrock', 'us.anthropic.claude-sonnet-4-5-20250929-v1:0'],
    [{ presetId: 'custom-openai', apiBaseUrl: 'https://api.githubcopilot.com', model: 'gpt-5-mini' }, 'exact', 'github-copilot', 'gpt-5-mini'],
    // an unknown endpoint with the id of a maker's model: the maker's listing, when exactly one maker has it
    [{ presetId: 'custom-openai', apiBaseUrl: 'https://proxy.example.com', model: 'gpt-5-mini' }, 'alias', 'openai', 'gpt-5-mini'],
    [{ presetId: 'custom-openai', apiBaseUrl: 'https://proxy.example.com', model: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0' }, 'alias', 'anthropic', 'claude-sonnet-4-5'],
  ];
  for (const [query, confidence, provider, modelId] of cases) {
    const found = lookup(query);
    assert.deepEqual([found.found, found.confidence, found.provider, found.modelId], [true, confidence, provider, modelId], JSON.stringify(query));
    assert.equal(found.source, `catalog@${snapshot.generatedAt}`);
  }
  // none: a user's own alias, a deployment name, a local runtime's tag, no id at all. Never a wrong model.
  const misses = [
    { presetId: 'custom-openai', apiBaseUrl: 'https://litellm.example.com', model: 'my-litellm-alias' },
    { presetId: 'custom-openai', apiBaseUrl: 'https://x.openai.azure.com/openai/v1', model: 'my-gpt4o-deployment' },
    { presetId: 'ollama', model: 'qwen2.5-coder:7b' },
    { presetId: 'lmstudio', model: 'local-model' },
    { presetId: 'custom-openai', apiBaseUrl: 'http://localhost:8080/v1', model: 'llama3.1:8b' },
    { presetId: 'anthropic', model: 'claude-not-released-yet' },
    { presetId: 'anthropic', model: '' },
    { presetId: 'anthropic' },
  ];
  for (const query of misses) {
    const none = lookup(query);
    assert.deepEqual([none.found, none.confidence, none.provider, none.contextWindow, none.rates, none.reasoning.supported, none.reasoning.efforts], [false, 'none', null, null, null, null, []], JSON.stringify(query));
  }
  assert.equal(lookup({ presetId: 'ollama', model: 'x' }).local, true);
  assert.equal(lookup({ presetId: 'custom-openai', apiBaseUrl: 'http://127.0.0.1:1234/v1', model: 'x' }).local, true);
  assert.equal(lookup({ presetId: 'anthropic', model: 'claude-sonnet-5-5' }).local, false);
  // an endpoint the catalog does not know and an id that two makers both list is not guessed: only one maker having it makes it an alias
  const row = [100000, 4096, null, null, 5, 0];
  const twoMakers = createCatalog({ version: 1, generatedAt: '2026-01-01', source: 'test', canon: [], hosts: {}, rows: [row], providers: { anthropic: { 'shared-model': 0, 'only-here': 0 }, openai: { 'shared-model': 0 } } });
  const unknownEndpoint = { presetId: 'custom-openai', apiBaseUrl: 'https://proxy.example.com' };
  assert.equal(twoMakers.lookup({ ...unknownEndpoint, model: 'shared-model' }).confidence, 'none', 'two makers list it: no guess');
  assert.deepEqual([twoMakers.lookup({ ...unknownEndpoint, model: 'only-here' }).confidence, twoMakers.lookup({ ...unknownEndpoint, model: 'only-here' }).provider], ['alias', 'anthropic']);
  assert.equal(twoMakers.lookup({ presetId: 'anthropic', model: 'shared-model' }).confidence, 'exact', 'a named provider answers for itself');
  // a gateway that lists a model of another maker under a spelling its own listing does not have: the canonical id of the maker's entry names it
  const viaGateway = createCatalog({ version: 1, generatedAt: '2026-01-01', source: 'test', canon: ['anthropic/claude-x'], hosts: {}, rows: [[100000, 4096, null, null, 5, 0, 0]], providers: { anthropic: { 'claude-x': 0 }, openrouter: {} } });
  const aliased = viaGateway.lookup({ presetId: 'openrouter', model: 'anthropic/claude-x' });
  assert.deepEqual([aliased.confidence, aliased.provider, aliased.modelId], ['alias', 'anthropic', 'claude-x'], 'found through the canonical id, and said to be an alias');
  assert.equal(viaGateway.lookup({ presetId: 'openrouter', model: 'anthropic/claude-y' }).confidence, 'none', 'a canonical id that is not in the catalog is none');
  // the normalisation itself
  const spelled = ['us.anthropic.claude-sonnet-4-5-20250929-v1:0', 'claude-sonnet-4.5', 'anthropic/claude-sonnet-4.5', 'claude-sonnet-4-5@20250929', 'Claude-Sonnet-4-5-20250929', 'global.anthropic.claude-sonnet-4-5-v1:0'];
  for (const id of spelled) assert.equal(normalizeModelId(id), 'claude-sonnet-4-5', id);
  assert.notEqual(normalizeModelId('claude-sonnet-4-5'), normalizeModelId('claude-sonnet-4-6'));
  assert.equal(normalizeModelId('gpt-5-mini'), 'gpt-5-mini');
  assert.equal(normalizeModelId('qwen2.5-coder:7b'), 'qwen2-5-coder:7b', 'a tag that is not a version stays in the id');
  ok(`${cases.length} ids resolve as expected (exact, normalized, alias), ${misses.length} come back as none, local runtimes are marked local, and spellings of one model normalise to one`);
}

// ------------------------------------------------------------------------------------------------------------------------------- 3. the indexes and the bounds
{
  const catalog = createCatalog(snapshot);
  let checked = 0;
  for (const provider of catalog.providerIds()) {
    for (const model of catalog.modelIds(provider)) {
      const found = catalog.lookup({ provider, model });
      assert.equal(found.confidence, 'exact', `${provider}/${model}`);
      assert.deepEqual([found.provider, found.modelId], [provider, model]);
      const row = snapshot.rows[snapshot.providers[provider][model]];
      assert.equal(found.maxOutput, row[1] ?? null);
      if (found.contextWindow !== null) assert.ok(found.contextWindow >= CONTEXT_WINDOW_MIN && found.contextWindow <= CONTEXT_WINDOW_MAX, `${provider}/${model}: ${found.contextWindow}`);
      for (const level of found.reasoning.efforts) assert.ok(EFFORT_LEVELS.includes(level), `${provider}/${model}: the level "${level}" is one the Hub has a setting for`);
      checked += 1;
    }
  }
  assert.equal(checked, catalogInfo().models);
  // a window above the bound is clamped to it, never dropped; one below the minimum is not usable and comes back null
  const tiny = createCatalog({ version: 1, generatedAt: '2026-01-01', source: 'test', canon: [], hosts: {}, rows: [[99999999, 1000, null, null, 5, [['e', 'low', 'high']]], [100, 50, null, null, 1, 0]], providers: { p: { huge: 0, small: 1 } } });
  assert.equal(tiny.lookup({ provider: 'p', model: 'huge' }).contextWindow, CONTEXT_WINDOW_MAX, 'above the bound: clamped');
  assert.equal(tiny.lookup({ provider: 'p', model: 'small' }).contextWindow, null, 'below the minimum: not usable');
  assert.throws(() => createCatalog({ version: 2 }), /version 1/, 'a snapshot of another format is refused, not misread');
  ok(`${checked} models resolve to themselves, exactly; windows stay inside ${CONTEXT_WINDOW_MIN}-${CONTEXT_WINDOW_MAX}; a snapshot of another format is refused`);
}

// ------------------------------------------------------------------------------------------------------------------------------- 4. the reasoning options
{
  const reasoning = (query) => lookup(query).reasoning;
  assert.deepEqual(reasoning({ presetId: 'anthropic', model: 'claude-sonnet-5-5' }), { supported: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], toggle: false, budget: null });
  assert.deepEqual(reasoning({ presetId: 'openai', model: 'gpt-5-mini' }).efforts, ['minimal', 'low', 'medium', 'high']);
  assert.ok(reasoning({ presetId: 'openai', model: 'gpt-5.1' }).efforts.includes('none'), 'GPT-5.1 can be told not to think');
  const gemini = reasoning({ presetId: 'gemini', model: 'gemini-2.5-pro' });
  assert.deepEqual([gemini.supported, gemini.efforts, gemini.budget], [true, [], { min: 128, max: 32768 }], 'a token budget, no effort levels');
  const flash = reasoning({ presetId: 'gemini', model: 'gemini-2.5-flash' });
  assert.deepEqual([flash.toggle, flash.budget], [true, { min: 0, max: 24576 }], 'a switch and a budget');
  assert.equal(reasoning({ presetId: 'anthropic', model: 'claude-haiku-5-5' }).toggle, true);
  // a model that does not reason says so: supported false
  let plain = null;
  for (const model of createCatalog(snapshot).modelIds('openai')) { const found = lookup({ presetId: 'openai', model }); if (found.reasoning.supported === false && found.toolCall) { plain = found; break; } }
  assert.ok(plain, '(premise) the snapshot has an OpenAI model that does not reason');
  assert.deepEqual([plain.reasoning.efforts, plain.reasoning.toggle, plain.reasoning.budget], [[], false, null]);
  // a word the Hub has no setting for (two Qwen models on Groq list "default") is left out of the levels, the real ones stay
  const qwen = lookup({ presetId: 'groq', model: 'qwen/qwen3.6-27b' });
  assert.deepEqual(qwen.reasoning.efforts, ['none'], 'the level "default" is not offered');
  ok('reasoning options: effort levels (Claude, GPT-5), a switch (Haiku, Flash), a token budget (Gemini 2.5), and models that do not reason');
}

// ------------------------------------------------------------------------------------------------------------------------------- 5. the maintainer script
if (!script) {
  console.log('  skip - scripts/update-model-catalog.mjs was not found next to CHATMCP-HUB (the script checks need the whole repository)');
} else {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'chatmcp-catalog-'));
  try {
    // a small models.dev document that passes the guard: enough providers and models, with every kind of reasoning option
    const model = (id, extra = {}) => ({ id, name: id, reasoning: false, tool_call: true, limit: { context: 128000, output: 8192 }, cost: { input: 1, output: 2 }, modalities: { input: ['text'] }, ...extra });
    const providers = {};
    for (let p = 0; p < 24; p += 1) {
      const models = {};
      for (let m = 0; m < 230; m += 1) models[`m${m}`] = model(`m${m}`);
      providers[`p${p}`] = { id: `p${p}`, models };
    }
    providers.anthropic = { id: 'anthropic', models: { 'claude-x': model('claude-x', { reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'high'] }, { type: 'toggle' }, { type: 'budget_tokens', min: 1024, max: 4096 }, { type: 'brand_new_kind' }], canonical_model_id: 'anthropic/claude-x' }) } };
    providers.openai = { id: 'openai', api: 'https://api.example-openai.test/v1', models: { 'gpt-x': model('gpt-x') } };
    providers.google = { id: 'google', models: { 'gemini-x': model('gemini-x') } };
    const written = path.join(dir, 'api.json');
    writeFileSync(written, JSON.stringify(providers));
    const out = path.join(dir, 'snapshot.json');
    const lines = [];
    assert.equal(await script.main(['--from', written, '--date', '2026-10-01', '--out', out], { out: (line) => lines.push(line) }), 0);
    const built = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(script.snapshotIsIntact(built), true);
    assert.equal(built.generatedAt, '2026-10-01');
    const small = createCatalog(built);
    assert.deepEqual(small.lookup({ provider: 'anthropic', model: 'claude-x' }).reasoning, { supported: true, efforts: ['low', 'high'], toggle: true, budget: { min: 1024, max: 4096 } }, 'an unknown option kind is ignored, the known ones are kept');
    assert.equal(small.lookup({ presetId: 'custom-openai', apiBaseUrl: 'https://api.example-openai.test/v1', model: 'gpt-x' }).provider, 'openai', 'the endpoint a provider publishes is in the snapshot');
    // --check: fresh passes, old fails, damaged fails, missing fails
    assert.equal(await script.main(['--check', '--out', out], { now: new Date('2026-10-20T00:00:00Z'), out: () => {} }), 0);
    assert.equal(await script.main(['--check', '--out', out], { now: new Date('2027-02-01T00:00:00Z'), out: () => {} }), 1, 'older than 90 days');
    assert.equal(await script.main(['--check', '--max-age-days', '400', '--out', out], { now: new Date('2027-02-01T00:00:00Z'), out: () => {} }), 0, 'the limit can be changed');
    writeFileSync(out, JSON.stringify({ ...built, rows: [...built.rows, [1, 1, null, null, 0, 0]] }));
    assert.equal(await script.main(['--check', '--out', out], { now: new Date('2026-10-20T00:00:00Z'), out: () => {} }), 1, 'edited by hand');
    assert.equal(await script.main(['--check', '--out', path.join(dir, 'none.json')], { out: () => {} }), 1, 'missing');
    // the guard: what is not the catalog is refused
    for (const [label, bad] of [['an array', []], ['too few providers', { anthropic: providers.anthropic }], ['a provider without models', { ...providers, broken: { id: 'broken' } }],
      ['a model that is not an object', { ...providers, p0: { id: 'p0', models: { x: 7 } } }], ['reasoning_options that is not a list', { ...providers, p1: { id: 'p1', models: { x: model('x', { reasoning_options: 'effort' }) } } }]]) {
      assert.throws(() => script.validateRaw(bad), /models\.dev/, label);
    }
    assert.throws(() => script.compactCatalog(providers, { generatedAt: 'yesterday' }), /generatedAt/);
    ok('the script builds an intact snapshot from a models.dev document, ignores a new kind of option, refuses what is not the catalog, and --check fails on old, edited and missing files');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ------------------------------------------------------------------------------------------------------------------------------- 6. negative controls
{
  const broken = (change) => { const copy = structuredClone(snapshot); change(copy); return copy; };
  const resolvesClaude = (data) => { const found = createCatalog(data).lookup({ presetId: 'anthropic', model: 'claude-sonnet-5-5' }); return found.found && found.reasoning.efforts.length === 5 && found.contextWindow === 1000000; };
  assert.equal(resolvesClaude(snapshot), true, '(premise) the real snapshot passes the probe');
  assert.equal(resolvesClaude(broken((data) => { delete data.providers.anthropic['claude-sonnet-5-5']; })), false, 'a model removed is noticed');
  assert.equal(resolvesClaude(broken((data) => { data.rows[data.providers.anthropic['claude-sonnet-5-5']] = [1000000, 128000, null, null, 5, [['e', 'low']]]; })), false, 'an effort list cut short is noticed');
  assert.throws(() => createCatalog(broken((data) => { data.version = 3; })), /version 1/);
  if (script) {
    assert.equal(script.snapshotIsIntact(broken((data) => { data.rows[0][0] = (data.rows[0][0] ?? 0) + 1; })), false, 'a changed number breaks the hash');
    assert.equal(script.snapshotIsIntact(broken((data) => { data.generatedAt = '2026-12-31'; })), true, 'the date is not part of the hash (it is metadata), the content is');
    assert.equal(script.snapshotIsIntact(broken((data) => { delete data.sha256; })), false, 'no hash, no trust');
  }
  ok('negative controls: a removed model, a shortened effort list, another format and an edited number are each noticed');
}

console.log(`\nPASS: ${checks} model catalog checks`);
