// The model catalog (lib/model-catalog.mjs) answers from a dated snapshot of models.dev. This suite checks, on the real snapshot file:
//
//   1. The snapshot: its own hash matches (nobody edited it by hand), it is dated, it holds the models of the providers a person is likely to use, and it stays small.
//   2. Resolution of the ids people really type, by provider and endpoint: exact, normalized (region prefix, date, dots), alias (a gateway's spelling of another maker's
//      model), and none. None is the right answer for a user's own alias and a local runtime's tag: a wrong model is worse than no model.
//   3. Every model of the snapshot resolves to itself (the indexes do not collide), and an absurd context window comes out inside the bounds the Hub accepts.
//   4. The reasoning options: the levels Claude, GPT-5 and the others offer, and models that are driven by a switch or a token budget instead.
//   5. The maintainer script: it builds the snapshot from a models.dev document, refuses a document that is not the catalog, and `--check` fails on an old or damaged one.
//   6. Format 2: the price tiers of a model (a prompt above a size is priced at other rates), its status (alpha, beta, deprecated), the list of a provider's models for the model picker,
//      and the build code living in lib/ where the Hub itself can use it (the maintainer script is not shipped).
//   7. Negative controls: the same checks fail on a snapshot with one defect put in at a time.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CONTEXT_WINDOW_MAX, CONTEXT_WINDOW_MIN } from '../lib/context-window.mjs';
import { catalogInfo, createCatalog, isTrusted, lookup, normalizeModelId } from '../lib/model-catalog.mjs';
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
  assert.equal(snapshot.version, 2);
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
    // the popular providers have a preset each, and their endpoints are recognised when typed by hand into a "custom" connection (GLM and MiniMax were not)
    [{ presetId: 'xai', model: 'grok-4.3' }, 'exact', 'xai', 'grok-4.3'],
    [{ presetId: 'glm', model: 'glm-5.3' }, 'exact', 'zai', 'glm-5.3'],
    [{ presetId: 'qwen', model: 'qwen3.7-plus' }, 'exact', 'alibaba', 'qwen3.7-plus'],
    [{ presetId: 'minimax', model: 'MiniMax-M3' }, 'exact', 'minimax', 'MiniMax-M3'],
    [{ presetId: 'deepseek', model: 'deepseek-flash' }, 'exact', 'deepseek', 'deepseek-flash'],
    [{ presetId: 'custom-openai', apiBaseUrl: 'https://api.x.ai/v1', model: 'grok-4.3' }, 'exact', 'xai', 'grok-4.3'],
    [{ presetId: 'custom-openai', apiBaseUrl: 'https://api.z.ai/api/paas/v4', model: 'glm-5.3' }, 'exact', 'zai', 'glm-5.3'],
    [{ presetId: 'custom-openai', apiBaseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.3' }, 'exact', 'zhipuai', 'glm-5.3'],
    [{ presetId: 'custom-openai', apiBaseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', model: 'qwen3.7-plus' }, 'exact', 'alibaba', 'qwen3.7-plus'],
    [{ presetId: 'custom-anthropic', apiBaseUrl: 'https://api.minimax.io/anthropic', model: 'MiniMax-M3' }, 'exact', 'minimax', 'MiniMax-M3'],
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
  console.log('  skip - scripts/update-model-catalog.mjs was not found next to DATGOLD-HUB (the script checks need the whole repository)');
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

// ------------------------------------------------------------------------------------------------------------------------------- 6. format 2: tiers, status, the list of a provider
{
  const build = await import('../lib/model-catalog-build.mjs').catch(() => null);
  assert.ok(build, 'lib/model-catalog-build.mjs exists: the Hub itself can build a snapshot (the refresh route), the maintainer script is not shipped');
  if (script) for (const name of ['validateRaw', 'compactCatalog', 'snapshotIsIntact', 'ageInDays']) assert.equal(script[name], build[name], `the script and the Hub share ${name}`);
  assert.equal(snapshot.version, 2, 'the bundled snapshot is format 2');

  // The bundled snapshot: a prompt above the size of a tier is priced at the tier's rates for the whole request (the vendors' rule); the catalog reports the tiers, pricing applies them.
  assert.deepEqual(lookup({ presetId: 'openai', model: 'gpt-5.4' }).tiers, [{ aboveTokens: 272000, rates: { input: 5, output: 22.5, cacheRead: 0.5, cacheWrite: null } }]);
  assert.deepEqual(lookup({ presetId: 'gemini', model: 'gemini-2.5-pro' }).tiers, [{ aboveTokens: 200000, rates: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: null } }]);
  assert.deepEqual(lookup({ presetId: 'anthropic', model: 'claude-haiku-5-5' }).tiers, [{ aboveTokens: 100000, rates: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 } }]);
  assert.deepEqual(lookup({ presetId: 'anthropic', model: 'claude-sonnet-5-5' }).tiers, [], 'a model with one price has no tiers');
  assert.deepEqual(lookup({ presetId: 'ollama', model: 'x' }).tiers, [], 'nothing is known about a local model, so no tiers');
  const catalog = createCatalog(snapshot);
  let tiered = 0, deprecated = 0, beta = 0, alpha = 0;
  for (const provider of catalog.providerIds()) {
    for (const model of catalog.modelIds(provider)) {
      const found = catalog.lookup({ provider, model });
      if (found.tiers.length) {
        tiered += 1;
        let previous = 0;
        for (const tier of found.tiers) {
          assert.ok(Number.isInteger(tier.aboveTokens) && tier.aboveTokens > previous, `${provider}/${model}: tiers go up in size`);
          assert.ok(Number.isFinite(tier.rates.input) && Number.isFinite(tier.rates.output) && tier.rates.input >= 0 && tier.rates.output >= 0, `${provider}/${model}: a tier has an input and an output rate`);
          previous = tier.aboveTokens;
        }
        assert.ok(found.rates, `${provider}/${model}: a model with a tier has a base price`);
      }
      if (found.status === 'deprecated') deprecated += 1; else if (found.status === 'beta') beta += 1; else if (found.status === 'alpha') alpha += 1;
      else assert.equal(found.status, null, `${provider}/${model}: ${found.status}`);
      assert.equal(found.notStable, found.status !== null);
    }
  }
  assert.ok(tiered >= 600, `about 666 models have price tiers: ${tiered}`);
  assert.ok(deprecated >= 250 && beta >= 60 && alpha >= 1, `statuses: ${deprecated} deprecated, ${beta} beta, ${alpha} alpha`);

  // Building from a models.dev document: the general list of tiers, the older "context_over_200k" field when there is no list, and what is not a context tier is left out.
  const model = (id, extra = {}) => ({ id, name: id, reasoning: false, tool_call: true, limit: { context: 128000, output: 8192 }, cost: { input: 1, output: 2 }, modalities: { input: ['text'] }, ...extra });
  const providers = {};
  for (let p = 0; p < 24; p += 1) { const models = {}; for (let m = 0; m < 230; m += 1) models[`m${m}`] = model(`m${m}`); providers[`p${p}`] = { id: `p${p}`, models }; }
  providers.anthropic = { id: 'anthropic', models: { x: model('x') } };
  providers.google = { id: 'google', models: { x: model('x') } };
  providers.openai = { id: 'openai', models: {
    tiered: model('tiered', { cost: { input: 1, output: 2, cache_read: 0.1, tiers: [{ input: 4, output: 6, tier: { type: 'context', size: 500000 } }, { input: 2, output: 3, cache_read: 0.2, tier: { type: 'context', size: 272000 } }] } }),
    legacy: model('legacy', { cost: { input: 1, output: 2, context_over_200k: { input: 3, output: 4, cache_read: 0.3 } } }),
    listed: model('listed', { cost: { input: 1, output: 2, tiers: [{ input: 5, output: 6, tier: { type: 'context', size: 100000 } }], context_over_200k: { input: 9, output: 9 } } }),
    odd: model('odd', { cost: { input: 1, output: 2, tiers: [{ input: 9, output: 9, tier: { type: 'output', size: 10 } }, { input: 'x', output: 9, tier: { type: 'context', size: 10 } }, { input: 9, output: 9, tier: { type: 'context', size: -1 } }, { input: 9, output: 9 }, 7] } }),
    gone: model('gone', { status: 'deprecated' }), early: model('early', { status: 'beta' }), first: model('first', { status: 'alpha' }), unheard: model('unheard', { status: 'something-new' }),
  } };
  const built = createCatalog(build.compactCatalog(providers, { generatedAt: '2026-10-01' }));
  const one = (id) => built.lookup({ provider: 'openai', model: id });
  assert.deepEqual(one('tiered').tiers, [{ aboveTokens: 272000, rates: { input: 2, output: 3, cacheRead: 0.2, cacheWrite: null } }, { aboveTokens: 500000, rates: { input: 4, output: 6, cacheRead: null, cacheWrite: null } }], 'sorted by size, a missing cache rate stays missing');
  assert.deepEqual(one('legacy').tiers, [{ aboveTokens: 200000, rates: { input: 3, output: 4, cacheRead: 0.3, cacheWrite: null } }], 'the older field is a tier at 200,000');
  assert.deepEqual(one('listed').tiers.map((tier) => tier.aboveTokens), [100000], 'the list wins over the older field');
  assert.deepEqual(one('odd').tiers, [], 'an output tier, a rate that is not a number, a negative size and a tier without a size are left out');
  assert.deepEqual(['gone', 'early', 'first', 'unheard', 'tiered'].map((id) => one(id).status), ['deprecated', 'beta', 'alpha', 'not_stable', null], 'a status the Hub does not know is "not stable", not stable-looking');
  assert.throws(() => build.validateRaw({ ...providers, p1: { id: 'p1', models: { x: model('x', { cost: { input: 1, output: 2, tiers: 'big' } }) } } }), /models\.dev/, 'tiers that are not a list: refused');

  // Format 1 (an older file) is still read, without tiers; format 2 rows may leave the canonical id out with null; another format is refused.
  const v1 = createCatalog({ version: 1, generatedAt: '2026-01-01', source: 'test', canon: [], hosts: {}, rows: [[100000, 4096, null, [1, 2, null, null], 21, 0]], providers: { p: { old: 0 } } }).lookup({ provider: 'p', model: 'old' });
  assert.deepEqual([v1.tiers, v1.status, v1.notStable, v1.rates.input], [[], 'not_stable', true, 1], 'format 1: no tiers, a status that is only "not stable"');
  const v2 = createCatalog({ version: 2, generatedAt: '2026-01-01', source: 'test', canon: ['m/x'], hosts: {}, rows: [[100000, 4096, null, [1, 2, null, null], 4, 0, null, [[50000, 2, 3, null, null]]], [100000, 4096, null, null, 4, 0, 0]], providers: { m: { x: 1 }, p: { a: 0 } } });
  assert.deepEqual(v2.lookup({ provider: 'p', model: 'a' }).tiers, [{ aboveTokens: 50000, rates: { input: 2, output: 3, cacheRead: null, cacheWrite: null } }]);
  assert.equal(v2.lookup({ presetId: 'openrouter', model: 'm/x' }).confidence, 'alias', 'a row whose canonical id is null is skipped; another row\'s canonical id still names its model');
  assert.throws(() => createCatalog({ version: 3, generatedAt: '2026-01-01', source: 'test', canon: [], hosts: {}, rows: [], providers: {} }), /version 1 or 2/);

  // The list of a provider's models, for the picker: the most certain provider of the endpoint, sorted, bounded; nothing for a local runtime or an endpoint it does not know.
  const openai = catalog.models({ presetId: 'openai' });
  assert.equal(openai.provider, 'openai');
  assert.equal(openai.source, `catalog@${snapshot.generatedAt}`);
  assert.ok(openai.total >= 50 && openai.models.length === openai.total, `OpenAI lists ${openai.total} models`);
  assert.deepEqual(openai.models.map((entry) => entry.modelId), [...openai.models.map((entry) => entry.modelId)].sort(), 'sorted by id');
  assert.equal(openai.models.find((entry) => entry.modelId === 'gpt-5-mini').contextWindow, 400000);
  const few = catalog.models({ presetId: 'openai' }, { limit: 5 });
  assert.deepEqual([few.models.length, few.total, few.truncated], [5, openai.total, true]);
  assert.equal(openai.truncated, false);
  assert.equal(catalog.models({ presetId: 'custom-openai', apiBaseUrl: 'https://api.anthropic.com' }).provider, 'anthropic', 'the endpoint decides when the preset does not');
  assert.deepEqual([catalog.models({ presetId: 'ollama' }).models, catalog.models({ presetId: 'ollama' }).local], [[], true]);
  assert.deepEqual([catalog.models({ presetId: 'custom-openai', apiBaseUrl: 'https://litellm.example.com' }).models, catalog.models({ presetId: 'custom-openai', apiBaseUrl: 'https://litellm.example.com' }).provider], [[], null]);
  assert.ok(openai.models.every((entry) => entry.confidence === 'exact' && entry.provider === 'openai'));
  const unsorted = createCatalog({ version: 2, generatedAt: '2026-01-01', source: 'test', canon: [], hosts: {}, rows: [[100000, 4096, null, null, 4, 0]], providers: { m: { c: 0, a: 0, b: 0 } } });
  assert.deepEqual(unsorted.models({ provider: 'm' }).models.map((entry) => entry.modelId), ['a', 'b', 'c'], 'sorted whatever the order of the file');

  // What the Hub may budget and price from: the catalog is sure of the model. A gateway's alias is shown, never relied on; a miss and a local runtime are nothing to rely on.
  const trust = (query) => isTrusted(lookup(query));
  assert.deepEqual([trust({ presetId: 'anthropic', model: 'claude-sonnet-5-5' }), trust({ presetId: 'openrouter', model: 'anthropic/claude-sonnet-5-5' }),
    trust({ presetId: 'custom-openai', apiBaseUrl: 'https://proxy.example.com', model: 'gpt-5-mini' }), trust({ presetId: 'anthropic', model: 'nope' }), trust({ presetId: 'ollama', model: 'x' }), isTrusted(null)],
  [true, true, false, false, false, false], 'exact and normalized are trusted; an alias, a miss, a local runtime and nothing at all are not');
  ok(`format 2: ${tiered} models with price tiers (sorted, a base price each), ${deprecated} deprecated / ${beta} beta / ${alpha} alpha, the three tier sources built correctly, format 1 still read, and the list of a provider's models`);
}

// ------------------------------------------------------------------------------------------------------------------------------- 7. negative controls
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
