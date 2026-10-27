import test from 'node:test';
import assert from 'node:assert/strict';
import { PRESETS } from '../../lib/provider-presets.mjs';
import { AI_PROVIDERS } from '../src/lib/ai-providers.ts';
import { aiProtocolForPreset, selectAiProviderDraft } from '../src/lib/ai-config-form.ts';

// The buttons of the connection form are the presets of the Hub. The list is written twice (lib/provider-presets.mjs for the Hub, src/lib/ai-providers.ts for the form),
// so this holds the two together: a preset the form does not offer cannot be picked, and a button with another address, model or protocol would fill the form with
// something the Hub then says is not that provider.
const named = (list) => list.map((entry) => entry.id).filter((id) => !id.startsWith('custom-'));

test('the form offers exactly the presets of the Hub', () => {
  assert.deepEqual(AI_PROVIDERS.map((entry) => entry.id).sort(), PRESETS.map((entry) => entry.id).sort());
});

test('the named providers come in the order of the Hub', () => {
  assert.deepEqual(named(AI_PROVIDERS), named(PRESETS));
});

test('every button starts the form from the address of its preset, and a named one from its model too', () => {
  for (const preset of PRESETS) {
    const choice = AI_PROVIDERS.find((entry) => entry.id === preset.id);
    assert.equal(choice.defaultUrl, preset.apiBaseUrl, `${preset.id}: address`);
    if (!preset.id.startsWith('custom-')) assert.equal(choice.defaultModel, preset.defaultModel, `${preset.id}: model`);
  }
});

test('the protocol the form sends is the protocol of the preset', () => {
  for (const preset of PRESETS) assert.equal(aiProtocolForPreset(preset.id), preset.protocol, preset.id);
});

test('the four providers of the popular set carry the names people know them by', () => {
  const nameOf = (id) => AI_PROVIDERS.find((entry) => entry.id === id)?.name;
  assert.deepEqual(['xai', 'glm', 'qwen', 'minimax'].map(nameOf), ['xAI (Grok)', 'Z.ai (GLM)', 'Alibaba (Qwen)', 'MiniMax']);
});

test('choosing one fills the address and the model, and never carries the key typed for another provider', () => {
  const current = { provider: 'anthropic', apiBaseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5-5', apiKey: 'typed-for-another-provider' };
  for (const [id, url, model] of [
    ['xai', 'https://api.x.ai/v1', 'grok-4.3'],
    ['glm', 'https://api.z.ai/api/paas/v4', 'glm-5.3'],
    ['qwen', 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', 'qwen3.7-plus'],
    ['minimax', 'https://api.minimax.io/anthropic', 'MiniMax-M3'],
  ]) {
    assert.deepEqual(selectAiProviderDraft(current, AI_PROVIDERS.find((entry) => entry.id === id)), { provider: id, apiBaseUrl: url, model, apiKey: '' }, id);
  }
});
