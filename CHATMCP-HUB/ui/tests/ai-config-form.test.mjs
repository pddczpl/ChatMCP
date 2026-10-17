import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GatewayProvider } from '../../lib/gateway-provider.mjs';
import { reconcileSavedAiConfig, selectAiProviderDraft, aiDraftHasChanges, aiProtocolForPreset } from '../src/lib/ai-config-form.ts';

test('saving a custom endpoint twice reuses its saved key with the Hub canonical preset', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-ai-form-'));
  try {
    const provider = new GatewayProvider({
      directory, manager: { secrets: [] }, env: {},
      protect: async () => 'fixture-ciphertext',
      unprotect: async () => 'fixture-key-0123456789',
      fetchImpl: () => { throw new Error('This configuration test must not contact a model.'); },
    });
    const submitted = { provider: 'openai', apiBaseUrl: 'https://gateway.example/v1', model: 'fixture-model', apiKey: 'fixture-key-0123456789' };
    const payload = form => ({ preset: form.provider, apiBaseUrl: form.apiBaseUrl, model: form.model, apiKey: form.apiKey || undefined, remember: true });
    const saved = await provider.configure(payload(submitted));
    assert.equal(saved.preset, 'custom-openai');
    assert.equal(saved.configured, true);
    assert.throws(() => provider.validateConfiguration(payload({ ...submitted, apiKey: '' })), { code: 'missing_key' });

    const current = reconcileSavedAiConfig(submitted, submitted, saved);
    assert.equal(current.provider, 'custom-openai');
    assert.equal(current.apiKey, '');
    const second = await provider.configure(payload({ ...current, model: 'another-fixture-model' }));
    assert.equal(second.configured, true);
    assert.equal(second.model, 'another-fixture-model');
    assert.equal(second.keySource, 'saved');
  } finally {
    const resolved = await fs.realpath(directory);
    const temp = await fs.realpath(os.tmpdir());
    assert.equal(path.dirname(resolved), temp);
    assert.match(path.basename(resolved), /^chatmcp-ai-form-/);
    await fs.rm(resolved, { recursive: true, force: true });
  }
});

test('a save response preserves a newer provider or endpoint selection', () => {
  const submitted = { provider: 'openai', apiBaseUrl: 'https://gateway.example/v1', model: 'old-model', apiKey: 'submitted-key' };
  const saved = { preset: 'custom-openai', apiBaseUrl: submitted.apiBaseUrl, model: submitted.model };
  for (const current of [
    { ...submitted, provider: 'anthropic', apiBaseUrl: 'https://api.anthropic.com', apiKey: 'new-key' },
    { ...submitted, apiBaseUrl: 'https://another.example/v1', apiKey: 'new-key' },
  ]) assert.deepEqual(reconcileSavedAiConfig(current, submitted, saved), current);
});

test('canonical config from save or connection test preserves a newer model and key', () => {
  const submitted = { provider: 'openai', apiBaseUrl: 'https://gateway.example/v1', model: 'old-model', apiKey: 'submitted-key' };
  const current = { ...submitted, model: 'new-model', apiKey: 'new-key' };
  const saved = { preset: 'custom-openai', apiBaseUrl: submitted.apiBaseUrl, model: submitted.model };
  assert.deepEqual(reconcileSavedAiConfig(current, submitted, saved), { ...current, provider: 'custom-openai' });
  const afterSave = reconcileSavedAiConfig(submitted, submitted, saved);
  const tested = { ...saved, preset: 'custom-anthropic' };
  assert.equal(reconcileSavedAiConfig(afterSave, afterSave, tested).provider, 'custom-anthropic');
});

test('switching custom Gemini to OpenAI keeps the original gateway and model without requiring the same key again', () => {
  const current = {provider:'custom-gemini',apiBaseUrl:'https://gateway.example/v1',model:'cx/gpt-6-astra',apiKey:''};
  const next = selectAiProviderDraft(current, {id:'custom-openai',defaultUrl:'',defaultModel:''});
  assert.deepEqual(next,{...current,provider:'custom-openai'});
  assert.equal(aiProtocolForPreset(next.provider),'openai-chat');
  assert.equal(aiDraftHasChanges(next,{preset:'custom-gemini',protocol:'gemini',apiBaseUrl:current.apiBaseUrl,model:current.model}),true);
  const confirmed = {preset:'custom-openai',protocol:'openai-chat',apiBaseUrl:next.apiBaseUrl,model:next.model};
  assert.equal(aiDraftHasChanges(next,confirmed),false);
  // Named-provider changes are different security destinations and clear typed credentials.
  const named = selectAiProviderDraft({...current,apiKey:'UNSAVED-DUMMY'}, {id:'openai',defaultUrl:'https://api.openai.com/v1',defaultModel:'gpt-mini'});
  assert.equal(named.apiKey,'');
  assert.equal(named.apiBaseUrl,'https://api.openai.com/v1');
  assert.equal(named.model,'gpt-mini');
  assert.equal(aiProtocolForPreset('openai-responses'),'openai-responses');
  assert.equal(aiProtocolForPreset('custom-responses'),'openai-responses');
  const responsesDraft=selectAiProviderDraft({...current,apiKey:''},{
    id:'custom-responses',defaultUrl:'',defaultModel:'',
  });
  assert.equal(responsesDraft.apiBaseUrl,current.apiBaseUrl);
  assert.equal(responsesDraft.model,current.model);
  assert.equal(responsesDraft.provider,'custom-responses');
  const namedResponses=selectAiProviderDraft({...current,apiKey:'UNSAVED-DUMMY'},{
    id:'openai-responses',defaultUrl:'https://api.openai.com/v1',defaultModel:'gpt-5-mini',
  });
  assert.equal(namedResponses.apiKey,'','named Responses provider must never inherit custom gateway credentials');
  assert.equal(namedResponses.apiBaseUrl,'https://api.openai.com/v1');
  assert.equal(aiProtocolForPreset('custom-gemini'),'gemini');
  assert.equal(aiProtocolForPreset('custom-anthropic'),'anthropic');
  assert.equal(aiProtocolForPreset('unknown'),null);
});
