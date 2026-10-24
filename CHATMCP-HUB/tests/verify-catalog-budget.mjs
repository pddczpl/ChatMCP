// The model catalog feeds the Hub's plans (prov-4): the context window a conversation is planned against, the most the model is asked to write, and the price a task is estimated at.
// What this suite holds the Hub to:
//   1. model-facts.mjs: only a model the catalog is SURE of is relied on (exact or the same id spelled another way, never a gateway's alias, a local runtime or a miss); the capacity respects
//      an input limit below the window; it also stops at the first point where the model's price rises with the length of the prompt (its first price tier, never below 128,000), which is
//      the row of the exact provider and model, so it differs from one model and one provider to the next; the output cap never exceeds what the agent asks for and is ignored when too small
//      to write in; every model of the bundled snapshot is plannable.
//   2. GatewayProvider: state() says where the window comes from (configured, catalog, fallback), snapshot() carries the facts the agent reads, the owner's own window still wins, a saved
//      window is still the owner's, a task profile is a connection like the global one, and the facts follow the configuration.
//   3. The presets: a window is hard-coded only for a default model the catalog does not know.
//   4. Everything that reads "the window" reads the effective one: the tool selection, the context meter, the adapter's own trimming.
//   5. The real path (the primary AgentRunner -> GatewayProvider -> the request body, only the network replaced): the budget, the output cap, the tool list and the cost estimate of a model the
//      catalog knows; the owner's rates win; the price a run is estimated at is the one it started with.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentRunner } from '../lib/agent.mjs';
import { createPrimaryAgentRunner } from '../hub.mjs';
import { GatewayProvider } from '../lib/gateway-provider.mjs';
import { LocalTools } from '../lib/local-tools.mjs';
import { resolveEffectiveContextBudget } from '../lib/context-compaction.mjs';
import { AGENT_OUTPUT_TOKENS, PRICE_CAP_FLOOR_TOKENS, factsFromInfo, modelFacts } from '../lib/model-facts.mjs';
import { modelInfo, modelInfoQuery } from '../lib/model-info.mjs';
import { PRESETS, publicPresets } from '../lib/provider-presets.mjs';
import { catalogInfo, createCatalog, lookup, resetCatalog, useCatalog } from '../lib/model-catalog.mjs';
import { followProviderWindow } from '../lib/tool-selector.mjs';

const BUNDLE = path.resolve(import.meta.dirname, '..');
const base = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-catalog-budget-'));
let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
const KEY = 'sk-catalog-budget-key-0123456789';

// A small catalog of made-up models, so that the rules are tested without depending on the numbers of the real snapshot.
const SYNTHETIC = {
  version: 2, generatedAt: '2026-01-01', source: 'test', canon: ['openai/limited'], hosts: {},
  rows: [
    [1000000, 128000, null, [2, 10, 0.1, 2.5], 5, 0], //            0 big: a large window, no input limit
    [400000, 128000, 272000, [0.25, 2, 0.025, null], 5, 0], //      1 limited: the input limit is below the window
    [128000, 4096, null, [10, 30, null, null], 1, 0], //            2 turbo: a small output cap
    [8192, 8192, null, [30, 60, null, null], 1, 0], //              3 small: a small window
    [200000, 512, null, null, 1, 0], //                             4 tinyout: an output cap too small to write in, no price
    [1050000, 128000, 922000, [2.5, 15, 0.25, null], 5, 0, null, [[272000, 5, 22.5, 0.5, null]]], // 5 tiered: price tiers
    [400000, 128000, 272000, [0.25, 2, 0.025, null], 5, 0, 0], //   6 aliased: only reachable through the canonical id
    [128000, 16384, 30000, [1, 2, null, null], 1, 0], //            7 narrow: an input limit so small that reserving the output beside it would let a longer prompt through
    [1000000, 128000, null, [2, 10, 0.1, 2.5], 5, 0, null, [[200000, 4, 15, 0.2, 5]]], //   8 cliff: the price doubles above 200,000
    [1000000, 128000, null, [1, 5, null, null], 5, 0, null, [[32000, 2, 10, null, null]]], // 9 cliffLow: the price rises above 32,000, which is less than the Hub plans on
    [128000, 16384, null, [1, 5, null, null], 5, 0, null, [[200000, 2, 10, null, null]]], //  10 cliffHigh: the price rises above a size the model cannot take anyway
    [1000000, 128000, null, [4, 20, null, null], 5, 0, null, [[200000, 2, 10, null, null]]], // 11 cheaper: a tier that is cheaper is no cliff
    [1000000, 128000, null, [2, 10, null, null], 5, 0, null, [[150000, 2, 15, null, null]]], // 12 outputCliff: only the output price rises
    [1000000, 128000, null, [2, 10, null, null], 5, 0, null, [[300000, 6, 30, null, null], [150000, 4, 20, null, null]]], // 13 twoTiers: the lowest boundary counts, in whatever order they are listed
    [1000000, 128000, null, [2, 10, null, null], 5, 0, null, [[128000, 4, 20, null, null]]], //  14 edge: the price rises exactly where the floor is
    [200000, 128000, null, [2, 10, null, null], 5, 0, null, [[200000, 4, 20, null, null]]], //   15 atTheWindow: the price rises where the window ends
    [1000000, 128000, null, null, 5, 0, null, [[200000, 4, 15, null, null]]], //                16 unpriced: tiers but no base price to compare with
    [1000000, 128000, null, [2, 10, null, null], 5, 0, null, [[0, 4, 20, null, null]]], //      17 oddTier: a tier of no size is no boundary
    [1000000, 128000, null, [2, 10, null, null], 5, 0, null, [[150000.5, 4, 20, null, null]]], // 18 fractionTier: nor is a size that is not a whole number
    [1000000, 128000, null, [2, 10, null, null], 5, 0, null, [[220000, 4, 10, null, null]]], //  19 inputCliff: only the input price rises
    [1050000, 128000, 400000, [2, 10, null, null], 5, 0, null, [[500000, 4, 20, null, null]]], //  20 beyondTheInput: the price rises at a size the model does not take in anyway
  ],
  providers: { anthropic: { big: 0 }, openai: { limited: 1, turbo: 2, small: 3, tinyout: 4, tiered: 5, narrow: 7, cliff: 8, cliffLow: 9, cliffHigh: 10, cheaper: 11, outputCliff: 12, twoTiers: 13, edge: 14, atTheWindow: 15, unpriced: 16, oddTier: 17, fractionTier: 18, inputCliff: 19, beyondTheInput: 20 }, openrouter: {}, otherlab: { aliased: 6 } },
};
const synthetic = createCatalog(SYNTHETIC);
const OPENAI = { presetId: 'openai', apiBaseUrl: 'https://api.openai.com/v1' };

// ------------------------------------------------------------------------------------------------------------------------------- 1. model facts
{
  const of = (query) => modelFacts(query, synthetic.lookup);
  const big = of({ presetId: 'anthropic', model: 'big' });
  assert.deepEqual([big.confidence, big.contextWindow, big.capacity, big.maxOutput, big.outputCap, big.source], ['exact', 1000000, 1000000, 128000, AGENT_OUTPUT_TOKENS, 'catalog@2026-01-01']);
  assert.deepEqual(big.pricing, { source: 'catalog@2026-01-01', confidence: 'exact', rates: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 }, tiers: [] });
  assert.equal(AGENT_OUTPUT_TOKENS, 16384);
  // An input limit below the window: the conversation may not exceed it, so the capacity is at most the input limit plus the output the agent reserves (less when that would plan a prompt longer than the limit: see `narrow` below), never the whole window.
  const limited = of({ ...OPENAI, model: 'limited' });
  assert.deepEqual([limited.contextWindow, limited.maxInput, limited.capacity], [400000, 272000, 272000 + AGENT_OUTPUT_TOKENS]);
  assert.ok(resolveEffectiveContextBudget({ modelMetadataTokens: limited.capacity }).maxHistoryTokens < 272000, 'the history planned for it fits under the input limit');
  // What the model itself allows (modelCapacity) and what the Hub plans on (capacity) are two numbers: a window of 1,050,000 with an input limit of 922,000 allows 922,000 + 16,384, and the price
  // of this model rises above 272,000 (2.5 / 15 to 5 / 22.5), so the Hub plans on 272,000 of its own accord.
  const tiered = of({ ...OPENAI, model: 'tiered' });
  assert.deepEqual([tiered.modelCapacity, tiered.capacity], [922000 + AGENT_OUTPUT_TOKENS, 272000]);
  assert.deepEqual(tiered.priceCap, { aboveTokens: 272000, tokens: 272000, floored: false, from: { input: 2.5, output: 15 }, to: { input: 5, output: 22.5 } });
  for (const model of ['big', 'limited', 'turbo', 'small']) {
    const plain = of(model === 'big' ? { presetId: 'anthropic', model } : { ...OPENAI, model });
    assert.deepEqual([plain.priceCap, plain.capacity === plain.modelCapacity], [null, true], `${model}: no price tier, no cap, and the Hub plans on all the model allows`);
  }
  // The budget keeps a quarter of a small capacity for the output and a margin of 3.5% (lib/context-compaction.mjs): for an input limit that is not far above the output, adding the whole output to
  // the limit would plan a prompt longer than the model takes in. The capacity is the largest one whose planned prompt is not.
  const promptOf = (capacity, outputCap) => {
    const budget = resolveEffectiveContextBudget({ modelMetadataTokens: capacity, maxOutputTokens: outputCap ?? AGENT_OUTPUT_TOKENS });
    return capacity - budget.plannedOutputTokens - budget.safetyMarginTokens;
  };
  const narrow = of({ ...OPENAI, model: 'narrow' });
  assert.deepEqual([narrow.contextWindow, narrow.maxInput, narrow.outputCap], [128000, 30000, AGENT_OUTPUT_TOKENS]);
  assert.ok(narrow.capacity < 30000 + AGENT_OUTPUT_TOKENS, 'less than the input limit and the whole output');
  assert.ok(promptOf(narrow.capacity, narrow.outputCap) <= 30000 && promptOf(narrow.capacity + 1, narrow.outputCap) > 30000, `the prompt planned on ${narrow.capacity} is ${promptOf(narrow.capacity, narrow.outputCap)}: the largest that is not above 30,000`);
  // A price cliff: the first point at which the price of THIS provider's row of THIS model rises with the length of the prompt. The Hub does not plan beyond it of its own accord (the owner
  // can type a larger window), and does not plan on less than 128,000 for it (a smaller window leaves the agent too little room), nor on more than the model allows.
  const cliff = of({ ...OPENAI, model: 'cliff' });
  assert.deepEqual([cliff.contextWindow, cliff.modelCapacity, cliff.capacity], [1000000, 1000000, 200000], 'a price that doubles above 200,000: planned on 200,000');
  assert.deepEqual(cliff.priceCap, { aboveTokens: 200000, tokens: 200000, floored: false, from: { input: 2, output: 10 }, to: { input: 4, output: 15 } });
  const low = of({ ...OPENAI, model: 'cliffLow' });
  assert.deepEqual([low.modelCapacity, low.capacity], [1000000, 128000], 'a price that rises above 32,000: the floor, not 32,000');
  assert.deepEqual(low.priceCap, { aboveTokens: 32000, tokens: 128000, floored: true, from: { input: 1, output: 5 }, to: { input: 2, output: 10 } });
  const edge = of({ ...OPENAI, model: 'edge' });
  assert.deepEqual([edge.capacity, edge.priceCap?.aboveTokens, edge.priceCap?.tokens, edge.priceCap?.floored], [128000, 128000, 128000, false], 'the price rises exactly at the floor: the floor is not what stopped it');
  const output = of({ ...OPENAI, model: 'outputCliff' });
  assert.deepEqual([output.capacity, output.priceCap?.from, output.priceCap?.to], [150000, { input: 2, output: 10 }, { input: 2, output: 15 }], 'a rise of the output price alone is a cliff too');
  // The window is 1,050,000 but the model takes in 400,000: a price that rises at 500,000 is beyond what the Hub would plan on anyway, and must not RAISE the plan to 500,000.
  const beyond = of({ ...OPENAI, model: 'beyondTheInput' });
  assert.deepEqual([beyond.modelCapacity, beyond.capacity, beyond.priceCap], [400000 + AGENT_OUTPUT_TOKENS, 400000 + AGENT_OUTPUT_TOKENS, null], 'a price rise past the input limit changes nothing');
  const input = of({ ...OPENAI, model: 'inputCliff' });
  assert.deepEqual([input.capacity, input.priceCap?.from, input.priceCap?.to], [220000, { input: 2, output: 10 }, { input: 4, output: 10 }], 'a rise of the input price alone is a cliff too');
  const two = of({ ...OPENAI, model: 'twoTiers' });
  assert.deepEqual([two.capacity, two.priceCap?.aboveTokens, two.priceCap?.to], [150000, 150000, { input: 4, output: 20 }], 'the lowest boundary counts, whatever the order of the tiers');
  for (const [model, allowed, why] of [['cliffHigh', 128000, 'the price rises above what the model takes anyway'], ['atTheWindow', 200000, 'the price rises where the window ends'],
    ['cheaper', 1000000, 'a tier that is cheaper is no cliff'], ['unpriced', 1000000, 'tiers with no base price to compare with'],
    ['oddTier', 1000000, 'a tier of no size is no boundary'], ['fractionTier', 1000000, 'nor is a size that is not a whole number']]) {
    const free = of({ ...OPENAI, model });
    assert.deepEqual([free.modelCapacity, free.capacity, free.priceCap], [allowed, allowed, null], `${model}: ${why}`);
  }
  assert.equal(PRICE_CAP_FLOOR_TOKENS, 128000);
  ok('model facts: the Hub plans only up to the first point where the price rises (never below 128,000, never above what the model allows), for the row of the exact provider and model');

  // The output cap: the model's own when it is below what the agent asks for, never above; too small to write an answer in (below 1,024): not used.
  assert.equal(of({ ...OPENAI, model: 'turbo' }).outputCap, 4096);
  assert.equal(of({ ...OPENAI, model: 'small' }).outputCap, 8192);
  const tiny = of({ ...OPENAI, model: 'tinyout' });
  assert.deepEqual([tiny.maxOutput, tiny.outputCap, tiny.capacity, tiny.pricing], [512, null, 200000, null], 'a cap below 1,024 is ignored; no price, no pricing');
  assert.equal(of({ ...OPENAI, model: 'small' }).capacity, 8192);
  // The same id in another spelling is trusted; a gateway's alias, a miss, a local runtime and an endpoint nobody knows are not.
  assert.equal(of({ ...OPENAI, model: 'limited-20250101' })?.confidence, 'normalized');
  for (const [label, query] of [['an alias through the canonical id', { presetId: 'openrouter', model: 'openai/limited' }], ['a miss', { presetId: 'anthropic', model: 'nope' }],
    ['a local runtime', { presetId: 'ollama', model: 'big' }], ['an endpoint nobody knows', { presetId: 'custom-openai', apiBaseUrl: 'https://proxy.example.com/v1', model: 'turbo' }], ['no model', { presetId: 'anthropic' }]]) {
    assert.equal(of(query), null, label);
  }
  assert.equal(factsFromInfo(null), null);
  assert.equal(factsFromInfo({ found: true, confidence: 'alias', contextWindow: 100000 }), null);
  ok('model facts: only a sure answer is relied on; the capacity respects an input limit, the output cap is the smaller of the model\'s and the agent\'s, a cap too small to write in is ignored');

  // Every model of the bundled snapshot is plannable: a usable window gives a source that is not the fallback, the capacity never passes the input limit, the cap stays in bounds.
  const real = createCatalog(JSON.parse(await fs.readFile(path.join(BUNDLE, 'lib', 'model-catalog.data.json'), 'utf8')));
  let planned = 0, limitedByInput = 0, capped = 0, stoppedByPrice = 0, liftedByFloor = 0;
  for (const provider of real.providerIds()) {
    for (const model of real.modelIds(provider)) {
      const info = real.lookup({ provider, model });
      const found = factsFromInfo(info);
      assert.notEqual(found, null, `${provider}/${model}`);
      if (info.contextWindow !== null) {
        assert.notEqual(found.capacity, null, `${provider}/${model}: a window the catalog lists is a capacity`);
        assert.notEqual(resolveEffectiveContextBudget({ modelMetadataTokens: found.capacity }).source, 'conservative_fallback', `${provider}/${model}`);
        assert.ok(found.capacity <= info.contextWindow, `${provider}/${model}: never above the window`);
        if (info.maxInput > 0 && info.maxInput < info.contextWindow) {
          assert.ok(found.capacity <= info.maxInput + AGENT_OUTPUT_TOKENS, `${provider}/${model}: never above the input limit plus the output`);
          const budget = resolveEffectiveContextBudget({ modelMetadataTokens: found.capacity, maxOutputTokens: found.outputCap ?? AGENT_OUTPUT_TOKENS });
          const prompt = found.capacity - budget.plannedOutputTokens - budget.safetyMarginTokens;
          assert.ok(prompt <= Math.max(info.maxInput, 4096), `${provider}/${model}: the prompt planned (${prompt}) is longer than the model takes in (${info.maxInput})`);
          limitedByInput += 1;
        }
        // The price cliff, worked out again from the raw tiers of this row: the lowest point at which the price rises, not below 128,000 and not above what the model itself allows.
        const rises = info.rates ? info.tiers.filter((tier) => tier.rates.input > info.rates.input || tier.rates.output > info.rates.output).map((tier) => tier.aboveTokens) : [];
        const expected = rises.length ? Math.min(found.modelCapacity, Math.max(128000, Math.min(...rises))) : found.modelCapacity;
        assert.equal(found.capacity, expected, `${provider}/${model}: planned on ${found.capacity}, the first price rise (${rises.length ? Math.min(...rises) : 'none'}) and the floor say ${expected}`);
        assert.equal(found.priceCap === null, found.capacity === found.modelCapacity, `${provider}/${model}: a cap is reported exactly when it lowered the capacity`);
        assert.ok(found.modelCapacity <= info.contextWindow, `${provider}/${model}: the model allows no more than its window`);
        if (found.priceCap !== null) {
          stoppedByPrice += 1;
          if (found.priceCap.floored) liftedByFloor += 1;
          assert.equal(found.priceCap.tokens, found.capacity, `${provider}/${model}`);
          assert.equal(found.priceCap.floored, found.priceCap.aboveTokens < 128000, `${provider}/${model}: floored exactly when the price rises below the floor`);
        }
        planned += 1;
      } else assert.equal(found.capacity, null, `${provider}/${model}: no window, no capacity`);
      if (found.outputCap !== null) { assert.ok(found.outputCap >= 1024 && found.outputCap <= AGENT_OUTPUT_TOKENS, `${provider}/${model}: ${found.outputCap}`); if (found.outputCap < AGENT_OUTPUT_TOKENS) capped += 1; }
    }
  }
  assert.ok(planned >= 8700 && limitedByInput >= 100 && capped >= 100,`${planned} models plannable, ${limitedByInput} with an input limit below the window, ${capped} with an output cap below the agent's`);
  assert.ok(stoppedByPrice >= 300 && liftedByFloor >= 20 && liftedByFloor < stoppedByPrice, `${stoppedByPrice} models stopped at a price rise, ${liftedByFloor} of them lifted to the floor`);
  ok(`all ${planned} models with a window in the bundled snapshot plan on it (${limitedByInput} under an input limit, ${capped} with a smaller output cap, ${stoppedByPrice} stopped at the first price rise, ${liftedByFloor} of those lifted to the 128,000 floor)`);
}

// ------------------------------------------------------------------------------------------------------------------------------- 2. the provider
let providerNumber = 0;
async function provider({ preset, apiBaseUrl, model, contextWindowTokens, catalog = synthetic, fetchImpl = async () => { throw new Error('no network in this test'); } }) {
  const directory = path.join(base, `gateway-${(providerNumber += 1)}`);
  const gateway = new GatewayProvider({ directory, bundleRoot: BUNDLE, manager: { secrets: [] }, env: {}, platform: 'linux', sleep: async () => {}, fetchImpl, catalog });
  await gateway.load();
  await gateway.configure({ preset, ...(apiBaseUrl ? { apiBaseUrl } : {}), model, apiKey: KEY, ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}) });
  return gateway;
}
{
  const gateway = await provider({ preset: 'anthropic', model: 'big' });
  let state = gateway.state();
  assert.deepEqual([state.contextWindowTokens, state.contextWindowSource, state.effectiveContextWindowTokens], [null, 'catalog', 1000000], 'nothing typed, the catalog knows it');
  assert.deepEqual(gateway.snapshot(), { provider: 'gateway:anthropic', model: 'big', metadataContextTokens: 1000000, maxOutputTokens: 16384,
    pricing: { source: 'catalog@2026-01-01', confidence: 'exact', rates: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 }, tiers: [] } });
  // The owner's window wins, and is said to be the owner's; the catalog's facts stay what they are.
  await gateway.configure({ contextWindowTokens: 64000 });
  state = gateway.state();
  assert.deepEqual([state.contextWindowTokens, state.contextWindowSource, state.effectiveContextWindowTokens], [64000, 'configured', 64000]);
  assert.equal(gateway.snapshot().metadataContextTokens, 1000000, 'the catalog\'s number is still reported as the catalog\'s');
  // Emptied again (null): back to the catalog.
  await gateway.configure({ contextWindowTokens: null });
  assert.deepEqual([gateway.state().contextWindowSource, gateway.state().effectiveContextWindowTokens], ['catalog', 1000000]);
  // The facts follow the configuration: another model, an unknown one, and back.
  await gateway.configure({ model: 'not-in-the-catalog' });
  state = gateway.state();
  assert.deepEqual([state.contextWindowSource, state.effectiveContextWindowTokens], ['fallback', null]);
  assert.deepEqual(gateway.snapshot(), { provider: 'gateway:anthropic', model: 'not-in-the-catalog', metadataContextTokens: null, maxOutputTokens: null, pricing: null });
  await gateway.configure({ model: 'big' });
  assert.equal(gateway.state().contextWindowSource, 'catalog');
  // The saved file keeps what the owner typed, not what the catalog said.
  const saved = JSON.parse(await fs.readFile(path.join(base, 'gateway-1', 'gateway-config.json'), 'utf8'));
  assert.equal(saved.contextWindowTokens, null, 'a window from the catalog is never written into the owner\'s configuration');
  // The context meter and the context size of an estimate follow the effective window.
  assert.equal(gateway.estimateUsage({ input: [], instructions: 'x' }).contextWindowTokens, 1000000);

  const limited = await provider({ preset: 'openai', model: 'limited' });
  assert.deepEqual([limited.state().contextWindowSource, limited.state().effectiveContextWindowTokens, limited.snapshot().metadataContextTokens], ['catalog', 272000 + 16384, 272000 + 16384]);
  const turbo = await provider({ preset: 'openai', model: 'turbo' });
  assert.deepEqual([turbo.snapshot().maxOutputTokens, turbo.snapshot().metadataContextTokens], [4096, 128000]);
  // A price rise reaches what the Hub plans with, and a window the owner types still goes past it.
  const cliffy = await provider({ preset: 'openai', model: 'cliff' });
  assert.deepEqual([cliffy.state().contextWindowSource, cliffy.state().effectiveContextWindowTokens, cliffy.snapshot().metadataContextTokens], ['catalog', 200000, 200000], 'planned up to the price rise');
  const past = await provider({ preset: 'openai', model: 'cliff', contextWindowTokens: 600000 });
  assert.deepEqual([past.state().contextWindowSource, past.state().effectiveContextWindowTokens], ['configured', 600000], 'the owner can plan past the price rise');
  // A model the catalog is not sure of: the alias of a gateway, an endpoint nobody knows, a local runtime.
  for (const [label, options] of [['an endpoint nobody knows', { preset: 'custom-openai', apiBaseUrl: 'https://proxy.example.com/v1', model: 'turbo' }], ['a local runtime', { preset: 'ollama', model: 'big' }]]) {
    const unsure = await provider(options);
    assert.deepEqual([unsure.state().contextWindowSource, unsure.snapshot().metadataContextTokens, unsure.snapshot().maxOutputTokens, unsure.snapshot().pricing], ['fallback', null, null, null], label);
  }
  // A window saved by an earlier build (a preset's default was written into the file) is the owner's value, as it always was.
  const old = path.join(base, 'gateway-old');
  await fs.mkdir(old, { recursive: true });
  await fs.writeFile(path.join(old, 'gateway-config.json'), JSON.stringify({ version: 2, preset: 'anthropic', apiBaseUrl: 'https://api.anthropic.com', protocol: 'anthropic', model: 'big', authMode: 'auto', customPath: '', contextWindowTokens: 200000 }));
  const earlier = new GatewayProvider({ directory: old, bundleRoot: BUNDLE, manager: { secrets: [] }, env: {}, platform: 'linux', catalog: synthetic });
  await earlier.load();
  assert.deepEqual([earlier.state().contextWindowTokens, earlier.state().contextWindowSource, earlier.state().effectiveContextWindowTokens], [200000, 'configured', 200000]);

  // A task profile is a connection like the global one.
  const fork = (profile) => gateway.forkForTask({ id: 'p', protocol: 'openai-chat', apiBaseUrl: 'https://api.openai.com/v1', model: 'limited', apiKey: KEY, ...profile });
  assert.deepEqual([fork({}).state().contextWindowSource, fork({}).snapshot().metadataContextTokens, fork({}).snapshot().pricing.rates.input], ['catalog', 272000 + 16384, 0.25]);
  assert.deepEqual([fork({ contextWindow: 50000 }).state().contextWindowSource, fork({ contextWindow: 50000 }).state().effectiveContextWindowTokens], ['configured', 50000]);
  assert.equal(fork({ model: 'unknown-model' }).snapshot().pricing, null);
  ok('provider: state() says where the window comes from, snapshot() carries the facts, the owner\'s window wins and is the only one saved, a saved window stays the owner\'s, a profile is a connection like the global one');
}

// ------------------------------------------------------------------------------------------------------------------------------- 3. the presets
{
  const real = (preset) => lookup({ presetId: preset.id, apiBaseUrl: preset.apiBaseUrl, model: preset.defaultModel });
  const hardCoded = PRESETS.filter((preset) => preset.contextWindowTokens);
  for (const preset of hardCoded) {
    const found = real(preset);
    assert.ok(!(found.found && (found.confidence === 'exact' || found.confidence === 'normalized')), `${preset.id}: a window is hard-coded only for a default model the catalog does not know (${preset.defaultModel} is in it: ${found.contextWindow})`);
  }
  assert.deepEqual(hardCoded.map((preset) => preset.id), ['deepseek'], 'only DeepSeek\'s default model (deepseek-chat) is not in the catalog');
  for (const id of ['anthropic', 'gemini', 'groq', 'mistral']) assert.equal(publicPresets({}).find((preset) => preset.id === id).contextWindowTokens, null, id);
  const fresh = await provider({ preset: 'anthropic', model: 'claude-sonnet-5-5', catalog: createCatalog(JSON.parse(await fs.readFile(path.join(BUNDLE, 'lib', 'model-catalog.data.json'), 'utf8'))) });
  assert.deepEqual([fresh.state().contextWindowTokens, fresh.state().contextWindowSource], [null, 'catalog'], 'a new connection to Anthropic plans on the catalog\'s window, not on the 200,000 that used to be written for it');
  ok('presets: the catalog\'s window replaces the hard-coded one wherever the catalog knows the default model (only DeepSeek keeps its own)');
}

// ------------------------------------------------------------------------------------------------------------------------------- 4. what reads "the window"
{
  const mode = (gateway) => followProviderWindow({ provider: gateway }, {}).toolSelectionMode;
  assert.equal(mode(await provider({ preset: 'anthropic', model: 'big' })), 'full', 'a window of 1,000,000 from the catalog keeps the full tool list, as the 200,000 of the preset did');
  assert.equal(mode(await provider({ preset: 'anthropic', model: 'big', contextWindowTokens: 16384 })), 'auto', 'the owner\'s small window wins');
  assert.equal(mode(await provider({ preset: 'anthropic', model: 'unknown-model' })), 'auto', 'an unknown window: the selected tools');
  assert.equal(mode(await provider({ preset: 'openai', model: 'small' })), 'auto', 'a small window from the catalog: the selected tools');
  assert.equal(mode({ state: () => ({ contextWindowTokens: 200000 }) }), 'full', 'a provider that only says contextWindowTokens is read as before');

  // The adapter trims what it sends to the window it plans with: a model of 8,192 tokens is not sent 60 KiB of tool results, an unknown one is (nothing to trim to).
  const long = [{ role: 'user', content: [{ type: 'input_text', text: 'Read the files.' }] }];
  for (let index = 0; index < 12; index += 1) {
    long.push({ type: 'function_call', call_id: `c${index}`, name: 'read_file', arguments: '{}', status: 'completed' });
    long.push({ type: 'function_call_output', call_id: `c${index}`, output: `line ${index} `.repeat(900) });
  }
  const sentBytes = async (options) => {
    let sent = 0;
    const gateway = await provider({ ...options, fetchImpl: async (url, init) => { sent = init.body.length; return { ok: true, status: 200, headers: { get: () => null }, async text() { return JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'ok' } }], usage: { prompt_tokens: 10, completion_tokens: 1 } }); } }; } });
    await gateway.respond({ input: long, instructions: 'Be brief.', tools: [], maxOutputTokens: 1024 });
    return sent;
  };
  const trimmed = await sentBytes({ preset: 'openai', model: 'small' });
  const untouched = await sentBytes({ preset: 'openai', model: 'not-in-the-catalog' });
  assert.ok(untouched > 60000, `an unknown window: nothing to trim to (${untouched} bytes)`);
  assert.ok(trimmed < untouched * 0.6, `a window of 8,192 tokens from the catalog: the old tool results are replaced by stubs (${trimmed} bytes against ${untouched})`);
  ok('the tool selection, the context meter and the adapter\'s trimming read the effective window (configured, else the catalog\'s)');
}

// ------------------------------------------------------------------------------------------------------------------------------- 5. the real path
{
  const catalogTools = new LocalTools({ workspace: { async resolve() { throw new Error('not called'); } }, shell: {}, git: {} }).definitions();
  const real = createCatalog(JSON.parse(await fs.readFile(path.join(BUNDLE, 'lib', 'model-catalog.data.json'), 'utf8')));
  const label = catalogInfo().label;
  let runNumber = 0;
  const sse = (payload) => ({ ok: true, status: 200, headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? 'text/event-stream' : null) }, body: new Response(`data: ${JSON.stringify({ type: 'response.completed', response: payload })}\n\n`).body });
  const completed = { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Nothing to change.' }] }], usage: { input_tokens: 20000, output_tokens: 5 } };
  async function runTask({ model, effectiveProfile = null, window, usage = completed.usage }) {
    const number = (runNumber += 1);
    const requests = [];
    const gateway = new GatewayProvider({ directory: path.join(base, `real-${number}`), bundleRoot: BUNDLE, manager: { secrets: [] }, env: {}, platform: 'linux', sleep: async () => {}, catalog: real,
      fetchImpl: async (url, init) => { requests.push({ url, body: JSON.parse(init.body) }); return sse({ ...completed, usage }); } });
    await gateway.load();
    await gateway.configure({ preset: 'openai-responses', model, apiKey: KEY, ...(window ? { contextWindowTokens: window } : {}) });
    let locked = false;
    const root = path.join(base, `workspace-${number}`);
    await fs.mkdir(root, { recursive: true });
    const manager = { secrets: [], workspace: root, generation: 1, instanceId: 'catalog-budget', studio: { checks: async () => ({ suggested: [] }) },
      state() { return { workspace: { path: root }, generation: 1, instanceId: 'catalog-budget', services: {} }; },
      acquireTask() { if (locked) return false; locked = true; return true; }, releaseTask() { locked = false; },
      async createAgentSession() { return { catalog: { tools: catalogTools, prompts: [], resources: [], resourceTemplates: [], servers: {} }, async close() {}, async callTool() { throw new Error('no tool is called'); } }; } };
    const runner = createPrimaryAgentRunner(AgentRunner, { manager, provider: gateway, taskDirectory: path.join(base, `tasks-${number}`), log: () => {}, env: {} });
    await runner.load();
    const { id } = await runner.start({ prompt: 'Fix the failing test in src/core.mjs and run the tests.', maxSteps: 3, maxMinutes: 1, ...(effectiveProfile ? { effectiveProfile } : {}) });
    await Promise.race([runner.context.done.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('catalog budget task timed out')), 20000))]);
    const task = runner.get(id);
    await runner.shutdown();
    return { task, requests };
  }

  // gpt-5-mini: 400,000 tokens with an input limit of 272,000 and an output of 128,000, USD 0.25 / 2 per million.
  const mini = await runTask({ model: 'gpt-5-mini' });
  assert.equal(mini.task.status, 'completed', mini.task.error);
  assert.equal(mini.task.contextPolicy.source, 'trusted_model_metadata', 'nothing typed, the catalog knows the model: the policy says so');
  assert.equal(mini.task.contextPolicy.capacityTokens, 272000 + AGENT_OUTPUT_TOKENS);
  assert.ok(mini.task.contextPolicy.maxHistoryTokens > 200000 && mini.task.contextPolicy.maxHistoryTokens < 272000, `history ${mini.task.contextPolicy.maxHistoryTokens} stays under the 272,000 input limit`);
  assert.equal(mini.requests[0].body.max_output_tokens, 16384);
  assert.equal(mini.requests[0].body.tools.length, 103, 'a window of this size keeps the full tool list');
  const cost = mini.task.modelCost;
  assert.deepEqual([cost.estimatedResponses, cost.estimateSource, cost.approximate, cost.complete, cost.totalUsd], [1, label, true, true, 0.00501], '20,000 in and 5 out at 0.25 / 2 per million, as an estimate that names its snapshot');
  assert.equal(mini.task.contextPolicy.approximate, true);

  // The owner's window still wins, the owner's rates still win.
  const typed = await runTask({ model: 'gpt-5-mini', window: 64000, effectiveProfile: { id: 'mine', revision: 'r1', ratesUsdPerMillion: { input: 1, output: 1 } } });
  assert.equal(typed.task.contextPolicy.source, 'provider_configuration');
  assert.equal(typed.task.contextPolicy.capacityTokens, 64000);
  assert.deepEqual([typed.task.modelCost.estimatedResponses, typed.task.modelCost.approximate, typed.task.modelCost.totalUsd], [0, false, 0.020005], 'the profile\'s rates are the owner\'s and exact');

  // A model that can only write 4,096 tokens is asked for no more than that.
  const turbo = await runTask({ model: 'gpt-4-turbo' });
  assert.equal(turbo.requests[0].body.max_output_tokens, 4096, 'gpt-4-turbo\'s own cap, not the 16,384 the agent would ask for');
  assert.equal(turbo.task.contextPolicy.reservedOutputTokens, 4096);
  assert.equal(turbo.task.modelCost.totalUsd, 0.20015, 'USD 10 / 30 per million: 20,000 in and 5 out');

  // A long prompt is priced at the tier: gpt-5.4 above 272,000 prompt tokens costs 5 / 22.5 instead of 2.5 / 15.
  const long = await runTask({ model: 'gpt-5.4', usage: { input_tokens: 300000, output_tokens: 1000 } });
  assert.equal(long.task.modelCost.totalUsd, 1.5225, 'the whole request at the tier\'s rates');
  const short = await runTask({ model: 'gpt-5.4', usage: { input_tokens: 100000, output_tokens: 1000 } });
  assert.equal(short.task.modelCost.totalUsd, 0.265, 'below the tier: the base rates');

  // gpt-5.4 takes 1,050,000 tokens (922,000 in) but its price doubles above 272,000 prompt tokens: the plan stops there of its own accord, and a window the owner types goes past it.
  const priced = await runTask({ model: 'gpt-5.4' });
  assert.equal(priced.task.contextPolicy.source, 'trusted_model_metadata');
  assert.equal(priced.task.contextPolicy.capacityTokens, 272000, 'planned up to the first price rise, not up to what the model takes in');
  assert.ok(priced.task.contextPolicy.maxHistoryTokens > 200000 && priced.task.contextPolicy.maxHistoryTokens < 272000, `history ${priced.task.contextPolicy.maxHistoryTokens} stays under the price rise`);
  const beyond = await runTask({ model: 'gpt-5.4', window: 500000 });
  assert.deepEqual([beyond.task.contextPolicy.source, beyond.task.contextPolicy.capacityTokens], ['provider_configuration', 500000], 'the owner\'s window is planned on, past the price rise');

  // A model nobody knows is unchanged: no window, no price.
  const unknown = await runTask({ model: 'my-own-finetune' });
  assert.deepEqual([unknown.task.contextPolicy.source, unknown.task.modelCost.estimatedResponses, unknown.task.modelCost.totalUsd, unknown.task.modelCost.unpricedResponses], ['conservative_fallback', 0, null, 1]);
  ok('real path: a model the catalog knows is planned on its capacity, asked for its own output cap, given the full tool list, and its cost is a labelled estimate with tiers; the owner\'s window and rates still win; an unknown model is unchanged');
}

// ------------------------------------------------------------------------------------------------------------------------------- 6. the price of a run is the one it started with
{
  const root = path.join(base, 'freeze');
  await fs.mkdir(root, { recursive: true });
  let locked = false;
  const manager = { secrets: [], workspace: root, generation: 1, instanceId: 'freeze', locked: false, studio: { checks: async () => ({ suggested: [] }) },
    state() { return { workspace: { path: root }, generation: 1, instanceId: 'freeze', services: {} }; },
    acquireTask() { if (locked) return false; locked = true; return true; }, releaseTask() { locked = false; },
    async createAgentSession() { return { catalog: { tools: [{ name: 'local.read_file', server: 'local', originalName: 'read_file', inputSchema: { type: 'object' } }], prompts: [], resources: [], resourceTemplates: [], servers: {} }, async close() {}, async callTool() { return { content: [{ type: 'text', text: 'x' }] }; } }; } };
  // The catalog is refreshed while the run goes on: the facts of the provider change between its two steps.
  let turn = 0;
  let inputRate = 2;
  const gateway = {
    ready: () => true,
    snapshot: () => ({ provider: 'fixture', model: 'fixture', metadataContextTokens: 100000, maxOutputTokens: 8192, pricing: { source: `catalog@rate-${inputRate}`, confidence: 'exact', rates: { input: inputRate, output: inputRate, cacheRead: null, cacheWrite: null }, tiers: [] } }),
    async respond({ maxOutputTokens }) {
      turn += 1;
      assert.ok(maxOutputTokens <= 8192, 'the output cap of the catalog reaches the request');
      const usage = { input_tokens: 1000000, output_tokens: 0 };
      if (turn === 1) { inputRate = 200; return { status: 'completed', usage, output: [{ type: 'function_call', call_id: 'a', name: 'mcp_describe', arguments: JSON.stringify({ name: 'read_file' }), status: 'completed' }] }; }
      return { status: 'completed', usage, output: [{ type: 'message', role: 'assistant', phase: 'final', content: [{ type: 'output_text', text: 'Done.' }] }] };
    },
  };
  const runner = new AgentRunner({ manager, provider: gateway, taskDirectory: path.join(base, 'freeze-tasks') });
  await runner.load();
  const { id } = await runner.start({ prompt: 'Describe a tool, then answer.', maxSteps: 4, maxMinutes: 1 });
  await Promise.race([runner.context.done.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('freeze task timed out')), 20000))]);
  const task = runner.get(id);
  await runner.shutdown();
  assert.equal(task.status, 'completed', task.error);
  assert.equal(turn, 2);
  assert.deepEqual([task.modelCost.estimatedResponses, task.modelCost.estimateSource, task.modelCost.totalUsd], [2, 'catalog@rate-2', 4], 'both responses priced at the rates the run started with (1,000,000 tokens at 2 each), not at the refreshed 200');
  assert.equal(task.contextPolicy.source, 'trusted_model_metadata');
  assert.equal(task.contextPolicy.reservedOutputTokens <= 8192, true);
  ok('a run keeps the price it started with when the catalog changes under it, and the output cap of the catalog reaches the request');
}

// ------------------------------------------------------------------------------------------------------------------------------- 7. the agent does not take a provider's output cap on trust
{
  // A provider (any: a fixture, a future one) that reports a cap: larger than the agent asks for lowers nothing and raises nothing, smaller than an answer needs is a gap, not a limit.
  let number = 0;
  const askedFor = async (snapshot) => {
    number += 1;
    const root = path.join(base, `cap-${number}`);
    await fs.mkdir(root, { recursive: true });
    let locked = false;
    const manager = { secrets: [], workspace: root, generation: 1, instanceId: `cap-${number}`, studio: { checks: async () => ({ suggested: [] }) },
      state() { return { workspace: { path: root }, generation: 1, instanceId: `cap-${number}`, services: {} }; },
      acquireTask() { if (locked) return false; locked = true; return true; }, releaseTask() { locked = false; },
      async createAgentSession() { return { catalog: { tools: [{ name: 'local.read_file', server: 'local', originalName: 'read_file', inputSchema: { type: 'object' } }], prompts: [], resources: [], resourceTemplates: [], servers: {} }, async close() {}, async callTool() { throw new Error('no tool is called'); } }; } };
    let asked = null;
    const gateway = { ready: () => true, snapshot: () => ({ provider: 'fixture', model: 'fixture', ...snapshot }),
      async respond({ maxOutputTokens }) { asked = maxOutputTokens; return { status: 'completed', output: [{ type: 'message', role: 'assistant', phase: 'final', content: [{ type: 'output_text', text: 'Done.' }] }] }; } };
    const runner = new AgentRunner({ manager, provider: gateway, taskDirectory: path.join(base, `cap-tasks-${number}`) });
    await runner.load();
    const { id } = await runner.start({ prompt: 'Say done.', maxSteps: 2, maxMinutes: 1 });
    await Promise.race([runner.context.done.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('cap task timed out')), 20000))]);
    assert.equal(runner.get(id).status, 'completed', runner.get(id).error);
    await runner.shutdown();
    return asked;
  };
  assert.equal(await askedFor({ metadataContextTokens: 400000, maxOutputTokens: 4096 }), 4096, 'a smaller cap of the model\'s is respected');
  assert.equal(await askedFor({ metadataContextTokens: 400000, maxOutputTokens: 128000 }), 16384, 'a larger one does not raise what the agent asks for');
  assert.equal(await askedFor({ metadataContextTokens: 400000, maxOutputTokens: 512 }), 16384, 'one too small to write an answer in is ignored');
  for (const odd of ['big', null, undefined, 4096.5, -1, Number.NaN]) assert.equal(await askedFor({ metadataContextTokens: 400000, maxOutputTokens: odd }), 16384, `${String(odd)} is not a cap`);
  assert.equal(await askedFor({}), 16384, 'a provider that says nothing: unchanged');
  ok('the agent clamps a reported output cap into 1,024..16,384 and ignores anything that is not an integer');
}

// ------------------------------------------------------------------------------------------------------------------------------- 8. the route says what the Hub plans on, and why it is not more
{
  useCatalog(SYNTHETIC);
  try {
    const answer = (model, preset = 'openai') => modelInfo(modelInfoQuery(new URLSearchParams({ preset, model })));
    const cliff = answer('cliff');
    assert.deepEqual([cliff.trusted, cliff.contextWindow, cliff.modelCapacity, cliff.capacity], [true, 1000000, 1000000, 200000]);
    assert.deepEqual(cliff.priceCap, { aboveTokens: 200000, tokens: 200000, floored: false, from: { input: 2, output: 10 }, to: { input: 4, output: 15 } });
    const plain = answer('big', 'anthropic');
    assert.deepEqual([plain.capacity, plain.modelCapacity, plain.priceCap], [1000000, 1000000, null], 'no price rise, no cap');
    const unknown = answer('nope');
    assert.deepEqual([unknown.trusted, unknown.capacity, unknown.modelCapacity, unknown.priceCap], [false, null, null, null], 'a model the catalog does not know: nothing to plan on, nothing to cap');
  } finally {
    resetCatalog();
  }
  ok('the model-info route says what the Hub plans on, what the model itself allows and the price rise that stopped it');
}

await fs.rm(base, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
console.log(`\nPASS: ${checks} catalog budget checks`);
